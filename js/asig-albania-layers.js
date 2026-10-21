/*
 * Albania ASIG WMS layers. Every row and Leaflet layer is rendered from
 * js/asig-albania-layers.config.js into ONE Albania-only panel group
 * (#albaniaRow → #albaniaSubLayers). The rows are not mounted inside the
 * Romanian/Denmark/Finland sections any more: the group — and every row in
 * it — is hidden unless Albania (ISO2 AL) is the selected country, and the
 * tile layers are taken off the map while another country (or the global
 * view) is active.
 *
 * Placement is enforced at runtime: buildPanel() removes the four pre-group
 * mounts and any Albanian row that is still outside the group before it
 * renders the nine rows again (sweepLegacyRows), so a stale installed shell
 * cannot leave Albanian layers scattered under another country's section.
 */
(function (window, document) {
    'use strict';

    var CONFIG = window.ASIG_ALBANIA_CONFIG || window.ASIG_ALBANIA_LAYERS;
    var L = window.L;
    if (!CONFIG || !Array.isArray(CONFIG.layers) || !L || !document) return;

    var LAYERS = CONFIG.enabledLayers();
    var STORE_KEY = 'detectlab_albania_layers_v1';
    var GROUP_ROW_ID = 'albaniaRow';
    var MOUNT_ID = 'albaniaSubLayers';
    var GROUP_TOGGLE_ID = 'albaniaToggle';
    var EXPAND_BTN_ID = 'albaniaExpandBtn';
    var EXPAND_ICON_ID = 'albaniaExpandIcon';
    /* Mounts used before the single Albania group existed: the 1:50k map in
     * the free Historical Maps section (#asigHistoricalLayers), the two
     * orthophotos between Romania's satellite periods (#asigSatelliteLayers),
     * the two hillshades in the LiDAR group that hosts Denmark's DHM
     * (#asigLidarLayers) and the four protected-site rows under Romania's
     * Heritage Sites (#asigHeritageLayers). A stale app shell (an installed
     * PWA still running an older index.html) can carry them; they are removed
     * so no Albanian row can ever sit inside another country's section. */
    var LEGACY_MOUNT_IDS = ['asigHistoricalLayers', 'asigSatelliteLayers', 'asigLidarLayers', 'asigHeritageLayers'];
    var COUNTRY = String(CONFIG.country || 'AL').toUpperCase();
    /* The row is hidden for every other country — including "no country" —
     * with a plain class that does not depend on the panel's filter state
     * (the HTML ships the class, so nothing flashes before this module runs). */
    var OUT_OF_COUNTRY_CLASS = 'albania-out-of-country';
    var PANE_BY_SECTION = {
        historical: ['pane_asig_historical', 405],
        satellite: ['pane_satellite', 398],
        lidar: ['pane_lidar', 610],
        heritage: ['pane_patrimoniu', 620]
    };
    var BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    var runtime = {
        ready: false, map: null, panes: false, built: {}, active: {}, opacity: {}, rows: {}, notices: {},
        /* Country gating: `inCountry` mirrors the last filter call, `suppressed`
         * says the tile layers are currently off the map because of it,
         * `expanded` is the accordion state of the group and `swept` is the
         * number of stray Albanian rows the placement sweep removed. */
        inCountry: false, suppressed: false, expanded: true, swept: 0
    };
    var STRINGS = {
        en: { opacity: 'Opacity', go: 'Tirana', unavailable: 'the source is not answering' },
        ro: { opacity: 'Opacitate', go: 'Tirana', unavailable: 'sursa nu răspunde' }
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
    function wmsBase() { return String(window.DETECTLAB_ASIG_WMS || CONFIG.wms.url).replace(/\/+$/, ''); }
    function round(value, places) {
        var factor = Math.pow(10, places);
        return Math.round(value * factor) / factor;
    }

    /* The config bounds are Leaflet [[south,west],[north,east]]. Clamp the
     * actual WMS bbox, not just the tile grid, to the published footprint. */
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
    function tileUrl(id, bbox, size, crs) {
        var def = CONFIG.byId(id);
        if (!def) throw new Error('Unknown ASIG layer: ' + id);
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
            'LAYERS=' + encodeURIComponent(def.layers),
            'STYLES=',
            'CRS=' + encodeURIComponent(useCrs),
            'BBOX=' + requestBbox.map(function (v) { return round(v, useCrs === 'EPSG:4326' ? 7 : 4); }).join(','),
            'WIDTH=' + (size || CONFIG.wms.tileSize),
            'HEIGHT=' + (size || CONFIG.wms.tileSize),
            'FORMAT=' + encodeURIComponent(def.format),
            'TRANSPARENT=' + (def.transparent ? 'TRUE' : 'FALSE')
        ];
        return wmsBase() + '?' + params.join('&');
    }

    function warnOnce(layer, detail) {
        if (runtime.warned && runtime.warned[layer.id]) return;
        runtime.warned = runtime.warned || {};
        runtime.warned[layer.id] = true;
        if (window.console && window.console.warn) window.console.warn('[ASIG] ' + layer.id + ': ' + detail);
    }

    var AsigWmsLayer = L.TileLayer.extend({
        options: {
            crs: CONFIG.wms.crs, tileSize: CONFIG.wms.tileSize, minZoom: 7, maxZoom: 20,
            keepBuffer: CONFIG.wms.keepBuffer, opacity: 1, attribution: CONFIG.attribution,
            errorTileUrl: BLANK_TILE, updateWhenZooming: false, updateWhenIdle: true,
            noWrap: true, crossOrigin: false
        },
        initialize: function (def, options) {
            this._layerDef = def;
            this._errorCount = 0;
            this._warned = false;
            L.setOptions(this, options || {});
            this.options.minZoom = def.minZoom;
            this.options.maxNativeZoom = def.maxNativeZoom;
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
            tile.setAttribute('role', 'presentation');
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
        _onTileLoad: function () { this._errorCount = 0; },
        _onTileError: function () {
            var def = this._layerDef;
            this._errorCount += 1;
            if (!this._warned) {
                this._warned = true;
                warnOnce(def, 'tile image failed; retrying with EPSG:4326 after the error burst');
            }
            if (this.options.crs === CONFIG.wms.crs && this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                this.options.crs = CONFIG.wms.fallbackCrs;
                this._errorCount = 0;
                this.redraw();
                return;
            }
            if (this.options.crs === CONFIG.wms.fallbackCrs && this._errorCount >= CONFIG.wms.fallbackAfterErrors) {
                this._errorCount = 0;
                setStatus(def.id, words().unavailable, 'error');
            }
        },
        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast(), size = this.getTileSize();
            var crs = this.options.crs;
            var bbox;
            if (crs === 'EPSG:4326') bbox = [sw.lng, sw.lat, ne.lng, ne.lat];
            else {
                var project = (this._map && this._map.options.crs && this._map.options.crs.project) || L.CRS.EPSG3857.project;
                var a = project(sw), b = project(ne);
                bbox = [a.x, a.y, b.x, b.y];
            }
            return tileUrl(this._layerDef.id, bbox, size.x, crs);
        }
    });

    function el(tag, attrs) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'text') node.textContent = attrs[key];
            else if (key === 'className') node.className = attrs[key];
            else node.setAttribute(key === 'htmlFor' ? 'for' : key, attrs[key]);
        });
        return node;
    }
    function setStatus(id, message, kind) {
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        row.status.textContent = message || '';
        row.status.style.display = message ? 'block' : 'none';
        row.status.className = 'albania-layer-status' + (kind ? ' is-' + kind : '');
        row.status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        if (message) runtime.notices[id] = { text: message, kind: kind };
        else delete runtime.notices[id];
    }
    function info(def) {
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(text(def.title), def.attributionRow || CONFIG.attribution, def.description || '');
        } else if (window.alert) window.alert(text(def.title) + '\n' + (def.attributionRow || CONFIG.attribution) + '\n' + (def.description || ''));
    }
    function gotoTirana() {
        var map = runtime.map || window._dlMap || window.map;
        if (map && map.setView) map.setView(CONFIG.view.center, CONFIG.view.zoom, { animate: true });
    }
    function createRow(def) {
        var row = el('div', { className: 'albania-layer-row', id: 'albaniaRow_' + def.id, 'data-category': 'free', 'data-albania-row': def.id });
        var head = el('div', { className: 'albania-layer-head' });
        var input = el('input', { type: 'checkbox', id: 'albaniaToggle_' + def.id, 'aria-label': text(def.title) });
        input.checked = !!runtime.active[def.id];
        input.addEventListener('change', function () { toggle(def.id, input.checked); });
        var label = el('label', { className: 'albania-layer-label', htmlFor: input.id });
        label.appendChild(input);
        label.appendChild(el('span', { className: 'albania-layer-title', text: text(def.title) }));
        head.appendChild(label);
        var actions = el('span', { className: 'albania-layer-actions' });
        var infoBtn = el('button', { type: 'button', className: 'albania-layer-info', title: 'Layer information', 'aria-label': 'Layer information', text: 'i' });
        infoBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); info(def); });
        actions.appendChild(infoBtn);
        var go = el('button', { type: 'button', className: 'albania-layer-go', text: words().go, title: 'Centre map on Tirana' });
        go.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); gotoTirana(); });
        actions.appendChild(go);
        head.appendChild(actions);
        row.appendChild(head);

        var opacityLine = el('div', { className: 'albania-layer-opacity' });
        opacityLine.appendChild(el('span', { text: words().opacity }));
        var pct = el('span', { className: 'pct', id: 'albaniaPct_' + def.id, text: runtime.opacity[def.id] + '%' });
        opacityLine.appendChild(pct);
        row.appendChild(opacityLine);
        var slider = el('input', { type: 'range', className: 'albania-layer-slider lidar-country-opacity', id: 'albaniaOpacity_' + def.id, min: '0', max: '100', value: String(runtime.opacity[def.id]), 'aria-label': text(def.title) + ' ' + words().opacity });
        slider.addEventListener('input', function () { setOpacity(def.id, slider.value); });
        row.appendChild(slider);
        var status = el('div', { className: 'albania-layer-status', id: 'albaniaStatus_' + def.id, role: 'status' });
        status.style.display = 'none';
        row.appendChild(status);
        runtime.rows[def.id] = { row: row, input: input, slider: slider, pct: pct, status: status, go: go };
        return row;
    }
    /* ── placement sweep ────────────────────────────────────────────────────
     * Every Albanian row must live inside #albaniaSubLayers: that is the one
     * container the country gate hides, so a row mounted anywhere else would
     * stay visible for Romania, Denmark and every other country — exactly the
     * scattered layout this module replaced. The current markup ships the
     * rows in the group, but an installed PWA can keep running an older shell
     * whose mounts above are still present. They are removed (the nine rows
     * are re-created from CONFIG right after), together with any Albanian row
     * that somehow ended up outside the group. Returns the number of stale
     * nodes removed. */
    function sweepLegacyRows(mount) {
        var removed = 0;
        LEGACY_MOUNT_IDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (!node || node === mount) return;
            if (node.parentNode && node.parentNode.removeChild) node.parentNode.removeChild(node);
            else if (node.innerHTML !== undefined) node.innerHTML = '';
            removed += 1;
        });
        if (mount && typeof document.querySelectorAll === 'function') {
            var strays = document.querySelectorAll('[data-albania-row]');
            Array.prototype.forEach.call(strays, function (row) {
                if (row === mount) return;
                if (typeof mount.contains === 'function' && mount.contains(row)) return;
                if (row.parentNode && row.parentNode.removeChild) row.parentNode.removeChild(row);
                removed += 1;
            });
        }
        runtime.swept = removed;
        /* Informational, not a layer failure: it must not inflate the
         * one-warning-per-layer console contract. */
        if (removed && window.console && window.console.info) {
            window.console.info('[ASIG] removed ' + removed + ' Albanian row(s) mounted outside the Albania group');
        }
        return removed;
    }
    /* The nine rows live in ONE container inside the Albania group row, in
     * draw order, with a small caption whenever the theme changes. */
    function buildPanel() {
        runtime.rows = {};
        var mount = document.getElementById(MOUNT_ID);
        if (mount) {
            sweepLegacyRows(mount);
            mount.innerHTML = '';
            var lastSection = null;
            CONFIG.drawOrder().forEach(function (def) {
                if (def.section !== lastSection) {
                    lastSection = def.section;
                    var label = CONFIG.sectionLabels && CONFIG.sectionLabels[def.section];
                    if (label) mount.appendChild(el('div', { className: 'albania-layer-section', text: text(label) }));
                }
                mount.appendChild(createRow(def));
            });
        }
        Object.keys(runtime.rows).forEach(function (id) {
            if (runtime.notices[id]) setStatus(id, runtime.notices[id].text, runtime.notices[id].kind);
        });
        setExpanded(runtime.expanded);
        /* Rebuilding the DOM must not undo the country gate. */
        applyCountryVisibility(runtime.inCountry);
    }
    function setExpanded(expanded) {
        runtime.expanded = !!expanded;
        var mount = document.getElementById(MOUNT_ID);
        if (mount && mount.style) {
            mount.style.maxHeight = expanded ? '4000px' : '0px';
            mount.style.opacity = expanded ? '1' : '0';
            mount.style.marginTop = expanded ? '6px' : '0px';
        }
        var button = document.getElementById(EXPAND_BTN_ID);
        if (button) button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        var icon = document.getElementById(EXPAND_ICON_ID);
        if (icon && icon.style) icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
    function toggleExpanded() { setExpanded(!runtime.expanded); }

    /* ── country gate ────────────────────────────────────────────────────────
     * Albania owns these rows. `applyCountryVisibility(false)` hides the group
     * row and every child row and parks the tile layers (the user's on/off
     * choice is remembered in runtime.active), so nothing is requested while
     * another country — or no country at all — is selected. */
    function setMapSuppressed(suppressed) {
        runtime.suppressed = !!suppressed;
        var map = runtime.map || window._dlMap || window.map;
        if (!map) return;
        LAYERS.forEach(function (def) {
            var layer = runtime.built[def.id];
            if (!layer) return;
            if (runtime.suppressed) {
                if (map.hasLayer(layer)) map.removeLayer(layer);
            } else if (runtime.active[def.id] && !map.hasLayer(layer)) {
                map.addLayer(layer);
            }
        });
    }
    function applyCountryVisibility(visible) {
        runtime.inCountry = !!visible;
        var groupRow = document.getElementById(GROUP_ROW_ID);
        if (groupRow) {
            groupRow.classList.toggle(OUT_OF_COUNTRY_CLASS, !visible);
            groupRow.classList.toggle('country-layer-unavailable', !visible);
            groupRow.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        LAYERS.forEach(function (def) {
            var row = runtime.rows[def.id] && runtime.rows[def.id].row;
            if (!row) return;
            row.classList.toggle('country-layer-unavailable', !visible);
            row.setAttribute('aria-hidden', visible ? 'false' : 'true');
        });
        setMapSuppressed(!visible);
    }
    /* The same signature the other country groups expose. Albania is strictly
     * its own country: no ISO (the global view) hides the rows too. */
    function filterForCountry(iso) {
        var code = String(iso == null ? (window._detectlabSelectedCountry || '') : iso).toUpperCase();
        applyCountryVisibility(code === COUNTRY);
        return code === COUNTRY;
    }
    function save() {
        try { window.localStorage.setItem(STORE_KEY, JSON.stringify({ active: runtime.active, opacity: runtime.opacity })); }
        catch (e) { /* Storage may be disabled in private browsing. */ }
    }
    function load() {
        try {
            var data = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
            LAYERS.forEach(function (def) {
                runtime.active[def.id] = !!(data.active && data.active[def.id]);
                runtime.opacity[def.id] = data.opacity && typeof data.opacity[def.id] === 'number'
                    ? Math.max(0, Math.min(100, data.opacity[def.id])) : Math.round(def.opacity * 100);
            });
        } catch (e) {
            LAYERS.forEach(function (def) { runtime.active[def.id] = false; runtime.opacity[def.id] = Math.round(def.opacity * 100); });
        }
    }
    function ensurePanes(map) {
        if (runtime.panes || !map || !map.createPane) return;
        var created = {};
        LAYERS.forEach(function (def) {
            var paneDef = PANE_BY_SECTION[def.section];
            if (!paneDef || created[paneDef[0]]) return;
            var pane = map.getPane && map.getPane(paneDef[0]);
            if (!pane) pane = map.createPane(paneDef[0]);
            if (pane && pane.style) pane.style.zIndex = String(paneDef[1]);
            if (pane && pane.style && paneDef[0] !== 'pane_asig_historical') pane.style.pointerEvents = 'none';
            created[paneDef[0]] = true;
        });
        runtime.panes = true;
    }
    function buildLayer(def) {
        var pane = PANE_BY_SECTION[def.section][0];
        var layer = new AsigWmsLayer(def, {
            pane: pane,
            opacity: runtime.opacity[def.id] / 100,
            attribution: CONFIG.attribution,
            keepBuffer: CONFIG.wms.keepBuffer
        });
        layer._dlDefId = 'albania.' + def.id;
        layer._detectlabProvider = CONFIG.provider;
        layer._detectlabUiTitle = text(def.title);
        layer._detectlabUiKeys = ['albaniaToggle_' + def.id];
        layer._detectlabNoGuard = true;
        return layer;
    }
    function activate(def) {
        var map = runtime.map || window._dlMap || window.map;
        runtime.active[def.id] = true;
        if (!map) return;
        ensurePanes(map);
        if (!runtime.built[def.id]) runtime.built[def.id] = buildLayer(def);
        var layer = runtime.built[def.id];
        if (layer.setOpacity) layer.setOpacity(runtime.opacity[def.id] / 100);
        /* The country gate owns the map membership while another country (or
         * the global view) is selected: remember the choice, draw nothing. */
        if (!runtime.suppressed && !map.hasLayer(layer)) map.addLayer(layer);
        setStatus(def.id, '', 'info');
    }
    function deactivate(def) {
        runtime.active[def.id] = false;
        var map = runtime.map || window._dlMap || window.map;
        var layer = runtime.built[def.id];
        if (map && layer && map.hasLayer(layer)) map.removeLayer(layer);
        setStatus(def.id, '', 'info');
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
        if (runtime.built[id] && runtime.built[id].setOpacity) runtime.built[id].setOpacity(opacity / 100);
        if (opacity > 0 && !runtime.active[id]) activate(def);
        if (opacity === 0 && runtime.active[id]) deactivate(def);
        syncUI();
        save();
    }
    function syncUI() {
        var anyActive = false;
        LAYERS.forEach(function (def) {
            var row = runtime.rows[def.id];
            if (runtime.active[def.id]) anyActive = true;
            if (!row) return;
            row.input.checked = !!runtime.active[def.id];
            row.row.classList.toggle('is-active', !!runtime.active[def.id]);
            row.pct.textContent = runtime.opacity[def.id] + '%';
            if (String(row.slider.value) !== String(runtime.opacity[def.id])) row.slider.value = String(runtime.opacity[def.id]);
        });
        var master = document.getElementById(GROUP_TOGGLE_ID);
        if (master) master.checked = anyActive;
    }
    /* Group master switch: one click turns the whole Albanian stack on/off. */
    function toggleAll(on) {
        LAYERS.forEach(function (def) { if (on) activate(def); else deactivate(def); });
        syncUI();
        save();
    }
    function showGroupInfo() {
        var title = text(CONFIG.groupLabel);
        var description = text(CONFIG.groupInfo) || '';
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(title, CONFIG.attribution, description);
            return;
        }
        if (window.alert) window.alert(title + '\n' + CONFIG.attribution + '\n' + description);
    }
    function start() {
        if (runtime.started) return;
        runtime.started = true;
        load();
        buildPanel();
        /* Nothing Albanian is shown before Albania is the selected country. */
        filterForCountry(window._detectlabSelectedCountry || '');
        var map = window._dlMap || window.map;
        if (map) ready(map);
        else {
            var attempts = 0;
            var timer = window.setInterval(function () {
                var found = window._dlMap || window.map;
                if (found) { window.clearInterval(timer); ready(found); }
                else if (++attempts > 240) window.clearInterval(timer);
            }, 250);
        }
    }
    function ready(map) {
        runtime.map = map;
        runtime.ready = true;
        ensurePanes(map);
        LAYERS.forEach(function (def) { if (runtime.active[def.id]) activate(def); });
        syncUI();
    }
    function refreshTexts() {
        /* The group title is a static .t[data-key] node (js/translations.js has
         * albania_group_title in every language) — only the generated rows are
         * rebuilt, and the country gate is re-applied by buildPanel(). */
        buildPanel();
        syncUI();
    }
    function goToView() { gotoTirana(); }
    function showInfo(id) { var def = CONFIG.byId(id); if (def) info(def); }

    var API = {
        CONFIG: CONFIG, layers: LAYERS, state: runtime, Layer: AsigWmsLayer, TEXT: STRINGS,
        GROUP_ROW_ID: GROUP_ROW_ID, MOUNT_ID: MOUNT_ID, COUNTRY: COUNTRY,
        LEGACY_MOUNT_IDS: LEGACY_MOUNT_IDS, sweepLegacyRows: sweepLegacyRows,
        tileUrl: tileUrl, init: start, toggle: toggle, setOpacity: setOpacity,
        isActive: function (id) { return !!runtime.active[id]; },
        filterForCountry: filterForCountry, refreshTexts: refreshTexts,
        goToView: goToView, showInfo: showInfo, setStatus: setStatus,
        showGroupInfo: showGroupInfo, toggleAll: toggleAll,
        toggleExpanded: toggleExpanded, setExpanded: setExpanded,
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
    document.addEventListener('detectlab:langchange', refreshTexts);
    /* The country gate follows every selection / exit, including restores. */
    document.addEventListener('detectlab:country-selected', function (event) {
        var iso = (event && event.detail && event.detail.iso) || window._detectlabSelectedCountry || '';
        filterForCountry(iso);
    });
    document.addEventListener('detectlab:country-cleared', function () { filterForCountry(null); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
