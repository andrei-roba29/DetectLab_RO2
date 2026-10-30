/*
 * corona-wms-layer.js
 * ───────────────────────────────────────────────────────────────────────────
 * CORONA ("Satellite imagery 60's") for DetectLab — a faithful port of the
 * tile-fetching logic of the original Corona Atlas
 * (https://corona.cast.uark.edu/atlas, CAST — University of Arkansas),
 * generalised from a hand-written Romania list to the WHOLE OF EUROPE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW THE ORIGINAL WEBSITE FETCHES TILES  (read from its own source:
 * corona.cast.uark.edu/assets/libraries/custom/maputils.js — the
 * "CORONA RASTER MANAGER/FUNCTIONS" block — and from its live traffic)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. CATALOGUE — on page load the atlas calls
 *
 *        GET /corona/get_raster_names        (JSON)
 *
 *    which returns EVERY Corona product the CAST GeoServer publishes, keyed
 *    by pass:
 *
 *        "1104-2155Fore": {
 *           label: "1104-2155Fore (Mar 20, 1967)",
 *           location: "1104-2155Fore",          // GeoServer layer, minus workspace
 *           extent: {minx, miny, maxx, maxy},   // EPSG:4326
 *           polygon: "{\"type\":\"Polygon\",\"coordinates\":[[…]]}",
 *           images: [ { label, location: "1104-2155df004", extent, polygon,
 *                       ftp, size_ntf, size_tif }, … ]   // individual frames
 *        }
 *
 *    `initializeRasterManager(resp)` → `new rasterManager(rasterSettings, data)`
 *    builds one `rasterLayer` for every pass (the "layerGroup") and one for
 *    every frame ("layer") inside it.
 *
 * 2. TILE SOURCE — each rasterLayer is an `ol.layer.Tile` over
 *
 *        new ol.source.TileWMS({
 *          url:    "https://geoserve.cast.uark.edu/geoserver/gwc/service/wms",
 *          params: {LAYERS: "corona:" + location, VERSION: "1.1.1", tiled: "true"},
 *          tileGrid: new ol.tilegrid.TileGrid({
 *            origin: [-20037508.34, -20037508.34],
 *            resolutions: [156543.03390000001, …, 1.1943285667419434]  // 18 levels
 *          }),
 *          extent: <the layer's own footprint, EPSG:900913>
 *        })
 *
 *    i.e. ONE Corona layer per request, GeoWebCache WMS-C, EPSG:900913,
 *    256×256 tiles of the standard Web-Mercator grid, and no request is ever
 *    sent outside the product's own footprint.
 *
 * 3. ZOOM GATING — `rasterSettings.layerSettings`:
 *
 *        layerGroup (pass mosaic): minZoom  8, maxZoom 11
 *        layer      (single frame): minZoom 12, maxZoom 20
 *
 * 4. WHAT IS VISIBLE — `rasterLayer.checkZoom()`, re-run on every `moveend`
 *    (`corona.zoomChanged()`): a product draws only when its POLYGON (not its
 *    bbox) intersects the current view extent *and* the zoom is inside its
 *    range. Everything else is `setVisible(false)`.
 *
 * This file reproduces 1–4 on Leaflet. The only deliberate difference is
 * memory hygiene: the original creates an OpenLayers layer for every product
 * in the catalogue up-front; here the Leaflet tile layer for a product is
 * created the first time it is actually needed and dropped when it leaves the
 * view, which keeps a Europe-wide catalogue affordable on a phone. The
 * requests that reach the server are identical.
 *
 * Exposes (Leaflet must be loaded first):
 *     window.coronaWmsTileUrl(baseUrl, layerName, z, x, y) → exact request URL
 *     window.CoronaWmsLayer                                 → L.TileLayer.WMS subclass
 *     window.createCoronaWmsLayer(url, options)             → factory
 *     window.CoronaAtlas                                    → catalogue + manager
 */
(function (root) {
    'use strict';

    var L = root.L;
    if (!L) {
        console.error('[CoronaWms] Leaflet is not loaded — corona-wms-layer.js must load after leaflet.js');
        return;
    }

    /* ───────────────────────────────────────────────────────────────────────
     * Web-Mercator / EPSG:900913 tile-grid math. GeoWebCache's EPSG:900913
     * gridset is the standard XYZ grid: 256×256 tiles, world extent
     * ±20037508.342789244 m, 18 levels (z0…z17 — the exact `resolutions`
     * array the atlas passes to ol.tilegrid.TileGrid).
     * ───────────────────────────────────────────────────────────────────── */
    var WM_ORIGIN = 20037508.342789244;

    function tileToBbox900913(z, x, y) {
        var tileSize = (WM_ORIGIN * 2) / Math.pow(2, z); // metres per 256 px tile
        var minX = -WM_ORIGIN + x * tileSize;
        var maxX = minX + tileSize;
        var maxY = WM_ORIGIN - y * tileSize;
        var minY = maxY - tileSize;
        // 6 decimals of a metre (~1 µm) — far beyond GeoWebCache's cache-key
        // tolerance, and it keeps the URLs as tidy as the original's.
        return [minX.toFixed(6), minY.toFixed(6), maxX.toFixed(6), maxY.toFixed(6)].join(',');
    }

    /* ───────────────────────────────────────────────────────────────────────
     * The EXACT WMS-C request URL the original Corona Atlas sends, byte for
     * byte in parameter name/order/encoding. Example captured from the
     * original site (z15 tile x=19312 y=13536, layer corona:1105-2235df021):
     *
     *   https://geoserve.cast.uark.edu/geoserver/gwc/service/wms
     *   ?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fpng
     *   &TRANSPARENT=true&LAYERS=corona%3A1105-2235df021&tiled=true
     *   &WIDTH=256&HEIGHT=256&SRS=EPSG%3A900913&STYLES=
     *   &BBOX=3580921.899662502%2C3481859.511022657%2C3582144.892114846%2C3483082.503475001
     * ───────────────────────────────────────────────────────────────────── */
    function buildWmsUrl(base, layerName, z, x, y) {
        return base
            + '?SERVICE=WMS'
            + '&VERSION=1.1.1'
            + '&REQUEST=GetMap'
            + '&FORMAT=image%2Fpng'
            + '&TRANSPARENT=true'
            + '&LAYERS=' + encodeURIComponent(layerName)
            + '&tiled=true'
            + '&WIDTH=256'
            + '&HEIGHT=256'
            + '&SRS=EPSG%3A900913'
            + '&STYLES='
            + '&BBOX=' + encodeURIComponent(tileToBbox900913(z, x, y));
    }

    /* ───────────────────────────────────────────────────────────────────────
     * The tile layer. One instance per Corona product (pass mosaic or frame),
     * so each tile request carries exactly one LAYERS= value — the same way
     * the original atlas issues its requests.
     * ───────────────────────────────────────────────────────────────────── */
    var CoronaWmsLayer = L.TileLayer.WMS.extend({

        initialize: function (url, options) {
            options = L.extend({
                format: 'image/png',
                transparent: true,
                version: '1.1.1',
                tileSize: 256,
                // The atlas's tileGrid has 18 resolutions → native levels z0…z17.
                maxNativeZoom: 17,
                minZoom: 0,
                maxZoom: 20
            }, options || {});

            this._coronaLayer = options.layers || options.coronaLayer || 'corona';
            this._coronaBaseUrl = url;

            L.TileLayer.WMS.prototype.initialize.call(this, url, options);
        },

        // The ONLY thing that differs from a normal basemap: the URL format.
        getTileUrl: function (coords) {
            return buildWmsUrl(this._coronaBaseUrl, this._coronaLayer, coords.z, coords.x, coords.y);
        },

        getCoronaLayerName: function () {
            return this._coronaLayer;
        }
    });

    /* ═══════════════════════════════════════════════════════════════════════
     * CATALOGUE — the Europe-wide equivalent of the atlas's
     * `getRasterNames()` → `initializeRasterManager()`.
     *
     * The CAST endpoint (corona.cast.uark.edu/corona/get_raster_names) sends
     * no `Access-Control-Allow-Origin` header, so a browser on another origin
     * cannot read it directly. The catalogue therefore arrives through one of
     * these, in order (all same-origin or CORS-enabled):
     *
     *   1. window.CORONA_CATALOG_URL      — explicit override (e.g. Supabase);
     *   2. data/corona-europe-catalog.json — static snapshot committed/produced
     *      by tools/build-corona-europe-catalog.mjs (fastest, cacheable, PWA);
     *   3. /api/corona/rasters            — Netlify function that proxies and
     *      filters the live CAST catalogue (always fresh, same origin);
     *   4. the built-in minimal list below — last-resort so the layer still
     *      draws something if 1–3 are all unavailable.
     *
     * Every source yields the same normalised shape.
     * ═══════════════════════════════════════════════════════════════════════ */

    // Whole of Europe (incl. Iceland/Svalbard in the north-west, the Urals in
    // the east, Cyprus/Crete in the south-east).
    var EUROPE_BBOX = [-25, 34, 60, 72]; // [minLon, minLat, maxLon, maxLat]

    // Zoom gating — the atlas's own rasterSettings.layerSettings.
    var PASS_MIN_ZOOM = 8;
    var PASS_MAX_ZOOM = 11;
    var FRAME_MIN_ZOOM = 12;
    var FRAME_MAX_ZOOM = 20;

    var WMS_URL = 'https://geoserve.cast.uark.edu/geoserver/gwc/service/wms';
    var WORKSPACE = 'corona:';

    /*
     * Last-resort list: Corona passes verified by hand (2026-08-12) to exist
     * on the CAST GeoServer and to return real pixels over Romania. It is NOT
     * the Europe catalogue — it only keeps the layer from going completely
     * dark if every catalogue source fails.
     */
    var FALLBACK_BLOCKS = [
        { id: '1104-2155Fore', location: '1104-2155Fore', label: '1104-2155Fore', extent: [19.50, 43.50, 26.77, 47.73] },
        { id: '1104-2155Aft', location: '1104-2155Aft', label: '1104-2155Aft', extent: [19.53, 43.50, 26.63, 47.72] },
        { id: '1036-2139Fore', location: '1036-2139Fore', label: '1036-2139Fore', extent: [21.08, 43.50, 27.78, 46.50] },
        { id: '1103-1058Aft', location: '1103-1058Aft', label: '1103-1058Aft', extent: [23.46, 43.50, 27.38, 45.82] },
        { id: '1103-1058Fore', location: '1103-1058Fore', label: '1103-1058Fore', extent: [22.62, 43.50, 28.34, 46.01] },
        { id: '1026-2088Aft', location: '1026-2088Aft', label: '1026-2088Aft', extent: [21.52, 43.50, 27.45, 46.29] }
    ].map(function (block) {
        return {
            id: block.id,
            label: block.label,
            location: block.location,
            extent: block.extent,
            rings: [bboxRing(block.extent)],
            images: [
                // Frame-level products of the two verified Transylvania passes.
                // (Kept tiny on purpose: this list is a safety net, not data.)
            ]
        };
    });

    FALLBACK_BLOCKS[0].images = [
        { label: '1104-2155df004', location: '1104-2155df004', extent: [21.01, 45.28, 24.78, 47.87] },
        { label: '1104-2155df007', location: '1104-2155df007', extent: [21.12, 44.91, 24.86, 47.50] },
        { label: '1104-2155df011', location: '1104-2155df011', extent: [21.25, 44.42, 24.95, 47.00] }
    ].map(function (image) {
        return {
            label: image.label,
            location: image.location,
            extent: image.extent,
            rings: [bboxRing(image.extent)]
        };
    });

    function bboxRing(extent) {
        return [
            [extent[0], extent[1]],
            [extent[2], extent[1]],
            [extent[2], extent[3]],
            [extent[0], extent[3]],
            [extent[0], extent[1]]
        ];
    }

    /* ── geometry helpers ─────────────────────────────────────────────────── */

    function bboxOfRings(rings) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r];
            for (var i = 0; i < ring.length; i++) {
                var x = ring[i][0], y = ring[i][1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        return [minX, minY, maxX, maxY];
    }

    function bboxIntersects(a, b) {
        return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
    }

    function pointInRing(x, y, ring) {
        var inside = false;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            var xi = ring[i][0], yi = ring[i][1];
            var xj = ring[j][0], yj = ring[j][1];
            var hit = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / ((yj - yi) || Number.MIN_VALUE) + xi);
            if (hit) inside = !inside;
        }
        return inside;
    }

    function segmentsIntersect(p1, p2, p3, p4) {
        function orient(a, b, c) {
            var v = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
            if (v > 0) return 1;
            if (v < 0) return 2;
            return 0;
        }
        function onSeg(a, b, c) {
            return b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0]) &&
                b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);
        }
        var o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
        var o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
        if (o1 !== o2 && o3 !== o4) return true;
        if (o1 === 0 && onSeg(p1, p3, p2)) return true;
        if (o2 === 0 && onSeg(p1, p4, p2)) return true;
        if (o3 === 0 && onSeg(p3, p1, p4)) return true;
        if (o4 === 0 && onSeg(p3, p2, p4)) return true;
        return false;
    }

    /*
     * The OpenLayers `geometry.intersectsExtent()` the atlas relies on, in
     * plain JS: does the product footprint (a thin, strongly rotated
     * parallelogram — its bbox is a poor proxy) overlap the view rectangle?
     * bbox = [minLon, minLat, maxLon, maxLat].
     */
    function ringsIntersectBbox(rings, bbox) {
        if (!rings || !rings.length) return false;
        var rect = bboxRing(bbox);
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r];
            if (!ring || ring.length < 2) continue;
            // a) any vertex of the footprint inside the view
            for (var i = 0; i < ring.length; i++) {
                var x = ring[i][0], y = ring[i][1];
                if (x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]) return true;
            }
            // b) the view is entirely inside the footprint
            if (pointInRing(bbox[0], bbox[1], ring)) return true;
            // c) any edge crossing
            for (var k = 0; k < ring.length - 1; k++) {
                for (var m = 0; m < rect.length - 1; m++) {
                    if (segmentsIntersect(ring[k], ring[k + 1], rect[m], rect[m + 1])) return true;
                }
            }
        }
        return false;
    }

    /* ── catalogue normalisation ──────────────────────────────────────────── */

    function extentToArray(extent) {
        if (!extent) return null;
        if (Object.prototype.toString.call(extent) === '[object Array]') {
            return extent.length === 4 ? extent.map(Number) : null;
        }
        if (typeof extent.minx === 'number' || typeof extent.minx === 'string') {
            return [Number(extent.minx), Number(extent.miny), Number(extent.maxx), Number(extent.maxy)];
        }
        return null;
    }

    /* The CAST catalogue ships `polygon` as a GeoJSON *string* of a Polygon or
     * MultiPolygon (the atlas does `JSON.parse` + wraps a Polygon so both end
     * up as MultiPolygon coordinates). Our slim snapshot ships `rings`
     * directly. Both become a flat array of rings here. */
    function toRings(polygon) {
        if (!polygon) return null;
        var parsed = polygon;
        if (typeof polygon === 'string') {
            try { parsed = JSON.parse(polygon); } catch (err) { return null; }
        }
        if (!parsed) return null;
        if (Object.prototype.toString.call(parsed) === '[object Array]') {
            // already a list of rings
            return parsed.length && parsed[0] && parsed[0].length ? parsed : null;
        }
        var coords = parsed.coordinates;
        if (!coords) return null;
        var rings = [];
        if (parsed.type === 'Polygon') {
            rings = coords.slice();
        } else if (parsed.type === 'MultiPolygon') {
            for (var i = 0; i < coords.length; i++) {
                rings = rings.concat(coords[i]);
            }
        }
        return rings.length ? rings : null;
    }

    function normalizeProduct(entry, key) {
        var location = entry.location || entry.name || key;
        if (!location) return null;
        var rings = toRings(entry.rings || entry.polygon);
        var extent = extentToArray(entry.extent) || (rings ? bboxOfRings(rings) : null);
        if (!extent) return null;
        if (!rings) rings = [bboxRing(extent)];
        return {
            id: key || location,
            label: entry.label || location,
            location: String(location).replace(/^corona:/, ''),
            extent: extent,
            rings: rings,
            ftp: entry.ftp || null
        };
    }

    /**
     * Accepts either the raw CAST payload (object keyed by pass) or our slim
     * snapshot ({blocks: [...]}) and returns the normalised block list,
     * optionally clipped to a bbox.
     */
    function normalizeCatalog(payload, bbox) {
        if (!payload) return [];
        var raw = payload.blocks || payload;
        var out = [];
        var keys;
        var isArray = Object.prototype.toString.call(raw) === '[object Array]';
        keys = isArray ? raw.map(function (_, i) { return i; }) : Object.keys(raw);

        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var entry = raw[key];
            if (!entry || typeof entry !== 'object') continue;
            var block = normalizeProduct(entry, isArray ? (entry.id || entry.location) : key);
            if (!block) continue;
            if (bbox && !bboxIntersects(block.extent, bbox)) continue;

            var images = [];
            var rawImages = entry.images || [];
            for (var j = 0; j < rawImages.length; j++) {
                var image = normalizeProduct(rawImages[j], rawImages[j].location);
                if (!image) continue;
                if (bbox && !bboxIntersects(image.extent, bbox)) continue;
                images.push(image);
            }
            block.images = images;
            out.push(block);
        }
        return out;
    }

    /* ── catalogue loading ────────────────────────────────────────────────── */

    function catalogSources() {
        var sources = [];
        if (root.CORONA_CATALOG_URL) sources.push(root.CORONA_CATALOG_URL);
        sources.push('data/corona-europe-catalog.json');
        sources.push('/api/corona/rasters?bbox=' + EUROPE_BBOX.join(','));
        return sources;
    }

    var _catalogPromise = null;

    function loadCatalog(options) {
        options = options || {};
        if (_catalogPromise && !options.force) return _catalogPromise;

        var bbox = options.bbox || EUROPE_BBOX;
        var sources = options.sources || catalogSources();

        _catalogPromise = new Promise(function (resolve) {
            var index = 0;

            function finish(blocks, source) {
                if (blocks && blocks.length) {
                    console.info('[Corona] catalogue: ' + blocks.length + ' passes from ' + source);
                    resolve({ blocks: blocks, source: source });
                } else {
                    next();
                }
            }

            function next() {
                if (index >= sources.length) {
                    console.warn('[Corona] no catalogue source reachable — using the built-in fallback list');
                    resolve({ blocks: FALLBACK_BLOCKS.slice(), source: 'fallback' });
                    return;
                }
                var url = sources[index++];
                var request;
                try {
                    request = fetch(url, { credentials: 'omit' });
                } catch (err) {
                    next();
                    return;
                }
                request.then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.json();
                }).then(function (json) {
                    finish(normalizeCatalog(json, bbox), url);
                })['catch'](function (err) {
                    console.warn('[Corona] catalogue source failed (' + url + '): ' + (err && err.message));
                    next();
                });
            }

            next();
        });

        return _catalogPromise;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     * RASTER MANAGER — the Leaflet twin of the atlas's `rasterManager` /
     * `rasterLayer.checkZoom()`.
     * ═══════════════════════════════════════════════════════════════════════ */

    /**
     * @param {L.Map} map
     * @param {Object} options
     *   group            {L.LayerGroup} where active tile layers are attached
     *   pane             {string}
     *   opacity          {number}
     *   opacityTarget    {'layers'|'pane'}  where the opacity is applied
     *                    (see §"ONE COMPOSITED SURFACE" below), default 'layers'
     *   viewportPad      {number}  extra view margin (fraction), default 0.25
     *   maxActivePasses  {number}  safety cap, default 18
     *   maxActiveFrames  {number}  safety cap, default 24
     *   maxCachedLayers  {number}  tile layers kept in the LRU, default 60
     *   tileLayerOptions {Object}  merged into every tile layer (perf tuning)
     *   onChange         {Function(activeDescriptors)}
     *
     * ── ONE COMPOSITED SURFACE, NOT ONE PER PRODUCT ────────────────────────
     * A Leaflet tile layer whose `opacity` is below 1 gets that opacity on its
     * own container div, which makes the browser promote EVERY layer to a
     * separate composited GPU surface. With this manager that is 8–24 surfaces
     * in the same pane, and during a zoom animation the whole tile pane is
     * re-transformed every frame — the pathological case for the GPU memory of
     * an Android device (the reported symptom was the map flashing a solid
     * green/blank rectangle while zooming with the 1960s layer on).
     *
     * With `opacityTarget: 'pane'` every product renders at opacity 1 and the
     * single shared pane carries the opacity instead: one composited surface
     * for the whole CORONA stack, identical pixels on screen, a fraction of
     * the GPU memory. `setOpacity()` keeps working in both modes.
     */
    function CoronaRasterManager(map, options) {
        this._map = map;
        this.options = L.extend({
            url: WMS_URL,
            workspace: WORKSPACE,
            group: null,
            pane: undefined,
            opacity: 0.85,
            opacityTarget: 'layers',
            viewportPad: 0.25,
            maxActivePasses: 18,
            maxActiveFrames: 24,
            // How many product tile layers may stay cached (created but not
            // attached) while the user pans/zooms around. Every cached layer
            // holds a container div; only the attached ones hold tiles.
            maxCachedLayers: 60,
            passMinZoom: PASS_MIN_ZOOM,
            passMaxZoom: PASS_MAX_ZOOM,
            frameMinZoom: FRAME_MIN_ZOOM,
            frameMaxZoom: FRAME_MAX_ZOOM,
            tileLayerOptions: {},
            onChange: null
        }, options || {});

        this.blocks = [];
        this._layers = {};   // location → L.TileLayer
        this._active = [];   // descriptors currently attached
        this._group = this.options.group || L.layerGroup([]);
    }

    CoronaRasterManager.prototype = {

        getGroup: function () {
            return this._group;
        },

        setCatalog: function (blocks) {
            this.blocks = blocks || [];
            return this;
        },

        /** The products the original atlas would show for this view/zoom. */
        selectProducts: function (zoom, bbox) {
            var out = [];
            var i, j;
            // ── NO DEAD ZOOM BAND ───────────────────────────────────────────
            // Leaflet's `getZoom()` is not always an integer: `flyTo()` moves
            // through FRACTIONAL zooms on every animation frame (that is how
            // the live-location button recentres the map), and pinch/wheel
            // zoom with `zoomSnap: 0` ends on one too. The atlas's two bands
            // are 8–11 and 12–20, so any z between 11 and 12 falls into
            // NEITHER branch: every product was detached, the pane went empty
            // and the imagery popped out and back in while the user was still
            // pinching. Rounding picks the nearer band, so the selection is
            // never empty between the bands.
            zoom = (typeof zoom === 'number' && isFinite(zoom)) ? Math.round(zoom) : zoom;
            if (zoom >= this.options.passMinZoom && zoom <= this.options.passMaxZoom) {
                for (i = 0; i < this.blocks.length; i++) {
                    var block = this.blocks[i];
                    if (!bboxIntersects(block.extent, bbox)) continue;
                    if (!ringsIntersectBbox(block.rings, bbox)) continue;
                    out.push({ type: 'pass', product: block });
                }
                out = out.slice(0, this.options.maxActivePasses);
            } else if (zoom >= this.options.frameMinZoom && zoom <= this.options.frameMaxZoom) {
                for (i = 0; i < this.blocks.length; i++) {
                    var parent = this.blocks[i];
                    if (!bboxIntersects(parent.extent, bbox)) continue;
                    var images = parent.images || [];
                    for (j = 0; j < images.length; j++) {
                        var image = images[j];
                        if (!bboxIntersects(image.extent, bbox)) continue;
                        if (!ringsIntersectBbox(image.rings, bbox)) continue;
                        out.push({ type: 'frame', product: image, parent: parent });
                    }
                }
                // A pass whose frames were not published individually would
                // vanish at z12+; keep its mosaic so the imagery stays on
                // screen while zoomed in (the atlas has the same gap, but an
                // empty map reads as a bug to our users).
                if (!out.length) {
                    for (i = 0; i < this.blocks.length; i++) {
                        var only = this.blocks[i];
                        if (!bboxIntersects(only.extent, bbox)) continue;
                        if (!ringsIntersectBbox(only.rings, bbox)) continue;
                        out.push({ type: 'pass', product: only });
                    }
                }
                out = out.slice(0, this.options.maxActiveFrames);
            }
            return out;
        },

        _tileLayerFor: function (descriptor) {
            var location = descriptor.product.location;
            var existing = this._layers[location];
            if (existing) return existing;

            var name = this.options.workspace + location;
            var extent = descriptor.product.extent;
            var bounds = L.latLngBounds([[extent[1], extent[0]], [extent[3], extent[2]]]);
            var isFrame = descriptor.type === 'frame';

            // In `opacityTarget: 'pane'` mode the product itself stays fully
            // opaque and the shared pane carries the opacity — see the note in
            // the constructor. One composited GPU surface instead of one per
            // product, which is what made Android flash green while zooming.
            var paneOpacityMode = this.options.opacityTarget === 'pane';
            var opts = L.extend({
                layers: name,
                coronaLayer: name,
                format: 'image/png',
                transparent: true,
                attribution: '© Corona 1960s (CAST UARK)',
                tileSize: 256,
                opacity: paneOpacityMode ? 1 : this.options.opacity,
                bounds: bounds,
                minZoom: isFrame ? this.options.frameMinZoom : this.options.passMinZoom,
                maxZoom: isFrame ? this.options.frameMaxZoom : 20,
                maxNativeZoom: 17
            }, this.options.tileLayerOptions);
            if (this.options.pane) opts.pane = this.options.pane;

            var layer = root.createCoronaWmsLayer
                ? root.createCoronaWmsLayer(this.options.url, opts)
                : L.tileLayer.wms(this.options.url, opts);

            // A tile the server refuses (renamed/retired product → GeoWebCache
            // answers "400 Unknown layer …") must not leave a broken <img>.
            layer.on('tileerror', function (e) {
                if (e && e.tile) e.tile.style.display = 'none';
                if (!layer._coronaErrorLogged) {
                    layer._coronaErrorLogged = true;
                    console.warn('[Corona] product unavailable on the CAST server: ' + name);
                }
            });

            layer._coronaDescriptor = descriptor;
            layer._coronaBounds = bounds;
            this._layers[location] = layer;
            return layer;
        },

        /** Re-evaluate the view — the atlas's `corona.zoomChanged()`. */
        update: function () {
            if (!this._map) return [];
            var zoom = this._map.getZoom();
            var viewBounds;
            try {
                viewBounds = this._map.getBounds().pad(this.options.viewportPad);
            } catch (err) {
                return this._active;
            }
            var bbox = [
                viewBounds.getWest(), viewBounds.getSouth(),
                viewBounds.getEast(), viewBounds.getNorth()
            ];

            var wanted = this.selectProducts(zoom, bbox);
            var wantedByLocation = {};
            var i;
            for (i = 0; i < wanted.length; i++) {
                wantedByLocation[wanted[i].product.location] = wanted[i];
            }

            // detach what left the view / the zoom range
            for (var location in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, location)) continue;
                var layer = this._layers[location];
                var attached = this._group.hasLayer(layer);
                if (!wantedByLocation[location] && attached) {
                    this._group.removeLayer(layer);
                }
            }
            // attach what entered it
            for (i = 0; i < wanted.length; i++) {
                var tileLayer = this._tileLayerFor(wanted[i]);
                if (!this._group.hasLayer(tileLayer)) this._group.addLayer(tileLayer);
            }

            // keep the cache bounded (tile layers hold decoded images alive)
            this._evictUnused(this.options.maxCachedLayers);

            this._active = wanted;
            if (typeof this.options.onChange === 'function') {
                try { this.options.onChange(wanted); } catch (err) { /* never break the map */ }
            }
            return wanted;
        },

        _evictUnused: function (limit) {
            var locations = Object.keys(this._layers);
            if (typeof limit !== 'number' || limit < 0) limit = 60;
            if (locations.length <= limit) return;
            for (var i = 0; i < locations.length && Object.keys(this._layers).length > limit; i++) {
                var layer = this._layers[locations[i]];
                if (this._group.hasLayer(layer)) continue;
                // Detached layers are already tile-free (GridLayer.onRemove
                // removes every tile), but their container and any retained
                // level must go too — otherwise panning across Europe leaves a
                // pile of empty-but-composited divs in the pane, exactly the
                // kind of per-layer surface that starves the GPU on Android.
                try {
                    if (layer._removeAllTiles) layer._removeAllTiles();
                    if (layer._container && layer._container.parentNode) {
                        layer._container.parentNode.removeChild(layer._container);
                    }
                    layer._container = null;
                } catch (err) { /* cosmetic only — never break the map */ }
                layer.off();
                delete this._layers[locations[i]];
            }
        },

        /** How many product layers are attached right now (diagnostics/tests). */
        getAttachedCount: function () {
            var n = 0;
            for (var location in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, location)) continue;
                if (this._group.hasLayer(this._layers[location])) n++;
            }
            return n;
        },

        getActiveProducts: function () {
            return this._active.slice();
        },

        getActiveLayers: function () {
            var out = [];
            for (var location in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, location)) continue;
                if (this._group.hasLayer(this._layers[location])) out.push(this._layers[location]);
            }
            return out;
        },

        /**
         * In 'pane' mode: push the opacity onto the shared pane and keep every
         * product fully opaque, so the whole CORONA stack is ONE composited GPU
         * surface instead of one per product. Returns true when it applied.
         */
        _applyPaneOpacity: function (opacity) {
            if (this.options.opacityTarget !== 'pane') return false;
            if (this._paneEl && !this._paneEl.parentNode) this._paneEl = null;
            if (!this._paneEl) {
                try {
                    this._paneEl = (this.options.pane && this._map && this._map.getPane)
                        ? this._map.getPane(this.options.pane) : null;
                } catch (err) { this._paneEl = null; }
            }
            if (!this._paneEl) return false;
            this._paneEl.style.opacity = String(opacity);
            for (var loc in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, loc)) continue;
                var pl = this._layers[loc];
                if (pl && pl.setOpacity) pl.setOpacity(1);
            }
            return true;
        },

        setOpacity: function (opacity) {
            this.options.opacity = opacity;
            if (this._applyPaneOpacity(opacity)) return;
            for (var loc in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, loc)) continue;
                var layer = this._layers[loc];
                if (layer && layer.setOpacity) layer.setOpacity(opacity);
            }
        },

        clear: function () {
            for (var location in this._layers) {
                if (!Object.prototype.hasOwnProperty.call(this._layers, location)) continue;
                var layer = this._layers[location];
                if (this._group.hasLayer(layer)) this._group.removeLayer(layer);
                layer.off();
            }
            this._layers = {};
            this._active = [];
        }
    };

    /* ── exports ──────────────────────────────────────────────────────────── */

    root.coronaWmsTileUrl = buildWmsUrl;          // pure helper (also used by tests)
    root.CoronaWmsLayer = CoronaWmsLayer;
    root.createCoronaWmsLayer = function (url, options) {
        return new CoronaWmsLayer(url, options);
    };

    root.CoronaAtlas = {
        WMS_URL: WMS_URL,
        WORKSPACE: WORKSPACE,
        EUROPE_BBOX: EUROPE_BBOX,
        PASS_MIN_ZOOM: PASS_MIN_ZOOM,
        PASS_MAX_ZOOM: PASS_MAX_ZOOM,
        FRAME_MIN_ZOOM: FRAME_MIN_ZOOM,
        FRAME_MAX_ZOOM: FRAME_MAX_ZOOM,
        MAX_NATIVE_ZOOM: 17,
        FALLBACK_BLOCKS: FALLBACK_BLOCKS,
        catalogSources: catalogSources,
        normalizeCatalog: normalizeCatalog,
        loadCatalog: loadCatalog,
        bboxIntersects: bboxIntersects,
        ringsIntersectBbox: ringsIntersectBbox,
        bboxOfRings: bboxOfRings,
        tileToBbox900913: tileToBbox900913,
        Manager: CoronaRasterManager,
        createManager: function (map, options) {
            return new CoronaRasterManager(map, options);
        }
    };

})(window);
