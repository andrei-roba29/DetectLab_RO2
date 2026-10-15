# Roman roads — why the layer stalled at 4 % and crashed, and what replaced it

**Status: 2026-10-15.** Reported: the **Roman roads** layer (Roman Empire group)
loads extremely slowly, in the **installed PWA** the byte readout appears stuck
at **4 %** for a long time (it does finish, eventually), and the page **crashes**
— on desktop web *and* in the PWA.

This document explains the cause, the replacement pipeline
(`js/roman-roads-parser.js` + `js/roman-roads-worker.js` + `js/roman-roads.js`),
the knobs, and how to reproduce the measurements.

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
  (`DetectLabRomanRoads.load` → `mainThread`). Nothing of the ingest is left on
  the path that pumps the network.
* **Binary geometry.** Per batch it hands over typed arrays, not objects:

  | array | contents | cost |
  |---|---|---|
  | `origins` `Float64Array(2n)` | Mercator metres of vertex 0 of each segment | 16 B/segment |
  | `deltas` `Float32Array(2v)` | per-vertex offset from that origin (sub-mm at any zoom) | 8 B/vertex |
  | `starts` `Uint32Array(n+1)` | prefix sum → vertex range of segment *i* | 4 B/segment |
  | `bounds` `Float32Array(4n)` | bbox per segment, for culling | 16 B/segment |
  | `cellKeys` / `cellStart` / `cellItems` | CSR spatial grid at z11 | ≈8 B/segment |
  | `spanItems` | the few segments longer than one grid cell | — |

  A segment therefore costs ≈36–40 bytes + 8 bytes per vertex, against roughly
  250+ bytes per vertex for the Leaflet objects it replaces.
* **Simplification once, not per frame.** Dedup (`minVertexDistMeters`, 0.6 m),
  then an iterative Ramer–Douglas–Peucker (`rdpMask`, 0.35 m — a raise is
  automatic if a single feature is still monstrous). The canvas never runs
  trigonometry: one multiply-add per vertex per frame.
* **Budgets, not hope.** `configForDevice()` allows a phone 40 MB / 350 000
  segments / 3 M vertices and a desktop 96 MB / 900 000 / 9 M. When the
  allowance is spent the collector *samples* — uniform 1:N stride derived from
  `seen / (bytes read / bytes total)`, i.e. a representative sample of the whole
  file rather than "the first N km of it", with long roads always kept and a
  hard stop at 2 × the caps. The status line says `sampled 1:N`.

### 2.2 `js/roman-roads-worker.js` — streaming with backpressure

`fetch` → `body.getReader()` → line splitter → the parser above. At most **4**
payloads may be un-acknowledged; the page `ack`s each batch after appending it,
so a fast socket can never queue geometry in front of a busy main thread. It
posts `progress` (bytes / total / segments / vertices / elapsed, at most every
250 ms), `batch`, `done`, `error`. `cancel` (layer switched off) stops the
socket immediately. If the worker cannot start at all (CSP, blocked blob) the
page falls back to the identical pipeline on the main thread — but only *before*
a batch has been delivered, so geometry can never arrive twice.

### 2.3 `js/roman-roads.js` — a canvas `GridLayer`

* One canvas per **visible** tile (`createTile` is a 1-argument function, so
  Leaflet marks the tile ready itself): nothing is drawn for the parts of the
  network the user is not looking at.
* Per tile it walks only the grid cells overlapping the tile (above z9 a tile is
  smaller than a z11 cell, so a handful of segments are in play instead of
  hundreds of thousands), tests each segment's bbox, and draws the survivors
  into **one path**, closed by **one `stroke()`**. Sub-pixel segments are a
  `fillRect` dot instead of a path — at continental zoom the old layer was a
  cloud of invisible specks anyway.
* Painting is time-sliced (`frameMsBudget: 6` ms per animation frame) and the
  per-tile item budget **self-tunes** (`maxItemsPerTile` 16 000 down to 1 500):
  `_adaptBudget()` shrinks it when a tile takes longer than `tileMsBudget`
  (26 ms) and grows it when tiles are cheap, so the layer settles on what the
  device can actually do.
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
  `?v=20261015-roman-roads`) load **before** `js/map-app.js`.
* `js/map-app.js`: `_loadRomanRoads()` now creates the canvas layer once
  (`_roadsLayer()`), adds it to the Roman group, and passes
  `DetectLabRomanRoads.configForDevice()`. The status line reports segments,
  `MB / MB`, percentage, `sampled 1:N` and elapsed seconds — it can no longer
  park on a bare percentage.
* `sw.js`: the three modules are precached; the **NDJSON itself** gets its own
  cache (`detectlab-roman-roads-v1`) served cache-first with a background
  refresh, so a second visit — and the installed PWA — paints from disk instead
  of re-downloading tens of MB. The shell cache is `detectlab-v210-roman-roads`.

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

The tile numbers are the ones that matter for the reported symptom: the cost of
a tile is bounded by the budget, not by the size of the network, so the same
layer that used to freeze the page paints a screenful in a few milliseconds —
and the parse that used to block the socket no longer runs on the page at all.

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
node test-roman-roads-pipeline.js     # parser batching + grid + worker protocol + canvas maths
node test-roman-reference-layer.js    # the Roman controls, DARE/Pleiades, and how roads are loaded
node bench-roman-roads.js             # the numbers above (jsdom optional)
```

`test-roman-roads-pipeline.js` is the regression net for the two bugs that made
the first version of this pipeline useless: a `flush()` that forgot to reset its
cursors re-emitted the whole file on every batch (the layer grew quadratically —
"loads slowly and then crashes"), and an off-by-one in the CSR build resolved
every tile lookup to an empty range (the layer painted nothing above z9).

---

## 6. Notes / caveats

* The percentages in the PWA now come from *bytes read* **and** segments kept,
  so a slow socket is distinguishable from a busy page.
* Caching the NDJSON in `sw.js` is cache-first with a background refresh: the
  first visit of a session still pays the download, later ones do not.
* Geometry that was sampled out (over budget) is reported in the console line
  `[Roman] roads ready: … (N segment(s) sampled out to fit the memory budget)`.
* If a future dataset stores one *point per record* the parser keeps it as a
  2-point segment (dot), which is the only sane reading of such an export.
