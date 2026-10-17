/*
 * js/asig-albania-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * DetectLab · the Albanian layers (ASIG geoportal, geoportal.asig.gov.al)
 *
 * What this file does — and what it deliberately does not do
 *   It reads js/asig-albania-layers.config.js and turns every entry into a
 *   panel row and a Leaflet tile layer. It holds no data of its own: a new
 *   Albanian layer, a renamed snapshot layer (the protected-sites names carry
 *   publication dates) or a different label is a change in the CONFIG file
 *   only — no map code has to be touched. The shared registry
 *   (js/layer-registry.js) mirrors the same config into the catalogue, so the
 *   3D status report, the diagnostics pop-up and the offline audit see the
 *   very same definitions.
 *
 * Projection strategy (see the config header for the full story)
 *   ASIG's native CRS is EPSG:6870 and its WMTS only publishes the national
 *   grid; this map — like the rest of Europe — is Web Mercator. So, exactly
 *   like the Polish GUGiK layer (js/geoportal-nmt-layer.js), every tile is a
 *   WMS 1.1.1 GetMap whose BBOX is the Leaflet tile's own extent projected
 *   to EPSG:3857; GeoServer reprojects server-side. If a layer ever starts
 *   refusing EPSG:3857 it falls back per tile to EPSG:4326 after a few
 *   errors, and if requests keep failing the row says “the source is not
 *   answering” instead of going silently blank (ALBANIA_ASIG_LAYERS.md §5).
 *
 * Panel behaviour
 *   • raster rows are independent checkboxes (they are meant to STACK:
 *     topographic / orthophotos at the bottom, the semi-transparent DSM and
 *     LiDAR hillshades on top — the LiDAR hillshade starts at 50%);
 *   • the four “Protected Sites” rows are one collapsible toggle group of
 *     child checkboxes (transparent vector overlays, always above the
 *     Albanian rasters, below the LiDAR pane/zlevel of the app);
 *   • every row has its own opacity slider and a status line;
 *   • rows are keyboard-operable (real checkbox/range inputs inside
 *     <label>s) and the group row carries aria-hidden for the country filter.
 *
 * Laziness
 *   Nothing is requested until a row is switched on: the layer object is
 *   built on first activation and Leaflet creates the tiles only once it is
 *   on the map. A layer marked on is restored between sessions.
 *
 * Failure handling
 *   Government server, no SLA: a failed tile degrades to a transparent
 *   pixel, one console warning per layer at most, repeated failures switch
 *   CRS once, persistent failures surface the panel's own notice through the
 *   row status line.
 *
 * No build step, no dependencies beyond Leaflet 1.x, no API keys, no tokens.
 */
(function (window, document) {
    'use strict';

    var CONFIG = window.ASIG_ALBANIA_CONFIG || window.ASIG_ALBANIA_LAYERS;
    if (!CONFIG || !Array.isArray(CONFIG.layers) || !CONFIG.layers.length) {
        if (window.console) {
            window.console.warn('[AsigAlbania] js/asig-albania-layers.config.js is missing — ' +
                'the Albanian layers are not available.');
        }
        return;
    }

    var L = window.L;
    if (!L) {
        if (window.console) {
            window.console.error('[AsigAlbania] Leaflet is not loaded — asig-albania-layers.js must load after leaflet.js');
        }
        return;
    }

    /* ── constants ────────────────────────────────────────────────────────── */

    var LAYERS = CONFIG.enabledLayers();
    var GROUP_ROW_ID = 'albaniaRow';
    var SUB_CONTAINER_ID = 'albaniaSubLayers';
    var GROUP_NOTICE_ID = 'albaniaGroupNotice';
    var STORE_KEY = 'detectlab_albania_layers_v1';

    /* Panes. The Albanian stack sits just above the app's own basemap stack
     * (pane_satellite z398) and the Danish rasters (z406 is Denmark only —
     * the two countries never overlap): Albanian rasters at 405, the
     * protected-sites vector overlays above them at 407, both below every
     * app-wide data pane (LiDAR 610, heritage 620, historical 640+). */
    var PANE_RASTER = 'pane_albania_raster';
    var PANE_PROTECTED = 'pane_albania_protected';
    var Z_RASTER = 405;
    var Z_PROTECTED = 407;

    // Transparent 1×1 PNG: Leaflet swaps it in for failed tiles, so the user
    // never sees a broken-image icon (outside coverage or service error).
    var BLANK_TILE = 'data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    function wmsBase() {
        /* A whole-service override — a caching proxy or a mirror — from the
         * page, without touching code (same idea as DETECTLAB_CENAGIS_WMS):
         *     window.DETECTLAB_ASIG_WMS = 'https://asig-cache.example.com/wms';
         */
        return String(window.DETECTLAB_ASIG_WMS || CONFIG.wms.url || '').replace(/\/+$/, '');
    }

    /* ── the WMS request builder (pure — used by the layer AND the tests) ── */

    function round(n, digits) {
        var f = Math.pow(10, digits === undefined ? 4 : digits);
        return Math.round(n * f) / f;
    }

    /**
     * Build a WMS 1.1.1 GetMap request for one tile.
     * @param {String} id    layer id from the CONFIG
     * @param {Array}  bbox  [minx, miny, maxx, maxy] — metres for EPSG:3857,
     *                       degrees (lon,lat axis order) for EPSG:4326
     * @param {Number} size  tile size in pixels (square)
     * @param {String} crs   'EPSG:3857' or 'EPSG:4326'
     */
    function tileUrl(id, bbox, size, crs) {
        var layer = CONFIG.byId(id);
        if (!layer) throw new Error('[AsigAlbania] unknown layer id: ' + id);
        var px = size || CONFIG.wms.tileSize;
        var useCrs = crs || CONFIG.wms.crs;
        var digits = (useCrs === 'EPSG:4326') ? 7 : 4;
        var params = [
            'SERVICE=WMS',
            'VERSION=' + encodeURIComponent(CONFIG.wms.version),
            'REQUEST=GetMap',
            'LAYERS=' + encodeURIComponent(layer.layers),
            'STYLES=' + encodeURIComponent(CONFIG.wms.styles),
            'SRS=' + encodeURIComponent(useCrs),   /* WMS 1.1.1 → SRS (1.3.0 would be CRS) */
            'BBOX=' + bbox.map(function (v) { return round(v, digits); }).join(','),
            'WIDTH=' + px,
            'HEIGHT=' + px,
            'FORMAT=' + encodeURIComponent(layer.format),
            'TRANSPARENT=' + (layer.transparent ? 'TRUE' : 'FALSE')
        ];
        return wmsBase() + '?' + params.join('&');
    }

    /* ── the tile layer ──────────────────────────────────────────────────── */

    /* One GetMap per tile. The tile extent comes from Leaflet itself, so the
     * raster lands exactly where the basemap tile is. Mirrors the Polish
     * module: EPSG:3857 first, EPSG:4326 (lon,lat axis order in 1.1.1) as the
     * automatic fallback, a transparent pixel for a failed tile and at most
     * one console warning per layer — plus a status-line notice once the
     * layer has clearly failed (“the source is not answering”). */
    var AsigWmsLayer = L.TileLayer.extend({
        options: {
            crs: CONFIG.wms.crs,
            tileSize: CONFIG.wms.tileSize,
            minZoom: 7,
            maxZoom: 20,
            maxNativeZoom: 18,
            keepBuffer: CONFIG.wms.keepBuffer,
            opacity: 1,
            attribution: CONFIG.attribution,
            errorTileUrl: BLANK_TILE,
            updateWhenZooming: false,
            updateWhenIdle: true,
            noWrap: true,
            crossOrigin: false    /* plain <img> tiles need no CORS */
        },

        initialize: function (layerDef, options) {
            this._layerDef = layerDef;
            this._warned = false;
            this._errorCount = 0;
            this._fallbackAnnounced = false;
            L.setOptions(this, options || {});
            if (!this.options.bounds && CONFIG.countryBounds) {
                this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
            }
            this.options.minZoom = layerDef.minZoom;
            this.options.maxNativeZoom = layerDef.maxNativeZoom;
            // L.TileLayer's own initialize takes (url, options); the URL is
            // computed per tile, so pass an empty template.
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

        _onTileLoad: function () {
            this._errorCount = 0;
        },

        _onTileError: function () {
            this._errorCount++;
            if (!this._warned) {
                this._warned = true;
                if (window.console) {
                    window.console.warn('[AsigAlbania] a ' + this._layerDef.id +
                        ' tile could not be loaded; further failures are silent');
                }
            }
            /* EPSG:3857 is the fastest path today, but GeoServer only ever
             * guarantees the native EPSG:6870 and EPSG:4326. If 3857 starts
             * failing, fall back to per-tile EPSG:4326 requests instead of
             * leaving the user with an empty layer. */
            if (this.options.crs === CONFIG.wms.crs &&
                this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                if (window.console && !this._fallbackAnnounced) {
                    this._fallbackAnnounced = true;
                    window.console.warn('[AsigAlbania] ' + this._layerDef.id +
                        ': switching to ' + CONFIG.wms.fallbackCrs + ' tiles after repeated failures');
                }
                this.options.crs = CONFIG.wms.fallbackCrs;
                this._errorCount = 0;
                this.redraw();
                return;
            }
            /* Already on the fallback and still failing: that is a layer that
             * is down, not a projection issue — say so once, in the row. */
            if (this.options.crs === CONFIG.wms.fallbackCrs &&
                this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                this._errorCount = 0;
                if (typeof this.options.onUnavailable === 'function') {
                    this.options.onUnavailable(this._layerDef);
                }
            }
        },

        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var size = this.getTileSize();
            var sw = bounds.getSouthWest();
            var ne = bounds.getNorthEast();

            if (this.options.crs === 'EPSG:4326') {
                /* WMS 1.1.1: lon,lat axis order. */
                return tileUrl(this._layerDef.id,
                    [sw.lng, sw.lat, ne.lng, ne.lat], size.x, 'EPSG:4326');
            }
            var crs = (this._map && this._map.options.crs) || L.CRS.EPSG3857;
            var swP = crs.project(sw);
            var neP = crs.project(ne);
            return tileUrl(this._layerDef.id,
                [swP.x, swP.y, neP.x, neP.y], size.x, 'EPSG:3857');
        }
    });

    /* ── language ─────────────────────────────────────────────────────────── */

    function lang() {
        try {
            if (typeof window._currentLang === 'function') return String(window._currentLang() || 'en');
        } catch (e) { /* private mode / translations not loaded yet */ }
        var htmlLang = document.documentElement && document.documentElement.getAttribute('lang');
        return String(htmlLang || 'en');
    }
    /* Romanian in the Romanian UI, English everywhere else — the app's own
     * rule (every dictionary is merged over translations.en). */
    function tr(pair) {
        if (!pair) return '';
        if (typeof pair === 'string') return pair;
        return lang().toLowerCase().indexOf('ro') === 0 ? (pair.ro || pair.en || '') : (pair.en || pair.ro || '');
    }

    /* The few labels this module generates itself. Everything static in the
     * group markup (title, switch titles) lives in index.html. */
    var TEXT = {
        raster: { ro: 'Raster', en: 'Raster' },
        protectedSites: { ro: 'Arii protejate', en: 'Protected Sites' },
        opacity: { ro: 'Opacitate', en: 'Opacity' },
        unavailable: { ro: 'sursa nu răspunde', en: 'the source is not answering' },
        expandProtected: { ro: 'Extinde/restrânge ariile protejate', en: 'Expand/Collapse the Protected Sites' }
    };

    /* ── state ────────────────────────────────────────────────────────────── */

    var runtime = {
        ready: false,
        map: null,
        panes: false,
        built: {},          /* id → Leaflet layer                              */
        active: {},         /* id → true when it is on the map                 */
        opacity: {},        /* id → 0–100                                      */
        rows: {},           /* id → { row, input, slider, pct, status }        */
        notices: {},        /* id → { text, kind }                             */
        expanded: false,
        expandedProtected: true,
        protectedBody: null
    };

    var MASTER_ID = 'albaniaToggle';

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
                expandedProtected: runtime.expandedProtected
            }));
        } catch (e) { /* private mode: the choice just is not remembered */ }
    }

    function applyStored() {
        var saved = persisted() || {};
        var savedActive = saved.active || {};
        var savedOpacity = saved.opacity || {};
        LAYERS.forEach(function (layer) {
            runtime.opacity[layer.id] = Math.round(
                typeof layer.opacity === 'number' ? layer.opacity * 100 : 100
            );
            if (typeof savedOpacity[layer.id] === 'number') runtime.opacity[layer.id] = savedOpacity[layer.id];
            if (typeof savedActive[layer.id] === 'boolean') runtime.active[layer.id] = savedActive[layer.id];
        });
        if (typeof saved.expanded === 'boolean') runtime.expanded = saved.expanded;
        if (typeof saved.expandedProtected === 'boolean') runtime.expandedProtected = saved.expandedProtected;
    }

    /* ── the map ─────────────────────────────────────────────────────────── */

    function getMap() {
        return window._dlMap || window.map || null;
    }

    function ensurePanes(map) {
        if (runtime.panes || !map || !map.createPane) return;
        [[PANE_RASTER, Z_RASTER], [PANE_PROTECTED, Z_PROTECTED]].forEach(function (def) {
            var pane = map.getPane && map.getPane(def[0]);
            if (!pane) pane = map.createPane(def[0]);
            pane.style.zIndex = def[1];
        });
        runtime.panes = true;
    }

    function build(layer) {
        var built = new AsigWmsLayer(layer, {
            pane: layer.group === 'protected' ? PANE_PROTECTED : PANE_RASTER,
            opacity: runtime.opacity[layer.id] / 100,
            attribution: CONFIG.attribution,
            keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                ? window.DLTilePerf.config.keepBuffer
                : CONFIG.wms.keepBuffer,
            onUnavailable: function (layerDef) {
                setStatus(layerDef.id, tr(TEXT.unavailable), 'warn');
            }
        });
        /* Naming the definition lets the availability guard and the
         * diagnostics talk about this layer instead of a hostname. The layer
         * carries `_detectlabNoGuard`: this module owns the row and explains
         * its own failures (CRS fallback + status line), and a guard trip
         * would flip the very switch that drives the state machine here. The
         * host is still listed in the guard's HOSTS map and the audit records
         * the opt-out on the definition (guard:false + selfGuardedReason). */
        try {
            built._dlDefId = 'albania.' + layer.id;
            built._detectlabProvider = CONFIG.provider;
            built._detectlabUiTitle = tr(layer.title);
            built._detectlabUiKeys = ['albaniaToggle_' + layer.id];
            built._detectlabNoGuard = true;
        } catch (e) {}
        return built;
    }

    /* `order` ranks the WHOLE Albanian stack (protected sites are on the
     * higher pane, so a zIndex inside the pane keeps each row's relative
     * rank; bringToFront would fight Leaflet's tile pruning, zIndex does
     * not). */
    function applyZIndex(layer) {
        var built = runtime.built[layer.id];
        if (built && typeof built.setZIndex === 'function') {
            built.setZIndex(layer.order % 100);
        }
    }

    function activate(layer) {
        var map = runtime.map || getMap();
        runtime.active[layer.id] = true;
        if (!map) return;
        ensurePanes(map);
        if (!runtime.built[layer.id]) runtime.built[layer.id] = build(layer);
        var built = runtime.built[layer.id];
        if (typeof built.setOpacity === 'function') built.setOpacity(runtime.opacity[layer.id] / 100);
        if (!map.hasLayer(built)) map.addLayer(built);
        applyZIndex(layer);
        setStatus(layer.id, '', 'info');
    }

    function deactivate(layer) {
        runtime.active[layer.id] = false;
        setStatus(layer.id, '', 'info');
        var map = runtime.map || getMap();
        var built = runtime.built[layer.id];
        if (map && built && map.hasLayer(built)) map.removeLayer(built);
    }

    /* The master switch: on ⇒ the default layers (today: the LiDAR
     * hillshade) unless the visitor made their own pick; off ⇒ everything
     * Albanian comes off the map. Like the LiDAR master switch, “off” also
     * resets the sub-switches so a later “on” never resurrects rows that were
     * left burning by accident. */
    function toggleGroup(on) {
        if (on) {
            var anyActive = LAYERS.some(function (layer) { return runtime.active[layer.id]; });
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id] || (!anyActive && layer.defaultOn)) {
                    activate(layer);
                }
            });
        } else {
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) deactivate(layer);
            });
        }
        syncUI();
        save();
    }

    function setOpacity(layer, value, fromSlide) {
        var v = Math.max(0, Math.min(100, Number(value) || 0));
        runtime.opacity[layer.id] = v;
        var built = runtime.built[layer.id];
        if (built && typeof built.setOpacity === 'function') built.setOpacity(v / 100);
        /* Sliding past 0 switches the row on for you — the app's standing
         * rule (see the LiDAR sliders). */
        if (v > 0 && !runtime.active[layer.id]) activate(layer);
        if (v === 0 && runtime.active[layer.id]) deactivate(layer);
        syncUI();
        save();
    }

    function setExpanded(expanded) {
        runtime.expanded = !!expanded;
        var container = document.getElementById(SUB_CONTAINER_ID);
        var icon = document.getElementById('albaniaExpandIcon');
        var btn = document.getElementById('albaniaExpandBtn');
        if (container) {
            if (runtime.expanded) {
                /* Measured, not hard-coded: a fixed max-height is exactly how
                 * the older accordions clipped their last checkbox. */
                container.style.maxHeight = container.scrollHeight + 'px';
                container.style.opacity = '1';
                container.style.marginTop = '0';
            } else {
                container.style.maxHeight = '0';
                container.style.opacity = '0';
                container.style.marginTop = '0';
            }
        }
        if (icon) icon.style.transform = runtime.expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        if (btn) btn.setAttribute('aria-expanded', runtime.expanded ? 'true' : 'false');
        save();
    }

    function setExpandedProtected(expanded) {
        runtime.expandedProtected = !!expanded;
        var body = runtime.protectedBody;
        if (body) {
            if (runtime.expandedProtected) {
                body.style.maxHeight = body.scrollHeight + 'px';
                body.style.opacity = '1';
            } else {
                body.style.maxHeight = '0';
                body.style.opacity = '0';
            }
        }
        var icon = document.getElementById('albaniaProtectedIcon');
        if (icon) icon.style.transform = runtime.expandedProtected ? 'rotate(0deg)' : 'rotate(-90deg)';
        /* The outer accordion's measured height changed with it. */
        if (runtime.expanded) setExpanded(true);
        save();
    }

    /* ── the panel ───────────────────────────────────────────────────────── */

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

    function setStatus(id, text, kind) {
        runtime.notices[id] = text ? { text: text, kind: kind || 'info' } : null;
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        row.status.textContent = text || '';
        row.status.style.display = text ? 'block' : 'none';
        row.status.className = 'albania-layer-status' + (kind ? ' is-' + kind : '');
        row.status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }

    function setNotice(text) {
        var node = document.getElementById(GROUP_NOTICE_ID);
        if (!node) return;
        node.textContent = text || '';
        node.style.display = text ? 'block' : 'none';
    }

    function buildRow(layer) {
        var title = tr(layer.title);
        var row = el('div', {
            class: 'albania-layer-row',
            id: 'albaniaRow_' + layer.id,
            'data-albania-row': layer.id
        });
        var head = el('div', { class: 'albania-layer-head' });

        var input = el('input', {
            type: 'checkbox',
            id: 'albaniaToggle_' + layer.id,
            name: layer.group === 'protected' ? 'albaniaProtected' : 'albaniaRaster',
            value: layer.id,
            'data-albania-input': layer.id
        });
        input.checked = !!runtime.active[layer.id];
        input.addEventListener('change', function () {
            if (input.checked) {
                if (runtime.opacity[layer.id] === 0) runtime.opacity[layer.id] =
                    Math.round((typeof layer.opacity === 'number' ? layer.opacity : 1) * 100);
                activate(layer);
            } else {
                deactivate(layer);
            }
            syncUI();
            save();
        });

        var label = el('label', { class: 'albania-layer-label', for: 'albaniaToggle_' + layer.id },
            [input, el('span', { class: 'albania-layer-title', text: title })]);

        var info = el('button', {
            type: 'button',
            class: 'albania-layer-info',
            title: tr(CONFIG.groupInfo).slice(0, 120),
            'aria-label': title,
            'data-albania-info': layer.id,
            text: 'i'
        });
        info.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            showInfo(layer);
        });

        head.appendChild(label);
        head.appendChild(info);
        row.appendChild(head);

        var pct = el('span', { class: 'pct', id: 'albaniaPct_' + layer.id, text: runtime.opacity[layer.id] + '%' });
        row.appendChild(el('div', { class: 'albania-layer-opacity' },
            [el('span', { text: tr(TEXT.opacity) }), pct]));

        var slider = el('input', {
            type: 'range',
            class: 'albania-layer-slider lidar-country-opacity',
            id: 'albaniaOpacity_' + layer.id,
            min: '0', max: '100',
            value: String(runtime.opacity[layer.id]),
            'aria-label': title + ' — ' + tr(TEXT.opacity)
        });
        slider.addEventListener('input', function () { setOpacity(layer, slider.value, true); });
        row.appendChild(slider);

        var status = el('div', {
            class: 'albania-layer-status',
            id: 'albaniaStatus_' + layer.id,
            role: 'status',
            style: 'display:none'
        });
        row.appendChild(status);

        runtime.rows[layer.id] = { row: row, input: input, slider: slider, pct: pct, status: status };
        return row;
    }

    /* The “Protected Sites” caption: one toggle group, collapsible, with the
     * four child checkboxes nested underneath (transparent overlays). */
    function buildProtectedSection(children) {
        var section = el('div', { class: 'albania-protected', id: 'albaniaProtectedSection' });
        var caption = el('button', {
            type: 'button',
            class: 'albania-protected-caption',
            id: 'albaniaProtectedCaption',
            'aria-expanded': runtime.expandedProtected ? 'true' : 'false',
            title: tr(TEXT.expandProtected)
        }, [
            el('span', {
                class: 'albania-protected-icon',
                text: ''
            }),
            el('span', { class: 'albania-layer-section', style: 'margin:0', text: tr(TEXT.protectedSites) })
        ]);
        var icon = el('span', { class: 'albania-protected-chevron', id: 'albaniaProtectedIcon', text: '▾' });
        caption.appendChild(icon);
        caption.addEventListener('click', function () {
            setExpandedProtected(!runtime.expandedProtected);
        });
        section.appendChild(caption);

        var body = el('div', {
            class: 'albania-protected-body',
            id: 'albaniaProtectedBody',
            style: 'display:flex;flex-direction:column;gap:8px;overflow:hidden;' +
                'transition:max-height 0.3s ease, opacity 0.3s ease;max-height:1200px;opacity:1;'
        });
        children.forEach(function (child) { body.appendChild(child); });
        section.appendChild(body);
        runtime.protectedBody = body;
        return section;
    }

    function buildPanel() {
        var container = document.getElementById(SUB_CONTAINER_ID);
        if (!container) return;
        runtime.rows = {};
        runtime.protectedBody = null;
        container.innerHTML = '';

        var rasterRows = LAYERS.filter(function (layer) { return layer.group === 'raster'; });
        var protectedRows = LAYERS.filter(function (layer) { return layer.group === 'protected'; });

        if (rasterRows.length) {
            container.appendChild(el('div', { class: 'albania-layer-section', text: tr(TEXT.raster) }));
            rasterRows.forEach(function (layer) { container.appendChild(buildRow(layer)); });
        }
        if (protectedRows.length) {
            container.appendChild(buildProtectedSection(protectedRows.map(buildRow)));
        }
        setExpandedProtected(runtime.expandedProtected);
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
        var master = document.getElementById(MASTER_ID);
        if (master) master.checked = LAYERS.some(function (layer) { return runtime.active[layer.id]; });
    }

    /* ── info panel ───────────────────────────────────────────────────────── */

    function showInfo(layer) {
        var title = tr(layer.title);
        var attribution = layer.attributionRow || CONFIG.attribution;
        var description = layer.description || tr(CONFIG.groupInfo);
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, attribution, description);
            return;
        }
        window.alert(title + '\n' + attribution + '\n' + description);
    }

    function showGroupInfo() {
        var title = tr(CONFIG.groupLabel);
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, CONFIG.attribution, tr(CONFIG.groupInfo));
            return;
        }
        window.alert(title + '\n' + CONFIG.attribution + '\n' + tr(CONFIG.groupInfo));
    }

    /* ── country filter (the rule the panel already uses) ─────────────────── */

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
        var activeSnapshot = {};
        var expandedSnapshot = runtime.expandedProtected;
        LAYERS.forEach(function (layer) { activeSnapshot[layer.id] = runtime.active[layer.id]; });
        buildPanel();
        runtime.expandedProtected = expandedSnapshot;
        setExpandedProtected(expandedSnapshot);
        LAYERS.forEach(function (layer) { runtime.active[layer.id] = activeSnapshot[layer.id]; });
        var title = document.getElementById('albaniaGroupTitle');
        if (title) title.textContent = tr(CONFIG.groupLabel);
        Object.keys(runtime.rows).forEach(function (id) {
            var notice = runtime.notices[id];
            if (notice) setStatus(id, notice.text, notice.kind);
        });
        filterForCountry(window._detectlabSelectedCountry || '');
        syncUI();
        if (runtime.expanded) setExpanded(true);
    }

    /* ── map wiring ───────────────────────────────────────────────────────── */

    /* A layer that is marked on but no longer on the map (something rebuilt
     * the panes) is put back — cheap, and it never fights a real removal
     * because a switched-off row is not marked active. */
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

    function onViewChange() {
        ensureActiveOnMap();
    }

    function wireMap(map) {
        map.on('moveend zoomend', onViewChange);
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
            } else if (tries > 240) {          /* ~1 minute, then stay dormant */
                window.clearInterval(timer);
                if (window.console) {
                    window.console.warn('[AsigAlbania] no Leaflet map found — the Albanian layers stay dormant.');
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
            /* Restore the session. This is the first moment anything is
             * requested: rows that were off make no call at all. */
            LAYERS.forEach(function (layer) {
                if (runtime.active[layer.id]) activate(layer);
            });
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

    /* ── public API (also the inline handlers in index.html) ──────────────── */

    var API = {
        CONFIG: CONFIG,
        layers: LAYERS,
        state: runtime,
        TEXT: TEXT,
        BLANK_TILE: BLANK_TILE,
        Layer: AsigWmsLayer,
        tileUrl: tileUrl,
        wmsBase: wmsBase,
        layerIds: function () { return LAYERS.map(function (layer) { return layer.id; }); },
        init: start,
        toggleGroup: toggleGroup,
        toggleSubLayers: function () { setExpanded(!runtime.expanded); },
        setExpanded: setExpanded,
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
            if (layer) setOpacity(layer, value, false);
        },
        opacityOf: function (id) { return runtime.opacity[id]; },
        isActive: function (id) { return !!runtime.active[id]; },
        activeIds: function () {
            return LAYERS.filter(function (layer) { return runtime.active[layer.id]; })
                .map(function (layer) { return layer.id; });
        },
        filterForCountry: filterForCountry,
        refreshTexts: refreshTexts,
        goToView: goToView,
        showInfo: showInfo,
        _test: {
            build: build,
            tileUrl: tileUrl,
            setStatus: setStatus,
            tr: tr,
            filterForCountry: filterForCountry,
            syncUI: syncUI,
            TEXT: TEXT
        }
    };

    window.AsigAlbaniaLayers = API;
    /* Inline handlers in index.html — the same style as the other groups. */
    window.toggleAlbaniaLayers = function (on) { API.toggleGroup(!!on); };
    window.toggleAlbaniaSubLayers = function () { API.toggleSubLayers(); };
    window.setAlbaniaLayer = function (id, on) { API.toggle(id, on); };
    window.setAlbaniaOpacity = function (id, value) { API.setOpacity(id, value); };
    window.goToAlbaniaView = function () { API.goToView(); };
    window.showAlbaniaInfo = function () { showGroupInfo(); };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
