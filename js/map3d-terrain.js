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
    var openGeneration = 0;
    var map = null;
    var surface = null;
    var veil = null;
    var bar = null;
    var toggleGroup = null;
    var toggleBtn = null;
    var refreshBtn = null;
    var refreshIcon = null;
    var refreshCount = null;
    var refreshStatus = null;
    var refreshJob = null;
    var refreshStatusTimer = null;

    var state = {
        open: false,
        engine: 'maplibre',
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
        /* What the deck already has: re-uploading or reloading any of it on the
         * next sync is what made 3D crawl (§6 of MAP_3D_TERRAIN.md). */
        sourceData: {},                  /* sourceId → the GeoJSON already uploaded */
        sourceTiles: {},                 /* sourceId → the tile template already loaded */
        blendCache: {},                  /* url → repainted tile bytes             */
        blendWarned: false,              /* the repaint failure was already reported */
        cappedSeen: {},                  /* deck-budget lines already reported     */
        retintedTiles: 0,                /* tiles repainted for a CSS blend mode   */
        /* ── LiDAR focus (js/lidar-3d-focus.js) ──────────────────────────────
         * The LiDAR layers the user chose may be draped in 3D — every one of
         * them, either entirely (scope 'full') or only inside the 1 km disc
         * that was picked and prefetched for them (scope 'disc').
         * state.focus is that decision, state.lidarOff means “the user removed
         * LiDAR from 3D”, and state.primed is the tile cache the prefetch
         * filled (see prefetchTiles below). */
        focus: null,                     /* { scope, layers[], mask?, bounds?, plan? } */
        lidarOff: false,                 /* LiDAR deliberately not drawn in 3D     */
        lidarNotes: [],                  /* what had to be left out, and why       */
        focusWarned: null,                /* the focus-not-drawn reason already reported */
        primed: {},                      /* url → raw bytes the prefetch downloaded */
        primedOut: {},                   /* url → { sig, data } after blend + clip  */
        primedLayer: {},                 /* url → the layer key it was prepared for */
        primedOrder: [],                 /* FIFO eviction order                     */
        primedBytes: 0,
        primedHits: 0,
        prefetching: false,
        prefetchCount: 0,
        /* The entry gate: an async function the LiDAR focus installs so that
         * pressing “3D” on a map with a LiDAR layer on can ask first. */
        entryGate: null,
        gateRunning: null,
        pendingImages: {},
        supported: {},                   /* resolved host policy cache           */
        lastSync: 0,
        syncTimer: null,
        healthTimers: [],
        pollTimer: null,
        protocols: false,                /* dl2d:// + dl3d:// registered         */
        errors: [],
        failed: false,                   /* last open() ended in an error        */
        safeMode: false,                 /* first GL context was refused         */
        contextLost: false,              /* GPU context reclaimed by the system  */
        resumeWatched: false,            /* visibilitychange/pageshow wired once */
        lastError: '',                   /* exact message, for the user to quote */
        probe: null                      /* memoised webglProbe() result         */
    };

    function isMobile() {
        try {
            return (root.matchMedia && root.matchMedia('(max-width: 768px)').matches) ||
                (navigator && navigator.maxTouchPoints > 1);
        } catch (e) { return false; }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  MOBILE / WEBGL CAPABILITY
     * -----------------------------------------------------------------------
     *  WHY THIS BLOCK EXISTS — the mobile “3D flashes and snaps back to 2D”
     *  bug, root-caused against the vendored MapLibre GL 5.24.0:
     *
     *    new maplibregl.Map(...) creates its WebGL2 context inside the
     *    constructor and THROWS SYNCHRONOUSLY when the context cannot be
     *    allocated:
     *
     *        i = canvas.getContext("webgl2", e) || canvas.getContext("webgl", e)
     *        if (!i) throw new Error("Failed to initialize WebGL")
     *
     *  On iOS Safari that happens on real hardware. The context used to be
     *  requested at the full devicePixelRatio (3 on a Face-ID iPhone →
     *  ~1170×2532 ≈ 3 Mpx) with powerPreference 'high-performance', after the
     *  page already holds every Leaflet tile image; WebKit refuses the
     *  allocation and returns null. Desktop GPUs never hit that ceiling, which
     *  is why the same build worked on a laptop and failed on a phone.
     *
     *  The throw landed in open()'s catch, which removed `body.is-3d` — and
     *  that class is what makes #map3d-surface display at all. So the surface
     *  containing the error message was hidden by the very code trying to show
     *  it: all the user ever saw was the dark rectangle flash once and vanish.
     *
     *  Three changes, in order of importance:
     *    1. ask for a small, low-power context from the FIRST call (§deviceProfile);
     *    2. probe WebGL before spending 1 MB on the SDK, and retry in a
     *       stripped-down “safe mode” if the first context is refused (§open);
     *    3. keep the surface — and the message — on screen when 3D fails (§fail3D).
     * ═══════════════════════════════════════════════════════════════════════ */
    function perf() { return REGISTRY.config().perf || {}; }

    /** Everything the MapLibre constructor must do differently on a phone. */
    function deviceProfile() {
        var p = perf();
        if (!isMobile()) {
            return {
                mobile: false,
                pixelRatio: null,            /* null → let MapLibre read devicePixelRatio */
                maxTileCacheSize: p.maxTileCacheSize || 320,
                maxCanvasSize: null,         /* null → MapLibre's own 4096² ceiling */
                canvasContextAttributes: {
                    antialias: true,
                    powerPreference: 'high-performance',
                    failIfMajorPerformanceCaveat: false,
                    preserveDrawingBuffer: false
                }
            };
        }
        return {
            mobile: true,
            /* Passed INTO the constructor rather than applied afterwards with
             * setPixelRatio(): the first GL context is then created small
             * instead of being created at ×3 and shrunk once it already exists
             * — by which point WebKit has already said no. */
            pixelRatio: p.mobilePixelRatio || 1,
            /* 64 tiles was enough for a 2D-sized deck, not for a pitched disc:
             * at z17+ the visible set (parents, children, the raster and the
             * DEM around it) is well over a hundred, so the cache evicted
             * tiles the user was looking at and every pinch re-requested them
             * through dl2d://. 160 keeps a prepared disc resident while still
             * well under the desktop's 320. */
            maxTileCacheSize: Math.max(MOBILE_TILE_CACHE, Number(p.mobileMaxTileCacheSize) || 0),
            maxCanvasSize: (p.mobileMaxCanvas && p.mobileMaxCanvas.length === 2)
                ? p.mobileMaxCanvas : [2048, 2048],
            canvasContextAttributes: {
                antialias: false,            /* 4× MSAA quadruples the colour buffer */
                powerPreference: 'low-power',
                failIfMajorPerformanceCaveat: false,
                preserveDrawingBuffer: false
            }
        };
    }

    /** Free a probe context so it does not eat the browser's context budget. */
    function releaseGl(gl) {
        try {
            var ext = gl.getExtension('WEBGL_lose_context') || gl.getExtension('WEBKIT_lose_context');
            if (ext && ext.loseContext) ext.loseContext();
        } catch (e) { /* a leaked probe is a nuisance, never a failure */ }
    }

    /**
     * Does this browser do WebGL at all, and which flavour? A throwaway 32×32
     * canvas: creating it costs nothing, and releasing it keeps it out of the
     * handful of contexts WebKit allows at once — a leaked probe context could
     * itself be the reason the real one is refused.
     */
    function webglProbe(force) {
        /* Memoised: status() call this on every repaint. open()
         * passes force=true because a device that refused a context minutes
         * ago may well grant one now. */
        if (!force && state.probe) return state.probe;
        var result = { webgl2: false, webgl: false, error: '' };
        try {
            var canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            var attrs = { antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: false };
            var gl = null;
            try { gl = canvas.getContext('webgl2', attrs); } catch (e) { gl = null; }
            if (gl) { result.webgl2 = true; releaseGl(gl); state.probe = result; return result; }
            try {
                gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
            } catch (e) { gl = null; }
            if (gl) { result.webgl = true; releaseGl(gl); state.probe = result; return result; }
            result.error = 'canvas.getContext("webgl2"/"webgl") returned null';
            state.probe = result;
            return result;
        } catch (e) {
            result.error = String((e && e.message) || e);
            state.probe = result;
            return result;
        }
    }

    /* The registry's `perf.mobileMaxTileCacheSize` default (64) predates the
     * LiDAR disc: it was sized for a phone-sized 2D deck. A pitched 3D view
     * over a 1 km disc at z17 shows well over a hundred tiles — parents,
     * children, the raster and the DEM — and at 64 MapLibre evicted tiles the
     * user was looking at, so every pinch re-requested them through dl2d://.
     * The profile raises it; a deployment may still ask for more. */
    var MOBILE_TILE_CACHE = 160;

    /* window._currentLang is a FUNCTION installed by js/translations.js; reading
     * it as a string (which this used to do) silently landed on COPY.en, so the
     * Romanian copy below was unreachable. */
    function lang() {
        try {
            if (typeof root._currentLang === 'function') {
                var value = root._currentLang();
                if (typeof value === 'string' && /^(ro|en)/i.test(value)) return /^en/i.test(value) ? 'en' : 'ro';
            } else if (typeof root._currentLang === 'string' && /^(ro|en)/i.test(root._currentLang)) {
                return /^en/i.test(root._currentLang) ? 'en' : 'ro';
            }
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
            refreshTitle: 'Încarcă tile-urile active pe o rază de 1 km în jurul centrului 3D',
            refreshProgress: 'Se încarcă tile-uri: {done}/{total}',
            refreshStopping: 'Se oprește pregătirea tile-urilor: {done}/{total}',
            refreshDone: 'Tile-uri pregătite: {prepared}/{total}; eșuate: {failed}',
            refreshStopped: 'Pregătire oprită: {prepared} pregătite, {failed} eșuate din {total}',
            refreshNoLayers: 'Nu există tile-uri raster non-LiDAR active în zona aceasta',
            refreshUnavailable: 'Centrul hărții 3D nu este disponibil',
            refreshBusy: 'O altă pregătire de tile-uri este deja în curs',
            refreshStop: 'Oprește pregătirea tile-urilor',
            title: 'Vedere 3D',
            loading: 'Se încarcă vederea 3D…',
            loadingDetail: 'Se descarcă MapLibre GL și modelul de elevație.',
            failed: 'Vederea 3D nu a putut porni.',
            failedDetail: 'Biblioteca 3D nu s-a putut încărca. Harta 2D funcționează în continuare.',
            retry: 'Încearcă din nou',
            back: 'Înapoi la 2D',
            noWebgl: 'Acest dispozitiv nu poate afișa harta 3D',
            noWebglDetail: 'Safari nu a putut crea un context WebGL — de obicei memoria este ocupată de harta 2D. Închide alte file sau reîncarcă pagina și încearcă din nou.',
            contextLost: 'Contextul 3D a fost pierdut',
            contextLostDetail: 'Sistemul a eliberat memoria grafică (aplicatia a trecut în fundal sau memoria era plină). Reluăm desenarea.',
            safeMode: 'mod avansat (calitate redusă)',
            pitch: 'Înclinare',
            bearing: 'Rotație',
            basemap: 'Hartă de bază',
            basemapImagery: 'Imagery ArcGIS',
            basemapTopographic: 'Topographic ArcGIS',
            basemapTerrain: 'Terrain ArcGIS',
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
            refreshTitle: 'Load active tiles within 1 km of the current 3D center',
            refreshProgress: 'Loading tiles: {done}/{total}',
            refreshStopping: 'Stopping tile preparation: {done}/{total}',
            refreshDone: 'Tiles ready: {prepared}/{total}; failed: {failed}',
            refreshStopped: 'Preparation stopped: {prepared} ready, {failed} failed of {total}',
            refreshNoLayers: 'No active non-LiDAR raster tiles cover this area',
            refreshUnavailable: 'The 3D map center is unavailable',
            refreshBusy: 'Another tile preparation is already running',
            refreshStop: 'Stop tile preparation',
            title: '3D view',
            loading: 'Loading the 3D view…',
            loadingDetail: 'Fetching MapLibre GL and the elevation model.',
            failed: 'The 3D view could not start.',
            failedDetail: 'The 3D library could not be loaded. The 2D map keeps working.',
            retry: 'Try again',
            back: 'Back to 2D',
            noWebgl: 'This device cannot show the 3D map',
            noWebglDetail: 'Safari could not create a WebGL context — usually because the 2D map is already using the available graphics memory. Close other tabs or reload the page and try again.',
            contextLost: 'The 3D context was lost',
            contextLostDetail: 'The system released the graphics memory (the app went to the background, or memory ran low). Redrawing.',
            safeMode: 'safe mode (reduced quality)',
            pitch: 'Pitch',
            bearing: 'Bearing',
            basemap: 'Base map',
            basemapImagery: 'Imagery ArcGIS',
            basemapTopographic: 'Topographic ArcGIS',
            basemapTerrain: 'Terrain ArcGIS',
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
        /* 1 MB of JS on a phone over cellular: the desktop timeout is far too
         * tight there, and a timeout is indistinguishable from a crash. */
        var timeoutMs = isMobile() ? (cfg.timeoutMsMobile || cfg.timeoutMs || 15000)
            : (cfg.timeoutMs || 15000);
        /* Keep one shared download, including its bounded retry. Failed script
         * nodes must not survive to execute alongside the next attempt. */
        function attempt(number) {
            return new Promise(function (resolve, reject) {
                var script = null;
                var settled = false;
                var timer = root.setTimeout(function () {
                    finish(new Error('Timed out loading MapLibre GL after ' + timeoutMs + 'ms'));
                }, timeoutMs);
                function finish(error) {
                    if (settled) return;
                    settled = true;
                    root.clearTimeout(timer);
                    if (script) {
                        script.onload = script.onerror = null;
                        if (script.parentNode) script.parentNode.removeChild(script);
                    }
                    var ns = root[cfg.namespace || 'maplibregl'];
                    if (ns && typeof ns.Map === 'function') {
                        MAPLIBRE = ns;
                        resolve(ns);
                    } else {
                        reject(error || new Error('MapLibre GL did not expose maplibregl.Map'));
                    }
                }
                if (root[cfg.namespace || 'maplibregl'] && typeof root[cfg.namespace || 'maplibregl'].Map === 'function') {
                    finish();
                    return;
                }
                if (cfg.css && !document.getElementById('map3d-sdk-css')) {
                    var link = document.createElement('link');
                    link.id = 'map3d-sdk-css';
                    link.rel = 'stylesheet';
                    link.href = cfg.css;
                    (document.head || document.documentElement).appendChild(link);
                }
                script = document.createElement('script');
                script.src = cfg.js;
                script.async = true;
                script.onload = function () { finish(); };
                script.onerror = function () {
                    finish(new Error('MapLibre GL could not be loaded from ' + cfg.js));
                };
                (document.head || document.documentElement).appendChild(script);
            }).catch(function (error) {
                if (number >= 2) throw error;
                return new Promise(function (resolve) { root.setTimeout(resolve, 500); })
                    .then(function () { return attempt(number + 1); });
            });
        }
        sdkPromise = attempt(1).catch(function (error) {
            sdkPromise = null;
            throw error;
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
        /* A host the registry documents as CORS-serving (“never” through the
         * proxy — the ArcGIS tile hosts above all, tiles.arcgis.com serving
         * the Romanian 1 m / 2–5 m LiDAR pyramids) is never rerouted, whatever
         * a runtime verdict says. One misread failure used to send those
         * pyramids through the proxy for the rest of the session, where a
         * cold function answers blank tiles and the prepared disc “loads” as
         * nothing but the base map. The declaration wins. */
        if (registryHostPolicy(host) === 'never') return false;
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
        /* Declared CORS hosts are never healed onto the proxy (shouldProxy
         * would ignore the verdict anyway — keep both honest). */
        if (registryHostPolicy(host) === 'never') return;
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
                if (setSourceTiles(sourceId, source.tiles.slice(), true)) retried += 1;
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

    /** Did the service answer with an HTTP status (rather than fail the fetch)? */
    function answeredWithStatus(error) {
        return !!(error && /^\d{3}\s+for\s/.test(String(error.message || '')));
    }

    /** A request the caller cancelled — never a verdict about the host.
     * MapLibre aborts tile loads whenever the camera moves or a source
     * reloads, and the prefetch aborts its own tiles at its 45 s deadline;
     * both arrive here as an AbortError, indistinguishable from a genuine
     * network failure unless the name is checked. */
    function isAbortError(error) {
        return !!(error && (error.name === 'AbortError' || error.code === 20));
    }

    /** Fetch one tile, healing a host that turns out to have no CORS. */
    /* ═══════════════════════════════════════════════════════════════════════
     *  PREFETCHED TILES — the LiDAR focus disc
     * -----------------------------------------------------------------------
     *  A LiDAR hillshade is heavy (a 1 m ArcGIS tile is tens of kilobytes, and
     *  the same tiles are what MapLibre decodes into a texture), so opening 3D
     *  over one used to show a half-drawn sheet while a pyramid of tiles the
     *  user may never look at was being fetched. js/lidar-3d-focus.js therefore
     *  asks for a point, downloads exactly the tiles of that disc (one fixed
     *  1 km radius — see MAP_3D_TERRAIN.md §6.4 for why the distance choice
     *  went away), and only then lets 3D open.
     *
     *  What is downloaded is kept HERE, in memory, keyed by upstream URL:
     *    state.primed[url]     – what the service sent (never re-downloaded)
     *    state.primedOut[url]  – { sig, data } after the CSS-blend repaint and
     *                            the disc clip, i.e. the exact bytes MapLibre
     *                            is handed (never re-encoded either)
     *  The cache is byte-budgeted and FIFO-evicted, lives across 3D sessions
     *  (closing 3D and opening it again on the same disc is instant) and is
     *  dropped tile by tile when the focus moves or closes.
     * ═══════════════════════════════════════════════════════════════════════ */
    var PRIME_DESKTOP = { entries: 2400, bytes: 96 * 1024 * 1024 };
    /* A 1 km disc prepared to a z18 native maximum is ~480 tiles, and every
     * one is held twice (the bytes the service sent + the clipped/repainted
     * copy the deck is handed). 900/28 MB could not hold that: the oldest
     * entries were evicted while the prefetch was still running, and a zoom
     * back out or in re-requested them. 1400/48 MB holds the deepest disc a
     * phone is likely to meet without approaching desktop's 96 MB. */
    var PRIME_MOBILE = { entries: 1400, bytes: 48 * 1024 * 1024 };

    function primeBudget() { return isMobile() ? PRIME_MOBILE : PRIME_DESKTOP; }

    function primeBytesOf(data) {
        if (!data) return 0;
        if (typeof data.byteLength === 'number') return data.byteLength;
        return 0;
    }

    /** The bytes the service sent for this tile, or null. */
    function primedRaw(url) {
        var hit = url ? state.primed[url] : null;
        if (!hit) return null;
        state.primedHits += 1;
        return hit;
    }

    /**
     * The finished bytes (blend repainted, disc clipped) for this tile, or null.
     * `sig` is the pipeline signature: a tile of a layer whose blend/clip
     * changed is recomputed from the raw bytes instead of being reused.
     */
    function primedOutput(url, sig) {
        var hit = url ? state.primedOut[url] : null;
        if (!hit || hit.sig !== (sig || '')) return null;
        state.primedHits += 1;
        return hit.data;
    }

    function primedPut(url, data, output, sig) {
        if (!url || !data) return;
        var store = output ? state.primedOut : state.primed;
        var entry = output ? { sig: sig || '', data: data } : data;
        var previous = store[url];
        if (previous) {
            state.primedBytes -= primeBytesOf(previous.data || previous);
        } else if (!state.primed[url] && !state.primedOut[url]) {
            /* One FIFO slot per tile, not per store. A tile whose bytes were
             * repainted for the relief is the same tile: counting it twice made
             * the bar's “N tiles ready” and status().lidar.primed.entries say
             * double, and cost the cache half its budget before it evicted. */
            state.primedOrder.push(url);
        }
        store[url] = entry;
        state.primedBytes += primeBytesOf(data);
        var budget = primeBudget();
        while (state.primedOrder.length > budget.entries || state.primedBytes > budget.bytes) {
            var oldest = state.primedOrder.shift();
            if (oldest === undefined) break;
            var raw = state.primed[oldest];
            var out = state.primedOut[oldest];
            if (raw) { state.primedBytes -= primeBytesOf(raw); delete state.primed[oldest]; }
            if (out) { state.primedBytes -= primeBytesOf(out.data); delete state.primedOut[oldest]; }
        }
    }

    /** Forget prefetched tiles (no filter = all of them). */
    function clearPrimed(filter) {
        state.primedOrder.slice().forEach(function (url) {
            if (filter && !filter(url)) return;
            var raw = state.primed[url];
            var out = state.primedOut[url];
            if (raw) state.primedBytes -= primeBytesOf(raw);
            if (out) state.primedBytes -= primeBytesOf(out.data);
            delete state.primed[url];
            delete state.primedOut[url];
            var at = state.primedOrder.indexOf(url);
            if (at !== -1) state.primedOrder.splice(at, 1);
        });
        if (state.primedBytes < 0) state.primedBytes = 0;
        return true;
    }

    function fetchTile(url, abortController, options) {
        options = options || {};
        /* Already downloaded for this very tile? Then there is no request to
         * make — this is what makes the prefetched disc appear instantly. */
        if (!options.force) {
            var primed = primedRaw(url);
            if (primed) return Promise.resolve({ data: primed });
        }
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
        /* Mirrored WMS layers: 2D Leaflet loads them as plain <img> (no CORS
         * needed), so most WMS hosts have never had to send CORS headers.
         * Trying direct first cost every tile of the first wave a failed
         * fetch + retry through the proxy — the "WMS crawls in 3D" report.
         * The dl2d handler flags those (preferProxy): one proxied request
         * per tile from the start, direct kept as fallback if the proxy
         * refuses the host (403 = not on its allow-list). */
        if (options.preferProxy && proxyBase()) useProxy = true;
        var target = useProxy ? proxiedUrl() : url;
        /* A “blank” from the proxy is an upstream failure wearing a 200 (a
         * 1×1 transparent PNG + X-Map3D-Tile: blank): fine to hand MapLibre
         * for one frame, but the caller must know — cached as if it were the
         * tile, it turns into a permanently invisible piece of the disc, and
         * counted by the prefetch it is a “prepared” tile that does not
         * exist. fetchTile flags it; the caches stay out of it (below). */
        var blankTile = false;
        function noteBlank(response) {
            if (response && response.headers && response.headers.get('X-Map3D-Tile') === 'blank') {
                blankTile = true;
                if (!state.blankWarned[target]) {
                    state.blankWarned[target] = true;
                    pushError('proxy returned a blank tile (' + (response.headers.get('X-Map3D-Upstream') || '?') +
                        ') for ' + url.slice(0, 120));
                }
            }
        }
        return root.fetch(target, { mode: 'cors', credentials: 'omit', signal: signal })
            .then(function (response) {
                if (response && response.ok) {
                    noteBlank(response);
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
                /* A cancelled request is not a CORS verdict either: MapLibre
                 * aborts tile loads on every camera move and source reload,
                 * and the prefetch aborts its own tiles at its deadline.
                 * Reading an abort as “no CORS” moved tiles.arcgis.com onto
                 * the proxy for the whole browser session (sessionStorage
                 * included) and then retried with the same dead signal, so
                 * the tile failed anyway and every later tile of the
                 * Romanian LiDAR pyramids paid the proxy hop — where a cold
                 * function answers blanks and the layer “never loads” (the
                 * “Romania 1m/pixel agregare appears for a moment, then only
                 * the base map is visible” report). Nobody is waiting for
                 * this tile any more: let the abort be an abort. */
                if (isAbortError(error)) throw error;
                /* The service ANSWERED (a 404 for a tile beyond its coverage, a
                 * 500, …): that is not a CORS verdict. Treating every HTTP
                 * error as “no CORS” moved whole hosts onto the proxy for the
                 * rest of the session, and a tile the service simply does not
                 * have then cost an extra hop — or, where the proxy refuses the
                 * host, turned into a hole in the terrain. */
                if (answeredWithStatus(error)) throw error;
                if (useProxy && !options.proxyUrl) {
                    /* Proxy refused/unreachable: a CORS-enabled upstream can
                     * still serve the tile directly — better than a hole. */
                    return root.fetch(url, { mode: 'cors', credentials: 'omit', signal: signal });
                }
                if (!useProxy && proxyBase() && host && registryHostPolicy(host) !== 'never') {
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
                /* The fallback fetches in the catch above never passed the
                 * first .then, so the blank check runs here too. */
                noteBlank(response);
                return response.arrayBuffer();
            })
            .then(function (data) { return { data: data, blank: blankTile }; });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  CSS BLEND MODES THE MIRROR CANNOT CARRY
     * -----------------------------------------------------------------------
     *  The 2D map paints the Romanian 1 m / 2 m LiDAR hillshades with
     *  `filter: invert(1); mix-blend-mode: screen` (css/styles.css). MapLibre
     *  has no blend modes, so a mirrored tile arrived as the service sent it —
     *  an opaque white sheet over the terrain, which is exactly the “these
     *  LiDAR layers never load in 3D” report. The mirror repaints every such
     *  tile (white, alpha = 1 − luminance) in js/map3d-mirror.js before it is
     *  handed to MapLibre; this is where the fetch and that repaint meet.
     *
     *  The repainted bytes are kept: MapLibre evicts decoded tiles, and
     *  re-downloading *and* re-encoding a 1 m hillshade tile every time the user
     *  pans back over it is what made these layers feel like they never load.
     * ═══════════════════════════════════════════════════════════════════════ */
    var BLEND_CACHE_MAX = 160;

    function blendedTile(layer, url, payload) {
        var blend = typeof MIRROR.blendOf === 'function' ? MIRROR.blendOf(layer) : null;
        if (!blend) return Promise.resolve(payload);
        var size = 256;
        try { if (layer && layer.getTileSize) size = layer.getTileSize().x || 256; } catch (e) { size = 256; }
        if (typeof MIRROR.retintTile !== 'function') return Promise.resolve(payload);
        /* A prefetched tile is already repainted — the disc the user prepared
         * must be served from memory, not recomputed on the first pan. */
        var prefetched = prefetchedForLayer(url, layer, blend);
        if (prefetched) return Promise.resolve(prefetched);
        var hit = state.blendCache[url];
        if (hit) return Promise.resolve(hit.slice(0));      /* never the cached buffer itself */
        return MIRROR.retintTile(payload, size, blend).then(function (bytes) {
            var keys = Object.keys(state.blendCache);
            if (keys.length >= BLEND_CACHE_MAX) delete state.blendCache[keys[0]];
            state.blendCache[url] = bytes;
            state.retintedTiles += 1;
            return bytes;
        }, function (error) {
            /* An un-repainted tile is wrong but visible, and it beats a hole in
             * the terrain: keep it, and say so once. */
            if (!state.blendWarned) {
                state.blendWarned = true;
                pushError('could not repaint the blended tiles of ' + url.slice(0, 120) + ': ' +
                    ((error && error.message) || error));
            }
            return payload;
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE LIDAR FOCUS — the chosen layers, whole or over one prepared disc
     * -----------------------------------------------------------------------
     *  js/lidar-3d-focus.js decides WHICH LiDAR layers may be draped, and
     *  whether they are drawn entirely (scope 'full') or over one prepared
     *  disc (scope 'disc'); everything else here is the enforcement:
     *
     *    • plan()        drops every other LiDAR layer, so 3D can never try to
     *                    drape two national pyramids at once (the report that
     *                    starts this work: “Romania 1m/pixel agregare / AB …
     *                    slow, broken, or simply never there”).
     *    • renderRaster() gives the focused source the disc's bounds, so
     *                    MapLibre never asks for a tile outside the prepared
     *                    area — the difference between a few hundred tiles and
     *                    a country.
     *    • the protocols below clip every tile of that layer to the disc, so
     *                    what the user prepared is exactly what is drawn.
     *    • prefetchTiles() does the preparing: the same fetchTile/blend/clip
     *                    path the 3D view uses, stored in state.primed.
     * ═══════════════════════════════════════════════════════════════════════ */

    /* ── one decision, two scopes, one or more layers ─────────────────────
     * A focus is
     *
     *   { scope: 'disc' | 'full',
     *     layers: [ { key, lidarKey, defId, label, plan? } ],
     *     mask?, bounds?, plan? }
     *
     * `disc` prepares (and clips to) the 1 km circle the user picked; `full`
     * drapes the chosen layers entirely, with no prepared area and no clip.
     * A single-layer focus written the old way ({ key, lidarKey, defId, lat,
     * lng, radiusKm, plan }) is normalised into the same shape on the way in
     * (setLidarFocus below), so every reader here has one form to deal with. */
    function focusLayers(focus) {
        var f = focus || state.focus;
        if (!f) return [];
        if (Array.isArray(f.layers) && f.layers.length) return f.layers;
        if (f.key || f.lidarKey || f.defId) {
            return [{
                key: f.key || null,
                lidarKey: f.lidarKey || null,
                defId: f.defId || null,
                label: f.label || '',
                plan: f.plan || null
            }];
        }
        return [];
    }

    /** 'disc', 'full', or null when there is no focus at all. */
    function focusScope(focus) {
        var f = focus || state.focus;
        if (!f) return null;
        if (f.scope === 'disc' || f.scope === 'full') return f.scope;
        /* Written before scopes existed: a focus that carries a disc is a disc. */
        return (f.mask && Number(f.mask.radiusKm) > 0) || Number(f.radiusKm) > 0 ? 'disc' : 'full';
    }

    /**
     * Does this key (deck key, family key, registry id or `def:` id) name one
     * of the focused layers?
     *
     * Four spellings of the same layer meet here: the deck key of the live 2D
     * layer (`2d.<stamp>`), the family key (`lidar.ro1m`), the registry id as
     * a focus stores it (`lidar.fr-mnh`) and the registry id as the deck
     * addresses it (`def:lidar.fr-mnh`). A disc belongs to the layer,
     * whichever of them names it — the def: form used to fall through, so a
     * registry-drawn LiDAR layer was bounded to the disc but never clipped to
     * it.
     */
    function keyNamesFocusLayer(key, layer) {
        if (!key || !layer) return false;
        if (key === layer.key || key === layer.lidarKey) return true;
        if (layer.defId && (key === layer.defId || key === 'def:' + layer.defId)) return true;
        return false;
    }

    /** Does this deck item / registry definition belong to a focused LiDAR layer? */
    function focusMatches(item) {
        if (!state.focus || !item) return false;
        var layers = focusLayers();
        for (var i = 0; i < layers.length; i += 1) {
            /* Two key spaces meet here. The deck key of a mirrored layer
             * (`2d.<stamp>`) is what dl2d:// and the disc clip are addressed by;
             * the LiDAR family key the tag carries (`lidar.ro1m`,
             * `def:lidar.fr-mnh`) is what the dialog, the mirror item and the
             * registry agree on. A focus carries both, and either may be the
             * one that names this item. */
            if (keyNamesFocusLayer(item.lidarKey, layers[i])) return true;
            /* The deck key itself: a focus is built FROM the live layer of that
             * key (js/lidar-3d-focus.js → activeLayers()), so a layer that lost
             * its family tag — a `window._lidarGroup` member rebuilt by a
             * country module, a layer added after the dialog was opened — still
             * matches the decision the user made instead of being dropped as
             * "missing". */
            if (item.key && layers[i].key && item.key === layers[i].key) return true;
            if (item.defId && layers[i].defId && item.defId === layers[i].defId) return true;
        }
        return false;
    }

    function focusKeyOf(item) {
        if (!item) return null;
        return item.lidarKey || item.defId || null;
    }

    /** The disc a mirrored layer / registry definition is drawn inside. */
    function maskOf(key) {
        var f = state.focus;
        if (!f || !key) return null;
        /* A whole-layer focus has no disc: nothing is bounded, nothing clipped. */
        if (focusScope(f) === 'full') return null;
        var layers = focusLayers(f);
        for (var i = 0; i < layers.length; i += 1) {
            if (keyNamesFocusLayer(key, layers[i])) return f.mask || f;
        }
        return null;
    }
    function focusMaskFor(key) { return maskOf(key); }

    /** The prepared plan of one focused layer (its zoom ceiling), or null. */
    function planForLayer(key) {
        var f = state.focus;
        if (!f || !key) return null;
        var layers = focusLayers(f);
        for (var i = 0; i < layers.length; i += 1) {
            if (keyNamesFocusLayer(key, layers[i])) return layers[i].plan || f.plan || null;
        }
        return f.plan || null;
    }

    /** The disc's identity, for a given layer ('' when that layer has no disc). */
    function focusSigFor(key) {
        var mask = maskOf(key);
        if (!mask) return focusScope() === 'full' ? 'full' : '';
        return 'disc@' + mask.lat + ',' + mask.lng + ',' + mask.radiusKm;
    }

    /**
     * The identity of the finishing pipeline a tile goes through. Prepared bytes
     * may only be reused while this is unchanged (same blend, same disc); a
     * focus that moved, or a layer that switched product, recomputes.
     */
    function pipelineSigFor(key, url) {
        var layer = key && MIRROR.layerByKey ? MIRROR.layerByKey(key) : null;
        var blend = layer && typeof MIRROR.blendOf === 'function' ? (MIRROR.blendOf(layer) || '') : '';
        return blend + '|' + focusSigFor(key);
    }

    /** True when the focus disc excludes this tile of the focused layer on purpose. */
    function focusExcludesTile(key, z, x, y) {
        var mask = focusMaskFor(key);
        if (!mask || !MIRROR.disc || typeof MIRROR.disc.touchesTile !== 'function') return false;
        return !MIRROR.disc.touchesTile(mask, z, x, y);
    }

    /** The prepared bytes of this tile, when it belongs to the focused layer. */
    function prefetchedForLayer(url, layer, blend) {
        var key = layer ? MIRROR.keyFor(layer) : null;
        if (!key || state.primedLayer[url] !== key) return null;
        return primedOutput(url, (blend || '') + '|' + focusSigFor(key));
    }

    /**
     * Clip a finished tile to the focused disc.
     *
     * Resolves with the bytes to hand MapLibre: the tile itself when it is
     * entirely inside the disc, a transparent 1×1 PNG when the disc excludes it
     * completely, and repainted PNG bytes for the tiles the rim crosses. Only
     * the focused layer is ever clipped, and only its own tiles are remembered.
     */
    function clipFocusedTile(key, url, payload, tile) {
        var mask = focusMaskFor(key);
        if (!mask || !payload || !MIRROR.disc || typeof MIRROR.disc.maskTile !== 'function') {
            return Promise.resolve(payload);
        }
        var sig = pipelineSigFor(key, url);
        var layer = MIRROR.layerByKey(key);
        var size = 256;
        try { if (layer && layer.getTileSize) size = layer.getTileSize().x || 256; } catch (e) { size = 256; }
        return MIRROR.disc.maskTile(payload, size, tile, mask).then(function (bytes) {
            var data = bytes || MIRROR.disc.blankTile();
            state.primedLayer[url] = key;
            primedPut(url, data, true, sig);
            return data;
        }, function (error) {
            /* The clip could not be computed (a browser with no canvas to
             * repaint in, a tile that would not decode). Keep the tile as it
             * is — a rim tile that runs a few pixels past the edge of the disc
             * beats a hole in the middle of it — and remember it as prepared
             * so the next frame does not pay for the same failure again. */
            if (!state.clipWarned) {
                state.clipWarned = true;
                pushError('could not clip a tile of ' + (key || '?') + ' to the LiDAR disc: ' +
                    ((error && error.message) || error));
            }
            state.primedLayer[url] = key;
            primedPut(url, payload, true, sig);
            return payload;
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  PREFETCH — “mold the disc onto the relief before entering 3D”
     * -----------------------------------------------------------------------
     *  js/lidar-3d-focus.js plans the tiles (which zooms, which z/x/y, inside
     *  the 1 km entry disc) and hands the list over. Every tile goes through
     *  the SAME path the 3D view would use — fetchTile (proxy/CORS decisions
     *  included), the CSS-blend repaint, the disc clip — so nothing can be
     *  prepared one way and drawn another. What comes out is in memory
     *  (state.primed / state.primedOut) and 3D opens on a disc that is already
     *  there.
     *
     *  Concurrency is modest (6, 4 on phones) on purpose: the point of the
     *  exercise is a provider that stops answering when 200 tiles are asked for
     *  at once, and a progress bar that actually advances.
     * ═══════════════════════════════════════════════════════════════════════ */
    function prefetchConcurrency() { return isMobile() ? 4 : 6; }

    function prefetchTiles(list, options) {
        options = options || {};
        /* The canvas route resolves each tile's layer through the mirror's
         * key table (MIRROR.layerByKey), and the blend/clip signature is
         * computed from that same layer — but the table is only filled by
         * collect(), which the viewer otherwise runs once 3D is already
         * opening. On a first entry the prefetch therefore found no layer
         * behind any key: every canvas tile rejected (“the 2D layer did
         * not finish drawing”), blended tiles were stored under a
         * signature the serve path never asks for, and the dialog folded
         * into 3D with a disc that existed only on paper — the view then
         * depended on live per-tile requests, and sometimes showed the
         * base map alone. Collect first, exactly as the view will see it. */
        collectMirror();
        var entries = (list || []).slice();
        var entryIndex = 0;
        var requestedTotal = Number(options.total);
        var total = options.total != null && isFinite(requestedTotal)
            ? Math.max(0, Math.floor(requestedTotal)) : entries.length;
        var report = {
            total: total, done: 0, prepared: 0, failed: 0, stopped: false,
            bytes: 0, startedAt: Date.now(), finishedAt: 0, errors: []
        };
        if (!total) {
            report.finishedAt = Date.now();
            if (options.onProgress) { try { options.onProgress(report); } catch (e) { /* ignore */ } }
            return Promise.resolve(report);
        }
        state.prefetchCount = (state.prefetchCount || 0) + 1;
        state.prefetching = true;
        var concurrency = Math.max(1, Math.min(12, Number(options.concurrency) || prefetchConcurrency()));
        var cancelled = false;

        function takeEntry() {
            if (entryIndex < entries.length) return entries[entryIndex++];
            if (typeof options.nextEntry === 'function') {
                try { return options.nextEntry() || null; }
                catch (error) { return { error: String((error && error.message) || error) }; }
            }
            return null;
        }

        function stopped() {
            if (report.done >= total) return true;          /* nothing left to do */
            if (!options.shouldStop) return false;
            var yes = false;
            try { yes = !!options.shouldStop(report); } catch (e) { yes = false; }
            if (yes) cancelled = true;
            return yes;
        }

        function prepare(entry) {
            if (entry && entry.error) return Promise.reject(new Error(String(entry.error)));
            var defId = entry.defId || null;
            var key = entry.layerKey || (defId ? 'def:' + defId : null);
            /* The tile's identity. Named `tileId`, not `tile`: the fetch below
             * resolves with its own `tile` ({ data }), and a callback parameter
             * of the same name shadowed this object — so the disc clip was
             * handed { data } instead of { z, x, y }, read z/x/y as undefined,
             * classified every tile of the disc as "outside it" and stored the
             * transparent 1×1 PNG as the prepared bytes. The dialog reported
             * every tile as downloaded and draped, and 3D showed an empty disc:
             * "it says it is loading them and nothing appears". */
            var tileId = { z: entry.z, x: entry.x, y: entry.y };
            /* The deck key this tile is served under in 3D — the SAME
             * substituted URL the dl2d:// protocol handler asks for, so a
             * prepared tile is found again (a raw template with {z}/{x}/{y} in
             * it is one shared key for every tile of the layer). */
            var templateUrl = (entry.template && String(entry.template).indexOf('{') === -1)
                ? String(entry.template)
                : (key ? 'dl2d://' + key + '/' + entry.z + '/' + entry.x + '/' + entry.y : (entry.url || ''));

            /* A layer that draws its own tiles (a country module building a
             * WMS GetMap per tile) has no URL to fetch: it is rendered through
             * the live 2D layer, exactly as the dl2d:// protocol does it. */
            if (entry.route === 'canvas') {
                if (typeof MIRROR.renderTile !== 'function') return Promise.reject(new Error('no renderTile in the mirror'));
                if (focusExcludesTile(key, entry.z, entry.x, entry.y)) {
                    state.primedLayer[templateUrl] = key;
                    primedPut(templateUrl, MIRROR.disc.blankTile(), true, pipelineSigFor(key, templateUrl));
                    return Promise.resolve();
                }
                return MIRROR.renderTile(MIRROR.layerByKey(key), entry.z, entry.x, entry.y).then(function (bytes) {
                    /* renderTile repaints a CSS-blended layer itself. */
                    return clipFocusedTile(key, templateUrl, bytes, tileId).then(function (prepared) {
                        /* A normal (non-LiDAR) canvas tile has no fetch URL to
                         * warm in the browser cache. Keep the finished pixels
                         * under the dl2d:// address the map will request. */
                        if (!focusMaskFor(key) && prepared) {
                            state.primedLayer[templateUrl] = key;
                            primedPut(templateUrl, prepared, true, pipelineSigFor(key, templateUrl));
                        }
                    });
                });
            }

            var proxyUrl = null;
            var preferProxy = !!entry.preferProxy;
            if (defId) {
                var def = REGISTRY.get(defId);
                if (!def) return Promise.reject(new Error('unknown layer ' + defId));
                proxyUrl = REGISTRY.proxyTemplate(def, { time: REGISTRY.timeOf(def), mode: REGISTRY.modeOf(def, {}) });
            }
            /* One tile, one deadline. The prefetch used to fetch with no
             * timeout at all: a provider that accepts the connection and
             * then stalls (the classic throttled-ArcGIS behaviour under a
             * six-lane burst) parked a worker for good, the progress sat a
             * tile short of done, and the entry never handed over — the
             * fetch “finished” and nothing else happened. A timed-out tile
             * simply counts as failed; 3D opens without it and asks again
             * on demand. */
            var abort = null;
            var abortTimer = null;
            var timeoutMs = options.tileTimeoutMs == null ? 45000 : Number(options.tileTimeoutMs);
            if (timeoutMs > 0 && typeof root.AbortController === 'function') {
                try {
                    abort = new root.AbortController();
                    abortTimer = root.setTimeout(function () {
                        try { abort.abort(); } catch (e) { /* ignore */ }
                    }, timeoutMs);
                } catch (e) { abort = null; abortTimer = null; }
            }
            var request = fetchTile(entry.url, abort, { proxyUrl: proxyUrl, preferProxy: preferProxy });
            if (abortTimer) {
                request = request.then(function (value) {
                    root.clearTimeout(abortTimer);
                    return value;
                }, function (error) {
                    root.clearTimeout(abortTimer);
                    throw error;
                });
            }
            return request
                .then(function (fetched) {
                    /* A proxy blank must never pose as a prepared tile: it
                     * would be prime-cached, counted as downloaded by the
                     * dialog and then draped as a transparent nothing — the
                     * fetches “finish”, 3D opens, and only the base map
                     * shows. Counting it failed is honest: the dialog says
                     * so and the live view asks the service again. */
                    if (fetched.blank) throw new Error('the tile proxy answered a blank tile for ' + entry.url);
                    primedPut(entry.url, fetched.data, false);
                    report.bytes += primeBytesOf(fetched.data);
                    var layer = key && MIRROR.layerByKey ? MIRROR.layerByKey(key) : null;
                    return blendedTile(layer, entry.url, fetched.data).then(function (bytes) {
                        return clipFocusedTile(key, entry.url, bytes, tileId).then(function () {});
                    });
                });
        }

        function worker() {
            if (stopped()) return Promise.resolve();
            var entry = takeEntry();
            if (!entry) return Promise.resolve();
            var prepared;
            try { prepared = prepare(entry); }
            catch (error) { prepared = Promise.reject(error); }
            return Promise.resolve(prepared).then(function () {
                report.done += 1;
                report.prepared += 1;
            }, function (error) {
                report.done += 1;
                report.failed += 1;
                if (report.errors.length < 5) {
                    report.errors.push(String((error && error.message) || error) + ' — ' +
                        (entry.url || entry.template || entry.layerKey || 'tile'));
                }
            }).then(function () {
                if (options.onProgress) { try { options.onProgress(report); } catch (e) { /* ignore */ } }
                return worker();
            });
        }

        var lanes = [];
        for (var i = 0; i < concurrency; i += 1) lanes.push(worker());
        return Promise.all(lanes).then(function () {
            report.stopped = cancelled;
            report.finishedAt = Date.now();
            state.prefetchCount = Math.max(0, (state.prefetchCount || 1) - 1);
            state.prefetching = state.prefetchCount > 0;
            if (options.onProgress) { try { options.onProgress(report); } catch (e) { /* ignore */ } }
            return report;
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE FOCUS ITSELF — the chosen layers, whole or over one disc
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * Decide what the 3D view may drape.
     *
     * focus = { scope: 'full' | 'disc',
     *           layers: [ { key, lidarKey?, defId?, label, plan? } ],
     *           key, lidarKey?, defId?, label,        // the first layer
     *           lat, lng, radiusKm, bounds?, mask? }  // disc only
     *   key      the dl2d key of the live 2D layer (what the mirror named it) —
     *            what dl2d://, the clip and the prepared tiles are addressed by
     *   lidarKey the LiDAR family key the mirror put on the item (`lidar.ro1m`)
     *            — what one-layer-at-a-time is decided by (js/lidar-3d-focus.js
     *            sends both; either may be the one that names a given item)
     *   defId    the registry definition, for a layer drawn from the registry
     *   mask     { lat, lng, radiusKm } — the disc every tile is clipped to
     *   bounds   [w, s, e, n] the raster source may load (computed here if absent)
     */
    function setLidarFocus(focus) {
        var next = focus && (focus.key || focus.lidarKey || focus.defId ||
            (Array.isArray(focus.layers) && focus.layers.length)) ? focus : null;
        if (next) {
            /* One decision, one shape: whatever the caller wrote (a single
             * layer, a list of them, with or without a disc) is normalised
             * here so the rest of the viewer reads `scope` + `layers`. */
            if (!Array.isArray(next.layers) || !next.layers.length) {
                next.layers = [{
                    key: next.key || null,
                    lidarKey: next.lidarKey || null,
                    defId: next.defId || null,
                    label: next.label || '',
                    plan: next.plan || null
                }];
            }
            /* The primary layer's ceiling travels on the focus too (the dialog
             * and the 3D bar read it there); keep the two ends of the same
             * number in step whichever one the caller wrote last. */
            if (next.plan && next.layers[0]) next.layers[0].plan = next.plan;
            next.scope = focusScope(next);
            if (next.scope === 'disc') {
                if (!next.mask && next.lat != null && next.lng != null && next.radiusKm) {
                    next.mask = { lat: Number(next.lat), lng: Number(next.lng), radiusKm: Number(next.radiusKm) };
                }
                if (!next.bounds && next.mask && MIRROR.disc) next.bounds = MIRROR.disc.bounds(next.mask);
            } else {
                /* Whole layer: no disc, so no bounds and no clipped rim — the
                 * layer is drawn exactly where the 2D map would draw it. */
                delete next.mask;
                delete next.bounds;
            }
            next.at = Date.now();
        }
        var changed = !sameFocus(state.focus, next);
        state.focus = next;
        if (next) state.lidarOff = false;
        if (changed) {
            /* The prepared tiles of the previous disc are of no use for the new
             * one, and neither is the prepared/live source of its layer. */
            Object.keys(state.primedLayer).forEach(function (url) { delete state.primedLayer[url]; });
            refreshFocusedSource();
        }
        if (state.open) syncLayers();
        refreshFocusRow();
        return state.focus;
    }

    function sameFocus(a, b) {
        if (!a || !b) return !a && !b;
        function signature(f) {
            /* Every chosen layer, and the prepared ceiling of each: a source
             * created for a z16 plan must be rebuilt (not silently kept) when
             * the plan reaches z18, or the cap would still be the old one. */
            var layers = focusLayers(f).map(function (layer) {
                var plan = layer.plan || {};
                return [layer.key || '', layer.lidarKey || '', layer.defId || '',
                    plan.zoomTo == null ? '' : plan.zoomTo].join('~');
            }).join('|');
            var m = f.mask || {};
            var ceiling = f.plan && f.plan.zoomTo != null ? f.plan.zoomTo : '';
            return [focusScope(f), layers, Number(m.lat), Number(m.lng), Number(m.radiusKm), ceiling].join('|');
        }
        return signature(a) === signature(b);
    }

    /** Do not drape any LiDAR layer in 3D (the user removed it from the bar). */
    function clearLidarFocus() {
        state.focus = null;
        state.lidarOff = true;
        Object.keys(state.primedLayer).forEach(function (url) { delete state.primedLayer[url]; });
        refreshFocusedSource();
        if (state.open) syncLayers();
        refreshFocusRow();
        return true;
    }

    function currentFocus() { return state.focus; }

    /**
     * Force the focused source to be rebuilt: its bounds and the clip of every
     * tile depend on the disc, and MapLibre caches both per source. Only the
     * sources that were marked as focused are touched — the rest of the deck is
     * none the wiser, so changing the LiDAR area does not re-download the map
     * underneath it.
     */
    function refreshFocusedSource() {
        Object.keys(state.rendered).forEach(function (id) {
            var status = state.status[id];
            if (!status || !status.focused) return;
            removeRendered(id);
        });
        refreshFocusOutline();
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
            var templateUrl = String(params.url);
            var coords = { z: z, x: x, y: y };
            var layer = MIRROR.layerByKey(key);
            if (!layer) return Promise.reject(new Error('[Map3D] the 2D layer behind ' + key + ' is gone'));
            /* Prepared by the LiDAR focus: no network, no rendering, no clip
             * work — the disc the user waited for is handed over as it is. */
            var prepared = primedOutput(templateUrl, pipelineSigFor(key, templateUrl));
            if (prepared) return Promise.resolve({ data: prepared });
            /* Outside the disc on purpose: not a hole, a decision. */
            if (focusExcludesTile(key, z, x, y)) return Promise.resolve({ data: MIRROR.disc.blankTile() });
            var url = MIRROR.tileUrlFor(layer, z, x, y);
            if (url) {
                var isWms = !!((layer.options && (layer.options.layers || layer.options.layer)) ||
                    /[?&](service=wms|request=getmap)/i.test(url));
                return fetchTile(url, abortController, { preferProxy: isWms }).then(function (tile) {
                    /* A proxy blank is an upstream error, not pixels: hand
                     * MapLibre the transparent tile for this frame but keep
                     * it out of the blend/clip/primed caches, so the next
                     * request asks the service again instead of serving the
                     * stored nothing for the rest of the session. */
                    if (tile.blank) return { data: MIRROR.disc.blankTile() };
                    return blendedTile(layer, url, tile.data).then(function (data) {
                        return clipFocusedTile(key, url, data, coords).then(function (bytes) { return { data: bytes }; });
                    });
                });
            }
            /* No URL: the layer draws its own tiles (canvas / custom plugin).
             * Ask the 2D layer for these pixels instead of re-implementing it. */
            if (typeof MIRROR.renderTile === 'function') {
                return MIRROR.renderTile(layer, z, x, y).then(function (data) {
                    state.renderedTiles += 1;
                    /* renderTile already repainted a CSS-blended layer, so only
                     * the disc clip is left to apply here. */
                    return clipFocusedTile(key, templateUrl, data, coords).then(function (bytes) { return { data: bytes }; });
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
            var defId = decodeURIComponent(match[1]);
            var z = Number(match[2]);
            var x = Number(match[3]);
            var y = Number(match[4]);
            var def = REGISTRY.get(defId);
            var templateUrl = String(params.url);
            var prepared = primedOutput(templateUrl, pipelineSigFor('def:' + defId, templateUrl));
            if (prepared) return Promise.resolve({ data: prepared });
            /* The country LiDAR products are def-backed (this source) but
             * draw their own tiles, so the dialog prepared their disc on
             * the canvas route — which stores under the dl2d:// deck key of
             * the live layer, not under this dl3d:// template. Without this
             * lookup the prepared disc was unreachable here: every tile was
             * fetched again live, and any hiccup in that second fetch left
             * the disc empty over the base map. The prepared bytes win;
             * the live builder below stays the fallback. */
            var focus = state.focus;
            /* The definition may be named by the focus as its id (`lidar.fr-mnh`,
             * which is what `_dlDefId` carries) or as the registry key the deck
             * uses (`def:lidar.fr-mnh`, which is what `_dlLidar` carries for a
             * module-built layer) — either way it is the same layer, and its
             * prepared disc is under the deck key. A disc can hold several
             * layers, so the matching one is looked up, not assumed first. */
            var focusLayer = focusLayers(focus).filter(function (layer) {
                return layer.defId === defId || layer.lidarKey === 'def:' + defId;
            })[0];
            if (focusLayer && focusLayer.key) {
                var deckUrl = 'dl2d://' + focusLayer.key + '/' + z + '/' + x + '/' + y;
                var fromDisc = primedOutput(deckUrl, pipelineSigFor(focusLayer.key, deckUrl));
                if (fromDisc) return Promise.resolve({ data: fromDisc });
            }
            if (focusExcludesTile('def:' + defId, z, x, y)) return Promise.resolve({ data: MIRROR.disc.blankTile() });
            var url = def ? REGISTRY.tileUrlAt(def, z, x, y) : '';
            if (!url) return Promise.reject(new Error('[Map3D] no per-tile URL for ' + match[1]));
            /* Proxied per-tile layers are rebuilt by the proxy from the same
             * definition (`?layer=…&m=<mode>`), never relayed URL by URL. */
            var proxyUrl = def ? REGISTRY.proxyTemplate(def, { time: REGISTRY.timeOf(def), mode: REGISTRY.modeOf(def, {}) }) : null;
            return fetchTile(url, abortController, { proxyUrl: proxyUrl }).then(function (tileData) {
                /* Same rule as the dl2d route: a proxy blank is served for
                 * this frame only and never reaches the clip cache. */
                if (tileData.blank) return { data: MIRROR.disc.blankTile() };
                return clipFocusedTile('def:' + defId, url, tileData.data, { z: z, x: x, y: y })
                    .then(function (bytes) { return { data: bytes }; });
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
            '<span class="m3d-veil-actions">' +
            '<button type="button" class="m3d-veil-action" style="display:none"></button>' +
            /* The way out of a failure: without it the only exit was the 2D⇄3D
             * pill, which reads "3D" again after a failure and would simply
             * retry instead of returning to the map. */
            '<button type="button" class="m3d-veil-back" style="display:none"></button>' +
            '</span>';
        surface.appendChild(veil);
        host.appendChild(surface);

        veil.querySelector('.m3d-veil-action').addEventListener('click', function () {
            close();
            open();
        });
        veil.querySelector('.m3d-veil-back').addEventListener('click', function () {
            close();
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

    function showVeil(mode, title, detail, actionLabel, backLabel) {
        if (!veil) return;
        surface.classList.remove('is-busy', 'is-error');
        if (mode) surface.classList.add(mode === 'error' ? 'is-error' : 'is-busy');
        veil.querySelector('.m3d-veil-title').textContent = title || '';
        veil.querySelector('.m3d-veil-detail').textContent = detail || '';
        var action = veil.querySelector('.m3d-veil-action');
        action.style.display = actionLabel ? '' : 'none';
        action.textContent = actionLabel || '';
        var back = veil.querySelector('.m3d-veil-back');
        back.style.display = backLabel ? '' : 'none';
        back.textContent = backLabel || '';
    }

    function hideVeil() {
        if (!surface) return;
        surface.classList.remove('is-busy', 'is-error');
    }

    /* ── the switch's anchor: the bottom-left control column ─────────────────
     * The 2D/3D switch sits directly above the base-layer button
     * (#arcgisBasemapCtrl — the Leaflet control js/map-app.js folds the three
     * ArcGIS base maps into). Leaflet stacks that corner in flow and every
     * environment moves it: the installed PWA adds the Detect button to the
     * compass column and rides the home-indicator inset, mobile-web fullscreen
     * makes the corner position:fixed above the browser bar, and the control
     * itself grows upward when its list folds open. So the offset is measured
     * rather than guessed, and published on .map-wrapper — the box the switch
     * and the 3D bar are positioned against — as three custom properties that
     * css/map3d-terrain.css reads:
     *   --m3d-anchor-bottom  wrapper bottom → the control's top edge + the gap
     *   --m3d-anchor-left    wrapper left   → the control's left edge
     *   --m3d-stack-top      wrapper bottom → the switch's own top edge
     * The stylesheet keeps constants for the documented column as fallbacks,
     * so the switch is still placed correctly before the first measurement. */
    var BASE_LAYER_CTRL_ID = 'arcgisBasemapCtrl';
    var ANCHOR_GAP = 8;                 /* px between the base-layer button and the switch */
    var anchorWatched = false;
    var anchorQueued = false;
    var anchorTimer = null;
    var anchorAttempts = 0;

    function queueAnchorSync() {
        if (anchorQueued) return;
        anchorQueued = true;
        var next = root.requestAnimationFrame || function (fn) { return root.setTimeout(fn, 16); };
        next(function () { anchorQueued = false; syncToggleAnchor(); });
    }

    /* Returns true once the control has actually been measured. */
    function syncToggleAnchor() {
        var host = wrapper();
        /* A stub wrapper (the layout harnesses) has no CSSStyleDeclaration:
         * say “not measured” instead of throwing inside a boot retry. */
        if (!host || !host.style || typeof host.style.setProperty !== 'function' ||
            typeof host.style.removeProperty !== 'function') return false;
        var ctrl = document.getElementById(BASE_LAYER_CTRL_ID);
        if (!ctrl || typeof ctrl.getBoundingClientRect !== 'function' ||
            typeof host.getBoundingClientRect !== 'function') {
            /* No base-layer button in this document (a bare layout harness, or
             * js/map-app.js has not built it yet): drop the properties so the
             * stylesheet's fallbacks place the switch. */
            host.style.removeProperty('--m3d-anchor-bottom');
            host.style.removeProperty('--m3d-anchor-left');
            host.style.removeProperty('--m3d-stack-top');
            return false;
        }
        var hostBox = host.getBoundingClientRect();
        var ctrlBox = ctrl.getBoundingClientRect();
        /* Nothing is laid out yet — keep the previous anchor rather than
         * publishing a zero that would drop the switch onto the corner. */
        if (!hostBox.height || !ctrlBox.height) return false;
        var bottom = Math.round(hostBox.bottom - ctrlBox.top + ANCHOR_GAP);
        var left = Math.round(ctrlBox.left - hostBox.left);
        var height = (toggleGroup && typeof toggleGroup.getBoundingClientRect === 'function')
            ? Math.round(toggleGroup.getBoundingClientRect().height) : 0;
        host.style.setProperty('--m3d-anchor-bottom', bottom + 'px');
        host.style.setProperty('--m3d-anchor-left', left + 'px');
        host.style.setProperty('--m3d-stack-top', (bottom + height) + 'px');
        /* The base-layer button is measured against the same corner: keep its
         * lift over MapLibre's own bottom-left widgets in step with it. */
        syncBasemapLift();
        return true;
    }

    /* ── the base-layer button's slot while 3D is on ────────────────────────
     * css/map3d-terrain.css keeps ONE Leaflet control visible in the 3D view:
     * the base-layer button (#arcgisBasemapCtrl). It keeps its bottom-left
     * slot, but MapLibre parks its own widgets in the same corner — the compact
     * source-credit button (the ⓘ) and the scale bar — so the button has to
     * ride above them. MapLibre lays those out itself (10px margins, and the
     * credit row grows when it is opened by the user), so the offset is
     * measured, exactly like the switch's anchor above, and published on
     * .map-wrapper as --m3d-basemap-lift:
     *   --m3d-basemap-lift   wrapper bottom → top of MapLibre's bottom-left
     *                        stack + the same 8px gap as the column
     * The stylesheet keeps a constant fallback for the documented stack, so the
     * button is placed correctly before the first measurement (and whenever the
     * surface is not built yet). */
    var BASEMAP_LIFT_ID = 'arcgisBasemapCtrl';
    var liftCorner = null;
    var liftObserved = false;

    /* Returns true once MapLibre's corner has actually been measured. */
    function syncBasemapLift() {
        var host = wrapper();
        if (!host || !host.style || typeof host.style.setProperty !== 'function' ||
            typeof host.style.removeProperty !== 'function') return false;
        var surf = surface;
        var corner = (surf && typeof surf.querySelector === 'function')
            ? surf.querySelector('.maplibregl-ctrl-bottom-left')
            : null;
        /* No MapLibre corner: the map is closed (the surface is display:none)
         * or the SDK is still loading. Drop the property so the stylesheet's
         * fallback places the button, and retry on the next anchor sync. */
        if (!corner || typeof corner.getBoundingClientRect !== 'function' ||
            typeof host.getBoundingClientRect !== 'function') {
            host.style.removeProperty('--m3d-basemap-lift');
            return false;
        }
        var hostBox = host.getBoundingClientRect();
        var cornerBox = corner.getBoundingClientRect();
        if (!hostBox.height || !cornerBox.height) return false;
        /* Lift from the BOTTOM OF LEAFLET'S OWN CORNER, not from the wrapper
         * edge: the installed PWA lifts that corner by the home-indicator inset
         * (index.html), mobile-web fullscreen fixes it above the browser bar
         * (css/styles.css) and MapLibre lifts its own corner by the same inset
         * — so both are measured from where they actually are. Falling back to
         * the wrapper edge when the corner is not measurable keeps a sensible
         * value in the layout harnesses. */
        var ctrl = document.getElementById(BASEMAP_LIFT_ID);
        var leafletCorner = ctrl && ctrl.parentElement;
        var base = (leafletCorner && typeof leafletCorner.getBoundingClientRect === 'function')
            ? leafletCorner.getBoundingClientRect().bottom
            : hostBox.bottom;
        var lift = Math.round(base - cornerBox.top + ANCHOR_GAP);
        if (lift < 0) lift = 0;
        host.style.setProperty('--m3d-basemap-lift', lift + 'px');
        watchBasemapLift(corner);
        return true;
    }

    /* The credit row can grow (the ⓘ expands into full credits) and the whole
     * corner moves when the surface is resized, neither of which is a window
     * resize: follow the corner itself. */
    function watchBasemapLift(corner) {
        if (liftObserved || !corner) return;
        if (typeof root.ResizeObserver !== 'function') return;
        liftObserved = true;
        liftCorner = corner;
        try { new root.ResizeObserver(queueAnchorSync).observe(corner); } catch (e) { /* ignore */ }
    }

    function watchToggleAnchor() {
        if (anchorWatched) return;
        var host = wrapper();
        var ctrl = document.getElementById(BASE_LAYER_CTRL_ID);
        if (!host || !ctrl) return;             /* startAnchorWatch() retries */
        anchorWatched = true;
        /* Every listener is optional: a layout harness may hand this module a
         * window or a document without one, and the anchor must still work. */
        if (typeof root.addEventListener === 'function') {
            root.addEventListener('resize', queueAnchorSync);
            root.addEventListener('orientationchange', queueAnchorSync);
        }
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('fullscreenchange', queueAnchorSync);
        }
        /* The control grows when its list of base maps folds open, the corner
         * grows when a button joins the compass column, and the wrapper is
         * resized by the panels folding — none of which is a window resize. */
        if (typeof root.ResizeObserver === 'function') {
            var observer = new root.ResizeObserver(queueAnchorSync);
            observer.observe(ctrl);
            if (ctrl.parentNode) observer.observe(ctrl.parentNode);
            observer.observe(host);
        }
        /* body.is-pwa (and the fullscreen classes) move the whole corner. */
        if (typeof root.MutationObserver === 'function' && document.body) {
            new root.MutationObserver(queueAnchorSync)
                .observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
        var map = leafletMap();
        if (map && typeof map.on === 'function') map.on('resize', queueAnchorSync);
    }

    function startAnchorWatch() {
        watchToggleAnchor();
        if (anchorWatched || anchorTimer) return;
        /* js/map-app.js builds the base-layer control inside its own async
         * boot, so the first measurement can easily run before it exists:
         * retry briefly, exactly the way the button's own boot loop does. */
        if (typeof root.setInterval !== 'function') { syncToggleAnchor(); return; }
        anchorTimer = root.setInterval(function () {
            anchorAttempts += 1;
            syncToggleAnchor();
            watchToggleAnchor();
            if (anchorWatched || anchorAttempts > 40) {
                root.clearInterval(anchorTimer);
                anchorTimer = null;
            }
        }, 250);
    }

    function ensureToggle() {
        if (toggleGroup) return toggleBtn;
        var host = wrapper();
        if (!host) return null;
        toggleGroup = document.createElement('div');
        toggleGroup.id = 'map3d-toggle-group';
        toggleGroup.className = 'm3d-toggle-group';

        toggleBtn = document.createElement('button');
        toggleBtn.id = 'map3d-toggle';
        toggleBtn.type = 'button';
        toggleBtn.innerHTML = '<span class="m3d-dot" aria-hidden="true"></span><span class="m3d-label"></span>';
        toggleBtn.addEventListener('click', function () { toggle(); });
        toggleGroup.appendChild(toggleBtn);

        refreshBtn = document.createElement('button');
        refreshBtn.id = 'map3d-refresh';
        refreshBtn.type = 'button';
        refreshBtn.title = t('refreshTitle');
        refreshBtn.setAttribute('aria-label', t('refreshTitle'));
        refreshBtn.setAttribute('aria-busy', 'false');
        refreshBtn.innerHTML = '<span class="m3d-refresh-icon" aria-hidden="true">↻</span>' +
            '<span class="m3d-refresh-count" aria-hidden="true" hidden></span>';
        refreshIcon = refreshBtn.querySelector('.m3d-refresh-icon');
        refreshCount = refreshBtn.querySelector('.m3d-refresh-count');
        refreshBtn.addEventListener('click', function () { refreshTiles(); });
        toggleGroup.appendChild(refreshBtn);

        refreshStatus = document.createElement('span');
        refreshStatus.id = 'map3d-refresh-status';
        refreshStatus.className = 'm3d-refresh-status';
        refreshStatus.setAttribute('role', 'status');
        refreshStatus.setAttribute('aria-live', 'polite');
        refreshStatus.setAttribute('aria-atomic', 'true');
        toggleGroup.appendChild(refreshStatus);

        host.appendChild(toggleGroup);
        refreshToggle();
        /* Measure the base-layer button and follow it: the switch's slot in the
         * bottom-left column belongs to that control's geometry. */
        syncToggleAnchor();
        startAnchorWatch();
        return toggleBtn;
    }

    function refreshToggle() {
        if (!toggleBtn) return;
        toggleBtn.querySelector('.m3d-label').textContent = state.open ? t('buttonOn') : t('button');
        toggleBtn.title = state.open ? t('buttonTitleOn') : t('buttonTitle');
        toggleBtn.setAttribute('aria-label', state.open ? t('buttonTitleOn') : t('buttonTitle'));
        toggleBtn.setAttribute('aria-pressed', state.open ? 'true' : 'false');
        if (refreshBtn && !refreshJob) {
            refreshBtn.title = t('refreshTitle');
            refreshBtn.setAttribute('aria-label', t('refreshTitle'));
        }
    }

    function ensureBar() {
        if (bar) return bar;
        var host = wrapper();
        if (!host) return null;
        bar = document.createElement('div');
        bar.id = 'map3d-bar';
        bar.innerHTML = [
            '<div class="m3d-head"><span>' + t('title') + '</span>',
            '<button type="button" class="m3d-collapse" title="Collapse" aria-expanded="true" aria-label="Toggle 3D controls">▾</button></div>',
            '<div class="m3d-row m3d-basemap-row"><label for="map3d-basemap"><span>' + t('basemap') + '</span></label>',
            '<select id="map3d-basemap" class="m3d-basemap-select">',
            '<option value="imagery">' + t('basemapImagery') + '</option>',
            '<option value="topographic">' + t('basemapTopographic') + '</option>',
            '<option value="terrain">' + t('basemapTerrain') + '</option>',
            '</select></div>',
            /* No exaggeration / pitch / bearing sliders: the camera is moved by
             * gestures only (drag to pan, right-drag or Ctrl+drag to pitch and
             * rotate, two fingers on touch, Shift+arrows on a keyboard), and the
             * DEM exaggeration is fixed at CONFIG.terrain.exaggeration.
             * No duplicate LiDAR row in the bar either (desktop or PWA): the
             * expandable “LiDAR in 3D” window (#map3d-focus / .m3d-focus-mini)
             * already provides the status summary and the same actions. */
            '<div class="m3d-actions">',
            '<button type="button" class="m3d-reset">' + t('reset') + '</button>',
            '<button type="button" class="m3d-north">↑ N</button>',
            '<button type="button" class="m3d-flat">2D ⤓</button>',
            '</div>'
        ].join('');
        host.appendChild(bar);

        /* The 3D view uses the same basemap stack as Leaflet. Route selection
         * through the existing 2D setter so there is still only one active
         * basemap state; the mirror then replaces the raster in this deck. */
        var basemapSelect = bar.querySelector('.m3d-basemap-select');
        var basemapKeys = ['imagery', 'topographic', 'terrain'];
        function syncBasemapSelect(key) {
            if (!basemapSelect) return;
            var active = key;
            if (basemapKeys.indexOf(active) < 0) {
                try {
                    active = typeof root.getArcgisBasemap === 'function'
                        ? root.getArcgisBasemap() : '';
                } catch (e) { active = ''; }
            }
            if (basemapKeys.indexOf(active) >= 0) basemapSelect.value = active;
        }
        if (basemapSelect) {
            basemapSelect.addEventListener('change', function () {
                if (typeof root.setArcgisBasemap !== 'function') {
                    syncBasemapSelect();
                    return;
                }
                try {
                    syncBasemapSelect(root.setArcgisBasemap(basemapSelect.value));
                } catch (e) { syncBasemapSelect(); }
                /* Sync the deck from this very event, unconditionally: a pick
                 * that changes nothing on the 2D map fires no layer events, and
                 * a missed event used to leave the 3D plan untouched. */
                scheduleSync();
            });
        }
        bar.syncBasemap = function () { syncBasemapSelect(); };
        syncBasemapSelect();

        /* Camera movement is gesture-only on the desktop website: there are no
         * pitch / bearing / exaggeration inputs to wire here. The three
         * remaining action buttons are one-tap shortcuts, not sliders. */
        bar.querySelector('.m3d-reset').addEventListener('click', function () { resetView(true); });
        bar.querySelector('.m3d-north').addEventListener('click', function () {
            if (map) map.setBearing(0);
        });
        bar.querySelector('.m3d-flat').addEventListener('click', function () {
            if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
        });
        bar.querySelector('.m3d-collapse').addEventListener('click', function () {
            bar.classList.toggle('collapsed');
            var collapsed = bar.classList.contains('collapsed');
            bar.querySelector('.m3d-collapse').textContent = collapsed ? '▸' : '▾';
            bar.querySelector('.m3d-collapse').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });
        return bar;
    }

    /**
     * The 3D bar no longer renders a duplicate LiDAR status/actions box on
     * either desktop or PWA: the expandable “LiDAR in 3D” window
     * (#map3d-focus / .m3d-focus-mini) already owns that state and its actions.
     * Keep the 3D disc outline synced whenever the focus changes.
     */
    function refreshFocusRow() {
        refreshFocusOutline();
    }

    function refreshBarCopy() {
        if (!bar) return;
        bar.querySelector('.m3d-head span').textContent = t('title');
        /* The basemap picker is the only row left: the camera rows are gone
         * (gesture-only view), so the copy pass has exactly one label. */
        var rows = bar.querySelectorAll('.m3d-row > label > span');
        if (rows[0]) rows[0].textContent = t('basemap');
        var basemapOptions = bar.querySelectorAll('.m3d-basemap-select option');
        if (basemapOptions[0]) basemapOptions[0].textContent = t('basemapImagery');
        if (basemapOptions[1]) basemapOptions[1].textContent = t('basemapTopographic');
        if (basemapOptions[2]) basemapOptions[2].textContent = t('basemapTerrain');
        var reset = bar.querySelector('.m3d-reset');
        if (reset) { reset.textContent = t('reset'); reset.title = t('resetTitle'); }
        refreshFocusRow();
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

    /*
     * Leaflet's public stop() cancels pan/flyTo frames, but it does not finish
     * an animated CSS zoom. That zoom owns a delayed _onZoomTransitionEnd()
     * callback (250 ms); if we replace the view while it is pending, the late
     * callback can restore the old center/zoom and make vector overlays such
     * as the country border jump after returning from 3D. Settle the old view
     * before handing the MapLibre camera back.
     */
    function settleLeafletMotion(lmap) {
        if (!lmap) return;
        try {
            if (typeof lmap.stop === 'function') lmap.stop();
        } catch (e) { /* keep the 2D/3D hand-off available */ }
        if (!lmap._animatingZoom || typeof lmap._onZoomTransitionEnd !== 'function') return;
        try {
            lmap._onZoomTransitionEnd();
        } catch (e) { /* a transition cleanup must never block closing 3D */ }
    }

    /** Push the 3D camera back to Leaflet (called when 3D closes). */
    function cameraTo2D() {
        var lmap = leafletMap();
        if (!lmap || !map) return;
        settleLeafletMotion(lmap);
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

    /* ═══════════════════════════════════════════════════════════════════════
     *  CAMERA — the disc the user prepared is what they get to see
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * The zoom at which the whole disc fits the viewport.
     *
     * The disc is the promise of the focus dialog (“this is the LiDAR you will
     * get in 3D”), so it has to be on screen when 3D opens — unless the 2D view
     * already shows it, in which case the camera is left exactly where the user
     * left it (`focusCamera` below is the judge).
     */
    function focusFitZoom(focus) {
        if (!focus) return null;
        var disc = focus.mask || focus;
        var radiusKm = Number(disc.radiusKm);
        if (!(radiusKm > 0)) return null;
        var host = wrapper();
        var width = (host && host.clientWidth) || 1024;
        var height = (host && host.clientHeight) || 768;
        /* The disc's diameter must fit the smaller viewport side, leaving a
         * margin so the outline and its surroundings are visible too. */
        var side = Math.max(160, Math.min(width, height) * 0.78);
        var metresPerPixel = (radiusKm * 2000) / side;
        /* Ground metres per pixel of a 256 px Web-Mercator tile at zoom 0. */
        var atZoomZero = 156543.03392804097 * Math.cos(Number(disc.lat) * Math.PI / 180);
        var zoom = Math.log2(atZoomZero / metresPerPixel);
        /* The disc frames the layer that owns it; with several layers on one
         * disc the first is the one the camera fits to. */
        var fitLayer = focusLayers(focus)[0] || {};
        var layer = fitLayer.key ? MIRROR.layerByKey(fitLayer.key) : null;
        if (!layer && fitLayer.lidarKey) layer = MIRROR.layerByKey(fitLayer.lidarKey);
        var ceiling = 20;
        try {
            if (layer && layer.options) {
                ceiling = Number(layer.options.maxNativeZoom || layer.options.maxZoom || 20);
            }
        } catch (e) { ceiling = 20; }
        return Math.max(0, Math.min(ceiling, zoom));
    }

    function focusCamera(cam) {
        var focus = state.focus;
        if (!focus || !focus.mask) return cam;      /* a whole-layer focus never moves the camera */
        if (state.lidarOff) return cam;
        // If none of the LiDAR layers the focus was prepared for is still active in
        // 2D, do not teleport to the stale disc — the user disabled those layers
        // (or the whole LiDAR group) and is now trying to view a different location.
        if (root.DetectLabLidar3D && typeof root.DetectLabLidar3D.activeLayers === 'function') {
            try {
                var activeForFocus = root.DetectLabLidar3D.activeLayers();
                if (!activeForFocus || activeForFocus.length === 0) return cam;
                var stillThere = focusLayers(focus).some(function (layer) {
                    return activeForFocus.some(function (ent) {
                        if (layer.key && (ent.key === layer.key || ent.lidarKey === layer.key)) return true;
                        if (layer.lidarKey && (ent.lidarKey === layer.lidarKey || ent.key === layer.lidarKey)) return true;
                        if (layer.defId && (ent.defId === layer.defId || ent.lidarKey === 'def:' + layer.defId)) return true;
                        if (layer.lidarKey && ent.defId && layer.lidarKey === 'def:' + ent.defId) return true;
                        return false;
                    });
                });
                if (!stillThere) return cam;
            } catch (e8) {}
        }
        var fit = focusFitZoom(focus);
        if (fit == null) return cam;
        var lmap = leafletMap();
        var alreadyVisible = false;
        try {
            if (lmap && typeof lmap.getBounds === 'function' && focus.bounds) {
                var view = lmap.getBounds();
                var corner0 = [focus.bounds[1], focus.bounds[0]];
                var corner1 = [focus.bounds[3], focus.bounds[2]];
                alreadyVisible = view.contains(corner0) && view.contains(corner1) &&
                    Number(lmap.getZoom()) >= fit;
            }
        } catch (e) { alreadyVisible = false; }
        if (alreadyVisible) return cam;
        return {
            center: [(focus.bounds[0] + focus.bounds[2]) / 2, (focus.bounds[1] + focus.bounds[3]) / 2],
            zoom: fit,
            bearing: cam.bearing,
            pitch: cam.pitch == null ? CONFIG.camera.pitch : cam.pitch
        };
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

    /** A #rrggbb colour with an alpha channel, as an rgba() string MapLibre
     * parses identically everywhere (8-digit hex is not accepted by every
     * style-spec version this viewer has shipped with). */
    function hillshadeColor(hex, opacity) {
        var m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
        if (!m || opacity >= 1) return String(hex || '');
        var n = parseInt(m[1], 16);
        return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + opacity + ')';
    }

    /**
     * @param {object} maplibre resolved SDK namespace (unused — kept for the tests)
     * @param {boolean} safeMode drop everything that is decoration, not map:
     *        sky and hillshade each cost an extra render pass and their own
     *        render targets, which is the first thing to shed when a device is
     *        too tight on GPU memory to open 3D at all. The DEM stays — the
     *        relief is the reason 3D exists.
     */
    function buildStyle(maplibre, safeMode) {
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
        } else if (cfg.hillshade && cfg.hillshade.enabled && !safeMode && style.sources[ts.id]) {
            /* The relief must read THROUGH the imagery, at the configured low
             * opacity — MapLibre has no hillshade-opacity property, so the
             * opacity is carried as the alpha of the three shading colours
             * (the shader multiplies its output by them, alpha included).
             * At full alpha the DEM shading sat on the satellite base at
             * full strength and the 3D view read as a grey topographic
             * sheet instead of the same map the user had in 2D — the
             * “3D turns the map topographic” report. `hillshade.opacity`
             * (0.55 by default) was configured for exactly this and was
             * never applied. */
            var hsOpacity = cfg.hillshade.opacity == null ? 1 : Number(cfg.hillshade.opacity);
            if (!isFinite(hsOpacity)) hsOpacity = 1;
            hsOpacity = Math.max(0, Math.min(1, hsOpacity));
            style.layers.push({
                id: 'm3d-hillshade',
                type: 'hillshade',
                source: ts.id,
                paint: {
                    'hillshade-exaggeration': cfg.hillshade.exaggeration || 1,
                    'hillshade-shadow-color': hillshadeColor('#2b2b33', hsOpacity),
                    'hillshade-highlight-color': hillshadeColor('#ffffff', hsOpacity),
                    'hillshade-accent-color': hillshadeColor('#3a3a45', hsOpacity)
                }
            });
        }

        if (cfg.sky && cfg.sky.enabled && !safeMode) {
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
        if (!map) return;
        if (mirroredBaseItem() || desktopBasemapDefs().length) {
            /* The boot fallback is not tracked in state.rendered. Remove it
             * explicitly once the real basemap is ready. */
            if (state.status['base.imagery'] && state.status['base.imagery'].fallbackBase) {
                if (map.getLayer('base.imagery')) map.removeLayer('base.imagery');
                if (map.getSource('base.imagery')) map.removeSource('base.imagery');
                delete state.status['base.imagery'];
            }
            return;
        }
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
            /* A LiDAR layer the focus did not choose is not drawn at all (see
             * lidarFilter): the registry fallback must respect the same rule,
             * or a layer would sneak back in through this second route. */
            if (!registryLidarAllowed(def)) return;
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

    /**
     * Only the LiDAR layers the user chose in the entry dialog.
     *
     * National LiDAR pyramids are the heaviest thing on this map: a single 1 m
     * hillshade covers a country, and every one of them at once (which the 2D
     * panel happily allows, since stacking is how you compare them on flat
     * imagery) is a deck MapLibre cannot finish opening. The 3D view therefore
     * draws exactly the layers the user ticked in the focus dialog — every one
     * of them either entirely (scope: 'full') or inside the disc that was
     * prefetched for it (scope: 'disc'). Anything else LiDAR is left out BY
     * DECISION — and says so in status().lidar, never silently.
     */
    function lidarItems() {
        return state.mirror.items.filter(function (item) { return !!item.lidarKey; });
    }

    function lidarFilter() {
        var items = lidarItems();
        var notes = [];
        if (state.lidarOff) {
            if (items.length) notes.push({ reason: 'off', count: items.length });
            state.lidarNotes = notes;
            return function (item) { return !item.lidarKey; };
        }
        if (state.focus) {
            var found = items.filter(focusMatches);
            notes.push(found.length
                ? { reason: 'focused', count: items.length, scope: focusScope(),
                    keptCount: found.length,
                    kept: found.map(function (item) { return item.lidarLabel || item.lidarKey; }).join(', ') }
                : { reason: 'missing', count: items.length,
                    kept: state.focus.label || (focusLayers()[0] && focusLayers()[0].label) || state.focus.key });
            state.lidarNotes = notes;
            return function (item) {
                if (!item.lidarKey) return true;
                return !!focusMatches(item);
            };
        }
        /* No focus, but LiDAR is on the 2D map: 3D is being asked for a LiDAR
         * layer it has no prepared disc for (a LiDAR layer switched on while 3D
         * was already open, or 3D opened from the console). Draping it here is
         * exactly the slow, blank load this whole path exists to prevent —
         * nothing is draped, and the bar names the state and points at the
         * dialog (“Choose the area”). */
        if (items.length) notes.push({ reason: 'unprepared', count: items.length });
        state.lidarNotes = notes;
        return function (item) { return !item.lidarKey; };
    }

    /** Is this registry definition one of the LiDAR layers the 3D view may drape? */
    function registryLidarAllowed(def) {
        if (!def || def.group !== 'lidar') return true;
        var key = 'def:' + def.id;
        if (state.lidarOff) return false;
        if (state.focus) {
            return focusLayers().some(function (layer) {
                return layer.defId === def.id || layer.key === key || layer.lidarKey === key;
            });
        }
        return false;   /* without a focus none of the registry's own is kept */
    }

    function desktopBasemapDefs() {
        if (isMobile() || typeof root.getArcgisBasemap !== 'function') return [];
        var ids = {
            imagery: ['base.imagery'],
            topographic: ['base.topographic'],
            terrain: ['base.terrain-base', 'base.terrain-relief']
        };
        var key;
        try { key = root.getArcgisBasemap(); } catch (e) { return []; }
        return (ids[key] || []).map(function (id) { return REGISTRY.get(id); }).filter(Boolean);
    }

    function plan() {
        var cfg = REGISTRY.config();
        var lidarKeep = lidarFilter();
        var items = state.mirror.items.slice().filter(lidarKeep);
        /* Desktop basemaps follow the picker, not a transient snapshot of the
         * hidden Leaflet stack. Keep overlays mirrored, but give the selected
         * ArcGIS sheet(s) stable, explicit entries in the 3D deck. */
        var desktopBases = desktopBasemapDefs();
        if (desktopBases.length) {
            items = items.filter(function (item) {
                var def = item.defId && REGISTRY.get(item.defId);
                return item.pane !== 'pane_satellite' &&
                    !(def && def.base && def.id !== 'base.hillshade');
            });
        }
        var entries = [];
        var seq = 0;

        /* 1. something must be at the bottom */
        items.forEach(function (item) {
            entries.push({ id: 'm3d-2d-' + item.key, z: item.z, seq: seq += 1, kind: item.kind, item: item, mirrored: true });
        });

        desktopBases.forEach(function (def) {
            entries.push({ id: def.id, z: 398, seq: seq += 1, kind: 'registry', def: def });
        });

        /* 2. registry fallbacks (raster only) */
        activeRegistryFallbacks().forEach(function (def) {
            if (desktopBases.length && def.base && def.id !== 'base.hillshade') return;
            entries.push({ id: def.id, z: def.z == null ? 500 : def.z, seq: seq += 1, kind: 'registry', def: def });
        });

        /* 3. the hillshade belongs directly above the base map and below every
         *    overlay: that is the whole point — the relief reads through the
         *    imagery instead of hiding underneath it. */
        var base = mirroredBaseItem();
        var baseEntryId = desktopBases.length ? desktopBases[desktopBases.length - 1].id
            : base ? 'm3d-2d-' + base.key
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
                delete state.sourceData[sourceId];
                delete state.sourceTiles[sourceId];
                try { if (map.getSource(sourceId)) map.removeSource(sourceId); } catch (e) { /* ignore */ }
            });
        }
        delete state.rendered[id];
        delete state.bound[id];
        delete state.status[id];
    }

    /* MapLibre re-parses whatever setData() is handed, and sync() runs on every
     * pan, panel change and 1.5 s poll. The mirror hands out the *identical*
     * GeoJSON object while a layer has not changed (its group cache), so
     * re-uploading it would reparse a 20 000-feature Roman-roads bundle on every
     * moveend — the “3D crawls while the roads are on” report. */
    function setSourceData(sourceId, data) {
        if (!map) return false;                       /* 3D closed: nothing to upload to */
        var source = map.getSource(sourceId);
        if (!source) return false;
        if (state.sourceData[sourceId] === data) return true;
        try {
            source.setData(data);
            state.sourceData[sourceId] = data;
        } catch (e) { return false; }
        return true;
    }

    /* setTiles() re-loads the whole source — every visible tile is asked for
     * again, and MapLibre aborts the requests already in flight. Renderers run
     * on every pan, panel change and 1.5 s poll, so a steady-state sync must not
     * call it: the template is remembered, and only a real change (or a forced
     * reload after a host healed) reaches the map. Reloading every 1.5 s is what
     * made the LiDAR layers look like they never finish loading in 3D. */
    function setSourceTiles(sourceId, tiles, force) {
        if (!map) return false;                       /* 3D closed: nothing to reload */
        var source = map.getSource(sourceId);
        if (!source) return false;
        var key = (tiles || []).join('|');
        if (!force && state.sourceTiles[sourceId] === key) return true;
        try {
            if (typeof source.setTiles === 'function') {
                source.setTiles(tiles);
                state.sourceTiles[sourceId] = key;
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function renderRaster(entry) {
        var item = entry.item;
        var sourceId = entry.id + '-src';
        /* One focused layer has ONE route (see rasterTilesFor). The flag has to
         * be known before the template is chosen: a def-backed LiDAR layer must
         * not fall back to the registry's own renderer, because that renderer
         * is a different tile source with a different CORS/proxy policy and no
         * knowledge of the disc the user prepared. */
        var focused = !!(state.focus && focusMatches(item));
        /* Only a DISC focus bounds the source and caps its zoom. A whole-layer
         * focus draws the layer the way the 2D map does: everywhere, at every
         * zoom the layer has. */
        var discFocus = focused && focusScope(state.focus) === 'disc';
        var plan = discFocus ? planForLayer(item.lidarKey || item.key) : null;
        var tiles = rasterTilesFor(item, focused);
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
        /* The focused LiDAR layer is limited to the disc the user prepared: a
         * raster source with `bounds` never asks for a tile outside it, which is
         * the difference between a few hundred prepared tiles and a national
         * pyramid nobody asked for. The tiles that only graze the disc's
         * rectangle are clipped pixel by pixel in the protocol handler. */
        if (discFocus && state.focus.bounds) spec.bounds = state.focus.bounds;
        /* …and it stops at the deepest zoom the prefetch actually prepared
         * for THIS layer (a disc can hold several layers, each with its own
         * native maximum and its own plan). Without this the source kept the
         * layer's native maximum, so pinching past the prepared ceiling made
         * MapLibre request tiles that were never downloaded: each one went
         * through dl2d:// into a live fetch that raced MapLibre's
         * cancel-while-zooming, and a phone spent the pinch showing the base
         * map. Capped here, the same pinch OVERZOOMS the prepared tiles
         * (sharp down to ~0.5 m/px at z18): LiDAR stays on screen, no request
         * is made, and the only thing lost is detail the prefetch never
         * bought. A whole-layer focus has no plan at all, so nothing is
         * capped: the layer loads entirely, exactly as asked. */
        if (discFocus && plan && plan.zoomTo != null) {
            /* Never below the source's own floor: a maxzoom under minzoom is a
             * source MapLibre can only draw nothing for, which is one more way
             * a "prepared" disc ends up as the base map alone. */
            spec.maxzoom = Math.max(Number(spec.minzoom) || 0,
                Math.min(Number(spec.maxzoom), Number(plan.zoomTo)));
        }
        if (!map.getSource(sourceId)) {
            map.addSource(sourceId, spec);
        } else {
            try {
                var current = map.getSource(sourceId).tiles || [];
                if (current[0] !== spec.tiles[0]) setSourceTiles(sourceId, spec.tiles, true);
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
            /* The 2D look of these layers comes from a CSS blend mode MapLibre
             * lacks; the tiles are repainted instead (see blendedTile). */
            blend: item.blend || null,
            kind: item.kind,
            mirrored: true,
            defId: item.defId || null,
            label: item.label,
            paneZ: item.z,
            /* One LiDAR layer at a time, inside one prepared disc. */
            lidarKey: item.lidarKey || null,
            focused: focused
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
     *
     * THE FOCUSED LiDAR LAYER IS THE EXCEPTION, AND ALWAYS TAKES THE dl2d://
     * ROUTE — def-backed or not. js/lidar-3d-focus.js prepares the disc through
     * that very route: the live layer's own URL, the viewer's own CORS/proxy
     * decision (`preferProxy` for the WMS products, the healed-host rule for
     * the rest) and the disc clip. A registry template is a *different* renderer
     * with a different policy — `dl3d://` for the bbox builders, `?layer=…` the
     * moment the prefetch healed the host, or the provider URL for the tile
     * builders — and none of them asks the prepared cache for anything. So a
     * disc the dialog had just reported as ready was rebuilt tile by tile from
     * the network, and on a host that only answers through the proxy the whole
     * sheet came back empty over the base map: “the fetch finishes, the tiles
     * are ready, and 3D shows only the base map”. One focused layer, one route.
     */
    function rasterTilesFor(item, focused) {
        /* `render: 'none'` is the one mirrored raster with no per-tile route at
         * all (no getTileUrl, no createTile): the dl2d handler could not build
         * a single one of its tiles, so it keeps the registry's template. A
         * focused item whose live layer is gone (the descriptor outlived it)
         * keeps it too — a registry template that still works beats a key the
         * dl2d handler can only reject. */
        if ((!focused || item.render === 'none' || !item.layer) && item.defId) {
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

    var REFRESH_RADIUS_KM = 1;

    function refreshRegistrySpec(def) {
        if (!def || typeof REGISTRY.rasterSource !== 'function') return null;
        try {
            return REGISTRY.rasterSource(def, {
                proxyHosts: Object.keys(state.proxyHosts),
                time: REGISTRY.timeOf(def),
                mode: REGISTRY.modeOf(def, {})
            });
        } catch (e) { return null; }
    }

    function refreshDefLabel(def) {
        var title = def && def.title;
        if (title && typeof title === 'object') title = title[lang()] || title.en || title.ro;
        return String(title || (def && def.id) || 'raster layer');
    }

    /** Fail closed on every LiDAR spelling the live map / registry can carry. */
    function isRefreshLidar(item, def) {
        if (item && item.lidarKey) return true;
        if (def && def.group === 'lidar') return true;
        var layer = item && item.layer;
        if (!layer) return false;
        if (layer._dlLidar && layer._dlLidar.key) return true;
        try {
            if (root._lidarGroup && typeof root._lidarGroup.hasLayer === 'function' &&
                    root._lidarGroup.hasLayer(layer)) return true;
        } catch (e) { /* ignore */ }
        var options = layer.options || {};
        return /\blidar\b/i.test(String(options.name || '') + ' ' + String(options.className || ''));
    }

    function refreshTileInBounds(bounds, z, x, y) {
        if (!bounds || bounds.length < 4 || !MIRROR.disc || !MIRROR.disc.tileBounds) return true;
        var tile = MIRROR.disc.tileBounds(z, x, y);
        var south = Number(bounds[1]), north = Number(bounds[3]);
        if (tile.north < south || tile.south > north) return false;
        var west = Number(bounds[0]), east = Number(bounds[2]);
        if (west <= east) return tile.east >= west && tile.west <= east;
        /* A bounds box crossing the antimeridian is two longitude ranges. */
        return tile.east >= west || tile.west <= east;
    }

    function refreshTileBbox3857(z, x, y) {
        var half = Math.PI * 6378137;
        var size = (2 * half) / Math.pow(2, z);
        var minX = -half + x * size;
        var maxY = half - y * size;
        return [minX, maxY - size, minX + size, maxY].join(',');
    }

    /** Resolve the standard MapLibre placeholders for one Web-Mercator tile. */
    function refreshUrlFromTemplate(template, tile, scheme, def) {
        var url = String(template || '');
        if (!url) return '';
        if (/^dl3d:\/\//.test(url)) {
            try { return def && REGISTRY.tileUrlAt ? REGISTRY.tileUrlAt(def, tile.z, tile.x, tile.y) : ''; }
            catch (e) { return ''; }
        }
        var n = Math.pow(2, tile.z);
        var tmsY = n - 1 - tile.y;
        var y = scheme === 'tms' ? tmsY : tile.y;
        return url
            .replace(/\{bbox-epsg-3857\}/gi, refreshTileBbox3857(tile.z, tile.x, tile.y))
            .replace(/\{bbox-epsg-900913\}/gi, refreshTileBbox3857(tile.z, tile.x, tile.y))
            .replace(/\{-y\}/g, String(tmsY))
            .replace(/\{z\}/g, String(tile.z))
            .replace(/\{x\}/g, String(tile.x))
            .replace(/\{y\}/g, String(y));
    }

    function refreshSourceIds(entry) {
        var rendered = entry && state.rendered[entry.id];
        if (rendered && rendered.sourceIds && rendered.sourceIds.length) return rendered.sourceIds.slice();
        if (!entry) return [];
        if (entry.kind === 'registry') return [entry.id];
        if (entry.kind === 'raster') return [entry.id + '-src'];
        return [];
    }

    function makeRegistryRefreshSource(def, entry, item) {
        if (!def || isRefreshLidar(item, def)) return null;
        var spec = refreshRegistrySpec(def);
        if (!spec || !spec.tiles || !spec.tiles.length) return null;
        var template = String(spec.tiles[0] || '');
        var key = item ? item.key : 'def:' + def.id;
        var sourceIds = refreshSourceIds(entry);
        return {
            key: key,
            label: (item && item.label) || refreshDefLabel(def),
            defId: def.id,
            layerKey: key,
            template: template,
            route: 'url',
            minZoom: item && item.minzoom != null ? item.minzoom : spec.minzoom,
            maxZoom: item && item.maxzoom != null ? item.maxzoom : spec.maxzoom,
            tileSize: (item && item.tileSize) || spec.tileSize || 256,
            bounds: (item && item.bounds) || spec.bounds || null,
            scheme: spec.scheme || null,
            paneZ: item && item.z != null ? item.z : (def.z == null ? 500 : def.z),
            sourceIds: sourceIds,
            order: entry && entry.seq || 0,
            urlFor: function (tile) { return refreshUrlFromTemplate(template, tile, spec.scheme, def); }
        };
    }

    function makeRefreshSource(entry) {
        if (!entry) return null;
        if (entry.kind === 'registry') return makeRegistryRefreshSource(entry.def, entry, null);
        if (entry.kind !== 'raster' || !entry.item) return null;
        var item = entry.item;
        var def = item.defId ? REGISTRY.get(item.defId) : null;
        if (isRefreshLidar(item, def)) return null;
        /* A def-backed mirrored layer uses the exact registry template the 3D
         * source uses (including a proxy or a per-tile dl3d:// builder). */
        if (def) {
            var registrySource = makeRegistryRefreshSource(def, entry, item);
            if (registrySource) return registrySource;
        }
        var layer = item.layer;
        if (!layer || item.render === 'none') return null;
        if (item.render === 'canvas') {
            return {
                key: item.key,
                label: item.label || item.key,
                layerKey: item.key,
                template: MIRROR.templateFor ? MIRROR.templateFor(layer) : item.template,
                route: 'canvas',
                minZoom: item.minzoom,
                maxZoom: item.maxzoom,
                tileSize: item.tileSize || 256,
                bounds: item.bounds || null,
                paneZ: item.z,
                sourceIds: refreshSourceIds(entry),
                order: entry.seq || 0
            };
        }
        if (typeof MIRROR.tileUrlFor !== 'function') return null;
        return {
            key: item.key,
            label: item.label || item.key,
            layerKey: item.key,
            template: MIRROR.templateFor ? MIRROR.templateFor(layer) : item.template,
            route: 'url',
            minZoom: item.minzoom,
            maxZoom: item.maxzoom,
            tileSize: item.tileSize || 256,
            bounds: item.bounds || null,
            paneZ: item.z,
            sourceIds: refreshSourceIds(entry),
            order: entry.seq || 0,
            preferProxy: function (url) {
                var options = layer.options || {};
                return !!((options.layers || options.layer) || /[?&](service=wms|request=getmap)/i.test(url || ''));
            },
            urlFor: function (tile) {
                try { return MIRROR.tileUrlFor(layer, tile.z, tile.x, tile.y) || ''; }
                catch (e) { return ''; }
            }
        };
    }

    function makeTemplateRefreshSource(options) {
        options = options || {};
        var templates = options.tiles || [];
        if (!templates.length) return null;
        var template = String(templates[0] || '');
        if (!template) return null;
        return {
            key: options.key,
            label: options.label || options.key || 'raster source',
            layerKey: options.key,
            template: template,
            route: 'url',
            minZoom: options.minZoom,
            maxZoom: options.maxZoom,
            tileSize: options.tileSize || 256,
            bounds: options.bounds || null,
            scheme: options.scheme || null,
            paneZ: options.paneZ == null ? -1 : options.paneZ,
            sourceIds: options.sourceIds || [],
            order: options.order || 0,
            urlFor: function (tile) { return refreshUrlFromTemplate(template, tile, options.scheme, null); }
        };
    }

    function tileDistanceFromCentre(disc, z, x, y) {
        if (!MIRROR.disc || !MIRROR.disc.distanceM || !MIRROR.disc.latAt || !MIRROR.disc.lngAt) return 0;
        return MIRROR.disc.distanceM(disc, {
            lat: MIRROR.disc.latAt(y + 0.5, z),
            lng: MIRROR.disc.lngAt(x + 0.5, z)
        });
    }

    /**
     * Make a lazy plan for every active non-LiDAR raster source. It records an
     * exact tile count up front, then emits one zoom level at a time so an
     * unusually deep source does not require a huge tile-list allocation.
     */
    function planTileRefresh(center) {
        center = center || (map && map.getCenter ? map.getCenter() : null);
        var lat = center && Number(center.lat);
        var rawLng = center && Number(center.lng);
        /* MapLibre can report an unwrapped longitude after panning through a
         * world copy. Tile x is canonical, so normalize before making the disc
         * or a centre east/west of ±180° would produce an empty tile window. */
        var lng = isFinite(rawLng) ? ((rawLng + 180) % 360 + 360) % 360 - 180 : NaN;
        var disc = isFinite(lat) && isFinite(lng)
            ? MIRROR.disc.of({ lat: lat, lng: lng, radiusKm: REFRESH_RADIUS_KM }) : null;
        if (!disc) return { center: null, radiusKm: REFRESH_RADIUS_KM, total: 0, layers: [], groups: [], skipped: [], sourceIds: [], nextEntry: function () { return null; } };

        collectMirror();
        var active = plan();
        var sources = [];
        var skipped = [];
        var seen = {};
        active.entries.forEach(function (entry) {
            if (entry.kind !== 'raster' && entry.kind !== 'registry') return;
            var source = makeRefreshSource(entry);
            if (!source) {
                var def = entry.def || (entry.item && entry.item.defId ? REGISTRY.get(entry.item.defId) : null);
                if (!isRefreshLidar(entry.item, def)) skipped.push((entry.item && entry.item.label) || (def && refreshDefLabel(def)) || entry.id);
                return;
            }
            if (seen[source.key]) return;
            seen[source.key] = true;
            sources.push(source);
        });

        /* The fallback base map is added outside plan() only if no live 2D
         * basemap exists. Include it when it is actually present in the deck. */
        if (!mirroredBaseItem() && map && map.getSource) {
            try {
                if (map.getSource('base.imagery')) {
                    var baseDef = REGISTRY.get('base.imagery');
                    var baseSource = makeRegistryRefreshSource(baseDef,
                        { id: 'base.imagery', kind: 'registry', seq: -1 }, null);
                    if (baseSource && !seen[baseSource.key]) {
                        seen[baseSource.key] = true;
                        sources.push(baseSource);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        /* The 3D terrain DEM is an active raster source too. It is not LiDAR;
         * use the same mobile zoom ceiling as buildStyle(). */
        if (map && map.getSource) {
            var dem = terrainSource();
            if (dem && !dem.missingKey && dem.tiles && dem.tiles.length) {
                var demMax = isMobile()
                    ? Math.min(Number(dem.maxzoom == null ? 22 : dem.maxzoom), Number((REGISTRY.config().perf || {}).mobileMaxTerrainZoom || 22))
                    : dem.maxzoom;
                var demSource = makeTemplateRefreshSource({
                    key: 'source:' + (dem.id || 'terrain-dem'),
                    label: '3D terrain elevation',
                    tiles: dem.tiles,
                    minZoom: isMobile() ? 0 : dem.minzoom,
                    maxZoom: demMax,
                    tileSize: dem.tileSize || 256,
                    sourceIds: [dem.id]
                });
                try {
                    if (demSource && map.getSource(dem.id)) {
                        if (!seen[demSource.key]) sources.push(demSource);
                        seen[demSource.key] = true;
                    }
                } catch (e) { /* ignore */ }
            }

            var hillshade = REGISTRY.config().hillshade || {};
            if (hillshade.enabled && hillshade.mode === 'service' && hillshade.serviceTiles &&
                    hillshade.serviceTiles.length) {
                var hillSource = makeTemplateRefreshSource({
                    key: 'source:m3d-hillshade-service',
                    label: '3D hillshade',
                    tiles: hillshade.serviceTiles,
                    minZoom: 0,
                    maxZoom: hillshade.serviceMaxzoom || 16,
                    sourceIds: ['m3d-hillshade-service'],
                    paneZ: -2
                });
                try {
                    if (hillSource && map.getSource('m3d-hillshade-service') && !seen[hillSource.key]) {
                        seen[hillSource.key] = true;
                        sources.push(hillSource);
                    }
                } catch (e) { /* ignore */ }
            }
        }

        var targetZoom = map && map.getZoom ? Math.round(Number(map.getZoom()) || 0) : 0;
        var groups = [];
        var total = 0;
        sources.forEach(function (source) {
            var rawMin = Number(source.minZoom);
            var rawMax = Number(source.maxZoom);
            var minZoom = Math.max(0, Math.min(22, isFinite(rawMin) ? Math.ceil(rawMin) : 0));
            var maxZoom = Math.max(0, Math.min(22, isFinite(rawMax) ? Math.floor(rawMax) : 22));
            source.zoomFrom = minZoom;
            source.zoomTo = maxZoom;
            source.tileCount = 0;
            if (maxZoom < minZoom) return;
            for (var z = minZoom; z <= maxZoom; z += 1) {
                var window = MIRROR.disc.tileWindow(disc, z);
                var count = 0;
                for (var x = window.x0; x <= window.x1; x += 1) {
                    for (var y = window.y0; y <= window.y1; y += 1) {
                        if (!MIRROR.disc.touchesTile(disc, z, x, y)) continue;
                        if (!refreshTileInBounds(source.bounds, z, x, y)) continue;
                        count += 1;
                    }
                }
                if (!count) continue;
                source.tileCount += count;
                total += count;
                groups.push({ source: source, z: z, window: window, count: count, started: false, tiles: null, tileIndex: 0 });
            }
        });

        groups.sort(function (a, b) {
            var zoomPriority = Math.abs(b.z - targetZoom) - Math.abs(a.z - targetZoom);
            if (zoomPriority) return zoomPriority; /* the live camera zoom is prepared last */
            if (a.z !== b.z) return a.z - b.z;
            if (a.source.paneZ !== b.source.paneZ) return a.source.paneZ - b.source.paneZ;
            return a.source.order - b.source.order;
        });

        var groupIndex = 0;
        function loadGroupTiles(group) {
            var tiles = [];
            var window = group.window;
            for (var x = window.x0; x <= window.x1; x += 1) {
                for (var y = window.y0; y <= window.y1; y += 1) {
                    if (!MIRROR.disc.touchesTile(disc, group.z, x, y)) continue;
                    if (!refreshTileInBounds(group.source.bounds, group.z, x, y)) continue;
                    tiles.push({ z: group.z, x: x, y: y,
                        distanceM: tileDistanceFromCentre(disc, group.z, x, y) });
                }
            }
            /* primed cache is FIFO: far tiles first keeps centre/current-zoom
             * tiles resident for the first 3D repaint on memory-limited phones. */
            tiles.sort(function (a, b) { return b.distanceM - a.distanceM; });
            group.tiles = tiles;
            group.started = true;
        }

        function nextEntry() {
            while (groupIndex < groups.length) {
                var group = groups[groupIndex];
                if (!group.started) loadGroupTiles(group);
                if (group.tileIndex >= group.tiles.length) {
                    group.tiles = null;
                    group.tileIndex = 0;
                    groupIndex += 1;
                    continue;
                }
                var tile = group.tiles[group.tileIndex++];
                var source = group.source;
                if (source.route === 'canvas') {
                    return { route: 'canvas', layerKey: source.layerKey, template: source.template,
                        z: tile.z, x: tile.x, y: tile.y };
                }
                var url = '';
                try { url = source.urlFor ? source.urlFor(tile) : ''; } catch (e) { url = ''; }
                if (!url) {
                    return { error: 'could not build a tile URL for ' + source.label + ' at ' +
                        tile.z + '/' + tile.x + '/' + tile.y, layerKey: source.layerKey,
                        template: source.template, z: tile.z, x: tile.x, y: tile.y };
                }
                var preferProxy = false;
                try { preferProxy = typeof source.preferProxy === 'function' && source.preferProxy(url); }
                catch (e) { preferProxy = false; }
                return { route: 'url', url: url, layerKey: source.layerKey, defId: source.defId,
                    template: source.template, preferProxy: preferProxy, z: tile.z, x: tile.x, y: tile.y };
            }
            return null;
        }

        var sourceIds = [];
        sources.forEach(function (source) {
            (source.sourceIds || []).forEach(function (id) {
                if (sourceIds.indexOf(id) === -1) sourceIds.push(id);
            });
        });
        return {
            center: { lat: lat, lng: lng },
            radiusKm: REFRESH_RADIUS_KM,
            targetZoom: targetZoom,
            total: total,
            groups: groups,
            layers: sources.map(function (source) {
                return { key: source.key, label: source.label, zoomFrom: source.zoomFrom,
                    zoomTo: source.zoomTo, count: source.tileCount };
            }),
            skipped: skipped,
            sourceIds: sourceIds,
            nextEntry: nextEntry
        };
    }

    function refreshCountText(value) {
        var count = Math.max(0, Number(value) || 0);
        try { return count.toLocaleString(lang()); } catch (e) { return String(count); }
    }

    function refreshCopy(key, values) {
        var text = t(key);
        Object.keys(values || {}).forEach(function (name) {
            text = text.replace('{' + name + '}', refreshCountText(values[name]));
        });
        return text;
    }

    function paintRefreshControl(mode, text, countText, announce) {
        if (!refreshBtn) return;
        var label = text || t('refreshTitle');
        refreshBtn.classList.remove('is-busy', 'is-stopping', 'is-result', 'is-error');
        if (mode === 'busy') refreshBtn.classList.add('is-busy');
        if (mode === 'stopping') refreshBtn.classList.add('is-stopping');
        if (mode === 'result') refreshBtn.classList.add('is-result');
        if (mode === 'error') refreshBtn.classList.add('is-error');
        refreshBtn.disabled = mode === 'stopping';
        refreshBtn.setAttribute('aria-busy', mode === 'busy' || mode === 'stopping' ? 'true' : 'false');
        refreshBtn.setAttribute('aria-label', mode === 'busy' ? t('refreshStop') : label);
        refreshBtn.title = mode === 'busy' ? t('refreshStop') + ' — ' + label : label;
        if (refreshIcon) refreshIcon.textContent = mode === 'result' ? '✓' : (mode === 'error' ? '!' : '↻');
        if (refreshCount) {
            refreshCount.textContent = countText || '';
            refreshCount.hidden = !countText;
        }
        if (refreshStatus && announce !== false) refreshStatus.textContent = label;
    }

    function resetRefreshControl() {
        if (refreshStatusTimer) root.clearTimeout(refreshStatusTimer);
        refreshStatusTimer = null;
        if (refreshJob) return;
        paintRefreshControl('idle', t('refreshTitle'), '', true);
    }

    function showRefreshResult(mode, message, countText) {
        if (refreshStatusTimer) root.clearTimeout(refreshStatusTimer);
        refreshStatusTimer = null;
        paintRefreshControl(mode || 'result', message, countText || '', true);
        refreshStatusTimer = root.setTimeout(function () {
            if (!refreshJob) resetRefreshControl();
        }, 7000);
    }

    function reloadRefreshSources(refreshPlan) {
        if (!map || !refreshPlan || !refreshPlan.sourceIds) return;
        refreshPlan.sourceIds.forEach(function (sourceId) {
            var source = null;
            try { source = map.getSource(sourceId); } catch (e) { source = null; }
            if (!source || !source.tiles || !source.tiles.length) return;
            setSourceTiles(sourceId, source.tiles.slice(), true);
        });
    }

    function emptyRefreshReport(message) {
        return { total: 0, done: 0, prepared: 0, failed: 0, stopped: false,
            bytes: 0, errors: message ? [message] : [], skipped: [] };
    }

    /** Refresh every active raster source around the 3D camera centre. */
    function refreshTiles() {
        if (refreshJob) {
            if (!refreshJob.stop) {
                refreshJob.stop = true;
                var latest = refreshJob.report || { done: 0, total: refreshJob.plan.total };
                paintRefreshControl('stopping', refreshCopy('refreshStopping', latest),
                    refreshCountText(latest.done) + '/' + refreshCountText(latest.total), true);
            }
            return refreshJob.promise || Promise.resolve(refreshJob.report || emptyRefreshReport());
        }
        if (!state.open || !map) {
            var closedReport = emptyRefreshReport(t('refreshUnavailable'));
            showRefreshResult('error', t('refreshUnavailable'));
            return Promise.resolve(closedReport);
        }
        if (state.prefetching) {
            var busyReport = emptyRefreshReport(t('refreshBusy'));
            showRefreshResult('result', t('refreshBusy'));
            return Promise.resolve(busyReport);
        }
        var camera = null;
        try { camera = map.getCenter(); } catch (e) { camera = null; }
        var refreshPlan = null;
        try { refreshPlan = planTileRefresh(camera); }
        catch (planningError) {
            var planningReport = emptyRefreshReport(String((planningError && planningError.message) || planningError));
            showRefreshResult('error', String((planningError && planningError.message) || planningError));
            return Promise.resolve(planningReport);
        }
        if (!refreshPlan.center) {
            var centerReport = emptyRefreshReport(t('refreshUnavailable'));
            showRefreshResult('error', t('refreshUnavailable'));
            return Promise.resolve(centerReport);
        }
        if (!refreshPlan.total) {
            var noTiles = emptyRefreshReport(t('refreshNoLayers'));
            noTiles.center = refreshPlan.center;
            noTiles.radiusKm = refreshPlan.radiusKm;
            noTiles.layers = refreshPlan.layers;
            noTiles.skipped = refreshPlan.skipped;
            var noTilesMessage = t('refreshNoLayers');
            if (refreshPlan.skipped.length) noTilesMessage += ' (' + refreshCountText(refreshPlan.skipped.length) + ')';
            showRefreshResult('result', noTilesMessage);
            return Promise.resolve(noTiles);
        }

        var job = { stop: false, plan: refreshPlan, report: null, lastPaintAt: 0,
            lastAnnouncedPercent: -1, promise: null };
        refreshJob = job;
        if (refreshStatusTimer) root.clearTimeout(refreshStatusTimer);
        refreshStatusTimer = null;
        var initial = { done: 0, total: refreshPlan.total };
        paintRefreshControl('busy', refreshCopy('refreshProgress', initial),
            '0/' + refreshCountText(refreshPlan.total), true);

        var prefetch;
        try {
            prefetch = prefetchTiles(null, {
                total: refreshPlan.total,
                nextEntry: refreshPlan.nextEntry,
                shouldStop: function () { return job.stop; },
                onProgress: function (report) {
                    job.report = report;
                    var now = Date.now();
                    if (report.done === report.total || now - job.lastPaintAt >= 300) {
                        job.lastPaintAt = now;
                        var copy = refreshCopy(job.stop ? 'refreshStopping' : 'refreshProgress', report);
                        var percent = report.total ? Math.floor((report.done / report.total) * 100) : 100;
                        var announce = report.done === report.total || percent >= job.lastAnnouncedPercent + 5;
                        if (announce) job.lastAnnouncedPercent = percent;
                        paintRefreshControl(job.stop ? 'stopping' : 'busy', copy,
                            refreshCountText(report.done) + '/' + refreshCountText(report.total), announce);
                    }
                }
            });
        } catch (error) { prefetch = Promise.reject(error); }

        job.promise = Promise.resolve(prefetch).then(function (report) {
            report.center = refreshPlan.center;
            report.radiusKm = refreshPlan.radiusKm;
            report.layers = refreshPlan.layers;
            report.layerCount = refreshPlan.layers.filter(function (layer) { return layer.count > 0; }).length;
            report.skipped = refreshPlan.skipped.slice();
            reloadRefreshSources(refreshPlan);
            if (refreshJob === job) refreshJob = null;
            var message = report.stopped
                ? refreshCopy('refreshStopped', report)
                : refreshCopy('refreshDone', report);
            if (report.skipped.length) message += ' · skipped ' + refreshCountText(report.skipped.length);
            showRefreshResult(report.failed ? 'error' : 'result', message,
                refreshCountText(report.prepared) + '/' + refreshCountText(report.total));
            return report;
        }, function (error) {
            var report = emptyRefreshReport(String((error && error.message) || error));
            report.center = refreshPlan.center;
            report.radiusKm = refreshPlan.radiusKm;
            report.layers = refreshPlan.layers;
            report.skipped = refreshPlan.skipped.slice();
            if (refreshJob === job) refreshJob = null;
            showRefreshResult('error', String((error && error.message) || error));
            return report;
        });
        return job.promise;
    }

    function renderRegistryRaster(entry) {
        var def = entry.def;
        var spec = REGISTRY.rasterSource(def, {
            proxyHosts: Object.keys(state.proxyHosts),
            time: REGISTRY.timeOf(def),
            mode: def.modes || (def.kind === 'dynamic' && typeof def.resolve === 'function') ? REGISTRY.modeOf(def, {}) : ''
        });
        var focused = !!(state.focus && focusMatches({ defId: def.id, lidarKey: 'def:' + def.id }));
        var discFocus = focused && focusScope(state.focus) === 'disc';
        var plan = discFocus ? planForLayer('def:' + def.id) : null;
        if (discFocus && state.focus.bounds) spec.bounds = state.focus.bounds;
        /* Same ceiling as the mirrored path: prepared up to plan.zoomTo, then
         * overzoomed — never a zoom the prefetch did not buy. A whole-layer
         * focus has no plan, so the registry's own zoom window stands. */
        if (discFocus && plan && plan.zoomTo != null) {
            /* Floored at the source's own minzoom — see renderRaster(). */
            spec.maxzoom = Math.max(Number(spec.minzoom) || 0,
                Math.min(Number(spec.maxzoom == null ? 22 : spec.maxzoom), Number(plan.zoomTo)));
        }
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
            label: (def.title && (def.title[lang()] || def.title.en)) || def.id,
            lidarKey: def.group === 'lidar' ? 'def:' + def.id : null,
            focused: focused
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
            setSourceData(sourceId, item.geojson);
        } else {
            map.addSource(sourceId, { type: 'geojson', data: item.geojson });
            state.sourceData[sourceId] = item.geojson;
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

    /* MapLibre's style validation refuses a layer whose paint carries a
     * property of another layer type (a 'line-color' inside a fill paint
     * dropped the Archeological Report's fill layer in real browsers while
     * every headless stub accepted it). Keep each paint inside its own
     * namespace, so a stray key from any present or future bridge costs
     * that one property, never the whole layer. */
    function paintForType(paint, type) {
        var out = {};
        Object.keys(paint || {}).forEach(function (key) {
            if (key.indexOf(type + '-') === 0) out[key] = paint[key];
        });
        return out;
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
        /* Per-feature paint (heritage bridge): each feature carries its own
         * colour/radius (layer-0 green vs layer-6 red sites, 600 m radii as
         * polygons), so the single Leaflet paint becomes a fallback coalesce. */
        var fillPaint = paints.fill, linePaint = paints.line, circlePaint = paints.circle;
        if (item.perFeature) {
            fillPaint = Object.assign({}, paints.fill, {
                'fill-color': ['coalesce', ['get', 'fillColor'], ['get', 'color'], paints.fill['fill-color'] || '#3388ff'],
                'fill-opacity': ['coalesce', ['get', 'fillOpacity'], paints.fill['fill-opacity'] == null ? 0.2 : paints.fill['fill-opacity']]
            });
            linePaint = Object.assign({}, paints.line, {
                'line-color': ['coalesce', ['get', 'color'], paints.line['line-color'] || '#3388ff'],
                'line-opacity': ['coalesce', ['get', 'opacity'], paints.line['line-opacity'] == null ? 1 : paints.line['line-opacity']],
                'line-width': ['coalesce', ['get', 'weight'], paints.line['line-width'] == null ? 2 : paints.line['line-width']]
            });
            circlePaint = Object.assign({}, paints.circle, {
                'circle-color': ['coalesce', ['get', 'fillColor'], ['get', 'color'], paints.circle['circle-color'] || '#3388ff'],
                'circle-stroke-color': ['coalesce', ['get', 'color'], paints.circle['circle-stroke-color'] || '#3388ff'],
                'circle-radius': ['coalesce', ['get', 'radius'], paints.circle['circle-radius'] == null ? 5 : paints.circle['circle-radius']],
                'circle-opacity': ['coalesce', ['get', 'fillOpacity'], paints.circle['circle-opacity'] == null ? 0.9 : paints.circle['circle-opacity']]
            });
        }

        fillPaint = paintForType(fillPaint, 'fill');
        linePaint = paintForType(linePaint, 'line');
        circlePaint = paintForType(circlePaint, 'circle');
        if (hasPolygon) {
            var fillId = entry.id + '-fill';
            if (!map.getLayer(fillId)) {
                map.addLayer({ id: fillId, type: 'fill', source: sourceId, filter: ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false], paint: fillPaint });
            } else {
                setPaint(fillId, fillPaint);
            }
            ids.push(fillId);
        }
        if (hasPolygon || hasLine) {
            var lineId = entry.id + '-line';
            if (!map.getLayer(lineId)) {
                map.addLayer({ id: lineId, type: 'line', source: sourceId, paint: linePaint, layout: layout });
            } else {
                setPaint(lineId, linePaint);
                setLayout(lineId, layout);
            }
            ids.push(lineId);
        }
        if (hasPoint) {
            var circleId = entry.id + '-circle';
            var pointFilter = item.perFeature || (item.icons && Object.keys(item.icons).length)
                ? ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'iconId']], ['!', ['has', 'noDot']]]
                : null;
            if (!map.getLayer(circleId)) {
                var circleSpec = {
                    id: circleId, type: 'circle', source: sourceId,
                    paint: item.perFeature ? circlePaint
                        : (hasCircle ? paints.circle : Object.assign({}, paints.circle, { 'circle-opacity': 0.85 }))
                };
                if (pointFilter) circleSpec.filter = pointFilter;
                map.addLayer(circleSpec);
            } else {
                setPaint(circleId, item.perFeature ? circlePaint
                    : (hasCircle ? paints.circle : Object.assign({}, paints.circle, { 'circle-opacity': 0.85 })));
            }
            ids.push(circleId);
            /* Pins inside a GeoJSON (DARE markers via pointToLayer) and any
             * per-feature labels: same symbol treatment as plain markers. */
            markerSymbolLayers(entry, sourceId, item, { suffix: '' }).forEach(function (id) { ids.push(id); });
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
            setSourceData(sourceId, item.geojson);
        } else {
            map.addSource(sourceId, { type: 'geojson', data: item.geojson });
            state.sourceData[sourceId] = item.geojson;
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


    /* Symbol (per-feature icon) + label layers for a point source whose
     * features carry iconId/label/noDot (mirror contract). Used by markers,
     * clusters and GeoJSON point layers alike (DARE glyphs, OSM Places
     * labels, event pins): the icon comes from the feature, never from the
     * first feature of the bundle. Returns layer ids created/ensured. */
    function markerSymbolLayers(entry, sourceId, item, opts) {
        opts = opts || {};
        var ids = [];
        var icons = item.icons || {};
        var iconIds = Object.keys(icons);
        var ready = iconIds.length > 0;
        iconIds.forEach(function (id) {
            if (!ensureImage(icons[id].url, function () { scheduleSync(); })) ready = false;
        });
        if (ready && iconIds.length) {
            var symbolId = entry.id + opts.suffix + '-icon';
            var layout = {
                'icon-image': ['image', ['get', 'iconId']],
                'icon-size': 1,
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                'icon-anchor': 'center'
            };
            if (!map.getLayer(symbolId)) {
                map.addLayer({ id: symbolId, type: 'symbol', source: sourceId,
                    filter: ['has', 'iconId'], layout: layout });
            }
            ids.push(symbolId);
        }
        var labelId = entry.id + opts.suffix + '-label';
        if (!map.getLayer(labelId)) {
            map.addLayer({
                id: labelId, type: 'symbol', source: sourceId,
                filter: ['all', ['has', 'label'], ['!=', ['get', 'label'], '']],
                layout: {
                    'text-field': ['get', 'label'],
                    'text-size': 11,
                    'text-offset': [0, 1.1],
                    'text-anchor': 'top',
                    'text-allow-overlap': false,
                    'text-optional': true
                },
                paint: { 'text-color': '#ffffff', 'text-halo-color': '#111827', 'text-halo-width': 1.2 }
            });
        }
        ids.push(labelId);
        return ids;
    }

    function renderMarkers(entry, tries) {
        tries = tries || 0;
        var item = entry.item;
        var sourceId = entry.id + '-src';
        var data = markerSourceData(item);
        if (map.getSource(sourceId)) {
            setSourceData(sourceId, data);
        } else {
            map.addSource(sourceId, { type: 'geojson', data: data });
            state.sourceData[sourceId] = data;
        }
        var ids = [];
        /* Fallback dot: only for features with no icon of their own and not
         * label-only (OSM Places anchors must not sprout invented pins). */
        var circleId = entry.id + '-dot';
        if (!map.getLayer(circleId)) {
            map.addLayer({
                id: circleId, type: 'circle', source: sourceId,
                filter: ['all', ['!', ['has', 'iconId']], ['!', ['has', 'noDot']]],
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#f59e0b',
                    'circle-stroke-color': '#1f2937',
                    'circle-stroke-width': 1.5,
                    'circle-opacity': item.opacity == null ? 0.95 : item.opacity
                }
            });
        } else {
            map.setPaintProperty(circleId, 'circle-opacity', item.opacity == null ? 0.95 : item.opacity);
        }
        ids.push(circleId);
        markerSymbolLayers(entry, sourceId, item, { suffix: '' }).forEach(function (id) { ids.push(id); });
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
            setSourceData(sourceId, item.geojson);
            try { map.getSource(sourceId).setClusterOptions({ clusterRadius: spec.clusterRadius, clusterMaxZoom: spec.clusterMaxZoom }); } catch (e) { /* ignore */ }
        } else {
            map.addSource(sourceId, spec);
            state.sourceData[sourceId] = item.geojson;
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
                id: dotId, type: 'circle', source: sourceId,
                filter: ['all', ['!', ['has', 'point_count']], ['!', ['has', 'iconId']], ['!', ['has', 'noDot']]],
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
        markerSymbolLayers(entry, sourceId, item, { suffix: '' }).forEach(function (id) { ids.push(id); });
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

    function pickInteractiveFeature(features) {
        if (!features || !features.length) return null;
        var withPopup = [];
        for (var i = 0; i < features.length; i += 1) {
            var p = (features[i] && features[i].properties) || {};
            if (p.popup) withPopup.push(features[i]);
        }
        if (withPopup.length === 1) return withPopup[0];
        if (withPopup.length > 1) {
            withPopup.sort(function (a, b) {
                var ra = Number(a.properties && a.properties.radiusM);
                var rb = Number(b.properties && b.properties.radiusM);
                if (isFinite(ra) && isFinite(rb) && ra !== rb) return ra - rb;
                return 0;
            });
            return withPopup[0];
        }
        for (var j = 0; j < features.length; j += 1) {
            var pj = (features[j] && features[j].properties) || {};
            if (pj.kind !== 'radius' && pj.kind !== 'exclusion') return features[j];
        }
        return features[0];
    }

    function bindInteractions(entry, rendered) {
        if (!rendered.interactive || !rendered.layerIds) return;
        var alreadyBound = state.bound[entry.id] || [];
        if (alreadyBound.join(',') === rendered.layerIds.join(',')) return;
        state.bound[entry.id] = rendered.layerIds.slice();
        rendered.layerIds.forEach(function (layerId) {
            if (alreadyBound.indexOf(layerId) !== -1) return;
            map.on('click', layerId, function (event) {
                var feature = pickInteractiveFeature(event && event.features);
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
                    /* 'radius' and 'exclusion' are shapes without a popup: the
                     * heritage circles and the Archaeological Potential red mask. */
                    if (props.kind === 'radius' || props.kind === 'exclusion') return;
                    var keys = Object.keys(props).filter(function (k) { return k !== 'popup' && k !== 'icon'; });
                    if (!keys.length) return;
                    html = '<div class="m3d-popup-body">' + keys.slice(0, 12).map(function (k) {
                        return '<div><b>' + escapeHtml(k) + ':</b> ' + escapeHtml(String(props[k])).slice(0, 200) + '</div>';
                    }).join('') + '</div>';
                }
                var popupPos = (feature.geometry && feature.geometry.type === 'Point' && Array.isArray(feature.geometry.coordinates))
                    ? feature.geometry.coordinates
                    : (event.lngLat || (isFinite(Number(props.lng)) && isFinite(Number(props.lat))
                        ? [Number(props.lng), Number(props.lat)] : null));
                showPopup(html, popupPos);
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
        /* Whatever the deck budget had to leave out is reported once, so a layer
         * that is visible in 2D and missing in 3D explains itself in
         * status().errors instead of being silently absent. */
        (result.capped || []).forEach(function (line) {
            if (state.cappedSeen[line]) return;
            state.cappedSeen[line] = true;
            pushError(line);
        });
        state.mirror = result;
    }

    /**
     * One guarded sync pass.
     *
     * Returns true only when the whole pass really ran. The 1.5 s signature
     * poll commits the signature only on a successful pass: a throw used to
     * mark the deck “up to date” and froze it on the previous plan until some
     * unrelated map change — the picker kept swapping the 2D layers while the
     * 3D view never moved (“changing the basemap does nothing”).
     */
    function runSync(reason) {
        if (!map || !state.open) return false;
        try {
            return syncLayers() !== false;
        } catch (e) {
            var msg = String((e && e.message) || e);
            pushError('sync' + (reason ? ' [' + reason + ']' : '') + ': ' + msg);
            console.warn('[Map3D] sync pass failed' + (reason ? ' (' + reason + ')' : '') + ':', e);
            return false;
        }
    }

    function syncLayers() {
        if (!map || !state.open) return false;
        var ok = true;
        /* Each phase is guarded on purpose: a throw in one phase must not
         * abort the pass, or the deck stays frozen on the last good plan while
         * the 2D map keeps changing — which is exactly the reported “the
         * basemap picker does nothing in 3D”. The mirror and the fallback are
         * non-fatal (a stale mirror still renders); a plan failure aborts this
         * pass and is reported as a failed sync so the poll retries it. */
        try { collectMirror(); } catch (e) { ok = false; pushError('mirror: ' + String((e && e.message) || e)); }
        try { ensureBaseFallback(); } catch (e) { ok = false; pushError('base fallback: ' + String((e && e.message) || e)); }

        var p = null;
        try { p = plan(); } catch (e) { ok = false; pushError('plan: ' + String((e && e.message) || e)); }
        if (!p) return ok;
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

        /* A focus the deck could not draw is the “prepared disc, base map only”
         * report in its generic form. The bar still names the focus (it is
         * state the user chose), so without this line the only evidence was an
         * empty 3D view. Say it once per distinct reason, with the reason the
         * renderer recorded. */
        if (state.focus && !state.lidarOff) {
            var drawnFocus = Object.keys(state.status).some(function (id) {
                return !!(state.status[id] && state.status[id].focused);
            });
            if (!drawnFocus) {
                var note = (state.lidarNotes || [])[0];
                var why = (note && note.reason) || 'no matching 2D layer';
                var firstFocusLayer = focusLayers()[0] || {};
                var detail = (state.status['m3d-2d-' + (firstFocusLayer.key || '')] || {}).reason || '';
                var focusName = state.focus.label || firstFocusLayer.label ||
                    state.focus.key || firstFocusLayer.key || state.focus.defId;
                if (state.focusWarned !== why) {
                    state.focusWarned = why;
                    pushError('LiDAR focus “' + focusName +
                        '” is not on the 3D deck (' + why + (detail ? ': ' + detail : '') + ')');
                }
            } else {
                state.focusWarned = null;
            }
        }

        try { applyDeck(p); } catch (e) { ok = false; pushError('deck order: ' + String((e && e.message) || e)); }
        try {
            watchSourceHealth();
            syncAttribution();
            refreshFocusRow();
        } catch (e) { ok = false; pushError('sync finish: ' + String((e && e.message) || e)); }
        state.lastSync = Date.now();
        return ok;
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
    /* ═══════════════════════════════════════════════════════════════════════
     *  THE DISC, DRAWN — so “where does the LiDAR end, and why?” is answerable
     * -----------------------------------------------------------------------
     *  A clipped raster with no outline reads as a broken layer: the user pans,
     *  the LiDAR stops, and nothing says that this was the prepared disc. The
     *  outline (plus the label in the 3D bar) is what turns it into a decision.
     * ═══════════════════════════════════════════════════════════════════════ */
    var FOCUS_SOURCE = 'm3d-lidar-disc';
    var FOCUS_LINE = 'm3d-lidar-disc-line';

    function refreshFocusOutline() {
        if (!map) return;
        var focus = state.focus;
        /* The outline stands for the disc that was prepared — a whole-layer
         * focus has no edge to draw, so it draws none. */
        var wanted = !!(focus && focus.lidarOff !== true && !state.lidarOff &&
            focusScope(focus) === 'disc' && focus.mask && MIRROR.disc && MIRROR.disc.geojson);
        var data = wanted ? MIRROR.disc.geojson(focus.mask, 96) : null;
        if (!wanted || !data) {
            try { if (map.getLayer(FOCUS_LINE)) map.removeLayer(FOCUS_LINE); } catch (e) { /* ignore */ }
            try { if (map.getSource(FOCUS_SOURCE)) map.removeSource(FOCUS_SOURCE); } catch (e) { /* ignore */ }
            delete state.sourceData[FOCUS_SOURCE];
            return;
        }
        try {
            if (!map.getSource(FOCUS_SOURCE)) {
                map.addSource(FOCUS_SOURCE, { type: 'geojson', data: data });
            } else {
                /* Through the shared upload gate, like every other GeoJSON this
                 * view has: the disc only moves when the user moves it. */
                setSourceData(FOCUS_SOURCE, data);
            }
            if (!map.getLayer(FOCUS_LINE)) {
                map.addLayer({
                    id: FOCUS_LINE,
                    type: 'line',
                    source: FOCUS_SOURCE,
                    paint: {
                        'line-color': '#c8a96e',
                        'line-width': 2,
                        'line-dasharray': [2, 2],
                        'line-opacity': 0.9
                    }
                });
            }
        } catch (e) { /* a broken outline never blocks the deck */ }
    }

    function applyDeck(p) {
        if (!map) return;
        refreshFocusOutline();
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
        /* The focus outline is not a deck entry, so the re-stack above
         * leaves it wherever the layers it was once added over have since
         * been moved to — in practice underneath the opaque background,
         * where the dashed ring that says “your LiDAR disc is here” could
         * never be seen. An annotation belongs on top of the map it
         * annotates. */
        try { if (map.getLayer(FOCUS_LINE)) map.moveLayer(FOCUS_LINE); } catch (e) { /* ignore */ }
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
        }, 7000);
        state.healthTimers.push(timer);
    }

    // Layer/provider diagnostics remain available through status()/report().
    // Visible controls stay compact: basemap picker, camera/terrain sliders,
    // reset/north/flat actions and the focused-LiDAR row.

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

    /**
     * The MapLibre constructor options for this device.
     *
     * `pixelRatio` and `maxCanvasSize` are passed IN, not applied afterwards:
     * MapLibre creates the WebGL context inside the constructor, so anything
     * set later can only resize a context that already had to be allocated at
     * the device's full ratio — which is precisely what iOS Safari refuses.
     *
     * `antialias` lives in `canvasContextAttributes` (v5 ignores a top-level
     * `antialias`, so the old code was silently running without it on desktop
     * and asking for the default on every device).
     */
    function buildMapOptions(cam, profile, safeMode) {
        var cfg = REGISTRY.config();
        var attrs = {};
        for (var key in profile.canvasContextAttributes) {
            if (Object.prototype.hasOwnProperty.call(profile.canvasContextAttributes, key)) {
                attrs[key] = profile.canvasContextAttributes[key];
            }
        }
        var pixelRatio = profile.pixelRatio;
        var maxCanvasSize = profile.maxCanvasSize;
        if (safeMode) {
            attrs.antialias = false;
            attrs.powerPreference = 'low-power';
            attrs.preserveDrawingBuffer = false;
            attrs.failIfMajorPerformanceCaveat = false;
            attrs.depth = true;
            attrs.stencil = false;
            pixelRatio = 1;
            maxCanvasSize = [1024, 1024];
        }
        var options = {
            container: surface,
            style: buildStyle(root.maplibregl || {}, safeMode),
            center: cam.center,
            zoom: cam.zoom,
            bearing: cam.bearing,
            pitch: (CONFIG.camera && CONFIG.camera.pitch) || 60,
            minZoom: (CONFIG.camera && CONFIG.camera.minZoom) || 2,
            maxZoom: (CONFIG.camera && CONFIG.camera.maxZoom) || 20,
            maxPitch: (CONFIG.camera && CONFIG.camera.maxPitch) || 80,
            /* Gesture-only camera: there are no pitch/bearing sliders in the
             * desktop bar any more, so every one of these has to stay on. A
             * right-drag (or Ctrl/⌘+drag) pitches and rotates, a two-finger
             * twist rotates / a two-finger vertical drag pitches on touch,
             * Shift+arrows rotate from the keyboard, and the wheel zooms with
             * pitchWithRotate letting the drag rotate the view while pitched. */
            dragRotate: true,
            pitchWithRotate: true,
            touchPitch: true,
            touchZoomRotate: true,
            dragPan: true,
            scrollZoom: true,
            keyboard: true,
            // Avoid MapLibre's default bottom-right attribution placement; the
            // compact source-credit control is added explicitly at bottom-left.
            attributionControl: false,
            maxTileCacheSize: safeMode ? Math.min(32, profile.maxTileCacheSize) : profile.maxTileCacheSize,
            fadeDuration: (cfg.perf && cfg.perf.fadeDuration) || 120,
            canvasContextAttributes: attrs,
            hash: false,
            cooperativeGestures: false
        };
        /* Only set the ones we have a value for: MapLibre has its own defaults
         * (devicePixelRatio and a 4096² ceiling) and `undefined` would override
         * them with nothing. */
        if (pixelRatio) options.pixelRatio = pixelRatio;
        if (maxCanvasSize) options.maxCanvasSize = maxCanvasSize;
        return options;
    }

    /**
     * The entry gate.
     *
     * A LiDAR layer cannot be draped the way the rest of the deck is: a 1 m
     * national hillshade is a pyramid of heavy tiles, and opening 3D over one
     * produced exactly the report this feature exists for — layers that load
     * slowly, look broken, or never appear at all. js/lidar-3d-focus.js installs
     * this gate, and it is what asks the user for a point and a distance,
     * prefetches that disc, and only then lets the viewer open.
     *
     * The gate resolves `false` when the user cancels (3D then simply does not
     * open), and the promise is shared: a second tap on the 3D button while the
     * dialog is up cannot start a second dialog or a second download.
     */
    function runEntryGate() {
        if (typeof state.entryGate !== 'function') return null;
        if (state.gateRunning) return state.gateRunning;
        var gate = state.entryGate;
        state.gateRunning = Promise.resolve()
            .then(function () { return gate(); })
            .then(function (allowed) {
                state.gateRunning = null;
                if (!allowed || state.open) return !!state.open;
                return openNow();
            }, function (error) {
                state.gateRunning = null;
                pushError('the LiDAR focus could not be prepared: ' + ((error && error.message) || error));
                console.warn('[Map3D] entry gate failed:', error);
                return fail3D(error);
            });
        return state.gateRunning;
    }

    function setEntryGate(gate) {
        state.entryGate = typeof gate === 'function' ? gate : null;
        return true;
    }

    function open() {
        if (state.open) return Promise.resolve(true);
        if (typeof state.entryGate === 'function') return runEntryGate();
        return openNow();
    }

    function openNow() {
        if (state.open) return Promise.resolve(true);
        if (!wrapper()) {
            console.warn('[Map3D] #detectlab-map is not in the DOM yet');
            return Promise.resolve(false);
        }
        if (state.failed || map) close();
        var generation = ++openGeneration;
        ensureSurface();
        var controlBar = ensureBar();
        if (controlBar && typeof controlBar.syncBasemap === 'function') controlBar.syncBasemap();
        ensureToggle();
        document.body.classList.add('is-3d');
        state.open = true;
        state.failed = false;
        refreshToggle();
        /* The refresh action joins the group in 3D, so the group's own box —
         * and with it --m3d-stack-top, which the 3D bar rides on — is
         * remeasured once the class has landed. */
        queueAnchorSync();
        showVeil('busy', t('loading'), t('loadingDetail'), null);

        /* Before spending 1 MB on the SDK: can this browser do WebGL at all?
         * A device that cannot gets an explanation instead of a flash of dark
         * canvas and a silent return to 2D. */
        var probe = webglProbe(true);
        if (!probe.webgl2 && !probe.webgl) {
            return Promise.resolve(reportNoWebgl(probe));
        }

        return loadMapLibre().then(function (maplibre) {
            if (!state.open || generation !== openGeneration) return false;
            registerProtocols(maplibre);
            var cfg = REGISTRY.config();
            var cam = focusCamera(cameraFrom2D());
            var profile = deviceProfile();

            /* One attempt at full quality, one at the minimum a phone will
             * grant. MapLibre throws SYNCHRONOUSLY from the constructor when
             * getContext('webgl2') returns null, so this is a plain try/catch
             * around `new` — no promise, no event, no error dialog by itself. */
            try {
                map = new maplibre.Map(buildMapOptions(cam, profile, false));
            } catch (firstError) {
                pushError('first GL context refused: ' + String((firstError && firstError.message) || firstError));
                state.safeMode = true;
                state.probe = null;          /* the memoised verdict is now stale */
                console.warn('[Map3D] WebGL context refused — retrying in safe mode');
                /* Throws again → falls through to the .catch below, which now
                 * has a real message to show the user. */
                map = new maplibre.Map(buildMapOptions(cam, profile, true));
            }
            if (!state.open) {                    /* closed while the SDK was loading */
                try { map.remove(); } catch (e) { /* ignore */ }
                map = null;
                return false;
            }
            /* The camera is moved by gestures only (see MAP3D_GESTURE_CAMERA.md):
             * make sure every rotation/pitch handler is on, whatever the style,
             * the safe-mode retry or a device profile did to it. */
            try { map.touchZoomRotate.enableRotation(); } catch (e) { /* no touch handler */ }
            try { if (map.touchPitch) map.touchPitch.enable(); } catch (e) { /* no touch pitch */ }
            try { if (map.dragRotate) map.dragRotate.enable(); } catch (e) { /* no drag rotate */ }
            try { if (map.dragPan) map.dragPan.enable(); } catch (e) { /* no drag pan */ }
            try { if (map.scrollZoom) map.scrollZoom.enable(); } catch (e) { /* no wheel zoom */ }
            try { if (map.keyboard) map.keyboard.enable(); } catch (e) { /* no keyboard */ }
            // The app's controls and map gestures make MapLibre's +/- and
            // compass redundant. Keep source credits available from a compact
            // info control rather than as a permanent text panel. MapLibre
            // expands compact credits when the first source is discovered, so
            // collapse that initial state once the attribution text is ready.
            if (maplibre.AttributionControl) {
                map.addControl(new maplibre.AttributionControl({ compact: true }), 'bottom-left');

                var collapseInitialAttribution = function () {
                    var control = surface && surface.querySelector
                        ? surface.querySelector('.maplibregl-ctrl-attrib')
                        : null;
                    var content = control && control.querySelector
                        ? control.querySelector('.maplibregl-ctrl-attrib-inner')
                        : null;
                    if (!control || !content || !String(content.textContent || '').trim()) return;

                    control.classList.remove('maplibregl-compact-show');
                    control.removeAttribute('open');
                    if (typeof map.off === 'function') {
                        map.off('styledata', collapseInitialAttribution);
                        map.off('sourcedata', collapseInitialAttribution);
                        map.off('terrain', collapseInitialAttribution);
                    }
                };

                // Wait for the source metadata if the control was added before
                // MapLibre had any attributions to render.
                if (typeof map.on === 'function') {
                    map.on('styledata', collapseInitialAttribution);
                    map.on('sourcedata', collapseInitialAttribution);
                    map.on('terrain', collapseInitialAttribution);
                }
                collapseInitialAttribution();
            }
            /* No MapLibre TerrainControl here. It was the only widget in the
             * top-right corner (the web layout reserved that row for it, phones
             * hid it), and its single button — the one titled “Disable
             * terrain” — switched off the very thing the 3D view exists for.
             * The deck is draped over the DEM by the style itself
             * (`style.terrain` in buildStyle, with the fixed exaggeration), and
             * a DEM that cannot load already falls back to the flat view with a
             * console warning. Nothing to toggle. */
            if (maplibre.ScaleControl) {
                map.addControl(new maplibre.ScaleControl({ maxWidth: 80, unit: 'metric' }), 'bottom-left');
            }
            /* The base-layer button stays on screen in 3D and rides above those
             * two bottom-left widgets (see syncBasemapLift): now that the corner
             * exists, measure it and follow it. queueAnchorSync runs the
             * measurement on the next frame, once the controls are laid out. */
            queueAnchorSync();
            /* The pixel ratio is already IN the constructor above; this only
             * covers an SDK that ignores the option, and only when the ratio
             * actually differs — an unconditional setPixelRatio() forces a
             * full resize on every open. */
            if (profile.pixelRatio && typeof map.setPixelRatio === 'function' &&
                typeof map.getPixelRatio === 'function' && map.getPixelRatio() !== profile.pixelRatio) {
                try { map.setPixelRatio(profile.pixelRatio); } catch (e) { /* ignore */ }
            }

            /* iOS drops the GL context when the app is backgrounded or memory
             * runs short; MapLibre then renders a black canvas with no visible
             * reason. Say so, and redraw as soon as it comes back. */
            watchContextLoss();
            /* Requests killed while the app was in the background are never
             * re-asked on their own; a resume redraws the deck. */
            watchResume();

            /* The deck is not gated on a single event: 'load' waits for the DEM,
             * so a slow/unreachable elevation model would hide every layer.
             * styledata fires as soon as the style is up, `loaded()` polling
             * covers the rest. */
            function firstSync() {
                if (!state.open || generation !== openGeneration) return;
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
            map.on('idle', function () { if (generation === openGeneration) hideVeil(); });
            map.on('moveend', function () {
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
            state.healthTimers.push(root.setTimeout(function () { if (state.open && map && !state.firstSyncDone) firstSync(); }, 2500));
            document.addEventListener('detectlab:langchange', refreshBarCopy);
            return true;
        }).catch(function (error) {
            if (generation !== openGeneration) return false;
            return fail3D(error);
        });
    }

    /**
     * A failure the user has to be able to SEE.
     *
     * `body.is-3d` is deliberately NOT removed here. That class is what makes
     * #map3d-surface display at all (`display:none` without it), and the veil
     * holding this message lives inside the surface — so dropping the class
     * hid the explanation along with the map. That is the whole of the mobile
     * bug as it presented: tap 3D, dark rectangle flashes, straight back to
     * 2D, no reason given anywhere.
     *
     * The surface now stays up with the message and two ways out (retry /
     * back to 2D). state.open goes false so the 2D⇄3D pill reads “3D” again
     * and one more tap retries; close() is what finally removes the class.
     */
    function fail3D(error) {
        var message = String((error && error.message) || error || 'unknown error');
        state.lastError = message;
        pushError(message);
        console.error('[Map3D] ' + message);
        state.failed = true;
        state.open = false;
        showVeil('error', t('failed'), t('failedDetail') + ' (' + message + ')', t('retry'), t('back'));
        refreshToggle();
        return false;
    }

    /** No WebGL at all — the SDK is never even downloaded. */
    function reportNoWebgl(probe) {
        var detail = t('noWebglDetail') + (probe.error ? ' (' + probe.error + ')' : '');
        state.lastError = probe.error || 'no WebGL';
        state.failed = true;
        /* Same contract as fail3D: the viewer reads as CLOSED, so the next
         * tap on the 3D button retries. Leaving state.open set here made
         * every later open() answer “already open” and do nothing at all —
         * no dialog, no veil, no map. */
        state.open = false;
        showVeil('error', t('noWebgl'), detail, t('retry'), t('back'));
        return false;
    }

    /* iOS/Android reclaim the GPU context on backgrounding or memory pressure.
     * MapLibre's own handling keeps the map object alive but paints nothing,
     * so the veil is the only honest signal there is. */
    function watchContextLoss() {
        var canvas = null;
        try { canvas = map && map.getCanvas ? map.getCanvas() : null; } catch (e) { canvas = null; }
        if (!canvas || !canvas.addEventListener) return;
        canvas.addEventListener('webglcontextlost', function (event) {
            try { if (event && event.preventDefault) event.preventDefault(); } catch (e) { /* ignore */ }
            state.contextLost = true;
            pushError('WebGL context lost');
            showVeil('error', t('contextLost'), t('contextLostDetail'), t('retry'), t('back'));
        }, false);
        canvas.addEventListener('webglcontextrestored', function () {
            state.contextLost = false;
            hideVeil();
            state.firstSyncDone = false;
            scheduleSync();
        }, false);
    }

    /**
     * Coming back from the background (the installed PWA, mostly).
     *
     * A backgrounded phone kills the tile requests that were in flight; the
     * canvas, the style and `state.rendered` all survive, so nothing ever asks
     * for those tiles again — the deck keeps what had arrived, which is
     * frequently the base map alone while the LiDAR source is still “open”.
     * A resume is also the only moment a resize is due: iOS reports the new
     * viewport a tick after `visibilitychange`, and MapLibre keeps rendering at
     * the old one until it is told.
     *
     * Guarded and idempotent: the listeners are added once, and a resume while
     * the view is closed is a no-op.
     */
    function watchResume() {
        if (state.resumeWatched) return;
        var doc = root.document;
        if (!doc || !doc.addEventListener) return;
        state.resumeWatched = true;
        function resume() {
            if (!state.open || !map) return;
            if (doc.hidden) return;
            try { map.resize(); } catch (e) { /* ignore */ }
            scheduleSync();
        }
        doc.addEventListener('visibilitychange', resume);
        root.addEventListener('pageshow', resume);
    }

    function close() {
        ++openGeneration;
        if (!state.open && !map && !state.failed) return false;
        state.open = false;
        state.firstSyncDone = false;
        state.failed = false;
        state.safeMode = false;
        state.contextLost = false;
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
        state.sourceData = {};
        state.sourceTiles = {};
        state.blendCache = {};
        state.blendWarned = false;
        state.cappedSeen = {};
        popup = null;
        hideVeil();
        document.body.classList.remove('is-3d');
        refreshToggle();
        /* Back in 2D: the refresh action leaves the group and the Leaflet
         * corner is visible again, so the anchor is remeasured. */
        queueAnchorSync();
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
            runSync('scheduled');
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
            /* A desktop choice must invalidate the deck even if the hidden
             * Leaflet snapshot has not changed (or the same sheet is picked). */
            if (!isMobile() && typeof root.getArcgisBasemap === 'function') {
                signature += '|basemap:' + root.getArcgisBasemap();
            }
            if (signature !== state.signature) {
                /* Commit the signature only after a pass that really ran: a
                 * failed pass must stay “pending” so the next tick retries,
                 * instead of freezing the deck on the old plan forever. */
                if (runSync('poll')) state.signature = signature;
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
    /* ═══════════════════════════════════════════════════════════════════════
     *  TERRAIN EXAGGERATION
     * -----------------------------------------------------------------------
     *  Every map.setTerrain() builds a NEW Terrain object and a NEW
     *  RenderToTexture (MapLibre 5: `this.terrain = new Terrain(...);
     *  this.painter.renderToTexture = new RenderToTexture(...)`) and frees
     *  neither of the previous pair. A slider drag fires `input` once per
     *  pixel, so dragging it allocated a render target per pixel and ran the
     *  device out of GPU memory — on a phone that kills the tab, reported as
     *  “modifying the terrain exaggeration crashes the app”.
     *
     *  So the value is applied once per frame at most, never re-applied when
     *  it has not moved, and never asked for on a style that has no DEM source
     *  (a mobile profile with no terrain tiles has none, and setTerrain then
     *  throws “cannot load terrain, because there exists no source with ID”).
     * ═══════════════════════════════════════════════════════════════════════ */
    var exagApply = null;

    function applyExaggeration() {
        exagApply = null;
        if (!map) return;
        var ts = terrainSource();
        if (!ts || !ts.id) return;
        var present = false;
        try {
            present = typeof map.getSource === 'function' ? !!map.getSource(ts.id) : false;
        } catch (e) { present = false; }
        if (!present) return;                     /* no DEM in this style: nothing to exaggerate */
        try { map.setTerrain({ source: ts.id, exaggeration: state.exaggeration }); } catch (e) { /* style not loaded yet */ }
    }

    function scheduleExaggeration() {
        if (exagApply) return;                    /* a frame is already booked */
        var run = function () { applyExaggeration(); };
        if (typeof root.requestAnimationFrame === 'function') {
            exagApply = root.requestAnimationFrame(function () { exagApply = null; run(); });
        } else {
            exagApply = setTimeout(function () { exagApply = null; run(); }, 60);
        }
    }

    function setExaggeration(value) {
        var min = CONFIG.terrain.minExaggeration || 0.5;
        var max = CONFIG.terrain.maxExaggeration || 4;
        var v = Math.max(min, Math.min(max, Number(value) || min));
        var same = state.exaggeration === v;
        state.exaggeration = v;
        if (same) return v;                       /* nothing changed: no setTerrain */
        scheduleExaggeration();
        return v;
    }

    function status() {
        return {
            open: state.open,
            exaggeration: state.exaggeration,
            /* Mobile diagnostics — what the device was asked for and whether
             * it had to fall back. Surfaced by /api/map3d/status and quoted by
             * the support report. */
            mobile: isMobile(),
            deviceProfile: deviceProfile(),
            safeMode: !!state.safeMode,
            failed: !!state.failed,
            contextLost: !!state.contextLost,
            lastError: state.lastError || '',
            webgl: webglProbe(),
            camera: map ? {
                center: [map.getCenter().lng, map.getCenter().lat],
                zoom: map.getZoom(),
                bearing: map.getBearing(),
                pitch: map.getPitch()
            } : null,
            terrain: terrainSource(),
            engine: state.engine,
            hillshade: REGISTRY.config().hillshade,
            proxyHosts: Object.keys(state.proxyHosts),
            directHosts: Object.keys(state.directHosts),
            deckOrder: state.deckOrder || [],
            mirrored: state.mirror.items.map(function (item) {
                return { id: 'm3d-2d-' + item.key, kind: item.kind, z: item.z, opacity: item.opacity,
                    label: item.label, blend: item.blend || null, features: item.count || null, live: !!item.layer };
            }),
            /* Blended (CSS-emulated) tiles repainted this session — a support
             * report should show the LiDAR hillshades actually being served. */
            retintedTiles: state.retintedTiles,
            /* The LiDAR focus: which single layer may be draped, over which
             * disc, how many tiles of it are already in memory, and what the
             * one-layer rule had to leave out. */
            lidar: {
                focus: state.focus ? {
                    key: state.focus.key || null,
                    lidarKey: state.focus.lidarKey || null,
                    defId: state.focus.defId || null,
                    label: state.focus.label || '',
                    /* 'disc' (1 km prepared area) or 'full' (the layer loads
                     * entirely, every zoom, no prepared area). */
                    scope: focusScope() || null,
                    layers: focusLayers().map(function (layer) {
                        return {
                            key: layer.key || null,
                            lidarKey: layer.lidarKey || null,
                            defId: layer.defId || null,
                            label: layer.label || '',
                            zoomTo: layer.plan && layer.plan.zoomTo != null ? layer.plan.zoomTo : null
                        };
                    }),
                    lat: state.focus.mask ? state.focus.mask.lat : state.focus.lat,
                    lng: state.focus.mask ? state.focus.mask.lng : state.focus.lng,
                    radiusKm: state.focus.mask ? state.focus.mask.radiusKm : state.focus.radiusKm,
                    bounds: state.focus.bounds || null,
                    at: state.focus.at || null
                } : null,
                off: !!state.lidarOff,
                drawn: state.status && Object.keys(state.status).reduce(function (list, id) {
                    var entry = state.status[id];
                    if (entry && entry.focused) {
                        list.push({ id: id, label: entry.label || id, key: entry.lidarKey || null });
                    }
                    return list;
                }, []),
                notes: (state.lidarNotes || []).slice(),
                primed: {
                    entries: state.primedOrder.length,
                    bytes: state.primedBytes,
                    hits: state.primedHits,
                    budget: primeBudget()
                }
            },
            capped: state.mirror.capped || [],
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
        getEngine: function () { return state.engine; },
        syncLayers: syncLayers,
        refreshTiles: refreshTiles,
        setExaggeration: setExaggeration,
        getExaggeration: function () { return state.exaggeration; },
        setPitch: function (v) { if (map) map.setPitch(Number(v) || 0); },
        setBearing: function (v) { if (map) map.setBearing(Number(v) || 0); },
        resetView: function () { resetView(true); },
        status: status,
        report: report,
        registry: REGISTRY,
        mirror: MIRROR,
        /* kept for the automated tests: build the style / options without a GPU */
        _buildStyle: function () { return buildStyle(root.maplibregl || {}); },
        _mapOptions: function (safeMode) {
            return buildMapOptions(cameraFrom2D(), deviceProfile(), !!safeMode);
        },
        _webglProbe: webglProbe,
        _deviceProfile: deviceProfile,
        getLastError: function () { return state.lastError || ''; },
        _deckOrder: computeDeckOrder,
        _mirror: function () { collectMirror(); return state.mirror; },
        _planTileRefresh: planTileRefresh,
        _fetchTile: fetchTile,
        /* CSS-blend emulation (see blendedTile) and the upload cache: exposed so
         * the suite can prove a blended tile is really repainted, and cached,
         * without a GPU. */
        _blendedTile: blendedTile,
        _setSourceData: setSourceData,
        _setSourceTiles: setSourceTiles,
        /* ── the LiDAR focus (js/lidar-3d-focus.js drives all of this) ────
         * setEntryGate() installs the “ask first” hook that open() consults;
         * prefetchTiles() downloads + finishes a prepared disc; setLidarFocus()
         * is the decision itself, and applies to a running 3D view live. */
        setEntryGate: setEntryGate,
        hasEntryGate: function () { return typeof state.entryGate === 'function'; },
        openWithoutGate: openNow,
        prefetchTiles: prefetchTiles,
        setLidarFocus: setLidarFocus,
        clearLidarFocus: clearLidarFocus,
        getLidarFocus: currentFocus,
        focusFitZoom: function () { return focusFitZoom(state.focus); },
        clearPrimed: clearPrimed,
        primedBytes: function () { return state.primedBytes; },
        /* “Is this tile already prepared for this layer?” — the focus dialog
         * asks before it promises a download. */
        isPrepared: function (url, layerKey) {
            if (!url || !state.primedOut[url]) return false;
            if (layerKey && state.primedLayer[url] && state.primedLayer[url] !== layerKey) return false;
            return true;
        },
        /* The bytes this tile will actually be draped as, or null. “Prepared”
         * alone is not an answer: a tile can be in the cache as the transparent
         * 1×1 placeholder the disc clip writes for a tile outside the disc, and
         * a dialog that counted those as ready used to promise a download it
         * could not deliver. */
        preparedTile: function (url, layerKey) {
            if (!url || !state.primedOut[url]) return null;
            if (layerKey && state.primedLayer[url] && state.primedLayer[url] !== layerKey) return null;
            return state.primedOut[url].data || null;
        },
        _focusSig: function (key) { return focusSigFor(key); },
        _focusLayers: focusLayers,
        _focusScope: focusScope,
        _planForLayer: planForLayer,
        /**
         * Are any of the focus's layers still switched on on the 2D map?
         *
         * js/map-app.js consults this when a LiDAR layer is toggled, so that
         * turning off ONE of the layers a 3D view was prepared for does not
         * throw the whole decision away — the 3D view simply stops drawing
         * that one. A focus whose every layer is gone is stale and cleared.
         */
        lidarFocusCovers: function (entries) {
            if (!state.focus) return false;
            var list = entries || [];
            if (!list.length) return false;
            return focusLayers().some(function (layer) {
                return list.some(function (ent) {
                    if (!ent) return false;
                    if (layer.key && (ent.key === layer.key || ent.lidarKey === layer.key)) return true;
                    if (layer.lidarKey && (ent.lidarKey === layer.lidarKey || ent.key === layer.lidarKey)) return true;
                    if (layer.defId && (ent.defId === layer.defId || ent.lidarKey === 'def:' + layer.defId)) return true;
                    if (layer.lidarKey && ent.defId && layer.lidarKey === 'def:' + ent.defId) return true;
                    return false;
                });
            });
        },
        /* The dl2d:// / dl3d:// protocol handlers, registered without a map:
         * the suite drives them exactly as MapLibre would, so “prepared in
         * the dialog” and “served in 3D” cannot drift apart unnoticed. */
        _registerProtocols: registerProtocols,
        _pipelineSig: function (key, url) { return pipelineSigFor(key, url); },
        _clipFocusedTile: clipFocusedTile,
        _focusExcludesTile: focusExcludesTile,
        _lidarFilter: lidarFilter,
        _focusCamera: focusCamera,
        /* The switch's measured slot in the bottom-left control column, right
         * above the base-layer button. Exposed so the layout tests can drive
         * the same arithmetic the browser does, and so a support session can
         * read what was actually measured instead of guessing from the
         * stylesheet's fallbacks. */
        _syncToggleAnchor: syncToggleAnchor,
        /* The base-layer button's measured lift over MapLibre's bottom-left
         * widgets while 3D is on (--m3d-basemap-lift). Exposed for the same
         * reason as the anchor above: a support session can read what the
         * browser actually measured. */
        _syncBasemapLift: syncBasemapLift,
        _basemapLift: function () {
            var host = wrapper();
            if (!host || !host.style || typeof host.style.getPropertyValue !== 'function') return null;
            var value = host.style.getPropertyValue('--m3d-basemap-lift');
            return value ? parseFloat(value) : null;
        },
        _toggleAnchor: function () {
            var host = wrapper();
            if (!host || !host.style || typeof host.style.getPropertyValue !== 'function') return null;
            var read = function (name) {
                var value = host.style.getPropertyValue(name);
                return value ? parseFloat(value) : null;
            };
            return {
                bottom: read('--m3d-anchor-bottom'),
                left: read('--m3d-anchor-left'),
                stackTop: read('--m3d-stack-top'),
                gap: ANCHOR_GAP
            };
        }
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
