# Mobile 3D LiDAR: why zooming in showed the base map

**Report (2026-10-19):** in the mobile 3D view, a 1 km LiDAR disc loads, but
zooming in drops the LiDAR and shows the base map. A 1 km area prepares 40–50
tiles on a phone where the desktop prepares 120–130.

---

## 1. Diagnosis: the prefetch stopped one zoom level earlier on a phone

Nothing was wrong with the radius. The planner anchored the *depth* of the plan
on `zFit`, the zoom at which the 1 km disc fills the screen:

```js
var zFit = Math.round(fitZoom(disc, view, tileSize)); // view = min(w,h) * 0.78
var zoomFrom = zFit - 1;
var zoomTo   = zFit + 2;                              // ← the bug
```

A 390 × 844 phone frames the disc on 304 px, a 1280 × 800 desktop on 624 px, so
the phone's `zFit` is exactly one level lower. The plan therefore ended at
**z16** on the phone and **z17** on the desktop — the counts in the report:

| device | `zFit` | prepared | tiles, z17 pyramid |
| --- | --- | --- | --- |
| phone 390 × 844 | 14 | z13–**z16** | **50** |
| desktop 1280 × 800 | 15 | z14–**z17** | **140** |

Pinching from the framed view to z17 on the phone left the prefetch entirely.
From there every tile was a live `dl2d://` request — one fetch per tile, racing
MapLibre's `cancelPendingTileRequestsWhileZooming`, the 7 s
`watchSourceHealth()` proxy flip and a 64-tile tile cache — over a phone
connection. Tiles lost that race resolve to nothing, the raster source draws
what it has (the base map), and the LiDAR appears to vanish.

There is a second, independent contributor: even when the fetch won, the
source's `maxzoom` was the layer's native maximum, so MapLibre kept asking for
zooms above the prepared ceiling — the most expensive possible moment to start
downloading.

## 2. The fix

**The screen decides where the camera opens, never how deep the disc is
prepared.**

| what | before | after |
| --- | --- | --- |
| plan depth | `zFit + 2` | the layer's `maxNativeZoom` (whole levels, budget-bounded) |
| levels below | `zFit - 1` | `zFit - 2` (so a zoom *out* also stays prepared) |
| level allocation | flat nearest-first trim across the window | a level is planned **whole or not at all** |
| budget (`BUDGET.url`) | 700 | **360** (a depth budget: z17 whole, z18 not bought) |
| source ceiling | layer `maxNativeZoom` | `min(layer max, plan.zoomTo)` |
| phone tile cache | 64 | **160** |
| phone primed disc | 900 entries / 28 MB | **1 400 / 48 MB** |

Measured with the shipped defaults:

| device | native z16 | native z17 | native z18 |
| --- | --- | --- | --- |
| phone | 51 tiles (z12–z16) | **145 tiles (z12–z17)** | 145, stops at z17 |
| desktop | 50 tiles (z13–z16) | **144 tiles (z13–z17)** | 144, stops at z17 |

So the phone and the desktop now prepare the same absolute zoom range, tile for
tile — and the one level the phone adds (`zFit - 2`) is four coarse tiles that
keep a zoom-out inside the prefetch too.

### Why "whole levels or none"

A partially primed level is a disc with a hole at its rim, exactly at the zoom
the user is looking at. Since the source is now capped at the prepared ceiling,
that hole could never be filled by an overzoomed parent — it would be the base
map showing through a ring of LiDAR. Stopping before the first level the budget
cannot hold makes the ceiling honest, and the dialog reports it: *“Budget of
360 tiles reached: the disc is prepared up to z17; deeper zoom enlarges those
tiles.”* (`plan.trimmed` carries the tiles of the level that was not bought.)

### Why capping the source is safe

`renderRaster()` / `renderRegistryRaster()` set

```js
spec.maxzoom = Math.min(layerMaxZoom, state.focus.plan.zoomTo);
```

Past that zoom MapLibre **overzooms** the deepest prepared level instead of
requesting new tiles. On a 1 km disc that ceiling is z17 (0.86 m/px at lat 46)
or z18 (0.43 m/px) — deeper than a phone screen can resolve at that framing —
so the only thing the cap costs is detail the prefetch never bought, and the
only thing it prevents is the empty disc. `sameFocus()` includes the ceiling in
the focus identity, so a new plan rebuilds the source rather than keeping the
old cap.

## 3. Files

| file | change |
| --- | --- |
| `js/lidar-3d-focus.js` | `planDisc()`: depth to `maxNativeZoom`, whole levels only, two levels below, `DEFAULT_ABOVE_LEVELS` 24, budget 360 (clamped to 5 000), `plan.trimmed` = the unbought level, `focus.plan` travels with the focus. |
| `js/map3d-terrain.js` | focused source `maxzoom` capped at `plan.zoomTo` (both the mirrored and the registry path), the ceiling in `sameFocus()`, `MOBILE_TILE_CACHE` 160, `PRIME_MOBILE` 1 400 / 48 MB. |
| `test-lidar-3d-focus.js` | phone/desktop parity (zFit −1, same `zoomTo`, ≥120 tiles), whole-level stop at native z18, source ceiling asserted in the fake MapLibre (z13 and a z12 re-point), `focus.plan` carried by the confirm. |
| `index.html`, `sw.js` | `js/lidar-3d-focus.js` / `js/map3d-terrain.js` / `css/map3d-terrain.css` → `?v=20261019-lidar-depth`; shell cache `v230-lidar-depth`. |
| `MAP_3D_TERRAIN.md`, `LIDAR_3D_ONE_KM_DISC.md` | §6.4 and §5/§9 updated. |

## 4. Verify

```bash
node test-lidar-3d-focus.js    # planner parity, whole levels, source ceiling, gate
node test-map3d-tile-order.js  # the SDK tile-order patch (unchanged)
node test-map3d-slider-layout.js
```

On a phone: enter 3D on a LiDAR layer at 1 km — the dialog now says ~145 tiles
(it said ~50), the entry takes a few seconds longer, and pinching from the
framed view through z15, z16 and z17 keeps LiDAR on screen at every level. At
z18+ the disc stays draped (overzoomed from z17) instead of falling back to the
base map.

Known limit: layers whose native pyramid ends at z16 (`ro1m`, `ro2m`) have no
deeper data to prepare — zooming past z16 there is an overzoom of z16 on both
devices, by design.
