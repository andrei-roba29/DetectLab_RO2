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
     * Tile error handling. Leaflet's normal <img> tile loader reports a failed
     * decode, but does not retry it. Since CAST does not expose CORS response
     * headers, browsers normally hide the HTTP status from the image element;
     * Resource Timing can expose it when the server sends Timing-Allow-Origin.
     * An unknown status is treated as transient, with a strict retry cap.
     * ───────────────────────────────────────────────────────────────────── */
    var CORONA_TILE_MAX_RETRIES = 2;
    var CORONA_TILE_RETRY_DELAYS = [500, 1500];
    var coronaUnavailableNotice = null;
    var coronaNoticeTimer = null;
    var coronaNoticeLastShown = 0;

    function observedTileStatus(url, event) {
        var candidates = [event, event && event.target];
        for (var i = 0; i < candidates.length; i++) {
            var status = candidates[i] && Number(candidates[i].status);
            if (status > 0) return status;
        }
        try {
            var entries = root.performance && root.performance.getEntriesByName(url, 'resource');
            if (entries && entries.length) {
                var responseStatus = Number(entries[entries.length - 1].responseStatus);
                if (responseStatus > 0) return responseStatus;
            }
        } catch (err) { /* cross-origin timing data is commonly restricted */ }
        return null;
    }

    function isRetryableTileFailure(status) {
        // A missing status is normal for cross-origin <img> requests without
        // Timing-Allow-Origin. Status 0 is an opaque/network failure. A 2xx
        // response that cannot decode is typically an HTML gateway page.
        if (status === null || status === 0) return true;
        if (status >= 200 && status < 300) return true;
        return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
    }

    function showCoronaUnavailableNotice() {
        var doc = root.document;
        if (!doc || !doc.body || !doc.createElement) return;
        if (coronaUnavailableNotice && coronaUnavailableNotice.parentNode) return;
        var now = Date.now();
        if (now - coronaNoticeLastShown < 30000) return;
        coronaNoticeLastShown = now;
        var notice = doc.createElement('div');
        notice.id = 'corona-tile-unavailable-notice';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.textContent = 'CORONA imagery is temporarily unavailable. Retrying; loaded tiles remain visible.';
        notice.style.position = 'fixed';
        notice.style.left = '50%';
        notice.style.bottom = '76px';
        notice.style.transform = 'translateX(-50%)';
        notice.style.zIndex = '2147483000';
        notice.style.maxWidth = 'min(92vw, 34rem)';
        notice.style.padding = '8px 12px';
        notice.style.borderRadius = '8px';
        notice.style.background = 'rgba(45, 35, 20, .94)';
        notice.style.color = '#fff';
        notice.style.font = '500 12px/1.4 system-ui, sans-serif';
        notice.style.boxShadow = '0 2px 10px rgba(0,0,0,.25)';
        doc.body.appendChild(notice);
        coronaUnavailableNotice = notice;
        if (coronaNoticeTimer !== null) root.clearTimeout(coronaNoticeTimer);
        coronaNoticeTimer = root.setTimeout(function () {
            if (notice.parentNode) notice.parentNode.removeChild(notice);
            if (coronaUnavailableNotice === notice) coronaUnavailableNotice = null;
            coronaNoticeTimer = null;
        }, 8000);
    }

    function clearCoronaUnavailableNotice() {
        if (coronaNoticeTimer !== null) root.clearTimeout(coronaNoticeTimer);
        coronaNoticeTimer = null;
        if (coronaUnavailableNotice && coronaUnavailableNotice.parentNode) {
            coronaUnavailableNotice.parentNode.removeChild(coronaUnavailableNotice);
        }
        coronaUnavailableNotice = null;
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
            this._coronaRetryJobs = Object.create(null);

            L.TileLayer.WMS.prototype.initialize.call(this, url, options);
        },

        // Use Leaflet's normal image-tile path and exact WMS URL, but hold the
        // tile open for at most two transient retries before reporting failure.
        // Successful sibling tiles are independent and remain attached.
        createTile: function (coords, done) {
            var layer = this;
            var tile = root.document.createElement('img');
            var url = this.getTileUrl(coords);
            var state = {
                layer: layer,
                tile: tile,
                url: url,
                done: done,
                retries: 0,
                settled: false,
                retrying: false,
                job: null
            };

            tile.alt = '';
            tile.setAttribute('role', 'presentation');
            tile.className = 'leaflet-tile';
            if (this.options.crossOrigin) {
                tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
            }

            function removeFromRetryJob() {
                var job = state.job;
                if (!job) return;
                var memberAt = job.members.indexOf(state);
                if (memberAt !== -1) job.members.splice(memberAt, 1);
                var waitingAt = job.waiting.indexOf(state);
                if (waitingAt !== -1) job.waiting.splice(waitingAt, 1);
                state.job = null;
                if (!job.members.length) {
                    if (job.timer !== null) root.clearTimeout(job.timer);
                    delete layer._coronaRetryJobs[url];
                }
            }

            function finish(error) {
                if (state.settled) return;
                state.settled = true;
                tile.onload = null;
                tile.onerror = null;
                removeFromRetryJob();
                if (typeof done === 'function') done(error || null, tile);
            }

            function scheduleWaiting(job) {
                if (job.timer !== null || job.active > 0 || !job.waiting.length) return;
                var delay = 0;
                for (var i = 0; i < job.waiting.length; i++) {
                    var retryIndex = Math.min(job.waiting[i].retries, CORONA_TILE_RETRY_DELAYS.length - 1);
                    delay = Math.max(delay, CORONA_TILE_RETRY_DELAYS[retryIndex]);
                }
                job.timer = root.setTimeout(function () {
                    job.timer = null;
                    var waiting = job.waiting.slice();
                    job.waiting.length = 0;
                    for (var j = 0; j < waiting.length; j++) {
                        var waitingState = waiting[j];
                        if (waitingState.settled) continue;
                        waitingState.retries += 1;
                        waitingState.retrying = true;
                        job.active += 1;
                        // Reset the image to force a fresh load, then reuse the
                        // exact URL: no WMS parameters or cache-busting query
                        // strings are added to CAST requests.
                        waitingState.tile.removeAttribute('src');
                        waitingState.tile.src = waitingState.url;
                    }
                }, delay);
            }

            function queueRetry(status) {
                if (state.retrying && state.job) {
                    state.retrying = false;
                    state.job.active = Math.max(0, state.job.active - 1);
                }
                if (!isRetryableTileFailure(status) || state.retries >= CORONA_TILE_MAX_RETRIES) {
                    var retryJob = state.job;
                    finish(new Error('CORONA tile failed' + (status ? ' (HTTP ' + status + ')' : '')));
                    if (retryJob) scheduleWaiting(retryJob);
                    return;
                }

                showCoronaUnavailableNotice();
                var job = layer._coronaRetryJobs[url];
                if (!job) {
                    job = layer._coronaRetryJobs[url] = { members: [], waiting: [], active: 0, timer: null };
                }
                if (state.job !== job) {
                    state.job = job;
                    job.members.push(state);
                }
                if (job.waiting.indexOf(state) === -1) job.waiting.push(state);
                scheduleWaiting(job);
            }

            tile.onload = function (event) {
                var status = observedTileStatus(url, event);
                if (status !== null && status >= 400) {
                    queueRetry(status);
                    return;
                }
                if (!(tile.naturalWidth > 0 && tile.naturalHeight > 0)) {
                    queueRetry(status === null ? 200 : status);
                    return;
                }
                if (state.retrying) {
                    state.retrying = false;
                    if (state.job) {
                        state.job.active = Math.max(0, state.job.active - 1);
                        scheduleWaiting(state.job);
                    }
                    clearCoronaUnavailableNotice();
                }
                finish(null);
            };
            tile.onerror = function (event) {
                queueRetry(observedTileStatus(url, event));
            };
            tile.src = url;
            return tile;
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
     *   1. data/corona-europe-catalog.json — static build snapshot (fast,
     *      cacheable, and available offline when the PWA has cached it);
     *   2. /api/corona/rasters            — same-origin live catalogue proxy;
     *   3. window.CORONA_CATALOG_URL      — optional explicit override;
     *   4. the built-in minimal list below — last resort if all sources fail.
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

    function validExtent(extent) {
        return Object.prototype.toString.call(extent) === '[object Array]' && extent.length === 4 &&
            extent.every(function (n) { return typeof n === 'number' && isFinite(n); }) &&
            extent[0] >= -180 && extent[2] <= 180 && extent[1] >= -90 && extent[3] <= 90 &&
            extent[0] <= extent[2] && extent[1] <= extent[3];
    }

    function validProduct(entry, key) {
        if (!entry || typeof entry !== 'object' || Object.prototype.toString.call(entry) === '[object Array]') return false;
        var product = normalizeProduct(entry, key);
        if (!product || !validExtent(product.extent) || !product.location) return false;
        var rings = product.rings;
        if (!rings || !rings.length) return false;
        for (var r = 0; r < rings.length; r++) {
            if (!rings[r] || rings[r].length < 4) return false;
            for (var p = 0; p < rings[r].length; p++) {
                var point = rings[r][p];
                if (!point || point.length < 2 || !isFinite(point[0]) || !isFinite(point[1]) ||
                    point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90) return false;
            }
        }
        return true;
    }

    /* Reject HTML, empty JSON, partial blocks and count mismatches before the
     * payload can be treated as a successful source or cached by the PWA. */
    function validateCatalogPayload(payload) {
        if (!payload || typeof payload !== 'object' || Object.prototype.toString.call(payload) === '[object Array]') {
            throw new Error('catalogue is not a JSON object');
        }
        if (payload.blocks !== undefined && Object.prototype.toString.call(payload.blocks) !== '[object Array]') {
            throw new Error('catalogue blocks must be an array');
        }
        if (payload.blocks !== undefined &&
            (typeof payload.generated !== 'string' || !isFinite(Date.parse(payload.generated)) ||
             !validExtent(payload.bbox))) throw new Error('catalogue metadata is incomplete');
        var raw = payload.blocks || payload;
        var isArray = Object.prototype.toString.call(raw) === '[object Array]';
        var keys = isArray ? raw.map(function (_, i) { return i; }) : Object.keys(raw);
        if (!keys.length) throw new Error('catalogue contains no passes');
        var frames = 0;
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var block = raw[key];
            var blockKey = isArray ? (block && (block.id || block.location)) : key;
            if (!validProduct(block, blockKey) || Object.prototype.toString.call(block.images) !== '[object Array]') {
                throw new Error('catalogue contains an incomplete pass');
            }
            for (var j = 0; j < block.images.length; j++) {
                if (!validProduct(block.images[j], block.images[j] && block.images[j].location)) {
                    throw new Error('catalogue contains an incomplete frame');
                }
                frames += 1;
            }
        }
        if (!frames) throw new Error('catalogue contains no image frames');
        if (payload.passes !== undefined && payload.passes !== keys.length) throw new Error('catalogue pass count mismatch');
        if (payload.frames !== undefined && payload.frames !== frames) throw new Error('catalogue frame count mismatch');
        if (payload.bbox !== undefined && !validExtent(payload.bbox)) throw new Error('catalogue bbox is invalid');
        return { passes: keys.length, frames: frames };
    }

    /* ── catalogue loading ────────────────────────────────────────────────── */

    function catalogSources() {
        var sources = ['data/corona-europe-catalog.json', '/api/corona/rasters?bbox=' + EUROPE_BBOX.join(',')];
        if (root.CORONA_CATALOG_URL && sources.indexOf(root.CORONA_CATALOG_URL) === -1) {
            sources.push(root.CORONA_CATALOG_URL);
        }
        return sources;
    }

    var _catalogPromise = null;

    function showCatalogFallbackNotice() {
        console.error('[Corona] no catalogue source reachable or valid. Showing the limited built-in fallback list; other map layers remain available.');
        var doc = root.document;
        if (!doc || !doc.body || !doc.createElement) return;
        var notice = doc.getElementById && doc.getElementById('corona-catalog-warning');
        if (!notice) {
            notice = doc.createElement('div');
            notice.id = 'corona-catalog-warning';
            notice.setAttribute('role', 'status');
            notice.setAttribute('aria-live', 'polite');
            notice.textContent = 'Corona catalogue unavailable. Showing limited fallback coverage; other map layers are unaffected.';
            notice.style.position = 'fixed';
            notice.style.left = '50%';
            notice.style.bottom = '76px';
            notice.style.transform = 'translateX(-50%)';
            notice.style.zIndex = '2147483000';
            notice.style.maxWidth = 'min(92vw, 34rem)';
            notice.style.padding = '10px 14px';
            notice.style.borderRadius = '8px';
            notice.style.background = '#5c2f00';
            notice.style.color = '#fff';
            notice.style.font = '600 13px/1.4 system-ui, sans-serif';
            notice.style.boxShadow = '0 2px 12px rgba(0,0,0,.3)';
            doc.body.appendChild(notice);
        }
        if (notice._coronaTimer) root.clearTimeout(notice._coronaTimer);
        notice._coronaTimer = root.setTimeout(function () {
            if (notice.parentNode) notice.parentNode.removeChild(notice);
        }, 10000);
    }

    function loadCatalog(options) {
        options = options || {};
        if (_catalogPromise && !options.force) return _catalogPromise;
        if (options.force) _catalogPromise = null;

        var bbox = options.bbox || EUROPE_BBOX;
        var sources = options.sources || catalogSources();

        _catalogPromise = new Promise(function (resolve) {
            var index = 0;

            function finish(blocks, source) {
                if (blocks) {
                    console.info('[Corona] catalogue: ' + blocks.length + ' passes from ' + source);
                    resolve({ blocks: blocks, source: source });
                } else {
                    next();
                }
            }

            function next() {
                if (index >= sources.length) {
                    showCatalogFallbackNotice();
                    resolve({
                        blocks: FALLBACK_BLOCKS.slice(),
                        source: 'fallback',
                        warning: 'Static catalogue and live API are unavailable or invalid.'
                    });
                    return;
                }
                var url = sources[index++];
                var request;
                try {
                    request = fetch(url, { credentials: 'omit' });
                } catch (err) {
                    console.warn('[Corona] catalogue source failed (' + url + '): ' + (err && err.message));
                    next();
                    return;
                }
                request.then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    var contentType = response.headers && response.headers.get && response.headers.get('content-type');
                    if (contentType && /text\/html/i.test(contentType)) throw new Error('received HTML instead of JSON');
                    return response.json();
                }).then(function (json) {
                    validateCatalogPayload(json);
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

            // Hide only the failed image after bounded retries. Leaflet keeps
            // this tile isolated from already-loaded siblings and other layers.
            layer.on('tileerror', function (e) {
                if (e && e.tile) e.tile.style.display = 'none';
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
        validateCatalogPayload: validateCatalogPayload,
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
