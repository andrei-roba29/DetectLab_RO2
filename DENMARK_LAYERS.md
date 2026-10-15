# Denmark · Danish maps — how the layer group works

*(README section for the Danish work; the machine-checked catalogue lives in
`WMS_WMTS_LAYER_AUDIT.md`, the licences and credentials in `DATA_SOURCES.md`,
and the LiDAR/terrain companion in `DENMARK_LIDAR_DATAFORSYNINGEN.md`.)*

Six Danish entries — three base maps, two overlays and one disabled placeholder
— are described in **`js/danish-layers.config.js`** and drawn by
**`js/danish-layers.js`**. They appear in the existing layer panel as one group,
*“Danmark · danske kort / Denmark · Danish maps”*, and the base maps also appear
as buttons in the existing basemap control. Nothing about the existing layers,
their controls, the projections or the default view changed.

```
index.html                          #danishRow … #danishSubLayers (one empty container)
js/danish-layers.config.js          the six layers — the only file to edit for a change
js/danish-layers.js                 reads the config, builds rows, panes, tiles, WFS
backend/src/lib/danish-layers.mjs   the three routes: credentials, params, cache
backend/src/lib/danish-layers.config.cjs  generated copy of the config (see below)
backend/src/routes/geoProxy.js      the same routes for the Express deployment
netlify/functions/dk-*.mjs          thin wrappers for Netlify
tools/map3d-dev-server.mjs          serves the routes locally (phone testing, 375 px)
tools/sync-danish-config.mjs        regenerates that copy; --check fails on drift
```

The backend owns those routes and is deployed **on its own** — Railway builds this
repository with `backend/` as the root directory, so the container only contains
`/app/src/…`. No file under `backend/` may therefore import anything above it
(an `../../../netlify/…` or `../../../js/…` specifier becomes `/netlify/…` in the
container and the process dies at startup with `ERR_MODULE_NOT_FOUND`). That is
why the library lives at `backend/src/lib/` and why the layer config is vendored
next to it as `danish-layers.config.cjs`:

```bash
node tools/sync-danish-config.mjs          # after editing js/danish-layers.config.js
node tools/sync-danish-config.mjs --check  # what the test suite runs
```

It is a `.cjs` file because `backend/package.json` is `"type": "module"`: a `.js`
copy there would be parsed as ESM and `require()` would return an empty object.
`test-danish-layers.js` enforces both rules — it scans every `backend/` source for
a relative `import`/`require` that resolves outside `backend/`, and it runs the
`--check` above, so neither the crash nor a stale mirror can come back unnoticed.

## The layers

| id | group | type | on by default | needs |
|---|---|---|---|---|
| `danish.dtk25` | base | WMS 1.3.0 | **yes** | `DATAFORSYNINGEN_TOKEN` |
| `danish.orto` | base | WMS 1.3.0 | no | `DATAFORDELER_USER` + `DATAFORDELER_PASSWORD` |
| `danish.osm` | base | XYZ | no | — (fallback base) |
| `danish.naturtyper` | overlay | WMS 1.3.0 (direct) | no | — |
| `danish.fortidsminder` | overlay | WFS 2.0.0 → GeoJSON | no | — |
| `danish.historic-witx` | base | XYZ | **disabled** | written permission from witx.dk |

Details, licences and attribution text: `DATA_SOURCES.md`.

## Environment variables

Set these on the deployment (Netlify / Express / local shell) — never in the
repository, never in the browser:

```bash
DATAFORSYNINGEN_TOKEN=…   # Dataforsyningen personal token → DTK25
DATAFORDELER_USER=…       # Datafordeler service user (tjenestebruger) → orthophoto
DATAFORDELER_PASSWORD=…
```

A missing variable is a first-class state, not a crash: the route answers
`501 {"error":"layer_not_configured","env":[…]}` naming what is missing, and the
row shows that name under its switch. Layer 1 also has a **local-preview-only**
path: export `DATAFORSYNINGEN_TOKEN` before
`node tools/map3d-dev-server.mjs`, and the dev server injects it into `index.html`
as `window.DETECTLAB_DK_TOKEN` so a workstation without the proxy can still see
DTK25. That token is never written to disk and no deployment serves it.

## Adding or changing a layer

Everything is data. Edit `js/danish-layers.config.js` — no map code changes:

```js
{
    id: 'orto2019',                       // stable id: pane/row/storage names
    title: { da: 'GeoDanmark Ortofoto 2019', en: 'GeoDanmark orthophoto 2019' },
    group: 'base',                        // 'base' (mutually exclusive) | 'overlay'
    type: 'wms',                          // 'wms' | 'xyz' | 'wfs'
    url: '/api/geo/dk-orto',              // what the browser calls
    upstream: 'https://services.datafordeler.dk/…/WMS',   // docs / direct fallback
    layers: 'geodanmark_2019_12_5cm',     // the LAYERS value (or typeName for WFS)
    crs: 'EPSG:3857', format: 'image/png', transparent: false,
    version: '1.3.0', tiled: true, tileSize: 256,
    minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
    attribution: 'Ortofoto © <a href="…">Klimadatastyrelsen</a> / GeoDanmark',
    opacity: 1, defaultOn: false, enabled: true,
    requiresCredentials: ['DATAFORDELER_USER', 'DATAFORDELER_PASSWORD'],
    provider: 'GeoDanmark / Klimadatastyrelsen, distributed by Datafordeleren',
    licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    sourcePage: 'https://dataforsyningen.dk/data/981',
    bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
    notes: '…', wfs: null, permission: { required: false, note: '' }
}
```

Then, in order:

1. `node test-danish-layers.js` — the suite reads the config and checks the row,
   the request format, the credential handling, the i18n strings and the
   `index.html`/`sw.js` wiring. It fails loudly if the config and the panel
   disagree.
2. `node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md` — rebuilds
   every layer's real request; it also insists that a third-party host is either
   guarded (`js/wms-health.js` `HOSTS`) or declares `guard: false` **with** a
   `selfGuardedReason`, so a new endpoint cannot silently go unmonitored.
3. `node test-wms-layer-audit.js`, `node test-wms-health.js`.
4. Bump the `?v=` tag of the changed files **and** of every test that pins them
   (`grep -rl '<tag>' .`), plus `sw.js`'s `CACHE_NAME` and precache list.
5. Update `DATA_SOURCES.md` (licence, attribution, credential, permission) and
   the checklist at its end.

Rules the config may not break: no secret ever appears in it; a `base` layer is
added to the `base` group only if the provider licence permits tiles; a layer
whose licence is unclear or non-commercial ships `enabled: false` with
`permission.required: true` and a note saying what is missing.

## Known limitations

* **Orthophoto needs a service user.** Datafordeler rejects every anonymous
  request (`Unauthorized access`), so `danish.orto` stays off until the
  credentials above are set. Everything else about the row works: it is visible,
  it explains itself, and it switches on as soon as the deployment can answer.
* **DTK25 is capped at zoom 17** (`maxNativeZoom`): beyond that Leaflet upscales
  the last real tile instead of asking the provider for tiles it does not have.
* **The heritage overlay starts at zoom 13** and shows at most 400 features per
  view (`maxFeatures`), debounced 450 ms after the map settles. That is
  deliberate: the register's terms forbid harvesting — we query per view, we do
  not copy the dataset.
* **DTK25 2023 only.** The service also publishes `dtk25` (latest) and 2002–2023
  vintages, and the orthophoto service publishes one layer per year plus a faster
  WMTS twin; all of them are *reported* in `DATA_SOURCES.md` and none is enabled,
  because only the six requested layers were added.
* **`danish.historic-witx` is disabled** and nothing in the site requests
  `witx.dk`: its licence is unknown and hotlinking needs the owner's written
  permission first.
* **The heritage WFS is proxied**, because its `fetch()` response needs CORS and
  the register's answers are large; the raster layers are not, since Leaflet
  draws WMS as an `<img>` and needs no CORS for that.
* **Mobile:** the group is one more accordion row in the existing panel; it was
  checked against the 375 px layout and every switch, slider and info button is
  reachable by keyboard (`Tab`, `Space`, arrow keys, `Escape` for the info
  panel).
