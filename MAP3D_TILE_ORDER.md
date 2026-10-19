# 3D: which tiles are requested first (and why the phone fetched the distance first)

**Status: 2026-10-19.** Reported: in the 3D view on a phone, historical maps load
very slowly and the fetch order is wrong — the first tiles that appear are not
the ones under the camera, sometimes they are not even in the current view;
tiles in the distance load before the ones closest to the user. The same build
feels fine on a laptop.

This document explains the cause, the one-line patch applied to the vendored
MapLibre build, and the follow-ups for the remaining phone latency.

---

## 1. Root cause: `coveringTiles()` sorted mixed zoom levels by a meaningless distance

MapLibre decides which tiles to request in
`coveringTiles()` (`src/geo/projection/covering_tiles.ts`). The function returns
the visible tiles **sorted by `distanceSq`**, and `TileManager.update()` →
`_updateRetainedTiles()` → `_addTile()` starts a request for each tile **in that
order**. The image queue is FIFO (16 parallel requests, 8 per frame), so the
sort is the load order.

In the vendored build (MapLibre GL JS **5.24.0**, `js/maplibre-gl.js`) the key
was:

```js
distanceSq: vec2.sqrLen([centerPoint[0] - 0.5 - x, centerPoint[1] - 0.5 - y])
```

`centerPoint` is the map centre in tiles of the **nominal** zoom
(`2^nominalZ × centre`), while `x, y` are the tile's own coordinates at **its**
zoom. With one zoom level — a flat, unpitched map — the two grids agree and the
sort is correct. With **variable zoom** — any pitched view, and *always* with
terrain — the view mixes zoom levels: z12–z14 at the horizon, z17–z18 under the
camera. A z13 tile then compares its x (≈4 000) with a z16 centre (≈32 768), so
its distance is dominated by the zoom level rather than by where it is on
screen.

The visible effect depends on where the view is:

* coarse tiles have small x/y, so near the north edge of the world (small y) and
  near the antimeridian (x near 0 or `2^z`) they sort **first**;
* elsewhere they sort last, and higher-than-nominal tiles (the near field) jump
  ahead by their raw, unscaled coordinates.

That is why the order looked "random" and location-dependent, and why the first
tiles were often the distant ones or outside the current point of view.

The 2D map never shows it: Leaflet at pitch 0 uses a single zoom level and a
different tile pipeline (`js/tile-perf.js`). The desktop 3D view has the same
order, but a fast connection drains the 16-request queue before the order is
visible; on a phone each request takes long enough that the first wave *is* the
experience.

**Upstream:** [maplibre/maplibre-gl-js#8494 — "Fix coveringTiles distance sort
for mixed zoom levels"](https://github.com/maplibre/maplibre-gl-js/pull/8494)
(opened 2026-09-19, still open as of 2026-10-19; the latest release, 6.15.0,
does not contain it). The unused `tileDistanceToCamera` field in the same
function had the right idea (`x << dz`), but an integer shift is undefined for
tiles finer than the nominal zoom (`dz < 0`), which is exactly what variable
zoom produces near the camera.

## 2. The fix: scale tile centres to one grid before measuring

Applied to `js/maplibre-gl.js` (the minified `coveringTiles`, function `Me`):

```diff
-distanceSq:t.as([m[0]-.5-f,m[1]-.5-x])
+/*DetectLab: coveringTiles nearest-first (upstream #8494)*/
+distanceSq:t.as([m[0]-(f+.5)*Math.pow(2,d-_.zoom),
+                 m[1]-(x+.5)*Math.pow(2,d-_.zoom)])
```

In the minified function `m` is `centerPoint`, `f`/`x` are the tile's x/y,
`d` is `nominalZ` and `_.zoom` is the tile's zoom. The scale is a **float**
power of two because a tile can be finer than the nominal zoom (`d - _.zoom`
negative), where the old integer shift was undefined. This is exactly the
upstream change; only the order changes, not the tile set.

One consequence worth knowing: the `distanceSq` key now orders tiles by true
distance from the **map centre**, so at a steep pitch the tiles under the centre
come first and the horizon last. That is the right trade for this app: the
historical sheet / LiDAR disc the user is looking at appears first, while the
horizon fills in behind it. (PR #8670 measured the same ordering and found it
spends the budget on the near, magnified part of the frame, which is what the
user is looking at.)

### Cache busting

* `js/layer-registry.js` → `maplibre.js = 'js/maplibre-gl.js?v=20261019-tile-order'`
* `sw.js` → the same tag in `PRECACHE_URLS`, and `CACHE_NAME` becomes
  `detectlab-v228-tile-order` so an installed PWA drops the old bundle.
* The stylesheet tag is unchanged (`css/maplibre-gl.css` did not change).

### Maintaining the patch

When the vendored SDK is upgraded, search `js/maplibre-gl.js` for
`distanceSq:t.as([`:

* if it already scales the tile centre (`(f+.5)*Math.pow(2,d-_.zoom)`), the
  upstream fix is in — delete the comment, keep the code, and keep the test;
* if not, re-apply the replacement above and bump the `?v=` tag again.

`node test-map3d-tile-order.js` extracts the shipped expression from the bundle
and runs it, so a silent regression (or a re-downloaded, unpatched SDK) fails
the suite instead of shipping.

## 3. What this does **not** fix: the rest of the phone latency

The order fix makes the **right** tiles arrive first. It does not reduce the
number of requests. On a phone the historical WMS sheets are still expensive:

| Cost | Where it comes from | Suggested follow-up |
| --- | --- | --- |
| 1 request per **256 px** tile, per layer | `wmsTemplate()` uses `def.tileSize` (256); a 62° pitched view can cover 40+ tiles for one sheet | Request **512 px** WMS tiles (4× fewer requests / proxy calls). `wmsTemplate(def, opts)` already accepts `opts.tileSize`; it needs to be threaded through `rasterSource()`/`map3dTiles()` and through the proxy (`buildUpstreamUrl()` uses `resolved.tileSize`; add a `size` query key and include it in the cache key). Only for `kind: 'wms'` — an XYZ pyramid's 256 px images cannot simply be relabelled 512. |
| A WMS host that sends no CORS cannot be fetched directly in 3D | MapLibre needs `crossOrigin="anonymous"`; the registry marks these hosts `cors: 'unknown'`, so the first wave is tried direct and the health watch moves the host to `/api/map3d/tile` only after it sees no complete source. The 2D Leaflet tiles (`<img>`, no CORS) cannot be reused: the 3D URL is different, and a tainted canvas cannot be `toBlob()`-ed into a texture. | When a host is known to need it, mark it `proxy: 'always'` so the **first** wave is proxied instead of burning 7 s on doomed requests; and make each proxied call cheaper (512 px tiles, CDN caching — already `s-maxage ≥ 604800`). |
| All visible sources share one 16-request queue | MapLibre's `image_request` queue is global and FIFO (16 parallel); base map + DEM + hillshade + every active historical sheet + LiDAR request at once. `syncLayers()` creates them in pane order, so the historical sheet is last. | Prefetch the opening view for the top historical sheet **centre-first** into the existing `state.primed` cache (the LiDAR disc prefetch already does exactly this ordering and uses `fetchTile`, so the URLs and the proxy decision match). When MapLibre then asks for those tiles, `dl2d` answers from memory. This is the generalisation of `prefetchTiles()` beyond the LiDAR disc. |
| Tile cache is 64 decoded tiles on phones | `perf.mobileMaxTileCacheSize` (kept low for iOS WebGL memory) | Measure after the order fix; raise only if pan-back still re-fetches. Do not trade a crash for a cache. |

None of these change what a layer looks like; they change which request the
phone makes first and how many it makes.
