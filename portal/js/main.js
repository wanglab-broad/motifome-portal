/* =============================================================================
   main.js — boot the atlas.

   Responsibilities, and nothing else:
     1. mark the boot as live so the cold-start panel in index.html stands down
     2. load the manifest (degrading to a banner if portal/data/ is not baked)
     3. mount the chrome: top bar, nav, omnibox, theme toggle, caveat slot, footer
     4. register every route, lazily importing the view modules and surviving
        any that do not exist yet
     5. hand control to the router

   NO view logic lives here. The two exceptions are the home landing and the
   which is a chrome-level page the shell owns.
   ============================================================================= */

import * as router from './router.js';
import * as data from './data.js';
import {
  el, mount, clear, fmt, card, stat, skeleton, emptyState, omnibox,
  copyLinkButton, moduleChip, regionBadge, setTitle, scrollTop, DENOMINATORS
} from './ui.js';

if (window.__MIRTO_BOOT__) window.__MIRTO_BOOT__.booted = true;

/* =============================================================================
   view module registry
   -----------------------------------------------------------------------------
   Each view module must export:   render(container, params) -> void | Promise
   `container` is an empty <div> already inserted into #main.
   `params` = { ...routeParams, query, path, hash, route }
   A module may also export  title(params) -> string   and   teardown().
   ============================================================================= */

const VIEWS = {
  gene:    { path: './views/gene.js',    label: 'Gene view',
             blurb: 'sequence tracks, motif spans, NTScore, annotations' },
  cluster: { path: './views/cluster.js', label: 'Cluster view',
             blurb: 'consensus, logo, enriched terms, cross-modal partners' },
  network: { path: './views/network.js', label: 'Module network',
             blurb: '519 nodes, 2,620 gated edges, frozen build-time layout' },
  module:  { path: './views/module.js',  label: 'Module detail',
             blurb: 'GO terms, member clusters, carrier genes' },
  browse:  { path: './views/browse.js',  label: 'Browse',
             blurb: 'the full cluster and gene index, filterable' }
};

const loaded = new Map();      // name -> module | null (null = tried and failed)

async function loadView(name) {
  if (loaded.has(name)) return loaded.get(name);
  const spec = VIEWS[name];
  let mod = null;
  try {
    mod = await import(/* @vite-ignore */ spec.path);
    if (!mod || typeof mod.render !== 'function') {
      console.warn('[main] ' + spec.path + ' loaded but exports no render(container, params)');
      mod = null;
    }
  } catch (err) {
    console.warn('[main] view module not available: ' + spec.path, err && err.message);
    mod = null;
  }
  loaded.set(name, mod);
  return mod;
}

/** Wraps a view module in the shell's lifecycle: fresh container, skeleton while
 *  the module loads, placeholder if it is missing, crash card if it throws. */
let liveView = null;           // the module currently mounted, for teardown()

function viewHandler(name, fallbackName) {
  return async function (host, params) {
    const spec = VIEWS[name];
    const stage = el('div');
    mount(host, stage);
    stage.appendChild(skeleton({ rows: 5, label: 'Loading ' + spec.label }));

    let mod = await loadView(name);
    let used = name;
    if (!mod && fallbackName) { mod = await loadView(fallbackName); used = fallbackName; }

    if (!mod) { clear(stage); stage.appendChild(placeholderView(name, params)); return; }

    clear(stage);
    liveView = mod;
    try {
      const p = mod.render(stage, Object.assign({}, params, { view: name, servedBy: used }));
      if (p && typeof p.then === 'function') await p;
    } catch (err) {
      console.error('[main] ' + used + '.render() threw', err);
      clear(stage);
      stage.appendChild(el('div.wrap.view-pad', [
        emptyState({
          mark: '!', title: spec.label + ' failed to render',
          message: 'The view module loaded but threw while drawing. Everything else in the ' +
                   'atlas still works. The error is in the browser console.',
          denominator: err && err.message ? String(err.message).slice(0, 140) : 'unknown error'
        })
      ]));
    }
  };
}

/** Home and About are shell-owned routes, but their bodies live in their own
 *  modules (js/view-home.js) so they can be worked on without
 *  touching the shell. If a module is missing or throws on import, the shell's
 *  own inline version below still renders — the route is never dead. */
function shellPage(path, fallback) {
  return async function (host, params) {
    let mod = null;
    try {
      mod = await import(/* @vite-ignore */ path);
      if (!mod || typeof mod.render !== 'function') mod = null;
    } catch (err) {
      console.warn('[main] shell page module not available: ' + path, err && err.message);
    }
    if (!mod) return fallback(host, params);
    liveView = mod;
    try {
      const p = mod.render(host, params);
      if (p && typeof p.then === 'function') await p;
    } catch (err) {
      console.error('[main] ' + path + '.render() threw', err);
      liveView = null;
      clear(host);
      fallback(host, params);
    }
  };
}

function placeholderView(name, params) {
  const spec = VIEWS[name];
  return el('div.wrap.view-pad', [
    el('p.eyebrow.mono', 'view module not installed'),
    el('h1', spec.label),
    el('p.lede', spec.blurb + '.'),
    el('div', { style: { marginTop: 'var(--s5)' } }, [
      emptyState({
        mark: '◻',
        title: 'js/views/' + name + '.js has not been built yet',
        message: 'The application shell, router, data layer and design system are live — this ' +
                 'route resolves, its parameters parse, and its deep link is shareable. The view ' +
                 'module that draws it is still to come.',
        denominator: 'route ' + (params && params.path ? params.path : '') +
                     ' · expects render(container, params)'
      })
    ])
  ]);
}

/* =============================================================================
   chrome
   ============================================================================= */

const NAV = [
  { href: '#/', label: 'Home', match: p => p === '/' },
  { href: '#/browse', label: 'Browse',
    match: p => p.startsWith('/browse') || p.startsWith('/gene') || p.startsWith('/cluster') },
  { href: '#/network', label: 'Network', match: p => p.startsWith('/network') || p.startsWith('/module') }
];

let navLinks = [];

function mountChrome(manifest) {
  const topbar = document.getElementById('topbar');
  const footer = document.getElementById('footer');

  /* --- top bar --------------------------------------------------------- */
  const nav = el('nav.nav', { 'aria-label': 'Main' });
  navLinks = NAV.map(item => {
    const a = el('a', { href: item.href }, item.label);
    a.__match = item.match;
    nav.appendChild(a);
    return a;
  });

  const omni = omnibox();
  document.body.appendChild(omni.node);

  const trigger = el('button.omni-trigger', {
    type: 'button', 'aria-label': 'Search the atlas',
    on: { click: () => omni.open() }
  }, [
    el('span', { 'aria-hidden': 'true' }, '⌕'),
    el('span.omni-trigger-label', 'Search genes, clusters…'),
    el('kbd.kbd-hint', isMac() ? '⌘K' : 'Ctrl K')
  ]);

  const navToggle = el('button.icon-btn.nav-toggle', {
    type: 'button', 'aria-label': 'Menu', 'aria-expanded': 'false',
    on: { click: () => {
      const open = nav.classList.toggle('mobile-open');
      navToggle.setAttribute('aria-expanded', String(open));
    } }
  }, '☰');

  mount(topbar, el('div.topbar-in', [
    el('a.brand', { href: '#/' }, [
      el('span.brand-mark', { 'aria-hidden': 'true' }),
      el('span.brand-name', [document.createTextNode('MIRTO '), el('em', 'Atlas')])
    ]),
    nav,
    el('div.topbar-spacer'),
    trigger,
    themeToggle(),
    navToggle
  ]));

  /* --- caveat slot (filled per route) ---------------------------------- */

  /* --- footer ----------------------------------------------------------- */
  const c = (manifest && manifest.counts) || {};
  const built = (manifest && manifest.built) || 'not built';
  const asserts = manifest && manifest.assertions_passed != null ? manifest.assertions_passed : null;
  // Print the DENOMINATOR. The manifest currently reports 10 of 11 — one assertion
  // is recorded as failed rather than weakened — and "10 build assertions passed"
  // read as if all of them had.
  const assertsN = manifest && manifest.assertions_total != null ? manifest.assertions_total : null;
  const assertLabel = asserts == null ? null
    : (assertsN != null ? asserts + ' of ' + assertsN + ' build assertions passed'
                        : asserts + ' build assertions passed');
  mount(footer, el('div.footer-in', [
    el('span.mono', 'MIRTO Atlas'),
    el('span.sep', '·'),
    el('span.mono', 'snapshot built ' + built),
    el('span.sep', '·'),
    el('span.mono', 'human GRCh37'),
    el('span.sep', '·'),
    el('span.mono', c.motifs ? fmt.int(c.motifs) + ' motif instances' : 'data not baked'),
    asserts != null ? el('span.sep', '·') : null,
    asserts != null ? el('span.mono', assertLabel) : null,
    el('span.topbar-spacer')
  ]));

  /* --- keep chrome in sync with the route ------------------------------ */
  router.onRoute(st => {
    for (const a of navLinks) {
      if (a.__match && a.__match(st.path)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    nav.classList.remove('mobile-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
}

function isMac() {
  return /Mac|iPhone|iPad/.test((navigator.platform || '') + (navigator.userAgent || ''));
}

/* --- theme: system -> light -> dark -> system ---------------------------- */
function themeToggle() {
  const order = ['system', 'light', 'dark'];
  const glyph = { system: '◐', light: '☀', dark: '☾' };
  let cur = 'system';
  try { const s = localStorage.getItem('mirto.theme'); if (s && order.includes(s)) cur = s; } catch (e) {}

  const btn = el('button.icon-btn', { type: 'button', on: { click: () => {
    cur = order[(order.indexOf(cur) + 1) % order.length];
    apply();
  } } });

  function apply() {
    if (cur === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem('mirto.theme', cur); } catch (e) {}
    btn.textContent = glyph[cur];
    btn.title = 'Theme: ' + cur + ' (click to cycle)';
    btn.setAttribute('aria-label', 'Theme: ' + cur);
  }
  apply();
  return btn;
}

/* =============================================================================
   home  (shell-owned)
   ============================================================================= */

function renderHome(host, params) {
  setTitle(null);
  const m = state.manifest;
  const c = (m && m.counts) || {};

  const hero = el('header', { style: { padding: 'var(--s8) 0 var(--s6)' } }, [
    el('p.eyebrow.mono', 'protein-conditioned masked diffusion · human transcriptome'),
    el('h1', { style: { fontSize: 'var(--fs-3xl)', maxWidth: '20ch' } },
      'Where a protein motif and an untranslated motif keep company.'),
    el('p.lede', [
      'MIRTO reads a full-length mRNA conditioned on the protein it encodes. Its attention and ' +
      'per-nucleotide likelihood localise motifs in 5′UTR, 3′UTR and protein sequence. This atlas is ' +
      'the raw material behind those figures: every instance, every cluster, every gated association — ',
      el('strong', 'and every place the evidence runs out'), '.'
    ]),
    el('div.row', { style: { marginTop: 'var(--s5)' } }, [
      el('a.btn.btn-primary', { href: '#/network' }, 'Open the module network'),
      el('button.btn', { type: 'button', on: { click: () => omnibox().open() } },
        ['Find a gene ', el('kbd.kbd-hint', isMac() ? '⌘K' : 'Ctrl K')]),
      el('a.btn.btn-ghost', { href: '#/browse' }, 'Browse all 900 clusters')
    ])
  ]);

  const stats = el('div.grid.grid-4', { style: { marginBottom: 'var(--s7)' } }, [
    stat('Motif instances', fmt.int(c.motifs || 889215), 'across three regions'),
    stat('Transcripts', fmt.int(c.transcripts || 18093), fmt.int(c.genes || 17847) + ' gene symbols'),
    stat('Embedding clusters', fmt.int(c.clusters || 900), '300 protein · 500 3′UTR · 100 5′UTR'),
    stat('Gated associations', fmt.int(c.edges || 2620),
         fmt.int(c.cross_module_edges || 757) + ' cross module boundaries')
  ]);

  const doors = el('div.grid.grid-3', [
    doorCard('#/browse', 'Read a gene',
      'Search a symbol, RefSeq or Ensembl id. See the 5′UTR, CDS and 3′UTR with every motif span ' +
      'drawn in place, the protein motifs projected onto mRNA coordinates, and the NTScore track ' +
      'underneath — with an honest hatched band where no score exists.',
      [regionBadge('utr5'), regionBadge('utr3'), regionBadge('protein')]),
    doorCard('#/browse?kind=cluster', 'Open a cluster',
      'Each of the 900 clusters carries its consensus strings, its STREME logo where one is ' +
      'defensible, its enriched InterPro / GO / RBP terms, and its cross-modal partners. ' +
      '444 clusters have no logo and say so.',
      [moduleChip(5, { href: false }), moduleChip(6, { href: false }), moduleChip(0, { href: false })]),
    doorCard('#/network', 'Explore the modules',
      '519 nodes and 2,620 gated edges in one connected graph — not six tidy islands. ' +
      '757 edges cross a module boundary. Click a node for its cluster, an edge for the ' +
      'evidence behind the pair.',
      [1, 2, 3, 4, 5, 6].map(i => moduleChip(i, { href: false })))
  ]);

  const honesty = card(el('h3', 'What this atlas will not claim'), null, [
    el('ul', { style: { margin: 0, paddingLeft: '1.15em', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' } }, [
      el('li', { style: { marginBottom: '8px' } },
        'Module membership is statistical co-occurrence across genes. It is not demonstrated ' +
        'physical interaction, and the caveat sits over every partner and edge panel rather than ' +
        'in a footnote.'),
      el('li', { style: { marginBottom: '8px' } },
        'The raw NPMI leaderboard is not offered as a sort key anywhere: 25 of its top 30 ' +
        'associations are ZNF clade artifacts by the authors’ own verdict.'),
      el('li', { style: { marginBottom: '8px' } },
        fmt.of(DENOMINATORS.noModule.k, DENOMINATORS.noModule.n) + ' clusters have no module; ' +
        fmt.of(DENOMINATORS.noTerm.k, DENOMINATORS.noTerm.n) + ' have no significant term; ' +
        fmt.of(DENOMINATORS.noLogo.k, DENOMINATORS.noLogo.n) + ' have no logo. Each is a designed ' +
        'empty state with its denominator printed, never a blank panel.'),
      el('li', 'There is no CDS or protein likelihood track anywhere in the source data, so the ' +
        'viewer draws a hatched “not computed” band instead of inventing one.')
    ])
  ]);

  const body = el('div.wrap', [hero, stats, doors,
    el('div', { style: { marginTop: 'var(--s7)', maxWidth: '760px' } }, honesty)]);

  mount(host, body);
  if (!state.manifest) host.appendChild(dataMissingBanner());
}

function doorCard(href, title, body, chips) {
  return el('a.card.card-pad', {
    href, style: { textDecoration: 'none', display: 'block', color: 'inherit' }
  }, [
    el('div.row', { style: { marginBottom: 'var(--s3)' } }, chips || []),
    el('h3', { style: { marginBottom: 'var(--s2)' } }, title),
    el('p', { style: { margin: 0, fontSize: 'var(--fs-sm)' } }, body)
  ]);
}

/* =============================================================================
   about  (shell-owned)
   ============================================================================= */

/* =============================================================================
   not found
   ============================================================================= */

function renderNotFound(host, params) {
  setTitle('Not found');
  mount(host, el('div.wrap.view-pad', [
    el('p.eyebrow.mono', 'unresolved route'),
    el('h1', 'No such page'),
    emptyState({
      mark: '⌗',
      title: 'Nothing is registered at ' + ((params && params.path) || location.hash),
      message: 'The atlas has seven routes: home, a gene, a cluster, the network (optionally scoped ' +
               'to a module), a module and browse. If you followed a link from a colleague, ' +
               'the id in it may not exist in this snapshot.',
      denominator: 'try ⌘K to search ' + fmt.int(18093) + ' transcripts and ' + fmt.int(900) + ' clusters',
      action: el('a.btn.btn-primary', { href: '#/' }, 'Back to the atlas')
    })
  ]));
}

function dataMissingBanner() {
  return el('div.wrap', el('div.banner.warn', [
    el('strong', 'portal/data/ has not been baked yet. '),
    'The shell, router, theme and search are live, but every payload is missing, so views will show ' +
    'their empty states. Run the bake scripts in code/build/ to populate it.'
  ]));
}

/* =============================================================================
   boot
   ============================================================================= */

const state = { manifest: null };

async function boot() {
  const main = document.getElementById('main');

  try {
    state.manifest = await data.getManifest();
  } catch (e) {
    console.error('[main] manifest load threw (it should not)', e);
    state.manifest = null;
  }

  mountChrome(state.manifest);

  /* --- routes ----------------------------------------------------------- */
  router.register('/', shellPage('./view-home.js', renderHome));
  router.register('/gene/:refseq', viewHandler('gene'));
  router.register('/cluster/:id', viewHandler('cluster'));
  router.register('/network', viewHandler('network'));
  router.register('/network/:module', viewHandler('network'));
  router.register('/module/:n', viewHandler('module', 'network'));
  router.register('/browse', viewHandler('browse'));

  router.setNotFound(renderNotFound);

  let lastPath = null;
  router.start({
    container: main,
    before: (st) => {
      // every route change tears the previous view down before the next mounts
      if (liveView && typeof liveView.teardown === 'function') {
        try { liveView.teardown(); } catch (e) { console.error('[main] teardown() threw', e); }
      }
      liveView = null;
      // a filter change keeps scroll; a genuine move resets it
      if (st.path !== lastPath) { scrollTop(); lastPath = st.path; }
      main.setAttribute('data-route', st.path);
    }
  });

  // expose a tiny console handle for debugging a live deploy
  window.MIRTO = { router, data, manifest: () => state.manifest, cache: data.cacheStats };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
