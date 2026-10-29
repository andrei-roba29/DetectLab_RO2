# Next-Gen APM (archaeological potential model)

Status: **MANUAL and TRAIN are implemented in the panel. Live data endpoints are not verified from a browser.**
Premium-only, behind an on/off switch. Cache: `detectlab-v303-apm-next-phase3`.

## What it does

Scores the area around a point you choose on the map.

- **MANUAL**: search radius **1–10 km** (default 5 km). Relief (slope, aspect, altitude percentile), water distance and an optional soil proxy, combined with weights and fixed, editable curves. Thresholded into three classes. Default weights: relief 0.6, water 0.4, **soil proxy 0**.
- **TRAIN**: fixed 50 km area. You upload a CSV of known sites. Sites are filtered (settlement types, position accuracy ≤ 100 m, de-duplication, period). A logistic model is fitted with 5-fold cross-validation and applied over the same area. Variables redundant with slope (|r| > 0.8) are excluded and reported.

Classes and colours (legend on the panel and on the map):

| Class | Colour |
|---|---|
| Medium probability | orange `#FFA500` |
| High probability | green `#2E9E4F` |
| Very high probability | baby blue `#89CFF0` |

## Using it

1. Click **APM** (bottom-left). The switch (stored as `localStorage.detectlab_apm_next`, default off) must be on, and the account must be premium. Otherwise the panel shows a gate message and Run is disabled.
2. Click **Pick point on map**, then click the map. A dashed circle shows the search radius.
3. Choose **MANUAL** or **TRAIN**. For TRAIN, upload a CSV (see *TRAIN input* below) and choose a period or all periods.
4. Run. Results show area per class, the sources actually used (label, version, resolution), warnings in the chosen language, and (TRAIN) model diagnostics. **Export GeoJSON** writes the polygons with provenance and diagnostics.

## Premium gate: what `_dlIsPremium()` returns

Defined in `js/subscriptions.js` as `window._dlIsPremium = isPremium`. `isPremium()`:

- returns `false` when there is no current user (`window._authUser()` returns nothing, i.e. logged out);
- for a logged-in user with `plan === 'premium'` and a `premiumExpiresAt` in the future, returns `true`;
- otherwise checks the local record for that user id (`localStorage` key with the prefix `LS_PREFIX`) and returns `true` only if it is premium and unexpired;
- returns `false` for free users and for expired premium.

It always returns a boolean. The panel reads it through a wrapper that also returns `false` when the function is missing or throws.

**Developer override (remove before release).** The block is marked `DEV-OVERRIDE-BEGIN` / `DEV-OVERRIDE-END` in `js/apm-next/apm-ui.js`. With `?apmDevPremium=1` in the URL, or `localStorage.apmDevPremium = '1'`, the gate opens and a yellow banner says so. Also remove the `.apm-dev-banner` CSS rule and the `devBanner` lines. Note that the override only changes the panel's own gate; it does not change any account.

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

**Fallbacks are always visible.** When an EU-DEM candidate fails, the result shows *Elevation source "EU-DEM v1.1 (EEA, 25 m)" failed (<reason>); used <source> instead*. When Terrarium is used, a second warning gives its resolution and says that terrain values are less precise than 25 m. The provenance line always shows the source, version and cell size actually used.

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
- **Download diagnostics** exports a JSON bundle: the record list, app version, user agent, page path, point, radius, settings (weights, thresholds, minimum area and slope, water classes, drainage, Strahler map, proxy switch, debug and override flags) and the last result's provenance and warnings.

## TRAIN input

CSV, comma or semicolon or tab delimited. Columns are matched by name (case-insensitive, punctuation ignored):

| Field | Accepted names (examples) |
|---|---|
| id | `id`, `site_id`, `name` |
| lat, lon | `lat`, `latitude`; `lon`, `lng`, `longitude` |
| period label | `period`, `period_label`, `culture` |
| start year | `start`, `start_year`, `period_start` |
| end year | `end`, `end_year`, `period_end` |
| type | `type`, `site_type`, `category` |
| accuracy (metres) | `accuracy`, `accuracy_m`, `position_accuracy` |

Extra columns (for example `notes`) are ignored.

**Years.** `N BC` / `N BCE` is stored in astronomical numbering: `1 BC` = year 0, `2200 BC` = −2199, `4000 BC` = −3999. A plain negative number is taken as already astronomical. Labels are shown as `N BC`.

**Thresholds.** Below **10** usable sites the run is refused (the Run button is disabled and the panel says so). Below **30** the run goes ahead with a warning that the model will be unreliable. From 30 there is no warning.

**Sample:** `samples/apm-next-SYNTHETIC-sample-sites.csv` has 36 rows. The coordinates are invented, around Marlow, England. Use it for the UI test only; it has no archaeological meaning.

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

## Files

| Path | Role |
|---|---|
| `js/apm-next/apm-core.js` | Curves, MANUAL score, logistic fit, validation, thresholds, keyed validation messages. UMD. |
| `js/apm-next/apm-raster.js` | Grids, Horn slope/aspect, distance transform, rbush water distance. |
| `js/apm-next/apm-polygonise.js` | Score grid → class polygons. Worker only. |
| `js/apm-next/apm-worker.js` | Web Worker: `setAnalysis`, `score`, `train`, sampling. |
| `js/apm-next/apm-sites.js` | CSV parsing, filters, period grouping, BCE years. |
| `js/apm-next/apm-providers.js` | DEM candidates, GetCapabilities parsing, water sources, Strahler map, proxy switch, step and request log. |
| `js/apm-next/apm-pipeline.js` | `runManual`, `runTrain`, DEM and water decisions, keyed warnings, site-count status. |
| `js/apm-next/apm-i18n.js` | Romanian and English strings (152 keys each). |
| `js/apm-next/apm-ui.js` | Panel, pick on map, switch, premium gate, dev override, legend, curves, TRAIN CSV, results, diagnostics. |
| `css/next-gen-apm.css` | `.apm-*` styles. |
| `samples/apm-next-SYNTHETIC-sample-sites.csv` | Synthetic TRAIN sample (36 rows). |
| `test-apm-next.js` | Node test suite: `node test-apm-next.js` (56 tests). |
| `LIVE_TEST.md` | Steps for the first live test and what to send back. |

Wiring: `index.html` loads the stylesheet and seven scripts (versioned `?v=20261029-apm-next-phase3`). `sw.js` precaches the same files under `detectlab-v303-apm-next-phase3`.

## Verification status

- `node test-apm-next.js`: **56 tests pass.** They cover terrain numerics (including the cos-latitude slope test at 65°N), distance transform, water distance (brute force at 10 km and 50 km, and the haversine error bounds), curves, logistic recovery, AUC and Kvamme, thresholds, the MANUAL score, polygonisation, CSV parsing (including BCE and the sample file), TRAIN thresholds (blocked below 10, before any download), provider parsers on fixtures (EU-Hydro layer list, Overpass, GetCapabilities), DEM candidate order, every failure reason, the fallback warnings (v1.1 → v1.0, and 25 m → Terrarium), the Strahler map, the drainage default, the proxy default, debug logging, translation key coverage (EN and RO), and the synthetic TRAIN recovery.
- **Browser check (headless Chromium 131, Puppeteer, stubbed pipeline):** 21 of 21 checks pass. They cover: the switch; the panel at desktop 1280×800 and mobile 390×844; radius default and bounds; drainage off by default; Strahler defaults; a map click sets the point; translated warnings in English and Romanian; the three-colour legend; the provenance line; the diagnostics bundle; the 1–10 km refusal; the free-user gate; the developer banner; and the TRAIN thresholds in the browser. No console errors. Screenshots are in the sandbox, not the repo.
- **Browser check limits:** the pipeline's `runManual` was stubbed, so no real DEM or water request was made. The map was a bare Leaflet map, not the app's map. Overlap was checked only against the stand-in control and the legend.
- **Not verified:** all live endpoints, their CORS headers, and the appearance on the real app map.

## Open issues found by the browser check

1. **Map-pick click conflict.** While picking, the APM handler and the existing app handler both run on the same click. `js/map-app.js` registers at least eight `map.on('click', …)` handlers (for example `onMapClick` at line ~1977, the coordinate tool at ~2161, and handlers at ~4232 and ~5408). Whether the pick click also triggers an app action depends on which are active. Needs a check in the real app; a fix would be a flag that those handlers respect while APM is picking.
2. **Legend overlaps the panel on phones.** With the panel open at 390 px wide, the bottom-right legend overlaps the panel's lower-right corner by about 6,900 px². Options: smaller legend on narrow screens, or placing it at the top when the panel is open.

## Known limitations

- Distances use a local equirectangular approximation (see the error table above).
- The EEA39 test is a coarse bounding approximation.
- Curves are editable in MANUAL only. In TRAIN they are learned from the sites.
- The panel's position next to the app's other controls is not verified in the real app.
