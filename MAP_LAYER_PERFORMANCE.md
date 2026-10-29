# Multi-layer map performance — the crash on a sudden zoom

**Status: 2026-09-18.** Reported: with several *dense* raster layers open at the
same time — the LIDAR sub-layers (HD, AR, AB, BH, CS, „Romania 2–5 m/pixel",
„Romania 1 m/pixel agregare", the four LAKI III sheets) and **„Imagini
satelitare anii 60'"** (CORONA) together with the historical maps, the APM
2.0 stack and the basemap — a **sudden gesture** (an abrupt zoom-in, a fast
pinch, a violent drag) made the page **crash and reload itself**.

This document explains the cause, the fix (`js/tile-perf.js` + the wiring in
`js/map-app.js`), and the live knobs you can use without a redeploy.

---

## 1. Cause: the number of live tiles, not a leak

A decoded 256×256 RGBA tile costs ≈ **0.25 MB** (262 144 bytes) in the renderer.
Leaflet's defaults are tuned for **one** tile layer; this app can put **10–25**
of them in the same viewport:

| Leaflet default | Effect with a stack of dense layers |
|---|---|
| `updateWhenZooming: true` | every animation frame of a pinch/scroll zoom re-runs `_update()` for **every** layer and queues tiles |
| `updateWhenIdle: L.Browser.mobile` | `false` whenever the UA is spoofed („Desktop site" mode, some PWAs), so every **pan** frame does the same |
| `keepBuffer: 2` | a 2-tile ring of off-screen tiles kept alive **per layer** |
| `_pruneTiles()` keeps **5 ancestor + 2 descendant** zoom levels | while the zoom changes, levels nobody sees stay decoded |
| `fadeAnimation: true` | `_tileReady()` re-scans **all** tiles of the layer on every animation frame to fade them in |

During one fast zoom of a phone-sized viewport (390×780 → ~15 visible tiles per
layer) an activated stack of ~15 heavy layers therefore reaches **hundreds of
in-flight requests and thousands of decoded tiles within a second**. WebKit /
Chromium terminate the tab (out of memory) and the page „refreshes" itself.

The 60's layer alone was already fixed this way (`SATELLITE_60s_FIX.md` §6);
the same class of limits is now applied to **every** tile layer, so the crash
does not come back as soon as another dense layer (LIDAR, historical map, APM)
is part of the mix.

---

## 2. The fix

### 2.1 `js/tile-perf.js` — one governor for every tile layer

Loaded **right after `js/leaflet.js`** and **before `js/map-app.js`**, so it
patches the defaults before any layer exists:

1. **Gesture-safe defaults** (prototype options, so `L.tileLayer(...)`,
   `L.tileLayer.wms(...)` and every custom `GridLayer` inherit them; an explicit
   per-layer option always wins):
   `updateWhenZooming: false`, `updateWhenIdle: true` on low-power devices,
   `keepBuffer: 1` (phone) / `2` (desktop), `updateInterval: 200–250 ms`.
2. **One tile update per layer per gesture.** `_update()` called while a zoom is
   animating, or within a short settle window (`quietMs`: 50 ms desktop /
   80 ms phone) after the last gesture, is merged: the layers are queued and
   updated **once**, at the final zoom. The quiet window is short so the new
   zoom starts fetching almost immediately, while still coalescing a rapid wheel
   burst. Two rules keep that from ever costing a frame: a pan (which is not a
   zoom) flushes the queue immediately, and a layer with **no tiles on screen**
   — the first paint after switching it on, or any `viewprereset` wipe
   (`setView(..., {animate:false})`, `redraw()`) — is also updated immediately.
   Deferral is only ever applied while there is an older level to keep visible,
   so the governor can never leave an empty tile pane. No `setView`/`zoomend`
   ordering assumptions are made: the governor listens to
   `zoomstart / zoomend / movestart / moveend / move / zoom` and self-heals if a
   `zoomend` never arrives.
3. **Stricter pruning + covering-tile handoff.** Pruning keeps **2–3 ancestor**
   levels (instead of 5) and **1–2 descendant** levels. Loaded tiles from the
   previous zoom stay on screen until the incoming ones are `active`, so zoom
   in/out does not flash the map background (the `#ddd` / white buffer). A hard
   ceiling (`maxRetainedTiles`: 24 phone / 64 desktop) still caps extras once
   the new zoom is painted — and always in conservation mode. Nothing is pruned
   while a zoom animation is on screen: the old levels are released right after
   the deferred update instead.
4. **A page watchdog** (every 5 s, never mid-gesture) estimates the decoded-tile
   memory of the whole page. Above the device budget (≈80 MB phone / ≈350 MB
   desktop) the page switches to **conservation mode**: the off-screen rings of
   all layers are dropped, the retained levels are cut to 1/0, and a one-time
   translated notice suggests closing the layers that are not needed. Below 60 %
   of the budget it goes back to normal limits.
5. **A CSS-only tile fade for the zoom handoff.** Leaflet's own `fadeAnimation`
   fades every loaded tile in through `_updateOpacity()` — a
   `requestAnimationFrame` loop that rewrites the opacity of **all** tiles of
   the layer for ~200 ms after *each* load, the exact kind of per-frame work
   this governor exists to remove (which is why phones used to get no fade at
   all and the new zoom simply popped in). The governor now switches Leaflet's
   fade machinery off on the governed map and fades every incoming tile with a
   CSS `opacity` transition instead (§4b of `js/tile-perf.js`): the same
   smooth cross-fade on every device class, with zero per-frame JS. A tile
   becomes `active` — the flag item 3's covering-tile handoff waits on — only
   once its fade has finished, so the previous zoom level stays on screen for
   the whole cross-fade and zoom in/out reads as one image morphing into the
   next.

### 2.2 `js/map-app.js`

- The map calls `window.DLTilePerf.attach(map)` right after it is created.
- **LIDAR**: `_buildLidarLeafletLayer()` builds every sub-layer (xyz, WMS and
  WMTS-KVP branches alike) through a shared `_lidarPerfOptions()` helper, so the
  LIDAR stack explicitly carries `updateWhenZooming: false`,
  `updateWhenIdle: true` and the adaptive `keepBuffer`.
- **Sat60 / CORONA** keeps its own explicit options (the same values, verified
  by `test-sat60-mobile-crash.js`) and now takes its device class from
  `DLTilePerf.isLowPowerDevice()` so a single detector rules both, with the old
  local detection kept as fallback.

### 2.3 Other files

| File | Change |
|---|---|
| `js/translations.js` | `perf_layers_notice` (en + ro) for the conservation-mode notice |
| `index.html` | `<script src="js/tile-perf.js?v=20260917-tile-fluid">` after Leaflet; `map-app.js` / `styles.css` re-versioned |
| `sw.js` | the new file + the re-versioned URLs added to `PRECACHE_URLS`, and `CACHE_NAME` bumped to `detectlab-v105-tile-fluid` so installed PWAs drop the old shell and pick the governor up |
| `css/styles.css` | `#detectlab-map` background `#060E1E` (hides Leaflet's `#ddd` through empty tiles); the 1 px tile overlap pinned to `mix-blend-mode: normal` — the white-grid fix (see §2.4) |
| `test-tile-perf.js` | new regression test (see §5) |
| `bench-tile-perf.js` | optional benchmark, needs `jsdom` (see §5) — not loaded by the site |

### 2.4 `css/styles.css` — the white grid between tiles

Reported as „se vede gridul alb al hărții": a white line every 256 px, in
both directions, on top of the basemap. Two rules cooperate on the seams:

1. every tile overlaps its right and bottom neighbour by 1 px
   (`width/height: 257px !important`), so no sub-pixel hairline can open
   between tiles — at rest, during the zoom-animation scaling, or at a
   fractional zoom;
2. the tiles' blend mode is pinned to `normal`. Leaflet ships
   `.leaflet-container img.leaflet-tile { mix-blend-mode: plus-lighter }`
   (a workaround for Chromium bug 600120), which **adds** the colours of
   whatever is underneath a tile instead of covering it. With the 1 px
   overlap, the pixels of two neighbouring tiles were added together on
   every seam and saturated to white — the grid. With `normal` blending the
   overlapping pixel is simply covered by the neighbour.

Canvas tiles (the UAT buildings layer) get the same pin, and `.leaflet-tile`
keeps `image-rendering: auto` so tiles stay smoothly resampled while the
zoom animation scales them — Leaflet's Safari rule would otherwise force
`-webkit-optimize-contrast` and render the scaling blocky.

---

## 3. What is deliberately NOT changed

The governor only decides **when** and **how many** tiles stay alive:

- tile URLs, WMS-C parameter order (the byte-identical CORONA request), layer
  names, zoom gates, footprints, opacities, panes and z-index are untouched;
- no layer is ever turned off automatically — conservation mode drops only the
  tiles nobody is looking at, and the notice asks the user what to close;
- `zoomAnimation` stays on: the Patrimoniu canvases need the `zoomanim`
  transform (see the comment in the `L.map(...)` options), and with
  `updateWhenZooming: false` the zoom frames are pure CSS transforms anyway.

---

## 4. Live knobs (no redeploy)

```js
// Tune the governor before/while debugging (partial object is fine):
window.DLTILE_PERF = { quietMs: 300, maxLiveTiles: 250, keepBuffer: 0 };

// Force the phone profile / escape hatch for a single layer:
window.DLTILE_LOW_POWER = true;              // or window.SAT60_LOW_POWER_TILES
L.tileLayer(url, { dltilePerf: false });     // this layer opts out entirely

// Inspect and act at runtime:
window.DLTilePerf.stats();          // { tiles, layers, mb, budget, lowPower, conservation }
window.DLTilePerf.sweep();          // release the off-screen tiles of every layer now
window.DLTilePerf.inConservationMode();
window.DLTilePerf.onConservation = function (s) { /* your own UI */ };
```

---

## 5. Tests

```bash
node test-tile-perf.js            # governor: defaults, one update per gesture,
                                  # pruning levels, tile ceiling, conservation mode
node test-sat60-mobile-crash.js   # the CORONA fix still intact (47 checks)

# optional, needs jsdom (npm i jsdom) — real Leaflet + real governor, tile counts:
node bench-tile-perf.js
```

`test-tile-perf.js` runs the real `js/tile-perf.js` against a minimal fake
Leaflet in a VM, so it verifies behaviour (update counts, retained levels, the
tile ceiling, the notice) instead of only grepping the source, plus the wiring:
script order in `index.html`, the PWA precache, the LIDAR helper and the
Sat60/governor detector handshake. It also pins the two rules that keep the map
from ever looking empty: a first paint is never delayed, and a layer whose tiles
were wiped repaints during the gesture instead of waiting for the settle window.

`bench-tile-perf.js` loads the real `js/leaflet.js` (1.9.4) in jsdom and replays
both gesture paths with 12 dense layers on a 390×780 viewport:

| Path (12 layers) | Without governor | With governor |
|---|---|---|
| pinch — `_moveStart` + `_move{pinch}` ×20 + `_animateZoom` | 720 tiles requested, 180 live | **96 tiles (−87 %)**, 96 live |
| wipe — `setZoom(z, {animate:false})` ×4 | 432 tiles, no empty frame | 432 tiles, no empty frame |

The pinch row is the reported crash: without the governor every frame of the
gesture queues a viewport of tiles for every layer, and the levels nobody looks
at stay decoded. The wipe row is unchanged on purpose — there is nothing left on
screen to protect there, so the repaint must go through at once.

---

## 6. Map gestures drop the glass — the Android zoom glitch (2026-10-29)

Reported separately from the tile-crash fix: on Android, zooming in/out with
very heavy layers on ("Satellite imagery 1960's" / CORONA + the historical
stacks) glitched the whole screen, and sometimes the frontend came back
haywire — the layer panel fully transparent, no rows inside, buttons gone.

**Cause — the same per-frame cost the LiDAR distance drag already removes,
but for every map gesture.** Every `backdrop-filter` surface (the panel,
search bar, legend, dock, tooltips — ~30 rules) snapshots and re-blurs
whatever is behind it on every *composited* frame. A pinch/wheel zoom
animates the whole map — with those layers on, hundreds of heavy tiles in
N separately composited panes (each Sat60 frame layer sits at
`opacity: 0.85`, so each is its own layer) — under all of that glass at
once. On the phone GPU that re-blur is the spike behind the glitching
screen; when the compositor runs out of room the same glass surfaces are
the ones that stop painting, which is what "the panel turns transparent"
looks like while every row and button is still in the DOM.

**The fix — `body.map-gesturing`, owned by the governor (§7a):**

- `js/tile-perf.js` adds the class from the shared `activity()` hook, so
  `zoomstart / movestart / zoomanim / move / zoom / zoomend / moveend`
  all arm it (a Leaflet pinch fires that whole chain). It is lifted after
  a self-healing timer: quiet window + the CSS tile fade + a margin —
  the settle-window tile pop-in happens defrosted too, and a cut event
  chain (the historical ReferenceError between `zoomend` and `moveend`)
  cannot leave the class stuck.
- `css/styles.css` drops **every** `backdrop-filter` (universal rule, so
  the hard-coded `blur()` rules are covered as well as the `--ctl-blur`
  ones) and raises the panel's two alpha stops to 0.92 / 0.94 for the
  duration — same trade the distance drag makes: the window stays
  readable without the blur, and nothing flashes back mid-gesture. The
  zoom transitions themselves are left alone; only the backdrop work is
  dropped.
- Scope: **low-power devices by default** (`gestureGlassOff:
  LOW_POWER` in `DEFAULT_CFG`), because that is where the GPU spike
  bites. Live knobs: `window.DLTILE_PERF = { gestureGlassOff: true|false }`
  (any new knob must be declared in `DEFAULT_CFG` — the merge only
  honours known keys).

**The empty-panel half of the report** was a separate DOM path, fixed in
`js/map-app.js`: `checkLayerVisibility` now validates the viewport
(`viewportBoundsUsable`: finite edges + a real `intersects()` method)
and skips the pass when it is unusable — a NaN viewport from a collapsed
pinch used to make `intersects()` false for *every* layer, so one
completed pass hid all the rows and the sticky `viewport-filter-active`
tag kept them hidden (fail-open now: previous visibility stands, the
filter is never activated on bad bounds).

**Tests**: `test-tile-perf.js` §12 (class rides/leaves the gesture, the
cut chain self-heals, desktop stays frosted, the knob forces it, the CSS
rules exist) and `test-layer-visibility.js` "a degenerate viewport fails
open… / bounds without a real intersects() method fail open too / the
validator is wired in". Shell bumped to `detectlab-v295-android-zoom-glass`.

---

## 7. Notes / caveats

- **Visual effect on a phone**: on an *animated* gesture (pinch, wheel, double
  tap) the previous level stays on screen and is CSS-scaled. The new zoom starts
  loading ~50–80 ms after the gesture ends (was ~160–260 ms), and covering tiles
  stay until the incoming ones are `active`. The swap itself is a **cross-fade
  on every device** (§2.1.5): the incoming tiles fade in over the previous
  level through a CSS transition — no per-frame JS, no hard pop. That is the
  trade-off that removes the burst that killed the tab without the white-tile
  buffer. Non-animated zooms (`setView(..., {animate:false})`, `redraw()`,
  `viewprereset`) are **not** delayed at all: there the old tiles are already
  gone, so the layer repaints immediately.
- **`keepBuffer: 1` on phones** keeps a one-tile ring so pan/zoom edges stay
  covered; conservation mode still drops it to 0 under memory pressure. Desktop
  keeps Leaflet's 2-tile ring.
- **If a device still reports memory pressure** (`window.DLTilePerf.stats().mb`
  near the budget), the honest fix is fewer simultaneous dense layers: LiDAR
  HD/AR/AB/BH/CS, „Romania 1 m" and the LAKI III sheets overlap, so two or three
  of them are usually enough for one area.
- The retired `js/Leaflet.VectorGrid.js` is not loaded by `index.html`; it now
  inherits the same defaults through the prototype, but the UAT layer is a plain
  `L.geoJSON` and is unaffected.
