# Country dock — search-bar country switcher, World hillshade & “Exit view”

## What changed

Selecting a country on the globe used to be a pure hand-off: the Leaflet map
was fitted to the country with a loose `maxBounds` and the only way back to
another country was the “Change Country” pill. Now the choice *owns* the map:

- **The view is locked to the country.** After the temporary 3D gate zooms to
  the clicked country, the gate cross-fades into the working map's flat 2D
  Leaflet/Web-Mercator basemap. The same World Imagery tiles are used on both
  surfaces, so the hand-off has no unrelated basemap flash. Panning is then
  clamped to the country box (`maxBoundsViscosity: 1`) and the zoom floor sits
  just under the fitted zoom, so the user cannot wander off.
- **A country dock is glued under the search bar** (inside `#mapSearchWrap`,
  so it shares the bar's anchor point and hidden/visible state). It shows the
  current 2-letter code and drops open the full list of country initials;
  hovering (or focusing) an initial prints the full country name, clicking it
  moves and re-locks the map to that country — no globe needed.
- **A small “World hillshade” checkbox** lays the Esri World Hillshade tiles
  (30 m terrain shading) over the flat 2D basemap and any selected historical
  imagery overlay.
- **“Exit view”** appears centred in the lower part of the screen once the
  locked country view is zoomed all the way out. It releases the lock, pulls
  back to the European overview and reopens the globe, so leaving a country
  view always means choosing the next one.

## Files

- `js/country-dock.js` — the whole UI: initials grid, hover names, hillshade
  overlay, exit-view button. Talks to the globe only through
  `window.DetectLabGlobeGate`.
- `css/country-dock.css` — dock strip, slide-down panel, initials cells,
  the compact checkbox and the exit pill.
- `js/globe-country-picker.js` — new country-switching / lock API:
  `listCountries()`, `nameOf(iso)`, `selectCountry(iso)`, `prefetch()`,
  `isLocked()`, `unlock()`, `exitView()`, plus the tightened
  `restrictLeafletToCountry()` and the `detectlab:country-lockchange` event.
- `js/map-app.js` — `window.DetectLabCountryDock.attach(map)` right after the
  globe gate, `window.unfilterLayersForCountry()` (the layer-coverage dimming
  belongs to the locked view only), and the flat ArcGIS Web-Mercator basemap
  stack used by the working map.
- `js/globe-arcgis-gate.js` plus `js/globe-country-picker.js` — the temporary
  3D selection surface and canvas fallback. Both stage the Leaflet 2D camera
  before the gate fades away; the working map remains the source of truth after
  the hand-off.
- `index.html` — the dock markup (inside `#mapSearchWrap`), the exit-view
  button (inside `.map-frame`), the CSS/JS tags.
- `js/translations.js` — `country_dock_title`, `country_dock_hint`,
  `country_dock_hillshade`, `country_exit_view` (EN + RO).
- `sw.js` — shell `v187`, precaches the dock, the local ArcGIS gate adapter,
  and the canvas fallback assets (not the remote ArcGIS SDK).
- `tools/country-dock-preview.html` — dev harness: the dock on a real Leaflet
  map with Esri imagery, no auth, no rest of the app.
- `test-country-dock.js` — the regression suite.

## How it works

### 1. The lock

`restrictLeafletToCountry(map, bbox)` (gate module) now:

- remembers the map's *own* `minZoom`/`maxZoom` once (`state.baseMinZoom` /
  `baseMaxZoom`), so switching country after country can never ratchet the
  zoom floor upwards;
- computes the opening zoom as `min(FIT_MAX_ZOOM = 11, boundsZoom(country
  box, 2 × FIT_PADDING))`, measured inside the map's *base* zoom range, clamped
  to that baseline — micro-states (Monaco, Vatican, San Marino) open on a sane
  local view instead of a single street, and switching country after country
  neither inherits the previous lock's zoom floor nor mis-measures the fit
  (Leaflet's `fitBounds()` frees `FIT_PADDING` on each side, i.e. counts a
  symmetric padding twice). It is the *same* call (`countryFitZoom` +
  `countryHandoffFrame`) that the 3D globe camera is flown to, so the two
  surfaces meet on one zoom (see `GLOBE_COUNTRY_GATE.md` → “One hand-off frame”
  and “A lock never leaks its zoom floor into the next country”);
- applies `maxBounds = country bbox padded by LOCK_PAD (0.15°)` with
  `maxBoundsViscosity = 1` (a drag past the edge snaps straight back);
- sets `minZoom = fitZoom − LOCK_ZOOM_SLACK (1)` and `fitBounds(...,
  { padding: [24, 24], maxZoom: fitZoom })`. The floor is a **full zoom level**
  below the fit on purpose: Leaflet snaps zooms to whole levels
  (`zoomSnap: 1`, untouched by this app), so a fractional floor would simply be
  unreachable and the zoom-out that reveals “Exit view” could never happen;
- adds `country-view-locked` to `<html>` and fires
  `detectlab:country-lockchange` (`{locked, iso, bbox, fitZoom}`).

`unlockCountryView()` reverses all of it (`setMaxBounds(null)`, baseline zoom
range, `unfilterLayersForCountry()`, class removed, event fired).

### 2. Switching country without the globe

The dock calls `DetectLabGlobeGate.selectCountry(iso)`, which warms the local
atlas (`ensureReady()`), takes the country's `bboxEU` — or `approxBbox(iso)`
built from the static `APPROX_CENTER` table when the geometry is unavailable —
and then runs the *same* path as a globe pick: `persistSelection` →
`applySelection` (lock + `filterLayersForCountry`) → the
`detectlab:country-selected` event. A dock switch starts directly on the normal
flat 2D working-map path; it does not reopen or animate the 3D gate. Search
sources and layer filtering therefore follow a dock switch exactly like they
follow a globe pick. `prefetch()` is fired after any selection so the next
switch is instant.

### 3. The dock UI

- It lives inside `#mapSearchWrap`, so it inherits the search bar's centring,
  width and the `auth-hidden` reveal that already hides the bar until a country
  is active. CSS shows it only with `body.country-selected`.
- `html.globe-gate-open` (set/cleared by the gate while the globe is on screen)
  hides both the dock and the exit pill — inside the globe the “Change Country”
  pill is the right affordance.
- A `MutationObserver` on `#mapSearchResults` adds `dock-suppressed` while the
  search autocomplete is open, so the two never overlap.
- The initials grid is rebuilt from `listCountries()` on every open, on
  `detectlab:country-selected` and on `detectlab:langchange` (the names follow
  the UI language). Hover/focus prints the name into the panel footer *and*
  sets the native `title`, so both mouse and touch/keyboard users get it.
- Clicking a cell sets `is-busy` until the promise resolves (geometry load),
  then closes the panel and refreshes the chip.

### 4. World hillshade

- `https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}`
  at `opacity: 0.5`, `maxNativeZoom: 16` (the fused dataset ends there; Leaflet
  overzooms instead of asking for empty placeholders).
- Its own pane `pane_world_hillshade` at `z-index 400`: created at runtime, so
  it is the *last* child at basemap level — it paints directly above the
  satellite / Copernicus mosaics and below every data pane (OSM places 401,
  UAT 402, LIDAR 610, historical maps 640+…). The basemap layers are never
  touched.
- Created lazily on the first tick (no tile requests for users who never enable
  it) and remembered in `localStorage['detectlab_world_hillshade_v1']`, so the
  overlay comes back on the next visit. `arcgisonline.com` is a
  `PASSTHROUGH_HOST` in `sw.js`, so those tiles stay network-only.
- `window.toggleWorldHillshade(on)` / `DetectLabCountryDock.toggleHillshade()`
  drive it programmatically, and the small ⓘ next to the checkbox opens the
  attribution popup (`showLayerInfo` → “© Esri, USGS, NOAA — 30 m terrain
  shading”), since the app hides Leaflet's own attribution control.

### 5. “Exit view”

Visible only when `isLocked()` **and** the map sits on the *reachable* zoom
floor — `reachableFloor()` rounds `minZoom` up to the next `zoomSnap` step, so
a 5.65 floor counts as 6 — **and** the user actually asked to zoom out since the
country was locked. Two signals count as “asked”: a `zoomend` that lowered the
zoom, and a map-container `wheel` with `deltaY > 0` (countries like Russia whose
floor equals the map's own minimum cannot zoom out at all, so Leaflet swallows
the gesture and no `zoomend` ever fires). The pill therefore never shows on the
freshly fitted view. Clicking it calls
`DetectLabGlobeGate.exitView()`: unlock → `setView([48.5, 14], max(baseMinZoom,
4))` → `openGate()`. If the user then closes the globe with ✕ they keep a free
map with the previous country's layers intact (nothing was forgotten — only the
lock was released).

## Notes for future changes

- Run `node test-country-dock.js` and `node test-globe-arcgis-gate.js` after
  touching the country flow; `node test-globe-canvas-picker.js` continues to
  guard the no-WebGL fallback. The dock suite covers the initials grid, hover
  names, switch call, the hand-off frame (`countryHandoffFrame` / `fitZoom`),
  hillshade layer (single instance, own pane, persistence) and every
  exit-button transition.
- The dock's UI is intentionally free of `querySelectorAll`: it keeps an
  `iso → element` map (`_test.state.buttons`) so the headless suite can drive
  it with the same minimal DOM stub the other suites use.
- Versioning: bump the `?v=` query of a changed local asset in `index.html`
  **and** the matching `sw.js` precache entry together, then raise
  `CACHE_NAME` (currently `detectlab-v189-country-handoff-zoom`). The SDK/theme CDN stays
  lazy and is not an app-shell precache entry.
- Manual QA: `python3 -m http.server` at the repo root, open
  `/tools/country-dock-preview.html`; the overlay status line reports the lock,
  the zoom floor and the hillshade state while you click through.
