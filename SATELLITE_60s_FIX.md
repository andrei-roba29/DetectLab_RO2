# Satellite Imagery 60's — faithful replica of the Corona Atlas, for all of Europe

**Status: 2026-10-06.** The layer no longer uses a hand-written list of nine
Romanian CORONA layers. It now replicates the *whole* raster logic of the
original [Corona Atlas](https://corona.cast.uark.edu/atlas) (CAST, University
of Arkansas) — catalogue-driven product selection, pass mosaics vs. individual
frames, footprint-intersection + zoom-band gating — over the **entire
European window** `[-25, 34] → [60, 72]` (Iceland/Azores edge to the Urals,
Crete to Svalbard). A second overlay draws the **coverage outlines** from the
supplied KML so users can see where 1960s imagery actually exists.

Previous notes about the Romania-only list are kept in §7 (history) because
they document a real trap: CORONA layer names cannot be guessed.

---

## 1. How the original atlas really works

The atlas is an OpenLayers app. Its raster logic lives in
`https://corona.cast.uark.edu/assets/libraries/custom/maputils.js?v=1.6.1`,
and it is short enough to transcribe:

```js
var tileGrid = new ol.tilegrid.TileGrid({
  origin: [-20037508.34, -20037508.34],
  resolutions: [156543.0339, 78271.51695, …, 1.1943285667419434]  // z0 … z17
});

rasterSettings = {
  baseUrl: "https://geoserve.cast.uark.edu/geoserver/gwc/service/wms",
  projection: "EPSG:900913", serverType: "geoserver", workspace: "corona:",
  version: "1.1.1", tiled: "true",
  layerSettings: {
    layerGroup: { minZoom: 8,  maxZoom: 11 },   // pass mosaics
    layer:      { minZoom: 12, maxZoom: 20 }    // individual frames
  },
  tileGrid: tileGrid
};

$(document).ready(function () { mapInit(); … getRasterNames(); loadSites(); });

function getRasterNames() {                      // once, on page load
  $.ajax({ url: '/corona/get_raster_names', dataType: 'json',
           success: function (resp) { initializeRasterManager(resp); } });
}
```

So the three mechanisms are:

1. **A catalogue, fetched once.** `/corona/get_raster_names` returns the whole
   worldwide archive as an object keyed by pass name:

   ```jsonc
   "1006-1025Aft": {
     "label": "1006-1025Aft (Jun 05, 1964)",
     "base": "1006-1025da",
     "show_on_load": "yes",
     "location": "1006-1025Aft",                     // ⇒ WMS layer corona:1006-1025Aft
     "extent": { "minx": 26.44, "miny": 40.40, "maxx": 29.35, "maxy": 41.15 },
     "polygon": "{\"type\": \"Polygon\", \"coordinates\": [[…]]}",  // JSON *string*
     "images": [{
       "label": "1006-1025A120",
       "location": "1006-1025da120",                 // ⇒ corona:1006-1025da120
       "ftp": "1006-1025d/1006-1025da/ds1006-1025da120.ntf",
       "size_ntf": "877", "size_tif": "370",
       "extent": { … }, "polygon": "{…}"
     }]
   }
   ```

   The product name sent to GeoServer is the **`location`** field, never the
   label — this is exactly what the old implementation got wrong.

2. **Selection = footprint ∩ viewport, inside a zoom band.** Every `moveend`
   calls `rasterManager.zoomChanged()` → `rasterLayer.checkZoom()`, which sets
   a product visible iff its parsed `polygon` intersects the view extent *and*
   the current zoom is inside its band (8–11 for the pass mosaic, 12–20 for
   the frames). The polygons are rotated strips, so the bbox test alone is far
   too generous — the atlas tests the polygon.

3. **Plain WMS-C tile fetching.** One GeoWebCache request per product:

   ```
   https://geoserve.cast.uark.edu/geoserver/gwc/service/wms
     ?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap
     &FORMAT=image%2Fpng&TRANSPARENT=true
     &LAYERS=corona%3A<location>          ← single layer, never a list
     &tiled=true&WIDTH=256&HEIGHT=256
     &SRS=EPSG%3A900913&STYLES=
     &BBOX=<minx>,<miny>,<maxx>,<maxy>    ← EPSG:900913 metres, standard XYZ grid
   ```

   The grid has 18 levels (z0 … z17) ⇒ `maxNativeZoom: 17`; above that the
   viewer overzooms, as DetectLab now does too.

Downloads (GeoTIFF `…/coronaftp2/<ftp>.tif`, NITF `…/coronaftp/<ftp>.ntf`) are
a separate feature of the atlas and remain out of scope.

---

## 2. The one thing that cannot be copied verbatim: the catalogue request

`corona.cast.uark.edu/corona/get_raster_names` **sends no CORS header** and
answers with ~6 MB of worldwide coverage. A browser `fetch()` from
detectlab.ro fails on the preflight-less cross-origin read, and even if it did
not, 6 MB on every page load is unacceptable on mobile.

The catalogue is therefore fetched **server-side**, clipped to a bbox and
slimmed down. Three sources are tried in order (`CoronaAtlas.catalogSources()`):

| # | Source | Why |
|---|---|---|
| 1 | `window.CORONA_CATALOG_URL` | escape hatch / self-hosting |
| 2 | `data/corona-europe-catalog.json` | static snapshot: same-origin, CDN-cached, works offline in the PWA, zero function invocations |
| 3 | `/api/corona/rasters?bbox=…` | live proxy (Netlify function) — always current, used if the snapshot is absent |
| 4 | `CoronaAtlas.FALLBACK_BLOCKS` | the six verified Romanian passes, so the layer is never completely dead |

Nothing in the shipped client code ever calls `corona.cast.uark.edu`
directly (pinned by `test-sat60-layers.js`).

**Slimming** (`netlify/lib/corona-catalog.mjs → slimCatalog`): drop every pass
whose footprint misses the bbox, drop the labels/sizes the map does not use,
parse the `polygon` strings into plain ring arrays and round coordinates to
5 decimals (~1 m). Europe comes out ≈20× smaller than the raw payload.

---

## 3. What DetectLab now does

### `js/corona-wms-layer.js`

| Export | Role |
|---|---|
| `coronaWmsTileUrl(base, layer, z, x, y)` | byte-identical WMS-C URL builder (pure; the tests compare it against the atlas's captured traffic) |
| `CoronaWmsLayer` / `createCoronaWmsLayer()` | `L.TileLayer.WMS` subclass emitting that URL, `maxNativeZoom: 17` |
| `CoronaAtlas.WMS_URL`, `.WORKSPACE`, `.EUROPE_BBOX` | the atlas's own constants |
| `CoronaAtlas.PASS_MIN_ZOOM 8` / `PASS_MAX_ZOOM 11` / `FRAME_MIN_ZOOM 12` / `FRAME_MAX_ZOOM 20` | the two zoom bands, verbatim from `maputils.js` |
| `CoronaAtlas.loadCatalog({bbox})` | the source chain above, with `normalizeCatalog()` accepting both the raw CAST shape and the slim snapshot |
| `CoronaAtlas.createManager(map, opts)` | the replica of `rasterManager` |

`createManager()` is the heart of it:

- `selectProducts(bounds, zoom)` — pure function: zoom band → candidate kind
  (pass mosaic or frame), then `ringsIntersectBbox()` against the padded view
  bbox. Rotated strips are handled with a real polygon test (edge
  intersection + point-in-ring), not a bbox test.
- `update()` — attaches what was selected, detaches the rest. Tile layers are
  created **lazily**, keyed by `location`, and `_evictUnused(60)` discards
  layers that have been off-screen for a while, so panning across Europe does
  not accumulate hundreds of Leaflet layers.
- Caps: `maxActivePasses`, `maxActiveFrames` — a hard ceiling on how much can
  be attached at once, nearest-to-centre first.
- `setOpacity()`, `getActiveLayers()`, `clear()`.

### `js/map-app.js` (Sat60 block)

- Own pane `pane_sat60` (z-index 648), opacity `0.85`.
- Manager options, tuned per device by `_sat60IsLowPowerDevice()`
  (`L.Browser.mobile` + coarse pointer + `navigator.deviceMemory <= 4`,
  override `window.SAT60_LOW_POWER_TILES`):

  | option | low power | desktop |
  |---|---|---|
  | `viewportPad` | 0.2 | 0.35 |
  | `maxActivePasses` | 8 | 18 |
  | `maxActiveFrames` | 10 | 24 |
  | `keepBuffer` | 1 | 2 |

  plus `updateWhenZooming: false`, `updateWhenIdle: true` on every tile layer.
- `map.on("moveend zoomend")` → `manager.update()` — never during a gesture.
- Globals: `toggleSatellite60sMap(on)`, `setSatellite60sMapOpacity(v)`,
  `toggleSatellite60sCoverage(on)`, `window._sat60Layers`,
  `window._sat60ActiveProducts`, `window._sat60Catalog`.
- The premium red coverage rectangle for this layer now spans Europe and
  hides from z8 (`coverageMinZoom: 8`), where real tiles begin.

### Server side

| File | Role |
|---|---|
| `netlify/lib/corona-catalog.mjs` | `fetchCoronaCatalog()`, `slimCatalog()`, `buildCatalogPayload()`, `parseBbox()`, geometry helpers. Deliberately **outside** `netlify/functions/`, which treats every subdirectory as a function. |
| `netlify/functions/corona-rasters.mjs` | `GET /api/corona/rasters?bbox=…`. 12 h warm-container memory cache, `Cache-Control: max-age=3600`, `Netlify-CDN-Cache-Control: s-maxage=604800, stale-while-revalidate=86400`, serves stale on upstream failure, CORS `*`. |
| `netlify.toml` | functions directory + the `/api/corona/rasters` redirect. |
| `tools/build-corona-europe-catalog.mjs` | regenerates the static snapshot: `node tools/build-corona-europe-catalog.mjs [--bbox=…] [--out=…]` (Node ≥ 18, no npm deps). Run it from a machine with plain internet access to CAST and commit the result. |

---

## 4. Coverage outlines (the KML)

`js/corona-coverage-layer.js` draws
`https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/corona2.kml`
(CORS-enabled, 666 KB, CDN-cached) as a thin amber outline with a 7 % fill, in
its own pane on a canvas renderer, non-interactive so it never steals clicks.

- **Lazy** — nothing is downloaded until the outlines are shown for the first
  time; the parsed rings are then reused.
- **Clipped** — the KML is a dissolved worldwide multipolygon (including polar
  passes); only rings intersecting `CoronaAtlas.EUROPE_BBOX` are kept.
- **Simplified** — the shapefile was buffered, so each corner carries ~16
  near-identical vertices; a distance filter (`SIMPLIFY_EPS` 0.001° ≈ 110 m)
  removes them with no visible difference.
- `window.CoronaCoverage`: `load()`, `show(map)`, `hide()`, `isVisible()`,
  `parseKml(text, bbox)`, `simplifyRing()`, `getLayer()`, `getRings()`.
  Override the URL with `window.CORONA_COVERAGE_KML_URL`.

UI: turning *Satellite imagery 60's* on also shows the outlines; a dedicated
switch (`#satellite60sCoverageToggle`, label key `layer_sat60_coverage`,
translated in all 25 languages) turns them off for users who only want the
imagery. The KML is **coverage only** — it has no per-pass names and can never
be used as a product catalogue.

---

## 5. Tests

```bash
node test-sat60-fetch.js          # 63 checks — request format, zoom constants
node test-sat60-layers.js         # 50 checks — catalogue handling, product names
node test-sat60-mobile-crash.js   # 51 checks — gesture volume limits
node test-sat60-live-location.js  # 44 checks — CORONA × live location on Android
node test-corona-europe.js        # 43 checks — catalogue proxy + coverage KML
node test-tile-perf.js            # 83 checks — shared tile-performance budget
```

> **2026-10-30 — Android "whole map turns green / twitches between zoom levels"
> with live location on:** the CORONA stack now renders inside ONE composited
> surface (the pane carries the opacity), has no dead zoom band between z11 and
> z12, runs one manager update per gesture and backs off while the tile
> governor is in conservation mode. See **SATELLITE_60s_LIVE_LOCATION.md**.

What each one pins:

- **`test-sat60-fetch.js`** — the generated URL is byte-identical to the
  atlas's captured traffic (parameter names, order, encoding), the BBOX is the
  standard EPSG:900913 tile grid (same z15 tile `x=19312, y=13536` as a 2020
  Wayback capture), exactly one layer per request, and `map-app.js` drives the
  manager instead of a hardcoded list.
- **`test-sat60-layers.js`** — the ten guessed/wrong-continent names
  (`corona:1107-1074Fore`, `corona:1110-2289Aft`, …) can never reappear in
  executable code; `normalizeCatalog()` is exercised on a verbatim 4-record
  CAST fixture (the Chinese and Kazakh passes must be clipped out, the
  Marmara and Moscow ones kept); zoom gating z6/z9/z11/z13/z21; the rotated
  strip must beat a bbox test; the catalogue source order must stay CORS-safe.
- **`test-sat60-mobile-crash.js`** — the four mitigations below, the
  `moveend zoomend`-only sync, the caps, `_evictUnused`, `maxNativeZoom: 17`,
  the `tileerror` hide-and-log-once handler, plus a simulated pan/zoom gesture
  across a synthetic European catalogue.
- **`test-corona-europe.js`** — the slimming/clipping/rounding of the proxy,
  `parseBbox` normalisation, the function route + caching headers +
  stale-on-error, the `netlify.toml` redirect, KML parsing/clipping/
  simplification, and the UI wiring (script order, toggle, translations,
  service-worker precache).

---

## 6. Mobile crash on fast zoom (still fixed)

The earlier crash (fast pinch-zoom killing the tab on mobile, including in
"Desktop site" mode) came from tile volume, not from the request format. The
four mitigations are unchanged and now apply to a manager that can see the
whole continent, which makes them more important, not less:

1. `updateWhenZooming: false` — zoom frames are pure CSS transforms; tiles
   load once, at the end of the gesture.
2. `updateWhenIdle: true` — set explicitly, so a spoofed desktop UA cannot
   opt a phone into per-frame pan updates.
3. `keepBuffer: 1` on low-power devices (desktop keeps Leaflet's `2`).
4. Attach/detach on `moveend zoomend` only, padded by `viewportPad`, with the
   `maxActivePasses` / `maxActiveFrames` ceilings and `_evictUnused()` on top.

Typical z13 view: ~3 attached products × 15 tiles ≈ 45 live tiles.

---

## 7. History — why layer names must come from the catalogue

The first implementation guessed CORONA layer names from the naming pattern.
Verified live against `geoserve.cast.uark.edu`:

| Old entry | Reality on the server |
|---|---|
| `corona:1107-1074Fore`, `corona:1103-2155Fore`, `corona:1110-2289Aft`, `corona:1103-2139Aft`, `corona:1106-1042Aft`, `corona:1105-2235Aft` | **do not exist** → `400 Unknown layer` |
| `corona:1107-1074Aft` | exists, but images **Greece** |
| `corona:1110-2289Fore` | exists, but images **Peru** |
| `corona:1105-2235Fore` | exists, but images the **Middle East** |
| `corona:1103-2167df101` | exists, but images **China** |

Those names are now banned by `test-sat60-layers.js`. The six passes that were
verified by hand (`1104-2155Fore`, `1104-2155Aft`, `1036-2139Fore`,
`1103-1058Aft`, `1103-1058Fore`, `1026-2088Aft`) survive only as
`CoronaAtlas.FALLBACK_BLOCKS`, used when every catalogue source fails.

Also removed earlier and **not** reintroduced: the "Load images here" button,
the client-side request queue, the IndexedDB tile cache, viewport probes and
manual zoom-gated loading. The original atlas has none of them, and neither
does DetectLab now.

---

## 8. Operating notes

- **Refreshing the snapshot:** run `tools/build-corona-europe-catalog.mjs` and
  commit `data/corona-europe-catalog.json`. Without the snapshot the layer
  silently falls back to the live proxy; without both, to the six passes.
- **Coverage gaps are real.** Even continent-wide, CORONA covers Europe in
  strips: the archive is the *"Corona Atlas of the Middle East"* extended with
  other declassified missions. Empty areas are a property of the source — the
  coverage outlines exist precisely to make that obvious.
- **Cache busting:** `index.html` loads
  `js/map-app.js?v=20261006-corona-europe`, `js/corona-wms-layer.js` and
  `js/corona-coverage-layer.js` at `?v=20261006-europe`; `sw.js` is
  `detectlab-v154-corona-europe` and precaches all three.

---

## 9. 2026-10-08 — honest coverage, Europe-wide, like the atlas

Two user-visible bugs were fixed together (`detectlab-v166-corona-coverage`):

1. **"One big semi-transparent red rectangle over all of Europe."** Two
   compounding causes:
   - the premium coverage-rectangle system drew the satellite60s entry as a
     red dashed rectangle over its bounds — which, since the Europe-wide
     catalogue, is the whole continent. A Europe-wide rectangle reads as
     "imagery everywhere", which is false for a strip archive. The entry now
     carries `noCoverageRect: true` and the rectangle factory skips it; the
     bounds stay for the layer-row visibility highlight.
   - `corona2.kml` (the buffered union of the worldwide coverage shapefile)
     contains a degenerate ring that walks the antimeridian around the whole
     planet. Its bbox intersects every bbox, so it survived the Europe clip
     and rendered as a map-wide sheet. `parseKml()` now drops any ring whose
     bbox spans more than `MAX_RING_SPAN_DEG` (20°) — a real CORONA pass
     strip spans a few degrees, never a continent.

2. **"Works only for Romania."** The coverage outlines are no longer parsed
   from the KML at all in the normal path: `CoronaCoverage.load()` now draws
   the footprint polygons of the **imagery catalogue itself**
   (`CoronaAtlas.loadCatalog()` — the same `/corona/get_raster_names`
   footprints the original atlas renders as its vector layer and uses in
   `rasterLayer.checkZoom()`). Outlines and tiles can no longer disagree: a
   strip is drawn exactly where a GetMap request can answer, for all ~95
   European passes. The KML remains only as a fallback when every catalogue
   source fails. In addition, `netlify.toml` gained a `[build]` command that
   bakes `data/corona-europe-catalog.json` fresh on every deploy (guarded by
   `|| true`), so the first catalogue source is a same-origin, CDN-cached
   static file and the layer no longer depends on the runtime proxy being up.
   The snapshot is a build artefact and is gitignored.

Covered by `test-corona-europe.js` sections B–B5 (giant-ring filter,
catalogue-first outlines, KML fallback, red-rectangle opt-out, deploy-time
snapshot). Shell: `index.html` loads `js/corona-coverage-layer.js` and
`js/map-app.js` at `?v=20261008-corona-coverage`; `sw.js` is
`detectlab-v166-corona-coverage`.

**2026-10-29 follow-up — zooming with these layers glitches the screen /
empties the panel.** Two more mitigations now sit on top of the four above,
because the tab-crash fix did not cover the compositor: (5) `js/tile-perf.js`
toggles `body.map-gesturing` for the duration of every map gesture, which
drops all `backdrop-filters` (see `MAP_LAYER_PERFORMANCE.md` §6 /
`LAYER_WINDOW_GLASS.md` §6) — the per-frame re-blur of ~30 glass surfaces over
the animating Sat60/WMS panes was the Android GPU spike; (6) `checkLayerVisibility`
fails open on an unusable (NaN / method-less) viewport instead of hiding every
row, which is what left the layer panel "transparent with no layers inside".
Shell `detectlab-v295-android-zoom-glass`.
