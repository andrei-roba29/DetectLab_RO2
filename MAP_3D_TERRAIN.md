# 3D terrain view (2D ⇄ 3D) — how it works, what is served, how to extend it

*Added in `js/layer-registry.js`, `js/map3d-terrain.js`, `css/map3d-terrain.css`,
`netlify/lib/map3d-tile.mjs`, `netlify/lib/map3d-country-modules.mjs`,
`netlify/functions/map3d-tile.mjs`, `tools/map3d-dev-server.mjs`; wired in
`index.html`, `sw.js`, `netlify.toml` and consumed by `js/map-app.js` /
`js/historical-eu-maps.js`. Regression suite: `node test-map3d-terrain.js`.*

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

* **Toggle** – the “3D” button, or `window.DetectLabMap3D.toggle()`.
* **Camera** – opening 3D keeps the 2D centre/zoom (and Leaflet's bearing, if the
  rotation control was used); closing 3D writes the 3D camera back into Leaflet.
* **Layers** – the *same* checkboxes decide what 3D draws. Switch a historical map on in
  2D, and it is draped in 3D; drag its opacity slider, and 3D follows live.
* **Controls** – oblique pitch, bearing, terrain exaggeration (0.5–4×), reset view,
  navigation/scale/terrain controls, and a status list that says for every layer *how* it
  is being served (direct / via the same-origin proxy / per tile) and why.
* **Layout while 3D is on** – the Leaflet panes stop painting and Leaflet's own controls
  (zoom, locate, measure — they move the *2D* camera) are hidden, so nobody clicks a
  button that changes a map they cannot see; MapLibre brings its own navigation, terrain
  and scale controls. The 3D bar sits bottom-left and the 2D⇄3D toggle bottom-centre,
  while the search bar, the layer panel and the opacity mirror keep their exact 2D
  position and stay fully usable.

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
    exaggeration: 1.4                // 0.5 … 4
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
then names the module in `reason` instead of dropping the layer, and the 3D status list
shows it in red. The relief you see under a historical sheet always comes from the DEM,
never from the layer provider — a WMS only ever contributes flat imagery.

## 5. Known limitations (please read before reporting “misalignment”)

1. **Historical maps do not line up with modern terrain.** A 1855 sheet is draped on
   today's SRTM/ETOPO DEM; where the landscape changed (quarries, mines, drained
   marshes, river regulation) the relief will not match the printed map. That is a
   property of the data, not of the viewer. Raise/lower **terrain exaggeration** to make
   the draping easier to judge.
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
   whole 3D view; the layer status list then shows the host as failing.
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

## 6. Performance notes (desktop and narrow mobile)

* Nothing but the registry (~107 kB) and the viewer (~60 kB) is parsed with the page;
  **MapLibre GL (1.0 MB) and any tile are only fetched when 3D is opened**.
* Closing 3D destroys the MapLibre map and its sources; the Leaflet map underneath is
  never touched, so the 2D page does not pay for 3D. While 3D is on the Leaflet panes are
  only *hidden* (`visibility`), so the 2D view comes back instantly — and the browser is
  never asked to rasterise two full maps at once.
* Only the layers that are **switched on** get a 3D source; each layer is one
  `raster` source with `raster-fade-duration` set from the registry config.
* On narrow viewports the MapLibre navigation/terrain controls are hidden
  (`@media (max-width: 720px)`), the control bar moves under the search bar and keeps its
  own scroll, the device pixel ratio is capped and the DEM zoom ceiling is lowered; the
  3D button stays reachable bottom-centre. Terrain + hillshade at a 3× exaggeration is the
  expensive combination on old phones — prefer 1.0–1.5× there.
* Per-tile layers (`dl3d://`) cost one extra URL build per tile in the browser — a
  function call, no extra request. Through the proxy they are one hop like any other
  layer, with the same in-memory + CDN caching.
* The proxy adds one hop per tile for the ~75 layers that
  use it. Tiles are cached in memory (256 entries / 6 h) and on the CDN
  (`s-maxage ≥ 604800`), so panning an area twice costs one upstream request. If you
  later enable a CORS header on a provider, flip its `cors` field in the registry to
  `'yes'` and its tiles go direct.

## 7. Verification performed / how to verify

* `node test-map3d-terrain.js` — wiring, registry integrity, “defined once” guards, a
  headless boot of the viewer (style, terrain, sky, status), the proxy's URL builder,
  validator, re-projection and blank-tile contract, **the per-tile route for all nine
  country LiDAR layers** (module → `tileUrlAt` → `dl3d://` → proxy) and the
  **91/91-draped** diagnostics.
* `curl 'http://localhost:4173/api/map3d/tile?layer=lidar.pl-nmt&z=12&x=2266&y=1348'`
  returns the labelled blank tile (`X-Map3D-Upstream: error`) in a sandbox without
  egress; on the live deploy the same call returns the GUGiK relief tile.
* `node tools/map3d-dev-server.mjs` → `/api/map3d/status` for the live
  per-layer classification, `/api/map3d/tile?...` for a single tile.
* In the browser (cannot be done from a sandbox without egress): open 3D over a
  mountainous area (Alps/Carpathians), switch on a historical sheet, watch the console
  for CORS/4xx/5xx and confirm the layer list at the top of the bar marks it **on**. A
  host that fails appears as `— switching to the proxy` in the console and then recovers.

## 8. Adding a new layer so it appears in 2D **and** 3D

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
