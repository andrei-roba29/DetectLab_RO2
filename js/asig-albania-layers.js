/*
 * Albania ASIG geoportal catalogue. Everything rendered here comes from
 * js/asig-albania-layers.config.js (sections, exact names, resolve-by-title
 * rules and Heritage parts) into ONE Albania-only panel group
 * (#albaniaRow → #albaniaSubLayers), shown only while Albania (ISO2 AL) is
 * the selected country.
 *
 * Ported from the owner's prototype viewer:
 *  - WMS 1.1.1 / EPSG:3857 / transparent PNG / 512 px (zoomOffset −1),
 *    per-workspace endpoint first, one retry through the global endpoint
 *    (this module keeps its older EPSG:4326 safety net after that);
 *  - Heritage as ONE toggle aggregating many WMS parts (one slider, one
 *    stack position, feature-info across all parts);
 *  - the three tile-only layers read the EPSG:4326 WMTS grid and are
 *    reprojected to Web Mercator on canvas (planTile/WmtsMercator),
 *    stepping down to shallower cached levels instead of going blank;
 *  - layers known only by Title are resolved in the visitor's browser
 *    from the live GetCapabilities (discover/ingest), with a
 *    load-capabilities-file fallback — never by guessing a name;
 *  - map-click GetFeatureInfo across every active WMS layer, grouped by
 *    endpoint, rendered in a sandboxed iframe.
 *
 * Placement is enforced at runtime: buildPanel() sweeps the four
 * pre-group mounts and any Albanian row outside the group before
 * re-rendering, so a stale PWA shell cannot scatter rows again.
 */
(function (window, document) {
    'use strict';

    var CONFIG = window && (window.ASIG_ALBANIA_CONFIG || window.ASIG_ALBANIA_LAYERS);
    var L = window && window.L;
    if (!CONFIG || !Array.isArray(CONFIG.layers) || !Array.isArray(CONFIG.sections) || !L || !document) return;

    var TILE_DEFS = CONFIG.enabledLayers();
    var ENTRIES = CONFIG.panelOrder();
    var HERITAGE_ID = (CONFIG.heritage && CONFIG.heritage.id) || 'heritage';
    var STORE_KEY = 'detectlab_albania_layers_v2';
    var LEGACY_STORE_KEY = 'detectlab_albania_layers_v1';
    var GROUP_ROW_ID = 'albaniaRow';
    var MOUNT_ID = 'albaniaSubLayers';
    var SEARCH_ID = 'albaniaLayerSearch';
    var GROUP_TOGGLE_ID = 'albaniaToggle';
    var EXPAND_BTN_ID = 'albaniaExpandBtn';
    var EXPAND_ICON_ID = 'albaniaExpandIcon';
    var LEGACY_MOUNT_IDS = ['asigHistoricalLayers', 'asigSatelliteLayers', 'asigLidarLayers', 'asigHeritageLayers'];
    var COUNTRY = String(CONFIG.country || 'AL').toUpperCase();
    var OUT_OF_COUNTRY_CLASS = 'albania-out-of-country';
    /* One pane for the whole catalogue so active-layer reordering is a
     * plain zIndex order inside it (the prototype's model). */
    var PANE = 'pane_asig_catalogue';
    var PANE_Z = 615;
    var BLANK_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    var runtime = {
        ready: false, started: false, map: null, panes: false,
        built: {}, active: {}, opacity: {}, rows: {}, sections: {}, notices: {},
        stack: [], collapsed: {}, search: '', searchWired: false, groupStatusEl: null,
        resolvedNames: {}, dynamicDefs: {}, heritagePartIds: [],
        discovery: { state: 'idle', missing: [], ambiguous: [], ambiguousById: {}, discovered: 0, error: '' },
        discoveryPromise: null,
        inCountry: false, suppressed: false, expanded: true, swept: 0, warned: {}
    };

    var STRINGS = {
        en: {
            opacity: 'Opacity', go: 'Tirana', unavailable: 'the source is not answering',
            retrying: 'First endpoint returned no tiles; retrying through the alternate one.',
            lookingUp: 'Looking up the exact ASIG layer name…',
            unresolved: 'Exact name not resolved yet — nothing is requested under a guessed name.',
            ambiguous: 'More than one ASIG layer matches this title; left off until the owner picks one:',
            overzoom: 'This map has no more detail at this zoom; closer views show enlarged tiles.',
            parts: 'parts', partsFailing: 'parts of this layer return no tiles.',
            openFailing: 'Open the failing request ↗',
            search: 'Search ASIG layers…', reload: 'Reload layer list', loadFile: 'Load capabilities file…',
            moveUp: 'Move up (draw on top)', moveDown: 'Move down',
            querying: 'Querying…', noFeatures: 'No features at this location.',
            discovering: 'Looking up the remaining layers on the ASIG geoportal…',
            discoveryFailed: 'Some layers are looked up in the ASIG layer list, which could not be read',
            layersAvailable: 'layers available.', notFound: 'Not found on the service:',
            resolveByTitle: 'Resolve by title:'
        },
        ro: {
            opacity: 'Opacitate', go: 'Tirana', unavailable: 'sursa nu răspunde',
            retrying: 'Primul punct de acces nu a întors dale; se reîncearcă prin cel alternativ.',
            lookingUp: 'Se caută numele exact al stratului ASIG…',
            unresolved: 'Numele exact nu e rezolvat încă — nu se cere nimic sub un nume ghicit.',
            ambiguous: 'Mai multe straturi ASIG au acest titlu; rămâne oprit până alege proprietarul:',
            overzoom: 'Harta nu mai are detalii la acest zoom; mai aproape se văd dale mărite.',
            parts: 'părți', partsFailing: 'părți din acest strat nu întorc dale.',
            openFailing: 'Deschide cererea care eșuează ↗',
            search: 'Caută în straturile ASIG…', reload: 'Reîncarcă lista', loadFile: 'Încarcă fișier capabilities…',
            moveUp: 'Mută sus (desenează deasupra)', moveDown: 'Mută jos',
            querying: 'Se interoghează…', noFeatures: 'Nicio entitate aici.',
            discovering: 'Se caută straturile rămase pe geoportalul ASIG…',
            discoveryFailed: 'Unele straturi se caută în lista ASIG, care nu a putut fi citită',
            layersAvailable: 'straturi disponibile.', notFound: 'Negăsite pe serviciu:',
            resolveByTitle: 'Rezolvat după titlu:'
        }
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
    function slug(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer';
    }
    function norm(s) { return String(s || '').toLowerCase().replace(/[_\s]+/g, ' ').trim(); }

    /* ── definition lookups ─────────────────────────────────────────── */
    function tileDefById(id) {
        return CONFIG.byId(id) || runtime.dynamicDefs[id] || null;
    }
    function entryById(id) {
        for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === id) return ENTRIES[i];
        return null;
    }
    /* Toggle/opacity accept a Heritage part id too (legacy calls): it
     * resolves to the Heritage group, the only switch its parts have. */
    function entryForId(id) {
        var entry = entryById(id);
        if (entry) return entry;
        var def = tileDefById(id);
        if (def && def.heritagePart) return entryById(HERITAGE_ID);
        return null;
    }
    function effectiveName(def) {
        if (!def) return null;
        return def.layers || runtime.resolvedNames[def.id] || null;
    }
    function effectiveDef(def) {
        if (!def) return null;
        var out = {};
        Object.keys(def).forEach(function (k) { out[k] = def[k]; });
        out.layers = effectiveName(def);
        return out;
    }
    function addHeritagePartDef(def) {
        if (!def || !def.id || tileDefById(def.id)) return null;
        runtime.dynamicDefs[def.id] = def;
        if (runtime.heritagePartIds.indexOf(def.id) === -1) runtime.heritagePartIds.push(def.id);
        return def;
    }
    runtime.heritagePartIds = (CONFIG.heritage && CONFIG.heritage.partIds || []).slice();
    ((CONFIG.heritage && CONFIG.heritage.staticDiscovered) || []).forEach(function (part, i) {
        if (!part || !part.layers) return;
        addHeritagePartDef({
            id: part.id || ('arch-' + slug(part.layers)),
            kind: 'wms', panel: false, heritagePart: true, discovered: true,
            section: 'heritage', registryGroup: 'patrimoniu', registryZ: 634,
            title: { ro: part.title || part.layers, en: part.title || part.layers },
            layers: part.layers, url: part.url || '', fallbackUrl: part.fallbackUrl || '',
            format: 'image/png', transparent: true, opacity: CONFIG.heritage.opacity,
            order: 100 + i, minZoom: 7, maxNativeZoom: 19, defaultOn: false,
            attributionRow: CONFIG.attribution,
            description: 'Heritage part (baked in from the owner\u2019s asig-layers.json export): ' + (part.title || part.layers) + '.',
            notes: 'staticDiscovered in js/asig-albania-layers.config.js.'
        });
    });
    function heritagePartDefs() {
        return runtime.heritagePartIds.map(tileDefById).filter(Boolean);
    }
    function entryTileDefs(entry) {
        if (!entry) return [];
        if (entry.kind === 'group') return heritagePartDefs();
        var def = tileDefById(entry.id);
        return def ? [def] : [];
    }
    function isTileRenderable(def) {
        if (!def || !effectiveName(def)) return false;
        if (def.kind === 'wmts') return !!WmtsMercator;
        return true;
    }
    function isEntryRenderable(entry) {
        var defs = entryTileDefs(entry);
        return defs.length > 0 && defs.some(isTileRenderable);
    }
    function renderableTileCount() {
        var count = 0;
        TILE_DEFS.forEach(function (def) { if (effectiveName(def)) count += 1; });
        Object.keys(runtime.dynamicDefs).forEach(function () { count += 1; });
        return count;
    }

    /* ── endpoints & WMS GetMap ─────────────────────────────────────── */
    function serviceRoot() {
        var root = (CONFIG.endpoints && CONFIG.endpoints.serviceRoot) || 'https://geoportal.asig.gov.al/service/';
        return String(root).replace(/\/*$/, '/');
    }
    function cleanEndpoint(url) { return String(url || '').replace(/\/+$/, ''); }
    function globalWmsBase() {
        return cleanEndpoint(window.DETECTLAB_ASIG_WMS || CONFIG.wms.url || (serviceRoot() + 'wms'));
    }
    /* Prototype localDef(): per-workspace endpoint first, global second.
     * An explicit def.url/fallbackUrl (owner export shape) wins. */
    function endpointsFor(name, def) {
        var out = [];
        function push(url) { var c = cleanEndpoint(url); if (c && out.indexOf(c) === -1) out.push(c); }
        if (def && def.url && def.kind !== 'wmts') { push(def.url); push(def.fallbackUrl); }
        if (window.DETECTLAB_ASIG_WMS) push(window.DETECTLAB_ASIG_WMS);
        var ws = String(name || '').split(':')[0];
        if (ws && String(name || '').indexOf(':') !== -1) push(serviceRoot() + encodeURIComponent(ws) + '/wms');
        push(CONFIG.wms.url || (serviceRoot() + 'wms'));
        return out;
    }
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
    /* tileUrl(id, bbox, size, crs[, endpoint]) — bbox in `crs` units
     * ([minx,miny,maxx,maxy]; lon/lat order for EPSG:4326). Tiles that do
     * not touch the ASIG footprint answer the blank pixel; intersecting
     * tiles keep their FULL bbox (the old module clipped the bbox to the
     * footprint, which stretched edge tiles — the prototype does not). */
    function tileUrl(id, bbox, size, crs, endpoint) {
        var def = tileDefById(id);
        if (!def) throw new Error('Unknown ASIG layer: ' + id);
        if (def.kind === 'wmts') throw new Error('ASIG layer ' + id + ' is tile-only (WMTS) — it has no WMS GetMap URL');
        var name = effectiveName(def);
        if (!name) throw new Error('Unresolved ASIG layer (no exact WMS name yet): ' + id +
            (runtime.discovery.ambiguousById[id] ? ' — ambiguous title: ' + runtime.discovery.ambiguousById[id].join(', ') : ''));
        var useCrs = crs || CONFIG.wms.crs;
        var bounds = projectedBounds(useCrs);
        if (!(bbox[2] > bounds[0] && bbox[0] < bounds[2] && bbox[3] > bounds[1] && bbox[1] < bounds[3])) return BLANK_TILE;
        var version = String(CONFIG.wms.getMapVersion || '1.1.1');
        var is13 = version >= '1.3.0';
        var requestBbox = (useCrs === 'EPSG:4326' && is13) ? [bbox[1], bbox[0], bbox[3], bbox[2]] : bbox;
        var base = cleanEndpoint(endpoint || endpointsFor(name, def)[0] || globalWmsBase());
        var params = [
            'SERVICE=WMS',
            'VERSION=' + encodeURIComponent(version),
            'REQUEST=GetMap',
            'LAYERS=' + encodeURIComponent(name),
            'STYLES=',
            (is13 ? 'CRS=' : 'SRS=') + encodeURIComponent(useCrs),
            'BBOX=' + requestBbox.map(function (v) { return round(v, useCrs === 'EPSG:4326' ? 7 : 4); }).join(','),
            'WIDTH=' + (size || CONFIG.wms.getMapTileSize || 512),
            'HEIGHT=' + (size || CONFIG.wms.getMapTileSize || 512),
            'FORMAT=' + encodeURIComponent(def.format || 'image/png'),
            'TRANSPARENT=' + (def.transparent ? 'TRUE' : 'FALSE')
        ];
        return base + (base.indexOf('?') === -1 ? '?' : '&') + params.join('&');
    }

    function warnOnce(layer, detail) {
        if (runtime.warned[layer.id]) return;
        runtime.warned[layer.id] = true;
        if (window.console && window.console.warn) window.console.warn('[ASIG] ' + layer.id + ': ' + detail);
    }

    /* Row status (with an optional failing-request link, as in the
     * prototype's active-layer warnings). */
    function setStatus(id, message, kind, href) {
        if (message) runtime.notices[id] = { text: message, kind: kind, href: href || '' };
        else delete runtime.notices[id];
        var row = runtime.rows[id];
        if (!row || !row.status) return;
        var status = row.status;
        try { status.innerHTML = ''; } catch (e) { /* mock-safe */ }
        status.textContent = message || '';
        status.style.display = message ? 'block' : 'none';
        status.className = 'albania-layer-status' + (kind ? ' is-' + kind : '');
        status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        if (message && href) {
            var a = document.createElement('a');
            a.setAttribute('href', href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener');
            a.textContent = ' ' + words().openFailing;
            status.appendChild(a);
        }
    }
    function noteLayerFailure(layer, stage) {
        var entryId = layer._asigEntryId || (layer._layerDef && layer._layerDef.id);
        if (!entryId) return;
        if (entryId === HERITAGE_ID) { updateHeritageStatus(); return; }
        if (stage === 'retry') setStatus(entryId, words().retrying, 'warn');
        else if (stage === 'overzoom') setStatus(entryId, words().overzoom, 'warn');
        else setStatus(entryId, words().unavailable, 'error', layer._lastBad || '');
    }
    function noteLayerSuccess(layer) {
        var entryId = layer._asigEntryId || (layer._layerDef && layer._layerDef.id);
        if (!entryId) return;
        layer._unavailable = false;
        if (entryId === HERITAGE_ID) { updateHeritageStatus(); return; }
        var notice = runtime.notices[entryId];
        if (notice && (notice.kind === 'error' || notice.text === words().retrying)) setStatus(entryId, '', 'info');
    }
    function updateHeritageStatus() {
        var layers = runtime.built[HERITAGE_ID] || [];
        if (!layers.length) return;
        var bad = layers.filter(function (l) { return l._unavailable && !l._okCount; });
        var retry = layers.some(function (l) { return (l._endpointIndex || 0) > 0 && !l._okCount && !l._unavailable; });
        if (bad.length) {
            setStatus(HERITAGE_ID, bad.length + ' of ' + layers.length + ' ' + words().partsFailing, 'error', bad[bad.length - 1]._lastBad || '');
        } else if (retry) setStatus(HERITAGE_ID, words().retrying, 'warn');
        else if (runtime.notices[HERITAGE_ID]) setStatus(HERITAGE_ID, '', 'info');
    }

    var AsigWmsLayer = L.TileLayer.extend({
        options: {
            crs: CONFIG.wms.crs, tileSize: CONFIG.wms.getMapTileSize || 512, zoomOffset: -1,
            minZoom: 7, maxZoom: 20, keepBuffer: CONFIG.wms.keepBuffer, opacity: 1,
            attribution: CONFIG.attribution, errorTileUrl: BLANK_TILE,
            updateWhenZooming: false, updateWhenIdle: true, noWrap: true, crossOrigin: false
        },
        initialize: function (def, options) {
            this._layerDef = def;
            this._asigEntryId = def.id;
            this._errorCount = 0;
            this._okCount = 0;
            this._warned = false;
            this._unavailable = false;
            this._lastBad = '';
            this._endpointIndex = 0;
            this._endpoints = endpointsFor(def.layers, def);
            this._asigEndpoint = this._endpoints[0] || globalWmsBase();
            L.setOptions(this, options || {});
            this.options.minZoom = def.minZoom;
            this.options.maxNativeZoom = def.maxNativeZoom;
            if (L.latLngBounds) this.options.bounds = L.latLngBounds(CONFIG.countryBounds);
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
            function finish(error) { if (!settled) { settled = true; done(error || null, tile); } }
            tile.alt = '';
            tile.setAttribute('role', 'presentation');
            tile.onload = function () {
                /* HTTP-200 XML/HTML ServiceExceptions fail image decoding
                 * (zero natural size) just like network errors. */
                if (!tile.naturalWidth || !tile.naturalHeight) finish(new Error('ASIG returned a non-image tile'));
                else finish(null);
            };
            tile.onerror = function () { finish(new Error('ASIG tile request failed or returned XML/HTML')); };
            tile.src = this.getTileUrl(coords);
            return tile;
        },
        _onTileLoad: function () { this._okCount += 1; this._errorCount = 0; noteLayerSuccess(this); },
        _onTileError: function (event) {
            var tile = event && event.tile;
            var bad = tile && (tile.src || (tile.dataset && tile.dataset.src) || tile._asigSrc);
            if (bad) this._lastBad = bad;
            this._errorCount += 1;
            if (!this._warned) {
                this._warned = true;
                warnOnce(this._layerDef, 'tile image failed; endpoint/CRS fallbacks will be tried');
            }
            var endpointAfter = CONFIG.wms.endpointFallbackAfterErrors || 2;
            var crsAfter = CONFIG.wms.fallbackAfterErrors || 6;
            if (!this._okCount && this._endpointIndex < this._endpoints.length - 1 && this._errorCount >= endpointAfter) {
                this._endpointIndex += 1;
                this._asigEndpoint = this._endpoints[this._endpointIndex];
                this._errorCount = 0;
                noteLayerFailure(this, 'retry');
                this.redraw();
                return;
            }
            if (this.options.crs === CONFIG.wms.crs && this._errorCount >= crsAfter) {
                this.options.crs = CONFIG.wms.fallbackCrs;
                this._errorCount = 0;
                this.redraw();
                return;
            }
            if (this.options.crs === CONFIG.wms.fallbackCrs && this._errorCount >= crsAfter) {
                this._errorCount = 0;
                this._unavailable = true;
                noteLayerFailure(this, 'unavailable');
            }
        },
        getTileUrl: function (coords) {
            var bounds = this._tileCoordsToBounds(coords);
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast(), size = this.getTileSize();
            var crs = this.options.crs, bbox;
            if (crs === 'EPSG:4326') bbox = [sw.lng, sw.lat, ne.lng, ne.lat];
            else {
                var project = (this._map && this._map.options.crs && this._map.options.crs.project) || L.CRS.EPSG3857.project;
                var a = project(sw), b = project(ne);
                bbox = [a.x, a.y, b.x, b.y];
            }
            return tileUrl(this._layerDef.id, bbox, size.x, crs, this._asigEndpoint);
        }
    });

    /* ── tile-only layers: EPSG:4326 WMTS → Web Mercator canvas ──────
     * planTile + WmtsMercator are the prototype's code, adapted only for
     * config values/mocks. See the config header for why this exists. */
    function wmtsTileUrl(nameOrId, z, col, row) {
        var def = tileDefById(nameOrId);
        var name = def ? effectiveName(def) : String(nameOrId || '');
        var base = cleanEndpoint((CONFIG.wmts && CONFIG.wmts.url) || (serviceRoot() + 'wmts'));
        var set = encodeURIComponent((CONFIG.wmts && CONFIG.wmts.tileMatrixSet) || 'EPSG:4326');
        return base + '?layer=' + encodeURIComponent(name) + '&style=default&tilematrixset=' + set +
            '&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fpng&TileMatrix=' + set + '%3A' + z +
            '&TileCol=' + col + '&TileRow=' + row;
    }
    function planTile(Z, tx, ty, size, maxZ) {
        var z = Math.min(maxZ, Z);
        var n = Math.pow(2, Z);
        var W = 256 * Math.pow(2, z + 1), H = 256 * Math.pow(2, z);
        var pxL = (tx / n) * W, pxR = ((tx + 1) / n) * W;
        function latAt(f) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + f) / n))) * 180 / Math.PI; }
        var rows = [];
        for (var j = 0; j < size; j++) {
            var a = (90 - latAt(j / size)) / 180 * H, b = (90 - latAt((j + 1) / size)) / 180 * H;
            var mid = (a + b) / 2, sh = Math.min(Math.max(b - a, 0.01), 256);
            var r = Math.max(0, Math.min(Math.floor(mid / 256), Math.pow(2, z) - 1));
            rows.push({ r: r, sy: Math.max(0, Math.min(mid - sh / 2 - r * 256, 256 - sh)), sh: sh });
        }
        var cols = [];
        for (var c = Math.floor(pxL / 256); c <= Math.ceil(pxR / 256) - 1; c++) {
            var s0 = Math.max(pxL, c * 256), s1 = Math.min(pxR, (c + 1) * 256);
            cols.push({ c: c, sx: s0 - c * 256, sw: s1 - s0, dx: (s0 - pxL) / (pxR - pxL) * size, dw: (s1 - s0) / (pxR - pxL) * size });
        }
        return { z: z, rows: rows, cols: cols };
    }
    var WmtsMercator = (L.GridLayer && L.GridLayer.extend) ? L.GridLayer.extend({
        initialize: function (options) {
            this._okCount = 0; this._errorCount = 0; this._unavailable = false; this._lastBad = ''; this.overzoomLevel = null;
            L.GridLayer.prototype.initialize.call(this, options || {});
        },
        onAdd: function (map) {
            L.GridLayer.prototype.onAdd.call(this, map);
            this.on('tileload', this._onTileLoad, this);
            this.on('tileerror', this._onTileError, this);
        },
        onRemove: function (map) {
            this.off('tileload', this._onTileLoad, this);
            this.off('tileerror', this._onTileError, this);
            L.GridLayer.prototype.onRemove.call(this, map);
        },
        _onTileLoad: function () { this._okCount += 1; this._errorCount = 0; noteLayerSuccess(this); },
        _onTileError: function (event) {
            var tile = event && event.tile;
            var bad = tile && ((tile.dataset && tile.dataset.src) || tile._asigSrc || tile.src);
            if (bad) this._lastBad = bad;
            this._errorCount += 1;
            if (!this._okCount && this._errorCount >= 3 && !this._unavailable) {
                this._unavailable = true;
                warnOnce(this._layerDef || { id: this._asigTileId || 'wmts' }, 'WMTS source tiles failed at every tried level');
                noteLayerFailure(this, 'unavailable');
            }
        },
        createTile: function (coords, done) {
            var self = this;
            var size = this.getTileSize().x;
            var canvas = document.createElement('canvas');
            canvas.width = canvas.height = size;
            var Img = window.Image || (typeof Image !== 'undefined' ? Image : null);
            if (!Img) { done(new Error('Image is not available'), canvas); return canvas; }
            var st = this._st || (this._st = { ok: {}, deep: {} });
            var lostAfter = (CONFIG.wmts && CONFIG.wmts.lostAfter) || 3;
            var stepDown = (CONFIG.wmts && CONFIG.wmts.stepDownMax) || 10;
            function lost(z) { return (st.deep[z] || 0) >= lostAfter && !st.ok[z]; }
            var lowest = Math.max(0, coords.z - stepDown);
            var start = Math.min(this.options.maxSourceZoom || 21, coords.z);
            while (start > lowest && lost(start)) start--;
            var failed = [];
            function attempt(zTry) {
                var plan = planTile(coords.z, coords.x, coords.y, size, zTry);
                var imgs = {};
                var keys = [];
                plan.rows.forEach(function (row) {
                    plan.cols.forEach(function (col) {
                        var key = col.c + '/' + row.r;
                        if (!(key in imgs)) { imgs[key] = null; keys.push(key); }
                    });
                });
                var pending = keys.length, loaded = 0;
                function finish() {
                    if (!loaded) {
                        if (zTry > lowest) { failed.push(zTry); attempt(zTry - 1); }
                        else done(new Error('no source tiles'), canvas);
                        return;
                    }
                    failed.forEach(function (f) { st.deep[f] = (st.deep[f] || 0) + 1; });
                    if (zTry < coords.z - 1 && (self.overzoomLevel == null || zTry > self.overzoomLevel)) {
                        self.overzoomLevel = zTry;
                        if (self.fire) self.fire('overzoom');
                    }
                    var ctx = canvas.getContext && canvas.getContext('2d');
                    if (ctx) {
                        plan.rows.forEach(function (row, j) {
                            plan.cols.forEach(function (col) {
                                var img = imgs[col.c + '/' + row.r];
                                if (img) ctx.drawImage(img, col.sx, row.sy, col.sw, row.sh, col.dx, j, col.dw, 1);
                            });
                        });
                    }
                    done(null, canvas);
                }
                if (!pending) { finish(); return; }
                keys.forEach(function (key) {
                    var parts = key.split('/').map(Number);
                    var img = new Img();
                    var url = self.options.tileUrl(plan.z, parts[0], parts[1]);
                    if (!canvas._asigSrc) canvas._asigSrc = url;
                    if (canvas.dataset && !canvas.dataset.src) canvas.dataset.src = url;
                    img.onload = function () { st.ok[zTry] = (st.ok[zTry] || 0) + 1; imgs[key] = img; loaded++; if (!--pending) finish(); };
                    img.onerror = function () { self._lastBad = url; if (!--pending) finish(); };
                    img.src = url;
                });
            }
            attempt(start);
            return canvas;
        }
    }) : null;

    /* ── capabilities discovery (prototype discover/ingest) ─────────── */
    function decodeEntities(s) {
        return String(s || '')
            .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
            .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    }
    /* Small Layer/Name/Title/Abstract parser: DOMParser is unavailable in
     * the Node audit/tests, and one code path in both is worth more here
     * than a general XML parser. Only direct Layer children are read, so
     * a Style's Title never overwrites the layer Title. */
    function parseCapabilities(xmlText) {
        var textIn = String(xmlText || '');
        if (!/<\s*(?:\w+:)?Capability[\s>]/.test(textIn) && !/<\s*(?:\w+:)?WMS_Capabilities[\s>]/.test(textIn)) {
            throw new Error('No WMS <Capability> section found in the response.');
        }
        var fields = { Name: 'name', Title: 'title', Abstract: 'abstract' };
        var tagStack = [], layerStack = [], roots = [], currentField = null;
        var tokenRe = /<[^>]+>|[^<]+/g, token;
        function localOf(raw) { return String(raw || '').split(':').pop(); }
        function finishLayer(node) {
            node.name = String(node.name || '').trim();
            node.title = String(node.title || '').trim();
            node.abstract = String(node.abstract || '').trim();
            var parent = layerStack[layerStack.length - 1];
            if (parent) parent.children.push(node); else roots.push(node);
        }
        while ((token = tokenRe.exec(textIn))) {
            var tok = token[0];
            if (tok.charAt(0) !== '<') {
                if (currentField && layerStack.length) layerStack[layerStack.length - 1][currentField] += decodeEntities(tok);
                continue;
            }
            if (tok.indexOf('<?') === 0 || tok.indexOf('<!') === 0) continue;
            var closing = tok.indexOf('</') === 0;
            var selfClosing = /\/>$/.test(tok);
            var inside = tok.replace(/^<\/?/, '').replace(/\/?>$/, '');
            var local = localOf(inside.trim().split(/\s+/)[0]);
            if (closing) {
                if (fields[local] && currentField === fields[local]) currentField = null;
                if (local === 'Layer' && layerStack.length) finishLayer(layerStack.pop());
                var idx = tagStack.lastIndexOf(local);
                if (idx !== -1) tagStack.length = idx;
                continue;
            }
            var parentTag = tagStack[tagStack.length - 1] || '';
            if (local === 'Layer') {
                var qm = inside.match(/queryable\s*=\s*["']([^"']*)["']/i);
                var node = { name: '', title: '', abstract: '', queryable: !!qm && (qm[1] === '1' || qm[1] === 'true'), children: [] };
                if (selfClosing) { layerStack.push(node); finishLayer(layerStack.pop()); continue; }
                layerStack.push(node);
            } else if (fields[local] && parentTag === 'Layer' && layerStack.length && !selfClosing) {
                currentField = fields[local];
            }
            if (!selfClosing) tagStack.push(local);
        }
        if (!roots.length) throw new Error('The capabilities document lists no layers.');
        return roots.length === 1 ? roots[0] : { name: '', title: '', abstract: '', queryable: false, children: roots };
    }
    function flattenNodes(node, out) {
        out = out || [];
        if (!node) return out;
        if (node.name) out.push(node);
        (node.children || []).forEach(function (child) { flattenNodes(child, out); });
        return out;
    }
    function resolveFromNodes(nodes) {
        var assigned = {};
        TILE_DEFS.forEach(function (def) { if (def.layers) assigned[def.layers] = true; });
        Object.keys(runtime.dynamicDefs).forEach(function (id) { assigned[runtime.dynamicDefs[id].layers] = true; });
        Object.keys(runtime.resolvedNames).forEach(function (id) { assigned[runtime.resolvedNames[id]] = true; });
        var missing = [], ambiguous = [], ambiguousById = {}, resolvedNow = 0;
        function dedupe(hits) {
            var seen = {}, out = [];
            hits.forEach(function (n) { if (n.name && !seen[n.name] && !assigned[n.name]) { seen[n.name] = true; out.push(n); } });
            return out;
        }
        TILE_DEFS.forEach(function (def) {
            if (def.layers || !def.resolveTitle || runtime.resolvedNames[def.id]) return;
            var key = norm(def.resolveTitle);
            var hits = dedupe(nodes.filter(function (n) { return norm(n.title) === key; }));
            if (!hits.length) hits = dedupe(nodes.filter(function (n) { return norm(n.name.split(':').pop()) === key; }));
            if (hits.length === 1) {
                runtime.resolvedNames[def.id] = hits[0].name;
                assigned[hits[0].name] = true;
                resolvedNow += 1;
            } else if (hits.length > 1) {
                var names = hits.map(function (n) { return n.name; });
                ambiguous.push({ id: def.id, title: def.resolveTitle, names: names });
                ambiguousById[def.id] = names;
            } else missing.push(def.resolveTitle);
        });
        var keyword = null;
        try { keyword = new RegExp((CONFIG.heritage && CONFIG.heritage.keyword) || 'archaeolog|archeolog|arkeolog', 'i'); } catch (e) { keyword = null; }
        var heritageMatches = [];
        if (keyword) {
            var matches = dedupe(nodes.filter(function (n) { return keyword.test((n.title || '') + ' ' + (n.name || '')); }))
                .sort(function (a, b) { return String(a.title || a.name).localeCompare(String(b.title || b.name)); });
            matches.forEach(function (n, i) {
                var id = 'arch-' + slug(n.name), base = id, suffix = 2;
                while (tileDefById(id)) { id = base + '-' + suffix; suffix += 1; }
                var part = addHeritagePartDef({
                    id: id, kind: 'wms', panel: false, heritagePart: true, discovered: true,
                    section: 'heritage', registryGroup: 'patrimoniu', registryZ: 634,
                    title: { ro: n.title || n.name, en: n.title || n.name },
                    layers: n.name, format: 'image/png', transparent: true,
                    opacity: CONFIG.heritage.opacity, order: 200 + i, minZoom: 7, maxNativeZoom: 19,
                    defaultOn: false, attributionRow: CONFIG.attribution,
                    description: 'Heritage part (found by the archaeology keyword in the live ASIG layer list): ' + (n.title || n.name) + '.',
                    notes: 'Runtime-discovered DCM archaeological zone; bake into CONFIG.heritage.staticDiscovered from asig-layers.json.'
                });
                if (part) { heritageMatches.push(part); assigned[n.name] = true; }
            });
        }
        runtime.discovery.missing = missing;
        runtime.discovery.ambiguous = ambiguous;
        runtime.discovery.ambiguousById = ambiguousById;
        runtime.discovery.discovered = resolvedNow + heritageMatches.length;
        return {
            resolved: Object.assign({}, runtime.resolvedNames),
            missing: missing.slice(), ambiguous: ambiguous.slice(),
            heritageMatches: heritageMatches.slice()
        };
    }
    function refreshResolutionStatuses() {
        var state = runtime.discovery.state;
        ENTRIES.forEach(function (entry) {
            if (entry.kind === 'group') return;
            var def = tileDefById(entry.id);
            if (!def) return;
            if (effectiveName(def)) {
                var notice = runtime.notices[entry.id];
                if (notice && (notice.text === words().lookingUp || notice.text === words().unresolved)) setStatus(entry.id, '', 'info');
                return;
            }
            var amb = runtime.discovery.ambiguousById[entry.id];
            if (amb) setStatus(entry.id, words().ambiguous + ' ' + amb.join(', '), 'warn');
            else if (state === 'loading') setStatus(entry.id, words().lookingUp, 'warn');
            else setStatus(entry.id, words().unresolved, 'warn');
        });
    }
    function setGroupStatus(message, kind) {
        var el = runtime.groupStatusEl;
        if (!el) return;
        el.textContent = message || '';
        el.style.display = message ? 'block' : 'none';
        el.className = 'albania-group-status' + (kind ? ' is-' + kind : '');
    }
    function updateDiscoveryStatus() {
        var d = runtime.discovery, w = words();
        if (d.state === 'loading') setGroupStatus(w.discovering, 'warn');
        else if (d.state === 'done') {
            var bits = [renderableTileCount() + ' ' + w.layersAvailable];
            if (d.missing.length) bits.push(w.notFound + ' ' + d.missing.join(', ') + '.');
            if (d.ambiguous.length) bits.push(w.ambiguous + ' ' + d.ambiguous.map(function (a) { return a.title + ' (' + a.names.join(', ') + ')'; }).join('; '));
            setGroupStatus(bits.join(' '), (d.missing.length || d.ambiguous.length) ? 'error' : 'info');
        } else if (d.state === 'failed') {
            setGroupStatus(renderableTileCount() + ' ' + w.layersAvailable + ' ' + w.discoveryFailed +
                (d.error ? ' (' + d.error + ')' : '') + '. ' + w.loadFile.replace('…', '') + ' / ' + w.reload + '.', 'error');
        }
        refreshResolutionStatuses();
    }
    function afterResolve() {
        /* Newly resolved rows that were remembered "on" can now draw. */
        ENTRIES.forEach(function (entry) {
            if (runtime.active[entry.id] && isEntryRenderable(entry)) activate(entry);
        });
        syncHeritageParts();
        buildPanel();
        syncUI();
        updateDiscoveryStatus();
    }
    function ingestCapabilities(xmlText) {
        var result = resolveFromNodes(flattenNodes(parseCapabilities(xmlText)));
        runtime.discovery.state = 'done';
        runtime.discovery.error = '';
        afterResolve();
        return result;
    }
    function resolveFromCapabilities(xmlText) { return ingestCapabilities(xmlText); }
    function discover(force) {
        if (runtime.discoveryPromise && runtime.discovery.state === 'loading') return runtime.discoveryPromise;
        if (runtime.discovery.state === 'done' && !force) return Promise.resolve(runtime.discovery);
        var enabled = !CONFIG.discovery || CONFIG.discovery.enabled !== false;
        if (!enabled || typeof window.fetch !== 'function') {
            runtime.discovery.state = 'failed';
            runtime.discovery.error = enabled ? 'fetch is not available' : 'discovery disabled in config';
            runtime.discovery.missing = TILE_DEFS.filter(function (d) { return !effectiveName(d); }).map(function (d) { return d.resolveTitle || text(d.title); });
            updateDiscoveryStatus();
            return Promise.resolve(false);
        }
        runtime.discovery.state = 'loading';
        runtime.discovery.error = '';
        updateDiscoveryStatus();
        var url = (CONFIG.discovery && CONFIG.discovery.capabilitiesUrl) ||
            (serviceRoot() + 'wms?service=WMS&version=1.3.0&request=GetCapabilities');
        runtime.discoveryPromise = window.fetch(url).then(function (res) {
            if (res && res.ok === false) throw new Error('HTTP ' + res.status);
            return res.text();
        }).then(function (xml) {
            ingestCapabilities(xml);
            return true;
        }).catch(function (err) {
            runtime.discovery.state = 'failed';
            runtime.discovery.error = String((err && err.message) || err || 'fetch failed');
            runtime.discovery.missing = TILE_DEFS.filter(function (d) { return !effectiveName(d); }).map(function (d) { return d.resolveTitle || text(d.title); });
            runtime.discoveryPromise = null;
            updateDiscoveryStatus();
            return false;
        });
        return runtime.discoveryPromise;
    }
    function readCapabilitiesFile(file) {
        if (!file) return Promise.resolve(false);
        var onText = function (xml) {
            try { ingestCapabilities(xml); return true; }
            catch (err) { setGroupStatus('Could not read that file: ' + ((err && err.message) || err), 'error'); return false; }
        };
        if (typeof file.text === 'function') return file.text().then(onText).catch(function (err) { setGroupStatus('Could not read that file: ' + ((err && err.message) || err), 'error'); return false; });
        if (window.FileReader) {
            return new Promise(function (resolve) {
                var reader = new window.FileReader();
                reader.onload = function () { resolve(onText(String(reader.result || ''))); };
                reader.onerror = function () { resolve(false); };
                reader.readAsText(file);
            });
        }
        return Promise.resolve(false);
    }

    /* ── panel ──────────────────────────────────────────────────────── */
    function el(tag, attrs) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'text') node.textContent = attrs[key];
            else if (key === 'className') node.className = attrs[key];
            else node.setAttribute(key === 'htmlFor' ? 'for' : key, attrs[key]);
        });
        return node;
    }
    function info(def) {
        var eff = effectiveDef(def) || def;
        var description = (def.description || '');
        if (eff.layers && description.indexOf(eff.layers) === -1) description += '\n' + eff.layers;
        if (typeof window.showLayerInfo === 'function') {
            window.showLayerInfo(text(def.title), def.attributionRow || CONFIG.attribution, description);
        } else if (window.alert) window.alert(text(def.title) + '\n' + (def.attributionRow || CONFIG.attribution) + '\n' + description);
    }
    function showHeritageInfo() {
        var parts = heritagePartDefs().map(function (def) { return '• ' + text(def.title) + ' — ' + effectiveName(def); }).join('\n');
        var description = CONFIG.heritage.description + '\n' + parts;
        if (typeof window.showLayerInfo === 'function') window.showLayerInfo(text(CONFIG.heritage.title), CONFIG.attribution, description);
        else if (window.alert) window.alert(text(CONFIG.heritage.title) + '\n' + CONFIG.attribution + '\n' + description);
    }
    function gotoTirana() {
        var map = runtime.map || window._dlMap || window.map;
        if (map && map.setView) map.setView(CONFIG.view.center, CONFIG.view.zoom, { animate: true });
    }
    function createRow(entry) {
        var isGroup = entry.kind === 'group';
        var def = isGroup ? null : tileDefById(entry.id);
        var renderable = isEntryRenderable(entry);
        var row = el('div', { className: 'albania-layer-row' + (renderable ? '' : ' is-unresolved'), id: 'albaniaRow_' + entry.id, 'data-category': 'free', 'data-albania-row': entry.id });
        var head = el('div', { className: 'albania-layer-head' });
        var input = el('input', { type: 'checkbox', id: 'albaniaToggle_' + entry.id, 'aria-label': text(entry.title) });
        input.checked = !!runtime.active[entry.id];
        input.disabled = !renderable;
        input.addEventListener('change', function () { toggle(entry.id, input.checked); });
        var label = el('label', { className: 'albania-layer-label', htmlFor: input.id });
        label.appendChild(input);
        label.appendChild(el('span', { className: 'albania-layer-title', text: text(entry.title) }));
        head.appendChild(label);
        var actions = el('span', { className: 'albania-layer-actions' });
        var moveUp = el('button', { type: 'button', className: 'albania-layer-move', title: words().moveUp, 'aria-label': words().moveUp, text: '↑' });
        moveUp.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); moveInStack(entry.id, 1); });
        actions.appendChild(moveUp);
        var moveDown = el('button', { type: 'button', className: 'albania-layer-move', title: words().moveDown, 'aria-label': words().moveDown, text: '↓' });
        moveDown.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); moveInStack(entry.id, -1); });
        actions.appendChild(moveDown);
        var infoBtn = el('button', { type: 'button', className: 'albania-layer-info', title: 'Layer information', 'aria-label': 'Layer information', text: 'i' });
        infoBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); if (isGroup) showHeritageInfo(); else if (def) info(def); });
        actions.appendChild(infoBtn);
        var go = el('button', { type: 'button', className: 'albania-layer-go', text: words().go, title: 'Centre map on Tirana' });
        go.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); gotoTirana(); });
        actions.appendChild(go);
        head.appendChild(actions);
        row.appendChild(head);

        var metaText = isGroup
            ? (heritagePartDefs().length + ' ' + words().parts)
            : (effectiveName(def) || (words().resolveByTitle + ' ' + (def.resolveTitle || text(def.title))));
        var meta = el('div', { className: 'albania-layer-name', text: metaText });
        row.appendChild(meta);

        var opacityLine = el('div', { className: 'albania-layer-opacity' });
        opacityLine.appendChild(el('span', { text: words().opacity }));
        var stack = el('span', { className: 'albania-layer-stack', text: '' });
        opacityLine.appendChild(stack);
        var pct = el('span', { className: 'pct', id: 'albaniaPct_' + entry.id, text: runtime.opacity[entry.id] + '%' });
        opacityLine.appendChild(pct);
        row.appendChild(opacityLine);
        var slider = el('input', { type: 'range', className: 'albania-layer-slider lidar-country-opacity', id: 'albaniaOpacity_' + entry.id, min: '0', max: '100', value: String(runtime.opacity[entry.id]), 'aria-label': text(entry.title) + ' ' + words().opacity });
        slider.disabled = !renderable;
        slider.addEventListener('input', function () { setOpacity(entry.id, slider.value); });
        row.appendChild(slider);
        var status = el('div', { className: 'albania-layer-status', id: 'albaniaStatus_' + entry.id, role: 'status' });
        status.style.display = 'none';
        row.appendChild(status);
        runtime.rows[entry.id] = { row: row, input: input, slider: slider, pct: pct, status: status, go: go, info: infoBtn, moveUp: moveUp, moveDown: moveDown, meta: meta, stack: stack, entry: entry };
        return row;
    }
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
        if (removed && window.console && window.console.info) {
            window.console.info('[ASIG] removed ' + removed + ' Albanian row(s) mounted outside the Albania group');
        }
        return removed;
    }
    function applySectionCollapsed(sectionId) {
        var rec = runtime.sections[sectionId];
        if (!rec) return;
        var collapsed = !!runtime.collapsed[sectionId];
        if (rec.rows && rec.rows.style) rec.rows.style.display = collapsed ? 'none' : '';
        if (rec.header) rec.header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        if (rec.wrapper && rec.wrapper.classList) rec.wrapper.classList.toggle('is-collapsed', collapsed);
    }
    function toggleSection(sectionId) {
        runtime.collapsed[sectionId] = !runtime.collapsed[sectionId];
        applySectionCollapsed(sectionId);
        save();
    }
    function buildPanel() {
        runtime.rows = {};
        runtime.sections = {};
        runtime.groupStatusEl = null;
        var mount = document.getElementById(MOUNT_ID);
        if (mount) {
            sweepLegacyRows(mount);
            mount.innerHTML = '';
            CONFIG.sections.forEach(function (section) {
                var entries = ENTRIES.filter(function (entry) { return entry.section === section.id; });
                if (!entries.length) return;
                var wrapper = el('div', { className: 'albania-section', 'data-section': section.id });
                var header = el('button', { type: 'button', className: 'albania-layer-section albania-section-toggle', text: text(section.title) + ' (' + entries.length + ')' });
                header.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); toggleSection(section.id); });
                wrapper.appendChild(header);
                var rowsBox = el('div', { className: 'albania-section-rows' });
                entries.forEach(function (entry) { rowsBox.appendChild(createRow(entry)); });
                wrapper.appendChild(rowsBox);
                runtime.sections[section.id] = { wrapper: wrapper, header: header, rows: rowsBox, section: section };
                mount.appendChild(wrapper);
                applySectionCollapsed(section.id);
            });
            var tools = el('div', { className: 'albania-group-tools' });
            var reloadBtn = el('button', { type: 'button', className: 'albania-tool-btn', text: words().reload });
            reloadBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); discover(true); });
            tools.appendChild(reloadBtn);
            var fileInput = el('input', { type: 'file', accept: '.xml,text/xml,application/xml', hidden: '' });
            fileInput.style.display = 'none';
            fileInput.addEventListener('change', function (event) {
                var file = event.target && event.target.files && event.target.files[0];
                readCapabilitiesFile(file);
                try { event.target.value = ''; } catch (e) { /* ignore */ }
            });
            var fileBtn = el('button', { type: 'button', className: 'albania-tool-btn', text: words().loadFile });
            fileBtn.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); if (fileInput.click) fileInput.click(); });
            tools.appendChild(fileBtn);
            tools.appendChild(fileInput);
            var groupStatus = el('div', { className: 'albania-group-status', role: 'status' });
            tools.appendChild(groupStatus);
            runtime.groupStatusEl = groupStatus;
            tools.appendChild(el('div', { className: 'albania-group-attribution', text: CONFIG.attribution }));
            mount.appendChild(tools);
        }
        Object.keys(runtime.rows).forEach(function (id) {
            var notice = runtime.notices[id];
            if (notice) setStatus(id, notice.text, notice.kind, notice.href);
        });
        setExpanded(runtime.expanded);
        applyCountryVisibility(runtime.inCountry);
        applyStackOrder();
        applySearch();
        updateDiscoveryStatus();
    }
    function setExpanded(expanded) {
        runtime.expanded = !!expanded;
        var mount = document.getElementById(MOUNT_ID);
        if (mount && mount.style) {
            mount.style.maxHeight = expanded ? '8000px' : '0px';
            mount.style.opacity = expanded ? '1' : '0';
            mount.style.marginTop = expanded ? '6px' : '0px';
        }
        var button = document.getElementById(EXPAND_BTN_ID);
        if (button) button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        var icon = document.getElementById(EXPAND_ICON_ID);
        if (icon && icon.style) icon.style.transform = expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
    function toggleExpanded() { setExpanded(!runtime.expanded); }

    /* ── search ─────────────────────────────────────────────────────── */
    function entryHaystack(entry) {
        var parts = [text(entry.title), (entry.title && entry.title.en) || '', (entry.title && entry.title.ro) || '', entry.section];
        entryTileDefs(entry).forEach(function (def) {
            parts.push(text(def.title), effectiveName(def) || '', def.resolveTitle || '');
        });
        return norm(parts.join(' '));
    }
    function applySearch() {
        var q = norm(runtime.search);
        var visibleBySection = {};
        ENTRIES.forEach(function (entry) {
            var rec = runtime.rows[entry.id];
            if (!rec || !rec.row) return;
            var visible = !q || entryHaystack(entry).indexOf(q) !== -1;
            rec.row.style.display = visible ? '' : 'none';
            if (rec.row.classList) rec.row.classList.toggle('is-filtered-out', !visible);
            if (visible) visibleBySection[entry.section] = true;
        });
        Object.keys(runtime.sections).forEach(function (sectionId) {
            var rec = runtime.sections[sectionId];
            if (rec.wrapper && rec.wrapper.style) rec.wrapper.style.display = visibleBySection[sectionId] ? '' : 'none';
        });
    }
    function setSearch(value) { runtime.search = String(value || ''); applySearch(); }
    function wireSearch() {
        if (runtime.searchWired) return;
        var input = document.getElementById(SEARCH_ID);
        if (!input || !input.addEventListener) return;
        input.value = runtime.search || '';
        try { input.placeholder = words().search; } catch (e) { /* ignore */ }
        input.addEventListener('input', function (event) { setSearch(event.target && event.target.value); });
        runtime.searchWired = true;
    }

    /* ── stack order / activation ───────────────────────────────────── */
    function layersOf(entryId) { return runtime.built[entryId] || []; }
    function applyStackOrder() {
        runtime.stack.forEach(function (entryId, i) {
            layersOf(entryId).forEach(function (layer) {
                if (layer.setZIndex) { try { layer.setZIndex(10 + i); } catch (e) { /* mock-safe */ } }
            });
        });
    }
    function moveInStack(entryId, delta) {
        var entry = entryForId(entryId);
        if (!entry) return false;
        var i = runtime.stack.indexOf(entry.id), j = i + delta;
        if (i === -1 || j < 0 || j >= runtime.stack.length) return false;
        var tmp = runtime.stack[i]; runtime.stack[i] = runtime.stack[j]; runtime.stack[j] = tmp;
        applyStackOrder(); syncUI(); save();
        return true;
    }
    function ensurePanes(map) {
        if (runtime.panes || !map || !map.createPane) return;
        var pane = map.getPane && map.getPane(PANE);
        if (!pane) pane = map.createPane(PANE);
        if (pane && pane.style) { pane.style.zIndex = String(PANE_Z); pane.style.pointerEvents = 'none'; }
        runtime.panes = true;
    }
    function buildTileLayer(def, entry) {
        var eff = effectiveDef(def);
        var layer;
        if (eff.kind === 'wmts') {
            if (!WmtsMercator) throw new Error('Leaflet GridLayer is not available for WMTS reprojection');
            layer = new WmtsMercator({
                tileUrl: function (z, c, r) { return wmtsTileUrl(eff.layers, z, c, r); },
                maxSourceZoom: (CONFIG.wmts && CONFIG.wmts.maxSourceZoom) || 21,
                bounds: L.latLngBounds ? L.latLngBounds(CONFIG.countryBounds) : undefined,
                attribution: CONFIG.attribution, pane: PANE,
                minZoom: eff.minZoom, maxZoom: 20, tileSize: 256,
                keepBuffer: CONFIG.wms.keepBuffer, opacity: runtime.opacity[entry.id] / 100,
                updateWhenZooming: false, updateWhenIdle: true, noWrap: true
            });
            layer._layerDef = eff;
            layer._asigEndpoint = cleanEndpoint((CONFIG.wmts && CONFIG.wmts.url) || (serviceRoot() + 'wmts'));
        } else {
            layer = new AsigWmsLayer(eff, {
                pane: PANE, opacity: runtime.opacity[entry.id] / 100,
                attribution: CONFIG.attribution, keepBuffer: CONFIG.wms.keepBuffer
            });
        }
        layer._dlDefId = 'albania.' + def.id;
        layer._detectlabProvider = CONFIG.provider;
        layer._detectlabUiTitle = text(def.title);
        layer._detectlabUiKeys = ['albaniaToggle_' + entry.id];
        layer._detectlabNoGuard = true;
        layer._asigEntryId = entry.id;
        layer._asigTileId = def.id;
        layer._asigKind = eff.kind || 'wms';
        layer._asigName = eff.layers;
        layer._asigTitle = text(def.title);
        if (layer.on) layer.on('overzoom', function () { noteLayerFailure(layer, 'overzoom'); });
        return layer;
    }
    function ensureBuilt(entry) {
        if (runtime.built[entry.id]) return runtime.built[entry.id];
        var layers = [];
        entryTileDefs(entry).forEach(function (def) {
            if (!isTileRenderable(def)) return;
            try { layers.push(buildTileLayer(def, entry)); }
            catch (err) { warnOnce(def, String((err && err.message) || err)); }
        });
        runtime.built[entry.id] = layers;
        return layers;
    }
    function syncHeritageParts() {
        var entry = entryById(HERITAGE_ID);
        if (!entry || !runtime.built[HERITAGE_ID]) return;
        var have = {};
        runtime.built[HERITAGE_ID].forEach(function (layer) { have[layer._asigTileId] = true; });
        var added = false;
        heritagePartDefs().forEach(function (def) {
            if (have[def.id] || !isTileRenderable(def)) return;
            try {
                var layer = buildTileLayer(def, entry);
                runtime.built[HERITAGE_ID].push(layer);
                added = true;
                var map = runtime.map || window._dlMap || window.map;
                if (map && runtime.active[HERITAGE_ID] && !runtime.suppressed && !map.hasLayer(layer)) map.addLayer(layer);
            } catch (err) { warnOnce(def, String((err && err.message) || err)); }
        });
        if (added) applyStackOrder();
    }
    function activate(entry) {
        if (!isEntryRenderable(entry)) {
            runtime.active[entry.id] = false;
            refreshResolutionStatuses();
            return;
        }
        runtime.active[entry.id] = true;
        if (runtime.stack.indexOf(entry.id) === -1) runtime.stack.push(entry.id);
        var map = runtime.map || window._dlMap || window.map;
        if (map) {
            ensurePanes(map);
            ensureBuilt(entry).forEach(function (layer) {
                if (layer.setOpacity) layer.setOpacity(runtime.opacity[entry.id] / 100);
                if (!runtime.suppressed && !map.hasLayer(layer)) map.addLayer(layer);
            });
        }
        applyStackOrder();
        if (entry.id === HERITAGE_ID) updateHeritageStatus();
        else if (!runtime.notices[entry.id]) setStatus(entry.id, '', 'info');
    }
    function deactivate(entry) {
        runtime.active[entry.id] = false;
        var i = runtime.stack.indexOf(entry.id);
        if (i !== -1) runtime.stack.splice(i, 1);
        var map = runtime.map || window._dlMap || window.map;
        if (map) layersOf(entry.id).forEach(function (layer) { if (map.hasLayer(layer)) map.removeLayer(layer); });
        applyStackOrder();
        setStatus(entry.id, '', 'info');
    }
    function toggle(id, on) {
        var entry = entryForId(id);
        if (!entry) return;
        if (on) activate(entry); else deactivate(entry);
        syncUI(); save();
    }
    function setOpacity(id, value) {
        var entry = entryForId(id);
        if (!entry) return;
        var opacity = Math.max(0, Math.min(100, Number(value) || 0));
        runtime.opacity[entry.id] = opacity;
        layersOf(entry.id).forEach(function (layer) { if (layer.setOpacity) layer.setOpacity(opacity / 100); });
        if (opacity > 0 && !runtime.active[entry.id]) activate(entry);
        if (opacity === 0 && runtime.active[entry.id]) deactivate(entry);
        syncUI(); save();
    }
    function syncUI() {
        var anyActive = false;
        ENTRIES.forEach(function (entry) {
            var rec = runtime.rows[entry.id];
            var active = !!runtime.active[entry.id];
            if (active) anyActive = true;
            if (!rec) return;
            var renderable = isEntryRenderable(entry);
            rec.input.checked = active;
            rec.input.disabled = !renderable;
            rec.slider.disabled = !renderable;
            if (rec.row.classList) {
                rec.row.classList.toggle('is-active', active);
                rec.row.classList.toggle('is-unresolved', !renderable);
            }
            rec.pct.textContent = runtime.opacity[entry.id] + '%';
            if (String(rec.slider.value) !== String(runtime.opacity[entry.id])) rec.slider.value = String(runtime.opacity[entry.id]);
            if (rec.meta) {
                rec.meta.textContent = entry.kind === 'group'
                    ? (heritagePartDefs().length + ' ' + words().parts)
                    : (function () { var d = tileDefById(entry.id); return (d && effectiveName(d)) || (words().resolveByTitle + ' ' + (d ? (d.resolveTitle || text(d.title)) : '')); }());
            }
            var pos = runtime.stack.indexOf(entry.id);
            if (rec.stack) rec.stack.textContent = active && pos !== -1 ? ((pos + 1) + '/' + runtime.stack.length) : '';
            if (rec.moveUp) rec.moveUp.disabled = !active || pos === -1 || pos >= runtime.stack.length - 1;
            if (rec.moveDown) rec.moveDown.disabled = !active || pos <= 0;
        });
        var master = document.getElementById(GROUP_TOGGLE_ID);
        if (master) master.checked = anyActive;
    }
    function toggleAll(on) {
        ENTRIES.forEach(function (entry) { if (on) activate(entry); else deactivate(entry); });
        syncUI(); save();
    }

    /* ── country gate ───────────────────────────────────────────────── */
    function setMapSuppressed(suppressed) {
        runtime.suppressed = !!suppressed;
        var map = runtime.map || window._dlMap || window.map;
        if (!map) return;
        ENTRIES.forEach(function (entry) {
            layersOf(entry.id).forEach(function (layer) {
                if (runtime.suppressed) { if (map.hasLayer(layer)) map.removeLayer(layer); }
                else if (runtime.active[entry.id] && !map.hasLayer(layer)) map.addLayer(layer);
            });
        });
        applyStackOrder();
    }
    function applyCountryVisibility(visible) {
        runtime.inCountry = !!visible;
        var groupRow = document.getElementById(GROUP_ROW_ID);
        if (groupRow) {
            groupRow.classList.toggle(OUT_OF_COUNTRY_CLASS, !visible);
            groupRow.classList.toggle('country-layer-unavailable', !visible);
            groupRow.setAttribute('aria-hidden', visible ? 'false' : 'true');
        }
        ENTRIES.forEach(function (entry) {
            var row = runtime.rows[entry.id] && runtime.rows[entry.id].row;
            if (!row) return;
            row.classList.toggle('country-layer-unavailable', !visible);
            row.setAttribute('aria-hidden', visible ? 'false' : 'true');
        });
        setMapSuppressed(!visible);
    }
    function filterForCountry(iso) {
        var code = String(iso == null ? (window._detectlabSelectedCountry || '') : iso).toUpperCase();
        applyCountryVisibility(code === COUNTRY);
        return code === COUNTRY;
    }

    /* ── persistence (v2, with v1 migration) ────────────────────────── */
    function defaults() {
        ENTRIES.forEach(function (entry) {
            runtime.active[entry.id] = false;
            runtime.opacity[entry.id] = Math.round((entry.opacity == null ? 1 : entry.opacity) * 100);
        });
        runtime.stack = [];
        runtime.collapsed = {};
    }
    function applyStored(data) {
        ENTRIES.forEach(function (entry) {
            runtime.active[entry.id] = !!(data.active && data.active[entry.id]);
            if (data.opacity && typeof data.opacity[entry.id] === 'number') {
                runtime.opacity[entry.id] = Math.max(0, Math.min(100, data.opacity[entry.id]));
            }
        });
        runtime.stack = (Array.isArray(data.stack) ? data.stack : []).filter(function (id, i, arr) {
            return !!entryById(id) && arr.indexOf(id) === i;
        });
        ENTRIES.forEach(function (entry) {
            if (runtime.active[entry.id] && runtime.stack.indexOf(entry.id) === -1) runtime.stack.push(entry.id);
        });
        runtime.collapsed = (data.collapsed && typeof data.collapsed === 'object') ? data.collapsed : {};
    }
    function load() {
        defaults();
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            if (raw) { applyStored(JSON.parse(raw) || {}); return; }
            var legacyRaw = window.localStorage.getItem(LEGACY_STORE_KEY);
            if (!legacyRaw) return;
            var legacy = JSON.parse(legacyRaw) || {};
            var migrated = { active: {}, opacity: {}, stack: [], collapsed: {} };
            ENTRIES.forEach(function (entry) {
                if (entry.kind === 'group') return;
                if (legacy.active && legacy.active[entry.id]) migrated.active[entry.id] = true;
                if (legacy.opacity && typeof legacy.opacity[entry.id] === 'number') migrated.opacity[entry.id] = legacy.opacity[entry.id];
            });
            /* v1 heritage/natural/cultural/monument rows fold into the one
             * Heritage toggle; v1 topo50k has no v2 entry and is dropped. */
            var folk = ['heritage', 'natural', 'cultural', 'monument'];
            if (folk.some(function (id) { return legacy.active && legacy.active[id]; })) migrated.active[HERITAGE_ID] = true;
            for (var i = 0; i < folk.length; i++) {
                if (legacy.opacity && typeof legacy.opacity[folk[i]] === 'number') { migrated.opacity[HERITAGE_ID] = legacy.opacity[folk[i]]; break; }
            }
            applyStored(migrated);
        } catch (e) { defaults(); }
    }
    function save() {
        try {
            window.localStorage.setItem(STORE_KEY, JSON.stringify({
                active: runtime.active, opacity: runtime.opacity,
                stack: runtime.stack, collapsed: runtime.collapsed
            }));
        } catch (e) { /* Storage may be disabled in private browsing. */ }
    }

    /* ── feature info (prototype behaviour) ─────────────────────────── */
    function featureInfoUrl(endpoint, names, bbox3857, size, point) {
        var list = Array.isArray(names) ? names.join(',') : String(names || '');
        var params = [
            'service=WMS', 'version=1.1.1', 'request=GetFeatureInfo',
            'layers=' + encodeURIComponent(list), 'query_layers=' + encodeURIComponent(list), 'styles=',
            'bbox=' + bbox3857.join(','), 'width=' + Math.round(size.x), 'height=' + Math.round(size.y),
            'srs=' + encodeURIComponent('EPSG:3857'),
            'x=' + Math.round(point.x), 'y=' + Math.round(point.y),
            'info_format=' + encodeURIComponent('text/html'), 'feature_count=10'
        ];
        var base = cleanEndpoint(endpoint);
        return base + (base.indexOf('?') === -1 ? '?' : '&') + params.join('&');
    }
    function collectFeatureInfoLeaves() {
        var map = runtime.map || window._dlMap || window.map;
        var leaves = [];
        runtime.stack.forEach(function (entryId) {
            layersOf(entryId).forEach(function (layer) {
                if (layer._asigKind === 'wmts') return;
                var def = tileDefById(layer._asigTileId);
                if (def && def.queryable === false) return;
                if (map && map.hasLayer && !map.hasLayer(layer)) return;
                leaves.push({
                    url: layer._asigEndpoint || endpointsFor(layer._asigName, def)[0],
                    name: layer._asigName, title: layer._asigTitle || layer._asigName, entryId: entryId
                });
            });
        });
        return leaves;
    }
    function featureInfoGroups() {
        var order = [], byUrl = {};
        collectFeatureInfoLeaves().forEach(function (leaf) {
            if (!byUrl[leaf.url]) { byUrl[leaf.url] = []; order.push(leaf.url); }
            byUrl[leaf.url].push(leaf);
        });
        return order.map(function (url) { return { url: url, leaves: byUrl[url] }; });
    }
    function onMapClick(e) {
        var map = runtime.map || window._dlMap || window.map;
        if (!map || !e || !e.latlng || !L.popup) return;
        try { if (typeof map._draggableMoved === 'function' && map._draggableMoved(map)) return; } catch (err) { /* ignore */ }
        var groups = featureInfoGroups();
        if (!groups.length || !map.getSize || !map.getBounds || !map.latLngToContainerPoint) return;
        var size = map.getSize();
        var pt = map.latLngToContainerPoint(e.latlng);
        var b = map.getBounds();
        var project = (L.CRS && L.CRS.EPSG3857 && L.CRS.EPSG3857.project) ||
            (map.options && map.options.crs && map.options.crs.project);
        if (!project) return;
        var sw = project(b.getSouthWest()), ne = project(b.getNorthEast());
        var bbox = [sw.x, sw.y, ne.x, ne.y];
        var box = el('div', { className: 'asig-fi' });
        var loading = el('div', { className: 'asig-fi-empty', text: words().querying });
        box.appendChild(loading);
        L.popup({ maxWidth: 420, minWidth: 280 }).setLatLng(e.latlng).setContent(box).openOn(map);
        var jobs = groups.map(function (group) {
            var names = group.leaves.map(function (l) { return l.name; });
            var title = group.leaves.map(function (l) { return l.title; }).join(', ');
            var full = featureInfoUrl(group.url, names, bbox, size, pt);
            function frame(attrs) {
                var wrap = el('div', {});
                wrap.appendChild(el('h4', { text: title }));
                var iframe = el('iframe', { sandbox: '' });
                Object.keys(attrs).forEach(function (k) { try { iframe[k] = attrs[k]; } catch (err) { iframe.setAttribute(k, attrs[k]); } });
                wrap.appendChild(iframe);
                return wrap;
            }
            if (typeof window.fetch !== 'function') return Promise.resolve(frame({ src: full }));
            return window.fetch(full).then(function (res) {
                if (res && res.ok === false) throw new Error('HTTP ' + res.status);
                return res.text();
            }).then(function (html) {
                return String(html || '').replace(/<[^>]*>/g, '').trim() ? frame({ srcdoc: html }) : null;
            }).catch(function () { return frame({ src: full }); });
        });
        Promise.all(jobs).then(function (results) {
            var present = results.filter(Boolean);
            try { box.innerHTML = ''; } catch (err) { /* ignore */ }
            box.textContent = '';
            if (!present.length) box.appendChild(el('div', { className: 'asig-fi-empty', text: words().noFeatures }));
            present.forEach(function (node) { box.appendChild(node); });
        }).catch(function () { /* popup keeps the querying note; no console noise */ });
    }
    function wireFeatureInfo(map) {
        if (!map || !map.on || map._asigFiWired) return;
        map._asigFiWired = true;
        map.on('click', onMapClick);
    }

    /* ── lifecycle ──────────────────────────────────────────────────── */
    function showGroupInfo() {
        var title = text(CONFIG.groupLabel);
        var description = text(CONFIG.groupInfo) || '';
        if (typeof window.showLayerInfo === 'function') { window.showLayerInfo(title, CONFIG.attribution, description); return; }
        if (window.alert) window.alert(title + '\n' + CONFIG.attribution + '\n' + description);
    }
    function ready(map) {
        runtime.map = map;
        runtime.ready = true;
        ensurePanes(map);
        wireFeatureInfo(map);
        ENTRIES.forEach(function (entry) { if (runtime.active[entry.id]) activate(entry); });
        syncUI();
    }
    function start() {
        if (runtime.started) return;
        runtime.started = true;
        load();
        buildPanel();
        wireSearch();
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
        /* Resolve the title-only layers + archaeology zones in-browser.
         * Failures only mark those rows; static layers keep working. */
        discover();
    }
    function refreshTexts() { buildPanel(); wireSearch(); syncUI(); }
    function goToView() { gotoTirana(); }
    function showInfo(id) {
        var entry = entryById(id);
        if (entry && entry.kind === 'group') { showHeritageInfo(); return; }
        var def = tileDefById(id);
        if (def) info(def);
    }

    var API = {
        CONFIG: CONFIG, layers: TILE_DEFS, entries: ENTRIES, state: runtime,
        Layer: AsigWmsLayer, WmtsLayer: WmtsMercator, TEXT: STRINGS,
        GROUP_ROW_ID: GROUP_ROW_ID, MOUNT_ID: MOUNT_ID, SEARCH_ID: SEARCH_ID, COUNTRY: COUNTRY,
        LEGACY_MOUNT_IDS: LEGACY_MOUNT_IDS, sweepLegacyRows: sweepLegacyRows,
        tileUrl: tileUrl, wmtsTileUrl: wmtsTileUrl, planTile: planTile, endpointsFor: endpointsFor,
        discover: discover, ingestCapabilities: ingestCapabilities,
        resolveFromCapabilities: resolveFromCapabilities, parseCapabilities: parseCapabilities,
        featureInfoUrl: featureInfoUrl, collectFeatureInfoLeaves: collectFeatureInfoLeaves,
        featureInfoGroups: featureInfoGroups,
        moveInStack: moveInStack, stackOrder: function () { return runtime.stack.slice(); },
        setSearch: setSearch, counts: function () { return CONFIG.countsBySection(); },
        panelEntries: function () { return ENTRIES.slice(); },
        heritageParts: function () { return heritagePartDefs().map(effectiveDef); },
        init: start, toggle: toggle, setOpacity: setOpacity,
        isActive: function (id) { var e = entryForId(id); return !!(e && runtime.active[e.id]); },
        filterForCountry: filterForCountry, refreshTexts: refreshTexts,
        goToView: goToView, showInfo: showInfo, setStatus: setStatus,
        showGroupInfo: showGroupInfo, showHeritageInfo: showHeritageInfo, toggleAll: toggleAll,
        toggleExpanded: toggleExpanded, setExpanded: setExpanded, toggleSection: toggleSection,
        isInCountry: function () { return !!runtime.inCountry; },
        layerIds: function () { return TILE_DEFS.map(function (d) { return d.id; }); },
        panelIds: function () { return ENTRIES.map(function (e) { return e.id; }); }
    };
    window.AsigAlbaniaLayers = API;
    window.setAlbaniaLayer = toggle;
    window.setAlbaniaOpacity = setOpacity;
    window.goToAlbaniaView = goToView;
    window.showAlbaniaInfo = showGroupInfo;
    window.toggleAlbaniaLayers = toggleAll;
    window.toggleAlbaniaSubLayers = toggleExpanded;
    document.addEventListener('detectlab:langchange', refreshTexts);
    document.addEventListener('detectlab:country-selected', function (event) {
        var iso = (event && event.detail && event.detail.iso) || window._detectlabSelectedCountry || '';
        filterForCountry(iso);
    });
    document.addEventListener('detectlab:country-cleared', function () { filterForCountry(null); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
