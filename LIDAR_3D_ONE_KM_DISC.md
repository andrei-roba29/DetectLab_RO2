# LiDAR in 3D: one layer, one point, one fixed 1 km disc

**Status: 2026-10-19.** Reported: choosing a 5 km fetching distance loaded only
~65 tiles, while 1–2 km loaded about twice as many — and the 1–2 km view was
noticeably sharper in 3D. Asked for: allow only **1 km**, and when entering 3D
over a LiDAR layer ask only **which** layer (“You can enter the 3D view with only
one LiDAR layer at a time.”) and **where**.

---

## 1. Why a bigger radius looked worse

`planDisc()` (in `js/lidar-3d-focus.js`) anchors the whole prefetch on **`zFit`**:
the zoom at which the disc's diameter fills the viewport (`fitZoom()`). It then
prepares a fixed window of four levels around it — one below, two above:

```js
var zFit = Math.round(fitZoom(disc, view, tileSize));
var zoomFrom = Math.max(minZoom, zFit - belowLevels);   // 1
var zoomTo   = Math.min(maxZoom, zFit + aboveLevels);   // 2
```

`fitZoom()` is `log2(metresPerPixelAtZoom0 / (diameter / screenSide))`, so
**every doubling of the radius lowers `zFit` by exactly one level**. The disc is
"fitted" to the screen, so the number of tiles per level stays roughly constant —
but the levels themselves move two steps coarser when the radius goes 1 km → 5 km.

Measured with the shipped code on a 390 × 844 phone viewport (layer capped at
z18):

| radius | `zFit` | prepared levels | tiles |
| --- | --- | --- | --- |
| 1 km | 14 | z13 (4) · z14 (4) · z15 (12) · **z16 (30)** | 50 |
| 2 km | 13 | z12 (1) · z13 (4) · z14 (12) · **z15 (32)** | 49 |
| 3 km | 12 | z11 (1) · z12 (1) · z13 (4) · **z14 (16)** | 22 |
| 5 km | 12 | z11 (4) · z12 (9) · z13 (16) · **z14 (38)** | 67 |
| 10 km | 11 | z10 (4) · z11 (5) · z12 (10) · **z13 (38)** | 57 |

That is exactly the report, in both directions:

* **more tiles, coarser detail** — the coarse levels hold many tiles (a z13 disc
  is 16 tiles, a z14 disc 38) while the fine levels hold few, so the count is
  dominated by the widest prepared zoom and does not track the radius;
* **sharper at 1–2 km** — the finest prepared level is `zFit + 2`: z16 at 1 km,
  z14 at 5 km. Two zoom levels is 4× the ground resolution per tile, and a
  user who zooms in from the framed view hits that ceiling immediately.

The plan arrived at four levels because `aboveLevels: 2` was chosen to cover the
"zoom in next" case. It cannot cover a 5 km disc at 1 km detail: that is 25× the
tiles, far past the prefetch budget.

## 2. The decision

**One fixed disc: 1 km (≈2 km across).** The distance slider and the 1/2/5/10
quick chips are gone; the dialog asks only:

1. **which** LiDAR layer — a radio group, because 3D drapes exactly one. The
   rule is stated verbatim in both languages:
   *EN “You can enter the 3D view with only one LiDAR layer at a time. The others
   stay on the 2D map.”* · *RO „În vederea 3D poți intra cu un singur strat LiDAR
   o dată. Celelalte rămân aprinse pe harta 2D.”*
2. **where** — a point picked on the 2D map (unchanged), which is the centre of
   that 1 km disc. The disc is outlined on the map while it downloads.

At 1 km the finest prepared level is the layer's native detail on both phone and
desktop (z16 on a phone, z17 on a laptop; a layer whose `maxNativeZoom` is lower
clips as before), the tile count is ~50 on a phone and ~140 on a desktop, and
**every entry now has the same resolution** — a smaller disc can no longer look
sharper than a larger one, because there is only one size.

`window.DETECTLAB_LIDAR_3D = { maxRadiusKm: 10 }` still raises the cap and
brings the slider back (the plan, the budget and the clip are unchanged); it is
not offered in the UI.

## 3. What changed where

| file | change |
| --- | --- |
| `js/lidar-3d-focus.js` | `MAX_RADIUS_KM = MIN_RADIUS_KM = DEFAULT_RADIUS_KM = 1` (overridable); `RADIUS_CHOICE` decides whether the slider renders at all; new `fixedRadius` / `fixedNote` copy and a `.m3d-focus-fixed` line in the dialog; `layerHint` is the one-layer-at-a-time sentence; `applyFocus()` clamps any caller's radius to the entry rule. |
| `css/map3d-terrain.css` | `.m3d-focus-fixed` — the area reads as a sentence, not as a disabled slider. |
| `index.html`, `sw.js` | `js/lidar-3d-focus.js?v=20261019-lidar-1km`; shell cache `v229-lidar-1km` (an installed PWA must replace the old module). |
| `test-lidar-3d-focus.js` | the cap is 1 km; the dialog has **no** slider and **no** chips; the area line states 1 km / 2 km across; the one-layer message is asserted; the planner test pins the “5 km prepares two levels coarser” fact that motivated the change; the §4/§5 discs are 1 km so the end-to-end handoff stays the real path. |
| `MAP_3D_TERRAIN.md` | §1 toggle, §6.4 items 1–3 and §9 verification. |

Unchanged on purpose: the disc clip (`disc.maskTile`), the prefetch pipeline
(same `fetchTile` / blend / clip), the memory cache, the entry gate, the pill,
the “Change the area” flow, and the one-layer rule in the viewer.

## 4. Verify

```bash
node test-lidar-3d-focus.js     # 1 km cap, no slider/chips, one-layer message,
                                # disc maths, prefetch, serve path, gate, pill
node test-map3d-tile-order.js   # the SDK ordering patch (unrelated, same 3D path)
```

In the app: switch two LiDAR layers on, press **3D** → the sheet lists both, one
selected, with the one-layer sentence; there is no distance control; tap
**Choose on the map**, pick a point, confirm — the 2D outline is a 1 km circle,
the progress runs to ~50 tiles (phone) / ~140 (desktop), and the 3D view opens
framed on it at the same sharpness every time.
