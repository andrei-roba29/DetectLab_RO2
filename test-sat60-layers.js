/*
 * test-sat60-layers.js
 * ──────────────────────────────────────────────────────────────────────────
 * "Satellite imagery 60's" — the CORONA products the layer requests.
 *
 * ── The bug this file was born from (kept as a regression) ────────────────
 * The layer used to carry a hand-written list of corona:<mission>-<pass>
 * names invented from the naming pattern. Most of them do not exist on the
 * CAST GeoServer:
 *
 *   …/gwc/service/wms?…&LAYERS=corona%3A1107-1074Fore&…
 *     → "400: Unknown layer corona:1107-1074Fore."
 *
 * and the few that do exist image Greece, Peru or China — so over Romania
 * the layer could never draw anything.
 *
 * ── What the layer does now ───────────────────────────────────────────────
 * It stopped guessing. Exactly like the original atlas
 * (corona.cast.uark.edu/atlas → getRasterNames() → /corona/get_raster_names),
 * the product list comes FROM THE SERVER'S OWN CATALOGUE, for the whole of
 * Europe, with each product's real footprint polygon; the Leaflet manager
 * then reproduces `rasterLayer.checkZoom()`: pass mosaics at z8–11,
 * individual frames at z12–20, visible only while their POLYGON intersects
 * the view.
 *
 * These tests assert:
 *   1. none of the invented / wrong-continent names can come back;
 *   2. the only names hardcoded anywhere are the verified fallback set;
 *   3. the CAST catalogue shape is parsed correctly and clipped to Europe;
 *   4. zoom gating matches the atlas's rasterSettings.layerSettings;
 *   5. selection uses the footprint POLYGON, not its bounding box;
 *   6. every request still carries a single corona:<product> layer;
 *   7. the catalogue is never fetched straight from the CORS-less CAST host.
 *
 * Run:  node test-sat60-layers.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ── Minimal Leaflet stub (only what corona-wms-layer.js touches) ────────── */
function classExtend(proto) {
    function SubClass() {
        if (this.initialize) this.initialize.apply(this, arguments);
    }
    SubClass.prototype = Object.create(this.prototype || {});
    for (const k in proto) SubClass.prototype[k] = proto[k];
    return SubClass;
}
function WMSBase(url, options) { this._url = url; this.options = options || {}; }
WMSBase.extend = classExtend;
WMSBase.prototype = {
    initialize: function (url, options) { this._url = url; this.options = options || {}; },
    on: function () { return this; },
    off: function () { return this; },
    setOpacity: function (o) { this.options.opacity = o; return this; }
};

function LatLngBounds(a, b) {
    if (Array.isArray(a) && Array.isArray(a[0])) { b = a[1]; a = a[0]; }
    this._south = Math.min(a[0], b[0]);
    this._north = Math.max(a[0], b[0]);
    this._west = Math.min(a[1], b[1]);
    this._east = Math.max(a[1], b[1]);
}
LatLngBounds.prototype = {
    getSouth: function () { return this._south; },
    getNorth: function () { return this._north; },
    getWest: function () { return this._west; },
    getEast: function () { return this._east; },
    pad: function (ratio) {
        const dLat = (this._north - this._south) * ratio;
        const dLon = (this._east - this._west) * ratio;
        return new LatLngBounds([this._south - dLat, this._west - dLon],
            [this._north + dLat, this._east + dLon]);
    }
};

function LayerGroup(layers) {
    this._layers = new Set(layers || []);
}
LayerGroup.prototype = {
    addLayer: function (l) { this._layers.add(l); return this; },
    removeLayer: function (l) { this._layers.delete(l); return this; },
    hasLayer: function (l) { return this._layers.has(l); },
    getLayers: function () { return Array.from(this._layers); }
};

const L = {
    extend: function (target) {
        for (let i = 1; i < arguments.length; i++) {
            const src = arguments[i] || {};
            for (const k in src) target[k] = src[k];
        }
        return target;
    },
    TileLayer: { WMS: WMSBase },
    latLngBounds: function (a, b) { return new LatLngBounds(a, b); },
    layerGroup: function (layers) { return new LayerGroup(layers); },
    tileLayer: { wms: function (url, options) { return new WMSBase(url, options); } }
};

const sandbox = {
    console: console,
    L: L,
    encodeURIComponent: encodeURIComponent,
    Promise: Promise,
    Object: Object
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/corona-wms-layer.js'), 'utf8'),
    sandbox, { filename: 'corona-wms-layer.js' });
const W = sandbox;
const Atlas = W.CoronaAtlas;

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

const coronaLib = fs.readFileSync(path.join(__dirname, 'js/corona-wms-layer.js'), 'utf8');
const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
/* The Sat60 block of map-app.js (everything else may legitimately mention
 * other services). */
const sat60Start = mapApp.indexOf('SATELIT 60s (CORONA)');
const sat60End = mapApp.indexOf('HARTI ISTORICE PREMIUM');
const sat60Block = mapApp.slice(sat60Start, sat60End);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The invented / wrong-continent names must stay gone
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] Guessed and wrong-continent CORONA names are not shipped');

check('the Sat60 block of map-app.js was found', sat60Start !== -1 && sat60End > sat60Start);

const BANNED = [
    'corona:1107-1074Fore',  // 400 Unknown layer (the reported bug)
    'corona:1103-2155Fore',  // does not exist
    'corona:1110-2289Aft',   // does not exist
    'corona:1103-2139Aft',   // does not exist
    'corona:1106-1042Aft',   // does not exist
    'corona:1105-2235Aft',   // does not exist
    'corona:1107-1074Aft',   // exists — images Greece
    'corona:1110-2289Fore',  // exists — images Peru
    'corona:1105-2235Fore',  // exists — images the Middle East
    'corona:1103-2167df101'  // exists — images China
];
const haystack = sat60Block + '\n' + coronaLib;
BANNED.forEach(function (name) {
    const bare = name.replace('corona:', '');
    check('never hardcodes ' + name,
        haystack.indexOf(name) === -1 && haystack.indexOf("'" + bare + "'") === -1);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The only hardcoded products are the verified fallback set
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] Product names come from the catalogue, not from the code');

const VERIFIED_FALLBACK = [
    '1104-2155Fore', '1104-2155Aft', '1036-2139Fore',
    '1103-1058Aft', '1103-1058Fore', '1026-2088Aft'
];
const hardcoded = Array.from(new Set(
    (haystack.match(/[0-9]{4}-[0-9]{4}(?:Fore|Aft|d[fa][0-9]{3})/g) || [])
));
const unexpected = hardcoded.filter(function (name) {
    return VERIFIED_FALLBACK.indexOf(name) === -1 &&
        ['1104-2155df004', '1104-2155df007', '1104-2155df011',
         '1105-2235df021'].indexOf(name) === -1;          // doc example only
});
check('no product name outside the verified fallback list is hardcoded',
    unexpected.length === 0, unexpected.join(', '));
eq('the fallback list has the 6 verified passes', Atlas.FALLBACK_BLOCKS.length, 6);
check('every fallback pass is one of the verified names',
    Atlas.FALLBACK_BLOCKS.every(function (b) { return VERIFIED_FALLBACK.indexOf(b.location) !== -1; }));
check('every fallback pass carries its own footprint',
    Atlas.FALLBACK_BLOCKS.every(function (b) { return b.extent.length === 4 && b.rings.length; }));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The CAST catalogue shape is parsed and clipped to Europe
 *    (fixture = verbatim entries of corona.cast.uark.edu/corona/get_raster_names)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] CAST catalogue parsing + Europe clipping');

const CAST_FIXTURE = {
    // China — outside Europe
    '1002-1037Aft': {
        label: '1002-1037Aft (Sep 25, 1963)',
        location: '1002-1037Aft',
        extent: { minx: 111.917923584625, miny: 34.2769308567445, maxx: 114.807937481338, maxy: 35.2435570842842 },
        polygon: '{"type": "Polygon", "coordinates": [[[111.917923584625, 34.457038944353], [112.041319261419, 34.2769308567445], [114.807937481338, 35.0384371533671], [114.770689858159, 35.2435570842842], [111.917923584625, 34.457038944353]]]}',
        images: [{
            label: '1002-1037A113', location: '1002-1037da113',
            extent: { minx: 111.917923584625, miny: 34.2769308567445, maxx: 114.807937481338, maxy: 35.2435570842842 },
            polygon: '{"type": "Polygon", "coordinates": [[[112.041319261419, 34.2769308567445], [111.917923584625, 34.457038944353], [114.770689858159, 35.2435570842842], [112.041319261419, 34.2769308567445]]]}'
        }]
    },
    // Marmara / Bosphorus — inside Europe
    '1006-1025Aft': {
        label: '1006-1025Aft (Jun 05, 1964)',
        location: '1006-1025Aft',
        extent: { minx: 26.4446517691805, miny: 40.4005864822581, maxx: 29.3530463435642, maxy: 41.1514338171344 },
        polygon: '{"type": "Polygon", "coordinates": [[[26.4446517691805, 40.5753592535862], [26.5517479314811, 40.4005864822581], [29.3530463435642, 40.9569955606865], [29.3390408271658, 41.1514338171344], [26.4446517691805, 40.5753592535862]]]}',
        images: [{
            label: '1006-1025A120', location: '1006-1025da120',
            extent: { minx: 26.4446517691805, miny: 40.4005864822581, maxx: 29.3530463435642, maxy: 41.1514338171344 },
            polygon: '{"type": "Polygon", "coordinates": [[[26.5517479314811, 40.4005864822581], [26.4446517691805, 40.5753592535862], [29.3390408271658, 41.1514338171344], [26.5517479314811, 40.4005864822581]]]}'
        }]
    },
    // Moscow area — inside Europe
    '1007-1056Fore': {
        label: '1007-1056Fore (Jun 23, 1964)',
        location: '1007-1056Fore',
        extent: { minx: 35.0795819387989, miny: 55.3894498428335, maxx: 39.4756565800395, maxy: 55.9990673564469 },
        polygon: '{"type": "Polygon", "coordinates": [[[35.0795819387989, 55.5970777579305], [35.0844551110382, 55.3894498428335], [39.4756565800395, 55.7913740087951], [39.3532754954868, 55.9990673564469], [35.0795819387989, 55.5970777579305]]]}',
        images: [{
            label: '1007-1056F103', location: '1007-1056df103',
            extent: { minx: 35.0795819387989, miny: 55.3894498428335, maxx: 39.4756565800395, maxy: 55.9990673564469 },
            polygon: '{"type": "Polygon", "coordinates": [[[35.0844551110382, 55.3894498428335], [35.0795819387989, 55.5970777579305], [39.3532754954868, 55.9990673564469], [35.0844551110382, 55.3894498428335]]]}'
        }]
    },
    // Kazakhstan — outside Europe
    '1006-2118Fore': {
        label: '1006-2118Fore (Jun 12, 1964)',
        location: '1006-2118Fore',
        extent: { minx: 68.5666590903957, miny: 47.1002205271421, maxx: 72.1173299126664, maxy: 47.9783192648253 },
        polygon: '{"type": "Polygon", "coordinates": [[[68.5666590903957, 47.3091702624542], [68.6030905060963, 47.1002205271421], [72.1173299126664, 47.7851813360123], [71.9783036760562, 47.9783192648253], [68.5666590903957, 47.3091702624542]]]}',
        images: []
    }
};

const europe = Atlas.normalizeCatalog(CAST_FIXTURE, Atlas.EUROPE_BBOX);
const ids = europe.map(function (b) { return b.location; }).sort();
eq('only the European passes survive the clip', ids.join(','), '1006-1025Aft,1007-1056Fore');
check('the Chinese pass is dropped', ids.indexOf('1002-1037Aft') === -1);
check('the Kazakh pass is dropped', ids.indexOf('1006-2118Fore') === -1);

const marmara = europe.filter(function (b) { return b.location === '1006-1025Aft'; })[0];
eq('the pass keeps its human label', marmara.label, '1006-1025Aft (Jun 05, 1964)');
eq('the pass keeps its frames', marmara.images.length, 1);
eq('the frame is the real GeoServer product name', marmara.images[0].location, '1006-1025da120');
check('the footprint polygon is parsed (not just the bbox)',
    marmara.rings.length === 1 && marmara.rings[0].length === 5);
eq('the extent is [minLon, minLat, maxLon, maxLat]',
    marmara.extent.map(function (n) { return Math.round(n); }).join(','), '26,40,29,41');

// Our own slim snapshot shape (data/corona-europe-catalog.json) parses too.
const slim = Atlas.normalizeCatalog({
    blocks: [{
        id: '1104-2155Fore', label: '1104-2155Fore', location: '1104-2155Fore',
        extent: [19.5, 43.5, 26.77, 47.73],
        rings: [[[19.5, 43.5], [26.77, 44.0], [26.5, 47.73], [19.5, 47.0], [19.5, 43.5]]],
        images: [{ label: 'f', location: '1104-2155df004', extent: [21.0, 45.2, 24.7, 47.8] }]
    }]
}, Atlas.EUROPE_BBOX);
eq('the slim snapshot shape is understood', slim.length, 1);
eq('…including its frames', slim[0].images[0].location, '1104-2155df004');

/* ══════════════════════════════════════════════════════════════════════════
 * 4 + 5. Zoom gating and polygon-based selection (rasterLayer.checkZoom)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Zoom gating + polygon selection reproduce rasterLayer.checkZoom()');

function fakeMap(zoom, bounds) {
    return {
        getZoom: function () { return zoom; },
        getBounds: function () { return new LatLngBounds(bounds[0], bounds[1]); }
    };
}

// View over the Bosphorus, inside the 1006-1025Aft strip.
const viewBosphorus = [[40.6, 27.5], [41.0, 28.5]];

function managerFor(zoom, bounds, blocks) {
    const map = fakeMap(zoom, bounds);
    const manager = Atlas.createManager(map, { group: L.layerGroup([]), viewportPad: 0 });
    manager.setCatalog(blocks || europe);
    return manager;
}

const atZ6 = managerFor(6, viewBosphorus).update();
eq('z6 (overview): nothing is requested, like the atlas', atZ6.length, 0);

const atZ9 = managerFor(9, viewBosphorus).update();
eq('z9: exactly the pass mosaic of the strip', atZ9.length, 1);
eq('z9: it is a pass mosaic', atZ9[0].type, 'pass');
eq('z9: the right product', atZ9[0].product.location, '1006-1025Aft');

const atZ11 = managerFor(11, viewBosphorus).update();
eq('z11: still the pass mosaic (atlas maxZoom 11)', atZ11[0].type, 'pass');

const atZ13 = managerFor(13, viewBosphorus).update();
eq('z13: the individual frame instead (atlas minZoom 12)', atZ13[0].type, 'frame');
eq('z13: the frame product name', atZ13[0].product.location, '1006-1025da120');

const atZ21 = managerFor(21, viewBosphorus).update();
eq('above the grid (z21): nothing is requested', atZ21.length, 0);

// Somewhere with no Corona pass at all (the Atlantic).
const atlantic = managerFor(10, [[45.0, -20.0], [45.5, -19.0]]).update();
eq('an area without coverage requests nothing', atlantic.length, 0);

console.log('\n[5] The footprint POLYGON decides, not its bounding box');

// A strongly rotated strip: the view sits in the bbox corner the strip misses.
const rotated = [{
    id: 'rot', label: 'rot', location: 'rot-strip',
    extent: [20, 40, 30, 50],
    rings: [[[20, 40], [21, 40], [30, 49], [30, 50], [20, 40]]],
    images: []
}];
check('the view is inside the bbox of the strip',
    Atlas.bboxIntersects(rotated[0].extent, [20.2, 48.5, 21.2, 49.5]));
check('…but outside its polygon → not requested',
    managerFor(9, [[48.5, 20.2], [49.5, 21.2]], rotated).update().length === 0);
check('a view on the strip itself → requested',
    managerFor(9, [[44.0, 24.5], [45.0, 25.5]], rotated).update().length === 1);

/* ══════════════════════════════════════════════════════════════════════════
 * 6. One corona:<product> per request, limited to its own footprint
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[6] Requests stay single-product and footprint-limited');

const manager = managerFor(9, viewBosphorus);
manager.update();
const layers = manager.getActiveLayers();
eq('one tile layer is attached', layers.length, 1);
eq('its LAYERS= value is the workspaced product', layers[0].options.layers, 'corona:1006-1025Aft');
check('no comma-separated layer list', layers[0].options.layers.indexOf(',') === -1);
check('the layer is bounded by its own footprint', !!layers[0].options.bounds);
eq('pass mosaics are gated at z8', layers[0].options.minZoom, 8);
eq('the server pyramid depth is honoured', layers[0].options.maxNativeZoom, 17);
check('a tileerror handler is attached', coronaLib.indexOf("layer.on('tileerror'") !== -1);
check('the failing tile element is hidden', /e\.tile\.style\.display = 'none'/.test(coronaLib));
check('the unavailable product is logged once',
    /_coronaErrorLogged/.test(coronaLib) && /product unavailable on the CAST server/.test(coronaLib));

/* ══════════════════════════════════════════════════════════════════════════
 * 7. The catalogue never comes straight from the CORS-less CAST host
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[7] Catalogue sources are same-origin / CORS-safe');

const sources = Atlas.catalogSources();
check('the static Europe snapshot is tried first',
    sources[0].indexOf('data/corona-europe-catalog.json') !== -1, sources.join(' | '));
check('the same-origin proxy is the fallback',
    sources.some(function (s) { return s.indexOf('/api/corona/rasters') === 0; }));
// (the host may be named in comments — it must not appear in executable code)
const libCode = coronaLib
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(function (line) { return !/^\s*\/\//.test(line); }).join('\n');
check('the browser never calls corona.cast.uark.edu directly',
    sources.every(function (s) { return s.indexOf('corona.cast.uark.edu') === -1; }) &&
    libCode.indexOf('corona.cast.uark.edu') === -1);
check('an unreachable catalogue falls back to the verified list, not to nothing',
    /FALLBACK_BLOCKS/.test(coronaLib) && /no catalogue source reachable/.test(coronaLib));

/* ───────────────────────────────────────────────────────────────────────── */
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('All CORONA Europe catalogue / product checks passed.');
