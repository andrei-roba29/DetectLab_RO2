# The layers window: one glass pane, glass rows, and a tile photo per sheet

Phase 2 of the 2026-10-25 glass release (phase 1 — the map buttons and the
Google-Earth compass — is described in `MAP_CONTROLS_GLASS_COMPASS.md`).

Three things changed in `#transpPanel`:

1. the **window** is the same translucent violet glass as the map controls;
2. **every row in it** — the top-level `.transp-layer-row` *and* the nested
   rows the `*SubLayers` accordions render — is the same material;
3. every **historical-map row** carries, as its own background, **a photo of
   one of its own tiles**, mean-ed out under a violet wash so the switch, the
   slider, the info button and the labels stay readable on top of it.

## 1. The window

`css/styles.css` § `.transp-panel`. The near-opaque navy slab
(`rgba(10,20,42,.97)` → `rgba(6,14,30,.97)`, `blur(20px)`, sky-blue border) is
replaced by the control tokens:

| Property | Before | Now |
|---|---|---|
| tint | two opaque navy stops | `rgba(20,14,34,.66)` → `rgba(12,9,24,.76)` |
| violet wash | `rgba(107,63,160,.16)` | `rgba(107,63,160,.30)` top-right + `rgba(126,94,214,.16)` bottom-left |
| frost | `blur(20px)` | `var(--ctl-blur)` — `blur(18px) saturate(150%)` |
| edge | `1px solid rgba(184,216,240,.16)` | `1px solid var(--ctl-border)` |
| drop | `-10px 0 40px rgba(0,0,0,.55)` | `-10px 0 40px rgba(4,6,18,.42)` + inner highlight |

The two tint stops are **custom properties** (`--panel-top-alpha`,
`--panel-bottom-alpha`) because of the LiDAR / archeology drag path: it drops
the panel's backdrop blur for performance on a phone, and a translucent pane
without its frost would flash much darker. That rule now thickens the tint to
`0.92 / 0.94` for the duration of the drag instead, so the window still reads
as the same window while the per-frame re-blur work is gone.

The tab row below the title uses the same tokens (idle `--ctl-bg`, hover
`--ctl-bg-hover`, active `--ctl-bg-engaged`), so the three tabs are the same
material as the rows under them.

In the installed PWA (`index.html`, `body.is-pwa .transp-panel`) the panel
keeps its transparent bottom safe-area gutter, which cannot be blurred — so
that rule stays `backdrop-filter: none !important` and carries a denser tint
(`0.86 / 0.90`) plus the same violet wash instead.

## 2. The rows

`css/styles.css` § `.transp-layer-row, .dl-sublayer-row` — one rule, one
material: `var(--ctl-bg)`, `var(--ctl-border)`, `var(--ctl-radius)`,
`var(--ctl-shadow)`, and the `--ctl-bg-hover` / `--ctl-border-hover` /
`--ctl-shadow-hover` set on hover.

The nested rows (the sheet rows inside `#histPremiumSubLayers`,
`#histSubLayers`, `#lidarSubLayers`, `#romanSubLayers`, the country groups —
any element inside an element whose id ends in `SubLayers` that owns a layer
control) had **no box at all** before: they floated bare on the panel. They
are tagged `.dl-sublayer-row` at runtime by `js/layer-panel-rows.js` (the rows
are static markup plus several generators, so a CSS-only selector would have
had to enumerate every container and would have caught the accordion wrappers
too), and get the compact cut of the same box: 10px radius, `10px 11px 12px`
padding.

**The rows carry no `backdrop-filter` of their own.** The window above them
already creates a backdrop root, so a row-level blur would only re-blur the
pane's own flat tint — invisible — while every row still bought a compositing
layer. On a phone that is dozens of layers over a live map, exactly the cost
the LiDAR drag path had to work around. Translucency + the hairline violet
edge + the inner highlight are what make a row read as glass inside the pane.

The CENAGIS catalogue rows (`js/historical-eu-maps.js` `renderUi()`) are
generated with their own dark inline box; `js/layer-panel-rows.js` drops the
whole `style` attribute on them rather than fighting it with `!important` (a
style parser is free to expand `background`/`border` into longhands, so
removing them one by one leaves half a box behind).

## 3. The tile photo

`js/layer-panel-rows.js` — new file, loaded after `js/layer-registry.js`
(`index.html`) and precached by `sw.js`.

* A row opts in with `data-preview-layer="<registry layer id>"` (29 rows in
  `index.html`: the three free historical rows and the 26 premium sheets).
  CENAGIS catalogue rows are resolved from their own `data-map-id` as
  `cenagis.<key>`, so the whole country catalogue gets photos without a second
  copy of anything.
* The URL is built from **the layer's own definition** in
  `js/layer-registry.js` — never from a second copy of an endpoint:
  * `kind: 'xyz'` / `'arcgis-image'` → the layer's own tile template, filled
    with the `{z}/{x}/{y}` of the tile under the sheet (ArcGIS templates are
    `{z}/{y}/{x}`; the template decides the order). The preview zoom is
    `min(maxNativeZoom, 13)`, clamped into `[minZoom, maxZoom]`.
  * `kind: 'wms'` → a 168×96 `GetMap` over the middle of the sheet, in
    `EPSG:3857`, `srs=` for 1.1.x and `crs=` for 1.3.0. The `_2180` CENAGIS
    mosaics are asked exactly the way the 2D map asks them (3857 request, the
    GeoServer re-projects).
  * The anchor is the centre of the layer's `bounds`; the 20 layers whose
    definition carries no box have an explicit anchor in the module's
    `ANCHORS` table (a town inside that sheet's footprint). The test fails if
    a new historical layer has neither.
* `css/styles.css` § `[data-row-preview]` paints it: `::before` is the photo
  (`blur(7px) saturate(.45) brightness(.72)`, `opacity .7`, clipped back to
  the row radius), `::after` is the violet fade over it, and every direct
  child is lifted to `z-index: 1`.
* Loading is lazy and fail-soft: nothing is fetched while the window is
  closed, collapsed accordions and hidden tabs are skipped (`getClientRects`),
  at most 4 requests are in flight, each row remembers it was already tried
  (`data-row-preview-state`), and the photo only lands on the row once the
  image really loaded. A service that is down leaves the plain glass row —
  never an empty frame.

To see it without the app: `preview/layer-window.html` (outside the repo,
built by `preview/build-layer-window.py`) assembles the real panel markup over
the real stylesheets and modules.

## 4. Assets

`index.html` loads `js/layer-panel-rows.js?v=20261025-layer-glass` and re-tags
the skin set (`css/styles.css`, `css/tutorial.css`, `css/offline-maps.css`,
`css/map3d-terrain.css`, `js/tutorial.js`) to the same tag — the release tag
moves from `20261025-glass-controls` to `20261025-layer-glass`. The same URLs
are appended to `PRECACHE_URLS` in `sw.js` and `CACHE_NAME` moves to
`detectlab-v270-layer-glass`. `js/layer-registry.js` and
`js/historical-eu-maps.js` are **not** retagged: the row chrome reads the
registry, it does not edit it.

## 5. Tests

`test-layer-panel-rows.js` (new):

* the window and both row kinds share the `--ctl-*` material, the window is
  translucent (`< .8` alpha stops) and the old `rgba(10,20,42,.97)` slab is
  gone;
* rows add no second blur layer inside the blurred pane;
* the photo is `var(--row-preview)`, blurred/desaturated/dimmed, violet-washed
  and lifted children above it;
* all 29 tagged rows resolve to a URL from their own registry definition; every
  bounded pyramid's preview tile decodes back to a point inside that layer's
  own `bounds`; unbounded layers are anchored; WMS previews carry the right
  `GetMap` parameters (`srs` vs `crs`, the layer's own endpoint);
* the loader is lazy, capped, fail-soft and remembers failures;
* cache-busting / precache / shell version wiring.

The tag bump touches the tests that pin `?v=20261025-…`: they were updated in
the same pass (`test-map-control-spacing.js`, `test-map3d-terrain.js`,
`test-mobile-fullscreen-controls.js`, `test-country-layer-filter.js`,
`test-country-exit-3d-stack.js`, `test-lidar-3d-focus.js`,
`test-3d-basemap-picker-lidar.js`, `test-3d-switch-base-layer-column.js`,
`test-map3d-mobile.js`, `test-map3d-slider-layout.js`,
`test-basemap-restore-and-picker.js`).
