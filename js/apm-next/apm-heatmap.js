/*!
 * DetectLab — APM continuous score texture + geographically projected Leaflet canvas tiles.
 * No point-density heat kernel: colour represents the model score at each raster location.
 * The worker downsamples display pixels only; hotspot contours keep the original resolution.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmHeatmap = api;
})(typeof self !== 'undefined' ? self : this, function () {
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
                    if (exclusionMask && exclusionMask[sourceIndex]) continue;
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
            if (raster.exclusionMask[sy * raster.sourceWidth + sx]) return;
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

    /** Canvas tiles project each map pixel back to lon/lat: unlike imageOverlay this also aligns
     * correctly with Web Mercator at high latitudes. Tile canvases are discarded by Leaflet on removal.
     */
    function createLayer(raster, L, options) {
        var HeatLayer = L.GridLayer.extend({
            // Pixel sampling used to run synchronously inside createTile. At high zoom levels a
            // single wheel gesture can request many 256x256 tiles, monopolising the UI thread.
            // Process a few rows per animation frame so Leaflet can paint/handle gestures between
            // chunks. Closed-over geographic coordinates use the EPSG:3857 inverse directly rather
            // than allocating 65k L.Points and calling map.unproject for every tile.
            createTile: function (coords, done) {
                var size = this.getTileSize(), tile = L.DomUtil.create('canvas', 'apm-heatmap-tile');
                tile.width = size.x; tile.height = size.y;
                tile.setAttribute('role', 'presentation');
                var context = tile.getContext('2d'), image = context.createImageData(size.x, size.y);
                var world = size.x * Math.pow(2, coords.z), x0 = coords.x * size.x, y0 = coords.y * size.y;
                var lons = new Float64Array(size.x), lats = new Float64Array(size.y);
                var x, y;
                for (x = 0; x < size.x; x++) lons[x] = ((x0 + x + 0.5) / world) * 360 - 180;
                for (y = 0; y < size.y; y++) {
                    var mercatorY = Math.PI * (1 - 2 * (y0 + y + 0.5) / world);
                    lats[y] = Math.atan(Math.sinh(mercatorY)) * 180 / Math.PI;
                }
                var row = 0, rowsPerFrame = 8, layer = this;

                function paintChunk() {
                    // A zoom/pan may discard a pending tile. Do no more work for a removed layer.
                    if (!layer._map || !tile.parentNode) return;
                    var end = Math.min(size.y, row + rowsPerFrame);
                    for (; row < end; row++) {
                        var offset = 4 * row * size.x;
                        for (var col = 0; col < size.x; col++) sampleRGBA(raster, lons[col], lats[row], image.data, offset + 4 * col);
                    }
                    if (row < size.y) schedule(paintChunk);
                    else {
                        context.putImageData(image, 0, 0);
                        if (done) done(null, tile);
                    }
                }
                function schedule(fn) {
                    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fn);
                    else setTimeout(fn, 0);
                }
                schedule(paintChunk);
                return tile;
            }
        });
        return new HeatLayer(Object.assign({ tileSize: 256, updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1, opacity: 1,
            bounds: L.latLngBounds([raster.north - raster.h * raster.dLat, raster.west],
                [raster.north, raster.west + raster.w * raster.dLon]) }, options));
    }
    return { stops: stops, colourAt: colourAt, buildRaster: buildRaster, sampleRGBA: sampleRGBA, createLayer: createLayer };
});
