/*
 * ahn-layer.js
 * ───────────────────────────────────────────────────────────────────────────
 * Netherlands — AHN (Actueel Hoogtebestand Nederland) LiDAR terrain, fetched
 * live from the public Esri Nederland ArcGIS ImageServers as the user pans and
 * zooms. Every Leaflet tile becomes one `exportImage` request in Web Mercator,
 * which the service reprojects on the fly from its native RD New (EPSG:28992).
 * Nothing is downloaded or pre-generated.
 *
 * Why this file exists — two real bugs it fixes
 *   1. The old builder requested `…/ImageServer?f=image&bbox=…` WITHOUT the
 *      `/exportImage` operation. Verified live on 2026-10-06: that URL answers
 *      HTTP 200 with `content-type: text/html`, which an <img> renders as
 *      nothing. The Netherlands row was therefore permanently blank.
 *   2. It pointed at AHN6, whose mosaic is still only partially flown.
 *      Verified with /identify at the same point:
 *        Veluwe  (52.10 N 5.80 E): AHN6 = 31.649 m, AHN5 = NoData
 *        Limburg (50.80 N 5.95 E): AHN6 = NoData,   AHN4 = 167 m
 *      So AHN6 alone leaves large holes. The default is now AHN4 (complete
 *      national coverage); AHN5 and AHN6 stay available in the dropdown for
 *      the newest data where it exists.
 *
 * Verified against the live services on 2026-10-06 (see NETHERLANDS_LIDAR_AHN.md):
 *   • Folder /Hoogtebestand lists AHN2…AHN6; AHN4/AHN5/AHN6 exist as
 *     DTM_50cm and DSM_50cm ImageServers, pixel size 0.5 m, EPSG:28992.
 *   • rasterFunctionInfos include "AHN - Hillshade (Multidirectionaal)",
 *     "AHN - Shaded Relief", "AHN - Slope (kleur)" and the colour ramps —
 *     every rendering rule below was read from the service, never guessed.
 *   • exportImage with bboxSR/imageSR=3857 returns `content-type: image/png`
 *     (AHN4 DTM hillshade over Limburg: 27 157 bytes of real relief).
 *   • CORS: the server echoes the request Origin in
 *     access-control-allow-origin (plus allow-credentials), so <img> tiles
 *     work and fetch()/canvas reads work from any origin.
 *   • maxImageWidth/Height = 15000, so a 256 px tile is well inside limits.
 *
 * Exposes `window.AhnLidar`:
 *   .CONFIG / .MODES
 *   .serviceUrl(mode)                      → …/<service>/ImageServer
 *   .exportImageUrl(mode, bbox3857, size)  pure URL builder (used by tests)
 *   .identifyUrl(mode, x3857, y3857)       pure URL builder
 *   .createLayer(options)                  → L.GridLayer subclass instance
 *   .identify(latlng, mode)                → Promise<{elevation, …}>
 *
 * No build step, no dependencies beyond Leaflet 1.x, no API keys, no tokens.
 */
(function (root) {
    'use strict';

    var L = root.L;
    if (!L) {
        console.error('[AhnLidar] Leaflet is not loaded — ahn-layer.js must load after leaflet.js');
        return;
    }

    /* ═══════════════════════════════════════════════════════════════════════
     *  CONFIG — everything tunable lives here and nowhere else.
     * ═══════════════════════════════════════════════════════════════════════ */
    var CONFIG = {
        // ArcGIS REST folder. Each mode appends "<service>/ImageServer".
        HOST: 'https://ahn.arcgisonline.nl/arcgis/rest/services/Hoogtebestand',

        // Optional caching proxy / CDN in front of the public server; see the
        // Nginx and Cloudflare Worker snippets in NETHERLANDS_LIDAR_AHN.md:
        //   window.AHN_PROXY_BASE = 'https://ahn-cache.example.com/arcgis/rest/services/Hoogtebestand';
        PROXY_BASE: root.AHN_PROXY_BASE || '',

        // AHN4 by default: it is the only campaign with complete national
        // coverage (AHN5/AHN6 are still being flown).
        DEFAULT_MODE: 'dtm',

        // `service` = ArcGIS service name, `renderingRule` = server-side raster
        // function; both read from each service's own ?f=pjson.
        MODES: {
            dtm: {
                label: 'AHN4 DTM · hillshade (0.5 m, full cover)',
                service: 'AHN4_DTM_50cm',
                renderingRule: 'AHN - Hillshade (Multidirectionaal)',
                elevation: true
            },
            relief: {
                label: 'AHN4 DTM · colour shaded relief',
                service: 'AHN4_DTM_50cm',
                renderingRule: 'AHN - Shaded Relief',
                elevation: true
            },
            slope: {
                // Slope often reads micro-relief (banks, ditches, trackways)
                // better than a hillshade in this very flat landscape.
                label: 'AHN4 DTM · slope (colour)',
                service: 'AHN4_DTM_50cm',
                renderingRule: 'AHN - Slope (kleur)',
                elevation: true
            },
            dsm: {
                label: 'AHN4 DSM · surface hillshade (0.5 m)',
                service: 'AHN4_DSM_50cm',
                renderingRule: 'AHN - Hillshade (Multidirectionaal)',
                elevation: true
            },
            ahn5: {
                label: 'AHN5 DTM · hillshade (newer, partial cover)',
                service: 'AHN5_DTM_50cm',
                renderingRule: 'AHN - Hillshade (Multidirectionaal)',
                elevation: true
            },
            ahn6: {
                label: 'AHN6 DTM · hillshade (newest, partial cover)',
                service: 'AHN6_DTM_50cm',
                renderingRule: 'AHN - Hillshade (Multidirectionaal)',
                elevation: true
            }
        },

        OPACITY: 0.8,          // default opacity of the relief over the basemap
        MIN_ZOOM: 8,           // below this the request covers half the country
        MAX_NATIVE_ZOOM: 19,   // 0.5 m data ≈ 0.3 m/px at z19; overzoom above
        MAX_ZOOM: 21,
        TILE_SIZE: 256,        // must match `size` (service max 15000)
        KEEP_BUFFER: 1,        // be a good citizen: barely preload off-screen
        FORMAT: 'png32',       // real alpha channel outside the mosaic
        TRANSPARENT: true,
        INTERPOLATION: 'RSP_BilinearInterpolation',
        CROSS_ORIGIN: false,   // plain <img> tiles need no CORS; set to
                               // 'anonymous' only to read tiles from a canvas

        // Netherlands only — the services' RD extent reaches into the North Sea.
        BOUNDS: [[50.65, 3.20], [53.70, 7.25]],

        ATTRIBUTION: 'AHN hillshade © <a href="https://www.ahn.nl/" target="_blank" ' +
            'rel="noopener">AHN</a> / Esri Nederland (CC BY 4.0)',

        // Click-to-read elevation (verified: /identify is CORS-safe).
        IDENTIFY: {
            ENABLED: true,
            TIMEOUT_MS: 8000,
            LABEL: 'Elevation'
        }
    };
    /* ════════════════════════ end of configuration ═══════════════════════ */

    // 1×1 transparent PNG — graceful fallback for a failed tile, so the
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

    // …/<service>/ImageServer — the *operation* (/exportImage, /identify) must
    // always be appended: the service root with f=image answers 200 text/html,
    // which renders as an empty tile. That was the original bug.
    function serviceUrl(key, forTiles) {
        return host(forTiles) + '/' + mode(key).service + '/ImageServer';
    }

    function round(n) { return Math.round(n * 1e6) / 1e6; }

    /**
     * Build an exportImage request.
     * @param {String} key   mode key
     * @param {Array}  bbox  [xmin, ymin, xmax, ymax] in EPSG:3857 metres
     * @param {Number} size  tile size in pixels (square)
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
            'adjustAspectRatio=false',
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

    var AhnGridLayer = L.GridLayer.extend({
        options: {
            mode: CONFIG.DEFAULT_MODE,
            tileSize: CONFIG.TILE_SIZE,
            minZoom: CONFIG.MIN_ZOOM,
            maxZoom: CONFIG.MAX_ZOOM,
            maxNativeZoom: CONFIG.MAX_NATIVE_ZOOM,
            keepBuffer: CONFIG.KEEP_BUFFER,
            opacity: CONFIG.OPACITY,
            attribution: CONFIG.ATTRIBUTION,
            updateWhenZooming: false,   // no tile churn during a pinch/drag
            updateWhenIdle: true,
            noWrap: true,
            crossOrigin: CONFIG.CROSS_ORIGIN
        },

        initialize: function (options) {
            L.setOptions(this, options || {});
            if (!this.options.bounds) {
                this.options.bounds = L.latLngBounds(CONFIG.BOUNDS);
            }
            this._warned = false;
        },

        /**
         * One exportImage request per tile. The tile extent comes from Leaflet
         * itself (`_tileCoordsToBounds`) and is projected with the map's CRS,
         * so the relief lines up with the basemap pixel for pixel — no
         * hand-rolled Web-Mercator maths.
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

            // Graceful failure: swap in a transparent pixel and report success,
            // so Leaflet neither retries nor logs and the user never sees a
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
                    console.warn('[AhnLidar] a relief tile could not be loaded (' +
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

        /** Switch product (AHN4 DTM ⇄ slope ⇄ DSM ⇄ AHN5/AHN6) in place. */
        setMode: function (key) {
            if (!CONFIG.MODES[key] || key === this.options.mode) return this;
            this.options.mode = key;
            this._warned = false;
            if (this._map) this.redraw();
            return this;
        },

        getMode: function () { return this.options.mode; }
    });

    function createLayer(options) {
        return new AhnGridLayer(options || {});
    }

    /* ── click → elevation ───────────────────────────────────────────────── */

    /**
     * Read the elevation under a point (metres above NAP).
     * @returns {Promise<{elevation:Number|null, service:String, raw:Object}>}
     */
    function identify(latlng, key) {
        var m = mode(key);
        var p = L.CRS.EPSG3857.project(latlng);
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
                // ArcGIS answers {"value":"31.649"} — or "NoData" outside the mosaic.
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

    /** "Elevation: 31.6 m NAP" / "No data here" — ready for a popup. */
    function formatIdentify(result) {
        if (!result || result.elevation === null) return 'No AHN data here';
        return CONFIG.IDENTIFY.LABEL + ': ' + result.elevation.toFixed(1) + ' m NAP';
    }

    root.AhnLidar = {
        CONFIG: CONFIG,
        MODES: CONFIG.MODES,
        BLANK_TILE: BLANK_TILE,
        GridLayer: AhnGridLayer,
        serviceUrl: serviceUrl,
        exportImageUrl: exportImageUrl,
        identifyUrl: identifyUrl,
        createLayer: createLayer,
        identify: identify,
        formatIdentify: formatIdentify,
        modeKeys: function () { return Object.keys(CONFIG.MODES); }
    };
})(typeof window !== 'undefined' ? window : this);
