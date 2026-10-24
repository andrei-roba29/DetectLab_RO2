// Smoke test for the eight premium UK historical maps hosted on MapTiler
// (National Library of Scotland collection):
//   · Ordnance Survey 1893-1896 (London five-foot, uk-oslondon1k1893)
//   · Ordnance Survey Historical Maps 1919-1947 (uk-osgb1919)
//   · Ordnance Survey 1888-1913 (County Series six-inch, uk-osgb10k1888)
//   · Ordnance Survey 1937-1961 (Provisional 1:25,000, uk-osgb25k1937)
//   · Ordnance Survey 'Hills' edition 1885-1903 (uk-osgb63k1885, PNG overlay)
//   · Ordnance Survey 1955-1961 (Seventh Series, uk-osgb63k1955)
//   · Ordnance Survey 1900s (seamless multi-scale hybrid, uk-osgb1888)
//   · UK Bartholomew Ireland 1940s (uk-baire250k1940, PNG overlay)
//
// Verifies:
//   1. Shared registry entries (URLs incl. the MapTiler key + tile set,
//      native zoom windows, service bounds, NLS attribution, CORS/proxy).
//   2. 2D wiring in map-app.js: dedicated panes, registry-built L.tileLayer,
//      toggle/opacity globals, coverage-rectangle zoom windows, viewport
//      filter rows, master-switch list and country attribution.
//   3. UI rows inside PREMIUM → Historical maps (histPremiumSubLayers) with
//      the exact requested names, toggles, opacity sliders and ⓘ credits.
//   4. Premium gating: wrapped toggle functions and the master-switch list.
//   5. Translation keys in every shipped language block.
//   6. Offline-maps catalogue entries and service-worker precache/cache bump.
//   7. Runtime simulation of the coverage-rectangle decision (red rectangle
//      only while the layer is on AND outside the service zoom window).
//
// Run: node test-premium-uk-historical-maps.js  (from repo root)
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
const sw = read('sw.js');
const offlineMaps = read('js/offline-maps.js');
const registry = require('./js/layer-registry.js');

const MAPTILER_KEY = 'lJtTFcjiimg8ZwMPUfpf';

/* name: exact UI label · key: map-app / coverage / viewport key
 * reg: registry id · set: MapTiler tile set · ext: tile extension
 * min/max: TileJSON minzoom/maxzoom (native ceiling) · pane z-index */
const LAYERS = [
    { name: 'Ordnance Survey 1893-1896', key: 'ukOsLondon1893', reg: 'premium.uk-os-london-1893', set: 'uk-oslondon1k1893', ext: '.jpg', min: 9, max: 20, z: 660, countries: ['GB'] },
    { name: 'Ordnance Survey Historical Maps 1919-1947', key: 'ukOs1919', reg: 'premium.uk-os-gb-1919', set: 'uk-osgb1919', ext: '.jpg', min: 1, max: 14, z: 661, countries: ['GB'] },
    { name: 'Ordnance Survey 1888-1913', key: 'ukOs10k1888', reg: 'premium.uk-os-10k-1888', set: 'uk-osgb10k1888', ext: '.jpg', min: 1, max: 17, z: 662, countries: ['GB'] },
    { name: 'Ordnance Survey 1937-1961', key: 'ukOs25k1937', reg: 'premium.uk-os-25k-1937', set: 'uk-osgb25k1937', ext: '.jpg', min: 1, max: 16, z: 663, countries: ['GB'] },
    { name: "Ordnance Survey, 'Hills' edition, 1885-1903", key: 'ukOsHills1885', reg: 'premium.uk-os-hills-1885', set: 'uk-osgb63k1885', ext: '.png', min: 1, max: 16, z: 664, countries: ['GB'] },
    { name: 'Ordnance Survey 1955-1961', key: 'ukOs63k1955', reg: 'premium.uk-os-63k-1955', set: 'uk-osgb63k1955', ext: '.jpg', min: 1, max: 15, z: 665, countries: ['GB'] },
    { name: 'Ordnance Survey 1900s', key: 'ukOs1900s', reg: 'premium.uk-os-1900s', set: 'uk-osgb1888', ext: '', min: 1, max: 17, z: 666, countries: ['GB', 'IE'] },
    { name: 'UK Bartholomew Ireland 1940s', key: 'ukBaire1940', reg: 'premium.uk-bartholomew-ireland-1940', set: 'uk-baire250k1940', ext: '.png', min: 5, max: 12, z: 667, countries: ['IE', 'GB'] }
];

const cap = key => key.replace(/^[a-z]/, c => c.toUpperCase());
const i18nKey = cfg => ({
    ukOsLondon1893: 'layer_uk_os_london1893',
    ukOs1919: 'layer_uk_os_1919',
    ukOs10k1888: 'layer_uk_os_10k1888',
    ukOs25k1937: 'layer_uk_os_25k1937',
    ukOsHills1885: 'layer_uk_os_hills1885',
    ukOs63k1955: 'layer_uk_os_63k1955',
    ukOs1900s: 'layer_uk_os_1900s',
    ukBaire1940: 'layer_uk_baire_1940'
}[cfg.key]);

console.log('[Test] Premium UK historical maps — Ordnance Survey / Bartholomew (MapTiler / NLS)...');

// ── 1. Shared registry ────────────────────────────────────────────────
LAYERS.forEach(function (cfg) {
    const def = registry.get(cfg.reg);
    assert.ok(def, cfg.reg + ' is registered');
    assert.strictEqual(def.group, 'hist-premium', cfg.key + ' sits in the hist-premium group');
    assert.strictEqual(def.z, cfg.z, cfg.key + ' draw order z=' + cfg.z);
    assert.strictEqual(def.kind, 'xyz', cfg.key + ' is an XYZ raster layer');

    // URL: exact MapTiler tile set, extension (hybrid layer is extensionless)
    // and the API key.
    const expectedPath = 'api.maptiler.com/tiles/' + cfg.set + '/{z}/{x}/{y}' + cfg.ext;
    assert.ok(def.url.indexOf('https://' + expectedPath) === 0,
        cfg.key + ' tile URL points at ' + expectedPath + ' (got ' + def.url + ')');
    assert.ok(def.url.indexOf('key=' + MAPTILER_KEY) !== -1, cfg.key + ' carries the MapTiler API key');
    assert.strictEqual(def.minZoom, cfg.min, cfg.key + ' minZoom=' + cfg.min + ' (TileJSON)');
    assert.strictEqual(def.maxNativeZoom, cfg.max, cfg.key + ' maxNativeZoom=' + cfg.max + ' (TileJSON maxzoom)');
    assert.strictEqual(def.maxZoom, 20, cfg.key + ' stays available on the map through z20 (over-zoom)');
    assert.ok(Array.isArray(def.bounds) && def.bounds.length === 2, cfg.key + ' carries service bounds');

    // National Library of Scotland attribution + MapTiler, everywhere.
    assert.ok(/National Library of Scotland/.test(def.attribution), cfg.key + ' credits the National Library of Scotland');
    assert.ok(/maps\.nls\.uk/.test(def.attribution), cfg.key + ' attribution links to maps.nls.uk');
    assert.ok(/MapTiler/.test(def.attribution), cfg.key + ' credits MapTiler');

    // MapTiler sends CORS headers, so the 3D view fetches it directly.
    assert.strictEqual(def.cors, 'yes', cfg.key + ' is CORS-enabled');
    assert.strictEqual(registry.hostPolicy()['api.maptiler.com'], 'never',
        'api.maptiler.com is never sent through the same-origin proxy');

    // UI wiring names match the 2D globals the panel calls.
    assert.strictEqual(def.ui.toggle, cfg.key + 'MapToggle', cfg.key + ' ui.toggle');
    assert.strictEqual(def.ui.slider, cfg.key + 'MapOpacitySlider', cfg.key + ' ui.slider');
    assert.strictEqual(def.ui.pct, cfg.key + 'MapPct', cfg.key + ' ui.pct');
    assert.strictEqual(def.ui.fn, 'toggle' + cap(cfg.key) + 'Map', cfg.key + ' ui.fn');
    assert.strictEqual(def.ui.var2d, '_' + cfg.key + 'MapLayer', cfg.key + ' ui.var2d');
    assert.strictEqual(def.ui.parent, 'histPremiumToggle', cfg.key + ' belongs to the Historical maps master switch');
});

// Every registry URL is matchable back from a live 2D tile layer (3D mirror).
LAYERS.forEach(function (cfg) {
    const def = registry.get(cfg.reg);
    const matched = registry.matchDef({ url: def.url });
    assert.ok(matched && matched.id === cfg.reg, cfg.key + ' live layer matches its registry definition');
});

// ── 2. 2D wiring in map-app.js ────────────────────────────────────────
const ukBlock = mapApp.slice(mapApp.indexOf('UNITED KINGDOM — ORDNANCE SURVEY'), mapApp.indexOf('SATELIT 60s (CORONA)'));
assert.ok(ukBlock.length > 800, 'UK layer factory block exists in map-app.js');
assert.ok(/UK_OS_LAYERS\s*=\s*\[/.test(ukBlock), 'the eight layers are declared in one UK_OS_LAYERS table');

// The factory is data-driven: pane names, window variables and globals are
// built from the config keys instead of being spelled out eight times.
assert.match(ukBlock, /var paneName = 'pane_' \+ cfg\.key/, 'pane name is built as pane_<key>');
assert.match(ukBlock, /map\.createPane\(paneName\)/, 'each UK layer creates its own pane');
assert.match(ukBlock, /getPane\(paneName\)\.style\.zIndex = cfg\.z/, 'pane z-index comes from the config table');
assert.match(ukBlock, /window\['_' \+ cfg\.key \+ 'MapLayer'\]/, 'window layer variable is built from the key');
assert.match(ukBlock, /window\['toggle' \+ cfg\.key\.replace\(\/\^\[a-z\]\//, 'toggle global name is built from the key');
assert.match(ukBlock, /window\['set' \+ cfg\.key\.replace\(\/\^\[a-z\]\//, 'opacity global name is built from the key');

LAYERS.forEach(function (cfg) {
    const def = registry.get(cfg.reg);
    // Registry-driven, not a hard-coded second URL.
    assert.ok(ukBlock.indexOf("reg: '" + cfg.reg + "'") !== -1, cfg.key + ' table row references its registry id');
    assert.ok(new RegExp("key: '" + cfg.key + "'[^}]*maxNative: " + cfg.max + "[^}]*minZoom: " + cfg.min + "[^}]*z: " + cfg.z).test(ukBlock),
        cfg.key + ' config carries minZoom ' + cfg.min + ', native ceiling ' + cfg.max + ' and pane z ' + cfg.z);
    // Live tunable native ceiling: the literal global name lives in the
    // registry ui config; map-app builds and reads it per row.
    const constName = cap(cfg.key).toUpperCase() + '_TILE_MAX_NATIVE_Z';
    assert.strictEqual(def.ui.maxNativeZoomGlobal, constName, cfg.key + ' native-ceiling constant ' + constName);
    // Bounds/zoom come from the registry entry itself.
    assert.strictEqual(def.maxNativeZoom, cfg.max, 'registry native ceiling agrees with the TileJSON');
});
assert.match(ukBlock, /_TILE_MAX_NATIVE_Z'/, 'map-app reads the per-layer native-ceiling global');

// One generic L.tileLayer call, built from DL.url2d/DL.tile2dOptions.
assert.match(ukBlock, /L\.tileLayer\(DL\.url2d\(cfg\.reg\), DL\.tile2dOptions\(cfg\.reg/,
    'UK 2D tile layers are built from the shared registry (no duplicated URL)');
assert.match(ukBlock, /toggleHistPremiumLayer\(true\)/, 'switching a UK sublayer on also arms the Historical maps master switch');

// Coverage rectangles: label, layer variable and exact zoom window.
LAYERS.forEach(function (cfg) {
    const marker = cfg.key + ': {';
    const idx = mapApp.indexOf(marker);
    assert.ok(idx !== -1, 'coverage bounds entry ' + cfg.key);
    const block = mapApp.slice(idx, mapApp.indexOf('},', idx));
    assert.ok(block.indexOf("layerVar: '_" + cfg.key + "MapLayer'") !== -1, cfg.key + ' coverage layerVar');
    assert.ok(new RegExp('coverageMinZoom:\\s*' + cfg.min).test(block), cfg.key + ' coverageMinZoom ' + cfg.min);
    assert.ok(new RegExp('coverageMaxZoom:\\s*' + cfg.max).test(block), cfg.key + ' coverageMaxZoom ' + cfg.max);
    assert.ok(block.indexOf("label: '" + cfg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'") !== -1 ||
        block.indexOf('label: "' + cfg.name + '"') !== -1, cfg.key + ' coverage label uses the exact display name');
});

// Viewport filter rows (so Romanian/Italian/... viewports never show UK rows).
LAYERS.forEach(function (cfg) {
    assert.match(mapApp, new RegExp("\\{\\s*key:\\s*'" + cfg.key + "',\\s*toggle:\\s*'" + cfg.key + "MapToggle',\\s*row:\\s*'" + cfg.key + "Row'\\s*\\}"),
        cfg.key + ' registered in the premium viewport-filter premiumKeys');
});

// Master switch turns every UK sublayer off.
LAYERS.forEach(function (cfg) {
    assert.match(mapApp, new RegExp("\\{\\s*id:\\s*'" + cfg.key + "MapToggle',\\s*fnName:\\s*'toggle" + cap(cfg.key) + "Map'\\s*\\}"),
        cfg.key + ' part of HIST_PREMIUM_SUBLAYER_TOGGLES');
});

// Country attribution for the selected-country layer window.
LAYERS.forEach(function (cfg) {
    cfg.countries.forEach(function (iso) {
        assert.match(mapApp, new RegExp("premium_" + cfg.key + ":\\s*\\[[^\\]]*'" + iso + "'"),
            cfg.key + ' is attributed to ' + iso);
    });
});

// ── 3. UI rows inside the premium Historical maps accordion ───────────
const subStart = html.indexOf('id="histPremiumSubLayers"');
const subEnd = html.indexOf('/histPremiumSubLayers');
assert.ok(subStart > -1 && subEnd > subStart, 'histPremiumSubLayers panel exists');
const subPanel = html.slice(subStart, subEnd);

LAYERS.forEach(function (cfg) {
    const ids = [cfg.key + 'Row', cfg.key + 'MapToggle', cfg.key + 'MapOpacitySlider', cfg.key + 'MapPct'];
    ids.forEach(function (id) {
        assert.ok(subPanel.includes('"' + id + '"'), id + ' lives inside the premium historical-maps panel');
    });
    assert.ok(subPanel.includes('onchange="toggle' + cap(cfg.key) + 'Map(this.checked)"'),
        cfg.key + ' toggle wired to toggle' + cap(cfg.key) + 'Map');
    assert.ok(subPanel.includes('oninput="set' + cap(cfg.key) + 'MapOpacity(this.value)"'),
        cfg.key + ' opacity slider wired');
    // Exact requested display name as the data-key fallback text.
    assert.ok(subPanel.includes('>' + cfg.name + '</span>'), cfg.key + ' shows the exact name "' + cfg.name + '"');
    assert.ok(subPanel.includes('data-key="' + i18nKey(cfg) + '"'), cfg.key + ' span is translatable via ' + i18nKey(cfg));
    // ⓘ popup credits the National Library of Scotland + MapTiler.
    const infoIdx = subPanel.indexOf('id="' + cfg.key + 'MapPct"');
    const rowBlock = subPanel.slice(Math.max(0, infoIdx - 900), infoIdx);
    assert.ok(/showLayerInfo\(/.test(rowBlock), cfg.key + ' has a layer-info button');
    assert.ok(/National Library of Scotland \(maps\.nls\.uk\)/.test(rowBlock), cfg.key + ' info credits NLS (maps.nls.uk)');
    assert.ok(/MapTiler/.test(rowBlock), cfg.key + ' info credits MapTiler');
});

// The NLS domain is linkified inside the ⓘ popup (same mechanism as bukowina1856.eu).
assert.ok(html.includes("'maps.nls.uk'"), 'maps.nls.uk is a linkifiable layer-info source domain');

// The ⓘ overlay localizes its title through LAYER_NAME_TO_KEY → layer_uk_*
// translation key (the raw English showLayerInfo name is not a translation key).
const nameMapStart = html.indexOf('var LAYER_NAME_TO_KEY = {');
const nameMapEnd = html.indexOf('};', nameMapStart);
assert.ok(nameMapStart > -1 && nameMapEnd > nameMapStart, 'LAYER_NAME_TO_KEY map exists');
const nameMap = html.slice(nameMapStart, nameMapEnd);
LAYERS.forEach(function (cfg) {
    const key = i18nKey(cfg);
    assert.ok(nameMap.includes("'" + key + "'"), 'LAYER_NAME_TO_KEY maps a display name to ' + key);
    assert.ok(nameMap.indexOf(cfg.name) !== -1, 'LAYER_NAME_TO_KEY knows the display name "' + cfg.name + '"');
});

// ── 4. Premium gating ─────────────────────────────────────────────────
LAYERS.forEach(function (cfg) {
    const fn = 'toggle' + cap(cfg.key) + 'Map';
    assert.ok(subscriptions.includes("'" + fn + "'"), 'subscriptions.js wraps ' + fn + ' (premium-only ON)');
});

// Rows inherit the lock badge / click block from the premium parent group.
const groupRow = html.slice(html.indexOf('<!-- Harti Istorice — Parent Group -->'), html.indexOf('/histPremium transp-layer-row'));
assert.ok(groupRow.includes('data-category="premium"'), 'the Historical maps group row is premium-categorised');
LAYERS.forEach(function (cfg) {
    assert.ok(groupRow.includes(cfg.key + 'Row'), cfg.key + 'Row lives inside the premium group row');
});

// ── 5. Translations in every language block ───────────────────────────
const langBlockCount = (translations.match(/^\s{12}[a-z]{2}: \{$/gm) || []).length;
assert.ok(langBlockCount >= 20, 'language blocks discovered (' + langBlockCount + ')');
LAYERS.forEach(function (cfg) {
    const key = i18nKey(cfg);
    const occurrences = translations.match(new RegExp(key + ':', 'g')) || [];
    assert.strictEqual(occurrences.length, langBlockCount,
        key + ' exists in every language block (' + langBlockCount + ')');
    // The exact requested English name is present (en block at minimum, and
    // the same canonical string ships for every locale).
    assert.ok(translations.includes(key + ": '" + cfg.name.replace(/'/g, "\\'") + "'"),
        key + ' carries the exact requested name');
});
// en + ro specifically.
const enBlock = translations.slice(translations.indexOf('en: {'), translations.indexOf('ro: {'));
const roBlock = translations.slice(translations.indexOf('ro: {'));
LAYERS.forEach(function (cfg) {
    const key = i18nKey(cfg);
    assert.ok(enBlock.includes(key) && roBlock.includes(key), key + ' present in both en and ro locales');
});

// ── 6. Offline-maps catalogue + service worker ────────────────────────
LAYERS.forEach(function (cfg) {
    const def = registry.get(cfg.reg);
    const marker = "id: '" + cfg.key + "'";
    const idx = offlineMaps.indexOf(marker);
    assert.ok(idx !== -1, 'offline catalogue contains ' + cfg.key);
    const block = offlineMaps.slice(idx, offlineMaps.indexOf('onlineKey:', idx) + 80);
    assert.ok(block.includes("requiresPremium: true"), cfg.key + ' offline source is premium-gated');
    assert.ok(block.includes(def.url), cfg.key + ' offline URL matches the registry');
    assert.ok(block.includes("onlineKey: '_" + cfg.key + "MapLayer'"), cfg.key + ' offline source links to its online layer');
    assert.ok(new RegExp('maxNativeZoom:\\s*' + cfg.max).test(block), cfg.key + ' offline native ceiling ' + cfg.max);
});

// Service worker: fresh asset versions precached and the shell cache bumped
// so installed PWAs replace the stale scripts.
['js/layer-registry.js', 'js/map-app.js', 'js/translations.js', 'js/subscriptions.js', 'js/offline-maps.js', 'js/vertical-opacity-control.js'].forEach(function (asset) {
    assert.ok(sw.includes("'" + asset + '?v=20261024-uk-historical-maps' + "'"), 'sw precaches ' + asset + ' (new version)');
});
const cacheVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert.ok(cacheVersion >= 265, 'CACHE_NAME bumped to v265+ for the UK maps (got v' + cacheVersion + ')');
// MapTiler tile URLs are cacheable offline (extensionless hybrid tiles work
// through the __dl_offline_map tag offline-maps adds to every download).
assert.ok(/__dl_offline_map=/.test(sw), 'offline tile cache recognises tagged offline-map requests');

// ── 7. Runtime simulation of the coverage-rectangle decision ──────────
// Extract the real updatePremiumMapCoverageVisibility and run it against a
// fake map for one JPG baselayer (1919, z1–14) and one PNG overlay
// (Bartholomew Ireland, z5–12).
const fnStart = mapApp.indexOf('window.updatePremiumMapCoverageVisibility = function()');
const fnEnd = mapApp.indexOf("map.on('zoomend', window.updatePremiumMapCoverageVisibility);");
assert.ok(fnStart > -1 && fnEnd > fnStart, 'updatePremiumMapCoverageVisibility found');
const fnSource = mapApp.slice(fnStart, fnEnd);

function runCoverageSim(zoom, key, min, max) {
    const layerVar = '_' + key + 'MapLayer';
    const win = {};
    win[layerVar] = { __id: layerVar };
    const layersOnMap = new Set([layerVar]);
    const shown = new Set();
    const bounds = {};
    bounds[key] = { layerVar: layerVar, coverageMinZoom: min, coverageMaxZoom: max };
    const polygons = {};
    polygons[key] = { added: false };
    polygons[key].addTo = function () { this.added = true; shown.add(key); return this; };
    const map = {
        getZoom: function () { return zoom; },
        hasLayer: function (l) { return layersOnMap.has(l.__id) || !!l.added; },
        on: function () {},
        removeLayer: function (l) { l.added = false; }
    };
    const runner = new Function('window', 'map', 'premiumMapCoverageBounds', 'premiumMapCoveragePolygons',
        fnSource + '\nwindow.updatePremiumMapCoverageVisibility();');
    runner(win, map, bounds, polygons);
    return shown.has(key);
}

for (let z = 1; z <= 16; z++) {
    const expect1919 = z < 1 || z > 14;   // min 1 → never below; rectangle only above z14
    assert.strictEqual(runCoverageSim(z, 'ukOs1919', 1, 14), expect1919,
        'OS 1919-1947 coverage rectangle at z' + z + ' (expected ' + expect1919 + ')');
    const expectBaire = z < 5 || z > 12;
    assert.strictEqual(runCoverageSim(z, 'ukBaire1940', 5, 12), expectBaire,
        'Bartholomew Ireland coverage rectangle at z' + z + ' (expected ' + expectBaire + ')');
}

console.log('  ✓ 8 registry entries — MapTiler tile sets, key, native zoom windows, bounds + NLS/MapTiler credits');
console.log('  ✓ 2D panes (z660–667), registry-built tile layers, toggle/opacity globals + tunable native ceilings');
console.log('  ✓ exact names, toggles, sliders and ⓘ credits inside PREMIUM → Historical maps');
console.log('  ✓ coverage rectangles, viewport filter, master switch and GB/IE country attribution');
console.log('  ✓ premium gating (wrapped toggles + premium group), ' + langBlockCount + ' translation blocks');
console.log('  ✓ offline-maps catalogue, service-worker precache v' + cacheVersion + ' and coverage zoom simulation');
console.log('OK — UK premium historical maps wired correctly.');
