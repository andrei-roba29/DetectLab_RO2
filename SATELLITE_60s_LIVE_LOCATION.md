# "Satellite imagery 60's" × live location on Android

**Reported (2026-10-30, Android — both the installed PWA and the desktop-mode
web app):** with *Satellite imagery 60's* (CORONA) ON **and** live location ON,

* sometimes the whole map turns **green**, and
* when it does not, the map **twitches and glitches badly while zooming between
  zoom levels**.

Each feature alone was fine. The bug needed both, and that is the clue: nothing
here is a data problem. It is a **count-of-live-GPU-surfaces problem**, made
worse by a **dead zoom band** and by a **GPS pin that was rebuilt from scratch
on every fix**.

---

## 1. What the user was actually looking at

Android's compositor hands out a **solid green (sometimes magenta or blank)
rectangle** when it cannot get a texture for a layer that must be re-composited.
It is the same failure mode as a green video frame: the surface exists, its
backing store does not. There is **no green colour anywhere in this app** — a
`grep` for green fills finds only the APM legend (`#00cc00`) and the
vegetation-fingerprint classifier, neither of which is part of this stack. So
"the whole map turns green" is not a layer being drawn: it is the browser
giving up on a stack of composited surfaces.

The stack that was being composited, with both features on:

| # | Surface | Why it was its own GPU surface |
|---|---|---|
| 1 | basemap | tile layer |
| 2…N | **each CORONA product** | `opacity: 0.85` on **every** tile layer → Leaflet writes `opacity` on that layer's own container div → the browser promotes **every layer** to a separate composited surface |
| N+1 | CORONA coverage outlines | canvas renderer |
| N+2 | the location marker + accuracy circle | overlay pane, **re-created on every GPS fix** |

On a phone `maxActiveFrames` was 10 and `maxActivePasses` 8, and a dense 1960s
corridor can put every one of those in view at once. During a zoom animation
Leaflet re-transforms the whole tile pane on **every frame** — so all of those
surfaces must be re-composited, every frame, while the live-location pin below
keeps invalidating the overlay pane once a second. That is the spike that ends
in a green screen, and the same spike read as "twitching" when the compositor
survived it.

Three separate defects fed that state. All three are fixed below.

---

## 2. Fix A — one composited surface for the whole CORONA stack

`js/corona-wms-layer.js` gained an `opacityTarget` option:

| mode | what happens |
|---|---|
| `'layers'` (default, unchanged) | every tile layer gets `opacity: <n>` |
| `'pane'` | every tile layer stays **fully opaque**; the shared pane (`pane_sat60`) carries the opacity |

`js/map-app.js` now runs the manager in `'pane'` mode and sets
`pane_sat60.style.opacity = 0.85`. Eight to twenty-four composited surfaces
become **one**, with the same pixels on screen. `setSatellite60sMapOpacity()`
(and therefore the sidebar slider and its mirror) writes the pane style.

*Visible difference:* where two CORONA products overlap, the older build
composited 0.85 × 0.85 (≈98 % opaque) and the overlap looked burnt-in. Now the
top product covers the one below and the whole stack is faded once (85 %) — the
overlap is subtler and the imagery reads more evenly. Nothing else changes: the
requests, the products, the footprints and the zoom gating are untouched.

The default (`'layers'`) is kept for any other caller, and `setOpacity()` still
fades every product when the manager is in that mode (pinned by
`test-sat60-mobile-crash.js`).

---

## 3. Fix B — the dead zoom band between z11 and z12

`CoronaRasterManager.selectProducts()` gates on the atlas's two bands:
**pass mosaics z8–11**, **individual frames z12–20**. Those are inclusive
integer comparisons, so **any zoom strictly between 11 and 12 falls into
neither branch** and *everything* was detached — the pane went empty for the
rest of the gesture and the imagery popped back afterwards.

Fractional zooms are not exotic here:

* `map.flyTo()` — **exactly what the live-location button calls** to recentre on
  the first fix — sets a fractional `map._zoom` on **every animation frame**
  (`_move(center, scaleZoom)`).
* pinch/wheel with `zoomSnap: 0`, and any `setView(..., {animate})` that leaves
  a fractional zoom.

The band is now resolved with `Math.round(zoom)`, so z11.5 becomes z12 (frames)
and z11.4 becomes z11 (pass mosaic). The atlas's ranges themselves are
unchanged: z6 still requests nothing, z21 still requests nothing, and a viewport
without CORONA coverage still requests nothing.

---

## 4. Fix C — one manager update per gesture

A zoom fires `zoomend` **and** `moveend`; both were wired straight to
`manager.update()`, so every gesture detached and re-attached the CORONA stack
**twice** a few milliseconds apart — two full tile-pane rebuilds, visible as a
twitch and pure GPU churn.

`map-app.js` now routes both events through `_sat60RequestUpdate()`, which

* coalesces the burst into a single `setTimeout` (120 ms) and
* refuses to run while `map._animatingZoom` is true, re-scheduling instead (a
  detach/attach in the middle of a zoom animation tears the scaled level apart).

---

## 5. Fix D — the GPS pin is moved, never rebuilt

`showLiveLocation()` used to call `createMarker()`, which called
`removeMarker()` and then built a **new** `L.marker`, a **new** `L.circle`, a
new `divIcon` and a new popup binding — **for every fix**. Android delivers a
fix about once a second with `enableHighAccuracy`.

Now (same file, same block):

* the marker and the accuracy circle are created **once per session** and
  updated with `setLatLng()` / `setRadius()`;
* updates are coalesced into **one animation frame** (`_pendingFix` +
  `requestAnimationFrame`);
* a fix that lands during a zoom animation or during the centring `flyTo()` is
  **held** and painted once, when the map settles (`map.once('zoomend moveend')`);
* the radius is only re-projected when the accuracy really changed (≥ 5 m), and
  it is capped at 3 000 m — a 5 km "accuracy" circle used to paint over the
  entire screen;
* implausible records are dropped before they touch the map: non-finite,
  out-of-range, or the **(0,0) "no fix yet"** record some Android providers
  emit. The same rule (`window._isPlausibleFix`) now guards the detection
  watcher and trail recording, so a bogus record can no longer recentre the
  map, publish a presence on the Atlantic or fire the heritage-proximity alert
  5 000 km away.

Only the first **real** fix of a session centres the map (at
`max(currentZoom, 14)`), exactly as before.

---

## 6. Fix E — back off while the page is over its tile budget

`js/tile-perf.js` already measures the decoded tiles of the page and switches to
**conservation mode** when the budget is exceeded (`maxLiveTiles` 320 on
phones). That is precisely the state that produces the green screen, so CORONA
now participates:

* `DLTilePerf.onConservationChange(cb)` — **new**: the old `onConservation` only
  fired on *entering* conservation, so a layer that backed off could never come
  back.
* `DLTilePerf.inConservationMode()` — the state the listener reads.
* The sat60 block subscribes: while conservation is on it **halves**
  `maxActivePasses` / `maxActiveFrames` (never below 2 of each) and re-runs the
  selection so the extra products are really detached (their tiles are freed),
  and it restores the normal caps when the page calms down.

Additionally, on phones the defaults are now tighter:

| option | before (low power) | now (low power) |
|---|---|---|
| `viewportPad` | 0.2 | 0.15 |
| `maxActivePasses` | 8 | 6 |
| `maxActiveFrames` | 10 | 8 |
| `maxCachedLayers` | — (hard-coded 60) | 16 |

`maxCachedLayers` is new: detached product layers are empty divs, but they used
to pile up while panning across Europe (hard-coded limit of 60). Eviction now
also drops the container element and any retained level.

---

## 7. Tuning without a redeploy

```js
window.DLSAT60 = { maxPasses: 4, maxFrames: 6, maxCached: 8, viewportPad: 0.1 };
// read when the CORONA manager is created (first time the layer is switched on)

window.DLTILE_PERF = { maxLiveTiles: 200 };   // the page-wide budget
window.SAT60_LOW_POWER_TILES = true;          // force the phone profile
window.DLTilePerf.stats();                    // { tiles, layers, mb, budget }
window.DLTilePerf.inConservationMode();
```

---

## 8. Files

| File | Change |
|---|---|
| `js/corona-wms-layer.js` | `opacityTarget: 'pane'`, `maxCachedLayers`, zoom-band rounding, eviction drops the container |
| `js/map-app.js` | pane opacity, coalesced `update()`, conservation back-off, `DLSAT60` knobs, reuse-and-move GPS pin, fix plausibility filter, tighter phone caps |
| `js/tile-perf.js` | `onConservationChange()` (both transitions) + `inConservationMode()` |
| `index.html`, `sw.js` | re-tagged `js/map-app.js`, `js/corona-wms-layer.js`, `js/tile-perf.js`; `CACHE_NAME` → `detectlab-v317-sat60-live-location` (installed PWAs must actually receive the fix) |
| `test-sat60-live-location.js` | **new** — the interplay contract |
| `test-live-location-zoom.js` | rewritten — the pin contract is "one marker, moved in place" |

---

## 9. Tests

```bash
node test-sat60-live-location.js    # 44 checks — the bug in this document
node test-live-location-zoom.js     # 27 checks — centring + pin reuse + junk fixes
node test-sat60-mobile-crash.js     # 51 checks — gesture volume (unchanged invariants)
node test-sat60-layers.js           # 50 checks — catalogue / product names
node test-sat60-fetch.js            # 63 checks — byte-identical WMS-C request
node test-tile-perf.js              # 94 checks — governor
node test-corona-europe.js          # 59 checks — coverage outlines
```

`test-sat60-live-location.js` asserts, among others:

* every fractional zoom 11 … 12 still selects a product (no dead band), while
  z6 and z21 still select nothing;
* in pane mode the products are created with `opacity: 1` and the **pane** gets
  the opacity, while the default mode still fades each layer;
* `maxCachedLayers` really bounds the cache;
* `moveend`/`zoomend` go through the coalescing scheduler and a coalesced
  update never runs inside a zoom animation;
* the live-location block never references the CORONA manager, never forces a
  map move, and updates the pin with `setLatLng`;
* the governor broadcasts **both** conservation transitions and the sat60 stack
  halves/restores its caps.

---

## 10. If it still misbehaves on a device

1. `window.DLTilePerf.stats()` — if `tiles` is at/over `budget` with both
   features on, the page is over its GPU budget: lower `maxLiveTiles` or turn
   off another raster layer.
2. `window.DLTilePerf.inConservationMode()` — `true` means the back-off in §6 is
   active; the imagery will be sparser but the map stays alive.
3. `window._sat60ActiveProducts` / `window._sat60Layers` — what is attached.
4. Force the phone profile with `localStorage`-free globals:
   `window.SAT60_LOW_POWER_TILES = true` / `window.DLTILE_LOW_POWER = true`
   before the map initialises.
5. A green screen with *no* other raster layer on is not this bug — report it
   with `DLTilePerf.stats()` and the list of open layers.
