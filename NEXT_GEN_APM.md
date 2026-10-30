# Next-Gen APM (archaeological potential model)

Status: **MANUAL and TRAIN are implemented in the panel. Live data endpoints are not verified from a browser.**
Premium-only, behind an on/off switch. Cache: `detectlab-v321-apm-pick-hidden`.

## What it does

Scores the area around a point you choose on the map.

- **MANUAL**: search radius **1–10 km** (default 5 km). Relief (slope, aspect, altitude percentile), water distance and an optional soil proxy, combined with weights and fixed, editable curves. Thresholded into three classes. Default weights: relief 0.6, water 0.4, **soil proxy 0**.
- **TRAIN**: fixed 50 km area. Classified settlement points load automatically from the ARIADNE portal using subject-scoped searches, not an all-monuments search. The user is prompted to choose one of the local occupation periods (or explicitly All periods) before training. Actual point coordinates are filtered by radius, de-duplicated (50 m), and filtered by period. ARIADNE does not supply position accuracy; these positions remain unknown and are included with an explicit uncertainty warning, not labelled as accurate to 100 m. A logistic model is fitted with 5-fold cross-validation and applied over the same area. Variables redundant with slope (|r| > 0.8) are excluded and reported.

## Hybrid result: heatmap + highest-potential polygons

Both MANUAL and TRAIN show a **continuous, semi-transparent score heatmap**, with **unfilled polygon outlines only for the very-high class**. This is the model score field, not a point-density map of known settlements.

- Colour is continuous: navy → teal → amber → orange → deep red. The intermediate ramp stops follow the run's medium/high/very-high thresholds; scores are **not stretched to the local minimum/maximum**. Lower-scoring areas remain visible without becoming polygons. Labels describe relative archaeological potential, not calibrated discovery probabilities.
- Only `score >= thresholds.veryhigh` is contoured. MANUAL's default is 0.85; TRAIN uses its learned very-high threshold. The legend shows the actual cutoff. Existing minimum fragment area and boundary smoothing apply; if no hotspot survives, **no lower class is promoted** to produce a polygon.
- All scoring and contouring stay at the original analysis resolution in the worker. Only the display texture is downsampled to at most **512 × 512** pixels, averaging valid scores with coverage alpha at masked edges. No-data cells are transparent; valid zero scores are retained. The RGBA texture is transferred to the main thread without cloning the full score raster.
- Leaflet canvas tiles project map pixels back to geographic raster coordinates and interpolate the texture with premultiplied alpha. This avoids the north/south distortion of stretching a geographic image over Web Mercator. Heat tiles do not intercept map gestures; outlines remain clickable above them. Re-run, Clear and switching APM off remove both result layers together.
- Medium/high/very-high areas in the panel are calculated from the **full-resolution classified score cells**, independent of contour smoothing or omitted polygon fragments. These totals should not be read as exact exported polygon areas.
- **Export hotspot GeoJSON** contains only very-high polygon features plus provenance, chosen settlement period, thresholds and rendering metadata. It does not embed the heatmap image or full score raster. The legacy polygonisation helper still supports all-class polygons for compatibility, but the production worker requests highest-only contours.

## Using it

1. Click **APM** (bottom-left). The switch (stored as `localStorage.detectlab_apm_next`, default off) must be on, and the account must be premium. Otherwise the panel shows a gate message and Run is disabled.
2. Click **Pick point on map**. The APM settings window disappears completely and stays hidden while you pan or zoom. Select a point on the map to set the search-area centre; only then do the settings return. A dashed circle shows the search radius. Attempts to reopen the settings during selection are ignored; an explicit close or switching APM off still cancels selection.
3. Choose **MANUAL** or **TRAIN**. For TRAIN, wait for classified settlements to load, then answer **Which settlement period would you like to analyse?** Pick a local occupation period, including a named period without numeric dates, or explicitly choose **All periods**. Each option shows the usable settlement count. TRAIN stays disabled until a choice is made and at least 10 settlements match. No CSV is required. Use **Reload ARIADNE points** to retry a failed request or refresh the data.
4. Run. Results show area per class, the sources actually used (label, version, resolution), warnings in the chosen language, and (TRAIN) model diagnostics. **Export hotspot GeoJSON** writes only the highest-potential polygons with provenance, thresholds, rendering metadata and diagnostics.

## Premium gate: what `_dlIsPremium()` returns

Defined in `js/subscriptions.js` as `window._dlIsPremium = isPremium`. `isPremium()`:

- returns `false` when there is no current user (`window._authUser()` returns nothing, i.e. logged out);
- for a logged-in user with `plan === 'premium'` and a `premiumExpiresAt` in the future, returns `true`;
- otherwise checks the local record for that user id (`localStorage` key with the prefix `LS_PREFIX`) and returns `true` only if it is premium and unexpired;
- returns `false` for free users and for expired premium.

It always returns a boolean. The panel reads it through a wrapper that also returns `false` when the function is missing or throws.

**Developer override: removed in phase 4.** The `?apmDevPremium=1` / `localStorage.apmDevPremium` switch, its banner, its CSS and its translation keys are gone. The gate now follows only `_dlIsPremium()`. To test as premium, use a premium account.

## Point picking and other map tools

While **Pick point on map** is armed, `window.dlApmPicking` is `true`. Every app click handler on the Leaflet map (measure, coordinates, heritage hit test, Norway elevation, iOS building suggest, archeo points, Albania, Denmark, Finland, LiDAR focus and photo filter, LiDAR scanner, offline draw, other maps, RVT profile) returns early while it is set, so the pick click only sets the APM point. The flag is set when picking starts and cleared after the pick click has reached every handler. Closing the APM panel cancels a pick armed in it. Map clicks work normally when APM is off (the flag is then `false`).

Not covered: click handlers on other map objects (the ArcGIS views, the MapLibre 3D layer click in `map3d-terrain.js`), and one dead handler in `map-app.js` that returns on its first line. A pick armed while a marker is clicked stays armed until a click reaches the map; the Pick button shows that it is active.

## Data sources

Order is chosen by location. The EEA39 test is a coarse bounding approximation (`inEea39Approx`).

### Elevation (DEM): order of attempts

| Order | Source | Endpoint | Notes |
|---|---|---|---|
| 1 (primary) | EU-DEM **v1.1** (EEA, 25 m), inside EEA39 | `https://image.discomap.eea.europa.eu/arcgis/services/Elevation/EUElev_DEM_V11/MapServer/WCSServer` | GetCapabilities read at runtime |
| 2 (secondary, older) | EU-DEM **v1.0** (EEA, 25 m, lower quality), inside EEA39 | `https://image.discomap.eea.europa.eu/arcgis/services/GioLandPublic/DEM/MapServer/WCSServer` | GetCapabilities read at runtime. Shows a warning that it is the older version |
| 3 (fallback only) | Terrarium tiles (mixed global sources, about 30 m) | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Always used outside EEA39. Inside EEA39 only if both EU-DEM candidates fail |

The former `copernicus.discomap` candidate has been removed: its GetCapabilities returned HTML, not WCS XML.

**At run time** each EU-DEM candidate is probed with a 300 m window before use. Its GetCapabilities document is read and the following is taken from it and logged: the coverage id (matched by `/dem/i`), the advertised output formats (must include `image/tiff`), the CRS list, and any advertised maximum request size in pixels (which sets the tile size). Failures are recorded with a reason:

- `HTTP <status>` (for example 503);
- `no HTTP response (network failure or CORS block)`;
- `empty response body`;
- `wrong format (got …, expected …)`;
- `no EU-DEM coverage listed (found …)`;
- `mostly no-data at this location`.

**Fallbacks are always visible.** When an EU-DEM candidate fails, the result shows *Elevation source "EU-DEM v1.1 (EEA, 25 m)" failed (<reason>); used <source> instead*. When Terrarium is used after an EU-DEM candidate failed (inside Europe), a second warning gives its resolution and says that terrain values are less precise than 25 m. When Terrarium is the only possible source (outside EU-DEM coverage, Europe only), the result shows a plain note instead ("Outside EU-DEM coverage … Terrarium is the only elevation source"), not a warning. Keys starting with `info.` are notes: they are shown in the warnings list in italics and do not change the status to *Done with warnings*. The provenance line always shows the source, version and cell size actually used.

**Not verified:** none of the three endpoints has been called from a browser. The sandbox cannot reach the EEA host. The GioLandPublic path is the one the user supplied; its existence is not confirmed here.

### Water

| Order | Source | Endpoint | Layers |
|---|---|---|---|
| 1 | EU-Hydro River Network (EEA39) | `https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer/{id}/query` (envelope, GeoJSON, paged, quadtree split on overflow) | Layers read from `…/MapServer?f=json`, de-duplicated by name (lowest id). Strahler layers mapped to size classes (see below). River_Net_polygon and InlandWater → large |
| 2 | OpenStreetMap via Overpass (global) | `https://overpass-api.de/api/interpreter` (POST) | waterway river/stream/brook/riverbank/canal/drain/ditch; natural=water |

Not used by default: Coastal_polygon (sea), Transit_polygon, and the duplicate scale ranges (InlandWater id 3; Strahler 6–9 at ids 15–18).

**EU-Hydro Drainage Network (beta) is an advanced option, default off.** Enable it in *Advanced water options*. It is a modelled network: lines can be intermittent or incorrect, and are **not** mapped rivers. The panel and the result warn when it is included. Its layer names are not confirmed: the code matches names containing "drain" with a Strahler order. A drainage layer without a Strahler order is logged and left out.

**Strahler → size class (configurable).** The default map is:

| Class | Strahler orders | Status |
|---|---|---|
| small | 1, 2 | **untested assumption** |
| medium | 3, 4 | **untested assumption** |
| large | 5–9 | **untested assumption** |

The panel shows three text fields (comma-separated orders). An order not listed in any class is skipped. Duplicates or values outside 1–20 are refused with a message. These defaults have not been checked against any archaeological or hydrological source.

## CORS: which requests need a proxy

Requests made by the browser to other origins. Each is a potential CORS block; the browser hides the reason, so the Network tab shows it.

| Request | Host | Needs CORS on the response |
|---|---|---|
| EU-DEM WCS GetCapabilities and GetCoverage (×2 candidates) | image.discomap.eea.europa.eu | yes |
| EU-Hydro layer JSON and `/query` | image.discomap.eea.europa.eu | yes |
| Terrarium tiles | s3.amazonaws.com | yes (usually permitted) |
| Overpass | overpass-api.de | yes (usually permitted) |

**Status:** not verified. If the EEA host does not send `Access-Control-Allow-Origin` for the app's domain, every EEA request fails and the chain falls to Terrarium/Overpass with the reasons logged.

**Proxy switch (built, disabled).** `CONFIG.proxy` in `apm-providers.js` has `enabled: false`, a `prefix` and a `hosts` list. When enabled, requests to those hosts go through `prefix + encodeURIComponent(url)`. Nothing is routed through it while `enabled` is false.

**Proxy design (not built).** Use the existing Netlify pattern (`netlify/functions/*.mjs`, configured in `netlify.toml` with `[functions] directory = "netlify/functions"`):

- Function `netlify/functions/apm-proxy.mjs`. Reads `?url=`, decodes it once.
- **Domain allow-list**: only `image.discomap.eea.europa.eu` (and optionally `s3.amazonaws.com`, `overpass-api.de`). Any other host returns 403. Only `GET`, plus `POST` for Overpass.
- **Caching**: honour the upstream `Cache-Control`. Otherwise cache GetCapabilities for 24 h and GetCoverage responses for 7 days. Use Netlify Blobs or the CDN cache keyed by the full URL.
- **Rate limiting**: a per-IP token bucket (for example 30 requests/minute), held in Blobs. Respond 429 with `Retry-After`.
- Returns the upstream body and content type, adds `Access-Control-Allow-Origin` for the app origin, and logs status and duration only (no request bodies).
- Estimate: about 80 lines. It needs a decision on whether the proxy may be called from third-party origins (it should not be).

The proxy is not built, and no request is changed until a user enables it.

## Debug mode and diagnostics

- **Debug mode** (panel → *Debug log*, or `?apmDebug=1`) prints every record to the console as `[APM] {…}`.
- Records are always kept in memory (last 500). Each request record has: step (dem / water), method, URL, HTTP status, duration, content type, response size in bytes, reason on failure, and whether it went through the proxy.
- Each source decision is a `step` record: the provider, its endpoint, `used` / `failed` / `skipped`, the reason (for example *outside EEA-39 coverage* or *an earlier source was used*), and the duration. Capability reads are `caps` records (coverages, formats, CRS, limits, layer list).
- **Download diagnostics** exports a JSON bundle: the record list, app version, user agent, page path, point, radius, settings (weights, thresholds, minimum area and slope, water classes, drainage, Strahler map, proxy switch, debug flag) and the last result's provenance and warnings.

## TRAIN input

The panel uses [ARIADNE Browse / Where](https://ariadne-portal.d4science.org/browse/where?forceReload=true&mapq=true&q=).

- Source contract checked against the public [portal implementation](https://github.com/ARIADNE-Infrastructure/portal): `server/classes/Elastic/Query.php`, `QuerySettings.php`, `server/html/api/index.php` and `client/src/component/BrowseWhere/FullMap.vue`.
- Requests go to `https://ariadne-portal.d4science.org/api/search` with `bbox=north,west,south,east`, `resourceType=Site/monument`, a settlement `derivedSubject` filter, `size=50`, and one-based `page`. The portal source declares CORS `*`; no proxy or credentials are required. `mapq` is deliberately omitted because it returns heatmap aggregations rather than individual hits for large searches.
- Two subject-filtered queries are unioned: `inhabited places` (AAT 300008347, with descendants expanded by the portal), plus `settlements (sites of small communities)` (AAT 300444153, explicitly supported by the portal’s label fallback). **There is no unfiltered all-site fallback.** The adapter also validates controlled settlement subjects using a compact snapshot of the portal’s inhabited-place vocabulary; cemeteries, standalone monuments and unclassified records are not accepted based on title/description mentions. Records missing these classifications are deliberately omitted.
- All pages of each scoped query are read sequentially, with a 20 s request timeout. Missing/invalid responses, incomplete paging, and per-query counts over the portal's 10,000-hit window fail visibly; no partial dataset is used for training.
- Only `spatial.geopoint` is used. Bounding boxes, polygons and heatmap centroids are **not** invented as site locations. Non-site resources are excluded. Points outside the actual 50 km circle are removed after the bounding-box query.
- Each `temporal` entry is retained as a separate occupation phase (`from`, `until`, `periodName`, `uri`). The period picker is populated only from usable settlement locations inside the 50 km circle, after accuracy filtering and spatial de-duplication. Duplicate locations retain the union of their phases. Selecting a listed period filters by that exact phase identity, even when numeric years are absent. Explicit numeric interval filters compare against individual phases, never the envelope between earliest and latest occupation; gaps are not invented habitation. Publication dates are never used as archaeological dates. Unlabelled and undated records are available only under All periods.
- Points with `spatialPrecision` or `coordinatePrecision` flags are excluded as approximate, following the portal map’s approximate-marker convention. Metric position accuracy is not supplied in this search contract and remains `null`. ARIADNE sites are allowed with a visible warning, also retained in results/GeoJSON. This is an explicit relaxation of the old CSV-only 100 m rule. CSV helper functions remain for compatibility/testing and still reject unknown accuracy. Site source, subject scope, retrieval timestamp, chosen period and accuracy policy are included in result provenance.
- Changing the centre invalidates the previous site pool and period selection; late responses from older requests are ignored. Failed loads can be retried. Below **10** usable sites, TRAIN is blocked; below **30**, reliability is warned about.

**Verification limitation:** live requests to the Ariadne host are blocked by this sandbox's network allowlist. Automated tests use realistic API fixtures, not claims of a successful live portal run. Existing DEM/water endpoint limitations still apply.

## Approximation error (distance to water)

`raster.nearestWaterM` uses a local equirectangular distance at the query latitude, not the haversine distance. Measured against an exact haversine reference (dense sampling of each water segment), 300 random points per radius, 60 random water segments per fixture:

| Radius | Max abs error | Max relative error (points ≥ 100 m from water) | Mean relative error |
|---|---|---|---|
| 5 km | 5.1 m | 0.56 % | 0.22 % |
| 10 km | 21.6 m | 0.56 % | 0.25 % |
| 50 km | 130.7 m | 0.56 % | 0.26 % |

Notes:

- The relative error is stable at about 0.56 % at every radius. The absolute error grows with distance, and depends on how far the water segments spread. An earlier scratch run with a different fixture gave 79 m at 50 km. Treat 131 m as the figure for this fixture, not a universal bound.
- Relative error is not stated for points closer than 100 m to water, because the ratio becomes meaningless there. An earlier figure of "0.2 %" and a 9.6 % maximum at 5 km came from that near-zero case and is withdrawn.
- The tests check these bounds (`test-apm-next.js`, *approximation error vs exact haversine*). The brute-force tests check the implementation against a same-metric reference with per-point latitude scaling.

## ARIADNE regression tests

- `node test-apm-ariadne.js`: eleven provider/conversion tests, using contract-shaped fixtures without network.
- With externally installed `jsdom` available through `NODE_PATH`, the same command also runs a real-panel DOM integration test for automatic loading, explicit period choice (including named-only periods), period thresholds, passing records/source/period to TRAIN, retry, centre changes, stale responses and disabling the feature.
- `node test-apm-next.js`: 60 APM tests, including the real MANUAL/TRAIN worker producing heat textures and highest-only contours.
- `node test-apm-heatmap.js`: seven pure rendering tests: continuous/threshold-anchored ramp, transparent no-data, bounded textures, geographic interpolation, highest-only contours, no-hotspot output and raster areas.
- `test-apm-next-browser.js`: 14 checks pass in Chromium with real Leaflet, real heatmap canvases and synthetic pipeline results. Local NSS/NSPR libraries bundled with `@sparticuz/chromium` were extracted to run Chromium here; no application dependency was added.

## Files

| Path | Role |
|---|---|
| `js/apm-next/apm-core.js` | Curves, MANUAL score, logistic fit, validation, thresholds, keyed validation messages. UMD. |
| `js/apm-next/apm-raster.js` | Grids, Horn slope/aspect, distance transform, rbush water distance. |
| `js/apm-next/apm-polygonise.js` | Score grid → highest-only production contours and classified raster areas; legacy all-class helper. Worker only. |
| `js/apm-next/apm-heatmap.js` | Bounded score-to-RGBA display raster, continuous ramp, geographic canvas-tile projection. |
| `js/apm-next/apm-worker.js` | Web Worker: `setAnalysis`, `score`, `train`, sampling. |
| `js/apm-next/apm-sites.js` | ARIADNE hit conversion, legacy CSV parsing, filters, period grouping, BCE years. |
| `js/apm-next/apm-providers.js` | DEM candidates, GetCapabilities parsing, water sources, Strahler map, proxy switch, step and request log. |
| `js/apm-next/apm-pipeline.js` | `runManual`, `runTrain`, DEM and water decisions, keyed warnings, site-count status. |
| `js/apm-next/apm-i18n.js` | Romanian and English panel, period-selection and hybrid-map strings. |
| `js/apm-next/apm-ui.js` | Panel, pick on map, switch, premium gate, legend, curves, automatic TRAIN ARIADNE loading/retry, results, diagnostics. |
| `css/next-gen-apm.css` | `.apm-*` styles. |
| `samples/apm-next-SYNTHETIC-sample-sites.csv` | Synthetic TRAIN sample (36 rows). |
| `test-apm-next.js` | Node test suite: `node test-apm-next.js` (60 tests). |
| `test-apm-next-browser.js` | Browser checks (14), run with `PUPPETEER_MODULE_DIR` set. |
| `LIVE_TEST.md` | Steps for the first live test and what to send back. |

Wiring: `index.html` loads the stylesheet and eight scripts (versioned `?v=20261030-apm-pick-hidden`). `sw.js` precaches the same files, including the heatmap module used by both worker and UI, under `detectlab-v321-apm-pick-hidden`.

## Verification status

- `node test-apm-next.js`: **60 tests pass.** (Browser checks: see below.) They cover terrain numerics (including the cos-latitude slope test at 65°N), distance transform, water distance (brute force at 10 km and 50 km, and the haversine error bounds), curves, logistic recovery, AUC and Kvamme, thresholds, the MANUAL score, polygonisation, CSV parsing (including BCE and the sample file), TRAIN thresholds (blocked below 10, before any download), provider parsers on fixtures (EU-Hydro layer list, Overpass, GetCapabilities), DEM candidate order, every failure reason, the fallback warnings (v1.1 → v1.0, and 25 m → Terrarium), the Strahler map, the drainage default, the proxy default, debug logging, translation key coverage (EN and RO), and the synthetic TRAIN recovery.
- **Browser checks (`test-apm-next-browser.js`, headless Chromium, real Leaflet, heatmap canvases and panel, pipeline stubbed):** 14 checks, all pass. They cover: APM off (a normal map click reaches the handler); a pick click goes to APM only and the flag clears after it; a handler registered during a pick is also blocked; closing the panel cancels a pick; the legend and the panel do not overlap at 390 px with a result, the legend returns when the panel closes, and the legend is visible at 1280 px; and the Terrarium-only note is shown as an info note with status *Done*; and a free account stays gated, with no developer banner. Point-selection checks verify computed display/zero panel height on desktop and phone, in both modes, including panning, attempts to reopen settings and CSS display overrides; settings return only after a point is accepted. Hybrid checks also verify coloured canvas pixels, unfilled outlines above the heat layer, zoom/pan, replacement/cleanup, no-hotspot behaviour and highest-only GeoJSON export. Run with `PUPPETEER_MODULE_DIR=<dir with puppeteer-core and @sparticuz/chromium>/ node test-apm-next-browser.js`; without the variable it is skipped.
- **Browser check limits:** the pipeline's `runManual` is stubbed, so no real DEM or water request is made. The map is a bare Leaflet map: the app's own click handlers (map-app.js etc.) are not loaded, because the full page needs login, Supabase and CDN scripts that the sandbox cannot reach. Their guard lines are checked by source in `test-apm-next.js`.
- **Not verified:** all live endpoints, their CORS headers, and the appearance on the real app map.

## Resolved in phase 4

0. **Developer premium override removed** (`?apmDevPremium=1` and its banner). Checked by a source test and a browser test: a free account stays gated even with the old localStorage key set.
1. **Map-pick click conflict.** Fixed with the shared `window.dlApmPicking` flag (see *Point picking and other map tools*). Checked by a source test for each handler and by the browser checks. Not yet checked in the real app.
2. **Legend overlapped the panel on phones.** Fixed: the map legend is hidden on narrow screens while the panel is open (see *Phone layout*). Measured in the browser at 390 px: before the fix the legend (x 213–380, y 741–834) overlapped the panel (x 12–352, y 183–774) by 139 × 33 px, about 4,600 px². After the fix there is no overlap.

## Phone layout (legend)

On screens up to 600 px wide the map legend (bottom-right) is hidden while the APM panel is open, because the panel (bottom-left, 340 px) would cover it. The panel repeats the heat gradient, very-high outline legend, score cutoff and class areas, so nothing is lost. The legend returns when the panel closes. Desktop widths are unchanged (checked at 1280 px).

## Known limitations

- Distances use a local equirectangular approximation (see the error table above).
- The EEA39 test is a coarse bounding approximation.
- Curves are editable in MANUAL only. In TRAIN they are learned from the sites.
- The panel's position next to the app's other controls is not verified in the real app.
