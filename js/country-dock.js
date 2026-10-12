/* ══════════════════════════════════════════════════════════════
   DetectLab — Country dock (search-bar country switcher)
   ──────────────────────────────────────────────────────────────
   The controls that live under the map search bar once a country
   has been picked from the globe gate:

     • a slide-down button glued to the search bar that shows the
       selected country's 2-letter code and drops open a list of
       every country initial — hovering (or focusing) a code prints
       the full country name, clicking it moves the locked map view
       to that country;
     • a small “World hillshade” checkbox that lays the Esri World
       Hillshade tiles (30 m terrain shading) over the permanent 3D
       globe base (and any historical imagery overlay) — a selection
       never switches the globe, it only overlays the relief;
     • the “Exit view” button, which appears in the middle of the
       lower edge once the locked country view is zoomed all the way
       out. Exiting releases the lock, pulls back to the European
       overview and reopens the globe so another country can be
       chosen — leaving a country view always means picking one.

   The locked view itself (maxBounds + zoom floor, persistence,
   hand-off to Leaflet) lives in js/globe-country-picker.js; this
   module is only the UI around it and talks to the globe exclusively
   through window.DetectLabGlobeGate.{listCountries,selectCountry,
   isLocked,exitView,unlock,prefetch}. See COUNTRY_SELECTION_DOCK.md.
   ══════════════════════════════════════════════════════════════ */
(function (window, document) {
    'use strict';
    if (!window || !document) return;

    /* ── Configuration ── */
    // Esri World Hillshade — the same terrain shading the ArcGIS reference
    // uses, served as plain Web-Mercator tiles.
    var HS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
    var HS_ATTRIBUTION = 'World Hillshade &copy; Esri, USGS, NOAA';
    var HS_PANE = 'pane_world_hillshade';
    // Same z-index as the basemap panes (satellite / historical mosaics). The
    // pane is created at runtime, so it is the last child at that level and
    // therefore paints directly above the basemap and below every data pane
    // (OSM places 401, UAT 402, LIDAR 610, historical maps 640+…).
    var HS_PANE_Z = '400';
    var HS_OPACITY = 0.5;
    // The dataset is a single fused layer; asking for deeper levels returns
    // empty placeholders, so Leaflet overzooms the level-16 tiles instead.
    var HS_MAX_NATIVE_ZOOM = 16;
    var HS_STORAGE_KEY = 'detectlab_world_hillshade_v1';

    // How close to the zoom floor counts as “zoomed out at maximum”.
    var EXIT_ZOOM_TOLERANCE = 0.05;

    /* The zoom floor as the user can actually reach it: Leaflet snaps the zoom
       to whole levels (zoomSnap, default 1), so a floor of 5.65 is really 6 —
       comparing against the raw minZoom would never show the Exit view pill. */
    function reachableFloor(map) {
        var min = null, snap = 0;
        try {
            min = (typeof map.getMinZoom === 'function') ? map.getMinZoom() : null;
            snap = (map.options && typeof map.options.zoomSnap === 'number') ? map.options.zoomSnap : 0;
        } catch (e) { return null; }
        if (typeof min !== 'number') return null;
        if (snap > 0) min = Math.ceil(min / snap) * snap;
        return min;
    }

    /* ── Small helpers ── */
    function gate() { return window.DetectLabGlobeGate || null; }

    function activeMap() { return state.map || window._dlMap || null; }

    function closest(el, cls) {
        while (el) {
            if (el.classList && el.classList.contains(cls)) return el;
            el = el.parentNode || null;
        }
        return null;
    }

    function safeGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
    function safeSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) {} }

    function currentIso() { return String(window._detectlabSelectedCountry || '').toUpperCase(); }

    /* ── Module state ── */
    var state = {
        map: null,
        attached: false,
        open: false,
        busy: false,
        buttons: {},          // iso → the grid button, so no querySelectorAll is needed
        hillshadeLayer: null,
        hillshadeOn: false,
        boundMap: null,       // the Leaflet instance carrying our zoom listener
        boundContainer: null, // the map container carrying the wheel fallback
        lastZoom: null,
        userZoomedOut: false, // a real zoom-out happened since the country was locked
        fallbackList: null
    };

    var els = {};
    function cacheEls() {
        els.dock = document.getElementById('countryDock');
        els.btn = document.getElementById('countryDockBtn');
        els.code = document.getElementById('countryDockCode');
        els.panel = document.getElementById('countryDockPanel');
        els.grid = document.getElementById('countryDockGrid');
        els.name = document.getElementById('countryDockName');
        els.close = document.getElementById('countryDockClose');
        els.hs = document.getElementById('countryDockHillshade');
        els.hsInfo = document.getElementById('countryDockHsInfo');
        els.exit = document.getElementById('countryExitViewBtn');
    }

    /* ══════════════════════════════════════════════════════════
       Country list (initials grid)
       ══════════════════════════════════════════════════════════ */
    function countries() {
        var g = gate();
        if (g && typeof g.listCountries === 'function') {
            try {
                var list = g.listCountries();
                if (list && list.length) { state.fallbackList = null; return list; }
            } catch (e) { /* fall through to the cached list */ }
        }
        return state.fallbackList || [];
    }

    // Remembers the last list the gate produced, so a transient hiccup while
    // rebuilding the grid (e.g. right after a language switch) leaves the
    // initials on screen instead of emptying the panel.
    function rememberFallback(list) {
        if (!list || !list.length) return;
        state.fallbackList = list;
    }

    function buildGrid() {
        if (!els.grid) return;
        var list = countries();
        rememberFallback(list);
        var cur = currentIso();
        state.buttons = {};
        els.grid.innerHTML = '';
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'country-dock-cell' + (c.iso === cur ? ' is-current' : '');
            b.setAttribute('data-iso', c.iso);
            b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', c.iso === cur ? 'true' : 'false');
            b.setAttribute('aria-label', c.name || c.iso);
            b.setAttribute('title', c.name || c.iso);   // native tooltip on hover
            b.textContent = c.code || c.iso;
            els.grid.appendChild(b);
            state.buttons[c.iso] = b;
        }
    }

    // Full name of the hovered/focused code — the “on hover show the full
    // name” behaviour, mirrored into the panel footer so touch users and
    // screen readers get it too.
    function showName(iso) {
        var g = gate();
        var name = '';
        if (g && typeof g.nameOf === 'function') {
            try { name = g.nameOf(iso) || ''; } catch (e) { name = ''; }
        }
        if (!name) {
            var list = countries();
            for (var i = 0; i < list.length; i++) {
                if (list[i].iso === iso) { name = list[i].name; break; }
            }
        }
        if (els.name) {
            els.name.textContent = name || '';
            if (els.name.classList) els.name.classList.toggle('show', !!name);
        }
        return name;
    }

    function sync() {
        var iso = currentIso();
        if (els.code) els.code.textContent = iso || '—';
        if (els.btn) els.btn.setAttribute('data-iso', iso || '');
        for (var key in state.buttons) {
            if (!Object.prototype.hasOwnProperty.call(state.buttons, key)) continue;
            var b = state.buttons[key];
            var on = key === iso;
            if (b.classList) b.classList.toggle('is-current', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        }
    }

    /* ══════════════════════════════════════════════════════════
       Panel (slide-down list)
       ══════════════════════════════════════════════════════════ */
    function setOpen(open) {
        state.open = !!open;
        if (els.dock && els.dock.classList) els.dock.classList.toggle('is-open', state.open);
        if (els.panel) {
            if (state.open) els.panel.removeAttribute('hidden');
            else els.panel.setAttribute('hidden', 'hidden');
        }
        if (els.btn) els.btn.setAttribute('aria-expanded', state.open ? 'true' : 'false');
        if (state.open) { buildGrid(); sync(); showName(currentIso()); }
    }

    function pick(iso) {
        iso = String(iso || '').toUpperCase();
        if (!iso) return;
        var g = gate();
        if (!g || typeof g.selectCountry !== 'function') return;
        if (state.busy) return;
        state.busy = true;
        if (els.dock && els.dock.classList) els.dock.classList.add('is-busy');
        var done = function (err) {
            state.busy = false;
            if (els.dock && els.dock.classList) els.dock.classList.remove('is-busy');
            if (err) console.warn('[DetectLab] Country dock: could not switch country', err && err.message);
            setOpen(false);
            sync();
            evaluateExitButton();
        };
        var p;
        try { p = g.selectCountry(iso); } catch (e) { p = null; }
        if (p && typeof p.then === 'function') p.then(function () { done(null); }, done);
        else done(null);
    }

    /* ══════════════════════════════════════════════════════════
       World hillshade overlay (never touches the basemap itself)
       ══════════════════════════════════════════════════════════ */
    function ensureHillshadeLayer() {
        if (state.hillshadeLayer) return state.hillshadeLayer;
        if (!window.L || typeof window.L.tileLayer !== 'function') return null;
        var map = activeMap();
        if (!map) return null;
        try {
            if (typeof map.getPane === 'function' && !map.getPane(HS_PANE) && typeof map.createPane === 'function') {
                map.createPane(HS_PANE);
            }
            var pane = (typeof map.getPane === 'function') ? map.getPane(HS_PANE) : null;
            if (pane && pane.style) pane.style.zIndex = HS_PANE_Z;
            state.hillshadeLayer = window.L.tileLayer(HS_URL, {
                pane: HS_PANE,
                opacity: HS_OPACITY,
                minZoom: 1,
                maxZoom: 20,
                maxNativeZoom: HS_MAX_NATIVE_ZOOM,
                attribution: HS_ATTRIBUTION,
                crossOrigin: false,
                className: 'country-dock-hillshade-tiles'
            });
        } catch (e) {
            console.warn('[DetectLab] Country dock: world hillshade layer unavailable', e);
            return null;
        }
        // On the 3D globe the hillshade is a globe twin like the other raster
        // overlays (js/globe-base-layer.js). A layer that does not convert exactly
        // keeps Leaflet's own tiles, so this changes nothing when there is no globe.
        var globeBase = window.DetectLabGlobeBase;
        if (globeBase && typeof globeBase.attachTileTwin === 'function') {
            try { globeBase.attachTileTwin(state.hillshadeLayer); } catch (e) { /* Leaflet tiles stay */ }
        }
        return state.hillshadeLayer;
    }

    function setHillshade(on, opts) {
        var map = activeMap();
        var layer = on ? ensureHillshadeLayer() : state.hillshadeLayer;
        state.hillshadeOn = !!on;
        if (layer && map) {
            try {
                if (on && !map.hasLayer(layer)) layer.addTo(map);
                else if (!on && map.hasLayer(layer)) map.removeLayer(layer);
            } catch (e) {
                console.warn('[DetectLab] Country dock: could not toggle world hillshade', e);
            }
        }
        if (els.hs) els.hs.checked = !!on;
        if (!opts || opts.persist !== false) safeSet(HS_STORAGE_KEY, on ? '1' : '0');
        return !!(on && layer);
    }

    function readHillshadeFlag() { return safeGet(HS_STORAGE_KEY) === '1'; }

    // The app hides Leaflet's own attribution control, so every live layer
    // credits its source through showLayerInfo() (same as the satellite tab).
    function showHillshadeInfo() {
        if (typeof window.showLayerInfo !== 'function') return;
        var lang = (typeof window._currentLang === 'function') ? window._currentLang() : 'ro';
        var description = (lang === 'en')
            ? 'Esri World Hillshade (30 m) is drawn over the permanent 3D globe base and any ' +
              'selected historical imagery, so terrain stays readable without replacing the globe. ' +
              'Toggle it with the small checkbox next to the country button.'
            : 'Esri World Hillshade (30 m) se suprapune peste globul 3D permanent și peste imaginile ' +
              'istorice selectate, pentru a evidenția relieful fără să înlocuiască globul. Se comută ' +
              'din bifa mică de lângă butonul de țară.';
        window.showLayerInfo(
            (lang === 'en') ? 'World Hillshade' : 'Relief umbrit (World Hillshade)',
            HS_ATTRIBUTION + ' — 30 m terrain shading (Esri, USGS, NOAA)',
            description);
    }

    /* ══════════════════════════════════════════════════════════
       “Exit view” — only reachable from the zoomed-all-the-way-out
       locked country view.
       ══════════════════════════════════════════════════════════ */
    function evaluateExitButton() {
        if (!els.exit) return;
        var g = gate();
        var map = activeMap();
        var locked = !!(g && typeof g.isLocked === 'function' && g.isLocked());
        var atFloor = false;
        if (locked && map) {
            try {
                var z = map.getZoom();
                var min = reachableFloor(map);
                if (typeof z === 'number' && typeof min === 'number') atFloor = z <= min + EXIT_ZOOM_TOLERANCE;
            } catch (e) { atFloor = false; }
        }
        var show = !!(locked && atFloor && state.userZoomedOut);
        if (show) els.exit.removeAttribute('hidden');
        else els.exit.setAttribute('hidden', 'hidden');
        if (els.exit.classList) els.exit.classList.toggle('show', show);
    }

    function exitView() {
        var g = gate();
        state.userZoomedOut = false;
        evaluateExitButton();
        if (!g) return;
        if (typeof g.exitView === 'function') { g.exitView(); return; }
        if (typeof g.unlock === 'function') g.unlock();
        if (typeof g.open === 'function') g.open();
    }

    /* ══════════════════════════════════════════════════════════
       Map wiring
       ══════════════════════════════════════════════════════════ */
    function onZoomEnd() {
        var map = activeMap();
        if (!map) return;
        var z = null;
        try { z = map.getZoom(); } catch (e) { z = null; }
        if (typeof z === 'number') {
            if (typeof state.lastZoom === 'number' && z < state.lastZoom - 0.001) state.userZoomedOut = true;
            state.lastZoom = z;
        }
        // The locked view may also be left by a second country pick.
        sync();
        evaluateExitButton();
    }

    /* Countries whose floor already *is* the map's own minimum zoom (Russia…)
       cannot zoom out at all, so the gesture is clamped away and no zoomend
       ever arrives. A wheel asking for a zoom-out is then the “I tried to get
       out” signal the Exit view pill waits for. */
    function onWheelAttempt(e) {
        if (!e || !(e.deltaY > 0)) return;
        state.userZoomedOut = true;
        evaluateExitButton();
    }

    function bindMap(map) {
        if (map && state.boundMap !== map && typeof map.on === 'function') {
            if (state.boundMap && typeof state.boundMap.off === 'function') {
                try { state.boundMap.off('zoomend', onZoomEnd); } catch (e) {}
            }
            state.boundMap = map;
            map.on('zoomend', onZoomEnd);
        }
        let container = null;
        try { container = (map && typeof map.getContainer === 'function') ? map.getContainer() : null; } catch (e) { container = null; }
        if (container && typeof container.addEventListener === 'function' && state.boundContainer !== container) {
            if (state.boundContainer && typeof state.boundContainer.removeEventListener === 'function') {
                try { state.boundContainer.removeEventListener('wheel', onWheelAttempt); } catch (e) {}
            }
            state.boundContainer = container;
            container.addEventListener('wheel', onWheelAttempt, { passive: true });
        }
    }

    /* ══════════════════════════════════════════════════════════
       Search interaction: the dock never fights the autocomplete
       ══════════════════════════════════════════════════════════ */
    function watchSearchResults() {
        var ul = document.getElementById('mapSearchResults');
        if (!ul) return;
        function apply() {
            var open = !!(ul.classList && ul.classList.contains('open'));
            if (els.dock && els.dock.classList) els.dock.classList.toggle('dock-suppressed', open);
            if (open && state.open) setOpen(false);
        }
        apply();
        if (typeof MutationObserver !== 'undefined' && ul.classList) {
            try { new MutationObserver(apply).observe(ul, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
        }
    }

    /* ══════════════════════════════════════════════════════════
       Wiring
       ══════════════════════════════════════════════════════════ */
    function wire() {
        if (els.btn) {
            els.btn.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                setOpen(!state.open);
            });
        }
        if (els.close) {
            els.close.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                setOpen(false);
            });
        }
        if (els.grid) {
            els.grid.addEventListener('click', function (e) {
                var b = closest(e && e.target, 'country-dock-cell');
                if (b) pick(b.getAttribute('data-iso'));
            });
            els.grid.addEventListener('mouseover', function (e) {
                var b = closest(e && e.target, 'country-dock-cell');
                if (b) showName(b.getAttribute('data-iso'));
            });
            els.grid.addEventListener('focusin', function (e) {
                var b = closest(e && e.target, 'country-dock-cell');
                if (b) showName(b.getAttribute('data-iso'));
            });
        }
        if (els.hs) {
            els.hs.addEventListener('change', function (e) {
                setHillshade(!!(e && e.target && e.target.checked));
            });
        }
        if (els.hsInfo) {
            els.hsInfo.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                showHillshadeInfo();
            });
        }
        if (els.exit) {
            els.exit.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                exitView();
            });
        }
        document.addEventListener('click', function (e) {
            if (!state.open) return;
            if (els.dock && typeof els.dock.contains === 'function' && e && els.dock.contains(e.target)) return;
            setOpen(false);
        });
        document.addEventListener('keydown', function (e) {
            if (state.open && e && (e.key === 'Escape' || e.keyCode === 27)) setOpen(false);
        });

        // A country picked on the globe: refresh the code chip, forget the
        // previous zoom-out and re-evaluate the exit button for the new lock.
        document.addEventListener('detectlab:country-selected', function () {
            state.userZoomedOut = false;
            state.lastZoom = null;
            setOpen(false);
            buildGrid();
            sync();
            bindMap(activeMap());
            evaluateExitButton();
            // Warm the country geometry in the background so the first switch
            // from the dock needs no wait at all.
            var g = gate();
            if (g && typeof g.prefetch === 'function') { try { g.prefetch(); } catch (e) {} }
        });
        document.addEventListener('detectlab:country-lockchange', function (e) {
            var locked = !!(e && e.detail && e.detail.locked);
            if (locked) { state.userZoomedOut = false; state.lastZoom = null; }
            evaluateExitButton();
        });
        document.addEventListener('detectlab:langchange', function () {
            buildGrid();
            sync();
            if (state.open) showName(currentIso());
        });
    }

    /* ══════════════════════════════════════════════════════════
       Public surface
       ══════════════════════════════════════════════════════════ */
    function attach(map) {
        cacheEls();
        if (!els.dock) return;                    // markup not in this page
        state.map = map || state.map;
        if (state.attached) {
            bindMap(activeMap());
            sync();
            evaluateExitButton();
            return;
        }
        state.attached = true;
        wire();
        watchSearchResults();
        if (readHillshadeFlag()) setHillshade(true, { persist: false });
        bindMap(activeMap());
        buildGrid();
        sync();
        evaluateExitButton();
        // Warm the atlas/geometry in the background so the first country
        // switch from the dock is instant (the local atlas is ~750 KB). Only
        // worth it when a country is already active — visitors who have not
        // chosen one yet are still on the globe gate, which loads it itself.
        if (currentIso()) {
            window.setTimeout(function () {
                var g = gate();
                if (g && typeof g.prefetch === 'function') { try { g.prefetch(); } catch (e) {} }
            }, 1500);
        }
    }

    // Convenience hook in the app's own naming style (window.setSatPeriod,
    // window.toggleSatellite60sMap…): window.toggleWorldHillshade(true/false).
    window.toggleWorldHillshade = setHillshade;

    window.DetectLabCountryDock = {
        attach: attach,
        open: function () { setOpen(true); },
        close: function () { setOpen(false); },
        toggle: function () { setOpen(!state.open); },
        isOpen: function () { return !!state.open; },
        selectCountry: pick,
        toggleHillshade: setHillshade,
        isHillshadeOn: function () { return !!(state.hillshadeLayer && state.hillshadeOn); },
        exitView: exitView,
        refresh: function () { buildGrid(); sync(); evaluateExitButton(); },
        // Internal hooks for the node test-suite (test-country-dock.js).
        _test: {
            state: state,
            els: els,
            cacheEls: cacheEls,
            buildGrid: buildGrid,
            showName: showName,
            sync: sync,
            setOpen: setOpen,
            pick: pick,
            setHillshade: setHillshade,
            ensureHillshadeLayer: ensureHillshadeLayer,
            evaluateExitButton: evaluateExitButton,
            exitView: exitView,
            wire: wire,
            bindMap: bindMap,
            onZoomEnd: onZoomEnd,
            onWheelAttempt: onWheelAttempt,
            reachableFloor: reachableFloor,
            showHillshadeInfo: showHillshadeInfo,
            countries: countries,
            closest: closest,
            HS_URL: HS_URL,
            HS_PANE: HS_PANE,
            HS_PANE_Z: HS_PANE_Z,
            HS_OPACITY: HS_OPACITY,
            HS_STORAGE_KEY: HS_STORAGE_KEY,
            EXIT_ZOOM_TOLERANCE: EXIT_ZOOM_TOLERANCE
        }
    };
})(window, document);
