/* =============================================================================
   view-gene.js — R1, the gene / transcript view.

   Route: #/gene/:refseq        (mounted by the shell through js/views/gene.js)

   A unified mRNA browser: one continuous axis carries the 5'UTR, the CDS and the
   3'UTR at their true proportions; protein motifs are projected onto that axis
   through ms/me, so a protein motif and a UTR motif in the same transcript sit
   on ONE ruler and can be joined by an arc. That projection is the whole point
   of the paper, so it is the centre of the page.

   Everything numeric on this page comes out of the shard. Nothing is inferred,
   nothing is fabricated: there is no CDS or protein NTScore anywhere in the
   corpus and the viewer draws a hatched "not computed" band instead of guessing.
   ============================================================================= */

import * as router from './router.js';
import * as data from './data.js';
import * as ui from './ui.js';
import {
  ensureStyles, buildModel, createOverview, createDetail,
  motifPasses, hasAnnotation, annotationSummary, motifDisplay, motifString,
  regionWord, visibleCoupling
} from './seqview.js';

const { el, fmt } = ui;

const DEFAULT_GENE = 'NM_001101';          // ACTB — the worked example in the contract
const MINSC_FLOOR = -4;                    // measured motif_score range is [-3.91, 0]

/* transcripts with no gated protein-UTR pair: 18,093 - 11,792 */
const NO_COUPLING_DENOM = { k: 6301, n: 18093, unit: 'transcripts carry no gated pair' };

let live = null;                           // { overview, detail, unsub, observers }

/* =============================================================================
   render
   ============================================================================= */

export async function render(container, params) {
  ensureStyles();
  teardown();

  const root = el('div.wrap.view-pad');
  container.appendChild(root);
  root.appendChild(ui.skeleton({ rows: 6, label: 'Loading transcript' }));

  /* ---- resolve the transcript ------------------------------------------ */
  let refseq = String((params && params.refseq) || '').trim() || DEFAULT_GENE;
  let g = await data.getGene(refseq);
  if (!g) {
    // tolerate a symbol or an Ensembl id in the URL bar
    const alt = await data.resolveToRefseq(refseq);
    if (alt && alt.toUpperCase() !== refseq.toUpperCase()) {
      router.navigate('/gene/' + alt, { replace: true, query: router.getQuery() });
      return;
    }
  }
  if (!g) { ui.clear(root); notFound(root, refseq); return; }

  ui.setTitle([g.symbol || g.refseq, 'gene']);
  const model = buildModel(g);

  /* ---- state ------------------------------------------------------------ */
  const coupledClusters = new Set();
  for (const c of model.coupling) {
    const mp = model.motifs[c.p], mu = model.motifs[c.u];
    if (mp) coupledClusters.add(mp.c);
    if (mu) coupledClusters.add(mu.c);
  }

  const st = {
    region: 'all', filter: 'all', mod: 0, minsc: MINSC_FLOOR,
    alpha: 'rna', arcs: 8, mode: 'auto',
    sel: null, selArc: null, hoverArc: null,
    hl: null, litClusters: new Set(), coupledClusters,
    win: [0, Math.min(model.mrna - 1, 599)],
    sort: { key: 'ms', dir: 1 }
  };
  // params.query is the shell's decoded query object; the router agrees with it
  // in production, but the API says params is the source of truth on mount.
  readQuery(st, (params && params.query) || router.getQuery(), model);

  /* ---- shell ------------------------------------------------------------ */
  ui.clear(root);
  root.appendChild(ui.breadcrumb([
    { label: 'Atlas', href: router.link('/') },
    { label: 'Genes', href: router.link('/browse', { tab: 'genes' }) },
    { label: g.symbol || g.refseq }
  ]));
  root.appendChild(identity(g, model, st));
  if (model.warnings.length) root.appendChild(warnBanner(model));

  const filterHost = el('div');
  root.appendChild(filterHost);

  const countLabel = el('span.gv-count');
  filterHost.appendChild(filterBar(st, model, countLabel));

  /* overview ------------------------------------------------------------- */
  const ovHost = el('div');
  root.appendChild(ui.card(
    el('h3', 'Transcript overview'),
    [
      model.coupling.length
        ? ui.segmented('arcs', [
            { value: '8', label: 'top 8 arcs' },
            { value: '25', label: '25' },
            { value: 'all', label: 'all ' + fmt.int(model.coupling.length) }
          ], { def: '8', label: 'Coupling arcs drawn' })
        : el('span.dim', { style: { fontSize: 'var(--fs-xs)' },
            title: 'Nothing to draw in the pair lane — see the cross-modal panel below' },
            'no gated pair to draw'),
      ui.copyLinkButton({ label: 'Copy view' })
    ],
    ovHost
  ));

  /* detail --------------------------------------------------------------- */
  const dtHost = el('div');
  root.appendChild(ui.card(
    el('h3', 'Detail — the brushed window'),
    [
      ui.segmented('mode', [
        { value: 'auto', label: 'auto' },
        { value: 'read', label: 'letters' },
        { value: 'track', label: 'tracks' }
      ], { def: 'auto', label: 'Sequence rendering mode' })
    ],
    dtHost
  ));

  /* table + inspector ----------------------------------------------------- */
  const cols = el('div.gv-cols');
  root.appendChild(cols);

  const tableHost = el('div');
  const couplingHost = el('div');
  const leftCol = el('div', { style: { display: 'grid', gap: 'var(--s5)', minWidth: '0' } },
    [tableHost, couplingHost]);
  const inspectHost = el('div.gv-inspect');
  cols.appendChild(leftCol);
  cols.appendChild(inspectHost);

  /* ---- components ------------------------------------------------------- */
  /* The brush fires onWindow on every pointermove. Redrawing the detail there
     costs 24–54 ms on the largest transcripts, so coalesce into one frame: the
     brush itself (a DOM rect) tracks the pointer immediately, the tracks catch
     up on the next rAF, and the URL is rewritten once per frame, not per event. */
  let winRaf = 0;
  const cb = {
    onWindow(win) {
      st.win = clampWin(win, model);
      overview.setWin(st.win[0], st.win[1]);
      if (winRaf) return;
      winRaf = requestAnimationFrame(() => {
        winRaf = 0;
        detail.draw();
        router.setQuery({ w: st.win[0] + '-' + st.win[1] }, { silent: true });
      });
    },
    onSelect(i) { select(i); },
    onArc(k) {
      st.selArc = st.selArc === k ? null : k;
      const row = model.coupling[k];
      if (st.selArc != null && row) {
        const mp = model.motifs[row.p];
        if (mp) select(model.motifs.indexOf(mp), { keepArc: true });
      }
      refresh();
    },
    onHover() { /* the overview draws its own tooltip */ }
  };

  const overview = createOverview(ovHost, model, st, cb);
  const detail = createDetail(dtHost, model, st, cb);

  function select(i, opts) {
    opts = opts || {};
    st.sel = (st.sel === i && !opts.keepArc) ? null : i;
    if (!opts.keepArc) st.selArc = null;
    router.setQuery({ sel: st.sel == null ? null : String(st.sel) }, { silent: true });
    refresh();
    // bring the selection into the detail window if it is off-screen
    if (st.sel != null) {
      const m = model.motifs[st.sel];
      if (m.me < st.win[0] || m.ms > st.win[1]) {
        const span = st.win[1] - st.win[0] + 1;
        const mid = (m.ms + m.me) / 2;
        cb.onWindow([Math.round(mid - span / 2), Math.round(mid + span / 2) - 1]);
      }
    }
  }

  function lit() {
    const s = new Set();
    if (st.hl) s.add(st.hl);
    if (st.sel != null && model.motifs[st.sel]) s.add(model.motifs[st.sel].c);
    if (st.selArc != null) {
      const row = model.coupling[st.selArc];
      if (row) {
        if (model.motifs[row.p]) s.add(model.motifs[row.p].c);
        if (model.motifs[row.u]) s.add(model.motifs[row.u].c);
      }
    }
    return s;
  }

  function refresh() {
    st.litClusters = lit();
    const shown = model.motifs.filter(m => motifPasses(m, st));
    countLabel.textContent = fmt.int(shown.length) + ' of ' + fmt.int(model.motifs.length) + ' motifs shown';
    overview.draw();
    detail.draw();
    ui.mount(tableHost, motifTable(model, st, shown, select, g));
    ui.mount(couplingHost, couplingPanel(model, st, cb, select));
    ui.mount(inspectHost, inspector(model, st, select));
  }

  refresh();

  /* ---- react to URL filter changes without a remount -------------------- */
  router.onQuery(q => {
    const before = JSON.stringify([st.region, st.filter, st.mod, st.minsc, st.alpha, st.arcs, st.mode, st.hl, st.sel, st.win]);
    readQuery(st, q, model);
    if (JSON.stringify([st.region, st.filter, st.mod, st.minsc, st.alpha, st.arcs, st.mode, st.hl, st.sel, st.win]) === before) return;
    ui.mount(filterHost, filterBar(st, model, countLabel));
    overview.setWin(st.win[0], st.win[1]);
    refresh();
  });

  /* ---- redraw the canvases when the theme flips ------------------------- */
  const redraw = () => { overview.draw(); detail.draw(); };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (mq && mq.addEventListener) mq.addEventListener('change', redraw);
  const mo = new MutationObserver(redraw);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  live = { overview, detail, mo, mq, redraw, raf: () => winRaf };
}

export function teardown() {
  if (!live) return;
  try { if (live.raf && live.raf()) cancelAnimationFrame(live.raf()); } catch (e) { /* noop */ }
  try { live.overview && live.overview.destroy(); } catch (e) { /* noop */ }
  try { live.detail && live.detail.destroy(); } catch (e) { /* noop */ }
  try { live.mo && live.mo.disconnect(); } catch (e) { /* noop */ }
  try { if (live.mq && live.mq.removeEventListener) live.mq.removeEventListener('change', live.redraw); }
  catch (e) { /* noop */ }
  live = null;
}

/* =============================================================================
   URL <-> state
   ============================================================================= */

function readQuery(st, q, model) {
  q = q || {};
  const one = v => (Array.isArray(v) ? v[0] : v);
  const prevRegion = st.region;
  st.region = ['utr5', 'cds', 'utr3'].includes(one(q.region)) ? one(q.region) : 'all';
  st.filter = ['annot', 'coupled'].includes(one(q.f)) ? one(q.f) : 'all';
  st.mod = Math.max(0, Math.min(6, parseInt(one(q.mod), 10) || 0));
  const ms = parseFloat(one(q.minsc));
  st.minsc = Number.isFinite(ms) ? Math.max(MINSC_FLOOR, Math.min(0, ms)) : MINSC_FLOOR;
  st.alpha = one(q.alpha) === 'dna' ? 'dna' : 'rna';
  st.arcs = one(q.arcs) === 'all' ? 'all' : (parseInt(one(q.arcs), 10) || 8);
  st.mode = ['read', 'track'].includes(one(q.mode)) ? one(q.mode) : 'auto';
  st.hl = data.normalizeClusterId(one(q.hl)) || null;

  const sel = parseInt(one(q.sel), 10);
  st.sel = Number.isInteger(sel) && sel >= 0 && sel < model.motifs.length ? sel : null;

  const w = String(one(q.w) || '');
  const m = /^(\d+)-(\d+)$/.exec(w);
  if (st.region !== prevRegion && st.region !== 'all') {
    // a region change re-frames the window and drops the stale w= from the URL
    st.win = regionWindow(st.region, model);
    router.setQuery({ w: st.win[0] + '-' + st.win[1] }, { silent: true });
  } else if (m) {
    st.win = clampWin([+m[1], +m[2]], model);
  } else if (st.region !== 'all') {
    st.win = regionWindow(st.region, model);
  } else if (!st.win) {
    st.win = [0, Math.min(model.mrna - 1, 599)];
  }
}

function regionWindow(region, model) {
  if (region === 'utr5') return clampWin([0, model.len5 - 1], model);
  if (region === 'cds') return clampWin([model.cds0, model.cds1], model);
  return clampWin([model.u30, model.u31], model);
}

function clampWin(w, model) {
  let a = Math.max(0, Math.round(w[0] || 0));
  let b = Math.min(model.mrna - 1, Math.round(w[1]));
  if (!(b > a)) b = Math.min(model.mrna - 1, a + 29);
  if (b - a + 1 < 30) a = Math.max(0, b - 29);
  return [a, b];
}

/* =============================================================================
   identity header
   ============================================================================= */

function identity(g, model, st) {
  const mods = Array.isArray(g.modules) ? g.modules : [];
  const bar = el('div.gv-lenbar', { title: '5′UTR ' + fmt.int(model.len5) + ' · CDS ' +
    fmt.int(model.lenC) + ' · 3′UTR ' + fmt.int(model.len3) + ' nt' });
  const seg = (n, color, label) => el('div', {
    style: { width: (100 * n / Math.max(1, model.mrna)) + '%', background: color },
    title: label + ' ' + fmt.int(n) + ' nt'
  });
  bar.appendChild(seg(model.len5, 'var(--rna)', "5′ UTR"));
  bar.appendChild(seg(model.lenC, 'var(--protein)', 'CDS'));
  bar.appendChild(seg(model.len3, 'var(--rna-soft)', "3′ UTR"));

  const subs = el('div.subs', [
    el('span.mono', g.refseq),
    sep(),
    ...(g.ensg || []).slice(0, 2).map(x => el('span.mono', x)),
    (g.enst || []).length ? sep() : null,
    ...(g.enst || []).slice(0, 2).map(x => el('span.mono', x)),
    (g.enst || []).length > 2 ? el('span.dim', '+' + ((g.enst || []).length - 2) + ' more') : null
  ]);

  const chips = el('div.row', { style: { gap: 'var(--s2)' } },
    mods.length
      ? mods.map(m => ui.moduleChip(m, { label: 'M' + m }))
      : [ui.moduleChip(0, { href: false }),
         el('span.dim', { style: { fontSize: 'var(--fs-xs)' } },
           fmt.of(NO_MODULE.k, NO_MODULE.n) + ' ' + NO_MODULE.unit)]);

  return el('header.gv-id', [
    el('div', { style: { minWidth: '0' } }, [
      el('p.eyebrow', 'transcript'),
      el('h1', g.symbol || g.refseq),
      subs,
      el('div', { style: { marginTop: 'var(--s3)' } }, chips)
    ]),
    el('div', { style: { minWidth: '240px' } }, [
      el('div.row', { style: { gap: 'var(--s4)', fontSize: 'var(--fs-sm)', marginBottom: '6px' } }, [
        num(fmt.int(model.mrna), 'nt mRNA'),
        num(fmt.int(model.lenP), 'aa'),
        num(fmt.int(model.motifs.length), 'motifs'),
        num(fmt.int(model.coupling.length), 'gated pairs')
      ]),
      bar,
      el('div.row', { style: { gap: 'var(--s3)', marginTop: '5px', fontSize: 'var(--fs-xs)', color: 'var(--ink-3)' } }, [
        el('span', "5′UTR " + fmt.int(model.len5)),
        el('span', 'CDS ' + fmt.int(model.lenC)),
        el('span', "3′UTR " + fmt.int(model.len3)),
        el('span', { title: 'transcript_length in the source table is not the mRNA length; ' +
          'this is len(5′UTR)+len(CDS)+len(3′UTR).' }, 'true mRNA length')
      ])
    ]),
    el('div.gv-tools', [
      ui.csvButton((g.symbol || g.refseq) + '_motifs.csv',
        () => csvRows(model, model.motifs.filter(m => motifPasses(m, st))), CSV_COLS, 'Motifs CSV'),
      el('button.btn.btn-sm', {
        type: 'button', title: 'Download this transcript payload exactly as the bake wrote it',
        on: { click: () => ui.exportJSON((g.symbol || g.refseq) + '_' + g.refseq + '.json', g) }
      }, [el('span', { 'aria-hidden': 'true' }, '⤓'), el('span', 'Shard JSON')])
    ])
  ]);
}

const NO_MODULE = ui.DENOMINATORS.noModuleGene;
function sep() { return el('span.dim', { 'aria-hidden': 'true' }, '·'); }
function num(v, k) {
  return el('span', [el('b.mono', { style: { fontSize: 'var(--fs-md)' } }, v), ' ',
                     el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, k)]);
}

function warnBanner(model) {
  return el('div.banner.warn', [
    el('b', 'This shard did not fully self-check. '),
    el('span', model.warnings.join(' · ') +
      '. The view still renders every value the shard contains; nothing has been repaired or inferred.')
  ]);
}

function notFound(root, refseq) {
  ui.setTitle(['Transcript not found']);
  root.appendChild(ui.breadcrumb([{ label: 'Atlas', href: router.link('/') }, { label: 'Gene' }]));
  root.appendChild(ui.emptyState({
    mark: '⌕',
    title: 'No transcript ' + refseq,
    message: 'The atlas covers 18,093 RefSeq transcripts over 17,847 gene symbols — the set that ' +
             'joins cleanly on refseq_id_without_ver. Try a gene symbol, a RefSeq accession with or ' +
             'without its version suffix, or an ENSG / ENST id.',
    denominator: '18,093 transcripts · 40,962 Ensembl aliases indexed',
    action: el('div.row', { style: { justifyContent: 'center' } }, [
      el('a.btn.btn-primary', { href: router.link('/gene/' + DEFAULT_GENE) }, 'Open ACTB (NM_001101)'),
      el('button.btn', { type: 'button', on: { click: () => ui.omnibox().open(refseq) } }, 'Search the atlas')
    ])
  }));
}

/* =============================================================================
   filter bar
   ============================================================================= */

function filterBar(st, model, countLabel) {
  const modBtn = m => {
    const n = model.motifs.filter(x => (Number(x.m) || 0) === m).length;
    return el('button', {
      type: 'button', 'aria-pressed': String(st.mod === m),
      title: (m ? 'Module M' + m + ' — ' + ui.moduleLabel(m) : 'Unassigned') + ' · ' + n + ' motifs here',
      disabled: n === 0,
      on: { click: () => router.setQuery({ mod: st.mod === m ? null : String(m) }) }
    }, ui.moduleChip(m, { href: false, label: (m ? 'M' + m : '—') + ' ' + n }));
  };

  const present = [];
  for (let m = 0; m <= 6; m++) if (model.motifs.some(x => (Number(x.m) || 0) === m)) present.push(m);

  const slider = el('input', {
    type: 'range', min: String(MINSC_FLOOR), max: '0', step: '0.05', value: String(st.minsc),
    'aria-label': 'Minimum motif score',
    on: {
      input: e => { scLabel.textContent = fmt.num(e.target.value, 2); pushScore(e.target.value); }
    }
  });
  const scLabel = el('span.mono', { style: { minWidth: '4ch' } }, fmt.num(st.minsc, 2));
  let scTimer = null;
  function pushScore(v) {
    clearTimeout(scTimer);
    scTimer = setTimeout(() => {
      router.setQuery({ minsc: Math.abs(v - MINSC_FLOOR) < 1e-9 ? null : String(v) });
    }, 140);
  }

  return el('div.gv-filters', [
    el('span.lab', 'show'),
    ui.segmented('f', [
      { value: 'all', label: 'all' },
      { value: 'annot', label: 'annotated' },
      { value: 'coupled', label: 'coupled' }
    ], { def: 'all', label: 'Motif filter' }),
    el('span.lab', 'region'),
    ui.segmented('region', [
      { value: 'all', label: 'whole mRNA' },
      { value: 'utr5', label: "5′UTR" },
      { value: 'cds', label: 'CDS' },
      { value: 'utr3', label: "3′UTR" }
    ], { def: 'all', label: 'Region' }),
    el('span.lab', 'module'),
    el('div.gv-modfilter', present.map(modBtn)),
    el('div.gv-slider', [
      el('span.lab', 'score ≥'), slider, scLabel
    ]),
    el('span.lab', 'alphabet'),
    ui.segmented('alpha', [
      { value: 'rna', label: 'RNA (U)', title: 'Map T→U in the 5′ and 3′ UTR' },
      { value: 'dna', label: 'DNA (T)', title: 'Show every sequence exactly as stored' }
    ], { def: 'rna', label: 'Display alphabet' }),
    countLabel
  ]);
}

/* =============================================================================
   motif table
   ============================================================================= */

const CSV_COLS = [
  { key: 'i', label: 'index' }, { key: 'region', label: 'region' },
  { key: 'cluster', label: 'cluster' }, { key: 'module', label: 'module' },
  { key: 'mrna_start', label: 'mrna_start_0based' }, { key: 'mrna_end', label: 'mrna_end_0based_incl' },
  { key: 'region_start', label: 'region_start_0based' }, { key: 'region_end', label: 'region_end_0based_incl' },
  { key: 'length', label: 'length' }, { key: 'sequence', label: 'sequence_as_stored' },
  { key: 'motif_score', label: 'motif_score' }, { key: 'entropy', label: 'motif_entropy' },
  { key: 'plddt', label: 'plddt_0_1' }, { key: 'annotations', label: 'annotation_layers' },
  { key: 'coupled', label: 'in_gated_pair' }
];

function csvRows(model, list) {
  return list.map(m => ({
    i: m.i, region: m.r, cluster: m.c, module: m.m || 0,
    mrna_start: m.ms, mrna_end: m.me,
    region_start: m.s, region_end: m.e,
    length: m.e - m.s + 1,
    sequence: motifString(model, m),
    motif_score: m.sc, entropy: m.en,
    plddt: m.pl == null ? '' : m.pl,
    annotations: annotationSummary(m).map(a => a.label + (a.n > 1 ? '×' + a.n : '')).join('; '),
    coupled: model.coupling.some(c => c.p === m.i || c.u === m.i ||
      (model.motifs[c.p] && model.motifs[c.p].c === m.c) ||
      (model.motifs[c.u] && model.motifs[c.u].c === m.c)) ? 'yes' : 'no'
  }));
}

const SORTS = {
  ms: (a, b) => a.ms - b.ms,
  len: (a, b) => (a.e - a.s) - (b.e - b.s),
  c: (a, b) => String(a.c).localeCompare(String(b.c)),
  m: (a, b) => (a.m || 0) - (b.m || 0),
  sc: (a, b) => a.sc - b.sc,
  en: (a, b) => a.en - b.en,
  pl: (a, b) => (a.pl == null ? -1 : a.pl) - (b.pl == null ? -1 : b.pl)
};

function motifTable(model, st, shown, select, g) {
  const head = [
    { k: 'ms', label: 'mRNA', title: 'mRNA-axis start, 0-based inclusive; protein motifs are projected through ms = len(5′UTR) + 3·aa_start', num: true },
    { k: null, label: 'region' },
    { k: 'len', label: 'len', num: true },
    { k: 'c', label: 'cluster' },
    { k: 'm', label: 'module' },
    { k: null, label: 'sequence' },
    { k: 'sc', label: 'score', num: true },
    { k: 'en', label: 'entropy', num: true },
    { k: 'pl', label: 'pLDDT', num: true, title: 'pLDDT on a 0–1 scale, protein rows only' },
    { k: null, label: 'annotations' }
  ];

  const tableHost = el('div');

  function paint() {
    const rows = shown.slice().sort((a, b) => (SORTS[st.sort.key] || SORTS.ms)(a, b) * st.sort.dir);
    const thead = el('thead', el('tr', head.map(h => el('th', {
      class: h.num ? 'num' : null,
      title: h.title,
      'aria-sort': h.k && st.sort.key === h.k ? (st.sort.dir > 0 ? 'ascending' : 'descending') : null,
      style: h.k ? { cursor: 'pointer', userSelect: 'none' } : null,
      on: h.k ? { click: () => {
        if (st.sort.key === h.k) st.sort.dir *= -1; else { st.sort.key = h.k; st.sort.dir = 1; }
        paint();
      } } : null
    }, [h.label, h.k ? el('span.dim', { style: { marginLeft: '4px' } },
        st.sort.key === h.k ? (st.sort.dir > 0 ? '▲' : '▼') : '⇅') : null]))));
    ui.mount(tableHost, el('table.data', [thead, el('tbody', body(rows))]));
  }

  function body(rows) {
    const frag = document.createDocumentFragment();
    for (const m of rows) {
      const ann = annotationSummary(m);
      const tr = el('tr', {
        class: 'gv-row' + (st.sel === m.i ? ' gv-sel' : ''),
        on: { click: e => { if (e.target.closest('a')) return; select(m.i); } }
      }, [
        el('td.num.mono', fmt.int(m.ms) + '–' + fmt.int(m.me)),
        el('td', ui.regionBadge(m.r)),
        el('td.num.mono', String(m.e - m.s + 1)),
        el('td', el('a.mono', { href: router.link('/cluster/' + m.c),
          on: { mouseenter: () => data.prefetchCluster(m.c) } }, m.c)),
        el('td', ui.moduleChip(m.m || 0, { quiet: true, href: false, label: m.m ? 'M' + m.m : '—' })),
        el('td.mono', { style: { maxWidth: '22ch', overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap' }, title: motifDisplay(model, m) }, shortSeq(model, m, st)),
        el('td.num.mono', fmt.num(m.sc, 3)),
        el('td.num.mono', fmt.num(m.en, 2)),
        el('td.num.mono', m.pl == null ? '—' : fmt.num(m.pl, 3)),
        el('td', el('div.gv-taglist', ann.length
          ? ann.map(a => el('span', { class: 'gv-tag' + (a.k === 'rbp' ? ' assay' : '') },
              a.label + (a.n > 1 ? ' ' + a.n : '')))
          : [el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, 'none')]))
      ]);
      frag.appendChild(tr);
    }
    return frag;
  }
  paint();

  const scroller = el('div.table-scroll', { style: { maxHeight: '540px' } }, tableHost);

  const bodyEl = shown.length ? scroller : ui.emptyState({
    mark: '⌀', compact: true,
    title: 'No motif matches these filters',
    message: 'Every filter is in the URL, so this exact state is shareable. Widen the score ' +
             'threshold or clear the module filter to bring rows back.',
    denominator: '0 of ' + fmt.int(model.motifs.length) + ' motifs in this transcript match',
    action: el('button.btn', { type: 'button', on: { click: () => router.setQuery(
      { f: null, mod: null, minsc: null, region: null }) } }, 'Clear filters')
  });

  return ui.card(
    el('h3', ['Motifs ', el('span.dim', { style: { fontWeight: '400', fontSize: 'var(--fs-sm)' } },
      fmt.int(shown.length) + ' of ' + fmt.int(model.motifs.length))]),
    [ui.csvButton((g.symbol || g.refseq) + '_motifs.csv', () => csvRows(model, shown), CSV_COLS, 'CSV')],
    [
      el('p.dim', { style: { fontSize: 'var(--fs-xs)', margin: '0 0 var(--s3)' } },
        'Coordinates are 0-based and inclusive at both ends, exactly as stored: the substring is ' +
        'seq.slice(start, end + 1). Protein rows are projected onto the mRNA axis through ' +
        'ms = len(5′UTR) + 3·aa_start, me = len(5′UTR) + 3·aa_end + 2.'),
      bodyEl
    ]
  );
}

function shortSeq(model, m, st) {
  const s = st.alpha === 'dna' ? motifString(model, m) : motifDisplay(model, m);
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
}

/* =============================================================================
   coupling panel
   ============================================================================= */

function couplingPanel(model, st, cb, select) {
  const rows = model.coupling;

  if (!rows.length) {
    return ui.card(el('h3', 'Cross-modal pairs in this transcript'), null, [
      ui.caveatInline(),
      ui.emptyState({
        mark: '⌀',
        title: 'No protein–UTR pair in this transcript passes the gate',
        message: 'A pair is only carried here when it clears all four conditions the analysis ' +
                 'applies: an NPMI+APC association above threshold, enough co-occurring transcripts, ' +
                 'breadth across phylogenetic clades, and the phylogenetic-independence filter ' +
                 '(clade concentration and ZNF-clade fraction). 2,620 of 166,615 co-occurring ' +
                 'cluster pairs — 1.6% — survive that gate corpus-wide.',
        denominator: NO_COUPLING_DENOM,
        action: el('a.btn', { href: router.link('/network') }, 'See the gated network')
      })
    ]);
  }

  const drawn = new Set(visibleCoupling(model, st).map(r => r.k));

  const body = rows.map((r, k) => {
    const mp = model.motifs[r.p], mu = model.motifs[r.u];
    if (!mp || !mu) return null;
    const np = (model.byCluster.get(mp.c) || []).length;
    const nu = (model.byCluster.get(mu.c) || []).length;
    return el('tr', {
      class: 'gv-row' + (st.selArc === k ? ' gv-sel' : ''),
      on: { click: e => { if (e.target.closest('a')) return; cb.onArc(k); } }
    }, [
      el('td', [el('a.mono', { href: router.link('/cluster/' + mp.c) }, mp.c), ' ',
                el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, '×' + np)]),
      el('td', [el('a.mono', { href: router.link('/cluster/' + mu.c) }, mu.c), ' ',
                el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, '×' + nu)]),
      el('td', ui.moduleChip(mp.m || 0, { quiet: true, href: false, label: mp.m ? 'M' + mp.m : '—' })),
      el('td.num.mono', fmt.num(r.sc, 3)),
      el('td.num.mono', fmt.num(r.npmi, 3)),
      el('td.num.mono', fmt.int(r.co)),
      el('td.num.mono', fmt.int(r.cl)),
      el('td.num.mono', r.conc == null ? nc() : fmt.num(r.conc, 3)),
      el('td.num.mono', r.znf == null ? nc() : fmt.num(r.znf, 3)),
      el('td', drawn.has(k) ? el('span.gv-tag', 'arc drawn') : el('span.dim',
        { style: { fontSize: 'var(--fs-xs)' } }, 'not drawn'))
    ]);
  }).filter(Boolean);

  const table = el('table.data', [
    el('thead', el('tr', [
      el('th', { title: 'protein motif cluster · ×n = instances of it in this transcript' }, 'protein cluster'),
      el('th', { title: 'UTR motif cluster · ×n = instances of it in this transcript' }, 'UTR cluster'),
      el('th', 'module'),
      el('th.num', { title: 'phylo_corrected_score — the gate\'s ranking statistic' }, 'score'),
      el('th.num', { title: 'NPMI after the MIP/APC correction. The raw, uncorrected NPMI is not ' +
        'carried here and is never offered as a sort key: it regenerates the artefact leaderboard ' +
        'the analysis removed — 25 of its top 30 associations are ZNF-clade artefacts by the ' +
        'authors’ own verdict column.' }, 'NPMI'),
      el('th.num', { title: 'transcripts carrying both clusters' }, 'co'),
      el('th.num', { title: 'distinct phylogenetic clades represented' }, 'clades'),
      el('th.num', { title: 'clade concentration — null when co = 0' }, 'conc'),
      el('th.num', { title: 'ZNF-clade fraction — null when co = 0' }, 'ZNF'),
      el('th', 'overview')
    ])),
    el('tbody', body)
  ]);

  return ui.card(
    el('h3', ['Cross-modal pairs ', el('span.dim',
      { style: { fontWeight: '400', fontSize: 'var(--fs-sm)' } }, fmt.int(rows.length) + ' gated')]),
    [ui.csvButton('pairs.csv', () => rows.map((r, k) => ({
      protein_cluster: model.motifs[r.p] ? model.motifs[r.p].c : '',
      utr_cluster: model.motifs[r.u] ? model.motifs[r.u].c : '',
      phylo_corrected_score: r.sc, npmi_mip_apc: r.npmi, co_count: r.co,
      clades: r.cl, clade_concentration: r.conc == null ? '' : r.conc,
      znf_fraction: r.znf == null ? '' : r.znf
    })), null, 'CSV')],
    [
      ui.caveatInline('Every row is a candidate, unvalidated pair: 2,620 of 166,615 co-occurring ' +
        'cluster pairs (1.6%) pass the phylogenetic-independence gate. Click a row to light its ' +
        'arc and every instance of both clusters on the axis.'),
      el('div.table-scroll', { style: { maxHeight: '420px' } }, table),
      el('p.dim', { style: { fontSize: 'var(--fs-xs)', marginTop: 'var(--s3)', marginBottom: 0 } },
        'p and u index the first motif of each cluster in this transcript; a cluster can occur ' +
        'several times, so selection lights every instance. conc and ZNF are null — “not computable” ' +
        '— wherever the co-occurrence count is zero; they are never shown as 0.')
    ]
  );
}

function nc() { return el('span.dim', { title: 'not computable — the co-occurrence count is zero' }, 'n/c'); }

/* =============================================================================
   inspector
   ============================================================================= */

function inspector(model, st, select) {
  if (st.sel == null || !model.motifs[st.sel]) {
    return ui.card(el('h3', 'Motif inspector'), null, [
      ui.emptyState({
        mark: '☞', compact: true,
        title: 'Nothing selected',
        message: 'Click a motif on the overview, in the sequence, or in the table. The selection ' +
                 'travels in the URL, so the link you copy opens on the same motif.',
        denominator: fmt.int(model.motifs.length) + ' motifs in this transcript'
      })
    ]);
  }

  const m = model.motifs[st.sel];
  const seqStr = st.alpha === 'dna' ? motifString(model, m) : motifDisplay(model, m);
  const siblings = model.byCluster.get(m.c) || [];
  const partners = model.coupling.map((r, k) => ({ r, k })).filter(({ r }) => {
    const mp = model.motifs[r.p], mu = model.motifs[r.u];
    return (mp && mp.c === m.c) || (mu && mu.c === m.c);
  });

  const kv = el('dl.gv-kv', [
    el('dt', 'cluster'), el('dd', el('a', { href: router.link('/cluster/' + m.c) }, m.c)),
    el('dt', 'region'), el('dd', regionWord(m.r)),
    el('dt', 'mRNA span'), el('dd', fmt.int(m.ms) + ' – ' + fmt.int(m.me) +
      '  (' + fmt.int(m.me - m.ms + 1) + ' nt)'),
    el('dt', m.r === 'protein' ? 'residues' : 'in-region'),
    el('dd', fmt.int(m.s) + ' – ' + fmt.int(m.e) + '  (' + fmt.int(m.e - m.s + 1) +
      (m.r === 'protein' ? ' aa)' : ' nt)')),
    el('dt', 'motif score'), el('dd', fmt.num(m.sc, 4)),
    el('dt', 'entropy'), el('dd', fmt.num(m.en, 4))
  ]);

  const blocks = [];
  if (m.pl != null) {
    blocks.push(el('div.gv-annblock', [
      el('h5', 'pLDDT ' + fmt.num(m.pl, 3) + ' (0–1 scale)'),
      el('div.gv-plddt', el('i', { style: { width: (100 * m.pl) + '%' } })),
      el('p', { style: { marginTop: '4px' } },
        'AlphaFold confidence over this span, stored on a 0–1 scale — not 0–100.')
    ]));
  }
  const a = m.a || {};
  if (a.rbp) {
    const kids = [];
    for (const assay of Object.keys(a.rbp)) {
      const list = a.rbp[assay] || [];
      if (!list.length) continue;
      kids.push(el('p', el('b', assay + ' (' + list.length + ')')));
      kids.push(el('div.gv-taglist', list.map(x => el('span.gv-tag.assay', x))));
    }
    if (kids.length) blocks.push(el('div.gv-annblock', [el('h5', 'RBP binding evidence'), ...kids]));
  }
  if (a.mir && a.mir.length) {
    blocks.push(el('div.gv-annblock', [el('h5', 'miRNA sites (' + a.mir.length + ')'),
      el('div.gv-taglist', a.mir.map(x => el('span.gv-tag', x)))]));
  }
  for (const [key, label] of [['ipr', 'InterPro'], ['upr', 'UniProt'], ['elm', 'ELM'],
                              ['idpo', 'IDPO'], ['sig', 'SignalP']]) {
    if (!a[key]) continue;
    blocks.push(el('div.gv-annblock', [
      el('h5', label),
      el('p', { class: 'mono', style: { color: 'var(--ink)', fontSize: '12px' } }, a[key])
    ]));
  }
  if (a.mob && a.mob.length) {
    blocks.push(el('div.gv-annblock', [el('h5', 'MobiDB disorder (' + a.mob.length + ')'),
      el('div.gv-taglist', a.mob.map(x => el('span.gv-tag', x)))]));
  }
  if (!blocks.length || (!hasAnnotation(m) && m.pl == null)) {
    blocks.push(ui.emptyState({
      mark: '⌀', compact: true,
      title: 'No annotation layer covers this motif',
      message: 'Annotation layers are masked to the modality they belong to: InterPro, UniProt, ' +
               'MobiDB, IDPO, ELM and SignalP on protein motifs only; RBP and miRNA evidence on ' +
               'UTR motifs only.',
      denominator: fmt.int(model.motifs.filter(x => !hasAnnotation(x)).length) + ' of ' +
                   fmt.int(model.motifs.length) + ' motifs here carry none'
    }));
  }

  const partnerBlock = partners.length
    ? el('div.gv-annblock', [
        el('h5', 'Gated partners of ' + m.c + ' (' + partners.length + ')'),
        ui.caveatInline('Statistical co-occurrence of motif clusters across genes, not a ' +
          'demonstrated physical interaction.'),
        el('div', partners.slice(0, 8).map(({ r, k }) => {
          const other = model.motifs[r.p] && model.motifs[r.p].c === m.c
            ? model.motifs[r.u] : model.motifs[r.p];
          return el('div.row', { style: { justifyContent: 'space-between', padding: '3px 0',
            borderBottom: '1px solid var(--line-soft)' } }, [
            el('a.mono', { href: router.link('/cluster/' + other.c) }, other.c),
            el('span.mono.dim', { style: { fontSize: 'var(--fs-xs)' } },
              'score ' + fmt.num(r.sc, 3) + ' · co ' + fmt.int(r.co))
          ]);
        }))
      ])
    : el('div.gv-annblock', [
        el('h5', 'Gated partners'),
        el('p', 'This cluster carries no gated partner inside this transcript.')
      ]);

  return ui.card(
    el('h3', 'Motif inspector'),
    [el('button.btn.btn-sm', { type: 'button', title: 'Clear the selection',
      on: { click: () => select(st.sel) } }, 'Clear')],
    [
      el('div.row', { style: { gap: 'var(--s2)', marginBottom: 'var(--s3)' } }, [
        ui.regionBadge(m.r, { long: true }),
        ui.moduleChip(m.m || 0, { label: m.m ? 'M' + m.m : 'no module' }),
        el('span.gv-tag', 'motif #' + m.i)
      ]),
      el('div.gv-seqbox', seqStr),
      el('div.row', { style: { gap: 'var(--s2)', marginBottom: 'var(--s4)' } }, [
        el('button.btn.btn-sm', { type: 'button', on: { click: async () => {
          const ok = await ui.copyText(seqStr);
          ui.toast(ok ? 'Sequence copied' : 'Could not copy');
        } } }, 'Copy sequence'),
        el('a.btn.btn-sm', { href: router.link('/cluster/' + m.c) }, 'Open cluster'),
        siblings.length > 1 ? el('button.btn.btn-sm', {
          type: 'button', title: 'Cycle through the ' + siblings.length + ' instances of ' + m.c,
          on: { click: () => {
            const at = siblings.indexOf(st.sel);
            select(siblings[(at + 1) % siblings.length]);
          } }
        }, siblings.length + ' instances') : null
      ]),
      kv,
      ...blocks,
      partnerBlock
    ]
  );
}
