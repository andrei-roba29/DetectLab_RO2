/*
 * backend/src/lib/danish-layers.config.cjs
 * ───────────────────────────────────────────────────────────────────────────
 * GENERATED MIRROR — do not edit this copy.
 *
 * The canonical file is js/danish-layers.config.js; edit that one and run
 *
 *     node tools/sync-danish-config.mjs
 *
 * It exists because the backend is deployed with backend/ as its own app root
 * (Railway), so nothing inside it may import the repository root. The mirror is
 * byte-for-byte the canonical file below this header, and
 * `node tools/sync-danish-config.mjs --check` — part of the test suite —
 * fails on any drift.
 */

/* ══════════════════════════════════════════════════════════════════════════
 * DetectLab — Danish data layers · THE CONFIG
 * ──────────────────────────────────────────────────────────────────────────
 * Every Danish layer the map can draw is described HERE and nowhere else.
 * js/danish-layers.js renders the panel rows, builds the Leaflet layers and
 * runs the base/overlay logic from this list; adding, removing or disabling a
 * layer is a change to this file only — no map code has to be touched.
 *
 * The file is loaded before js/layer-registry.js, which mirrors the enabled
 * entries into the shared registry (ids `danish.<id>`) so the Danish layers get
 * the same treatment as every other layer: the availability guard
 * (js/wms-health.js), the 3D catalogue (js/map3d-terrain.js), the country
 * filter and the offline audit (tools/audit-wms-layers.mjs).
 *
 * Field reference (every entry carries all of them; `null` where it does not
 * apply, so the shape never changes):
 *
 *   id                  stable id; the panel row, the registry entry
 *                       (`danish.<id>`) and localStorage all use it
 *   title               { da, en } — the row label and the info popup title
 *   group               'base'   → mutually exclusive (one at a time)
 *                       'overlay'→ independent toggles
 *   type                'wms' | 'xyz' | 'wfs'
 *   url                 service endpoint. A same-origin path (/api/geo/…) means
 *                       the deployment adds the credentials server-side and the
 *                       browser never sees them.
 *   layers              WMS LAYERS value (null for xyz / wfs)
 *   crs                 WMS request CRS (EPSG:3857 = the map's own projection)
 *   format              WMS FORMAT
 *   transparent,tiled   WMS TRANSPARENT / TILED
 *   tileSize            request size (256)
 *   version             WMS/WFS protocol version
 *   minZoom,maxZoom     when the row may draw / how far the map may zoom
 *   maxNativeZoom       last level with real data; beyond it the browser
 *                       upscales instead of asking the service for more
 *   attribution         REQUIRED attribution text (CC BY 4.0 etc.) — rendered
 *                       in the map's attribution control while the layer is on
 *   opacity             initial opacity (0–1)
 *   defaultOn           switched on when the map starts
 *   enabled             false → the row is not rendered at all (placeholders)
 *   auth                'token' | 'basic' | 'none'; proxy auth helper uses it
 *   requiresCredentials names of the environment variables the deployment needs
 *   credentialsNote     what a visitor/admins sees if they are missing
 *   provider,licence,licenceUrl,sourcePage   DATA_SOURCES.md facts
 *   bounds              [[south, west], [north, east]] coverage
 *   notes               developer note
 *   wfs                 { typeName, maxFeatures, minZoom, style, popup } for
 *                       type 'wfs' (bbox queries, size-capped, styled)
 *   permission          { required, note } for anything that may not be used
 *                       without written permission (third-party hosts)
 *   directFallback      { url, version, typeName } — a provider that can be
 *                       called straight from the browser when no proxy is
 *                       deployed (local previews). Never used first.
 * ══════════════════════════════════════════════════════════════════════════ */
/** @typedef {'base'|'overlay'} DanishLayerGroup */
/** @typedef {'wms'|'xyz'|'wfs'} DanishLayerType */
/** @typedef {'token'|'basic'|'none'} DanishLayerAuth */
/**
 * @typedef {Object} DanishLayer
 * @property {string} id
 * @property {{da:string,en:string}} title
 * @property {DanishLayerGroup} group
 * @property {DanishLayerType} type
 * @property {string} url
 * @property {string|null} layers
 * @property {string} crs
 * @property {string} format
 * @property {number} minZoom
 * @property {number} maxZoom
 * @property {string} attribution
 * @property {number} opacity
 * @property {boolean} defaultOn
 * @property {boolean} enabled
 * @property {DanishLayerAuth} auth
 * @property {string[]} requiresCredentials
 * @property {string} provider
 * @property {string} licence
 * @property {Array<Array<number>>} bounds
 * @property {string=} selectorGroup
 */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    /* Node (the Netlify functions, the Express backend, the audit tool) gets
     * the very same object: the proxy allow-lists and the docs are generated
     * from this file, so a layer can never be described twice. */
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) {
        root.DANISH_LAYERS_CONFIG = api;
        root.DANISH_LAYERS = api;
    }
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    /* Read at *runtime* by the proxy functions and in the audit; a layer is
     * only credential-gated when the deployment really needs a variable. */
    var CONFIG = {
        version: '20261015-danish-v1',

        /* Country this group belongs to. Drives the country filter (rows are
         * shown when Denmark is the selected country) and the coverage check. */
        country: 'DK',
        countryBounds: [[54.4265, 7.99125], [57.7781, 15.5995]],

        /* Only used by the “Go to Denmark” button of the group row — the map's
         * own start view is never changed by this feature. */
        view: { center: [56.1629, 10.2039], zoom: 9, label: { da: 'Aarhus', en: 'Aarhus' } },

        /* Panel group row. */
        groupLabel: { da: 'Danmark · danske kort', en: 'Denmark · Danish maps' },
        groupInfo: {
            da: 'Danske kort og data: historiske kort, ortofoto og topografiske kort som baggrundskort; LiDAR-terræn, ' +
                'beskyttede naturtyper (NBL § 3) og fredede fortidsminder som temaer. Kildeangivelse vises ' +
                'på kortet, når laget er tændt.',
            en: 'Danish maps and data: historic maps, orthophotos and topographic maps as base maps; LiDAR terrain, ' +
                'protected nature types (NBL § 3) and scheduled ancient monuments as overlays. ' +
                'The required attribution appears on the map while a layer is on.'
        },

        /** @type {DanishLayer[]} */
        layers: [
            /* ── 1. DTK25 topographic base map ─────────────────────────────── */
            {
                id: 'dtk25',
                title: {
                    da: 'Danmark · DTK25 topografisk kort (1:25 000)',
                    en: 'Denmark · DTK25 topographic map (1:25,000)'
                },
                group: 'base',
                type: 'wms',
                /* Same-origin: the proxy adds the account-wide token server-side; it
                 * never reaches the browser. */
                url: '/api/geo/dk-dtk25',
                upstream: 'https://api.dataforsyningen.dk/dtk_25_DAF',
                layers: 'dtk25_2023',
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: false,          /* a base map: it is the picture */
                tiled: true,
                tileSize: 256,
                version: '1.3.0',
                minZoom: 6,
                maxZoom: 20,
                maxNativeZoom: 17,           /* 508 DPI raster, 1:25 000 */
                attribution: 'Kort25 / DTK25 © <a href="https://klimadatastyrelsen.dk/" target="_blank" ' +
                    'rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1,
                defaultOn: true,          /* the one Danish base map that starts on */
                enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'],
                auth: 'token',
                credentialsNote: {
                    da: 'DTK25 kræver en Dataforsyningen-token, som sættes i miljøvariablen ' +
                        'DATAFORSYNINGEN_TOKEN på serveren.',
                    en: 'DTK25 needs a Dataforsyningen token, set as the DATAFORSYNINGEN_TOKEN ' +
                        'environment variable on the server.'
                },
                provider: 'Klimadatastyrelsen (Danish Agency for Climate Data), via Dataforsyningen',
                licence: 'CC BY 4.0',
                licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/956',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Other years are published as dtk25_2002 … dtk25_2023 and dtk25 (latest); see ' +
                    'DATA_SOURCES.md — change `layers` to switch year.',
                wfs: null,
                permission: { required: false, note: '' }
            },

            /* ── 2. GeoDanmark Ortofoto base map ──────────────────────────── */
            {
                id: 'orto',
                title: {
                    da: 'Danmark · GeoDanmark ortofoto (forår)',
                    en: 'Denmark · GeoDanmark orthophoto (spring)'
                },
                group: 'base',
                type: 'wms',
                url: '/api/geo/dk-orto',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2025_12_5cm',
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: false,
                tiled: true,
                tileSize: 256,
                version: '1.3.0',
                minZoom: 6,
                maxZoom: 22,
                maxNativeZoom: 19,           /* 12.5 cm ground sample distance */
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" ' +
                    'rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1,
                defaultOn: false,
                enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'],
                auth: 'basic',
                credentialsNote: {
                    da: 'Ortofoto fra Datafordeleren kræver en tjenestebruger (brugernavn og adgangskode), ' +
                        'som sættes i DATAFORDELER_USERNAME og DATAFORDELER_PASSWORD på serveren.',
                    en: 'The Datafordeler orthophoto needs a service user (username + password), set as ' +
                        'DATAFORDELER_USERNAME and DATAFORDELER_PASSWORD on the server.'
                },
                provider: 'GeoDanmark / Klimadatastyrelsen, distributed by Datafordeleren',
                licence: 'CC BY 4.0',
                licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Other years are published as geodanmark_<year>_10cm / _12_5cm; the layer name is ' +
                    'data-driven (this field) — see DATA_SOURCES.md. Historic years go back to 2012.',
                wfs: null,
                permission: { required: false, note: '' }
            },

            /* ── 3. Protected nature types (NBL § 3) overlay ──────────────── */
            {
                id: 'naturtyper',
                title: {
                    da: 'Danmark · Beskyttede naturtyper (NBL § 3)',
                    en: 'Denmark · Protected nature types (NBL § 3)'
                },
                group: 'overlay',
                type: 'wms',
                /* Public service, no credentials. It is read straight from the
                 * agency's GeoServer: Leaflet draws WMS tiles as plain <img>
                 * elements, which need no CORS — and this host publishes no
                 * Access-Control-Allow-Origin. */
                url: 'https://arealeditering-dist-geo.miljoeportal.dk/geoserver/wms',
                upstream: null,
                layers: 'dai:bes_naturtyper',
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: true,
                tiled: true,
                tileSize: 256,
                version: '1.3.0',
                minZoom: 7,
                maxZoom: 20,
                maxNativeZoom: 18,
                attribution: 'Beskyttede naturtyper © <a href="https://miljoeportal.dk/" target="_blank" ' +
                    'rel="noopener">Danmarks Miljøportal</a> (CC0 1.0)',
                opacity: 0.75,
                defaultOn: false,
                enabled: true,
                requiresCredentials: [],
                auth: 'none',
                credentialsNote: { da: '', en: '' },
                provider: 'Danmarks Miljøportal (kommunerne / Miljøstyrelsen)',
                licence: 'CC0 1.0',
                licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
                sourcePage: 'https://arealdata.miljoeportal.dk/datasets/dai-edit20',
                bounds: [[54.43, 7.99], [57.78, 15.6]],
                notes: 'The service advertises EPSG:25832 and CRS:84 only, but answers EPSG:3857 ' +
                    'GetMap requests correctly (verified 2026-10-15) — the map therefore asks for ' +
                    'Web-Mercator tiles like every other layer.',
                wfs: null,
                permission: { required: false, note: '' }
            },

            /* ── 4. OpenStreetMap base map ────────────────────────────────── */
            {
                id: 'osm',
                title: { da: 'Danmark · OpenStreetMap', en: 'Denmark · OpenStreetMap' },
                group: 'base',
                type: 'xyz',
                url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                upstream: null,
                layers: null,
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: false,
                tiled: true,
                tileSize: 256,
                version: null,
                minZoom: 0,
                /* The community tile servers stop at z19 and ask that clients
                 * do not hammer them; the map upscales above the native level
                 * instead of requesting deeper tiles. */
                maxZoom: 20,
                maxNativeZoom: 19,
                attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" ' +
                    'rel="noopener">OpenStreetMap</a> contributors',
                opacity: 1,
                defaultOn: false,
                enabled: true,
                requiresCredentials: [],
                auth: 'none',
                credentialsNote: { da: '', en: '' },
                provider: 'OpenStreetMap Foundation (community tile servers)',
                licence: 'ODbL 1.0 (data) · tile server usage policy applies',
                licenceUrl: 'https://operations.osmfoundation.org/policies/tiles/',
                sourcePage: 'https://www.openstreetmap.org/copyright',
                bounds: [[-90, -180], [90, 180]],
                notes: 'The OSM tile usage policy is fine for development and small traffic; for a ' +
                    'production site with traffic, point this entry at a commercial provider ' +
                    '(the URL is the only thing that has to change).',
                wfs: null,
                permission: { required: false, note: '' }
            },

            /* ── 5. Historic tiles (third-party host) — DISABLED ─────────── */
            {
                id: 'historic-witx',
                title: { da: 'Danmark · Historiske kort (videnskaberne)', en: 'Denmark · Historic map (videnskaberne)' },
                group: 'base',
                type: 'xyz',
                url: 'https://witx.dk/tiles/videnskaberne/{z}/{x}/{y}.png',
                upstream: null,
                layers: null,
                crs: 'EPSG:3857',
                format: 'image/png',
                transparent: false,
                tiled: true,
                tileSize: 256,
                version: null,
                minZoom: 8,
                maxZoom: 18,
                maxNativeZoom: 14,           /* z14 is the only level seen live */
                attribution: 'Historiske kort © witx.dk (brug ikke uden tilladelse / do not use without permission)',
                opacity: 1,
                defaultOn: false,
                /* Placeholder on purpose: a third-party host, no published
                 * licence and no written permission on file. Flip to true only
                 * after the owner has confirmed in writing. */
                enabled: false,
                requiresCredentials: [],
                auth: 'none',
                credentialsNote: { da: '', en: '' },
                provider: 'witx.dk (third party — NOT an official Danish authority service)',
                licence: 'Unknown / no permission on file — must not be used',
                licenceUrl: '',
                sourcePage: 'https://witx.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Disabled placeholder. Do not hotlink without written permission from the owner; ' +
                    'an official alternative for historic Danish maps is the Royal Library’s ' +
                    'map collection (see DATA_SOURCES.md).',
                wfs: null,
                permission: { required: true, note: 'Written permission from witx.dk required before enabling.' }
            },

            /* ── 6. Fund og Fortidsminder — official service, overlay ────── */
            {
                id: 'fortidsminder',
                title: {
                    da: 'Danmark · Fredede fortidsminder (arealer)',
                    en: 'Denmark · Scheduled ancient monuments (areas)'
                },
                group: 'overlay',
                type: 'wfs',
                /* Same-origin: the proxy validates the bbox, asks the official
                 * WFS in its native EPSG:25832 grid and returns GeoJSON in
                 * EPSG:4326, which Leaflet draws without any projection plugin. */
                url: '/api/geo/dk-heritage',
                upstream: 'https://www.kulturarv.dk/ffgeoserver/public/wfs',
                layers: 'public:fundogfortidsminder_areal_fredet',
                crs: 'EPSG:4326',
                format: 'application/json',
                transparent: true,
                tiled: false,
                tileSize: 256,
                version: '1.0.0',
                /* Features are only fetched from z13 up: below that a bbox query
                 * returns thousands of polygons that are a few pixels wide. */
                minZoom: 13,
                maxZoom: 22,
                maxNativeZoom: 19,
                attribution: 'Fund og Fortidsminder © <a href="https://slks.dk/" target="_blank" ' +
                    'rel="noopener">Slots- og Kulturstyrelsen</a> (CC0 1.0)',
                opacity: 0.85,
                defaultOn: false,
                enabled: true,
                requiresCredentials: [],
                auth: 'none',
                credentialsNote: { da: '', en: '' },
                provider: 'Slots- og Kulturstyrelsen (Danish Agency for Culture and Palaces)',
                licence: 'CC0 1.0',
                licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
                sourcePage: 'https://slks.dk/omraader/kulturarv/databaserne/til-udviklere/webservices',
                bounds: [[54.42, 7.99], [57.78, 15.6]],
                notes: 'Official upstream replaces the unauthorised geoserver.witx.dk mirror the brief ' +
                    'mentioned (witx:FundOgFortidsminderAreal). Other layers of the same service: ' +
                    'areal_beskyttelse (protection zones), areal_ka (heritage areas), areal_adm, ' +
                    'punkt_fredet, linie_alle — set `layers` to switch.',
                /* The same service can answer a browser directly: WFS 2.0.0
                 * takes the bbox in degrees with the CRS spelled out and
                 * returns EPSG:4326 GeoJSON, so a workstation without the
                 * proxy still sees the monuments. Public data, CC0 1.0. */
                directFallback: {
                    url: 'https://www.kulturarv.dk/ffgeoserver/public/wfs',
                    version: '2.0.0',
                    typeName: 'public:fundogfortidsminder_areal_fredet'
                },
                wfs: {
                    typeName: 'public:fundogfortidsminder_areal_fredet',
                    /* Hard cap: one bbox query can match ~3 000 polygons, which
                     * would be megabytes of JSON in a city-sized view. */
                    maxFeatures: 400,
                    /* The proxy is asked for the view bbox and returns only what
                     * fits this many features; the row explains it in the info
                     * popup instead of silently truncating. */
                    style: {
                        color: '#ffd166',
                        weight: 1.6,
                        opacity: 0.95,
                        fillColor: '#ffb703',
                        fillOpacity: 0.28
                    },
                    popup: {
                        /* Which properties the click popup shows, in order. */
                        fields: ['anlaegstype', 'datering', 'frednr', 'stednr'],
                        linkField: 'url',
                        linkLabel: { da: 'Åbn i Fund og Fortidsminder', en: 'Open in Fund og Fortidsminder' }
                    }
                },
                permission: { required: false, note: '' }
            },
            /* ── LiDAR (terrain model / hillshade) overlays ─────────────── */
            {
                id: 'lidar_hillshade_historik',
                title: { da: 'LiDAR skyggekort 1.6 m (DHM historik)', en: 'LiDAR hillshade 1.6 m (DHM historik)' },
                group: 'overlay',
                type: 'wms',
                url: '/api/geo/dk-dtk25?layer=lidar_hillshade_historik',
                upstream: 'https://api.dataforsyningen.dk/dhm_historik_DAF',
                layers: 'hillshade_1_6m',
                crs: 'EPSG:3857', format: 'image/png', transparent: true, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 0, maxZoom: 20, maxNativeZoom: 19,
                attribution: 'Danmarks Højdemodel © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'],
                auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'LiDAR hillshade 1.6 m (DHM historik).',
                wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'lidar_quickdhm_exaggerated',
                title: { da: 'LiDAR skyggekort, overdrevet terræn (quickDHM)', en: 'LiDAR hillshade, exaggerated terrain (quickDHM)' },
                group: 'overlay',
                type: 'wms',
                url: '/api/geo/dk-dtk25?layer=lidar_quickdhm_exaggerated',
                upstream: 'https://api.dataforsyningen.dk/wms/dhm_temp',
                layers: 'quickDHM_skyggekort_terraen_overdrevet',
                crs: 'EPSG:3857', format: 'image/png', transparent: true, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 0, maxZoom: 20, maxNativeZoom: 19,
                attribution: 'Danmarks Højdemodel © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'],
                auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'LiDAR hillshade, exaggerated terrain (quickDHM).',
                wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'lidar_dhm_terrain_hillshade',
                title: { da: 'LiDAR terræn skyggekort (DHM)', en: 'LiDAR terrain hillshade (DHM)' },
                group: 'overlay',
                type: 'wms',
                url: '/api/geo/dk-dtk25?layer=lidar_dhm_terrain_hillshade',
                upstream: 'https://api.dataforsyningen.dk/dhm_DAF',
                layers: 'dhm_terraen_skyggekort',
                crs: 'EPSG:3857', format: 'image/png', transparent: true, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 0, maxZoom: 20, maxNativeZoom: 19,
                attribution: 'Danmarks Højdemodel © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'],
                auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'LiDAR terrain hillshade (DHM).',
                wfs: null, permission: { required: false, note: '' }
            },
            /* ── Historical maps (base) ──────────────────────────────────── */
            {
                id: 'hist_hoeje',
                title: { da: 'Høje målebordsblade', en: 'High measurement table sheets' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=hist_hoeje',
                upstream: 'https://api.dataforsyningen.dk/topo20_hoeje_maalebordsblade_DAF',
                layers: 'dtk_hoeje_maalebordsblade',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 20, maxNativeZoom: 17,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Høje målebordsblade.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'hist_lave',
                title: { da: 'Lave målebordsblade', en: 'Low measurement table sheets' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=hist_lave',
                upstream: 'https://api.dataforsyningen.dk/topo20_lave_maalebordsblade_DAF',
                layers: 'dtk_lave_maalebordsblade',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 20, maxNativeZoom: 17,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Lave målebordsblade.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'hist_preussen',
                title: { da: 'Preussiske målebordsblade', en: 'Prussian measurement table sheets' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=hist_preussen',
                upstream: 'https://api.dataforsyningen.dk/topo25_preussen_maalebordsblade_DAF',
                layers: 'dtk_preussen_maalebordsblade',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 20, maxNativeZoom: 17,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Preussiske målebordsblade.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'topo4cm_1953_1976',
                title: { da: '4 cm kort 1953-1976', en: '4 cm map 1953-1976' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=topo4cm_1953_1976',
                upstream: 'https://api.dataforsyningen.dk/topo4cm_1953_1976_DAF',
                layers: 'topo4cm_1953_1976',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 20, maxNativeZoom: 17,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: '4 cm map 1953-1976.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'topo4cm_1980_2001',
                title: { da: '4 cm kort 1980-2001', en: '4 cm map 1980-2001' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=topo4cm_1980_2001',
                upstream: 'https://api.dataforsyningen.dk/topo4cm_1980_2001_DAF',
                layers: 'topo4cm_1980_2001',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 20, maxNativeZoom: 17,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: '4 cm map 1980-2001.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_sommer_1999',
                title: { da: 'Sommerortofoto 1999', en: 'Summer orthophoto 1999' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=orto_sommer_1999',
                upstream: 'https://api.dataforsyningen.dk/wms/orto_sommer_1999',
                layers: 'orto_sommer_1999',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Summer orthophoto 1999.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_sommer_2002',
                title: { da: 'Sommerortofoto 2002', en: 'Summer orthophoto 2002' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=orto_sommer_2002',
                upstream: 'https://api.dataforsyningen.dk/wms/orto_sommer_2002',
                layers: 'orto_sommer_2002',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Summer orthophoto 2002.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_sommer_2005',
                title: { da: 'Sommerortofoto 2005', en: 'Summer orthophoto 2005' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=orto_sommer_2005',
                upstream: 'https://api.dataforsyningen.dk/wms/orto_sommer_2005',
                layers: 'orto_sommer_2005',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Summer orthophoto 2005.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_sommer_2008',
                title: { da: 'Sommerortofoto 2008', en: 'Summer orthophoto 2008' },
                group: 'base', type: 'wms',
                url: '/api/geo/dk-dtk25?layer=orto_sommer_2008',
                upstream: 'https://api.dataforsyningen.dk/wms/orto_sommer_2008',
                layers: 'orto_sommer_2008',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: '© <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORSYNINGEN_TOKEN'], auth: 'token',
                credentialsNote: { da: 'Kræver DATAFORSYNINGEN_TOKEN.', en: 'Requires DATAFORSYNINGEN_TOKEN.' },
                provider: 'Klimadatastyrelsen, via Dataforsyningen',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Summer orthophoto 2008.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2016',
                title: { da: 'Forårsortofoto 2016', en: 'Spring orthophoto 2016' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2016',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2016_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2016.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2017',
                title: { da: 'Forårsortofoto 2017', en: 'Spring orthophoto 2017' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2017',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2017_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2017.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2018',
                title: { da: 'Forårsortofoto 2018', en: 'Spring orthophoto 2018' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2018',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2018_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2018.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2019',
                title: { da: 'Forårsortofoto 2019', en: 'Spring orthophoto 2019' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2019',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2019_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2019.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2020',
                title: { da: 'Forårsortofoto 2020', en: 'Spring orthophoto 2020' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2020',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2020_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2020.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2021',
                title: { da: 'Forårsortofoto 2021', en: 'Spring orthophoto 2021' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2021',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2021_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2021.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2022',
                title: { da: 'Forårsortofoto 2022', en: 'Spring orthophoto 2022' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2022',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2022_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2022.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2023',
                title: { da: 'Forårsortofoto 2023', en: 'Spring orthophoto 2023' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2023',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2023_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2023.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2024',
                title: { da: 'Forårsortofoto 2024', en: 'Spring orthophoto 2024' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2024',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2024_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2024.', wfs: null, permission: { required: false, note: '' }
            },
            {
                id: 'orto_foraar_2025',
                title: { da: 'Forårsortofoto 2025', en: 'Spring orthophoto 2025' },
                group: 'base', type: 'wms', selectorGroup: 'spring-orthophoto',
                url: '/api/geo/dk-orto?layer=orto_foraar_2025',
                upstream: 'https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS',
                layers: 'geodanmark_2025_12_5cm',
                crs: 'EPSG:3857', format: 'image/png', transparent: false, tiled: true, tileSize: 256, version: '1.3.0',
                minZoom: 6, maxZoom: 22, maxNativeZoom: 19,
                attribution: 'Ortofoto © <a href="https://klimadatastyrelsen.dk/" target="_blank" rel="noopener">Klimadatastyrelsen</a> / GeoDanmark (CC BY 4.0)',
                opacity: 1, defaultOn: false, enabled: true,
                requiresCredentials: ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD'], auth: 'basic',
                credentialsNote: { da: 'Kræver DATAFORDELER_USERNAME/PASSWORD.', en: 'Requires DATAFORDELER_USERNAME/PASSWORD.' },
                provider: 'GeoDanmark / Klimadatastyrelsen, via Datafordeleren',
                licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
                sourcePage: 'https://dataforsyningen.dk/data/981',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Spring orthophoto 2025.', wfs: null, permission: { required: false, note: '' }
            },
            /* WITX WFS endpoints are third-party and explicitly disabled until permission. */
            {
                id: 'witx_fundogfortidsminder_areal',
                title: { da: 'WITX · Fund og Fortidsminder (arealer, deaktiveret)', en: 'WITX · Finds and ancient monuments (areas, disabled)' },
                group: 'overlay', type: 'wfs',
                url: 'https://geoserver.witx.dk/geoserver/witx/ows', upstream: 'https://geoserver.witx.dk/geoserver/witx/ows',
                layers: 'witx:FundOgFortidsminderAreal', crs: 'EPSG:4326', format: 'application/json',
                transparent: true, tiled: false, tileSize: 256, version: '2.0.0', minZoom: 0, maxZoom: 20,
                attribution: 'Third-party WITX data — disabled pending written permission', opacity: 1,
                defaultOn: false, enabled: false, requiresCredentials: [], auth: 'none',
                credentialsNote: { da: '', en: '' }, provider: 'witx.dk (third party)',
                licence: 'Unknown — written permission required', licenceUrl: '', sourcePage: 'https://witx.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Disabled placeholder only; never contact without permission.',
                wfs: { typeName: 'witx:FundOgFortidsminderAreal' },
                permission: { required: true, note: 'Do not enable without written permission from witx.dk or official upstream authorization.' }
            },
            {
                id: 'witx_fundogfortidsminder',
                title: { da: 'WITX · Fund og Fortidsminder (deaktiveret)', en: 'WITX · Finds and ancient monuments (disabled)' },
                group: 'overlay', type: 'wfs',
                url: 'https://geoserver.witx.dk/geoserver/witx/ows', upstream: 'https://geoserver.witx.dk/geoserver/witx/ows',
                layers: 'witx:FundOgFortidsminder', crs: 'EPSG:4326', format: 'application/json',
                transparent: true, tiled: false, tileSize: 256, version: '2.0.0', minZoom: 0, maxZoom: 20,
                attribution: 'Third-party WITX data — disabled pending written permission', opacity: 1,
                defaultOn: false, enabled: false, requiresCredentials: [], auth: 'none',
                credentialsNote: { da: '', en: '' }, provider: 'witx.dk (third party)',
                licence: 'Unknown — written permission required', licenceUrl: '', sourcePage: 'https://witx.dk/',
                bounds: [[54.4265, 7.99125], [57.7781, 15.5995]],
                notes: 'Disabled placeholder only; never contact without permission.',
                wfs: { typeName: 'witx:FundOgFortidsminder' },
                permission: { required: true, note: 'Do not enable without written permission from witx.dk or official upstream authorization.' }
            },
        ]
    };

    /* Enabled entries, in config order — the only thing the rest of the app
     * iterates. Disabled placeholders stay visible to the docs and to the
     * “what is in the config” report, but are never built. */
    CONFIG.enabledLayers = function () {
        return CONFIG.layers.filter(function (l) { return l.enabled !== false; });
    };
    CONFIG.byId = function (id) {
        for (var i = 0; i < CONFIG.layers.length; i++) {
            if (CONFIG.layers[i].id === id) return CONFIG.layers[i];
        }
        return null;
    };
    /* Title in the current UI language, with English as the fallback. */
    CONFIG.title = function (layer, lang) {
        var t = (layer && layer.title) || {};
        var key = String(lang || '').toLowerCase().slice(0, 2);
        if (key === 'da' && t.da) return t.da;
        return t.en || t.da || layer.id;
    };

    return CONFIG;
}));
