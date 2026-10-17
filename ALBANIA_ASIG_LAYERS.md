# Albania — ASIG geoportal layers (geoportal.asig.gov.al)

Added 2026-10-17. Nine layers from **ASIG — Autoriteti Shtetëror për Informacionin
Gjeohapësinor** (the Albanian State Authority for Geospatial Information), streamed
live from the state geoportal — nothing is downloaded or pre-generated, no key, no
token, HTTPS only.

| Panel row | ASIG catalogue (`LAYERS`) | Notes |
|---|---|---|
| Topographic map 1:50k | `Topografike:50K_Topografike` | opaque PNG basemap-style raster |
| Orthophoto 1999 | `Orthophoto:Ortofoto_1999` | opaque PNG |
| Orthophoto 1994 | `orthophoto_2015:OrthoImagery_20cm` | opaque **JPEG** — see §Labels |
| DSM (hillshade) | `DSM:Dsm_Hill_Group` | transparent PNG, 60 % by default |
| LiDAR | `Dtm_2015:Hillshade_2015_group` | transparent PNG, **50 %** by default |
| **Protected Sites ›** Heritage Sites | `iktk:zonatembrojturatetrashegimisekulturore22_07_2026` | transparent overlay |
| Natural Protected Sites | `akzm:zonat_mbrojtura_081124` | transparent overlay |
| Cultural Protected Sites | `iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026` | transparent overlay |
| Environment: Natural monument | `akzm:monumentet_natyrore_07032023` | transparent overlay |

Draw order (bottom → top), exactly as the integration brief asks: topographic map,
orthophotos, DSM hillshade, LiDAR hillshade (~50 %), then the Protected Sites
(transparent vector overlays), below every app-wide pane (LiDAR z610, heritage
z620, historical z640+). Panes: `pane_albania_raster` (405),
`pane_albania_protected` (407).

Attribution shown on the map while a layer is on:
*“Data: ASIG, Albanian State Authority for Geospatial Information (geoportal.asig.gov.al)”.*

## Where everything lives

- **`js/asig-albania-layers.config.js`** — the single description of the nine layers
  (titles RO+EN, `LAYERS`, format, transparency, zoom limits, opacity, draw order).
  A renamed layer — the protected-sites names carry **publication snapshot dates**,
  see below — is a change to this file only.
- **`js/asig-albania-layers.js`** — renders the panel rows into `#albaniaSubLayers`
  and builds the Leaflet tile layers from the config (nothing is requested before a
  row is switched on; the choice persists in `localStorage`).
- `index.html` — the group row (`#albaniaRow`, Free tab), master switch, expand
  chevron, go-to-Tirana button; script tags.
- `js/layer-registry.js` — mirrors the config into the shared catalogue
  (`albania.<id>`, groups `albania-raster` 405 / `albania-overlay` 407) so the
  diagnostics, the 3D status report and `tools/audit-wms-layers.mjs` see the same
  definitions.
- `js/wms-health.js` — the host is named in `HOSTS`; the rows self-handle failures
  (see §Failure handling).
- `js/map-app.js` — the country filter hooks: the group shows only for **AL** (or no
  country selected).
- `test-albania-asig-layers.js` — 26 offline checks. `WMS_WMTS_LAYER_AUDIT.md` is
  regenerated from the registry.

## Projection strategy: WMS 1.1.1 in EPSG:3857 (not the native WMTS)

ASIG's native CRS is **EPSG:6870** (ETRS89 / Albania TM 2010). The raster products
are confirmed as **WMTS** on the `EPSG:6870` tile matrix set (a non-power-of-two
grid: level 0 is 2×2 tiles, level 7 ≈ 490×499), with a second EPSG:4326 set. This
map — like every other national layer on it — is Web Mercator, so the native tiles
cannot be addressed as XYZ.

The module instead issues **one WMS 1.1.1 GetMap per Leaflet tile**, `SRS=EPSG:3857`,
with the tile's own projected bbox — the same approach as the Polish GUGiK layer
(`js/geoportal-nmt-layer.js`). GeoServer reprojects server-side, so the rasters line
up with OSM, the European LiDAR rows, CORONA and the historical maps with zero
client projection work. If a layer ever starts refusing EPSG:3857, it falls back per
tile to `SRS=EPSG:4326` (lon,lat axis order in 1.1.1) after 6 consecutive tile
errors.

If a dedicated EPSG:6870 map (OpenLayers) is ever built, the WMTS endpoint, matrix
set and `style=default` note are recorded in `endpoints` in the config, and the
brief's verified reference tiles are:

- LiDAR `EPSG:6870:6` col 65 row 83, HTTP 200 image/png
- DSM `EPSG:6870:5` col 28 row 30
- Orthophoto 1999 `EPSG:6870:4` col 18 row 12
- Orthophoto (2015, 20 cm) `EPSG:6870:3` col 2 row 9, image/jpeg
- Topographic 1:50k `EPSG:6870:4` col 12 row 31

Coverage (WGS84): lon 18.773 → 21.179, lat 39.538 → 42.758 (all of Albania); the
Leaflet layers are bounded to it.

## Labels (confirmed with the site owner, 2026-10-17)

- **“LiDAR”** is kept as the row label even though the product is a *hillshade
  derived from the 2015 DTM*, not a point cloud. The row's ⓘ popup says so.
- **“Orthophoto 1994”** is the label the owner asked for. The capabilities publish
  no 1994 layer; the row is wired to `orthophoto_2015:OrthoImagery_20cm` (the 2015
  national orthophoto at 20 cm, JPEG-only). The ⓘ popup names the real product, so
  the provenance is never hidden. If a 1994 mosaic appears in the catalogue later,
  repoint `ortho1994.layers` in the config — nothing else changes.

## The Protected Sites names are snapshots — re-check before editing

`zonatembrojturatetrashegimisekulturore22_07_2026`, `zonat_mbrojtura_081124`,
`zonatembrojturatetrashegimisekulturore_pike13_05_2026`,
`monumentet_natyrore_07032023` embed publication dates; ASIG may publish new
versions under new names. When one of these rows stops drawing, re-check

```
https://geoportal.asig.gov.al/service/wms?SERVICE=WMS&REQUEST=GetCapabilities
```

and update **only** `js/asig-albania-layers.config.js` (search “snapshot”). The test
asserts the exact strings so an accidental edit is loud, not silent.

## Failure handling (government host, no SLA)

- a failed tile degrades to a transparent pixel (`errorTileUrl`), one console warning
  per layer at most;
- repeated failures flip the layer to EPSG:4326 requests once;
- failures continuing after that put **“the source is not answering”** in the row's
  status line — never a silent blank map;
- the layers opt out of the global availability guard (`_detectlabNoGuard`,
  `guard:false` + `selfGuardedReason` in the registry) because the module owns its
  rows; the host is still named in `js/wms-health.js` so a tile-error burst can be
  attributed. `tools/audit-wms-layers.mjs` records the failure signature.

## What is verified — and what still needs a live check

Offline (this repo): config contract, request shape (WMS 1.1.1, SRS/BBOX/axis
order/formats), registry mirror, panel DOM, toggles/opacity/master switch/fallback,
country filter, guard wiring, audit invariants — `node test-albania-asig-layers.js`
(26 checks) plus `test-wms-health.js`, `test-wms-layer-audit.js` and
`node tools/audit-wms-layers.mjs` (0 errors, 106 layers).

Live, on the next deploy — the sandbox could not reach geoportal.asig.gov.al:

1. `curl -sI` one built GetMap per layer (sample URLs:
   `node tools/audit-wms-layers.mjs --layer=albania.lidar --urls`) and confirm
   `200 image/png|jpeg`, no `ServiceExceptionReport` — this also confirms the
   server accepts `SRS=EPSG:3857` for these catalogue names (GeoServer does by
   default; the EPSG:4326 fallback covers the opposite).
2. CORS: tiles are plain `<img>`, so drawing works either way; only canvas reads
   would need `Access-Control-Allow-Origin`. If a 3D drape ever needs pixels,
   route through the existing `/api/map3d/tile` proxy — the registry entries are
   already `proxy: 'auto'`.
3. ASIG's terms of use for web redistribution are not stated in the capabilities —
   verify before commercial promotion; keep the attribution visible.
