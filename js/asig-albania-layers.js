/*
 * js/asig-albania-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · the ASIG geoportal catalogue for Albania
 *
 * Every row and every Leaflet layer is rendered from data/asig-layers.json
 * (wrapped for the browser by data/asig-layers.data.js) via
 * js/asig-albania-layers.config.js. The module holds no layer names of its own:
 * a new orthophoto, a new mining layer or a new archaeological zoning decision
 * is a re-run of tools/build-asig-catalogue.mjs, not a code change.
 *
 * Panel (all inside the single Albania group, #albaniaRow → #albaniaSubLayers)
 *   • rows in the same style as the other countries' free rows (Romania is
 *     the template): glass `.dl-sublayer-row`, title left and the pill
 *     on/off switch (`.apm-toggle-switch`) right, then the “Opacity” line
 *     with the ⓘ button and `%` badge and a `.transp-slider` slider;
 *   • collapsible Romania-style sections — a `.transp-layer-row` header with
 *     title + count, an expand chevron and a master on/off switch — with
 *     one switch and one opacity slider per layer;
 *   • Heritage is ONE toggle at the top: one checkbox, one opacity slider, one
 *     entry in the active-layer list, one reorder control, one remove button.
 *     Its parts are never rendered as rows;
 *   • a search box filtering by display title or exact layer name;
 *   • an active-layer list with ↑ / ↓ reordering (top of the list = top of the
 *     map) and a per-entry remove button. Reordering is a real z-order: every
 *     catalogue layer draws in ONE Leaflet pane (pane_asig), so the list order
 *     is the draw order.
 *
 * Layer kinds
 *   • wms  — one GeoServer GetMap per tile, the tile's own extent, clipped to
 *            the ASIG footprint. Web Mercator first, EPSG:4326 after a
 *            tile-error burst; the per-workspace endpoint is retried once via
 *            the global service when it returns no tiles (the prototype's
 *            behaviour; which endpoint a layer prefers is unverified).
 *   • wmts — the three tile-only products (Hillshade 2015 group, Dsm Hill
 *            Group, italiane 100k) do not exist in the WMS: it answers HTTP 200
 *            with an XML “LayerNotDefined” exception instead of a tile. The
 *            WMTS exposes no Web Mercator grid. They are mosaicked from the
 *            EPSG:4326 plate-carrée grid and reprojected tile by tile on a
 *            canvas. When a deep level has no cached tiles the layer steps down
 *            to a shallower one and says so in its row.
 *
 * Failure handling
 *   A failed image — including the HTTP 200 XML/HTML bodies this server sends
 *   for a bad layer name — is a Leaflet tile error. Rows report what happened
 *   (“no tiles”, “retrying the alternate endpoint”, “fewer cached levels here”)
 *   instead of silently going blank; console output is one warning per row.
 *
 * Country gate
 *   The group and every row are visible only while Albania (ISO2 AL) is the
 *   selected country; the on/off choice is remembered meanwhile and nothing is
 *   requested for another country or the global view. buildPanel() always
 *   rebuilds the panel inside #albaniaSubLayers, so the catalogue owns exactly
 *   one place in the page.
 *
 * Attribution
 *   ASIG is credited on every layer (Leaflet attribution control) and in every
 *   row's ⓘ popup. ASIG's reuse terms are NOT published in the supplied
 *   capabilities — see the licence note in the group popup and
 *   ALBANIA_ASIG_LAYERS.md before commercial use.
 */
(function (window, document) {
    'use strict';

    var CONFIG = window.ASIG_ALBANIA_CONFIG || window.ASIG_ALBANIA_LAYERS;
    var L = window.L;
    if (!CONFIG || !L || !document) return;
    /* The catalogue missing means the generated data file was not loaded; say
     * so once rather than rendering an empty group. */
    if (!Array.isArray(CONFIG.layers) || !CONFIG.layers.length) {
        if (window.console && window.console.warn) {
            window.console.warn('[ASIG] data/asig-layers.data.js is missing — the Albanian catalogue is not available.');
        }
        return;
    }

    var LAYERS = CONFIG.enabledLayers();
    var HERITAGE = CONFIG.heritageDef || CONFIG.byId('heritage');
    var HERITAGE_ID = HERITAGE ? HERITAGE.id : 'heritage';

    var STORE_KEY = 'detectlab_albania_layers_v2';
    var GROUP_ROW_ID = 'albaniaRow';
    var MOUNT_ID = 'albaniaSubLayers';
    var GROUP_TOGGLE_ID = 'albaniaToggle';
    var EXPAND_BTN_ID = 'albaniaExpandBtn';
    var EXPAND_ICON_ID = 'albaniaExpandIcon';
    var SEARCH_ID = 'albaniaSearch';
    var ACTIVE_ID = 'albaniaActive';
    var PANE_ID = 'pane_asig';
    /* Above the satellite basemap stack (398) and just below the historical-map
     * pane (405); every catalogue layer shares it so the active-layer order is
     * the real draw order. */
    var PANE_Z = 404;
    var Z_BASE = 100;

    var COUNTRY = String(CONFIG.country || 'AL').toUpperCase();
    var OUT_OF_COUNTRY_CLASS = 'albania-out-of-country';
    var BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    var STRINGS = {
        en: {
            opacity: 'Opacity',
            toggle: 'On / off',
            layerInfo: 'Layer information',
            expand: 'Expand section',
            go: 'Tirana',
            unavailable: 'the source is not answering',
            resolving: 'resolving the layer name from the service …',
            unresolved: 'not in the catalogue yet — the layer name could not be read from the service',
            retrying: 'first endpoint returned no tiles; retrying through the alternate one',
            overzoom: 'no cached tiles at this zoom; showing a shallower level enlarged',
            partsFailed: 'parts of this layer return no tiles',
            allFailed: 'no tiles are loading for this layer',
            active: 'Active layers',
            activeEmpty: 'Nothing from the catalogue is on yet.',
            search: 'Search ASIG layers…',
            noMatch: 'No layer matches.',
            moveUp: 'Move up (draw above)',
            moveDown: 'Move down (draw below)',
            remove: 'Remove from the map',
            parts: 'parts',
            infoParts: 'Heritage switches on every part at once',
            licence: 'ASIG has not published reuse terms for this service',
            querying: 'Querying the ASIG service…',
            noFeatures: 'No features at this location.',
            wmtsNoInfo: 'Tile-only layer: the service provides no feature info for it.'
        },
        ro: {
            opacity: 'Opacitate',
            toggle: 'Pornit / oprit',
            layerInfo: 'Informații despre strat',
            expand: 'Deschide secțiunea',
            go: 'Tirana',
            unavailable: 'sursa nu răspunde',
            resolving: 'se rezolvă numele stratului din serviciu …',
            unresolved: 'încă nu e în catalog — numele stratului nu a putut fi citit din serviciu',
            retrying: 'primul endpoint nu a returnat plăci; se reîncearcă prin cel alternativ',
            overzoom: 'nu există plăci la acest zoom; se afișează un nivel mai mic, mărit',
            partsFailed: 'o parte din straturile acestei intrări nu returnează plăci',
            allFailed: 'nu se încarcă nicio placă pentru acest strat',
            active: 'Straturi active',
            activeEmpty: 'Niciun strat din catalog nu este pornit.',
            search: 'Caută în straturile ASIG…',
            noMatch: 'Niciun strat nu corespunde.',
            moveUp: 'Mută mai sus (desenează deasupra)',
            moveDown: 'Mută mai jos (desenează dedesubt)',
            remove: 'Scoate de pe hartă',
            parts: 'părți',
            infoParts: 'Patrimoniu pornește toate părțile deodată',
            licence: 'ASIG nu a publicat termenii de reutilizare pentru acest serviciu',
            querying: 'Se interoghează serviciul ASIG…',
            noFeatures: 'Nicio informație la acest punct.',
            wmtsNoInfo: 'Strat doar cu plăci: serviciul nu oferă informații pentru el.'
        }
    };

    var runtime = {
        ready: false,
        map: null,
        panes: false,
        expanded: true,
        collapsed: {},
        search: '',
        /* Herite is not in `order` unless it is on; the list is bottom → top. */
        order: [],
        active: {},
        opacity: {},
        rows: {},
        entries: {},
        notices: {},
        warned: {},
        inCountry: false,
        suppressed: false,
        resolver: { state: 'idle', names: {}, parts: [], error: '' },
        heritageParts: []
    };

    function lang() {
        try { return typeof window._currentLang === 'function' ? String(window._currentLang()) : 'en'; }
        catch (e) { return 'en'; }
    }
    function text(pair) {
        if (!pair) return '';
        if (typeof pair === 'string') return pair;
        return /^ro/i.test(lang()) ? (pair.ro || pair.en || '') : (pair.en || pair.ro || '');
    }
    function words() { return /^ro/i.test(lang()) ? STRINGS.ro : STRINGS.en; }
    function round(value, places) {
        var factor = Math.pow(10, places);
        return Math.round(value * factor) / factor;
    }
    function mapInstance() { return runtime.map || window._dlMap || window.map || null; }

    /* ═══════════════════════════════════════════════════════════════════════
     * 1. WMS REQUEST — one GetMap per tile, clipped to the ASIG footprint
     * ═══════════════════════════════════════════════════════════════════════ */
    /* The config bounds are Leaflet [[south,west],[north,east]]. Clamp the actual
     * WMS bbox, not just the tile grid, to the published footprint. */
    function projectedBounds(crs) {
        var sw = CONFIG.countryBounds[0], ne = CONFIG.countryBounds[1];
        if (crs === 'EPSG:4326') return [sw[1], sw[0], ne[1], ne[0]];
        var r = 6378137;
        function x(lon) { return r * lon * Math.PI / 180; }
        function y(lat) {
            var rad = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
            return r * Math.log(Math.tan(Math.PI / 4 + rad / 2));
        }
        return [x(sw[1]), y(sw[0]), x(ne[1]), y(ne[0])];
    }
    function clippedBbox(bbox, crs) {
        var bounds = projectedBounds(crs);
        return [Math.max(bbox[0], bounds[0]), Math.max(bbox[1], bounds[1]),
            Math.min(bbox[2], bounds[2]), Math.min(bbox[3], bounds[3])];
    }
    /** GetMap URL for one tile extent. `leaf` needs name/url/format/transparent. */
    function wmsRequestUrl(leaf, bbox, size, crs) {
        var useCrs = crs || CONFIG.wms.crs;
        var clipped = clippedBbox(bbox, useCrs);
        if (!(clipped[2] > clipped[0] && clipped[3] > clipped[1])) return BLANK_TILE;
        /* In WMS 1.3.0, EPSG:4326 has latitude/longitude axis order. */
        var requestBbox = useCrs === 'EPSG:4326'
            ? [clipped[1], clipped[0], clipped[3], clipped[2]] : clipped;
        var params = [
            'SERVICE=WMS',
            'VERSION=' + encodeURIComponent(CONFIG.wms.version),
            'REQUEST=GetMap',
            'LAYERS=' + encodeURIComponent(leaf.name || ''),
            'STYLES=' + encodeURIComponent(CONFIG.wms.styles || ''),
            'CRS=' + encodeURIComponent(useCrs),
            'BBOX=' + requestBbox.map(function (v) { return round(v, useCrs === 'EPSG:4326' ? 7 : 4); }).join(','),
            'WIDTH=' + (size || CONFIG.wms.tileSize),
            'HEIGHT=' + (size || CONFIG.wms.tileSize),
            'FORMAT=' + encodeURIComponent(leaf.format || 'image/png'),
            'TRANSPARENT=' + (leaf.transparent === false ? 'FALSE' : 'TRUE')
        ];
        return String(leaf.url || CONFIG.wms.url) + '?' + params.join('&');
    }

    /* The offline audit (tools/audit-wms-layers.mjs) builds one regression URL
     * per registry row through this function — keep the signature. */
    function tileUrl(id, bbox, size, crs) {
        var def = CONFIG.byId(id);
        if (!def) throw new Error('Unknown ASIG layer: ' + id);
        /* Tile-only rows have no WMS layer; the Heritage entry's LAYERS value
         * is the comma list of its baked parts (WMS accepts that). */
        if (def.kind === 'wmts' || !def.layers) return '';
        return wmsRequestUrl({
            name: def.name || def.layers,
            url: def.url,
            format: def.format,
            transparent: def.transparent
        }, bbox, size, crs);
    }

    var AsigWmsLayer = L.TileLayer.extend({
        options: {
            crs: CONFIG.wms.crs, tileSize: CONFIG.wms.tileSize, minZoom: 7, maxZoom: 20,
            keepBuffer: CONFIG.wms.keepBuffer, opacity: 1, attribution: CONFIG.attribution,
            errorTileUrl: BLANK_TILE, updateWhenZooming: false, updateWhenIdle: true,
            noWrap: true, crossOrigin: false
        },
        initialize: function (leaf, options) {
            this._leaf = {
                name: leaf.name,
                url: leaf.url,
                fallbackUrl: leaf.fallbackUrl || leaf.url,
                format: leaf.format || 'image/png',
                transparent: leaf.transparent !== false
            };
            this._layerId = leaf.id;
            this._errorCount = 0;
            this._warned = false;
            L.setOptions(this, options || {});
            this.options.minZoom = leaf.minZoom || 7;
            this.options.maxNativeZoom = leaf.maxNativeZoom || 19;
            this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            L.TileLayer.prototype.initialize.call(this, '', this.options);
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
        createTile: function (coords, done) {
            var tile = document.createElement('img');
            var settled = false;
            function finish(error) {
                if (settled) return;
                settled = true;
                done(error || null, tile);
            }
            tile.alt = '';
            if (tile.setAttribute) tile.setAttribute('role', 'presentation');
            tile.onload = function () {
                /* Invalid 200 XML/HTML and other non-image bodies fail image
                 * decoding (zero natural dimensions) just like network errors. */
                if (!tile.naturalWidth || !tile.naturalHeight) finish(new Error('ASIG returned a non-image tile'));
                else finish(null);
            };
            tile.onerror = function () { finish(new Error('ASIG tile request failed or returned XML/HTML')); };
            var url = this.getTileUrl(coords);
            if (url === BLANK_TILE) {
                tile.src = BLANK_TILE;
                return tile;
            }
            tile.src = url;
            return tile;
        },
        /** Switch the endpoint once (per-workspace → global service). */
        setEndpoint: function (url) {
            if (!url || url === this._leaf.url) return false;
            this._leaf.url = url;
            this._errorCount = 0;
            this.redraw();
            return true;
        },
        endpoint: function () { return this._leaf.url; },
        _onTileLoad: function () { this._errorCount = 0; },
        _onTileError: function () {
            var literal = this._leaf;
            this._errorCount += 1;
            reportFailure(this);
            if (!this._warned) {
                this._warned = true;
                warnOnce(literal.name, 'tile image failed; retrying with EPSG:4326 after the error burst');
            }
            if (this.options.crs === CONFIG.wms.crs && this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                this.options.crs = CONFIG.wms.fallbackCrs;
                this._errorCount = 0;
                this.redraw();
                return;
            }
            if (this.options.crs === CONFIG.wms.fallbackCrs && this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                this._errorCount = 0;
                setStatus(this._layerId, words().unavailable, 'error');
            }
        },
        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast(), size = this.getTileSize();
            var crs = this.options.crs;
            var bbox;
            if (crs === 'EPSG:4326') bbox = [sw.lng, sw.lat, ne.lng, ne.lat];
            else {
                /* Call project() ON the CRS object: Leaflet's CRS.project reads
                 * this.projection, so a detached reference throws. */
                var mapCrs = (this._map && this._map.options && this._map.options.crs) || L.CRS.EPSG3857;
                var a = mapCrs.project(sw), b = mapCrs.project(ne);
                bbox = [a.x, a.y, b.x, b.y];
            }
            return wmsRequestUrl(this._leaf, bbox, size.x, crs);
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * 2. WMTS → WEB MERCATOR — the three tile-only layers
     * ═══════════════════════════════════════════════════════════════════════
     * The WMTS publishes no Web-Mercator matrix set, so each destination tile is
     * filled with a canvas mosaic of the EPSG:4326 plate-carrée tiles that
     * cover it. In that grid level z is 256-px tiles over 2^(z+1) columns and
     * 2^z rows, top-left at -180/90. Longitude is linear in both systems;
     * latitude is not, so every destination pixel row picks its own source row
     * (planWmtsTile). Proven in the owner's prototype; kept verbatim in shape.
     */
    function planWmtsTile(Z, tx, ty, size, maxZ) {
        var z = Math.min(maxZ, Z);
        var n = Math.pow(2, Z);
        var W = 256 * Math.pow(2, z + 1), H = 256 * Math.pow(2, z);
        var pxL = (tx / n) * W, pxR = ((tx + 1) / n) * W;
        function latAt(f) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + f) / n))) * 180 / Math.PI; }
        var rows = [];
        for (var j = 0; j < size; j++) {
            var a = (90 - latAt(j / size)) / 180 * H;
            var b = (90 - latAt((j + 1) / size)) / 180 * H;
            var mid = (a + b) / 2;
            var sh = Math.min(Math.max(b - a, 0.01), 256);
            var r = Math.max(0, Math.min(Math.floor(mid / 256), Math.pow(2, z) - 1));
            rows.push({ r: r, sy: Math.max(0, Math.min(mid - sh / 2 - r * 256, 256 - sh)), sh: sh });
        }
        var cols = [];
        for (var c = Math.floor(pxL / 256); c <= Math.ceil(pxR / 256) - 1; c++) {
            var s0 = Math.max(pxL, c * 256), s1 = Math.min(pxR, (c + 1) * 256);
            cols.push({
                c: c, sx: s0 - c * 256, sw: s1 - s0,
                dx: (s0 - pxL) / (pxR - pxL) * size,
                dw: (s1 - s0) / (pxR - pxL) * size
            });
        }
        return { z: z, rows: rows, cols: cols };
    }

    /* Adjacent Mercator tiles often use the same plate-carrée source image.
     * Share in-flight requests and retain a bounded LRU of decoded images, so
     * panning/reprojection does not repeatedly download and decode them. */
    var wmtsImages = new Map();
    function loadWmtsImage(url, callback) {
        var cached = wmtsImages.get(url);
        if (cached && cached.failedAt && Date.now() - cached.failedAt >= 15000) {
            wmtsImages.delete(url);
            cached = null;
        }
        if (cached) {
            wmtsImages.delete(url);
            wmtsImages.set(url, cached);
            if (cached.waiters) cached.waiters.push(callback);
            else callback(cached.image);
            return;
        }
        var entry = { waiters: [callback], image: null, failedAt: 0 };
        wmtsImages.set(url, entry);
        var img = document.createElement('img');
        function finish(image) {
            if (!entry.waiters) return;
            img.onload = img.onerror = null;
            entry.image = image;
            entry.failedAt = image ? 0 : Date.now();
            var waiters = entry.waiters;
            entry.waiters = null;
            // Never evict an in-flight entry: its consumers still need it.
            var completed = 0;
            wmtsImages.forEach(function (item) { if (!item.waiters) completed++; });
            wmtsImages.forEach(function (item, key) {
                if (completed > 128 && !item.waiters) { wmtsImages.delete(key); completed--; }
            });
            waiters.forEach(function (notify) { notify(image); });
        }
        // No crossOrigin: ASIG does not provide CORS for these images.
        img.onload = function () { finish(img.naturalWidth && img.naturalHeight ? img : null); };
        img.onerror = function () { finish(null); };
        img.src = url;
    }

    var AsigWmtsLayer = L.GridLayer.extend({
        options: {
            tileSize: CONFIG.wmts.tileSize, opacity: 1, attribution: CONFIG.attribution,
            updateWhenZooming: false, updateWhenIdle: true, keepBuffer: CONFIG.wmts.keepBuffer,
            noWrap: true, minZoom: 7, maxZoom: 22
        },
        initialize: function (part, options) {
            this._part = { id: part.id, name: part.name, url: part.url || CONFIG.wmts.url, title: part.title };
            this._maxSourceZoom = CONFIG.wmts.maxSourceZoom;
            this._stats = { ok: 0, err: 0, deep: {}, okLevel: {}, overzoomLevel: null };
            L.setOptions(this, options || {});
            this.options.minZoom = part.minZoom || 7;
            this.options.maxNativeZoom = part.maxNativeZoom || 20;
            this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            L.GridLayer.prototype.initialize.call(this, this.options);
        },
        /** The WMTS GetTile URL for one plate-carrée tile. */
        tileUrl: function (level, col, row) {
            return CONFIG.wmtsTileUrl(this._part.name, level, col, row);
        },
        createTile: function (coords, done) {
            var size = this.getTileSize().x;
            var canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            if (canvas.setAttribute) canvas.setAttribute('role', 'presentation');
            var self = this;
            var st = this._stats;
            function lost(level) { return (st.deep[level] || 0) >= 3 && !st.okLevel[level]; }
            var lowest = Math.max(0, coords.z - 10);
            var start = Math.min(this._maxSourceZoom, coords.z);
            while (start > lowest && lost(start)) start--;
            var failed = [];
            function attempt(level) {
                var plan = planWmtsTile(coords.z, coords.x, coords.y, size, level);
                var images = new Map();
                plan.rows.forEach(function (row) {
                    plan.cols.forEach(function (col) { images.set(col.c + '/' + row.r, null); });
                });
                var pending = images.size, loaded = 0;
                function finish() {
                    if (!loaded) {
                        if (level > lowest) {
                            failed.push(level);
                            attempt(level - 1);
                        } else {
                            st.err += 1;
                            reportFailure(self);
                            done(new Error('ASIG WMTS: no source tiles at any level'), canvas);
                        }
                        return;
                    }
                    failed.forEach(function (level_) { st.deep[level_] = (st.deep[level_] || 0) + 1; });
                    if (level < coords.z - 1 && (st.overzoomLevel == null || level > st.overzoomLevel)) {
                        st.overzoomLevel = level;
                    }
                    st.ok += 1;
                    st.okLevel[level] = (st.okLevel[level] || 0) + 1;
                    done(null, canvas);
                }
                if (!pending) { finish(); return; }
                images.forEach(function (_, key) {
                    var split = key.split('/');
                    loadWmtsImage(self.tileUrl(plan.z, Number(split[0]), Number(split[1])), function (img) {
                        if (img) {
                            images.set(key, img);
                            loaded += 1;
                            // Paint each available source immediately rather than
                            // waiting for the slowest image in the mosaic.
                            var context = null;
                            try { context = canvas.getContext && canvas.getContext('2d'); } catch (e) {}
                            if (context) plan.rows.forEach(function (row, j) {
                                if (row.r !== Number(split[1])) return;
                                plan.cols.forEach(function (col) {
                                    if (col.c === Number(split[0])) context.drawImage(img, col.sx, row.sy, col.sw, row.sh, col.dx, j, col.dw, 1);
                                });
                            });
                        }
                        if (!--pending) finish();
                    });
                });
            }
            attempt(start);
            return canvas;
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * 3. SMALL DOM HELPERS + status
     * ═══════════════════════════════════════════════════════════════════════ */
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            var value = attrs[key];
            if (value == null || value === false) return;
            if (key === 'text') node.textContent = value;
            else if (key === 'className') node.className = value;
            else if (key === 'htmlFor') node.setAttribute('for', value);
            else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else node.setAttribute(key, value === true ? '' : String(value));
        });
        (children || []).forEach(function (child) {
            if (child == null || child === false) return;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    }
    function clear(node) { if (node && node.replaceChildren) node.replaceChildren(); else if (node) node.innerHTML = ''; }
    function warnOnce(key, detail) {
        if (!key || runtime.warned[key]) return;
        runtime.warned[key] = true;
        if (window.console && window.console.warn) window.console.warn('[ASIG] ' + key + ': ' + detail);
    }
    /* The shared availability guard counts failures per host. These rows are
     * self-guarded (their own status line and active-list hint do the talking),
     * but a tile error is still reported so the guard's host verdict stays
     * honest; noteFailure() is a no-op for a layer the guard does not watch. */
    function reportFailure(layer) {
        try {
            if (window.DetectLabWmsHealth && typeof window.DetectLabWmsHealth.noteFailure === 'function') {
                window.DetectLabWmsHealth.noteFailure(layer);
            }
        } catch (e) { /* the guard must never break the row */ }
    }
    function setStatus(id, message, kind) {
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        row.status.textContent = message || '';
        if (row.status.style) row.status.style.display = message ? 'block' : 'none';
        row.status.className = 'albania-layer-status' + (kind ? ' is-' + kind : '');
        if (row.status.setAttribute) row.status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        if (message) runtime.notices[id] = { text: message, kind: kind };
        else delete runtime.notices[id];
    }
    function info(def) {
        var title = text(def.title);
        var description = def.description || '';
        if (def.kind === 'group') {
            var parts = currentHeritageParts();
            description = (def.description || '') + ' ' + words().infoParts + ' (' + parts.length + ' ' + words().parts + '): ' +
                parts.map(function (part) { return text(part.title) + (part.name ? ' — ' + part.name : ''); }).join(' · ');
        }
        description += ' ' + CONFIG.attribution + '. ' + words().licence + '.';
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, CONFIG.attribution, description);
        } else if (window.alert) window.alert(title + '\n' + CONFIG.attribution + '\n' + description);
    }
    function gotoTirana() {
        var map = mapInstance();
        if (map && map.setView) map.setView(CONFIG.view.center, CONFIG.view.zoom, { animate: true });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 4. THE PANEL — heritage toggle, search, active list, sections
     * ═══════════════════════════════════════════════════════════════════════ */
    /* Parts that can actually draw: a baked part with a name, plus whatever the
     * browser resolved. The catalogue's dynamic placeholder is a rule, not a
     * layer, and an unnamed part cannot be requested — neither is counted, so
     * the row does not promise layers it cannot switch on. */
    function currentHeritageParts() {
        var baked = (HERITAGE ? HERITAGE.parts : []).filter(function (part) {
            return !part.dynamic && part.name;
        });
        return baked.concat(runtime.resolver.parts || []);
    }

    function sectionById(id) {
        var list = CONFIG.sections || [];
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }

    /* One layer row, in the same shape as the other countries' free rows
     * (Romania's hand-written markup in index.html is the template): the
     * glass `.dl-sublayer-row` shell, the layer's title on the left and the
     * pill on/off switch (`.apm-toggle-switch`) on the right of the header
     * line, then the “Opacity” line — word left, ⓘ button and `%` badge
     * right — and the shared `.transp-slider` slider. Albania keeps one
     * extra: the little Tirana fly-to button next to the switch. The ids
     * stay the ones the registry and the vertical-opacity control already
     * watch (`albaniaToggle_/albaniaOpacity_/albaniaPct_` + id). */
    function createRow(def) {
        var row = el('div', {
            className: 'albania-layer-row dl-sublayer-row' +
                (def.section === 'lidar' ? ' lidar-country-row' : '') +
                (def.kind === 'group' ? ' albania-layer-group' : ''),
            id: 'albaniaRow_' + def.id,
            'data-category': 'free',
            'data-albania-row': def.id
        });
        var input = el('input', {
            type: 'checkbox',
            id: 'albaniaToggle_' + def.id,
            'aria-label': text(def.title) + ' — ' + words().toggle
        });
        input.checked = !!runtime.active[def.id];
        if (row.classList) row.classList.toggle('is-active', !!runtime.active[def.id]);
        input.addEventListener('change', function () { toggle(def.id, input.checked); });
        var titleNode = el('span', { className: 'albania-layer-title', text: text(def.title) });
        var partsNode = def.kind === 'group'
            ? el('span', { className: 'albania-layer-parts', text: currentHeritageParts().length + ' ' + words().parts })
            : null;
        var titleWrap = el('span', {
            style: 'display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;'
        }, [titleNode, partsNode]);

        var go = el('button', {
            type: 'button', className: 'albania-layer-go', text: words().go, title: 'Centre map on Tirana'
        });
        go.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            gotoTirana();
        });
        var switchLabel = el('label', {
            className: 'apm-toggle-switch',
            style: 'transform:scale(0.85);',
            title: text(def.title) + ' — ' + words().toggle
        }, [input, el('span', { className: 'apm-toggle-track' })]);
        var headRight = el('span', {
            style: 'display:inline-flex;align-items:center;gap:6px;flex-shrink:0;'
        }, [go, switchLabel]);
        var head = el('div', {
            style: 'display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;margin-bottom:6px;gap:8px;'
        }, [titleWrap, headRight]);
        row.appendChild(head);

        var infoBtn = el('button', {
            type: 'button', className: 'layer-info-btn', title: words().layerInfo,
            'aria-label': words().layerInfo, text: 'ⓘ'
        });
        infoBtn.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            info(def);
        });
        var pct = el('span', { className: 'pct', id: 'albaniaPct_' + def.id, text: runtime.opacity[def.id] + '%' });
        var opacityRight = el('span', {
            style: 'display:flex;align-items:center;gap:4px;flex-shrink:0;'
        }, [infoBtn, pct]);
        var opacityLine = el('div', {
            className: 'transp-layer-label', style: 'margin-bottom:5px;'
        }, [
            el('span', { style: 'font-size:0.72rem;opacity:0.7;', text: words().opacity }),
            opacityRight
        ]);
        row.appendChild(opacityLine);
        var slider = el('input', {
            type: 'range',
            className: 'transp-slider' + (def.section === 'lidar' ? ' lidar-country-opacity' : ''),
            id: 'albaniaOpacity_' + def.id, min: '0', max: '100',
            value: String(runtime.opacity[def.id]),
            'aria-label': text(def.title) + ' ' + words().opacity
        });
        slider.addEventListener('input', function () { setOpacity(def.id, slider.value); });
        row.appendChild(slider);
        var status = el('div', {
            className: 'albania-layer-status', id: 'albaniaStatus_' + def.id, role: 'status',
            style: 'display:none;padding-left:0;'
        });
        if (status.style) status.style.display = 'none';
        row.appendChild(status);

        runtime.rows[def.id] = {
            row: row, input: input, slider: slider, status: status, go: go,
            pct: pct, title: titleNode, parts: partsNode, info: infoBtn
        };
        return row;
    }

    /* One collapsible section, headered like the other countries' groups
     * (Romania in index.html is the template): a `.transp-layer-row` shell
     * whose `.transp-layer-label` header carries the section title and row
     * count on the left and, on the right, the expand chevron button and a
     * master pill switch that turns the whole section on or off. Sections
     * start expanded (as Albania's always have); the collapsed choice is
     * persisted exactly as before. */
    function sectionNode(sectionId) {
        var section = sectionById(sectionId) || { id: sectionId, title: sectionId };
        var defs = LAYERS.filter(function (def) { return def.section === sectionId; });
        var collapsed = !!runtime.collapsed[sectionId];
        var sectionTitle = text(section.label || section.title);

        var icon = el('span', {
            style: 'display:inline-block;transition:transform 0.25s ease;font-size:12px;opacity:0.75;line-height:1;',
            text: '▾'
        });
        if (icon.style) icon.style.transform = collapsed ? 'rotate(-90deg)' : '';
        var expandButton = el('button', {
            type: 'button',
            id: 'albaniaSectionHead_' + sectionId,
            style: 'background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:2px 4px;line-height:1;display:inline-flex;align-items:center;flex-shrink:0;',
            'aria-expanded': collapsed ? 'false' : 'true',
            'aria-label': sectionTitle + ' — ' + words().expand,
            title: words().expand
        }, [icon]);
        expandButton.addEventListener('click', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();
            toggleSection(sectionId);
        });

        var master = el('input', {
            type: 'checkbox',
            id: 'albaniaSectionToggle_' + sectionId,
            'aria-label': sectionTitle + ' — ' + words().toggle
        });
        master.addEventListener('change', function () { toggleSectionLayers(sectionId, !!master.checked); });
        var masterLabel = el('label', {
            className: 'apm-toggle-switch',
            style: 'transform:scale(0.85);',
            title: sectionTitle + ' — ' + words().toggle
        }, [master, el('span', { className: 'apm-toggle-track' })]);

        var titleSpan = el('span', {
            style: 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;min-width:0;'
        }, [
            el('span', { className: 'albania-section-title', text: sectionTitle }),
            el('span', { className: 'albania-section-count', text: '(' + defs.length + ')' })
        ]);
        var rightSpan = el('span', {
            style: 'display:flex;align-items:center;gap:4px;flex-shrink:0;'
        }, [expandButton, masterLabel]);
        var head = el('div', {
            className: 'transp-layer-label',
            style: 'margin-bottom:6px;',
            'aria-expanded': collapsed ? 'false' : 'true',
            title: sectionTitle
        }, [titleSpan, rightSpan]);

        var body = el('div', { className: 'albania-section-body', id: 'albaniaSectionBody_' + sectionId });
        if (collapsed) if (body.style) body.style.display = 'none';
        defs.forEach(function (def) { body.appendChild(createRow(def)); });
        var wrapper = el('div', {
            className: 'albania-section transp-layer-row', id: 'albaniaSection_' + sectionId,
            'data-albania-section': sectionId, 'data-category': 'free'
        }, [head, body]);
        runtime.sectionNodes = runtime.sectionNodes || {};
        runtime.sectionNodes[sectionId] = {
            wrapper: wrapper, head: head, body: body,
            master: master, icon: icon, button: expandButton
        };
        syncSectionMaster(sectionId);
        return wrapper;
    }

    /* Master switch of one section: on when every layer in it is on the
     * map, indeterminate (the pill's half-way state) when only some are. */
    function syncSectionMaster(sectionId) {
        var node = runtime.sectionNodes && runtime.sectionNodes[sectionId];
        if (!node || !node.master) return;
        var defs = LAYERS.filter(function (def) { return def.section === sectionId; });
        var on = 0;
        defs.forEach(function (def) { if (runtime.active[def.id]) on += 1; });
        node.master.checked = defs.length > 0 && on === defs.length;
        node.master.indeterminate = on > 0 && on < defs.length;
    }

    function syncSectionMasters() {
        (CONFIG.sections || []).forEach(function (section) { syncSectionMaster(section.id); });
    }

    function toggleSectionLayers(sectionId, on) {
        LAYERS.filter(function (def) { return def.section === sectionId; })
            .forEach(function (def) { toggle(def.id, on); });
        syncSectionMaster(sectionId);
    }

    function toolsNode() {
        var search = el('input', {
            type: 'search',
            id: SEARCH_ID,
            className: 'albania-search',
            placeholder: words().search,
            'aria-label': words().search,
            autocomplete: 'off',
            spellcheck: 'false'
        });
        search.value = runtime.search;
        search.addEventListener('input', function () { setSearch(search.value); });
        var active = el('div', { className: 'albania-active', id: ACTIVE_ID });
        return el('div', { className: 'albania-catalogue-tools' }, [search, active]);
    }

    /* The panel's Free/Premium tabs gate rows purely by `data-category` +
     * `.active` (switchLayerTab in js/map-app.js, `.transp-layer-row
     * [data-category]` in css/styles.css). Every Albanian row is FREE —
     * Heritage included — so none of them may ever appear in the Premium
     * tab. (Heritage once did: its block was a plain div with no
     * data-category, so the tab CSS never hid it and it showed in both
     * tabs.) switchLayerTab only re-marks nodes that exist when a tab is
     * clicked, and a rebuild (language change) creates fresh nodes with
     * no `.active`; re-apply the current tab after every build so the
     * free rows are visible in the Free tab and absent from Premium. */
    function currentPanelTab() {
        try {
            if (typeof document.querySelector === 'function') {
                var btn = document.querySelector('.transp-panel-tabs button.active');
                if (btn) {
                    if (btn.dataset && btn.dataset.tab) return btn.dataset.tab;
                    if (btn.getAttribute) return btn.getAttribute('data-tab') || 'free';
                }
            }
        } catch (e) { /* the tab bar is best-effort; Free is the default */ }
        return 'free';
    }

    function applyPanelTab() {
        var free = currentPanelTab() === 'free';
        var nodes = [];
        if (runtime.heritageBlock) nodes.push(runtime.heritageBlock);
        Object.keys(runtime.sectionNodes || {}).forEach(function (id) {
            var node = runtime.sectionNodes[id];
            if (node && node.wrapper) nodes.push(node.wrapper);
        });
        nodes.forEach(function (node) {
            if (node.classList) node.classList.toggle('active', free);
        });
    }

    function buildPanel() {
        runtime.rows = {};
        runtime.sectionNodes = {};
        runtime.heritageBlock = null;
        var mount = document.getElementById(MOUNT_ID);
        if (mount) {
            clear(mount);
            // Sections are normal layer-list entries, not a country catalogue.
            var lidarMount = document.getElementById('albaniaLidarLayers');
            if (lidarMount) clear(lidarMount);
            /* Heritage is ONE toggle at the top of the panel — never a group of
             * rows and never inside a section, so its parts cannot be mistaken
             * for layers the visitor has to switch on one by one. */
            if (HERITAGE) {
                /* data-category="free" + transp-layer-row is what keeps this
                 * block in the Free tab only (see applyPanelTab above). */
                var heritageBlock = el('div', { className: 'albania-heritage-block transp-layer-row', 'data-category': 'free' }, [
                    el('div', { className: 'albania-heritage-caption', text: text(HERITAGE.title) }),
                    createRow(HERITAGE),
                    el('div', {
                        className: 'albania-heritage-note',
                        text: words().infoParts + ' (' + currentHeritageParts().length + ' ' + words().parts + ')'
                    })
                ]);
                runtime.heritageBlock = heritageBlock;
                mount.appendChild(heritageBlock);
            }
            (CONFIG.sections || []).forEach(function (section) {
                if (section.id === HERITAGE_ID) return;
                if (section.id === 'lidar' && lidarMount) {
                    // Reuse the existing LiDAR accordion; render each source once.
                    LAYERS.filter(function (def) { return def.section === 'lidar'; })
                        .forEach(function (def) { lidarMount.appendChild(createRow(def)); });
                } else {
                    var sectionRow = sectionNode(section.id);
                    sectionRow.classList.add('transp-layer-row');
                    sectionRow.setAttribute('data-category', 'free');
                    mount.appendChild(sectionRow);
                }
            });
        }
        Object.keys(runtime.rows).forEach(function (id) {
            if (runtime.notices[id]) setStatus(id, runtime.notices[id].text, runtime.notices[id].kind);
        });
        renderActive();
        applySearch();
        setExpanded(runtime.expanded);
        /* Rebuilding the DOM must not undo the country gate. */
        applyCountryVisibility(runtime.inCountry);
        /* …nor the Free/Premium tab gate (Heritage is free-tab only). */
        applyPanelTab();
        refreshResolverNotices();
    }

    function toggleSection(sectionId) {
        runtime.collapsed[sectionId] = !runtime.collapsed[sectionId];
        var node = runtime.sectionNodes && runtime.sectionNodes[sectionId];
        if (node) {
            var collapsed = !!runtime.collapsed[sectionId];
            if (node.body.style) node.body.style.display = collapsed ? 'none' : '';
            node.head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            if (node.button) node.button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            if (node.icon && node.icon.style) node.icon.style.transform = collapsed ? 'rotate(-90deg)' : '';
        }
        save();
    }

    /* Diacritics-insensitive comparison: visitors type "Durres", "Shkoder" or
     * "Kruje", while the catalogue keeps the portal's "Durrës", "Shkodër",
     * "Krujë". NFD splits the accent off the base letter, so stripping the
     * combining marks makes both spellings the same search term. */
    function fold(value) {
        var out = String(value == null ? '' : value).toLowerCase();
        if (out.normalize) out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return out.replace(/[đĐ]/g, 'd').replace(/[_\s]+/g, ' ').trim();
    }

    function applySearch() {
        var query = fold(runtime.search);
        var matched = {};
        var visible = 0;
        LAYERS.forEach(function (def) {
            var row = runtime.rows[def.id];
            if (!row) return;
            /* The Heritage toggle is searchable by EVERY part, so
             * “zonat_mbrojtura” or “arkeologjike” finds it even though the
             * parts are never rows of their own. */
            var heritageText = def.kind === 'group'
                ? ' heritage archaeolog archeolog arkeolog ' + currentHeritageParts().map(function (part) {
                    return text(part.title) + ' ' + (part.name || '');
                }).join(' ')
                : '';
            var haystack = fold(text(def.title) + ' ' + def.title.en + ' ' + (def.name || '') + ' ' +
                heritageText);
            matched[def.id] = !query || haystack.indexOf(query) !== -1;
            if (row.row.style) row.row.style.display = matched[def.id] ? '' : 'none';
            if (matched[def.id]) visible += 1;
        });
        (CONFIG.sections || []).forEach(function (section) {
            var node = runtime.sectionNodes && runtime.sectionNodes[section.id];
            if (!node) return;
            if (section.id === HERITAGE_ID) {
                /* Heritage has no section node; it is the bare toggle above. */
                return;
            }
            var shown = LAYERS.filter(function (def) {
                return def.section === section.id && matched[def.id];
            }).length;
            if (node.wrapper.style) node.wrapper.style.display = shown ? '' : 'none';
            /* A search overrides the collapsed state so matches are visible. */
            if (node.body.style) node.body.style.display = (!query && runtime.collapsed[section.id]) ? 'none' : '';
        });
        if (HERITAGE && runtime.rows[HERITAGE_ID] && !query && runtime.rows[HERITAGE_ID].row.style) {
            runtime.rows[HERITAGE_ID].row.style.display = '';
        }
        var empty = document.getElementById('albaniaSearchEmpty');
        if (query && !visible) {
            if (!empty) {
                var mount = document.getElementById(MOUNT_ID);
                if (mount) {
                    mount.appendChild(el('div', { className: 'empty', id: 'albaniaSearchEmpty', text: words().noMatch }));
                }
            }
        } else if (empty && empty.parentNode) {
            empty.parentNode.removeChild(empty);
        }
        return visible;
    }

    function setSearch(value) {
        runtime.search = String(value == null ? '' : value);
        applySearch();
    }

    /* ── active layers: the real draw order, top of the list = top of the map ── */
    function orderList() {
        return runtime.order.slice();
    }
    function hasActive() {
        return runtime.order.length > 0;
    }
    function syncOrder() {
        runtime.order = runtime.order.filter(function (id) { return !!runtime.active[id]; });
        LAYERS.forEach(function (def) {
            if (runtime.active[def.id] && runtime.order.indexOf(def.id) === -1) runtime.order.push(def.id);
        });
    }
    function applyZOrder() {
        syncOrder();
        runtime.order.forEach(function (id, index) {
            var entry = runtime.entries[id];
            if (!entry) return;
            entry.parts.forEach(function (part) {
                if (part.layer && part.layer.setZIndex) part.layer.setZIndex(Z_BASE + index);
            });
        });
    }

    function renderActive() {
        var box = document.getElementById(ACTIVE_ID);
        if (!box) return;
        clear(box);
        var list = orderList().slice().reverse();   /* top of list = top of map */
        if (!list.length) {
            box.appendChild(el('div', { className: 'empty albania-active-empty', text: words().activeEmpty }));
            return;
        }
        box.appendChild(el('div', { className: 'albania-active-head', text: words().active + ' (' + list.length + ')' }));
        list.forEach(function (id) {
            var def = CONFIG.byId(id);
            if (!def) return;
            var entry = runtime.entries[id];
            var slider = el('input', {
                type: 'range', className: 'albania-active-slider', min: '0', max: '100',
                value: String(runtime.opacity[id]),
                'aria-label': text(def.title) + ' ' + words().opacity
            });
            slider.addEventListener('input', function () { setOpacity(id, slider.value); });
            var item = el('div', { className: 'albania-active-item', 'data-active-id': id }, [
                el('div', { className: 'albania-active-top' }, [
                    el('b', { text: text(def.title) }),
                    def.kind === 'group' ? el('span', { className: 'albania-active-parts', text: currentHeritageParts().length + ' ' + words().parts }) : null,
                    el('button', {
                        type: 'button', className: 'albania-active-move', 'data-dir': 'up',
                        title: words().moveUp, 'aria-label': words().moveUp, text: '↑',
                        onclick: function () { moveActive(id, 1); }
                    }),
                    el('button', {
                        type: 'button', className: 'albania-active-move', 'data-dir': 'down',
                        title: words().moveDown, 'aria-label': words().moveDown, text: '↓',
                        onclick: function () { moveActive(id, -1); }
                    }),
                    el('button', {
                        type: 'button', className: 'albania-active-remove',
                        title: words().remove, 'aria-label': words().remove, text: '✕',
                        onclick: function () { toggle(id, false); }
                    })
                ]),
                slider
            ]);
            if (entry) {
                var overzoom = entry.parts.some(function (part) { return part.stats && part.stats.overzoomLevel != null; });
                var bad = entry.parts.filter(function (part) { return part.warn && !part.ok; });
                var retrying = entry.parts.some(function (part) { return part.switched && !part.warn && !part.ok; });
                if (overzoom) item.appendChild(el('div', { className: 'albania-active-hint', text: words().overzoom }));
                if (retrying && !bad.length) item.appendChild(el('div', { className: 'albania-active-hint', text: words().retrying }));
                if (bad.length) {
                    item.appendChild(el('div', {
                        className: 'albania-active-hint is-warn',
                        text: (entry.parts.length > 1 ? bad.length + '/' + entry.parts.length + ' ' + words().partsFailed : words().allFailed)
                    }));
                }
            }
            box.appendChild(item);
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 5. LAYER LIFECYCLE
     * ═══════════════════════════════════════════════════════════════════════ */
    function ensurePanes(map) {
        if (runtime.panes || !map || !map.createPane) return;
        var pane = map.getPane && map.getPane(PANE_ID);
        if (!pane) pane = map.createPane(PANE_ID);
        if (pane && pane.style) {
            pane.style.zIndex = String(PANE_Z);
            /* Tiles are decoration: never steal a click from the map. */
            pane.style.pointerEvents = 'none';
        }
        runtime.panes = true;
    }

    function attachPart(entry, leaf) {
        var part = {
            leaf: leaf,
            layer: null,
            ok: 0,
            err: 0,
            switched: false,
            warn: false
        };
        if (!leaf.name) {
            part.missingName = true;
            entry.parts.push(part);
            return part;
        }
        var layer = leaf.kind === 'wmts'
            ? new AsigWmtsLayer(leaf, {
                pane: PANE_ID,
                opacity: entry.opacity,
                attribution: CONFIG.attribution,
                minZoom: leaf.minZoom,
                maxNativeZoom: leaf.maxNativeZoom
            })
            : new AsigWmsLayer(leaf, {
                pane: PANE_ID,
                opacity: entry.opacity,
                attribution: CONFIG.attribution,
                keepBuffer: CONFIG.wms.keepBuffer
            });
        part.layer = layer;
        layer._dlDefId = 'albania.' + entry.def.id;
        layer._detectlabProvider = CONFIG.provider;
        layer._detectlabUiTitle = text(entry.def.title) + (entry.def.kind === 'group' ? ' · ' + text(leaf.title) : '');
        layer._detectlabUiKeys = ['albaniaToggle_' + entry.def.id];
        layer._detectlabNoGuard = true;

        if (leaf.kind === 'wmts') {
            layer._stats = layer._stats || {};
            part.stats = layer._stats;
            layer.on('tileload', function () {
                if (part.stats.overzoomLevel != null && !part.overzoomNoted) {
                    part.overzoomNoted = true;
                    renderActive();
                }
            });
            layer.on('tileerror', function () {
                part.err += 1;
                if (part.err >= 3 && !part.warn) { part.warn = true; renderActive(); }
            });
        } else {
            layer.on('tileload', function () {
                part.ok += 1;
                if (part.ok === 1) renderActive();
            });
            layer.on('tileerror', function () {
                part.err += 1;
                if (!part.ok && !part.switched && part.err >= 2 && leaf.fallbackUrl && leaf.fallbackUrl !== layer.endpoint()) {
                    /* The prototype's one automatic retry: this layer's
                     * per-workspace endpoint answered nothing, so ask the
                     * global service. */
                    part.switched = true;
                    layer.setEndpoint(leaf.fallbackUrl);
                    part.err = 0;
                    renderActive();
                } else if (!part.ok && part.err >= 3 && !part.warn) {
                    part.warn = true;
                    renderActive();
                }
            });
        }
        entry.parts.push(part);
        return part;
    }

    function buildEntry(def) {
        var entry = runtime.entries[def.id];
        if (entry && entry.parts.length) return entry;
        entry = runtime.entries[def.id] = {
            def: def,
            parts: [],
            opacity: runtime.opacity[def.id] / 100,
            overzoom: false
        };
        if (def.id === HERITAGE_ID) {
            // One bounded vector controller replaces N simultaneous WMS stacks.
            if (!window.AsigHeritageLayer) {
                setStatus(def.id, 'Heritage renderer unavailable. Reload the app.', 'error');
                return entry;
            }
            var heritageLayer = new window.AsigHeritageLayer({
                opacity: entry.opacity,
                attribution: CONFIG.attribution,
                parts: currentHeritageParts,
                createFallback: function (parts, opacity, status) {
                    var layer = new AsigWmsLayer({
                        id: HERITAGE_ID,
                        name: parts.filter(function (part) { return part.name && part.kind !== 'wmts'; })
                            .map(function (part) { return part.name; }).join(','),
                        url: CONFIG.wms.url,
                        minZoom: 10,
                        maxNativeZoom: 18
                    }, {
                        pane: PANE_ID, opacity: opacity, keepBuffer: 0,
                        attribution: CONFIG.attribution
                    });
                    layer._dlDefId = 'albania.' + def.id;
                    layer._detectlabNoGuard = true;
                    layer.on('tileerror', function () {
                        status('ASIG Heritage map unavailable. Try again later.', 'error');
                    });
                    layer.on('tileload', function () {
                        status('Heritage · ASIG map (no feature markers).', 'info');
                    });
                    return layer;
                },
                status: function (message, kind) { setStatus(def.id, message, kind); }
            });
            heritageLayer._dlDefId = 'albania.' + def.id;
            entry.parts.push({ leaf: { kind: 'heritage-vector' }, layer: heritageLayer });
            return entry;
        }
        var leaves = def.kind === 'group'
            ? currentHeritageParts().filter(function (part) {
                /* Only WMS parts carry a map layer; the keyword rule has no
                 * tile-only products. */
                return part.kind !== 'wmts';
            }).map(function (part) {
                return {
                    id: part.id,
                    kind: 'wms',
                    title: part.title,
                    name: part.name,
                    url: part.url,
                    fallbackUrl: part.fallbackUrl,
                    format: part.format,
                    transparent: part.transparent,
                    minZoom: def.minZoom,
                    maxNativeZoom: def.maxNativeZoom
                };
            })
            : [{
                id: def.id,
                kind: def.kind,
                title: def.title,
                name: def.name,
                url: def.url,
                fallbackUrl: def.fallbackUrl,
                format: def.format,
                transparent: def.transparent,
                minZoom: def.minZoom,
                maxNativeZoom: def.maxNativeZoom
            }];
        leaves.forEach(function (leaf) { attachPart(entry, leaf); });
        return entry;
    }

    function addEntryToMap(entry) {
        var map = mapInstance();
        if (!map || runtime.suppressed) return;
        entry.parts.forEach(function (part) {
            if (part.layer && !map.hasLayer(part.layer)) map.addLayer(part.layer);
        });
    }
    function removeEntryFromMap(entry) {
        var map = mapInstance();
        if (!map) return;
        entry.parts.forEach(function (part) {
            if (part.layer && map.hasLayer(part.layer)) map.removeLayer(part.layer);
        });
    }

    function activate(def) {
        runtime.active[def.id] = true;
        if (runtime.order.indexOf(def.id) === -1) runtime.order.push(def.id);
        var entry = buildEntry(def);
        entry.opacity = runtime.opacity[def.id] / 100;
        entry.parts.forEach(function (part) { if (part.layer && part.layer.setOpacity) part.layer.setOpacity(entry.opacity); });
        addEntryToMap(entry);
        applyZOrder();
        setStatus(def.id, '', 'info');
        refreshRowNotice(def.id);
        renderActive();
    }
    function deactivate(def) {
        runtime.active[def.id] = false;
        var index = runtime.order.indexOf(def.id);
        if (index !== -1) runtime.order.splice(index, 1);
        var entry = runtime.entries[def.id];
        if (entry) removeEntryFromMap(entry);
        setStatus(def.id, '', 'info');
        var row = runtime.rows[def.id];
        if (row && row.input) row.input.checked = false;
        applyZOrder();
        renderActive();
        save();
    }

    function refreshRowNotice(id) {
        var def = CONFIG.byId(id);
        var entry = runtime.entries[id];
        if (!def || !runtime.active[id]) return;
        if (id === HERITAGE_ID) return; // The viewport controller owns loading/error status.
        var parts = entry ? entry.parts : [];
        if (!parts.length) return;
        var missing = parts.filter(function (part) { return part.missingName; }).length;
        var bad = parts.filter(function (part) { return part.warn && !part.ok; }).length;
        var retrying = parts.some(function (part) { return part.switched && !part.warn && !part.ok; });
        if (missing === parts.length) {
            setStatus(id, runtime.resolver.state === 'failed' ? words().unresolved : words().resolving, 'warn');
        } else if (missing) {
            setStatus(id, missing + '/' + parts.length + ' ' + words().partsFailed, 'warn');
        } else if (bad === parts.length) {
            setStatus(id, words().allFailed, 'error');
        } else if (bad) {
            setStatus(id, bad + '/' + parts.length + ' ' + words().partsFailed, 'warn');
        } else if (retrying) {
            setStatus(id, words().retrying, 'warn');
        } else {
            setStatus(id, '', 'info');
        }
    }

    function toggle(id, on) {
        var def = CONFIG.byId(id);
        if (!def) return;
        if (on) activate(def); else deactivate(def);
        syncUI();
        save();
    }

    function setOpacity(id, value) {
        var def = CONFIG.byId(id);
        if (!def) return;
        var opacity = Math.max(0, Math.min(100, Number(value) || 0));
        runtime.opacity[id] = opacity;
        var entry = runtime.entries[id];
        if (entry) {
            entry.opacity = opacity / 100;
            entry.parts.forEach(function (part) { if (part.layer && part.layer.setOpacity) part.layer.setOpacity(entry.opacity); });
        }
        if (opacity > 0 && !runtime.active[id]) activate(def);
        if (opacity === 0 && runtime.active[id]) deactivate(def);
        syncUI();
        save();
    }

    /** ↑/↓ in the active list. `direction` +1 moves the entry up (drawn later). */
    function moveActive(id, direction) {
        syncOrder();
        var index = runtime.order.indexOf(id);
        if (index === -1) return;
        var target = index + direction;
        if (target < 0 || target >= runtime.order.length) return;
        var other = runtime.order[target];
        runtime.order[target] = id;
        runtime.order[index] = other;
        applyZOrder();
        renderActive();
        save();
        return runtime.order.slice();
    }

    function syncUI() {
        var anyActive = false;
        LAYERS.forEach(function (def) {
            var row = runtime.rows[def.id];
            if (runtime.active[def.id]) anyActive = true;
            if (!row) return;
            row.input.checked = !!runtime.active[def.id];
            if (row.row.classList) row.row.classList.toggle('is-active', !!runtime.active[def.id]);
            if (row.pct) row.pct.textContent = runtime.opacity[def.id] + '%';
            if (row.slider && String(row.slider.value) !== String(runtime.opacity[def.id])) {
                row.slider.value = String(runtime.opacity[def.id]);
            }
        });
        syncSectionMasters();
        var master = document.getElementById(GROUP_TOGGLE_ID);
        if (master) master.checked = anyActive;
    }

    /* Group master switch: one click turns the whole Albanian stack on/off. */
    function toggleAll(on) {
        LAYERS.forEach(function (def) { if (on) activate(def); else deactivate(def); });
        if (!on) runtime.order = [];
        applyZOrder();
        syncUI();
        renderActive();
        save();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 6. RUN-TIME NAME RESOLUTION (rows the export has not named yet)
     * ═══════════════════════════════════════════════════════════════════════
     * The prototype resolved the rows the owner's notes do not name by title
     * from the service's own GetCapabilities. ASIG refused the automated
     * requests from a cloud IP (“IP … is blacklisted”), so this happens in the
     * visitor's browser — where the service does answer — once, with the answer
     * cached for a week. A baked name always wins: this only fills the blanks,
     * and rows whose name never resolves say so instead of drawing nothing.
     */
    function resolverNeeded() {
        var pending = false;
        LAYERS.forEach(function (def) {
            if (def.kind !== 'group' && !def.name) pending = true;
        });
        (HERITAGE ? HERITAGE.parts : []).forEach(function (part) { if (!part.name) pending = true; });
        return pending;
    }

    function readResolverCache() {
        try {
            var raw = window.localStorage.getItem(CONFIG.resolver.cacheKey);
            if (!raw) return null;
            var cached = JSON.parse(raw);
            if (!cached || !cached.at || (Date.now() - cached.at) > CONFIG.resolver.ttlMs) return null;
            return cached;
        } catch (e) { return null; }
    }
    function writeResolverCache(names, parts) {
        try {
            window.localStorage.setItem(CONFIG.resolver.cacheKey, JSON.stringify({
                at: Date.now(), names: names || {}, parts: parts || []
            }));
        } catch (e) { /* private mode: resolve again next time */ }
    }

    function parseCapabilities(xmlText) {
        var Parser = window.DOMParser;
        if (!Parser) throw new Error('DOMParser unavailable');
        var doc = new Parser().parseFromString(xmlText, 'text/xml');
        if (doc.querySelector && doc.querySelector('parsererror')) throw new Error('the response is not valid XML');
        var nodes = doc.getElementsByTagName ? doc.getElementsByTagName('*') : [];
        var found = [];
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (!node.localName || node.localName !== 'Layer') continue;
            var name = '', title = '';
            for (var j = 0; j < node.children.length; j++) {
                var child = node.children[j];
                if (child.localName === 'Name' && !name) name = String(child.textContent || '').trim();
                if (child.localName === 'Title' && !title) title = String(child.textContent || '').trim();
            }
            if (name) found.push({ name: name, title: title || name });
        }
        if (!found.length) throw new Error('the capabilities document lists no layers');
        return found;
    }

    /* Same folding as the search box, so a capabilities title spelled with an
     * accent still matches the catalogue's plain-spelled resolveByTitle. */
    function norm(value) {
        return fold(value);
    }

    function applyResolved(names, parts) {
        runtime.resolver.names = names || {};
        runtime.resolver.parts = (parts || []).map(function (part) {
            return {
                id: part.id, title: part.title, kind: 'wms', name: part.name,
                url: part.url || CONFIG.workspaceUrl(part.name),
                fallbackUrl: part.fallbackUrl || CONFIG.wms.url,
                format: 'image/png', transparent: true
            };
        });
        var resolvedAny = false;
        LAYERS.forEach(function (def) {
            if (def.kind === 'group' || def.name) return;
            var key = norm(def.resolveByTitle || def.title.en);
            var name = runtime.resolver.names[key];
            if (!name) return;
            def.name = name;
            def.layers = name;
            def.url = CONFIG.workspaceUrl(name);
            def.fallbackUrl = CONFIG.wms.url;
            resolvedAny = true;
            /* An entry built while the name was unknown must be rebuilt. */
            if (runtime.entries[def.id]) {
                removeEntryFromMap(runtime.entries[def.id]);
                delete runtime.entries[def.id];
                if (runtime.active[def.id]) activate(def);
            }
        });
        if (resolvedAny) {
            buildPanel();
            syncUI();
        }
        /* Heritage discovered by keyword joins the group, and the group redraws
         * if it is already on. */
        if (runtime.resolver.parts.length) {
            var heritageEntry = runtime.entries[HERITAGE_ID];
            if (heritageEntry) {
                removeEntryFromMap(heritageEntry);
                delete runtime.entries[HERITAGE_ID];
                if (runtime.active[HERITAGE_ID]) activate(HERITAGE);
            }
            var row = runtime.rows[HERITAGE_ID];
            if (row && row.title) row.title.textContent = text(HERITAGE.title);
            buildPanel();
            syncUI();
        }
        LAYERS.forEach(function (def) { refreshRowNotice(def.id); });
        renderActive();
    }

    function refreshResolverNotices() {
        if (!resolverNeeded()) return;
        LAYERS.forEach(function (def) {
            if (def.kind === 'group' || def.name) return;
            if (runtime.active[def.id]) refreshRowNotice(def.id);
        });
    }

    function resolveNames() {
        if (!CONFIG.resolver.enabled || runtime.resolver.state === 'running' || runtime.resolver.state === 'done') {
            return Promise.resolve(runtime.resolver);
        }
        if (!resolverNeeded()) {
            runtime.resolver.state = 'done';
            return Promise.resolve(runtime.resolver);
        }
        runtime.resolver.state = 'running';
        refreshResolverNotices();
        var cached = readResolverCache();
        if (cached) {
            runtime.resolver.state = 'done';
            runtime.resolver.cached = true;
            applyResolved(cached.names, cached.parts);
            return Promise.resolve(runtime.resolver);
        }
        if (typeof window.fetch !== 'function') {
            runtime.resolver.state = 'failed';
            runtime.resolver.error = 'no fetch';
            refreshResolverNotices();
            return Promise.resolve(runtime.resolver);
        }
        return window.fetch(CONFIG.resolver.capabilitiesUrl, { cache: 'force-cache' })
            .then(function (response) {
                if (!response.ok) throw new Error('HTTP ' + response.status);
                return response.text();
            })
            .then(function (xml) {
                var found = parseCapabilities(xml);
                var names = {};
                var pending = LAYERS.filter(function (def) { return def.kind !== 'group' && !def.name; });
                pending.forEach(function (def) {
                    var key = norm(def.resolveByTitle || def.title.en);
                    var hit = found.filter(function (node) { return norm(node.title) === key; })[0] ||
                        found.filter(function (node) {
                            return norm(String(node.name).split(':').pop()) === key;
                        })[0];
                    if (hit) names[key] = hit.name;
                });
                /* Every archaeological layer the service publishes joins
                 * Heritage, exactly like the prototype's keyword rule. */
                var keyword = new RegExp(CONFIG.resolver.keyword || 'archaeolog|archeolog|arkeolog', 'i');
                var known = {};
                (HERITAGE ? HERITAGE.parts : []).forEach(function (part) { if (part.name) known[part.name] = true; });
                var parts = found.filter(function (node) {
                    return keyword.test(node.title + ' ' + node.name) && !known[node.name];
                }).sort(function (a, b) { return a.title.localeCompare(b.title); }).map(function (node) {
                    return {
                        id: 'heritage_archaeology_' + node.name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase(),
                        title: node.title,
                        name: node.name
                    };
                });
                runtime.resolver.state = 'done';
                writeResolverCache(names, parts);
                applyResolved(names, parts);
                return runtime.resolver;
            })
            .catch(function (error) {
                runtime.resolver.state = 'failed';
                runtime.resolver.error = (error && error.message) || 'request failed';
                warnOnce('resolver', 'GetCapabilities could not be read in this browser: ' + runtime.resolver.error);
                refreshResolverNotices();
                return runtime.resolver;
            });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7. FEATURE INFO — one query per endpoint, sandboxed iframe for the HTML
     * ═══════════════════════════════════════════════════════════════════════ */
    /* The leaves that can answer a GetFeatureInfo *right now*: on, WMS, and
     * actually drawing on this map. The last condition matters because the
     * on/off state is restored from localStorage — a layer switched on in an
     * earlier session (or parked by the country gate) is "active" without
     * being on the map, and it must not answer taps or issue queries then. */
    function activeWmsLeaves() {
        var map = mapInstance();
        var leaves = [];
        runtime.order.forEach(function (id) {
            var entry = runtime.entries[id];
            if (!entry) return;
            entry.parts.forEach(function (part) {
                if (!part.layer || part.missingName) return;
                if (part.leaf.kind === 'wmts' || part.leaf.kind === 'heritage-vector') return;
                if (map && typeof map.hasLayer === 'function' && !map.hasLayer(part.layer)) return;
                leaves.push({
                    name: part.leaf.name,
                    title: part.leaf.title || entry.def.title,
                    url: part.layer.endpoint ? part.layer.endpoint() : part.leaf.url
                });
            });
        });
        return leaves;
    }

    function featureInfoUrl(url, leaves, latlng, size, point, bounds) {
        var crs = L.CRS.EPSG3857;
        var sw = crs.project(bounds.getSouthWest());
        var ne = crs.project(bounds.getNorthEast());
        var names = leaves.map(function (leaf) { return leaf.name; }).join(',');
        var query = new window.URLSearchParams({
            service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
            layers: names, query_layers: names, styles: '',
            bbox: [sw.x, sw.y, ne.x, ne.y].join(','),
            width: size.x, height: size.y, srs: 'EPSG:3857',
            x: Math.round(point.x), y: Math.round(point.y),
            info_format: CONFIG.featureInfo.format || 'text/html',
            feature_count: CONFIG.featureInfo.featureCount || 10
        });
        return url + (url.indexOf('?') === -1 ? '?' : '&') + query.toString();
    }

    function featureInfo(latlng) {
        var map = mapInstance();
        if (!map || !latlng) return Promise.resolve([]);
        var leaves = activeWmsLeaves();
        if (!leaves.length) return Promise.resolve([]);
        var groups = {};
        leaves.forEach(function (leaf) {
            if (!groups[leaf.url]) groups[leaf.url] = [];
            groups[leaf.url].push(leaf);
        });
        var bounds = map.getBounds();
        var size = map.getSize();
        var point = map.latLngToContainerPoint(latlng);
        var results = [];
        var requests = Object.keys(groups).map(function (url) {
            var list = groups[url];
            var full = featureInfoUrl(url, list, latlng, size, point, bounds);
            var title = list.map(function (leaf) { return text(leaf.title); }).join(', ');
            if (typeof window.fetch !== 'function') {
                results.push({ title: title, url: full, html: '' });
                return Promise.resolve();
            }
            return window.fetch(full)
                .then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.text();
                })
                .then(function (html) {
                    if (String(html).replace(/<[^>]*>/g, '').trim()) results.push({ title: title, url: full, html: html });
                })
                .catch(function () {
                    /* Cross-origin read blocked: let the browser show the
                     * server's own HTML in the sandboxed iframe. */
                    results.push({ title: title, url: full, html: '' });
                });
        });
        return Promise.all(requests).then(function () { return results; });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 7b. WHAT A MAP TAP IS ALLOWED TO ASK
     * ═══════════════════════════════════════════════════════════════════════
     * The Albanian catalogue answers taps only inside its own footprint, and
     * only while it is really on screen. Without these gates the map-wide
     * click handler fired everywhere: a tap over Romania (or anywhere else)
     * still opened the popup, showed “Querying the ASIG service…” and then
     * loaded the Albanian archaeological/heritage HTML — in the installed PWA
     * too, where the last session's on/off state is restored from storage. */
    function insideFootprint(latlng) {
        var bounds = CONFIG.countryBounds; /* [[south, west], [north, east]] */
        if (!bounds || !bounds.length || !latlng) return false;
        var lat = latlng.lat, lng = latlng.lng;
        if (typeof lat !== 'number' || typeof lng !== 'number') return false;
        /* A small margin: tiles and the service metadata may sit marginally
         * outside the published outline. */
        var pad = 0.02;
        return lat >= bounds[0][0] - pad && lat <= bounds[1][0] + pad &&
               lng >= bounds[0][1] - pad && lng <= bounds[1][1] + pad;
    }

    function canQueryAt(latlng) {
        if (runtime.suppressed) return false;      /* country gate: parked */
        if (!runtime.inCountry) return false;      /* only when Albania is selected */
        if (!insideFootprint(latlng)) return false; /* and only on Albanian ground */
        return activeWmsLeaves().length > 0;        /* with something actually drawing */
    }

    function openFeatureInfo(latlng) {
        var map = mapInstance();
        if (!map || !L.popup) return;
        var box = el('div', { className: 'albania-feature-info' }, [el('div', { className: 'empty', text: words().querying })]);
        var popup = L.popup({
            maxWidth: CONFIG.featureInfo.maxWidth,
            minWidth: CONFIG.featureInfo.minWidth
        }).setLatLng(latlng).setContent(box);
        popup.openOn(map);
        featureInfo(latlng).then(function (results) {
            clear(box);
            if (!results.length) { box.appendChild(el('div', { className: 'empty', text: words().noFeatures })); return; }
            results.forEach(function (result) {
                box.appendChild(el('h4', { text: result.title }));
                var frame = document.createElement('iframe');
                /* Sandboxed, script-free rendering: the service's HTML cannot
                 * run a script or reach this page. */
                frame.setAttribute('sandbox', '');
                frame.setAttribute('loading', 'lazy');
                frame.className = 'albania-feature-frame';
                if (result.html) frame.setAttribute('srcdoc', result.html);
                else frame.setAttribute('src', result.url);
                box.appendChild(frame);
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 8. COUNTRY GATE + PLACEMENT SWEEP
     * ═══════════════════════════════════════════════════════════════════════ */
    function setMapSuppressed(suppressed) {
        runtime.suppressed = !!suppressed;
        var map = mapInstance();
        if (!map) return;
        Object.keys(runtime.entries).forEach(function (id) {
            var entry = runtime.entries[id];
            if (runtime.suppressed) removeEntryFromMap(entry);
            else if (runtime.active[id]) addEntryToMap(entry);
        });
    }
    function applyCountryVisibility(visible) {
        runtime.inCountry = !!visible;
        var groupRow = document.getElementById(GROUP_ROW_ID);
        if (groupRow) {
            if (groupRow.classList) {
                groupRow.classList.toggle(OUT_OF_COUNTRY_CLASS, !visible);
                groupRow.classList.toggle('country-layer-unavailable', !visible);
            }
            groupRow.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        var lidarMount = document.getElementById('albaniaLidarLayers');
        if (lidarMount) lidarMount.classList.toggle('country-layer-unavailable', !visible);
        LAYERS.forEach(function (def) {
            var row = runtime.rows[def.id] && runtime.rows[def.id].row;
            if (!row) return;
            if (row.classList) row.classList.toggle('country-layer-unavailable', !visible);
            row.setAttribute('aria-hidden', visible ? 'false' : 'true');
        });
        setMapSuppressed(!visible);
    }
    /* The same signature the other country groups expose. */
    function filterForCountry(iso) {
        var code = String(iso == null ? (window._detectlabSelectedCountry || '') : iso).toUpperCase();
        applyCountryVisibility(code === COUNTRY);
        return code === COUNTRY;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 9. STATE
     * ═══════════════════════════════════════════════════════════════════════ */
    function save() {
        var state = {
            active: runtime.active,
            opacity: runtime.opacity,
            order: runtime.order,
            collapsed: runtime.collapsed
        };
        try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
        catch (e) { /* Storage may be disabled in private browsing. */ }
    }

    function defaultOpacity(def) {
        return Math.round((typeof def.opacity === 'number' ? def.opacity : 1) * 100);
    }

    function load() {
        LAYERS.forEach(function (def) {
            runtime.active[def.id] = false;
            runtime.opacity[def.id] = defaultOpacity(def);
        });
        var data = null;
        try { data = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null'); }
        catch (e) { data = null; }
        if (!data) return;
        LAYERS.forEach(function (def) {
            if (data.active && data.active[def.id]) runtime.active[def.id] = true;
            if (data.opacity && typeof data.opacity[def.id] === 'number') {
                runtime.opacity[def.id] = Math.max(0, Math.min(100, data.opacity[def.id]));
            }
        });
        runtime.collapsed = (data.collapsed && typeof data.collapsed === 'object') ? data.collapsed : {};
        if (Array.isArray(data.order)) {
            runtime.order = data.order.filter(function (id) {
                return !!runtime.active[id] && !!CONFIG.byId(id);
            });
        }
        syncOrder();
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * 10. EXPANSION + GROUP INFO + START
     * ═══════════════════════════════════════════════════════════════════════ */
    function setExpanded(expanded) {
        expanded = true; // No country-level accordion; sections own their expansion.
        runtime.expanded = true;
        var mount = document.getElementById(MOUNT_ID);
        if (mount && mount.style) {
            mount.style.maxHeight = expanded ? '6000px' : '0px';
            mount.style.opacity = expanded ? '1' : '0';
            mount.style.marginTop = expanded ? '6px' : '0px';
        }
        var button = document.getElementById(EXPAND_BTN_ID);
        if (button) button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        var icon = document.getElementById(EXPAND_ICON_ID);
        if (icon && icon.style) icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
    function toggleExpanded() { setExpanded(!runtime.expanded); }

    function showGroupInfo() {
        var title = text(CONFIG.groupLabel);
        var description = text(CONFIG.groupInfo) + ' ' + words().licence + '. ' + CONFIG.attribution + '.';
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, CONFIG.attribution, description);
            return;
        }
        if (window.alert) window.alert(title + '\n' + CONFIG.attribution + '\n' + description);
    }

    function ready(map) {
        runtime.map = map;
        runtime.ready = true;
        ensurePanes(map);
        LAYERS.forEach(function (def) { if (runtime.active[def.id]) activate(def); });
        applyZOrder();
        syncUI();
        renderActive();
        map.on('click', function (event) {
            if (window.dlApmPicking) return;   // APM point picking owns this map click
            if (!event || !canQueryAt(event.latlng)) return;
            openFeatureInfo(event.latlng);
        });
        resolveNames();
    }

    function start() {
        if (runtime.started) return;
        runtime.started = true;
        load();
        buildPanel();
        filterForCountry(window._detectlabSelectedCountry || '');
        var map = mapInstance();
        if (map) ready(map);
        else {
            var attempts = 0;
            var timer = window.setInterval(function () {
                var found = mapInstance();
                if (found) { window.clearInterval(timer); ready(found); }
                else if (++attempts > 240) window.clearInterval(timer);
            }, 250);
        }
    }

    function refreshTexts() {
        buildPanel();
        syncUI();
    }
    function goToView() { gotoTirana(); }
    function showInfo(id) { var def = CONFIG.byId(id); if (def) info(def); }

    var API = {
        CONFIG: CONFIG,
        layers: LAYERS,
        state: runtime,
        Layer: AsigWmsLayer,
        WmtsLayer: AsigWmtsLayer,
        TEXT: STRINGS,
        GROUP_ROW_ID: GROUP_ROW_ID,
        MOUNT_ID: MOUNT_ID,
        COUNTRY: COUNTRY,
        HERITAGE_ID: HERITAGE_ID,
        PANE_ID: PANE_ID,
        tileUrl: tileUrl,
        wmsRequestUrl: wmsRequestUrl,
        planWmtsTile: planWmtsTile,
        init: start,
        toggle: toggle,
        setOpacity: setOpacity,
        setSearch: setSearch,
        toggleSection: toggleSection,
        toggleSectionLayers: toggleSectionLayers,
        applyPanelTab: applyPanelTab,
        moveActive: moveActive,
        activeOrder: orderList,
        activeLeaves: activeWmsLeaves,
        featureInfo: featureInfo,
        openFeatureInfo: openFeatureInfo,
        canQueryAt: canQueryAt,
        insideFootprint: insideFootprint,
        resolveNames: resolveNames,
        isActive: function (id) { return !!runtime.active[id]; },
        filterForCountry: filterForCountry,
        refreshTexts: refreshTexts,
        goToView: goToView,
        showInfo: showInfo,
        setStatus: setStatus,
        showGroupInfo: showGroupInfo,
        toggleAll: toggleAll,
        toggleExpanded: toggleExpanded,
        setExpanded: setExpanded,
        isInCountry: function () { return !!runtime.inCountry; },
        layerIds: function () { return LAYERS.map(function (def) { return def.id; }); }
    };
    window.AsigAlbaniaLayers = API;
    window.setAlbaniaLayer = toggle;
    window.setAlbaniaOpacity = setOpacity;
    window.goToAlbaniaView = goToView;
    window.showAlbaniaInfo = showGroupInfo;
    window.toggleAlbaniaLayers = toggleAll;
    window.toggleAlbaniaSubLayers = toggleExpanded;
    window.filterAlbaniaCatalogue = setSearch;
    document.addEventListener('detectlab:langchange', refreshTexts);
    document.addEventListener('detectlab:country-selected', function (event) {
        var iso = (event && event.detail && event.detail.iso) || window._detectlabSelectedCountry || '';
        filterForCountry(iso);
    });
    document.addEventListener('detectlab:country-cleared', function () { filterForCountry(null); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
