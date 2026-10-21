# The “3D” button now sits right above the base-layer button (v254)

Date: 2026-10-21 · Files: `css/map3d-terrain.css`, `js/map3d-terrain.js`,
`index.html`, `sw.js` ·
Test: `node test-3d-switch-base-layer-column.js`

---

## The ask

> move the 3D button right above the base layer button

The **3D button** is the 2D/3D switch `#map3d-toggle` (with the 1 km raster
refresh `#map3d-refresh` beside it once 3D is on). The **base layer button** is
`#arcgisBasemapCtrl` — the bottom-left Leaflet control `js/map-app.js` builds,
whose icon-only header folds the three ArcGIS base maps (Imagery /
Topographic / Terrain) and the World Hillshade checkbox open.

## Before

The switch floated **bottom-centre**: `66px` up on desktop, `58px` on phones,
`64px + env(safe-area-inset-bottom)` in the installed PWA's 3D view. That slot
is the busiest on the map — the country “Exit view” pill, the analysis action
dock, the offline ✕ and the APM/zoom hints all live there — so the switch
needed two lift variables (`--layer-dock-clearance`, `--country-exit-lift`) to
dodge them, and v248 existed purely because the PWA pill and the switch fought
over the same 60px of bottom centre (`PWA_EXIT_VIEW_3D_STACK.md`).

## After

The switch **heads the map's bottom-left control column**, in Leaflet's own
stacking order, left-aligned with the button it sits on:

```
┌──────────────┐
│  [3D]  [↻]   │  ← .m3d-toggle-group   (z 960, in .map-wrapper)
│  [layers]    │  ← #arcgisBasemapCtrl  (Leaflet control, bottomleft)
│  [N]         │  ← compass
│  [lock]      │  ← rotation lock
│  [Detect]    │  ← installed PWA only
└──────────────┘
```

The bottom-centre slot is left to the pills and hints that already share it,
and the switch no longer reads either lift variable.

## Why the offset is measured, not a CSS constant

Leaflet stacks that corner **in flow** and every environment moves it:

| Environment | What moves the corner | Column height above the wrapper's bottom edge |
|---|---|---|
| Website | compass 38 + 8 + lock 38, two 10px Leaflet margins, the 34px control | control top **138px** → switch bottom **146px** |
| Installed PWA | `body.is-pwa .leaflet-bottom { bottom: env(safe-area-inset-bottom) }` (index.html) **and** the third `.compass-detect-btn` | control top **184px + inset** → switch bottom **192px + inset** |
| Mobile web, fullscreen | `body:not(.is-pwa) .map-frame.is-fullscreen #detectlab-map .leaflet-bottom.leaflet-left { position: fixed; bottom: calc(56px + inset) }` (css/styles.css) | the whole corner is fixed 56px above the browser bar |
| Base-layer list open | `.arcgis-basemap-ctrl.is-open` grows the control **upward** | the switch steps up with it |

So `js/map3d-terrain.js` measures `#arcgisBasemapCtrl` against `.map-wrapper`
(the box both the switch and the 3D bar are positioned against) and publishes
three custom properties on the wrapper:

| Property | Meaning | Website fallback | PWA fallback |
|---|---|---|---|
| `--m3d-anchor-bottom` | wrapper bottom → the control's top edge **+ 8px gap** | `146px` | `calc(192px + inset)` |
| `--m3d-anchor-left` | wrapper left → the control's left edge | `10px` | – |
| `--m3d-stack-top` | wrapper bottom → the **switch's own** top edge | `190px` | `calc(236px + inset)` |

`css/map3d-terrain.css` reads them, with those documented columns as the
fallbacks (so the switch is placed correctly even before the first
measurement, or in a document with no base-layer control at all).

Re-measured on: `resize`, `orientationchange`, `fullscreenchange`, a Leaflet
`resize` (panels folding, no window resize), a `ResizeObserver` on the control
(its list folds open), its Leaflet corner (a button joins the compass column)
and the wrapper, a `MutationObserver` on `body[class]` (`is-pwa`, fullscreen),
and on every 2D⇄3D switch (the refresh action joins the group, so the group's
height — and with it `--m3d-stack-top` — changes). Because `js/map-app.js`
builds the control inside its own async boot, the measurement retries for up to
10s until the control exists, the way the button's own boot loop does.

`window.DetectLabMap3D._toggleAnchor()` returns what was measured
(`{ bottom, left, stackTop, gap }`) and `_syncToggleAnchor()` re-measures on
demand — for support sessions and for the tests.

## The 3D control bar follows

The switch stays visible in 3D (it is the way back to 2D), so the bar can no
longer sit at a fixed `bottom: 34px` in the same corner:

| Layout | Bar placement |
|---|---|
| Desktop (`#map3d-bar`) | `left: var(--m3d-anchor-left)`, `bottom: calc(var(--m3d-stack-top) + 8px)`, `max-height: calc(100% - var(--m3d-stack-top) - 64px)` |
| Phones ≤ 720px | unchanged top anchor (`top: 56px; left: 8px`), `max-height: calc(100% - 64px - var(--m3d-stack-top))` — the cap is what keeps landscape (390px of height) from putting the bar over the switch |
| Installed PWA, 3D | still centred over the bottom actions, `bottom: calc(var(--m3d-stack-top) + 8px)`, `max-height: calc(100% - var(--m3d-stack-top) - 72px)` |

Where the bar has less room than its contents (short/landscape screens) it
scrolls, exactly as it already did — `overflow-y: auto` is untouched.

## What did **not** change

- The switch's markup, ids, copy, `aria-*`, z-index (960) and behaviour:
  `#map3d-toggle`, `#map3d-refresh`, `#map3d-refresh-status`, the entry gate,
  the LiDAR disc route, the tile prefetch.
- `#arcgisBasemapCtrl` itself, the compass column, the layer panel, the search
  bar, the country dock and the PWA action dock.
- The country “Exit view” pill's anchors (`18px`, PWA `60px + inset`) and the
  `--country-exit-lift` hook `js/country-dock.js` publishes; the switch simply
  no longer needs it. The dock's `--layer-dock-clearance` still lifts the
  bottom-centre stack (APM help, zoom hints).
- The folded LiDAR window `#map3d-focus .m3d-focus-mini`, which keeps the
  bottom-centre slot to itself (`10px + inset`, 44px tall).

One accepted consequence of joining the corner: while the offline-maps picker
(`.offline-map-panel`, `z-index 1300`, bottom-left) is open it covers the
switch — exactly as it already covers the base-layer button, the compass and
the rotation lock beneath it. The panel is a deliberate, closable overlay, and
the switch is now part of the stack it parks on.

## Assets

`index.html` and `sw.js` re-tag both changed files
(`?v=20261021-3d-switch-baselayer-column`) and `CACHE_NAME` moves to
`detectlab-v254-3d-switch-baselayer-column`. The previous tags stay in the
precache list, so an installed shell still finds the copy it references.

## Tests

- **`test-3d-switch-base-layer-column.js`** (new) — the stylesheet contract
  (the three properties, the fallbacks, no centred anchor and no lift
  variables left, the bar's three layouts), the viewer contract (what is
  measured, published, watched and retried), and the measurement itself run in
  a `vm` against a stub column: website `146px`, PWA `192px + inset`, an open
  base-layer list, a missing control and a not-yet-laid-out control. Optional
  real-cascade geometry in Chromium (a stub Leaflet corner + the extracted
  measurement): `PUPPETEER_MODULE_DIR=/path/to/node_modules node
  test-3d-switch-base-layer-column.js`.
- **`test-country-exit-3d-stack.js`** — §3 now asserts the switch has left the
  pill's column (no rule that places it may read the lift or be centred) and
  the geometry checks assert the two boxes never intersect, the pill keeps its
  own taps and the bar rides above the switch.
- **`test-lidar-3d-focus.js`**, **`test-analysis-layers-3d.js`** — the switch
  assertions follow the new anchor; the pill and the dock keep theirs.
- **`test-map3d-mobile.js`**, **`test-map3d-slider-layout.js`**,
  **`test-map3d-terrain.js`**, **`test-map-control-spacing.js`**,
  **`test-search-exit-3d.js`**, **`test-3d-analysis-points.js`**,
  **`test-arcgis-primary-atlas.js`**, **`test-globe-canvas-picker.js`** — the
  cache-busting tags they pin move to `20261021-3d-switch-baselayer-column`
  (`test-map-control-spacing.js` also picks up the `css/styles.css` tag v253
  left behind). `test-map3d-startup.js` and `test-search-exit-3d.js` stub the
  new `queueAnchorSync()` in the closures they run.
