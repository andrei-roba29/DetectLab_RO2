# Roman roads — why the layer stalled at 4 % and crashed, and what replaced it

**Status: 2026-10-15.** Reported: the **Roman roads** layer (Roman Empire group)
loads extremely slowly, in the **installed PWA** the byte readout appears stuck
at **4 %** for a long time (it does finish, eventually), and the page **crashes**
— on desktop web *and* in the PWA.

This document explains the cause, the replacement pipeline
(`js/roman-roads-parser.js` + `js/roman-roads-worker.js` + `js/roman-roads.js`),
the knobs, and how to reproduce the measurements.

### 2026-11-04: missing segments near Aiton

The current Supabase source includes the 71-vertex Itiner-e segment **23379,
Potaissa–Napoca**, which passes through Aiton (marked *Conjectured*). The
missing line was not absent from the source. Two independent errors could hide
it:

1. When one network chunk or a `response.text()` fallback contained more than
   two transfer batches, the collector compacted its current batch purely because
   of its size, even though the dataset was within the memory budget. This could
   discard thousands of valid roads; the compaction also did not move the grid
   indices along with the retained geometry. The worker and fallback now flush
   **between records** and the collector no longer performs batch-size-driven
   compaction. Backpressure still limits unacknowledged worker batches to four.
2. At low zoom the renderer sampled against the size of the **whole** network
   before checking which roads intersected each tile. Aiton could disappear from
   a tile containing only 58 distinct segment entries in the older snapshot,
   under a 1,500-item budget. Rendering now counts candidates after spatial/bbox
   culling and samples only if that tile actually exceeds its budget. Long roads
   appear in both the centre-cell index and a span list; the layer now counts
   them once, while still finding their ends in distant tiles.

Deduplication also used to discard valid sub-0.6 m roads: the original last
valid point is now preserved. An older public Itiner-e snapshot was used for a
full-file regression: all **16,554** of its records were retained for both a
single-chunk and a 64 KiB-chunk ingest under phone and desktop limits, and none
were memory-sampled. That snapshot is not identical to the current Supabase
object. The current source was separately checked for segment 23379; no road
geometry or certainty has been invented or changed.

The screen can still be sampled when a *particular* tile truly exceeds the
adaptive drawing budget. The collector can still sample when a source exceeds
its memory allowance, and the 3D mirror retains its separate 25,000-feature cap.
The status line reports real ingest omissions and invalid/unsupported paths.

---

## 1. Cause: one SVG `<path>` per road segment, on the main thread

The layer streams `route-segments-all-…ndjson` (Supabase storage) and, in the
version that crashed, did this for **every** line that arrived:

1. `JSON.parse` on the main thread, inside the same task that pumps the socket;
2. normalise the record (GeoJSON / WKT / `paths` / bare coordinates) and thin it;
3. `L.polyline(...)` per segment, appended to a `L.featureGroup` in
   `requestAnimationFrame` batches.

The map has no `preferCanvas` and the old style objects carried no `renderer`,
so Leaflet rendered each of those polylines with the **SVG renderer**: every
segment became a live `Path` object (a `LatLng` per vertex, `_parts`, `_rings`,
bounds) **and** a `<path>` element in the DOM.

The real network has five to six figures of segments (the 3D view already had to
bundle ~20 000 of them — see `MAP_3D_TERRAIN.md` §6). Measured on a synthetic
stream with the real Leaflet renderer (`bench-roman-roads.js`):

| dataset | legacy pipeline |
|---|---|
| 20 000 segments × 12 vtx | 20 000 `LatLng` **path arrays**, 240 000 `LatLng` objects, **20 000 `<path>`** elements, ≈1.0 s to build |
| 120 000 segments × 14 vtx | 1 680 000 `LatLng` objects, ≈88 MB heap, **120 000 `<path>`** elements, ≈4.9 s to build |

Three things then compound:

* **the tab dies.** Tens of thousands of SVG nodes plus their Leaflet objects
  are what makes the renderer terminate the page on a phone, and what makes a
  desktop tab freeze while it re-clips every path on zoom;
* **the stream crawls.** `reader.read()` only gets a turn when the current task
  yields, and that task is busy parsing JSON and building SVG-backed vectors, so
  the download progress (`'Roads: … lines read… 4%'`) sits at a few percent for
  minutes. The 4 % was **not** a network problem — it was the page refusing to
  come back to the socket;
* **the PWA is worst.** An installed PWA on a phone has the smallest memory
  budget, so the same layer that merely stutters on a desktop is killed there.

---

## 2. The replacement pipeline

Three files, one direction of data flow:

```
js/roman-roads-worker.js      fetch + NDJSON streaming + backpressure   (worker)
        ↓ importScripts
js/roman-roads-parser.js      record → simplified Web-Mercator typed arrays
        ↓ transferable batches (zero-copy postMessage)
js/roman-roads.js             L.GridLayer that paints canvas tiles, viewport only
```

### 2.1 `js/roman-roads-parser.js` — the only place that understands a record

* **Off-thread.** It runs in the worker (`importScripts`) or, when a Worker is
  unavailable, in the page through the same entry point
  (`DetectLabRomanRoads.load` → `mainThread`). The fallback yields while parsing
  large chunks or complete text responses so the page can remain responsive.
* **Binary geometry.** Per batch it hands over typed arrays, not objects:

  | array | contents | cost |
  |---|---|---|
  | `origins` `Float64Array(2n)` | Mercator metres of vertex 0 of each segment | 16 B/segment |
  | `deltas` `Float32Array(2v)` | per-vertex offset from that origin (sub-mm at any zoom) | 8 B/vertex |
  | `starts` `Uint32Array(n+1)` | prefix sum → vertex range of segment *i* | 4 B/segment |
  | `bounds` `Float32Array(4n)` | bbox per segment, for culling | 16 B/segment |
  | `cellKeys` / `cellStart` / `cellItems` | CSR spatial grid at z11 | ≈8 B/segment |
  | `spanItems` | segments longer than one grid cell (also in `cellItems`) | 4 B/span |

  A segment therefore costs ≈36–40 bytes + 8 bytes per vertex, against roughly
  250+ bytes per vertex for the Leaflet objects it replaces.
* **Simplification once, not per frame.** Dedup (`minVertexDistMeters`, 0.6 m),
  then an iterative Ramer–Douglas–Peucker (`rdpMask`, 0.35 m — a raise is
  automatic if a single feature is still monstrous). The canvas never runs
  trigonometry: one multiply-add per vertex per frame.
* **Budgets, not hope.** `configForDevice()` allows a phone 40 MB / 350 000
  segments / 3 M vertices and a desktop 96 MB / 900 000 / 9 M. If the projected
  source size exceeds an allowance, the collector *samples* using a 1:N stride
  derived from `seen / (bytes read / bytes total)`, rather than simply retaining
  the first N km. Long roads are prioritised, but a hard ceiling applies to all
  roads: 2 × the vertex/estimated-byte caps, and 2 × the segment cap plus one
  batch of headroom. The last accepted path can cross a vertex/byte ceiling.
  Actual omissions are counted in the progress and final status.

### 2.2 `js/roman-roads-worker.js` — streaming with backpressure

`fetch` → `body.getReader()` → line splitter → the parser above. At most **4**
payloads may be un-acknowledged; the page `ack`s each batch after appending it,
including while processing one large chunk or a complete text response. It
posts `progress` (bytes / total / segments / vertices / elapsed, at most every
250 ms), `batch`, `done`, `error`. Calling `cancel()` stops the stream. If the
worker cannot start (e.g. CSP) the page falls back to the same parser on the
main thread — but only *before* a batch has been delivered, so geometry cannot
arrive twice. The fallback processes up to 250 records or roughly 6 ms at a time.

### 2.3 `js/roman-roads.js` — a canvas `GridLayer`

* One canvas per **visible** tile (`createTile` is a 1-argument function, so
  Leaflet marks the tile ready itself): nothing is drawn for the parts of the
  network the user is not looking at.
* Per tile it walks only the grid cells overlapping the tile (above z9 a tile is
  smaller than a z11 cell, so a handful of segments are in play instead of
  hundreds of thousands), tests each segment's bbox, and draws the survivors
  into **one path**, closed by **one `stroke()`**. Segments present in both
  the span and cell indices are visited only once. Sub-pixel segments are a
  `fillRect` dot instead of a path — at continental zoom the old layer was a
  cloud of invisible specks anyway.
* Painting is time-sliced (`frameMsBudget: 6` ms per animation frame) and the
  per-tile item budget **self-tunes** (`maxItemsPerTile` 16 000 down to 1 500):
  `_adaptBudget()` shrinks it when a tile takes longer than `tileMsBudget`
  (26 ms) and grows it when tiles are cheap. It first counts the candidates
  intersecting that tile and then spreads the drawing budget across them; no
  sampling occurs when the tile fits. A dense tile's candidates still have to
  be counted, so the time budget is between tiles rather than a strict bound
  on any single paint.
* The opacity slider is free: `setOpacity()` only sets the container opacity —
  the geometry is not restyled (the old code restyled every path). `setColor()`
  invalidates tiles; a new batch invalidates **only the tiles its extent
  touches**.
* Reused by the rest of the app:
  * `_dl3dFeatures()` → the 2D→3D mirror keeps drawing real vector roads
    (≤25 000 features, the same bundling contract as `MAP_3D_TERRAIN.md` §6);
  * `window._romanRoadsLayer` → `js/archeo-report.js` measures against the
    already-loaded network (`nearestRoadMeters`, `roadSegmentsInBounds`) instead
    of downloading and parsing the 25 MB reference GeoJSON again. The GeoJSON is
    still the fallback when the layer is off.

### 2.4 Wiring

* `index.html`: `js/roman-roads-parser.js` and `js/roman-roads.js` (version
  `?v=20261104-roman-roads-complete`) load **before** `js/map-app.js`.
* `js/map-app.js`: `_loadRomanRoads()` now creates the canvas layer once
  (`_roadsLayer()`), adds it to the Roman group, and passes
  `DetectLabRomanRoads.configForDevice()`. The status line reports segments,
  `MB / MB`, percentage, actual memory omissions and elapsed seconds. The
  final status also reports invalid/unsupported paths. A failed load clears
  its partial geometry so retrying does not duplicate it.
* `sw.js`: the three modules are precached; the **NDJSON itself** gets its own
  cache (`detectlab-roman-roads-v1`) served cache-first, so a second visit —
  and the installed PWA — can paint from disk. Stale copies are fetched again,
  with the cached copy used when offline. The shell cache is
  `detectlab-v401-roman-roads-complete`; older versioned scripts remain in the
  shell cache for compatibility with previously installed pages.

---

## 3. What was measured (`bench-roman-roads.js`)

Synthetic stream in the shapes the export uses, same bytes through both
pipelines; the jsdom part uses the **real** `js/leaflet.js` 1.9.4 and its SVG
renderer (jsdom is optional and is not a dependency of the site):

```
node bench-roman-roads.js 120000 14
npm i jsdom && node bench-roman-roads.js 20000 12      # adds the DOM comparison
```

Reference run (node 22, 2026-10-15):

| | legacy (SVG renderer) | now (canvas tiles) |
|---|---|---|
| 20 000 segments | 20 000 `<path>` + 20 001 SVG nodes, ≈1.0 s to build | 12 canvas elements, 125 ms ingest, last tile 1.8 ms |
| 120 000 segments | 120 000 `<path>`, ≈4.9 s to build | 12 canvases, 804 ms ingest, 16.9 MB transferred |
| tile paint (real layer code) | — | z3 1.7–2.2 ms · z6 0.8–1.0 ms · z9–z15 0.1–1.7 ms per tile, 1 stroke/tile |
| worker parse | — | 264 ms for 20 000 · 1.6 s for 120 000, off the main thread |

These historical timings predate the 2026-11-04 completeness fix. The drawing
work is bounded by the tile budget, while counting and bbox culling depend on
that tile's candidates. The normal worker parses off the page; the no-worker
fallback yields regularly on the main thread. See the tests below for the
current behaviour and rerun the benchmark on the target device for timings.

---

## 4. Live knobs (no redeploy)

`window.DetectLabRomanRoads.DEFAULTS` / the `createLayer({…})` options:

| option | default | effect |
|---|---|---|
| `maxSegments`, `maxVertices`, `maxBytes` | phone 350 k / 3 M / 40 MB, desktop 900 k / 9 M / 96 MB | the memory allowance; beyond it the stream is sampled |
| `maxBatchSegments` | phone 4 000, desktop 6 000 | how much geometry one transferred batch carries |
| `simplifyMeters` | 0.35 | RDP tolerance at ingest |
| `minVertexDistMeters` | 0.6 | vertices closer than this are dropped |
| `gridZoom` | 11 | spatial grid used by the tile lookups |
| `maxItemsPerTile` | 16 000 | upper bound of the adaptive per-tile budget |
| `frameMsBudget` | 6 | milliseconds of painting per animation frame |
| `tileMsBudget` | 26 | a tile slower than this shrinks the item budget |
| `dotMaxZoom` | 7 | at or below this zoom, sub-pixel segments become dots |
| `updateWhenZooming` / `keepBuffer` | `false` / `1` | inherited from the `js/tile-perf.js` governor |

Debugging: `window._romanRoadsLayer.getStats()` → `{pages, segments, vertices,
sampled, stride, paintedTiles, lastPaintMs, cappedTiles, bytes}`.

---

## 5. Tests

```
node test-roman-roads-pipeline.js       # parser batching + grid + worker protocol + canvas maths
node test-roman-roads-completeness.js   # Aiton, chunking, fallback, budgets, errors and cancellation
node test-roman-reference-layer.js      # the Roman controls, DARE/Pleiades, and how roads are loaded
node test-roman-roads-browser.js        # optional Playwright + Chromium: real worker, Leaflet and canvas
node bench-roman-roads.js               # synthetic performance (jsdom optional)
```

The browser test finds Playwright in `node_modules` or `PLAYWRIGHT_MODULE_DIR`.
Set `CHROMIUM_EXECUTABLE_PATH` if needed, and optionally set
`ROMAN_ROADS_TEST_DATA` to a local, under-budget Itiner-e NDJSON snapshot
containing Aiton; the external file is never committed or downloaded by the
test. The included fixture is attributed in `test/fixtures/README.md`.

`test-roman-roads-pipeline.js` is the regression net for the two bugs that made
the first version of this pipeline useless: a `flush()` that forgot to reset its
cursors re-emitted the whole file on every batch (the layer grew quadratically —
"loads slowly and then crashes"), and an off-by-one in the CSR build resolved
every tile lookup to an empty range (the layer painted nothing above z9).

---

## 6. Notes / caveats

* The percentages in the PWA now come from *bytes read* **and** segments kept,
  so a slow socket is distinguishable from a busy page.
* Caching the NDJSON in `sw.js` is cache-first with an age-based refresh: the
  first visit of a session still pays the download, later ones generally do not.
* Geometry sampled out to fit the memory budget is reported in the status and
  in the console line
  `[Roman] roads ready: … (N segment(s) sampled out to fit the memory budget)`.
* If a future dataset stores one *point per record* the parser keeps it as a
  2-point segment (dot), which is the only sane reading of such an export.
