/*
 * test-switzerland-swisstopo-relief.js
 * ──────────────────────────────────────────────────────────────────────────
 * Switzerland LiDAR layer — swisstopo WMTS relief of swissALTI3D /
 * swissSURFACE3D / swissBATHY3D.
 *
 * What this pins:
 *   • the row no longer asks the WMS for ch.swisstopo.swisssurface3d.metadata
 *     (acquisition footprints, not terrain imagery);
 *   • the RESTful WMTS path is byte-for-byte the request that returned 200
 *     image/png on the live service (2026-10-06), including the order
 *     {TileMatrix}/{TileCol}/{TileRow} = {z}/{x}/{y};
 *   • maxNativeZoom comes from each layer's own TileMatrixSet in the
 *     capabilities (3857_18 → 18, 3857_17 → 17 for the bathymetry), which was
 *     also confirmed empirically: z18 returns a PNG, z19 returns a JSON error;
 *   • no API key and no token, HTTPS only;
 *   • only the Switzerland row of the app changed.
 *
 * Run:  node test-switzerland-swisstopo-relief.js
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

/* ── Leaflet 1.x stub (enough of L.TileLayer to build a real tile URL) ──── */
const R = 6378137;
const HALF = Math.PI * R;

function makeLeaflet() {
    function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
    function Point(x, y) { this.x = x; this.y = y; }

    function LatLngBounds(a, b) {
        const lats = [a.lat !== undefined ? a.lat : a[0], b.lat !== undefined ? b.lat : b[0]];
        const lngs = [a.lng !== undefined ? a.lng : a[1], b.lng !== undefined ? b.lng : b[1]];
        this._south = Math.min.apply(null, lats);
        this._north = Math.max.apply(null, lats);
        this._west = Math.min.apply(null, lngs);
        this._east = Math.max.apply(null, lngs);
    }
    LatLngBounds.prototype.getSouthWest = function () { return new LatLng(this._south, this._west); };
    LatLngBounds.prototype.getNorthEast = function () { return new LatLng(this._north, this._east); };
    LatLngBounds.prototype.contains = function (ll) {
        return ll.lat >= this._south && ll.lat <= this._north &&
            ll.lng >= this._west && ll.lng <= this._east;
    };

    function TileLayer() {}
    TileLayer.prototype.options = {};
    TileLayer.prototype.initialize = function (url, options) {
        this._url = url;
        this.options = Object.assign({}, this.options, options || {});
    };
    TileLayer.prototype.getTileUrl = function (coords) {
        return this._url
            .replace('{z}', coords.z)
            .replace('{y}', coords.y)
            .replace('{x}', coords.x);
    };
    TileLayer.prototype.setUrl = function (url) {
        this._url = url;
        this.redraw();
        return this;
    };
    TileLayer.prototype.onAdd = function () { this._added = true; };
    TileLayer.prototype.onRemove = function () { this._added = false; };
    TileLayer.prototype.redraw = function () { this._redrawn = (this._redrawn || 0) + 1; return this; };
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
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/swisstopo-relief-layer.js'), 'utf8'),
        sandbox, { filename: 'swisstopo-relief-layer.js' });
    return { S: sandbox.SwisstopoRelief, L: L, sandbox: sandbox };
}

const { S, L, sandbox } = loadModule();
const moduleSource = fs.readFileSync(path.join(__dirname, 'js/swisstopo-relief-layer.js'), 'utf8');
const executableSource = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. No keys, no tokens, no mixed content
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Security / transport constraints');

const url = S.tileUrl('relief', 11, 1073, 722);
check('the module never references a token', !/token/i.test(executableSource));
check('no API key or secret is embedded',
    !/api[_-]?key|secret|password/i.test(executableSource));
check('every service URL is https',
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).length === 0,
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).join(' '));
check('a built tile URL is https', url.indexOf('https://') === 0, url);
check('a built tile URL carries no token or key', !/token|[?&]key=/i.test(url), url);
check('the URL is a clean REST path, not a KVP query string',
    url.indexOf('?') === -1, url);

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Configuration — only what the live GetCapabilities publishes
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] Configuration block');

eq('the endpoint is the public swisstopo WMTS', S.CONFIG.HOST, 'https://wmts.geo.admin.ch');
eq('WMTS 1.0.0', S.CONFIG.VERSION, '1.0.0');
eq('style "default"', S.CONFIG.STYLE, 'default');
eq('time dimension "current" (the only value these layers publish)',
    S.CONFIG.TIME, 'current');
eq('tile matrix set 3857 (= standard XYZ, Web Mercator)',
    S.CONFIG.TILE_MATRIX_SET, '3857');
eq('PNG so the basemap shows through', S.CONFIG.EXT, 'png');
eq('256 px tiles, as published in the matrix set', S.CONFIG.TILE_SIZE, 256);
eq('the default product is the swissALTI3D multidirectional relief',
    S.CONFIG.DEFAULT_MODE, 'relief');
eq('…with the published layer identifier', S.MODES.relief.layer,
    'ch.swisstopo.swissalti3d-reliefschattierung');
eq('the mono-directional variant is the published one', S.MODES.mono.layer,
    'ch.swisstopo.swissalti3d-reliefschattierung_monodirektional');
eq('the surface model layer is the published one (hyphen, not underscore)',
    S.MODES.surface.layer,
    'ch.swisstopo.swisssurface3d-reliefschattierung-multidirektional');
eq('the lake-floor layer is the published one', S.MODES.bathy.layer,
    'ch.swisstopo.swissbathy3d-reliefschattierung');
check('the dead metadata layer is gone',
    executableSource.indexOf('swisssurface3d.metadata') === -1);
check('the WMS endpoint is not used by this module',
    executableSource.indexOf('wms.geo.admin.ch') === -1);
eq('maxNativeZoom for the relief layers is 18 (TileMatrixSet 3857_18)',
    S.MODES.relief.maxNativeZoom + ',' + S.MODES.mono.maxNativeZoom + ',' +
    S.MODES.surface.maxNativeZoom, '18,18,18');
eq('maxNativeZoom for the bathymetry is 17 (TileMatrixSet 3857_17)',
    S.MODES.bathy.maxNativeZoom, 17);
eq('default opacity is 0.7', S.CONFIG.OPACITY, 0.7);
check('a sensible minZoom exists', S.CONFIG.MIN_ZOOM >= 1 && S.CONFIG.MIN_ZOOM <= 9);
check('keepBuffer stays small on a government server', S.CONFIG.KEEP_BUFFER <= 1);
check('a caching-proxy hook exists', 'PROXY_HOST' in S.CONFIG);
check('the attribution is the required swisstopo credit',
    /©\s*<a[^>]*>swisstopo<\/a>|©\s*swisstopo/.test(S.CONFIG.ATTRIBUTION),
    S.CONFIG.ATTRIBUTION);

// Coverage from the capabilities: 5.140242 45.398181 → 11.47757 48.230651.
const b = S.CONFIG.BOUNDS;
near('the south bound matches the capabilities', b[0][0], 45.398181, 1e-6);
near('the west bound matches the capabilities', b[0][1], 5.140242, 1e-6);
near('the north bound matches the capabilities', b[1][0], 48.230651, 1e-6);
near('the east bound matches the capabilities', b[1][1], 11.47757, 1e-6);

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The GetTile path (compared with the verified live request)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] RESTful WMTS path');

const VERIFIED = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung' +
    '/default/current/3857/11/1073/722.png';
eq('the built URL is byte-for-byte the request that returned 200 image/png',
    url, VERIFIED);
const template = S.tileTemplate('relief');
check('the template keeps Leaflet placeholders in z/x/y order',
    /\/3857\/\{z\}\/\{x\}\/\{y\}\.png$/.test(template), template);
check('switching product only changes the layer segment',
    S.tileUrl('mono', 11, 1073, 722) ===
    VERIFIED.replace('ch.swisstopo.swissalti3d-reliefschattierung',
        'ch.swisstopo.swissalti3d-reliefschattierung_monodirektional'));
check('an unknown product falls back to the default',
    S.tileUrl('nope', 11, 1073, 722) === VERIFIED);
check('the time segment is part of the path, not a query parameter',
    template.indexOf('/current/') !== -1 && template.indexOf('time=') === -1);

S.CONFIG.PROXY_HOST = 'https://swisstopo-cache.example.com';
check('tiles honour the caching proxy when configured',
    S.tileUrl('relief', 11, 1073, 722).indexOf(
        'https://swisstopo-cache.example.com/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung/') === 0);
S.CONFIG.PROXY_HOST = '';

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Tile geometry — the relief must line up with the basemap
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Tile geometry (EPSG:3857 XYZ grid)');

// The example tile 11/1073/722 and Bern (46.948 N, 7.447 E) at z14/z18 were
// all fetched live; here we only prove the XYZ arithmetic the template relies
// on, since the matrix set origin is the standard -20037508.342789244.
function lonToX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
const bern = { lat: 46.948, lng: 7.447 };
eq('Bern at z18 maps to the tile that returned 200 image/png',
    latToY(bern.lat, 18) + '/' + lonToX(bern.lng, 18), '92258/136494');
eq('…and its URL substitutes the numbers in the right order',
    S.tileUrl('relief', 18, 136494, 92258),
    'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung' +
    '/default/current/3857/18/136494/92258.png');
const HALF_M = Math.PI * 6378137;
const span11 = (2 * HALF_M) / Math.pow(2, 11);
const exampleWest = -HALF_M + 1073 * span11;          // metres, EPSG:3857
const exampleNorth = HALF_M - 722 * span11;
near('the z11 example tile sits on the standard Web-Mercator grid',
    exampleWest, 958826.083, 0.01);
check('…and inside Switzerland (≈8.6 E, ≈46.8 N)',
    Math.abs(exampleWest / HALF_M * 180 - 8.613) < 0.01 &&
    Math.abs((2 * Math.atan(Math.exp(exampleNorth / 6378137)) - Math.PI / 2) * 180 / Math.PI - 46.80) < 0.1,
    exampleWest + '/' + exampleNorth);
check('no hand-rolled Mercator maths in the module (Leaflet owns the grid)',
    !/6378137|20037508/.test(executableSource));

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Layer behaviour
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] Layer behaviour');

const layer = S.createLayer({ mode: 'relief' });
eq('maxNativeZoom caps real requests at the published maximum',
    layer.options.maxNativeZoom, 18);
eq('minZoom comes from the config', layer.options.minZoom, S.CONFIG.MIN_ZOOM);
eq('the attribution travels with the layer', layer.options.attribution, S.CONFIG.ATTRIBUTION);
eq('opacity default', layer.options.opacity, 0.7);
eq('keepBuffer is tiny (no far-viewport preloading)', layer.options.keepBuffer, 1);
check('the layer is bounded to the Swiss extent',
    layer.options.bounds.contains(new L.LatLng(46.948, 7.447)) &&     // Bern
    layer.options.bounds.contains(new L.LatLng(47.14, 9.52)) &&       // Liechtenstein
    !layer.options.bounds.contains(new L.LatLng(48.85, 2.35)));       // Paris
eq('failed tiles fall back to a transparent pixel',
    layer.options.errorTileUrl, S.BLANK_TILE);
check('the fallback really is a transparent PNG data URI',
    S.BLANK_TILE.indexOf('data:image/png;base64,') === 0);
check('no tile churn during gestures', layer.options.updateWhenZooming === false &&
    layer.options.updateWhenIdle === true);
check('the layer does not wrap around the world', layer.options.noWrap === true);
check('the initial URL is the relief template', layer._url === S.tileTemplate('relief'));

layer.setMode('bathy');
eq('setMode switches the product', layer.getMode(), 'bathy');
check('the URL follows the switch',
    layer.getTileUrl({ x: 1073, y: 722, z: 11 }).indexOf('swissbathy3d-reliefschattierung') !== -1);
eq('…and maxNativeZoom follows the product (bathymetry stops at 17)',
    layer.options.maxNativeZoom, 17);
check('switching redraws instead of rebuilding', layer._redrawn >= 1);
check('an unknown mode is ignored', layer.setMode('nope').getMode() === 'bathy');
layer.setMode('relief');
eq('switching back restores maxNativeZoom 18', layer.options.maxNativeZoom, 18);

// Tile errors: one warning for the whole layer, never one per tile.
const errLayer = S.createLayer({ mode: 'relief' });
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
 * 6. Wiring in the app (Switzerland row only)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Wiring in the app');

const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
const mapAppCode = mapApp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const scriptSrcs = (indexHtml.match(/<script[^>]+src="[^"]+"/g) || [])
    .map((tag) => tag.match(/src="([^"?]+)/)[1]);
check('index.html loads swisstopo-relief-layer.js before map-app.js',
    scriptSrcs.indexOf('js/swisstopo-relief-layer.js') !== -1 &&
    scriptSrcs.indexOf('js/swisstopo-relief-layer.js') < scriptSrcs.indexOf('js/map-app.js'));
check('the service worker pre-caches it', sw.indexOf('js/swisstopo-relief-layer.js') !== -1);
check('the service worker cache name was bumped',
    /detectlab-v159|detectlab-v(1[6-9]|2[0-9])\d/.test(sw));
check('the Switzerland layer is built by the module', /SwisstopoRelief\.createLayer/.test(mapApp));
check('the Switzerland row no longer requests the metadata layer',
    mapAppCode.indexOf('ch.swisstopo.swisssurface3d.metadata') === -1 &&
    indexHtml.indexOf('ch.swisstopo.swisssurface3d.metadata') === -1);
check('the product dropdown offers all four relief products',
    /value="relief"/.test(indexHtml) && /value="mono"/.test(indexHtml) &&
    /value="surface"/.test(indexHtml) && /value="bathy"/.test(indexHtml));
check('the dropdown is also filled from the module at runtime',
    /_populateSwitzerlandModeSelect/.test(mapApp) && /SwisstopoRelief\.modeKeys\(\)/.test(mapApp));
check('switching product uses setMode instead of rebuilding',
    /setSwitzerlandLidarMode/.test(mapApp) && /cfg\.leafletLayer\.setMode\(mode\)/.test(mapApp));
check('the on/off switch still drives the Switzerland row',
    /toggleInternationalLidar\('chLidar', this\.checked\)/.test(indexHtml));
check('the opacity slider defaults to 70%',
    /id="lidarChLidarOpacitySlider"[^>]*value="70"/.test(indexHtml) &&
    /id="lidarChLidarPct">70%/.test(indexHtml));
check('the visible attribution is © swisstopo',
    /swisstopo/.test(mapApp) && /swisstopo/.test(indexHtml));
check('the fly-to bounds match the capabilities extent',
    /chLidar: \[\[45\.398181, 5\.140242\], \[48\.230651, 11\.47757\]\]/.test(mapApp));

// Scope guard: only the Switzerland row changed.
check('the Norway layer still uses its own module', /Hoydedata\.createLayer/.test(mapApp));
check('the Poland layer still uses its own module', /GeoportalNMT\.createLayer/.test(mapApp));
check('the Spain layer still uses its own module', /IgnMdt\.createLayer/.test(mapApp));
check('the Netherlands layer still uses its own module', /AhnLidar\.createLayer/.test(mapApp));
['UK_LIDAR_WMS_URL', 'FRANCE_LIDAR_WMS_URL', 'DENMARK_LIDAR_WMS_URL'].forEach(function (name) {
    check('other country service kept: ' + name, mapApp.indexOf(name) !== -1);
});

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('All Switzerland swisstopo relief checks passed.');
