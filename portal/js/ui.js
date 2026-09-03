/* =============================================================================
   ui.js — the shared vocabulary every view composes from.

   If a view needs a chip, a badge, an empty state, a skeleton, a caveat or a
   download, it comes from here. Views must not re-invent these: the point is
   that a module colour, a region badge and an empty state look and behave
   identically in the gene view, the cluster view and the network view.
   ============================================================================= */

import * as router from './router.js';
import { MODULE_COLORS, MODULE_LABELS, search as dataSearch, searchIndexReady } from './data.js';

/* =============================================================================
   el() — the hyperscript helper
   el('div.card', {id:'x', dataset:{k:1}, on:{click:fn}}, [child, 'text'])
   ============================================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'line', 'text', 'polyline',
  'polygon', 'defs', 'use', 'clipPath', 'linearGradient', 'stop', 'ellipse', 'tspan',
  'marker', 'pattern', 'foreignObject', 'title', 'desc', 'image']);

export function el(spec, props, children) {
  // 'div.card.pad#id' -> tag + classes + id
  let tag = 'div', cls = [], id = null;
  const m = String(spec).match(/^([a-zA-Z0-9]+)?((?:[.#][^.#]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    if (m[2]) {
      for (const tok of m[2].match(/[.#][^.#]+/g) || []) {
        if (tok[0] === '.') cls.push(tok.slice(1)); else id = tok.slice(1);
      }
    }
  } else tag = String(spec);

  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag)
                                 : document.createElement(tag);

  // allow el('div', 'text') and el('div', [children])
  if (props != null && (typeof props === 'string' || typeof props === 'number' ||
      Array.isArray(props) || props instanceof Node)) {
    children = props; props = null;
  }
  props = props || {};

  if (cls.length) addClass(node, cls.join(' '));
  if (id) node.id = id;

  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') addClass(node, v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = v;                   // callers only pass literals
    else if (k === 'dataset') { for (const dk of Object.keys(v)) if (v[dk] != null) node.dataset[dk] = v[dk]; }
    else if (k === 'style') {
      if (typeof v === 'string') node.setAttribute('style', v);
      else for (const sk of Object.keys(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, v[sk]); else node.style[sk] = v[sk];
      }
    }
    else if (k === 'on') { for (const ek of Object.keys(v)) node.addEventListener(ek, v[ek]); }
    else if (k === 'ref' && typeof v === 'function') v(node);
    else if (k in node && !SVG_TAGS.has(tag) && typeof v !== 'object') {
      try { node[k] = v; } catch (e) { node.setAttribute(k, String(v)); }
    }
    else node.setAttribute(k, v === true ? '' : String(v));
  }

  append(node, children);
  return node;
}

function addClass(node, v) {
  const s = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
  if (!s) return;
  if (node.namespaceURI === SVG_NS) node.setAttribute('class',
    ((node.getAttribute('class') || '') + ' ' + s).trim());
  else node.className = ((node.className || '') + ' ' + s).trim();
}

export function append(node, children) {
  if (children == null || children === false) return node;
  if (Array.isArray(children)) { for (const c of children) append(node, c); return node; }
  if (children instanceof Node) { node.appendChild(children); return node; }
  node.appendChild(document.createTextNode(String(children)));
  return node;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

export function mount(host, ...children) { clear(host); append(host, children); return host; }

/* =============================================================================
   formatting
   ============================================================================= */

const NF = new Intl.NumberFormat('en-US');
export const fmt = {
  int(n) { return Number.isFinite(+n) ? NF.format(Math.round(+n)) : '—'; },
  num(n, d) {
    if (!Number.isFinite(+n)) return '—';
    return (+n).toFixed(d == null ? 3 : d);
  },
  /* Switches to exponential whenever fixed notation would ROUND THE VALUE AWAY.
     The old rule keyed only on |n| < 1e-3, so sci(0.0027, 1) printed "0.0" — an
     E-value or FDR of 0.0027 rendered as zero, which is a false claim. Two view
     agents each shipped their own helper (R2.sig, G.pval) to dodge exactly this;
     this makes the shared formatter safe for whoever reaches for it next. */
  sci(n, d) {
    if (!Number.isFinite(+n)) return '—';
    const v = +n, a = Math.abs(v), dp = d == null ? 2 : d;
    if (a === 0) return '0';
    if (a < 1e-3 || a >= 1e5 || +v.toFixed(dp) === 0) return v.toExponential(d == null ? 1 : d);
    return v.toFixed(dp);
  },
  pct(x, d) { return Number.isFinite(+x) ? (100 * +x).toFixed(d == null ? 1 : d) + '%' : '—'; },
  /** "437 of 900" */
  of(k, n) { return fmt.int(k) + ' of ' + fmt.int(n); },
  bp(n) { return Number.isFinite(+n) ? NF.format(+n) + ' nt' : '—'; },
  aa(n) { return Number.isFinite(+n) ? NF.format(+n) + ' aa' : '—'; }
};

/** T -> U, for utr5 / utr3 display ONLY. Never call this on a protein sequence:
 *  U there is selenocysteine. */
export function toRNA(s) { return typeof s === 'string' ? s.replace(/T/g, 'U').replace(/t/g, 'u') : s; }
/* T->U applies to every NUCLEOTIDE region: 5'UTR, CDS and 3'UTR are all mRNA.
   The carve-out is the PROTEIN sequence, where U is selenocysteine and mapping
   would corrupt a real residue. Mapping the UTRs but not the CDS was the earlier
   reading of that rule, and it printed a single mRNA line as ...CUCACC|ATGGAT...
   — U on both flanks, T in the middle — which reads as a data error. */
export function displaySeq(s, region) {
  return (region === 'utr5' || region === 'utr3' || region === 'cds') ? toRNA(s) : s;
}
export function isRNARegion(r) { return r === 'utr5' || r === 'utr3'; }

export const REGION_LABEL = { utr5: "5′ UTR", utr3: "3′ UTR", protein: 'Protein', cds: 'CDS' };
export const REGION_SHORT = { utr5: "5′UTR", utr3: "3′UTR", protein: 'PROT', cds: 'CDS' };

export function moduleColor(m) { return MODULE_COLORS[Number(m) || 0] || MODULE_COLORS[0]; }
export function moduleLabel(m) {
  const n = Number(m) || 0;
  return n ? (MODULE_LABELS[n] || 'Module M' + n) : 'No module';
}

/* =============================================================================
   chips & badges
   ============================================================================= */

/** Module colour chip. m = 1..6, or 0/null for unassigned. */
export function moduleChip(m, opts) {
  opts = opts || {};
  const n = Number(m) || 0;
  const label = opts.label != null ? opts.label : (n ? 'M' + n : 'no module');
  const cls = 'chip chip-mod mod-' + n + (opts.quiet ? ' quiet' : '');
  const kids = [opts.quiet ? el('span.chip-dot') : null, el('span', { text: label })];
  const title = n ? 'Module M' + n + ' — ' + moduleLabel(n)
                  : 'Not assigned to a module (387 of 900 clusters)';
  if (opts.href !== false && n) {
    return el('a', { class: cls, href: opts.href || ('#/module/' + n), title }, kids);
  }
  return el('span', { class: cls, title }, kids);
}

/** Region badge: RNA blue for utr5/utr3, vermillion for protein. */
export function regionBadge(region, opts) {
  opts = opts || {};
  const r = String(region || '').toLowerCase();
  const cls = 'chip badge-region reg-' + (r || 'utr');
  return el('span', { class: cls, title: REGION_LABEL[r] || r },
    [el('span.chip-dot'), el('span', { text: opts.long ? (REGION_LABEL[r] || r) : (REGION_SHORT[r] || r) })]);
}

export function pill(text, opts) {
  opts = opts || {};
  return el(opts.href ? 'a' : 'span',
    { class: 'chip' + (opts.class ? ' ' + opts.class : ''), href: opts.href, title: opts.title,
      style: { background: 'var(--surface-2)', color: 'var(--ink-2)', borderColor: 'var(--line)' } },
    text);
}

/* =============================================================================
   the caveat — non-dismissible by construction: no close control is rendered,
   and nothing in this module can remove it.
   ============================================================================= */

/* =============================================================================
   empty state — takes a message AND its denominator. A blank panel is a bug.
   ============================================================================= */

/**
 * emptyState({title, message, denominator, mark, action})
 *   denominator: '437 of 900 clusters have no significant term'  (string)
 *                or {k:437, n:900, unit:'clusters have no significant term'}
 */
export function emptyState(opts) {
  opts = opts || {};
  let denom = opts.denominator;
  if (denom && typeof denom === 'object') {
    denom = fmt.of(denom.k, denom.n) + (denom.unit ? ' ' + denom.unit : '');
  }
  return el('div.empty' + (opts.compact ? '.compact' : ''), { role: 'status' }, [
    el('div.empty-mark', { 'aria-hidden': 'true' }, opts.mark || '⌀'),
    el('h4', opts.title || 'Nothing to show here'),
    opts.message ? el('p', opts.message) : null,
    denom ? el('span.denom', denom) : null,
    opts.action ? el('div', { style: { marginTop: 'var(--s4)' } }, opts.action) : null
  ]);
}

/** The measured denominators, so every view prints the same number. */
export const DENOMINATORS = {
  noModule:      { k: 387, n: 900, unit: 'clusters have no module' },
  noTerm:        { k: 437, n: 900, unit: 'clusters have no significant term' },
  noLogo:        { k: 444, n: 900, unit: 'clusters have no defensible sequence logo' },
  utrNoPartner:  { k: 282, n: 600, unit: 'UTR clusters have zero passing partners' },
  protNoPartner: { k: 99,  n: 300, unit: 'protein clusters have zero passing partners' },
  noModuleGene:  { k: 58,  n: 18093, unit: 'transcripts touch no module' },
  edgeNoPair:    { k: 1190, n: 2620, unit: 'gated edges are cluster-level only' }
};

/* =============================================================================
   loading skeleton
   ============================================================================= */

export function skeleton(opts) {
  opts = opts || {};
  const rows = opts.rows || 5;
  const host = el('div.skeleton', { 'aria-busy': 'true', 'aria-label': opts.label || 'Loading' });
  if (opts.title !== false) host.appendChild(el('div.sk', { style: { height: '24px', width: '34%', marginBottom: '18px' } }));
  const widths = ['92%', '78%', '85%', '64%', '88%', '71%', '80%', '58%'];
  for (let i = 0; i < rows; i++) {
    host.appendChild(el('div.sk', { style: { height: (opts.height || 12) + 'px', width: widths[i % widths.length] } }));
  }
  return host;
}

export function skeletonCards(n, h) {
  const g = el('div.grid.grid-3');
  for (let i = 0; i < (n || 3); i++) g.appendChild(el('div.sk', { style: { height: (h || 110) + 'px', width: '100%' } }));
  return g;
}

/* =============================================================================
   toast
   ============================================================================= */

let toastHost = null;
export function toast(message, ms) {
  if (!toastHost) {
    toastHost = el('div.toast-host', { 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = el('div.toast', message);
  toastHost.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .2s'; }, (ms || 1900) - 220);
  setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, ms || 1900);
}

/* =============================================================================
   copy link
   ============================================================================= */

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through to the textarea trick */ }
  try {
    const ta = el('textarea', { value: text, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}

/**
 * copyLinkButton({href, label, title})
 * Copies the deep link for the CURRENT view (filters included) unless a href is
 * given. `href` may be a hash ('#/cluster/utr3_0215?tab=partners').
 */
export function copyLinkButton(opts) {
  opts = opts || {};
  const btn = el('button.btn.btn-sm', {
    type: 'button',
    title: opts.title || 'Copy a link to exactly this view, filters included',
    on: {
      click: async () => {
        const hash = opts.href || location.hash || '#/';
        const url = location.origin === 'null'
          ? location.href.split('#')[0] + hash
          : new URL(hash, location.href.split('#')[0]).href;
        const ok = await copyText(url);
        btn.classList.toggle('ok', ok);
        btn.querySelector('.cl-label').textContent = ok ? 'Copied' : 'Press ⌘C';
        toast(ok ? 'Link copied — filters included' : 'Could not copy automatically');
        setTimeout(() => {
          btn.classList.remove('ok');
          btn.querySelector('.cl-label').textContent = opts.label || 'Copy link';
        }, 1600);
      }
    }
  }, [el('span', { 'aria-hidden': 'true' }, '🔗'), el('span.cl-label', opts.label || 'Copy link')]);
  return btn;
}

/* =============================================================================
   CSV export
   ============================================================================= */

function csvCell(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v.join('; ');
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * toCSV(rows, columns)
 *   rows    : array of objects, or array of arrays
 *   columns : [{key, label}] | ['key', ...] | undefined (inferred from row 0)
 */
export function toCSV(rows, columns) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '';
  let cols = columns;
  if (!cols) {
    cols = Array.isArray(list[0]) ? list[0].map((_, i) => ({ key: i, label: 'c' + i }))
                                  : Object.keys(list[0]).map(k => ({ key: k, label: k }));
  }
  cols = cols.map(c => (typeof c === 'string' ? { key: c, label: c } : c));
  const head = cols.map(c => csvCell(c.label != null ? c.label : c.key)).join(',');
  const body = list.map(r => cols.map(c => csvCell(r[c.key])).join(','));
  return [head].concat(body).join('\r\n') + '\r\n';
}

/** Triggers a download of `rows` as CSV. Returns the row count written. */
export function exportCSV(filename, rows, columns) {
  const text = toCSV(rows, columns);
  if (!text) { toast('Nothing to export'); return 0; }
  downloadBlob(filename || 'mirto-export.csv', text, 'text/csv;charset=utf-8');
  toast(fmt.int(Array.isArray(rows) ? rows.length : 0) + ' rows exported');
  return Array.isArray(rows) ? rows.length : 0;
}

export function exportJSON(filename, obj) {
  downloadBlob(filename || 'mirto-export.json', JSON.stringify(obj, null, 2), 'application/json');
}

export function downloadBlob(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  } catch (e) {
    console.error('[ui] download failed', e);
    toast('Download blocked by the browser');
  }
}

/** A ready-made export button. `getRows` is called at click time. */
export function csvButton(filename, getRows, columns, label) {
  return el('button.btn.btn-sm', {
    type: 'button', title: 'Download this table as CSV',
    on: { click: () => { const r = typeof getRows === 'function' ? getRows() : getRows;
                         exportCSV(filename, r, columns); } }
  }, [el('span', { 'aria-hidden': 'true' }, '⤓'), el('span', label || 'CSV')]);
}

/* =============================================================================
   small structural helpers views use constantly
   ============================================================================= */

export function card(title, tools, body) {
  const c = el('section.card');
  if (title != null) {
    c.appendChild(el('div.card-head', [
      typeof title === 'string' ? el('h3', title) : title,
      tools ? el('div.card-tools', tools) : null
    ]));
  }
  c.appendChild(el('div.card-pad', body));
  return c;
}

export function stat(k, v, sub) {
  return el('div.card.stat', [
    el('span.k', k), el('span.v', v == null ? '—' : v), sub ? el('span.sub', sub) : null
  ]);
}

export function breadcrumb(items) {
  const nav = el('nav.row', { 'aria-label': 'Breadcrumb',
    style: { fontSize: 'var(--fs-sm)', gap: 'var(--s2)', marginBottom: 'var(--s3)' } });
  items.filter(Boolean).forEach((it, i) => {
    if (i) nav.appendChild(el('span.dim', { 'aria-hidden': 'true' }, '›'));
    nav.appendChild(it.href ? el('a', { href: it.href }, it.label)
                            : el('span.dim', it.label));
  });
  return nav;
}

/** A segmented filter control wired straight into the URL query string. */
export function segmented(queryKey, options, opts) {
  opts = opts || {};
  const cur = String(router.getQuery()[queryKey] != null ? router.getQuery()[queryKey]
                                                         : (opts.def == null ? '' : opts.def));
  const host = el('div.seg', { role: 'group', 'aria-label': opts.label || queryKey });
  for (const o of options) {
    const val = String(o.value == null ? o : o.value);
    const b = el('button', {
      type: 'button', 'aria-pressed': String(val === cur), title: o.title,
      on: { click: () => {
        const patch = {}; patch[queryKey] = (opts.def != null && val === String(opts.def)) ? null : val;
        router.setQuery(patch, { remount: !!opts.remount });
        for (const other of host.querySelectorAll('button')) other.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        if (opts.onChange) opts.onChange(val);
      } }
    }, o.label != null ? o.label : val);
    host.appendChild(b);
  }
  return host;
}

/* =============================================================================
   omnibox — the single search entry point (⌘K / Ctrl-K)
   ============================================================================= */

let omni = null;

export function omnibox() {
  if (omni) return omni;

  const input = el('input', {
    type: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
    placeholder: 'Gene symbol, RefSeq, ENSG/ENST, cluster id (utr3_0215), M3…',
    'aria-label': 'Search the atlas', 'aria-controls': 'omni-results', 'aria-expanded': 'true'
  });
  const results = el('div.omni-results#omni-results', { role: 'listbox' });
  const foot = el('div.omni-foot', [
    el('span', [el('kbd', '↑'), el('kbd', '↓'), ' navigate']),
    el('span', [el('kbd', '↵'), ' open']),
    el('span', [el('kbd', 'esc'), ' close']),
    el('span.omni-status', { style: { marginLeft: 'auto' } }, '')
  ]);
  const panel = el('div.omni', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' }, [
    el('div.omni-field', [el('span', { 'aria-hidden': 'true', class: 'dim' }, '⌕'), input,
                          el('kbd', 'esc')]),
    results, foot
  ]);
  const backdrop = el('div.omni-backdrop', { hidden: true, on: {
    mousedown: (e) => { if (e.target === backdrop) close(); }
  } }, [panel]);

  let items = [];
  let cursor = 0;
  let seq = 0;
  let lastFocus = null;
  let debounce = null;

  function renderList(list, q) {
    clear(results);
    items = list;
    cursor = 0;
    if (!q) {
      results.appendChild(el('div.omni-group', 'Jump to'));
      const quick = [
        { label: 'Module network', sub: '519 nodes · 2,620 gated edges', href: '#/network' },
        { label: 'Browse clusters', sub: '900 clusters · 6 modules', href: '#/browse' },
      ];
      quick.forEach((r, i) => results.appendChild(row(r, i)));
      items = quick;
      mark();
      return;
    }
    if (!list.length) {
      results.appendChild(el('div.omni-empty', [
        el('div', { style: { marginBottom: '6px' } }, 'No match for “' + q + '”.'),
        el('div', 'Try a gene symbol (ACTB), a RefSeq (NM_001101), an Ensembl id, ' +
                  'a cluster id (utr3_0215) or M1–M6.')
      ]));
      mark();
      return;
    }
    let group = null;
    list.forEach((r, i) => {
      const g = r.kind === 'gene' ? 'Genes' : r.kind === 'cluster' ? 'Motif clusters'
              : r.kind === 'module' ? 'Modules' : 'Pages';
      if (g !== group) { group = g; results.appendChild(el('div.omni-group', g)); }
      results.appendChild(row(r, i));
    });
    mark();
  }

  function row(r, i) {
    const right = [];
    if (r.module) right.push(moduleChip(r.module, { quiet: true, href: false }));
    if (r.n) right.push(el('span.mono.oi-sub', fmt.int(r.n) + ' motifs'));
    return el('a.omni-item', {
      href: r.href, role: 'option', 'aria-selected': 'false', dataset: { i },
      on: { click: () => close(), mouseenter: () => { cursor = i; mark(); } }
    }, [
      el('span.oi-label', r.label),
      r.sub ? el('span.oi-sub', r.sub) : null,
      right.length ? el('span.oi-right', right) : null
    ]);
  }

  function mark() {
    const nodes = results.querySelectorAll('.omni-item');
    nodes.forEach((n, i) => n.setAttribute('aria-selected', String(i === cursor)));
    const sel = nodes[cursor];
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  async function run() {
    const q = input.value.trim();
    const mine = ++seq;
    const list = await dataSearch(q, { limit: 24 });
    if (mine !== seq) return;
    renderList(list, q);
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 60);
  });

  input.addEventListener('keydown', (e) => {
    const n = results.querySelectorAll('.omni-item').length;
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = n ? (cursor + 1) % n : 0; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = n ? (cursor - 1 + n) % n : 0; mark(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = results.querySelectorAll('.omni-item')[cursor];
      if (sel) { const href = sel.getAttribute('href'); close(); router.navigate(href); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  function open(prefill) {
    lastFocus = document.activeElement;
    backdrop.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    input.value = prefill || '';
    renderList([], '');
    run();
    setTimeout(() => { input.focus(); input.select(); }, 0);
    searchIndexReady().then(s => {
      foot.querySelector('.omni-status').textContent =
        s.ok ? fmt.int(s.genes) + ' transcripts · ' + fmt.int(s.aliases) + ' aliases'
             : 'search index not built yet';
    });
  }

  function close() {
    backdrop.hidden = true;
    document.documentElement.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function isOpen() { return !backdrop.hidden; }

  document.addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && k === 'k') { e.preventDefault(); isOpen() ? close() : open(); return; }
    if (k === 'escape' && isOpen()) { e.preventDefault(); close(); return; }
    if (k === '/' && !isOpen() && !isTyping(e.target)) { e.preventDefault(); open(); }
  });

  omni = { node: backdrop, open, close, isOpen, input };
  return omni;
}

function isTyping(t) {
  if (!t) return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

/* =============================================================================
   misc
   ============================================================================= */

/** Set the document title without losing the atlas identity. */
export function setTitle(parts) {
  const list = (Array.isArray(parts) ? parts : [parts]).filter(Boolean);
  document.title = (list.length ? list.join(' · ') + ' — ' : '') + 'MIRTO Atlas';
}

/** Scroll the content column to the top on a route change (not on filter changes). */
export function scrollTop() {
  try { window.scrollTo({ top: 0, behavior: 'instant' }); }
  catch (e) { window.scrollTo(0, 0); }
}

export { router };
