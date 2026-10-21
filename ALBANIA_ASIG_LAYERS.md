# Albania ASIG layers — one Albania-only group in the layer panel

The nine public WMS products below are described once in
`js/asig-albania-layers.config.js` and rendered as separate rows **inside a
single Albania group**: `#albaniaRow` → `#albaniaSubLayers` in the Gratis / Free
tab. The group is attributed to Albania (`country: 'AL'`) and is visible **only
while Albania is the selected country**. Every row keeps its own checkbox,
opacity control, information popup, Tirana button, and failure status; the group
adds a master switch, an expander, a Tirana button and an info popup. ASIG
attribution is attached to every layer.

| Theme caption in the group | Row label | Registry ID | Exact ASIG WMS `Name` | Format | Snapshot/date notes |
|---|---|---|---|---|---|
| Historical Maps | Topographic map 1:50k | `albania.topo50k` | `Topografike:50K_Topografike` | PNG | — |
| Satellite | Orthophoto 1999 | `albania.ortho1999` | `Orthophoto:Ortofoto_1999` | PNG | — |
| Satellite | Orthophoto 20 cm (2015) | `albania.ortho1994` | `orthophoto_2015:OrthoImagery_20cm` | JPEG | Catalogued 2015 20 cm product; the row no longer calls it 1994 |
| LiDAR | DSM hillshade | `albania.dsm` | `DSM:Dsm_Hill_Group` | PNG | 60% initial opacity |
| LiDAR | LiDAR hillshade | `albania.lidar` | `Dtm_2015:Hillshade_2015_group` | PNG | Hillshade derived from 2015 DTM; 50% initial opacity |
| Heritage Sites | Heritage Sites | `albania.heritage` | `iktk:zonatembrojturatetrashegimisekulturore22_07_2026` | PNG | Snapshot: 22 July 2026 (`_22_07_2026`) |
| Heritage Sites | Natural Protected Sites | `albania.natural` | `akzm:zonat_mbrojtura_081124` | PNG | Snapshot: 8 November 2024 (`_081124`) |
| Heritage Sites | Cultural Protected Sites | `albania.cultural` | `iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026` | PNG | Snapshot: 13 May 2026 (`_13_05_2026`) |
| Heritage Sites | Natural monuments | `albania.monument` | `akzm:monumentet_natyrore_07032023` | PNG | Snapshot: 7 March 2023 (`_07032023`) |

The four date-bearing names are provider snapshots, not timeless identifiers.
If one stops drawing, re-check the provider capabilities and update the config;
do not silently rename a layer. The exact strings above are regression-tested.

## Capabilities evidence and request CRS

The capabilities facts below were supplied by the owner. They are documented in
`test/fixtures/asig-wms-capabilities.xml`; this fixture is explicitly an
owner-supplied excerpt, **not an agent-fetched live response**:

- WMS version 1.3.0; GetMap formats `image/png` and `image/jpeg`.
- Root CRS values `EPSG:6870`, `EPSG:4326`, `EPSG:900913`, and `CRS:84`.
- Each of the nine layers has an empty default style name, so requests use
  `STYLES=`.
- EPSG:6870 is the native CRS / WMTS matrix set. No hand-built EPSG:6870 XYZ
  grid is inferred.
- EPSG:900913 is the advertised Web-Mercator alias. EPSG:3857 is not literally
  listed in this excerpt, so the excerpt alone does **not** establish that the
  service accepts EPSG:3857.

The 2D layer keeps its existing EPSG:3857 first-request path and switches to
EPSG:4326 after six tile errors. WMS 1.3.0 uses latitude/longitude BBOX axis
order for EPSG:4326; the renderer handles that fallback ordering. Acceptance of
the retained EPSG:3857 path is established only by the production proxy probe,
not by offline URL construction or by the supplied capabilities excerpt.

## Coverage, visibility, and panel placement

The WMS BBOX is clipped to the ASIG footprint: longitude 18.773–21.179 and
latitude 39.538–42.758. Tirana is `[41.3275, 19.8187]`, zoom 9. Each Tirana
button (per row and on the group) uses that view.

**Placement.** The rows used to be mounted in four different places of the
Romanian/Denmark panel — the orthophotos between Romania's satellite periods,
the heritage rows inside Romania's Heritage Sites section, and the DSM/LiDAR
hillshades inside the LiDAR group that hosts Denmark's DHM. There are no
`asigHistoricalLayers` / `asigSatelliteLayers` / `asigLidarLayers` /
`asigHeritageLayers` mounts any more: `js/asig-albania-layers.js` renders all
nine rows into `#albaniaSubLayers`, in draw order, with a small
Historical / Satellite / LiDAR / Heritage caption whenever the theme changes
(`CONFIG.sectionLabels`). The group row sits on its own between the LiDAR group
and the Denmark group.

**Country gate.** `filterForCountry(iso)` (called by
`js/map-app.js` → `filterLayersForCountry` on every selection, by
`unfilterLayersForCountry` on “Exit view”, and from the
`detectlab:country-selected` / `detectlab:country-cleared` events) shows the
group only for ISO2 `AL`. For every other country — and for the global view
with no country selected — the group row and every child row get
`albania-out-of-country` / `country-layer-unavailable` and `aria-hidden="true"`,
and the active tile layers are taken off the map (the user's on/off choice is
remembered and restored on the next Albania view, so nothing is requested while
another country is on screen). The class ships in the HTML and the hide rule
(`#albaniaRow.albania-out-of-country { display:none !important; }`) is not
scoped to `.country-filter-active`, because the gate must hold in the global
view too, where that panel class is absent. The gate only controls the panel and
map membership — it never changes the stored on/off state.

Config metadata still supplies the shared catalogue group/z-order:
Historical Maps → `hist-free`, Satellite → `sat-hist`, LiDAR → `lidar`, and
Heritage Sites → `patrimoniu`; that is draw order (panes), not panel placement.
Registry definitions carry `countries: ['AL']` (they are no longer
`countryIndependent`), `guard:false`, `selfGuarded:true`, and an explicit
explanation because this module owns the per-row fallback and status rather than
allowing the global guard to flip a control.

## Failure behavior

- Failed image loads, including HTTP-200 XML/HTML or bodies the browser cannot
  decode as images, become Leaflet tile errors.
- After six EPSG:3857 tile errors, that layer redraws with EPSG:4326.
- If the fallback also has a persistent error burst, that row reports
  **“the source is not answering”** (or its Romanian equivalent).
- Console output is limited to one concise warning per layer.

The same-origin map tile proxy also rejects successful upstream responses that
are not `image/*` or contain fewer than 32 bytes, and marks upstream failures in
`X-Map3D-Upstream`. The production probe treats those markers as failures.

## Offline checks versus live production results

The offline audit rebuilds request URLs and verifies repository invariants only;
it makes no HTTP request and does not claim that ASIG or the production proxy
returned a tile. Its Tirana sample for all nine Albania entries is
`12/2273/1530`. The former sample `12/2345/1480` is Bucharest, not Albania.

Run the same-origin production gate with:

```sh
node tools/probe-asig-production.mjs --origin=https://detectlab.eu --tile=12/2273/1530
```

It requests all nine registry IDs through
`/api/map3d/tile?layer=albania.<id>&z=12&x=2273&y=1530` and prints HTTP status,
Content-Type, body size, and `X-Map3D-Upstream` for every layer. A pass requires
HTTP 200, an `image/*` response of at least 32 bytes, no XML/HTML exception body,
and no upstream failure marker. The test `test-asig-production-probe.mjs` is
mock-only and does not contact production. Do not represent its results—or the
offline audit—as live verification.

## Manual QA

- Open the layer panel in the default view: there is **no** Albania group (the
  Albanian rows are not in the Romanian Historical Maps / Satellite / Heritage
  Sites rows, nor in the LiDAR group that hosts Denmark's DHM).
- Select Albania from the globe/dock: the “Albania · ASIG geoportal” group
  appears between the LiDAR group and the Denmark group, expanded, with the four
  theme captions and the nine rows. Its master switch toggles the whole stack;
  the arrow collapses it; “Tirana” frames the country.
- Switch to Romania, Denmark or Finland (or “Exit view”): the group disappears
  and any Albanian layer that was on is parked without losing its switch state.
  Back to Albania: the same rows return with the same on/off and opacity values.
- `node test-albania-asig-layers.js` covers the placement invariants (one group,
  no old mounts, position before the Denmark group), the gate for RO/DK/FI/IT,
  the global view, the remembered per-layer state, the master switch, the
  expander, the WMS URL/BBOX clipping and the EPSG:4326 fallback.
  `node test-country-layer-filter.js`, `node test-wms-layer-audit.js` and
  `node test-wms-health.js` cover the surrounding filter/registry/health
  contracts.

Attribution: Data: ASIG, Albanian State Authority for Geospatial Information
(geoportal.asig.gov.al). Terms for commercial redistribution are not stated in
the supplied capabilities excerpt; verify them before commercial promotion.
