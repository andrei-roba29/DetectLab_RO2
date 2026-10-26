# The “3D” button sits right above the base-layer button — installed PWA only (v255)

Date: 2026-10-23 · Files: `css/map3d-terrain.css`, `js/map3d-terrain.js`,
`index.html`, `sw.js` ·
Test: `node test-3d-switch-base-layer-column.js`

Scope: **installed PWA (`body.is-pwa`) only.** On the website
(`body:not(.is-pwa)`) nothing moves — the switch still floats bottom-centre
(`66px` desktop, `58px` phones) and the 3D bar still anchors at `bottom: 34px`,
centred over the bottom-centre switch.

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

In the installed PWA (`body.is-pwa`), the switch **heads the map's
bottom-left control column**, in Leaflet's own stacking order, left-aligned
with the button it sits on:

Under `body:not(.is-pwa)` the website is byte-for-byte unchanged: the switch
stays bottom-centre (`66px` desktop, `58px` phones) and the bar stays at
`bottom: 34px`, centred over it.

```
┌──────────────┐
│  [3D]  [↻]   │  ← .m3d-toggle-group   (z 960, in .map-wrapper)
│  [layers]    │  ← #arcgisBasemapCtrl  (Leaflet control, bottomleft)
│  [N]         │  ← compass (drag to rotate, tap for north)
│  [Detect]    │  ← installed PWA only
└──────────────┘
```

The bottom-centre slot is left to the pills and hints that already share it,
and the switch no longer reads either lift variable.

## Why the offset is measured, not a CSS constant

Leaflet stacks that corner **in flow** and every environment moves it:

| Environment | What moves the corner | Column height above the wrapper's bottom edge |
|---|---|---|
| Website | compass 38, two 10px Leaflet margins, the 34px control | measured and published, but **not consumed**: the website switch stays bottom-centre (`66px`) |
| Installed PWA | `body.is-pwa .leaflet-bottom { bottom: env(safe-area-inset-bottom) }` (index.html) **and** the second `.compass-detect-btn` | control top **138px + inset** → switch bottom **146px + inset** |
| Mobile web, fullscreen | `body:not(.is-pwa) .map-frame.is-fullscreen #detectlab-map .leaflet-bottom.leaflet-left { position: fixed; bottom: calc(56px + inset) }` (css/styles.css) | the whole corner is fixed 56px above the browser bar |
| Base-layer list open | `.arcgis-basemap-ctrl.is-open` grows the control **upward** | the switch steps up with it (PWA only) |

So `js/map3d-terrain.js` measures `#arcgisBasemapCtrl` against `.map-wrapper`
and publishes three custom properties on the wrapper in **every** environment,
but `css/map3d-terrain.css` only consumes them under `body.is-pwa`:

| Property | Meaning | PWA fallback (consumed under `body.is-pwa`) |
|---|---|---|
| `--m3d-anchor-bottom` | wrapper bottom → the control's top edge **+ 8px gap** | `calc(146px + inset)` |
| `--m3d-anchor-left` | wrapper left → the control's left edge | `10px` |
| `--m3d-stack-top` | wrapper bottom → the **switch's own** top edge | `calc(190px + inset)` |

The website keeps its own constants instead — switch `bottom: 66px`,
`left: 50%`, `translateX(-50%)`; bar `bottom: 34px`, centred — so nothing on
the website reads or moves with the measured properties.

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
| Website, desktop | centred over the bottom-centre switch, `bottom: 34px`, `left: 50%`, `translateX(-50%)`, `width: 208px`, `max-height: calc(100% - 72px)` — unchanged |
| Website, phones ≤ 720px | same centred `bottom: 34px` placement; only width, font-size and padding narrow — unchanged |
| Installed PWA, phones ≤ 720px | tucked under the search bar on the left, `top: 56px`, `left: 8px`, `bottom: auto`, `max-height: calc(100% - 64px - var(--m3d-stack-top, 144px))` — the cap keeps landscape (390px of height) from putting the bar over the switch |
| Installed PWA, 3D (desktop/tablet) | centred over the column switch, `bottom: calc(var(--m3d-stack-top) + 8px)`, `left: 50%`, `translateX(-50%)`, `width: 280px`, `max-height: calc(100% - var(--m3d-stack-top) - 72px)` |

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
switch — exactly as it already covers the base-layer button and the compass
beneath it. The panel is a deliberate, closable overlay, and
the switch is now part of the stack it parks on.

## Assets

`index.html` and `sw.js` re-tag both changed files
(`?v=20261023-pwa-only-3d-column`) and `CACHE_NAME` moves to
`detectlab-v255-pwa-only-3d-column`. The previous tags stay in the
precache list, so an installed shell still finds the copy it references.

## Tests

- **`test-3d-switch-base-layer-column.js`** (new) — the stylesheet contract
  (the three properties, the fallbacks, no centred anchor and no lift
  variables left, the bar's three layouts), the viewer contract (what is
  measured, published, watched and retried), and the measurement itself run in
  a `vm` against a stub column: website `100px`, PWA `146px + inset`, an open
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
  cache-busting tags they pin move to `20261023-pwa-only-3d-column`
  (`test-map-control-spacing.js` also picks up the `css/styles.css` tag v253
  left behind). `test-map3d-startup.js` and `test-search-exit-3d.js` stub the
  new `queueAnchorSync()` in the closures they run.

---

# v276 — the base-layer button itself now stays on screen in 3D

Date: 2026-10-26 · Files: `css/map3d-terrain.css`, `js/map3d-terrain.js`,
`index.html`, `sw.js` · Test: `node test-3d-basemap-button.js`

## The ask

> The base map in 3D view should still appear as its side button on the bottom
> left side of the screen, above the info button and the altitude distance.

While 3D was on, `body.is-3d #detectlab-map .leaflet-control-container`
hid **every** Leaflet control — the whole 2D stack drives a map the user cannot
see — so the base-layer button (`#arcgisBasemapCtrl`, the round layers icon)
vanished with it and the only way to change the base map was the picker inside
the 3D bar.

## After

The base-layer button is the **one** exception: it keeps its bottom-left slot
in the 3D view, in the same glass material as the rest of the map icons, and
the 3D bar's picker stays as the second (identical, synced) way to do the same
thing — both read and write the single ArcGIS basemap state.

```
┌──────────────────────────┐
│                          │
│   (3D canvas)            │
│                          │
│  [layers] ← base layer   │  above the MapLibre widgets
│  (i)      ← source credits│  MapLibre AttributionControl (compact)
│  ├── 500 m ┤ ← scale      │  MapLibre ScaleControl
└──────────────────────────┘
```

- `css/map3d-terrain.css` — the corner still hides the container; a
  `:not(#arcgisBasemapCtrl)` rule removes every **other** bottom-left control
  (compass, attribution) with `display: none` so they no longer reserve space,
  and `#arcgisBasemapCtrl` gets `visibility: visible` plus
  `margin-bottom: var(--m3d-basemap-lift, 58px) !important`.
- `js/map3d-terrain.js` — the lift is **measured**, not guessed, exactly like
  the switch's own anchor: MapLibre lays its bottom-left widgets out itself
  (10px margins, and the credit row grows when the ⓘ is opened), and every
  environment moves the Leaflet corner (PWA home-indicator inset, mobile-web
  fullscreen). `syncBasemapLift()` publishes

  `--m3d-basemap-lift` = bottom of Leaflet's own corner → top of
  `.maplibregl-ctrl-bottom-left` + the same `8px` gap the column uses.

  It runs from `syncToggleAnchor()` (the single place every layout change
  already passes through: open, close, window resize, orientation change,
  fullscreen change, body-class mutation, control/​wrapper resize), is queued
  right after MapLibre's ⓘ and scale are added, follows the credit row with a
  `ResizeObserver`, clears the property when the surface is not built (so the
  stylesheet fallback applies), and is exposed as `_syncBasemapLift()` /
  `_basemapLift()` for diagnostics.

Measuring from Leaflet's own corner bottom (not the wrapper edge) is what keeps
a shared safe-area inset from being counted twice: the PWA lifts both corners by
the same `env(safe-area-inset-bottom)`.
