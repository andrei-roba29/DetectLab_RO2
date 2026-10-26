# 3D terrain view (2D ⇄ 3D) — how it works, what is served, how to extend it

*Added in `js/layer-registry.js`, `js/map3d-terrain.js`, `js/lidar-3d-focus.js`,
`css/map3d-terrain.css`, `netlify/lib/map3d-tile.mjs`,
`netlify/lib/map3d-country-modules.mjs`, `netlify/functions/map3d-tile.mjs`,
`tools/map3d-dev-server.mjs`; wired in `index.html`, `sw.js`, `netlify.toml` and consumed by
`js/map-app.js` / `js/historical-eu-maps.js`. Regression suites:
`node test-map3d-terrain.js`, `node test-map3d-mobile.js`, `node test-lidar-3d-focus.js`,
`node test-search-exit-3d.js`.*

**Status: all 91 registry layers are drapeable.** Nothing is left behind in 2D: the
nine country LiDAR layers whose URL builders need a real tile bbox are draped tile by
tile through the `dl3d://` protocol described in §2, and the ones whose hosts lack CORS
take the same route through the tile proxy.

## 1. What it is, and how to open it

The Leaflet map keeps working exactly as before. A **“3D” button** (bottom-centre of
the map, added by `js/map3d-terrain.js`) switches to a second renderer of the **same**
map: a MapLibre GL JS view in which every layer that is switched on in the 2D panel is
**draped over real elevation** (a raster DEM). Nothing about the 2D view changed — the
3D surface is simply drawn on top of it, and closing 3D removes it again.

* **Toggle** – the “3D” button, or `window.DetectLabMap3D.toggle()`. With a **LiDAR**
  layer switched on, the button first asks *which* layer and *where* — LiDAR in 3D enters
  on **one fixed 1 km disc** (≈2 km across), one layer at a time, and the tiles of that
  disc are downloaded and draped before the view opens (§6.4).
* **Camera** – opening 3D keeps the 2D centre/zoom (and Leaflet's bearing, if the
  rotation control was used); closing 3D writes the 3D camera back into Leaflet.
  Before that hand-off, the viewer stops Leaflet pan/fly motion and completes any
  in-flight CSS zoom. `Map.stop()` alone does not cancel Leaflet's delayed 250 ms
  zoom-end callback; if it fires after the camera hand-off it can restore a stale
  view and make the country outline jump when the user searches immediately after
  returning to 2D.
* **Layers** – the *same* checkboxes decide what 3D draws. Switch a historical map on in
  2D, and it is draped in 3D; drag its opacity slider, and 3D follows live.
* **Controls** – a 3D-view basemap picker (Imagery / Topographic / Terrain),
  the reset / ↑ N / 2D ⤓ shortcut buttons, plus MapLibre's source credits and
  scale at bottom-left. **Pitch, bearing and terrain exaggeration have no
  controls on the desktop website**: the camera is moved by gestures only
  (drag to pan, right-drag or Ctrl/⌘+drag to pitch and rotate, two fingers on
  touch, Shift+arrows from the keyboard, wheel to zoom) and the DEM
  exaggeration is the fixed `CONFIG.terrain.exaggeration`. See
  `MAP3D_GESTURE_CAMERA.md`. The picker uses the
  same ArcGIS basemap stack as 2D, so its choice stays in sync and the mirrored
  3D deck updates without leaving the view. Beside the bottom-centre **2D**
  switch, the **refresh** button preloads every source-supported zoom for the
  active non-LiDAR raster layers within a 1 km radius of the current 3D camera
  centre. This includes the current basemap and terrain raster sources; it shows
  progress, can be stopped, and reloads the visible sources from the warmed
  cache. LiDAR stays on its separate prepared-disc flow (§6.4). There is **no
  terrain on/off button** (MapLibre's `TerrainControl`, titled “Disable terrain”):
  3D is draped over the DEM by the style itself, at a fixed exaggeration.
  Layer/provider diagnostics are available via
  `window.DetectLabMap3D.status()` / `.report()`, not in the visible controls.
  (`setExaggeration()` / `setPitch()` / `setBearing()` remain on the public API
  for diagnostics and automation; nothing in the UI calls them.)
* **Layout while 3D is on** – the Leaflet panes stop painting and Leaflet's own controls
  (zoom, locate, measure — they move the *2D* camera) are hidden, so nobody clicks a
  button that changes a map they cannot see; MapLibre contributes only the source
  credits and the scale, both bottom-left, so the top-right corner stays the app's own
  “?” help button. The 3D bar sits bottom-left and the 2D⇄3D toggle plus raster-refresh
  button sit bottom-centre as one group; the refresh action is visible only while 3D is
  open. The search bar, the layer panel and the opacity mirror keep their exact 2D
  position and stay fully usable. In the installed PWA, the control strips instead
  sit horizontally centred in the lower half, above the bottom actions; short
  screens can scroll them. PWA zoom buttons sit top-left (14px + top safe area),
  mirroring the top-right help button. Web navigation remains bottom-right.

Run it locally with the tile proxy (Netlify functions do not exist in `file://`):

```bash
node tools/map3d-dev-server.mjs            # http://localhost:4173 (0.0.0.0)
node tools/map3d-dev-server.mjs --port 8080
```

`http://localhost:4173/api/map3d/status` prints the registry + the proxy report as JSON —
handy when a provider misbehaves. In production the same route is served by
`netlify/functions/map3d-tile.mjs` (declared in `netlify.toml`).

## 2. How it is put together

| Concern | Where it lives | Notes |
| --- | --- | --- |
| **Layer definitions (single source of truth)** | `js/layer-registry.js` | 91 layers: base imagery/relief, historical WMS sheets, R2/Supabase tile pyramids, LiDAR relief, CORONA, VEG-FP, city plans. Each entry carries URL, `LAYERS`, `FORMAT`, `VERSION`, transparency, custom params, bounds, attribution, tile size, zoom window, 2D pane z-index, the CORS/proxy policy and — for country layers whose URL builder needs a tile box — the `builder` that says which module builds it. |
| **3D renderer** | `js/map3d-terrain.js` + `css/map3d-terrain.css` | MapLibre GL JS 5.24.0 (vendored in `js/maplibre-gl.js`, loaded lazily on first open). DEM + hillshade + sky, one `raster` source per active layer, stacked by the 2D pane z-index. |
| **Same-origin tile proxy** | `netlify/lib/map3d-tile.mjs` (shared), `netlify/functions/map3d-tile.mjs` (production), `tools/map3d-dev-server.mjs` (local) | `GET /api/map3d/tile?layer=<id>&z=&x=&y=[&t=][&m=][&p=]`. The allow-list *is* the registry, so it cannot fetch anything else. Re-projects the tile bbox for layers that cannot answer Web Mercator, and runs the country-layer modules that build a URL per tile. |
| **Per-tile URL protocol** | `dl3d://<layer id>/{z}/{x}/{y}` registered by `js/map3d-terrain.js` | Five country LiDAR layers (PL, ES, NL, NO, SE) can only build a URL from a *tile bbox* (WMS `GetMap`, ArcGIS `exportImage`), which no `{z}/{x}/{y}` template can express. MapLibre asks for `dl3d://…`, the handler calls `registry.tileUrlAt(def, z, x, y)` and fetches what the layer's own module returned — the same URL the 2D Leaflet layer uses, mode dropdown included. |
| **Country-module sandbox** | `netlify/lib/map3d-country-modules.mjs` | The same `js/*-layer.js` modules, evaluated in `node:vm` with a minimal `L`/`document`, so the proxy can build those per-tile URLs server-side when a host turns out to have no CORS. A module that fails to evaluate leaves its layer reported as “module not loaded” — never silently dropped. |
| **2D consumers** | `js/map-app.js`, `js/historical-eu-maps.js` | Both now build their service options from the registry (`DL.url2d()`, `DL.wms2dOptions()`, `DL.tile2dOptions()`, `DL.cenagisCatalog()`). The historical/premium sheets, the Copernicus mosaics and the Josephine pyramids no longer repeat a single URL. |

Why MapLibre GL and not CesiumJS: every layer **is** available in EPSG:3857 (the two
EPSG:2180-only city plans are re-projected by the proxy), so a terrain-capable raster
viewer is enough — no 3D-tiles/globe stack is needed for draping flat WMS imagery.

### Uploading the DEM

| Provider | Tiles | Encoding | Key |
| --- | --- | --- | --- |
| **AWS Terrain Tiles** (default) | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | `terrarium` | none |
| MapTiler | `https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp` | `mapbox` | **required** |
| Custom | any terrarium/Mapbox-encoded raster-dem | — | — |

The DEM is **not** provided by the historical-map services (they are flat imagery) — that
is exactly why it is a separate, configurable source. Switch it without touching code:

```html
<script>
window.DETECTLAB_MAP3D = {
  terrain: {
    provider: 'maptiler',            // 'aws-terrarium' (default) | 'maptiler' | 'custom'
    key: 'YOUR_MAPTILER_KEY',        // injected at deploy time — never committed
    exaggeration: 1.4                // fixed in the UI (0.5 … 4): no slider on web
  },
  hillshade: { mode: 'dem' },        // 'dem' (from the DEM) | 'service' | 'off'
  sky: { enabled: true },
  camera: { pitch: 62, maxPitch: 80 },
  proxy: { base: '/api/map3d/tile' },
  perf: { maxTileCacheSize: 256 }
};
</script>
```

Every key is optional — `deepMerge()` over the registry defaults
(`MAP3D_DEFAULT` in `js/layer-registry.js`) means a partial object is enough.

**Keys needed:** *none* by default. The only optional key is a MapTiler key for a
higher-resolution DEM; keep it out of the repository (config/inline snippet as above,
injected at deploy time). The two credential-gated sources that already existed keep
their own server-side functions (`LANTMATERIET_WMS_USER`/`_PASSWORD`/`_TOKEN`,
`DATAFORSYNINGEN_TOKEN` — see `SWEDEN_LIDAR_LANTMATERIET.md`,
`DENMARK_LIDAR_DATAFORSYNINGEN.md`); the 3D view reaches them through
`/api/geo/se-hojdmodell` and `/api/geo/dk-dhm`, so no secret ever reaches the browser.

## 3. Per-source CORS policy (why some layers go through the proxy)

MapLibre GL loads raster tiles with `crossOrigin="anonymous"` (they become WebGL
textures), so a host that sends **no** `Access-Control-Allow-Origin` yields *no tile at
all* in 3D — even though the same layer renders fine in 2D as a plain `<img>`. The
proxy therefore serves the layers whose hosts are known/believed not to be CORS-safe,
and the viewer probes unknown hosts at runtime (a 32×32 GetMap) and remembers the verdict
for the session, switching that host to the direct URL when it proves CORS-safe.

| Host | Layers | CORS evidence | 3D transport |
| --- | --- | --- | --- |
| `pastmaps.cenagis.edu.pl` | 51 | unknown | auto |
| `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | 10 | unknown | auto |
| `server.arcgisonline.com` | 4 | yes | direct |
| `phenology.hrvpp2.vgt.vito.be` | 4 | unknown | auto |
| `services.geo-spatial.org` | 3 | unknown | auto |
| `image.discomap.eea.europa.eu` | 2 | no | proxied |
| `tiles.arcgis.com` | 2 | yes | direct |
| `services.arcgisonline.com` | 1 | yes | direct |
| `copernicus.discomap.eea.europa.eu` | 1 | no | proxied |
| `ahn.arcgisonline.nl` | 1 | yes | direct |
| `hoydedata.no` | 1 | yes | direct |
| `mapy.geoportal.gov.pl` | 1 | unknown | auto |
| `wms-mapa-lidar.idee.es` | 1 | unknown | auto |
| `wmts.geo.admin.ch` | 1 | yes | direct |
| `environment.data.gov.uk` | 1 | yes | direct |
| `/api/geo/dk-dhm` | 1 | yes | direct |
| `/api/geo/se-hojdmodell` | 1 | yes | direct |
| `data.geopf.fr` | 1 | unknown | auto |
| `(relative / runtime)` | 1 | yes | direct |
| `sclav.andreiroba2000.workers.dev` | 1 | unknown | auto |
| `geoserve.cast.uark.edu` | 1 | no | proxied |
| `dacboefvooxgsngxkavx.supabase.co` | 1 | yes | direct |

Bucket totals: **16 direct**, **69 direct-with-runtime-probe (proxied until proven)**,
**6 always through the proxy** (2 of them re-projected). **8 layers are built per tile by
their own country module** (`moduleBuilt` in `/api/map3d/status`) — five of them are the
`dl3d://` ones above; when such a host is found to have no CORS the proxy takes over and
builds the very same URL server-side.

A layer that fails its first direct tiles is never left blank: the viewer's health watch
(`7 s`) moves that **host** to the proxy, remembers the verdict for the session
(`sessionStorage: dl3d.cors.<host>`) and re-requests the same tiles through
`/api/map3d/tile`.

## 4. Inventory — every layer, as the registry defines it

`kind`/`crs`/`format` come straight from the shared registry; `3D mode` is the transport
decision (`direct` = browser fetches the provider, `auto` = direct until the CORS probe
says otherwise, `proxied` = always through `/api/map3d/tile`). “works via proxy” and
“works per tile” are supported states, not failures: the layer is draped, either from our
own origin or through the module that owns its URL. The table is generated from the
registry (`diagnostics()` + `proxyReport()`), so it cannot drift from the code.

| Layer id | Title | Group | Kind | CRS requested | Format / version | Zoom | Host | CORS | 3D mode | 3D status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `base.imagery` | Satellite imagery (Esri World Imagery) | base | xyz | EPSG:3857 | xyz tiles | 1–20 | `server.arcgisonline.com` | yes | direct | works directly |
| `base.topographic` | Topographic (Esri World Topo) | base | xyz | EPSG:3857 | xyz tiles | 1–20 | `server.arcgisonline.com` | yes | direct | works directly |
| `base.terrain-base` | Terrain base (Esri World Terrain Base) | base | xyz | EPSG:3857 | xyz tiles | 1–20 | `server.arcgisonline.com` | yes | direct | works directly |
| `base.terrain-relief` | Shaded relief (Esri World Shaded Relief) | base | xyz | EPSG:3857 | xyz tiles | 1–20 | `server.arcgisonline.com` | yes | direct | works directly |
| `base.hillshade` | World Hillshade (Esri) | base | xyz | EPSG:3857 | xyz tiles | 0–20 | `services.arcgisonline.com` | yes | direct | works directly |
| `sat.vhr-2012` | Satellite 2012 (Copernicus VHR) | sat-hist | wms | EPSG:3857 | image/jpeg 1.1.1 opaque | 1–20 | `copernicus.discomap.eea.europa.eu` | no | proxied | works via proxy |
| `sat.vhr-2018` | Satellite 2018 (Copernicus VHR) | sat-hist | wms | EPSG:3857 | image/jpeg 1.1.1 opaque | 1–20 | `image.discomap.eea.europa.eu` | no | proxied | works via proxy |
| `sat.vhr-2021` | Satellite 2021 (Copernicus VHR) | sat-hist | wms | EPSG:3857 | image/jpeg 1.1.1 opaque | 1–20 | `image.discomap.eea.europa.eu` | no | proxied | works via proxy |
| `uat.tiles` | UAT (administrative units) | uat | xyz | EPSG:3857 | xyz tiles | 0–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `lidar.nl-ahn` | Netherlands · AHN (DTM/DSM) | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `ahn.arcgisonline.nl` | yes | direct | works per tile (dl3d://) |
| `lidar.no-hoydedata` | Norway · Kartverket Høydedata | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `hoydedata.no` | yes | direct | works per tile (dl3d://) |
| `lidar.pl-nmt` | Poland · GUGiK NMT (shading/hypsometry) | lidar | dynamic | EPSG:3857 | image/png 1.3.0 transparent | 6–20 | `mapy.geoportal.gov.pl` | unknown | auto | works per tile (dl3d://) |
| `lidar.es-mdt` | Spain · IGN MDT/LiDAR | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `wms-mapa-lidar.idee.es` | unknown | auto | works per tile (dl3d://) |
| `lidar.ch-swisstopo` | Switzerland · swisstopo relief | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `wmts.geo.admin.ch` | yes | direct | works directly |
| `lidar.uk-ea` | UK · Environment Agency LiDAR | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `environment.data.gov.uk` | yes | direct | works directly |
| `lidar.dk-dhm` | Denmark · Dataforsyningen DHM | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `/api/geo/dk-dhm` | yes | direct | works directly |
| `lidar.se-lantmateriet` | Sweden · Lantmäteriet höjdmodell | lidar | dynamic | EPSG:3857 | image/png transparent | 6–20 | `/api/geo/se-hojdmodell` | yes | direct | works per tile (dl3d://) |
| `lidar.fr-mnh` | France · IGN LiDAR HD (DTM/DSM/CHM) | lidar | wms | EPSG:3857 | image/png 1.3.0 transparent 3 products | 6–20 | `data.geopf.fr` | unknown | auto | works (proxy on demand) |
| `vegfp.ppi` | Vegetation PPI (dekadal) | vegfp | wmts | EPSG:3857 | image/png 1.0.0 transparent TIME TIME | 6–20 | `phenology.hrvpp2.vgt.vito.be` | unknown | auto | works (proxy on demand) |
| `vegfp.smx` | Vegetation SMX (season max) | vegfp | wmts | EPSG:3857 | image/png 1.0.0 transparent TIME TIME | 6–20 | `phenology.hrvpp2.vgt.vito.be` | unknown | auto | works (proxy on demand) |
| `vegfp.sgu` | Vegetation SGU (season start) | vegfp | wmts | EPSG:3857 | image/png 1.0.0 transparent TIME TIME | 6–20 | `phenology.hrvpp2.vgt.vito.be` | unknown | auto | works (proxy on demand) |
| `vegfp.sgd` | Vegetation SGD (season end) | vegfp | wmts | EPSG:3857 | image/png 1.0.0 transparent TIME TIME | 6–20 | `phenology.hrvpp2.vgt.vito.be` | unknown | auto | works (proxy on demand) |
| `overlay.image-overlays` | Dynamic image overlays | image-overlay | dynamic | EPSG:3857 | dynamic (runtime deck) | 0–20 | `—` | yes | direct | works directly |
| `cenagis.wig25k` | WIG Detailed Map 1:25,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.wig100k` | WIG Tactical Map 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.wig300k` | WIG Operational Map 1:300,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.wig500k_1947` | WIG Poland & Neighboring Countries 1:500,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.tkkp_126k` | Topographic Chart of the Kingdom of Poland (TKKP) 1:126,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.chrzanowski` | Charter of Old Poland (Wojciech Chrzanowski) 1:300,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.gaul` | Gaul / Raczyński Map 1:125,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.kummersberg` | Administrative Map of Galicia & Lodomeria (Kummersberg) 1:115,200 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.schroetter` | Schroetter Map (East & West Prussia) 1:150,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.gilly` | Gilly Map (South Prussia) 1:150,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.textor` | Textor-Sotzmann Map (New East Prussia) 1:150,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.m25k` | German Topographic Messtischblätter 1:25,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.kdr` | German Empire Map (Karte des Deutschen Reiches) 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.kdr_gb` | German Grossblätter WWII 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.kdwr` | Western Russia Map (Karte des Westlichen Russlands) 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.ukvme` | Central Europe Map (Übersichtskarte von Mitteleuropa) 1:300,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.reymann` | Reymann's Special Map of Central Europe 1:200,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.dwuwiorstowka` | Russian 2-Verst Map (Dvukhverstka) 1:84,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.ahp_ziemie_polskie` | Crown Lands of Poland in 16th c. 1:250,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.ahp_drogi` | Trade & Postal Routes in 16th c. 1:500,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.ahp_koscielne` | Ecclesiastical Divisions in 16th c. 1:500,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.ahp_wlasnosc` | Land Ownership Structure in 16th c. 1:500,000 | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_warszawa` | Warsaw City Plan 1:25,000 (1944) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_krakow` | Kraków City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_gdansk` | Gdańsk City Plan 1:25,000 (1944) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_wroclaw` | Wrocław (Breslau) City Plan 1:25,000 (1944) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_poznan` | Poznań City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_lodz` | Łódź City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_katowice` | Katowice City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_czestochowa` | Częstochowa City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_bialystok` | Białystok City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_bydgoszcz` | Bydgoszcz City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_torun` | Toruń City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_lublin` | Lublin City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_kielce` | Kielce City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_radom` | Radom City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_rzeszow` | Rzeszów City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_tarnow` | Tarnów City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_grudziadz` | Grudziądz City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_inowroclaw` | Inowrocław City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_jaslo` | Jasło City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_siedlce` | Siedlce City Plan 1:25,000 (1943) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_warszawa_lindley` | Lindley Warsaw Plan 1:2,500 (1897–1901) | hist-premium | wms | EPSG:3857 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `cenagis.city_warszawa_1822` | Warsaw City Plan (Corps of Engineers) 1:4,800 (1822) | hist-premium | wms | EPSG:2180 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | proxied | works via proxy · re-projected |
| `cenagis.city_praga_1796` | Praga Suburb (Warsaw) Plan 1:7,200 (1796) | hist-premium | wms | EPSG:2180 | image/png 1.3.0 transparent | 0–20 | `pastmaps.cenagis.edu.pl` | unknown | proxied | works via proxy · re-projected |
| `hist.austrian` | Austrian Map 1910 | hist-free | wms | EPSG:3857 | image/png 1.1.0 transparent | 0–20 | `services.geo-spatial.org` | unknown | auto | works (proxy on demand) |
| `hist.firing-plans` | Firing Plans | hist-free | wms | EPSG:3857 | image/png 1.1.0 transparent | 0–20 | `services.geo-spatial.org` | unknown | auto | works (proxy on demand) |
| `premium.bucovina` | Galicia & Bukovina (1861–1864) | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `hist.soviet-1970` | Soviet Map 1970 | hist-free | wms | EPSG:3857 | image/png 1.1.0 transparent | 0–20 | `services.geo-spatial.org` | unknown | auto | works (proxy on demand) |
| `premium.austro-hungarian` | Austro-Hungarian Map (1869–1912) | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `premium.moldova-1868` | Moldova 1868 | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `premium.moldova-wwii` | Moldova WWII | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `premium.polish-tactical-1933` | Polish Tactical Map 1933 | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `apm.tiles` | APM 2.0 (archaeological potential) | apm | xyz | EPSG:3857 | xyz tiles | 0–20 | `sclav.andreiroba2000.workers.dev` | unknown | auto | works (proxy on demand) |
| `premium.ww1` | World War I Map | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `premium.ww2` | World War II Map | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `sat.corona-60s` | Satellite imagery 60s (CORONA) | hist-sat | dynamic | EPSG:900913 | image/png 1.1.1 transparent | 8–20 | `geoserve.cast.uark.edu` | no | proxied | works via proxy |
| `premium.banat` | Banat (historical map) | hist-premium | xyz | EPSG:3857 | xyz tiles | 11–20 | `dacboefvooxgsngxkavx.supabase.co` | yes | direct | works directly |
| `premium.josephine` | Josephine Map + (1780–1790) | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | yes | direct | works directly |
| `premium.moldova-1771` | Moldova 1771 | hist-premium | xyz | EPSG:3857 | xyz tiles | 8–20 | `pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev` | unknown | auto | works (proxy on demand) |
| `premium.transylvania-1859` | Transylvania 1859 (Siebenbürgen) | hist-premium | arcgis-image | EPSG:3857 | xyz tiles | 7–20 | `tiles.arcgis.com` | yes | direct | works directly |
| `premium.galicia-1855` | Galicia 1855 (Kummerer) | hist-premium | arcgis-image | EPSG:3857 | xyz tiles | 6–20 | `tiles.arcgis.com` | yes | direct | works directly |
| `premium.mitteleuropa` | Central Europe (Übersichtskarte 1:300,000) | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `premium.chrzanowski` | Charter of Old Poland (Chrzanowski 1859) | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `premium.reymann` | Reymann Special Map (1:200,000) | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `premium.kdr-100k` | Karte des Deutschen Reiches 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `premium.kdr-gb` | German Grossblätter 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
| `premium.wig-100k` | WIG Tactical Map 1:100,000 | hist-premium | wms | EPSG:3857 | image/png 1.1.1 transparent | 0–18 | `pastmaps.cenagis.edu.pl` | unknown | auto | works (proxy on demand) |
Nothing in this list is “unsupported”, and nothing is skipped: every one of the 91
layers is draped — directly, through the proxy, or per tile through `dl3d://`. A layer
would only be reported as **2D only** if its module failed to load; `registry.diagnostics()`
then names the module in `reason` instead of dropping the layer; the viewer's
`.status()` / `.report()` diagnostics retain the details. The relief you see under a historical sheet always comes from the DEM,
never from the layer provider — a WMS only ever contributes flat imagery.

## 5. Known limitations (please read before reporting “misalignment”)

1. **Historical maps do not line up with modern terrain.** A 1855 sheet is draped on
   today's SRTM/ETOPO DEM; where the landscape changed (quarries, mines, drained
   marshes, river regulation) the relief will not match the printed map. That is a
   property of the data, not of the viewer. The exaggeration is a fixed config
   constant (`CONFIG.terrain.exaggeration`); pitch and bearing change with the
   drag gesture so the draping can be judged from an angle.
2. **The two EPSG:2180 city plans are re-projected approximately** (Warsaw 1822, Prague
   1796). The proxy converts the Web-Mercator tile bbox into PL-1992 (GRS80 transverse
   Mercator, k0 = 0.9993, λ0 = 19° E) and requests the tile in `crs=EPSG:2180`; the
   client-side grid is still Web Mercator, so expect a small offset at high zoom. The
   report flags those tiles with `approximate: true`.
3. **Flat imagery stays flat.** Layers without alpha (the Copernicus mosaics are JPEG,
   `transparent=false`) hide everything drawn under them in 3D, exactly as they do in 2D.
4. **CORONA is a dynamic deck.** The 60s imagery is not one layer but the set of passes
   (z8–11) or frames (z12–20) that intersect the view; the 3D view asks the same
   catalogue/selection code the 2D layer uses and drapes the products it returns. Gaps
   between passes are real (no imagery there).
5. **Image overlays** (e.g. the free “Harta Iosefină” sheet) are mirrored from Leaflet at
   runtime — the 3D source uses the exact bounds Leaflet is using; no georeferencing is
   invented.
6. **Provider 4xx/5xx**: the proxy answers a **transparent 1×1 PNG labelled
   `X-Map3D-Tile: blank`** instead of an error, so one broken provider cannot blank the
   whole 3D view; the viewer's `.status()` diagnostics retain the failing host.
7. **Offline/PWA**: MapLibre GL, the registry and the viewer are precached, but tiles
   obviously are not — 3D needs the network unless the layer tiles were downloaded to
   the offline cache.
8. **Country LiDAR layers are rebuilt, not re-implemented.** Their URLs are produced by
   `js/ahn-layer.js`, `js/hoydedata-layer.js`, `js/geoportal-nmt-layer.js`,
   `js/ign-mdt-layer.js`, `js/swisstopo-relief-layer.js`, `js/ea-lidar-wmts-layer.js`,
   `js/dataforsyningen-dhm-layer.js` and `js/lantmateriet-hojdmodell-layer.js` — in the
   browser directly, on the server inside the `node:vm` sandbox. If you change one of
   those modules, both views follow automatically; if you *rename* a module's global
   (`window.AhnLidar`, …) or its `tileUrl`/`exportImageUrl` export, update the
   `builder: { module, fn, kind }` field of the registry entry to match.
9. **France LiDAR HD is a plain WMS with three products** (MNT/MNS/MNH). The product
   table lives in the registry (`modes`) and both views read it; the 3D source is
   re-pointed when the 2D dropdown changes, and the product travels to the proxy as
   `&m=<mode>`.
10. **A per-tile layer needs the module before it can drape.** In the headless registry
   (Node without the sandbox) the 8 module-backed layers report `drape: false` with the
   module name; in the browser and in the proxy they are evaluated, so
   `/api/map3d/status` and `node test-map3d-terrain.js` show **91/91 draped**.

## 6. The Roman-roads crash, the blank LiDAR tiles, and what the deck budget does

Three reports, one release, all of them in the 2D → 3D mirror and the way it hands a deck
to MapLibre. This is what each one was, and what the code does now.

**1. “Roman roads + 3D = the page crashes.”** The roads are ~20 000 polylines collected
in one `L.featureGroup`. The mirror walked the group and produced **one 3D source and one
3D layer per polyline** — 20 000 of each — and re-described the whole group on every
1.5 s poll and every `moveend`, rebuilding a ~500 KB signature each time. The bundling
added here merges siblings that draw identically: the same kind, paint, order, popup and
tooltip. The result for that group is **10 bundles of 20 000 features** (`2d.R1/b1` …),
each with the label `roman (20,000 features)`, and the poll pass reuses them
(`DetectLabMirror.invalidate(group)` drops the cache; the opacity slider is part of the
cache key, so moving it redraws).

Budgets, all in `js/map3d-mirror.js` and all reported to the user rather than enforced
silently:

| limit | value | why |
| --- | --- | --- |
| features per bundle | 20 000 | one GeoJSON upload per merge, not one per polyline |
| bundles per group | 24 | children that paint differently still cannot explode |
| deck items | 400 | a flat map with thousands of loose layers |
| layers examined | 1 600 | the walk itself stops, so a pathological map cannot hang the page |

What the budget had to leave out appears in `.status().capped` as a sentence naming how
many layers, is pushed **once** into `.status().errors` (so “the layer is missing in 3D”
is always answerable, and never repeats on every poll), and is printed by `.report()`.

**2. “The Romanian LiDAR layers look like a white sheet / never load in 3D.”** `ro1m`
(Romania 1m/pixel agregare) and `ro2m` are hillshades whose background is white; the 2D
map removes it with CSS:
`filter: invert(1); mix-blend-mode: screen` (`css/styles.css`). MapLibre has no blend
modes — and the vendored build has no `raster-color` either — so the mirrored tile
arrived as the service sent it, i.e. an opaque white rectangle over the terrain.

The mirror now carries the blend (`item.blend === 'invert-screen'`, read from the layer's
own class name) and the viewer repaints every such tile before handing it to MapLibre:
**white, with alpha = 1 − luminance**. That is not an approximation of a dark base — it
is the stylesheet's arithmetic for *any* base: screen over a base `b` of an inverted tile
`1 − c` is `1 − c + c·b`, and white at alpha `(1 − c)` composited over `b` is
`(1 − c) + c·b`. Grayscale hillshades come out pixel-exact; `tools/probe-3d-blend.js`
prints the worst channel error over a full ramp (0.0000). Transparent source pixels stay
transparent, so a tile with holes keeps them.

Repainted tiles are cached (160 tiles, dropped when 3D closes): MapLibre evicts decoded
tiles, and re-downloading *and* re-encoding a 1 m hillshade tile on every pan back is what
made these layers feel like they never finished loading. `.status().retintedTiles` counts
them, so a support report can show they are being served.

The layer keeps 2D fidelity elsewhere too: `maxzoom` is taken from `maxNativeZoom` (16 for
`ro1m`/`ro2m`), so MapLibre **overzooms the z16 tiles** above that instead of asking a 1 m
service for dozens of deep tiles — the “really slow at high zoom” half of the report.

**3. Tiles that were already loaded were being reloaded.** `syncLayers()` runs on every
pan, panel change and 1.5 s poll. It used to call `source.setData(geojson)` and
`source.setTiles(template)` unconditionally — in MapLibre that re-parses the GeoJSON and
**re-loads the whole raster source, aborting in-flight requests**. Two caches (keyed by
source id, cleared when the source is removed or 3D closes) make both calls no-ops while
the data or the template is unchanged; a host that healed to the proxy forces the reload
it needs. Before this, a LiDAR layer in 3D re-requested every visible tile every 1.5
seconds, which looks exactly like “it loads really slow, sometimes blank, sometimes fine”.

**Still a property of the data, not a bug:** beyond its published zoom (e.g. z16 for the
Romanian 1 m service) or outside its coverage, a provider answers with a blank or
all-white tile. The 3D view draws what it was sent at that zoom; only the white *sheet*
over the whole layer was ours to fix, and that is the blend above.

### 6.4 LiDAR in 3D: whole layers, or one disc prepared before the view opens

**4. “Some LiDAR layers still load really slow, or look really bad, or don't load at all
in 3D — e.g. Romania 1m/pixel agregare, AB.”** The blend and the caching above fix *how* a
LiDAR tile is drawn, but not *how many* of them are asked for. A national LiDAR pyramid is
not a layer, it is a few hundred thousand heavy tiles, and the user's own sub-layers
(`ro1m`, `ro2m`, `ab`, `hd`, … in `js/map-app.js`) plus the nine country modules all sit in
`window._lidarGroup`. Opening 3D with one switched on handed MapLibre the opening camera
and let it ask that provider for every tile it could see, at every zoom — over one slow
service, that is a blank sheet with a spinner behind it.

`js/lidar-3d-focus.js` (loaded after the viewer, ~30 kB, no dependencies) changes the
order of events. It installs itself as the viewer's **entry gate**
(`DetectLabMap3D.setEntryGate`); the 3D button still calls `toggle()`/`open()`, but `open()`
now asks the gate first and only opens when it is answered with a prepared disc:

1. **One fixed disc, stated, not implied.** A sheet over the 2D map says LiDAR in 3D loads
   on a **1 km radius** around a point, and asks for the point. There is no distance
   slider and no quick chips: every entry prepares the same disc
   (`MAX_RADIUS_KM = MIN_RADIUS_KM = DEFAULT_RADIUS_KM = 1`; `applyFocus()` clamps any
   other caller, so an old saved focus cannot slip a bigger disc in).
   **Why the distance choice went away** — the plan's zoom window is anchored on
   `round(fitZoom(disc))`, the zoom at which the whole disc fills the screen, and that
   zoom falls by one level for every doubling of the radius. A 5 km disc was therefore
   prepared from levels two steps coarser than a 1 km disc (zFit 12 vs 14 on a phone),
   so the larger disc looked soft — and its tile count jumped with the rounding (67 at
   5 km, 50 at 1 km, 22 at 3 km on the same viewport), which is the “65 tiles at 5 km,
   double that at 1–2 km, and sharper” report. At a fixed 1 km the opening view is always
   prepared at the layer's native detail. `window.DETECTLAB_LIDAR_3D.maxRadiusKm > 1`
   still raises the cap (and brings the slider back) for anyone who wants it.
2. **Every LiDAR layer switched on is offered, and the ticked ones are the decision.**
   The dialog lists every LiDAR layer the 2D map is showing, each with its own tick box —
   for a whole-layer entry as much as for a disc, where the box means “prepare this layer
   over the 1 km circle too”. The 2D map may stack as many as it likes (that is how the
   products are compared); 3D draws exactly the ticked ones, `status().lidar.drawn` names
   them and `status().lidar.notes` carries `{reason: 'focused', count, keptCount, kept,
   scope}` for the ones left out. The choice is remembered in the focus, so the state
   survives closing and reopening 3D. §6.4.3 has the 2026-10-26 change that replaced the
   old “one LiDAR layer at a time” rule (the one that never let a national layer be drawn
   whole).
3. **A point on the map**, chosen by tapping the 2D map (`window._dlLidarFocusPicking`
   tells `js/lidar-scanner.js` to stand down while the tap belongs to the dialog). The disc
   is drawn on the 2D map immediately — a dashed outline with a centre dot in the pane
   `pane_lidar_3d_focus` (z 656, above every LiDAR pane), so the area being prepared is
   visible while it downloads.
4. **The plan.** `planDisc()` resolves the zoom at which the disc fills the viewport
   (`zFit`) and walks **whole zoom levels from `zFit - 2` to the layer's native
   `maxNativeZoom`**, keeping only the tiles that really intersect the disc. The screen
   decides where the camera *opens*; it does **not** decide how deep the prepared disc
   goes. This is the mobile lesson of 2026-10-19: a phone frames the same disc one level
   wider than a desktop, so the old fixed “two levels above `zFit`” stopped at z16 where a
   desktop reached z17 — a 1 km disc had 50 prepared tiles on a phone and 140 on a desktop,
   and pinching past z16 dropped every tile into a live per-tile fetch that raced
   MapLibre's cancel-while-zooming, leaving the base map under the LiDAR. Both devices now
   prepare to the native maximum (144 vs 140 tiles on a z17 pyramid).
   A level is included only **whole**: the plan stops before the first level that does not
   fit the budget (`{url: 360, canvas: 260}`, `window.DETECTLAB_LIDAR_3D` overrides) and
   reports the tiles it did not buy (`plan.trimmed`) — a half-prepared level would be a
   hole at the rim at exactly the zoom under the camera. Inside a level, tiles stay
   **centre-first**. The viewer caps the focused raster source's `maxzoom` at
   `plan.zoomTo` (`renderRaster()`), so beyond it MapLibre *overzooms* the prepared tiles
   instead of asking for tiles nobody downloaded; the same cap is applied to the
   registry-backed country modules in `renderRegistryRaster()`. Phones also keep a
   160-tile MapLibre tile cache (was 64) and a 1 400-entry / 48 MB primed disc (was
   900 / 28 MB), so the deeper plan stays resident through a pinch.
5. **The prefetch runs through the same pipeline 3D draws with.** `prefetchTiles()` calls
   the viewer's own `fetchTile()` (so the CORS/proxy decision per host — including the WMS
   `preferProxy` rule — is the same one the deck makes), then the same `blendedTile()`
   repaint (a Romanian hillshade tile is repainted before it is stored) and the same disc
   clip. Concurrency is 6 (4 on phones) on purpose: the point is a slow provider and a
   progress bar that moves, not 200 simultaneous requests. The dialog shows
   `{done}/{total}`, the failures and a Stop button, and the *same* count the bar will
   report afterwards.
6. **Only then does 3D open**, framed on the disc (`focusCamera()`) at the zoom that fits
   it, from tiles that are already decoded and in memory.

The disc is a **circle, not a rectangle**. `disc.maskTile()` (in the mirror) hands a tile
wholly inside the disc through untouched, returns null for one the disc does not touch (the
viewer substitutes a 1×1 transparent PNG, so the terrain under it is intact), and repaints
only the rim tiles with a one-pixel feather. The focused 3D source is also **bounded to the
disc's rectangle**, so MapLibre never asks outside the prepared area — and `tl2d://` tiles
of that layer outside the disc are answered with the blank tile instead of a request.

Prepared tiles live in the viewer (`state.primed` / `state.primedOut`, one FIFO slot per
tile), byte-budgeted at 2 400 entries / 96 MB on desktop and 900 / 28 MB on phones, and they
**survive closing 3D**: reopening on the same disc downloads nothing at all
(`status().lidar.primed` counts them, `clearPrimed()` forgets them). Moving the disc or
closing the focus drops the tiles of the old one.

“Sometimes the fetch finishes, 3D opens, and only the base map is there” was a
first-entry defect in how those tiles are addressed. The prefetch resolves each tile's
layer through the mirror's key table (`DetectLabMirror.layerByKey`), and so does the
blend/clip signature — but that table is only filled by `collect()`, which the viewer
otherwise runs once the 3D view is already opening. On a first entry the table was
empty: every canvas-route tile (the nine country products draw their own tiles) rejected
with “the 2D layer did not finish drawing”, and blended tiles were stored under a
pipeline signature the serve path never asks for. The dialog folded into 3D with a disc
that existed only on paper, and the view fell back to live per-tile requests racing
MapLibre's aborts — usually rescued, sometimes an empty disc over the base map.
`prefetchTiles()` now collects the mirror first, exactly as the view will see it. The
country products needed a second bridge: their 3D source is `dl3d://<defId>` while
their canvas prefetch stores under the `dl2d://<deck key>` of the live layer, so the
`dl3d` handler also honours the prepared `dl2d` disc of the current focus before it
fetches anything live. The invariant the suite now holds end to end: for every tile of
the disc, at the moment 3D opens, the protocol handlers answer with the prepared pixels
and make no request at all.

The same “nothing happens” shape had a second, quieter cause in the handover itself:
the fetch finished, the dialog said “Done”, and no 3D view ever appeared. The gate is
answered by `settle()`, which sat at the end of the post-fetch bookkeeping (apply the
counted focus, paint “Done”, write the pill summary) with nothing guarding it — any
throw in that stretch (a Leaflet layer that will not restyle, a bar row mid-teardown)
left the dialog at “Done” and the gate unanswered forever. The bookkeeping is now
guarded, the focus having been applied before the download is what the entry proceeds
on, and the gate is always answered. Two sibling dead-ends were closed with it: the
no-WebGL report used to leave `state.open` set (unlike `fail3D`), so every later tap
on the 3D button answered “already open” and did nothing at all — it now reads as
closed, and the next tap retries; and a single stalled tile fetch (a provider that
accepts the connection and then says nothing, the classic throttled-service behaviour
under the six-lane burst) could park the prefetch a tile short of done forever —
prefetch fetches now carry a 45 s per-tile deadline, after which the tile simply
counts as failed and is asked again on demand inside 3D.

Two key spaces meet on this path and both travel with the focus: the **deck key** of a
mirrored layer (`2d.<stamp>`, what `dl2d://` and the clip are addressed by) and the **LiDAR
family key** the tag carries (`lidar.ro1m`, `def:lidar.fr-mnh`, what the mirror item, the
registry and the dialog agree on). `js/map-app.js` tags every LiDAR sub-layer it builds with
`_dlLidar = { key, label }` (next to the existing `_dlDefId`), which is where the dialog
learns the label the user sees in the panel.

### 6.4.1 One focused layer, one route (the 2026-10-20 report)

The first-entry bridge above was necessary but not sufficient: the same report came back as
*“when used multiple times … after the loading of tiles finished it loads only the base map
in 3D, with no LiDAR — mostly in the PWA”*. The reason was that the deck and the prefetch
were still allowed to draw the same layer from **two different routes**.

A mirrored raster carries up to two: the live layer's own `dl2d://<deck key>` route (which
is what `prefetchTiles()` fills — its URL builder, its `preferProxy`/healed-host decision,
then `blendedTile()` and `clipFocusedTile()`), and the **registry template** the item's
`defId` resolves to (`dl3d://…` for the bbox builders, `?layer=…` once `needsProxy()` is
true, or the provider URL). `rasterTilesFor()` preferred the registry whenever a `defId`
was present — true for exactly the nine country products — so a prepared disc was drawn
from a source that has never heard of `state.primed`. Two consequences:

* the prefetch heals a host that cannot answer with CORS by writing
  `state.proxyHosts[host]`, and `rasterTilesFor()` passes `Object.keys(state.proxyHosts)`
  to the registry — so the moment the download succeeded through the proxy, the 3D source
  became a **live per-tile `?layer=` template**: the "ready" disc was downloaded again,
  without a disc and without the preparation, and on a cold proxy it came back empty;
* for the tile builders (swisstopo, EA, Dataforsyningen, Lantmäteriet, the French WMS) the
  provider URL was fetched directly by MapLibre with `crossOrigin`, whatever the prefetch
  had decided — a host that only renders in 3D through the proxy returned nothing.

The repeat-use/PWA flavour follows from state, not from the service worker: the disc is
applied *before* the download, so the live rebuild only starts when 3D opens (after the
progress bar finished); `state.proxyHosts` is already populated from earlier tiles in the
same session; and the per-tile re-requests are the ones that lose to MapLibre's
cancel-while-zooming on a phone.

**The rule now: the focused LiDAR layer always draws through `dl2d://`**, def-backed or not
(`rasterTilesFor(item, focused)`; the single exception is a descriptor with
`render: 'none'`, which has no per-tile route at all). Prepared bytes are answered from
`state.primedOut`; anything the budget trimmed or that failed goes through the same
`fetchTile()` proxy/CORS decision the download made and is clipped to the disc. The
source's recorded `mode` is therefore `live 2D layer`, and `watchSourceHealth()` no longer
applies its 7 s "no direct tile → flip the host to the proxy" guess to it. Three smaller
defects on the same path were fixed with it: `maxzoom` is floored at the source's
`minzoom`; `maskOf()` recognises the `def:` form of a registry id (a def-drawn LiDAR layer
was bounded to the disc but never clipped to it); and the `dl3d` handler's prepared-disc
lookup also accepts `focus.lidarKey === 'def:' + defId`. A focus that still cannot be
drawn now writes one line per distinct reason into `status().errors` instead of leaving a
silent base map.

`LIDAR_3D_DISC_ROUTE.md` holds the long form; the regression is §4d-quater of
`test-lidar-3d-focus.js` (a def-backed `AHN` layer must render from
`dl2d://2d.C9/{z}/{x}/{y}`, bounded to the disc and capped at the plan — it fails on the
old code with `dl3d://lidar.nl-ahn/{z}/{x}/{y}`).

When the fetch finishes and the 3D view opens, the window does not disappear:
it **folds itself into a slim pill** pinned to the bottom centre of the 3D view
(the sheet's layer name, the radius, how many tiles are ready, and a ▴ arrow),
so the prepared area stays reachable without ever covering the terrain. The pill
is the same dialog minimized, not a reopened copy: clicking it — arrow and all —
expands the full window over the running 3D view (live mode, so confirming
re-points the view), cancelling an expanded window folds it back into the pill,
and removing the LiDAR from the 3D bar takes the pill away with the focus. That
it only ever shows over the 3D view is pure CSS (`body:not(.is-3d)` hides the
folded host); closing 3D folds it out of sight, returning to 3D brings it back.
`DetectLabLidar3D.minimizeDialog()` / `.expandDialog()` drive it by hand and
`status().dialog.minimized` says which form the window is in.

Anything the viewer knows about the focus is readable without a debugger:

```js
DetectLabMap3D.status().lidar      // focus, off, drawn, notes, primed {entries,bytes,hits,budget}
DetectLabLidar3D.status()          // the dialog: layers, plan (levels, trimmed, route), lastPrepare
DetectLabLidar3D.MAX_RADIUS_KM     // 10
```

The 3D bar grows a LiDAR line while a disc is loaded (which layer, how wide, how many tiles
ready) with **Change the area** and **Remove from 3D** buttons; those announce
`detectlab:map3d-lidar-change` / `detectlab:map3d-lidar-clear` and the focus module owns the
rest — the viewer never opens a dialog of its own. **Change the area** reopens the same
dialog: with 3D closed it prepares a new disc before opening (`mode: 'gate'`), with 3D open
it re-points the running view in place (`mode: 'live'`, the viewer is not reopened and the
dialog steps aside once the new tiles are in). Removing LiDAR from 3D
(`clearLidarFocus()`) draws neither LiDAR layer and says so.

There is one state the dialog cannot reach: a LiDAR layer on the 2D map **without** a
prepared disc (a LiDAR layer switched on while 3D is already open, or 3D opened from the
console). The viewer then drapes **no** LiDAR layer — opening a national pyramid behind the
user's back is exactly the load this path exists to prevent — records
`{reason: 'unprepared', count}` in `status().lidar.notes` and the bar shows
“LiDAR: prepare the area for 3D”, whose button is the dialog. Nothing is silently blank:
the state is named, and it is one press away from being prepared.

### 6.4.2 A canvas tile is not ready when createTile() returns (the 2026-10-21 report)

*“LiDAR in 3D doesn't work properly for Denmark: it says it loads around 200 tiles, the
LiDAR is visible only at one zoom level, and zooming in more shows only the base layer.”*

The count was right — a 1 km disc in Denmark is planned as 196 tiles on a desktop and 197
on a phone (z13–z17). The disc was prepared and applied; what MapLibre was handed was a
disc of **transparent** images.

`js/dataforsyningen-dhm-layer.js` is the one country product that paints asynchronously: its
tiles live on a WMTS `View1` grid in EPSG:25832, so `createTile()` returns an **empty
canvas** and calls `done(null, canvas)` only after it has fetched a mosaic of View1 tiles
through `/api/geo/dk-dhm` and warped them in. `renderTile()` in `js/map3d-mirror.js`
snapshotted every canvas on the next frame, before a single pixel existed — so each
prepared tile became a transparent PNG, stored in `state.primedOut` and served by
`dl2d://` in 3D, with the base map showing through.

Coarse tiles whose View1 sources were still in the layer's own source cache painted in a
microtask, ahead of that timer, and did appear — which is why the relief was visible at one
zoom level and vanished when the user zoomed onto the deep, uncached levels.

`renderTile()` now follows Leaflet's own rule (`L.GridLayer._addTile`): a `createTile()`
that declares `done` owns the moment the pixels exist (wait for it; a `done` that fires
before `createTile()` returns counts too), while a one-argument `createTile()` is read on
the next frame (`js/roman-roads.js` relies on that). A canvas whose `done` never arrives is
handed over as it is when the tile deadline passes rather than rejected — an errored tile
draws nothing at all. The plan, the disc clip, the prepared cache, the `dl2d://` route and
the source ceiling are unchanged; past `plan.zoomTo` (z17 here) the deepest prepared level
is overzoomed exactly as described in §6.4/`LIDAR_3D_MOBILE_ZOOM.md`.

`DENMARK_LIDAR_3D_CANVAS.md` holds the long form; the regression is §4h-bis of
`test-lidar-3d-focus.js` (an asynchronous Danish-style canvas must come back painted, a
one-argument canvas must not wait for a `done` that never comes, and no prepared tile of a
Danish disc may be a transparent placeholder).

### 6.4.3 Whole layers, or only the 1 km disc (the 2026-10-26 request)

*“All the LiDAR layers should be able to load in 3D entirely, not only 1 km — but there
must remain the option of loading them only for that 1 km radius, and in that option the
dialog must include all the layers that are turned on at that moment, for the user to
choose which of them get loaded for the 1 km radius.”*

Opening 3D with a LiDAR layer switched on now starts with a **scope**, two buttons at the
top of the same window:

* **Whole layers** (`scope: 'full'`, the default) — nothing is bounded, clipped, planned or
  downloaded in advance. The chosen layers are draped the way the 2D map draws them: over
  their whole extent, at any zoom the layer itself supports, tiles requested as the camera
  moves. A national pyramid is not a “disc that never grows”; it is the layer, and this is
  the scope that lets it be seen beyond the opening kilometre.
* **Only 1 km** (`scope: 'disc'`) — the flow of §6.4 unchanged: one fixed 1 km radius around
  a point, whole zoom levels planned from the layer's own limits, downloaded through the
  viewer's own tile pipeline before the view opens, the disc outlined on the 2D map, the
  raster source bounded to it and capped at `plan.zoomTo`. What changed here is the list:
  every LiDAR layer switched on is listed and **each ticked layer gets its own plan**, and
  the plans are downloaded together (interleaved level by level) under one progress bar.

The layer list is the same in both scopes — `js/lidar-3d-focus.js → activeLayers()`, read
fresh from `window._lidarGroup` and the mirror — so a layer switched on while the window is
open is neither silently skipped nor assumed; the list is rebuilt whenever the dialog is
opened or the 2D visibility changes.

**The focus grew a list.** `setLidarFocus()` normalises a legacy single-layer focus into
`layers[0]`, so every caller from before this change keeps working:

```js
{ scope: 'full' | 'disc',
  layers: [ { key, lidarKey, defId, label, plan? } ],   // every ticked layer
  key, lidarKey, defId, label, labels,                  // the first layer, for old callers
  mask, bounds, plan, lat, lng, radiusKm, at }           // disc only
```

and the viewer reads it with `focusLayers()`, `focusMatches()`, `maskOf()`,
`planForLayer()` and `keyNamesFocusLayer()`, all of which understand both key spaces (the
deck key `2d.<stamp>` and the LiDAR family key `lidar.ro1m` / `def:lidar.fr-mnh`).
`sameFocus()` compares every layer and every prepared ceiling, so adding or removing one
layer rebuilds exactly the affected sources — and `refreshFocusedSource()` only touches the
sources that were marked `focused`, so the base map is not re-downloaded.

**What “full” drops, concretely** (`js/map3d-terrain.js`):

| mechanism | `scope: 'disc'` | `scope: 'full'` |
| --- | --- | --- |
| `spec.bounds` on the focused raster source | the disc's rectangle | absent — MapLibre may ask for any tile |
| `spec.maxzoom` | `min(layer max, plan.zoomTo)` | the layer's own maximum, uncapped |
| per-tile clip (`focusExcludesTile()` / `clipFocusedTile()`) | rim feathered, outside = blank | `maskOf()` returns null: no clip at all |
| 2D disc outline | drawn, dashed, with centre dot | cleared |
| camera teleport (`focusCamera()`) | framed on the disc | camera left where the 2D map was |
| prefetch | `prefetchTiles()` before the view opens | none — the decision settles immediately |
| tile route | `dl2d://` (or `dl3d://` for registry-only products) | the same route, per tile, on demand |

Both render paths agree: `renderRaster()` (mirrored layers) and `renderRegistryRaster()`
(the nine country products) compute `discFocus = focused && focusScope() === 'disc'` before
touching `bounds` or `maxzoom`, so a whole-layer focus can never inherit a stale disc
ceiling. The route rule of §6.4.1 still holds in both scopes: a focused layer is drawn
through `dl2d://` (the live 2D layer's own URL and the viewer's own CORS/proxy decision),
never through a registry template that never heard of `state.primed`.

**When a focus cannot be drawn it says why.** A whole-layer focus is not a promise that
every tile will arrive — a provider can be down or a layer switched off mid-view. The
standing rule of `LIDAR_3D_DISC_ROUTE.md` applies unchanged: `status().lidar` carries
`{focus: {scope, layers[]}, off, drawn, notes, primed}`, the bar surfaces the note, and
`status().errors` receives a line rather than leaving a blank 3D view unexplained.

`test-lidar-3d-focus.js` §5a–5c walks the whole thing: two scope buttons, checkboxes for
every layer, the whole-layer confirm with **zero** tile requests, the pill naming whole
layers, back to the disc with both layers still ticked, untick/re-tick re-planning, the
point pick, and the confirm that downloads the sum of both plans. §4d-quater-bis asserts
the viewer half on a real deck: no `bounds`, an uncapped `maxzoom`, both sources drawn, and
a tile on the far side of the world served live instead of being blanked.

### 6.5 Raster refresh in a running 3D view

The refresh action sits beside the bottom-centre **2D** switch and snapshots the
current MapLibre camera centre when tapped (it does not request GPS permission). It
preloads all tile zooms supported by each active non-LiDAR raster source, from that
source's `minzoom` through its native `maxzoom`, keeping only tiles that intersect a
1 km ground-radius disc. The current basemap, DEM and configured service hillshade
are included when present. LiDAR stays on §6.4's separate, chosen-disc flow; vectors,
markers, heatmaps and image overlays have no raster tile pyramid to preload.

The planner counts the complete request set, emits one zoom level at a time, and
uses the active source templates / live layer URL builders so WMS, proxy and custom
canvas tiles follow the same route as 3D. It does not silently trim zoom levels. The
button displays progress; pressing it again stops after in-flight tiles finish. Once
preparation ends, visible raster sources are reloaded so the current viewport requests
the warmed tiles immediately. Requests use the viewer's modest concurrency (4 on
phones, 6 on desktop), and individual failures are reported rather than blocking the
whole refresh. The public entry point is `window.DetectLabMap3D.refreshTiles()`.

## 7. Mobile — WebGL, why 3D used to snap straight back to 2D, and what changed

**Symptom (iPhone Safari, mobile browser *and* installed PWA):** tapping **3D** made a
dark rectangle flash once and the app went straight back to the 2D map, with no error
anywhere. Desktop was unaffected.

**Root cause.** MapLibre GL 5 acquires its WebGL context *inside the constructor* and
throws synchronously when it cannot:

```js
gl = canvas.getContext("webgl2", attrs) || canvas.getContext("webgl", attrs);
if (!gl) throw new Error("Failed to initialize WebGL");   // ← vendored js/maplibre-gl.js
```

On iOS Safari that happens on real hardware. The context was requested at the full
`devicePixelRatio` (3 on a Face-ID iPhone → ~1170 × 2532 ≈ 3 Mpx) with
`powerPreference: 'high-performance'`, after the page already holds every Leaflet tile
image — WebKit refuses the allocation and returns `null`. A desktop GPU never reaches that
ceiling, which is why the same build worked on a laptop.

**Why it looked silent.** That throw landed in `open()`'s `catch`, which removed
`body.is-3d`. That class is what makes `#map3d-surface` display at all
(`#map3d-surface { display: none }` without it) — and the veil carrying the error message
lives *inside* the surface. So the failure path hid the very message it was trying to show.
The user saw a flash; the console had the reason.

**What changed** (`js/map3d-terrain.js`, `css/map3d-terrain.css`, `js/layer-registry.js`):

| # | Change | Why |
| --- | --- | --- |
| 1 | `deviceProfile()` → the phone's `pixelRatio`, `maxCanvasSize` and `canvasContextAttributes` are passed **into** `new maplibregl.Map()` | `setPixelRatio(1)` *after* construction could only resize a context that had already been allocated at ×3 — by which point WebKit had already said no |
| 2 | Phones: `pixelRatio: 1`, canvas ceiling 2048², no MSAA, `powerPreference: 'low-power'`, tile cache 64 instead of 320 | 320 decoded tiles is ~80 MB of texture on top of the framebuffers; 4× MSAA quadruples the colour buffer |
| 3 | `webglProbe()` runs before the 1 MB SDK download, and releases its context (`WEBGL_lose_context`) | A device that cannot do 3D gets an explanation instead of a flash — and the probe does not itself eat one of WebKit's handful of contexts |
| 4 | A refused context is retried **once in safe mode**: `pixelRatio` 1, canvas 1024², cache 32, no stencil, no sky, no hillshade — **DEM kept** | The relief is the reason 3D exists; everything that is decoration, not map, is shed first |
| 5 | `fail3D()` keeps `body.is-3d`, records `state.lastError`, and shows **Try again** + **Back to 2D** (44 px touch targets, scrollable detail) | The message can no longer hide itself; the exact WebGL reason is quotable in a bug report |
| 6 | `webglcontextlost` / `webglcontextrestored` are handled | iOS reclaims the GPU context on backgrounding or memory pressure; MapLibre then painted a black canvas with no visible reason |
| 7 | Phones get a 45 s SDK timeout instead of 15 s | 1 MB of JS on cellular; a timeout is indistinguishable from a crash |

Desktop is unchanged except that antialiasing now actually applies — MapLibre 5 reads
`antialias` under `canvasContextAttributes`, so the old top-level `antialias: true` was
silently ignored.

**Diagnosing a device that still cannot open 3D** (console):

```js
DetectLabMap3D.status().webgl        // { webgl2, webgl, error }
DetectLabMap3D.status().deviceProfile
DetectLabMap3D.getLastError()        // the exact message, e.g. "Failed to initialize WebGL"
```

Regression suite: `node test-map3d-mobile.js` (9 groups — profile, constructor options,
safe-mode retry, visible failures, touch targets, probe, context loss, phone timeouts, PWA
cache).

## 8. Performance notes (desktop and narrow mobile)

* Nothing but the registry (~107 kB) and the viewer (~60 kB) is parsed with the page;
  **MapLibre GL (1.0 MB) and any tile are only fetched when 3D is opened**.
* Closing 3D destroys the MapLibre map and its sources; the Leaflet map underneath is
  never touched, so the 2D page does not pay for 3D. While 3D is on the Leaflet panes are
  only *hidden* (`visibility`), so the 2D view comes back instantly — and the browser is
  never asked to rasterise two full maps at once.
* Only the layers that are **switched on** get a 3D source; each layer is one
  `raster` source with `raster-fade-duration` set from the registry config.
* On narrow viewports the MapLibre scale widget is hidden
  (`@media (max-width: 720px)`), the control bar moves under the search bar and keeps its
  own scroll, the device pixel ratio is capped *in the constructor* and the DEM zoom
  ceiling is lowered; the 3D button stays reachable bottom-centre. Terrain + hillshade at
  a 3× exaggeration is the expensive combination on old phones — the shipping
  constant is 1.4×, which is in that range.
  See §7 for the phone budget (pixel ratio, canvas ceiling, tile cache, MSAA).
* Per-tile layers (`dl3d://`) cost one extra URL build per tile in the browser — a
  function call, no extra request. Through the proxy they are one hop like any other
  layer, with the same in-memory + CDN caching.
* The proxy adds one hop per tile for the ~75 layers that
  use it. Tiles are cached in memory (256 entries / 6 h) and on the CDN
  (`s-maxage ≥ 604800`), so panning an area twice costs one upstream request. If you
  later enable a CORS header on a provider, flip its `cors` field in the registry to
  `'yes'` and its tiles go direct.
* **Tile request order** is no longer MapLibre's mixed-zoom `coveringTiles()`
  distance (which, on a pitched/terrain view, asked for coarse tiles in the
  distance before the ones under the camera). The vendored build carries the
  upstream fix, so every raster source — historical WMS sheets included —
  requests the tiles under the point of view first. The cause, the patch, the
  cache busting and the remaining phone work (512 px WMS tiles, centre-first
  prefetch) are in **`MAP3D_TILE_ORDER.md`**.

## 9. Verification performed / how to verify

* `node test-map3d-tile-order.js` — the order MapLibre asks for tiles in: the
  patched `coveringTiles()` key is extracted from the shipped bundle and run
  (a near z17 tile must sort before a far z13 one, and the order must be
  monotonic in true distance across z12–z18), plus the SDK tag and shell-cache
  bump. See `MAP3D_TILE_ORDER.md`.
* `node test-map3d-mobile.js` — the phone/WebGL path: device profile, constructor options,
  safe-mode retry, failures that stay visible, touch targets, the context-loss watch.
* `node test-map3d-terrain.js` — wiring, registry integrity, “defined once” guards, a
  headless boot of the viewer (style, terrain, sky, status), the proxy's URL builder,
  validator, re-projection and blank-tile contract, **the per-tile route for all nine
  country LiDAR layers** (module → `tileUrlAt` → `dl3d://` → proxy) and the
  **91/91-draped** diagnostics. It also covers §6: the sibling merge (25 001 polylines →
  2 bundles, cache, `invalidate()`, opacity change, the per-group and deck budgets with
  their `capped` reports), the blend descriptor for `lidar-ro1m-tiles`, the pixel maths of
  the repaint against the CSS formula, the repaint + cache running end-to-end with the
  layer `map-app.js` really builds, and the idempotent `setData`/`setTiles` calls.
* `node test-lidar-3d-focus.js` — LiDAR in 3D (§6.4): the wiring (`_dlLidar` tags, the
  scanner stand-down, the version tags), the disc maths (bounds, tile windows, the
  circle-vs-rectangle classification, the feathered rim, the blank tile), the planner (a
  disc stays bounded, the zoom window respects the layer's own limits, every level is
  planned **whole**, the order is centre-first at every level, trimming is reported and
  counted in the estimate, a 5 km disc really prepares two levels coarser — the reason
  the entry is fixed at 1 km — and the **mobile depth regression**: a 390 × 844 phone and
  a 1280 × 800 desktop prepare the same absolute zoom range to the layer's native maximum,
  145 vs 144 tiles on a z17 pyramid, with no level left half-prepared at z18) and the
  viewer end-to-end in a headless sandbox: the mirror describes both tagged layers, the
  one-layer rule keeps exactly the focused layer and reports the rest (`focused`, `count`),
  a LiDAR layer with **no** prepared disc is draped by nobody and reported as
  `unprepared`, an explicit removal draws neither and says `off`, the focus clips only its
  own layer, a prefetch over the plan makes **one request per tile and none on a second run**,
  `isPrepared()` answers, and the entry gate is honoured (refusal keeps 3D shut, a pending
  gate is shared, an allowed gate reaches the surface). The dialog is driven through a
  minimal DOM: the fixed 1 km area (no slider, no chips), the one-layer message and the
  radio group (choosing a layer re-plans the same 1 km disc), the
  point pick (including Escape), the progress block, the 2D disc, the two ends of the
  gate — confirm opens, cancel does not — and the bar's own two buttons: **Change the
  area** reopening the dialog in gate mode when 3D is closed (then opening the view on the
  prepared disc) and in live mode when 3D is open (the view stays, the focus is
  re-pointed), and **Remove** clearing the focus and the 2D disc. §4d-quater pins the
  route rule of §6.4.1: a def-backed (`_dlDefId` + `AhnLidar`) focused layer must be
  drawn from `dl2d://2d.<stamp>/{z}/{x}/{y}`, bounded to the disc and capped at the
  prepared plan — on the old code it was built from `dl3d://lidar.nl-ahn/…` and the
  assertion fails.
* `node tools/probe-3d-blend.js` — the same two mechanisms with the **real Leaflet**
  bundle and the numbers that justify the budgets: the `ro1m` descriptor and tile URL,
  a 200 000-polyline featureGroup (10 bundles, 200 000 features, ~1 s for the first pass,
  ~20 ms for each cached poll pass, 292-character signature), and the blend error against
  the CSS it replaces.
* `curl 'http://localhost:4173/api/map3d/tile?layer=lidar.pl-nmt&z=12&x=2266&y=1348'`
  returns the labelled blank tile (`X-Map3D-Upstream: error`) in a sandbox without
  egress; on the live deploy the same call returns the GUGiK relief tile.
* `node tools/map3d-dev-server.mjs` → `/api/map3d/status` for the live
  per-layer classification, `/api/map3d/tile?...` for a single tile.
* In the browser (cannot be done from a sandbox without egress): open 3D over a
  mountainous area (Alps/Carpathians), switch on a historical sheet, watch the console
  for CORS/4xx/5xx and confirm the layer list at the top of the bar marks it **on**. A
  host that fails appears as `— switching to the proxy` in the console and then recovers.

## 10. Adding a new layer so it appears in 2D **and** 3D

1. Add **one entry** to `js/layer-registry.js` (the panel group order, the 2D pane
   z-index and – for a WMS – the service facts):
   ```js
   {
       id: 'premium.my-sheet', group: 'hist-premium', z: 660, kind: 'wms',
       title: { ro: 'Foaia mea', en: 'My sheet' },
       url: 'https://example.org/geoserver/wms', layer: 'workspace:layer_3857',
       format: 'image/png', transparent: true, version: '1.1.1',
       minZoom: 6, maxZoom: 20, opacity: 0.8, tileSize: 256,
       attribution: '© Provider',
       cors: 'unknown', proxy: 'auto',        // 'yes' | 'no' | 'unknown' + 'auto' | 'always' | 'never'
       bounds: [[44.0, 20.0], [49.0, 30.0]],  // optional WGS84 footprint
       ui: { toggle: 'mySheetToggle', slider: 'mySheetOpacitySlider', pct: 'mySheetPct' }
   }
   ```
   (`crs`/reprojection, `params`, `time`, `alt`, `resolve()` for runtime layers: see the
   entries already in the file.)
2. Create the 2D layer from it — in `js/map-app.js` that is one line:
   ```js
   var layer = L.tileLayer.wms(DL.url2d('premium.my-sheet'),
       DL.wms2dOptions('premium.my-sheet', { pane: 'pane_my_sheet' }));
   ```
   (`L.tileLayer(DL.url2d(id), DL.tile2dOptions(id, {...}))` for XYZ/ArcGIS pyramids.)
3. Add the row + switch/slider to the panel in `index.html` and point the registry's
   `ui` block at those element ids — that is how 3D learns whether the layer is on and
   how opaque it should be.
4. Done. 3D needs **no** change: the viewer walks the registry, reads state from the 2D
   controls, stacks by `z` and picks direct-vs-proxy from `cors`/`proxy`. If the host is
   not CORS-safe, `proxy: 'auto'` already routes it through `/api/map3d/tile`; nothing
   else to do.
5. A **module-backed** layer (a country LiDAR module that builds its own URL) declares
   only *how* to call that module — nothing is copied into the registry:
   ```js
   {
       id: 'lidar.xx-mine', group: 'lidar', z: 610, kind: 'dynamic',
       builder: { module: 'XxLidar', fn: 'tileUrl', kind: 'bbox' },  // or kind: 'tile'
       url: 'https://provider.example/wms', layer: 'relief', format: 'image/png',
       transparent: true, tileSize: 256, minZoom: 6, maxZoom: 20,
       ui: { toggle: 'xxLidarToggle', select: 'xxLidarModeSelect' },  // mode dropdown
       cors: 'unknown', proxy: 'auto'
   }
   ```
   `kind: 'bbox'` (WMS `GetMap`, ArcGIS `exportImage`) is served through `dl3d://`;
   `kind: 'tile'` needs `fn(mode, z, x, y)`. Both work in the browser and in the proxy.
   A WMS with a product dropdown instead of a module uses `modes: { key: { label, layer } }`
   (see `lidar.fr-mnh`) — the 2D code then reads it with `DL.modes(id)`.
6. Keep it honest: `node test-map3d-terrain.js` fails if the same service fact starts
   being written twice (URL, `LAYERS`, format, version, attribution, France's product
   names) or if a registry layer has no way to be draped.
