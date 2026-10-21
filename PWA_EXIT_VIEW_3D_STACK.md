# PWA: “Exit view” no longer hides under the 2D/3D switch (v248)

Date: 2026-10-21 · Files: `js/country-dock.js`, `css/country-dock.css`,
`css/map3d-terrain.css`, `index.html`, `sw.js` ·
Test: `node test-country-exit-3d-stack.js` (+ the “Exit view” block of
`node test-country-dock.js`)

---

## Symptom

In the **installed PWA**, when a country view was zoomed all the way out, the
centred **“Exit view”** pill appeared with the **“3D”** switch sitting on top of
its middle: only the left and right ends of the pill were visible, and tapping
the pill's centre pressed **3D** instead. The website was fine.

Measured in Chromium with the real stylesheets (safe-area insets = 0, as in a
desktop Chromium window):

| Window | Body | “Exit view” pill | 2D/3D switch | Overlap |
|---|---|---|---|---|
| 390 × 844 | `is-pwa` | y 760–792 (h 32) | y 742–786 (h 44) | **26 px** |
| 390 × 844 | `is-pwa is-3d` | y 760–792 | y 736–780 | **20 px** |
| 1280 × 800 | `is-pwa` | y 713–748 (h 35) | y 698–734 (h 36) | **21 px** |
| 393 × 852 | website | y 810–842 | y 750–794 | – |
| 1280 × 800 | website | y 755–790 | y 698–734 | – |

`document.elementFromPoint()` at the pill's centre returned `#map3d-toggle` in
every PWA row — the switch was painting over the pill *and* taking its taps.

## Cause

Two rules, each correct on its own, fighting over the same bottom-centre slot:

| Rule | File | `bottom` |
|---|---|---|
| `.country-exit-view` | `css/country-dock.css` | `18px + env(safe-area-inset-bottom)` |
| `body.is-pwa .country-exit-view` (“lift it above the home indicator”) | `css/country-dock.css` | **`60px + env(…)`** |
| `.m3d-toggle-group` | `css/map3d-terrain.css` | `66px + var(--layer-dock-clearance)` |
| `@media (max-width:720px) .m3d-toggle-group` | `css/map3d-terrain.css` | **`58px`** |
| `body.is-pwa.is-3d .m3d-toggle-group` | `css/map3d-terrain.css` | **`64px + safe-area`** |

Both elements are `left: 50%` + `translateX(-50%)`, and the switch paints later
(`z-index: 960` vs the pill's `950`). On the website the pill sits 18px up —
clear of the 58/66px switch, which is why the old comment in
`css/map3d-terrain.css` (“the country ‘Exit view’ pill occupies the very bottom
centre”) was true there. The PWA's 60px lift — added for the home indicator —
puts the pill exactly where the switch lives, and nothing in either file knew
about the other's move.

## Fix

One hook instead of two files guessing about each other:

1. **`js/country-dock.js`** — `evaluateExitButton()` already computes the one
   boolean that reveals the pill; it now toggles `body.country-exit-open` with
   that same value:

   ```js
   if (document.body && document.body.classList) {
       document.body.classList.toggle('country-exit-open', show);
   }
   ```

2. **`css/country-dock.css`** — the class becomes the bottom column's lift,
   **only in the installed PWA**:

   ```css
   body.is-pwa.country-exit-open {
       --country-exit-lift: 46px;   /* pill height (32–35px) + a 10px gap */
   }
   ```

3. **`css/map3d-terrain.css`** — every rule that places the switch adds the
   variable, and so does the 3D bar that rides on top of it:

   ```css
   bottom: calc(66px + var(--layer-dock-clearance, 0px) + var(--country-exit-lift, 0px));            /* desktop */
   .m3d-toggle-group { bottom: calc(58px + var(--country-exit-lift, 0px)); }                          /* phones */
   body.is-pwa.is-3d .m3d-toggle-group { bottom: calc(64px + var(--map3d-safe-area-bottom, …) + var(--country-exit-lift, 0px)); }
   body.is-pwa.is-3d #map3d-bar      { bottom: calc(108px + var(--map3d-safe-area-bottom, …) + var(--country-exit-lift, 0px)); }
   ```

   The bar's `max-height` takes the same step, so lifting the column does not
   push the bar's top edge into the search bar on short/landscape screens.

On the website nothing changes (no `is-pwa`, no lift), and when the pill hides
the class is removed on the same call, so the switch drops back to 58/64/66px
with no animation or state to keep in sync.

### After the fix (measured again in Chromium)

| Window | Body | Pill | Switch | Gap |
|---|---|---|---|---|
| 390 × 844 | `is-pwa` | 760–792 | 696–740 | 20 px |
| 390 × 844 | `is-pwa is-3d` | 760–792 | 690–734 (bar top 690) | 26 px |
| 1280 × 800 | `is-pwa` | 713–748 | 652–688 | 12 px |
| 390 × 844 | `is-pwa`, pill hidden | — | 742–786 | unchanged |
| 393 × 852 | website | 810–842 | 750–794 | unchanged |

The pill's centre now hit-tests to the pill itself in all three PWA rows.

## Assets

`index.html` and `sw.js` re-tag the three changed files
(`?v=20261021-country-exit-3d-stack`) and `CACHE_NAME` moves to
`detectlab-v248-country-exit-3d-stack`.

## Tests

- `test-country-exit-3d-stack.js` — static contract (the hook, the single
  `--country-exit-lift` declaration, all four bottom rules, the cache wiring
  and the arithmetic) plus optional geometry checks in Chromium:
  `PUPPETEER_MODULE_DIR=/path/to/node_modules node test-country-exit-3d-stack.js`.
- `test-country-dock.js` — §6e asserts the body class appears with the pill,
  disappears when the view is unlocked and clears when “Exit view” is pressed.
