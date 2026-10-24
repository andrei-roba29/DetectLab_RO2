/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Albania (ASIG geoportal) layer catalogue · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * Every Albania ASIG layer rendered by js/asig-albania-layers.js is
 * described here: the panel sections, the per-layer WMS/WMTS identity and
 * the parts of the single "Heritage" toggle. Adding, removing or
 * re-labelling a layer is a change to this file only — no map code has to
 * be touched. js/layer-registry.js mirrors the statically-named WMS
 * entries (ids `albania.<id>`) for diagnostics, the 3D deck and the
 * offline audit (tools/audit-wms-layers.mjs). `node tools/build-asig-
 * catalogue.mjs` regenerates the interchange copy data/asig-catalogue.json.
 *
 * CATALOGUE SHAPE (owner's prototype viewer, ported faithfully)
 *   Heritage (ONE toggle; its parts are never panel rows), then six
 *   sections: Orthophotos (14), Terrain (2), Cadastre (3), Maps (2),
 *   Environment (1), Planning & mining (6). All 28 rows + the Heritage
 *   toggle are mounted in the single Albania-only group (#albaniaRow →
 *   #albaniaSubLayers) and shown only while Albania (ISO2 `AL`) is the
 *   selected country. Display titles (`title.en`) are the geoportal titles
 *   exactly as the owner listed them — including the portal's own
 *   misspelling "Mineral Resouces". `title.ro` repeats the same string:
 *   these are product names, not sentences.
 *
 * WHERE THE NAMES COME FROM (provenance, per entry in `notes`)
 *   - "prototype" — the exact `workspace:name` was built into the owner's
 *     prototype viewer (its WANTED table, cross-checked against the
 *     portal's WMTS list).
 *   - "repo" — the name was already served by this site's previous
 *     9-layer Albania module (the IKTK cultural sites). The owner chose
 *     to keep them as Heritage's cultural point/polygon parts.
 *   - "resolve-by-title" — only the portal Title is known in this repo;
 *     `layers` is null and `resolveTitle` carries the exact title.
 *     js/asig-albania-layers.js resolves it in the visitor's browser from
 *     the live WMS GetCapabilities (exact normalised Title match, then
 *     local Name match), exactly like the prototype's discover(). No name
 *     is ever guessed: until resolution succeeds the row is shown
 *     disabled with an explanation. To bake a name in, set `layers` from
 *     the owner's asig-layers.json export (or tools/resolve_layers.py on
 *     a browser-saved capabilities file) and delete `resolveTitle`.
 *
 * HERITAGE
 *   One toggle, several WMS parts (see CONFIG.heritage): the two AKZM
 *   layers, the two IKTK cultural layers, plus — at runtime — every WMS
 *   layer whose Title/Name matches /archaeolog|archeolog|arkeolog/i
 *   (the DCM archaeological zones). Parts have `panel:false`; they are
 *   switched, faded, reordered and queried together by the one row.
 *   `staticDiscovered` is the bake-in list for keyword matches once the
 *   owner supplies asig-layers.json (`heritage.parts`).
 *
 * TILE-ONLY LAYERS (kind:'wmts')
 *   DSM:Dsm_Hill_Group, Dtm_2015:Hillshade_2015_group and
 *   hartat_historike:italiane_100k are NOT WMS layers (GeoServer answers
 *   LayerNotDefined as an XML body with HTTP 200). The owner-supplied WMTS
 *   GetCapabilities (2026-10-24) confirms those layers link only the
 *   EPSG:6870 (levels 0–12) and EPSG:4326 (levels 0–21, top-left −180, 90,
 *   256 px tiles, matrix width 2^(z+1) / height 2^z) TileMatrixSets. The
 *   service also *defines* EPSG:900913 / GoogleCRS84Quad TileMatrixSets,
 *   but the target layers do not advertise a link to them, so a direct
 *   Web-Mercator GetTile is unproven. js/asig-albania-layers.js therefore
 *   reprojects the EPSG:4326 tiles to Web Mercator on canvas, stepping
 *   down to shallower cached levels instead of going blank at deep zoom.
 *
 * RETIRED WITH THE EXACT CATALOGUE (owner decision, 2026-10-24)
 *   `topo50k` (Topografike:50K_Topografike) — the previous module's 1:50k
 *   topographic row is not in the prototype catalogue and was removed.
 *   The old `heritage` tile id (the IKTK zone layer) is now the Heritage
 *   GROUP id; the layer itself is the part `culturalZone`.
 *
 * Source: geoportal.asig.gov.al — Autoriteti Shtetëror për Informacionin
 * Gjeohapësinor (ASIG, Albanian State Authority for Geospatial
 * Information). GeoServer + GeoWebCache, public, no key, HTTPS.
 * LICENCE: not stated in the capabilities supplied — verify ASIG's reuse
 * terms before relying on them (see CONFIG.licence).
 *
 * WARNING — dated layer names (…_081124, …22_07_2026, …) are publication
 * snapshots. If one stops drawing, re-check the name in a browser at
 *   https://geoportal.asig.gov.al/service/wms?SERVICE=WMS&REQUEST=GetCapabilities
 * and update ONLY this file. (ASIG blacklists datacenter IPs; a normal
 * browser works, an automated fetch from CI may not.)
 *
 * Field reference (tile entries):
 *   id              stable id; row, registry (`albania.<id>`), localStorage
 *   kind            'wms' | 'wmts' (tile-only, canvas-reprojected)
 *   title           { ro, en } display name (en = portal title, verbatim)
 *   section         catalogue section id (see CONFIG.sections)
 *   registryGroup   shared catalogue group/z-order for registry & 3D
 *   registryZ       z within that group
 *   layers          exact WMS/WMTS `workspace:name`, or null
 *   resolveTitle    exact portal Title to resolve at runtime (when null name)
 *   url/fallbackUrl optional explicit endpoints (owner export shape);
 *                   default: per-workspace /service/<ws>/wms, then global
 *   queryable       false only where GetFeatureInfo is meaningless (wmts)
 *   format          GetMap FORMAT (image/png throughout, per prototype)
 *   transparent     GetMap TRANSPARENT (true, per prototype)
 *   opacity         initial opacity 0–1
 *   order           catalogue order inside the Albania group
 *   minZoom/maxNativeZoom  Leaflet zoom window (map ceiling is 20)
 *   panel           true = own panel row; false = Heritage part
 *   attributionRow/user popup credit, description ⓘ popup text, notes
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    /* Node (the registry mirror, the audit tool, the tests) gets the very same
     * object, so a layer can never be described twice. */
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) {
        root.ASIG_ALBANIA_CONFIG = api;
        root.ASIG_ALBANIA_LAYERS = api;
    }
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var ATTRIBUTION = 'Data: ASIG, Albanian State Authority for Geospatial Information (geoportal.asig.gov.al)';
    var SERVICE_ROOT = 'https://geoportal.asig.gov.al/service/';

    function protoDesc(what) {
        return what + ', rendered live from the ASIG geoportal (geoportal.asig.gov.al). ' +
            'Requests are limited to the ASIG coverage of Albania.';
    }
    function resolveDesc(title) {
        return 'ASIG layer “' + title + '”. Its exact WMS name is resolved from the geoportal ' +
            'layer list in your browser (by exact title) — until that lookup succeeds the row stays ' +
            'disabled and nothing is requested under a guessed name.';
    }

    var CONFIG = {
        version: '20261024-asig-catalogue',
        provider: 'ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor',
        /* The owner does not know ASIG's reuse terms and neither do we: do
         * not present this as a licence grant. Verify before redistribution. */
        licence: 'ASIG terms unknown — no explicit licence in the supplied capabilities; verify reuse/redistribution terms with ASIG',

        /* ISO2 of the only country these rows belong to. */
        country: 'AL',
        groupLabel: { ro: 'Albania · geoportalul ASIG', en: 'Albania · ASIG geoportal' },
        groupInfo: 'The ASIG geoportal catalogue for Albania: one Heritage toggle (all archaeological, ' +
            'cultural and natural protected-area layers together), 14 orthophotos (1957–2018, incl. CIR), ' +
            'the two terrain hillshades (tile-only, reprojected in the browser), cadastral zones/parcels, ' +
            'two map series, water courses, and the planning & mining layers. Tiles load directly from ' +
            'geoportal.asig.gov.al in your browser — nothing is proxied or pre-downloaded. Catalogue: ' +
            'js/asig-albania-layers.config.js.',

        /* WGS84 coverage of the ASIG footprint [[south,west],[north,east]]. */
        countryBounds: [[39.538, 18.773], [42.758, 21.179]],
        view: { center: [41.3275, 19.8187], zoom: 9, label: { ro: 'Tirana', en: 'Tirana' } },

        /* Panel sections in the prototype's order. `heritage` holds the
         * single Heritage row; the rest hold one row per layer. */
        sections: [
            { id: 'heritage', kind: 'group', title: { ro: 'Patrimoniu', en: 'Heritage' } },
            { id: 'orthophotos', kind: 'layers', title: { ro: 'Ortofoto', en: 'Orthophotos' } },
            { id: 'terrain', kind: 'layers', title: { ro: 'Relief', en: 'Terrain' } },
            { id: 'cadastre', kind: 'layers', title: { ro: 'Cadastru', en: 'Cadastre' } },
            { id: 'maps', kind: 'layers', title: { ro: 'Hărți', en: 'Maps' } },
            { id: 'environment', kind: 'layers', title: { ro: 'Mediu', en: 'Environment' } },
            { id: 'planning', kind: 'layers', title: { ro: 'Planificare și minerit', en: 'Planning & mining' } }
        ],
        /* Back-compat captions (older code/tests read sectionLabels). */
        sectionLabels: {
            heritage: { ro: 'Patrimoniu', en: 'Heritage' },
            orthophotos: { ro: 'Ortofoto', en: 'Orthophotos' },
            terrain: { ro: 'Relief', en: 'Terrain' },
            cadastre: { ro: 'Cadastru', en: 'Cadastre' },
            maps: { ro: 'Hărți', en: 'Maps' },
            environment: { ro: 'Mediu', en: 'Environment' },
            planning: { ro: 'Planificare și minerit', en: 'Planning & mining' }
        },

        /* ── Heritage: ONE toggle, many WMS parts ─────────────────────
         * Part ids refer to `panel:false` entries in `layers` below.
         * `keyword` is the prototype's rule, applied to Title + Name of
         * every WMS layer at discovery time. `legalNoticePlaceholder` is
         * deliberately a placeholder for the site OWNER — the parts draw
         * protected zones; they are not a permission map and this site
         * must not state detecting rules it has not verified. */
        heritage: {
            id: 'heritage',
            title: { ro: 'Patrimoniu', en: 'Heritage' },
            partIds: ['culturalZone', 'cultural', 'natural', 'monument'],
            keyword: 'archaeolog|archeolog|arkeolog',
            /* Bake-in list once the owner exports heritage.parts from the
             * prototype: [{ title: '…', layers: 'workspace:name' }, …] */
            staticDiscovered: [],
            opacity: 0.85,
            description: 'Switches on every ASIG protected-heritage layer at once: cultural protected ' +
                'sites (points and polygons), natural protected areas and natural monuments, plus every ' +
                'archaeological zone the geoportal publishes (found by the keyword archaeolog*/' +
                'archeolog*/arkeolog* in the WMS layer list, exactly as in the owner\u2019s prototype). ' +
                'One opacity slider controls all parts; map clicks query all of them.\n' +
                '[OWNER PLACEHOLDER: legal notice about protected areas to be written by the site owner. ' +
                'These layers show protected zones only — they are not a permission map.]'
        },

        endpoints: {
            serviceRoot: SERVICE_ROOT,
            wms: SERVICE_ROOT + 'wms',
            wmts: SERVICE_ROOT + 'wmts',
            capabilities: {
                wms: SERVICE_ROOT + 'wms?SERVICE=WMS&REQUEST=GetCapabilities',
                wmts: SERVICE_ROOT + 'wmts?service=WMTS&request=GetCapabilities',
                wmsVersion: '1.3.0',
                getMapFormats: ['image/png', 'image/jpeg'],
                rootCrs: ['EPSG:6870', 'EPSG:4326', 'EPSG:900913', 'CRS:84'],
                /* WMTS grids from the owner-supplied GetCapabilities. The
                 * EPSG:900913 / GoogleCRS84Quad sets are defined by the
                 * service, but the catalogue's WMTS layers link only the
                 * two grids listed in `wmtsGrids`. */
                wmtsGrids: ['EPSG:6870', 'EPSG:4326'],
                wmtsDefinedButUnlinked: ['EPSG:900913', 'GoogleCRS84Quad', 'GlobalCRS84Pixel', 'GlobalCRS84Scale'],
                defaultStyle: ''
            },
            nativeCrs: 'EPSG:6870',
            nativeTileMatrixSet: 'EPSG:6870'
        },

        /* Shared request parameters.
         * GetMap (2D): the owner's prototype-verified shape — WMS 1.1.1,
         * SRS=EPSG:3857, transparent PNG, 512 px tiles with zoomOffset −1,
         * per-workspace endpoint first, one retry through the global
         * endpoint — plus this module's older EPSG:4326 safety net.
         * `version`/`tileSize` stay 1.3.0/256: they are what the shared
         * registry/3D proxy has always used for these layer ids. */
        wms: {
            url: SERVICE_ROOT + 'wms',
            version: '1.3.0',
            getMapVersion: '1.1.1',
            crs: 'EPSG:3857',
            fallbackCrs: 'EPSG:4326',
            endpointFallbackAfterErrors: 2,
            fallbackAfterErrors: 6,
            styles: '',
            tileSize: 256,
            getMapTileSize: 512,
            keepBuffer: 1
        },
        wmts: {
            url: SERVICE_ROOT + 'wmts',
            tileMatrixSet: 'EPSG:4326',
            /* Owner-supplied WMTS capabilities: EPSG:4326 has TileMatrix
             * EPSG:4326:0 … EPSG:4326:21, top-left corner (-180, 90),
             * 256×256 tiles and MatrixWidth=2^(z+1), MatrixHeight=2^z.
             * planTile() in the renderer uses exactly that grid; the
             * real deepest *cached* level is still discovered at runtime
             * by stepping down when a level returns no tiles. */
            grid: { crs: 'EPSG:4326', topLeft: [-180, 90], tileSize: 256, minZoom: 0, maxZoom: 21 },
            maxSourceZoom: 21,
            stepDownMax: 10,
            lostAfter: 3
        },
        discovery: {
            /* In-browser GetCapabilities lookup for resolve-by-title and
             * archaeology-keyword layers (the prototype's discover()). */
            enabled: true,
            capabilitiesUrl: SERVICE_ROOT + 'wms?service=WMS&version=1.3.0&request=GetCapabilities'
        },

        attribution: ATTRIBUTION,

        /* Every tile-layer definition. Panel rows appear in section order
         * then `order`; Heritage parts (panel:false) never appear as rows. */
        layers: [
            /* ── Heritage parts (panel:false — switched only by Heritage) ── */
            {
                id: 'culturalZone', kind: 'wms', panel: false, heritagePart: true,
                section: 'heritage', registryGroup: 'patrimoniu', registryZ: 620,
                title: { ro: 'Cultural protected sites (polygon)', en: 'Cultural protected sites (polygon)' },
                layers: 'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
                format: 'image/png', transparent: true, opacity: 0.85, order: 1,
                minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION,
                description: protoDesc('Heritage part: protected cultural-heritage ZONES (IKTK polygons; ' +
                    'layer name carries the 22 July 2026 snapshot, _22_07_2026)'),
                notes: 'repo: served by the previous Albania module as "Heritage Sites"; owner chose it ' +
                    'as the cultural-polygon Heritage part (title mapping repo-sourced, not export-verified). ' +
                    'SNAPSHOT name — re-check on failure.'
            },
            {
                id: 'cultural', kind: 'wms', panel: false, heritagePart: true,
                section: 'heritage', registryGroup: 'patrimoniu', registryZ: 622,
                title: { ro: 'Cultural protected sites (point)', en: 'Cultural protected sites (point)' },
                layers: 'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
                format: 'image/png', transparent: true, opacity: 0.85, order: 2,
                minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION,
                description: protoDesc('Heritage part: protected cultural-heritage POINTS (IKTK, "pike"; ' +
                    'layer name carries the 13 May 2026 snapshot, _13_05_2026)'),
                notes: 'repo: served by the previous Albania module as "Cultural Protected Sites"; owner ' +
                    'chose it as the cultural-point Heritage part (title mapping repo-sourced). SNAPSHOT name.'
            },
            {
                id: 'natural', kind: 'wms', panel: false, heritagePart: true,
                section: 'heritage', registryGroup: 'patrimoniu', registryZ: 621,
                title: { ro: 'Natural Protected Areas', en: 'Natural Protected Areas' },
                layers: 'akzm:zonat_mbrojtura_081124',
                format: 'image/png', transparent: true, opacity: 0.85, order: 3,
                minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION,
                description: protoDesc('Heritage part: legally protected natural areas (AKZM; layer name ' +
                    'carries the 8 November 2024 snapshot, _081124)'),
                notes: 'prototype HERITAGE_KNOWN. SNAPSHOT name.'
            },
            {
                id: 'monument', kind: 'wms', panel: false, heritagePart: true,
                section: 'heritage', registryGroup: 'patrimoniu', registryZ: 623,
                title: { ro: 'Natural monument', en: 'Natural monument' },
                layers: 'akzm:monumentet_natyrore_07032023',
                format: 'image/png', transparent: true, opacity: 0.85, order: 4,
                minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION,
                description: protoDesc('Heritage part: natural monuments (AKZM; layer name carries the ' +
                    '7 March 2023 snapshot, _07032023)'),
                notes: 'prototype HERITAGE_KNOWN. SNAPSHOT name.'
            },

            /* ── Orthophotos (14) — exact names from the prototype ── */
            { id: 'ortho7686', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 400, title: { ro: 'Ortofoto 76 86 25k', en: 'Ortofoto 76 86 25k' }, layers: 'Orthophoto:Ortofoto_76_86_25k', format: 'image/png', transparent: true, opacity: 1, order: 10, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG orthophoto “Ortofoto 76 86 25k”'), notes: 'prototype exact name.' },
            { id: 'ortho94', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 401, title: { ro: 'ortofoto 94', en: 'ortofoto 94' }, layers: 'Orthophoto:ortofoto_94', format: 'image/png', transparent: true, opacity: 1, order: 20, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG orthophoto “ortofoto 94”'), notes: 'prototype exact name.' },
            { id: 'ortho2007', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 402, title: { ro: 'OrthoImagery (2007)', en: 'OrthoImagery (2007)' }, layers: 'orthophoto_2007:OrthoImagery', format: 'image/png', transparent: true, opacity: 1, order: 30, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2007 orthophoto imagery'), notes: 'prototype exact name.' },
            { id: 'ortho2015', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 403, title: { ro: 'OrthoImagery (2015)', en: 'OrthoImagery (2015)' }, layers: 'orthophoto_2015:OrthoImagery', format: 'image/png', transparent: true, opacity: 1, order: 40, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2015 orthophoto imagery'), notes: 'prototype exact name.' },
            { id: 'ortho1994', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 404, title: { ro: 'OrthoImagery 20cm', en: 'OrthoImagery 20cm' }, layers: 'orthophoto_2015:OrthoImagery_20cm', format: 'image/png', transparent: true, opacity: 1, order: 50, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2015 orthophoto imagery at 20 cm'), notes: 'prototype exact name. Legacy id "ortho1994" kept (previous module; the product is the catalogued 2015 20 cm orthophoto, not 1994). Previous module requested image/jpeg; the prototype requests transparent image/png — config follows the prototype.' },
            { id: 'ortho8cm', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 405, title: { ro: 'OrthoImagery 8cm', en: 'OrthoImagery 8cm' }, layers: 'orthophoto_2015:OrthoImagery_8cm', format: 'image/png', transparent: true, opacity: 1, order: 60, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2015 orthophoto imagery at 8 cm'), notes: 'prototype exact name.' },
            { id: 'orthoCir', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 406, title: { ro: 'Orthophoto CIR', en: 'Orthophoto CIR' }, layers: 'Orthophoto_cir:Orthophoto_CIR', format: 'image/png', transparent: true, opacity: 1, order: 70, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG colour-infrared (CIR) orthophoto'), notes: 'prototype exact name.' },
            { id: 'orthoCir8cm', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 407, title: { ro: 'Orthophoto CIR 8cm', en: 'Orthophoto CIR 8cm' }, layers: 'Orthophoto_cir:Orthophoto_CIR_8cm', format: 'image/png', transparent: true, opacity: 1, order: 80, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG colour-infrared (CIR) orthophoto at 8 cm'), notes: 'prototype exact name.' },
            { id: 'ortho2018', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 408, title: { ro: 'Ortofoto 2018', en: 'Ortofoto 2018' }, layers: 'ortofoto_2018:Ortofoto_2018', format: 'image/png', transparent: true, opacity: 1, order: 90, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2018 orthophoto'), notes: 'prototype exact name.' },
            { id: 'ortho2001', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 409, title: { ro: 'Ortofoto 2001', en: 'Ortofoto 2001' }, layers: 'Orthophoto:Ortofoto_2001', format: 'image/png', transparent: true, opacity: 1, order: 100, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 2001 orthophoto'), notes: 'prototype exact name.' },
            { id: 'ortho1999', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 410, title: { ro: 'Ortofoto 1999', en: 'Ortofoto 1999' }, layers: 'Orthophoto:Ortofoto_1999', format: 'image/png', transparent: true, opacity: 1, order: 110, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 1999 orthophoto'), notes: 'prototype exact name; same layer/id as the previous Albania module.' },
            { id: 'ortho1957', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 411, title: { ro: 'Ortofoto 1957', en: 'Ortofoto 1957' }, layers: 'Orthophoto:Ortofoto_1957', format: 'image/png', transparent: true, opacity: 1, order: 120, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 1957 orthophoto'), notes: 'prototype exact name.' },
            { id: 'ortho19761980', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 412, title: { ro: 'Orthofoto 1976 1980', en: 'Orthofoto 1976 1980' }, layers: 'Orthophoto:Orthofoto_1976_1980', format: 'image/png', transparent: true, opacity: 1, order: 130, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG 1976–1980 orthophoto'), notes: 'prototype exact name (display title spells "Orthofoto", as in the prototype table).' },
            { id: 'fragmentDurres1986', kind: 'wms', panel: true, section: 'orthophotos', registryGroup: 'sat-hist', registryZ: 413, title: { ro: 'Fragment Durres 1986', en: 'Fragment Durres 1986' }, layers: 'Orthophoto:Fragment_Durres_1986', format: 'image/png', transparent: true, opacity: 1, order: 140, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: protoDesc('ASIG orthophoto fragment of Durrës, 1986'), notes: 'prototype exact name.' },

            /* ── Terrain (2) — TILE-ONLY (WMTS, canvas-reprojected) ── */
            {
                id: 'lidar', kind: 'wmts', panel: true, queryable: false,
                section: 'terrain', registryGroup: 'lidar', registryZ: 611,
                title: { ro: 'Hillshade 2015 group', en: 'Hillshade 2015 group' },
                layers: 'Dtm_2015:Hillshade_2015_group', url: SERVICE_ROOT + 'wmts',
                format: 'image/png', transparent: true, opacity: 0.5, order: 150,
                minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION,
                description: 'Hillshade of the 2015 digital terrain model. Tile-only product: ' +
                    'ASIG serves it as pre-rendered WMTS tiles (EPSG:4326 grid), reprojected to ' +
                    'Web Mercator in your browser; where the tile cache ends, shallower tiles are enlarged.',
                notes: 'prototype WMTS_ONLY (WMS GetMap answers LayerNotDefined). Same id/layer as the ' +
                    'previous module, which wrongly drew it through WMS. Not mirrored in the registry: ' +
                    'it has no WMS GetMap for the proxy to serve — the 3D mirror drapes the live 2D canvas tiles.'
            },
            {
                id: 'dsm', kind: 'wmts', panel: true, queryable: false,
                section: 'terrain', registryGroup: 'lidar', registryZ: 610,
                title: { ro: 'Dsm Hill Group', en: 'Dsm Hill Group' },
                layers: 'DSM:Dsm_Hill_Group', url: SERVICE_ROOT + 'wmts',
                format: 'image/png', transparent: true, opacity: 0.6, order: 160,
                minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION,
                description: 'Hillshade of the digital surface model (DSM). Tile-only product: ' +
                    'ASIG serves it as pre-rendered WMTS tiles (EPSG:4326 grid), reprojected to ' +
                    'Web Mercator in your browser; where the tile cache ends, shallower tiles are enlarged.',
                notes: 'prototype WMTS_ONLY (WMS GetMap answers LayerNotDefined). Not registry-mirrored — see lidar note.'
            },

            /* ── Cadastre (3) — resolve by exact title at runtime ── */
            { id: 'cadastralZone', kind: 'wms', panel: true, section: 'cadastre', registryGroup: 'patrimoniu', registryZ: 624, title: { ro: 'Cadastral Zone', en: 'Cadastral Zone' }, layers: null, resolveTitle: 'Cadastral Zone', format: 'image/png', transparent: true, opacity: 0.85, order: 170, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Cadastral Zone'), notes: 'resolve-by-title: exact name is in the owner\u2019s asig-layers.json (not yet supplied). Bake into `layers` when supplied.' },
            { id: 'cadastralParcels', kind: 'wms', panel: true, section: 'cadastre', registryGroup: 'patrimoniu', registryZ: 625, title: { ro: 'Cadastral Parcels', en: 'Cadastral Parcels' }, layers: null, resolveTitle: 'Cadastral Parcels', format: 'image/png', transparent: true, opacity: 0.85, order: 180, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Cadastral Parcels'), notes: 'resolve-by-title: see cadastralZone.' },
            { id: 'cadastralParcelsAshk', kind: 'wms', panel: true, section: 'cadastre', registryGroup: 'patrimoniu', registryZ: 626, title: { ro: 'Cadastral Parcels (ASHK)', en: 'Cadastral Parcels (ASHK)' }, layers: null, resolveTitle: 'Cadastral Parcels (ASHK)', format: 'image/png', transparent: true, opacity: 0.85, order: 190, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Cadastral Parcels (ASHK)'), notes: 'resolve-by-title: see cadastralZone.' },

            /* ── Maps (2) ── */
            {
                id: 'italiane100k', kind: 'wmts', panel: true, queryable: false,
                section: 'maps', registryGroup: 'hist-free', registryZ: 640,
                title: { ro: 'italiane 100k', en: 'italiane 100k' },
                layers: 'hartat_historike:italiane_100k', url: SERVICE_ROOT + 'wmts',
                format: 'image/png', transparent: true, opacity: 1, order: 200,
                minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION,
                description: 'Historical Italian 1:100,000 map. Tile-only product: ASIG serves it as ' +
                    'pre-rendered WMTS tiles (EPSG:4326 grid), reprojected to Web Mercator in your ' +
                    'browser; at deep zoom enlarged tiles are shown instead of blank ones.',
                notes: 'prototype WMTS_ONLY (the owner\u2019s LayerNotDefined example). Not registry-mirrored — see lidar note.'
            },
            { id: 'topo25k', kind: 'wms', panel: true, section: 'maps', registryGroup: 'hist-free', registryZ: 641, title: { ro: '25k_krgjsh_1', en: '25k_krgjsh_1' }, layers: null, resolveTitle: '25k_krgjsh_1', format: 'image/png', transparent: true, opacity: 1, order: 210, minZoom: 7, maxNativeZoom: 18, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('25k_krgjsh_1'), notes: 'resolve-by-title (the wanted string looks like a local layer Name; the resolver tries Title first, then Name, like the prototype).' },

            /* ── Environment (1) ── */
            { id: 'waterCourseLink', kind: 'wms', panel: true, section: 'environment', registryGroup: 'patrimoniu', registryZ: 627, title: { ro: 'Water course link', en: 'Water course link' }, layers: null, resolveTitle: 'Water course link', format: 'image/png', transparent: true, opacity: 0.9, order: 220, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Water course link'), notes: 'resolve-by-title: see cadastralZone.' },

            /* ── Planning & mining (6) — resolve by exact title ── */
            { id: 'areasPlanned347', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 628, title: { ro: 'Areas Planned by (DCM 347)', en: 'Areas Planned by (DCM 347)' }, layers: null, resolveTitle: 'Areas Planned by (DCM 347)', format: 'image/png', transparent: true, opacity: 0.85, order: 230, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Areas Planned by (DCM 347)'), notes: 'resolve-by-title: see cadastralZone.' },
            { id: 'miningHazardous726', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 629, title: { ro: 'Mining Hazardous Areas (DCM 726)', en: 'Mining Hazardous Areas (DCM 726)' }, layers: null, resolveTitle: 'Mining Hazardous Areas (DCM 726)', format: 'image/png', transparent: true, opacity: 0.85, order: 240, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Mining Hazardous Areas (DCM 726)'), notes: 'resolve-by-title: see cadastralZone.' },
            { id: 'miningHazardous347', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 630, title: { ro: 'Mining Hazardous Areas (DCM 347)', en: 'Mining Hazardous Areas (DCM 347)' }, layers: null, resolveTitle: 'Mining Hazardous Areas (DCM 347)', format: 'image/png', transparent: true, opacity: 0.85, order: 250, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Mining Hazardous Areas (DCM 347)'), notes: 'resolve-by-title: see cadastralZone.' },
            { id: 'oldMiningAreas', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 631, title: { ro: 'Old Mining Areas', en: 'Old Mining Areas' }, layers: null, resolveTitle: 'Old Mining Areas', format: 'image/png', transparent: true, opacity: 0.85, order: 260, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Old Mining Areas'), notes: 'resolve-by-title: see cadastralZone.' },
            { id: 'mineralResouces', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 632, title: { ro: 'Mineral Resouces', en: 'Mineral Resouces' }, layers: null, resolveTitle: 'Mineral Resouces', format: 'image/png', transparent: true, opacity: 0.85, order: 270, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Mineral Resouces'), notes: 'resolve-by-title: "Resouces" is the portal\u2019s own spelling of the Title — keep it for matching.' },
            { id: 'miningPermits', kind: 'wms', panel: true, section: 'planning', registryGroup: 'patrimoniu', registryZ: 633, title: { ro: 'Mining exploitation permits', en: 'Mining exploitation permits' }, layers: null, resolveTitle: 'Mining exploitation permits', format: 'image/png', transparent: true, opacity: 0.85, order: 280, minZoom: 7, maxNativeZoom: 19, defaultOn: false, attributionRow: ATTRIBUTION, description: resolveDesc('Mining exploitation permits'), notes: 'resolve-by-title: see cadastralZone.' }
        ]
    };

    CONFIG.byId = function (id) {
        for (var i = 0; i < CONFIG.layers.length; i++) {
            if (CONFIG.layers[i].id === id) return CONFIG.layers[i];
        }
        return null;
    };

    CONFIG.enabledLayers = function () {
        return CONFIG.layers.filter(function (layer) { return layer.enabled !== false; });
    };

    /* Panel tile rows (Heritage parts excluded), in display order. */
    CONFIG.panelLayers = function () {
        var sectionRank = {};
        CONFIG.sections.forEach(function (section, i) { sectionRank[section.id] = i; });
        return CONFIG.enabledLayers().filter(function (layer) { return layer.panel !== false; })
            .slice().sort(function (a, b) {
                return ((sectionRank[a.section] || 0) - (sectionRank[b.section] || 0)) || (a.order - b.order);
            });
    };

    /* The catalogue, bottom → top as `order` sorts the panel rows. The
     * Heritage group is represented by a pseudo-entry in panelOrder(). */
    CONFIG.drawOrder = function () { return CONFIG.panelLayers(); };

    /* Panel entries exactly as the visitor sees them: the Heritage group
     * toggle plus the 28 layer rows, in section order. */
    CONFIG.panelOrder = function () {
        var entries = [];
        CONFIG.sections.forEach(function (section) {
            if (section.kind === 'group') {
                entries.push({
                    id: CONFIG.heritage.id, kind: 'group', panel: true, section: section.id,
                    title: CONFIG.heritage.title, opacity: CONFIG.heritage.opacity,
                    partIds: CONFIG.heritage.partIds, order: 0
                });
            } else {
                CONFIG.panelLayers().forEach(function (layer) {
                    if (layer.section === section.id) entries.push(layer);
                });
            }
        });
        return entries;
    };

    /* Row counts per section (Heritage counts its one toggle row). */
    CONFIG.countsBySection = function () {
        var counts = {};
        CONFIG.sections.forEach(function (section) { counts[section.id] = 0; });
        CONFIG.panelOrder().forEach(function (entry) { counts[entry.section] = (counts[entry.section] || 0) + 1; });
        return counts;
    };

    return CONFIG;
}));
