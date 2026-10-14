/*
 * test-netherlands-ahn.js
 * ──────────────────────────────────────────────────────────────────────────
 * Netherlands LiDAR layer — AHN relief from the Esri Nederland ArcGIS
 * ImageServers.
 *
 * The two bugs this pins:
 *   1. the old builder hit `…/ImageServer?f=image&bbox=…` without the
 *      /exportImage operation. Verified live: that answers HTTP 200 with
 *      content-type text/html, which an <img> renders as nothing — the row
 *      was permanently blank;
 *   2. it used AHN6, whose mosaic is only partly flown (identify returned
 *      NoData in Limburg while AHN4 returned 167 m), so even a corrected URL
 *      would show holes. AHN4 is now the default.
 *
 * Run:  node test-netherlands-ahn.js
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

/* ── A faithful-enough Leaflet 1.x stub ─────────────────────────────────── */
const R = 6378137;
const HALF = Math.PI * R;           // 20037508.342789244

function makeLeaflet() {
    function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
    function Point(x, y) { this.x = x; this.y = y; }
    Point.prototype.multiplyBy = function (n) { return new Point(this.x * n, this.y * n); };
    Point.prototype.add = function (p) { return new Point(this.x + p[0], this.y + p[1]); };

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

    const CRS = {
        EPSG3857: {
            project: function (ll) {
                return new Point(R * ll.lng * Math.PI / 180,
                    R * Math.log(Math.tan(Math.PI / 4 + ll.lat * Math.PI / 360)));
            },
            unproject: function (p) {
                return new LatLng((2 * Math.atan(Math.exp(p.y / R)) - Math.PI / 2) * 180 / Math.PI,
                    p.x / R * 180 / Math.PI);
            },
            scale: function (z) { return 256 * Math.pow(2, z); },
            pointToLatLng: function (point, z) {
                const scale = this.scale(z);
                return this.unproject(new Point((point.x / scale - 0.5) * 2 * HALF,
                    (0.5 - point.y / scale) * 2 * HALF));
            }
        }
    };

    const L = {
        LatLng: LatLng,
        Point: Point,
        CRS: CRS,
        latLng: function (a, b) { return new LatLng(a, b); },
        latLngBounds: function (a, b) {
            if (Array.isArray(a) && !b) return new LatLngBounds(a[0], a[1]);
            if (a instanceof LatLngBounds) return a;
            return new LatLngBounds(a, b);
        },
        point: function (x, y) { return new Point(x, y); },
        setOptions: function (obj, options) {
            obj.options = Object.assign({}, obj.options, options || {});
            return obj.options;
        },
        DomUtil: {
            create: function (tag, className) {
                return { tagName: tag, className: className, style: {}, setAttribute: function () {} };
            }
        },
        Util: {
            getParamString: function (obj, existing) {
                const parts = [];
                for (const k in obj) parts.push(k + '=' + encodeURIComponent(obj[k]));
                return ((existing && existing.indexOf('?') !== -1) ? '&' : '?') + parts.join('&');
            }
        },
        popup: function () {
            const p = {
                setLatLng: function () { return p; },
                setContent: function (c) { p.content = c; return p; },
                openOn: function () { return p; }
            };
            return p;
        }
    };

    // Minimal GridLayer with the real _tileCoordsToBounds semantics.
    function GridLayer() {}
    GridLayer.prototype.options = {};
    GridLayer.prototype.getTileSize = function () {
        const s = this.options.tileSize || 256;
        return new Point(s, s);
    };
    GridLayer.prototype._tileCoordsToBounds = function (coords) {
        const size = this.getTileSize().x;
        const nw = CRS.EPSG3857.pointToLatLng(new Point(coords.x * size, coords.y * size), coords.z);
        const se = CRS.EPSG3857.pointToLatLng(new Point((coords.x + 1) * size, (coords.y + 1) * size), coords.z);
        return new LatLngBounds(nw, se);
    };
    GridLayer.prototype.onAdd = function () {};
    GridLayer.prototype.redraw = function () { this._redrawn = (this._redrawn || 0) + 1; return this; };
    GridLayer.extend = function (proto) {
        function Child(options) { if (this.initialize) this.initialize(options); }
        Child.prototype = Object.create(GridLayer.prototype);
        Object.assign(Child.prototype, proto);
        Child.prototype.options = Object.assign({}, GridLayer.prototype.options, proto.options || {});
        Child.prototype.constructor = Child;
        return Child;
    };
    L.GridLayer = GridLayer;
    return L;
}

function loadModule(fetchImpl) {
    const L = makeLeaflet();
    const sandbox = {
        console: {
            log: () => {},
            warn: (...a) => sandbox.__warnings.push(a.join(' ')),
            error: (...a) => sandbox.__warnings.push(a.join(' '))
        },
        L: L,
        fetch: fetchImpl || (() => Promise.reject(new Error('no network in tests'))),
        Promise: Promise,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        AbortController: typeof AbortController === 'function' ? AbortController : undefined,
        __warnings: []
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/ahn-layer.js'), 'utf8'),
        sandbox, { filename: 'ahn-layer.js' });
    return { A: sandbox.AhnLidar, L: L, sandbox: sandbox };
}

const { A, L, sandbox } = loadModule();
const moduleSource = fs.readFileSync(path.join(__dirname, 'js/ahn-layer.js'), 'utf8');
const executableSource = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Security / transport
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Security / transport constraints');

const tileUrl = A.exportImageUrl('dtm', [543239.115, 6865481.657, 545465.505, 6867304.687], 256);
check('the module never references a token', !/token/i.test(executableSource));
check('no API key or secret is embedded',
    !/api[_-]?key|secret|password/i.test(executableSource));
check('every service URL is https',
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).length === 0,
    (executableSource.match(/http:\/\/[^\s'"]+/g) || []).join(' '));
check('a built tile URL is https', tileUrl.indexOf('https://') === 0, tileUrl);
check('a built tile URL carries no token or key', !/token|[?&]key=/i.test(tileUrl));

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The bug: the /exportImage operation must be in the URL
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] The /exportImage operation');

check('tile requests go to /ImageServer/exportImage',
    tileUrl.indexOf('/ImageServer/exportImage?') !== -1, tileUrl);
check('never to the ImageServer root (200 text/html → blank tile)',
    !/\/ImageServer\?f=image/.test(tileUrl));
check('identify requests go to /ImageServer/identify',
    A.identifyUrl('dtm', 1, 2).indexOf('/ImageServer/identify?') !== -1);
check('serviceUrl() itself still returns the bare service root',
    /\/AHN4_DTM_50cm\/ImageServer$/.test(A.serviceUrl('dtm')), A.serviceUrl('dtm'));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. Configuration — only services and raster functions that exist
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] Configuration block');

eq('the host is the public AHN ArcGIS folder', A.CONFIG.HOST,
    'https://ahn.arcgisonline.nl/arcgis/rest/services/Hoogtebestand');
eq('the default product is the AHN4 terrain hillshade', A.CONFIG.DEFAULT_MODE, 'dtm');
eq('…because AHN4 is the only complete national coverage',
    A.MODES.dtm.service, 'AHN4_DTM_50cm');
eq('the colour relief uses the same AHN4 DTM', A.MODES.relief.service, 'AHN4_DTM_50cm');
eq('the surface model is the AHN4 DSM', A.MODES.dsm.service, 'AHN4_DSM_50cm');
eq('AHN5 is offered as the newer, partial coverage', A.MODES.ahn5.service, 'AHN5_DTM_50cm');
eq('AHN6 stays available as the newest, partial coverage',
    A.MODES.ahn6.service, 'AHN6_DTM_50cm');
eq('the hillshade rendering rule is the published one',
    A.MODES.dtm.renderingRule, 'AHN - Hillshade (Multidirectionaal)');
eq('the colour relief rendering rule is the published one',
    A.MODES.relief.renderingRule, 'AHN - Shaded Relief');
eq('the slope rendering rule is the published one',
    A.MODES.slope.renderingRule, 'AHN - Slope (kleur)');
check('no invented raster function slipped in',
    A.modeKeys().every((k) => /^AHN - /.test(A.MODES[k].renderingRule)));
eq('default opacity', A.CONFIG.OPACITY, 0.8);
eq('maxNativeZoom suits a 0.5 m grid', A.CONFIG.MAX_NATIVE_ZOOM, 19);
check('above it the library upscales', A.CONFIG.MAX_ZOOM > A.CONFIG.MAX_NATIVE_ZOOM);
check('minZoom avoids half-country requests', A.CONFIG.MIN_ZOOM >= 7);
check('the tile size is far inside the service limit (maxImageWidth 15000)',
    A.CONFIG.TILE_SIZE <= 15000);
check('keepBuffer stays small on a public server', A.CONFIG.KEEP_BUFFER <= 1);
check('a caching-proxy hook exists', 'PROXY_BASE' in A.CONFIG);
check('the attribution credits AHN and Esri Nederland under CC BY 4.0',
    /AHN/.test(A.CONFIG.ATTRIBUTION) && /Esri Nederland/.test(A.CONFIG.ATTRIBUTION) &&
    /CC BY 4\.0/.test(A.CONFIG.ATTRIBUTION), A.CONFIG.ATTRIBUTION);
const b = A.CONFIG.BOUNDS;
check('the bounds cover the Netherlands', b[0][0] <= 50.7 && b[0][1] <= 3.3 &&
    b[1][0] >= 53.6 && b[1][1] >= 7.2, JSON.stringify(b));
check('and nothing much beyond it', b[0][0] > 49.5 && b[1][0] < 54.5 && b[1][1] < 8);

/* ══════════════════════════════════════════════════════════════════════════
 * 4. exportImage parameters
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] exportImage request format');

check('f=image', tileUrl.indexOf('f=image') !== -1);
check('format=png32 keeps a real alpha channel', tileUrl.indexOf('format=png32') !== -1);
check('bbox is xmin,ymin,xmax,ymax in metres',
    tileUrl.indexOf('bbox=543239.115,6865481.657,545465.505,6867304.687') !== -1, tileUrl);
check('bboxSR and imageSR are 3857 (the service reprojects from RD New)',
    tileUrl.indexOf('bboxSR=3857') !== -1 && tileUrl.indexOf('imageSR=3857') !== -1);
check('size matches the tile', tileUrl.indexOf('size=256,256') !== -1);
check('transparent=true', tileUrl.indexOf('transparent=true') !== -1);
check('adjustAspectRatio=false keeps the tile square',
    tileUrl.indexOf('adjustAspectRatio=false') !== -1);
check('the rendering rule is sent as encoded JSON',
    tileUrl.indexOf('renderingRule=' + encodeURIComponent(
        JSON.stringify({ rasterFunction: 'AHN - Hillshade (Multidirectionaal)' }))) !== -1, tileUrl);
check('switching product only changes service and rendering rule',
    A.exportImageUrl('dsm', [1, 2, 3, 4], 256).indexOf('AHN4_DSM_50cm') !== -1 &&
    A.exportImageUrl('ahn6', [1, 2, 3, 4], 256).indexOf('AHN6_DTM_50cm') !== -1);
check('an unknown product falls back to the default',
    A.exportImageUrl('nope', [1, 2, 3, 4], 256).indexOf('AHN4_DTM_50cm') !== -1);

A.CONFIG.PROXY_BASE = 'https://ahn-cache.example.com/arcgis/rest/services/Hoogtebestand';
check('tiles honour the caching proxy when configured',
    A.exportImageUrl('dtm', [1, 2, 3, 4], 256)
        .indexOf('https://ahn-cache.example.com/arcgis/rest/services/Hoogtebestand/AHN4_DTM_50cm/ImageServer/exportImage?') === 0);
check('but identify still goes straight to the service',
    A.identifyUrl('dtm', 1, 2).indexOf('https://ahn.arcgisonline.nl/') === 0);
A.CONFIG.PROXY_BASE = '';

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Tile geometry — the relief must line up with the basemap
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] Tile geometry (EPSG:3857 XYZ grid)');

const layer = A.createLayer({ mode: 'dtm' });
layer._map = { options: { crs: L.CRS.EPSG3857 } };

// Amsterdam, 52.37 N 4.90 E → the z14 tile that contains it.
const AMS = { lat: 52.37, lng: 4.90 };
const z = 14;
const tx = Math.floor((AMS.lng + 180) / 360 * Math.pow(2, z));
const ty = Math.floor((1 - Math.log(Math.tan(AMS.lat * Math.PI / 180) +
    1 / Math.cos(AMS.lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
const span = (2 * HALF) / Math.pow(2, z);
const exp = { xmin: -HALF + tx * span, ymax: HALF - ty * span };
exp.xmax = exp.xmin + span;
exp.ymin = exp.ymax - span;

const got = decodeURIComponent(layer.tileUrl({ x: tx, y: ty, z: z }).match(/bbox=([^&]+)/)[1])
    .split(',').map(Number);
near('tile minx matches the standard XYZ grid', got[0], exp.xmin, 0.001);
near('tile miny matches the standard XYZ grid', got[1], exp.ymin, 0.001);
near('tile maxx matches the standard XYZ grid', got[2], exp.xmax, 0.001);
near('tile maxy matches the standard XYZ grid', got[3], exp.ymax, 0.001);
check('the tile is square (no aspect-ratio distortion)',
    Math.abs((got[2] - got[0]) - (got[3] - got[1])) < 0.001);
const amsMerc = L.CRS.EPSG3857.project(new L.LatLng(AMS.lat, AMS.lng));
check('the tile covers Amsterdam',
    got[0] < amsMerc.x && got[2] > amsMerc.x &&
    got[1] < amsMerc.y && got[3] > amsMerc.y,
    got.join(',') + ' vs ' + amsMerc.x + ',' + amsMerc.y);
check('the extent comes from Leaflet, not hand-rolled Mercator maths',
    /_tileCoordsToBounds/.test(moduleSource) && !/20037508/.test(executableSource));

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Layer behaviour
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Layer behaviour');

eq('maxNativeZoom reaches the module config', layer.options.maxNativeZoom, 19);
eq('minZoom reaches the module config', layer.options.minZoom, A.CONFIG.MIN_ZOOM);
eq('the attribution travels with the layer', layer.options.attribution, A.CONFIG.ATTRIBUTION);
eq('keepBuffer is tiny (no far-viewport preloading)', layer.options.keepBuffer, 1);
check('no tile churn during gestures', layer.options.updateWhenZooming === false &&
    layer.options.updateWhenIdle === true);
check('the layer is bounded to the Netherlands',
    layer.options.bounds.contains(new L.LatLng(52.37, 4.90)) &&
    !layer.options.bounds.contains(new L.LatLng(48.85, 2.35)));

layer.setMode('slope');
eq('setMode switches the product', layer.getMode(), 'slope');
check('the URL follows the switch',
    layer.tileUrl({ x: tx, y: ty, z: z }).indexOf(encodeURIComponent('AHN - Slope (kleur)')) !== -1);
check('an unknown mode is ignored', layer.setMode('nope').getMode() === 'slope');
layer.setMode('dtm');

eq('setOpacity updates the option', layer.setOpacity(0.55).options.opacity, 0.55);
layer.setOpacity(A.CONFIG.OPACITY);

// A failing tile must degrade to a transparent pixel, report success to
// Leaflet, and warn exactly once.
const errLayer = A.createLayer({ mode: 'dtm' });
errLayer._map = { options: { crs: L.CRS.EPSG3857 } };
const before = sandbox.__warnings.length;
let reported = [];
for (let i = 0; i < 3; i++) {
    const tile = errLayer.createTile({ x: tx, y: ty, z: z },
        (err, el) => reported.push({ err: err, el: el }));
    tile.onerror();
}
eq('a broken tile reports no error to Leaflet (no retry storm)',
    reported.filter((r) => r.err !== null).length, 0);
eq('…and is swapped for the transparent pixel', reported[0].el.src, A.BLANK_TILE);
eq('tile errors are logged once, not once per tile',
    sandbox.__warnings.length - before, 1);

const okTile = errLayer.createTile({ x: tx, y: ty, z: z }, () => {});
check('a healthy tile points at exportImage',
    okTile.src.indexOf('/ImageServer/exportImage?') !== -1);

/* ══════════════════════════════════════════════════════════════════════════
 * 7. identify() — click-to-read elevation
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[7] identify()');

const calls = [];
function fakeFetch(payload) {
    return function (url) {
        calls.push(url);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    };
}

const withValue = loadModule(fakeFetch({ value: '31.649' }));
const withNoData = loadModule(fakeFetch({ value: 'NoData' }));

Promise.all([
    withValue.A.identify(new withValue.L.LatLng(52.10, 5.80), 'dtm'),
    withNoData.A.identify(new withNoData.L.LatLng(50.80, 5.95), 'ahn6')
]).then(function (results) {
    near('identify parses the pixel value (Veluwe, AHN4)', results[0].elevation, 31.649, 1e-6);
    eq('…and reports the service it came from', results[0].service, 'AHN4_DTM_50cm');
    eq('"NoData" becomes null instead of NaN', results[1].elevation, null);
    eq('the popup text is human-readable',
        withValue.A.formatIdentify(results[0]), 'Elevation: 31.6 m NAP');
    eq('…and honest when there is no data',
        withNoData.A.formatIdentify(results[1]), 'No AHN data here');
    check('identify asks the right endpoint',
        calls[0].indexOf('/AHN4_DTM_50cm/ImageServer/identify?') !== -1 &&
        calls[1].indexOf('/AHN6_DTM_50cm/ImageServer/identify?') !== -1, calls.join(' '));
    check('with the point in EPSG:3857',
        calls[0].indexOf(encodeURIComponent('"wkid":3857')) !== -1);
    finish();
}).catch(function (error) {
    check('identify() resolves', false, error.message);
    finish();
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. Wiring in the app (Netherlands row only)
 * ═════════════════════════════════════════════════════════════════════════ */
function finish() {
    console.log('\n[8] Wiring in the app');

    const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');

    const scriptSrcs = (indexHtml.match(/<script[^>]+src="[^"]+"/g) || [])
        .map((tag) => tag.match(/src="([^"?]+)/)[1]);
    check('index.html loads ahn-layer.js before map-app.js',
        scriptSrcs.indexOf('js/ahn-layer.js') !== -1 &&
        scriptSrcs.indexOf('js/ahn-layer.js') < scriptSrcs.indexOf('js/map-app.js'));
    check('the service worker pre-caches it', sw.indexOf('js/ahn-layer.js') !== -1);
    check('the service worker cache name was bumped',
        /detectlab-v15[8-9]|detectlab-v(1[6-9]|2[0-9])\d/.test(sw));
    check('the Netherlands layer is built by the module', /AhnLidar\.createLayer/.test(mapApp));
    check('the product dropdown is in the panel',
        /id="netherlandsLidarModeSelect"/.test(indexHtml) &&
        /value="ahn6"/.test(indexHtml) && /value="slope"/.test(indexHtml));
    check('the dropdown is also filled from the module at runtime',
        /_populateNetherlandsModeSelect/.test(mapApp) && /AhnLidar\.modeKeys\(\)/.test(mapApp));
    check('switching product uses setMode instead of rebuilding',
        /setNetherlandsLidarMode/.test(mapApp));
    check('the on/off switch still drives the Netherlands row',
        /toggleInternationalLidar\('nlAhn', this\.checked\)/.test(indexHtml));
    check('the opacity slider is still wired',
        /id="lidarNlAhnOpacitySlider"[^>]*value="80"/.test(indexHtml));
    check('the generic ArcGIS builder also appends /exportImage now',
        /\/exportImage'/.test(mapApp) && !/imageServerUrl \+ L\.Util\.getParamString/.test(mapApp));
    check('the stale CC0/Rijkswaterstaat attribution is gone',
        !/AHN6 DSM 50 cm — Rijkswaterstaat/.test(mapApp) &&
        !/AHN6 DSM 50 cm ImageServer/.test(indexHtml));

    // Scope guard: only the Netherlands row changed.
    check('the Norway layer still uses its own module', /Hoydedata\.createLayer/.test(mapApp));
    check('the Poland layer still uses its own module', /GeoportalNMT\.createLayer/.test(mapApp));
    check('the Spain layer still uses its own module', /IgnMdt\.createLayer/.test(mapApp));
    ['SPAIN_LIDAR_WMS_URL', 'SWITZERLAND_LIDAR_WMS_URL', 'UK_LIDAR_WMS_URL',
        'FRANCE_LIDAR_WMS_URL', 'DENMARK_LIDAR_WMS_URL'].forEach(function (name) {
        check('other country service kept: ' + name, mapApp.indexOf(name) !== -1);
    });

    console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
    if (failures > 0) {
        console.error(failures + ' FAILED');
        process.exit(1);
    }
    console.log('All Netherlands AHN relief checks passed.');
}
