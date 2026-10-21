/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Albania (ASIG geoportal) data layers · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * Every Albania ASIG layer rendered by this module is described here.
 * js/asig-albania-layers.js renders the panel rows, builds the Leaflet layers
 * and runs the raster/overlay logic from this list; adding, removing or
 * re-labelling a layer is a change to this file only — no map code has to be
 * touched. js/layer-registry.js mirrors the enabled entries (ids
 * `albania.<id>`) so the layers are also catalogued for the diagnostics, the
 * 3D status report and the offline audit (tools/audit-wms-layers.mjs).
 *
 * PANEL PLACEMENT — one Albania-only group
 *   All nine rows are mounted in a single group row (`#albaniaRow` →
 *   `#albaniaSubLayers`) that belongs to Albania exclusively. They are NOT
 *   rendered inside the Romanian/Denmark/Finland sections any more (an
 *   orthophoto used to appear between Romania's satellite periods, the
 *   heritage rows under Romania's Heritage Sites and the two hillshades
 *   under the LiDAR group that hosts Denmark's DHM). `section` still decides
 *   the Leaflet pane/z-order and the small caption inside the group; it no
 *   longer decides where the row is mounted. The group and every row are
 *   hidden unless Albania (ISO2 `AL`) is the selected country — see
 *   `country` below.
 *
 * Source: geoportal.asig.gov.al — Autoriteti Shtetëror për Informacionin
 * Gjeohapësinor (ASIG, the Albanian State Authority for Geospatial
 * Information). GeoServer + GeoWebCache, public, no key, no token, HTTPS.
 *
 * Projection notes
 *   The owner-supplied GetCapabilities excerpt advertises WMS 1.3.0, EPSG:6870,
 *   EPSG:4326, EPSG:900913 and CRS:84. EPSG:6870 is native and the WMTS matrix
 *   set; no XYZ grid is inferred from it. Existing 2D requests keep EPSG:3857
 *   as the first path and fall back to EPSG:4326 after repeated tile errors.
 *   The excerpt does not literally list EPSG:3857, so acceptance is not claimed
 *   without the required same-origin production proxy probe.
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
 *   section         theme inside the single Albania group, and the Leaflet
 *                   pane: historical/satellite/lidar/heritage
 *   registryGroup   existing shared catalogue group/z-order
 *   layers          WMS LAYERS value, exactly as published
 *   format          WMS FORMAT (image/jpeg only where the product is JPEG-only)
 *   transparent     WMS TRANSPARENT (true for hillshades + vector overlays)
 *   opacity         initial opacity (0–1); the LiDAR hillshade starts at 0.5
 *                   so an orthophoto stacked underneath stays readable
 *   order           draw order inside the Albanian stack, bottom → top
 *   minZoom         when the row may draw
 *   maxNativeZoom   last level with real data; beyond it the browser upscales
 *   defaultOn       legacy migration metadata; no row is enabled on a fresh install
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
        version: '20261021-albania-country-group',
        provider: 'ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor',
        licence: 'ASIG terms of use (no explicit licence in the capabilities — verify redistribution terms)',

        /* ISO2 of the only country these rows belong to. The panel group and
         * every row are hidden (and their tile layers taken off the map) for
         * any other selection, including the global view with no country. */
        country: 'AL',
        groupLabel: { ro: 'Albania · geoportalul ASIG', en: 'Albania · ASIG geoportal' },
        groupInfo: 'Nine public ASIG WMS products for Albania: the 1:50,000 topographic map, the 1999 ' +
            'and 2015 (20 cm) orthophotos, the DSM and 2015 DTM hillshades, and the four protected-site ' +
            'overlays (cultural heritage zones, protected cultural points, protected natural areas and ' +
            'natural monuments). Every request is clipped to the ASIG footprint, so the rows belong to ' +
            'Albania only and appear only in the Albania view. Source: geoportal.asig.gov.al.',

        /* WGS84 coverage used to clip each WMS BBOX (west, south, east, north).
         * Geography, not a selector: the panel rows are scoped by `country`. */
        countryBounds: [[39.538, 18.773], [42.758, 21.179]],
        view: { center: [41.3275, 19.8187], zoom: 9, label: { ro: 'Tirana', en: 'Tirana' } },

        /* Captions inside the single Albania group. `section` keeps its job of
         * choosing the Leaflet pane/z-order; these labels spell out the theme
         * of the rows that follow them. */
        sectionLabels: {
            historical: { ro: 'Hărți istorice', en: 'Historical maps' },
            satellite: { ro: 'Satelit', en: 'Satellite' },
            lidar: { ro: 'LiDAR', en: 'LiDAR' },
            heritage: { ro: 'Patrimoniu', en: 'Heritage sites' }
        },

        endpoints: {
            /* The app currently calls a tiled WMS GetMap endpoint. */
            wms: 'https://geoportal.asig.gov.al/service/wms',
            capabilities: {
                wms: 'https://geoportal.asig.gov.al/service/wms?SERVICE=WMS&REQUEST=GetCapabilities',
                wmsVersion: '1.3.0',
                getMapFormats: ['image/png', 'image/jpeg'],
                rootCrs: ['EPSG:6870', 'EPSG:4326', 'EPSG:900913', 'CRS:84'],
                defaultStyle: ''
            },
            nativeCrs: 'EPSG:6870',       /* ETRS89 / Albania TM 2010; owner-supplied capabilities */
            nativeTileMatrixSet: 'EPSG:6870' /* no hand-built XYZ grid */
        },

        /* Shared WMS request parameters for every layer below. */
        wms: {
            url: 'https://geoportal.asig.gov.al/service/wms',
            version: '1.3.0',
            /* The current map path requests Web Mercator. The owner-supplied
             * capabilities list EPSG:900913, not EPSG:3857; keep this request
             * path but require live proxy evidence before claiming acceptance. */
            crs: 'EPSG:3857',
            fallbackCrs: 'EPSG:4326',
            fallbackAfterErrors: 6,
            styles: '',
            tileSize: 256,
            keepBuffer: 1            /* public government service: barely preload */
        },

        attribution: ATTRIBUTION,

        layers: [
            /* Mounted in the single Albania-only group (#albaniaSubLayers); the
             * registry groups keep the shared catalogue z-order. */
            {
                id: 'topo50k',
                section: 'historical',
                registryGroup: 'hist-free',
                registryZ: 640,
                title: { ro: 'Hartă topografică 1:50k', en: 'Topographic map 1:50k' },

                layers: 'Topografike:50K_Topografike',
                format: 'image/png',
                transparent: false,
                opacity: 1,
                order: 10,
                minZoom: 7,
                maxNativeZoom: 17,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Albanian 1:50,000 topographic map, rendered live by the ASIG WMS. Opaque; ' +
                    'requests are clipped to the ASIG coverage bounds.',
                notes: 'Owner-supplied WMS capabilities list this exact Name and image/png.'
            },
            {
                id: 'ortho1999',
                section: 'satellite',
                registryGroup: 'sat-hist',
                registryZ: 400,
                title: { ro: 'Ortofoto 1999', en: 'Orthophoto 1999' },

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
                    'hillshade at ~50% on top. Requests are clipped to the ASIG coverage bounds.',
                notes: 'Owner-supplied WMS capabilities list this exact Name and image/png.'
            },
            {
                id: 'ortho1994',
                section: 'satellite',
                registryGroup: 'sat-hist',
                registryZ: 401,
                title: { ro: 'Ortofoto 20 cm (2015)', en: 'Orthophoto 20 cm (2015)' },
                layers: 'orthophoto_2015:OrthoImagery_20cm',
                format: 'image/jpeg',
                transparent: false,
                opacity: 1,
                order: 30,
                minZoom: 7,
                maxNativeZoom: 19,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: 'Catalogued 2015 national orthophoto at 20 cm resolution, served by the ASIG WMS as ' +
                    'orthophoto_2015:OrthoImagery_20cm. JPEG and opaque; use with a hillshade above it.',
                notes: 'Owner-supplied WMS capabilities list image/jpeg; this is the catalogued 2015 20 cm product.'
            },
            {
                id: 'dsm',
                section: 'lidar',
                registryGroup: 'lidar',
                registryZ: 610,
                title: { ro: 'DSM (hillshade)', en: 'DSM (hillshade)' },

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
                    'so it can tone an orthophoto or the topographic map underneath. Requests are clipped to the ASIG coverage bounds.',
                notes: 'Owner-supplied WMS capabilities list this exact Name and image/png.'
            },
            {
                id: 'lidar',
                section: 'lidar',
                registryGroup: 'lidar',
                registryZ: 611,
                /* Not a point cloud: a hillshade derived from the 2015 DTM. */
                title: { ro: 'LiDAR', en: 'LiDAR' },

                layers: 'Dtm_2015:Hillshade_2015_group',
                format: 'image/png',
                transparent: true,
                opacity: 0.5,
                order: 50,
                minZoom: 7,
                maxNativeZoom: 18,
                defaultOn: false,
                attributionRow: ATTRIBUTION,
                description: '“LiDAR” is a hillshade derived from the national 2015 LiDAR digital terrain ' +
                    'model (ASIG layer Dtm_2015:Hillshade_2015_group), rendered live by the WMS. Starts at ' +
                    '50% opacity — the intended read is over an orthophoto or the topographic map. ' +
                    'Requests are clipped to the ASIG coverage bounds.',
                notes: 'Owner-supplied WMS capabilities list this exact Name and image/png.'
            },

            /* Four independent heritage rows. Snapshot dates stay explicit in titles,
             * notes and info text so stale source names are discoverable. */
            {
                id: 'heritage',
                section: 'heritage',
                registryGroup: 'patrimoniu',
                registryZ: 620,
                title: { ro: 'Situri de patrimoniu', en: 'Heritage Sites' },

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
                    'carries the publication snapshot (22 July 2026; _22_07_2026).',
                notes: 'SNAPSHOT name: iktk:zonatembrojturatetrashegimisekulturore22_07_2026.'
            },
            {
                id: 'natural',
                section: 'heritage',
                registryGroup: 'patrimoniu',
                registryZ: 621,
                title: { ro: 'Arii naturale protejate', en: 'Natural Protected Sites' },

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
                    'ASIG WMS overlay; the layer name carries the publication snapshot (8 November 2024; _081124).',
                notes: 'SNAPSHOT name: akzm:zonat_mbrojtura_081124.'
            },
            {
                id: 'cultural',
                section: 'heritage',
                registryGroup: 'patrimoniu',
                registryZ: 622,
                title: { ro: 'Situri culturale protejate', en: 'Cultural Protected Sites' },

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
                    '(13 May 2026; _13_05_2026).',
                notes: 'SNAPSHOT name: iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026.'
            },
            {
                id: 'monument',
                section: 'heritage',
                registryGroup: 'patrimoniu',
                registryZ: 623,
                title: { ro: 'Monumente ale naturii', en: 'Environment: Natural monument' },

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
                    '(7 March 2023; _07032023).',
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
