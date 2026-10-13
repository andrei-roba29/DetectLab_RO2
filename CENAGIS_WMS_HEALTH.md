# CENAGIS / IH PAN historical maps — availability guard

## The failure this guards against

The historical sheets streamed from the IH PAN GeoServer
(`https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms`) can break **without
returning an HTTP error**. On 2026-10-13 every `GetMap` for the raster
catalogue answered **200 OK** with a Java exception as the body:

```
java.lang.RuntimeException: Unable to create a valid ImageInputStream for the
provided input: /opt/geoserver/data_dir/cartomatic/UKvME/mosaick/ukvme_3857_transparent.ecw
```

(`kdr`, `chrzanowski`, `reymann`, `m25k`, `gdansk`, `ahp_*` — the whole raster
catalogue; only the server operator can fix it.) A browser cannot decode that
body as an image, so:

- **DevTools** showed a wall of `200 OK` image requests whose Preview pane said
  **“Nothing to preview”** — that is the symptom users report;
- **Leaflet** fired `tileerror` for every tile and left the layer silently
  blank — no message, no explanation, hundreds of requests per pan/zoom;
- the app looked broken even though the app was fine.

## What the guard does (`js/wms-health.js`)

Loaded from `index.html` right after `js/leaflet.js`, before `js/map-app.js`
and `js/historical-eu-maps.js`. It wraps `L.tileLayer.wms` and only touches
layers whose host is in `HOSTS` (`pastmaps.cenagis.edu.pl` today).

1. **One probe per add.** `layer.onAdd()` is delayed by a single image request
   built exactly like the tile Leaflet would ask for — same
   `service/request/layers/format/transparent/version`, same `srs`/`crs`, same
   256 px tile, and the **bbox of the tile under the view centre** (if the
   centre lies outside the layer's own `bounds`, the middle of the sheet's
   coverage is probed instead, since the visible tile may legitimately be
   outside `bounds`). A broken server therefore gets **one** request, not a
   screenful, and the probe URL is byte-identical to Leaflet's own tile URL
   (verified in jsdom against real `js/leaflet.js`).
2. **An image that never decodes counts as down** — `onerror`, or an `onload`
   with no intrinsic size, or no answer within 9 s.
3. **A down verdict is sticky for 60 s.** Re-toggling the layer inside the
   cooldown makes no request at all and re-shows the notice.
4. **The UI says what happened**: the row gets `data-wms-state="down"`, is
   dimmed, the switch is turned back off, and a dismissible notice explains
   that the **provider's server** answered with an error instead of an image
   and that the rest of the map keeps working. Bilingual (RO/EN) via
   `_currentLang`/`<html lang>`. `js/map-app.js` also refreshes
   `updatePremiumMapCoverageVisibility()` on `layerremove` for its premium
   layers, so a guard-removed layer takes its zoom-out coverage rectangle
   with it immediately instead of at the next zoom.
5. **Retry** forgets the verdicts and re-checks exactly the switches the guard
   itself turned off (never a layer the user never asked for) and replays the
   app's own `change` handlers, so the layers go back through the guard.
6. **Mid-session outages** trip the same path: an accepted layer that then
   fails three tiles with no success in between (or eight with successes) is
   removed, marked and explained.
7. **Offline is not blamed on the server** (`navigator.onLine === false`) and
   leaves no cooldown behind — the notice says the connection is at fault and
   nothing is cached as a server verdict.

Safety: if anything the probe needs is missing (no `Image`, no map size) the
guard **fails open** and adds the layer exactly as before.

## Wiring a new layer into the guard

The guard needs to know which row/switch belongs to a layer. Two ways:

- **Premium panel rows** (`js/map-app.js`, e.g. `#mitteleuropaRow` /
  `#mitteleuropaMapToggle`): after creating the layer,

  ```js
  window._mitteleuropaMapLayer._detectlabUiKeys = ['mitteleuropa'];
  ```

- **Country catalogue rows** (`js/historical-eu-maps.js` `createLeafletLayer`):
  the guard reads `.cenagis-map-row[data-map-id]` + `.cenagis-toggle[data-map-key]`
  and the title goes in the notice, so both are attached in one place:

  ```js
  layer._detectlabUiKeys = [mapKey];
  layer._detectlabUiTitle = mapMeta.title[lang] || ...;
  ```

New hosts go into `HOSTS` in `js/wms-health.js`; new row shapes into
`toggleEls()` / `rowEls()` / `nameFor()`.

Keys must **not** travel inside the layer options — Leaflet copies every
unknown option into the WMS query string.

## Also fixed here

`js/historical-eu-maps.js` was asking the `ihpan` workspace through the stock
GeoServer prefix: `layers: 'topp:' + mapMeta.wms_layer` (and the layer-info
dialog printed `topp:` too). This server happens to match the layer by local
name, so it worked, but it was wrong — the guard and the catalogue now ask
`ihpan:` explicitly on `pastmaps.cenagis.edu.pl/geoserver/ihpan/wms`.

## Tests

- `node test-wms-health.js` — stub-DOM suite: probe URL, failed probe →
  switch off + row `data-wms-state="down"` + notice, cooldown, retry scoping,
  tile-error trip, offline path, balanced add/remove while a probe is pending,
  notice naming, plus the static wiring in `index.html`/`sw.js`/the two app
  modules.
- `/tmp/qa/guard-integration.js` (`node`) — jsdom with the **real**
  `js/leaflet.js` + `js/wms-health.js`: probe URL identical to Leaflet's own
  tile URL, one request only, the row/switch/notice chain, Retry.
- Re-run `node test-historical-eu-maps.js`, `node test-country-layer-filter.js`
  and `node test-arcgis-primary-atlas.js` after touching the catalogue or the
  version pins.

## Manual QA

- With the CENAGIS outage live (or any URL that returns a non-image 200),
  switch on “Übersichtskarte von Mitteleuropa” → **one** network request, the
  row dims, the switch returns to off and the notice appears; “Retry” probes
  once more.
- Break the URL on purpose (`CENAGIS_WMS_URL` → any 404 host) → same path for
  the raster rows, while the WMS **vector** layers of that server (which are
  not guarded yet) are unaffected.
- Go offline (DevTools → Network → Offline) → the notice blames the
  connection, and re-toggling after going back online works without waiting
  for a cooldown.

## Service worker

`CACHE_NAME` is `detectlab-v192-flat-hist-maps`; the precache list carries
`js/wms-health.js?v=20261013-wms-guard`, `js/map-app.js?v=20261013-wms-guard`
and `js/historical-eu-maps.js?v=20261013-flat-hist-maps`, matching the `?v=`
pins in `index.html`.
