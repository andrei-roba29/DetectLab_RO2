// Test suite for the "Hillshade LiDAR derivate" row (MapTiler Hillshade).
//
// Two bugs are pinned here:
//
//   1. The row was TRIPLED (in fact duplicated 50×). The layer catalogue used
//      to carry one entry per European country — LIDAR_SUB_LAYERS.derivateAD …
//      derivateXK — for what is a single GLOBAL raster: every copy requested
//      exactly the same maptiler.com/tiles/hillshade tiles. The panel therefore
//      showed "Hillshade LiDAR derivate" once per country whose box touched the
//      viewport, and switching two of them on stacked identical overlays.
//      It is now ONE row (#lidarDerivateRow / key `derivate`) that is
//      country-independent, so every country view keeps it exactly once.
//
//   2. The overlay VANISHED when zooming in. The Hillshade tileset's TileJSON
//      declares maxzoom 12 (https://api.maptiler.com/tiles/hillshade/tiles.json)
//      but the layer went through Leaflet's default maxNativeZoom (18), so
//      every zoom above 12 requested tiles the service does not have: the
//      overlay went blank and only the basemap was left on screen. The layer
//      now carries maxNativeZoom: 12 and Leaflet upscales the last native tile
//      above z12 instead.
//
// No network, account or npm dependencies.
// Usage: node test-lidar-hillshade-derivate.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Hillshade LiDAR derivate: one global row, visible above z12...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const source = read('js/map-app.js');
const html = read('index.html');
const sw = read('sw.js');

const MAPTILER_HILLSHADE = 'api.maptiler.com/tiles/hillshade';
const NEW_TAG = 'js/map-app.js?v=20261026-lidar-hillshade-zoom';

/* ══════════════════════════════════════════════════════════════
   1. Panel markup: exactly ONE Hillshade LiDAR derivate row
   ══════════════════════════════════════════════════════════════ */
const derivateRows = html.match(/id="lidarDerivate[A-Z]{2}Row"/g) || [];
assert.strictEqual(derivateRows.length, 0,
    'no per-country derivate rows are left in index.html (found ' + derivateRows.join(', ') + ')');

assert(/id="lidarDerivateRow"/.test(html), 'the single #lidarDerivateRow exists');
assert(/id="lidarDerivateToggle"[^>]*toggleInternationalLidar\('derivate'/.test(html),
    'the row toggle drives the single `derivate` key');
assert(/id="lidarDerivateOpacitySlider"[^>]*setInternationalLidarOpacity\('derivate'/.test(html),
    'the row opacity slider drives the single `derivate` key');
assert(/id="lidarDerivatePct"/.test(html), 'the opacity read-out stays wired (#lidarDerivatePct)');

// Every label of the catalogue's own rows, to prove the panel no longer repeats
// the same title per country.
const derivateLabels = (html.match(/<span>Hillshade LiDAR derivate<\/span>/g) || []).length;
assert.strictEqual(derivateLabels, 1,
    'the panel shows "Hillshade LiDAR derivate" exactly once (found ' + derivateLabels + ')');

// The row must still live inside the European LiDAR mount so the panel layout,
// the viewport filter and the country filter keep finding it.
const europeanBlock = html.slice(html.indexOf('id="lidarEuropeanSubLayers"'),
                                 html.indexOf('/lidarEuropeanSubLayers'));
assert(europeanBlock.includes('id="lidarDerivateRow"'),
    '#lidarDerivateRow sits inside #lidarEuropeanSubLayers');

console.log('  ✓ index.html: one Hillshade LiDAR derivate row, keyed on `derivate`');

/* ══════════════════════════════════════════════════════════════
   2. LIDAR_SUB_LAYERS: one derivate entry, maxNativeZoom 12
   ══════════════════════════════════════════════════════════════ */
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert(from >= 0 && to > from, 'production section must exist: ' + start);
    return source.slice(from, to);
}

// The sub-layer catalogue, evaluated with the browser globals it reads.
const subLayersCode = section('var LIDAR_SUB_LAYERS = {', 'var LIDAR_COUNTRY_TOGGLE_IDS = {');
const subLayersSandbox = {
    window: {}, console, L: {},
    NETHERLANDS_LIDAR_DEFAULT_MODE: 'dtm', NORWAY_LIDAR_DEFAULT_MODE: 'dtm',
    POLAND_LIDAR_DEFAULT_MODE: 'cieniowanie', SPAIN_LIDAR_DEFAULT_MODE: 'mapa_lidar',
    SWITZERLAND_LIDAR_DEFAULT_MODE: 'dtm', UK_LIDAR_DEFAULT_MODE: 'hillshade',
    DENMARK_LIDAR_DEFAULT_MODE: 'terrain', SWEDEN_LIDAR_DEFAULT_MODE: 'terrangskuggning'
};
vm.runInNewContext(
    subLayersCode.replace('var LIDAR_SUB_LAYERS = {', 'result = {') + ';',
    subLayersSandbox
);
const probe = subLayersSandbox.result;
const keys = Object.keys(probe);
const derivateKeys = keys.filter(k => /^derivate/.test(k));
assert.deepStrictEqual(derivateKeys, ['derivate'],
    'exactly one derivate key in LIDAR_SUB_LAYERS (got ' + derivateKeys.join(', ') + ')');

const cfg = probe.derivate;
assert(cfg.url && cfg.url.includes(MAPTILER_HILLSHADE), 'the row still points at MapTiler Hillshade');
assert.strictEqual(cfg.maxNativeZoom, 12,
    'maxNativeZoom is 12 — the tileset real maxzoom (18 asked for tiles that do not exist)');
assert(!('maxZoom' in cfg), 'the xyz builder owns maxZoom (20) — only maxNativeZoom is declared');
assert.strictEqual(cfg.minZoom, 0, 'global raster is available from zoom 0');

// No per-country derivate keys may linger in the toggle map or the attribution
// map either — that is what produced the duplicate panel rows.
assert(!/derivate[A-Z]{2}:/.test(section('var LIDAR_COUNTRY_TOGGLE_IDS = {', 'function _createSelectableEuropeanLidarLayer')),
    'LIDAR_COUNTRY_TOGGLE_IDS carries no derivate<ISO> entries');
assert(/derivate: 'lidarDerivateToggle'/.test(source),
    'LIDAR_COUNTRY_TOGGLE_IDS maps derivate → #lidarDerivateToggle');
assert(!/lidar_derivate[A-Z]{2}:/.test(section('var LAYER_COUNTRIES = {', 'var SHARED_PREMIUM_CATALOG_KEYS')),
    'LAYER_COUNTRIES carries no per-country lidar_derivate<ISO> attribution');

console.log('  ✓ js/map-app.js: single `derivate` layer with maxNativeZoom 12');

/* ══════════════════════════════════════════════════════════════
   3. The builder really hands maxNativeZoom 12 to Leaflet
   ══════════════════════════════════════════════════════════════ */
const builderCode = section('function _buildLidarLeafletLayerRaw(key, cfg) {',
                            'var _lidarGroup = L.layerGroup(');
let captured = null;
const L = {
    tileLayer(url, options) { captured = { url: url, options: options }; return { url: url, options: options }; },
    tileLayerWms: null,
    GridLayer: { extend() { return function () {}; } },
    Util: { getParamString() { return ''; } },
    latLngBounds: b => b,
    CRS: { EPSG3857: {} }
};
L.tileLayer.wms = (url, options) => { captured = { url: url, options: options }; return captured; };
const sandbox = { L: L, window: {}, console: console, LIDAR_DEF_IDS: {}, map: { getZoom: () => 12 } };
vm.runInNewContext(builderCode + '\nresult = _buildLidarLeafletLayerRaw("derivate", __cfg);',
    Object.assign(sandbox, { __cfg: cfg, result: null }));
assert(captured, 'the xyz builder created a tile layer');
assert.strictEqual(captured.options.maxNativeZoom, 12,
    'Leaflet receives maxNativeZoom 12 → it upscales the z12 tile above z12 instead of showing nothing');
assert.strictEqual(captured.options.maxZoom, 20, 'the layer keeps drawing up to the builder maxZoom (20)');
assert(captured.url.includes(MAPTILER_HILLSHADE), 'the tile URL is untouched');

console.log('  ✓ builder forwards maxNativeZoom 12 (relief stays on the map above z12)');

/* ══════════════════════════════════════════════════════════════
   4. The viewport / country filters know the row only once
   ══════════════════════════════════════════════════════════════ */
const boundsCode = section('var LIDAR_DERIVATE_BOUNDS = {', '// Resolve rows on every check');
const boundsSandbox = {};
vm.runInNewContext(boundsCode.replace('var LIDAR_DERIVATE_BOUNDS = {', 'result = {') + ';',
    boundsSandbox);
assert.deepStrictEqual(Object.keys(boundsSandbox.result), ['derivate'],
    'LIDAR_DERIVATE_BOUNDS has a single continent box');

const defsCode = section('Object.keys(INTERNATIONAL_LIDAR_BOUNDS).forEach(function(k) {', '// Premium top-level leaf layers');
assert(/key: 'lidar_derivate'/.test(defsCode), 'one layer-def for the row (key lidar_derivate)');
assert(/countryIndependent: true/.test(defsCode),
    'the row is country-independent: every country view keeps the one global overlay');
assert(!/LIDAR_DERIVATE_BOUNDS\)\.concat/.test(source),
    'the per-country derivate keys are no longer merged into the international layer-defs loop');

console.log('  ✓ filters: one continent-wide, country-independent row');

/* ══════════════════════════════════════════════════════════════
   5. Cache-busting: the page and the service worker agree
   ══════════════════════════════════════════════════════════════ */
assert(html.includes('<script src="' + NEW_TAG + '"></script>'),
    'index.html loads ' + NEW_TAG);
assert(sw.includes("'" + NEW_TAG + "'"), 'sw.js precaches ' + NEW_TAG);
const shellVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 275, 'sw.js cache is v275 or newer (got v' + shellVersion + ')');
assert(!/'js\/map-app\.js\?v=20261026-flat-country-sections'/.test(sw) ||
       html.includes('js/map-app.js?v=20261026-flat-country-sections'),
    'the service worker only precaches tags the page still uses');

console.log('  ✓ cache-busting: index.html and sw.js ship the same tag (v' + shellVersion + ')');

console.log('\nAll Hillshade LiDAR derivate tests passed ✔');
