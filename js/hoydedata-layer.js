/*
 * hoydedata-layer.js
 * ───────────────────────────────────────────────────────────────────────────
 * Norwegian LiDAR terrain (hillshade) from Kartverket's hoydedata.no ArcGIS
 * ImageServer, fetched live as the user pans and zooms. Nothing is
 * pre-generated or downloaded: every Leaflet tile becomes one `exportImage`
 * request in Web Mercator, which the service reprojects on the fly from its
 * native EPSG:25833.
 *
 * Why this file exists
 *   The previous Norwegian layer used the Geonorge WMS
 *   `wms.hoyde-hoydedata-metadata-prosjekt`, whose layers are *per survey
 *   project*: outside the one selected project the server answers 200 with a
 *   fully transparent PNG, so the map looked empty everywhere. The same trap
 *   exists on ArcGIS: requesting `…/ImageServer?f=image&…` (without the
 *   `/exportImage` operation) also returns HTTP 200 — but `text/html`, which
 *   an <img> silently renders as nothing.
 *
 * Verified against the live service on 2026-10-06 (see NORWAY_LIDAR_HOYDEDATA.md):
 *   • NHM_DTM_25833   exists, rasterFunctionInfos = ["skyggerelieff", "None"],
 *                     maxImageWidth/Height = 4096, pixel size 1 m.
 *   • NHM_DSM_25833   does NOT exist → the surface model is NHM_DOM_25833
 *                     (DOM = "digital overflatemodell"), same raster function.
 *   • exportImage with bboxSR/imageSR=3857 returns `content-type: image/png`.
 *   • identify returns {"value":"17.5408", …} and the server reflects the
 *     request Origin in access-control-allow-origin → fetch() works from the
 *     browser, no proxy required.
 *
 * Exposes `window.Hoydedata`:
 *   .CONFIG                      the single configuration block below
 *   .MODES                       {key: {label, service, renderingRule, …}}
 *   .serviceUrl(mode)            → …/<service>/ImageServer
 *   .exportImageUrl(mode, bbox3857, size)   pure URL builder (used by tests)
 *   .identifyUrl(mode, x3857, y3857)        pure URL builder
 *   .createLayer(options)        → L.GridLayer subclass instance
 *   .identify(latlng, mode)      → Promise<{elevation:Number|null, …}>
 *
 * No build step, no dependencies beyond Leaflet 1.x, no API keys.
 */
(function (root) {
    'use strict';

    var L = root.L;
    if (!L) {
        console.error('[Hoydedata] Leaflet is not loaded — hoydedata-layer.js must load after leaflet.js');
        return;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  CONFIG — everything tunable lives here and nowhere else.
     * ═══════════════════════════════════════════════════════════════════════ */
    var CONFIG = {
        // ArcGIS REST root. Each mode below appends "<service>/ImageServer".
        HOST: 'https://hoydedata.no/arcgis/rest/services',

        // Optional caching proxy in front of the public server. When set, it
        // replaces HOST for *tile* requests (see the Nginx / Cloudflare Worker
        // snippets in NORWAY_LIDAR_HOYDEDATA.md). Example:
        //   window.HOYDEDATA_PROXY_BASE = 'https://hoyde-cache.example.com/arcgis/rest/services';
        PROXY_BASE: root.HOYDEDATA_PROXY_BASE || '',

        // Which product the layer shows by default.
        DEFAULT_MODE: 'dtm',

        // The selectable products. `service` is the ArcGIS service name and
        // `renderingRule` the server-side raster function; both were read from
        // the service's own ?f=pjson, never guessed.
        MODES: {
            dtm: {
                label: 'DTM · terrain hillshade (1 m)',
                service: 'NHM_DTM_25833',
                renderingRule: 'skyggerelieff',
                elevation: true,                       // identify returns metres
                bounds: [[57.5, -1.0], [71.6, 32.0]]   // service extent, EPSG:25833 → WGS84
            },
            dsm: {
                label: 'DSM · surface hillshade (1 m)',
                // NHM_DSM_25833 does not exist; Kartverket calls the surface
                // model DOM ("digital overflatemodell").
                service: 'NHM_DOM_25833',
                renderingRule: 'skyggerelieff',
                elevation: true,
                bounds: [[57.5, -1.0], [71.6, 32.0]]
            },
            lrm: {
                // Local relief model: the archaeologist's favourite — it
                // removes the landform and leaves small surface anomalies.
                label: 'DTM · local relief (0.25 m)',
                service: 'DTM_lokalhoyde_graatone',
                renderingRule: 'LokalHoyde',
                elevation: false,                      // values are ±0.5 m residuals
                bounds: [[57.5, -1.0], [81.2, 36.0]]   // includes Svalbard
            }
        },

        OPACITY: 0.7,          // default opacity of the hillshade over the basemap
        MIN_ZOOM: 8,           // below this the data is useless and the requests huge
        MAX_NATIVE_ZOOM: 17,   // request real pixels up to z17, overzoom above
        MAX_ZOOM: 20,
        TILE_SIZE: 256,        // must match the `size` parameter (service max 4096)
        KEEP_BUFFER: 1,        // be a good citizen: barely preload outside the viewport
        FORMAT: 'png32',       // png32 keeps a real alpha channel; 'png' also works
        TRANSPARENT: true,
        INTERPOLATION: 'RSP_BilinearInterpolation',
        CROSS_ORIGIN: false,   // plain <img> tiles need no CORS; only set this if
                               // you intend to read the tiles back from a canvas
        ATTRIBUTION: 'Hillshade © Kartverket (CC BY 4.0)',

        // Click-to-read elevation (verified: CORS-safe, see header).
        IDENTIFY: {
            ENABLED: true,
            TIMEOUT_MS: 8000,
            LABEL: 'Elevation'
        }
    };
    /* ════════════════════════ end of configuration ═══════════════════════ */

    // 1×1 transparent PNG — the graceful fallback for a failed tile, so the
    // browser never shows a broken-image icon.
    var BLANK_TILE = 'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    /* Tell the availability guard (js/wms-health.js) that a tile could not be
       fetched. The module deliberately hides the failure from Leaflet, so the
       guard would never see a `tileerror`; this keeps the layer watched and
       lets a real outage become a visible, provider-named notice instead of a
       blank grid. No-op when the guard is absent or the layer unwatched. */
    function reportTileFailure(layer) {
        try {
            var health = root.DetectLabWmsHealth;
            if (health && typeof health.noteFailure === 'function') health.noteFailure(layer);
        } catch (e) {}
    }

    function mode(key) {
        return CONFIG.MODES[key] || CONFIG.MODES[CONFIG.DEFAULT_MODE];
    }

    function host(forTiles) {
        var base = (forTiles && CONFIG.PROXY_BASE) ? CONFIG.PROXY_BASE : CONFIG.HOST;
        return String(base).replace(/\/+$/, '');
    }

    // …/<service>/ImageServer — note that the *operation* (/exportImage,
    // /identify) must be appended; hitting the service root with f=image
    // returns HTML with status 200 and renders as an empty tile.
    function serviceUrl(key, forTiles) {
        return host(forTiles) + '/' + mode(key).service + '/ImageServer';
    }

    function round(n) {
        return Math.round(n * 1e6) / 1e6;
    }

    /**
     * Build an exportImage request.
     * @param {String} key    mode key ('dtm' | 'dsm' | 'lrm')
     * @param {Array}  bbox   [xmin, ymin, xmax, ymax] in EPSG:3857 metres
     * @param {Number} size   tile size in pixels (square)
     */
    function exportImageUrl(key, bbox, size) {
        var m = mode(key);
        var px = size || CONFIG.TILE_SIZE;
        var params = [
            'f=image',
            'format=' + encodeURIComponent(CONFIG.FORMAT),
            'bbox=' + bbox.map(round).join(','),
            'bboxSR=3857',
            'imageSR=3857',
            'size=' + px + ',' + px,
            'transparent=' + (CONFIG.TRANSPARENT ? 'true' : 'false'),
            'interpolation=' + CONFIG.INTERPOLATION,
            'renderingRule=' + encodeURIComponent(JSON.stringify({ rasterFunction: m.renderingRule }))
        ];
        return serviceUrl(key, true) + '/exportImage?' + params.join('&');
    }

    /** Build an identify request for one point in EPSG:3857 metres. */
    function identifyUrl(key, x, y) {
        var geometry = { x: round(x), y: round(y), spatialReference: { wkid: 3857 } };
        return serviceUrl(key, false) + '/identify?' + [
            'f=json',
            'geometry=' + encodeURIComponent(JSON.stringify(geometry)),
            'geometryType=esriGeometryPoint',
            'returnGeometry=false',
            'returnCatalogItems=false'
        ].join('&');
    }

    /* ── the tile layer ──────────────────────────────────────────────────── */

    var HoydedataGridLayer = L.GridLayer.extend({
        options: {
            mode: CONFIG.DEFAULT_MODE,
            tileSize: CONFIG.TILE_SIZE,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            maxNativeZoom: CONFIG.MAX_NATIVE_ZOOM,
            keepBuffer: CONFIG.KEEP_BUFFER,
            opacity: CONFIG.OPACITY,
            attribution: CONFIG.ATTRIBUTION,
            // Mobile safety: no tile churn during a pinch/drag, only at the end.
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true,
            crossOrigin: CONFIG.CROSS_ORIGIN
        },

        initialize: function (options) {
            L.setOptions(this, options || {});
            if (!this.options.bounds) {
                this.options.bounds = L.latLngBounds(mode(this.options.mode).bounds);
            }
            this._warned = false;
        },

        /**
         * One exportImage request per tile. The tile's extent comes from
         * Leaflet itself (`_tileCoordsToBounds`) and is projected with the
         * map's CRS, so the hillshade lines up with the basemap pixel for
         * pixel — no hand-rolled Web-Mercator maths.
         */
        tileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var crs = (this._map && this._map.options.crs) || L.CRS.EPSG3857;
            var sw = crs.project(bounds.getSouthWest());
            var ne = crs.project(bounds.getNorthEast());
            var size = this.getTileSize();
            return exportImageUrl(this.options.mode, [sw.x, sw.y, ne.x, ne.y], size.x);
        },

        createTile: function (coords, done) {
            var tile = L.DomUtil.create('img', 'leaflet-tile');
            var size = this.getTileSize();
            var self = this;
            var settled = false;

            tile.alt = '';
            tile.setAttribute('role', 'presentation');
            tile.width = size.x;
            tile.height = size.y;
            if (this.options.crossOrigin) tile.crossOrigin = this.options.crossOrigin;

            tile.onload = function () {
                if (settled) return;
                settled = true;
                done(null, tile);
            };

            // Graceful failure: swap in a transparent pixel and report success
            // so Leaflet neither retries nor logs, and the user never sees a
            // broken-image icon. One console warning per layer, not per tile.
            // The failure still reaches the availability guard — it removes
            // the layer and explains the provider once a whole run of tiles
            // has failed, so “blank grid” never stays unexplained.
            tile.onerror = function () {
                if (settled) return;
                settled = true;
                tile.onerror = null;
                tile.src = BLANK_TILE;
                if (!self._warned) {
                    self._warned = true;
                    console.warn('[Hoydedata] a hillshade tile could not be loaded (' +
                        mode(self.options.mode).service + '); further failures are silent');
                }
                reportTileFailure(self);
                done(null, tile);
            };

            tile.src = this.tileUrl(coords);
            return tile;
        },

        onAdd: function (map) {
            L.GridLayer.prototype.onAdd.call(this, map);
            this.setOpacity(this.options.opacity);
        },

        setOpacity: function (opacity) {
            this.options.opacity = opacity;
            if (this._container) this._container.style.opacity = opacity;
            return this;
        },

        /** Switch DTM ⇄ DSM ⇄ local relief without rebuilding the layer. */
        setMode: function (key) {
            if (!CONFIG.MODES[key] || key === this.options.mode) return this;
            this.options.mode = key;
            this.options.bounds = L.latLngBounds(mode(key).bounds);
            this._warned = false;
            if (this._map) this.redraw();
            return this;
        },

        getMode: function () { return this.options.mode; }
    });

    function createLayer(options) {
        return new HoydedataGridLayer(options || {});
    }

    /* ── click → elevation ───────────────────────────────────────────────── */

    /**
     * Read the elevation under a point.
     * @param {L.LatLng} latlng
     * @param {String}   key   mode key; defaults to the configured default
     * @returns {Promise<{elevation:Number|null, raw:Object, service:String}>}
     */
    function identify(latlng, key) {
        var m = mode(key);
        var crs = L.CRS.EPSG3857;
        var p = crs.project(latlng);
        var url = identifyUrl(key, p.x, p.y);

        var controller = (typeof AbortController === 'function') ? new AbortController() : null;
        var timer = controller && setTimeout(function () { controller.abort(); }, CONFIG.IDENTIFY.TIMEOUT_MS);

        return fetch(url, controller ? { signal: controller.signal } : undefined)
            .then(function (response) {
                if (!response.ok) throw new Error('identify HTTP ' + response.status);
                return response.json();
            })
            .then(function (data) {
                if (timer) clearTimeout(timer);
                // ArcGIS answers {"value":"17.5408"} — or "NoData" outside coverage.
                var value = data && data.value;
                var num = (value === undefined || value === null || value === 'NoData')
                    ? null : parseFloat(value);
                return {
                    elevation: (num === null || isNaN(num)) ? null : num,
                    isElevation: !!m.elevation,
                    service: m.service,
                    raw: data
                };
            })
            .catch(function (error) {
                if (timer) clearTimeout(timer);
                throw error;
            });
    }

    /** "Elevation: 17.5 m" / "No data here" — ready for a popup. */
    function formatIdentify(result) {
        if (!result || result.elevation === null) return 'No elevation data here';
        if (!result.isElevation) return 'Local relief: ' + result.elevation.toFixed(2) + ' m';
        return CONFIG.IDENTIFY.LABEL + ': ' + result.elevation.toFixed(1) + ' m';
    }

    root.Hoydedata = {
        CONFIG: CONFIG,
        MODES: CONFIG.MODES,
        BLANK_TILE: BLANK_TILE,
        GridLayer: HoydedataGridLayer,
        serviceUrl: serviceUrl,
        exportImageUrl: exportImageUrl,
        identifyUrl: identifyUrl,
        createLayer: createLayer,
        identify: identify,
        formatIdentify: formatIdentify,
        modeKeys: function () { return Object.keys(CONFIG.MODES); }
    };
})(typeof window !== 'undefined' ? window : this);
