## Heritage performance change — 2026-10-26

Heritage no longer creates one WMS tile overlay per source. A single viewport
controller (`js/asig-heritage.js`) queries `/api/geo/asig-heritage` at zoom 10+
and clusters the returned representatives in screen-pixel cells (80/50/24 px
as zoom increases). Below zoom 10 it asks the user to zoom in, with no feature
requests. Counts are a **bounded viewport sample**, not national totals.

Queries are debounced 350 ms, serial, aborted on movement/removal, and guarded
against stale replies. Old markers are cleared on movement and removal. Limits:
150 objects per source, 600 per view, 2 MB per upstream response, 10 seconds per
upstream query. Capped or failed queries have visible status messages. There is
no automatic return to the memory-heavy WMS stack. Cluster clicks zoom in;
individual clicks show a text-only title. Area features use bbox-centre markers,
**not original polygon boundaries or guaranteed interior points**. Representatives
outside the viewport are omitted. Full polygon detail and exhaustive results
would require a separate, verified server-side generalization/aggregation feed.

The proxy implementation is shared by Netlify, Express and the preview server.
It requests WFS 1.0 EPSG:4326 (longitude,latitude) from ASIG's `/service/wfs`,
using fixed host, validated bounds and constrained heritage type names. Existing
WMS catalogue/attribution metadata stays intact for auditing, but Heritage is
excluded from raster GetFeatureInfo queries. Marker attribution is retained.

**Deployment verification required:** this environment cannot contact the ASIG
host. WFS availability, type names, output-format support and production speed
have not been verified live. A WMS layer being published does **not** guarantee
that the equivalent WFS type is enabled. If ASIG refuses WFS or a type is absent,
the UI reports an unavailable/incomplete feature service rather than silently
showing an empty successful result. This change has mock/offline tests, not a
confirmed PWA crash reproduction or device-memory benchmark.

Tests: `node test-asig-heritage.mjs`, `node test-albania-asig-layers.js`.

---

> WMTS performance (2026-10-26): reprojection shares in-flight source images, caches up to 128 completed images, briefly caches failed URLs (15 seconds), and paints each source as it arrives. Source zoom/detail and CRS are unchanged. This reduces repeat work but cannot accelerate an uncached response from ASIG itself.

> UI update (2026-10-26): thematic sections now appear directly in the layer list, without a country master layer. All Albanian and Danish LiDAR rows live once under the existing shared LiDAR accordion. Country filtering and per-layer controls remain in place.

# Albania ASIG geoportal catalogue — one Albania-only panel

The Albanian layers are the **ASIG geoportal catalogue** (Autoriteti Shtetëror
për Informacionin Gjeohapësinor, <https://geoportal.asig.gov.al>): 28 curated
layers in six sections plus **Heritage as one toggle**. Everything is mounted in
a single Albania-only group, `#albaniaRow` → `#albaniaSubLayers`, in the
Gratis / Free tab.

| File | Job |
|---|---|
| `data/asig-layers.json` | **The catalogue** — sections, display titles, exact `workspace:name` values, endpoints, Heritage parts, licence note. Generated; never hand-edit. |
| `data/asig-layers.data.js` | The same object as a plain `<script>` (and a Node `require`). Generated in the same pass, so it cannot drift. |
| `tools/build-asig-catalogue.mjs` | The generator: curated spec + the prototype's `asig-layers.json` export → both files above. |
| `js/asig-albania-layers.config.js` | Request rules only: WMS/WMTS parameters, CRS, zoom limits, pane/registry metadata, labels, run-time resolver settings. |
| `js/asig-albania-layers.js` | The panel and the Leaflet layers: sections, search, active list, Heritage, WMS, WMTS reprojection, feature info, country gate. |
| `js/layer-registry.js` | Mirrors every answerable WMS row as `albania.<id>` for the diagnostics, the 3D status report and the offline audit. |
| `index.html` | Loads `data/asig-layers.data.js` before the config; the group row and `#albaniaSubLayers` mount. |
| `css/styles.css` | `.albania-*` panel styles (search, active list, sections, Heritage block, feature-info iframes). |

## The catalogue

Section order in the panel: **Heritage (one toggle)** first, then Orthophotos
(14), **LiDAR** (2), Cadastre (3), Maps (2), Environment (1), Planning & mining
(6) — 28 catalogue rows, and the only Albanian content the site has.

The section used to be labelled *Terrain*; it is now **LiDAR** (id `lidar`), which
is what its two products actually are — DTM/DSM-derived hillshades — and what the
rest of the site calls that kind of layer. The label and the section id are
separate things: the id keys the DOM (`#albaniaSection_lidar`), the registry's
`ui.section` and the saved collapsed state, so it was renamed together with the
label rather than left behind.

Three rows are tile-only (WMTS) and cannot be drawn through the WMS:

| Title | Name | Kind |
|---|---|---|
| Hillshade 2015 group (LiDAR) | `Dtm_2015:Hillshade_2015_group` | WMTS only |
| Dsm Hill Group (LiDAR) | `DSM:Dsm_Hill_Group` | WMTS only |
| italiane 100k (Maps) | `hartat_historike:italiane_100k` | WMTS only |

Display titles are the portal's own, kept verbatim — including the misspelled
**“Mineral Resouces”**, which is also the title the export uses, so resolution
must match it exactly.

Nothing from the pre-catalogue group survives: the old 1:50k sheet
(`Topografike:50K_Topografike`), its captions and the modules' legacy
state/mount handling are gone, so an older Albanian layer cannot be switched on
beside the catalogue — a country view shows the catalogue or no ASIG layers at
all.

### Heritage — one toggle, several parts

Turning Heritage on switches on every part at once; turning it off removes them
all. It has **one** checkbox, **one** opacity slider, **one** entry in the
active-layer list, one reorder control and one remove button. The parts are
never rows of their own:

- `akzm:zonat_mbrojtura_081124` — Natural Protected Areas
- `akzm:monumentet_natyrore_07032023` — Natural monument
- Cultural protected sites (point) — `iktk:…_pike13_05_2026` (recorded in this
  repo from the owner-supplied capabilities; the export wins when it has the
  same title)
- Cultural protected sites (polygon) — `iktk:…22_07_2026`
- **every** WMS layer whose title or name matches
  `/archaeolog|archeolog|arkeolog/i` — added by the generator from the export,
  and by the run-time resolver when the export is not available yet.

Because ASIG keeps publishing new Council of Ministers zoning decisions, the
archaeological list is meant to be regenerated, not hand-edited (see
“Regenerating the catalogue”).

## The panel

- **Same row style as the other countries** (Romania is the template, restyle
  of 2026-10-27). Every layer is a glass `.dl-sublayer-row`: title on the left
  and the pill on/off switch (`.apm-toggle-switch`) on the right of the header
  line, then the “Opacity” line (`.transp-layer-label`, with the shared ⓘ
  button and `%` badge) and the shared `.transp-slider` slider. The old
  Albania-only rows (native checkbox on the left inside a wrapping label,
  `.albania-layer-slider` offset by 19px, text-“i” info button) are gone. Row
  ids did not move (`albaniaRow_` / `albaniaToggle_` / `albaniaOpacity_` /
  `albaniaPct_` / `albaniaStatus_` + layer id), so the registry, the
  vertical-opacity control and saved state keep working unchanged; the LiDAR
  rows in the shared LiDAR accordion also keep their `lidar-country-row` /
  `lidar-country-opacity` treatment.
- **Collapsible sections.** One Romania-style header per section
  (`.transp-layer-row` + `.transp-layer-label`): title and row count on the
  left, an expand chevron (`#albaniaSectionHead_<id>`) and a **master on/off
  switch** (`#albaniaSectionToggle_<id>`, new with the restyle —
  `toggleSectionLayers(id, on)`, indeterminate when only part of the section
  is on) on the right. Sections still start expanded; the collapsed state is
  remembered in `localStorage`.
- **One switch and one opacity slider per layer** (the switch wraps the same
  per-layer checkbox as before), plus a per-row ⓘ popup (title, exact service
  name, ASIG attribution, licence caveat) and a per-row **Tirana** button
  (centre the map on the capital, now next to the switch) — both kept from
  the earlier group.
- **Search box** (`#albaniaSearch`) filtering by display title, exact layer name
  and — for Heritage — every part's title/name, so `zonat_mbrojtura` or
  `arkeologjike` finds the Heritage toggle even though its parts are not rows.
  Matching folds diacritics and case: `durres` finds *Durrës*, `shkoder` finds
  *Shkodër*, `25k` finds the sheet.
- **Active-layer list** (`#albaniaActive`) with ↑ / ↓ reordering and a remove
  button per entry; the top of the list is the top of the map. Reordering is a
  real z-order: every catalogue layer draws in ONE Leaflet pane
  (`pane_asig`, z-index 404), so list order is draw order. (The sections no
  longer own individual panes — that would have made cross-section reordering
  meaningless.)
- **Group master switch / expander / Tirana / ⓘ** behave as before.

## Requests

### WMS (25 of the 28 rows)

`GetMap` per tile, WMS 1.3.0, `STYLES=`, `image/png`, `TRANSPARENT=TRUE`, the
tile's own EPSG:3857 extent clipped to the ASIG footprint
(`lon 18.773–21.179`, `lat 39.538–42.758`). Two fallbacks, in order:

1. **Endpoint.** The per-workspace route
   `https://geoportal.asig.gov.al/service/<workspace>/wms` is asked first; after
   two tile errors with no successful tile the layer retries once through the
   global `https://geoportal.asig.gov.al/service/wms` (the prototype's rule).
   *Not verified:* which endpoint a given layer prefers; the export records both
   (`url`, `fallbackUrl`) and the catalogue uses what it says.
2. **CRS.** After `CONFIG.wms.fallbackAfterErrors` (6) consecutive errors the
   layer redraws with `EPSG:4326` (WMS 1.3.0 lat/lon axis order, handled). A
   second burst marks the row “the source is not answering”.

A HTTP 200 answer that is XML/HTML, or any body the browser cannot decode as an
image, is a tile error — that is how the GeoServer `LayerNotDefined` body for the
three tile-only names is caught.

### WMTS (the 3 tile-only rows)

The WMTS (`service/wmts`, GeoWebCache) links its layers **only** to the
`EPSG:6870` (13 levels, Albania TM) and `EPSG:4326` (22 levels) tile-matrix sets.
There is no Web-Mercator grid, so each Web-Mercator tile is drawn on a canvas:
`api.planWmtsTile()` maps the destination tile into the plate-carrée grid
(`2^(z+1) × 2^z` tiles of 256 px, top-left at −180°/90°), fetches the source
tiles that cover it and mosaics them row by row (latitude is not linear in
Mercator). The images are **not** requested with `crossOrigin` — the WMTS sends
no CORS header and the canvas is only a drawing surface here, so a tainted
canvas keeps working while a CORS request would refuse every tile.

The deepest cached level is unknown. Each destination tile starts at
`min(maxSourceZoom, z)`, steps down a level when a source level evidently has no
cached tiles (three misses), and the row says “no cached tiles at this zoom;
showing a shallower level enlarged”. `italiane 100k` is the layer this was added
for; the step-down has **not** been re-confirmed against the live tile server
from this environment.

## Feature info on map click

A click queries **every active WMS part** (Heritage included), grouped by
endpoint, with `GetFeatureInfo` (WMS 1.1.1, `SRS=EPSG:3857`, the clicked pixel
and the map's view size). The answer is rendered in a map popup, one
**sandboxed** `<iframe>` (`sandbox=""`) per endpoint. If the cross-origin read is
blocked the iframe loads the request URL directly, so the service's own HTML is
still shown. Tile-only layers have no feature info and are skipped.

**A tap only queries inside Albania, and only while a layer is drawing.** The
handler is registered once on the map, but `canQueryAt(latlng)` gates it on four
conditions; without them the popup opened for a tap anywhere in Europe (the
installed PWA included, because the on/off state is restored from
`localStorage`):

| gate | why |
| --- | --- |
| `!runtime.suppressed` | the group is parked (country switched away) |
| `runtime.inCountry` | Albania is the selected country |
| `insideFootprint(latlng)` | the tap is inside the catalogue's `countryBounds` (+0.02° margin for tile edges) |
| `activeWmsLeaves().length > 0` | a WMS part is **on the map right now** — `map.hasLayer(part.layer)`, not merely remembered in storage |

`API.canQueryAt` / `API.insideFootprint` are exposed for tests. Regression test:
`node test-asig-click-guard.js`.

## Run-time name resolution (rows the export has not named yet)

`asig-layers.json` (the prototype export) was **not available** when this
catalogue was generated, so only the names that were already verified in this
repository are baked: `Orthophoto:Ortofoto_1999`,
`orthophoto_2015:OrthoImagery_20cm`, the three tile-only products and the four
Heritage parts. **23 of the 25 WMS rows are still unnamed** — the other 13
orthophoto flights, Cadastre ×3, `25k_krgjsh_1`, Water course link and
Planning & mining ×6. They are written as
`"name": null` plus `resolveByTitle`, and `js/asig-albania-layers.js` fills them
in **in the visitor's browser**:

1. a name baked in the catalogue always wins;
2. otherwise the service's `GetCapabilities` is read once (title match, then the
   bare name segment) and the answer is cached in `localStorage` for 7 days;
3. every layer whose title/name matches the archaeology keyword joins Heritage
   as a new part, and Heritage redraws if it is already on.

This runs in the browser on purpose: ASIG answers *“IP … is blacklisted”* to
automated requests from some cloud addresses, while visitors' browsers are
served normally. If the read fails, the affected rows stay off and say so — they
never draw a guessed layer name.

**Bake the names as soon as the export exists** (below): the panel keeps the
rows but marks them *not in the catalogue yet*, the registry skips them
(`AsigAlbaniaLayers` → `asigCatalogueSkips()` lists them, with the reason), so
they are invisible to the diagnostics, the 3D status report and the production
probe until the catalogue is regenerated. Nothing is guessed in the meantime.

## Regenerating the catalogue

```sh
# 1. Prototype: wait for the status line, click “Export layer list (JSON)”,
#    save the file as asig-layers.json in the repo root.
node tools/build-asig-catalogue.mjs --export=asig-layers.json
node tools/build-asig-catalogue.mjs --check        # what the regression test runs

# Bootstrap only, when no export exists yet (run-time resolution, see above) —
# this is how the committed catalogue was produced:
node tools/build-asig-catalogue.mjs --allow-unresolved
```

The export also carries the archaeology list: every layer whose title or name
matches `/archaeolog|archeolog|arkeolog/i` is appended to Heritage as soon as it
appears in it — no code change per Council of Ministers decision.

The generator is **strict**: a WMS row whose title cannot be matched stops the
build and lists the titles, because a catalogue must not ship a layer name nobody
verified. `--allow-unresolved` is the only way to write `null` names. The
curated spec (sections, order, display titles, which rows are tile-only, the
Heritage rule) lives in `CATALOGUE_SPEC` / `HERITAGE_SPEC` inside the generator;
names, endpoints and the archaeological parts come from the export. Both output
files are written in one pass, and `test-albania-asig-layers.js` fails if they
drift from the generator.

After regenerating: bump the `?v=` tags for the data + config + module in
`index.html` and `sw.js` (and `CACHE_NAME`), then run the tests below.

## Attribution, licence, and what is verified

- **Attribution.** `Data: ASIG, Albanian State Authority for Geospatial
  Information (geoportal.asig.gov.al)` is attached to every Leaflet layer (so it
  appears in the map's attribution control whenever a layer is on) and repeated
  in every row's ⓘ popup and the group popup.
- **Licence — unresolved, deliberately.** ASIG does not state reuse terms in the
  supplied capabilities. The catalogue records
  `"licence": { "state": "unverified", … }` and the ⓘ popups tell the visitor
  the terms are not published. **Confirm them with ASIG before commercial use or
  redistribution of the tiles.** Do not replace this with a guessed licence.
- **Observed** (from the portal's WMTS capabilities and the owner's network
  logs): the WMTS endpoint and its two matrix sets; no Web-Mercator grid; the
  WMS `LayerNotDefined` XML body with HTTP 200 for `hartat_historike:italiane_100k`;
  the portal's own map asking WMS with `SRS=EPSG:6870` and WMTS with
  `tilematrixset=EPSG:6870`; the cloud-IP blacklist.
- **Assumed / unverified:** which endpoint each WMS layer prefers; the deepest
  WMTS level with cached tiles; that EPSG:3857 is accepted (the supplied
  capabilities advertise EPSG:900913, not 3857 literally — the retained request
  path is established only by the production probe, not by URL construction).

## Coverage, country gate, and the 3D view

- The panel group and every row are visible **only** while Albania (ISO2 `AL`)
  is the selected country — including the global view, where no country is
  selected. The on/off choice is remembered and the tile layers are parked while
  another country is on screen, so nothing is requested.
- `buildPanel()` always rebuilds the panel inside `#albaniaSubLayers`, so the
  catalogue has exactly one place in the page and nothing older can be rendered
  beside it.
- State is stored under `detectlab_albania_layers_v2`; there is no migration
  from the pre-catalogue keys, because none of those rows exist any more.
- The three WMTS rows are **not** in the registry: they are canvas-reprojected
  layers with no WMS layer to audit, and the 2D ⇄ 3D mirror does not carry ASIG
  layers. WMS rows are mirrored as `albania.<id>`, `countries: ['AL']`,
  `guard: false`, `selfGuarded: true`; rows without a baked name are skipped
  until the catalogue is regenerated (`AsigAlbaniaLayers` shows the list via
  `registry.asigCatalogueSkips()`).

## Tests and live checks

```sh
node test-albania-asig-layers.js            # catalogue + panel + WMS/WMTS + registry (offline)
node test-asig-catalogue-generator.mjs      # generator: title folding, names, strict mode, artefacts
node test-wms-layer-audit.js                # offline audit of every WMS/WMTS layer
node test-asig-production-probe.mjs         # mock-only probe regression
node test-wms-health.js                     # the availability guard, incl. the ASIG rows
node tools/audit-wms-layers.mjs             # the audit itself (0 errors expected)
node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md   # refresh the report
```

Live production check (same-origin tile proxy, never ASIG directly):

```sh
node tools/probe-asig-production.mjs --origin=https://detectlab.eu --tile=12/2273/1530
```

It requests every `albania.*` WMS registry row through
`/api/map3d/tile?layer=albania.<id>&z=12&x=2273&y=1530` and prints HTTP status,
Content-Type, body size and `X-Map3D-Upstream`. A pass requires HTTP 200, an
`image/*` body of at least 32 bytes, no XML/HTML exception body and no upstream
failure marker. Offline tests build URLs only — they do not prove that ASIG (or
the proxy) returned a tile.

## Manual QA

- Default view (no country): there is **no** Albania group.
- Select Albania: the group appears between Romania's LiDAR group and the
  Denmark group, expanded, with the search box, the active list, the Heritage
  toggle and six collapsible sections — Orthophotos · **LiDAR** · Cadastre ·
  Maps · Environment · Planning & mining. Counts per section: 14 / 2 / 3 / 2 / 1 / 6.
- Search `arkeolog`: only the Heritage toggle remains visible; search `durres`:
  one orthophoto row. Clear: everything returns.
- Switch on two orthophotos and reorder them with ↑/↓: the upper list entry
  draws above the other (compare with and without the basemap).
- Switch Heritage on: one active-list entry, 4+ layers on the map, one slider
  moving all of them. Click the map inside Albania: the popup queries the
  Heritage parts (one iframe per workspace endpoint).
- Switch `italiane 100k` on and zoom in deeply: instead of going blank it shows
  enlarged tiles and the row says the level is not cached (only if the WMTS
  really has no deep tiles there).
- Switch to Romania / Denmark / Finland, or “Exit view”: the group disappears,
  the switches are remembered, and back in Albania the same rows return with the
  same opacity and order.
