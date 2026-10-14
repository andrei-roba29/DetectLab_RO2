# 3D vectors, heritage and WMS speed — 2026-10-14

Reports fixed: some WMS maps load slowly in 3D; some vector layers do not
appear in 3D, or pins appear with different icons (OSM Places, Roman
Empire–DARE); the heritage (Patrimoniu) layer showed only polygons in 3D —
no points and no 600 m radii.

## Root causes

1. **Icons were lost before MapLibre saw them.** The mirror only understood
   `iconUrl`. DARE pins and most app pins are `L.divIcon`s (inline SVG/HTML),
   and GeoJSON layers built with `pointToLayer` hold real markers whose
   icons `toGeoJSON()` drops. Everything fell back to one generic amber dot.
   OSM Places is worse: its marker is a 0×0 transparent anchor whose only
   visible part is a permanent text tooltip, and the renderer copied the
   *first* feature's tooltip as a literal `text-field` for every place.
2. **Heritage points/radii are not Leaflet layers at all.** For performance
   they are painted on raw map-pane canvases (`_sitesCanvas` /
   `_displayCanvas` in `js/map-app.js`). The 3D mirror walks Leaflet layers,
   so only the lazy `L.GeoJSON` polygons (zoom ≥ 11) ever existed in 3D.
3. **Mirrored WMS paid a failed CORS wave.** 2D loads WMS as plain `<img>`
   (no CORS needed), so most WMS hosts send no CORS headers. In 3D every
   tile was fetched directly first, failed, then retried through the proxy —
   two requests per tile for the whole first wave.

## Fixes

- `js/map3d-mirror.js`: `divIcon` SVG becomes a `data:image/svg+xml` icon;
  zero-size divIcons are `labelOnly` (`noDot`); features carry only primitive
  `iconId`/`label` properties, specs travel on `item.icons`. GeoJSON marker
  children are re-matched to their points (glyph + popup restored). Layers
  exposing `_dl3dFeatures()` mirror as per-feature vectors.
- `js/map3d-terrain.js`: symbol/label layers resolve icon and text
  **per feature** (`['image',['get','iconId']]`, `['get','label']`) for
  markers, clusters and GeoJSON points; fallback dots exclude icon and
  label-only features; per-feature paints (heritage colours/radii) via
  `coalesce(['get',…])`. Mirrored WMS tiles go proxy-first (`preferProxy`)
  with a direct fallback when the proxy refuses a host.
- `js/map-app.js`: an invisible `_heritage3dBridge` Leaflet layer (no DOM,
  follows the heritage toggle) offers the point records as coloured points
  and the `_circleStore` 600 m shapes as 24-gon geodesic polygons, cached
  by a content stamp so the 1.5 s mirror poll only re-uploads on change.
  Polygons are deliberately not duplicated — they already mirror.

Regression suite: `node test-map3d-vectors-heritage-wms.js` (plus the
existing `test-map3d-terrain.js`, `test-map3d-mobile.js`, WMS audit suites).
Assets re-versioned `20261014-3d-vectors`, service-worker cache `v204`.
