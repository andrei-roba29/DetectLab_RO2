# Denmark LiDAR in 3D: ~200 tiles “load”, the relief shows only at one zoom

**Report (2026-10-21):** *“LiDAR in 3D doesn't work properly for Denmark. It shows that it
loads around 200 tiles, but when entering the 3D view the LiDAR layer is visible only at a
certain zoom level, and when zooming in more only the base layer is visible.”*

The count is right (a 1 km disc is planned as z13→z17 on both a phone and a desktop:
196 tiles on 1280 × 800, 197 on 390 × 844 — see §4). The tiles were prepared and the disc
was applied. What 3D received was a disc of **fully transparent** images.

---

## 1. Diagnosis: Denmark is the only country product that paints asynchronously

`js/dataforsyningen-dhm-layer.js` is not a `L.TileLayer` with a `{z}/{x}/{y}` URL. Its only
grid is WMTS `View1`, in **EPSG:25832 (UTM 32N)**, so every destination tile is built by
hand:

```js
createTile: function (coords, done) {
    var canvas = document.createElement('canvas');       // blank, right now
    this._renderTile(canvas, coords, size).then(function (drewSomething) {
        done(null, canvas);                              // …painted much later
    });
    return canvas;
}
```

`_renderTile()` lays an 8 × 8 mesh over the Web-Mercator tile, converts every node to
UTM 32N, picks the View1 level, **fetches a mosaic of View1 tiles through
`/api/geo/dk-dhm`**, then warps that mosaic into the canvas cell by cell. The canvas that
`createTile()` returns is therefore empty until the network answers.

The 2D→3D mirror (`js/map3d-mirror.js → renderTile()`) is what both the prefetch
(`DetectLabMap3D.prefetchTiles`) and the live `dl2d://` protocol use to get those pixels.
It sampled a canvas tile on the **next frame**, whatever the layer said:

```js
} else if (tile.getContext) {
    root.setTimeout(function () { if (!settled) finish(tile); }, 0);   // ← the bug
}
```

Leaflet's own contract (`L.GridLayer._addTile`) is the opposite: a layer whose
`createTile()` declares the `done` argument owns the moment the pixels exist and calls back
when they do; only a one-argument `createTile()` is ready on the next frame (that is why
`js/roman-roads.js` deliberately declares `createTile: function (coords)`).

So:

| step | what happened |
| --- | --- |
| dialog | plans the disc (196 tiles, z13–z17), reports the count |
| prefetch | `renderTile()` snapshots each Danish canvas one tick after `createTile()` returns → a blank canvas → a transparent PNG |
| disc clip | masks and stores those transparent PNGs in `state.primedOut` |
| 3D | MapLibre asks `dl2d://` for exactly those tiles, is handed the transparent bytes, draws the base map underneath |

### Why the LiDAR still appeared at one zoom level

`_renderTile()` resolves in a **microtask** when every View1 source tile is already in the
layer's own 96-entry `sourceCache`; the snapshot timer is a **macrotask**, so it runs after
those. Tiles whose sources had been decoded while the user was browsing the 2D map — the
coarse levels of a freshly framed disc, a few tiles per level — therefore came out painted,
while the deep levels (hundreds of uncached View1 tiles each) came out blank. Zooming in
moved the view onto exactly the tiles that had been prepared blank, which is the “visible
only at a certain zoom level, then only the base layer” part of the report. The blanks are
then *cached* as prepared, so no later pinch ever re-fetched them.

The other eight country products are unaffected: AHN (`js/ahn-layer.js`) and Høydedata
(`js/hoydedata-layer.js`) return `<img>` tiles that the mirror waits on via `load`, and the
rest are `L.TileLayer` subclasses with a per-tile URL.

---

## 2. The fix

`js/map3d-mirror.js → renderTile()` now follows Leaflet's rule:

| tile returned by `createTile()` | when it is read |
| --- | --- |
| `<img>` | on `load` (unchanged) |
| canvas, `createTile.length < 2` (no `done`) | on the next frame (Leaflet's own rule; `roman-roads`) |
| canvas, `done` called | the moment `done()` runs — **painted** |
| canvas, `done` declared but never called | when the tile deadline passes, handed over as it is (not rejected: MapLibre draws nothing at all for an errored tile) |

`done` may fire before `createTile()` returns (a fully cached tile); the callback is
recorded and the tile is finished as soon as it is known. The existing 15 s tile deadline
still bounds a layer that never calls back.

Nothing else changed: the prefetch, the disc clip, the primed cache, the `dl2d://` route,
the plan (still z13–z17, still capped at `plan.zoomTo`) and the source ceiling are the
same. The fix makes the pixels real; the zoom behaviour described in
`LIDAR_3D_MOBILE_ZOOM.md` (past `plan.zoomTo` the deepest prepared level is overzoomed
instead of requested) then applies to Denmark like everywhere else.

### Cost

The prefetch now performs the network work it was always supposed to perform: each
destination tile needs 1–12 View1 tiles, 6 destination tiles in flight at a time, one
progress step per destination tile. Previously that work happened too — before the blank
snapshot — so the repair removes the wasted blank disc, not extra requests.

---

## 3. Files

| file | change |
| --- | --- |
| `js/map3d-mirror.js` | `renderTile()`: wait for `done()` on canvas tiles, keep the next-frame rule for one-argument `createTile()`, hand over an unfinished canvas at the deadline instead of rejecting. `VERSION` → `2026-10-21-lidar-canvas-tiles-v1`. |
| `test-lidar-3d-focus.js` | §4h-bis: an asynchronous Danish-style canvas layer is read back painted (`renderTile`), a one-argument canvas settles at once, a `done`-declaring canvas that never calls back is still read at its deadline, and the prefetch + `dl2d://` serve of a Danish disc carries pixels in every prepared tile. The three synchronous canvas fakes in §4d-quater/§4h now call `done()`, as Leaflet's contract expects. `TAG_MIRROR` bumped. |
| `test-map3d-terrain.js`, `test-arcgis-primary-atlas.js`, `test-3d-analysis-points.js` | the mirror's new `?v=` tag. |
| `index.html`, `sw.js` | `js/map3d-mirror.js?v=20261021-lidar-canvas-tiles`; shell cache `v247-lidar-canvas-tiles`. |
| `MAP_3D_TERRAIN.md` | §6.4.2. |

---

## 4. The plan this affects (measured, shipped defaults)

`DetectLabLidar3D.plan({lat: 56.15, lng: 9.55, radiusKm: 1}, {minZoom: 6, maxZoom: 19,
tileSize: 256, budget: 260})`:

| viewport | `zFit` | levels | tiles | `zoomTo` | trimmed |
| --- | --- | --- | --- | --- | --- |
| 1280 × 800 | 15 | z13 4, z14 7, z15 14, z16 42, z17 129 | **196** | 17 | 478 (z18 not bought) |
| 390 × 844 | 14 | z12 1, z13 4, z14 7, z15 14, z16 42, z17 129 | **197** | 17 | 478 |

That is the “around 200 tiles” in the report. The deepest prepared level is z17, so the
source is capped there and z18+ overzooms it — the same behaviour as every other country.

---

## 5. Verify

```bash
node test-lidar-3d-focus.js          # including the new §4h-bis
node test-map3d-terrain.js
node test-denmark-dataforsyningen-dhm.js
node test-danish-layers.js
```

On a Danish LiDAR layer at 1 km: the dialog counts ~196 tiles, the download now really
paints them (the progress bar takes as long as the View1 mosaics need), and the 3D view
shows the hillshade at the opening zoom **and** at every level on the way in, up to z17
natively and as an overzoom beyond it. Nothing shows the base map through the disc.

Removing the fix makes `test-lidar-3d-focus.js` fail on
*“renderTile waits for the canvas the layer says is finished, instead of snapshotting it
blank”* and on *“none of the prepared tiles is a transparent placeholder”*.
