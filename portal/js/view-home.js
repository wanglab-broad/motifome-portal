/* =============================================================================
   view-home.js — the front door.

   The six modules ARE the landing page. The title, then the modules — a reader
   who leaves this page having learned only that has learned the right thing.

   Everything numeric on this page is read live from portal/data/manifest.json
   and portal/data/network.json.

   API:  render(container, params)   teardown()
   ============================================================================= */

import * as router from './router.js';
import * as data from './data.js';
import {
  el, mount, clear, fmt, moduleChip, moduleLabel,
  setTitle, omnibox
} from './ui.js';

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


  /* --- 1. hero ---------------------------------------------------------- */
  wrap.appendChild(hero());

  /* --- 2. the six modules: the front door ------------------------------- */
  const modSection = el('section.section#modules');
  wrap.appendChild(modSection);
  const cardHosts = mountModuleSection(modSection);

  if (!manifest) wrap.insertBefore(notBakedBanner(), wrap.firstChild.nextSibling);

  installTooltips(wrap);

  /* --- async: the network payload fills the module cards ---------------- */
  const net = await data.getNetwork();
  if (cancelled) return;

  fillModuleCards(cardHosts, net);

  /* --- idle: one named carrier gene per module, from modules/<n>.json ---- */
  scheduleIdle(() => fillExampleGenes(cardHosts, net));
}

/* =============================================================================
   1. hero — the title and the two ways in
   ============================================================================= */

function hero() {
  const h = el('header.home-hero');

  h.appendChild(el('h1.home-h1', 'MIRTO Human Motifome'));

  h.appendChild(el('div.row.home-cta', [
    el('a.btn.btn-primary', { href: router.link('/network') }, 'Explore the module network'),
    el('button.btn', {
      type: 'button', on: { click: () => omnibox().open() }
    }, ['Look up a gene ', el('kbd.kbd-hint', isMac() ? '⌘K' : 'Ctrl K')])
  ]));

  return h;
}

function isMac() {
  return /Mac|iPhone|iPad/.test((navigator.platform || '') + (navigator.userAgent || ''));
}

/* =============================================================================
   2. the six module story cards
   ============================================================================= */

function mountModuleSection(section) {
  section.appendChild(el('header.sec-head', [
    el('h2', 'Six modules'),
    el('p.lede',
      'Each module is a bipartite community of protein motif clusters and UTR motif clusters that ' +
      'co-occur across genes more than the background allows. Modules are named after the GO terms ' +
      'enriched in their carrier genes')
  ]));

  const grid = el('div.grid.grid-2.mod-grid');
  section.appendChild(grid);

  const hosts = {};
  for (let n = 1; n <= 6; n++) {
    const host = moduleCardShell(n);
    hosts[n] = host;
    grid.appendChild(host.node);
  }

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

function notBakedBanner() {
  return el('div.banner.warn', [
    el('strong', 'portal/data/ has not been baked. '),
    'The shell, router and search are live but every payload is missing, so the module cards ' +
    'stay empty. Run the scripts in code/build/.'
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
.home-h1 { font-size: clamp(1.75rem, 5.2vw, var(--fs-3xl)); line-height: var(--lh-tight);
  white-space: nowrap; margin: 0 0 var(--s4); }
.home-cta { margin-top: var(--s5); }
/* SCOPED to .home-cta on purpose. Unscoped, this rule is injected after app.css
   and so re-styled the shell's own ⌘K hint in the top bar for the rest of the
   session — the chrome changed shape depending on whether you had been to Home.
   app.css owns the bare "kbd, .kbd-hint" rule; this is the home hero's variant. */
.home-cta .kbd-hint { font-family: var(--font-mono); font-size: var(--fs-xs);
  border: 1px solid var(--line); border-bottom-width: 1px;
  border-radius: var(--r-sm); padding: 0 4px; background: var(--surface-2); color: var(--ink-3); }

.sec-head { margin-bottom: var(--s5); }
.sec-head h2 { font-size: var(--fs-2xl); margin: var(--s2) 0 var(--s3); line-height: var(--lh-tight); }

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

/* --- tooltip ------------------------------------------------------------- */
.mirto-tip { position: fixed; z-index: 90; max-width: 320px; pointer-events: none;
  background: var(--ink); color: var(--bg); font-size: var(--fs-xs); line-height: 1.5;
  padding: 7px 10px; border-radius: var(--r-md); box-shadow: var(--shadow-2); }

@media (max-width: 700px) {
  .mod-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`;
  document.head.appendChild(el('style', { id: STYLE_ID, text: css }));
}
