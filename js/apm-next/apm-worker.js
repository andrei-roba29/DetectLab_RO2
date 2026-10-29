/*!
 * DetectLab — Next-Gen APM · Web Worker.
 *
 * All heavy numeric work runs here, never on the main thread:
 *   terrain       Horn slope/aspect/curvature for a DEM block
 *   sampleTile    TRAIN: DEM tile → values at site/background points (+ water distance via rbush)
 *   setAnalysis   MANUAL/TRAIN prediction window: terrain, percentiles, water distance fields (EDT)
 *   score         score grid from curves/weights → non-overlapping class polygons (GeoJSON)
 *
 * Analysis rasters stay inside the worker, so re-scoring with new weights or curves does
 * not refetch or recompute terrain (see setAnalysis / score).
 */
/* global importScripts, self, DetectLabApmCore, DetectLabApmRaster, DetectLabApmPolygonise, rbush */
importScripts(
    'apm-core.js',
    'apm-raster.js',
    '../d3.min.js',
    '../vendor/polygon-clipping.umd.min.js',
    'apm-polygonise.js',
    '../rbush.min.js'
);

(function () {
    'use strict';
    var core = DetectLabApmCore;
    var R = DetectLabApmRaster;
    var P = DetectLabApmPolygonise;

    var state = { water: null, analysis: null };

    function reply(id, payload, transfer) {
        self.postMessage(Object.assign({ id: id, ok: true }, payload), transfer || []);
    }
    function fail(id, err) {
        self.postMessage({ id: id, ok: false, error: String(err && err.message ? err.message : err) });
    }

    function handleTerrain(m) {
        var t = R.terrain(m.elev, m.w, m.h, m.dxM, m.dyM, { smooth: m.smooth, nodata: m.nodata });
        reply(m.id, { slope: t.slope, aspect: t.aspect, curv: t.curv, valid: t.valid },
            [t.slope.buffer, t.aspect.buffer, t.curv.buffer, t.valid.buffer]);
    }

    /** TRAIN tile: values at points that fall in this tile's grid. Output rows: elev,slope,aspect,curv,valid, then water per class. */
    function handleSampleTile(m) {
        var grid = { w: m.w, h: m.h, west: m.tile.west, north: m.tile.north, dLon: m.tile.dLon, dLat: m.tile.dLat };
        var t = R.terrain(m.elev, m.w, m.h, m.dxM, m.dyM, { smooth: m.smooth, nodata: m.nodata });
        var pts = m.points, n = pts.length / 2;
        var classes = core.WATER_CLASSES.filter(function (c) { return state.water && state.water[c]; });
        var out = new Float64Array(n * 5);
        var waterOut = {};
        classes.forEach(function (c) { waterOut[c] = new Float64Array(n); });
        var inside = new Uint8Array(n);
        for (var p = 0; p < n; p++) {
            var lon = pts[2 * p], lat = pts[2 * p + 1];
            var cell = R.cellOf(grid, lon, lat);
            var o = p * 5;
            if (cell < 0) { out[o + 4] = 0; inside[p] = 0; }
            else {
                inside[p] = 1;
                out[o] = m.elev[cell];
                out[o + 1] = t.slope[cell];
                out[o + 2] = t.aspect[cell];
                out[o + 3] = t.curv[cell];
                out[o + 4] = t.valid[cell];
            }
            classes.forEach(function (c) {
                waterOut[c][p] = inside[p] ? R.nearestWaterM(state.water[c], lon, lat) : NaN;
            });
        }
        var transfer = [out.buffer, inside.buffer];
        classes.forEach(function (c) { transfer.push(waterOut[c].buffer); });
        reply(m.id, { values: out, inside: inside, water: waterOut, classes: classes }, transfer);
    }

    function handleSetWater(m) {
        state.water = {};
        core.WATER_CLASSES.forEach(function (c) {
            var segs = m.classes && m.classes[c];
            if (segs && segs.length >= 4) state.water[c] = R.buildSegmentIndex(rbush, segs);
        });
        reply(m.id, {
            counts: Object.keys(state.water).reduce(function (acc, c) { acc[c] = state.water[c].count; return acc; }, {})
        });
    }

    function handleSetAnalysis(m) {
        var g = m.grid, w = g.w, h = g.h, n = w * h;
        var sp = R.gridSpacingM(g);
        var t = R.terrain(m.elev, w, h, sp.dx, sp.dy, { smooth: m.smooth, nodata: m.nodata });
        var inCircle = R.circleMask(g, m.circle.lat, m.circle.lon, m.circle.radiusM);
        // Reference distributions for percentiles: explicit (TRAIN background) or the search window itself.
        var elevInCircle = [], curvInCircle = [];
        for (var i = 0; i < n; i++) {
            if (inCircle[i] && t.valid[i]) { elevInCircle.push(m.elev[i]); curvInCircle.push(t.curv[i]); }
        }
        var altRef = m.altRef ? Float64Array.from(m.altRef) : Float64Array.from(elevInCircle).sort();
        var soilRef = m.soilRef ? Float64Array.from(m.soilRef) : Float64Array.from(curvInCircle).sort();
        var altPct = new Float32Array(n), soilPct = new Float32Array(n);
        var valid = new Uint8Array(n);
        for (i = 0; i < n; i++) {
            if (!inCircle[i] || !t.valid[i]) continue;
            valid[i] = 1;
            altPct[i] = R.percentileOf(altRef, m.elev[i]);
            soilPct[i] = R.percentileOf(soilRef, t.curv[i]);
        }
        var waterDist = {};
        var stats = { cells: n, inCircle: 0, valid: 0, waterCells: {} };
        for (i = 0; i < n; i++) { if (inCircle[i]) stats.inCircle++; if (valid[i]) stats.valid++; }
        core.WATER_CLASSES.forEach(function (c) {
            var mask = m.waterMasks && m.waterMasks[c];
            if (!mask) return;
            var cnt = 0;
            for (i = 0; i < n; i++) if (mask[i]) cnt++;
            stats.waterCells[c] = cnt;
            waterDist[c] = cnt ? R.edt(mask, w, h, sp.dx, sp.dy) : new Float32Array(n).fill(Infinity);
        });
        state.analysis = {
            grid: g, spacing: sp, slope: t.slope, aspect: t.aspect, curv: t.curv, valid: valid,
            inCircle: inCircle, altPct: altPct, soilPct: soilPct, waterDist: waterDist
        };
        stats.spacingM = { dx: sp.dx, dy: sp.dy };
        reply(m.id, { stats: stats });
    }

    function scoreGrid(mode, cfg) {
        var A = state.analysis;
        if (!A) throw new Error('No analysis loaded.');
        var n = A.grid.w * A.grid.h;
        var score = new Float32Array(n).fill(NaN);
        var classes = cfg.waterClasses || [];
        var cell = { slope: 0, aspect: 0, altPct: 0, soilPct: 0, waterDist: {} };
        var sum = 0, cnt = 0, mn = Infinity, mx = -Infinity;
        for (var i = 0; i < n; i++) {
            if (!A.valid[i]) continue;
            cell.slope = A.slope[i];
            cell.aspect = A.aspect[i];
            cell.altPct = A.altPct[i];
            cell.soilPct = A.soilPct[i];
            for (var k = 0; k < classes.length; k++) {
                var c = classes[k];
                cell.waterDist[c] = A.waterDist[c] ? A.waterDist[c][i] : Infinity;
            }
            var s = mode === 'manual' ? core.manualCellScore(cell, cfg) : core.trainCellScore(cell, cfg.model);
            if (!(s === s)) continue;
            score[i] = s;
            sum += s; cnt++;
            if (s < mn) mn = s;
            if (s > mx) mx = s;
        }
        return { score: score, stats: { cells: cnt, min: cnt ? mn : null, max: cnt ? mx : null, mean: cnt ? sum / cnt : null } };
    }

    function handleScore(m) {
        var cfg = m.mode === 'manual'
            ? {
                curves: m.curves, weights: m.weights, minSlopeDeg: m.minSlopeDeg,
                preferredAspectDeg: m.preferredAspectDeg, waterClasses: m.waterClasses
            }
            : { model: m.model, waterClasses: m.waterClasses };
        var res = scoreGrid(m.mode, cfg);
        var fc = P.polygonise(res.score, state.analysis.grid, m.thresholds, {
            minAreaM2: m.minAreaM2 == null ? 2500 : m.minAreaM2,
            smoothIters: m.smoothIters == null ? 1 : m.smoothIters
        });
        reply(m.id, { geojson: fc, areaKm2: P.areaByClass(fc), scoreStats: res.stats });
    }

    function handleTrain(m) {
        var res = core.trainModelFromSamples(m.S, { waterClasses: m.waterClasses, minSlopeDeg: m.minSlopeDeg, folds: m.folds });
        reply(m.id, { result: res });
    }

    self.onmessage = function (ev) {
        var m = ev.data || {};
        try {
            switch (m.op) {
                case 'terrain': return handleTerrain(m);
                case 'sampleTile': return handleSampleTile(m);
                case 'setWater': return handleSetWater(m);
                case 'setAnalysis': return handleSetAnalysis(m);
                case 'score': return handleScore(m);
                case 'train': return handleTrain(m);
                default: throw new Error('Unknown worker operation: ' + m.op);
            }
        } catch (err) {
            fail(m.id, err);
        }
    };
})();
