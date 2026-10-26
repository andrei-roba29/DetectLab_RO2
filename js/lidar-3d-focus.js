/* ============================================================================
 * lidar-3d-focus.js — LiDAR in the 3D view: whole layers, or a 1 km disc
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
 *   Pressing 3D with LiDAR on no longer opens 3D straight away: the viewer's
 *   entry gate (DetectLabMap3D.setEntryGate) calls the dialog below, which
 *   asks ONE question first — how much of the LiDAR to load:
 *
 *   ▸ WHOLE LAYERS (scope 'full', the default). Every LiDAR layer switched on
 *     on the 2D map is listed, ticked, and drawn ENTIRELY in 3D: no prepared
 *     area, no disc clip, no zoom ceiling — the layer loads the way it loads on
 *     the 2D map, wherever the camera looks and at whatever zoom the layer has.
 *     Nothing is downloaded in advance; the tiles are requested as the user
 *     looks around. This is what “all LiDAR layers should be able to load in 3D
 *     entirely, not only 1 km” asks for.
 *
 *   ▸ ONLY 1 KM (scope 'disc'). The same list of layers, with a tick box each,
 *     so the user chooses WHICH of the layers switched on at that moment are
 *     prepared over the 1 km disc. For every ticked layer the dialog plans the
 *     tiles of that disc — from two levels below the zoom at which the disc
 *     fits the screen ALL THE WAY to the layer's own native maximum (see
 *     planDisc below) — prefetches them through the very path the 3D view
 *     draws with (same proxy decision, same CSS-blend repaint, same disc clip;
 *     the viewer keeps them in memory in `state.primed`), shows the progress of
 *     exactly that, and only then lets 3D open — framed on the disc, on tiles
 *     that are already there.
 *
 *   The same dialog is reachable from the 3D pill (“expand”), where it
 *   re-prepares and re-applies the focus to the running 3D view.
 *
 *   Once the tiles are fetched and the 3D view is entered, the window does
 *   not vanish: it MINIMIZES to a slim pill at the bottom of the map (layers,
 *   scope — whole layer or 1 km — and prepared-tile count, plus an expand
 *   arrow). The pill is only painted while 3D is up (`body.is-3d`); tapping the
 *   arrow expands the full window again over the 3D view — in live mode, so it
 *   re-points the running view — and cancelling an expanded window returns it
 *   to the pill instead of dismissing it. Removing LiDAR from the 3D view
 *   takes the pill away with the focus.
 *
 * RULES THAT HOLD EVERYWHERE
 *   • Only the layers the user ticked are drawn in 3D. The 2D map may stack as
 *     many as it likes (that is how you compare them); the deck draws the
 *     chosen ones and nothing else, and says so in status().lidar.
 *   • A disc is 1 km (≈2 km across) and it is an OPTION, not the rule. WHY the
 *     distance choice is still fixed at 1 km — the plan's zoom window is
 *     anchored on `round(fitZoom(disc))`, i.e. the zoom at which the whole disc
 *     fills the screen, and that zoom falls by one level for every doubling of
 *     the radius: a 5 km disc was prepared from levels two steps coarser than a
 *     1 km disc, so the bigger the disc the softer the very same view looked.
 *     At a fixed 1 km the opening view is always prepared at the layer's native
 *     detail. `window.DETECTLAB_LIDAR_3D.maxRadiusKm` still raises the cap
 *     (= re-enables the distance slider) for someone who wants a bigger disc.
 *   • In the disc scope every chosen layer is drawn ONLY inside the disc: every
 *     tile is clipped to the circle in the protocol handler (js/map3d-mirror.js
 *     → disc.maskTile) and the raster source is bounded to the disc's
 *     rectangle, so no request ever leaves the prepared area. The disc is
 *     outlined on both maps, so the edge of the LiDAR is visibly a decision,
 *     not a failure. The whole-layer scope has no edge at all.
 *   • Nothing here re-implements a tile URL: the plan asks the 2D layer itself
 *     (DetectLabMirror.tileUrlFor / renderTile), exactly like the 3D view does.
 *
 * CONFIGURATION (optional, read once at start)
 *   window.DETECTLAB_LIDAR_3D = {
 *     maxRadiusKm: 1,         // the hard ceiling; >1 brings the slider back
 *     defaultRadiusKm: 1,
 *     scope: 'full',          // 'full' (whole layers) or 'disc' (1 km)
 *     budget: { url: 700, canvas: 260 },   // tiles per prefetch
 *     concurrency: 0          // 0 = the viewer's own (6 desktop / 4 phone)
 *   };
 *
 * Exposes window.DetectLabLidar3D:
 *   .VERSION .MAX_RADIUS_KM .MIN_RADIUS_KM .DEFAULT_RADIUS_KM .SCOPES .BUDGET
 *   .activeLayers() .status() .isReady() .install()
 *   .plan(focus, opts) .planEntries(plan) .prepare(plan|plans, opts)
 *   .applyFocus(focus) .drawDisc(focus) .clearDisc()
 *   .beginPick(opts) .endPick(opts) .openDialog(opts) .closeDialog()
 *   .minimizeDialog() .expandDialog()
 *   .PREPARE (pure planning helpers, for the tests)
 *   ._gate() (the entry gate the viewer calls) ._copy ._t
 * ========================================================================== */
(function (root, document) {
    'use strict';

    if (!root || !document) return;

    var VERSION = '2026-10-26-lidar-3d-focus-whole-or-disc';
    var LIMITS = root.DETECTLAB_LIDAR_3D || {};
    /* One fixed disc, 1 km (§“RULES THAT HOLD EVERYWHERE”): every 3D entry is
     * prepared at the same ground resolution, so a smaller disc can no longer
     * look sharper than a larger one. >1 (window.DETECTLAB_LIDAR_3D) brings the
     * distance slider back; it is not offered by default. */
    var MAX_RADIUS_KM = Math.max(1, Math.min(50, Number(LIMITS.maxRadiusKm) || 1));
    var MIN_RADIUS_KM = 1;
    var DEFAULT_RADIUS_KM = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM, Number(LIMITS.defaultRadiusKm) || 1));
    var RADIUS_CHOICE = MAX_RADIUS_KM > MIN_RADIUS_KM;
    /* THE TWO SCOPES. 'full' draws the chosen LiDAR layers entirely (the way
     * the 2D map draws them); 'disc' prepares — and clips to — a 1 km circle.
     * Full is the default because a LiDAR layer should reach 3D the way every
     * other layer does; the disc stays one tap away as the answer to a heavy
     * national pyramid. `window.DETECTLAB_LIDAR_3D.scope` sets the first one. */
    var SCOPE_FULL = 'full';
    var SCOPE_DISC = 'disc';
    var SCOPES = [SCOPE_FULL, SCOPE_DISC];
    function normalScope(value) {
        return String(value || '').toLowerCase() === SCOPE_DISC ? SCOPE_DISC : (String(value || '').toLowerCase() === SCOPE_FULL ? SCOPE_FULL : null);
    }
    var DEFAULT_SCOPE = normalScope(LIMITS.scope) || SCOPE_FULL;
    /* The prefetch budget is now a DEPTH budget: the plan adds whole zoom
     * levels from zFit-1 upwards and stops before the first one that would not
     * fit, so this number decides how deep a 1 km disc is prepared.
     *   360  → a z17 pyramid is prepared whole (144 tiles: what a desktop
     *          prepared all along at 140), a z18 one stops at z17 and lets
     *          MapLibre overzoom the last level — no blank rim, no 500-tile
     *          wait on a phone, and the same plan on both devices.
     * The old flat 700 was never reached at 1 km (the window stopped at
     * zFit+2); it is kept for the big discs `maxRadiusKm` can still ask for. */
    var BUDGET = {
        url: Math.max(40, Number((LIMITS.budget && LIMITS.budget.url) || 360)),
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
            lead: 'Alege ce se încarcă în 3D: straturile LiDAR întregi, ori numai pe o rază de ' +
                MAX_RADIUS_KM + ' km în jurul unui punct ales pe hartă.',
            scope: 'Ce se încarcă',
            scopeFull: 'Straturile întregi',
            scopeDisc: 'Doar {km} km',
            scopeNoteFull: 'Straturile alese se încarcă întregi și se desenează în 3D pe toată suprafața ' +
                'lor, la orice zoom. Tile-urile se cer pe măsură ce te uiți — un strat național poate dura până apare.',
            scopeNoteDisc: 'Se descarcă în avans doar tile-urile din discul de {km} km, pentru straturile ' +
                'alese, înainte de a intra în 3D. În afara discului rămâne harta 2D.',
            layer: 'Straturi LiDAR de încărcat',
            layerFull: 'Straturi LiDAR de încărcat în 3D',
            layerDisc: 'Straturi LiDAR de descărcat pe discul de {km} km',
            layerHint: 'Sunt listate toate straturile LiDAR aprinse acum pe harta 2D — bifează ce vrei ' +
                'descărcat pe discul de {km} km. Celelalte rămân doar pe harta 2D.',
            layerHintFull: 'Sunt listate toate straturile LiDAR aprinse acum pe harta 2D. Fiecare strat ' +
                'bifat se încarcă întreg în 3D.',
            distance: RADIUS_CHOICE ? 'Distanță de descărcare (rază)' : 'Zonă descărcată',
            fixedRadius: 'Rază fixă: {km} km ({diameter} km diametru)',
            fixedNote: 'Centrul se alege pe hartă; tot ce e în afara discului rămâne harta de bază.',
            km: 'km',
            point: 'Centrul zonei',
            pick: 'Alege pe hartă',
            move: 'Mută punctul',
            cancel: 'Renunță',
            go: 'Descarcă și deschide 3D',
            goLive: 'Descarcă și aplică',
            estimate: '≈ {tiles} tile-uri · ~{size} MB',
            estimateCanvas: '≈ {tiles} tile-uri (desenate de stratul 2D)',
            estimateBig: 'Buget de {budget} tile-uri atins: discul este pregătit până la z{z}; la zoom mai mare tile-urile se măresc.',
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
            miniFull: 'straturile întregi',
            minimize: 'Minimizează',
            goFull: 'Deschide 3D',
            goLiveFull: 'Aplică în 3D',
            estimateWhole: '{layers} strat(u-uri) · se încarcă întregi în 3D · fără descărcare în avans',
            estimateWholeNote: 'Se cer tile-uri la fiecare zoom și la fiecare deplasare. Pentru un strat greu, alege „Doar {km} km”.',
            estimateMulti: '≈ {tiles} tile-uri în total · ~{size} MB',
            pickNone: 'Bifează cel puțin un strat LiDAR.',
            noLayersPicked: 'Niciun strat LiDAR bifat.',
            cap: RADIUS_CHOICE ? 'maximum ' + MAX_RADIUS_KM + ' km' : ''
        },
        en: {
            title: 'LiDAR in 3D',
            lead: 'Choose how much of the LiDAR goes into 3D: the whole layers, or only a ' +
                MAX_RADIUS_KM + ' km radius around a point you pick on the map.',
            scope: 'What is loaded',
            scopeFull: 'Whole layers',
            scopeDisc: 'Only {km} km',
            scopeNoteFull: 'The chosen layers are loaded entirely and drawn in 3D over their whole ' +
                'extent, at every zoom. Tiles are requested as you look around — a national layer can ' +
                'take a while to appear.',
            scopeNoteDisc: 'Only the tiles inside the {km} km disc are downloaded in advance, for the ' +
                'layers you tick, before 3D opens. Everything outside the disc stays the 2D map.',
            layer: 'LiDAR layers to load',
            layerFull: 'LiDAR layers to load in 3D',
            layerDisc: 'LiDAR layers to fetch over the {km} km disc',
            layerHint: 'Every LiDAR layer switched on on the 2D map is listed — tick the ones you want ' +
                'downloaded over the {km} km disc. The others stay on the 2D map only.',
            layerHintFull: 'Every LiDAR layer switched on on the 2D map is listed. Each ticked layer ' +
                'loads entirely in 3D.',
            distance: RADIUS_CHOICE ? 'Fetching distance (radius)' : 'Area downloaded',
            fixedRadius: 'Fixed radius: {km} km ({diameter} km across)',
            fixedNote: 'Pick the centre on the map; everything outside the disc stays the base map.',
            km: 'km',
            point: 'Centre of the area',
            pick: 'Choose on the map',
            move: 'Move the point',
            cancel: 'Cancel',
            go: 'Fetch and open 3D',
            goLive: 'Fetch and apply',
            estimate: '≈ {tiles} tiles · ~{size} MB',
            estimateCanvas: '≈ {tiles} tiles (drawn by the 2D layer itself)',
            estimateBig: 'Budget of {budget} tiles reached: the disc is prepared up to z{z}; deeper zoom enlarges those tiles.',
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
            miniFull: 'whole layers',
            minimize: 'Minimize',
            goFull: 'Open 3D',
            goLiveFull: 'Apply in 3D',
            estimateWhole: '{layers} layer(s) · loaded entirely in 3D · no download in advance',
            estimateWholeNote: 'Tiles are requested at every zoom and every pan. For a heavy layer, choose “Only {km} km”.',
            estimateMulti: '≈ {tiles} tiles in total · ~{size} MB',
            pickNone: 'Tick at least one LiDAR layer.',
            noLayersPicked: 'No LiDAR layer ticked.',
            cap: RADIUS_CHOICE ? 'maximum ' + MAX_RADIUS_KM + ' km' : ''
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

    /** Does this dialog entry answer to that key (any of its four spellings)? */
    function entryAnswersKey(entry, key) {
        if (!entry || !key) return false;
        if (entry.key === key || entry.lidarKey === key || entry.tagKey === key) return true;
        if (entry.defId && (key === entry.defId || key === 'def:' + entry.defId)) return true;
        if (entry.lidarKey && entry.defId && entry.lidarKey === 'def:' + entry.defId) return true;
        return false;
    }

    /** Every spelling a focus names its layers by (for the “starts ticked” set). */
    function focusKeysOf(focus) {
        if (!focus) return [];
        var layers = Array.isArray(focus.layers) && focus.layers.length ? focus.layers : [focus];
        var out = [];
        layers.forEach(function (layer) {
            [layer.key, layer.lidarKey, layer.defId, layer.defId ? 'def:' + layer.defId : null]
                .forEach(function (key) { if (key && out.indexOf(key) === -1) out.push(key); });
        });
        return out;
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
     * opts: { minZoom, maxZoom, tileSize, budget, viewport, radiusKm,
     *         belowLevels, aboveLevels }
     * Returns { disc, zFit, zoomFrom, zoomTo, levels, tiles, count, budget,
     *           trimmed, partial, bytes } — `tiles` is what the download loop
     *           consumes, in the order it should be attempted (centre first).
     *
     * The levels run from zFit-2 up to the LAYER's native maximum (bounded by
     * `aboveLevels`, 24 levels by default and by the budget): the screen only
     * decides where the camera opens. A level is included only WHOLE — the
     * plan stops before the first one the budget cannot hold and reports the
     * tiles it did not buy (`trimmed`), because a half-prepared level is a
     * hole at the rim at exactly the zoom the user is looking at. `zoomTo` is
     * therefore also the source ceiling in the 3D view (see renderRaster in
     * js/map3d-terrain.js): past it MapLibre overzooms the prepared tiles
     * instead of asking for tiles that were never downloaded.
     */
    function planDisc(focus, options) {
        options = options || {};
        var M = mirror();
        var disc = M.disc.of(focus) || M.disc.of({ lat: focus.lat, lng: focus.lng, radiusKm: focus.radiusKm });
        if (!disc) return null;
        var tileSize = Number(options.tileSize) || 256;
        var minZoom = Math.max(0, Math.min(22, Number(options.minZoom) || 0));
        var maxZoom = Math.max(minZoom, Math.min(22, Number(options.maxZoom) || 20));
        /* Capped: a configured budget is a depth budget, not a licence to
         * enumerate a national pyramid level by level (a 22-level zoom over a
         * 10 km disc is millions of tiles). 5 000 is already far past any
         * prefetch a device should attempt. */
        var budget = Math.max(1, Math.min(5000, Number(options.budget) || BUDGET.url));
        var view = options.viewport || viewportSize();

        var fractionalFit = fitZoom(disc, view, tileSize);
        var zFit = Math.max(minZoom, Math.min(maxZoom, Math.round(fractionalFit)));
        /* Two levels BELOW the fit, not one: coarse tiles are a handful
         * (z12 over a 1 km disc is one tile), and they are what a zoom-out —
         * the symmetrically broken gesture — needs to stay inside the
         * prefetch instead of falling into a live per-tile fetch. */
        var zoomFrom = Math.max(minZoom, zFit - (options.belowLevels == null ? 2 : Number(options.belowLevels) || 0));
        /* HOW DEEP THE PREFETCH GOES — the whole point of the 1 km disc.
         *
         * This used to stop two levels above zFit, where zFit is the zoom at
         * which the disc fits the SCREEN. On a phone that is two levels below
         * a desktop's, so a 1 km disc was prepared to z16 on a phone and z17
         * on a desktop (50 vs 140 tiles for a z17 pyramid) — and the moment
         * the user pinched in to z17 on the phone, every tile was outside the
         * prefetch: MapLibre asked the live protocol handler for them, the
         * slow per-tile fetch raced the pinch (MapLibre cancels pending tile
         * requests while zooming), and the disc fell back to the base map.
         * The detail ceiling is therefore the LAYER's native maximum, not the
         * screen's: a 1 km disc at z17/z18 is a few hundred tiles and fits the
         * budget. The screen decides where the camera opens (focusFitZoom in
         * js/map3d-terrain.js), never how deep the prepared disc goes. */
        var aboveLevels = options.aboveLevels == null ? 24 : Math.max(0, Number(options.aboveLevels) || 0);
        var zoomTo = Math.min(maxZoom, zFit + aboveLevels);

        function levelTiles(z) {
            var window = M.disc.tileWindow(disc, z);
            var list = [];
            for (var x = window.x0; x <= window.x1; x += 1) {
                for (var y = window.y0; y <= window.y1; y += 1) {
                    if (!M.disc.touchesTile(disc, z, x, y)) continue;
                    list.push({ z: z, x: x, y: y, distanceM: tileCentreDistanceM(disc, z, x, y) });
                }
            }
            list.sort(function (a, b) { return a.distanceM - b.distanceM; });
            return { window: window, list: list };
        }

        var levels = [];
        var tiles = [];
        var trimmed = 0;
        var partial = false;
        for (var z = zoomFrom; z <= zoomTo; z += 1) {
            var level = levelTiles(z);
            if (tiles.length + level.list.length > budget) {
                /* A level that cannot be prepared WHOLE is not prepared at
                 * all. A partially primed level is a disc with a hole in its
                 * rim at exactly the zoom the user is looking at — and the
                 * source is capped at the prepared ceiling, so that hole
                 * would show the base map under the LiDAR. Stop before it and
                 * report the tiles of THAT level as the ones the budget did
                 * not buy; the deeper levels were never attempted (and are
                 * not enumerated — a z22 level over a wide disc is millions
                 * of tiles nobody would fetch). */
                trimmed += level.list.length;
                break;
            }
            levels.push({ z: z, count: level.list.length, window: level.window });
            tiles = tiles.concat(level.list);
        }
        if (!levels.length) {
            /* Not even the widest level fits: prepare its centre, and say so.
             * (A budget this small is a deliberate override, not a device.) */
            var first = levelTiles(zoomFrom);
            var room = Math.max(1, budget);
            trimmed += Math.max(0, first.list.length - room);
            var kept = first.list.slice(0, room);
            levels.push({ z: zoomFrom, count: kept.length, window: first.window });
            tiles = tiles.concat(kept);
            partial = true;
        }
        zoomTo = levels[levels.length - 1].z;
        return {
            disc: disc,
            zFit: zFit,
            zFitExact: Math.round(fractionalFit * 100) / 100,
            zoomFrom: zoomFrom,
            zoomTo: zoomTo,
            partial: partial,
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
        discState.focus = null;
    }

    /* Keep the 2D disc and the 3D focus in sync with the actual LiDAR
     * visibility. When the yellow point/disc was left over after LiDAR was
     * disabled, or when the focused LiDAR layer itself was removed, the 2D
     * marker must disappear and the 3D view must not teleport to the old disc. */
    function syncDiscWithLidarState() {
        var layers = activeLayers();
        var api = viewer();
        var focus = api && api.getLidarFocus ? api.getLidarFocus() : null;
        var discFocus = discState.focus;

        if (!layers.length) {
            var hasDisc = !!(discState.circle || discState.dot || discState.preview || discFocus);
            if (hasDisc) clearDisc();
            if (focus && api && api.clearLidarFocus) {
                try { api.clearLidarFocus(); } catch (e) {}
            }
            return;
        }

        var relevant = focus || discFocus;
        if (!relevant) return;

        /* The decision can name several layers now: it is stale only when NONE
         * of them is still on the 2D map. One layer switched off must not take
         * the whole 3D view's LiDAR away. */
        var found = false;
        focusKeysOf(relevant).forEach(function (key) {
            layers.forEach(function (entry) { if (entryAnswersKey(entry, key)) found = true; });
        });
        if (!found) {
            clearDisc();
            if (api && api.clearLidarFocus) {
                try { api.clearLidarFocus(); } catch (e2) {}
            }
        }
    }

    function attachLidarWatcher() {
        var m = leafletMap();
        if (!m || typeof m.on !== 'function') return false;
        if (m._dlLidarDiscWatcher) return true;
        m._dlLidarDiscWatcher = true;
        try {
            m.on('layeradd', syncDiscWithLidarState);
            m.on('layerremove', syncDiscWithLidarState);
        } catch (e2) {}
        return true;
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
        scope: DEFAULT_SCOPE,   /* 'full' (whole layers) or 'disc' (1 km)      */
        layers: [],             /* every LiDAR layer on the 2D map, topmost last */
        picks: {},              /* key → the entry the user ticked             */
        chosen: null,           /* the first ticked entry (kept for the pill,
                                 * status() and anything that wants ONE name)  */
        point: null,
        radiusKm: DEFAULT_RADIUS_KM,
        plans: [],              /* one plan per ticked layer (disc scope)       */
        plan: null,             /* their aggregate — what the estimate/status quote */
        report: null,
        preparing: false,
        stop: false,
        open: false,
        minimized: false,       /* the card is folded into the pill (3D is up) */
        expandedFromMini: false,/* this showing was expanded from the pill */
        miniSummary: null,      /* { labels, scope, radiusKm, tiles } for the pill */
        el: {}
    };
    /* The scope the user settled on last (in this session): opening the
     * dialog again offers the same answer instead of re-deciding for them. */
    var lastScope = DEFAULT_SCOPE;

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
            /* HOW MUCH: the whole layers, or a 1 km disc around a chosen point.
             * Two options, always visible — this is the decision the window
             * exists for. */
            '<div class="m3d-focus-block m3d-focus-scope-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-scope-label"></span></div>',
            '<div class="m3d-focus-scope" role="group"></div>',
            '<p class="m3d-focus-scope-note"></p>',
            '</div>',
            '<div class="m3d-focus-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-layer-label"></span>',
            '<em class="m3d-focus-cap"></em></div>',
            /* A checkbox list, not a radio group: the 1 km cut is per chosen
             * layer, and the whole-layer scope may take several at once. */
            '<div class="m3d-focus-layers" role="group"></div>',
            '<p class="m3d-focus-hintline"></p>',
            '</div>',
            '<div class="m3d-focus-block m3d-focus-area-block">',
            '<div class="m3d-focus-label"><span class="m3d-focus-distance-label"></span>',
            '<b class="m3d-focus-radius-val"></b></div>',
            /* The radius is fixed (1 km) by default: no slider, no chips — just
             * the area the entry will prepare. A configured cap > 1 km brings
             * the control back (window.DETECTLAB_LIDAR_3D.maxRadiusKm). */
            RADIUS_CHOICE
                ? '<input id="m3d-focus-radius" class="m3d-focus-radius" type="range" min="' + MIN_RADIUS_KM +
                  '" max="' + MAX_RADIUS_KM + '" step="1" value="' + DEFAULT_RADIUS_KM + '">' +
                  '<div class="m3d-focus-chips"></div>'
                : '<p class="m3d-focus-hintline m3d-focus-fixed"></p>',
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
        el.scopeLabel = node.querySelector('.m3d-focus-scope-label');
        el.scopeGroup = node.querySelector('.m3d-focus-scope');
        el.scopeNote = node.querySelector('.m3d-focus-scope-note');
        el.areaBlock = node.querySelector('.m3d-focus-area-block');
        el.pointBlock = node.querySelector('.m3d-focus-point-block');
        el.layerLabel = node.querySelector('.m3d-focus-layer-label');
        el.cap = node.querySelector('.m3d-focus-cap');
        el.layers = node.querySelector('.m3d-focus-layers');
        el.hintline = node.querySelector('.m3d-focus-hintline');
        el.distanceLabel = node.querySelector('.m3d-focus-distance-label');
        el.radius = node.querySelector('#m3d-focus-radius');
        el.radiusValue = node.querySelector('.m3d-focus-radius-val');
        el.chips = node.querySelector('.m3d-focus-chips');
        el.fixed = node.querySelector('.m3d-focus-fixed');
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

        if (el.scopeGroup) {
            /* The two scopes are buttons, not radios: each is a 44px touch
             * target that also carries its own explanation below. */
            el.scopeGroup.addEventListener('click', function (event) {
                var button = event.target && event.target.closest ? event.target.closest('button[data-scope]') : null;
                if (!button) return;
                setScope(button.getAttribute('data-scope'));
            });
        }
        if (el.radius) el.radius.addEventListener('input', function () {
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
        if (el.chips) el.chips.addEventListener('click', function (event) {
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

    /* ── the scope: how much of the LiDAR goes into 3D ──────────────────── */
    function setScope(scope) {
        var next = normalScope(scope) || DEFAULT_SCOPE;
        if (dialog.scope === next) { paintDialog(); return; }
        dialog.scope = next;
        lastScope = next;
        /* Leaving the disc behind: nothing is being prepared over an area any
         * more, so the yellow outline on the 2D map goes with it. */
        if (next !== SCOPE_DISC && !picking.active) clearDisc();
        refreshPlan({ restart: true });
        paintDialog();
    }

    /** The layers the user ticked, in the order the 2D map lists them. */
    function pickedEntries() {
        return dialog.layers.filter(function (entry) {
            return !!(entry && dialog.picks[entry.key]);
        });
    }

    /** Text, chips, estimate and buttons — everything that depends on state. */
    function paintDialog() {
        if (!dialog.host) return;
        var el = dialog.el;
        el.title.textContent = t('title');
        el.lead.textContent = t('lead');
        el.layerLabel.textContent = t('layer');
        el.cap.textContent = t('cap');
        var disc = dialog.scope === SCOPE_DISC;
        el.scopeLabel.textContent = t('scope');
        el.layerLabel.textContent = disc ? t('layerDisc', { km: dialog.radiusKm }) : t('layerFull');
        el.hintline.textContent = disc ? t('layerHint', { km: dialog.radiusKm }) : t('layerHintFull');
        el.scopeNote.textContent = disc ? t('scopeNoteDisc', { km: dialog.radiusKm }) : t('scopeNoteFull');
        if (el.areaBlock) el.areaBlock.hidden = !disc;
        if (el.pointBlock) el.pointBlock.hidden = !disc;
        el.distanceLabel.textContent = t('distance');
        el.pointLabel.textContent = t('point');
        el.cancel.textContent = t('cancel');
        el.stop.textContent = t('stopNow');
        el.radiusValue.textContent = dialog.radiusKm + ' ' + t('km');
        if (el.radius) el.radius.value = String(dialog.radiusKm);
        if (el.fixed) {
            el.fixed.textContent = t('fixedRadius', { km: dialog.radiusKm, diameter: dialog.radiusKm * 2 }) +
                ' ' + t('fixedNote');
        }
        el.pick.textContent = dialog.point && dialog.point.picked ? t('move') : t('pick');
        el.pointValue.textContent = dialog.point
            ? formatPoint(dialog.point.lat, dialog.point.lng)
            : '—';
        /* Whole layers: nothing is downloaded in advance, so the button
         * promises the view, not a download. */
        if (dialog.mode === 'gate') el.go.textContent = disc ? t('go') : t('goFull');
        else el.go.textContent = disc ? t('goLive') : t('goLiveFull');
        el.go.disabled = !pickedEntries().length;
        el.go.hidden = dialog.preparing;
        el.cancel.hidden = dialog.preparing;
        /* Folded out of the pill, the × folds it back; otherwise it closes. */
        if (el['x']) {
            var xLabel = dialog.expandedFromMini ? t('minimize') : t('close');
            el['x'].setAttribute('aria-label', xLabel);
            el['x'].title = xLabel;
        }

        if (el.chips && !el.chips.childNodes.length) {
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
        if (el.chips) Array.prototype.forEach.call(el.chips.querySelectorAll('button[data-radius]'), function (button) {
            var on = Number(button.getAttribute('data-radius')) === dialog.radiusKm;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        });

        /* The scope switch: whole layers, or only the 1 km disc. */
        if (el.scopeGroup) {
            el.scopeGroup.innerHTML = '';
            SCOPES.forEach(function (scope) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'm3d-focus-scope-opt';
                button.setAttribute('data-scope', scope);
                button.textContent = scope === SCOPE_DISC
                    ? t('scopeDisc', { km: dialog.radiusKm })
                    : t('scopeFull');
                var on = dialog.scope === scope;
                button.classList.toggle('is-on', on);
                button.setAttribute('aria-pressed', on ? 'true' : 'false');
                el.scopeGroup.appendChild(button);
            });
        }

        /* The layer list: checkboxes — every LiDAR layer switched on on the 2D
         * map right now, so the user can choose which ones go into 3D (whole
         * layer) or into the 1 km disc. */
        el.layers.innerHTML = '';
        if (!dialog.layers.length) {
            var empty = document.createElement('p');
            empty.className = 'm3d-focus-empty';
            empty.textContent = t('layersEmpty');
            el.layers.appendChild(empty);
        }
        dialog.layers.forEach(function (entry) {
            var on = !!dialog.picks[entry.key];
            var label = document.createElement('label');
            label.className = 'm3d-focus-layer' + (on ? ' is-on' : '');
            var input = document.createElement('input');
            input.type = 'checkbox';
            input.name = 'm3d-focus-layer';
            input.value = entry.key;
            input.checked = on;
            input.addEventListener('change', function () {
                if (input.checked) dialog.picks[entry.key] = entry;
                else delete dialog.picks[entry.key];
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
        if (!dialog.layers.length) { el.estimate.textContent = ''; return; }
        var picks = pickedEntries();
        if (!picks.length) { el.estimate.textContent = t('pickNone'); return; }
        if (dialog.scope !== SCOPE_DISC) {
            /* No download, no zoom window: the promise is the layer itself. */
            el.estimate.textContent = [
                t('estimateWhole', { layers: picks.length }),
                t('estimateWholeNote', { km: dialog.radiusKm })
            ].join(' · ');
            return;
        }
        var plan = dialog.plan;
        if (!plan) { el.estimate.textContent = ''; return; }
        var lines = [];
        if (plan.route === 'canvas') {
            lines.push(t('estimateCanvas', { tiles: plan.count }));
        } else if (plan.plans.length > 1) {
            /* Several layers on one disc: the sum is what is downloaded, the
             * per-layer line below says how it splits. */
            lines.push(t('estimateMulti', { tiles: plan.count, size: humanSize(plan.bytes) }));
            lines.push(plan.plans.map(function (one) {
                return (one.layer && one.layer.label ? one.layer.label : one.focus.key) + ' ' + one.count;
            }).join(' · '));
        } else {
            lines.push(t('estimate', { tiles: plan.count, size: humanSize(plan.bytes) }));
        }
        if (plan.trimmed > 0) lines.push(t('estimateBig', { budget: plan.budget, z: plan.zoomTo }));
        lines.push('z' + plan.zoomFrom + '–' + plan.zoomTo);
        el.estimate.textContent = lines.join(' · ');
    }

    function showDialog(options) {
        options = options || {};
        var node = buildDialog();
        if (!node) return Promise.resolve({ cancelled: true, reason: 'no-map' });
        dialog.mode = options.mode === 'live' ? 'live' : 'gate';
        /* EVERY LiDAR layer that is switched on at this moment, so the list is
         * the whole choice the user has — not a subset of it. */
        dialog.layers = activeLayers();
        var previous = viewer() && viewer().getLidarFocus ? viewer().getLidarFocus() : null;
        /* What starts ticked: an explicit request, else the layers the previous
         * 3D entry was prepared for, else all of them. The unticked ones stay
         * in the list — the user can always add them back. */
        var wanted = [];
        if (Array.isArray(options.keys)) wanted = options.keys.slice();
        else if (options.key) wanted = [options.key];
        else if (previous) wanted = focusKeysOf(previous);
        dialog.picks = {};
        dialog.layers.forEach(function (entry) {
            var on = !wanted.length || wanted.some(function (key) { return entryAnswersKey(entry, key); });
            if (on) dialog.picks[entry.key] = entry;
        });
        if (!pickedEntries().length) {
            dialog.layers.forEach(function (entry) { dialog.picks[entry.key] = entry; });
        }
        dialog.chosen = pickedEntries()[0] || defaultLayer(dialog.layers);
        dialog.scope = normalScope(options.scope) || (previous && normalScope(previous.scope)) || lastScope;
        lastScope = dialog.scope;
        var previousRadius = previous ? (previous.mask ? previous.mask.radiusKm : previous.radiusKm) : null;
        dialog.radiusKm = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM,
            Number(options.radiusKm) || Number(previousRadius) || DEFAULT_RADIUS_KM));
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
            var labels = summary ? (summary.labels || [summary.label]).filter(Boolean) : [];
            var scopeText = '';
            if (summary) {
                scopeText = summary.scope === SCOPE_DISC
                    ? [summary.radiusKm + ' ' + t('km'),
                       summary.tiles != null ? t('miniTiles', { tiles: summary.tiles }) : ''].filter(Boolean).join(' · ')
                    : t('miniFull');
            }
            el.miniText.textContent = summary
                ? [labels.join(', '), scopeText].filter(Boolean).join(' · ')
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
    /**
     * Re-plan the disc for every ticked layer.
     *
     * The whole-layer scope prepares nothing, so it has no plan at all: the
     * decision it returns is the list of layers, and 3D asks them for tiles
     * exactly where the 2D map would. The disc scope produces one plan per
     * ticked layer — each layer has its own zoom window, native maximum, tile
     * route and budget — and they are aggregated into `dialog.plan` for the
     * estimate, the progress bar and status().
     */
    function refreshPlan(options) {
        options = options || {};
        dialog.chosen = pickedEntries()[0] || null;
        dialog.plans = [];
        if (options.restart) {
            /* The user changed something: whatever was decided before is void,
             * but the tiles already in memory stay (they are still correct). */
            dialog.report = null;
            if (dialog.el.progress) dialog.el.progress.setAttribute('hidden', 'hidden');
        }
        if (!dialog.chosen || !dialog.point || dialog.scope !== SCOPE_DISC) {
            dialog.plan = null;
            return null;
        }
        dialog.plans = pickedEntries().map(function (entry) {
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
            if (!plan) return null;
            plan.route = route;
            plan.layer = entry;
            plan.focus = focus;
            /* The prepared ceiling goes WITH the focus: the viewer caps the
             * raster source at it, so MapLibre can never ask for a zoom the
             * prefetch did not buy — it overzooms the prepared tiles instead of
             * showing the base map while the live fetch races the pinch. */
            focus.plan = { zoomFrom: plan.zoomFrom, zoomTo: plan.zoomTo, count: plan.count, route: route };
            var prepared = countPrepared(plan);
            plan.prepared = prepared;
            plan.pending = Math.max(0, plan.count - prepared);
            return plan;
        }).filter(Boolean);
        dialog.plan = aggregatePlans(dialog.plans);
        return dialog.plan;
    }

    /**
     * Several discs, one download: the sum of the per-layer plans, with the
     * fields the estimate, the progress bar and status() quote.
     */
    function aggregatePlans(plans) {
        plans = (plans || []).filter(Boolean);
        if (!plans.length) return null;
        var first = plans[0];
        var out = {
            plans: plans,
            route: plans.every(function (p) { return p.route === first.route; }) ? first.route : 'mixed',
            layer: first.layer,
            focus: first.focus,
            disc: first.disc,
            count: 0,
            bytes: 0,
            prepared: 0,
            pending: 0,
            trimmed: 0,
            budget: 0,
            zoomFrom: Infinity,
            zoomTo: 0,
            levels: [],
            tiles: []
        };
        plans.forEach(function (plan) {
            out.count += plan.count;
            out.bytes += plan.bytes;
            out.prepared += plan.prepared || 0;
            out.pending += plan.pending || 0;
            out.trimmed += plan.trimmed || 0;
            out.budget += plan.budget || 0;
            out.zoomFrom = Math.min(out.zoomFrom, plan.zoomFrom);
            out.zoomTo = Math.max(out.zoomTo, plan.zoomTo);
            out.levels = out.levels.concat(plan.levels || []);
            out.tiles = out.tiles.concat(plan.tiles || []);
        });
        if (!isFinite(out.zoomFrom)) out.zoomFrom = 0;
        return out;
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
            /* A canvas-route tile (the country products draw their own pixels)
             * has no URL of its own: the prefetch stores it under the deck key
             * dl2d://<key>/z/x/y — the very URL the 3D view will ask for. Asking
             * the cache with the un-substituted template ({z}/{x}/{y} still in
             * it) never matched anything, so these discs always reported “0
             * prepared” and the dialog offered a download it never needed. */
            if (!url && entry.key) url = 'dl2d://' + entry.key + '/' + tile.z + '/' + tile.x + '/' + tile.y;
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

    /**
     * Download a disc — one plan, or one plan per ticked layer.
     *
     * They share the same 1 km circle, so they are fetched as one queue: the
     * viewer's prefetch already takes a flat list of entries tagged with their
     * layer, and the progress bar counts the whole disc across all of them.
     * Entries of every layer are interleaved level by level, so the camera's
     * opening view is finished first whichever layers were chosen.
     */
    function prepare(plans, options) {
        options = options || {};
        var api = viewer();
        var list = (Array.isArray(plans) ? plans : [plans]).filter(Boolean);
        var empty = { total: 0, done: 0, prepared: 0, failed: 0, stopped: false, errors: [] };
        if (!list.length || !api || typeof api.prefetchTiles !== 'function') {
            return Promise.resolve(empty);
        }
        var perLayer = list.map(function (plan) { return planEntries(plan); });
        var entries = interleave(perLayer);
        if (!entries.length) return Promise.resolve(empty);
        list.forEach(function (plan, at) { plan.count = perLayer[at].length; });
        var started = Date.now();
        return api.prefetchTiles(entries, {
            concurrency: Number(options.concurrency) || (LIMITS.concurrency || 0),
            shouldStop: function () { return !!dialog.stop; },
            onProgress: function (report) {
                if (typeof options.onProgress === 'function') options.onProgress(report);
            }
        }).then(function (report) {
            report.ms = Date.now() - started;
            lastPrep = { plan: list[0], plans: list, report: report, startedAt: started };
            return report;
        });
    }

    /** Round-robin the per-layer queues, so no layer waits for another. */
    function interleave(queues) {
        var out = [];
        var longest = 0;
        (queues || []).forEach(function (queue) { longest = Math.max(longest, queue.length); });
        for (var at = 0; at < longest; at += 1) {
            (queues || []).forEach(function (queue) { if (queue[at]) out.push(queue[at]); });
        }
        return out;
    }

    /* ── what the buttons do ────────────────────────────────────────────── */
    function applyFocus(focus) {
        var api = viewer();
        if (!api || typeof api.setLidarFocus !== 'function') return null;
        if (focus && normalScope(focus.scope) === SCOPE_DISC) {
            /* Whatever asks for a disc (the dialog, a restored focus, the 3D
             * bar), it can never ask for more than the entry rule allows. */
            focus.radiusKm = Math.max(MIN_RADIUS_KM, Math.min(MAX_RADIUS_KM,
                Number(focus.radiusKm) || DEFAULT_RADIUS_KM));
            if (focus.mask) {
                focus.mask.radiusKm = focus.radiusKm;
                focus.mask.lat = Number(focus.lat != null ? focus.lat : focus.mask.lat);
                focus.mask.lng = Number(focus.lng != null ? focus.lng : focus.mask.lng);
            }
            delete focus.bounds;            /* derived again by the viewer */
        }
        var applied = api.setLidarFocus(focus);
        /* A whole-layer focus has no area to outline — and a leftover disc
         * from an earlier entry must not stay on the 2D map claiming one. */
        if (focus && normalScope(focus.scope) === SCOPE_DISC) drawDisc(focus, { fill: true });
        else clearDisc();
        return applied;
    }

    /**
     * The decision itself, in the shape js/map3d-terrain.js reads:
     *
     *   { scope, layers: [ { key, lidarKey, defId, label, plan? } ],
     *     key, lidarKey, defId, label, labels,          // the first layer
     *     mask, lat, lng, radiusKm, plan }              // disc only
     */
    function buildFocus(entries, disc) {
        var list = (entries || []).map(function (entry, at) {
            var plan = disc && dialog.plans[at] ? dialog.plans[at] : null;
            var item = {
                key: entry.key,
                lidarKey: entry.lidarKey || null,
                defId: entry.defId || null,
                label: entry.label
            };
            if (plan) {
                item.plan = { zoomFrom: plan.zoomFrom, zoomTo: plan.zoomTo, count: plan.count, route: plan.route };
            }
            return item;
        });
        if (!list.length) return null;
        var focus = {
            scope: disc ? SCOPE_DISC : SCOPE_FULL,
            layers: list,
            key: list[0].key,
            lidarKey: list[0].lidarKey,
            defId: list[0].defId,
            label: list[0].label,
            labels: list.map(function (layer) { return layer.label; })
        };
        if (disc) {
            focus.lat = Number(dialog.point.lat);
            focus.lng = Number(dialog.point.lng);
            focus.radiusKm = Number(dialog.radiusKm);
            focus.mask = { lat: focus.lat, lng: focus.lng, radiusKm: focus.radiusKm };
            if (list[0].plan) focus.plan = list[0].plan;
        }
        return focus;
    }

    function confirmDialog() {
        if (dialog.preparing) return;
        var picks = pickedEntries();
        if (!picks.length) { paintDialog(); return; }

        /* ── WHOLE LAYERS ───────────────────────────────────────────────────
         * Nothing is downloaded in advance and nothing is bounded: the 3D view
         * asks the 2D layers for whatever it is looking at, exactly like the
         * 2D map does. The decision is the list itself. */
        if (dialog.scope !== SCOPE_DISC) {
            var whole = buildFocus(picks, false);
            try {
                applyFocus(whole);
            } catch (error) {
                dialog.el.estimate.textContent = String((error && error.message) || error);
                return;
            }
            lastScope = SCOPE_FULL;
            dialog.miniSummary = {
                labels: whole.labels,
                scope: SCOPE_FULL,
                radiusKm: null,
                tiles: null
            };
            settle({ cancelled: false, focus: whole, report: null }, { minimize: true });
            return;
        }

        /* ── ONLY 1 KM ──────────────────────────────────────────────────────
         * One plan per ticked layer, downloaded together. */
        var plan = (dialog.plan && dialog.plans.length) ? dialog.plan : refreshPlan({});
        if (!plan || !plan.count || !dialog.plans.length) {
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
        var focus = buildFocus(picks, true);
        try {
            applyFocus(focus);
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

        prepare(dialog.plans, {
            onProgress: function (report) { renderProgress(report); }
        }).then(function (report) {
            dialog.report = report;
            dialog.preparing = false;
            var prepared = report.prepared || 0;
            var failed = report.failed || 0;
            lastScope = SCOPE_DISC;
            focus.preparedTiles = prepared;
            focus.failedTiles = failed;
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
                 * this disc: layers, fetching distance, tiles prepared. */
                dialog.miniSummary = {
                    labels: focus.labels || [focus.label || 'LiDAR'],
                    scope: SCOPE_DISC,
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
            /* No LiDAR on the 2D map: 3D opens exactly as it always did.
             * If a stale yellow point/disc was left over from an earlier LiDAR
             * session, remove it now so the 3D camera does not teleport to it. */
            try { if (api && api.getLidarFocus && api.getLidarFocus()) api.clearLidarFocus(); } catch (e2) {}
            try { clearDisc(); } catch (e3) {}
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
            scopes: SCOPES.slice(),
            defaultScope: DEFAULT_SCOPE,
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
                scope: dialog.scope,
                /* Every layer offered, and which of them are ticked. */
                offered: dialog.layers.map(function (entry) { return entry.key; }),
                picks: Object.keys(dialog.picks),
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
            /* The same disc, layer by layer: which layer, how many tiles, and
             * the zoom ceiling its own source will be capped at. */
            plans: dialog.plans.map(function (plan) {
                return {
                    key: plan.layer ? plan.layer.key : (plan.focus && plan.focus.key) || null,
                    label: plan.layer ? plan.layer.label : '',
                    route: plan.route,
                    count: plan.count,
                    prepared: plan.prepared,
                    pending: plan.pending,
                    zoomFrom: plan.zoomFrom,
                    zoomTo: plan.zoomTo
                };
            }),
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
        SCOPES: SCOPES,
        DEFAULT_SCOPE: DEFAULT_SCOPE,
        activeLayers: activeLayers,
        status: status,
        plan: planDisc,
        planEntries: planEntries,
        prepare: prepare,
        buildFocus: buildFocus,
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
        document.addEventListener('detectlab:lidar-visibility-changed', syncDiscWithLidarState);
        document.addEventListener('detectlab:langchange', function () {
            if (dialog.open) paintDialog();
            if (dialog.minimized) paintMinimized();
        });
        /* Keep the 2D disc in sync with the actual LiDAR visibility: if the
         * yellow point was left over after LiDAR was disabled, it must disappear
         * and the 3D view must not teleport to the old disc. */
        attachLidarWatcher();
        root.setTimeout(attachLidarWatcher, 800);
        root.setTimeout(syncDiscWithLidarState, 600);
        /* A disc already decided (the 3D view restored it) is drawn in 2D too,
         * but only if that LiDAR layer is still active in 2D. */
        var restored = viewer().getLidarFocus && viewer().getLidarFocus();
        if (restored) {
            var restoredKeys = focusKeysOf(restored);
            var stillActive = activeLayers().some(function (entry) {
                return restoredKeys.some(function (key) { return entryAnswersKey(entry, key); });
            });
            /* A whole-layer focus has no disc to draw; a disc restores its
             * outline only while at least one of its layers is still on the map. */
            if (stillActive && normalScope(restored.scope) === SCOPE_DISC) drawDisc(restored, { fill: true });
            else if (!stillActive) {
                /* Stale focus from a previous session whose LiDAR is no longer
                 * on the 2D map: clear it so a new 3D entry at a different
                 * location does not teleport back to the old disc. */
                try { if (viewer().clearLidarFocus) viewer().clearLidarFocus(); } catch (e2) {}
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', whenReady);
    } else {
        whenReady();
    }
}(typeof window !== 'undefined' && window ? window : null,
  typeof document !== 'undefined' ? document : null));
