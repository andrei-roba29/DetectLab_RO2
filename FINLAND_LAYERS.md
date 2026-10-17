# Finland · Finnish maps — layers, endpoints and verification

**Group row:** “Finland · Finnish maps” (id `finlandRow`, master switch
`finlandToggle`, country `FI`). **Everything a layer is** — id, FI/EN titles,
kind, endpoint, zoom limits, attribution, default visibility — lives in one
file, **`js/finland-layers.config.js`**; `js/finland-layers.js` only renders
rows and Leaflet layers from it, and `js/layer-registry.js` mirrors the
enabled entries as `finland.<id>` into the shared catalogue (diagnostics, 3D
status report, offline audit). `js/finland-tm35.js` supplies the pure
EPSG:3067 (ETRS-TM35FIN) maths and the Mapbox Vector Tile decoder — no proj4,
no new map library, Leaflet 1.x only.

## 1 · The panel

* master switch + five collapsible sections, each with its own “all on/off”
  checkbox: **Terrain** · **Cadastral** · **Protected sites** · **Åland** ·
  **Local files (Supabase)**;
* inside “Protected sites”, collapsible sub-sections with a colour swatch
  each: SYKE built heritage (special legislation), SYKE INSPIRE nature /
  Natura 2000 / specially-protected built heritage, the eight
  Muinaisjäännösrekisteri categories, and the Museovirasto protected-buildings
  register;
* every row: checkbox, ⓘ description (EN text, FI original as tooltip),
  opacity slider, status line — loading / “zoom in to see this layer (min zN)” /
  errors with a **Retry** button; blocked and duplicate rows stay listed with
  an explanation instead of disappearing;
* nothing is requested until a row is switched on (the WFS families also wait
  for their minZoom and then fetch one bbox per settled view, debounced
  400 ms, capped at 1500 features per layer per view);
* popups: English labels + Finnish originals + a KYPPI register link; the
  register popups carry the Antiquities Act 295/1963 note, the ≈ ±50 m
  location-accuracy note and the “point-only sites have no defined extent”
  note;
* attribution per source is rendered on the map while its layer is on;
* choices persist in `localStorage` (`detectlab_finland_layers_v1`).

## 2 · Per-layer status

Verified on **2026-10-17** through the endpoint discovery of this task (every
conclusion below was re-checked live unless marked otherwise; the sandbox
could not fetch images, so *rendering* was verified by response metadata —
content type/size and JSON bodies — and the final visual check belongs to a
browser, see §8).

| # | id | kind | status | why / what is left |
|---|---|---|---|---|
| 1 | `mml-hillshade` | tm35-wmts (canvas) | ⚠ **unverified rendering — wired, direct-first + proxy fallback** | MML WMTS `korkeusmalli_vinovalo`, EPSG:3067/ETRS-TM35FIN. `karttamoottori.maanmittauslaitos.fi` answers **403 “Forbidden”** to every non-browser client probed (capabilities and tiles); plain `<img>` tiles from a real browser may still work (no CORS needed). The layer tries direct tiles first and falls back to the same-origin proxy `/api/geo/finland?src=mml-hillshade` after repeated failures; with `MML_API_KEY` set the proxy can serve the official `avoin-karttakuva` WMTS instead (`src=mml-hillshade-open`). **Needs one browser check** (§8). |
| 2 | `maastokartta` | tm35-wmts (canvas) | ⛔ **degraded — upstream broken** | Museoverkko `GetLayerTile?id=17&layer=maastokartta`: HTTP 500 `{"error":"Problematic response from actual service"}` for every tile variant probed — *its own upstream* is failing, not our request. Fully wired (same TM35FIN machinery), visibly failing in the row with Retry, proxy fallback automatic. Re-check later; the row stays honest. |
| 3 | `hkp-rajat` | mvt (canvas) | ✅ **working (vector data verified; rendering needs a browser)** | MML HKP `GetLayerTile?id=623` — **Mapbox Vector Tiles** on the TM35FIN grid (decoded with `js/finland-tm35.js`, cross-validated against the reference `@mapbox/vector-tile` decoder). Sample tile `x=248&y=316&z=9` contains `KiinteistorajanSijaintitiedot` (boundary lines) at TM35FIN (9, 248, 316). Browser fetch may need the proxy (CORS) — the direct→proxy switch is automatic. |
| 4 | `hkp-tunnukset` | mvt (canvas) | ✅ **working (same caveat)** | HKP `id=819` (z13+): `PalstanSijaintitiedot` (parcels, `kiinteistotunnus` “63040100130000”, display form “630-401-13-0”) + `KiinteistotunnuksenSijaintitiedot` label points. Labels drawn from z15, per the register’s own zoom policy. |
| 5 | `syke-rakennussuojelu-kohde` | wms | ✅ **working** | SYKE `syke_rakennussuojelukohteet` / `Rakennussuojelukohteet`. GetMap in EPSG:3857 verified live (image data returned). Per-tile GetMap like the Albanian layers — plain `<img>`, no CORS involved. Click → GetFeatureInfo popup (JSON, direct→proxy). |
| 6 | `syke-rakennussuojelu-alue` | wms | ✅ **working** | Same service, `Rakennussuojelualueet`. |
| 7–18 | `syke-ps-*` (12) | wms | ✅ **working** | SYKE `inspire_ps` — all 12 published `PS.ProtectedSites*` layers exposed as sub-toggles grouped nature / Natura / built-heritage. GetCapabilities + a rendered EPSG:3857 tile verified live. Two of them (`…LaillaRakennusperinnonSuojelemisestaSuojeltuKohde` + `…Polygons`) are **the same register as #5/#6** (identical extents in both capabilities) → marked `status:'duplicate'`, default off. |
| 19 | `mj-kiinteat-pisteet` | wfs | ✅ **working** | museoverkko `GetWFSFeatures?id=133&srs=EPSG:4326` — verified live, GeoJSON with KYPPI links. Default on. |
| 20 | `mj-kiinteat-alakohteet` | wfs | ✅ **working** | id=134, verified live (sub-sites, richer attrs). |
| 21 | `mj-kiinteat-alueet` | wfs | ✅ **working** | id=135, verified live (Helsinki defence-works polygons). |
| 22 | `mj-mahdolliset-pisteet` | wfs | ✅ **working** | id=142, verified live. |
| 23–24 | `mj-mahdolliset-alakohteet/alueet` | wfs | ◻ **unverified ids** | 143/144 — inferred from the verified {pisteet, alakohteet, alueet} block pattern (142–144); empty in the Helsinki probe box so the table name could not be read from data. `tools/verify-finland-layers.mjs` settles them with one run. |
| 25–27 | `mj-poistetut-*` | wfs | ✅ **working** | 148/149/150, all verified live. |
| 28 | `mj-loytopaikat-pisteet` | wfs | ✅ **working** | id=139, verified live. |
| 29–30 | `mj-loytopaikat-alakohteet/alueet` | wfs | ◻ **unverified ids** | 140/141 — same block-pattern inference (139–141). |
| 31 | `mj-luonnonmuodostumat-pisteet` | wfs | ✅ **working** | id=136, verified live (Northern Ostrobothnia box — empty in the south, that is the data, not the id). |
| 32–33 | `mj-luonnonmuodostumat-alakohteet/alueet` | wfs | ◻ **unverified ids** | 137/138 — block-pattern inference (136–138). |
| 34 | `mj-muut-pisteet` | wfs | ✅ **working** | id=145, verified live (wrecks etc.). |
| 35–36 | `mj-muut-alakohteet/alueet` | wfs | ◻ **unverified ids** | 146/147 — block-pattern inference (145–147). |
| 37 | `mj-havaintokohteet` | wfs | ⛔ **blocked at the source** | ids 130–132: “User doesn’t have permissions for requested layer” (130, 131), “Failed to retrieve features” (132). Museovirasto’s own OGC WFS for these tables needs a **Museoverkko account** (apply: paikkatieto@museovirasto.fi). Row listed, disabled, with the explanation. |
| 38 | `mj-muut-kulttuuriperintokohteet` | wfs | ⛔ **blocked at the source** | ids 153–154: permission-gated the same way. |
| 39 | `mv-rakennusperinto-piste` | wfs | ✅ **working** | id=155 — the protected-buildings register itself (superset of the SYKE “special legislation” layers; Ateneum, Eduskuntatalo, Kansallismuseo verified in the data with `Suojeluvaline`, `Rakennus_nimi`, `Kohde_ID` → KYPPI 130.x links). |
| 40 | `mv-rakennusperinto-alue` | wfs | ✅ **working** | id=156 — protection area delineations (Tarvaspää, Villa Kleineh, Olympiastadion verified). |
| 41 | `aland-fornminnen` | arcgis | ✅ **working** | Åland `Kulturarv/Fornminnen/MapServer` layer 1. REST `/export?bboxSR=3857&f=image` verified live (image metadata returned). Click → `f=geojson` query popup. Default on. |
| 42 | `aland-skyddsomraden` | arcgis | ✅ **working** | layer 0 (Skyddsområden). |
| 43 | `aland-maritima` | arcgis | ✅ **working** | layer 5 (Maritima fornminnen). |
| 44 | `aland-krigstida` | arcgis | ✅ **working** | layer 6 (Krigstida lämningar). |
| 45 | `local-rky-alue` | geojson | ⏸ **needs conversion** | RKY areas — no public live vector service exists (absent from GetWFSFeatures ids; Museovirasto WFS permit-gated), so the Supabase GeoPackage is the only source. Run `node tools/finland-convert-gpkg.mjs` (§6). |
| 46 | `local-rky-piste` | geojson | ⏸ **needs conversion** | RKY points (`rky_piste.gpkg`, the non-INSPIRE variant with the fuller attributes; `rky_inspire_piste.gpkg` is the same geometry in the INSPIRE schema and is **not** exposed separately — dropped as a duplicate). |
| 47 | `local-rky-viiva` | geojson | ⏸ **needs conversion** | RKY lines (`rky_viava.gpkg`). |
| 48 | `local-vark-alue` | geojson | ⏸ **needs conversion** | VARK area delineations. |
| 49 | `local-vark-piste` | geojson | ⏸ **needs conversion** | VARK centroids. |
| 50 | `local-arkeologiset-alakohteet` | geojson | 🔁 **duplicate — disabled** | The register’s sub-sites as one file; the same sub-sites are served live by rows 20/23/29/32/35/26. Off by default, kept for offline use; the conversion report compares counts. |
| 51 | `local-suojellut-alue` | geojson | 🔁 **duplicate — disabled** | Same register as rows 39/40 (live WFS 155/156) and SYKE #5/#6. Dropped per the brief’s rule. |
| 52 | `local-suojellut-piste` | geojson | 🔁 **duplicate — disabled** | Same. |

**Defaults:** hillshade (55%), Natura 2000 SAC, immovable-relics points and
Åland monuments are on when the visitor switches the group on with no prior
choice; everything else is opt-in.

## 3 · Endpoints (what was actually probed)

| source | endpoint | verified fact |
|---|---|---|
| MML WMTS | `https://karttamoottori.maanmittauslaitos.fi/maasto/wmts/1.0.0/korkeusmalli_vinovalo/default/ETRS-TM35FIN/{TileMatrix}/{TileRow}/{TileCol}.png` | 403 “Forbidden” to non-browser clients (caps + tiles). URL order Row-then-Col. |
| MML open WMTS (key) | `https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/korkeusmalli_vinovalo/default/ETRS-TM35FIN/{z}/{row}/{col}.png?apikey=…` | the documented, free self-service key equivalent (`MML_API_KEY`, attached only by the proxy) |
| Museoverkko tiles | `https://kartta.museoverkko.fi/action?action_route=GetLayerTile&id=17&layer=maastokartta&…&TileMatrix={z}&TileCol={col}&TileRow={row}` | HTTP 500 “Problematic response from actual service” (upstream broken). **Col before Row.** |
| MML HKP | `https://hkp.maanmittauslaitos.fi/hkp/action?action_route=GetLayerTile&id={623\|819}&x={col}&y={row}&z={level}` | returns MVT (protobuf), `x=col&y=row&z=level` |
| Museoverkko WFS | `https://kartta.museoverkko.fi/action?action_route=GetWFSFeatures&id={133…156}&srs=EPSG:4326&bbox=w,s,e,n` | GeoJSON with degree coordinates (the response `crs` header wrongly still says 3067 — harmless); ids 130–132/153–154 permission-gated; 129 and 157/158 “Layer not found” |
| SYKE WMS | `https://paikkatiedot.ymparisto.fi/geoserver/{syke_rakennussuojelukohteet\|inspire_ps}/wms` | native EPSG:3067, advertises 3857/4326, GetMap in EPSG:3857 verified live |
| Åland REST | `https://kartor.regeringen.ax/arcgis/rest/services/Kulturarv/Fornminnen/MapServer` | `/export?bbox=…&bboxSR=3857&layers=show:{n}&size=256,256&format=png&transparent=true&f=image` verified live; `/query?f=geojson` for identify; 4 feature layers (0, 1, 5, 6); WMS twin exists (numeric layer ids only, `LAYERS=<title>` is rejected) |
| Supabase GPKG | `https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Finlanda/*.gpkg` | public bucket, not reachable from this checkout’s sandbox — converted by `tools/finland-convert-gpkg.mjs` |
| Museovirasto OGC WFS | (CSW record `83787bc0-…`) | the official “kulttuuriympäristöaineistot” WFS — **requires a Museoverkko account**, so it cannot power the public site; documented as the permission-required equivalent |

The **id→table map** for `GetWFSFeatures` (blocks of three per register
category — pisteet / alakohteet / alueet):

```
133–135 kiinteat_muinaisjaannokset     136–138 luonnonmuodostumat
139–141 loytopaikat                     142–144 mahdolliset_muinaisjaannokset
145–147 muut_kohteet                    148–150 poistetut_kiinteat_muinaisjaannokset
151–152 arkeologiset_hankkeet (piste/alue — not exposed)   155–156 rakennusperinto_suojellut
```

## 4 · Projection (why no proj4 was needed)

Everything Finnish on these services is published in **ETRS-TM35FIN
(EPSG:3067)** — UTM zone 35N on GRS80, central meridian 27°E — on the
TileMatrixSet `ETRS-TM35FIN` (origin −548576 8388608, 256 px tiles,
resolutions 8192/2^level for levels 0–15, rows counted southward). The map is
EPSG:3857 like every other national layer here. `js/finland-tm35.js`
implements the exact bridge:

* **Krüger series** (4th order, the PROJ formulation) `forward`/`inverse` —
  round trip exact to **2.4 µm**; Helsinki (60.171 N, 24.937 E) →
  E 385537.48, N 6672243.27, cross-validated against proj4’s EPSG:3067 to the
  last digit;
* grid helpers (`levelForZoom`, `tileCol/Row`, `tileBounds`, `tilesInBBox`,
  `matrixSize`) whose tile arithmetic reproduces the three sample tiles the
  services answered during discovery (see `tools/verify-finland-layers.mjs`
  §2);
* a **Mapbox Vector Tile decoder** validated against the reference
  `@mapbox/vector-tile` + `vt-pbf` round-trip (geometry and tags byte-equal),
  including the two-pass layer read that vt-pbf’s field ordering requires.

With that, four drawing strategies cover every Finnish kind — the same ones
the repo already uses, no new library:

* **tm35-wmts** (hillshade, maastokartta): each destination tile is drawn on
  a `<canvas>` by mosaicking the source tiles that cover it and warping them
  through an 8×8 affine mesh — the Danish DHM machinery re-pointed at
  EPSG:3067 (`js/dataforsyningen-dhm-layer.js` is the reference);
* **mvt** (HKP cadastral): the TM35FIN source tiles are fetched (up to 3×3
  per destination tile), decoded, and every vertex is projected tile-unit →
  EPSG:3067 metres → WGS84 → destination pixels, then stroked — lines,
  parcel fills and property-ID labels included; click identify uses the
  cached decoded features;
* **wms** (SYKE): per-tile WMS 1.1.1 GetMap with the tile’s own EPSG:3857
  extent (GeoServer reprojects server-side; plain `<img>`, no CORS needed) —
  the Albanian pattern;
* **arcgis** (Åland): the REST `/export` endpoint renders EPSG:3857 tiles
  directly (verified); identify is an `f=geojson` envelope query;
* **wfs / geojson**: EPSG:4326 GeoJSON, no reprojection at all.

## 5 · The proxy (`/api/geo/finland`)

`backend/src/lib/finland-geo.mjs` holds the routing once; the Express route
(`backend/src/routes/finlandProxy.js`, mounted in `backend/src/app.js` next to
`geoProxyRouter`) and the Netlify function (`netlify/functions/finland-geo.mjs`
+ the `netlify.toml` redirect) both call it. Direct requests are **always
tried first** — the proxy is the fallback, never the default, because plain
`<img>` tiles need no CORS and most Finnish endpoints work direct.

| `src` | upstream | validation |
|---|---|---|
| `mml-hillshade` | karttamoottori WMTS REST path | z/col/row checked against the TM35FIN matrix |
| `mml-hillshade-open` | avoin-karttakuva WMTS + `MML_API_KEY` | 401 `mml_api_key_missing` when the env var is absent |
| `museo-tile` | GetLayerTile id=17, fixed params | z/col/row |
| `hkp-tile` | HKP GetLayerTile | id ∈ {623, 819} + z/x/y |
| `museo-wfs` | GetWFSFeatures | id ∈ the public set + a bounded bbox (≤ 5° × 10°) |
| `syke` | paikkatiedot.ymparisto.fi `/geoserver/*` | host + path allowlist, OGC parameter allowlist, credentials stripped |
| `aland` / `aland-query` | kartor.regeringen.ax `/arcgis/{rest/,}services/*` | same |

Images are cached 7 days, JSON 5 minutes; cross-origin/cross-site requests
are rejected; a 15 MB body cap and a 20 s timeout protect the function. The
client switches a layer from direct to proxy automatically after 3
consecutive tile failures, and says so in the row.

**Environment variables** (never in the repo, never in the browser):
`MML_API_KEY` — optional; the free self-service key of the MML
*avoin-karttakuva* service. `FINLAND_PROXY_ALLOWED_ORIGINS` — optional
comma-separated extra origins. `SUPABASE_SERVICE_KEY` — only for the
converter’s `--upload` (§6).

**Official API-key equivalents found** (reported per the brief): the
*avoin-karttakuva* WMTS above (free key, CC BY 4.0); MML’s OGC API Features
(`…/maastotiedot/features/v1`, `…/kiinteisto-avoin/simple-features/v3`); and
Museovirasto’s account-gated OGC WFS (see §3) — none needed for the current
layer set, all documented.

## 6 · Local files (the Supabase GeoPackages)

The bucket `Harti/Finlanda` is not reachable from every development sandbox,
so the conversion is a tool run where it is:

```bash
node tools/finland-convert-gpkg.mjs            # download + inspect + convert
SUPABASE_SERVICE_KEY=… node tools/finland-convert-gpkg.mjs --upload
```

* downloads the GPKGs **read-only** (originals are never touched);
* reads the `.qml` sidecars and writes `<name>.style.json` colour schemes the
  map can apply;
* converts to **EPSG:4326 GeoJSON** with `ogr2ogr` (GDAL) → `data/finland/`;
* writes `data/finland/conversion-report.json` — layer inventory, feature
  counts, large-file warnings (with the exact PMTiles/FGB command to run
  instead if a file exceeds ~8 MB) and the dedup counts against the live
  services;
* `--upload` mirrors the outputs back to the same bucket under
  **`converted/`** (new names — never over the originals). The anon key
  cannot write, so this needs the service key; without it the outputs live in
  the repo (`data/finland/`, served same-origin) — either way the originals
  are untouched. The panel reads the repo copy first and falls back to the
  Supabase mirror.

Dedup decisions (per the brief’s rule) — kept: RKY (areas/points/lines) and
VARK (areas/centroids), because **no public live vector serves them**;
dropped as duplicates (rows stay, disabled): `suojellut_rakennukset_{piste,
alue}` (= live WFS 155/156 + SYKE), `arkeologiset_kohteet_alakohteet_piste`
(= the live sub-site WFS families), and the INSPIRE-schema twins of the RKY
point/line files.

## 7 · Register attribution & wording

* Muinaisjäännösrekisteri / Rakennusperintörekisteri: **“Data: Museovirasto,
  CC BY 4.0”** + the Antiquities Act 295/1963 note (register categories),
  ≈ ±50 m average location accuracy (±15 m for new GPS measurements),
  point-only sites have no defined extent, KYPPI links in every popup
  (`Kohteen_tiedot` from the data; fallback builders `112.<Kohdetunnus>` /
  `130.<Kohde_ID>`).
* MML: “Korkeusmalli © Maanmittauslaitos (CC BY 4.0)” /
  “Kiinteistötietojen karttapalvelu © Maanmittauslaitos”.
* SYKE: “© Suomen ympäristökeskus (SYKE), CC BY 4.0”.
* Åland: “© Ålands landskapsregering, CC BY 4.0”.

## 8 · Verification — what is proven and what needs a browser

Proven in this checkout (all runnable again):

```bash
node -e "console.log(require('./js/finland-tm35.js').selfTest())"
# → ok:true · roundTrip 2.4e-6 m · Helsinki 0.004 m · mvt:true
node tools/verify-finland-layers.mjs     # full endpoint sweep + grid checks
node tools/sync-finland-config.mjs --check
```

* projection + MVT decoder: unit-verified (proj4 cross-check, reference MVT
  encoder round-trip);
* TM35FIN grid: reproduces the discovery tiles exactly;
* URL builders: every layer’s sample request is asserted by the verifier and
  by the jsdom + real-Leaflet harness (SYKE GetMap and Åland export URLs were
  generated through actual `L.TileLayer.getTileUrl`);
* panel: jsdom against the real `index.html` — 5 sections, 52 rows, 11
  sub-sections, swatches, masters, sliders, blocked rows, Retry, language
  rebuild, country filter, localStorage — all pass;
* proxy: validation matrix probed (bad tile indices, bad ids, bad bboxes,
  wrong hosts, cross-origin, missing key → the exact JSON error each time);
  upstream reachability needs a deployed run.

**Not verifiable from this sandbox** (no egress to the Finnish hosts; images
return as opaque payloads to the page-fetcher): actually *seeing* tiles
render. Run once in a browser over Finland:

1. hillshade on at z8–12 — if direct tiles stay blank, confirm the row flips
   to “retrying through the site proxy…” and pixels appear (proxy deploy
   needed for that fallback);
2. cadastral boundaries + property IDs at z15+ (labels appear from z15);
3. one SYKE GetMap layer and the register points over Helsinki (z11+), click
   a monument → KYPPI popup;
4. Åland monuments on at z9 over Mariehamn, click → popup;
5. `node tools/verify-finland-layers.mjs` from a network that reaches the
   Finnish hosts — it settles the six inferred WFS ids and writes
   `tools/finland-verification-report.json`;
6. `node tools/finland-convert-gpkg.mjs` where Supabase is reachable.

## 9 · Files

| file | role |
|---|---|
| `js/finland-tm35.js` | EPSG:3067 maths, TM35FIN grid, MVT decoder, `selfTest()` |
| `js/finland-layers.config.js` | **the single description of every Finnish layer** (52 entries) |
| `js/finland-layers.js` | panel + Leaflet layers (canvas warp, MVT draw, WMS, WFS, ArcGIS, GeoJSON) |
| `js/layer-registry.js` | mirrors `finland.*` entries + the `finland-raster` (z408) / `finland-vector` (z409) panes |
| `js/wms-health.js` | the five Finnish hosts named for the provider-failure reporter |
| `index.html` | the “Finland · Finnish maps” group row + script tags (`?v=20261017-finland`) |
| `js/translations.js` | `finland_group_title` / `finland_group_info` (en/ro/da) |
| `css/styles.css` | `finland-*` panel + popup classes |
| `backend/src/lib/finland-geo.mjs` | the proxy routing (allow-lists, key handling, caches) |
| `backend/src/lib/finland-layers.config.cjs` | vendored config copy for the backend (`tools/sync-finland-config.mjs`) |
| `backend/src/routes/finlandProxy.js` | Express mount (`/api/geo/finland`) |
| `netlify/functions/finland-geo.mjs` + `netlify.toml` | the Netlify twin |
| `tools/finland-convert-gpkg.mjs` | Supabase GPKG → EPSG:4326 GeoJSON (+ QML styles + dedup report + optional upload) |
| `tools/verify-finland-layers.mjs` | the per-layer endpoint verifier |
| `data/finland/` | converter output (created on first run) |
