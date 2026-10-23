# PWA: the 2D⇄3D switch sits right above the base-layer button (v255)

Date: 2026-10-21 · Files: `js/map3d-terrain.js`, `css/map3d-terrain.css`,
`index.html`, `sw.js` · Test: `node test-pwa-3d-above-basemap.js`

> **Supersedes the v254 release** (PR #332, cache
> `detectlab-v254-3d-switch-baselayer-column`). v254 made the same move but did
> it for **every** layout — it relocated the website's switch from bottom-centre
> to bottom-left too — and placed it with offsets measured in JS at runtime
> (`--m3d-anchor-bottom` / `--m3d-anchor-left` / `--m3d-stack-top`, with 146px
> and 192px fallbacks, plus a `ResizeObserver`/`MutationObserver` watcher and a
> 250 ms retry loop to keep re-measuring). That implementation and its test are
> gone from this branch: the request was to move the button **only in the PWA**,
> and the placement is now done by the column's own layout instead of by
> measured pixel offsets.

---

## Symptom

In the **installed PWA** the 2D⇄3D switch floated at the **bottom centre** of
the map, ~66px up, with the refresh button next to it. The controls that decide
*what the map is drawn on* — the compass column and the ArcGIS **base-layer**
button — live in the map's own column at the **bottom left**. On a phone the two
groups sat diagonally across the screen from each other, and the switch covered
the middle of the map while the layer column hugged the left edge.

On the **website** the bottom-centre placement is intentional and stays: there
is room, and the switch is looked for where it has always been.

## Cause

`css/map3d-terrain.css` places `.m3d-toggle-group` absolutely in the map
wrapper, centred:

```css
.m3d-toggle-group {
    position: absolute;
    bottom: calc(66px + var(--layer-dock-clearance, 0px) + var(--country-exit-lift, 0px));
    left: 50%;
    transform: translateX(-50%);
}
```

That rule is shared by both shells; nothing knew the installed app has no
bottom bar and that its bottom edge already belongs to Leaflet's control
column. The switch was never *inside* the column, so no amount of z-index or
`bottom:` tuning could put it above the base-layer button on every screen size,
with every safe-area inset and with the basemap list both folded and unfolded.

## Fix

**Structure, not offsets.** In the PWA the switch group is mounted *into*
Leaflet's bottom-left corner, in a slot inserted **immediately before**
`#arcgisBasemapCtrl` (the base-layer button). Leaflet stacks a bottom corner
top-down, and `Control.addTo()` inserts every new bottom control at
`corner.firstChild`, so "immediately before the basemap control" *is* "one row
directly above it", whatever the column's height, margins or safe-area
anchoring happen to be.

```
bottom-left column, installed PWA
┌─────────────┐
│  [ 3D ]     │  ← #map3d-toggle-slot  (the switch group, + refresh in 3D)
│  [ ▤ ]      │  ← #arcgisBasemapCtrl  (base layer: Imagery/Topo/Terrain)
│  [ ✥ ]      │  ← compass column (compass, rotation lock, detect)
└─────────────┘
```

### `js/map3d-terrain.js`

* `pwaLayout()` — `is-pwa` on `<html>` **or** `<body>`. `index.html` adds the
  class to both; `map-app.js` runs `initMap()` before the footer script adds it,
  which is exactly why the placement below retries.
* `toggleHost()` — the wrapper (bottom-centre) on the website, the slot inside
  the bottom-left corner in the PWA. If the corner does not exist yet the
  wrapper is used as a temporary fallback, never a dead end.
* `ensureToggleSlot(corner)` — creates `<div id="map3d-toggle-slot"
  class="m3d-toggle-slot">`, places it before `#arcgisBasemapCtrl` and guards it
  with `L.DomEvent.disableScrollPropagation` + stopPropagation on mouse, touch,
  pointer, click, dblclick, contextmenu and wheel. The slot now lives inside
  `#detectlab-map`, so without the guard a tap would pan the map or drop a point
  in the click-to-locate tools.
* `placeToggleSlot(corner)` — idempotent re-assertion of the order: if the slot
  is not immediately followed by `#arcgisBasemapCtrl` (or is not the first child
  when the basemap control is absent) it is re-inserted. Called on every mount,
  on every `refreshToggle()` (open, close, language change) and on every boot
  retry, so a control that Leaflet adds *later* cannot wedge itself between the
  switch and the base layer.
* `boot()` — `ensureToggle()` then `placeToggleSlot()`; the 250 ms retry loop
  (80 tries) keeps re-running it until the group is mounted and, in the PWA,
  `toggleGroup.parentNode === toggleSlot`. The retry is what catches a map that
  is built after the viewer script, and the moment `.is-pwa` is added.

### `css/map3d-terrain.css`

```css
.m3d-toggle-slot {                       /* a normal row of the column */
    float: left;
    clear: both;
    margin: 0 0 8px 10px;                /* the column's 10px inset + 8px gap */
    pointer-events: none;                /* the buttons re-enable themselves */
}

body.is-pwa #map3d-toggle-slot .m3d-toggle-group {
    position: static;                    /* flow, not bottom-centre */
    left: auto; right: auto; bottom: auto;
    transform: none;
    z-index: auto;
    width: auto;
}

body.is-3d #detectlab-map .leaflet-control-container #map3d-toggle-slot {
    visibility: visible;                 /* the switch is the way back to 2D */
}

body.is-pwa.is-3d #detectlab-map .leaflet-bottom.leaflet-left > .leaflet-control {
    display: none;                       /* the invisible column leaves the layout */
}

body.is-pwa.is-3d #map3d-toggle-slot {
    margin-bottom: 46px;                 /* 24px credit button + 10px margin + 8px gap + 4px slack */
}
```

`body.is-pwa #map3d-toggle-slot …` wins on id specificity over the existing
`body.is-pwa.is-3d .m3d-toggle-group` bottom-centre rule, so 3D does not pull
the switch back to the middle. The group keeps `pointer-events: none` and the
two buttons keep `pointer-events: auto`, so the transparent slot never eats a
tap aimed at the map.

In 3D the Leaflet control container is hidden with `visibility: hidden` (layout
kept, which is why the empty column used to hover); the slot re-declares
`visibility: visible` so the switch survives, and the other controls of the
column leave the flow so the switch drops to the corner. The 46px margin keeps
it clear of MapLibre's compact source-credit button (24px + 10px margin + the
8px gap + 4px slack), and 46 + 44 = 90px still clears the 3D bar's 108px
offset.

### Website

No non-PWA rule references the slot, and the base `.m3d-toggle-group` rule is
untouched: bottom-centre, 66px + the layer-dock clearance + the country
“Exit view” lift, `left: 50%` + `translateX(-50%)`. Not one pixel of the website
layout changes.

## Limits of the verification

There is no Chromium/WebKit in the verification sandbox, so the fix is proven by

* static assertions on the stylesheet (slot row, neutralised centring, the 3D
  visibility exemption, the hidden column, the 46px lift, and that no non-PWA
  selector references the slot), and
* a `vm` sandbox that boots the real `js/map3d-terrain.js` against a hand-built
  DOM (Leaflet's own `insertBefore(firstChild)` ordering, a late basemap
  control, a late `is-pwa` class, and the web fallback).

Geometry on a physical phone should still be eyeballed once.

## Assets

`index.html` and `sw.js` carry `?v=20261021-pwa-3d-above-basemap` for
`js/map3d-terrain.js` and `css/map3d-terrain.css`; `CACHE_NAME` is
`detectlab-v255-pwa-3d-above-basemap`. Older tagged entries — including the
`?v=20261021-3d-switch-baselayer-column` pair that v254 shipped — stay in
`PRECACHE_URLS`, because the list is a history of what an installed shell may
still ask for, and the install is best-effort: it logs a warning instead of
failing when an old tag is gone.

## Tests

`node test-pwa-3d-above-basemap.js` —

1. the slot and both stylesheets, plus the website geometry, as text;
2. the real viewer in a `vm` sandbox: PWA → the group is inside the slot,
   the slot is the row directly above `#arcgisBasemapCtrl`, the compass stays
   below, a basemap control added *after* boot is still kept below the switch,
   and `<html class="is-pwa">` alone is enough;
3. website → the group stays in the wrapper, no slot is created;
4. `index.html`/`sw.js` request both files with the new tag and the cache is
   v255 or newer.
