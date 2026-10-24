/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Albania (ASIG geoportal) layers · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * The catalogue itself (sections, display titles, exact `workspace:name`
 * values, endpoints, Heritage parts) lives in data/asig-layers.json and is
 * GENERATED from the prototype export by tools/build-asig-catalogue.mjs.
 * data/asig-layers.data.js is the same object wrapped for a plain <script>
 * tag (and for Node's require), so both the browser and the audit tools read
 * one synchronous, identical source — this repo has no bundler.
 *
 * This file adds only what the map needs on top of that data: the service
 * request rules (endpoints, CRS, WMS/WMTS parameters, tile size), the pane and
 * registry metadata per section, zoom limits, the labels, and the API surface
 * the rest of the app consumes (CONFIG.layers, byId, drawOrder, …).
 *
 * PANEL PLACEMENT — one Albania-only group
 *   Every row is mounted in the single group (`#albaniaRow` →
 *   `#albaniaSubLayers`) that belongs to Albania exclusively, in the Gratis /
 *   Free tab. Heritage is ONE toggle at the top of that group; its parts are
 *   never rows of their own.
 *
 * Source: geoportal.asig.gov.al — Autoriteti Shtetëror për Informacionin
 * Gjeohapësinor (ASIG, the Albanian State Authority for Geospatial
 * Information). GeoServer + GeoWebCache, public, no key, no token, HTTPS.
 *
 * Projection notes (observed)
 *   • WMS: the portal's own map asks WMS with SRS=EPSG:6870; the app asks
 *     Web Mercator first and falls back to EPSG:4326 after a tile-error burst
 *     (the owner-supplied capabilities advertise EPSG:6870, EPSG:4326,
 *     EPSG:900913 and CRS:84).
 *   • WMTS: the 50 layers are linked ONLY to the EPSG:6870 and EPSG:4326
 *     tile-matrix sets — there is no Web-Mercator grid. The three tile-only
 *     rows (Hillshade 2015 group, Dsm Hill Group, italiane 100k) are therefore
 *     mosaicked from the plate-carrée (EPSG:4326) grid and reprojected onto
 *     Web Mercator tiles in the browser (js/asig-albania-layers.js).
 *
 * WARNING — some protected-sites layer names embed SNAPSHOT DATES
 *   (e.g. …_pike13_05_2026). ASIG publishes new versions under new names.
 *   Re-export the prototype's layer list and re-run the generator; do not
 *   hand-rename a layer.
 * ══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root && api) {
        root.ASIG_ALBANIA_CONFIG = api;
        root.ASIG_ALBANIA_LAYERS = api;
    }
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var CATALOGUE = root && root.ASIG_LAYERS_CATALOGUE;
    if (!CATALOGUE && typeof require === 'function') {
        try { CATALOGUE = require('../data/asig-layers.data.js'); } catch (e) { CATALOGUE = null; }
    }
    if (!CATALOGUE || !Array.isArray(CATALOGUE.sections)) return null;

    var ATTRIBUTION = CATALOGUE.attribution ||
        'Data: ASIG, Albanian State Authority for Geospatial Information (geoportal.asig.gov.al)';

    /* Registry group + z-order per catalogue section. The group is only the
     * shared catalogue's bucket (used by the diagnostics, the 3D status report
     * and the offline audit); the panel mounts every row in the Albania group.
     * `pane` is the ONE Leaflet pane the catalogue draws in: the active-layer
     * list is a real z-order, so all rows must share a pane for reordering to
     * mean anything. */
    var SECTION_META = {
        orthophotos: { registryGroup: 'sat-hist', registryZ: 400 },
        terrain: { registryGroup: 'lidar', registryZ: 610 },
        cadastre: { registryGroup: 'uat', registryZ: 402 },
        maps: { registryGroup: 'hist-free', registryZ: 640 },
        environment: { registryGroup: 'asig-env', registryZ: 618 },
        planning: { registryGroup: 'asig-plan', registryZ: 646 },
        heritage: { registryGroup: 'patrimoniu', registryZ: 620 }
    };

    var SECTION_NOTES = {
        orthophotos: 'National orthophoto mosaics served by the ASIG WMS. Opaque products are best used ' +
            'instead of the basemap; the CIR products are colour-infrared and read vegetation differently.',
        terrain: 'Hillshades derived from the national DTM/DSM. Tile-only: the WMS service answers ' +
            'LayerNotDefined for these names, so they are read from the WMTS plate-carrée grid and ' +
            'reprojected in the browser.',
        cadastre: 'Cadastral zones and parcels (ASHK). Transparent overlays on top of an orthophoto.',
        maps: 'Historical and topographic map sheets published by ASIG.',
        environment: 'Hydrography overlay (water course links).',
        planning: 'Planning and mining layers published by ASIG after Council of Ministers decisions ' +
            '(DCM). Hazard and permit extents are the authority’s published ones, not legal advice.',
        heritage: 'Archaeological, cultural and natural protected areas. They change as ASIG publishes ' +
            'new Council of Ministers zoning decisions, so this list is regenerated from the export.'
    };

    var WMTS = {
        url: CATALOGUE.service.wmts,
        version: CATALOGUE.service.wmtsVersion || '1.0.0',
        style: CATALOGUE.service.wmtsStyle || 'default',
        tileMatrixSet: CATALOGUE.service.wmtsTileMatrixSet || 'EPSG:4326',
        tileMatrixPrefix: CATALOGUE.service.wmtsTileMatrixPrefix || 'EPSG:4326:',
        format: CATALOGUE.service.wmtsFormat || 'image/png',
        tileSize: 256,
        /* The deepest source level ASIG serves is unknown; the layer steps down
         * to a shallower, already-cached level at run time (and says so). */
        maxSourceZoom: 21,
        keepBuffer: 1
    };

    var CONFIG = {
        version: '20261024-asig-catalogue',
        provider: 'ASIG — Autoriteti Shtetëror për Informacionin Gjeohapësinor',
        licence: (CATALOGUE.licence && CATALOGUE.licence.note) ||
            'ASIG terms of use are not stated in the supplied capabilities — verify redistribution terms.',
        licenceState: (CATALOGUE.licence && CATALOGUE.licence.state) || 'unverified',

        /* ISO2 of the only country these rows belong to. */
        country: 'AL',
        groupLabel: { ro: 'Albania · geoportalul ASIG', en: 'Albania · ASIG geoportal' },
        groupInfo: 'The ASIG geoportal catalogue for Albania: orthophotos, hillshades, cadastre, ' +
            'historical sheets, environment and planning/mining layers, plus one Heritage toggle that ' +
            'switches on every archaeological, cultural and natural protected area at once. Source: ' +
            'geoportal.asig.gov.al.',

        /* WGS84 coverage used to clip each WMS BBOX (south-west / north-east). */
        countryBounds: CATALOGUE.bounds || [[39.538, 18.773], [42.758, 21.179]],
        view: { center: [41.3275, 19.8187], zoom: 9, label: { ro: 'Tirana', en: 'Tirana' } },

        sectionLabels: CATALOGUE.sectionLabels || {},
        sectionNotes: SECTION_NOTES,

        catalogue: CATALOGUE,

        endpoints: {
            wms: CATALOGUE.service.wms,
            wmts: CATALOGUE.service.wmts,
            serviceRoot: CATALOGUE.service.root,
            capabilities: {
                wms: CATALOGUE.service.wms + '?service=WMS&version=1.3.0&request=GetCapabilities',
                wmsVersion: '1.3.0',
                getMapFormats: ['image/png', 'image/jpeg'],
                rootCrs: ['EPSG:6870', 'EPSG:4326', 'EPSG:900913', 'CRS:84'],
                defaultStyle: ''
            },
            nativeCrs: CATALOGUE.service.nativeCrs || 'EPSG:6870',
            nativeTileMatrixSet: 'EPSG:6870'
        },

        /* Shared WMS request parameters. */
        wms: {
            url: CATALOGUE.service.wms,
            version: '1.3.0',
            crs: 'EPSG:3857',
            fallbackCrs: 'EPSG:4326',
            fallbackAfterErrors: 6,
            /* The prototype sends one GetMap per 512-px tile with zoomOffset
             * -1 (a 256-px grid image per request); the audit tool builds the
             * regression URL at 256, and both must stay in step with this. */
            tileSize: 256,
            keepBuffer: 1,
            styles: ''
        },

        wmts: WMTS,

        /* Feature info (map click). Prototype behaviour: ask every active WMS
         * layer, grouped by endpoint, and render the answer in a sandboxed
         * iframe (no script execution, no CORS requirement for the fallback). */
        featureInfo: {
            format: 'text/html',
            featureCount: 10,
            maxWidth: 420,
            minWidth: 280
        },

        /* Run-time name resolution for rows the export did not name yet. It
         * runs in the visitor's browser (ASIG blacklists some cloud IPs) and
         * remembers the answer for a week; the baked catalogue is always
         * preferred. See ALBANIA_ASIG_LAYERS.md. */
        resolver: {
            enabled: true,
            capabilitiesUrl: CATALOGUE.service.wms + '?service=WMS&version=1.3.0&request=GetCapabilities',
            cacheKey: 'detectlab_asig_capabilities_v1',
            ttlMs: 7 * 24 * 60 * 60 * 1000,
            keyword: CATALOGUE.heritage && CATALOGUE.heritage.keyword
        },

        attribution: ATTRIBUTION,

        sections: [],
        layers: [],
        heritage: null
    };

    function title(title) {
        /* The catalogue titles are the portal's own English display names and
         * are kept verbatim in both languages (as the owner asked). */
        return { ro: title, en: title };
    }

    function partDef(part, groupId) {
        return {
            id: part.id,
            group: groupId,
            kind: part.kind === 'wmts' ? 'wmts' : 'wms',
            title: title(part.title),
            name: part.name || '',
            layers: part.name || '',
            url: part.url || CATALOGUE.service.wms,
            fallbackUrl: part.fallbackUrl || CATALOGUE.service.wms,
            format: part.format || 'image/png',
            transparent: part.transparent !== false,
            resolveByTitle: part.resolveByTitle || '',
            keywordMatch: !!part.keywordMatch,
            /* The catalogue carries one dynamic placeholder: the rule that adds
             * every archaeological layer the browser discovers. It is not a
             * part, so it is never counted, drawn or listed. */
            dynamic: !!part.dynamic,
            nameSource: part.nameSource || ''
        };
    }

    function layerDef(layer, section) {
        var meta = SECTION_META[section.id] || SECTION_META.orthophotos;
        var kind = layer.kind === 'wmts' ? 'wmts' : 'wms';
        var def = {
            id: layer.id,
            section: section.id,
            sectionTitle: section.title,
            registryGroup: meta.registryGroup,
            registryZ: meta.registryZ,
            kind: kind,
            title: title(layer.title),
            name: layer.name || '',
            /* The registry/audit contract calls the LAYERS value `layers`. */
            layers: layer.name || '',
            url: layer.url || CATALOGUE.service.wms,
            fallbackUrl: layer.fallbackUrl || CATALOGUE.service.wms,
            format: layer.format || 'image/png',
            transparent: layer.transparent !== false,
            opacity: typeof layer.opacity === 'number' ? layer.opacity : 1,
            minZoom: layer.minZoom || 7,
            maxNativeZoom: layer.maxNativeZoom || (kind === 'wmts' ? 20 : 19),
            resolveByTitle: layer.resolveByTitle || '',
            nameSource: layer.nameSource || '',
            retained: !!layer.retained,
            notes: '',
            description: ''
        };
        def.notes = def.layers
            ? 'Exact ASIG ' + (kind === 'wmts' ? 'WMTS' : 'WMS') + ' name: ' + def.layers + '.'
            : 'Name not in the catalogue yet: resolved by title “' + def.title.en +
                '” from the service capabilities in the browser.';
        def.description = (SECTION_NOTES[section.id] || '') + ' ' + def.notes +
            (kind === 'wmts' ? ' Tile-only product: read from the WMTS plate-carrée grid and reprojected to Web Mercator.' : '');
        return def;
    }

    /* Flatten the catalogue: sections bottom → top, Heritage on top. `order`
     * is the default draw order of the active-layer list (bottom → top). */
    var bottomToTop = CONFIG.catalogue.sections.slice();
    bottomToTop.forEach(function (section, index) {
        CONFIG.sections.push({ id: section.id, title: section.title, label: section.label || title(section.title) });
        section.layers.forEach(function (layer, layerIndex) {
            var def = layerDef(layer, section);
            def.order = 100 + index * 100 + layerIndex;
            CONFIG.layers.push(def);
        });
    });

    var heritageParts = ((CATALOGUE.heritage && CATALOGUE.heritage.parts) || []).map(function (part) {
        return partDef(part, 'heritage');
    });
    CONFIG.heritage = {
        id: (CATALOGUE.heritage && CATALOGUE.heritage.id) || 'heritage',
        title: (CATALOGUE.heritage && CATALOGUE.heritage.title) || 'Heritage',
        keyword: (CATALOGUE.heritage && CATALOGUE.heritage.keyword) || 'archaeolog|archeolog|arkeolog',
        opacity: (CATALOGUE.heritage && CATALOGUE.heritage.opacity) || 0.85,
        parts: heritageParts
    };
    CONFIG.sections.unshift({ id: 'heritage', title: CONFIG.heritage.title, label: title(CONFIG.heritage.title) });
    var heritageDef = {
        id: CONFIG.heritage.id,
        section: 'heritage',
        sectionTitle: CONFIG.heritage.title,
        registryGroup: SECTION_META.heritage.registryGroup,
        registryZ: SECTION_META.heritage.registryZ,
        kind: 'group',
        title: title(CONFIG.heritage.title),
        name: '',
        /* One registry row with every currently baked WMS part as its LAYERS
         * value (WMS accepts a comma list). Parts discovered later join the
         * map, not this string. */
        layers: heritageParts.filter(function (part) {
            return part.kind === 'wms' && part.layers;
        }).map(function (part) { return part.layers; }).join(','),
        url: CATALOGUE.service.wms,
        fallbackUrl: CATALOGUE.service.wms,
        format: 'image/png',
        transparent: true,
        opacity: CONFIG.heritage.opacity,
        minZoom: 7,
        maxNativeZoom: 19,
        parts: heritageParts,
        keyword: CONFIG.heritage.keyword,
        order: 100 + bottomToTop.length * 100,
        notes: 'One toggle for every Heritage part (' +
            heritageParts.filter(function (part) { return !part.dynamic; }).length +
            ' baked + every archaeological layer found by ' + CONFIG.heritage.keyword + ').',
        description: SECTION_NOTES.heritage
    };
    CONFIG.layers.push(heritageDef);

    var BY_ID = {};
    CONFIG.layers.forEach(function (layer) { BY_ID[layer.id] = layer; });
    heritageParts.forEach(function (part) { if (!BY_ID[part.id]) BY_ID[part.id] = part; });

    CONFIG.byId = function (id) { return BY_ID[id] || null; };

    CONFIG.enabledLayers = function () {
        return CONFIG.layers.filter(function (layer) { return layer.enabled !== false; });
    };

    /* The stack, bottom → top, exactly as `order` sorts it. */
    CONFIG.drawOrder = function () {
        return CONFIG.enabledLayers().slice().sort(function (a, b) { return a.order - b.order; });
    };

    CONFIG.heritageDef = heritageDef;

    /** Per-workspace WMS route for a `workspace:name` value. */
    CONFIG.workspaceUrl = function (name) {
        var text = String(name || '');
        var cut = text.indexOf(':');
        if (cut <= 0) return CONFIG.wms.url;
        return CATALOGUE.service.root + encodeURIComponent(text.slice(0, cut)) + '/wms';
    };

    /** WMTS GetTile URL for a `workspace:name` value on the plate-carrée grid. */
    CONFIG.wmtsTileUrl = function (name, level, col, row) {
        return WMTS.url +
            '?layer=' + encodeURIComponent(name) +
            '&style=' + encodeURIComponent(WMTS.style) +
            '&tilematrixset=' + encodeURIComponent(WMTS.tileMatrixSet) +
            '&Service=WMTS&Request=GetTile&Version=' + encodeURIComponent(WMTS.version) +
            '&Format=' + encodeURIComponent(WMTS.format) +
            '&TileMatrix=' + encodeURIComponent(WMTS.tileMatrixPrefix + level) +
            '&TileCol=' + col + '&TileRow=' + row;
    };

    return CONFIG;
}));
