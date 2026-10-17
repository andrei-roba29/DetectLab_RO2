/*
 * js/finland-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · the Finnish layers (MML · Museovirasto · SYKE · Åland · local)
 *
 * What this file does — and what it deliberately does not do
 *   It reads js/finland-layers.config.js and turns every entry into a panel
 *   row and a Leaflet layer. It holds no layer definitions of its own: adding,
 *   removing, re-labelling or re-zoom-limiting a layer is a change to the
 *   CONFIG file only. The shared registry (js/layer-registry.js) mirrors the
 *   same config into the catalogue for the diagnostics and the audits.
 *
 * Projection strategy (the repo carries no proj4 — see the config header)
 *   • tm35-wmts (MML hillshade, museoverkko maastokartta): the services
 *     publish the national ETRS-TM35FIN TileMatrixSet (EPSG:3067). Every
 *     destination tile is drawn on a canvas by mosaicking the source tiles
 *     that cover it and warping them through a mesh — the exact machinery of
 *     the Danish DHM layer (js/dataforsyningen-dhm-layer.js), re-pointed at
 *     EPSG:3067 via js/finland-tm35.js (UTM zone 35N on GRS80).
 *   • mvt (MML HKP cadastral tiles): Mapbox Vector Tiles on the same TM35FIN
 *     grid, decoded with the same finland-tm35.js decoder and re-drawn vertex
 *     by vertex onto canvas tiles in EPSG:3857.
 *   • wms (SYKE): per-tile WMS 1.1.1 GetMap with the tile's own EPSG:3857
 *     extent (the Albanian pattern — GeoServer reprojects server-side; the
 *     browser only needs plain <img> tiles, so no CORS is involved).
 *   • arcgis (Åland): the REST /export endpoint renders EPSG:3857 tiles
 *     directly; identify uses f=geojson queries around the click.
 *   • wfs (museoverkko GetWFSFeatures): GeoJSON in EPSG:4326, one debounced
 *     bbox query per view (the Danish heritage pattern — AbortController,
 *     minZoom gate with a “zoom in” status, proxy fallback, feature cap).
 *   • geojson (local Supabase conversions): plain L.geoJSON, repo copy first,
 *     Supabase mirror second, an honest “not converted yet” status if neither
 *     exists.
 *
 * Panel behaviour
 *   • master switch + one collapsible section per group (Terrain, Cadastral,
 *     Protected sites, Åland, Local files); each section header carries its
 *     own “all on/off” checkbox, so “Cadastral” is one toggle with
 *     sub-toggles exactly as requested;
 *   • the register categories inside “Protected sites” are collapsible
 *     sub-sections with a colour swatch each;
 *   • every row: checkbox, ⓘ description, opacity slider, status line
 *     (loading / zoom-in hint / errors + retry);
 *   • rows are keyboard-operable and carry aria-hidden for the country
 *     filter, like the Albanian rows.
 *
 * Laziness
 *   Nothing is requested until a row is switched on. The WFS families only
 *   fetch above their minZoom, and then one bbox per settled view.
 *
 * Failure handling
 *   A raster tile that fails falls back to a transparent pixel; repeated
 *   failures switch the layer from direct to the same-origin proxy
 *   (/api/geo/finland) and redraw; persistent failures surface in the row
 *   with a Retry control. Blocked/duplicate layers keep their rows with an
 *   explanation instead of disappearing.
 *
 * No build step. Dependencies: Leaflet 1.x, js/finland-tm35.js (loaded first).
 */
(function (window, document) {
    'use strict';

    var CONFIG = window.FINLAND_LAYERS_CONFIG || window.FINLAND_LAYERS;
    if (!CONFIG || !Array.isArray(CONFIG.layers) || !CONFIG.layers.length) {
        if (window.console) {
            window.console.warn('[Finland] js/finland-layers.config.js is missing — ' +
                'the Finnish layers are not available.');
        }
        return;
    }

    var L = window.L;
    var TM = window.FinlandTM35;
    if (!L) {
        if (window.console) {
            window.console.error('[Finland] Leaflet is not loaded — finland-layers.js must load after leaflet.js');
        }
        return;
    }
    if (!TM || typeof TM.UTM35 !== 'object' || typeof TM.mvtDecode !== 'function') {
        if (window.console) {
            window.console.error('[Finland] js/finland-tm35.js is missing — ' +
                'the Finnish layers need its EPSG:3067 maths and MVT decoder.');
        }
        return;
    }

    /* ── constants ────────────────────────────────────────────────────────── */

    var LAYERS = CONFIG.enabledLayers();
    var GROUP_ROW_ID = 'finlandRow';
    var SUB_CONTAINER_ID = 'finlandSubLayers';
    var GROUP_NOTICE_ID = 'finlandGroupNotice';
    var STORE_KEY = 'detectlab_finland_layers_v1';
    var MASTER_ID = 'finlandToggle';

    /* Panes: the Finnish stack sits above the Albanian rasters (z405) and
     * the Danish rasters (z406) — the countries never overlap — and below
     * every app-wide data pane. Vectors above rasters. */
    var PANE_RASTER = 'pane_finland_raster';
    var PANE_VECTOR = 'pane_finland_vector';
    var Z_RASTER = 408;
    var Z_VECTOR = 409;

    var WFS_DEBOUNCE_MS = 400;
    var WFS_FEATURE_CAP = 1500;      /* per layer, per view */
    var PROXY_AFTER_ERRORS = 3;      /* direct → proxy switch */

    /* Transparent 1×1 PNG — Leaflet's errorTileUrl and the blank source
     * squares of the mosaics (see the Danish DHM layer). */
    var BLANK_TILE = 'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    var PROXY_PATH = (CONFIG.proxy && CONFIG.proxy.path) || '/api/geo/finland';

    /* ── small helpers ────────────────────────────────────────────────────── */

    function round(n, digits) {
        var f = Math.pow(10, digits === undefined ? 4 : digits);
        return Math.round(n * f) / f;
    }

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ── language (the app's own rule: Romanian in the Romanian UI) ───────── */

    function lang() {
        try {
            if (typeof window._currentLang === 'function') return String(window._currentLang() || 'en');
        } catch (e) { /* translations not loaded yet */ }
        var htmlLang = document.documentElement && document.documentElement.getAttribute('lang');
        return String(htmlLang || 'en');
    }

    function tr(pair) {
        if (!pair) return '';
        if (typeof pair === 'string') return pair;
        var l = lang().toLowerCase();
        if (l.indexOf('ro') === 0) return pair.ro || pair.en || pair.fi || '';
        return pair.en || pair.ro || pair.fi || '';
    }

    var TEXT = {
        opacity: { ro: 'Opacitate', en: 'Opacity' },
        loading: { ro: 'se încarcă…', en: 'loading…' },
        loadingTiles: { ro: 'dală se încarcă…', en: 'loading tiles…' },
        zoomIn: { ro: 'măriți zoom-ul (min z', en: 'zoom in to see this layer (min z' },
        zoomInShort: { ro: 'măriți zoom-ul pentru restul', en: 'zoom in for the rest' },
        truncated: { ro: 'se arată doar primele', en: 'only the first' },
        shown: { ro: 'obiecte afișate', en: 'features shown' },
        unavailable: { ro: 'sursa nu răspunde', en: 'the source is not answering' },
        proxying: { ro: 'se trece prin proxy-ul site-ului…', en: 'retrying through the site proxy…' },
        retry: { ro: 'Reîncearcă', en: 'Retry' },
        directFailed: { ro: 'cererea directă a eșuat', en: 'the direct request failed' },
        notConverted: { ro: 'neconvertit încă', en: 'not converted yet' },
        blocked: { ro: 'blocat la sursă', en: 'blocked at the source' },
        group: { ro: 'Grup', en: 'Group' },
        finnishName: { ro: 'Denumirea originală (finlandeză)', en: 'Finnish original name' },
        expand: { ro: 'Extinde/restrânge', en: 'Expand/Collapse' }
    };

    /* ── state ────────────────────────────────────────────────────────────── */

    var runtime = {
        ready: false,
        map: null,
        panes: false,
        built: {},          /* id → Leaflet layer                              */
        active: {},         /* id → true when on the map                       */
        opacity: {},        /* id → 0–100                                      */
        rows: {},           /* id → { row, input, slider, pct, status }        */
        notices: {},        /* id → { text, kind }                             */
        expanded: false,    /* the whole accordion                             */
        expandedSections: {},   /* section id → boolean                        */
        tileMode: {},       /* id → 'direct' | 'proxy' (tiles)                 */
        wfs: {},            /* id → { running, dirty, controller, last, mode, count } */
        zoomHints: {}       /* id → true while the zoom hint is shown          */
    };

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
                expanded: runtime.expanded,
                expandedSections: runtime.expandedSections
            }));
        } catch (e) { /* private mode */ }
    }

    function applyStored() {
        var saved = persisted() || {};
        var savedActive = saved.active || {};
        var savedOpacity = saved.opacity || {};
        LAYERS.forEach(function (layer) {
            runtime.opacity[layer.id] = Math.round(
                typeof layer.opacity === 'number' ? layer.opacity * 100 : 100);
            runtime.tileMode[layer.id] = 'direct';
            if (typeof savedOpacity[layer.id] === 'number') runtime.opacity[layer.id] = savedOpacity[layer.id];
            if (typeof savedActive[layer.id] === 'boolean') runtime.active[layer.id] = savedActive[layer.id];
        });
        if (typeof saved.expanded === 'boolean') runtime.expanded = saved.expanded;
        runtime.expandedSections = saved.expandedSections || {};
    }

    function getMap() {
        return window._dlMap || window.map || null;
    }

    function ensurePanes(map) {
        if (runtime.panes || !map || !map.createPane) return;
        [[PANE_RASTER, Z_RASTER], [PANE_VECTOR, Z_VECTOR]].forEach(function (def) {
            var pane = map.getPane && map.getPane(def[0]);
            if (!pane) pane = map.createPane(def[0]);
            pane.style.zIndex = def[1];
        });
        runtime.panes = true;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 1. URL BUILDERS (pure — exported for the registry mirror and tests)
     * ═══════════════════════════════════════════════════════════════════════ */

    /** TM35FIN raster tile URL (hillshade / maastokartta), direct or proxied. */
    function tm35TileUrl(layerDef, level, col, row, proxied) {
        if (proxied) {
            return PROXY_PATH + '?src=' + encodeURIComponent(layerDef.proxySrc || 'mml-hillshade') +
                '&z=' + level + '&col=' + col + '&row=' + row;
        }
        return String(layerDef.urlTemplate || '')
            .replace('{z}', level).replace('{col}', col).replace('{row}', row);
    }

    /** HKP MVT tile URL (x=TileCol, y=TileRow, z=TileMatrix). */
    function mvtTileUrl(layerDef, level, col, row, proxied) {
        if (proxied) {
            return PROXY_PATH + '?src=hkp-tile&id=' + layerDef.hkpId +
                '&x=' + col + '&y=' + row + '&z=' + level;
        }
        return CONFIG.endpoints.hkpTiles + '?action_route=GetLayerTile' +
            '&id=' + layerDef.hkpId + '&x=' + col + '&y=' + row + '&z=' + level;
    }

    /** SYKE WMS 1.1.1 GetMap for one tile (the Albanian pattern). */
    function wmsTileUrl(layerDef, bbox, size, crs) {
        var service = CONFIG.WMS_SERVICES[layerDef.service] || {};
        var base = String(service.url || '');
        var useCrs = crs || layerDef.crs || 'EPSG:3857';
        var digits = (useCrs === 'EPSG:4326') ? 7 : 4;
        var params = [
            'SERVICE=WMS',
            'VERSION=' + encodeURIComponent(layerDef.version || '1.1.1'),
            'REQUEST=GetMap',
            'LAYERS=' + encodeURIComponent(layerDef.layers),
            'STYLES=',
            'SRS=' + encodeURIComponent(useCrs),
            'BBOX=' + bbox.map(function (v) { return round(v, digits); }).join(','),
            'WIDTH=' + size,
            'HEIGHT=' + size,
            'FORMAT=' + encodeURIComponent(layerDef.format || 'image/png'),
            'TRANSPARENT=' + (layerDef.transparent === false ? 'FALSE' : 'TRUE')
        ];
        return base + '?' + params.join('&');
    }

    /** SYKE proxy passthrough (GetFeatureInfo / WFS GetFeature). */
    function sykeProxyUrl(fullUrl) {
        return PROXY_PATH + '?src=syke&url=' + encodeURIComponent(fullUrl);
    }

    /** Åland REST export URL for one Web-Mercator tile (f=image → PNG). */
    function alandTileUrl(layerDef, bbox, size) {
        return CONFIG.endpoints.alandRest + '/' + layerDef.restService + '/export' +
            '?bbox=' + bbox.map(function (v) { return round(v, 2); }).join(',') +
            '&bboxSR=3857&layers=show:' + layerDef.layerId +
            '&size=' + size + ',' + size +
            '&format=png&transparent=true&f=image';
    }

    /** Åland REST query URL around a click (returns GeoJSON). */
    function alandQueryUrl(layerDef, bounds) {
        return CONFIG.endpoints.alandRest + '/' + layerDef.restService + '/' + layerDef.layerId + '/query' +
            '?f=geojson&geometryType=esriGeometryEnvelope' +
            '&geometry=' + encodeURIComponent('{"xmin":' + round(bounds[0], 6) + ',"ymin":' + round(bounds[1], 6) +
                ',"xmax":' + round(bounds[2], 6) + ',"ymax":' + round(bounds[3], 6) + '}') +
            '&inSR=4326&spatialRel=esriSpatialRelIntersects' +
            '&returnGeometry=true&outFields=*&outSR=4326';
    }

    /** museoverkko GetWFSFeatures URL for one bbox (EPSG:4326, w,s,e,n). */
    function wfsUrl(layerDef, bbox, proxied) {
        var b = bbox.map(function (v) { return round(v, 6); }).join(',');
        if (proxied) {
            return PROXY_PATH + '?src=museo-wfs&id=' + layerDef.wfsId + '&bbox=' + b;
        }
        return CONFIG.endpoints.museoWfs + '?action_route=GetWFSFeatures' +
            '&id=' + layerDef.wfsId + '&srs=EPSG:4326&bbox=' + b;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 2. TM35FIN RASTER LAYER (hillshade · maastokartta) — canvas warp
     * ═══════════════════════════════════════════════════════════════════════ */

    var MERC_HALF = 20037508.342789244;
    var MERC_R = 6378137;

    function mercatorLat(y) { return (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180 / Math.PI; }
    function mercatorLon(x) { return x / MERC_R * 180 / Math.PI; }
    function webMercatorResolution(zoom, tileSize) {
        return (2 * MERC_HALF) / ((tileSize || 256) * Math.pow(2, zoom));
    }

    function invertAffine(a, b, c, d, e, f) {
        var det = a * d - c * b;
        if (!det || !isFinite(det)) return null;
        var A = d / det, B = -b / det, C = -c / det, D = a / det;
        return [A, B, C, D, -(A * e + C * f), -(B * e + D * f)];
    }

    /* Source-tile loader: small LRU + in-flight de-duplication, plain <img>
     * so no CORS is needed (the Danish DHM loader, verbatim in spirit). */
    var sourceCache = new window.Map ? new window.Map() : {};
    function cacheGet(url) {
        if (sourceCache.get) {
            var hit = sourceCache.get(url);
            if (hit) { sourceCache.delete(url); sourceCache.set(url, hit); }
            return hit;
        }
        return sourceCache[url] || null;
    }
    function cacheSet(url, promise) {
        if (sourceCache.size !== undefined && typeof sourceCache.delete === 'function') {
            if (sourceCache.size >= 96) sourceCache.delete(sourceCache.keys().next().value);
            sourceCache.set(url, promise);
        } else {
            sourceCache[url] = promise;
        }
    }
    function cacheDelete(url) {
        if (sourceCache.delete) sourceCache.delete(url);
        else delete sourceCache[url];
    }
    function clearSourceCache() {
        if (sourceCache.clear) sourceCache.clear();
        else sourceCache = {};
    }

    function loadSourceTile(url) {
        var hit = cacheGet(url);
        if (hit) return hit;
        var promise = new window.Promise(function (resolve) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { cacheDelete(url); resolve(null); };
            img.src = url;
        });
        cacheSet(url, promise);
        return promise;
    }

    var FinlandTm35RasterLayer = L.GridLayer.extend({
        options: {
            tileSize: 256,
            keepBuffer: 2,
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true,
            errorTileUrl: BLANK_TILE,
            crossOrigin: false    /* plain <img> mosaics need no CORS */
        },

        initialize: function (layerDef, options) {
            this._layerDef = layerDef;
            this._failCount = 0;
            this._warned = false;
            this._announcedUnavailable = false;
            L.setOptions(this, options || {});
            if (!this.options.bounds) this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            this.options.minZoom = layerDef.minZoom;
            this.options.maxZoom = layerDef.maxZoom;
            this.options.maxNativeZoom = layerDef.maxNativeLevel + 3;  /* upscale only */
            L.GridLayer.prototype.initialize.call(this, this.options);
        },

        createTile: function (coords, done) {
            var size = this.getTileSize();
            var canvas = document.createElement('canvas');
            canvas.width = size.x;
            canvas.height = size.y;
            canvas.setAttribute('role', 'presentation');
            var self = this;
            this._renderTile(canvas, coords, size).then(function (drew) {
                if (canvas._dlCancelled) return;
                if (!drew) self._noteTileGap();
                done(null, canvas);
            })['catch'](function (err) {
                if (canvas._dlCancelled) return;
                self._noteTileGap(err);
                done(null, canvas);
            });
            return canvas;
        },

        _renderTile: function (canvas, coords, size) {
            var layerDef = this._layerDef;
            var tileSize = size.x;
            var mesh = 8;                 /* 8×8 cells: sub-pixel warp error */
            var proxied = runtime.tileMode[layerDef.id] === 'proxy';

            /* (a) destination tile bounds in EPSG:3857 metres */
            var res = webMercatorResolution(coords.z, tileSize);
            var x0 = -MERC_HALF + coords.x * tileSize * res;
            var y0 = MERC_HALF - coords.y * tileSize * res;

            /* (b) mesh nodes → EPSG:3067 */
            var nodes = new Array((mesh + 1) * (mesh + 1));
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            var i, j, px, py, en;
            for (j = 0; j <= mesh; j++) {
                for (i = 0; i <= mesh; i++) {
                    px = (i / mesh) * tileSize;
                    py = (j / mesh) * tileSize;
                    en = TM.UTM35.forward(mercatorLat(y0 - py * res), mercatorLon(x0 + px * res));
                    nodes[j * (mesh + 1) + i] = en;
                    if (en[0] < minX) minX = en[0];
                    if (en[0] > maxX) maxX = en[0];
                    if (en[1] < minY) minY = en[1];
                    if (en[1] > maxY) maxY = en[1];
                }
            }
            if (!isFinite(minX) || !isFinite(minY)) return window.Promise.resolve(false);

            /* outside Finland's TM35FIN coverage → nothing to draw */
            var ext = TM.GRID.EXTENT || [-548576, 6291456, 1548576, 8388608];
            if (maxX < ext[0] || minX > ext[2] || maxY < ext[1] || minY > ext[3]) {
                return window.Promise.resolve(false);
            }

            /* (c) the source level that matches the needed resolution */
            var mid = Math.floor(mesh / 2);
            var left = nodes[mid * (mesh + 1)], right = nodes[mid * (mesh + 1) + mesh];
            var top = nodes[mid], bottom = nodes[mesh * (mesh + 1) + mid];
            var needed = Math.min(
                Math.hypot(right[0] - left[0], right[1] - left[1]),
                Math.hypot(bottom[0] - top[0], bottom[1] - top[1])) / tileSize;
            var level = TM.levelForResolution(needed);
            if (layerDef.maxNativeLevel !== undefined) {
                level = Math.min(level, layerDef.maxNativeLevel);
            }

            /* (d) source tiles covering the node bbox, stepping coarser if
             *     the count explodes (the Danish safeguard) */
            var srcRes, span, c0, c1, r0, r1, count, m;
            for (;;) {
                srcRes = TM.GRID.resolution(level);
                span = srcRes * 256;
                c0 = Math.floor((minX - TM.GRID.origin[0]) / span);
                c1 = Math.floor((maxX - TM.GRID.origin[0]) / span);
                r0 = Math.floor((TM.GRID.origin[1] - maxY) / span);
                r1 = Math.floor((TM.GRID.origin[1] - minY) / span);
                count = (c1 - c0 + 1) * (r1 - r0 + 1);
                if (count <= 12 || level === 0) break;
                level--;
            }
            m = TM.GRID.matrixSize(level);
            c0 = Math.max(0, c0); r0 = Math.max(0, r0);
            c1 = Math.min(m[0] - 1, c1); r1 = Math.min(m[1] - 1, r1);
            if (c1 < c0 || r1 < r0) return window.Promise.resolve(false);

            /* (e) fetch + mosaic + warp */
            var self = this;
            var jobs = [], col, rw;
            for (rw = r0; rw <= r1; rw++) {
                for (col = c0; col <= c1; col++) {
                    jobs.push({
                        col: col, row: rw,
                        promise: loadSourceTile(tm35TileUrl(layerDef, level, col, rw, proxied))
                    });
                }
            }
            return window.Promise.all(jobs.map(function (t) { return t.promise; }))
                .then(function (images) {
                    if (canvas._dlCancelled) return false;
                    if (!images.some(Boolean)) {
                        self._noteTileFailures();
                        return false;
                    }
                    var st = 256;
                    var mosaic = document.createElement('canvas');
                    mosaic.width = (c1 - c0 + 1) * st;
                    mosaic.height = (r1 - r0 + 1) * st;
                    var mctx = mosaic.getContext('2d');
                    images.forEach(function (img, k) {
                        if (img) mctx.drawImage(img, (jobs[k].col - c0) * st, (jobs[k].row - r0) * st);
                    });
                    self._warpMesh(canvas, mosaic, nodes, mesh, tileSize,
                        TM.GRID.origin[0] + c0 * span, TM.GRID.origin[1] - r0 * span, srcRes);
                    self._noteTileSuccess();
                    return true;
                });
        },

        _warpMesh: function (canvas, mosaic, nodes, mesh, tileSize, originX, originY, srcRes) {
            var ctx = canvas.getContext('2d');
            var cell = tileSize / mesh;
            ctx.globalAlpha = Math.max(0, Math.min(1, runtime.opacity[this._layerDef.id] / 100));
            ctx.imageSmoothingEnabled = true;
            if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

            function sourcePx(node) {
                return [(node[0] - originX) / srcRes, (originY - node[1]) / srcRes];
            }
            for (var j = 0; j < mesh; j++) {
                for (var i = 0; i < mesh; i++) {
                    var s00 = sourcePx(nodes[j * (mesh + 1) + i]),
                        s10 = sourcePx(nodes[j * (mesh + 1) + i + 1]),
                        s01 = sourcePx(nodes[(j + 1) * (mesh + 1) + i]);
                    var dx0 = i * cell, dy0 = j * cell;
                    var a = (s10[0] - s00[0]) / cell, c = (s01[0] - s00[0]) / cell,
                        b = (s10[1] - s00[1]) / cell, d = (s01[1] - s00[1]) / cell,
                        e = s00[0] - a * dx0 - c * dy0,
                        f = s00[1] - b * dx0 - d * dy0,
                        t = invertAffine(a, b, c, d, e, f);
                    if (!t) continue;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(dx0 - 0.5, dy0 - 0.5, cell + 1, cell + 1);
                    ctx.clip();
                    ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
                    ctx.drawImage(mosaic, 0, 0);
                    ctx.restore();
                }
            }
        },

        /* diagnostics: proxy switch + row status, one warning per layer */
        _noteTileGap: function () {
            if (!this._warned) {
                this._warned = true;
                if (window.console) {
                    window.console.warn('[Finland] a ' + this._layerDef.id +
                        ' source tile was unavailable; further gaps are silent');
                }
            }
        },
        _noteTileFailures: function () {
            var id = this._layerDef.id;
            this._failCount += 1;
            if (runtime.tileMode[id] === 'direct' && this._failCount >= PROXY_AFTER_ERRORS) {
                runtime.tileMode[id] = 'proxy';
                this._failCount = 0;
                setStatus(id, tr(TEXT.proxying), 'warn');
                if (window.console) {
                    window.console.warn('[Finland] ' + id +
                        ': switching to the site proxy after repeated direct failures');
                }
                this.redraw();
                return;
            }
            if (runtime.tileMode[id] === 'proxy' && this._failCount >= PROXY_AFTER_ERRORS) {
                this._failCount = 0;
                if (!this._announcedUnavailable) {
                    this._announcedUnavailable = true;
                    setStatus(id, tr(TEXT.unavailable) + ' — ' + this._layerDef.statusNote, 'error', true);
                }
            }
        },
        _noteTileSuccess: function () {
            this._failCount = 0;
            var id = this._layerDef.id;
            var notice = runtime.notices[id];
            if (notice && notice.kind !== 'info-zoom') clearStatus(id);
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * 3. SYKE WMS LAYER — per-tile GetMap in EPSG:3857 (Albanian pattern)
     * ═══════════════════════════════════════════════════════════════════════ */

    var FinlandWmsLayer = L.TileLayer.extend({
        options: {
            tileSize: 256,
            keepBuffer: 2,
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true,
            errorTileUrl: BLANK_TILE,
            crossOrigin: false
        },

        initialize: function (layerDef, options) {
            this._layerDef = layerDef;
            this._errorCount = 0;
            this._warned = false;
            this._announced = false;
            L.setOptions(this, options || {});
            if (!this.options.bounds) this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            this.options.minZoom = layerDef.minZoom;
            this.options.maxZoom = layerDef.maxZoom;
            this.options.maxNativeZoom = layerDef.maxNativeZoom || 18;
            L.TileLayer.prototype.initialize.call(this, '', this.options);
        },

        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var size = this.getTileSize().x;
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
            var crs = (this._map && this._map.options.crs) || L.CRS.EPSG3857;
            var swP = crs.project(sw), neP = crs.project(ne);
            return wmsTileUrl(this._layerDef, [swP.x, swP.y, neP.x, neP.y], size, 'EPSG:3857');
        },

        onAdd: function (map) {
            L.TileLayer.prototype.onAdd.call(this, map);
            this.on('tileerror', this._onTileError, this);
            this.on('tileload', this._onTileLoad, this);
        },
        onRemove: function (map) {
            this.off('tileerror', this._onTileError, this);
            this.off('tileload', this._onTileLoad, this);
            L.TileLayer.prototype.onRemove.call(this, map);
        },
        _onTileLoad: function () { this._errorCount = 0; },
        _onTileError: function () {
            this._errorCount += 1;
            if (!this._warned) {
                this._warned = true;
                if (window.console) {
                    window.console.warn('[Finland] a ' + this._layerDef.id +
                        ' tile could not be loaded; further failures are silent');
                }
            }
            if (this._errorCount >= PROXY_AFTER_ERRORS && !this._announced) {
                this._announced = true;
                setStatus(this._layerDef.id, tr(TEXT.unavailable), 'error', true);
            }
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * 4. ÅLAND ARCGIS LAYER — REST /export tiles + click queries
     * ═══════════════════════════════════════════════════════════════════════ */

    var FinlandArcgisLayer = L.TileLayer.extend({
        options: {
            tileSize: 256,
            keepBuffer: 2,
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true,
            errorTileUrl: BLANK_TILE,
            crossOrigin: false
        },

        initialize: function (layerDef, options) {
            this._layerDef = layerDef;
            this._errorCount = 0;
            this._warned = false;
            this._announced = false;
            L.setOptions(this, options || {});
            if (!this.options.bounds) {
                /* Åland only — tighter than the country bounds. */
                this.options.bounds = L.latLngBounds([[59.5, 19.0], [60.8, 21.5]]);
            }
            this.options.minZoom = layerDef.minZoom;
            this.options.maxZoom = layerDef.maxZoom;
            this.options.maxNativeZoom = layerDef.maxNativeZoom || 19;
            L.TileLayer.prototype.initialize.call(this, '', this.options);
        },

        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var size = this.getTileSize().x;
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
            var crs = (this._map && this._map.options.crs) || L.CRS.EPSG3857;
            var swP = crs.project(sw), neP = crs.project(ne);
            return alandTileUrl(this._layerDef, [swP.x, swP.y, neP.x, neP.y], size);
        },

        onAdd: function (map) {
            L.TileLayer.prototype.onAdd.call(this, map);
            this.on('tileerror', this._onTileError, this);
            this.on('tileload', this._onTileLoad, this);
        },
        onRemove: function (map) {
            this.off('tileerror', this._onTileError, this);
            this.off('tileload', this._onTileLoad, this);
            L.TileLayer.prototype.onRemove.call(this, map);
        },
        _onTileLoad: function () { this._errorCount = 0; },
        _onTileError: function () {
            this._errorCount += 1;
            if (!this._warned) {
                this._warned = true;
                if (window.console) {
                    window.console.warn('[Finland] an Åland ' + this._layerDef.id +
                        ' tile could not be loaded; further failures are silent');
                }
            }
            if (this._errorCount >= PROXY_AFTER_ERRORS && !this._announced) {
                this._announced = true;
                setStatus(this._layerDef.id, tr(TEXT.unavailable), 'error', true);
            }
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * 5. MUSEOVERKKO WFS LAYERS — one debounced bbox query per view
     * ═══════════════════════════════════════════════════════════════════════
     * The register is served as EPSG:4326 GeoJSON by GetWFSFeatures, so the
     * browser needs no projection maths. The Danish heritage pattern: a shared
     * debounced refresh on moveend, an AbortController per request, a minZoom
     * gate with a “zoom in” status, direct→proxy fallback and a feature cap
     * with an honest “only the first …” note. */

    function categoryColor(layerDef) {
        var cat = CONFIG.categoryById(layerDef.subGroup);
        if (cat) return cat.color;
        if (layerDef.subGroup === 'rakennusperinto') return '#d16ba5';
        return '#e01b24';
    }

    function wfsLayerGroup(layerDef) {
        var color = categoryColor(layerDef);
        var isPoint = layerDef.geom === 'point';
        var group = L.layerGroup();
        /* The GeoJSON container is rebuilt per view; the group is the stable
         * handle the panel talks to. */
        var baseOpacity = Math.max(0, Math.min(1, runtime.opacity[layerDef.id] / 100));
        var geo = L.geoJSON(null, {
            pane: PANE_VECTOR,
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: layerDef.subGroup === 'poistetut' ? 4 : 5,
                    color: color,
                    weight: 1.5,
                    opacity: baseOpacity,
                    fillColor: color,
                    fillOpacity: baseOpacity * 0.45,
                    className: 'finland-wfs-point'
                });
            },
            style: function () {
                return {
                    color: color,
                    weight: layerDef.subGroup === 'poistetut' ? 1.5 : 2,
                    opacity: baseOpacity,
                    dashArray: layerDef.subGroup === 'poistetut' ? '5,4' : null,
                    fillColor: color,
                    fillOpacity: baseOpacity * 0.08,
                    className: 'finland-wfs-shape'
                };
            },
            onEachFeature: function (feature, layer) {
                layer.bindPopup(function () {
                    return popupHtml(layerDef, feature.properties || {});
                }, { maxWidth: 320, autoPan: false });
            }
        });
        group.addLayer(geo);
        group._geoContainer = geo;
        group._baseOpacity = baseOpacity;
        group.setLayerOpacity = function (v) {
            group._baseOpacity = Math.max(0, Math.min(1, v));
            geo.eachLayer(function (child) {
                if (typeof child.setStyle === 'function') {
                    child.setStyle({ opacity: group._baseOpacity, fillOpacity: group._baseOpacity * 0.45 });
                }
            });
        };
        return group;
    }

    function scheduleWfs() {
        if (runtime.wfsTimer) window.clearTimeout(runtime.wfsTimer);
        runtime.wfsTimer = window.setTimeout(function () {
            runtime.wfsTimer = null;
            LAYERS.forEach(function (layer) {
                if (layer.kind === 'wfs' && runtime.active[layer.id]) refreshOneWfs(layer, false);
            });
        }, WFS_DEBOUNCE_MS);
    }

    function refreshOneWfs(layer, force) {
        var map = runtime.map;
        if (!map || !runtime.active[layer.id]) return;
        var state = runtime.wfs[layer.id];
        if (!state) state = runtime.wfs[layer.id] = { running: false, dirty: false, controller: null, last: '', mode: 'direct', count: 0, truncated: false };

        if (map.getZoom() < (layer.minZoom || 0)) {
            var built = runtime.built[layer.id];
            if (built && built._geoContainer) built._geoContainer.clearLayers();
            state.count = 0;
            setZoomHint(layer, true);
            state.last = '';
            return;
        }
        setZoomHint(layer, false);

        if (state.running && !force) { state.dirty = true; return; }

        var bounds = map.getBounds().pad(0.1);   /* small edge buffer */
        var bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
        var key = bbox.map(function (v) { return round(v, 4); }).join(',');
        if (!force && key === state.last) return;
        state.last = key;
        state.running = true;
        setStatus(layer.id, tr(TEXT.loading), 'info');

        if (state.controller && state.controller.abort) {
            try { state.controller.abort(); } catch (e) {}
        }
        var controller = (typeof window.AbortController === 'function') ? new window.AbortController() : null;
        state.controller = controller;
        var options = controller ? { signal: controller.signal } : {};

        function finish() {
            state.running = false;
            if (state.dirty) { state.dirty = false; refreshOneWfs(layer, true); }
        }

        function render(collection) {
            var built = runtime.built[layer.id];
            if (!built || !built._geoContainer) { finish(); return; }
            var features = (collection && collection.features) || [];
            state.truncated = features.length >= WFS_FEATURE_CAP;
            var shown = features.slice(0, WFS_FEATURE_CAP);
            built._geoContainer.clearLayers();
            built._geoContainer.addData({ type: 'FeatureCollection', features: shown });
            state.count = shown.length;
            if (state.count === 0) {
                setStatus(layer.id, '', 'info');
            } else if (state.truncated) {
                setStatus(layer.id, tr(TEXT.truncated) + ' ' + WFS_FEATURE_CAP + ' ' + tr(TEXT.zoomInShort), 'warn');
            } else {
                setStatus(layer.id, state.count + ' ' + tr(TEXT.shown), 'info');
            }
        }

        function fetchJson(url) {
            return window.fetch(url, options).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }

        fetchJson(wfsUrl(layer, bbox, state.mode === 'proxy'))
            .then(function (collection) {
                /* the route answers errors as text/plain with 200 sometimes */
                if (!collection || collection.error) throw new Error('bad payload');
                render(collection);
                finish();
            })
            .catch(function (error) {
                if (error && error.name === 'AbortError') { finish(); return; }
                if (state.mode === 'direct') {
                    state.mode = 'proxy';
                    fetchJson(wfsUrl(layer, bbox, true))
                        .then(function (collection) {
                            if (!collection || collection.error) throw new Error('bad payload');
                            render(collection);
                            finish();
                        })
                        .catch(function (error2) {
                            if (error2 && error2.name === 'AbortError') { finish(); return; }
                            setStatus(layer.id, tr(TEXT.unavailable), 'error', true);
                            finish();
                        });
                    return;
                }
                setStatus(layer.id, tr(TEXT.unavailable), 'error', true);
                finish();
            });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 6. HKP MVT CADASTRAL LAYER — decode + reproject + draw on canvas
     * ═══════════════════════════════════════════════════════════════════════
     * GetLayerTile serves MVT on the TM35FIN grid (x=TileCol, y=TileRow,
     * z=TileMatrix). One destination tile fetches the matching source level,
     * decodes the protobuf (js/finland-tm35.js), projects every vertex from
     * tile-local extent units → EPSG:3067 metres → WGS84 → tile pixels, and
     * strokes it. Click identify uses the cached decoded features. */

    var mvtCache = new window.Map ? new window.Map() : {};   /* 'z/x/y' → decoded layers, small LRU */

    function mvtCacheGet(key) {
        if (mvtCache.get) return mvtCache.get(key);
        return mvtCache[key] || null;
    }
    function mvtCacheSet(key, value) {
        if (mvtCache.size !== undefined && typeof mvtCache.delete === 'function') {
            if (mvtCache.size >= 64) mvtCache.delete(mvtCache.keys().next().value);
            mvtCache.set(key, value);
        } else {
            mvtCache[key] = value;
        }
    }

    var FinlandMvtLayer = L.GridLayer.extend({
        options: {
            tileSize: 256,
            keepBuffer: 2,
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true
        },

        initialize: function (layerDef, options) {
            this._layerDef = layerDef;
            this._failCount = 0;
            this._warned = false;
            this._announced = false;
            this._identifyHandler = null;
            L.setOptions(this, options || {});
            if (!this.options.bounds) this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            this.options.minZoom = layerDef.minZoom;
            this.options.maxZoom = layerDef.maxZoom;
            L.GridLayer.prototype.initialize.call(this, this.options);
        },

        onAdd: function (map) {
            L.GridLayer.prototype.onAdd.call(this, map);
            this.on('tileunload', this._onTileUnload, this);
            var self = this;
            this._identifyHandler = function (event) { self._identify(event); };
            map.on('click', this._identifyHandler, this);
        },
        onRemove: function (map) {
            this.off('tileunload', this._onTileUnload, this);
            if (this._identifyHandler) map.off('click', this._identifyHandler, this);
            L.GridLayer.prototype.onRemove.call(this, map);
        },
        _onTileUnload: function (e) {
            if (e && e.tile) e.tile._dlCancelled = true;
        },

        createTile: function (coords, done) {
            var size = this.getTileSize();
            var canvas = document.createElement('canvas');
            canvas.width = size.x;
            canvas.height = size.y;
            canvas.setAttribute('role', 'presentation');
            var self = this;
            this._renderTile(canvas, coords, size).then(function (drew) {
                if (canvas._dlCancelled) return;
                if (!drew) self._noteFailure();
                done(null, canvas);
            })['catch'](function (err) {
                if (canvas._dlCancelled) return;
                self._noteFailure(err);
                done(null, canvas);
            });
            return canvas;
        },

        _renderTile: function (canvas, coords, size) {
            var layerDef = this._layerDef;
            var map = this._map;
            var tileSize = size.x;
            var self = this;

            /* Source level: match the destination tile's ground resolution at
             * the tile's own latitude (TM35FIN metres are true scale). */
            var bounds = this._tileCoordsToBounds(coords);
            var centerLat = (bounds.getNorth() + bounds.getSouth()) / 2;
            var level = Math.min(TM.levelForZoom(coords.z, centerLat), 15);
            var span = TM.GRID.tileSpan(level);

            /* The destination tile's four corners → EPSG:3067 bbox → every
             * source tile that intersects it (a z13 destination tile at
             * level 10 needs up to 2×2 source tiles; one is NOT enough). */
            var nw = TM.UTM35.forward(bounds.getNorth(), bounds.getWest());
            var ne = TM.UTM35.forward(bounds.getNorth(), bounds.getEast());
            var sw = TM.UTM35.forward(bounds.getSouth(), bounds.getWest());
            var se = TM.UTM35.forward(bounds.getSouth(), bounds.getEast());
            var bbox = [
                Math.min(nw[0], sw[0], ne[0], se[0]),
                Math.min(sw[1], se[1], nw[1], ne[1]),
                Math.max(ne[0], se[0], nw[0], sw[0]),
                Math.max(nw[1], ne[1], sw[1], se[1])
            ];
            var m = TM.GRID.matrixSize(level);
            var c0 = Math.max(0, Math.floor((bbox[0] - TM.GRID.origin[0]) / span));
            var c1 = Math.min(m[0] - 1, Math.floor((bbox[2] - TM.GRID.origin[0]) / span));
            var r0 = Math.max(0, Math.floor((TM.GRID.origin[1] - bbox[3]) / span));
            var r1 = Math.min(m[1] - 1, Math.floor((TM.GRID.origin[1] - bbox[1]) / span));
            if (c1 < c0 || r1 < r0) return window.Promise.resolve(false);

            /* Cap the mosaic (paranoia: TM35FIN tiles are square, so this
             * never trips in practice — a whole destination tile fits in
             * 3×3 source tiles at the matched level). */
            if ((c1 - c0 + 1) * (r1 - r0 + 1) > 9) {
                level = Math.max(0, level - 1);
                span = TM.GRID.tileSpan(level);
                m = TM.GRID.matrixSize(level);
                c0 = Math.max(0, Math.floor((bbox[0] - TM.GRID.origin[0]) / span));
                c1 = Math.min(m[0] - 1, Math.floor((bbox[2] - TM.GRID.origin[0]) / span));
                r0 = Math.max(0, Math.floor((TM.GRID.origin[1] - bbox[3]) / span));
                r1 = Math.min(m[1] - 1, Math.floor((TM.GRID.origin[1] - bbox[1]) / span));
                if (c1 < c0 || r1 < r0) return window.Promise.resolve(false);
            }

            var proxied = runtime.tileMode[layerDef.id] === 'proxy';
            var wanted = layerDef.layerNames || null;
            var jobs = [];
            for (var row = r0; row <= r1; row++) {
                for (var col = c0; col <= c1; col++) {
                    (function (col, row) {
                        var cacheKey = layerDef.id + '/' + level + '/' + col + '/' + row;
                        var cached = mvtCacheGet(cacheKey);
                        if (cached) {
                            jobs.push(window.Promise.resolve(cached));
                        } else {
                            jobs.push(window.fetch(mvtTileUrl(layerDef, level, col, row, proxied))
                                .then(function (response) {
                                    if (!response.ok) throw new Error('HTTP ' + response.status);
                                    return response.arrayBuffer();
                                })
                                .then(function (buffer) {
                                    var decoded = TM.mvtDecode(new Uint8Array(buffer));
                                    mvtCacheSet(cacheKey, decoded);
                                    return decoded;
                                }));
                        }
                    })(col, row);
                }
            }

            return window.Promise.all(jobs).then(function (decodedTiles) {
                if (canvas._dlCancelled) return false;
                var drew = false;
                var colIdx = 0;
                for (var row = r0; row <= r1; row++) {
                    for (var col = c0; col <= c1; col++, colIdx++) {
                        var decoded = decodedTiles[colIdx];
                        if (!decoded) continue;
                        ((decoded && decoded.layers) || []).forEach(function (tileLayer) {
                            if (wanted && wanted.indexOf(tileLayer.name) === -1) return;
                            if (self._drawMvtLayer(canvas, tileLayer, coords, level, col, row, tileSize, map)) drew = true;
                        });
                    }
                }
                self._failCount = 0;
                return drew;
            });
        },

        /** Decode-agnostic draw: TM35FIN tile units → mercator pixels. */
        _drawMvtLayer: function (canvas, tileLayer, coords, level, col, row, tileSize, map) {
            var layerDef = this._layerDef;
            var ctx = canvas.getContext('2d');
            var alpha = Math.max(0, Math.min(1, runtime.opacity[layerDef.id] / 100));
            var style = layerDef.style || {};
            var tb = TM.tileBounds(level, col, row);
            var span = tb[2] - tb[0];
            var extent = tileLayer.extent || 4096;
            var tileOriginPx = { x: coords.x * tileSize, y: coords.y * tileSize };
            var zoom = coords.z;
            var self = this;

            function toPx(xUnits, yUnits) {
                var e = tb[0] + (xUnits / extent) * span;
                var n = tb[3] - (yUnits / extent) * span;   /* y grows southward */
                var ll = TM.UTM35.inverse(e, n);
                var pt = map.project([ll[0], ll[1]], zoom);
                return [pt.x - tileOriginPx.x, pt.y - tileOriginPx.y];
            }

            ctx.save();
            ctx.globalAlpha = alpha;
            var drewAny = false;

            tileLayer.features.forEach(function (feature) {
                var parts = feature.parts || [];
                var i, part, k, px;
                if (feature.type === 1) {
                    /* point (label points / parcel centroids) */
                    ctx.beginPath();
                    for (i = 0; i < parts.length; i++) {
                        part = parts[i];
                        if (!part.length) continue;
                        px = toPx(part[0][0], part[0][1]);
                        ctx.moveTo(px[0] + 2, px[1]);
                        ctx.arc(px[0], px[1], 2, 0, Math.PI * 2);
                    }
                    ctx.fillStyle = style.color || '#ffd24d';
                    ctx.fill();
                    drewAny = true;
                    /* optional label text */
                    if (layerDef.labelField && (feature.tags[layerDef.labelField] ||
                        (layerDef.labelFallbackField && feature.tags[layerDef.labelFallbackField]))) {
                        var text = feature.tags[layerDef.labelField] ||
                            feature.tags[layerDef.labelFallbackField];
                        var ls = layerDef.labelStyle || {};
                        ctx.font = ls.font || '11px sans-serif';
                        ctx.textBaseline = 'middle';
                        if (ls.stroke) {
                            ctx.strokeStyle = ls.stroke;
                            ctx.lineWidth = 3;
                            ctx.strokeText(text, px[0] + 5, px[1]);
                        }
                        ctx.fillStyle = ls.color || '#fff2c4';
                        ctx.fillText(text, px[0] + 5, px[1]);
                    }
                } else if (feature.type === 2 || feature.type === 3) {
                    ctx.beginPath();
                    for (i = 0; i < parts.length; i++) {
                        part = parts[i];
                        if (!part.length) continue;
                        px = toPx(part[0][0], part[0][1]);
                        ctx.moveTo(px[0], px[1]);
                        for (k = 1; k < part.length; k++) {
                            px = toPx(part[k][0], part[k][1]);
                            ctx.lineTo(px[0], px[1]);
                        }
                        if (feature.type === 3) ctx.closePath();
                    }
                    if (feature.type === 3 && style.fill) {
                        ctx.fillStyle = style.fillColor || style.color || '#ffd24d';
                        ctx.globalAlpha = alpha * (style.fillOpacity !== undefined ? style.fillOpacity : 0.06);
                        ctx.fill();
                        ctx.globalAlpha = alpha;
                    }
                    ctx.strokeStyle = style.color || '#ffd24d';
                    ctx.lineWidth = style.weight || 2;
                    if (style.dash) ctx.setLineDash(style.dash.split(',').map(Number));
                    ctx.stroke();
                    if (style.dash) ctx.setLineDash([]);
                    drewAny = true;
                }
            });
            ctx.restore();
            return drewAny;
        },

        /** Click → nearest cached feature within ~10 px, as a popup. */
        _identify: function (event) {
            var map = this._map;
            if (!map || map.getZoom() < (this._layerDef.minZoom || 0)) return;
            var layerDef = this._layerDef;
            var target = event.latlng;
            var best = null, bestDist = 12;   /* px */
            mvtCache.forEachOwn = mvtCacheForEach;
            mvtCacheForEach(function (decoded, key) {
                if (key.indexOf(layerDef.id + '/') !== 0) return;
                var parts = key.split('/');
                var level = Number(parts[1]), col = Number(parts[2]), row = Number(parts[3]);
                (decoded.layers || []).forEach(function (tileLayer) {
                    var wanted = layerDef.layerNames || null;
                    if (wanted && wanted.indexOf(tileLayer.name) === -1) return;
                    var tb = TM.tileBounds(level, col, row);
                    var span = tb[2] - tb[0];
                    var extent = tileLayer.extent || 4096;
                    (tileLayer.features || []).forEach(function (feature) {
                        (feature.parts || []).forEach(function (part) {
                            part.forEach(function (pt) {
                                var e = tb[0] + (pt[0] / extent) * span;
                                var n = tb[3] - (pt[1] / extent) * span;
                                var ll = TM.UTM35.inverse(e, n);
                                var dist = map.distance(L.latLng(ll[0], ll[1]), target) /
                                    (map.options.crs.distance ? 1 : 1);
                                /* compare in pixels, not metres */
                                var p1 = map.project(L.latLng(ll[0], ll[1]), map.getZoom());
                                var p2 = map.project(target, map.getZoom());
                                var dpx = Math.hypot(p1.x - p2.x, p1.y - p2.y);
                                if (dpx < bestDist) {
                                    bestDist = dpx;
                                    best = { feature: feature, layerName: tileLayer.name };
                                }
                            });
                        });
                    });
                });
            });
            if (!best) return;
            var props = {};
            var tags = best.feature.tags || {};
            Object.keys(tags).forEach(function (k) { props[k] = tags[k]; });
            props._mvtLayer = best.layerName;
            var html = popupHtml(layerDef, props);
            if (html) L.popup({ maxWidth: 320 }, this)
                .setLatLng(event.latlng)
                .setContent(html)
                .openOn(map);
        },

        _noteFailure: function (err) {
            var id = this._layerDef.id;
            this._failCount += 1;
            if (!this._warned) {
                this._warned = true;
                if (window.console) {
                    window.console.warn('[Finland] a ' + id + ' vector tile failed' +
                        (err && err.message ? ' (' + err.message + ')' : '') +
                        '; further failures are silent');
                }
            }
            if (runtime.tileMode[id] === 'direct' && this._failCount >= PROXY_AFTER_ERRORS) {
                runtime.tileMode[id] = 'proxy';
                this._failCount = 0;
                setStatus(id, tr(TEXT.proxying), 'warn');
                this.redraw();
                return;
            }
            if (runtime.tileMode[id] === 'proxy' && this._failCount >= PROXY_AFTER_ERRORS) {
                this._failCount = 0;
                if (!this._announced) {
                    this._announced = true;
                    setStatus(id, tr(TEXT.unavailable), 'error', true);
                }
            }
        }
    });

    function mvtCacheForEach(fn) {
        if (mvtCache.forEach) {
            mvtCache.forEach(function (value, key) { fn(value, key); });
        } else {
            Object.keys(mvtCache).forEach(function (key) { fn(mvtCache[key], key); });
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7. LOCAL GEOJSON LAYERS (the Supabase conversions)
     * ═══════════════════════════════════════════════════════════════════════ */

    function localFileUrl(layerDef) {
        return CONFIG.endpoints.localBase + layerDef.file + '.geojson';
    }
    function localSupabaseUrl(layerDef) {
        return CONFIG.endpoints.supabase + (layerDef.supabaseFile || ('converted/' + layerDef.file + '.geojson'));
    }

    var localState = {};    /* id → 'ok' | 'missing' */

    function loadLocalLayer(layerDef) {
        var built = runtime.built[layerDef.id];
        if (!built || !built._geoContainer) return;
        var state = runtime.wfs[layerDef.id];
        if (!state) state = runtime.wfs[layerDef.id] = { running: false, dirty: false, controller: null, last: '', mode: 'direct', count: 0, truncated: false };
        setStatus(layerDef.id, tr(TEXT.loading), 'info');
        window.fetch(localFileUrl(layerDef))
            .then(function (response) {
                if (response.status === 404) return localSupabaseFetch(layerDef);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            })
            .then(function (collection) {
                if (localState[layerDef.id] === 'missing') {
                    localState[layerDef.id] = 'ok';
                }
                renderLocal(layerDef, collection);
            })
            .catch(function (error) {
                /* the Supabase mirror failed too — honest status, no dummy data */
                localState[layerDef.id] = 'missing';
                setStatus(layerDef.id, tr(TEXT.notConverted) + ' — ' + (layerDef.statusNote || ''), 'warn');
                if (window.console) {
                    window.console.warn('[Finland] ' + layerDef.id + ' not loadable: ' +
                        (error && error.message ? error.message : 'fetch failed'));
                }
            });
    }

    function localSupabaseFetch(layerDef) {
        return window.fetch(localSupabaseUrl(layerDef)).then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status + ' (also no local copy)');
            localState[layerDef.id] = 'supabase';
            return response.json();
        });
    }

    function renderLocal(layerDef, collection) {
        var built = runtime.built[layerDef.id];
        if (!built || !built._geoContainer) return;
        var features = (collection && collection.features) || [];
        built._geoContainer.clearLayers();
        built._geoContainer.addData(collection || { type: 'FeatureCollection', features: [] });
        var state = runtime.wfs[layerDef.id] || (runtime.wfs[layerDef.id] = {});
        state.count = features.length;
        setStatus(layerDef.id, features.length + ' ' + tr(TEXT.shown) +
            (localState[layerDef.id] === 'supabase' ? ' (Supabase)' : ''), 'info');
    }

    function localLayerGroup(layerDef) {
        var style = layerDef.style || {};
        var baseOpacity = Math.max(0, Math.min(1, runtime.opacity[layerDef.id] / 100));
        var group = L.layerGroup();
        var geo = L.geoJSON(null, {
            pane: PANE_VECTOR,
            pointToLayer: function (feature, latlng) {
                return L.circleMarker(latlng, {
                    radius: style.radius || 5,
                    color: style.color || '#c9a227',
                    weight: 2,
                    opacity: baseOpacity,
                    fillColor: style.color || '#c9a227',
                    fillOpacity: baseOpacity * 0.5
                });
            },
            style: function () {
                return {
                    color: style.color || '#c9a227',
                    weight: style.weight || 2,
                    opacity: baseOpacity,
                    dashArray: style.dash || null,
                    fill: !!style.fill,
                    fillColor: style.fillColor || style.color || '#c9a227',
                    fillOpacity: baseOpacity * (style.fillOpacity !== undefined ? style.fillOpacity : 0.08)
                };
            },
            onEachFeature: function (feature, layer) {
                layer.bindPopup(function () {
                    return popupHtml(layerDef, feature.properties || {});
                }, { maxWidth: 320, autoPan: false });
            }
        });
        group.addLayer(geo);
        group._geoContainer = geo;
        group.setLayerOpacity = function (v) {
            var b = Math.max(0, Math.min(1, v));
            geo.eachLayer(function (child) {
                if (typeof child.setStyle === 'function') {
                    child.setStyle({ opacity: b, fillOpacity: b * 0.4 });
                }
            });
        };
        return group;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 8. SYKE CLICK IDENTIFY (GetFeatureInfo, direct→proxy)
     * ═══════════════════════════════════════════════════════════════════════ */

    function sykeIdentify(event) {
        var map = runtime.map;
        if (!map) return;
        var active = LAYERS.filter(function (layer) {
            return layer.kind === 'wms' && runtime.active[layer.id] && map.getZoom() >= (layer.minZoom || 0);
        });
        if (!active.length) return;
        var target = event.latlng;
        var size = map.getSize();
        var b = map.getBounds();
        var bbox4326 = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        var nw = map.project(b.getNorthWest(), map.getZoom());
        var pt = map.project(target, map.getZoom());
        var x = Math.round(pt.x - nw.x), y = Math.round(pt.y - nw.y);

        var layerDef = active[0];
        var service = CONFIG.WMS_SERVICES[layerDef.service] || {};
        var infoUrl = String(service.url || '') + '?' + [
            'SERVICE=WMS', 'VERSION=1.1.1', 'REQUEST=GetFeatureInfo',
            'LAYERS=' + encodeURIComponent(layerDef.layers),
            'QUERY_LAYERS=' + encodeURIComponent(layerDef.layers),
            'STYLES=', 'SRS=EPSG:4326',
            'BBOX=' + bbox4326.map(function (v) { return round(v, 6); }).join(','),
            'WIDTH=' + size.x, 'HEIGHT=' + size.y,
            'X=' + x, 'Y=' + y,
            'INFO_FORMAT=application/json', 'FEATURE_COUNT=5'
        ].join('&');

        function fetchJson(url) {
            return window.fetch(url).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }
        fetchJson(infoUrl)
            .catch(function () { return fetchJson(sykeProxyUrl(infoUrl)); })
            .then(function (collection) {
                var features = (collection && collection.features) || [];
                if (!features.length) return;
                var props = features[0].properties || {};
                var html = popupHtml(layerDef, props);
                if (html) L.popup({ maxWidth: 320 })
                    .setLatLng(target)
                    .setContent(html)
                    .openOn(map);
            })
            .catch(function () { /* no identify — silent, the tiles still render */ });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 9. ÅLAND CLICK IDENTIFY (REST query, direct→proxy)
     * ═══════════════════════════════════════════════════════════════════════ */

    function alandIdentify(event) {
        var map = runtime.map;
        if (!map) return;
        var target = event.latlng;
        var tol = 0.002 * Math.pow(2, Math.max(0, map.getZoom() - 14)) + 0.0008;
        var bounds = [target.lng - tol, target.lat - tol, target.lng + tol, target.lat + tol];
        var layerDefs = LAYERS.filter(function (layer) {
            return layer.kind === 'arcgis' && runtime.active[layer.id];
        });
        if (!layerDefs.length) return;
        var layerDef = layerDefs[0];
        var url = alandQueryUrl(layerDef, bounds);
        var proxyUrl = PROXY_PATH + '?src=aland&url=' + encodeURIComponent(url);

        function fetchJson(u) {
            return window.fetch(u).then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.json();
            });
        }
        fetchJson(url)
            .catch(function () { return fetchJson(proxyUrl); })
            .then(function (collection) {
                var features = (collection && collection.features) || [];
                if (!features.length) return;
                var props = features[0].properties || {};
                var html = popupHtml(layerDef, props);
                if (html) L.popup({ maxWidth: 320 })
                    .setLatLng(target)
                    .setContent(html)
                    .openOn(map);
            })
            .catch(function () { /* silent */ });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 10. POPUPS — English labels, Finnish originals, KYPPI links
     * ═══════════════════════════════════════════════════════════════════════ */

    function fieldLabel(fiKey) {
        return (CONFIG.FIELD_LABELS || {})[fiKey] || fiKey;
    }

    function kyppiLink(props) {
        if (props.Kohteen_tiedot) return String(props.Kohteen_tiedot);
        if (props.Kohdetunnus) return 'https://www.kyppi.fi/to.aspx?id=112.' + props.Kohdetunnus;
        if (props.Kohde_ID) return 'https://www.kyppi.fi/to.aspx?id=130.' + props.Kohde_ID;
        return null;
    }

    function popupHtml(layerDef, props) {
        var def = layerDef.popup || { fields: [], link: null };
        var title = tr(layerDef.title);
        var rows = [];
        var i, key, value;
        for (i = 0; i < (def.fields || []).length; i++) {
            key = def.fields[i][0];
            value = props[key];
            if (value === undefined || value === null || value === '') continue;
            rows.push('<tr><th>' + esc(def.fields[i][1]) + '</th><td>' + esc(value) + '</td></tr>');
        }
        /* anything not covered above still shows, translated by fieldLabel */
        Object.keys(props).forEach(function (k) {
            if (k === '_mvtLayer') return;
            var covered = false;
            for (var j = 0; j < (def.fields || []).length; j++) {
                if (def.fields[j][0] === k) { covered = true; break; }
            }
            if (covered) return;
            var v = props[k];
            if (v === undefined || v === null || v === '') return;
            rows.push('<tr><th>' + esc(fieldLabel(k)) + '</th><td>' + esc(v) + '</td></tr>');
        });
        var link = def.link && props[def.link.field] ? props[def.link.field] : kyppiLink(props);
        var html = '<div class="finland-popup"><div class="finland-popup-title">' + esc(title) + '</div>';
        if (layerDef.title && layerDef.title.fi && layerDef.title.fi !== title) {
            html += '<div class="finland-popup-fi">' + esc(layerDef.title.fi) + '</div>';
        }
        if (rows.length) html += '<table class="finland-popup-table">' + rows.join('') + '</table>';
        if (link && /^https?:/.test(String(link))) {
            html += '<a class="finland-popup-link" href="' + esc(link) + '" target="_blank" rel="noopener">' +
                esc((def.link && def.link.label) || 'KYPPI register entry') + ' ↗</a>';
        }
        html += '<div class="finland-popup-attr">' + esc(layerDef.attributionRow || '') + '</div>';
        if (layerDef.kind === 'wfs' && layerDef.group === 'protected') {
            if (layerDef.subGroup === 'rakennusperinto') {
                html += '<div class="finland-popup-note">Protection instruments vary by law (decrees, Church/Orthodox Church Acts, ' +
                    'Building Protection Act); see the KYPPI entry for the instrument in force.</div>';
            } else {
                html += '<div class="finland-popup-note">Protected under the Antiquities Act 295/1963 · ' +
                    'location accuracy ≈ ±50 m · point-only sites have no defined extent.</div>';
            }
        }
        html += '</div>';
        return html;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 11. ACTIVATION
     * ═══════════════════════════════════════════════════════════════════════ */

    function build(layerDef) {
        var built;
        if (layerDef.kind === 'tm35-wmts') {
            built = new FinlandTm35RasterLayer(layerDef, {
                pane: PANE_RASTER,
                opacity: 1,   /* drawn per-canvas from runtime.opacity */
                attribution: layerDef.attribution
            });
        } else if (layerDef.kind === 'mvt') {
            built = new FinlandMvtLayer(layerDef, {
                pane: PANE_VECTOR,
                attribution: layerDef.attribution
            });
        } else if (layerDef.kind === 'wms') {
            built = new FinlandWmsLayer(layerDef, {
                pane: PANE_RASTER,
                opacity: runtime.opacity[layerDef.id] / 100,
                attribution: layerDef.attribution
            });
        } else if (layerDef.kind === 'arcgis') {
            built = new FinlandArcgisLayer(layerDef, {
                pane: PANE_RASTER,
                opacity: runtime.opacity[layerDef.id] / 100,
                attribution: layerDef.attribution
            });
        } else if (layerDef.kind === 'wfs') {
            built = wfsLayerGroup(layerDef);
        } else if (layerDef.kind === 'geojson') {
            built = localLayerGroup(layerDef);
        } else {
            return null;
        }
        /* Naming the definition lets the availability guard and the
         * diagnostics talk about this layer instead of a hostname. The layer
         * carries `_detectlabNoGuard`: this module owns the row and explains
         * its own failures (proxy fallback + status line), and a guard trip
         * would flip the very switch that drives the state machine here. */
        try {
            built._dlDefId = 'finland.' + layerDef.id;
            built._detectlabProvider = CONFIG.provider;
            built._detectlabUiTitle = tr(layerDef.title);
            built._detectlabUiKeys = ['finlandToggle_' + layerDef.id];
            built._detectlabNoGuard = true;
        } catch (e) {}
        return built;
    }

    function activate(layerDef) {
        var map = runtime.map || getMap();
        runtime.active[layerDef.id] = true;
        if (!map) return;
        ensurePanes(map);
        if (!runtime.built[layerDef.id]) runtime.built[layerDef.id] = build(layerDef);
        var built = runtime.built[layerDef.id];
        if (!built) return;
        applyOpacity(layerDef);
        if (!map.hasLayer(built)) map.addLayer(built);
        setStatus(layerDef.id, tr(TEXT.loading), 'info');
        if (layerDef.kind === 'wfs') refreshOneWfs(layerDef, true);
        if (layerDef.kind === 'geojson') loadLocalLayer(layerDef);
        if (map.getZoom() < (layerDef.minZoom || 0)) setZoomHint(layerDef, true);
    }

    function deactivate(layerDef) {
        runtime.active[layerDef.id] = false;
        setZoomHint(layerDef, false);
        var map = runtime.map || getMap();
        var built = runtime.built[layerDef.id];
        if (map && built && map.hasLayer(built)) map.removeLayer(built);
        if (built && layerDef.kind === 'wfs') {
            var state = runtime.wfs[layerDef.id];
            if (state && state.controller && state.controller.abort) {
                try { state.controller.abort(); } catch (e) {}
            }
            state.last = '';
        }
        setStatus(layerDef.id, '', 'info');
    }

    function applyOpacity(layerDef) {
        var v = runtime.opacity[layerDef.id] / 100;
        var built = runtime.built[layerDef.id];
        if (!built) return;
        if (layerDef.kind === 'wms' || layerDef.kind === 'arcgis' || layerDef.kind === 'tm35-wmts') {
            if (typeof built.setOpacity === 'function') {
                /* the canvas layers draw their own alpha; setOpacity keeps
                 * the container consistent for the css-based ones */
                if (layerDef.kind !== 'tm35-wmts') built.setOpacity(v);
            }
        } else if (typeof built.setLayerOpacity === 'function') {
            built.setLayerOpacity(v);
        }
    }

    function setOpacity(layerDef, value) {
        var v = Math.max(0, Math.min(100, Number(value) || 0));
        runtime.opacity[layerDef.id] = v;
        applyOpacity(layerDef);
        if (v > 0 && !runtime.active[layerDef.id]) activate(layerDef);
        if (v === 0 && runtime.active[layerDef.id]) deactivate(layerDef);
        syncUI();
        save();
    }

    /* The master switch: on ⇒ the default layers unless the visitor already
     * chose; off ⇒ everything Finnish comes off (and stays off on return). */
    function toggleGroup(on) {
        if (on) {
            var anyActive = LAYERS.some(function (layer) { return runtime.active[layer.id]; });
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id] || (!anyActive && layer.defaultOn)) activate(layer);
            });
        } else {
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) deactivate(layer);
            });
        }
        syncUI();
        save();
    }

    /* A section master (e.g. “Cadastral”) toggles its whole section. */
    function toggleSection(groupId, on) {
        CONFIG.layersOfGroup(groupId).forEach(function (layer) {
            if (!layer.enabled) return;
            if (on) activate(layer);
            else deactivate(layer);
        });
        syncUI();
        save();
    }

    /* ── retry ─────────────────────────────────────────────────────────────── */

    function retryLayer(id) {
        var layerDef = CONFIG.byId(id);
        if (!layerDef) return;
        var built = runtime.built[id];
        runtime.tileMode[id] = 'direct';
        if (built) {
            if (built._failCount !== undefined) built._failCount = 0;
            if (built._announced) built._announced = false;
            if (built._warned) built._warned = false;
        }
        clearSourceCache();
        setStatus(id, tr(TEXT.loading), 'info');
        if (layerDef.kind === 'wfs') {
            var state = runtime.wfs[id];
            if (state) state.last = '';
            refreshOneWfs(layerDef, true);
        } else if (layerDef.kind === 'geojson') {
            loadLocalLayer(layerDef);
        } else if (built) {
            built.redraw();
        }
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 12. THE PANEL
     * ═══════════════════════════════════════════════════════════════════════ */

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

    function setStatus(id, text, kind, withRetry) {
        runtime.notices[id] = text ? { text: text, kind: kind || 'info', retry: !!withRetry } : null;
        paintStatus(id);
    }
    function clearStatus(id) {
        runtime.notices[id] = null;
        paintStatus(id);
    }
    function paintStatus(id) {
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        var notice = runtime.notices[id];
        var node = row.status;
        node.innerHTML = '';
        if (!notice) {
            node.style.display = 'none';
            node.className = 'finland-layer-status';
            return;
        }
        node.style.display = 'block';
        node.className = 'finland-layer-status is-' + (notice.kind || 'info');
        node.setAttribute('role', notice.kind === 'error' ? 'alert' : 'status');
        node.appendChild(document.createTextNode(notice.text));
        if (notice.retry) {
            var retry = el('button', {
                type: 'button', class: 'finland-layer-retry', text: tr(TEXT.retry)
            });
            retry.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                retryLayer(id);
            });
            node.appendChild(document.createTextNode(' '));
            node.appendChild(retry);
        }
    }

    function setZoomHint(layerDef, on) {
        var id = layerDef.id;
        if (!!runtime.zoomHints[id] === !!on) return;
        runtime.zoomHints[id] = !!on;
        if (on) {
            setStatus(id, tr(TEXT.zoomIn) + (layerDef.minZoom || 0) + ')', 'info');
        } else {
            clearStatus(id);
        }
    }

    function setNotice(text) {
        var node = document.getElementById(GROUP_NOTICE_ID);
        if (!node) return;
        node.textContent = text || '';
        node.style.display = text ? 'block' : 'none';
    }

    function buildRow(layerDef) {
        var title = tr(layerDef.title);
        var row = el('div', {
            class: 'finland-layer-row' + (layerDef.enabled === false ? ' is-blocked' : ''),
            id: 'finlandRow_' + layerDef.id,
            'data-finland-row': layerDef.id
        });
        var head = el('div', { class: 'finland-layer-head' });

        var input = el('input', {
            type: 'checkbox',
            id: 'finlandToggle_' + layerDef.id,
            value: layerDef.id,
            'data-finland-input': layerDef.id
        });
        if (layerDef.enabled === false) input.disabled = true;
        input.checked = !!runtime.active[layerDef.id];
        input.addEventListener('change', function () {
            if (input.checked) {
                if (runtime.opacity[layerDef.id] === 0) runtime.opacity[layerDef.id] =
                    Math.round((typeof layerDef.opacity === 'number' ? layerDef.opacity : 1) * 100);
                activate(layerDef);
            } else {
                deactivate(layerDef);
            }
            syncUI();
            save();
        });

        var labelSpan = el('span', { class: 'finland-layer-title', text: title });
        if (layerDef.title && layerDef.title.fi && layerDef.title.fi !== title) {
            labelSpan.setAttribute('title', tr(TEXT.finnishName) + ': ' + layerDef.title.fi);
        }
        var label = el('label', { class: 'finland-layer-label', for: 'finlandToggle_' + layerDef.id },
            [input, labelSpan]);

        var info = el('button', {
            type: 'button',
            class: 'finland-layer-info',
            title: layerDef.title ? layerDef.title.fi || title : title,
            'aria-label': title,
            'data-finland-info': layerDef.id,
            text: 'i'
        });
        info.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            showInfo(layerDef);
        });

        head.appendChild(label);
        head.appendChild(info);
        row.appendChild(head);

        var pct = el('span', { class: 'pct', id: 'finlandPct_' + layerDef.id, text: runtime.opacity[layerDef.id] + '%' });
        row.appendChild(el('div', { class: 'finland-layer-opacity' }, [el('span', { text: tr(TEXT.opacity) }), pct]));

        var slider = el('input', {
            type: 'range',
            class: 'finland-layer-slider lidar-country-opacity',
            id: 'finlandOpacity_' + layerDef.id,
            min: '0', max: '100',
            value: String(runtime.opacity[layerDef.id]),
            'aria-label': title + ' — ' + tr(TEXT.opacity)
        });
        slider.addEventListener('input', function () { setOpacity(layerDef, slider.value); });
        row.appendChild(slider);

        var status = el('div', {
            class: 'finland-layer-status',
            id: 'finlandStatus_' + layerDef.id,
            role: 'status',
            style: 'display:none'
        });
        row.appendChild(status);

        /* A blocked/duplicate layer explains itself right in the row. */
        if (layerDef.statusNote && layerDef.status !== 'ok' && layerDef.status !== 'unverified') {
            var note = el('div', { class: 'finland-layer-note', text: layerDef.statusNote });
            row.appendChild(note);
        }

        runtime.rows[layerDef.id] = { row: row, input: input, slider: slider, pct: pct, status: status };
        return row;
    }

    /* A collapsible section: a caption row holding the master checkbox (all
     * on/off for the section) and the collapse button. The checkbox is NOT
     * inside the <button> — interactive content inside a button is invalid
     * HTML and unreliable in browsers; they live side by side instead. */
    function buildSection(groupId, groupLabel, rows) {
        var sectionId = 'finlandSection_' + groupId;
        var section = el('div', { class: 'finland-group', id: sectionId, 'data-finland-group': groupId });
        var expanded = runtime.expandedSections[groupId] !== false;

        var master = el('input', {
            type: 'checkbox',
            class: 'finland-group-master',
            id: 'finlandGroupToggle_' + groupId,
            'aria-label': groupLabel + ' — all'
        });
        master.addEventListener('change', function () {
            toggleSection(groupId, master.checked);
        });

        var toggle = el('button', {
            type: 'button',
            class: 'finland-group-toggle',
            'aria-expanded': expanded ? 'true' : 'false',
            title: tr(TEXT.expand)
        }, [el('span', { class: 'finland-group-chevron', text: '▾' }),
            el('span', { class: 'finland-layer-section', style: 'margin:0;flex:1;text-align:left', text: groupLabel })]);
        toggle.addEventListener('click', function () {
            setSectionExpanded(groupId, !isSectionExpanded(groupId));
        });

        var caption = el('div', { class: 'finland-group-caption' }, [master, toggle]);

        var body = el('div', {
            class: 'finland-group-body',
            style: 'display:flex;flex-direction:column;gap:8px;overflow:hidden;' +
                'transition:max-height 0.3s ease, opacity 0.3s ease;'
        });
        rows.forEach(function (r) { body.appendChild(r); });
        section.appendChild(caption);
        section.appendChild(body);
        section._body = body;
        section._caption = caption;

        return section;
    }

    function isSectionExpanded(groupId) {
        return runtime.expandedSections[groupId] !== false;
    }

    function setSectionExpanded(groupId, expanded) {
        runtime.expandedSections[groupId] = !!expanded;
        var section = document.getElementById('finlandSection_' + groupId);
        if (!section) return;
        var body = section._body || section.querySelector('.finland-group-body');
        var icon = section.querySelector('.finland-group-chevron');
        if (body) {
            body.style.maxHeight = expanded ? (body.scrollHeight + 400) + 'px' : '0';
            body.style.opacity = expanded ? '1' : '0';
        }
        if (icon) icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        var caption = section.querySelector('.finland-group-caption');
        if (caption) caption.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (runtime.expanded) setExpanded(true);
        save();
    }

    /* Inside “Protected sites”, a collapsible sub-section per category. */
    function buildSubSection(subGroupId, rows) {
        var labels = CONFIG.SUBGROUP_LABELS || {};
        var label = tr(labels[subGroupId] || subGroupId);
        var cat = CONFIG.categoryById(subGroupId);
        var section = el('div', {
            class: 'finland-subgroup' + (cat && cat.blocked ? ' is-blocked' : ''),
            'data-finland-subgroup': subGroupId
        });
        var captionRow = el('div', { class: 'finland-subgroup-head' });
        var caption = el('button', {
            type: 'button',
            class: 'finland-subgroup-caption',
            'aria-expanded': 'true',
            title: tr(TEXT.expand)
        }, [el('span', { class: 'finland-protected-chevron', text: '▾' }),
            el('span', { class: 'finland-subgroup-title', text: label })]);
        if (cat) {
            captionRow.appendChild(el('span', {
                class: 'finland-swatch',
                style: 'background:' + cat.color + (cat.blocked ? ';opacity:.4' : '')
            }));
        }
        captionRow.appendChild(caption);
        section.appendChild(captionRow);

        var body = el('div', {
            class: 'finland-subgroup-body',
            style: 'display:flex;flex-direction:column;gap:6px;overflow:hidden;' +
                'transition:max-height 0.3s ease, opacity 0.3s ease;max-height:4000px;opacity:1;'
        });
        rows.forEach(function (r) { body.appendChild(r); });
        section.appendChild(body);
        section._body = body;

        caption.addEventListener('click', function () {
            var open = body.style.maxHeight !== '0';
            body.style.maxHeight = open ? '0' : (body.scrollHeight + 200) + 'px';
            body.style.opacity = open ? '0' : '1';
            caption.setAttribute('aria-expanded', open ? 'false' : 'true');
            var icon = caption.querySelector('.finland-protected-chevron');
            if (icon) icon.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
            if (runtime.expanded) setExpanded(true);
        });
        return section;
    }

    function buildPanel() {
        var container = document.getElementById(SUB_CONTAINER_ID);
        if (!container) return;
        runtime.rows = {};
        container.innerHTML = '';

        (CONFIG.groups || []).forEach(function (group) {
            var layers = CONFIG.layersOfGroup(group.id).filter(function (l) { return l.enabled !== false; });
            var blocked = CONFIG.layersOfGroup(group.id).filter(function (l) { return l.enabled === false; });
            var children = [];

            if (group.id === 'protected') {
                /* sub-sections in the order the register itself uses */
                CONFIG.subGroupsOf('protected').forEach(function (subGroupId) {
                    var subRows = layers.filter(function (l) { return l.subGroup === subGroupId; })
                        .map(buildRow);
                    if (subRows.length) children.push(buildSubSection(subGroupId, subRows));
                });
                blocked.forEach(function (l) { children.push(buildRow(l)); });
            } else {
                layers.forEach(function (l) { children.push(buildRow(l)); });
                blocked.forEach(function (l) { children.push(buildRow(l)); });
            }
            if (!children.length) return;
            var section = buildSection(group.id, tr(group.label), children);
            container.appendChild(section);
            /* apply the persisted collapsed state */
            if (!isSectionExpanded(group.id)) setSectionExpanded(group.id, false);
            else setSectionExpanded(group.id, true);
        });

        /* re-paint persisted statuses */
        Object.keys(runtime.notices).forEach(function (id) {
            if (runtime.notices[id]) paintStatus(id);
        });
    }

    function syncUI() {
        LAYERS.forEach(function (layer) {
            var entry = runtime.rows[layer.id];
            if (!entry) return;
            var on = !!runtime.active[layer.id];
            if (entry.input) entry.input.checked = on;
            if (entry.row) entry.row.classList.toggle('is-active', on);
            if (entry.pct) entry.pct.textContent = runtime.opacity[layer.id] + '%';
            if (entry.slider && String(entry.slider.value) !== String(runtime.opacity[layer.id])) {
                entry.slider.value = String(runtime.opacity[layer.id]);
            }
        });
        /* section masters: checked when every enabled leaf of the section is
         * on, indeterminate when only some are */
        (CONFIG.groups || []).forEach(function (group) {
            var master = document.getElementById('finlandGroupToggle_' + group.id);
            if (!master) return;
            var leaves = CONFIG.layersOfGroup(group.id).filter(function (l) { return l.enabled !== false; });
            var onCount = leaves.filter(function (l) { return runtime.active[l.id]; }).length;
            master.checked = leaves.length > 0 && onCount === leaves.length;
            master.indeterminate = onCount > 0 && onCount < leaves.length;
        });
        var masterEl = document.getElementById(MASTER_ID);
        if (masterEl) masterEl.checked = LAYERS.some(function (layer) { return runtime.active[layer.id]; });
    }

    /* ── accordion (the whole Finland block) ─────────────────────────────── */

    function setExpanded(expanded) {
        runtime.expanded = !!expanded;
        var container = document.getElementById(SUB_CONTAINER_ID);
        if (container) {
            if (runtime.expanded) {
                container.style.maxHeight = 'none';
                container.style.opacity = '1';
                container.style.marginTop = '0';
                /* then measure once the transition has a chance */
                window.setTimeout(function () {
                    container.style.maxHeight = container.scrollHeight + 800 + 'px';
                }, 30);
            } else {
                container.style.maxHeight = '0';
                container.style.opacity = '0';
            }
        }
        var icon = document.getElementById('finlandExpandIcon');
        if (icon) icon.style.transform = runtime.expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        var btn = document.getElementById('finlandExpandBtn');
        if (btn) btn.setAttribute('aria-expanded', runtime.expanded ? 'true' : 'false');
        save();
    }

    /* ── info ─────────────────────────────────────────────────────────────── */

    function showInfo(layerDef) {
        var title = tr(layerDef.title);
        var attribution = layerDef.attributionRow || CONFIG.attribution;
        var description = layerDef.description || tr(CONFIG.groupInfo);
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, attribution, description);
            return;
        }
        window.alert(title + '\n' + attribution + '\n' + description);
    }

    function showGroupInfo() {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(tr(CONFIG.groupLabel), CONFIG.attribution, tr(CONFIG.groupInfo));
            return;
        }
        window.alert(tr(CONFIG.groupLabel) + '\n' + CONFIG.attribution + '\n' + tr(CONFIG.groupInfo));
    }

    /* ── country filter (the rule the panel already uses) ────────────────── */

    function filterForCountry(iso) {
        var code = String(iso || '').toUpperCase();
        var inCountry = !code || code === String(CONFIG.country || '').toUpperCase();
        Object.keys(runtime.rows).forEach(function (id) {
            var row = runtime.rows[id].row;
            if (!row) return;
            row.classList.toggle('country-layer-unavailable', !inCountry);
            row.setAttribute('aria-hidden', inCountry ? 'false' : 'true');
        });
        var groupRow = document.getElementById(GROUP_ROW_ID);
        if (groupRow) {
            groupRow.classList.toggle('country-layer-unavailable', !inCountry);
            groupRow.setAttribute('aria-hidden', inCountry ? 'false' : 'true');
        }
    }

    /* ── language change ──────────────────────────────────────────────────── */

    function refreshTexts() {
        var activeSnapshot = {}, sectionsSnapshot = {};
        LAYERS.forEach(function (layer) { activeSnapshot[layer.id] = runtime.active[layer.id]; });
        Object.keys(runtime.expandedSections).forEach(function (k) { sectionsSnapshot[k] = runtime.expandedSections[k]; });
        buildPanel();
        runtime.expandedSections = sectionsSnapshot;
        LAYERS.forEach(function (layer) { runtime.active[layer.id] = activeSnapshot[layer.id]; });
        var title = document.getElementById('finlandGroupTitle');
        if (title) title.textContent = tr(CONFIG.groupLabel);
        Object.keys(runtime.notices).forEach(function (id) {
            if (runtime.notices[id]) paintStatus(id);
        });
        filterForCountry(window._detectlabSelectedCountry || '');
        syncUI();
        if (runtime.expanded) setExpanded(true);
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 13. MAP WIRING
     * ═══════════════════════════════════════════════════════════════════════ */

    function onMoveEnd() {
        var map = runtime.map;
        if (!map) return;
        /* WFS families: one debounced query per settled view */
        scheduleWfs();
        /* zoom hints for the rows that are below their minZoom */
        LAYERS.forEach(function (layer) {
            if (!runtime.active[layer.id]) return;
            var below = map.getZoom() < (layer.minZoom || 0);
            if (layer.kind === 'wfs') return;   /* refreshOneWfs handles it */
            setZoomHint(layer, below);
        });
    }

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

    function wireMap(map) {
        map.on('moveend zoomend', function () { ensureActiveOnMap(); onMoveEnd(); });
        map.on('click', function (event) {
            sykeIdentify(event);
            alandIdentify(event);
        });
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
            } else if (tries > 240) {
                window.clearInterval(timer);
                if (window.console) {
                    window.console.warn('[Finland] no Leaflet map found — the Finnish layers stay dormant.');
                }
            }
        }, 250);
    }

    function start() {
        applyStored();
        buildPanel();
        setExpanded(runtime.expanded);
        if (!runtime.expanded) {
            var container = document.getElementById(SUB_CONTAINER_ID);
            if (container) { container.style.maxHeight = '0'; container.style.opacity = '0'; }
        }
        filterForCountry(window._detectlabSelectedCountry || '');
        whenMapReady(function (map) {
            runtime.map = map;
            runtime.ready = true;
            ensurePanes(map);
            wireMap(map);
            /* Restore the session — the first moment anything is requested. */
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) activate(layer);
            });
            onMoveEnd();
            syncUI();
        });
        syncUI();
    }

    document.addEventListener('detectlab:langchange', function () {
        try { refreshTexts(); } catch (e) {}
    });

    function goToView() {
        var map = runtime.map || getMap();
        if (!map || !CONFIG.view) return;
        try { map.setView(CONFIG.view.center, CONFIG.view.zoom, { animate: true }); } catch (e) {}
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 14. PUBLIC API (also the inline handlers in index.html)
     * ═══════════════════════════════════════════════════════════════════════ */

    var API = {
        CONFIG: CONFIG,
        layers: LAYERS,
        state: runtime,
        TEXT: TEXT,
        BLANK_TILE: BLANK_TILE,
        layerIds: function () { return LAYERS.map(function (l) { return l.id; }); },
        init: start,
        toggleGroup: toggleGroup,
        setExpanded: setExpanded,
        toggleSection: toggleSection,
        toggle: function (id, on) {
            var layer = CONFIG.byId(id);
            if (!layer) return;
            var wanted = on === undefined ? !runtime.active[id] : !!on;
            if (wanted) {
                if (runtime.opacity[id] === 0) runtime.opacity[id] =
                    Math.round((typeof layer.opacity === 'number' ? layer.opacity : 1) * 100);
                activate(layer);
            } else {
                deactivate(layer);
            }
            syncUI();
            save();
        },
        activate: function (id) { API.toggle(id, true); },
        deactivate: function (id) { API.toggle(id, false); },
        setOpacity: function (id, value) {
            var layer = CONFIG.byId(id);
            if (layer) setOpacity(layer, value);
        },
        opacityOf: function (id) { return runtime.opacity[id]; },
        isActive: function (id) { return !!runtime.active[id]; },
        activeIds: function () {
            return LAYERS.filter(function (l) { return runtime.active[l.id]; })
                .map(function (l) { return l.id; });
        },
        retry: retryLayer,
        refreshWfs: function (force) {
            LAYERS.forEach(function (layer) {
                if (layer.kind === 'wfs' && runtime.active[layer.id]) refreshOneWfs(layer, !!force);
            });
        },
        filterForCountry: filterForCountry,
        refreshTexts: refreshTexts,
        goToView: goToView,
        showInfo: showInfo,
        showGroupInfo: showGroupInfo,
        /* URL builders — the registry mirror, the proxy tests and the audit
         * tool all use these, so there is exactly one URL per layer. */
        urlBuilders: {
            tm35TileUrl: tm35TileUrl,
            mvtTileUrl: mvtTileUrl,
            wmsTileUrl: wmsTileUrl,
            alandTileUrl: alandTileUrl,
            alandQueryUrl: alandQueryUrl,
            wfsUrl: wfsUrl,
            sykeProxyUrl: sykeProxyUrl
        },
        _test: {
            build: build,
            popupHtml: popupHtml,
            fieldLabel: fieldLabel,
            tr: tr,
            filterForCountry: filterForCountry,
            syncUI: syncUI,
            setStatus: setStatus,
            retryLayer: retryLayer
        }
    };

    window.FinlandLayers = API;
    /* Inline handlers in index.html — the same style as the other groups. */
    window.toggleFinlandLayers = function (on) { API.toggleGroup(!!on); };
    window.toggleFinlandSubLayers = function () {
        API.setExpanded(!runtime.expanded);
    };
    window.setFinlandLayer = function (id, on) { API.toggle(id, on); };
    window.setFinlandOpacity = function (id, value) { API.setOpacity(id, value); };
    window.setFinlandSection = function (groupId, on) { API.toggleSection(groupId, !!on); };
    window.goToFinlandView = function () { API.goToView(); };
    window.showFinlandInfo = function () { API.showGroupInfo(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
