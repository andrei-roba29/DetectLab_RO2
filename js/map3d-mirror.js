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

    var VERSION = '2026-10-21-lidar-canvas-tiles-v1';

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

    /* ── budget ─────────────────────────────────────────────────────────────
       A group may hold tens of thousands of child layers: the Roman road
       network (js/map-app.js) adds ONE L.polyline per road segment, and the
       Babel/battle/patrimoniu layers add thousands of markers. Mirroring such
       a group child by child produced one 3D source + one MapLibre layer per
       child — hundreds of thousands of them — and the tab died while the deck
       was being built (a full re-walk every 1.5 s on top of it). Siblings that
       draw the same way are now merged into a single GeoJSON item per chunk,
       the result is cached on the group, and the deck has a hard item budget so
       no 2D layer can ever blow the 3D view up again. */
    var MAX_BUNDLE_FEATURES = 20000;   /* features in one merged 3D source    */
    var MAX_BUNDLES_PER_GROUP = 256;   /* merged sources taken from one group */
    var MAX_ITEMS = 400;               /* mirrored items in the whole deck    */

    /* ── CSS-blended rasters ────────────────────────────────────────────────
       Some 2D layers are only readable because CSS blends them into the base
       map (css/styles.css):
           .lidar-ro2m-tiles, .lidar-ro1m-tiles { filter: invert(1); mix-blend-mode: screen; }
       The ArcGIS hillshades behind them are white-backed, so 2D shows the
       relief lines glowing over the satellite imagery. MapLibre has no blend
       modes: mirrored as-is, the same tiles cover the terrain with an opaque
       white sheet — which is exactly what “the Romanian LiDAR does not load in
       3D” looked like. The descriptor carries the blend and the pixels are
       repainted here (blendPixels / retintTile below, driven by the viewer's
       dl2d:// protocol): white lines with alpha = 1 − luminance, which IS
       screen(base, invert(pixel)) — pixel for pixel. */
    var BLEND_BY_CLASS = {
        'lidar-ro1m-tiles': 'invert-screen',
        'lidar-ro5m-tiles': 'invert-screen',
        'lidar-ro2m-tiles': 'invert-screen'
    };

    function blendOf(layer) {
        var def = layer && layer._dlBlend;
        if (def) return def;
        var className = (layer && layer.options && layer.options.className) || '';
        var names = String(className).split(/\s+/);
        for (var i = 0; i < names.length; i += 1) {
            if (names[i] && BLEND_BY_CLASS[names[i]]) return BLEND_BY_CLASS[names[i]];
        }
        return null;
    }

    /* ── LiDAR layers (the 3D focus disc of js/lidar-3d-focus.js) ───────────
     * Every LiDAR sub-layer the app builds is tagged by js/map-app.js with
     * `_dlLidar = { key, label }`; the nine country modules carry a registry id
     * (`_dlDefId`) whose definition has `group: 'lidar'`; and anything living in
     * the live `window._lidarGroup` is LiDAR by construction.
     *
     * WHY the descriptor has to carry it: the 3D view is allowed to drape ONE
     * LiDAR layer at a time, and only inside the disc the user prefetched
     * (10 km radius maximum). The mirror is the only place that sees both the
     * live Leaflet layer and its registry definition, so it is the only place
     * that can answer “is this layer LiDAR, and which family is it?” without
     * either side re-implementing the other.
     *
     * `def:` keys name a registry definition (a layer that is drawn from the
     * registry fallback rather than mirrored); the plain `2d.<id>` keys are the
     * mirror's own, and they are what the 2D focus picker sees. */
    function lidarTag(layer, def) {
        var tag = layer && layer._dlLidar;
        if (tag && tag.key) return { key: String(tag.key), label: String(tag.label || '') };
        // Some country LiDAR products are mounted outside the LiDAR group.
        var photo = root.DLPhotoFilter;
        if (photo && photo.source3d && photo.source3d() === layer) {
            var photoId = layer._dlDefId || keyOf(layer);
            return { key: layer._dlDefId ? 'def:' + photoId : photoId, label: titleOf(def) || photoId };
        }
        if (def && def.group === 'lidar') return { key: 'def:' + def.id, label: titleOf(def) || def.id };
        var group = root._lidarGroup;
        var inGroup = false;
        try {
            inGroup = !!(group && layer && typeof group.hasLayer === 'function' && group.hasLayer(layer));
        } catch (e) { inGroup = false; }
        if (inGroup) {
            var opts = (layer && layer.options) || {};
            return {
                key: keyOf(layer),
                label: String(opts.name || opts.attribution || (def ? titleOf(def) : '') || keyOf(layer))
            };
        }
        return null;
    }

    /** The stable key the 3D focus names this very layer by (null when not LiDAR). */
    function lidarKeyOf(layer, def) {
        var tag = lidarTag(layer, def);
        return tag ? tag.key : null;
    }

    /* ── Web-Mercator tile maths + the LiDAR focus disc ─────────────────────
     * The focus disc is defined in GROUND metres (the radius the user chose), so
     * every question about it — which tiles hold it, what rectangle a MapLibre
     * source may ask for, which pixels survive the clip — is answered with the
     * same helpers below. The plan, the prefetch and what the 3D view draws can
     * therefore never disagree about the disc.
     *
     * The per-pixel check uses the local equirectangular metric (metres per
     * degree of latitude/longitude at the disc's latitude). Over 10 km that is
     * within a metre of haversine — and it makes the per-pixel loop a couple of
     * multiplications instead of four trigonometry calls, which matters: a
     * 10 km disc is a few hundred tiles × 65 536 pixels. */
    var EARTH_CIRCUMFERENCE = 40075016.686;
    var METRES_PER_DEGREE = 111320;

    function clampLat(lat) { return Math.max(-85.05112878, Math.min(85.05112878, lat)); }
    function lngAt(x, z) { return x / Math.pow(2, z) * 360 - 180; }
    function latAt(y, z) {
        var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }
    function lngToTileX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
    function latToTileY(lat, z) {
        var rad = clampLat(lat) * Math.PI / 180;
        return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
    }
    function tileBounds(z, x, y) {
        return {
            west: lngAt(x, z), north: latAt(y, z),
            east: lngAt(x + 1, z), south: latAt(y + 1, z)
        };
    }
    /** Ground metres per pixel of a 256 px (or `tileSize`) Web-Mercator tile. */
    function groundMetresPerPixel(lat, z, tileSize) {
        var size = tileSize || 256;
        return EARTH_CIRCUMFERENCE * Math.cos(clampLat(lat) * Math.PI / 180) / (size * Math.pow(2, z));
    }
    /** Ground metres per tile — the LOD yardstick of the prefetch planner. */
    function groundMetresPerTile(lat, z, tileSize) {
        return groundMetresPerPixel(lat, z, tileSize) * (tileSize || 256);
    }
    function metresPerDegreeLng(lat) {
        return METRES_PER_DEGREE * Math.max(0.01, Math.cos(clampLat(lat) * Math.PI / 180));
    }
    /** Approximate ground distance (metres) between a point and a lat/lng box. */
    function distanceToBoxM(lat, lng, box) {
        var mLng = metresPerDegreeLng(lat);
        var dLat = Math.max(0, box.south - lat, lat - box.north) * METRES_PER_DEGREE;
        var dLng = Math.max(0, box.west - lng, lng - box.east) * mLng;
        return Math.sqrt(dLat * dLat + dLng * dLng);
    }
    /** Great-circle distance (metres) — the honest one, for reporting. */
    function distanceM(a, b) {
        var rad = Math.PI / 180;
        var dLat = (b.lat - a.lat) * rad;
        var dLng = (b.lng - a.lng) * rad;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * 6378137 * Math.asin(Math.min(1, Math.sqrt(s)));
    }
    /** The local metric's distance (metres) — the one the pixel mask uses. */
    function localDistanceM(disc, lat, lng) {
        var dLat = (lat - disc.lat) * METRES_PER_DEGREE;
        var dLng = (lng - disc.lng) * metresPerDegreeLng(disc.lat);
        return Math.sqrt(dLat * dLat + dLng * dLng);
    }
    /** Normalise whatever the caller passes as a focus: { lat, lng, radiusKm }. */
    function discOf(spec) {
        if (!spec) return null;
        var lat = Number(spec.lat), lng = Number(spec.lng), radiusKm = Number(spec.radiusKm);
        if (!isFinite(lat) || !isFinite(lng) || !(radiusKm > 0)) return null;
        return { lat: lat, lng: lng, radiusKm: radiusKm, radiusM: radiusKm * 1000 };
    }
    /** The lng/lat rectangle a raster source may ask tiles for. */
    function discBounds(spec) {
        var disc = discOf(spec);
        if (!disc) return null;
        var dLat = disc.radiusKm / 111.32;
        var dLng = disc.radiusKm / (111.32 * Math.max(0.01, Math.cos(disc.lat * Math.PI / 180)));
        return [
            Math.max(-180, disc.lng - dLng), Math.max(-85, disc.lat - dLat),
            Math.min(180, disc.lng + dLng), Math.min(85, disc.lat + dLat)
        ];
    }
    /** Inclusive tile window whose tiles can intersect the disc at `z`. */
    function discTileWindow(spec, z) {
        var disc = discOf(spec);
        var n = Math.pow(2, z);
        if (!disc) return { z: z, x0: 0, y0: 0, x1: n - 1, y1: n - 1, count: n * n };
        var dLat = disc.radiusKm / 111.32;
        var dLng = disc.radiusKm / (111.32 * Math.max(0.01, Math.cos(disc.lat * Math.PI / 180)));
        var x0 = Math.max(0, Math.floor(lngToTileX(disc.lng - dLng, z)));
        var x1 = Math.min(n - 1, Math.floor(lngToTileX(disc.lng + dLng, z)));
        var y0 = Math.max(0, Math.floor(latToTileY(disc.lat + dLat, z)));
        var y1 = Math.min(n - 1, Math.floor(latToTileY(disc.lat - dLat, z)));
        return { z: z, x0: x0, y0: y0, x1: x1, y1: y1, count: Math.max(0, (x1 - x0 + 1) * (y1 - y0 + 1)) };
    }
    /** Does the tile share any ground with the disc? (the tile window is only a box) */
    function discTouchesTile(spec, z, x, y) {
        var disc = discOf(spec);
        if (!disc) return true;
        return distanceToBoxM(disc.lat, disc.lng, tileBounds(z, x, y)) <= disc.radiusM;
    }
    /** Does the tile lie entirely inside the disc (no pixel work needed)? */
    function discContainsTile(spec, z, x, y) {
        var disc = discOf(spec);
        if (!disc) return false;
        var b = tileBounds(z, x, y);
        /* Distance is convex over the tile, so its maximum is at a corner — and
         * it is measured with the very metric the pixel mask uses, so “inside”
         * here means every pixel really is inside (never a leak at the edge). */
        return Math.max(
            localDistanceM(disc, b.north, b.west),
            localDistanceM(disc, b.north, b.east),
            localDistanceM(disc, b.south, b.west),
            localDistanceM(disc, b.south, b.east)
        ) <= disc.radiusM;
    }
    /** A closed lat/lng ring around the disc (the outline drawn in 3D / 2D). */
    function discRing(spec, steps) {
        var disc = discOf(spec);
        if (!disc) return null;
        var count = Math.max(16, Math.round(steps || 72));
        var mLng = metresPerDegreeLng(disc.lat);
        var ring = [];
        for (var i = 0; i <= count; i += 1) {
            var a = (i / count) * Math.PI * 2;
            ring.push([
                disc.lng + (disc.radiusM * Math.cos(a)) / mLng,
                disc.lat + (disc.radiusM * Math.sin(a)) / METRES_PER_DEGREE
            ]);
        }
        return ring;
    }
    function discGeojson(spec, steps) {
        var ring = discRing(spec, steps);
        if (!ring) return null;
        return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
    }

    /** The alpha a pixel of `tile` gets inside the disc, applied in place. */
    function maskPixels(frame, size, tile, spec) {
        var disc = discOf(spec);
        if (!frame || !disc) return frame;
        var d = frame.data || frame;
        var px = Math.max(1, Math.round(size));
        /* Column/row lookup tables: the pixel loop must not call Math.pow()
         * twice per pixel (65 536 of them per tile, a few hundred tiles). */
        var rows = new Float64Array(px);
        var cols = new Float64Array(px);
        for (var p = 0; p < px; p += 1) {
            rows[p] = (latAt(tile.y + (p + 0.5) / px, tile.z) - disc.lat) * METRES_PER_DEGREE;
            cols[p] = (lngAt(tile.x + (p + 0.5) / px, tile.z) - disc.lng) * metresPerDegreeLng(disc.lat);
        }
        /* One pixel of feathering: the edge of the disc is a curve, and a hard
         * threshold would give it a staircase. */
        var feather = groundMetresPerPixel(disc.lat, tile.z, px);
        for (var i = 0; i < d.length; i += 4) {
            var index = i / 4;
            var tx = index % px;
            var ty = (index - tx) / px;
            var dLat = rows[ty];
            var dLng = cols[tx];
            var dist = Math.sqrt(dLat * dLat + dLng * dLng);
            if (dist >= disc.radiusM) { d[i + 3] = 0; continue; }
            var left = disc.radiusM - dist;
            if (left < feather) d[i + 3] = ((d[i + 3] * (left / feather)) + 0.5) | 0;
        }
        return frame;
    }

    /**
     * Clip one tile to the disc.
     *
     * Resolves with the tile bytes unchanged when the tile is entirely inside
     * the disc, with `null` when none of it is (the caller draws nothing there),
     * and with repainted PNG bytes only for the tiles the disc's edge crosses —
     * typically a few dozen of the few hundred the disc is made of.
     */
    function maskTile(payload, size, tile, spec) {
        var disc = discOf(spec);
        if (!disc || !tile) return Promise.resolve(payload);
        if (!discTouchesTile(spec, tile.z, tile.x, tile.y)) return Promise.resolve(null);
        if (discContainsTile(spec, tile.z, tile.x, tile.y)) return Promise.resolve(payload);
        return toCanvas(payload, size).then(function (canvas) {
            var ctx = canvas.getContext('2d');
            var frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            maskPixels(frame, canvas.width, tile, spec);
            ctx.putImageData(frame, 0, 0);
            return canvasToBytes(canvas);
        });
    }

    /* A 1×1 fully transparent PNG (68 bytes), for the tiles the disc excludes
     * completely: MapLibre gets a decodable texture instead of a failed
     * request, which is what keeps the terrain under the disc intact. Decoded
     * here rather than with atob() — the headless suites have no DOM. */
    var BLANK_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
    var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var blankTileBytes = null;

    function decodeBase64(text) {
        var clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
        var out = new Uint8Array(Math.floor(clean.length * 3 / 4));
        var buffer = 0, bits = 0, at = 0;
        for (var i = 0; i < clean.length; i += 1) {
            var value = BASE64_ALPHABET.indexOf(clean.charAt(i));
            if (value < 0) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[at] = (buffer >> bits) & 0xff;
                at += 1;
            }
        }
        return at === out.length ? out : out.slice(0, at);
    }

    /** The transparent tile the 3D view draws where the disc excludes a tile. */
    function blankTile() {
        if (!blankTileBytes) blankTileBytes = decodeBase64(BLANK_PNG_BASE64);
        return blankTileBytes.buffer.slice(0);
    }

    function keyOf(layer) { return '2d.' + stamp(layer); }

    /** The mirror's own key for a live layer — the one a dl2d:// template carries. */
    function keyFor(layer) { return keyOf(layer); }

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
        if (/heat/i.test((layer.options && layer.options._kind) || '')) return true;
        /* The Archaeological Potential heatmap is a hand-rolled L.Layer (see
         * heatLayerProto in js/archeo-potential.js): a score raster stretched
         * over the grid's bbox, with no leaflet.heat contract at all. Without
         * this branch classify() falls through to the L.Layer default and the
         * whole layer is reported as having no 3D equivalent. */
        if (layer._raster && typeof layer.setRaster === 'function') return true;
        return false;
    }
    /* A layer that can hand the mirror its own georeferenced picture —
     * `_dl3dImage()` → { url, coordinates } — drapes as an image. The score
     * raster of js/archeo-potential.js uses this: MapLibre has no heatmap that
     * reproduces a score ramp (its density saturates), but a PNG of the very
     * same colourised raster does, pixel for pixel. */
    function hasImageHook(layer) {
        return !!(layer && typeof layer._dl3dImage === 'function');
    }
    function isRotatedOverlay(layer) {
        return layer && layer._rotation != null && layer._img && layer._canvas;
    }

    /* Leaflet renderers (the canvas/SVG a pane draws its paths with) live on the
     * map as layers, but they hold no geometry of their own — their children
     * are the layers the user sees. Reporting them as “no 3D equivalent” told
     * the user about plumbing. */
    function isRenderer(layer) {
        var Leaflet = L();
        return !!(Leaflet && Leaflet.Renderer && layer instanceof Leaflet.Renderer);
    }

    function classify(layer, Leaflet) {
        if (!layer) return 'unsupported';
        /* A layer that paints outside Leaflet's layer tree (the heritage
         * points + 600 m radii are drawn on raw map-pane canvases) can offer
         * its features explicitly; it is mirrored as per-feature vector. */
        if (typeof layer._dl3dFeatures === 'function') return 'vector';
        if (isTileLayer(layer, Leaflet)) return 'raster';
        /* Not an L.TileLayer, but it paints its own tiles (a custom L.Layer with
         * createTile: the country LiDAR canvases, the heritage canvas). */
        if (typeof layer.createTile === 'function') return 'raster';
        if (isMarkerCluster(layer)) return 'cluster';
        if (hasImageHook(layer)) return 'image';
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

    /* ── ground circles ─────────────────────────────────────────────────────
     * L.Circle (unlike L.CircleMarker, which it extends in Leaflet 1.9, so
     * `instanceof Circle` is the discriminator) measures its radius in
     * ground metres. The 32-segment ring uses the same local metric as the
     * per-layer bridges in archeo-potential.js / archeo-report.js
     * (r / 111 320 in latitude, stretched by 1/cos(lat) in longitude), so a
     * circle the mirror projects and a circle a bridge projects coincide. */
    var GROUND_CIRCLE_SEGMENTS = 32;

    function isGroundCircle(layer, Leaflet) {
        if (!layer || !Leaflet || !Leaflet.Circle) return false;
        try {
            return layer instanceof Leaflet.Circle &&
                typeof layer.getLatLng === 'function' &&
                typeof layer.getRadius === 'function';
        } catch (e) { return false; }
    }

    function groundCircleGeoJSON(layer, geojson) {
        var centre = null, radiusM = NaN;
        try {
            centre = layer.getLatLng();
            radiusM = Number(layer.getRadius());
        } catch (e) { return null; }
        if (!centre || !isFinite(centre.lat) || !isFinite(centre.lng) || !(radiusM > 0)) return null;
        var feature = geojson && geojson.type === 'Feature' ? geojson
            : { type: 'Feature', properties: {}, geometry: null };
        var latRad = centre.lat * Math.PI / 180;
        var dLat = radiusM / METRES_PER_DEGREE;
        var dLng = radiusM / (METRES_PER_DEGREE * Math.max(Math.abs(Math.cos(latRad)), 0.2));
        var ring = [];
        for (var i = 0; i < GROUND_CIRCLE_SEGMENTS; i += 1) {
            var a = (i / GROUND_CIRCLE_SEGMENTS) * Math.PI * 2;
            ring.push([centre.lng + Math.sin(a) * dLng, centre.lat + Math.cos(a) * dLat]);
        }
        ring.push(ring[0].slice());
        return {
            type: 'Feature',
            properties: feature.properties || {},
            geometry: { type: 'Polygon', coordinates: [ring] }
        };
    }

    function popupHtml(layer) {
        try {
            var popup = layer.getPopup && layer.getPopup();
            var content = popup ? (popup.getContent ? popup.getContent() : popup._content) : (layer._popupContent || layer.popup || null);
            if (typeof content === 'function') {
                try { content = content(layer); } catch (e) { content = null; }
            }
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
            var content = tooltip ? (tooltip.getContent ? tooltip.getContent() : tooltip._content) : (layer._tooltipContent || layer.tooltip || null);
            if (typeof content === 'function') {
                try { content = content(layer); } catch (e) { content = null; }
            }
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
            var size = opts.iconSize || [24, 24];
            if (typeof size === 'number') size = [size, size];
            var anchor = opts.iconAnchor || [size[0] / 2, size[1] / 2];
            if (typeof anchor === 'number') anchor = [anchor, anchor];
            var spec = {
                iconOffset: [-Math.round(anchor[0] - size[0] / 2), -Math.round(anchor[1] - size[1] / 2)],
                size: [Math.round(size[0]), Math.round(size[1])]
            };
            var url = opts.iconUrl || (opts.icon && opts.icon.src) || null;
            if (url) { spec.url = String(url); return spec; }
            /* L.DivIcon carries no URL: its look is inline HTML. Inline SVG
             * (the DARE Roman-site glyphs) rasterises losslessly as an SVG
             * image, so the 3D pin is the SAME glyph, not a generic dot.
             * A zero-size divIcon (OSM Places: a transparent anchor whose only
             * visible part is its permanent text tooltip) is label-only —
             * drawing a dot for it invents a pin 2D never shows. Any other
             * HTML (emoji/text badges) is kept verbatim for the renderer to
             * draw as a text symbol. */
            var rawHtml = opts.html;
            var html = '';
            if (rawHtml != null) {
                if (typeof rawHtml === 'string') html = rawHtml;
                else if (typeof rawHtml.outerHTML === 'string') html = rawHtml.outerHTML;
                else if (typeof rawHtml.textContent === 'string') html = rawHtml.textContent;
                else html = String(rawHtml);
            }
            if (!html.trim()) {
                if (!spec.size[0] || !spec.size[1]) spec.labelOnly = true;
                return spec.labelOnly ? spec : null;
            }
            var svg = html.match(/<svg[\s\S]*?<\/svg>/i);
            if (svg) {
                var markup = svg[0];
                if (!/xmlns=/i.test(markup)) markup = markup.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
                if (!/\swidth=/i.test(markup)) markup = markup.replace(/<svg/i, '<svg width="' + (spec.size[0] || 26) + '" height="' + (spec.size[1] || 26) + '"');
                spec.url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
                return spec;
            }
            spec.html = html.replace(/<[^>]*>/g, '').trim();
            if (!spec.html) spec.labelOnly = true;
            return spec;
        } catch (e) { return null; }
    }

    function iconHash(text) {
        var h = 5381;
        for (var i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    /* Register an icon spec on a descriptor and return its per-feature id.
     * GeoJSON properties handed to MapLibre must be primitives, so a feature
     * carries only `iconId`; the spec itself travels on item.icons. */
    function registerIcon(item, spec) {
        if (!spec) return '';
        if (spec.labelOnly && !spec.url && !spec.html) return 'label-only';
        var key = String(spec.url || spec.html || '');
        if (!key) return '';
        var id = 'i' + iconHash(key + '|' + (spec.size || []).join('x'));
        item.icons = item.icons || {};
        if (!item.icons[id]) item.icons[id] = spec;
        return id;
    }

    function plainText(value) {
        return String(value == null ? '' : value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function dashArray(value) {
        if (value == null) return null;
        if (typeof value === 'string') {
            var parts = value.split(/[\s,]+/).map(Number).filter(function (v) { return !isNaN(v) && v > 0; });
            return parts.length ? parts : null;
        }
        return null;
    }

    /* ── paint quantisation (merge signature only) ──────────────────────────
       A 2D layer that paints its siblings from a continuous ramp — the
       Archaeological Potential bubbles are coloured by score and sized by the
       packing radius, so no two of them carry the same stroke, fill or radius —
       gives every sibling a different paint. paintSignature() then splits the
       group into one bundle per sibling and the per-group merge budget silently
       throws almost all of them away, which is exactly what "these layers do
       not appear in 3D" looked like.

       The fix quantises the SIGNATURE, never the paint: rounding the mirrored
       colour to 4 levels per channel and the circle radius to a ⅓-octave band
       puts those siblings back into one bundle. Measured on the real ramp
       (js/archeo-potential.js): 100 bubbles → 52 sources, 200 → 103,
       400 → 153, all of them carried, where one source per sibling hit the
       budget at 24 and silently dropped the rest. Battles keeps its six epoch
       colours and its context/zone split (12 sources for 40 events) because
       those are 4 levels apart, not 1-in-255. The bundle still carries the
       exact paint of its first sibling, so an app colour like the LIDAR
       Scanner's #39ff14 is mirrored as #39ff14, not as whatever a rounding
       step produced. */
    var PAINT_STEP = 64;      /* 255 / 4: 4 levels per colour channel  */
    var RADIUS_BAND = 1.4;    /* ~⅓-octave radius bands               */

    function quantiseHex(color) {
        var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || ''));
        if (!m) return color;
        var hex = m[1];
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        var out = '#';
        for (var i = 0; i < 3; i += 1) {
            var c = parseInt(hex.substr(i * 2, 2), 16);
            c = Math.round(c / PAINT_STEP) * PAINT_STEP;
            if (c > 255) c = 255;
            out += (c < 16 ? '0' : '') + c.toString(16);
        }
        return out;
    }

    /* A copy of the paints with the continuous values banded, used only to
     * decide which siblings may share one 3D source. The nested paint sets
     * (line / fill / circle) are copied too: mutating the live ones would
     * change what MapLibre draws. */
    function quantisePaints(paints) {
        if (!paints) return paints;
        var out = {};
        Object.keys(paints).forEach(function (k) {
            var v = paints[k];
            out[k] = (v && typeof v === 'object') ? Object.assign({}, v) : v;
        });
        ['line', 'fill', 'circle'].forEach(function (set) {
            var paint = out[set];
            if (!paint) return;
            ['line-color', 'fill-color', 'circle-color', 'circle-stroke-color'].forEach(function (key) {
                if (typeof paint[key] === 'string') paint[key] = quantiseHex(paint[key]);
            });
            if (paint['circle-radius'] != null) {
                var r = Number(paint['circle-radius']);
                if (r > 0) {
                    var band = Math.round(Math.log(r) / Math.log(RADIUS_BAND));
                    paint['circle-radius'] = Math.round(Math.pow(RADIUS_BAND, band));
                }
            }
        });
        return out;
    }

    /* Leaflet path options → MapLibre paint properties (pixel units match). */
    function pathPaints(layer) {
        var o = layer.options || {};
        var color = o.color || '#3388ff';
        var weight = o.weight == null ? 3 : Number(o.weight);
        var lineOpacity = o.opacity == null ? 1 : Number(o.opacity);
        var fillColor = o.fillColor || color;
        var fillOpacity = o.fill === false ? 0 : (o.fillOpacity == null ? 0.2 : Number(o.fillOpacity));
        /* The country selection wash is 2D navigation chrome, not imagery.
         * Draping its translucent green polygon over terrain tints the whole
         * landscape. Keep the geographic border in 3D, but no interior wash.
         * Work on the mirrored paint only: never mutate the live 2D style,
         * and do not suppress genuine heritage/LiDAR polygon fills. */
        if (o.pane === 'pane_country_bounds') fillOpacity = 0;
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
        /* The mirrored paint is exact: the quantised copy below is only ever
         * used to decide what may be merged, so the app's own colours survive
         * the trip into MapLibre unchanged. */
        return {
            line: line,
            fill: fill,
            circle: circle,
            layout: layout,
            dashed: !!dash
        };
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

    /* The points a heat layer feeds to MapLibre. leaflet.heat keeps its own
     * {lat, lng, alt} list in _latlngs; the app's own raster heatmaps (the
     * Archaeological Potential score raster) keep the grid they were built
     * from instead — rebuild the weighted points from that, one per scored
     * cell, so the 3D heatmap reads the same field the 2D canvas paints. */
    function rasterHeatPoints(raster) {
        var points = [];
        if (!raster || !raster.cols || !raster.rows) return points;
        var cols = Number(raster.cols), rows = Number(raster.rows);
        var bbox = raster.bbox;
        /* Two shapes exist: the Archaeological Potential grid carries an object
         * {minLat, maxLat, minLng, maxLng} (grid.bbox), while the array form
         * [west, south, east, north] is the older contract. Accept both — an
         * unreadable bbox used to drop the whole heatmap from 3D without a word. */
        var west, east, south, north;
        if (Array.isArray(bbox) && bbox.length === 4) {
            west = Math.min(Number(bbox[0]), Number(bbox[2]));
            east = Math.max(Number(bbox[0]), Number(bbox[2]));
            south = Math.min(Number(bbox[1]), Number(bbox[3]));
            north = Math.max(Number(bbox[1]), Number(bbox[3]));
        } else if (bbox && typeof bbox === 'object') {
            west = Number(bbox.minLng); east = Number(bbox.maxLng);
            south = Number(bbox.minLat); north = Number(bbox.maxLat);
        } else {
            return points;
        }
        if (!(east > west) || !(north > south)) return points;
        var base = raster.base, values = raster.values, valid = raster.valid;
        var peak = 0;
        if (values && values.length === rows * cols) {
            for (var i = 0; i < values.length; i += 1) {
                if (valid && !valid[i]) continue;
                if (values[i] > peak) peak = values[i];
            }
        }
        if (!(peak > 0)) peak = 1;
        var cellLng = (east - west) / cols, cellLat = (north - south) / rows;
        for (var row = 0; row < rows; row += 1) {
            for (var col = 0; col < cols; col += 1) {
                var idx = row * cols + col;
                if (valid && !valid[idx]) continue;
                var w = values ? (values[idx] / peak) : (base ? base[idx] : 0);
                if (!(w > 0)) continue;
                points.push({
                    type: 'Feature',
                    properties: { w: w },
                    geometry: {
                        type: 'Point',
                        /* row 0 is the SOUTHERN edge (buildHeatRaster indexes
                         * row 0 at minLat; the 2D picture flips it on draw), so
                         * the points land on the same cells the canvas paints. */
                        coordinates: [
                            west + cellLng * (col + 0.5),
                            south + cellLat * (row + 0.5)
                        ]
                    }
                });
            }
        }
        return points;
    }

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
        if (!points.length && layer._raster) points = rasterHeatPoints(layer._raster);
        var o = layer.options || {};
        var gridStep = (layer._raster && layer._raster.cellM) ? Number(layer._raster.cellM) : 0;
        return {
            geojson: featureCollection(points),
            heat: {
                radius: o.radius == null ? (gridStep > 0 ? Math.max(6, gridStep / 2) : 25) : Number(o.radius),
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

    /**
     * The page language. `window._currentLang` is a FUNCTION installed by
     * js/translations.js (`function () { return currentLang; }`), so reading it
     * as a string — which this used to do — always landed on the English
     * fallback and the Romanian titles of every 3D layer were unreachable.
     */
    function currentLang() {
        try {
            if (typeof root._currentLang === 'function') {
                var v = root._currentLang();
                if (typeof v === 'string' && /^(ro|en)/i.test(v)) return /^en/i.test(v) ? 'en' : 'ro';
            } else if (typeof root._currentLang === 'string' && /^(ro|en)/i.test(root._currentLang)) {
                return /^en/i.test(root._currentLang) ? 'en' : 'ro';
            }
            if (document && document.documentElement && /^en/i.test(document.documentElement.lang || '')) return 'en';
        } catch (e) { /* fall through */ }
        return 'ro';
    }

    /** Title of a registry definition in the current page language. */
    function titleOf(def) {
        if (!def) return '';
        var lang = currentLang();
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
                if (canvas.convertToBlob) {            /* OffscreenCanvas */
                    canvas.convertToBlob({ type: 'image/png' }).then(function (blob) {
                        if (!blob) { reject(new Error('tile canvas produced no PNG')); return; }
                        blob.arrayBuffer().then(resolve, reject);
                    }, reject);
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

    /* ── CSS blend modes, repainted into the pixels ─────────────────────────
     * css/styles.css paints the Romanian 1 m / 2 m LiDAR hillshades with
     * `filter: invert(1); mix-blend-mode: screen`. MapLibre has neither blend
     * modes nor this build's `raster-color`, so a mirrored tile of those layers
     * arrives as the service sent it: an opaque white sheet that hides the
     * terrain — the “LiDAR layers never load in 3D” report.
     *
     * Screen is exactly reproducible in the pixels. Drawing the tile with
     * source alpha `a` and colour `c` over a base `b` gives
     *     (1 − a)·b + a·[1 − (1 − b)·c]                     (screen of invert)
     * and painting white with alpha `a·(1 − c)` gives
     *     (1 − a·(1 − c))·b + a·(1 − c)
     * which is the same value for every `b`. So repainting the tile as white
     * with alpha = 1 − luminance reproduces the 2D look over any base, not just
     * a dark one. Grayscale hillshades — what these services return — come out
     * pixel-exact; only a colourful tile differs, and only where its own
     * channels disagree.
     * ─────────────────────────────────────────────────────────────────────── */

    /** The one blend this code can emulate, applied to RGBA pixels in place. */
    function blendPixels(frame, blend) {
        if (!frame || blend !== 'invert-screen') return frame;
        var d = frame.data || frame;
        for (var i = 0; i < d.length; i += 4) {
            var alpha = d[i + 3];
            /* Rec. 601 luma: the weights CSS's invert()/screen pair behaves
             * like on a gray tile, and within a rounding step on any other. */
            var luma = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
            d[i] = 255;
            d[i + 1] = 255;
            d[i + 2] = 255;
            d[i + 3] = ((alpha * (255 - luma)) + 127) / 255 | 0;
        }
        return frame;
    }

    function newCanvas(width, height) {
        var canvas = null;
        try {
            if (typeof root.OffscreenCanvas === 'function') canvas = new root.OffscreenCanvas(width, height);
        } catch (e) { canvas = null; }
        if (!canvas) {
            var doc = root.document;
            canvas = doc && doc.createElement ? doc.createElement('canvas') : null;
            if (!canvas) return null;
            canvas.width = width;
            canvas.height = height;
        }
        return canvas;
    }

    /** Draw any pixel source (bytes, <img>, ImageBitmap, canvas) into a canvas. */
    function toCanvas(source, size) {
        if (source && typeof source.getContext === 'function') return Promise.resolve(source);
        var fallback = size || 256;
        function draw(image) {
            var width = image.naturalWidth || image.width || fallback;
            var height = image.naturalHeight || image.height || fallback;
            var canvas = newCanvas(width, height);
            if (!canvas) return Promise.reject(new Error('cannot repaint the tile (no canvas)'));
            var ctx = canvas.getContext('2d');
            try { ctx.drawImage(image, 0, 0, width, height); }
            catch (e) { return Promise.reject(e); }
            return canvas;
        }
        if (source && (source.naturalWidth || source.width)) return Promise.resolve(draw(source));
        var bytes = source;
        if (bytes && bytes.data !== undefined) bytes = bytes.data;      /* {data: ArrayBuffer} */
        if (!bytes) return Promise.reject(new Error('no tile pixels to repaint'));
        var blob = null;
        try { blob = new root.Blob([bytes], { type: 'image/png' }); }
        catch (e) { blob = null; }
        if (!blob) return Promise.reject(new Error('cannot repaint the tile (no Blob)'));
        if (typeof root.createImageBitmap === 'function') {
            return root.createImageBitmap(blob).then(draw);
        }
        return new Promise(function (resolve, reject) {
            var url = root.URL && root.URL.createObjectURL ? root.URL.createObjectURL(blob) : '';
            if (!url) { reject(new Error('cannot repaint the tile (no image decoder)')); return; }
            var img = new root.Image();
            img.onload = function () {
                try { root.URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                resolve(draw(img));
            };
            img.onerror = function () {
                try { root.URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                reject(new Error('the tile could not be decoded for repainting'));
            };
            img.src = url;
        });
    }

    /**
     * Repaint one tile for a layer whose 2D look comes from a CSS blend mode.
     * `payload` is what the service sent (ArrayBuffer / typed array), a tile the
     * layer drew (canvas) or an <img>/ImageBitmap. Resolves with PNG bytes.
     */
    function retintTile(payload, size, blend) {
        if (!blend) return Promise.resolve(payload);
        return toCanvas(payload, size).then(function (canvas) {
            var ctx = canvas.getContext('2d');
            var frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
            blendPixels(frame, blend);
            ctx.putImageData(frame, 0, 0);
            return canvasToBytes(canvas);
        });
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
        /* Leaflet's own helpers (L.GridLayer._tileCoordsToBounds, which every
           country module calls from tileUrl) expect an L.Point with the zoom on
           it — a plain {x,y,z} throws “coords.scaleBy is not a function” and
           every tile of that layer came out blank in 3D. */
        var coords = { x: x, y: y, z: z };
        try {
            if (Leaflet && typeof Leaflet.point === 'function') {
                coords = Leaflet.point(x, y);
                coords.z = z;
            }
        } catch (e) { coords = { x: x, y: y, z: z }; }
        return new Promise(function (resolve, reject) {
            var shim = Object.create(layer);
            shim._tileZoom = z;
            shim._tileSize = { x: size, y: size };
            var settled = false;
            /* A canvas tile that declared done() but never called it (a vector
             * renderer whose fetch failed, a plugin that forgot): hand over what
             * has been painted rather than failing the tile — MapLibre draws
             * nothing at all for an errored tile, which is one more way a
             * “prepared” disc shows the base map. */
            var pendingCanvas = null;
            var timer = root.setTimeout(function () {
                if (settled) return;
                if (pendingCanvas) { finish(pendingCanvas); return; }
                settled = true;
                reject(new Error('the 2D layer did not finish drawing this tile in time'));
            }, timeoutMs || 15000);

            function finish(tile) {
                if (settled) return;
                settled = true;
                root.clearTimeout(timer);
                if (!tile) { reject(new Error('the 2D layer produced no tile')); return; }
                try {
                    var blend = blendOf(layer);
                    if (blend) { retintTile(tile, size, blend).then(resolve, reject); return; }
                    if (tile.getContext) { canvasToBytes(tile).then(resolve, reject); return; }
                    imageToBytes(tile, size).then(resolve, reject);
                } catch (e) { reject(e); }
            }

            var tile = null;
            /* Did the layer already call the done() it was handed? A tile can be
             * finished synchronously (from a cache) before createTile returns,
             * and `tile` is only known afterwards. */
            var doneCalled = false;
            try {
                tile = layer.createTile.call(shim, coords, function (error) {
                    if (error) {
                        if (!settled) { settled = true; root.clearTimeout(timer); reject(error); }
                        return;
                    }
                    doneCalled = true;
                    if (tile) finish(tile);
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
                /* A CANVAS TILE IS NOT READY WHEN createTile() RETURNS.
                 *
                 * Leaflet's contract (`L.GridLayer._addTile`) is: a layer whose
                 * createTile() declares the `done` argument owns the moment the
                 * pixels exist and calls back when they do; one declared with a
                 * single argument is ready on the next frame. This function used
                 * to snapshot the canvas on the next frame in BOTH cases, so a
                 * module that fetches and warps its sources first was read before
                 * it had drawn anything. js/dataforsyningen-dhm-layer.js is
                 * exactly that layer: every Danish LiDAR tile comes from a
                 * mosaic of EPSG:25832 View1 tiles, warped cell by cell after
                 * the network answers. 3D therefore prepared a disc of fully
                 * transparent tiles — the dialog counted ~200 tiles, the disc
                 * was empty and only the base map showed. Coarse tiles whose
                 * sources happened to be in the layer's source cache were
                 * painted within a microtask (before the snap-back timer) and
                 * did show, which is why the LiDAR appeared only at some zoom
                 * levels and vanished when the user zoomed in. Wait for done()
                 * here; the single-argument case keeps Leaflet's next-frame
                 * rule, and the timer above still bounds a layer that never
                 * calls back. */
                if (layer.createTile.length < 2) {
                    root.setTimeout(function () { if (!settled) finish(tile); }, 0);
                } else if (doneCalled) {
                    finish(tile);
                } else {
                    pendingCanvas = tile;
                }
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
        var lidar = lidarTag(layer, def);
        var base = {
            key: keyOf(layer),
            kind: kind,
            z: paneZIndex(map, layer),
            pane: pane,
            opacity: opacityOf(layer),
            defId: def ? def.id : null,
            /* The LiDAR family this layer belongs to, or null: the 3D view
             * drapes at most ONE of them and only inside the focus disc. */
            lidarKey: lidar ? lidar.key : null,
            lidarLabel: lidar ? lidar.label : '',
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
                blend: blendOf(layer),
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

        if (kind === 'image' && hasImageHook(layer)) {
            var picture = null;
            try { picture = layer._dl3dImage(); } catch (e) { picture = null; }
            if (!picture || !picture.url || !picture.coordinates) return null;
            return Object.assign(base, {
                url: String(picture.url),
                coordinates: picture.coordinates,
                label: base.label || 'image overlay'
            });
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
                        feat.properties.label = plainText(feat.properties.tooltip);
                        var cIcon = registerIcon(base, iconOf(child));
                        if (cIcon === 'label-only') feat.properties.noDot = 1;
                        else if (cIcon) feat.properties.iconId = cIcon;
                        delete feat.properties.icon;
                        clusterFeatures.push(feat);
                    });
                });
            } catch (e) { /* ignore */ }
            if (!clusterFeatures.length) return null;
            var co = layer.options || {};
            return Object.assign(base, {
                geojson: featureCollection(clusterFeatures),
                icons: base.icons || {},
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
            var tooltip = tooltipText(layer);
            geometry.properties = Object.assign({}, geometry.properties, {
                popup: popupHtml(layer),
                tooltip: tooltip,
                label: plainText(tooltip),
                z: base.z
            });
            var mIcon = registerIcon(base, iconOf(layer));
            if (mIcon === 'label-only') geometry.properties.noDot = 1;
            else if (mIcon) geometry.properties.iconId = mIcon;
            delete geometry.properties.icon;
            return Object.assign(base, {
                geojson: featureCollection([geometry]),
                icons: base.icons || {},
                label: base.label || 'markers'
            });
        }

        if (kind === 'vector') {
            /* Virtual vector (heritage canvases): features + per-feature paint
             * come from the layer itself; no Leaflet geometry exists. */
            if (typeof layer._dl3dFeatures === 'function') {
                var virt = null;
                try { virt = layer._dl3dFeatures(); } catch (e) { virt = null; }
                if (!virt || !virt.geojson || !(virt.geojson.features || []).length) return null;
                return Object.assign(base, {
                    geojson: virt.geojson,
                    types: geometryTypes(virt.geojson),
                    paints: virt.paints || pathPaints(layer),
                    icons: virt.icons || {},
                    perFeature: true,
                    stamp: virt.stamp || '',
                    popup: '',
                    tooltip: '',
                    label: base.label || virt.label || 'vector'
                });
            }
            var gj = geometryOf(layer);
            if (!gj) return null;
            /* An L.Circle is a GROUND circle: its radius is in metres, but
             * Leaflet's toGeoJSON() returns only the centre Point, so a
             * mirrored circle used to reach MapLibre as a Point whose
             * `circle-radius` was the metre value read as PIXELS — a 100 m
             * scanner ring became a 100 px disc that never scaled with the
             * ground, and a 5 km analysis search circle became a 5 000 px
             * disc that tinted the whole 3D view in its fill colour (the
             * Archaeological Potential purple wash and the LiDAR Scanner
             * points that “do not show appropriately” in 3D). Project the
             * circle to a ground polygon, exactly like the per-layer 3D
             * bridges do, so every present and future L.circle drapes at
             * its true size. L.CircleMarker is deliberately excluded: its
             * radius really is pixels, so its Point + circle paint is the
             * faithful mirror. Layers that offer `_dl3dFeatures()` were
             * already returned above and never reach this branch. */
            var convertedCircle = false;
            if (isGroundCircle(layer, Leaflet)) {
                var ground = groundCircleGeoJSON(layer, gj);
                if (ground) { gj = ground; convertedCircle = true; }
            }
            var paints = pathPaints(layer);
            if (convertedCircle) {
                /* The geometry is a ground polygon now, so the circle paint
                 * built from the metre radius (`circle-radius: 5000`) is a
                 * dead, misleading value: drop it back to a plain dot size
                 * in case the same source ever carries a real point. */
                paints.circle = Object.assign({}, paints.circle, { 'circle-radius': 5 });
            }
            var fc = gj.type === 'FeatureCollection' ? gj : featureCollection([gj]);
            /* An L.GeoJSON built with pointToLayer (DARE sites) holds real
             * L.Markers: toGeoJSON() keeps the point but drops the marker's
             * divIcon/popup. Re-attach them per feature (matched by position)
             * so 3D draws the category glyph, not a generic circle. */
            try {
                var Leaflet2 = Leaflet;
                if (Leaflet2.Marker && typeof layer.eachLayer === 'function') {
                    var byPos = {};
                    (fc.features || []).forEach(function (f) {
                        if (f && f.geometry && f.geometry.type === 'Point') {
                            var c = f.geometry.coordinates;
                            byPos[c[0].toFixed(6) + ',' + c[1].toFixed(6)] = f;
                        }
                    });
                    layer.eachLayer(function (child) {
                        if (!(child instanceof Leaflet2.Marker) || typeof child.getLatLng !== 'function') return;
                        var ll = child.getLatLng();
                        var f = byPos[ll.lng.toFixed(6) + ',' + ll.lat.toFixed(6)];
                        if (!f) return;
                        f.properties = f.properties || {};
                        if (!f.properties.popup) f.properties.popup = popupHtml(child);
                        if (!f.properties.tooltip) f.properties.tooltip = tooltipText(child);
                        if (!f.properties.label) f.properties.label = plainText(f.properties.tooltip);
                        var vIcon = registerIcon(base, iconOf(child));
                        if (vIcon === 'label-only') f.properties.noDot = 1;
                        else if (vIcon) f.properties.iconId = vIcon;
                    });
                }
            } catch (e) { /* plain vector geometry still mirrors */ }
            var layerPopup = popupHtml(layer);
            var layerTooltip = tooltipText(layer);
            var layerLabel = plainText(layerTooltip);
            if (layerPopup || layerTooltip || layerLabel) {
                (fc.features || []).forEach(function (f) {
                    if (!f) return;
                    f.properties = f.properties || {};
                    if (layerPopup && !f.properties.popup) f.properties.popup = layerPopup;
                    if (layerTooltip && !f.properties.tooltip) f.properties.tooltip = layerTooltip;
                    if (layerLabel && !f.properties.label) f.properties.label = layerLabel;
                });
            }
            return Object.assign(base, {
                geojson: fc,
                types: geometryTypes(gj),
                paints: paints,
                icons: base.icons || {},
                popup: layerPopup,
                tooltip: layerTooltip,
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

    /* ── merging siblings ───────────────────────────────────────────────────
       Items that draw identically are concatenated into one GeoJSON feature
       collection, so a group of N polylines becomes a handful of 3D sources
       instead of N of them. Content stays identical: same features, same paint,
       same order. */
    function paintSignature(item) {
        return JSON.stringify({
            kind: item.kind,
            z: item.z,
            pane: item.pane,
            opacity: item.opacity,
            paints: quantisePaints(item.paints),
            types: item.types || null,
            perFeature: !!item.perFeature
        });
    }

    function canMerge(bundle, item) {
        if (bundle.kind !== item.kind) return false;
        if (bundle.sig !== paintSignature(item)) return false;
        if ((bundle.geojson.features || []).length + (item.geojson && item.geojson.features || []).length
                > MAX_BUNDLE_FEATURES) return false;
        return true;
    }

    function bundleSiblings(items, parent, key) {
        var out = [];
        var bundles = 0;
        var dropped = 0;
        var bySig = {};      /* signature -> the bundle that carries it */
        items.forEach(function (item) {
            var mergeable = item.kind === 'vector' || item.kind === 'markers' || item.kind === 'heat';
            if (!mergeable || !item.geojson) {
                out.push(item);
                return;
            }
            var sig = paintSignature(item);
            var open = bySig[sig];
            if (open && canMerge(open, item)) {
                var features = item.geojson.type === 'FeatureCollection' ? item.geojson.features : [item.geojson];
                (features || []).forEach(function (f) { open.geojson.features.push(f); });
                if (item.icons) { open.icons = open.icons || {}; Object.keys(item.icons).forEach(function (k) { open.icons[k] = item.icons[k]; }); }
                open.count += (features || []).length;
                return;
            }
            if (bundles >= MAX_BUNDLES_PER_GROUP) { dropped += 1; return; }
            bundles += 1;
            var first = item.geojson.type === 'FeatureCollection' ? item.geojson.features : [item.geojson];
            var fresh = Object.assign({}, item, {
                key: (key || keyOf(parent)) + '/b' + bundles,
                layer: parent || item.layer || null,
                geojson: featureCollection((first || []).slice()),
                icons: item.icons ? Object.assign({}, item.icons) : {},
                count: (first || []).length,
                sig: sig,
                bundled: true
            });
            bySig[sig] = fresh;
            out.push(fresh);
        });
        /* The label of a bundle says how much of the group it carries, so the
           3D status panel is honest about what was merged. */
        out.forEach(function (item) {
            if (!item.bundled || item.count == null) return;
            if (item.count === 1) return;
            item.label = (item.label || 'layer') + ' (' + item.count.toLocaleString() + ' features)';
        });
        return { items: out, dropped: dropped };
    }

    /**
     * Walk a group, with the merged result cached on the group.
     *
     * The 3D view re-collects the whole 2D map every 1.5 s; describing 100 000
     * polylines on every pass is what made the page unusable while the Roman
     * roads were on, even after the fixes to the deck itself. The cache is
     * keyed by the group's own child count, its pane and the paint of its first
     * child (the opacity slider rewrites every child's style, so a change is
     * visible there), and any caller that knows better can drop it with
     * DetectLabMirror.invalidate(layer).
     */
    /* The paint of one child, cheaply — the opacity slider rewrites every
       child's style without changing the child count, so this is what makes the
       cached bundle notice. */
    function styleStamp(child) {
        var o = (child && child.options) || {};
        var icon = o.icon && o.icon.options;
        return [o.color, o.weight, o.opacity, o.fillColor, o.fillOpacity, o.fill, o.radius,
            o.dashArray, o.lineCap, o.lineJoin, icon && (icon.iconUrl || icon.html)]
            .join(',');
    }

    function walkGroup(map, layer, out, depth) {
        var childrenLength = 0, first = null, last = null;
        try {
            var children = layer.getLayers ? layer.getLayers() : null;
            childrenLength = children ? children.length : 0;
            if (childrenLength) { first = children[0]; last = children[childrenLength - 1]; }
        } catch (e) { childrenLength = 0; }

        var cache = layer._dlMirrorBundle;
        /* NB: not named `stamp` — that is the id helper above. */
        var cacheKey = [
            childrenLength,
            first ? stamp(first) : '',
            last ? stamp(last) : '',
            paneZIndex(map, layer),
            opacityOf(layer),
            styleStamp(first)
        ].join('|');
        if (cache && cache.stamp === cacheKey && cache.depth === depth) {
            cache.items.forEach(function (item) { out.push(item); });
            return cache.dropped || 0;
        }

        var collected = [];
        try {
            layer.eachLayer(function (child) { walk(map, child, collected, depth + 1); });
        } catch (e) { /* ignore */ }
        var bundled = bundleSiblings(collected, layer, keyOf(layer));
        layer._dlMirrorBundle = { stamp: cacheKey, depth: depth, items: bundled.items, dropped: bundled.dropped };
        bundled.items.forEach(function (item) { out.push(item); });
        return bundled.dropped;
    }

    function walk(map, layer, out, depth) {
        if (!layer || depth > 4) return;
        /* `_dl3dSkip`: the layer is drawn in 2D by a group that also offers its
         * features through `_dl3dFeatures()` (the Archaeological Potential bubbles
         * and red mask). Leaflet puts a LayerGroup's children on the map as well
         * as in the group, so without this every bubble was mirrored twice and
         * the 400-item deck budget ran out before the heatmap and the mask. */
        if (layer._dl3dSkip || isRenderer(layer)) return;
        var Leaflet = L();
        var kind = classify(layer, Leaflet);
        if (kind === 'group') {
            /* The dropped count must travel back: it is what tells the user that
             * the 3D deck could not carry every sibling of this group. */
            return walkGroup(map, layer, out, depth);
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

    /* What the budget had to leave out, as human-readable lines: shown by the
     * 3D status panel and quoted by the support report. */
    var lastCapped = [];

    function collect(map) {
        if (!map || typeof map.eachLayer !== 'function') {
            return { items: [], unsupported: [], capped: [], signature: '', byKey: {} };
        }
        var items = [];
        var unsupported = [];
        var capped = [];
        var droppedChildren = 0;
        var skippedLayers = 0;
        byKey = {};
        map.eachLayer(function (layer) {
            if (layer && (layer._dl3dSkip || isRenderer(layer))) return;   /* owned by a virtual 3D layer, or plumbing */
            /* A map with thousands of *top-level* layers (no group to merge
             * within) would otherwise be described in full before the deck
             * budget could drop it — the work, not just the deck, has to be
             * bounded. */
            if (items.length > MAX_ITEMS * 4) { skippedLayers += 1; return; }
            var before = items.length;
            try { droppedChildren += walk(map, layer, items, 0) || 0; }
            catch (e) { failures[keyOf(layer)] = String((e && e.message) || e); }
            if (items.length === before) {
                var d = safeDescribe(map, layer);
                if (d && d.kind === 'unsupported') {
                    var line = (d.label || 'layer') + ' — ' + (d.reason || '');
                    if (unsupported.indexOf(line) === -1) unsupported.push(line);
                }
            }
        });
        if (droppedChildren > 0) {
            capped.push(droppedChildren.toLocaleString() + ' sibling layer(s) beyond the 3D merge budget were ' +
                'left out of the 3D view (they stay on the 2D map)');
        }
        if (skippedLayers > 0) {
            capped.push(skippedLayers.toLocaleString() + ' further 2D layer(s) were not even examined: the 3D ' +
                'deck budget of ' + MAX_ITEMS + ' was already full');
        }
        if (items.length > MAX_ITEMS) {
            capped.push((items.length - MAX_ITEMS).toLocaleString() + ' mirrored layer(s) beyond the 3D deck ' +
                'budget of ' + MAX_ITEMS + ' were left out of the 3D view');
            items = items.slice(0, MAX_ITEMS);
        }
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
        lastCapped = capped;
        return {
            items: items,
            unsupported: unsupported.concat(capped),
            capped: capped,
            signature: signatureOf(items) + '|' + unsupported.join(',') + '|' + capped.join(','),
            byKey: byKey
        };
    }

    /* A cheap fingerprint: id · kind · order · opacity · content size. */
    function signatureOf(items) {
        return items.map(function (i) {
            var size = 0;
            if (i.geojson) size = (i.geojson.features || []).length;
            if (i.kind === 'image') size = String(i.url).length;
            return [i.kind, i.key, i.z, Math.round((i.opacity == null ? 1 : i.opacity) * 100), size, i.stamp || ''].join(':');
        }).join('|');
    }

    function isRotated(layer) { return isRotatedOverlay(layer); }

    /* Drop the merged cache of a group (and of its parents) after changing its
       children without touching the count — a style rewrite of every child is
       picked up by the paint stamp, an in-place geometry swap is not. */
    function invalidate(layer) {
        var node = layer;
        var guard = 0;
        while (node && guard < 8) {
            if (node._dlMirrorBundle) node._dlMirrorBundle = null;
            node = node._group || node._parentGroup || null;
            guard += 1;
        }
        return true;
    }

    root.DetectLabMirror = {
        VERSION: VERSION,
        collect: collect,
        describe: describe,
        classify: classify,
        tileUrlFor: tileUrlFor,
        templateFor: templateFor,
        layerByKey: layerByKey,
        keyFor: keyFor,
        lidarKeyOf: lidarKeyOf,
        /** The LiDAR focus disc: geometry, planning helpers and the pixel clip. */
        disc: {
            of: discOf,
            bounds: discBounds,
            ring: discRing,
            geojson: discGeojson,
            tileWindow: discTileWindow,
            touchesTile: discTouchesTile,
            containsTile: discContainsTile,
            maskPixels: maskPixels,
            maskTile: maskTile,
            blankTile: blankTile,
            metresPerTile: groundMetresPerTile,
            metresPerPixel: groundMetresPerPixel,
            distanceM: distanceM,
            tileBounds: tileBounds,
            latAt: latAt,
            lngAt: lngAt,
            latToTileY: latToTileY,
            lngToTileX: lngToTileX
        },
        paneZIndex: paneZIndex,
        paneNameOf: paneNameOf,
        signatureOf: signatureOf,
        isRotated: isRotated,
        errors: function () { return Object.assign({}, failures); },
        renderTile: renderTile,
        retintTile: retintTile,
        blendPixels: blendPixels,
        invalidate: invalidate,
        blendOf: blendOf,
        capped: function () { return lastCapped.slice(); },
        BUDGET: {
            maxBundleFeatures: MAX_BUNDLE_FEATURES,
            maxBundlesPerGroup: MAX_BUNDLES_PER_GROUP,
            maxItems: MAX_ITEMS
        },
        PANE_Z: PANE_Z
    };
}(typeof window !== 'undefined' && window ? window
    : typeof self !== 'undefined' && self ? self
        : typeof globalThis !== 'undefined' && globalThis ? globalThis : this));
