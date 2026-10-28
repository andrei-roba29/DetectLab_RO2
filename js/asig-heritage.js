/* Viewport-only heritage representatives. No national GeoJSON download or
 * per-source raster stacks. Grid clusters use screen pixels at the current zoom.
 * Counts describe the bounded viewport sample, never nationwide totals. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory;
    else root.AsigHeritageLayer = factory(root.L, root);
}(typeof window !== 'undefined' ? window : this, function (L, root) {
    'use strict';
    return L.Layer.extend({
        initialize: function (options) {
            this.options = options || {};
            this._generation = 0;
            this._opacity = this.options.opacity == null ? 1 : this.options.opacity;
        },
        onAdd: function (map) {
            this._map = map;
            this._group = L.layerGroup().addTo(map);
            map.on('movestart zoomstart', this._cancel, this);
            map.on('moveend zoomend', this._schedule, this);
            this._schedule();
        },
        onRemove: function (map) {
            this._cancel();
            map.off('movestart zoomstart', this._cancel, this);
            map.off('moveend zoomend', this._schedule, this);
            if (this._group) { this._group.clearLayers(); map.removeLayer(this._group); }
            if (this._fallback) map.removeLayer(this._fallback);
            this._fallback = null;
            this._group = null;
            this._map = null;
        },
        setOpacity: function (value) {
            this._opacity = value;
            if (this._group) this._group.eachLayer(function (marker) { marker.setOpacity(value); });
            if (this._fallback) this._fallback.setOpacity(value);
            return this;
        },
        setZIndex: function (value) {
            this._zIndex = value;
            if (this._fallback) this._fallback.setZIndex(value);
            return this;
        },
        _status: function (message, kind) {
            if (this.options.status) this.options.status(message, kind || 'info');
        },
        _cancel: function () {
            this._generation++;
            clearTimeout(this._timer);
            if (this._controller) this._controller.abort();
            this._controller = null;
            if (this._group) this._group.clearLayers();
        },
        _schedule: function () {
            this._cancel();
            var self = this;
            this._timer = setTimeout(function () { self._load(); }, 350);
        },
        _load: async function () {
            var map = this._map;
            if (!map || !this._group) return;
            var ro = /^ro/i.test(root.document.documentElement.lang || '');
            if (this._fallback) return;
            if (map.getZoom() < 10) {
                this._status(ro ? 'Mărește la zoom 10 pentru patrimoniu (doar zona vizibilă).' : 'Zoom to level 10 to load Heritage in the visible area.');
                return;
            }
            var bounds = map.getBounds();
            var bbox = [Math.max(19, bounds.getWest()), Math.max(39, bounds.getSouth()),
                Math.min(21.2, bounds.getEast()), Math.min(43, bounds.getNorth())];
            if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) { this._status(''); return; }
            var generation = this._generation;
            var controller = this._controller = new AbortController();
            var parts = this.options.parts();
            var points = [], seen = new Set(), limited = false, errors = 0;
            this._status(ro ? 'Se încarcă patrimoniul din zona vizibilă…' : 'Loading visible Heritage…');
            for (var i = 0; i < parts.length; i++) {
                if (points.length >= 600) { limited = true; break; }
                try {
                    // Serial, capped queries prevent one toggle flooding ASIG.
                    var response = await root.fetch('/api/geo/asig-heritage?layer=' + encodeURIComponent(parts[i].name) + '&bbox=' + bbox.join(','), { signal: controller.signal });
                    if (!response.ok) throw new Error('WFS unavailable');
                    var data = await response.json();
                    if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('Invalid features');
                    if (generation !== this._generation || !this._map) return;
                    limited = limited || !!data.truncated;
                    data.features.slice(0, 150).forEach(function (feature) {
                        var coordinates = feature.geometry && feature.geometry.coordinates;
                        if (feature.geometry && feature.geometry.type === 'Point' && coordinates && coordinates.length >= 2 &&
                            Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1]) &&
                            coordinates[0] >= bbox[0] && coordinates[0] <= bbox[2] && coordinates[1] >= bbox[1] && coordinates[1] <= bbox[3] &&
                            !seen.has(feature.id) && points.length < 600) {
                            seen.add(feature.id); points.push(feature);
                        }
                    });
                    this._draw(points);
                } catch (error) {
                    if (controller.signal.aborted || generation !== this._generation) return;
                    errors++;
                    // One unavailable type must not hide the remaining sources.
                }
            }
            if (generation !== this._generation || !this._map) return;
            this._controller = null;
            if (errors && this.options.createFallback) {
                // A single server-composited tile layer, never one stack per source.
                this._group.clearLayers();
                this._fallback = this.options.createFallback(parts, this._opacity, function (message, kind) {
                    this._status(message, kind);
                }.bind(this));
                if (this._zIndex != null) this._fallback.setZIndex(this._zIndex);
                map.addLayer(this._fallback);
                this._status(ro ? 'Patrimoniu afișat ca hartă ASIG (serviciul de obiecte este incomplet).' : 'Showing Heritage as an ASIG map (feature service incomplete).', 'warn');
            }
            else if (errors) this._status(ro ? 'Serviciul de obiecte ASIG nu este disponibil sau a răspuns incomplet.' : 'ASIG feature service unavailable or incomplete.', 'error');
            else if (limited) this._status(ro ? 'Rezultat parțial (max. 600 obiecte / 150 per sursă). Mărește harta pentru detalii.' : 'Partial viewport sample (max. 600 objects / 150 per source). Zoom in for more detail.', 'warn');
            else this._status(points.length + (ro ? ' obiecte în zona vizibilă.' : ' objects in the visible area.'));
        },
        _draw: function (features) {
            var map = this._map, group = this._group;
            if (!map || !group) return;
            group.clearLayers();
            var cells = new Map(), zoom = map.getZoom();
            var cellSize = zoom < 13 ? 80 : zoom < 16 ? 50 : 24;
            features.forEach(function (feature) {
                var c = feature.geometry.coordinates, p = map.project([c[1], c[0]], zoom);
                var key = Math.floor(p.x / cellSize) + '/' + Math.floor(p.y / cellSize);
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push(feature);
            });
            var self = this;
            cells.forEach(function (items) {
                var lat = 0, lng = 0;
                items.forEach(function (feature) { lng += feature.geometry.coordinates[0]; lat += feature.geometry.coordinates[1]; });
                var marker = L.marker([lat / items.length, lng / items.length], {
                    opacity: self._opacity,
                    icon: L.divIcon({ className: 'asig-heritage-cluster', html: items.length > 1 ? String(items.length) : '•', iconSize: [32, 32] })
                });
                if (items.length > 1) marker.on('click', function () {
                    if (map.getZoom() < 20) map.setView(marker.getLatLng(), map.getZoom() + 2);
                    else {
                        var content = root.document.createElement('div');
                        content.textContent = items.map(function (f) { return f.properties.title; }).join('; ');
                        marker.bindPopup(content).openPopup();
                    }
                });
                else {
                    var content = root.document.createElement('div');
                    content.textContent = items[0].properties.title + (items[0].properties.representative ? ' (area representative / reper de suprafață)' : '');
                    marker.bindPopup(content);
                }
                group.addLayer(marker);
            });
        }
    });
}));
