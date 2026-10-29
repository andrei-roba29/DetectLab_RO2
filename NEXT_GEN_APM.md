# Next-Gen APM (archaeological potential model)

Status: **MANUAL and TRAIN implemented in the panel. Live data endpoints are not yet verified in a browser.**
Premium-only, behind an on/off switch.

## What it does

Scores the area around a point you choose on the map (search radius 1–10 km in MANUAL; a fixed 50 km area in TRAIN).

- **MANUAL**: relief (slope, aspect, altitude percentile), water distance, and an optional soil proxy, combined with weights and fixed, editable curves. Thresholded into three classes.
- **TRAIN**: you upload a CSV of known sites. Sites within 50 km are filtered (settlement types, position accuracy, de-duplication, period). A logistic model is fitted with cross-validation, and the model is then applied over the same area. Variables that are redundant with slope (|r| > 0.8) are excluded and reported.

Classes and colours (legend on the panel and on the map):

| Class | Colour |
|---|---|
| Medium probability | orange `#FFA500` |
| High probability | green `#2E9E4F` |
| Very high probability | baby blue `#89CFF0` |

## Using it

1. Click **APM** (bottom-left). It shows *premium* if your account is not premium, and *off* while the switch is off. The switch is stored in `localStorage` as `detectlab_apm_next` (default off).
2. Click **Pick point on map**, then click the map. A dashed circle shows the search radius.
3. Choose **MANUAL** or **TRAIN**. For TRAIN, upload the CSV and choose a period (or all periods).
4. Run. Results show area per class, the data sources used, warnings and (TRAIN) model diagnostics. **Export GeoJSON** writes the polygons with provenance and diagnostics in `metadata`.

Premium is checked with the app's own entitlement function, `window._dlIsPremium()` (defined in `js/subscriptions.js`).

## Data sources (exact endpoints and layers)

Order is chosen by location. The EEA39 test is a coarse bounding approximation (`inEea39Approx` in `apm-providers.js`).

### Elevation (DEM)

| Priority | Where | Endpoint | What is requested |
|---|---|---|---|
| 1 | Inside EEA39 | `https://image.discomap.eea.europa.eu/arcgis/services/Elevation/EUElev_DEM_V11/MapServer/WCSServer` | WCS `GetCapabilities` to discover the coverage id (expected `DEM_v11_Masked2`, matched by `/dem/i`), then `GetCoverage` (GeoTIFF, EPSG:4326 subset) |
| 1b | Inside EEA39, if 1 fails | `https://copernicus.discomap.eea.europa.eu/arcgis/services/Elevation/EUElev_DEM_V11/MapServer/WCSServer` | same |
| 2 | Fallback (and only source outside EEA39) | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Terrarium PNG tiles, decoded to metres |

**Verification:** the EU-DEM service path is confirmed from EEA's catalogue. The WMS endpoint `…/Elevation/EUElev_DEM_V11/MapServer/WMSServer` exposes layer `DEM_v11_Masked2`. The WCS on the same service is not confirmed from the sandbox (its capabilities document could not be retrieved), so the code tries both candidates and logs the outcome. The `GioLandPublic/DEM` path used earlier is not used any more.

### Water

| Priority | Where | Endpoint | Layers |
|---|---|---|---|
| 1 | Inside EEA39 | `https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer/{id}/query` (envelope, `f=geojson`, paged, quadtree split on overflow) | Layers are read from the service JSON (`…/MapServer?f=json`), then de-duplicated by name (lowest id): **Strahler 1, 2 → small; 3, 4 → medium; 5–9 → large** (ids 5–13 under group `River_Net_lines`, id 4); **River_Net_polygon** (id 19) → large; **InlandWater** (id 2) → large |
| 2 | Global fallback (and only source outside EEA39) | `https://overpass-api.de/api/interpreter` (POST, Overpass QL) | `waterway` = river, stream, brook, riverbank, canal, drain, ditch; `natural=water` ways and multipolygon relations |

Deliberately **not** used: Coastal_polygon (0, sea), Transit_polygon (1), InlandWater id 3 and Strahler 6–9 in the second group (ids 15–18) (same features at another scale, which would double-count), and the Drainage Network (20, public beta).

The EU-Hydro service JSON was verified from the sandbox (service version 2.9.0, EEA39). Query behaviour (`f=geojson`, envelope in EPSG:4326) is what the service advertises; it has not been exercised from a browser.

## Debug mode (for network and CORS problems)

Turn it on with the **Debug mode** switch in the panel's *Debug log* section, or add `?apmDebug=1` to the page URL. Each request is logged with its method, URL, HTTP status and duration. A request that gets no HTTP response is labelled as a network failure or CORS block. The log is kept in memory (last 500 entries), mirrored to the console as `[APM] …`, and can be downloaded as JSON.

Note that the browser hides the reason for CORS failures from scripts, so the Network tab is the place to confirm them.

## Files

| Path | Role |
|---|---|
| `js/apm-next/apm-core.js` | Curves, per-cell MANUAL score, logistic fit, validation, thresholds, input validation (radius, curve text). UMD. |
| `js/apm-next/apm-raster.js` | Grids, Horn slope/aspect with cos-latitude correction, Euclidean distance transform, rbush-indexed water distance. |
| `js/apm-next/apm-polygonise.js` | Score grid → class polygons (d3 contours + polygon-clipping). Worker only. |
| `js/apm-next/apm-worker.js` | Web Worker: `setAnalysis`, `score`, `train`, plus terrain and sampling ops. |
| `js/apm-next/apm-sites.js` | CSV parsing, type/accuracy/de-duplication/distance/period filters, period grouping. |
| `js/apm-next/apm-providers.js` | DEM and water sources above, rate limiting, IndexedDB cache, debug log. |
| `js/apm-next/apm-pipeline.js` | `runManual`, `runTrain`, background sampling, sample-set assembly. |
| `js/apm-next/apm-i18n.js` | Romanian and English strings for the panel. |
| `js/apm-next/apm-ui.js` | Floating button, panel, pick-on-map, switch, premium gate, legend, editable curves, TRAIN CSV flow, results, export, debug log. |
| `css/next-gen-apm.css` | Panel styling (`.apm-*` only). |
| `js/vendor/` | `geotiff.browser.js`, `polygon-clipping.umd.min.js` and their licences. |
| `test-apm-next.js` | Node test suite: `node test-apm-next.js` (43 tests). |

Wiring: `index.html` loads the stylesheet and six scripts before `archeo-potential.js`. `sw.js` uses cache `detectlab-v302-apm-next-phase2` and precaches the new files (including the worker's versioned URL). The legacy archeo layer is not touched.

## Verification status

- `node test-apm-next.js`: 43 tests pass. They cover terrain numerics (including the cos-latitude slope test at 65°N), distance transform and water distance against brute force, curves, logistic recovery, AUC and Kvamme, thresholds, the MANUAL score, polygonisation, CSV parsing and filters, provider parsers on fixtures (including the real EU-Hydro layer list), the EU-DEM endpoint fallback, debug logging, input rules (radius, curve text, translations, class colours), a synthetic 100 km TRAIN recovery test, a redundant-soil exclusion test, and the real worker file in a VM harness.
- The panel was driven in jsdom (no real browser or map): gate, switch, point picking, radius limit, MANUAL run with soil weight, curve validation and reset, TRAIN CSV upload and period choice, TRAIN run and diagnostics, Romanian relabelling, debug toggle, and switch-off clearing. 38 checks pass.
- **Not verified:** live endpoints (EU-DEM WCS, EU-Hydro query, Terrarium, Overpass), their CORS headers, and the appearance of the panel and legend on the real map. These are the things the debug log is for.

## Known limitations

- Distances use a local equirectangular approximation at the query latitude; the error is about 0.2 % across a 50 km circle.
- The EEA39 test is a coarse bounding approximation.
- Engine messages (warnings and errors from the pipeline and providers) are still English; the panel's own labels are translated.
- Curves are editable in MANUAL only. In TRAIN they are learned from the sites.
- The panel is placed bottom-left and may need adjustment next to other controls.
