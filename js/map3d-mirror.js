/* ============================================================================
 * map3d-mirror.js — the 2D → 3D mirror
 * ----------------------------------------------------------------------------
 * WHY
 *   The 3D view used to draw the layers that the *registry* knew about. Any
 *   map element the registry did not describe — vectors, markers, clusters,
 *   heatmaps, image overlays, a plugin layer, a layer created at runtime —
 *   simply did not exist in 3D, and a layer whose 2D switch was labelled with
 *   a different element id could never be detected as “on”.
 *
 * WHAT
 *   This module reads the LIVE Leaflet map (`window._dlMap`) and translates
 *   every visible layer into a renderer-independent descriptor:
 *
 *     tile layer (XYZ · WMS · WMTS · ArcGIS · any L.TileLayer subclass)
 *                                     → kind 'raster'  (one tile URL per tile)
 *     L.ImageOverlay / rotated overlay → kind 'image'   (4 corner coordinates)
 *     L.GeoJSON · Polygon · Polyline · Circle · CircleMarker
 *                                     → kind 'vector'  (GeoJSON + paints)
 *     L.Marker (icon, popup, tooltip) → kind 'markers' (GeoJSON + symbol spec)
 *     L.MarkerClusterGroup            → kind 'cluster' (GeoJSON + cluster spec)
 *     heat layers (leaflet-heat, custom canvas heatmaps)
 *                                     → kind 'heat'    (weighted GeoJSON)
 *     anything unknown                → kind 'unsupported' (named, never hidden)
 *
 *   The 3D viewer (`js/map3d-terrain.js`) turns those descriptors into
 *   MapLibre sources/layers. Because the descriptors come from the live 2D
 *   map, a layer CANNOT be visible in 2D and missing from 3D: the 2D map is
 *   the single source of truth for *what exists*, the registry
 *   (`js/layer-registry.js`) stays the single source of truth for the service
 *   facts (URLs, params, CORS/proxy policy, titles).
 *
 * HOW A TILE URL IS BUILT
 *   No layer is re-implemented here. For an `{z}/{x}/{y}` request the mirror
 *   asks the Leaflet layer itself — `layer.getTileUrl(coords)` — through a
 *   prototype shim that pins `_tileZoom`/`_globalTileRange` to the requested
 *   tile, so a WMS `GetMap` bbox, an ArcGIS `exportImage`, a WMTS KVP tile, a
 *   canvas-recolouring TileLayer subclass or a per-country LiDAR builder all
 *   produce exactly the URL the 2D view would have produced. The 3D view only
 *   decides how to transport it (direct, or through /api/map3d/tile).
 *
 * Exposes window.DetectLabMirror:
 *   .collect(map, opts)      → { items, unsupported, signature, byKey }
 *   .tileUrlFor(layer, z,x,y)→ concrete upstream URL ('' when impossible)
 *   .layerByKey(key)         → the Leaflet layer behind a dl2d:// template
 *   .templateFor(layer)      → 'dl2d://<key>/{z}/{x}/{y}'
 *   .paneZIndex(map, layer)  → the layer's 2D pane z-index (its draw order)
 *   .describe(layer, map)    → the descriptor of one layer (or null)
 * ========================================================================== */
(function (root) {
    'use strict';

    /* No global object at all (a headless probe, a worker without `self`):
     * importing the module must never be fatal. */
    if (!root) return;

    var VERSION = '2026-10-13-3d-mirror-v1';

    /* Leaflet's own pane z-index defaults — used when a layer has no pane. */
    var PANE_Z = {
        tilePane: 200,
        overlayPane: 400,
        shadowPane: 500,
        markerPane: 600,
        tooltipPane: 650,
        popupPane: 700
    };

    var byKey = {};      /* dl2d key → live Leaflet layer (protocol lookup) */

    function L() { return root.L || null; }

    function stamp(layer) {
        if (layer._leaflet_id) return layer._leaflet_id;
        try {
            var Leaflet = L();
            if (Leaflet && Leaflet.stamp) return Leaflet.stamp(layer);
        } catch (e) { /* ignore */ }
        layer._leaflet_id = 'm' + (++stamp.counter);
        return layer._leaflet_id;
    }
    stamp.counter = 0;

    function keyOf(layer) { return '2d.' + stamp(layer); }

    function templateFor(layer) {
        return 'dl2d://' + keyOf(layer) + '/{z}/{x}/{y}';
    }

    function layerByKey(key) { return byKey[key] || null; }

    /* ── pane / order ─────────────────────────────────────────────────────── */
    function paneNameOf(map, layer) {
        var o = layer.options || {};
        if (o.pane) return o.pane;
        var Leaflet = L();
        if (Leaflet) {
            if (Leaflet.Marker && layer instanceof Leaflet.Marker) return 'markerPane';
            if (Leaflet.ImageOverlay && layer instanceof Leaflet.ImageOverlay) return 'overlayPane';
            if (Leaflet.Path && layer instanceof Leaflet.Path) return 'overlayPane';
        }
        if (layer._pane) return layer._pane;                    /* custom overlays */
        return 'overlayPane';
    }

    function paneZIndex(map, layer) {
        var name = paneNameOf(map, layer);
        try {
            var pane = map && map.getPane ? map.getPane(name) : null;
            var z = pane && pane.style ? parseInt(pane.style.zIndex, 10) : NaN;
            if (!isNaN(z)) return z;
        } catch (e) { /* ignore */ }
        if (layer._pane) {
            /* A custom overlay that owns its pane: read that pane instead. */
            try {
                var custom = map && map.getPane ? map.getPane(layer._pane) : null;
                var cz = custom && custom.style ? parseInt(custom.style.zIndex, 10) : NaN;
                if (!isNaN(cz)) return cz;
            } catch (e2) { /* ignore */ }
        }
        return PANE_Z[name] || 400;
    }

    /* ── classification ───────────────────────────────────────────────────── */
    function isTileLayer(layer, Leaflet) {
        return !!(Leaflet.TileLayer && layer instanceof Leaflet.TileLayer);
    }
    function isMarkerCluster(layer) {
        /* leaflet.markercluster is a FeatureGroup with a cluster tree. */
        return !!(layer && layer._topClusterLevel && typeof layer.getAllChildMarkers === 'function');
    }
    function isHeatLayer(layer) {
        if (!layer) return false;
        if (layer._heat && typeof layer._heat.draw === 'function') return true;
        if (layer._latlngs && /heat/i.test((layer.constructor && layer.constructor.name) || '')) return true;
        return /heat/i.test((layer.options && layer.options._kind) || '');
    }
    function isRotatedOverlay(layer) {
        return layer && layer._rotation != null && layer._img && layer._canvas;
    }

    function classify(layer, Leaflet) {
        if (!layer) return 'unsupported';
        if (isTileLayer(layer, Leaflet)) return 'raster';
        /* Not an L.TileLayer, but it paints its own tiles (a custom L.Layer with
         * createTile: the country LiDAR canvases, the heritage canvas). */
        if (typeof layer.createTile === 'function') return 'raster';
        if (isMarkerCluster(layer)) return 'cluster';
        if (isHeatLayer(layer)) return 'heat';
        /* The app's own rotated overlay (L.RotatedImageOverlay in js/map-app.js)
         * is an L.Layer, not an L.ImageOverlay — it is still a georeferenced
         * image and drapes as one. */
        if (isRotatedOverlay(layer)) return 'image';
        if (Leaflet.ImageOverlay && layer instanceof Leaflet.ImageOverlay) return 'image';
        if (Leaflet.SVGOverlay && layer instanceof Leaflet.SVGOverlay) return 'vector';
        if (Leaflet.VideoOverlay && layer instanceof Leaflet.VideoOverlay) return 'video';
        if (Leaflet.Marker && layer instanceof Leaflet.Marker) return 'markers';
        if (Leaflet.GeoJSON && layer instanceof Leaflet.GeoJSON) return 'vector';
        if (Leaflet.Path && layer instanceof Leaflet.Path) return 'vector';
        if (Leaflet.LayerGroup && layer instanceof Leaflet.LayerGroup) return 'group';
        return 'unsupported';
    }

    /* ── per-tile URL, built by the layer itself ──────────────────────────── */
    var warned = {};
    var failures = {};      /* key → last error while building a tile URL */

    function tileUrlFor(layer, z, x, y) {
        if (!layer) return '';
        var n = Math.pow(2, z);
        /* Leaflet's own tile layers expect an L.Point (L.TileLayer.WMS calls
         * coords.scaleBy(), the ArcGIS layers read .x/.y) with the tile zoom on
         * it — a plain {x,y,z} object throws inside the layer's own builder. */
        var Leaflet = L();
        var coords = { x: x, y: y, z: z };
        try {
            if (Leaflet && typeof Leaflet.point === 'function') {
                coords = Leaflet.point(x, y);
                coords.z = z;
            }
        } catch (e) { coords = { x: x, y: y, z: z }; }
        try {
            /* A prototype shim: every method/option of the real layer is
             * visible, but _tileZoom / _globalTileRange describe the tile we
             * are asking for — which is what the 3D grid needs. */
            var shim = Object.create(layer);
            shim._tileZoom = z;
            shim._globalTileRange = {
                min: { x: 0, y: 0 },
                max: { x: n - 1, y: n - 1 }
            };
            if (typeof layer.getTileUrl === 'function') {
                var url = layer.getTileUrl.call(shim, coords);
                if (url) return String(url);
            }
        } catch (e) {
            failures[keyOf(layer)] = String(e && e.message || e);
            if (!warned[keyOf(layer)]) {
                warned[keyOf(layer)] = true;
                if (root.console && console.warn) {
                    console.warn('[Map3D] ' + keyOf(layer) + ' could not build a tile URL: ' + (e && e.message));
                }
            }
        }
        /* Fallback: plain template substitution on the layer's own template. */
        var template = layer._url || (layer.options && layer.options.url) || '';
        if (!template) { failures[keyOf(layer)] = 'no getTileUrl() result and no template'; return ''; }
        failures[keyOf(layer)] = failures[keyOf(layer)] || 'used the raw template (getTileUrl() threw)';
        return String(template)
            .replace(/\{z\}/g, String(z))
            .replace(/\{x\}/g, String(x))
            .replace(/\{y\}/g, String(y))
            .replace(/\{-y\}/g, String(n - 1 - y));
    }

    /* ── GeoJSON helpers ──────────────────────────────────────────────────── */
    function featureCollection(features) {
        return { type: 'FeatureCollection', features: features || [] };
    }

    function geometryOf(layer) {
        try {
            if (typeof layer.toGeoJSON !== 'function') return null;
            var json = layer.toGeoJSON();
            if (!json) return null;
            if (json.type === 'FeatureCollection') return json;
            return json;
        } catch (e) { return null; }
    }

    function popupHtml(layer) {
        try {
            var popup = layer.getPopup && layer.getPopup();
            if (!popup) return '';
            var content = popup.getContent && popup.getContent();
            if (content == null) return '';
            if (typeof content === 'string') return content;
            if (content.outerHTML) return content.outerHTML;
            if (content.innerHTML != null) return content.innerHTML;
        } catch (e) { /* ignore */ }
        return '';
    }

    function tooltipText(layer) {
        try {
            var tooltip = layer.getTooltip && layer.getTooltip();
            if (!tooltip) return '';
            var content = tooltip.getContent && tooltip.getContent();
            if (content == null) return '';
            if (typeof content === 'string') return content;
            if (content.textContent) return content.textContent;
            if (content.outerHTML) return content.outerHTML;
        } catch (e) { /* ignore */ }
        return '';
    }

    function iconOf(layer) {
        try {
            var icon = layer.options && layer.options.icon;
            var opts = icon && icon.options;
            if (!opts) return null;
            var url = opts.iconUrl || (opts.icon && opts.icon.src) || null;
            if (!url) return null;
            var size = opts.iconSize || [24, 24];
            if (typeof size === 'number') size = [size, size];
            var anchor = opts.iconAnchor || [size[0] / 2, size[1] / 2];
            if (typeof anchor === 'number') anchor = [anchor, anchor];
            return {
                url: String(url),
                /* MapLibre anchors an icon by its top-left corner offset from the
                 * point; Leaflet's iconAnchor is the pixel of the icon that sits
                 * on the point. */
                iconOffset: [-Math.round(anchor[0] - size[0] / 2), -Math.round(anchor[1] - size[1] / 2)],
                size: [Math.round(size[0]), Math.round(size[1])]
            };
        } catch (e) { return null; }
    }

    function dashArray(value) {
        if (value == null) return null;
        if (typeof value === 'string') {
            var parts = value.split(/[\s,]+/).map(Number).filter(function (v) { return !isNaN(v) && v > 0; });
            return parts.length ? parts : null;
        }
        return null;
    }

    /* Leaflet path options → MapLibre paint properties (pixel units match). */
    function pathPaints(layer) {
        var o = layer.options || {};
        var color = o.color || '#3388ff';
        var weight = o.weight == null ? 3 : Number(o.weight);
        var lineOpacity = o.opacity == null ? 1 : Number(o.opacity);
        var fillColor = o.fillColor || color;
        var fillOpacity = o.fillOpacity == null ? 0.2 : Number(o.fillOpacity);
        var dash = dashArray(o.dashArray);
        var line = {
            'line-color': color,
            'line-width': Math.max(0, weight),
            'line-opacity': lineOpacity
        };
        if (dash) line['line-dasharray'] = dash;
        /* line-cap / line-join are LAYOUT properties in MapLibre, not paint:
         * handing them to addLayer as paint raises a style error and the layer
         * never appears. */
        var layout = {};
        if (o.lineCap) layout['line-cap'] = o.lineCap === 'square' ? 'butt' : o.lineCap;
        if (o.lineJoin) layout['line-join'] = o.lineJoin;
        var fill = { 'fill-color': fillColor, 'fill-opacity': fillOpacity };
        var circle = {
            'circle-radius': o.radius == null ? 10 : Number(o.radius),
            'circle-color': fillColor,
            /* A circleMarker paints its stroke with the line colour/width. */
            'circle-stroke-color': color,
            'circle-stroke-width': Math.max(0, weight),
            'circle-stroke-opacity': lineOpacity,
            'circle-opacity': fillOpacity
        };
        return { line: line, fill: fill, circle: circle, layout: layout, dashed: !!dash };
    }

    function geometryTypes(geojson) {
        var types = {};
        var features = geojson.type === 'FeatureCollection' ? geojson.features : [geojson];
        features.forEach(function (f) {
            var g = f && f.geometry;
            if (!g) return;
            var t = g.type;
            if (t === 'GeometryCollection') {
                (g.geometries || []).forEach(function (gg) { if (gg) types[gg.type] = true; });
            } else if (t) types[t] = true;
        });
        return Object.keys(types);
    }

    /* ── image overlays ───────────────────────────────────────────────────── */
    function overlayCoordinates(layer) {
        try {
            var bounds = layer._initialBounds || (layer.getBounds ? layer.getBounds() : null);
            if (!bounds) return null;
            var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
            var rotation = Number(layer._rotation || (layer.options && layer.options.rotation) || 0);
            if (!rotation) {
                return [
                    [sw.lng, ne.lat], [ne.lng, ne.lat],
                    [ne.lng, sw.lat], [sw.lng, sw.lat]
                ];
            }
            /* Rotated overlay: the four corners of the rectangle, rotated about
             * the rectangle centre — the same transform the 2D canvas uses. */
            var cx = (sw.lng + ne.lng) / 2, cy = (sw.lat + ne.lat) / 2;
            var rad = rotation * Math.PI / 180;
            var cos = Math.cos(rad), sin = Math.sin(rad);
            var corners = [
                [ne.lng, ne.lat], [ne.lng, sw.lat], [sw.lng, sw.lat], [sw.lng, ne.lat]
            ];
            return corners.map(function (c) {
                var dx = c[0] - cx, dy = c[1] - cy;
                return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
            });
        } catch (e) { return null; }
    }

    /* ── heat layers ──────────────────────────────────────────────────────── */
    function heatDescriptor(layer) {
        var points = [];
        var lls = layer._latlngs || [];
        for (var i = 0; i < lls.length; i += 1) {
            var p = lls[i];
            if (!p) continue;
            var lat = p.lat != null ? p.lat : p[0];
            var lng = p.lng != null ? p.lng : p[1];
            var w = p.alt != null ? p.alt : (Array.isArray(p) ? p[2] : null);
            if (lat == null || lng == null) continue;
            points.push({ type: 'Feature', properties: { w: w == null ? 1 : Number(w) }, geometry: { type: 'Point', coordinates: [lng, lat] } });
        }
        var o = layer.options || {};
        return {
            geojson: featureCollection(points),
            heat: {
                radius: o.radius == null ? 25 : Number(o.radius),
                blur: o.blur == null ? 15 : Number(o.blur),
                max: o.max == null ? 1 : Number(o.max),
                gradient: o.gradient || null,
                minOpacity: o.minOpacity == null ? 0.05 : Number(o.minOpacity)
            }
        };
    }

    /* ── the descriptor of one layer ──────────────────────────────────────── */
    function opacityOf(layer) {
        try {
            if (typeof layer.getOpacity === 'function') {
                var v = layer.getOpacity();
                if (v != null && !isNaN(v)) return Math.max(0, Math.min(1, Number(v)));
            }
            var o = layer.options || {};
            if (o.opacity != null) return Math.max(0, Math.min(1, Number(o.opacity)));
            if (layer._opacity != null) return Math.max(0, Math.min(1, Number(layer._opacity)));
        } catch (e) { /* ignore */ }
        return 1;
    }

    function labelOf(layer) {
        var vars = varNamesOf(layer);
        if (vars.length) return vars[0];
        var o = layer.options || {};
        return (o.name || o.id || (layer.constructor && layer.constructor.name) || 'layer');
    }

    function varNamesOf(layer) {
        var out = [];
        try {
            for (var k in root) {
                var v = null;
                try { v = root[k]; } catch (e) { continue; }
                if (v === layer) out.push(k);
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    /** Title of a registry definition in the current page language. */
    function titleOf(def) {
        if (!def) return '';
        var lang = 'ro';
        try {
            if (root._currentLang) lang = root._currentLang;
            else if (document && document.documentElement && /^en/i.test(document.documentElement.lang || '')) lang = 'en';
        } catch (e) { /* keep ro */ }
        var title = def.title;
        if (typeof title === 'string') return title;
        return (title && (title[lang] || title.en || title.ro)) || def.id || '';
    }

    /**
     * The registry definition behind a live 2D layer, when there is one.
     * Keeping the link matters in two directions: the 3D view reuses the
     * service facts (title, attribution, CORS/proxy policy, zoom window) the
     * 2D layer was built from, and the registry can report a layer as active in
     * 2D because the mirror found it — not because a checkbox happened to be
     * ticked.
     */
    function defFor(layer) {
        var tagged = taggedDef(layer);                /* the app named it itself */
        if (tagged) return tagged;
        var reg = registry();
        if (!reg || typeof reg.matchDef !== 'function') return null;
        try {
            return reg.matchDef({
                url: layer._url || (layer.options && layer.options.url) || '',
                layers: layer.options && (layer.options.layers || layer.options.layer),
                version: layer.options && layer.options.version,
                format: layer.options && layer.options.format
            });
        } catch (e) { return null; }
    }

    /** 'pane_patrimoniu' → 'patrimoniu' (a last-resort, still useful, label). */
    function paneLabel(name) {
        if (!name) return '';
        return String(name).replace(/^pane_/, '').replace(/_/g, ' ');
    }

    /* ── canvas-rendered tiles ─────────────────────────────────────────────
     * Some layers have no tile URL: they fetch their data and draw the tile
     * into a canvas (or an <img>) of their own. Leaflet calls createTile() for
     * each tile it needs; the 3D view does exactly the same and hands the
     * resulting pixels to MapLibre, so such a layer drapes with the same look it
     * has in 2D — no re-implementation, no data-format knowledge needed.
     * ─────────────────────────────────────────────────────────────────────── */
    function canvasToBytes(canvas) {
        return new Promise(function (resolve, reject) {
            try {
                if (canvas.toBlob) {
                    canvas.toBlob(function (blob) {
                        if (!blob) { reject(new Error('tile canvas produced no PNG')); return; }
                        blob.arrayBuffer().then(resolve, reject);
                    }, 'image/png');
                    return;
                }
                var url = canvas.toDataURL('image/png');
                resolve(dataUrlToBytes(url));
            } catch (e) { reject(e); }
        });
    }

    function dataUrlToBytes(url) {
        var base64 = String(url).split(',')[1] || '';
        var binary = '';
        try { binary = root.atob(base64); }
        catch (e) {
            if (typeof Buffer !== 'undefined') return Promise.resolve(Buffer.from(base64, 'base64'));
            return Promise.reject(new Error('cannot decode the rendered tile'));
        }
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return Promise.resolve(bytes.buffer);
    }

    /** The rendered pixels of an <img> tile (or any ImageBitmap-ish source). */
    function imageToBytes(image, size) {
        var doc = (root.document) || (image && image.ownerDocument);
        var canvas = doc && doc.createElement ? doc.createElement('canvas') : null;
        if (!canvas) return Promise.reject(new Error('cannot rasterise the rendered tile (no canvas)'));
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        try { ctx.drawImage(image, 0, 0, size, size); } catch (e) { return Promise.reject(e); }
        return canvasToBytes(canvas);
    }

    /**
     * Render one tile through the Leaflet layer itself.
     * Resolves with the PNG bytes, exactly as the 2D map would have drawn them.
     */
    function renderTile(layer, z, x, y, timeoutMs) {
        var Leaflet = L();
        if (!Leaflet || !layer || typeof layer.createTile !== 'function') {
            return Promise.reject(new Error('this layer cannot render its own tiles'));
        }
        var size = 256;
        try { if (layer.getTileSize) size = layer.getTileSize().x || 256; } catch (e) { size = 256; }
        return new Promise(function (resolve, reject) {
            var shim = Object.create(layer);
            shim._tileZoom = z;
            shim._tileSize = { x: size, y: size };
            var settled = false;
            var timer = root.setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error('the 2D layer did not finish drawing this tile in time'));
            }, timeoutMs || 15000);

            function finish(tile) {
                if (settled) return;
                settled = true;
                root.clearTimeout(timer);
                if (!tile) { reject(new Error('the 2D layer produced no tile')); return; }
                try {
                    if (tile.getContext) { canvasToBytes(tile).then(resolve, reject); return; }
                    imageToBytes(tile, size).then(resolve, reject);
                } catch (e) { reject(e); }
            }

            var tile = null;
            try {
                tile = layer.createTile.call(shim, { x: x, y: y, z: z }, function (error) {
                    if (error) {
                        if (!settled) { settled = true; root.clearTimeout(timer); reject(error); }
                        return;
                    }
                    finish(tile);
                });
            } catch (e) {
                settled = true;
                root.clearTimeout(timer);
                reject(e);
                return;
            }
            if (!tile) return;                                   /* done() will settle it */
            if (tile.tagName === 'IMG') {
                if (tile.complete && tile.naturalWidth) finish(tile);
                else tile.addEventListener('load', function () { finish(tile); }, { once: true });
            } else if (tile.getContext) {
                /* Leaflet canvas tiles call done() when they are finished; some
                 * implementations return the canvas already painted. Give it one
                 * frame anyway, then settle on whatever is there. */
                root.setTimeout(function () { if (!settled) finish(tile); }, 0);
            }
        });
    }

    function describe(layer, map, opts) {
        try { return describeUnsafe(layer, map, opts); }
        catch (e) {
            failures[keyOf(layer)] = String((e && e.message) || e);
            return null;
        }
    }

    function registry() { return root.DetectLabLayers || root.DetectLabLayerRegistry || null; }

    function taggedDef(layer) {
        var id = layer && (layer._dlDefId || (layer.options && layer.options.dlDefId));
        var reg = registry();
        if (!id || !reg) return null;
        try { return reg.get(id); } catch (e) { return null; }
    }

    function describeUnsafe(layer, map, opts) {
        opts = opts || {};
        var Leaflet = L();
        if (!Leaflet || !layer) return null;
        var kind = classify(layer, Leaflet);
        var def = defFor(layer);
        var pane = paneNameOf(map, layer);
        var base = {
            key: keyOf(layer),
            kind: kind,
            z: paneZIndex(map, layer),
            pane: pane,
            opacity: opacityOf(layer),
            defId: def ? def.id : null,
            label: String(layer.options && layer.options.name || '').trim() ||
                (def ? titleOf(def) : '') || paneLabel(pane) || null,
            attribution: (layer.options && typeof layer.options.attribution === 'string' && layer.options.attribution)
                || (def && def.attribution) || '',
            cors: def ? (def.cors || 'unknown') : 'unknown',
            interactive: !!(layer.options && layer.options.interactive)
        };

        if (kind === 'group') return null;                  /* children are mirrored */

        if (kind === 'raster') {
            var attribution = base.attribution;
            if (layer.options && layer.options.attribution && typeof layer.options.attribution === 'object' && layer.options.attribution.value) {
                attribution = layer.options.attribution.value;
            }
            var bounds = null;
            try {
                var b = layer.options && layer.options.bounds;
                if (b && b.isValid && b.isValid()) {
                    bounds = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
                }
            } catch (e) { bounds = null; }
            var size = 256;
            try { if (layer.getTileSize) size = layer.getTileSize().x || 256; } catch (e) { size = 256; }
            /* A tile layer may have no URL at all: the country LiDAR modules
             * (js/ahn-layer.js, js/hoydedata-layer.js, …) and the canvas layers
             * in js/map-app.js draw each tile themselves from a data service.
             * Those are mirrored too — the 3D view asks for the tile and lets
             * the layer render it (see renderTile below), so the pixels are the
             * same ones the 2D map draws. A layer that can do neither is the
             * only kind that cannot be draped, and it is reported as such. */
            var canvasTiles = typeof layer.createTile === 'function';
            if (!layer.getTileUrl && !layer._url && !canvasTiles) {
                return Object.assign(base, {
                    reason: 'tile layer with neither a URL nor its own tile renderer',
                    render: 'none'
                });
            }
            return Object.assign(base, {
                template: templateFor(layer),
                render: (layer.getTileUrl || layer._url) ? 'url' : 'canvas',
                tileSize: size,
                minzoom: layer.options && layer.options.minZoom != null ? Number(layer.options.minZoom) : 0,
                maxzoom: layer.options && (layer.options.maxNativeZoom || layer.options.maxZoom) != null
                    ? Number(layer.options.maxNativeZoom || layer.options.maxZoom) : 22,
                bounds: bounds,
                attribution: attribution || '',
                label: base.label || 'tiles',
                layer: layer
            });
        }

        if (kind === 'vector' || kind === 'markers' || kind === 'cluster' || kind === 'heat') {
            base.layer = layer;
        }

        if (kind === 'image') {
            var coordinates = overlayCoordinates(layer);
            var url = layer._url || (layer._image && layer._image.src) ||
                (layer._img && (layer._img.currentSrc || layer._img.src)) || '';
            if (!coordinates || !url) return null;
            return Object.assign(base, { url: String(url), coordinates: coordinates, label: base.label || 'image overlay' });
        }

        if (kind === 'video') {
            return Object.assign(base, {
                reason: 'video overlay — no terrain-draped equivalent in MapLibre',
                url: layer._url || ''
            });
        }

        if (kind === 'heat') {
            var heat = heatDescriptor(layer);
            if (!heat.geojson.features.length) return null;
            return Object.assign(base, heat, { label: base.label || 'heatmap' });
        }

        if (kind === 'cluster') {
            var clusterFeatures = [];
            try {
                layer.eachLayer(function (child) {
                    var f = geometryOf(child);
                    if (!f) return;
                    var feats = f.type === 'FeatureCollection' ? f.features : [f];
                    feats.forEach(function (feat) {
                        if (!feat || !feat.geometry || feat.geometry.type !== 'Point') return;
                        feat.properties = feat.properties || {};
                        feat.properties.popup = popupHtml(child);
                        feat.properties.tooltip = tooltipText(child);
                        feat.properties.icon = iconOf(child);
                        clusterFeatures.push(feat);
                    });
                });
            } catch (e) { /* ignore */ }
            if (!clusterFeatures.length) return null;
            var co = layer.options || {};
            return Object.assign(base, {
                geojson: featureCollection(clusterFeatures),
                cluster: {
                    radius: co.maxClusterRadius == null ? 60 : Number(co.maxClusterRadius),
                    maxZoom: co.disableClusteringAtZoom == null ? 14 : Number(co.disableClusteringAtZoom) - 1,
                    color: (co.iconCreateFunction ? '#2b6cb0' : '#2b6cb0')
                },
                label: base.label || 'clusters'
            });
        }

        if (kind === 'markers') {
            var geometry = geometryOf(layer);
            if (!geometry || (geometry.geometry && geometry.geometry.type !== 'Point')) return null;
            geometry.properties = Object.assign({}, geometry.properties, {
                popup: popupHtml(layer),
                tooltip: tooltipText(layer),
                icon: iconOf(layer),
                z: base.z
            });
            return Object.assign(base, {
                geojson: featureCollection([geometry]),
                label: base.label || 'markers'
            });
        }

        if (kind === 'vector') {
            var gj = geometryOf(layer);
            if (!gj) return null;
            var paints = pathPaints(layer);
            return Object.assign(base, {
                geojson: gj.type === 'FeatureCollection' ? gj : featureCollection([gj]),
                types: geometryTypes(gj),
                paints: paints,
                popup: popupHtml(layer),
                tooltip: tooltipText(layer),
                label: base.label || (layer.constructor && layer.constructor.name) || 'vector'
            });
        }

        return Object.assign(base, { reason: 'no 3D equivalent for ' + ((layer.constructor && layer.constructor.name) || typeof layer) });
    }

    /* ── walking the map ──────────────────────────────────────────────────── */
    function safeDescribe(map, layer) {
        try { return describe(layer, map, {}); }
        catch (e) {
            failures[keyOf(layer)] = String((e && e.message) || e);
            if (root.console && console.warn) console.warn('[Map3D] ' + keyOf(layer) + ' could not be mirrored: ' + (e && e.message));
            return null;
        }
    }

    function walk(map, layer, out, depth) {
        if (!layer || depth > 4) return;
        var Leaflet = L();
        var kind = classify(layer, Leaflet);
        if (kind === 'group') {
            try {
                layer.eachLayer(function (child) { walk(map, child, out, depth + 1); });
            } catch (e) { /* ignore */ }
            return;
        }
        if (kind === 'cluster') {
            /* A cluster group renders its children itself: mirror it as one
             * clustered source instead of thousands of single points. */
            var descriptor = safeDescribe(map, layer);
            if (descriptor) out.push(descriptor);
            return;
        }
        var descriptor = safeDescribe(map, layer);
        if (descriptor) out.push(descriptor);
    }

    function collect(map) {
        if (!map || typeof map.eachLayer !== 'function') {
            return { items: [], unsupported: [], signature: '', byKey: {} };
        }
        var items = [];
        var unsupported = [];
        byKey = {};
        map.eachLayer(function (layer) {
            var before = items.length;
            try { walk(map, layer, items, 0); }
            catch (e) { failures[keyOf(layer)] = String((e && e.message) || e); }
            if (items.length === before) {
                var d = safeDescribe(map, layer);
                if (d && d.kind === 'unsupported') {
                    var line = (d.label || 'layer') + ' — ' + (d.reason || '');
                    if (unsupported.indexOf(line) === -1) unsupported.push(line);
                }
            }
        });
        var unique = [];
        var seen = {};
        items.forEach(function (item) {
            if (seen[item.key]) return;            /* the same layer, walked twice */
            seen[item.key] = true;
            unique.push(item);
            if (item.kind === 'unsupported') return;
            byKey[item.key] = item.layer || null;
        });
        items = unique;
        return {
            items: items,
            unsupported: unsupported,
            signature: signatureOf(items) + '|' + unsupported.join(','),
            byKey: byKey
        };
    }

    /* A cheap fingerprint: id · kind · order · opacity · content size. */
    function signatureOf(items) {
        return items.map(function (i) {
            var size = 0;
            if (i.geojson) size = (i.geojson.features || []).length;
            if (i.kind === 'image') size = String(i.url).length;
            return [i.kind, i.key, i.z, Math.round((i.opacity == null ? 1 : i.opacity) * 100), size].join(':');
        }).join('|');
    }

    function isRotated(layer) { return isRotatedOverlay(layer); }

    root.DetectLabMirror = {
        VERSION: VERSION,
        collect: collect,
        describe: describe,
        classify: classify,
        tileUrlFor: tileUrlFor,
        templateFor: templateFor,
        layerByKey: layerByKey,
        paneZIndex: paneZIndex,
        paneNameOf: paneNameOf,
        signatureOf: signatureOf,
        isRotated: isRotated,
        errors: function () { return Object.assign({}, failures); },
        renderTile: renderTile,
        PANE_Z: PANE_Z
    };
}(typeof window !== 'undefined' && window ? window
    : typeof self !== 'undefined' && self ? self
        : typeof globalThis !== 'undefined' && globalThis ? globalThis : this));
