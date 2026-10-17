/* ============================================================================
 * lidar-3d-focus.js — LiDAR in the 3D view: one layer, one prepared disc
 * ----------------------------------------------------------------------------
 * THE PROBLEM
 *   The 3D view drapes whatever the 2D map is showing (js/map3d-mirror.js →
 *   js/map3d-terrain.js). That works for a historical sheet or a hillshade the
 *   size of a country — but national LiDAR pyramids are not “a layer”, they are
 *   a few hundred thousand heavy tiles (a Romanian 1 m hillshade tile is tens of
 *   kilobytes; the country is ~240 000 km²). Switching one on and pressing 3D
 *   therefore asked MapLibre for whatever the opening camera saw, at every zoom
 *   level, through one provider that is happy to answer slowly — the report
 *   behind this file: “some LiDAR layers still load really slow, or look really
 *   bad, or don't load at all in 3D — e.g. Romania 1m/pixel agregare, AB”.
 *
 * WHAT THIS DOES
 *   Pressing 3D with a LiDAR layer on no longer opens 3D straight away. The
 *   viewer's entry gate (DetectLabMap3D.setEntryGate) calls the dialog below:
 *
 *     1. it explains that LiDAR in 3D is limited to a 10 km radius per load,
 *     2. it asks for ONE LiDAR layer (only one may be draped at a time),
 *     3. it asks for a point on the map and a fetching distance (1–10 km),
 *     4. it plans the tiles of that disc — a bounded zoom window around the
 *        zoom at which the whole disc fits the screen (see planDisc below),
 *     5. it prefetches them through the very path the 3D view uses (same proxy
 *        decision, same CSS-blend repaint, same disc clip; the viewer keeps
 *        them in memory in `state.primed`),
 *     6. it shows the progress of exactly that, and only then lets the 3D view
 *        open — framed on the disc, on tiles that are already there.
 *
 *   The same dialog is reachable from the 3D bar (“Change the area”), where it
 *   re-prepares and re-applies the focus to the running 3D view.
 *
 *   Once the tiles are fetched and the 3D view is entered, the window does
 *   not vanish: it MINIMIZES to a slim pill at the bottom of the map (layer,
 *   fetching distance and prepared-tile count, plus an expand arrow). The
 *   pill is only painted while 3D is up (`body.is-3d`); tapping the arrow
 *   expands the full window again over the 3D view — in live mode, so it
 *   re-points the running view — and cancelling an expanded window returns
 *   it to the pill instead of dismissing it. Removing LiDAR from the 3D view
 *   (the bar's “remove”) takes the pill away with the focus.
 *
 * RULES THAT HOLD EVERYWHERE
 *   • ONE LiDAR layer at a time in 3D. The 2D map may stack as many as it likes
 *     (that is how you compare them); the deck draws only the chosen one, and
 *     the 3D bar names both the chosen layer and what it left out.
 *   • 10 km radius maximum, 1 km minimum. The dialog cannot ask for more.
 *   • The LiDAR of that layer is drawn ONLY inside the disc. Every tile is
 *     clipped to the circle in the protocol handler (js/map3d-mirror.js →
 *     disc.maskTile) and the raster source is bounded to the disc's rectangle,
 *     so no request ever leaves the prepared area. The disc is outlined on both
 *     maps, so the edge of the LiDAR is visibly a decision, not a failure.
 *   • Nothing here re-implements a tile URL: the plan asks the 2D layer itself
 *     (DetectLabMirror.tileUrlFor / renderTile), exactly like the 3D view does.
 *
 * CONFIGURATION (optional, read once at start)
 *   window.DETECTLAB_LIDAR_3D = {
 *     maxRadiusKm: 10,        // the hard ceiling (and the slider's maximum)
 *     defaultRadiusKm: 5,
 *     budget: { url: 700, canvas: 260 },   // tiles per prefetch
 *     concurrency: 0          // 0 = the viewer's own (6 desktop / 4 phone)
 *   };
 *
 * Exposes window.DetectLabLidar3D:
 *   .VERSION .MAX_RADIUS_KM .MIN_RADIUS_KM .DEFAULT_RADIUS_KM .BUDGET
 *   .activeLayers() .status() .isReady() .install()
 *   .plan(focus, opts) .planEntries(plan) .prepare(plan, opts)
 *   .applyFocus(focus) .drawDisc(focus) .clearDisc()
 *   .beginPick(opts) .endPick(opts) .openDialog(opts) .closeDialog()
 *   .minimizeDialog() .expandDialog()
 *   .PREPARE (pure planning helpers, for the tests)
 *   ._gate() (the entry gate the viewer calls) ._copy ._t
 * ========================================================================== */
(function (root, document) {
    'use strict';

    if (!root || !document) return;

    var VERSION = '2026-10-14-lidar-3d-focus-v1';
    var LIMITS = root.DETECTLAB_LIDAR_3D || {};
    var MAX_RADIUS_KM = Math.max(1, Math.min(50, Number(LIMITS.maxRadiusKm) || 10));
    var MIN_RADIUS_KM = 1;
    var DEFAULT_RADIUS_KM = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, Number(LIMITS.defaultRadiusKm) || 5));
    var BUDGET = {
        url: Math.max(40, Number((LIMITS.budget && LIMITS.budget.url) || 700)),
        canvas: Math.max(20, Number((LIMITS.budget && LIMITS.budget.canvas) || 260))
    };
    /* The disc's diameter, in tiles, at the zoom the planner anchors on. 3.2
     * keeps the whole disc on screen on a phone and a desktop alike with a
     * margin for the outline; the levels above it are the detail the user zooms
     * into next. */
    var FIT_TILES = 3.2;
    var VIEWPORT_MARGIN = 0.78;
    var METRES_PER_PIXEL_Z0 = 156543.03392804097;
    var ASSUMED_TILE_BYTES = 48 * 1024;

    var PANE_NAME = 'pane_lidar_3d_focus';
    var PANE_Z = 656;                       /* above the LiDAR panes (610–651) */

    /* ── copy ───────────────────────────────────────────────────────────── */
    var COPY = {
        ro: {
            title: 'LiDAR în 3D',
            lead: 'În vederea 3D, LiDAR se poate încărca doar pe o rază de maximum ' + MAX_RADIUS_KM +
                ' km o dată. Alege un punct pe hartă și distanța de descărcare: tile-urile zonei sunt ' +
                'descărcate și modelate pe relief înainte de a intra în 3D.',
            layer: 'Strat LiDAR pentru 3D',
            layerHint: 'Un singur strat LiDAR poate fi afișat în 3D. Celelalte rămân aprinse pe harta 2D.',
            distance: 'Distanță de descărcare (rază)',
            km: 'km',
            point: 'Centrul zonei',
            pick: 'Alege pe hartă',
            move: 'Mută punctul',
            cancel: 'Renunță',
            go: 'Descarcă și deschide 3D',
            goLive: 'Descarcă și aplică',
            estimate: '≈ {tiles} tile-uri · ~{size} MB',
            estimateCanvas: '≈ {tiles} tile-uri (desenate de stratul 2D)',
            estimateBig: 'Peste bugetul de {budget} tile-uri: se descarcă prioritar zona din mijloc.',
            progress: 'Se descarcă tile-urile zonei… {done}/{total}',
            preparing: 'Se modelează tile-urile pe relief…',
            prepared: 'Gata: {tiles} tile-uri pregătite pentru relief.',
            failedTiles: '{failed} tile-uri nu au putut fi pregătite; vor fi cerute la nevoie.',
            stopped: 'Descărcare oprită.',
            stopNow: 'Oprește descărcarea',
            noRoute: 'Stratul ales nu poate fi descărcat în avans.',
            layersEmpty: 'Niciun strat LiDAR nu este aprins pe harta 2D.',
            center: 'Centru',
            close: 'Închide',
            expand: 'Extinde fereastra LiDAR în 3D',
            miniTiles: '{tiles} tile-uri pregătite',
            minimize: 'Minimizează',
            cap: 'maximum ' + MAX_RADIUS_KM + ' km'
        },
        en: {
            title: 'LiDAR in 3D',
            lead: 'In the 3D view, LiDAR can only be loaded over a maximum radius of ' + MAX_RADIUS_KM +
                ' km at a time. Choose a point on the map and a fetching distance: the tiles of that ' +
                'area are downloaded and moulded onto the relief before 3D opens.',
            layer: 'LiDAR layer for 3D',
            layerHint: 'Only one LiDAR layer can be drawn in 3D. The others stay on the 2D map.',
            distance: 'Fetching distance (radius)',
            km: 'km',
            point: 'Centre of the area',
            pick: 'Choose on the map',
            move: 'Move the point',
            cancel: 'Cancel',
            go: 'Fetch and open 3D',
            goLive: 'Fetch and apply',
            estimate: '≈ {tiles} tiles · ~{size} MB',
            estimateCanvas: '≈ {tiles} tiles (drawn by the 2D layer itself)',
            estimateBig: 'Above the {budget}-tile budget: the tiles nearest the centre go first.',
            progress: 'Downloading the tiles of the area… {done}/{total}',
            preparing: 'Moulding the tiles onto the relief…',
            prepared: 'Done: {tiles} tiles ready to drape.',
            failedTiles: '{failed} tiles could not be prepared; they will be requested on demand.',
            stopped: 'Download stopped.',
            stopNow: 'Stop the download',
            noRoute: 'The chosen layer cannot be prefetched.',
            layersEmpty: 'No LiDAR layer is switched on on the 2D map.',
            center: 'Centre',
            close: 'Close',
            expand: 'Expand the LiDAR in 3D window',
            miniTiles: '{tiles} tiles ready',
            minimize: 'Minimize',
            cap: 'maximum ' + MAX_RADIUS_KM + ' km'
        }
    };

    function lang() {
        try {
            if (typeof root._currentLang === 'function') {
                var value = root._currentLang();
                if (typeof value === 'string' && /^(ro|en)/i.test(value)) return /^en/i.test(value) ? 'en' : 'ro';
            }
            var l = document.documentElement && document.documentElement.lang;
            return /^en/i.test(l || '') ? 'en' : 'ro';
        } catch (e) { return 'ro'; }
    }

    function t(key, vars) {
        var table = COPY[lang()] || COPY.en;
        var text = table[key] || COPY.en[key] || key;
        if (vars) {
            Object.keys(vars).forEach(function (name) {
                text = text.split('{' + name + '}').join(String(vars[name]));
            });
        }
        return text;
    }

    /* ── dependencies (resolved lazily: load order is not guaranteed) ────── */
    function viewer() { return root.DetectLabMap3D || null; }
    function mirror() { return root.DetectLabMirror || null; }
    function registry() { return root.DetectLabLayers || null; }
    function leaflet() { return root.L || null; }
    function leafletMap() { return root._dlMap || root.map || null; }
    function lidarGroup() { return root._lidarGroup || null; }

    function ready() { return !!(viewer() && mirror() && mirror().disc); }

    /* ═══════════════════════════════════════════════════════════════════════
     *  WHICH LAYERS COUNT AS LIDAR
     * -----------------------------------------------------------------------
     *  The master “LIDAR” switch in js/map-app.js owns one Leaflet layer group
     *  (window._lidarGroup) and tags every layer it builds with
     *  `_dlLidar = { key, label }`. The group is the source of truth here: it
     *  contains the Romanian sheets (HD/AR/AB/BH/CS/1m/2–5m, LAKI III), and the
     *  nine country modules (AHN, Kartverket, GUGiK, IGN, swisstopo, EA,
     *  Dataforsyningen, Lantmäteriet, Géoplateforme) — all of them LiDAR, all of
     *  them subjects of the one-layer/one-disc rule.
     * ═══════════════════════════════════════════════════════════════════════ */
    function tagOf(layer) { return (layer && layer._dlLidar) || null; }

    function labelOf(layer, tag) {
        if (tag && tag.label) return String(tag.label);
        var opts = (layer && layer.options) || {};
        var name = String(opts.name || opts.attribution || '').trim();
        if (name) return name.replace(/^©\s*LiDAR\s*/i, '').replace(/^©\s*/, '');
        var key = tag && tag.key;
        return key ? String(key) : 'LiDAR';
    }

    function zoomWindowOf(layer) {
        var opts = (layer && layer.options) || {};
        var max = opts.maxNativeZoom != null ? opts.maxNativeZoom : opts.maxZoom;
        var min = opts.minZoom;
        return {
            minzoom: min != null && isFinite(min) ? Math.max(0, Number(min)) : 0,
            maxzoom: max != null && isFinite(max) ? Math.min(22, Number(max)) : 20
        };
    }

    /** The tile size the layer itself draws with (256 unless it says otherwise). */
    function tileSizeOf(layer) {
        try { if (layer && layer.getTileSize) return layer.getTileSize().x || 256; } catch (e) { /* ignore */ }
        return 256;
    }

    /**
     * Every LiDAR layer the 2D map is currently showing, topmost last.
     *
     * A sub-layer with its opacity slider above 0 is added to the group by
     * js/map-app.js; one that is switched off is not. The group itself is only
     * on the map while the master switch is on — which is exactly “visible”.
     */
    function activeLayers() {
        var group = lidarGroup();
        var map = leafletMap();
        if (!group || !map || typeof group.getLayers !== 'function') return [];
        var groupOnMap = true;
        try { groupOnMap = typeof map.hasLayer !== 'function' || map.hasLayer(group); } catch (e) { groupOnMap = true; }
        if (!groupOnMap) return [];
        return group.getLayers().filter(function (layer) {
            if (!layer) return false;
            try { if (typeof map.hasLayer === 'function' && !map.hasLayer(layer)) return false; } catch (e) { /* keep it */ }
            var tag = tagOf(layer);
            if (!tag) return false;
            return true;
        }).map(function (layer) {
            var tag = tagOf(layer);
            var zoom = zoomWindowOf(layer);
            var mirrorKey = mirror() && mirror().keyFor ? mirror().keyFor(layer) : (tag.key || '');
            return {
                key: mirrorKey || tag.key,
                /* The family key the mirror puts on the item (`lidar.ro1m`) —
                 * the viewer matches the focus against it, and the deck key
                 * above against the tiles it serves. Both travel with the
                 * focus, because the two key spaces answer different questions. */
                lidarKey: tag.key || null,
                tagKey: tag.key,
                defId: layer._dlDefId || null,
                label: labelOf(layer, tag),
                opacity: (layer.options && layer.options.opacity) || 1,
                minzoom: zoom.minzoom,
                maxzoom: zoom.maxzoom,
                tileSize: tileSizeOf(layer),
                layer: layer
            };
        });
    }

    /** The layer the dialog picks by default: the most prominent one on top. */
    function defaultLayer(list) {
        var best = null;
        (list || []).forEach(function (entry) {
            if (!best) { best = entry; return; }
            if (entry.opacity > best.opacity + 0.001) { best = entry; return; }
            if (Math.abs(entry.opacity - best.opacity) <= 0.001) best = entry;     /* later = on top */
        });
        return best;
    }

    function entryFor(list, key) {
        for (var i = 0; i < (list || []).length; i += 1) {
            if (list[i].key === key) return list[i];
        }
        return null;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE PLAN — which tiles, at which zooms, for a disc
     * -----------------------------------------------------------------------
     *  The disc is a ground radius around a point, so the honest question is
     *  “at which zoom does this disc fill the viewport?”. That zoom (zFit) is
     *  where the 3D camera opens (the viewer fits the disc), so the plan takes
     *  one level below it (the context the terrain view shows around the disc at
     *  a pitch) and two above it (the detail the user zooms into next), clipped
     *  to the layer's own zoom window.
     *
     *  Two hard stops:
     *    • every tile must really intersect the disc (the disc's rectangle is
     *      only a rectangle — its corners are not part of the disc),
     *    • the total must stay inside the budget; the tiles nearest the centre
     *      of the disc are kept, and the rest is reported as `trimmed` instead
     *      of being silently dropped.
     * ═══════════════════════════════════════════════════════════════════════ */
    function viewportSize() {
        var host = document.getElementById('detectlab-map') || (leafletMap() && leafletMap().getContainer && leafletMap().getContainer());
        var width = (host && host.clientWidth) || root.innerWidth || 1024;
        var height = (host && host.clientHeight) || root.innerHeight || 768;
        return { width: Math.max(240, width), height: Math.max(240, height) };
    }

    /** The zoom at which the disc's diameter fits the viewport (fractional). */
    function fitZoom(disc, viewport, tileSize) {
        var size = tileSize || 256;
        var view = viewport || viewportSize();
        var side = Math.max(160, Math.min(view.width, view.height) * VIEWPORT_MARGIN);
        var metresPerPixel = (Number(disc.radiusKm) * 2000) / side * (256 / size);
        var atZoomZero = METRES_PER_PIXEL_Z0 * Math.cos(Number(disc.lat) * Math.PI / 180);
        if (!(metresPerPixel > 0)) return 0;
        return Math.log2(atZoomZero / metresPerPixel);
    }

    /** Ground distance (metres) from the disc's centre to a tile's centre. */
    function tileCentreDistanceM(disc, z, x, y) {
        var M = mirror();
        return M.disc.distanceM(disc, { lat: M.disc.latAt(y + 0.5, z), lng: M.disc.lngAt(x + 0.5, z) });
    }

    /**
     * The prefetch plan of one disc.
     *
     * opts: { minZoom, maxZoom, tileSize, budget, viewport, radiusKm }
     * Returns { disc, zFit, zoomFrom, zoomTo, levels, tiles, count, budget,
     *           trimmed, bytes, window } — `tiles` is what the download loop
     *           consumes, in the order it should be attempted (centre first).
     */
    function planDisc(focus, options) {
        options = options || {};
        var M = mirror();
        var disc = M.disc.of(focus) || M.disc.of({ lat: focus.lat, lng: focus.lng, radiusKm: focus.radiusKm });
        if (!disc) return null;
        var tileSize = Number(options.tileSize) || 256;
        var minZoom = Math.max(0, Math.min(22, Number(options.minZoom) || 0));
        var maxZoom = Math.max(minZoom, Math.min(22, Number(options.maxZoom) || 20));
        var budget = Math.max(1, Number(options.budget) || BUDGET.url);
        var view = options.viewport || viewportSize();

        var fractionalFit = fitZoom(disc, view, tileSize);
        var zFit = Math.max(minZoom, Math.min(maxZoom, Math.round(fractionalFit)));
        var zoomFrom = Math.max(minZoom, zFit - (Number(options.belowLevels) || 1));
        var zoomTo = Math.min(maxZoom, zFit + (Number(options.aboveLevels) || 2));

        var levels = [];
        var tiles = [];
        var trimmed = 0;
        for (var z = zoomFrom; z <= zoomTo; z += 1) {
            var window = M.disc.tileWindow(disc, z);
            var list = [];
            for (var x = window.x0; x <= window.x1; x += 1) {
                for (var y = window.y0; y <= window.y1; y += 1) {
                    if (!M.disc.touchesTile(disc, z, x, y)) continue;
                    list.push({ z: z, x: x, y: y, distanceM: tileCentreDistanceM(disc, z, x, y) });
                }
            }
            list.sort(function (a, b) { return a.distanceM - b.distanceM; });
            var room = budget - tiles.length;
            if (list.length > room) {
                trimmed += list.length - Math.max(0, room);
                list = room > 0 ? list.slice(0, room) : [];
            }
            levels.push({ z: z, count: list.length, window: window });
            tiles = tiles.concat(list);
            if (tiles.length >= budget) break;
        }
        return {
            disc: disc,
            zFit: zFit,
            zFitExact: Math.round(fractionalFit * 100) / 100,
            zoomFrom: zoomFrom,
            zoomTo: zoomTo,
            viewport: view,
            tileSize: tileSize,
            levels: levels,
            tiles: tiles,
            count: tiles.length,
            budget: budget,
            trimmed: trimmed,
            bytes: tiles.length * ASSUMED_TILE_BYTES
        };
    }

    function humanSize(bytes) {
        var mb = Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10;
        return mb < 0.1 ? '0.1' : String(mb);
    }

    function formatPoint(lat, lng) {
        function fmt(value) { return (Math.round(value * 100000) / 100000).toFixed(5); }
        return fmt(lat) + ', ' + fmt(lng);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE 2D DISC — what the user is about to prepare, drawn where they are
     * ═══════════════════════════════════════════════════════════════════════ */
    var discState = { circle: null, dot: null, preview: null, focus: null };

    function ensurePane(map) {
        var L = leaflet();
        if (!L || !map || typeof map.createPane !== 'function') return null;
        var pane = map.getPane(PANE_NAME);
        if (!pane) pane = map.createPane(PANE_NAME);
        if (pane && pane.style) {
            pane.style.zIndex = String(PANE_Z);
            pane.style.pointerEvents = 'none';
        }
        return pane ? PANE_NAME : null;
    }

    function drawDisc(focus, options) {
        options = options || {};
        var L = leaflet();
        var map = leafletMap();
        if (!L || !map || !focus) return false;
        ensurePane(map);
        var pane = map.getPane(PANE_NAME) ? PANE_NAME : undefined;
        var latlng = [Number(focus.lat), Number(focus.lng)];
        var radius = Number(focus.radiusKm) * 1000;
        var style = {
            pane: pane,
            color: '#c8a96e',
            weight: 2,
            dashArray: '6 5',
            fillColor: '#c8a96e',
            fillOpacity: options.fill ? 0.07 : 0.04,
            interactive: false
        };
        if (!discState.circle) {
            discState.circle = L.circle(latlng, style).addTo(map);
        } else {
            discState.circle.setStyle(style);
            discState.circle.setLatLng(latlng);
        }
        discState.circle.setRadius(radius);
        if (!discState.dot) {
            discState.dot = L.circleMarker(latlng, {
                pane: pane, radius: 4, color: '#ffe9b8', weight: 2,
                fillColor: '#c8a96e', fillOpacity: 1, interactive: false
            }).addTo(map);
        } else {
            discState.dot.setLatLng(latlng);
        }
        discState.circle.bringToFront && discState.circle.bringToFront();
        discState.focus = focus;
        return true;
    }

    function clearDisc() {
        var map = leafletMap();
        [discState.circle, discState.dot, discState.preview].forEach(function (layer) {
            if (layer && map) { try { map.removeLayer(layer); } catch (e) { /* ignore */ } }
        });
        discState.circle = null;
        discState.dot = null;
        discState.preview = null;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  POINT PICKING — a click on the 2D map, with a live preview
     * ═══════════════════════════════════════════════════════════════════════ */
    var picking = { active: false, onPick: null, onCancel: null, moveHandler: null, clickHandler: null, keyHandler: null, radiusKm: 5 };

    function beginPick(options) {
        options = options || {};
        var map = leafletMap();
        if (!map || typeof map.on !== 'function') return false;
        endPick({ silent: true });
        picking.active = true;
        picking.radiusKm = Number(options.radiusKm) || DEFAULT_RADIUS_KM;
        root._dlLidarFocusPicking = true;
        var container = map.getContainer ? map.getContainer() : null;
        if (container && container.classList) container.classList.add('m3d-picking');

        function previewAt(latlng) {
            var L = leaflet();
            if (!L) return;
            ensurePane(map);
            var pane = map.getPane(PANE_NAME) ? PANE_NAME : undefined;
            if (!discState.preview) {
                discState.preview = L.circle(latlng, {
                    pane: pane, radius: picking.radiusKm * 1000, color: '#ffe9b8',
                    weight: 1.5, dashArray: '4 5', fillColor: '#c8a96e',
                    fillOpacity: 0.05, interactive: false
                }).addTo(map);
            } else {
                discState.preview.setLatLng(latlng);
            }
            if (discState.preview.setRadius) discState.preview.setRadius(picking.radiusKm * 1000);
        }

        picking.moveHandler = function (event) {
            if (!picking.active || !event || !event.latlng) return;
            previewAt(event.latlng);
        };
        picking.clickHandler = function (event) {
            if (!picking.active) return;
            var latlng = event && event.latlng;
            if (!latlng) return;
            var onPick = picking.onPick;
            endPick({ silent: true });
            if (typeof onPick === 'function') onPick({ lat: latlng.lat, lng: latlng.lng });
        };
        picking.keyHandler = function (event) {
            if (!event || (event.key !== 'Escape' && event.key !== 'Esc')) return;
            var onCancel = picking.onCancel;
            endPick({ silent: true });
            if (typeof onCancel === 'function') onCancel();
        };
        picking.onPick = options.onPick || null;
        picking.onCancel = options.onCancel || null;
        map.on('click', picking.clickHandler);
        map.on('mousemove', picking.moveHandler);
        document.addEventListener('keydown', picking.keyHandler);
        return true;
    }

    function endPick(options) {
        options = options || {};
        var map = leafletMap();
        if (picking.clickHandler && map && typeof map.off === 'function') map.off('click', picking.clickHandler);
        if (picking.moveHandler && map && typeof map.off === 'function') map.off('mousemove', picking.moveHandler);
        if (picking.keyHandler) document.removeEventListener('keydown', picking.keyHandler);
        if (picking.active) {
            var container = map && map.getContainer ? map.getContainer() : null;
            if (container && container.classList) container.classList.remove('m3d-picking');
            root._dlLidarFocusPicking = false;
        }
        picking.active = false;
        picking.clickHandler = null;
        picking.moveHandler = null;
        picking.keyHandler = null;
        if (!options.silent) {
            picking.onPick = null;
            picking.onCancel = null;
        }
        if (discState.preview && map) {
            try { map.removeLayer(discState.preview); } catch (e) { /* ignore */ }
        }
        discState.preview = null;
        return true;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE DIALOG
     * ═══════════════════════════════════════════════════════════════════════ */
    var dialog = {
        host: null,
        card: null,
        hint: null,
        deferred: null,
        mode: 'gate',
        layers: [],
        chosen: null,
        point: null,
        radiusKm: DEFAULT_RADIUS_KM,
        plan: null,
        report: null,
        preparing: false,
        stop: false,
        open: false,
        minimized: false,       /* the card is folded into the pill (3D is up) */
        expandedFromMini: false,/* this showing was expanded from the pill */
        miniSummary: null,      /* { label, radiusKm, tiles } for the pill */
        el: {}
    };

    function wrapper() {
        var el = document.getElementById('detectlab-map');
        return (el && el.parentNode) || null;
    }

    function buildDialog() {
        if (dialog.host) return dialog.host;
        var host = wrapper();
        if (!host) return null;
        var node = document.createElement('div');
        node.id = 'map3d-focus';
        node.className = 'm3d-focus';
        node.hidden = true;
        node.innerHTML = [
            '<div class="m3d-focus-card" role="dialog" aria-modal="true" aria-labelledby="m3d-focus-title">',
            '<header class="m3d-focus-head">',
            '<h2 id="m3d-focus-title"></h2>',
            '<button type="button" class="m3d-focus-x" aria-label="' + t('close') + '">×</button>',
            '</header>',
            '<p class="m3d-focus-lead" id="m3d-focus-lead"></p>',
            '<div class="m3d-focus-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-layer-label"></span>',
            '<em class="m3d-focus-cap"></em></div>',
            '<div class="m3d-focus-layers" role="radiogroup"></div>',
            '<p class="m3d-focus-hintline"></p>',
            '</div>',
            '<div class="m3d-focus-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-distance-label"></span>',
            '<b class="m3d-focus-radius-val"></b></div>',
            '<input id="m3d-focus-radius" class="m3d-focus-radius" type="range" min="' + MIN_RADIUS_KM +
            '" max="' + MAX_RADIUS_KM + '" step="1" value="' + DEFAULT_RADIUS_KM + '">',
            '<div class="m3d-focus-chips"></div>',
            '</div>',
            '<div class="m3d-focus-block m3d-focus-point-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-point-label"></span>',
            '<b class="m3d-focus-point-val"></b></div>',
            '<button type="button" class="m3d-focus-pick"></button>',
            '</div>',
            '<p class="m3d-focus-estimate" aria-live="polite"></p>',
            '<div class="m3d-focus-actions">',
            '<button type="button" class="m3d-focus-go"></button>',
            '<button type="button" class="m3d-focus-cancel"></button>',
            '</div>',
            '<div class="m3d-focus-progress" hidden>',
            '<div class="m3d-focus-bar"><i></i></div>',
            '<div class="m3d-focus-progress-text" aria-live="polite"></div>',
            '<button type="button" class="m3d-focus-stop"></button>',
            '</div>',
            '</div>',
            /* The minimized form of this very window: what it folds into once
             * the tiles are fetched and the 3D view is entered. The whole
             * pill is the expand control — the arrow says it opens upwards,
             * back into the card above it. */
            '<button type="button" class="m3d-focus-mini" hidden aria-expanded="false">',
            '<span class="m3d-focus-mini-title"></span>',
            '<span class="m3d-focus-mini-text"></span>',
            '<span class="m3d-focus-mini-arrow" aria-hidden="true">▴</span>',
            '</button>'
        ].join('');
        host.appendChild(node);
        dialog.host = node;
        dialog.card = node.querySelector('.m3d-focus-card');
        if (!dialog.card) return null;          /* the markup above did not parse: no dialog */

        var el = dialog.el;
        el.title = node.querySelector('#m3d-focus-title');
        el.lead = node.querySelector('.m3d-focus-lead');
        el.layerLabel = node.querySelector('.m3d-focus-layer-label');
        el.cap = node.querySelector('.m3d-focus-cap');
        el.layers = node.querySelector('.m3d-focus-layers');
        el.hintline = node.querySelector('.m3d-focus-hintline');
        el.distanceLabel = node.querySelector('.m3d-focus-distance-label');
        el.radius = node.querySelector('#m3d-focus-radius');
        el.radiusValue = node.querySelector('.m3d-focus-radius-val');
        el.chips = node.querySelector('.m3d-focus-chips');
        el.pointLabel = node.querySelector('.m3d-focus-point-label');
        el.pointValue = node.querySelector('.m3d-focus-point-val');
        el.pick = node.querySelector('.m3d-focus-pick');
        el.estimate = node.querySelector('.m3d-focus-estimate');
        el.go = node.querySelector('.m3d-focus-go');
        el.cancel = node.querySelector('.m3d-focus-cancel');
        el.progress = node.querySelector('.m3d-focus-progress');
        el.bar = node.querySelector('.m3d-focus-bar i');
        el.progressText = node.querySelector('.m3d-focus-progress-text');
        el.stop = node.querySelector('.m3d-focus-stop');
        el.mini = node.querySelector('.m3d-focus-mini');
        el.miniTitle = node.querySelector('.m3d-focus-mini-title');
        el.miniText = node.querySelector('.m3d-focus-mini-text');
        el.miniArrow = node.querySelector('.m3d-focus-mini-arrow');

        el.radius.addEventListener('input', function () {
            var value = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, Number(el.radius.value) || DEFAULT_RADIUS_KM));
            dialog.radiusKm = value;
            if (discState.preview && discState.preview.setRadius) discState.preview.setRadius(value * 1000);
            if (discState.circle && !picking.active) discState.circle.setRadius(value * 1000);
            if (discState.focus && !picking.active) {
                discState.focus = null;
                if (discState.circle) discState.circle.setRadius(value * 1000);
            }
            refreshPlan({ restart: true });
            paintDialog();
        });
        el.chips.addEventListener('click', function (event) {
            var button = event.target && event.target.closest ? event.target.closest('button[data-radius]') : null;
            if (!button) return;
            el.radius.value = button.getAttribute('data-radius');
            dialog.radiusKm = Number(el.radius.value);
            if (discState.circle) discState.circle.setRadius(dialog.radiusKm * 1000);
            refreshPlan({ restart: true });
            paintDialog();
        });
        el.pick.addEventListener('click', function () { pickFromDialog(); });
        el.go.addEventListener('click', function () { confirmDialog(); });
        el.cancel.addEventListener('click', function () { cancelDialog(); });
        el['x'] = node.querySelector('.m3d-focus-x');
        if (el['x']) el['x'].addEventListener('click', function () { cancelDialog(); });
        el.stop.addEventListener('click', function () { dialog.stop = true; });
        if (el.mini) el.mini.addEventListener('click', function () { expandMinimized(); });
        /* The card is the description target of its own lead paragraph. */
        el.card = dialog.card;
        if (el.card.setAttribute) el.card.setAttribute('aria-describedby', 'm3d-focus-lead');
        return node;
    }

    /** Text, chips, estimate and buttons — everything that depends on state. */
    function paintDialog() {
        if (!dialog.host) return;
        var el = dialog.el;
        el.title.textContent = t('title');
        el.lead.textContent = t('lead');
        el.layerLabel.textContent = t('layer');
        el.cap.textContent = t('cap');
        el.hintline.textContent = t('layerHint');
        el.distanceLabel.textContent = t('distance');
        el.pointLabel.textContent = t('point');
        el.cancel.textContent = t('cancel');
        el.stop.textContent = t('stopNow');
        el.radiusValue.textContent = dialog.radiusKm + ' ' + t('km');
        el.radius.value = String(dialog.radiusKm);
        el.pick.textContent = dialog.point && dialog.point.picked ? t('move') : t('pick');
        el.pointValue.textContent = dialog.point
            ? formatPoint(dialog.point.lat, dialog.point.lng)
            : '—';
        el.go.textContent = dialog.mode === 'gate' ? t('go') : t('goLive');
        el.go.disabled = !dialog.chosen;
        el.go.hidden = dialog.preparing;
        el.cancel.hidden = dialog.preparing;
        /* Folded out of the pill, the × folds it back; otherwise it closes. */
        if (el['x']) {
            var xLabel = dialog.expandedFromMini ? t('minimize') : t('close');
            el['x'].setAttribute('aria-label', xLabel);
            el['x'].title = xLabel;
        }

        if (!el.chips.childNodes.length) {
            [1, 2, 5, MAX_RADIUS_KM].filter(function (value, at, all) {
                return all.indexOf(value) === at && value >= MIN_RADIUS_KM && value <= MAX_RADIUS_KM;
            }).forEach(function (value) {
                var button = document.createElement('button');
                button.type = 'button';
                button.setAttribute('data-radius', String(value));
                button.textContent = value + ' ' + t('km');
                el.chips.appendChild(button);
            });
        }
        Array.prototype.forEach.call(el.chips.querySelectorAll('button[data-radius]'), function (button) {
            var on = Number(button.getAttribute('data-radius')) === dialog.radiusKm;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        });

        /* The layer list: a radio group, because 3D draws exactly one. */
        el.layers.innerHTML = '';
        if (!dialog.layers.length) {
            var empty = document.createElement('p');
            empty.className = 'm3d-focus-empty';
            empty.textContent = t('layersEmpty');
            el.layers.appendChild(empty);
        }
        dialog.layers.forEach(function (entry) {
            var label = document.createElement('label');
            label.className = 'm3d-focus-layer' + (dialog.chosen && entry.key === dialog.chosen.key ? ' is-on' : '');
            var input = document.createElement('input');
            input.type = 'radio';
            input.name = 'm3d-focus-layer';
            input.value = entry.key;
            input.checked = !!(dialog.chosen && entry.key === dialog.chosen.key);
            input.addEventListener('change', function () {
                dialog.chosen = entry;
                refreshPlan({ restart: true });
                paintDialog();
            });
            var text = document.createElement('span');
            text.textContent = entry.label;
            label.appendChild(input);
            label.appendChild(text);
            el.layers.appendChild(label);
        });
        paintEstimate();
    }

    function paintEstimate() {
        var el = dialog.el;
        if (!dialog.plan) { el.estimate.textContent = ''; return; }
        var plan = dialog.plan;
        var lines = [];
        if (plan.route === 'canvas') {
            lines.push(t('estimateCanvas', { tiles: plan.count }));
        } else {
            lines.push(t('estimate', { tiles: plan.count, size: humanSize(plan.bytes) }));
        }
        if (plan.trimmed > 0) lines.push(t('estimateBig', { budget: plan.budget }));
        lines.push('z' + plan.zoomFrom + '–' + plan.zoomTo);
        el.estimate.textContent = lines.join(' · ');
    }

    function showDialog(options) {
        options = options || {};
        var node = buildDialog();
        if (!node) return Promise.resolve({ cancelled: true, reason: 'no-map' });
        dialog.mode = options.mode === 'live' ? 'live' : 'gate';
        dialog.layers = activeLayers();
        var previous = viewer() && viewer().getLidarFocus ? viewer().getLidarFocus() : null;
        var wanted = options.key || (previous && (previous.key || previous.defId));
        dialog.chosen = entryFor(dialog.layers, wanted) || defaultLayer(dialog.layers);
        dialog.radiusKm = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM,
            Number(options.radiusKm) || (previous && previous.radiusKm) || DEFAULT_RADIUS_KM));
        var center = null;
        try {
            var map = leafletMap();
            if (map && typeof map.getCenter === 'function') center = map.getCenter();
        } catch (e) { center = null; }
        dialog.point = {
            lat: Number(options.lat != null ? options.lat : (previous && previous.mask ? previous.mask.lat : center ? center.lat : 45.9432)),
            lng: Number(options.lng != null ? options.lng : (previous && previous.mask ? previous.mask.lng : center ? center.lng : 24.9668)),
            picked: !!(options.lat != null || previous)
        };
        if (typeof dialog.point.lat !== 'number' || !isFinite(dialog.point.lat)) dialog.point = { lat: 45.9432, lng: 24.9668, picked: false };
        if (typeof dialog.point.lng !== 'number' || !isFinite(dialog.point.lng)) dialog.point.lng = 24.9668;

        dialog.preparing = false;
        dialog.stop = false;
        dialog.report = null;
        /* A fresh showing is always the full card: whatever the window was
         * folded into (the pill) is unfolded, never left painted alongside. */
        dialog.minimized = false;
        node.classList.remove('is-minimized');
        if (dialog.card) dialog.card.hidden = false;
        if (dialog.el.mini) {
            dialog.el.mini.hidden = true;
            dialog.el.mini.setAttribute('aria-expanded', 'false');
        }
        refreshPlan({ restart: true });
        paintDialog();
        node.hidden = false;
        dialog.open = true;
        if (document.body && document.body.classList) document.body.classList.add('m3d-focus-open');

        /* An already-decided focus is offered as it is; the plan below recomputes
         * what is still missing, so pressing the button twice is not a re-download. */
        if (!dialog.deferred) {
            dialog.deferred = {};
            dialog.deferred.promise = new Promise(function (resolve) { dialog.deferred.resolve = resolve; });
        }
        try { if (dialog.el.go.focus) dialog.el.go.focus(); } catch (e) { /* ignore */ }
        return dialog.deferred.promise;
    }

    function closeDialog() {
        if (dialog.host) {
            dialog.host.hidden = true;
            dialog.host.classList.remove('is-minimized');
        }
        dialog.open = false;
        dialog.minimized = false;
        dialog.expandedFromMini = false;
        if (document.body && document.body.classList) document.body.classList.remove('m3d-focus-open');
    }

    /* What the pill says: the window's title, then the decision it stands
     * for — which layer, over what fetching distance, how many tiles were
     * prepared for it. Repainted on language change like the card is. */
    function paintMinimized() {
        var el = dialog.el;
        if (!el.mini) return;
        el.mini.setAttribute('aria-label', t('expand'));
        el.mini.setAttribute('title', t('expand'));
        if (el.miniTitle) el.miniTitle.textContent = t('title');
        var summary = dialog.miniSummary;
        if (el.miniText) {
            el.miniText.textContent = summary
                ? [summary.label,
                   summary.radiusKm + ' ' + t('km'),
                   t('miniTiles', { tiles: summary.tiles })].filter(Boolean).join(' · ')
                : '';
        }
    }

    /* Fold the window into its pill. The host stays in the DOM and the card
     * is hidden; the skin only paints the folded host while the 3D view is
     * up (`body.is-3d`), so the pill appears as the 3D view is entered and
     * leaves with it — it is chrome of the 3D view, not of the 2D map. */
    function minimizeDialog() {
        if (!dialog.host) return;
        dialog.minimized = true;
        dialog.expandedFromMini = false;
        dialog.open = false;
        if (dialog.card) dialog.card.hidden = true;
        if (dialog.el.mini) {
            dialog.el.mini.hidden = false;
            dialog.el.mini.setAttribute('aria-expanded', 'false');
        }
        dialog.host.classList.add('is-minimized');
        dialog.host.hidden = false;
        if (document.body && document.body.classList) document.body.classList.remove('m3d-focus-open');
        paintMinimized();
    }

    /* The arrow on the pill: expand the full window again, over whichever
     * map is live. With 3D up it re-opens in live mode (confirming re-points
     * the running view); without it, it prepares a new area and the confirm
     * opens 3D on it — exactly what the 3D bar's “change” button does. */
    function expandMinimized() {
        if (!dialog.minimized) return;
        dialog.expandedFromMini = true;
        var api = viewer();
        var wasOpen = !!(api && api.isOpen && api.isOpen());
        showDialog({ mode: wasOpen ? 'live' : 'gate' }).then(function (result) {
            if (!result || result.cancelled) return;
            if (!wasOpen && api && typeof api.openWithoutGate === 'function') api.openWithoutGate();
        });
    }

    function settle(result, options) {
        var deferred = dialog.deferred;
        dialog.deferred = null;
        /* A fetched disc settles into the pill rather than vanishing: the
         * window stays reachable for as long as its 3D view is up. */
        if (options && options.minimize) minimizeDialog();
        else closeDialog();
        if (deferred && deferred.resolve) deferred.resolve(result || { cancelled: true });
    }

    function cancelDialog() {
        dialog.stop = true;
        endPick({});
        /* Cancelling a window that was expanded from the pill folds it back
         * into the pill — the prepared focus is still in the 3D view, so
         * its window stays reachable. A fresh window cancels outright. */
        if (dialog.expandedFromMini) settle({ cancelled: true }, { minimize: true });
        else settle({ cancelled: true });
    }

    function pickFromDialog() {
        var map = leafletMap();
        if (!map) return;
        /* The card steps aside so the whole map is clickable: the crosshair
         * cursor says what the next tap does, and Escape backs out of it. */
        if (dialog.card) dialog.card.hidden = true;
        beginPick({
            radiusKm: dialog.radiusKm,
            onPick: function (point) {
                dialog.point = { lat: point.lat, lng: point.lng, picked: true };
                if (dialog.card) dialog.card.hidden = false;
                refreshPlan({ restart: true });
                paintDialog();
                if (dialog.el.go && dialog.el.go.focus) { try { dialog.el.go.focus(); } catch (e) { /* ignore */ } }
            },
            onCancel: function () { cancelPick(); }
        });
    }

    function cancelPick() {
        endPick({});
        if (dialog.card) dialog.card.hidden = false;
    }

    /* ── the plan behind the dialog ─────────────────────────────────────── */
    function refreshPlan(options) {
        options = options || {};
        var entry = dialog.chosen;
        if (!entry || !dialog.point) { dialog.plan = null; return null; }
        var focus = {
            key: entry.key,
            lidarKey: entry.lidarKey,
            defId: entry.defId,
            label: entry.label,
            lat: dialog.point.lat,
            lng: dialog.point.lng,
            radiusKm: dialog.radiusKm
        };
        var route = detectRoute(entry);
        var plan = planDisc(focus, {
            minZoom: entry.minzoom,
            maxZoom: entry.maxzoom,
            tileSize: entry.tileSize,
            budget: route === 'canvas' ? BUDGET.canvas : BUDGET.url
        });
        if (!plan) { dialog.plan = null; return null; }
        plan.route = route;
        plan.layer = entry;
        plan.focus = focus;
        dialog.plan = plan;
        var prepared = countPrepared(plan);
        plan.prepared = prepared;
        plan.pending = Math.max(0, plan.count - prepared);
        if (options.restart) {
            /* The user changed something: whatever was decided before is void,
             * but the tiles already in memory stay (they are still correct). */
            dialog.report = null;
            dialog.el.progress.setAttribute('hidden', 'hidden');
        }
        return plan;
    }

    /** Is this layer drawn from a URL, or does it draw its own tiles? */
    function detectRoute(entry) {
        var M = mirror();
        var layer = entry.layer;
        if (!layer || typeof M.tileUrlFor !== 'function') return entry.defId ? 'url' : 'canvas';
        try {
            var probe = planDiscProbe(entry);
            var url = M.tileUrlFor(layer, probe.z, probe.x, probe.y);
            if (url) return 'url';
        } catch (e) { /* fall through */ }
        return 'canvas';
    }

    function planDiscProbe(entry) {
        var view = viewportSize();
        var zoom = Math.max(0, Math.min(20, Math.round(fitZoom({ lat: 45, lng: 25, radiusKm: 5 }, view, entry.tileSize || 256))));
        var M = mirror();
        return {
            z: zoom,
            x: Math.floor(M.disc.lngToTileX(25, zoom)),
            y: Math.floor(M.disc.latToTileY(45, zoom))
        };
    }

        /* The prepared-tile cache lives in the viewer (state.primed); ask it rather
     * than guess, so “already prepared” survives closing and reopening 3D. */
    function isPrepared(url, layerKey) {
        var api = viewer();
        if (!api || typeof api.isPrepared !== 'function') return false;
        try { return !!api.isPrepared(url, layerKey); } catch (e) { return false; }
    }

    /** How many of this plan's tiles are already in memory. */
    function countPrepared(plan) {
        var M = mirror();
        var entry = plan.layer;
        var layer = entry && entry.layer;
        if (!M.tileUrlFor || !layer) return 0;
        var template = M.templateFor ? M.templateFor(layer) : '';
        var prepared = 0;
        plan.tiles.forEach(function (tile) {
            var url = '';
            try { url = M.tileUrlFor(layer, tile.z, tile.x, tile.y); } catch (e) { url = ''; }
            if (isPrepared(url || template, entry.key)) prepared += 1;
        });
        return prepared;
    }

    /** Turn the plan into the entries the viewer's prefetch loop consumes. */
    function planEntries(plan) {
        var M = mirror();
        var entry = plan.layer;
        var layer = entry && entry.layer;
        var template = layer && M.templateFor ? M.templateFor(layer) : null;
        var out = [];
        plan.tiles.forEach(function (tile) {
            if (plan.route === 'canvas') {
                out.push({
                    route: 'canvas',
                    layerKey: entry.key,
                    template: template,
                    z: tile.z, x: tile.x, y: tile.y
                });
                return;
            }
            var url = '';
            try { url = layer ? M.tileUrlFor(layer, tile.z, tile.x, tile.y) : ''; } catch (e) { url = ''; }
            if (!url) return;
            out.push({
                route: 'url',
                url: url,
                layerKey: entry.key,
                template: template,
                z: tile.z, x: tile.x, y: tile.y,
                preferProxy: isWmsLayer(layer, url)
            });
        });
        return out;
    }

    function isWmsLayer(layer, url) {
        var options = (layer && layer.options) || {};
        return !!(options.layers || options.layer || /[?&](service=wms|request=getmap)/i.test(url || ''));
    }

    /* ── prefetching ────────────────────────────────────────────────────── */
    var lastPrep = { plan: null, report: null, startedAt: 0 };

    function prepare(plan, options) {
        options = options || {};
        var api = viewer();
        if (!plan || !api || typeof api.prefetchTiles !== 'function') {
            return Promise.resolve({ total: 0, done: 0, prepared: 0, failed: 0, stopped: false, errors: [] });
        }
        var entries = planEntries(plan);
        if (!entries.length) {
            return Promise.resolve({ total: 0, done: 0, prepared: 0, failed: 0, stopped: false, errors: [] });
        }
        plan.count = entries.length;
        var started = Date.now();
        return api.prefetchTiles(entries, {
            concurrency: Number(options.concurrency) || (LIMITS.concurrency || 0),
            shouldStop: function () { return !!dialog.stop; },
            onProgress: function (report) {
                if (typeof options.onProgress === 'function') options.onProgress(report);
            }
        }).then(function (report) {
            report.ms = Date.now() - started;
            lastPrep = { plan: plan, report: report, startedAt: started };
            return report;
        });
    }

    /* ── what the buttons do ────────────────────────────────────────────── */
    function applyFocus(focus) {
        var api = viewer();
        if (!api || typeof api.setLidarFocus !== 'function') return null;
        var applied = api.setLidarFocus(focus);
        drawDisc(focus, { fill: true });
        return applied;
    }

    function confirmDialog() {
        if (dialog.preparing) return;
        var plan = dialog.plan || refreshPlan({});
        if (!plan || !plan.count) {
            settle({ cancelled: true, reason: 'nothing-to-fetch' });
            return;
        }
        dialog.preparing = true;
        dialog.stop = false;
        dialog.el.go.hidden = true;
        dialog.el.cancel.hidden = true;
        dialog.el.progress.hidden = false;
        renderProgress({ total: plan.count, done: 0, prepared: 0, failed: 0 });
        /* The focus is applied BEFORE the download, and that order is the whole
         * trick: the viewer's prefetch goes through the same clip pipeline the
         * 3D view uses, and that pipeline reads the disc from the focus. The
         * disc is also drawn in 2D now, so the user sees the exact area the
         * progress bar is talking about. */
        try {
            applyFocus(plan.focus);
        } catch (error) {
            /* Nothing has been fetched yet, so the honest answer is the
             * dialog back, with the reason — not a sheet frozen in its
             * “preparing” state over a download that never started. */
            dialog.preparing = false;
            dialog.el.progress.hidden = true;
            dialog.el.go.hidden = false;
            dialog.el.cancel.hidden = false;
            dialog.el.estimate.textContent = String((error && error.message) || error);
            return;
        }

        prepare(plan, {
            onProgress: function (report) { renderProgress(report); }
        }).then(function (report) {
            dialog.report = report;
            dialog.preparing = false;
            var prepared = report.prepared || 0;
            var failed = report.failed || 0;
            var focus = plan.focus;
            focus.preparedTiles = prepared;
            focus.failedTiles = failed;
            focus.plan = { zoomFrom: plan.zoomFrom, zoomTo: plan.zoomTo, count: plan.count, route: plan.route };
            /* The fetch is finished; everything from here is bookkeeping
             * (the counted re-application, the “Done” line, the pill
             * summary), and NONE of it may strand the entry: the gate is
             * waiting on settle(), and a throw in a Leaflet restyle or a
             * bar repaint used to leave the dialog sitting at “Done” with
             * the gate unanswered — fetch finished, nothing else happens.
             * The focus was already applied before the download, so the
             * entry proceeds on it whatever the bookkeeping does. */
            try {
                /* Same disc, now with the numbers: sameFocus() keeps the 3D sources
                 * exactly where they are, and only the bar's line changes. */
                applyFocus(focus);
                renderProgress(report, { final: true });
                /* The pill this window is about to fold into stands for exactly
                 * this disc: layer, fetching distance, tiles prepared. */
                dialog.miniSummary = {
                    label: dialog.chosen ? dialog.chosen.label : (focus.label || 'LiDAR'),
                    radiusKm: focus.radiusKm,
                    tiles: prepared
                };
            } catch (error) {
                if (root.console && console.warn) {
                    console.warn('[Lidar3D] the fetched disc is ready, but finishing the dialog failed: ' +
                        ((error && error.message) || error));
                }
            }
            if (dialog.mode === 'gate') {
                /* The gate settles and the 3D view is entered — the window
                 * minimizes instead of closing, so it is already there,
                 * folded, when the 3D view comes up. */
                settle({ cancelled: false, focus: focus, report: report }, { minimize: true });
            } else {
                /* Live re-focus: the running 3D view has just been re-pointed at
                 * the new disc, so let the “done” line be read for a moment
                 * before the dialog folds into its pill. */
                root.setTimeout(function () {
                    settle({ cancelled: false, focus: focus, report: report }, { minimize: true });
                }, 700);
            }
        }, function (error) {
            dialog.preparing = false;
            dialog.el.progress.hidden = true;
            dialog.el.go.hidden = false;
            dialog.el.cancel.hidden = false;
            dialog.el.estimate.textContent = String((error && error.message) || error);
        });
    }

    function renderProgress(report, options) {
        options = options || {};
        var el = dialog.el;
        var total = Math.max(1, Number(report.total) || 1);
        var done = Math.max(0, Math.min(total, Number(report.done) || 0));
        var percent = Math.round((done / total) * 100);
        if (el.bar) el.bar.style.width = percent + '%';
        var text;
        if (options.final) {
            text = t('prepared', { tiles: report.prepared || report.done || 0 });
            if (report.failed) text += ' ' + t('failedTiles', { failed: report.failed });
            if (report.stopped) text = t('stopped') + ' ' + text;
        } else if (done >= total) {
            text = t('preparing');
        } else {
            text = t('progress', { done: done, total: total });
            if (report.failed) text += ' · ' + t('failedTiles', { failed: report.failed });
        }
        if (el.progressText) el.progressText.textContent = text;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  THE ENTRY GATE
     * -----------------------------------------------------------------------
     *  Installed on the 3D viewer once it (and the map) exist. It answers the
     *  single question the viewer asks: “may I open?” — and the answer is a
     *  prepared disc, not a promise.
     * ═══════════════════════════════════════════════════════════════════════ */
    function gate() {
        var api = viewer();
        if (!api || typeof api.setEntryGate !== 'function') return Promise.resolve(true);
        if (!ready()) return Promise.resolve(true);
        var layers = activeLayers();
        if (!layers.length) {
            /* No LiDAR on the 2D map: 3D opens exactly as it always did. */
            return Promise.resolve(true);
        }
        if (api.isOpen && api.isOpen()) return Promise.resolve(true);
        return showDialog({ mode: 'gate' }).then(function (result) {
            if (!result || result.cancelled) return false;
            return true;                     /* applyFocus() already ran in confirmDialog */
        });
    }

    function install() {
        var api = viewer();
        if (!api || typeof api.setEntryGate !== 'function') return false;
        api.setEntryGate(gate);
        return true;
    }

    /* ── the 3D bar's two buttons ──────────────────────────────────────── */
    function onBarChange() {
        var api = viewer();
        var wasOpen = !!(api && api.isOpen && api.isOpen());
        showDialog({ mode: wasOpen ? 'live' : 'gate' }).then(function (result) {
            if (!result || result.cancelled) return;
            if (!wasOpen) {
                /* The dialog was opened from the 2D bar area while 3D was closed:
                 * the focus is prepared — now open the view on it. */
                if (api && typeof api.openWithoutGate === 'function') api.openWithoutGate();
            }
        });
    }

    function onBarClear() {
        var api = viewer();
        if (api && typeof api.clearLidarFocus === 'function') api.clearLidarFocus();
        clearDisc();
        /* The focus the pill stood for is gone, so the folded window goes
         * with it (a full dialog, if one is open, is left alone). */
        if (dialog.minimized) closeDialog();
        if (api && typeof api.syncLayers === 'function') api.syncLayers();
    }

    /* ── status (diagnostics + the tests) ──────────────────────────────── */
    function status() {
        var api = viewer();
        var layers = activeLayers();
        return {
            version: VERSION,
            ready: ready(),
            maxRadiusKm: MAX_RADIUS_KM,
            minRadiusKm: MIN_RADIUS_KM,
            defaultRadiusKm: DEFAULT_RADIUS_KM,
            budget: { url: BUDGET.url, canvas: BUDGET.canvas },
            layers: layers.map(function (entry) {
                return { key: entry.key, lidarKey: entry.lidarKey, label: entry.label, opacity: entry.opacity,
                    minzoom: entry.minzoom, maxzoom: entry.maxzoom, defId: entry.defId };
            }),
            dialog: {
                open: dialog.open,
                minimized: dialog.minimized,
                mode: dialog.mode,
                preparing: dialog.preparing,
                chosen: dialog.chosen ? dialog.chosen.key : null,
                point: dialog.point ? { lat: dialog.point.lat, lng: dialog.point.lng } : null,
                radiusKm: dialog.radiusKm,
                pointPicked: !!(dialog.point && dialog.point.picked)
            },
            plan: dialog.plan ? {
                route: dialog.plan.route,
                count: dialog.plan.count,
                pending: dialog.plan.pending,
                prepared: dialog.plan.prepared,
                zoomFrom: dialog.plan.zoomFrom,
                zoomTo: dialog.plan.zoomTo,
                zFit: dialog.plan.zFit,
                levels: dialog.plan.levels.map(function (level) { return { z: level.z, count: level.count }; }),
                budget: dialog.plan.budget,
                trimmed: dialog.plan.trimmed,
                bytes: dialog.plan.bytes
            } : null,
            lastPrepare: lastPrep.report ? {
                total: lastPrep.report.total,
                prepared: lastPrep.report.prepared,
                failed: lastPrep.report.failed,
                stopped: lastPrep.report.stopped,
                ms: lastPrep.report.ms || 0,
                errors: (lastPrep.report.errors || []).slice()
            } : null,
            focus: api && api.getLidarFocus ? api.getLidarFocus() : null,
            picking: !!picking.active
        };
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  BOOT
     * ═══════════════════════════════════════════════════════════════════════ */
    var api = {
        VERSION: VERSION,
        MAX_RADIUS_KM: MAX_RADIUS_KM,
        MIN_RADIUS_KM: MIN_RADIUS_KM,
        DEFAULT_RADIUS_KM: DEFAULT_RADIUS_KM,
        BUDGET: BUDGET,
        activeLayers: activeLayers,
        status: status,
        plan: planDisc,
        planEntries: planEntries,
        prepare: prepare,
        applyFocus: applyFocus,
        drawDisc: drawDisc,
        clearDisc: clearDisc,
        beginPick: beginPick,
        endPick: endPick,
        openDialog: function (options) { return showDialog(options || {}); },
        closeDialog: function () { cancelDialog(); },
        minimizeDialog: minimizeDialog,
        expandDialog: expandMinimized,
        install: install,
        isReady: ready,
        _copy: COPY,
        _t: t,
        _gate: gate,
        /* pure helpers, exposed for the regression suite */
        PREPARE: {
            fitZoom: fitZoom,
            planDisc: planDisc,
            humanSize: humanSize,
            formatPoint: formatPoint,
            viewportSize: viewportSize,
            tagOf: tagOf,
            defaultLayer: defaultLayer
        }
    };

    root.DetectLabLidar3D = api;

    var bootAttempts = 0;

    function whenReady() {
        var decided = !!wrapper() && install();
        if (!decided && bootAttempts < 40) {
            bootAttempts += 1;
            root.setTimeout(whenReady, 250);
            return;
        }
        if (!decided) {
            console.warn('[Lidar3D] the 3D viewer did not expose a gate — LiDAR will open as before');
            return;
        }
        /* The 3D bar's buttons announce themselves; the dialog is ours. */
        document.addEventListener('detectlab:map3d-lidar-change', onBarChange);
        document.addEventListener('detectlab:map3d-lidar-clear', onBarClear);
        document.addEventListener('detectlab:langchange', function () {
            if (dialog.open) paintDialog();
            if (dialog.minimized) paintMinimized();
        });
        /* A disc already decided (the 3D view restored it) is drawn in 2D too. */
        var restored = viewer().getLidarFocus && viewer().getLidarFocus();
        if (restored) drawDisc(restored, { fill: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', whenReady);
    } else {
        whenReady();
    }
}(typeof window !== 'undefined' && window ? window : null,
  typeof document !== 'undefined' ? document : null));
