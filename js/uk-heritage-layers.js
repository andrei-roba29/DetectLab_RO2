/* United Kingdom heritage overlays (Historic England, RCAHMW, Heneb and Cadw).
 * ArcGIS FeatureServer data is requested only for the current viewport and only
 * while a row is enabled. No Esri Leaflet dependency is required. */
(function (window, document) {
    'use strict';
    if (!window || !document || !window.L) return;

    var ENGLAND = 'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/National_Heritage_List_for_England_NHLE_v02_VIEW/FeatureServer';
    var WALES = 'https://services7.arcgis.com/YFaBqL5jL3y8fq7s/arcgis/rest/services/';
    var SOURCES = [
        { id: 'nhle', label: 'National Heritage List for England', url: ENGLAND, discoverLayers: true, minZoom: 8, colour: '#d9a441', attribution: 'Historic England · NHLE' },
        { id: 'rcahmw', label: 'National Monuments Records of Wales (RCAHMW)', url: WALES + 'National_Monuments_Record_of_Wales/FeatureServer/2', minZoom: 13, colour: '#65b5e8', attribution: 'RCAHMW' },
        { id: 'heneb', label: 'Historic Environment Record of Wales (Heneb)', url: WALES + 'Welsh_Historic_Environment_Records/FeatureServer/0', minZoom: 13, colour: '#9b82d1', attribution: 'Heneb' },
        { id: 'listed', label: 'Listed buildings (Cadw)', url: WALES + 'Listed_Buildings/FeatureServer/0', minZoom: 12, colour: '#e7bd55', attribution: 'Cadw' },
        { id: 'scheduled', label: 'Scheduled Monuments (Cadw)', url: WALES + 'Scheduled_Monuments/FeatureServer/0', minZoom: 9, colour: '#e46d5f', attribution: 'Cadw' },
        { id: 'wrecks', label: 'Designated Wrecks (Cadw)', url: WALES + 'Designated_Wrecks/FeatureServer/0', minZoom: 8, colour: '#39aeb3', attribution: 'Cadw' },
        { id: 'parks', label: 'Registered historical parks & gardens (Cadw)', url: WALES + 'Registered_Parks_and_Gardens/FeatureServer/0', minZoom: 9, colour: '#73b86b', attribution: 'Cadw' }
    ];
    var state = { map: null, active: {}, layers: {}, aborters: {}, timer: null };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function source(id) { return SOURCES.filter(function (s) { return s.id === id; })[0]; }
    function getMap() { return window.map || window._map || null; }
    function style(s) {
        return { color: s.colour, weight: 2, opacity: 0.9, fillColor: s.colour, fillOpacity: 0.2 };
    }
    function popup(feature, s) {
        var p = feature.properties || {};
        var preferred = ['Name', 'NAME', 'name', 'Title', 'TITLE', 'Description', 'Reference', 'ListEntry', 'PRN'];
        var rows = [];
        preferred.forEach(function (key) {
            if (p[key] != null && p[key] !== '' && rows.length < 4) rows.push('<b>' + esc(key) + ':</b> ' + esc(p[key]));
        });
        return '<strong>' + esc(s.label) + '</strong>' + (rows.length ? '<br>' + rows.join('<br>') : '');
    }
    function ensureLayer(s) {
        if (state.layers[s.id]) return state.layers[s.id];
        state.layers[s.id] = window.L.geoJSON(null, {
            pane: 'ukHeritagePane', style: function () { return style(s); },
            pointToLayer: function (f, ll) { return window.L.circleMarker(ll, { pane: 'ukHeritagePane', radius: 5, color: '#fff', weight: 1, fillColor: s.colour, fillOpacity: 0.9 }); },
            onEachFeature: function (f, layer) { layer.bindPopup(popup(f, s)); }
        });
        return state.layers[s.id];
    }
    function status(s, text) {
        var el = document.getElementById('ukHeritageStatus-' + s.id);
        if (el) el.textContent = text || '';
    }
    function load(s) {
        if (!state.map || !state.active[s.id]) return;
        if (state.map.getZoom() < s.minZoom) { ensureLayer(s).clearLayers(); status(s, 'Zoom to ' + s.minZoom + '+'); return; }
        if (state.aborters[s.id]) state.aborters[s.id].abort();
        var controller = window.AbortController ? new AbortController() : null;
        state.aborters[s.id] = controller;
        var b = state.map.getBounds();
        var params = new URLSearchParams({
            f: 'geojson', where: '1=1', outFields: '*', returnGeometry: 'true',
            geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
            geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
            spatialRel: 'esriSpatialRelIntersects', resultRecordCount: '8000'
        });
        status(s, 'Loading…');
        var requestOptions = controller ? { signal: controller.signal } : {};
        /* Historic England supplied the FeatureServer root (not one layer id).
         * Discover its current public sublayers so additions/reordering at the
         * service do not silently disappear from the NHLE toggle. */
        var urlsPromise = s.discoverLayers
            ? (s._layerUrls ? Promise.resolve(s._layerUrls) : fetch(s.url + '?f=json', requestOptions).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }).then(function (meta) {
                if (meta.error) throw new Error(meta.error.message || 'ArcGIS metadata error');
                s._layerUrls = (meta.layers || []).map(function (item) { return s.url + '/' + item.id; });
                if (!s._layerUrls.length) throw new Error('No public NHLE sublayers');
                return s._layerUrls;
            }))
            : Promise.resolve([s.url]);
        urlsPromise.then(function (urls) {
            return Promise.all(urls.map(function (url) {
                return fetch(url + '/query?' + params.toString(), requestOptions).then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                });
            }));
        }).then(function (collections) {
            if (!state.active[s.id]) return;
            var features = [];
            collections.forEach(function (data) {
                if (data.error) throw new Error(data.error.message || 'ArcGIS error');
                features = features.concat(data.features || []);
            });
            var layer = ensureLayer(s); layer.clearLayers(); layer.addData({ type: 'FeatureCollection', features: features });
            status(s, features.length + ' features');
        }).catch(function (err) {
            if (err && err.name === 'AbortError') return;
            status(s, 'Temporarily unavailable');
            if (window.console) console.warn('[UK heritage] ' + s.id, err);
        });
    }
    function refresh() {
        window.clearTimeout(state.timer);
        state.timer = window.setTimeout(function () { SOURCES.forEach(function (s) { if (state.active[s.id]) load(s); }); }, 180);
    }
    function toggle(id, on) {
        var s = source(id); if (!s || !state.map) return;
        state.active[id] = !!on;
        var layer = ensureLayer(s);
        if (on) { layer.addTo(state.map); load(s); } else {
            if (state.aborters[id]) state.aborters[id].abort();
            state.map.removeLayer(layer); layer.clearLayers(); status(s, '');
        }
    }
    function buildPanel() {
        var mount = document.getElementById('ukHeritageSubLayers'); if (!mount) return;
        mount.innerHTML = '';
        var heading = document.createElement('div'); heading.className = 'transp-layer-label';
        heading.innerHTML = '<span style="font-weight:600">United Kingdom · Heritage</span><button type="button" class="layer-info-btn" title="Live national heritage registers">ⓘ</button>';
        heading.querySelector('button').onclick = function () {
            if (window.showLayerInfo) window.showLayerInfo('United Kingdom · Heritage', '© Historic England · © RCAHMW · © Heneb · © Cadw', 'Live ArcGIS FeatureServer records, loaded for the visible map area. England and Wales coverage.');
        };
        mount.appendChild(heading);
        SOURCES.forEach(function (s) {
            var row = document.createElement('div'); row.className = 'transp-layer-row active';
            row.innerHTML = '<div class="transp-layer-label" style="margin-bottom:2px"><span style="display:flex;align-items:center;gap:6px"><i style="width:9px;height:9px;border-radius:50%;background:' + s.colour + '"></i><span>' + esc(s.label) + '</span></span><label class="apm-toggle-switch" title="Toggle ' + esc(s.label) + '"><input type="checkbox"><span class="apm-toggle-track"></span></label></div><div id="ukHeritageStatus-' + s.id + '" style="font-size:.65rem;opacity:.58;min-height:.8em"></div>';
            row.querySelector('input').onchange = function () { toggle(s.id, this.checked); };
            mount.appendChild(row);
        });
    }
    function filter(iso) {
        var row = document.getElementById('ukHeritageRow'); if (!row) return;
        var code = String(iso || '').toUpperCase();
        var visible = !code || code === 'GB' || code === 'GBR' || code === 'UK';
        row.classList.toggle('country-layer-unavailable', !visible);
        row.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }
    function start() {
        buildPanel(); filter(window._detectlabSelectedCountry || '');
        var tries = 0, timer = window.setInterval(function () {
            state.map = getMap();
            if (!state.map && ++tries < 240) return;
            window.clearInterval(timer); if (!state.map) return;
            if (!state.map.getPane('ukHeritagePane')) { state.map.createPane('ukHeritagePane'); state.map.getPane('ukHeritagePane').style.zIndex = 621; }
            state.map.on('moveend zoomend', refresh);
        }, 250);
    }
    document.addEventListener('detectlab:country-selected', function (e) {
        var d = e.detail;
        filter(typeof d === 'string' ? d : d && (d.iso || d.code || d.country));
    });
    document.addEventListener('detectlab:country-cleared', function () { filter(null); });
    window.DetectLabUkHeritage = { sources: SOURCES, toggle: toggle, filterForCountry: filter };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null));
