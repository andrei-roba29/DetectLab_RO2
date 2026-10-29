# Next-Gen APM (archaeological potential model) — Phase 1: MANUAL

Status: **Phase 1 (MANUAL) implemented; live data endpoints not yet verified.**
TRAIN mode (fit to known sites) has its core code and tests in place but no UI yet.

## What it does

Scores the area of a circle around the map centre (1–25 km) from:

- **Relief**: slope, aspect (preferred sun-facing direction, flipped in the southern hemisphere) and altitude percentile within the analysis window. Fixed curves: `DEFAULT_CURVES` in `js/apm-next/apm-core.js`.
- **Water**: distance to streams, rivers, large rivers/lakes and canals, each with its own curve. The score takes the maximum over the enabled classes.
- **Soil** (optional, weight 0 by default): concavity-based moisture proxy.

The score is thresholded into three non-overlapping classes (medium, high, very high), smoothed and returned as GeoJSON polygons, one feature per class region.

## Files

| Path | Role |
|---|---|
| `js/apm-next/apm-core.js` | Curves, per-cell MANUAL scoring (`manualCellScore`), logistic fit (`trainModelFromSamples`), AUC/Kvamme validation, thresholds. UMD. |
| `js/apm-next/apm-raster.js` | Grids, Horn slope/aspect with cos-latitude correction, Euclidean distance transform, rbush-indexed water distance. |
| `js/apm-next/apm-polygonise.js` | Score grid → non-overlapping class polygons (d3 contours + polygon-clipping). Runs in the worker. |
| `js/apm-next/apm-worker.js` | Web Worker: `setAnalysis`, `score`, `train`, plus terrain/sampling ops. |
| `js/apm-next/apm-sites.js` | Known-sites CSV parsing, type/accuracy/de-duplication/distance/period filters, period grouping. |
| `js/apm-next/apm-providers.js` | Elevation, water and site data sources with fallbacks, rate limiting and an IndexedDB cache. |
| `js/apm-next/apm-pipeline.js` | Orchestration: `runManual`, `runTrain`, background sampling, sample-set assembly. |
| `js/apm-next/apm-ui.js` | Floating "APM" button and panel (MANUAL). Draws results on `window._dlMap`. |
| `css/next-gen-apm.css` | Panel styling (`.apm-*` classes only). |
| `js/vendor/` | `geotiff.browser.js`, `polygon-clipping.umd.min.js` and their licences. |
| `test-apm-next.js` | Node test suite: `node test-apm-next.js`. |

The panel is wired into `index.html` (one stylesheet, six scripts before `archeo-potential.js`). `sw.js` has cache `detectlab-v301-apm-next-phase1` and precaches the new files. The legacy `archeo-potential` layer and its `APM_TILES` layer are untouched.

## Using it

1. Pan/zoom the map to the area of interest.
2. Click **APM** (bottom-left). Set the radius, weights, water classes and thresholds.
3. **Run MANUAL model**. The first run downloads elevation and water for the circle; re-runs with the same centre, radius and smoothing reuse the analysis in the worker.
4. Results show area per class, the data sources used and any warnings. **Export GeoJSON** writes the polygons with provenance in a `metadata` member.

## Verification status

- `node test-apm-next.js`: 35 tests pass. They cover terrain numerics (including 65°N cos-latitude), distance transform and water distance against brute force, curves, logistic recovery, AUC/Kvamme, threshold ordering, manual score, polygonisation, CSV parsing and filters, provider parsers on fixtures, a synthetic 100 km TRAIN recovery test, a redundant-soil exclusion test, and the real worker file run in a VM harness.
- The panel was smoke-tested in jsdom with a stubbed pipeline: open/close, parameter read-out, result drawing, warnings, export enable and input validation. **Not yet tested in a real browser against the live map.**
- **Not verified**: the live endpoints in `apm-providers.js` (EU-DEM WCS, EU-Hydro REST, Terrarium tiles, Overpass). They are candidates with runtime discovery (WCS `GetCapabilities`, EU-Hydro layer listing) and fallbacks, but have not been exercised against the real services.

## Known limitations

- MANUAL only in the UI; curves are the fixed defaults (not editable yet).
- Radius capped at 25 km in the UI.
- Distances use a local equirectangular approximation at the query latitude (≈0.2% scale error across a 50 km circle).
- Panel text is English only; the app's translation layer is not used yet.
- The soil proxy is excluded automatically when it correlates strongly (|r| > 0.8) with slope.
