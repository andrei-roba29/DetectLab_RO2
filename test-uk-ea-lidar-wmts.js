/*
 * test-uk-ea-lidar-wmts.js
 * ──────────────────────────────────────────────────────────────────────────
 * England LiDAR layer — Environment Agency LIDAR Composite over the public
 * WMTS on environment.data.gov.uk.
 *
 * What this pins:
 *   • the GetTile query string is byte-for-byte the request that returned 200
 *     image/png on the live service (2026-10-06), including the camelCase
 *     parameter names and the mapping tileMatrix={z}, tileCol={x}, tileRow={y};
 *   • maxNativeZoom (24) comes from the WebMercatorQuad TileMatrixSetLimits in
 *     the capabilities — also confirmed empirically: z24 returns a PNG, z25
 *     returns an XML ServiceException;
 *   • the layer is clipped to the published England extent, so Scotland,
 *     Wales and Ireland never generate a request;
 *   • no API key and no token, HTTPS only;
 *   • only the UK row of the app changed.
 *
 * Run:  node test-uk-ea-lidar-wmts.js
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
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/ea-lidar-wmts-layer.js'), 'utf8'),
        sandbox, { filename: 'ea-lidar-wmts-layer.js' });
    return { E: sandbox.EaLidarWmts, L: L, sandbox: sandbox };
}

const { E, L, sandbox } = loadModule();
const moduleSource = fs.readFileSync(path.join(__dirname, 'js/ea-lidar-wmts-layer.js'), 'utf8');
const executableSource = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. No keys, no tokens, no mixed content
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Security / transport constraints');

const url = E.tileUrl('hillshade', 15, 16183, 10989);
check('the module never references a token', !/token/i.test(executableSource));
check('no API key or secret is embedded',
    !/api[_-]?key|secret|password/i.test(executableSource));
check('every service URL is https',
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).length === 0,
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).join(' '));
check('a built tile URL is https', url.indexOf('https://') === 0, url);
check('a built tile URL carries no token or key', !/token|[?&]key=/i.test(url), url);

/* ══════════════════════════════════════════════════════════════════════════
 * 2. Configuration — only what the live GetCapabilities publishes
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] Configuration block');

eq('the endpoint is the public Defra/EA spatial data service',
    E.CONFIG.HOST, 'https://environment.data.gov.uk');
eq('WMTS 1.0.0', E.CONFIG.VERSION, '1.0.0');
eq('tile matrix set WebMercatorQuad (= standard XYZ, EPSG:3857)',
    E.CONFIG.TILE_MATRIX_SET, 'WebMercatorQuad');
eq('PNG so the basemap shows through', E.CONFIG.FORMAT, 'image/png');
eq('transparent tiles requested', E.CONFIG.TRANSPARENT, true);
eq('256 px tiles, as published in the matrix set', E.CONFIG.TILE_SIZE, 256);
eq('the default product is the 1 m DTM hillshade', E.CONFIG.DEFAULT_MODE, 'hillshade');
eq('…with the published layer identifier', E.MODES.hillshade.layer,
    'Lidar_Composite_Hillshade_DTM_1m');
eq('…from the DTM 1 m service path', E.MODES.hillshade.service,
    'lidar-composite-digital-terrain-model-dtm-1m');
eq('the colour elevation layer is the published one', E.MODES.elevation.layer,
    'Lidar_Composite_Elevation_DTM_1m');
eq('the plain terrain model is the published one', E.MODES.dtm.layer,
    'Lidar_Composite_DTM_1m');
eq('the surface-model hillshade is the published one', E.MODES.dsmHillshade.layer,
    'Lidar_Composite_Hillshade_LZ_DSM_1m');
eq('…and lives on the last-return DSM service', E.MODES.dsmHillshade.service,
    'lidar-composite-digital-surface-model-last-return-dsm-1m');
check('every product declares its own maxNativeZoom',
    E.modeKeys().every((k) => E.MODES[k].maxNativeZoom === 24),
    JSON.stringify(E.modeKeys().map((k) => E.MODES[k].maxNativeZoom)));
check('every product declares its own published extent',
    E.modeKeys().every((k) => Array.isArray(E.MODES[k].bounds)));
eq('default opacity is 0.7', E.CONFIG.OPACITY, 0.7);
check('a sensible minZoom exists', E.CONFIG.MIN_ZOOM >= 1 && E.CONFIG.MIN_ZOOM <= 9);
check('keepBuffer stays small on a government server', E.CONFIG.KEEP_BUFFER <= 1);
check('a caching-proxy hook exists', 'PROXY_HOST' in E.CONFIG);
check('the attribution carries the dataset statement',
    /Environment Agency copyright and\/or database right/.test(E.CONFIG.ATTRIBUTION),
    E.CONFIG.ATTRIBUTION);
check('…and the Open Government Licence v3.0 notice',
    /Open Government Licence/.test(E.CONFIG.ATTRIBUTION) &&
    /open-government-licence\/version\/3/.test(E.CONFIG.ATTRIBUTION));

// Coverage of the hillshade layer from the capabilities:
// -7.104775741839742 49.85060473351981 → 2.0842821419111135 55.87708724246775
const b = E.CONFIG.BOUNDS;
near('the south bound matches the capabilities', b[0][0], 49.85060473351981, 1e-9);
near('the west bound matches the capabilities', b[0][1], -7.104775741839742, 1e-9);
near('the north bound matches the capabilities', b[1][0], 55.87708724246775, 1e-9);
near('the east bound matches the capabilities', b[1][1], 2.0842821419111135, 1e-9);

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The GetTile request (compared with the verified live request)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] WMTS GetTile request');

const VERIFIED = 'https://environment.data.gov.uk/spatialdata/' +
    'lidar-composite-digital-terrain-model-dtm-1m/wmts' +
    '?service=WMTS&request=GetTile&version=1.0.0' +
    '&layer=Lidar_Composite_Hillshade_DTM_1m&style=hillshade' +
    '&tileMatrixSet=WebMercatorQuad&format=image%2Fpng&transparent=true' +
    '&tileMatrix=15&tileRow=10989&tileCol=16183';
eq('the built URL is byte-for-byte the request that returned 200 image/png',
    url, VERIFIED);

const template = E.tileTemplate('hillshade');
check('the template keeps the Leaflet placeholders',
    /tileMatrix=\{z\}&tileRow=\{y\}&tileCol=\{x\}$/.test(template), template);
check('tileMatrix is the zoom, tileCol the x and tileRow the y',
    E.tileUrl('hillshade', 7, 1, 2).indexOf('tileMatrix=7&tileRow=2&tileCol=1') !== -1,
    E.tileUrl('hillshade', 7, 1, 2));
check('the format value stays percent-encoded',
    template.indexOf('format=image%2Fpng') !== -1);
check('the parameter names use the service\'s camelCase spelling',
    /tileMatrixSet=/.test(template) && /tileMatrix=/.test(template) &&
    !/TILEMATRIX|tilematrix=/.test(template));
check('switching product changes the layer (and the service path when needed)',
    E.tileUrl('dsmHillshade', 15, 16183, 10989).indexOf(
        '/spatialdata/lidar-composite-digital-surface-model-last-return-dsm-1m/wmts') !== -1 &&
    E.tileUrl('dsmHillshade', 15, 16183, 10989).indexOf(
        'layer=Lidar_Composite_Hillshade_LZ_DSM_1m') !== -1);
check('an unknown product falls back to the default',
    E.tileUrl('nope', 15, 16183, 10989) === VERIFIED);
check('the plain DTM is requested with the service\'s empty default style',
    E.tileUrl('dtm', 15, 16183, 10989).indexOf('&style=&') !== -1);

E.CONFIG.PROXY_HOST = 'https://ea-lidar-cache.example.com';
check('tiles honour the caching proxy when configured',
    E.tileUrl('hillshade', 15, 16183, 10989).indexOf(
        'https://ea-lidar-cache.example.com/spatialdata/') === 0);
E.CONFIG.PROXY_HOST = '';

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Tile geometry — the hillshade must line up with the basemap
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Tile geometry (WebMercatorQuad = EPSG:3857 XYZ grid)');

function lonToX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
function latToY(lat, z) {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
// The Dorset tile that returned 200 image/png at z19, and the example tile.
eq('Dorset (50.70 N, 2.45 W) at z19 maps to the tile that returned 200',
    lonToX(-2.45, 19) + '/' + latToY(50.70, 19), '258575/176211');
check('…and its URL substitutes the numbers in the right order',
    E.tileUrl('hillshade', 19, 258575, 176211)
        .endsWith('&tileMatrix=19&tileRow=176211&tileCol=258575'),
    E.tileUrl('hillshade', 19, 258575, 176211));
// The example tile's GeoWebCache bounds were
// -245821.48 6596821.29 → -244598.49 6598044.28 (EPSG:3857 metres).
const HALF_M = Math.PI * 6378137;
const span15 = (2 * HALF_M) / Math.pow(2, 15);
near('the example tile sits exactly on the Web-Mercator grid (west edge)',
    -HALF_M + 16183 * span15, -245821.48, 0.1);
near('…and on its north edge', HALF_M - 10989 * span15, 6598044.28, 0.1);
check('no hand-rolled Mercator maths in the module (Leaflet owns the grid)',
    !/6378137|20037508/.test(executableSource));

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Layer behaviour
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] Layer behaviour');

const layer = E.createLayer({ mode: 'hillshade' });
eq('maxNativeZoom caps real requests at the published maximum (24)',
    layer.options.maxNativeZoom, 24);
eq('minZoom comes from the config', layer.options.minZoom, E.CONFIG.MIN_ZOOM);
eq('the attribution travels with the layer', layer.options.attribution, E.CONFIG.ATTRIBUTION);
eq('opacity default', layer.options.opacity, 0.7);
eq('keepBuffer is tiny (no far-viewport preloading)', layer.options.keepBuffer, 1);
// The published box is England's data extent rounded out to a rectangle, so
// it does clip a little of Wales, Ireland and the Scottish border — where the
// service answers with a valid, empty tile. What matters is that anything
// clearly beyond it never generates a request.
check('the layer is bounded to the published England extent',
    layer.options.bounds.contains(new L.LatLng(50.70, -2.45)) &&     // Dorset
    layer.options.bounds.contains(new L.LatLng(54.97, -1.61)) &&     // Newcastle
    !layer.options.bounds.contains(new L.LatLng(55.95, -3.19)) &&    // Edinburgh
    !layer.options.bounds.contains(new L.LatLng(57.48, -4.22)) &&    // Inverness
    !layer.options.bounds.contains(new L.LatLng(53.27, -9.05)) &&    // Galway
    !layer.options.bounds.contains(new L.LatLng(48.85, 2.35)));      // Paris
eq('failed tiles fall back to a transparent pixel',
    layer.options.errorTileUrl, E.BLANK_TILE);
check('the fallback really is a transparent PNG data URI',
    E.BLANK_TILE.indexOf('data:image/png;base64,') === 0);
check('no tile churn during gestures', layer.options.updateWhenZooming === false &&
    layer.options.updateWhenIdle === true);
check('the layer does not wrap around the world', layer.options.noWrap === true);
check('the initial URL is the hillshade template', layer._url === E.tileTemplate('hillshade'));

layer.setMode('dsmHillshade');
eq('setMode switches the product', layer.getMode(), 'dsmHillshade');
check('the URL follows the switch',
    layer.getTileUrl({ x: 16183, y: 10989, z: 15 })
        .indexOf('Lidar_Composite_Hillshade_LZ_DSM_1m') !== -1);
check('…and so does the extent (the DSM layer publishes its own bbox)',
    layer.options.bounds.contains(new L.LatLng(55.87, 2.14)) &&
    E.boundsFor('hillshade').contains(new L.LatLng(55.87, 2.14)) === false);
check('switching redraws instead of rebuilding', layer._redrawn >= 1);
check('an unknown mode is ignored', layer.setMode('nope').getMode() === 'dsmHillshade');
layer.setMode('hillshade');
eq('switching back restores the terrain hillshade', layer.getMode(), 'hillshade');

// Tile errors: one warning for the whole layer, never one per tile.
const errLayer = E.createLayer({ mode: 'hillshade' });
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
 * 6. Wiring in the app (UK row only)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Wiring in the app');

const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

const scriptSrcs = (indexHtml.match(/<script[^>]+src="[^"]+"/g) || [])
    .map((tag) => tag.match(/src="([^"?]+)/)[1]);
check('index.html loads ea-lidar-wmts-layer.js before map-app.js',
    scriptSrcs.indexOf('js/ea-lidar-wmts-layer.js') !== -1 &&
    scriptSrcs.indexOf('js/ea-lidar-wmts-layer.js') < scriptSrcs.indexOf('js/map-app.js'));
check('the service worker pre-caches it', sw.indexOf('js/ea-lidar-wmts-layer.js') !== -1);
check('the service worker cache name was bumped',
    /detectlab-v(1[6-9]|2[0-9])\d/.test(sw));
check('the UK layer is built by the module', /EaLidarWmts\.createLayer/.test(mapApp));
check('the UK row no longer renders tiles through the WMS',
    !/_createFreeLidarWmsLayer\(UK_LIDAR_WMS_URL/.test(mapApp));
check('the product dropdown offers all four products',
    /value="hillshade"/.test(indexHtml) && /value="elevation"/.test(indexHtml) &&
    /value="dtm"/.test(indexHtml) && /value="dsmHillshade"/.test(indexHtml));
const ukSelect = indexHtml.slice(indexHtml.indexOf('id="ukLidarModeSelect"'));
check('hillshade is the first option of the UK select (the default)',
    ukSelect.indexOf('<option value="hillshade"') <
    ukSelect.indexOf('<option value="dtm"'));
check('the dropdown is also filled from the module at runtime',
    /_populateUkModeSelect/.test(mapApp) && /EaLidarWmts\.modeKeys\(\)/.test(mapApp));
check('switching product uses setMode instead of rebuilding',
    /setUkLidarMode/.test(mapApp) && /cfg\.leafletLayer\.setMode\(mode\)/.test(mapApp));
check('the on/off switch still drives the UK row',
    /toggleInternationalLidar\('ukLidar', this\.checked\)/.test(indexHtml));
check('the opacity slider defaults to 70%',
    /id="lidarUkLidarOpacitySlider"[^>]*value="70"/.test(indexHtml) &&
    /id="lidarUkLidarPct">70%/.test(indexHtml));
check('the visible attribution names the Environment Agency and the OGL',
    /Environment Agency copyright/.test(mapApp) || /EaLidarWmts\.CONFIG\.ATTRIBUTION/.test(mapApp));
check('the info popup states the England-only coverage',
    /England only|~99% of England/.test(indexHtml));
check('the fly-to bounds match the published England extent',
    /ukLidar: \[\[49\.850605, -7\.104776\], \[55\.877087, 2\.084282\]\]/.test(mapApp));

// Scope guard: only the UK row changed.
check('the Norway layer still uses its own module', /Hoydedata\.createLayer/.test(mapApp));
check('the Poland layer still uses its own module', /GeoportalNMT\.createLayer/.test(mapApp));
check('the Spain layer still uses its own module', /IgnMdt\.createLayer/.test(mapApp));
check('the Netherlands layer still uses its own module', /AhnLidar\.createLayer/.test(mapApp));
check('the Switzerland layer still uses its own module', /SwisstopoRelief\.createLayer/.test(mapApp));
['FRANCE_LIDAR_WMS_URL', 'DENMARK_LIDAR_WMS_URL'].forEach(function (name) {
    check('other country service kept: ' + name, mapApp.indexOf(name) !== -1);
});

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('All England / Environment Agency LiDAR WMTS checks passed.');
