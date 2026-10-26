# PWA 3D switch: 38×38 column squares, centred group in 3D (v285)

Date: 2026-10-26 · Files: `css/map3d-terrain.css`, `index.html`, `sw.js`,
tests · Test: `node test-pwa-3d-button-size-centre.js`

Scope: **installed PWA (`body.is-pwa`) only.** On the website
(`body:not(.is-pwa)`) nothing moves and nothing is resized — the switch keeps
its roomier bottom-centre text pill (`66px` desktop, `58px` phones,
`min-height: 36px` / `44px` in the phone media query).

## The two asks

1. *“The 3D button is too big compared to the rest of the buttons — they all
   should have the same size.”*
2. *“When in 3D mode the 2D and refresh buttons should be centred in the
   middle.”*

Both are pure CSS. `js/map3d-terrain.js` already builds the group
(`#map3d-toggle-group` with `#map3d-toggle` + `#map3d-refresh`) and already
toggles `body.is-3d`; no markup or JS behaviour changed.

## 1. Uniform 38×38 squares in the PWA column

The bottom-left control column is a stack of 38×38 glass icon squares:

| Button | Size | Defined in |
|---|---|---|
| Compass `.detectlab-compass-btn` | 38×38 | `css/styles.css` |
| Detect `.compass-detect-btn` (PWA only) | 38×38 | `css/styles.css` |
| Base layer `#arcgisBasemapCtrl` | 38 wide, 34 tall folded | inline CSS in `index.html` |
| 2D/3D switch + refresh — **before** | pill, `min-height: 36px`, `padding: 6px 11px`, 44px on phones | `css/map3d-terrain.css` |
| 2D/3D switch + refresh — **after (PWA)** | **38×38, `padding: 0`** | `css/map3d-terrain.css` |

```css
body.is-pwa #map3d-toggle,
body.is-pwa #map3d-refresh {
    width: 38px; min-width: 38px;
    height: 38px; min-height: 38px;
    padding: 0;
    gap: 3px;
}
```

Specificity is deliberate: `body.is-pwa #map3d-toggle` is `(1,1,1)` — higher
than both the shared pill rule `#map3d-toggle` `(1,0,0)` and the
`@media (max-width: 720px)` bump `#map3d-toggle { min-height: 44px }`, so the
column stays uniformly 38px on every PWA screen instead of growing on phones.
The website still takes the media bump because no `body.is-pwa` matches there.

The switch keeps its dot + `3D`/`2D` label (the dot still glows in 3D); at
`0.74rem` / `0.68rem` the content is ~23px wide inside the 36px content box.
The refresh button's inline `done/total` count (`#map3d-refresh-count`) is
hidden in the PWA square — it cannot fit beside the glyph. It is
`aria-hidden`, and the same progress is still carried by the
`role="status"` `#map3d-refresh-status` live region and the button title, so
assistive technology loses nothing:

```css
body.is-pwa #map3d-refresh .m3d-refresh-count { display: none; }
```

## 2. The group centres while 3D is on

In 2D the single switch still heads the measured bottom-left column (the
`--m3d-anchor-*` machinery from
[MAP3D_SWITCH_BASE_LAYER_COLUMN.md](MAP3D_SWITCH_BASE_LAYER_COLUMN.md) is
untouched). When 3D opens, the refresh button joins the group and the whole
group moves to the bottom-centre slot, directly under the centred 3D bar:

```css
body.is-pwa.is-3d .m3d-toggle-group {
    bottom: calc(64px
        + var(--map3d-safe-area-bottom, env(safe-area-inset-bottom, 0px))
        + var(--country-exit-lift, 0px));
    left: 50%;
    transform: translateX(-50%);
}
```

- **64px + inset** is the historical PWA 3D slot the switch used before it
  moved into the column.
- The selector adds `.is-3d`, so it out-specifies the base
  `body.is-pwa .m3d-toggle-group` column rule only while 3D is open; closing
  3D returns the single switch to the column automatically.
- The group no longer consumes `--m3d-anchor-*` in this state, but the
  properties keep being measured — the 3D bar still rides on
  `--m3d-stack-top` (now well above the centred group), and the 2D column
  placement needs the values again as soon as 3D closes.

### The “Exit view” pill collision

The country “Exit view” pill is bottom-centred in the PWA at
`safe-area + 60px` (~32–35px tall), so a centred group at `64px + inset`
would overlap it when a locked country view is zoomed to its floor while 3D
is open. The existing hook solves it: `js/country-dock.js`
(`evaluateExitButton()`) toggles `body.country-exit-open`, which
`css/country-dock.css` turns into `--country-exit-lift: 46px` (PWA only).
The centred 3D group is now the **only** `.m3d-toggle-group` rule allowed to
read that variable — the 2D column rule and the website rules still never
read it (asserted in both
[test-country-exit-3d-stack.js](test-country-exit-3d-stack.js) and
[test-pwa-3d-button-size-centre.js](test-pwa-3d-button-size-centre.js)).

## Geometry on a 390px phone (no inset)

```
2D, PWA (column)                 3D, PWA (centred)
┌─────────────────────┐          ┌─────────────────────┐
│                     │          │   3D bar (centred)  │  ← --m3d-stack-top + 8
│                     │          │                     │
│ [3D]                │ ← 38×38  │     [2D] [↻]        │  ← 64px up, 38px each
│ [layers]            │          │                     │
│ [N]  [Detect]       │          │  (Exit pill lifts   │
└─────────────────────┘          │   the group +46px)  │
                                 └─────────────────────┘
```

In 2D the group is one 38px square, left-aligned with the 38px base-layer
button below it. In 3D it is two 38px squares with the existing 6px gap
(82px total), horizontally centred.

## Assets and cache

- `index.html` loads `css/map3d-terrain.css?v=20261026-pwa-3d-button-size`.
- `sw.js` bumps the shell to **`detectlab-v285-pwa-3d-button-size`**,
  precaches the new skin URL and keeps every older skin URL (an installed
  shell running the previous `index.html` still finds its own copy).
- The viewer JS did not change, so `js/map3d-terrain.js` keeps its
  `20261026-desktop-basemap` tag.

## Tests

- **`test-pwa-3d-button-size-centre.js`** (new) — the 38px square rule and
  its specificity over the phone media query, the hidden-but-accessible
  refresh count, the centred `is-3d` rule and its pill lift, the untouched
  2D column and website rules, the unchanged JS markup/gating, and the
  re-tag/cache wiring.
- **`test-3d-switch-base-layer-column.js`** — new §1b for the squares and
  the centred 3D group; the headless browser expectations branch on
  PWA-2D (column, 146px fallback) vs PWA-3D (centred, 64px slot) and assert
  the real 38×38 boxes. The vm harness now stubs the module-level `surface`
  so the anchor measurement runs outside a browser (the missing stub made
  §4 crash before this change).
- **`test-country-exit-3d-stack.js`** — the lift may be read by the centred
  3D rule alone; the column/website rules stay lift-free.
- The tag-only constants in the other 3D skin tests
  (`test-3d-basemap-button.js`, `test-3d-basemap-picker-lidar.js`,
  `test-lidar-3d-focus.js`, `test-map3d-mobile.js`,
  `test-map3d-slider-layout.js`, `test-map3d-terrain.js`,
  `test-basemap-restore-and-picker.js`) now expect the new skin tag; their
  viewer-JS constants follow the tag `index.html` actually serves.
