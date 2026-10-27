> UI update (2026-10-26): thematic sections now appear directly in the layer list, without a country master layer. All Albanian and Danish LiDAR rows live once under the existing shared LiDAR accordion. Country filtering and per-layer controls remain in place.

> UI update (2026-10-27): every free Denmark layer is now styled exactly like
> the other countries' rows (Romania's free rows are the template) — a glass
> sublayer row with the pill on/off switch (`.apm-toggle-switch`), an
> “Opacity” line with the ⓘ button and percentage badge, and its own opacity
> slider. The “Base map” section is gone: there are no Danish radio base maps
> any more. All rendered layers are independent overlays (the historical
> sheets, orthophoto years and DTK25 included; DTK25 now lives under
> Historical maps and is still the one layer on by default). The former base
> rows — the GeoDanmark spring-orthophoto year dropdown and the Danish OSM
> base — are no longer rendered; their catalogue entries remain for the
> proxy, the registry and the 3D catalogue, but stored preferences for them
> are never restored. The separate “Denmark · DHM hillshade (DHM/Terræn)”
> WMTS row is also removed from the LiDAR accordion: its terrain/surface
> products are the Danish WMS LiDAR rows below; the WMTS module stays loaded
> only as the 3D registry builder (`lidar.dk-dhm`).

## Free Denmark-only source groups (October 2026)

The Danish panel shows four collapsible groups, with no premium gate. Each
group header carries an expand chevron and a master on/off switch, and every
layer inside has its own switch and opacity slider:

- **LiDAR** (inside the shared LiDAR accordion, after the global “Hillshade
  LiDAR derivate” row): LiDAR hillshade 1.6 m (DHM historik); LiDAR
  hillshade, exaggerated terrain (quickDHM); LiDAR terrain hillshade (DHM);
  LiDAR surface hillshade (DHM).
- **Heritage**: Protected nature types (NBL § 3); Scheduled ancient monuments
  (areas); Not protected ancient monuments; Protected ancient monuments.
  The monument layers reuse the official Kulturarv public services (CC0), while
  the nature overlay comes from Danmarks Miljøportal.
- **Historical maps**: Topographic map 1980–2001; Topographic map 1953–1976;
  Low measuring table leaves 1901–1971; High measuring table leaves 1842–1899;
  Prussian measuring table leaves 1877–1920; Denmark · DTK25 topographic map
  (1:25,000).
- **Ortophoto**: 2008, 2005, 2002, 1999.

These groups inherit the Danish panel's country filter: selecting a country
other than Denmark hides them. All of them are overlays now, so any
combination can be stacked and each slider blends its sheet over the
basemap — the same rule as the Romanian free layers. Existing layer
IDs/preferences are preserved.

### Deployment

Set **DATAFORSYNINGEN_TOKEN** on the backend/Netlify deployment for both the
five historical maps and the summer orthophotos. Historical maps use the
original Dataforsyningen `_DAF` WMS endpoints; **no Datafordeler API key is
needed for these groups**. Free app access does not remove provider authentication.
The token stays server-side and is never sent to browsers. Missing credentials
produce the existing explicit unavailable status, not silent tiles.

The supplied “2002” request actually points at 2008. The catalogue retains its
separate `orto_sommer_2002` endpoint rather than mislabelling 2008 imagery.
Live availability of that endpoint (and the other upstream services) must be
checked in deployment; the sandbox cannot reach these provider hosts. WMS tiles
continue to use the existing EPSG:3857 / WMS 1.3.0 integration, rather than copying
a fixed EPSG:25832 viewport from a sample request.

---

# Denmark · Danish maps — how the layer group works

*(README section for the Danish work; the machine-checked catalogue lives in
`WMS_WMTS_LAYER_AUDIT.md`, the licences and credentials in `DATA_SOURCES.md`,
and the LiDAR/terrain companion in `DENMARK_LIDAR_DATAFORSYNINGEN.md`.)*

The Danish entries — topographic, orthophoto, LiDAR and heritage base maps and
overlays, plus the permission-gated witx placeholders — are described in
**`js/danish-layers.config.js`** and drawn by **`js/danish-layers.js`**. They
appear in the existing layer panel as one group,
*“Danmark · danske kort / Denmark · Danish maps”*, and the base maps also appear
as buttons in the existing basemap control. Nothing about the existing layers,
their controls, the projections or the default view changed.

```
index.html                          #danishRow … #danishSubLayers (one empty container)
js/danish-layers.config.js          the Danish layer catalogue — the only file to edit for a change
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
The proxy library imports it with a **static**
`import danishLayerConfig from './danish-layers.config.cjs'`. Do not replace that
with a runtime `createRequire(path.resolve(...))` lookup: Netlify could not trace
that lookup, omitted the config from the deployed Danish function bundles, and
made every LiDAR, historical-map and orthophoto request fail with
`MODULE_NOT_FOUND`. The static import works in both the Netlify and Railway
deployments.
`test-danish-layers.js` enforces both rules — it scans every `backend/` source for
a relative `import`/`require` that resolves outside `backend/`, and it runs the
`--check` above, so neither the crash nor a stale mirror can come back unnoticed.

## The layers

| id | group | type | on by default | needs |
|---|---|---|---|---|
| `danish.dtk25` | overlay (Historical maps) | WMS 1.3.0 | **yes** | `DATAFORSYNINGEN_TOKEN` |
| `danish.orto` | base (catalogue only, no panel row) | WMS 1.3.0 | no | `DATAFORDELER_USERNAME` + `DATAFORDELER_PASSWORD` |
| `danish.osm` | base (catalogue only, no panel row) | XYZ | no | — |
| `danish.naturtyper` | overlay | WMS 1.3.0 (direct) | no | — |
| `danish.fortidsminder` | overlay | WFS 2.0.0 → GeoJSON | no | — |
| `danish.fortidsminder_punkt_fredet` | overlay | WMS 1.3.0 (direct) | no | — |
| `danish.fortidsminder_punkt_ikkefredet` | overlay | WMS 1.3.0 (direct, z10+) | no | — |
| `danish.lidar_dhm_surface_hillshade` | overlay | WMS 1.3.0 | no | `DATAFORSYNINGEN_TOKEN` |
| `danish.historic-witx` | base | XYZ | **disabled** | written permission from witx.dk |
| `danish.witx_fundogfortidsminder_areal`, `danish.witx_fundogfortidsminder` | overlay | WFS | **disabled placeholders** | written permission from witx.dk |

The full list — historical maps, summer/spring orthophotos, the three other
LiDAR overlays — is in `DATA_SOURCES.md`, which is the licence and attribution
register.

## Provider access: the Dataforsyningen token

Everything the Danish group asks of
`api.dataforsyningen.dk` is authenticated with one credential, the personal
**token** in `DATAFORSYNINGEN_TOKEN`. Per Dataforsyningen's own *Log ind og Token*
page (<https://confluence.kds.dk/display/MYD/Log+ind+og+Token>):

* every request must be **HTTPS** (TLS ≥ 1.2); HTTP is not served, and a call
  with no token or a wrong token fails — the service keeps no session, so the
  token travels with **every** request;
* the token is created and rotated by the account owner on
  [dataforsyningen.dk](https://dataforsyningen.dk/user#token) (user icon →
  *Administrer token til webservices og API'er* → *Opret ny token*), where it can
  also be named and given an expiry date;
* it may be sent **either** as the `token` HTTP header (what the docs recommend,
  because a header stays out of access logs, browser history and `Referer`)
  **or** as the `token` query parameter (what Dataforsyningen's own KVP examples
  and this repo's proxy use; the KVP is what their WMS/WMTS documents show).

This repo never puts the token in a browser: `js/danish-layers.config.js` points
credentialed rows at the same-origin `/api/geo/…` routes, and
`backend/src/lib/danish-layers.mjs` adds the KVP server-side. A token is
account-wide, so exposing it client-side would hand the whole subscription to
every visitor.

Two things to check when copying request URLs out of a browser's Network tab:

1. **The token in the copied URL is not yours.** Example requests in docs,
   screenshots and other people's sites carry *their* token (and sometimes a
   `9854…` sample). Replace it — pasting it into this repository would leak a
   third party's credential and still fail if it was revoked.
2. **`wms.datafordeler.dk` uses a different credential from
   `api.dataforsyningen.dk`.** The Datafordeler WMS/WMTS answers to a service
   user (`username`/`password`, what `DATAFORDELER_USERNAME` /
   `DATAFORDELER_PASSWORD` are for) or to a Datafordeler **`apikey`** query
   parameter. An `apikey=` copied from a Network tab is not the Dataforsyningen
   token and cannot be swapped for it. This repo reaches the same historical
   products through `api.dataforsyningen.dk/…_DAF` with the token instead, so
   only one credential is needed for the Danish WMS group.

`js/dataforsyningen-dhm-layer.js` is the one piece that uses the header form: it
asks the same-origin `/api/geo/dk-dhm` route, which attaches `token` as a header
when it talks to the WMTS.

## Environment variables

Set these on the deployment (Netlify / Express / local shell) — never in the
repository or browser:

```bash
DATAFORSYNINGEN_TOKEN=…   # Dataforsyningen personal token → DTK25
DATAFORDELER_USERNAME=…   # Datafordeler service user (tjenestebruger) → orthophoto
DATAFORDELER_PASSWORD=…
```

A missing variable is a first-class state, not a crash: the route logs the
missing variable name server-side and returns a generic HTTP 503. The row shows
a generic configuration notice without variable names or secret values. For a
Netlify-to-Railway proxy, configure `DANISH_PROXY_ALLOWED_ORIGINS` with exact
frontend origins; do not use wildcards. The local preview uses the same
server-side proxy; no secret is injected into served HTML.

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
    opacity: 1, defaultOn: false, enabled: true, auth: 'token' | 'basic' | 'none',
    requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'],
    auth: 'basic',
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
