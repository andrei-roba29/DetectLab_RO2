# Albania — the ASIG geoportal catalogue in one Albania-only group

The ASIG geoportal (`geoportal.asig.gov.al`, Autoriteti Shtetëror për
Informacionin Gjeohapësinor) catalogue for Albania lives in **one** layer-panel
group — `#albaniaRow` → `#albaniaSubLayers` in the Gratis / Free tab — and is
visible **only while Albania (ISO2 `AL`) is the selected country** (global view
included: hidden). The group ships hidden in the HTML
(`albania-out-of-country`), is gated at runtime by
`js/asig-albania-layers.js` (`filterForCountry`), and a startup sweep removes
any pre-group mount or Albanian row a stale PWA shell might still carry inside
another country's section.

Everything the panel shows is **data**: `js/asig-albania-layers.config.js` is
the single description of the catalogue (sections, titles, exact
`workspace:name` identities or resolve-by-title rules, opacities, zoom limits,
attribution). Adding, removing or re-labelling a layer is a config change, not
a map-code change. `node tools/build-asig-catalogue.mjs` regenerates the
interchange copy `data/asig-catalogue.json` from that config (`--check`
verifies it is current; the test suite runs it).

**Licence: unknown.** ASIG's reuse/redistribution terms are not stated in the
capabilities supplied and are flagged as unknown in the config and registry —
do not present them as a grant. Verify with ASIG before relying on them.

**No legal claims.** The Heritage layers draw protected zones only. They are
not a permission map, and the site states no detecting rules for Albania: the
Heritage ⓘ text in the config carries a clearly marked
`[OWNER PLACEHOLDER: …]` for the site owner to replace with a verified notice.

## The catalogue (exactly as rendered)

Display titles are the portal titles verbatim — including the portal's own
spelling "Mineral Resouces". Tiles load **directly from ASIG in the visitor's
browser**; nothing is proxied (2D), prefetched or bulk-downloaded.

| Section | Panel entry | Kind | ASIG identity |
|---|---|---|---|
| Heritage | **Heritage** (ONE toggle) | group | parts below — never listed individually |
| Orthophotos | Ortofoto 76 86 25k | WMS | `Orthophoto:Ortofoto_76_86_25k` |
| Orthophotos | ortofoto 94 | WMS | `Orthophoto:ortofoto_94` |
| Orthophotos | OrthoImagery (2007) | WMS | `orthophoto_2007:OrthoImagery` |
| Orthophotos | OrthoImagery (2015) | WMS | `orthophoto_2015:OrthoImagery` |
| Orthophotos | OrthoImagery 20cm | WMS | `orthophoto_2015:OrthoImagery_20cm` |
| Orthophotos | OrthoImagery 8cm | WMS | `orthophoto_2015:OrthoImagery_8cm` |
| Orthophotos | Orthophoto CIR | WMS | `Orthophoto_cir:Orthophoto_CIR` |
| Orthophotos | Orthophoto CIR 8cm | WMS | `Orthophoto_cir:Orthophoto_CIR_8cm` |
| Orthophotos | Ortofoto 2018 | WMS | `ortofoto_2018:Ortofoto_2018` |
| Orthophotos | Ortofoto 2001 | WMS | `Orthophoto:Ortofoto_2001` |
| Orthophotos | Ortofoto 1999 | WMS | `Orthophoto:Ortofoto_1999` |
| Orthophotos | Ortofoto 1957 | WMS | `Orthophoto:Ortofoto_1957` |
| Orthophotos | Orthofoto 1976 1980 | WMS | `Orthophoto:Orthofoto_1976_1980` |
| Orthophotos | Fragment Durres 1986 | WMS | `Orthophoto:Fragment_Durres_1986` |
| Terrain | Hillshade 2015 group | WMTS-only | `Dtm_2015:Hillshade_2015_group` |
| Terrain | Dsm Hill Group | WMTS-only | `DSM:Dsm_Hill_Group` |
| Cadastre | Cadastral Zone | WMS | resolve by Title |
| Cadastre | Cadastral Parcels | WMS | resolve by Title |
| Cadastre | Cadastral Parcels (ASHK) | WMS | resolve by Title |
| Maps | italiane 100k | WMTS-only | `hartat_historike:italiane_100k` |
| Maps | 25k_krgjsh_1 | WMS | resolve by Title (then local Name) |
| Environment | Water course link | WMS | resolve by Title |
| Planning & mining | Areas Planned by (DCM 347) | WMS | resolve by Title |
| Planning & mining | Mining Hazardous Areas (DCM 726) | WMS | resolve by Title |
| Planning & mining | Mining Hazardous Areas (DCM 347) | WMS | resolve by Title |
| Planning & mining | Old Mining Areas | WMS | resolve by Title |
| Planning & mining | Mineral Resouces | WMS | resolve by Title |
| Planning & mining | Mining exploitation permits | WMS | resolve by Title |

Heritage parts (switched/faded/reordered/queried together by the one row):

| Part | ASIG `workspace:name` | Provenance |
|---|---|---|
| Cultural protected sites (polygon) | `iktk:zonatembrojturatetrashegimisekulturore22_07_2026` | repo (previous module; snapshot 22 Jul 2026) |
| Cultural protected sites (point) | `iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026` | repo (snapshot 13 May 2026) |
| Natural Protected Areas | `akzm:zonat_mbrojtura_081124` | prototype (snapshot 8 Nov 2024) |
| Natural monuments | `akzm:monumentet_natyrore_07032023` | prototype (snapshot 7 Mar 2023) |
| every archaeological zone | *(runtime)* | every WMS layer whose Title/Name matches `/archaeolog\|archeolog\|arkeolog/i` in the live GetCapabilities |

The dated names are publication snapshots. If one stops drawing, re-check the
name in a browser capabilities document and update **only the config** — never
silently rename or drop a layer (report the failing URL + response instead;
every row's error status carries an "open the failing request" link).

**Retired with the exact catalogue (owner decision):** the previous module's
Topo 1:50k row (`Topografike:50K_Topografike`) is not in the prototype
catalogue and was removed. Saved state migrates
(`detectlab_albania_layers_v1` → `v2`): the four old heritage rows fold into
the one Heritage toggle, surviving rows keep on/off + opacity, `topo50k` is
dropped.

## How layers are requested

### WMS (the prototype-verified shape)

`SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=<name>&STYLES=&SRS=EPSG:3857
&FORMAT=image/png&TRANSPARENT=TRUE`, 512 px tiles (`zoomOffset −1`), tiles
keep their **full** bbox (clipping the bbox to the footprint would stretch
edge tiles); tiles not touching the ASIG footprint
(18.773–21.179 E / 39.538–42.758 N) answer a blank pixel locally.

Failure chain per layer (HTTP-200 XML/HTML ServiceExceptions count as tile
errors — a zero-size "image" is never a success):

1. per-workspace endpoint `…/service/<workspace>/wms` first;
2. after 2 errors, one retry through the global `…/service/wms`
   (row status says it is retrying);
3. after a further error burst, `EPSG:4326` (the module's older safety net);
4. persistent failure → visible row status with a link to the failing
   request. The layers are self-guarded (`_detectlabNoGuard`); the global
   availability guard only names the host.

Caveat kept from the prototype: the site's Leaflet ceiling is zoom 20 — if the
map `maxZoom` ever drops back to 18, these layers disappear above it and the
ceiling must be raised, not the layers.

### WMTS-only layers (tile products, canvas-reprojected)

The three WMTS-only layers are **not** WMS layers: GetMap answers
`LayerNotDefined` as XML with HTTP 200. The owner-supplied WMTS
GetCapabilities (2026-10-24) confirms they link only the `EPSG:6870`
(levels 0–12) and `EPSG:4326` (levels 0–21; top-left −180, 90; 256 px tiles;
`MatrixWidth = 2^(z+1)`, `MatrixHeight = 2^z`) TileMatrixSets. The service
also *defines* `EPSG:900913`/`GoogleCRS84Quad` sets, but these layers do not
advertise a link to them, so direct Web-Mercator GetTile is **unproven** and
not used. Instead, `planTile`/`WmtsMercator` reproject EPSG:4326 tiles to Web
Mercator on canvas, row by row; where the tile cache ends, the renderer
**steps down to shallower levels and enlarges** them (with a row notice)
instead of going blank — the real deepest cached level is discovered at
runtime, per level, after repeated misses.

### Resolve-by-title discovery (no guessed names, ever)

The 11 title-only layers have `layers: null` + `resolveTitle` in the config.
In the visitor's browser the module fetches the live WMS GetCapabilities and
matches **exact normalised Title** (lowercase, `_`/space-insensitive), then
local Name (that's what `25k_krgjsh_1` needs). Outcomes:

- exactly one hit → the row enables and requests that exact name;
- more than one → the row stays off and **lists the candidates for the owner**
  (ambiguous titles are an owner decision, never a guess);
- none / document unreadable → the row stays disabled with an explanation;
  static layers keep working. ASIG blacklists automated IPs, so this runs in
  the browser; the panel's tools ("Reload layer list" / "Load capabilities
  file…") re-run it or ingest a browser-saved XML file.

To bake names in permanently, run the offline resolver on a browser-saved
capabilities file and copy the results into the config (`layers:`), deleting
`resolveTitle`; archaeology hits go to `CONFIG.heritage.staticDiscovered`:

```sh
python3 tools/resolve_layers.py path/to/capabilities.xml          # human report
python3 tools/resolve_layers.py path/to/capabilities.xml --json   # machine-readable
node tools/build-asig-catalogue.mjs                               # refresh data/asig-catalogue.json
```

(The owner's `asig-layers.json` export from the prototype carries the same
resolved names — `heritage.parts` maps to `staticDiscovered`. It had not been
supplied when this catalogue was integrated, hence runtime discovery.)

### Click feature-info

With any WMS layers on, a map click issues WMS 1.1.1 GetFeatureInfo
(`text/html`, `feature_count=10`) for **every active WMS leaf — all Heritage
parts included** — grouped per endpoint, and shows the answers in a Leaflet
popup inside `sandbox=""` iframes (ASIG's own HTML, no scripts, no
same-origin access). Empty answers collapse to "No features at this
location."; a failed fetch never breaks the click. WMTS-only layers are not
queried (orthophoto/terrain rasters have no feature info contract here).

## Panel behaviour

One Albania-only group with: master switch, expander, Tirana button, group
ⓘ; a **search box** (`#albaniaLayerSearch`, outside the generated mount so
rebuilds keep the query); seven **collapsible sections**; per entry a
checkbox, opacity slider + %, ⓘ, Tirana shortcut, exact Name (or
resolve-by-title hint), status line, and **↑/↓ active-stack reordering**
(z-order inside the one catalogue pane `pane_asig_catalogue` — Heritage moves
as one). State (on/off, opacity, stack order, collapsed sections) persists in
`localStorage` (`detectlab_albania_layers_v2`). ASIG attribution rides on
every tile layer (Leaflet attribution control) and under the catalogue.

## Registry, 3D and audits — what is *not* in the proxy path

`js/layer-registry.js` mirrors only the **18 statically-named WMS** layers
(14 orthophotos + 4 Heritage parts, ids `albania.<id>`, parts pointing at the
Heritage controls with `ui.partOf: 'heritage'`) for diagnostics, the 3D deck
and the offline audit. The WMTS-only three and the resolve-by-title eleven
have no static WMS GetMap for the same-origin 3D tile proxy to serve, so they
are deliberately absent there — the 2D panel loads them direct from ASIG and
the 3D mirror drapes the live 2D canvas tiles.

Checks (all offline; none of them claims a live ASIG result):

```sh
node test-albania-asig-layers.js        # catalogue/panel/gate/requests/discovery/fallbacks
node test-asig-production-probe.mjs     # mock-server regression for the probe below
node test-wms-layer-audit.js            # registry-wide offline audit (regenerates expectations)
node tools/build-asig-catalogue.mjs --check
node tools/audit-wms-layers.mjs --write=WMS_WMTS_LAYER_AUDIT.md   # refresh the audit report
node tools/probe-asig-production.mjs --origin=https://detectlab.eu --tile=12/2273/1530
```

The production probe is the only live check, and it goes through the site's
own tile proxy for the 18 registry layers (HTTP 200 + `image/*` + ≥32 bytes +
no exception body required — a 200 `text/xml` is a FAIL).

## Verifying rendering in a browser (owner checklist)

Sandbox/CI cannot reach ASIG (automated IPs are blacklisted), so per-layer
live proof is a normal-browser job. In the deployed site: select Albania →
the ASIG group appears with Heritage + 14/2/3/2/1/6 entries and **no Heritage
part rows**; switch layers on over Albania and watch the row statuses. To
check a single request by hand, these URLs must return `image/png` (a 200
with `text/xml` is the failure signature — report the exact URL + body, do
not rename the layer):

- WMS GetMap (Orthophoto 1999 over Tirana):
  `https://geoportal.asig.gov.al/service/Orthophoto/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=Orthophoto%3AOrtofoto_1999&STYLES=&SRS=EPSG%3A3857&BBOX=2200000,5050000,2215000,5065000&WIDTH=512&HEIGHT=512&FORMAT=image%2Fpng&TRANSPARENT=TRUE`
- WMTS GetTile (italiane 100k, EPSG:4326 grid, z12 over Tirana):
  `https://geoportal.asig.gov.al/service/wmts?layer=hartat_historike%3Aitaliane_100k&style=default&tilematrixset=EPSG%3A4326&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fpng&TileMatrix=EPSG%3A4326%3A12&TileCol=4546&TileRow=1108`
  — then zoom the map to z18+ and confirm enlarged tiles instead of blanks
  (this re-confirms the step-down fix end to end).
- If a resolve-by-title row stays disabled in the browser, open the group
  tools' status line: it names missing titles and ambiguous candidates
  verbatim for an owner decision.

## Files

| File | Role |
|---|---|
| `js/asig-albania-layers.config.js` | the catalogue (single source of truth) |
| `js/asig-albania-layers.js` | panel + renderers (WMS, WMTS canvas), discovery, feature-info, gate |
| `js/layer-registry.js` | mirrors the 18 static WMS layers for 3D/diagnostics/audit |
| `data/asig-catalogue.json` | generated interchange copy (do not hand-edit) |
| `tools/build-asig-catalogue.mjs` | regenerates/checks the JSON copy |
| `tools/resolve_layers.py` | offline Title→Name resolver for browser-saved capabilities |
| `tools/probe-asig-production.mjs` | live proxy probe for the 18 registry layers |
| `test/fixtures/asig-wms-capabilities.xml` | owner-supplied excerpt (facts, untouched) |
| `test/fixtures/asig-wms-capabilities.synthetic.xml` | invented names for resolver tests — **not** an ASIG response |
| `index.html` / `css/styles.css` / `sw.js` | group shell + search, panel styles, cache `detectlab-v258-asig-catalogue` (assets `?v=20261024-asig-catalogue`) |
