# Map Touch Rotation — Google-Earth-style twist deadband

**Files:** `js/map-rotate.js` · `test-map-rotate-lock.js` · `sw.js` (v283) · `index.html`
**Symptom fixed:** in the PWA, the map turned with very light touches —
especially while zooming in with two fingers.

## What was wrong

`L.Map.TouchRotate` in `js/map-rotate.js` gated the two-finger twist on a
**fixed 9° angle** between the fingers, with a minimum finger spacing of just
35 px, and it applied rotation from the moment that angle was crossed. That is
wrong for touch on three counts:

1. **A fixed angle is not a fixed gesture.** 9° is a wide, deliberate sweep
   when the fingers are 300 px apart — and a ~5 px twitch when they are close
   together. A pinch-zoom routinely brings the fingertips near each other,
   where the measured angle is pure sensor noise.
2. **No pinch arbitration.** A two-finger zoom is never perfectly radial: one
   finger usually lags, the spread breathes, and the angle between the fingers
   drifts. The old handler happily turned the map from that drift, so *the
   act of zooming in turned the view*.
3. **Nothing was sticky.** Because the threshold was tiny, the accidental
   rotation started within the first few frames of the pinch and then tracked
   the noise 1:1.

## The fix — the Google Earth model

Google Earth gates a two-finger twist on **how far the fingers actually travel
tangentially** (along the arc of the rotation), not on a raw angle, and it
keeps a pinch **purely radial**: while the spread between the fingers is
changing, the gesture is a zoom and never a turn. `L.Map.TouchRotate` now does
the same:

| Constant | Value | Meaning |
| --- | --- | --- |
| `TOUCH_ROTATE_ARC` | 34 px | tangential finger travel required before a twist counts |
| `TOUCH_ROTATE_ANGLE_MIN` | 8° | …never below this angle, however wide the fingers |
| `TOUCH_ROTATE_ANGLE_MAX` | 45° | …never above this, however close together |
| `MIN_TOUCH_DISTANCE` | 64 px | closer than this the angle cannot be read at all |
| `TOUCH_PINCH_SLOP` | 6 % | spread change before any twist engages → it is a pinch |
| `TOUCH_PINCH_ABORT` | 18 % | spread change that cancels an already-engaged twist |
| `TOUCH_GESTURE_MIN_ANGLE` | 12° | deadband for iOS Safari `gesturechange` rotation |

The effective angle threshold is `TOUCH_ROTATE_ARC / fingerDistance` (clamped
to the min/max), so:

* 150 px apart → the twist must reach ~13° *and* 34 px of real travel;
* 400 px apart → ~8° (the floor);
* 64 px apart → ~30° (and below 64 px nothing turns at all).

### Gesture lifecycle (one two-finger touch)

1. **Baseline.** `touchstart` records the angle, spread and bearing. If the
   fingers are closer than 64 px, the baseline waits until they spread far
   enough to be readable (`_rebase`).
2. **Classification.** On every `touchmove`:
   * |twist| ≥ arc threshold → **twist engages** (checked BEFORE the pinch
     gate), and the turn starts from exactly 0° at that frame (no jump),
     tracking the fingers 1:1 afterwards. A deliberate twist can carry a
     few percent of natural spread drift — engagement must win over the
     zoom rule, or the turn is swallowed by the very gesture that asks for it.
   * |twist| < arc threshold → nothing (the deadband); spread changed by
     more than 6 % from the baseline → **pinch**. The gesture is locked as
     a zoom for its whole life; the map never turns.
3. **Cancellation.** An engaged twist stops dead — and stays stopped for the
   rest of the gesture — if the spread then changes by more than 18 %
   (the twist turned into a real pinch) or if the fingers converge below the
   readable spacing. Spread drift under 18 % never freezes an engaged
   deliberate twist; only a real pinch does.

iOS Safari's `gesturestart`/`gesturechange`/`gestureend` path (which carries a
rotation in degrees but no finger spacing) gets the same arbitration with the
12° degree deadband and the 6 % `scale` pinch gate — engagement checked
before the pinch gate, exactly like the touch path: a deliberate twist
(≥ 12°) engages even while the scale drifts a few percent, and an engaged
twist dies once the scale change passes 18 %.

### What is untouched

* Pinch-zoom itself — still Leaflet's own `TouchZoom`, and now guaranteed not
  to leak rotation.
* Desktop rotation (Alt-drag, Ctrl/⌘+wheel), the compass rose drag, keyboard
  nudges, snap-to-north and the 320 ms ease back to north.
* There is still no rotation lock: rotation is always *available*, exactly as
  in Google Earth — it just needs a deliberate twist.

## Tests

`test-map-rotate-lock.js` section **[6]** drives the real handler through
simulated two-finger frames and pins the model:

* a pinch-zoom with angle jitter (fast and slow) never rotates;
* twists under the arc deadband never rotate;
* a deliberate twist turns 1:1 past the deadband, starting from 0° at engage;
* fingers closer than 64 px never rotate, and a later spread re-baselines;
* a pinch growing out of a twist freezes the turn and locks it out;
* iOS gesture rotation obeys the same deadband and pinch rules.

Run with `node test-map-rotate-lock.js`.

## 3D counterpart (MapLibre)

The 3D viewer (`installTouchTwist()` in `js/map3d-terrain.js`) runs the same
lifecycle — engagement before the pinch gate, 34 px arc (clamped 8°–45°),
64 px minimum spacing, 6 % slop / 18 % abort, 12° iOS deadband — but the
sign differs, deliberately: MapLibre counts the bearing the other way from
the CSS rotation (the same sign the 2D↔3D hand-offs use via
`bearingFlip()`). Twisting fingers clockwise must turn the view clockwise,
which is a **negative** MapLibre bearing, so the sweep is negated before the
camera is turned. An earlier revision of the 3D twist applied the 2D
(CSS-style) sign and turned the view the opposite way.

The same guard runs on the 3D side: an engaged twist **disables MapLibre's
own two-finger zoom** — pinch pivots around the midpoint of the fingers and
re-centres the view on it, which is the reported "teleport". The twist owns
the gesture for its whole life; the native zoom is restored when it ends,
and a pure pinch (never a turn) never disables anything.
