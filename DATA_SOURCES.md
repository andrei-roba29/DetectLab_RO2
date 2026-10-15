# Data sources, licences and credentials

<!-- Danish layers added 2026-10-15. Keep this file in step with
     js/danish-layers.config.js: one row per layer, in the order the panel shows
     them. Never enable a layer whose licence reads “unclear” or “non-commercial”
     — flag it here first, ship it disabled, and say why in §Per-layer checklist. -->

Every raster/vector service the map draws is declared in `js/layer-registry.js`
and, for the Danish group, in `js/danish-layers.config.js`. This file answers,
for each source: **who owns it, what it is, which licence applies, what
attribution must be shown, and whether it needs a credential or a permission
before it may be enabled at all.**

The machine-readable check of the same catalogue is `WMS_WMTS_LAYER_AUDIT.md`
(`node tools/audit-wms-layers.mjs`, 75 layers, 0 errors): it rebuilds each
layer's real GetMap/GetTile URL against the service's documented contract.

## Credentials — environment variables only

No secret is ever written into `js/`, `index.html` or any file that is served to
a browser. The credentialed Danish layers go through same-origin routes
(`/api/geo/dk-*`, implemented in `backend/src/lib/danish-layers.mjs`, mirrored by
`netlify/functions/*.mjs` and `backend/src/routes/geoProxy.js`), which add the
secret **server-side** and strip any credential the caller tried to send.

| variable | used by | what it is | where to get it |
|---|---|---|---|
| `DATAFORSYNINGEN_TOKEN` | 1 · DTK25 (`/api/geo/dk-dtk25`) | a personal Dataforsyningen token, sent to the provider as the `token` **header** (never in a URL, never logged) | [dataforsyningen.dk](https://dataforsyningen.dk/) → *Min profil* → token |
| `DATAFORDELER_USER` + `DATAFORDELER_PASSWORD` | 2 · GeoDanmark ortho (`/api/geo/dk-orto`) | a **service user** (tjenestebruger) on Datafordeleren — a normal web login cannot read the WMS | [selfservice.datafordeler.dk](https://selfservice.datafordeler.dk/) → create a service user for *GeoDanmarkOrto* |

Both are documented in `backend/.env.example` (search for *Denmark*). A missing
variable is not an error the visitor sees as a blank map: the route answers
**501 `layer_not_configured`** naming the variable, and the row writes that name
under the switch. For layer 1 only, a workstation with no backend can export
`DATAFORSYNINGEN_TOKEN` for
`node tools/map3d-dev-server.mjs`, which injects it as
`window.DETECTLAB_DK_TOKEN` — a documented, **local-preview-only** fallback; no
deployment ever serves it.

Requests to the token-guarded service go through our own origin, so the provider
sees one origin, and the responses are cacheable (`public, max-age=604800,
immutable` for tiles, `max-age=300`/`s-maxage=3600` for the heritage query), so
repeated panning costs the providers nothing new.

## The Danish layers (Denmark · Danish maps)

| # | id | what it is | provider endpoint | LAYERS | licence | attribution as shown | credential / permission |
|---|---|---|---|---|---|---|---|
| 1 | `danish.dtk25` | **Base** — DTK25 / Kort25 topographic map, 1:25,000 (508 dpi) | `api.dataforsyningen.dk/dtk_25_DAF` (`/api/geo/dk-dtk25`) | `dtk25_2023` | **CC BY 4.0** | `Kort25 / DTK25 © Klimadatastyrelsen` | `DATAFORSYNINGEN_TOKEN` — token required by the provider; yes |
| 2 | `danish.orto` | **Base** — GeoDanmark Ortofoto, spring imagery, 12.5 cm | `services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS` (`/api/geo/dk-orto`) | `geodanmark_2025_12_5cm` | **CC BY 4.0** | `Ortofoto © Klimadatastyrelsen / GeoDanmark` | `DATAFORDELER_USER` + `DATAFORDELER_PASSWORD` (service user); yes |
| 3 | `danish.naturtyper` | **Overlay** — protected nature types (2013), polygons | `arealeditering-dist-geo.miljoeportal.dk/geoserver/wms` — called **directly** | `dai:bes_naturtyper` | **CC0 1.0** | `Beskyttede naturtyper © Danmarks Miljøportal` | none |
| 4 | `danish.osm` | **Base** — OpenStreetMap standard tiles | `tile.openstreetmap.org/{z}/{x}/{y}.png` | — (XYZ) | **ODbL 1.0** (data) / tile usage policy | `© OpenStreetMap contributors` | none; **tile usage policy applies** |
| 5 | `danish.historic-witx` | **Base** — historic tiles, third party | `witx.dk/tiles/videnskaberne/{z}/{x}/{y}.png` | — (XYZ) | **Unknown — no permission on file** | not shown (never enabled) | **written permission required** — layer ships `enabled: false` |
| 6 | `danish.fortidsminder` | **Overlay** — protected ancient monuments & finds (`Fund og Fortidsminder`), GeoJSON | `kulturarv.dk/ffgeoserver/public/wfs` (`/api/geo/dk-heritage`) | `public:fundogfortidsminder_areal_fredet` | **CC0 1.0** | `Fund og Fortidsminder © Slots- og Kulturstyrelsen (CC0)` | none |

### 1 · DTK25 topographic (`danish.dtk25`) — base, **on by default**

* Provider: **Klimadatastyrelsen** (Danish Agency for Climate Data), via
  Dataforsyningen. Source page:
  <https://dataforsyningen.dk/data/956>.
* Licence: CC BY 4.0, “Data stilles frit til rådighed … reguleres af CC BY 4.0
  licensen”. Attribution must name the agency — the config does.
* Request: WMS **1.3.0**, `CRS=EPSG:3857` (advertised; the service also offers
  25832/32632/25833/32633/4093–4096/4326/4258/3395), `FORMAT=image/png`,
  256×256, `TILED=TRUE` for the tiled case. `transparent: false` — it is a base.
* **Reported from GetCapabilities, not added**: the same service publishes
  `dtk25` (latest) plus yearly layers `dtk25_2002 … dtk25_2023`. Adding a year is
  a one-field change (`layers`) in `js/danish-layers.config.js`; the brief asked
  for 2023 only, so nothing else was enabled.
* Zoom: capped at `maxNativeZoom: 17`; above that Leaflet upscales instead of
  hammering the provider for tiles it does not have.

### 2 · GeoDanmark Ortofoto, spring (`danish.orto`) — base, off by default

* Provider: **GeoDanmark / Klimadatastyrelsen**, distributed by
  **Datafordeleren**. Source page: <https://dataforsyningen.dk/data/981>.
* Licence: CC BY 4.0.
* Request: WMS 1.3.0, `CRS=EPSG:3857`, PNG, 256×256, opaque.
* Verified 2026-10-15: `…/orto_foraar/1.0.0/WMS?…GetCapabilities` answers
  `ServiceExceptionReport: Unauthorized access` without a **service user** —
  Datafordeler rejects every anonymous request, so this layer *cannot* be
  switched on until `DATAFORDELER_USER`/`DATAFORDELER_PASSWORD` are set. The row
  stays visible and says exactly that instead of failing silently.
* **Reported, not added**: layers `geodanmark_<year>_10cm` / `_12_5cm` per year
  (2012 → 2025) in the same service, and a faster WMTS twin
  (`orto_foraar_webm_DAF`, Web Mercator, ~10× faster than WMS) documented by the
  provider. Switching year or moving to the WMTS twin is a config edit; neither
  was requested, so neither was enabled.

### 3 · Protected nature types (`danish.naturtyper`) — overlay, off by default

* Provider: **Danmarks Miljøportal** (the municipalities + Miljøstyrelsen)
  GeoServer, “2013 Beskyttede naturtyper”.
* Licence: **CC0 1.0** — confirmed on the same dataset published at
  <https://arealdata.miljoeportal.dk/datasets/dai-edit20> (“Licens: Creative
  Common – CC0 1.0”).
* Request: WMS 1.3.0, `CRS=EPSG:3857`, `FORMAT=image/png`,
  `TRANSPARENT=TRUE`, 256×256, layer `dai:bes_naturtyper`.
* Two traps, both checked against the live service on 2026-10-15:
  1. Its `GetCapabilities` advertises **only** `EPSG:25832` / `CRS:84`, yet a
     `GetMap` in `EPSG:3857` returns a correct transparent 256×256 RGBA tile —
     never judge this service by its capabilities.
  2. Leaflet 1.1.1 sends lowercase KVP by default (`uppercase: false`); the
     uppercase 1.3.0 form (`SERVICE/VERSION/REQUEST/LAYERS/CRS/BBOX`) is what
     was verified working, so the module asks for that everywhere.
* Because it is tokenless, public, and Leaflet draws WMS as an `<img>` (no CORS
  needed), the browser calls the agency **directly** — no proxy, no credential,
  no origin trick. Default opacity 75 % so the basemap stays readable.

### 4 · OpenStreetMap (`danish.osm`) — base, off by default

* Tiles: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `maxNativeZoom: 19`.
* Licence: data © **OpenStreetMap contributors**, ODbL 1.0; the tile service is
  run by the OSM Foundation under the
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
* That policy is why this is only a *fallback* base inside the Danish group: it
  requires a valid `Referer`/User-Agent, no bulk downloading, no heavy automated
  use, and caching. We send normal browser requests, use plain XYZ with no
  prefetch, and stop asking beyond zoom 19. The attribution control shows
  `© OpenStreetMap contributors` whenever the layer is on.
* This is also the base the group falls back to when DTK25 is unconfigured
  (no token), so Denmark is never left without a working base map.

### 5 · WITX historical tiles (`danish.historic-witx`) — **disabled placeholder**

* Endpoint as supplied in the brief:
  `https://witx.dk/tiles/videnskaberne/{z}/{x}/{y}.png` (third party, unrelated
  to the Danish public sector services above).
* Licence: **unknown / not documented** — no terms of use, no open licence
  found, no permission on file. Per the brief, a third party must not be
  hotlinked without the owner's written confirmation.
* Therefore: `enabled: false`, `permission.required: true`, and the entry carries
  the note “Written permission from witx.dk required before enabling.” It is
  kept in the config as a placeholder so the row's metadata (URL, zooms,
  attribution slot) is ready once permission exists. **Nothing in the shipped
  site requests this host.** For historic Danish maps, the config notes the
  Royal Library's map collection as an official alternative to check first.
* Also disabled for the same reason: the `geoserver.witx.dk` WFS mirror the
  brief mentioned (`witx:FundOgFortidsminderAreal`) — see the next row for the
  official upstream that replaced it.

### 6 · Fund og Fortidsminder (`danish.fortidsminder`) — overlay, off by default

* Provider: **Slots- og Kulturstyrelsen** (Danish Agency for Culture and
  Palaces), the official `Fund og Fortidsminder` register — **not** the witx
  mirror. Developer page:
  <https://slks.dk/omraader/kulturarv/databaserne/til-udviklere/webservices>.
* Endpoint: `https://www.kulturarv.dk/ffgeoserver/public/wfs`, type
  `public:fundogfortidsminder_areal_fredet` (the protected sites polygons).
* Licence: **CC0 1.0** — “Tekstuelle data i databaserne stilles til rådighed af
  Slots- og Kulturstyrelsen under Creative Commons' CC0 betingelser”
  (<https://slks.dk/omraader/kulturarv/databaserne/rettigheder-til-data>), and
  the same dataset is listed as CC0 in Arealdata. Images and documents in the
  database are CC BY-NC-ND — **no image or document is fetched here**, only
  geometry and text attributes.
* Terms that shape the implementation
  (<https://www.kulturarv.dk/fundogfortidsminder/Regler>): *harvesting of the
  site's content is not permitted*, while *deep links are*. We therefore
  **query, never harvest**: one bbox `GetFeature` per settled view, debounced
  450 ms after `moveend`/`zoomend`, capped at `maxFeatures: 400`, only above
  zoom 13, with an `AbortController` cancelling superseded requests; the popup
  links to the register's own page for the monument (`url` field) instead of
  copying its content.
* Request: WFS 2.0.0, `bbox=<w,s,e,n>,EPSG:4326`, `outputFormat=application/json`.
  Verified 2026-10-15: a small Aarhus bbox returns `totalFeatures: 14`
  (`anlaegstype: "Rundhøj"`, `frednr: "300914"`); a 25832 bbox over Jutland
  returns 2950. Our proxy asks upstream in **EPSG:25832** — the register's native
  CRS — and reprojects to EPSG:4326, which is why the response is ordinary
  GeoJSON for Leaflet.
* Styling: amber outline `#ffd166` / semi-transparent fill `#ffb703` at 0.28,
  readable over both the topographic and the orthophoto base.
* **Reported, not added**: the same service publishes `areal_beskyttelse`
  (protection zones), `areal_ka` (heritage areas), `areal_adm`, `punkt_fredet`
  and `linie_alle`. The brief asked for the area layer only.

## Guard, caching and politeness

* **Availability guard opt-out.** These rows are driven by `js/danish-layers.js`,
  which owns their switch, probes the same-origin route once, prints a status
  line and falls back to a public base when a credential is missing. Building the
  WMS layers through `new L.TileLayer.WMS(...)` (not the `L.tileLayer.wms`
  factory that `js/wms-health.js` wraps) plus a `_detectlabNoGuard` marker keeps
  the guard from flipping a basemap switch behind the visitor's back. The
  registry entries say so explicitly (`guard: false`, `selfGuardedReason`), and
  the audit prints that as `GUARD_SELF`. The one public third-party host
  (`arealeditering-dist-geo.miljoeportal.dk`) is still listed in the guard's
  `HOSTS` map so a widespread outage can be *named*, and it has an entry in the
  audit's `SIGNATURES` describing what a broken answer looks like.
* **Caching.** Proxy responses are cacheable (one week, immutable, for tiles;
  5 minutes for the heritage query) so panning around Aarhus does not translate
  into repeated upstream traffic.
* **Lazy loading.** No Danish tile or WFS request is issued while a layer is off
  — the module builds a layer only when it is switched on (`activate`), and the
  heritage query only runs while its overlay is on and the zoom gate is met.
* **No scraping.** Nothing here downloads whole datasets, walks tile pyramids, or
  reads credentials from other sites' traffic. Third-party services are queried
  per view at human speeds.

## Per-layer checklist (final)

| # | layer | status | why / what is left |
|---|---|---|---|
| 1 | DTK25 (base) | ✅ **working** | Public endpoint verified (token authenticates, PNG returned); needs `DATAFORSYNINGEN_TOKEN` in the deployment. Without it the row explains itself and OSM takes over. |
| 2 | GeoDanmark Ortofoto (base) | ⛔ **blocked — needs the user's credentials** | Datafordeler answers `Unauthorized access` to every anonymous request; cannot be verified or enabled until `DATAFORDELER_USER`/`DATAFORDELER_PASSWORD` are set. Code path is complete and covered by tests against a stubbed upstream. |
| 3 | Protected nature types (overlay) | ✅ **working** | CC0, tokenless, verified live in EPSG:3857 with the uppercase KVP form. |
| 4 | OpenStreetMap (base) | ✅ **working** | Public tiles; used as the fallback base and kept inside the tile-usage policy. |
| 5 | WITX historic tiles (base) | ⏸ **disabled placeholder** | Licence unknown, no written permission — must not be hotlinked. Ships `enabled: false`; nothing requests `witx.dk`. |
| 6 | Fund og Fortidsminder (overlay) | ✅ **working** | Official SLKS upstream (replaces the unrunnable witx mirror), CC0, verified live; queried per view, capped, debounced, zoom ≥ 13. |

**One layer is on by default** — the DTK25 topographic base — and every other
Danish entry is off until the visitor switches it on. Existing layers and the
default view are untouched: the extra layers append to the country catalogue as
`danish.*` and appear in their own “Denmark · Danish maps” group in the existing
layer panel, with the three bases also offered as buttons in the existing
basemap control.
