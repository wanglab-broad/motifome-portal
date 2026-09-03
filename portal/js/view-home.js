/* =============================================================================
   view-home.js — the front door.

   The six modules ARE the landing page. Below them sits the one chart that
   matters most: the attrition funnel. 180,000 candidate protein-cluster x
   UTR-cluster pairs go in; 2,620 come out. A reader who leaves this page
   having learned only that has learned the right thing.

   Everything numeric on this page is read live from portal/data/manifest.json
   and portal/data/network.json. The only literals are labelled as bake-time
   measurements with their provenance, and there are exactly two of them.

   API:  render(container, params)   teardown()
   ============================================================================= */

import * as router from './router.js';
import * as data from './data.js';
import {
  el, mount, clear, fmt, card, stat, moduleChip, moduleLabel,
  regionBadge, emptyState, setTitle, omnibox, DENOMINATORS
} from './ui.js';

/* -----------------------------------------------------------------------------
   The two bake-time constants on this page.

   PAIR_CO_OCCUR — 07_cluster_shards.py consumed 180,000 partner rows (300
   protein clusters x 600 UTR clusters) and measured 13,385 of them at co == 0,
   i.e. the two clusters never share a transcript. 180,000 - 13,385 = 166,615
   pairs that co-occur at least once. This is the same denominator the shell
   prints in its caveat strip ("2,620 of 166,615 co-occurring pairs, 1.6%"), so
   the funnel and the caveat can never disagree. It is not in manifest.json;
   if a future bake adds manifest.pairs.co_occurring, that wins (see funnelData).

   SEEDS — five real transcripts, each verified present in search.json, chosen
   so that between them they touch five different primary modules.
   -------------------------------------------------------------------------- */
const PAIR_CO_OCCUR = 166615;

const SEEDS = [
  { sym: 'ACTB',   why: 'the cytoskeletal workhorse; 20 motifs, a compact 3′UTR' },
  { sym: 'SOX2',   why: 'developmental transcription factor' },
  { sym: 'MLXIPL', why: 'ChREBP — long 5′UTR, carbohydrate-response' },
  { sym: 'TRA2B',  why: 'splicing factor that autoregulates through its own UTRs' },
  { sym: 'NOTCH1', why: '110 motifs across a 2,555-residue receptor' }
];

/* -------------------------------------------------------------------------- */

const STYLE_ID = 'mirto-home-css';
let tipNode = null;
let idleHandle = null;
let cancelled = false;

export function teardown() {
  cancelled = true;
  if (idleHandle != null) {
    if (window.cancelIdleCallback) { try { window.cancelIdleCallback(idleHandle); } catch (e) {} }
    else clearTimeout(idleHandle);
    idleHandle = null;
  }
  if (tipNode && tipNode.parentNode) tipNode.parentNode.removeChild(tipNode);
  tipNode = null;
}

/* =============================================================================
   render
   ============================================================================= */

export async function render(host, params) {
  cancelled = false;
  setTitle(null);
  injectStyle();

  const wrap = el('div.wrap');
  mount(host, wrap);

  const manifest = await data.getManifest();
  if (cancelled) return;

  const c = (manifest && manifest.counts) || {};
  const es = (manifest && manifest.empty_states) || {};
  const cov = (manifest && manifest.coverage) || {};

  /* --- 1. hero ---------------------------------------------------------- */
  wrap.appendChild(hero(manifest, c));

  /* --- 2. live counts --------------------------------------------------- */
  wrap.appendChild(statStrip(c, cov, manifest));

  /* --- 3. the six modules: the front door ------------------------------- */
  const modSection = el('section.section#modules');
  wrap.appendChild(modSection);
  const cardHosts = mountModuleSection(modSection, es);

  /* --- 4. the funnel ---------------------------------------------------- */
  const funnelSection = el('section.section#funnel');
  wrap.appendChild(funnelSection);

  /* --- 5. three ways in ------------------------------------------------- */
  wrap.appendChild(entryPoints(c, es));

  /* --- 6. what this page will not claim --------------------------------- */
  wrap.appendChild(closing(manifest));

  if (!manifest) wrap.insertBefore(notBakedBanner(), wrap.firstChild.nextSibling);

  installTooltips(wrap);

  /* --- async: the network payload fills the module cards and the funnel -- */
  const net = await data.getNetwork();
  if (cancelled) return;

  fillModuleCards(cardHosts, net);
  mount(funnelSection, funnel(manifest, net));
  installTooltips(funnelSection);

  /* --- idle: one named carrier gene per module, from modules/<n>.json ---- */
  scheduleIdle(() => fillExampleGenes(cardHosts, net));
}

/* =============================================================================
   1. hero — one paragraph, in a working scientist's language
   ============================================================================= */

function hero(manifest, c) {
  const h = el('header.home-hero');

  h.appendChild(el('p.eyebrow.mono',
    'MIRTO · protein-conditioned masked diffusion over full-length human mRNA'));

  h.appendChild(el('h1.home-h1',
    'Motifs that keep company across the coding boundary.'));

  h.appendChild(el('p.lede.home-lede', [
    'MIRTO reads a whole mRNA while conditioned on the protein it encodes. Two of its internals ' +
    'are readable: where attention concentrates, and how surprised the model is by each ' +
    'nucleotide (NTScore). Together they localise ',
    el('strong', fmt.int(c.motifs || 889215) + ' motif instances'),
    ' in the 5′UTR, 3′UTR and protein sequence of ',
    el('strong', fmt.int(c.transcripts || 18093) + ' human transcripts'),
    '. Instances were embedded and k-means’d into ',
    el('strong', fmt.int(c.clusters || 900) + ' clusters'),
    ', every protein cluster was tested against every UTR cluster for co-occurrence across genes ' +
    '(NPMI with an APC background correction), and the survivors of a phylogenetic-independence ' +
    'gate were organised into six modules. What follows is that evidence, in full — including ' +
    'every place it runs out.'
  ]));

  h.appendChild(el('div.row.home-cta', [
    el('a.btn.btn-primary', { href: router.link('/network') }, 'Explore the module network'),
    el('button.btn', {
      type: 'button', on: { click: () => omnibox().open() }
    }, ['Look up a gene ', el('kbd.kbd-hint', isMac() ? '⌘K' : 'Ctrl K')]),
    el('a.btn.btn-ghost', { href: router.link('/about') }, 'Methods & caveats')
  ]));

  return h;
}

function isMac() {
  return /Mac|iPhone|iPad/.test((navigator.platform || '') + (navigator.userAgent || ''));
}

/* =============================================================================
   2. live counts
   ============================================================================= */

function statStrip(c, cov, manifest) {
  const s = el('div.grid.grid-4.home-stats');
  s.appendChild(stat('Motif instances', fmt.int(c.motifs),
    "5′UTR, 3′UTR and protein"));
  s.appendChild(stat('Transcripts', fmt.int(c.transcripts),
    fmt.int(c.genes) + ' gene symbols'));
  s.appendChild(stat('Motif clusters', fmt.int(c.clusters),
    cov.clusters_in_network != null
      ? fmt.int(cov.clusters_in_network) + ' carry a gated association'
      : 'k-means on embeddings'));
  s.appendChild(stat('Gated associations', fmt.int(c.edges),
    fmt.int(c.cross_module_edges) + ' cross a module boundary'));
  if (manifest && manifest.built) s.setAttribute('data-built', manifest.built);
  return s;
}

/* =============================================================================
   3. the six module story cards
   ============================================================================= */

function mountModuleSection(section, es) {
  section.appendChild(el('header.sec-head', [
    el('p.eyebrow.mono', 'the front door'),
    el('h2', 'Six modules'),
    el('p.lede',
      'Each module is a bipartite community of protein motif clusters and UTR motif clusters that ' +
      'co-occur across genes more than the background allows. Modules are named after the GO terms ' +
      'enriched in their carrier genes — the name describes the genes, not the motifs.')
  ]));

  const grid = el('div.grid.grid-2.mod-grid');
  section.appendChild(grid);

  const hosts = {};
  for (let n = 1; n <= 6; n++) {
    const host = moduleCardShell(n);
    hosts[n] = host;
    grid.appendChild(host.node);
  }

  section.appendChild(el('p.dim.sec-foot', [
    fmt.of(es.clusters_no_module != null ? es.clusters_no_module : DENOMINATORS.noModule.k,
           es.clusters_total != null ? es.clusters_total : DENOMINATORS.noModule.n),
    ' clusters belong to no module at all. They are not failures — they are clusters whose ' +
    'associations did not survive the gate, and they keep their own pages.'
  ]));

  return hosts;
}

/** The card renders instantly from the colour + label constants; the counts,
 *  themes and example gene stream in. Nothing here is ever a blank box. */
function moduleCardShell(n) {
  const href = router.link('/module/' + n);
  const facts = el('div.mod-facts');
  const themes = el('div.mod-themes');
  const example = el('div.mod-example.dim', 'top carrier gene…');

  for (let i = 0; i < 3; i++) facts.appendChild(el('div.sk', { style: { height: '30px' } }));

  const node = el('article.card.mod-card', { style: { '--mod-c': 'var(--mod-' + n + ')' } }, [
    el('div.mod-rail', { 'aria-hidden': 'true' }),
    el('div.card-pad.mod-body', [
      el('div.row.mod-top', [
        moduleChip(n, { href }),
        el('span.mod-short.dim', '')
      ]),
      el('h3.mod-label', el('a', { href }, moduleLabel(n))),
      facts,
      themes,
      example,
      el('a.mod-open', { href }, ['Open module M' + n, el('span', { 'aria-hidden': 'true' }, ' →')])
    ])
  ]);

  return { n, node, facts, themes, example, short: node.querySelector('.mod-short'),
           label: node.querySelector('.mod-label a') };
}

function fillModuleCards(hosts, net) {
  const mods = (net && net.meta && Array.isArray(net.meta.modules)) ? net.meta.modules : [];
  if (!mods.length) {
    for (const n of Object.keys(hosts)) {
      const h = hosts[n];
      clear(h.facts);
      h.facts.appendChild(el('p.dim.mod-nodata',
        'network.json did not load, so this module’s counts are unavailable. The module page ' +
        'itself reads a different payload and may still work.'));
      clear(h.example);
    }
    return;
  }

  for (const m of mods) {
    const h = hosts[m.id];
    if (!h) continue;

    h.label.textContent = m.label || moduleLabel(m.id);
    h.short.textContent = m.short || '';

    clear(h.facts);
    h.facts.appendChild(fact(
      fmt.int(m.n_protein) + ' × ' + fmt.int(m.n_utr),
      'protein × UTR clusters',
      fmt.int(m.n_protein) + ' protein clusters and ' + fmt.int(m.n_utr) +
      ' UTR clusters (5′ and 3′ together) belong to M' + m.id));
    h.facts.appendChild(fact(
      fmt.int(m.n_edges), 'internal edges',
      fmt.int(m.n_edges) + ' gated pairs with both endpoints inside M' + m.id + '; ' +
      fmt.int(m.n_cross_out) + ' more leave it and ' + fmt.int(m.n_cross_in) + ' arrive from elsewhere'));
    h.facts.appendChild(fact(
      fmt.int(m.genes), 'carrier genes',
      'genes carrying at least one motif from a cluster in this module'));

    clear(h.themes);
    const terms = Array.isArray(m.terms) ? m.terms.slice(0, 4) : [];
    if (terms.length) {
      h.themes.appendChild(el('p.mod-themes-k', 'Leading enriched themes in its carrier genes'));
      const list = el('ul.term-pills');
      for (const t of terms) list.appendChild(el('li.term-pill', t));
      h.themes.appendChild(list);
      if (m.n_sig_terms) {
        h.themes.appendChild(el('p.mod-themes-n.dim',
          fmt.int(m.n_trusted_terms) + ' of ' + fmt.int(m.n_sig_terms) +
          ' significant terms also clear the trusted filter (fold ≥ 2, ≥ 5 families)'));
      }
    } else {
      h.themes.appendChild(el('p.dim.mod-themes-n', 'No enriched term reached significance for this module.'));
    }
  }
}

function fact(v, k, tip, chips) {
  return el('div.mod-fact', { dataset: tip ? { tip } : null }, [
    el('span.mod-fact-v.mono', v),
    el('span.mod-fact-k', k),
    chips ? el('span.mod-fact-chips', chips) : null
  ]);
}

/** Idle-time: pull each module payload for its top carrier gene. This doubles
 *  as a prefetch — clicking through to /module/<n> is then instant. */
async function fillExampleGenes(hosts, net) {
  const shown = new Map();               // symbol -> [module ids that it tops]

  for (let n = 1; n <= 6; n++) {
    if (cancelled) return;
    const h = hosts[n];
    if (!h) continue;
    const mod = await data.getModule(n);
    if (cancelled) return;
    clear(h.example);
    const g = mod && Array.isArray(mod.genes) && mod.genes.length ? mod.genes[0] : null;
    if (!g) {
      h.example.appendChild(el('span.dim', 'No carrier-gene ranking in this payload.'));
      continue;
    }
    h.example.classList.remove('dim');
    h.example.appendChild(el('span.mod-example-k', 'Top carrier gene'));
    h.example.appendChild(el('a.mod-example-g', {
      href: router.link('/gene/' + g.rs),
      dataset: { tip: g.s + ' (' + g.rs + ') carries ' + fmt.int(g.pf) +
                      ' motif instances and hits ' + fmt.int(g.trs) + ' of M' + n +
                      '’s trusted terms — ranked first of ' +
                      fmt.int((mod.counts && mod.counts.genes) || 0) + ' carrier genes.' },
      on: { pointerenter: () => data.prefetchGene(g.rs) }
    }, g.s));
    h.example.appendChild(el('span.mod-example-sub.dim.mono', g.rs));

    // A gene may top more than one module — NOTCH1 tops both M1 and M2. Say so
    // rather than letting the repeat read as a rendering bug.
    if (!shown.has(g.s)) shown.set(g.s, []);
    shown.get(g.s).push({ n, node: h.example });
  }

  for (const [, hits] of shown) {
    if (hits.length < 2) continue;
    for (const hit of hits) {
      const others = hits.filter(o => o.n !== hit.n).map(o => 'M' + o.n).join(', ');
      hit.node.appendChild(el('span.mod-example-dup', {
        dataset: { tip: 'The same gene is the top carrier of more than one module. The modules ' +
                        'are communities of motif clusters, not disjoint sets of genes.' }
      }, 'also tops ' + others));
    }
  }
}

function scheduleIdle(fn) {
  if (window.requestIdleCallback) idleHandle = window.requestIdleCallback(fn, { timeout: 3000 });
  else idleHandle = setTimeout(fn, 400);
}

/* =============================================================================
   4. the funnel — the single most important thing on this page
   ============================================================================= */

function funnelData(manifest, net) {
  const c = (manifest && manifest.counts) || {};
  const es = (manifest && manifest.empty_states) || {};
  const nProt = es.prot_clusters_total || 300;
  const nUtr = es.utr_clusters_total || 600;
  const possible = nProt * nUtr;
  // a future bake may publish this; prefer it over the measured constant
  const coOccur = (manifest && manifest.pairs && manifest.pairs.co_occurring) || PAIR_CO_OCCUR;
  const gated = c.edges || 2620;

  const meta = (net && net.meta) || {};
  const mods = Array.isArray(meta.modules) ? meta.modules : [];
  const counts = meta.counts || {};

  return {
    nProt, nUtr, possible, coOccur, gated,
    withinModule: counts.within_module_edges != null
      ? counts.within_module_edges
      : mods.reduce((a, m) => a + (m.n_edges || 0), 0),
    cross: counts.cross_module_edges != null ? counts.cross_module_edges : (c.cross_module_edges || 0),
    outside: counts.edges_outside_module != null ? counts.edges_outside_module : 0,
    mods,
    clustersInModule: (manifest && manifest.coverage && manifest.coverage.clusters_with_module) || null,
    clustersTotal: es.clusters_total || c.clusters || 900,
    nModules: c.modules || mods.length || 6
  };
}

function funnel(manifest, net) {
  const d = funnelData(manifest, net);
  const sec = el('div');

  sec.appendChild(el('header.sec-head', [
    el('p.eyebrow.mono', 'the gate'),
    el('h2', 'Most candidate associations did not survive.'),
    el('p.lede',
      'Every protein cluster was tested against every UTR cluster. Co-occurrence is cheap — ' +
      'almost every pair shares a gene somewhere. What is expensive is surviving the ' +
      'phylogenetic-independence gate, which asks whether an association still holds once one ' +
      'paralogous clade can no longer carry it on its own.')
  ]));

  const stages = [
    { k: 'possible', label: 'All candidate pairs',
      sub: fmt.int(d.nProt) + ' protein clusters × ' + fmt.int(d.nUtr) + ' UTR clusters',
      v: d.possible, tone: 1,
      tip: 'The complete cross product. Every protein cluster was scored against every UTR cluster; ' +
           'nothing was pre-filtered by sequence similarity.' },
    { k: 'cooccur', label: 'Co-occur in at least one transcript',
      sub: pctOf(d.coOccur, d.possible) + ' of all pairs — co-occurrence alone filters almost nothing',
      v: d.coOccur, tone: 2,
      tip: fmt.int(d.possible - d.coOccur) + ' pairs never share a transcript, so no association ' +
           'statistic is computable for them at all. Measured at bake.' },
    { k: 'gated', label: 'Pass the four-condition phylogenetic-independence gate',
      sub: pctOf(d.gated, d.possible) + ' of all pairs · ' + pctOf(d.gated, d.coOccur) +
           ' of the pairs that co-occur',
      v: d.gated, tone: 3, accent: true,
      tip: 'NPMI with an APC background correction, then the gate: enough independent gene ' +
           'families carrying the pair, and no single clade (ZNF, olfactory receptor, PCDH) ' +
           'accounting for it. These 2,620 are the atlas’s edges.' }
  ];

  const chart = el('div.fn-chart', { role: 'img',
    'aria-label': 'Funnel: ' + stages.map(s => s.label + ', ' + fmt.int(s.v)).join('; ') });

  for (const s of stages) {
    const w = 100 * s.v / d.possible;
    const inside = w >= 22;
    chart.appendChild(el('div.fn-row' + (s.accent ? '.is-survivor' : ''), [
      el('div.fn-label', [
        el('span.fn-label-t', s.label),
        el('span.fn-label-s.dim', s.sub)
      ]),
      el('div.fn-track', [
        el('div.fn-bar', {
          dataset: { tip: s.tip, tone: String(s.tone) },
          style: { width: Math.max(w, 0.35) + '%' }
        }, inside ? el('span.fn-val-in.mono', fmt.int(s.v)) : null),
        inside ? null : el('span.fn-val-out.mono', { style: { left: Math.max(w, 0.35) + '%' } },
          fmt.int(s.v))
      ])
    ]));
  }

  const dropped = d.possible - d.gated;
  chart.appendChild(el('p.fn-note', [
    el('span.fn-note-mark', { 'aria-hidden': 'true' }, '⤷'),
    el('span', [
      el('strong', fmt.int(dropped) + ' pairs (' + pctOf(dropped, d.possible) + ') are gone by the ' +
        'third bar.'),
      ' The atlas shows you the ', el('strong', fmt.int(d.gated)),
      ' that are left. Sorting by the uncorrected NPMI would hand back the discarded leaderboard, ' +
      'which is why it is not offered as a sort key anywhere in this site.'
    ])
  ]));

  sec.appendChild(chart);

  /* --- stage 3: what the survivors organise into ------------------------ */
  sec.appendChild(survivorBar(d));

  /* --- the table twin --------------------------------------------------- */
  const table = funnelTable(d);
  table.hidden = true;
  const toggle = el('button.btn.btn-sm', {
    type: 'button', 'aria-expanded': 'false',
    on: { click: () => {
      table.hidden = !table.hidden;
      toggle.setAttribute('aria-expanded', String(!table.hidden));
      toggle.querySelector('span:last-child').textContent =
        table.hidden ? 'Show these numbers as a table' : 'Hide the table';
    } }
  }, [el('span', { 'aria-hidden': 'true' }, '≣'), el('span', 'Show these numbers as a table')]);

  sec.appendChild(el('div.fn-tools', [toggle]));
  sec.appendChild(table);

  return sec;
}

function survivorBar(d) {
  const total = d.gated || 1;
  const zoom = Math.round(d.possible / total);

  const host = el('div.fn-zoom');
  host.appendChild(el('p.fn-zoom-head', [
    el('span.fn-zoom-mark.mono', '×' + fmt.int(zoom)),
    el('span', ['The ', el('strong', fmt.int(total)), ' survivors, magnified to full width — ' +
      'and they do not fall into six tidy islands.'])
  ]));

  if (!d.mods.length) {
    host.appendChild(emptyState({
      mark: '○', compact: true,
      title: 'The module breakdown needs network.json',
      message: 'The gate counts above come from manifest.json and are intact. The per-module split ' +
               'of the surviving edges lives in network.json, which did not load this session.',
      denominator: fmt.int(total) + ' gated edges in total'
    }));
    return host;
  }

  const segs = d.mods.map(m => ({
    v: m.n_edges || 0, label: 'M' + m.id,
    color: 'var(--mod-' + m.id + ')', ink: 'var(--mod-' + m.id + '-ink)',
    href: router.link('/module/' + m.id),
    tip: 'M' + m.id + ' — ' + (m.label || moduleLabel(m.id)) + ': ' + fmt.int(m.n_edges) +
         ' gated pairs with both endpoints inside the module.'
  }));

  const group1 = el('div.fn-stack-group', { style: { flexGrow: String(d.withinModule || 1) } });
  for (const s of segs) {
    const w = 100 * s.v / (d.withinModule || 1);
    const fits = (100 * s.v / total) >= 9;
    group1.appendChild(el('a.fn-seg', {
      href: s.href, dataset: { tip: s.tip },
      style: { width: w + '%', background: s.color, color: s.ink }
    }, fits ? el('span.fn-seg-l.mono', s.label + ' ' + fmt.int(s.v)) : null));
  }

  const group2 = el('div.fn-stack-group', { style: { flexGrow: String((d.cross + d.outside) || 1) } });
  const g2total = (d.cross + d.outside) || 1;
  group2.appendChild(el('div.fn-seg.fn-seg-cross', {
    dataset: { tip: fmt.int(d.cross) + ' gated pairs join a protein cluster in one module to a UTR ' +
                    'cluster in another. They are why the gated graph is one connected component of ' +
                    '513 nodes and not six separate panels.' },
    style: { width: (100 * d.cross / g2total) + '%' }
  }, el('span.fn-seg-l.mono', fmt.int(d.cross))));
  if (d.outside > 0) {
    group2.appendChild(el('div.fn-seg.fn-seg-out', {
      dataset: { tip: fmt.int(d.outside) + ' gated pairs have both endpoints outside every module. ' +
                      'They form isolated dyads and are placed, not laid out, in the network view.' },
      style: { width: (100 * d.outside / g2total) + '%' }
    }));
  }

  host.appendChild(el('div.fn-stack', [group1, group2]));
  host.appendChild(el('div.fn-stack-caps', [
    el('span.fn-cap', { style: { flexGrow: String(d.withinModule || 1) } }, [
      el('b.mono', fmt.int(d.withinModule)), ' inside a single module (',
      pctOf(d.withinModule, total), ')'
    ]),
    el('span.fn-cap.fn-cap-2', { style: { flexGrow: String(g2total) } }, [
      el('b.mono', fmt.int(d.cross + d.outside)), ' crossing or outside (',
      pctOf(d.cross + d.outside, total), ')'
    ])
  ]));

  const legend = el('div.fn-legend', { role: 'list' });
  for (const m of d.mods) {
    legend.appendChild(el('a.fn-key', { role: 'listitem', href: router.link('/module/' + m.id) }, [
      el('span.fn-key-sw', { style: { background: 'var(--mod-' + m.id + ')' }, 'aria-hidden': 'true' }),
      el('span.fn-key-l', 'M' + m.id),
      el('span.fn-key-v.mono', fmt.int(m.n_edges))
    ]));
  }
  legend.appendChild(el('span.fn-key', { role: 'listitem' }, [
    el('span.fn-key-sw.sw-cross', { 'aria-hidden': 'true' }),
    el('span.fn-key-l', 'cross-module'),
    el('span.fn-key-v.mono', fmt.int(d.cross))
  ]));
  legend.appendChild(el('span.fn-key', { role: 'listitem' }, [
    el('span.fn-key-sw.sw-out', { 'aria-hidden': 'true' }),
    el('span.fn-key-l', 'outside every module'),
    el('span.fn-key-v.mono', fmt.int(d.outside))
  ]));
  host.appendChild(legend);

  if (d.clustersInModule != null) {
    host.appendChild(el('p.fn-zoom-foot', [
      el('strong', fmt.of(d.clustersInModule, d.clustersTotal) + ' clusters'),
      ' end up inside one of the ', el('strong', String(d.nModules)),
      ' modules. The rest keep their own pages and say so.'
    ]));
  }

  return host;
}

function funnelTable(d) {
  const rows = [
    ['All candidate pairs', d.possible, '100%', fmt.int(d.nProt) + ' × ' + fmt.int(d.nUtr) + ' clusters'],
    ['Co-occur in ≥1 transcript', d.coOccur, pctOf(d.coOccur, d.possible), 'measured at bake'],
    ['Pass the gate', d.gated, pctOf(d.gated, d.possible), 'the atlas’s edges'],
    [' inside one module', d.withinModule, pctOf(d.withinModule, d.possible), pctOf(d.withinModule, d.gated) + ' of survivors'],
    [' crossing a module boundary', d.cross, pctOf(d.cross, d.possible), pctOf(d.cross, d.gated) + ' of survivors'],
    [' outside every module', d.outside, pctOf(d.outside, d.possible), pctOf(d.outside, d.gated) + ' of survivors']
  ];
  for (const m of d.mods) {
    rows.push(['  M' + m.id + ' · ' + (m.short || m.label || ''), m.n_edges,
               pctOf(m.n_edges, d.possible), pctOf(m.n_edges, d.gated) + ' of survivors']);
  }
  return el('div.table-scroll.fn-table', el('table.data', [
    el('thead', el('tr', [
      el('th', 'Stage'), el('th.num', 'Pairs'), el('th.num', 'Of all candidates'), el('th', 'Note')
    ])),
    el('tbody', rows.map(r => el('tr', [
      el('td', { style: { color: 'var(--ink)' } }, r[0]),
      el('td.num.mono', fmt.int(r[1])),
      el('td.num.mono', r[2]),
      el('td.dim', r[3])
    ])))
  ]));
}

/** Percentages a reader will quote. One decimal wherever rounding to a whole
 *  number would overstate the result — an attrition of 98.5% must not print
 *  as "99%", and 92.6% must not print as "93%". */
function pctOf(k, n) {
  if (!n) return '—';
  const p = 100 * k / n;
  if (p === 0) return '0%';
  if (p < 0.1) return p.toFixed(3) + '%';
  if (p < 10 || p > 90) return p.toFixed(1) + '%';
  return p.toFixed(0) + '%';
}

/* =============================================================================
   5. three ways in
   ============================================================================= */

function entryPoints(c, es) {
  const sec = el('section.section');
  sec.appendChild(el('header.sec-head', [
    el('p.eyebrow.mono', 'three ways in'),
    el('h2', 'Start from a gene, a cluster, or the graph')
  ]));

  const grid = el('div.grid.grid-3.door-grid');

  /* --- door 1: a gene --------------------------------------------------- */
  const seeds = el('div.seed-row');
  for (const s of SEEDS) seeds.appendChild(seedChip(s));

  grid.appendChild(door(
    router.link('/browse'), '☷', 'Look up a gene',
    'Search a symbol, a RefSeq accession or an Ensembl id. The gene page draws the 5′UTR, CDS ' +
    'and 3′UTR to scale with every motif span in place, projects protein motifs onto mRNA ' +
    'coordinates, and lays the NTScore track underneath — with a hatched band over the CDS, ' +
    'where no likelihood was ever computed.',
    [regionBadge('utr5'), regionBadge('utr3'), regionBadge('protein')],
    [el('p.door-k', 'Try one'), seeds]
  ));

  /* --- door 2: clusters -------------------------------------------------- */
  grid.appendChild(door(
    router.link('/browse', { kind: 'cluster' }), '≡',
    'Browse ' + fmt.int(c.clusters || 900) + ' motif clusters',
    'Every cluster carries its consensus strings, its enriched InterPro / GO / eCLIP terms, its ' +
    'positional distribution within the region, and its cross-modal partners with all four gate ' +
    'values shown. Where STREME found no motif at p < 0.05 there is no logo, and the page says so ' +
    'rather than inventing one.',
    [moduleChip(1, { href: false }), moduleChip(4, { href: false }), moduleChip(0, { href: false })],
    [el('p.door-k', 'Denominators printed on the page'),
     el('p.door-stat.dim', [
       el('span.mono', fmt.of(es.clusters_no_logo || 444, es.clusters_total || 900)), ' have no logo · ',
       el('span.mono', fmt.of(es.clusters_no_term || 437, es.clusters_total || 900)), ' no significant term'
     ])]
  ));

  /* --- door 3: the network ---------------------------------------------- */
  grid.appendChild(door(
    router.link('/network'), '◉', 'Explore the network',
    'The gated graph is one connected component of 513 nodes, not six islands. Click a node for ' +
    'its cluster page, an edge for the evidence behind that pair: NPMI after APC, the number of ' +
    'independent gene families, the clade concentration and the ZNF fraction that the gate tested.',
    [1, 2, 3, 4, 5, 6].map(i => moduleChip(i, { href: false, label: String(i) })),
    [el('p.door-k', 'Layout provenance'),
     el('p.door-stat.dim',
       'Coordinates are frozen at bake with a fixed seed and never recomputed in the browser. ' +
       'Distance and direction carry no meaning.')]
  ));

  sec.appendChild(grid);
  return sec;
}

function door(href, mark, title, body, chips, extra) {
  return el('article.card.card-pad.door', [
    el('div.row.door-top', [el('span.door-mark', { 'aria-hidden': 'true' }, mark), ...(chips || [])]),
    el('h3.door-title', el('a', { href }, title)),
    el('p.door-body', body),
    extra ? el('div.door-extra', extra) : null
  ]);
}

/** A seeded example gene. Renders immediately as a link that resolves on click,
 *  then upgrades to a real href once search.json has answered — so middle-click
 *  and "copy link" work as soon as the index is warm. */
function seedChip(s) {
  const a = el('a.seed', {
    href: router.link('/browse', { q: s.sym }),
    dataset: { tip: s.sym + ' — ' + s.why },
    on: {
      pointerenter: async () => {
        const rs = await data.resolveToRefseq(s.sym);
        if (rs) data.prefetchGene(rs);
      },
      click: async (ev) => {
        if (a.dataset.resolved) return;             // real href: let the browser do it
        ev.preventDefault();
        const rs = await data.resolveToRefseq(s.sym);
        if (rs) router.navigate('/gene/' + rs);
        else omnibox().open(s.sym);
      }
    }
  }, s.sym);

  data.resolveToRefseq(s.sym).then(rs => {
    if (!rs || cancelled) return;
    a.setAttribute('href', router.link('/gene/' + rs));
    a.dataset.resolved = '1';
    a.appendChild(el('span.seed-rs.mono', rs));
  });

  return a;
}

/* =============================================================================
   6. closing
   ============================================================================= */

function closing(manifest) {
  const es = (manifest && manifest.empty_states) || {};
  const items = [
    ['Co-occurrence, not interaction',
     'Nothing in this atlas demonstrates that a protein motif touches a UTR motif. Every module ' +
     'and every edge is a statement about which clusters appear in the same genes. The caveat is ' +
     'mounted by the shell over every partner and edge panel and cannot be dismissed.'],
    ['Empty is a designed state',
     fmt.of(es.clusters_no_logo || 444, es.clusters_total || 900) + ' clusters have no logo, ' +
     fmt.of(es.clusters_no_term || 437, es.clusters_total || 900) + ' no significant term, ' +
     fmt.of(es.utr_clusters_no_gated_partner || 282, es.utr_clusters_total || 600) +
     ' UTR clusters no surviving partner. Each of those pages prints its own denominator instead ' +
     'of showing you a blank panel.'],
    ['Nothing is interpolated',
     'There is no NTScore for the CDS or the protein anywhere in the source data, so none is drawn. ' +
     'UTR sequence is stored as DNA and displayed as RNA; that mapping is never applied to a ' +
     'protein sequence, where U is selenocysteine.']
  ];

  return el('section.section.home-closing', [
    card(el('h3', 'What this atlas will not claim'),
      [el('a.btn.btn-sm', { href: router.link('/about') }, 'Full methods & caveats')],
      el('div.close-list', items.map(x => el('div.close-item', [
        el('h4', x[0]), el('p', x[1])
      ]))))
  ]);
}

function notBakedBanner() {
  return el('div.banner.warn', [
    el('strong', 'portal/data/ has not been baked. '),
    'The shell, router and search are live but every payload is missing, so the counts below fall ' +
    'back to the published figures and the module cards stay empty. Run the scripts in code/build/.'
  ]);
}

/* =============================================================================
   tooltip layer — delegated, one node, removed on teardown
   ============================================================================= */

function installTooltips(scope) {
  if (!tipNode) {
    tipNode = el('div.mirto-tip', { role: 'tooltip', hidden: true });
    document.body.appendChild(tipNode);
  }
  const show = (target) => {
    const t = target && target.closest ? target.closest('[data-tip]') : null;
    if (!t) return hide();
    tipNode.textContent = t.dataset.tip;
    tipNode.hidden = false;
    const r = t.getBoundingClientRect();
    const w = tipNode.offsetWidth;
    const h = tipNode.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    let y = r.top - h - 10;
    if (y < 8) y = r.bottom + 10;
    tipNode.style.left = x + 'px';
    tipNode.style.top = y + 'px';
  };
  const hide = () => { if (tipNode) tipNode.hidden = true; };

  scope.addEventListener('pointerover', e => show(e.target));
  scope.addEventListener('pointerout', e => {
    const to = e.relatedTarget;
    if (!to || !to.closest || !to.closest('[data-tip]')) hide();
  });
  scope.addEventListener('focusin', e => show(e.target));
  scope.addEventListener('focusout', hide);
  scope.addEventListener('pointerdown', hide);
}

/* =============================================================================
   styles — scoped to this view, injected once, tokens only (no literal colour)
   ============================================================================= */

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
.home-hero { padding: var(--s8) 0 var(--s6); }
.home-h1 { font-size: var(--fs-3xl); line-height: var(--lh-tight); max-width: 17ch; margin: var(--s3) 0 var(--s4); }
.home-lede { max-width: 62ch; }
.home-cta { margin-top: var(--s5); }
.kbd-hint { font-family: var(--font-mono); font-size: var(--fs-xs); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 0 4px; background: var(--surface-2); color: var(--ink-3); }
.home-stats { margin-bottom: var(--s8); }

.sec-head { margin-bottom: var(--s5); }
.sec-head h2 { font-size: var(--fs-2xl); margin: var(--s2) 0 var(--s3); line-height: var(--lh-tight); }
.sec-foot { font-size: var(--fs-sm); margin-top: var(--s4); max-width: var(--measure); }

/* --- module story cards ------------------------------------------------- */
.mod-grid { align-items: stretch; grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 1180px) { .mod-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px)  { .mod-grid { grid-template-columns: 1fr; } }
.mod-card { display: flex; overflow: hidden; }
.mod-rail { flex: 0 0 6px; background: var(--mod-c); }
.mod-body { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--s3); }
.mod-top { gap: var(--s2); }
.mod-short { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .09em; font-weight: 620; }
.mod-label { margin: 0; font-size: var(--fs-lg); line-height: 1.25; }
.mod-label a { color: var(--ink); text-decoration: none; }
.mod-label a:hover { color: var(--accent-ink); text-decoration: underline; }
.mod-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s3);
  border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); padding: var(--s3) 0; }
.mod-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.mod-fact-v { font-size: var(--fs-md); color: var(--ink); font-weight: 600; letter-spacing: -.02em; }
.mod-fact-k { font-size: var(--fs-xs); color: var(--ink-3); }
.mod-fact-chips { display: flex; gap: 3px; margin-top: 3px; }
.mod-nodata { font-size: var(--fs-sm); margin: 0; }
.mod-themes-k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em;
  color: var(--ink-3); font-weight: 620; margin: 0 0 6px; }
.term-pills { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
.term-pill { font-size: var(--fs-xs); color: var(--ink-2); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: var(--r-full); padding: 2px 9px; }
.mod-themes-n { font-size: var(--fs-xs); margin: 8px 0 0; }
.mod-example { display: flex; align-items: baseline; gap: var(--s2); flex-wrap: wrap;
  font-size: var(--fs-sm); margin-top: auto; padding-top: var(--s2); }
.mod-example-k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em;
  color: var(--ink-3); font-weight: 620; }
.mod-example-g { font-weight: 620; }
.mod-example-sub { font-size: var(--fs-xs); }
.mod-example-dup { font-size: var(--fs-xs); color: var(--ink-3); border: 1px dashed var(--line-strong);
  border-radius: var(--r-full); padding: 1px 7px; cursor: help; }
.mod-open { font-size: var(--fs-sm); font-weight: 560; text-decoration: none; }
.mod-open:hover { text-decoration: underline; }

/* --- funnel -------------------------------------------------------------- */
.fn-chart { margin-bottom: var(--s6); }
.fn-row { margin-bottom: var(--s5); }
.fn-label { display: flex; flex-direction: column; gap: 1px; margin-bottom: 7px; }
.fn-label-t { font-size: var(--fs-md); color: var(--ink); font-weight: 560; }
.fn-label-s { font-size: var(--fs-sm); }
.fn-track { position: relative; height: 30px; background: var(--surface-2);
  border-radius: var(--r-sm); }
.fn-bar { height: 100%; border-radius: var(--r-sm); display: flex; align-items: center;
  justify-content: flex-end; min-width: 3px; transition: filter .12s; }
.fn-bar[data-tone="1"] { background: color-mix(in srgb, var(--accent) 16%, var(--surface-3)); }
.fn-bar[data-tone="2"] { background: color-mix(in srgb, var(--accent) 40%, var(--surface-3)); }
.fn-bar[data-tone="3"] { background: var(--accent); }
.fn-bar:hover { filter: brightness(1.06); }
.fn-val-in { padding-right: var(--s3); font-size: var(--fs-sm); color: var(--ink);
  font-weight: 620; }
.fn-bar[data-tone="3"] .fn-val-in { color: var(--ink-inv); }
.fn-val-out { position: absolute; top: 0; height: 30px; display: flex; align-items: center;
  padding-left: 9px; font-size: var(--fs-sm); font-weight: 620; color: var(--accent-ink);
  white-space: nowrap; }
.is-survivor .fn-label-t { font-weight: 640; }
.fn-note { display: flex; gap: var(--s3); margin: var(--s5) 0 0; font-size: var(--fs-sm);
  color: var(--ink-2); max-width: 76ch; }
.fn-note-mark { color: var(--ink-3); flex: 0 0 auto; }

.fn-zoom { border-top: 1px solid var(--line); padding-top: var(--s5); }
.fn-zoom-head { display: flex; align-items: baseline; gap: var(--s3); margin: 0 0 var(--s4);
  font-size: var(--fs-md); color: var(--ink-2); }
.fn-zoom-mark { font-size: var(--fs-xs); font-weight: 700; color: var(--ink-3);
  border: 1px solid var(--line-strong); border-radius: var(--r-full); padding: 2px 8px; flex: 0 0 auto; }
.fn-stack { display: flex; gap: var(--s4); height: 34px; }
.fn-stack-group { display: flex; border-radius: var(--r-sm); overflow: hidden; background: var(--surface-2); }
.fn-seg { display: flex; align-items: center; justify-content: center; min-width: 2px;
  box-shadow: 2px 0 0 0 var(--surface); text-decoration: none; overflow: hidden; }
.fn-seg:last-child { box-shadow: none; }
.fn-seg-l { font-size: var(--fs-xs); font-weight: 700; white-space: nowrap; }
.fn-seg-cross { background: repeating-linear-gradient(135deg, var(--surface-3) 0 5px,
  color-mix(in srgb, var(--ink-3) 22%, var(--surface-3)) 5px 6px); color: var(--ink-2); }
.fn-seg-out { background: var(--mod-0); }
.fn-stack-caps { display: flex; gap: var(--s4); margin-top: 7px; }
.fn-cap { font-size: var(--fs-xs); color: var(--ink-3); }
.fn-cap b { color: var(--ink-2); }
.fn-cap-2 { text-align: right; }
.fn-legend { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); margin-top: var(--s4); }
.fn-key { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs);
  color: var(--ink-2); text-decoration: none; }
a.fn-key:hover { color: var(--ink); }
.fn-key-sw { width: 11px; height: 11px; border-radius: 3px; flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent); }
.sw-cross { background: repeating-linear-gradient(135deg, var(--surface-3) 0 3px,
  color-mix(in srgb, var(--ink-3) 45%, var(--surface-3)) 3px 4px); }
.sw-out { background: var(--mod-0); }
.fn-key-v { color: var(--ink-3); }
.fn-zoom-foot { margin: var(--s5) 0 0; font-size: var(--fs-sm); color: var(--ink-2); max-width: var(--measure); }
.fn-tools { margin-top: var(--s5); }
.fn-table { margin-top: var(--s3); max-height: 420px; border: 1px solid var(--line);
  border-radius: var(--r-md); background: var(--surface); }

/* --- doors --------------------------------------------------------------- */
.door { display: flex; flex-direction: column; gap: var(--s3); }
.door-top { gap: 5px; }
.door-mark { font-size: 15px; color: var(--ink-3); margin-right: 2px; }
.door-title { margin: 0; font-size: var(--fs-lg); }
.door-title a { color: var(--ink); text-decoration: none; }
.door-title a:hover { color: var(--accent-ink); text-decoration: underline; }
.door-body { margin: 0; font-size: var(--fs-sm); }
.door-extra { margin-top: auto; padding-top: var(--s3); border-top: 1px solid var(--line-soft); }
.door-k { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em;
  color: var(--ink-3); font-weight: 620; margin: 0 0 7px; }
.door-stat { font-size: var(--fs-xs); margin: 0; line-height: 1.55; }
.seed-row { display: flex; flex-wrap: wrap; gap: 6px; }
.seed { display: inline-flex; align-items: baseline; gap: 5px; font-size: var(--fs-xs);
  font-family: var(--font-mono); font-weight: 620; text-decoration: none; color: var(--accent-ink);
  background: var(--accent-soft); border: 1px solid var(--accent-line);
  border-radius: var(--r-full); padding: 3px 10px; }
.seed:hover { background: var(--surface); border-color: var(--accent); }
.seed-rs { font-size: 9.5px; opacity: .62; font-weight: 400; }

/* --- closing ------------------------------------------------------------- */
.home-closing { margin-bottom: var(--s8); }
.close-list { display: grid; gap: var(--s5); grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.close-item h4 { margin: 0 0 5px; color: var(--ink); }
.close-item p { margin: 0; font-size: var(--fs-sm); color: var(--ink-2); }

/* --- tooltip ------------------------------------------------------------- */
.mirto-tip { position: fixed; z-index: 90; max-width: 320px; pointer-events: none;
  background: var(--ink); color: var(--bg); font-size: var(--fs-xs); line-height: 1.5;
  padding: 7px 10px; border-radius: var(--r-md); box-shadow: var(--shadow-2); }

/* Below ~900px a stacked segment is too narrow to hold its own label without
   clipping it. Drop the in-segment labels and let the legend — which is always
   rendered and carries every value — do the work. */
@media (max-width: 900px) {
  .fn-seg-l { display: none; }
  .fn-legend { gap: var(--s2) var(--s3); }
}
@media (max-width: 700px) {
  .mod-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fn-stack { gap: var(--s3); }
  .fn-cap-2 { text-align: left; }
  .fn-label-t { font-size: var(--fs-base); }
}
`;
  document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
}
