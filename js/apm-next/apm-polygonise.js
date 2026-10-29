/*!
 * DetectLab — Next-Gen APM · score grid → non-overlapping class polygons.
 *
 * Nested iso-regions come from d3-contour (marching squares, smooth=true).
 * Non-overlap is enforced with polygon-clipping set differences:
 *   medium    = R(t_medium) − R(t_high)
 *   high      = R(t_high)   − R(t_veryhigh)
 *   veryhigh  = R(t_veryhigh)
 *
 * d3 contour output coordinates are cell EDGES: u ∈ [0,w], v ∈ [0,h].
 * Geographic mapping: lon = west + u·dLon, lat = north − v·dLat.
 */
(function (root, factory) {
    var api = factory(
        typeof module === 'object' && module.exports ? require('./apm-core.js') : root.DetectLabApmCore,
        typeof module === 'object' && module.exports ? require('./apm-raster.js') : root.DetectLabApmRaster,
        typeof module === 'object' && module.exports ? require('../d3.min.js') : root.d3,
        typeof module === 'object' && module.exports ? require('../vendor/polygon-clipping.umd.min.js') : root.polygonClipping
    );
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmPolygonise = api;
})(typeof self !== 'undefined' ? self : this, function (core, raster, d3, pc) {
    'use strict';

    /** Nested region (score ≥ t) as a MultiPolygon in grid-edge coordinates. Empty → []. */
    function regionAtThreshold(values, w, h, t) {
        var c = d3.contours().size([w, h]).thresholds([t]).smooth(true)(values);
        return c && c[0] && c[0].coordinates ? c[0].coordinates : [];
    }

    function diff(a, b) {
        if (!a.length) return [];
        if (!b.length) return a;
        return pc.difference(a, b);
    }

    /** Non-overlapping class regions in grid-edge coordinates. */
    function classRegions(values, w, h, thr) {
        var rm = regionAtThreshold(values, w, h, thr.medium);
        var rh = regionAtThreshold(values, w, h, thr.high);
        var rv = regionAtThreshold(values, w, h, thr.veryhigh);
        return {
            medium: diff(rm, rh),
            high: diff(rh, rv),
            veryhigh: rv
        };
    }

    /** One Chaikin corner-cutting pass on a closed ring (keeps the ring closed). */
    function chaikinRing(ring, iters) {
        var r = ring;
        for (var k = 0; k < (iters || 0); k++) {
            var out = [];
            var n = r.length - 1;               // last point equals first
            for (var i = 0; i < n; i++) {
                var a = r[i], b = r[i + 1];
                out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
                out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
            }
            out.push(out[0]);
            r = out;
        }
        return r;
    }

    /** Clip to a rectangle-free, geographic MultiPolygon with area filtering. */
    function toGeoPolygons(mp, grid, opts) {
        var minArea = opts.minAreaM2 || 0;
        var smoothIters = opts.smoothIters == null ? 1 : opts.smoothIters;
        var out = [];
        for (var p = 0; p < mp.length; p++) {
            var polyRings = mp[p];
            if (!polyRings.length) continue;
            var outer = polyRings[0].map(function (q) { return [grid.west + q[0] * grid.dLon, grid.north - q[1] * grid.dLat]; });
            outer = chaikinRing(outer, smoothIters);
            var outerArea = raster.ringAreaM2(outer);
            if (outerArea < minArea) continue;
            var holes = [];
            for (var h = 1; h < polyRings.length; h++) {
                var hole = polyRings[h].map(function (q) { return [grid.west + q[0] * grid.dLon, grid.north - q[1] * grid.dLat]; });
                hole = chaikinRing(hole, smoothIters);
                if (raster.ringAreaM2(hole) >= minArea) holes.push(hole);
            }
            var area = outerArea;
            holes.forEach(function (hr) { area -= raster.ringAreaM2(hr); });
            out.push({ rings: [outer].concat(holes), areaM2: Math.max(0, area) });
        }
        return out;
    }

    /**
     * Full polygonisation of a score grid.
     * @param score   Float32Array(w·h); cells outside the analysis mask must be NaN or < 0.
     * @param grid    grid object (see apm-raster.js)
     * @param thr     { medium, high, veryhigh }
     * @param opts    { minAreaM2 = 2500, smoothIters = 1 }
     * @returns GeoJSON FeatureCollection; features carry class, label, colour, areaM2.
     */
    function polygonise(score, grid, thr, opts) {
        opts = opts || {};
        var w = grid.w, h = grid.h;
        var values = new Float64Array(w * h);
        for (var i = 0; i < values.length; i++) {
            var s = score[i];
            values[i] = (s === s && s > 0) ? s : 0;    // NaN/outside → 0
        }
        var regions = classRegions(values, w, h, thr);
        var features = [];
        core.CLASSES.slice().reverse().forEach(function (cls) {        // veryhigh first, draw order later
            var polys = toGeoPolygons(regions[cls.id], grid, opts);
            polys.forEach(function (p) {
                features.push({
                    type: 'Feature',
                    properties: {
                        class: cls.id,
                        label: cls.label,
                        colour: cls.colour,
                        areaM2: Math.round(p.areaM2)
                    },
                    geometry: { type: 'Polygon', coordinates: p.rings }
                });
            });
        });
        return { type: 'FeatureCollection', features: features };
    }

    /** Area in km² per class for a FeatureCollection. */
    function areaByClass(fc) {
        var out = { medium: 0, high: 0, veryhigh: 0 };
        fc.features.forEach(function (f) { out[f.properties.class] += f.properties.areaM2 / 1e6; });
        return out;
    }

    return {
        regionAtThreshold: regionAtThreshold,
        classRegions: classRegions,
        chaikinRing: chaikinRing,
        polygonise: polygonise,
        areaByClass: areaByClass
    };
});
