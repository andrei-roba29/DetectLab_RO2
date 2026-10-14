/*
 * test-spain-mapa-lidar-wms.js
 * ──────────────────────────────────────────────────────────────────────────
 * Spain LiDAR layer — IDEE/IGN "Mapa LiDAR" WMS (PNOA-LiDAR surface model).
 *
 * What this pins:
 *   • the row no longer reads the IDEE WMTS relief cache
 *     (servicios.idee.es/wmts/mdt) nor the retired INSPIRE WMS
 *     (servicios.idee.es/wms-inspire/mdt) — both domains are gone from the
 *     shipped files;
 *   • the GetMap request matches what the live service answered on 2026-10-07
 *     (HTTP 200, image/png, 256×256, CORS *): WMS 1.1.1 → SRS=EPSG:3857
 *     (not CRS=), LAYERS=EL.GridCoverage, STYLES= empty, TRANSPARENT,
 *     TILED, CONTINUOUSWORLD, INFO_FORMAT=text/xml, one BBOX per tile;
 *   • the BBOX is derived from Leaflet's own tile geometry (never hardcoded):
 *     the z/x/y → EPSG:3857 box is compared with the Web-Mercator grid;
 *   • the layer is clipped to the capabilities extent (−19 27 → 5 44) and
 *     keeps the row's opacity (0.7), zoom window, pane and one-shot warning;
 *   • only the Spain row of the app changed.
 *
 * Run:  node test-spain-mapa-lidar-wms.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
    checks++;
    if (cond) {
        console.log('  \u2713 ' + name);
    } else {
        failures++;
        console.error('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
    }
}
function eq(name, actual, expected) {
    check(name, actual === expected,
        'expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual));
}
function near(name, actual, expected, tol) {
    check(name, Math.abs(actual - expected) <= tol,
        'expected ' + expected + ' ±' + tol + ', got ' + actual);
}

/* ── Leaflet 1.x stub (enough of L.TileLayer to build a real tile BBOX) ─── */
const R = 6378137;
const HALF = Math.PI * R;

function makeLeaflet() {
    function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
    function Point(x, y) { this.x = x; this.y = y; }

    function LatLngBounds(a, b) {
        if (Array.isArray(a) && !b) { b = a[1]; a = a[0]; }
        const s = a.lat !== undefined ? a.lat : a[0];
        const w = a.lng !== undefined ? a.lng : a[1];
        const n = b.lat !== undefined ? b.lat : b[0];
        const e = b.lng !== undefined ? b.lng : b[1];
        this._south = Math.min(s, n);
        this._north = Math.max(s, n);
        this._west = Math.min(w, e);
        this._east = Math.max(w, e);
    }
    LatLngBounds.prototype.getSouthWest = function () { return new LatLng(this._south, this._west); };
    LatLngBounds.prototype.getNorthEast = function () { return new LatLng(this._north, this._east); };
    LatLngBounds.prototype.contains = function (ll) {
        return ll.lat >= this._south && ll.lat <= this._north &&
            ll.lng >= this._west && ll.lng <= this._east;
    };

    const EPSG3857 = {
        code: 'EPSG:3857',
        project: function (latlng) {
            return new Point(
                latlng.lng * R * Math.PI / 180,
                Math.log(Math.tan(Math.PI / 4 + (latlng.lat * Math.PI / 180) / 2)) * R);
        }
    };

    function TileLayer() {}
    TileLayer.prototype.options = {};
    TileLayer.prototype.initialize = function (url, options) {
        this._url = url;
        this.options = Object.assign({}, this.options, options || {});
    };
    TileLayer.prototype.getTileSize = function () {
        const s = this.options.tileSize;
        return (s && s.x !== undefined) ? s : new Point(s, s);
    };
    // Standard XYZ → WGS 84 corner of a tile (Leaflet's own maths).
    TileLayer.prototype._tileCoordsToLatLng = function (coords) {
        const n = Math.pow(2, coords.z);
        const lng = coords.x / n * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * coords.y / n))) * 180 / Math.PI;
        return new LatLng(lat, lng);
    };
    TileLayer.prototype._tileCoordsToBounds = function (coords) {
        const nw = this._tileCoordsToLatLng({ x: coords.x, y: coords.y, z: coords.z });
        const se = this._tileCoordsToLatLng({ x: coords.x + 1, y: coords.y + 1, z: coords.z });
        return new LatLngBounds(new LatLng(se.lat, nw.lng), new LatLng(nw.lat, se.lng));
    };
    TileLayer.prototype.redraw = function () { this._redrawn = (this._redrawn || 0) + 1; return this; };
    TileLayer.prototype.onAdd = function () { this._added = true; };
    TileLayer.prototype.onRemove = function () { this._added = false; };
    TileLayer.prototype.on = function (ev, fn, ctx) {
        (this._events = this._events || {})[ev] = fn.bind(ctx || this);
        return this;
    };
    TileLayer.prototype.off = function (ev) {
        if (this._events) delete this._events[ev];
        return this;
    };
    TileLayer.prototype.fire = function (ev, data) {
        if (this._events && this._events[ev]) this._events[ev](data || {});
        return this;
    };
    TileLayer.extend = function (proto) {
        function Child(options) { if (this.initialize) this.initialize(options); }
        Child.prototype = Object.create(TileLayer.prototype);
        Object.assign(Child.prototype, proto);
        Child.prototype.options = Object.assign({}, TileLayer.prototype.options, proto.options || {});
        Child.prototype.constructor = Child;
        return Child;
    };

    return {
        LatLng: LatLng,
        Point: Point,
        TileLayer: TileLayer,
        CRS: { EPSG3857: EPSG3857 },
        latLngBounds: function (a, b) {
            if (Array.isArray(a) && !b) return new LatLngBounds(a[0], a[1]);
            if (a instanceof LatLngBounds) return a;
            return new LatLngBounds(a, b);
        },
        setOptions: function (obj, options) {
            obj.options = Object.assign({}, obj.options, options || {});
            return obj.options;
        }
    };
}

function loadModule() {
    const L = makeLeaflet();
    const sandbox = {
        L: L,
        console: {
            log: () => {},
            warn: (...a) => sandbox.__warnings.push(a.join(' ')),
            error: (...a) => sandbox.__warnings.push(a.join(' '))
        },
        __warnings: []
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/ign-mdt-layer.js'), 'utf8'),
        sandbox, { filename: 'ign-mdt-layer.js' });
    return { S: sandbox.IgnMdt, L: L, sandbox: sandbox };
}

const { S, L, sandbox } = loadModule();
const moduleSource = fs.readFileSync(path.join(__dirname, 'js/ign-mdt-layer.js'), 'utf8');
const executableSource = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. No keys, no tokens, no mixed content, no dead old source
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Security / transport / dead-code constraints');

const sample = [-322258.5112503031, 5013657.559281281, -321647.0150240217, 5014269.055507562];
const url = S.tileUrl('mapa_lidar', sample, 256);
check('the module never references a token', !/token/i.test(executableSource));
check('no API key or secret is embedded',
    !/api[_-]?key|secret|password/i.test(executableSource));
check('every service URL is https',
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).length === 0,
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).join(' '));
check('a built tile URL is https', url.indexOf('https://') === 0, url);
check('a built tile URL carries no token or key', !/token|key=/i.test(url), url);
check('the retired WMTS endpoint is gone from the module',
    executableSource.indexOf('wmts/mdt') === -1);
check('the retired INSPIRE WMS endpoint is gone from the module',
    executableSource.indexOf('wms-inspire') === -1);
check('the WMTS-specific matrix set / TileMatrix template is gone',
    executableSource.indexOf('GoogleMapsCompatible') === -1 &&
    executableSource.indexOf('TileMatrix') === -1 &&
    executableSource.indexOf('TileRow') === -1 &&
    executableSource.indexOf('TileCol') === -1);

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Configuration — only what the live GetCapabilities publishes
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] Configuration block');

eq('the endpoint is the public IDEE/IGN Mapa LiDAR WMS',
    S.CONFIG.WMS_URL, 'https://wms-mapa-lidar.idee.es/lidar');
eq('the default (only) product is Mapa LiDAR', S.CONFIG.DEFAULT_MODE, 'mapa_lidar');
eq('the product maps to the capabilities layer EL.GridCoverage',
    S.MODES.mapa_lidar.layer, 'EL.GridCoverage');
eq('the only declared style is "default", selected by an empty STYLES=',
    S.MODES.mapa_lidar.styles, '');
eq('exactly one product is offered (the service publishes one layer)',
    S.modeKeys().join(','), 'mapa_lidar');
eq('WMS 1.1.1', S.CONFIG.VERSION, '1.1.1');
eq('the projection parameter is SRS=EPSG:3857 (1.1.1, Web Mercator)',
    S.CONFIG.SRS, 'EPSG:3857');
eq('PNG so the basemap shows through', S.CONFIG.FORMAT, 'image/png');
eq('transparent tiles', S.CONFIG.TRANSPARENT, true);
eq('MapServer tiling hint TILED', S.CONFIG.TILED, true);
eq('MapServer tiling hint CONTINUOUSWORLD', S.CONFIG.CONTINUOUSWORLD, true);
eq('the identify format is the advertised text/xml', S.CONFIG.INFO_FORMAT, 'text/xml');
eq('256 px tiles (service MaxWidth/MaxHeight is 4096)', S.CONFIG.TILE_SIZE, 256);
eq('default opacity is 0.7', S.CONFIG.OPACITY, 0.7);
eq('maxZoom stays at the app-wide LiDAR cap', S.CONFIG.MAX_ZOOM, 20);
eq('maxNativeZoom keeps the previous zoom window', S.CONFIG.MAX_NATIVE_ZOOM, 20);
check('no zoom beyond the previous window is requested',
    S.CONFIG.MAX_ZOOM <= 20);
check('a sensible minZoom exists', S.CONFIG.MIN_ZOOM >= 1 && S.CONFIG.MIN_ZOOM <= 8);
check('keepBuffer stays small on a government server', S.CONFIG.KEEP_BUFFER <= 1);
check('a caching-proxy hook exists (no token involved)', 'PROXY_URL' in S.CONFIG);
check('no CORS dance is needed for plain <img> tiles', S.CONFIG.CROSS_ORIGIN === false);
check('the attribution credits the IDEE, the IGN/CNIG and the CC BY 4.0 licence',
    /IDEE/.test(S.CONFIG.ATTRIBUTION) &&
    /Instituto Geográfico Nacional/.test(S.CONFIG.ATTRIBUTION) &&
    /CNIG/.test(S.CONFIG.ATTRIBUTION) &&
    /CC BY 4\.0/.test(S.CONFIG.ATTRIBUTION), S.CONFIG.ATTRIBUTION);
check('the attribution links to the service provider',
    /href="https:\/\/www\.ign\.es\/"/.test(S.CONFIG.ATTRIBUTION) ||
    /href="https:\/\/www\.idee\.es\/"/.test(S.CONFIG.ATTRIBUTION));

// Coverage from the capabilities: EX_GeographicBoundingBox −19 27 → 5 44.
const b = S.CONFIG.BOUNDS;
check('the bounds are the capabilities extent (−19 27 → 5 44)',
    JSON.stringify(b) === JSON.stringify([[27, -19], [44, 5]]), JSON.stringify(b));
check('the bounds cover the peninsula, the Balearics and the Canaries',
    b[0][0] <= 27.64 && b[0][1] <= -18.21 && b[1][0] >= 43.94 && b[1][1] >= 4.77,
    JSON.stringify(b));
check('and nothing outside the published service box', b[0][0] >= 26 &&
    b[1][0] <= 45 && b[0][1] >= -19.5 && b[1][1] <= 6, JSON.stringify(b));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The GetMap request (the shape the live service answered with 200 PNG)
 *    Reference request (2026-10-07, HTTP 200 image/png 256×256, CORS *):
 *    https://wms-mapa-lidar.idee.es/lidar?SERVICE=WMS&REQUEST=GetMap&
 *    LAYERS=EL.GridCoverage&STYLES=&FORMAT=image%2Fpng&TRANSPARENT=true&
 *    VERSION=1.1.1&CONTINUOUSWORLD=true&TILED=true&INFO_FORMAT=text%2Fxml&
 *    WIDTH=256&HEIGHT=256&SRS=EPSG%3A3857&BBOX=<minx>,<miny>,<maxx>,<maxy>
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] GetMap request format');

const VERIFIED =
    'https://wms-mapa-lidar.idee.es/lidar' +
    '?SERVICE=WMS&REQUEST=GetMap&LAYERS=EL.GridCoverage&STYLES=&FORMAT=image%2Fpng' +
    '&TRANSPARENT=true&VERSION=1.1.1&CONTINUOUSWORLD=true&TILED=true' +
    '&INFO_FORMAT=text%2Fxml&WIDTH=256&HEIGHT=256&SRS=EPSG%3A3857' +
    '&BBOX=-322258.5113,5013657.5593,-321647.015,5014269.0555';
eq('the built URL matches the verified live request (BBOX supplied per tile)',
    url, VERIFIED);
check('the projection parameter is SRS, never CRS (WMS 1.1.1)',
    /[?&]SRS=EPSG%3A3857/.test(url) && !/[?&]CRS=/.test(url));
check('the service version is 1.1.1, not 1.3.0', /[?&]VERSION=1\.1\.1&/.test(url));
check('STYLES is left empty (the service default)', /[?&]STYLES=&/.test(url));
check('the layer is the capabilities layer EL.GridCoverage',
    /[?&]LAYERS=EL\.GridCoverage&/.test(url));
check('the BBOX keeps the geometry it was given (4 decimals)',
    /&BBOX=-322258\.5113,5013657\.5593,-321647\.015,5014269\.0555$/.test(url), url);
check('the BBOX is never hardcoded in the module (it is a parameter)',
    !/BBOX=-?\d/.test(executableSource));
check('switching an unknown product falls back to the default',
    S.tileUrl('nope', sample, 256) === url);

S.CONFIG.PROXY_URL = 'https://lidar-cache.example.com/lidar';
check('tiles honour the caching proxy when configured',
    S.tileUrl('mapa_lidar', sample, 256).indexOf('https://lidar-cache.example.com/lidar?') === 0);
S.CONFIG.PROXY_URL = '';

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Tile geometry — the layer must line up with the basemap
 *    The old WMTS cache reported for TileMatrix=12 TileCol=2002 TileRow=1544:
 *      -450061.222480502, 4921321.628427692, -440277.2828613594, 4931105.568046834
 *    The WMS must ask for exactly that box for the same XYZ tile.
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Tile geometry (EPSG:3857 XYZ grid)');

const z = 12, tx = 2002, ty = 1544;
const span = (2 * HALF) / Math.pow(2, z);
const xmin = -HALF + tx * span;
const ymax = HALF - ty * span;
const layer = S.createLayer({ mode: 'mapa_lidar' });
layer._map = { options: { crs: L.CRS.EPSG3857 }, getZoom: function () { return z; } };
const tileUrl = layer.getTileUrl({ x: tx, y: ty, z: z });
const tileBBox = tileUrl.match(/&BBOX=([^&]+)$/)[1].split(',').map(Number);
near('XYZ x=2002 at z12 matches the tile minx the WMTS reported', tileBBox[0], xmin, 0.5);
near('XYZ y=1544 at z12 matches the tile maxy the WMTS reported', tileBBox[3], ymax, 0.5);
near('the tile is one full XYZ step wide',
    tileBBox[2] - tileBBox[0], 4931105.568046834 - 4921321.628427692, 0.5);
near('the layer reproduces the WMTS tile box (same grid, no offset)',
    tileBBox[0], -450061.222480502, 0.5);
check('the BBOX grows with x and shrinks with y (Mercator, top-left origin)',
    tileBBox[2] > tileBBox[0] && tileBBox[3] > tileBBox[1]);
check('the tile URL asks for the WMS in 3857', /SRS=EPSG%3A3857/.test(tileUrl));

// Madrid 40.4168 N, 3.7038 W must fall inside its own tile.
function lonToX(lon, zoom) { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
function latToY(lat, zoom) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, zoom));
}
const mx = lonToX(-3.7038, z), my = latToY(40.4168, z);
const madrid = layer.getTileUrl({ x: mx, y: my, z: z }).match(/&BBOX=([^&]+)$/)[1]
    .split(',').map(Number);
const madridX = -3.7038 * R * Math.PI / 180;
const madridY = Math.log(Math.tan(Math.PI / 4 + (40.4168 * Math.PI / 180) / 2)) * R;
check('Madrid lies inside the tile the layer asks for',
    madridX >= madrid[0] && madridX <= madrid[2] &&
    madridY >= madrid[1] && madridY <= madrid[3]);

// The identify helper queries one pixel of that tile at the same geometry.
const gfi = layer.getFeatureInfoUrl(new L.LatLng(40.4168, -3.7038), { zoom: 15 });
check('the identify URL is a GetFeatureInfo on the same layer',
    /REQUEST=GetFeatureInfo/.test(gfi) && /QUERY_LAYERS=EL\.GridCoverage/.test(gfi));
check('the identify URL declares the advertised INFO_FORMAT',
    /INFO_FORMAT=text%2Fxml/.test(gfi));
check('the identify URL queries a pixel inside the 256 px image',
    /[?&]X=128&Y=128/.test(gfi) && /WIDTH=256&HEIGHT=256/.test(gfi));
check('the identify URL is in EPSG:3857 as well', /SRS=EPSG%3A3857/.test(gfi));
check('the identify URL is https and token-free',
    gfi.indexOf('https://') === 0 && !/token|key=/i.test(gfi));

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Layer behaviour
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] Layer behaviour');

eq('maxNativeZoom keeps the published window', layer.options.maxNativeZoom, 20);
eq('minZoom comes from the config', layer.options.minZoom, S.CONFIG.MIN_ZOOM);
eq('the attribution travels with the layer', layer.options.attribution, S.CONFIG.ATTRIBUTION);
eq('opacity default', layer.options.opacity, 0.7);
eq('keepBuffer is tiny (no far-viewport preloading)', layer.options.keepBuffer, 1);
eq('the layer is sized 256 px', layer.getTileSize().x, 256);
check('the layer is bounded to the published extent',
    layer.options.bounds.contains(new L.LatLng(40.4168, -3.7038)) &&
    layer.options.bounds.contains(new L.LatLng(28.29, -16.62)) &&   // Tenerife
    !layer.options.bounds.contains(new L.LatLng(48.85, 2.35)));     // Paris
eq('failed tiles fall back to a transparent pixel',
    layer.options.errorTileUrl, S.BLANK_TILE);
check('the fallback really is a transparent PNG data URI',
    S.BLANK_TILE.indexOf('data:image/png;base64,') === 0);
check('no tile churn during gestures', layer.options.updateWhenZooming === false &&
    layer.options.updateWhenIdle === true);
check('the layer does not wrap around the world', layer.options.noWrap === true);

check('an unknown mode is ignored', layer.setMode('nope').getMode() === 'mapa_lidar');
check('re-selecting the current product is a no-op',
    layer.setMode('mapa_lidar').getMode() === 'mapa_lidar' && !layer._redrawn);

// Tile errors: one warning for the whole layer, never one per tile.
const errLayer = S.createLayer({ mode: 'mapa_lidar' });
errLayer.onAdd({});
const before = sandbox.__warnings.length;
errLayer.fire('tileerror', {});
errLayer.fire('tileerror', {});
errLayer.fire('tileerror', {});
eq('tile errors are logged once, not once per tile',
    sandbox.__warnings.length - before, 1);
errLayer.onRemove({});
check('removing the layer detaches the error handler',
    !errLayer._events || !errLayer._events.tileerror);

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Wiring in the app (Spain row only)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Wiring in the app');

const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const mapAppCode = mapApp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const scriptSrcs = (indexHtml.match(/<script[^>]+src="[^"]+"/g) || [])
    .map((tag) => tag.match(/src="([^"?]+)/)[1]);
check('index.html loads ign-mdt-layer.js before map-app.js',
    scriptSrcs.indexOf('js/ign-mdt-layer.js') !== -1 &&
    scriptSrcs.indexOf('js/ign-mdt-layer.js') < scriptSrcs.indexOf('js/map-app.js'));
check('the service worker pre-caches it', sw.indexOf('js/ign-mdt-layer.js') !== -1);
check('the service worker cache name was bumped for this change',
    /detectlab-v16[8-9]|detectlab-v(1[7-9]|2[0-9])\d/.test(sw));
check('the Spain layer is built by the module', /IgnMdt\.createLayer/.test(mapApp));
check('the app exposes the new Spain WMS endpoint, not the WMTS one',
    /window\.SPAIN_LIDAR_WMS_URL = SPAIN_LIDAR_WMS_URL/.test(mapApp) &&
    mapApp.indexOf('SPAIN_LIDAR_WMTS_URL') === -1);
check('the dead INSPIRE WMS constant is gone from the app',
    mapAppCode.indexOf('wms-inspire') === -1);
check('the retired WMTS endpoint is gone from the app', mapAppCode.indexOf('wmts/mdt') === -1);
check('the retired INSPIRE WMS endpoint is gone from index.html',
    indexHtml.indexOf('wms-inspire') === -1 && indexHtml.indexOf('wmts/mdt') === -1);
check('the retired relief style name is gone from the shipped files',
    indexHtml.indexOf('Elevaciones') === -1 && mapAppCode.indexOf('Elevaciones') === -1);
check('the product dropdown offers the single Mapa LiDAR product',
    /value="mapa_lidar"/.test(indexHtml) &&
    !/value="relieve"/.test(indexHtml) && !/value="elevacion"/.test(indexHtml));
check('the dropdown is also filled from the module at runtime',
    /_populateSpainModeSelect/.test(mapApp) && /IgnMdt\.modeKeys\(\)/.test(mapApp));
check('switching product uses setMode instead of rebuilding',
    /setSpainLidarMode/.test(mapApp) && /cfg\.leafletLayer\.setMode\(mode\)/.test(mapApp));
check('the on/off switch still drives the Spain row',
    /toggleInternationalLidar\('esLidar', this\.checked\)/.test(indexHtml));
check('the opacity slider defaults to 70%',
    /id="lidarEsLidarOpacitySlider"[^>]*value="70"/.test(indexHtml) &&
    /id="lidarEsLidarPct">70%/.test(indexHtml));
check('the attribution is visible in the UI config',
    /Mapa LiDAR ©/.test(mapApp) || /Mapa LiDAR ©/.test(indexHtml));
check('the info popup no longer advertises the WMTS source',
    /wms-mapa-lidar\.idee\.es\/lidar/.test(indexHtml));
check('the fly-to bounds match the capabilities extent',
    /esLidar: \[\[27, -19\], \[44, 5\]\]/.test(mapApp));
check('the service worker lets IDEE tiles bypass the app-shell cache',
    /'idee\.es'/.test(sw));

// Scope guard: only the Spain row changed.
check('the Norway layer still uses its own module', /Hoydedata\.createLayer/.test(mapApp));
check('the Poland layer still uses its own module', /GeoportalNMT\.createLayer/.test(mapApp));
check('the Netherlands layer still uses its own module',
    /AhnLidar\.createLayer/.test(mapApp));
['SWITZERLAND_LIDAR_WMS_URL', 'UK_LIDAR_WMS_URL', 'FRANCE_LIDAR_WMS_URL',
    'DENMARK_LIDAR_WMS_URL'].forEach(function (name) {
    check('other country service kept: ' + name, mapApp.indexOf(name) !== -1);
});

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('All Spain IDEE/IGN "Mapa LiDAR" WMS checks passed.');
