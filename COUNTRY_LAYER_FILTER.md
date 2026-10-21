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
  - **The Albanian ASIG rows** (`albania.*`, `js/asig-albania-layers.js`) live in
    one Albania-owned panel group (`#albaniaRow` → `#albaniaSubLayers`) and are
    strictly `['AL']`: they are hidden for every other ISO **and** in the global
    view with no country selected. They are no longer mounted inside the
    Romanian Historical Maps / Satellite / Heritage Sites rows or in the LiDAR
    group that hosts Denmark's DHM; the module removes their tile layers from the
    map (keeping the user's switch state) while another country is on screen.
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
- **The CENAGIS dynamic catalog** (`js/historical-eu-maps.js` — `renderUi` /
  `filterForCountry`, rendered flat in `#histEuMapsSection` without a
  subcategory heading) is curated-first: for the 19 analyzed countries the
  `COUNTRIES_DATA` lists decide (rectangle overlap alone leaked neighbouring
  countries' sheets into the window — the exact bug this fixes). For a country
  outside that analysis (Italy, Norway…) the sheets' own extents are used, and
  only a *substantial* overlap counts (≥ 5% of the country's box **or** ≥ 5%
  of the sheet's box) — a bbox graze is not "a map of this country".
- **The selected country's real outline stays visible on the map — never its
  bounding box.** The overlay is the country geometry from the gate's atlas
  (`L.geoJSON`, non-interactive). While that geometry is not in yet (a
  `localStorage` selection restored before the atlas finishes loading, or the
  10 m refinement still in flight) *nothing* is drawn: the selection bbox is
  used for `maxBounds`, the layer-coverage math and the camera — but a bbox is
  a rectangle around e.g. Sweden, and drawing it as the country's outline made
  a fresh selection look like a rectangle that “merged” into the real shape a
  couple of seconds later. `refreshCountryBoundsLayer()` draws the outline as
  soon as `ensureReady()` / `refineFromShapefile()` delivers geometry (and
  re-draws it when the refined feature object replaces the atlas one), so the
  first frame with an overlay is already the correct shape. `attach()` warms
  the atlas immediately for a restored selection, so that frame comes as early
  as possible. Once the hand-off completes, Leaflet/Web Mercator owns the
  outline and its highlight fill, so the overlay stays aligned with every
  working-map raster and vector layer. It sits in its own pane
  `pane_country_bounds` at z-index **688** (above every data pane — LIDAR 610,
  historical maps ≤ 652 — under tracks 690 / measure 700), is replaced on every
  new selection and removed on unlock (“Exit view”, `reset()`).

## Files

- `js/asig-albania-layers.js` / `js/asig-albania-layers.config.js` — the
  Albania-only group: `filterForCountry(iso)` shows `#albaniaRow` only for `AL`,
  marks the group and every row `country-layer-unavailable` otherwise, and parks
  the tile layers. `js/map-app.js` calls it on selection and on exit;
  `js/layer-registry.js` mirrors the rows with `countries: ['AL']`.
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
  `refineFromShapefile`; `state.boundsLayer` / `state.boundsIso` /
  `state.boundsFeature` track the overlay (outline only — no bbox rectangle
  fallback) and always use Leaflet/Web-Mercator placement in the working view.
- `tools/country-dock-preview.html` — the dev harness implements the same
  contract (national rows strict by ISO, `histEuRow` pan-European by coverage).
- `test-country-layer-filter.js` — regression suite: Italy must not see
  France/Switzerland rows, Denmark must not see Sweden/Poland rows or the
  Polish WIG sheets; curated premium sheets stay for their countries.
- `test-historical-eu-maps.js` — curated-first catalog + a drift guard that
  asserts `SHARED_PREMIUM_COUNTRIES` mirrors `COUNTRIES_DATA` exactly.
- `index.html` / `sw.js` — version bumps
  (`js/map-app.js?v=20261013-wms-guard`,
  `js/historical-eu-maps.js?v=20261013-flat-hist-maps`,
  `js/globe-country-picker.js?v=20261013-no-change-pill`), shell `v192`.
  The CENAGIS sheets are listed **flat** in the single “Hărți istorice /
  Historical Maps” group: there is no “European maps · CENAGIS / IH PAN”
  subcategory heading (nor any replacement one) above them.

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
