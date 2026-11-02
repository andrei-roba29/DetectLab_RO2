/*!
 * DetectLab — APM continuous score texture + geographically projected Leaflet canvas tiles.
 * No point-density heat kernel: colour represents the model score at each raster location.
 * The worker downsamples display pixels only; hotspot contours keep the original resolution.
 *
 * Exclusion mask values (see computeArcheoExclusionMask): 0 = scoreable, 2 = known-site
 * protection zone on verified free land (never a result, but coloured so the heat stays
 * continuous), any other non-zero value = hidden (transparent) in the heatmap.
 */
(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmHeatmap = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    function stops(thresholds) {
        return [
            { value: 0, colour: [36, 59, 123] },
            { value: thresholds.medium, colour: [53, 198, 180] },
            { value: thresholds.high, colour: [255, 200, 87] },
            { value: thresholds.veryhigh, colour: [255, 99, 61] },
            { value: 1, colour: [168, 25, 53] }
        ];
    }
    function colourAt(value, ramp) {
        var s = Math.max(0, Math.min(1, value)), k = 0;
        while (k < ramp.length - 2 && s >= ramp[k + 1].value) k++;
        var a = ramp[k], b = ramp[k + 1];
        var f = b.value > a.value ? Math.max(0, Math.min(1, (s - a.value) / (b.value - a.value))) : 1;
        return a.colour.map(function (c, i) { return Math.round(c + (b.colour[i] - c) * f); });
    }

    /** True when an exclusion value must be transparent in the heatmap. */
    function hiddenCell(mask, i) {
        var e = mask[i];
        return !!e && e !== 2;
    }

    /** Bounded RGBA display raster. Invalid/negative scores are transparent, zero is valid.
     * Area-average each display block, with coverage alpha for masked edges. No per-run stretching.
     */
    function buildRaster(score, grid, thresholds, maxDimension, exclusionMask) {
        var scale = Math.min(1, (maxDimension || 512) / Math.max(grid.w, grid.h));
        var w = Math.max(1, Math.round(grid.w * scale)), h = Math.max(1, Math.round(grid.h * scale));
        var rgba = new Uint8Array(w * h * 4), ramp = stops(thresholds);
        for (var y = 0; y < h; y++) {
            var y0 = Math.floor(y * grid.h / h), y1 = Math.floor((y + 1) * grid.h / h);
            for (var x = 0; x < w; x++) {
                var x0 = Math.floor(x * grid.w / w), x1 = Math.floor((x + 1) * grid.w / w);
                var sum = 0, valid = 0;
                for (var j = y0; j < y1; j++) for (var i = x0; i < x1; i++) {
                    var sourceIndex = j * grid.w + i;
                    // Exclusions apply to source cells, not to the entire display block.
                    // Blocking the whole block whenever it contains one excluded source cell
                    // can erase almost the complete heatmap when the raster is downsampled.
                    if (exclusionMask && hiddenCell(exclusionMask, sourceIndex)) continue;
                    var v = score[sourceIndex];
                    if (Number.isFinite(v) && v >= 0) { sum += v; valid++; }
                }
                if (!valid) continue;
                var colour = colourAt(sum / valid, ramp), offset = 4 * (y * w + x);
                rgba[offset] = colour[0]; rgba[offset + 1] = colour[1]; rgba[offset + 2] = colour[2];
                rgba[offset + 3] = Math.round(180 * valid / ((y1 - y0) * (x1 - x0)));
            }
        }
        return { w: w, h: h, west: grid.west, north: grid.north,
            dLon: grid.dLon * grid.w / w, dLat: grid.dLat * grid.h / h,
            rgba: rgba, thresholds: thresholds, ramp: ramp, aggregation: 'mean-score / valid-coverage alpha',
            exclusionMask: exclusionMask || null,
            sourceWidth: grid.w, sourceHeight: grid.h };
    }

    /** Bilinear, premultiplied-alpha texture lookup. Never extrapolates beyond the analysis grid. */
    function sampleRGBA(raster, lon, lat, out, offset) {
        var u = (lon - raster.west) / raster.dLon, v = (raster.north - lat) / raster.dLat;
        if (u < 0 || v < 0 || u >= raster.w || v >= raster.h) return;
        // Bilinear texture filtering must not colour a forbidden source cell.
        if (raster.exclusionMask) {
            var sx = Math.floor(u * raster.sourceWidth / raster.w);
            var sy = Math.floor(v * raster.sourceHeight / raster.h);
            if (hiddenCell(raster.exclusionMask, sy * raster.sourceWidth + sx)) return;
        }
        var fx = Math.max(0, Math.min(raster.w - 1, u - 0.5));
        var fy = Math.max(0, Math.min(raster.h - 1, v - 0.5));
        var x0 = Math.floor(fx), y0 = Math.floor(fy), dx = fx - x0, dy = fy - y0;
        var red = 0, green = 0, blue = 0, alpha = 0;
        for (var j = 0; j <= 1; j++) for (var i = 0; i <= 1; i++) {
            var x = Math.min(raster.w - 1, x0 + i), y = Math.min(raster.h - 1, y0 + j);
            var p = 4 * (y * raster.w + x), weight = (i ? dx : 1 - dx) * (j ? dy : 1 - dy);
            var a = raster.rgba[p + 3] * weight;
            alpha += a; red += raster.rgba[p] * a; green += raster.rgba[p + 1] * a; blue += raster.rgba[p + 2] * a;
        }
        if (!alpha) return;
        out[offset] = Math.round(red / alpha); out[offset + 1] = Math.round(green / alpha);
        out[offset + 2] = Math.round(blue / alpha); out[offset + 3] = Math.round(alpha);
    }

    /* ── Web Mercator display texture ───────────────────────────────────── */

    var TEXTURE_MIN = 256, TEXTURE_MAX = 1024;

    function mercatorY(lat) {
        var r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    }
    function latFromMercatorY(y) {
        var n = Math.PI - 2 * Math.PI * y;
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }

    /** Resample the geographic display raster ONCE into a texture whose rows are
     * evenly spaced in Web Mercator (normalised 0..1 world units). A Leaflet tile is
     * then an affine sub-rectangle of this texture: one drawImage per tile, no
     * per-pixel JavaScript on the main thread. Every texel is produced by
     * sampleRGBA, so the source-resolution exclusion mask is honoured exactly at
     * texel centres. Runs in the worker. */
    function buildMercatorTexture(raster, maxDimension) {
        var max = maxDimension || TEXTURE_MAX;
        var west = raster.west, east = raster.west + raster.w * raster.dLon;
        var north = raster.north, south = raster.north - raster.h * raster.dLat;
        var x0 = (west + 180) / 360, x1 = (east + 180) / 360;
        var y0 = mercatorY(north), y1 = mercatorY(south);
        var base = Math.max(raster.w, raster.sourceWidth || 0, raster.h, raster.sourceHeight || 0);
        var longest = Math.max(TEXTURE_MIN, Math.min(max, base));
        var spanX = Math.max(1e-12, x1 - x0), spanY = Math.max(1e-12, y1 - y0);
        var w, h;
        if (spanX >= spanY) { w = longest; h = Math.max(1, Math.min(max, Math.round(longest * spanY / spanX))); }
        else { h = longest; w = Math.max(1, Math.min(max, Math.round(longest * spanX / spanY))); }
        var rgba = new Uint8Array(w * h * 4), lons = new Float64Array(w), u, v;
        for (u = 0; u < w; u++) lons[u] = west + (u + 0.5) / w * (east - west);
        for (v = 0; v < h; v++) {
            var lat = latFromMercatorY(y0 + (v + 0.5) / h * spanY), row = 4 * v * w;
            for (u = 0; u < w; u++) sampleRGBA(raster, lons[u], lat, rgba, row + 4 * u);
        }
        return { w: w, h: h, west: west, east: east, north: north, south: south,
            x0: x0, x1: x1, y0: y0, y1: y1, rgba: rgba };
    }

    /** Nearest-texel lookup in a Mercator texture (tests/diagnostics). */
    function sampleTexture(texture, lon, lat, out, offset) {
        var u = Math.floor(((lon + 180) / 360 - texture.x0) / (texture.x1 - texture.x0) * texture.w);
        var v = Math.floor((mercatorY(lat) - texture.y0) / (texture.y1 - texture.y0) * texture.h);
        if (u < 0 || v < 0 || u >= texture.w || v >= texture.h) return false;
        var p = 4 * (v * texture.w + u);
        for (var k = 0; k < 4; k++) out[(offset || 0) + k] = texture.rgba[p + k];
        return true;
    }

    /** Geographic centre of texel (u, v) — lets tests check the mask contract exactly. */
    function texelCentre(texture, u, v) {
        return { lon: texture.west + (u + 0.5) / texture.w * (texture.east - texture.west),
            lat: latFromMercatorY(texture.y0 + (v + 0.5) / texture.h * (texture.y1 - texture.y0)) };
    }

    /** What the worker sends to the main thread: the display raster metadata and
     * RGBA plus the Mercator texture — but not the full-resolution exclusion mask
     * (up to 1 M cells), which the texture already encodes. */
    function displayPayload(raster, texture) {
        var out = {};
        Object.keys(raster).forEach(function (k) { if (k !== 'exclusionMask') out[k] = raster[k]; });
        out.texture = texture;
        return out;
    }

    /** Canvas tiles. With a Mercator texture (worker output) each tile is a single
     * affine drawImage from one shared bitmap: cheap enough to stay smooth while
     * pinch-zooming on phones. Without one (legacy callers) each tile pixel is
     * projected back to lon/lat and sampled. Unlike imageOverlay both paths align
     * with Web Mercator at any latitude. Tile canvases are discarded on removal.
     */
    function createLayer(raster, L, options) {
        var texture = raster.texture && raster.texture.rgba ? raster.texture : null;
        /* The 3D picture is encoded once per result (see _dl3dImage below). */
        var drapedUrl;
        var HeatLayer = L.GridLayer.extend({
            onRemove: function (map) {
                L.GridLayer.prototype.onRemove.call(this, map);
                if (this._apmBitmap && typeof this._apmBitmap.close === 'function') this._apmBitmap.close();
                this._apmBitmap = null; this._apmSource = null; this._apmBitmapPending = false;
            },
            _apmTextureSource: function () {
                if (this._apmBitmap) return this._apmBitmap;
                if (!this._apmSource) {
                    var canvas = L.DomUtil.create('canvas');
                    canvas.width = texture.w; canvas.height = texture.h;
                    var ctx = canvas.getContext('2d'), image = ctx.createImageData(texture.w, texture.h);
                    image.data.set(texture.rgba);
                    ctx.putImageData(image, 0, 0);
                    this._apmSource = canvas;
                }
                // An immutable ImageBitmap can stay resident on the GPU, so later
                // tiles do not re-upload the texture. Until it resolves the canvas
                // is used directly.
                if (!this._apmBitmapPending && typeof createImageBitmap === 'function') {
                    var self = this;
                    this._apmBitmapPending = true;
                    createImageBitmap(this._apmSource).then(function (bitmap) {
                        if (self._apmSource) self._apmBitmap = bitmap;
                        else if (bitmap && bitmap.close) bitmap.close();
                    }).catch(function () { /* keep the canvas source */ });
                }
                return this._apmSource;
            },
            createTile: function (coords) {
                var size = this.getTileSize(), tile = L.DomUtil.create('canvas', 'apm-heatmap-tile');
                tile.width = size.x; tile.height = size.y;
                tile.setAttribute('role', 'presentation');
                var context = tile.getContext('2d');
                if (texture) {
                    var worldX = size.x * Math.pow(2, coords.z), worldY = size.y * Math.pow(2, coords.z);
                    context.imageSmoothingEnabled = true;
                    if ('imageSmoothingQuality' in context) context.imageSmoothingQuality = 'medium';
                    context.setTransform((texture.x1 - texture.x0) * worldX / texture.w, 0, 0,
                        (texture.y1 - texture.y0) * worldY / texture.h,
                        texture.x0 * worldX - coords.x * size.x, texture.y0 * worldY - coords.y * size.y);
                    context.drawImage(this._apmTextureSource(), 0, 0);
                    return tile;
                }
                var image = context.createImageData(size.x, size.y);
                var map = this._map, lons = [], lats = [], x, y;
                for (x = 0; x < size.x; x++) lons[x] = map.unproject(L.point(coords.x * size.x + x + 0.5, coords.y * size.y), coords.z).lng;
                for (y = 0; y < size.y; y++) lats[y] = map.unproject(L.point(coords.x * size.x, coords.y * size.y + y + 0.5), coords.z).lat;
                for (y = 0; y < size.y; y++) for (x = 0; x < size.x; x++) {
                    sampleRGBA(raster, lons[x], lats[y], image.data, 4 * (y * size.x + x));
                }
                context.putImageData(image, 0, 0);
                return tile;
            },

            /* ── 3D view (js/map3d-mirror.js → MapLibre) ─────────────────────
             * The final heatmap is draped over the 3D base map / terrain as ONE
             * georeferenced picture, not repainted tile by tile.
             *
             * WHY: the mirror would otherwise treat this custom L.GridLayer as a
             * canvas tile source and re-run createTile() for every 3D tile at
             * every zoom. That rebuilds a 1024² canvas (and a new ImageBitmap)
             * per tile on the main thread — the exact work that made zooming
             * over a result stutter on Android — and it is unnecessary: the
             * Web-Mercator texture this layer already holds IS the finished
             * picture. Encoded once as a PNG, the mirror's image contract drapes
             * it over the terrain with the colours and per-cell alpha of the 2D
             * heatmap.
             *
             * Coordinates are [NW, NE, SE, SW] taken from the texture's own
             * Web-Mercator rectangle (x0..x1, y0..y1), converted back to
             * latitude, so every texel lands on the same lon/lat it has in 2D.
             * The texture is only produced by the worker; the geographic raster
             * is the fallback for callers that pass a bare display raster. That
             * fallback stretches rows evenly in latitude (the legacy 2D
             * image-overlay path), which is slightly off in Mercator but never
             * empty.
             */
            _dlApmHeat: true,
            /* Opacity of the APM panel slider. The 2D view applies it to the
             * result panes; this is the same value for the 3D deck (the mirror's
             * opacityOf() reads it), so both views fade together. */
            _dl3dOpacity: 1,
            _dl3dImage: function () {
                var width, height, west, east, north, south, rgba;
                if (texture) {
                    width = texture.w; height = texture.h;
                    west = texture.west; east = texture.east;
                    north = latFromMercatorY(texture.y0); south = latFromMercatorY(texture.y1);
                    rgba = texture.rgba;
                } else {
                    width = raster.w; height = raster.h;
                    west = raster.west; east = raster.west + raster.w * raster.dLon;
                    north = raster.north; south = raster.north - raster.h * raster.dLat;
                    rgba = raster.rgba;
                }
                if (!(width > 0) || !(height > 0) || !rgba || rgba.length !== width * height * 4) return null;
                if (drapedUrl === undefined) {
                    drapedUrl = null;
                    try {
                        var doc = (root && root.document) || null;
                        var canvas = doc && typeof doc.createElement === 'function' ? doc.createElement('canvas') : null;
                        var context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
                        if (canvas && context && typeof context.createImageData === 'function' &&
                                typeof canvas.toDataURL === 'function') {
                            canvas.width = width; canvas.height = height;
                            var frame = context.createImageData(width, height);
                            frame.data.set(rgba);
                            context.putImageData(frame, 0, 0);
                            drapedUrl = canvas.toDataURL('image/png');
                            /* Release the pixels the moment they are encoded. */
                            canvas.width = 0; canvas.height = 0;
                        }
                    } catch (e) { drapedUrl = null; }
                }
                if (!drapedUrl) return null;
                var opacity = typeof this._dl3dOpacity === 'number' ? this._dl3dOpacity : 1;
                return {
                    url: drapedUrl,
                    coordinates: [[west, north], [east, north], [east, south], [west, south]],
                    opacity: Math.max(0, Math.min(1, opacity)),
                    label: 'APM heatmap'
                };
            }
        });
        return new HeatLayer(Object.assign({ tileSize: 256, updateWhenIdle: true, updateWhenZooming: false,
            keepBuffer: 1, opacity: 1,
            bounds: L.latLngBounds([raster.north - raster.h * raster.dLat, raster.west],
                [raster.north, raster.west + raster.w * raster.dLon]) }, options));
    }
    return { stops: stops, colourAt: colourAt, buildRaster: buildRaster, sampleRGBA: sampleRGBA,
        hiddenCell: hiddenCell, buildMercatorTexture: buildMercatorTexture, sampleTexture: sampleTexture,
        texelCentre: texelCentre, displayPayload: displayPayload, mercatorY: mercatorY,
        latFromMercatorY: latFromMercatorY, createLayer: createLayer };
});
