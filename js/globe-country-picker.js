/* ══════════════════════════════════════════════════════════════
   DetectLab — 3D Globe Country Gate (canvas edition)
   ──────────────────────────────────────────────────────────────
   The very first thing an authenticated visitor sees in the map
   card: an orthographic globe rendered on a plain 2D <canvas> with
   d3-geo. The sphere is textured with the SAME Esri World Imagery tiles
   the working map's MapLibre globe draws (js/globe-base-layer.js), so
   the basemap before a selection and the basemap after it are one and
   the same picture: the Web Mercator tiles are sampled per pixel onto
   the sphere, flat-lit, on the same background colour, with no extra
   shading or atmosphere. Every European country is tinted translucent
   grey-violet with a black border, hovering flips it to translucent
   neon-green, and clicking flies to the country before handing off to
   the Leaflet-controlled working map (js/map-app.js).

   The gate deliberately stays canvas-based instead of using MapLibre
   for hit-testing: WebGL context loss/driver blacklists and unreliable
   feature-state picking previously made country selection fragile. The
   gate picture is drawn by us, and picking is pure geometry
   (projection.invert + d3.geoContains) so hover/click can't miss. The
   working map's separate MapLibre globe has an inline local style and a
   raster fallback if WebGL cannot start.

   Everything needed to draw the globe ships with the site:
     js/d3.min.js, js/topojson-client.min.js  (lazy-loaded, local)
     data/countries-50m.json                  (world-atlas TopoJSON)
     images/globe/earth-blue-marble.jpg/.png  (fallback texture only:
       used when the imagery tile service cannot be reached at all)
   Optionally, higher-detail European coastlines are streamed in the
   background from the project's Natural Earth 10m shapefile on
   Supabase; the gate is fully usable before (and without) it.
   See GLOBE_COUNTRY_GATE.md.
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
    'use strict';
    if (!window || !document) return;

    /* ── Assets: local first, public mirror as fallback ── */
    var D3_JS = 'js/d3.min.js?v=7.9.0';
    var TOPOJSON_JS = 'js/topojson-client.min.js?v=3.1.0';
    var SHAPEFILE_JS = 'js/shapefile.js?v=0.6.6';
    var ATLAS_LOCAL = 'data/countries-50m.json?v=20261008';
    var ATLAS_REMOTE = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
    var TEXTURE_LOCAL = 'images/globe/earth-blue-marble.jpg?v=20261008';
    var TEXTURE_REMOTE = 'https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-blue-marble.jpg';
    var TOPOLOGY_LOCAL = 'images/globe/earth-topology.png?v=20261008';
    var TOPOLOGY_REMOTE = 'https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-topology.png';
    var SHP_URL = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/ne_10m_admin_0_countries.shp';

    var STORAGE_KEY = 'detectlab_selected_country_v1';
    var FETCH_TIMEOUT_MS = 20000;

    /* ── Basemap imagery ────────────────────────────────────────────────
       The sphere shows the same Esri World Imagery the working map's
       MapLibre globe draws (WORLD_IMAGERY_URL / BACKGROUND in
       js/globe-base-layer.js), so the picture does not change when a
       country is picked. The tiles are Web Mercator: for every canvas
       pixel the inverse orthographic mapping gives lon/lat, which is
       converted to Mercator and read from the tile covering it (or from
       the nearest loaded ancestor while that tile is still downloading —
       the same progressive refinement MapLibre does). Like MapLibre the
       gate draws the imagery as it is: no hillshade, no limb darkening,
       no atmosphere halo, and the pole caps are filled by extending the
       outermost Mercator rows. */
    var IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
    var IMAGERY_BACKGROUND = '#030916';     // globe-base-layer.js BACKGROUND
    var IMAGERY_ATTRIBUTION = 'Imagery \u00a9 Esri \u2014 World Imagery';
    var FALLBACK_ATTRIBUTION = 'Imagery: NASA Blue Marble';   // shown only when the tile service is unreachable
    var TILE_PX = 256;
    var IMAGERY_PIN_Z = 2;         // z0–z2 load up front and are never evicted: a fallback for every pixel
    var IMAGERY_MAX_Z = 10;        // the gate never shows more than a country-sized view
    var IMAGERY_MAX_TILES = 128;   // asked for per frame; the tile zoom steps down until the view fits
    var IMAGERY_CACHE_MAX = 400;   // tile images kept (least recently drawn go first)
    var IMAGERY_DATA_MAX = 160;    // decoded 256×256 pixel buffers kept (≤ 40 MB)
    var IMAGERY_INFLIGHT_MAX = 12;
    var IMAGERY_RETRY_MS = 15000;  // a failed tile is asked for again after this
    var MERC_MAX_SIN = Math.sin(85.05112878 * Math.PI / 180);

    /* ── Locked country view ─────────────────────────────────────────────
       Once a country is picked the working map is pinned to it: the
       maxBounds box keeps every drag inside the country (maxBoundsViscosity
       1 snaps a gesture straight back) and the zoom floor is the fit zoom,
       so the user cannot wander off the chosen country. Zooming out to that
       floor is the signal for the “Exit view” button built by
       js/country-dock.js; the only other way out is picking another country
       from the dock glued to the search bar (or from this globe). The
       permanent 3D globe basemap is never replaced by a selection — see
       COUNTRY_SELECTION_DOCK.md. */
    var LOCK_PAD = 0.15;         // degrees of slack around the country bbox
    // Leaflet snaps the zoom to whole levels by default, so the floor has to be
    // a *reachable* step: one level below the fitted view. That is the “zoomed
    // out at maximum” state the dock's Exit view button watches for, and it is
    // also the only legal way out of a locked view (see js/country-dock.js).
    var LOCK_ZOOM_SLACK = 1;
    var FIT_MAX_ZOOM = 11;       // micro-states: never dive into a single street

    var CONTROL_IDS = ['mapSearchWrap', 'transpTab', 'transpPanel', 'verticalOpacityControl', 'verticalSatPeriodControl', 'mapHelpBtn'];

    // Every European (+ immediate-neighbour) ISO-3166-1 alpha-2 code the
    // picker will accept. Kept identical to the retired js/country-selector.js
    // list so coverage doesn't silently shrink. `alt` entries also cover the
    // exact spellings used by the world-atlas 50m dataset ("Bosnia and Herz.",
    // "Macedonia", "Vatican"…) so every country resolves to an ISO code.
    var NAMES = {
        AL: { en: 'Albania', ro: 'Albania' },
        AD: { en: 'Andorra', ro: 'Andorra' },
        AM: { en: 'Armenia', ro: 'Armenia' },
        AT: { en: 'Austria', ro: 'Austria' },
        AZ: { en: 'Azerbaijan', ro: 'Azerbaidjan' },
        BY: { en: 'Belarus', ro: 'Belarus' },
        BE: { en: 'Belgium', ro: 'Belgia' },
        BA: { en: 'Bosnia and Herzegovina', ro: 'Bosnia și Herțegovina', alt: ['bosnia and herz', 'bosnia & herzegovina'] },
        BG: { en: 'Bulgaria', ro: 'Bulgaria' },
        HR: { en: 'Croatia', ro: 'Croația' },
        CY: { en: 'Cyprus', ro: 'Cipru' },
        CZ: { en: 'Czechia', ro: 'Cehia', alt: ['czech republic'] },
        DK: { en: 'Denmark', ro: 'Danemarca' },
        EE: { en: 'Estonia', ro: 'Estonia' },
        FI: { en: 'Finland', ro: 'Finlanda' },
        FR: { en: 'France', ro: 'Franța' },
        GE: { en: 'Georgia', ro: 'Georgia' },
        DE: { en: 'Germany', ro: 'Germania' },
        GR: { en: 'Greece', ro: 'Grecia', alt: ['hellenic republic'] },
        HU: { en: 'Hungary', ro: 'Ungaria' },
        IS: { en: 'Iceland', ro: 'Islanda' },
        IE: { en: 'Ireland', ro: 'Irlanda' },
        IT: { en: 'Italy', ro: 'Italia' },
        XK: { en: 'Kosovo', ro: 'Kosovo' },
        LV: { en: 'Latvia', ro: 'Letonia' },
        LI: { en: 'Liechtenstein', ro: 'Liechtenstein' },
        LT: { en: 'Lithuania', ro: 'Lituania' },
        LU: { en: 'Luxembourg', ro: 'Luxemburg' },
        MT: { en: 'Malta', ro: 'Malta' },
        MD: { en: 'Moldova', ro: 'Moldova', alt: ['republic of moldova'] },
        MC: { en: 'Monaco', ro: 'Monaco' },
        ME: { en: 'Montenegro', ro: 'Muntenegru' },
        NL: { en: 'Netherlands', ro: 'Țările de Jos', alt: ['holland'] },
        MK: { en: 'North Macedonia', ro: 'Macedonia de Nord', alt: ['macedonia'] },
        NO: { en: 'Norway', ro: 'Norvegia' },
        PL: { en: 'Poland', ro: 'Polonia' },
        PT: { en: 'Portugal', ro: 'Portugalia' },
        RO: { en: 'Romania', ro: 'România' },
        RU: { en: 'Russia', ro: 'Rusia', alt: ['russian federation'] },
        SM: { en: 'San Marino', ro: 'San Marino' },
        RS: { en: 'Serbia', ro: 'Serbia', alt: ['republic of serbia'] },
        SK: { en: 'Slovakia', ro: 'Slovacia' },
        SI: { en: 'Slovenia', ro: 'Slovenia' },
        ES: { en: 'Spain', ro: 'Spania' },
        SE: { en: 'Sweden', ro: 'Suedia' },
        CH: { en: 'Switzerland', ro: 'Elveția' },
        TR: { en: 'Turkey', ro: 'Turcia', alt: ['turkiye', 'türkiye', 'republic of turkiye'] },
        UA: { en: 'Ukraine', ro: 'Ucraina' },
        GB: { en: 'United Kingdom', ro: 'Regatul Unit', alt: ['uk', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'] },
        VA: { en: 'Vatican City', ro: 'Vatican', alt: ['vatican', 'holy see'] }
    };

    // Rough [lng, lat, zoom] fallback used only when every geometry source
    // failed to load — keeps the picker usable (if geometrically crude)
    // even with zero access to a polygon dataset.
    var APPROX_CENTER = {
        AL: [20.1, 41.2, 7.3], AD: [1.6, 42.55, 9.5], AM: [45.0, 40.3, 7], AT: [14.2, 47.6, 6.6],
        AZ: [47.6, 40.3, 6.6], BY: [27.9, 53.5, 6.2], BE: [4.6, 50.6, 7.4], BA: [17.8, 44.1, 7],
        BG: [25.3, 42.7, 6.8], HR: [16.4, 45.3, 6.8], CY: [33.3, 35.1, 8.1], CZ: [15.4, 49.8, 7],
        DK: [10.0, 56.1, 6.4], EE: [25.6, 58.7, 7], FI: [26.0, 64.5, 4.6], FR: [2.4, 46.6, 5.2],
        GE: [43.5, 42.2, 6.8], DE: [10.3, 51.1, 5.6], GR: [22.9, 39.0, 6], HU: [19.5, 47.2, 6.8],
        IS: [-19.0, 64.9, 5.6], IE: [-8.0, 53.3, 6.2], IT: [12.6, 42.5, 5.3], XK: [20.9, 42.6, 8.2],
        LV: [24.6, 56.9, 6.7], LI: [9.55, 47.17, 10.3], LT: [23.9, 55.2, 6.8], LU: [6.13, 49.8, 9.3],
        MT: [14.4, 35.9, 10], MD: [28.4, 47.4, 7.2], MC: [7.42, 43.73, 12.5], ME: [19.3, 42.7, 8.1],
        NL: [5.3, 52.2, 6.6], MK: [21.7, 41.6, 7.6], NO: [11.0, 64.5, 4.2], PL: [19.1, 52.1, 5.9],
        PT: [-8.2, 39.5, 6], RO: [24.9, 45.9, 6.1], RU: [60.0, 61.5, 2.6], SM: [12.45, 43.94, 11.5],
        RS: [20.9, 44.1, 7], SK: [19.5, 48.7, 7.3], SI: [14.8, 46.1, 7.9], ES: [-3.7, 40.3, 5.2],
        SE: [17.6, 62.5, 4.1], CH: [8.2, 46.8, 7.2], TR: [35.2, 39.0, 5.3], UA: [31.2, 48.4, 5.3],
        GB: [-2.9, 54.2, 5.1], VA: [12.45, 41.9, 13]
    };

    var EUROPE_ISO = {};
    Object.keys(NAMES).forEach(function (iso) { EUROPE_ISO[iso] = true; });

    var NAME_TO_ISO = {};
    Object.keys(NAMES).forEach(function (iso) {
        var entry = NAMES[iso];
        [entry.en, entry.ro].concat(entry.alt || []).forEach(function (n) {
            if (!n) return;
            NAME_TO_ISO[normalizeName(n)] = iso;
        });
    });

    function normalizeName(s) {
        s = String(s || '').toLowerCase().trim();
        try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
        return s.replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function currentLang() {
        try {
            if (typeof window._currentLang === 'function') return window._currentLang();
        } catch (e) {}
        return (document.documentElement && document.documentElement.lang) || 'en';
    }

    function displayName(iso, datasetName) {
        var ov = NAMES[iso];
        var lang = currentLang();
        if (ov) {
            if (lang === 'ro' && ov.ro) return ov.ro;
            if (ov.en) return ov.en;
        }
        return datasetName || iso;
    }

    /* ── Fetch / script helpers ── */
    function fetchWithTimeout(url, timeoutMs) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = controller && timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
        return fetch(url, { signal: controller ? controller.signal : undefined }).then(function (res) {
            if (timer) clearTimeout(timer);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
            return res;
        }, function (err) {
            if (timer) clearTimeout(timer);
            throw err;
        });
    }

    var scriptPromises = {};
    function loadScript(src) {
        if (scriptPromises[src]) return scriptPromises[src];
        scriptPromises[src] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { delete scriptPromises[src]; reject(new Error('Failed to load ' + src)); };
            document.head.appendChild(s);
        });
        return scriptPromises[src];
    }

    function loadImage(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('Image failed: ' + src)); };
            img.src = src;
        });
    }

    /* ── Persistence ── */
    function persistSelection(iso, name, bbox) {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ iso: iso, name: name, bbox: bbox, ts: Date.now() }));
        } catch (e) {}
    }
    function readStoredSelection() {
        try {
            var raw = window.localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (obj && obj.iso && EUROPE_ISO[obj.iso] && Array.isArray(obj.bbox) && obj.bbox.length === 4) return obj;
        } catch (e) {}
        return null;
    }
    function clearStoredSelection() {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    }

    /* ── Leaflet handoff (unchanged contract with js/map-app.js) ── */
    function setMapControlsHidden(hidden) {
        CONTROL_IDS.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.toggle('auth-hidden', !!hidden);
        });
    }

    function activeMap() { return state.leafletMap || window._dlMap || null; }

    /* Remembers the map's own zoom limits the first time a country is locked,
       so switching country to country never ratchets minZoom upwards. */
    function rememberBaseZoom(map) {
        if (state.baseMinZoom != null || !map) return;
        var opts = map.options || {};
        state.baseMinZoom = (typeof opts.minZoom === 'number') ? opts.minZoom : 2;
        state.baseMaxZoom = (typeof opts.maxZoom === 'number') ? opts.maxZoom : 20;
    }

    // The zoom the country view opens at: the bbox fitted to the viewport,
    // capped so micro-states (Monaco, Vatican…) don't fall into one street.
    function countryFitZoom(map, padded) {
        var fit = FIT_MAX_ZOOM;
        try {
            var z = map.getBoundsZoom(padded, false);
            if (typeof z === 'number' && isFinite(z)) fit = Math.min(FIT_MAX_ZOOM, z);
        } catch (e) { /* keep the cap */ }
        return Math.max(state.baseMinZoom, Math.min(state.baseMaxZoom, fit));
    }

    /* Lock the working map to one country: pan pinned to the (slightly
       padded) country box, zoom floor at the fit zoom. The permanent 3D globe
       base is never replaced here — a selection only moves the camera and
       locks it. */
    function restrictLeafletToCountry(map, bbox) {
        if (!map || !window.L) return;
        try {
            rememberBaseZoom(map);
            var sw = window.L.latLng(bbox[1], bbox[0]);
            var ne = window.L.latLng(bbox[3], bbox[2]);
            var bounds = window.L.latLngBounds(sw, ne);
            var padded = bounds.pad(LOCK_PAD);
            var fitZoom = countryFitZoom(map, padded);
            map.setMaxBounds(null);
            map.options.maxBoundsViscosity = 1;
            map.setMaxBounds(padded);
            map.setMinZoom(Math.max(state.baseMinZoom, fitZoom - LOCK_ZOOM_SLACK));
            if (typeof map.setMaxZoom === 'function') map.setMaxZoom(state.baseMaxZoom);
            map.fitBounds(bounds, { padding: [24, 24], maxZoom: fitZoom, animate: true });
            state.locked = true;
            state.fitZoom = fitZoom;
            // The bounds of the selected country stay visible on the map for
            // the whole locked view (outline once geometry is loaded).
            showCountryBoundsLayer(map, window._detectlabSelectedCountry, bbox);
            if (document.documentElement) document.documentElement.classList.add('country-view-locked');
            fireLockChange(true);
        } catch (e) {
            console.warn('[DetectLab] Globe gate: could not restrict the map to the selected country', e);
        }
    }

    /* Release the lock: free panning and the map's original zoom range.
       Used by the “Exit view” button (js/country-dock.js) and by reset(). */
    function unlockCountryView() {
        var map = activeMap();
        state.locked = false;
        state.fitZoom = null;
        if (document.documentElement) document.documentElement.classList.remove('country-view-locked');
        if (map) {
            try {
                map.setMaxBounds(null);
                if (map.options) map.options.maxBoundsViscosity = 0;
                if (state.baseMinZoom != null && typeof map.setMinZoom === 'function') map.setMinZoom(state.baseMinZoom);
                if (state.baseMaxZoom != null && typeof map.setMaxZoom === 'function') map.setMaxZoom(state.baseMaxZoom);
            } catch (e) {
                console.warn('[DetectLab] Globe gate: could not release the country lock', e);
            }
        }
        // Layer coverage filtering belongs to the locked view — drop it so the
        // whole catalogue is selectable again once the user roams freely.
        if (typeof window.unfilterLayersForCountry === 'function') {
            try { window.unfilterLayersForCountry(); } catch (e) {}
        }
        removeCountryBoundsLayer();
        fireLockChange(false);
    }

    /* ── Selected-country bounds on the working map ────────────────────────
       A selection keeps the country bounds visible on the Leaflet map: the
       country outline when the gate's geometry is loaded, otherwise the
       selection bbox. Drawn non-interactive in its own pane above every data
       pane (LIDAR 610, historical maps ≤ 652), removed when the lock is
       released (“Exit view”, reset) and replaced on every new selection.
       With the 3D globe basemap live, the outline and its highlight are
       projected with the globe camera, so they stay on the imagery when zoomed
       out and while the globe moves (see DetectLabGlobeBase.createProjectedFeature).
       Without a live globe they are placed by Leaflet as before. */
    var BOUNDS_PANE = 'pane_country_bounds';
    var BOUNDS_PANE_Z = 688;   // above the data panes, under tracks (690)/measure (700)

    function ensureBoundsPane(map) {
        try {
            if (!map || typeof map.getPane !== 'function' || typeof map.createPane !== 'function') return null;
            var pane = map.getPane(BOUNDS_PANE);
            if (!pane) {
                pane = map.createPane(BOUNDS_PANE);
                if (pane && pane.style) pane.style.zIndex = BOUNDS_PANE_Z;
            }
            return BOUNDS_PANE;
        } catch (e) { return null; }
    }

    function removeCountryBoundsLayer() {
        var layer = state.boundsLayer;
        state.boundsLayer = null;
        if (!layer) return;
        var map = activeMap();
        if (map && typeof map.removeLayer === 'function') {
            try { map.removeLayer(layer); } catch (e) {}
        }
    }

    function showCountryBoundsLayer(map, iso, bbox) {
        if (!map || !window.L || !Array.isArray(bbox) || bbox.length !== 4) return;
        removeCountryBoundsLayer();
        // Leaflet passes these options straight to every vector it builds
        // (bundled 1.9.4: geometryToLayer forwards the GeoJSON options), so
        // pane/interactive apply to the outline itself.
        var styleOpts = {
            color: '#39ff14',
            weight: 2.5,
            opacity: 0.9,
            fillColor: '#39ff14',
            fillOpacity: 0.05,
            interactive: false,
            bubblingMouseEvents: false
        };
        var paneName = ensureBoundsPane(map);
        if (paneName) styleOpts.pane = paneName;
        var layer = null;
        var kind = 'bbox rectangle';   // what the layer draws (read by the status line)
        var entry = (iso && G.byIso) ? G.byIso[iso] : null;
        // With the live 3D globe the outline is projected with the globe camera
        // (DetectLabGlobeBase.createProjectedFeature), so it stays on the
        // imagery at every zoom and view. Without a globe on this map, Leaflet's
        // own Web Mercator placement is used, as before.
        // map-app publishes the Leaflet raster fallback under the same name when
        // WebGL is unavailable, so only a real globe adapter counts here.
        var globe = window._detectlabGlobeBaseLayer;
        var projector = window.DetectLabGlobeBase;
        if (globe && globe._map === map && typeof globe.getMaplibreMap === 'function' && projector) {
            var globeOpts = { globeLayer: globe };
            for (var key in styleOpts) {
                if (Object.prototype.hasOwnProperty.call(styleOpts, key)) globeOpts[key] = styleOpts[key];
            }
            if (entry && entry.feature) {
                try { layer = projector.createProjectedFeature(entry.feature, globeOpts); } catch (e) { layer = null; }
                if (layer) kind = 'country outline';
            }
            if (!layer) {
                try {
                    layer = projector.createProjectedPolygon([
                        [bbox[1], bbox[0]], [bbox[1], bbox[2]], [bbox[3], bbox[2]], [bbox[3], bbox[0]]
                    ], globeOpts);
                } catch (e) { layer = null; }
            }
        }
        if (!layer && entry && entry.feature && typeof window.L.geoJSON === 'function') {
            try { layer = window.L.geoJSON(entry.feature, styleOpts); kind = 'country outline'; } catch (e) { layer = null; }
        }
        if (!layer && typeof window.L.rectangle === 'function') {
            try {
                layer = window.L.rectangle([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], styleOpts);
            } catch (e) { layer = null; }
        }
        if (!layer || typeof map.addLayer !== 'function') return;
        // Paths have no eachLayer, so the status line cannot tell the outline
        // from the rectangle by shape; the kind is recorded here instead.
        layer._detectlabBoundsKind = kind;
        try {
            map.addLayer(layer);
            state.boundsLayer = layer;
        } catch (e) {}
    }

    // Redraw once the atlas (or the 10m shapefile refinement) is ready: a
    // selection restored from localStorage starts with the plain bbox rectangle
    // and upgrades to the real country outline as soon as geometry exists.
    function refreshCountryBoundsLayer() {
        if (!state.locked || !state.boundsLayer) return;
        var map = activeMap();
        if (!map) return;
        showCountryBoundsLayer(map, window._detectlabSelectedCountry, window._detectlabCountryBounds);
    }

    function fireLockChange(locked) {
        var detail = {
            locked: !!locked,
            iso: window._detectlabSelectedCountry || null,
            bbox: window._detectlabCountryBounds || null,
            fitZoom: state.fitZoom
        };
        try {
            document.dispatchEvent(new CustomEvent('detectlab:country-lockchange', { detail: detail }));
        } catch (e) {
            try {
                var evt = document.createEvent('CustomEvent');
                evt.initCustomEvent('detectlab:country-lockchange', true, true, detail);
                document.dispatchEvent(evt);
            } catch (e2) {}
        }
    }

    function callFilterLayersWithRetry(iso, attemptsLeft) {
        if (typeof window.filterLayersForCountry === 'function') {
            try { window.filterLayersForCountry(iso); } catch (e) {}
            return;
        }
        if (attemptsLeft <= 0) return;
        window.setTimeout(function () { callFilterLayersWithRetry(iso, attemptsLeft - 1); }, 60);
    }

    function hasSelection() {
        return !!window._detectlabSelectedCountry;
    }

    function applySelection(iso, name, bbox) {
        window._detectlabSelectedCountry = iso;
        window._detectlabSelectedCountryName = name;
        window._detectlabCountryBounds = bbox;
        window._detectlabCountryLayer = {
            eachLayer: function (cb) {
                if (!window.L) return;
                var sw = window.L.latLng(bbox[1], bbox[0]);
                var ne = window.L.latLng(bbox[3], bbox[2]);
                cb({ feature: { properties: { ISO_A2: iso } }, getBounds: function () { return window.L.latLngBounds(sw, ne); } });
            }
        };
        var leafletMap = activeMap();
        if (leafletMap) restrictLeafletToCountry(leafletMap, bbox);
        document.documentElement.classList.add('country-selected');
        if (document.body) document.body.classList.add('country-selected');
        callFilterLayersWithRetry(iso, 40);
        setMapControlsHidden(false);
        var detail = { iso: iso, name: name, bbox: bbox };
        try {
            document.dispatchEvent(new CustomEvent('detectlab:country-selected', { detail: detail }));
        } catch (e) {
            var evt = document.createEvent('CustomEvent');
            evt.initCustomEvent('detectlab:country-selected', true, true, detail);
            document.dispatchEvent(evt);
        }
    }

    /* ══════════════════════════════════════════════════════════
       Canvas globe engine
       (adapted from the reference orthographic-canvas implementation:
       per-pixel texture sampling + hillshade for the base layer, d3
       geoPath vector overlays for countries, geometric picking)
       ══════════════════════════════════════════════════════════ */
    var G = {
        W: 800, H: 600,
        rot: [-15, -50],            // centred on Europe
        k: 1.55,                     // zoom factor
        eu: [],                      // [{iso, name, feature, lat, lng, size, bounds, bboxEU, fromShp}]
        byIso: {},
        hovered: null,
        selected: null,              // entry highlighted during the fly-to animation
        world: null,                 // world-atlas features (all countries)
        mesh: null,                  // world border mesh (faint)
        land: null,                  // merged land (fill under missing imagery / texture-less fallback)
        tex: null, texName: 'none',  // Blue Marble fallback texture (only when the tile service is unreachable)
        shade: null,
        layer: null, baseKey: '', baseStep: 0, off: null,
        proj: null,
        canvas: null, ctx: null,
        spinEnabled: true,
        userInteracting: false,
        flying: false,
        mk: function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
        // The cached base picture is rebuilt when the view changes or when an
        // imagery tile arrives (tiles.rev) — never on hover alone.
        key: function () {
            return [this.rot[0].toFixed(3), this.rot[1].toFixed(3), this.k.toFixed(3), this.W, this.H,
                this.texName, tiles.rev, tiles.disabled ? 'tex' : 'img'].join('|');
        }
    };

    /* ── Imagery tiles: cache, loader, lookup ───────────────────────────── */
    var tiles = {
        cache: new Map(),   // 'z/x/y' → {key, z, x, y, img, data, ok, err, errAt, loading, queued, pinned, frame, used, prio}
        queue: [],          // records waiting for a free download slot
        inflight: 0,
        frame: 0,           // bumped per base draw; marks the tiles the latest frame asked for
        rev: 0,             // bumped on every arrival/failure; part of the base cache key
        loaded: 0,
        failed: 0,
        dataCount: 0,       // tiles currently holding a decoded pixel buffer
        started: false,
        disabled: false     // the service is unreachable → Blue Marble texture / land fill
    };

    function tileKey(z, x, y) { return z + '/' + x + '/' + y; }
    function tileUrl(z, x, y) {
        return IMAGERY_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x);
    }

    // Returns the record for a tile and asks for it when it is not loaded.
    // `prio` is the distance (in tiles) from the view centre: nearer first.
    function getTile(z, x, y, prio) {
        var key = tileKey(z, x, y);
        var t = tiles.cache.get(key);
        if (!t) {
            t = { key: key, z: z, x: x, y: y, img: null, data: null, ok: false, err: false, errAt: 0,
                  loading: false, queued: false, pinned: z <= IMAGERY_PIN_Z, frame: 0, used: 0, prio: 0 };
            tiles.cache.set(key, t);
        } else if (!t.pinned) {
            tiles.cache.delete(key);   // Map keeps insertion order: re-insert = most recently used
            tiles.cache.set(key, t);
        }
        t.frame = tiles.frame;
        t.prio = prio || 0;
        if (t.err && Date.now() - t.errAt > IMAGERY_RETRY_MS) t.err = false;
        if (!t.ok && !t.err && !t.loading && !t.queued && !tiles.disabled) {
            t.queued = true;
            tiles.queue.push(t);
        }
        return t;
    }

    function tileOrder(a, b) {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;   // the always-available base levels first
        if (a.frame !== b.frame) return b.frame - a.frame;      // then what the latest frame needs
        return a.prio - b.prio;                                 // nearest the view centre first
    }

    function pumpTiles() {
        if (tiles.disabled || tiles.inflight >= IMAGERY_INFLIGHT_MAX || !tiles.queue.length) return;
        tiles.queue.sort(tileOrder);
        while (tiles.inflight < IMAGERY_INFLIGHT_MAX && tiles.queue.length) {
            var t = tiles.queue.shift();
            t.queued = false;
            if (!t.pinned && t.frame !== tiles.frame) {
                // The view moved on before the download started: forget the
                // tile; it is asked for again if a later frame needs it.
                tiles.cache.delete(t.key);
                continue;
            }
            loadTile(t);
        }
    }

    function loadTile(t) {
        t.loading = true;
        tiles.inflight++;
        var img = new Image();
        img.crossOrigin = 'anonymous';   // the pixels are read back: a CORS load, as MapLibre does
        img.decoding = 'async';
        img.onload = function () {
            tiles.inflight--;
            t.loading = false;
            t.ok = true;
            t.img = img;
            tiles.loaded++;
            tiles.rev++;
            evictTiles();
            scheduleImageryRender();
            pumpTiles();
        };
        img.onerror = function () {
            tiles.inflight--;
            t.loading = false;
            t.err = true;
            t.errAt = Date.now();
            tiles.failed++;
            tiles.rev++;
            imageryHealthCheck();
            pumpTiles();
        };
        img.src = tileUrl(t.z, t.x, t.y);
    }

    // Tile images beyond the budget go, least recently drawn first. The base
    // levels, downloads in progress and the latest frame's tiles stay.
    function evictTiles() {
        if (tiles.cache.size <= IMAGERY_CACHE_MAX) return;
        var excess = tiles.cache.size - IMAGERY_CACHE_MAX;
        var drop = [];
        tiles.cache.forEach(function (t, key) {
            if (drop.length >= excess) return;
            if (t.pinned || t.loading || t.queued || t.frame === tiles.frame) return;
            drop.push(key);
        });
        drop.forEach(function (key) {
            var t = tiles.cache.get(key);
            if (t && t.data) { t.data = null; tiles.dataCount--; }
            tiles.cache.delete(key);
        });
    }

    // Decoded pixel buffers beyond the budget go, least recently drawn first
    // (the tile image itself stays, so the buffer can be rebuilt cheaply).
    function evictData() {
        if (tiles.dataCount <= IMAGERY_DATA_MAX) return;
        var holders = [];
        tiles.cache.forEach(function (t) { if (t.data && t.used !== tiles.frame) holders.push(t); });
        holders.sort(function (a, b) { return a.used - b.used; });
        for (var i = 0; i < holders.length && tiles.dataCount > IMAGERY_DATA_MAX; i++) {
            holders[i].data = null;
            tiles.dataCount--;
        }
    }

    // Pixels of one loaded tile, read once through a scratch canvas.
    var scratch = null, scratchCtx = null;
    function tileData(t) {
        if (t.data) { t.used = tiles.frame; return t.data; }
        if (!t.ok || !t.img) return null;
        try {
            if (!scratch) {
                scratch = G.mk(TILE_PX, TILE_PX);
                scratchCtx = scratch.getContext('2d', { willReadFrequently: true }) || scratch.getContext('2d');
            }
            scratchCtx.clearRect(0, 0, TILE_PX, TILE_PX);
            scratchCtx.drawImage(t.img, 0, 0, TILE_PX, TILE_PX);
            t.data = scratchCtx.getImageData(0, 0, TILE_PX, TILE_PX).data;
        } catch (e) {
            // A SecurityError means the tile came back without CORS and
            // tainted the canvas: the imagery cannot be sampled at all.
            disableImagery('pixels not readable: ' + (e && e.message));
            return null;
        }
        tiles.dataCount++;
        t.used = tiles.frame;
        return t.data;
    }

    // A redraw once tiles have arrived: promptly when nothing else is
    // outstanding, otherwise a little later so a burst of arrivals is drawn
    // in a few frames rather than one per tile.
    var imageryRenderTimer = 0;
    function scheduleImageryRender() {
        if (imageryRenderTimer) return;
        var delay = (tiles.inflight || tiles.queue.length) ? 220 : 60;
        imageryRenderTimer = window.setTimeout(function () {
            imageryRenderTimer = 0;
            if (gateVisible()) render(G.userInteracting ? 3 : 1);
        }, delay);
    }

    function imageryHealthCheck() {
        if (tiles.disabled || tiles.loaded > 0) return;
        // Nothing has ever arrived and the first requests all failed: the
        // service is unreachable (offline, blocked). Use the bundled texture.
        if (tiles.failed >= 5) disableImagery('tile service unreachable');
    }

    function disableImagery(reason) {
        if (tiles.disabled) return;
        tiles.disabled = true;
        tiles.queue.forEach(function (t) { t.queued = false; });
        tiles.queue.length = 0;
        tiles.rev++;
        console.warn('[DetectLab] Globe gate: World Imagery unavailable (' + reason + '); using the bundled texture.');
        loadTextures();
        setAttribution();
        if (gateVisible()) render(1);
    }

    // Credit line in the gate's corner: Esri while World Imagery is drawn,
    // NASA once the bundled texture has taken over.
    function setAttribution() {
        if (els.attrib) els.attrib.textContent = tiles.disabled ? FALLBACK_ATTRIBUTION : IMAGERY_ATTRIBUTION;
    }

    // The base levels (z0–z2, 21 tiles) are asked for as soon as the gate
    // opens, so every pixel has imagery within a moment and the finer tiles
    // refine the picture as they arrive.
    function startImagery() {
        if (tiles.started || tiles.disabled) return;
        tiles.started = true;
        tiles.frame++;
        for (var z = 0; z <= IMAGERY_PIN_Z; z++) {
            var n = 1 << z;
            for (var y = 0; y < n; y++) {
                for (var x = 0; x < n; x++) {
                    getTile(z, x, y, z * 100 + Math.abs(x + 0.5 - n / 2) + Math.abs(y + 0.5 - n / 2));
                }
            }
        }
        pumpTiles();
    }

    function wrapDeg(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

    // Web Mercator y (0 at the north edge, 1 at the south edge) of a latitude,
    // clamped to the ±85.05° the tiles cover: like MapLibre's globe, the pole
    // caps repeat the outermost row.
    function mercY(latDeg) {
        var s = Math.sin(latDeg * Math.PI / 180);
        if (s > MERC_MAX_SIN) s = MERC_MAX_SIN; else if (s < -MERC_MAX_SIN) s = -MERC_MAX_SIN;
        return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    }

    // Latitude of a Web Mercator y (0 = north edge, 1 = south edge).
    function latFromMercY(yNorm) {
        return Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180 / Math.PI;
    }

    // The largest cos(lat) inside a latitude band: where its Mercator tiles
    // are least stretched, so where the finest zoom is needed.
    function bandCos(latN, latS) {
        if (latN >= 0 && latS <= 0) return 1;
        return Math.cos(Math.min(Math.abs(latN), Math.abs(latS)) * Math.PI / 180);
    }

    // The tile zoom whose texels match the sampled pixels: the globe shows
    // R·π/180 px per degree (R = radius in CSS px, divided by the sampling
    // step of coarse frames) and a Mercator tile row holds 256·2^z/360 px per
    // degree, stretched by 1/cos(lat). Rounded to the nearest level with a
    // slight lean towards magnification (0.64–1.27 texels per sampled pixel),
    // which the bilinear sampler renders without aliasing; rows nearer a pole
    // get a coarser zoom from the same rule.
    function imageryZoomFor(R, cosLat) {
        var c = Math.max(0.15, cosLat);
        var z = Math.round(Math.log(R * Math.PI * c / 128) / Math.LN2 - 0.15);
        return Math.max(1, Math.min(IMAGERY_MAX_Z, z));
    }

    // Geographic extent of the visible part of the globe: the viewport
    // [x0,x1]×[y0,y1] intersected with the disc of radius R about (cx, cy).
    // Longitudes are relative to the view centre (lon0). Latitude and
    // longitude take their extremes on the boundary of the region, so the
    // viewport edges inside the disc and the rim inside the viewport are
    // sampled; a pole inside the region means every longitude is on screen.
    function viewCoverage(R, cx, cy, x0, y0, x1, y1) {
        var DEG = Math.PI / 180;
        var phi0 = -G.rot[1] * DEG;
        var sinp = Math.sin(phi0), cosp = Math.cos(phi0);
        var cov = { lon0: wrapDeg(-G.rot[0]), lat0: -G.rot[1], lonMin: Infinity, lonMax: -Infinity,
                    latMin: Infinity, latMax: -Infinity, full: false };
        function add(px, py) {
            var r2 = px * px + py * py;
            if (r2 > 1) return;
            var z = Math.sqrt(1 - r2);
            var s = z * sinp + py * cosp;
            var lat = Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
            var dlon = Math.atan2(px, z * cosp - py * sinp) / DEG;
            if (dlon < cov.lonMin) cov.lonMin = dlon;
            if (dlon > cov.lonMax) cov.lonMax = dlon;
            if (lat < cov.latMin) cov.latMin = lat;
            if (lat > cov.latMax) cov.latMax = lat;
        }
        var step = 6, x, y;
        for (x = x0; x <= x1 + step; x += step) {
            var xx = Math.min(x, x1);
            add((xx - cx) / R, (cy - y0) / R);
            add((xx - cx) / R, (cy - y1) / R);
        }
        for (y = y0; y <= y1 + step; y += step) {
            var yy = Math.min(y, y1);
            add((x0 - cx) / R, (cy - yy) / R);
            add((x1 - cx) / R, (cy - yy) / R);
        }
        var rr = 0.9995;
        for (var a = 0; a < 360; a++) {
            var px = rr * Math.cos(a * DEG), py = rr * Math.sin(a * DEG);
            var sx = cx + px * R, sy = cy - py * R;
            if (sx >= x0 - 1 && sx <= x1 + 1 && sy >= y0 - 1 && sy <= y1 + 1) add(px, py);
        }
        // Poles: forward orthographic puts them at x = 0, y = ±cos(phi0),
        // visible when z = ±sin(phi0) > 0.
        [1, -1].forEach(function (sign) {
            if (sign * sinp <= 0) return;
            var sy = cy - sign * cosp * R;
            if (cx >= x0 && cx <= x1 && sy >= y0 && sy <= y1) {
                cov.full = true;
                if (sign > 0) cov.latMax = 90; else cov.latMin = -90;
            }
        });
        if (!isFinite(cov.lonMin)) { cov.lonMin = 0; cov.lonMax = 0; cov.latMin = cov.lat0; cov.latMax = cov.lat0; }
        return cov;
    }

    // Tiles of zoom tz covering the extent, padded by one tile. Columns may run
    // past [0, n): a range that straddles the antimeridian keeps its indices
    // continuous and wraps them when the tile is fetched.
    function imageryTileRange(cov, tz) {
        var n = 1 << tz;
        var ty0 = Math.max(0, Math.min(n - 1, Math.floor(mercY(cov.latMax) * n) - 1));
        var ty1 = Math.max(0, Math.min(n - 1, Math.floor(mercY(cov.latMin) * n) + 1));
        var tx0, tx1;
        if (cov.full) {
            tx0 = 0; tx1 = n - 1;
        } else {
            tx0 = Math.floor((cov.lon0 + cov.lonMin + 180) / 360 * n) - 1;
            tx1 = Math.floor((cov.lon0 + cov.lonMax + 180) / 360 * n) + 1;
            if (tx1 - tx0 + 1 >= n) { tx0 = 0; tx1 = n - 1; }
        }
        return { tz: tz, n: n, tx0: tx0, tx1: tx1, ty0: ty0, ty1: ty1, cols: tx1 - tx0 + 1, rows: ty1 - ty0 + 1 };
    }

    // What one frame needs: the tile range at the finest zoom `tz` (the zoom
    // for the least stretched latitude in view) and, per cell of that range,
    // the tile actually asked for — the cell's own tile, or, in rows nearer a
    // pole, where Mercator tiles are stretched and a coarser zoom already
    // matches the screen, its ancestor at that zoom. Cells entirely on the far
    // side of the globe are never sampled, so nothing is asked for them.
    var HORIZON_COS = Math.cos(94 * Math.PI / 180);   // 4° past the rim, see below
    function planImagery(cov, R, tz) {
        var range = imageryTileRange(cov, tz);
        var n = range.n, cols = range.cols, rows = range.rows, count = cols * rows;
        var plan = { range: range, x: new Int32Array(count), rz: new Int32Array(count), rx: new Int32Array(count),
                     ry: new Int32Array(count), visible: new Uint8Array(count), distinct: 0 };
        var DEG = Math.PI / 180;
        var sin0 = Math.sin(cov.lat0 * DEG), cos0 = Math.cos(cov.lat0 * DEG), lon0 = cov.lon0 * DEG;
        var seen = {}, sinLa = [0, 0, 0, 0, 0], cosLa = [0, 0, 0, 0, 0], cosDl = [0, 0, 0, 0, 0];
        for (var gy = 0; gy < rows; gy++) {
            var ty = range.ty0 + gy;
            var latN = latFromMercY(ty / n), latS = latFromMercY((ty + 1) / n);
            var rz = Math.min(tz, imageryZoomFor(R, bandCos(latN, latS)));
            var up = tz - rz;
            var k;
            for (k = 0; k < 5; k++) {
                var la = (latN + (latS - latN) * k / 4) * DEG;
                sinLa[k] = Math.sin(la); cosLa[k] = Math.cos(la);
            }
            for (var gx = 0; gx < cols; gx++) {
                var idx = gy * cols + gx;
                var x = (((range.tx0 + gx) % n) + n) % n;
                // Visible when any of 5×5 sample points is within 94° of the
                // view centre. The margin covers the bulge of a tile's parallel
                // edges between samples; a miss only costs a cell its finest
                // tile (it is drawn from an ancestor), never a hole.
                var vis = rz <= IMAGERY_PIN_Z;
                if (!vis) {
                    for (k = 0; k < 5; k++) cosDl[k] = Math.cos(((x + k / 4) / n * 360 - 180) * DEG - lon0);
                    for (var a = 0; a < 5 && !vis; a++) {
                        for (var b = 0; b < 5; b++) {
                            if (sinLa[a] * sin0 + cosLa[a] * cos0 * cosDl[b] > HORIZON_COS) { vis = true; break; }
                        }
                    }
                }
                plan.x[idx] = x;
                plan.rz[idx] = rz;
                plan.rx[idx] = x >> up;
                plan.ry[idx] = ty >> up;
                plan.visible[idx] = vis ? 1 : 0;
                if (vis && rz > IMAGERY_PIN_Z) {
                    var key = tileKey(rz, x >> up, ty >> up);
                    if (!seen[key]) { seen[key] = true; plan.distinct++; }
                }
            }
        }
        return plan;
    }

    // `step` is the sampling step of the frame: the spin and the fly-to sample
    // every 2nd pixel, drags every 3rd. The zoom follows the resolution
    // actually drawn, but only half-way (√step): texels then span 1–2
    // sampled pixels, which bilinear sampling still averages without
    // shimmer, while the picture stays as sharp as the sampling allows and
    // the refined frame mostly reuses the tiles the coarse one drew.
    function chooseImageryRange(cov, R, step) {
        var Rs = R / Math.sqrt(step || 1);
        var tz = imageryZoomFor(Rs, bandCos(cov.latMax, cov.latMin));
        var plan = planImagery(cov, Rs, tz);
        while (plan.distinct > IMAGERY_MAX_TILES && tz > 1) {
            tz--;
            plan = planImagery(cov, Rs, tz);
        }
        return plan;
    }

    // The lookup table one frame samples from: per cell of the range, the
    // pixels of the tile planned for it, or of its nearest loaded ancestor,
    // with `shift` = levels above the range zoom and ox/oy = the cell's
    // offset inside that tile.
    function buildImageryGrid(plan, cov) {
        var range = plan.range;
        var n = range.n, cols = range.cols, rows = range.rows, tz = range.tz;
        var count = cols * rows;
        var grid = { data: new Array(count), shift: new Int32Array(count), ox: new Int32Array(count),
                     oy: new Int32Array(count), complete: true, missing: 0 };
        var txC = Math.floor((cov.lon0 + 180) / 360 * n), tyC = Math.floor(mercY(cov.lat0) * n);
        for (var gy = 0; gy < rows; gy++) {
            var ty = range.ty0 + gy;
            for (var gx = 0; gx < cols; gx++) {
                var idx = gy * cols + gx;
                var x = plan.x[idx], rz = plan.rz[idx];
                var up0 = tz - rz;
                grid.data[idx] = null;
                if (plan.visible[idx]) {
                    var dx = Math.abs(x - txC);
                    getTile(rz, plan.rx[idx], plan.ry[idx], Math.min(dx, n - dx) + Math.abs(ty - tyC));
                }
                for (var up = plan.visible[idx] ? up0 : 0; up <= tz; up++) {
                    var a = tiles.cache.get(tileKey(tz - up, x >> up, ty >> up));
                    if (!a || !a.ok) continue;
                    var ad = tileData(a);
                    if (!ad) break;
                    a.frame = tiles.frame;   // in use: keep it out of the eviction
                    var sub = TILE_PX >> up;
                    grid.data[idx] = ad;
                    grid.shift[idx] = up;
                    grid.ox[idx] = (x - ((x >> up) << up)) * sub;
                    grid.oy[idx] = (ty - ((ty >> up) << up)) * sub;
                    break;
                }
                if (!grid.data[idx]) { grid.complete = false; grid.missing++; }
            }
        }
        return grid;
    }

    // Samples the imagery onto the pixel buffer `id` (w×h, every `s`-th canvas
    // pixel from x0/y0) through the inverse orthographic mapping. Pixels off
    // the disc or without any loaded tile keep alpha 0.
    function sampleImagery(id, w, h, s, x0, y0, R, cx, cy, range, grid) {
        var DEG = Math.PI / 180;
        var lam0 = wrapDeg(-G.rot[0]) * DEG, phi0 = -G.rot[1] * DEG;
        var sinp = Math.sin(phi0), cosp = Math.cos(phi0);
        var n = range.n, n256 = n * TILE_PX, cols = range.cols, rows = range.rows, tx0 = range.tx0, ty0 = range.ty0;
        var kx = n256 / (2 * Math.PI), yMax = n256 - 0.001;
        var gData = grid.data, gShift = grid.shift, gOx = grid.ox, gOy = grid.oy;
        var PI = Math.PI, SMAX = MERC_MAX_SIN;
        for (var j = 0; j < h; j++) {
            var py = (cy - (y0 + j * s + s / 2)) / R;
            for (var i = 0; i < w; i++) {
                var px = ((x0 + i * s + s / 2) - cx) / R, r2 = px * px + py * py;
                if (r2 >= 1) continue;
                var z = Math.sqrt(1 - r2);
                var sl = z * sinp + py * cosp;                           // sin(lat)
                if (sl > SMAX) sl = SMAX; else if (sl < -SMAX) sl = -SMAX;
                var mx = (lam0 + Math.atan2(px, z * cosp - py * sinp) + PI) * kx;
                if (mx < 0) mx += n256; else if (mx >= n256) mx -= n256;
                var my = (PI - 0.5 * Math.log((1 + sl) / (1 - sl))) * kx;   // atanh(sin lat) = ln tan(π/4 + lat/2)
                if (my >= yMax) my = yMax; else if (my < 0) my = 0;
                var mxi = mx | 0, myi = my | 0;
                var gx = (mxi >> 8) - tx0;
                if (gx < 0) gx += n; else if (gx >= cols) gx -= n;
                if (gx < 0 || gx >= cols) continue;
                var gy = (myi >> 8) - ty0;
                if (gy < 0 || gy >= rows) continue;
                var gi = gy * cols + gx;
                var td = gData[gi];
                if (!td) continue;
                // Bilinear sample at texel-centre coordinates inside the tile
                // (or inside the ancestor standing in for it, at its scale).
                var u = mx - (mxi & ~255), v = my - (myi & ~255), sh = gShift[gi];
                if (sh) { u = u / (1 << sh) + gOx[gi]; v = v / (1 << sh) + gOy[gi]; }
                u -= 0.5; v -= 0.5;
                var iu = ((u + 1) | 0) - 1, iv = ((v + 1) | 0) - 1;
                var fu = u - iu, fv = v - iv;
                var iu0 = iu < 0 ? 0 : iu, iu1 = iu > 254 ? 255 : iu + 1;
                var iv0 = iv < 0 ? 0 : iv, iv1 = iv > 254 ? 255 : iv + 1;
                var r0 = iv0 << 8, r1 = iv1 << 8;
                var o00 = (r0 | iu0) << 2, o10 = (r0 | iu1) << 2, o01 = (r1 | iu0) << 2, o11 = (r1 | iu1) << 2;
                var w11 = fu * fv, w10 = fu - w11, w01 = fv - w11, w00 = 1 - fu - fv + w11;
                var o = (j * w + i) << 2;
                id[o] = td[o00] * w00 + td[o10] * w10 + td[o01] * w01 + td[o11] * w11;
                id[o + 1] = td[o00 + 1] * w00 + td[o10 + 1] * w10 + td[o01 + 1] * w01 + td[o11 + 1] * w11;
                id[o + 2] = td[o00 + 2] * w00 + td[o10 + 2] * w10 + td[o01 + 2] * w01 + td[o11 + 2] * w11;
                id[o + 3] = 255;
            }
        }
    }

    function polysOf(g) { return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
    function centroidOf(p) { return window.d3.geoCentroid({ type: 'Polygon', coordinates: p }); }
    // Loose window used to pick candidate shapes out of the raw shapefile.
    function looseEu(p) { var c = centroidOf(p), lo = c[0], la = c[1]; return lo > -32 && lo < 190 && la > 34 && la < 82; }
    // Display window: continental Europe (+ Caucasus/Turkey); Russia keeps all
    // of its polygons so the globe never shows a truncated coastline.
    function keepFor(iso, p) {
        if (iso === 'RU') return true;
        var c = centroidOf(p), lo = c[0], la = c[1];
        return lo > -32 && lo < 62 && la > 33 && la < 82;
    }
    // Hand-off window: what the Leaflet map gets locked to. European Russia
    // only — the app's layer catalogue is European.
    function inHandoffWindow(p) {
        var c = centroidOf(p), lo = c[0], la = c[1];
        return lo > -32 && lo < 62 && la > 33 && la < 82;
    }
    function bboxArea(poly) {
        var a = 1e9, b = -1e9, c = 1e9, e = -1e9;
        for (var i = 0; i < poly[0].length; i++) {
            var x = poly[0][i][0], y = poly[0][i][1];
            if (x < a) a = x; if (x > b) b = x;
            if (y < c) c = y; if (y > e) e = y;
        }
        return (b - a) * (e - c);
    }
    function lngLatBbox(polys) {
        var w = 1e9, s = 1e9, e = -1e9, n = -1e9;
        polys.forEach(function (poly) {
            poly.forEach(function (ring) {
                for (var i = 0; i < ring.length; i++) {
                    var x = ring[i][0], y = ring[i][1];
                    if (x < w) w = x; if (x > e) e = x;
                    if (y < s) s = y; if (y > n) n = y;
                }
            });
        });
        return (w <= e && s <= n) ? [w, s, e, n] : null;
    }
    function simp(ring) {
        if (ring.length < 40) return ring;
        var out = [ring[0]], l = ring[0];
        for (var i = 1; i < ring.length - 1; i++) {
            var p = ring[i];
            if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.03) { out.push(p); l = p; }
        }
        out.push(ring[ring.length - 1]);
        return out.length >= 4 ? out : ring;
    }
    function simpPoly(p) { // keep the original if simplification breaks the polygon
        var d3g = window.d3;
        var q = p.map(simp);
        var same = true;
        for (var i = 0; i < q.length; i++) if (q[i] !== p[i]) { same = false; break; }
        if (same) return p;
        var a0 = d3g.geoArea({ type: 'Polygon', coordinates: p });
        var a1 = d3g.geoArea({ type: 'Polygon', coordinates: q });
        return Math.abs(a1 - a0) <= 0.0005 + 0.05 * a0 ? q : p;
    }

    function isoOfWorldFeature(f) {
        var name = f && f.properties && f.properties.name;
        return NAME_TO_ISO[normalizeName(name)] || null;
    }

    // shpFeatures may be null → the public world-atlas geometry is used.
    // When the 10m shapefile is available its (much more detailed) shapes are
    // matched to the atlas countries by point-in-polygon on their centroids.
    function buildEurope(shpFeatures) {
        var d3g = window.d3;
        var euWorld = [];
        var seen = {};
        (G.world || []).forEach(function (f) {
            var iso = isoOfWorldFeature(f);
            if (iso && EUROPE_ISO[iso] && !seen[iso] && f.geometry &&
                (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')) {
                seen[iso] = true;
                euWorld.push({ iso: iso, feature: f });
            }
        });

        var found = {};
        (shpFeatures || []).forEach(function (f) {
            if (!f || !f.geometry) return;
            if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') return;
            var kept = polysOf(f.geometry).filter(looseEu);
            if (!kept.length) return;
            var big = kept.reduce(function (a, b) { return bboxArea(a) > bboxArea(b) ? a : b; });
            var pt = centroidOf(big);
            for (var i = 0; i < euWorld.length; i++) {
                if (d3g.geoContains(euWorld[i].feature, pt)) {
                    var iso = euWorld[i].iso;
                    found[iso] = (found[iso] || []).concat(polysOf(f.geometry));
                    break;
                }
            }
        });

        var eu = [];
        euWorld.forEach(function (w) {
            var iso = w.iso;
            var src = found[iso] || polysOf(w.feature.geometry);
            var coords = src.filter(function (p) { return keepFor(iso, p); }).map(simpPoly);
            if (!coords.length) return;
            var big = coords.reduce(function (a, b) { return bboxArea(a) > bboxArea(b) ? a : b; });
            var c = centroidOf(big), lng = c[0], lat = c[1];
            var feature = { type: 'Feature', properties: { iso: iso }, geometry: { type: 'MultiPolygon', coordinates: coords } };
            var euPolys = coords.filter(inHandoffWindow);
            var bboxEU = lngLatBbox(euPolys.length ? euPolys : coords);
            eu.push({
                iso: iso,
                name: (w.feature.properties && w.feature.properties.name) || NAMES[iso].en,
                feature: feature,
                lat: lat, lng: lng,
                size: Math.sqrt(bboxArea(big)),
                bounds: d3g.geoBounds(feature),
                bboxEU: bboxEU,
                fromShp: !!found[iso]
            });
        });
        G.eu = eu;
        G.byIso = {};
        eu.forEach(function (d) { G.byIso[d.iso] = d; });
        return eu;
    }

    function makeTexture(img) {
        var w = 2048, h = 1024, c = G.mk(w, h), x = c.getContext('2d');
        x.drawImage(img, 0, 0, w, h);
        return { w: w, h: h, data: x.getImageData(0, 0, w, h).data };
    }
    function makeShade(topo) { // hillshade derived from the elevation map
        var w = 2048, h = 1024, c = G.mk(w, h), x = c.getContext('2d');
        x.drawImage(topo, 0, 0, w, h);
        var d = x.getImageData(0, 0, w, h).data, sh = new Float32Array(w * h);
        for (var y = 1; y < h - 1; y++) {
            for (var i = 1; i < w - 1; i++) {
                var dh = d[((y + 1) * w + i + 1) * 4] - d[((y - 1) * w + i - 1) * 4];
                sh[y * w + i] = Math.max(0.65, Math.min(1.35, 1 + dh * 0.012));
            }
        }
        sh.fill(1, 0, w); sh.fill(1, (h - 1) * w);
        return sh;
    }

    function getProj() {
        var R = Math.min(G.W, G.H) / 2 * 0.88 * G.k;
        return window.d3.geoOrthographic().rotate(G.rot).translate([G.W / 2, G.H / 2]).scale(R).clipAngle(90).precision(0.5);
    }

    // Background + imagery + world borders. Rebuilt only when rotation/zoom/
    // size change or a tile arrives (G.key()); vector overlays are drawn on
    // top each frame in draw().
    function drawBase(step) {
        var d3g = window.d3;
        var ctx = G.layer.getContext('2d'), W = G.W, H = G.H;
        var proj = getProj(), R = proj.scale(), cx = W / 2, cy = H / 2;
        var path = d3g.geoPath(proj, ctx);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // Same background as the working map's globe (globe-base-layer.js), no
        // atmosphere halo: MapLibre draws none either.
        ctx.fillStyle = IMAGERY_BACKGROUND; ctx.fillRect(0, 0, W, H);
        ctx.beginPath(); path({ type: 'Sphere' }); ctx.fillStyle = '#0e2a47'; ctx.fill();

        var s = step;
        var x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
        var x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
        var w = Math.max(1, Math.ceil((x1 - x0) / s)), h = Math.max(1, Math.ceil((y1 - y0) / s));
        var octx, img, id;
        function sampledBuffer() {
            if (!G.off || G.off.width !== w || G.off.height !== h) G.off = G.mk(w, h);
            octx = G.off.getContext('2d');
            img = octx.createImageData(w, h);
            id = img.data;
        }
        function blitSampled() {
            octx.putImageData(img, 0, 0);
            ctx.save(); ctx.beginPath(); path({ type: 'Sphere' }); ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(G.off, 0, 0, w, h, x0, y0, w * s, h * s);
            ctx.restore();
        }
        function landFill() {
            if (!G.land) return;
            ctx.beginPath(); path(G.land); ctx.fillStyle = '#2d4a3e'; ctx.fill();
        }

        if (!tiles.disabled) {
            // The working map's imagery, flat-lit, the pole caps extended like
            // MapLibre's. Tiles still downloading are stood in for by their
            // nearest loaded ancestor; only pixels with no tile at all show the
            // flat land fill underneath.
            var cov = viewCoverage(R, cx, cy, x0, y0, x1, y1);
            var plan = chooseImageryRange(cov, R, s);
            var range = plan.range;
            tiles.frame++;
            var grid = buildImageryGrid(plan, cov);
            pumpTiles();
            evictTiles();
            evictData();
            G.imageryFrame = { tz: range.tz, cols: range.cols, rows: range.rows, tiles: plan.distinct, missing: grid.missing };
            if (!grid.complete) landFill();
            if (!tiles.disabled) {   // tileData() may have found the pixels unreadable
                sampledBuffer();
                sampleImagery(id, w, h, s, x0, y0, R, cx, cy, range, grid);
                blitSampled();
            }
        }
        if (tiles.disabled) {
            if (G.tex) {
                // Fallback texture (Blue Marble + hillshade), only when the tile
                // service cannot be reached at all.
                sampledBuffer();
                var lam0 = -G.rot[0] * Math.PI / 180, phi0 = -G.rot[1] * Math.PI / 180;
                var sinp = Math.sin(phi0), cosp = Math.cos(phi0);
                var T = G.tex, tw = T.w, th = T.h, sh = G.shade;
                for (var j = 0; j < h; j++) {
                    var py = (cy - (y0 + j * s + s / 2)) / R;
                    for (var i = 0; i < w; i++) {
                        var px = ((x0 + i * s + s / 2) - cx) / R, r2 = px * px + py * py, o = (j * w + i) * 4;
                        if (r2 >= 1) continue;
                        var z = Math.sqrt(1 - r2);
                        var lat = Math.asin(z * sinp + py * cosp), lon = lam0 + Math.atan2(px, z * cosp - py * sinp);
                        var ld = lon * 57.29578; ld = ((ld + 180) % 360 + 360) % 360;
                        var u = Math.min(tw - 1, (ld / 360 * tw) | 0);
                        var v = Math.max(0, Math.min(th - 1, ((90 - lat * 57.29578) / 180 * th) | 0));
                        var ti = v * tw + u, f = (sh ? sh[ti] : 1) * (0.62 + 0.38 * Math.sqrt(z));
                        id[o] = Math.min(255, T.data[ti * 4] * f);
                        id[o + 1] = Math.min(255, T.data[ti * 4 + 1] * f);
                        id[o + 2] = Math.min(255, T.data[ti * 4 + 2] * f);
                        id[o + 3] = 255;
                    }
                }
                blitSampled();
            } else {
                landFill();   // texture-less fallback: flat land fill
            }
        }
        if (G.mesh) { ctx.beginPath(); path(G.mesh); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 0.6; ctx.stroke(); }
        G.baseKey = G.key();
    }

    function draw(step) {
        var d3g = window.d3;
        var ctx = G.ctx;
        if (!ctx) return;
        if (!G.layer || G.layer.width !== G.W || G.layer.height !== G.H) {
            G.layer = G.mk(G.W, G.H);
            G.baseKey = '';
        }
        if (G.baseKey !== G.key() || G.baseStep !== step) { drawBase(step); G.baseStep = step; }
        ctx.drawImage(G.layer, 0, 0, G.W, G.H);
        var proj = getProj(); G.proj = proj;
        var path = d3g.geoPath(proj, ctx);
        var d, q, i;

        // all European countries: translucent grey-violet fill, black border
        // over a pale casing (legible on sea, land and ice alike)
        for (i = 0; i < G.eu.length; i++) {
            d = G.eu[i];
            ctx.beginPath(); path(d.feature);
            ctx.fillStyle = 'rgba(107,95,130,.34)'; ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,.65)'; ctx.lineWidth = 1.8; ctx.stroke();
            ctx.strokeStyle = 'rgba(0,0,0,.95)'; ctx.lineWidth = 0.9; ctx.stroke();
        }
        ctx.lineJoin = 'round';
        if (G.selected) { // fly-to highlight
            ctx.beginPath(); path(G.selected.feature);
            ctx.fillStyle = 'rgba(57,255,20,.5)'; ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 5; ctx.stroke();
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 2.4; ctx.stroke();
        }
        if (G.hovered && G.hovered !== G.selected) { // neon-green hover
            ctx.beginPath(); path(G.hovered.feature);
            ctx.fillStyle = 'rgba(57,255,20,.42)'; ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 4.5; ctx.stroke();
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 2; ctx.stroke();
        }
        // micro-states: ring marker when they'd be invisible at this zoom
        for (i = 0; i < G.eu.length; i++) {
            d = G.eu[i];
            var hv = d === G.hovered || d === G.selected;
            if (!hv || d.size * G.k > 1.5) continue;
            q = proj([d.lng, d.lat]);
            if (!q || d3g.geoDistance([d.lng, d.lat], [-G.rot[0], -G.rot[1]]) > 1.5) continue;
            ctx.beginPath(); ctx.arc(q[0], q[1], 9, 0, 7);
            ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 5; ctx.stroke();
            ctx.strokeStyle = '#39ff14'; ctx.lineWidth = 2.5; ctx.stroke();
        }
        // label for the hovered / selected country
        var labelled = [];
        if (G.selected) labelled.push(G.selected);
        if (G.hovered && G.hovered !== G.selected) labelled.push(G.hovered);
        var center = [-G.rot[0], -G.rot[1]];
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (i = 0; i < labelled.length; i++) {
            d = labelled[i];
            if (d3g.geoDistance([d.lng, d.lat], center) > 1.45) continue;
            q = proj([d.lng, d.lat]);
            if (!q) continue;
            ctx.font = '600 ' + Math.round(12 + Math.min(6, d.size * G.k * 0.5)) + 'px system-ui, sans-serif';
            ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)';
            var label = displayName(d.iso, d.name);
            ctx.strokeText(label, q[0], q[1]);
            ctx.fillStyle = '#eaffdd';
            ctx.fillText(label, q[0], q[1]);
        }
    }

    // Geometric picking: exact point-in-polygon first, then a 12-px screen
    // tolerance so micro-states (Malta, Monaco, Vatican…) stay clickable.
    function pick(x, y) {
        var d3g = window.d3;
        var proj = G.proj || getProj();
        var pt = proj.invert([x, y]);
        if (!pt || isNaN(pt[0]) || isNaN(pt[1])) return null;
        // reject the far side of the globe
        if (d3g.geoDistance(pt, [-G.rot[0], -G.rot[1]]) > Math.PI / 2) return null;
        var lo = pt[0], la = pt[1], i, d;
        for (i = 0; i < G.eu.length; i++) {
            d = G.eu[i];
            var b = d.bounds, w = b[0][0], s = b[0][1], e = b[1][0], n = b[1][1];
            if (la < s || la > n) continue;
            if (!(w <= e ? (lo >= w && lo <= e) : (lo >= w || lo <= e))) continue;
            if (d3g.geoContains(d.feature, pt)) return d;
        }
        var best = null, bd = 12;
        for (i = 0; i < G.eu.length; i++) {
            d = G.eu[i];
            if (d.size > 2.5) continue;
            var q = proj([d.lng, d.lat]);
            if (!q) continue;
            var dist = Math.hypot(q[0] - x, q[1] - y);
            if (dist < bd) { bd = dist; best = d; }
        }
        return best;
    }

    /* ── Render scheduling (coarse while interacting, refine when idle) ── */
    var drawing = false, idleTimer = 0, nextStep = 1;
    function render(step) {
        step = step || 1;
        nextStep = Math.max(nextStep, step);
        if (drawing) return;
        drawing = true;
        window.requestAnimationFrame(function () {
            drawing = false;
            if (!G.ctx || !gateVisible()) { nextStep = 1; return; }
            var st = nextStep; nextStep = 1;
            var dpr = Math.min(2, window.devicePixelRatio || 1);
            G.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            try { draw(st); } catch (e) { console.warn('[DetectLab] Globe gate render error', e); }
            if (st > 1) {
                window.clearTimeout(idleTimer);
                idleTimer = window.setTimeout(function () { render(1); }, 140);
            }
        });
    }

    function gateVisible() {
        return !!(els.root && !els.root.classList.contains('hidden'));
    }

    function resizeNow() {
        if (!G.canvas || !els.canvas) return;
        var r = els.canvas.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        var dpr = Math.min(2, window.devicePixelRatio || 1);
        G.W = Math.max(200, Math.round(r.width));
        G.H = Math.max(200, Math.round(r.height));
        G.canvas.width = Math.round(G.W * dpr);
        G.canvas.height = Math.round(G.H * dpr);
        G.layer = null;
        render(1);
    }

    /* ── Interaction: drag-rotate, hover, click, wheel + pinch zoom ── */
    function canvasXY(e) {
        var r = G.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }
    function setZoom(k) {
        G.k = Math.max(0.8, Math.min(16, k));
        render(2);
    }
    function wireCanvasEvents() {
        var cv = G.canvas;
        var down = null;
        var pointers = {};
        var pinchDist = 0;

        cv.addEventListener('pointerdown', function (e) {
            try { cv.setPointerCapture(e.pointerId); } catch (err) {}
            pointers[e.pointerId] = canvasXY(e);
            var ids = Object.keys(pointers);
            G.userInteracting = true;
            G.spinEnabled = false; // first touch stops the idle auto-spin for good
            if (ids.length === 2) {
                var a = pointers[ids[0]], b = pointers[ids[1]];
                pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
                down = null;
            } else {
                down = { p: canvasXY(e), moved: 0, rot: G.rot.slice() };
            }
        });
        cv.addEventListener('pointermove', function (e) {
            var p = canvasXY(e);
            if (pointers[e.pointerId]) pointers[e.pointerId] = p;
            var ids = Object.keys(pointers);
            if (ids.length === 2) { // pinch zoom
                var a = pointers[ids[0]], b = pointers[ids[1]];
                var dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
                if (pinchDist > 0 && dist > 0) setZoom(G.k * dist / pinchDist);
                pinchDist = dist;
                return;
            }
            if (down && !G.flying) {
                var dx = p[0] - down.p[0], dy = p[1] - down.p[1];
                down.moved = Math.max(down.moved, Math.hypot(dx, dy));
                if (down.moved > 4) {
                    var f = 0.3 / G.k;
                    G.rot = [down.rot[0] + dx * f, Math.max(-90, Math.min(90, down.rot[1] - dy * f))];
                    if (G.hovered) { G.hovered = null; hideHint(); }
                    render(3);
                    return;
                }
            }
            if (G.flying) return;
            var h = pick(p[0], p[1]);
            if (h !== G.hovered) {
                G.hovered = h;
                cv.style.cursor = h ? 'pointer' : 'grab';
                if (h) showHint(displayName(h.iso, h.name)); else hideHint();
                render(1);
            }
        });
        function release(e) {
            delete pointers[e.pointerId];
            if (!Object.keys(pointers).length) { G.userInteracting = false; pinchDist = 0; }
        }
        cv.addEventListener('pointerup', function (e) {
            if (down && down.moved <= 4 && !G.flying) {
                var h = pick.apply(null, canvasXY(e));
                if (h) selectCountry(h.iso);
            }
            down = null;
            release(e);
        });
        cv.addEventListener('pointercancel', function (e) { down = null; release(e); });
        cv.addEventListener('pointerleave', function () {
            if (G.hovered) { G.hovered = null; hideHint(); render(1); }
        });
        cv.addEventListener('wheel', function (e) {
            e.preventDefault();
            G.spinEnabled = false;
            setZoom(G.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
        }, { passive: false });
    }

    /* ── Idle auto-spin (until the first interaction) ── */
    var spinRaf = 0;
    function spinLoop() {
        spinRaf = 0;
        if (!gateVisible()) return;
        if (G.spinEnabled && !G.userInteracting && !G.flying && !document.hidden) {
            G.rot[0] += 0.045;
            render(2);
        }
        spinRaf = window.requestAnimationFrame(spinLoop);
    }
    function startSpinLoop() {
        if (!spinRaf) spinRaf = window.requestAnimationFrame(spinLoop);
    }
    function stopSpinLoop() {
        if (spinRaf) { window.cancelAnimationFrame(spinRaf); spinRaf = 0; }
    }

    /* ── Fly-to animation, then hand off to Leaflet ── */
    function flyTo(entry, done) {
        var d3g = window.d3;
        G.flying = true;
        G.selected = entry;
        G.hovered = null;
        var rot0 = G.rot.slice(), k0 = G.k;
        var lon1 = -entry.lng, lat1 = -entry.lat;
        lon1 = rot0[0] + (((lon1 - rot0[0] + 540) % 360) - 180); // shortest way round
        var b = entry.bounds;
        var spanLon = b[1][0] >= b[0][0] ? b[1][0] - b[0][0] : 360 - b[0][0] + b[1][0];
        var span = Math.max(spanLon, b[1][1] - b[0][1], 0.5);
        var k1 = Math.max(2, Math.min(9, 60 / span));
        if (entry.iso === 'RU') k1 = 1.8;
        var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
        var dur = 950;
        function stepFrame() {
            var now = (window.performance && performance.now) ? performance.now() : Date.now();
            var t = Math.min(1, (now - t0) / dur);
            var e = t * t * (3 - 2 * t); // smoothstep
            G.rot = [rot0[0] + (lon1 - rot0[0]) * e, rot0[1] + (lat1 - rot0[1]) * e];
            G.k = k0 + (k1 - k0) * e;
            render(2);
            if (t < 1 && gateVisible()) {
                window.requestAnimationFrame(stepFrame);
            } else {
                render(1);
                window.setTimeout(function () {
                    G.flying = false;
                    done();
                }, 180);
            }
        }
        window.requestAnimationFrame(stepFrame);
    }

    function selectCountry(iso) {
        var entry = G.byIso[iso];
        if (!entry || !entry.bboxEU) return;
        var name = displayName(iso, entry.name);
        showHint(name, true);
        flyTo(entry, function () {
            finishSelection(iso, name, entry.bboxEU);
            G.selected = null;
        });
    }

    function finishSelection(iso, name, bbox) {
        persistSelection(iso, name, bbox);
        applySelection(iso, name, bbox);
        closeGate(true);
    }

    /* ══════════════════════════════════════════════════════════
       Switching country without the globe — the API behind
       js/country-dock.js (the slide-down list glued to the search bar).
       ══════════════════════════════════════════════════════════ */

    // Last-resort bbox for a country whose geometry never loaded: the rough
    // [lng, lat, zoom] table above still yields a sane locked view.
    function approxBbox(iso) {
        var c = APPROX_CENTER[iso] || [15, 48, 5];
        var lonSpan = 360 / Math.pow(2, c[2]);   // ≈ the width the old picker zoomed to
        var latSpan = lonSpan * 0.6;
        return [c[0] - lonSpan / 2, c[1] - latSpan / 2, c[0] + lonSpan / 2, c[1] + latSpan / 2];
    }

    // What the dock renders: every selectable country with its 2-letter code,
    // both names and the bbox it locks the map to (real geometry when it is
    // loaded, the static approximation otherwise). Sorted for the current
    // language, so the grid order follows the UI language like the rest of
    // the site.
    function listCountries() {
        var lang = currentLang();
        return Object.keys(NAMES).map(function (iso) {
            var entry = G.byIso[iso];
            return {
                iso: iso,
                code: iso,
                name: displayName(iso, (entry && entry.name) || NAMES[iso].en),
                en: NAMES[iso].en,
                ro: NAMES[iso].ro,
                bbox: (entry && entry.bboxEU) || approxBbox(iso),
                fromGeometry: !!(entry && entry.bboxEU)
            };
        }).sort(function (a, b) {
            return a.name.localeCompare(b.name, lang === 'ro' ? 'ro' : 'en');
        });
    }

    function nameOf(iso) {
        iso = String(iso || '').toUpperCase();
        if (!NAMES[iso]) return null;
        var entry = G.byIso[iso];
        return displayName(iso, (entry && entry.name) || NAMES[iso].en);
    }

    /* Pick a country straight from the search-bar dock: the geometry is
       loaded in the background (local atlas, one small fetch), then the map
       is moved to the country and locked to it exactly like a globe pick —
       same localStorage record and the same `detectlab:country-selected`
       event, so search sources and layer filtering follow along unchanged. */
    function selectCountryByIso(iso) {
        iso = String(iso || '').toUpperCase();
        if (!NAMES[iso]) return Promise.reject(new Error('Unknown country code: ' + iso));
        return ensureReady().then(function () {
            var entry = G.byIso[iso];
            var bbox = (entry && entry.bboxEU) || approxBbox(iso);
            var name = displayName(iso, (entry && entry.name) || NAMES[iso].en);
            finishSelection(iso, name, bbox);
            return { iso: iso, name: name, bbox: bbox };
        });
    }

    // Warm d3/topojson/atlas in the background so the first dock click is
    // instant (the globe gate itself only loads them when it opens).
    function prefetch() {
        return ensureReady().then(function () { return true; }, function () { return false; });
    }

    /* “Exit view” — the button js/country-dock.js shows in the middle of the
       bottom edge once the locked country view is zoomed all the way out.
       It releases the lock, pulls back to the European overview and reopens
       the globe, so leaving a country always means choosing another one. */
    function exitView() {
        var map = activeMap();
        unlockCountryView();
        if (map && typeof map.setView === 'function') {
            try {
                map.setView([48.5, 14], Math.max(state.baseMinZoom || 2, 4), { animate: true });
            } catch (e) {}
        }
        openGate();
    }

    /* ── Data loading ── */
    function loadLibraries() {
        var need = [];
        if (!(window.d3 && window.d3.geoOrthographic && window.d3.geoContains)) need.push(loadScript(D3_JS));
        if (!(window.topojson && window.topojson.feature)) need.push(loadScript(TOPOJSON_JS));
        return Promise.all(need);
    }

    function loadAtlas() {
        function parse(json) {
            var tj = window.topojson;
            var feats = tj.feature(json, json.objects.countries).features;
            G.world = feats;
            G.mesh = tj.mesh(json, json.objects.countries, function (a, b) { return a !== b; });
            try { G.land = tj.merge(json, json.objects.countries.geometries); } catch (e) { G.land = null; }
            return feats;
        }
        return fetchWithTimeout(ATLAS_LOCAL, FETCH_TIMEOUT_MS)
            .then(function (res) { return res.json(); })
            .then(parse)
            .catch(function (err) {
                console.warn('[DetectLab] Globe gate: local atlas unavailable, trying the public mirror.', err && err.message);
                return fetchWithTimeout(ATLAS_REMOTE, FETCH_TIMEOUT_MS)
                    .then(function (res) { return res.json(); })
                    .then(parse);
            });
    }

    // Fallback texture (Blue Marble + hillshade), loaded only when the imagery
    // tile service cannot be reached (disableImagery). The globe (flat land
    // fill) works without it, so this never blocks the gate.
    var texturesStarted = false;
    function loadTextures() {
        if (texturesStarted) return;
        texturesStarted = true;
        var shadePromise = loadImage(TOPOLOGY_LOCAL)
            .catch(function () { return loadImage(TOPOLOGY_REMOTE); })
            .then(function (img) { return makeShade(img); })
            .catch(function () { return null; });
        loadImage(TEXTURE_LOCAL)
            .catch(function () { return loadImage(TEXTURE_REMOTE); })
            .then(function (img) { return makeTexture(img); })
            .then(function (tex) {
                return shadePromise.then(function (shade) {
                    G.tex = tex;
                    G.shade = shade;
                    G.texName = 'blue-marble';
                    render(1);
                });
            })
            .catch(function (err) {
                console.warn('[DetectLab] Globe gate: Earth texture unavailable, using the flat land fill.', err && err.message);
            });
    }

    // Optional refinement: trade the 50m atlas coastlines for the Natural
    // Earth 10m shapefile when it can be streamed. Never blocks, never fails
    // the gate.
    var shpStarted = false;
    function refineFromShapefile() {
        if (shpStarted) return;
        shpStarted = true;
        loadScript(SHAPEFILE_JS)
            .then(function () {
                if (!window.shapefile || typeof window.shapefile.read !== 'function') {
                    throw new Error('shapefile reader unavailable');
                }
                return window.shapefile.read(SHP_URL);
            })
            .then(function (collection) {
                var feats = collection && collection.features;
                if (!feats || !feats.length) throw new Error('empty shapefile');
                var selIso = G.selected && G.selected.iso;
                var hovIso = G.hovered && G.hovered.iso;
                buildEurope(feats);
                G.selected = selIso ? G.byIso[selIso] || null : null;
                G.hovered = hovIso ? G.byIso[hovIso] || null : null;
                var n = G.eu.filter(function (d) { return d.fromShp; }).length;
                console.info('[DetectLab] Globe gate: refined ' + n + '/' + G.eu.length + ' countries from the 10m shapefile.');
                render(1);
                refreshCountryBoundsLayer();   // redraw the outline with the finer shape
            })
            .catch(function (err) {
                console.info('[DetectLab] Globe gate: 10m shapefile not available (' + (err && err.message) + '); keeping the 50m outlines.');
            });
    }

    /* ── Module state & DOM refs ── */
    var state = {
        leafletMap: null,
        readyPromise: null,
        globeFailed: false,
        locked: false,          // is the working map pinned to a country right now?
        fitZoom: null,          // the zoom the current country view opens at
        baseMinZoom: null,      // the map's own zoom range, remembered once
        baseMaxZoom: null,
        boundsLayer: null       // the country outline/bbox drawn on the Leaflet map
    };

    var els = {};
    function cacheEls() {
        els.root = document.getElementById('globeGate');
        els.canvas = document.getElementById('globeGateCanvas');
        els.loading = document.getElementById('globeGateLoading');
        els.error = document.getElementById('globeGateError');
        els.errorText = document.getElementById('globeGateErrorText');
        els.retryBtn = document.getElementById('globeGateRetryBtn');
        els.hint = document.getElementById('globeGateHint');
        els.closeBtn = document.getElementById('globeGateCloseBtn');
        els.reopenBtn = document.getElementById('globeGateReopenBtn');
        els.fallbackWrap = document.getElementById('globeGateFallback');
        els.fallbackSelect = document.getElementById('globeGateFallbackSelect');
        els.fallbackBtn = document.getElementById('globeGateFallbackBtn');
        els.zoomIn = document.getElementById('globeGateZoomIn');
        els.zoomOut = document.getElementById('globeGateZoomOut');
        els.attrib = document.getElementById('globeGateAttrib');
        setAttribution();
    }

    function showLoading(show) { if (els.loading) els.loading.classList.toggle('hidden', !show); }
    function showError(show, msg) {
        if (els.error) els.error.classList.toggle('hidden', !show);
        if (show && els.errorText && msg) els.errorText.textContent = msg;
    }
    function showHint(text, strong) {
        if (!els.hint) return;
        els.hint.textContent = text || '';
        els.hint.classList.toggle('show', !!text);
        els.hint.style.borderColor = strong ? '#39ff14' : '';
    }
    function hideHint() { if (els.hint) els.hint.classList.remove('show'); }

    function populateFallbackSelect() {
        if (!els.fallbackSelect || els.fallbackSelect.options.length) return;
        var codes = Object.keys(NAMES).sort(function (a, b) {
            return displayName(a, NAMES[a].en).localeCompare(displayName(b, NAMES[b].en));
        });
        codes.forEach(function (iso) {
            var opt = document.createElement('option');
            opt.value = iso;
            opt.textContent = displayName(iso, NAMES[iso].en);
            els.fallbackSelect.appendChild(opt);
        });
    }

    /* ── Gate open/close orchestration ── */
    function buildCanvas() {
        if (G.canvas || !els.canvas) return;
        var cv = document.createElement('canvas');
        cv.className = 'globe-gate-cv';
        cv.setAttribute('aria-label', 'Interactive globe');
        els.canvas.appendChild(cv);
        G.canvas = cv;
        G.ctx = cv.getContext('2d');
        wireCanvasEvents();
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { resizeNow(); }).observe(els.canvas);
        } else {
            window.addEventListener('resize', resizeNow);
        }
    }

    function ensureReady() {
        if (state.readyPromise) return state.readyPromise;
        showError(false);
        if (els.fallbackWrap) els.fallbackWrap.classList.add('hidden');
        showLoading(true);

        state.readyPromise = loadLibraries()
            .then(loadAtlas)
            .then(function () {
                buildEurope(null);
                if (!G.eu.length) throw new Error('no European countries in the dataset');
                buildCanvas();
                if (!G.ctx) throw new Error('canvas 2d context unavailable');
                state.globeFailed = false;
                showLoading(false);
                resizeNow();
                render(1);
                // Imagery is fetched only while the gate is on screen; a
                // background prefetch() for the dock does not touch the tiles.
                if (gateVisible()) startImagery();
                refineFromShapefile();
                // A selection restored from storage drew the bbox rectangle —
                // now that geometry exists, upgrade it to the country outline.
                refreshCountryBoundsLayer();
            })
            .catch(function (err) {
                // The gate must never hard-lock the app: fall back to a plain
                // country <select> built from the static name table.
                console.warn('[DetectLab] Globe gate: canvas globe unavailable, using the list fallback.', err && err.message);
                state.globeFailed = true;
                showLoading(false);
                populateFallbackSelect();
                if (els.fallbackWrap) els.fallbackWrap.classList.remove('hidden');
            });
        return state.readyPromise;
    }

    function openGate() {
        if (!els.root) return;
        els.root.classList.remove('hidden', 'is-leaving');
        els.root.setAttribute('aria-hidden', 'false');
        if (document.documentElement) document.documentElement.classList.add('globe-gate-open');
        if (els.closeBtn) els.closeBtn.style.display = hasSelection() ? '' : 'none';
        setMapControlsHidden(true);
        G.selected = null;
        G.flying = false;
        ensureReady().then(function () {
            if (!state.globeFailed) {
                startImagery();
                window.requestAnimationFrame(function () {
                    resizeNow();
                    G.spinEnabled = true;
                    startSpinLoop();
                });
            }
        });
    }

    function closeGate(revealControls) {
        if (!els.root) return;
        els.root.classList.add('is-leaving');
        stopSpinLoop();
        G.spinEnabled = false;
        hideHint();
        window.setTimeout(function () {
            els.root.classList.add('hidden');
            els.root.classList.remove('is-leaving');
            els.root.setAttribute('aria-hidden', 'true');
            if (document.documentElement) document.documentElement.classList.remove('globe-gate-open');
        }, 420);
        if (revealControls && hasSelection()) setMapControlsHidden(false);
    }

    function wireChrome() {
        if (els.closeBtn) {
            els.closeBtn.addEventListener('click', function () { closeGate(true); });
        }
        if (els.reopenBtn) {
            els.reopenBtn.addEventListener('click', function () { openGate(); });
        }
        if (els.retryBtn) {
            els.retryBtn.addEventListener('click', function () {
                state.readyPromise = null;
                openGate();
            });
        }
        if (els.zoomIn) els.zoomIn.addEventListener('click', function () { G.spinEnabled = false; setZoom(G.k * 1.3); });
        if (els.zoomOut) els.zoomOut.addEventListener('click', function () { G.spinEnabled = false; setZoom(G.k / 1.3); });
        if (els.fallbackBtn) {
            els.fallbackBtn.addEventListener('click', function () {
                var iso = els.fallbackSelect && els.fallbackSelect.value;
                if (!iso) return;
                var entry = G.byIso[iso];
                var bbox = (entry && entry.bboxEU) || null;
                var name = displayName(iso, (entry && entry.name) || NAMES[iso].en);
                if (!bbox) {
                    var c = APPROX_CENTER[iso] || [15, 48, 6];
                    var pad = 0.6;
                    bbox = [c[0] - pad, c[1] - pad, c[0] + pad, c[1] + pad];
                }
                finishSelection(iso, name, bbox);
            });
        }
        document.addEventListener('detectlab:langchange', function () {
            if (els.fallbackSelect) {
                els.fallbackSelect.innerHTML = '';
                populateFallbackSelect();
            }
            if (gateVisible()) render(1);
        });
    }

    function evaluateAuthState(user) {
        if (!user) { closeGate(false); return; }
        if (!hasSelection()) openGate();
    }

    var attached = false;
    function attach(leafletMap) {
        cacheEls();
        if (!els.root) return;
        state.leafletMap = leafletMap || state.leafletMap;
        if (!attached) {
            attached = true;
            wireChrome();

            var stored = readStoredSelection();
            if (stored) {
                applySelection(stored.iso, stored.name, stored.bbox);
            } else {
                setMapControlsHidden(true);
            }

            window.addEventListener('detectlab:authchange', function (e) {
                var user = (e.detail && e.detail.user) || (typeof window._authUser === 'function' ? window._authUser() : null);
                evaluateAuthState(user);
            });

            // Covers the (rare) case where auth state was already resolved
            // before this script ran — e.g. a fast cached session.
            if (typeof window._authUser === 'function') {
                var immediateUser = window._authUser();
                if (immediateUser) evaluateAuthState(immediateUser);
            }
        } else if (leafletMap && hasSelection()) {
            restrictLeafletToCountry(leafletMap, window._detectlabCountryBounds);
        }
    }

    window.DetectLabGlobeGate = {
        attach: attach,
        open: openGate,
        close: function () { closeGate(true); },
        hasSelection: hasSelection,
        reset: function () {
            clearStoredSelection();
            unlockCountryView();
            window._detectlabSelectedCountry = null;
            window._detectlabSelectedCountryName = null;
            window._detectlabCountryBounds = null;
            document.documentElement.classList.remove('country-selected');
            if (document.body) document.body.classList.remove('country-selected');
        },
        getSelection: function () {
            return hasSelection() ? { iso: window._detectlabSelectedCountry, name: window._detectlabSelectedCountryName, bbox: window._detectlabCountryBounds } : null;
        },

        /* ── Country switching & locked view (js/country-dock.js) ── */
        listCountries: listCountries,          // [{iso, code, name, en, ro, bbox}]
        nameOf: nameOf,                        // iso → localised name
        selectCountry: selectCountryByIso,     // iso → Promise (no globe needed)
        prefetch: prefetch,                    // warm atlas/geometry in the background
        isLocked: function () { return !!state.locked; },
        getLockZoom: function () { return state.fitZoom; },
        unlock: unlockCountryView,
        exitView: exitView,

        // Internal hooks for the node test-suite (test-globe-canvas-picker.js).
        // Not part of the public contract.
        _test: {
            G: G,
            NAMES: NAMES,
            NAME_TO_ISO: NAME_TO_ISO,
            normalizeName: normalizeName,
            buildEurope: buildEurope,
            pick: pick,
            getProj: getProj,
            displayName: displayName,
            draw: draw,
            drawBase: drawBase,
            state: state,
            // basemap imagery (same tiles as the working map's globe)
            imagery: tiles,
            IMAGERY_URL: IMAGERY_URL,
            IMAGERY_BACKGROUND: IMAGERY_BACKGROUND,
            IMAGERY_ATTRIBUTION: IMAGERY_ATTRIBUTION,
            FALLBACK_ATTRIBUTION: FALLBACK_ATTRIBUTION,
            setAttribution: setAttribution,
            els: els,
            IMAGERY_MAX_TILES: IMAGERY_MAX_TILES,
            IMAGERY_PIN_Z: IMAGERY_PIN_Z,
            tileKey: tileKey,
            tileUrl: tileUrl,
            getTile: getTile,
            tileData: tileData,
            mercY: mercY,
            latFromMercY: latFromMercY,
            bandCos: bandCos,
            imageryZoomFor: imageryZoomFor,
            viewCoverage: viewCoverage,
            imageryTileRange: imageryTileRange,
            planImagery: planImagery,
            chooseImageryRange: chooseImageryRange,
            buildImageryGrid: buildImageryGrid,
            sampleImagery: sampleImagery,
            startImagery: startImagery,
            disableImagery: disableImagery,
            approxBbox: approxBbox,
            listCountries: listCountries,
            restrictLeafletToCountry: restrictLeafletToCountry,
            unlockCountryView: unlockCountryView,
            showCountryBoundsLayer: showCountryBoundsLayer,
            removeCountryBoundsLayer: removeCountryBoundsLayer,
            refreshCountryBoundsLayer: refreshCountryBoundsLayer,
            BOUNDS_PANE: BOUNDS_PANE,
            BOUNDS_PANE_Z: BOUNDS_PANE_Z,
            LOCK_PAD: LOCK_PAD,
            LOCK_ZOOM_SLACK: LOCK_ZOOM_SLACK,
            FIT_MAX_ZOOM: FIT_MAX_ZOOM
        }
    };
})(window, document);
