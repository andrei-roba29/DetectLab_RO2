# 3D view: the “Disable terrain” button is gone (v213)

**Request:** in the web desktop version, remove the *disable terrain* button.

## What the button was

The 3D surface at `#map3d-surface` carried MapLibre's own **`TerrainControl`**
(`new maplibre.TerrainControl({ source: 'detectlab-dem', … })`, added to the
`top-right` corner in `js/map3d-terrain.js` → `openNow()`). It renders one
square button whose tooltip reads **“Disable terrain”** while the DEM is
applied and “Enable terrain” when it is not — i.e. the only thing it can do is
switch the 3D view off its elevation model.

It was the **only MapLibre widget in the top-right corner**, and the only
reason the skin and the tests dealt with that corner at all:

| Where | Rule | Why it existed |
| --- | --- | --- |
| `css/map3d-terrain.css` | `#map3d-surface .maplibregl-ctrl-top-right { top: calc(60px + env(safe-area-inset-top, 0px)); }` | keep the button below the app's own “?” help button (top:14px / 36px) and the fullscreen ✕ |
| `css/map3d-terrain.css` | `@media (max-width: 720px) … { #map3d-surface .maplibregl-ctrl-top-right { display: none; } }` | phones never showed it |
| `css/map3d-terrain.css` | `#map3d-surface .maplibregl-ctrl-group { … }` + `button + button` + `.maplibregl-ctrl-icon { filter: invert(…) }` | the dark chrome for that corner's button group — no other group existed |

So the button was visible **only in the desktop-width web layout** — which is
exactly where the report came from.

## What changed

1. **`js/map3d-terrain.js`** — the `map.addControl(new maplibre.TerrainControl(…))`
   block is removed. The viewer now adds exactly two MapLibre controls, both at
   `bottom-left`: the source credits and the scale.
2. **`css/map3d-terrain.css`** — the desktop row reservation for that corner, the
   phone `display: none` rule, and the `.maplibregl-ctrl-group` /
   `button + button` / `.maplibregl-ctrl-icon` chrome that only that button group
   used are all deleted; each would now be dead. The comment above them records
   why the corner is free (it belongs to the app's “?” button), and the stale
   “MapLibre brings its own navigation/pitch/terrain controls” note in the
   `.is-3d` block now says what MapLibre actually adds: credits + scale,
   both bottom-left.
3. **`MAP_3D_TERRAIN.md`** — §“Controls”, §“Layout while 3D is on” and the
   narrow-viewport budget list describe the new set (no terrain toggle).
4. **`index.html` / `sw.js`** — cache busting: the viewer and the skin move to
   `?v=20261015-3d-no-terrain-toggle` (the old tags stay in the SW pre-cache
   list), and `CACHE_NAME` becomes `detectlab-v213-no-terrain-toggle` so an
   installed PWA picks both files up.
5. **Tests** — the tag pins in `test-map3d-terrain.js`, `test-map3d-mobile.js`,
   `test-map3d-slider-layout.js`, `test-lidar-3d-focus.js` (new `TAG_VIEWER`),
   `test-arcgis-primary-atlas.js` and `test-globe-canvas-picker.js` follow the
   new tags; `test-danish-layers.js` checks the shell cache numerically instead
   of pinning `v212`.

## What deliberately did **not** change

* **Terrain stays on.** The DEM is part of the style (`style.terrain =
  { source: 'detectlab-dem', exaggeration: … }` in `buildStyle`), not something
  the control switched on. Removing the button cannot flatten the 3D view.
* **Exaggeration stays user-controlled on web.** The `#map3d-exag` slider in
  the 3D bar keeps calling `map.setTerrain({ source, exaggeration })`, and
  `style.terrain.exaggeration` follows `state.exaggeration`. Follow-up: the
  installed PWA hides this slider (v243) because changing DEM exaggeration can
  crash the app; web controls remain unchanged.
* **A DEM that cannot load is still handled.** `terrainSource().missingKey`
  warns once and the view runs flat; the `map.on('error')` handler and the
  veil/report diagnostics are untouched.
* **The 2D map is untouched** — nothing in `js/map-app.js`, `css/styles.css` or
  the layer registry had a terrain on/off switch; this was a 3D-only control.

## How to verify

```bash
node test-map-control-spacing.js    # no top-right reservation, no TerrainControl,
                                    # exactly two bottom-left addControl() calls
node test-map3d-terrain.js          # 3D wiring, style, proxy and mirror suites
node test-map3d-mobile.js           # phone/PWA budget and cache wiring
node test-map3d-slider-layout.js    # bar layout, credits vs duplicate buttons
node test-lidar-3d-focus.js         # the LiDAR entry gate still installs
```

Manually: open the app on a desktop-width window, press **3D** — the top-right
corner shows only the “?” help button (and the fullscreen ✕ in fullscreen), the
bottom-left keeps the credits and the scale, and the 3D bar still has the
*Terrain exaggeration* slider.
