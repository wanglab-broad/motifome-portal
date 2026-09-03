/* =============================================================================
   views/browse.js — the faceted front door to all 900 motif clusters.

   Three things, kept in sync and kept in the URL:
     1. six facet groups whose counts are recomputed live against the OTHER
        active filters, so a zero-result combination is visible before it is
        chosen (a facet value that would empty the table shows a red 0);
     2. a 900-point overview scatter — instances x carrier genes, log-log,
        coloured by module — that BRUSHES the table;
     3. a sortable table of whatever survives.

   Every number on this page comes from portal/data/cluster_index.json (built by
   code/build/11_cluster_index.py from the 900 shards). Nothing is estimated.
   The scatter never hides a cluster: a filtered-out point is dimmed, not
   removed, so the reader always sees the whole corpus behind their filter.
   ============================================================================= */

import * as router from '../router.js';
import { prefetchCluster } from '../data.js';
import {
  el, mount, clear, fmt, emptyState, skeleton, copyLinkButton, csvButton, moduleChip,
  regionBadge, moduleColor, setTitle, scrollTop, displaySeq
} from '../ui.js';
import * as R2 from '../r2-ui.js';

/* =============================================================================
   local style
   ============================================================================= */

const CSS = `
.br-layout { display: grid; grid-template-columns: 292px minmax(0, 1fr); gap: var(--s5);
             align-items: start; }
@media (max-width: 1080px) { .br-layout { grid-template-columns: minmax(0, 1fr); } }
.br-facets { position: sticky; top: calc(var(--topbar-h) + var(--s3));
             max-height: calc(100vh - var(--topbar-h) - var(--s5)); overflow-y: auto;
             padding-right: 4px; scrollbar-width: thin; }
@media (max-width: 1080px) { .br-facets { position: static; max-height: none; overflow: visible; } }
.br-sum { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
          margin-bottom: var(--s3); }
.br-name { color: var(--ink); }
.br-id { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }
.br-row-link { text-decoration: none; }
tr.br-tr { cursor: pointer; }
tr.br-tr:hover td { background: var(--accent-soft); }
.br-search { width: 100%; height: 32px; border-radius: var(--r-md); border: 1px solid var(--line-strong);
             background: var(--surface); color: var(--ink); padding: 0 var(--s3);
             font-size: var(--fs-sm); }
.br-search:focus { outline: none; box-shadow: var(--ring); border-color: var(--accent); }
`;

/* =============================================================================
   facet definitions — every one of these is derived from the index row
   ============================================================================= */

const FACETS = [
  { key: 'region', label: 'Region', multi: true,
    values: [
      { v: 'utr5', label: "5′ UTR", test: r => r.r === 'utr5' },
      { v: 'utr3', label: "3′ UTR", test: r => r.r === 'utr3' },
      { v: 'protein', label: 'Protein', test: r => r.r === 'protein' }
    ] },
  { key: 'module', label: 'Module', multi: true,
    values: [1, 2, 3, 4, 5, 6].map(m => ({ v: String(m), label: 'M' + m, mod: m,
      test: r => r.m === m })).concat([
      { v: '0', label: 'no module', mod: 0, test: r => !r.m }
    ]) },
  { key: 'logo', label: 'Sequence logo', multi: false,
    values: [
      { v: 'has', label: 'has a logo', test: r => !!r.logo },
      { v: 'none', label: 'no defensible logo', test: r => !r.logo }
    ] },
  { key: 'terms', label: 'Enriched terms', multi: false,
    values: [
      { v: 'has', label: 'has a significant term', test: r => r.nterms > 0 },
      { v: 'none', label: 'no significant term', test: r => !r.nterms }
    ] },
  { key: 'partners', label: 'Cross-modal partners', multi: false,
    values: [
      { v: 'has', label: 'has a strict partner', test: r => r.npass > 0 },
      { v: 'none', label: 'no strict partner', test: r => !r.npass },
      { v: 'sugg', label: 'suggestive only', test: r => !r.npass && r.nsug > 0 }
    ] },
  { key: 'size', label: 'Size (instances)', multi: true, dynamic: true }
];

const COLS = [
  { key: 'id', label: 'Cluster', sort: r => r.id, cell: idCell, w: '30%' },
  { key: 'r', label: 'Region', sort: r => r.r, cell: r => regionBadge(r.r), num: false },
  { key: 'm', label: 'Module', sort: r => r.m, cell: r => moduleChip(r.m, { quiet: true, href: false }) },
  { key: 'ni', label: 'Instances', sort: r => r.ni, num: true, cell: r => numCell(r.ni) },
  { key: 'ntx', label: 'Transcripts', sort: r => r.ntx, num: true, cell: r => numCell(r.ntx) },
  { key: 'ng', label: 'Genes', sort: r => r.ng, num: true, cell: r => numCell(r.ng) },
  { key: 'nterms', label: 'Terms', sort: r => r.nterms, num: true,
    cell: r => r.nterms ? numCell(r.nterms) : el('span.tag-off', '—') },
  { key: 'npass', label: 'Strict partners', sort: r => r.npass, num: true,
    cell: r => r.npass ? numCell(r.npass)
      : el('span.tag-off', { title: r.nsug + ' suggestive' }, r.nsug ? '0 (' + r.nsug + ' sugg.)' : '0') },
  { key: 'logo', label: 'Logo', sort: r => r.logo, num: true,
    cell: r => r.logo ? el('span', { title: 'STREME E ' + R2.sig(r.ev) }, '●')
                      : el('span.tag-off', { title: 'no motif at test p < 0.05' }, '○') },
  { key: 'cons', label: 'Top consensus', sort: r => r.cons || '~',
    cell: r => r.cons ? el('span.mono', { style: { fontSize: 'var(--fs-xs)' },
        title: 'coverage ' + fmt.pct(r.cov, 1) }, displaySeq(r.cons, r.r))
      : el('span.tag-off', '—') }
];

function idCell(r) {
  return el('div', [
    el('div.br-name', r.name),
    el('div.br-id', r.id + ' · tier ' + r.tier)
  ]);
}
function numCell(v) { return el('span.mono', fmt.int(v)); }

/* =============================================================================
   state
   ============================================================================= */

let S = null;                    // {ix, rows, nodes...}
let token = 0;

export function teardown() { S = null; token++; }

function qList(q, key) {
  const v = q[key];
  if (v == null || v === '') return [];
  return String(Array.isArray(v) ? v.join(',') : v).split(',').filter(Boolean);
}

function activeFilters() {
  const q = router.getQuery();
  return {
    region: qList(q, 'region'), module: qList(q, 'module'), size: qList(q, 'size'),
    logo: q.logo || null, terms: q.terms || null, partners: q.partners || null,
    text: String(q.q || '').trim().toLowerCase(),
    brush: parseBrush(q.bx),
    sort: q.sort || 'id', dir: q.dir === 'asc' ? 'asc' : (q.sort ? 'desc' : 'asc')
  };
}

function parseBrush(s) {
  if (!s) return null;
  const p = String(s).split(',').map(Number);
  return p.length === 4 && p.every(Number.isFinite) ? p : null;
}

/** Does row r satisfy every filter group except `skip`? */
function matches(r, f, skip) {
  for (const F of FACETS) {
    if (F.key === skip) continue;
    if (F.key === 'size') {
      if (f.size.length && f.size.indexOf(r.sb) === -1) return false;
      continue;
    }
    if (F.multi) {
      const sel = f[F.key];
      if (sel.length) {
        const ok = F.values.some(v => sel.indexOf(v.v) !== -1 && v.test(r));
        if (!ok) return false;
      }
    } else if (f[F.key]) {
      const v = F.values.find(x => x.v === f[F.key]);
      if (v && !v.test(r)) return false;
    }
  }
  if (skip !== '__text' && f.text) {
    const hay = (r.id + ' ' + r.name + ' ' + (r.cons || '') + ' ' + (r.tdisp || '')).toLowerCase();
    if (hay.indexOf(f.text) === -1) return false;
  }
  if (skip !== '__brush' && f.brush) {
    const [x0, x1, y0, y1] = f.brush;
    if (r.ni < x0 || r.ni > x1 || r.ng < y0 || r.ng > y1) return false;
  }
  return true;
}

/* =============================================================================
   render
   ============================================================================= */

export async function render(container, params) {
  R2.ensureR2Style();
  R2.ensureStyle('mirto-browse-style', CSS);
  const mine = ++token;
  setTitle(['Browse clusters']);
  scrollTop();

  const wrap = el('div.wrap.view-pad');
  mount(container, wrap);
  wrap.appendChild(skeleton({ rows: 6, label: 'Loading the cluster index' }));

  const ix = await R2.getClusterIndex();
  if (mine !== token) return;
  clear(wrap);

  wrap.appendChild(el('header', { style: { marginBottom: 'var(--s5)' } }, [
    el('p.eyebrow', 'Browse'),
    el('h1', { style: { margin: '0', fontSize: 'var(--fs-2xl)' } },
      'Motif clusters')
  ]));

  if (!ix) {
    wrap.appendChild(emptyState({
      mark: '◻', title: 'The cluster index has not been built',
      message: 'This page reads a single 900-row index derived from the cluster shards. ' +
        'Build it with:  python code/build/11_cluster_index.py --verify-gate',
      denominator: 'expects portal/data/cluster_index.json (900 rows)',
      action: el('a.btn', { href: router.link('/network') }, 'The network view still works')
    }));
    return;
  }

  S = { ix, rows: ix.rows, meta: ix.meta };
  buildSizeFacet(ix);

  const facetHost = el('aside.br-facets', { 'aria-label': 'Filters' });
  const main = el('div');
  wrap.appendChild(el('div.br-layout', [facetHost, main]));

  S.facetHost = facetHost;
  S.summary = el('div.br-sum');
  S.scatterHost = el('section.rail-card', { style: { marginBottom: 'var(--s4)' } });
  S.tableHost = el('div');

  main.appendChild(S.summary);
  main.appendChild(S.scatterHost);
  main.appendChild(S.tableHost);

  buildScatter();
  paint();

  router.onQuery(() => { if (mine === token) paint(); });
}

function buildSizeFacet(ix) {
  const F = FACETS.find(f => f.key === 'size');
  F.values = (ix.meta.size_buckets || []).map(b => ({
    v: b.key, label: fmt.int(b.min) + '–' + fmt.int(b.max),
    sub: b.label, test: r => r.sb === b.key
  }));
}

/* =============================================================================
   paint — everything that depends on the filters
   ============================================================================= */

function paint() {
  if (!S) return;
  const f = activeFilters();
  const shown = S.rows.filter(r => matches(r, f, null));
  S.shown = shown;
  paintFacets(f, shown);
  paintSummary(f, shown);
  paintScatter(f, shown);
  paintTable(f, shown);
}

function paintFacets(f, shown) {
  const host = S.facetHost;
  clear(host);

  /* text search */
  const input = el('input.br-search', {
    type: 'search', value: f.text, 'aria-label': 'Search clusters',
    placeholder: 'id, name, consensus, term…',
    on: { input: e => {
      const v = e.target.value;
      clearTimeout(input.__t);
      input.__t = setTimeout(() => router.setQuery({ q: v || null }), 200);
    } }
  });
  host.appendChild(el('div', { style: { marginBottom: 'var(--s4)' } }, [
    input,
    el('p.r2-note', { style: { marginTop: '6px' } },
      'Matches cluster id, name, top consensus and top term.')
  ]));

  const anyFilter = f.region.length || f.module.length || f.size.length || f.logo ||
                    f.terms || f.partners || f.text || f.brush;
  if (anyFilter) {
    host.appendChild(el('button.btn.btn-sm', {
      type: 'button', style: { marginBottom: 'var(--s4)' },
      on: { click: () => router.setQuery({
        region: null, module: null, size: null, logo: null, terms: null,
        partners: null, q: null, bx: null
      }) }
    }, 'Clear all filters'));
  }

  const groups = el('div.facets');
  for (const F of FACETS) {
    const pool = S.rows.filter(r => matches(r, f, F.key));       // all OTHER filters
    const sel = F.multi ? f[F.key] : (f[F.key] ? [f[F.key]] : []);
    const list = el('div.facet-list');
    for (const v of F.values) {
      const n = pool.reduce((a, r) => a + (v.test(r) ? 1 : 0), 0);
      const on = sel.indexOf(v.v) !== -1;
      list.appendChild(el('button', {
        type: 'button', class: 'fbtn' + (n === 0 && !on ? ' zero' : ''),
        'aria-pressed': String(on),
        title: (v.sub ? v.sub + ' — ' : '') + n + ' of the 900 clusters match this value ' +
               'given the other active filters' + (n === 0 ? ' (choosing it empties the table)' : ''),
        on: { click: () => toggleFacet(F, v.v, on) }
      }, [
        v.mod != null ? el('span.swatch', { style: { background: moduleColor(v.mod) } }) : null,
        el('span', v.label),
        el('span.cnt', fmt.int(n))
      ]));
    }
    groups.appendChild(el('div.facet', [el('h4', F.label), list]));
  }
  host.appendChild(groups);

  host.appendChild(el('p.r2-note', { style: { marginTop: 'var(--s5)' } }, [
    'Denominators: ', el('b', '444'), ' of 900 clusters have no defensible logo, ',
    el('b', '437'), ' no significant term, ', el('b', '387'), ' no module, ',
    el('b', '282'), ' of 600 UTR clusters no strict partner.'
  ]));
}

function toggleFacet(F, v, on) {
  const f = activeFilters();
  if (F.multi) {
    const sel = new Set(f[F.key]);
    if (on) sel.delete(v); else sel.add(v);
    const patch = {}; patch[F.key] = sel.size ? Array.from(sel).join(',') : null;
    router.setQuery(patch);
  } else {
    const patch = {}; patch[F.key] = on ? null : v;
    router.setQuery(patch);
  }
}

function paintSummary(f, shown) {
  const s = S.summary;
  clear(s);
  // live filter readout — this is a control, it moves with the facets
  s.appendChild(el('span.r2-note', ['Showing ', el('b', fmt.int(shown.length)), ' clusters']));
  s.appendChild(el('span', { style: { marginLeft: 'auto' } }, el('div.row', [
    f.brush ? el('button.btn.btn-sm', { type: 'button',
      on: { click: () => router.setQuery({ bx: null }) } }, 'Clear brush') : null,
    csvButton('mirto-clusters.csv', () => sortRows(shown, f), [
      { key: 'id', label: 'cluster' }, { key: 'r', label: 'region' }, { key: 'm', label: 'module' },
      { key: 'name', label: 'name' }, { key: 'tier', label: 'name_tier' },
      { key: 'ni', label: 'instances' }, { key: 'ntx', label: 'transcripts' },
      { key: 'ng', label: 'genes' }, { key: 'nterms', label: 'significant_terms' },
      { key: 'npass', label: 'strict_partners' }, { key: 'nsug', label: 'suggestive_partners' },
      { key: 'logo', label: 'has_logo' }, { key: 'cons', label: 'top_consensus' },
      { key: 'tdisp', label: 'top_term' }
    ]),
    copyLinkButton({ label: 'Copy this view' })
  ])));
}

/* =============================================================================
   the scatter
   ============================================================================= */

const SC = { W: 900, H: 330, padL: 52, padR: 14, padT: 12, padB: 34 };

function buildScatter() {
  const host = S.scatterHost;
  clear(host);
  const rows = S.rows;
  const xs = rows.map(r => r.ni), ys = rows.map(r => r.ng);
  const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  const y0 = Math.max(1, Math.min.apply(null, ys)), y1 = Math.max.apply(null, ys);
  const lx = v => SC.padL + (Math.log10(Math.max(v, 1)) - Math.log10(x0)) /
                  (Math.log10(x1) - Math.log10(x0)) * (SC.W - SC.padL - SC.padR);
  const ly = v => SC.H - SC.padB - (Math.log10(Math.max(v, 1)) - Math.log10(y0)) /
                  (Math.log10(y1) - Math.log10(y0)) * (SC.H - SC.padT - SC.padB);
  const ix = (px) => Math.pow(10, Math.log10(x0) + (px - SC.padL) /
                  (SC.W - SC.padL - SC.padR) * (Math.log10(x1) - Math.log10(x0)));
  const iy = (py) => Math.pow(10, Math.log10(y0) + (SC.H - SC.padB - py) /
                  (SC.H - SC.padT - SC.padB) * (Math.log10(y1) - Math.log10(y0)));

  const svg = el('svg.scatter', { viewBox: '0 0 ' + SC.W + ' ' + SC.H,
    role: 'img', 'aria-label': '900 clusters plotted by instance count against carrier genes' });

  const grid = el('g.grid');
  const axis = el('g.axis');
  const ticks = [200, 500, 1000, 2000, 5000];
  for (const t of ticks) {
    if (t < x0 || t > x1) continue;
    grid.appendChild(el('line', { x1: lx(t), x2: lx(t), y1: SC.padT, y2: SC.H - SC.padB }));
    axis.appendChild(el('text', { x: lx(t), y: SC.H - SC.padB + 13, 'text-anchor': 'middle' },
      fmt.int(t)));
  }
  for (const t of [10, 30, 100, 300, 1000, 3000]) {
    if (t < y0 || t > y1) continue;
    grid.appendChild(el('line', { x1: SC.padL, x2: SC.W - SC.padR, y1: ly(t), y2: ly(t) }));
    axis.appendChild(el('text', { x: SC.padL - 6, y: ly(t) + 3, 'text-anchor': 'end' }, fmt.int(t)));
  }
  axis.appendChild(el('text', { x: SC.W / 2, y: SC.H - 4, 'text-anchor': 'middle' },
    'motif instances (log)'));
  axis.appendChild(el('text', { x: 11, y: SC.H / 2, 'text-anchor': 'middle',
    transform: 'rotate(-90 11 ' + (SC.H / 2) + ')' }, 'carrier genes (log)'));
  svg.appendChild(grid);
  svg.appendChild(axis);

  const pts = el('g');
  const nodes = new Map();
  for (const r of S.rows) {
    const c = el('circle', {
      cx: lx(r.ni).toFixed(1), cy: ly(r.ng).toFixed(1), r: r.npass ? 3.6 : 2.6,
      fill: moduleColor(r.m), 'fill-opacity': r.m ? 0.85 : 0.5,
      dataset: { id: r.id }
    });
    pts.appendChild(c);
    nodes.set(r.id, c);
  }
  svg.appendChild(pts);

  const brushRect = el('rect.brush', { x: 0, y: 0, width: 0, height: 0, hidden: true });
  svg.appendChild(brushRect);

  const tip = el('div.sc-tip', { hidden: true });
  const wrapEl = el('div.scatter-wrap', [svg, tip]);

  /* hover + click */
  svg.addEventListener('mousemove', ev => {
    const t = ev.target;
    if (t && t.tagName === 'circle' && t.dataset.id) {
      const r = S.ix.byId.get(t.dataset.id);
      const rect = wrapEl.getBoundingClientRect();
      tip.hidden = false;
      tip.textContent = r.id + ' · ' + fmt.int(r.ni) + ' inst · ' + fmt.int(r.ng) + ' genes · ' +
        (r.npass ? r.npass + ' strict partners' : 'no strict partner');
      tip.style.left = (ev.clientX - rect.left) + 'px';
      tip.style.top = (ev.clientY - rect.top) + 'px';
    } else tip.hidden = true;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; });
  svg.addEventListener('click', ev => {
    const t = ev.target;
    if (t && t.tagName === 'circle' && t.dataset.id && !S.dragged) {
      router.navigate('/cluster/' + t.dataset.id, { query: { from: 'browse' } });
    }
  });

  /* brush: drag a rectangle, and the table shows exactly what is inside it. A
     click without a drag clears the brush (and the click handler above opens the
     cluster under the pointer instead). */
  let start = null;
  const toLocal = ev => {
    const rect = svg.getBoundingClientRect();
    return [(ev.clientX - rect.left) / rect.width * SC.W,
            (ev.clientY - rect.top) / rect.height * SC.H];
  };
  svg.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    start = toLocal(ev);
    S.dragged = false;
    try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* not captureable */ }
  });
  svg.addEventListener('pointermove', ev => {
    if (!start) return;
    const p = toLocal(ev);
    if (Math.abs(p[0] - start[0]) + Math.abs(p[1] - start[1]) > 4) S.dragged = true;
    if (!S.dragged) return;
    brushRect.hidden = false;
    brushRect.setAttribute('x', Math.min(start[0], p[0]).toFixed(1));
    brushRect.setAttribute('y', Math.min(start[1], p[1]).toFixed(1));
    brushRect.setAttribute('width', Math.abs(p[0] - start[0]).toFixed(1));
    brushRect.setAttribute('height', Math.abs(p[1] - start[1]).toFixed(1));
  });
  svg.addEventListener('pointerup', ev => {
    if (!start) return;
    const p = toLocal(ev);
    const dragged = S.dragged;
    const a = start;
    start = null;
    brushRect.hidden = true;
    if (!dragged) return;                       // a plain click: handled above
    const px0 = Math.min(a[0], p[0]), px1 = Math.max(a[0], p[0]);
    const py0 = Math.min(a[1], p[1]), py1 = Math.max(a[1], p[1]);
    // y is inverted on screen, so py1 (lower on screen) is the SMALLER gene count
    router.setQuery({ bx: [Math.floor(ix(px0)), Math.ceil(ix(px1)),
                           Math.floor(iy(py1)), Math.ceil(iy(py0))].join(',') });
  });
  svg.addEventListener('pointercancel', () => { start = null; brushRect.hidden = true; });

  host.appendChild(el('div.r2-panelhead', [
    el('h4', 'Corpus overview'),
    el('span.r2-note', 'drag to brush the table · click a point to open the cluster')
  ]));
  host.appendChild(wrapEl);
  const legend = el('div.sc-legend');
  for (const m of [1, 2, 3, 4, 5, 6, 0]) {
    legend.appendChild(el('span.k', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } }, [
      el('i', { style: { width: '9px', height: '9px', borderRadius: '50%',
                         background: moduleColor(m), display: 'inline-block' } }),
      m ? 'M' + m : 'no module'
    ]));
  }
  legend.appendChild(el('span.dim', 'larger dot = has a strict partner'));
  host.appendChild(legend);
  S.scatterNodes = nodes;
  S.brushRect = brushRect;
}

function paintScatter(f, shown) {
  if (!S.scatterNodes) return;
  const on = new Set(shown.map(r => r.id));
  for (const [id, node] of S.scatterNodes) {
    node.classList.toggle('dim', !on.has(id));
  }
}

/* =============================================================================
   the table
   ============================================================================= */

function sortRows(rows, f) {
  const col = COLS.find(c => c.key === f.sort) || COLS[0];
  const dir = f.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const va = col.sort(a), vb = col.sort(b);
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return String(a.id).localeCompare(String(b.id));
  });
}

function paintTable(f, shown) {
  const host = S.tableHost;
  clear(host);

  if (!shown.length) {
    host.appendChild(emptyState({
      mark: '⌀', title: 'No cluster matches this combination',
      message: 'Every facet count in the rail is computed against your other filters, so the ' +
        'value that emptied this table was showing 0 before you chose it. Drop one filter to ' +
        'get back.',
      denominator: '0 of 900 clusters',
      action: el('button.btn.btn-primary', { type: 'button',
        on: { click: () => router.setQuery({ region: null, module: null, size: null, logo: null,
                                             terms: null, partners: null, q: null, bx: null }) } },
        'Clear all filters')
    }));
    return;
  }

  const sorted = sortRows(shown, f);
  const head = el('tr');
  for (const c of COLS) {
    const on = f.sort === c.key;
    head.appendChild(el('th', {
      class: 'sortable' + (c.num ? ' num' : ''),
      title: 'Sort by ' + c.label + (on ? ' (click to reverse)' : ''),
      on: { click: () => {
        const dir = on ? (f.dir === 'asc' ? 'desc' : 'asc') : (c.num ? 'desc' : 'asc');
        router.setQuery({ sort: c.key, dir: dir === 'desc' ? 'desc' : 'asc' });
      } }
    }, [c.label, on ? el('span.arw', f.dir === 'asc' ? ' ▲' : ' ▼') : null]));
  }

  const tbody = el('tbody');
  const table = el('table.data', [el('thead', head), tbody]);
  host.appendChild(el('div.table-scroll', { style: { maxHeight: '70vh' } }, table));

  let drawn = 0;
  const PAGE = 150;
  const more = el('div.row', { style: { marginTop: 'var(--s3)', justifyContent: 'center' } });
  function draw() {
    for (const r of sorted.slice(drawn, drawn + PAGE)) {
      const tr = el('tr.br-tr', {
        on: {
          click: () => router.navigate('/cluster/' + r.id, { query: { from: 'browse' } }),
          mouseenter: () => prefetchCluster(r.id)
        }
      });
      for (const c of COLS) tr.appendChild(el('td', { class: c.num ? 'num' : null }, c.cell(r)));
      tbody.appendChild(tr);
    }
    drawn = Math.min(drawn + PAGE, sorted.length);
    clear(more);
    if (drawn < sorted.length) {
      more.appendChild(el('button.btn', { type: 'button', on: { click: draw } },
        'Show ' + Math.min(PAGE, sorted.length - drawn) + ' more (' + fmt.int(drawn) + ' of ' +
        fmt.int(sorted.length) + ')'));
    } else if (sorted.length > PAGE) {
      more.appendChild(el('span.r2-note', 'all ' + fmt.int(sorted.length) + ' rows shown'));
    }
  }
  draw();
  host.appendChild(more);
}
