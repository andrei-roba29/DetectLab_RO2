/*
 * DetectLab — Offline maps
 *
 * Offline areas are deliberately kept local to the device.  The polygon and
 * its ten-day metadata live in IndexedDB; raster tiles live in a dedicated
 * Cache Storage bucket and are served by sw.js when the network is gone.
 * Nothing from an offline map is uploaded to Supabase.
 */
(function () {
    'use strict';

    /* A polygon may now span up to 100 km² — large enough for a whole
       commune with its surroundings on every free layer. */
    var MAX_AREA_M2 = 100 * 1000 * 1000;
    var MAP_TTL_MS = 10 * 24 * 60 * 60 * 1000;
    /* Scaled up together with the 100 km² area cap: a 100 km² satellite
       download at zoom 18 alone is ~6 200 tiles, so the old 5 000 cap would
       have refused what the new area allows. Storage is still bounded by the
       browser quota, and the tile estimate warns before the cap is hit. */
    var MAX_TILE_JOBS = 20000;
    var DB_NAME = 'detectlab-offline-maps';
    var DB_VERSION = 1;
    var STORE_NAME = 'maps';
    var FALLBACK_KEY = 'detectlab_offline_maps_v1';
    var OFFLINE_TILE_CACHE = 'detectlab-offline-tiles-v1';
    var TILE_QUERY_KEY = '__dl_offline_map';
    /* Tapping inside this radius (in screen pixels) of the first corner closes
       the ring, so a finger only has to get close to the starting pin — which
       matters at high zoom levels where a few metres are dozens of pixels. */
    var CLOSE_HIT_RADIUS_PX = 18;

    var text = {
        offlineTitle: { ro: 'Hărți offline', en: 'Offline maps' },
        offlineButton: { ro: 'Hărți offline', en: 'Offline maps' },
        drawPrompt: { ro: 'Desenează un poligon', en: 'Draw a polygon' },
        drawHint: { ro: 'Atinge harta pentru colțuri, apoi apasă dublu sau „Finalizează”.', en: 'Tap the map for corners, then double-click or press “Finish”.' },
        closeHint: { ro: 'Atinge primul punct atins pentru a închide poligonul.', en: 'Tap the first corner again to close the polygon.' },
        finished: { ro: 'Zonă selectată. Alege straturile mai jos.', en: 'Area selected. Pick the layers below.' },
        finish: { ro: 'Finalizează poligonul', en: 'Finish polygon' },
        redraw: { ro: 'Desenează alt poligon', en: 'Draw another polygon' },
        clear: { ro: 'Șterge poligonul', en: 'Clear polygon' },
        area: { ro: 'Suprafață', en: 'Area' },
        maximum: { ro: 'Suprafața maximă este de 100 km².', en: 'The maximum area is 100 km².' },
        tooLarge: { ro: 'Poligonul depășește limita de 100 km². Micșorează-l sau modifică punctele.', en: 'The polygon exceeds the 100 km² limit. Make it smaller or edit its points.' },
        tooFew: { ro: 'Ai nevoie de cel puțin 3 puncte.', en: 'You need at least 3 points.' },
        available: { ro: 'Straturi disponibile în această zonă', en: 'Layers available in this area' },
        noLayers: { ro: 'Nu există straturi raster descărcabile în această zonă.', en: 'No downloadable raster layers are available in this area.' },
        choose: { ro: 'Alege straturile pe care vrei să le salvezi.', en: 'Choose the layers you want to save.' },
        premium: { ro: 'Premium', en: 'Premium' },
        free: { ro: 'Free', en: 'Free' },
        detail: { ro: 'Nivel de detaliu', en: 'Detail level' },
        zoomLabel: { ro: 'Nivel zoom', en: 'Zoom level' },
        zoomFrom: { ro: 'de la', en: 'from' },
        zoomTo: { ro: 'până la', en: 'to' },
        estimated: { ro: 'tile estimate', en: 'tile estimate' },
        download: { ro: 'Descarcă harta', en: 'Download map' },
        downloading: { ro: 'Se descarcă…', en: 'Downloading…' },
        cancel: { ro: 'Anulează', en: 'Cancel' },
        downloaded: { ro: 'Harta a fost salvată pe dispozitiv.', en: 'The map was saved on this device.' },
        downloadError: { ro: 'Descărcarea nu a reușit. Verifică conexiunea și încearcă un nivel de detaliu mai mic.', en: 'The download failed. Check your connection and try a lower detail level.' },
        noSelection: { ro: 'Bifează cel puțin un strat.', en: 'Select at least one layer.' },
        areaLabel: { ro: 'Suprafață', en: 'Area' },
        libraryTitle: { ro: 'Hărți offline salvate', en: 'Saved offline maps' },
        libraryEmpty: { ro: 'Nu ai încă hărți offline salvate.', en: 'You have no saved offline maps yet.' },
        expires: { ro: 'Această hartă se va șterge automat după 10 zile.', en: 'This map will be deleted automatically after 10 days.' },
        created: { ro: 'Salvată', en: 'Saved' },
        activate: { ro: 'Activează harta', en: 'Activate map' },
        active: { ro: 'Harta activă', en: 'Active map' },
        deactivate: { ro: 'Dezactivează', en: 'Deactivate' },
        exitOffline: { ro: 'Ieși din harta offline', en: 'Exit the offline map' },
        delete: { ro: 'Șterge', en: 'Delete' },
        offlineTab: { ro: 'Offline', en: 'Offline' },
        offlineActive: { ro: 'Straturile din harta offline activă', en: 'Layers from the active offline map' },
        offlineModeOn: { ro: 'Modul hărți offline activ', en: 'Offline maps mode is active' },
        offlineModeOff: { ro: 'Modul hărți offline oprit', en: 'Offline maps mode is off' },
        noCache: { ro: 'Browserul nu permite salvarea locală a hărții.', en: 'This browser does not allow local map storage.' },
        premiumLocked: { ro: 'Necesită Premium', en: 'Premium required' },
        onlyThree: { ro: 'Alege cel puțin 3 puncte pentru poligon.', en: 'Choose at least 3 points for the polygon.' },
        cacheWarning: { ro: 'Hărțile offline ocupă spațiu pe dispozitiv.', en: 'Offline maps use storage on this device.' }
    };

    function currentLang() {
        try {
            return typeof window._currentLang === 'function' && window._currentLang() === 'en' ? 'en' : 'ro';
        } catch (e) { return 'ro'; }
    }

    function t(key) {
        var value = text[key];
        if (!value) return key;
        return value[currentLang()] || value.ro || value.en;
    }

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function uid() {
        return 'offline_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
    }

    function pointArray(points) {
        return (points || []).map(function (p) {
            return { lat: Number(p.lat), lng: Number(p.lng) };
        }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); });
    }

    /* A local equirectangular projection is accurate to well below a percent
       for an area up to a hundred square kilometres and avoids a heavyweight
       geometry plugin. */
    function polygonAreaM2(points) {
        points = pointArray(points);
        if (points.length < 3) return 0;
        var earth = 6371008.8;
        var lat0 = points.reduce(function (sum, p) { return sum + p.lat; }, 0) / points.length * Math.PI / 180;
        var xy = points.map(function (p) {
            return {
                x: earth * p.lng * Math.PI / 180 * Math.cos(lat0),
                y: earth * p.lat * Math.PI / 180
            };
        });
        var sum = 0;
        for (var i = 0; i < xy.length; i++) {
            var next = xy[(i + 1) % xy.length];
            sum += xy[i].x * next.y - next.x * xy[i].y;
        }
        return Math.abs(sum) / 2;
    }

    function formatArea(m2) {
        if (m2 >= 1000000) return (m2 / 1000000).toFixed(2) + ' km²';
        if (m2 >= 10000) return (m2 / 10000).toFixed(2) + ' ha';
        return Math.round(m2) + ' m²';
    }

    function isPremium() {
        try {
            if (typeof window._dlIsPremium === 'function') return !!window._dlIsPremium();
            var user = typeof window._authUser === 'function' ? window._authUser() : null;
            return !!(user && user.plan === 'premium');
        } catch (e) { return false; }
    }

    function boundsArray(swLat, swLng, neLat, neLng) {
        return { south: swLat, west: swLng, north: neLat, east: neLng };
    }

    /* The catalogue intentionally contains only raster/XYZ layers. Vector
       layers (OSM labels, live heritage points and reports) cannot be useful
       as a tile cache when the browser is disconnected. */
    var SOURCES = [
        {
            id: 'satellite', label: { ro: 'Satelit', en: 'Satellite' }, category: 'free',
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            minZoom: 10, maxNativeZoom: 18, tms: false,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Imagine satelitară de bază', en: 'Base satellite imagery' }, onlineKey: '_satLayer'
        },
        {
            id: 'apm', label: { ro: 'APM Layer', en: 'APM Layer' }, category: 'free',
            url: 'https://sclav.andreiroba2000.workers.dev/APM_TILES/{z}/{x}/{y}.png',
            minZoom: 8, maxNativeZoom: 12, tms: true,
            bounds: boundsArray(42.865, 19.9, 49.003, 30.672),
            description: { ro: 'Modelul de predicție arheologică', en: 'Archaeological prediction model' }, onlineKey: '_apmLayer'
        },
        {
            id: 'uat', label: { ro: 'UAT', en: 'UAT' }, category: 'free',
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/UAT/{z}/{x}/{y}.png',
            minZoom: 8, maxNativeZoom: 14, tms: true,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Unități administrativ-teritoriale', en: 'Administrative-territorial units' }, onlineKey: '_uatLayer'
        },
        {
            id: 'lidar-ro2m', label: { ro: 'LIDAR România 2–5 m/pixel', en: 'LIDAR Romania 2–5 m/pixel' }, category: 'free',
            url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/Ro2m/MapServer/tile/{z}/{y}/{x}',
            minZoom: 9, maxNativeZoom: 16, tms: false,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Model digital de elevație LIDAR', en: 'LIDAR digital elevation model' }, onlineKey: '_lidarGroup'
        },
        {
            id: 'josephine', label: { ro: 'Harta Iosefină +', en: 'Josephine Map +' }, category: 'free',
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Josephine/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 15, tms: false,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Foi istorice georeferențiate', en: 'Georeferenced historical sheets' }, onlineKey: '_jLayerRef'
        },
        {
            /* WMS raster fallback for the heritage layer — the same service the
               map falls back to when the heritage API is unreachable, so the
               offline copy looks like the online map without connection. */
            id: 'patrimoniu', label: { ro: 'Patrimoniu', en: 'Heritage' }, category: 'free',
            wms: { url: 'https://eism.geo-spatial.ro/eismgeo/services/Patrimoniu/PatrimoniuWM/MapServer/WmsServer', layers: '0,5,6', format: 'image/png', transparent: true, version: '1.1.1' },
            minZoom: 8, maxNativeZoom: 16,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Situri arheologice și monumente istorice (CIMEC)', en: 'Archaeological sites and historic monuments (CIMEC)' }, onlineKey: '_patrimoniuLayer'
        },
        {
            /* The three free historical maps from geo-spatial.org (eharta WMS). */
            id: 'austrian', label: { ro: 'Harta Austriacă 1910', en: 'Austrian Map 1910' }, category: 'free',
            wms: { url: 'https://services.geo-spatial.org/geoserver/eharta/wms', layers: 'eharta:mozaic_austrian_200k', format: 'image/png', transparent: true, version: '1.1.1' },
            minZoom: 6, maxNativeZoom: 13,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Mozaic austriac 1:200.000 (geo-spatial.org)', en: 'Austrian 1:200,000 mosaic (geo-spatial.org)' }, onlineKey: '_austrianMapLayer'
        },
        {
            id: 'firingplans', label: { ro: 'Planuri de Tragere 20k', en: 'Firing Plans 20k' }, category: 'free',
            wms: { url: 'https://services.geo-spatial.org/geoserver/eharta/wms', layers: 'eharta:mozaic_planuri_tragere_20k', format: 'image/png', transparent: true, version: '1.1.1' },
            minZoom: 8, maxNativeZoom: 15,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Planuri de tragere 1:20.000 (geo-spatial.org)', en: '1:20,000 firing plans (geo-spatial.org)' }, onlineKey: '_firingPlansLayer'
        },
        {
            id: 'soviet', label: { ro: 'Harta Sovietică 1970', en: 'Soviet Map 1970' }, category: 'free',
            wms: { url: 'https://services.geo-spatial.org/geoserver/eharta/wms', layers: 'eharta:mozaic_soviet100k', format: 'image/png', transparent: true, version: '1.1.1' },
            minZoom: 6, maxNativeZoom: 13,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Harta sovietică 1:100.000 (geo-spatial.org)', en: 'Soviet 1:100,000 map (geo-spatial.org)' }, onlineKey: '_sovietMapLayer'
        },
        {
            /* Vector source: the OSM Places document is downloaded as one file
               and the locality labels are rebuilt from the cached copy when the
               offline map is activated (see makeOfflinePlacesLayer). */
            id: 'osm-places', label: { ro: 'Localități OSM', en: 'OSM Places' }, category: 'free',
            kind: 'geojson',
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/OSM.geojson',
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Numele localităților din OpenStreetMap', en: 'Locality names from OpenStreetMap' }, onlineKey: '_osmPlacesGroup'
        },
        {
            id: 'apm20', label: { ro: 'APM 2.0', en: 'APM 2.0' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 15, tms: false,
            bounds: boundsArray(42.865, 19.9, 49.003, 30.672),
            description: { ro: 'Model APM de rezoluție avansată', en: 'Higher-resolution APM model' }, onlineKey: '_apm20Layer'
        },
        {
            id: 'bucovina', label: { ro: 'Bucovina 1861–1864', en: 'Bukovina 1861–1864' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/Galitzien_and_Bukovina-1861-1864/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 15, tms: false,
            bounds: boundsArray(46.0, 22.0, 49.1, 27.2),
            description: { ro: 'Hartă istorică regională', en: 'Regional historical map' }, onlineKey: '_bucovinaMapLayer'
        },
        {
            id: 'austrohu', label: { ro: 'Harta Austro-Ungară', en: 'Austro-Hungarian Map' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/1869-1912/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 13, tms: false,
            bounds: boundsArray(43.5, 19.5, 48.5, 30.5),
            description: { ro: 'Hartă istorică Austro-Ungaria', en: 'Austro-Hungarian historical map' }, onlineKey: '_austrohuMapLayer'
        },
        {
            id: 'moldova1868', label: { ro: 'Moldova 1868', en: 'Moldova 1868' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/moldova-1868/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 13, tms: false,
            bounds: boundsArray(45.0, 25.0, 48.5, 30.7),
            description: { ro: 'Hartă istorică a Moldovei', en: 'Historical map of Moldova' }, onlineKey: '_moldova1868MapLayer'
        },
        {
            id: 'moldova1771', label: { ro: 'Moldova 1771', en: 'Moldova 1771' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Moldova_1771/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 15, tms: false,
            bounds: boundsArray(45.0, 25.0, 48.5, 30.7),
            description: { ro: 'Hartă istorică a Moldovei', en: 'Historical map of Moldova' }, onlineKey: '_moldova1771MapLayer'
        },
        {
            id: 'moldovawwii', label: { ro: 'Moldova WWII', en: 'Moldova WWII' }, category: 'premium', requiresPremium: true,
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/moldova-wwii/{z}/{x}/{y}.jpg',
            minZoom: 8, maxNativeZoom: 13, tms: false,
            bounds: boundsArray(45.0, 25.0, 48.5, 30.7),
            description: { ro: 'Hartă istorică din al Doilea Război Mondial', en: 'World War II historical map' }, onlineKey: '_moldovaWwiiMapLayer'
        },
        {
            id: 'banat', label: { ro: 'Banat 1769–1772', en: 'Banat 1769–1772' }, category: 'premium', requiresPremium: true,
            url: 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Banat/{z}/{x}/{y}.png',
            minZoom: 11, maxNativeZoom: 15, tms: false,
            bounds: boundsArray(44.5, 20.2, 46.4, 23.5),
            description: { ro: 'Hartă istorică a Banatului', en: 'Historical map of Banat' }, onlineKey: '_banatMapLayer'
        },
        {
            id: 'transylvania1859', label: { ro: 'Harta Transilvaniei 1859', en: 'Transylvania Map 1859' }, category: 'premium', requiresPremium: true,
            url: 'https://tiles.arcgis.com/tiles/t2AVhHhEnEvHcPF6/arcgis/rest/services/Siebenburgen_1859/MapServer/tile/{z}/{y}/{x}',
            minZoom: 7, maxNativeZoom: 14, tms: false,
            bounds: boundsArray(45.2059, 22.2319, 47.7300, 26.7037),
            description: { ro: 'Hartă administrativă istorică · Digitalizare și publicare: Universitatea „Ștefan cel Mare” din Suceava · Sursă: bukowina1856.eu', en: 'Historical administrative map · Digitized and published by “Ștefan cel Mare” University of Suceava · Source: bukowina1856.eu' }, onlineKey: '_transylvania1859MapLayer'
        },
        {
            id: 'galicia1855', label: { ro: 'Galiția și Lodomeria 1855', en: 'Galicia and Lodomeria 1855' }, category: 'premium', requiresPremium: true,
            url: 'https://tiles.arcgis.com/tiles/t2AVhHhEnEvHcPF6/arcgis/rest/services/Kummerer_1855/MapServer/tile/{z}/{y}/{x}',
            minZoom: 6, maxNativeZoom: 14, tms: false,
            bounds: boundsArray(46.8116, 18.3937, 50.8713, 26.6844),
            description: { ro: 'Hartă administrativă istorică regională · Digitalizare și publicare: Universitatea „Ștefan cel Mare” din Suceava · Sursă: bukowina1856.eu', en: 'Regional historical administrative map · Digitized and published by “Ștefan cel Mare” University of Suceava · Source: bukowina1856.eu' }, onlineKey: '_galicia1855MapLayer'
        }
    ];

    var state = {
        map: null,
        mode: false,
        drawState: 'idle',
        points: [],
        polygon: null,
        previewLine: null,
        selected: {},
        db: null,
        dbReady: null,
        maps: [],
        activeId: null,
        activeLayers: [],
        activeSources: [],
        hiddenOnlineLayers: [],
        panel: null,
        exitButton: null,
        library: null,
        libraryOpen: false,
        downloading: false,
        cancelDownload: false,
        downloadUrls: [],
        /* Sticky message shown in the panel head. It survives updatePanel()
           re-renders, otherwise an error such as "polygon too large" would be
           overwritten by the next (informational) status line. */
        status: null
    };

    function sourceById(id) {
        for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
        return null;
    }

    function idbRequest(request) {
        return new Promise(function (resolve, reject) {
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error || new Error('IndexedDB error')); };
        });
    }

    function openDb() {
        if (!window.indexedDB) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var request;
            try { request = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { resolve(null); return; }
            request.onupgradeneeded = function () {
                var db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            };
            request.onsuccess = function () { state.db = request.result; resolve(state.db); };
            request.onerror = function () { resolve(null); };
        });
    }

    function fallbackRead() {
        try { return JSON.parse(localStorage.getItem(FALLBACK_KEY) || '[]'); } catch (e) { return []; }
    }

    function fallbackWrite(records) {
        try { localStorage.setItem(FALLBACK_KEY, JSON.stringify(records)); } catch (e) { /* quota */ }
    }

    function getRecords() {
        if (!state.db) return Promise.resolve(fallbackRead());
        try {
            var tx = state.db.transaction(STORE_NAME, 'readonly');
            return idbRequest(tx.objectStore(STORE_NAME).getAll()).catch(function () { return fallbackRead(); });
        } catch (e) { return Promise.resolve(fallbackRead()); }
    }

    function putRecord(record) {
        if (!state.db) {
            var records = fallbackRead().filter(function (r) { return r.id !== record.id; });
            records.push(record); fallbackWrite(records); return Promise.resolve();
        }
        try {
            var tx = state.db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(record);
            return new Promise(function (resolve) { tx.oncomplete = resolve; tx.onerror = resolve; });
        } catch (e) { return Promise.resolve(); }
    }

    function deleteRecord(id) {
        if (!state.db) {
            fallbackWrite(fallbackRead().filter(function (r) { return r.id !== id; }));
            return Promise.resolve();
        }
        try {
            var tx = state.db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(id);
            return new Promise(function (resolve) { tx.oncomplete = resolve; tx.onerror = resolve; });
        } catch (e) { return Promise.resolve(); }
    }

    function cleanRecordTiles(record) {
        if (!window.caches || !record || !record.tileUrls) return Promise.resolve();
        return caches.open(OFFLINE_TILE_CACHE).then(function (cache) {
            return Promise.all(record.tileUrls.map(function (url) { return cache.delete(url); }));
        }).catch(function () {});
    }

    function cleanupExpiredRecords() {
        var now = Date.now();
        return getRecords().then(function (records) {
            var expired = records.filter(function (r) { return Number(r.expiresAt) <= now; });
            if (!expired.length) return records;
            return Promise.all(expired.map(function (r) {
                if (state.activeId === r.id) deactivateOfflineMap();
                return cleanRecordTiles(r).then(function () { return deleteRecord(r.id); });
            })).then(function () { return records.filter(function (r) { return Number(r.expiresAt) > now; }); });
        }).then(function (records) {
            state.maps = (records || []).sort(function (a, b) { return Number(b.createdAt) - Number(a.createdAt); });
            if (state.activeId && !state.maps.some(function (r) { return r.id === state.activeId; })) {
                state.activeId = null;
                try { localStorage.removeItem('detectlab_active_offline_map'); } catch (e) {}
            }
            return state.maps;
        });
    }

    function polygonBounds(points) {
        var p = pointArray(points);
        if (!p.length) return null;
        var south = p[0].lat, north = p[0].lat, west = p[0].lng, east = p[0].lng;
        p.forEach(function (x) {
            south = Math.min(south, x.lat); north = Math.max(north, x.lat);
            west = Math.min(west, x.lng); east = Math.max(east, x.lng);
        });
        return boundsArray(south, west, north, east);
    }

    function intersects(a, b) {
        return !!a && !!b && a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
    }

    function availableSources(points) {
        var bounds = polygonBounds(points);
        return SOURCES.filter(function (source) { return intersects(bounds, source.bounds); });
    }

    function pointInPolygon(point, polygon) {
        var x = point.lng, y = point.lat, inside = false;
        for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            var xi = polygon[i].lng, yi = polygon[i].lat;
            var xj = polygon[j].lng, yj = polygon[j].lat;
            var hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
            if (hit) inside = !inside;
        }
        return inside;
    }

    function orientation(a, b, c) {
        return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    }

    function onSegment(a, b, c) {
        return Math.min(a.lng, c.lng) - 1e-12 <= b.lng && b.lng <= Math.max(a.lng, c.lng) + 1e-12 &&
            Math.min(a.lat, c.lat) - 1e-12 <= b.lat && b.lat <= Math.max(a.lat, c.lat) + 1e-12;
    }

    function segmentsIntersect(a, b, c, d) {
        var o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
        if (o1 === 0 && onSegment(a, c, b)) return true;
        if (o2 === 0 && onSegment(a, d, b)) return true;
        if (o3 === 0 && onSegment(c, a, d)) return true;
        if (o4 === 0 && onSegment(c, b, d)) return true;
        return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
    }

    function tileBounds(z, x, y) {
        var n = Math.pow(2, z);
        var west = x / n * 360 - 180;
        var east = (x + 1) / n * 360 - 180;
        function yToLat(yy) { return 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))); }
        return boundsArray(yToLat(y + 1), west, yToLat(y), east);
    }

    function tileTouchesPolygon(z, x, y, polygon) {
        var b = tileBounds(z, x, y);
        var rect = [
            { lat: b.south, lng: b.west }, { lat: b.south, lng: b.east },
            { lat: b.north, lng: b.east }, { lat: b.north, lng: b.west }
        ];
        for (var i = 0; i < polygon.length; i++) if (pointInPolygon(polygon[i], rect) ||
            (polygon[i].lat >= b.south && polygon[i].lat <= b.north && polygon[i].lng >= b.west && polygon[i].lng <= b.east)) return true;
        var center = { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
        if (pointInPolygon(center, polygon)) return true;
        for (var r = 0; r < 4; r++) {
            var c1 = rect[r], c2 = rect[(r + 1) % 4];
            for (var p = 0; p < polygon.length; p++) {
                if (segmentsIntersect(c1, c2, polygon[p], polygon[(p + 1) % polygon.length])) return true;
            }
        }
        return false;
    }

    function tileRange(z, bounds) {
        var n = Math.pow(2, z);
        function lonX(lon) { return (lon + 180) / 360 * n; }
        function latY(lat) {
            var rad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
            return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n;
        }
        return {
            x0: Math.max(0, Math.floor(lonX(bounds.west))), x1: Math.min(n - 1, Math.floor(lonX(bounds.east))),
            y0: Math.max(0, Math.floor(latY(bounds.north))), y1: Math.min(n - 1, Math.floor(latY(bounds.south)))
        };
    }

    function appendParam(url, key, value) {
        return url + (url.indexOf('?') === -1 ? '?' : '&') + key + '=' + encodeURIComponent(value);
    }

    function tileUrl(source, z, x, y, mapId) {
        var yy = source.tms ? Math.pow(2, z) - 1 - y : y;
        var url = source.url.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, yy);
        return appendParam(url, TILE_QUERY_KEY, mapId);
    }

    /* A WMS tile is a GetMap request whose BBOX is the XYZ tile extent in
       EPSG:3857 metres — the same CRS the online L.tileLayer.wms layers use.
       The URL depends only on (source, z, x, y, mapId), so the download loop
       and the activated layer build byte-identical URLs and the service
       worker finds every downloaded tile in the cache. */
    function wmsTileUrl(source, z, x, y, mapId) {
        var b = tileBounds(z, x, y);
        var R = 6378137, rad = Math.PI / 180;
        function merY(lat) { return R * Math.log(Math.tan(Math.PI / 4 + lat * rad / 2)); }
        var params = [
            'SERVICE=WMS',
            'REQUEST=GetMap',
            'VERSION=' + (source.wms.version || '1.1.1'),
            'LAYERS=' + source.wms.layers,
            'STYLES=',
            'FORMAT=' + (source.wms.format || 'image/png'),
            'TRANSPARENT=' + (source.wms.transparent === false ? 'FALSE' : 'TRUE'),
            'SRS=EPSG:3857',
            'WIDTH=256',
            'HEIGHT=256',
            'BBOX=' + (R * b.west * rad) + ',' + merY(b.south) + ',' + (R * b.east * rad) + ',' + merY(b.north)
        ];
        return source.wms.url + '?' + params.join('&') + '&' + TILE_QUERY_KEY + '=' + mapId;
    }

    function sourceJobUrl(source, z, x, y, mapId) {
        return source.wms ? wmsTileUrl(source, z, x, y, mapId) : tileUrl(source, z, x, y, mapId);
    }

    function jobsFor(recordId, points, selectedIds, zoomMin, zoomMax) {
        var bounds = polygonBounds(points);
        var polygon = pointArray(points);
        var jobs = [], seen = {};
        var sources = selectedIds.map(sourceById).filter(function (s) { return s && intersects(bounds, s.bounds); });
        sources.forEach(function (source) {
            /* A vector source is stored as a single document (the whole
               GeoJSON file), not as a zoom pyramid of raster tiles. */
            if (source.kind === 'geojson') {
                var docUrl = appendParam(source.url, TILE_QUERY_KEY, recordId);
                if (!seen[docUrl]) { seen[docUrl] = true; jobs.push({ source: source, url: docUrl }); }
                return;
            }
            var start = Math.max(1, Number(zoomMin), source.minZoom || 0);
            var end = Math.min(20, Number(zoomMax), source.maxNativeZoom || 20);
            for (var z = start; z <= end; z++) {
                var range = tileRange(z, bounds);
                for (var x = range.x0; x <= range.x1; x++) {
                    for (var y = range.y0; y <= range.y1; y++) {
                        if (!tileTouchesPolygon(z, x, y, polygon)) continue;
                        var url = sourceJobUrl(source, z, x, y, recordId);
                        if (seen[url]) continue;
                        seen[url] = true;
                        jobs.push({ source: source, z: z, x: x, y: y, url: url });
                    }
                }
            }
        });
        return jobs;
    }

    function getZoomValues() {
        var min = Number((document.getElementById('offlineZoomMin') || {}).value || 11);
        var max = Number((document.getElementById('offlineZoomMax') || {}).value || 14);
        if (min > max) max = min;
        return { min: min, max: max };
    }

    function selectedSourceIds() {
        var inArea = state.polygon ? availableSources(state.points) : SOURCES;
        return Object.keys(state.selected).filter(function (id) {
            var source = sourceById(id);
            return state.selected[id] && source && inArea.indexOf(source) !== -1 && (!source.requiresPremium || isPremium());
        });
    }

    function updateEstimate() {
        var el = document.getElementById('offlineTileEstimate');
        if (!el || !state.polygon) return;
        var ids = selectedSourceIds();
        if (!ids.length) { el.textContent = t('noSelection'); return; }
        var zoom = getZoomValues();
        var fakeId = 'estimate';
        var count = jobsFor(fakeId, state.points, ids, zoom.min, zoom.max).length;
        el.textContent = count + ' ' + t('estimated');
        el.classList.toggle('offline-count-warning', count > MAX_TILE_JOBS);
    }

    function ensurePanel() {
        if (state.panel) return state.panel;
        var parent = document.querySelector('.map-frame') || document.body;
        var panel = document.createElement('section');
        panel.id = 'offlineMapPanel';
        panel.className = 'offline-map-panel';
        panel.setAttribute('aria-live', 'polite');
        panel.innerHTML =
            '<div class="offline-panel-head">' +
                '<div class="offline-panel-title"><span class="offline-panel-icon" aria-hidden="true">⇩</span><strong></strong></div>' +
                '<button type="button" class="offline-panel-close" title="Close" aria-label="Close">×</button>' +
            '</div>' +
            '<p class="offline-panel-message"></p>' +
            '<p class="offline-panel-hint"></p>' +
            '<div class="offline-area-line" hidden><span></span><strong></strong></div>' +
            '<div class="offline-draw-actions">' +
                '<button type="button" class="offline-action offline-finish"></button>' +
                '<button type="button" class="offline-action offline-redraw"></button>' +
                '<button type="button" class="offline-action offline-clear"></button>' +
            '</div>' +
            '<div class="offline-layer-picker" hidden>' +
                '<div class="offline-picker-title"></div>' +
                '<p class="offline-picker-subtitle"></p>' +
                '<div class="offline-layer-options"></div>' +
            '</div>' +
            '<div class="offline-download-options" hidden>' +
                '<div class="offline-zoom-row">' +
                    '<span class="offline-zoom-name"></span>' +
                    '<span class="offline-zoom-word offline-zoom-from"></span>' +
                    '<select id="offlineZoomMin"></select>' +
                    '<span class="offline-zoom-separator">–</span>' +
                    '<span class="offline-zoom-word offline-zoom-to"></span>' +
                    '<select id="offlineZoomMax"></select>' +
                '</div>' +
                '<span id="offlineTileEstimate" class="offline-tile-estimate"></span>' +
            '</div>' +
            '<p class="offline-storage-warning"></p>' +
            '<button type="button" class="offline-download-btn"></button>' +
            '<div class="offline-progress" hidden><div class="offline-progress-track"><span></span></div><span class="offline-progress-label"></span></div>';
        parent.appendChild(panel);
        state.panel = panel;

        panel.querySelector('.offline-panel-close').onclick = function () { setMode(false); };
        panel.querySelector('.offline-finish').onclick = finishDrawing;
        panel.querySelector('.offline-redraw').onclick = beginDrawing;
        panel.querySelector('.offline-clear').onclick = clearPolygon;
        panel.querySelector('.offline-download-btn').onclick = function () {
            if (state.downloading) state.cancelDownload = true;
            else downloadMap();
        };
        panel.querySelector('#offlineZoomMin').onchange = function () {
            var max = document.getElementById('offlineZoomMax');
            if (max && Number(this.value) > Number(max.value)) max.value = this.value;
            updateEstimate();
        };
        panel.querySelector('#offlineZoomMax').onchange = function () {
            var min = document.getElementById('offlineZoomMin');
            if (min && Number(this.value) < Number(min.value)) min.value = this.value;
            updateEstimate();
        };
        for (var z = 8; z <= 17; z++) {
            var minOption = document.createElement('option'); minOption.value = z; minOption.textContent = z;
            var maxOption = document.createElement('option'); maxOption.value = z; maxOption.textContent = z;
            panel.querySelector('#offlineZoomMin').appendChild(minOption);
            panel.querySelector('#offlineZoomMax').appendChild(maxOption);
        }
        panel.querySelector('#offlineZoomMin').value = '11';
        panel.querySelector('#offlineZoomMax').value = '14';
        return panel;
    }

    function renderLayerOptions() {
        var panel = ensurePanel();
        var holder = panel.querySelector('.offline-layer-options');
        var picker = panel.querySelector('.offline-layer-picker');
        holder.innerHTML = '';
        if (!state.polygon || state.drawState !== 'finished') { picker.hidden = true; return; }
        var sources = availableSources(state.points);
        var visibleCount = 0;
        sources.forEach(function (source) {
            visibleCount++;
            if (state.selected[source.id] === undefined) state.selected[source.id] = source.id === 'satellite';
            if (source.requiresPremium && !isPremium()) state.selected[source.id] = false;
            var row = document.createElement('label');
            row.className = 'offline-layer-option' + (source.requiresPremium ? ' is-premium-option' : '');
            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.checked = !!state.selected[source.id];
            checkbox.disabled = !!source.requiresPremium && !isPremium();
            checkbox.setAttribute('data-offline-layer', source.id);
            checkbox.onchange = function () { state.selected[source.id] = checkbox.checked; updateEstimate(); updatePanel(); };
            var copy = document.createElement('span'); copy.className = 'offline-layer-copy';
            var lock = source.requiresPremium && !isPremium() ? ' · ' + t('premiumLocked') : '';
            copy.innerHTML = '<strong>' + esc(source.label[currentLang()]) + '</strong>' +
                '<small>' + esc(source.description[currentLang()]) + '</small>';
            var badge = document.createElement('span');
            badge.className = 'offline-layer-badge ' + (source.category === 'premium' ? 'premium' : 'free');
            badge.textContent = source.category === 'premium' ? t('premium') : t('free');
            row.appendChild(checkbox); row.appendChild(copy); row.appendChild(badge);
            if (lock) {
                var lockText = document.createElement('em'); lockText.className = 'offline-layer-lock'; lockText.textContent = lock;
                row.appendChild(lockText);
            }
            holder.appendChild(row);
        });
        picker.hidden = visibleCount === 0;
        panel.querySelector('.offline-picker-title').textContent = visibleCount ? t('available') : t('noLayers');
        panel.querySelector('.offline-picker-subtitle').textContent = visibleCount ? t('choose') : '';
        if (visibleCount) updateEstimate();
    }

    function updatePanel() {
        var panel = ensurePanel();
        panel.classList.toggle('is-open', state.mode);
        panel.querySelector('.offline-panel-title strong').textContent = t('offlineTitle');
        renderStatus();
        var hint = state.drawState === 'drawing' ? t('drawHint') :
            (state.drawState === 'finished' ? t('finished') : t('drawHint'));
        // Once the ring can be closed, say how: the first corner doubles as the
        // closing handle.
        if (state.drawState === 'drawing' && state.points.length >= 3) hint += ' ' + t('closeHint');
        panel.querySelector('.offline-panel-hint').textContent = hint;
        // The two dropdowns pick a zoom level; name them explicitly so the bare
        // numbers are not mistaken for something else.
        panel.querySelector('.offline-zoom-name').textContent = t('zoomLabel');
        panel.querySelector('.offline-zoom-from').textContent = t('zoomFrom');
        panel.querySelector('.offline-zoom-to').textContent = t('zoomTo');
        panel.querySelector('#offlineZoomMin').setAttribute('aria-label', t('zoomLabel') + ' ' + t('zoomFrom'));
        panel.querySelector('#offlineZoomMax').setAttribute('aria-label', t('zoomLabel') + ' ' + t('zoomTo'));
        var areaLine = panel.querySelector('.offline-area-line');
        var area = polygonAreaM2(state.points);
        areaLine.hidden = state.points.length < 3;
        areaLine.querySelector('span').textContent = t('areaLabel');
        areaLine.querySelector('strong').textContent = formatArea(area) + ' / 100 km²';
        areaLine.classList.toggle('is-over', area > MAX_AREA_M2);

        var finish = panel.querySelector('.offline-finish');
        var redraw = panel.querySelector('.offline-redraw');
        var clear = panel.querySelector('.offline-clear');
        finish.textContent = t('finish'); finish.hidden = state.drawState !== 'drawing';
        redraw.textContent = t('redraw'); redraw.hidden = state.drawState !== 'finished';
        clear.textContent = t('clear'); clear.hidden = state.points.length === 0;
        panel.querySelector('.offline-download-options').hidden = state.drawState !== 'finished' || area > MAX_AREA_M2;
        if (state.drawState === 'finished') renderLayerOptions();
        else panel.querySelector('.offline-layer-picker').hidden = true;
        panel.querySelector('.offline-storage-warning').textContent = t('cacheWarning');
        panel.querySelector('.offline-download-btn').textContent = state.downloading ? t('cancel') : t('download');
        panel.querySelector('.offline-download-btn').disabled = !state.downloading && (state.drawState !== 'finished' || area > MAX_AREA_M2 || !selectedSourceIds().length);
    }

    function defaultStatus() {
        if (!state.mode) return { message: t('offlineModeOff'), isError: false };
        if (state.drawState === 'finished') return { message: t('offlineActive'), isError: false };
        return { message: t('drawPrompt'), isError: false };
    }

    function renderStatus() {
        var panel = ensurePanel();
        var node = panel.querySelector('.offline-panel-message');
        var status = state.status || defaultStatus();
        node.textContent = status.message;
        node.classList.toggle('is-error', !!status.isError);
    }

    /* setStatus() keeps the message until it is explicitly cleared, so an error
       ("polygon too large") is not wiped out by the next updatePanel() render.
       The optional key lets a later interaction clear one specific message. */
    function setStatus(message, isError, key) {
        state.status = { message: message, isError: !!isError, key: key || '' };
        renderStatus();
    }

    function clearStatus(key) {
        if (key && (!state.status || state.status.key !== key)) return;
        state.status = null;
        renderStatus();
    }

    function clearPreview() {
        if (state.previewLine && state.map && state.map.hasLayer(state.previewLine)) state.map.removeLayer(state.previewLine);
        state.previewLine = null;
    }

    function removePolygon() {
        if (state.polygon && state.map && state.map.hasLayer(state.polygon)) state.map.removeLayer(state.polygon);
        state.polygon = null;
    }

    /* The shape being drawn is shown AS the shape: a dashed outline that fills
       in as soon as the ring can be closed. No vertex dots, no circles around
       a pin — the offline area has always been a polygon, and drawing pins on
       top of it made the flow look like two different tools at once. */
    function redrawPreview() {
        clearPreview();
        if (!state.map || state.points.length === 0) return;
        var over = state.points.length >= 3 && polygonAreaM2(state.points) > MAX_AREA_M2;
        var color = over ? '#c42b2b' : '#E8772A';
        var style = {
            color: color, weight: 2.5, dashArray: '7 5', opacity: 0.95,
            pane: 'offlineDrawPane', interactive: false
        };
        if (state.points.length >= 3) {
            state.previewLine = L.polygon(state.points, {
                color: style.color, weight: style.weight, dashArray: style.dashArray,
                opacity: style.opacity, fill: true, fillColor: color,
                fillOpacity: over ? 0.16 : 0.11, pane: style.pane, interactive: false
            }).addTo(state.map);
        } else {
            state.previewLine = L.polyline(state.points, style).addTo(state.map);
        }
    }

    /* While an offline polygon is being drawn, the map taps belong to the
       polygon — and to nothing else. The analysis layers (LIDAR Scanner, Zone
       cu potențial arheologic, Raport arheologic) each arm a "tap the map to
       drop a pin + a radius circle" handler, so without this flag a single tap
       used to produce BOTH a corner of the offline area and a pin with its
       circle: two tools answering the same gesture at once. Offline areas are
       polygons, full stop; the flag is what keeps the pin-with-radius logic out
       of the flow (the three modules read window._dlOfflineDrawActive). */
    function updateDrawModeFlag() {
        try {
            window._dlOfflineDrawActive = !!(state.mode && state.drawState === 'drawing');
        } catch (e) { /* a sandbox without a window object */ }
    }

    function beginDrawing() {
        if (!state.map) return;
        removePolygon(); clearPreview();
        state.points = []; state.selected = {}; state.drawState = 'drawing';
        state.map.getContainer().classList.add('offline-drawing');
        if (state.map.doubleClickZoom) state.map.doubleClickZoom.disable();
        state.map.on('click', onDrawClick);
        state.map.on('dblclick', onDrawDoubleClick);
        updateDrawModeFlag();
        clearStatus();
        updatePanel();
    }

    /* True when a tap lands close enough (in screen pixels) to the first corner
       to be understood as "close the polygon here". */
    function isNearFirstPoint(point) {
        if (!state.map || state.points.length < 3) return false;
        var first = state.points[0];
        try {
            var a = state.map.latLngToContainerPoint(first);
            var b = state.map.latLngToContainerPoint(point);
            return Math.abs(a.x - b.x) <= CLOSE_HIT_RADIUS_PX && Math.abs(a.y - b.y) <= CLOSE_HIT_RADIUS_PX;
        } catch (e) {
            // Fallback for maps without projection helpers: a few dozen metres.
            return !!(point.distanceTo && point.distanceTo(first) < 30);
        }
    }

    function onDrawClick(event) {
        if (!state.mode || state.drawState !== 'drawing') return;
        var next = event.latlng;
        var last = state.points[state.points.length - 1];
        if (last && next.distanceTo && next.distanceTo(last) < 5) return;
        if (isNearFirstPoint(next)) { finishDrawing(); return; }
        state.points.push(next);
        redrawPreview(); updatePanel();
        // Report the size limit while drawing, not only when finishing, so an
        // over-sized shape is obvious right away.
        if (polygonAreaM2(state.points) > MAX_AREA_M2) setStatus(t('tooLarge'), true, 'tooLarge');
        else clearStatus('tooLarge');
    }

    function onDrawDoubleClick(event) {
        if (!state.mode || state.drawState !== 'drawing') return;
        if (state.points.length && event.latlng.distanceTo(state.points[state.points.length - 1]) < 5) state.points.pop();
        finishDrawing();
    }

    function finishDrawing() {
        if (!state.map || state.drawState !== 'drawing') return;
        if (state.points.length < 3) { setStatus(t('onlyThree'), true, 'onlyThree'); return; }
        var area = polygonAreaM2(state.points);
        // updatePanel() renders the sticky status, so the error survives the
        // re-render that used to overwrite it with the "active map" line.
        if (area > MAX_AREA_M2) { setStatus(t('tooLarge'), true, 'tooLarge'); updatePanel(); return; }
        state.map.off('click', onDrawClick); state.map.off('dblclick', onDrawDoubleClick);
        if (state.map.doubleClickZoom) state.map.doubleClickZoom.enable();
        state.map.getContainer().classList.remove('offline-drawing');
        clearPreview();
        state.polygon = L.polygon(state.points, {
            color: '#4fc3f7', weight: 2.5, fillColor: '#4fc3f7', fillOpacity: 0.16, pane: 'offlineDrawPane'
        }).addTo(state.map);
        state.drawState = 'finished';
        clearStatus();
        updateDrawModeFlag();
        updatePanel();
    }

    function clearPolygon() {
        if (!state.map) return;
        state.map.off('click', onDrawClick); state.map.off('dblclick', onDrawDoubleClick);
        if (state.map.doubleClickZoom) state.map.doubleClickZoom.enable();
        state.map.getContainer().classList.remove('offline-drawing');
        clearPreview(); removePolygon();
        state.points = []; state.selected = {}; state.drawState = 'idle';
        clearStatus();
        updateDrawModeFlag();
        updatePanel();
    }

    function setMode(on) {
        state.mode = !!on;
        var button = document.getElementById('btnOfflineMaps');
        if (button) {
            button.classList.toggle('active', state.mode);
            button.setAttribute('aria-pressed', state.mode ? 'true' : 'false');
            button.title = state.mode ? t('offlineModeOff') : t('offlineButton');
        }
        ensurePanel();
        if (state.mode && state.drawState === 'idle') beginDrawing();
        if (!state.mode) {
            state.map && state.map.off('click', onDrawClick).off('dblclick', onDrawDoubleClick);
            if (state.map && state.map.doubleClickZoom) state.map.doubleClickZoom.enable();
            if (state.map) state.map.getContainer().classList.remove('offline-drawing');
            // A half-drawn polygon is a temporary gesture. Remove it when the
            // mode is switched off so the next activation starts cleanly.
            if (state.drawState === 'drawing') {
                clearPreview(); state.points = []; state.drawState = 'idle'; state.selected = {};
            }
            updateDrawModeFlag();
            // Drops any pending error; the panel falls back to "offline mode off".
            clearStatus();
        }
        updatePanel();
    }

    function makeIconButton() {
        if (document.getElementById('btnOfflineMaps')) return;
        var topLeft = document.querySelector('#detectlab-map .leaflet-top.leaflet-left');
        if (!topLeft) { setTimeout(makeIconButton, 150); return; }
        var wrap = document.createElement('div');
        wrap.className = 'leaflet-control leaflet-bar offline-control-wrap';
        var button = document.createElement('button');
        button.id = 'btnOfflineMaps';
        button.className = 'btn-offline-maps';
        button.type = 'button';
        button.setAttribute('aria-pressed', 'false');
        button.title = t('offlineButton');
        button.setAttribute('aria-label', t('offlineButton'));
        button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15h-7l-4.5 4v-4.2A2.5 2.5 0 0 1 4 12.3z"/>' +
            '<path d="M12 6v6m0 0-2.4-2.4M12 12l2.4-2.4"/>' +
            '</svg>';
        button.onclick = function (event) { L.DomEvent.stopPropagation(event); setMode(!state.mode); };
        wrap.appendChild(button);
        topLeft.appendChild(wrap);
    }

    function showSavedCategory() {
        var tab = document.getElementById('offlineLayerTab');
        if (tab) tab.style.display = '';
    }

    function hideSavedCategory() {
        var tab = document.getElementById('offlineLayerTab');
        if (tab) tab.style.display = 'none';
        if (document.querySelector('#transpPanel .tab-btn.active[data-tab="offline"]') && typeof window.switchLayerTab === 'function') window.switchLayerTab('free');
        var holder = document.getElementById('offlineLayerRows');
        if (holder) holder.innerHTML = '';
    }

    function removeActiveLayers() {
        state.activeLayers.forEach(function (layer) { if (state.map && state.map.hasLayer(layer)) state.map.removeLayer(layer); });
        state.activeLayers = [];
        state.activeSources = [];
        state.hiddenOnlineLayers.forEach(function (layer) { if (state.map && !state.map.hasLayer(layer)) layer.addTo(state.map); });
        state.hiddenOnlineLayers = [];
    }

    function ensureOfflinePane(name, zIndex) {
        if (!state.map.getPane(name)) {
            state.map.createPane(name);
            state.map.getPane(name).style.zIndex = zIndex;
            state.map.getPane(name).style.pointerEvents = 'none';
        }
        return name;
    }

    function makeOfflineLayer(source, record) {
        var url = appendParam(source.url, TILE_QUERY_KEY, record.id);
        var pane = source.id === 'satellite' ? 'offlineBase' : 'offlineOverlay';
        ensureOfflinePane(pane, pane === 'offlineBase' ? 399 : 665);
        return L.tileLayer(url, {
            pane: pane,
            minZoom: source.minZoom || 0,
            maxZoom: 20,
            maxNativeZoom: source.maxNativeZoom,
            tms: !!source.tms,
            opacity: source.id === 'satellite' ? 1 : 0.82,
            tileSize: 256,
            attribution: '© DetectLab · ' + source.label.en,
            crossOrigin: 'anonymous'
        });
    }

    /* WMS layers replay the exact URLs built by wmsTileUrl() during the
       download, so the service worker serves the cached GetMap images when
       the device is offline and falls through to the network when it is not. */
    function makeOfflineWmsLayer(source, record) {
        var pane = ensureOfflinePane('offlineOverlay', 665);
        var WmsTileLayer = L.TileLayer.extend({
            initialize: function (src, recordId, options) {
                this._dlSource = src;
                this._dlRecordId = recordId;
                L.TileLayer.prototype.initialize.call(this, null, options);
            },
            getTileUrl: function (coords) {
                var z = typeof this._getZoomForUrl === 'function' ? this._getZoomForUrl() : coords.z;
                return wmsTileUrl(this._dlSource, z, coords.x, coords.y, this._dlRecordId);
            }
        });
        return new WmsTileLayer(source, record.id, {
            pane: pane,
            minZoom: source.minZoom || 0,
            maxZoom: 20,
            maxNativeZoom: source.maxNativeZoom,
            opacity: 0.82,
            tileSize: 256,
            attribution: '© DetectLab · ' + source.label.en,
            crossOrigin: 'anonymous'
        });
    }

    function readCachedJson(url) {
        if (!window.caches) return Promise.reject(new Error('Cache Storage unavailable'));
        return caches.open(OFFLINE_TILE_CACHE).then(function (cache) {
            return cache.match(url).then(function (hit) {
                if (!hit) throw new Error('Document not cached');
                return hit.json();
            });
        });
    }

    /* OSM Places offline: the GeoJSON document cached during the download is
       replayed as permanent name labels — the same label-only look as the
       online layer (transparent markers + permanent tooltips). Only the
       localities inside the downloaded polygon are shown, mirroring what the
       download was built for. The layer lives in its own pane so the opacity
       slider can drive pane opacity without touching the other overlays. */
    function makeOfflinePlacesLayer(source, record) {
        var pane = ensureOfflinePane('offlinePlacesPane', 666);
        var group = L.layerGroup([], { pane: pane });
        group.options.opacity = 1;
        group.setOpacity = function (value) {
            var node = state.map && state.map.getPane ? state.map.getPane('offlinePlacesPane') : null;
            if (node && node.style) node.style.opacity = value;
        };
        var docUrl = appendParam(source.url, TILE_QUERY_KEY, record.id);
        var polygon = pointArray(record.polygon);
        var box = polygonBounds(record.polygon);
        readCachedJson(docUrl).then(function (data) {
            var feats = (data && data.features) || [];
            var picked = [];
            for (var i = 0; i < feats.length; i++) {
                var coords = feats[i] && feats[i].geometry && feats[i].geometry.coordinates;
                if (!coords) continue;
                var lng = Number(coords[0]), lat = Number(coords[1]);
                if (!isFinite(lat) || !isFinite(lng)) continue;
                if (box && (lat < box.south || lat > box.north || lng < box.west || lng > box.east)) continue;
                if (polygon.length >= 3 && !pointInPolygon({ lat: lat, lng: lng }, polygon)) continue;
                var props = feats[i].properties || {};
                picked.push({
                    lat: lat, lng: lng,
                    name: props.name || props.NAME || '',
                    pop: Number(props.population || props.pop || 0) || 0
                });
            }
            /* Crowded polygons still have to stay readable: cities and towns
               (the populated entries) win the label budget over hamlets. */
            picked.sort(function (a, b) { return b.pop - a.pop; });
            picked = picked.slice(0, 600);
            for (var j = 0; j < picked.length; j++) {
                var marker = L.marker([picked[j].lat, picked[j].lng], {
                    pane: pane,
                    icon: L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0] }),
                    interactive: false
                });
                if (picked[j].name) {
                    marker.bindTooltip(picked[j].name, { permanent: true, direction: 'center', className: 'osm-places-tooltip', offset: [0, 0] });
                }
                group.addLayer(marker);
            }
        }).catch(function (error) {
            console.warn('[Offline maps] OSM places layer unavailable:', error && error.message);
        });
        return group;
    }

    function makeOfflineSourceLayer(source, record) {
        if (source.kind === 'geojson') return makeOfflinePlacesLayer(source, record);
        if (source.wms) return makeOfflineWmsLayer(source, record);
        return makeOfflineLayer(source, record);
    }

    function onlineLayerFor(source) {
        return source && source.onlineKey ? window[source.onlineKey] : null;
    }

    function renderOfflineRows(record) {
        var holder = document.getElementById('offlineLayerRows');
        if (!holder) return;
        holder.innerHTML = '';
        if (!record) { hideSavedCategory(); return; }
        showSavedCategory();
        var offlineTabIsActive = !!document.querySelector('#transpPanel .tab-btn.active[data-tab="offline"]');
        var title = document.createElement('div'); title.className = 'offline-right-panel-heading' + (offlineTabIsActive ? ' active' : ''); title.dataset.category = 'offline'; title.textContent = t('offlineActive'); holder.appendChild(title);
        (state.activeSources || []).forEach(function (source, index) {
            var layer = state.activeLayers[index];
            if (!source || !layer) return;
            var row = document.createElement('div');
            row.className = 'transp-layer-row offline-layer-row' + (offlineTabIsActive ? ' active' : ''); row.dataset.category = 'offline';
            var label = document.createElement('div'); label.className = 'transp-layer-label';
            var name = document.createElement('span'); name.textContent = source.label[currentLang()];
            var toggleLabel = document.createElement('label'); toggleLabel.className = 'apm-toggle-switch';
            var checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.map.hasLayer(layer);
            var track = document.createElement('span'); track.className = 'apm-toggle-track';
            checkbox.onchange = function () { if (checkbox.checked) layer.addTo(state.map); else state.map.removeLayer(layer); };
            toggleLabel.appendChild(checkbox); toggleLabel.appendChild(track); label.appendChild(name); label.appendChild(toggleLabel);
            var sub = document.createElement('div'); sub.className = 'transp-layer-label offline-layer-opacity-label';
            sub.innerHTML = '<span>' + esc(currentLang() === 'en' ? 'Opacity' : 'Opacitate') + '</span><span class="pct">' + Math.round(layer.options.opacity * 100) + '%</span>';
            var range = document.createElement('input'); range.type = 'range'; range.className = 'transp-slider'; range.min = '10'; range.max = '100'; range.value = String(Math.round(layer.options.opacity * 100));
            range.oninput = function () { var value = Number(range.value); layer.setOpacity(value / 100); sub.querySelector('.pct').textContent = value + '%'; };
            row.appendChild(label); row.appendChild(sub); row.appendChild(range); holder.appendChild(row);
        });
    }

    /* ── the ✕ that leaves an active offline map ──
       A saved area takes the map over: the cached rasters cover the online
       tiles, the polygon sits on top of everything and the layer panel shows
       the offline tab. While that is the case, a single ✕ is centred at the
       bottom of the screen (the same place the analysis layers dock their own
       button) and deactivates the map: local layers off, polygon off, offline
       mode off. */
    function ensureExitButton() {
        if (state.exitButton) return state.exitButton;
        var parent = document.querySelector('.map-frame') || document.body;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'offlineMapExit';
        btn.className = 'offline-active-exit';
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>' +
            '<span class="offline-active-exit-label"></span>';
        btn.onclick = function (event) {
            if (event && event.stopPropagation) event.stopPropagation();
            exitOfflineMap();
        };
        parent.appendChild(btn);
        state.exitButton = btn;
        return btn;
    }

    function updateExitButton() {
        var btn = ensureExitButton();
        var visible = !!state.activeId;
        if (btn.classList) btn.classList.toggle('is-visible', visible);
        btn.setAttribute('aria-hidden', visible ? 'false' : 'true');
        var label = btn.querySelector ? btn.querySelector('.offline-active-exit-label') : null;
        if (label) label.textContent = t('exitOffline');
        btn.setAttribute('title', t('exitOffline'));
        btn.setAttribute('aria-label', t('exitOffline'));
    }

    function exitOfflineMap() {
        // A half-drawn ring is abandoned first so the next activation is clean.
        if (state.drawState === 'drawing') clearPolygon();
        deactivateOfflineMap();
        setMode(false);
        renderLibrary();
    }

    function activateOfflineMap(record, silent) {
        if (!state.map || !record) return;
        removeActiveLayers();
        state.activeId = record.id;
        try { localStorage.setItem('detectlab_active_offline_map', record.id); } catch (e) {}
        (record.layerIds || []).forEach(function (id) {
            var source = sourceById(id); if (!source) return;
            // A locally cached Premium tile must not become a way around the
            // subscription gate after the subscription expires.
            if (source.requiresPremium && !isPremium()) return;
            var online = onlineLayerFor(source);
            // The 3D globe is the permanent basemap. Cached satellite tiles are
            // drawn above it only inside the downloaded polygon instead of
            // removing the globe (which would also discard its global context).
            if (source.id !== 'satellite' && online && state.map.hasLayer(online)) {
                state.map.removeLayer(online);
                state.hiddenOnlineLayers.push(online);
            }
            var layer = makeOfflineSourceLayer(source, record);
            layer.addTo(state.map); state.activeLayers.push(layer); state.activeSources.push(source);
        });
        renderOfflineRows(record);
        updateExitButton();
        var polygon = record.polygon || []
        if (polygon.length >= 3) {
            if (state.polygon && state.map.hasLayer(state.polygon)) state.map.removeLayer(state.polygon);
            state.points = pointArray(polygon);
            state.polygon = L.polygon(state.points, { color: '#4fc3f7', weight: 2.5, fillColor: '#4fc3f7', fillOpacity: 0.12, pane: 'offlineDrawPane' }).addTo(state.map);
            state.drawState = 'finished';
            if (state.mode) updatePanel();
            try { state.map.fitBounds(state.polygon.getBounds(), { padding: [60, 60], maxZoom: record.zoomMax || 15 }); } catch (e) {}
        }
        if (typeof window.switchLayerTab === 'function') window.switchLayerTab('offline');
        if (!silent) {
            ensureLibrary();
            setStatus(t('active') + ': ' + t('expires'));
            document.dispatchEvent(new CustomEvent('detectlab:offlineactivated', { detail: { id: record.id } }));
        }
        renderLibrary();
    }

    function deactivateOfflineMap() {
        removeActiveLayers();
        state.activeId = null;
        try { localStorage.removeItem('detectlab_active_offline_map'); } catch (e) {}
        hideSavedCategory();
        if (state.polygon && state.map && state.map.hasLayer(state.polygon)) state.map.removeLayer(state.polygon);
        state.polygon = null; state.points = []; state.drawState = 'idle';
        updateDrawModeFlag();
        updateExitButton();
    }

    function ensureLibrary() {
        if (state.library) return state.library;
        var parent = document.querySelector('.map-frame') || document.body;
        var library = document.createElement('section');
        library.id = 'offlineMapsLibrary'; library.className = 'offline-library';
        library.setAttribute('aria-live', 'polite');
        library.innerHTML = '<div class="offline-library-head"><strong></strong><button type="button" aria-label="Close">×</button></div><div class="offline-library-list"></div>';
        parent.appendChild(library); state.library = library;
        library.querySelector('button').onclick = closeLibrary;
        return library;
    }

    function renderLibrary() {
        var library = ensureLibrary();
        library.querySelector('.offline-library-head strong').textContent = t('libraryTitle');
        var list = library.querySelector('.offline-library-list'); list.innerHTML = '';
        if (!state.maps.length) { list.innerHTML = '<p class="offline-library-empty">' + esc(t('libraryEmpty')) + '</p>'; return; }
        state.maps.forEach(function (record) {
            var card = document.createElement('article'); card.className = 'offline-map-card' + (state.activeId === record.id ? ' is-active' : '');
            var mapName = currentLang() === 'en' ? 'Offline area' : 'Zonă offline';
            var layers = (record.layerIds || []).map(function (id) { var s = sourceById(id); return s ? s.label[currentLang()] : id; }).join(', ');
            var created = new Date(Number(record.createdAt));
            card.innerHTML = '<div class="offline-map-card-title"><strong>' + esc(mapName) + '</strong>' +
                (state.activeId === record.id ? '<span class="offline-active-pill">' + esc(t('active')) + '</span>' : '') + '</div>' +
                '<div class="offline-map-card-meta">' + esc(t('areaLabel')) + ': ' + esc(formatArea(polygonAreaM2(record.polygon))) + ' · ' + esc(record.tileCount || 0) + ' tiles</div>' +
                '<div class="offline-map-card-layers">' + esc(layers) + '</div>' +
                '<p class="offline-expiry-warning">' + esc(t('expires')) + '</p>' +
                '<small class="offline-map-card-date">' + esc(t('created')) + ': ' + esc(isNaN(created.getTime()) ? '' : created.toLocaleString()) + '</small>' +
                '<div class="offline-map-card-actions"><button type="button" class="offline-card-activate"></button><button type="button" class="offline-card-delete"></button></div>';
            var activate = card.querySelector('.offline-card-activate'); activate.textContent = state.activeId === record.id ? t('deactivate') : t('activate');
            activate.onclick = function () { if (state.activeId === record.id) { deactivateOfflineMap(); renderLibrary(); } else activateOfflineMap(record); };
            var del = card.querySelector('.offline-card-delete'); del.textContent = t('delete'); del.onclick = function () { deleteOfflineMap(record); };
            list.appendChild(card);
        });
    }

    function openLibrary() {
        var ready = state.dbReady || Promise.resolve();
        ready.then(function () { return cleanupExpiredRecords(); }).then(function () {
            var library = ensureLibrary(); state.libraryOpen = true; library.classList.add('is-open'); renderLibrary();
        });
    }

    function closeLibrary() {
        state.libraryOpen = false;
        if (state.library) state.library.classList.remove('is-open');
        var toggle = document.getElementById('switchOfflineMaps'); if (toggle) toggle.checked = false;
    }

    function deleteOfflineMap(record) {
        var wasActive = state.activeId === record.id;
        if (wasActive) deactivateOfflineMap();
        cleanRecordTiles(record).then(function () { return deleteRecord(record.id); }).then(function () {
            state.maps = state.maps.filter(function (r) { return r.id !== record.id; }); renderLibrary();
            updateExitButton();
        });
    }

    function updateDownloadProgress(done, total, failed) {
        var panel = ensurePanel(), progress = panel.querySelector('.offline-progress');
        progress.hidden = false;
        var pct = total ? Math.round(done / total * 100) : 0;
        progress.querySelector('.offline-progress-track span').style.width = pct + '%';
        progress.querySelector('.offline-progress-label').textContent = pct + '% · ' + done + '/' + total + (failed ? ' · ' + failed + ' failed' : '');
    }

    function cacheTile(url) {
        if (!window.caches) return Promise.reject(new Error('Cache Storage unavailable'));
        return caches.open(OFFLINE_TILE_CACHE).then(function (cache) {
            return fetch(url, { mode: 'cors', cache: 'no-store', credentials: 'omit' }).then(function (response) {
                if (!response || (!response.ok && response.type !== 'opaque')) throw new Error('Tile HTTP error');
                return cache.put(url, response.clone()).then(function () { return true; });
            }).catch(function () {
                // Several public GIS servers omit CORS headers. An opaque response
                // is still perfectly valid for an <img> tile and is cacheable.
                return fetch(new Request(url, { mode: 'no-cors', cache: 'no-store' })).then(function (response) {
                    if (!response) throw new Error('Tile unavailable');
                    return cache.put(url, response.clone()).then(function () { return true; });
                });
            });
        });
    }

    function downloadMap() {
        if (state.downloading) return;
        if (!state.polygon || state.drawState !== 'finished') return;
        var area = polygonAreaM2(state.points);
        if (area > MAX_AREA_M2) { setStatus(t('tooLarge'), true, 'tooLarge'); return; }
        var ids = selectedSourceIds();
        if (!ids.length) { setStatus(t('noSelection'), true); updatePanel(); return; }
        var zoom = getZoomValues();
        var recordId = uid();
        var jobs;
        try { jobs = jobsFor(recordId, state.points, ids, zoom.min, zoom.max); } catch (e) { setStatus(t('downloadError'), true); return; }
        if (!jobs.length) { setStatus(t('noLayers'), true); return; }
        if (jobs.length > MAX_TILE_JOBS) {
            setStatus((currentLang() === 'en' ? 'Too many tiles (' : 'Prea multe tile-uri (') + jobs.length + '). ' + t('detail'), true);
            return;
        }
        state.downloading = true; state.cancelDownload = false; state.downloadUrls = [];
        updatePanel(); updateDownloadProgress(0, jobs.length, 0);
        // The download button is sticky and sits right above the progress bar;
        // bring the bar into view so a long layer list cannot hide it.
        try {
            var progressNode = state.panel && state.panel.querySelector('.offline-progress');
            if (progressNode && typeof progressNode.scrollIntoView === 'function') progressNode.scrollIntoView({ block: 'nearest' });
        } catch (e) {}
        var done = 0, failed = 0, cursor = 0, workerCount = Math.min(4, jobs.length);
        function worker() {
            if (state.cancelDownload || cursor >= jobs.length) return Promise.resolve();
            var job = jobs[cursor++];
            return cacheTile(job.url).then(function () {
                state.downloadUrls.push(job.url);
            }).catch(function () { failed++; }).then(function () {
                done++; updateDownloadProgress(done, jobs.length, failed); return worker();
            });
        }
        Promise.all(Array.from({ length: workerCount }, worker)).then(function () {
            var urls = state.downloadUrls.slice();
            if (state.cancelDownload) {
                return cleanRecordTiles({ tileUrls: urls }).then(function () { setStatus(t('cancel'), true); });
            }
            if (!urls.length || failed === jobs.length) { setStatus(t('downloadError'), true); return; }
            var record = {
                id: recordId, createdAt: Date.now(), expiresAt: Date.now() + MAP_TTL_MS,
                polygon: pointArray(state.points), layerIds: ids, zoomMin: zoom.min, zoomMax: zoom.max,
                tileCount: urls.length, tileUrls: urls
            };
            return putRecord(record).then(function () {
                state.maps.unshift(record); state.maps.sort(function (a, b) { return b.createdAt - a.createdAt; });
                setStatus(t('downloaded') + (failed ? ' · ' + failed + ' failed' : ''));
                activateOfflineMap(record, true); openLibrary();
            });
        }).catch(function (error) {
            console.warn('[Offline maps] download failed:', error);
            setStatus(t('downloadError'), true);
        }).then(function () {
            state.downloading = false; state.cancelDownload = false; updatePanel();
        });
    }

    function toggleSavedLibrary(checked) { if (checked) openLibrary(); else closeLibrary(); }

    function createOfflinePane() {
        if (!state.map.getPane('offlineDrawPane')) {
            state.map.createPane('offlineDrawPane');
            state.map.getPane('offlineDrawPane').style.zIndex = 710;
            state.map.getPane('offlineDrawPane').style.pointerEvents = 'auto';
        }
    }

    function restoreActive() {
        var id = null;
        try { id = localStorage.getItem('detectlab_active_offline_map'); } catch (e) {}
        if (!id) return;
        var record = state.maps.find(function (r) { return r.id === id; });
        if (record) activateOfflineMap(record, true);
    }

    function updateLanguage() {
        if (state.panel) updatePanel();
        if (state.exitButton) updateExitButton();
        if (state.libraryOpen) renderLibrary();
        var button = document.getElementById('btnOfflineMaps');
        if (button) { button.title = state.mode ? t('offlineModeOff') : t('offlineButton'); button.setAttribute('aria-label', t('offlineButton')); }
        var active = state.activeId ? state.maps.find(function (r) { return r.id === state.activeId; }) : null;
        if (active) renderOfflineRows(active);
    }

    function updatePremiumAvailability() {
        var active = state.activeId ? state.maps.find(function (r) { return r.id === state.activeId; }) : null;
        if (active) {
            var expected = (active.layerIds || []).map(sourceById).filter(function (source) {
                return source && (!source.requiresPremium || isPremium());
            }).map(function (source) { return source.id; }).join('|');
            var actual = state.activeSources.map(function (source) { return source.id; }).join('|');
            if (expected !== actual) activateOfflineMap(active, true);
        }
        if (state.panel && state.drawState === 'finished') updatePanel();
    }

    function boot() {
        if (state.map || !window._dlMap || !window.L) { if (!state.map) setTimeout(boot, 150); return; }
        state.map = window._dlMap;
        createOfflinePane(); makeIconButton(); ensurePanel(); ensureExitButton(); updateExitButton();
        state.map.on('resize', function () { if (state.mode) updatePanel(); });
        state.dbReady = openDb();
        state.dbReady.then(function () { return cleanupExpiredRecords(); }).then(function () { restoreActive(); });
        // Also enforce the ten-day TTL while the page remains open; a user should
        // not have to reload the PWA before an expired area disappears.
        window.setInterval(function () {
            state.dbReady.then(function () { return cleanupExpiredRecords(); }).then(function () {
                if (state.libraryOpen) renderLibrary();
            });
        }, 60 * 60 * 1000);
        window.openOfflineMapsLibrary = openLibrary;
        window.closeOfflineMapsLibrary = closeLibrary;
        window.toggleOfflineLibraryVisibility = toggleSavedLibrary;
        window.toggleOfflineMaps = function () { setMode(!state.mode); };
        var savedToggle = document.getElementById('switchOfflineMaps');
        if (savedToggle && savedToggle.checked) openLibrary();
        // Test/debug handle: the ✕ is driven by updateExitButton(), which reads
        // state.activeId — exposing it lets the node test activate a map without
        // touching the network.
        state.refreshExitButton = updateExitButton;
        window._offlineMapsState = state;
        /* Test/debug handle: the layer catalogue (ids, categories, WMS/geojson
           descriptors) so the node tests can assert the free/premium split
           without parsing the source. */
        window._offlineSources = SOURCES;
        document.addEventListener('detectlab:langchange', updateLanguage);
        window.addEventListener('detectlab:authchange', updatePremiumAvailability);
        window.addEventListener('beforeunload', function () { if (state.downloading) state.cancelDownload = true; });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
