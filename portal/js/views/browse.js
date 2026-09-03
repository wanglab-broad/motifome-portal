/* =============================================================================
   views/browse.js — the faceted front door to all 900 motif clusters.

   Three things, kept in sync and kept in the URL:
     1. six facet groups whose counts are recomputed live against the OTHER
        active filters, so a zero-result combination is visible before it is
        chosen (a facet value that would empty the table shows a red 0);
     2. the GO enrichment map — one bubble per enriched GO term, coloured by
        module (a pie where several modules share it), laid out by gene-set
        similarity and grouped into labelled discs. Picking a term or a disc
        filters the table to that module's clusters;
     3. a sortable table of whatever survives.

   Table and facet numbers come from portal/data/cluster_index.json (built by
   code/build/11_cluster_index.py from the 900 shards); the map comes from
   portal/data/go_map.json (12_go_map.py, which imports the published figure
   script so the discs match Fig 3d / ED 3b exactly). Nothing is estimated.
   ============================================================================= */

import * as router from '../router.js';
import * as gomap from '../gomap.js';
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
    sort: q.sort || 'id', dir: q.dir === 'asc' ? 'asc' : (q.sort ? 'desc' : 'asc')
  };
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
  S.mapHost = el('section.rail-card', { style: { marginBottom: 'var(--s4)' } });
  S.tableHost = el('div');

  main.appendChild(S.summary);
  main.appendChild(S.mapHost);
  main.appendChild(S.tableHost);

  buildGoMap();
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
                    f.terms || f.partners || f.text;
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
   the GO enrichment map — the page's overview panel

   Replaces the old 900-point instances-x-genes scatter. That plot showed the
   shape of the corpus but answered no biological question: two clusters sitting
   near each other on it have nothing in common beyond size. The map instead
   shows what the modules are ABOUT — one bubble per enriched GO term, split by
   pie where several modules share a term — and doubles as a filter: pick a term
   or a disc and the table below narrows to the motif clusters of the module(s)
   that term is enriched in.
   ============================================================================= */

function buildGoMap() {
  const host = S.mapHost;
  clear(host);
  host.appendChild(el('div', { style: { padding: 'var(--s4)' } }, [
    el('div.gm-mount')
  ]));
  const mount = host.querySelector('.gm-mount');

  // Selecting a term/disc sets the module facet. A GO term is enriched in a
  // MODULE, not in a motif cluster, so the honest projection onto this page is
  // "show me the clusters of that module", not "show me that term's clusters".
  const pickModules = mods => {
    const sel = (mods || []).filter(m => m).map(String);
    router.setQuery({ module: sel.length ? sel.join(',') : null });
  };

  gomap.render(mount, {
    onPickTerm: n => pickModules(n.m),
    onPickCluster: c => pickModules(c.m)
  });
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
