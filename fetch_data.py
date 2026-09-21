"""
fetch_data.py - download cocktails from the 24Cocktails API, clean them,
and write web/data/cocktails.json for the website.

Usage (from the project folder):
    python fetch_data.py              # balanced sample of 500 cocktails (about 6 minutes)
    python fetch_data.py --limit 150  # smaller / faster
    python fetch_data.py --all        # every cocktail (7,000+; about an hour)
    python fetch_data.py --refresh    # ignore the saved cache and download again

Only the Python standard library is used, so there is nothing to pip install.
Downloaded responses are cached in data/raw/, so you can stop (Ctrl+C) and run
the script again later and it will continue where it left off.

API docs: https://24cocktails.com/developers.html
"""

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone

# The API address. (COCKTAIL_API_BASE only exists so the script can be tested
# against a stand-in server; leave it alone for normal use.)
API_BASE = os.environ.get("COCKTAIL_API_BASE", "https://24cocktails.com").rstrip("/")

# The API allows 120 requests per minute per client. 0.55 s between calls is
# about 109 per minute, which stays safely under that limit.
MIN_SECONDS_BETWEEN_CALLS = float(os.environ.get("COCKTAIL_MIN_INTERVAL", "0.55"))

# The eight values the API accepts for its `base` (base spirit) filter.
BASES = ["gin", "vodka", "rum", "whiskey", "tequila", "brandy", "other", "na"]

PAGE_SIZE = 50  # the API's maximum page size

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(HERE, "data", "raw")
RECIPE_DIR = os.path.join(RAW_DIR, "recipes")
OUT_FILE = os.path.join(HERE, "web", "data", "cocktails.json")

_last_call = 0.0


# --------------------------------------------------------------------------
# Talking to the API
# --------------------------------------------------------------------------
def get_json(path, params=None):
    """GET a JSON document from the API, politely (rate limit + retries)."""
    global _last_call
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)

    for attempt in range(1, 6):
        wait = MIN_SECONDS_BETWEEN_CALLS - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()

        request = urllib.request.Request(
            url, headers={"User-Agent": "cocktail-explorer-class-project/1.0", "Accept": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None  # e.g. a recipe that no longer exists
            if err.code == 429:  # too many requests: back off and retry
                pause = int(err.headers.get("Retry-After", "10") or 10)
                print(f"  rate limited, waiting {pause}s ...")
                time.sleep(pause)
                continue
            print(f"  HTTP {err.code} for {url} (attempt {attempt}/5)")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            print(f"  network problem: {err} (attempt {attempt}/5)")
        time.sleep(2 * attempt)

    sys.exit(f"Giving up on {url}. Check your internet connection and try again.")


def load_cache(path):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def save_cache(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


# --------------------------------------------------------------------------
# Step 1: get the list of cocktails (summaries) - a few pages per base spirit
# --------------------------------------------------------------------------
def collect_summaries(limit, refresh):
    """Return (summaries, total_in_api). limit=None means every cocktail.

    The list is built round-robin across the base spirits so a small sample
    still has gin, rum, tequila, non-alcoholic, ... and not just the drinks
    that happen to come first in the API's order.
    """
    cache_path = os.path.join(RAW_DIR, f"summaries_{limit or 'all'}.json")
    if not refresh:
        cached = load_cache(cache_path)
        if cached:
            print(f"Using saved list of {len(cached['summaries'])} cocktails ({cache_path})")
            return cached["summaries"], cached["total_in_api"]

    print("Step 1/2: getting the cocktail list from the API ...")
    pages = {b: [] for b in BASES}      # summaries fetched so far, per base
    totals = {}                         # how many cocktails each base has in the API
    while True:
        progressed = False
        for base in BASES:
            have = len(pages[base])
            if base in totals and have >= totals[base]:
                continue  # this base is exhausted
            data = get_json("/api/v1/search", {"base": base, "limit": PAGE_SIZE, "offset": have})
            if not data:
                continue
            totals[base] = data.get("total", 0)
            results = data.get("results", [])
            pages[base].extend(results)
            progressed = progressed or bool(results)
            print(f"  {base:8s} {len(pages[base]):5d} / {totals[base]}")
        enough = limit is not None and sum(len(v) for v in pages.values()) >= limit
        if enough or not progressed:
            break

    # Interleave the bases: 1st gin, 1st vodka, 1st rum, ..., 2nd gin, 2nd vodka, ...
    ordered = []
    for i in range(max(len(v) for v in pages.values())):
        for base in BASES:
            if i < len(pages[base]):
                ordered.append(pages[base][i])
    if limit is not None:
        ordered = ordered[:limit]

    total_in_api = sum(totals.values())
    save_cache(cache_path, {"summaries": ordered, "total_in_api": total_in_api})
    return ordered, total_in_api


# --------------------------------------------------------------------------
# Step 2: get the full recipe for each cocktail
# --------------------------------------------------------------------------
def fetch_recipes(summaries, refresh):
    """Full recipe (measures, garnish, steps) - one API call per cocktail."""
    print(f"Step 2/2: downloading {len(summaries)} full recipes (cached ones are skipped) ...")
    recipes = []
    for i, summary in enumerate(summaries, start=1):
        slug = summary["slug"]
        cache_path = os.path.join(RECIPE_DIR, urllib.parse.quote(slug, safe="") + ".json")
        recipe = None if refresh else load_cache(cache_path)
        if recipe is None:
            recipe = get_json("/api/v1/recipe/" + urllib.parse.quote(slug, safe=""))
            if recipe is None:
                print(f"  [{i}/{len(summaries)}] {slug}: not found, skipped")
                continue
            save_cache(cache_path, recipe)
            print(f"  [{i}/{len(summaries)}] {recipe.get('name', slug)}")
        recipes.append(recipe)
    return recipes


# --------------------------------------------------------------------------
# Cleaning: turn raw API recipes into the compact records the website uses
# --------------------------------------------------------------------------
def text(value):
    """A stripped string, or None when the API gave nothing useful."""
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def clean_recipe(raw):
    base = text(raw.get("base"))
    abv = raw.get("abv")
    abv = abv if isinstance(abv, (int, float)) else None

    # The API reports abv 0 both for genuinely non-alcoholic drinks (base "na")
    # and for drinks whose strength it could not work out (e.g. an Avocado
    # Margarita made with tequila). We only trust a 0 when the base is "na".
    strength_known = abv is not None and (abv > 0 or base == "na")

    ingredients = []
    for item in raw.get("ingredients") or []:
        name = text(item.get("name"))
        if not name:
            continue
        ingredients.append(
            {
                "name": name,
                "amount": text(item.get("amount")),
                "ml": item.get("ml") if isinstance(item.get("ml"), (int, float)) else None,
                "key": text(item.get("key")),
                "optional": bool(item.get("optional")),
            }
        )

    categories = []
    for c in raw.get("categories") or []:
        c = text(c)
        if c and c.lower() not in categories:
            categories.append(c.lower())

    return {
        "slug": raw.get("slug"),
        "name": text(raw.get("name")) or raw.get("slug"),
        "base": base or "other",
        "abv": abv if strength_known else None,
        "strength_known": strength_known,
        "method": text(raw.get("method_key")) or text(raw.get("method")),
        "method_text": text(raw.get("method")),
        "glass": text(raw.get("glass")),
        "glass_key": text(raw.get("glass_key")),
        "categories": categories,
        "prep_minutes": raw.get("prep_minutes") if isinstance(raw.get("prep_minutes"), int) else None,
        "difficulty": raw.get("difficulty") if isinstance(raw.get("difficulty"), int) else None,
        "description": text(raw.get("description")),
        "ice": text(raw.get("ice")),
        "garnish": text(raw.get("garnish")),
        "ingredients": ingredients,
        "ingredient_count": len(ingredients),  # counted from the API's ingredient list
        "steps": [s for s in (text(s) for s in raw.get("steps") or []) if s],
        "url": text(raw.get("url")),
        "photo": text(raw.get("photo")),
        "attribution": text(raw.get("attribution")),
    }


def build_ingredient_index(cocktails, min_count=2):
    """Which ingredients can the user pick as 'I have this'?

    Uses the API's own normalized ingredient `key` (e.g. "lime_juice") so the
    same ingredient written differently still matches. Keys that appear in only
    one recipe are mostly messy one-off strings ("1/2 oz silver tequila"), so
    they are left out of the picker.
    """
    counts = Counter()
    names = defaultdict(Counter)
    for c in cocktails:
        for ing in c["ingredients"]:
            if ing["key"] and not ing["optional"]:
                counts[ing["key"]] += 1
                names[ing["key"]][ing["name"]] += 1
    index = []
    for key, n in counts.most_common():
        if n >= min_count:
            index.append({"key": key, "label": names[key].most_common(1)[0][0], "count": n})
    return index


# --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Download and clean 24Cocktails API data.")
    parser.add_argument("--limit", type=int, default=500, help="how many cocktails to download (default 500)")
    parser.add_argument("--all", action="store_true", help="download every cocktail (7,000+; about an hour)")
    parser.add_argument("--refresh", action="store_true", help="ignore the cache and download everything again")
    args = parser.parse_args()
    limit = None if args.all else max(1, args.limit)

    summaries, total_in_api = collect_summaries(limit, args.refresh)
    raw_recipes = fetch_recipes(summaries, args.refresh)

    cocktails, seen = [], set()
    for raw in raw_recipes:
        record = clean_recipe(raw)
        if record["slug"] and record["slug"] not in seen:  # drop duplicates
            seen.add(record["slug"])
            cocktails.append(record)
    cocktails.sort(key=lambda c: c["name"].lower())

    ingredient_index = build_ingredient_index(cocktails)

    output = {
        "meta": {
            "source": "24Cocktails API",
            "source_url": "https://24cocktails.com/developers.html",
            "api_base": API_BASE,
            "fetched_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
            "total_in_api": total_in_api,
            "count": len(cocktails),
            "sample": "all cocktails" if limit is None else f"balanced sample across base spirits (limit {limit})",
        },
        "ingredient_index": ingredient_index,
        "cocktails": cocktails,
    }
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False)

    # A short data-quality report so nothing is hidden from you.
    unknown = sum(1 for c in cocktails if not c["strength_known"])
    null_keys = sum(1 for c in cocktails for i in c["ingredients"] if not i["key"])
    no_photo = sum(1 for c in cocktails if not c["photo"])
    print()
    print(f"Saved {len(cocktails)} cocktails (of {total_in_api} in the API) to {os.path.relpath(OUT_FILE, HERE)}")
    print("By base spirit:", dict(Counter(c["base"] for c in cocktails)))
    print(f"Strength not reported by the API: {unknown}")
    print(f"Ingredients with no normalized key (cannot be matched): {null_keys}")
    print(f"Cocktails without a photo: {no_photo}")
    print(f"Ingredients offered in the 'I have' picker: {len(ingredient_index)}")
    print("\nNext step:  python serve.py")


if __name__ == "__main__":
    main()
