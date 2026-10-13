# Country-selection gate (ArcGIS SceneView + canvas fallback)

## Renderer choice

The authenticated country gate now prefers a **lazy-loaded ArcGIS SceneView**
globe. The existing 2D canvas globe remains the fallback if the ArcGIS SDK,
imagery/network, WebGL, or SceneView cannot start. Both renderers use the same
country-picker data and preserve the existing one-country hand-off, localStorage
record, events, and Leaflet lock. The gate has **no “Change Country” pill** any
more (v190): the dock under the search bar already switches country, and
“Exit view” — or `DetectLabGlobeGate.open()` — reopens the globe. This is
approach B: keep the canvas implementation until the ArcGIS route has been
verified in the deployed browser environment.

The working map remains the primary Leaflet interface, with its flat ArcGIS
Web-Mercator basemap and existing data overlays. The ArcGIS/canvas view is only
the temporary country-selection surface. On selection, the picker starts the
same-country Leaflet camera transition while the 3D renderer is still visible,
then cross-fades to the flat 2D map. Roman layers are not part of this gate.

## ArcGIS globe

`js/globe-arcgis-gate.js` is a small local adapter. It does **not** load the
ArcGIS runtime at page load. Only after `DetectLabGlobeGate.open()` has opened
the gate does it request the ArcGIS Maps SDK 4.31 and its dark theme from
`js.arcgis.com`; the SDK and theme are intentionally not precached. The SceneView
configuration is:

- `viewingMode: "global"`, centered initially at **14°E, 40°N**;
- Esri **World Imagery** as a `TileLayer` in a custom basemap;
- `ground: { layers: [] }`, which leaves a flat globe with no elevation layer;
- background `#030916`, `starsEnabled: false`, `atmosphereEnabled: false`, and
  virtual lighting with direct shadows and ambient occlusion disabled;
- no Esri view widgets: the gate supplies its own zoom controls and visible
  imagery credit.

The 50-country polygons come from the gate's existing geometry builder. The
renderer normalizes GeoJSON ring winding for ArcGIS, draws a separate
`GraphicsLayer` casing under the country outlines, and uses hit-testing plus a
small screen-space fallback for tiny states. The current repository colors and
line styles are retained: default fill `#6b5f82` at 34%, white casing 1.8 px
(1.35 pt), black inner outline 0.9 px (0.675 pt); hover green `#39ff14` at 42%
with 4.5 px casing (3.375 pt) and 2 px outline (1.5 pt); selected fill at 50%
with 5 px casing (3.75 pt) and 2.4 px outline (1.8 pt). Text uses the existing
pale green label color and system font. Tiny country geometry also receives a
small marker so micro-states remain visible and targetable.

## Country selection and data

The gate has no country list or search panel. The globe is the picker: a click
on any supported country immediately selects it, highlights it, flies the
active renderer to the **same frame the flat 2D map will open on** (its fit
zoom, not a level of its own — see “One hand-off frame” below), persists the
existing selection, and then hands off to the existing Leaflet country lock.
The canvas fallback uses the same direct map-click path and the same frame. The
country dock remains available after hand-off for switching countries without
reopening the globe.

The data flow remains the one in `js/globe-country-picker.js`:

1. `data/countries-50m.json` (world-atlas TopoJSON) supplies the 50-country
   geometry; the local d3-geo/topojson libraries are loaded as needed.
2. The Natural Earth **10m** admin-0 shapefile is optionally streamed from the
   existing Supabase public-storage URL, matched to the atlas countries, and
   used to refine the displayed outlines in the background. Neither renderer
   waits on that refinement.
3. Overseas territories are trimmed by the existing picker logic. France
   displays metropolitan France; Russia may display its full geometry but
   retains the existing European hand-off bounds.

Selection still writes
`localStorage['detectlab_selected_country_v1']`, sets
`window._detectlabSelectedCountry` / `..Name` / `..Bounds`, dispatches
`detectlab:country-selected`, and uses the existing `_detectlabCountryLayer`
shim, `filterLayersForCountry()`, lock-change event, and country dock. The app
remains limited to one selected country. Returning users keep the same saved
selection; switching country happens in the dock under the search bar, and
“Exit view” (or `DetectLabGlobeGate.open()`) brings the globe back. There is no
“Change Country” pill next to the “?” help button — it overlapped that button
and duplicated the dock.

## Canvas and last-resort fallback

If ArcGIS CDN loading, WebGL initialization, SceneView preparation, or the
imagery layer fails, the adapter is closed and the gate activates the existing
canvas globe. That path samples the same legacy Esri World Imagery tile URL as
the working map, over `#030916`; if imagery is unavailable it uses the bundled
Blue Marble texture, and if that also fails it draws the atlas land fill. It
keeps the canvas's geometric picking and fly-to behavior.

If the local geometry or 2D canvas cannot initialize either, the static select
is retained only as a last-resort no-globe fallback using the existing
approximate country bounds. The gate should never hard-lock the map solely
because a renderer failed.

## Drawable-surface guard (v185 — “black screen, no globe”)

`#globeGateArcGIS` is not a wrapper around the SceneView — it **is** the view's
container, so the SDK tags the element with `.esri-view`, whose own stylesheet
says `display: flex`. `.esri-view-root` (the SDK's child) sizes itself with
`flex: 100%`, so that flex context is what stretches the view root — and only
then does `.esri-view-surface` and the drawing canvas get a real height.

If anything overrides the container's display (the gate CSS used `display:
block` until v185), the root collapses to `0 px`, the SDK keeps its fallback
300×150 canvas and never resizes it, and the gate opens as a flat `#030916`
panel: no globe, no country outlines, only the gate chrome and zoom buttons —
the reported black screen. The fix keeps the SDK contract:

- the gate CSS uses `display: flex` for `.globe-gate.is-arcgis
  .globe-gate-arcgis` and restates `.esri-view-root { flex: 100%; position:
  relative; }` so a theme stylesheet failure cannot re-collapse the view;
- `js/globe-arcgis-gate.js` measures the drawable surface after `open()`
  (`surfaceCoversHost()`, `requestAnimationFrame`-deferred so the layout has
  settled). If the surface is collapsed it restores the documented flex layout
  once (plus `view.resize()`), re-measures, and — if it is still unsized —
  rejects. `js/globe-country-picker.js` then activates the canvas globe, so a
  broken SceneView can no longer leave the visitor on an empty gate.

The guard is only active when the host itself has a measurable size, so a hidden
or `display: none` host (the canvas fallback, background pre-warm of the
geometry) is never treated as broken. Regression coverage:
`test-globe-arcgis-gate.js` (CSS contract, `surfaceCoversHost()`, repair path,
and the reject → canvas-fallback path).

## PWA, network, licensing, and device constraints

`sw.js` uses shell cache `detectlab-v190-no-change-country-pill`. The local
adapter, picker, CSS, translations, and country data remain in the app shell. The external
ArcGIS SDK/theme and imagery services are **not** precached; cross-origin
requests pass through the service worker's network path. `js.arcgis.com`,
`arcgis.com`, and `ibasemaps-api.arcgis.com` are noted in the service-worker
passthrough host list. The static ArcGIS adapter remains available offline, but
the CDN SceneView does not: offline, it falls back to the local canvas assets;
canvas imagery also needs the network, with bundled Blue Marble as its image
fallback.

No API key is embedded in the repository. If the production owner supplies an
approved, referrer-restricted key through
`window.DETECTLAB_ARCGIS_API_KEY` or `window.DetectLabConfig.arcgisApiKey`, the
ArcGIS adapter switches to the keyed `ibasemaps-api.arcgis.com` World Imagery
service and sets `esriConfig.apiKey`. Without that runtime key it uses the same
legacy `server.arcgisonline.com` World Imagery service already used by the
application. Production credentials, usage limits, and the applicable Esri
terms for this deployment still need confirmation by the service owner; this
implementation makes no legal or licensing determination. The gate shows Esri
imagery credit in its own UI.

SceneView consumes WebGL/GPU memory and downloads a third-party SDK when online;
very low-memory phones, older mobile WebViews, or browsers with blocked WebGL
may use the canvas or last-resort select fallback instead. The 10m geometry
refinement can also increase work when it arrives on a mobile device. These are
documented risks, not verified mobile-device results.

## Files

- `js/globe-arcgis-gate.js` — optional ArcGIS SceneView renderer, projection and
  country graphics, hover/click hit-testing, micro-state snap, and camera zoom.
- `js/globe-country-picker.js` — shared 50-country / 10m data flow, direct
  globe-click selection, public API, persistence, selection events, Leaflet
  lock and canvas fallback.
- `css/globe-country-picker.css`, `index.html`, and `js/translations.js` — gate
  layout, markup, and EN/RO click-to-select copy.
- `js/map-app.js` — the working map's flat ArcGIS Web-Mercator basemap stack.
- `js/country-dock.js` + `css/country-dock.css` — the working map's country
  switcher and lock-exit controls (see `COUNTRY_SELECTION_DOCK.md`).
- `js/d3.min.js`, `js/topojson-client.min.js`, `js/shapefile.js`, and
  `data/countries-50m.json` — local data/rendering dependencies; the optional
  Natural Earth 10m shapefile remains a remote Supabase refinement.
- `images/globe/earth-blue-marble.jpg` and `images/globe/earth-topology.png` —
  canvas fallback texture assets.
- `tools/globe-gate-preview.html` — dev-only full-gate harness for visual
  checks without auth or a working map.

## Verification status for this change

The root Node tests exercise the shared data builder, single-country contract,
SceneView configuration, lazy CDN wiring, cache versions, and renderer fallback
wiring. A live browser check of ArcGIS WebGL, Esri imagery, mobile layout,
service-worker offline behavior, and the production key/terms was **not run for
this change**. Those checks remain required before removing or deprecating the
canvas fallback.

## Seamless 3D-to-2D hand-off

The selected-country outline belongs to the working Leaflet map, so it is
placed in Web Mercator together with every other working-map overlay. The
picker no longer projects that outline through a separate globe camera. During
a globe selection, `prepareFlatMapTransition()` stages the hand-off before the
3D gate is hidden:

1. The flat map switches to the same ArcGIS World Imagery basemap used by the
   gate, stops any previous Leaflet motion, and invalidates its size.
2. The selected country's padded bounds and fit zoom are computed once, using
   the same lock constants as `restrictLeafletToCountry()`.
3. Leaflet begins its animated `fitBounds()` while ArcGIS SceneView or the
   canvas globe performs its own camera flight. Both surfaces therefore target
   the same country concurrently.
4. Once selection and lock state are applied, the active renderer remains
   visible during a 720 ms opacity fade. ArcGIS cleanup is delayed until that
   fade completes; the canvas path follows the same timing.

The staged transition is consumed by `applySelection()` so the working map is
not fitted a second time. Dock-driven country changes skip the gate and use the
normal flat-map selection path. If a renderer or the map is unavailable, the
existing last-resort selection and lock behavior still applies.

The selected-country outline is consequently stable in the final view:
Leaflet/Web-Mercator owns its placement, while the 3D renderer is only a
transitional selection surface. The lock, persistence, layer filtering, bounds
pane, country dock, and exit-view behavior are unchanged.

## One hand-off frame (v189 — the zoom the two surfaces meet on)

The globe used to end its flight on a zoom of its own: `zoomFor()` in
`js/globe-arcgis-gate.js` derived a SceneView zoom from the country's bbox span
(`log2(360 / span) − 0.35`, clamped to 1.8–9.2), while the flat map opened on
its Leaflet fit zoom (`min(11, getBoundsZoom(country box))`). For France on a
desktop viewport those are ~4.2 and ~6 — the cross-fade therefore revealed a map
zoomed about **3× closer** than the globe the user had just been looking at.
The canvas fallback had the same class of mismatch (`k = 60 / span`).

Both renderers now start from one object, computed by the picker before either
camera moves (`countryHandoffFrame(iso, bbox)`):

- `bounds` / `padded` — the country box and its `LOCK_PAD` box, built once and
  reused by the staged 2D fit and by `restrictLeafletToCountry()`;
- `fitZoom` — `countryFitZoom(map, bounds)` = `min(FIT_MAX_ZOOM 11,
  map.getBoundsZoom(bounds, false, [2 × FIT_PADDING, 2 × FIT_PADDING]))`,
  clamped to the map's own zoom range. The doubled padding is Leaflet's:
  `fitBounds()` measures with `paddingTopLeft.add(paddingBottomRight)`, so a
  symmetric `padding: [24, 24]` frees 24 px on *each* side and asking for a
  single 24 would report a fit up to one level too deep — the level the globe
  would then fly to while the 2D map landed one step wider. With the doubling,
  the number *is* the zoom the flat map opens at (verified against real Leaflet
  for all 50 countries: fit zoom == landed zoom);
- `center` — the hand-off bbox centre (for Russia the App's European box, not
  the Asian geometry centroid), which is what both cameras centre on.

`selectCountry()` hands that frame to the active renderer:

- **ArcGIS SceneView** — `DetectLabArcGISGate.goToCountry(iso, { zoom:
  fitZoom })`. The adapter converts the flat (Web-Mercator) zoom to the
  equivalent 3D level with the documented 2D→3D viewpoint correction: a
  Mercator map shows ground at a nominal scale inflated by `1/cos φ`, while the
  globe shows true ground scale, so `sceneZoomForFlat()` adds
  `log2(1 / cos φ)` zoom levels (Esri's own “switch view from 2D to 3D” sample
  multiplies the 2D scale by `cos φ` for the same reason; ~0.67 levels at 51°N,
  ~0 at the equator). The result is clamped to the SceneView window
  (`MIN_SCENE_ZOOM 1.5` … `MAX_SCENE_ZOOM 12`, the same window `zoomBy()`
  uses). `zoomFor()` remains only as the fallback for a gate with no flat map
  behind it (dev harness), and the picker passes `{ zoom: null }` in that case.
- **Canvas fallback** — `flyTo(entry, done, frame)` centres on `frame.center`
  and takes its scale from `canvasFrameScale()`, the orthographic equivalent of
  the same conversion: with the projection radius `R = min(W,H)/2 · 0.88 · k`
  px per radian, a country box of `Δλ°` spans `R·Δλ·(π/180)·cos φ` px on the
  canvas and `Δλ·256·2^z/360` px on the flat map, so
  `k = 92.6 · 2^fitZoom / (min(W,H) · cos φ)`. Without a fit zoom the old
  span-based estimate is kept.

The 2D fit still runs first and the globe flight still resolves before the
gate's 720 ms fade, so the two surfaces are already on the same frame when the
cross-fade starts. Regression coverage: the hand-off zoom/conversion/clamp
assertions in `test-globe-arcgis-gate.js`, the canvas pixel-width cross-check in
`test-globe-canvas-picker.js` (the country must land within 1 px of the flat
map's width), and the `countryHandoffFrame` / `canvasFrameScale` assertions in
`test-country-dock.js`.

### A lock never leaks its zoom floor into the next country (v189)

Because `fitZoom` is shared, a stale zoom level would also be flown to by the
globe — so the frame is measured inside the map's **own** zoom range:

- `countryFitZoom()` calls `getBoundsZoom()` with the map's base `minZoom` /
  `maxZoom` temporarily restored. Leaflet clamps that answer to the *live*
  range, and the locked view has already raised `minZoom` to the current
  country's fit level; measuring under it pegs the next country there. Locked on
  Monaco (floor 10) and switching to Russia used to compute `fitZoom 10`
  (≈43 000 px wide at that zoom) instead of the Russian extent's 2–3, so both
  the globe and the map opened at street level. The live range is put straight
  back, so the lock itself is untouched.
- `prepareFlatMapTransition()` drops a stale floor (`setMinZoom(baseMinZoom)`)
  before its `fitBounds()`, because Leaflet's `setView()` clamps to the live
  range as well — otherwise the staged 2D camera could not reach the frame the
  globe is flying to. `restrictLeafletToCountry()` sets the new floor right
  after.

Asserted in `test-country-dock.js` (“zoom floors never leak between countries”),
and cross-checked with real Leaflet in a 900×600 jsdom viewport, where every
country's `fitZoom` now equals the zoom the map actually lands on (before the
fix a country switch inherited the previous floor, e.g. Monaco → Russia landed
at 10).

## The locked view never draws a bounding box (v189)

`showCountryBoundsLayer()` has no `L.rectangle` fallback any more. It draws the
country's real outline from the gate geometry and, while that geometry is not
loaded, draws **nothing at all** — the bbox keeps its other jobs (`maxBounds`,
layer-coverage math, camera) but is never rendered as the country's shape.

That fallback was the “perfect rectangle that merges into the country a few
seconds later”: a selection restored from `localStorage` locked the map before
the atlas arrived, so the overlay started as the selection box and was only
swapped for the real outline when `ensureReady()` (or the 10 m refinement)
finished. `refreshCountryBoundsLayer()` now runs whenever the view is locked
(not only when a layer already exists), so the outline appears the moment
geometry is available; `attach()` fires `prefetch()` for a restored selection
so that moment comes as early as possible; and a repeat draw with the same
country and the same feature object is a no-op, so re-locks and refreshes no
longer flash the outline. `state.boundsIso` / `state.boundsFeature` record what
is currently drawn (a *new* feature object — the 10 m refinement — does replace
the outline, which is the intended detail upgrade).

## Gate deployment and regression checks

`sw.js` cache `v190` precaches the local ArcGIS adapter, picker, styles,
translations and the 50m atlas (the retired MapLibre globe assets are no longer
part of the shell). The remote ArcGIS SDK,
theme, imagery, and the two optional canvas texture images are intentionally
not precached. The canvas can still show atlas land if those texture images are
unavailable.

The key suites are `node test-globe-arcgis-gate.js` (lazy loading, SceneView
configuration, the v185 drawable-surface guard, country graphics, the
single-select flow and the v189 hand-off zoom/conversion/clamp),
`node test-globe-canvas-picker.js` (fallback picking, shared geometry, imagery
math and the canvas↔flat-map frame cross-check), `node test-country-dock.js`
(public API, lock, dock, exit/re-entry and the shared hand-off frame), and
`node test-country-layer-filter.js` (country-scoped layers and the outline-only
bounds overlay). The public `window.DetectLabGlobeGate` API and `_test` hooks
remain in `js/globe-country-picker.js` (`countryHandoffFrame`,
`countryFitZoom`, `canvasFrameScale`, `bboxBounds`, `FIT_PADDING` are exported
for the suites).
