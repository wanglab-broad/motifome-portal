/* =============================================================================
   gomap.js — the interactive GO enrichment map.

   One bubble = one enriched GO term. Radius from term size K. Colour = the
   module the term is enriched in; a term enriched in SEVERAL modules is drawn
   as a pie, which is the point of the picture — it shows where the six modules
   share biology and where they do not. Grey discs are MCL clusters of terms
   with an auto-generated 3-word label. Faint edges are gene-set similarity.

   The payload (data/go_map.json) is baked by code/build/12_go_map.py, which
   IMPORTS the published figure script and reuses its pipeline verbatim, so this
   is the same analysis as manuscript Fig 3d / ED 3b rather than a lookalike:
   disc labels and per-disc term counts match the published *_clusters.csv
   exactly for all four branches.

   Colours come from the PORTAL's module tokens, not the figure's. The paper
   draws M1 blue and M5 grey; the portal has drawn M1 orange and M5 blue on the
   home cards, the network and every cluster chip since it was built. A reader
   who just saw M1 orange in the network must not meet a blue M1 here.
   ============================================================================= */

import { el, clear, append, fmt, moduleColor, moduleLabel, emptyState, skeleton } from './ui.js';
import * as data from './data.js';

const BRANCHES = [
  ['ALL', 'All'], ['BP', 'Biological process'],
  ['MF', 'Molecular function'], ['CC', 'Cellular component']
];

let styled = false;
function ensureStyles() {
  if (styled) return;
  styled = true;
  document.head.appendChild(el('style', { id: 'mirto-gomap-css' }, `
.gm-wrap{position:relative}
.gm-head{display:flex;gap:var(--s3);align-items:baseline;flex-wrap:wrap;margin-bottom:var(--s3)}
.gm-tabs{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap}
.gm-tabs button{font:inherit;font-size:var(--fs-xs);padding:3px 10px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink-2);border-radius:var(--r-sm);cursor:pointer}
.gm-tabs button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--ink-inv)}
/* A hard ceiling on how much page the map may take. width:100% + height:auto
   would otherwise let a tall layout render ~3,000px high on a wide panel and
   swamp the table underneath. With the default preserveAspectRatio the SVG
   scales down to fit and centres itself, so capping the height never distorts
   it. The bake now also packs the discs into a landscape box, so this cap is a
   safety net rather than the primary fix. */
.gm-canvas{width:100%;height:auto;max-height:min(58vh,560px);display:block;
  overflow:visible;background:var(--surface)}
@media (max-width:900px){.gm-canvas{max-height:min(52vh,420px)}}
.gm-disc{fill:var(--surface-2);stroke:var(--line);stroke-width:1}
.gm-disc.hot{stroke:var(--ink-3);stroke-width:1.6}
.gm-edge{stroke:var(--line-strong);fill:none}
.gm-node{cursor:pointer}
.gm-node circle,.gm-node path{stroke:var(--surface);stroke-width:.5}
.gm-node.dim{opacity:.18}
.gm-node.hot circle,.gm-node.hot path{stroke:var(--ink);stroke-width:1.2}
.gm-leader{stroke:var(--ink-3);stroke-width:.6;opacity:.55}
.gm-lab{font-size:9px;fill:var(--ink-2);pointer-events:none;
  paint-order:stroke;stroke:var(--surface);stroke-width:2.4px;stroke-linejoin:round}
.gm-legend{display:flex;gap:var(--s3);flex-wrap:wrap;align-items:center;margin-top:var(--s3);
  font-size:var(--fs-xs);color:var(--ink-3)}
.gm-legend .sw{display:inline-flex;align-items:center;gap:5px}
.gm-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.gm-tip{position:absolute;z-index:20;pointer-events:none;max-width:290px;
  background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--r-md);
  box-shadow:var(--shadow-2);padding:var(--s2) var(--s3);font-size:var(--fs-xs);line-height:1.45}
.gm-tip b{display:block;color:var(--ink);margin-bottom:2px;font-size:var(--fs-sm)}
.gm-tip .kv{color:var(--ink-3)}
.gm-tip .mods{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
`));
}

/** Pie slices for a term enriched in several modules. One module -> a circle. */
function nodeMark(n, onPick) {
  const g = el('g', { class: 'gm-node', role: 'button', tabindex: '-1',
    dataset: { term: n.t } });
  const mods = n.m && n.m.length ? n.m : [0];
  if (mods.length === 1) {
    g.appendChild(el('circle', { cx: n.x, cy: n.y, r: n.r,
      style: { fill: moduleColor(mods[0]) } }));
  } else {
    const step = (Math.PI * 2) / mods.length;
    mods.forEach((m, i) => {
      const a0 = -Math.PI / 2 + i * step, a1 = a0 + step;
      const x0 = n.x + n.r * Math.cos(a0), y0 = n.y + n.r * Math.sin(a0);
      const x1 = n.x + n.r * Math.cos(a1), y1 = n.y + n.r * Math.sin(a1);
      g.appendChild(el('path', {
        d: `M${n.x},${n.y} L${x0},${y0} A${n.r},${n.r} 0 ${step > Math.PI ? 1 : 0} 1 ${x1},${y1} Z`,
        style: { fill: moduleColor(m) }
      }));
    });
  }
  if (onPick) g.addEventListener('click', () => onPick(n));
  return g;
}

/** Place disc labels largest disc first.
 *
 *  The discs are packed tight, so the space directly above a disc is usually
 *  another disc — an earlier version only checked label-vs-label and dropped
 *  captions on top of neighbouring discs. Each label therefore tries four
 *  positions and must clear BOTH every disc and every label already placed;
 *  when it lands somewhere other than straight above its own disc, a leader
 *  line says which disc it belongs to. A label that cannot be placed anywhere
 *  is dropped rather than drawn over the map — it is still on hover. */
function placeLabels(svg, clusters, W, H) {
  const CH = 5.2, LH = 10, GAP = 4;
  const placed = [];
  const discs = clusters.map(c => ({ cx: c.cx, cy: c.cy, R: c.R }));

  const hitsDisc = (b, own) => discs.some(d => {
    if (d === own) return false;
    const nx = Math.max(b.x0, Math.min(d.cx, b.x1));
    const ny = Math.max(b.y0, Math.min(d.cy, b.y1));
    const dx = d.cx - nx, dy = d.cy - ny;
    return dx * dx + dy * dy < d.R * d.R;
  });
  const hitsLabel = b => placed.some(p =>
    !(b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1));

  let n = 0;
  const order = [...clusters].sort((a, b) => b.R - a.R);
  for (const c of order) {
    const words = String(c.label).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > 16 && line) { lines.push(line); line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) lines.push(line);
    const wpx = Math.max(...lines.map(l => l.length)) * CH;
    const hpx = lines.length * LH;
    const own = discs[clusters.indexOf(c)];

    // above · below · right · left, in that order of preference
    const cands = [
      { x: c.cx, y: c.cy - c.R - GAP - hpx, anchor: 'middle' },
      { x: c.cx, y: c.cy + c.R + GAP, anchor: 'middle' },
      { x: c.cx + c.R + GAP, y: c.cy - hpx / 2, anchor: 'start' },
      { x: c.cx - c.R - GAP, y: c.cy - hpx / 2, anchor: 'end' }
    ];
    let put = null;
    for (const cand of cands) {
      const x0 = cand.anchor === 'middle' ? cand.x - wpx / 2
               : cand.anchor === 'start' ? cand.x : cand.x - wpx;
      const box = { x0: x0 - 2, x1: x0 + wpx + 2, y0: cand.y - 2, y1: cand.y + hpx + 2 };
      if (box.y0 < -28 || box.y1 > H + 28 || box.x0 < -28 || box.x1 > W + 28) continue;
      if (hitsDisc(box, own) || hitsLabel(box)) continue;
      put = { cand, box };
      break;
    }
    if (!put) continue;
    placed.push(put.box);
    n++;

    if (put.cand !== cands[0]) {                 // not straight above: draw a leader
      const lx = put.cand.anchor === 'start' ? put.box.x0
               : put.cand.anchor === 'end' ? put.box.x1 : c.cx;
      const ly = put.cand === cands[1] ? put.box.y0 : put.cand.y + hpx / 2;
      const ux = c.cx + (lx - c.cx) * (c.R / Math.max(Math.hypot(lx - c.cx, ly - c.cy), 1e-6));
      const uy = c.cy + (ly - c.cy) * (c.R / Math.max(Math.hypot(lx - c.cx, ly - c.cy), 1e-6));
      svg.appendChild(el('line', { class: 'gm-leader', x1: ux, y1: uy, x2: lx, y2: ly }));
    }

    const t = el('text', { class: 'gm-lab', x: put.cand.x, y: put.cand.y + LH - 2,
      style: { textAnchor: put.cand.anchor }, dataset: { disc: c.id } });
    lines.forEach((l, i) => t.appendChild(
      el('tspan', { x: put.cand.x, dy: i ? LH : 0 }, l)));
    svg.appendChild(t);
  }
  return n;
}

/**
 * render(host, opts)
 *   opts.onPickTerm(node)      a bubble was clicked
 *   opts.onPickCluster(disc)   a disc label / disc was clicked
 *   opts.branch                initial branch key, default 'ALL'
 */
export async function render(host, opts) {
  opts = opts || {};
  ensureStyles();
  const wrap = el('div.gm-wrap');
  host.appendChild(wrap);
  wrap.appendChild(skeleton({ rows: 3, label: 'Loading the GO enrichment map' }));

  const map = await data.getGoMap();
  clear(wrap);

  if (!map || !map.branches) {
    wrap.appendChild(emptyState({
      mark: '◌',
      title: 'The GO enrichment map has not been baked',
      message: 'This view needs data/go_map.json, written by code/build/12_go_map.py. ' +
               'Everything else on this page works without it.',
      denominator: 'expected 4 branches · 308–339 terms each'
    }));
    return;
  }

  let branch = BRANCHES.some(b => b[0] === opts.branch) ? opts.branch : 'ALL';
  const head = el('div.gm-head');
  const body = el('div');
  const legend = el('div.gm-legend');
  const tip = el('div.gm-tip', { style: { display: 'none' } });
  append(wrap, [head, body, legend, tip]);

  const tabs = el('div.gm-tabs');
  head.appendChild(el('p.eyebrow.mono', { style: { margin: 0 } }, 'GO ENRICHMENT MAP'));
  head.appendChild(tabs);

  function draw() {
    const b = map.branches[branch];
    clear(body); clear(legend); clear(tabs);

    for (const [k, label] of BRANCHES) {
      const n = map.branches[k] ? map.branches[k].nodes.length : 0;
      tabs.appendChild(el('button', {
        type: 'button', 'aria-pressed': String(k === branch),
        title: label + ' — ' + n + ' enriched terms',
        on: { click: () => { branch = k; draw(); } }
      }, k === 'ALL' ? 'All' : k));
    }

    if (!b || !b.nodes.length) {
      body.appendChild(emptyState({ compact: true, mark: '◌',
        title: 'No terms in this branch', denominator: 'try All' }));
      return;
    }

    // extent from the data, with room for the labels that sit above discs
    let maxX = 0, maxY = 0;
    for (const c of b.clusters) { maxX = Math.max(maxX, c.cx + c.R); maxY = Math.max(maxY, c.cy + c.R); }
    const W = Math.ceil(maxX + 60), H = Math.ceil(maxY + 60);
    const svg = el('svg', {
      class: 'gm-canvas', viewBox: `-30 -30 ${W + 30} ${H + 30}`,
      role: 'img', 'aria-label':
        `GO enrichment map, ${b.nodes.length} terms in ${b.clusters.length} labelled clusters`
    });

    const gDisc = el('g'), gEdge = el('g'), gNode = el('g');
    append(svg, [gDisc, gEdge, gNode]);

    for (const c of b.clusters) {
      gDisc.appendChild(el('circle', { class: 'gm-disc', cx: c.cx, cy: c.cy, r: c.R,
        dataset: { disc: c.id } }));
    }
    for (const [i, j, w] of b.edges) {
      const a = b.nodes[i], z = b.nodes[j];
      if (!a || !z) continue;
      gEdge.appendChild(el('line', { class: 'gm-edge', x1: a.x, y1: a.y, x2: z.x, y2: z.y,
        style: { strokeWidth: (0.25 + 0.7 * (w - 0.5)).toFixed(2), strokeOpacity: 0.35 } }));
    }
    const marks = b.nodes.map(n => nodeMark(n, opts.onPickTerm));
    marks.forEach(m => gNode.appendChild(m));

    const nLab = placeLabels(svg, b.clusters, W, H);   // appends into svg, on top
    body.appendChild(svg);

    /* ---- hover ---------------------------------------------------------- */
    const discById = new Map(b.clusters.map(c => [c.id, c]));
    svg.addEventListener('mousemove', ev => {
      const g = ev.target.closest && ev.target.closest('.gm-node');
      if (!g) { tip.style.display = 'none'; marks.forEach(m => m.classList.remove('hot')); return; }
      const n = b.nodes.find(x => x.t === g.dataset.term);
      if (!n) return;
      marks.forEach(m => m.classList.toggle('hot', m === g));
      const disc = discById.get(n.c);
      clear(tip);
      append(tip, [
        el('b', n.n),
        el('div.kv', 'term size ' + fmt.int(n.K) + ' · up to ' + fmt.int(n.k) +
                     ' member genes · FDR ' + fmt.sci(n.q, 1)),
        disc ? el('div.kv', 'in “' + disc.label + '” (' + disc.n + ' terms)') : null,
        el('div.mods', (n.m || []).map(m => el('span.sw', [
          el('span.dot', { style: { background: moduleColor(m) } }),
          el('span', 'M' + m + ' ' + moduleLabel(m).slice(0, 28))
        ])))
      ]);
      tip.style.display = '';
      const r = wrap.getBoundingClientRect();
      const x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
      tip.style.left = Math.min(x, r.width - 300) + 'px';
      tip.style.top = y + 'px';
    });
    svg.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      marks.forEach(m => m.classList.remove('hot'));
    });

    /* ---- legend --------------------------------------------------------- */
    for (let m = 1; m <= 6; m++) {
      legend.appendChild(el('span.sw', [
        el('span.dot', { style: { background: moduleColor(m) } }),
        el('span', 'M' + m)
      ]));
    }
    append(legend, [
      el('span', '· a split bubble is one term enriched in several modules'),
      el('span', '· bubble size = term size'),
      el('span', '· grey disc = a cluster of similar terms'),
      el('span.mono', b.nodes.length + ' terms · ' + b.clusters.length + ' clusters · ' +
        nLab + ' labelled')
    ]);
  }

  draw();
}
