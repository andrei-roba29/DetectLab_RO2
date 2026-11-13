# DetectLab Cloudflare Pages migration (parallel, non-destructive)

This is an additive Pages Functions implementation. It does not deploy anything, change DNS, change Netlify settings, or replace the existing Netlify host.

## Architecture

- Cloudflare Pages serves the static site from the repository root (`index.html`, `css/`, `js/`, `images/`, `data/`, `src/`, `manifest.json`, and the existing PWA/service-worker resources).
- The nine same-origin `/api/...` endpoints are Pages Functions using filesystem routing under `functions/api/`.
- `_routes.json` limits Function invocation to `/api/*` plus the two Google callback paths; other static paths bypass Functions.
- Shared Corona catalogue code remains in `netlify/lib/corona-catalog.mjs`; there is no duplicated catalog business logic.
- Danish, Finnish and Albanian Pages handlers use Cloudflare-specific helper copies under `functions/_shared/`; the original backend helper files remain byte-for-byte identical to `HEAD` and Node/Netlify behavior is unchanged.
- `functions/_shared/map3d-tile.mjs` is a Workers-Web-API port. It imports the shared browser registry, uses `Uint8Array` and Web APIs, and does not enable Node compatibility.
- The Express backend remains a separate service and is not migrated here.

## Files added

- `functions/package.json`
- `functions/_shared/http.js`
- `functions/_shared/map3d-tile.mjs`
- `functions/api/corona/rasters.js`
- `functions/api/geo/asig-heritage.js`
- `functions/api/geo/dk-dhm.js`
- `functions/api/geo/dk-dtk25.js`
- `functions/api/geo/dk-heritage.js`
- `functions/api/geo/dk-orto.js`
- `functions/api/geo/finland.js`
- `functions/api/geo/se-hojdmodell.js`
- `functions/api/map3d/tile.js`
- `_routes.json`, `_headers`, `wrangler.jsonc`
- `functions/_shared/asig-heritage.mjs`, `functions/_shared/danish-layers.mjs`, `functions/_shared/finland-geo.mjs` (Cloudflare-only helper copies)
- `functions/_shared/map3d-country-urls.mjs` (Workers-compatible URL builders, differentially tested against the Netlify VM)
- `functions/_shared/corona-snapshot.mjs` (retained legacy helper; the Pages build now uses the shared `tools/build-corona-europe-catalog.mjs` generator instead)
- `functions/_shared/google-auth-callback.js`, `functions/google-auth-callback.html.js`, `functions/google-auth-callback.js`
- `test/cloudflare-functions.test.mjs`
- This document.

## Existing files intentionally preserved

- `netlify/`, all nine original Netlify Functions, and `netlify/lib/` remain in place and unmodified.
- `netlify.toml` and all its redirects, build settings and headers remain unchanged.
- Existing frontend files, API URLs, PWA files, Supabase/Stripe integration, and backend application behavior are not intentionally changed.
- The three backend helpers (`backend/src/lib/asig-heritage.mjs`, `danish-layers.mjs`, `finland-geo.mjs`) are restored exactly to `HEAD`. Cloudflare-only compatibility changes live in `functions/_shared/` and Pages handlers import those copies.

## Route mapping and implementation status

| API path | Pages Function | Status |
| --- | --- | --- |
| `/api/corona/rasters` | `functions/api/corona/rasters.js` | Implemented; shared catalogue transformation, warm-isolate cache, CORS, and static snapshot fallback. Fallback depends on the JSON snapshot being present in the deployed assets. |
| `/api/geo/se-hojdmodell` | `functions/api/geo/se-hojdmodell.js` | Implemented; fixed upstream hostname, allow-listed WMS layers/formats/size, server-only auth, binary response and seven-day cache headers. |
| `/api/map3d/tile` | `functions/api/map3d/tile.js` | Registry layers plus all eight module-backed country LiDAR builders; exact builder URL parity, binary pass-through, internal Danish/Swedish auth routing, caching, allow-list and explicit error responses are regression-tested. Live provider imagery and Cloudflare edge caching still need a permitted preview check. |
| `/api/geo/dk-dhm` | `functions/api/geo/dk-dhm.js` | Implemented; fixed upstream table, WMTS validation, server-only token and binary response. |
| `/api/geo/dk-dtk25` | `functions/api/geo/dk-dtk25.js` | Implemented by reusing the shared Danish handler; explicit Cloudflare env binding. |
| `/api/geo/dk-orto` | `functions/api/geo/dk-orto.js` | Implemented by reusing the shared Danish handler; explicit Cloudflare env bindings. |
| `/api/geo/dk-heritage` | `functions/api/geo/dk-heritage.js` | Implemented by reusing the shared Danish handler; GeoJSON reprojection retained. |
| `/api/geo/finland` | `functions/api/geo/finland.js` | Implemented by reusing the shared Finnish handler; allow-listed sources and optional MML key retained. |
| `/api/geo/asig-heritage` | `functions/api/geo/asig-heritage.js` | Implemented by reusing shared bounded WFS handler and GeoJSON conversion. |

“Implemented” means local validation passed for route handling and relevant code paths. It does not mean the functions have been deployed or verified against live provider services from Cloudflare.

## Runtime compatibility findings

- The Netlify wrapper convention (`default` handler and `process.env`) is not used by Pages code; each Pages file exports `onRequest` and reads secrets from `context.env`.
- All Cloudflare handlers use Fetch API `Request`, `Response`, `Headers`, `URL`, `fetch`, `TextDecoder`, `Uint8Array`, and `atob`/`btoa`. No `nodejs_compat` flag is configured.
- Backend source helpers remain unchanged; Workers-specific edits and backend config reuse are isolated in `functions/_shared/`. The post-isolation Wrangler compile and local Pages preview are the compatibility checks for those copies.
- Netlify's `netlify/lib/map3d-country-modules.mjs` evaluates the real browser modules in a Node VM and `registry.tileUrlAt()` calls their own URL builders per MapLibre tile. Workers cannot run that VM or read the repository at request time, so `functions/_shared/map3d-country-urls.mjs` contains narrowly scoped Cloudflare adapters for the same eight fixed registry IDs. `test/map3d-adapters.test.mjs` differentially compares every advertised mode at three z/x/y positions against Netlify's original VM output; all generated URL strings match byte-for-byte.

| Registry ID | Original browser builder | Cloudflare path | Validation and caveat |
| --- | --- | --- | --- |
| `lidar.nl-ahn` | `js/ahn-layer.js` → `AhnLidar.exportImageUrl` (EPSG:3857 bbox) | Adapter builds the identical ArcGIS ImageServer `exportImage` URL, including 6-decimal bbox, renderer JSON, 256×256 PNG32; public fetch forwards bytes. | URL parity all six modes. Mocked 256×256 PNG pass-through. No live provider image comparison. |
| `lidar.no-hoydedata` | `js/hoydedata-layer.js` → `Hoydedata.exportImageUrl` (EPSG:3857 bbox) | Identical ArcGIS export URL, renderer and dimensions; public fetch forwards bytes. | URL parity for DTM/DSM/LRM. Mocked binary pass-through; no live image comparison. |
| `lidar.pl-nmt` | `js/geoportal-nmt-layer.js` → `GeoportalNMT.tileUrl` (WMS 1.3.0 bbox, EPSG:3857) | Identical WMS version, CRS, axis handling, per-mode service path, bbox rounding and image dimensions. | URL parity for shading/hypsometry. Mocked binary pass-through; no live provider status/image check. |
| `lidar.es-mdt` | `js/ign-mdt-layer.js` → `IgnMdt.tileUrl` (WMS 1.1.1 bbox, EPSG:3857) | Identical SRS, layer/style, WMS hints, bbox rounding and 256×256 PNG request. | URL parity for its mode. Mocked binary pass-through; no live provider comparison. |
| `lidar.ch-swisstopo` | `js/swisstopo-relief-layer.js` → `SwisstopoRelief.tileUrl` (XYZ WMTS path) | Identical REST WMTS path, matrix, product and extension. | URL parity for all four products. Mocked binary pass-through; no live tile status/image check. |
| `lidar.uk-ea` | `js/ea-lidar-wmts-layer.js` → `EaLidarWmts.tileUrl` (WebMercatorQuad XYZ KVP) | Identical service, WMTS KVP order, mode layer/style, matrix and encoded format. | URL parity for all four products. Mocked binary pass-through; no live tile status/image check. |
| `lidar.dk-dhm` | `js/dataforsyningen-dhm-layer.js` → `DataforsyningenDHM.tileUrl` (View1 WMTS) | Identical same-origin builder URL is dispatched internally to the fixed `/api/geo/dk-dhm` Pages handler; the token is attached only in its upstream header. | URL/query parity for both products; tests cover server-side token, JPEG bytes and seven-day cache. Important: the 2D layer's Canvas/View1 mosaic is not recreated in the Map3D server adapter. Map3D follows the existing Netlify `tileUrl(level=z,col=x,row=y)` path; no live visual alignment was possible here. |
| `lidar.se-lantmateriet` | `js/lantmateriet-hojdmodell-layer.js` → `LantmaterietHojdmodell.tileUrl` (WMS 1.1.1 bbox) | Identical same-origin builder URL is dispatched internally to `/api/geo/se-hojdmodell`; its fixed upstream host, WMS allow-list and bearer/Basic credentials stay server-side. | URL/query parity for all four layers; mocked PNG, auth-header, no-credential-echo and cache checks pass. No live service image comparison. |

For all eight layers, invalid/unregistered IDs and invalid coordinates are rejected; public upstream errors now return explicit `502` JSON with `Cache-Control: no-store`, never a transparent substitute. Successful public tiles pass through unmodified bytes with browser and Cloudflare CDN cache headers; the Danish/Swedish internal routes retain their seven-day cache policy. The fixtures verify 256×256 image headers and exact byte pass-through, but actual provider status codes, content types and tile images remain unverified because this sandbox cannot reach those hosts. Netlify's map3D implementation remains untouched. The Cloudflare adapter is limited to the registry allow-list and does not add an arbitrary proxy.

## Corona static catalogue and runtime fallback

The confirmed deployment issue is that `data/corona-europe-catalog.json` is absent from the current Git tree, so `/data/corona-europe-catalog.json` can fall through to the Pages SPA HTML. Per the deploy operator's live check, `/api/corona/rasters` returns valid JSON from CAST (95 passes, 742 frames); this implementation deliberately leaves that Pages Function and its route unchanged.

The frontend loader in `js/corona-wms-layer.js` now tries the static JSON first, then `/api/corona/rasters`, then the optional explicit `CORONA_CATALOG_URL`. It checks HTTP success, rejects HTML, parses JSON and validates non-empty passes/frames, geographic extents, metadata, and counters before normalization. Concurrent loads share one promise. If all sources fail or are invalid, the existing six verified local fallback passes still let the rest of the map run, and a non-blocking accessible notice explains that Corona coverage is limited.

The existing `tools/build-corona-europe-catalog.mjs` is the build generator for both hosts. It has no npm dependencies and uses the existing shared catalogue transformation. It now validates the shaped Europe payload and serialized output, writes a same-directory temporary file and atomically renames only after successful validation. CAST/network/JSON/empty-catalogue failure leaves any previous file byte-for-byte untouched; if no prior file exists, it logs a warning and exits successfully without creating one, so the Pages static build can complete and the frontend uses the API. A write/rename filesystem error remains a build error. The generated path is `data/corona-europe-catalog.json`, inside the configured Pages publish root (`.`).

Service worker handling is explicitly network-first for both Corona URLs. Only structurally valid pass/frame JSON is stored; HTML SPA fallbacks, invalid/empty JSON and error responses are never added to Cache Storage. The shell-cache version bump migrates only validated Corona responses from the prior cache before cleanup. On network failure, a previously validated static/API response remains available to the PWA offline. No endpoint URL, raster style, geometry, projection, or Cloudflare API Function was changed for this fix.

## Environment variables for Cloudflare

Configure these in **Workers & Pages → the Pages project → Settings → Variables and Secrets**. Secrets should use Cloudflare's encrypted **Secret** type; non-credential settings should be ordinary **Text** variables.

| Variable | Function(s) | Required? | Cloudflare type |
| --- | --- | --- | --- |
| `DATAFORSYNINGEN_TOKEN` | `dk-dhm`, `dk-dtk25` | Required for those protected services; without it they fail closed. | Secret |
| `DATAFORDELER_USERNAME` | `dk-orto` | Required together with password. `DATAFORDELER_USER` is a legacy alias. | Secret |
| `DATAFORDELER_PASSWORD` | `dk-orto` | Required together with username. | Secret |
| `DATAFORDELER_USER` | `dk-orto` | Optional legacy username alias if `DATAFORDELER_USERNAME` is absent. Prefer the canonical variable. | Secret |
| `LANTMATERIET_WMS_TOKEN` | `se-hojdmodell` | One auth option; takes precedence over Basic credentials. | Secret |
| `LANTMATERIET_WMS_USER` | `se-hojdmodell` | Required only when using Basic auth (with password). | Secret |
| `LANTMATERIET_WMS_PASSWORD` | `se-hojdmodell` | Required only when using Basic auth (with username). | Secret |
| `LANTMATERIET_WMS_URL` | `se-hojdmodell` | Optional upstream override. Implementation rejects anything except HTTPS `maps.lantmateriet.se`. | Text (not a credential) |
| `MML_API_KEY` | `finland` | Optional; needed only for `src=mml-hillshade-open`. | Secret |
| `DANISH_PROXY_ALLOWED_ORIGINS` | `dk-dtk25`, `dk-orto` | Optional comma-separated extra origins; same-origin/no-Origin requests work without it. | Text |
| `FINLAND_PROXY_ALLOWED_ORIGINS` | `finland` | Optional comma-separated extra origins; same-origin/no-Origin requests work without it. | Text |

No credential values are included in repository files or this document. There are no environment variables for `asig-heritage`, `corona-rasters`, `map3d-tile`, or `dk-heritage`.

## Pages build and output settings

Set these under the Pages project's build settings (repository root as the project root):

- **Framework preset:** None
- **Root directory:** `/` (repository root)
- **Build command:** `node tools/build-corona-europe-catalog.mjs`
- **Build output directory:** `.`
- **Node.js version:** 22 (set Pages build environment variable `NODE_VERSION=22`; the generator checks for Node.js 18+ at runtime)
- **Functions directory:** `functions/` (default Pages convention)
- **Compatibility date:** `2026-11-12`
- **Node compatibility flag:** none

`wrangler.jsonc` records the Pages output directory and compatibility date for local Wrangler use. The actual Pages project slug could not be confirmed in the Cloudflare Dashboard (no Dashboard connector is available, and deployed-host checks were inconclusive). The current config name `detectlab-pages` is not treated as confirmation of the project slug; neither config nor project name has been aligned based on a guess.

The same generator is used by Netlify, but only its implementation was hardened; `netlify.toml`, `netlify/functions/`, and `netlify/lib/` are unchanged. In Cloudflare Pages, the Git-connected project must have the build command above configured in its Pages build settings and `NODE_VERSION=22` set as a build environment variable; these dashboard settings cannot be changed from this repository.

## Redirects and headers

- Both `/google-auth-callback.html` and `/google-auth-callback` are routed through a narrow Pages Function that applies `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow`; `_headers` retains the `.html` static rule and generic `X-Content-Type-Options: nosniff`. Wrangler Pages still performs its `.html` → extensionless 308 clean-URL redirect, but both redirect and final responses carry the required headers. The service worker bypasses both paths; the local preview confirmed the redirect and headers.
- Cloudflare Pages `_redirects` is path-based and is not a reliable host-conditional equivalent for Netlify's absolute-host rules. Since we must not alter production DNS/hosting now, configure these as two **manual Cloudflare Single Redirect Rules** after confirming the correct zone/project:
  1. Expression: `http.host eq "www.detectlab.ro"`; target: `concat("https://detectlab.ro", http.request.uri.path)`; status 301; preserve query string.
  2. Expression: `http.host eq "www.detectlab.eu"`; target: `concat("https://detectlab.eu", http.request.uri.path)`; status 301; preserve query string.
- Attach both apex domains and their `www` hostnames to the Pages project only when ready. Do not point one country domain at the other; there is no cross-country redirect rule here.

These dashboard rules are intentionally **not** created or enabled by this repository change.

## Local validation and deployment

Run the migration-focused local tests from the repository root:

```sh
node --test test/corona-catalog-fallback.test.mjs test/cloudflare-functions.test.mjs
node test-sat60-layers.js
node test-corona-europe.js
```

Also run each country's existing module regression test before changing an adapter. Backend tests remain separate (`npm --prefix backend test`); backend implementation is outside this migration.

Run the snapshot generator from the repository root (a local CAST failure is non-fatal and never overwrites the prior snapshot):

```sh
node tools/build-corona-europe-catalog.mjs
```

The generator writes only a validated non-empty catalogue, atomically. It uses Node's built-in fetch and has no package dependencies.

Optional local Pages preview (requires Wrangler; it may be invoked with `npx` without adding a project dependency):

```sh
npx wrangler pages dev . --port 8788 --compatibility-date=2026-11-12
```

Local secrets can be put in an ignored `.dev.vars` file (never commit it). Example variable names only:

```dotenv
DATAFORSYNINGEN_TOKEN=...
DATAFORDELER_USERNAME=...
DATAFORDELER_PASSWORD=...
LANTMATERIET_WMS_TOKEN=...
MML_API_KEY=...
```

Do not deploy as part of this preparation. No deployment command is provided here because the Pages project slug is unconfirmed. Do not deploy until the project slug, build artifact, secrets, domains, and dashboard redirect plan are confirmed. No preview or production deployment has been attempted.

### Test coverage in this repository

`test/corona-catalog-fallback.test.mjs` covers static-valid, 404, HTML, malformed/incomplete JSON, API fallback, offline cache behavior, controlled dual-source failure, build validation, atomic writes, and last-good preservation using mocks/temp directories. `test/cloudflare-functions.test.mjs` covers all nine API routes plus both callback routes, auth/cache boundaries, and all eight Map3D layers. `test/map3d-adapters.test.mjs` differentially checks each module builder's URLs against Netlify's original Node VM. The provider response tests use synthetic 256×256 PNG/JPEG bytes and mocked fetches; live external imagery/status and Cloudflare's edge cache are not verified here.

## Manual Cloudflare Dashboard checklist

- [ ] Confirm whether the target is the existing Pages project and verify its exact project slug (`detectlab-4i1` is inferred from the `pages.dev` hostname, not confirmed via dashboard access).
- [ ] Connect the repository/branch to Pages; root directory `/`, preset None, build command and output directory as above.
- [ ] Confirm deployment output includes a valid `data/corona-europe-catalog.json`; arrange a successful refresh or an already validated build artifact before relying on offline Corona fallback. Never supply an empty or fabricated snapshot.
- [ ] Add the secrets/text variables listed above only if the corresponding map providers are licensed/configured for Cloudflare use.
- [ ] Add Pages custom domains for `detectlab.ro`, `detectlab.eu`, and their `www` variants only when approved.
- [ ] Create the two separate www-to-apex Redirect Rules; preserve path/query and never cross-redirect country domains.
- [ ] Validate all nine endpoints on a Pages preview, including actual provider responses, CORS, cache status, credentials, OAuth callback headers, PWA install/offline behavior, and Supabase/Stripe flows.
- [ ] Verify live imagery and visual behavior for all eight Map3D country layers on an authorized Cloudflare preview; mocked pass-through and exact URL parity are not live visual proof.
- [ ] Confirm no required APIs are provided only by the separate Express backend; if needed, configure its origin as a separately secured service rather than migrating it here.

## Rollback to Netlify

No production switch is part of this change. If a Pages preview is incorrect, stop using that preview and continue using the existing Netlify deployment. If production is later moved, rollback is an infrastructure/DNS action: restore the existing Netlify domain/custom-domain routing and keep Netlify environment variables and `netlify.toml` intact. Do not delete the Pages files or Netlify implementation as part of rollback.
