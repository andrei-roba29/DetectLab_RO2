# 2D ⇄ 3D bearing hand-off — the map no longer mirrors on return

**Files:** `js/map3d-terrain.js` · `test-map3d-bearing-handoff.js` · `test-search-exit-3d.js` · `test-map3d-startup.js` · `sw.js` (v341) · `index.html`

**Symptom:** after a LiDAR layer is set up and the view goes to 3D and back to
2D, the 2D map glitches and the area chosen for editing (the LiDAR 1 km disc,
or the scanner's search circle) swings around the map on its own.

## What was wrong

The two map engines count the bearing in opposite directions:

| Engine | Bearing `+30` | Where north appears |
| --- | --- | --- |
| Leaflet (`js/map-rotate.js`, CSS `rotate(+deg)`) | clockwise | up-**right** |
| MapLibre (3D) | counter-clockwise | up-**left** |

`cameraFrom2D()` (2D → 3D) and `cameraTo2D()` (3D → 2D) copied the number across
unchanged. So every hand-off **mirrored** the rotation:

* a 2D map at +30° entered 3D at −30° on screen;
* a gesture in 3D to +40° came back to 2D at +40° the other way round;
* the Leaflet pane — and everything drawn on it, including the LiDAR disc and
  the scanner circle — jumped around the pivot on return.

Leaflet's own geometry stayed self-consistent (a pin kept its coordinate to
0 px), which is why it looked like random motion rather than a broken layer.

## The fix

One helper, applied at the edge between the two engines:

```js
function bearingFlip(deg) {          // the two bearings are each other's negation
    var value = -(Number(deg) || 0);
    return value === 0 ? 0 : value;  // never −0
}
```

* `cameraFrom2D()` → MapLibre gets `bearingFlip(lmap.getBearing())`.
* `cameraTo2D()` → Leaflet gets `bearingFlip(map.getBearing())`.
* The public `setBearing(v)` and `status().camera.bearing` use the 2D
  convention too, so a number from the app means the same thing everywhere.

The 2D bearing stays the number the app speaks (Leaflet bearing, the tests,
the diagnostics). Nothing on the Leaflet side changed.

## Verification

* **Browser (headless Chromium, the real app):**
  * 2D +30° → 3D: the north point is on the same side of the screen in both
    (before the fix: opposite sides).
  * 2D −25° → 3D → gesture to +40° → 2D: 2D comes back at −40°, north on the
    same side as in 3D; the scanner pin stays at 0 px error throughout.
* **`node test-map3d-bearing-handoff.js`** runs the real `bearingFlip`,
  `cameraFrom2D`, `cameraTo2D` in a sandbox and pins: the involution and no `−0`,
  the 2D → 3D and 3D → 2D conversions, round trips for several bearings and a
  3D gesture, the public API, and the geometric premise. It fails on the old
  code and passes on the fix.
* `test-search-exit-3d.js` evaluates `cameraTo2D` on its own; it now includes
  `bearingFlip` too. (Without it the `try` inside `cameraTo2D` silently skipped
  the hand-off, which is exactly why that helper must travel with it.)
* Cache: `js/map3d-terrain.js?v=20261031-3d-bearing-handoff` in `index.html`
  and the precache list; `CACHE_NAME` → `detectlab-v341-3d-bearing-handoff`, so
  installed PWAs replace the old viewer.

## Known, not changed here

The **2D compass rose** (`js/map-rotate.js`, `_update`) uses `rotate(-bearing)`,
the MapLibre convention. Leaflet's pane turns clockwise, so at +30° the needle's
north tip points up-left while the map's north is up-right. It is independent of
3D and is covered by `test-map-rotate-lock.js` (`rotate(-45deg)`), so it is left
for a separate change: it would be `rotate(+bearing)` plus those expectations.
