/*
 * js/danish-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · the Danish layers (Denmark)
 *
 * What this file does — and what it deliberately does not do
 *   It reads js/danish-layers.config.js and turns every `enabled:true` entry
 *   into a panel row, a Leaflet layer and an entry in the shared registry.
 *   It holds no data of its own: a new Danish layer, another orthophoto year,
 *   a different upstream is a change in the CONFIG file only.
 *
 * Panel behaviour — the same row style as the other countries (Romania's
 * free rows are the template):
 *   • every Danish row is a glass sublayer row with the title on the left,
 *     the pill on/off switch (`.apm-toggle-switch` + `.apm-toggle-track`)
 *     on the right, then an “Opacity” line carrying the ⓘ info button and
 *     the percentage badge, and its own `.transp-slider` opacity slider —
 *     including the historical sheets, the orthophoto years and DTK25,
 *     which used to be radio “base maps” without a slider;
 *   • rows are grouped exactly like the other free catalogues: the four
 *     Danish LiDAR overlays sit in the shared LiDAR accordion (after the
 *     global “Hillshade LiDAR derivate” row), and Heritage, Historical maps
 *     and Ortophoto are Romania-style sections — a `.transp-layer-row`
 *     header with an expand chevron and a master on/off switch over a
 *     bordered `…SubLayers` column. There is no “Base map” section any
 *     more, and only the layers in `CONFIG.panelGroups` are rendered; the
 *     remaining catalogue entries (the spring-orthophoto years, the Danish
 *     OSM base) stay available to the proxy, the registry and the API but
 *     have no panel row, so a stored preference can never resurrect a
 *     layer the visitor cannot switch off;
 *   • every rendered layer is an independent overlay: switches combine
 *     freely and each slider blends its own sheet over the basemap, exactly
 *     like the Romanian historical sublayers. (The unrendered catalogue
 *     bases keep their old mutually-exclusive behaviour if the API
 *     activates them.) Danish layers are never mirrored into the ArcGIS
 *     basemap control (which only shows Imagery, Topographic and Terrain);
 *   • rows are keyboard-operable (real checkbox/range inputs, so Tab +
 *     Space + arrows work) and the group row carries aria-expanded /
 *     aria-hidden where the country filter needs them.
 *
 * Laziness
 *   Nothing is requested until a row is switched on: the layer object is built
 *   on first activation, Leaflet creates the tiles only once it is on the map,
 *   and the heritage WFS is queried per `moveend` (debounced, cancellable) and
 *   only above the layer's minZoom. A provider that would answer with a
 *   ServiceException is asked exactly one GetCapabilities first, so a missing
 *   credential never turns into a blank basemap.
 *
 * Credentials
 *   Credentialed Dataforsyningen/Datafordeler WMS layers use same-origin
 *   proxy routes, which append credentials server-side. This file never reads
 *   or embeds a secret. The browser shows a generic server-configuration notice
 *   and never receives missing variable names or credential values.
 *
 * Failure handling
 *   A configuration error (HTTP 503) is explained generically in the row, and
 *   DTK25 falls back to the public OpenStreetMap base map, so a Danish visitor
 *   is never left with an empty basemap. Real tile errors surface the panel's
 *   own notice through the row status line.
 */
(function (window, document) {
    'use strict';

    var CONFIG = window.DANISH_LAYERS_CONFIG || window.DANISH_LAYERS;
    if (!CONFIG || !Array.isArray(CONFIG.layers) || !CONFIG.layers.length) {
        if (window.console) {
            window.console.warn('[DanishLayers] js/danish-layers.config.js is missing — ' +
                'the Danish layers are not available.');
        }
        return;
    }

    /* ── constants ────────────────────────────────────────────────────────── */

    var LAYERS = CONFIG.enabledLayers();
    /* The panel renders only the free catalogue in CONFIG.panelGroups
     * (LiDAR, Heritage, Historical maps, Ortophoto). Everything else in the
     * config — the spring-orthophoto selector years, the Danish OSM base —
     * is catalogue/proxy data without a row: it is never built into the
     * panel and never restored from a stored preference. */
    var PANEL_GROUP_IDS = {};
    (CONFIG.panelGroups || []).forEach(function (group) { PANEL_GROUP_IDS[group.id] = true; });
    function isPanelLayer(layer) {
        return !!(layer && layer.panelGroup && PANEL_GROUP_IDS[layer.panelGroup]);
    }
    var PANEL_LAYERS = LAYERS.filter(isPanelLayer);
    var GROUP_ROW_ID = 'danishRow';
    var SUB_CONTAINER_ID = 'danishSubLayers';
    var GROUP_NOTICE_ID = 'danishGroupNotice';
    var STORE_KEY = 'detectlab_danish_layers_v1';

    /* Panes. The app's own basemap stack lives on `pane_satellite` (z398), so a
     * Danish base map paints at 399 — above it, below every existing data pane
     * (OSM places 401, LiDAR 610, historical 640+). Raster overlays sit just
     * above the base maps; vectors need their own pane because they receive
     * clicks for their popups. */
    var PANE_BASE = 'pane_danish_base';
    var PANE_RASTER = 'pane_danish_raster';
    var PANE_VECTOR = 'pane_danish_vector';
    var Z_BASE = 399;
    var Z_RASTER = 406;
    var Z_VECTOR = 408;

    var WFS_DEBOUNCE_MS = 450;

    /* The map variable, the way every other module in this repo finds it. */
    function getMap() {
        return window._dlMap || window.map || null;
    }

    /* ── language ─────────────────────────────────────────────────────────── */

    function lang() {
        try {
            if (typeof window._currentLang === 'function') return String(window._currentLang() || 'en');
        } catch (e) { /* private mode / translations not loaded yet */ }
        var htmlLang = document.documentElement && document.documentElement.getAttribute('lang');
        return String(htmlLang || 'en');
    }
    function isDa() {
        return lang().toLowerCase().indexOf('da') === 0;
    }
    /* Danish in the Danish UI, English everywhere else — the app's own rule
     * (every dictionary is merged over translations.en). */
    function tr(pair) {
        if (!pair) return '';
        if (typeof pair === 'string') return pair;
        return isDa() ? (pair.da || pair.en || '') : (pair.en || pair.da || '');
    }

    /* The few labels this module generates itself. Everything static in the
     * group markup (title, switch titles) lives in index.html with data-key
     * attributes and therefore travels through js/translations.js. */
    var TEXT = {
        toggle: { da: 'Slå til eller fra', en: 'Toggle' },
        layerInfo: { da: 'Laginfo', en: 'Layer info' },
        expand: { da: 'Udvid/skjul underlag', en: 'Expand/Collapse sublayers' },
        opacity: { da: 'Gennemsigtighed', en: 'Opacity' },
        needsToken: {
            da: 'Serveren har ikke konfigureret legitimationsoplysninger til dette kortlag.',
            en: 'The server has not configured credentials for this map layer.'
        },
        needsCredentials: {
            da: 'Serveren har ikke konfigureret legitimationsoplysninger til dette kortlag.',
            en: 'The server has not configured credentials for this map layer.'
        },
        proxyMissing: {
            da: 'Ingen proxy her — kortet hentes direkte fra kilden (kun lokal visning).',
            en: 'No proxy here — the map is fetched directly from the source (local preview only).'
        },
        directFailed: {
            da: 'Kilden kan ikke nås fra browseren. Kør serveren med miljøvariablerne for at se dette kort.',
            en: 'The source cannot be reached from the browser. Run the server with the environment variables to see this map.'
        },
        fallbackToOsm: {
            da: 'DTK25 er ikke konfigureret på serveren endnu — viser OpenStreetMap i stedet.',
            en: 'DTK25 is not configured on the server yet — showing OpenStreetMap instead.'
        },
        zoomIn: {
            da: 'Zoom ind for at se fredede fortidsminder (fra zoom',
            en: 'Zoom in to see scheduled ancient monuments (from zoom'
        },
        loading: { da: 'Indlæser…', en: 'Loading…' },
        noFeatures: { da: 'Ingen fredede fortidsminder i visningen', en: 'No scheduled monuments in this view' },
        features: { da: 'fortidsminder', en: 'monuments' },
        truncated: {
            da: 'kun de første vises — zoom ind for resten',
            en: 'only the first ones are shown — zoom in for the rest'
        },
        unavailable: { da: 'kilden svarer ikke', en: 'the source is not answering' },
        missingCredentials: {
            da: 'Kortlaget er ikke konfigureret på serveren endnu.',
            en: 'This map layer is not configured on the server yet.'
        }
    };

    /* ── state ────────────────────────────────────────────────────────────── */

    var runtime = {
        ready: false,
        map: null,
        panes: false,
        built: {},          /* id → Leaflet layer                 */
        mode: {},           /* id → 'proxy' | 'direct'            */
        selected: null,     /* id of the selected Danish base map */
        active: {},         /* id → true when it is on the map     */
        opacity: {},        /* id → 0–100                          */
        rows: {},           /* id → { row, input, slider, pct, status } */
        groupRows: {},      /* panelGroup id → { row, body, master, icon, button } */
        expandedGroups: {}, /* panelGroup id → true when its section is unfolded */
        expanded: true,
        wfs: { timer: null, controller: null, running: false, dirty: false, last: '', layer: null },
        notices: {},        /* id → { text, kind }                 */
        guard: {}           /* id → 'unknown' | 'ok' | 'unconfigured' | 'absent' */
    };

    var MASTER_ID = 'danishToggle';

    function persisted() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function save() {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify({
                active: runtime.active,
                opacity: runtime.opacity,
                selected: runtime.selected,
                expanded: runtime.expanded
            }));
        } catch (e) { /* private mode: the choice just is not remembered */ }
    }

    function applyStored() {
        var saved = persisted() || {};
        var savedActive = saved.active || {};
        var savedOpacity = saved.opacity || {};
        var defaultBase = null;
        LAYERS.forEach(function (layer) {
            runtime.opacity[layer.id] = Math.round(
                typeof layer.opacity === 'number' ? layer.opacity * 100 : 100
            );
            if (typeof savedOpacity[layer.id] === 'number') runtime.opacity[layer.id] = savedOpacity[layer.id];
            if (typeof savedActive[layer.id] === 'boolean') runtime.active[layer.id] = savedActive[layer.id];
            if (layer.group === 'base' && layer.defaultOn && !defaultBase) defaultBase = layer;
        });
        /* Exactly one Danish base map is on by default (config `defaultOn`). */
        runtime.selected = defaultBase ? defaultBase.id : null;
        LAYERS.forEach(function (layer) {
            if (layer.group === 'base' && defaultBase && layer.id !== defaultBase.id) {
                if (typeof savedActive[layer.id] !== 'boolean') runtime.active[layer.id] = false;
            }
        });
        if (defaultBase && typeof savedActive[defaultBase.id] !== 'boolean') {
            runtime.active[defaultBase.id] = true;
        }
        /* A rendered overlay may also start on (DTK25, now a Historical-maps
         * overlay): honour `defaultOn` whenever the visitor has no stored
         * choice for it. Layers without a panel row are never restored — a
         * preference saved by an older build (the Danish OSM base, a spring
         * orthophoto year) must not switch on a layer that no longer has a
         * switch to turn it back off with. */
        LAYERS.forEach(function (layer) {
            if (!isPanelLayer(layer)) { runtime.active[layer.id] = false; return; }
            if (layer.group !== 'base' && layer.defaultOn &&
                typeof savedActive[layer.id] !== 'boolean') {
                runtime.active[layer.id] = true;
            }
        });
        if (saved.selected && CONFIG.byId(saved.selected)) runtime.selected = saved.selected;
        if (!runtime.selected) {
            var firstBase = LAYERS.filter(function (l) { return l.group === 'base'; })[0];
            runtime.selected = firstBase ? firstBase.id : null;
        }
        if (typeof saved.expanded === 'boolean') runtime.expanded = saved.expanded;
    }

    /* ── Leaflet helpers ──────────────────────────────────────────────────── */

    function ensurePanes(map) {
        if (runtime.panes || !map) return;
        if (!map.getPane(PANE_BASE)) {
            map.createPane(PANE_BASE);
            map.getPane(PANE_BASE).style.zIndex = Z_BASE;
            /* A basemap must not swallow drags, clicks or pinch gestures. */
            map.getPane(PANE_BASE).style.pointerEvents = 'none';
        }
        if (!map.getPane(PANE_RASTER)) {
            map.createPane(PANE_RASTER);
            map.getPane(PANE_RASTER).style.zIndex = Z_RASTER;
            map.getPane(PANE_RASTER).style.pointerEvents = 'none';
        }
        if (!map.getPane(PANE_VECTOR)) {
            map.createPane(PANE_VECTOR);
            map.getPane(PANE_VECTOR).style.zIndex = Z_VECTOR;
        }
        runtime.panes = true;
    }

    function fraction(id) {
        var pct = runtime.opacity[id];
        if (typeof pct !== 'number') pct = 100;
        return Math.max(0, Math.min(1, pct / 100));
    }

    /* A layer's URL decides how it is fetched: a same-origin path goes through
     * this deployment's proxy, an absolute URL straight to the provider. */
    function modeFor(layer) {
        return String(layer.url || '').indexOf('/') === 0 ? 'proxy' : 'direct';
    }

    function proxyProbeUrl(layer) {
        return layer.url + (layer.url.indexOf('?') === -1 ? '?' : '&') +
            'service=WMS&request=GetCapabilities&version=' + (layer.version || '1.3.0');
    }

    /* Does the deployment answer the proxy route (and is it configured)? 503 →
     * the route exists but server credentials are unavailable. 404/403/network →
     * there is no usable proxy at this origin (for example, a static preview). */
    function probeProxy(layer, done) {
        var cached = runtime.guard[layer.id];
        if (cached && cached !== 'unknown') { done(cached); return; }
        var settled = false;
        function finish(state) {
            if (settled) return;
            settled = true;
            runtime.guard[layer.id] = state;
            done(state);
        }
        var timer = window.setTimeout(function () { finish('absent'); }, 6000);
        try {
            window.fetch(proxyProbeUrl(layer), { method: 'GET', credentials: 'same-origin' })
                .then(function (response) {
                    window.clearTimeout(timer);
                    if (response.status === 503) return finish('unconfigured');
                    if (response.ok) return finish('ok');
                    return finish('absent');
                })
                .catch(function () {
                    window.clearTimeout(timer);
                    finish('absent');
                });
        } catch (e) {
            window.clearTimeout(timer);
            finish('absent');
        }
    }

    function buildTileLayer(layer, mode) {
        var common = {
            minZoom: layer.minZoom || 0,
            maxZoom: layer.maxZoom || 19,
            opacity: fraction(layer.id),
            attribution: layer.attribution,
            crossOrigin: false
        };
        if (typeof layer.maxNativeZoom === 'number') common.maxNativeZoom = layer.maxNativeZoom;
        if (layer.type === 'xyz') {
            common.pane = PANE_BASE;
            return L.tileLayer(layer.url, common);
        }
        var options = {
            layers: layer.layers,
            styles: '',
            format: layer.format,
            transparent: layer.transparent ? 'TRUE' : 'FALSE',
            version: layer.version || '1.3.0',
            tileSize: layer.tileSize || 256,
            pane: layer.group === 'base' ? PANE_BASE : PANE_RASTER,
            /* The requested request format: WMS 1.3.0, CRS=EPSG:3857, PNG,
             * 256×256, TILED — with the uppercase KVP names of the 1.3.0 spec. */
            uppercase: true,
            tiled: 'TRUE'
        };
        Object.keys(common).forEach(function (key) { options[key] = common[key]; });
        var url = layer.url;
        /* Built with the constructor, not the L.tileLayer.wms *factory*: the
         * availability guard (js/wms-health.js) wraps that factory, and these
         * rows must stay under this module's control — a guard trip would flip
         * the very switch that drives the state machine here. The layers carry
         * `_detectlabNoGuard` so the guard's map hook skips them as well; the
         * host of the public one is still listed in the guard's HOSTS map, and
         * the audit records the opt-out on the definition itself
         * (guard:false + selfGuardedReason). See DATA_SOURCES.md §Guard. */
        return new L.TileLayer.WMS(url, options);
    }

    /* The heritage polygons have no tile opacity: the row's slider scales
     * the stroke/fill opacity of the vector style instead, so the Heritage
     * slider does the same visible job as every raster row's slider. */
    function wfsStyle(layer) {
        var style = (layer.wfs && layer.wfs.style) || {};
        var scale = fraction(layer.id);
        return {
            color: style.color || '#ffd166',
            weight: style.weight || 1.6,
            opacity: (style.opacity === undefined ? 0.95 : style.opacity) * scale,
            fillColor: style.fillColor || '#ffb703',
            fillOpacity: (style.fillOpacity === undefined ? 0.28 : style.fillOpacity) * scale
        };
    }

    function buildWfsLayer(layer) {
        return L.geoJSON(null, {
            pane: PANE_VECTOR,
            style: function () { return wfsStyle(layer); },
            onEachFeature: function (feature, featureLayer) {
                featureLayer.bindPopup(popupHtml(layer, feature));
            }
        });
    }

    function escapeHtml(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function popupHtml(layer, feature) {
        var popup = (layer.wfs && layer.wfs.popup) || {};
        var props = (feature && feature.properties) || {};
        var rows = (popup.fields || []).map(function (field) {
            if (props[field] === undefined || props[field] === '') return '';
            return '<div><span style="opacity:0.6">' + escapeHtml(field) + ':</span> ' +
                '<strong>' + escapeHtml(props[field]) + '</strong></div>';
        }).join('');
        var link = '';
        if (popup.linkField && props[popup.linkField]) {
            link = '<div style="margin-top:5px"><a href="' + escapeHtml(props[popup.linkField]) +
                '" target="_blank" rel="noopener">' + escapeHtml(tr(popup.linkLabel) || 'Open') + '</a></div>';
        }
        return '<div style="min-width:150px">' +
            '<div style="font-weight:600;margin-bottom:3px">' + escapeHtml(tr(layer.title)) + '</div>' +
            rows + link +
            '<div style="margin-top:5px;font-size:0.68rem;opacity:0.55">' +
            escapeHtml(layer.provider || '') + '</div></div>';
    }

    /* ── the heritage WFS: one bbox query per view, debounced ─────────────── */

    function wfsLayers() {
        return LAYERS.filter(function (layer) { return layer.type === 'wfs'; });
    }

    function wfsQueryUrl(layer, bbox) {
        var max = (layer.wfs && layer.wfs.maxFeatures) || 400;
        return layer.url + '?bbox=' + bbox.join(',') + '&layer=' + encodeURIComponent(layer.id) +
            '&maxFeatures=' + max;
    }

    /* The no-backend variant: the official service answers WFS 2.0.0 with a
     * degrees bbox and returns EPSG:4326 GeoJSON, so the browser needs no
     * reprojection plugin (verified against the live service — DATA_SOURCES.md). */
    function wfsDirectUrl(layer, bbox) {
        var direct = layer.directFallback;
        if (!direct) return '';
        var version = direct.version || '2.0.0';
        var max = (layer.wfs && layer.wfs.maxFeatures) || 400;
        return direct.url +
            '?service=WFS&version=' + version +
            '&request=GetFeature' +
            '&typeNames=' + encodeURIComponent(direct.typeName || layer.layers) +
            '&outputFormat=application/json' +
            '&srsName=EPSG:4326' +
            '&bbox=' + bbox.join(',') + ',EPSG:4326' +
            (version === '2.0.0' ? '&count=' : '&maxFeatures=') + max;
    }

    function renderWfs(layer, collection) {
        var built = runtime.built[layer.id];
        if (!built) return;
        built.clearLayers();
        if (collection && collection.features && collection.features.length) built.addData(collection);
        var shown = collection && collection.features ? collection.features.length : 0;
        var total = collection && typeof collection.totalFeatures === 'number'
            ? collection.totalFeatures : shown;
        var message;
        if (!shown) {
            message = tr(TEXT.noFeatures);
        } else {
            message = shown + ' ' + tr(TEXT.features);
            if (collection && (collection.truncated || total > shown)) {
                message += ' · ' + tr(TEXT.truncated);
            }
        }
        setStatus(layer.id, message, 'info');
    }

    function refreshWfs(force) {
        wfsLayers().forEach(function (layer) {
            if (runtime.active[layer.id]) refreshOneWfs(layer, force);
        });
    }

    function refreshOneWfs(layer, force) {
        var map = runtime.map;
        if (!map || !runtime.active[layer.id]) return;
        if (map.getZoom() < (layer.minZoom || 0)) {
            var built = runtime.built[layer.id];
            if (built) built.clearLayers();
            setStatus(layer.id, tr(TEXT.zoomIn) + ' ' + (layer.minZoom || 0) + ')', 'info');
            runtime.wfs.last = '';
            return;
        }
        if (runtime.wfs.running && !force) {
            runtime.wfs.dirty = true;
            return;
        }
        var bounds = map.getBounds();
        var bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
            .map(function (v) { return Math.round(v * 1e6) / 1e6; });
        var key = bbox.join(',');
        if (!force && key === runtime.wfs.last) return;
        runtime.wfs.last = key;
        runtime.wfs.running = true;
        runtime.wfs.layer = layer;
        setStatus(layer.id, tr(TEXT.loading), 'info');

        if (runtime.wfs.controller && runtime.wfs.controller.abort) {
            try { runtime.wfs.controller.abort(); } catch (e) {}
        }
        var controller = (typeof window.AbortController === 'function') ? new window.AbortController() : null;
        runtime.wfs.controller = controller;
        var options = controller ? { signal: controller.signal } : {};

        function finish() {
            runtime.wfs.running = false;
            if (runtime.wfs.dirty) {
                runtime.wfs.dirty = false;
                refreshOneWfs(layer, true);
            }
        }

        function fallbackToDirect() {
            var url = wfsDirectUrl(layer, bbox);
            if (!url) { setStatus(layer.id, tr(TEXT.unavailable), 'error'); finish(); return; }
            runtime.mode[layer.id] = 'direct';
            window.fetch(url, options)
                .then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                })
                .then(function (collection) { renderWfs(layer, collection); finish(); })
                .catch(function (error) {
                    if (error && error.name === 'AbortError') { finish(); return; }
                    setStatus(layer.id, tr(TEXT.directFailed), 'error');
                    finish();
                });
        }

        window.fetch(wfsQueryUrl(layer, bbox), options)
            .then(function (response) {
                if (response.ok) {
                    runtime.mode[layer.id] = 'proxy';
                    return response.json();
                }
                if (response.status === 404 || response.status === 501 ||
                    response.status === 502 || response.status === 503) {
                    fallbackToDirect();
                    return null;
                }
                throw new Error('HTTP ' + response.status);
            })
            .then(function (collection) {
                if (!collection) return;              /* the fallback took over */
                renderWfs(layer, collection);
                finish();
            })
            .catch(function (error) {
                if (error && error.name === 'AbortError') { finish(); return; }
                setStatus(layer.id, tr(TEXT.unavailable), 'error');
                finish();
            });
    }

    function scheduleWfs() {
        if (runtime.wfs.timer) window.clearTimeout(runtime.wfs.timer);
        runtime.wfs.timer = window.setTimeout(function () {
            runtime.wfs.timer = null;
            refreshWfs(false);
        }, WFS_DEBOUNCE_MS);
    }

    /* ── activation ───────────────────────────────────────────────────────── */

    /* The rows report their own failures: a provider that stops answering shows
     * up in the status line under its switch instead of leaving a silently blank
     * layer. (The site-wide availability guard js/wms-health.js is deliberately
     * not used here — it flips the very switch that drives this module's state,
     * and a base map must never switch itself off; see DATA_SOURCES.md.) */
    function watchTiles(layer, built) {
        var state = { fails: 0, loaded: 0, reported: false };
        built.on('tileload', function () { state.loaded += 1; });
        built.on('tileerror', function () {
            state.fails += 1;
            if (state.reported || state.loaded > 0 || state.fails < 3) return;
            state.reported = true;
            setStatus(layer.id, tr(TEXT.unavailable), 'error');
        });
    }

    function build(layer) {
        if (runtime.built[layer.id]) return runtime.built[layer.id];
        var mode = runtime.mode[layer.id] || modeFor(layer);
        var built = layer.type === 'wfs' ? buildWfsLayer(layer) : buildTileLayer(layer, mode);
        if (layer.type !== 'wfs') watchTiles(layer, built);
        /* Naming the definition lets the availability guard and the diagnostics
         * talk about this layer instead of a hostname. */
        try {
            built._dlDefId = 'danish.' + layer.id;
            built._detectlabProvider = layer.provider;
            built._detectlabUiTitle = tr(layer.title);
            built._detectlabUiKeys = ['danishToggle_' + layer.id];
            /* This module owns the row and explains its own failures. */
            built._detectlabNoGuard = true;
        } catch (e) {}
        runtime.built[layer.id] = built;
        return built;
    }

    function discard(layer) {
        var built = runtime.built[layer.id];
        if (!built) return;
        if (runtime.map && runtime.map.hasLayer(built)) runtime.map.removeLayer(built);
        delete runtime.built[layer.id];
        runtime.mode[layer.id] = null;
    }

    function activate(layer, options) {
        options = options || {};
        var map = runtime.map;
        if (!map) return;
        /* Remember the last layer switched on (`selectedBase()` kept its
         * historical name for API callers; every rendered layer is an
         * overlay now, so it simply reports the last activation). */
        runtime.selected = layer.id;
        if (layer.group === 'base') {
            /* The unrendered catalogue bases stay exclusive if the API
             * activates them: first switch the other Danish bases off. */
            LAYERS.forEach(function (other) {
                if (other.group === 'base' && other.id !== layer.id && runtime.active[other.id]) {
                    deactivate(other, {});
                }
            });
        }
        if (!runtime.active[layer.id]) {
            ensurePanes(map);
            if (!runtime.mode[layer.id]) runtime.mode[layer.id] = modeFor(layer);
            var built = build(layer);
            try { map.addLayer(built); } catch (e) { /* a broken layer must not break the map */ }
            runtime.active[layer.id] = true;
            if (layer.type === 'wfs') {
                var control = map.attributionControl;
                if (control && layer.attribution) control.addAttribution(layer.attribution);
                runtime.wfs.last = '';
                refreshOneWfs(layer, true);
            }
        }
        syncUI();
        save();
    }

    function deactivate(layer, options) {
        options = options || {};
        runtime.active[layer.id] = false;
        var built = runtime.built[layer.id];
        if (runtime.map && built && runtime.map.hasLayer(built)) runtime.map.removeLayer(built);
        if (layer.type === 'wfs') {
            var control = runtime.map && runtime.map.attributionControl;
            if (control && layer.attribution) {
                try { control.removeAttribution(layer.attribution); } catch (e) {}
            }
            if (runtime.wfs.controller && runtime.wfs.controller.abort && runtime.wfs.layer === layer) {
                try { runtime.wfs.controller.abort(); } catch (e) {}
            }
            runtime.wfs.last = '';
        }
        syncUI();
        save();
        void options;
    }

    /* The credential is missing server-side. Explain it in the row, and for a
     * base map switch to the public Danish alternative so the map is never
     * empty. */
    function handleUnconfigured(layer) {
        setStatus(layer.id, tr(TEXT.missingCredentials), 'error');
        runtime.active[layer.id] = false;
        var built = runtime.built[layer.id];
        if (runtime.map && built && runtime.map.hasLayer(built)) runtime.map.removeLayer(built);
        if (layer.group !== 'base') { syncUI(); return; }
        var alternative = null;
        LAYERS.forEach(function (other) {
            if (alternative || other.group !== 'base') return;
            if ((other.requiresCredentials || []).length) return;
            alternative = other;
        });
        if (!alternative) { syncUI(); return; }
        setNotice(tr(TEXT.fallbackToOsm));
        runtime.selected = alternative.id;
        activate(alternative, {});
    }

    /* A workstation preview: no proxy routes exist, but the page may have been
     * handed a token (Dataforsyningen) and the public WFS answers directly. */
    function tryDirectFallback(layer) {
        var wasActive = !!runtime.active[layer.id];
        discard(layer);                       /* also clears the remembered mode */
        runtime.mode[layer.id] = 'direct';     /* so build() picks the provider URL */
        runtime.active[layer.id] = false;
        setStatus(layer.id, tr(TEXT.proxyMissing), 'warn');
        if (wasActive) activate(layer, {});
        else syncUI();
    }

    /* The single entry point every row uses. It decides, once per layer, how
     * that layer can be reached here and then turns it on. */
    function switchOn(layer) {
        var map = runtime.map;
        if (!map) return;
        ensurePanes(map);
        var gated = (layer.requiresCredentials || []).length && modeFor(layer) === 'proxy';
        if (!gated) {
            activate(layer, {});
            return;
        }
        setStatus(layer.id, tr(TEXT.loading), 'info');
        probeProxy(layer, function (state) {
            if (state === 'ok') {
                setStatus(layer.id, '', 'info');
                activate(layer, {});
                return;
            }
            if (state === 'unconfigured') { handleUnconfigured(layer); return; }
            if (layer.directFallback) { tryDirectFallback(layer); return; }
            handleUnconfigured(layer);
        });
    }

    /* ── the panel ───────────────────────────────────────────────────────── */

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'text') node.textContent = attrs[key];
            else if (key === 'style') node.setAttribute('style', attrs[key]);
            else if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
    }

    function setStatus(id, text, kind) {
        runtime.notices[id] = text ? { text: text, kind: kind || 'info' } : null;
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        row.status.textContent = text || '';
        row.status.style.display = text ? 'block' : 'none';
        row.status.className = 'danish-layer-status' + (kind ? ' is-' + kind : '');
        row.status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function setNotice(text) {
        var node = document.getElementById(GROUP_NOTICE_ID);
        if (!node) return;
        node.textContent = text || '';
        node.style.display = text ? 'block' : 'none';
    }

    /* One row, the same shape as every other country's free rows — the
     * Romanian sublayers in index.html are the template:
     *
     *   ┌ title ────────────────────────── [pill on/off switch] ┐
     *   │ Opacity                              ⓘ  [ 80% ]      │
     *   │ ────────────●──────────────── (opacity slider)        │
     *   └ (status line, only when the layer has something to say)
     *
     * The switch is the shared `.apm-toggle-switch` (a real checkbox whose
     * `.apm-toggle-track` sibling paints the pill — the input must stay the
     * track's immediate predecessor for the checked CSS to bite), the
     * percentage is the shared `.pct` badge next to the shared
     * `.layer-info-btn`, and the slider is the shared `.transp-slider`
     * (LiDAR rows also carry `.lidar-country-opacity`, like their
     * neighbours in the European LiDAR accordion). EVERY Danish layer gets
     * the slider, including the opaque historical/orthophoto sheets and
     * DTK25: they are overlays now, so the slider blends them over the
     * basemap instead of replacing it. `.dl-sublayer-row` gives the row the
     * same glass box as a nested row anywhere else in the window. */
    function buildRow(layer) {
        var title = tr(layer.title);
        var isLidar = layer.panelGroup === 'lidar' || layer.id.indexOf('lidar_') === 0;
        var row = el('div', {
            class: 'danish-layer-row dl-sublayer-row is-overlay' + (isLidar ? ' lidar-country-row' : ''),
            id: 'danishRow_' + layer.id,
            'data-category': 'free',
            'data-danish-row': layer.id
        });

        var input = el('input', {
            type: 'checkbox',
            id: 'danishToggle_' + layer.id,
            name: 'danishOverlay',
            value: layer.id,
            'data-danish-input': layer.id,
            'aria-label': title
        });
        input.checked = !!runtime.active[layer.id];
        input.addEventListener('change', function () {
            if (input.checked) switchOn(layer);
            else deactivate(layer, {});
            syncUI();
        });

        var toggle = el('label', {
            class: 'apm-toggle-switch',
            title: tr(TEXT.toggle) + ' ' + title,
            style: 'transform:scale(0.85);transform-origin:right center;flex-shrink:0;'
        }, [input, el('span', { class: 'apm-toggle-track' })]);

        var head = el('div', {
            class: 'danish-layer-head',
            style: 'display:flex;align-items:center;justify-content:space-between;' +
                'font-size:0.78rem;color:rgba(245,240,235,0.75);margin-bottom:5px;gap:5px;'
        }, [
            el('span', { style: 'display:flex;align-items:center;gap:5px;min-width:0;' }, [
                el('span', { class: 'danish-layer-title', text: title })
            ]),
            toggle
        ]);
        row.appendChild(head);

        var info = el('button', {
            type: 'button',
            class: 'layer-info-btn',
            title: tr(TEXT.layerInfo),
            'aria-label': tr(TEXT.layerInfo) + ' — ' + title,
            'data-danish-info': layer.id,
            text: 'ⓘ'
        });
        info.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            showInfo(layer);
        });

        var pct = el('span', {
            class: 'pct danish-layer-pct',
            id: 'danishPct_' + layer.id,
            text: runtime.opacity[layer.id] + '%'
        });

        var opacityLine = el('div', {
            class: 'transp-layer-label',
            style: 'margin-bottom:5px;'
        }, [
            el('span', { style: 'font-size:0.72rem;opacity:0.6', text: tr(TEXT.opacity) }),
            el('span', { style: 'display:flex;align-items:center;gap:5px' }, [info, pct])
        ]);
        row.appendChild(opacityLine);

        var slider = el('input', {
            type: 'range',
            class: 'transp-slider' + (isLidar ? ' lidar-country-opacity' : ''),
            id: 'danishOpacity_' + layer.id,
            min: '0', max: '100', step: '1',
            value: String(runtime.opacity[layer.id]),
            'aria-label': tr(TEXT.opacity) + ' — ' + title
        });
        slider.addEventListener('input', function () {
            setOpacity(layer, Number(slider.value), true);
        });
        row.appendChild(slider);

        var status = el('div', {
            class: 'danish-layer-status',
            id: 'danishStatus_' + layer.id,
            role: 'status',
            style: 'display:none;padding-left:0;'
        });
        status.style.display = 'none';
        row.appendChild(status);

        runtime.rows[layer.id] = { row: row, input: input, slider: slider, pct: pct, status: status };
        var notice = runtime.notices[layer.id];
        if (notice) setStatus(layer.id, notice.text, notice.kind);
        return row;
    }

    /* The id of a group's sublayer column. It deliberately ends in
     * `SubLayers`, the suffix the window's row chrome
     * (js/layer-panel-rows.js) and the accordion helpers look for. */
    function groupSubLayersId(group) {
        return 'danish' + group.id.charAt(0).toUpperCase() + group.id.slice(1) + 'SubLayers';
    }

    function setGroupExpanded(groupId, expanded) {
        runtime.expandedGroups[groupId] = !!expanded;
        var entry = runtime.groupRows[groupId];
        if (!entry) return;
        if (entry.body) {
            entry.body.style.maxHeight = expanded ? '6000px' : '0';
            entry.body.style.opacity = expanded ? '1' : '0';
            entry.body.style.marginTop = expanded ? '8px' : '0';
        }
        if (entry.icon) entry.icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        if (entry.button) entry.button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    /* A section's master switch: on → every layer of the section on, off →
     * every layer off (the Finland section-master rule). The switch itself
     * is re-synced from the layers in syncUI(), indeterminate in between. */
    function togglePanelGroup(group, on) {
        (group.layers || []).forEach(function (id) {
            var layer = CONFIG.byId(id);
            if (!layer || layer.enabled === false) return;
            if (on) switchOn(layer);
            else if (runtime.active[layer.id]) deactivate(layer, {});
        });
        syncUI();
    }

    /* One thematic section (Heritage / Historical maps / Ortophoto) in the
     * shape of Romania's Historical Maps group: a glass `.transp-layer-row`
     * whose `.transp-layer-label` header carries the section title, an
     * expand chevron and the master `.apm-toggle-switch`, over a
     * left-bordered `…SubLayers` column of buildRow() rows. Sections start
     * collapsed, like the Romanian group. */
    function buildGroup(group) {
        var title = tr(group.title);
        var expanded = !!runtime.expandedGroups[group.id];
        var wrap = el('div', {
            class: 'transp-layer-row danish-group-row',
            'data-category': 'free',
            'data-danish-group': group.id,
            id: 'danishGroup_' + group.id
        });

        var master = el('input', {
            type: 'checkbox',
            id: 'danishGroupToggle_' + group.id,
            'aria-label': title
        });
        master.addEventListener('change', function () { togglePanelGroup(group, master.checked); });
        var masterSwitch = el('label', {
            class: 'apm-toggle-switch',
            title: tr(TEXT.toggle) + ' ' + title,
            style: 'flex-shrink:0;'
        }, [master, el('span', { class: 'apm-toggle-track' })]);

        var icon = el('span', {
            id: 'danishGroupExpandIcon_' + group.id,
            style: 'display:inline-block;transition:transform 0.25s ease;font-size:0.72rem;line-height:1;',
            text: '▾'
        });
        icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        var expandBtn = el('button', {
            type: 'button',
            id: 'danishGroupExpandBtn_' + group.id,
            title: tr(TEXT.expand),
            'aria-expanded': expanded ? 'true' : 'false',
            style: 'background:none;border:none;cursor:pointer;padding:2px 4px;' +
                'color:rgba(214,69,80,0.85);display:flex;align-items:center;'
        }, [icon]);
        expandBtn.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            setGroupExpanded(group.id, !runtime.expandedGroups[group.id]);
        });

        var head = el('div', { class: 'transp-layer-label', style: 'margin-bottom:6px' }, [
            el('span', { style: 'display:flex;align-items:center;gap:7px;min-width:0;' }, [
                el('span', { text: title })
            ]),
            el('span', { style: 'display:flex;align-items:center;gap:6px;margin-left:auto;flex-shrink:0;' },
                [expandBtn, masterSwitch])
        ]);
        wrap.appendChild(head);

        var body = el('div', {
            id: groupSubLayersId(group),
            style: 'margin-top:0;padding-left:6px;border-left:2px solid rgba(214,69,80,0.3);' +
                'display:flex;flex-direction:column;gap:8px;overflow:hidden;' +
                'transition:max-height 0.3s ease, opacity 0.3s ease, margin-top 0.3s ease;'
        });
        body.style.maxHeight = expanded ? '6000px' : '0';
        body.style.opacity = expanded ? '1' : '0';
        body.style.marginTop = expanded ? '8px' : '0';
        (group.layers || []).forEach(function (id) {
            var layer = CONFIG.byId(id);
            if (layer && layer.enabled !== false) body.appendChild(buildRow(layer));
        });
        wrap.appendChild(body);

        runtime.groupRows[group.id] = {
            row: wrap, body: body, master: master, icon: icon, button: expandBtn
        };
        syncGroupMaster(group);
        return wrap;
    }

    function syncGroupMaster(group) {
        var entry = runtime.groupRows[group.id];
        if (!entry || !entry.master) return;
        var ids = (group.layers || []).filter(function (id) {
            var layer = CONFIG.byId(id);
            return layer && layer.enabled !== false;
        });
        var onCount = ids.filter(function (id) { return !!runtime.active[id]; }).length;
        entry.master.checked = ids.length > 0 && onCount === ids.length;
        try { entry.master.indeterminate = onCount > 0 && onCount < ids.length; } catch (e) {}
    }

    function buildPanel() {
        var container = document.getElementById(SUB_CONTAINER_ID);
        if (!container) return;
        container.innerHTML = '';
        runtime.groupRows = {};
        var lidarMount = document.getElementById('danishLidarLayers');
        if (lidarMount) lidarMount.innerHTML = '';
        /* Only the panelGroups are rendered, each row once: the LiDAR group
         * goes into the shared LiDAR accordion (its mount follows the
         * global “Hillshade LiDAR derivate” row in index.html), the other
         * groups become Romania-style sections in the Denmark mount. No
         * “Base map” section, no spring-year dropdown, no Danish OSM row. */
        (CONFIG.panelGroups || []).forEach(function (group) {
            if (group.mount || group.id === 'lidar') {
                var mount = document.getElementById(group.mount || 'danishLidarLayers');
                if (!mount) return;
                (group.layers || []).forEach(function (id) {
                    var layer = CONFIG.byId(id);
                    if (layer && layer.enabled !== false) mount.appendChild(buildRow(layer));
                });
                return;
            }
            container.appendChild(buildGroup(group));
        });
        // Danish bases are intentionally NOT mirrored into the ArcGIS basemap control —
        // the control must only ever show Imagery (ArcGIS), Topographic (ArcGIS) and Terrain (ArcGIS).
        // Clean up any legacy Danish buttons that might still be in the DOM from an older build.
        try {
            var legacyControl = document.getElementById('arcgisBasemapCtrl');
            if (legacyControl) {
                Array.prototype.forEach.call(legacyControl.querySelectorAll('[data-danish-basemap]'), function (btn) {
                    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
                });
            }
        } catch (e) {}
    }

    function relabelControl() {
        // No-op: Danish titles are not mirrored into the ArcGIS basemap control any more.
        // The control only contains the three ArcGIS basemaps.
    }

    function syncUI() {
        LAYERS.forEach(function (layer) {
            var entry = runtime.rows[layer.id];
            if (!entry) return;
            var on = !!runtime.active[layer.id];
            if (entry.input && entry.input.checked !== on) entry.input.checked = on;
            if (entry.row) entry.row.classList.toggle('is-active', on);
            if (entry.slider && entry.slider.value !== String(runtime.opacity[layer.id])) {
                entry.slider.value = String(runtime.opacity[layer.id]);
            }
            if (entry.pct) entry.pct.textContent = runtime.opacity[layer.id] + '%';
        });
        (CONFIG.panelGroups || []).forEach(function (group) {
            if (!group.mount && group.id !== 'lidar') syncGroupMaster(group);
        });
        var any = LAYERS.some(function (layer) { return !!runtime.active[layer.id]; });
        var master = document.getElementById(MASTER_ID);
        if (master && master.checked !== any) master.checked = any;
        // No syncing into the ArcGIS basemap control — it only shows the three ArcGIS basemaps.
        try {
            var legacyControl2 = document.getElementById('arcgisBasemapCtrl');
            if (legacyControl2) {
                Array.prototype.forEach.call(legacyControl2.querySelectorAll('[data-danish-basemap]'), function (btn) {
                    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
                });
            }
        } catch (e2) {}
        var first = Object.keys(runtime.notices).filter(function (key) { return runtime.notices[key]; })[0];
        setNotice(first ? runtime.notices[first].text : '');
    }

    function setOpacity(layer, value, fromSlider) {
        runtime.opacity[layer.id] = Math.max(0, Math.min(100, Number(value)));
        var built = runtime.built[layer.id];
        if (built && typeof built.setOpacity === 'function') built.setOpacity(fraction(layer.id));
        if (built && layer.type === 'wfs' && typeof built.setStyle === 'function') {
            try { built.setStyle(wfsStyle(layer)); } catch (e) { /* style refresh is best-effort */ }
        }
        var entry = runtime.rows[layer.id];
        if (entry) {
            if (entry.pct) entry.pct.textContent = runtime.opacity[layer.id] + '%';
            if (entry.slider && !fromSlider && entry.slider.value !== String(runtime.opacity[layer.id])) {
                entry.slider.value = String(runtime.opacity[layer.id]);
            }
        }
        save();
    }

    function setExpanded(expanded) {
        expanded = true; // Sections are exposed directly, without a country accordion.
        runtime.expanded = !!expanded;
        var container = document.getElementById(SUB_CONTAINER_ID);
        if (container) {
            container.style.maxHeight = runtime.expanded ? '6000px' : '0';
            container.style.opacity = runtime.expanded ? '1' : '0';
            container.style.marginTop = runtime.expanded ? '8px' : '0';
        }
        var button = document.getElementById('danishExpandBtn');
        if (button) button.setAttribute('aria-expanded', runtime.expanded ? 'true' : 'false');
        var icon = document.getElementById('danishExpandIcon');
        if (icon) icon.style.transform = runtime.expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        save();
    }

    /* The info panel (`showLayerInfo` in index.html) renders the attribution as
     * *plain text and links the URLs it finds in it* and prints the description
     * through `textContent`, so neither argument may carry markup or newlines:
     * every fact is a ` · `-separated phrase in one paragraph. */
    function showInfo(layer) {
        var da = isDa();
        var title = tr(layer.title);
        var attribution = [layer.provider, layer.licence, layer.licenceUrl]
            .filter(function (part) { return !!part; }).join(' · ');
        var facts = [(da ? 'Lag: ' : 'Layer: ') + (layer.layers || layer.url)];
        if (layer.type === 'wms') {
            facts.push('WMS ' + (layer.version || '1.3.0'));
        } else if (layer.type === 'wfs') {
            facts.push('WFS ' + ((layer.wfs && layer.wfs.version) || '2.0.0') + ' GeoJSON');
        } else {
            facts.push('XYZ');
        }
        if (layer.crs && layer.crs !== 'EPSG:3857') facts.push(layer.crs);
        facts.push('zoom ' + (layer.minZoom || 0) + '–' + (layer.maxZoom || 18));
        if (layer.upstream && layer.upstream !== layer.url) facts.push(layer.upstream);
        var needs = layer.requiresCredentials || [];
        if (needs.length) facts.push(da ? 'serverlegitimationsoplysninger kræves' : 'server-side credentials required');
        if (layer.enabled === false) facts.push(da ? 'deaktiveret' : 'disabled');
        if (layer.permission && layer.permission.required) {
            facts.push((da ? 'kræver tilladelse: ' : 'permission required: ') + (layer.permission.note || ''));
        } else if (layer.permission && layer.permission.note && layer.enabled === false) {
            facts.push(layer.permission.note);
        }
        var description = facts.join(' · ');
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, attribution, description);
            return;
        }
        window.alert(title + '\n' + attribution + '\n' + description);
    }

    /* ── country filter (the rule the panel already uses) ─────────────────── */

    function filterForCountry(iso) {
        var code = String(iso || '').toUpperCase();
        var inCountry = !code || code === String(CONFIG.country || '').toUpperCase();
        Object.keys(runtime.rows).forEach(function (id) {
            var row = runtime.rows[id].row;
            if (!row) return;
            row.classList.toggle('country-layer-unavailable', !inCountry);
            row.setAttribute('aria-hidden', inCountry ? 'false' : 'true');
        });
        Object.keys(runtime.groupRows).forEach(function (id) {
            var row = runtime.groupRows[id].row;
            if (!row) return;
            row.classList.toggle('country-layer-unavailable', !inCountry);
            row.setAttribute('aria-hidden', inCountry ? 'false' : 'true');
        });
        var lidarMount = document.getElementById('danishLidarLayers');
        if (lidarMount) lidarMount.classList.toggle('country-layer-unavailable', !inCountry);
        var groupRow = document.getElementById(GROUP_ROW_ID);
        if (groupRow) {
            groupRow.classList.toggle('country-layer-unavailable', !inCountry);
            groupRow.setAttribute('aria-hidden', inCountry ? 'false' : 'true');
        }
    }

    /* ── language change ──────────────────────────────────────────────────── */

    function refreshTexts() {
        buildPanel();
        relabelControl();
        var title = document.getElementById('danishGroupTitle');
        if (title) title.textContent = tr(CONFIG.groupLabel);
        Object.keys(runtime.rows).forEach(function (id) {
            var notice = runtime.notices[id];
            if (notice) setStatus(id, notice.text, notice.kind);
        });
        wfsLayers().forEach(function (layer) {
            var built = runtime.built[layer.id];
            if (!built) return;
            try {
                built.eachLayer(function (featureLayer) {
                    if (featureLayer && featureLayer.feature) {
                        featureLayer.bindPopup(popupHtml(layer, featureLayer.feature));
                    }
                });
            } catch (e) {}
        });
    }

    /* ── map wiring ───────────────────────────────────────────────────────── */

    /* A layer that is marked on but no longer on the map (something rebuilt the
     * panes) is put back — cheap, and it never fights a real removal because a
     * switched-off row is not marked active. */
    function ensureActiveOnMap() {
        var map = runtime.map;
        if (!map) return;
        LAYERS.forEach(function (layer) {
            if (!runtime.active[layer.id]) return;
            var built = runtime.built[layer.id];
            if (built && !map.hasLayer(built)) {
                try { map.addLayer(built); } catch (e) {}
            }
        });
    }

    function onViewChange() {
        ensureActiveOnMap();
        scheduleWfs();
    }

    function wireMap(map) {
        map.on('moveend zoomend', onViewChange);
    }

    function whenMapReady(callback) {
        var map = getMap();
        if (map) { callback(map); return; }
        var tries = 0;
        var timer = window.setInterval(function () {
            tries += 1;
            var found = getMap();
            if (found) {
                window.clearInterval(timer);
                callback(found);
            } else if (tries > 240) {          /* ~1 minute, then stay dormant */
                window.clearInterval(timer);
                if (window.console) {
                    window.console.warn('[DanishLayers] no Leaflet map found — the Danish layers stay dormant.');
                }
            }
        }, 250);
    }

    function start() {
        applyStored();
        buildPanel();
        setExpanded(runtime.expanded);
        filterForCountry(window._detectlabSelectedCountry || '');
        whenMapReady(function (map) {
            runtime.map = map;
            runtime.ready = true;
            ensurePanes(map);
            wireMap(map);
            /* Restore the session. This is the first moment anything is
             * requested: rows that were off make no call at all, and layers
             * without a panel row are never restored. */
            PANEL_LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) switchOn(layer);
            });
            syncUI();
        });
    }

    document.addEventListener('detectlab:langchange', function () {
        try { refreshTexts(); } catch (e) {}
    });

    /* ── public API (also the inline handlers in index.html) ──────────────── */

    function toggleGroup(on) {
        if (on) {
            /* No country master switch exists in the panel any more; for
             * API callers, “on” restores the rendered layers that were on
             * (or start on by default — DTK25). */
            var restored = false;
            PANEL_LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id] || layer.defaultOn) {
                    restored = true;
                    switchOn(layer);
                }
            });
            if (!restored) {
                var fallback = CONFIG.byId('dtk25');
                if (fallback) switchOn(fallback);
            }
        } else {
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) deactivate(layer, {});
            });
        }
        syncUI();
    }

    function goToView() {
        var map = runtime.map || getMap();
        if (!map || !CONFIG.view) return;
        try { map.setView(CONFIG.view.center, CONFIG.view.zoom, { animate: true }); } catch (e) {}
    }

    /* The shared registry mirror lives in js/layer-registry.js: that file is
     * loaded by the browser, by the Netlify functions and by the audit tools,
     * so the Danish layers are catalogued everywhere, not only where the map
     * runs. Nothing to register from here — js/danish-layers.js only draws
     * them. */

    var API = {
        CONFIG: CONFIG,
        layers: LAYERS,
        panelLayers: PANEL_LAYERS,
        state: runtime,
        TEXT: TEXT,
        init: start,
        toggleGroup: toggleGroup,
        togglePanelGroup: function (groupId, on) {
            var group = (CONFIG.panelGroups || []).filter(function (g) { return g.id === groupId; })[0];
            if (group) togglePanelGroup(group, !!on);
        },
        setGroupExpanded: setGroupExpanded,
        toggleSubLayers: function () { setExpanded(!runtime.expanded); },
        setExpanded: setExpanded,
        select: function (id) { var l = CONFIG.byId(id); if (l) { runtime.selected = l.id; switchOn(l); } },
        toggle: function (id, on) {
            var l = CONFIG.byId(id);
            if (!l) return;
            var wanted = on === undefined ? !runtime.active[id] : !!on;
            if (wanted) switchOn(l); else deactivate(l, {});
        },
        activate: function (id) { var l = CONFIG.byId(id); if (l) switchOn(l); },
        deactivate: function (id) { var l = CONFIG.byId(id); if (l) deactivate(l, {}); },
        setOpacity: function (id, value) { var l = CONFIG.byId(id); if (l) setOpacity(l, value, false); },
        opacityOf: function (id) { return runtime.opacity[id]; },
        isActive: function (id) { return !!runtime.active[id]; },
        activeIds: function () {
            return LAYERS.filter(function (l) { return runtime.active[l.id]; })
                .map(function (l) { return l.id; });
        },
        selectedBase: function () { return runtime.selected; },
        filterForCountry: filterForCountry,
        refreshTexts: refreshTexts,
        goToView: goToView,
        showInfo: showInfo,
        modeOf: function (id) { return runtime.mode[id] || null; },
        _test: {
            build: build,
            buildRow: buildRow,
            buildGroup: buildGroup,
            buildTileLayer: buildTileLayer,
            probeUrl: proxyProbeUrl,
            wfsQueryUrl: wfsQueryUrl,
            wfsDirectUrl: wfsDirectUrl,
            popupHtml: popupHtml,
            setStatus: setStatus,
            tr: tr,
            filterForCountry: filterForCountry,
            syncUI: syncUI,
            TEXT: TEXT
        }
    };

    window.DetectLabDanishLayers = API;
    /* Inline handlers in index.html — the same style as the other groups. */
    window.toggleDanishLayers = function (on) { API.toggleGroup(!!on); };
    window.toggleDanishSubLayers = function () { API.toggleSubLayers(); };
    window.setDanishBase = function (id) { API.select(id); };
    window.setDanishLayer = function (id, on) { API.toggle(id, on); };
    window.setDanishOpacity = function (id, value) { API.setOpacity(id, value); };
    window.showDanishInfo = function () {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(tr(CONFIG.groupLabel), '© Klimadatastyrelsen · © GeoDanmark · ' +
                '© Danmarks Miljøportal · © OpenStreetMap contributors · © Slots- og Kulturstyrelsen',
                tr(CONFIG.groupInfo));
            return;
        }
        window.alert(tr(CONFIG.groupInfo));
    };
    window.goToDenmarkView = function () { API.goToView(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null));
