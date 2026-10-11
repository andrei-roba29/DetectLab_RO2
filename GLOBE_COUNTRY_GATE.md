# 3D Globe Country Gate (canvas edition)

## What changed

The country-selection gate — the first thing an authenticated visitor sees
in the map card — remains an **orthographic globe drawn on a plain 2D
`<canvas>` with d3-geo**. This keeps hover/click picking independent of WebGL:
every pixel is drawn by the app and picking is pure geometry
(`projection.invert` + `d3.geoContains`).

The working map underneath now has its own **permanent MapLibre GL 3D globe
basemap** (`projection: globe`) using Esri World Imagery. A Leaflet binding
keeps the existing map controls, geographic data layers and country-lock
contract in place; MapLibre is used only to render the basemap. It uses a local,
inline style (no remote style-host dependency), with the pre-existing Esri tile
service as the imagery source. If WebGL is unavailable, the app falls back to
the same imagery as a Leaflet raster layer so country selection and the map
remain usable.

The gate is now the *start* of a locked country view rather than a one-off
hand-off: picking a country pins the Leaflet-controlled working map to its
bounds (tight `maxBounds` + zoom floor) while keeping the same 3D globe base.
The search-bar country dock takes over switching from there — see
**COUNTRY_SELECTION_DOCK.md**.

The gate and the working map share **one basemap**: the canvas globe samples
the same Esri World Imagery tiles (`IMAGERY_URL` in the picker =
`WORLD_IMAGERY_URL` in `globe-base-layer.js`) over the same background colour
(`#030916`), drawn flat like MapLibre draws them — no hillshade, no
limb darkening, no atmosphere halo. The bundled Blue Marble texture is kept
only as a fallback for when the tile service cannot be reached (see "Base
layer" below), and the gate shows the imagery credit in its bottom-left
corner (`#globeGateAttrib`).

Files:

- `js/globe-country-picker.js` — the canvas gate (hover/click picking,
  fly-to animation, Leaflet handoff, persistence) plus the country-switching /
  locked-view API the dock uses (`listCountries`, `selectCountry`, `isLocked`,
  `unlock`, `exitView`).
- `js/globe-base-layer.js` — local MapLibre style + Leaflet adapter for the
  permanent 3D working-map basemap, with opacity handling and WebGL fallback.
- `css/globe-base-layer.css`, `js/maplibre-gl.js`,
  `js/leaflet-maplibre-gl.js`, `css/maplibre-gl.css` — local runtime assets;
  licenses are retained in `MAPLIBRE_LICENSE.txt` and
  `MAPLIBRE_LEAFLET_LICENSE.txt`.
- `css/globe-country-picker.css` — gate overlay, legend, zoom buttons,
  loading/error states, "Change Country" pill.
- `js/country-dock.js` + `css/country-dock.css` — the search-bar country dock,
  the World-hillshade checkbox and the "Exit view" button of the locked
  country view (see COUNTRY_SELECTION_DOCK.md).
- `js/d3.min.js` (7.9.0), `js/topojson-client.min.js` (3.1.0) — lazy-loaded
  **local** libraries (no CDN dependency; both precached by `sw.js`).
- `data/countries-50m.json` — world-atlas 2 TopoJSON, the primary country
  geometry, shipped with the site (public CDN mirror as fallback).
- `images/globe/earth-blue-marble.jpg`, `images/globe/earth-topology.png` —
  the fallback Earth texture (and its elevation map), used only when the
  World Imagery tile service is unreachable.
- `tools/globe-gate-preview.html` — dev-only harness that opens the gate
  without auth/Leaflet for visual checks.
- `js/maplibre-gl.js` / `css/maplibre-gl.css` — **deleted**.

## How the globe is drawn

1. **Base layer (raster).** For every canvas pixel inside the globe disc the
   inverse orthographic mapping gives a lon/lat, which is converted to Web
   Mercator and sampled (bilinear) from the **Esri World Imagery** tile
   covering it — the same tiles the working map's MapLibre globe draws, so
   the picture does not change at the hand-off. Per frame the picker builds a
   tile plan (`chooseImageryRange` → `planImagery` → `buildImageryGrid`):
   the finest zoom follows the least-stretched latitude in view and the
   sampling step of the frame (the coarse frames drawn while spinning or
   dragging never ask for finer tiles than the refined frame needs), each
   Mercator row nearer a pole steps down to the zoom whose
   texels match the screen there, only cells on the front hemisphere are
   requested, at most 128 distinct tiles per frame (the zoom steps down until
   the view fits), and a cell whose tile is still downloading is drawn from
   its nearest loaded ancestor — the same progressive refinement MapLibre
   does. z0–z2 are loaded as soon as the gate opens and never evicted, so
   every pixel has imagery within a moment; the other tiles live in an LRU
   cache (400 images / 160 decoded buffers). Tiles are drawn as they are: no
   hillshade, no limb darkening, no atmosphere halo; the pole caps repeat the
   outermost Mercator row. The base layer is cached on an offscreen canvas
   and only rebuilt when rotation/zoom/size change (or new tiles arrive) —
   coarse (step 3) while dragging, refined to full resolution ~140 ms after
   the interaction stops. If the tile service is unreachable (the first tiles
   all fail and nothing has loaded, or the canvas gets tainted) the picker
   falls back to the bundled 2048×1024 Blue Marble texture (with its
   hillshade), and if even that can't load, countries render over a flat
   land fill (`topojson.merge` of the atlas) — the gate never blocks on
   images.
2. **Vector overlay.** Every European country (same 50-ISO list as the
   retired flat picker) is drawn per frame with `d3.geoPath`: translucent
   grey-violet fill (`#6b5f82` @ 34%), black border over a pale casing.
   Hover = translucent **neon green** (`#39ff14`) + name label; micro-states
   (Malta, Monaco, Vatican…) get a ring marker when they'd be sub-pixel.
3. **Geometry sources.** `data/countries-50m.json` (local, instant) builds
   the gate; overseas territories are trimmed by polygon-centroid windows
   (France keeps metropolitan France, Russia draws fully but hands off only
   its European bbox). In the background the module then tries to stream the
   Natural Earth **10m** shapefile from the Supabase bucket
   (`.../Harti/ne_10m_admin_0_countries.shp`, matched to atlas countries by
   centroid containment) and swaps in the finer coastlines when it arrives —
   purely an enhancement, never a dependency.
4. **Interaction.** Pointer drag rotates (speed scaled by zoom), wheel and
   the on-screen +/− buttons zoom, two-finger pinch works on touch. The
   globe auto-spins slowly until the first interaction. Hover/click picking
   is exact point-in-polygon with a 12 px screen tolerance so micro-states
   stay clickable.
5. **Selecting a country.** A click flies the camera to the country
   (smoothstep rotation + zoom fitted to the country's angular size), then
   hands off to the existing Leaflet map exactly like before:
   `window._detectlabSelectedCountry` / `..Name` / `..Bounds` +
   the `_detectlabCountryLayer` shim (so `filterLayersForCountry()` in
   `js/map-app.js` keeps working unmodified), locking, and the
   `detectlab:country-selected` CustomEvent. The lock is deliberately tight —
   `maxBounds` = country bbox padded by 0.15° with viscosity 1, and the zoom
   floor one reachable step below the fitted zoom (Leaflet snaps zooms to whole
   levels; opening zoom capped at 11 for micro-states) — and **never replaces the
   3D globe base**: a selection only moves the camera. The `<html>` element gets `country-view-locked` and a
   `detectlab:country-lockchange` event fires, which is what the dock's
   "Exit view" button reacts to (COUNTRY_SELECTION_DOCK.md).
6. **Persistence & re-entry.** Unchanged: the `{iso, name, bbox}` selection
   is saved to `localStorage['detectlab_selected_country_v1']`, returning
   visitors skip the globe entirely, and the "Change Country" pill reopens
   it.
7. **Failure mode.** If d3/topojson/the atlas can't load at all, a plain
   `<select>` of countries (static name table, `APPROX_CENTER` bboxes)
   replaces the canvas so the gate never hard-locks the app.
8. **Search bar follows the selection.** Once a non-RO country is active,
   the map search bar serves that country's localities, streamed from the
   project's Supabase `europe-places.geojsonseq` (NDJSON/RFC 8142, filtered
   per country while streaming — only the selected country stays in memory).
   Romania keeps the richer `OSM.geojson` source (real counties + manual
   additions). See `osmPlaceLookup` / `europePlaceLookup` in `js/map-app.js`
   and `test-europe-places-search.js`.

## The country outline on the 3D basemap

The selected-country outline (and its highlight fill) is the one country-shaped
overlay on the working map that has to stay on the imagery. Leaflet places
vectors with Web Mercator, while the basemap is a true sphere, so a Mercator
outline drifted by tens of pixels when zoomed out (27 px on average for Denmark
viewed 8° off-centre at zoom 5) and moved as the globe was panned.

The fix keeps the basemap exactly as it was and changes where the outline's
vertices are placed:

- **Projected with the globe camera.** `DetectLabGlobeBase.createProjectedFeature`
  returns a Leaflet polygon whose vertices are `gl.project([lng, lat])` of the
  basemap's own MapLibre camera, plus the container's layer position. Longer
  edges are sampled every 1° along the sphere, longitudes are unwrapped across
  the antimeridian, holes are kept, and vertices on the far side of the globe
  are left out (perspective projection would fold them over the visible disc).
- **Simplified for speed.** Sampled rings are reduced with Douglas–Peucker to
  within 0.25 px on screen at the zoom they are shown at (cached per integer
  zoom). A large country such as Russia (7,245 raw vertices) drops to about
  4,000 rendered points. One update costs about 0.2 ms for Denmark and about
  5–6 ms for Russia on the software-rendered test machine.
- **Synced on every move.** The adapter's `move` handler was throttled to
  32 ms, so during a drag the globe camera could trail Leaflet's centre (up to
  about 20 px in a one-step-per-frame pan probe). `DetectLabGlobeBase.create`
  overrides `getEvents().move` so the camera is synced on each move. The
  outline re-projects on `move` and `resize`, and Leaflet's own renderer hooks
  re-project it on `viewreset`, `zoomend` and `moveend`. During a zoom animation
  the outline waits for the zoom end, as Leaflet's own paths do.
- **Fallback.** Without a live globe on the map (WebGL unavailable, or the
  globe removed), the outline and the bbox rectangle use Leaflet's own
  placement (`L.geoJSON` / `L.rectangle`), exactly as before.

Verified in headless Chromium with software WebGL. The harness imagery draws
the same atlas borders into its tiles, so the borders are a ground truth:

- **Against the imagery's own borders** (Denmark at zooms 3, 5 and 7, the
  border mask taken as the difference between the same view with and without
  border lines): the projected outline lies a median 0.4 px from the nearest
  border pixel (worst 1.4 px, no systematic offset beyond 0.2 px). The previous
  Mercator outline lay a median 0.7 px away at zooms 3 and 5 and 1.6 px at zoom
  7 (worst 8.8 px).
- **Against the globe camera's projection of every vertex** (this checks the
  Leaflet rendering and the simplification bound; the border check above is the
  independent one): the rendered outline is within 0.22 px at zooms 3–7 for
  Denmark and within 0.14 px for Denmark viewed off-centre at zoom 5. The
  Mercator placement was 27 px off on average (44 px worst) in that off-centre
  view.
- **Pan:** with the synced move the globe camera stays on Leaflet's centre
  (0 px) at every step. The throttled adapter trailed by up to 6 px in this
  environment.
- **Zoom:** during animated zooms the outline's bounding box stays within
  0.4 px of the rendered globe, against up to 4 px for the Mercator outline.
  Software WebGL captures only a few frames per animation, so this is a thin
  sample.

Node regression: `node test-globe-outline-projection.js`.

Raster country layers are moved onto the globe in phases. LIDAR layers get a
globe twin wherever their URLs convert exactly (see "LIDAR layers on the globe"
below). UAT tiles, hillshade, Copernicus VHR, historical maps and the other
country families are not wired yet and keep Leaflet's Web Mercator placement.

## Raster overlays on the globe: globe twins (phase 1)

Country rasters are Leaflet layers, so they drift off the globe the same way
the outline did. Phase 1 adds the mechanism that fixes this. No layer uses it
yet.

`DetectLabGlobeBase.attachTileTwin(tileLayer)` gives a Leaflet tile or WMS layer
a *twin*: a MapLibre raster overlay built from the same URLs, in the layer's own
pane, on the basemap's camera.

- **Ownership.** The Leaflet layer keeps add/remove, opacity, `setUrl` and
  `setParams`. Adding the layer attaches its twin, removing it removes the twin,
  and `setOpacity` is forwarded. While a twin is attached the Leaflet layer's own
  tiles are hidden and their requests return a 1x1 blank image, so nothing is
  downloaded twice.
- **Exact conversion only.** A URL template becomes a MapLibre source only when
  it reproduces Leaflet's own `getTileUrl` at sample tiles (0/0/0, 5/11/5 and
  140/90/8, restricted to zooms the layer can request). WMS must be EPSG:3857,
  and the twin requests `{bbox-epsg-3857}`. Quadkeys, `{-y}`, `{r}`, TMS, zoom
  offsets, non-256 tiles, `minNativeZoom` and WMS requests Leaflet would not make
  stay Leaflet layers. An error during conversion or GL creation also keeps
  Leaflet's own tiles.
- **Zoom limits.** The adapter drives the camera at Leaflet zoom minus one (a
  512 px world against Leaflet's 256 px tiles). Leaflet shows a layer while
  `Math.round(zoom)` is inside `[minZoom, maxZoom]`, which is camera zoom in
  `[minZoom - 1.5, maxZoom - 0.5)`. The node suite checks this against Leaflet's
  rule at every eighth of a zoom level.
- **Basemap flags.** Twins are created with `create(map, { overlay: true })` and
  carry `_detectlabGlobeOverlay`, not the basemap's `_detectlabGlobeBase`.
- **Two kinds of URL convert.** A template with `{z}`/`{x}`/`{y}` (or `{s}`) is
  used as it is. A URL with no such template converts when its only varying
  part is the tile's EPSG:3857 bbox: a WMS `BBOX`, or a service that puts the
  same four numbers in another parameter. The twin then requests
  `{bbox-epsg-3857}`. The bbox span is found from two sample tiles, and every
  sample must rebuild exactly. A URL with a second varying parameter, or a bbox
  in another axis order, stays a Leaflet layer.
- **Custom tile drawing is never converted.** A layer whose `createTile` is not
  Leaflet's own (canvas-drawn tiles, ArcGIS ImageServer grids) may request
  something other than its URL template, so it always stays a Leaflet layer.

Verified in headless Chromium with software WebGL. The truth is each vertex of
Denmark projected by the basemap camera (`gl.project`). The distance is from that
vertex to the nearest drawn pixel. An exact 1-px line measures about 0.5 px with
this method, so that is the floor.

| View | Twin, median / p90 / max (px) | Plain Leaflet (Mercator), median / max (px) |
|---|---|---|
| zoom 5, centred | 0.51 / 0.84 / 1.36 (97 % within 1 px) | 3.39 / 17.6 |
| zoom 3 | 0.46 / 0.76 / 1.19 | 0.81 / 3.8 |
| zoom 5, 8° off-centre (46, 20) | 0.51 / 0.93 / 4.3 | 13.3 / 39.5 |
| panned to (46, 20), no animation | 0.51 / 0.96 / 4.7 | 13.5 / 39.8 |
| animated zoom 3 to 5, after zoomend | 0.51 / 0.84 / 1.36 | 3.39 / 17.6 |
| animated zoom 5 to 3, after zoomend | 0.46 / 0.76 / 1.19 | 0.81 / 3.8 |

The twin's worst cases (4 to 5 px) are all north Jutland coast vertices in the
off-centre and pan views. They were not investigated further. For a zoom limit
check, a layer with `maxZoom: 6` and Denmark in view shows no pixels at zoom 7
and 859 at zoom 5. The same layer with the default `maxZoom: 9` shows 4,403 at
zoom 7.

What this does not cover yet:

- Only synthetic tile services were reachable from the sandbox, which allows
  GitHub, npm and PyPI only. Real national services need a device check.
- Mid-animation frames were not measured, only the state after `zoomend`.
- **WebGL contexts.** Each attached twin is one MapLibre instance with its own
  WebGL context. Browsers cap the number of live contexts (Chromium: 16), so a
  large family cannot simply get one twin per layer. Measure, and consider one
  shared canvas per pane, before wiring a large family.
- A layer-level `setZIndex` does not reorder its twin. The twin sits in the
  layer's pane.
- `setUrl(url, true)` and `setParams(params, true)` (no redraw) do not rebuild
  the twin until the next redraw.

Node regression: `node test-globe-raster-twin.js`. Browser harness: a plain
Leaflet page with the production basemap module, three overlays in separate
panes, and the truth taken from the basemap camera (kept outside the repo).

## LIDAR layers on the globe (phase 2)

`js/map-app.js` builds every LIDAR sub-layer through `_buildLidarLeafletLayer`.
Its three call sites now pass the result through `_lidarGlobeTwin`, which calls
`DetectLabGlobeBase.attachTileTwin`. A layer that converts gets a twin. Any
other layer comes back unchanged and keeps Leaflet's own tiles. The helper sits
in the same block as the builder, and an acorn parse confirmed that all three
call sites are in its scope.

Verified:

- `node test-globe-raster-twin.js`: conversion of XYZ, WMS and per-tile bbox
  URLs, refusal of the other cases, and the zoom limits.
- Browser, real Leaflet: a layer whose `getTileUrl` builds a per-tile EPSG:3857
  bbox (no URL template) converts. Its pixels match the WMS twin exactly, with a
  median of 0.51 px from the truth. Leaflet's own tiles in the same view would be
  about 3.4 px off.
- The full root suite is unchanged (the two failures that predate this work
  remain: `test-premium-subscription.js` needs `jsdom`, and
  `test-eu-domain-setup.mjs` asserts a DARE query that is not part of this work).

Coverage. These are expectations from the code, not runs against the live
services, which the sandbox cannot reach. Confirm each on a device.

| LIDAR source | How it is built | Expected |
|---|---|---|
| France, IGN free LIDAR | WMS 1.3.0, EPSG:3857 | converts |
| Generic LIDAR WMS / tile sub-layers | `L.tileLayer.wms` / `L.tileLayer` | converts when the URL is a template or EPSG:3857 WMS |
| UK, EA LIDAR | WMTS through an XYZ-style `L.TileLayer` | converts when the template is `{z}/{y}/{x}` |
| Switzerland, swisstopo relief | XYZ-style `L.TileLayer` | converts when the template is `{z}/{y}/{x}` |
| Poland, Geoportal NMT | `L.TileLayer`, bbox per tile | converts (map is EPSG:3857) |
| France, IGN MDT | `L.TileLayer`, bbox per tile | converts (map is EPSG:3857) |
| Sweden, Lantmäteriet height model | `L.TileLayer`, bbox per tile | converts (map is EPSG:3857) |
| Netherlands AHN | `L.GridLayer`, canvas `createTile` | stays Leaflet |
| Denmark DHM | `L.GridLayer`, canvas `createTile` | stays Leaflet |
| Norway Hoydedata | `L.GridLayer`, canvas `createTile` | stays Leaflet |
| ArcGIS ImageServer grids (AHN6, Spain) | custom grid layer with `createTile` | stays Leaflet |

Open points:

- **WebGL contexts.** Addressed: converted layers share one MapLibre overlay per
  pane (see "One overlay per pane"). Each pane with twins adds one context.
- Canvas-drawn services (the last four rows) are gated to zoom 11 (see "Zoom gate
  for canvas LIDAR"). Moving them onto the globe needs their pixels drawn into a
  MapLibre image source. That is separate work and is not started.
- A layer-level `setZIndex` does not reorder its twin, and `setUrl(url, true)`
  or `setParams(params, true)` do not rebuild it until the next redraw. The
  LIDAR code does not use either call.
- The LIDAR panes (`pane_lidar`) have `pointer-events: none`, so a twin in them
  cannot take clicks.

Remaining phases: (3) UAT tiles, Copernicus VHR and the historical and other country
families (the hillshade is done, see its section); (4) offline tiles, which need a cache-backed raster path because
MapLibre cannot read the blob-served tiles directly.

## Zoom gate for canvas LIDAR (phase 2b)

Four LIDAR sources draw their own tiles (a custom `createTile`): NL AHN, DK DHM,
NO Hoydedata and the ArcGIS ImageServer grids. They cannot become twins, so on the
live globe they stay on Leaflet's Web Mercator placement, which does not match the
globe basemap. The error is a property of the globe's geometry, not of the tiles.

Measured drift, Leaflet placement against the globe basemap, over the whole
viewport (1000 x 700 px, 25 px grid, median px / p90 / max). The harness measures
`gl.project` against `map.latLngToLayerPoint` for the same lat/lng. Its
Mercator control (globe projection replaced by Mercator) gives 0.3-0.7 px at every
zoom, which is the floor.

| Leaflet zoom | View 56N 10E | View 70N 20E | View 46N 20E |
|---|---|---|---|
| 3 | 124.6 / 294.6 / 394.4 | | |
| 5 | 35.8 / 81.9 / 133.3 | | |
| 7 | 9.2 / 20.7 / 35.9 | | |
| 8 | 4.7 / 10.8 / 18.6 | | |
| 9 | 2.3 / 5.2 / 9.2 | | |
| 10 | 1.16 / 2.56 / 4.76 | 1.38 / 2.89 / 5.08 | 1.07 / 2.34 / 4.77 |
| 11 | 0.70 / 1.39 / 2.71 | 0.70 / 1.35 / 2.41 | 0.56 / 1.11 / 2.29 |
| 12 | 0.47 / 0.73 / 1.28 | 0.61 / 1.07 / 1.52 | 0.45 / 0.81 / 1.34 |

Whole-country measures (a grid over Denmark only) gave a different picture: the
median rose to about 5 px at zoom 7. That grid included points far outside the
screen, and at high zoom they dominate. The viewport measure is the one that
matters, because it is what the user sees.

**Decision: canvas-drawn LIDAR sources are shown from Leaflet zoom 11.** It is the
first zoom at which the viewport median is 1 px or less at every latitude tested
(56N, 70N and 46N). Zoom 10 is 1.1 to 1.4 px. The user chose this rule (zoom in
more); it was checked against the measurements above.

How it is built (`js/map-app.js`):

- `LIDAR_CANVAS_MIN_ZOOM = 11`. `_lidarGlobeTwin` (all three LIDAR build paths)
  passes every layer through `_lidarApplyCanvasZoomGate`. The gate applies only to
  a layer with a custom `createTile`, and only while a live globe is on the map.
- The gate wraps `createTile`. Below zoom 11 a tile is an empty placeholder that
  is reported ready at once. Nothing is requested or drawn. Above it, the original
  `createTile` runs.
- **It does not use `options.minZoom`.** Leaflet registers every layer with a
  `minZoom` in its zoom bounds and raises the map to the smallest of them. In the
  browser harness, turning such a layer on at zoom 9 moved the map to zoom 11, and
  the map then could not zoom out below 11 while the layer was on. Do not set
  `minZoom` on these layers.
- `_updateLidarZoomGateMessage` shows `#lidarZoomGateMsg` (bottom centre, in
  `#detectlab-map`) while the master LIDAR switch is on, a canvas-drawn source is
  enabled, and the map is below zoom 11. It is refreshed on `zoomend`, on the master
  and sub-layer toggles, and after `setLang`.
- Text: the key `lidar_zoom_in_more` is in all 25 language tables in
  `js/translations.js`. It is English plus each country's language (for example
  Dutch for NL, Danish for DK, Norwegian for NO). The lookup uses
  `window._currentLang()`, with the global `currentLang` and English as fallbacks.

Verified:

- Browser, real Leaflet and the real `DetectLabGlobeBase` globe. The extracted
  gate code (`js/map-app.js`, checked with the source itself) ran in a harness
  (headless Chromium, SwiftShader). A canvas source on a live globe is gated and its
  `minZoom` is unchanged (0). A base-`createTile` layer is not gated and gets a
  twin. With no live globe nothing is gated. Enabling the source at zoom 9 keeps
  the map at 9, draws nothing, and shows the message. Zoom 11 draws 20 tiles and
  hides the message. Zooming out to 8 works and keeps the message. Disabling hides
  it. Languages en, ro, da, sr and de show their own text.
- `node test-lidar-canvas-zoom-gate.js`: the key in all 25 languages, the gate's
  shape (wraps `createTile`, no `minZoom`), the three build paths, the message
  hooks, and the shipped version. `node test-globe-raster-twin.js` and the full root
  suite are unchanged apart from the two failures that predate this work.

## One overlay per pane (GPU budget)

Each globe twin used to be a MapLibre instance of its own, with its own WebGL
context. Browsers allow only a few contexts, and phones fewer, and each costs GPU
memory. With several LIDAR sub-layers on, that meant several contexts.

Now every twin in a Leaflet pane is one raster source and one raster layer in that
pane's shared overlay, which is a single MapLibre globe with no basemap of its own
(`paneOverlayFor` / `addPaneTwin` in `js/globe-base-layer.js`). Its camera is the
adapter's, which follows the basemap camera, so each twin is placed as before.

- The overlay is created with the pane's first twin and removed with its last.
- Work added before the overlay's style has loaded is queued. A twin removed
  before then is never added.
- A redraw (a new URL) adds the new twin before it removes the old one, so the pane
  overlay is reused rather than rebuilt.
- Opacity belongs to each twin (`raster-opacity` on its own layer).
- A style that refuses a twin leaves Leaflet's own tiles on screen, and the overlay
  that was opened for it is closed again.

Contexts: one per pane that has twins, plus the basemap. For the LIDAR set that is
two in total (the basemap and `pane_lidar`), however many converted sub-layers are on.

Verified:

- `node test-globe-raster-twin.js`: two twins in a pane share one instance, and
  both sources and layers sit in it. Later twins draw above earlier ones. A twin in
  another pane gets an instance of its own. Removing one twin keeps the instance
  and the other twin. Removing the last closes the instance. Queued work runs when
  `style.load` fires, and cancelled work does not run. Opacity is per twin. A
  refused twin falls back to Leaflet tiles. Redraw reuses the instance.
- Browser, real MapLibre and Leaflet, headless Chromium with SwiftShader, and a
  synthetic tile route (solid colours on one half of the world). Two twins in
  `pane_lidar` at zoom 5: one overlay in the pane. The west side is red and the
  east side blue, and at zoom 4 after a pan they are still red and blue at the
  same geography. Half opacity blends the red. A redraw to green keeps the same
  overlay. Removing one twin leaves the other. Removing the last closes the
  overlay. A twin in `pane_other` gets its own. The red/blue edge is the meridian
  lng 0, within half a pixel of the basemap's projection.

Open points:

- Each pane still has its own instance. If more panes take twins, each adds one
  context. Keep the number of panes with twins small.
- Canvas-drawn sources are not twins and do not use an overlay. They stay on Leaflet
  tiles behind the zoom gate.

## Phase 3, first family: the world hillshade

The world hillshade (`js/country-dock.js`, `ensureHillshadeLayer`, pane
`pane_world_hillshade`, z 400) is a plain `L.tileLayer` on the Esri hillshade XYZ
template. It is attached as a globe twin right after it is created, and only when
`DetectLabGlobeBase` is present. Its twin lives in the pane's shared overlay.

Checked in the browser with the real URL and options: the twin converts, its source
keeps the `{z}/{y}/{x}` template with a native maximum of 16, its opacity is 0.5,
Leaflet's own tiles are hidden, and the template holds after a pan and zoom to 12.
`test-country-dock.js` pins the wiring.

Remaining phase 3 families: UAT (`pane_uat`), Copernicus VHR (`map-app.js`, the
EEA ArcGIS tiles), the historical and other country families (`map-app.js`, the
`historical-eu-maps.js` catalogue, `corona-wms-layer.js`, `library-of-babel.js`).
`map-app.js` has 32 `L.tileLayer` and WMS sites. Each family needs its URLs checked
for conversion, and any canvas-drawn source gets the zoom gate, not a twin.



- `sw.js` (cache `v178`) precaches the country picker, local MapLibre runtime /
  Leaflet binding, globe-base module, d3, topojson-client, the atlas and the
  country dock. The two canvas-gate texture images are intentionally **not**
  precached (≈1.8 MB; the texture-less gate fallback still works offline).
- Suites guard this area: `node test-globe-canvas-picker.js` (canvas gate,
  picking, geometry), `node test-globe-base-layer.js` (MapLibre globe source,
  Leaflet adapter, opacity and PWA wiring) and `node test-country-dock.js`
  (country list API, lock maths, dock UI, hillshade, exit view).
- Country name → ISO resolution uses the bundled EN/RO name dictionary
  (`NAMES`, incl. `alt` spellings such as "Bosnia and Herz.", "Macedonia",
  "Vatican" used by world-atlas). `test-globe-canvas-picker.js` asserts all
  50 countries resolve from the shipped atlas and that picking works — run
  `node test-globe-canvas-picker.js` after touching any of this.
- The module exposes `window.DetectLabGlobeGate` with the same API as
  before (`attach/open/close/hasSelection/reset/getSelection`), plus the
  country-switching / lock API the dock builds on
  (`listCountries/nameOf/selectCountry/prefetch/isLocked/getLockZoom/unlock/exitView`)
  and a `_test` hook for the node suites.
