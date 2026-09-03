/* =============================================================================
   logo.js — the sequence-logo renderer.

   Draws a STREME position-weight matrix as an SVG logo: one stack per position,
   stack height = information content in bits, each letter's height inside the
   stack = its probability x that information content.

       IC(pos) = log2(K) - H(pos),  H = -sum p_i log2 p_i,  K = |alphabet|

   so a fully determined DNA column is 2 bits and a fully determined protein
   column is log2(20) = 4.32 bits.  Nothing is normalised away: a protein logo
   is drawn on its own 4.32-bit axis, and the axis label says so.

   ALPHABET.  The bake ships every logo in the DNA alphabet (VERIFIED FACT 11).
   Pass {region:'utr5'|'utr3'} and the T column is drawn as U — display only, the
   probabilities and the column order never move.  Protein logos are never mapped:
   U in a protein sequence is selenocysteine.

   ABSENT STATE.  Only 456 of 900 clusters have a STREME motif at
   test_pvalue < 0.05.  There is no defensible client-side fallback: the clusters
   were k-means'd on embeddings, not on sequence, so a naive PWM over the member
   strings disagrees with STREME on 77% of clusters and manufactures SSSSS/PPPPP
   artifacts.  absentLogo() therefore renders a designed state carrying its
   denominator (444 of 900), never a blank box and never a guess.

   Exported:
     renderLogo(logo, opts) -> HTMLElement      opts {region, height, maxColW, id}
     absentLogo(opts)       -> HTMLElement      the designed 444-of-900 state
     logoBits(pwm, K)       -> [bits, ...]      per-position information content
     logoConsensus(logo, opts) -> string        argmax letter per position
     logoSVGText(node)      -> string           standalone SVG for download
   ============================================================================= */

import { el, emptyState, fmt, DENOMINATORS } from './ui.js';
import { sig } from './r2-ui.js';

/* ---------- alphabet colouring ------------------------------------------- */
/* Colours live in CSS custom properties injected once, with a dark-theme block,
   so the logo re-themes with the page and no view writes a hex value. */

const AA_CLASS = {
  A: 'hyd', V: 'hyd', L: 'hyd', I: 'hyd', M: 'hyd',
  F: 'aro', W: 'aro', Y: 'aro',
  K: 'pos', R: 'pos', H: 'pos',
  D: 'neg', E: 'neg',
  S: 'pol', T: 'pol', N: 'pol', Q: 'pol',
  C: 'cys', G: 'gly', P: 'pro'
};
const AA_CLASS_LABEL = {
  hyd: 'aliphatic / hydrophobic (AVLIM)', aro: 'aromatic (FWY)',
  pos: 'basic (KRH)', neg: 'acidic (DE)', pol: 'polar (STNQ)',
  cys: 'cysteine', gly: 'glycine', pro: 'proline'
};
const NT_VAR = { A: 'nt-a', C: 'nt-c', G: 'nt-g', T: 'nt-t', U: 'nt-t' };

function letterVar(ch, isProtein) {
  if (!isProtein) return 'var(--lg-' + (NT_VAR[ch] || 'other') + ')';
  const c = AA_CLASS[ch];
  return c ? 'var(--lg-aa-' + c + ')' : 'var(--lg-other)';
}

const STYLE_ID = 'mirto-logo-style';
const CSS = `
:root {
  --lg-nt-a:#2e8b57; --lg-nt-c:#2b6cb0; --lg-nt-g:#c98a00; --lg-nt-t:#c0392b;
  --lg-aa-hyd:#2f7d5a; --lg-aa-aro:#7b4fb5; --lg-aa-pos:#2b6cb0; --lg-aa-neg:#c0392b;
  --lg-aa-pol:#0e8b8b; --lg-aa-cys:#b8860b; --lg-aa-gly:#8a6d3b; --lg-aa-pro:#b5528a;
  --lg-other:#78848f;
}
:root:not([data-theme="light"]) {
  --lg-nt-a:#5cc98d; --lg-nt-c:#6aaee8; --lg-nt-g:#e6b13d; --lg-nt-t:#ef7f6b;
  --lg-aa-hyd:#5cc196; --lg-aa-aro:#b18ce8; --lg-aa-pos:#6aaee8; --lg-aa-neg:#ef7f6b;
  --lg-aa-pol:#4fc7c7; --lg-aa-cys:#e0b352; --lg-aa-gly:#c3a377; --lg-aa-pro:#e58ac2;
  --lg-other:#8b98a3;
}
:root[data-theme="dark"] {
  --lg-nt-a:#5cc98d; --lg-nt-c:#6aaee8; --lg-nt-g:#e6b13d; --lg-nt-t:#ef7f6b;
  --lg-aa-hyd:#5cc196; --lg-aa-aro:#b18ce8; --lg-aa-pos:#6aaee8; --lg-aa-neg:#ef7f6b;
  --lg-aa-pol:#4fc7c7; --lg-aa-cys:#e0b352; --lg-aa-gly:#c3a377; --lg-aa-pro:#e58ac2;
  --lg-other:#8b98a3;
}
.logo-box { width: 100%; }
.logo-svg { display: block; width: 100%; height: auto; overflow: visible; }
.logo-svg text { font-family: var(--font-mono); font-weight: 700; }
.logo-axis text { font-family: var(--font-mono); font-weight: 500;
                  fill: var(--ink-3); font-size: 9px; }
.logo-axis line { stroke: var(--line-strong); stroke-width: 1; }
.logo-grid line { stroke: var(--line-soft); stroke-width: 1; }
.logo-col:hover rect.logo-hit { fill: color-mix(in srgb, var(--ink-3) 10%, transparent); }
.logo-key { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: var(--s3);
            font-size: var(--fs-xs); color: var(--ink-3); }
.logo-key span.k { display: inline-flex; align-items: center; gap: 4px; }
.logo-key i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.logo-meta { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); margin-top: var(--s3);
             font-size: var(--fs-xs); color: var(--ink-3); }
.logo-meta b { color: var(--ink-2); font-weight: 600; }
`;

export function ensureLogoStyle() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.appendChild(el('style', { id: STYLE_ID, text: CSS }));
}

/* ---------- maths --------------------------------------------------------- */

/** Per-position information content in bits. */
export function logoBits(pwm, K) {
  const k = K || (pwm && pwm[0] ? pwm[0].length : 4);
  const max = Math.log2(k);
  return (pwm || []).map(row => {
    let h = 0;
    for (const p of row) if (p > 0) h -= p * Math.log2(p);
    const ic = max - h;
    return ic > 0 ? ic : 0;                     // rounding can push a flat column to -1e-16
  });
}

/** The argmax letter at each position, in display alphabet. */
export function logoConsensus(logo, opts) {
  if (!logo || !logo.pwm) return '';
  const letters = displayAlphabet(logo, opts && opts.region);
  return logo.pwm.map(row => {
    let bi = 0;
    for (let i = 1; i < row.length; i++) if (row[i] > row[bi]) bi = i;
    return letters[bi] || '?';
  }).join('');
}

function displayAlphabet(logo, region) {
  const raw = String((logo && logo.alphabet) || 'ACGT').split('');
  const isProt = raw.length > 4;
  if (isProt) return raw;                                    // never map U in protein
  if (region === 'utr5' || region === 'utr3') return raw.map(c => (c === 'T' ? 'U' : c));
  return raw;
}

/* ---------- the renderer -------------------------------------------------- */

const NS = 'http://www.w3.org/2000/svg';

/**
 * renderLogo(logo, opts)
 *   logo : {pwm, alphabet, evalue, nsites, source, motif_id, test_pvalue, width}
 *   opts : {region, height=118, maxColW=34, minColW=13, showKey=true, showMeta=true}
 * Returns a <div class="logo-box"> containing the SVG plus its caption. Safe to
 * call before the container is in the document: glyph metrics are measured on
 * insertion if possible and fall back to a cap-height constant otherwise.
 */
export function renderLogo(logo, opts) {
  opts = opts || {};
  ensureLogoStyle();
  if (!logo || !Array.isArray(logo.pwm) || !logo.pwm.length) return absentLogo(opts);

  const pwm = logo.pwm;
  const letters = displayAlphabet(logo, opts.region);
  const isProt = letters.length > 4;
  const K = letters.length;
  const maxBits = Math.log2(K);
  const bits = logoBits(pwm, K);

  const n = pwm.length;
  const H = opts.height || 118;                 // plot height in px (bits axis)
  const padL = 26, padR = 6, padT = 6, padB = 18;
  const colW = Math.max(opts.minColW || 13, Math.min(opts.maxColW || 34, 340 / n));
  const W = padL + padR + colW * n;
  const totalH = H + padT + padB;

  const svg = el('svg.logo-svg', {
    viewBox: '0 0 ' + W.toFixed(1) + ' ' + totalH.toFixed(1),
    preserveAspectRatio: 'xMinYMid meet',
    role: 'img',
    'aria-label': 'Sequence logo, ' + n + ' positions, ' +
      (isProt ? 'amino-acid' : 'nucleotide') + ' alphabet, consensus ' +
      logoConsensus(logo, opts)
  });

  /* y axis: 0 .. maxBits, ticks at whole bits */
  const y = b => padT + H - (b / maxBits) * H;
  const axis = el('g.logo-axis');
  const grid = el('g.logo-grid');
  for (let b = 0; b <= Math.floor(maxBits + 1e-9); b++) {
    grid.appendChild(el('line', { x1: padL, x2: W - padR, y1: y(b).toFixed(1), y2: y(b).toFixed(1) }));
    axis.appendChild(el('text', { x: padL - 5, y: (y(b) + 3).toFixed(1), 'text-anchor': 'end' }, String(b)));
  }
  axis.appendChild(el('line', { x1: padL, x2: padL, y1: padT, y2: padT + H }));
  axis.appendChild(el('text', {
    x: 8, y: padT + H / 2, 'text-anchor': 'middle',
    transform: 'rotate(-90 8 ' + (padT + H / 2).toFixed(1) + ')'
  }, 'bits'));
  svg.appendChild(grid);
  svg.appendChild(axis);

  /* stacks */
  const stacks = el('g.logo-stacks');
  const glyphs = [];                            // {node, letter, x, w, h, yBottom}
  for (let i = 0; i < n; i++) {
    const row = pwm[i];
    const x0 = padL + i * colW;
    const g = el('g.logo-col');
    const parts = row.map((p, j) => ({ p, ch: letters[j] || '?' }))
      .filter(d => d.p * bits[i] > 0.012)       // below ~1/100 bit nothing is legible
      .sort((a, b) => a.p - b.p);               // smallest at the top of the stack

    g.appendChild(el('rect.logo-hit', {
      x: x0.toFixed(1), y: padT, width: colW.toFixed(1), height: H, fill: 'transparent'
    }));
    g.appendChild(el('title', 'Position ' + (i + 1) + ' · ' + bits[i].toFixed(2) + ' bits\n' +
      row.map((p, j) => [letters[j], p]).filter(d => d[1] >= 0.01)
        .sort((a, b) => b[1] - a[1])
        .map(d => '  ' + d[0] + ' ' + (100 * d[1]).toFixed(1) + '%').join('\n')));

    let yTop = padT + H - (bits[i] / maxBits) * H;
    for (const d of parts.slice().reverse()) {  // draw tallest first, top-down
      const h = (d.p * bits[i] / maxBits) * H;
      const t = el('text', {
        x: 0, y: 0, 'font-size': 100, 'text-anchor': 'start',
        style: { fill: letterVar(d.ch, isProt) }
      }, d.ch);
      g.appendChild(t);
      glyphs.push({ node: t, ch: d.ch, x: x0 + colW * 0.06, w: colW * 0.88, h, yBottom: yTop + h });
      yTop += h;
    }
    stacks.appendChild(g);

    /* position ruler */
    if (n <= 14 || (i % 2 === 0)) {
      axis.appendChild(el('text', {
        x: (x0 + colW / 2).toFixed(1), y: (padT + H + 12).toFixed(1), 'text-anchor': 'middle'
      }, String(i + 1)));
    }
  }
  svg.appendChild(stacks);

  /* Glyph metrics. Try a real measurement; fall back to a cap-height constant.
     If the box is built detached (the usual case) the measurement is redone by
     refreshLogo() once the view has mounted it. */
  svg.__glyphs = glyphs;
  svg.dataset.measured = placeGlyphs(svg, glyphs) ? '1' : '0';

  const box = el('div.logo-box', { dataset: { n } }, [svg]);

  if (opts.showMeta !== false) {
    box.appendChild(el('div.logo-meta', [
      el('span', [el('b', logoConsensus(logo, opts)), ' consensus']),
      el('span', { title: 'STREME E-value' }, ['E ', el('b', sig(logo.evalue))]),
      logo.test_pvalue != null
        ? el('span', { title: 'STREME held-out test p-value — the gate for drawing a logo at all' },
            ['p ', el('b', sig(logo.test_pvalue))]) : null,
      logo.nsites != null ? el('span', [el('b', fmt.int(logo.nsites)), ' sites']) : null,
      el('span', [el('b', n), ' positions · max ', el('b', maxBits.toFixed(2)), ' bits'])
    ]));
  }
  if (opts.showKey !== false) box.appendChild(colourKey(isProt, letters));
  return box;
}

/** Measure one glyph per distinct letter, then place every glyph exactly. */
function placeGlyphs(svg, glyphs) {
  const uniq = Array.from(new Set(glyphs.map(g => g.ch)));
  const metrics = {};
  let measured = false;
  try {
    const probe = el('g', { style: { visibility: 'hidden' } });
    const nodes = uniq.map(ch => el('text', { x: 0, y: 0, 'font-size': 100 }, ch));
    nodes.forEach(nd => probe.appendChild(nd));
    svg.appendChild(probe);
    if (document.body && document.body.contains(svg)) {
      nodes.forEach((nd, i) => {
        const b = nd.getBBox();
        if (b && b.height > 1 && b.width > 0) {
          metrics[uniq[i]] = { w: b.width, h: b.height, x: b.x, y: b.y };
          measured = true;
        }
      });
    }
    svg.removeChild(probe);
  } catch (e) { /* jsdom, detached node, or a browser that refuses getBBox */ }

  for (const g of glyphs) {
    const m = measured && metrics[g.ch] ? metrics[g.ch]
      : { w: 60, h: 72, x: 0, y: -72 };         // monospace cap-height fallback at 100px
    const sx = g.w / m.w;
    const sy = g.h / m.h;
    // translate so the glyph's own bbox lands exactly in (x, yBottom-h) .. (x+w, yBottom)
    g.node.setAttribute('transform',
      'translate(' + (g.x - m.x * sx).toFixed(2) + ',' +
      (g.yBottom - (m.y + m.h) * sy).toFixed(2) + ') scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')');
    if (g.h < 1.2) g.node.setAttribute('opacity', '0.55');
  }
  return measured;
}

/** Views build the logo detached and mount it afterwards; this re-runs the glyph
 *  measurement once the SVG is live, so letters fill their column exactly. */
export function refreshLogo(box) {
  if (!box || !box.querySelector) return false;
  const svg = box.querySelector('svg');
  if (!svg || !svg.__glyphs || svg.dataset.measured === '1') return false;
  if (!document.body.contains(svg)) return false;
  svg.dataset.measured = placeGlyphs(svg, svg.__glyphs) ? '1' : '0';
  return svg.dataset.measured === '1';
}

function colourKey(isProt, letters) {
  const key = el('div.logo-key');
  if (isProt) {
    for (const c of Object.keys(AA_CLASS_LABEL)) {
      key.appendChild(el('span.k', [
        el('i', { style: { background: 'var(--lg-aa-' + c + ')' } }),
        AA_CLASS_LABEL[c]
      ]));
    }
  } else {
    for (const ch of letters) {
      key.appendChild(el('span.k', [
        el('i', { style: { background: letterVar(ch, false) } }), ch
      ]));
    }
  }
  return key;
}

/* ---------- the designed absent state ------------------------------------ */

/**
 * absentLogo({region, action})
 * The honest state for the 444 clusters with no STREME motif at p < 0.05.
 */
export function absentLogo(opts) {
  opts = opts || {};
  ensureLogoStyle();
  return el('div', [
    emptyState({
      compact: true,
      mark: '◫',
      title: 'No defensible sequence logo',
      message: 'STREME found no motif at test p < 0.05 for this cluster. None is drawn ' +
        'from the member strings either: clusters were k-means’d on MIRTO embeddings, ' +
        'not on sequence, so a naive position-weight matrix disagrees with STREME on 77% ' +
        'of clusters and manufactures poly-S / poly-P artifacts. The consensus repertoire ' +
        'below is the honest sequence-level summary.',
      denominator: DENOMINATORS.noLogo,
      action: opts.action || null
    })
  ]);
}

/* ---------- export helper ------------------------------------------------- */

/** Serialise a rendered logo box's SVG for download. */
export function logoSVGText(box) {
  const svg = box && box.querySelector ? box.querySelector('svg') : null;
  if (!svg) return '';
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  // inline the custom properties so the file stands alone
  const cs = getComputedStyle(document.documentElement);
  clone.querySelectorAll('text').forEach(t => {
    const f = t.style && t.style.fill;
    const m = f && /var\((--[\w-]+)\)/.exec(f);
    if (m) t.setAttribute('fill', (cs.getPropertyValue(m[1]) || '#555').trim());
    t.setAttribute('font-family', 'monospace');
    t.style.fill = '';
  });
  clone.querySelectorAll('.logo-axis text').forEach(t => t.setAttribute('fill', '#666'));
  clone.querySelectorAll('line').forEach(l => l.setAttribute('stroke', '#bbb'));
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}
