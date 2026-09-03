/* =============================================================================
   seqview.js — the mRNA rendering engine behind the gene view.

   Owned by the gene-view agent. It knows nothing about routing, fetching or the
   page chrome: it takes a decoded gene shard, a plain state object and a set of
   callbacks, and draws.

   Two components:
     createOverview(host, model, st, cb)  the whole-transcript stack + brush
     createDetail  (host, model, st, cb)  the brushed window, 'track' or 'read'

   Every coordinate in this file is an mRNA-axis coordinate: 0-based, INCLUSIVE
   both ends, exactly as the shard stores m.ms / m.me. The substring of a motif
   is seq.slice(m.s, m.e + 1) and its pixel width is (e - s + 1). There is no
   other convention anywhere in here.
   ============================================================================= */

import { decodeTrack, ntValue, NT_DOMAIN } from './data.js';
import { el, clear, fmt, displaySeq, moduleColor } from './ui.js';

/* =============================================================================
   0.  styles — injected once, so app.css (shell-owned) is never touched
   ============================================================================= */

const STYLE_ID = 'mirto-seqview-css';

export function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const CSS = `
/* ---- browser shell -------------------------------------------------------- */
.sv { position: relative; }
.sv canvas { display: block; width: 100%; }
.sv-legend { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); align-items: center;
  font-size: var(--fs-xs); color: var(--ink-3); margin-top: var(--s3); }
.sv-legend b { font-weight: 620; color: var(--ink-2); }
.sv-key { display: inline-flex; align-items: center; gap: 5px; }
.sv-swatch { width: 12px; height: 9px; border-radius: 2px; display: inline-block;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.28); }
.sv-swatch.hatch { background-image: repeating-linear-gradient(45deg,
  var(--line-strong) 0 2px, transparent 2px 5px); background-color: var(--surface-2); }

/* ---- brush ---------------------------------------------------------------- */
.sv-brushlayer { position: absolute; left: 0; right: 0; cursor: crosshair; touch-action: none; }
.sv-shade { position: absolute; top: 0; bottom: 0; pointer-events: none;
  background: color-mix(in srgb, var(--bg) 66%, transparent); }
.sv-brush { position: absolute; top: 0; bottom: 0; cursor: grab; box-sizing: border-box;
  border-left: 2px solid var(--accent); border-right: 2px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent); }
.sv-brush:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.sv-brush.drag { cursor: grabbing; }
.sv-handle { position: absolute; top: 0; bottom: 0; width: 13px; cursor: ew-resize; }
.sv-handle.l { left: -7px; } .sv-handle.r { right: -7px; }
.sv-handle::after { content: ''; position: absolute; left: 50%; top: 50%; width: 3px; height: 22px;
  margin: -11px 0 0 -1px; border-radius: 2px; background: var(--accent); opacity: .85; }

/* ---- hover tooltip -------------------------------------------------------- */
.sv-tip { position: absolute; z-index: 40; pointer-events: none; max-width: 320px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-md);
  box-shadow: var(--shadow-2); padding: 7px 10px; font-size: var(--fs-xs); color: var(--ink-2);
  line-height: 1.45; }
.sv-tip b { color: var(--ink); font-weight: 620; }
.sv-tip .k { color: var(--ink-3); }

/* ---- detail: read mode ---------------------------------------------------- */
.sv-read { font-family: var(--font-mono); font-size: 12.5px; width: max-content; min-width: 100%; }
.sv-line { display: grid; grid-template-columns: 9ch 60ch; gap: var(--s3);
  padding: 6px 0; border-top: 1px solid var(--line-soft); align-items: start; }
.sv-line:first-child { border-top: 0; }
.sv-gut { color: var(--ink-3); font-size: var(--fs-xs); text-align: right;
  padding-top: 20px; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* EXACTLY 60ch wide. The per-line NTScore canvas is sized from this element's
   pixel width divided by 60, so any other width silently de-registers the score
   bars from the nucleotides they belong to. */
.sv-body { position: relative; overflow: visible; width: 60ch; }
.sv-lane { position: relative; height: 0; }
.sv-nts { white-space: pre; letter-spacing: 0; line-height: 17px; height: 17px; color: var(--ink); }
/* NOTE ON ORDER: [data-c] and .hit have equal specificity, so .hit must come
   last or a selected span loses its focus ring. */
.sv-seg { border-radius: 2px; }
.sv-seg[data-c] { cursor: pointer; box-shadow: inset 0 0 0 1px var(--seg-line); }
.sv-seg.hit { box-shadow: inset 0 0 0 1px var(--seg-line), 0 0 0 2px var(--accent); }
.sv-aa { position: relative; height: 16px; line-height: 16px; }
/* every ch-positioned element must keep the row's font-size, or 1ch drifts */
.sv-aa i { position: absolute; top: 0; width: 3ch; text-align: center; font-style: normal;
  font-size: inherit; color: var(--ink-2); }
.sv-aa i.stop { color: var(--bad); font-weight: 700; }
.sv-frame { position: relative; height: 5px; }
.sv-frame u { position: absolute; top: 0; width: 1px; height: 4px; background: var(--line-strong);
  text-decoration: none; opacity: .7; }
.sv-ann { position: relative; height: 7px; margin-top: 2px; }
.sv-ann b { position: absolute; top: 0; height: 6px; border-radius: 2px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 22%, transparent); }
.sv-annlab { position: absolute; right: 100%; margin-right: 7px; top: -1px; font-size: 9.5px;
  letter-spacing: .04em; text-transform: uppercase; color: var(--ink-3);
  font-family: var(--font-sans); white-space: nowrap; }
.sv-linecv { display: block; height: 22px; }
.sv-more { text-align: center; padding: var(--s4); color: var(--ink-3); font-size: var(--fs-sm); }

/* ---- detail chrome -------------------------------------------------------- */
.sv-detail-head { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center;
  margin-bottom: var(--s3); }
.sv-win { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink-2);
  font-variant-numeric: tabular-nums; }
.sv-zoom { display: inline-flex; gap: 2px; }
.sv-scroll { overflow-x: auto; overflow-y: hidden; }

/* ---- inspector ------------------------------------------------------------ */
.gv-inspect { position: sticky; top: calc(var(--topbar-h) + var(--s3)); }
.gv-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px var(--s3); font-size: var(--fs-sm); }
.gv-kv dt { color: var(--ink-3); }
.gv-kv dd { margin: 0; color: var(--ink); font-family: var(--font-mono);
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.gv-seqbox { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.5;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm);
  padding: 7px 9px; overflow-wrap: anywhere; margin: var(--s2) 0 var(--s3); }
.gv-annblock { margin-top: var(--s3); }
.gv-annblock h5 { margin: 0 0 4px; font-family: var(--font-sans); font-size: var(--fs-xs);
  text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); font-weight: 700; }
.gv-annblock p { margin: 0 0 4px; font-size: var(--fs-sm); color: var(--ink-2); }
.gv-taglist { display: flex; flex-wrap: wrap; gap: 4px; }
.gv-tag { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: var(--r-full);
  background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2); }
.gv-tag.assay { background: var(--rna-soft); border-color: color-mix(in srgb, var(--rna) 30%, transparent); }
.gv-plddt { height: 7px; border-radius: var(--r-full); background: var(--surface-3);
  overflow: hidden; margin-top: 4px; }
.gv-plddt i { display: block; height: 100%; background: var(--protein); }

/* ---- filter bar ----------------------------------------------------------- */
.gv-filters { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center;
  padding: var(--s3) var(--s4); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); margin-bottom: var(--s4); }
.gv-filters .lab { font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .08em;
  color: var(--ink-3); font-weight: 700; }
.gv-modfilter { display: flex; gap: 4px; flex-wrap: wrap; }
.gv-modfilter button { border: 0; background: none; padding: 0; cursor: pointer; opacity: .42;
  transition: opacity .12s; }
.gv-modfilter button[aria-pressed="true"] { opacity: 1; }
.gv-modfilter button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px;
  border-radius: var(--r-full); }
.gv-slider { display: flex; align-items: center; gap: var(--s2); }
.gv-slider input[type=range] { width: 128px; accent-color: var(--accent); }
.gv-count { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--ink-2);
  font-variant-numeric: tabular-nums; margin-left: auto; }

/* ---- identity header ------------------------------------------------------ */
.gv-id { display: flex; flex-wrap: wrap; gap: var(--s4) var(--s5); align-items: flex-end;
  margin-bottom: var(--s4); }
.gv-id h1 { margin: 0; font-size: var(--fs-2xl); }
.gv-id .subs { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s3); align-items: center;
  margin-top: 6px; font-size: var(--fs-sm); color: var(--ink-2); }
.gv-id .subs .mono { color: var(--ink-2); }
.gv-lenbar { display: flex; height: 8px; border-radius: var(--r-full); overflow: hidden;
  border: 1px solid var(--line); min-width: 220px; }
.gv-tools { margin-left: auto; display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; }

/* ---- page columns --------------------------------------------------------- */
.gv-cols { display: grid; grid-template-columns: minmax(0, 1fr) 372px; gap: var(--s5);
  align-items: start; margin-bottom: var(--s7); }
@media (max-width: 1180px) {
  .gv-cols { grid-template-columns: minmax(0, 1fr); }
  .gv-inspect { position: static; }
}

/* ---- motif table row states ---------------------------------------------- */
table.data tr.gv-sel td { background: var(--accent-soft) !important; }
table.data tr.gv-row { cursor: pointer; }
.gv-dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; vertical-align: -1px;
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.3); }

@media (max-width: 900px) {
  .gv-id .gv-tools { margin-left: 0; width: 100%; }
  .gv-line { grid-template-columns: 7ch 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .gv-modfilter button { transition: none; }
}
`;

/* =============================================================================
   1.  design tokens for canvas
   ============================================================================= */

const TOKEN_KEYS = ['--ink', '--ink-2', '--ink-3', '--line', '--line-soft', '--line-strong',
  '--surface', '--surface-2', '--surface-3', '--bg', '--accent', '--rna', '--rna-soft',
  '--protein', '--protein-soft', '--warn', '--bad',
  '--mod-0', '--mod-1', '--mod-2', '--mod-3', '--mod-4', '--mod-5', '--mod-6',
  '--mod-0-ink', '--mod-1-ink', '--mod-2-ink', '--mod-3-ink', '--mod-4-ink',
  '--mod-5-ink', '--mod-6-ink'];

/** Read the design tokens fresh at draw time so both themes work with no
 *  re-rendering logic — the canvas cannot inherit a CSS variable. */
export function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const T = {};
  for (const k of TOKEN_KEYS) T[k] = (cs.getPropertyValue(k) || '').trim();
  T.mod = m => T['--mod-' + (Number(m) || 0)] || moduleColor(m);
  T.modInk = m => T['--mod-' + (Number(m) || 0) + '-ink'] || pickInk(T, m);
  return T;
}

function fitCanvas(cv, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** A 45° hatch fill meaning "not computed". */
function hatchPattern(ctx, T) {
  const p = document.createElement('canvas');
  p.width = 6; p.height = 6;
  const c = p.getContext('2d');
  c.fillStyle = T['--surface-2'] || '#f3f6f9';
  c.fillRect(0, 0, 6, 6);
  c.strokeStyle = T['--line-strong'] || '#c2ccd8';
  c.lineWidth = 1.1;
  c.beginPath(); c.moveTo(-1, 5); c.lineTo(5, -1); c.moveTo(1, 7); c.lineTo(7, 1); c.stroke();
  return ctx.createPattern(p, 'repeat');
}

/* =============================================================================
   2.  the model — built once per gene
   ============================================================================= */

/**
 * buildModel(shard) -> model
 *   .len5 .lenC .len3 .lenP .mrna     lengths straight out of shard.len
 *   .cds0 .cds1 .u30 .u31             mRNA-axis bounds, inclusive
 *   .mseq                             utr5 + cds + utr3, DNA alphabet as stored
 *   .nt5 .nt3                         Uint8Array quantized NTScore, or null
 *   .motifs                           shard.motifs, already sorted by (ms, me)
 *   .byCluster                        Map cluster id -> [motif index, ...]
 *   .warnings                         [] — anything that did not check out
 */
export function buildModel(g) {
  const L = g.len || {};
  const len5 = L.utr5 | 0, lenC = L.cds | 0, len3 = L.utr3 | 0, lenP = L.protein | 0;
  const seq = g.seq || {};
  const s5 = seq.utr5 || '', sC = seq.cds || '', s3 = seq.utr3 || '', sP = seq.protein || '';
  const mseq = s5 + sC + s3;
  const mrna = L.mrna || mseq.length;
  const warnings = [];

  if (mseq.length !== mrna) warnings.push('seq.utr5+cds+utr3 is ' + mseq.length + ' nt but len.mrna is ' + mrna);
  if (lenC && lenP && lenC !== 3 * lenP + 3) warnings.push('len.cds ' + lenC + ' != 3*len.protein+3 (' + (3 * lenP + 3) + ')');

  const nt5 = decodeTrack(g.nt && g.nt.utr5);
  const nt3 = decodeTrack(g.nt && g.nt.utr3);
  if (nt5 && nt5.length !== len5) warnings.push('nt.utr5 decodes to ' + nt5.length + ', len.utr5 is ' + len5);
  if (nt3 && nt3.length !== len3) warnings.push('nt.utr3 decodes to ' + nt3.length + ', len.utr3 is ' + len3);

  const motifs = Array.isArray(g.motifs) ? g.motifs.slice() : [];
  motifs.sort((a, b) => a.ms - b.ms || a.me - b.me);

  const byCluster = new Map();
  let bad = 0;
  for (let i = 0; i < motifs.length; i++) {
    const m = motifs[i];
    if (!byCluster.has(m.c)) byCluster.set(m.c, []);
    byCluster.get(m.c).push(i);
    // spot-check the coordinate convention on the region-local span
    const rs = m.r === 'protein' ? sP : m.r === 'utr5' ? s5 : s3;
    if (rs && (m.e + 1) > rs.length) bad++;
  }
  if (bad) warnings.push(bad + ' motif spans fall outside their region sequence');

  const model = {
    shard: g,
    len5, lenC, len3, lenP, mrna,
    cds0: len5, cds1: len5 + lenC - 1,
    u30: len5 + lenC, u31: mrna - 1,
    mseq, protein: sP,
    nt5, nt3,
    motifs, byCluster,
    coupling: Array.isArray(g.coupling) ? g.coupling : [],
    warnings
  };

  model.regionAt = p => (p < model.cds0 ? 'utr5' : p <= model.cds1 ? 'cds' : 'utr3');

  /** quantized NTScore at an mRNA position, or -1 where none was computed. */
  model.ntAt = p => {
    if (p < len5) return nt5 ? nt5[p] : -1;
    if (p <= model.cds1) return -1;                 // there is no CDS/protein track
    return nt3 ? (nt3[p - model.u30] !== undefined ? nt3[p - model.u30] : -1) : -1;
  };

  /** motif index covering an mRNA position, or -1. Motifs never overlap. */
  model.motifAt = p => {
    let lo = 0, hi = motifs.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (motifs[mid].ms <= p) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best >= 0 && motifs[best].me >= p ? best : -1;
  };

  /** the amino acid index whose codon covers an mRNA position, or -1. */
  model.aaAt = p => {
    if (p < model.cds0 || p > model.cds1) return -1;
    return Math.floor((p - model.cds0) / 3);
  };

  return model;
}

/** The stored substring of a motif — seq.slice(s, e+1), the only correct slice. */
export function motifString(model, m) {
  const src = m.r === 'protein' ? model.protein
            : m.r === 'utr5' ? (model.shard.seq.utr5 || '')
            : (model.shard.seq.utr3 || '');
  return src.slice(m.s, m.e + 1);
}

/** Motif substring in the display alphabet (T->U for UTRs only). */
export function motifDisplay(model, m) { return displaySeq(motifString(model, m), m.r); }

/* =============================================================================
   3.  filtering — one predicate, used by every panel so the counts always agree
   ============================================================================= */

export function motifPasses(m, st) {
  if (st.mod && (Number(m.m) || 0) !== Number(st.mod)) return false;
  if (Number.isFinite(st.minsc) && st.minsc > -4 && !(m.sc >= st.minsc)) return false;
  if (st.filter === 'annot' && !hasAnnotation(m)) return false;
  if (st.filter === 'coupled' && !(st.coupledClusters && st.coupledClusters.has(m.c))) return false;
  if (st.region && st.region !== 'all') {
    const r = st.region === 'cds' ? 'protein' : st.region;
    if (m.r !== r) return false;
  }
  return true;
}

export function hasAnnotation(m) {
  const a = m.a;
  if (!a) return false;
  for (const k of Object.keys(a)) {
    const v = a[k];
    if (v == null) continue;
    if (typeof v === 'string' && v) return true;
    if (Array.isArray(v) && v.length) return true;
    if (typeof v === 'object' && Object.keys(v).length) return true;
  }
  return false;
}

export function annotationSummary(m) {
  const a = m.a; if (!a) return [];
  const out = [];
  if (a.rbp) {
    let n = 0; for (const k of Object.keys(a.rbp)) n += (a.rbp[k] || []).length;
    if (n) out.push({ k: 'rbp', label: 'RBP', n });
  }
  if (a.mir && a.mir.length) out.push({ k: 'mir', label: 'miRNA', n: a.mir.length });
  if (a.ipr) out.push({ k: 'ipr', label: 'InterPro', n: 1 });
  if (a.upr) out.push({ k: 'upr', label: 'UniProt', n: 1 });
  if (a.mob && a.mob.length) out.push({ k: 'mob', label: 'MobiDB', n: a.mob.length });
  if (a.elm) out.push({ k: 'elm', label: 'ELM', n: 1 });
  if (a.idpo) out.push({ k: 'idpo', label: 'IDPO', n: 1 });
  if (a.sig) out.push({ k: 'sig', label: 'SignalP', n: 1 });
  return out;
}

export function hasDomainAnn(m) { return !!(m.a && (m.a.ipr || (m.a.mob && m.a.mob.length) || m.a.idpo || m.a.sig)); }
export function hasRbpAnn(m) {
  if (!m.a || !m.a.rbp) return false;
  for (const k of Object.keys(m.a.rbp)) if ((m.a.rbp[k] || []).length) return true;
  return false;
}

/* =============================================================================
   4.  the overview — one continuous mRNA axis, proportional widths
   ============================================================================= */

const OV = {
  padL: 58, padR: 12, padT: 4,        // padL is the lane-label gutter
  hRegion: 22, gap1: 7,
  hTicks: 13, gap2: 2,
  hArcs: 46,
  hNt: 52, gap3: 3,
  hAxis: 15
};
OV.yRegion = OV.padT;
OV.yTicks = OV.yRegion + OV.hRegion + OV.gap1;
OV.yArcs = OV.yTicks + OV.hTicks + OV.gap2;
OV.yNt = OV.yArcs + OV.hArcs;
OV.yAxis = OV.yNt + OV.hNt + OV.gap3;
OV.height = OV.yAxis + OV.hAxis;

export function createOverview(host, model, st, cb) {
  ensureStyles();
  cb = cb || {};
  const wrap = el('div.sv');
  const cv = el('canvas', { 'aria-label': 'Whole-transcript overview of ' + (model.shard.symbol || '') });
  const layer = el('div.sv-brushlayer', { tabindex: '-1' });
  const shadeL = el('div.sv-shade'), shadeR = el('div.sv-shade');
  const hL = el('div.sv-handle.l', { 'aria-hidden': 'true' });
  const hR = el('div.sv-handle.r', { 'aria-hidden': 'true' });
  const brush = el('div.sv-brush', {
    tabindex: '0', role: 'slider', 'aria-label': 'Detail window over the transcript',
    'aria-valuemin': '0', 'aria-valuemax': String(model.mrna - 1)
  }, [hL, hR]);
  layer.appendChild(shadeL); layer.appendChild(shadeR); layer.appendChild(brush);
  const tip = el('div.sv-tip', { hidden: true });
  const arcNote = el('span.sv-key');
  wrap.appendChild(cv); wrap.appendChild(layer); wrap.appendChild(tip);
  wrap.appendChild(legend(arcNote));
  host.appendChild(wrap);

  let W = 0, plotX = OV.padL, plotW = 0;
  let geom = { ticks: [], arcs: [] };

  const x = p => plotX + (p / Math.max(1, model.mrna)) * plotW;
  const xw = (a, b) => Math.max(1.4, ((b - a + 1) / Math.max(1, model.mrna)) * plotW);
  const posAt = px => Math.max(0, Math.min(model.mrna - 1,
    Math.round(((px - plotX) / Math.max(1, plotW)) * model.mrna)));

  /* ---- draw ------------------------------------------------------------- */
  function draw() {
    // fitCanvas writes an inline cv.style.width, which beats `.sv canvas
    // { width: 100% }`. So W must never exceed the box we actually sit in:
    // a floor wider than the container paints the plot out through the card
    // edge (a 320 floor overflowed the ~308px card interior at 390px by 12px).
    // Measure first, fall back to a nominal width only when unmeasurable.
    const avail = wrap.clientWidth || host.clientWidth || 0;
    W = avail > 0 ? avail : 900;
    plotW = Math.max(1, W - OV.padL - OV.padR);
    const T = tokens();
    const ctx = fitCanvas(cv, W, OV.height);
    layer.style.top = '0px';
    layer.style.height = OV.height + 'px';
    geom = { ticks: [], arcs: [] };

    drawRegions(ctx, T);
    drawTicks(ctx, T);
    drawArcs(ctx, T);
    arcNote.textContent = model.coupling.length
      ? fmt.int(visibleCoupling(model, st).length) + ' of ' + fmt.int(model.coupling.length) +
        ' gated pairs drawn'
      : 'no gated pair in this transcript';
    drawNt(ctx, T);
    drawAxis(ctx, T);
    laneLabel(ctx, T, OV.yRegion + OV.hRegion / 2, 'regions');
    laneLabel(ctx, T, OV.yTicks + OV.hTicks / 2, 'motifs');
    laneLabel(ctx, T, OV.yArcs + 12, 'pairs');
    // the NTScore lane names itself with its own 0 … −8 axis in the same gutter
    laneLabel(ctx, T, OV.yAxis + 7, 'nt');
    placeBrush();
  }

  /** Lane names live in the left gutter so they never sit on top of data. */
  function laneLabel(ctx, T, y, text) {
    ctx.font = '9.5px ' + sansStack();
    ctx.fillStyle = T['--ink-3'];
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(text, OV.padL - 6, y);
  }

  function drawRegions(ctx, T) {
    const y = OV.yRegion, h = OV.hRegion;
    const blocks = [
      { a: 0, b: model.len5 - 1, label: "5′ UTR", fill: T['--rna-soft'], line: T['--rna'], ink: T['--rna'] },
      { a: model.cds0, b: model.cds1, label: 'CDS', fill: T['--protein-soft'], line: T['--protein'], ink: T['--protein'] },
      { a: model.u30, b: model.u31, label: "3′ UTR", fill: T['--rna-soft'], line: T['--rna'], ink: T['--rna'] }
    ];
    for (const b of blocks) {
      if (b.b < b.a) continue;
      const x0 = x(b.a), w = Math.max(1, x(b.b + 1) - x0);
      ctx.fillStyle = b.fill; ctx.fillRect(x0, y, w, h);
      ctx.strokeStyle = b.line; ctx.globalAlpha = .55; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + .5, y + .5, w - 1, h - 1); ctx.globalAlpha = 1;
      ctx.font = '600 10.5px ' + sansStack();
      const label = b.label + '  ' + fmt.int(b.b - b.a + 1);
      if (ctx.measureText(label).width + 12 < w) {
        ctx.fillStyle = b.ink; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.fillText(label, x0 + w / 2, y + h / 2 + .5);
      }
    }
    // AUG and stop landmarks
    landmark(ctx, T, model.cds0, 'AUG', T['--protein']);
    landmark(ctx, T, model.cds1 - 2, 'stop', T['--bad']);
  }

  function landmark(ctx, T, p, label, color) {
    const px = x(p);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, OV.yRegion - 3); ctx.lineTo(px, OV.yRegion + OV.hRegion + 3); ctx.stroke();
    ctx.font = '700 9px ' + sansStack();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(label, Math.min(W - 12, Math.max(12, px)), OV.yRegion - 3);
  }

  function drawTicks(ctx, T) {
    const y = OV.yTicks, h = OV.hTicks;
    ctx.fillStyle = T['--surface-2'];
    ctx.fillRect(plotX, y, plotW, h);
    for (let i = 0; i < model.motifs.length; i++) {
      const m = model.motifs[i];
      const on = motifPasses(m, st);
      const x0 = x(m.ms), w = xw(m.ms, m.me);
      geom.ticks.push({ i, x0, x1: x0 + w });
      const sel = st.sel === i;
      const lit = st.litClusters && st.litClusters.has(m.c);
      ctx.globalAlpha = on ? (lit || sel ? 1 : .92) : .16;
      ctx.fillStyle = T.mod(m.m);
      ctx.fillRect(x0, y + (m.r === 'protein' ? 0 : 3), w, h - (m.r === 'protein' ? 0 : 3));
      // every span gets its own border: 9,838 same-cluster pairs abut at gap 0
      ctx.globalAlpha = on ? .85 : .14;
      ctx.strokeStyle = T['--surface'];
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + .5, y + (m.r === 'protein' ? 0 : 3) + .5, Math.max(0, w - 1), h - (m.r === 'protein' ? 0 : 3) - 1);
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.strokeStyle = T['--ink']; ctx.lineWidth = 1.6;
        ctx.strokeRect(x0 - 1, y - 2, w + 2, h + 4);
      }
    }
  }

  function drawArcs(ctx, T) {
    const y0 = OV.yArcs;
    const rows = visibleCoupling(model, st);
    if (!rows.length) {
      ctx.font = '11px ' + sansStack();
      ctx.fillStyle = T['--ink-3']; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(model.coupling.length
        ? 'no gated pair matches the current filter'
        : 'no gated protein–UTR pair in this transcript', plotX + plotW / 2, y0 + OV.hArcs / 2);
      return;
    }
    const maxSc = Math.max.apply(null, rows.map(r => r.row.sc)) || 1;
    for (const r of rows) {
      const mp = model.motifs[r.row.p], mu = model.motifs[r.row.u];
      if (!mp || !mu) continue;
      const xa = x(mp.ms) + xw(mp.ms, mp.me) / 2;
      const xb = x(mu.ms) + xw(mu.ms, mu.me) / 2;
      const span = Math.abs(xb - xa);
      const depth = Math.min(OV.hArcs - 4, 10 + span * 0.42);
      const cx = (xa + xb) / 2, cy = y0 + depth * 1.35;
      const lit = st.hoverArc === r.k || st.selArc === r.k;
      ctx.globalAlpha = lit ? 1 : (0.28 + 0.5 * (r.row.sc / maxSc));
      ctx.strokeStyle = T.mod(mp.m);
      ctx.lineWidth = lit ? 2.6 : 1.5;
      ctx.beginPath();
      ctx.moveTo(xa, y0);
      ctx.quadraticCurveTo(cx, cy, xb, y0);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // endpoint pips
      ctx.fillStyle = T.mod(mp.m);
      ctx.beginPath(); ctx.arc(xa, y0, lit ? 3 : 2, 0, 6.284); ctx.fill();
      ctx.fillStyle = T.mod(mu.m);
      ctx.beginPath(); ctx.arc(xb, y0, lit ? 3 : 2, 0, 6.284); ctx.fill();
      geom.arcs.push({ k: r.k, xa, xb, cx, cy, y0 });
    }
  }

  function drawNt(ctx, T) {
    const y = OV.yNt, h = OV.hNt;
    const dom = NT_DOMAIN;
    const yv = v => y + h - ((v - dom[0]) / (dom[1] - dom[0])) * h;

    // frame
    ctx.fillStyle = T['--surface-2']; ctx.fillRect(plotX, y, plotW, h);
    ctx.strokeStyle = T['--line-soft']; ctx.lineWidth = 1;
    for (const g of [-2, -4, -6]) {
      const yy = Math.round(yv(g)) + .5;
      ctx.beginPath(); ctx.moveTo(plotX, yy); ctx.lineTo(plotX + plotW, yy); ctx.stroke();
      ctx.font = '9px ' + sansStack(); ctx.fillStyle = T['--ink-3'];
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(String(g), plotX - 3, yy);          // in the gutter, off the data
    }

    // hatched "not computed" band over the CDS
    const hx0 = x(model.cds0), hx1 = x(model.cds1 + 1);
    ctx.save();
    ctx.fillStyle = hatchPattern(ctx, T);
    ctx.fillRect(hx0, y, Math.max(1, hx1 - hx0), h);
    ctx.restore();
    ctx.font = '700 9.5px ' + sansStack();
    ctx.fillStyle = T['--ink-3']; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const note = 'NTScore not computed for CDS / protein';
    if (ctx.measureText(note).width + 14 < (hx1 - hx0)) ctx.fillText(note, (hx0 + hx1) / 2, y + h / 2);

    // per-pixel min/max envelope + mean line, per UTR
    for (const seg of [[0, model.len5 - 1], [model.u30, model.u31]]) {
      if (seg[1] < seg[0]) continue;
      const px0 = Math.floor(x(seg[0])), px1 = Math.ceil(x(seg[1] + 1));
      const cols = [];
      for (let px = px0; px < px1; px++) {
        const a = Math.max(seg[0], posAtRaw(px)), b = Math.min(seg[1], posAtRaw(px + 1) - 1);
        let mn = Infinity, mx = -Infinity, sum = 0, n = 0;
        for (let p = a; p <= b; p++) {
          const q = model.ntAt(p); if (q < 0) continue;
          const v = ntValue(q);
          if (v < mn) mn = v; if (v > mx) mx = v; sum += v; n++;
        }
        cols.push(n ? { px, mn, mx, mean: sum / n } : null);
      }
      // envelope
      ctx.fillStyle = T['--rna']; ctx.globalAlpha = .22;
      ctx.beginPath();
      let started = false;
      for (const c of cols) { if (!c) continue; if (!started) { ctx.moveTo(c.px, yv(c.mx)); started = true; } else ctx.lineTo(c.px, yv(c.mx)); }
      for (let i = cols.length - 1; i >= 0; i--) { const c = cols[i]; if (!c) continue; ctx.lineTo(c.px, yv(c.mn)); }
      if (started) { ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = 1;
      // mean
      ctx.strokeStyle = T['--rna']; ctx.lineWidth = 1;
      ctx.beginPath(); started = false;
      for (const c of cols) { if (!c) continue; if (!started) { ctx.moveTo(c.px, yv(c.mean)); started = true; } else ctx.lineTo(c.px, yv(c.mean)); }
      if (started) ctx.stroke();
    }

    ctx.strokeStyle = T['--line']; ctx.lineWidth = 1;
    ctx.strokeRect(plotX + .5, y + .5, plotW - 1, h - 1);
    ctx.font = '9px ' + sansStack(); ctx.fillStyle = T['--ink-2'];
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('NTScore 0', plotX - 3, y);
    ctx.textBaseline = 'bottom';
    ctx.fillText('−8', plotX - 3, y + h);
  }

  function posAtRaw(px) {
    return Math.max(0, Math.min(model.mrna, Math.round(((px - plotX) / Math.max(1, plotW)) * model.mrna)));
  }

  function drawAxis(ctx, T) {
    const y = OV.yAxis;
    ctx.strokeStyle = T['--line-strong']; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, y + .5); ctx.lineTo(plotX + plotW, y + .5); ctx.stroke();
    const step = niceStep(model.mrna, plotW);
    ctx.font = '9.5px ' + sansStack(); ctx.fillStyle = T['--ink-3'];
    ctx.textBaseline = 'top';
    for (let p = 0; p <= model.mrna; p += step) {
      const px = x(p);
      ctx.beginPath(); ctx.moveTo(px + .5, y); ctx.lineTo(px + .5, y + 4); ctx.stroke();
      ctx.textAlign = p === 0 ? 'left' : (px > plotX + plotW - 32 ? 'right' : 'center');
      ctx.fillText(fmt.int(p), px, y + 5);
    }
  }

  /* ---- brush ------------------------------------------------------------ */
  function placeBrush() {
    const a = st.win[0], b = st.win[1];
    const x0 = x(a), x1 = x(b + 1);
    brush.style.left = x0 + 'px';
    brush.style.width = Math.max(6, x1 - x0) + 'px';
    shadeL.style.left = '0px'; shadeL.style.width = Math.max(0, x0) + 'px';
    shadeR.style.left = x1 + 'px'; shadeR.style.width = Math.max(0, W - x1) + 'px';
    brush.setAttribute('aria-valuenow', String(a));
    brush.setAttribute('aria-valuetext', fmt.int(a) + ' to ' + fmt.int(b) + ' of ' + fmt.int(model.mrna) + ' nt');
  }

  function setWin(a, b, quiet) {
    const span = Math.max(30, Math.min(model.mrna, Math.round(b - a + 1)));
    let s = Math.max(0, Math.min(model.mrna - span, Math.round(a)));
    st.win = [s, s + span - 1];
    placeBrush();
    if (!quiet && cb.onWindow) cb.onWindow(st.win.slice());
  }

  let drag = null;
  layer.addEventListener('pointerdown', e => {
    const r = layer.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = e.target;
    if (t === hL || t === hR) {
      drag = { mode: t === hL ? 'l' : 'r' };
    } else if (t === brush) {
      drag = { mode: 'move', px, a0: st.win[0], b0: st.win[1] };
    } else {
      // click on the track: centre a window of the current width there
      const span = st.win[1] - st.win[0] + 1;
      const c = posAt(px);
      setWin(c - span / 2, c + span / 2 - 1);
      drag = { mode: 'move', px, a0: st.win[0], b0: st.win[1] };
    }
    brush.classList.add('drag');
    layer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  layer.addEventListener('pointermove', e => {
    const r = layer.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (!drag) { hover(px, e.clientY - r.top); return; }
    if (drag.mode === 'move') {
      const d = ((px - drag.px) / Math.max(1, plotW)) * model.mrna;
      setWin(drag.a0 + d, drag.b0 + d);
    } else if (drag.mode === 'l') {
      setWin(Math.min(posAt(px), st.win[1] - 29), st.win[1]);
    } else {
      setWin(st.win[0], Math.max(posAt(px), st.win[0] + 29));
    }
  });
  const endDrag = () => { if (drag) { drag = null; brush.classList.remove('drag'); if (cb.onWindow) cb.onWindow(st.win.slice()); } };
  layer.addEventListener('pointerup', endDrag);
  layer.addEventListener('pointercancel', endDrag);
  layer.addEventListener('pointerleave', () => { hideTip(); });

  layer.addEventListener('wheel', e => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return;
    e.preventDefault();
    const r = layer.getBoundingClientRect();
    const anchor = posAt(e.clientX - r.left);
    const span = st.win[1] - st.win[0] + 1;
    const next = Math.max(30, Math.min(model.mrna, Math.round(span * (e.deltaY > 0 ? 1.22 : 0.82))));
    const frac = (anchor - st.win[0]) / span;
    setWin(anchor - frac * next, anchor - frac * next + next - 1);
  }, { passive: false });

  brush.addEventListener('keydown', e => {
    const span = st.win[1] - st.win[0] + 1;
    const step = e.shiftKey ? Math.round(span) : Math.max(1, Math.round(span / 8));
    if (e.key === 'ArrowLeft') { setWin(st.win[0] - step, st.win[1] - step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setWin(st.win[0] + step, st.win[1] + step); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') { setWin(st.win[0] + span / 4, st.win[1] - span / 4); e.preventDefault(); }
    else if (e.key === '-' || e.key === '_') { setWin(st.win[0] - span / 2, st.win[1] + span / 2); e.preventDefault(); }
    else if (e.key === 'Home') { setWin(0, span - 1); e.preventDefault(); }
    else if (e.key === 'End') { setWin(model.mrna - span, model.mrna - 1); e.preventDefault(); }
  });

  /* ---- hover / click on ticks and arcs ---------------------------------- */
  function hover(px, py) {
    if (py >= OV.yTicks - 3 && py <= OV.yTicks + OV.hTicks + 3) {
      const hit = geom.ticks.find(t => px >= t.x0 - 1.5 && px <= t.x1 + 1.5);
      if (hit) { showTipMotif(hit.i, px, py); st.hoverArc = null; if (cb.onHover) cb.onHover(hit.i); return; }
    }
    if (py >= OV.yArcs - 4 && py <= OV.yArcs + OV.hArcs) {
      const k = arcHit(px, py);
      if (k != null) { showTipArc(k, px, py); if (st.hoverArc !== k) { st.hoverArc = k; draw(); } return; }
    }
    if (st.hoverArc != null) { st.hoverArc = null; draw(); }
    hideTip();
    if (cb.onHover) cb.onHover(-1);
  }

  function arcHit(px, py) {
    let best = null, bd = 9;
    for (const a of geom.arcs) {
      for (let i = 0; i <= 14; i++) {
        const t = i / 14, u = 1 - t;
        const qx = u * u * a.xa + 2 * u * t * a.cx + t * t * a.xb;
        const qy = u * u * a.y0 + 2 * u * t * a.cy + t * t * a.y0;
        const d = Math.hypot(qx - px, qy - py);
        if (d < bd) { bd = d; best = a.k; }
      }
    }
    return best;
  }

  layer.addEventListener('click', e => {
    const r = layer.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (py >= OV.yTicks - 3 && py <= OV.yTicks + OV.hTicks + 3) {
      const hit = geom.ticks.find(t => px >= t.x0 - 1.5 && px <= t.x1 + 1.5);
      if (hit && cb.onSelect) { cb.onSelect(hit.i); return; }
    }
    if (py >= OV.yArcs - 4 && py <= OV.yArcs + OV.hArcs) {
      const k = arcHit(px, py);
      if (k != null && cb.onArc) cb.onArc(k);
    }
  });

  function showTipMotif(i, px, py) {
    const m = model.motifs[i];
    const ann = annotationSummary(m).map(a => a.label + (a.n > 1 ? ' ×' + a.n : '')).join(' · ');
    tip.innerHTML = '';
    tip.appendChild(el('div', [el('b', m.c), ' ', el('span.k', regionWord(m.r))]));
    tip.appendChild(el('div.k', 'mRNA ' + fmt.int(m.ms) + '–' + fmt.int(m.me) +
      ' · ' + (m.r === 'protein' ? 'aa ' : 'nt ') + fmt.int(m.s) + '–' + fmt.int(m.e)));
    tip.appendChild(el('div', { class: 'mono', style: { color: 'var(--ink)', margin: '3px 0' } },
      truncate(motifDisplay(model, m), 44)));
    tip.appendChild(el('div.k', 'score ' + fmt.num(m.sc, 2) + ' · entropy ' + fmt.num(m.en, 2) +
      (m.pl != null ? ' · pLDDT ' + fmt.num(m.pl, 2) + ' (0–1)' : '')));
    if (ann) tip.appendChild(el('div.k', ann));
    positionTip(px, py);
  }

  function showTipArc(k, px, py) {
    const row = model.coupling[k];
    const mp = model.motifs[row.p], mu = model.motifs[row.u];
    if (!mp || !mu) return;
    const np = (model.byCluster.get(mp.c) || []).length, nu = (model.byCluster.get(mu.c) || []).length;
    tip.innerHTML = '';
    tip.appendChild(el('div', [el('b', mp.c), ' ↔ ', el('b', mu.c)]));
    tip.appendChild(el('div.k', np + ' protein instance' + (np === 1 ? '' : 's') + ' · ' +
      nu + ' UTR instance' + (nu === 1 ? '' : 's') + ' in this transcript'));
    tip.appendChild(el('div.k', 'score ' + fmt.num(row.sc, 3) + ' · NPMI ' + fmt.num(row.npmi, 3) +
      ' · co-occurrence ' + fmt.int(row.co) + ' · clades ' + fmt.int(row.cl)));
    tip.appendChild(el('div.k', 'candidate co-occurrence, not a demonstrated interaction'));
    positionTip(px, py);
  }

  function positionTip(px, py) {
    tip.hidden = false;
    const w = tip.offsetWidth || 240;
    tip.style.left = Math.max(2, Math.min(W - w - 2, px - w / 2)) + 'px';
    tip.style.top = (py + 16) + 'px';
  }
  function hideTip() { tip.hidden = true; }

  /* ---- lifecycle -------------------------------------------------------- */
  let ro = null;
  if (window.ResizeObserver) {
    let lastW = 0;
    ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      if (Math.abs(w - lastW) < 2) return;
      lastW = w; draw();
    });
    ro.observe(wrap);
  }

  draw();

  return {
    el: wrap,
    draw,
    setWin: (a, b) => setWin(a, b, true),
    destroy() { if (ro) ro.disconnect(); hideTip(); }
  };
}

function legend(arcNote) {
  const key = (cls, style, label) => el('span.sv-key', [
    el('span', { class: 'sv-swatch ' + cls, style }), el('span', label)
  ]);
  return el('div.sv-legend', [
    el('b', 'Overview'),
    key('', { background: 'var(--rna-soft)', boxShadow: 'inset 0 0 0 1px var(--rna)' }, 'UTR'),
    key('', { background: 'var(--protein-soft)', boxShadow: 'inset 0 0 0 1px var(--protein)' }, 'CDS'),
    key('', { background: 'var(--mod-3)' }, 'motif, coloured by module'),
    key('hatch', {}, 'NTScore not computed (CDS / protein)'),
    el('span.sv-key', 'arcs = gated protein↔UTR pairs'),
    arcNote,
    el('span.sv-key', 'coordinates 0-based, inclusive both ends'),
    el('span.sv-key', 'drag the window · scroll to zoom · click a motif')
  ]);
}

/** The coupling rows currently drawable, newest cap first. */
export function visibleCoupling(model, st) {
  const out = [];
  const cap = st.arcs === 'all' ? Infinity : (Number(st.arcs) || 8);
  for (let k = 0; k < model.coupling.length; k++) {
    const row = model.coupling[k];
    const mp = model.motifs[row.p], mu = model.motifs[row.u];
    if (!mp || !mu) continue;
    if (!motifPasses(mp, st) && !motifPasses(mu, st)) continue;
    out.push({ k, row });
    if (out.length >= cap) break;
  }
  return out;
}

/* =============================================================================
   5.  the detail panel
   ============================================================================= */

const READ_MAX = 1500;        // above this the letters are unreadable anyway
const PER_LINE = 60;

export function createDetail(host, model, st, cb) {
  ensureStyles();
  cb = cb || {};
  const wrap = el('div.sv');
  host.appendChild(wrap);
  let io = null, ro = null;

  function destroyObservers() {
    if (io) { io.disconnect(); io = null; }
  }

  function draw() {
    destroyObservers();
    clear(wrap);
    const a = st.win[0], b = st.win[1], span = b - a + 1;
    const mode = st.mode === 'track' ? 'track'
               : st.mode === 'read' ? (span <= READ_MAX * 3 ? 'read' : 'track')
               : (span <= READ_MAX ? 'read' : 'track');
    wrap.appendChild(head(span, mode));
    if (mode === 'read') drawRead(a, b);
    else drawTrack(a, b);
  }

  function head(span, mode) {
    const a = st.win[0], b = st.win[1];
    const region = model.regionAt(a) === model.regionAt(b)
      ? regionWord(model.regionAt(a)) : 'spans regions';
    return el('div.sv-detail-head', [
      el('span.sv-win', fmt.int(a) + ' – ' + fmt.int(b) + '  (' + fmt.int(span) + ' nt of ' +
        fmt.int(model.mrna) + ')'),
      el('span.dim', { style: { fontSize: 'var(--fs-xs)' } }, region),
      el('span.sv-zoom', [
        zbtn('−', 'Zoom out', () => zoom(1.8)),
        zbtn('+', 'Zoom in', () => zoom(1 / 1.8)),
        zbtn('⤢', 'Whole transcript', () => cb.onWindow && cb.onWindow([0, model.mrna - 1])),
        zbtn('‹', 'Previous motif', () => stepMotif(-1)),
        zbtn('›', 'Next motif', () => stepMotif(1))
      ]),
      el('span.dim', { style: { fontSize: 'var(--fs-xs)', marginLeft: 'auto' } },
        mode === 'read' ? 'read mode · 60 nt per line' : 'track mode · zoom in below ' +
          fmt.int(READ_MAX) + ' nt for letters')
    ]);
  }

  function zbtn(label, title, fn) {
    return el('button.btn.btn-sm', { type: 'button', title, on: { click: fn } }, label);
  }

  function zoom(f) {
    const span = st.win[1] - st.win[0] + 1;
    const c = (st.win[0] + st.win[1]) / 2;
    const next = Math.max(30, Math.min(model.mrna, Math.round(span * f)));
    const a = Math.max(0, Math.min(model.mrna - next, Math.round(c - next / 2)));
    if (cb.onWindow) cb.onWindow([a, a + next - 1]);
  }

  function stepMotif(dir) {
    const c = (st.win[0] + st.win[1]) / 2;
    const list = model.motifs.filter(m => motifPasses(m, st));
    if (!list.length) return;
    let target = null;
    if (dir > 0) target = list.find(m => m.ms > c + 1);
    else { for (const m of list) if (m.me < c - 1) target = m; }
    if (!target) target = dir > 0 ? list[0] : list[list.length - 1];
    const span = st.win[1] - st.win[0] + 1;
    const mid = (target.ms + target.me) / 2;
    if (cb.onSelect) cb.onSelect(model.motifs.indexOf(target));
    if (cb.onWindow) cb.onWindow([Math.round(mid - span / 2), Math.round(mid + span / 2) - 1]);
  }

  /* ---- track mode ------------------------------------------------------- */
  /* padL is the lane-label gutter: every lane shares one x() mapping, so labels
     must live outside the plot or they sit on top of the data. */
  const TR = { padL: 56, padR: 12, hRuler: 16, hNt: 54, hSpans: 18, hFrame: 7,
               hPl: 9, hDom: 9, hRbp: 9, gap: 4 };

  function trLabel(ctx, T, y, text) {
    ctx.font = '9.5px ' + sansStack();
    ctx.fillStyle = T['--ink-3'];
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(text, TR.padL - 6, y);
  }

  function drawTrack(a, b) {
    // Same rule as the overview: the track canvas is given an inline width,
    // so it must track the container instead of holding a floor above it.
    const avail = wrap.clientWidth || 0;
    const W = avail > 0 ? avail : 900;
    const plotX = TR.padL, plotW = Math.max(1, W - TR.padL - TR.padR);
    const n = b - a + 1;
    const x = p => plotX + ((p - a) / n) * plotW;
    const H = TR.hRuler + TR.hNt + TR.gap + TR.hSpans + TR.hFrame + TR.gap +
              TR.hPl + TR.hDom + TR.hRbp + 3 * 2 + 26;
    const cv = el('canvas', { 'aria-label': 'Detail tracks' });
    const box = el('div', { style: { position: 'relative' } }, [cv]);
    wrap.appendChild(box);
    const T = tokens();
    const ctx = fitCanvas(cv, W, H);
    let y = 0;

    // ruler
    ctx.strokeStyle = T['--line-strong']; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotX, y + TR.hRuler - .5); ctx.lineTo(plotX + plotW, y + TR.hRuler - .5); ctx.stroke();
    const step = niceStep(n, plotW);
    ctx.font = '9.5px ' + sansStack(); ctx.fillStyle = T['--ink-3']; ctx.textBaseline = 'top';
    for (let p = Math.ceil(a / step) * step; p <= b; p += step) {
      const px = x(p);
      ctx.beginPath(); ctx.moveTo(px + .5, y + TR.hRuler - 5); ctx.lineTo(px + .5, y + TR.hRuler); ctx.stroke();
      ctx.textAlign = px < plotX + 24 ? 'left' : (px > plotX + plotW - 30 ? 'right' : 'center');
      ctx.fillText(fmt.int(p), px, y + 1);
    }
    trLabel(ctx, T, y + TR.hRuler / 2, 'mRNA nt');
    y += TR.hRuler;

    // NTScore
    const dom = NT_DOMAIN;
    const yv = v => y + TR.hNt - ((v - dom[0]) / (dom[1] - dom[0])) * TR.hNt;
    ctx.fillStyle = T['--surface-2']; ctx.fillRect(plotX, y, plotW, TR.hNt);
    ctx.strokeStyle = T['--line-soft'];
    for (const g of [-2, -4, -6]) {
      const yy = Math.round(yv(g)) + .5;
      ctx.beginPath(); ctx.moveTo(plotX, yy); ctx.lineTo(plotX + plotW, yy); ctx.stroke();
      ctx.fillStyle = T['--ink-3']; ctx.font = '9px ' + sansStack();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(String(g), plotX - 3, yy);
    }
    trLabel(ctx, T, y + 5, 'NTScore');
    // hatch the CDS part of the window
    const ha = Math.max(a, model.cds0), hb = Math.min(b, model.cds1);
    if (hb >= ha) {
      ctx.save(); ctx.fillStyle = hatchPattern(ctx, T);
      ctx.fillRect(x(ha), y, Math.max(1, x(hb + 1) - x(ha)), TR.hNt); ctx.restore();
      ctx.font = '700 9.5px ' + sansStack(); ctx.fillStyle = T['--ink-3'];
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const note = 'no NTScore for CDS';
      if (ctx.measureText(note).width + 12 < x(hb + 1) - x(ha)) ctx.fillText(note, (x(ha) + x(hb + 1)) / 2, y + TR.hNt / 2);
    }
    // bars or envelope
    const perNt = plotW / n;
    ctx.fillStyle = T['--rna'];
    if (perNt >= 1.2) {
      for (let p = a; p <= b; p++) {
        const q = model.ntAt(p); if (q < 0) continue;
        const v = ntValue(q), yy = yv(v);
        ctx.globalAlpha = .8;
        ctx.fillRect(x(p), yy, Math.max(.8, perNt - .35), y + TR.hNt - yy);
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = .28; ctx.beginPath();
      let started = false; const tops = [];
      for (let px = 0; px < plotW; px++) {
        const p0 = a + Math.floor((px / plotW) * n), p1 = a + Math.floor(((px + 1) / plotW) * n);
        let mn = Infinity, mx = -Infinity;
        for (let p = p0; p < Math.max(p0 + 1, p1); p++) {
          const q = model.ntAt(p); if (q < 0) continue;
          const v = ntValue(q); if (v < mn) mn = v; if (v > mx) mx = v;
        }
        if (mn === Infinity) { tops.push(null); continue; }
        tops.push({ px: plotX + px, mn, mx });
      }
      for (const t of tops) { if (!t) continue; if (!started) { ctx.moveTo(t.px, yv(t.mx)); started = true; } else ctx.lineTo(t.px, yv(t.mx)); }
      for (let i = tops.length - 1; i >= 0; i--) { const t = tops[i]; if (!t) continue; ctx.lineTo(t.px, yv(t.mn)); }
      if (started) { ctx.closePath(); ctx.fill(); }
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = T['--line']; ctx.strokeRect(plotX + .5, y + .5, plotW - 1, TR.hNt - 1);
    y += TR.hNt + TR.gap;

    // motif spans — one lane, every span its own border
    const hits = [];
    ctx.fillStyle = T['--surface-2']; ctx.fillRect(plotX, y, plotW, TR.hSpans);
    trLabel(ctx, T, y + TR.hSpans / 2, 'motifs');
    for (let i = 0; i < model.motifs.length; i++) {
      const m = model.motifs[i];
      if (m.me < a || m.ms > b) continue;
      const on = motifPasses(m, st);
      const x0 = x(Math.max(a, m.ms)), x1 = x(Math.min(b, m.me) + 1);
      const w = Math.max(1.6, x1 - x0);
      hits.push({ i, x0, x1: x0 + w, y0: y, y1: y + TR.hSpans });
      ctx.globalAlpha = on ? 1 : .18;
      ctx.fillStyle = T.mod(m.m);
      ctx.fillRect(x0, y, w, TR.hSpans);
      ctx.strokeStyle = T['--surface']; ctx.lineWidth = 1.2;
      ctx.strokeRect(x0 + .6, y + .6, Math.max(0, w - 1.2), TR.hSpans - 1.2);
      ctx.globalAlpha = 1;
      if (st.sel === i) { ctx.strokeStyle = T['--ink']; ctx.lineWidth = 1.8; ctx.strokeRect(x0 - 1, y - 1.5, w + 2, TR.hSpans + 3); }
      const label = m.c;
      ctx.font = '9.5px ' + sansStack();
      if (on && ctx.measureText(label).width + 10 < w) {
        ctx.fillStyle = T.modInk(m.m);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, x0 + w / 2, y + TR.hSpans / 2 + .5);
      }
    }
    y += TR.hSpans;

    // codon frame ticks
    if (Math.min(b, model.cds1) >= Math.max(a, model.cds0) && perNt > 1.2) {
      ctx.strokeStyle = T['--line-strong']; ctx.globalAlpha = .6; ctx.lineWidth = 1;
      const from = Math.max(a, model.cds0), to = Math.min(b, model.cds1);
      const first = from + ((3 - ((from - model.cds0) % 3)) % 3);
      ctx.beginPath();
      for (let p = first; p <= to; p += 3) { ctx.moveTo(x(p) + .5, y); ctx.lineTo(x(p) + .5, y + TR.hFrame); }
      ctx.stroke(); ctx.globalAlpha = 1;
      trLabel(ctx, T, y + TR.hFrame / 2, 'codons');
    }
    y += TR.hFrame + TR.gap;

    // pLDDT / domain / RBP lanes (motif-level, labelled as such)
    y = annLane(ctx, T, y, TR.hPl, 'pLDDT', a, b, x, m => m.pl != null,
      (m) => ({ color: T['--protein'], alpha: 0.25 + 0.75 * Math.max(0, Math.min(1, m.pl)) }));
    y = annLane(ctx, T, y, TR.hDom, 'domain', a, b, x, hasDomainAnn, () => ({ color: T['--mod-3'], alpha: .85 }));
    y = annLane(ctx, T, y, TR.hRbp, 'RBP', a, b, x, hasRbpAnn, () => ({ color: T['--rna'], alpha: .85 }));

    // hit testing
    cv.style.cursor = 'default';
    cv.addEventListener('mousemove', ev => {
      const r = cv.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const h = hits.find(t => px >= t.x0 && px <= t.x1 && py >= t.y0 - 2 && py <= t.y1 + 2);
      cv.style.cursor = h ? 'pointer' : 'default';
      cv.title = h ? model.motifs[h.i].c + '  mRNA ' + model.motifs[h.i].ms + '–' + model.motifs[h.i].me : '';
    });
    cv.addEventListener('click', ev => {
      const r = cv.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const h = hits.find(t => px >= t.x0 && px <= t.x1 && py >= t.y0 - 2 && py <= t.y1 + 2);
      if (h && cb.onSelect) cb.onSelect(h.i);
    });

    wrap.appendChild(el('div.sv-legend', [
      el('b', 'Lanes'),
      el('span.sv-key', 'NTScore, −8 … 0, per nucleotide'),
      el('span.sv-key', 'motif spans — one lane, no overlaps, each span outlined'),
      el('span.sv-key', 'codon frame ticks every 3 nt inside the CDS'),
      el('span.sv-key', 'pLDDT / domain / RBP are motif-level annotations, not per-residue tracks')
    ]));
  }

  function annLane(ctx, T, y, h, label, a, b, x, test, style) {
    trLabel(ctx, T, y + h / 2, label);
    let any = false;
    for (const m of model.motifs) {
      if (m.me < a || m.ms > b || !test(m) || !motifPasses(m, st)) continue;
      any = true;
      const s = style(m);
      const x0 = x(Math.max(a, m.ms)), w = Math.max(1.6, x(Math.min(b, m.me) + 1) - x0);
      ctx.globalAlpha = s.alpha; ctx.fillStyle = s.color;
      ctx.fillRect(x0, y + 1, w, h - 3);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = T['--surface']; ctx.lineWidth = 1;
      ctx.strokeRect(x0 + .5, y + 1.5, Math.max(0, w - 1), h - 4);
    }
    if (!any) {
      // a designed "nothing here" rather than a blank strip
      ctx.strokeStyle = T['--line']; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(TR.padL, y + h / 2 + .5);
      ctx.lineTo(TR.padL + 110, y + h / 2 + .5); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = T['--ink-3']; ctx.font = '9px ' + sansStack();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('none in view', TR.padL + 116, y + h / 2);
    }
    return y + h + 2;
  }

  /* ---- read mode -------------------------------------------------------- */
  function drawRead(a, b) {
    const holder = el('div.sv-read');
    // 60ch + gutters can exceed a narrow viewport: scroll the block, never the body
    wrap.appendChild(el('div.sv-scroll', holder));
    const lines = [];
    for (let s = a; s <= b; s += PER_LINE) lines.push([s, Math.min(b, s + PER_LINE - 1)]);

    const nodes = lines.map(([s, e]) => {
      const body = el('div.sv-body');
      const node = el('div.sv-line', [
        el('div.sv-gut', fmt.int(s)),
        body
      ]);
      node._range = [s, e]; node._body = body; node._done = false;
      return node;
    });
    for (const n of nodes) holder.appendChild(n);

    const paint = node => {
      if (node._done) return;
      node._done = true;
      renderLine(node._body, node._range[0], node._range[1]);
    };

    if (window.IntersectionObserver) {
      io = new IntersectionObserver(entries => {
        for (const en of entries) if (en.isIntersecting) { paint(en.target); io.unobserve(en.target); }
      }, { rootMargin: '600px 0px' });
      for (const n of nodes) io.observe(n);
      // paint the first screenful synchronously so there is never a blank flash
      nodes.slice(0, 12).forEach(paint);
    } else {
      nodes.forEach(paint);
    }

    wrap.appendChild(el('div.sv-legend', [
      el('b', 'Read mode'),
      el('span.sv-key', '60 nt per line · 0-based mRNA coordinates in the gutter'),
      el('span.sv-key', st.alpha === 'dna'
        ? 'DNA alphabet as stored'
        : "mRNA shown as RNA (T→U across 5′UTR, CDS and 3′UTR); the protein row is never mapped (U there is selenocysteine)"),
      el('span.sv-key', 'amino acids sit under their codon; ✱ is the stop codon')
    ]));
  }

  function renderLine(body, s, e) {
    const n = e - s + 1;
    const T = tokens();

    /* NTScore strip */
    const cvw = el('canvas.sv-linecv');
    body.appendChild(cvw);
    const px = body.clientWidth || 600;
    const cw = px / PER_LINE;
    const w = Math.max(1, cw * n);
    const H = 22;
    cvw.style.width = w + 'px';
    const ctx = fitCanvas(cvw, w, H);
    const dom = NT_DOMAIN;
    ctx.fillStyle = T['--surface-2']; ctx.fillRect(0, 0, w, H);
    // the CDS has no NTScore anywhere in the corpus: hatch it once, not per base
    const ha = Math.max(s, model.cds0), hb = Math.min(e, model.cds1);
    if (hb >= ha) {
      ctx.fillStyle = hatchPattern(ctx, T);
      ctx.fillRect((ha - s) * cw, 0, (hb - ha + 1) * cw, H);
    }
    for (let p = s; p <= e; p++) {
      const q = model.ntAt(p);
      if (q < 0) continue;
      const i = p - s;
      const v = ntValue(q);
      const hh = ((v - dom[0]) / (dom[1] - dom[0]));           // 1 = confident, 0 = surprising
      const bar = (1 - hh) * H;                                 // draw SURPRISE upward
      ctx.fillStyle = T['--rna']; ctx.globalAlpha = .28 + .6 * (1 - hh);
      ctx.fillRect(i * cw + .3, H - bar, Math.max(.7, cw - .6), bar);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = T['--line']; ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, w - 1, H - 1);
    cvw.title = 'NTScore per nucleotide: taller = more model-surprising (−8 at full height, 0 at the baseline). No score exists for the CDS — hatched.';

    /* nucleotide row, one span per segment */
    const row = el('div.sv-nts');
    let i = s;
    while (i <= e) {
      const mi = model.motifAt(i);
      if (mi === -1) {
        let j = i;
        while (j <= e && model.motifAt(j) === -1) j++;
        row.appendChild(el('span', { text: sliceDisplay(model, i, j - 1, st) }));
        i = j;
      } else {
        const m = model.motifs[mi];
        const j = Math.min(e, m.me);
        const on = motifPasses(m, st);
        const col = T.mod(m.m);
        const sp = el('span', {
          class: 'sv-seg' + (st.sel === mi ? ' hit' : ''),
          dataset: { c: m.c, i: mi },
          title: m.c + ' · ' + regionWord(m.r) + ' · mRNA ' + m.ms + '–' + m.me +
                 ' · score ' + fmt.num(m.sc, 2) + (m.pl != null ? ' · pLDDT ' + fmt.num(m.pl, 2) : ''),
          style: {
            background: on ? mix(col, T['--surface'], .30) : 'transparent',
            color: 'var(--ink)',
            '--seg-line': on ? col : T['--line'],
            opacity: on ? 1 : .45
          },
          text: sliceDisplay(model, i, j, st),
          on: { click: () => cb.onSelect && cb.onSelect(mi) }
        });
        row.appendChild(sp);
        i = j + 1;
      }
    }
    body.appendChild(row);

    /* amino-acid row under the CDS */
    const aa = el('div.sv-aa');
    const ca = Math.max(s, model.cds0), cb2 = Math.min(e, model.cds1);
    if (cb2 >= ca) {
      const firstK = Math.floor((ca - model.cds0) / 3);
      const lastK = Math.floor((cb2 - model.cds0) / 3);
      for (let k = firstK; k <= lastK; k++) {
        const p0 = model.cds0 + 3 * k;
        const col = p0 - s;                             // may be negative at a line edge
        const isStop = k >= model.lenP;
        const ch = isStop ? '✱' : (model.protein[k] || '·');
        aa.appendChild(el('i', {
          class: isStop ? 'stop' : null,
          style: { left: col + 'ch' },
          title: isStop ? 'stop codon' : ('residue ' + k + ' · ' + ch),
          text: ch
        }));
      }
    }
    body.appendChild(aa);

    /* codon frame ticks */
    const fr = el('div.sv-frame');
    if (cb2 >= ca) {
      const first = ca + ((3 - ((ca - model.cds0) % 3)) % 3);
      for (let p = first; p <= cb2; p += 3) fr.appendChild(el('u', { style: { left: (p - s) + 'ch' } }));
    }
    body.appendChild(fr);

    /* pLDDT / domain / RBP lanes */
    body.appendChild(annRow('pLDDT', s, e, m => m.pl != null,
      m => ({ bg: T['--protein'], op: 0.22 + 0.78 * Math.max(0, Math.min(1, m.pl)),
              title: 'pLDDT ' + fmt.num(m.pl, 3) + ' (0–1 scale) · ' + m.c })));
    body.appendChild(annRow('domain', s, e, hasDomainAnn,
      m => ({ bg: T['--mod-3'], op: .85, title: domainTitle(m) })));
    body.appendChild(annRow('RBP', s, e, hasRbpAnn,
      m => ({ bg: T['--rna'], op: .85, title: rbpTitle(m) })));
  }

  function annRow(label, s, e, test, style) {
    const row = el('div.sv-ann', [el('span.sv-annlab', label)]);
    for (const m of model.motifs) {
      if (m.me < s || m.ms > e || !test(m) || !motifPasses(m, st)) continue;
      const a0 = Math.max(s, m.ms), a1 = Math.min(e, m.me);
      const sty = style(m);
      row.appendChild(el('b', {
        style: { left: (a0 - s) + 'ch', width: (a1 - a0 + 1) + 'ch',
                 background: sty.bg, opacity: sty.op },
        title: sty.title
      }));
    }
    return row;
  }

  /* ---- lifecycle -------------------------------------------------------- */
  if (window.ResizeObserver) {
    let last = 0;
    ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      if (Math.abs(w - last) < 12) return;
      last = w; draw();
    });
    ro.observe(wrap);
  }

  draw();
  return {
    el: wrap, draw,
    destroy() { destroyObservers(); if (ro) ro.disconnect(); }
  };
}

/* =============================================================================
   6.  small shared helpers
   ============================================================================= */

/** The mRNA substring [a,b] inclusive, in the display alphabet.
 *  T->U is applied to every nucleotide region (5'UTR, CDS, 3'UTR) — they are all
 *  mRNA. The protein sequence is never touched (U there is selenocysteine). */
export function sliceDisplay(model, a, b, st) {
  const raw = model.mseq.slice(a, b + 1);
  if (st && st.alpha === 'dna') return raw;
  let out = '';
  let i = a;
  while (i <= b) {
    const r = model.regionAt(i);
    let j = i;
    while (j <= b && model.regionAt(j) === r) j++;
    const chunk = model.mseq.slice(i, j);
    out += displaySeq(chunk, r);
    i = j;
  }
  return out;
}

export function regionWord(r) {
  return r === 'utr5' ? "5′ UTR" : r === 'utr3' ? "3′ UTR" : r === 'protein' ? 'protein / CDS' : 'CDS';
}

function domainTitle(m) {
  const bits = [];
  if (m.a.ipr) bits.push('InterPro: ' + m.a.ipr);
  if (m.a.upr) bits.push('UniProt: ' + m.a.upr);
  if (m.a.mob && m.a.mob.length) bits.push('MobiDB: ' + m.a.mob.join(' | '));
  if (m.a.idpo) bits.push('IDPO: ' + m.a.idpo);
  if (m.a.sig) bits.push('SignalP: ' + m.a.sig);
  return bits.join('\n');
}

function rbpTitle(m) {
  const bits = [];
  for (const k of Object.keys(m.a.rbp || {})) {
    const v = m.a.rbp[k] || [];
    if (v.length) bits.push(k + ' (' + v.length + '): ' + v.slice(0, 14).join(', ') + (v.length > 14 ? ' …' : ''));
  }
  return bits.join('\n');
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function niceStep(total, px) {
  const target = Math.max(60, px / 9);
  const raw = (total / Math.max(1, px)) * target;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
  for (const m of [1, 2, 2.5, 5, 10]) if (pow * m >= raw) return Math.max(1, Math.round(pow * m));
  return Math.max(1, Math.round(pow * 10));
}

function sansStack() {
  return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
}

/** Cheap hex mix so canvas and DOM agree without color-mix support checks. */
export function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  if (!pa || !pb) return a;
  const c = pa.map((v, i) => Math.round(v * t + pb[i] * (1 - t)));
  return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
}

function hex(s) {
  s = String(s || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [0, 1, 2].map(i => parseInt(m[1][i] + m[1][i], 16));
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(',').map(v => parseFloat(v)); return [p[0] | 0, p[1] | 0, p[2] | 0]; }
  return null;
}

/** Readable ink on a filled module swatch. */
function pickInk(T, m) {
  const c = hex(T.mod(m));
  if (!c) return T['--ink'];
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  return lum > 0.6 ? '#1b2733' : '#ffffff';
}
