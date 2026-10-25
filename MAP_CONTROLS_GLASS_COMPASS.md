# Map controls: one glass material, and a Google-Earth compass

Two changes to the icon controls that float over the map, plus a behaviour
change to the compass.

The layers window joined the same material in phase 2 — the pane, its
top-level rows and every nested sublayer row, plus a tile photo per historical
sheet: see `LAYER_WINDOW_GLASS.md`.

## 1. The buttons are one translucent “glass pane”, violet on purpose

Every map icon (zoom **+ / −**, live location, measure, coordinates, trail,
offline maps, the PWA nearby button, the PWA account trigger, the base-layer
switcher, the 2D/3D switch and the “?” quick guide) now paints the same
material, declared once in `css/styles.css` `:root`:

| Token | Value | What it is |
|---|---|---|
| `--ctl-radius` | `12px` | the corner of every icon button |
| `--ctl-bg` | `rgba(24, 19, 40, 0.42)` | the pane: dark, violet-tinted, translucent |
| `--ctl-bg-hover` | `rgba(45, 33, 74, 0.58)` | hover / focus lift |
| `--ctl-bg-press` | `rgba(38, 27, 64, 0.66)` | pressed |
| `--ctl-bg-engaged` | `rgba(126, 94, 214, 0.26)` | an engaged *mode* (measure, trail, coordinates, offline, nearby, 3D list) |
| `--ctl-border` | `rgba(198, 180, 255, 0.20)` | hairline edge; `…-hover` / `…-engaged` are the louder versions |
| `--ctl-icon` | `#BBA9F2` | the glyph; `--ctl-icon-hover` `#DCD2FB`, `--ctl-icon-engaged` `#F0EBFF` |
| `--ctl-live` | `#F08298` | live / recording status only (live location, Detect) |
| `--ctl-blur` | `blur(18px) saturate(150%)` | the frost |
| `--ctl-shadow` | `0 6px 18px rgba(4,6,18,.32), inset 0 1px 0 rgba(255,255,255,.07)` | a soft drop, a hairline highlight |

Change a token and the whole family follows. The look is deliberately quiet:
no gradients, no coloured glows, no lettering, no per-layer colours — that is
what makes the row read as instruments on the imagery instead of badges.

Notes on the intent:

* **Hover** brightens the pane and the glyph. It no longer fills the button
  with solid purple (the “cartoon” look the redesign removes).
* **Engaged states** are a soft violet wash — one shared rule, so nine
  different buttons cannot drift apart again.
* **Live status stays a status.** Live location and the PWA Detect toggle use
  a muted rose (`--ctl-live`) rather than a neon red, and only while they are
  actually live.
* The arcgis basemap switcher dropped its lime (`#b9ff14`) accent, and the
  2D/3D switch its tan (`#c8a96e`) one: both now speak the same violet.
* `--ctl-*` are read through `var(…, fallback)` in `css/offline-maps.css`,
  `css/tutorial.css`, `css/map3d-terrain.css` and the inline sheet in
  `index.html`, so the tokens live in one place and the other files still
  degrade gracefully if they are loaded alone.

## 2. The compass is the Google-Earth compass

`js/map-rotate.js` used to render a column of **compass → rotation lock →
Detect**, with a padlock that froze rotation and persisted in `localStorage`.
The lock is gone; the compass now behaves like Google Earth's:

| Gesture | Result |
|---|---|
| The view turns (twist, Alt-drag, drag on the rose) | the rose follows the camera frame by frame, driven by the map's own `rotate` event |
| Tap / `Enter` on the rose | the map eases back to true north — 320 ms cubic ease-out, `moveend` at the end |
| Horizontal drag on the rose | turns the view at 0.55°/px; the trailing click does not also reset north |
| `←` / `→` | nudge 5° (15° with `Shift`) |
| `Home` | face north |
| `prefers-reduced-motion: reduce` | the reset is instant instead of animated |

Details worth knowing:

* A press only becomes a drag after 3px of horizontal travel, so a plain tap
  is never swallowed by the deadband.
* `pointerdown` deliberately does **not** `preventDefault()`: that would also
  eat the click a tap needs. `touch-action: none` on the rose keeps a phone's
  pan gesture from taking the drag, and `index.html` exempts the compass from
  its `body.is-pwa … touch-action: pan-x pan-y !important` rule.
* The rose is drawn without letters — a hairline ring, a two-tone needle and a
  single hub dot — so nothing can read upside-down when the view is turned.
  The needle's north half brightens once the view is off north, and the
  `aria-label` reports the current offset in degrees.
* Unlike Google Earth *web*, which hides its compass while the view is
  north-up, the compass here stays visible: it heads a fixed column, and a
  button that appears and disappears would make the Detect toggle below it
  jump. The off-north state is signalled instead — the needle's north half
  brightens and the pane's edge strengthens.
* The column is now two buttons in the installed app (compass + Detect) and
  one on the website, which lifts the PWA bottom-left corner from
  `192px + inset` to `146px + inset` (`--m3d-anchor-bottom` fallback in
  `css/map3d-terrain.css`; the measurement in `js/map3d-terrain.js` still
  wins when it runs).

### Removed API

`L.Map.prototype.isRotateLocked`, `L.Map.prototype.setRotateLocked`, the
`rotatelockchange` event, the `rotateLocked` map option and the
`detectlab_rotation_locked` storage key are gone. Nothing in the app called
them except the compass control itself; the key is actively deleted on mount
so a visitor who had locked rotation cannot come back to a map that refuses to
turn. `setBearing()` no longer takes a `force` / `noLockCheck` flag (callers
that still pass one are unaffected — extra options are ignored).

## 3. Tutorial copy

`js/tutorial.js` described the lock (“the lock button underneath…”). It now
describes the two real gestures: tap to face north, drag to rotate, no lock.

## 4. Assets

`index.html` re-tags `css/styles.css`, `css/tutorial.css`,
`css/offline-maps.css`, `css/map3d-terrain.css`, `js/tutorial.js`
(`?v=20261025-layer-glass`) and `js/map-rotate.js`
(`?v=20261025-earth-compass`); the same URLs are appended to
`PRECACHE_URLS` in `sw.js` and `CACHE_NAME` moves to
`detectlab-v269-glass-compass` (phase 2 of the same release moved the skin tag
to `?v=20261025-layer-glass` and the shell to `detectlab-v270-layer-glass`;
see `LAYER_WINDOW_GLASS.md`). Older tags stay in the precache list, so an
installed shell still finds the copy it references.

## 5. Tests

* `test-map-rotate-lock.js` — rewritten for the lock-free compass: no lock
  API, stale key cleared, exactly two buttons in the column, the rose tracks
  the bearing, tap faces north, a 60px drag turns 33°, the click that ends a
  drag does not reset, keys nudge, the glass tokens are in the stylesheet.
* `test-3d-switch-base-layer-column.js`, `test-country-exit-3d-stack.js`,
  `test-3d-basemap-picker-lidar.js`, `test-lidar-3d-focus.js` — the shorter
  compass column (`100px` website / `146px + inset` PWA) and the re-tagged
  3D skin.
* `test-map-control-spacing.js`, `test-mobile-fullscreen-controls.js`,
  `test-country-layer-filter.js`, `test-map3d-terrain.js`,
  `test-map3d-mobile.js`, `test-map3d-slider-layout.js`,
  `test-basemap-restore-and-picker.js` — the re-tagged stylesheets.
