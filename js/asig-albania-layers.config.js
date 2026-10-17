/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Albania (ASIG geoportal) data layers · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * Every Albanian layer the map can draw is described HERE and nowhere else.
 * js/asig-albania-layers.js renders the panel rows, builds the Leaflet layers
 * and runs the raster/overlay logic from this list; adding, removing or
 * re-labelling a layer is a change to this file only — no map code has to be
 * touched. js/layer-registry.js mirrors the enabled entries (ids
 * `albania.<id>`) so the layers are also catalogued for the diagnostics, the
 * 3D status report and the offline audit (tools/audit-wms-layers.mjs).
 *
 * Source: geoportal.asig.gov.al — Autoriteti Shtetëror për Informacionin
 * Gjeohapësinor (ASIG, the Albanian State Authority for Geospatial
 * Information). GeoServer + GeoWebCache, public, no key, no token, HTTPS.
 *
 * Why WMS (EPSG:3857) and not the native WMTS grid
 *   ASIG's native CRS is EPSG:6870 (ETRS89 / Albania TM 2010). The WMTS
 *   publishes these rasters on the EPSG:6870 tile matrix set (and a coarse
 *   EPSG:4326 one) — NEITHER is the Web-Mercator XYZ grid this Leaflet map
 *   (and every other national layer on it) lives in, and the 6870 grid is
 *   not even a power-of-two pyramid, so tiles fetched as XYZ would land in
 *   the wrong place. Re-projecting tile pixels client-side for nine layers
 *   (the Danish DHM trick) is possible but wasteful; GeoServer re-projects
 *   server-side for free, so — exactly like the Polish GUGiK layer — every
 *   request below is a WMS 1.1.1 GetMap for the Leaflet tile bbox in
 *   EPSG:3857, with an automatic per-layer fallback to EPSG:4326 built into
 *   js/asig-albania-layers.js. If a dedicated EPSG:6870 map is ever wanted,
 *   the WMTS endpoint and matrix set are recorded in `endpoints` for that
 *   future work.
 *
 * WARNING — the protected-sites layer names embed SNAPSHOT DATES
 *   (e.g. ...22_07_2026, ...13_05_2026). ASIG publishes new versions under
 *   new names. When a protected layer stops drawing, re-check the names:
 *     https://geoportal.asig.gov.al/service/wms?SERVICE=WMS&REQUEST=GetCapabilities
 *   and update ONLY this file (search for "snapshot").
 *
 * Field reference (every entry carries all of them):
 *   id              stable id; the panel row, the registry entry
 *                   (`albania.<id>`) and localStorage all use it
 *   title           { ro, en } — the row label and the info popup title
 *   group           'raster'    → independent checkbox basemaps/overlays
 *                   'protected' → the "Protected Sites" child checkboxes
 *   layers          WMS LAYERS value, exactly as published
 *   format          WMS FORMAT (image/jpeg only where the product is JPEG-only)
 *   transparent     WMS TRANSPARENT (true for hillshades + vector overlays)
 *   opacity         initial opacity (0–1); the LiDAR hillshade starts at 0.5
 *                   so an orthophoto stacked underneath stays readable
 *   order           draw order inside the Albanian stack, bottom → top
 *   minZoom         when the row may draw
 *   maxNativeZoom   last level with real data; beyond it the browser upscales
 *   defaultOn       switched on by the group master switch when nothing was
 *                   chosen yet (nothing is ever requested before a switch)
 *   attributionRow  short credit for the row's ⓘ popup
 *   description     one-paragraph ⓘ popup text (plain text, no markup)
 *   notes           developer note
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

    var CONFIG = {
        version: '20261017-albania-v1',
        provider: 'ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor',
        licence: 'ASIG terms of use (no explicit licence in the capabilities — verify redistribution terms)',

        /* Country this group belongs to. Drives the country filter (rows are
         * shown when Albania is the selected country) and the coverage check. */
        country: 'AL',
        countryBounds: [[39.538, 18.773], [42.758, 21.179]],

        /* Only used by the “Go to Albania” button of the group row — the map's
         * own start view is never changed by this feature. */
        view: { center: [41.3275, 19.8187], zoom: 9, label: { ro: 'Tirana', en: 'Tirana' } },

        /* Panel group row. */
        groupLabel: { ro: 'Albania · hărți ASIG', en: 'Albania · ASIG geoportal' },
        groupInfo: {
            ro: 'Hărți și date pentru Albania de la geoportalul de stat ASIG: hillshade LiDAR (MDT 2015) și DSM, ' +
                'ortofotoplanuri (1999 / 1994), harta topografică 1:50.000 și patru straturi de arii protejate ' +
                '(IKTK / AKZM). Servite ca WMS în EPSG:3857; sursa nativă este EPSG:6870. Sursa apare pe hartă ' +
                'cât timp un strat este pornit.',
            en: 'Albanian state geoportal (ASIG) layers: LiDAR hillshade (2015 DTM) and DSM hillshade, ' +
                'orthophotos (1999 / 1994), the 1:50,000 topographic map and four protected-sites overlays ' +
                '(IKTK / AKZM). Served as WMS in EPSG:3857; the native CRS is EPSG:6870. The required credit ' +
                'is shown on the map while a layer is on.'
        },

        endpoints: {
            /* WMS 1.1.1 — what the browser calls (one GetMap per Leaflet tile). */
            wms: 'https://geoportal.asig.gov.al/service/wms',
            /* Same layer catalogue as pre-rendered tiles: would need a map in
             * the native EPSG:6870 grid — kept here for that future work. */
            wmts: 'https://geoportal.asig.gov.al/service/wmts',
            capabilities: {
                wms: 'https://geoportal.asig.gov.al/service/wms?SERVICE=WMS&REQUEST=GetCapabilities',
                wmts: 'https://geoportal.asig.gov.al/service/wmts?request=GetCapabilities'
            },
            nativeCrs: 'EPSG:6870',       /* ETRS89 / Albania TM 2010 */
            nativeTileMatrixSet: 'EPSG:6870',
            style: 'default'              /* the capabilities' style id is empty; the portal sends style=default */
        },

        /* Shared WMS request parameters for every layer below. */
        wms: {
            url: 'https://geoportal.asig.gov.al/service/wms',
            version: '1.1.1',
            /* EPSG:3857 keeps everything aligned with the basemap for free.
             * FALLBACK_CRS is used automatically per layer if 3857 ever starts
             * failing (GeoServer advertises EPSG:4326 for the whole catalogue). */
            crs: 'EPSG:3857',
            fallbackCrs: 'EPSG:4326',
            fallbackAfterErrors: 6,
            styles: '',
            tileSize: 256,
            keepBuffer: 1            /* public government service: barely preload */
        },

        attribution: ATTRIBUTION,

        layers: [
            /* ── Raster basemaps / overlays (bottom → top) ────────────────── */
            {
                id: 'topo50k',
                title: { ro: 'Hartă topografică 1:50k', en: 'Topographic map 1:50k' },
                group: 'raster',
                layers: 'Topografike:50K_Topografike',
                format: 'image/png',
                transparent: false,
                opacity: 1,
                order: 10,
                minZoom: 7,
                maxNativeZoom: 17,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Albanian 1:50,000 topographic base map, rendered live by the ASIG WMS ' +
                    '(layer Topografike:50K_Topografike; the identical pre-tiled product is published as WMTS ' +
                    'on the EPSG:6870 grid). Opaque: it is used instead of the basemap, on its own or under ' +
                    'the hillshades. Albania only.',
                notes: 'WMTS twin (EPSG:6870 matrix set): layer Topografike:50K_Topografike, image/png.'
            },
            {
                id: 'ortho1999',
                title: { ro: 'Ortofoto 1999', en: 'Orthophoto 1999' },
                group: 'raster',
                layers: 'Orthophoto:Ortofoto_1999',
                format: 'image/png',
                transparent: false,
                opacity: 1,
                order: 20,
                minZoom: 7,
                maxNativeZoom: 18,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'The 1999 national orthophoto mosaic of Albania, rendered live by the ASIG WMS ' +
                    '(layer Orthophoto:Ortofoto_1999). Opaque: use it instead of the basemap, possibly with a ' +
                    'hillshade at ~50% on top. Albania only.',
                notes: 'WMTS twin (EPSG:6870 matrix set): layer Orthophoto:Ortofoto_1999, image/png.'
            },
            {
                id: 'ortho1994',
                /* The integration brief called this row "Orthophoto 1994" and the
                 * site owner confirmed that label. The underlying ASIG product is
                 * orthophoto_2015:OrthoImagery_20cm (the capabilities publish no
                 * 1994 layer) — see the description and ALBANIA_ASIG_LAYERS.md. */
                title: { ro: 'Ortofoto 1994', en: 'Orthophoto 1994' },
                group: 'raster',
                layers: 'orthophoto_2015:OrthoImagery_20cm',
                format: 'image/jpeg',
                transparent: false,
                opacity: 1,
                order: 30,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'High-resolution national orthophoto served by the ASIG WMS as ' +
                    'orthophoto_2015:OrthoImagery_20cm (the 2015 survey at 20 cm; the service catalogue ' +
                    'lists no 1994 layer — the label follows the project brief). JPEG, opaque: use it ' +
                    'instead of the basemap, possibly with a hillshade at ~50% on top. Albania only.',
                notes: 'JPEG-only product (the WMTS advertises image/jpeg). WMTS twin: ' +
                    'orthophoto_2015:OrthoImagery_20cm on the EPSG:6870 matrix set.'
            },
            {
                id: 'dsm',
                title: { ro: 'DSM (hillshade)', en: 'DSM (hillshade)' },
                group: 'raster',
                layers: 'DSM:Dsm_Hill_Group',
                format: 'image/png',
                transparent: true,
                opacity: 0.6,
                order: 40,
                minZoom: 7,
                maxNativeZoom: 18,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Hillshade of the Albanian digital SURFACE model (canopy and buildings), ' +
                    'rendered live by the ASIG WMS (layer DSM:Dsm_Hill_Group). Semi-transparent by default ' +
                    'so it can tone an orthophoto or the topographic map underneath. Albania only.',
                notes: 'WMTS twin (EPSG:6870 matrix set): DSM:Dsm_Hill_Group, image/png.'
            },
            {
                id: 'lidar',
                /* Not a point cloud: a hillshade derived from the 2015 DTM. */
                title: { ro: 'LiDAR', en: 'LiDAR' },
                group: 'raster',
                layers: 'Dtm_2015:Hillshade_2015_group',
                format: 'image/png',
                transparent: true,
                opacity: 0.5,
                order: 50,
                minZoom: 7,
                maxNativeZoom: 18,
                defaultOn: true,
                attributionRow: ATTRIBUTION,
                description: '“LiDAR” is a hillshade derived from the national 2015 LiDAR digital terrain ' +
                    'model (ASIG layer Dtm_2015:Hillshade_2015_group), rendered live by the WMS. Starts at ' +
                    '50% opacity — the intended read is over an orthophoto or the topographic map. ' +
                    'Albania only.',
                notes: 'WMTS twin (EPSG:6870 matrix set): Dtm_2015:Hillshade_2015_group, image/png. ' +
                    'Reference tile verified by the site owner: TileMatrix EPSG:6870:6, col 65, row 83.'
            },

            /* ── “Protected Sites” group (transparent WMS vector overlays) ──
             * SNAPSHOT DATES in the names — re-check GetCapabilities before
             * renaming anything here (see the file header). */
            {
                id: 'heritage',
                title: { ro: 'Situri de patrimoniu', en: 'Heritage Sites' },
                group: 'protected',
                layers: 'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
                format: 'image/png',
                transparent: true,
                opacity: 0.85,
                order: 60,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Protected cultural-heritage zones (IKTK — Instituti i Kulturës), polygons ' +
                    'drawn on top of every Albanian raster. Transparent ASIG WMS overlay; the layer name ' +
                    'carries the publication snapshot (22_07_2026).',
                notes: 'SNAPSHOT name: iktk:zonatembrojturatetrashegimisekulturore22_07_2026.'
            },
            {
                id: 'natural',
                title: { ro: 'Arii naturale protejate', en: 'Natural Protected Sites' },
                group: 'protected',
                layers: 'akzm:zonat_mbrojtura_081124',
                format: 'image/png',
                transparent: true,
                opacity: 0.85,
                order: 70,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Legally protected natural areas (AKZM — Agjencia e Zonave të Mbrojtura / ' +
                    'National Agency of Protected Areas), polygons over every Albanian raster. Transparent ' +
                    'ASIG WMS overlay; the layer name carries the publication snapshot (08_11_24).',
                notes: 'SNAPSHOT name: akzm:zonat_mbrojtura_081124.'
            },
            {
                id: 'cultural',
                title: { ro: 'Situri culturale protejate', en: 'Cultural Protected Sites' },
                group: 'protected',
                layers: 'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
                format: 'image/png',
                transparent: true,
                opacity: 0.85,
                order: 80,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Protected cultural-heritage POINTS (IKTK), over every Albanian raster. ' +
                    'Transparent ASIG WMS overlay; the layer name carries the publication snapshot ' +
                    '(13_05_2026).',
                notes: 'SNAPSHOT name: iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026.'
            },
            {
                id: 'monument',
                title: { ro: 'Monumente ale naturii', en: 'Environment: Natural monument' },
                group: 'protected',
                layers: 'akzm:monumentet_natyrore_07032023',
                format: 'image/png',
                transparent: true,
                opacity: 0.85,
                order: 90,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Natural monuments (environment category, AKZM), over every Albanian raster. ' +
                    'Transparent ASIG WMS overlay; the layer name carries the publication snapshot ' +
                    '(07_03_2023).',
                notes: 'SNAPSHOT name: akzm:monumentet_natyrore_07032023.'
            }
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

    /* The Albanian stack, bottom → top, exactly as `order` sorts it. */
    CONFIG.drawOrder = function () {
        return CONFIG.enabledLayers().slice().sort(function (a, b) { return a.order - b.order; });
    };

    return CONFIG;
}));
