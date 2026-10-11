# Country-scoped layer window + visible country bounds

## What changed

Selecting a country scopes the alternate Leaflet catalogue to **that country's
own layers** and passes its extent to the 2D map for framing:

- **The layer window only offers the layers that are aferente țării selectate.**
  Membership is decided by **country attribution**, not by rectangle
  intersection: after a selection, every row in `#transpPanel` that is not
  attributed to the selected country gets `.country-layer-unavailable` and is
  hidden (CSS rule under `#transpPanel.country-filter-active`). Neighbouring
  countries' rows never leak in just because their published box grazes the
  country's bbox or because they happen to be visible at the edges of the
  current viewport:
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
- **The ArcGIS SceneView atlas shows the selected country geometry directly.**
  Clicking the map or checking the country list highlights that country's
  outline and fill. When exactly one country is selected, the embedded atlas
  sends its ISO-2 code and `[west, south, east, north]` bbox to `atlas-shell.js`;
  the alternate Leaflet map uses that bbox for layer filtering, country-aware
  place search, and `fitBounds`. Zero or multiple selections clear the legacy
  map's single-country filter.

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
- `js/europe-roman-atlas.js` — country geometry, selection highlighting and
  the `[west, south, east, north]` bounds sent to the parent page.
- `js/atlas-shell.js` — validates same-origin selection messages, updates the
  legacy map's selected-country state, fits its bounds, and calls
  `filterLayersForCountry` / `unfilterLayersForCountry`.
- `test-country-layer-filter.js` — regression suite: Italy must not see
  France/Switzerland rows, Denmark must not see Sweden/Poland rows or the
  Polish WIG sheets; curated premium sheets stay for their countries, and the
  ArcGIS country-selection hand-off is checked.
- `test-historical-eu-maps.js` — curated-first catalog + a drift guard that
  asserts `SHARED_PREMIUM_COUNTRIES` mirrors `COUNTRIES_DATA` exactly.
- `index.html` / `sw.js` — SceneView-first map, 2D-map toggle and PWA cache
  version `v183`.

## Semantics

- *Aferentă țării* = the layer provides data for that country's territory:
  the country's own national services, sheets whose footprint genuinely covers
  the country (curated lists), and pan-European catalogues the country sits in.
  Rectangle intersection alone is **not** enough — published boxes routinely
  overshoot their data (service capability boxes include sea/foreign margins).
- Substantial coverage fallback (unanalyzed countries only): the rectangles
  must intersect and the overlap must be ≥ 5% of the country's bbox area OR
  ≥ 5% of the sheet's bbox area.
- Filtering does not change layer on/off state; when the single-country
  selection is cleared or becomes multiple, the full catalogue returns with
  each layer's prior visibility intact.
- The filter applies only to the alternate Leaflet map when the ArcGIS atlas
  reports exactly one selected country. The atlas remains navigable and is not
  locked to that country's bounds.
- Market note: attribution is market-independent. On the .eu market the Roman
  layers keep the Empire-wide box (kept for Italy/Denmark), while
  vegetation-fingerprint rows stay `['RO']` and hide abroad.

## Manual QA

- Open the full app and use the ArcGIS atlas country list to select Italy.
  Switch to the 2D map: the LiDAR group should be gone, while Mitteleuropa /
  Reymann / KDR remain (they cover the Alps) and Romanian groups are gone.
- Select Denmark: Danish LiDAR + Mitteleuropa/Chrzanowski/Reymann/KDR 100k
  remain; Sweden/Poland LiDAR and the WIG sheets are gone. Clear the selection
  or select multiple countries: all Leaflet layer rows return.
- Run `node test-country-layer-filter.js`, `node test-historical-eu-maps.js`,
  `node test-roman-reference-layer.js`, and `node test-layer-visibility.js`.
