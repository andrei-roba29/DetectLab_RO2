# Archeological Potential Sites — "Zone cu potențial arheologic"

Premium map analysis layer for DetectLab.

> **This layer does NOT predict archaeological sites with AI.** It identifies
> candidate areas that *statistically* have a higher probability of containing
> undiscovered sites, based only on the spatial distribution of the already
> known archaeological sites around the current map center.

---

## Files

| File | Purpose |
|---|---|
| `js/archeo-potential.js` | The whole layer: triangulation, filtering, scoring, score field, rendering, pin/radius, UI wiring. |
| `js/leaflet-heat.js` | `L.heatLayer` (simpleheat). **No longer used by this layer** — the heatmap is now the layer's own score raster (see below). Still in the app shell, so keep it precached. |
| `js/vertical-opacity-control.js` | Mirrors the layer's radius slider vertically on the map and docks its action button bottom-centre (`DISTANCE_SOURCES`, `syncDistanceDock`). |
| `index.html` | Premium-tab UI row (permanent purple pin, radius slider, output-mode buttons, run button, dual legend, status) + `#layerActionDock` + `<script>` includes. |
| `css/styles.css` | `.archeo-pot-*` (row, pin, mode buttons, legend, heat bar), `.layer-action-dock*`, `[data-kind="distance"]` mirror colours. |
| `js/translations.js` | RO/EN labels for the new UI. |
| `sw.js` | Pre-cache list + cache version bump for the new scripts. |
| `test-archeo-potential.js` | Node test harness (pure logic + field pipeline + UAT sampling/fail-open + determinism + bubble packing/coverage + heat raster + legend + zoom/pan + pin/radius). Run with `node test-archeo-potential.js`. |
| `bench-archeo-coverage.js` | Coverage benchmark on a synthetic scenario (4 site clusters + striped UAT). `node bench-archeo-coverage.js [radiusKm] [lat] [lng] [jsonOverrides] [uatMode]` with `uatMode` = `ok` \| `unreadable` \| `missing`. |
| `test-vertical-opacity-control.js` | Covers the distance mirror + action dock. Run with `node test-vertical-opacity-control.js`. |

---

## Clicking a candidate — popup with star rating

Every candidate circle is **clickable**. Clicking opens a small popup with:

- **Classification + raw score %** (`High Potential — 72%`).
- **5-star rating** — the score (0–1) is converted to `score × 5` stars with
  partial fill (e.g. `0.72 → 3.6/5`). The stars' colour comes from the layer's
  one score ramp: cold navy (0) → blue (0.25) → green (0.55) → amber (0.75) →
  violet (1.0), so the colour itself also encodes the score. **Red is never a
  score colour** — it is reserved for the exclusion mask.
- **Distance to the closest known site** (always ≥ 700 m by the mandatory
  distance filter — the exact value is shown, e.g. `812 m`).
- Full scoring breakdown: nearby site count, average distance, local density,
  triangle quality, and coordinates.

Internally the colour mapping lives in `scoreColor()` / `scoreColorHex()` /
`scoreColorRgb()` and the star markup in `starRatingHtml()` (all exposed on
`_archeoPotentialDebug`); the ramp stops are `HEAT_GRADIENT`, which the bubbles,
the heatmap and the legend all read from.

---

## Workflow (button press)

1. Take the **purple pin** dropped on the map (the map-point logic is
   permanent — no pin switch; tap the map any time the layer is on) or,
   without a pin, the **current map center** (`map.getCenter()`).
2. Build a search circle from the **radius slider** (`#archeoPotDistance`,
   1–10 km; `currentRadiusM()`). Headless callers that pass no radius still get
   `SEARCH_RADIUS_M` (10 km).
3. Load every known archaeological site intersecting the circle from DetectLab's
   own API data already present in `window._localLayerData`
   (layers `0` = RAN sites, `5` = tumuli, `6` = site-boundary polygons).
4. Project the working area to local meters (center-latitude Web Mercator) and
   run a **Delaunay triangulation** (Bowyer–Watson) over the site coordinates.
   Triangles are bucketed in a uniform index (`TRI_INDEX_CELL_M`) so any point
   finds its containing triangle in O(1).
5. **Tile the whole circle with a regular grid** (`buildFieldCells`) — one grid
   for both modes, cell size adapts to the radius (`gridCellM`: 120 m baseline,
   grown until the circle holds ≤ `FIELD.MAX_CELLS` 9000 cells → 125 m at 1–4 km,
   175 m at 10 km).
6. **Pre-load every UAT tile the grid needs** (`prewarmUatTiles`, bounded
   concurrency `UAT.CONCURRENCY` 6, per-tile timeout + one retry). Scoring is
   synchronous afterwards, so a cell is never decided by a tile that had not
   arrived yet — this is what removed the "sometimes nothing is generated"
   behaviour. The first 30 % of the progress bar is this phase
   (`running_tiles`).
7. Score **every cell** (`scoreCandidate` + `triScoreAt`) after the mandatory
   exclusion checks; excluded cells are recorded with a reason (`uat`,
   `heritage`) instead of being dropped silently.
8. **Pack the bubbles** (`selectBubbles`) or **build the heat raster**
   (`buildHeatRaster`) from that same field, then render it plus the red
   exclusion mask.

> `window.computeArcheoPotential(centerLat, centerLng, radiusM, opts)` still
> runs the **original candidate pipeline** (few, separated, Medium/High only)
> and is what the Archeological Report layer consumes — its signature and result
> shape are unchanged. The map layer uses the separate
> `window.computeArcheoPotentialField(...)` score field.

---

## Two output modes (bubbles / heatmap)

Both modes read the **same dense score field**; they only differ in how they
show it (`#archeoPotModeBubbles` / `#archeoPotModeHeat`,
`setArcheoPotentialMode`). Switching modes re-renders the last analysis
immediately — the rendering follows the UI mode, not the mode the field was
computed with.

| | **Bubbles** | **Heatmap** |
|---|---|---|
| Geometry | a **sparse selection** of the best cells (`selectBubbles`), one `L.circle` each, with **its own radius** | a **score raster** (1 px per grid cell) drawn on a canvas anchored to the geography |
| Grid | the shared grid (`gridCellM`, ≤ `FIELD.MAX_CELLS` 9000 cells) | the same grid — one raster pixel per cell |
| Score encoding | disc radius = how much free ground fits there; colour = `scoreColor(score)` (same ramp as the heatmap) + popup with star rating | `HEAT_GRADIENT` ramp (`#10233f → #1f7fc4 → #23c48e → #f2b134 → #8b3ff0`) on an **absolute** 0..1 scale **plus** alpha growing with the score |
| Pane | `pane_archeo` (z 660) | `pane_archeo_heat` (z 656) |

**Every point is considered**: `stats.scored + stats.excludedUat +
stats.excludedHeritage === stats.cells`.

### Bubbles — packing the free ground

The bubbles are not "the best N cells": they are a **packing** of the free
ground. A cell becomes a bubble only when its **whole disc** fits, and the
selection keeps adding smaller discs until the area is as full as the geometry
allows (`CONFIG.BUBBLE`):

1. **clearance per cell**, measured once (`measureClearance`) — exact distance
   to the nearest red thing: the heritage rings (`SITE_RADIUS_M` +
   `SITE_BUFFER_M` = 700 m), the site-boundary polygons and the UAT built-up
   rectangles (point→box distance over a uniform grid index of the excluded
   cells);
2. **total ordering** — cells are sorted by score, then by `row`/`col`. There is
   no `Math.random()` and no iteration-order dependence anywhere in the layer,
   so the same area gives **bit-for-bit the same bubbles and scores on every
   run** (asserted by the test harness);
3. **size tiers, large → small** — `TIERS` `[1, 0.66, 0.44, 0.28]` ×
   `bubbleBaseRadiusM(radius)`; each cell takes the largest disc its clearance
   allows (`radius = min(tierR, clearance − MASK_CLEARANCE_M)`, clearance 25 m),
   a tier is used down to `TIER_FILL` (72 %) of its radius, and a disc that
   would fall below `RADIUS_FLOOR_M` (35 m) is not drawn. Gaps shrink with the
   tier (`bubbleGapForRadius`, floor `GAP_MIN_M` 15 m) so small bubbles pack
   tighter than big ones;
4. **a filler tier sized from the grid** — `radius = (cellM − GAP_MIN_M) / 2`, so
   two neighbouring cells can each host a bubble. This removed the big holes the
   "best cells only" selection used to leave;
5. **gap-fill lattice** (`gapFillCandidates`) — a second set of centres offset by
   half a cell, tried only while coverage is under `COVERAGE_TARGET` (0.82) and
   the cap is not reached. Those bubbles carry `gapFill: true`; they are the
   "small free spaces between bubbles" the heatmap mirrors;
6. **caps** — `bubbleCountCap` = max(`PER_KM2` 4.5 × km², the number of typical
   discs needed to reach the coverage target), clamped to `MIN_BUBBLES` 26 …
   `MAX_BUBBLES` 1400.

Conflicts are checked **edge to edge** (`r₁ + r₂ + gap`) through a uniform grid
index, so no two bubbles ever overlap or interleave, none overlaps a heritage
radius and none touches the UAT mask.

| | 1 km | 4 km | 10 km |
|---|---|---|---|
| grid cell | 125 m | 125 m | 175 m |
| base radius (`bubbleScale`, floor 0.34) | 150 m | 266 m | 420 m |
| gap at full size | 24 m | 44 m | 70 m |
| bubble cap | 40 | 376 | 1400 |

Measured on the synthetic scenario (`node bench-archeo-coverage.js`, 4 site
clusters + half-tile UAT stripes):

| radius | scored cells | bubbles | free ground covered |
|---|---|---|---|
| 1 km (centre of a cluster) | 44 | 8 (cap 40) | 4.7 % of 0.69 km² |
| 4 km | 1 320 | 328 (14 gap-fill) | **51.8 %** of 20.63 km² |
| 10 km | 5 400 | 1276 (6 gap-fill) | **68.1 %** of 165.38 km² |

The 1 km row is **geometry-limited, not a selection failure**: eight clustered
sites put 156 of the 208 cells inside a 700 m heritage ring, and every
remaining free cell sits within 70 m of the red mask, so no disc larger than
~42 m fits. The heatmap is the mode that covers that ground.

### Heatmap — a real score surface

`leaflet-heat` accumulates **alpha** from overlapping blobs. With a dense grid
every pixel is covered by dozens of blobs, so alpha saturates at 1 nearly
everywhere and the whole surface ends up one colour; on top of that its blob
radius is in pixels and its canvas is repositioned only on `moveend`, so the
heat visibly slides while zooming.

The layer now builds its own surface (`buildHeatRaster`):

1. every scored cell writes its score into a `cols × rows` grid
   (`field.grid`, cells carry `row`/`col`);
2. scores go through `heatScoreWindow`, which with the default
   `HEAT.NORMALIZE = 'absolute'` is simply **0..1** — a colour always means the
   same score in every run, which is what makes the legend truthful. (The old
   percentile stretching made the same ground change colour between runs and
   contradicted the legend; it is still available as `'percentile'`, with
   `LOW/HIGH_PERCENTILE` and the `MIN_WINDOW` 0.12 expansion for narrow score
   bands.) Gap-fill cells are scored too, so the spaces between bubbles are
   filled with the same triangulated logic;
3. a separable gaussian blur (`HEAT.SMOOTH_SIGMA_CELLS` = 1 cell) smooths
   **between scored cells only** — excluded cells stay transparent, so the red
   mask is not painted over;
4. each cell is coloured through the 256-entry ramp LUT (`buildHeatRamp`) and
   given an alpha between `HEAT.ALPHA_MIN` (0.52) and `HEAT.ALPHA_MAX` (0.97)
   with `ALPHA_GAMMA` 0.6 — weak zones read as faint, strong zones as
   saturated, and the whole free area is opaque enough to look covered;
5. the small raster is drawn scaled between the **geographic** corners of the
   grid, on a canvas positioned with the same contract as the Patrimoniu
   canvases in `map-app.js`: `containerPointToLayerPoint([0,0])` +
   `project(latlng) − pixelOrigin` on every settled view
   (`move/moveend/zoom/zoomend/viewreset/resize`), and the renderer transform
   (`getZoomScale` + `_getNewPixelOrigin`, scaled around the recorded bitmap
   anchor) during `zoomanim`/pinch. Unrounded projection keeps a zoom jump from
   multiplying a half-pixel rounding error into a visible slide.
   **Orientation is north-up**: the grid indexes row 0 at the southern edge
   (`minLat`), while the bitmap's top row is pinned to `maxLat` (north), so
   `createHeatSourceCanvas` copies the raster rows flipped — a cell's colour
   always lands at its own latitude, exactly where its bubble is drawn.
   (The old un-flipped copy painted the whole surface mirror-reversed N–S:
   colours and the transparent exclusion holes landed on the opposite side of
   the circle, in places that are neither UAT nor a site radius.)

So a colour always means the same thing — the score of that ground — and the
surface stays glued to the map at every zoom. `test-archeo-potential.js`
asserts both: the drawn width equals the grid's geographic extent at z10/z13/
z16 (±2 %), and the ramp steps are far apart in RGB.

**Excluded areas are red** (in both modes) and live in `pane_archeo_mask`
(z 658): UAT-excluded cells merged into row-run `L.rectangle`s, the 600 + 100 m
heritage protection rings, and the site-boundary polygon outlines. Red is
reserved for exclusions — the score ramp ends in violet instead.

---

## In the 3D view

The layer is projected into the 3D terrain view (`js/map3d-terrain.js`, fed by
`js/map3d-mirror.js`) in both output modes, plus the red exclusion mask. The 3D
copy is built from the same field as the 2D one, so it follows the same mode
switch, slider and on/off state.

| What | 3D form | Layer name in the 3D panel |
|---|---|---|
| Bubbles (bubbles mode) | one 32-sided ground polygon per bubble, at the bubble's metre radius, coloured as in 2D; popup = the 2D star-rating popup | `Archeological Potential Sites` |
| Heatmap (heatmap mode) | the score raster as a georeferenced PNG over the grid's bbox, north-up, opacity 0.82 (`heatLayerProto._dl3dImage()`, mirror kind `image`) | `Archeological Potential Sites — heatmap` |
| Red mask (both modes) | ground polygons: the UAT built-up exclusion and the heritage protection circles (site radius + buffer, 700 m); no popup (`kind: 'exclusion'`) | `Archeological exclusion (red)` |

Notes for whoever changes this:

- **Radii are ground metres.** MapLibre's `circle-radius` is in screen pixels, so
  the circles are built as ground rings (`groundRing3d`, `rectRing3d`) instead of
  being passed as a circle paint. The rings match `L.circle` within about 1 %.
- **Each feature reaches 3D once.** The layer group's own children are marked
  `_dl3dSkip`, and the group supplies its features through `_dl3dFeatures()`
  (`own3dFeatures`). Without this the mirror walked each bubble twice.
- **The click-through canvas renderers are not mirrored.** A Leaflet renderer is
  not a layer, so the mirror skips it (`isRenderer`). Otherwise the custom
  `pane_archeo` canvas shows up as an unsupported layer.
- **The heat image is north-up.** `buildHeatRaster` indexes row 0 at the southern
  edge; the canvas flips it on draw. The point fallback in the mirror
  (`rasterHeatPoints`) uses the same convention.

Covered by `test-archeo-3d-projection.js` (contracts, metre radii, north-up
picture, mode switching, off-state) and `test-analysis-layers-3d.js`.

## Map-side controls (distance mirror + action dock)

`js/vertical-opacity-control.js` registers the analysis layers' distance/radius
sliders explicitly (`DISTANCE_SOURCES`, by id — never through the generic
`[id*="Opacity"]` panel selector):

| Layer | slider | toggle | docked button |
|---|---|---|---|
| LIDAR Scanner | `#lidarScannerDistance` (10–50 km) | `#lidarScannerToggle` | `#lidarScannerRun` |
| Archeological Potential Sites | `#archeoPotDistance` (1–10 km) | `#archeoPotToggle` (main layer switch) | `#archeoPotRunBtn` |
| Archeological Report | `#archReportDistance` (1–10 km) | `#archReportToggle` | `#archReportRunBtn` |

Pressing the layer row (or switching the layer on) opens the **vertical mirror**
on the right — same interaction as the opacity sliders, but `data-kind="distance"`
formats the value in km, shows a `DISTANCE`/`RAZĂ` caption and colours the mirror
per layer through `data-owner`. The layer's own action button is **physically
moved** into `#layerActionDock` (bottom-centre of the map screen) with a radius
chip beside it, and returned to its panel row when the mirror closes. While the
dock is open, `body.layer-dock-open` lifts the other bottom-centre floating
controls (`--layer-dock-clearance`) so nothing overlaps.

The purple pin works like the LIDAR/report points, with one difference: there
is **no separate pin switch** — the map-point logic is permanent while the
layer's main switch (`#archeoPotToggle`) is on. Tap the map to drop the pin,
drag the slider to resize its circle, press the docked button to analyse that
exact radius; without a pin the analysis starts from the map center. Turning
the layer off also closes the pin logic (removes the tap handler and the pin),
the mirror and the dock.


---

## Mandatory filters (all must pass)

1. **Inside the UAT "red zone"** — the candidate must sit on ground the UAT
   raster (Cloudflare R2 tiles, zoom 14) paints red, i.e. **opaque + dark**
   pixels (`uatIsRedPixel`, the same convention as `map-app.js` and
   `archeo-report.js`). Transparent or light pixels = intravilan/built-up →
   discarded.
   - **The verdict is per cell, not per pixel.** `uatCellRedFraction` samples a
     k×k lattice across the cell's own box (`SAMPLE_STEP_M` 50 m, at most
     `MAX_SAMPLES_PER_AXIS` 8 per axis) and keeps the cell while
     ≥ `MIN_RED_FRACTION` (0.5) of the readable samples are red. A 175 m cell
     used to be decided by one ~9.5 m pixel, so exclusion looked speckled and
     arbitrary at the intravilan border.
   - **Tiles are pre-loaded before scoring** (step 6 of the workflow), each with
     a timeout (`TILE_TIMEOUT_MS` 9 s), one retry through the layer's own image
     loader, and a per-tile state cache (`ok` / `missing` / `unreadable` /
     `timeout`) that expires failures after `FAILURE_TTL_MS` (60 s). Cached tiles
     are stored as a compact **red mask** (1 byte/pixel, 64 kB instead of 256 kB)
     and the cache is FIFO-bounded (`MAX_CACHED_TILES` 600).
   - **Unreadable raster → fail open** (`FAIL_OPEN_WHEN_UNREADABLE` true): if no
     tile could be decoded (CORS, offline, 404 storm) the built-up exclusion is
     *skipped* and reported in the status line (`uat_unavailable` /
     `uat_partial`), instead of silently emptying the map. The heritage radii
     stay excluded and stay red either way.
2. **Distance from existing sites** — every known site has a protection radius
   (`SITE_RADIUS_M` = 600 m, the same value as the app's heritage circles).
   A candidate must be at least `SITE_RADIUS_M + SITE_BUFFER_M` (600 + 100 m)
   from every site's center. Polygon sites (layer 6) are represented by
   guard points along their perimeter (every `POLYGON_GUARD_STEP_M` m) plus
   their centroid, and candidates may not fall **inside** a site polygon.
3. **Search circle** — cells are only generated inside the slider radius
   (1–10 km; 10 km = `SEARCH_RADIUS_M` for headless callers).
4. **Separation** *(legacy candidate pipeline only)* — after scoring, candidates
   closer than `CANDIDATE_MIN_SEPARATION_M` (900 m) to a higher-scored candidate
   are suppressed; output is capped at `MAX_CANDIDATES`. The score **field**
   keeps every cell (that is the point of the dense modes), so it applies no
   separation and no cap.

---

## Scoring (0..1, configurable weights)

| Factor | How it's computed | Config |
|---|---|---|
| Nearby sites | sites within 1.5 km, normalized by 6 (`2 → 0.33`, `4 → 0.67`, `6+ → 1.0`) | `SCORING.NEARBY_RADIUS_M`, `NEARBY_COUNT_REF` |
| Avg. distance | mean distance to the 5 nearest sites, `1 − avg/3000 m` | `SCORING.K_NEAREST`, `AVG_DIST_REFERENCE_M` |
| Triangulation | triangle quality (equilateral = 1, sliver → 0) × centroid-proximity bonus | `MIN_TRIANGLE_QUALITY`, `MAX_SAMPLES_PER_TRIANGLE` |
| Density | sites within 3 km, normalized by 8 | `SCORING.DENSITY_RADIUS_M`, `DENSITY_COUNT_REF` |

Weights (default `0.30 / 0.25 / 0.25 / 0.20`) live in `CONFIG.SCORING`.
Classification thresholds in `CONFIG.CLASSIFY`:

- `score < 0.25` → **discarded**
- `0.25 ≤ score < 0.55` → **Medium Potential**
- `score ≥ 0.55` → **High Potential**

**Adding a new criterion later:** add a normalized factor in
`scoreCandidate()` and a weight row in `SCORING` — nothing else changes.

---

## Live configuration (no redeploy)

```js
// from the browser console
ARCH_POTENTIAL_CONFIG.SEARCH_RADIUS_M = 15000;          // 15 km working area
ARCH_POTENTIAL_CONFIG.SITE_RADIUS_M = 300;              // smaller heritage rings
ARCH_POTENTIAL_CONFIG.CLASSIFY.SCORE_HIGH_FROM = 0.6;   // stricter High class
ARCH_POTENTIAL_CONFIG.SCORING.W_TRIANGLE = 0.35;        // boost triangle weight
ARCH_POTENTIAL_CONFIG.SHOW_TRIANGULATION = true;        // debug: draw triangles

ARCH_POTENTIAL_CONFIG.BUBBLE.RADIUS_M = 520;            // bigger bubbles at 10 km
ARCH_POTENTIAL_CONFIG.BUBBLE.GAP_M = 40;                // tighter packing
ARCH_POTENTIAL_CONFIG.BUBBLE.TIERS = [1, 0.7, 0.5];     // fewer size steps
ARCH_POTENTIAL_CONFIG.BUBBLE.COVERAGE_TARGET = 0.9;     // push the gap-fill pass
ARCH_POTENTIAL_CONFIG.BUBBLE.MAX_BUBBLES = 2000;        // raise the cap
ARCH_POTENTIAL_CONFIG.FIELD.CELL_M = 90;                // finer grid (slower)

ARCH_POTENTIAL_CONFIG.HEAT.NORMALIZE = 'percentile';    // stretch per run instead
ARCH_POTENTIAL_CONFIG.HEAT.ALPHA_MAX = 1;               // fully opaque surface
ARCH_POTENTIAL_CONFIG.UAT.MIN_RED_FRACTION = 0.35;      // stricter intravilan test
ARCH_POTENTIAL_CONFIG.UAT.FAIL_OPEN_WHEN_UNREADABLE = false;  // old fail-closed policy
```

Legend consistency: `CONFIG.CLASSIFY` thresholds (0.25 / 0.55) drive both the
bubble colours and the ramp stops (`HEAT_GRADIENT` at 0 / 0.25 / 0.55 / 0.75 /
1.0), and `syncLegend()` repaints the swatches, the percentage bands and the
heat bar from those very values — so changing a threshold updates the legend
with it.

---

## Performance

- **Global grid spatial index** (R-tree-style culling) is built lazily once
  over all loaded heritage features and cached; per-run queries only touch
  the cells overlapped by the 10 km circle.
- **UAT tile reads** go through the app's loader first (with its own promise
  cache) and are stored per tile as a 1-byte-per-pixel red mask, FIFO-bounded to
  600 tiles — a 10 km run is ~156 tiles ≈ 10 MB instead of ~40 MB of RGBA, and
  repeated runs in the same area read nothing new.
- The analysis runs in **async chunks** (`FIELD.CHUNK_SIZE` = 400 cells per
  batch for the field, 30 seeds per batch for the legacy pipeline), yielding to
  the UI between batches so the map stays responsive; progress is reported
  through `opts.onProgress` into the status line (0–30 % tile pre-load, 30–100 %
  scoring).
- **Grid caps keep phones alive**: `gridCellM()` grows the cell size until the
  circle holds at most `FIELD.MAX_CELLS` (9000) cells, so a 10 km run costs the
  same as a 3 km run.
- Bubble **popups are built lazily** (`bindPopup(fn)`) and the circles are plain
  `L.circle`s in one layer group, so even the 1400-bubble cap stays cheap;
  `selectBubbles` itself is O(cells × tiers) with grid-indexed conflict checks.
- The heat surface is a **tiny raster** (≤ ~115 × 115 px) drawn with a single
  `drawImage` per settled view — no per-cell DOM, no per-zoom recomputation of
  the scores.
- The UAT mask merges excluded cells into **row-run rectangles** instead of one
  rectangle per cell (a few hundred shapes instead of a few thousand).
- A Web Worker is intentionally not used: the only slow part (tile fetching)
  is already asynchronous and cached, and geometry is O(n log n)-ish over a
  few hundred points.

---

## Debugging

```js
_archeoPotentialResults()          // scored cells of the last run (field mode)
_archeoPotentialBubbles()          // the sparse bubble selection actually drawn
_archeoPotentialHeat()             // the heat canvas layer (canvas, _lastFrame, anchor)
_archeoPotentialHeatRaster()       // heat raster: rgba, values, valid, window, bbox
_archeoPotentialField()            // full field: grid, results, bubbles, excluded, heat, stats
_archeoPotentialState()            // { pinMode, pin, radiusKm, radiusM, mode, resultsVisible, running }
setArcheoPotentialMode('heat')     // 'bubbles' | 'heat'
setArcheoPotentialPinMode(true)    // arm the purple pin (map clicks place it)
_archeoPotSetPoint(46.77, 23.59)   // drop the pin from the console
setArcheoPotentialRadiusKm(4)      // move the radius slider (1–10)
computeArcheoPotentialField(lat, lng, radiusM, { mode: 'heat' })  // field without rendering
_archeoPotentialDebug.config       // live config object (incl. CONFIG.UAT / FIELD / BUBBLE / HEAT)
_archeoPotentialResetCache()       // force the global site index rebuild + reset the UAT tile cache
_archeoPotentialDebug.prewarmUatTiles(bounds)      // { total, ok, missing, unreadable, timeout }
_archeoPotentialDebug.uatCellRedFraction(lat,lng,m)// { red, samples, known } for one cell
_archeoPotentialDebug.syncLegend()                 // repaint swatches / bands / heat bar
_archeoPotentialDebug.LEGEND_SCORES                // the score each legend row stands for
```

The console logs one summary line per run, e.g.:
`[ArcheoPotential] bubbles · 41 sites, 2230 cells (375 m), 2162 scored, 0 UAT-excluded, 68 heritage-excluded (64 high, 128 medium, 1970 low) — 340 ms`.
