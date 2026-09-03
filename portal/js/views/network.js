/* =============================================================================
   views/network.js — the module-network cockpit.

   Routes: /network  and  /network/:module        (and /module/:n as a fallback
   if views/module.js is ever missing — the shell passes servedBy==='network').

   Level-of-detail by construction: the DEFAULT canvas is ONE module's bipartite
   drill-down (at most 133 nodes), so the reader never lands on a hairball. The
   full 519-node graph is a deliberate second mode. The left rail always shows
   the DIRECTIONAL 6x6 protein-module x UTR-module matrix, because the relation
   is asymmetric (M1 protein -> M2 UTR = 178, M2 protein -> M1 UTR = 66) and a
   symmetric meta-graph would destroy exactly that.

   Every filter lives in the URL: ?mode=&m=&pair=&minsc=&enc=&cross=&sel=&sort=
   ============================================================================= */

import * as router from '../router.js';
import * as data from '../data.js';
import {
  el, clear, append, fmt, emptyState, skeleton, caveatInline, moduleChip, regionBadge,
  copyLinkButton, csvButton, setTitle, breadcrumb, moduleLabel, DENOMINATORS, toast
} from '../ui.js';
import * as G from '../graph.js';

/* =============================================================================
   module-scope live state (torn down by the shell before the next route mounts)
   ============================================================================= */

let live = null;

export function teardown() {
  if (!live) return;
  try { if (live.ctrl) live.ctrl.destroy(); } catch (e) { /* noop */ }
  try { if (live.ro) live.ro.disconnect(); } catch (e) { /* noop */ }
  live = null;
}

/* =============================================================================
   render
   ============================================================================= */

export async function render(host, params) {
  G.ensureStyles();
  teardown();

  const asModule = params.servedBy === 'network' && params.view === 'module';
  setTitle(asModule ? ['Module M' + params.n] : ['Module network']);

  const root = el('div.wrap.view-pad');
  host.appendChild(root);
  root.appendChild(skeleton({ rows: 6, label: 'Loading the network' }));

  const net = await data.getNetwork();
  clear(root);

  if (!net) {
    root.appendChild(breadcrumb([{ label: 'Atlas', href: '#/' }, { label: 'Network' }]));
    root.appendChild(emptyState({
      mark: '⌗',
      title: 'network.json could not be loaded',
      message: 'The cockpit needs data/network.json (519 nodes, 2,620 gated edges). If the bake ' +
               'has not run, or the site is being opened from the filesystem instead of a server, ' +
               'this is what you see. Everything else in the atlas still works.',
      denominator: 'expected 519 nodes · 2,620 edges · 6 modules',
      action: el('a.btn', { href: '#/about' }, 'What failed to load')
    }));
    return;
  }

  /* ---- normalise state from the URL ------------------------------------ */
  const q = params.query || {};
  const meta = net.meta || {};
  const counts = meta.counts || {};
  const matrix = meta.matrix || [];
  const modules = meta.modules || [];

  const nmax = net.nodes.reduce((t, n) => Math.max(t, n.n || 0), 1);
  const scAll = net.edges.map(e => e.sc).sort((a, b) => a - b);
  // slider bounds are rounded to the step so a value round-trips through the URL
  // unchanged (0.146 -> "0.15" -> 0.15 would otherwise re-fire the query listener)
  const scMin = Math.floor(scAll[0] * 100) / 100;
  const scMax = Math.ceil(scAll[scAll.length - 1] * 100) / 100;
  const scTrue = [scAll[0], scAll[scAll.length - 1]];

  const S = {
    net, meta, counts, matrix, modules, nmax, scMin, scMax,
    mode: MODES[q.mode] ? q.mode : 'module',
    // ?m= wins over the /network/:module path segment, so that picking a different
    // module from /network/4 produces a link that reloads to what you were looking at
    m: pickModule(asModule ? params.n : (q.m != null ? q.m : params.module)),
    pair: parsePair(q.pair),
    enc: G.ENC[q.enc] ? q.enc : 'sc',
    minsc: clampNum(q.minsc, scMin, scMax, scMin),
    cross: q.cross !== '0',
    sel: typeof q.sel === 'string' ? q.sel : null,
    sort: ['sc', 'npmi', 'co', 'cl', 'name'].indexOf(q.sort) !== -1 ? q.sort : 'sc'
  };

  /* ---- chrome ----------------------------------------------------------- */
  root.appendChild(breadcrumb([
    { label: 'Atlas', href: '#/' },
    { label: 'Module network', href: S.mode === 'module' ? null : undefined },
    S.mode === 'module' ? { label: 'M' + S.m + ' — ' + moduleLabel(S.m) } : null
  ].filter(Boolean)));

  root.appendChild(el('div.row', { style: { alignItems: 'flex-end', marginBottom: 'var(--s4)' } }, [
    el('div', [
      el('p.eyebrow.mono', fmt.int(counts.nodes || net.nodes.length) + ' nodes · ' +
        fmt.int(counts.edges || net.edges.length) + ' gated edges · ' +
        fmt.int(counts.cross_module_edges || 0) + ' cross-module (' +
        (counts.cross_module_pct != null ? counts.cross_module_pct : 28.9) + '%)'),
      el('h1', { style: { margin: '0 0 6px' } }, 'The module network'),
      el('p.lede', 'One connected graph of ' + fmt.int(counts.nodes || 519) + ' motif clusters. ' +
        'Protein clusters on one side, UTR clusters on the other; an edge is a co-occurrence that ' +
        'survived the phylogenetic-independence gate. ' +
        fmt.int(counts.cross_module_edges || 757) + ' of them cross a module boundary, so the six ' +
        'modules are not six separate pictures — they are ' +
        (counts.components === 4 ? 'one giant component of ' +
          fmt.int((counts.component_sizes || [513])[0]) + ' nodes plus three isolated dyads.'
          : 'one graph.'))
    ]),
    el('div', { style: { marginLeft: 'auto', display: 'flex', gap: 'var(--s2)' } }, [
      copyLinkButton({ label: 'Copy view' })
    ])
  ]));

  /* ---- cockpit layout --------------------------------------------------- */
  const rail = el('div.nw-rail');
  const main = el('div.nw-main');
  const insp = el('div.nw-insp');
  root.appendChild(el('div.nw-cockpit', [rail, main, insp]));

  /* ---- the pieces ------------------------------------------------------- */
  const canvasHost = el('div.nw-canvas-wrap');
  const countsLine = el('div.nw-counts');
  const canvasTitle = el('h3');
  const provenance = el('div.nw-provenance');
  const legendRow = el('div.nw-legend');
  const railStrip = el('div.nw-rail-strip');
  const railHead = el('div', { style: { display: 'flex', gap: 'var(--s2)', alignItems: 'center',
    flexWrap: 'wrap', padding: 'var(--s3) var(--s4) var(--s2)' } });
  const inspBody = el('div');

  const canvasCard = el('section.card', [
    el('div.nw-canvas-head', [canvasTitle, countsLine]),
    canvasHost,
    legendRow,
    provenance
  ]);
  const railCard = el('section.card', { style: { marginTop: 'var(--s4)' } }, [railHead, railStrip]);
  main.appendChild(canvasCard);
  main.appendChild(railCard);
  insp.appendChild(el('section.card', [inspBody]));

  /* ---- left rail: matrix + switches + controls -------------------------- */
  const matrixHost = el('div.nw-panel-body.tight');
  rail.appendChild(el('section.nw-panel', [
    el('h4', 'protein module × UTR module'),
    matrixHost,
    el('div', { style: { padding: '0 var(--s3) var(--s3)', fontSize: 'var(--fs-xs)',
      color: 'var(--ink-3)', lineHeight: '1.45' } }, [
      el('b', { style: { color: 'var(--ink-2)' } }, 'Directional. '),
      'Row = the protein cluster’s module, column = the UTR cluster’s module. ' +
      'M1→M2 is ' + fmt.int((matrix[0] || [])[1] || 0) + ' edges while M2→M1 is ' +
      fmt.int((matrix[1] || [])[0] || 0) + ' — a symmetric meta-graph would erase that. ' +
      ((meta.matrix_axes && meta.matrix_axes.excluded_unassigned_edges)
        ? 'Excludes ' + meta.matrix_axes.excluded_unassigned_edges + ' edges whose endpoints sit ' +
          'outside every module.' : ''),
      el('div', { style: { marginTop: 'var(--s2)' } }, [
        el('b', { style: { color: 'var(--ink-2)' } },
          fmt.int((meta.outside_module_nodes || []).length) + ' of ' +
          fmt.int(net.nodes.length) + ' clusters sit outside every module. '),
        'They form ' + Math.max(0, (counts.component_sizes || []).length - 1) + ' isolated dyads ' +
        'and appear only in the full graph — a module drill-down cannot show them.'
      ])
    ])
  ]));

  const modesHost = el('div.nw-panel-body', el('div.nw-modes'));
  rail.appendChild(el('section.nw-panel', [el('h4', 'canvas'), modesHost]));

  const ctlHost = el('div.nw-panel-body');
  rail.appendChild(el('section.nw-panel', [el('h4', 'edges'), ctlHost]));

  /* =============================================================================
     controls
     ============================================================================= */

  const modeButtons = new Map();
  const modeList = el('div.nw-modes');
  clear(modesHost); modesHost.appendChild(modeList);
  for (const key of MODE_ORDER) {
    const def = MODES[key];
    const b = el('button.nw-mode', {
      type: 'button', 'aria-pressed': String(S.mode === key),
      on: { click: () => setState({ mode: key }) }
    }, [
      el('span.mk', { html: def.icon }),
      el('span', [el('span.lb', def.label), el('span.sb', def.sub)])
    ]);
    modeButtons.set(key, b);
    modeList.appendChild(b);
  }

  // module picker (only meaningful for the drill-down)
  const modPick = el('div.nw-ctl');
  modPick.appendChild(el('div.nw-ctl-lab', [el('span', 'module in focus'),
    el('span.v', 'M' + S.m)]));
  const modRow = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } });
  for (let i = 1; i <= 6; i++) {
    const mm = modules.find(x => x.id === i) || {};
    modRow.appendChild(el('button', {
      type: 'button', class: 'nw-mode ' + G.modClass(i),
      style: { padding: '4px 8px', width: 'auto', borderRadius: 'var(--r-full)' },
      'aria-pressed': String(S.m === i),
      title: 'M' + i + ' — ' + (mm.label || moduleLabel(i)) + ' · ' +
             fmt.int(mm.n_protein || 0) + ' protein + ' + fmt.int(mm.n_utr || 0) + ' UTR clusters',
      dataset: { mod: i },
      on: { click: () => setState({ m: i, mode: S.mode === 'module' ? 'module' : S.mode }) }
    }, [
      el('span', { style: { width: '8px', height: '8px', borderRadius: '2px',
        background: 'var(--mc)', display: 'inline-block' } }),
      el('span', { style: { fontSize: 'var(--fs-xs)' } }, 'M' + i)
    ]));
  }
  modPick.appendChild(modRow);
  ctlHost.appendChild(modPick);

  // encoding
  const encCtl = el('div.nw-ctl');
  encCtl.appendChild(el('div.nw-ctl-lab', 'edge width by'));
  const encRow = el('div.nw-enc');
  const encButtons = new Map();
  for (const k of G.ENC_ORDER) {
    const d = G.ENC[k];
    const b = el('button', { type: 'button', 'aria-pressed': String(S.enc === k), title: d.hint,
      on: { click: () => setState({ enc: k }) } }, d.label.replace(' (MIP / APC)', ''));
    encButtons.set(k, b);
    encRow.appendChild(b);
  }
  encRow.appendChild(el('button', {
    type: 'button', disabled: true, 'aria-disabled': 'true',
    title: G.ENC_REFUSED.reason
  }, G.ENC_REFUSED.label));
  encCtl.appendChild(encRow);
  encCtl.appendChild(el('div.nw-refuse', [
    el('b', 'npmi_raw is refused. '), G.ENC_REFUSED.reason
  ]));
  ctlHost.appendChild(encCtl);

  // threshold
  const thCtl = el('div.nw-ctl');
  const thVal = el('span.v', fmt.num(S.minsc, 2));
  thCtl.appendChild(el('div.nw-ctl-lab', [el('span', 'min phylo-corrected score'), thVal]));
  const slider = el('input.nw-range', {
    type: 'range', min: String(scMin), max: String(scMax), step: '0.01', value: String(S.minsc),
    'aria-label': 'minimum phylo-corrected score'
  });
  const preview = el('div.nw-preview');
  thCtl.appendChild(slider);
  thCtl.appendChild(preview);
  ctlHost.appendChild(thCtl);

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    thVal.textContent = fmt.num(v, 2);
    const s = survivors(net, v);
    preview.classList.add('armed');
    preview.textContent = 'at ≥ ' + fmt.num(v, 2) + ' → ' + fmt.int(s.edges) + ' of ' +
      fmt.int(net.edges.length) + ' edges, ' + fmt.int(s.nodes) + ' of ' +
      fmt.int(net.nodes.length) + ' nodes survive';
  });
  slider.addEventListener('change', () => {
    const v = parseFloat(slider.value);
    preview.classList.remove('armed');
    setState({ minsc: v <= scMin + 1e-9 ? null : v });
  });

  // cross-module toggle
  const crossBox = el('input', { type: 'checkbox', checked: S.cross,
    on: { change: () => setState({ cross: crossBox.checked }) } });
  ctlHost.appendChild(el('div.nw-ctl', [
    el('label.nw-switch', [crossBox, el('span', [
      'show the ', el('b', fmt.int(counts.cross_module_edges || 757)), ' cross-module edges'
    ])]),
    el('div.nw-refuse', 'On by default. Turning them off hides 28.9% of the graph, including the ' +
      'M5-protein × M1-UTR result (' + fmt.int((matrix[4] || [])[0] || 0) + ' edges).')
  ]));

  /* =============================================================================
     the draw cycle
     ============================================================================= */

  function viewSet() {
    const byId = net.byId;
    const keep = e => e.sc >= S.minsc - 1e-9;
    let edges, nodes;
    if (S.mode === 'module') {
      const inM = id => (byId.get(id) || {}).m === S.m;
      edges = net.edges.filter(e => keep(e) && (inM(e.p) || inM(e.u)) &&
        (S.cross || (inM(e.p) && inM(e.u))));
      nodes = net.nodes.filter(n => n.m === S.m);
    } else {
      edges = net.edges.filter(e => keep(e) && (S.cross || !e.x));
      const seen = new Set();
      for (const e of edges) { seen.add(e.p); seen.add(e.u); }
      nodes = net.nodes.filter(n => seen.has(n.id));
    }
    const cross = edges.reduce((t, e) => t + (e.x ? 1 : 0), 0);
    const consN = edges.reduce((t, e) => t + (e.cons ? 1 : 0), 0);
    return { edges, nodes, cross, consN };
  }

  function drawCanvas() {
    const v = viewSet();
    live.view = v;
    live.lastWidth = Math.max(320, canvasHost.clientWidth - 16) || 820;
    const dom = G.encDomain(v.edges.length ? v.edges : net.edges, S.enc);

    if (live.ctrl) { try { live.ctrl.destroy(); } catch (e) { /* noop */ } }

    if (!v.edges.length && S.mode !== 'module') {
      clear(canvasHost);
      canvasHost.appendChild(emptyState({
        mark: '⌁', title: 'No edge survives a score of ' + fmt.num(S.minsc, 2),
        message: 'Every one of the 2,620 gated pairs scores below the threshold you set. ' +
                 'Drag the slider back down — the preview under it tells you what survives ' +
                 'before you commit.',
        denominator: 'gated edges span ' + fmt.num(scTrue[0], 3) + ' – ' + fmt.num(scTrue[1], 3),
        action: el('button.btn', { type: 'button', on: { click: () => {
          slider.value = String(scMin); setState({ minsc: null }); } } }, 'Reset the threshold')
      }));
      live.ctrl = null;
    } else {
      const width = live.lastWidth;
      const nProt = v.nodes.reduce((t, n) => t + (n.r === 'protein' ? 1 : 0), 0);
      const maxCol = Math.max(1, nProt, v.nodes.length - nProt);
      live.ctrl = G.renderCanvas(canvasHost, {
        mode: S.mode, net, nodes: v.nodes, edges: v.edges, enc: S.enc, encDomain: dom,
        module: S.m, pair: S.pair, sel: S.sel, showCross: S.cross, nmax,
        width, height: S.mode === 'matrix' ? Math.round(width * 0.66)
                     : S.mode === 'module' ? Math.max(400, Math.min(1020, maxCol * 14 + 80))
                     : Math.round(width * 0.72),
        aria: MODES[S.mode].label,
        onPick: id => setState({ sel: id || null }),
        onHover: id => { live.hover = id; },
        tipFor: id => tipFor(id)
      });
    }

    // header + counts + provenance
    canvasTitle.textContent = S.mode === 'module'
      ? 'M' + S.m + ' — ' + moduleLabel(S.m)
      : MODES[S.mode].label;
    clear(countsLine);
    append(countsLine, [
      el('span', ['showing ', el('b', fmt.int(v.nodes.length)), ' of ' +
        fmt.int(net.nodes.length) + ' nodes · ', el('b', fmt.int(v.edges.length)), ' of ' +
        fmt.int(net.edges.length) + ' edges (' + fmt.int(v.cross) + ' cross-module)']),
      el('br'),
      el('span.dim', fmt.int(v.consN) + ' of ' + fmt.int(v.edges.length) +
        ' drawn edges have a consensus-level pair (solid); the rest are cluster-level only (dashed)')
    ]);
    provenance.textContent = G.provenanceNote(net, S.mode);
    drawLegend();
    updateSelClasses();
  }

  function drawLegend() {
    clear(legendRow);
    const sw = (cls, style) => el('span', { class: cls, style: Object.assign({
      width: '11px', height: '11px', display: 'inline-block', borderRadius: '2px' }, style || {}) });
    append(legendRow, [
      el('span.lg', [regionBadge('protein'), el('span', 'square')]),
      el('span.lg', [regionBadge('utr5'), el('span', 'triangle')]),
      el('span.lg', [regionBadge('utr3'), el('span', 'circle')]),
      el('span.lg', [
        el('svg', { width: 26, height: 8, 'aria-hidden': 'true' },
          [el('line', { x1: 0, y1: 4, x2: 26, y2: 4, style: { stroke: 'var(--ink-2)', strokeWidth: 2 } })]),
        el('span', 'a consensus-level pair is recorded (' +
          fmt.int(counts.edges_with_consensus_pair || 1430) + ')')
      ]),
      el('span.lg', [
        el('svg', { width: 26, height: 8, 'aria-hidden': 'true' },
          [el('line', { x1: 0, y1: 4, x2: 26, y2: 4, style: { stroke: 'var(--ink-2)', strokeWidth: 2,
            strokeDasharray: '2.5 2.5' } })]),
        el('span', 'cluster-level only (' + fmt.int(counts.edges_cluster_level_only || 1190) + ')')
      ]),
      el('span.lg', [sw('', { background: 'var(--ink-3)' }), el('span', 'cross-module edge')]),
      el('span.lg', el('span.dim', 'size = motif instances · width = ' + G.ENC[S.enc].label))
    ]);
  }

  /* ---- tooltips --------------------------------------------------------- */
  function tipFor(id) {
    if (G.isEdgeId(id)) {
      const e = live.edgeById.get(id);
      if (!e) return null;
      const a = net.byId.get(e.p), b = net.byId.get(e.u);
      return [
        el('div.t-h', [G.nodeMark(a, { size: 13 }), el('span.t-n', a.name || a.id),
          el('span.t-k', '×'), G.nodeMark(b, { size: 13 }), el('span.t-n', b.name || b.id)]),
        el('div.t-row', [el('span', 'phylo-corrected'), el('span', fmt.num(e.sc, 3))]),
        el('div.t-row', [el('span', 'NPMI (MIP/APC)'), el('span', fmt.num(e.npmi, 3))]),
        el('div.t-row', [el('span', 'co-occurrence'), el('span', fmt.int(e.co))]),
        el('div.t-row', [el('span', 'independent clades'), el('span', fmt.int(e.cl))]),
        el('div', { style: { marginTop: '4px', color: 'var(--ink-3)' } },
          (e.cons ? 'a consensus-level pair backs this edge' : 'cluster-level only — no consensus pair') +
          (e.x ? ' · crosses M' + a.m + ' → M' + b.m : ''))
      ];
    }
    const n = net.byId.get(id);
    if (!n) return null;
    return [
      el('div.t-h', [G.nodeMark(n, { size: 14 }), el('span.t-n', n.name || n.id)]),
      el('div', { style: { marginBottom: '4px' } }, [
        el('span.mono.t-k', n.id), ' · ', G.REG[n.r], ' · ',
        n.m ? 'M' + n.m : 'no module', ' · name tier ' + n.tier +
        (n.src && n.src !== 'none' ? ' (' + n.src + ')' : '')
      ]),
      el('div.t-row', [el('span', 'gated partners'), el('span', fmt.int(n.deg))]),
      el('div.t-row', [el('span', 'motif instances'), el('span', fmt.int(n.n))]),
      el('div.t-row', [el('span', 'transcripts / genes'),
        el('span', fmt.int(n.nt) + ' / ' + fmt.int(n.ng))]),
      n.cons
        ? el('div', { style: { marginTop: '5px', display: 'flex', gap: '6px', alignItems: 'center' } },
            [G.consensusGlyph(n.cons, n.r, { max: 12 }), G.coverageBar(n.cov, { carriers: n.carriers })])
        : el('div', { style: { marginTop: '5px' } }, G.noConsensusMark())
    ];
  }

  /* =============================================================================
     the partner rail — a degree-62 hub as a sortable strip
     ============================================================================= */

  function drawRail() {
    clear(railHead); clear(railStrip);
    const selNode = S.sel && !G.isEdgeId(S.sel) ? net.byId.get(S.sel) : null;
    const selEdge = S.sel && G.isEdgeId(S.sel) ? live.edgeById.get(S.sel) : null;
    const anchor = selNode || (selEdge ? net.byId.get(selEdge.p) : null);

    let rows, title, denom = null;
    if (anchor) {
      rows = live.view.edges.filter(e => e.p === anchor.id || e.u === anchor.id);
      title = 'Partners of ' + (anchor.name || anchor.id);
    } else {
      rows = live.view.edges.slice();
      title = S.mode === 'module' ? 'Edges in M' + S.m : 'Strongest edges in view';
    }

    const cmp = {
      sc: (a, b) => b.sc - a.sc, npmi: (a, b) => b.npmi - a.npmi,
      co: (a, b) => b.co - a.co, cl: (a, b) => b.cl - a.cl,
      name: (a, b) => {
        const na = other(a, anchor), nb = other(b, anchor);
        return String(na && na.name || '').localeCompare(String(nb && nb.name || ''));
      }
    }[S.sort] || ((a, b) => b.sc - a.sc);
    rows.sort(cmp);

    append(railHead, [
      el('strong', { style: { fontSize: 'var(--fs-sm)' } }, title),
      el('span.dim', { style: { fontSize: 'var(--fs-xs)' } },
        fmt.int(rows.length) + (anchor ? ' of ' + fmt.int(anchor.deg) + ' gated partners' : ' edges') +
        (rows.length > 250 ? ' · showing the first 250' : '')),
      el('span', { style: { marginLeft: 'auto' } }),
      el('div.nw-sorts', [el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, 'sort')].concat(
        [['sc', 'score'], ['npmi', 'npmi'], ['co', 'co'], ['cl', 'clades'], ['name', 'name']]
          .map(([k, lab]) => el('button', {
            type: 'button', 'aria-pressed': String(S.sort === k),
            title: k === 'name' ? 'alphabetical by partner name' : G.ENC[k].hint,
            on: { click: () => setState({ sort: k === 'sc' ? null : k }) }
          }, lab))
      ).concat([el('button', { type: 'button', disabled: true,
        title: G.ENC_REFUSED.reason,
        style: { textDecoration: 'line-through', opacity: '.55' } }, 'npmi_raw')])),
      csvButton('mirto-network-' + S.mode + (anchor ? '-' + anchor.id : '') + '.csv',
        () => rows.map(e => ({
          protein_cluster: e.p, protein_name: (net.byId.get(e.p) || {}).name,
          utr_cluster: e.u, utr_region: (net.byId.get(e.u) || {}).r,
          utr_name: (net.byId.get(e.u) || {}).name,
          phylo_corrected_score: e.sc, npmi_mip_apc: e.npmi, co_count: e.co,
          n_indep_clades: e.cl, clade_concentration: e.conc, znf_fraction: e.znf,
          cross_module: e.x, consensus_pair: e.cons
        })), null, 'CSV')
    ]);

    if (!rows.length) {
      railStrip.appendChild(emptyState({
        compact: true, mark: '⌀',
        title: anchor ? 'No partner survives the current threshold'
                      : 'No edge is in view',
        message: anchor
          ? (anchor.name || anchor.id) + ' has ' + fmt.int(anchor.deg) + ' gated partners, but none ' +
            'scores at or above ' + fmt.num(S.minsc, 2) + '.'
          : 'Lower the score threshold or turn the cross-module edges back on.',
        denominator: anchor && anchor.r !== 'protein' ? DENOMINATORS.utrNoPartner
                   : anchor ? DENOMINATORS.protNoPartner : null
      }));
      return;
    }

    const dom = G.encDomain(rows, S.sort === 'name' ? 'sc' : S.sort);
    for (const e of rows.slice(0, 250)) {
      const p = net.byId.get(e.p), u = net.byId.get(e.u);
      const partner = anchor ? other(e, anchor) : null;
      const key = G.edgeKey(e);
      const shownNode = partner || p;
      const v = e[S.sort === 'name' ? 'sc' : S.sort];
      railStrip.appendChild(G.nodeRow(shownNode, {
        selected: S.sel === key || S.sel === shownNode.id,
        sub: anchor ? null : (u ? '× ' + u.id : null),
        onPick: () => setState({ sel: key }),
        onHover: id => { if (live.ctrl) live.ctrl.setFocus(id ? key : (S.sel || null), false); },
        right: [
          el('span.num', { title: G.ENC[S.sort === 'name' ? 'sc' : S.sort].hint },
            (G.ENC[S.sort === 'name' ? 'sc' : S.sort].fmt)(v)),
          el('span.bar2', el('i', { style: { width: (100 * (dom[1] > dom[0]
            ? (v - dom[0]) / (dom[1] - dom[0]) : 1)) + '%' } })),
          e.cons ? el('span.num', { title: 'a consensus-level pair backs this edge' }, '≡')
                 : el('span.num', { title: 'cluster-level only — 1,190 of 2,620 edges', style:
                     { color: 'var(--ink-3)' } }, '⋯'),
          e.x ? el('span.num', { title: 'crosses a module boundary',
            class: G.modClass((partner || u).m), style: { color: 'var(--mc)' } }, '↗') : el('span.num', '')
        ]
      }));
    }
  }

  function other(e, anchor) {
    return net.byId.get(e.p === anchor.id ? e.u : e.p);
  }

  /* =============================================================================
     the inspector
     ============================================================================= */

  function drawInspector() {
    clear(inspBody);
    if (!S.sel) { inspBody.appendChild(inspectorIdle()); return; }
    if (G.isEdgeId(S.sel)) {
      const e = live.edgeById.get(S.sel);
      if (!e) { inspBody.appendChild(inspectorMissing('edge', S.sel)); return; }
      inspBody.appendChild(edgeInspector(e));
    } else {
      const n = net.byId.get(S.sel);
      if (!n) { inspBody.appendChild(inspectorMissing('node', S.sel)); return; }
      inspBody.appendChild(nodeInspector(n));
    }
  }

  function inspectorIdle() {
    const mm = modules.find(x => x.id === S.m) || {};
    return el('div.nw-insp-head', [
      el('p.eyebrow.mono', 'inspector'),
      el('h3', { style: { margin: '0 0 var(--s2)' } }, 'Nothing selected'),
      el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-2)', margin: '0 0 var(--s4)' } },
        'Click a node for the cluster, or an edge for the pair. The strip under the canvas is the ' +
        'same data as a sortable list — a degree-62 hub is easier to read there than on the canvas.'),
      S.mode === 'module' ? el('div', [
        el('div.nw-hr'),
        el('div.row', { style: { marginBottom: 'var(--s2)' } },
          [moduleChip(S.m), el('strong', mm.label || moduleLabel(S.m))]),
        el('dl.nw-kv', [
          kv('protein clusters', fmt.int(mm.n_protein || 0)),
          kv('UTR clusters', fmt.int(mm.n_utr || 0)),
          kv('internal edges', fmt.int(mm.n_edges || 0)),
          kv('cross-module out', fmt.int(mm.n_cross_out || 0)),
          kv('cross-module in', fmt.int(mm.n_cross_in || 0)),
          kv('mean score', fmt.num(mm.mean_score, 3)),
          kv('carrier genes', fmt.int(mm.genes || 0))
        ]),
        el('div.nw-linkline', [
          el('a.btn.btn-sm', { href: router.link('/module/' + S.m) }, 'Open module page'),
          el('a.btn.btn-sm', { href: router.link('/browse', { region: '', module: S.m }) }, 'Browse its clusters')
        ]),
        el('p.nw-note', 'Leading terms: ' + (mm.terms || []).slice(0, 4).join(' · '))
      ]) : el('p.nw-note', 'Switch to the module drill-down for a per-module summary here.')
    ]);
  }

  function inspectorMissing(kind, id) {
    return el('div.nw-insp-head', [emptyState({
      compact: true, mark: '⌗',
      title: 'That ' + kind + ' is not in the current view',
      message: el('span', ['The link named ', el('span.mono', id),
        '. It may have been filtered out by the score threshold, or it may not exist in this snapshot.']),
      denominator: fmt.int(net.nodes.length) + ' nodes · ' + fmt.int(net.edges.length) + ' edges in the graph',
      action: el('button.btn.btn-sm', { type: 'button',
        on: { click: () => setState({ sel: null, minsc: null }) } }, 'Clear selection and threshold')
    })]);
  }

  /* ---- node inspector --------------------------------------------------- */
  function nodeInspector(n) {
    const box = el('div');
    box.appendChild(el('div.nw-insp-head', [
      el('div.row', { style: { gap: 'var(--s2)', marginBottom: 'var(--s2)' } }, [
        G.nodeMark(n, { size: 18 }), regionBadge(n.r), moduleChip(n.m),
        el('span', { style: { marginLeft: 'auto' } },
          copyLinkButton({ href: router.link(params.path, Object.assign(qOf(), { sel: n.id })),
                           label: 'Link' }))
      ]),
      el('h3', { style: { margin: '0 0 2px' } }, n.name || n.id),
      el('p', { style: { margin: '0 0 var(--s3)', fontSize: 'var(--fs-sm)', color: 'var(--ink-3)' } }, [
        el('span.mono', n.id), ' · name tier ' + n.tier + ' — ' + tierWord(n.tier) +
        (n.src && n.src !== 'none' ? ' (' + n.src + ')' : '')
      ]),
      el('div', { style: { display: 'flex', gap: 'var(--s3)', alignItems: 'center',
        flexWrap: 'wrap', marginBottom: 'var(--s3)' } }, [
        n.cons ? G.consensusGlyph(n.cons, n.r) : G.noConsensusMark(),
        n.cons ? G.coverageBar(n.cov, { carriers: n.carriers }) : null,
        G.sparkline(n.pos, { w: 72, h: 20, region: n.r })
      ]),
      el('dl.nw-kv', [
        kv('gated partners', fmt.int(n.deg)),
        kv('motif instances', fmt.int(n.n)),
        kv('transcripts', fmt.int(n.nt)),
        kv('genes', fmt.int(n.ng)),
        n.cons ? kv('consensus carriers', fmt.int(n.carriers || 0)) : null
      ].filter(Boolean)),
      el('div.nw-linkline', [
        el('a.btn.btn-sm.btn-primary', { href: router.link('/cluster/' + n.id) }, 'Open cluster page'),
        n.m ? el('a.btn.btn-sm', { href: router.link('/module/' + n.m) }, 'Module M' + n.m) : null,
        el('button.btn.btn-sm', { type: 'button',
          on: { click: () => setState({ mode: 'module', m: n.m || S.m, sel: n.id }) } },
          n.m ? 'Focus M' + n.m : 'Focus')
      ].filter(Boolean))
    ]));

    // logo, lazily
    const logoSlot = el('div', { style: { padding: '0 var(--s4) var(--s4)' } },
      el('div.sk', { style: { height: '74px' } }));
    box.appendChild(logoSlot);
    data.getCluster(n.id).then(c => {
      clear(logoSlot);
      if (!c) { logoSlot.appendChild(G.noLogoMark(n.id)); return; }
      logoSlot.appendChild(el('div.nw-ctl-lab', 'consensus logo'));
      if (c.logo && Array.isArray(c.logo.pwm) && c.logo.pwm.length) {
        logoSlot.appendChild(G.logoSVG(c.logo.pwm, c.logo.alphabet, { region: c.region }));
        logoSlot.appendChild(el('div', { style: { marginTop: '4px' } },
          G.logoSupportBar(c.logo.nsites, c.size && c.size.instances)));
        logoSlot.appendChild(el('p.nw-note', 'STREME ' + (c.logo.motif_id || '') + ' · test p = ' +
          G.pval(c.logo.test_pvalue) + ' · E = ' + G.pval(c.logo.evalue) + ' · ' +
          (c.logo.source || '') + '. The gate is test p < 0.05; without it 43 clusters would ' +
          'take a logo from a motif STREME itself scored p = 1.0.'));
      } else {
        logoSlot.appendChild(G.noLogoMark(n.id));
      }
      if (c.n_terms_total) {
        logoSlot.appendChild(el('div.nw-hr'));
        logoSlot.appendChild(el('div.nw-ctl-lab', [el('span', 'top enriched terms'),
          el('span.v', fmt.int(c.n_terms_total))]));
        logoSlot.appendChild(el('div.nw-badge-line', (c.terms || []).slice(0, 5).map(t =>
          el('span.chip', { title: t.src + ' ' + t.term + ' · fold ' + fmt.num(t.fold, 1) +
            ' · FDR ' + G.pval(t.fdr), style: { background: 'var(--surface-2)',
            color: 'var(--ink-2)', borderColor: 'var(--line)' } }, t.display))));
      } else {
        logoSlot.appendChild(el('div.nw-hr'));
        logoSlot.appendChild(emptyState({
          compact: true, mark: '⌀', title: 'No significant enriched term',
          message: 'Nothing passes FDR < 0.05 within this cluster, so its name comes from a lower tier.',
          denominator: DENOMINATORS.noTerm
        }));
      }
    });
    return box;
  }

  /* ---- edge inspector: facing pages ------------------------------------- */
  function edgeInspector(e) {
    const p = net.byId.get(e.p), u = net.byId.get(e.u);
    const box = el('div');
    box.appendChild(el('div.nw-insp-head', [
      el('div.row', { style: { gap: 'var(--s2)', marginBottom: 'var(--s2)' } }, [
        el('p.eyebrow.mono', { style: { margin: 0 } },
          (!p.m || !u.m) ? 'pair outside every module'
                         : (e.x ? 'cross-module pair' : 'within-module pair')),
        el('span', { style: { marginLeft: 'auto' } },
          copyLinkButton({ href: router.link(params.path, Object.assign(qOf(), { sel: G.edgeKey(e) })),
                           label: 'Link' }))
      ]),
      el('h3', { style: { margin: '0 0 var(--s3)' } }, 'Protein cluster × UTR cluster'),
      caveatInline('This pair is a co-occurrence across transcripts that survived the ' +
        'phylogenetic-independence gate (' + fmt.int(e.cl) + ' independent clades). It is a ' +
        'candidate, not a demonstrated interaction: nothing here shows the protein motif binding ' +
        'the UTR motif.')
    ]));

    const pageP = el('div.nw-page.prot');
    const pageU = el('div.nw-page.rna');
    const spine = el('div.nw-spine', [
      el('span.sv', fmt.num(e.sc, 3)),
      el('span.sk2', 'phylo-corrected score'),
      el('div.nw-gate', [
        gateCell('npmi', fmt.num(e.npmi, 3), 'NPMI with MIP/APC background removed'),
        gateCell('co-count', fmt.int(e.co), 'transcripts carrying both clusters'),
        gateCell('clades', fmt.int(e.cl), 'independent paralog families supporting the pair'),
        gateCell('clade conc.', e.conc == null ? 'n/a' : fmt.num(e.conc, 3),
          e.conc == null ? 'not computable for this pair' :
            'share of the co-occurrence coming from the single largest clade — lower is better'),
        gateCell('ZnF fraction', e.znf == null ? 'n/a' : fmt.num(e.znf, 3),
          'fraction of carriers that are zinc-finger genes; the ZNF clade is the known artifact source'),
        gateCell('boundary',
          (!p.m || !u.m) ? 'no module' : (e.x ? 'M' + p.m + ' → M' + u.m : 'within M' + p.m),
          (!p.m || !u.m)
            ? 'One or both clusters sit outside every module — 6 of 519 nodes do, forming 3 ' +
              'isolated dyads. They appear only in the full graph, never in a module drill-down.'
            : (e.x ? 'this edge crosses a module boundary'
                   : 'both clusters sit in the same module'))
      ]),
      el('span.sk2', e.cons ? 'a consensus-level pair backs this edge'
                            : 'cluster-level only — no consensus pair')
    ]);

    box.appendChild(el('div', { style: { padding: '0 var(--s4) var(--s3)' } },
      el('div.nw-facing', [pageP, spine, pageU])));

    facingPage(pageP, p, 'protein');
    facingPage(pageU, u, 'utr');

    // consensus pairs, if any — fetched from the protein cluster shard
    const pairsSlot = el('div', { style: { padding: '0 var(--s4) var(--s4)' } });
    box.appendChild(pairsSlot);
    pairsSlot.appendChild(el('div.sk', { style: { height: '48px' } }));
    data.getCluster(p.id).then(c => {
      clear(pairsSlot);
      const row = c && (c.partners || []).find(x => x.id === u.id);
      const cp = row && row.consensus_pairs;
      if (cp && cp.length) {
        const zero = cp.filter(x => !(x[2] > 0)).length;
        pairsSlot.appendChild(el('div.nw-ctl-lab', [el('span', 'consensus-level pairs'),
          el('span.v', fmt.int(cp.length))]));
        const tbl = el('table.data', [
          el('thead', el('tr', [el('th', 'protein consensus'), el('th', 'UTR consensus'),
            el('th.num', { title: 'the string-level pair’s own phylo-corrected score' },
              'own score')])),
          el('tbody', cp.map(([a, b, sc]) => el('tr', [
            el('td', G.consensusGlyph(a, 'protein', { max: 12 })),
            el('td', G.consensusGlyph(b, u.r, { max: 12 })),
            el('td.num.mono', {
              style: sc > 0 ? null : { color: 'var(--ink-3)' },
              title: sc > 0 ? 'this string pair carries independent support of its own'
                            : 'measured, but zero after the phylogenetic correction — this string ' +
                              'pair adds no independent evidence to the cluster-level result'
            }, fmt.num(sc, 3))
          ])))
        ]);
        pairsSlot.appendChild(el('div.table-scroll', tbl));
        pairsSlot.appendChild(el('p.nw-note', [
          'These are the consensus strings the two clusters are made of, scored as pairs. ',
          el('b', 'The evidence for this edge is at CLUSTER level. '),
          zero === cp.length
            ? 'All ' + cp.length + ' string-level pairs score 0 after the phylogenetic correction, ' +
              'so none of them adds independent support — they say what the clusters look like, ' +
              'not that these particular strings associate.'
            : fmt.int(zero) + ' of ' + fmt.int(cp.length) + ' score 0 after the phylogenetic ' +
              'correction and add no independent support.',
          ' A recorded consensus-level pair is what makes the edge solid rather than dashed: ' +
          fmt.int(counts.edges_with_consensus_pair || 1430) + ' of ' +
          fmt.int(net.edges.length) + ' gated edges have one.'
        ]));
      } else {
        pairsSlot.appendChild(emptyState({
          compact: true, mark: '⌁',
          title: 'Cluster-level only',
          message: 'This pair passed the gate at the level of the two clusters, but no pair of ' +
                   'consensus strings inside them reaches significance on its own. The edge is drawn ' +
                   'dashed everywhere in this atlas for exactly that reason.',
          denominator: DENOMINATORS.edgeNoPair
        }));
      }
    });

    box.appendChild(el('div', { style: { padding: '0 var(--s4) var(--s4)' } }, [
      el('div.nw-linkline', [
        el('a.btn.btn-sm', { href: router.link('/cluster/' + p.id, { tab: 'partners' }) },
          'Protein cluster page'),
        el('a.btn.btn-sm', { href: router.link('/cluster/' + u.id, { tab: 'partners' }) },
          'UTR cluster page')
      ])
    ]));
    return box;
  }

  function facingPage(host, n, side) {
    clear(host);
    append(host, [
      el('div.row', { style: { gap: '6px', marginBottom: 'var(--s2)' } },
        [G.nodeMark(n, { size: 15 }), regionBadge(n.r), moduleChip(n.m, { quiet: true })]),
      el('a', { href: router.link('/cluster/' + n.id), style: { fontWeight: 640,
        display: 'block', marginBottom: '2px', color: 'var(--ink)' } }, n.name || n.id),
      el('div.gg-id', { style: { marginBottom: 'var(--s2)' } }, n.id + ' · tier ' + n.tier),
      el('div', { style: { minHeight: '78px' } }, el('div.sk', { style: { height: '70px' } })),
      el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
        marginTop: 'var(--s2)' } }, [
        n.cons ? G.consensusGlyph(n.cons, n.r, { max: 12 }) : G.noConsensusMark(),
        n.cons ? G.coverageBar(n.cov, { carriers: n.carriers }) : null
      ].filter(Boolean)),
      el('div', { style: { marginTop: '6px', display: 'flex', gap: 'var(--s2)',
        alignItems: 'center' } }, [
        G.sparkline(n.pos, { w: 64, h: 18, region: n.r }),
        el('span.gg-id', fmt.int(n.n) + ' instances · ' + fmt.int(n.nt) + ' transcripts')
      ])
    ]);
    const slot = host.children[3];
    data.getCluster(n.id).then(c => {
      clear(slot);
      if (c && c.logo && Array.isArray(c.logo.pwm) && c.logo.pwm.length) {
        slot.appendChild(G.logoSVG(c.logo.pwm, c.logo.alphabet,
          { region: c.region, height: 54, colWidth: c.logo.alphabet.length === 4 ? 15 : 13 }));
        slot.appendChild(el('div', { style: { marginTop: '3px' } },
          G.logoSupportBar(c.logo.nsites, c.size && c.size.instances)));
        slot.appendChild(el('div.gg-id', { style: { marginTop: '2px' } },
          'STREME p = ' + G.pval(c.logo.test_pvalue)));
      } else {
        slot.appendChild(G.noLogoMark(n.id));
      }
    });
    void side;
  }

  function gateCell(k, v, title) {
    return el('div.cell', { title }, [el('span.k', k), el('span.v', v)]);
  }

  /* =============================================================================
     matrix
     ============================================================================= */

  function drawMatrix() {
    clear(matrixHost);
    if (!matrix.length) {
      matrixHost.appendChild(emptyState({ compact: true, mark: '⌀',
        title: 'No matrix in this payload', denominator: 'expected a 6 × 6 directional matrix' }));
      return;
    }
    matrixHost.appendChild(G.matrixSVG(matrix, {
      pair: S.pair,
      onModule: m => setState({ m, mode: 'module', pair: null }),
      onCell: (p, u, v) => {
        if (!v) { toast('M' + p + ' protein × M' + u + ' UTR: no gated edge'); return; }
        setState({ m: p, mode: 'module', pair: p === u ? null : p + '-' + u, sel: null });
      }
    }));
    if (S.pair) {
      matrixHost.appendChild(el('div', { style: { marginTop: 'var(--s2)', fontSize: 'var(--fs-xs)' } }, [
        el('span', 'focused on '), el('b', 'M' + S.pair[0] + ' protein → M' + S.pair[1] + ' UTR'),
        ' (', el('b', fmt.int((matrix[S.pair[0] - 1] || [])[S.pair[1] - 1] || 0)), ' edges; the ' +
        'reverse direction has ', el('b', fmt.int((matrix[S.pair[1] - 1] || [])[S.pair[0] - 1] || 0)),
        ') ',
        el('button.btn.btn-sm.btn-ghost', { type: 'button',
          on: { click: () => setState({ pair: null }) } }, 'clear')
      ]));
    }
  }

  /* =============================================================================
     state plumbing
     ============================================================================= */

  function qOf() {
    return {
      mode: S.mode === 'module' ? null : S.mode,
      m: S.m === 1 ? null : S.m,
      pair: S.pair ? S.pair.join('-') : null,
      enc: S.enc === 'sc' ? null : S.enc,
      minsc: S.minsc > scMin + 1e-9 ? fmt.num(S.minsc, 2) : null,
      cross: S.cross ? null : '0',
      sel: S.sel, sort: S.sort === 'sc' ? null : S.sort
    };
  }

  function setState(patch) {
    Object.assign(S, patch);
    // normalise every field the URL can carry, so a `null` in a patch means
    // "back to the default" rather than "put null in the state"
    S.m = pickModule(S.m);
    S.mode = MODES[S.mode] ? S.mode : 'module';
    S.enc = G.ENC[S.enc] ? S.enc : 'sc';
    S.minsc = clampNum(S.minsc, scMin, scMax, scMin);
    S.pair = Array.isArray(S.pair) ? S.pair : parsePair(S.pair);
    S.sort = ['sc', 'npmi', 'co', 'cl', 'name'].indexOf(S.sort) !== -1 ? S.sort : 'sc';
    S.cross = !!S.cross;
    S.sel = typeof S.sel === 'string' && S.sel ? S.sel : null;
    router.setQuery(qOf());
    apply(patch);
  }

  /** Apply a state change to the DOM without a remount. */
  function apply(patch) {
    const keys = Object.keys(patch || {});
    const onlySel = keys.length === 1 && keys[0] === 'sel';
    const onlySort = keys.length === 1 && keys[0] === 'sort';

    for (const [k, b] of modeButtons) b.setAttribute('aria-pressed', String(S.mode === k));
    for (const [k, b] of encButtons) b.setAttribute('aria-pressed', String(S.enc === k));
    for (const b of modRow.querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.mod) === S.m));
    }
    modPick.querySelector('.v').textContent = 'M' + S.m;
    modPick.hidden = S.mode !== 'module';
    if (Math.abs(parseFloat(slider.value) - S.minsc) > 1e-9) slider.value = String(S.minsc);
    thVal.textContent = fmt.num(S.minsc, 2);
    if (!preview.classList.contains('armed')) {
      const s = survivors(net, S.minsc);
      preview.textContent = S.minsc <= scMin + 1e-9
        ? 'no threshold — all ' + fmt.int(net.edges.length) + ' gated edges are in play'
        : 'at ≥ ' + fmt.num(S.minsc, 2) + ' → ' + fmt.int(s.edges) + ' edges, ' +
          fmt.int(s.nodes) + ' nodes';
    }
    crossBox.checked = S.cross;

    drawMatrix();
    if (onlySel) {
      if (live.ctrl) live.ctrl.setFocus(S.sel, false);
      updateSelClasses();
      drawRail();
      drawInspector();
      return;
    }
    if (onlySort) { drawRail(); return; }
    drawCanvas();
    drawRail();
    drawInspector();
  }

  function updateSelClasses() {
    if (!live.ctrl) return;
    for (const p of live.ctrl.svg.querySelectorAll('.g-node.sel')) p.classList.remove('sel');
    if (!S.sel) return;
    const ids = G.isEdgeId(S.sel) ? S.sel.split('~') : [S.sel];
    for (const id of ids) {
      const e = live.ctrl.elByNode.get(id);
      if (e) e.classList.add('sel');
    }
  }

  /* ---- boot ------------------------------------------------------------- */
  live = {
    ctrl: null, ro: null, view: { nodes: [], edges: [], cross: 0, consN: 0 },
    edgeById: new Map(net.edges.map(e => [G.edgeKey(e), e])), hover: null, lastWidth: 0
  };

  apply({});

  // width-driven redraw only (height is derived); avoids a redraw storm on scroll
  if (window.ResizeObserver) {
    live.ro = new ResizeObserver(() => {
      const w = Math.max(320, canvasHost.clientWidth - 16);
      if (Math.abs(w - live.lastWidth) < 12) return;
      drawCanvas();
    });
    live.ro.observe(canvasHost);
  }

  // back/forward over a filter change, and links that only move ?sel=
  router.onQuery(nq => {
    const next = {
      mode: MODES[nq.mode] ? nq.mode : 'module',
      m: pickModule(nq.m != null ? nq.m : (params.module != null ? params.module : 1)),
      pair: parsePair(nq.pair),
      enc: G.ENC[nq.enc] ? nq.enc : 'sc',
      minsc: clampNum(nq.minsc, scMin, scMax, scMin),
      cross: nq.cross !== '0',
      sel: typeof nq.sel === 'string' ? nq.sel : null,
      sort: ['sc', 'npmi', 'co', 'cl', 'name'].indexOf(nq.sort) !== -1 ? nq.sort : 'sc'
    };
    const changed = {};
    for (const k of Object.keys(next)) {
      const a = k === 'pair' ? String(S[k]) : S[k], b = k === 'pair' ? String(next[k]) : next[k];
      if (a !== b) changed[k] = next[k];
    }
    if (!Object.keys(changed).length) return;
    Object.assign(S, next);
    apply(changed);
  });
}

/* =============================================================================
   helpers
   ============================================================================= */

const MODES = {
  module: { label: 'Module drill-down', sub: 'bipartite, ≤133 nodes — the default',
            icon: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
                  '<circle cx="3" cy="4" r="1.6" fill="currentColor"/>' +
                  '<circle cx="3" cy="8" r="1.6" fill="currentColor"/>' +
                  '<circle cx="3" cy="12" r="1.6" fill="currentColor"/>' +
                  '<circle cx="13" cy="5" r="1.6" fill="currentColor"/>' +
                  '<circle cx="13" cy="11" r="1.6" fill="currentColor"/>' +
                  '<path d="M3 4 L13 5 M3 8 L13 5 M3 12 L13 11" stroke="currentColor" ' +
                  'stroke-width=".8" fill="none" opacity=".6"/></svg>' },
  full:   { label: 'Full 519-node graph', sub: 'frozen seed-7 layout, all 2,620 edges',
            icon: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
                  '<path d="M4 3 L11 6 L8 12 L4 3 M11 6 L14 11 M4 3 L2 9 L8 12" stroke="currentColor" ' +
                  'stroke-width=".8" fill="none" opacity=".7"/>' +
                  '<circle cx="4" cy="3" r="1.5" fill="currentColor"/>' +
                  '<circle cx="11" cy="6" r="1.5" fill="currentColor"/>' +
                  '<circle cx="8" cy="12" r="1.5" fill="currentColor"/>' +
                  '<circle cx="2" cy="9" r="1.2" fill="currentColor"/>' +
                  '<circle cx="14" cy="11" r="1.2" fill="currentColor"/></svg>' },
  matrix: { label: 'Seriated matrix', sub: '201 × 318 clusters, only gated cells drawn',
            icon: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
                  '<rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" ' +
                  'stroke-width=".8" opacity=".5"/><rect x="3" y="3" width="3" height="3" ' +
                  'fill="currentColor"/><rect x="7" y="7" width="3" height="3" fill="currentColor"/>' +
                  '<rect x="10" y="4" width="2" height="2" fill="currentColor" opacity=".6"/>' +
                  '<rect x="4" y="10" width="2" height="2" fill="currentColor" opacity=".6"/></svg>' },
  profile:{ label: 'Positional profile map', sub: 'PCA of the 20-bin histogram — not a UMAP',
            icon: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">' +
                  '<circle cx="4" cy="10" r="1.4" fill="currentColor"/>' +
                  '<circle cx="7" cy="6" r="1.4" fill="currentColor"/>' +
                  '<circle cx="11" cy="8" r="1.4" fill="currentColor"/>' +
                  '<circle cx="12" cy="4" r="1.1" fill="currentColor" opacity=".6"/>' +
                  '<circle cx="6" cy="12" r="1.1" fill="currentColor" opacity=".6"/></svg>' }
};
const MODE_ORDER = ['module', 'full', 'matrix', 'profile'];

function pickModule(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/^m/i, ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : 1;
}
function parsePair(s) {
  const m = /^([1-6])-([1-6])$/.exec(String(s || ''));
  return m ? [+m[1], +m[2]] : null;
}
function clampNum(v, lo, hi, def) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function tierWord(t) {
  return { 1: 'a significant enriched term (fold ≥ 2)', 2: 'a significant term with fold < 2',
           3: 'derived from the top consensus string — descriptive only',
           4: 'no term and no consensus; the id is the only honest name' }[t] || 'unknown provenance';
}
function kv(k, v) { return [el('dt', k), el('dd', v)]; }

/** Global survivor counts at a threshold — what the slider promises before you commit. */
function survivors(net, minsc) {
  let e = 0;
  const seen = new Set();
  for (const edge of net.edges) {
    if (edge.sc < minsc - 1e-9) continue;
    e++; seen.add(edge.p); seen.add(edge.u);
  }
  return { edges: e, nodes: seen.size };
}

export function title() { return 'Module network'; }
