# Country-scoped layer window + visible country bounds

## What changed

Selecting a country now *scopes* the layer catalogue to **that country's own
layers** and keeps the selection visible on the map:

- **The layer window only offers the layers that are aferente țării selectate.**
  Membership is decided by **country attribution**, not by rectangle
  intersection: after a selection, every row in `#transpPanel` that is not
  attributed to the selected country gets `.country-layer-unavailable` and is
  hidden (CSS rule under `#transpPanel.country-filter-active`). Neighbouring
  countries' rows never leak in just because their published box grazes the
  country's bbox or because those countries are visible at the edges of the
  locked viewport:
  - **National services are strictly their own country.** The European LiDAR
    rows (`js/map-app.js` `LAYER_COUNTRIES`) — Denmark · DHM, Sweden ·
    Lantmäteriet, France · IGN MNT, Switzerland · swisstopo, Norway, Poland,
    Netherlands, Spain, UK — show ONLY for their own ISO. Italy selected →
    **no** France/Switzerland rows (their boxes reach Italy's bbox but the
    services carry zero Italian data); Denmark selected → **no** Sweden/Poland
    rows (their boxes clip Denmark's bbox at Bornholm/Zealand).
  - **Romanian national layers** (county LiDAR grids, APM, UAT, patrimoniu,
    Biblioteca din Babel, the free historical sheets, battles, scanner, archeo
    tools, Amprenta Vegetației) are attributed `['RO']` and disappear for every
    other country — including the neighbours whose bboxes overlap
    `ROMANIA_BOUNDS`.
  - **Premium sheets** list the modern countries whose territory the sheet
    genuinely shows (e.g. Bucovina → `RO, UA`; Banat → `RO, HU, RS`; the
    Moldavia sheets → `RO, MD`).
  - **Shared CENAGIS sheets** (the premium rows hosting `ukvme` /
    Mitteleuropa, Chrzanowski, Reymann, KDR 1:100k, KDR Großblatt, WIG 100k,
    Kummersberg / Galiția 1855) follow the catalog's **curated coverage**
    (`COUNTRIES_DATA` in `js/historical-eu-maps.js`, `pct > 0` = the sheet
    really covers part of that country). Denmark therefore keeps KDR,
    Reymann, Chrzanowski and Mitteleuropa (they cover its territory) but no
    longer sees WIG 100k / WIG 300k ("Harta Poloniei" — their boxes merely
    graze the Danish bbox).
  - **Pan-European catalogues** (CORONA "Satellite imagery 60's", the Roman
    Empire group) carry no country list and keep the coverage rule — they are
    declared by their real extent and belong to every country they span.
  - Rows **without** any attribution or bounds record (live/API layers) are
    left untouched.
- **The CENAGIS dynamic catalog** (`js/historical-eu-maps.js
  filterForCountry`) is curated-first: for the 19 analyzed countries the
  `COUNTRIES_DATA` lists decide (rectangle overlap alone leaked neighbouring
  countries' sheets into the window — the exact bug this fixes). For a country
  outside that analysis (Italy, Norway…) the sheets' own extents are used, and
  only a *substantial* overlap counts (≥ 5% of the country's box **or** ≥ 5%
  of the sheet's box) — a bbox graze is not "a map of this country".
- **The bounds of the selected country stay visible on the map.** The globe
  gate draws them for the whole locked view: the real country outline (the
  gate's geometry) once the atlas is loaded, the bbox rectangle until then (a
  selection restored from `localStorage` starts with the rectangle and upgrades
  as soon as `ensureReady()` / the 10 m shapefile refinement delivers geometry).
  The outline and its highlight fill are one path. While the 3D globe basemap
  is live on the same map (`window._detectlabGlobeBaseLayer`), that path is
  **projected with the globe's own camera** (`DetectLabGlobeBase
  .createProjectedFeature` for the outline, `createProjectedPolygon` over the
  bbox corners for the rectangle), so it stays on the imagery when zoomed out
  and while the globe moves. Without a live globe, Leaflet places it as before
  (`L.geoJSON` / `L.rectangle`). The basemap itself is unchanged. The overlay
  is non-interactive, sits in its own pane `pane_country_bounds` at z-index
  **688** (above every data pane — LIDAR 610, historical maps ≤ 652 — under
  tracks 690 / measure 700), is replaced on every new selection and removed on
  unlock (“Exit view”, `reset()`).
- **Scope of the projection.** Only the country-shaped vector overlay (the
  outline and highlight) is projected onto the globe. The country-attributed
  Leaflet *raster* layers (LIDAR, WMS/WMTS, UAT tiles, hillshade, Copernicus
  VHR) keep Leaflet's Web Mercator placement, so they still differ from the
  globe by a few pixels away from the view centre.

## Files

- `js/map-app.js` — `LAYER_COUNTRIES` (per-row ISO attribution, Romanian
  county LiDAR keys added programmatically), `SHARED_PREMIUM_CATALOG_KEYS` /
  `SHARED_PREMIUM_COUNTRIES` (static mirror of the catalog's curated coverage
  for the premium rows that host the shared sheets — the filter runs before /
  without `historical-eu-maps.js`), `CURATED_COVERAGE_COUNTRIES` (the analyzed
  ISO set). `filterLayersForCountry(iso)` matches attributed rows strictly by
  ISO (BE-LU ↔ BE/LU and GB ↔ UK aliases), falls back to substantial coverage
  for shared sheets when the country is outside the analysis, and keeps the
  coverage rule for unattributed pan-European rows. Group rows still hide when
  no sublayer survives.
- `js/historical-eu-maps.js` — `filterForCountry` is curated-first
  (`COUNTRIES_DATA`), with the substantial-extent fallback for unanalyzed
  countries and `[]` for an unknown ISO without geometry. The empty-state text
  notes that premium-hosted sheets appear above.
- `css/styles.css` — `#transpPanel.country-filter-active
  .country-layer-unavailable { display: none !important; }` (unchanged).
- `js/globe-country-picker.js` — `showCountryBoundsLayer` /
  `removeCountryBoundsLayer` / `refreshCountryBoundsLayer`, wired into
  `restrictLeafletToCountry`, `unlockCountryView`, `ensureReady` and
  `refineFromShapefile`; `state.boundsLayer` tracks the overlay. With a live
  globe it builds the projected outline (see above).
- `js/globe-base-layer.js` — `DetectLabGlobeBase.createProjectedPolygon` /
  `createProjectedFeature`: a Leaflet polygon whose vertices come from the
  globe camera (`gl.project`), re-projected on every pan, resize and zoom end.
  Fall back to Leaflet placement when no globe is on the map.
- `tools/country-dock-preview.html` — the dev harness implements the same
  contract (national rows strict by ISO, `histEuRow` pan-European by coverage).
- `test-country-layer-filter.js` — regression suite: Italy must not see
  France/Switzerland rows, Denmark must not see Sweden/Poland rows or the
  Polish WIG sheets; curated premium sheets stay for their countries.
- `test-historical-eu-maps.js` — curated-first catalog + a drift guard that
  asserts `SHARED_PREMIUM_COUNTRIES` mirrors `COUNTRIES_DATA` exactly.
- `index.html` / `sw.js` — version bumps
  (`js/map-app.js?v=20261008-country-layers-strict`,
  `js/historical-eu-maps.js?v=20261008-country-layers-strict`), shell `v172`.

## Semantics

- *Aferentă țării* = the layer provides data for that country's territory:
  the country's own national services, sheets whose footprint genuinely covers
  the country (curated lists), and pan-European catalogues the country sits in.
  Rectangle intersection alone is **not** enough — published boxes routinely
  overshoot their data (service capability boxes include sea/foreign margins).
- Substantial coverage fallback (unanalyzed countries only): the rectangles
  must intersect and the overlap must be ≥ 5% of the country's bbox area OR
  ≥ 5% of the sheet's bbox area.
- Layer on/off state is not changed by the filter — the map is locked to the
  country anyway, and switching back restores rows with their previous state.
- The filter belongs to the locked view: it applies on every selection
  (globe pick, dock switch, restored selection) and is released by
  “Exit view” / `DetectLabGlobeGate.unlock()` / `reset()`.
- Market note: attribution is market-independent. On the .eu market the Roman
  layers keep the Empire-wide box (kept for Italy/Denmark), while
  vegetation-fingerprint rows stay `['RO']` and hide abroad.

## Manual QA

- `python3 -m http.server` at the repo root → open
  `/tools/country-dock-preview.html`: pick Italy → the mini panel loses every
  national LiDAR row (including France/Switzerland); pick Denmark → only
  "Denmark · DHM" remains of the national services; "Exit view" restores
  everything.
- In the full app: select Italy → the LiDAR group is gone, Mitteleuropa /
  Reymann / KDR remain (they cover the Alps), the Romanian groups are gone.
  Select Denmark → Danish LiDAR + Mitteleuropa/Chrzanowski/Reymann/KDR 100k
  remain; Sweden/Poland LiDAR and the WIG sheets are gone.
- Run `node test-country-layer-filter.js`, then `node test-historical-eu-maps.js`,
  `node test-country-dock.js`, `node test-globe-canvas-picker.js` and
  `node test-layer-visibility.js` after touching any of this.
