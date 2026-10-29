/*!
 * DetectLab — Next-Gen APM · core model (pure functions, no DOM, no network).
 *
 * Everything in this file is deterministic and unit-tested in Node
 * (`node test-apm-next.js`). Browser code loads it as a global
 * (`window.DetectLabApmCore`); Node loads it with require().
 *
 * Score convention: every variable score s_i ∈ [0,1];
 *   final = Σ w_i·s_i / Σ w_i   (weights need not sum to 1).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var R_EARTH_M = 6371008.8;
    var M_PER_DEG_LAT = 110574;           // approx, adequate for ≤ 50 km windows
    var M_PER_DEG_LON_EQ = 111320;

    /* ── Output classes (fixed colours requested by the product brief) ─────── */
    var CLASSES = [
        { id: 'medium', label: 'Medium probability', colour: '#FFA500' },
        { id: 'high', label: 'High probability', colour: '#2E9E4F' },
        { id: 'veryhigh', label: 'Very high probability', colour: '#89CFF0' }
    ];

    var MANUAL_THRESHOLDS = { medium: 0.55, high: 0.70, veryhigh: 0.85 };

    /* ── Water size classes ────────────────────────────────────────────────── */
    // Strahler 1–2 → small stream, 3–4 → medium river, ≥5 → large river.
    // River polygons and inland-water polygons → large (lake / wide river).
    var WATER_CLASSES = ['small', 'medium', 'large', 'artificial'];

    /* ── Default suitability curves (x → score in [0,1], piecewise linear) ── */
    var DEFAULT_CURVES = {
        // slope in degrees: 1.0 up to 5°, linear fall to 0 at 20°
        slope: [[0, 1], [5, 1], [20, 0]],
        // altitude as percentile (0..1) within the analysis window; favours lower→mid
        altitude: [[0, 0.7], [0.2, 1], [0.5, 0.9], [0.8, 0.4], [1, 0.1]],
        // aspect as deviation (degrees) from the sun-facing direction (180° N-hemisphere, 0° S-hemisphere)
        // approximates a cosine preference: (1+cos θ)/2
        aspectDeviation: [[0, 1], [45, 0.85], [90, 0.5], [135, 0.15], [180, 0]],
        // soil proxy as percentile (0..1) of local moisture-tendency (concavity)
        soil: [[0, 0.3], [0.5, 0.6], [1, 1]],
        // water: distance (m) → score, per size class
        water: {
            small: [[0, 1], [150, 0.9], [500, 0.5], [1000, 0.15], [2000, 0]],           // rises with proximity, no penalty
            medium: [[0, 0.85], [150, 0.9], [600, 1], [1500, 0.6], [3000, 0]],          // mild band, peak near 150–600 m
            large: [[0, 0.1], [150, 0.25], [300, 1], [1200, 0.9], [3000, 0]],           // flood band 0–150 m penalised, peak 300 m+
            artificial: [[0, 0.5], [50, 0.5], [300, 0.3], [1000, 0]]                    // canals/ditches (off by default)
        }
    };

    /* ── Small numeric helpers ─────────────────────────────────────────────── */
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    function sortPoints(points) {
        return points.slice().sort(function (a, b) { return a[0] - b[0]; });
    }

    /** Piecewise-linear interpolation, clamped at both ends. Points: [[x,y],...]. */
    function interp(points, x) {
        var n = points.length;
        if (!n) return 0;
        if (x <= points[0][0]) return points[0][1];
        if (x >= points[n - 1][0]) return points[n - 1][1];
        var lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (points[mid][0] <= x) lo = mid; else hi = mid;
        }
        var x0 = points[lo][0], x1 = points[hi][0];
        var t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
        return points[lo][1] + t * (points[hi][1] - points[lo][1]);
    }

    /** Circular interpolation over [0, period) for aspect bins. Points: [[angleDeg,y],...]. */
    function interpCircular(points, angle, period) {
        period = period || 360;
        var n = points.length;
        if (!n) return 0;
        var a = ((angle % period) + period) % period;
        var pts = sortPoints(points);
        // Extend the list by one period on each side to wrap.
        var ext = [];
        for (var k = 0; k < n; k++) ext.push([pts[k][0] - period, pts[k][1]]);
        for (k = 0; k < n; k++) ext.push(pts[k]);
        for (k = 0; k < n; k++) ext.push([pts[k][0] + period, pts[k][1]]);
        return interp(ext, a + period);
    }

    /** Clean a user-edited curve: numeric, sorted, clamped y ∈ [0,1], at least 2 points. */
    function sanitizeCurve(points, circularPeriod) {
        var out = [];
        (points || []).forEach(function (p) {
            var x = Number(p[0]), y = Number(p[1]);
            if (!isFinite(x) || !isFinite(y)) return;
            if (circularPeriod) x = ((x % circularPeriod) + circularPeriod) % circularPeriod;
            out.push([x, clamp(y, 0, 1)]);
        });
        if (out.length < 2) throw new Error('A curve needs at least two valid points.');
        return sortPoints(out);
    }

    function cloneCurves(c) { return JSON.parse(JSON.stringify(c)); }

    /* ── Geodesy (local) ───────────────────────────────────────────────────── */
    function haversineM(lat1, lon1, lat2, lon2) {
        var toR = Math.PI / 180;
        var dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /** Metres per degree (lon, lat) at a latitude. This is the cos(φ) correction. */
    function metresPerDegree(latDeg) {
        var c = Math.cos(latDeg * Math.PI / 180);
        return { lon: M_PER_DEG_LON_EQ * c, lat: M_PER_DEG_LAT };
    }

    /** Bounding box (degrees) of a circle, with extra margin in metres. */
    function circleBBox(lat, lon, radiusM) {
        var mpd = metresPerDegree(lat);
        var dLat = radiusM / mpd.lat;
        var dLon = radiusM / mpd.lon;
        return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
    }

    /** Pick the sun-facing preferred aspect for a latitude (flip in southern hemisphere). */
    function preferredAspectDeg(latDeg) {
        return latDeg >= 0 ? 180 : 0;
    }

    /** Smallest angular difference in degrees, 0..180. */
    function angularDiff(a, b) {
        var d = Math.abs(((a - b) % 360 + 360) % 360);
        return d > 180 ? 360 - d : d;
    }

    /* ── Statistics ────────────────────────────────────────────────────────── */
    function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }

    function pearson(x, y) {
        var n = x.length;
        if (n < 3) return NaN;
        var mx = mean(x), my = mean(y), sxy = 0, sxx = 0, syy = 0;
        for (var i = 0; i < n; i++) {
            var dx = x[i] - mx, dy = y[i] - my;
            sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
        }
        if (sxx === 0 || syy === 0) return NaN;
        return sxy / Math.sqrt(sxx * syy);
    }

    /** Rank-based AUC (Mann–Whitney). pos = site scores, neg = background scores. */
    function auc(pos, neg) {
        var n1 = pos.length, n0 = neg.length;
        if (!n1 || !n0) return NaN;
        var all = [];
        for (var i = 0; i < n1; i++) all.push({ v: pos[i], p: 1 });
        for (i = 0; i < n0; i++) all.push({ v: neg[i], p: 0 });
        all.sort(function (a, b) { return a.v - b.v; });
        var rankSumPos = 0, k = 0;
        while (k < all.length) {
            var j = k;
            while (j + 1 < all.length && all[j + 1].v === all[k].v) j++;
            var avgRank = (k + j) / 2 + 1;          // 1-based average rank of tie group
            for (var m = k; m <= j; m++) if (all[m].p) rankSumPos += avgRank;
            k = j + 1;
        }
        return (rankSumPos - n1 * (n1 + 1) / 2) / (n1 * n0);
    }

    /**
     * Score threshold that captures at least `fraction` of the sites
     * (i.e. the fraction of sites with score ≥ t is ≥ fraction).
     */
    function thresholdForCapture(siteScores, fraction) {
        var s = Array.prototype.slice.call(siteScores).filter(isFinite).sort(function (a, b) { return b - a; });
        if (!s.length) return NaN;
        var k = Math.max(1, Math.ceil(fraction * s.length));
        return s[Math.min(k, s.length) - 1];
    }

    /** Kvamme gain at a threshold: 1 − (background area fraction) / (site fraction). */
    function kvammeGain(siteScores, bgScores, t) {
        var S = 0, A = 0;
        for (var i = 0; i < siteScores.length; i++) if (siteScores[i] >= t) S++;
        for (i = 0; i < bgScores.length; i++) if (bgScores[i] >= t) A++;
        if (!siteScores.length || !bgScores.length || S === 0) return NaN;
        var sFrac = S / siteScores.length, aFrac = A / bgScores.length;
        return 1 - aFrac / sFrac;
    }

    /* ── Curve building from site / background ratios ─────────────────────── */
    /**
     * Binned, smoothed, shrunk log-density-ratio curve → points [[x, y∈0..1]].
     * @param values    Float64Array-like of site values (already in variable units)
     * @param bgValues  background values
     * @param edges     ascending bin edges (length B+1; first/last may be ±Infinity)
     * @param opts      { alpha=1 pseudo-count, kappa=10 shrinkage, circular=false, period=360 }
     */
    function buildCurve(values, bgValues, edges, opts) {
        opts = opts || {};
        var alpha = opts.alpha == null ? 1 : opts.alpha;
        var kappa = opts.kappa == null ? 10 : opts.kappa;
        var B = edges.length - 1;
        var ns = new Float64Array(B), nb = new Float64Array(B);
        var i, b;
        function binOf(v) {
            // binary search: largest b with edges[b] <= v < edges[b+1]
            var lo = 0, hi = B - 1;
            if (v < edges[0]) return 0;
            if (v >= edges[B]) return B - 1;
            while (lo < hi) {
                var mid = (lo + hi + 1) >> 1;
                if (edges[mid] <= v) lo = mid; else hi = mid - 1;
            }
            return lo;
        }
        for (i = 0; i < values.length; i++) if (isFinite(values[i])) ns[binOf(values[i])]++;
        for (i = 0; i < bgValues.length; i++) if (isFinite(bgValues[i])) nb[binOf(bgValues[i])]++;
        var Ns = 0, Nb = 0;
        for (b = 0; b < B; b++) { Ns += ns[b]; Nb += nb[b]; }
        if (Ns === 0 || Nb === 0) {
            // No information: neutral curve.
            return uniformCurve(edges, 0.5, opts);
        }

        var logr = new Float64Array(B);
        for (b = 0; b < B; b++) {
            var ps = (ns[b] + alpha) / (Ns + alpha * B);
            var pb = (nb[b] + alpha) / (Nb + alpha * B);
            var raw = Math.log(ps / pb);
            var nEff = ns[b] + nb[b];
            logr[b] = raw * (nEff / (nEff + kappa));          // shrink toward neutral (log 1 = 0)
        }

        // Light 3-tap smoothing (circular for aspect).
        var sm = new Float64Array(B);
        for (b = 0; b < B; b++) {
            var left = b - 1, right = b + 1;
            if (left < 0) left = opts.circular ? B - 1 : 0;
            if (right >= B) right = opts.circular ? 0 : B - 1;
            sm[b] = 0.25 * logr[left] + 0.5 * logr[b] + 0.25 * logr[right];
        }

        // Min–max normalise to 0..1 across bins.
        var mn = Infinity, mx = -Infinity;
        for (b = 0; b < B; b++) { if (sm[b] < mn) mn = sm[b]; if (sm[b] > mx) mx = sm[b]; }
        var pts = [];
        for (b = 0; b < B; b++) {
            var y = mx - mn < 1e-12 ? 0.5 : (sm[b] - mn) / (mx - mn);
            pts.push([binCentre(edges, b, opts), y]);
        }
        return pts;
    }

    function binCentre(edges, b, opts) {
        var lo = edges[b], hi = edges[b + 1];
        if (!isFinite(lo) || !isFinite(hi)) {
            var finiteEdge = isFinite(lo) ? lo : hi;
            return finiteEdge;   // open-ended bin: use its finite boundary
        }
        return (lo + hi) / 2;
    }

    function uniformCurve(edges, y, opts) {
        var pts = [];
        for (var b = 0; b < edges.length - 1; b++) pts.push([binCentre(edges, b, opts), y]);
        return pts;
    }

    /** Equal-width edges with open ends, for distance / slope / percentile features. */
    function linearEdges(min, max, n) {
        var e = [];
        for (var i = 0; i <= n; i++) e.push(min + (max - min) * i / n);
        return e;
    }

    /* ── Logistic regression (non-negative weights, L2) ───────────────────── */
    /**
     * @param cols  array of Float64Array feature columns (each in [0,1])
     * @param y     Uint8Array labels (1 = site, 0 = background)
     * Returns { weights: Float64Array(p), intercept, iterations, converged }
     */
    function fitNonNegLogistic(cols, y, opts) {
        opts = opts || {};
        var lambda = opts.lambda == null ? 1e-3 : opts.lambda;
        var lr = opts.lr || 2.0;
        var maxIt = opts.maxIter || 3000;
        var p = cols.length, n = y.length;
        var nPos = 0, nNeg = 0, i, j;
        for (i = 0; i < n; i++) { if (y[i]) nPos++; else nNeg++; }
        if (!nPos || !nNeg) throw new Error('Logistic fit needs both site and background samples.');
        // Class-balanced sample weights (each class sums to 0.5).
        var sw = new Float64Array(n);
        for (i = 0; i < n; i++) sw[i] = y[i] ? 0.5 / nPos : 0.5 / nNeg;

        var w = new Float64Array(p).fill(0.1), b = 0;
        var gw = new Float64Array(p), it, converged = false;
        for (it = 0; it < maxIt; it++) {
            gw.fill(0);
            var gb = 0;
            for (i = 0; i < n; i++) {
                var z = b;
                for (j = 0; j < p; j++) z += w[j] * cols[j][i];
                var pr = 1 / (1 + Math.exp(-z));
                var e = (pr - y[i]) * sw[i];
                gb += e;
                for (j = 0; j < p; j++) gw[j] += e * cols[j][i];
            }
            var maxStep = 0;
            for (j = 0; j < p; j++) {
                var g = gw[j] + lambda * w[j];
                var nw = Math.max(0, w[j] - lr * g);      // projection onto w ≥ 0
                maxStep = Math.max(maxStep, Math.abs(nw - w[j]));
                w[j] = nw;
            }
            var nb2 = b - lr * gb;
            maxStep = Math.max(maxStep, Math.abs(nb2 - b));
            b = nb2;
            if (maxStep < 1e-7) { converged = true; break; }
        }
        return { weights: w, intercept: b, iterations: it + 1, converged: converged };
    }

    /* ── Model fitting (TRAIN) ─────────────────────────────────────────────── */
    /**
     * Sample set layout:
     *   S = { n, y: Uint8Array, fold: Uint8Array, vals: { altitude, slope, aspect, soil,
     *         water_small, water_medium, water_large, water_artificial : Float64Array } }
     * Altitude and soil values must already be percentiles (0..1) in the reference window.
     */
    var TRAIN_BINS = {
        altitude: function () { return linearEdges(0, 1, 10); },
        soil: function () { return linearEdges(0, 1, 10); },
        slope: function () { var e = linearEdges(0, 25, 25); e[e.length - 1] = Infinity; return e; },
        aspect: function () { return linearEdges(0, 360, 8); },
        water: function () { return [0, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400, Infinity]; }
    };

    /** Variable keys actually fitted in TRAIN (water is handled per class). */
    function trainVariableKeys(enabledWaterClasses) {
        var keys = ['altitude', 'slope', 'aspect', 'soil'];
        (enabledWaterClasses || []).forEach(function (c) { keys.push('water_' + c); });
        return keys;
    }

    function buildCurvesFor(S, idx, keys, opts) {
        var curves = {};
        var bgIdx = [], siteIdx = [], i;
        for (i = 0; i < idx.length; i++) (S.y[idx[i]] ? siteIdx : bgIdx).push(idx[i]);
        keys.forEach(function (k) {
            var src = S.vals[k];
            var sv = new Float64Array(siteIdx.length), bv = new Float64Array(bgIdx.length);
            for (i = 0; i < siteIdx.length; i++) sv[i] = src[siteIdx[i]];
            for (i = 0; i < bgIdx.length; i++) bv[i] = src[bgIdx[i]];
            var base = k.indexOf('water_') === 0 ? 'water' : k;
            var edges = TRAIN_BINS[base]();
            curves[k] = buildCurve(sv, bv, edges, { circular: k === 'aspect', period: 360 });
        });
        return curves;
    }

    /** Per-sample curve score for a key. NaN (e.g. aspect on flat ground) → neutral 0.5. */
    function curveScore(curves, key, value) {
        if (value !== value) return 0.5;
        if (key === 'aspect') return interpCircular(curves.aspect, value, 360);
        return interp(curves[key], value);
    }

    /**
     * Variable scores for every sample given curves (water = max over classes).
     * Returns { cols: { altitude: Float64Array, ... } , water: Float64Array }
     */
    function sampleFeatures(S, curves, keys) {
        var n = S.n, cols = {}, k, i;
        keys.forEach(function (key) {
            var c = new Float64Array(n);
            var src = S.vals[key];
            for (i = 0; i < n; i++) c[i] = curveScore(curves, key, src[i]);
            cols[key] = c;
        });
        var waterKeys = keys.filter(function (k) { return k.indexOf('water_') === 0; });
        if (waterKeys.length) {
            var water = new Float64Array(n);
            for (i = 0; i < n; i++) {
                var m = 0;
                for (k = 0; k < waterKeys.length; k++) {
                    var v = curveScore(curves, waterKeys[k], S.vals[waterKeys[k]][i]);
                    if (v > m) m = v;
                }
                water[i] = m;
            }
            cols.water = water;
        }
        return cols;
    }

    /**
     * Fit curves + weights on the subset `idx`.
     * Variables are grouped into the five TRAIN variables: water, altitude, slope, aspect, soil.
     * Returns { curves, weights (normalised to Σ=1, zero for excluded), raw, noSignal, intercept }.
     */
    function fitModel(S, idx, opts) {
        opts = opts || {};
        var enabledWater = opts.waterClasses || ['small', 'medium', 'large'];
        var keys = trainVariableKeys(enabledWater);
        var use = opts.variables || ['water', 'altitude', 'slope', 'aspect', 'soil'];
        var curves = buildCurvesFor(S, idx, keys, opts);
        var cols = sampleFeatures(S, curves, keys);
        var varNames = use.filter(function (v) { return cols[v]; });
        var sub = new Float64Array(idx.length);
        var y = new Uint8Array(idx.length);
        var colArr = varNames.map(function (v) {
            var c = new Float64Array(idx.length);
            for (var i = 0; i < idx.length; i++) c[i] = cols[v][idx[i]];
            return c;
        });
        for (var i = 0; i < idx.length; i++) y[i] = S.y[idx[i]];
        var fit = fitNonNegLogistic(colArr, y, opts);
        var raw = {}, total = 0, weights = {};
        ['water', 'altitude', 'slope', 'aspect', 'soil'].forEach(function (v) { weights[v] = 0; raw[v] = 0; });
        varNames.forEach(function (v, j) { raw[v] = fit.weights[j]; total += fit.weights[j]; });
        var noSignal = total <= 1e-9;
        varNames.forEach(function (v) { weights[v] = noSignal ? 0 : raw[v] / total; });
        return { curves: curves, weights: weights, raw: raw, noSignal: noSignal, intercept: fit.intercept, converged: fit.converged };
    }

    /** Composite score for samples with a fitted model. Uses model.weights (zero weights skipped). */
    function scoreSamples(model, S, idx) {
        var keys = Object.keys(model.curves);
        var out = new Float64Array(idx.length);
        // Pre-compute variable scores once.
        var vs = {};
        var names = ['water', 'altitude', 'slope', 'aspect', 'soil'];
        names.forEach(function (v) {
            if (!model.weights[v]) return;
            var arr = new Float64Array(idx.length);
            if (v === 'water') {
                var wk = keys.filter(function (k) { return k.indexOf('water_') === 0; });
                for (var i = 0; i < idx.length; i++) {
                    var m = 0;
                    for (var k = 0; k < wk.length; k++) {
                        var s = curveScore(model.curves, wk[k], S.vals[wk[k]][idx[i]]);
                        if (s > m) m = s;
                    }
                    arr[i] = m;
                }
            } else {
                for (i = 0; i < idx.length; i++) arr[i] = curveScore(model.curves, v, S.vals[v][idx[i]]);
            }
            vs[v] = arr;
        });
        for (var j = 0; j < idx.length; j++) {
            var sum = 0;
            names.forEach(function (v) { if (vs[v]) sum += model.weights[v] * vs[v][j]; });
            out[j] = sum;   // weights already sum to 1 ⇒ Σ w·s / Σ w
        }
        return out;
    }

    /** Spatial block fold id for a point (metres from the study centre). */
    function spatialFold(xM, yM, areaRadiusM, k, blocksPerSide) {
        blocksPerSide = blocksPerSide || 4;
        var span = 2 * areaRadiusM;
        var bx = clamp(Math.floor((xM + areaRadiusM) / span * blocksPerSide), 0, blocksPerSide - 1);
        var by = clamp(Math.floor((yM + areaRadiusM) / span * blocksPerSide), 0, blocksPerSide - 1);
        return (bx + 2 * by) % k;
    }

    /**
     * Spatial block cross-validation. Curves AND weights are re-fitted on each
     * training fold; only held-out samples are scored.
     * Returns { auc, kvamme75, nFolds, perFold:[{auc}], heldSiteScores, heldBgScores }.
     */
    function spatialBlockCV(S, opts) {
        var k = opts.folds || 5;
        var sIdx = [], bIdx = [], i;
        for (i = 0; i < S.n; i++) (S.y[i] ? sIdx : bIdx).push(i);
        var heldS = [], heldB = [], perFold = [];
        for (var f = 0; f < k; f++) {
            var trainIdx = [];
            var testS = [], testB = [];
            for (i = 0; i < S.n; i++) {
                if (S.fold[i] === f) (S.y[i] ? testS : testB).push(i);
                else trainIdx.push(i);
            }
            var nTrS = 0, nTrB = 0;
            for (i = 0; i < trainIdx.length; i++) { if (S.y[trainIdx[i]]) nTrS++; else nTrB++; }
            if (!testS.length || !testB.length || nTrS < 3 || nTrB < 10) continue;
            var model = fitModel(S, trainIdx, opts);
            var ss = scoreSamples(model, S, testS);
            var bs = scoreSamples(model, S, testB);
            perFold.push({ fold: f, auc: auc(ss, bs), nSites: testS.length });
            for (i = 0; i < ss.length; i++) heldS.push(ss[i]);
            for (i = 0; i < bs.length; i++) heldB.push(bs[i]);
        }
        var pooled = auc(heldS, heldB);
        var t75 = thresholdForCapture(heldS, 0.75);
        return {
            auc: pooled,
            kvamme75: kvammeGain(heldS, heldB, t75),
            nFolds: perFold.length,
            perFold: perFold,
            heldSiteScores: heldS,
            heldBgScores: heldB
        };
    }

    /**
     * Full TRAIN fit with the redundancy and value checks the brief requires.
     *   • |r| > 0.8 between the soil proxy and slope (background samples) → soil weight 0.
     *   • soil included, but CV AUC gain over the model without soil < 0.01 → soil weight 0.
     * opts: { waterClasses, minSlopeDeg, folds=5 }
     */
    function trainModelFromSamples(S, opts) {
        opts = opts || {};
        var waterClasses = (opts.waterClasses || []).slice();
        var variables = ['water', 'altitude', 'slope', 'aspect', 'soil'];
        if (!waterClasses.length) variables = variables.filter(function (v) { return v !== 'water'; });
        var excluded = [];
        var bg = [], i;
        for (i = 0; i < S.n; i++) if (!S.y[i]) bg.push(i);
        var soilSlope = pearson(
            Float64Array.from(bg, function (k) { return S.vals.soil[k]; }),
            Float64Array.from(bg, function (k) { return S.vals.slope[k]; }));
        var redundant = isFinite(soilSlope) && Math.abs(soilSlope) > 0.8;
        if (redundant) {
            variables = variables.filter(function (v) { return v !== 'soil'; });
            excluded.push({ variable: 'soil', reason: 'redundant', detail: 'Soil proxy correlates with slope (|r| = ' + soilSlope.toFixed(2) + ' > 0.8).' });
        }
        var cvOpts = { folds: opts.folds || 5, waterClasses: waterClasses, minSlopeDeg: opts.minSlopeDeg };
        var cv = spatialBlockCV(S, Object.assign({ variables: variables }, cvOpts));
        if (!redundant && variables.indexOf('soil') >= 0) {
            var noSoil = variables.filter(function (v) { return v !== 'soil'; });
            var cvNo = spatialBlockCV(S, Object.assign({ variables: noSoil }, cvOpts));
            if (isFinite(cv.auc) && isFinite(cvNo.auc) && cv.auc - cvNo.auc < 0.01) {
                variables = noSoil;
                excluded.push({ variable: 'soil', reason: 'no-value', detail: 'Adds no held-out predictive value (AUC gain ' + (cv.auc - cvNo.auc).toFixed(3) + ' < 0.01).' });
                cv = cvNo;
            }
        }
        var all = [];
        for (i = 0; i < S.n; i++) all.push(i);
        var model = fitModel(S, all, Object.assign({ variables: variables, waterClasses: waterClasses }, cvOpts));
        model.minSlopeDeg = opts.minSlopeDeg || 0.5;
        var siteIdx = [];
        for (i = 0; i < S.n; i++) if (S.y[i]) siteIdx.push(i);
        var siteScores = scoreSamples(model, S, siteIdx);
        return {
            model: model,
            cv: { auc: cv.auc, kvamme75: cv.kvamme75, nFolds: cv.nFolds, perFold: cv.perFold },
            soilSlopeR: soilSlope,
            excluded: excluded,
            variables: variables,
            siteScores: Array.prototype.slice.call(siteScores),
            thresholds: trainThresholds(siteScores),
            confidence: confidenceBadge(siteIdx.length, cv.auc, cv.kvamme75)
        };
    }

    /** Honest confidence badge from sample size and validation. */
    function confidenceBadge(nSites, cvAuc, kvamme) {
        if (!isFinite(cvAuc)) return { level: 'low', text: 'Low — validation not available' };
        if (nSites >= 50 && cvAuc >= 0.75 && isFinite(kvamme) && kvamme > 0.3) {
            return { level: 'good', text: 'Moderate — validated on held-out blocks' };
        }
        if (nSites >= 30 && cvAuc >= 0.65) {
            return { level: 'fair', text: 'Low–moderate — weak but above chance' };
        }
        return { level: 'low', text: 'Low — treat as exploratory only' };
    }

    /* ── Score thresholds ──────────────────────────────────────────────────── */
    /** TRAIN thresholds derived from training-site scores (in-sample). */
    function trainThresholds(siteScores) {
        var t = {
            veryhigh: thresholdForCapture(siteScores, 0.50),  // smallest area that captures 50% of sites
            high: thresholdForCapture(siteScores, 0.75),
            medium: thresholdForCapture(siteScores, 0.90)
        };
        // Keep strictly ordered and inside (0,1].
        t.high = Math.min(t.high, t.veryhigh - 1e-6);
        t.medium = Math.min(t.medium, t.high - 1e-6);
        return { medium: t.medium, high: t.high, veryhigh: t.veryhigh, source: 'train' };
    }

    function validateManualThresholds(t) {
        var m = Number(t.medium), h = Number(t.high), v = Number(t.veryhigh);
        if (![m, h, v].every(isFinite)) throw new Error('Thresholds must be numbers.');
        if (!(0 <= m && m < h && h < v && v <= 1)) throw new Error('Thresholds must satisfy 0 ≤ medium < high < very high ≤ 1.');
        return { medium: m, high: h, veryhigh: v, source: 'manual' };
    }

    /* ── Final score (MANUAL) ──────────────────────────────────────────────── */
    /**
     * Variable scores for one cell. Used by the grid scorer and by tests.
     * cell = { slope(deg), aspect(deg), altPct(0..1), soilPct(0..1), waterDist:{small,medium,large,artificial} }
     * manual.weights = { relief, water, soil };  manual.minSlopeDeg
     */
    function manualCellScore(cell, cfg) {
        var c = cfg.curves;
        var slopeS = interp(c.slope, cell.slope);
        var aspectS = 0.5;
        if (cell.slope >= cfg.minSlopeDeg) {
            var dev = angularDiff(cell.aspect, cfg.preferredAspectDeg);
            aspectS = interp(c.aspectDeviation, dev);
        }
        var altS = interp(c.altitude, cell.altPct);
        var relief = 0.4 * altS + 0.4 * slopeS + 0.2 * aspectS;
        var water = waterScore(cell.waterDist, c.water, cfg.waterClasses);
        var soil = cfg.weights.soil > 0 ? interp(c.soil, cell.soilPct) : 0;
        var num = cfg.weights.relief * relief + cfg.weights.water * water + cfg.weights.soil * soil;
        var den = cfg.weights.relief + cfg.weights.water + cfg.weights.soil;
        return den > 0 ? num / den : 0;
    }

    /** Water score = max over enabled size classes of that class's distance curve. */
    function waterScore(waterDist, curves, enabledClasses) {
        var m = 0;
        for (var i = 0; i < enabledClasses.length; i++) {
            var c = enabledClasses[i];
            var d = waterDist[c];
            if (d == null || d !== d) continue;     // missing / NaN; Infinity = no water of this class
            var s = interp(curves[c], d);
            if (s > m) m = s;
        }
        return m;
    }

    /**
     * Composite score for one cell under a TRAIN model.
     * cell = { slope, aspect, altPct, soilPct, waterDist:{class: metres} }
     * model = fitModel() output (curves keyed altitude/slope/aspect/soil/water_<class>, weights).
     */
    function trainCellScore(cell, model) {
        var c = model.curves, w = model.weights, sum = 0;
        if (w.altitude) sum += w.altitude * interp(c.altitude, cell.altPct);
        if (w.slope) sum += w.slope * interp(c.slope, cell.slope);
        if (w.aspect) sum += w.aspect * (cell.slope >= (model.minSlopeDeg || 0.5) ? interpCircular(c.aspect, cell.aspect, 360) : 0.5);
        if (w.soil) sum += w.soil * interp(c.soil, cell.soilPct);
        if (w.water) {
            var m = 0;
            Object.keys(c).forEach(function (k) {
                if (k.indexOf('water_') !== 0) return;
                var d = cell.waterDist[k.slice(6)];
                if (d == null || d !== d) return;
                var s = interp(c[k], d);
                if (s > m) m = s;
            });
            sum += w.water * m;
        }
        return sum;
    }

    /* ── Editable-curve validation helper for the UI ─────────────────────── */
    function normaliseManualWeights(w) {
        var r = Number(w.relief) || 0, wa = Number(w.water) || 0, s = Number(w.soil) || 0;
        if (r < 0 || wa < 0 || s < 0) throw new Error('Weights cannot be negative.');
        if (r + wa + s <= 0) throw new Error('At least one of RELIEF or WATER must be above zero.');
        return { relief: r, water: wa, soil: s };
    }

    return {
        CLASSES: CLASSES,
        MANUAL_THRESHOLDS: MANUAL_THRESHOLDS,
        WATER_CLASSES: WATER_CLASSES,
        DEFAULT_CURVES: DEFAULT_CURVES,
        TRAIN_BINS: TRAIN_BINS,
        clamp: clamp,
        interp: interp,
        interpCircular: interpCircular,
        sanitizeCurve: sanitizeCurve,
        cloneCurves: cloneCurves,
        haversineM: haversineM,
        metresPerDegree: metresPerDegree,
        circleBBox: circleBBox,
        preferredAspectDeg: preferredAspectDeg,
        angularDiff: angularDiff,
        mean: mean,
        pearson: pearson,
        auc: auc,
        thresholdForCapture: thresholdForCapture,
        kvammeGain: kvammeGain,
        buildCurve: buildCurve,
        linearEdges: linearEdges,
        fitNonNegLogistic: fitNonNegLogistic,
        fitModel: fitModel,
        scoreSamples: scoreSamples,
        sampleFeatures: sampleFeatures,
        spatialFold: spatialFold,
        spatialBlockCV: spatialBlockCV,
        trainModelFromSamples: trainModelFromSamples,
        confidenceBadge: confidenceBadge,
        trainThresholds: trainThresholds,
        validateManualThresholds: validateManualThresholds,
        manualCellScore: manualCellScore,
        trainCellScore: trainCellScore,
        waterScore: waterScore,
        normaliseManualWeights: normaliseManualWeights
    };
});
