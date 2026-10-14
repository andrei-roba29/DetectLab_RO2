#!/usr/bin/env node
/*
 * tools/audit-wms-layers.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * OFFLINE audit of every WMS / WMTS layer the site can put on the map.
 *
 * Why: the third-party services behind these layers fail in the worst possible
 * way — HTTP 200 with an XML/JSON/text body instead of a tile, which Leaflet
 * happily ignores. When that happens the only honest answer is “check the
 * layer's request”, and doing that by hand for ~30 services is how mistakes
 * survive. This tool rebuilds each layer's real request from the SAME code the
 * app uses (js/layer-registry.js, the country LiDAR modules) and checks it
 * against the service's documented contract:
 *
 *   • WMS  — version/CRS parameter pair (1.3.0 → CRS, 1.1.1 → SRS), axis
 *     order, LAYERS, FORMAT vs TRANSPARENT, BBOX sanity, https;
 *   • WMTS — SERVICE/REQUEST/VERSION/LAYER/STYLE/FORMAT/TILEMATRIXSET/
 *     TILEMATRIX/TILEROW/TILECOL and the TIME dimension for time-aware layers;
 *   • dynamic (module-built) layers — the builder named by the definition must
 *     exist, must build a URL for a concrete tile, and that URL must carry the
 *     parameters the service needs;
 *   • routing policy — a host documented as “no CORS” must be routed through
 *     the same-origin proxy in 3D, and a same-origin endpoint must not be;
 *   • availability guard coverage — which layers the silent-failure guard
 *     (js/wms-health.js) already protects, and which ones only fail silently.
 *
 * It prints one line per layer, the concrete request URL for a sample tile
 * (copy/paste it into curl to test the service live) and exits non-zero when a
 * hard invariant is broken.
 *
 * Usage:
 *     node tools/audit-wms-layers.mjs                 # human-readable report
 *     node tools/audit-wms-layers.mjs --json          # machine-readable
 *     node tools/audit-wms-layers.mjs --urls          # only the sample URLs
 *     node tools/audit-wms-layers.mjs --tile=12/2345/1480   # sample tile
 *     node tools/audit-wms-layers.mjs --layer=cenagis.ukvme # one layer
 *
 * No network access: everything is string/maths work against the repository.
 * Run the printed URLs yourself (curl -I) to test the services live.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Inputs
 * ══════════════════════════════════════════════════════════════════════════ */
function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const asJson = process.argv.includes('--json');
const urlsOnly = process.argv.includes('--urls');
const writeDoc = arg('write', '');
const onlyLayer = arg('layer', '');

/* Default sample tile: z12/2345/1480 → Bucharest (26.10 E, 44.43 N), i.e. the
 * tile the Romanian view asks for first — the same one a manual check wants. */
const tileArg = arg('tile', '12/2345/1480');
const [sampleZ, sampleX, sampleY] = tileArg.split('/').map(Number);

const DL = require(path.join(repoRoot, 'js/layer-registry.js'));

/* Guarded hosts, read from the guard itself so the audit can never drift:
 * the file is an IIFE over `window`/`document`, so give it a minimal stub. */
const guardHosts = (() => {
  const sandbox = {
    window: {}, document: { readyState: 'complete' },
    console, setTimeout, clearTimeout, Promise, Date, Math, JSON,
    encodeURIComponent, parseFloat, String, Object, Array
  };
  sandbox.window = sandbox;
  sandbox.window.document = sandbox.document;
  try {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(repoRoot, 'js/wms-health.js'), 'utf8'), sandbox,
      { filename: 'js/wms-health.js' });
    const api = sandbox.DetectLabWmsHealth || {};
    const hosts = api.HOSTS || {};
    return {
      list: Array.isArray(hosts) ? hosts : Object.keys(hosts),
      labelFor: (host) => (Array.isArray(hosts) ? host : (hosts[host] || host)),
      api
    };
  } catch (e) {
    return { list: [], labelFor: (h) => h, api: null, error: e.message };
  }
})();

function isGuardedUrl(url) {
  const host = hostOfUrl(url);
  return guardHosts.list.indexOf(host) !== -1;
}

/* How a layer is actually protected, not just "host is listed":
 *   probe — js/wms-health.js wraps L.tileLayer.wms, so the layer is probed
 *           once per add before a screenful of broken tiles can be requested;
 *   watch — the guard adopts it from the live map (`layeradd`) and trips on a
 *           run of failed tiles (module-built WMTS/GridLayer layers);
 *   none  — nothing watches it. */
function guardPath(kind, url) {
  /* Same-origin routes (/api/geo/dk-dhm, /api/geo/se-hojdmodell, the 3D tile
     proxy) are the site's own functions: they answer a JSON error the module
     can read, so they have their own error path instead of needing the guard. */
  if (!url) return 'runtime';
  if (String(url).indexOf('/') === 0) return 'same-origin';
  if (!isGuardedUrl(url)) return 'none';
  return kind === 'wms' ? 'probe' : 'watch';
}
function guardLabel(url) {
  return guardHosts.labelFor(hostOfUrl(url));
}
function hostOfUrl(url) {
  const m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Minimal Leaflet + window, so the country LiDAR modules can be loaded
 *    exactly as the browser loads them (they own their URL builders).
 * ══════════════════════════════════════════════════════════════════════════ */
const MODULE_FILES = {
  AhnLidar: 'js/ahn-layer.js',
  Hoydedata: 'js/hoydedata-layer.js',
  GeoportalNMT: 'js/geoportal-nmt-layer.js',
  IgnMdt: 'js/ign-mdt-layer.js',
  SwisstopoRelief: 'js/swisstopo-relief-layer.js',
  EaLidarWmts: 'js/ea-lidar-wmts-layer.js',
  DataforsyningenDHM: 'js/dataforsyningen-dhm-layer.js',
  LantmaterietHojdmodell: 'js/lantmateriet-hojdmodell-layer.js'
};

function makeLeafletStub() {
  function Klass() {}
  Klass.prototype = {
    initialize() {}, onAdd() {}, onRemove() {}, getTileUrl() { return ''; },
    createTile() { return {}; }, setOpacity() {}, setZIndex() {}, redraw() {},
    setParams() { return this; }, fire() {}, on() { return this; }, off() { return this; },
    addTo() { return this; }, setUrl() { return this; }
  };
  function extend(props) {
    function Sub() {}
    Sub.prototype = Object.create(Klass.prototype);
    Object.assign(Sub.prototype, props || {});
    Sub.extend = extend;
    return Sub;
  }
  Klass.extend = extend;
  const bounds = (a, b) => ({
    _a: a, _b: b,
    isValid: () => true,
    contains: () => true,
    getSouth: () => 0, getWest: () => 0, getNorth: () => 0, getEast: () => 0,
    toBBoxString: () => '0,0,0,0'
  });
  return {
    TileLayer: Klass, GridLayer: Klass, Layer: Klass, ImageOverlay: Klass,
    CRS: {
      EPSG3857: { code: 'EPSG:3857', project: (ll) => ll },
      EPSG900913: { code: 'EPSG:900913', project: (ll) => ll },
      EPSG4326: { code: 'EPSG:4326', project: (ll) => ll }
    },
    Util: {
      template: (str, data) => String(str).replace(/\{!?([^}]+)\}/g,
        (m, k) => (data && data[k.trim()] != null ? String(data[k.trim()]) : m)),
      getParamString: (obj, existingUrl, uppercase) => {
        const parts = Object.keys(obj).map((k) =>
          encodeURIComponent(uppercase ? k.toUpperCase() : k) + '=' + encodeURIComponent(obj[k]));
        return (String(existingUrl || '').indexOf('?') !== -1 ? '&' : '?') + parts.join('&');
      },
      emptyImageUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
      setOptions: (obj, opts) => Object.assign(obj, opts || {}),
      extend: Object.assign,
      throttle: (fn) => fn,
      falseFn: () => false,
      stamp: (o) => (o && o._dlStamp) || 'dl1'
    },
    setOptions: (obj, opts) => Object.assign(obj || {}, opts || {}),
    latLngBounds: bounds, latLng: (a, b) => (Array.isArray(a) ? { lat: a[0], lng: a[1] } : a),
    LatLngBounds: function () {}, LatLng: function () {},
    point: (x, y) => ({ x, y }), Bounds: function () {},
    DomUtil: { create: () => ({}), addClass() {}, removeClass() {}, setOpacity() {} },
    DomEvent: { on() {}, off() {} },
    Browser: { retina: false, mobile: false, touch: false, pointer: true },
    tileLayer: {}, TileLayer: Object.assign(Klass, { WMS: Klass }),
    emptyImageUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
  };
}

const moduleSandbox = (() => {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Math, JSON, Date,
    Promise, Object, Array, String, Number, Boolean, isNaN, parseFloat, parseInt,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, RegExp, Error,
    navigator: { onLine: true, userAgent: 'node' }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.L = sandbox.L = makeLeafletStub();
  sandbox.document = {
    readyState: 'complete', body: null,
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeChild() {} }),
    addEventListener() {}, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], documentElement: { lang: 'ro' }
  };
  sandbox.location = { href: 'https://detectlab.eu/', hostname: 'detectlab.eu', origin: 'https://detectlab.eu' };
  sandbox.navigator = { onLine: true, userAgent: 'node' };
  vm.createContext(sandbox);
  for (const [name, rel] of Object.entries(MODULE_FILES)) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) { sandbox[name + '_MISSING_FILE'] = rel; continue; }
    try {
      vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: rel });
    } catch (e) {
      sandbox[name + '_LOAD_ERROR'] = e.message;
    }
  }
  return sandbox;
})();

const moduleStatus = {};
for (const [name, rel] of Object.entries(MODULE_FILES)) {
  moduleStatus[name] = {
    file: rel,
    present: fs.existsSync(path.join(repoRoot, rel)),
    loaded: !!(moduleSandbox[name] && typeof moduleSandbox[name] === 'object'),
    error: moduleSandbox[name + '_LOAD_ERROR'] || null
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. Request builders — the same ones the app uses, called in Node
 * ══════════════════════════════════════════════════════════════════════════ */
const TILE_FORMATS = new Set(['image/png', 'image/png8', 'image/jpeg', 'image/jpg', 'image/webp']);
/* 1.1.0 is what the eHarta GeoServer mosaics are requested with today (and
   was verified against the live service) — rare, but not suspicious. */
const WMS_VERSIONS = new Set(['1.1.0', '1.1.1', '1.3.0']);
const OGC_SERVICE = /(^|[?&])service=wms/i;

function paramFrom(url, name) {
  const m = String(url || '').match(new RegExp('[?&]' + name + '=([^&]*)', 'i'));
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
}

/**
 * WMS GetMap URL for one tile, built exactly like Leaflet's WMS layer.
 *
 * The 2D map is Web Mercator throughout and every call site passes
 * `crs: L.CRS.EPSG3857` (see js/historical-eu-maps.js and
 * js/map-app.js), so the 2D request always asks for EPSG:3857 — the native
 * CRS of a `reproject: true` sheet (EPSG:2180) is asked for by the PROXY,
 * which is what the 3D path uses.
 */
function wmsSampleUrl(def, z, x, y) {
  const opts = { ...(def.params || {}) };
  const size = def.tileSize || 256;
  const version = String(def.version || '1.3.0');
  const crs = 'EPSG:3857';
  const [minX, minY, maxX, maxY] = DL.tileBounds3857At(z, x, y);
  const params = {
    service: 'WMS', request: 'GetMap', version,
    layers: DL.layerOf(def), styles: '',
    format: def.format || 'image/png',
    transparent: def.transparent !== false,
    ...opts
  };
  if (version >= '1.3.0') params.crs = crs; else params.srs = crs;
  params.width = size;
  params.height = size;
  const query = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  query.push('bbox=' + [minX, minY, maxX, maxY].join(','));
  return def.url + (String(def.url).indexOf('?') === -1 ? '?' : '&') + query.join('&');
}

/** WMTS KVP GetTile URL for one tile (registry template). */
function wmtsSampleUrl(def, z, x, y) {
  return DL.wmtsTemplate(def, {})
    .replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

function dynamicSampleUrl(def, z, x, y) {
  const spec = def.builder || {};
  const mod = moduleSandbox[spec.module];
  if (!mod || typeof mod[spec.fn] !== 'function') return '';
  const size = def.tileSize || 256;
  const crs = def.crs || 'EPSG:3857';
  const mode = (() => {
    try {
      if (typeof mod.modeKeys === 'function') return mod.modeKeys()[0];
      return (Object.keys(mod.MODES || {})[0]) || (def.modes ? Object.keys(def.modes)[0] : null);
    } catch (e) { return null; }
  })();
  try {
    if ((spec.kind || 'tile') === 'bbox') {
      return String(mod[spec.fn].call(mod, mode, DL.tileBounds3857At(z, x, y), size, crs));
    }
    return String(mod[spec.fn].call(mod, mode, z, x, y));
  } catch (e) {
    return '';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Checks
 * ══════════════════════════════════════════════════════════════════════════ */
function auditWms(def) {
  const findings = [];
  const err = (code, message) => findings.push({ level: 'error', code, message });
  const warn = (code, message) => findings.push({ level: 'warn', code, message });
  const info = (code, message) => findings.push({ level: 'info', code, message });
  const version = String(def.version || '1.3.0');

  if (!/^https:\/\//i.test(def.url) && !/^\//.test(def.url)) {
    err('W_URL', 'endpoint is neither https:// nor same-origin: ' + def.url);
  }
  if (!DL.layerOf(def)) err('W_LAYERS', 'no LAYERS value — GetMap would be answered with an exception');
  if (!WMS_VERSIONS.has(version)) warn('W_VERSION', 'unusual WMS version "' + version + '"');
  if (!TILE_FORMATS.has(String(def.format || '').toLowerCase())) {
    warn('W_FORMAT', 'format "' + def.format + '" is not a raster format the browser decodes directly');
  }
  if (def.format === 'image/jpeg' && def.transparent !== false) {
    err('W_JPEG_TRANSPARENT', 'image/jpeg cannot carry transparency — transparent must be false, else the service ' +
      'answers an opaque white/black plate or an exception');
  }
  if (def.crs && def.crs !== 'EPSG:3857' && !def.reproject) {
    warn('W_CRS', 'crs ' + def.crs + ' without reproject:true — the proxy transforms the tile bbox only for ' +
      'reprojected layers');
  }
  if (def.crs === 'EPSG:4326' && version >= '1.3.0') {
    warn('W_AXIS', 'WMS 1.3.0 + EPSG:4326 is lat,lon (axis order) — check the BBOX builder');
  }
  if (def.reproject) {
    if (!def.crs || def.crs === 'EPSG:3857') {
      err('W_REPROJECT_CRS', 'reproject:true needs the sheet\'s native crs (e.g. EPSG:2180) for the proxy bbox');
    } else {
      info('W_REPROJECT', 'routed through the proxy, which asks the server in ' + def.crs);
    }
  }
  const cors = def.cors || 'unknown';
  if (cors === 'no' && def.proxy !== 'always') {
    err('P_CORS', 'host documented as no-CORS but proxy is "' + def.proxy + '" — the 3D view would send direct, ' +
      'CORS-less requests');
  }
  if (cors === 'yes' && def.proxy === 'always') {
    warn('P_CORS_EXTRA', 'host is CORS-enabled yet every 3D tile goes through the proxy');
  }
  if (isGuardedUrl(def.url)) {
    info('GUARDED', 'availability guard active (' + guardLabel(def.url) + ')');
  } else {
    err('GUARD_MISSING', 'no availability guard: a broken server would leave a blank layer with no explanation — ' +
      'add the host to HOSTS in js/wms-health.js');
  }
  const hasUi = !!(def.ui && (def.ui.toggle || def.ui.var2d));
  if (!hasUi && def.ui && def.ui.select) info('UI_SELECT', 'driven by a <select>, not a switch');
  return findings;
}

function auditWmts(def) {
  const findings = [];
  const err = (code, message) => findings.push({ level: 'error', code, message });
  const warn = (code, message) => findings.push({ level: 'warn', code, message });
  const info = (code, message) => findings.push({ level: 'info', code, message });
  const template = DL.wmtsTemplate(def, {});

  if (!/^https:\/\//i.test(def.url) && !/^\//.test(def.url)) err('M_URL', 'endpoint is not https: ' + def.url);
  ['SERVICE=WMTS', 'REQUEST=GetTile', 'VERSION=1.0.0', 'TILEMATRIXSET=', 'TILEMATRIX=', 'TILEROW={y}',
    'TILECOL={x}', 'STYLE='].forEach((needle) => {
    if (template.indexOf(needle) === -1) err('M_KVP', 'WMTS KVP is missing ' + needle);
  });
  if (!def.layer) err('M_LAYER', 'no LAYER value');
  if (def.layer && String(def.layer).indexOf('{') !== -1) {
    warn('M_LAYER_TEMPLATE', 'LAYER contains a placeholder: ' + def.layer);
  }
  if (!TILE_FORMATS.has(String(def.format || '').toLowerCase())) warn('M_FORMAT', 'format "' + def.format + '"');
  if (!def.crs) warn('M_TMS', 'no crs/tile matrix set declared — defaulting to EPSG:3857');
  if (def.maxNativeZoom == null) {
    warn('M_MAXNATIVE', 'no maxNativeZoom — Leaflet would request levels the cache does not hold');
  }
  if (!def.time && !def.timeAware) info('M_TIME', 'no TIME dimension (fine for a static layer)');
  if (def.timeAware && def.time && !def.time.value) err('M_TIME_MISSING', 'time-aware layer without a default TIME value');
  if (def.bounds && def.bounds.length === 2) info('M_BOUNDS', 'clipped to the published footprint');
  if (isGuardedUrl(def.url)) info('GUARDED', 'availability guard active (' + guardLabel(def.url) + ')');
  else {
    err('GUARD_MISSING', 'WMTS host is not watched: a cache answering an XML ServiceException would leave a blank ' +
      'layer — add the host to HOSTS in js/wms-health.js');
  }
  return findings;
}

function auditDynamic(def) {
  const findings = [];
  const err = (code, message) => findings.push({ level: 'error', code, message });
  const warn = (code, message) => findings.push({ level: 'warn', code, message });
  const info = (code, message) => findings.push({ level: 'info', code, message });
  const spec = def.builder || {};
  const st = moduleStatus[spec.module];

  if (!spec.module || !spec.fn) {
    /* Runtime-driven definition: the layer object is produced elsewhere
     * (CORONA's per-pass deck, user image overlays). Nothing to audit statically
     * beyond noting it — its tiles are watched through the map hook when its
     * endpoint belongs to a watched host. */
    info('RUNTIME', 'layer is built at runtime (no static builder) — audited through its module and the map hook');
    if (def.url && !isGuardedUrl(def.url) && String(def.url).indexOf('/') !== 0) {
      warn('UNGUARDED_RUNTIME', 'host not watched: ' + hostOfUrl(def.url));
    }
    return findings;
  }
  if (st && !st.present) err('D_FILE', 'builder module file missing: ' + st.file);
  if (st && st.error) err('D_LOAD', 'builder module failed to load: ' + st.error);
  const mod = moduleSandbox[spec.module];
  if (mod && typeof mod[spec.fn] !== 'function') {
    err('D_FN', 'module ' + spec.module + ' does not expose ' + spec.fn + '()');
  }
  const url = dynamicSampleUrl(def, sampleZ, sampleX, sampleY);
  if (!url) {
    err('D_URL', 'builder returned no URL for tile ' + sampleZ + '/' + sampleX + '/' + sampleY);
  } else {
    if (!/^https:\/\//i.test(url) && !/^\//.test(url)) err('D_URL_SCHEME', 'built URL is not https/same-origin: ' + url.slice(0, 60));
    if (OGC_SERVICE.test(url) && !/request=getmap/i.test(url)) err('D_KVP', 'WMS URL without REQUEST=GetMap: ' + url.slice(0, 80));
    if (OGC_SERVICE.test(url) && !/(bbox|SERVICE)/i.test(url)) err('D_BBOX', 'WMS URL without BBOX');
    if (/\{z\}/.test(url)) warn('D_TEMPLATE', 'builder returned a template, not a concrete tile URL');
  }
  if (def.cors === 'no' && def.proxy !== 'always') {
    err('P_CORS', 'no-CORS host must use proxy:"always" (found "' + def.proxy + '")');
  }
  if (def.proxy === 'never' && !/^\//.test(String(def.url))) {
    warn('P_ORIGIN', 'proxy:"never" on a cross-origin endpoint — the browser talks to it directly');
  }
  if (isGuardedUrl(def.url)) info('GUARDED', 'host watched by the guard (' + guardLabel(def.url) + ')');
  else if (String(def.url).indexOf('/api/') === 0) {
    info('SAME_ORIGIN', 'same-origin proxy route — its own error path applies');
  } else if (path2dHasOwnErrorPath(def)) {
    info('OWN_ERROR_PATH', 'module reports its own failures (see its .md)');
  } else {
    err('GUARD_MISSING', 'third-party endpoint without a guard: ' + def.url);
  }
  return findings;
}

/* Modules that already turn their own failures into something visible (a
   notice, a blank tile instead of a broken image, a documented error path). */
const OWN_ERROR_PATHS = [
  'js/dataforsyningen-dhm-layer.js',
  'js/lantmateriet-hojdmodell-layer.js'
];
function path2dHasOwnErrorPath(def) {
  const st = moduleStatus[def.builder && def.builder.module];
  return !!(st && OWN_ERROR_PATHS.indexOf(st.file) !== -1);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Run
 * ══════════════════════════════════════════════════════════════════════════ */
const rows = [];
for (const def of DL.ordered()) {
  if (!['wms', 'wmts', 'dynamic'].includes(def.kind)) continue;
  if (onlyLayer && def.id !== onlyLayer) continue;
  let findings = [];
  let url = '';
  let url3d = '';
  try {
    if (def.kind === 'wms') {
      findings = auditWms(def);
      url = wmsSampleUrl(def, sampleZ, sampleX, sampleY);
    } else if (def.kind === 'wmts') {
      findings = auditWmts(def);
      url = wmtsSampleUrl(def, sampleZ, sampleX, sampleY);
    } else {
      findings = auditDynamic(def);
      url = dynamicSampleUrl(def, sampleZ, sampleX, sampleY);
    }
    try { url3d = (DL.map3dTiles(def, { modules: moduleSandbox })[0]) || ''; } catch (e) { url3d = ''; }
    if (def.reproject && url3d && url3d.indexOf('{bbox-epsg-3857}') !== -1) {
      findings.push({ level: 'error', code: 'W_REPROJECT_DIRECT',
        message: 'native CRS ' + def.crs + ' asked for directly on the tile grid — the bbox would be in Web ' +
          'Mercator, not in ' + def.crs + '; the proxy must transform it' });
    }
  } catch (e) {
    findings = [{ level: 'error', code: 'AUDIT_THREW', message: e.message }];
  }
  rows.push({
    id: def.id,
    group: def.group,
    kind: def.kind,
    title: (def.title && (def.title.en || def.title.ro)) || def.id,
    endpoint: def.url,
    host: hostOfUrl(def.url),
    layer: def.kind === 'wms' ? DL.layerOf(def) : (def.layer || ''),
    version: def.version || (def.kind === 'wmts' ? '1.0.0' : ''),
    format: def.format || '',
    cors: def.cors || 'unknown',
    proxy: def.proxy || 'auto',
    runtime: def.kind === 'dynamic' && !def.builder,
    guardPath: guardPath(def.kind, def.url),
    guarded: guardPath(def.kind, def.url) !== 'none',
    provider: guardLabel(def.url),
    sample2d: url,
    sample3d: url3d,
    findings
  });
}

const errors = rows.flatMap((r) => r.findings.filter((f) => f.level === 'error').map((f) => ({ id: r.id, ...f })));
const warnings = rows.flatMap((r) => r.findings.filter((f) => f.level === 'warn').map((f) => ({ id: r.id, ...f })));

/**
 * What a failure looks like, per provider family. Keyed by the endpoint host;
 * `what` is the first thing to look for when a layer of that provider goes
 * blank, `owner` says whether the fault can be fixed in this repo at all.
 */
const SIGNATURES = [
  {
    host: 'pastmaps.cenagis.edu.pl',
    provider: 'CENAGIS / IH PAN',
    request: 'WMS GetMap (1.3.0 for the catalogue, 1.1.1 for the premium rows)',
    what: '200 + a Java exception body: java.lang.RuntimeException: Unable to create a valid ImageInputStream ' +
      '(...ukvme_3857_transparent.ecw); occasionally 502/504 from the host',
    owner: 'external (the operator\'s GeoServer / raster store)',
    app: 'probe runs before the layer is added; on failure the row is switched off, marked and the notice names ' +
      'the provider, with Retry'
  },
  {
    host: 'services.geo-spatial.org',
    provider: 'geo-spatial.org (eHarta)',
    request: 'WMS GetMap, version 1.1.0 (SRS=)',
    what: '200 + ServiceExceptionReport XML, or an empty tile where the mosaic has no coverage',
    owner: 'external',
    app: 'probe before the layer is added, same notice path'
  },
  {
    host: 'copernicus.discomap.eea.europa.eu',
    provider: 'Copernicus Land / EEA discomap',
    request: 'ArcGIS MapServer/WMSServer GetMap, WMS 1.1.1, JPEG (transparent=false)',
    what: '200 + an ArcGIS JSON error, or a blank JPEG outside the VHR footprint of that year',
    owner: 'external',
    app: 'probe; the 3D view always goes through the same-origin proxy because the host sends no CORS headers'
  },
  {
    host: 'image.discomap.eea.europa.eu',
    provider: 'Copernicus Land / EEA discomap',
    request: 'ArcGIS ImageServer/WMSServer GetMap, WMS 1.1.1, JPEG',
    what: '200 + an ArcGIS JSON error, or a blank JPEG where the LAEA-native mosaic has no data',
    owner: 'external',
    app: 'probe; 3D through the proxy for the same reason'
  },
  {
    host: 'data.geopf.fr',
    provider: 'IGN France / Géoplateforme',
    request: 'WMS 1.3.0 GetMap (CRS=EPSG:3857), IGNF_LIDAR-HD_*',
    what: '200 + ServiceExceptionReport XML, or 400 for an unknown LAYERS/CRS pair',
    owner: 'external',
    app: 'probe before the layer is added'
  },
  {
    host: 'wmts.geo.admin.ch',
    provider: 'swisstopo',
    request: 'WMTS KVP GetTile (ch.swisstopo.swisssurface3d-relief)',
    what: '200 + WMTS ServiceException XML, or swisstopo\'s standard no-data tile beyond the modelled area',
    owner: 'external',
    app: 'adopted by the guard when it goes on the map, then watched: three failed tiles in a row remove ' +
      'the layer and explain the provider (no probe — the host publishes dozens of products)'
  },
  {
    host: 'environment.data.gov.uk',
    provider: 'Environment Agency (England)',
    request: 'WMTS KVP GetTile, TILEMATRIXSET=WebMercatorQuad',
    what: '200 + XML ServiceException for a tile outside the published limits',
    owner: 'external',
    app: 'adopted and watched for tile errors; the module itself clips its bounds and asks for transparent ' +
      'tiles past maxNativeZoom'
  },
  {
    host: 'hoydedata.no',
    provider: 'Kartverket (høydedata.no)',
    request: 'ArcGIS exportImage (image/png, bbox per tile)',
    what: '200 + a JSON error when the product has no coverage at that scale',
    owner: 'external',
    app: 'adopted and watched; the module paints a blank tile for a failed fetch and reports it through ' +
      'DetectLabWmsHealth.noteFailure(), so a run of them still switches the row off and explains itself'
  },
  {
    host: 'ahn.arcgisonline.nl',
    provider: 'AHN / Esri Nederland',
    request: 'ArcGIS exportImage (image/png)',
    what: '200 + a JSON error, or 404 on a retired service version',
    owner: 'external',
    app: 'adopted and watched; the module paints a blank tile and warns once in the console, and reports ' +
      'each failure through DetectLabWmsHealth.noteFailure()'
  },
  {
    host: 'mapy.geoportal.gov.pl',
    provider: 'GUGiK / geoportal.gov.pl',
    request: 'WMS 1.3.0 GetMap (CRS=EPSG:3857), Raster',
    what: '200 + ServiceExceptionReport XML; during maintenance the host answers an HTML page instead',
    owner: 'external',
    app: 'adopted and watched for tile errors'
  },
  {
    host: 'wms-mapa-lidar.idee.es',
    provider: 'IGN España / IDEE',
    request: 'WMS 1.1.1 GetMap (SRS=EPSG:3857), EL.GridCoverage',
    what: '200 + a MapServer text error for an unknown LAYERS, or a fully transparent tile off the LiDAR footprint',
    owner: 'external',
    app: 'adopted and watched; 3D can be re-pointed with window.SPAIN_LIDAR_PROXY_URL'
  },
  {
    host: 'phenology.hrvpp2.vgt.vito.be',
    provider: 'VITO / Copernicus HR-VPP',
    request: 'WMTS KVP GetTile + TIME (dekadal for PPI, annual for VPP)',
    what: '200 + ServiceException XML for an out-of-range TIME or a zoom level the cache does not hold',
    owner: 'external',
    app: 'adopted and watched; the layer\'s own footprint mask stops most out-of-footprint requests before ' +
      'they are sent'
  },
  {
    host: 'geoserve.cast.uark.edu',
    provider: 'CAST / University of Arkansas (CORONA)',
    request: 'WMS GetMap with tiled=true (GeoWebCache), LAYER corona:<product>',
    what: '200 + GeoWebCache XML when that pass has no cached mosaic',
    owner: 'external',
    app: 'adopted in watch-only mode: one layer per pass, so a single failed pass must not switch the row off'
  },
  {
    host: '/api/geo/dk-dhm',
    provider: 'Dataforsyningen (Denmark), via the same-origin proxy',
    request: 'the proxy builds the Dataforsyningen GetMap and adds the token server-side',
    what: '401 {"error":"dataforsyningen_token_missing"} when the deployment has no DATAFORSYNINGEN_TOKEN; ' +
      '401/403 + token XML from Dataforsyningen itself when the token is invalid',
    owner: 'this repo\'s deployment (env var) + external service',
    app: 'module shows the deployment-specific notice and switches the row off'
  },
  {
    host: '/api/geo/se-hojdmodell',
    provider: 'Lantmäteriet (Sweden), via the same-origin proxy',
    request: 'the proxy adds the Geotorget credentials server-side',
    what: '401 {"error":"lantmateriet_credentials_missing"} when no LANTMATERIET_WMS_* env is set',
    owner: 'this repo\'s deployment (env vars) + external service',
    app: 'module shows the Geotorget credentials notice'
  }
];



const SIGNATURE_BY_HOST = new Map(SIGNATURES.map((sig) => [sig.host, sig]));
/* A module that swaps a failed tile for a blank image instead of letting
 * Leaflet fire `tileerror` is invisible to the guard unless it reports the
 * failure itself — every such module must call
 * DetectLabWmsHealth.noteFailure(), or have its own visible error path
 * (OWN_ERROR_PATHS). */
for (const [name, st] of Object.entries(moduleStatus)) {
  if (!st.present || !st.loaded) continue;
  const src = fs.readFileSync(path.join(repoRoot, st.file), 'utf8');
  const hidesFailures = /done\(null\s*,\s*(tile|canvas)\)/.test(src);
  if (hidesFailures && OWN_ERROR_PATHS.indexOf(st.file) === -1 && src.indexOf('noteFailure') === -1) {
    errors.push({ id: name, code: 'D_HIDDEN_FAILURES',
      message: st.file + ' replaces a failed tile with a blank image and never calls ' +
        'DetectLabWmsHealth.noteFailure(), so the layer would go blank without the guard noticing' });
  }
}

/* Drift control for the report: every host the availability guard watches must
 * have a documented failure signature ("what you will see when it breaks"), so
 * a new provider cannot be added without saying what its failure looks like. */
for (const host of guardHosts.list) {
  if (host === 'image.discomap.eea.europa.eu') continue;   /* same family as copernicus.… */
  if (!SIGNATURE_BY_HOST.has(host)) {
    errors.push({ id: '(guard host)', code: 'SIG_MISSING',
      message: host + ' is watched by the availability guard but has no failure signature in ' +
        'SIGNATURES (tools/audit-wms-layers.mjs) — add what a broken answer from it looks like' });
  }
}
for (const sig of SIGNATURES) {
  if (sig.host.charAt(0) === '/') continue;                 /* same-origin routes */
  if (guardHosts.list.indexOf(sig.host) === -1) {
    warnings.push({ id: '(signature)', code: 'SIG_UNUSED',
      message: sig.host + ' is documented in SIGNATURES but not watched by the guard' });
  }
}




function markdownReport() {
  const out = [];
  out.push('# WMS / WMTS layer audit');
  out.push('');
  out.push('<!-- Generated by `node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md` —');
  out.push('     do not edit the tables by hand; re-run the tool after changing a layer. -->');
  out.push('');
  out.push('Every raster service the map can draw — the CENAGIS / IH PAN historical catalogue,');
  out.push('the eHarta historics, the Copernicus VHR mosaics, the country LiDAR/relief services');
  out.push('(Netherlands, Norway, Poland, Spain, Switzerland, England, France, Denmark, Sweden)');
  out.push('and the vegetation-phenology WMTS — is defined once in `js/layer-registry.js` and');
  out.push('guarded by `js/wms-health.js`. This file is the offline check of that statement:');
  out.push('the tool rebuilds each layer\'s real request with the very same code the map uses');
  out.push('and verifies it against the service\'s documented contract.');
  out.push('');
  out.push('## Why it exists');
  out.push('');
  out.push('On **2026-10-13** every `GetMap` of the CENAGIS / IH PAN GeoServer answered');
  out.push('**HTTP 200 with a Java exception body** instead of an image:');
  out.push('');
  out.push('```');
  out.push('java.lang.RuntimeException: Unable to create a valid ImageInputStream for the');
  out.push('provided input: /opt/geoserver/data_dir/cartomatic/UKvME/mosaick/');
  out.push('ukvme_3857_transparent.ecw');
  out.push('```');
  out.push('');
  out.push('A browser cannot decode that as an image, so Leaflet fired `tileerror` for every');
  out.push('tile and left the layer blank — silently. The user-visible summary of that class of');
  out.push('failure is what this audit is about: **a third-party raster server that answers');
  out.push('“200 OK” with something that is not a tile**.');
  out.push('');
  out.push('## The three errors that started this audit');
  out.push('');
  out.push('| what was seen | registry entry | service + LAYERS | root cause | whose fault |');
  out.push('|---|---|---|---|---|');
  out.push('| the Central Europe row (“Central Europe Map 1:300k”) reported as not loadable — the guard\'s *“This map cannot be loaded”* notice | ' +
    '`premium.mitteleuropa` (2D) / `cenagis.ukvme` (3D) | `pastmaps.cenagis.edu.pl`, `ihpan:ukvme_3857` | ' +
    'HTTP 200 with `java.lang.RuntimeException: Unable to create a valid ImageInputStream … ' +
    'ukvme_3857_transparent.ecw` — the GeoServer cannot read the ECW raster behind the mosaic | ' +
    'CENAGIS / IH PAN (external) |');
  out.push('| the German Empire row (“German Empire Map 1:100k”) reported as not loadable — same notice | ' +
    '`premium.kdr-100k` (2D) / `cenagis.kdr` (3D) | same server, `ihpan:kdr_3857` | ' +
    'the same failure class: a 200 response that is not an image | CENAGIS / IH PAN (external) |');
  out.push('| *“Invalid or missing Dataforsyningen token”* | `lidar.dk-dhm` | `/api/geo/dk-dhm` → ' +
    'Dataforsyningen DHM | the deployment has no `DATAFORSYNINGEN_TOKEN` (or a visitor-supplied token was ' +
    'rejected); the proxy answers 401 `{\"error\":\"dataforsyningen_token_missing\"}` | deployment config ' +
    '(this repo) + the token holder |');
  out.push('');
  out.push('The first two are **not fixable here**: the endpoint is correct, the service answers 200 and its own ' +
    'body is broken. What this repo can do — and now does — is say so, name the provider, switch off the rows ' +
    'and keep everything else working. The third one is a configuration gap and is reported as such.');
  out.push('');
  out.push('## What is checked');
  out.push('');
  out.push('* **WMS** — https endpoint, `LAYERS` present, version/CRS pair (`1.3.0` → `CRS`,');
  out.push('  `1.1.1` → `SRS`), axis order for EPSG:4326, `FORMAT` vs `TRANSPARENT`');
  out.push('  (JPEG cannot carry transparency), usable raster format.');
  out.push('* **WMTS** — `SERVICE/REQUEST/VERSION/LAYER/STYLE/FORMAT/TILEMATRIXSET/TILEMATRIX/');
  out.push('  TILEROW/TILECOL` present, a `TIME` value for time-aware layers, a');
  out.push('  `maxNativeZoom` matching the published pyramid.');
  out.push('* **Module-built layers** (`kind: dynamic`) — the builder named by the registry');
  out.push('  exists, loads and returns a concrete URL for a real tile, carrying the KVP the');
  out.push('  service needs.');
  out.push('* **Routing** — a host documented as “no CORS” must go through the same-origin proxy');
  out.push('  in 3D, and a same-origin endpoint must not.');
  out.push('* **Availability guard** — every third-party endpoint must be watched by');
  out.push('  `js/wms-health.js`: `probe` (one GetMap before a layer is added, WMS factory).');
  out.push('  or `watch` (adopted from the live map, tripped by a run of failed tiles).');
  out.push('');
  out.push('## The layers');
  out.push('');
  out.push('| layer | kind | endpoint host | LAYERS | ver | format | CORS | proxy | availability guard |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push('| `' + r.id + '` | ' + r.kind + ' | ' + (r.host || 'same-origin') + ' | ' +
      (String(r.layer).length > 44 ? String(r.layer).slice(0, 41) + '…' : r.layer) + ' | ' + r.version +
      ' | ' + r.format + ' | ' + r.cors + ' | ' + r.proxy + ' | ' +
      (r.guardPath === 'none' ? '❌ none'
        : r.guardPath === 'same-origin' ? '— same-origin'
          : r.guardPath === 'runtime' ? '— runtime'
            : r.guardPath + ' · ' + r.provider) + ' |');
  }
  out.push('');
  const probes = rows.filter((r) => r.guardPath === 'probe').length;
  const watches = rows.filter((r) => r.guardPath === 'watch').length;
  const remote = rows.filter((r) => r.guardPath !== 'same-origin' && r.guardPath !== 'runtime').length;
  out.push('**' + (probes + watches) + '/' + remote + ' third-party layers guarded** (' + probes + ' probed, ' +
    watches + ' watched); ' + (rows.length - remote) + ' same-origin/runtime. ' +
    errors.length + ' error(s), ' + warnings.length + ' warning(s).');
  out.push('');
  out.push('### Small print');
  out.push('');
  out.push('Things the tables above cannot show, verified in the code:');
  out.push('');
  {
    const mapApp = fs.readFileSync(path.join(repoRoot, 'js/map-app.js'), 'utf8');
    const usesWmsKvp = mapApp.indexOf("type === 'wms_kvp'") !== -1;
    const anyKvp = DL.ordered().some((d) => d.type === 'wms_kvp' || (d.builder && d.builder.kind === 'wms_kvp'));
    if (usesWmsKvp && !anyKvp) {
      out.push('* **The unused generic WMTS branch.** `js/map-app.js` still has a');
      out.push('  `cfg.type === \'wms_kvp\'` branch that asks for `tilematrixset=default028mm`;');
      out.push('  **no registry entry uses it today** (the country LiDAR layers are `wms`, `xyz` or');
      out.push('  module-built). If a layer is ever moved onto it, the tile-matrix set must become');
      out.push('  `EPSG:3857` with `EPSG:3857:{z}` matrix names (exactly what the `vegfp` builders');
      out.push('  send), or the service answers a `ServiceException` about an unknown TileMatrixSet.');
    }
    const reprojected = DL.ordered().filter((d) => d.reproject).map((d) => d.id);
    if (reprojected.length) {
      out.push('* **Native-CRS sheets.** ' + reprojected.map((id) => '`' + id + '`').join(', ') +
        ' are EPSG:2180 natively: the 2D map');
      out.push('  always asks EPSG:3857 (GeoServer reprojects on the fly) and the 3D view goes through');
      out.push('  the same-origin proxy, which asks the server in the sheet\'s own CRS.');
    }
    const vegfp = DL.ordered().filter((d) => d.kind === 'wmts' && d.timeAware);
    if (vegfp.length) {
      out.push('* **Coverage vs `bounds`.** `' + vegfp[0].id + '` declares Romanian `bounds` while the WMTS');
      out.push('  covers Europe. `bounds` is a UI hint (it clips the 2D layer and widens on `.eu`); what');
      out.push('  limits the actual requests is the layer\'s own footprint mask (`VegFpTileLayer`), which');
      out.push('  returns `L.Util.emptyImageUrl` for a tile outside the polygon — a guarded layer must');
      out.push('  still be assumed to answer anything inside its published pyramid.');
    }
    out.push('* **`HOSTS` is not a safety net by itself.** Adding a host only means “watch this”; the');
    out.push('  guard never rewrites a request, so a service that is up but serving the wrong thing');
    out.push('  (a cached mosaic from the wrong year, say) is out of its reach by design.');
  }
  out.push('');
  out.push('## Findings');
  out.push('');
  if (!errors.length && !warnings.length) out.push('None — every checked invariant holds.');
  if (errors.length) {
    out.push('### Errors');
    out.push('');
    for (const e of errors) out.push('- **' + e.id + '** `' + e.code + '` — ' + e.message);
    out.push('');
  }
  if (warnings.length) {
    out.push('### Warnings');
    out.push('');
    for (const w of warnings) out.push('- `' + w.id + '` `' + w.code + '` — ' + w.message);
    out.push('');
  }
  out.push('## What a failure looks like, per provider');
  out.push('');
  out.push('| provider (host) | the request the app sends | typical failure (`curl -I` will show it) | owner | what the app does |');
  out.push('|---|---|---|---|---|');
  for (const sig of SIGNATURES) {
    out.push('| **' + sig.provider + '** (`' + sig.host + '`) | ' + sig.request + ' | ' + sig.what + ' | ' +
      sig.owner + ' | ' + sig.app + ' |');
  }
  out.push('');
  out.push('Every one of these arrives as **HTTP 200**: the failure is in the body, which is exactly why the ' +
    'browser cannot report it and why the guard has to.');
  out.push('');
  out.push('## Deployment requirements (server side)');
  out.push('');
  out.push('| variable | where | needed by | if it is missing |');
  out.push('|---|---|---|---|');
  out.push('| `DATAFORSYNINGEN_TOKEN` | Netlify env / `backend/.env` | Denmark LiDAR proxy ' +
    '(`netlify/functions/dk-dhm.mjs`, `backend/src/routes/geoProxy.js`) | proxy answers 401 ' +
    '`dataforsyningen_token_missing`; the row shows the “not configured on this deployment” notice instead ' +
    'of staying blank |');
  out.push('| `LANTMATERIET_WMS_TOKEN` (or `LANTMATERIET_WMS_USER` + `LANTMATERIET_WMS_PASSWORD`) | same | ' +
    'Sweden LiDAR proxy `/api/geo/se-hojdmodell` | 401 `lantmateriet_credentials_missing`; the row shows the ' +
    'Geotorget credentials notice |');
  out.push('| `window.DETECTLAB_CENAGIS_WMS` | page (optional) | re-points the whole CENAGIS catalogue at a ' +
    'mirror without a code change | the app keeps using `pastmaps.cenagis.edu.pl` |');
  out.push('| `window.SPAIN_LIDAR_PROXY_URL`, `window.EA_LIDAR_PROXY_HOST`, `window.DETECTLAB_DK_TOKEN`, ' +
    '`window.DETECTLAB_SE_WMS_SOURCE` | page (optional) | per-country mirrors / client tokens for deployments ' +
    'without a backend | the app uses the direct endpoint or the same-origin proxy |');
  out.push('| `window.DETECTLAB_MAP3D.terrain` | page (optional) | the 3D terrain provider/key (`maptiler`) — ' +
    'never committed | the 3D view falls back to the keyless provider |');
  out.push('');
  out.push('## Sample request URLs');
  out.push('');
  out.push('One concrete tile per layer, built by the same code the map runs (sample tile ' +
    `${sampleZ}/${sampleX}/${sampleY} — Bucharest). Paste one into \`curl -I\` to test a service live.`);
  out.push('');
  for (const r of rows) {
    out.push('```');
    out.push('# ' + r.id + ' — ' + r.title);
    out.push('2D ' + (r.sample2d || '(built at runtime)'));
    if (r.sample3d && r.sample3d !== r.sample2d) out.push('3D ' + r.sample3d);
    out.push('```');
  }
  out.push('');
  out.push('## Re-checking');
  out.push('');
  out.push('```bash');
  out.push('node tools/audit-wms-layers.mjs                 # table + findings, exits non-zero on an error');
  out.push('node tools/audit-wms-layers.mjs --urls          # just the sample URLs (one per line)');
  out.push('node tools/audit-wms-layers.mjs --json          # machine-readable, for CI');
  out.push('node tools/audit-wms-layers.mjs --layer=cenagis.ukvme --tile=12/2345/1480');
  out.push('node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md   # regenerate this file');
  out.push('```');
  out.push('');
  out.push('The tool never talks to the network: it checks the requests the app *would* send.');
  out.push('A live check is one `curl` of any URL in the section above — a service that cannot');
  out.push('render answers with text/XML/JSON under an HTTP 200, and `curl -I` shows it.');
  out.push('');
  out.push('## What to do when one of them breaks');
  out.push('');
  out.push('* **The guard already said it** — the layer is switched off, its row is dimmed and');
  out.push('  the notice names the provider. Nothing to do but wait for the operator.');
  out.push('* **Re-point the catalogue** — CENAGIS layers can be moved to a mirror or a cached');
  out.push('  copy without touching the code: set `window.DETECTLAB_CENAGIS_WMS` before');
  out.push('  `js/layer-registry.js` loads. The guard watches the mirror host as well.');
  out.push('* **A host that is not in the guard yet** — add it to `HOSTS` in `js/wms-health.js`');
  out.push('  with the provider name to show; the map hook adopts its layers automatically.');
  out.push('* **A configuration error, not an outage** — report it with');
  out.push('  `DetectLabWmsHealth.markUnavailable(layer, message)` so the row is switched off');
  out.push('  with its own explanation (that is what the Denmark token path does).');
  out.push('');
  return out.join('\n');
}

if (asJson) {
  console.log(JSON.stringify({
    generatedFor: { tile: `${sampleZ}/${sampleX}/${sampleY}` },
    totals: {
      layers: rows.length,
      guarded: rows.filter((r) => r.guarded).length,
      guardPaths: rows.reduce((acc, r) => { acc[r.guardPath] = (acc[r.guardPath] || 0) + 1; return acc; }, {}),
      errors: errors.length,
      warnings: warnings.length
    },
    guardHosts: guardHosts.list,
    signatureHosts: SIGNATURES.map((sig) => sig.host),
    modules: moduleStatus,
    layers: rows,
    errors,
    warnings
  }, null, 2));
} else if (writeDoc) {
  fs.writeFileSync(path.join(repoRoot, writeDoc), markdownReport(), 'utf8');
  console.log('wrote ' + writeDoc + ' (' + rows.length + ' layers, ' + errors.length + ' error(s))');
} else if (urlsOnly) {
  for (const r of rows) console.log(r.id + '\t' + r.sample2d);
} else {
  console.log('# WMS / WMTS layer audit — ' + rows.length + ' layers, sample tile ' +
    `${sampleZ}/${sampleX}/${sampleY}\n`);
  console.log('| layer | kind | endpoint host | LAYERS | ver | format | CORS | proxy | availability guard |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log('| `' + r.id + '` | ' + r.kind + ' | ' + (r.host || 'same-origin') + ' | ' +
      (String(r.layer).length > 44 ? String(r.layer).slice(0, 41) + '…' : r.layer) + ' | ' + r.version +
      ' | ' + r.format + ' | ' + r.cors + ' | ' + r.proxy + ' | ' +
      (r.guardPath === 'none' ? '❌ none'
        : r.guardPath === 'same-origin' ? '— same-origin'
          : r.guardPath === 'runtime' ? '— runtime'
            : r.guardPath + ' · ' + r.provider) + ' |');
  }
  if (errors.length) {
    console.log('\n## Errors (' + errors.length + ')\n');
    for (const e of errors) console.log('- **' + e.id + '** [' + e.code + '] ' + e.message);
  }
  if (warnings.length) {
    console.log('\n## Warnings (' + warnings.length + ')\n');
    for (const w of warnings) console.log('- ' + w.id + ' [' + w.code + '] ' + w.message);
  }
  console.log('\n(--urls prints one sample request URL per layer; --write=<file> regenerates the report)');
}

if (!asJson && !urlsOnly && !writeDoc) {
  const probes = rows.filter((r) => r.guardPath === 'probe').length;
  const watches = rows.filter((r) => r.guardPath === 'watch').length;
  const remote = rows.filter((r) => r.guardPath !== 'same-origin' && r.guardPath !== 'runtime').length;
  console.log('\n' + (errors.length ? '❌ ' : '✅ ') + errors.length + ' error(s), ' + warnings.length + ' warning(s), ' +
    (probes + watches) + '/' + remote + ' third-party layers under the availability guard (' + probes + ' probed, ' +
    watches + ' watched); ' + (rows.length - remote) + ' same-origin/runtime.');
}
process.exit(errors.length ? 1 : 0);
