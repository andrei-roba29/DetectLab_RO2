# “Choose your country” clears the phone's status bar (v249)

Date: 2026-10-21 · Files: `css/globe-country-picker.css`, `index.html`,
`sw.js` · Tests: `node test-globe-gate-safe-area.js`,
`node test-globe-arcgis-gate.js`, `node test-globe-canvas-picker.js`

---

## Symptom

Opening the country gate in the installed PWA (and in a mobile browser tab on
iOS), the top of the screen was unusable: **“Choose your country”** was painted
behind the clock/notch, the description lost its first lines, and the gate's
**✕** was half hidden under the status bar. The globe itself was fine.

Measured in Chromium with the real stylesheets and
`Emulation.setSafeAreaInsetsOverride` at `top: 59px` (Face-ID iPhone class):

| Element | Before | After |
|---|---|---|
| `.globe-gate-title` top | **14 px** | 73 px |
| `#globeGateCloseBtn` top | **12 px** | 71 px |
| zoom stack bottom | 826 px (of 844) | 792 px (`844 − 34 − 18`) |

Anything above `y = 59` is inside the status bar.

## Cause

`.globe-gate` is `inset: 0` of `.map-wrapper`, and in the installed PWA that
wrapper *is* the whole screen — `body.is-pwa #map-section` is
`position: fixed; top: 0; bottom: 0` with a `min-height: 100vh` floor
(`index.html`), because the map is the safe-area background. So the gate's
origin is the physical top edge of the display, under the translucent status
bar where `env(safe-area-inset-top)` is ~47–59 px.

The gate's own chrome ignored that variable entirely:

| Rule | Value before |
|---|---|
| `.globe-gate-chrome` | `padding: 18px 20px 14px` |
| `@media (max-width: 640px) .globe-gate-chrome` | `padding: 14px 14px 10px` |
| `#globeGateCloseBtn` | `top: 12px !important; left: 12px !important` |
| `.globe-gate-reopen` | `top: 14px` (only fullscreen added the inset) |
| `.globe-gate-zoom` / `.globe-gate-hint` | `bottom: 18px` / `22px` |

Every other floating control in the app already offsets itself
(`.map-search-wrap` → `14px + inset-top`, `body.is-pwa .leaflet-top` →
`70px + inset-top`, `body.is-pwa .leaflet-bottom` → `inset-bottom`, the ✕ list
of fullscreen controls…). The gate was the one surface that filled the screen
without asking.

## Fix (`css/globe-country-picker.css`)

```css
.globe-gate-chrome {                     /* header band */
    padding: calc(18px + env(safe-area-inset-top, 0px)) 20px 14px;
}
@media (max-width: 640px) {
    .globe-gate-chrome { padding: calc(14px + env(safe-area-inset-top, 0px)) 14px 10px; }
}
#globeGateCloseBtn {                     /* the gate's ✕ */
    top: calc(12px + env(safe-area-inset-top, 0px)) !important;
    left: calc(12px + env(safe-area-inset-left, 0px)) !important;
}
.globe-gate-reopen { top: calc(14px + env(safe-area-inset-top, 0px)); }
.globe-gate-zoom  { bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
.globe-gate-hint  { bottom: calc(22px + env(safe-area-inset-bottom, 0px)); }
```

Notes

- **No `body.is-pwa` gate on the CSS.** `env(safe-area-inset-*)` already
  reports `0px` wherever the page is not under system chrome, so the desktop
  browser keeps the historical `18 / 14 / 12 / 22 px` anchors — verified at
  `1280×800` (18/12/18) and at `390×844` in a plain tab (14 px header).
- The old `.map-frame.is-fullscreen .globe-gate-reopen { top: calc(14px + …) }`
  override is gone: the base rule now carries the inset, and in fullscreen the
  frame *is* the screen, so one declaration covers both.
- Bottom edge follows the app's existing PWA convention (`body.is-pwa
  .leaflet-bottom → env(safe-area-inset-bottom)`): the zoom stack and the
  hovered-country hint stop landing on the home indicator / gesture bar.
- The globe canvas itself stays full-bleed on purpose — only chrome is inset.

## Assets

`index.html`, `sw.js` and `tools/globe-gate-preview.html` re-tag
`css/globe-country-picker.css?v=20261021-gate-safe-area`; `CACHE_NAME` moves to
`detectlab-v249-gate-safe-area-top`.

## Verification

- `node test-globe-gate-safe-area.js` — static assertions (both header
  variants carry the inset, ✕ / pill / zoom / hint, no `body.is-pwa` switch,
  cache wiring) plus optional Chromium measurements with emulated insets:
  `PUPPETEER_MODULE_DIR=/path/to/node_modules node test-globe-gate-safe-area.js`.
- `test-globe-arcgis-gate.js` and `test-globe-canvas-picker.js` keep passing;
  the full `node test-*.js` sweep shows no new failures.
