// Integration checks for the fixed PR #283 integration:
//   • the DetectLab interface (tabs, search, layer panel, country gate + dock,
//     APM/LIDAR/historical/DARE/report/offline layers) is the primary,
//     always-visible map — no embedded ArcGIS iframe, no 2D-toggle gating;
//   • the basemap engine is the ArcGIS basemap stack (Esri World Imagery /
//     Topographic / Terrain + World Hillshade) on the existing Leaflet map;
//   • the ArcGIS SceneView experience stays available in the lazy country gate
//     and the full-screen europe-roman-atlas.html page.
// Run: node test-arcgis-primary-atlas.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const index = read('index.html');
const atlasHtml = read('europe-roman-atlas.html');
const atlasJs = read('js/europe-roman-atlas.js');
const atlasCss = read('css/europe-roman-atlas.css');
const appJs = read('js/map-app.js');
const gateJs = read('js/globe-arcgis-gate.js');
const pickerJs = read('js/globe-country-picker.js');
const dockJs = read('js/country-dock.js');
const styles = read('css/styles.css');
const sw = read('sw.js');

/* ── 1. The DetectLab interface is primary — no iframe, no toggle gating ── */
assert.doesNotMatch(index, /arcgisAtlasStage|arcgisAtlasFrame|atlasModeToggle|atlasModeFloatingToggle/,
    'no embedded ArcGIS iframe stage or mode toggles in the main page');
assert.doesNotMatch(index, /<section id="map-section" class="atlas-primary">/, 'the map section is not in ArcGIS-primary mode');
assert.match(index, /<section id="map-section">/, 'the map section carries the DetectLab interface');
assert.doesNotMatch(index, /class="map-frame atlas-view"/, 'the map frame is not the atlas view');
assert.doesNotMatch(styles, /atlas-primary|atlas-view|legacy-map-tab|atlas-mode-floating-toggle/,
    'no ArcGIS-primary CSS overrides remain in styles.css');
/* The RETIRED MapLibre *globe basemap* must stay gone. MapLibre GL is loaded
 * again — deliberately — as the separate 3D terrain viewer (2D ⇄ 3D), which
 * drapes the historical layers over a DEM; see MAP_3D_TERRAIN.md. */
assert.doesNotMatch(index, /leaflet-maplibre-gl|globe-base-layer/,
    'the retired MapLibre globe basemap is not loaded by the shell');
assert(index.includes('js/map3d-terrain.js?v=20261020-1km-raster-refresh') &&
       index.includes('js/layer-registry.js?v=20261020-albania-independent-rows') &&
       index.includes('js/map3d-mirror.js?v=20261020-3d-analysis-points'),
    'the 3D terrain viewer, its shared layer registry and the 2D→3D mirror are loaded');

/* ── 2. The original map tabs and controls are restored and visible ── */
assert.match(index, /<button class="map-tab active t" data-key="tab_free" onclick="switchTab\(this,'free'\)">/,
    'the Free Preview tab is back and active by default');
assert.match(index, /<button class="map-tab" id="tabWeather" onclick="switchTab\(this,'weather'\)">/,
    'the Weather (Vreme) tab is back');
assert.match(index, /data-key="map_title">Explore the <span class="hl">APM Layer<\/span>/,
    'the map title is restored');
assert.match(index, /id="mapSearchWrap"/, 'the search bar is present');
assert.match(index, /id="transpPanel"/, 'the layer panel is present');
// The full-screen SceneView atlas is an optional new-tab target, never a cover.
assert.match(index, /<a class="map-tab roman-atlas-link" href="europe-roman-atlas.html" target="_blank"/,
    'the ArcGIS SceneView atlas is reachable in a new tab from the map header');
assert.match(index, /<li><a href="europe-roman-atlas.html">/, 'the top nav keeps the Roman Atlas link');

/* ── 3. Country selection: gate + dock restored (pre-PR behaviour) ── */
assert.match(index, /id="globeGate"/, 'the country gate markup is restored');
assert.match(index, /id="globeGateArcGIS"/, 'the lazy ArcGIS SceneView gate surface is restored');
assert.match(index, /id="globeGateCanvas"/, 'the canvas fallback picker surface is restored');
assert.match(index, /id="countryDock"/, 'the country dock is restored');
assert.match(index, /id="countryDockHillshade"/, 'the dock World-hillshade checkbox is restored');
assert.match(index, /id="countryExitViewBtn"[^>]*hidden/, 'the Exit view button is restored');
assert.match(index, /id="mapAuthGate"/, 'the authentication overlay is restored');
assert.match(index, /id="mapLock"/, 'the members-only lock overlay is restored');

/* ── 4. Script order: gate → dock → map-app (ArcGIS basemap) ── */
const order = [
    'js/translations.js?v=20261017-albania-asig',
    'js/globe-arcgis-gate.js?v=20261013-handoff-zoom',
    'js/globe-country-picker.js?v=20261017-outline-zoom-settle',
    'js/country-dock.js?v=20261013-country-2d',
    'js/map-app.js?v=20261020-albania-independent-rows',
    'js/offline-maps.js?v=20261009-3d-globe'
];
order.forEach((asset) => assert(index.includes(asset), 'index.html loads ' + asset));
for (let i = 0; i < order.length - 1; i++) {
    assert(index.indexOf(order[i]) < index.indexOf(order[i + 1]),
        order[i] + ' loads before ' + order[i + 1]);
}

/* ── 5. The ArcGIS basemap engine on the working Leaflet map ── */
assert.match(appJs, /SATELLITE_IMAGERY_URL\s*=\s*'https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}'/,
    'Imagery basemap uses Esri World Imagery');
assert.match(appJs, /ARCGIS_TOPOGRAPHIC_URL\s*=\s*'https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Topo_Map\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}'/,
    'Topographic basemap uses Esri World Topographic Map');
assert.match(appJs, /World_Terrain_Base\/MapServer\/tile/, 'the terrain basemap uses Esri World Terrain');
assert.match(appJs, /World_Terrain_Shaded_Relief\/MapServer\/tile/, 'the terrain basemap adds Esri shaded relief');
assert.match(appJs, /window\.setArcgisBasemap = function/, 'the basemap switch is scriptable/testable');
assert.match(appJs, /window\.getArcgisBasemap = function/, 'the active basemap is queryable');
assert.match(appJs, /arcgisBasemapCtrl/, 'the basemap switcher control exists');
assert.match(appJs, /L\.control\(\{ position: 'bottomleft' \}\)/, 'the switcher is a bottom-left Leaflet control (never covers the panels)');
assert.match(appJs, /window\.toggleWorldHillshade/, 'the hillshade toggle drives the shared World Hillshade overlay');
assert.match(appJs, /\.id = 'arcgisBasemapHillshade'/, 'the hillshade checkbox is part of the control');
assert.match(appJs, /window\.DetectLabGlobeGate\.attach\(map\)/, 'the country gate is attached to the working map');
assert.match(appJs, /window\.DetectLabCountryDock\.attach\(map\)/, 'the country dock is attached to the working map');
assert.match(appJs, /var satelliteLayer\s*=\s*L\.tileLayer\(SATELLITE_IMAGERY_URL/, 'the imagery layer keeps the historical _satLayer contract');
assert.doesNotMatch(appJs, /DetectLabGlobeBase|_lidarGlobeTwin/, 'the retired MapLibre globe API is not used');

/* ── 6. The ArcGIS SceneView is preserved (gate + full-screen atlas) ── */
assert.match(gateJs, /'esri\/views\/SceneView'/, 'the country gate lazy-loads the ArcGIS SceneView renderer');
assert.match(gateJs, /https:\/\/js\.arcgis\.com\/4\.31\//, 'the gate pins the ArcGIS Maps SDK 4.31');
assert.doesNotMatch(sw, /'https:\/\/js\.arcgis\.com\/4\.31\//, 'the external SDK stays out of precache');

assert.match(atlasJs, /'esri\/views\/SceneView'/, 'the atlas app constructs a 3D SceneView');
assert.match(atlasHtml, /js\/europe-roman-atlas\.js\?v=20261011-arcgis-primary/, 'the current ArcGIS atlas module is loaded');
assert.match(atlasHtml, /js\.arcgis\.com\/4\.31/, 'the atlas loads the ArcGIS SDK from the official CDN');
assert.match(atlasHtml, /id="hs"/, 'atlas World Hillshade control is present');
assert.match(atlasHtml, /id="terr"/, 'atlas elevation terrain control is present');
assert.match(atlasHtml, /id="bm"/, 'atlas basemap switch is present');
assert.match(atlasHtml, /value="img"/, 'atlas Imagery basemap option is present');
assert.match(atlasHtml, /value="topo"/, 'atlas Topographic basemap option is present');
assert.match(atlasJs, /World_Imagery\/MapServer/, 'atlas Imagery basemap uses Esri World Imagery');
assert.match(atlasJs, /World_Topo_Map\/MapServer/, 'atlas Topographic basemap uses Esri World Topographic Map');
assert.match(atlasJs, /World_Hillshade\/MapServer/, 'atlas World Hillshade is available as an overlay');
assert.match(atlasJs, /WorldElevation3D\/Terrain3D\/ImageServer/, 'atlas ground can use 3D elevation');
assert.match(atlasJs, /DARE_CATS/, 'DARE Roman categories are part of the atlas');
assert.match(atlasJs, /route-segments-all-/, 'Roman-road data is wired');
assert.match(atlasJs, /pleiades-places-latest/, 'Pleiades sites are wired');
assert.match(atlasCss, /\.atlas-embedded \.back-link\s*\{\s*display:\s*none/, 'embedded atlas hides its standalone back link');

/* ── 7. Service worker: v185+ shell, atlas + gate/dock precached ── */
const cacheVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(cacheVersion >= 187, 'the PWA shell version was bumped to v187 for the flat country hand-off');
[
  'europe-roman-atlas.html?embed=1',
  'europe-roman-atlas.html',
  'css/europe-roman-atlas.css?v=20261011-arcgis-primary',
  'js/europe-roman-atlas.js?v=20261011-arcgis-primary',
  'js/atlas-shell.js?v=20261011-arcgis-primary',
  'css/styles.css?v=20261020-albania-independent-rows',
  'css/globe-country-picker.css?v=20261013-no-change-pill',
  'js/globe-arcgis-gate.js?v=20261013-handoff-zoom',
  'js/globe-country-picker.js?v=20261017-outline-zoom-settle',
  'css/country-dock.css?v=20261008',
  'js/country-dock.js?v=20261013-country-2d',
  'js/map-app.js?v=20261020-albania-independent-rows',
  'js/offline-maps.js?v=20261009-3d-globe',
  'js/translations.js?v=20261017-albania-asig',
  'data/countries-50m.json'
].forEach((asset) => assert(sw.includes("'" + asset + "'"), 'PWA precaches ' + asset));
assert.doesNotMatch(sw, /'js\/(?:leaflet-maplibre-gl|globe-base-layer)\.js/, 'PWA does not precache the retired globe modules');
assert(sw.includes("'js/maplibre-gl.js?v=20261019-tile-order'") &&
       sw.includes("'js/map3d-terrain.js?v=20261020-1km-raster-refresh'") &&
       sw.includes("'js/map3d-mirror.js?v=20261020-3d-analysis-points'"),
    'PWA precaches the vendored 3D SDK and the terrain viewer');

/* ── 8. Restored files exist ── */
[
  'js/globe-arcgis-gate.js', 'js/globe-country-picker.js', 'js/country-dock.js',
  'css/globe-country-picker.css', 'css/country-dock.css',
  'images/globe/earth-blue-marble.jpg', 'images/globe/earth-topology.png',
  'tools/country-dock-preview.html', 'tools/globe-gate-preview.html',
  'js/atlas-shell.js', 'css/europe-roman-atlas.css', 'js/europe-roman-atlas.js',
  'data/countries-50m.json', 'js/d3.min.js', 'js/topojson-client.min.js', 'js/shapefile.js'
].forEach((asset) => assert(fs.existsSync(path.join(root, asset)), asset + ' exists'));

console.log('ArcGIS basemap + restored DetectLab UI integration checks passed.');
