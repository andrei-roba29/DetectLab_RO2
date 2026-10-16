# DetectLab

DetectLab is a static HTML/JavaScript website with an existing Leaflet map and
serverless/Express proxy routes. This repository's map is extended in place;
there is no separate frontend build or client-side environment-variable
injection. The Danish WMS credentials are server-only.

## Danish LiDAR and historical layers

The Danish layer catalogue is `js/danish-layers.config.js`; the existing
`js/danish-layers.js` panel reads it, creates layers lazily, and uses the
existing radio/overlay controls. The config mirror used by the separately
rooted backend is generated with:

```sh
node tools/sync-danish-config.mjs
node tools/sync-danish-config.mjs --check
```

Set these as server environment variables (Netlify Functions or the Express
backend, depending on which service receives the routes), never in browser
JavaScript or committed files:

```sh
DATAFORSYNINGEN_TOKEN=your_own_token
DATAFORDELER_USERNAME=your_service_username
DATAFORDELER_PASSWORD=your_service_password
DANISH_PROXY_ALLOWED_ORIGINS=https://detectlab.ro,https://www.detectlab.ro,https://detectlab.eu,https://www.detectlab.eu
```

`DANISH_PROXY_ALLOWED_ORIGINS` is an exact comma-separated origin allowlist
for requests proxied from the frontend to Express. Add any deploy-preview origin
individually; wildcards are not accepted.

Dataforsyningen token-gated layers and Datafordeler spring orthophotos use
same-origin routes `/api/geo/dk-dtk25` and `/api/geo/dk-orto`. The routes add
credentials server-side and allow only configured layer IDs. Missing values
return a generic HTTP 503; the missing variable name is logged server-side only,
and the layer panel shows a generic configuration notice. Datafordeler access requires an approved service user for GeoDanmarkOrto;
a normal website login is not enough. `DATAFORDELER_USER` is accepted as a
legacy alias for `DATAFORDELER_USERNAME`.

The three LiDAR layers are overlays (opacity defaults to 100%, with individual
sliders); historical map sheets and orthophotos are mutually exclusive base
layers. Spring orthophoto years 2016–2025 are selected through a single year
dropdown. `bes_naturtyper` and OSM remain available. The witx.dk WFS/tiles are
disabled placeholders pending written permission.

### Add a layer

Add a typed-by-convention entry to `js/danish-layers.config.js` with `id`, DA/EN
titles, `group`, `type`, endpoint, `layers`, `crs`, `format`, zoom range,
attribution, opacity/default state, `enabled`, and `auth: 'token' | 'basic' | 'none'`.
For a credentialed WMS, use the existing fixed same-origin proxy route and set
`requiresCredentials`; the shared `appendLayerAuth()` helper chooses the
server-side parameters from `auth`. Never form credentials in client code.
Then regenerate the backend config and add the provider/licence/attribution to
`DATA_SOURCES.md`. Keep new layers lazy and add any year option to the existing
spring orthophoto selector group where appropriate.

### Limitations and verification

* No credentials are supplied in this checkout, so token/password-protected
  imagery cannot return successful tiles here. The layer rows explicitly say
  which environment variables are missing.
* Provider `GetCapabilities` endpoints could not be reached from the current
  sandbox network; layer-name matches and live rendering remain unverified.
  When online with credentials, run `node tools/verify-danish-capabilities.mjs`
  and test each LiDAR overlay at zoom 12–17 over Denmark. A real deployment
  verification must observe HTTP 200 `image/png` proxy responses and visible
  pixels; never mark a layer working based only on config or a stub test.
* For protected services the browser sees the same-origin proxy in its Network
  panel, intentionally. Credentials are not exposed for direct browser requests.
  The routes set seven-day cache headers; avoid bulk tile downloads and respect
  provider terms and rate limits.
* The public OSM tile server is suitable for development and modest interactive
  usage only; use a production tile provider that permits the site's traffic.
* Licences for newly added historic products are flagged as expected, not
  confirmed, until checked against authoritative provider product pages.

Automated checks include `node test-danish-layers.js`, `node test-danish-wms-layers.js`, and
`node tools/sync-danish-config.mjs --check`.
