/* =============================================================================
   r2-ui.js — the vocabulary shared by the cluster view and the cluster browser.

   Everything general lives in ui.js; this file holds only what those two views
   both need and nothing else does: the gate meters, the quantile strip with its
   ghost corpus outline, the position histogram, the percentile bar, the name-tier
   badge, and the loader for the 900-row cluster index.

   No hex value appears below: every colour is a token from app.css.
   ============================================================================= */

import { el, fmt, moduleChip, regionBadge } from './ui.js';
import * as router from './router.js';
import { getClusterIndex as fetchClusterIndex } from './data.js';

/* =============================================================================
   style injection — R2 owns no CSS file, so its classes are injected once
   ============================================================================= */

/** A significance number that never rounds itself away: ui.fmt.sci(0.0027, 1)
 *  prints "0.0", which is wrong for an E-value. Two significant digits, with an
 *  exponent once the value leaves the readable range. */
export function sig(v, digits) {
  if (v == null || !Number.isFinite(+v)) return '—';
  const x = +v;
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a < 1e-3 || a >= 1e5) return x.toExponential(digits == null ? 1 : digits);
  return String(Number(x.toPrecision(digits == null ? 2 : digits + 1)));
}

export function ensureStyle(id, css) {
  if (document.getElementById(id)) return;
  document.head.appendChild(el('style', { id, text: css }));
}

const R2_CSS = `
/* layout ------------------------------------------------------------------ */
.r2-layout { display: grid; grid-template-columns: 380px minmax(0, 1fr);
             gap: var(--s5); align-items: start; }
.r2-rail { position: sticky; top: calc(var(--topbar-h) + var(--s3));
           max-height: calc(100vh - var(--topbar-h) - var(--s5));
           overflow-y: auto; overflow-x: hidden; padding-right: 2px;
           scrollbar-width: thin; }
.r2-rail > * + * { margin-top: var(--s4); }
@media (max-width: 1080px) {
  .r2-layout { grid-template-columns: minmax(0, 1fr); }
  .r2-rail { position: static; max-height: none; overflow: visible; }
}
.r2-head { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: flex-end;
           margin-bottom: var(--s3); }
.r2-head h1 { margin: 0; font-size: var(--fs-2xl); letter-spacing: -.015em; }
.r2-id { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink-3);
         letter-spacing: .04em; }
.r2-chips { display: flex; flex-wrap: wrap; gap: var(--s2); align-items: center; }
.r2-sub { color: var(--ink-2); font-size: var(--fs-sm); margin: var(--s2) 0 0; }
.r2-panelhead { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
                margin-bottom: var(--s3); }
.r2-panelhead h3 { margin: 0; font-size: var(--fs-md); }
.r2-note { font-size: var(--fs-xs); color: var(--ink-3); line-height: 1.5; }
.r2-note b { color: var(--ink-2); font-weight: 600; }
.rail-card { border: 1px solid var(--line); border-radius: var(--r-lg);
             background: var(--surface); padding: var(--s4); }
.rail-card h4 { margin: 0 0 var(--s3); font-size: var(--fs-xs); text-transform: uppercase;
                letter-spacing: .09em; color: var(--ink-3); font-weight: 620; }
.rail-card + .rail-card { margin-top: var(--s4); }

/* from-breadcrumb --------------------------------------------------------- */
.r2-from { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-sm);
           color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line);
           border-radius: var(--r-full); padding: 3px 6px 3px 12px; width: fit-content;
           margin-bottom: var(--s3); }
.r2-from button { border: 0; background: transparent; color: var(--ink-3); cursor: pointer;
                  border-radius: 50%; width: 20px; height: 20px; line-height: 1; }
.r2-from button:hover { background: var(--surface-3); color: var(--ink); }

/* tabs -------------------------------------------------------------------- */
.r2-tabs { display: flex; gap: var(--s1); border-bottom: 1px solid var(--line);
           margin-bottom: var(--s4); overflow-x: auto; }
.r2-tab { border: 0; background: transparent; cursor: pointer; padding: var(--s3) var(--s4);
          font-size: var(--fs-sm); font-weight: 580; color: var(--ink-3);
          border-bottom: 2px solid transparent; white-space: nowrap; text-decoration: none; }
.r2-tab:hover { color: var(--ink); }
.r2-tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.r2-tab .cnt { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3);
               margin-left: 5px; }
.r2-tab[aria-selected="true"] .cnt { color: var(--accent-ink); }

/* gate meters ------------------------------------------------------------- */
.gate-legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
               gap: var(--s2) var(--s4); font-size: var(--fs-xs); color: var(--ink-3);
               border: 1px solid var(--line); border-radius: var(--r-md);
               background: var(--surface-2); padding: var(--s3) var(--s4); margin-bottom: var(--s3); }
.gate-legend b { color: var(--ink-2); font-weight: 620; font-family: var(--font-mono); }
.gate-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
              gap: var(--s2); }
.gate { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 5px 7px 6px;
        background: var(--surface-2); }
.gate.pass { border-color: color-mix(in srgb, var(--good) 42%, var(--line)); }
.gate.fail { border-color: color-mix(in srgb, var(--bad) 34%, var(--line)); }
.gate.diag { border-style: dashed; }
.gate-k { display: flex; justify-content: space-between; align-items: baseline; gap: 6px;
          font-size: var(--fs-xs); color: var(--ink-3); }
.gate-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
          font-size: var(--fs-sm); color: var(--ink); font-weight: 620; }
.gate.fail .gate-v { color: var(--bad); }
.gate.pass .gate-v { color: var(--good); }
.gate-track { position: relative; height: 5px; margin-top: 4px; border-radius: 3px;
              background: var(--surface-3); overflow: visible; }
.gate-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
             background: var(--ink-3); }
.gate.pass .gate-fill { background: var(--good); }
.gate.fail .gate-fill { background: var(--bad); }
.gate-thr { position: absolute; top: -3px; bottom: -3px; width: 1.5px; background: var(--ink); opacity: .55; }
.gate-thrlab { font-size: 9px; color: var(--ink-3); font-family: var(--font-mono); margin-top: 3px;
               display: block; }

/* partner rows ------------------------------------------------------------ */
.p-row { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface);
         padding: var(--s3) var(--s4); }
.p-row + .p-row { margin-top: var(--s2); }
.p-row.is-fail { background: var(--surface-2); }
.p-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin-top: var(--s3); }
.p-id { font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 620;
        color: var(--ink); text-decoration: none; }
.p-id:hover { color: var(--accent-ink); text-decoration: underline; }
.p-name { color: var(--ink-2); font-size: var(--fs-sm); }
.p-score { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
           font-size: var(--fs-sm); color: var(--ink); }
.p-score span { color: var(--ink-3); font-size: var(--fs-xs); }
.p-cons { margin-top: var(--s3); border-top: 1px dashed var(--line); padding-top: var(--s2);
          display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); font-size: var(--fs-xs);
          color: var(--ink-3); }
.p-cons .pair { font-family: var(--font-mono); color: var(--ink-2); }
.p-cons .pair i { color: var(--ink-3); font-style: normal; padding: 0 4px; }
.p-verdict { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-xs);
             font-weight: 620; letter-spacing: .03em; text-transform: uppercase; }
.p-verdict.ok { color: var(--good); }
.p-verdict.no { color: var(--ink-3); }

/* quantile strip ---------------------------------------------------------- */
.qbox { width: 100%; height: 34px; display: block; overflow: visible; }
.qbox .ghost { fill: none; stroke: var(--ink-3); stroke-dasharray: 2 2; opacity: .75; }
.qbox .whisk { stroke: var(--line-strong); stroke-width: 1; }
.qbox .box { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1; }
.qbox .med { stroke: var(--accent-ink); stroke-width: 2; }
.qbox text { font-family: var(--font-mono); font-size: 9px; fill: var(--ink-3); }
.q-legend { font-size: var(--fs-xs); color: var(--ink-3); margin-top: 2px; }

/* histogram --------------------------------------------------------------- */
.hist { display: block; width: 100%; height: 62px; overflow: visible; }
.hist rect.b { fill: var(--accent); opacity: .78; }
.hist rect.b:hover { opacity: 1; }
.hist line.med { stroke: var(--ink); stroke-width: 1.5; stroke-dasharray: 3 2; }
.hist text { font-family: var(--font-mono); font-size: 9px; fill: var(--ink-3); }
.hist-axis { display: flex; justify-content: space-between; font-size: var(--fs-xs);
             color: var(--ink-3); font-family: var(--font-mono); margin-top: 2px; }

/* percentile / coverage bars ---------------------------------------------- */
.pbar-row { display: grid; grid-template-columns: 1fr auto; gap: 2px var(--s3);
            align-items: baseline; }
.pbar-row + .pbar-row { margin-top: var(--s3); }
.pbar-k { font-size: var(--fs-sm); color: var(--ink-2); }
.pbar-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums;
          font-size: var(--fs-sm); color: var(--ink); }
.pbar { grid-column: 1 / -1; position: relative; height: 6px; border-radius: 3px;
        background: var(--surface-3); }
.pbar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
          background: var(--accent); display: block; }
.pbar u { position: absolute; top: -3px; bottom: -3px; width: 1.5px; background: var(--ink-3); }
.pbar-sub { grid-column: 1 / -1; font-size: 10px; color: var(--ink-3);
            font-family: var(--font-mono); }

/* consensus list ---------------------------------------------------------- */
.cons-row { display: grid; grid-template-columns: 1fr auto; gap: 2px var(--s3); align-items: baseline; }
.cons-row + .cons-row { margin-top: var(--s3); }
.cons-seq { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink);
            word-break: break-all; }
.cons-n { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--ink-3); }

/* name tier badge --------------------------------------------------------- */
.tier { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs);
        color: var(--ink-3); border: 1px solid var(--line); border-radius: var(--r-full);
        padding: 1px 8px; background: var(--surface-2); white-space: nowrap; }
.tier .dots { display: inline-flex; gap: 2px; }
.tier .dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--line-strong); }
.tier .dots i.on { background: var(--accent); }

/* quality chips ----------------------------------------------------------- */
.qchip { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-xs);
         border: 1px solid var(--line); border-radius: var(--r-full); padding: 2px 9px;
         background: var(--surface); color: var(--ink-2); white-space: nowrap; }
.qchip b { font-family: var(--font-mono); color: var(--ink); font-weight: 620; }
.qchip.off { color: var(--ink-3); background: var(--surface-2); border-style: dashed; }
.qchip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); }
.qchip.off .dot { background: var(--line-strong); }

/* facets (browse) --------------------------------------------------------- */
.facets { display: grid; gap: var(--s4); }
.facet h4 { margin: 0 0 var(--s2); font-size: var(--fs-xs); text-transform: uppercase;
            letter-spacing: .09em; color: var(--ink-3); font-weight: 620; }
.facet-list { display: flex; flex-direction: column; gap: 2px; }
.fbtn { display: flex; align-items: center; gap: var(--s2); width: 100%; text-align: left;
        border: 1px solid transparent; background: transparent; cursor: pointer;
        border-radius: var(--r-sm); padding: 4px 7px; font-size: var(--fs-sm);
        color: var(--ink-2); }
.fbtn:hover { background: var(--surface-2); }
.fbtn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-line);
                             color: var(--ink); font-weight: 600; }
.fbtn .cnt { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
             font-size: var(--fs-xs); color: var(--ink-3); }
.fbtn.zero { opacity: .45; }
.fbtn.zero .cnt { color: var(--bad); }
.fbtn .swatch { width: 9px; height: 9px; border-radius: 2px; flex: 0 0 auto; }

/* scatter (browse) -------------------------------------------------------- */
.scatter-wrap { position: relative; }
.scatter { display: block; width: 100%; height: auto; touch-action: none; cursor: crosshair; }
.scatter circle { stroke: var(--surface); stroke-width: .6; }
.scatter circle.dim { opacity: .12; }
.scatter circle.hot { stroke: var(--ink); stroke-width: 1.2; }
.scatter .axis line, .scatter .axis path { stroke: var(--line-strong); }
.scatter .axis text { font-family: var(--font-mono); font-size: 9px; fill: var(--ink-3); }
.scatter .grid line { stroke: var(--line-soft); }
.scatter rect.brush { fill: color-mix(in srgb, var(--accent) 12%, transparent);
                      stroke: var(--accent); stroke-dasharray: 3 2; }
.sc-tip { position: absolute; pointer-events: none; background: var(--ink); color: var(--bg);
          border-radius: var(--r-sm); padding: 5px 8px; font-size: var(--fs-xs);
          font-family: var(--font-mono); box-shadow: var(--shadow-2); transform: translate(-50%, -130%);
          white-space: nowrap; z-index: 5; }
.sc-legend { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); font-size: var(--fs-xs);
             color: var(--ink-3); margin-top: var(--s2); }

/* table extras ------------------------------------------------------------ */
.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: var(--ink); }
.sortable .arw { color: var(--accent); font-size: 9px; }
.mini { display: inline-block; height: 5px; border-radius: 3px; background: var(--accent);
        vertical-align: middle; opacity: .8; }
.mini-track { display: inline-block; width: 46px; height: 5px; border-radius: 3px;
              background: var(--surface-3); vertical-align: middle; overflow: hidden; }
.tag-off { color: var(--ink-3); }
`;

export function ensureR2Style() { ensureStyle('mirto-r2-style', R2_CSS); }

/* =============================================================================
   the 900-row cluster index
   -----------------------------------------------------------------------------
   Generated by code/build/11_cluster_index.py, imported (never fetched) because
   data.js owns fetching and has no getter for it yet. Resolves to null if the
   module is missing, so the caller renders its designed empty state.
   ============================================================================= */

/* INTEGRATION NOTE: this used to `import('./cluster-index.js')` — a 379 KB ES
   module carrying the same bytes as data/cluster_index.json — because data.js
   had no getter for this payload. data.js now exports getClusterIndex(), so the
   rule that only data.js fetches holds with ONE copy of the data on disk.
   js/cluster-index.js is no longer imported by anything; 11_cluster_index.py can
   stop writing it. This wrapper is kept so R2.getClusterIndex() callers are
   unchanged, and it still resolves to null (never rejects) on any failure. */
export function getClusterIndex() { return fetchClusterIndex(); }

/* =============================================================================
   the gate
   -----------------------------------------------------------------------------
   passes_phylo_filter in protein_utr_FINAL_scores.csv is reproduced EXACTLY by
   these four conditions — 180,000/180,000 rows, 2,620 pass, 0 false positives,
   0 false negatives (re-checked at bake by 11_cluster_index.py --verify-gate).
   frac_co_ZNF <= 0.40 holds for every pair that clears them (max 0.400), so ZNF
   ships as a diagnostic, not as a fifth gate.
   ============================================================================= */

export const GATES = [
  { key: 'co', label: 'co-occurrence', op: '≥', t: 10, tl: '10', hi: true, dp: 0,
    help: 'genes carrying both clusters' },
  { key: 'clades', label: 'indep. clades', op: '≥', t: 8, tl: '8', hi: true, dp: 0,
    help: 'phylogenetically independent protein clades among the carriers' },
  { key: 'conc', label: 'clade conc.', op: '<', t: 0.35, tl: '0.35', hi: false, dp: 3,
    help: 'share of the co-occurrence sitting in its single biggest clade — lower is better' },
  { key: 'npmi', label: 'NPMI', op: '>', t: 0.10, tl: '0.10', hi: true, dp: 3,
    help: 'normalised PMI after MI-adjustment and average-product correction' }
];

export const ZNF_DIAG = { key: 'znf', label: 'ZNF share', op: '≤', t: 0.40, tl: '0.40', hi: false, dp: 3,
  help: 'fraction of the co-occurrence contributed by zinc-finger genes. Never binding: ' +
        'no pair that clears the four gates exceeds 0.400.' };

export function gatePass(g, v) {
  if (v == null || !Number.isFinite(+v)) return null;         // not computable
  return g.hi ? (g.op === '≥' ? +v >= g.t : +v > g.t)
              : (g.op === '≤' ? +v <= g.t : +v < g.t);
}

/** Strict = the published gate. */
export function isStrict(p) {
  return GATES.every(g => gatePass(g, p[g.key]) === true);
}
/** Suggestive = the labelled superset: clears the co-occurrence evidence floor
 *  (count and NPMI) but not necessarily phylogenetic independence. */
export function isSuggestive(p) {
  return gatePass(GATES[0], p.co) === true && gatePass(GATES[3], p.npmi) === true;
}

/** Threshold sits at 45% of the track; beyond it the scale is asymptotic, so a
 *  value ten times the threshold is still on screen and still distinguishable. */
function gateFrac(g, v) {
  const r = Math.abs(+v) / (g.t || 1);
  if (!Number.isFinite(r)) return 0;
  if (r <= 1) return 0.45 * r;
  return 0.45 + 0.55 * (1 - 1 / r);
}

/** One gate meter: the number first, the bar as the glance. */
export function gateMeter(g, v, opts) {
  opts = opts || {};
  const ok = gatePass(g, v);
  const cls = 'gate ' + (opts.diag ? 'diag ' : '') + (ok === null ? '' : ok ? 'pass' : 'fail');
  const frac = v == null ? 0 : Math.max(0, Math.min(1, gateFrac(g, v)));
  const show = v == null ? 'n/a' : (g.dp ? (+v).toFixed(g.dp) : fmt.int(v));
  return el('div', {
    class: cls,
    title: g.label + ' ' + g.op + ' ' + (g.tl || g.t) + ' — ' + g.help +
           (v == null ? '\nNot computable for this pair (co-occurrence is 0).'
                      : '\nThis pair: ' + show + (ok ? '  → passes' : '  → fails'))
  }, [
    el('div.gate-k', [
      el('span', g.label),
      el('span.gate-v', show)
    ]),
    el('div.gate-track', [
      el('span.gate-fill', { style: { width: (100 * frac).toFixed(1) + '%' } }),
      el('span.gate-thr', { style: { left: '45%' } })
    ]),
    el('span.gate-thrlab', (opts.diag ? 'diagnostic ' : '') + g.op + ' ' + (g.tl || g.t))
  ]);
}

/** All four gates plus the ZNF diagnostic, ABOVE any interpretation. */
export function gateStrip(p) {
  const strip = el('div.gate-strip');
  for (const g of GATES) strip.appendChild(gateMeter(g, p[g.key]));
  strip.appendChild(gateMeter(ZNF_DIAG, p.znf, { diag: true }));
  return strip;
}

export function gateLegend() {
  return el('div.gate-legend', [
    el('div', ['Every partner is scored on four gates, shown before any interpretation. ',
               'A pair passes only if all four hold: ',
               el('b', 'co ≥ 10'), ', ', el('b', 'clades ≥ 8'), ', ',
               el('b', 'conc < 0.35'), ', ', el('b', 'NPMI > 0.10'), '.']),
    el('div', ['The tick at 45% of each bar is the threshold. ',
               el('b', 'ZNF share'), ' is a diagnostic, not a gate — no pair that clears the ',
               'four ever exceeds 0.400.'])
  ]);
}

/* =============================================================================
   name tier badge — the provenance of a cluster's name
   ============================================================================= */

export const TIER_TEXT = {
  1: 'named by a significant enriched term',
  2: 'named from its top consensus string — descriptive only',
  3: 'no term and no consensus: the id is the only honest name'
};

export function tierBadge(tier, source) {
  const t = Number(tier) || 3;
  const dots = el('span.dots');
  for (let i = 1; i <= 3; i++) dots.appendChild(el('i', { class: i <= (4 - t) ? 'on' : '' }));
  const src = source ? String(source).split(':').slice(-1)[0] : null;
  return el('span.tier', {
    title: 'Name tier ' + t + ' — ' + (TIER_TEXT[t] || '') + (source ? '\nsource: ' + source : '')
  }, [dots, el('span', 'tier ' + t + (src && t < 3 ? ' · ' + src : ''))]);
}

/* =============================================================================
   quality chip
   ============================================================================= */

export function qualityChip(on, label, value, title) {
  return el('span', { class: 'qchip' + (on ? '' : ' off'), title: title || '' },
    [el('span.dot'), value != null ? el('b', String(value)) : null, el('span', label)]);
}

/* =============================================================================
   percentile bar — a value with its rank in the 900-cluster rail
   ============================================================================= */

export function percentileRow(label, value, pct, sub) {
  return el('div.pbar-row', [
    el('span.pbar-k', label),
    el('span.pbar-v', fmt.int(value)),
    el('span.pbar', { title: pct == null ? '' : 'percentile ' + fmt.num(pct, 0) + ' of the 900 clusters' },
      [el('i', { style: { width: (pct == null ? 0 : Math.max(1.5, pct)) + '%' } }),
       el('u', { style: { left: '50%' }, title: 'median cluster' })]),
    sub ? el('span.pbar-sub', sub) : null
  ]);
}

/* =============================================================================
   coverage bar with a corpus-median marker
   ============================================================================= */

export function coverageRow(seq, coverage, carriers, median) {
  const pctv = Math.max(0, Math.min(1, +coverage || 0));
  return el('div.cons-row', [
    el('span.cons-seq.seq', seq),
    el('span.cons-n', fmt.pct(coverage, 0) + ' · ' + fmt.int(carriers) + ' carriers'),
    el('span.pbar', {
      title: 'coverage ' + fmt.pct(coverage, 1) + ' of this cluster’s carrier transcripts' +
             (median ? '\ncorpus median consensus coverage: ' + fmt.pct(median, 1) : '')
    }, [
      el('i', { style: { width: (100 * pctv).toFixed(1) + '%' } }),
      median ? el('u', { style: { left: (100 * median).toFixed(1) + '%' } }) : null
    ])
  ]);
}

/* =============================================================================
   quantile strip with a ghost corpus outline
   -----------------------------------------------------------------------------
   q = [min, p5, p25, p50, p75, p95, max]; ghost is the same seven for the median
   cluster of this region, drawn as a dashed outline behind.
   ============================================================================= */

export function quantileStrip(q, ghost, opts) {
  opts = opts || {};
  const W = 300, H = 34, padL = 2, padR = 2;
  const lo = opts.lo != null ? opts.lo : Math.min(q[0], ghost ? ghost.q[0] : q[0]);
  const hi = opts.hi != null ? opts.hi : Math.max(q[6], ghost ? ghost.q[6] : q[6]);
  const span = (hi - lo) || 1;
  const x = v => padL + ((v - lo) / span) * (W - padL - padR);
  const svg = el('svg.qbox', {
    viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': (opts.label || 'distribution') +
      ': median ' + fmt.num(q[3], 3) + ', 25–75% ' + fmt.num(q[2], 3) + ' to ' + fmt.num(q[4], 3)
  });

  if (ghost) {
    const gy = 8, gh = 8;
    svg.appendChild(el('rect.ghost', {
      x: x(ghost.q[2]).toFixed(1), y: gy, width: Math.max(1, x(ghost.q[4]) - x(ghost.q[2])).toFixed(1),
      height: gh, rx: 2
    }));
    svg.appendChild(el('line.ghost', { x1: x(ghost.q[1]).toFixed(1), x2: x(ghost.q[5]).toFixed(1),
      y1: gy + gh / 2, y2: gy + gh / 2 }));
    svg.appendChild(el('line.ghost', { x1: x(ghost.q[3]).toFixed(1), x2: x(ghost.q[3]).toFixed(1),
      y1: gy - 1, y2: gy + gh + 1 }));
  }

  const by = 18, bh = 11;
  svg.appendChild(el('line.whisk', { x1: x(q[0]).toFixed(1), x2: x(q[6]).toFixed(1),
    y1: by + bh / 2, y2: by + bh / 2 }));
  svg.appendChild(el('line.whisk', { x1: x(q[1]).toFixed(1), x2: x(q[5]).toFixed(1),
    y1: by + bh / 2, y2: by + bh / 2, 'stroke-width': 2 }));
  svg.appendChild(el('rect.box', { x: x(q[2]).toFixed(1), y: by,
    width: Math.max(1, x(q[4]) - x(q[2])).toFixed(1), height: bh, rx: 2 }));
  svg.appendChild(el('line.med', { x1: x(q[3]).toFixed(1), x2: x(q[3]).toFixed(1),
    y1: by - 2, y2: by + bh + 2 }));
  svg.appendChild(el('title', (opts.label || '') +
    '\nthis cluster  min ' + fmt.num(q[0], 3) + ' · p25 ' + fmt.num(q[2], 3) +
    ' · median ' + fmt.num(q[3], 3) + ' · p75 ' + fmt.num(q[4], 3) + ' · max ' + fmt.num(q[6], 3) +
    (ghost ? '\ncorpus (dashed)  median ' + fmt.num(ghost.q[3], 3) +
             ' · p25 ' + fmt.num(ghost.q[2], 3) + ' · p75 ' + fmt.num(ghost.q[4], 3) : '')));
  return svg;
}

/* =============================================================================
   position histogram — 20 bins along the region, with the median marked
   ============================================================================= */

export function positionHistogram(bins, region, opts) {
  opts = opts || {};
  const W = 300, H = 62, padB = 2;
  const n = bins.length || 20;
  const max = Math.max.apply(null, bins.concat([0.0001]));
  const svg = el('svg.hist', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none',
    role: 'img', 'aria-label': 'positional distribution of motif instances along the region' });
  const bw = W / n;
  for (let i = 0; i < n; i++) {
    const h = (bins[i] / max) * (H - padB - 2);
    svg.appendChild(el('rect.b', {
      x: (i * bw + 0.6).toFixed(2), y: (H - padB - h).toFixed(2),
      width: (bw - 1.2).toFixed(2), height: Math.max(0.6, h).toFixed(2), rx: 1
    }, [el('title', 'bin ' + (i + 1) + ' of ' + n + ' · ' + fmt.pct(bins[i], 1) +
                    ' of instances')]));
  }
  // median position, interpolated inside the crossing bin
  let cum = 0, medX = 0;
  for (let i = 0; i < n; i++) {
    if (cum + bins[i] >= 0.5) { medX = (i + (0.5 - cum) / (bins[i] || 1)) * bw; break; }
    cum += bins[i];
  }
  svg.appendChild(el('line.med', { x1: medX.toFixed(1), x2: medX.toFixed(1), y1: 0, y2: H - padB },
    [el('title', 'median instance sits at ' + fmt.pct(medX / W, 0) + ' of the region')]));
  const isProt = region === 'protein';
  return el('div', [
    svg,
    el('div.hist-axis', [
      el('span', isProt ? 'N-term' : "5′"),
      el('span.dim', 'median ' + fmt.pct(medX / W, 0)),
      el('span', isProt ? 'C-term' : "3′")
    ])
  ]);
}

/* =============================================================================
   small shared bits
   ============================================================================= */

export function clusterHref(id, query) {
  return router.link('/cluster/' + id, query || null);
}

export function clusterLink(id, query, label) {
  return el('a.p-id', { href: clusterHref(id, query) }, label || id);
}

export function regionOf(id) {
  return String(id || '').startsWith('prot_') ? 'protein'
       : String(id || '').startsWith('utr5_') ? 'utr5' : 'utr3';
}

export function idChips(id, module) {
  return [regionBadge(regionOf(id)), moduleChip(module || 0, { quiet: true, href: false })];
}

export const REGION_NAME = { utr5: "5′ UTR", utr3: "3′ UTR", protein: 'Protein' };
