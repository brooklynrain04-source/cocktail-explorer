# Cocktail Explorer

An interactive website for exploring and comparing cocktails. You set several preferences at once (strength, base spirit, style, number of ingredients, preparation method, and the ingredients you already own) and the chart, the bar charts, and the results table all update together to show only the drinks that fit **every** preference.

All data comes from the free **24Cocktails API**. Python downloads and cleans the data, then serves the website on `localhost`.

## 1. The data source: 24Cocktails API

- Website and docs: <https://24cocktails.com/developers.html>
- Base URL: `https://24cocktails.com`
- **No API key, sign-up or payment is needed.** It is free to use.
- Limit: 120 requests per minute per client. The download script waits about half a second between requests to stay under this.
- Terms: attribution is required, so every drink in the website links back to its page on 24cocktails.com.
- The catalogue has 7,000+ recipes.

### Endpoints used

| Endpoint | What it is used for |
|---|---|
| `GET /api/v1/search?base=...&limit=50&offset=...` | Gets a list of cocktails, a page at a time, for each base spirit |
| `GET /api/v1/recipe/{slug}` | Gets one full recipe (measures, garnish, steps) |

The API also has `/by-ingredients` and `/random`. They are not used, because the "ingredients I have" filter runs in the browser on the downloaded data so that it updates instantly and combines with the other filters.

### Fields used

| Website shows | API field |
|---|---|
| Cocktail name | `name` |
| Base spirit (gin, vodka, rum, whiskey, tequila, brandy, other, non-alcoholic) | `base` |
| Strength (% ABV) | `abv` |
| Category / style (classic, sour, tiki, long, strong, creamy, ...) | `categories` (a list; a drink can have several) |
| Preparation method (shake, stir, build, blend, muddle, throw, layer) | `method` / `method_key` |
| Glass | `glass` |
| Garnish, ice | `garnish`, `ice` |
| Ingredients and measurements | `ingredients[]` with `name`, `amount`, `ml`, `key`, `optional` |
| Instructions | `steps[]` |
| Prep time, difficulty, description | `prep_minutes`, `difficulty`, `description` |
| Image and source link | `photo`, `url`, `attribution` |
| Number of ingredients | counted from the length of `ingredients[]` (not an API field) |

### What the API does **not** provide

Price, customer ratings, calories/nutrition and taste/flavor profiles are not in this API, so the website has no filters for them and nothing was made up to fill the gap. (The "Style / category" tags such as *sour* or *creamy* are the closest thing to a taste description that the API offers.)

## 2. How the data is cleaned (`fetch_data.py`)

- **A balanced sample.** Getting the measures, garnish and steps needs one API call per drink, and the API allows about 110 per minute, so all 7,000+ drinks would take about an hour. By default the script downloads **500 drinks, taken in turn from each base spirit** (gin, vodka, rum, whiskey, tequila, brandy, other, non-alcoholic), so every spirit is represented. Use `--limit N` for a different size or `--all` for everything.
- **Strength.** The API reports `abv: 0` both for truly non-alcoholic drinks and for drinks where it could not work out a strength (for example an Avocado Margarita made with tequila). The script only trusts a `0` when the base is non-alcoholic. Every other `0` is treated as **"strength not reported"**. These drinks are shown in an **n/a** column on the chart and are left out of strength filtering unless you tick *Include drinks with no reported strength*. No strength is guessed.
- **Ingredient count** is the number of entries in the API's ingredient list (garnishes such as "Lime wedge" are often listed there too).
- **"Ingredients I have"** matches on the API's normalized ingredient `key` (for example `lime_juice`). A few recipes have messy ingredient text such as "1/2 oz silver tequila". Keys used by only one recipe are left out of the picker, and an ingredient with no `key` cannot be matched, so it counts as missing. Matching is exact: many recipes name specific brands (for example "Ketel One Vodka" or "Rutte Dry Gin"), and a brand-name ingredient is a different ingredient from a generic one such as "Vodka". Pick the exact ingredients you want; the site does not guess that one stands in for another.
- **Measurements.** Some recipes put the amount inside the ingredient name and leave `amount` as a bare number such as `1`. The website hides a bare number (the real amount is in the name) and shows amounts that include a unit, such as `50 ml`.
- Duplicates are removed, text is trimmed, and the results are saved to `web/data/cocktails.json`. The script prints a short data-quality report at the end.

## 3. How the website works

Everything on the page is driven by **one shared set of filters**. Changing any control re-draws the chart, the bars and the table at the same time, and the numbers always agree.

**Filters** (all combine with AND, so a drink must satisfy all of them):

| Filter | How to use it | Rule |
|---|---|---|
| Strength | Two-handle slider | Strength must be inside the range |
| Number of ingredients | Two-handle slider | Ingredient count must be inside the range |
| Base spirit | Click bars (several allowed) | Drink's base is **any** of the selected spirits |
| Style / category | Click bars; *Match all / Match any* switch | With *Match all* (default) the drink needs every selected style; with *Match any*, at least one |
| Preparation method | Click bars (several allowed) | Method is **any** of the selected methods |
| Ingredients I have | Type in the box (for example "bourbon" or "lime") or click the quick buttons, then choose a mode: | **Use all of these** (default): the drink contains every ingredient you picked. **Use any of these**: it contains at least one. **I can make (only these)**: the drink needs at most N ingredients you did not pick (set N with "allowing up to N missing"; 0 means you own everything it needs). In every mode a **Missing** column shows how many required ingredients you would still need, and the table starts sorted by it. |

Chips under the filters list what is active, and each has an **×** to remove it. **Reset all filters** clears everything.

**The linked views**

1. **Scatter chart: strength vs. number of ingredients.** One dot per cocktail. Blue dots match all filters, gray dots are filtered out, and the orange dot is the drink you pinned. Drag a box on the chart to set the strength *and* ingredient-count ranges in one move (the sliders follow); double-click the chart to clear those two ranges. The shaded rectangle shows where the current ranges sit. Dots in the **n/a** column have no reported strength.
2. **Bar charts (base spirit, style, method).** Each bar counts the drinks that match *all the other* filters, so you can see what would be left if you added that choice. They are also the filter controls: click a bar to select it (selected bars are blue with a check mark, the others turn gray).
3. **Results table.** The table view of every blue dot. Click a column heading to sort. With "ingredients I have" active, a **Missing** column appears.
4. **Detail panel.** Hover a dot or a table row (or press Tab to a row) to preview a cocktail; click to pin it. It shows the photo, name, base spirit, styles, strength, ingredient count, prep time, difficulty, every ingredient with its measurement (marked ✓ have / ✗ missing when you use "ingredients I have"), glass, method, garnish, ice, instructions, and a link to the recipe. A **"Why it matches your filters"** list shows a ✓ or ✗ for each active filter, so you can see exactly why a drink is in the results.

Example searches to try:

- *Strong tequila cocktail with few ingredients:* click **Tequila**, then drag a box over the high-strength, low-ingredient corner of the chart (or move the sliders). If a **Strong** style bar is listed, you can click it too.
- *Lighter gin sour:* click **Gin** and **Sour**, then drag the top of the strength slider down.
- *What can I make with my bourbon?* Add "Bourbon whiskey" under "Ingredients I have". The table lists every drink that uses it, with the fewest extra ingredients needed at the top.
- *What can I make tonight?* Add everything you own, switch the mode to **I can make (only these)**, and keep "allowing up to 0 missing". Raise it to 1 to see drinks that are one ingredient away. (This mode needs *every* ingredient of a recipe, so it only returns results once you have picked enough ingredients.)
- If a combination of filters returns nothing, the table says which single filter to remove to get results back, with a button for each.

## 4. How to run it locally

**You need:** Python 3.8 or newer and an internet connection for the download step. Nothing needs to be installed with `pip`; only Python's standard library is used.

**Step 1: open a terminal in the project folder** (the folder that contains `fetch_data.py`, `serve.py` and `web/`).

- Windows: open the folder in File Explorer, click the address bar, type `cmd` and press Enter. Or in PowerShell: `cd "C:\path\to\cocktail-explorer"`
- macOS/Linux: `cd /path/to/cocktail-explorer`

**Step 2: download and clean the data** (once):

```
python fetch_data.py
```

On Windows, if `python` is not recognized, use `py fetch_data.py`. On macOS/Linux, use `python3 fetch_data.py` if needed.

This takes about 6 minutes for the default 500 drinks and prints its progress. It saves a cache in `data/raw/`, so if you stop it (Ctrl+C) and run it again, it continues where it left off. When it finishes it prints `Saved 500 cocktails ...` and a short data-quality report.

Options:

```
python fetch_data.py --limit 150   # smaller and faster (about 2 minutes)
python fetch_data.py --all         # every cocktail (7,000+, roughly an hour)
python fetch_data.py --refresh     # ignore the cache and download again
```

**Step 3: start the website:**

```
python serve.py
```

Then open **<http://localhost:8000>** in your browser (it should open by itself). Press **Ctrl+C** in the terminal to stop the server. If port 8000 is busy, use another one, for example `python serve.py 9000` and open <http://localhost:9000>.

### If something goes wrong

| Problem | What to do |
|---|---|
| The page says "No cocktail data yet" | Run `python fetch_data.py` first (Step 2), then reload the page. |
| The page is blank or shows a file error when opened by double-clicking `index.html` | The site must be opened through `python serve.py` at `http://localhost:8000`; browsers block loading the data file from a plain file. |
| `fetch_data.py` reports network problems | Check your internet connection and run it again; it resumes from its cache. A school or work network that blocks `24cocktails.com` will also block it. |
| Photos are missing | Photos load from 24cocktails.com when you view the page. The site shows "No photo available" if one cannot load; everything else still works. |
| The data looks stale | Run `python fetch_data.py --refresh`. |

## 5. Project structure

```
cocktail-explorer/
├── README.md          this file
├── fetch_data.py      downloads + cleans the API data  ->  web/data/cocktails.json
├── serve.py           serves the website at http://localhost:8000
├── data/raw/          (created by fetch_data.py) cached API responses
└── web/
    ├── index.html     page layout
    ├── style.css      styles (light and dark mode)
    ├── app.js         filters, charts, table and detail panel
    └── data/
        └── cocktails.json   (created by fetch_data.py) the cleaned data the site reads
```

## 6. Credits

Recipe data and photos: [24cocktails.com](https://24cocktails.com/developers.html) via the free 24Cocktails API. Each drink in the website links to its original recipe page. Charts are drawn with plain JavaScript and the HTML canvas; no libraries are used.
