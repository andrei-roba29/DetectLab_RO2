// Regression checks for the Roman Empire premium sublayers and the reference
// DARE / progressive-roads behavior. No network, browser or npm dependency.
// Usage: node test-roman-reference-layer.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html');
const mapApp = read('js/map-app.js');
const subscriptions = read('js/subscriptions.js');
const sw = read('sw.js');

console.log('[Test] Roman Empire premium layers — DARE and progressive roads...');

// The new Roman controls have actual IDs matching ROMAN_SUB_LAYERS and the
// country-coverage filter; DARE keeps all twenty categories selected by default.
const dareIds = [...html.matchAll(/<input\b[^>]*id="roman_dare_(\d+)"[^>]*>/g)];
assert.strictEqual(dareIds.length, 20, 'exactly twenty DARE category checkboxes are rendered');
assert(dareIds.every(match => /\bchecked\b/.test(match[0])), 'all DARE categories default to checked');
assert(html.includes('id="romanDareAll"') && html.includes('toggleRomanDareCategories(true)'), 'DARE All button is wired');
assert(html.includes('id="romanDareNone"') && html.includes('toggleRomanDareCategories(false)'), 'DARE None button is wired');
assert(html.includes('id="romanDareCountryCode"'), 'manual DARE ISO2 field is rendered');
for (const id of ['roman_places', 'roman_period', 'romanPlacesFile', 'roman_regional_names']) {
    assert(!html.includes('id="' + id + '"'), id + ' is absent from the Roman panel');
}
assert(!mapApp.includes('pleiades') && !mapApp.includes('regional_names'),
    'removed sublayers cannot be loaded through the Roman layer');
assert(html.includes('id="roman_walls"') && html.includes('id="roman_roads"'), 'Walls and Roman roads remain available');
assert(html.includes('id="roman_shade_herod"') && html.includes("toggleRomanSub('shade_herod',this.checked)"), 'Herod layer toggle is wired');
assert(html.includes('id="roman_shade_hasmonean"') && html.includes("toggleRomanSub('shade_hasmonean',this.checked)"), 'Hasmonean layer toggle is wired');
console.log('  ✓ DARE categories, ISO2 reload control and remaining Roman markup verified');

// The renderer and controls must be connected to one load path, and a changed
// ISO2 code must clear the previous response/dedupe state and request new sites.
assert(/dare_11:\s*\{[^}]*enabled:\s*true/.test(mapApp), 'DARE data starts enabled in ROMAN_SUB_LAYERS');
assert(mapApp.includes("_dareCountryInput.addEventListener('change'"), 'ISO2 changes reload DARE');
assert(mapApp.includes("map.on('moveend zoomend', function ()"), 'DARE requests follow viewport pan/zoom changes');
assert(mapApp.includes("_clearDareSites();"), 'changing ISO2 clears old sites and dedupe IDs');
assert(mapApp.includes('requestVersion !== _dareRequestVersion'), 'stale in-flight DARE responses are ignored after ISO2 changes');
assert(mapApp.includes("'&cc=' + encodeURIComponent(cc)"), 'the selected ISO2 is sent as the DARE cc parameter');
assert(mapApp.includes("interactive: false"), 'remaining static Roman linework is non-interactive');
assert(mapApp.includes('function _dareIconSvg(type, size)'), 'map and legend use a shared scalable DARE icon');
assert(mapApp.includes('className: \'dare-icon-marker\''), 'DARE uses the category marker icon');
assert(mapApp.includes('filter: isShade ? null : function (feature) { return _romanFeatureInBounds(feature); }'),
    'Leaflet layer callback cannot confuse its second layer argument with the DARE ISO override');
console.log('  ✓ DARE category icons, viewport reload and Roman sublayer dispatch verified');

// Roads no longer become one L.polyline (and therefore one SVG <path>) per
// segment on the main thread — that is what froze the tab and killed the page.
// They are parsed off-thread into typed arrays and painted on canvas tiles, so
// the loader contract is now: a worker-backed parser, a canvas grid layer, and
// progress expressed in segments + bytes rather than a byte percentage alone.
assert(mapApp.includes('var ROMAN_ROADS_URL =') && mapApp.includes('.ndjson'), 'Roman routes use the reference NDJSON asset');
assert(mapApp.includes("if (cfg.type === 'ndjson') { _loadRomanRoads(); return; }"), 'roads are connected to the Roman layer toggle');
assert(mapApp.includes('window.DetectLabRomanRoads.load(ROMAN_ROADS_URL'), 'the shared loader owns the stream');
assert(mapApp.includes('factory.createLayer({') && mapApp.includes("pane: 'pane_roman'"), 'roads are painted by a canvas grid layer in the Roman pane');
assert(!mapApp.includes('_readNdjsonStream') && !mapApp.includes('_roadStyle') && !mapApp.includes('_thinPath'),
    'no per-segment Leaflet/SVG path loader is left behind');
assert(mapApp.includes("_romanStatus('roads', 'Roads: ' + parts.join(' · '))"), 'live progress is reported while data arrives');
assert(mapApp.includes("'Roads: ' + segs.toLocaleString() + ' segments loaded.'"), 'final segment count is reported');
assert(mapApp.includes("onError: function (message)"), 'stream failures are surfaced instead of leaving the layer blank');
// The parser/loader/worker must be shipped and cached, otherwise the map falls
// back to the message above ("loader not loaded").
const loader = read('js/roman-roads.js');
const parser = read('js/roman-roads-parser.js');
const worker = read('js/roman-roads-worker.js');
assert(loader.includes('DetectLabRomanRoads') && loader.includes('mainThread'), 'loader exposes a main-thread fallback');
assert(parser.includes('createCollector') && parser.includes('rdpMask'), 'parser turns records into simplified typed arrays');
assert(worker.includes('importScripts') && worker.includes('roman-roads-parser.js'), 'worker loads the shared parser');
for (const asset of ['js/roman-roads.js', 'js/roman-roads-parser.js', 'js/roman-roads-worker.js']) {
    assert(sw.includes(asset), 'service worker precaches ' + asset);
}
console.log('  ✓ worker/canvas road loading and visible progress preserved');

// Premium users only may activate Roman/CENAGIS layers through either the UI
// capture guard or direct JavaScript toggles.
assert(subscriptions.includes("'toggleRomanSub'"), 'Roman sublayer API is premium-gated');
assert(subscriptions.includes("'toggleRomanDareCategories'"), 'DARE All/None API is premium-gated');
assert(subscriptions.includes('euMaps.toggleCenagisLayer = function (mapKey, on)'), 'CENAGIS catalog toggle is premium-gated');
assert(html.includes('js/map-app.js?v=20261030-roman-layer-cleanup'), 'index.html loads the 2D compatibility map-app script');
assert(sw.includes('js/map-app.js?v=20261030-roman-layer-cleanup'), 'current map-app script is in the service-worker cache');
assert(html.includes('js/roman-roads.js?v=20261015-roman-roads'), 'index.html loads the Roman-roads canvas layer');
assert(sw.includes('js/roman-roads.js?v=20261015-roman-roads'), 'the Roman-roads layer is in the service-worker cache');
assert(sw.includes('js/subscriptions.js?v=20261024-uk-historical-maps'), 'premium guard script is in the service-worker cache');
assert(sw.includes('css/styles.css?v=20261024-asig-catalogue'), 'DARE marker CSS is in the service-worker cache');
console.log('  ✓ Premium guards and PWA asset versions verified');

console.log('✅ test-roman-reference-layer.js passed all checks successfully.');
