// Smoke test for the two ArcGIS-hosted premium historical maps:
//   · Harta Transilvaniei 1859        (Siebenburgen_1859 MapServer, LOD 7-14)
//   · Hartă administrativă a Galiției și Lodomeriei – 1855 (Kummerer_1855, LOD 6-14)
//
// Verifies:
//   1. Leaflet layers point at the ArcGIS tiled services with the correct
//      native zoom range and per-service bounds.
//   2. The UI rows live inside PREMIUM → Harti istorice (histPremiumSubLayers)
//      with the exact requested names, opacity sliders and info buttons
//      carrying the required copyright texts plus the digitization credit
//      (Universitatea „Ștefan cel Mare” din Suceava · sursă bukowina1856.eu).
//   3. Premium gating: rows are registered with the premium group, and the
//      toggle functions are wrapped by subscriptions.js PREMIUM_TOGGLE_FNS.
//   4. Red coverage rectangle shows whenever the zoom is OUTSIDE the
//      service's available LOD interval (runtime simulation of
//      updatePremiumMapCoverageVisibility).
//
// Run: node test-premium-historical-arcgis-maps.js  (from repo root)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

const mapApp = read('js/map-app.js');
const subscriptions = read('js/subscriptions.js');
const translations = read('js/translations.js');
const html = read('index.html');

/* The two XYZ endpoints are defined ONCE in the shared layer registry
 * (js/layer-registry.js, entries premium.transylvania-1859 / premium.galicia-1855)
 * — the 2D map, the 3D terrain view and the tile proxy all read them from
 * there. See MAP_3D_TERRAIN.md. */
const registry = require('./js/layer-registry.js');

console.log('[Test] Premium historical maps — Transilvania 1859 & Galiția 1855 (ArcGIS tiles)...');

// ── 1. Layer sources (Tiled Map Services, org t2AVhHhEnEvHcPF6) ─────
assert.match(
    registry.get('premium.transylvania-1859').url,
    /tiles\.arcgis\.com\/tiles\/t2AVhHhEnEvHcPF6\/arcgis\/rest\/services\/Siebenburgen_1859\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/,
    'Transylvania 1859 must use the ArcGIS Siebenburgen_1859 MapServer XYZ tile endpoint ({z}/{row}/{col})'
);
assert.match(
    registry.get('premium.galicia-1855').url,
    /tiles\.arcgis\.com\/tiles\/t2AVhHhEnEvHcPF6\/arcgis\/rest\/services\/Kummerer_1855\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}/,
    'Galicia 1855 must use the ArcGIS Kummerer_1855 MapServer XYZ tile endpoint ({z}/{row}/{col})'
);
assert.match(mapApp, /DL\.url2d\('premium\.transylvania-1859'\)/, 'map-app.js builds Transylvania from the registry');
assert.match(mapApp, /DL\.url2d\('premium\.galicia-1855'\)/, 'map-app.js builds Galicia from the registry');

// Native zoom ranges match the service LODs (Siebenburgen 7-14, Kummerer 6-14).
const transylvaniaBlock = mapApp.slice(mapApp.indexOf('_transylvania1859MapLayer = L.tileLayer'), mapApp.indexOf('window.toggleTransylvania1859Map'));
assert.match(transylvaniaBlock, /minZoom:\s*7/, 'Transylvania tiles begin at z7 (service minLOD 7)');
assert.match(transylvaniaBlock, /maxNativeZoom:\s*window\.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z/, 'Transylvania native ceiling is tunable, defaults from window constant');
assert.match(transylvaniaBlock, /pane:\s*'pane_transylvania1859'/, 'Transylvania renders in its own dedicated pane');
assert.match(transylvaniaBlock, /bounds:\s*TRANSYLVANIA1859_BOUNDS/, 'Transylvania tile requests are limited to the service fullExtent');

const galiciaBlock = mapApp.slice(mapApp.indexOf('_galicia1855MapLayer = L.tileLayer'), mapApp.indexOf('window.toggleGalicia1855Map'));
assert.match(galiciaBlock, /minZoom:\s*6/, 'Galicia tiles begin at z6 (service minLOD 6)');
assert.match(galiciaBlock, /maxNativeZoom:\s*window\.GALICIA1855_TILE_MAX_NATIVE_Z/, 'Galicia native ceiling is tunable, defaults from window constant');
assert.match(galiciaBlock, /pane:\s*'pane_galicia1855'/, 'Galicia renders in its own dedicated pane');
assert.match(galiciaBlock, /bounds:\s*GALICIA1855_BOUNDS/, 'Galicia tile requests are limited to the service fullExtent');

// Both default their native ceiling to 14 (service maxLOD 14).
assert.match(mapApp, /TRANSYLVANIA1859_TILE_MAX_NATIVE_Z !== undefined[^;]*:\s*14/, 'Transylvania maxNativeZoom defaults to 14');
assert.match(mapApp, /GALICIA1855_TILE_MAX_NATIVE_Z !== undefined[^;]*:\s*14/, 'Galicia maxNativeZoom defaults to 14');

// ── 2. Coverage bounds + exact names ────────────────────────────────
assert.match(mapApp, /transylvania1859:\s*\{[^}]*bounds:\s*\[\[45\.2059,\s*22\.2319\],\s*\[47\.7300,\s*26\.7037\]\]/,
    'Transylvania coverage bounds = service fullExtent in WGS84');
assert.match(mapApp, /galicia1855:\s*\{[^}]*bounds:\s*\[\[46\.8116,\s*18\.3937\],\s*\[50\.8713,\s*26\.6844\]\]/,
    'Galicia coverage bounds = service fullExtent in WGS84');
assert.match(mapApp, /label:\s*'Harta Transilvaniei 1859'/, 'coverage popup label uses the exact Transylvania name');
assert.match(mapApp, /label:\s*'Hartă administrativă a Galiției și Lodomeriei – 1855'/, 'coverage popup label uses the exact Galicia name');
assert.match(mapApp, /layerVar:\s*'_transylvania1859MapLayer'/, 'coverage entry wired to the Transylvania layer');
assert.match(mapApp, /layerVar:\s*'_galicia1855MapLayer'/, 'coverage entry wired to the Galicia layer');
assert.match(mapApp, /transylvania1859:[\s\S]{0,900}coverageMinZoom:\s*7/, 'Transylvania rectangle hides only from z7');
assert.match(mapApp, /transylvania1859:[\s\S]{0,900}coverageMaxZoom:\s*14/, 'Transylvania rectangle returns above z14');
assert.match(mapApp, /galicia1855:[\s\S]{0,900}coverageMinZoom:\s*6/, 'Galicia rectangle hides only from z6');
assert.match(mapApp, /galicia1855:[\s\S]{0,900}coverageMaxZoom:\s*14/, 'Galicia rectangle returns above z14');

// ── 3. UI rows inside PREMIUM → Harti istorice ──────────────────────
const subStart = html.indexOf('id="histPremiumSubLayers"');
const subEnd = html.indexOf('/histPremiumSubLayers');
assert.ok(subStart > -1 && subEnd > subStart, 'histPremiumSubLayers panel exists');
const subPanel = html.slice(subStart, subEnd);

for (const id of [
    'transylvania1859Row', 'transylvania1859MapToggle', 'transylvania1859MapOpacitySlider', 'transylvania1859MapPct',
    'galicia1855Row', 'galicia1855MapToggle', 'galicia1855MapOpacitySlider', 'galicia1855MapPct'
]) {
    assert.ok(subPanel.includes('"' + id + '"'), id + ' must live inside the premium historical-maps sublayer panel');
}
assert.ok(subPanel.includes('onchange="toggleTransylvania1859Map(this.checked)"'), 'Transylvania toggle wired to toggleTransylvania1859Map');
assert.ok(subPanel.includes('onchange="toggleGalicia1855Map(this.checked)"'), 'Galicia toggle wired to toggleGalicia1855Map');
assert.ok(subPanel.includes('oninput="setTransylvania1859MapOpacity(this.value)"'), 'Transylvania opacity slider wired');
assert.ok(subPanel.includes('oninput="setGalicia1855MapOpacity(this.value)"'), 'Galicia opacity slider wired');

// Exact display names (data-key fallback text and translation entries).
assert.ok(subPanel.includes('>Harta Transilvaniei 1859</span>'), 'exact Transylvania name in the panel');
assert.ok(subPanel.includes('>Hartă administrativă a Galiției și Lodomeriei – 1855</span>'), 'exact Galicia name in the panel');
for (const lang of ['en', 'ro']) {
    const block = translations.split(/(^|\n)\s{12}(?:en|ro):\s*\{/); // cheap split sanity
    void block;
}
assert.match(translations, /layer_transylvania1859:\s*'Harta Transilvaniei 1859'/, 'translation key for Transylvania (exact name)');
assert.match(translations, /layer_galicia1855:\s*'Hartă administrativă a Galiției și Lodomeriei – 1855'/, 'translation key for Galicia (exact name)');
// Both languages carry the keys (en block ~line 3.., ro block after).
const enBlock = translations.slice(translations.indexOf('en: {'), translations.indexOf('ro: {'));
const roBlock = translations.slice(translations.indexOf('ro: {'));
assert.ok(enBlock.includes('layer_transylvania1859') && enBlock.includes('layer_galicia1855'), 'en locale has the new layer keys');
assert.ok(roBlock.includes('layer_transylvania1859') && roBlock.includes('layer_galicia1855'), 'ro locale has the new layer keys');

// Info buttons with the mandatory copyright texts.
const TRANSYLVANIA_INFO = '© Administrativ Karte des Grossfürstenthums Siebenbürgen nach der neuesten Landeseintheilung (1859; 1:144 000, 1 w.zoll= 2000 w. klaftern)';
const GALICIA_INFO = '© Administrativ-Karte von den Königreichen Galizien und Lodomerien mit dem Grossherzogthume Krakau und den Herzogthümern Auschwitz, Zator und Bukowina : in 60 Blättern - Carl von Kummersberg 1855';
// Digitization / publication credit + source, required on both maps.
const DIGITIZATION_CREDIT = 'Digitalizare și publicare: Universitatea „Ștefan cel Mare” din Suceava';
const SOURCE_CREDIT = 'Sursă: bukowina1856.eu';

assert.ok(subPanel.includes(`showLayerInfo('Harta Transilvaniei 1859','${TRANSYLVANIA_INFO} · ${DIGITIZATION_CREDIT} · ${SOURCE_CREDIT}')`),
    'Transylvania info button carries the required copyright line');
assert.ok(subPanel.includes(`showLayerInfo('Hartă administrativă a Galiției și Lodomeriei – 1855','${GALICIA_INFO} · ${DIGITIZATION_CREDIT} · ${SOURCE_CREDIT}')`),
    'Galicia info button carries the required copyright line');

// The ⓘ popup, the Leaflet attribution and the offline-maps panel all repeat
// the digitization credit and the bukowina1856.eu source.
/* The credit line is DEFINED in the shared registry entry and reaches the 2D
 * layer through DL.tile2dOptions() (so the 3D view shows the very same
 * attribution). Asserting it here keeps every consumer honest. */
[['premium.transylvania-1859', 'Transylvania', transylvaniaBlock],
 ['premium.galicia-1855', 'Galicia', galiciaBlock]].forEach(([id, which, block]) => {
    const attribution = registry.get(id).attribution;
    assert.ok(attribution.includes(DIGITIZATION_CREDIT), which + ' Leaflet attribution credits the USV digitization');
    assert.ok(attribution.includes('bukowina1856.eu'), which + ' Leaflet attribution names bukowina1856.eu as the source');
    assert.match(block, new RegExp("DL\\.tile2dOptions\\('" + id.replace('.', '\\.') + "'"),
        which + ' 2D layer takes its options (incl. the credit) from the registry');
});
const offlineMaps = read('js/offline-maps.js');
for (const id of ['transylvania1859', 'galicia1855']) {
    const entry = offlineMaps.slice(offlineMaps.indexOf(`id: '${id}'`));
    const desc = entry.slice(0, entry.indexOf('onlineKey'));
    assert.ok(desc.includes('bukowina1856.eu') && /Ștefan cel Mare|Suceava/.test(desc),
        'offline-maps description for ' + id + ' carries the digitization credit + source');
}
// The popup renderer turns the source domain into a link (no innerHTML).
assert.ok(html.includes('renderLayerInfoAttribution') && html.includes("LAYER_INFO_SOURCE_DOMAINS = ['bukowina1856.eu']"),
    'ⓘ popup renders bukowina1856.eu as a clickable source link');

// ── 4. Premium gating wiring ────────────────────────────────────────
assert.match(mapApp, /\{\s*key:\s*'transylvania1859',\s*toggle:\s*'transylvania1859MapToggle',\s*row:\s*'transylvania1859Row'\s*\}/,
    'Transylvania registered in the premium visibility-highlight defs');
assert.match(mapApp, /\{\s*key:\s*'galicia1855',\s*toggle:\s*'galicia1855MapToggle',\s*row:\s*'galicia1855Row'\s*\}/,
    'Galicia registered in the premium visibility-highlight defs');
assert.match(mapApp, /\{\s*id:\s*'transylvania1859MapToggle',\s*fnName:\s*'toggleTransylvania1859Map'\s*\}/,
    'Transylvania part of HIST_PREMIUM_SUBLAYER_TOGGLES (master switch turns it off)');
assert.match(mapApp, /\{\s*id:\s*'galicia1855MapToggle',\s*fnName:\s*'toggleGalicia1855Map'\s*\}/,
    'Galicia part of HIST_PREMIUM_SUBLAYER_TOGGLES (master switch turns it off)');
assert.ok(subscriptions.includes("'toggleTransylvania1859Map'"), 'subscriptions.js wraps the Transylvania toggle (premium-only ON)');
assert.ok(subscriptions.includes("'toggleGalicia1855Map'"), 'subscriptions.js wraps the Galicia toggle (premium-only ON)');

// Rows sit inside the data-category="premium" group row → they inherit the
// lock badge + click-block for free users from subscriptions.js.
const groupRow = html.slice(html.indexOf('<!-- Harti Istorice — Parent Group -->'), html.indexOf('/histPremium transp-layer-row'));
assert.ok(groupRow.includes('data-category="premium"'), 'historical-maps group row is premium-categorised');
assert.ok(groupRow.includes('transylvania1859Row') && groupRow.includes('galicia1855Row'), 'both new rows live inside the premium group row');

// ── 5. Runtime simulation of the coverage-rectangle decision ────────
// Extract the real updatePremiumMapCoverageVisibility from map-app.js and
// run it against a fake map at every zoom level.
const fnStart = mapApp.indexOf('window.updatePremiumMapCoverageVisibility = function()');
const fnEnd = mapApp.indexOf("map.on('zoomend', window.updatePremiumMapCoverageVisibility);");
assert.ok(fnStart > -1 && fnEnd > fnStart, 'updatePremiumMapCoverageVisibility found');
const fnSource = mapApp.slice(fnStart, fnEnd);

function runCoverageSim(zoom) {
    const win = {
        _transylvania1859MapLayer: { __id: '_transylvania1859MapLayer' },
        _galicia1855MapLayer: { __id: '_galicia1855MapLayer' }
    };
    const layersOnMap = new Set(['_transylvania1859MapLayer', '_galicia1855MapLayer']);
    const shown = new Set();
    const premiumMapCoverageBounds = {
        transylvania1859: { layerVar: '_transylvania1859MapLayer', coverageMinZoom: 7, coverageMaxZoom: 14 },
        galicia1855: { layerVar: '_galicia1855MapLayer', coverageMinZoom: 6, coverageMaxZoom: 14 }
    };
    const premiumMapCoveragePolygons = {
        transylvania1859: { added: false },
        galicia1855: { added: false }
    };
    const map = {
        getZoom() { return zoom; },
        hasLayer(l) { return layersOnMap.has(l.__id) || !!l.added; },
        on() {},
        removeLayer(l) { l.added = false; }
    };
    premiumMapCoveragePolygons.transylvania1859.__id = 'rect_transylvania1859';
    premiumMapCoveragePolygons.galicia1855.__id = 'rect_galicia1855';
    // rectangles add themselves via addTo(map)
    premiumMapCoveragePolygons.transylvania1859.addTo = function (m) { this.added = true; shown.add('transylvania1859'); return this; };
    premiumMapCoveragePolygons.galicia1855.addTo = function (m) { this.added = true; shown.add('galicia1855'); return this; };

    // Evaluate the real function body in this sandbox.
    const runner = new Function('window', 'map', 'premiumMapCoverageBounds', 'premiumMapCoveragePolygons',
        fnSource + '\nwindow.updatePremiumMapCoverageVisibility();');
    runner(win, map, premiumMapCoverageBounds, premiumMapCoveragePolygons);
    return shown;
}

// Transylvania: rectangle below z7 and above z14, hidden for z7..z14.
for (let z = 3; z <= 20; z++) {
    const shown = runCoverageSim(z);
    const expectT = z < 7 || z > 14;
    const expectG = z < 6 || z > 14;
    assert.strictEqual(shown.has('transylvania1859'), expectT,
        'Transylvania red rectangle at z' + z + ' (expected ' + expectT + ')');
    assert.strictEqual(shown.has('galicia1855'), expectG,
        'Galicia red rectangle at z' + z + ' (expected ' + expectG + ')');
}

// ── 6. Service worker already caches tiles.arcgis.com (offline-safe) ─
assert.ok(read('sw.js').includes('tiles.arcgis.com'), 'sw.js allowlist covers tiles.arcgis.com');

console.log('  ✓ tile endpoints (Siebenburgen_1859 z7-14, Kummerer_1855 z6-14) + service bounds');
console.log('  ✓ exact names + copyright info popups inside PREMIUM → Harti istorice');
console.log('  ✓ digitization credit (Universitatea „Ștefan cel Mare” din Suceava · bukowina1856.eu)');
console.log('    in the ⓘ popup, the Leaflet attribution and the offline-maps descriptions');
console.log('  ✓ premium gating (group category, master switch, wrapped toggles)');
console.log('  ✓ red coverage rectangle whenever zoom is outside the available LOD range');
console.log('OK — ArcGIS premium historical maps wired correctly.');
