/* =============================================================================
   graph.js — the graph renderer for the MIRTO module network.

   Owned by the network agent. Imported by js/views/network.js (the cockpit) and
   js/views/module.js (the six module pages).

   Everything here is PRESENTATION over payloads that were frozen at bake time:
     · network.json  nodes[].x/.y      frozen spring layout, seed 7  — distance means nothing
     · network.json  nodes[].x2/.y2    frozen per-module bipartite coordinates
     · network.json  meta.matrix       DIRECTIONAL 6x6 protein-module x UTR-module counts

   No layout is ever recomputed in the browser except:
     · the seriated adjacency ordering (a display ordering, labelled as such)
     · the positional-profile projection (a deterministic PCA of the 20-bin
       position histogram — it is NOT a UMAP, and it says so on screen)

   Rendering is SVG with JS-side hit testing: one pointer listener on the root
   instead of 3,000 per-element listeners, which keeps the DOM at ~3.6k nodes for
   the full 519-node graph and gives edges a generous 7px pick radius.
   ============================================================================= */

import { el, clear, append, fmt, moduleLabel, REGION_LABEL, displaySeq } from './ui.js';

/* =============================================================================
   0.  style — injected once, scoped to .nw-* / .g-* so it cannot leak into
       another agent's view. app.css belongs to the shell; this file does not
       touch it.
   ============================================================================= */

const STYLE_ID = 'mirto-graph-style';

export function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
/* ---- module colour carriers (so SVG inherits the theme without JS) ------- */
.g-m0{--mc:var(--mod-0);--mci:var(--mod-0-ink)}
.g-m1{--mc:var(--mod-1);--mci:var(--mod-1-ink)}
.g-m2{--mc:var(--mod-2);--mci:var(--mod-2-ink)}
.g-m3{--mc:var(--mod-3);--mci:var(--mod-3-ink)}
.g-m4{--mc:var(--mod-4);--mci:var(--mod-4-ink)}
.g-m5{--mc:var(--mod-5);--mci:var(--mod-5-ink)}
.g-m6{--mc:var(--mod-6);--mci:var(--mod-6-ink)}
.g-rprotein{--rc:var(--protein);--rsoft:var(--protein-soft)}
.g-rutr5,.g-rutr3{--rc:var(--rna);--rsoft:var(--rna-soft)}

/* ---- cockpit shell ------------------------------------------------------- */
.nw-cockpit{display:grid;gap:var(--s4);align-items:start;grid-template-columns:minmax(0,1fr)}
.nw-rail,.nw-insp{min-width:0}
.nw-main{min-width:0}
@media (min-width:1120px){
  .nw-cockpit{grid-template-columns:264px minmax(0,1fr)}
  .nw-insp{grid-column:1/-1}
  .nw-rail{position:sticky;top:calc(var(--topbar-h) + var(--s3));max-height:calc(100vh - var(--topbar-h) - var(--s5));overflow-y:auto;overflow-x:hidden}
}
@media (min-width:1480px){
  .nw-cockpit{grid-template-columns:264px minmax(0,1fr) 344px}
  .nw-insp{grid-column:3;position:sticky;top:calc(var(--topbar-h) + var(--s3));max-height:calc(100vh - var(--topbar-h) - var(--s5));overflow-y:auto;overflow-x:hidden}
}
.nw-rail::-webkit-scrollbar,.nw-insp::-webkit-scrollbar{width:8px}
.nw-rail::-webkit-scrollbar-thumb,.nw-insp::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}

.nw-panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-1);margin-bottom:var(--s4)}
.nw-panel:last-child{margin-bottom:0}
.nw-panel > h4{margin:0;padding:var(--s3) var(--s4) var(--s2);font-size:var(--fs-xs);text-transform:uppercase;
  letter-spacing:.09em;color:var(--ink-3);font-weight:640;font-family:var(--font-sans)}
.nw-panel-body{padding:0 var(--s4) var(--s4)}
.nw-panel-body.tight{padding:0 var(--s3) var(--s3)}

/* ---- the directional meta matrix ---------------------------------------- */
.g-matrix{display:block;width:100%;height:auto;overflow:visible}
.g-mx-cell{cursor:pointer}
.g-mx-cell rect.fillc{stroke:var(--surface);stroke-width:1}
.g-mx-cell:hover rect.fillc{stroke:var(--ink);stroke-width:1.4}
.g-mx-cell[aria-pressed="true"] rect.fillc{stroke:var(--ink);stroke-width:2}
.g-mx-cell text{font-family:var(--font-mono);font-size:8.5px;text-anchor:middle;pointer-events:none;
  font-variant-numeric:tabular-nums}
.g-mx-axis{font-family:var(--font-mono);font-size:9px;fill:var(--ink-3)}
.g-mx-head{cursor:pointer}
.g-mx-head:hover text{fill:var(--ink)}
.g-mx-diag{fill:none;stroke:var(--line-strong);stroke-dasharray:2 2}
.g-mx-corner{font-size:8px;fill:var(--ink-3);font-family:var(--font-sans)}

/* ---- view switch --------------------------------------------------------- */
.nw-modes{display:flex;flex-direction:column;gap:2px}
.nw-mode{display:flex;gap:var(--s2);align-items:flex-start;width:100%;text-align:left;cursor:pointer;
  padding:7px var(--s2);border:1px solid transparent;border-radius:var(--r-md);background:transparent;
  color:var(--ink-2);font:inherit;font-size:var(--fs-sm);line-height:1.3}
.nw-mode:hover{background:var(--surface-2);color:var(--ink)}
.nw-mode[aria-pressed="true"]{background:var(--surface-3);border-color:var(--line);color:var(--ink)}
.nw-mode .mk{width:16px;flex:0 0 auto;opacity:.75;margin-top:1px}
.nw-mode .lb{display:block;font-weight:600}
.nw-mode .sb{display:block;font-size:var(--fs-xs);color:var(--ink-3)}

/* ---- controls ------------------------------------------------------------ */
.nw-ctl{margin-top:var(--s3)}
.nw-ctl-lab{display:flex;align-items:baseline;gap:var(--s2);font-size:var(--fs-xs);
  text-transform:uppercase;letter-spacing:.08em;color:var(--ink-3);font-weight:640;margin-bottom:4px}
.nw-ctl-lab .v{margin-left:auto;font-family:var(--font-mono);text-transform:none;letter-spacing:0;color:var(--ink)}
.nw-range{width:100%;accent-color:var(--accent);height:20px}
.nw-preview{font-size:var(--fs-xs);color:var(--ink-2);font-family:var(--font-mono);
  font-variant-numeric:tabular-nums;min-height:15px;line-height:1.35}
.nw-preview.armed{color:var(--accent-ink)}
.nw-enc{display:flex;flex-wrap:wrap;gap:4px}
.nw-enc button{font:inherit;font-size:var(--fs-xs);padding:3px 8px;border-radius:var(--r-full);
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);cursor:pointer}
.nw-enc button:hover{border-color:var(--line-strong);color:var(--ink)}
/* --ink-inv, not #fff: --accent is a light blue in the dark palette (see app.css) */
.nw-enc button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);
  color:var(--ink-inv)}
.nw-enc button[disabled]{cursor:not-allowed;opacity:1;background:repeating-linear-gradient(135deg,
  var(--surface-2) 0 4px,var(--surface-3) 4px 8px);color:var(--ink-3);text-decoration:line-through;
  border-style:dashed}
.nw-refuse{margin-top:5px;font-size:var(--fs-xs);color:var(--ink-3);line-height:1.4}
.nw-switch{display:flex;align-items:center;gap:var(--s2);font-size:var(--fs-sm);color:var(--ink-2);cursor:pointer}
.nw-switch input{accent-color:var(--accent)}

/* ---- canvas -------------------------------------------------------------- */
.nw-canvas-head{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:baseline;
  padding:var(--s3) var(--s4);border-bottom:1px solid var(--line-soft)}
.nw-canvas-head h3{margin:0;font-size:var(--fs-md);font-family:var(--font-display);font-weight:620}
.nw-counts{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink-2);
  font-variant-numeric:tabular-nums;margin-left:auto;text-align:right}
.nw-counts b{color:var(--ink);font-weight:640}
.nw-canvas-wrap{position:relative;padding:var(--s2);background:var(--surface);overflow-x:auto}
/* below ~480px the canvas scrolls inside its own box rather than shrinking its
   9px labels into illegibility; the page body never scrolls horizontally. */
.g-canvas{display:block;width:100%;min-width:480px;height:auto;touch-action:pan-y;outline:none;
  border-radius:var(--r-md)}
.g-canvas:focus-visible{box-shadow:var(--ring)}
.g-edge{fill:none;stroke-linecap:round}
.g-edge.cross{stroke:var(--ink-3)}
.g-edge.dashed{stroke-dasharray:2.5 2.5}
.g-node{stroke:var(--surface);stroke-width:1}
.g-node.ring{stroke:var(--rc);stroke-width:1.4}
.g-canvas.is-focused .g-edge{stroke-opacity:.05}
.g-canvas.is-focused .g-edge.on{stroke-opacity:.95}
.g-canvas.is-focused .g-node{opacity:.2}
.g-canvas.is-focused .g-node.on{opacity:1}
.g-node.sel{stroke:var(--ink);stroke-width:2}
.g-lab{font-family:var(--font-sans);font-size:9px;fill:var(--ink-2);dominant-baseline:middle}
.g-lab.dimx{fill:var(--ink-3)}
.g-lab-id{font-family:var(--font-mono);font-size:8px;fill:var(--ink-3);dominant-baseline:middle}
.g-colhead{font-family:var(--font-sans);font-size:10px;fill:var(--ink-3);letter-spacing:.06em;
  text-transform:uppercase;font-weight:640}
.g-gutter{font-family:var(--font-mono);font-size:8.5px;fill:var(--ink-3);dominant-baseline:middle}
.g-axis{stroke:var(--line);stroke-width:1}
.g-hatch{stroke:var(--line-strong);stroke-width:.6}
.g-tip{position:absolute;pointer-events:none;z-index:12;background:var(--surface);
  border:1px solid var(--line-strong);border-radius:var(--r-md);box-shadow:var(--shadow-2);
  padding:var(--s2) var(--s3);max-width:290px;font-size:var(--fs-xs);line-height:1.45;color:var(--ink)}
.g-tip .t-h{display:flex;gap:var(--s2);align-items:center;margin-bottom:3px}
.g-tip .t-n{font-weight:640;font-size:var(--fs-sm)}
.g-tip .t-k{color:var(--ink-3)}
.g-tip .t-row{display:flex;gap:var(--s3);font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.g-tip .t-row span:last-child{margin-left:auto;color:var(--ink)}
.nw-provenance{padding:var(--s2) var(--s4) var(--s3);font-size:var(--fs-xs);color:var(--ink-3);
  line-height:1.5;border-top:1px dashed var(--line)}
.nw-legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);padding:var(--s2) var(--s4);
  font-size:var(--fs-xs);color:var(--ink-2);border-top:1px solid var(--line-soft)}
.nw-legend .lg{display:inline-flex;align-items:center;gap:5px}

/* ---- node glyph ---------------------------------------------------------- */
.g-glyph{display:flex;align-items:center;gap:var(--s2);min-width:0}
.g-glyph .gg-mark{flex:0 0 auto}
.g-glyph .gg-txt{min-width:0}
.g-glyph .gg-name{font-size:var(--fs-sm);font-weight:600;color:var(--ink);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.g-glyph .gg-id{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink-3)}
.g-cons{display:inline-flex;gap:1px;vertical-align:middle}
.g-cons i{font-family:var(--font-mono);font-style:normal;font-size:10.5px;line-height:15px;
  min-width:10px;text-align:center;border-radius:2px;background:var(--surface-3);color:var(--ink)}
.g-cons i.b-A{background:color-mix(in srgb,var(--mod-3) 26%,transparent)}
.g-cons i.b-C{background:color-mix(in srgb,var(--mod-5) 26%,transparent)}
.g-cons i.b-G{background:color-mix(in srgb,var(--mod-1) 30%,transparent)}
.g-cons i.b-U{background:color-mix(in srgb,var(--mod-6) 26%,transparent)}
.g-nocons{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-xs);color:var(--ink-3);
  border:1px dashed var(--line-strong);border-radius:var(--r-sm);padding:0 6px;height:15px;
  background:repeating-linear-gradient(135deg,transparent 0 3px,var(--surface-2) 3px 6px)}
.g-cov{display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-xs);color:var(--ink-3);
  font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.g-cov .bar{width:44px;height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden;
  border:1px solid var(--line-soft);flex:0 0 auto}
.g-cov .bar > i{display:block;height:100%;background:var(--rc,var(--accent))}
.g-cov.low .bar > i{background:var(--warn)}
.g-spark{display:block}
.g-spark .ar{fill:var(--rc,var(--accent));fill-opacity:.28}
.g-spark .ln{fill:none;stroke:var(--rc,var(--accent));stroke-width:1}
.g-spark .bl{stroke:var(--line);stroke-width:1}

/* ---- sequence logo ------------------------------------------------------- */
.g-logo{display:block;max-width:100%;height:auto}
.g-logo .ax{stroke:var(--line-strong);stroke-width:1}
.g-logo .axt{font-family:var(--font-mono);font-size:8px;fill:var(--ink-3)}
.g-logo .pos{font-family:var(--font-mono);font-size:8px;fill:var(--ink-3);text-anchor:middle}
.g-logo text.lt{font-family:var(--font-sans);font-weight:800}
.g-logo .l-A{fill:var(--mod-3)} .g-logo .l-C{fill:var(--mod-5)}
.g-logo .l-G{fill:var(--mod-1)} .g-logo .l-U{fill:var(--mod-6)} .g-logo .l-T{fill:var(--mod-6)}
.g-logo .aa-hydro{fill:var(--ink-2)} .g-logo .aa-polar{fill:var(--mod-5)}
.g-logo .aa-acid{fill:var(--mod-6)} .g-logo .aa-base{fill:var(--mod-2)}
.g-logo .aa-spec{fill:var(--mod-3)}

/* ---- rails & tables ------------------------------------------------------ */
.nw-rail-strip{max-height:340px;overflow-y:auto;border-top:1px solid var(--line-soft)}
.nw-row{display:grid;grid-template-columns:auto minmax(90px,1.3fr) auto auto auto;gap:var(--s3);
  align-items:center;padding:6px var(--s4);border-bottom:1px solid var(--line-soft);
  cursor:pointer;background:none;border-left:0;border-right:0;border-top:0;width:100%;
  text-align:left;font:inherit;color:inherit}
.nw-row:hover{background:var(--surface-2)}
.nw-row[aria-pressed="true"]{background:var(--accent-soft)}
.nw-row .num{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink-2);
  font-variant-numeric:tabular-nums;text-align:right}
.nw-row .bar2{width:60px;height:5px;border-radius:3px;background:var(--surface-3);overflow:hidden}
.nw-row .bar2 > i{display:block;height:100%;background:var(--accent)}
.nw-sorts{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.nw-sorts button{font:inherit;font-size:var(--fs-xs);padding:2px 7px;border-radius:var(--r-full);
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);cursor:pointer}
.nw-sorts button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--ink-inv)}

/* ---- inspector ----------------------------------------------------------- */
.nw-insp-head{padding:var(--s4) var(--s4) var(--s3)}
.nw-kv{display:grid;grid-template-columns:1fr auto;gap:3px var(--s3);font-size:var(--fs-sm)}
.nw-kv dt{color:var(--ink-3)}
.nw-kv dd{margin:0;font-family:var(--font-mono);font-variant-numeric:tabular-nums;text-align:right;color:var(--ink)}
.nw-facing{display:grid;grid-template-columns:1fr auto 1fr;gap:var(--s3);align-items:stretch}
@media (max-width:520px){.nw-facing{grid-template-columns:1fr}}
.nw-page{border:1px solid var(--line);border-radius:var(--r-md);padding:var(--s3);background:var(--surface-2);min-width:0}
.nw-page.prot{border-top:3px solid var(--protein)}
.nw-page.rna{border-top:3px solid var(--rna)}
.nw-spine{display:flex;flex-direction:column;align-items:center;gap:var(--s2);
  padding:0 var(--s2);border-left:1px dashed var(--line);border-right:1px dashed var(--line);min-width:118px}
.nw-spine .sv{font-family:var(--font-mono);font-size:var(--fs-lg);font-weight:600;line-height:1;
  font-variant-numeric:tabular-nums}
.nw-spine .sk2{font-size:var(--fs-xs);color:var(--ink-3);text-align:center;line-height:1.3}
.nw-gate{display:grid;grid-template-columns:repeat(2,1fr);gap:var(--s2);width:100%}
.nw-gate .cell{border:1px solid var(--line);border-radius:var(--r-sm);padding:4px 6px;background:var(--surface)}
.nw-gate .cell .k{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3)}
.nw-gate .cell .v{display:block;font-family:var(--font-mono);font-size:var(--fs-sm);color:var(--ink);
  font-variant-numeric:tabular-nums}
.nw-linkline{display:flex;flex-wrap:wrap;gap:var(--s2);margin-top:var(--s3)}
.nw-note{font-size:var(--fs-xs);color:var(--ink-3);line-height:1.5;margin-top:var(--s2)}
.nw-hr{height:1px;background:var(--line-soft);margin:var(--s3) 0}
.nw-badge-line{display:flex;flex-wrap:wrap;gap:6px;align-items:center}

/* ---- module page --------------------------------------------------------- */
.md-hero{display:grid;gap:var(--s4);grid-template-columns:minmax(0,1fr)}
@media (min-width:960px){.md-hero{grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)}}
.md-swatch{width:100%;height:6px;border-radius:3px;background:var(--mc)}
.md-termbar{width:100%;height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden}
.md-termbar > i{display:block;height:100%;background:var(--mc)}
.md-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:var(--s4)}
.md-tabs a{padding:7px 12px;font-size:var(--fs-sm);color:var(--ink-2);text-decoration:none;
  border-bottom:2px solid transparent;margin-bottom:-1px}
.md-tabs a[aria-current="page"]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
.md-tabs a:hover{color:var(--ink)}
.md-filter{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
.md-filter input[type=search]{height:26px;border:1px solid var(--line);border-radius:var(--r-md);
  background:var(--surface-2);color:var(--ink);padding:0 var(--s2);font:inherit;font-size:var(--fs-sm);min-width:150px}
.md-cluster-grid{display:grid;gap:var(--s2);grid-template-columns:repeat(auto-fill,minmax(232px,1fr))}
.md-cc{display:block;text-decoration:none;color:inherit;border:1px solid var(--line);
  border-radius:var(--r-md);padding:var(--s2) var(--s3);background:var(--surface)}
.md-cc:hover{border-color:var(--line-strong);background:var(--surface-2)}
.md-cc .r1{display:flex;align-items:center;gap:var(--s2);margin-bottom:3px}
.md-cc .r2{display:flex;align-items:center;gap:var(--s3);flex-wrap:wrap}
`;

/* =============================================================================
   1.  small shared helpers
   ============================================================================= */

export function edgeKey(e) { return e.p + '~' + e.u; }
export function isEdgeId(id) { return typeof id === 'string' && id.indexOf('~') !== -1; }

export function modClass(m) { return 'g-m' + (Number(m) || 0); }
export function regClass(r) { return 'g-r' + (r || 'utr3'); }

/** Region short label used in glyphs and legends. */
export const REG = { protein: 'protein', utr5: "5′UTR", utr3: "3′UTR" };

/** The four gate values that may drive edge width. */
export const ENC = {
  sc:   { key: 'sc',   label: 'phylo-corrected score',
          hint: 'NPMI+APC after the phylogenetic-independence correction — the gate statistic',
          fmt: v => fmt.num(v, 3) },
  npmi: { key: 'npmi', label: 'NPMI (MIP / APC)',
          hint: 'normalised pointwise mutual information with the APC background removed',
          fmt: v => fmt.num(v, 3) },
  co:   { key: 'co',   label: 'co-occurrence count',
          hint: 'transcripts carrying both clusters',
          fmt: v => fmt.int(v) },
  cl:   { key: 'cl',   label: 'independent clades',
          hint: 'paralog families supporting the pair — the phylogenetic breadth',
          fmt: v => fmt.int(v) }
};
export const ENC_ORDER = ['sc', 'npmi', 'co', 'cl'];

/**
 * p-value / FDR formatter. ui.fmt.sci only switches to exponential below 1e-3,
 * so a STREME p of 0.0029 renders as "0.00" there — which reads as zero. Any
 * probability below 0.01 gets an exponent here.
 */
export function pval(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  if (x < 0.01) return x.toExponential(1);
  return x.toFixed(3);
}

/** Linear map with clamping. */
function scale(v, d0, d1, r0, r1) {
  if (!(d1 > d0)) return (r0 + r1) / 2;
  const t = Math.max(0, Math.min(1, (v - d0) / (d1 - d0)));
  return r0 + t * (r1 - r0);
}

/** Edge stroke width in user units for the current encoding. */
export function edgeWidth(e, enc, dom, min, max) {
  const v = e[enc];
  if (!Number.isFinite(v)) return min;
  return scale(Math.sqrt(Math.max(0, v - dom[0])), 0, Math.sqrt(Math.max(1e-9, dom[1] - dom[0])), min, max);
}

/** Domain [min,max] of an encoding over a set of edges. */
export function encDomain(edges, enc) {
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) {
    const v = e[enc];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  return [lo, hi === lo ? lo + 1 : hi];
}

/** Node radius from instance count — area-proportional, floored so a 1-instance
 *  cluster is still clickable. */
export function nodeRadius(n, nmax, base) {
  const b = base || 1;
  return (2.6 + 5.4 * Math.sqrt(Math.max(1, n || 1) / Math.max(1, nmax))) * b;
}

/* =============================================================================
   2.  node marks — region shape + module fill + size
   ============================================================================= */

/** Path data for the region glyph, centred on (cx,cy) with radius r.
 *  protein = square (the modality with a fold), utr5 = triangle (the 5′ cap end),
 *  utr3 = circle. Three shapes so the modality survives a greyscale print. */
export function markPathD(region, cx, cy, r) {
  if (region === 'protein') {
    const a = r * 0.9;
    return 'M' + (cx - a) + ' ' + (cy - a) + 'h' + (2 * a) + 'v' + (2 * a) + 'h' + (-2 * a) + 'Z';
  }
  if (region === 'utr5') {
    const a = r * 1.18;
    return 'M' + cx + ' ' + (cy - a) + 'L' + (cx + a * 0.92) + ' ' + (cy + a * 0.72) +
           'L' + (cx - a * 0.92) + ' ' + (cy + a * 0.72) + 'Z';
  }
  const k = r * 0.5523;
  return 'M' + (cx - r) + ' ' + cy +
         'C' + (cx - r) + ' ' + (cy - k) + ' ' + (cx - k) + ' ' + (cy - r) + ' ' + cx + ' ' + (cy - r) +
         'C' + (cx + k) + ' ' + (cy - r) + ' ' + (cx + r) + ' ' + (cy - k) + ' ' + (cx + r) + ' ' + cy +
         'C' + (cx + r) + ' ' + (cy + k) + ' ' + (cx + k) + ' ' + (cy + r) + ' ' + cx + ' ' + (cy + r) +
         'C' + (cx - k) + ' ' + (cy + r) + ' ' + (cx - r) + ' ' + (cy + k) + ' ' + (cx - r) + ' ' + cy + 'Z';
}

/** A standalone inline mark, for use in lists and headers. */
export function nodeMark(node, opts) {
  opts = opts || {};
  const s = opts.size || 14;
  const r = s * 0.36;
  const svg = el('svg', {
    class: 'gg-mark ' + modClass(node.m) + ' ' + regClass(node.r),
    width: s, height: s, viewBox: '0 0 ' + s + ' ' + s, 'aria-hidden': 'true', focusable: 'false'
  }, [
    el('path', { d: markPathD(node.r, s / 2, s / 2, r), class: 'g-node ring',
                 style: { fill: 'var(--mc)' } })
  ]);
  return svg;
}

/* =============================================================================
   3.  consensus glyph, coverage bar, positional sparkline
       — the three honesty marks that travel together everywhere a cluster is named
   ============================================================================= */

/** The consensus string as coloured monospace boxes. `region` drives T→U. */
export function consensusGlyph(text, region, opts) {
  opts = opts || {};
  const host = el('span.g-cons', { title: opts.title || ('consensus ' + text) });
  const shown = displaySeq(String(text || ''), region);
  const isRNA = region === 'utr5' || region === 'utr3';
  for (const ch of shown.slice(0, opts.max || 14)) {
    host.appendChild(el('i', { class: isRNA ? 'b-' + ch : null, text: ch }));
  }
  if (shown.length > (opts.max || 14)) host.appendChild(el('i', { text: '…' }));
  return host;
}

/** The deliberate fallback mark for the 68 of 519 nodes with no consensus. */
export function noConsensusMark(opts) {
  opts = opts || {};
  return el('span.g-nocons', {
    title: 'No consensus string survived for this cluster — 68 of 519 network nodes are in ' +
           'this state. Nothing is drawn in its place.'
  }, opts.label || 'no consensus');
}

/**
 * The honesty mark. `cov` is the fraction of cluster members the consensus
 * matches — printed next to every consensus, never hidden.
 */
export function coverageBar(cov, opts) {
  opts = opts || {};
  const v = Number.isFinite(cov) ? Math.max(0, Math.min(1, cov)) : null;
  const low = v != null && v < 0.15;
  const title = v == null
    ? 'No consensus, so no coverage.'
    : 'This consensus matches ' + fmt.pct(v) + ' of the cluster’s members' +
      (opts.carriers ? ' (' + fmt.int(opts.carriers) + ' carriers)' : '') +
      '. Low coverage means the consensus describes only a slice of the cluster.';
  return el('span', { class: 'g-cov' + (low ? ' low' : ''), title }, [
    el('span.bar', el('i', { style: { width: (v == null ? 0 : v * 100) + '%' } })),
    el('span', v == null ? '—' : fmt.pct(v, 0))
  ]);
}

/** 20-bin positional profile within the region, 5′→3′ (N→C for protein). */
export function sparkline(pos, opts) {
  opts = opts || {};
  const w = opts.w || 56, h = opts.h || 16;
  const arr = Array.isArray(pos) && pos.length ? pos : null;
  if (!arr) return el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, '—');
  const max = Math.max.apply(null, arr) || 1;
  const n = arr.length;
  const step = w / (n - 1);
  let line = '', area = 'M0 ' + h;
  for (let i = 0; i < n; i++) {
    const x = i * step, y = h - (arr[i] / max) * (h - 1.5) - 0.75;
    line += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    area += 'L' + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  area += 'L' + w + ' ' + h + 'Z';
  const dirn = opts.region === 'protein' ? 'N → C terminus' : '5′ → 3′';
  return el('svg', {
    class: 'g-spark ' + regClass(opts.region), width: w, height: h,
    viewBox: '0 0 ' + w + ' ' + h, role: 'img',
    'aria-label': 'positional profile, ' + dirn,
    title: 'Where in the region this cluster’s motifs fall (' + n + ' bins, ' + dirn + ')'
  }, [
    el('path', { class: 'ar', d: area }),
    el('path', { class: 'ln', d: line }),
    el('line', { class: 'bl', x1: 0, y1: h - 0.5, x2: w, y2: h - 0.5 })
  ]);
}

/* =============================================================================
   4.  sequence logo (information content) — drawn from the cluster shard's PWM.
       444 of 900 clusters have logo === null and get the designed empty mark;
       there is NO client-side PWM fallback, by construction.
   ============================================================================= */

const AA_CLASS = {
  A: 'aa-hydro', V: 'aa-hydro', L: 'aa-hydro', I: 'aa-hydro', M: 'aa-hydro',
  F: 'aa-hydro', W: 'aa-hydro', Y: 'aa-polar',
  S: 'aa-polar', T: 'aa-polar', N: 'aa-polar', Q: 'aa-polar',
  D: 'aa-acid', E: 'aa-acid', K: 'aa-base', R: 'aa-base', H: 'aa-base',
  G: 'aa-spec', P: 'aa-spec', C: 'aa-spec'
};
const CAP = 0.72;    // cap height of the display font at font-size 1

/**
 * logoSVG(pwm, alphabet, {region, colWidth, height})
 * Column height = information content (log2(A) − H); letter height = p·IC.
 * The alphabet on disk is DNA ('ACGT'); `region` drives the T→U relabel for UTRs.
 */
export function logoSVG(pwm, alphabet, opts) {
  opts = opts || {};
  const cols = pwm.length, A = alphabet.length;
  const maxIC = Math.log2(A);
  const cw = opts.colWidth || (A === 4 ? 17 : 15);
  const plotH = opts.height || 62;
  const padL = 20, padB = 13, padT = 3;
  const w = padL + cols * cw + 4, h = padT + plotH + padB;
  const isRNA = opts.region === 'utr5' || opts.region === 'utr3';
  const letters = alphabet.split('').map(c => (isRNA && c === 'T') ? 'U' : c);

  const svg = el('svg', {
    class: 'g-logo', width: w, height: h, viewBox: '0 0 ' + w + ' ' + h,
    preserveAspectRatio: 'xMinYMid meet', role: 'img',
    'aria-label': 'sequence logo, ' + cols + ' positions, information content up to ' +
                  maxIC.toFixed(2) + ' bits'
  });

  // y axis
  svg.appendChild(el('line', { class: 'ax', x1: padL - 3, y1: padT, x2: padL - 3, y2: padT + plotH }));
  svg.appendChild(el('text', { class: 'axt', x: padL - 6, y: padT + 6, 'text-anchor': 'end' },
                     maxIC >= 4 ? '4.3' : String(maxIC)));
  svg.appendChild(el('text', { class: 'axt', x: padL - 6, y: padT + plotH, 'text-anchor': 'end' }, '0'));
  svg.appendChild(el('text', {
    class: 'axt', x: 7, y: padT + plotH / 2, 'text-anchor': 'middle',
    transform: 'rotate(-90 7 ' + (padT + plotH / 2) + ')'
  }, 'bits'));

  for (let c = 0; c < cols; c++) {
    const row = pwm[c] || [];
    let hEnt = 0;
    for (let i = 0; i < A; i++) { const p = row[i]; if (p > 0) hEnt -= p * Math.log2(p); }
    const ic = Math.max(0, maxIC - hEnt);
    const order = row.map((p, i) => [p, i]).filter(d => d[0] > 0.002).sort((a, b) => a[0] - b[0]);
    let y = padT + plotH;
    const x = padL + c * cw;
    for (const [p, i] of order) {
      const lh = (p * ic / maxIC) * plotH;
      if (lh < 0.4) continue;
      const ch = letters[i];
      const cls = A === 4 ? 'l-' + ch : (AA_CLASS[ch] || 'aa-hydro');
      const g = el('g', { transform: 'translate(' + x.toFixed(2) + ',' + y.toFixed(2) + ') ' +
                                    'scale(' + ((cw - 1.2) / 100).toFixed(4) + ',' + (lh / (100 * CAP)).toFixed(4) + ')' });
      g.appendChild(el('text', {
        class: 'lt ' + cls, x: 0, y: 0, 'font-size': '100', textLength: '100',
        lengthAdjust: 'spacingAndGlyphs'
      }, ch));
      svg.appendChild(g);
      y -= lh;
    }
    if (cols <= 16 || c % 2 === 0) {
      svg.appendChild(el('text', { class: 'pos', x: x + (cw - 1.2) / 2, y: padT + plotH + 10 }, String(c + 1)));
    }
  }
  return svg;
}

/**
 * The honesty mark for a LOGO, which is a different quantity from a consensus's
 * coverage: STREME builds the PWM from `nsites` sites, and a cluster can have
 * thousands of instances (prot_0040: 28 sites out of 991 instances = 2.8%).
 * A logo is never shown in this atlas without this bar next to it.
 */
export function logoSupportBar(nsites, instances) {
  const f = (nsites > 0 && instances > 0) ? Math.min(1, nsites / instances) : null;
  const low = f != null && f < 0.1;
  return el('span', {
    class: 'g-cov' + (low ? ' low' : ''),
    title: f == null
      ? 'STREME did not report how many sites this logo was built from.'
      : 'This logo was built from ' + fmt.int(nsites) + ' sites out of ' + fmt.int(instances) +
        ' motif instances in the cluster (' + fmt.pct(f) + '). A logo is a description of the ' +
        'sites STREME found, not of the whole cluster.'
  }, [
    el('span', { style: { color: 'var(--ink-3)' } }, 'logo support'),
    el('span.bar', el('i', { style: { width: (f == null ? 0 : f * 100) + '%' } })),
    el('span', f == null ? '—' : fmt.int(nsites) + '/' + fmt.int(instances) + ' · ' + fmt.pct(f, 1))
  ]);
}

/** The designed no-logo state — 444 of 900 clusters. */
export function noLogoMark(clusterId) {
  return el('div', {
    style: {
      border: '1px dashed var(--line-strong)', borderRadius: 'var(--r-md)',
      padding: 'var(--s3)', fontSize: 'var(--fs-xs)', color: 'var(--ink-3)', lineHeight: '1.5',
      background: 'repeating-linear-gradient(135deg,transparent 0 5px,var(--surface-2) 5px 10px)'
    }
  }, [
    el('b', { style: { color: 'var(--ink-2)' } }, 'No defensible logo. '),
    'STREME found no motif at test p < 0.05 for ' + (clusterId || 'this cluster') + '. ',
    el('span.mono', '444 of 900'), ' clusters are in this state. Clusters were built on embeddings, ' +
    'not on sequence, so a client-side PWM would manufacture an artifact rather than reveal one.'
  ]);
}

/* =============================================================================
   5.  the DIRECTIONAL meta matrix
       rows = protein module, cols = UTR module. It is a matrix and not a meta
       node-link diagram because M1p→M2u = 178 while M2p→M1u = 66; a symmetric
       edge would destroy exactly the asymmetry the analysis is about.
   ============================================================================= */

export function matrixSVG(matrix, opts) {
  opts = opts || {};
  const N = matrix.length;
  const cell = opts.cell || 26, lab = 20, top = 22;
  const w = lab + N * cell + 2, h = top + N * cell + 14;
  let max = 0, total = 0;
  for (const row of matrix) for (const v of row) { if (v > max) max = v; total += v; }

  const svg = el('svg', {
    class: 'g-matrix', viewBox: '0 0 ' + w + ' ' + h, role: 'img',
    'aria-label': 'directional 6 by 6 matrix, rows are protein modules, columns are UTR modules'
  });

  svg.appendChild(el('text', { class: 'g-mx-corner', x: 0, y: 8 }, 'prot ↓'));
  svg.appendChild(el('text', { class: 'g-mx-corner', x: lab, y: 8 }, 'UTR module →'));

  for (let c = 0; c < N; c++) {
    const g = el('g', { class: 'g-mx-head ' + modClass(c + 1), role: 'button', tabindex: '0',
      'aria-label': 'focus UTR module M' + (c + 1) });
    g.appendChild(el('rect', { x: lab + c * cell, y: top - 8, width: cell, height: 7,
      style: { fill: 'var(--mc)' }, rx: 1.5 }));
    g.appendChild(el('text', { class: 'g-mx-axis', x: lab + c * cell + cell / 2, y: top - 10,
      'text-anchor': 'middle' }, 'M' + (c + 1)));
    if (opts.onModule) {
      g.addEventListener('click', () => opts.onModule(c + 1));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ')
        { ev.preventDefault(); opts.onModule(c + 1); } });
    }
    svg.appendChild(g);
  }

  for (let r = 0; r < N; r++) {
    const g = el('g', { class: 'g-mx-head ' + modClass(r + 1), role: 'button', tabindex: '0',
      'aria-label': 'focus protein module M' + (r + 1) });
    g.appendChild(el('rect', { x: 0, y: top + r * cell + 3, width: 6, height: cell - 6,
      style: { fill: 'var(--mc)' }, rx: 1.5 }));
    g.appendChild(el('text', { class: 'g-mx-axis', x: 9, y: top + r * cell + cell / 2 + 3 }, 'M' + (r + 1)));
    if (opts.onModule) {
      g.addEventListener('click', () => opts.onModule(r + 1));
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ')
        { ev.preventDefault(); opts.onModule(r + 1); } });
    }
    svg.appendChild(g);
  }

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const v = matrix[r][c];
      const x = lab + c * cell, y = top + r * cell;
      const t = max ? Math.sqrt(v / max) : 0;
      const active = opts.pair && opts.pair[0] === r + 1 && opts.pair[1] === c + 1;
      const g = el('g', {
        class: 'g-mx-cell ' + modClass(r + 1), role: 'button', tabindex: '0',
        'aria-pressed': String(!!active),
        'aria-label': 'M' + (r + 1) + ' protein to M' + (c + 1) + ' UTR: ' + v + ' edges'
      });
      g.appendChild(el('title', 'M' + (r + 1) + ' protein clusters → M' + (c + 1) + ' UTR clusters: ' +
        fmt.int(v) + (r === c ? ' within-module edges' : ' cross-module edges') +
        '  ·  the reverse direction (M' + (c + 1) + ' protein → M' + (r + 1) + ' UTR) is ' +
        fmt.int(matrix[c][r])));
      g.appendChild(el('rect', { class: 'fillc', x, y, width: cell - 1, height: cell - 1, rx: 2,
        style: { fill: v ? 'var(--mc)' : 'var(--surface-2)', fillOpacity: v ? (0.14 + 0.86 * t) : 1 } }));
      if (v) {
        g.appendChild(el('text', {
          x: x + (cell - 1) / 2, y: y + (cell - 1) / 2 + 3,
          style: { fill: t > 0.55 ? 'var(--mci)' : 'var(--ink-2)' }
        }, String(v)));
      }
      if (r === c) g.appendChild(el('rect', { class: 'g-mx-diag', x: x + 0.5, y: y + 0.5,
        width: cell - 2, height: cell - 2, rx: 2 }));
      if (opts.onCell) {
        g.addEventListener('click', () => opts.onCell(r + 1, c + 1, v));
        g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ')
          { ev.preventDefault(); opts.onCell(r + 1, c + 1, v); } });
      }
      svg.appendChild(g);
    }
  }

  svg.appendChild(el('text', { class: 'g-mx-corner', x: 0, y: h - 3 },
    'dashed = within-module · ' + fmt.int(total) + ' edges placed'));
  return svg;
}

/* =============================================================================
   6.  deterministic 2-D projection of the 20-bin positional profile.
       This is NOT a UMAP: no embedding ships in any payload. It is a PCA of the
       position histogram, computed here, and the view says so in words.
   ============================================================================= */

export function profileProjection(nodes) {
  const d = 20, n = nodes.length;
  if (!n) return [];
  const mean = new Float64Array(d);
  const X = nodes.map(nd => {
    const v = new Float64Array(d);
    const p = nd.pos || [];
    for (let i = 0; i < d; i++) v[i] = Number(p[i]) || 0;
    return v;
  });
  for (const v of X) for (let i = 0; i < d; i++) mean[i] += v[i] / n;
  for (const v of X) for (let i = 0; i < d; i++) v[i] -= mean[i];

  // covariance (20x20)
  const C = [];
  for (let i = 0; i < d; i++) C.push(new Float64Array(d));
  for (const v of X) for (let i = 0; i < d; i++) { const vi = v[i]; for (let j = i; j < d; j++) C[i][j] += vi * v[j]; }
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { C[i][j] /= (n - 1 || 1); C[j][i] = C[i][j]; }

  const e1 = power(C, d, 0);
  deflate(C, d, e1.vec, e1.val);
  const e2 = power(C, d, 1);

  return X.map((v, k) => {
    let a = 0, b = 0;
    for (let i = 0; i < d; i++) { a += v[i] * e1.vec[i]; b += v[i] * e2.vec[i]; }
    return { node: nodes[k], x: a, y: b };
  });
}

function power(C, d, seedIdx) {
  let v = new Float64Array(d);
  for (let i = 0; i < d; i++) v[i] = Math.cos(0.7 * (i + 1) + seedIdx * 1.3) + 1.05;   // deterministic
  norm(v, d);
  let val = 0;
  for (let it = 0; it < 260; it++) {
    const w = new Float64Array(d);
    for (let i = 0; i < d; i++) { let s = 0; const Ci = C[i]; for (let j = 0; j < d; j++) s += Ci[j] * v[j]; w[i] = s; }
    val = norm(w, d);
    v = w;
  }
  return { vec: v, val };
}
function norm(v, d) {
  let s = 0; for (let i = 0; i < d; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  for (let i = 0; i < d; i++) v[i] /= s;
  return s;
}
function deflate(C, d, vec, val) {
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) C[i][j] -= val * vec[i] * vec[j];
}

/* =============================================================================
   7.  THE CANVAS
       One renderer object per mount. ctx supplies the data and the callbacks;
       the renderer owns the SVG, the hit index and the highlight state.
   ============================================================================= */

const PAD = 26;

/**
 * renderCanvas(host, ctx) -> controller
 *   ctx = { mode, net, nodes, edges, enc, encDomain, module, pair, sel, hover,
 *           width, height, onPick(id|null), onHover(id|null) }
 *   controller = { svg, setFocus(id), destroy() }
 */
export function renderCanvas(host, ctx) {
  clear(host);
  const W = Math.max(320, ctx.width || 820);
  const H = ctx.height || Math.round(Math.min(760, Math.max(420, W * 0.72)));

  const svg = el('svg', {
    class: 'g-canvas', viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
    tabindex: '0', role: 'application',
    'aria-label': ctx.aria || 'motif cluster network'
  });
  const gEdge = el('g', { class: 'lay-edge' });
  const gDeco = el('g', { class: 'lay-deco' });
  const gNode = el('g', { class: 'lay-node' });
  const gTop = el('g', { class: 'lay-top' });
  append(svg, [gDeco, gEdge, gNode, gTop]);

  const hitNodes = [];     // {x, y, r, id}
  const hitEdges = [];     // {x1,y1,x2,y2,id}
  const elByNode = new Map();
  const elByEdge = new Map();

  const paint = MODES[ctx.mode] || MODES.module;
  const info = paint({ svg, gEdge, gDeco, gNode, gTop, W, H, ctx, hitNodes, hitEdges, elByNode, elByEdge });

  host.appendChild(svg);

  /* ---- tooltip --------------------------------------------------------- */
  const tip = el('div.g-tip', { hidden: true });
  host.appendChild(tip);

  /* ---- hit testing ------------------------------------------------------ */
  function toLocal(ev) {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  }
  function pick(pt) {
    let best = null, bestD = Infinity;
    for (const n of hitNodes) {
      const dx = pt.x - n.x, dy = pt.y - n.y, d = dx * dx + dy * dy;
      const rad = Math.max(n.r + 3, 6);
      if (d < rad * rad && d < bestD) { best = { kind: 'node', id: n.id }; bestD = d; }
    }
    if (best) return best;
    const TOL = 7;
    bestD = TOL * TOL;
    for (const e of hitEdges) {
      const d = segDist2(pt.x, pt.y, e.x1, e.y1, e.x2, e.y2);
      if (d < bestD) { bestD = d; best = { kind: 'edge', id: e.id }; }
    }
    return best;
  }

  let hoverId = null;
  let raf = 0, pending = null;

  function onMove(ev) {
    pending = ev;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const ev2 = pending; pending = null;
      if (!ev2) return;
      const pt = toLocal(ev2);
      const hit = pick(pt);
      const id = hit ? hit.id : null;
      if (id !== hoverId) {
        hoverId = id;
        setFocus(ctx.sel || hoverId, !!(ctx.sel && ctx.sel !== hoverId));
        svg.style.cursor = id ? 'pointer' : 'default';
        if (ctx.onHover) ctx.onHover(id);
      }
      if (id) showTip(id, ev2);
      else tip.hidden = true;
    });
  }

  function showTip(id, ev) {
    const body = ctx.tipFor ? ctx.tipFor(id) : null;
    if (!body) { tip.hidden = true; return; }
    clear(tip); append(tip, body);
    tip.hidden = false;
    const hr = host.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = ev.clientX - hr.left + 14, y = ev.clientY - hr.top + 14;
    if (x + tw > hr.width - 4) x = Math.max(4, ev.clientX - hr.left - tw - 12);
    if (y + th > hr.height - 4) y = Math.max(4, ev.clientY - hr.top - th - 12);
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  function onLeave() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    hoverId = null; pending = null;
    tip.hidden = true;
    setFocus(ctx.sel || null, false);
    if (ctx.onHover) ctx.onHover(null);
  }

  function onClick(ev) {
    const hit = pick(toLocal(ev));
    if (ctx.onPick) ctx.onPick(hit ? hit.id : null);
  }

  /* keyboard: the canvas is a graphical enhancement, but it stays reachable —
     ←/→ walk the node list in draw order, Enter selects, Esc clears. The rails
     below the canvas remain the fully accessible path to the same data. */
  let kbIdx = -1;
  function onKey(ev) {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      if (!hitNodes.length) return;
      kbIdx = (kbIdx + (ev.key === 'ArrowRight' ? 1 : -1) + hitNodes.length) % hitNodes.length;
      const id = hitNodes[kbIdx].id;
      setFocus(id, false);
      if (ctx.onHover) ctx.onHover(id);
    } else if (ev.key === 'Enter' && kbIdx >= 0) {
      ev.preventDefault();
      if (ctx.onPick) ctx.onPick(hitNodes[kbIdx].id);
    } else if (ev.key === 'Escape') {
      if (ctx.onPick) ctx.onPick(null);
    }
  }

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKey);

  /* ---- focus / dim ------------------------------------------------------ */
  let onEls = [];
  function setFocus(id, keepSel) {
    for (const e of onEls) e.classList.remove('on');
    onEls = [];
    if (!id) { svg.classList.remove('is-focused'); return; }
    svg.classList.add('is-focused');
    if (isEdgeId(id)) {
      const le = elByEdge.get(id);
      if (le) { le.classList.add('on'); onEls.push(le); }
      const [p, u] = id.split('~');
      for (const nid of [p, u]) {
        const ne = elByNode.get(nid);
        if (ne) { ne.classList.add('on'); onEls.push(ne); }
      }
    } else {
      const ne = elByNode.get(id);
      if (ne) { ne.classList.add('on'); onEls.push(ne); }
      for (const e of ctx.edges) {
        if (e.p === id || e.u === id) {
          const le = elByEdge.get(edgeKey(e));
          if (le) { le.classList.add('on'); onEls.push(le); }
          const other = elByNode.get(e.p === id ? e.u : e.p);
          if (other) { other.classList.add('on'); onEls.push(other); }
        }
      }
    }
    void keepSel;
  }

  if (ctx.sel) setFocus(ctx.sel, false);

  return {
    svg,
    info: info || {},
    elByNode, elByEdge,
    setFocus,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      svg.removeEventListener('mousemove', onMove);
      svg.removeEventListener('mouseleave', onLeave);
      svg.removeEventListener('click', onClick);
      svg.removeEventListener('keydown', onKey);
    }
  };
}

function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

/* =============================================================================
   7a.  mode: FULL — all 519 nodes at the frozen seed-7 spring coordinates.
   ============================================================================= */

const MODES = {};

MODES.full = function (S) {
  const { gEdge, gNode, W, H, ctx, hitNodes, hitEdges, elByNode, elByEdge } = S;
  const sx = v => PAD + (v / 1000) * (W - 2 * PAD);
  const sy = v => PAD + (v / 1000) * (H - 2 * PAD);
  const nmax = ctx.nmax || 1;
  const dom = ctx.encDomain;
  const shown = new Set(ctx.nodes.map(n => n.id));

  for (const e of ctx.edges) {
    const a = ctx.net.byId.get(e.p), b = ctx.net.byId.get(e.u);
    if (!a || !b || !shown.has(a.id) || !shown.has(b.id)) continue;
    const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(b.x), y2 = sy(b.y);
    const hot = ctx.pair && e.x && a.m === ctx.pair[0] && b.m === ctx.pair[1];
    const line = el('line', {
      class: 'g-edge ' + (e.x ? 'cross ' : modClass(a.m) + ' ') + (e.cons ? '' : 'dashed'),
      x1, y1, x2, y2,
      style: {
        stroke: e.x ? null : 'var(--mc)',
        strokeWidth: edgeWidth(e, ctx.enc, dom, 0.45, 3.4),
        strokeOpacity: hot ? 0.95 : (e.x ? 0.42 : 0.3)
      }
    });
    gEdge.appendChild(line);
    elByEdge.set(edgeKey(e), line);
    hitEdges.push({ x1, y1, x2, y2, id: edgeKey(e) });
  }

  for (const n of ctx.nodes) {
    const x = sx(n.x), y = sy(n.y), r = nodeRadius(n.n, nmax);
    const p = el('path', {
      class: 'g-node ring ' + modClass(n.m) + ' ' + regClass(n.r) + (n.id === ctx.sel ? ' sel' : ''),
      d: markPathD(n.r, x, y, r), dataset: { id: n.id, cx: x.toFixed(1), cy: y.toFixed(1) },
      style: { fill: 'var(--mc)' }
    });
    gNode.appendChild(p);
    elByNode.set(n.id, p);
    hitNodes.push({ x, y, r, id: n.id });
  }

  // the reserved strip for the three isolated dyads is labelled, never hidden
  const outY = sy(978);
  if (ctx.nodes.some(n => n.y > 960)) {
    S.gDeco.appendChild(el('line', { class: 'g-axis', x1: PAD, y1: outY - 16, x2: W - PAD, y2: outY - 16,
      style: { strokeDasharray: '3 4' } }));
    S.gDeco.appendChild(el('text', { class: 'g-lab dimx', x: PAD, y: outY - 24 },
      'outside every module — 3 isolated dyads, placed not simulated'));
  }
  return { drawn: ctx.nodes.length };
};

/* =============================================================================
   7b.  mode: MODULE — one module's bipartite drill-down at the frozen x2/y2,
        protein column left, UTR column right, cross-module edges as labelled
        stubs into the gutters. Max 133 nodes, so a hairball is impossible.
   ============================================================================= */

MODES.module = function (S) {
  const { gEdge, gDeco, gNode, gTop, W, H, ctx, hitNodes, hitEdges, elByNode, elByEdge } = S;
  const m = ctx.module;
  const GUT = Math.min(78, Math.max(46, W * 0.09));  // gutter for cross-module stubs
  const innerL = GUT, innerR = W - GUT;
  const span = innerR - innerL;
  /* The frozen part of the bake's bipartite layout is the ROW ORDER (y2, from 24
     deterministic barycenter sweeps). x2 is only the constant pair 250 / 750, so
     the two column positions are placed here to leave room for the glyph band. */
  const colX = v => innerL + (v < 500 ? 0.33 : 0.67) * span;
  const sy = v => 40 + ((v - 46) / 908) * (H - 58);
  const nmax = ctx.nmax || 1;
  const dom = ctx.encDomain;
  const XP = colX(250), XU = colX(750);

  const inModule = new Set(ctx.nodes.filter(n => n.m === m).map(n => n.id));

  gDeco.appendChild(el('text', { class: 'g-colhead', x: XP, y: 16, 'text-anchor': 'middle' },
    'protein clusters'));
  gDeco.appendChild(el('text', { class: 'g-colhead', x: XU, y: 16, 'text-anchor': 'middle' },
    'UTR clusters'));
  for (const cx of [XP, XU]) {
    gDeco.appendChild(el('line', { class: 'g-axis', x1: cx, y1: 26, x2: cx, y2: H - 6,
      style: { strokeDasharray: '2 5', strokeOpacity: .7 } }));
  }

  // ---- internal edges
  const stubs = [];                                  // cross-module, drawn after
  for (const e of ctx.edges) {
    const a = ctx.net.byId.get(e.p), b = ctx.net.byId.get(e.u);
    if (!a || !b) continue;
    const ain = inModule.has(a.id), bin = inModule.has(b.id);
    if (!ain && !bin) continue;
    if (ain && bin) {
      const x1 = colX(a.x2), y1 = sy(a.y2), x2 = colX(b.x2), y2 = sy(b.y2);
      const line = el('line', {
        class: 'g-edge ' + modClass(m) + (e.cons ? '' : ' dashed'),
        x1, y1, x2, y2,
        style: { stroke: 'var(--mc)', strokeWidth: edgeWidth(e, ctx.enc, dom, 0.5, 4.2),
                 strokeOpacity: .34 }
      });
      gEdge.appendChild(line);
      elByEdge.set(edgeKey(e), line);
      hitEdges.push({ x1, y1, x2, y2, id: edgeKey(e) });
    } else if (ctx.showCross) {
      stubs.push({ e, inNode: ain ? a : b, outNode: ain ? b : a, side: ain ? 'right' : 'left' });
    }
  }

  // ---- cross-module stubs: short, labelled with the module they leave for
  const gutter = { left: new Map(), right: new Map() };
  for (const s of stubs) {
    const n0 = s.inNode;
    const x0 = colX(n0.x2), y0 = sy(n0.y2);
    const toEdge = s.side === 'right' ? innerR + 8 : innerL - 8;
    const tip = s.side === 'right' ? Math.min(W - 4, toEdge + 26) : Math.max(4, toEdge - 26);
    const hot = ctx.pair && ((s.side === 'right' && ctx.pair[0] === m && s.outNode.m === ctx.pair[1]) ||
                             (s.side === 'left' && ctx.pair[1] === m && s.outNode.m === ctx.pair[0]));
    const line = el('polyline', {
      class: 'g-edge cross ' + modClass(s.outNode.m) + (s.e.cons ? '' : ' dashed'),
      points: x0 + ',' + y0 + ' ' + toEdge + ',' + y0 + ' ' + tip + ',' + y0,
      style: { stroke: 'var(--mc)', strokeWidth: edgeWidth(s.e, ctx.enc, dom, 0.5, 3.2),
               strokeOpacity: hot ? 0.95 : 0.45 }
    });
    gEdge.appendChild(line);
    elByEdge.set(edgeKey(s.e), line);
    hitEdges.push({ x1: x0, y1: y0, x2: tip, y2: y0, id: edgeKey(s.e) });
    const bag = gutter[s.side];
    bag.set(s.outNode.m, (bag.get(s.outNode.m) || 0) + 1);
  }

  // gutter tallies — a stub is never anonymous
  const tallyRight = [...gutter.right.entries()].sort((a, b) => b[1] - a[1]);
  const tallyLeft = [...gutter.left.entries()].sort((a, b) => b[1] - a[1]);
  tallyRight.forEach(([mm, c], i) => {
    gTop.appendChild(el('text', { class: 'g-gutter ' + modClass(mm), x: W - 3, y: 40 + i * 12,
      'text-anchor': 'end', style: { fill: 'var(--mc)' } }, '→M' + mm + ' ' + c));
  });
  tallyLeft.forEach(([mm, c], i) => {
    gTop.appendChild(el('text', { class: 'g-gutter ' + modClass(mm), x: 3, y: 40 + i * 12,
      style: { fill: 'var(--mc)' } }, 'M' + mm + '→ ' + c));
  });
  if (tallyRight.length) gTop.appendChild(el('text', { class: 'g-lab dimx', x: W - 3, y: 28,
    'text-anchor': 'end' }, 'UTR elsewhere'));
  if (tallyLeft.length) gTop.appendChild(el('text', { class: 'g-lab dimx', x: 3, y: 28 },
    'protein elsewhere'));

  // ---- nodes, with the full glyph inline (this is the level-of-detail payoff)
  const rows = ctx.nodes.filter(n => n.m === m);
  const nProt = rows.filter(n => n.r === 'protein').length;
  const maxCol = Math.max(1, nProt, rows.length - nProt);
  const rowH = (H - 58) * (908 / 1000) / Math.max(1, maxCol - 1);
  const showText = rowH >= 9;
  const showGlyph = rowH >= 12;
  const BAND = 88;                                   // consensus + coverage band
  for (const n of rows) {
    const isProt = n.r === 'protein';
    const x = isProt ? XP : XU, y = sy(n.y2), r = nodeRadius(n.n, nmax, 0.92);
    const p = el('path', {
      class: 'g-node ring ' + modClass(n.m) + ' ' + regClass(n.r) + (n.id === ctx.sel ? ' sel' : ''),
      d: markPathD(n.r, x, y, r), dataset: { id: n.id, cx: x.toFixed(1), cy: y.toFixed(1) },
      style: { fill: 'var(--mc)' }
    });
    gNode.appendChild(p);
    elByNode.set(n.id, p);
    hitNodes.push({ x, y, r, id: n.id });
    if (!showText) continue;

    // [ gutter | coverage | consensus | name | NODE ]   (mirrored on the UTR side)
    const bandStart = isProt ? innerL + 2 : innerR - 2;
    const dir = isProt ? 1 : -1;
    const nameEdge = isProt ? x - r - 7 : x + r + 7;
    const nameRoom = Math.max(24, dir * (nameEdge - (bandStart + dir * (showGlyph ? BAND : 0))));
    const raw = n.name || n.id;
    const budget = Math.floor(nameRoom / 4.9);
    const label = raw.length > budget ? raw.slice(0, Math.max(3, budget - 1)) + '…' : raw;
    gNode.appendChild(el('text', { class: 'g-lab', x: nameEdge, y,
      'text-anchor': isProt ? 'end' : 'start' }, label));
    if (!showGlyph) continue;

    const barX = isProt ? bandStart : bandStart - 26;
    if (n.cons) {
      gNode.appendChild(el('rect', { x: barX, y: y - 2.5, width: 26, height: 5, rx: 2.5,
        style: { fill: 'var(--surface-3)' } }));
      gNode.appendChild(el('rect', { class: regClass(n.r), x: barX, y: y - 2.5,
        width: Math.max(0.8, 26 * (n.cov || 0)), height: 5, rx: 2.5,
        style: { fill: 'var(--rc)' } }));
      gNode.appendChild(el('text', {
        class: 'g-lab-id', x: bandStart + dir * 31, y,
        'text-anchor': isProt ? 'start' : 'end'
      }, displaySeq(String(n.cons).slice(0, 10), n.r)));
    } else {
      gNode.appendChild(el('rect', { class: 'g-hatch', x: barX, y: y - 3, width: 26, height: 6,
        rx: 2, style: { fill: 'none', strokeDasharray: '2 2' } }));
      gNode.appendChild(el('text', { class: 'g-lab-id', x: bandStart + dir * 31, y,
        'text-anchor': isProt ? 'start' : 'end', style: { fillOpacity: .75 } }, 'no consensus'));
    }
  }
  return { drawn: rows.length, crossRight: tallyRight, crossLeft: tallyLeft, rowH };
};

/* =============================================================================
   7c.  mode: MATRIX — the seriated cluster-level adjacency.
        Rows = 201 protein clusters, cols = 318 UTR clusters, only the 2,620
        non-zero cells drawn. Row/column order is a DISPLAY ordering computed
        here (module block, then barycenter); it carries no meaning and says so.
   ============================================================================= */

MODES.matrix = function (S) {
  const { gEdge, gDeco, gTop, W, H, ctx, hitEdges, elByEdge } = S;
  const prot = ctx.nodes.filter(n => n.r === 'protein');
  const utr = ctx.nodes.filter(n => n.r !== 'protein');
  if (!prot.length || !utr.length) return { drawn: 0 };

  const order = seriate(prot, utr, ctx.edges);
  const pIx = new Map(order.prot.map((n, i) => [n.id, i]));
  const uIx = new Map(order.utr.map((n, i) => [n.id, i]));

  const left = 30, top = 30, right = 10, bot = 16;
  const cw = (W - left - right) / order.utr.length;
  const ch = (H - top - bot) / order.prot.length;
  const dom = ctx.encDomain;

  // module bands on both axes
  for (let i = 0; i < order.prot.length; i++) {
    gDeco.appendChild(el('rect', { class: modClass(order.prot[i].m), x: left - 8, y: top + i * ch,
      width: 6, height: Math.max(1, ch - 0.3), style: { fill: 'var(--mc)', fillOpacity: .85 } }));
  }
  for (let j = 0; j < order.utr.length; j++) {
    gDeco.appendChild(el('rect', { class: modClass(order.utr[j].m), x: left + j * cw, y: top - 8,
      width: Math.max(1, cw - 0.3), height: 6, style: { fill: 'var(--mc)', fillOpacity: .85 } }));
  }
  gTop.appendChild(el('text', { class: 'g-colhead', x: left, y: 14 },
    'UTR clusters →  (' + order.utr.length + ')'));
  gTop.appendChild(el('text', { class: 'g-colhead', x: 4, y: top + 4,
    transform: 'rotate(-90 4 ' + (top + 4) + ')', 'text-anchor': 'end' },
    'protein clusters ↓ (' + order.prot.length + ')'));

  for (const e of ctx.edges) {
    const i = pIx.get(e.p), j = uIx.get(e.u);
    if (i == null || j == null) continue;
    const x = left + j * cw, y = top + i * ch;
    const w = Math.max(2, cw - 0.25), h = Math.max(2, ch - 0.25);
    const t = scale(e[ctx.enc], dom[0], dom[1], 0.25, 1);
    const r = el('rect', {
      class: 'g-edge ' + (e.x ? 'cross ' : modClass(ctx.net.byId.get(e.p).m)),
      x, y, width: w, height: h,
      style: { fill: e.x ? 'var(--ink-2)' : 'var(--mc)', fillOpacity: t,
               stroke: e.cons ? 'none' : 'var(--ink-3)',
               strokeWidth: e.cons ? 0 : 0.4, strokeDasharray: e.cons ? null : '1 1' }
    });
    gEdge.appendChild(r);
    elByEdge.set(edgeKey(e), r);
    hitEdges.push({ x1: x + w / 2, y1: y + h / 2, x2: x + w / 2, y2: y + h / 2, id: edgeKey(e) });
  }
  return { drawn: ctx.edges.length, seriation: order.note };
};

/** Module block order, then 8 deterministic barycenter sweeps inside each block. */
function seriate(prot, utr, edges) {
  const pAdj = new Map(prot.map(n => [n.id, []]));
  const uAdj = new Map(utr.map(n => [n.id, []]));
  for (const e of edges) {
    if (pAdj.has(e.p) && uAdj.has(e.u)) { pAdj.get(e.p).push(e.u); uAdj.get(e.u).push(e.p); }
  }
  const byModule = (a, b) => (a.m || 99) - (b.m || 99) || (a.id < b.id ? -1 : 1);
  let P = prot.slice().sort(byModule);
  let U = utr.slice().sort(byModule);
  for (let s = 0; s < 8; s++) {
    const uPos = new Map(U.map((n, i) => [n.id, i]));
    P = P.map(n => {
      const a = pAdj.get(n.id);
      const bc = a.length ? a.reduce((t, id) => t + (uPos.get(id) || 0), 0) / a.length : 1e9;
      return { n, bc };
    }).sort((x, y) => (x.n.m || 99) - (y.n.m || 99) || x.bc - y.bc || (x.n.id < y.n.id ? -1 : 1))
      .map(d => d.n);
    const pPos = new Map(P.map((n, i) => [n.id, i]));
    U = U.map(n => {
      const a = uAdj.get(n.id);
      const bc = a.length ? a.reduce((t, id) => t + (pPos.get(id) || 0), 0) / a.length : 1e9;
      return { n, bc };
    }).sort((x, y) => (x.n.m || 99) - (y.n.m || 99) || x.bc - y.bc || (x.n.id < y.n.id ? -1 : 1))
      .map(d => d.n);
  }
  return { prot: P, utr: U, note: '8 barycenter sweeps inside module blocks' };
}

/* =============================================================================
   7d.  mode: PROFILE — the deterministic positional-profile projection.
   ============================================================================= */

MODES.profile = function (S) {
  const { gDeco, gEdge, gNode, W, H, ctx, hitNodes, hitEdges, elByNode, elByEdge } = S;
  const proj = profileProjection(ctx.nodes);
  if (!proj.length) return { drawn: 0 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of proj) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  const sx = v => scale(v, x0, x1, PAD + 8, W - PAD - 8);
  const sy = v => scale(v, y1, y0, PAD + 8, H - PAD - 18);
  const nmax = ctx.nmax || 1;

  gDeco.appendChild(el('line', { class: 'g-axis', x1: PAD, y1: H - PAD, x2: W - PAD, y2: H - PAD }));
  gDeco.appendChild(el('line', { class: 'g-axis', x1: PAD, y1: PAD, x2: PAD, y2: H - PAD }));
  gDeco.appendChild(el('text', { class: 'g-lab dimx', x: W - PAD, y: H - PAD + 12, 'text-anchor': 'end' },
    'PC1 of the 20-bin position histogram'));
  gDeco.appendChild(el('text', { class: 'g-lab dimx', x: PAD - 6, y: PAD + 2,
    transform: 'rotate(-90 ' + (PAD - 6) + ' ' + (PAD + 2) + ')' }, 'PC2'));

  // edges are drawn very faintly: they are not what this projection is about,
  // but hiding them would make the counts line describe something not on screen
  const at = new Map(proj.map(p => [p.node.id, p]));
  for (const e of ctx.edges) {
    const a = at.get(e.p), b = at.get(e.u);
    if (!a || !b) continue;
    const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(b.x), y2 = sy(b.y);
    const line = el('line', {
      class: 'g-edge ' + (e.x ? 'cross ' : modClass(ctx.net.byId.get(e.p).m) + ' ') +
             (e.cons ? '' : 'dashed'),
      x1, y1, x2, y2,
      style: { stroke: e.x ? null : 'var(--mc)', strokeWidth: 0.5, strokeOpacity: 0.08 }
    });
    gEdge.appendChild(line);
    elByEdge.set(edgeKey(e), line);
    hitEdges.push({ x1, y1, x2, y2, id: edgeKey(e) });
  }

  for (const p of proj) {
    const n = p.node, x = sx(p.x), y = sy(p.y), r = nodeRadius(n.n, nmax, 0.85);
    const e = el('path', {
      class: 'g-node ring ' + modClass(n.m) + ' ' + regClass(n.r) + (n.id === ctx.sel ? ' sel' : ''),
      d: markPathD(n.r, x, y, r), dataset: { id: n.id, cx: x.toFixed(1), cy: y.toFixed(1) },
      style: { fill: 'var(--mc)', fillOpacity: .82 }
    });
    gNode.appendChild(e);
    elByNode.set(n.id, e);
    hitNodes.push({ x, y, r, id: n.id });
  }
  return { drawn: proj.length };
};

/* =============================================================================
   8.  glyph rows for the rails (the sortable strip that tames a degree-62 hub)
   ============================================================================= */

/**
 * nodeRow(node, {right:[...], selected, onPick, sub})
 * A full node glyph: mark (region+module+size) · name · consensus · coverage ·
 * sparkline · caller-supplied numbers.
 */
export function nodeRow(node, opts) {
  opts = opts || {};
  const btn = el('button.nw-row', {
    type: 'button', 'aria-pressed': String(!!opts.selected),
    title: node.id + ' — ' + (node.name || '') + '  ·  ' + REGION_LABEL[node.r] +
           '  ·  ' + fmt.int(node.n) + ' instances in ' + fmt.int(node.nt) + ' transcripts',
    on: { click: () => opts.onPick && opts.onPick(node.id),
          mouseenter: () => opts.onHover && opts.onHover(node.id),
          mouseleave: () => opts.onHover && opts.onHover(null) }
  }, [
    nodeMark(node, { size: 15 }),
    el('span', { style: { minWidth: 0 } }, [
      el('span', { class: 'gg-name', style: { display: 'block' } }, node.name || node.id),
      el('span.gg-id', node.id + (opts.sub ? ' · ' + opts.sub : ''))
    ]),
    node.cons ? consensusGlyph(node.cons, node.r, { max: 10 }) : noConsensusMark({ label: '⌀' }),
    node.cons ? coverageBar(node.cov, { carriers: node.carriers }) : el('span'),
    el('span', { style: { display: 'flex', gap: 'var(--s3)', alignItems: 'center' } },
      (opts.right || []).concat([sparkline(node.pos, { w: 46, h: 15, region: node.r })]))
  ]);
  return btn;
}

/* =============================================================================
   9.  provenance — the sentence that must accompany every drawn layout
   ============================================================================= */

export function provenanceNote(net, mode) {
  const L = (net && net.meta && net.meta.layout) || {};
  const base = L.note || 'Positions are frozen at build time with a fixed seed.';
  if (mode === 'full') return base;
  if (mode === 'module') {
    return 'The frozen part of this panel is the ROW ORDER: it comes from 24 deterministic ' +
      'barycenter sweeps at build time, over this module’s internal edges only, so a cross-module ' +
      'edge has one endpoint off-panel and is drawn as a labelled stub. The two column positions ' +
      'are a display choice made here to leave room for the consensus band. Vertical distance ' +
      'between two rows carries no meaning.';
  }
  if (mode === 'matrix') {
    return 'Row and column order is a DISPLAY ordering computed in your browser at load time ' +
      '(module blocks, then 8 barycenter sweeps). It is deterministic but carries no biological ' +
      'meaning. Only the 2,620 gated pairs are drawn; every blank cell is a pair that did not pass.';
  }
  return 'This is NOT a UMAP — no embedding ships in any payload, so the atlas will not draw one. ' +
    'It is a deterministic principal-component projection of each cluster’s 20-bin positional ' +
    'histogram, computed in your browser. Two clusters land near each other when their motifs sit ' +
    'at similar relative positions within their region — nothing more. Edges are drawn at very low ' +
    'contrast because this projection says nothing about them; hover a node to pull its edges out.';
}
