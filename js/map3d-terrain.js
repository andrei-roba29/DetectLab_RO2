/* ============================================================================
 * map3d-terrain.js — the 3D terrain view (MapLibre GL JS) of the DetectLab map
 * ----------------------------------------------------------------------------
 * WHAT IT IS
 *   A second renderer for the SAME map. It is opened with the “3D” button this
 *   file adds to the map, and it drapes EVERY layer the 2D Leaflet map is
 *   showing over real elevation (raster DEM):
 *
 *   base map ▸ hillshade (low opacity) ▸ every 2D layer in its pane order ▸
 *   vectors ▸ markers/labels/clusters ▸ heatmaps ▸ image overlays
 *
 *   Nothing is re-defined here. Two shared sources feed the deck:
 *
 *     • js/map3d-mirror.js — reads the LIVE 2D map and translates each layer
 *       into a renderer-independent descriptor (raster tiles, GeoJSON, marker
 *       symbols, cluster/heat specs, image-overlay corners). A layer that is
 *       on the 2D map is therefore never missing from 3D: vectors, markers,
 *       clusters, heatmaps, plugin layers and runtime layers included.
 *     • js/layer-registry.js — the service facts (URLs, LAYERS/FORMAT/VERSION,
 *       CRS, CORS/proxy policy, titles, zoom windows) used by the 2D view, by
 *       the tile proxy and as the fallback route for a registry layer the
 *       mirror could not translate (per-tile LiDAR builders, CORONA decks).
 *
 * HOW IT STAYS IN SYNC WITH 2D (no duplicated state anywhere)
 *   • camera   – centre/zoom/bearing are read from the Leaflet map on open and
 *                written back on close, so both views show the same place.
 *   • layers   – the deck is the mirror of the live Leaflet map. Toggling a
 *                switch, adding a marker, drawing a track, switching the
 *                basemap or loading a plugin layer changes the 2D map and the
 *                3D deck follows (layeradd/layerremove + panel events + a
 *                signature poll as the safety net).
 *   • opacity  – read from the live layer (the same slider that drives 2D).
 *   • order    – the 2D pane z-index of every layer is the 3D z-order, so the
 *                stack matches the 2D map pixel for pixel.
 *   • popups   – the popup/tooltip HTML bound in Leaflet is what a click in 3D
 *                opens, and the same feature it belongs to.
 *
 * WHAT LOADS WHEN
 *   Nothing but this file, the mirror and the registry are parsed with the
 *   page. MapLibre GL JS + CSS and, above all, the paint of a layer happen
 *   only when the user opens 3D / switches that layer on. Closing 3D removes
 *   every MapLibre object again (the Leaflet map underneath is never touched).
 *
 * CONFIGURATION (no code edit needed)
 *   window.DETECTLAB_MAP3D = { terrain: { provider: 'maptiler', key: '…' }, … }
 *   See MAP3D_DEFAULT in js/layer-registry.js and MAP_3D_TERRAIN.md.
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
    var MIRROR = root.DetectLabMirror;
    if (!MIRROR) {
        console.error('[Map3D] js/map3d-mirror.js must load before js/map3d-terrain.js');
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
        mirror: { items: [], signature: '', unsupported: [] },
        rendered: {},                    /* deck id → rendered entry            */
        bound: {},                       /* deck id → interaction handlers bound */
        images: {},                      /* icon url → registered MapLibre image */
        blankWarned: {},                 /* proxy URL → already reported blank */
        renderedTiles: 0,                /* tiles drawn by a 2D layer itself */
        pendingImages: {},
        supported: {},                   /* resolved host policy cache           */
        lastSync: 0,
        syncTimer: null,
        healthTimers: [],
        pollTimer: null,
        protocols: false,                /* dl2d:// + dl3d:// registered         */
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
            statusIdle: 'Se pregătesc straturile…',
            noLayers: 'Niciun strat activ. Pornește straturi din panoul Hărți.',
            viaProxy: 'prin proxy',
            direct: 'direct',
            perTile: 'pe tile (bbox)',
            unsupported: 'fără echivalent 3D',
            terrainOff: 'Modelul de elevație nu s-a putut încărca',
            mirrored: 'oglindite din harta 2D',
            base: 'hartă de bază',
            attribution: 'Surse'
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
            statusIdle: 'Preparing the layers…',
            noLayers: 'No active layer. Switch layers on in the map panel.',
            viaProxy: 'via proxy',
            direct: 'direct',
            perTile: 'per tile (bbox)',
            unsupported: 'no 3D equivalent',
            terrainOff: 'The elevation model could not be loaded',
            mirrored: 'mirrored from the 2D map',
            base: 'base map',
            attribution: 'Sources'
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
     *  TILE TRANSPORT — direct, or through the same-origin proxy
     * -----------------------------------------------------------------------
     *  dl2d://<key>/{z}/{x}/{y}  — a layer the mirror found on the 2D map.
     *                              The tile URL is built by the Leaflet layer
     *                              itself (WMS bbox, ArcGIS exportImage, WMTS
     *                              KVP, canvas-recolouring subclass, …), so the
     *                              3D view never re-implements a provider.
     *  dl3d://<layer id>/{z}/{x}/{y}
     *                            — the registry fallback: a per-tile builder
     *                              the mirror could not translate.
     * ═══════════════════════════════════════════════════════════════════════ */
    function hostOfUrl(url) {
        var m = String(url || '').match(/^https?:\/\/([^/?#]+)/i);
        return m ? m[1].toLowerCase() : '';
    }

    function proxyBase() {
        var cfg = REGISTRY.config();
        return (cfg.proxy && cfg.proxy.enabled !== false && cfg.proxy.base) || '';
    }

    /** The registry's verdict for a host (falls back to “unknown”). */
    function registryHostPolicy(host) {
        if (state.supported[host] !== undefined) return state.supported[host];
        var policy = 'unknown';
        try {
            if (REGISTRY.hostPolicy) {
                var all = REGISTRY.hostPolicy();
                if (all[host]) policy = all[host];
            }
        } catch (e) { policy = 'unknown'; }
        state.supported[host] = policy;
        return policy;
    }

    function shouldProxy(host) {
        if (!proxyBase()) return false;
        if (state.proxyHosts[host]) return true;
        if (state.directHosts[host]) return false;
        /* A verdict from this session (set when a host healed, or by an earlier
         * layer on the same host) beats the declaration. */
        if (readHostCache(host)) return state.proxyHosts[host] === true;
        return registryHostPolicy(host) === 'always';
    }

    /**
     * A host that answers no CORS headers fails silently in WebGL: every tile
     * is dropped, so the layer looks “not working”. Move it to the proxy and
     * make the sources that use it load again — MapLibre re-resolves every tile
     * through the protocol handlers, which now take the proxy route.
     */
    function healHost(host, layerId) {
        if (!host || state.proxyHosts[host]) return;
        state.proxyHosts[host] = true;
        writeHostCache(host, false);
        var retried = 0;
        Object.keys(state.rendered).forEach(function (id) {
            var entry = state.rendered[id];
            if (!entry || !entry.sourceIds) return;
            entry.sourceIds.forEach(function (sourceId) {
                var source = map && map.getSource(sourceId);
                if (!source || !source.tiles || !source.tiles.length) return;
                if (hostOfUrl(source.tiles[0]) !== host) return;
                if (setSourceTiles(sourceId, source.tiles.slice())) retried += 1;
            });
        });
        pushError('host ' + host + ' has no CORS — retrying it through ' + proxyBase() +
            (layerId ? ' (' + layerId + ')' : '') + (retried ? ' — ' + retried + ' source(s) reloaded' : ''));
        /* A source MapLibre has not created yet (raster templates resolve per
         * tile, so the host is only known then) still benefits: the next sync
         * creates it with the healed policy. */
        scheduleSync();
    }

    function readHostCache(host) {
        try {
            var value = root.sessionStorage && root.sessionStorage.getItem('dl3d.cors.' + host);
            if (value === '1') { state.directHosts[host] = true; return true; }
            if (value === '0') { state.proxyHosts[host] = true; return true; }
        } catch (e) { /* storage can be blocked */ }
        return false;
    }

    function writeHostCache(host, direct) {
        try {
            if (root.sessionStorage) root.sessionStorage.setItem('dl3d.cors.' + host, direct ? '1' : '0');
        } catch (e) { /* ignore */ }
    }

    /** Fetch one tile, healing a host that turns out to have no CORS. */
    function fetchTile(url, abortController, options) {
        options = options || {};
        var signal = abortController && abortController.signal;
        var host = hostOfUrl(url);
        var useProxy = shouldProxy(host);
        /* Two ways through the proxy: a registry layer is rebuilt server-side
         * from its definition (`?layer=…`, the normal path), a mirrored 2D
         * layer is relayed as the exact URL its own Leaflet layer produced
         * (`?u=…`, host allow-listed). */
        function proxiedUrl() {
            return options.proxyUrl || (proxyBase() + '?u=' + encodeURIComponent(url));
        }
        var target = useProxy ? proxiedUrl() : url;
        return root.fetch(target, { mode: 'cors', credentials: 'omit', signal: signal })
            .then(function (response) {
                if (response && response.ok) {
                    if (response.headers && response.headers.get('X-Map3D-Tile') === 'blank' && !state.blankWarned[target]) {
                        state.blankWarned[target] = true;
                        pushError('proxy returned a blank tile (' + (response.headers.get('X-Map3D-Upstream') || '?') +
                            ') for ' + url.slice(0, 120));
                    }
                    return response;
                }
                if (useProxy && response && response.status === 403) {
                    return response.json().then(function (body) {
                        throw new Error('proxy refused ' + host + ': ' + ((body && body.error) || 'not allowed'));
                    }, function () {
                        throw new Error('proxy refused ' + host);
                    });
                }
                throw new Error(((response && response.status) || 0) + ' for ' + target);
            })
            .catch(function (error) {
                if (!useProxy && proxyBase() && host) {
                    /* A CORS-less host fails exactly like this: remember the
                     * verdict for the session and retry through the proxy. */
                    state.proxyHosts[host] = true;
                    writeHostCache(host, false);
                    pushError('host ' + host + ' has no CORS — serving its tiles through ' + proxyBase());
                    return root.fetch(proxiedUrl(), { mode: 'cors', credentials: 'omit', signal: signal });
                }
                throw error;
            })
            .then(function (response) {
                if (!response || !response.ok) throw new Error(((response && response.status) || 0) + ' for ' + url);
                return response.arrayBuffer();
            })
            .then(function (data) { return { data: data }; });
    }

    function registerProtocols(maplibre) {
        if (state.protocols || !maplibre || typeof maplibre.addProtocol !== 'function') return;
        state.protocols = true;

        /* Layers the mirror found on the live 2D map. */
        maplibre.addProtocol('dl2d', function (params, abortController) {
            var match = String((params && params.url) || '').match(/^dl2d:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
            if (!match) return Promise.reject(new Error('[Map3D] malformed dl2d:// URL'));
            var key = decodeURIComponent(match[1]);
            var z = Number(match[2]);
            var x = Number(match[3]);
            var y = Number(match[4]);
            var layer = MIRROR.layerByKey(key);
            if (!layer) return Promise.reject(new Error('[Map3D] the 2D layer behind ' + key + ' is gone'));
            var url = MIRROR.tileUrlFor(layer, z, x, y);
            if (url) return fetchTile(url, abortController);
            /* No URL: the layer draws its own tiles (canvas / custom plugin).
             * Ask the 2D layer for these pixels instead of re-implementing it. */
            if (typeof MIRROR.renderTile === 'function') {
                return MIRROR.renderTile(layer, z, x, y).then(function (data) {
                    state.renderedTiles += 1;
                    return { data: data };
                }).catch(function (error) {
                    pushError(key + ' could not draw tile ' + z + '/' + x + '/' + y + ': ' +
                        ((error && error.message) || error));
                    throw error;
                });
            }
            return Promise.reject(new Error('[Map3D] no per-tile URL for ' + key));
        });

        /* Registry fallback: country LiDAR builders that need a tile bbox. */
        maplibre.addProtocol('dl3d', function (params, abortController) {
            var match = String((params && params.url) || '').match(/^dl3d:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
            if (!match) return Promise.reject(new Error('[Map3D] malformed dl3d:// URL'));
            var def = REGISTRY.get(decodeURIComponent(match[1]));
            var url = def ? REGISTRY.tileUrlAt(def, Number(match[2]), Number(match[3]), Number(match[4])) : '';
            if (!url) return Promise.reject(new Error('[Map3D] no per-tile URL for ' + match[1]));
            /* Proxied per-tile layers are rebuilt by the proxy from the same
             * definition (`?layer=…&m=<mode>`), never relayed URL by URL. */
            var proxyUrl = def ? REGISTRY.proxyTemplate(def, { time: REGISTRY.timeOf(def), mode: REGISTRY.modeOf(def, {}) }) : null;
            return fetchTile(url, abortController, { proxyUrl: proxyUrl });
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

        /* Attribution of the layers the 2D map is showing: rasters also carry
         * theirs into MapLibre's own control, but vector/cluster/heat layers
         * have no source attribution slot, and “who made this data” must not
         * depend on the renderer. */
        attribution = document.createElement('div');
        attribution.id = 'map3d-sources';
        attribution.setAttribute('aria-live', 'polite');
        surface.appendChild(attribution);
        return surface;
    }

    var attribution = null;

    function syncAttribution() {
        if (!attribution) return;
        var seen = {};
        var list = [];
        state.mirror.items.forEach(function (item) {
            var text = String(item.attribution || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            if (!text || seen[text]) return;
            seen[text] = true;
            list.push(text);
        });
        var terrain = terrainSource();
        if (terrain.attribution && !seen[terrain.attribution]) list.push(terrain.attribution);
        if (!list.length) { attribution.innerHTML = ''; return; }
        attribution.innerHTML = '<b>' + escapeHtml(t('attribution')) + ':</b> ' +
            escapeHtml(list.slice(0, 6).join(' · '));
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
     *  STYLE — background + DEM + hillshade + sky
     * -----------------------------------------------------------------------
     *  The base map is NOT defined here: it is one of the layers the mirror
     *  finds on the 2D map, so switching the 2D basemap switches the 3D one.
     *  A registry base layer is only added when the mirror saw no basemap at
     *  all (e.g. the 2D map is still booting).
     * ═══════════════════════════════════════════════════════════════════════ */
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

        /* Hillshade — drawn ABOVE the base map and BELOW every overlay, so the
         * relief reads through the imagery instead of hiding under it. */
        if (cfg.hillshade && cfg.hillshade.enabled && cfg.hillshade.mode === 'service') {
            style.sources['m3d-hillshade-service'] = {
                type: 'raster',
                tiles: cfg.hillshade.serviceTiles,
                tileSize: 256,
                maxzoom: cfg.hillshade.serviceMaxzoom || 16,
                attribution: cfg.hillshade.serviceAttribution || ''
            };
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

    /** The 2D basemap the mirror found (lowest raster below z 500). */
    function mirroredBaseItem() {
        var bases = state.mirror.items.filter(function (item) {
            return item.kind === 'raster' && item.z < 500 && !item.isOverlay;
        });
        bases.sort(function (a, b) { return a.z - b.z; });
        return bases[0] || null;
    }

    function ensureBaseFallback() {
        if (!map || mirroredBaseItem()) return;
        /* No 2D basemap visible (or the 2D map is not up yet): fall back to the
         * registry's own base imagery so the 3D view is never empty. */
        var def = REGISTRY.get('base.imagery');
        if (!def || map.getSource(def.id)) return;
        try {
            map.addSource(def.id, REGISTRY.rasterSource(def, { proxyHosts: Object.keys(state.proxyHosts) }));
            map.addLayer({
                id: def.id,
                type: 'raster',
                source: def.id,
                paint: { 'raster-opacity': 1, 'raster-fade-duration': (REGISTRY.config().perf || {}).fadeDuration }
            });
            state.status[def.id] = { state: 'on', mode: 'direct', fallbackBase: true };
        } catch (e) { /* ignore */ }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  PLAN — everything that must be on the 3D map right now
     * ═══════════════════════════════════════════════════════════════════════ */
    function activeRegistryFallbacks() {
        /* A definition is rendered from the registry ONLY when the mirror could
         * not carry it: the live 2D layer is not on the map, or its own
         * getTileUrl() produced nothing (a module that needs a tile bbox the
         * browser cannot compute). Everything the mirror did translate — which
         * is what the user sees in 2D — is drawn from the live layer instead,
         * so a layer can never appear twice or in two different places. */
        var claimed = {};
        var mirrored = [];
        state.mirror.items.forEach(function (item) {
            if (item.defId) claimed[item.defId] = true;
            if (item.layer) mirrored.push(item.layer);
        });
        /* The mirror cannot always name the definition (a canvas layer has no
         * URL to match on), but the 2D variable it lives in is just as exact. */
        function covered(def) {
            var live = def.ui && def.ui.var2d ? root[def.ui.var2d] : null;
            if (!live) return false;
            for (var i = 0; i < mirrored.length; i += 1) {
                var layer = mirrored[i];
                if (layer === live) return true;
                try {
                    if (live.hasLayer && live.hasLayer(layer)) return true;
                    if (layer._group && layer._group === live) return true;
                } catch (e) { /* ignore */ }
            }
            return false;
        }
        var out = [];
        REGISTRY.ordered().forEach(function (def) {
            if (def.stub) return;                                  /* already in the deck */
            if (def.runtimeOverlays) return;
            if (claimed[def.id]) return;
            if (covered(def)) return;                              /* the mirror has it */
            var live = def.ui && def.ui.var2d ? root[def.ui.var2d] : null;
            var onMap = !!(live && leafletMap() && typeof leafletMap().hasLayer === 'function' &&
                (leafletMap().hasLayer(live) || (typeof live.getLayers === 'function' && live.getLayers().length)));
            var active = false;
            try { active = REGISTRY.is2dActive(def); } catch (e) { active = false; }
            if (!active && !onMap) return;
            /* Mirrored, but its tiles could not be built (per-tile modules). */
            if (onMap && !mirrorFailed(def)) return;
            out.push(def);
        });
        return out;
    }

    /** Did the mirror see a live layer for this definition and fail on it? */
    function mirrorFailed(def) {
        var errors = MIRROR.errors ? MIRROR.errors() : {};
        var ids = Object.keys(errors);
        if (!ids.length) return false;
        var live = def.ui && def.ui.var2d ? root[def.ui.var2d] : null;
        if (!live) return false;
        var key = '2d.' + (live._leaflet_id || '');
        return !!errors[key];
    }

    function plan() {
        var cfg = REGISTRY.config();
        var items = state.mirror.items.slice();
        var entries = [];
        var seq = 0;

        /* 1. something must be at the bottom */
        items.forEach(function (item) {
            entries.push({ id: 'm3d-2d-' + item.key, z: item.z, seq: seq += 1, kind: item.kind, item: item, mirrored: true });
        });

        /* 2. registry fallbacks (raster only) */
        activeRegistryFallbacks().forEach(function (def) {
            entries.push({ id: def.id, z: def.z == null ? 500 : def.z, seq: seq += 1, kind: 'registry', def: def });
        });

        /* 3. the hillshade belongs directly above the base map and below every
         *    overlay: that is the whole point — the relief reads through the
         *    imagery instead of hiding underneath it. */
        var base = mirroredBaseItem();
        var baseEntryId = base ? 'm3d-2d-' + base.key
            : (map && map.getLayer('base.imagery') ? 'base.imagery' : null);

        return {
            entries: entries,
            baseEntryId: baseEntryId,
            unsupported: state.mirror.unsupported,
            cfg: cfg
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  RENDERERS — one per descriptor kind
     * ═══════════════════════════════════════════════════════════════════════ */
    function fadeDuration() { return (REGISTRY.config().perf || {}).fadeDuration || 120; }

    function removeRendered(id) {
        var entry = state.rendered[id];
        if (!entry) return;
        if (entry.layerIds) {
            entry.layerIds.slice().reverse().forEach(function (layerId) {
                try { if (map.getLayer(layerId)) map.removeLayer(layerId); } catch (e) { /* ignore */ }
            });
        }
        if (entry.sourceIds) {
            entry.sourceIds.forEach(function (sourceId) {
                try { if (map.getSource(sourceId)) map.removeSource(sourceId); } catch (e) { /* ignore */ }
            });
        }
        delete state.rendered[id];
        delete state.bound[id];
        delete state.status[id];
    }

    function setSourceTiles(sourceId, tiles) {
        var source = map.getSource(sourceId);
        if (!source) return false;
        try {
            if (typeof source.setTiles === 'function') { source.setTiles(tiles); return true; }
        } catch (e) { /* ignore */ }
        return false;
    }

    function renderRaster(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var tiles = rasterTilesFor(item);
        var spec = {
            type: 'raster',
            tiles: tiles,
            tileSize: item.tileSize || 256,
            minzoom: item.minzoom == null ? 0 : item.minzoom,
            maxzoom: item.maxzoom == null ? 22 : item.maxzoom,
            attribution: item.attribution || '',
            fadeDuration: fadeDuration()
        };
        if (item.bounds) spec.bounds = item.bounds;
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, spec);
        } else {
            try {
                var current = map.getSource(sourceId).tiles || [];
                if (current[0] !== spec.tiles[0]) setSourceTiles(sourceId, spec.tiles);
                if (typeof map.getSource(sourceId).setMaxZoom === 'function') { /* MapLibre updates via source reload */ }
            } catch (e) { /* ignore */ }
        }
        var layerId = entry.id;
        if (!map.getLayer(layerId)) {
            map.addLayer({
                id: layerId,
                type: 'raster',
                source: sourceId,
                paint: { 'raster-opacity': item.opacity == null ? 1 : item.opacity, 'raster-fade-duration': fadeDuration() }
            });
        } else {
            map.setPaintProperty(layerId, 'raster-opacity', item.opacity == null ? 1 : item.opacity);
        }
        var viaProtocol = /^dl2d:\/\//.test(tiles[0]);
        state.status[entry.id] = {
            state: 'on',
            mode: viaProtocol ? 'live 2D layer' : (shouldProxy(hostOfUrl(tiles[0])) ? 'proxy' : 'direct'),
            kind: item.kind,
            mirrored: true,
            defId: item.defId || null,
            label: item.label,
            paneZ: item.z
        };
        return { sourceIds: [sourceId], layerIds: [layerId] };
    }

    /**
     * The tile template of a mirrored raster layer.
     *
     * A layer that is bound to a registry definition uses the definition's own
     * template (direct, or the tested `?layer=…` proxy route, which re-projects
     * the tile bbox for services that cannot answer Web Mercator). Anything
     * else — a plugin layer, a runtime layer, a service the registry does not
     * know — is asked tile by tile from the live Leaflet layer through the
     * `dl2d://` protocol: the layer's own getTileUrl() builds the request, so
     * its LAYERS / FORMAT / VERSION / STYLE / TIME parameters cannot drift from
     * what the 2D map asks for.
     */
    function rasterTilesFor(item) {
        if (item.defId) {
            var def = REGISTRY.get(item.defId);
            if (def) {
                var spec = REGISTRY.rasterSource(def, {
                    proxyHosts: Object.keys(state.proxyHosts),
                    time: REGISTRY.timeOf(def),
                    mode: REGISTRY.modeOf(def, {})
                });
                if (spec.tiles && spec.tiles.length) return spec.tiles;
                if (spec.tiles && spec.tiles.length === 0) {
                    /* Nothing to build (module not loaded): fall through to the
                     * live 2D layer, which builds it in the browser. */
                }
            }
        }
        return [item.template];
    }

    function renderRegistryRaster(entry) {
        var def = entry.def;
        var spec = REGISTRY.rasterSource(def, {
            proxyHosts: Object.keys(state.proxyHosts),
            time: REGISTRY.timeOf(def),
            mode: def.modes || (def.kind === 'dynamic' && typeof def.resolve === 'function') ? REGISTRY.modeOf(def, {}) : ''
        });
        if (!spec.tiles || !spec.tiles.length) {
            state.status[entry.id] = { state: 'unsupported', reason: 'no tile template (module not loaded?)' };
            return null;
        }
        if (!map.getSource(entry.id)) {
            map.addSource(entry.id, spec);
        } else {
            try { setSourceTiles(entry.id, spec.tiles); } catch (e) { /* ignore */ }
        }
        if (!map.getLayer(entry.id)) {
            map.addLayer({
                id: entry.id,
                type: 'raster',
                source: entry.id,
                paint: { 'raster-opacity': REGISTRY.opacityOf(def), 'raster-fade-duration': fadeDuration() }
            });
        } else {
            map.setPaintProperty(entry.id, 'raster-opacity', REGISTRY.opacityOf(def));
        }
        var proxied = String(spec.tiles[0]).indexOf(proxyBase()) === 0;
        var perTile = String(spec.tiles[0]).indexOf('dl3d://') === 0;
        state.status[entry.id] = {
            state: 'on',
            mode: proxied ? 'proxy' : 'direct',
            perTile: perTile,
            host: (def.url || '').replace(/^https?:\/\//, '').split('/')[0],
            mirrored: false,
            kind: def.kind,
            label: (def.title && (def.title[lang()] || def.title.en)) || def.id
        };
        return { sourceIds: [entry.id], layerIds: [entry.id] };
    }

    function renderImage(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var layerId = entry.id;
        var coordinates = item.coordinates;
        var existing = map.getSource(sourceId);
        var changed = true;
        try {
            if (existing && existing.coordinates) {
                changed = JSON.stringify(existing.coordinates) !== JSON.stringify(coordinates) ||
                    (existing.url || '') !== item.url;
            }
        } catch (e) { changed = true; }
        if (existing && changed) { removeRendered(entry.id); }
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, { type: 'image', url: item.url, coordinates: coordinates });
            map.addLayer({
                id: layerId,
                type: 'raster',
                source: sourceId,
                paint: { 'raster-opacity': item.opacity == null ? 1 : item.opacity, 'raster-fade-duration': fadeDuration() }
            });
        } else if (map.getLayer(layerId)) {
            map.setPaintProperty(layerId, 'raster-opacity', item.opacity == null ? 1 : item.opacity);
        }
        state.status[entry.id] = { state: 'on', mode: 'direct', kind: 'image-overlay', mirrored: true, label: item.label };
        return { sourceIds: [sourceId], layerIds: [layerId] };
    }

    function renderHeat(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var layerId = entry.id;
        if (map.getSource(sourceId)) {
            try { map.getSource(sourceId).setData(item.geojson); } catch (e) { /* ignore */ }
        } else {
            map.addSource(sourceId, { type: 'geojson', data: item.geojson });
        }
        if (!map.getLayer(layerId)) {
            var paint = {
                'heatmap-weight': ['coalesce', ['get', 'w'], 1],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 2.4],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, Math.max(2, item.heat.radius / 3), 12, item.heat.radius],
                'heatmap-opacity': item.opacity == null ? 0.85 : item.opacity,
                'heatmap-max': item.heat.max
            };
            if (item.heat.gradient) {
                /* leaflet.heat gradients are {stop: 'css colour'} → MapLibre uses
                 * a colour ramp on heatmap-color at fixed stops. */
                var stops = Object.keys(item.heat.gradient).map(Number).sort(function (a, b) { return a - b; });
                if (stops.length >= 2) {
                    var ramp = ['interpolate', ['linear'], ['heatmap-density']];
                    stops.forEach(function (stop) {
                        ramp.push(Math.max(0, Math.min(1, stop)));
                        ramp.push(String(item.heat.gradient[String(stop)]));
                    });
                    paint['heatmap-color'] = ramp;
                }
            }
            map.addLayer({ id: layerId, type: 'heatmap', source: sourceId, paint: paint });
        } else {
            map.setPaintProperty(layerId, 'heatmap-opacity', item.opacity == null ? 0.85 : item.opacity);
        }
        state.status[entry.id] = { state: 'on', mode: 'direct', kind: 'heatmap', mirrored: true, label: item.label };
        return { sourceIds: [sourceId], layerIds: [layerId] };
    }

    function vectorLayersFor(entry, sourceId) {
        var item = entry.item;
        var paints = item.paints || { line: {}, fill: {}, circle: {}, layout: {} };
        var layout = paints.layout || {};
        var types = item.types || [];
        var ids = [];
        var hasPolygon = types.some(function (t) { return /Polygon/.test(t); });
        var hasLine = types.some(function (t) { return /LineString|MultiLineString/.test(t); });
        var hasPoint = types.some(function (t) { return /Point/.test(t); });
        var hasCircle = item.circle === true;

        if (hasPolygon) {
            var fillId = entry.id + '-fill';
            if (!map.getLayer(fillId)) {
                map.addLayer({ id: fillId, type: 'fill', source: sourceId, paint: paints.fill });
            } else {
                setPaint(fillId, paints.fill);
            }
            ids.push(fillId);
        }
        if (hasPolygon || hasLine) {
            var lineId = entry.id + '-line';
            if (!map.getLayer(lineId)) {
                map.addLayer({ id: lineId, type: 'line', source: sourceId, paint: paints.line, layout: layout });
            } else {
                setPaint(lineId, paints.line);
                setLayout(lineId, layout);
            }
            ids.push(lineId);
        }
        if (hasPoint) {
            var circleId = entry.id + '-circle';
            if (!map.getLayer(circleId)) {
                map.addLayer({
                    id: circleId, type: 'circle', source: sourceId,
                    paint: hasCircle ? paints.circle : Object.assign({}, paints.circle, { 'circle-opacity': 0.85 })
                });
            } else {
                setPaint(circleId, hasCircle ? paints.circle : Object.assign({}, paints.circle, { 'circle-opacity': 0.85 }));
            }
            ids.push(circleId);
        }
        return ids;
    }

    /** Live 2D edits (colour chip, opacity slider) reach the 3D layer too. */
    function setPaint(layerId, paint) {
        Object.keys(paint || {}).forEach(function (key) {
            try { map.setPaintProperty(layerId, key, paint[key]); } catch (e) { /* ignore */ }
        });
    }

    function setLayout(layerId, layout) {
        Object.keys(layout || {}).forEach(function (key) {
            try { map.setLayoutProperty(layerId, key, layout[key]); } catch (e) { /* ignore */ }
        });
    }

    function renderVector(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        if (map.getSource(sourceId)) {
            try { map.getSource(sourceId).setData(item.geojson); } catch (e) { /* ignore */ }
        } else {
            map.addSource(sourceId, { type: 'geojson', data: item.geojson });
        }
        var layerIds = vectorLayersFor(entry, sourceId);
        state.status[entry.id] = { state: 'on', mode: 'direct', kind: 'vector', mirrored: true, label: item.label, features: (item.geojson.features || []).length };
        return { sourceIds: [sourceId], layerIds: layerIds, interactive: true };
    }

    function ensureImage(url, done) {
        if (!url) return null;
        var id = 'm3d-icon-' + String(url).replace(/[^A-Za-z0-9]/g, '_').slice(-64);
        if (state.images[id]) return id;
        if (state.pendingImages[id]) return null;
        state.pendingImages[id] = true;
        map.loadImage(url).then(function (image) {
            if (!state.pendingImages[id]) return;
            if (!map.hasImage(id)) {
                try { map.addImage(id, image.data); } catch (e) { /* ignore */ }
            }
            state.images[id] = true;
            delete state.pendingImages[id];
            if (done) done();
        }).catch(function () {
            delete state.pendingImages[id];
            state.images[id] = false;
        });
        return null;
    }

    function markerSourceData(item) {
        /* Markers are one source per layer so a big dataset stays one upload. */
        return item.geojson;
    }

    function renderMarkers(entry, tries) {
        tries = tries || 0;
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var data = markerSourceData(item);
        var feature = (data.features || [])[0];
        var iconSpec = feature && feature.properties && feature.properties.icon;
        var iconId = null;
        if (iconSpec && iconSpec.url) {
            iconId = ensureImage(iconSpec.url, function () { scheduleSync(); });
        }
        if (map.getSource(sourceId)) {
            try { map.getSource(sourceId).setData(data); } catch (e) { /* ignore */ }
        } else {
            map.addSource(sourceId, { type: 'geojson', data: data });
        }
        var ids = [];
        var circleId = entry.id + '-dot';
        var o = feature && feature.properties && feature.properties.paint;
        if (!map.getLayer(circleId)) {
            map.addLayer({
                id: circleId, type: 'circle', source: sourceId,
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#f59e0b',
                    'circle-stroke-color': '#1f2937',
                    'circle-stroke-width': 1.5,
                    'circle-opacity': iconId ? 0 : (item.opacity == null ? 0.95 : item.opacity)
                }
            });
        } else {
            map.setPaintProperty(circleId, 'circle-opacity', iconId ? 0 : (item.opacity == null ? 0.95 : item.opacity));
        }
        ids.push(circleId);
        if (iconId) {
            var symbolId = entry.id + '-icon';
            var layout = {
                'icon-image': iconId,
                'icon-size': 1,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-anchor': 'center',
                'icon-offset': (iconSpec.iconOffset && iconSpec.iconOffset.length === 2) ? iconSpec.iconOffset : [0, 0]
            };
            if (!map.getLayer(symbolId)) {
                map.addLayer({ id: symbolId, type: 'symbol', source: sourceId, layout: layout });
            } else {
                Object.keys(layout).forEach(function (k) {
                    try { map.setLayoutProperty(symbolId, k, layout[k]); } catch (e) { /* ignore */ }
                });
            }
            ids.push(symbolId);
        }
        var text = feature && feature.properties && feature.properties.tooltip;
        if (text && String(text).replace(/<[^>]*>/g, '').trim().length && String(text).length < 60) {
            var textId = entry.id + '-label';
            var textLayout = {
                'text-field': String(text).replace(/<[^>]*>/g, '').trim(),
                'text-size': 11,
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-allow-overlap': false,
                'text-optional': true
            };
            if (!map.getLayer(textId)) {
                map.addLayer({
                    id: textId, type: 'symbol', source: sourceId, layout: textLayout,
                    paint: { 'text-color': '#ffffff', 'text-halo-color': '#111827', 'text-halo-width': 1.2 }
                });
            }
            ids.push(textId);
        }
        state.status[entry.id] = { state: 'on', mode: 'direct', kind: 'marker', mirrored: true, label: item.label };
        return { sourceIds: [sourceId], layerIds: ids, interactive: true };
    }

    function renderCluster(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var spec = {
            type: 'geojson',
            data: item.geojson,
            cluster: true,
            clusterRadius: item.cluster.radius,
            clusterMaxZoom: Math.max(0, Math.min(20, item.cluster.maxZoom))
        };
        if (map.getSource(sourceId)) {
            try { map.getSource(sourceId).setData(item.geojson); } catch (e) { /* ignore */ }
            try { map.getSource(sourceId).setClusterOptions({ clusterRadius: spec.clusterRadius, clusterMaxZoom: spec.clusterMaxZoom }); } catch (e) { /* ignore */ }
        } else {
            map.addSource(sourceId, spec);
        }
        var ids = [];
        var ringId = entry.id + '-ring';
        var countId = entry.id + '-count';
        var dotId = entry.id + '-dot';
        if (!map.getLayer(ringId)) {
            map.addLayer({
                id: ringId, type: 'circle', source: sourceId, filter: ['has', 'point_count'],
                paint: {
                    'circle-color': '#2b6cb0',
                    'circle-opacity': 0.55,
                    'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 100, 24],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 1.2
                }
            });
            map.addLayer({
                id: countId, type: 'symbol', source: sourceId, filter: ['has', 'point_count'],
                layout: {
                    'text-field': ['get', 'point_count_abbreviated'],
                    'text-size': 11,
                    'text-allow-overlap': true
                },
                paint: { 'text-color': '#ffffff' }
            });
            map.addLayer({
                id: dotId, type: 'circle', source: sourceId, filter: ['!', ['has', 'point_count']],
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#f59e0b',
                    'circle-stroke-color': '#1f2937',
                    'circle-stroke-width': 1.2,
                    'circle-opacity': item.opacity == null ? 0.95 : item.opacity
                }
            });
        }
        ids.push(ringId, countId, dotId);
        state.status[entry.id] = {
            state: 'on', mode: 'direct', kind: 'cluster', mirrored: true,
            label: item.label, features: (item.geojson.features || []).length
        };
        return { sourceIds: [sourceId], layerIds: ids, interactive: true, clustered: true };
    }

    var popup = null;
    function showPopup(html, lngLat) {
        if (!html) return;
        try {
            if (!popup && MAPLIBRE && MAPLIBRE.Popup) {
                popup = new MAPLIBRE.Popup({ closeButton: true, maxWidth: '340px', className: 'm3d-popup' });
            }
            if (!popup) return;
            popup.setLngLat(lngLat).setHTML(html).addTo(map);
        } catch (e) { /* ignore */ }
    }

    function bindInteractions(entry, rendered) {
        if (!rendered.interactive || !rendered.layerIds) return;
        if (state.bound[entry.id] && state.bound[entry.id].join(',') === rendered.layerIds.join(',')) return;
        state.bound[entry.id] = rendered.layerIds.slice();
        rendered.layerIds.forEach(function (layerId) {
            map.on('click', layerId, function (event) {
                var feature = event.features && event.features[0];
                if (!feature) return;
                var props = feature.properties || {};
                if (rendered.clustered && props.cluster) {
                    var source = map.getSource(entry.id + '-src');
                    if (source && source.getClusterExpansionZoom) {
                        source.getClusterExpansionZoom(props.cluster_id).then(function (zoom) {
                            map.easeTo({ center: feature.geometry.coordinates, zoom: zoom });
                        }).catch(function () { /* ignore */ });
                    }
                    return;
                }
                var html = props.popup;
                if (!html && props.icon && props.icon.html) html = props.icon.html;
                if (!html) {
                    var keys = Object.keys(props).filter(function (k) { return k !== 'popup' && k !== 'icon'; });
                    if (!keys.length) return;
                    html = '<div class="m3d-popup-body">' + keys.slice(0, 12).map(function (k) {
                        return '<div><b>' + escapeHtml(k) + ':</b> ' + escapeHtml(String(props[k])).slice(0, 200) + '</div>';
                    }).join('') + '</div>';
                }
                showPopup(html, feature.geometry.coordinates.slice ? feature.geometry.coordinates : event.lngLat);
            });
            map.on('mouseenter', layerId, function () { map.getCanvas().style.cursor = 'pointer'; });
            map.on('mouseleave', layerId, function () { map.getCanvas().style.cursor = ''; });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  SYNC — mirror the 2D map into the 3D deck, then re-assert the order
     * ═══════════════════════════════════════════════════════════════════════ */
    function collectMirror() {
        var lmap = leafletMap();
        if (!lmap) return;
        var result = MIRROR.collect(lmap);
        state.mirror = result;
    }

    function syncLayers() {
        if (!map || !state.open) return;
        collectMirror();
        ensureBaseFallback();

        var p = plan();
        var wanted = {};
        p.entries.forEach(function (entry) { wanted[entry.id] = entry; });

        /* Remove what is gone (2D layer switched off / removed from the map). */
        Object.keys(state.rendered).forEach(function (id) {
            if (!wanted[id]) removeRendered(id);
        });

        p.entries.forEach(function (entry) {
            try {
                var rendered = null;
                if (entry.kind === 'registry') {
                    rendered = renderRegistryRaster(entry);
                } else if (entry.kind === 'raster') {
                    rendered = renderRaster(entry);
                } else if (entry.kind === 'image') {
                    rendered = renderImage(entry);
                } else if (entry.kind === 'vector') {
                    rendered = renderVector(entry);
                } else if (entry.kind === 'markers') {
                    rendered = renderMarkers(entry);
                } else if (entry.kind === 'cluster') {
                    rendered = renderCluster(entry);
                } else if (entry.kind === 'heat') {
                    rendered = renderHeat(entry);
                } else {
                    state.status[entry.id] = { state: 'unsupported', reason: entry.item && entry.item.reason };
                    return;
                }
                if (rendered) {
                    state.rendered[entry.id] = rendered;
                    entry.layerIds = rendered.layerIds;
                    bindInteractions(entry, rendered);
                }
            } catch (e) {
                state.status[entry.id] = { state: 'unsupported', reason: String((e && e.message) || e) };
                pushError(entry.id + ': ' + ((e && e.message) || e));
            }
        });

        applyDeck(p);
        watchSourceHealth();
        syncAttribution();
        renderStatus();
        state.lastSync = Date.now();
    }

    /**
     * The one place the 3D stack is decided:
     *
     *   background ▸ base map ▸ hillshade ▸ every 2D layer in its pane order ▸
     *   vectors ▸ markers/labels/clusters ▸ heatmaps ▸ image overlays
     *
     * Pure function of what exists — `entries` are already sorted by the 2D
     * pane z-index — so the order is re-asserted the same way after every
     * basemap switch, style reload or toggle. Exposed for the tests.
     */
    function computeDeckOrder(entries, present, hillshadeIds, baseEntryId) {
        var order = [];
        if (present['m3d-background']) order.push('m3d-background');
        var inserted = false;
        entries.slice().sort(function (a, b) {
            var za = a.z == null ? 1000 : a.z;
            var zb = b.z == null ? 1000 : b.z;
            if (za !== zb) return za - zb;
            return (a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq);
        }).forEach(function (entry) {
            (entry.layerIds || [entry.id]).forEach(function (id) {
                if (present[id]) order.push(id);
            });
            if (!inserted && baseEntryId && entry.id === baseEntryId) {
                (hillshadeIds || []).forEach(function (id) {
                    if (present[id]) order.push(id);
                });
                inserted = true;
            }
        });
        if (!inserted) {
            /* No basemap visible: the hillshade still sits on top of nothing
             * else — right after the background, under every layer. */
            var at = order.indexOf('m3d-background') + 1;
            (hillshadeIds || []).reverse().forEach(function (id) {
                if (present[id]) order.splice(at, 0, id);
            });
        }
        var seen = {};
        return order.filter(function (id) {
            if (seen[id]) return false;
            seen[id] = true;
            return true;
        });
    }

    /** Deterministic stacking: bottom → top, re-asserted with beforeId. */
    function applyDeck(p) {
        if (!map) return;
        var present = {};
        ['m3d-background', 'm3d-hillshade', 'm3d-hillshade-service'].forEach(function (id) {
            present[id] = !!map.getLayer(id);
        });
        var entries = p.entries.slice().sort(function (a, b) {
            if (a.z !== b.z) return a.z - b.z;
            return a.seq - b.seq;
        });
        entries.forEach(function (entry) {
            (entry.layerIds || [entry.id]).forEach(function (id) {
                if (map.getLayer(id)) present[id] = true;
            });
        });

        var order = computeDeckOrder(
            entries.map(function (entry) {
                return { id: entry.id, layerIds: entry.layerIds || [entry.id], z: entry.z, seq: entry.seq };
            }),
            present,
            ['m3d-hillshade', 'm3d-hillshade-service'],
            p.baseEntryId
        );

        for (var i = order.length - 1; i >= 0; i -= 1) {
            var above = i === order.length - 1 ? null : order[i + 1];
            try { map.moveLayer(order[i], above || undefined); } catch (e) { /* ignore */ }
        }
        state.deckOrder = order;
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
                if (!entry || entry.state !== 'on') return;
                if (entry.mode !== 'direct' || entry.kind === 'image-overlay') return;
                if (state.loadedSources[id] || state.loadedSources[id + '-src']) return;
                var host = hostOfUrl(entry.url || (state.rendered[id] && state.rendered[id].url) || '');
                if (!host) {
                    var item = (state.mirror.items || []).filter(function (i) { return 'm3d-2d-' + i.key === id; })[0];
                    if (item && item.template) host = hostOfUrl(item.template) || '';
                }
                if (!host || state.proxyHosts[host]) return;
                entry.mode = 'proxy';
                entry.healed = true;
                console.warn('[Map3D] No direct tile for ' + id + ' — retrying via ' + proxyBase());
                healHost(host, id);
            });
            renderStatus();
        }, 7000);
        state.healthTimers.push(timer);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  STATUS PANEL
     * ═══════════════════════════════════════════════════════════════════════ */
    function renderStatus() {
        var box = document.getElementById('map3d-status');
        if (!box) return;
        var on = Object.keys(state.status).filter(function (id) {
            return state.status[id] && (state.status[id].state === 'on' || state.status[id].state === 'unsupported');
        });
        var rows = [];
        if (!on.length) rows.push('<div class="m3d-st">' + escapeHtml(t('noLayers')) + '</div>');

        var sorted = on.sort(function (a, b) {
            var za = state.status[a].paneZ == null ? 999 : state.status[a].paneZ;
            var zb = state.status[b].paneZ == null ? 999 : state.status[b].paneZ;
            return za - zb;
        });
        sorted.forEach(function (id) {
            var entry = state.status[id];
            var label = entry.label || id;
            if (entry.state === 'unsupported') {
                rows.push('<div class="m3d-st is-bad"><b>' + escapeHtml(label) + '</b> — ' +
                    escapeHtml(t('unsupported')) + (entry.reason ? ': ' + escapeHtml(entry.reason) : '') + '</div>');
                return;
            }
            var mode = entry.mode === 'proxy' ? t('viaProxy')
                : (entry.perTile ? t('perTile')
                    : (entry.mode === 'live 2D layer' ? (lang() === 'ro' ? 'strat 2D' : 'live 2D layer') : t('direct')));
            rows.push('<div class="m3d-st' + (entry.mode === 'proxy' ? ' is-proxy' : '') + '"><b>' +
                escapeHtml(label) + '</b> — ' + escapeHtml(mode) +
                (entry.features ? ' · ' + entry.features + (lang() === 'ro' ? ' elemente' : ' features') : '') + '</div>');
        });

        /* A mirrored layer whose tile URL could not be built is reported with
         * the reason instead of vanishing (the 2D map may still draw it — a
         * canvas layer, for instance — but the 3D view must say so). */
        var failures = MIRROR.errors ? MIRROR.errors() : {};
        Object.keys(failures).forEach(function (key) {
            var item = (state.mirror.items || []).filter(function (i) { return i.key === key; })[0];
            if (item) {
                rows.push('<div class="m3d-st is-bad"><b>' + escapeHtml(item.label || key) + '</b> — ' +
                    escapeHtml(failures[key]) + '</div>');
            }
        });
        var terrain = terrainSource();
        rows.push('<div class="m3d-sum">' + escapeHtml(terrain.label) + ' · ' +
            state.exaggeration.toFixed(1) + '× · ' + on.length + ' ' +
            escapeHtml(lang() === 'ro' ? 'straturi active' : 'active layers') +
            ' · ' + escapeHtml(t('mirrored')) + '</div>');
        box.innerHTML = rows.join('');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function pushError(message) {
        state.errors.push({ message: String(message).slice(0, 200) });
        if (state.errors.length > 40) state.errors.shift();
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
                cooperativeGestures: false
            };
            map = new maplibre.Map(options);
            if (!state.open) {                    /* closed while the SDK was loading */
                try { map.remove(); } catch (e) { /* ignore */ }
                map = null;
                return false;
            }
            map.touchZoomRotate.enableRotation();
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

            /* The deck is not gated on a single event: 'load' waits for the DEM,
             * so a slow/unreachable elevation model would hide every layer.
             * styledata fires as soon as the style is up, `loaded()` polling
             * covers the rest. */
            function firstSync() {
                hideVeil();
                if (terrainSource().missingKey) {
                    console.warn('[Map3D] Terrain provider needs an API key — running without terrain.');
                }
                collectMirror();
                syncLayers();
                startPanelWatcher();
            }
            map.on('styledata', function () { if (!state.firstSyncDone) { state.firstSyncDone = true; firstSync(); } });
            map.on('load', firstSync);
            map.on('idle', function () { hideVeil(); });
            map.on('moveend', function () {
                if (bar && bar.paintLabels) bar.paintLabels();
                scheduleSync();
            });
            map.on('sourcedata', function (event) {
                if (event.sourceId && event.isSourceLoaded) state.loadedSources[event.sourceId] = true;
            });
            map.on('error', function (event) {
                var message = String((event && event.error && event.error.message) || (event && event.error) || '');
                if (/terrain|dem/i.test(message)) {
                    console.warn('[Map3D] Terrain source error: ' + message);
                }
                pushError(message);
            });
            /* Safety: whatever happens to the DEM, the layers appear. */
            root.setTimeout(function () { if (state.open && map && !state.firstSyncDone) firstSync(); }, 2500);
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
        state.firstSyncDone = false;
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
        state.rendered = {};
        state.bound = {};
        state.images = {};
        state.pendingImages = {};
        popup = null;
        document.body.classList.remove('is-3d');
        refreshToggle();
        return true;
    }

    function toggle() {
        return state.open ? close() : open();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  WATCHERS — the 2D map and the 2D panel are the single source of truth
     * ═══════════════════════════════════════════════════════════════════════ */
    function onPanelEvent(event) {
        if (!state.open) return;
        var target = event.target;
        if (!target || !target.tagName) return;
        var tag = String(target.tagName).toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'button') return;
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

    function attachLeafletWatchers() {
        var lmap = leafletMap();
        if (!lmap || state.leafletWatched === lmap) return;
        if (state.leafletWatched && state.leafletWatched.off) {
            try {
                state.leafletWatched.off('layeradd', scheduleSync);
                state.leafletWatched.off('layerremove', scheduleSync);
                state.leafletWatched.off('moveend', scheduleSync);
            } catch (e) { /* ignore */ }
        }
        state.leafletWatched = lmap;
        try {
            lmap.on('layeradd', scheduleSync);
            lmap.on('layerremove', scheduleSync);
            lmap.on('moveend', scheduleSync);
            lmap.on('zoomend', scheduleSync);
        } catch (e) { /* ignore */ }
    }

    function startPanelWatcher() {
        document.addEventListener('change', onPanelEvent, true);
        document.addEventListener('input', onPanelEvent, true);
        document.addEventListener('click', onPanelEvent, true);
        attachLeafletWatchers();
        if (state.pollTimer) root.clearInterval(state.pollTimer);
        state.pollTimer = root.setInterval(function () {
            if (!state.open) return;
            attachLeafletWatchers();
            var result = MIRROR.collect(leafletMap() || {});
            var signature = result.signature;
            if (signature !== state.signature) {
                state.signature = signature;
                syncLayers();
            }
        }, 1500);
    }

    function stopPanelWatcher() {
        document.removeEventListener('change', onPanelEvent, true);
        document.removeEventListener('input', onPanelEvent, true);
        document.removeEventListener('click', onPanelEvent, true);
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
            deckOrder: state.deckOrder || [],
            mirrored: state.mirror.items.map(function (item) {
                return { id: 'm3d-2d-' + item.key, kind: item.kind, z: item.z, opacity: item.opacity, label: item.label, live: !!item.layer };
            }),
            unsupported3d: state.mirror.unsupported,
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
                    reason: entry ? (entry.reason || null) : null,
                    mirrored: !!(entry && entry.mirrored),
                    notes: def.notes || ''
                };
                if (def.runtimeOverlays) {
                    status3d.kind = 'image-overlay (runtime)';
                    status3d.active3d = (state.mirror.items || []).some(function (i) { return i.kind === 'image'; });
                }
                return status3d;
            }),
            dynamic: Object.keys(state.status).filter(function (id) {
                return id.indexOf('m3d-corona-') === 0 || id.indexOf('m3d-overlay-') === 0;
            }),
            errors: state.errors.slice(-8)
        };
    }

    function report() {
        var data = status();
        var rows = data.mirrored.map(function (layer) {
            var status3d = state.status[layer.id] || {};
            return {
                drawn: layer.id,
                kind: layer.kind,
                z: layer.z,
                opacity: layer.opacity,
                mode: status3d.mode || '',
                label: layer.label || ''
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
        status: status,
        report: report,
        registry: REGISTRY,
        mirror: MIRROR,
        /* kept for the automated tests: build the style without a GPU */
        _buildStyle: function () { return buildStyle(root.maplibregl || {}); },
        _deckOrder: computeDeckOrder,
        _mirror: function () { collectMirror(); return state.mirror; },
        _fetchTile: fetchTile
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
