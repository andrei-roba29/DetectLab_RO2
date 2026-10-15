# Third-party WMS / WMTS availability guard

`js/wms-health.js` + `tools/audit-wms-layers.mjs`. The audit of every raster
layer the map can draw is in **`WMS_WMTS_LAYER_AUDIT.md`** (regenerate with
`node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md`).

## The failure this guards against

A third-party raster server can break **without returning an HTTP error**. On
2026-10-13 every `GetMap` of the IH PAN GeoServer
(`https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms`) answered **200 OK** with
a Java exception as the body:

```
java.lang.RuntimeException: Unable to create a valid ImageInputStream for the
provided input: /opt/geoserver/data_dir/cartomatic/UKvME/mosaick/ukvme_3857_transparent.ecw
```

(`kdr`, `chrzanowski`, `reymann`, `m25k`, `gdansk`, `ahp_*` — on that day the
whole raster catalogue answered like this; only the server operator can fix it.)
By 2026-10-15 the operator had brought everything back **except the
Web-Mercator (`…_3857`) mosaics of two sheets — `ukvme` and `kdr`** — which
still answer with the same `…_3857_transparent.ecw` exception. Those two rows no
longer produce it: see *When the sheet's `_3857` mosaic is dead* below. A
browser cannot decode such a body as an image, so:

- **DevTools** showed a wall of `200 OK` image requests whose Preview pane said
  **“Nothing to preview”** — that is the symptom users report;
- **Leaflet** fired `tileerror` for every tile and left the layer silently
  blank, with hundreds of requests per pan/zoom;
- the app looked broken even though the app was fine.

The same class of failure exists on every provider: a service outage, a
maintenance page, a `ServiceException` body, an ArcGIS JSON error, a 401 from a
misconfigured token.

## When the sheet's `_3857` mosaic is dead — the 2026-10-15 repoint

Reported twice by the user as *“This map cannot be loaded”* on the **Central
Europe Map 1:300k (1893–1945)** and **German Empire Map 1:100k (1878–1945)**
rows. The guard was right: the provider really does answer those two rows with
an error instead of an image.

What the browser-free check (`GetMap` + `GetFeatureInfo`, request CRSes
`1.1.1`/`SRS=EPSG:3857` and `1.3.0`/`CRS=EPSG:2180`) showed on 2026-10-15:

| layer asked for | answer |
|---|---|
| `ihpan:ukvme_3857` | 200 + `Unable to create a valid ImageInputStream … UKvME/mosaick/ukvme_3857_transparent.ecw` |
| `ihpan:ukvme_3857_transparent` | `Could not find layer` — that name does not exist |
| `ihpan:ukvme_2180` | PNG, opaque pixels (Warsaw `38/7/22/255`, Berlin `179/163/182/255`) |
| `ihpan:kdr_3857` | 200 + the same exception for `kdr/mosaick/kdr_3857_transparent.ecw` |
| `ihpan:kdr_2180` | PNG, opaque pixels (Poznań `33/32/21/255`, Berlin `199/203/182/253`) |
| every other `…_3857` the app uses (`chrzanowski`, `reymann`, `kdr_gb`, `wig100k`, `wig25k`, `wig300k`, `m25k`, `TKKP_126k`, `ahp_*`, …) | PNG — the rest of the catalogue recovered |

**The fix is a name, not a workaround.** CENAGIS publishes the same sheets once
per CRS, and the `…_2180` twin of each is readable, so the two catalogue entries
in `js/layer-registry.js` now name the readable twin (`kdr_2180`, `ukvme_2180`)
and both views stay correct:

* **2D** asks the WMS for `EPSG:3857` tiles as always — the GeoServer
  re-projects the PL-1992 mosaic onto the Web-Mercator grid server-side;
* **3D** goes through the same-origin tile proxy, which asks in `EPSG:2180`
  with the tile bbox transformed into PL-1992 (exactly like the two Warsaw
  city-plan sheets that have always been 2180-only).

The premium panel rows (`premium.mitteleuropa`, `premium.kdr-100k`) take their
`LAYERS` value **from the catalogue entry** instead of repeating it, because
they are separate registry entries for the same sheet and had drifted: one row
asking for the readable twin while the other still asked for the dead mosaic
would have kept the notice on screen.

The audit keeps this from silently reverting:

* `DEAD_MOSAICS` in `tools/audit-wms-layers.mjs` records the two unreadable
  mosaics, what they answer and since when; `W_DEAD_MOSAIC` **fails the audit**
  if any row asks for one of them again, and a `REPOINTED` info finding records
  the rows that ask for the twin;
* `SAME_SHEET_PAIRS` fails with `PAIR_DRIFT` when a premium row and its
  catalogue row name different mosaics.

If CENAGIS ever repairs the `…_3857` ECWs, flipping the rows back is a two-line
change (`wms_layer` in the catalogue) — check first with
`node tools/audit-wms-layers.mjs --layer=cenagis.kdr --tile=12/2345/1480`, then
remove the entry from `DEAD_MOSAICS`.

## What the guard does (`js/wms-health.js`)

Loaded from `index.html` right after `js/leaflet.js`, before `js/map-app.js`,
`js/historical-eu-maps.js` and the country modules.

**Hosts.** `HOSTS` is the list of third-party raster hosts worth reporting this
way, with the provider name the notice shows:

| host | provider shown |
|---|---|
| `pastmaps.cenagis.edu.pl` | CENAGIS / IH PAN |
| `services.geo-spatial.org` | geo-spatial.org (eHarta) |
| `data.geopf.fr` | IGN France / Géoplateforme |
| `copernicus.discomap.eea.europa.eu`, `image.discomap.eea.europa.eu` | Copernicus Land / EEA discomap |
| `wms-mapa-lidar.idee.es` | IGN España / IDEE |
| `mapy.geoportal.gov.pl` | GUGiK / geoportal.gov.pl |
| `geoserve.cast.uark.edu` | CAST / University of Arkansas (CORONA) |
| `wmts.geo.admin.ch` | swisstopo |
| `environment.data.gov.uk` | Environment Agency (England) |
| `hoydedata.no` | Kartverket (høydedata.no) |
| `ahn.arcgisonline.nl` | AHN / Esri Nederland |
| `phenology.hrvpp2.vgt.vito.be` | VITO / Copernicus HR-VPP |

A re-pointed catalogue (`window.DETECTLAB_CENAGIS_WMS`, read by
`js/layer-registry.js`) is registered as `CENAGIS / IH PAN (mirror)` at load
time, so a mirror is guarded too. `WATCH_ONLY_HOSTS`
(`geoserve.cast.uark.edu`) are never probed: CORONA publishes one layer per
flight, and one failed flight must not switch the row off.

**Modes.**

- **probe** — `layer.onAdd()` is delayed by a single image request built exactly
  like the tile Leaflet would ask for: the WMS factory layers through
  `sampleUrl()`, the country modules through their own builder
  (`probeUrlFor()` → `DetectLabLayers.tileUrlAt(tile under the view centre)`,
  or the middle of the layer's own `bounds` when the centre is outside them).
  A broken server gets **one** request, not a screenful.
- **watch** — the layer is added straight away and its tiles are counted: three
  failures with no success, or eight with successes, trip it. Layers added to
  the map by the country modules are adopted in this mode when they go on the
  map (`L.Map.prototype.addLayer` is hooked once).

**What counts as a failure.** `onerror`, or an `onload` with no intrinsic size,
or no answer within 9 s. Modules that hide the error from Leaflet
(`js/ahn-layer.js`, `js/hoydedata-layer.js` paint a transparent tile and call
`done(null, tile)`) call `DetectLabWmsHealth.noteFailure(layer)` for every
failed fetch instead — same threshold, same outcome.

**Verdicts** are keyed `<host>|<layers>`, so the rasters of a server fail and
recover independently of its other layers. A down verdict is sticky for 60 s:
re-toggling inside the cooldown sends **no** request and re-shows the notice.

**The UI says what happened.** The row gets `data-wms-state="down"`, is dimmed,
its switch is turned back off, and a dismissible notice names **the provider
that failed** and the layer(s), in RO/EN via `_currentLang`/`<html lang>`:
“This map cannot be loaded … The map provider’s server (**IGN France /
Géoplateforme**) answers with an error instead of an image …”. Offline
(`navigator.onLine === false`) is reported as a connection problem and leaves no
cooldown behind.

**Retry** forgets the verdicts and re-checks exactly the switches the guard
itself turned off — never a layer the user never asked for — and replays the
app’s own `change` handlers, so the layers go back through the guard. Rows are
found through the shared registry (`ui.toggle`, `ui.select`, `ui.selector`,
`ui.wmsHealthKeys`) with the legacy `<key>MapToggle`/`<key>Row`,
`.cenagis-toggle[data-map-key]` and `.cenagis-map-row[data-map-id]` shapes as a
fallback.

**Configuration errors are not outages.** `markUnavailable(layer, message)`
switches the row off and shows the given message verbatim — that is what
`js/dataforsyningen-dhm-layer.js` and `js/lantmateriet-hojdmodell-layer.js` use
for a missing deployment token/credential, so “the layer is not configured on
this deployment” never reads as “the provider is down”.

Safety: if anything a probe needs is missing (no `Image`, no map size, no
settings beyond the defaults), the guard **fails open** and adds the layer
exactly as before.

## Wiring a new layer into the guard

- **Hosted by a listed provider, built through `L.tileLayer.wms`** — nothing to
  do, the factory wrapper guards it.
- **Built by a module** (`L.GridLayer` / WMTS / ArcGIS `exportImage`) — nothing
  to do either, as long as its host is in `HOSTS`: adoption uses the registry
  definition (`ui.*`, `builder`) to find the row, the title and the probe.
- **New host** — add it to `HOSTS` in `js/wms-health.js` with the provider name,
  and to the `SIGNATURES` table in `tools/audit-wms-layers.mjs` describing what
  its failure looks like (the audit fails without it).
- **Rows the naming conventions miss** — attach them in the registry
  (`ui.toggle`/`ui.select`/`ui.selector`/`wmsHealthKeys`) or, for a one-off,
  after creating the layer:

  ```js
  layer._detectlabUiKeys = ['mitteleuropa'];
  layer._detectlabUiTitle = 'Übersichtskarte von Mitteleuropa';
  ```

- **A module that hides tile errors** — call
  `window.DetectLabWmsHealth.noteFailure(this)` from the error path (see
  `js/ahn-layer.js`'s `reportTileFailure()`).
- **A configuration error** — call
  `window.DetectLabWmsHealth.markUnavailable(layer, message)`; do not let it
  read as a provider outage.

Keys must **not** travel inside the layer options — Leaflet copies every unknown
option into the WMS query string.

## The audit tool

```bash
node tools/audit-wms-layers.mjs                  # table + findings, exits 1 on an error
node tools/audit-wms-layers.mjs --urls           # one sample request URL per layer
node tools/audit-wms-layers.mjs --json           # machine-readable
node tools/audit-wms-layers.mjs --layer=cenagis.ukvme --tile=12/2345/1480
node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md
```

It never talks to the network: it rebuilds every layer's request with the same
code the map uses (registry + the eight country modules in `vm` sandboxes) and
checks it against the service's documented contract — endpoint scheme, LAYERS,
version/CRS pair (`1.3.0` → `CRS`, `1.1.1`/`1.1.0` → `SRS`), format vs
transparency, WMTS KVP and `TIME`, `maxNativeZoom`, CORS/proxy routing, the
guard coverage of every third-party host, and that no module hides a failure
from the guard. Current state: **72 layers, 0 errors, 69/69 third-party layers
guarded (58 probed, 11 watched), 3 same-origin/runtime**.

## Tests

- `node test-wms-health.js` — stub-DOM suite: probe URL, failed probe → switch
  off + row `data-wms-state="down"` + notice, cooldown, retry scoping,
  tile-error trip, offline path, balanced add/remove while a probe is pending,
  notice naming per provider, registry-defined rows, `noteFailure()`, plus the
  static wiring in `index.html`/`sw.js`/the app modules.
- `node test-wms-layer-audit.js` — runs the tool, asserts no errors, that every
  third-party layer is guarded, that the sample requests are KVP-correct, that
  the country modules load and build real URLs, and that the generated report
  documents every layer, provider failure signature and deployment requirement.
- Re-run `node test-historical-eu-maps.js`, `node test-country-layer-filter.js`
  and `node test-arcgis-primary-atlas.js` after touching the catalogue or the
  version pins; `node test-netherlands-ahn.js`, `node test-norway-hoydedata.js`,
  … for the per-country modules.

## Manual QA

- With a provider outage live (or any URL that returns a non-image 200), switch
  the row on → **one** network request, the row dims, the switch returns to off
  and the notice names that provider; “Retry” probes once more.
- Point `window.DETECTLAB_CENAGIS_WMS` at a mirror (or a 404 host) → the raster
  rows follow the same path and the notice says …(mirror).
- Go offline (DevTools → Network → Offline) → the notice blames the connection,
  and re-toggling after going back online works without waiting for a cooldown.
- Unset `DATAFORSYNINGEN_TOKEN` → the Denmark row shows the “not configured on
  this deployment” message, not the provider-outage one.
- The two repointed rows (Central Europe 1:300k, German Empire 1:100k) switch
  on **without** a notice in both the 2D map and the 3D view: they are served
  by the sheets' EPSG:2180 mosaics, so a notice here means the provider has
  broken something else — check with
  `node tools/audit-wms-layers.mjs --layer=cenagis.kdr --tile=12/2345/1480`
  and the `GetFeatureInfo` probes in the table above.

## Service worker

`CACHE_NAME` is `detectlab-v211-cenagis-repoint`; the precache list carries
`js/wms-health.js?v=20261014-guard-watch`,
`js/ahn-layer.js?v=20261014-tile-failure-hook`,
`js/hoydedata-layer.js?v=20261014-tile-failure-hook`,
`js/layer-registry.js?v=20261015-cenagis-repoint`,
`js/layer-registry.js?v=20261014-wms-audit` and
`js/dataforsyningen-dhm-layer.js?v=20261014-dk-token-message`, matching the
`?v=` pins in `index.html`. Old tags stay in the list (the established pattern)
so a client that still has the previous shell cached can resolve them.
