(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    if (root) root.DetectLabLayers = api;
}(typeof window !== 'undefined' ? window
    : typeof self !== 'undefined' ? self
        : typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var VERSION = '2026-10-13-3d-mirror-v1';

    /* ═══════════════════════════════════════════════════════════════════════
     *  3D VIEW DEFAULTS — terrain, hillshade, sky, camera
     *  Overridable from the page (no code edit) with:
     *      window.DETECTLAB_MAP3D = { terrain: { provider: 'maptiler' }, … }
     *  Every URL/key lives here (or in that object), never inline in a view.
     * ═══════════════════════════════════════════════════════════════════════ */
    var TERRAIN_PROVIDERS = {
        /* Default: AWS Open Data “Terrain Tiles” (Tilezen Joerd), Terrarium
         * encoding, 256 px, no key, worldwide, CORS-enabled, z0–z15. */
        'aws-terrarium': {
            label: 'AWS Terrain Tiles (Terrarium)',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
            encoding: 'terrarium',
            tileSize: 256,
            minzoom: 0,
            maxzoom: 15,
            attribution: 'Elevation: AWS Open Data “Terrain Tiles” (Tilezen Joerd — SRTM, GMTED, ETOPO1, NED, EDNA, …)'
        },
        /* Optional: MapTiler Terrain-RGB. Needs a key — set it in
         * window.DETECTLAB_MAP3D.terrain.key (or .maptilerKey); it is never
         * committed to the repository. */
        'maptiler': {
            label: 'MapTiler Terrain-RGB',
            tiles: ['https://api.maptiler.com/tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key={key}'],
            encoding: 'mapbox',
            tileSize: 512,
            minzoom: 0,
            maxzoom: 12,
            attribution: 'Elevation: MapTiler Terrain-RGB',
            requiresKey: 'terrain.key'
        },
        /* Optional: user-supplied DEM. window.DETECTLAB_MAP3D.terrain.tiles
         * plus (for RGB DEMs) window.DETECTLAB_MAP3D.terrain.encoding. */
        'custom': {
            label: 'Custom DEM (window.DETECTLAB_MAP3D.terrain.tiles)',
            tiles: [],
            encoding: 'terrarium',
            tileSize: 256,
            minzoom: 0,
            maxzoom: 15,
            attribution: 'Elevation: custom source'
        }
    };

    var MAP3D_DEFAULT = {
        /* MapLibre GL JS is vendored (same convention as js/leaflet.js) so the
         * 3D view works offline and without a third-party CDN. Point these at
         * a CDN if you prefer: { maplibre: { js: 'https://…/maplibre-gl.js' } } */
        maplibre: {
            js: 'js/maplibre-gl.js?v=20261013-3d-terrain',
            css: 'css/maplibre-gl.css?v=20261013-3d-terrain',
            namespace: 'maplibregl',
            timeoutMs: 15000
        },
        terrain: {
            provider: 'aws-terrarium',   // 'aws-terrarium' | 'maptiler' | 'custom'
            exaggeration: 1.4,           // sensible default: visible relief, not a caricature
            minExaggeration: 0.5,
            maxExaggeration: 4,
            key: '',                     // ← MapTiler key (env/config, never in source)
            tiles: [],                   // ← overrides the provider when non-empty
            encoding: '',                // ← overrides the provider when non-empty
            tileSize: 0
        },
        hillshade: {
            enabled: true,
            mode: 'dem',                 // 'dem' (from the DEM above) | 'service' | 'off'
            opacity: 0.55,
            exaggeration: 1,
            /* 'service' mode draws Esri World Hillshade — the same raster the
             * ArcGIS SceneView atlas page (js/europe-roman-atlas.js) uses. */
            serviceTiles: ['https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}'],
            serviceAttribution: 'Hillshade: Esri World Hillshade',
            serviceMaxzoom: 16
        },
        sky: {
            enabled: true,
            paint: {
                'sky-color': '#0b1c33',
                'sky-horizon-blend': 0.6,
                'horizon-color': '#cfe4f5',
                'horizon-fog-blend': 0.6,
                'fog-color': '#a8c6dd',
                'fog-ground-blend': 0.12,
                'atmosphere-blend': 0.7
            }
        },
        camera: {
            pitch: 62,
            bearing: 0,
            maxPitch: 80,
            minZoom: 2,
            maxZoom: 20,
            /* “reset view” returns to the 2D-looking camera */
            flatPitch: 0
        },
        /* Same-origin proxy used for layers whose host sends no CORS headers
         * and/or cannot answer EPSG:3857 tiles. Netlify function in production
         * (netlify.toml), tools/map3d-dev-server.mjs locally. */
        proxy: {
            base: '/api/map3d/tile',
            enabled: true,               // false = never route through it
            probe: true,                 // probe unknown hosts once per session
            tileCacheSeconds: 86400,
            timeoutMs: 15000,
            /* Hosts a layer may be relayed from (?u=) in addition to the ones
             * this registry and the country LiDAR modules already use. Only a
             * layer of your own needs an entry here — never a private host:
             * loopback/private addresses are refused by the proxy outright. */
            extraHosts: []
        },
        perf: {
            /* Phones: 1 device pixel ratio, fewer DEM tiles, shorter tile life */
            mobilePixelRatio: 1,
            mobileMaxTerrainZoom: 12,
            fadeDuration: 120,
            maxTileCacheSize: 320
        },
        /* Analysis/interactive layers that are NOT draped rasters stay in 2D.
         * Listed in the diagnostics report with the reason. */
        adaptive: true
    };

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }
    function deepMerge(base, extra) {
        var out = {}, key;
        for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
        if (!isPlainObject(extra)) return out;
        for (key in extra) {
            if (!Object.prototype.hasOwnProperty.call(extra, key)) continue;
            out[key] = isPlainObject(out[key]) && isPlainObject(extra[key])
                ? deepMerge(out[key], extra[key]) : extra[key];
        }
        return out;
    }
    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function config() {
        var overrides = null;
        try { overrides = root && root.DETECTLAB_MAP3D; } catch (e) { overrides = null; }
        return deepMerge(MAP3D_DEFAULT, isPlainObject(overrides) ? overrides : {});
    }

    /* Resolved terrain provider: preset + overrides + key substitution. */
    function terrainSource() {
        var cfg = config();
        var t = cfg.terrain || {};
        var preset = TERRAIN_PROVIDERS[t.provider] || TERRAIN_PROVIDERS['aws-terrarium'];
        var tiles = (t.tiles && t.tiles.length ? t.tiles : preset.tiles).slice();
        var encoding = t.encoding || preset.encoding;
        var tileSize = t.tileSize || preset.tileSize;
        var key = t.key || t.maptilerKey || '';
        tiles = tiles.map(function (template) {
            return String(template).replace(/\{key\}/g, encodeURIComponent(key));
        });
        return {
            id: 'detectlab-dem',
            provider: t.provider || 'aws-terrarium',
            label: preset.label,
            tiles: tiles,
            encoding: encoding,
            tileSize: tileSize,
            minzoom: preset.minzoom,
            maxzoom: preset.maxzoom,
            attribution: (t.attribution || preset.attribution || ''),
            requiresKey: preset.requiresKey || null,
            missingKey: !!(preset.requiresKey && !key)
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  GROUPS — draw order and panel grouping. `z` mirrors the Leaflet pane
     *  z-index used today, so carrying the layer set into 3D preserves order.
     * ═══════════════════════════════════════════════════════════════════════ */
    var GROUPS = {
        'base': { label: { ro: 'Hărți de bază', en: 'Base maps' }, z: 100, base: true },
        'sat-hist': { label: { ro: 'Satelit istoric (Copernicus)', en: 'Historical satellite (Copernicus)' }, z: 400 },
        'uat': { label: { ro: 'UAT', en: 'UAT' }, z: 402 },
        'lidar': { label: { ro: 'LiDAR / relief', en: 'LiDAR / relief' }, z: 610 },
        'vegfp': { label: { ro: 'Vegetație (WMTS)', en: 'Vegetation (WMTS)' }, z: 612 },
        'patrimoniu': { label: { ro: 'Patrimoniu', en: 'Heritage' }, z: 620 },
        'hist-free': { label: { ro: 'Hărți istorice', en: 'Historical maps' }, z: 640 },
        'apm': { label: { ro: 'APM (analiză)', en: 'APM (analysis)' }, z: 645 },
        'hist-sat': { label: { ro: 'Satelit 60s (CORONA)', en: 'Satellite 60s (CORONA)' }, z: 648 },
        'hist-premium': { label: { ro: 'Hărți istorice premium', en: 'Premium historical maps' }, z: 654 },
        'image-overlay': { label: { ro: 'Suprapuneri imagine', en: 'Image overlays' }, z: 630 }
    };

    /* ═══════════════════════════════════════════════════════════════════════
     *  CENAGIS / IH PAN historical-map catalogue
     * ---------------------------------------------------------------------
     * 45 georeferenced sheets served by the IH PAN GeoServer. This table is the
     * single source for BOTH views: js/historical-eu-maps.js builds its
     * MAPS_CATALOG from it (same shape it used to hold inline) and
     * js/map3d-terrain.js builds the 3D raster sources from it.
     * All but two sheets are published as *_3857 (EPSG:3857). The two
     * exceptions (warszawaOKI_2180, rauch_2180) only exist in EPSG:2180 —
     * `reproject: true` routes them through the proxy, which asks the
     * GeoServer for the tile bbox transformed into EPSG:2180.
     * ═══════════════════════════════════════════════════════════════════════ */
    var CENAGIS = {
        url: 'https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms',
        workspace: 'ihpan',
        version: '1.3.0',
        format: 'image/png',
        transparent: true,
        opacity: 0.80,
        /* GeoServer answers plain <img> tiles without CORS, so every 3D layer
         * from this host starts on the proxy (see MAP_3D_TERRAIN.md §Proxy). */
        cors: 'unknown',
        maps: {
            "wig25k": {
                id: "wig25k", wms_layer: "wig25k_3857",
                title: { "ro": "Harta detaliată WIG 1:25 000", "en": "WIG Detailed Map 1:25,000", "pl": "Mapa szczegółowa WIG 1:25 000" },
                scale: "1:25 000", years: "1918–1939",
                provider: "Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN",
                bounds: [[49.16, 15.66], [55, 27.33]]
            },
            "wig100k": {
                id: "wig100k", wms_layer: "wig100k_3857",
                title: { "ro": "Harta tactică WIG 1:100 000", "en": "WIG Tactical Map 1:100,000", "pl": "Mapa taktyczna WIG 1:100 000" },
                scale: "1:100 000", years: "1918–1939",
                provider: "Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN",
                bounds: [[47.75, 12.83], [56, 28.83]]
            },
            "wig300k": {
                id: "wig300k", wms_layer: "wig300k_3857",
                title: { "ro": "Harta operațională WIG 1:300 000", "en": "WIG Operational Map 1:300,000", "pl": "Mapa operacyjna WIG 1:300 000" },
                scale: "1:300 000", years: "1918–1939",
                provider: "Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN",
                bounds: [[49, 14.33], [55.8, 27.5]]
            },
            "wig500k_1947": {
                id: "wig500k_1947", wms_layer: "wig500k_3857",
                title: { "ro": "Harta Poloniei și a țărilor vecine WIG 1:500 000", "en": "WIG Poland & Neighboring Countries 1:500,000", "pl": "Mapa Polski i Krajów Ościennych WIG 1:500 000" },
                scale: "1:500 000", years: "1947",
                provider: "Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN",
                bounds: [[49, 13.5], [55, 25.5]]
            },
            "tkkp_126k": {
                id: "tkkp_126k", wms_layer: "TKKP_126k_3857",
                title: { "ro": "Harta Topografică a Regatului Poloniei 1:126 000", "en": "Topographic Chart of the Kingdom of Poland (TKKP) 1:126,000", "pl": "Topograficzna Karta Królestwa Polskiego 1:126 000" },
                scale: "1:126 000", years: "1839–1843",
                provider: "Sztab Kwatermistrzostwa Generalnego WP / CENAGIS IH PAN",
                bounds: [[49.81, 17.27], [55.33, 24.92]]
            },
            "chrzanowski": {
                id: "chrzanowski", wms_layer: "chrzanowski_3857",
                title: { "ro": "Harta Vechii Polonii (Wojciech Chrzanowski) 1:300 000", "en": "Charter of Old Poland (Wojciech Chrzanowski) 1:300,000", "pl": "Karta Dawnej Polski 1:300 000 (Wojciech Chrzanowski)" },
                scale: "1:300 000", years: "1859",
                provider: "Gen. Wojciech Chrzanowski (Paris 1859) / CENAGIS IH PAN",
                bounds: [[45.8, 11.9], [57.1, 38.28]]
            },
            "gaul": {
                id: "gaul", wms_layer: "gaul_3857",
                title: { "ro": "Harta Gaula / Raczyńskiego 1:125 000", "en": "Gaul / Raczyński Map 1:125,000", "pl": "Mapa Gaula/Raczyńskiego 1:125 000" },
                scale: "1:125 000", years: "1807–1812",
                provider: "Edward Raczyński / Archiwum Państwowe w Poznaniu / CENAGIS IH PAN",
                bounds: [[51.49, 15.12], [52.99, 17.36]]
            },
            "kummersberg": {
                id: "kummersberg", wms_layer: "kummersberg_3857",
                title: { "ro": "Harta Administrativă a Galiției și Lodomeriei (Kummersberg) 1:115 200", "en": "Administrative Map of Galicia & Lodomeria (Kummersberg) 1:115,200", "pl": "Administrativ Karte von Galizien und Lodomerien (Kummersberg)" },
                scale: "1:115 200", years: "1855",
                provider: "Carl Ritter von Kummersberg / CENAGIS IH PAN",
                bounds: [[48.83, 18.62], [50.85, 26.68]]
            },
            "schroetter": {
                id: "schroetter", wms_layer: "schroetter_3857",
                title: { "ro": "Harta Schroetter (Prusia Răsăriteană și Apuseană) 1:150 000", "en": "Schroetter Map (East & West Prussia) 1:150,000", "pl": "Mapa Schroettera 1:150 000 (Ost- und Westpreussen)" },
                scale: "1:150 000", years: "1796–1802",
                provider: "Friedrich Leopold von Schroetter / CENAGIS IH PAN",
                bounds: [[52.3, 15.1], [55.9, 22.96]]
            },
            "gilly": {
                id: "gilly", wms_layer: "gilly_3857",
                title: { "ro": "Harta Gilly (Prusia de Sud) 1:150 000", "en": "Gilly Map (South Prussia) 1:150,000", "pl": "Mapa Gilly'ego 1:150 000 (Südpreussen)" },
                scale: "1:150 000", years: "1802–1803",
                provider: "David Gilly (Special Karte von Südpreussen) / CENAGIS IH PAN",
                bounds: [[50.07, 14.88], [53.72, 21.87]]
            },
            "textor": {
                id: "textor", wms_layer: "textor_3857",
                title: { "ro": "Harta Textor-Sotzmann (Noua Prusie Răsăriteană) 1:150 000", "en": "Textor-Sotzmann Map (New East Prussia) 1:150,000", "pl": "Mapa Textora-Sotzmanna 1:150 000 (Neu Ostpreussen)" },
                scale: "1:150 000", years: "1806–1808",
                provider: "J. C. Textor & D. F. Sotzmann / CENAGIS IH PAN",
                bounds: [[52.48, 18.56], [55.05, 24.34]]
            },
            "m25k": {
                id: "m25k", wms_layer: "m25k_3857",
                title: { "ro": "Hărțile Germane Messtischblätter 1:25 000", "en": "German Topographic Messtischblätter 1:25,000", "pl": "Messtischblätter 1:25 000" },
                scale: "1:25 000", years: "1870–1945",
                provider: "Königlich Preussische Landesaufnahme / Reichsamt für Landesaufnahme / CENAGIS IH PAN",
                bounds: [[49.39, 13.99], [55.89, 24.66]]
            },
            "kdr": {
                id: "kdr", wms_layer: "kdr_3857",
                title: { "ro": "Harta Imperiului German (Karte des Deutschen Reiches) 1:100 000", "en": "German Empire Map (Karte des Deutschen Reiches) 1:100,000", "pl": "Karte des Deutschen Reiches 1:100 000" },
                scale: "1:100 000", years: "1870–1914 (~1900)",
                provider: "Reichsamt für Landesaufnahme / CENAGIS IH PAN",
                bounds: [[47.25, 5.83], [56, 23.33]]
            },
            "kdr_gb": {
                id: "kdr_gb", wms_layer: "kdr_gb_3857",
                title: { "ro": "Harta Germană Grossblätter WWII 1:100 000", "en": "German Grossblätter WWII 1:100,000", "pl": "Karte des Deutschen Reiches – Grossblätter 1:100 000" },
                scale: "1:100 000", years: "1939–1944",
                provider: "Hauptvermessungsabteilung / CENAGIS IH PAN",
                bounds: [[47.75, 13.33], [56.75, 28.33]]
            },
            "kdwr": {
                id: "kdwr", wms_layer: "kdwr_3857",
                title: { "ro": "Harta Rusiei Vestice (Karte des Westlichen Russlands) 1:100 000", "en": "Western Russia Map (Karte des Westlichen Russlands) 1:100,000", "pl": "Karte des Westlichen Russlands 1:100 000" },
                scale: "1:100 000", years: "1914–1921",
                provider: "Kartographische Abteilung des Stellvertretenden Generalstabes / CENAGIS IH PAN",
                bounds: [[49.99, 17.33], [57.75, 27.33]]
            },
            "ukvme": {
                id: "ukvme", wms_layer: "ukvme_3857",
                title: { "ro": "Harta Europei Centrale (Übersichtskarte von Mitteleuropa) 1:300 000", "en": "Central Europe Map (Übersichtskarte von Mitteleuropa) 1:300,000", "pl": "Übersichtskarte von Mitteleuropa 1:300 000" },
                scale: "1:300 000", years: "1890–1915 (~1900)",
                provider: "Königlich Preussische Landesaufnahme / CENAGIS IH PAN",
                bounds: [[45.99, 12.33], [58.99, 34.33]]
            },
            "reymann": {
                id: "reymann", wms_layer: "reymann_3857",
                title: { "ro": "Harta Specială Reymann a Europei Centrale 1:200 000", "en": "Reymann's Special Map of Central Europe 1:200,000", "pl": "Reymann's Special-Karte von Central Europa 1:200 000" },
                scale: "1:200 000", years: "1850–1900",
                provider: "Daniel Gottlob Reymann / Flemming / CENAGIS IH PAN",
                bounds: [[46.5, 5.2], [55.8, 28.5]]
            },
            "dwuwiorstowka": {
                id: "dwuwiorstowka", wms_layer: "dwuwiorstowka_3857",
                title: { "ro": "Harta Rusă de Două Verste (Dvuhviorstka) 1:84 000", "en": "Russian 2-Verst Map (Dvukhverstka) 1:84,000", "pl": "Dwuwiorstówka 1:84 000" },
                scale: "1:84 000", years: "1908–1936",
                provider: "Военно-Топографический Отдел Главного Штаба / CENAGIS IH PAN",
                bounds: [[50, 17.5], [56, 26.5]]
            },
            "ahp_ziemie_polskie": {
                id: "ahp_ziemie_polskie", wms_layer: "ahp_ziemie_polskie_3857",
                title: { "ro": "Țările Coroanei Poloneze în sec. XVI 1:250 000", "en": "Crown Lands of Poland in 16th c. 1:250,000", "pl": "Ziemie polskie Korony w II połowie XVI w. 1:250 000" },
                scale: "1:250 000", years: "XVI w. (~1580)",
                provider: "Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)",
                bounds: [[48.88, 14.49], [55, 24.34]]
            },
            "ahp_drogi": {
                id: "ahp_drogi", wms_layer: "ahp_drogi_3857",
                title: { "ro": "Drumurile comerciale în sec. XVI 1:500 000", "en": "Trade & Postal Routes in 16th c. 1:500,000", "pl": "Drogi w II połowie XVI w. 1:500 000" },
                scale: "1:500 000", years: "XVI w. (~1580)",
                provider: "Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)",
                bounds: [[48.88, 14.49], [55, 24.34]]
            },
            "ahp_koscielne": {
                id: "ahp_koscielne", wms_layer: "ahp_koscielne_3857",
                title: { "ro": "Împărțirile ecleziastice în sec. XVI 1:500 000", "en": "Ecclesiastical Divisions in 16th c. 1:500,000", "pl": "Podziały kościelne w II połowie XVI w. 1:500 000" },
                scale: "1:500 000", years: "XVI w. (~1580)",
                provider: "Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)",
                bounds: [[48.88, 14.49], [55, 24.34]]
            },
            "ahp_wlasnosc": {
                id: "ahp_wlasnosc", wms_layer: "ahp_wlasnosc_3857",
                title: { "ro": "Structura proprietății funciare în sec. XVI 1:500 000", "en": "Land Ownership Structure in 16th c. 1:500,000", "pl": "Rozmieszczenie własności w II połowie XVI w. 1:500 000" },
                scale: "1:500 000", years: "XVI w. (~1580)",
                provider: "Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)",
                bounds: [[48.88, 14.49], [55, 24.34]]
            },
            "city_warszawa": {
                id: "city_warszawa", wms_layer: "warszawa_3857",
                title: { "ro": "Planul Varșoviei 1:25 000 (1944)", "en": "Warsaw City Plan 1:25,000 (1944)", "pl": "Plan Warszawy 1:25 000 (1944)" },
                scale: "1:25 000", years: "1944",
                provider: "Geographical Section General Staff (GSGS 4435) / WIG / CENAGIS IH PAN",
                bounds: [[52.16, 20.88], [52.3, 21.15]]
            },
            "city_krakow": {
                id: "city_krakow", wms_layer: "krakow_3857",
                title: { "ro": "Planul Cracoviei 1:25 000 (1943)", "en": "Kraków City Plan 1:25,000 (1943)", "pl": "Plan Krakowa 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[49.99, 19.87], [50.1, 20]]
            },
            "city_gdansk": {
                id: "city_gdansk", wms_layer: "gdansk_3857",
                title: { "ro": "Planul Gdańskului 1:25 000 (1944)", "en": "Gdańsk City Plan 1:25,000 (1944)", "pl": "Plan Gdańska 1:25 000 (1944)" },
                scale: "1:25 000", years: "1944",
                provider: "GSGS 4496 / WIG / CENAGIS IH PAN",
                bounds: [[54.32, 18.59], [54.42, 18.7]]
            },
            "city_wroclaw": {
                id: "city_wroclaw", wms_layer: "wroclaw_3857",
                title: { "ro": "Planul Wrocławului (Breslau) 1:25 000 (1944)", "en": "Wrocław (Breslau) City Plan 1:25,000 (1944)", "pl": "Plan Wrocławia 1:25 000 (1944)" },
                scale: "1:25 000", years: "1944",
                provider: "GSGS 4480 / WIG / CENAGIS IH PAN",
                bounds: [[51.07, 16.98], [51.14, 17.1]]
            },
            "city_poznan": {
                id: "city_poznan", wms_layer: "poznan_3857",
                title: { "ro": "Planul Poznańului 1:25 000 (1943)", "en": "Poznań City Plan 1:25,000 (1943)", "pl": "Plan Poznania 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[52.36, 16.86], [52.43, 17]]
            },
            "city_lodz": {
                id: "city_lodz", wms_layer: "lodz_3857",
                title: { "ro": "Planul orașului Łódź 1:25 000 (1943)", "en": "Łódź City Plan 1:25,000 (1943)", "pl": "Plan Łodzi 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[51.64, 19.32], [51.87, 19.55]]
            },
            "city_katowice": {
                id: "city_katowice", wms_layer: "katowice_3857",
                title: { "ro": "Planul Katowice 1:25 000 (1943)", "en": "Katowice City Plan 1:25,000 (1943)", "pl": "Plan Katowic 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[50.23, 18.98], [50.28, 19.08]]
            },
            "city_czestochowa": {
                id: "city_czestochowa", wms_layer: "czestochowa_3857",
                title: { "ro": "Planul Częstochowa 1:25 000 (1943)", "en": "Częstochowa City Plan 1:25,000 (1943)", "pl": "Plan Częstochowy 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[50.77, 19.06], [50.83, 19.17]]
            },
            "city_bialystok": {
                id: "city_bialystok", wms_layer: "bialystok_3857",
                title: { "ro": "Planul Białystok 1:25 000 (1943)", "en": "Białystok City Plan 1:25,000 (1943)", "pl": "Plan Białegostoku 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[53.09, 23.09], [53.16, 23.21]]
            },
            "city_bydgoszcz": {
                id: "city_bydgoszcz", wms_layer: "bydgoszcz_3857",
                title: { "ro": "Planul Bydgoszcz 1:25 000 (1943)", "en": "Bydgoszcz City Plan 1:25,000 (1943)", "pl": "Plan Bydgoszczy 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[53.1, 17.94], [53.15, 18.06]]
            },
            "city_torun": {
                id: "city_torun", wms_layer: "torun_3857",
                title: { "ro": "Planul Toruń 1:25 000 (1943)", "en": "Toruń City Plan 1:25,000 (1943)", "pl": "Plan Torunia 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[52.98, 18.55], [53.05, 18.66]]
            },
            "city_lublin": {
                id: "city_lublin", wms_layer: "lublin_3857",
                title: { "ro": "Planul Lublin 1:25 000 (1943)", "en": "Lublin City Plan 1:25,000 (1943)", "pl": "Plan Lublina 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[51.2, 22.52], [51.28, 22.62]]
            },
            "city_kielce": {
                id: "city_kielce", wms_layer: "kielce_3857",
                title: { "ro": "Planul Kielce 1:25 000 (1943)", "en": "Kielce City Plan 1:25,000 (1943)", "pl": "Plan Kielc 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[50.83, 20.57], [50.89, 20.69]]
            },
            "city_radom": {
                id: "city_radom", wms_layer: "radom_3857",
                title: { "ro": "Planul Radom 1:25 000 (1943)", "en": "Radom City Plan 1:25,000 (1943)", "pl": "Plan Radomia 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[51.36, 21.09], [51.42, 21.21]]
            },
            "city_rzeszow": {
                id: "city_rzeszow", wms_layer: "rzeszow_3857",
                title: { "ro": "Planul Rzeszów 1:25 000 (1943)", "en": "Rzeszów City Plan 1:25,000 (1943)", "pl": "Plan Rzeszowa 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[50.01, 21.96], [50.07, 22.05]]
            },
            "city_tarnow": {
                id: "city_tarnow", wms_layer: "tarnow_3857",
                title: { "ro": "Planul Tarnów 1:25 000 (1943)", "en": "Tarnów City Plan 1:25,000 (1943)", "pl": "Plan Tarnowa 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[49.99, 20.94], [50.03, 21.05]]
            },
            "city_grudziadz": {
                id: "city_grudziadz", wms_layer: "grudziadz_3857",
                title: { "ro": "Planul Grudziądz 1:25 000 (1943)", "en": "Grudziądz City Plan 1:25,000 (1943)", "pl": "Plan Grudziądza 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[53.46, 18.72], [53.52, 18.8]]
            },
            "city_inowroclaw": {
                id: "city_inowroclaw", wms_layer: "inowroclaw_3857",
                title: { "ro": "Planul Inowrocław 1:25 000 (1943)", "en": "Inowrocław City Plan 1:25,000 (1943)", "pl": "Plan Inowrocławia 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[52.78, 18.2], [52.82, 18.3]]
            },
            "city_jaslo": {
                id: "city_jaslo", wms_layer: "jaslo_3857",
                title: { "ro": "Planul Jasło 1:25 000 (1943)", "en": "Jasło City Plan 1:25,000 (1943)", "pl": "Plan Jasła 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[49.71, 21.41], [49.79, 21.54]]
            },
            "city_siedlce": {
                id: "city_siedlce", wms_layer: "siedlce_3857",
                title: { "ro": "Planul Siedlce 1:25 000 (1943)", "en": "Siedlce City Plan 1:25,000 (1943)", "pl": "Plan Siedlec 1:25 000 (1943)" },
                scale: "1:25 000", years: "1943",
                provider: "GSGS 4435 / WIG / CENAGIS IH PAN",
                bounds: [[52.13, 22.21], [52.2, 22.33]]
            },
            "city_warszawa_lindley": {
                id: "city_warszawa_lindley", wms_layer: "lindley_3857",
                title: { "ro": "Planul Lindley al Varșoviei 1:2 500 (1897–1901)", "en": "Lindley Warsaw Plan 1:2,500 (1897–1901)", "pl": "Warszawa - mapa Lindleyów (1897-1901)" },
                scale: "1:2 500", years: "1897–1901",
                provider: "William Heerlein Lindley / Archiwum Państwowe w Warszawie / IH PAN",
                bounds: [[52.17, 20.94], [52.31, 21.08]]
            },
            "city_warszawa_1822": {
                id: "city_warszawa_1822", wms_layer: "warszawaOKI_2180",
                title: { "ro": "Planul Capitalei Varșovia (Corpul de Ingineri) 1:4 800 (1822)", "en": "Warsaw City Plan (Corps of Engineers) 1:4,800 (1822)", "pl": "Plan miasta stołecznego Warszawy (1822)" },
                scale: "1:4 800", years: "1822",
                provider: "Oficerowie Korpusu Inżynierów (1818-1819, litogr. 1822) / AGAD / IH PAN",
                bounds: [[52.19, 20.95], [52.28, 21.07]]
            },
            "city_praga_1796": {
                id: "city_praga_1796", wms_layer: "rauch_2180",
                title: { "ro": "Planul Suburbiei Praga (Varșovia) 1:7 200 (1796)", "en": "Praga Suburb (Warsaw) Plan 1:7,200 (1796)", "pl": "Original Plan der Vorstadt Praga (1796)" },
                scale: "1:7 200", years: "1796",
                provider: "Johann Georg Gustav von Rauch / Staatsbibliothek zu Berlin / IH PAN",
                bounds: [[52.22, 20.99], [52.28, 21.07]]
            }
        }
    };

    /* ═══════════════════════════════════════════════════════════════════════
     *  LAYERS
     * ═══════════════════════════════════════════════════════════════════════ */
    var LAYERS = [
        /* ───────────────────────────── base maps ──────────────────────────── */
        {
            id: 'base.imagery', group: 'base', z: 100, kind: 'xyz', base: true,
            title: { ro: 'Imagini satelitare (Esri World Imagery)', en: 'Satellite imagery (Esri World Imagery)' },
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 18, opacity: 1,
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
            cors: 'yes', proxy: 'never',
            ui: { var2d: '_satLayer', select: 'basemap' },
            notes: 'ArcGIS basemap stack — the 2D base of the working map and the 3D base behind the draped layers.'
        },
        {
            id: 'base.topographic', group: 'base', z: 101, kind: 'xyz', base: true,
            title: { ro: 'Hartă topografică (Esri World Topo)', en: 'Topographic (Esri World Topo)' },
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 18, opacity: 1,
            attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
            cors: 'yes', proxy: 'never',
            ui: { select: 'basemap' },
            notes: 'ArcGIS basemap stack (ARCGIS_BASEMAPS.topographic).'
        },
        {
            id: 'base.terrain-base', group: 'base', z: 102, kind: 'xyz', base: true,
            title: { ro: 'Relief de bază (Esri World Terrain Base)', en: 'Terrain base (Esri World Terrain Base)' },
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 9, opacity: 1,
            attribution: 'Tiles &copy; Esri — World Terrain Base',
            cors: 'yes', proxy: 'never',
            ui: { select: 'basemap' },
            notes: 'ArcGIS basemap stack (ARCGIS_BASEMAPS.terrain, layer 1/2 — maxNativeZoom 9).'
        },
        {
            id: 'base.terrain-relief', group: 'base', z: 103, kind: 'xyz', base: true,
            title: { ro: 'Relief umbrit (Esri World Shaded Relief)', en: 'Shaded relief (Esri World Shaded Relief)' },
            url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Shaded_Relief/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 9, opacity: 1,
            attribution: 'Tiles &copy; Esri — World Shaded Relief',
            cors: 'yes', proxy: 'never',
            ui: { select: 'basemap' },
            notes: 'ArcGIS basemap stack (ARCGIS_BASEMAPS.terrain, layer 2/2 — maxNativeZoom 9).'
        },
        {
            id: 'base.hillshade', group: 'base', z: 104, kind: 'xyz', base: true, optional: true,
            title: { ro: 'World Hillshade (Esri)', en: 'World Hillshade (Esri)' },
            url: 'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 0, maxZoom: 20, maxNativeZoom: 16, opacity: 0.55,
            attribution: 'Hillshade: Esri World Hillshade',
            cors: 'yes', proxy: 'never',
            ui: {},
            notes: 'Used by map3d hillshade.mode "service". Same raster as the ArcGIS SceneView atlas page.'
        },

        /* ──────────────────── historical maps — free tier ─────────────────── */
        {
            id: 'hist.austrian', group: 'hist-free', z: 640, kind: 'wms',
            title: { ro: 'Harta Austriacă 1910', en: 'Austrian Map 1910' },
            url: 'https://services.geo-spatial.org/geoserver/eharta/wms',
            layer: 'eharta:mozaic_austrian_200k',
            format: 'image/png', transparent: true, version: '1.1.0', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 20, opacity: 0.80,
            attribution: '© geo-spatial.org / Harta Austriacă 1910',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'austrianMapToggle', slider: 'austrianMapOpacitySlider', pct: 'austrianMapPct', fn: 'toggleAustrianMap', var2d: '_austrianMapLayer', parent: 'histToggle' },
            notes: 'Mosaic of the 1:200 000 Austro-Hungarian survey. 2D asks WMS 1.1.0 (SRS=).'
        },
        {
            id: 'hist.firing-plans', group: 'hist-free', z: 641, kind: 'wms',
            title: { ro: 'Planuri de Tragere', en: 'Firing Plans' },
            url: 'https://services.geo-spatial.org/geoserver/eharta/wms',
            layer: 'eharta:mozaic_planuri_tragere_20k',
            format: 'image/png', transparent: true, version: '1.1.0', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 20, opacity: 0.80,
            attribution: '© geo-spatial.org / Planuri de Tragere',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'firingPlansToggle', slider: 'firingPlansOpacitySlider', pct: 'firingPlansPct', fn: 'toggleFiringPlans', var2d: '_firingPlansLayer', parent: 'histToggle' },
            notes: '1:20 000 artillery firing plans (WWI-era archive mosaic).'
        },
        {
            id: 'hist.soviet-1970', group: 'hist-free', z: 642, kind: 'wms',
            title: { ro: 'Harta Sovietică 1970', en: 'Soviet Map 1970' },
            url: 'https://services.geo-spatial.org/geoserver/eharta/wms',
            layer: 'eharta:mozaic_soviet100k',
            format: 'image/png', transparent: true, version: '1.1.0', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 20, opacity: 0.80,
            attribution: '© geo-spatial.org / Harta Sovietică 1970',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'sovietMapToggle', slider: 'sovietMapOpacitySlider', pct: 'sovietMapPct', fn: 'toggleSovietMap', var2d: '_sovietMapLayer', parent: 'histToggle' },
            notes: 'Soviet 1:100 000 mosaic of the 1970s.'
        },

        /* ───────────────────── premium historical maps ─────────────────────── */
        {
            id: 'premium.josephine', group: 'hist-premium', z: 650, kind: 'xyz',
            title: { ro: 'Harta Iosefină + (1780–1790)', en: 'Josephine Map + (1780–1790)' },
            /* Cloudflare R2 is the primary 3D source: it is the full mosaic
             * (z ≤ 15, whole coverage), which is what the 2D view shows outside
             * the Josephine coverage polygon as well. Supabase Storage — the
             * sharper bucket the 2D view prefers INSIDE that polygon (native
             * z10–14) — stays available as the 'supabase' alternative. */
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Josephine/{z}/{x}/{y}.jpg',
            alt: {
                'supabase': 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Joseph/{z}/{x}/{y}.png',
                'cloudflare': 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Josephine/{z}/{x}/{y}.jpg'
            },
            altMeta: {
                'supabase': { minNativeZoom: 10, maxNativeZoom: 14, cors: 'yes' }
            },
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 15, opacity: 0.80,
            attribution: '© Harta Iosefină 1780–1790 · Österreichisches Staatsarchiv / wnętrza (Cloudflare R2 / Supabase)',
            cors: 'yes', proxy: 'auto',
            ui: { toggle: 'josephineMapToggle', slider: 'josephineMapOpacitySlider', pct: 'josephineMapPct', var2d: '_jLayerRef', parent: 'histPremiumToggle' },
            notes: '2D switches between the Cloudflare R2 mirror (z≤15) and the Supabase bucket ' +
                '(native z10–14) by viewport test; both URLs come from here. 3D drapes the ' +
                'Cloudflare mosaic (the global one).'
        },
        {
            id: 'premium.bucovina', group: 'hist-premium', z: 641, kind: 'xyz',
            title: { ro: 'Galitia și Bucovina (1861–1864)', en: 'Galicia & Bukovina (1861–1864)' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/Galitzien_and_Bukovina-1861-1864/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 15, opacity: 0.80,
            attribution: '© Bucovina 1861-1864',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'bucovinaMapToggle', slider: 'bucovinaMapOpacitySlider', pct: 'bucovinaMapPct', fn: 'toggleBucovinaMap', var2d: '_bucovinaMapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'BUCOVINA_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2 public bucket); the 2D code keeps a window.<NAME>_TILE_MAX_NATIVE_Z override.'
        },
        {
            id: 'premium.austro-hungarian', group: 'hist-premium', z: 642, kind: 'xyz',
            title: { ro: 'Harta Austro-Ungară (1869–1912)', en: 'Austro-Hungarian Map (1869–1912)' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/1869-1912/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 13, opacity: 0.80,
            attribution: '© Austro-Hungarian Map 1861-1864',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'austrohuMapToggle', slider: 'austrohuMapOpacitySlider', pct: 'austrohuMapPct', fn: 'toggleAustrohuMap', var2d: '_austrohuMapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'AUSTROHU_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.moldova-1868', group: 'hist-premium', z: 643, kind: 'xyz',
            title: { ro: 'Moldova 1868', en: 'Moldova 1868' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/moldova-1868/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 13, opacity: 0.80,
            attribution: '© Moldova 1868',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'moldova1868MapToggle', slider: 'moldova1868MapOpacitySlider', pct: 'moldova1868MapPct', fn: 'toggleMoldova1868Map', var2d: '_moldova1868MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'MOLDOVA1868_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.moldova-1771', group: 'hist-premium', z: 650, kind: 'xyz',
            title: { ro: 'Moldova 1771', en: 'Moldova 1771' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Moldova_1771/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 15, opacity: 0.80,
            attribution: '© Národní knihovna České republiky',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'moldova1771MapToggle', slider: 'moldova1771MapOpacitySlider', pct: 'moldova1771MapPct', fn: 'toggleMoldova1771Map', var2d: '_moldova1771MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'MOLDOVA1771_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.moldova-wwii', group: 'hist-premium', z: 644, kind: 'xyz',
            title: { ro: 'Moldova WWII', en: 'Moldova WWII' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/moldova-wwii/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 13, opacity: 0.80,
            attribution: '© Moldova WWII',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'moldovaWwiiMapToggle', slider: 'moldovaWwiiMapOpacitySlider', pct: 'moldovaWwiiMapPct', fn: 'toggleMoldovaWwiiMap', var2d: '_moldovaWwiiMapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'MOLDOVAWWII_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.polish-tactical-1933', group: 'hist-premium', z: 645, kind: 'xyz',
            title: { ro: 'Harta tactică poloneză 1933', en: 'Polish Tactical Map 1933' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/ukraine_zapad_pl-1933/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 13, opacity: 0.80,
            attribution: '© Tactical Polish Map 1933',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'polishTactical1933MapToggle', slider: 'polishTactical1933MapOpacitySlider', pct: 'polishTactical1933MapPct', fn: 'togglePolishTactical1933Map', var2d: '_polishTactical1933MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'POLISHTACTICAL1933_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.ww1', group: 'hist-premium', z: 646, kind: 'xyz',
            title: { ro: 'Harta Primului Război Mondial', en: 'World War I Map' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/ww1/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 11, opacity: 0.80,
            attribution: '© WWI',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'ww1MapToggle', slider: 'ww1MapOpacitySlider', pct: 'ww1MapPct', fn: 'toggleWw1Map', var2d: '_ww1MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'WW1_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.ww2', group: 'hist-premium', z: 647, kind: 'xyz',
            title: { ro: 'Harta celui de-al Doilea Război Mondial', en: 'World War II Map' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Galitzien_and_Bukovina-1861-1864/ww2/{z}/{x}/{y}.jpg',
            tileSize: 256, minZoom: 8, maxZoom: 20, maxNativeZoom: 10, opacity: 0.80,
            attribution: '© WWII',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'ww2MapToggle', slider: 'ww2MapOpacitySlider', pct: 'ww2MapPct', fn: 'toggleWw2Map', var2d: '_ww2MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'WW2_TILE_MAX_NATIVE_Z' },
            notes: 'Own tile store (Cloudflare R2).'
        },
        {
            id: 'premium.banat', group: 'hist-premium', z: 649, kind: 'xyz',
            title: { ro: 'Banat (hartă istorică)', en: 'Banat (historical map)' },
            url: 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Banat/{z}/{x}/{y}.png',
            tileSize: 256, minZoom: 11, maxZoom: 20, maxNativeZoom: 15, opacity: 0.80,
            attribution: '© Banat 1769-1772',
            cors: 'yes', proxy: 'auto',
            ui: { toggle: 'banatMapToggle', slider: 'banatMapOpacitySlider', pct: 'banatMapPct', fn: 'toggleBanatMap', var2d: '_banatMapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'BANAT_TILE_MAX_NATIVE_Z' },
            notes: 'Supabase Storage public bucket (CORS-enabled).'
        },
        {
            id: 'premium.transylvania-1859', group: 'hist-premium', z: 652, kind: 'arcgis-image',
            title: { ro: 'Transilvania 1859 (Siebenbürgen)', en: 'Transylvania 1859 (Siebenbürgen)' },
            url: 'https://tiles.arcgis.com/tiles/t2AVhHhEnEvHcPF6/arcgis/rest/services/Siebenburgen_1859/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 7, maxZoom: 20, maxNativeZoom: 14, opacity: 0.80,
            bounds: [[45.2059, 22.2319], [47.7300, 26.7037]],
            attribution: '© Administrativ Karte des Grossfürstenthums Siebenbürgen (1859; 1:144 000) · Digitalizare și publicare: Universitatea „Ștefan cel Mare” din Suceava · Sursă: <a href="https://bukowina1856.eu" target="_blank" rel="noopener noreferrer">bukowina1856.eu</a>',
            cors: 'yes', proxy: 'auto',
            ui: { toggle: 'transylvania1859MapToggle', slider: 'transylvania1859MapOpacitySlider', pct: 'transylvania1859MapPct', fn: 'toggleTransylvania1859Map', var2d: '_transylvania1859MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'TRANSYLVANIA1859_TILE_MAX_NATIVE_Z' },
            notes: 'ArcGIS tiled raster service (Esri-hosted, CORS-enabled) clipped to the sheet footprint.'
        },
        {
            id: 'premium.galicia-1855', group: 'hist-premium', z: 653, kind: 'arcgis-image',
            title: { ro: 'Galitia 1855 (Kummerer)', en: 'Galicia 1855 (Kummerer)' },
            url: 'https://tiles.arcgis.com/tiles/t2AVhHhEnEvHcPF6/arcgis/rest/services/Kummerer_1855/MapServer/tile/{z}/{y}/{x}',
            tileSize: 256, minZoom: 6, maxZoom: 20, maxNativeZoom: 14, opacity: 0.80,
            attribution: '© Administrativ-Karte von Galizien und Lodomerien - Carl von Kummersberg 1855 · Digitalizare și publicare: Universitatea „Ștefan cel Mare” din Suceava · Sursă: <a href="https://bukowina1856.eu" target="_blank" rel="noopener noreferrer">bukowina1856.eu</a>',
            cors: 'yes', proxy: 'auto',
            ui: { toggle: 'galicia1855MapToggle', slider: 'galicia1855MapOpacitySlider', pct: 'galicia1855MapPct', fn: 'toggleGalicia1855Map', var2d: '_galicia1855MapLayer', parent: 'histPremiumToggle', maxNativeZoomGlobal: 'GALICIA1855_TILE_MAX_NATIVE_Z' },
            notes: 'ArcGIS tiled raster service (Esri-hosted, CORS-enabled).'
        },
        {
            id: 'premium.mitteleuropa', group: 'hist-premium', z: 654, kind: 'wms',
            title: { ro: 'Harta Europei Centrale (Übersichtskarte 1:300 000)', en: 'Central Europe (Übersichtskarte 1:300,000)' },
            url: CENAGIS.url, layer: 'ihpan:ukvme_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Übersichtskarte von Mitteleuropa 1:300 000 (1893–1945) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'mitteleuropaMapToggle', slider: 'mitteleuropaMapOpacitySlider', pct: 'mitteleuropaMapPct', fn: 'toggleMitteleuropaMap', var2d: '_mitteleuropaMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['mitteleuropa'] },
            notes: 'Premium wrapper around the CENAGIS catalogue sheet ukvme_3857 (the panel row Romanian users see first).'
        },
        {
            id: 'premium.chrzanowski', group: 'hist-premium', z: 655, kind: 'wms',
            title: { ro: 'Harta Vechii Polonii (Chrzanowski 1859)', en: 'Charter of Old Poland (Chrzanowski 1859)' },
            url: CENAGIS.url, layer: 'ihpan:chrzanowski_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Karta Dawnej Polski – Wojciech Chrzanowski (1859) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'chrzanowskiMapToggle', slider: 'chrzanowskiMapOpacitySlider', pct: 'chrzanowskiMapPct', fn: 'toggleChrzanowskiMap', var2d: '_chrzanowskiMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['chrzanowski'] },
            notes: 'Premium wrapper around CENAGIS chrzanowski_3857.'
        },
        {
            id: 'premium.reymann', group: 'hist-premium', z: 656, kind: 'wms',
            title: { ro: 'Harta Specială Reymann (1:200 000)', en: 'Reymann Special Map (1:200,000)' },
            url: CENAGIS.url, layer: 'ihpan:reymann_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Reymann\'s Special-Karte von Central-Europa (1806–1908) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'reymannMapToggle', slider: 'reymannMapOpacitySlider', pct: 'reymannMapPct', fn: 'toggleReymannMap', var2d: '_reymannMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['reymann'] },
            notes: 'Premium wrapper around CENAGIS reymann_3857.'
        },
        {
            id: 'premium.kdr-100k', group: 'hist-premium', z: 657, kind: 'wms',
            title: { ro: 'Harta Imperiului German 1:100 000 (KDR)', en: 'Karte des Deutschen Reiches 1:100,000' },
            url: CENAGIS.url, layer: 'ihpan:kdr_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Karte des Deutschen Reiches 1:100 000 (1878–1945) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'kdr100kMapToggle', slider: 'kdr100kMapOpacitySlider', pct: 'kdr100kMapPct', fn: 'toggleKdr100kMap', var2d: '_kdr100kMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['kdr100k'] },
            notes: 'Premium wrapper around CENAGIS kdr_3857.'
        },
        {
            id: 'premium.kdr-gb', group: 'hist-premium', z: 658, kind: 'wms',
            title: { ro: 'Harta Germană Grossblätter 1:100 000', en: 'German Grossblätter 1:100,000' },
            url: CENAGIS.url, layer: 'ihpan:kdr_gb_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Karte des Deutschen Reiches – Großblatt (1914–1944) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'kdrGbMapToggle', slider: 'kdrGbMapOpacitySlider', pct: 'kdrGbMapPct', fn: 'toggleKdrGbMap', var2d: '_kdrGbMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['kdrGb'] },
            notes: 'Premium wrapper around CENAGIS kdr_gb_3857.'
        },
        {
            id: 'premium.wig-100k', group: 'hist-premium', z: 659, kind: 'wms',
            title: { ro: 'Harta tactică WIG 1:100 000', en: 'WIG Tactical Map 1:100,000' },
            url: CENAGIS.url, layer: 'ihpan:wig100k_3857',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 0, maxZoom: 18, opacity: 0.80,
            attribution: '© Wojskowy Instytut Geograficzny (WIG) 1:100 000 (1919–1939) · CENAGIS / IH PAN',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'wig100kMapToggle', slider: 'wig100kMapOpacitySlider', pct: 'wig100kMapPct', fn: 'toggleWig100kMap', var2d: '_wig100kMapLayer', parent: 'histPremiumToggle', wmsHealthKeys: ['wig100k'] },
            notes: 'Premium wrapper around CENAGIS wig100k_3857.'
        },

        /* ───────────────────────── CORONA (1960s) ──────────────────────────── */
        {
            id: 'sat.corona-60s', group: 'hist-sat', z: 648, kind: 'dynamic',
            title: { ro: 'Imagini satelitare 60\'s (CORONA)', en: 'Satellite imagery 60s (CORONA)' },
            /* One MapLibre raster source PER CORONA product, built at runtime from
             * the catalogue (js/corona-wms-layer.js) — see map3d-terrain.js. */
            url: 'https://geoserve.cast.uark.edu/geoserver/gwc/service/wms',
            layer: 'corona:<product>',
            format: 'image/png', transparent: true, version: '1.1.1', crs: 'EPSG:900913',
            params: { tiled: 'true' },
            tileSize: 256, minZoom: 8, maxZoom: 20, opacity: 0.85,
            cors: 'no', proxy: 'always',
            ui: { toggle: 'satellite60sMapToggle', slider: 'satellite60sMapOpacitySlider', pct: 'satellite60sMapPct', fn: 'toggleSatellite60sMap', var2d: '_sat60MapLayer', parent: 'histPremiumToggle' },
            notes: 'CAST University of Arkansas GeoWebCache (WMS-C). Sends no CORS header (SATELLITE_60s_FIX.md) ' +
                'so 3D always goes through the same-origin proxy. Pass mosaics at z8–z11, individual frames z12–z20.'
        },

        /* ──────────── historical / recent satellite mosaics (Copernicus) ──── */
        {
            id: 'sat.vhr-2012', group: 'sat-hist', z: 400, kind: 'wms', time: null,
            title: { ro: 'Satelit 2012 (Copernicus VHR)', en: 'Satellite 2012 (Copernicus VHR)' },
            url: 'https://copernicus.discomap.eea.europa.eu/arcgis/services/GioLand/VeryHighResolution2012/MapServer/WMSServer',
            layer: 'Image', format: 'image/jpeg', transparent: false, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 17, opacity: 1,
            attribution: "&copy; European Union's Copernicus Land Monitoring Service information",
            cors: 'no', proxy: 'always',
            ui: { select: 'satHistPeriod', slider: 'satHistOpacitySlider', pct: 'satHistOpacityPct', fn: 'setSatHistPeriod' },
            notes: 'EEA discomap ArcGIS WMSServer. The 2D code loads it without crossOrigin because ' +
                'discomap does not guarantee CORS headers — 3D therefore uses the proxy.'
        },
        {
            id: 'sat.vhr-2018', group: 'sat-hist', z: 401, kind: 'wms',
            title: { ro: 'Satelit 2018 (Copernicus VHR)', en: 'Satellite 2018 (Copernicus VHR)' },
            url: 'https://image.discomap.eea.europa.eu/arcgis/services/GioLand/VHR_2018_WM/ImageServer/WMSServer',
            layer: 'VHR_2018_WM', format: 'image/jpeg', transparent: false, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 17, opacity: 1,
            attribution: "&copy; European Union's Copernicus Land Monitoring Service information",
            cors: 'no', proxy: 'always',
            ui: { select: 'satHistPeriod', slider: 'satHistOpacitySlider', pct: 'satHistOpacityPct', fn: 'setSatHistPeriod' },
            notes: 'EEA discomap — no guaranteed CORS, 3D uses the proxy.'
        },
        {
            id: 'sat.vhr-2021', group: 'sat-hist', z: 402, kind: 'wms',
            title: { ro: 'Satelit 2021 (Copernicus VHR)', en: 'Satellite 2021 (Copernicus VHR)' },
            url: 'https://image.discomap.eea.europa.eu/arcgis/services/GioLand/VHR_2021_LAEA/ImageServer/WMSServer',
            layer: 'VHR_2021_LAEA', format: 'image/jpeg', transparent: false, version: '1.1.1', crs: 'EPSG:3857',
            tileSize: 256, minZoom: 1, maxZoom: 20, maxNativeZoom: 17, opacity: 1,
            attribution: "&copy; European Union's Copernicus Land Monitoring Service information",
            cors: 'no', proxy: 'always',
            ui: { select: 'satHistPeriod', slider: 'satHistOpacitySlider', pct: 'satHistOpacityPct', fn: 'setSatHistPeriod' },
            notes: 'EEA discomap — source really is LAEA; the proxy asks for EPSG:3857 (WMS 1.1.1 SRS, ' +
                'ArcGIS reprojects server-side). If the service ever refuses, override crs to EPSG:3035 ' +
                'and the proxy will transform the tile bbox.'
        },

        /* ─────────────────────────────── LiDAR ─────────────────────────────── */
        {
            id: 'lidar.nl-ahn', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'AhnLidar', fn: 'exportImageUrl', kind: 'bbox' },   /* URL builder needs the tile bbox instead of z/x/y substitution */
            title: { ro: 'Țările de Jos · AHN (DTM/DSM)', en: 'Netherlands · AHN (DTM/DSM)' },
            url: 'https://ahn.arcgisonline.nl/arcgis/rest/services/Hoogtebestand',
            layer: 'exportImage', format: 'image/png', transparent: true, version: '',
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© AHN / Esri Nederland',
            cors: 'yes', proxy: 'auto',
            resolve: function () {
                var mod = root && root.AhnLidar;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('netherlandsLidarModeSelect'), module: 'AhnLidar' };
            },
            ui: { toggle: 'lidarNlAhnToggle', select: 'netherlandsLidarModeSelect' },
            notes: 'ArcGIS ImageServer exportImage (hillshade/relief/slope/DSM renderers, mode dropdown). ' +
                'URL builder lives in js/ahn-layer.js — the registry points at it, nothing is duplicated.'
        },
        {
            id: 'lidar.no-hoydedata', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'Hoydedata', fn: 'exportImageUrl', kind: 'bbox' },   /* URL builder needs the tile bbox instead of z/x/y substitution */
            title: { ro: 'Norvegia · Kartverket Høydedata', en: 'Norway · Kartverket Høydedata' },
            url: 'https://hoydedata.no/arcgis/rest/services',
            layer: 'exportImage', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© Kartverket (høydedata.no)',
            cors: 'yes', proxy: 'auto',
            resolve: function () {
                var mod = root && root.Hoydedata;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('norwayLidarModeSelect'), module: 'Hoydedata' };
            },
            ui: { toggle: 'lidarNoHoydedataToggle', select: 'norwayLidarModeSelect' },
            notes: 'ArcGIS ImageServer (DTM/DSM/LAZ relief). URL builder: js/hoydedata-layer.js.'
        },
        {
            id: 'lidar.pl-nmt', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'GeoportalNMT', fn: 'tileUrl', kind: 'bbox' },   /* URL builder needs the tile bbox instead of z/x/y substitution */
            title: { ro: 'Polonia · GUGiK NMT (cieniowanie/hipsometria)', en: 'Poland · GUGiK NMT (shading/hypsometry)' },
            url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WMS/',
            layer: 'Raster', format: 'image/png', transparent: true, version: '1.3.0',
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© GUGiK / geoportal.gov.pl',
            cors: 'unknown', proxy: 'auto',
            resolve: function () {
                var mod = root && root.GeoportalNMT;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('polandLidarModeSelect'), module: 'GeoportalNMT' };
            },
            ui: { toggle: 'lidarPlLidarToggle', select: 'polandLidarModeSelect' },
            notes: 'Geoportal Krajowy WMS (NMT GRID1). URL builder: js/geoportal-nmt-layer.js.'
        },
        {
            id: 'lidar.es-mdt', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'IgnMdt', fn: 'tileUrl', kind: 'bbox' },   /* URL builder needs the tile bbox instead of z/x/y substitution */
            title: { ro: 'Spania · IGN MDT/LiDAR', en: 'Spain · IGN MDT/LiDAR' },
            url: 'https://wms-mapa-lidar.idee.es/lidar',
            layer: 'EL.GridCoverage', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© IGN España / IDEE',
            cors: 'unknown', proxy: 'auto',
            resolve: function () {
                var mod = root && root.IgnMdt;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('spainLidarModeSelect'), module: 'IgnMdt' };
            },
            ui: { toggle: 'lidarEsLidarToggle', select: 'spainLidarModeSelect' },
            notes: 'IGN MDT WMS. URL builder: js/ign-mdt-layer.js (window.SPAIN_LIDAR_PROXY_URL supported).'
        },
        {
            id: 'lidar.ch-swisstopo', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'SwisstopoRelief', fn: 'tileUrl', kind: 'tile' },   /* URL builder takes z/x/y directly */
            title: { ro: 'Elveția · swisstopo relief', en: 'Switzerland · swisstopo relief' },
            url: 'https://wmts.geo.admin.ch',
            layer: '', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© swisstopo',
            cors: 'yes', proxy: 'auto',
            resolve: function () {
                var mod = root && root.SwisstopoRelief;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('switzerlandLidarModeSelect'), module: 'SwisstopoRelief' };
            },
            ui: { toggle: 'lidarChLidarToggle', select: 'switzerlandLidarModeSelect' },
            notes: 'swisstopo WMTS (relief/hillshade). URL builder: js/swisstopo-relief-layer.js. CORS: * (SWITZERLAND_LIDAR_SWISSTOPO.md).'
        },
        {
            id: 'lidar.uk-ea', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'EaLidarWmts', fn: 'tileUrl', kind: 'tile' },   /* URL builder takes z/x/y directly */
            title: { ro: 'Marea Britanie · Environment Agency LiDAR', en: 'UK · Environment Agency LiDAR' },
            url: 'https://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wms',
            layer: '', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© Environment Agency (Open Government Licence)',
            cors: 'yes', proxy: 'auto',
            resolve: function () {
                var mod = root && root.EaLidarWmts;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('ukLidarModeSelect'), module: 'EaLidarWmts' };
            },
            ui: { toggle: 'lidarUkLidarToggle', select: 'ukLidarModeSelect' },
            notes: 'EA WMTS (hillshade/DTM/DSM). URL builder: js/ea-lidar-wmts-layer.js. CORS: * on tiles (UK_LIDAR_EA_WMTS.md).'
        },
        {
            id: 'lidar.dk-dhm', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'DataforsyningenDHM', fn: 'tileUrl', kind: 'tile' },   /* URL builder takes z/x/y directly */
            title: { ro: 'Danemarca · Dataforsyningen DHM', en: 'Denmark · Dataforsyningen DHM' },
            url: '/api/geo/dk-dhm',
            layer: 'dhm', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© Styrelsen for Dataforsyning og Infrastruktur (DHM)',
            cors: 'yes', proxy: 'never',
            resolve: function () {
                var mod = root && root.DataforsyningenDHM;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('denmarkLidarModeSelect'), module: 'DataforsyningenDHM' };
            },
            ui: { toggle: 'lidarDkLidarToggle', select: 'denmarkLidarModeSelect' },
            notes: 'Goes through the existing Netlify token function /api/geo/dk-dhm (DATAFORSYNINGEN_TOKEN). ' +
                'The module already emits same-origin URLs, so 3D reuses them unchanged.'
        },
        {
            id: 'lidar.se-lantmateriet', group: 'lidar', z: 610, kind: 'dynamic',
            /* builder: how the module in js/ turns one tile into one URL. */
            builder: { module: 'LantmaterietHojdmodell', fn: 'tileUrl', kind: 'bbox' },   /* URL builder needs the tile bbox instead of z/x/y substitution */
            title: { ro: 'Suedia · Lantmäteriet höjdmodell', en: 'Sweden · Lantmäteriet höjdmodell' },
            url: '/api/geo/se-hojdmodell',
            layer: '', format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© Lantmäteriet (höjdmodell)',
            cors: 'yes', proxy: 'never',
            resolve: function () {
                var mod = root && root.LantmaterietHojdmodell;
                if (!mod || typeof mod.tileUrl !== 'function') return null;
                return { mode: moduleMode('swedenLidarModeSelect'), module: 'LantmaterietHojdmodell' };
            },
            ui: { toggle: 'lidarSeLidarToggle', select: 'swedenLidarModeSelect' },
            notes: 'Licensed product: the existing Netlify function /api/geo/se-hojdmodell attaches the ' +
                'LANTMATERIET_WMS_* credentials server-side (never in the browser).'
        },
        {
            id: 'lidar.fr-mnh', group: 'lidar', z: 610, kind: 'wms',
            title: { ro: 'Franța · IGN LiDAR HD (MNT/MNS/MNH)', en: 'France · IGN LiDAR HD (DTM/DSM/CHM)' },
            url: 'https://data.geopf.fr/wms-r/wms',
            layer: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW',
            /* One WMS, three products, switched from the 2D dropdown: the mode
             * table lives here and js/map-app.js reads it from this registry
             * (single definition, no drift). `layerOf()` resolves the current
             * mode at tile time in BOTH views. */
            modes: {
                terrain: {
                    label: 'MNT · Terrain',
                    layer: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW'
                },
                surface: {
                    label: 'MNS · Surface',
                    layer: 'IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW'
                },
                height: {
                    label: 'MNH · Height',
                    layer: 'IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW'
                }
            },
            version: '1.3.0', crs: 'EPSG:3857',
            format: 'image/png', transparent: true,
            tileSize: 256, minZoom: 6, maxZoom: 20, opacity: 1,
            attribution: '© IGN France / Géoplateforme — LiDAR HD',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'lidarFrLidarToggle', select: 'franceLidarModeSelect' },
            notes: 'Géoplateforme LiDAR HD WMS 1.3.0 (EPSG:3857). The 2D map and the ' +
                '3D view both read the layer name for the selected product from `modes`.'
        },

        /* ─────────────────── vegetation phenology (WMTS + TIME) ───────────── */
        {
            id: 'vegfp.ppi', group: 'vegfp', z: 612, kind: 'wmts', timeAware: true,
            title: { ro: 'Vegetație PPI (dekadal)', en: 'Vegetation PPI (dekadal)' },
            url: 'https://phenology.hrvpp2.vgt.vito.be/wmts',
            layer: 'CLMS_HRVPP_ST_PPI_10M', format: 'image/png', transparent: true, version: '1.0.0',
            crs: 'EPSG:3857', tileSize: 256,
            time: { param: 'TIME', value: '2024-07-01', from: 'vegfpPpiDate' },
            minZoom: 6, maxZoom: 20, maxNativeZoom: 15, opacity: 0.85,
            bounds: [[43.4, 19.9], [48.6, 30.1]],
            attribution: '© Copernicus Land Monitoring Service — HR-VPP (10 m)',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'vegfpPpiToggle', select: 'vegfpPpiDate' },
            notes: 'CLMS HR-VPP WMTS KVP GetTile, EPSG:3857 tile matrix — identical grid to the 3D tiles, ' +
                'so the time dimension maps 1:1. TIME is carried over from the same 2D dropdown.'
        },
        {
            id: 'vegfp.smx', group: 'vegfp', z: 612, kind: 'wmts', timeAware: true,
            title: { ro: 'Vegetație SMX (max sezon)', en: 'Vegetation SMX (season max)' },
            url: 'https://phenology.hrvpp2.vgt.vito.be/wmts',
            layer: 'CLMS_HRVPP_VPP_MAXV_SEASON1_10M', format: 'image/png', transparent: true, version: '1.0.0',
            crs: 'EPSG:3857', tileSize: 256,
            time: { param: 'TIME', value: '2024-01-01', from: 'vegfpSmxYear' },
            minZoom: 6, maxZoom: 20, maxNativeZoom: 15, opacity: 0.85,
            bounds: [[43.4, 19.9], [48.6, 30.1]],
            attribution: '© Copernicus Land Monitoring Service — HR-VPP (10 m)',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'vegfpSmxToggle', select: 'vegfpSmxYear' },
            notes: 'WMTS time dimension = year (YYYY-01-01).'
        },
        {
            id: 'vegfp.sgu', group: 'vegfp', z: 612, kind: 'wmts', timeAware: true,
            title: { ro: 'Vegetație SGU (start sezon)', en: 'Vegetation SGU (season start)' },
            url: 'https://phenology.hrvpp2.vgt.vito.be/wmts',
            layer: 'CLMS_HRVPP_VPP_LSLOPE_SEASON1_10M', format: 'image/png', transparent: true, version: '1.0.0',
            crs: 'EPSG:3857', tileSize: 256,
            time: { param: 'TIME', value: '2024-01-01', from: 'vegfpSguYear' },
            minZoom: 6, maxZoom: 20, maxNativeZoom: 15, opacity: 0.85,
            bounds: [[43.4, 19.9], [48.6, 30.1]],
            attribution: '© Copernicus Land Monitoring Service — HR-VPP (10 m)',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'vegfpSguToggle', select: 'vegfpSguYear' },
            notes: 'WMTS time dimension = year (YYYY-01-01).'
        },
        {
            id: 'vegfp.sgd', group: 'vegfp', z: 612, kind: 'wmts', timeAware: true,
            title: { ro: 'Vegetație SGD (sfârșit sezon)', en: 'Vegetation SGD (season end)' },
            url: 'https://phenology.hrvpp2.vgt.vito.be/wmts',
            layer: 'CLMS_HRVPP_VPP_RSLOPE_SEASON1_10M', format: 'image/png', transparent: true, version: '1.0.0',
            crs: 'EPSG:3857', tileSize: 256,
            time: { param: 'TIME', value: '2024-01-01', from: 'vegfpSgdYear' },
            minZoom: 6, maxZoom: 20, maxNativeZoom: 15, opacity: 0.85,
            bounds: [[43.4, 19.9], [48.6, 30.1]],
            attribution: '© Copernicus Land Monitoring Service — HR-VPP (10 m)',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'vegfpSgdToggle', select: 'vegfpSgdYear' },
            notes: 'WMTS time dimension = year (YYYY-01-01).'
        },

        /* ──────────────────── analysis rasters (own tile stores) ──────────── */
        {
            id: 'apm.tiles', group: 'apm', z: 645, kind: 'xyz', optional: true,
            title: { ro: 'APM 2.0 (potențial arheologic)', en: 'APM 2.0 (archaeological potential)' },
            url: 'https://sclav.andreiroba2000.workers.dev/APM_TILES/{z}/{x}/{y}.png',
            tileSize: 256, minZoom: 0, maxZoom: 20, opacity: 0.85,
            attribution: 'DetectLab APM 2.0',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'apm20Toggle', slider: 'apm20OpacitySlider', pct: 'apm20Pct', fn: 'toggleApm20Layer' },
            notes: 'Analysis raster (own Cloudflare worker). Carried into 3D when its 2D switch is on.'
        },
        {
            id: 'uat.tiles', group: 'uat', z: 402, kind: 'xyz', optional: true,
            title: { ro: 'UAT (unități administrative)', en: 'UAT (administrative units)' },
            url: 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/UAT/{z}/{x}/{y}.png',
            tileSize: 256, minZoom: 0, maxZoom: 20, opacity: 1,
            attribution: 'UAT — DetectLab',
            cors: 'unknown', proxy: 'auto',
            ui: { toggle: 'uatToggle', fn: 'toggleUatLayer' },
            notes: 'Administrative-boundary raster tiles (R2). URL override: window.UAT_TILE_URL.'
        },

        /* ───────────────────── dynamic 2D image overlays ──────────────────── */
        {
            id: 'overlay.image-overlays', group: 'image-overlay', z: 630, kind: 'dynamic', runtimeOverlays: true,
            title: { ro: 'Suprapuneri imagine dinamice', en: 'Dynamic image overlays' },
            url: '', layer: '', tileSize: 256, opacity: 0.80,
            attribution: '',
            cors: 'yes', proxy: 'never',
            ui: { runtime: true },
            notes: 'Any L.ImageOverlay the 2D app is showing (e.g. the per-locality “Harta Iosefină” ' +
                'Wikipedia sheet loaded by iosfree) is mirrored into 3D as an image source with the ' +
                'exact bounds from Leaflet — no georeferencing is invented.'
        }
    ];

    /* CENAGIS catalogue sheets → one LAYERS entry each (id prefix “cenagis.”). */
    (function expandCenagis() {
        var maps = CENAGIS.maps || {};
        Object.keys(maps).forEach(function (key) {
            var meta = maps[key];
            var layerName = CENAGIS.workspace + ':' + meta.wms_layer;
            /* The two EPSG:2180-only sheets cannot be served on the Web
             * Mercator grid: the proxy re-projects the tile bbox. */
            var nativeIs2180 = /_2180$/.test(meta.wms_layer);
            LAYERS.push({
                id: 'cenagis.' + key,
                cenagisKey: key,
                group: 'hist-premium',
                z: 635,                     /* all catalogue rows share the 2D pane z-index */
                kind: 'wms',
                title: meta.title,
                url: CENAGIS.url,
                layer: layerName,
                format: CENAGIS.format,
                transparent: CENAGIS.transparent,
                version: CENAGIS.version,
                crs: nativeIs2180 ? 'EPSG:2180' : 'EPSG:3857',
                reproject: nativeIs2180,
                tileSize: 256,
                minZoom: 0, maxZoom: 20, opacity: CENAGIS.opacity,
                bounds: meta.bounds,
                scale: meta.scale,
                years: meta.years,
                provider: meta.provider,
                attribution: '© ' + meta.provider + ' · <a href="https://pastmaps.cenagis.edu.pl" target="_blank" rel="noopener">CENAGIS</a> / <a href="https://atlasfontium.pl" target="_blank" rel="noopener">IH PAN</a>',
                cors: CENAGIS.cors,
                proxy: 'auto',
                ui: { selector: '.cenagis-toggle[data-map-key="' + key + '"]', sliderSelector: '.cenagis-opacity-slider[data-map-key="' + key + '"]', pctSelector: '.cenagis-pct[data-map-key="' + key + '"]', fn: 'DetectLabEuMaps.toggleCenagisLayer', fnKey: key, parent: 'histPremiumToggle', wmsHealthKeys: [key] },
                notes: nativeIs2180
                    ? 'EPSG:2180 ONLY — the proxy transforms the Web-Mercator tile bbox into PL-1992 ' +
                      'before calling GetMap (see MAP_3D_TERRAIN.md §Problem layers).'
                    : 'CENAGIS/IH PAN sheet, EPSG:3857.'
            });
        });
    }());

    /* ── index ─────────────────────────────────────────────────────────────── */
    var BY_ID = {};
    LAYERS.forEach(function (def) { BY_ID[def.id] = def; });

    function cenagisCatalog() {
        /* Same shape js/historical-eu-maps.js has always used. */
        var out = {};
        Object.keys(CENAGIS.maps || {}).forEach(function (key) {
            var meta = CENAGIS.maps[key];
            out[key] = {
                id: meta.id || key,
                wms_layer: meta.wms_layer,
                title: meta.title,
                scale: meta.scale,
                years: meta.years,
                provider: meta.provider,
                bounds: clone(meta.bounds)
            };
        });
        return out;
    }

    function get(id) { return BY_ID[id] || null; }

    /* ═══════════════════════════════════════════════════════════════════════
     *  MIRROR STUBS — layers that only exist on the live 2D map
     * -----------------------------------------------------------------------
     *  The registry describes the services; the 2D map decides which of them
     *  are actually drawn. A layer the 2D app builds on its own (a plugin, a
     *  runtime overlay, a group the panel creates lazily, a layer registered
     *  from the console) has no definition here, and used to be invisible to
     *  everything that reads this registry — including the 3D view.
     *
     *  js/map3d-mirror.js describes exactly those layers. They are folded in
     *  as read-only stub definitions, so `list()`/`ordered()`/`diagnostics()`
     *  cover every visible layer. An explicit definition always wins.
     * ═══════════════════════════════════════════════════════════════════════ */
    var STUBS = { cache: null, at: 0 };

    var STUB_KIND = {
        raster: 'xyz',
        image: 'image-overlay',
        vector: 'geojson',
        markers: 'marker',
        cluster: 'cluster',
        heat: 'heatmap',
        video: 'video',
        unsupported: 'unsupported'
    };

    function mirrorStubs() {
        var mirror = root && root.DetectLabMirror;
        if (!mirror || typeof mirror.collect !== 'function' || typeof mirror.describe !== 'function') return [];
        var map = root._dlMap || root.map;
        if (!map || typeof map.eachLayer !== 'function') return [];
        /* `list()` is called from the status panel and the tests, so the walk
         * is cached for a second — the mirror itself is the source of truth,
         * this only avoids re-walking an unchanged map. */
        var now = Date.now();
        if (STUBS.cache && now - STUBS.at < 1000) return STUBS.cache;
        var out = [];
        try {
            var collected = mirror.collect(map);
            (collected.items || []).forEach(function (item) {
                if (!item || !item.key || BY_ID[item.key]) return;      /* explicit definition wins */
                out.push(stubDef(item));
            });
        } catch (e) { out = []; }
        STUBS.cache = out;
        STUBS.at = now;
        return out;
    }

    function stubDef(item) {
        var title = item.label || item.key;
        return {
            id: item.key,
            stub: true,                       /* mirrored from the live 2D map */
            group: 'mirror',
            z: item.z == null ? 1000 : item.z,
            kind: STUB_KIND[item.kind] || 'xyz',
            kind3d: item.kind,
            url: item.template || item.url || '',
            template: item.template || '',
            layer: '',
            opacity: item.opacity == null ? 1 : item.opacity,
            tileSize: item.tileSize || 256,
            minZoom: item.minzoom == null ? 0 : item.minzoom,
            maxZoom: item.maxzoom == null ? 20 : item.maxzoom,
            bounds: item.bounds || null,
            attribution: item.attribution || '',
            cors: 'unknown',
            proxy: 'auto',
            modes: null,
            ui: { mirror: true },
            title: { ro: title, en: title },
            notes: 'mirrored from the live 2D map (' + item.kind + '); tile URLs are built by the 2D layer itself'
        };
    }

    /** Explicit definitions + everything the live 2D map is showing. */
    function list() { return LAYERS.concat(mirrorStubs()); }

    function byGroup(group) {
        return list().filter(function (def) { return def.group === group; });
    }

    /* Draw order for the 3D deck: base first, then the 2D pane z-index, then
     * the panel order — exactly what Leaflet does with its panes. */
    function ordered() {
        var all = list();
        return all.sort(function (a, b) {
            var za = a.z == null ? 1000 : a.z, zb = b.z == null ? 1000 : b.z;
            if (za !== zb) return za - zb;
            return all.indexOf(a) - all.indexOf(b);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  MATCHING — which definition is a live 2D layer built from?
     * -----------------------------------------------------------------------
     *  Used by js/map3d-mirror.js when it translates a Leaflet layer: a layer
     *  that matches a definition inherits its title, attribution, CORS/proxy
     *  policy and zoom window instead of being an anonymous tile layer.
     *  Matching is deliberately strict (host + path + LAYERS), so a runtime
     *  layer of the user's own is never mistaken for a defined one.
     * ═══════════════════════════════════════════════════════════════════════ */
    function normalizeUrl(url) {
        return String(url || '')
            .replace(/^https?:\/\//i, '')
            .replace(/\{[^}]*\}/g, '{x}')
            .replace(/\?.*$/, '')
            .replace(/\/+$/, '')
            .toLowerCase();
    }

    function normalizeLayers(value) {
        return String(value || '').split(',').map(function (part) { return part.trim().toLowerCase(); })
            .filter(Boolean).sort().join(',');
    }

    function matchDef(probe) {
        if (!probe || !probe.url) return null;
        var url = normalizeUrl(probe.url);
        var layers = normalizeLayers(probe.layers);
        var version = probe.version == null ? '' : String(probe.version);
        for (var i = 0; i < LAYERS.length; i += 1) {
            var def = LAYERS[i];
            var candidates = [def.url].concat(Object.keys(def.alt || {}).map(function (key) { return def.alt[key]; }));
            for (var c = 0; c < candidates.length; c += 1) {
                if (normalizeUrl(candidates[c]) !== url) continue;
                var defLayers = normalizeLayers(def.layer || def.layers);
                /* A WMS/WMTS request carries its LAYERS: when both sides have
                 * one it must be the same service, so two definitions sharing
                 * an endpoint are never interchangeable. */
                if (layers && defLayers && layers !== defLayers) continue;
                if (version && def.version && String(def.version) !== version && layers && defLayers) continue;
                return def;                                            /* first exact hit wins */
            }
        }
        return null;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  HOST POLICY — may the 3D view fetch a host directly?
     *  Answers with what the definitions already declare about their hosts, so
     *  a tile request is routed (direct or via the same-origin proxy) without
     *  waiting for a failed request. 'unknown' = try direct, heal if it fails.
     * ═══════════════════════════════════════════════════════════════════════ */
    var HOSTS = null;

    function hostOf(def) {
        var url = def && (def.url || def.template || '');
        var m = String(url).match(/^https?:\/\/([^/?#]+)/i);
        return m ? m[1].toLowerCase() : '';
    }

    function hostPolicy() {
        if (HOSTS) return HOSTS;
        HOSTS = {};
        function note(host, cors, proxy) {
            if (!host) return;
            var verdict = (proxy === 'never') ? 'never'
                : (proxy === 'always' || cors === 'no') ? 'always'
                    : (cors === 'yes' ? 'never' : 'unknown');
            /* An explicit "never" is only overridden by an explicit "always". */
            if (!HOSTS[host] || verdict === 'always' || (HOSTS[host] === 'unknown' && verdict === 'never')) {
                HOSTS[host] = verdict;
            }
        }
        LAYERS.forEach(function (def) {
            note(hostOf(def), def.cors, def.proxy);
            Object.keys(def.alt || {}).forEach(function (key) {
                note(hostOf({ url: def.alt[key] }), def.cors, def.proxy);
            });
        });
        /* Hosts whose verdict is documented in MAP_3D_TERRAIN.md §“CORS /
         * transport” — kept here so the first 3D paint already takes the right
         * route instead of burning a wave of failed tiles. `auto`/`unknown`
         * hosts are deliberately absent: the viewer tries them directly and
         * heals to the proxy for the rest of the session. */
        note('server.arcgisonline.com', 'yes', 'never');
        note('services.arcgisonline.com', 'yes', 'never');
        note('tiles.arcgis.com', 'yes', 'never');
        note('s3.amazonaws.com', 'yes', 'never');
        note('api.maptiler.com', 'yes', 'never');
        note('image.discomap.eea.europa.eu', 'no', 'always');
        note('copernicus.discomap.eea.europa.eu', 'no', 'always');
        note('geoserve.cast.uark.edu', 'no', 'always');
        return HOSTS;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  URL / PARAMETER BUILDERS — shared by the 2D view, the 3D view and the
     *  proxy. Pure string work: no DOM, no fetch, safe in Node.
     * ═══════════════════════════════════════════════════════════════════════ */
    function lngLatTo3857(lng, lat) {
        var R = 6378137;
        var x = R * lng * Math.PI / 180;
        var y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
        return [x, y];
    }

    /** [minX, minY, maxX, maxY] of one raster tile on the Web-Mercator grid. */
    function tileBounds3857At(z, x, y) {
        var R = 6378137, half = Math.PI * R;
        var size = (2 * half) / Math.pow(2, z);
        var minX = -half + x * size;
        var maxY = half - y * size;
        return [minX, maxY - size, minX + size, maxY];
    }

    function boundsTo3857(bounds) {
        if (!bounds) return null;
        var sw = bounds[0], ne = bounds[1];
        var a = lngLatTo3857(sw[1], sw[0]);
        var b = lngLatTo3857(ne[1], ne[0]);
        return [a[0], a[1], b[0], b[1]];
    }

    /* Extra KVP params (custom params, TIME, plus anything a caller adds). */
    function extraParams(def, opts) {
        opts = opts || {};
        var parts = [];
        var params = def.params || {};
        Object.keys(params).forEach(function (key) {
            if (params[key] === '' || params[key] == null) return;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
        });
        var time = opts.time != null ? opts.time : (def.time ? def.time.value : null);
        if (def.time && time != null && time !== '') {
            parts.push(encodeURIComponent(def.time.param || 'TIME') + '=' + encodeURIComponent(time));
        }
        return parts;
    }

    /**
     * WMS GetMap template for the 3D view.
     * Uses MapLibre's `{bbox-epsg-3857}` placeholder: every request is a
     * Web-Mercator tile, so WMS 1.3.0 axis order is always x,y (lon,lat),
     * which is exactly what the placeholder provides.
     */
    function wmsTemplate(def, opts) {
        opts = opts || {};
        var size = opts.tileSize || def.tileSize || 256;
        var query = [
            'service=WMS',
            'request=GetMap',
            'version=' + encodeURIComponent(def.version || '1.3.0'),
            'layers=' + encodeURIComponent(layerOf(def, opts)),
            'styles=',
            'format=' + encodeURIComponent(def.format || 'image/png'),
            'transparent=' + (def.transparent ? 'true' : 'false'),
            (String(def.version || '1.3.0') >= '1.3.0' ? 'crs=' : 'srs=') + encodeURIComponent(opts.crs || def.crs || 'EPSG:3857'),
            'width=' + size,
            'height=' + size,
            'bbox={bbox-epsg-3857}'
        ].concat(extraParams(def, opts));
        return def.url + (def.url.indexOf('?') === -1 ? '?' : '&') + query.join('&');
    }

    /** WMTS KVP GetTile template (time dimension included when declared). */
    function wmtsTemplate(def, opts) {
        opts = opts || {};
        var query = [
            'SERVICE=WMTS',
            'REQUEST=GetTile',
            'VERSION=' + encodeURIComponent(def.version || '1.0.0'),
            'LAYER=' + encodeURIComponent(def.layer || ''),
            'STYLE=',
            'FORMAT=' + encodeURIComponent(def.format || 'image/png'),
            'TILEMATRIXSET=' + encodeURIComponent(def.crs || 'EPSG:3857'),
            'TILEMATRIX=' + encodeURIComponent(def.crs || 'EPSG:3857') + '%3A{z}',
            'TILEROW={y}',
            'TILECOL={x}'
        ].concat(extraParams(def, opts));
        return def.url + (def.url.indexOf('?') === -1 ? '?' : '&') + query.join('&');
    }

    /** Direct (no proxy) tile template for a definition. */
    function directTemplate(def, opts) {
        opts = opts || {};
        var resolved = resolveDef(def, opts.modules);
        if (!resolved) return null;
        if (resolved.template) return resolved.template;
        if (resolved.kind === 'wms') return wmsTemplate(resolved, opts);
        if (resolved.kind === 'wmts') return wmtsTemplate(resolved, opts);
        var url = opts.url || resolved.url || '';
        if (!url) return null;
        if (resolved.scheme === 'tms') return url;   /* MapLibre flips y itself */
        return url;
    }

    /** Same-origin proxy template (used when CORS is missing / reprojection is needed). */
    function proxyTemplate(def, opts) {
        opts = opts || {};
        var cfg = config();
        if (!cfg.proxy || cfg.proxy.enabled === false) return null;
        var base = opts.proxyBase || cfg.proxy.base;
        var template = base + '?layer=' + encodeURIComponent(def.id) + '&z={z}&x={x}&y={y}';
        var time = opts.time != null ? opts.time : (def.time ? def.time.value : null);
        if (time != null && time !== '') template += '&t=' + encodeURIComponent(time);
        /* CORONA and other per-product services: one product per tile request. */
        if (opts.proxyProduct) template += '&p=' + encodeURIComponent(opts.proxyProduct);
        /* Country LiDAR layers switch product/renderer (hillshade/DTM/DSM/MNT/
         * MNS/MNH) from a 2D dropdown: the proxy must build the same mode's URL
         * as the 2D map, so the selection travels with the request. */
        if (def.modes || (def.kind === 'dynamic' && typeof def.resolve === 'function')) {
            var mode = opts.mode || modeOf(def, opts);
            if (mode) template += '&m=' + encodeURIComponent(mode);
        }
        return template;
    }

    /** Hostname of a definition's endpoint (probe/heal bookkeeping key). */
    function hostOf(def) {
        var url = (def && (def.url || (def.resolve && ''))) || '';
        var match = String(url).match(/^https?:\/\/([^/?#]+)/i);
        return match ? match[1].toLowerCase() : '';
    }

    /**
     * Should this layer go through the same-origin proxy?
     *   'always'   → yes (documented no-CORS hosts, reprojection, token)
     *   'never'    → no  (same-origin endpoints, known CORS-safe hosts)
     *   'auto'     → only when the definition needs reprojection, or when the
     *                runtime CORS probe / tile-error auto-heal put its host in
     *                opts.proxyHosts (see js/map3d-terrain.js).
     * opts.forceProxy === true|false overrides everything (tests, debugging).
     */
    function needsProxy(def, opts) {
        opts = opts || {};
        if (opts.forceProxy === true) return true;
        if (opts.forceProxy === false) return false;
        if (!def || def.proxy === 'never') return false;
        if (def.proxy === 'always') return true;
        if (def.reproject) return true;
        var host = hostOf(def);
        if (host && opts.proxyHosts && opts.proxyHosts.indexOf(host) !== -1) return true;
        if (opts.proxyHostsAll === true) return true;
        return false;
    }

    /** Tile templates for the 3D raster source of `def`. */
    function map3dTiles(def, opts) {
        opts = opts || {};
        var resolved = resolveDef(def, opts.modules) || def;
        var proxied = needsProxy(resolved, opts);
        var template;
        if (resolved.perTile && !proxied) {
            /* The module builds the URL from the tile bbox, which no static
             * template can express: MapLibre asks for
             * `dl3d://<layer id>/{z}/{x}/{y}` and js/map3d-terrain.js turns
             * each request into the module call (protocol handler below). */
            template = protocolTemplate(resolved);
        } else {
            template = proxied ? proxyTemplate(resolved, opts) : directTemplate(resolved, opts);
        }
        return template ? [template] : [];
    }

    /** MapLibre raster source object for a definition. */
    function rasterSource(def, opts) {
        opts = opts || {};
        var resolved = resolveDef(def, opts.modules) || def;
        var source = {
            type: 'raster',
            tiles: opts.tiles || map3dTiles(resolved, opts),
            tileSize: resolved.tileSize || 256,
            attribution: resolved.attribution || ''
        };
        if (resolved.scheme === 'tms') source.scheme = 'tms';
        /* MapLibre raster-source bounds are [west, south, east, north] in
         * DEGREES (its default is [-180, -85.051129, 180, 85.051129]) — the
         * registry stores Leaflet's [[south, west], [north, east]], so this is
         * a reorder, never a reprojection. */
        if (resolved.bounds && resolved.bounds.length === 2) {
            var sw = resolved.bounds[0], ne = resolved.bounds[1];
            source.bounds = [sw[1], sw[0], ne[1], ne[0]];
        }
        var minz = resolved.minZoom == null ? 0 : resolved.minZoom;
        var maxz = resolved.maxNativeZoom != null ? resolved.maxNativeZoom
            : (resolved.maxZoom == null ? 22 : resolved.maxZoom);
        source.minzoom = Math.max(0, minz);
        source.maxzoom = Math.min(22, maxz);
        if (resolved.maxZoom != null && resolved.maxNativeZoom != null && resolved.maxZoom > resolved.maxNativeZoom) {
            /* MapLibre keeps asking above maxzoom; harmless, the server answers
             * with the native level only when it supports it (2D behaviour is
             * identical: Leaflet over-zooms the same tiles). */
        }
        return source;
    }

    /* ── module-backed layers (LiDAR, …) ───────────────────────────────────── */
    function moduleMode(selectId) {
        try {
            if (typeof document === 'undefined' || !document.getElementById) return null;
            var el = document.getElementById(selectId);
            return el && el.value ? el.value : null;
        } catch (e) { return null; }
    }

    /**
     * Late binding for definitions whose URL builder, mode list and mode
     * default live in a country module (js/ahn-layer.js, js/hoydedata-layer.js,
     * js/geoportal-nmt-layer.js, js/ign-mdt-layer.js, …). Nothing is copied into
     * this file: the module stays the single owner of its URL.
     *
     * `def.builder` says HOW that module wants to be called:
     *   { fn: 'tileUrl',        kind: 'tile' } → fn(mode, z, x, y)
     *   { fn: 'tileUrl',        kind: 'bbox' } → fn(mode, bbox3857, size, crs)
     *   { fn: 'exportImageUrl', kind: 'bbox' } → fn(mode, bbox3857, size)
     * `kind: 'bbox'` builders cannot be expressed as a `{z}/{x}/{y}` template,
     * so the 3D view calls them per tile through the `dl3d://` protocol
     * registered in js/map3d-terrain.js (or, for no-CORS hosts, through the
     * tile proxy, which loads the very same module in Node).
     */
    function moduleBuilder(def) {
        if (!def || def.kind !== 'dynamic' || typeof def.resolve !== 'function') return null;
        var spec = def.builder;
        if (!spec || !spec.module || !spec.fn) return null;
        return { module: spec.module, fn: spec.fn, kind: spec.kind || 'tile' };
    }

    /** The module object backing a dynamic definition (browser or injected). */
    function moduleFor(name, modules) {
        if (modules && modules[name]) return modules[name];
        return (root && root[name]) || null;
    }

    /**
     * WMS layer name of a mode-switched definition (e.g. France LiDAR HD:
     * elevation / surface / height). Definitions without `modes` are returned
     * unchanged, so every other layer keeps its single `layer` string.
     */
    function layerOf(def, opts) {
        if (!def) return '';
        if (!def.modes) return def.layer || def.layers || '';
        var key = modeOf(def, opts) || Object.keys(def.modes)[0];
        var entry = def.modes[key] || {};
        return entry.layer || entry.layers || def.layer || '';
    }

    /**
     * Current mode key of a mode-switched layer: the live 2D dropdown wins in
     * the browser, the caller may override it (the tile proxy passes the mode
     * the client asked for), and the declaration's first mode is the last
     * resort.
     */
    function modeOf(def, opts) {
        opts = opts || {};
        if (opts.mode) return opts.mode;
        /* 1. the live 2D dropdown (browser); 2. the module's first mode. */
        var select = def && def.ui && def.ui.select;
        var live = select ? moduleMode(select) : null;
        if (live) return live;
        var b = moduleBuilder(def);
        var mod = moduleFor(b ? b.module : null, opts.modules);
        if (mod && typeof mod.modeKeys === 'function') {
            try { return mod.modeKeys()[0]; } catch (e) { /* ignore */ }
        }
        if (def && def.modes) {
            var keys = Object.keys(def.modes);
            if (keys.length) return keys[0];
        }
        return null;
    }

    /**
     * Exact upstream URL for ONE tile of a module-backed layer — the only way
     * to reach builders that need a bbox (WMS GetMap / ArcGIS exportImage).
     * Returns '' when the module is not loaded, so callers can report
     * "unsupported: module not loaded" instead of requesting a broken URL.
     */
    function tileUrlAt(def, z, x, y, opts) {
        opts = opts || {};
        var b = moduleBuilder(def);
        if (!b) return '';
        var mod = moduleFor(b.module, opts.modules);
        var fn = mod && mod[b.fn];
        if (typeof fn !== 'function') return '';
        var size = def.tileSize || 256;
        var crs = def.crs || 'EPSG:3857';
        var mode = modeOf(def, opts);
        try {
            if (b.kind === 'bbox') {
                return String(fn.call(mod, mode, tileBounds3857At(z, x, y), size, crs));
            }
            return String(fn.call(mod, mode, z, x, y));
        } catch (e) {
            return '';
        }
    }

    /** MapLibre custom-protocol template for a per-tile (bbox) builder. */
    function protocolTemplate(def) {
        return 'dl3d://' + def.id + '/{z}/{x}/{y}';
    }

    function resolveDef(def, modules) {
        if (!def) return null;
        if (def.kind !== 'dynamic' || !def.resolve) return def;
        var spec = moduleBuilder(def);
        if (!spec) return null;
        var mod = moduleFor(spec.module, modules);
        if (!mod) return null;                                        /* module not loaded (yet) */
        var fn = mod[spec.fn];
        if (typeof fn !== 'function') return null;
        var mode = modeOf(def, { modules: modules });
        var perTile = spec.kind === 'bbox';
        var template = null;
        if (!perTile) {
            try { template = fn(mode, '{z}', '{x}', '{y}'); } catch (e) { template = null; }
            if (!template) return null;
        }
        var modes = mod.MODES || {};
        var meta = (mode && modes[mode]) || {};
        return {
            id: def.id, group: def.group, z: def.z, kind: def.kind,
            title: def.title, attribution: def.attribution, opacity: def.opacity,
            url: template || def.url, template: template || '', mode: mode,
            perTile: perTile, builder: spec.kind || 'tile',
            bounds: def.bounds,
            minZoom: def.minZoom, maxZoom: def.maxZoom, maxNativeZoom: def.maxNativeZoom,
            tileSize: def.tileSize, cors: def.cors, proxy: def.proxy, notes: def.notes,
            modeLabel: meta.label || mode || ''
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  2D ADAPTERS — what js/map-app.js and js/historical-eu-maps.js use.
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * Options for L.tileLayer.wms() — the service half of the definition.
     *
     * NOTE ON `crs`: Leaflet expects a CRS *object* here (it reads `.code` and
     * calls `.project()`), and the 2D map is Web Mercator throughout, so the
     * call site passes `crs: L.CRS.EPSG3857` when it wants it explicitly. The
     * `crs` field of a definition is a different thing: the CRS the SERVER is
     * asked for by the 3D view / the proxy (where it may be EPSG:2180).
     *
     * `extra` carries the view-specific wiring (pane, zoom window, bounds,
     * crossOrigin, …) — exactly the parts that legitimately differ per view.
     */
    function wms2dOptions(id, extra) {
        var def = get(id);
        if (!def) throw new Error('[layer-registry] unknown layer: ' + id);
        var opts = {
            layers: def.layer || def.layers,
            format: def.format || 'image/png',
            transparent: def.transparent !== false,
            version: def.version || '1.3.0',
            opacity: def.opacity == null ? 1 : def.opacity,
            attribution: def.attribution || ''
        };
        Object.keys(def.params || {}).forEach(function (key) { opts[key] = def.params[key]; });
        Object.keys(extra || {}).forEach(function (key) { opts[key] = extra[key]; });
        return opts;
    }

    /** Options for L.tileLayer() — XYZ / ArcGIS-tiled definitions. */
    function tile2dOptions(id, extra) {
        var def = get(id);
        if (!def) throw new Error('[layer-registry] unknown layer: ' + id);
        var opts = {
            tileSize: def.tileSize || 256,
            opacity: def.opacity == null ? 1 : def.opacity,
            attribution: def.attribution || ''
        };
        if (def.minNativeZoom != null) opts.minNativeZoom = def.minNativeZoom;
        if (def.maxNativeZoom != null) opts.maxNativeZoom = def.maxNativeZoom;
        Object.keys(extra || {}).forEach(function (key) { opts[key] = extra[key]; });
        return opts;
    }

    /** Endpoint of a definition; `altKey` selects a mirror (def.alt[key]). */
    function url2d(id, altKey) {
        var def = get(id);
        if (!def) throw new Error('[layer-registry] unknown layer: ' + id);
        if (altKey) {
            if (!def.alt || !def.alt[altKey]) {
                throw new Error('[layer-registry] ' + id + ' has no alt source "' + altKey + '"');
            }
            return def.alt[altKey];
        }
        return def.url;
    }

    /** The service-level fields of a definition (for call sites that need one). */
    function service(id) {
        var def = get(id);
        if (!def) throw new Error('[layer-registry] unknown layer: ' + id);
        return {
            url: def.url,
            layer: def.layer || def.layers || '',
            format: def.format || 'image/png',
            transparent: def.transparent !== false,
            version: def.version || '1.3.0',
            crs: def.crs || 'EPSG:3857',
            opacity: def.opacity == null ? 1 : def.opacity,
            attribution: def.attribution || '',
            bounds: def.bounds || null,
            time: def.time ? def.time.value : null
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  STATE — where a layer is ON and how opaque it is, read from the 2D UI
     *  (the only place layer state lives). Used by the 3D view so the two
     *  views can never disagree about what is active.
     * ═══════════════════════════════════════════════════════════════════════ */
    function doc() {
        try { return (root && root.document) || (typeof document !== 'undefined' ? document : null); }
        catch (e) { return null; }
    }

    function uiElement(def, kind) {
        var d = doc();
        if (!d) return null;
        var ui = def.ui || {};
        try {
            if (kind === 'toggle') {
                if (ui.toggle) return d.getElementById(ui.toggle);
                if (ui.selector) return d.querySelector(ui.selector);
            }
            if (kind === 'slider') {
                if (ui.slider) return d.getElementById(ui.slider);
                if (ui.sliderSelector) return d.querySelector(ui.sliderSelector);
            }
            if (kind === 'pct') {
                if (ui.pct) return d.getElementById(ui.pct);
                if (ui.pctSelector) return d.querySelector(ui.pctSelector);
            }
            if (kind === 'select') {
                if (ui.select) return d.getElementById(ui.select);
                if (ui.selectSelector) return d.querySelector(ui.selectSelector);
            }
        } catch (e) { return null; }
        return null;
    }

    /** Is the layer currently switched on in the 2D panel? */
    function is2dActive(def) {
        /* A mirrored (stub) layer only exists in this list while the live 2D
         * map is showing it — the mirror is the answer. */
        if (def.stub) {
            var mirror = root && root.DetectLabMirror;
            if (mirror && typeof mirror.layerByKey === 'function') return !!mirror.layerByKey(def.id);
            return false;
        }
        var el = uiElement(def, 'toggle');
        if (el) return !!el.checked;
        /* Layers without a switch of their own follow a select (satellite
         * periods) or the parent group (Josephine's LayerGroup reference). */
        /* Copernicus VHR periods share one slider, so they are identified by
         * the live Leaflet layer the 2D app keeps in window._satHistPeriods. */
        if (def.id.indexOf('sat.vhr-') === 0) {
            var periods = root._satHistPeriods;
            var key = def.id.replace('sat.vhr-', '');
            var livePeriod = periods && periods[key];
            var liveMap = root._dlMap;
            if (livePeriod && liveMap && typeof liveMap.hasLayer === 'function') {
                return liveMap.hasLayer(livePeriod);
            }
            return String(root._satPeriod || '') === key;
        }
        /* Layers driven by a runtime Leaflet layer object (Josephine's
         * viewport-switched LayerGroup, CORONA deck, …) are asked of the live
         * 2D map instead of a checkbox. */
        var ui = def.ui || {};
        if (ui.var2d) {
            var live = root[ui.var2d];
            var map = root._dlMap;
            if (live && map && typeof map.hasLayer === 'function') return map.hasLayer(live);
        }
        return false;
    }

    /** Current opacity of the layer, read from the 2D slider when present. */
    function opacityOf(def) {
        var slider = uiElement(def, 'slider');
        if (slider && slider.value !== '' && slider.value != null) {
            var v = Number(slider.value);
            if (!isNaN(v)) return Math.max(0, Math.min(1, v / 100));
        }
        var live = def.ui && def.ui.var2d ? root[def.ui.var2d] : null;
        if (live && typeof live.getOpacity === 'function') {
            try { return live.getOpacity(); } catch (e) { /* fall through */ }
        }
        return def.opacity == null ? 1 : def.opacity;
    }

    /** Current value of a time dimension (2D control wins over the default). */
    function timeOf(def) {
        if (!def.time) return null;
        var sel = uiElement(def, 'select');
        if (sel && sel.value) return sel.value;
        return def.time.value;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  DIAGNOSTICS — feed the 3D status panel, the tests and MAP_3D_TERRAIN.md
     * ═══════════════════════════════════════════════════════════════════════ */
    function layerStatus(def, opts) {
        opts = opts || {};
        var resolved = resolveDef(def, opts.modules);
        var status = {
            id: def.id,
            group: def.group,
            title: def.title && (def.title.en || def.title.ro) || def.id,
            kind: def.kind,
            url: (resolved && resolved.url) || def.url,
            layer: layerOf(def, opts),
            mode: def.modes ? modeOf(def, opts) : (resolved && resolved.mode) || undefined,
            modeKeys: def.modes ? Object.keys(def.modes) : undefined,
            crs: def.crs || 'EPSG:3857',
            cors: def.cors || 'unknown',
            proxy: def.proxy || 'auto',
            reproject: !!def.reproject,
            drape: true,
            active2d: is2dActive(def),
            opacity: opacityOf(def),
            zoom: [def.minZoom == null ? 0 : def.minZoom, def.maxZoom == null ? 20 : def.maxZoom],
            notes: def.notes || ''
        };
        if (def.runtimeOverlays) {
            status.kind = 'dynamic';
            status.notes = def.notes;
        }
        if (!resolved) {
            status.drape = false;
            var modName = def.builder && def.builder.module;
            status.reason = modName
                ? 'module ' + modName + ' not loaded — nothing to drape yet'
                : 'module not loaded (country LiDAR module) — nothing to drape yet';
        } else if (resolved.perTile) {
            /* bbox-driven builder: draped through the dl3d:// protocol (or the
             * proxy when the host has no CORS) — never silently skipped. */
            status.perTile = true;
            status.drape = true;
            status.reason = 'per-tile URL from ' + (def.builder && def.builder.fn ? def.builder.fn : 'tileUrl') +
                '() — draped tile by tile (protocol, or the proxy where CORS is missing)';
        }
        return status;
    }

    function diagnostics(opts) {
        opts = opts || {};
        var out = ordered().map(function (def) { return layerStatus(def, opts); });
        var cfg = config();
        return {
            version: VERSION,
            terrain: terrainSource(),
            exaggeration: cfg.terrain.exaggeration,
            hillshade: cfg.hillshade,
            proxy: cfg.proxy,
            layers: out,
            totals: {
                layers: out.length,
                draped: out.filter(function (s) { return s.drape; }).length,
                active2d: out.filter(function (s) { return s.active2d; }).length,
                viaProxy: out.filter(function (s) { return s.proxy === 'always' || s.proxy === 'auto' && (s.cors === 'no' || s.cors === 'unknown'); }).length,
                reprojected: out.filter(function (s) { return s.reproject; }).length
            }
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  DRIFT GUARD — compares the registry with the live 2D Leaflet layers.
     *  Runs from the console / tests: it never mutates anything.
     * ═══════════════════════════════════════════════════════════════════════ */
    function verify2d() {
        var problems = [];
        ordered().forEach(function (def) {
            if (def.kind === 'dynamic' || !def.ui || !def.ui.var2d || def.ui.selector) return;
            var live = root[def.ui.var2d];
            if (!live || !live.options) return;                       /* not created yet */
            var o = live.options;
            if (def.kind === 'wms') {
                var liveLayers = o.layers;
                if (liveLayers && def.layer && liveLayers !== def.layer) {
                    problems.push(def.id + ': 2D LAYERS=' + liveLayers + ' vs registry ' + def.layer);
                }
                if (o.version && def.version && String(o.version) !== String(def.version)) {
                    problems.push(def.id + ': 2D version=' + o.version + ' vs registry ' + def.version);
                }
                if (o.format && def.format && o.format !== def.format) {
                    problems.push(def.id + ': 2D format=' + o.format + ' vs registry ' + def.format);
                }
            }
            var liveUrl = live._url || o.url;
            if (liveUrl && def.url && liveUrl !== def.url) {
                /* Leaflet normalises ?service=… order, so compare hosts+paths. */
                var a = String(liveUrl).split('?')[0], b = String(def.url).split('?')[0];
                if (a !== b) problems.push(def.id + ': 2D url=' + a + ' vs registry ' + b);
            }
        });
        return { ok: problems.length === 0, problems: problems };
    }

    var API = {
        VERSION: VERSION,
        GROUPS: GROUPS,
        TERRAIN_PROVIDERS: TERRAIN_PROVIDERS,
        DEFAULTS: MAP3D_DEFAULT,
        config: config,
        terrainSource: terrainSource,
        get: get,
        list: list,
        all: list,
        byGroup: byGroup,
        ordered: ordered,
        /* mirrored stub definitions + host routing policy */
        mirrorStubs: mirrorStubs,
        hostPolicy: hostPolicy,
        matchDef: matchDef,
        cenagisCatalog: cenagisCatalog,
        cenagis: { url: CENAGIS.url, version: CENAGIS.version, format: CENAGIS.format, transparent: CENAGIS.transparent, opacity: CENAGIS.opacity },
        resolve: resolveDef,
        register: function (def) {
            if (!def || !def.id) throw new Error('[layer-registry] register() needs an id');
            if (BY_ID[def.id]) throw new Error('[layer-registry] duplicate id: ' + def.id);
            if (!GROUPS[def.group]) throw new Error('[layer-registry] unknown group: ' + def.group);
            LAYERS.push(def);
            BY_ID[def.id] = def;
            return def;
        },
        /* builders */
        wmsTemplate: wmsTemplate,
        wmtsTemplate: wmtsTemplate,
        directTemplate: directTemplate,
        proxyTemplate: proxyTemplate,
        map3dTiles: map3dTiles,
        rasterSource: rasterSource,
        boundsTo3857: boundsTo3857,
        lngLatTo3857: lngLatTo3857,
        tileBounds3857At: tileBounds3857At,
        /* per-tile module builders (bbox-driven WMS / ArcGIS exportImage) */
        tileUrlAt: tileUrlAt,
        modeOf: modeOf,
        layerOf: layerOf,
        modes: function (id) {
            var def = get(id);
            return (def && def.modes) || null;
        },
        /* 2D adapters */
        wms2dOptions: wms2dOptions,
        tile2dOptions: tile2dOptions,
        url2d: url2d,
        service: service,
        /* state */
        is2dActive: is2dActive,
        opacityOf: opacityOf,
        timeOf: timeOf,
        /* reporting */
        layerStatus: layerStatus,
        diagnostics: diagnostics,
        verify2d: verify2d
    };
    return API;
}));
