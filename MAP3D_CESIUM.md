# “Cesium” — the alternative 3D engine (quantized-mesh terrain)

Date: 2026-10-24 · Files: `js/layer-registry.js`, `js/map3d-terrain.js`,
`css/map3d-terrain.css`, `index.html` (unchanged tags), `sw.js` (unchanged)
Test: `node test-map3d-cesium.js`

## The ask

> also add this basemap alternative named "Cesium" for 3D mode:
> MapTiler `terrain-quantized-mesh-v2` TileJSON
> (`https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/tiles.json?key=…`,
> tiles `…/{z}/{x}/{y}.quantized-mesh-1.0?key=…`)

## Why this is an engine, not another raster source

The supplied TileJSON is **terrain**, in `quantized-mesh-1.0` (a binary TIN,
EPSG:4326 tiling, `octvertexnormals`, z0–15). The existing 3D mode is
MapLibre GL, whose DEM is a `raster-dem` source (Terrarium / Mapbox-RGB
encodings) — it cannot decode quantized-mesh tiles. Feeding those URLs to
MapLibre would paint nothing.

So “Cesium” is implemented the way the format intends: as a **real second
3D engine**. Picking **Cesium** in the 3D basemap picker
(`#map3d-basemap`, next to Imagery / Topographic / Terrain ArcGIS):

1. lazy-loads CesiumJS 1.131.0 (jsDelivr, with unpkg and cesium.com
   fallbacks; `CESIUM_BASE_URL` derived from the URL that won, so workers
   and assets resolve from the same folder),
2. creates a `Cesium.Viewer` in `#map3d-cesium` inside the existing 3D
   surface (same veil, bar, attribution and 2D⇄3D switch),
3. sets its terrain from
   `CesiumTerrainProvider.fromUrl(cesium.tilesJson, { requestVertexNormals: true })`
   — Cesium resolves the TileJSON's `tiles` template, `available` ranges
   and extensions itself,
4. drapes the ArcGIS basemap active underneath as the globe's imagery
   (`UrlTemplateImageryProvider` over the registry URL:
   Imagery → World Imagery, Topographic → World Topo,
   Terrain → World Terrain Base),
5. hands the camera over from MapLibre (centre/zoom/bearing/pitch →
   destination/heading/pitch, zoom converted through Web-Mercator
   ground resolution).

Picking an ArcGIS entry again destroys the Cesium viewer, hands its
camera back to MapLibre (`jumpTo`) and routes the choice through the
shared `setArcgisBasemap()` as before. Closing 3D does the same hand-off
before `cameraTo2D()` writes the camera back to Leaflet. The Reset /
North / Flat buttons and terrain exaggeration
(`scene.verticalExaggeration`) act on whichever engine is live.

## What Cesium does not draw

The mirrored deck — every WMS/LiDAR/vector/cluster layer the 2D map is
showing — is a MapLibre feature of `js/map3d-terrain.js` and is **not**
re-drawn by the Cesium globe. In Cesium mode you get the quantized-mesh
terrain + the draped ArcGIS imagery; switch back to an ArcGIS entry for
the full mirrored deck. The 2D Leaflet basemap is never changed by the
Cesium entry (it is a 3D-only alternative; the ArcGIS selection stays
whatever it was and is what gets draped).

If CesiumJS or the terrain fails to load, the viewer is torn down, the
picker reverts to the ArcGIS entry and the MapLibre deck stays in charge
(the error is in `status().lastError` / `status().errors`).

## Configuration

Single source of truth: `MAP3D_DEFAULT.cesium` in `js/layer-registry.js`,
resolved by `DetectLabLayers.cesiumTerrain()` and exposed in
`diagnostics()` and `DetectLabMap3D.status().cesium`. Override without
code edits:

```html
<script>
window.DETECTLAB_MAP3D = {
  cesium: {
    tilesJson: 'https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/tiles.json?key=YOUR_KEY',
    tileTemplate: 'https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/{z}/{x}/{y}.quantized-mesh-1.0?key=YOUR_KEY'
  }
};
</script>
```

The committed key is the same public MapTiler key the MapTiler hillshade
layers already ship in `js/map-app.js`. Programmatic hooks:
`DetectLabMap3D.setBasemapCesium()`, `.getEngine()`, `.getCesiumViewer()`,
`.status().engine`.

## Verification

- `node test-map3d-cesium.js` — registry resolution (tiles.json, tile
  template, format/extensions, z0–15, attribution, pinned SDK + fallbacks),
  picker wiring, no hard-coded service URL in the viewer, zoom↔height
  camera round-trip, closed/failure paths staying on MapLibre.
- `node test-map3d-terrain.js`, `node test-map3d-slider-layout.js`,
  `node test-map3d-startup.js`, `node test-3d-switch-base-layer-column.js`
  — unchanged behaviour of the MapLibre deck.
- Live tile/CDN fetches could not be probed from the sandbox (MapTiler and
  the CDNs are outside its network allowlist); on a real deployment, open
  3D → pick **Cesium** and confirm quantized-mesh tiles
  (`terrain-quantized-mesh-v2/{z}/{x}/{y}…`) return 200 in the Network
  panel and the globe drapes the ArcGIS imagery over the mesh.
