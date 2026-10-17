// Regression checks for the Roman Empire premium sublayers and the reference
// DARE / progressive-roads behavior. No network, browser or npm dependency.
// Usage: node test-roman-reference-layer.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html');
const mapApp = read('js/map-app.js');
const subscriptions = read('js/subscriptions.js');
const sw = read('sw.js');

console.log('[Test] Roman Empire premium layers — DARE, Pleiades and progressive roads...');

// The new Roman controls have actual IDs matching ROMAN_SUB_LAYERS and the
// country-coverage filter; DARE keeps all twenty categories selected by default.
const dareIds = [...html.matchAll(/<input\b[^>]*id="roman_dare_(\d+)"[^>]*>/g)];
assert.strictEqual(dareIds.length, 20, 'exactly twenty DARE category checkboxes are rendered');
assert(dareIds.every(match => /\bchecked\b/.test(match[0])), 'all DARE categories default to checked');
assert(html.includes('id="romanDareAll"') && html.includes('toggleRomanDareCategories(true)'), 'DARE All button is wired');
assert(html.includes('id="romanDareNone"') && html.includes('toggleRomanDareCategories(false)'), 'DARE None button is wired');
assert(html.includes('id="romanDareCountryCode"'), 'manual DARE ISO2 field is rendered');
assert(html.includes('id="roman_places"') && html.includes("toggleRomanSub('places',this.checked)"), 'Pleiades toggle uses the Roman sublayer API');
assert(html.includes('id="roman_period"') && html.includes('setRomanPlacesPeriod(this.value)'), 'Pleiades period selector is wired');
assert(html.includes('id="romanPlacesFile"'), 'Pleiades CSV.GZ fallback picker is available');
assert(html.includes('id="roman_regional_names"') && html.includes("toggleRomanSub('regional_names',this.checked)"), 'AWMC regional names toggle is wired');
assert(html.includes('id="roman_shade_herod"') && html.includes("toggleRomanSub('shade_herod',this.checked)"), 'Herod layer toggle is wired');
assert(html.includes('id="roman_shade_hasmonean"') && html.includes("toggleRomanSub('shade_hasmonean',this.checked)"), 'Hasmonean layer toggle is wired');
console.log('  ✓ DARE categories, ISO2 reload control, Pleiades, Regional names, Herod and Hasmonean markup verified');

// The renderer and controls must be connected to one load path, and a changed
// ISO2 code must clear the previous response/dedupe state and request new sites.
assert(/dare_11:\s*\{[^}]*enabled:\s*true/.test(mapApp), 'DARE data starts enabled in ROMAN_SUB_LAYERS');
assert(mapApp.includes("if (cfg.type === 'pleiades') { _loadRomanPleiades(); return; }"), 'Pleiades is dispatched from the master Roman loader');
assert(mapApp.includes("_dareCountryInput.addEventListener('change'"), 'ISO2 changes reload DARE');
assert(mapApp.includes("map.on('moveend zoomend', function ()"), 'DARE requests follow viewport pan/zoom changes');
assert(mapApp.includes("_clearDareSites();"), 'changing ISO2 clears old sites and dedupe IDs');
assert(mapApp.includes('requestVersion !== _dareRequestVersion'), 'stale in-flight DARE responses are ignored after ISO2 changes');
assert(mapApp.includes("'&cc=' + encodeURIComponent(cc)"), 'the selected ISO2 is sent as the DARE cc parameter');
assert(mapApp.includes("interactive: key === 'regional_names'"), 'Roman linework is interactive only where it needs labels');
assert(mapApp.includes('function _dareIconSvg(type, size)'), 'map and legend use a shared scalable DARE icon');
assert(mapApp.includes('className: \'dare-icon-marker\''), 'DARE uses the category marker icon');
assert(mapApp.includes('filter: isShade ? null : function (feature) { return _romanFeatureInBounds(feature); }'),
    'Leaflet layer callback cannot confuse its second layer argument with the DARE ISO override');
console.log('  ✓ DARE category icons, viewport reload and Roman sublayer dispatch verified');

// Parse the production parser helpers against a BOM-prefixed CSV containing
// commas/quotes, three supported period families and one excluded period.
const parserStart = mapApp.indexOf('function _parseRomanCsv(text)');
const parserEnd = mapApp.indexOf('function _bytesToRomanText(buffer)', parserStart);
assert(parserStart >= 0 && parserEnd > parserStart, 'Pleiades parser functions exist');
const parserSandbox = {};
vm.createContext(parserSandbox);
vm.runInContext(mapApp.slice(parserStart, parserEnd), parserSandbox);
const csv = '\uFEFFid,title,description,featureTypes,reprLat,reprLong,timePeriodsKeys,timePeriods\n' +
    'p1,"Roman, site","A \"\"quoted\"\" note",settlement,44.2,26.1,R,Roman\n' +
    'p2,Hellenistic site,description,settlement,43.1,24.2,H,Hellenistic\n' +
    'p3,Late site,description,settlement,42.0,23.0,L,Late Antique\n' +
    'p4,Medieval site,description,settlement,41.0,22.0,M,Medieval\n';
const places = parserSandbox._parsePleiadesCsv(csv);
assert.deepStrictEqual(Array.from(places, p => p.pid), ['p1', 'p2', 'p3'], 'parser accepts only Roman/Hellenistic/Late Antique records');
assert.strictEqual(places[0].title, 'Roman, site', 'quoted CSV commas are parsed correctly');
assert.strictEqual(places[0].description, 'A "quoted" note', 'escaped CSV quotes are parsed correctly');
assert.strictEqual(places[0].R, 1);
assert.strictEqual(places[1].H, 1);
assert.strictEqual(places[2].L, 1);
assert(mapApp.includes("x.replace(/^\\uFEFF/, '').trim().toLowerCase()"), 'CSV header BOM is removed');
console.log('  ✓ Pleiades CSV parser handles UTF-8 BOM, quotes and period filtering');

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
assert(html.includes('js/map-app.js?v=20261017-albania-asig'), 'index.html loads the 2D compatibility map-app script');
assert(sw.includes('js/map-app.js?v=20261017-albania-asig'), 'current map-app script is in the service-worker cache');
assert(html.includes('js/roman-roads.js?v=20261015-roman-roads'), 'index.html loads the Roman-roads canvas layer');
assert(sw.includes('js/roman-roads.js?v=20261015-roman-roads'), 'the Roman-roads layer is in the service-worker cache');
assert(sw.includes('js/subscriptions.js?v=20261008-premium-roman-guard'), 'premium guard script is in the service-worker cache');
assert(sw.includes('css/styles.css?v=20261017-albania-asig'), 'DARE marker CSS is in the service-worker cache');
console.log('  ✓ Premium guards and PWA asset versions verified');

console.log('✅ test-roman-reference-layer.js passed all checks successfully.');
