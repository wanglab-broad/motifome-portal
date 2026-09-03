/* =============================================================================
   router.js — hash routing for the MIRTO Atlas.

   Design rule this file exists to enforce: EVERY view state a reader would send
   to a colleague lives in the URL. The path carries the object; the query string
   carries the filters. Nothing that changes what is on screen may live only in a
   JS variable.

     #/                         home
     #/gene/NM_001101           gene view       ?region=utr5&sel=12&hl=utr3_0215
     #/cluster/utr3_0215        cluster view    ?tab=partners&pass=1&sort=score
     #/network                  network view    ?module=4&minsc=0.3&cross=1&sel=prot_0072
     #/network/4                network, scoped to module 4
     #/module/4                 module detail
     #/browse                   browse/index    ?kind=cluster&region=utr3&page=2

   Public API
     register(pattern, handler)      pattern '/gene/:refseq'; handler(container, params)
     navigate(path, opts)            opts {replace, query}
     link(path, query)               -> '#/gene/NM_1?region=utr5'   (for href=)
     start(opts)                     opts {container, notFound, before, after}
     current()                       -> {path, params, query, hash, route}
     getQuery() / setQuery(patch, o) o {replace, silent}
     onQuery(fn)                     per-route query listener; auto-cleared on route change
     onRoute(fn)                     fires after every successful route render
     refresh()                       force a re-render of the current route
   ============================================================================= */

const routes = [];
let notFoundHandler = null;
let container = null;
let beforeHook = null;
let afterHook = null;

let state = { path: '/', params: {}, query: {}, hash: '#/', route: null };
let queryListeners = [];
let routeListeners = [];
let started = false;
let suppress = 0;          // ignore the next N hashchange events (self-inflicted URL writes)
let renderToken = 0;       // guards against a slow async view painting over a newer one

/* ---------- parsing ------------------------------------------------------ */

function decode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

export function parseHash(raw) {
  let h = raw == null ? (location.hash || '') : raw;
  if (h.startsWith('#')) h = h.slice(1);
  if (h === '' || h === '/') h = '/';
  if (!h.startsWith('/')) h = '/' + h;

  const qi = h.indexOf('?');
  const path = qi === -1 ? h : h.slice(0, qi);
  const qs = qi === -1 ? '' : h.slice(qi + 1);

  const query = {};
  if (qs) {
    for (const part of qs.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = decode((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
      const v = eq === -1 ? '' : decode(part.slice(eq + 1).replace(/\+/g, ' '));
      if (!k) continue;
      if (k in query) {                       // repeated key -> array
        if (Array.isArray(query[k])) query[k].push(v);
        else query[k] = [query[k], v];
      } else query[k] = v;
    }
  }
  // normalise trailing slash, keep the root as '/', and decode each segment so
  // `path` and the route params agree and are human-readable.
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : '/';
  const decoded = clean === '/' ? '/' : clean.split('/').map(decode).join('/');
  return { path: decoded || '/', query };
}

/** Encode a path segment without double-encoding one that is already escaped. */
function encSeg(s) {
  return encodeURIComponent(String(s)).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
}

export function stringifyQuery(q) {
  if (!q) return '';
  const parts = [];
  for (const k of Object.keys(q)) {
    const v = q[k];
    if (v == null || v === '' || v === false) continue;
    const vals = Array.isArray(v) ? v : [v];
    for (const one of vals) {
      if (one == null || one === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(one)));
    }
  }
  return parts.join('&');
}

export function link(path, query) {
  let p = String(path || '/');
  if (p.startsWith('#')) p = p.slice(1);
  const qi = p.indexOf('?');
  let inlineQ = null;
  if (qi !== -1) { inlineQ = p.slice(qi + 1); p = p.slice(0, qi); }
  if (!p.startsWith('/')) p = '/' + p;
  p = p === '/' ? '/' : p.split('/').map((s, i) => (i === 0 ? s : encSeg(s))).join('/');
  let qs = stringifyQuery(query);
  if (inlineQ && !qs) qs = inlineQ;              // link('#/gene/X?region=utr5') round-trips
  return '#' + p + (qs ? '?' + qs : '');
}

/* ---------- pattern matching --------------------------------------------- */

function compile(pattern) {
  let p = String(pattern);
  if (p.startsWith('#')) p = p.slice(1);
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const segs = p.split('/').filter((s, i) => i > 0 || s !== '');
  return { pattern: p, segs };
}

function match(route, path) {
  const want = route.segs;
  const got = path.split('/').filter((s, i) => i > 0 || s !== '');
  const params = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    // `path` arrives already decoded from parseHash(), so no decoding here.
    if (w === '*') { params.rest = got.slice(i).join('/'); return params; }
    if (i >= got.length) return null;
    if (w.startsWith(':')) {
      const key = w.slice(1).replace(/\?$/, '');
      params[key] = got[i];
    } else if (w.toLowerCase() !== got[i].toLowerCase()) {
      return null;
    }
  }
  if (got.length !== want.length) return null;
  return params;
}

function resolve(path) {
  for (const r of routes) {
    const params = match(r, path);
    if (params) return { route: r, params };
  }
  return null;
}

/* ---------- registration -------------------------------------------------- */

export function register(pattern, handler) {
  if (typeof handler !== 'function') throw new TypeError('register(): handler must be a function');
  const r = compile(pattern);
  r.handler = handler;
  // Longest, most literal pattern wins: sort by segment count desc, then by
  // number of literal (non-:param) segments desc. So '/network/:module' is
  // considered before '/network' and '/module/:n' never shadows '/module'.
  routes.push(r);
  routes.sort((a, b) => {
    if (b.segs.length !== a.segs.length) return b.segs.length - a.segs.length;
    const lit = x => x.segs.filter(s => !s.startsWith(':') && s !== '*').length;
    return lit(b) - lit(a);
  });
  return r;
}

export function setNotFound(handler) { notFoundHandler = handler; }

/* ---------- query listeners ---------------------------------------------- */

export function onQuery(fn) {
  queryListeners.push(fn);
  return () => { queryListeners = queryListeners.filter(f => f !== fn); };
}

export function onRoute(fn) {
  routeListeners.push(fn);
  return () => { routeListeners = routeListeners.filter(f => f !== fn); };
}

/* ---------- navigation ---------------------------------------------------- */

function writeHash(hash, replace) {
  if (hash === location.hash) return false;
  suppress++;
  if (replace && window.history && history.replaceState) {
    history.replaceState(history.state, '', hash);
  } else if (window.history && history.pushState) {
    history.pushState(null, '', hash);
  } else {
    location.hash = hash;                       // falls through to a hashchange
    return true;
  }
  // pushState/replaceState do NOT fire hashchange, so we un-suppress ourselves
  suppress = Math.max(0, suppress - 1);
  return true;
}

export function navigate(path, opts) {
  opts = opts || {};
  const target = link(path, opts.query);
  const changed = writeHash(target, opts.replace);
  if (changed || opts.force) handle(true);
}

export function getQuery() { return Object.assign({}, state.query); }

/**
 * Merge `patch` into the current query string.
 *  - a key set to null / undefined / '' is REMOVED (that is how a filter clears)
 *  - by default this is a QUIET update: the URL changes and onQuery listeners fire,
 *    but the view is not remounted. Pass {silent:false, remount:true} to re-render.
 */
export function setQuery(patch, opts) {
  opts = opts || {};
  const next = Object.assign({}, state.query);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v == null || v === '' || v === false) delete next[k];
    else next[k] = v;
  }
  const hash = link(state.path, next);
  if (hash === location.hash) return;
  writeHash(hash, opts.replace !== false);       // filters default to replaceState
  state.query = parseHash(hash).query;
  state.hash = hash;
  if (opts.remount) { handle(true); return; }
  if (!opts.silent) emitQuery();
}

function emitQuery() {
  const q = getQuery();
  for (const fn of queryListeners.slice()) {
    try { fn(q, state); } catch (e) { console.error('[router] onQuery listener failed', e); }
  }
}

export function current() {
  return { path: state.path, params: Object.assign({}, state.params), query: getQuery(),
           hash: state.hash, route: state.route ? state.route.pattern : null };
}

export function refresh() { handle(true); }

/* ---------- the render cycle --------------------------------------------- */

async function handle(force) {
  const { path, query } = parseHash();
  const hit = resolve(path);
  const samePlace = !force && state.route && hit && hit.route === state.route &&
                    shallowEqual(state.params, hit.params) && state.path === path;

  if (samePlace) {
    // only the query string moved (back/forward over a filter change, or a
    // #anchor). Let the mounted view update in place if it asked to.
    const qChanged = !shallowEqual(state.query, query);
    state.query = query;
    state.hash = location.hash || '#/';
    if (qChanged) {
      if (queryListeners.length) emitQuery();
      else return void handle(true);            // view did not opt in -> remount
    }
    return;
  }

  queryListeners = [];                          // per-route; always cleared on move
  state = {
    path,
    params: hit ? hit.params : {},
    query,
    hash: location.hash || '#/',
    route: hit ? hit.route : null
  };

  const token = ++renderToken;
  const handler = hit ? hit.route.handler : notFoundHandler;

  if (beforeHook) { try { beforeHook(current()); } catch (e) { console.error(e); } }

  if (!handler) {
    if (container) container.textContent = '';
    return;
  }

  const params = Object.assign({}, state.params, {
    query: getQuery(),
    path: state.path,
    hash: state.hash,
    route: hit ? hit.route.pattern : null
  });

  try {
    const out = handler(container, params);
    if (out && typeof out.then === 'function') await out;
  } catch (err) {
    console.error('[router] view threw while rendering ' + state.path, err);
    if (token === renderToken && container) renderCrash(container, state.path, err);
  }

  if (token !== renderToken) return;            // a newer navigation already won

  if (afterHook) { try { afterHook(current()); } catch (e) { console.error(e); } }
  for (const fn of routeListeners.slice()) {
    try { fn(current()); } catch (e) { console.error('[router] onRoute listener failed', e); }
  }
}

function renderCrash(host, path, err) {
  host.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML =
    '<section class="placeholder-view">' +
    '<p class="eyebrow mono">view error</p>' +
    '<h1>This view failed to render.</h1>' +
    '<p>The rest of the atlas still works — use the navigation above or press ' +
    '<kbd>⌘</kbd><kbd>K</kbd> to search. The underlying error is in the browser console.</p>' +
    '<pre class="mono"></pre></section>';
  wrap.querySelector('pre').textContent = path + '\n' + (err && err.message ? err.message : String(err));
  host.appendChild(wrap);
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k], y = b[k];
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/* ---------- boot ---------------------------------------------------------- */

export function start(opts) {
  opts = opts || {};
  container = opts.container || document.getElementById('main');
  notFoundHandler = opts.notFound || notFoundHandler;
  beforeHook = opts.before || null;
  afterHook = opts.after || null;

  if (!started) {
    started = true;
    window.addEventListener('hashchange', () => {
      if (suppress > 0) { suppress--; return; }
      handle(false);
    });
    window.addEventListener('popstate', () => handle(false));
    // in-page links: let the browser do the work, but normalise a bare '#'
    document.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href="#"]') : null;
      if (a) ev.preventDefault();
    });
  }

  if (!location.hash || location.hash === '#') {
    writeHash('#/', true);
  }
  handle(true);
}
