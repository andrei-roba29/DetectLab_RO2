/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Finland (heritage · cadastral · terrain) data layers · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * Every Finnish layer the map can draw is described HERE and nowhere else.
 * js/finland-layers.js renders the panel rows, builds the Leaflet layers and
 * runs every request from this list; adding, removing, re-labelling or
 * re-zoom-limiting a layer is a change to this file only — no map code has to
 * be touched. js/layer-registry.js mirrors the enabled entries (ids
 * `finland.<id>`) into the shared catalogue for the diagnostics, the 3D
 * status report and the offline audit (tools/audit-wms-layers.mjs).
 *
 * Sources (all verified live on 2026-10-17 unless a `status` says otherwise —
 * see FINLAND_LAYERS.md for the full verification report):
 *
 *   Maanmittauslaitos (MML, National Land Survey of Finland)
 *     • WMTS rasters on the ETRS-TM35FIN TileMatrixSet (EPSG:3067, origin
 *       −548576 8388608, resolutions 8192/2^level, 256 px tiles, levels 0–15).
 *       The brief's karttamoottori tile URLs answer "Forbidden" to every
 *       non-browser client tested (2026-10-17); the browser path is tried
 *       first and a same-origin proxy fallback follows.
 *     • HKP cadastral service — GetLayerTile returns MAPBOX VECTOR TILES
 *       (protobuf, not rasters!) on the same TM35FIN grid, x=TileCol,
 *       y=TileRow, z=TileMatrix. Decoded and reprojected client-side.
 *     • The documented, API-key equivalent of the WMTS is
 *       https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/… with
 *       a free self-service key (env MML_API_KEY on the proxy, never here).
 *
 *   Museovirasto (Finnish Heritage Agency) — kartta.museoverkko.fi (an Oskari
 *     app). The public vector route is
 *       /action?action_route=GetWFSFeatures&id=<layer id>&srs=EPSG:4326&bbox=…
 *     which returns GeoJSON (srs=EPSG:4326 confirmed live; the default is
 *     EPSG:3067 metres). The id→table map below was probed layer by layer:
 *     the 24 Muinaisjäännösrekisteri tables sit in blocks of three
 *     (pisteet / alakohteet / alueet). 18 of the 24 are public; the
 *     havaintokohteet and muut kulttuuriperintökohteet blocks answer
 *     "User doesn't have permissions" (130, 131, 153, 154) or
 *     "Failed to retrieve features" (132) and are listed as blocked.
 *     Museovirasto's own OGC WFS ("kulttuuriympäristöaineistot") requires a
 *     Museoverkko account, so it is NOT usable on a public site.
 *     GetLayerTile (raster tiles, e.g. maastokartta id=17) currently answers
 *     {"error":"Problematic response from actual service"} / HTTP 500 — the
 *     layer is wired up, degrades visibly and retries.
 *
 *   SYKE (Finnish Environment Institute) — paikkatiedot.ymparisto.fi GeoServer
 *     WMS. Native EPSG:3067, but GetMap in EPSG:3857 is confirmed live, so
 *     every tile is a per-tile GetMap on the map's own projection (the same
 *     pattern as the Albanian and Polish layers). GetFeatureInfo-style popups
 *     are not needed: the two services are paired with live WFS for identify.
 *
 *   Ålands landskapsregering — kartor.regeringen.ax (ArcGIS Server 11.5).
 *     The CSW record da0e5eb9-… points at INSPIRE/ALR_Skyddsomraden (WMS,
 *     layer PS.ProtectedSitesArchaeological, CC BY 4.0, EPSG:3067); the
 *     richer Kulturarv/Fornminnen MapServer (Fornminnen, Skyddsområden,
 *     Maritima fornminnen, Krigstida lämningar) is used instead, via its
 *     REST export endpoint which renders EPSG:3857 tiles directly (verified
 *     live) plus f=geojson queries for the click-to-identify popups.
 *     Åland's monuments are NOT in the mainland Muinaisjäännösrekisteri
 *     (the provincial administration keeps its own register), so this layer
 *     adds features rather than duplicating them.
 *
 *   Supabase-hosted GeoPackages (bucket Harti/Finlanda) — cannot be reached
 *     from this checkout's sandbox, so tools/finland-convert-gpkg.mjs
 *     downloads, inspects, reprojects to EPSG:4326 GeoJSON and (optionally)
 *     uploads them back; the "Local files" group reads those conversions.
 *
 * Field reference (every leaf layer carries all of them, `null` where not
 * applicable, so the shape never changes):
 *   id          stable id; the panel row, the registry entry (`finland.<id>`)
 *              and localStorage all use it
 *   title       { fi, en } — Finnish source name + English label (the panel
 *              shows English; the Finnish original rides along in popups)
 *   kind        'tm35-wmts' | 'wms' | 'wfs' | 'mvt' | 'arcgis' | 'geojson'
 *  group        one of the GROUPS ids below (panel section)
 *  subGroup     optional caption inside a section (SYKE families, register
 *              categories)
 *   …service-specific fields documented inline below
 *   minZoom     below this zoom the row shows a "zoom in" hint and nothing
 *              is requested
 *   maxZoom     how far the map may zoom (browser upscaling beyond
 *              maxNativeZoom / maxNativeLevel)
 *   opacity     initial opacity 0–1 (rasters; the hillshade starts at 0.55)
 *   defaultOn   switched on by the group master switch when the visitor has
 *              not chosen yet — nothing is ever requested before a switch
 *   enabled     false → the row is still listed but marked and never drawn
 *              (blocked / duplicate layers stay documented, never silent)
 *  status       'ok' | 'unverified' | 'blocked' | 'degraded' | 'needs-conversion'
 *              | 'duplicate' — what FINLAND_LAYERS.md reports per layer
 *  statusNote   the honest one-liner shown in the row when status ≠ ok
 *  attribution  REQUIRED credit, rendered in the map attribution while on
 *  description  one-paragraph ⓘ popup text (plain text)
 *  popup        { fields: [[fiKey, enLabel], …], link: {field, label} }
 *  style        vector drawing (color, weight, fill, dash, radius, label)
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    /* Node (the registry mirror, the proxy, the audit tool, the tests) gets
     * the very same object, so a layer can never be described twice. */
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) {
        root.FINLAND_LAYERS_CONFIG = api;
        root.FINLAND_LAYERS = api;
    }
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    /* ── shared credits ─────────────────────────────────────────────────── */

    var CC = 'https://creativecommons.org/licenses/by/4.0/';
    var ATTR = {
        mml: 'Korkeusmalli © <a href="https://www.maanmittauslaitos.fi/en" target="_blank" rel="noopener">' +
            'Maanmittauslaitos</a> (CC BY 4.0)',
        mmlCadastral: 'Kiinteistötietojen karttapalvelu © <a href="https://www.maanmittauslaitos.fi/en" ' +
            'target="_blank" rel="noopener">Maanmittauslaitos</a>',
        museoTopo: 'Maastokartta © <a href="https://www.museovirasto.fi/en" target="_blank" rel="noopener">' +
            'Museovirasto</a>, taustakartta © Maanmittauslaitos',
        museo: 'Data: <a href="https://www.museovirasto.fi/en" target="_blank" rel="noopener">Museovirasto</a>, ' +
            'Muinaisjäännösrekisteri (CC BY 4.0)',
        syke: '© <a href="https://www.syke.fi/en-US" target="_blank" rel="noopener">Suomen ympäristökeskus (SYKE)</a> (CC BY 4.0)',
        aland: '© <a href="https://regeringen.ax/ax-kulturmiljo/" target="_blank" rel="noopener">' +
            'Ålands landskapsregering</a> (CC BY 4.0)',
        local: 'Own data (Supabase-hosted Museovirasto/RKY/VARK conversions)'
    };

    /* Finnish attribute names → English popup labels. One map for every
     * Finnish source (Museovirasto, MML HKP). Kept here so the grouping and
     * the translation live in this file only. */
    var FIELD_LABELS = {
        'Kohdetunnus': 'Site ID',
        'Kohde_ID': 'Site ID',
        'Kohdenimi': 'Name',
        'Kunta': 'Municipality',
        'Tyyppi': 'Type',
        'Alatyyppi': 'Subtype',
        'Ajoitus': 'Dating',
        'Ajoitustarkenne': 'Dating detail',
        'Paikannustapa': 'Positioning method',
        'Paikannustarkkuus': 'Positioning accuracy',
        'Alakohde_nimi': 'Sub-site name',
        'Alakohde_ID': 'Sub-site ID',
        'Kohteen_tiedot': 'Register entry',
        'Luotu': 'Created',
        'Muokattu': 'Modified',
        'Suojeluväline': 'Protection instrument',
        'Suojeluvaline': 'Protection instrument',
        'Suojelun_tila': 'Protection status',
        'Rakennus_nimi': 'Building name',
        'Rakennus_ID': 'Building ID',
        'Selite': 'Note',
        'Toimija': 'Actor',
        'Hanke_ID': 'Project ID',
        'Hankkeen_kohde': 'Project target',
        'Hanke_nimi': 'Project name',
        'Hanke_vuosi': 'Project year',
        'Tutkimuslaji': 'Research type',
        'Alue_tyyppi': 'Area type',
        'Alue_selite': 'Area description',
        'kiinteistotunnus': 'Property ID',
        'kiinteistotunnuksenEsitysmuoto': 'Property ID (display)',
        'kiinteistorajalaji': 'Boundary class',
        'lahdeaineisto': 'Source data',
        'id': 'ID'
    };

    /* Popup field order per source family (Finnish key → English label). */
    var POPUP = {
        register: {
            fields: [
                ['Kohdenimi', 'Name'],
                ['Kohdetunnus', 'Site ID'],
                ['Tyyppi', 'Type'],
                ['Alatyyppi', 'Subtype'],
                ['Ajoitus', 'Dating'],
                ['Ajoitustarkenne', 'Dating detail'],
                ['Paikannustapa', 'Positioning method'],
                ['Paikannustarkkuus', 'Positioning accuracy'],
                ['Alakohde_nimi', 'Sub-site name'],
                ['Kunta', 'Municipality']
            ],
            link: { field: 'Kohteen_tiedot', label: 'KYPPI register entry' }
        },
        subsite: {
            fields: [
                ['Alakohde_nimi', 'Sub-site name'],
                ['Kohdenimi', 'Site name'],
                ['Kohdetunnus', 'Site ID'],
                ['Tyyppi', 'Type'],
                ['Alatyyppi', 'Subtype'],
                ['Alakohde_ID', 'Sub-site ID'],
                ['Kunta', 'Municipality']
            ],
            link: { field: 'Kohteen_tiedot', label: 'KYPPI register entry' }
        },
        building: {
            fields: [
                ['Kohdenimi', 'Name'],
                ['Rakennus_nimi', 'Building name'],
                ['Suojeluväline', 'Protection instrument'],
                ['Suojeluvaline', 'Protection instrument'],
                ['Suojelun_tila', 'Protection status'],
                ['Kohde_ID', 'Site ID'],
                ['Rakennus_ID', 'Building ID'],
                ['Selite', 'Note']
            ],
            link: { field: 'Kohteen_tiedot', label: 'KYPPI register entry' }
        },
        cadastral: {
            fields: [
                ['kiinteistotunnuksenEsitysmuoto', 'Property ID'],
                ['kiinteistotunnus', 'Property ID (national format)'],
                ['kiinteistorajalaji', 'Boundary class'],
                ['lahdeaineisto', 'Source data'],
                ['id', 'ID']
            ],
            link: null
        },
        aland: {
            fields: [
                ['NAMN', 'Name'],
                ['KOMMUN', 'Municipality'],
                ['TYP', 'Type'],
                ['DATERING', 'Dating'],
                ['BESKRIVN', 'Description']
            ],
            link: null
        },
        generic: { fields: [], link: null }
    };

    /* KYPPI (Kulttuuriympäristön palveluikkuna) — the register portal. The
     * features already carry full links in Kohteen_tiedot; this is only the
     * fallback builder for datasets that carry a bare Kohdetunnus. */
    var KYPSI_PORTAL = 'https://www.kyppi.fi/palveluikkuna/mjreki/read/asp/r_default.aspx';

    var CONFIG = {
        version: '20261017-finland-v1',

        /* Country this group belongs to. Drives the country filter (rows are
         * shown when Finland is the selected country) and coverage checks. */
        country: 'FI',
        countryBounds: [[59.45, 19.08], [70.09, 31.59]],   /* mainland + Åland */

        /* Only used by the “Go to Finland” button of the group row. */
        view: { center: [60.171, 24.937], zoom: 10, label: { fi: 'Helsinki', en: 'Helsinki' } },

        /* Panel group row. */
        groupLabel: { fi: 'Suomi · Suomen karttatasot', en: 'Finland · Finnish maps' },
        groupInfo: {
            en: 'Finnish national and heritage layers: Maanmittauslaitos LiDAR hillshade and Museovirasto topographic map ' +
                '(reprojected in the browser from the ETRS-TM35FIN grid), the cadastral map with property IDs (vector tiles, ' +
                'reprojected live), Museovirasto’s ancient-monuments register with its eight categories, protected buildings, ' +
                'SYKE’s nature-conservation / Natura 2000 / specially-protected built-heritage sites, the Åland ancient-monuments ' +
                'register, and locally hosted RKY / VARK datasets. Every source is credited on the map while its layer is on. ' +
                'Location accuracy of the monument register is about ±50 m on average (±15 m for new GPS measurements); ' +
                'point-only sites have no defined extent.',
            fi: 'Suomalaisia kansallisia ja kulttuuriperintötasoja: Maanmittauslaitoksen laserkeilausvinovarjostus ja ' +
                'Museoviraston maastokartta (ETRS-TM35FIN-ruudukosta selaimessa uudelleenprojisoituna), kiinteistökartta ' +
                'kiinteistötunnuksineen (vektorilaatoitusa, reprojisoituna), Museoviraston muinaisjäännösrekisteri kahdeksanineen ' +
                'kohderyhmineen, suojellut rakennukset, SYKEn luonnonsuojelu- / Natura 2000- ja erityislailla suojellut kohteet, ' +
                'Ahvenanmaan muinaisjäännösrekisteri sekä paikallisesti isännöidyt RKY- ja VARK-aineistot.'
        },

        /* ── endpoints (documentation + the machinery's defaults) ─────────── */

        endpoints: {
            /* Rasters in EPSG:3067 on the ETRS-TM35FIN TileMatrixSet. */
            mmlWmts: 'https://karttamoottori.maanmittauslaitos.fi/maasto/wmts/1.0.0',
            /* Official, documented, API-key WMTS (free self-service key):
             * the proxy uses it when MML_API_KEY is configured. */
            mmlOpenWmts: 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0',
            museoTiles: 'https://kartta.museoverkko.fi/action',
            hkpTiles: 'https://hkp.maanmittauslaitos.fi/hkp/action',
            museoWfs: 'https://kartta.museoverkko.fi/action',
            sykeBuilt: 'https://paikkatiedot.ymparisto.fi/geoserver/syke_rakennussuojelukohteet/wms',
            sykeBuiltWfs: 'https://paikkatiedot.ymparisto.fi/geoserver/syke_rakennussuojelukohteet/wfs',
            sykeInspire: 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_ps/wms',
            sykeInspireWfs: 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_ps/wfs',
            alandRest: 'https://kartor.regeringen.ax/arcgis/rest/services',
            alandWms: 'https://kartor.regeringen.ax/arcgis/services/Kulturarv/Fornminnen/MapServer/WMSServer',
            alandCswRecord: 'https://www.paikkatietohakemisto.fi/geonetwork/srv/fin/csw?elementSetName=full' +
                '&id=da0e5eb9-029a-4d9f-96a6-a7b4a5dc7c3d&outputSchema=http://www.isotc211.org/2005/gmd' +
                '&Request=GetRecordById&service=CSW&version=2.0.2',
            supabase: 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Finlanda/',
            localBase: 'data/finland/',
            capabilities: {
                sykeBuilt: 'https://paikkatiedot.ymparisto.fi/geoserver/syke_rakennussuojelukohteet/wms?request=GetCapabilities&service=WMS',
                sykeInspire: 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_ps/wms?request=GetCapabilities&service=WMS',
                aland: 'https://kartor.regeringen.ax/arcgis/services/Kulturarv/Fornminnen/MapServer/WMSServer?request=GetCapabilities&service=WMS'
            },
            nativeCrs: 'EPSG:3067',
            nativeTileMatrixSet: 'ETRS-TM35FIN',
            /* The permit-gated official alternative — documented, not used. */
            museoOfficialWfs: 'Museoviraston kulttuuriympäristöaineistot WFS — requires a Museoverkko ' +
                'account / separate permission (paikkatieto@museovirasto.fi); not usable on a public site.'
        },

        /* Same-origin proxy (Netlify function / Express route) used when a
         * direct browser request is blocked (CORS or referrer). Direct is
         * always tried first; the proxy is the fallback, never the default. */
        proxy: {
            path: '/api/geo/finland',
            sources: ['mml-hillshade', 'mml-hillshade-open', 'museo-tile', 'hkp-tile',
                'museo-wfs', 'syke', 'aland', 'aland-query']
        },

        /* ── panel sections ──────────────────────────────────────────────── */

        GROUPS: [
            { id: 'terrain', label: { fi: 'Maasto ja terreeni', en: 'Terrain' } },
            { id: 'cadastral', label: { fi: 'Kiinteistöt', en: 'Cadastral' } },
            { id: 'protected', label: { fi: 'Suojellut kohteet', en: 'Protected sites' } },
            { id: 'aland', label: { fi: 'Ahvenanmaa', en: 'Åland' } },
            { id: 'local', label: { fi: 'Paikalliset aineistot (Supabase)', en: 'Local files (Supabase)' } }
        ],

        /* The register categories, in the panel order requested by the brief.
 * Each drives a collapsible sub-section with a legend swatch. */
        REGISTER_CATEGORIES: [
            { id: 'kiiteat', table: 'kiinteat_muinaisjaannokset', label: { fi: 'Kiinteät muinaisjäännökset', en: 'Immovable ancient relics' }, color: '#e01b24', note: { en: 'Protected fixed ancient monuments under the Antiquities Act 295/1963. Points for all sites; some also have digitised area delineations; sub-sites carry the site type detail.' } },
            { id: 'mahdolliset', table: 'mahdolliset_muinaisjaannokset', label: { fi: 'Mahdolliset muinaisjäännökset', en: 'Possible ancient relics' }, color: '#f39c1b', note: null },
            { id: 'poistetut', table: 'poistetut_kiinteat_muinaisjaannokset', label: { fi: 'Poistetut kiinteät muinaisjäännökset', en: 'Removed immovable ancient relics' }, color: '#9aa0a6', note: { en: 'Deregistered sites — not protected any more.' } },
            { id: 'loytopaikat', table: 'loytopaikat', label: { fi: 'Löytöpaikat', en: 'Places of discovery' }, color: '#17a2a2', note: null },
            { id: 'havainnot', table: 'havaintokohteet', label: { fi: 'Havaintokohteet', en: 'Observation sites / targets / objects' }, color: '#6b8fb3', blocked: true },
            { id: 'luonnonmuodostumat', table: 'luonnonmuodostumat', label: { fi: 'Luonnonmuodostumat', en: 'Natural formations' }, color: '#3e9e4f', note: null },
            { id: 'muut_kulttuuri', table: 'muut_kulttuuriperintokohteet', label: { fi: 'Muut kulttuuriperintökohteet', en: 'Other cultural heritage sites' }, color: '#b36b4b', blocked: true },
            { id: 'muut', table: 'muut_kohteet', label: { fi: 'Muut kohteet', en: 'Other items / other destinations' }, color: '#8b6fc9', note: { en: 'Wrecks, jetties and other registered items outside the protected categories.' } }
        ],

        providers: {
            mml: 'Maanmittauslaitos (National Land Survey of Finland)',
            museo: 'Museovirasto (Finnish Heritage Agency)',
            syke: 'Suomen ympäristökeskus (SYKE, Finnish Environment Institute)',
            aland: 'Ålands landskapsregering',
            own: 'Own data (Supabase)'
        },

        licence: 'CC BY 4.0 (MML/Museovirasto/SYKE/Åland open data); MML cadastral service terms; own data',

        attribution: 'Data: Museovirasto (CC BY 4.0), Maanmittauslaitos, SYKE, Ålands landskapsregering',

        fieldLabels: FIELD_LABELS,
        popup: POPUP,
        kyppiPortal: KYPSI_PORTAL,

        /** @type {Array} */ layers: [

            /* ══════════════════════════════════════════════════════════════
             * A · TERRAIN
             * ══════════════════════════════════════════════════════════════ */

            {
                /* 1. LiDAR hillshade — Maanmittauslaitos WMTS (EPSG:3067,
                 * ETRS-TM35FIN grid), reprojected per tile on a canvas like
                 * the Danish DHM layer. karttamoottori answers "Forbidden"
                 * to non-browser clients, so: direct tiles first (plain
                 * <img> needs no CORS), proxy fallback after repeated tile
                 * errors, and the proxy switches to the official
                 * avoin-karttakuva WMTS when MML_API_KEY is configured. */
                id: 'mml-hillshade',
                title: { fi: 'Maanmittauslaitos · korkeusmalli_vinovalo (laserkeilaus)', en: 'Finland · MML LiDAR hillshade' },
                kind: 'tm35-wmts',
                group: 'terrain',
                urlTemplate: 'https://karttamoottori.maanmittauslaitos.fi/maasto/wmts/1.0.0/' +
                    'korkeusmalli_vinovalo/default/ETRS-TM35FIN/{z}/{row}/{col}.png',
                proxySrc: 'mml-hillshade',
                openProxySrc: 'mml-hillshade-open',   /* + MML_API_KEY server-side */
                format: 'image/png',
                transparent: true,
                minZoom: 5,
                maxZoom: 20,
                maxNativeLevel: 15,        /* TM35FIN level 15 = 0.25 m/px */
                opacity: 0.55,
                defaultOn: true,
                enabled: true,
                status: 'unverified',
                statusNote: 'karttamoottori answers “Forbidden” to every non-browser client tested; ' +
                    'the browser path is tried first and the same-origin proxy (/api/geo/finland) takes over on errors — ' +
                    'with MML_API_KEY set the proxy uses the official avoin-karttakuva WMTS instead.',
                attribution: ATTR.mml,
                attributionRow: 'Korkeusmalli © Maanmittauslaitos (CC BY 4.0)',
                description: 'Hillshade of the national airborne laser scanning elevation model, streamed live from ' +
                    'Maanmittauslaitos’ WMTS as an overlay (default opacity 55%). The service publishes the national ' +
                    'ETRS-TM35FIN grid (EPSG:3067), not Web Mercator, so every tile is reprojected onto a canvas in the ' +
                    'browser — the relief therefore lines up with the basemap to well under a pixel. Free open data, CC BY 4.0.',
                notes: 'TM35FIN grid; REST template order is {z}/{TileRow}/{TileCol}.'
            },
            {
                /* 2. Topographic map — Museovirasto museoverkko WMTS proxy
                 * (id=17, layer=maastokartta). Captured live from the app,
                 * but the route currently answers HTTP 500 with
                 * {"error":"Problematic response from actual service"} — its
                 * own upstream (MML) is failing for foreign/server requests.
                 * Wired, visibly degraded, retried, proxy-fallbackable. */
                id: 'maastokartta',
                title: { fi: 'Maastokartta (Museoviraston museoverkko)', en: 'Finland · topographic map (maastokartta)' },
                kind: 'tm35-wmts',
                group: 'terrain',
                urlTemplate: 'https://kartta.museoverkko.fi/action?action_route=GetLayerTile&id=17' +
                    '&layer=maastokartta&style=default&tilematrixset=ETRS-TM35FIN&Service=WMTS&Request=GetTile' +
                    '&Version=1.0.0&Format=image%2Fpng&TileMatrix={z}&TileCol={col}&TileRow={row}',
                proxySrc: 'museo-tile',
                format: 'image/png',
                transparent: false,
                minZoom: 5,
                maxZoom: 20,
                maxNativeLevel: 15,
                opacity: 1,
                defaultOn: false,
                enabled: true,
                status: 'degraded',
                statusNote: 'The service answers HTTP 500 (“Problematic response from actual service”) for every ' +
                    'tile tested on 2026-10-17 — its upstream is failing. The layer is fully wired (same TM35FIN ' +
                    'machinery as the hillshade), shows the failure in its row and retries; the /api/geo/finland ' +
                    'proxy takes over automatically when a server-side fetch succeeds.',
                attribution: ATTR.museoTopo,
                attributionRow: 'Maastokartta © Museovirasto; taustakartta © Maanmittauslaitos',
                description: 'Museovirasto’s copy of the Maanmittauslaitos 1:20k/1:50k topographic map, served as ' +
                    'WMTS tiles on the national ETRS-TM35FIN grid and reprojected per tile in the browser like the ' +
                    'LiDAR hillshade. Use it as an alternate base map under the heritage overlays.',
                notes: 'Sample tile: TileMatrix=11&TileCol=991&TileRow=1158 → TM35FIN tile (11, col 991, row 1158) ≈ 64.94 N 26.30 E (Lapland), which is how the grid was confirmed.'
            },

            /* ══════════════════════════════════════════════════════════════
             * B · CADASTRAL (MML HKP — Mapbox Vector Tiles, EPSG:3067 grid)
             * ══════════════════════════════════════════════════════════════ */

            {
                /* 3. Cadastral boundaries — hkp id=623 returns MVT whose
                 * layers include KiinteistorajanSijaintitiedot (boundary
                 * lines). Drawn onto canvas tiles after reprojecting every
                 * vertex from the TM35FIN tile to the mercator tile. */
                id: 'hkp-rajat',
                title: { fi: 'Kiinteistörajat (MML kiinteistötietojen karttapalvelu)', en: 'Finland · cadastral boundaries' },
                kind: 'mvt',
                group: 'cadastral',
                hkpId: 623,
                layerNames: ['KiinteistorajanSijaintitiedot'],
                style: { color: '#ffd24d', weight: 2, dash: null, fill: false },
                minZoom: 12,
                maxZoom: 20,
                opacity: 1,
                defaultOn: false,
                enabled: true,
                status: 'ok',
                attribution: ATTR.mmlCadastral,
                attributionRow: 'Kiinteistötietojen karttapalvelu © Maanmittauslaitos',
                popup: POPUP.cadastral,
                description: 'Parcel and registered-unit boundary lines from Maanmittauslaitos’ cadastral map service. ' +
                    'The HKP endpoint serves Mapbox Vector Tiles on the ETRS-TM35FIN grid; they are decoded and reprojected ' +
                    'in the browser, so the lines stay crisp at every zoom. Click a parcel for its property identifier.',
                notes: 'Sample tile ?id=623&x=248&y=316&z=9 decodes to protobuf layer KiinteistorajanSijaintitiedot at TM35FIN (9, 248, 316) ≈ 64.8 N 28.0 E.'
            },
            {
                /* 4. Property IDs — hkp id=819 (PalstanSijaintitiedot parcels
                 * + KiinteistotunnuksenSijaintitiedot label points with
                 * kiinteistotunnus / kiinteistotunnuksenEsitysmuoto, e.g.
                 * “630-401-13-0”). Labels only exist at high zoom. */
                id: 'hkp-tunnukset',
                title: { fi: 'Kiinteistötunnukset (rekisteritunnus kartalla)', en: 'Finland · property IDs (labels)' },
                kind: 'mvt',
                group: 'cadastral',
                hkpId: 819,
                layerNames: ['PalstanSijaintitiedot', 'KiinteistotunnuksenSijaintitiedot'],
                labelField: 'kiinteistotunnuksenEsitysmuoto',
                labelFallbackField: 'kiinteistotunnus',
                style: { color: '#ffd24d', weight: 1, fill: true, fillColor: '#ffd24d', fillOpacity: 0.06 },
                labelStyle: { color: '#fff2c4', font: '11px sans-serif', stroke: 'rgba(0,0,0,0.85)' },
                minZoom: 15,
                maxZoom: 20,
                opacity: 1,
                defaultOn: false,
                enabled: true,
                status: 'ok',
                attribution: ATTR.mmlCadastral,
                attributionRow: 'Kiinteistötietojen karttapalvelu © Maanmittauslaitos',
                popup: POPUP.cadastral,
                description: 'Property identifiers (kiinteistotunnus, e.g. 630-401-13-0) drawn on the parcels they ' +
                    'belong to, from the cadastral map service’s vector tiles. The register only labels from high zoom — ' +
                    'the row asks you to zoom in below z15.',
                notes: 'Sample tile ?id=819&x=4019&y=5032&z=13 contains PalstanSijaintitiedot with kiinteistotunnus “63040100130000” and display form “630-401-13-0”.'
            },

            /* ══════════════════════════════════════════════════════════════
             * C · PROTECTED SITES
             * ══════════════════════════════════════════════════════════════ */

            /* C.5 — Built heritage objects (special legislation), SYKE. */
            {
                id: 'syke-rakennussuojelu-kohde',
                title: { fi: 'Suojellut rakennusperintökohteet (erityislait) — pisteet', en: 'Finland · protected built heritage, sites (SYKE)' },
                kind: 'wms',
                group: 'protected',
                subGroup: 'built',
                service: 'sykeBuilt',
                layers: 'Rakennussuojelukohteet',
                version: '1.1.1',
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: true,
                minZoom: 8,
                maxZoom: 20,
                maxNativeZoom: 18,
                opacity: 1,
                defaultOn: false,
                enabled: true,
                status: 'ok',
                attribution: ATTR.syke,
                attributionRow: 'Rakennussuojelukohteet © SYKE (CC BY 4.0)',
                description: 'Buildings protected under special legislation (the Building Protection Act, the Church Act, ' +
                    'the Orthodox Church Act and the decree on state-owned buildings), as maintained by the ELY Centres and ' +
                    'published by SYKE. Rendered as per-tile WMS GetMap in the map’s own projection; click a site and the ' +
                    'matching live WFS features are fetched for the popup.',
                notes: 'GetMap in EPSG:3857 verified live 2026-10-17 (server answers image/png). Native EPSG:3067.'
            },
            {
                id: 'syke-rakennussuojelu-alue',
                title: { fi: 'Suojellut rakennusperintökohteet (erityislait) — alueet', en: 'Finland · protected built heritage, areas (SYKE)' },
                kind: 'wms',
                group: 'protected',
                subGroup: 'built',
                service: 'sykeBuilt',
                layers: 'Rakennussuojelualueet',
                version: '1.1.1',
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: true,
                minZoom: 8,
                maxZoom: 20,
                maxNativeZoom: 18,
                opacity: 1,
                defaultOn: false,
                enabled: true,
                status: 'ok',
                attribution: ATTR.syke,
                attributionRow: 'Rakennussuojelualueet © SYKE (CC BY 4.0)',
                description: 'Area delineations of the specially-protected built-heritage sites (same register as the ' +
                    'site layer; some protections are drawn as areas rather than points).',
                notes: null
            },

            /* C.6 — Nature protected areas, Natura 2000 and protected built
             * heritage (INSPIRE), SYKE. All 12 published sublayers exposed. */
            {
                id: 'syke-ps-eramaa',
                title: { fi: 'Erämaa-alueet', en: 'Finland · wilderness areas (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-nature', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesEramaaAlueEramaa', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Erämaa-alueet © SYKE (CC BY 4.0)',
                description: 'The twelve official wilderness-reserve areas (erämaa-alueet) established by the Wilderness Act.',
                notes: null
            },
            {
                id: 'syke-ps-valtion-luonnonsuojelu',
                title: { fi: 'Valtion omistamat luonnonsuojelualueet', en: 'Finland · state-owned nature conservation areas (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-nature', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesValtionOmistamaLuonnonsuojelualue', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Luonnonsuojelualueet © SYKE (CC BY 4.0)',
                description: 'Nature conservation areas on state-owned land (national parks, strict nature reserves and other state reserves).',
                notes: null
            },
            {
                id: 'syke-ps-yksityismaiden-luonnonsuojelu',
                title: { fi: 'Yksityisten mailla olevat luonnonsuojelualueet', en: 'Finland · private-land nature conservation areas (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-nature', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesYksityistenMaillaOlevaLuonnonsuojelualue', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Luonnonsuojelualueet © SYKE (CC BY 4.0)',
                description: 'Nature conservation areas established on private land (e.g. private nature reserves and conservation agreements).',
                notes: null
            },
            {
                id: 'syke-ps-natura-sci',
                title: { fi: 'Natura 2000 · ehdotetut SCI-alueet', en: 'Finland · Natura 2000 proposed Sites of Community Importance (SYKE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-natura', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesProposedSiteOfCommunityImportance', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Natura 2000 © SYKE (CC BY 4.0)',
                description: 'Natura 2000 areas proposed as Sites of Community Importance (pSCI) under the Habitats Directive.',
                notes: null
            },
            {
                id: 'syke-ps-natura-sac',
                title: { fi: 'Natura 2000 · SAC-alueet', en: 'Finland · Natura 2000 Special Areas of Conservation (SYKE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-natura', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesSpecialAreaOfConservation', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: true, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Natura 2000 © SYKE (CC BY 4.0)',
                description: 'Natura 2000 Special Areas of Conservation (SAC, Habitats Directive) — the core habitat-protection network.',
                notes: 'GetMap verified live 2026-10-17 (fetch of a 256 px EPSG:3857 tile returns image data).'
            },
            {
                id: 'syke-ps-natura-spa',
                title: { fi: 'Natura 2000 · SPA-alueet', en: 'Finland · Natura 2000 Special Protection Areas (SYKE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-natura', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesSpecialProtectionArea', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 5, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Natura 2000 © SYKE (CC BY 4.0)',
                description: 'Natura 2000 Special Protection Areas (SPA, Birds Directive).',
                notes: null
            },
            {
                id: 'syke-ps-asetus-valtion',
                title: { fi: 'Asetus valtion omistamien rakennusten suojelusta · pisteet', en: 'Finland · state-owned protected buildings, sites (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesAsetusValtionOmistamienRakennustenSuojelusta', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'State-owned buildings protected by decree (Asetus valtion omistamien rakennusten suojelusta, e.g. decree 480/85).',
                notes: null
            },
            {
                id: 'syke-ps-asetus-valtion-alue',
                title: { fi: 'Asetus valtion omistamien rakennusten suojelusta · alueet', en: 'Finland · state-owned protected buildings, areas (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesAsetusValtionOmistamienRakennustenSuojelustaPolygons', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'Area delineations of the decree-protected state-owned buildings.',
                notes: null
            },
            {
                id: 'syke-ps-kirkkolaki',
                title: { fi: 'Kirkkolailla suojellut kohteet', en: 'Finland · Church Act protected sites (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesKirkkolaillaSuojellutKohteet', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'Buildings and church sites protected under the Church Act (kirkkolaki).',
                notes: null
            },
            {
                id: 'syke-ps-ortodoksikirkko',
                title: { fi: 'Lailla ortodoksisesta kirkosta suojellut kohteet', en: 'Finland · Orthodox Church Act protected sites (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesLaillaOrtodoksisestaKirkoistaSuojellutKohteet', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'Buildings protected under the Act on the Orthodox Church.',
                notes: null
            },
            {
                id: 'syke-ps-rakennusperintolaki',
                title: { fi: 'Rakennussuojelulain kohteet · pisteet', en: 'Finland · Building Protection Act sites (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesLaillaRakennusperinnonSuojelemisestaSuojeltuKohde', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'duplicate',
                statusNote: 'Same register as “protected built heritage, sites (SYKE)” above — both services publish ' +
                    'the Building Protection Act layer. Off by default; switch one of the two, not both.',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'Buildings protected under the Building Protection Act (laki rakennusperinnön suojelemisesta), ' +
                    'published both by this INSPIRE service and by the dedicated Rakennussuojelukohteet service — this copy ' +
                    'is the same data.',
                notes: 'Extents of this layer and syke-rakennussuojelu-kohde are identical in both capabilities docs.'
            },
            {
                id: 'syke-ps-rakennusperintolaki-alue',
                title: { fi: 'Rakennussuojelulain kohteet · alueet', en: 'Finland · Building Protection Act areas (SYKE INSPIRE)' },
                kind: 'wms', group: 'protected', subGroup: 'inspire-built', service: 'sykeInspire',
                layers: 'PS.ProtectedSitesLaillaRakennusperinnonSuojelemisestaSuojeltuKohdePolygons', version: '1.1.1', crs: 'EPSG:3857',
                format: 'image/png', transparent: true, minZoom: 8, maxZoom: 20, maxNativeZoom: 18,
                opacity: 1, defaultOn: false, enabled: true, status: 'duplicate',
                statusNote: 'Same register as “protected built heritage, areas (SYKE)” above.',
                attribution: ATTR.syke, attributionRow: 'Suojellut rakennukset © SYKE (CC BY 4.0)',
                description: 'Area delineations of Building Protection Act sites — the same data the dedicated ' +
                    'Rakennussuojelualueet service publishes.',
                notes: null
            },

            /* C.7/C.8 — Muinaisjäännösrekisteri via museoverkko GetWFSFeatures.
             * One entry per geometry table; subGroup = the register category.
             * ids 133–135, 136–138, 139–141, 142–144, 145–147, 148–150 are
             * blocks of {pisteet, alakohteet, alueet}; the last two
             * categories are blocked on the public route (documented below). */

            {
                id: 'mj-kiinteat-pisteet',
                title: { fi: 'Kiinteät muinaisjäännökset · pisteet', en: 'Immovable ancient relics · points' },
                kind: 'wfs', group: 'protected', subGroup: 'kiiteat',
                wfsId: 133, table: 'kiinteat_muinaisjaannokset_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: true, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'All fixed ancient monuments protected under the Antiquities Act (muinaismuistolaki 295/1963) — ' +
                    'the core of the Muinaisjäännösrekisteri. Points exist for every registered site; location accuracy is ' +
                    'about ±50 m on average (±15 m for new GPS measurements).',
                notes: 'Verified live 2026-10-17: GeoJSON in EPSG:4326 with KYPPI links per feature.'
            },
            {
                id: 'mj-kiinteat-alakohteet',
                title: { fi: 'Kiinteät muinaisjäännökset · alakohteet', en: 'Immovable ancient relics · sub-sites' },
                kind: 'wfs', group: 'protected', subGroup: 'kiiteat',
                wfsId: 134, table: 'kiinteat_muinaisjaannokset_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Sub-sites of the protected monuments (a single monument can hold several named sub-sites with ' +
                    'their own types). Shown from z12 because dense urban areas carry thousands of them.',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-kiinteat-alueet',
                title: { fi: 'Kiinteät muinaisjäännökset · aluerajaukset', en: 'Immovable ancient relics · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'kiiteat',
                wfsId: 135, table: 'kiinteat_muinaisjaannokset_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Digitised area delineations of protected monuments (only some monuments have an area; ' +
                    'point-only sites have no defined extent).',
                notes: 'Verified live 2026-10-17 (Helsinki WWI defence works).'
            },
            {
                id: 'mj-mahdolliset-pisteet',
                title: { fi: 'Mahdolliset muinaisjäännökset · pisteet', en: 'Possible ancient relics · points' },
                kind: 'wfs', group: 'protected', subGroup: 'mahdolliset',
                wfsId: 142, table: 'mahdolliset_muinaisjaannokset_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Sites suspected to be ancient monuments — protected until investigated, but not confirmed.',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-mahdolliset-alakohteet',
                title: { fi: 'Mahdolliset muinaisjäännökset · alakohteet', en: 'Possible ancient relics · sub-sites' },
                kind: 'wfs', group: 'protected', subGroup: 'mahdolliset',
                wfsId: 143, table: 'mahdolliset_muinaisjaannokset_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Sub-sites of the suspected monuments.',
                notes: 'id inferred from the verified {pisteet, alakohteet, alueet} block pattern (142–144); empty in the Helsinki probe box, so the table name is confirmed only by the pattern — tools/verify-finland-layers.mjs settles it.'
            },
            {
                id: 'mj-mahdolliset-alueet',
                title: { fi: 'Mahdolliset muinaisjäännökset · aluerajaukset', en: 'Possible ancient relics · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'mahdolliset',
                wfsId: 144, table: 'mahdolliset_muinaisjaannokset_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Area delineations of suspected monuments.',
                notes: 'id inferred from the block pattern (142–144); see tools/verify-finland-layers.mjs.'
            },
            {
                id: 'mj-poistetut-pisteet',
                title: { fi: 'Poistetut kiinteät muinaisjäännökset · pisteet', en: 'Removed immovable ancient relics · points' },
                kind: 'wfs', group: 'protected', subGroup: 'poistetut',
                wfsId: 148, table: 'poistetut_kiinteat_muinaisjaannokset_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Monuments that were deregistered (usually because investigation showed nothing protected ' +
                    'remains). Drawn greyed out.',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-poistetut-alakohteet',
                title: { fi: 'Poistetut kiinteät muinaisjäännökset · alakohteet', en: 'Removed immovable ancient relics · sub-sites' },
                kind: 'wfs', group: 'protected', subGroup: 'poistetut',
                wfsId: 149, table: 'poistetut_kiinteat_muinaisjaannokset_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Sub-sites of the deregistered monuments.',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-poistetut-alueet',
                title: { fi: 'Poistetut kiinteät muinaisjäännökset · aluerajaukset', en: 'Removed immovable ancient relics · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'poistetut',
                wfsId: 150, table: 'poistetut_kiinteat_muinaisjaannokset_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Area delineations of deregistered monuments (the brief’s original id=151 example turned out ' +
                    'to be project areas — the real table is id=150).',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-loytopaikat-pisteet',
                title: { fi: 'Löytöpaikat · pisteet', en: 'Places of discovery · points' },
                kind: 'wfs', group: 'protected', subGroup: 'loytopaikat',
                wfsId: 139, table: 'loytopaikat_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Find spots — places where artefacts or stray finds were made (loose finds, wrecks, ballast sites).',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-loytopaikat-alakohteet',
                title: { fi: 'Löytöpaikat · alakohteet', en: 'Places of discovery · sub-sites' },
                kind: 'wfs', group: 'protected', subGroup: 'loytopaikat',
                wfsId: 140, table: 'loytopaikat_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Individual find contexts within the find spots.',
                notes: 'id inferred from the block pattern (139–141).'
            },
            {
                id: 'mj-loytopaikat-alueet',
                title: { fi: 'Löytöpaikat · aluerajaukset', en: 'Places of discovery · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'loytopaikat',
                wfsId: 141, table: 'loytopaikat_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Area delineations of find spots.',
                notes: 'id inferred from the block pattern (139–141).'
            },
            {
                id: 'mj-luonnonmuodostumat-pisteet',
                title: { fi: 'Luonnonmuodostumat · pisteet', en: 'Natural formations · points' },
                kind: 'wfs', group: 'protected', subGroup: 'luonnonmuodostumat',
                wfsId: 136, table: 'luonnonmuodostumat_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Natural formations recorded in the register (sacred stones, giant’s kettles and related ' +
                    'landscape features).',
                notes: 'Verified live 2026-10-17 (Northern Ostrobothnia box).'
            },
            {
                id: 'mj-luonnonmuodostumat-alakohteet',
                title: { fi: 'Luonnonmuodostumat · alakohteet', en: 'Natural formations · sub-sites' },
                kind: 'wfs', group: 'protected', subGroup: 'luonnonmuodostumat',
                wfsId: 137, table: 'luonnonmuodostumat_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Sub-sites of the recorded natural formations.',
                notes: 'id inferred from the block pattern (136–138).'
            },
            {
                id: 'mj-luonnonmuodostumat-alueet',
                title: { fi: 'Luonnonmuodostumat · aluerajaukset', en: 'Natural formations · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'luonnonmuodostumat',
                wfsId: 138, table: 'luonnonmuodostumat_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Area delineations of the recorded natural formations.',
                notes: 'id inferred from the block pattern (136–138).'
            },
            {
                id: 'mj-muut-pisteet',
                title: { fi: 'Muut kohteet · pisteet', en: 'Other items · points' },
                kind: 'wfs', group: 'protected', subGroup: 'muut',
                wfsId: 145, table: 'muut_kohteet_pisteet', geom: 'point',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Other registered items — mostly wrecks, jetties and harbour structures outside the ' +
                    'protected categories.',
                notes: 'Verified live 2026-10-17.'
            },
            {
                id: 'mj-muut-alakohteet',
                title: { fi: 'Muut kohteet · alakohteet', en: 'Other items · sub-items' },
                kind: 'wfs', group: 'protected', subGroup: 'muut',
                wfsId: 146, table: 'muut_kohteet_alakohteet', geom: 'point',
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.subsite,
                description: 'Sub-items of the other registered items.',
                notes: 'id inferred from the block pattern (145–147).'
            },
            {
                id: 'mj-muut-alueet',
                title: { fi: 'Muut kohteet · aluerajaukset', en: 'Other items · areas' },
                kind: 'wfs', group: 'protected', subGroup: 'muut',
                wfsId: 147, table: 'muut_kohteet_alueet', geom: 'polygon',
                minZoom: 9, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'unverified',
                verified: false,
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Area delineations of the other registered items.',
                notes: 'id inferred from the block pattern (145–147).'
            },

            /* The two register categories that are NOT public on
             * GetWFSFeatures — listed, explained, never silently dropped. */
            {
                id: 'mj-havaintokohteet',
                title: { fi: 'Havaintokohteet (ei julkinen rajapinnassa)', en: 'Observation sites / targets / objects (blocked)' },
                kind: 'wfs', group: 'protected', subGroup: 'havainnot',
                wfsId: 130, table: 'havaintokohteet', geom: 'mixed',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: false, status: 'blocked',
                statusNote: 'ids 130–132 of the public route are not accessible: 130 and 131 answer ' +
                    '“User doesn’t have permissions for requested layer”, 132 answers “Failed to retrieve features”. ' +
                    'Museovirasto’s own OGC WFS for these tables needs a Museoverkko account. Ask ' +
                    'paikkatieto@museovirasto.fi if you need them.',
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Observation targets/objects recorded in the register. Not reachable through the public ' +
                    'browser route — see the status note.',
                notes: 'Probed 2026-10-17.'
            },
            {
                id: 'mj-muut-kulttuuriperintokohteet',
                title: { fi: 'Muut kulttuuriperintökohteet (ei julkisia rajapinnassa)', en: 'Other cultural heritage sites (blocked)' },
                kind: 'wfs', group: 'protected', subGroup: 'muut_kulttuuri',
                wfsId: 153, table: 'muut_kulttuuriperintokohteet', geom: 'mixed',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: false, status: 'blocked',
                statusNote: 'ids 153–154 of the public route answer “User doesn’t have permissions for requested layer”. ' +
                    'Museovirasto’s own OGC WFS needs a Museoverkko account. Ask paikkatieto@museovirasto.fi.',
                attribution: ATTR.museo, attributionRow: 'Muinaisjäännösrekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.register,
                description: 'Other cultural-heritage sites in the register (e.g. recent-history sites). Not reachable ' +
                    'through the public browser route — see the status note.',
                notes: 'Probed 2026-10-17.'
            },

            /* Bonus (needed for the Supabase comparison): the protected-
             * buildings register itself, live. id 155 points + 156 areas. */
            {
                id: 'mv-rakennusperinto-piste',
                title: { fi: 'Rakennusperintörekisteri · suojellut rakennukset (pisteet)', en: 'Finland · protected buildings register, sites (Museovirasto)' },
                kind: 'wfs', group: 'protected', subGroup: 'rakennusperinto',
                wfsId: 155, table: 'rakennusperinto_suojellut_piste', geom: 'point',
                minZoom: 11, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Rakennusperintörekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.building,
                description: 'The Museovirasto protected-buildings register itself — every protection instrument ' +
                    '(decrees, the Church and Orthodox Church Acts, the railway agreement, the Building Protection Act), ' +
                    'so a superset of the SYKE “special legislation” layers. Click a building for its protection ' +
                    'instrument and KYPPI entry.',
                notes: 'Verified live 2026-10-17 (Ateneum, Eduskuntatalo, Kansallismuseo…).'
            },
            {
                id: 'mv-rakennusperinto-alue',
                title: { fi: 'Rakennusperintörekisteri · suojellut rakennukset (alueet)', en: 'Finland · protected buildings register, areas (Museovirasto)' },
                kind: 'wfs', group: 'protected', subGroup: 'rakennusperinto',
                wfsId: 156, table: 'rakennusperinto_suojellut_alue', geom: 'polygon',
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                verified: true,
                attribution: ATTR.museo, attributionRow: 'Rakennusperintörekisteri © Museovirasto (CC BY 4.0)',
                popup: POPUP.building,
                description: 'Area delineations of the protected buildings (“suojelurajaus”; several copied from SYKE’s ' +
                    'interface).',
                notes: 'Verified live 2026-10-17 (Tarvaspää, Villa Kleineh, Olympiastadion…).'
            },

            /* ══════════════════════════════════════════════════════════════
             * D · ÅLAND — Kulturarv/Fornminnen (ArcGIS Server)
             * ══════════════════════════════════════════════════════════════ */

            {
                id: 'aland-fornminnen',
                title: { fi: 'Ahvenanmaa · muinaisjäännökset (fornlämningar)', en: 'Åland · ancient monuments' },
                kind: 'arcgis', group: 'aland',
                restService: 'Kulturarv/Fornminnen/MapServer', layerId: 1,
                minZoom: 8, maxZoom: 20, maxNativeZoom: 19, opacity: 1, defaultOn: true, enabled: true, status: 'ok',
                attribution: ATTR.aland, attributionRow: 'Fornminnen © Ålands landskapsregering (CC BY 4.0)',
                popup: POPUP.aland,
                description: 'The Åland ancient-monuments register kept by the provincial government’s Culture Office ' +
                    '(municipality, village, monument type and dating; scale ≈ 1:20 000). Åland’s monuments are NOT part ' +
                    'of the mainland Muinaisjäännösrekisteri, so this layer adds sites the Finnish layers cannot show. ' +
                    'Rendered from the ArcGIS REST export endpoint in the map’s own projection; clicking fetches the ' +
                    'matching GeoJSON features for the popup.',
                notes: 'REST export with bboxSR=3857 verified live 2026-10-17 (f=json returns image 256×256 metadata). CSW record da0e5eb9-… lists the INSPIRE WMS twin.'
            },
            {
                id: 'aland-skyddsomraden',
                title: { fi: 'Ahvenanmaa · suojelualueet (fornminneskyddsområden)', en: 'Åland · monument protection areas' },
                kind: 'arcgis', group: 'aland',
                restService: 'Kulturarv/Fornminnen/MapServer', layerId: 0,
                minZoom: 8, maxZoom: 20, maxNativeZoom: 19, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.aland, attributionRow: 'Skyddsområden © Ålands landskapsregering (CC BY 4.0)',
                popup: POPUP.aland,
                description: 'Protected-area delineations around Åland’s ancient monuments.',
                notes: null
            },
            {
                id: 'aland-maritima',
                title: { fi: 'Ahvenanmaa · merelliset muinaisjäännökset', en: 'Åland · maritime ancient monuments' },
                kind: 'arcgis', group: 'aland',
                restService: 'Kulturarv/Fornminnen/MapServer', layerId: 5,
                minZoom: 8, maxZoom: 20, maxNativeZoom: 19, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.aland, attributionRow: 'Maritima fornminnen © Ålands landskapsregering (CC BY 4.0)',
                popup: POPUP.aland,
                description: 'Maritime heritage sites (wrecks and underwater remains) around Åland.',
                notes: null
            },
            {
                id: 'aland-krigstida',
                title: { fi: 'Ahvenanmaa · sotaaikaiset jäännökset', en: 'Åland · wartime remains' },
                kind: 'arcgis', group: 'aland',
                restService: 'Kulturarv/Fornminnen/MapServer', layerId: 6,
                minZoom: 8, maxZoom: 20, maxNativeZoom: 19, opacity: 1, defaultOn: false, enabled: true, status: 'ok',
                attribution: ATTR.aland, attributionRow: 'Krigstida lämningar © Ålands landskapsregering (CC BY 4.0)',
                popup: POPUP.aland,
                description: 'First/Second World War fortification remains around Åland (not visible by default in the ' +
                    'province’s own map either).',
                notes: null
            },

            /* ══════════════════════════════════════════════════════════════
             * E · LOCAL FILES (Supabase-hosted GeoPackages, converted)
             * ══════════════════════════════════════════════════════════════ */

            {
                id: 'local-rky-alue',
                title: { fi: 'RKY · valtakunnallisesti merkittävät rakennetut kulttuuriympäristöt · alueet', en: 'Finland · RKY built environments of national significance · areas (local file)' },
                kind: 'geojson', group: 'local',
                file: 'rky_inspire_alue', supabaseFile: 'converted/rky_inspire_alue.geojson',
                geom: 'polygon', style: { color: '#c9a227', weight: 2, fill: true, fillOpacity: 0.08 },
                minZoom: 6, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'needs-conversion',
                statusNote: 'GeoPackage conversion not run yet — run node tools/finland-convert-gpkg.mjs where the ' +
                    'Supabase bucket is reachable (see FINLAND_LAYERS.md §local-files).',
                attribution: ATTR.local, attributionRow: 'RKY-aineisto (omaa konversiota, lähde Museovirasto)',
                popup: POPUP.generic,
                description: 'RKY — the nationally significant built cultural environments (valtakunnallisesti merkittävät ' +
                    'rakennetut kulttuuriympäristöt), areas. Served from the local GeoJSON conversion of the Supabase ' +
                    'GeoPackage (no public live vector service exists for RKY; Museovirasto’s WFS for it is permit-gated).',
                notes: 'Source: rky_inspire_alue.gpkg (INSPIRE schema). QML styling not provided for the areas file.'
            },
            {
                id: 'local-rky-piste',
                title: { fi: 'RKY · pisteet', en: 'Finland · RKY sites (local file)' },
                kind: 'geojson', group: 'local',
                file: 'rky_piste', supabaseFile: 'converted/rky_piste.geojson',
                geom: 'point', style: { color: '#c9a227', weight: 2, radius: 5, fill: true, fillOpacity: 0.5 },
                minZoom: 8, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'needs-conversion',
                statusNote: 'GeoPackage conversion not run yet — run node tools/finland-convert-gpkg.mjs.',
                attribution: ATTR.local, attributionRow: 'RKY-aineisto (omaa konversiota, lähde Museovirasto)',
                popup: POPUP.generic,
                description: 'RKY sites as points (the non-INSPIRE rky_piste.gpkg variant, which carries the fuller ' +
                    'attribute set; rky_inspire_piste.gpkg is the same geometry in the INSPIRE schema and is not ' +
                    'converted separately).',
                notes: 'rky_piste.qml is read by the conversion script for the colour scheme.'
            },
            {
                id: 'local-rky-viiva',
                title: { fi: 'RKY · viivat (esim. reitit, kanavat)', en: 'Finland · RKY lines (local file)' },
                kind: 'geojson', group: 'local',
                file: 'rky_viiva', supabaseFile: 'converted/rky_viiva.geojson',
                geom: 'line', style: { color: '#c9a227', weight: 3, dash: '6,4' },
                minZoom: 8, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'needs-conversion',
                statusNote: 'GeoPackage conversion not run yet — run node tools/finland-convert-gpkg.mjs.',
                attribution: ATTR.local, attributionRow: 'RKY-aineisto (omaa konversiota, lähde Museovirasto)',
                popup: POPUP.generic,
                description: 'Linear RKY environments (routes, canals, roads). rky_viiva.qml is read by the conversion ' +
                    'script for the styling.',
                notes: null
            },
            {
                id: 'local-vark-alue',
                title: { fi: 'VARK · arkeologiset kulttuuriympäristöt · aluerajaukset', en: 'Finland · VARK archaeological cultural environments · areas (local file)' },
                kind: 'geojson', group: 'local',
                file: 'VARK_aluerajaukset', supabaseFile: 'converted/VARK_aluerajaukset.geojson',
                geom: 'polygon', style: { color: '#e07b39', weight: 2, fill: true, fillOpacity: 0.08 },
                minZoom: 6, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'needs-conversion',
                statusNote: 'GeoPackage conversion not run yet — run node tools/finland-convert-gpkg.mjs.',
                attribution: ATTR.local, attributionRow: 'VARK-aineisto (omaa konversiota, lähde Museovirasto)',
                popup: POPUP.generic,
                description: 'VARK — nationally important archaeological cultural environments ' +
                    '(valtakunnallisesti arvokkaat arkeologisen kulttuuriperinnön kohteet), area delineations from the ' +
                    'Supabase GeoPackage conversion.',
                notes: null
            },
            {
                id: 'local-vark-piste',
                title: { fi: 'VARK · keskipisteet', en: 'Finland · VARK centroids (local file)' },
                kind: 'geojson', group: 'local',
                file: 'VARK_keskipisteet', supabaseFile: 'converted/VARK_keskipisteet.geojson',
                geom: 'point', style: { color: '#e07b39', weight: 2, radius: 5, fill: true, fillOpacity: 0.5 },
                minZoom: 8, maxZoom: 20, opacity: 1, defaultOn: false, enabled: true, status: 'needs-conversion',
                statusNote: 'GeoPackage conversion not run yet — run node tools/finland-convert-gpkg.mjs.',
                attribution: ATTR.local, attributionRow: 'VARK-aineisto (omaa konversiota, lähde Museovirasto)',
                popup: POPUP.generic,
                description: 'Centroids of the VARK areas.',
                notes: null
            },
            {
                id: 'local-arkeologiset-alakohteet',
                title: { fi: 'Arkeologisten kohteiden alakohteet (pisteet) — kaksoiskappale', en: 'Archaeological sub-sites, points (local file · duplicate)' },
                kind: 'geojson', group: 'local',
                file: 'arkeologiset_kohteet_alakohteet_piste', supabaseFile: 'converted/arkeologiset_kohteet_alakohteet_piste.geojson',
                geom: 'point', style: { color: '#8b6fc9', weight: 2, radius: 4, fill: true, fillOpacity: 0.5 },
                minZoom: 12, maxZoom: 20, opacity: 1, defaultOn: false, enabled: false, status: 'duplicate',
                statusNote: 'Duplicates the live museoverkko sub-site layers (mj-*-alakohteet): the conversion report ' +
                    'should be compared against those before enabling. Kept here for offline use.',
                attribution: ATTR.local, attributionRow: 'Museoviraston alakohteet (omaa konversiota)',
                popup: POPUP.subsite,
                description: 'The register’s sub-sites as one file. The same sub-sites are already served live by the ' +
                    'museoverkko layers, so this row stays off unless you want a static copy.',
                notes: null
            },
            {
                id: 'local-suojellut-alue',
                title: { fi: 'Suojellut rakennukset · alueet (Supabase) — kaksoiskappale', en: 'Protected buildings, areas (Supabase · duplicate)' },
                kind: 'geojson', group: 'local',
                file: 'suojellut_rakennukset_alue', supabaseFile: 'converted/suojellut_rakennukset_alue.geojson',
                geom: 'polygon', style: { color: '#d16ba5', weight: 2, fill: true, fillOpacity: 0.08 },
                minZoom: 10, maxZoom: 20, opacity: 1, defaultOn: false, enabled: false, status: 'duplicate',
                statusNote: 'Same register as the live Museovirasto protected-buildings layers (mv-rakennusperinto-alue) ' +
                    'and the SYKE built-heritage service — dropped as a duplicate per the brief’s rule. The conversion ' +
                    'report confirms the feature counts when the script runs.',
                attribution: ATTR.local, attributionRow: 'Rakennusperintörekisteri (omaa konversiota)',
                popup: POPUP.building,
                description: 'Protected-buildings areas from the Supabase GeoPackage — superseded by the live ' +
                    'Museovirasto/SYKE services.',
                notes: null
            },
            {
                id: 'local-suojellut-piste',
                title: { fi: 'Suojellut rakennukset · pisteet (Supabase) — kaksoiskappale', en: 'Protected buildings, points (Supabase · duplicate)' },
                kind: 'geojson', group: 'local',
                file: 'suojellut_rakennukset_piste', supabaseFile: 'converted/suojellut_rakennukset_piste.geojson',
                geom: 'point', style: { color: '#d16ba5', weight: 2, radius: 5, fill: true, fillOpacity: 0.5 },
                minZoom: 11, maxZoom: 20, opacity: 1, defaultOn: false, enabled: false, status: 'duplicate',
                statusNote: 'Same register as the live Museovirasto protected-buildings layers (mv-rakennusperinto-piste) ' +
                    'and SYKE’s service — dropped as a duplicate.',
                attribution: ATTR.local, attributionRow: 'Rakennusperintörekisteri (omaa konversiota)',
                popup: POPUP.building,
                description: 'Protected-buildings points from the Supabase GeoPackage — superseded by the live services.',
                notes: null
            }
        ]
    };

    /* ── helpers the panel, the proxy and the tools all use ─────────────── */

    function byId(id) {
        for (var i = 0; i < CONFIG.layers.length; i++) {
            if (CONFIG.layers[i].id === id) return CONFIG.layers[i];
        }
        return null;
    }

    function enabledLayers() {
        return CONFIG.layers.filter(function (layer) { return layer.enabled !== false; });
    }

    function layersOfKind(kind) {
        return CONFIG.layers.filter(function (layer) { return layer.kind === kind; });
    }

    function layersOfGroup(groupId) {
        return CONFIG.layers.filter(function (layer) { return layer.group === groupId; });
    }

    function subGroupsOf(groupId) {
        var seen = {}, out = [];
        CONFIG.layers.forEach(function (layer) {
            if (layer.group !== groupId || !layer.subGroup) return;
            if (!seen[layer.subGroup]) { seen[layer.subGroup] = true; out.push(layer.subGroup); }
        });
        return out;
    }

    function categoryById(catId) {
        return (CONFIG.REGISTER_CATEGORIES || []).filter(function (c) { return c.id === catId; })[0] || null;
    }

    /* The SYKE WMS endpoints, by the config's service key. */
    function wmsUrl(serviceKey) {
        return CONFIG.endpoints[serviceKey] || null;
    }

    var WMS_SERVICES = {
        sykeBuilt: {
            url: 'https://paikkatiedot.ymparisto.fi/geoserver/syke_rakennussuojelukohteet/wms',
            proxySrc: 'syke',
            attribution: ATTR.syke
        },
        sykeInspire: {
            url: 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_ps/wms',
            proxySrc: 'syke',
            attribution: ATTR.syke
        }
    };

    /* Labels for the collapsible sub-sections inside “Protected sites”. */
    var SUBGROUP_LABELS = {
        built: { fi: 'Rakennusperintö (erityislait) — SYKE', en: 'Built heritage (special legislation) — SYKE' },
        'inspire-nature': { fi: 'Luonnonsuojelu ja erämaat — SYKE INSPIRE', en: 'Nature conservation & wilderness — SYKE INSPIRE' },
        'inspire-natura': { fi: 'Natura 2000 — SYKE INSPIRE', en: 'Natura 2000 — SYKE INSPIRE' },
        'inspire-built': { fi: 'Erityislailla suojellut rakennukset — SYKE INSPIRE', en: 'Specially-protected built heritage — SYKE INSPIRE' },
        rakennusperinto: { fi: 'Suojellut rakennukset — Museoviraston rekisteri', en: 'Protected buildings — Museovirasto register' },
        kiiteat: { fi: 'Kiinteät muinaisjäännökset', en: 'Immovable ancient relics' },
        mahdolliset: { fi: 'Mahdolliset muinaisjäännökset', en: 'Possible ancient relics' },
        poistetut: { fi: 'Poistetut kiinteät muinaisjäännökset', en: 'Removed immovable ancient relics' },
        loytopaikat: { fi: 'Löytöpaikat', en: 'Places of discovery' },
        havainnot: { fi: 'Havaintokohteet', en: 'Observation sites / targets / objects' },
        luonnonmuodostumat: { fi: 'Luonnonmuodostumat', en: 'Natural formations' },
        muut_kulttuuri: { fi: 'Muut kulttuuriperintökohteet', en: 'Other cultural heritage sites' },
        muut: { fi: 'Muut kohteet', en: 'Other items / other destinations' }
    };

    var api = {
        version: CONFIG.version,
        CONFIG: CONFIG,
        layers: CONFIG.layers,
        groups: CONFIG.GROUPS,
        byId: byId,
        enabledLayers: enabledLayers,
        layersOfKind: layersOfKind,
        layersOfGroup: layersOfGroup,
        subGroupsOf: subGroupsOf,
        categoryById: categoryById,
        wmsUrl: wmsUrl,
        WMS_SERVICES: WMS_SERVICES,
        SUBGROUP_LABELS: SUBGROUP_LABELS,
        FIELD_LABELS: FIELD_LABELS,
        REGISTER_CATEGORIES: CONFIG.REGISTER_CATEGORIES,
        endpoints: CONFIG.endpoints,
        attributionParts: ATTR,
        country: CONFIG.country,
        countryBounds: CONFIG.countryBounds,
        view: CONFIG.view,
        groupLabel: CONFIG.groupLabel,
        groupInfo: CONFIG.groupInfo,
        provider: 'Maanmittauslaitos · Museovirasto · SYKE · Ålands landskapsregering',
        licence: CONFIG.licence
    };

    return api;
}));
