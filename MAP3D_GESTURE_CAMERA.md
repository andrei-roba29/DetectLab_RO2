# 3D view: gesture-only camera, no exaggeration/pitch/bearing sliders (v264)

**Request:** terrain exaggeration, pitch and bearing should be removed from the
desktop website, and the view should rely **only on gestures** to move and
change the 3D camera.

## What the three sliders were

The 3D bar (`#map3d-bar`, built by `ensureBar()` in `js/map3d-terrain.js`) had
four rows: the ArcGIS **basemap picker** plus three `input[type="range"]`
strips — *Terrain exaggeration* (`#map3d-exag`), *Pitch* (`#map3d-pitch`) and
*Bearing* (`#map3d-bearing`). Each strip painted its own value (`1.4×`, `62°`,
`0°`) into a `<b>` label and called `setExaggeration()`,
`map.setPitch()` / `map.setBearing()` on `input`.

| Where | Rule / code | Why it existed |
| --- | --- | --- |
| `js/map3d-terrain.js` → `ensureBar()` | `m3d-exag-row`, `m3d-pitch-row`, `m3d-bearing-row` markup | the three sliders |
| `js/map3d-terrain.js` → `ensureBar()` | `paintLabels()`, `exagToSlider()` / `sliderToExag()`, three `input` listeners | slider wiring |
| `js/map3d-terrain.js` → `resetView()`, `map.on('moveend')`, `setExaggeration()` | `bar.paintLabels()` / `.m3d-exag-val` writes | keep the values in sync while the camera moves |
| `js/map3d-terrain.js` → `refreshBarCopy()` | rows `[1..3]` labels re-translated on `detectlab:langchange` | the three rows' i18n |
| `css/map3d-terrain.css` | `.m3d-row input[type="range"]` skin, `body.is-pwa.is-3d … .m3d-exag-row/.m3d-pitch-row/.m3d-bearing-row { display: none; }`, the `.m3d-row:not(…)-row` collapsed-bar override | styling, and the PWA exception (changing DEM exaggeration could crash the installed PWA) |

## What changed

1. **`js/map3d-terrain.js`**
   * The three slider rows are gone from `ensureBar()`. The bar now holds the
     basemap picker, the LiDAR row and the three action buttons.
   * `paintLabels()`, the two slider↔value helpers and the three `input`
     listeners are deleted, together with every `bar.paintLabels()` call site
     (`resetView()`, `map.on('moveend')`) and the `.m3d-exag-val` write in
     `setExaggeration()`.
   * `refreshBarCopy()` re-translates the one remaining row label.
   * **Gestures are made explicit.** `buildMapOptions()` now asks for
     `dragRotate`, `pitchWithRotate`, `touchPitch`, `touchZoomRotate`,
     `dragPan`, `scrollZoom` and `keyboard`, and `openNow()` enables
     `touchZoomRotate.enableRotation()`, `touchPitch`, `dragRotate`,
     `dragPan`, `scrollZoom` and `keyboard` after the map is created — so a
     safe-mode retry or a device profile cannot leave the camera stuck: with no
     slider left, a disabled handler would be a dead end.
2. **`css/map3d-terrain.css`** — the dead `input[type="range"]` skin and the
   PWA `display: none` rules for the three rows are deleted (they would have
   hidden nothing); the PWA collapsed-bar override simplifies to
   `.m3d-row` / `.m3d-actions`, and the header comment describes the new set.
3. **Kept on purpose** — the *collapse* button, *Reset* (`resetView`), *↑ N*
   (`setBearing(0)`) and *2D ⤓* (`easeTo({ pitch: 0, bearing: 0 })`)
   shortcuts, and the public `setExaggeration()` / `setPitch()` / `setBearing()`
   API (diagnostics, `window.DetectLabMap3D`, automation). No UI reaches them
   any more.
4. **Terrain exaggeration is now a constant** — `CONFIG.terrain.exaggeration`
   (default `1.4`, overridable via `window.DETECTLAB_MAP3D.terrain.exaggeration`)
   is applied once by `buildStyle()` (`style.terrain.exaggeration`) and by
   `applyExaggeration()`. Nothing changes it at runtime, so the “slider drag
   allocates a render target per pixel” hazard noted in §TERRAIN EXAGGERATION
   is structurally gone.
5. **`index.html` / `sw.js`** — cache busting: the viewer and skin move to
   `?v=20261024-gesture-only-camera` (the old tags stay in the SW pre-cache
   list) and `CACHE_NAME` becomes `detectlab-v264-gesture-only-3d-camera`.
6. **Docs** — `MAP_3D_TERRAIN.md` §Controls / §Layout / §Known limitations and
   `MAP3D_NO_TERRAIN_TOGGLE.md` describe the new set; this file records why.

## The gestures that replace them

| Intent | Mouse (desktop web) | Touch | Keyboard |
| --- | --- | --- | --- |
| Pan | drag with the left button | one-finger drag | arrows |
| Zoom | wheel / trackpad pinch | pinch | `+` / `-` |
| Pitch + rotate (bearing) | right-button drag, or Ctrl/⌘ + drag | two-finger drag (pitch) and twist (rotate) | `Shift` + arrows |
| Back to north / flat | the **↑ N** and **2D ⤓** buttons, or **Reset** | same buttons | — |

MapLibre maps a right-drag onto its `dragRotate` handler: horizontal movement
changes the bearing, vertical movement changes the pitch (`pitchWithRotate`),
clamped to `CONFIG.camera.maxPitch` (80°). This is also why Leaflet's own
rotation control is irrelevant in 3D — 3D reads Leaflet's bearing when it
opens and writes it back on close, but the camera itself is MapLibre's.

## What deliberately did **not** change

* The **2D map** and its controls — nothing here touches Leaflet.
* The **basemap picker**, the LiDAR focus row and the refresh button.
* The **DEM itself**: `style.terrain` still drapes every layer; a DEM that
  cannot load still warns once and runs the view flat.
* The installed **PWA** layout: it already hid those rows, so nothing moved
  there except that the CSS hiding them is gone.

## How to verify

```bash
node test-map3d-slider-layout.js   # bar geometry, no sliders (node assertions),
                                   # gesture handlers + PWA rows/cache wiring
node test-map3d-terrain.js         # 3D wiring, style, proxy, mirror, fixed exaggeration
node test-map3d-mobile.js          # phone/PWA budget and cache wiring
node test-lidar-3d-focus.js        # the LiDAR entry gate still installs
node test-map-control-spacing.js   # controls and cache-tag wiring
```

Manually, on a desktop-width window: press **3D** — the bar shows only the
basemap picker, the LiDAR row (when relevant) and *Reset / ↑ N / 2D ⤓*. Drag
with the right mouse button (or Ctrl+drag) to tilt and rotate; the terrain
keeps its 1.4× relief and no control can change it.
