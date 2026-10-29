/* ============================================================================
   DetectLab — global tile performance governor          js/tile-perf.js
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS
   ----------------------------------------------------------------------------
   Reported bug: with several *dense* raster layers open at the same time
   (the LIDAR sub-layers — HD / AR / AB / BH / CS / "Romania 1m" / "Romania
   2–5m" / CS·DJ·GJ·MH LAKI III — and "Satellite imagery 60's" / CORONA,
   together with the historical maps, the APM layers and the Esri basemap),
   a sudden gesture (an abrupt zoom-in, a fast pinch, a violent drag) made
   the page crash and reload itself.

   That is not a leak: it is the number of live tiles. Each 256×256 RGBA tile
   is ~0.25 MB decoded, and Leaflet's defaults are tuned for ONE tile layer,
   not for the 10–25 this app can stack in the same viewport:

     • updateWhenZooming = true  → every animation frame of a pinch/wheel zoom
       re-runs _update() and queues tiles, for every layer;
     • updateWhenIdle = L.Browser.mobile → with a spoofed UA ("Desktop site"
       mode / some PWAs) it is false, so every pan frame does the same;
     • keepBuffer = 2 → a 2-tile ring of off-screen tiles kept per layer;
     • _pruneTiles() keeps up to 5 ancestor zoom levels + 2 descendant levels
       per layer while the zoom changes;
     • _tileReady() fades every loaded tile in (map option fadeAnimation),
       re-scanning all tiles of the layer on every animation frame.

   A 390×780 phone with ~15 heavy layers on is then holding thousands of
   decoded tiles → WebKit/Chromium kills the tab and the page "refreshes".

   WHAT THIS FILE DOES
   ----------------------------------------------------------------------------
   It installs ONE governor for every tile layer of the app, without changing
   *what* is requested (same URLs, same zoom gates, same footprints — the
   CORONA request format and the LIDAR sources stay byte-identical):

     1. Gesture-safe defaults for every L.TileLayer / L.GridLayer:
        updateWhenZooming = false  (zoom frames are pure CSS transforms),
        updateWhenIdle    = true on low-power devices,
        keepBuffer        = 1 on low-power devices, 2 on desktop,
        updateInterval    = 200–250 ms.
     2. A settle window: tile work requested while a zoom is animating — and
        for a short moment after it ends — is merged into ONE update per layer.
        Zooming through five levels in a second therefore loads the tiles of
        the LAST level, not of all five. Only layers that still have tiles on
        screen are held back: a first paint, a `viewprereset` wipe (non-animated
        zoom, `redraw()`) and every pan are updated at once, so the governor can
        never leave the tile pane empty. The post-zoom quiet window is short
        (~50–80 ms) so the new zoom starts loading almost immediately, while
        still coalescing a rapid wheel burst.
     3. Stricter pruning than Leaflet (2–3 ancestor levels instead of 5) PLUS
        a covering-tile handoff: loaded tiles from the previous zoom stay on
        screen until the incoming ones are `active`, so zoom in/out does not
        flash the map background. A hard ceiling still caps extras once the
        new zoom is painted (and always in conservation mode). The handoff is
        a real cross-fade on every device class: incoming tiles fade in
        through a pure-CSS opacity transition (§4b) instead of Leaflet's own
        fadeAnimation (a requestAnimationFrame loop over ALL tiles of the
        layer for every loaded tile), so zoom in/out reads as one smooth
        image morphing into the next instead of a hard pop — on phones too.
     4. A watchdog (every 5 s) that estimates the decoded-tile memory of the
        whole page; above the device budget it switches to CONSERVATION MODE
        (drops the off-screen rings of every layer, keeps only what is on
        screen) and shows a one-time notice suggesting fewer layers.

   Everything can be tuned live from the console, without a redeploy:

     window.DLTILE_PERF = { quietMs: 300, maxLiveTiles: 250, ... }
     window.DLTILE_LOW_POWER = true            // force the phone profile
     window.DLTilePerf.stats()                 // { tiles, layers, mb, ... }
     window.DLTilePerf.sweep()                 // free the off-screen tiles now

   The Sat60 block in js/map-app.js keeps its own explicit options (they are
   the same values) and uses window.DLTilePerf.isLowPowerDevice() so both
   devices classes agree.
   ============================================================================ */
(function () {
    'use strict';

    if (typeof window === 'undefined' || !window.L || !L.GridLayer || !L.GridLayer.prototype) {
        return;
    }

    /* ── 1. Device class ──────────────────────────────────────────────────── */

    function detectLowPower() {
        if (typeof window.DLTILE_LOW_POWER === 'boolean') return window.DLTILE_LOW_POWER;
        // Kept for backwards compatibility with the Sat60 switch (see
        // SATELLITE_60s_FIX.md §6 — same detection, single source of truth).
        if (typeof window.SAT60_LOW_POWER_TILES === 'boolean') return window.SAT60_LOW_POWER_TILES;
        var low = false;
        try {
            // Leaflet's own UA sniff (true on a normal mobile browser).
            if (L.Browser && L.Browser.mobile) low = true;
            // "Desktop site" mode / PWAs on a phone defeat the UA sniff, but a
            // touch-first device still reports a coarse pointer + touch points.
            var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
            var touch = (navigator.maxTouchPoints || 0) > 0 || ('ontouchstart' in window);
            if (coarse && touch) low = true;
            // Low-memory / low-core devices benefit from the same limits.
            if (typeof navigator.deviceMemory === 'number' &&
                navigator.deviceMemory > 0 && navigator.deviceMemory <= 4) {
                low = true;
            }
            if (typeof navigator.hardwareConcurrency === 'number' &&
                navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2) {
                low = true;
            }
        } catch (err) {
            low = false;
        }
        return low;
    }

    var LOW_POWER = detectLowPower();

    var DEFAULT_CFG = {
        enabled: true,
        lowPower: LOW_POWER,
        // Merge every tile update requested during a zoom animation, and for
        // this long after it ends, into a single update per layer. Short enough
        // that the new zoom starts fetching almost immediately; long enough to
        // coalesce a rapid wheel burst.
        quietMs: LOW_POWER ? 80 : 50,
        // Off-screen ring kept around the viewport (Leaflet default: 2).
        keepBuffer: LOW_POWER ? 1 : 2,
        // null = keep Leaflet's own default for desktop (updateWhenIdle false).
        updateWhenIdle: LOW_POWER ? true : null,
        updateWhenZooming: false,
        updateInterval: LOW_POWER ? 250 : 200,
        // Ancestor / descendant zoom levels kept alive per layer
        // (Leaflet defaults: 5 and 2). Extra parents cover multi-level
        // zooms (z10 scaled over z14) until the children are active.
        retainParentLevels: LOW_POWER ? 2 : 3,
        retainChildLevels: LOW_POWER ? 1 : 2,
        // Hard ceiling for tiles kept OUTSIDE the current viewport, per layer.
        // The effective ceiling is at least one full extra level (see below).
        maxRetainedTiles: LOW_POWER ? 24 : 64,
        // Duration (ms) of the CSS tile fade (§4b): incoming tiles cross-fade
        // over the previous zoom level for this long; the covering tiles are
        // released only once the fade is done.
        fadeMs: 180,
        // Fade incoming tiles with a pure-CSS opacity transition instead of
        // Leaflet's own fadeAnimation. Leaflet's fade runs _updateOpacity() —
        // a requestAnimationFrame loop that rewrites the opacity of EVERY tile
        // of the layer for ~200 ms after EACH tile loads — the worst possible
        // work during a tile burst, which is why phones previously got no
        // fade at all. The CSS transition gives the same smooth zoom handoff
        // on every device with no per-frame JS.
        cssFade: true,
        // Page-wide decoded-tile budget before conservation mode kicks in.
        // 256×256 RGBA ≈ 0.25 MB per tile: 320 ≈ 80 MB, 1400 ≈ 350 MB.
        maxLiveTiles: LOW_POWER ? 320 : 1400,
        // How often the tile watchdog measures the page.
        sweepEveryMs: 5000,
        // Legacy knob, only honoured when cssFade is switched off: keep the
        // map's own fadeAnimation option (the app sets fadeAnimation: true),
        // except on low-power devices, where Leaflet's per-frame fade loop
        // must stay out.
        fadeAnimation: LOW_POWER ? false : null,
        // Show the one-time "too many layers" notice in conservation mode.
        notice: true,
        // Defrost every backdrop-filter for the duration of a map gesture
        // (§7a). Each glass surface snapshots and re-blurs whatever is behind
        // it on EVERY composited frame, and a pinch/wheel zoom animates the
        // whole map — hundreds of heavy tiles — under the whole glass UI at
        // once. That per-frame re-blur is the GPU spike Android reported as
        // "the screen starts glitching" while the Sat60/WMS layers are on.
        // Low-power devices only by default; override with
        // window.DLTILE_PERF = { gestureGlassOff: true|false }.
        gestureGlassOff: LOW_POWER
    };

    var CFG = {};
    (function () {
        for (var k in DEFAULT_CFG) CFG[k] = DEFAULT_CFG[k];
        var over = window.DLTILE_PERF;
        if (over && typeof over === 'object') {
            for (var j in over) if (j in CFG) CFG[j] = over[j];
        }
    })();

    // Applied while the page is over its tile budget (never turns anything
    // off on its own — it only stops keeping tiles nobody is looking at).
    var CONSERVATION = {
        keepBuffer: 0,
        retainParentLevels: 1,
        retainChildLevels: 0,
        maxRetainedTiles: 0
    };

    var STATE = {
        map: null,
        zooming: false,
        zoomStartedAt: 0,
        lastGestureAt: 0,
        // Only a ZOOM opens a settle window: panning keeps Leaflet's own
        // throttling (updateInterval / updateWhenIdle) instead of pausing.
        lastZoomEndAt: 0,
        pending: [],
        timer: null,
        timerAt: 0,
        forceImmediate: false,
        conservation: false,
        noticeShown: false,
        stats: null,
        tick: null,
        // body.map-gesturing is currently applied / the timer that lifts it.
        glassAdded: false,
        glassTimer: null
    };

    function now() {
        return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    }

    function cfgInt(key) {
        if (STATE.conservation && CONSERVATION[key] !== undefined) return CONSERVATION[key];
        return CFG[key];
    }

    function layerOptNumber(layer, key, fallback) {
        var v = layer.options ? layer.options[key] : undefined;
        return (typeof v === 'number' && isFinite(v)) ? v : fallback;
    }

    function layerTiles(layer) {
        var n = 0, k, t = layer._tiles;
        if (!t) return 0;
        for (k in t) n++;
        return n;
    }

    /* ── 2. Defaults for every tile layer of the app ──────────────────────── */

    (function installDefaults() {
        // L.TileLayer.prototype.options inherits from L.GridLayer.prototype.options
        // (created with Object.create), so writing the values here is picked up by
        // every L.tileLayer / L.tileLayer.wms / custom GridLayer instance, while
        // an explicit per-layer option still wins over the default.
        var targets = [];
        if (L.TileLayer && L.TileLayer.prototype && L.TileLayer.prototype.options) {
            targets.push(L.TileLayer.prototype.options);
        }
        if (L.GridLayer.prototype.options) targets.push(L.GridLayer.prototype.options);

        targets.forEach(function (opts) {
            opts.updateWhenZooming = CFG.updateWhenZooming;
            opts.keepBuffer = CFG.keepBuffer;
            opts.updateInterval = CFG.updateInterval;
            if (CFG.updateWhenIdle !== null && CFG.updateWhenIdle !== undefined) {
                opts.updateWhenIdle = !!CFG.updateWhenIdle;
            }
        });
    })();

    /* ── 3. One update per layer per gesture (the settle window) ──────────── */

    // Does the layer still have tiles on screen?
    function hasAnyTiles(layer) {
        var k, t = layer._tiles;
        if (!t) return false;
        for (k in t) return true;
        return false;
    }

    // True while tile work for this layer should be held back and merged with
    // the update that follows the gesture.
    function deferring(layer) {
        if (!CFG.enabled || STATE.forceImmediate) return false;
        if (layer.options && layer.options.dltilePerf === false) return false;
        var map = layer._map || STATE.map;
        if (!map) return false;
        // Only defer while the layer has something to show. If its tiles are
        // gone — first paint after switching the layer on, a `viewprereset`
        // wipe (non-animated zoom, `map.setView(..., {animate:false})`,
        // `redraw()`), or a pan outside the layer's footprint — the update must
        // run now, otherwise the user stares at an empty tile pane for the
        // whole settle window. Animated zooms (wheel, pinch, double-click: the
        // gestures this governor is for) never wipe the tiles, so they are
        // always deferred.
        if (!hasAnyTiles(layer)) return false;
        if (map._animatingZoom) return true;   // frames of the zoom animation
        if (STATE.zooming) return true;        // between zoomstart and zoomend
        if (STATE.lastZoomEndAt && (now() - STATE.lastZoomEndAt) < CFG.quietMs) return true;
        return false;
    }

    var _origUpdate = L.GridLayer.prototype._update;

    L.GridLayer.prototype._update = function (center) {
        if (!deferring(this)) return _origUpdate.call(this, center);
        if (STATE.pending.indexOf(this) === -1) STATE.pending.push(this);
        scheduleFlush();
    };

    function scheduleFlush(delay) {
        var d = (delay === undefined) ? CFG.quietMs : delay;
        var at = now() + d;
        // Several layers ask for the same flush: only the latest deadline needs
        // a timer, so a 20-layer stack does not reschedule 20 times per frame.
        if (STATE.timer && STATE.timerAt && STATE.timerAt <= at) return;
        if (STATE.timer) clearTimeout(STATE.timer);
        STATE.timerAt = at;
        STATE.timer = setTimeout(function () {
            STATE.timer = null;
            STATE.timerAt = 0;
            flush();
        }, d + 16);
    }

    function flush() {
        if (!STATE.pending.length) return;
        // A zoom that is still running keeps its deferral (it will schedule the
        // next flush itself); a stale flag is cleared by the watchdog.
        if (STATE.zooming || (STATE.map && STATE.map._animatingZoom)) {
            scheduleFlush();
            return;
        }
        var list = STATE.pending;
        STATE.pending = [];
        STATE.forceImmediate = true;
        try {
            for (var i = 0; i < list.length; i++) {
                var layer = list[i];
                var map = layer._map;
                if (!map || (map.hasLayer && !map.hasLayer(layer))) continue;
                try {
                    _origUpdate.call(layer, map.getCenter());
                    // `_update` does not prune in this Leaflet build: pruning is
                    // driven by _setView and by tile loads. Force it here so the
                    // levels the gesture left behind are released even when no
                    // new tile actually loads.
                    if (layer._pruneTiles) layer._pruneTiles();
                } catch (err) {
                    // Never let one broken layer stop the others.
                }
            }
        } finally {
            STATE.forceImmediate = false;
        }
    }

    /* ── 4. Stricter pruning + hard ceiling on retained tiles ─────────────── */

    var _origPrune = L.GridLayer.prototype._pruneTiles;

    L.GridLayer.prototype._pruneTiles = function () {
        if (!this._map || !CFG.enabled ||
            (this.options && this.options.dltilePerf === false) ||
            typeof this._retainParent !== 'function' ||
            typeof this._retainChildren !== 'function') {
            return _origPrune.call(this);
        }
        // While a zoom is running (or inside its settle window) the level shown
        // by the animation must stay: pruning now would blank the layer until
        // the deferred update runs. Memory cannot grow meanwhile — the tile
        // creation itself is deferred too.
        if (deferring(this)) return;

        var map = this._map;
        var zoom = map.getZoom();
        var key, tile;
        if (zoom > this.options.maxZoom || zoom < this.options.minZoom) {
            return this._removeAllTiles();
        }

        var waiting = false;
        for (key in this._tiles) {
            tile = this._tiles[key];
            tile.retain = tile.current;
            // Incoming zoom tiles are `current` as soon as `_update` queues
            // them, but they are only `active` once they have loaded (and
            // faded in, when fadeAnimation is on). Until then the previous
            // zoom must stay on screen — otherwise the user sees the map
            // background through a buffer of white/empty tiles.
            if (tile.current && !tile.active) waiting = true;
        }

        var parentLevels = layerOptNumber(this, 'dltilePerfRetainParents', cfgInt('retainParentLevels'));
        var childLevels = layerOptNumber(this, 'dltilePerfRetainChildren', cfgInt('retainChildLevels'));

        for (key in this._tiles) {
            tile = this._tiles[key];
            if (tile.current && !tile.active) {
                var c = tile.coords;
                var kept = (parentLevels > 0)
                    ? this._retainParent(c.x, c.y, c.z, c.z - parentLevels)
                    : false;
                if (!kept && childLevels > 0) {
                    this._retainChildren(c.x, c.y, c.z, c.z + childLevels);
                }
            }
        }

        if (waiting) {
            for (key in this._tiles) {
                tile = this._tiles[key];
                if (tile.loaded || tile.active) tile.retain = true;
            }
        }

        // Hard ceiling for the "just in case" tiles (off-screen ring + retained
        // zoom levels). It is never smaller than one full extra level, so the
        // zoom handoff (previous level scaled over the incoming one) survives.
        // Skip the cap while the new zoom is still loading, otherwise the
        // covering tiles we just kept would be dropped. Conservation mode
        // always applies the cap — crash protection beats a brief flash.
        var cap = layerOptNumber(this, 'dltilePerfMaxRetained', cfgInt('maxRetainedTiles'));
        if (cap >= 0 && (!waiting || STATE.conservation)) {
            var extra = [];
            var currentCount = 0;
            for (key in this._tiles) {
                tile = this._tiles[key];
                if (tile.current) currentCount++;
                else if (tile.retain) extra.push(key);
            }
            cap = Math.max(cap, currentCount);
            for (var i = 0; i < extra.length - cap; i++) {
                this._tiles[extra[i]].retain = false;
            }
        }

        for (key in this._tiles) {
            if (!this._tiles[key].retain) this._removeTile(key);
        }
    };

    /* ── 4b. Smooth zoom handoff: a pure-CSS tile fade ──────────────────── */

    // Leaflet's own fadeAnimation fades each loaded tile in through
    // _updateOpacity(): a requestAnimationFrame loop that rewrites the
    // opacity of ALL tiles of the layer for ~200 ms after every single tile
    // load. On a stack of dense layers that is exactly the work the governor
    // exists to remove, so low-power devices used to run with the fade off —
    // which is why the new zoom level popped in over the old one. This
    // section replaces the mechanism with a CSS opacity transition (GPU-side,
    // zero per-frame JS) while keeping Leaflet's handoff semantics: a tile
    // becomes `active` — the flag the pruner above waits for — only once its
    // fade has finished, so the covering tiles of the previous zoom stay on
    // screen for the whole cross-fade.

    function cssFadeActiveFor(layer) {
        if (!CFG.enabled || !CFG.cssFade) return false;
        if (layer.options && layer.options.dltilePerf === false) return false;
        // Only on the governed map: any other Leaflet map on the page (e.g.
        // a mini-map) keeps Leaflet's own behaviour untouched.
        var map = layer._map;
        return !!STATE.map && map === STATE.map && map._fadeAnimated === false;
    }

    var fadeStyleInstalled = false;

    function installFadeStyle() {
        if (fadeStyleInstalled || typeof document === 'undefined') return;
        // The page head only: test harnesses without one simply skip the
        // style and get the un-animated behaviour.
        var host = document.head;
        if (!host || typeof document.createElement !== 'function') return;
        var el = document.createElement('style');
        el.id = 'dltilePerfFadeStyle';
        el.textContent = '.dltile-cssfade .leaflet-tile{transition:opacity ' +
            CFG.fadeMs + 'ms linear;}';
        try {
            host.appendChild(el);
            fadeStyleInstalled = true;
        } catch (err) { /* the fade is cosmetic; never break for it */ }
    }

    var _origTileReady = L.GridLayer.prototype._tileReady;

    if (typeof _origTileReady === 'function') {
        L.GridLayer.prototype._tileReady = function (coords, err, tile) {
            var key = this._tileCoordsToKey ? this._tileCoordsToKey(coords) : null;
            var entry = (key !== null && this._tiles) ? this._tiles[key] : null;
            if (!cssFadeActiveFor(this) || err || !tile || !entry ||
                entry.el !== tile || entry._dlCssFade) {
                return _origTileReady.apply(this, arguments);
            }
            entry._dlCssFade = true;
            entry.loaded = +new Date();

            var el = entry.el;
            var layer = this;

            // Two animation frames so the browser registers opacity:0 before
            // the transition starts. The fade target is 1, exactly like
            // Leaflet's own fade: a layer opacity below 1 is applied by
            // Leaflet to the layer CONTAINER, never to the tiles, and when a
            // layer's opacity changes (e.g. the vertical slider) Leaflet
            // rewrites the tile opacities itself.
            try {
                el.style.opacity = 0;
                var raf = window.requestAnimationFrame ||
                    function (f) { return setTimeout(f, 16); };
                raf(function () {
                    raf(function () {
                        try { el.style.opacity = 1; } catch (e) {}
                    });
                });
            } catch (e) { /* never break tile loading for a visual effect */ }

            // The loaded-tile bookkeeping of Leaflet's own _tileReady — the
            // tile is announced at once, but becomes `active` (and lets the
            // pruner release the covering tiles) only when the fade is done.
            try {
                if (L.DomUtil && L.DomUtil.addClass) {
                    L.DomUtil.addClass(tile, 'leaflet-tile-loaded');
                }
            } catch (e) {}
            if (this.fire) this.fire('tileload', { tile: tile, coords: coords });

            setTimeout(function () {
                var t = layer._tiles ? layer._tiles[key] : null;
                if (!t || t !== entry) return;   // removed/replaced meanwhile
                t.active = true;
                if (t.el) {
                    try { t.el.style.opacity = 1; } catch (e) {}
                }
                if (!layer._noPrune && layer._pruneTiles) {
                    try { layer._pruneTiles(); } catch (e) {}
                }
            }, CFG.fadeMs + 40);

            if (this._noTilesToLoad && this._noTilesToLoad()) {
                this._loading = false;
                if (this.fire) this.fire('load');
            }
            return tile;
        };
    }

    /* ── 5. Page watchdog: tile budget + conservation mode ────────────────── */

    function countLiveTiles() {
        var map = STATE.map;
        var total = 0, layers = 0;
        if (!map || !map.eachLayer) return { tiles: 0, layers: 0 };
        map.eachLayer(function (layer) {
            if (!layer || !layer._tiles) return;
            var n = layerTiles(layer);
            if (n > 0) {
                total += n;
                layers++;
            }
        });
        return { tiles: total, layers: layers };
    }

    function stats() {
        var s = countLiveTiles();
        s.mb = Math.round(s.tiles * 0.25); // 256×256×4 bytes ≈ 0.25 MB
        s.budget = CFG.maxLiveTiles;
        s.lowPower = !!CFG.lowPower;
        s.conservation = !!STATE.conservation;
        return s;
    }

    function forEachTileLayer(fn) {
        var map = STATE.map;
        if (!map || !map.eachLayer) return;
        map.eachLayer(function (layer) {
            if (layer && layer._tiles) fn(layer);
        });
    }

    function sweep() {
        var saved = STATE.forceImmediate;
        STATE.forceImmediate = true;
        try {
            forEachTileLayer(function (layer) {
                if (layer._pruneTiles) {
                    try { layer._pruneTiles(); } catch (err) { /* ignore */ }
                }
            });
        } finally {
            STATE.forceImmediate = saved;
        }
    }

    function enterConservationMode(s) {
        STATE.conservation = true;
        // Existing layers keep their own options: tighten them in place so the
        // change applies to the next prune/update of every one of them. The
        // previous value is remembered so an explicit per-layer setting (e.g.
        // Sat60's keepBuffer on desktop) is restored when the page calms down.
        forEachTileLayer(function (layer) {
            layer._dltilePerfKeepBuffer = layer.options.keepBuffer;
            layer.options.keepBuffer = CONSERVATION.keepBuffer;
        });
        sweep();
        console.warn('[TilePerf] conservation mode ON — ' + s.tiles + ' tiles ≈ ' +
            Math.round(s.tiles * 0.25) + ' MB live in ' + s.layers + ' layers');
        showNotice();
        if (typeof api.onConservation === 'function') {
            try { api.onConservation(stats()); } catch (err) { /* ignore */ }
        }
    }

    function exitConservationMode() {
        STATE.conservation = false;
        forEachTileLayer(function (layer) {
            // Restore what the layer itself had asked for (the governor's
            // default was written into options.keepBuffer when it was created).
            layer.options.keepBuffer = (typeof layer._dltilePerfKeepBuffer === 'number')
                ? layer._dltilePerfKeepBuffer
                : CFG.keepBuffer;
            delete layer._dltilePerfKeepBuffer;
        });
        console.info('[TilePerf] conservation mode OFF — back to normal limits');
    }

    function tick() {
        var map = STATE.map;
        if (!map || !CFG.enabled) return;
        // Self-heal: if zoomend never arrived (interrupted animation), release
        // the deferral once the map has been quiet for a while.
        if (STATE.zooming && (now() - STATE.lastGestureAt) > 800) {
            STATE.zooming = false;
        }
        if (STATE.pending.length && !STATE.timer) flush();

        // Measuring walks every tile layer; never do it mid-gesture.
        if (STATE.zooming || map._animatingZoom || (now() - STATE.lastGestureAt) < 400) return;
        var s = countLiveTiles();
        STATE.stats = s;
        if (s.tiles > CFG.maxLiveTiles) {
            if (!STATE.conservation) enterConservationMode(s);
        } else if (STATE.conservation && s.tiles < CFG.maxLiveTiles * 0.6) {
            exitConservationMode();
        }
    }

    /* ── 6. One-time notice ("too many layers") ───────────────────────────── */

    function currentLanguage() {
        try {
            if (typeof currentLang !== 'undefined' && currentLang) return currentLang;
            if (typeof window._currentLang === 'function') {
                var l = window._currentLang();
                if (l) return l;
            }
        } catch (err) { /* ignore */ }
        return 'ro';
    }

    function noticeText() {
        var lang = currentLanguage();
        try {
            if (typeof translations !== 'undefined' && translations[lang] &&
                translations[lang].perf_layers_notice) {
                return translations[lang].perf_layers_notice;
            }
        } catch (err) { /* ignore */ }
        return (lang === 'en')
            ? 'Performance mode: too many image layers are open at once. Turn off the ones you do not need to keep the map smooth.'
            : 'Mod performanță: sunt prea multe straturi de imagini active simultan. Oprește-le pe cele de care nu ai nevoie, ca harta să rămână fluidă.';
    }

    function showNotice() {
        if (!CFG.notice || STATE.noticeShown) return;
        STATE.noticeShown = true;
        if (typeof document === 'undefined' || !document.body) return;
        var el = document.getElementById('dltilePerfNotice');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dltilePerfNotice';
            el.setAttribute('role', 'status');
            el.style.cssText = [
                'position:fixed', 'left:50%', 'bottom:86px', 'transform:translateX(-50%)',
                'max-width:min(420px,88vw)', 'z-index:12000', 'pointer-events:none',
                'padding:10px 14px', 'border-radius:10px',
                'background:rgba(6,14,30,0.94)', 'color:#E8EEF6',
                'border:1px solid rgba(79,195,247,0.35)',
                'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
                'font:0.78rem/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
                'opacity:0', 'transition:opacity 0.35s ease'
            ].join(';');
            el.textContent = noticeText();
            document.body.appendChild(el);
        }
        requestAnimationFrame(function () { el.style.opacity = '1'; });
        setTimeout(function () {
            el.style.opacity = '0';
            setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
            }, 400);
        }, 7000);
    }

    /* ── 7a. Map gestures drop the glass (see § header) ───────────────────── */

    // How long the surfaces stay defrosted after the LAST map event: the
    // settle window (quietMs) + the CSS tile fade (fadeMs) + a margin, so
    // the settle-window tile pop-in also happens without a re-blur burst.
    function glassGraceMs() {
        return (CFG.quietMs || 0) + (CFG.fadeMs || 0) + 120;
    }

    // The check runs slightly AFTER the staleness threshold, so a timer that
    // fires a hair early still lifts the class instead of re-arming.
    function glassArmMs() {
        return glassGraceMs() + 60;
    }

    // Called from activity() on every gesture event (zoomstart / movestart /
    // zoomanim / move / zoom / zoomend / moveend — a pinch fires them all).
    function glassGestureEvent() {
        if (!CFG.gestureGlassOff) return;
        if (!STATE.glassAdded) {
            try {
                if (!document.body || !document.body.classList) return;
                document.body.classList.add('map-gesturing');
                STATE.glassAdded = true;
            } catch (err) {
                // No body / no classList: the glass simply stays frosted.
                STATE.glassAdded = false;
                return;
            }
        }
        // Self-healing timer: it is re-armed by every event, so if the
        // event chain is ever cut short (the historical ReferenceError
        // between zoomend and moveend) the class still lifts on its own.
        if (STATE.glassTimer) clearTimeout(STATE.glassTimer);
        STATE.glassTimer = setTimeout(glassGestureCheck, glassArmMs());
    }

    function glassGestureCheck() {
        STATE.glassTimer = null;
        if (!STATE.glassAdded) return;
        if (now() - STATE.lastGestureAt < glassGraceMs()) {
            STATE.glassTimer = setTimeout(glassGestureCheck, glassArmMs());
            return;
        }
        try {
            if (document.body && document.body.classList) {
                document.body.classList.remove('map-gesturing');
            }
        } catch (err) { /* cosmetic */ }
        STATE.glassAdded = false;
    }

    /* ── 7. Map wiring ────────────────────────────────────────────────────── */

    function attach(map) {
        if (!map || map._dltilePerfAttached) return api;
        map._dltilePerfAttached = true;
        STATE.map = map;

        function activity() { STATE.lastGestureAt = now(); glassGestureEvent(); }

        map.on('zoomstart', function () {
            STATE.zooming = true;
            STATE.zoomStartedAt = now();
            activity();
            // The layers already waiting are NOT dropped: their update is
            // re-run at the end of the new gesture, which is exactly what the
            // new zoom needs. Dropping them would leave a layer that no longer
            // gets an event (e.g. its zoom gate changed) without tiles.
        });
        map.on('zoomend', function () {
            STATE.zooming = false;
            STATE.lastZoomEndAt = now();
            activity();
            // The settle window starts here: a zoom that follows immediately
            // merges into this one instead of loading tiles of its own.
            if (STATE.pending.length) scheduleFlush();
        });
        map.on('movestart', function () {
            activity();
            // A pan/pinch means the user is looking at THIS zoom now: load the
            // updates that were waiting for the zoom to settle (Leaflet fires
            // zoomstart before movestart, so a real zoom gesture — which keeps
            // its own deferral — never reaches flush()).
            if (STATE.zooming || map._animatingZoom) return;
            if (STATE.timer) {
                clearTimeout(STATE.timer);
                STATE.timer = null;
                STATE.timerAt = 0;
            }
            flush();
        });
        map.on('move zoom', activity);
        map.on('moveend', function () {
            activity();
            if (STATE.pending.length) scheduleFlush();
        });

        // Tile fade. Leaflet's own fadeAnimation runs a requestAnimationFrame
        // loop over ALL tiles of a layer for every loaded tile — the worst
        // possible work during a tile burst, so it cannot stay on a stack of
        // dense layers. With cssFade (the default) Leaflet's fade machinery
        // is switched off and §4b cross-fades the incoming tiles with a CSS
        // transition instead: the zoom handoff stays smooth on every device.
        if (CFG.cssFade) {
            if (map.options) map.options.fadeAnimation = false;
            map._fadeAnimated = false;
            installFadeStyle();
            if (map.getContainer) {
                try {
                    map.getContainer().classList.add('dltile-cssfade');
                } catch (err) { /* cosmetic; the fade degrades to a pop */ }
            }
        } else if (CFG.fadeAnimation !== null && CFG.fadeAnimation !== undefined && map._fadeAnimated) {
            map.options.fadeAnimation = !!CFG.fadeAnimation;
            map._fadeAnimated = !!CFG.fadeAnimation;
        }

        if (STATE.tick) clearInterval(STATE.tick);
        STATE.tick = setInterval(tick, CFG.sweepEveryMs);
        if (map.whenReady) {
            map.whenReady(function () {
                setTimeout(tick, Math.min(CFG.sweepEveryMs, 3000));
            });
        }
        return api;
    }

    /* ── 8. Public API ────────────────────────────────────────────────────── */

    var api = {
        version: '20261029-android-zoom-glass',
        config: CFG,
        conservationLimits: CONSERVATION,
        isLowPowerDevice: function () { return !!CFG.lowPower; },
        attach: attach,
        sweep: sweep,
        stats: stats,
        inConservationMode: function () { return !!STATE.conservation; },
        // Explicit options for a specific layer (map-app.js uses this for the
        // LIDAR stack so its gesture behaviour is visible in the source too).
        tileOptions: function (extra) {
            var o = {
                updateWhenZooming: !!CFG.updateWhenZooming,
                keepBuffer: cfgInt('keepBuffer')
            };
            if (CFG.updateWhenIdle !== null && CFG.updateWhenIdle !== undefined) {
                o.updateWhenIdle = !!CFG.updateWhenIdle;
            }
            for (var k in extra) o[k] = extra[k];
            return o;
        },
        onConservation: null
    };

    window.DLTilePerf = api;
})();
