/*
 * test-denmark-dataforsyningen-dhm.js
 * ──────────────────────────────────────────────────────────────────────────
 * Denmark LiDAR layer — Danmarks Højdemodel hillshade from Dataforsyningen's
 * WMTS (dhm_terraen_skyggekort_DAF / dhm_overflade_skyggekort_DAF, the View1
 * grid in EPSG:25832).
 *
 * What this pins:
 *   • NO TOKEN is present anywhere in the repository, and the browser gets
 *     its tiles from this site's own proxy path, not from the Danish service;
 *   • the View1 grid constants reproduce the live GetCapabilities exactly —
 *     all 14 resolutions and all 14 MatrixWidth×MatrixHeight pairs;
 *   • the EPSG:25832 projection in the module is the right one: it round
 *     trips exactly and it reproduces the service's own published
 *     WGS84BoundingBox from the View1 extent;
 *   • the brief's two example tiles decode to places inside Denmark;
 *   • the request is a WMTS 1.0.0 KVP GetTile with style=default, a bare
 *     integer TileMatrix and image/jpeg;
 *   • THE REPROJECTION IS CORRECT: §9 drives the real createTile() through a
 *     recording canvas and checks that known Danish coordinates land on the
 *     right destination pixel to a fraction of a pixel;
 *   • the layer is clipped to the published Danish extent and never asks for
 *     a tile outside the matrix;
 *   • a missing token produces one non-blocking notice, never console spam
 *     and never a broken-image icon;
 *   • only the Denmark row of the app changed.
 *
 * Run:  node test-denmark-dataforsyningen-dhm.js
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

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(__dirname, f));

/* ══════════════════════════════════════════════════════════════════════════
 * Stubs: just enough Leaflet 1.x, DOM canvas and Image to run the real layer
 * ═════════════════════════════════════════════════════════════════════════ */

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

    const CRS = {
        EPSG3857: {
            code: 'EPSG:3857',
            project: (ll) => new Point(R * ll.lng * Math.PI / 180,
                R * Math.log(Math.tan(Math.PI / 4 + ll.lat * Math.PI / 360))),
            unproject: (p) => new LatLng((2 * Math.atan(Math.exp(p.y / R)) - Math.PI / 2) * 180 / Math.PI,
                p.x / R * 180 / Math.PI)
        }
    };

    // L.GridLayer — the base class the Denmark layer now extends.
    function GridLayer() {}
    GridLayer.prototype.options = {};
    GridLayer.prototype.initialize = function (options) {
        this.options = Object.assign({}, this.options, options || {});
    };
    GridLayer.prototype.getTileSize = function () {
        const s = this.options.tileSize || 256;
        return new Point(s, s);
    };
    GridLayer.prototype.onAdd = function () { this._added = true; };
    GridLayer.prototype.onRemove = function () { this._added = false; };
    GridLayer.prototype.redraw = function () { this._redrawn = (this._redrawn || 0) + 1; return this; };
    GridLayer.prototype.on = function (ev, fn, ctx) {
        (this._events = this._events || {})[ev] = fn.bind(ctx || this);
        return this;
    };
    GridLayer.prototype.off = function (ev) { if (this._events) delete this._events[ev]; return this; };
    GridLayer.prototype.fire = function (ev, data) {
        if (this._events && this._events[ev]) this._events[ev](data || {});
        return this;
    };
    GridLayer.extend = function (proto) {
        function Child(options) { if (this.initialize) this.initialize(options); }
        Child.prototype = Object.create(GridLayer.prototype);
        Object.assign(Child.prototype, proto);
        Child.prototype.options = Object.assign({}, GridLayer.prototype.options, proto.options || {});
        Child.prototype.constructor = Child;
        return Child;
    };

    return {
        LatLng, Point, CRS, GridLayer,
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

/** A 2-D context that records exactly what the warp draws. */
function makeRecordingContext(record) {
    let rect = null;
    let transform = null;
    return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
        save() {},
        beginPath() {},
        rect(x, y, w, h) { rect = [x, y, w, h]; },
        clip() {},
        setTransform(a, b, c, d, e, f) { transform = [a, b, c, d, e, f]; },
        drawImage(img, x, y) {
            if (transform) record.cells.push({ rect, transform });
            else record.mosaic.push({ img, x, y });
        },
        restore() { transform = null; }
    };
}

function makeDom(record) {
    return {
        body: null,
        createElement(tag) {
            if (tag !== 'canvas') return { style: {}, setAttribute() {}, appendChild() {} };
            const canvas = {
                width: 0, height: 0, style: {},
                setAttribute() {},
                getContext() {
                    // The first canvas created per render is the destination,
                    // the second is the source mosaic.
                    return canvas.__isMosaic
                        ? { drawImage(img, x, y) { record.mosaic.push({ img, x, y }); } }
                        : makeRecordingContext(record);
                }
            };
            record.canvases.push(canvas);
            if (record.canvases.length > 1) canvas.__isMosaic = true;
            return canvas;
        }
    };
}

/** An Image that always "loads", recording the URL it was given. */
function makeImage(record, failAll) {
    return function Image() {
        const img = {};
        Object.defineProperty(img, 'src', {
            set(value) {
                record.urls.push(value);
                setImmediate(() => (failAll ? img.onerror && img.onerror()
                    : img.onload && img.onload()));
            },
            get() { return undefined; }
        });
        return img;
    };
}

function loadModule(windowExtras, record) {
    const L = makeLeaflet();
    const sandbox = {
        L,
        console: {
            log: () => {},
            warn: (...a) => sandbox.__warnings.push(a.join(' ')),
            error: (...a) => sandbox.__warnings.push(a.join(' '))
        },
        __warnings: [],
        setTimeout: () => 0,
        setImmediate,
        Promise,
        Map,
        fetch: undefined,
        document: record ? makeDom(record) : undefined,
        Image: record ? makeImage(record, false) : undefined
    };
    Object.assign(sandbox, windowExtras || {});
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('js/dataforsyningen-dhm-layer.js'), sandbox,
        { filename: 'dataforsyningen-dhm-layer.js' });
    return { D: sandbox.DataforsyningenDHM, L, sandbox };
}

const { D } = loadModule();
const moduleSource = read('js/dataforsyningen-dhm-layer.js');
const executableSource = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Token hygiene — nothing secret may live in the repository
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Token hygiene');

const repoFiles = ['js/dataforsyningen-dhm-layer.js', 'js/map-app.js', 'index.html',
    'sw.js', 'backend/src/routes/geoProxy.js', 'netlify/functions/dk-dhm.mjs',
    'netlify.toml', 'tools/denmark-lidar-demo.html',
    'DENMARK_LIDAR_DATAFORSYNINGEN.md', 'test-denmark-dataforsyningen-dhm.js']
    .filter(exists);
// A Dataforsyningen token is 32 hexadecimal characters.
const TOKEN_SHAPE = /\b[0-9a-f]{32}\b/;
repoFiles.forEach(function (file) {
    // The public Cloudflare R2 bucket host (pub-<32 hex>.r2.dev) is not a
    // secret and predates this work, so it is excluded from the scan.
    const body = read(file).replace(/pub-[0-9a-f]{32}\.r2\.dev/g, 'pub-R2BUCKET.r2.dev');
    check('no 32-hex token literal in ' + file, !TOKEN_SHAPE.test(body),
        (body.match(TOKEN_SHAPE) || [''])[0]);
    check('no token=<value> literal in ' + file,
        !/[?&]token=(?!\{|'|"|\s|$|YOUR_TOKEN|&|<)[A-Za-z0-9]/.test(body));
});
check('the README only ever shows YOUR_TOKEN',
    !exists('DENMARK_LIDAR_DATAFORSYNINGEN.md') ||
    !/token=[0-9a-f]{8}/i.test(read('DENMARK_LIDAR_DATAFORSYNINGEN.md')));
check('the backend reads the token from the environment',
    /process\.env\.DATAFORSYNINGEN_TOKEN/.test(read('backend/src/routes/geoProxy.js')));
check('the Netlify function reads the token from the environment',
    /process\.env\.DATAFORSYNINGEN_TOKEN/.test(read('netlify/functions/dk-dhm.mjs')));
check('.env files are gitignored',
    /^\.env$/m.test(read('.gitignore')) && /backend\/\.env/.test(read('.gitignore')));
check('the token is not part of the CONFIG block',
    !('TOKEN' in D.CONFIG) && !/TOKEN\s*:/.test(executableSource.split('end of configuration')[0]));
check('.env.example ships a placeholder, not a real token',
    /DATAFORSYNINGEN_TOKEN=YOUR_TOKEN/.test(read('backend/.env.example')));

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The View1 grid reproduces the live GetCapabilities
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] View1 grid vs GetCapabilities');

eq('CRS is EPSG:25832 (ETRS89 / UTM 32N)', D.CONFIG.SOURCE_EPSG, 25832);
eq('TopLeftCorner easting', D.CONFIG.GRID_ORIGIN_X, 120000);
eq('TopLeftCorner northing', D.CONFIG.GRID_ORIGIN_Y, 6500000);
check('TileMatrixSet extent 120000 5900000 → 1000000 6500000',
    JSON.stringify(D.CONFIG.GRID_EXTENT) === JSON.stringify([120000, 5900000, 1000000, 6500000]));
eq('tiles are 256 px', D.CONFIG.SOURCE_TILE_SIZE, 256);
eq('14 levels (0…13)', D.CONFIG.SOURCE_LEVELS, 14);
eq('TileMatrixSet identifier', D.CONFIG.TILEMATRIXSET, 'View1');

// ScaleDenominator × 0.00028 for each of the 14 TileMatrix elements.
const SCALE_DENOMINATORS = [
    5851428.571428571, 2925714.285714286, 1462857.142857143, 731428.5714285714,
    365714.2857142857, 182857.1428571429, 91428.57142857143, 45714.28571428571,
    22857.14285714286, 11428.57142857143, 5714.285714285714, 2857.142857142857,
    1428.571428571429, 714.2857142857143
];
let ladderOk = true;
SCALE_DENOMINATORS.forEach((scale, level) => {
    if (Math.abs(D.GRID.resolution(level) - scale * 0.00028) > 1e-9) ladderOk = false;
});
check('all 14 resolutions equal ScaleDenominator × 0.00028 (1638.4 → 0.2 m/px)', ladderOk);
near('level 0 is 1638.4 m/px', D.GRID.resolution(0), 1638.4, 1e-9);
near('level 13 is 0.2 m/px', D.GRID.resolution(13), 0.2, 1e-9);

// MatrixWidth × MatrixHeight, verbatim from the capabilities.
const MATRIX = [[3, 2], [5, 3], [9, 6], [17, 12], [34, 23], [68, 46], [135, 92],
    [269, 184], [538, 367], [1075, 733], [2149, 1465], [4297, 2930],
    [8594, 5860], [17188, 11719]];
let matrixOk = true;
MATRIX.forEach((m, level) => {
    const got = D.GRID.matrixSize(level);
    if (got[0] !== m[0] || got[1] !== m[1]) {
        matrixOk = false;
        console.error('      level ' + level + ': expected ' + m + ' got ' + got);
    }
});
check('all 14 MatrixWidth × MatrixHeight pairs reproduce exactly', matrixOk);
check('tiles outside the matrix are rejected',
    !D.GRID.isValidTile(13, 17188, 0) && !D.GRID.isValidTile(13, 0, 11719) &&
    !D.GRID.isValidTile(14, 0, 0) && !D.GRID.isValidTile(0, -1, 0));
check('tiles inside the matrix are accepted',
    D.GRID.isValidTile(13, 17187, 11718) && D.GRID.isValidTile(0, 0, 0));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The EPSG:25832 projection is the right one
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] ETRS89 / UTM 32N projection');

let worstRoundTrip = 0;
[[54.5, 8.0], [55.5, 10.0], [56.5, 12.0], [57.5, 15.0], [55.676, 12.568]].forEach(([lat, lon]) => {
    const en = D.UTM.forward(lat, lon);
    const back = D.UTM.inverse(en[0], en[1]);
    worstRoundTrip = Math.max(worstRoundTrip,
        Math.abs(back[0] - lat) * 111320, Math.abs(back[1] - lon) * 62000);
});
check('forward/inverse round trip is exact over Denmark (< 1 mm)',
    worstRoundTrip < 0.001, worstRoundTrip + ' m');

// The central meridian of zone 32 must come back as the false easting.
near('9°E maps to the 500 000 m false easting', D.UTM.forward(0, 9)[0], 500000, 1e-6);
near('the equator maps to northing 0', D.UTM.forward(0, 9)[1], 0, 1e-6);

// AUTHORITATIVE: transforming the View1 extent must reproduce the service's
// own <ows:WGS84BoundingBox> 2.478420 53.015000 → 17.557800 58.640300.
(function () {
    const e = D.CONFIG.GRID_EXTENT;
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (let i = 0; i <= 200; i++) {
        const x = e[0] + (e[2] - e[0]) * i / 200;
        const y = e[1] + (e[3] - e[1]) * i / 200;
        [D.UTM.inverse(x, e[1]), D.UTM.inverse(x, e[3]),
         D.UTM.inverse(e[0], y), D.UTM.inverse(e[2], y)].forEach(([la, lo]) => {
            minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
            minLon = Math.min(minLon, lo); maxLon = Math.max(maxLon, lo);
        });
    }
    near('View1 extent → published WGS84 west  2.47842', minLon, 2.47842, 0.0001);
    near('View1 extent → published WGS84 south 53.015', minLat, 53.015, 0.0001);
    near('View1 extent → published WGS84 east  17.5578', maxLon, 17.5578, 0.0001);
    near('View1 extent → published WGS84 north 58.6403', maxLat, 58.6403, 0.0001);
}());

/* ══════════════════════════════════════════════════════════════════════════
 * 4. The brief's two example tiles land inside Denmark
 * ═════════════════════════════════════════════════════════════════════════ */
console.log("\n[4] The brief's example tiles");

const DENMARK = { south: 54.4, north: 57.9, west: 7.9, east: 15.7 };
[
    { z: 10, col: 1027, row: 620, lat: 56.3555, lon: 9.6613, where: 'central Jutland' },
    { z: 4, col: 15, row: 13, lat: 55.4604, lon: 9.4163, where: 'Kolding / Vejle' }
].forEach(function (t) {
    const label = 'TileMatrix=' + t.z + ' TileCol=' + t.col + ' TileRow=' + t.row;
    check(label + ' is a valid index in the ' + MATRIX[t.z].join('×') + ' matrix',
        D.GRID.isValidTile(t.z, t.col, t.row));

    const b = D.GRID.tileBounds(t.z, t.col, t.row);
    const centre = D.UTM.inverse((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
    near(label + ' centre latitude (' + t.where + ')', centre[0], t.lat, 0.001);
    near(label + ' centre longitude (' + t.where + ')', centre[1], t.lon, 0.001);
    check(label + ' is INSIDE Denmark',
        centre[0] > DENMARK.south && centre[0] < DENMARK.north &&
        centre[1] > DENMARK.west && centre[1] < DENMARK.east,
        centre.join(', '));

    // The trap the brief flagged: these are NOT XYZ indices.
    const ll = D.GRID.tileLatLngBounds(t.z, t.col, t.row);
    check(label + ' bbox is a square in EPSG:25832',
        Math.abs((b[2] - b[0]) - (b[3] - b[1])) < 1e-6 &&
        Math.abs((b[2] - b[0]) - 256 * D.GRID.resolution(t.z)) < 1e-6);
    check(label + ' geographic bbox brackets its centre',
        centre[0] > ll[0] && centre[0] < ll[2] && centre[1] > ll[1] && centre[1] < ll[3]);
});
check('level 10 column 1027 is beyond the XYZ range (0…1023) — proves View1 ≠ XYZ',
    1027 > Math.pow(2, 10) - 1);

/* ══════════════════════════════════════════════════════════════════════════
 * 5. GetTile URLs
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[5] WMTS GetTile URLs');

const proxied = D.tileUrl('terrain', 10, 1027, 620, '');
check('by default the browser talks to our own proxy',
    proxied.indexOf('/api/geo/dk-dhm?') === 0, proxied);
check('…and carries no token at all', proxied.indexOf('token') === -1);
check('service=WMTS', /[?&]service=WMTS(&|$)/.test(proxied));
check('request=GetTile', /[?&]request=GetTile(&|$)/.test(proxied));
check('version=1.0.0', /[?&]version=1\.0\.0(&|$)/.test(proxied));
check('layer=dhm_terraen_skyggekort', /[?&]layer=dhm_terraen_skyggekort(&|$)/.test(proxied));
check('style=default (what Dataforsyningen documents)', /[?&]style=default(&|$)/.test(proxied));
check('tilematrixset=View1', /[?&]tilematrixset=View1(&|$)/.test(proxied));
check('format=image/jpeg — the only format published',
    /[?&]format=image%2Fjpeg(&|$)/.test(proxied));
check('TileMatrix is a BARE INTEGER, not "View1:10"',
    /[?&]TileMatrix=10(&|$)/.test(proxied) && proxied.indexOf('TileMatrix=View1') === -1);
check('TileCol / TileRow are the View1 indices',
    /[?&]TileCol=1027(&|$)/.test(proxied) && /[?&]TileRow=620(&|$)/.test(proxied));
check('isProxied() is true when no client token is set', D.isProxied() === true);

const surface = D.tileUrl('surface', 4, 15, 13, '');
check('the surface product switches only the layer name',
    /[?&]layer=dhm_overflade_skyggekort(&|$)/.test(surface) &&
    surface.indexOf('/api/geo/dk-dhm?') === 0);

// Insecure direct mode (explicitly opted into by setting a token).
const direct = D.tileUrl('terrain', 4, 15, 13, 'YOUR_TOKEN');
check('direct mode hits the product\'s own endpoint',
    direct.indexOf('https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF?') === 0, direct);
check('direct mode appends the token (and only then)',
    /[&?]token=YOUR_TOKEN$/.test(direct));
const directSurface = D.tileUrl('surface', 4, 15, 13, 'YOUR_TOKEN');
check('direct mode uses the surface service for the surface product',
    directSurface.indexOf('https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF?') === 0);
eq('source() is the proxy path by default', D.source('terrain'), '/api/geo/dk-dhm');
eq('exactly two products are offered', D.modeKeys().join(','), 'terrain,surface');
check('no WMS GetMap request survives anywhere in the module',
    !/GetMap/i.test(executableSource) && !/request=GetMap/i.test(moduleSource.replace(/\/\*[\s\S]*?\*\//g, '')));

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Level selection
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Source level selection');

eq('1638.4 m/px → level 0', D.GRID.levelForResolution(1638.4), 0);
eq('1.6 m/px → level 10', D.GRID.levelForResolution(1.6), 10);
eq('0.2 m/px → level 13', D.GRID.levelForResolution(0.2), 13);
eq('anything finer than 0.2 m/px is clamped to level 13',
    D.GRID.levelForResolution(0.01), 13);
eq('anything coarser than 1638.4 m/px is clamped to level 0',
    D.GRID.levelForResolution(100000), 0);
check('every level choice stays inside 0…13', [0.05, 0.9, 7, 300, 9000]
    .every((r) => { const l = D.GRID.levelForResolution(r); return l >= 0 && l <= 13; }));

/* ══════════════════════════════════════════════════════════════════════════
 * 7. The affine inversion the warp depends on
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[7] Affine inversion');

(function () {
    const a = 1.7, b = 0.31, c = -0.22, d = 1.41, e = 12.5, f = -7.25;
    const t = D.invertAffine(a, b, c, d, e, f);
    let worst = 0;
    [[0, 0], [1, 0], [0, 1], [37.5, -12.25], [255, 255]].forEach(([dx, dy]) => {
        const sx = a * dx + c * dy + e, sy = b * dx + d * dy + f;
        worst = Math.max(worst,
            Math.abs(t[0] * sx + t[2] * sy + t[4] - dx),
            Math.abs(t[1] * sx + t[3] * sy + t[5] - dy));
    });
    check('invertAffine round trips to machine precision', worst < 1e-9, String(worst));
    check('a degenerate (zero-area) cell returns null',
        D.invertAffine(0, 0, 0, 0, 1, 1) === null);
}());

/* ══════════════════════════════════════════════════════════════════════════
 * 8. Layer configuration
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[8] Layer configuration');

const layer = D.createLayer();
eq('opacity defaults to 0.6', layer.options.opacity, 0.6);
eq('CONFIG.OPACITY is 0.6 (JPEG has no transparency)', D.CONFIG.OPACITY, 0.6);
eq('keepBuffer is 1 — a public agency server, so barely any preloading',
    layer.options.keepBuffer, 1);
check('no far-viewport preloading', layer.options.updateWhenIdle === true &&
    layer.options.updateWhenZooming === false);
eq('maxNativeZoom 19 — 0.2 m/px runs out just under z19', layer.options.maxNativeZoom, 19);
eq('minZoom 6', layer.options.minZoom, 6);
check('the layer is clipped to the published Danish extent',
    layer.options.bounds.contains({ lat: 55.676, lng: 12.568 }) &&       // Copenhagen
    layer.options.bounds.contains({ lat: 57.74, lng: 10.63 }) &&         // Skagen
    !layer.options.bounds.contains({ lat: 59.33, lng: 18.07 }) &&        // Stockholm
    !layer.options.bounds.contains({ lat: 53.55, lng: 9.99 }));          // Hamburg
check('BOUNDS are the WMS-published skyggekort extent',
    JSON.stringify(D.CONFIG.BOUNDS) === JSON.stringify([[54.4265, 7.99125], [57.7781, 15.5995]]));
check('attribution names Klimadatastyrelsen, DHM and CC BY 4.0',
    /Klimadatastyrelsen/.test(D.CONFIG.ATTRIBUTION) &&
    /Danmarks Højdemodel/.test(D.CONFIG.ATTRIBUTION) &&
    /CC BY 4\.0/.test(D.CONFIG.ATTRIBUTION));
eq('the 401/403 message is the one the brief asked for',
    D.CONFIG.AUTH_MESSAGE, 'Invalid or missing Dataforsyningen token');
// A deployment without the same-origin proxy (the live v161 shell had no
// /api/geo/dk-dhm Netlify function at all) answers 404 — the layer must say
// so instead of staying silently blank.
check('a 404 from the proxy names the real problem (route not deployed)',
    /\/api\/geo\/dk-dhm/.test(String(D.CONFIG.PROXY_MISSING_MESSAGE || '')));
check('the auth probe reports a missing proxy, in proxy mode only',
    /res\.status === 404 && !clientToken\(\)/.test(read('js/dataforsyningen-dhm-layer.js')) &&
    /showAuthNotice\(CONFIG\.PROXY_MISSING_MESSAGE\)/.test(read('js/dataforsyningen-dhm-layer.js')));
check('a transparent 1×1 PNG is available as the no-data fallback',
    /^data:image\/png;base64,/.test(D.BLANK_TILE));
eq('the warp mesh is 8 (sub-pixel everywhere in Denmark)', D.CONFIG.WARP_MESH, 8);
check('source tiles per destination tile are capped', D.CONFIG.MAX_SOURCE_TILES <= 16);
check('setMode switches product and redraws in place',
    layer.setMode('surface').getMode() === 'surface');
check('setMode ignores an unknown product',
    layer.setMode('contours').getMode() === 'surface');
check('every CONFIG key the brief listed lives in the one marked block',
    ['PROXY_PATH', 'MODES', 'TILEMATRIXSET', 'MIN_ZOOM', 'MAX_ZOOM', 'BOUNDS',
     'OPACITY', 'ATTRIBUTION', 'FORMAT'].every((k) => k in D.CONFIG));

/* ══════════════════════════════════════════════════════════════════════════
 * 9. THE REPROJECTION IS CORRECT  (drives the real createTile)
 *
 * This is the acceptance criterion "hillshade correctly aligned". For a real
 * destination tile over Denmark we run the shipped code with a recording
 * canvas, then take known Danish coordinates, work out independently
 *   (a) where they belong in the destination tile  (Web Mercator), and
 *   (b) where they are in the fetched View1 mosaic (UTM 32N),
 * push (b) through the transform the warp actually installed for that mesh
 * cell, and require the result to equal (a).
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[9] End-to-end reprojection alignment');

function renderTile(z, x, y, mode) {
    const record = { urls: [], canvases: [], cells: [], mosaic: [] };
    const { D: DD } = loadModule({}, record);
    const lyr = DD.createLayer({ mode: mode || 'terrain' });
    lyr._map = { options: { crs: { code: 'EPSG:3857' } } };
    return new Promise((resolve) => {
        const canvas = lyr.createTile({ x, y, z }, () =>
            resolve({ record, canvas, D: DD }));
        record.destCanvas = canvas;
    });
}

function tileXY(lat, lon, z) {
    const n = Math.pow(2, z);
    return {
        x: Math.floor((lon + 180) / 360 * n),
        y: Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) +
            1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)
    };
}

(async function () {
    const places = [
        { name: 'Copenhagen', lat: 55.6761, lon: 12.5683, z: 12 },
        { name: 'Skagen (north tip)', lat: 57.7400, lon: 10.6280, z: 10 },
        { name: 'Esbjerg (west coast)', lat: 55.4670, lon: 8.4520, z: 14 },
        { name: 'Bornholm (far east)', lat: 55.1000, lon: 14.9000, z: 9 },
        { name: 'Jutland, example tile 1', lat: 56.3555, lon: 9.6613, z: 16 }
    ];

    for (const p of places) {
        const t = tileXY(p.lat, p.lon, p.z);
        const { record, canvas, D: DD } = await renderTile(p.z, t.x, t.y);

        check(p.name + ' z' + p.z + ': the tile was drawn',
            canvas.width === 256 && canvas.height === 256 && record.cells.length > 0);
        eq(p.name + ' z' + p.z + ': one affine per mesh cell (8×8)',
            record.cells.length, 64);

        // Which View1 tiles were requested?
        const reqs = record.urls.map((u) => ({
            level: Number(/TileMatrix=(\d+)/.exec(u)[1]),
            col: Number(/TileCol=(\d+)/.exec(u)[1]),
            row: Number(/TileRow=(\d+)/.exec(u)[1])
        }));
        check(p.name + ' z' + p.z + ': ' + reqs.length +
            ' View1 tile(s) requested, all valid indices inside the matrix',
            reqs.length > 0 && reqs.length <= DD.CONFIG.MAX_SOURCE_TILES &&
            reqs.every((r) => DD.GRID.isValidTile(r.level, r.col, r.row)),
            JSON.stringify(reqs));
        check(p.name + ' z' + p.z + ': every request goes to our own proxy, token-free',
            record.urls.every((u) => u.indexOf('/api/geo/dk-dhm?') === 0 &&
                u.indexOf('token') === -1));

        const level = reqs[0].level;
        check(p.name + ' z' + p.z + ': a single source level was used',
            reqs.every((r) => r.level === level));

        // Reconstruct the mosaic frame exactly as the layer did.
        const span = DD.GRID.tileSpan(level);
        const srcRes = DD.GRID.resolution(level);
        const c0 = Math.min(...reqs.map((r) => r.col));
        const r0 = Math.min(...reqs.map((r) => r.row));
        const originX = DD.CONFIG.GRID_ORIGIN_X + c0 * span;
        const originY = DD.CONFIG.GRID_ORIGIN_Y - r0 * span;

        // Destination tile frame in EPSG:3857.
        const res3857 = DD.webMercator.resolution(p.z, 256);
        const x0 = -DD.webMercator.HALF + t.x * 256 * res3857;
        const y0 = DD.webMercator.HALF - t.y * 256 * res3857;

        // Probe 25 points spread across the tile. The 0.41 offset and the
        // division by 5 deliberately keep every probe OFF the 32 px mesh
        // nodes — on a node the affine is exact by construction and the
        // check would prove nothing.
        let worst = 0;
        for (let gy = 0; gy < 5; gy++) {
            for (let gx = 0; gx < 5; gx++) {
                const px = (gx + 0.41) * 256 / 5,                // expected dest pixel
                      py = (gy + 0.67) * 256 / 5;
                const lat = DD.webMercator.lat(y0 - py * res3857);
                const lon = DD.webMercator.lon(x0 + px * res3857);
                const en = DD.UTM.forward(lat, lon);
                const sx = (en[0] - originX) / srcRes;            // mosaic pixel
                const sy = (originY - en[1]) / srcRes;

                const cell = 256 / DD.CONFIG.WARP_MESH;
                const i = Math.min(DD.CONFIG.WARP_MESH - 1, Math.floor(px / cell));
                const j = Math.min(DD.CONFIG.WARP_MESH - 1, Math.floor(py / cell));
                const tr = record.cells[j * DD.CONFIG.WARP_MESH + i].transform;

                const gotX = tr[0] * sx + tr[2] * sy + tr[4];
                const gotY = tr[1] * sx + tr[3] * sy + tr[5];
                worst = Math.max(worst, Math.hypot(gotX - px, gotY - py));
            }
        }
        check(p.name + ' z' + p.z + ': warped position is accurate to ' +
            worst.toFixed(4) + ' px (need < 0.25)', worst < 0.25, worst + ' px');
        check(p.name + ' z' + p.z + ': …and the probes were genuinely off-mesh-node',
            worst > 0, 'exactly 0 px means every probe sat on a node');

        // The source resolution must roughly match the destination's.
        const groundRes = res3857 * Math.cos(p.lat * Math.PI / 180);
        check(p.name + ' z' + p.z + ': source level ' + level + ' (' + srcRes +
            ' m/px) matches the ~' + groundRes.toFixed(2) + ' m/px needed',
            srcRes <= groundRes * 1.5 && srcRes >= groundRes / 3);

        // Mesh cells must tile the whole 256×256 destination with no gap.
        const covered = record.cells.every((c) => c.rect[2] >= 256 / 8 && c.rect[3] >= 256 / 8);
        check(p.name + ' z' + p.z + ': mesh cells overlap slightly so there are no seams',
            covered && record.cells[0].rect[0] === -0.5 && record.cells[0].rect[1] === -0.5);
    }

    /* ── a tile outside the View1 matrix must make no request at all ────── */
    {
        // Far west of the grid origin (Atlantic, well outside EPSG:25832's box).
        const t = tileXY(55.0, -40.0, 8);
        const { record } = await renderTile(8, t.x, t.y);
        eq('a destination tile outside the View1 matrix requests nothing',
            record.urls.length, 0);
    }

    /* ── every source tile failing must not throw or spam ───────────────── */
    {
        const record = { urls: [], canvases: [], cells: [], mosaic: [] };
        const L = makeLeaflet();
        const sandbox = {
            L,
            console: { log: () => {}, warn: (...a) => sandbox.__warnings.push(a.join(' ')),
                error: (...a) => sandbox.__warnings.push(a.join(' ')) },
            __warnings: [], setTimeout: () => 0, setImmediate, Promise, Map,
            fetch: undefined,
            document: makeDom(record),
            Image: makeImage(record, true)        // every tile 404s
        };
        sandbox.window = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(read('js/dataforsyningen-dhm-layer.js'), sandbox,
            { filename: 'dataforsyningen-dhm-layer.js' });

        const lyr = sandbox.DataforsyningenDHM.createLayer();
        lyr._map = { options: { crs: { code: 'EPSG:3857' } } };
        const t = tileXY(55.6761, 12.5683, 12);

        await new Promise((resolve) => {
            const canvas = lyr.createTile({ x: t.x, y: t.y, z: 12 }, (err, tile) => {
                check('all source tiles failing still calls done() without an error',
                    err === null && tile === canvas);
                check('…and leaves a blank 256×256 canvas, never a broken-image icon',
                    canvas.width === 256 && canvas.height === 256);
                resolve();
            });
        });

        eq('…and logs exactly one warning, not one per tile',
            sandbox.__warnings.length, 1);
        check('…and that warning names the layer',
            /dhm_terraen_skyggekort/.test(sandbox.__warnings[0]));

        // A second failing tile must stay silent.
        const t2 = tileXY(55.70, 12.60, 12);
        await new Promise((resolve) => {
            lyr.createTile({ x: t2.x, y: t2.y, z: 12 }, () => resolve());
        });
        eq('a second failure is silent', sandbox.__warnings.length, 1);
    }

    /* ── the surface product uses the same grid and the same tiles ──────── */
    {
        const t = tileXY(55.6761, 12.5683, 12);
        const a = await renderTile(12, t.x, t.y, 'terrain');
        const b = await renderTile(12, t.x, t.y, 'surface');
        check('terrain and surface request the identical View1 indices',
            JSON.stringify(a.record.urls.map((u) => u.replace(/layer=[^&]+/, ''))) ===
            JSON.stringify(b.record.urls.map((u) => u.replace(/layer=[^&]+/, ''))));
        check('…and differ only in the layer name',
            b.record.urls.every((u) => /layer=dhm_overflade_skyggekort(&|$)/.test(u)));
    }

    runRemainingSyncChecks();
}());

/* ══════════════════════════════════════════════════════════════════════════
 * 10 … 13 — static checks on the proxy, the app wiring and the docs
 * ═════════════════════════════════════════════════════════════════════════ */
function runRemainingSyncChecks() {

console.log('\n[10] Server-side proxy (Express) and its Netlify twin');

const proxy = read('backend/src/routes/geoProxy.js');
const fn = read('netlify/functions/dk-dhm.mjs');

[['Express route', proxy], ['Netlify function', fn]].forEach(([what, src]) => {
    check(what + ': upstream is chosen from a fixed layer→service table',
        /LAYER_UPSTREAM/.test(src) &&
        /dhm_terraen_skyggekort_DAF/.test(src) && /dhm_overflade_skyggekort_DAF/.test(src));
    check(what + ': only GetTile and GetCapabilities are forwarded',
        /ALLOWED_REQUESTS[\s\S]{0,80}gettile[\s\S]{0,40}getcapabilities/.test(src));
    check(what + ': only image/jpeg is allowed',
        /ALLOWED_FORMATS = new Set\(\['image\/jpeg'\]\)/.test(src));
    check(what + ': only the View1 tile-matrix-set is allowed',
        /ALLOWED_TILEMATRIXSETS/.test(src) && /view1/.test(src));
    check(what + ': tile indices are bounds-checked against the matrix',
        /MAX_TILEMATRIX = 13/.test(src) && /MAX_TILE_INDEX = 17187/.test(src) &&
        /bad_tile_index/.test(src));
    check(what + ': a client-supplied token is dropped, never forwarded',
        /token/.test(src) && (/key\.toLowerCase\(\) === 'token'/.test(src) ||
            /STRIPPED_PARAMS/.test(src)));
    check(what + ': the token goes upstream as a header, not a query parameter',
        /headers:\s*\{\s*token\s*\}/.test(src));
    check(what + ': tiles are cached for 7 days',
        /max-age=604800/.test(src));
    check(what + ': a missing token answers 401 token_missing',
        /dataforsyningen_token_missing/.test(src));
    check(what + ': an upstream XML exception is turned into 401 token_invalid',
        /dataforsyningen_token_invalid/.test(src) && /not authori/i.test(src));
    check(what + ': the token is never echoed back to the client',
        !/res\.(send|json)\([^)]*token[^)]*\)/.test(src.replace(/_token_(missing|invalid)/g, '_')));
});
check('netlify.toml routes /api/geo/dk-dhm to the function',
    /from = "\/api\/geo\/dk-dhm"/.test(read('netlify.toml')) &&
    /to = "\/\.netlify\/functions\/dk-dhm"/.test(read('netlify.toml')));
check('the Netlify function declares the same public path',
    /path: '\/api\/geo\/dk-dhm'/.test(fn));
check('the Sweden proxy route is untouched', /\/geo\/se-hojdmodell/.test(proxy));
// Everything from the start of the Denmark route to the first mention of
// Sweden's upstream, i.e. the Denmark route body and nothing else.
const dkRoute = (function () {
    const from = proxy.indexOf("router.get('/geo/dk-dhm'");
    const rest = proxy.slice(from);
    const to = rest.search(/lantmateriet/i);
    return to === -1 ? rest : rest.slice(0, to);
}());
check('the Denmark route body was isolated for the scan',
    dkRoute.length > 500 && /dataforsyningen_token_missing/.test(dkRoute));
check('no WMS GetMap handling is left in the Denmark route', !/getmap/i.test(dkRoute));
check('the Denmark route speaks WMTS GetTile', /gettile/i.test(dkRoute));

console.log('\n[11] App wiring');

const mapApp = read('js/map-app.js');
const indexHtml = read('index.html');

check('the Denmark layer is built by its own module',
    /window\.DataforsyningenDHM\.createLayer/.test(mapApp));
const dhmTag = indexHtml.match(/js\/dataforsyningen-dhm-layer\.js\?v=([\w-]+)/);
check('the layer module is loaded by index.html with a cache-buster', !!dhmTag);
const swSource = read('sw.js');
check('the service worker precaches the layer version index.html loads',
    !!dhmTag && swSource.indexOf("'js/dataforsyningen-dhm-layer.js?v=" + dhmTag[1] + "'") !== -1);
// The shell that shipped the WMTS rewrite was v163; later features keep
// bumping the number, so assert the floor and the recorded history instead
// of pinning the literal cache name.
check('the service worker shell is v163 (dk-dhm-wmts) or newer',
    Number((swSource.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]) >= 163);
check('the shell history records the v163 WMTS switch',
    /v163[^\n]*dk-dhm-wmts/.test(swSource));
/* The 2D panel row was removed at the owner's request: Denmark's terrain
   and surface hillshades are now the WMS LiDAR rows of
   js/danish-layers.config.js (panelGroup "lidar"), each with its own
   switch and slider. The WMTS module, its proxy routes and the map-app
   plumbing below stay in place for the 3D registry builder
   (lidar.dk-dhm), dormant in the 2D panel. */
check('the Denmark DHM hillshade row is removed from the 2D layer panel',
    !/lidarDkLidarRow/.test(indexHtml) &&
    !/Denmark · DHM hillshade \(DHM\/Terræn\)/.test(indexHtml) &&
    !/denmarkLidarModeSelect/.test(indexHtml));
check('no dkLidar switch or opacity slider remains in the panel markup',
    !/toggleInternationalLidar\('dkLidar', this\.checked\)/.test(indexHtml) &&
    !/lidarDkLidarToggle|lidarDkLidarOpacitySlider|lidarDkLidarPct/.test(indexHtml) &&
    !/setInternationalLidarOpacity\('dkLidar', this\.value\)/.test(indexHtml));
check('the Danish terrain/surface hillshades live on as styled WMS LiDAR rows',
    /id: 'lidar_dhm_terrain_hillshade',\s*\n\s*panelGroup: 'lidar'/.test(read('js/danish-layers.config.js')) &&
    /id: 'lidar_dhm_surface_hillshade',\s*\n\s*panelGroup: 'lidar'/.test(read('js/danish-layers.config.js')) &&
    /id="danishLidarLayers"/.test(indexHtml));
check('the dropdown filler stays dormant but intact in map-app',
    /_populateDenmarkModeSelect/.test(mapApp) && /DataforsyningenDHM\.modeKeys\(\)/.test(mapApp));
check('switching product uses setMode instead of rebuilding',
    /setDenmarkLidarMode/.test(mapApp) && /cfg\.leafletLayer\.setMode\(mode\)/.test(mapApp));
check('the WMTS module stays loaded for the 3D registry builder',
    /lidar\.dk-dhm/.test(read('js/layer-registry.js')) &&
    /builder: \{ module: 'DataforsyningenDHM'/.test(read('js/layer-registry.js')));
check('the fly-to bounds match the published extent',
    /dkLidar: \[\[54\.4265, 7\.99125\], \[57\.7781, 15\.5995\]\]/.test(mapApp));

console.log('\n[12] Documentation');

const doc = read('DENMARK_LIDAR_DATAFORSYNINGEN.md');
check('the README states the exact attribution text',
    /Indeholder data fra Klimadatastyrelsen, Danmarks Højdemodel/.test(doc));
check('the README names the licence', /CC BY 4\.0/.test(doc));
check('the README documents the View1 grid', /View1/.test(doc) && /25832/.test(doc));
check('the README covers token setup', /DATAFORSYNINGEN_TOKEN/.test(doc) && /YOUR_TOKEN/.test(doc));
check('the README offers a proxy for each backend choice',
    /Cloudflare/i.test(doc) && /Nginx/i.test(doc) && /PHP/i.test(doc) && /Express/i.test(doc));
check('the README has a manual test checklist',
    /Copenhagen/i.test(doc) && /DevTools/i.test(doc));
check('the README lists known limitations', /limitation/i.test(doc));
check('the README says what could NOT be verified', /not verif/i.test(doc));
check('the standalone alignment demo page exists', exists('tools/denmark-lidar-demo.html'));

console.log('\n[13] Scope guard — only the Denmark row changed');

check('the Norway layer still uses its own module', /Hoydedata\.createLayer/.test(mapApp));
check('the Poland layer still uses its own module', /GeoportalNMT\.createLayer/.test(mapApp));
check('the Spain layer still uses its own module', /IgnMdt\.createLayer/.test(mapApp));
check('the Netherlands layer still uses its own module', /AhnLidar\.createLayer/.test(mapApp));
check('the Switzerland layer still uses its own module', /SwisstopoRelief\.createLayer/.test(mapApp));
check('the England layer still uses its own module', /EaLidarWmts\.createLayer/.test(mapApp));
check('the Sweden layer still uses its own module', /LantmaterietHojdmodell\.createLayer/.test(mapApp));
check('other country service kept: FRANCE_LIDAR_WMS_URL',
    mapApp.indexOf('FRANCE_LIDAR_WMS_URL') !== -1);

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('All Denmark / Dataforsyningen DHM WMTS checks passed.');

}
