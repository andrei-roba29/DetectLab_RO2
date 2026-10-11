# ArcGIS basemap integration (PR #283 fix — v184)

PR #283 replaced the working map with an embedded ArcGIS SceneView atlas
(`europe-roman-atlas.html?embed=1` in an iframe with `z-index: 10050`) and put
the whole DetectLab interface (tabs, search, layer panel, country dock,
country gate, APM/LIDAR/historical/DARE/report/offline layers) behind a
“2D map & layers” toggle. That integration broke the acceptance rule that the
DetectLab interface must stay primary, visible and functional.

## What v184 does

**Only the basemap engine was replaced; the app is not.**

- The DetectLab Leaflet map is again the **primary, always-visible** interface:
  the map tabs (Free Preview / Vreme), the search bar, the full layer panel
  (tabs, categories, sublayers, visibility + opacity), APM, LIDAR, historical
  maps, DARE/Roman layers, reports and offline maps all behave as before the
  PR. The iframe stage and the 2D/3D mode toggles are removed from
  `index.html`; nothing with a high `z-index` covers the panels or buttons.
- The **basemap engine is the ArcGIS basemap stack** (the retired MapLibre 3D
  globe, `js/globe-base-layer.js` + `js/maplibre-gl.js` +
  `js/leaflet-maplibre-gl.js`, is not restored — it is the old basemap
  implementation the ArcGIS variant replaces). The same Esri tile services the
  SceneView atlas uses, served as plain Web Mercator tiles on the existing
  `pane_satellite` (z-index 398, below every data pane):
  - **Imagery** — `World_Imagery` (default, keeps the historical `window._satLayer`
    contract, the “Istoric” Copernicus slider and offline satellite tiles);
  - **Topographic** — `World_Topo_Map`;
  - **Terrain** — `World_Terrain_Base` + `World_Terrain_Shaded_Relief`;
  - **World Hillshade** (30 m relief overlay) — shared with the country dock
    checkbox via `window.toggleWorldHillshade`.
  A compact bottom-left Leaflet control (`#arcgisBasemapCtrl`,
  `js/map-app.js`) switches the basemap and toggles the hillshade; the choice
  persists in `localStorage`. It sits clear of the search bar (top-centre),
  the layer panel (right) and the PWA action dock (bottom-right).
- The **country gate** (lazy ArcGIS **SceneView** renderer
  `js/globe-arcgis-gate.js` + canvas fallback `js/globe-country-picker.js`),
  the **country dock** (`js/country-dock.js`: country switcher, World
  hillshade, “Exit view”), the locked country view, the country-scoped layer
  window and the search bar's country-aware lookup are restored exactly as
  before the PR (`DetectLabGlobeGate.attach(map)` +
  `DetectLabCountryDock.attach(map)` in `js/map-app.js`).
- The **full-screen ArcGIS SceneView atlas** (`europe-roman-atlas.html`:
  SceneView, Imagery/Topographic, hillshade, 3D elevation terrain, DARE/Roman
  layers) is kept as an **optional new-tab experience** from the map header
  (“3D ArcGIS atlas”) and the top nav (“Roman Atlas”) — it never replaces or
  covers the main interface. `js/atlas-shell.js` (the iframe message bridge)
  stays in the repo and in the PWA precache for that page bundle, but is no
  longer loaded by `index.html` because the page no longer embeds an iframe.

## Why the SceneView is not the main map's engine

An ArcGIS **SceneView** is a standalone WebGL scene: it renders only ArcGIS
SDK layers (tiles, vector/feature layers, graphics). The DetectLab overlay
stack — APM rasters, ~10 national LIDAR WMS/WMTS services (some with custom
`createTile` canvas rendering), Copernicus VHR mosaics, historical scans,
DARE/AWMC vectors, Patrimoniu clusters, trail recording, the measure control,
the offline-tile manager — is built on the **Leaflet** API on a shared
Web-Mercator projection. A SceneView cannot host those Leaflet layers, and
compositing one inside the map area would put the whole analytical stack
(plus the country lock) behind a second rendering engine, which is exactly
the covering-iframe situation v183 introduced. So:

- the **2D ArcGIS tile basemap** hosts all existing Leaflet layers on the
  working map (they stay 100% functional);
- the **3D SceneView experience** (elevation terrain, 3D globe, Roman layers)
  stays available in the two ArcGIS views above (gate + full-screen atlas).

Known, accepted differences vs. the pre-PR 3D globe: the selected-country
outline is no longer projected with a globe camera — `js/globe-country-picker.js`
falls back to its own Leaflet placement (`L.geoJSON`/`L.rectangle` in
`pane_country_bounds`), and the canvas-drawn LIDAR sources no longer need the
zoom-11 gate because there is no globe camera to drift from.

## PWA / service worker

- `sw.js` is bumped to **v184** (`detectlab-v184-arcgis-basemap`).
- The retired MapLibre/globe assets stay out of the precache; the restored
  gate/dock assets and the new `js/map-app.js?v=20261011-arcgis-basemap`
  are precached; the atlas page assets remain precached.
- In installed PWA mode the map header (tabs) is hidden by design, exactly as
  before the PR — the floating PWA controls carry those actions; the basemap
  switcher stays visible bottom-left.

## Verification

- `node test-arcgis-primary-atlas.js` — integration checks for this fix
  (primary UI, no iframe, ArcGIS basemap stack, SceneView preserved).
- Restored suites: `test-globe-arcgis-gate.js`, `test-globe-canvas-picker.js`,
  `test-country-dock.js`, `test-country-layer-filter.js`,
  `test-globe-lockin-logic.mjs`.
- Updated: `test-historical-eu-maps.js`, `test-roman-reference-layer.js`
  (map-app version), `test-sat-historic-periods.js` kept (2D satellite base).
- Not restored (they test the deliberately retired MapLibre globe engine):
  `test-globe-base-layer.js`, `test-globe-raster-twin.js`,
  `test-globe-outline-projection.js`, `test-lidar-canvas-zoom-gate.js`,
  `test-base-satellite-native-zoom.js`.
- Full run: 77/77 non-network suites pass in the sandbox
  (13 jsdom suites included); browser-level visual inspection of the ArcGIS
  tile rendering needs a normal browser session (desktop + `?pwa=1`).
