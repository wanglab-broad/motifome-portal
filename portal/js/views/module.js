/* =============================================================================
   views/module.js — the six module detail pages.   Route: /module/:n

   Summary · GO themes (significant vs the stricter trusted subset) · member
   clusters · top carrier genes · the caveat stated in full, in the bake's own
   words (modules/<N>.json carries `caveat` and `term_caveat`; the shell's strip
   above is the short form, this page prints the long one).

   Filters live in the URL:  ?tab=&tr=&find=&sort=
   ============================================================================= */

import * as router from '../router.js';
import * as data from '../data.js';
import {
  el, clear, fmt, emptyState, skeleton, moduleChip, regionBadge, copyLinkButton,
  csvButton, setTitle, breadcrumb, moduleLabel, stat, DENOMINATORS
} from '../ui.js';
import * as G from '../graph.js';

let live = null;

export function teardown() {
  if (!live) return;
  try { if (live.ctrl) live.ctrl.destroy(); } catch (e) { /* noop */ }
  try { if (live.ro) live.ro.disconnect(); } catch (e) { /* noop */ }
  live = null;
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'terms', label: 'GO themes' },
  { key: 'clusters', label: 'Member clusters' },
  { key: 'genes', label: 'Carrier genes' }
];

export async function render(host, params) {
  G.ensureStyles();
  teardown();

  const n = parseInt(String(params.n || '').replace(/^m/i, ''), 10);
  const root = el('div.wrap.view-pad');
  host.appendChild(root);
  root.appendChild(skeleton({ rows: 6, label: 'Loading module' }));

  if (!(n >= 1 && n <= 6)) {
    clear(root);
    root.appendChild(breadcrumb([{ label: 'Atlas', href: '#/' },
      { label: 'Network', href: '#/network' }, { label: 'Module' }]));
    root.appendChild(emptyState({
      mark: '⌗', title: 'There is no module ' + (params.n || '?'),
      message: 'The analysis produced six modules, M1 to M6. 387 of 900 clusters were left ' +
               'unassigned and belong to no module at all — they are reachable from the browse ' +
               'page and from their own cluster pages.',
      denominator: DENOMINATORS.noModule,
      action: el('a.btn.btn-primary', { href: '#/network' }, 'Open the module network')
    }));
    return;
  }

  const [mod, net] = await Promise.all([data.getModule(n), data.getNetwork()]);
  clear(root);

  if (!mod) {
    root.appendChild(breadcrumb([{ label: 'Atlas', href: '#/' },
      { label: 'Network', href: '#/network' }, { label: 'M' + n }]));
    root.appendChild(emptyState({
      mark: '⌗', title: 'data/modules/' + n + '.json could not be loaded',
      message: 'The module page needs its own payload: GO enrichment, member clusters and carrier ' +
               'genes. The network view still works from network.json alone.',
      denominator: '6 module files expected in data/modules/',
      action: el('a.btn', { href: '#/network/' + n }, 'Open M' + n + ' in the network')
    }));
    return;
  }

  setTitle(['M' + n + ' — ' + (mod.short || mod.label)]);
  live = { ctrl: null, ro: null };

  const q = params.query || {};
  const S = {
    tab: TABS.some(t => t.key === q.tab) ? q.tab : 'overview',
    trusted: q.tr !== '0',
    find: typeof q.find === 'string' ? q.find : '',
    sort: ['q', 'f', 'k', 'fs'].indexOf(q.sort) !== -1 ? q.sort : 'q'
  };

  const c = mod.counts || {};
  const es = mod.empty_states || {};

  /* =============================================================================
     head
     ============================================================================= */

  root.appendChild(breadcrumb([
    { label: 'Atlas', href: '#/' },
    { label: 'Module network', href: '#/network' },
    { label: 'M' + n }
  ]));

  root.appendChild(el('div', { class: G.modClass(n), style: { marginBottom: 'var(--s5)' } }, [
    el('div.md-swatch', { style: { marginBottom: 'var(--s3)' } }),
    el('div.row', { style: { alignItems: 'flex-start' } }, [
      el('div', { style: { minWidth: 0 } }, [
        el('div.row', { style: { gap: 'var(--s2)', marginBottom: '6px' } }, [
          moduleChip(n, { href: false }),
          el('span.eyebrow.mono', { style: { margin: 0 } },
            fmt.int(c.n_clusters || 0) + ' clusters · ' + fmt.int(c.n_edges || 0) + ' internal edges · ' +
            fmt.int((c.n_cross_out || 0) + (c.n_cross_in || 0)) + ' cross-module')
        ]),
        el('h1', { style: { margin: '0 0 6px' } }, mod.label || moduleLabel(n)),
        el('p.lede', (mod.leading_terms || []).slice(0, 5).join(' · ') || 'No leading terms.')
      ]),
      el('div', { style: { marginLeft: 'auto', display: 'flex', gap: 'var(--s2)', flexWrap: 'wrap' } }, [
        el('a.btn.btn-primary', { href: router.link('/network', { m: n === 1 ? null : n }) },
          'Open in the network'),
        copyLinkButton({ label: 'Copy link' })
      ])
    ])
  ]));

  root.appendChild(el('div.grid.grid-4', { style: { marginBottom: 'var(--s5)' } }, [
    stat('protein clusters', fmt.int(c.n_protein || 0), 'left column of the drill-down'),
    stat('UTR clusters', fmt.int(c.n_utr || 0), "5′ and 3′ together"),
    stat('internal edges', fmt.int(c.n_edges || 0), 'mean score ' + fmt.num(c.mean_score, 3)),
    stat('cross-module', fmt.int(c.n_cross_out || 0) + ' out / ' + fmt.int(c.n_cross_in || 0) + ' in',
      'this module is not an island'),
    stat('carrier genes', fmt.int(c.genes || 0),
      fmt.int(c.genes_hitting_a_term || 0) + ' hit ≥1 significant term'),
    stat('mean independent clades', fmt.num(c.mean_clades, 1), 'phylogenetic breadth per edge'),
    stat('ZnF fraction', fmt.pct(c.frac_znf, 1), 'the known artifact clade'),
    stat('GO terms', fmt.int(c.n_sig_terms || 0),
      fmt.int(c.n_trusted_terms || 0) + ' survive the trusted filter')
  ]));

  /* ---- the caveat, in full, in the bake's own words --------------------- */
  root.appendChild(el('section.card', { style: { marginBottom: 'var(--s5)',
    borderColor: 'var(--warn-line)' } }, [
    el('div.card-pad', [
      el('p.eyebrow.mono', { style: { color: 'var(--warn)' } }, 'what this module is, and is not'),
      el('p', { style: { margin: '0 0 var(--s3)', maxWidth: 'var(--measure)' } },
        mod.caveat || 'Module membership is statistical co-occurrence, not demonstrated interaction.'),
      el('p', { style: { margin: 0, maxWidth: 'var(--measure)', color: 'var(--ink-2)',
        fontSize: 'var(--fs-sm)' } }, mod.term_caveat || '')
    ])
  ]));

  /* ---- tabs ------------------------------------------------------------- */
  const tabs = el('nav.md-tabs', { 'aria-label': 'Module sections' });
  const tabLinks = new Map();
  for (const t of TABS) {
    const a = el('a', {
      href: router.link('/module/' + n, { tab: t.key === 'overview' ? null : t.key }),
      'aria-current': S.tab === t.key ? 'page' : null
    }, t.label + (t.key === 'terms' ? ' (' + fmt.int(c.n_sig_terms || 0) + ')'
                : t.key === 'clusters' ? ' (' + fmt.int(c.n_clusters || 0) + ')'
                : t.key === 'genes' ? ' (' + fmt.int(c.genes || 0) + ')' : ''));
    tabLinks.set(t.key, a);
    tabs.appendChild(a);
  }
  root.appendChild(tabs);

  const body = el('div');
  root.appendChild(body);

  function paint() {
    for (const [k, a] of tabLinks) {
      if (S.tab === k) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    // the preview canvas only exists on the overview tab; drop its observers
    if (live.ctrl) { try { live.ctrl.destroy(); } catch (e) { /* noop */ } live.ctrl = null; }
    if (live.ro) { try { live.ro.disconnect(); } catch (e) { /* noop */ } live.ro = null; }
    live.canvasHost = null;
    clear(body);
    if (S.tab === 'overview') body.appendChild(tabOverview());
    else if (S.tab === 'terms') body.appendChild(tabTerms());
    else if (S.tab === 'clusters') body.appendChild(tabClusters());
    else body.appendChild(tabGenes());
  }

  /* =============================================================================
     overview
     ============================================================================= */

  function tabOverview() {
    const box = el('div');

    // cross-module traffic — the reason the six modules are one graph
    const out = mod.cross && mod.cross.out ? mod.cross.out : {};
    const inn = mod.cross && mod.cross.in ? mod.cross.in : {};
    const flowRow = (title, obj, arrowFirst) => {
      const keys = Object.keys(obj).sort((a, b) => obj[b] - obj[a]);
      return el('div', { style: { marginBottom: 'var(--s3)' } }, [
        el('div.nw-ctl-lab', [el('span', title),
          el('span.v', fmt.int(keys.reduce((t, k) => t + obj[k], 0)))]),
        keys.length ? el('div.nw-badge-line', keys.map(k => el('a', {
          class: 'chip chip-mod mod-' + k,
          href: router.link('/network', { m: arrowFirst ? k : n, pair: arrowFirst ? k + '-' + n : n + '-' + k }),
          title: arrowFirst
            ? 'M' + k + ' protein clusters → M' + n + ' UTR clusters: ' + obj[k] + ' edges'
            : 'M' + n + ' protein clusters → M' + k + ' UTR clusters: ' + obj[k] + ' edges'
        }, [el('span', (arrowFirst ? 'M' + k + ' → ' : '→ M' + k + ' ') + obj[k])]))) :
          el('p.nw-note', 'None.')
      ]);
    };

    box.appendChild(el('div.md-hero', [
      el('section.card', [
        el('div.card-head', [el('h3', 'The bipartite drill-down'),
          el('div.card-tools', el('a.btn.btn-sm',
            { href: router.link('/network', { m: n === 1 ? null : n }) }, 'Open the cockpit'))]),
        el('div.nw-canvas-wrap', { ref: h => { live.canvasHost = h; } }),
        el('div.nw-provenance', G.provenanceNote(net, 'module'))
      ]),
      el('div', [
        el('section.card', { style: { marginBottom: 'var(--s4)' } }, [
          el('div.card-pad', [
            el('h3', { style: { marginTop: 0 } }, 'Cross-module traffic'),
            el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' } },
              (mod.cross && mod.cross.note) || ''),
            flowRow('protein here → UTR elsewhere', out, false),
            flowRow('protein elsewhere → UTR here', inn, true)
          ])
        ]),
        el('section.card', [
          el('div.card-pad', [
            el('h3', { style: { marginTop: 0 } }, 'Leading terms'),
            el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-3)', marginTop: 0 } },
              'The module label is a compression of these — nothing beyond the enrichment is claimed.'),
            (mod.leading_terms || []).length
              ? el('ul', { style: { paddingLeft: '1.1em', margin: 0, fontSize: 'var(--fs-sm)' } },
                  mod.leading_terms.map(t => el('li', t)))
              : emptyState({ compact: true, mark: '⌀', title: 'No leading term',
                  denominator: DENOMINATORS.noTerm })
          ])
        ])
      ])
    ]));

    // strongest internal pairs
    const ee = mod.edges || [];
    box.appendChild(el('section.card', { style: { marginTop: 'var(--s4)' } }, [
      el('div.card-head', [
        el('h3', 'Strongest internal pairs'),
        el('div.card-tools', [
          el('span.dim', { style: { fontSize: 'var(--fs-xs)' } },
            fmt.int(c.edges_shipped || ee.length) + ' of ' + fmt.int(c.n_edges || ee.length) + ' shipped'),
          csvButton('mirto-M' + n + '-edges.csv', () => ee.map(e => ({
            protein_cluster: e.p, utr_cluster: e.u, phylo_corrected_score: e.sc,
            npmi_mip_apc: e.npmi, co_count: e.co, n_indep_clades: e.cl,
            clade_concentration: e.conc, znf_fraction: e.znf
          })), null, 'CSV')
        ])
      ]),
      ee.length ? el('div.table-scroll', el('table.data', [
        el('thead', el('tr', [el('th', 'protein cluster'), el('th', 'UTR cluster'),
          el('th.num', 'score'), el('th.num', 'npmi'), el('th.num', 'co'), el('th.num', 'clades'),
          el('th.num', 'clade conc.'), el('th.num', 'ZnF')])),
        el('tbody', ee.slice(0, 60).map(e => {
          const pn = net && net.byId.get(e.p), un = net && net.byId.get(e.u);
          return el('tr', [
            el('td', el('a', { href: router.link('/cluster/' + e.p) },
              (pn && pn.name) || e.p)),
            el('td', el('a', { href: router.link('/cluster/' + e.u) },
              (un && un.name) || e.u)),
            el('td.num.mono', fmt.num(e.sc, 3)), el('td.num.mono', fmt.num(e.npmi, 3)),
            el('td.num.mono', fmt.int(e.co)), el('td.num.mono', fmt.int(e.cl)),
            el('td.num.mono', e.conc == null ? '—' : fmt.num(e.conc, 3)),
            el('td.num.mono', e.znf == null ? '—' : fmt.num(e.znf, 3))
          ]);
        }))
      ])) : emptyState({ compact: true, mark: '⌀', title: 'No internal pair',
        message: 'Every edge touching this module crosses a boundary.',
        denominator: fmt.int(c.n_edges || 0) + ' internal edges recorded' })
    ]));

    // draw the preview once the card is in the document
    requestAnimationFrame(() => drawPreview());
    return box;
  }

  function drawPreview() {
    const hostEl = live.canvasHost;
    if (!hostEl || !net) return;
    const nodes = net.nodes.filter(x => x.m === n);
    const ids = new Set(nodes.map(x => x.id));
    const edges = net.edges.filter(e => ids.has(e.p) || ids.has(e.u));
    const width = Math.max(300, hostEl.clientWidth - 16) || 560;
    const nProt = nodes.reduce((t, x) => t + (x.r === 'protein' ? 1 : 0), 0);
    const maxCol = Math.max(1, nProt, nodes.length - nProt);
    if (live.ctrl) { try { live.ctrl.destroy(); } catch (e) { /* noop */ } }
    live.ctrl = G.renderCanvas(hostEl, {
      mode: 'module', net, nodes, edges, enc: 'sc', encDomain: G.encDomain(edges, 'sc'),
      module: n, sel: null, showCross: true, nmax: net.nodes.reduce((t, x) => Math.max(t, x.n), 1),
      width, height: Math.max(360, Math.min(900, maxCol * 13 + 70)),
      aria: 'M' + n + ' bipartite drill-down',
      onPick: id => {
        if (!id) return;
        router.navigate('/network', { query: { m: n === 1 ? null : n, sel: id } });
      },
      tipFor: id => {
        if (G.isEdgeId(id)) {
          const e = edges.find(x => G.edgeKey(x) === id);
          if (!e) return null;
          const a = net.byId.get(e.p), b = net.byId.get(e.u);
          return [el('div.t-h', [el('span.t-n', a.name || a.id), el('span.t-k', '×'),
            el('span.t-n', b.name || b.id)]),
            el('div.t-row', [el('span', 'score'), el('span', fmt.num(e.sc, 3))]),
            el('div.t-row', [el('span', 'clades'), el('span', fmt.int(e.cl))])];
        }
        const nd = net.byId.get(id);
        if (!nd) return null;
        return [el('div.t-h', [G.nodeMark(nd, { size: 13 }), el('span.t-n', nd.name || nd.id)]),
          el('div.t-row', [el('span', 'partners'), el('span', fmt.int(nd.deg))]),
          el('div.t-row', [el('span', 'instances'), el('span', fmt.int(nd.n))])];
      }
    });
    live.lastWidth = width;
    if (window.ResizeObserver && !live.ro) {
      live.ro = new ResizeObserver(() => {
        const w = Math.max(300, hostEl.clientWidth - 16);
        if (Math.abs(w - live.lastWidth) < 14) return;
        drawPreview();
      });
      live.ro.observe(hostEl);
    }
  }

  /* =============================================================================
     GO themes — significant vs the stricter trusted subset
     ============================================================================= */

  function tabTerms() {
    const all = mod.terms || [];
    const box = el('div');

    if (!all.length) {
      box.appendChild(emptyState({
        mark: '⌀', title: 'No enriched term at q < 0.05',
        message: 'This module has no GO term over its carrier genes that clears the FDR gate.',
        denominator: DENOMINATORS.noTerm
      }));
      return box;
    }

    const find = S.find.trim().toLowerCase();
    let rows = all.filter(t => (!S.trusted || t.tr) &&
      (!find || String(t.n).toLowerCase().indexOf(find) !== -1 ||
                String(t.t).toLowerCase().indexOf(find) !== -1));
    const cmp = { q: (a, b) => a.q - b.q, f: (a, b) => b.f - a.f,
                  k: (a, b) => b.k - a.k, fs: (a, b) => b.fs - a.fs }[S.sort];
    rows = rows.slice().sort(cmp);

    const search = el('input', {
      type: 'search', value: S.find, placeholder: 'filter terms…', 'aria-label': 'filter GO terms'
    });
    let deb = null;
    search.addEventListener('input', () => {
      clearTimeout(deb);
      deb = setTimeout(() => { S.find = search.value; router.setQuery({ find: S.find || null });
                               paintTermTable(); }, 140);
    });

    const trBtn = el('div.seg', { role: 'group', 'aria-label': 'term confidence' }, [
      el('button', { type: 'button', 'aria-pressed': String(S.trusted),
        title: mod.term_caveat || 'trusted = q < 0.05 and fold ≥ 2 and ≥ 5 independent paralog families',
        on: { click: () => { S.trusted = true; router.setQuery({ tr: null }); paintTermTable(); } } },
        'trusted (' + fmt.int(c.n_trusted_terms || 0) + ')'),
      el('button', { type: 'button', 'aria-pressed': String(!S.trusted),
        title: 'every term at q < 0.05, including those a single paralog family can explain',
        on: { click: () => { S.trusted = false; router.setQuery({ tr: '0' }); paintTermTable(); } } },
        'all significant (' + fmt.int(c.n_sig_terms || 0) + ')')
    ]);

    const sortSeg = el('div.nw-sorts', [el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, 'sort')]
      .concat([['q', 'FDR'], ['f', 'fold'], ['k', 'genes'], ['fs', 'families']].map(([k, lab]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.sort === k),
          on: { click: () => { S.sort = k; router.setQuery({ sort: k === 'q' ? null : k });
                               paintTermTable(); } } }, lab))));

    const tableHost = el('div');
    const countLine = el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-2)',
      margin: '0 0 var(--s3)' } });

    box.appendChild(el('section.card', [
      el('div.card-head', [
        el('h3', 'GO enrichment over carrier genes'),
        el('div.card-tools', [trBtn, sortSeg,
          el('span.md-filter', search),
          csvButton('mirto-M' + n + '-terms.csv', () => rows.map(t => ({
            term: t.t, name: t.n, genes_in_module: t.k, term_size: t.K, fold: t.f, q: t.q,
            paralog_families: t.fs, dominant_family_frac: t.df, trusted: t.tr
          })), null, 'CSV')])
      ]),
      el('div.card-pad', [countLine, tableHost])
    ]));

    function paintTermTable() {
      const f = S.find.trim().toLowerCase();
      rows = all.filter(t => (!S.trusted || t.tr) &&
        (!f || String(t.n).toLowerCase().indexOf(f) !== -1 ||
               String(t.t).toLowerCase().indexOf(f) !== -1))
        .sort({ q: (a, b) => a.q - b.q, f: (a, b) => b.f - a.f,
                k: (a, b) => b.k - a.k, fs: (a, b) => b.fs - a.fs }[S.sort]);
      for (const b of trBtn.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
      trBtn.children[S.trusted ? 0 : 1].setAttribute('aria-pressed', 'true');
      for (const b of sortSeg.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.textContent ===
          { q: 'FDR', f: 'fold', k: 'genes', fs: 'families' }[S.sort]));
      }
      countLine.textContent = 'Showing ' + fmt.int(Math.min(rows.length, 200)) + ' of ' +
        fmt.int(rows.length) + (S.trusted ? ' trusted' : ' significant') + ' terms' +
        (S.trusted ? ' — ' + fmt.int(c.n_sig_terms || 0) + ' terms are significant in total, ' +
          fmt.int((c.n_sig_terms || 0) - (c.n_trusted_terms || 0)) + ' of which the trusted filter ' +
          'removes.' : '.');
      clear(tableHost);
      if (!rows.length) {
        tableHost.appendChild(emptyState({
          compact: true, mark: '⌀', title: 'Nothing matches this filter',
          message: S.trusted ? 'Try the “all significant” tab — the trusted filter removes ' +
            fmt.int((c.n_sig_terms || 0) - (c.n_trusted_terms || 0)) + ' terms in this module.'
            : 'No term name or id contains “' + S.find + '”.',
          denominator: fmt.int(c.n_trusted_terms || 0) + ' trusted of ' +
            fmt.int(c.n_sig_terms || 0) + ' significant'
        }));
        return;
      }
      const maxF = rows.reduce((t, r) => Math.max(t, r.f), 1);
      tableHost.appendChild(el('div.table-scroll', { style: { maxHeight: '620px' } },
        el('table.data', [
          el('thead', el('tr', [
            el('th', 'term'), el('th.num', 'genes'), el('th.num', 'term size'),
            el('th.num', 'fold'), el('th', ''), el('th.num', 'FDR q'),
            el('th.num', 'families'), el('th.num', 'dom. family'), el('th', '')
          ])),
          el('tbody', rows.slice(0, 200).map(t => el('tr', [
            el('td', [el('span', { style: { display: 'block' } }, t.n),
              el('span.mono.dim', { style: { fontSize: 'var(--fs-xs)' } }, t.t)]),
            el('td.num.mono', fmt.int(t.k)), el('td.num.mono', fmt.int(t.K)),
            el('td.num.mono', fmt.num(t.f, 2)),
            el('td', el('span.md-termbar', { class: G.modClass(n), style: { width: '54px' } },
              el('i', { style: { width: (100 * t.f / maxF) + '%' } }))),
            el('td.num.mono', G.pval(t.q)),
            el('td.num.mono', { title: 'independent paralog families supporting the term' }, fmt.int(t.fs)),
            el('td.num.mono', { title: 'fraction of the supporting genes that come from the single ' +
              'largest paralog family — high means one clade explains the term' }, fmt.num(t.df, 2)),
            el('td', t.tr ? el('span.chip', { title: 'q < 0.05, fold ≥ 2, ≥ 5 independent families',
              style: { background: 'var(--surface-2)', color: 'var(--good)',
                       borderColor: 'var(--line)' } }, 'trusted') : el('span.dim', '—'))
          ])))
        ])));
    }
    paintTermTable();
    return box;
  }

  /* =============================================================================
     member clusters
     ============================================================================= */

  function tabClusters() {
    const box = el('div');
    const groups = [
      ['protein', 'Protein clusters', (mod.clusters && mod.clusters.protein) || []],
      ['utr', 'UTR clusters', (mod.clusters && mod.clusters.utr) || []]
    ];
    const noTerm = es.clusters_with_no_significant_term;
    const noCons = es.clusters_with_no_consensus;

    box.appendChild(el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-2)',
      maxWidth: 'var(--measure)', marginTop: 0 } }, [
      'Each card carries the cluster’s name tier, its consensus with the coverage bar next to it ' +
      '(the fraction of members that consensus actually matches), and its positional profile. ',
      noCons != null ? el('b', fmt.of(noCons, es.n_clusters || 0) + ' clusters in this module have ' +
        'no consensus at all') : null,
      noCons != null ? ' and get the hatched fallback mark rather than a blank. ' : '',
      noTerm != null ? el('b', fmt.of(noTerm, es.n_clusters || 0) + ' have no significant term') : null,
      noTerm != null ? ', so their name comes from a lower tier.' : ''
    ]));

    for (const [kind, title, list] of groups) {
      box.appendChild(el('section.card', { style: { marginBottom: 'var(--s4)' } }, [
        el('div.card-head', [
          el('h3', title),
          el('div.card-tools', [
            el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, fmt.int(list.length) + ' clusters'),
            csvButton('mirto-M' + n + '-' + kind + '-clusters.csv', () => list.map(x => ({
              cluster_id: x.id, region: x.r, name: x.name, name_tier: x.tier,
              gated_partners: x.deg, instances: x.n, transcripts: x.nt, genes: x.ng,
              consensus: x.cons, consensus_coverage: x.cov
            })), null, 'CSV')
          ])
        ]),
        el('div.card-pad', list.length
          ? el('div.md-cluster-grid', list.slice().sort((a, b) => b.deg - a.deg || b.n - a.n)
              .map(x => clusterCard(x)))
          : emptyState({ compact: true, mark: '⌀', title: 'No ' + kind + ' cluster in this module',
              denominator: DENOMINATORS.noModule }))
      ]));
    }
    return box;
  }

  function clusterCard(x) {
    const nd = (net && net.byId.get(x.id)) || x;
    return el('a.md-cc', { href: router.link('/cluster/' + x.id),
      title: x.id + ' · ' + fmt.int(x.n) + ' instances in ' + fmt.int(x.nt) + ' transcripts' }, [
      el('div.r1', [
        G.nodeMark({ m: n, r: x.r }, { size: 14 }),
        el('span', { style: { fontWeight: 620, fontSize: 'var(--fs-sm)', overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, x.name || x.id),
        el('span', { style: { marginLeft: 'auto' } }, regionBadge(x.r))
      ]),
      el('div.gg-id', { style: { marginBottom: '5px' } },
        x.id + ' · tier ' + x.tier + ' · ' + fmt.int(x.deg) + ' partners · ' +
        fmt.int(x.n) + ' instances'),
      el('div.r2', [
        x.cons ? G.consensusGlyph(x.cons, x.r, { max: 10 }) : G.noConsensusMark(),
        x.cons ? G.coverageBar(x.cov) : null,
        el('span', { style: { marginLeft: 'auto' } },
          G.sparkline(nd.pos, { w: 48, h: 15, region: x.r }))
      ].filter(Boolean))
    ]);
  }

  /* =============================================================================
     carrier genes
     ============================================================================= */

  function tabGenes() {
    const genes = mod.genes || [];
    const box = el('div');
    if (!genes.length) {
      box.appendChild(emptyState({ mark: '⌀', title: 'No carrier gene list in this payload',
        denominator: fmt.int(c.genes || 0) + ' carrier genes counted' }));
      return box;
    }
    const find = el('input', { type: 'search', placeholder: 'find a gene…',
      'aria-label': 'find a carrier gene' });
    const tbody = el('tbody');
    const note = el('p', { style: { fontSize: 'var(--fs-sm)', color: 'var(--ink-2)', margin: 0 } });

    function fill() {
      const f = find.value.trim().toUpperCase();
      const rows = genes.filter(g => !f || String(g.s).toUpperCase().indexOf(f) !== -1);
      clear(tbody);
      note.textContent = 'Showing ' + fmt.int(rows.length) + ' of ' +
        fmt.int(c.genes_shipped || genes.length) + ' shipped — this module has ' +
        fmt.int(c.genes || 0) + ' carrier genes in total, of which ' +
        fmt.int(c.genes_hitting_a_term || 0) + ' hit at least one significant term. ' +
        'The list is ordered by trusted terms hit, then significant terms hit, then symbol.';
      if (!rows.length) {
        tbody.appendChild(el('tr', el('td', { colspan: 6 },
          emptyState({ compact: true, mark: '⌀', title: 'No gene matches “' + find.value + '”',
            denominator: fmt.int(genes.length) + ' genes shipped for this module' }))));
        return;
      }
      for (const g of rows.slice(0, 400)) {
        tbody.appendChild(el('tr', [
          el('td', el('a', { href: router.link('/gene/' + g.rs) }, g.s)),
          el('td.mono.dim', g.rs),
          el('td.num.mono', fmt.int(g.nt)),
          el('td.num.mono', { title: 'paralog families this gene belongs to' }, fmt.int(g.pf)),
          el('td.num.mono', fmt.int(g.sig)),
          el('td.num.mono', fmt.int(g.trs))
        ]));
      }
    }
    find.addEventListener('input', fill);

    box.appendChild(el('section.card', [
      el('div.card-head', [
        el('h3', 'Top carrier genes'),
        el('div.card-tools', [
          el('span.md-filter', find),
          csvButton('mirto-M' + n + '-genes.csv', () => genes.map(g => ({
            gene_symbol: g.s, refseq: g.rs, transcripts: g.nt, paralog_families: g.pf,
            significant_terms_hit: g.sig, trusted_terms_hit: g.trs
          })), null, 'CSV')
        ])
      ]),
      el('div.card-pad', [
        note,
        el('div.table-scroll', { style: { maxHeight: '620px', marginTop: 'var(--s3)' } },
          el('table.data', [
            el('thead', el('tr', [el('th', 'gene'), el('th', 'RefSeq'), el('th.num', 'transcripts'),
              el('th.num', 'paralog families'), el('th.num', 'significant terms'),
              el('th.num', 'trusted terms')])),
            tbody
          ]))
      ])
    ]));
    fill();
    return box;
  }

  /* ---- go ---------------------------------------------------------------- */
  paint();

  router.onQuery(nq => {
    const tab = TABS.some(t => t.key === nq.tab) ? nq.tab : 'overview';
    const trusted = nq.tr !== '0';
    const find = typeof nq.find === 'string' ? nq.find : '';
    const sort = ['q', 'f', 'k', 'fs'].indexOf(nq.sort) !== -1 ? nq.sort : 'q';
    if (tab === S.tab && trusted === S.trusted && find === S.find && sort === S.sort) return;
    const tabChanged = tab !== S.tab;
    S.tab = tab; S.trusted = trusted; S.find = find; S.sort = sort;
    if (tabChanged) paint();
  });
}

export function title(params) { return 'Module M' + (params && params.n); }
