// Integration checks for the ArcGIS SceneView as DetectLab's primary map.
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
const shellJs = read('js/atlas-shell.js');
const appJs = read('js/map-app.js');
const styles = read('css/styles.css');
const sw = read('sw.js');

assert.match(index, /<section id="map-section" class="atlas-primary">/, 'the map section starts in ArcGIS-primary mode');
assert.match(index, /<div class="map-frame atlas-view">/, 'the embedded ArcGIS atlas is visible by default');
assert.match(index, /id="arcgisAtlasFrame"[^>]*src="europe-roman-atlas\.html\?embed=1"/, 'the main map embeds the atlas in compact mode');
assert.match(index, /id="atlasModeToggle"/, 'the legacy Leaflet map remains reachable through an explicit switch');
assert.match(index, /id="atlasModeFloatingToggle"/, 'the 2D map switch is available inside the installed PWA map frame');
assert.match(index, /europe-roman-atlas\.html" target="_blank"/, 'the atlas also has a full-screen route');
assert.match(index, /js\/atlas-shell\.js\?v=20261011-arcgis-primary/, 'the map-mode bridge is loaded');
const mapAppScript = index.indexOf('js/map-app.js?v=20261011-2d-basemap');
const atlasShellScript = index.indexOf('js/atlas-shell.js?v=20261011-arcgis-primary');
const hybridSwitchScript = index.indexOf('js/hybrid-tile-switch.js');
assert(mapAppScript >= 0 && mapAppScript < atlasShellScript && atlasShellScript < hybridSwitchScript, 'the map app and atlas bridge load before the hybrid tile switch');

assert.match(atlasJs, /'esri\/views\/SceneView'/, 'the atlas app requests the ArcGIS SceneView module');
assert.match(atlasHtml, /js\/europe-roman-atlas\.js\?v=20261011-arcgis-primary/, 'the current ArcGIS atlas module is loaded');
assert.match(atlasHtml, /js\.arcgis\.com\/4\.31/, 'ArcGIS SDK is loaded from the official CDN');
assert.match(atlasHtml, /id="hs"/, 'World Hillshade control is present');
assert.match(atlasHtml, /id="terr"/, 'elevation terrain control is present');
assert.match(atlasHtml, /id="bm"/, 'basemap switch is present');
assert.match(atlasHtml, /value="img"/, 'Imagery basemap option is present');
assert.match(atlasHtml, /value="topo"/, 'Topographic basemap option is present');

assert.match(atlasJs, /'esri\/views\/SceneView'/, 'the ArcGIS app constructs a 3D SceneView');
assert.match(atlasJs, /World_Imagery\/MapServer/, 'Imagery basemap uses Esri World Imagery');
assert.match(atlasJs, /World_Topo_Map\/MapServer/, 'Topographic basemap uses Esri World Topographic Map');
assert.match(atlasJs, /World_Hillshade\/MapServer/, 'World Hillshade is available as an overlay');
assert.match(atlasJs, /WorldElevation3D\/Terrain3D\/ImageServer/, 'the ground can use 3D elevation');
assert.match(atlasJs, /DARE_CATS/, 'DARE Roman categories are part of the atlas');
assert.match(atlasJs, /route-segments-all-/, 'Roman-road data is wired');
assert.match(atlasJs, /pleiades-places-latest/, 'Pleiades sites are wired');
assert.match(atlasJs, /AWMC/, 'AWMC layers are credited and included');
assert.match(atlasJs, /detectlab-atlas-country-selected/, 'country choices are bridged to the parent app');
assert.match(atlasJs, /boundsOfPolygons/, 'selected-country extents are available to the legacy map');

assert.match(shellJs, /detectlab-atlas-resize/, 'the SceneView is resized after toggling back into view');
assert.match(shellJs, /filterLayersForCountry/, 'single-country selection filters the legacy layer catalogue');
assert.match(shellJs, /invalidateSize/, 'the Leaflet map is resized when the user switches to it');
assert.match(styles, /\.map-frame\.atlas-view \.arcgis-atlas-stage\s*\{\s*display:\s*block/, 'the ArcGIS frame overlays the map controls in primary mode');
assert.match(styles, /body\.is-pwa \.atlas-mode-floating-toggle\s*\{\s*display:\s*inline-flex/, 'PWA mode shows the floating switch to the Leaflet map');
assert.match(styles, /#map-section\.atlas-primary #mapAuthGate:not\(\.hidden\),\s*#map-section\.atlas-primary #mapLock\.show\s*\{\s*z-index:\s*10060/, 'authentication and membership overlays remain above the embedded atlas');
assert.match(atlasCss, /\.atlas-embedded \.back-link\s*\{\s*display:\s*none/, 'embedded atlas hides its standalone back link');

assert.match(appJs, /SATELLITE_IMAGERY_URL\s*=\s*'https:\/\/server\.arcgisonline\.com\/ArcGIS\/rest\/services\/World_Imagery/, 'the fallback Leaflet map retains its normal raster basemap');
assert.doesNotMatch(appJs, /DetectLabGlobeBase|DetectLabGlobeGate|DetectLabCountryDock|_lidarGlobeTwin/, 'legacy MapLibre globe and gate are not initialized');
assert.doesNotMatch(index, /maplibre-gl|leaflet-maplibre-gl|globe-base-layer|globe-country-picker|country-dock\.js|globe-arcgis-gate/, 'the old globe bundles are not loaded');

const cacheVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(cacheVersion >= 183, 'the PWA shell version was incremented for the atlas');
[
  'europe-roman-atlas.html?embed=1',
  'europe-roman-atlas.html',
  'css/europe-roman-atlas.css?v=20261011-arcgis-primary',
  'js/europe-roman-atlas.js?v=20261011-arcgis-primary',
  'js/atlas-shell.js?v=20261011-arcgis-primary',
  'css/styles.css?v=20261011-arcgis-primary',
  'js/map-app.js?v=20261011-2d-basemap',
  'data/countries-50m.json'
].forEach((asset) => assert(sw.includes("'" + asset + "'"), 'PWA precaches ' + asset));
assert.doesNotMatch(sw, /'js\/(?:maplibre-gl|leaflet-maplibre-gl|globe-base-layer|globe-country-picker|country-dock)\.js/, 'PWA no longer precaches retired globe modules');

[
  'js/atlas-shell.js', 'css/europe-roman-atlas.css', 'js/europe-roman-atlas.js',
  'data/countries-50m.json', 'js/d3.min.js', 'js/topojson-client.min.js', 'js/shapefile.js'
].forEach((asset) => assert(fs.existsSync(path.join(root, asset)), asset + ' exists'));

console.log('ArcGIS primary atlas integration checks passed.');
