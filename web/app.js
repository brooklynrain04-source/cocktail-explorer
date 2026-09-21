/* Cocktail Explorer - all charts and the table are driven by ONE shared filter state.
   Change any filter (slider, bar, pill, brush on the chart) -> update() re-draws everything. */
(async function main() {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  // Build DOM safely. Text from the API is always inserted as text, never as HTML.
  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  const pretty = (s) => {
    s = String(s).replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const BASE_LABEL = { gin: 'Gin', vodka: 'Vodka', rum: 'Rum', whiskey: 'Whiskey', tequila: 'Tequila', brandy: 'Brandy', other: 'Other spirit', na: 'Non-alcoholic' };
  const BASE_ORDER = ['gin', 'vodka', 'rum', 'whiskey', 'tequila', 'brandy', 'other', 'na'];
  const baseLabel = (b) => BASE_LABEL[b] || pretty(b);
  const safeUrl = (u) => {
    try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
  };
  const list = (arr) => arr.join(', ');
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ---------------------------------------------------------------- load data
  let data;
  try {
    const res = await fetch('data/cocktails.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    $('#setup').hidden = false;
    return;
  }
  const D = data.cocktails || [];
  if (!D.length) { $('#setup').hidden = false; return; }
  $('#app').hidden = false;

  // ---------------------------------------------------------------- prepare records
  function hash01(text) {               // stable pseudo-random 0..1, so dots don't jump around
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
  }
  for (const d of D) {
    d.catSet = new Set(d.categories || []);
    d._jx = hash01(d.slug + 'x') - 0.5;
    d._jy = hash01(d.slug + 'y') - 0.5;
    d.keySet = new Set(d.ingredients.map((i) => i.key).filter(Boolean));   // every ingredient key in the recipe
    d._miss = 0;    // required ingredients the user does not have
    d._hit = 0;     // how many of the user's picked ingredients are in this recipe
    d._m = true;
    d._x = d._y = -1000;
  }
  const known = D.filter((d) => d.strength_known);
  const unknownCount = D.length - known.length;
  const ABV_MAX = Math.max(5, Math.ceil(Math.max(0, ...known.map((d) => d.abv)) / 5) * 5);
  const ING_MIN = Math.min(...D.map((d) => d.ingredient_count));
  const ING_MAX = Math.max(...D.map((d) => d.ingredient_count));
  const byName = new Map(D.map((d) => [d.slug, d]));
  const ingIndex = data.ingredient_index || [];
  const ingLabel = new Map(ingIndex.map((i) => [i.key, i.label]));

  // ---------------------------------------------------------------- shared filter state
  const state = {
    abv: [0, ABV_MAX],
    nIng: [ING_MIN, ING_MAX],
    includeUnknown: false,
    bases: new Set(),
    cats: new Set(),
    catMode: 'all',
    methods: new Set(),
    have: new Set(),
    haveMode: 'all',      // 'all' = uses all my ingredients, 'any' = uses at least one, 'make' = I can make it
    allowMissing: 0,      // only used by the 'make' mode
    sort: { key: 'name', dir: 1 },
    rows: 50,
    selected: null,   // pinned drink (slug)
    hover: null,      // drink under the pointer (slug)
    catExpanded: false,
  };

  const missingIngredients = (d) =>
    d.ingredients.filter((i) => !i.optional && (!i.key || !state.have.has(i.key)));

  function catPass(d) {
    const chosen = [...state.cats];
    return state.catMode === 'all' ? chosen.every((c) => d.catSet.has(c)) : chosen.some((c) => d.catSet.has(c));
  }

  function havePass(d) {
    if (state.haveMode === 'all') return d._hit === state.have.size;
    if (state.haveMode === 'any') return d._hit >= 1;
    return d._miss <= state.allowMissing;           // 'make'
  }

  // Does this drink pass every filter? `skip` leaves one group out
  // ('abv', 'ing', 'base', 'cat', 'method' or 'have'); used for the bar counts and the "try loosening" hints.
  function passes(d, skip) {
    if (skip !== 'abv') {
      if (d.strength_known) {
        if (d.abv < state.abv[0] || d.abv > state.abv[1]) return false;
      } else if (!state.includeUnknown) return false;
    }
    if (skip !== 'ing' && (d.ingredient_count < state.nIng[0] || d.ingredient_count > state.nIng[1])) return false;
    if (skip !== 'base' && state.bases.size && !state.bases.has(d.base)) return false;
    if (skip !== 'cat' && state.cats.size && !catPass(d)) return false;
    if (skip !== 'method' && state.methods.size && !state.methods.has(d.method)) return false;
    if (skip !== 'have' && state.have.size && !havePass(d)) return false;
    return true;
  }

  // Human-readable "why does / doesn't this drink match" lines.
  function explain(d) {
    const out = [];
    const abvNarrow = state.abv[0] > 0 || state.abv[1] < ABV_MAX;
    if (d.strength_known && abvNarrow) {
      const ok = d.abv >= state.abv[0] && d.abv <= state.abv[1];
      out.push({ ok, text: `Strength ${d.abv}% is ${ok ? 'inside' : 'outside'} your ${state.abv[0]}–${state.abv[1]}% range` });
    } else if (!d.strength_known) {
      out.push({ ok: state.includeUnknown, text: state.includeUnknown ? 'Strength not reported by the API (included by your setting)' : 'Strength not reported by the API (excluded; tick “Include drinks with no reported strength”)' });
    }
    if (state.nIng[0] > ING_MIN || state.nIng[1] < ING_MAX) {
      const ok = d.ingredient_count >= state.nIng[0] && d.ingredient_count <= state.nIng[1];
      out.push({ ok, text: `${d.ingredient_count} ingredients is ${ok ? 'inside' : 'outside'} your ${state.nIng[0]}–${state.nIng[1]} range` });
    }
    if (state.bases.size) {
      const ok = state.bases.has(d.base);
      out.push({ ok, text: `Base spirit: ${baseLabel(d.base)} (${ok ? 'selected' : 'not among ' + list([...state.bases].map(baseLabel))})` });
    }
    if (state.cats.size) {
      const ok = catPass(d);
      const have = [...state.cats].filter((c) => d.catSet.has(c)).map(pretty);
      out.push({ ok, text: ok ? `Style: ${list(have)} (${state.catMode === 'all' ? 'has all' : 'has one of'} the selected styles)` : `Style: missing ${list([...state.cats].filter((c) => !d.catSet.has(c)).map(pretty))}` });
    }
    if (state.methods.size) {
      const ok = state.methods.has(d.method);
      out.push({ ok, text: `Method: ${pretty(d.method || 'unknown')} (${ok ? 'selected' : 'not among ' + list([...state.methods].map(pretty))})` });
    }
    if (state.have.size) {
      const ok = havePass(d);
      const mine = [...state.have];
      const nameOf = (key) => ingLabel.get(key) || pretty(key);
      if (state.haveMode === 'all') {
        const absent = mine.filter((k) => !d.keySet.has(k));
        out.push({ ok, text: ok ? `Uses all your picked ingredients (${list(mine.map(nameOf))})` : `Does not use: ${list(absent.map(nameOf))}` });
      } else if (state.haveMode === 'any') {
        const used = mine.filter((k) => d.keySet.has(k));
        out.push({ ok, text: ok ? `Uses ${list(used.map(nameOf))}` : 'Uses none of your picked ingredients' });
      } else {
        const miss = missingIngredients(d);
        out.push({ ok, text: miss.length ? `Missing ${miss.length}: ${list(miss.map((i) => i.name))}${ok ? ' (within your allowance)' : ''}` : 'You have every required ingredient' });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- range sliders
  function makeRange(root, min, max, key, format, outEl) {
    const lo = el('input', { type: 'range', min, max, step: 1, 'aria-label': root.dataset.loLabel });
    const hi = el('input', { type: 'range', min, max, step: 1, 'aria-label': root.dataset.hiLabel });
    const fill = $('.fill', root);
    root.append(lo, hi);
    lo.addEventListener('input', () => { state[key] = [Math.min(+lo.value, state[key][1]), state[key][1]]; update(); });
    hi.addEventListener('input', () => { state[key] = [state[key][0], Math.max(+hi.value, state[key][0])]; update(); });
    return function sync() {
      const [a, b] = state[key];
      lo.value = a; hi.value = b;
      const span = max - min || 1, p1 = (a - min) / span, p2 = (b - min) / span;
      fill.style.left = `calc(9px + (100% - 18px) * ${p1})`;
      fill.style.width = `calc((100% - 18px) * ${p2 - p1})`;
      lo.style.zIndex = a === b && a === max ? 5 : 3;   // keep both thumbs reachable when they meet
      hi.style.zIndex = 4;
      outEl.textContent = format(a, b);
    };
  }
  const syncAbv = makeRange($('#abvRange'), 0, ABV_MAX, 'abv', (a, b) => `${a}–${b}%`, $('#abvOut'));
  const syncIng = makeRange($('#ingRange'), ING_MIN, ING_MAX, 'nIng', (a, b) => (a === b ? `${a}` : `${a}–${b}`), $('#ingOut'));
  $('#unknownCount').textContent = unknownCount;
  $('#incUnknown').addEventListener('change', (e) => { state.includeUnknown = e.target.checked; update(); });

  // ---------------------------------------------------------------- "ingredients I have"
  const haveInput = $('#haveInput'), suggest = $('#suggest');
  let suggestItems = [], suggestActive = -1;

  function addHave(key) {
    // First ingredient: put the drinks that need the fewest extra ingredients at the top of the table.
    if (!state.have.size && state.sort.key === 'name') state.sort = { key: 'miss', dir: 1 };
    state.have.add(key); haveInput.value = ''; closeSuggest(); update();
  }
  function closeSuggest() { suggest.hidden = true; suggestItems = []; suggestActive = -1; }
  function openSuggest() {
    const q = haveInput.value.trim().toLowerCase();
    if (!q) { closeSuggest(); return; }
    suggestItems = ingIndex.filter((i) => !state.have.has(i.key) && (i.label.toLowerCase().includes(q) || i.key.includes(q.replace(/\s+/g, '_')))).slice(0, 8);
    suggestActive = suggestItems.length ? 0 : -1;
    renderSuggest();
  }
  function renderSuggest() {
    suggest.replaceChildren();
    if (!suggestItems.length) {
      if (haveInput.value.trim()) suggest.append(el('li', { class: 'n', text: 'No matching ingredient in this data' }));
      suggest.hidden = !haveInput.value.trim();
      return;
    }
    suggestItems.forEach((item, i) => {
      suggest.append(el('li', { role: 'option', 'aria-selected': String(i === suggestActive), onmousedown: (e) => { e.preventDefault(); addHave(item.key); } },
        el('span', { text: item.label }), el('span', { class: 'n', text: `${item.count} drinks` })));
    });
    suggest.hidden = false;
  }
  haveInput.addEventListener('input', openSuggest);
  haveInput.addEventListener('blur', closeSuggest);
  haveInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && suggestItems.length) { suggestActive = (suggestActive + 1) % suggestItems.length; renderSuggest(); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && suggestItems.length) { suggestActive = (suggestActive - 1 + suggestItems.length) % suggestItems.length; renderSuggest(); e.preventDefault(); }
    else if (e.key === 'Enter' && suggestItems[suggestActive]) { addHave(suggestItems[suggestActive].key); e.preventDefault(); }
    else if (e.key === 'Escape') closeSuggest();
  });
  $('#allowMissing').addEventListener('change', (e) => { state.allowMissing = +e.target.value; update(); });
  $('#haveMode').addEventListener('change', (e) => { state.haveMode = e.target.value; update(); });

  const quick = ingIndex.slice(0, 10);
  function renderPills() {
    // Selected ingredients (removable), then the common ones as quick toggles.
    const shown = $('#havePills');
    shown.replaceChildren(...[...state.have].map((key) =>
      el('button', { type: 'button', class: 'pill', 'aria-pressed': 'true', title: 'Remove', onclick: () => { state.have.delete(key); update(); } },
        `${ingLabel.get(key) || pretty(key)} ×`)));
    $('#quickPills').replaceChildren(...quick.filter((i) => !state.have.has(i.key)).map((i) =>
      el('button', { type: 'button', class: 'pill', 'aria-pressed': 'false', onclick: () => addHave(i.key) }, `+ ${i.label}`)));
    const hints = {
      all: 'Showing drinks that contain every ingredient you picked. The Missing column shows how many other ingredients each one still needs.',
      any: 'Showing drinks that contain at least one ingredient you picked. The Missing column shows how many other ingredients each one still needs.',
      make: `Showing drinks where at most ${state.allowMissing} required ingredient${state.allowMissing === 1 ? ' is' : 's are'} missing. Optional ingredients are not counted.`,
    };
    $('#haveHint').textContent = state.have.size
      ? hints[state.haveMode]
      : 'Pick what you have (ingredient names come straight from the recipes, so try a word like "bourbon" or "lime"). Then choose how strictly to match.';
    $('#missWrap').hidden = state.haveMode !== 'make';
  }

  // ---------------------------------------------------------------- bar charts (also filters)
  const catTotals = new Map();
  for (const d of D) for (const c of d.categories || []) catTotals.set(c, (catTotals.get(c) || 0) + 1);
  const methodTotals = new Map();
  for (const d of D) if (d.method) methodTotals.set(d.method, (methodTotals.get(d.method) || 0) + 1);
  const basesPresent = BASE_ORDER.filter((b) => D.some((d) => d.base === b)).concat([...new Set(D.map((d) => d.base))].filter((b) => !BASE_ORDER.includes(b)));

  const GROUPS = [
    { id: 'base', title: 'Base spirit', set: state.bases, values: basesPresent, get: (d) => [d.base], label: baseLabel },
    { id: 'cat', title: 'Style / category', set: state.cats, values: [...catTotals.keys()].sort((a, b) => catTotals.get(b) - catTotals.get(a) || a.localeCompare(b)), get: (d) => d.categories || [], label: pretty },
    { id: 'method', title: 'Preparation method', set: state.methods, values: [...methodTotals.keys()].sort((a, b) => methodTotals.get(b) - methodTotals.get(a) || a.localeCompare(b)), get: (d) => (d.method ? [d.method] : []), label: pretty },
  ];
  const TOP_CATS = 12;

  function buildBars() {
    const root = $('#bars');
    for (const g of GROUPS) {
      g.rows = new Map();
      const head = el('h3', {}, el('span', { text: g.title }));
      if (g.id === 'cat') {
        const seg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Match all or any selected styles' });
        for (const mode of ['all', 'any']) {
          seg.append(el('button', { type: 'button', 'aria-pressed': String(state.catMode === mode), 'data-mode': mode, text: mode === 'all' ? 'Match all' : 'Match any',
            onclick: () => { state.catMode = mode; update(); } }));
        }
        head.append(seg);
      }
      g.box = el('div', { class: 'bgroup' }, head);
      for (const value of g.values) {
        const row = el('button', { type: 'button', class: 'brow', 'aria-pressed': 'false',
          onclick: () => { g.set.has(value) ? g.set.delete(value) : g.set.add(value); update(); } },
          el('span', { class: 'blabel' }, el('span', { class: 'tick', text: '✓' }), g.label(value)),
          el('span', { class: 'btrack' }, el('span', { class: 'bfill' })),
          el('span', { class: 'bcount', text: '0' }));
        g.rows.set(value, row);
        g.box.append(row);
      }
      if (g.id === 'cat' && g.values.length > TOP_CATS) {
        g.expander = el('button', { type: 'button', class: 'btn expand', onclick: () => { state.catExpanded = !state.catExpanded; renderBars(); } });
        g.box.append(g.expander);
      }
      root.append(g.box);
    }
  }

  function renderBars() {
    for (const g of GROUPS) {
      const counts = new Map();
      for (const d of D) {
        if (!passes(d, g.id)) continue;      // every OTHER filter still applies
        for (const v of g.get(d)) counts.set(v, (counts.get(v) || 0) + 1);
      }
      let max = 1;
      g.values.forEach((v, i) => { if (g.id !== 'cat' || state.catExpanded || i < TOP_CATS || g.set.has(v)) max = Math.max(max, counts.get(v) || 0); });
      g.values.forEach((v, i) => {
        const row = g.rows.get(v), n = counts.get(v) || 0;
        const visible = g.id !== 'cat' || state.catExpanded || i < TOP_CATS || g.set.has(v);
        row.hidden = !visible;
        row.setAttribute('aria-pressed', String(g.set.has(v)));
        row.classList.toggle('zero', n === 0);
        $('.bfill', row).style.width = `${(n / max) * 100}%`;
        $('.bcount', row).textContent = n;
        row.title = `${g.label(v)}: ${n} drink${n === 1 ? '' : 's'} match all your other filters`;
      });
      g.box.classList.toggle('has-sel', g.set.size > 0);
      if (g.expander) g.expander.textContent = state.catExpanded ? 'Show fewer styles' : `Show all ${g.values.length} styles`;
      if (g.id === 'cat') for (const b of $('.seg', g.box).children) b.setAttribute('aria-pressed', String(b.dataset.mode === state.catMode));
    }
  }

  // ---------------------------------------------------------------- scatter chart (canvas)
  const canvas = $('#scatter'), ctx = canvas.getContext('2d'), tip = $('#tip');
  const PAD = { l: 46, r: 14, t: 12, b: 44 };
  let geo = null;       // current chart geometry, used for drawing and for the brush
  let brush = null;     // {x0,y0,x1,y1,moved} while the user drags a box
  let raf = 0;

  function layout() {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const naW = unknownCount ? 40 : 0, naGap = unknownCount ? 26 : 0;
    const ax0 = PAD.l + naW + naGap, ax1 = w - PAD.r;
    const yMin = ING_MIN - 0.5, yMax = ING_MAX + 0.5, top = PAD.t, bottom = h - PAD.b;
    geo = {
      w, h, naW, ax0, ax1, top, bottom, yMin, yMax,
      naX: PAD.l + naW / 2,
      x: (abv) => ax0 + (abv / ABV_MAX) * (ax1 - ax0),
      y: (n) => top + ((yMax - n) / (yMax - yMin)) * (bottom - top),
      abvAt: (px) => ((px - ax0) / (ax1 - ax0)) * ABV_MAX,
      nAt: (py) => yMax - ((py - top) / (bottom - top)) * (yMax - yMin),
    };
    return geo;
  }

  function drawScatter() {
    const g = layout();
    const c = { surface: cssVar('--surface'), grid: cssVar('--grid'), axis: cssVar('--axis'), muted: cssVar('--muted'), ink2: cssVar('--ink2'),
      s1: cssVar('--series1'), s2: cssVar('--series2'), ghost: cssVar('--ghost') };
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';

    // gridlines + tick labels (hairlines, solid)
    ctx.lineWidth = 1;
    const yStep = ING_MAX - ING_MIN > 14 ? 2 : 1;
    ctx.textAlign = 'right';
    for (let n = ING_MIN; n <= ING_MAX; n += yStep) {
      const y = Math.round(g.y(n)) + 0.5;
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(PAD.l - 4, y); ctx.lineTo(g.ax1, y); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(String(n), PAD.l - 10, y);
    }
    ctx.textAlign = 'center';
    const xStep = ABV_MAX > 40 ? 10 : 5;
    for (let a = 0; a <= ABV_MAX; a += xStep) {
      const x = Math.round(g.x(a)) + 0.5;
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(x, g.top); ctx.lineTo(x, g.bottom); ctx.stroke();
      ctx.fillStyle = c.muted; ctx.fillText(a + '%', x, g.bottom + 14);
    }
    ctx.strokeStyle = c.axis; ctx.beginPath(); ctx.moveTo(PAD.l - 4, Math.round(g.bottom) + 0.5); ctx.lineTo(g.ax1, Math.round(g.bottom) + 0.5); ctx.stroke();
    if (unknownCount) {
      ctx.fillStyle = c.muted; ctx.fillText('n/a', g.naX, g.bottom + 14);
      ctx.strokeStyle = c.grid; ctx.beginPath(); ctx.moveTo(PAD.l + g.naW + 12.5, g.top); ctx.lineTo(PAD.l + g.naW + 12.5, g.bottom); ctx.stroke();
    }
    ctx.fillStyle = c.ink2; ctx.textAlign = 'center';
    ctx.fillText('Strength (% ABV)  ·  n/a = strength not reported by the API', (g.ax0 + g.ax1) / 2, g.h - 10);
    ctx.save(); ctx.translate(12, (g.top + g.bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('Ingredients', 0, 0); ctx.restore();

    // where the current slider ranges sit on the chart
    if (state.abv[0] > 0 || state.abv[1] < ABV_MAX || state.nIng[0] > ING_MIN || state.nIng[1] < ING_MAX) {
      const x0 = g.x(state.abv[0]), x1 = g.x(state.abv[1]), y0 = g.y(state.nIng[1] + 0.5), y1 = g.y(state.nIng[0] - 0.5);
      ctx.fillStyle = cssVar('--wash'); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = c.s1; ctx.globalAlpha = 0.55; ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, x1 - x0, y1 - y0); ctx.globalAlpha = 1;
    }

    // dot positions (small stable jitter so equal values don't pile up exactly)
    const rowH = (g.bottom - g.top) / (g.yMax - g.yMin);
    for (const d of D) {
      d._x = (d.strength_known ? g.x(d.abv) : g.naX) + d._jx * (d.strength_known ? 7 : 22);
      d._y = g.y(d.ingredient_count) + d._jy * rowH * 0.62;
    }
    const dot = (d, r, fill, ring) => {
      ctx.beginPath(); ctx.arc(d._x, d._y, r, 0, Math.PI * 2);
      if (ring) { ctx.lineWidth = 2; ctx.strokeStyle = c.surface; ctx.stroke(); }
      ctx.fillStyle = fill; ctx.fill();
    };
    ctx.globalAlpha = 0.6;
    for (const d of D) if (!d._m) dot(d, 3.5, c.ghost, false);     // filtered out: quiet gray
    ctx.globalAlpha = 1;
    for (const d of D) if (d._m) dot(d, 4.5, c.s1, true);         // matches: blue
    const sel = state.selected && byName.get(state.selected);
    if (sel) dot(sel, 6.5, c.s2, true);                            // pinned: orange
    const hov = state.hover && byName.get(state.hover);
    if (hov) {
      ctx.beginPath(); ctx.arc(hov._x, hov._y, 9, 0, Math.PI * 2); ctx.lineWidth = 2.5; ctx.strokeStyle = c.s2; ctx.stroke();
      dot(hov, hov === sel ? 6.5 : 5.5, hov === sel ? c.s2 : c.s1, true);
    }

    if (!D.some((d) => d._m)) {
      ctx.fillStyle = c.ink2; ctx.textAlign = 'center'; ctx.font = '600 14px system-ui, sans-serif';
      ctx.fillText('No cocktails match every filter. See the table below for what to loosen.', (g.ax0 + g.ax1) / 2, (g.top + g.bottom) / 2);
    }
    if (brush && brush.moved) {
      const x = Math.min(brush.x0, brush.x1), y = Math.min(brush.y0, brush.y1), w = Math.abs(brush.x1 - brush.x0), h = Math.abs(brush.y1 - brush.y0);
      ctx.fillStyle = cssVar('--wash'); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = c.s1; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
    }
  }
  const scheduleDraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawScatter(); }); };

  function nearestMatch(px, py, radius = 16) {
    let best = null, bestD = radius * radius;
    for (const d of D) {
      if (!d._m) continue;
      const dx = d._x - px, dy = d._y - py, dist = dx * dx + dy * dy;
      if (dist <= bestD) { bestD = dist; best = d; }
    }
    return best;
  }
  const pointer = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  function showTip(d, px, py) {
    if (!d) { tip.hidden = true; return; }
    tip.replaceChildren(el('strong', { text: d.name }),
      el('span', { text: `${d.strength_known ? d.abv + '% ABV' : 'strength not reported'} · ${d.ingredient_count} ingredients · ${baseLabel(d.base)}` }));
    tip.hidden = false;
    const wrap = $('#chartwrap').clientWidth;
    tip.style.left = Math.min(Math.max(4, px + 14), wrap - tip.offsetWidth - 4) + 'px';
    tip.style.top = Math.max(4, py - tip.offsetHeight - 12) + 'px';
  }

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = pointer(e);
    brush = { x0: x, y0: y, x1: x, y1: y, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pointer(e);
    if (brush) {
      brush.x1 = x; brush.y1 = y;
      if (Math.hypot(x - brush.x0, y - brush.y0) > 5) brush.moved = true;
      if (brush.moved) { tip.hidden = true; scheduleDraw(); return; }
    }
    const d = nearestMatch(x, y);
    setHover(d ? d.slug : null, true);
    showTip(d, x, y);
  });
  canvas.addEventListener('pointerup', (e) => {
    const b = brush; brush = null;
    if (!b) return;
    if (b.moved) applyBrush(b);
    else {
      const d = nearestMatch(b.x0, b.y0);
      if (d) toggleSelected(d.slug);
    }
    scheduleDraw();
  });
  canvas.addEventListener('pointerleave', () => { if (!brush) { setHover(null, true); tip.hidden = true; } });
  canvas.addEventListener('dblclick', () => { state.abv = [0, ABV_MAX]; state.nIng = [ING_MIN, ING_MAX]; update(); });

  function applyBrush(b) {
    const g = geo, xa = Math.min(b.x0, b.x1), xb = Math.max(b.x0, b.x1);
    if (xb < g.ax0 - 8) return;   // the box only covered the "n/a" column: nothing to set
    const clampA = (v) => Math.max(0, Math.min(ABV_MAX, v));
    const a0 = Math.round(clampA(g.abvAt(Math.max(xa, g.ax0)))), a1 = Math.round(clampA(g.abvAt(xb)));
    const nA = Math.min(g.nAt(b.y0), g.nAt(b.y1)), nB = Math.max(g.nAt(b.y0), g.nAt(b.y1));
    let n0 = Math.max(ING_MIN, Math.round(nA)), n1 = Math.min(ING_MAX, Math.round(nB));
    if (n0 > n1) n0 = n1 = Math.max(ING_MIN, Math.min(ING_MAX, Math.round((nA + nB) / 2)));
    state.abv = [Math.min(a0, a1), Math.max(a0, a1)];
    state.nIng = [n0, n1];
    update();
  }
  new ResizeObserver(scheduleDraw).observe($('#chartwrap'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleDraw);

  // ---------------------------------------------------------------- "nothing matches" help
  // For every active filter, count how many drinks would match if that one filter were removed,
  // and offer a button to remove it. This shows which filter is the one blocking the results.
  function emptyState() {
    const options = [
      { id: 'abv', label: 'the strength range', on: state.abv[0] > 0 || state.abv[1] < ABV_MAX, clear: () => { state.abv = [0, ABV_MAX]; } },
      { id: 'ing', label: 'the ingredient-count range', on: state.nIng[0] > ING_MIN || state.nIng[1] < ING_MAX, clear: () => { state.nIng = [ING_MIN, ING_MAX]; } },
      { id: 'base', label: 'the base spirit choice', on: state.bases.size > 0, clear: () => state.bases.clear() },
      { id: 'cat', label: 'the style choice', on: state.cats.size > 0, clear: () => state.cats.clear() },
      { id: 'method', label: 'the method choice', on: state.methods.size > 0, clear: () => state.methods.clear() },
      { id: 'have', label: 'the ingredients I have', on: state.have.size > 0, clear: () => state.have.clear() },
    ].filter((o) => o.on).map((o) => ({ ...o, n: D.reduce((s, d) => s + (passes(d, o.id) ? 1 : 0), 0) }))
      .filter((o) => o.n > 0).sort((a, b) => b.n - a.n);

    const box = el('div', {}, el('p', { text: 'No cocktails match every filter at once.' }));
    if (state.have.size && state.haveMode === 'make') {
      box.append(el('p', { class: 'hint', text: '“I can make” needs every ingredient of a recipe, so a short list of ingredients rarely completes a drink. Try “use all of these” or “use any of these”, or allow more missing ingredients.' }));
    }
    if (options.length) {
      box.append(el('p', { class: 'hint', text: 'Try removing one filter:' }),
        el('div', { class: 'pills' }, options.map((o) =>
          el('button', { type: 'button', class: 'pill', onclick: () => { o.clear(); update(); } }, `Remove ${o.label} → ${o.n} match${o.n === 1 ? '' : 'es'}`))));
    }
    return box;
  }

  // ---------------------------------------------------------------- results table
  const COLS = [
    { key: 'name', label: 'Cocktail', get: (d) => d.name.toLowerCase() },
    { key: 'base', label: 'Base spirit', get: (d) => baseLabel(d.base) },
    { key: 'abv', label: 'Strength', num: true, get: (d) => (d.strength_known ? d.abv : null) },
    { key: 'n', label: 'Ingredients', num: true, get: (d) => d.ingredient_count },
    { key: 'method', label: 'Method', get: (d) => d.method || '' },
    { key: 'styles', label: 'Styles', get: (d) => list(d.categories || []) },
    { key: 'miss', label: 'Missing', num: true, get: (d) => d._miss, onlyWithHave: true },
  ];

  function renderTable() {
    const cols = COLS.filter((c) => !c.onlyWithHave || state.have.size);
    if (!cols.some((c) => c.key === state.sort.key)) state.sort = { key: 'name', dir: 1 };
    const sc = COLS.find((c) => c.key === state.sort.key);
    const rows = D.filter((d) => d._m).sort((a, b) => {
      const va = sc.get(a), vb = sc.get(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;                       // unreported strength always last
      if (vb === null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : a.name.localeCompare(b.name)) * state.sort.dir;
    });

    $('#table thead').replaceChildren(el('tr', {}, cols.map((c) =>
      el('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': c.key === state.sort.key ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none' },
        el('button', { type: 'button', onclick: () => { state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : 1 }; renderTable(); } },
          c.label + (c.key === state.sort.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''))))));

    const body = $('#table tbody');
    if (!rows.length) {
      body.replaceChildren(el('tr', { class: 'static' }, el('td', { colspan: cols.length, class: 'empty' }, emptyState())));
    } else {
      body.replaceChildren(...rows.slice(0, state.rows).map((d) => {
        const photo = safeUrl(d.photo);
        const cells = {
          name: el('td', {}, el('div', { class: 'namecell' },
            photo ? el('img', { class: 'thumb', src: photo, alt: '', loading: 'lazy', onerror: (e) => e.target.remove() }) : null, d.name)),
          base: el('td', { text: baseLabel(d.base) }),
          abv: el('td', { class: 'num', text: d.strength_known ? d.abv + '%' : 'n/a' }),
          n: el('td', { class: 'num', text: d.ingredient_count }),
          method: el('td', { text: d.method ? pretty(d.method) : '–' }),
          styles: el('td', { class: 'styles', title: list((d.categories || []).map(pretty)), text: list((d.categories || []).map(pretty)) }),
          miss: el('td', { class: 'num', text: d._miss }),
        };
        const tr = el('tr', { tabindex: '0', 'data-slug': d.slug, class: state.selected === d.slug ? 'sel' : '',
          onmouseenter: () => setHover(d.slug), onmouseleave: () => setHover(null), onfocus: () => setHover(d.slug), onblur: () => setHover(null),
          onclick: () => toggleSelected(d.slug),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); } } },
          cols.map((c) => cells[c.key]));
        return tr;
      }));
    }
    const left = rows.length - state.rows;
    const more = $('#moreRows');
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(50, left)} more (${left} not shown)`;
    more.onclick = () => { state.rows += 50; renderTable(); };
  }

  // Pin / unpin a drink without rebuilding the table (so keyboard focus stays where it was).
  function toggleSelected(slug) {
    state.selected = state.selected === slug ? null : slug;
    for (const tr of $('#table tbody').children) tr.classList.toggle('sel', tr.dataset.slug === state.selected);
    renderDetail(true);
    scheduleDraw();
  }

  // ---------------------------------------------------------------- detail panel
  let shownSlug = null, shownSig = '';
  function setHover(slug, fromChart) {
    if (state.hover === slug) return;
    state.hover = slug;
    for (const tr of $('#table tbody').children) tr.classList.toggle('hl', tr.dataset.slug === slug);
    if (!fromChart && !slug) tip.hidden = true;
    renderDetail(false);
    scheduleDraw();
  }

  function renderDetail(force) {
    const slug = state.hover || state.selected, box = $('#detail');
    const d = slug && byName.get(slug);
    const sig = slug + '|' + (d ? d._m : '');
    if (!force && slug === shownSlug && sig === shownSig) return;
    shownSlug = slug; shownSig = sig;
    if (!d) {
      box.replaceChildren(el('p', { class: 'ph' }, 'Hover a dot or a table row to preview a cocktail here. Click to pin it.'));
      return;
    }
    const photo = safeUrl(d.photo), link = safeUrl(d.url);
    const noPhoto = () => el('div', { class: 'nophoto', text: 'No photo available' });
    const img = photo ? el('img', { class: 'photo', src: photo, alt: `Photo of ${d.name}`, onerror: (e) => e.target.replaceWith(noPhoto()) }) : noPhoto();

    const why = explain(d);
    const whyList = el('ul', { class: 'why' }, (why.length ? why : [{ ok: true, text: 'No filters set: every drink matches.' }]).map((w) =>
      el('li', {}, el('span', { class: w.ok ? 'ok' : 'no', 'aria-label': w.ok ? 'matches' : 'does not match', text: w.ok ? '✓' : '✗' }), el('span', { text: w.text }))));

    const haveOn = state.have.size > 0;
    const ingList = el('ul', { class: 'ings' }, d.ingredients.map((i) => {
      const missing = haveOn && !i.optional && (!i.key || !state.have.has(i.key));
      const amount = i.amount && (/[a-z]/i.test(i.amount) || i.ml != null) ? i.amount : '';
      const status = !haveOn ? (i.optional ? 'optional' : '') : i.optional ? 'optional' : missing ? '✗ missing' : '✓ have';
      return el('li', { class: haveOn ? (missing ? 'miss' : (i.optional ? '' : 'have')) : '' },
        el('span', { class: 'amt', text: amount }), el('span', { text: i.name }), el('span', { class: 'st', text: status }));
    }));

    const facts = [['Glass', d.glass], ['Method', d.method ? pretty(d.method) : d.method_text], ['Garnish', d.garnish], ['Ice', d.ice]].filter((f) => f[1]);
    box.replaceChildren(img, el('div', { class: 'pad' },
      el('h2', { text: d.name }),
      el('div', { class: 'tags' }, el('span', { class: 'tag strong', text: baseLabel(d.base) }), (d.categories || []).map((c) => el('span', { class: 'tag', text: pretty(c) }))),
      d.description ? el('p', { class: 'hint', text: d.description }) : null,
      el('div', { class: 'stats' },
        stat(d.strength_known ? d.abv + '%' : 'n/a', 'strength'), stat(String(d.ingredient_count), 'ingredients'),
        stat(d.prep_minutes != null ? d.prep_minutes + ' min' : 'n/a', 'prep time'), stat(d.difficulty != null ? String(d.difficulty) : 'n/a', 'difficulty')),
      el('h3', { text: 'Why it matches your filters' }),
      el('p', { class: 'verdict', text: d._m ? 'Matches all current filters' : 'Filtered out by the current filters' }),
      whyList,
      el('h3', { text: 'Ingredients' }), ingList,
      facts.length ? el('h3', { text: 'Preparation' }) : null,
      facts.length ? el('dl', { class: 'kv' }, facts.map((f) => [el('dt', { text: f[0] }), el('dd', { text: f[1] })])) : null,
      d.steps && d.steps.length ? [el('h3', { text: 'Instructions' }), el('ol', { class: 'steps' }, d.steps.map((s) => el('li', { text: s })))] : null,
      link ? el('p', { class: 'src' }, 'Recipe from ', el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: (d.attribution || '24cocktails.com') + ' ↗' })) : null));
  }
  const stat = (v, l) => el('div', { class: 'stat' }, el('div', { class: 'v', text: v }), el('div', { class: 'l', text: l }));

  // ---------------------------------------------------------------- active-filter chips
  function renderChips() {
    const chips = [];
    const chip = (text, remove) => chips.push(el('span', { class: 'chip' }, text, el('button', { type: 'button', 'aria-label': 'Remove filter: ' + text, onclick: remove, text: '×' })));
    if (state.abv[0] > 0 || state.abv[1] < ABV_MAX) chip(`Strength ${state.abv[0]}–${state.abv[1]}%`, () => { state.abv = [0, ABV_MAX]; update(); });
    if (state.includeUnknown) chip('Including unreported strength', () => { state.includeUnknown = false; update(); });
    if (state.nIng[0] > ING_MIN || state.nIng[1] < ING_MAX) chip(`${state.nIng[0]}–${state.nIng[1]} ingredients`, () => { state.nIng = [ING_MIN, ING_MAX]; update(); });
    for (const g of GROUPS) for (const v of g.set) chip(`${g.title}: ${g.label(v)}`, () => { g.set.delete(v); update(); });
    if (state.have.size) {
      const n = `${state.have.size} picked ingredient${state.have.size === 1 ? '' : 's'}`;
      const text = state.haveMode === 'all' ? `Uses all of ${n}` : state.haveMode === 'any' ? `Uses any of ${n}` : `Can make from ${n} (≤ ${state.allowMissing} missing)`;
      chip(text, () => { state.have.clear(); update(); });
    }
    $('#chips').replaceChildren(...(chips.length ? chips : [el('span', { class: 'none', text: 'No filters set. Adjust a slider, click a bar, or drag a box on the chart.' })]));
    $('#resetAll').hidden = !chips.length;
  }

  function resetAll() {
    state.abv = [0, ABV_MAX]; state.nIng = [ING_MIN, ING_MAX]; state.includeUnknown = false;
    state.bases.clear(); state.cats.clear(); state.methods.clear(); state.have.clear(); state.haveMode = 'all'; state.allowMissing = 0; state.catMode = 'all';
    state.rows = 50; state.selected = null;
    update();
  }
  $('#resetAll').addEventListener('click', resetAll);

  // ---------------------------------------------------------------- the one update function
  function update() {
    state.hover = null; tip.hidden = true;   // a filter change can remove the drink under the pointer
    for (const d of D) {
      d._miss = state.have.size ? missingIngredients(d).length : 0;
      d._hit = state.have.size ? [...state.have].filter((k) => d.keySet.has(k)).length : 0;
    }
    for (const d of D) d._m = passes(d);
    state.rows = Math.max(50, state.rows);
    syncAbv(); syncIng();
    $('#incUnknown').checked = state.includeUnknown;
    $('#allowMissing').value = String(state.allowMissing);
    $('#haveMode').value = state.haveMode;
    renderPills(); renderChips(); renderBars(); renderTable();
    const n = D.reduce((s, d) => s + (d._m ? 1 : 0), 0);
    $('#countHead').textContent = `${n} of ${D.length} cocktails match`;
    $('#scatterNote').textContent = unknownCount
      ? `${unknownCount} drink${unknownCount === 1 ? '' : 's'} in this data set have no strength from the API (0% is not trusted for spirit-based drinks). They sit in the n/a column and are only matched when you tick “Include drinks with no reported strength”.`
      : '';
    canvas.setAttribute('aria-label', `Scatter chart of ${D.length} cocktails by strength and number of ingredients. ${n} match the filters. The table below lists the same matching drinks.`);
    renderDetail(true);
    drawScatter();
  }

  // ---------------------------------------------------------------- footer + start
  const m = data.meta || {};
  $('#meta').textContent = `${D.length} cocktails loaded (${m.sample || 'sample'}) of ${m.total_in_api || '?'} in the API · fetched ${m.fetched_at_utc || '?'} UTC`;
  $('#foot').replaceChildren('Data: ', el('a', { href: m.source_url || 'https://24cocktails.com/developers.html', target: '_blank', rel: 'noopener noreferrer', text: '24Cocktails API' }),
    '. Each recipe links back to its page on 24cocktails.com. Nothing on this page is invented: fields the API does not provide (price, ratings, calories, taste) are not shown.');
  buildBars();
  update();
})();
