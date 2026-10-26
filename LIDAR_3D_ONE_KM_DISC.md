# LiDAR in 3D: the 1 km disc (the option, since 2026-10-26)

> **Status: 2026-10-26 — read §0 first.** The 1 km disc is no longer the only
> way into 3D. The default is **whole layers**, drawn entirely at every zoom;
> the disc below is the second scope, chosen explicitly. And the disc can now
> hold **several** LiDAR layers at once — every layer switched on is listed and
> the user ticks which ones to prepare. See `MAP_3D_TERRAIN.md` §6.4.3. The
> measurements and the depth fix below still describe the disc scope exactly as
> shipped.

**Status of this document: 2026-10-19.** Reported: choosing a 5 km fetching
distance loaded only ~65 tiles, while 1–2 km loaded about twice as many — and
the 1–2 km view was noticeably sharper in 3D. Asked for: allow only **1 km**, and
when entering 3D over a LiDAR layer ask only **which** layer and **where**.

---

## 0. What 2026-10-26 changed here

| | before | now |
| --- | --- | --- |
| entry | always a 1 km disc | **two scopes**: whole layers (default) or only 1 km |
| layer choice | a radio group, exactly one | **a tick box each**, and every ticked layer is drawn (whole) or prepared (disc) |
| the 1 km disc | one layer per disc | **one plan per ticked layer**, downloaded together, one progress bar |
| whole layers | not possible | the layer is draped uncapped and unbounded, tiles on demand |
| the “one layer at a time” sentence | stated in the dialog | gone — see §0.2 |

### 0.1 The disc itself is unchanged

Everything from §1 on still holds for `scope: 'disc'`: the fixed 1 km radius (no
slider, no chips), the `zFit − 2 … maxNativeZoom` plan, whole levels or none, the
budget, the source ceiling at `plan.zoomTo`, the disc clip, the 2D outline, the
prefetch through `fetchTile()` / `blendedTile()` / `clipFocusedTile()`, and the
pill. The only difference is that the plan is built **per ticked layer**
(`refreshPlan()` → `dialog.plans[]`, summed by `aggregatePlans()`) and the
download walks the per-layer queues round-robin (`prepare()` → `interleave()`),
so one slow provider cannot hold back the other layer.

### 0.2 The one-layer rule is retired

The sentence *“You can enter the 3D view with only one LiDAR layer at a time”*
is no longer shipped. The viewer keeps exactly the layers the focus names
(`focusLayers()`, `focusMatches()`, `lidarFilter()`), the bar reports what it
kept and in which scope (`status().lidar.notes → {reason: 'focused', count,
keptCount, kept, scope}`), and `js/map-app.js` asks
`DetectLabMap3D.lidarFocusCovers(activeLayers())` so switching **one** of several
chosen layers off does not throw the decision away while any other chosen layer
is still on.

### 0.3 Whole layers, in one sentence

`scope: 'full'` drops the bounds, the zoom cap, the per-tile clip, the 2D disc
outline, the camera teleport and the prefetch — and keeps the route rule: a
focused layer is still drawn through `dl2d://`, so the CORS/proxy decision the
prefetch would have made is the one the render makes. On a national pyramid
this is the scope that actually shows the pyramid; the disc remains the choice
for “I only care about this one kilometre and I want it already downloaded”.

---

## 1. Why a bigger radius looked worse

`planDisc()` (in `js/lidar-3d-focus.js`) anchors the whole prefetch on **`zFit`**:
the zoom at which the disc's diameter fills the viewport (`fitZoom()`). At the
time of this report it prepared a fixed window of four levels around it — one
below, two above (the depth fix that followed is §5):

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
| `js/lidar-3d-focus.js` | `MAX_RADIUS_KM = MIN_RADIUS_KM = DEFAULT_RADIUS_KM = 1` (overridable); `RADIUS_CHOICE` decides whether the slider renders at all; `fixedRadius` / `fixedNote` copy and a `.m3d-focus-fixed` line in the dialog; `layerHint` names the 1 km disc of the current scope; `applyFocus()` clamps any caller's radius to the entry rule. (Since 2026-10-26 the hint is `layerHintDisc` / `layerHintFull` and the layer list is checkboxes — §0.) |
| `css/map3d-terrain.css` | `.m3d-focus-fixed` — the area reads as a sentence, not as a disabled slider. |
| `index.html`, `sw.js` | `js/lidar-3d-focus.js?v=20261019-lidar-depth`; shell cache `v230-lidar-depth` (an installed PWA must replace the old module) — see §5 for the depth fix that shares this bump. |
| `test-lidar-3d-focus.js` | the cap is 1 km; the dialog has **no** slider and **no** chips; the area line states 1 km / 2 km across; the one-layer message is asserted; the planner test pins the “5 km prepares two levels coarser” fact that motivated the change; the §4/§5 discs are 1 km so the end-to-end handoff stays the real path. |
| `MAP_3D_TERRAIN.md` | §1 toggle, §6.4 items 1–3 and §9 verification. |

Unchanged on purpose: the disc clip (`disc.maskTile`), the prefetch pipeline
(same `fetchTile` / blend / clip), the memory cache, the entry gate, the pill and
the “Change the area” flow. (The one-layer rule in the viewer was retired on
2026-10-26 — §0.2.)

## 4. Verify

```bash
node test-lidar-3d-focus.js     # both scopes, checkbox list, 1 km cap, no
                                # slider/chips, disc maths, prefetch, serve path,
                                # whole-layer deck (no bounds, no cap, no clip)
node test-map3d-tile-order.js   # the SDK ordering patch (unrelated, same 3D path)
```

In the app: switch two LiDAR layers on, press **3D** → the sheet opens on the
whole-layer scope with both layers ticked; confirm and the 3D view shows both
over their whole extent with nothing downloaded up front. Reopen it, press
**Only 1 km**, keep both ticked, tap **Choose on the map**, pick a point,
confirm — the 2D outline is a 1 km circle, the progress runs to ~145 tiles per
layer on a phone / ~144 on a desktop (both prepared to the layer's native
maximum — see §5), and the 3D view opens framed on it at the same sharpness
every time. Untick one layer and the disc (and its download) narrows to the
other.

## 5. Follow-up (same day): why the phone stopped at z16 and lost the LiDAR

Reported after the 1 km change: **on mobile, entering 3D with LiDAR at 1 km is
fine, but zooming in drops the LiDAR and shows the base map — and the phone
prepares 40–50 tiles where the desktop prepares 120–130.**

Both symptoms are one bug in the planner's *depth*, not in the radius.

`platform` did not matter before: `planDisc()` stopped at `zFit + 2`, and
`zFit` is derived from `min(viewport width, height) × 0.78`. A 390 × 844 phone
frames the same 1 km disc one zoom level wider than a 1280 × 800 desktop, so
its `zFit` is one lower (14 vs 15) and its prepared window ended at **z16**
where the desktop reached **z17**:

| device | `zFit` | prepared | tiles (z17 pyramid) |
| --- | --- | --- | --- |
| phone 390 × 844 | 14 | z13–**z16** | **50** |
| desktop 1280 × 800 | 15 | z14–**z17** | **140** |

Pinching from the framed view to z17 on the phone therefore left the prefetch
entirely. Every tile became a live `dl2d://` request — one fetch per tile,
racing MapLibre's `cancelPendingTileRequestsWhileZooming` and the 7 s
`watchSourceHealth` proxy flip — and a phone showed the base map under a disc
it had just spent the entry dialog downloading.

### What changed

1. **The ceiling is the layer's native maximum, not the screen's.**
   `planDisc()` walks whole levels from `zFit - 2` to `maxNativeZoom`. The
   viewport still decides where the camera *opens* (`focusFitZoom`), never how
   deep the prepared disc goes. Phone 1 km on a z17 pyramid: **145 tiles**;
   desktop: **144**.
2. **Whole levels or none.** The plan stops before the first level the budget
   cannot hold and reports the tiles it did not buy (`plan.trimmed`). A
   half-prepared level would be a hole at the rim at exactly the zoom under
   the camera.
3. **The budget now means depth.** `BUDGET.url` 700 → **360**: a z17 pyramid
   is prepared whole; a z18 one stops at z17 (both devices), so the entry stays
   ~145 tiles instead of ~480.
4. **The source is capped at the prepared ceiling** (`renderRaster()` /
   `renderRegistryRaster()`: `spec.maxzoom = min(layer max, plan.zoomTo)`).
   Past the ceiling MapLibre *overzooms* the prepared tiles — the disc stays
   LiDAR at every zoom, no request is made, and `sameFocus()` includes the
   ceiling so a new plan rebuilds the source instead of keeping the old cap.
5. **Phone caches sized for the deeper disc.** MapLibre `maxTileCacheSize`
   64 → **160** (desktop 320) and the primed disc 900 entries / 28 MB →
   **1 400 / 48 MB**: the z17 disc is held twice (raw + clipped) and a 64-tile
   cache was evicting tiles the user was looking at.
6. **Two levels below `zFit`**, not one: coarse tiles are a handful (z12 over
   a 1 km disc is one tile), and they keep a zoom-*out* inside the prefetch too.

Tests: `test-lidar-3d-focus.js` now pins the phone/desktop parity (zFit −1,
same `zoomTo`, 145 vs 144 tiles), the whole-level stop at z18, and the source
ceiling (`maxzoom === plan.zoomTo`, and a plan at z12 capping the source there).
