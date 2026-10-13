/* ============================================================================
 * map3d-terrain.js — the 3D terrain view (MapLibre GL JS) of the DetectLab map
 * ----------------------------------------------------------------------------
 * WHAT IT IS
 *   A second renderer for the SAME map. It is opened with the “3D” button that
 *   this file adds to the map, and it drapes every layer the 2D panel has
 *   switched on over real elevation (raster DEM) — nothing is redefined here:
 *   the layer definitions live in js/layer-registry.js and are shared with the
 *   Leaflet view, so a layer can never exist in one view and be missing from
 *   the other.
 *
 * HOW IT STAYS IN SYNC WITH 2D (no duplicated state anywhere)
 *   • camera   – centre/zoom/bearing are read from the Leaflet map on open and
 *                written back on close, so both views show the same place.
 *   • layers   – the active set is read from the 2D panel itself: the very same
 *                checkboxes (.cenagis-toggle[data-map-key], #austrianMapToggle,
 *                …) decide what 3D draws. Toggling a switch in either view
 *                changes the same element, so the two can never disagree.
 *   • opacity  – read from the same range inputs, and written back into them
 *                when the 3D control bar changes it.
 *   • order    – the registry carries the 2D pane z-index of every layer; the
 *                3D deck is stacked by that value (and then re-asserted with
 *                moveLayer after every change), so the stacking order matches.
 *   • time     – time-enabled layers (WMTS/WMS-T) take their TIME value from
 *                the same 2D dropdown that drives the Leaflet layer.
 *
 * WHAT LOADS WHEN
 *   Nothing but this file (≈30 kB) and the registry are parsed with the page.
 *   MapLibre GL JS + CSS and, above all, the paint of a layer happen only when
 *   the user opens 3D / switches that layer on. Closing 3D removes every
 *   MapLibre object again (the Leaflet map underneath is never touched).
 *
 * CONFIGURATION (no code edit needed)
 *   window.DETECTLAB_MAP3D = { terrain: { provider: 'maptiler', key: '…' }, … }
 *   See the DEFAULTS object in js/layer-registry.js for every knob and
 *   MAP_3D_TERRAIN.md for the walk-through.
 *
 * Exposes window.DetectLabMap3D:
 *   .open() .close() .toggle() .isOpen() .getMap() .syncLayers()
 *   .setExaggeration(v) .setPitch(v) .setBearing(v) .resetView()
 *   .status()  → per-layer 3D status (used by /api/map3d/status and the tests)
 *   .report()  → console table of what is drawn, how, and why
 * ========================================================================== */
(function (root, document) {
    'use strict';

    if (!root || !document) return;

    var REGISTRY = root.DetectLabLayers;
    if (!REGISTRY) {
        console.error('[Map3D] js/layer-registry.js must load before js/map3d-terrain.js');
        return;
    }

    var CONFIG = REGISTRY.config();
    var MAPLIBRE = null;                 /* resolved constructor namespace */
    var sdkPromise = null;
    var map = null;
    var surface = null;
    var veil = null;
    var bar = null;
    var toggleBtn = null;

    var state = {
        open: false,
        exaggeration: CONFIG.terrain.exaggeration,
        proxyHosts: {},                  /* host → true when it must be proxied */
        directHosts: {},                 /* host → true when CORS is confirmed  */
        loadedSources: {},
        status: {},                      /* layerId → { state, mode, reason } */
        lastSync: 0,
        syncTimer: null,
        healthTimers: [],
        pollTimer: null,
        pending: {},
        protocols: false,                /* dl3d:// registered with MapLibre */
        errors: []
    };

    function isMobile() {
        try {
            return (root.matchMedia && root.matchMedia('(max-width: 768px)').matches) ||
                (navigator && navigator.maxTouchPoints > 1);
        } catch (e) { return false; }
    }

    function lang() {
        try {
            if (root._currentLang) return root._currentLang;
            var l = document.documentElement && document.documentElement.lang;
            return /^en/i.test(l || '') ? 'en' : 'ro';
        } catch (e) { return 'ro'; }
    }

    var COPY = {
        ro: {
            button: '3D',
            buttonOn: '2D',
            buttonTitle: 'Vezi harta în 3D, cu relief (teren DEM)',
            buttonTitleOn: 'Întoarce-te la harta 2D',
            title: 'Vedere 3D',
            loading: 'Se încarcă vederea 3D…',
            loadingDetail: 'Se descarcă MapLibre GL și modelul de elevație.',
            failed: 'Vederea 3D nu a putut porni.',
            failedDetail: 'Biblioteca 3D nu s-a putut încărca. Harta 2D funcționează în continuare.',
            retry: 'Încearcă din nou',
            pitch: 'Înclinare',
            bearing: 'Rotație',
            exaggeration: 'Exagerare relief',
            reset: 'Resetează',
            resetTitle: 'Reia poziția și unghiul hărții 2D',
            layers: 'Straturi în 3D',
            nav: 'Navigare',
            statusIdle: 'Se pregătesc straturile…',
            noLayers: 'Niciun strat activ. Pornește straturi din panoul Hărți.',
            viaProxy: 'prin proxy',
            direct: 'direct',
            perTile: 'pe tile (bbox)',
            unavailable: 'indisponibil',
            unsupported: 'nu poate fi drapat',
            terrainOff: 'Modelul de elevație nu s-a putut încărca'
        },
        en: {
            button: '3D',
            buttonOn: '2D',
            buttonTitle: 'View the map in 3D, draped over terrain (DEM)',
            buttonTitleOn: 'Back to the 2D map',
            title: '3D view',
            loading: 'Loading the 3D view…',
            loadingDetail: 'Fetching MapLibre GL and the elevation model.',
            failed: 'The 3D view could not start.',
            failedDetail: 'The 3D library could not be loaded. The 2D map keeps working.',
            retry: 'Try again',
            pitch: 'Pitch',
            bearing: 'Bearing',
            exaggeration: 'Terrain exaggeration',
            reset: 'Reset',
            resetTitle: 'Return to the 2D camera',
            layers: 'Layers in 3D',
            nav: 'Navigation',
            statusIdle: 'Preparing the layers…',
            noLayers: 'No active layer. Switch layers on in the map panel.',
            viaProxy: 'via proxy',
            direct: 'direct',
            perTile: 'per tile (bbox)',
            unavailable: 'unavailable',
            unsupported: 'cannot be draped',
            terrainOff: 'The elevation model could not be loaded'
        }
    };
    function t(key) { var l = lang(); return (COPY[l] && COPY[l][key]) || COPY.en[key] || key; }

    /* ═══════════════════════════════════════════════════════════════════════
     *  MAPLIBRE GL — lazy load (nothing is downloaded until 3D is opened)
     * ═══════════════════════════════════════════════════════════════════════ */
    function loadMapLibre() {
        if (MAPLIBRE) return Promise.resolve(MAPLIBRE);
        if (sdkPromise) return sdkPromise;
        var cfg = REGISTRY.config().maplibre || {};
        sdkPromise = new Promise(function (resolve, reject) {
            var timer = root.setTimeout(function () {
                sdkPromise = null;
                reject(new Error('Timed out loading MapLibre GL'));
            }, cfg.timeoutMs || 15000);

            function finish() {
                root.clearTimeout(timer);
                var ns = root[cfg.namespace || 'maplibregl'];
                if (!ns || typeof ns.Map !== 'function') {
                    sdkPromise = null;
                    reject(new Error('MapLibre GL did not expose maplibregl.Map'));
                    return;
                }
                MAPLIBRE = ns;
                resolve(ns);
            }

            if (root[cfg.namespace || 'maplibregl'] && typeof root[cfg.namespace || 'maplibregl'].Map === 'function') {
                finish();
                return;
            }

            if (cfg.css) {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = cfg.css;
                (document.head || document.documentElement).appendChild(link);
            }
            var script = document.createElement('script');
            script.src = cfg.js;
            script.async = true;
            script.onload = finish;
            script.onerror = function () {
                root.clearTimeout(timer);
                sdkPromise = null;
                reject(new Error('MapLibre GL could not be loaded from ' + cfg.js));
            };
            (document.head || document.documentElement).appendChild(script);
        });
        return sdkPromise;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  dl3d:// — per-tile URLs for builders that need a tile bbox
     * -----------------------------------------------------------------------
     * Five country LiDAR layers (js/geoportal-nmt-layer.js, js/ign-mdt-layer.js,
     * js/lantmateriet-hojdmodell-layer.js, js/ahn-layer.js, js/hoydedata-layer.js)
     * can only build a URL for an explicit tile box (WMS GetMap / ArcGIS
     * exportImage), so no {z}/{x}/{y} template exists for them. The registry
     * hands MapLibre `dl3d://<layer id>/{z}/{x}/{y}` and this handler turns each
     * request into the module's own call — the module stays the single owner of
     * the URL, and the 3D view gets the same pixels as the 2D layer, mode
     * dropdown included.
     * ═══════════════════════════════════════════════════════════════════════ */
    function registerProtocols(maplibre) {
        if (state.protocols || !maplibre || typeof maplibre.addProtocol !== 'function') return;
        state.protocols = true;
        maplibre.addProtocol('dl3d', function (params, abortController) {
            var match = String((params && params.url) || '').match(/^dl3d:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
            if (!match) return Promise.reject(new Error('[Map3D] malformed dl3d:// URL'));
            var def = REGISTRY.get(decodeURIComponent(match[1]));
            var z = Number(match[2]), x = Number(match[3]), y = Number(match[4]);
            var url = def ? REGISTRY.tileUrlAt(def, z, x, y) : '';
            if (!url) return Promise.reject(new Error('[Map3D] no per-tile URL for ' + match[1]));
            return root.fetch(url, {
                mode: 'cors',
                credentials: 'omit',
                signal: abortController && abortController.signal
            }).then(function (response) {
                if (!response || !response.ok) {
                    throw new Error('[Map3D] ' + ((response && response.status) || 0) + ' for ' + url);
                }
                return response.arrayBuffer();
            }).then(function (data) {
                return { data: data };
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  DOM — the surface, the veil and the control bar
     * ═══════════════════════════════════════════════════════════════════════ */
    function leafletMap() { return root._dlMap || root.map || null; }

    function wrapper() {
        var el = document.getElementById('detectlab-map');
        return (el && el.parentNode) || null;
    }

    function ensureSurface() {
        if (surface) return surface;
        var host = wrapper();
        if (!host) return null;
        surface = document.createElement('div');
        surface.id = 'map3d-surface';
        surface.setAttribute('role', 'application');
        surface.setAttribute('aria-label', '3D terrain map');

        veil = document.createElement('div');
        veil.id = 'map3d-veil';
        veil.innerHTML =
            '<span class="m3d-ring" aria-hidden="true"></span>' +
            '<span class="m3d-veil-title"></span>' +
            '<span class="m3d-veil-detail"></span>' +
            '<button type="button" class="m3d-veil-action" style="display:none"></button>';
        surface.appendChild(veil);
        host.appendChild(surface);

        veil.querySelector('.m3d-veil-action').addEventListener('click', function () {
            close();
            open();
        });
        return surface;
    }

    function showVeil(mode, title, detail, actionLabel) {
        if (!veil) return;
        surface.classList.remove('is-busy', 'is-error');
        if (mode) surface.classList.add(mode === 'error' ? 'is-error' : 'is-busy');
        veil.querySelector('.m3d-veil-title').textContent = title || '';
        veil.querySelector('.m3d-veil-detail').textContent = detail || '';
        var action = veil.querySelector('.m3d-veil-action');
        action.style.display = actionLabel ? '' : 'none';
        action.textContent = actionLabel || '';
    }

    function hideVeil() {
        if (!surface) return;
        surface.classList.remove('is-busy', 'is-error');
    }

    function ensureToggle() {
        if (toggleBtn) return toggleBtn;
        var host = wrapper();
        if (!host) return null;
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'map3d-toggle';
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = '<span class="m3d-dot" aria-hidden="true"></span><span class="m3d-label"></span>';
        toggleBtn.addEventListener('click', function () { toggle(); });
        host.appendChild(toggleBtn);
        refreshToggle();
        return toggleBtn;
    }

    function refreshToggle() {
        if (!toggleBtn) return;
        toggleBtn.querySelector('.m3d-label').textContent = state.open ? t('buttonOn') : t('button');
        toggleBtn.title = state.open ? t('buttonTitleOn') : t('buttonTitle');
        toggleBtn.setAttribute('aria-pressed', state.open ? 'true' : 'false');
    }

    function ensureBar() {
        if (bar) return bar;
        var host = wrapper();
        if (!host) return null;
        bar = document.createElement('div');
        bar.id = 'map3d-bar';
        bar.innerHTML = [
            '<div class="m3d-head"><span>' + t('title') + '</span>',
            '<button type="button" class="m3d-collapse" title="Collapse">▾</button></div>',
            '<div class="m3d-row"><label><span>' + t('exaggeration') + '</span>',
            '<b class="m3d-exag-val"></b></label>',
            '<input type="range" class="m3d-exag" min="0" max="100" step="1"></div>',
            '<div class="m3d-row"><label><span>' + t('pitch') + '</span>',
            '<b class="m3d-pitch-val"></b></label>',
            '<input type="range" class="m3d-pitch" min="0" max="' + (CONFIG.camera.maxPitch || 80) + '" step="1"></div>',
            '<div class="m3d-row"><label><span>' + t('bearing') + '</span>',
            '<b class="m3d-bearing-val"></b></label>',
            '<input type="range" class="m3d-bearing" min="0" max="360" step="1"></div>',
            '<div class="m3d-actions">',
            '<button type="button" class="m3d-reset">' + t('reset') + '</button>',
            '<button type="button" class="m3d-north">↑ N</button>',
            '<button type="button" class="m3d-flat">2D ⤓</button>',
            '</div>',
            '<div id="map3d-status" aria-live="polite"></div>'
        ].join('');
        host.appendChild(bar);

        var exag = bar.querySelector('.m3d-exag');
        var pitch = bar.querySelector('.m3d-pitch');
        var bearing = bar.querySelector('.m3d-bearing');
        var c = CONFIG.camera || {};
        var min = CONFIG.terrain.minExaggeration || 0.5;
        var max = CONFIG.terrain.maxExaggeration || 4;
        function exagToSlider(v) { return Math.round(((v - min) / (max - min)) * 100); }
        function sliderToExag(v) { return min + (Number(v) / 100) * (max - min); }
        exag.value = String(exagToSlider(state.exaggeration));

        function paintLabels() {
            bar.querySelector('.m3d-exag-val').textContent = state.exaggeration.toFixed(1) + '×';
            bar.querySelector('.m3d-pitch-val').textContent = Math.round(cameraPitch()) + '°';
            bar.querySelector('.m3d-bearing-val').textContent = Math.round(cameraBearing()) + '°';
            pitch.value = String(Math.round(cameraPitch()));
            bearing.value = String(Math.round((cameraBearing() + 360) % 360));
        }

        exag.addEventListener('input', function () {
            setExaggeration(sliderToExag(exag.value));
            paintLabels();
        });
        pitch.addEventListener('input', function () {
            if (map) map.setPitch(Number(pitch.value));
            paintLabels();
        });
        bearing.addEventListener('input', function () {
            if (map) map.setBearing(Number(bearing.value));
            paintLabels();
        });
        bar.querySelector('.m3d-reset').addEventListener('click', function () { resetView(true); paintLabels(); });
        bar.querySelector('.m3d-north').addEventListener('click', function () {
            if (map) map.setBearing(0);
            paintLabels();
        });
        bar.querySelector('.m3d-flat').addEventListener('click', function () {
            if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
            paintLabels();
        });
        bar.querySelector('.m3d-collapse').addEventListener('click', function () {
            bar.classList.toggle('collapsed');
            bar.querySelector('.m3d-collapse').textContent = bar.classList.contains('collapsed') ? '▸' : '▾';
        });
        bar.paintLabels = paintLabels;
        paintLabels();
        return bar;
    }

    function refreshBarCopy() {
        if (!bar) return;
        bar.querySelector('.m3d-head span').textContent = t('title');
        var rows = bar.querySelectorAll('.m3d-row > label > span');
        if (rows[0]) rows[0].textContent = t('exaggeration');
        if (rows[1]) rows[1].textContent = t('pitch');
        if (rows[2]) rows[2].textContent = t('bearing');
        var reset = bar.querySelector('.m3d-reset');
        if (reset) { reset.textContent = t('reset'); reset.title = t('resetTitle'); }
        refreshToggle();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  CAMERA
     * ═══════════════════════════════════════════════════════════════════════ */
    function cameraPitch() { return map && map.getPitch ? map.getPitch() : (CONFIG.camera.pitch || 0); }
    function cameraBearing() { return map && map.getBearing ? map.getBearing() : 0; }

    /** Centre/zoom/bearing of the 2D map (source of truth when 3D opens). */
    function cameraFrom2D() {
        var lmap = leafletMap();
        var c = CONFIG.camera || {};
        if (!lmap) return { center: [12, 51], zoom: 3, bearing: 0 };
        var center = lmap.getCenter();
        var bearing = 0;
        try { if (typeof lmap.getBearing === 'function') bearing = lmap.getBearing() || 0; } catch (e) { bearing = 0; }
        return {
            center: [center.lng, center.lat],
            zoom: lmap.getZoom(),
            bearing: bearing,
            pitch: c.pitch
        };
    }

    /** Push the 3D camera back to Leaflet (called when 3D closes). */
    function cameraTo2D() {
        var lmap = leafletMap();
        if (!lmap || !map) return;
        try {
            var center = map.getCenter();
            if (typeof lmap.setBearing === 'function' && map.getBearing) {
                lmap.setBearing(map.getBearing(), { noMove: true });
            }
            lmap.setView([center.lat, center.lng], map.getZoom(), { animate: false });
        } catch (e) {
            /* never break the 2D map because of a view hand-off */
        }
    }

    function resetView(animate) {
        var cam = cameraFrom2D();
        if (!map) return;
        map.easeTo({
            center: cam.center,
            zoom: cam.zoom,
            bearing: cam.bearing,
            pitch: CONFIG.camera.pitch,
            duration: animate ? 500 : 0
        });
        if (bar && bar.paintLabels) bar.paintLabels();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  LAYERS — what is on, in what order, through which route
     * ═══════════════════════════════════════════════════════════════════════ */
    function hostOf(def) {
        var url = (def && def.url) || '';
        var m = String(url).match(/^https?:\/\/([^/?#]+)/i);
        return m ? m[1].toLowerCase() : '';
    }

    function activeDefs() {
        return REGISTRY.ordered().filter(function (def) {
            if (def.runtimeOverlays) return true;              /* handled separately */
            if (def.kind === 'dynamic' && !def.resolve) return false;
            try { return REGISTRY.is2dActive(def); } catch (e) { return false; }
        });
    }

    function runtimeOverlays() {
        var lmap = leafletMap();
        if (!lmap || typeof lmap.eachLayer !== 'function') return [];
        var L = root.L;
        if (!L || !L.ImageOverlay) return [];
        var out = [];
        lmap.eachLayer(function (layer) {
            if (layer instanceof L.ImageOverlay) {
                var bounds = null;
                try { bounds = layer.getBounds ? layer.getBounds() : layer._bounds; } catch (e) { bounds = null; }
                var url = layer._url || (layer._image && layer._image.src) || '';
                if (!bounds || !url) return;
                var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
                out.push({
                    id: 'overlay.' + (out.length + 1),
                    url: url,
                    coordinates: [
                        [sw.lng, ne.lat], [ne.lng, ne.lat],
                        [ne.lng, sw.lat], [sw.lng, sw.lat]
                    ],
                    opacity: (typeof layer.getOpacity === 'function') ? layer.getOpacity() : 1
                });
            }
        });
        return out;
    }

    /* ── CORS routing ─────────────────────────────────────────────────────── */
    function hostCacheKey(host) { return 'dl3d.cors.' + host; }

    function readHostCache(host) {
        try {
            var value = root.sessionStorage && root.sessionStorage.getItem(hostCacheKey(host));
            if (value === '1') { state.directHosts[host] = true; return true; }
            if (value === '0') { state.proxyHosts[host] = true; return true; }
        } catch (e) { /* storage can be blocked */ }
        return false;
    }

    function writeHostCache(host, direct) {
        try {
            if (root.sessionStorage) root.sessionStorage.setItem(hostCacheKey(host), direct ? '1' : '0');
        } catch (e) { /* ignore */ }
    }

    /** A tiny request that has the same CORS profile as a real tile. */
    function probeUrl(def) {
        var box = def.bounds && def.bounds.length === 2 ? def.bounds : null;
        if (def.kind === 'wms') {
            var b = box || [[44.4, 26.1], [44.5, 26.2]];
            var sw = REGISTRY.lngLatTo3857(b[0][1], b[0][0]);
            var ne = REGISTRY.lngLatTo3857(b[1][1], b[1][0]);
            return REGISTRY.wmsTemplate(def, {}).replace('{bbox-epsg-3857}',
                [sw[0], sw[1], ne[0], ne[1]].map(function (v) { return v.toFixed(1); }).join(','))
                .replace(/width=\d+/, 'width=32').replace(/height=\d+/, 'height=32');
        }
        var template = REGISTRY.directTemplate(def, {});
        if (!template) return null;
        var z = Math.max(0, Math.min(def.minZoom == null ? 0 : def.minZoom, def.maxNativeZoom == null ? 12 : def.maxNativeZoom));
        var n = Math.pow(2, z);
        var x = 0, y = 0;
        if (box) {
            var mid = REGISTRY.lngLatTo3857((box[0][1] + box[1][1]) / 2, (box[0][0] + box[1][0]) / 2);
            var size = 2 * Math.PI * 6378137;
            x = Math.floor(((mid[0] + size / 2) / size) * n);
            y = Math.floor(((size / 2 - mid[1]) / size) * n);
        } else {
            x = Math.floor(n / 2);
            y = Math.floor(n / 2);
        }
        return template.replace(/\{z\}/g, String(z)).replace(/\{x\}/g, String(x)).replace(/\{y\}/g, String(y));
    }

    function probeHost(def) {
        var host = hostOf(def);
        if (!host) return Promise.resolve(def.cors === 'yes');
        if (state.proxyHosts[host]) return Promise.resolve(false);
        if (state.directHosts[host]) return Promise.resolve(true);
        if (!CONFIG.proxy || CONFIG.proxy.probe === false) {
            return Promise.resolve(def.cors === 'yes');
        }
        if (readHostCache(host)) return Promise.resolve(!!state.directHosts[host]);
        var url = probeUrl(def);
        if (!url || typeof root.fetch !== 'function') {
            var fallback = def.cors === 'yes';
            return Promise.resolve(fallback);
        }
        return root.fetch(url, { mode: 'cors', cache: 'no-store' }).then(function (response) {
            var ok = !!response && response.ok;
            if (ok) { state.directHosts[host] = true; } else { state.proxyHosts[host] = true; }
            writeHostCache(host, ok);
            return ok;
        }).catch(function () {
            /* Either no CORS header or offline. Offline leaves the verdict open
             * so a later attempt (or a 2D-only session) is unaffected. */
            if (root.navigator && root.navigator.onLine === false) return true;
            state.proxyHosts[host] = true;
            writeHostCache(host, false);
            return false;
        });
    }

    /* ── style assembly ───────────────────────────────────────────────────── */
    function baseLayers() {
        var selected = 'imagery';
        try {
            selected = root.localStorage.getItem('detectlab_arcgis_basemap_v1') || 'imagery';
        } catch (e) { /* keep default */ }
        if (['imagery', 'topographic', 'terrain'].indexOf(selected) === -1) selected = 'imagery';
        if (selected === 'topographic') return [REGISTRY.get('base.topographic')];
        if (selected === 'terrain') return [REGISTRY.get('base.terrain-base'), REGISTRY.get('base.terrain-relief')];
        return [REGISTRY.get('base.imagery')];
    }

    function terrainSource() { return REGISTRY.terrainSource(); }

    function buildStyle(maplibre) {
        var ts = terrainSource();
        var cfg = REGISTRY.config();
        var style = {
            version: 8,
            sources: {},
            layers: [{ id: 'm3d-background', type: 'background', paint: { 'background-color': '#0a1526' } }]
        };

        /* DEM — one source, used by the terrain AND the hillshade */
        if (ts.tiles.length && !ts.missingKey) {
            style.sources[ts.id] = {
                type: 'raster-dem',
                tiles: ts.tiles,
                tileSize: ts.tileSize || 256,
                encoding: ts.encoding || 'terrarium',
                minzoom: isMobile() ? 0 : ts.minzoom,
                maxzoom: isMobile() ? Math.min(ts.maxzoom, cfg.perf.mobileMaxTerrainZoom) : ts.maxzoom,
                attribution: ts.attribution || ''
            };
            style.terrain = { source: ts.id, exaggeration: state.exaggeration };
        }

        baseLayers().forEach(function (def) {
            if (!def) return;
            style.sources[def.id] = REGISTRY.rasterSource(def, { proxyHosts: Object.keys(state.proxyHosts) });
            style.layers.push({
                id: def.id,
                type: 'raster',
                source: def.id,
                paint: { 'raster-opacity': 1, 'raster-fade-duration': cfg.perf.fadeDuration }
            });
        });

        if (cfg.hillshade && cfg.hillshade.enabled && cfg.hillshade.mode === 'service') {
            var hs = 'm3d-hillshade-service';
            style.sources[hs] = {
                type: 'raster',
                tiles: cfg.hillshade.serviceTiles,
                tileSize: 256,
                maxzoom: cfg.hillshade.serviceMaxzoom || 16,
                attribution: cfg.hillshade.serviceAttribution || ''
            };
            style.layers.push({
                id: hs, type: 'raster', source: hs,
                paint: { 'raster-opacity': cfg.hillshade.opacity, 'raster-fade-duration': cfg.perf.fadeDuration }
            });
        } else if (cfg.hillshade && cfg.hillshade.enabled && style.sources[ts.id]) {
            style.layers.push({
                id: 'm3d-hillshade',
                type: 'hillshade',
                source: ts.id,
                paint: {
                    'hillshade-exaggeration': cfg.hillshade.exaggeration || 1,
                    'hillshade-shadow-color': '#2b2b33',
                    'hillshade-highlight-color': '#ffffff',
                    'hillshade-accent-color': '#3a3a45'
                }
            });
        }

        if (cfg.sky && cfg.sky.enabled) {
            style.sky = Object.assign({}, cfg.sky.paint || {});
        }
        return style;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  SYNC — diff the active set against what the 3D deck currently shows
     * ═══════════════════════════════════════════════════════════════════════ */
    function deckOrder() {
        var ids = [];
        baseLayers().forEach(function (def) { if (def) ids.push(def.id); });
        activeDefs().forEach(function (def) { ids.push(def.id); });
        return ids;
    }

    function sourceSpecFor(def) {
        var opts = {
            proxyHosts: Object.keys(state.proxyHosts),
            time: REGISTRY.timeOf(def)
        };
        if (def.modes || (def.kind === 'dynamic' && typeof def.resolve === 'function')) {
            /* Country LiDAR layers: the 2D dropdown picks the product/renderer,
             * and both the tile template and the proxy have to follow it. */
            var mode = REGISTRY.modeOf(def, {});
            if (mode) opts.mode = mode;
        }
        return REGISTRY.rasterSource(def, opts);
    }

    function tilesChanged(source, tiles) {
        try {
            var current = source && source.tiles;
            if (!current || current.length !== tiles.length) return true;
            for (var i = 0; i < tiles.length; i += 1) {
                if (current[i] !== tiles[i]) return true;
            }
            return false;
        } catch (e) { return false; }
    }

    function addDef(def) {
        if (!map || !def) return;
        var spec = sourceSpecFor(def);
        if (!spec.tiles || !spec.tiles.length) {
            state.status[def.id] = { state: 'unsupported', reason: 'no tile template (module not loaded?)' };
            return;
        }
        var proxied = String(spec.tiles[0]).indexOf(CONFIG.proxy.base) === 0;
        var perTile = String(spec.tiles[0]).indexOf('dl3d://') === 0;
        if (!map.getSource(def.id)) {
            map.addSource(def.id, spec);
        } else if (spec.tiles && spec.tiles.length && tilesChanged(map.getSource(def.id), spec.tiles)) {
            /* The template itself changed — a new product in a mode dropdown
             * (France LiDAR HD), a new TIME value (WMS-T / WMTS), a switch
             * from direct to proxy. Swapping the tile list is cheaper than
             * rebuilding the source and keeps the paint order untouched. */
            try { map.getSource(def.id).setTiles(spec.tiles); } catch (e) { /* ignore */ }
        }
        if (!map.getLayer(def.id)) {
            map.addLayer({
                id: def.id,
                type: 'raster',
                source: def.id,
                paint: {
                    'raster-opacity': REGISTRY.opacityOf(def),
                    'raster-fade-duration': (REGISTRY.config().perf || {}).fadeDuration
                }
            });
        } else {
            map.setPaintProperty(def.id, 'raster-opacity', REGISTRY.opacityOf(def));
        }
        state.status[def.id] = {
            state: 'on',
            mode: proxied ? 'proxy' : 'direct',
            host: hostOf(def),
            tiles: 1,
            crs: def.crs || 'EPSG:3857',
            reproject: !!def.reproject,
            perTile: perTile,
            time: REGISTRY.timeOf(def) || null
        };
    }

    function removeLayerObjects(id) {
        if (!map) return;
        try { if (map.getLayer(id)) map.removeLayer(id); } catch (e) { /* ignore */ }
        try { if (map.getSource(id)) map.removeSource(id); } catch (e) { /* ignore */ }
        delete state.status[id];
    }

    /* ── Dynamic CORONA products: one raster source per pass/frame in view ──
     * The selection logic (which pass mosaic at which zoom, which individual
     * frames, how the footprints intersect the view) is NOT re-implemented
     * here: js/corona-wms-layer.js already exposes it (createManager →
     * selectProducts + the catalogue loader). The 3D view only turns the
     * chosen products into MapLibre raster sources, via the registry proxy
     * route (the CAST server sends no CORS header). */
    function coronaManager() {
        var atlas = root.CoronaAtlas;
        if (!atlas || typeof atlas.createManager !== 'function') return null;
        if (!state.coronaManager) {
            try {
                state.coronaManager = atlas.createManager(leafletMap(), {
                    /* The 3D deck caps the number of sources; the 2D caps are
                     * kept for the 3D view too. */
                    maxActivePasses: 8,
                    maxActiveFrames: 12
                });
            } catch (e) {
                state.coronaManager = null;
            }
        }
        return state.coronaManager;
    }

    function loadCoronaCatalog() {
        if (state.coronaCatalog) return Promise.resolve(state.coronaCatalog);
        if (state.coronaCatalogPromise) return state.coronaCatalogPromise;
        var atlas = root.CoronaAtlas;
        var manager = coronaManager();
        if (!atlas || !manager || typeof atlas.loadCatalog !== 'function') return Promise.resolve(null);
        state.coronaCatalogPromise = atlas.loadCatalog().then(function (payload) {
            var blocks = atlas.normalizeCatalog(payload, atlas.EUROPE_BBOX);
            manager.setCatalog(blocks);
            state.coronaCatalog = blocks;
            return blocks;
        }).catch(function () {
            return null;
        });
        return state.coronaCatalogPromise;
    }

    function syncCorona(def) {
        var atlas = root.CoronaAtlas;
        var prefix = 'm3d-corona-';
        var existing = Object.keys(state.status).filter(function (id) {
            return id.indexOf(prefix) === 0;
        });
        var manager = coronaManager();
        if (!atlas || !manager) {
            if (!existing.length) {
                state.status[def.id] = {
                    state: 'unsupported',
                    reason: 'CORONA catalogue helper (window.CoronaAtlas) is not loaded'
                };
            }
            return;
        }
        if (!state.coronaCatalog) {
            loadCoronaCatalog().then(function () {
                if (map && state.open) syncCorona(def);
            });
            state.status[def.id] = { state: 'idle', reason: 'loading the CORONA catalogue…' };
            return;
        }

        var bounds = map.getBounds();
        var bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        var descriptors = [];
        try {
            descriptors = manager.selectProducts(Math.floor(map.getZoom()), bbox) || [];
        } catch (e) {
            descriptors = [];
        }

        var wanted = {};
        descriptors.forEach(function (descriptor) {
            var product = descriptor.product;
            if (!product || !product.location) return;
            var id = prefix + String(product.location).replace(/[^A-Za-z0-9_.-]/g, '_');
            wanted[id] = { location: product.location, extent: product.extent };
        });

        existing.forEach(function (id) { if (!wanted[id]) removeLayerObjects(id); });
        Object.keys(wanted).forEach(function (id) {
            var product = wanted[id];
            if (map.getSource(id)) return;
            var tiles = REGISTRY.map3dTiles(def, {
                forceProxy: true,
                proxyProduct: product.location
            });
            if (!tiles || !tiles.length) return;
            map.addSource(id, {
                type: 'raster',
                tiles: tiles,
                tileSize: 256,
                /* extent is [minLon, minLat, maxLon, maxLat] — MapLibre wants
                 * [west, south, east, north]. */
                bounds: product.extent || undefined,
                minzoom: 8,
                maxzoom: 17,
                attribution: def.attribution
            });
            map.addLayer({
                id: id, type: 'raster', source: id,
                paint: { 'raster-opacity': REGISTRY.opacityOf(def) }
            });
            state.status[id] = {
                state: 'on', mode: 'proxy', host: hostOf(def),
                product: product.location, group: def.id
            };
        });
        if (!Object.keys(wanted).length) {
            state.status[def.id] = { state: 'idle', reason: 'no CORONA pass covers this view at this zoom' };
        } else {
            delete state.status[def.id];
        }
    }

    function syncOverlays() {
        var overlays = runtimeOverlays();
        var prefix = 'm3d-overlay-';
        Object.keys(state.status).forEach(function (id) {
            if (id.indexOf(prefix) === 0 && !overlays.some(function (o) { return id === prefix + o.id; })) {
                removeLayerObjects(id);
            }
        });
        overlays.forEach(function (o) {
            var id = prefix + o.id;
            if (!map.getSource(id)) {
                map.addSource(id, { type: 'image', url: o.url, coordinates: o.coordinates });
                map.addLayer({
                    id: id, type: 'raster', source: id,
                    paint: { 'raster-opacity': o.opacity }
                });
            }
            state.status[id] = { state: 'on', mode: 'direct', imageOverlay: true };
        });
    }

    function reorderDeck() {
        if (!map) return;
        /* Moving in ascending order puts every layer on top of the previous
         * one, which reproduces the 2D pane stacking exactly. */
        var ids = deckOrder();
        var hillshade = map.getLayer('m3d-hillshade') ? ['m3d-hillshade'] : [];
        var serviceHillshade = map.getLayer('m3d-hillshade-service') ? ['m3d-hillshade-service'] : [];
        ids.forEach(function (id) {
            if (map.getLayer(id)) {
                try { map.moveLayer(id); } catch (e) { /* ignore */ }
            }
        });
        Object.keys(state.status).forEach(function (id) {
            if (id.indexOf('m3d-corona-') === 0 || id.indexOf('m3d-overlay-') === 0) {
                if (map.getLayer(id)) { try { map.moveLayer(id); } catch (e) { /* ignore */ } }
            }
        });
        hillshade.concat(serviceHillshade).forEach(function (id) {
            if (map.getLayer(id)) {
                try {
                    var first = deckOrder()[0];
                    if (first && map.getLayer(first)) map.moveLayer(id, first);
                } catch (e) { /* ignore */ }
            }
        });
    }

    function baseIds() {
        return ['base.imagery', 'base.topographic', 'base.terrain-base', 'base.terrain-relief'];
    }

    function syncLayers() {
        if (!map || !state.open) return;
        var defs = activeDefs();
        var wanted = {};
        defs.forEach(function (def) { wanted[def.id] = def; });

        /* Layers that the 2D panel switched off leave the 3D deck; the base
         * map follows the 2D basemap choice instead of a checkbox. */
        var keep = {};
        Object.keys(wanted).forEach(function (id) { keep[id] = true; });
        baseLayers().forEach(function (def) { if (def) keep[def.id] = true; });
        Object.keys(state.status).forEach(function (id) {
            if (id.indexOf('m3d-') === 0) return;                 /* dynamic decks handle themselves */
            if (!keep[id] && REGISTRY.get(id)) removeLayerObjects(id);
        });

        var corona = REGISTRY.get('sat.corona-60s');
        var overlaysDef = REGISTRY.get('overlay.image-overlays');

        /* Everything that is on but has no CORS verdict yet is probed first. */
        var pending = [];
        defs.forEach(function (def) {
            if (def.kind === 'dynamic') return;                   /* corona/overlay decks below */
            var host = hostOf(def);
            if (!host || def.cors === 'yes' || def.cors === 'no' || def.proxy === 'never') {
                addDef(def);
                return;
            }
            pending.push(probeHost(def).then(function (direct) {
                if (!direct && host) state.proxyHosts[host] = true;
                addDef(def);
            }));
        });

        if (wanted['sat.corona-60s'] && corona) syncCorona(corona);
        else {
            Object.keys(state.status).forEach(function (id) {
                if (id.indexOf('m3d-corona-') === 0) removeLayerObjects(id);
            });
            if (corona) delete state.status[corona.id];
        }

        /* Image overlays (e.g. the per-locality “Harta Iosefină” sheet) are
         * runtime state of the 2D map: whatever Leaflet is showing right now
         * is mirrored, with the bounds Leaflet itself computed. */
        if (overlaysDef) syncOverlays();

        Promise.all(pending).then(function () {
            if (!map || !state.open) return;
            reorderDeck();
            watchSourceHealth();
            renderStatus();
        });

        state.lastSync = Date.now();
    }

    /* Layers that never load a single tile almost always mean “no CORS”. */
    function watchSourceHealth() {
        state.healthTimers.forEach(function (timer) { root.clearTimeout(timer); });
        state.healthTimers = [];
        if (!map) return;
        var timer = root.setTimeout(function () {
            if (!map || !state.open) return;
            Object.keys(state.status).forEach(function (id) {
                var entry = state.status[id];
                if (!entry || entry.state !== 'on' || entry.mode !== 'proxy' && entry.mode !== 'direct') return;
                if (entry.mode !== 'direct') return;
                if (entry.imageOverlay) return;
                var def = REGISTRY.get(id);
                if (!def) return;
                if (!viewTouches(def)) return;
                if (state.loadedSources[id]) return;
                var host = hostOf(def);
                if (!host || state.proxyHosts[host] || def.proxy === 'never') return;
                state.proxyHosts[host] = true;
                writeHostCache(host, false);
                state.status[id] = { state: 'on', mode: 'proxy', host: host, healed: true };
                state.errors.push({ layer: id, reason: 'no tiles loaded — switching to the proxy' });
                console.warn('[Map3D] No direct tile loaded for ' + id + ' — retrying via /api/map3d/tile');
                var spec = sourceSpecFor(def);
                try {
                    if (map.getSource(id) && typeof map.getSource(id).setTiles === 'function' && spec.tiles) {
                        map.getSource(id).setTiles(spec.tiles);
                    }
                } catch (e) { /* ignore */ }
            });
            renderStatus();
        }, 7000);
        state.healthTimers.push(timer);
    }

    function viewTouches(def) {
        if (!map || !def) return true;
        if (!def.bounds || def.bounds.length !== 2) return true;
        try {
            var b = map.getBounds();
            var sw = def.bounds[0], ne = def.bounds[1];
            return !(ne[1] < b.getWest() || sw[1] > b.getEast() || ne[0] < b.getSouth() || sw[0] > b.getNorth());
        } catch (e) { return true; }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  STATUS PANEL
     * ═══════════════════════════════════════════════════════════════════════ */
    function renderStatus() {
        var box = document.getElementById('map3d-status');
        if (!box) return;
        var defs = activeDefs();
        var on = Object.keys(state.status).filter(function (id) {
            return state.status[id] && state.status[id].state === 'on';
        });
        var rows = [];
        if (!defs.length && !on.length) {
            rows.push('<div class="m3d-st">' + escapeHtml(t('noLayers')) + '</div>');
        }
        defs.forEach(function (def) {
            var st = state.status[def.id];
            var label = (def.title && (def.title[lang()] || def.title.en)) || def.id;
            if (!st) {
                rows.push('<div class="m3d-st"><b>' + escapeHtml(label) + '</b> — ' + escapeHtml(t('statusIdle')) + '</div>');
                return;
            }
            if (st.state === 'unsupported') {
                rows.push('<div class="m3d-st is-bad"><b>' + escapeHtml(label) + '</b> — ' +
                    escapeHtml(t('unsupported')) + (st.reason ? ': ' + escapeHtml(st.reason) : '') + '</div>');
                return;
            }
            if (st.state === 'idle') {
                rows.push('<div class="m3d-st is-warn"><b>' + escapeHtml(label) + '</b> — ' + escapeHtml(st.reason || '') + '</div>');
                return;
            }
            var mode = st.mode === 'proxy' ? t('viaProxy') : (st.perTile ? t('perTile') : t('direct'));
            var cls = st.mode === 'proxy' ? ' is-proxy' : '';
            rows.push('<div class="m3d-st' + cls + '"><b>' + escapeHtml(label) + '</b> — ' + escapeHtml(mode) +
                (st.time ? ' · ' + escapeHtml(String(st.time)) : '') +
                (st.reproject ? ' · reproiectat' : '') + '</div>');
        });
        var terrain = terrainSource();
        rows.push('<div class="m3d-sum">' + escapeHtml(terrain.label) + ' · ' +
            state.exaggeration.toFixed(1) + '× · ' + on.length + ' ' +
            escapeHtml(lang() === 'ro' ? 'straturi active' : 'active layers') + '</div>');
        box.innerHTML = rows.join('');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  OPEN / CLOSE
     * ═══════════════════════════════════════════════════════════════════════ */
    function open() {
        if (state.open) return Promise.resolve(true);
        if (!wrapper()) {
            console.warn('[Map3D] #detectlab-map is not in the DOM yet');
            return Promise.resolve(false);
        }
        ensureSurface();
        ensureBar();
        ensureToggle();
        document.body.classList.add('is-3d');
        state.open = true;
        refreshToggle();
        showVeil('busy', t('loading'), t('loadingDetail'), null);

        return loadMapLibre().then(function (maplibre) {
            if (!state.open) return true;
            registerProtocols(maplibre);
            var cfg = REGISTRY.config();
            var cam = cameraFrom2D();
            var options = {
                container: surface,
                style: buildStyle(maplibre),
                center: cam.center,
                zoom: cam.zoom,
                bearing: cam.bearing,
                pitch: (CONFIG.camera && CONFIG.camera.pitch) || 60,
                minZoom: (CONFIG.camera && CONFIG.camera.minZoom) || 2,
                maxZoom: (CONFIG.camera && CONFIG.camera.maxZoom) || 20,
                maxPitch: (CONFIG.camera && CONFIG.camera.maxPitch) || 80,
                attributionControl: { compact: true },
                maxTileCacheSize: (cfg.perf && cfg.perf.maxTileCacheSize) || 320,
                fadeDuration: (cfg.perf && cfg.perf.fadeDuration) || 120,
                antialias: true,
                hash: false,
                /* The 3D surface is a preview: gestures must not scroll the page. */
                cooperativeGestures: false
            };
            map = new maplibre.Map(options);
            if (!state.open) {                    /* closed while the SDK was loading */
                try { map.remove(); } catch (e) { /* ignore */ }
                map = null;
                return false;
            }
            map.touchZoomRotate.enableRotation();
            /* Control corners are chosen around the 2D chrome that stays on
             * screen: the search bar owns the top centre, the layer panel the
             * whole right edge, the 3D bar the bottom-left and the 3D toggle the
             * bottom centre — so MapLibre's own controls live top-right /
             * bottom-right, and the scale sits at the bottom edge. */
            if (maplibre.NavigationControl) {
                map.addControl(new maplibre.NavigationControl({ visualizePitch: true, showCompass: true }), 'bottom-right');
            }
            if (maplibre.TerrainControl && terrainSource().tiles.length && !terrainSource().missingKey) {
                map.addControl(new maplibre.TerrainControl({
                    source: terrainSource().id,
                    exaggeration: state.exaggeration
                }), 'top-right');
            }
            if (maplibre.ScaleControl) {
                map.addControl(new maplibre.ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left');
            }
            if (isMobile() && typeof map.setPixelRatio === 'function') {
                try { map.setPixelRatio(cfg.perf.mobilePixelRatio || 1); } catch (e) { /* ignore */ }
            }

            map.on('load', function () {
                hideVeil();
                if (terrainSource().missingKey) {
                    console.warn('[Map3D] Terrain provider needs an API key — running without terrain.');
                }
                syncLayers();
                startPanelWatcher();
            });
            map.on('idle', function () { hideVeil(); });
            map.on('moveend', function () {
                if (bar && bar.paintLabels) bar.paintLabels();
                var corona = REGISTRY.get('sat.corona-60s');
                if (corona && REGISTRY.is2dActive(corona)) syncCorona(corona);
                if (runtimeOverlays().length) syncOverlays();
            });
            map.on('sourcedata', function (event) {
                if (event.sourceId && event.isSourceLoaded) state.loadedSources[event.sourceId] = true;
            });
            map.on('error', function (event) {
                var message = String((event && event.error && event.error.message) || event && event.error || '');
                if (/terrain|dem/i.test(message)) {
                    console.warn('[Map3D] Terrain source error: ' + message);
                }
                state.errors.push({ message: message.slice(0, 200) });
                if (state.errors.length > 40) state.errors.shift();
            });
            /* The language switch re-renders the panel: keep our own copy in sync. */
            document.addEventListener('detectlab:langchange', refreshBarCopy);
            return true;
        }).catch(function (error) {
            console.error('[Map3D] ' + (error && error.message || error));
            showVeil('error', t('failed'), t('failedDetail'), t('retry'));
            state.open = false;
            document.body.classList.remove('is-3d');
            refreshToggle();
            return false;
        });
    }

    function close() {
        if (!state.open && !map) return false;
        state.open = false;
        stopPanelWatcher();
        state.healthTimers.forEach(function (timer) { root.clearTimeout(timer); });
        state.healthTimers = [];
        if (map) {
            cameraTo2D();
            try { map.remove(); } catch (e) { /* ignore */ }
            map = null;
        }
        state.loadedSources = {};
        state.status = {};
        document.body.classList.remove('is-3d');
        refreshToggle();
        return true;
    }

    function toggle() {
        return state.open ? close() : open();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  PANEL WATCHER — the 2D panel is the single source of layer state
     * ═══════════════════════════════════════════════════════════════════════ */
    function onPanelEvent(event) {
        if (!state.open) return;
        var target = event.target;
        if (!target || !target.tagName) return;
        var tag = String(target.tagName).toLowerCase();
        if (tag !== 'input' && tag !== 'select') return;
        var type = target.type;
        var isRange = type === 'range';
        if (type !== 'checkbox' && !isRange && tag !== 'select') return;

        /* Opacity of an already drawn layer: cheap in-place update. */
        if (isRange) {
            var sliderId = target.id || '';
            var selectorKey = target.getAttribute && target.getAttribute('data-map-key');
            REGISTRY.list().forEach(function (def) {
                var ui = def.ui || {};
                var matches = (sliderId && (ui.slider === sliderId || ui.sliderSelector && ui.sliderSelector.indexOf('["' + sliderId + '"]') !== -1)) ||
                    (selectorKey && ui.sliderSelector && ui.sliderSelector.indexOf('data-map-key="' + selectorKey + '"') !== -1);
                if (!matches) return;
                if (map && map.getLayer(def.id)) {
                    map.setPaintProperty(def.id, 'raster-opacity', Number(target.value) / 100);
                }
            });
            return;
        }

        /* Switch / dropdown change (including the time dimensions). */
        var relevant = false;
        REGISTRY.list().forEach(function (def) {
            var ui = def.ui || {};
            var id = target.id || '';
            if (ui.toggle && ui.toggle === id) relevant = true;
            if (ui.select && ui.select === id) relevant = true;
            if (ui.selector && target.matches && target.matches(ui.selector)) relevant = true;
            if (ui.parent && ui.parent === id) relevant = true;
            if (['histToggle', 'histPremiumToggle', 'lidarToggle'].indexOf(id) !== -1) relevant = true;
        });
        if (!relevant) return;
        scheduleSync();
    }

    function scheduleSync() {
        if (!state.open) return;
        if (state.syncTimer) root.clearTimeout(state.syncTimer);
        state.syncTimer = root.setTimeout(function () {
            state.syncTimer = null;
            syncLayers();
        }, 120);
    }

    function startPanelWatcher() {
        document.addEventListener('change', onPanelEvent, true);
        document.addEventListener('input', onPanelEvent, true);
        if (state.pollTimer) root.clearInterval(state.pollTimer);
        /* Safety net for programmatic changes (country filter, premium guard,
         * wms-health removing a layer) that do not fire DOM events. */
        state.pollTimer = root.setInterval(function () {
            if (!state.open) return;
            var signature = activeDefs().map(function (def) { return def.id; }).join(',');
            if (signature !== state.lastSignature) {
                state.lastSignature = signature;
                syncLayers();
            }
        }, 2500);
    }

    function stopPanelWatcher() {
        document.removeEventListener('change', onPanelEvent, true);
        document.removeEventListener('input', onPanelEvent, true);
        if (state.pollTimer) {
            root.clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  PUBLIC API
     * ═══════════════════════════════════════════════════════════════════════ */
    function setExaggeration(value) {
        var min = CONFIG.terrain.minExaggeration || 0.5;
        var max = CONFIG.terrain.maxExaggeration || 4;
        var v = Math.max(min, Math.min(max, Number(value) || min));
        state.exaggeration = v;
        if (map) {
            try { map.setTerrain({ source: terrainSource().id, exaggeration: v }); } catch (e) { /* ignore */ }
        }
        if (bar && bar.querySelector('.m3d-exag-val')) {
            bar.querySelector('.m3d-exag-val').textContent = v.toFixed(1) + '×';
        }
        renderStatus();
        return v;
    }

    function status() {
        return {
            open: state.open,
            exaggeration: state.exaggeration,
            camera: map ? {
                center: [map.getCenter().lng, map.getCenter().lat],
                zoom: map.getZoom(),
                bearing: map.getBearing(),
                pitch: map.getPitch()
            } : null,
            terrain: terrainSource(),
            hillshade: REGISTRY.config().hillshade,
            proxyHosts: Object.keys(state.proxyHosts),
            directHosts: Object.keys(state.directHosts),
            layers: REGISTRY.ordered().map(function (def) {
                var entry = state.status[def.id] || null;
                var status3d = {
                    id: def.id,
                    title: (def.title && (def.title.en || def.title.ro)) || def.id,
                    group: def.group,
                    kind: def.kind,
                    crs: def.crs || 'EPSG:3857',
                    reproject: !!def.reproject,
                    proxy: def.proxy || 'auto',
                    cors: def.cors || 'unknown',
                    active2d: REGISTRY.is2dActive(def),
                    active3d: !!entry && entry.state === 'on',
                    mode: entry ? entry.mode : null,
                    perTile: !!(entry && entry.perTile) ||
                        (def.kind === 'dynamic' && !!((REGISTRY.resolve(def) || {}).perTile)),
                    reason: entry ? (entry.reason || null) : null,
                    notes: def.notes || ''
                };
                if (def.runtimeOverlays) {
                    status3d.kind = 'image-overlay (runtime)';
                    status3d.active3d = Object.keys(state.status).some(function (id) {
                        return id.indexOf('m3d-overlay-') === 0;
                    });
                }
                return status3d;
            }),
            dynamic: Object.keys(state.status).filter(function (id) {
                return id.indexOf('m3d-') === 0;
            }),
            errors: state.errors.slice(-8)
        };
    }

    function report() {
        var data = status();
        var rows = data.layers.map(function (layer) {
            return {
                layer: layer.id,
                on2d: layer.active2d ? '✓' : '',
                on3d: layer.active3d ? '✓' : '',
                mode: (layer.mode || '') + (layer.perTile ? ' +perTile' : ''),
                crs: layer.crs,
                proxy: layer.proxy,
                cors: layer.cors,
                note: layer.reason || ''
            };
        });
        try {
            if (console.table) console.table(rows);
            else console.log(rows);
        } catch (e) { console.log(rows); }
        return data;
    }

    var api = {
        VERSION: REGISTRY.VERSION,
        open: open,
        close: close,
        toggle: toggle,
        isOpen: function () { return state.open; },
        getMap: function () { return map; },
        syncLayers: syncLayers,
        setExaggeration: setExaggeration,
        getExaggeration: function () { return state.exaggeration; },
        setPitch: function (v) { if (map) map.setPitch(Number(v) || 0); },
        setBearing: function (v) { if (map) map.setBearing(Number(v) || 0); },
        resetView: function () { resetView(true); },
        probeHost: probeHost,
        status: status,
        report: report,
        registry: REGISTRY,
        /* kept for the automated tests: build the style without a GPU */
        _buildStyle: function () { return buildStyle(root.maplibregl || {}); },
        _activeDefs: activeDefs
    };

    root.DetectLabMap3D = api;

    /* ── boot: the button appears as soon as the map container exists ─────── */
    function boot() {
        if (!wrapper()) return;
        ensureToggle();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
    /* map-app.js builds the map inside an async IIFE; retry briefly. */
    var attempts = 0;
    var bootTimer = root.setInterval(function () {
        attempts += 1;
        if (toggleBtn || attempts > 40) { root.clearInterval(bootTimer); return; }
        boot();
    }, 250);
}(window, document));
