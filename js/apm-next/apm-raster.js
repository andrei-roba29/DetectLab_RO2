/*!
 * DetectLab — Next-Gen APM · raster operations (pure, typed arrays).
 *
 * Grid convention used everywhere in Next-Gen APM:
 *   grid = { w, h, west, north, dLon, dLat }   (degrees; dLon, dLat > 0)
 *   cell (i = column, j = row) centre: lon = west + (i+0.5)·dLon, lat = north − (j+0.5)·dLat
 *   row 0 is the northern edge (standard raster order).
 *
 * Runs in the Web Worker (importScripts) and in Node tests (require).
 */
(function (root, factory) {
    var api = factory(typeof module === 'object' && module.exports ? require('./apm-core.js') : root.DetectLabApmCore);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmRaster = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
    'use strict';

    var NODATA_LIMIT = -9000;     // EU-DEM nodata is -32768; anything below -9000 m is invalid

    function isValidElev(v, nodata) {
        return v === v && v > NODATA_LIMIT && (nodata === undefined || v !== nodata);
    }

    /* ── Geometry helpers ──────────────────────────────────────────────────── */
    function gridCentreLat(grid) { return grid.north - (grid.h / 2) * grid.dLat; }

    /** Ground spacing (m) of one cell at the grid centre, with the cos(latitude) correction. */
    function gridSpacingM(grid) {
        var mpd = core.metresPerDegree(gridCentreLat(grid));
        return { dx: grid.dLon * mpd.lon, dy: grid.dLat * mpd.lat };
    }

    function cellLon(grid, i) { return grid.west + (i + 0.5) * grid.dLon; }
    function cellLat(grid, j) { return grid.north - (j + 0.5) * grid.dLat; }

    /** Grid that covers a lon/lat bbox at a target cell size in metres (square-ish cells). */
    function gridForBBox(bbox, cellM) {
        var midLat = (bbox.north + bbox.south) / 2;
        var mpd = core.metresPerDegree(midLat);
        var w = Math.max(1, Math.round((bbox.east - bbox.west) * mpd.lon / cellM));
        var h = Math.max(1, Math.round((bbox.north - bbox.south) * mpd.lat / cellM));
        return {
            w: w, h: h, west: bbox.west, north: bbox.north,
            dLon: (bbox.east - bbox.west) / w, dLat: (bbox.north - bbox.south) / h
        };
    }

    /* ── Terrain: Horn 3×3 slope / aspect, with per-axis metric spacing ────── */
    /**
     * @param elev    Float32Array (h×w), row 0 = north
     * @param dxM,dyM ground metres per cell (east–west, north–south). Use gridSpacingM() for geographic grids.
     * Border cells (no full 3×3 neighbourhood) and cells with nodata neighbours are invalid.
     * Returns { slope (deg), aspect (deg, downslope azimuth 0..360), curv (d²z/dx²+d²z/dy², +ve = concave/wet), valid }
     */
    function horn(elev, w, h, dxM, dyM, opts) {
        opts = opts || {};
        var nodata = opts.nodata;
        var slope = new Float32Array(w * h), aspect = new Float32Array(w * h);
        var curv = new Float32Array(w * h), valid = new Uint8Array(w * h);
        var i8dx = 1 / (8 * dxM), i8dy = 1 / (8 * dyM);
        var idx2x = 1 / (dxM * dxM), idx2y = 1 / (dyM * dyM);
        for (var j = 1; j < h - 1; j++) {
            for (var i = 1; i < w - 1; i++) {
                var o = j * w + i;
                var a = elev[o - w - 1], b = elev[o - w], c = elev[o - w + 1];
                var d = elev[o - 1], e = elev[o], f = elev[o + 1];
                var g = elev[o + w - 1], hh = elev[o + w], ii = elev[o + w + 1];
                if (!isValidElev(a, nodata) || !isValidElev(b, nodata) || !isValidElev(c, nodata) ||
                    !isValidElev(d, nodata) || !isValidElev(e, nodata) || !isValidElev(f, nodata) ||
                    !isValidElev(g, nodata) || !isValidElev(hh, nodata) || !isValidElev(ii, nodata)) continue;
                var dzdx = ((c + 2 * f + ii) - (a + 2 * d + g)) * i8dx;     // east − west
                var dzdrow = ((g + 2 * hh + ii) - (a + 2 * b + c)) * i8dy;  // south − north
                slope[o] = Math.atan(Math.sqrt(dzdx * dzdx + dzdrow * dzdrow)) * 180 / Math.PI;
                // Downslope azimuth (clockwise from north): east = −dz/dx, north = +dzdrow.
                var az = Math.atan2(-dzdx, dzdrow) * 180 / Math.PI;
                aspect[o] = (az + 360) % 360;
                var d2x = (d + f - 2 * e) * idx2x, d2y = (b + hh - 2 * e) * idx2y;
                curv[o] = d2x + d2y;
                valid[o] = 1;
            }
        }
        return { slope: slope, aspect: aspect, curv: curv, valid: valid };
    }

    /** Light 3×3 Gaussian-like smoothing [1 2 1]/16 (user option). Nodata neighbours are skipped. */
    function smoothElevation(elev, w, h, nodata) {
        var out = new Float32Array(elev.length);
        out.set(elev);
        var k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
        for (var j = 1; j < h - 1; j++) {
            for (var i = 1; i < w - 1; i++) {
                var o = j * w + i;
                if (!isValidElev(elev[o], nodata)) continue;
                var s = 0, ws = 0, kk = 0;
                for (var dj = -1; dj <= 1; dj++) {
                    for (var di = -1; di <= 1; di++, kk++) {
                        var v = elev[o + dj * w + di];
                        if (!isValidElev(v, nodata)) continue;
                        s += k[kk] * v; ws += k[kk];
                    }
                }
                out[o] = s / ws;
            }
        }
        return out;
    }

    /** Full terrain pass for a DEM block (optionally smoothed first). */
    function terrain(elev, w, h, dxM, dyM, opts) {
        opts = opts || {};
        var src = opts.smooth ? smoothElevation(elev, w, h, opts.nodata) : elev;
        return horn(src, w, h, dxM, dyM, { nodata: opts.nodata });
    }

    /* ── Anisotropic Euclidean distance transform (Felzenszwalb–Huttenlocher) ─ */
    function dt1d(f, n, sp, out, v, z) {
        var k = -1, q, s = 0;
        for (q = 0; q < n; q++) {
            if (f[q] === Infinity) continue;             // no source here: parabola absent
            var xq = q * sp, fq = f[q] + xq * xq;
            if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
            // Intersection of the new parabola with the last one on the envelope.
            for (;;) {
                var p = v[k], xp = p * sp;
                s = (fq - (f[p] + xp * xp)) / (2 * (xq - xp));
                if (s <= z[k]) k--; else break;           // z[0] = -Infinity, so k ≥ 0 here
            }
            k++;
            v[k] = q; z[k] = s; z[k + 1] = Infinity;
        }
        if (k < 0) { for (q = 0; q < n; q++) out[q] = Infinity; return; }
        k = 0;
        for (q = 0; q < n; q++) {
            while (z[k + 1] < q * sp) k++;
            var dx = q * sp - v[k] * sp;
            out[q] = dx * dx + f[v[k]];
        }
    }

    /**
     * Distance (m) from every cell to the nearest source cell (mask = 1), with
     * anisotropic ground spacing dxM × dyM. Cells with no source anywhere → Infinity.
     */
    function edt(mask, w, h, dxM, dyM) {
        var g = new Float64Array(w * h);
        var rowF = new Float64Array(w), rowOut = new Float64Array(w);
        var v = new Int32Array(Math.max(w, h) + 1), z = new Float64Array(Math.max(w, h) + 2);
        var j, i;
        for (j = 0; j < h; j++) {
            for (i = 0; i < w; i++) rowF[i] = mask[j * w + i] ? 0 : Infinity;
            dt1d(rowF, w, dxM, rowOut, v, z);
            for (i = 0; i < w; i++) g[j * w + i] = rowOut[i];
        }
        var colF = new Float64Array(h), colOut = new Float64Array(h);
        var out = new Float32Array(w * h);
        for (i = 0; i < w; i++) {
            for (j = 0; j < h; j++) colF[j] = g[j * w + i];
            dt1d(colF, h, dyM, colOut, v, z);
            for (j = 0; j < h; j++) {
                var d2 = colOut[j];
                out[j * w + i] = d2 === Infinity ? Infinity : Math.sqrt(d2);
            }
        }
        return out;
    }

    /* ── Rasterisation of vector water onto a grid ────────────────────────── */
    function cellOf(grid, lon, lat) {
        var i = Math.floor((lon - grid.west) / grid.dLon);
        var j = Math.floor((grid.north - lat) / grid.dLat);
        if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) return -1;
        return j * grid.w + i;
    }

    /** lines: array of [[lon,lat],...]. Marks every cell the polyline touches. */
    function rasteriseLines(lines, grid, mask) {
        mask = mask || new Uint8Array(grid.w * grid.h);
        var step = Math.min(grid.dLon, grid.dLat) * 0.5;
        for (var L = 0; L < lines.length; L++) {
            var pts = lines[L];
            for (var p = 0; p + 1 < pts.length; p++) {
                var a = pts[p], b = pts[p + 1];
                var dLon = b[0] - a[0], dLat = b[1] - a[1];
                var n = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / step));
                for (var k = 0; k <= n; k++) {
                    var c = cellOf(grid, a[0] + dLon * k / n, a[1] + dLat * k / n);
                    if (c >= 0) mask[c] = 1;
                }
            }
        }
        return mask;
    }

    /**
     * Even–odd fill of polygon rings (each ring = [[lon,lat],...]) on cell centres,
     * plus their boundaries. Rings may be outers and holes.
     */
    function rasterisePolygons(rings, grid, mask) {
        mask = mask || new Uint8Array(grid.w * grid.h);
        var rowsX = new Array(grid.h);
        for (var j0 = 0; j0 < grid.h; j0++) rowsX[j0] = [];
        for (var r = 0; r < rings.length; r++) {
            var ring = rings[r];
            for (var p = 0; p < ring.length; p++) {
                var a = ring[p], b = ring[(p + 1) % ring.length];
                if (a[0] === b[0] && a[1] === b[1]) continue;
                // boundary cells
                rasteriseLines([[a, b]], grid, mask);
                // scanline crossings for rows whose centre latitude is inside [min,max)
                var yMin = Math.min(a[1], b[1]), yMax = Math.max(a[1], b[1]);
                var jFrom = Math.max(0, Math.ceil((grid.north - yMax) / grid.dLat - 0.5));
                var jTo = Math.min(grid.h - 1, Math.floor((grid.north - yMin) / grid.dLat - 0.5));
                for (var j = jFrom; j <= jTo; j++) {
                    var lat = cellLat(grid, j);
                    if ((a[1] > lat) === (b[1] > lat)) continue;
                    var x = a[0] + (lat - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
                    rowsX[j].push(x);
                }
            }
        }
        for (j = 0; j < grid.h; j++) {
            var xs = rowsX[j];
            if (xs.length < 2) continue;
            xs.sort(function (u, v) { return u - v; });
            for (var k = 0; k + 1 < xs.length; k += 2) {
                // cells whose centre lies in [xs[k], xs[k+1])
                var i0 = Math.max(0, Math.ceil((xs[k] - grid.west) / grid.dLon - 0.5));
                var i1 = Math.min(grid.w - 1, Math.floor((xs[k + 1] - grid.west) / grid.dLon - 0.5));
                for (var i = i0; i <= i1; i++) mask[j * grid.w + i] = 1;
            }
        }
        return mask;
    }

    /** Circular mask (1 inside) of radius metres around lat/lon, using local metres per degree. */
    function circleMask(grid, lat, lon, radiusM) {
        var mask = new Uint8Array(grid.w * grid.h);
        var mpd = core.metresPerDegree(lat);
        var r2 = radiusM * radiusM;
        for (var j = 0; j < grid.h; j++) {
            var dy = (cellLat(grid, j) - lat) * mpd.lat;
            for (var i = 0; i < grid.w; i++) {
                var dx = (cellLon(grid, i) - lon) * mpd.lon;
                if (dx * dx + dy * dy <= r2) mask[j * grid.w + i] = 1;
            }
        }
        return mask;
    }

    /* ── Point → water distance with an R-tree over segments (TRAIN sampling) ─ */
    /**
     * segs: Float64Array [lon1,lat1,lon2,lat2, …]. RBushCtor: the rbush constructor.
     * Returns { tree, segs } usable with nearestWaterM().
     */
    function buildSegmentIndex(RBushCtor, segs) {
        var tree = new RBushCtor(16);
        var items = [];
        for (var k = 0; k + 3 < segs.length; k += 4) {
            items.push({
                minX: Math.min(segs[k], segs[k + 2]), maxX: Math.max(segs[k], segs[k + 2]),
                minY: Math.min(segs[k + 1], segs[k + 3]), maxY: Math.max(segs[k + 1], segs[k + 3]),
                k: k
            });
        }
        tree.load(items);
        return { tree: tree, segs: segs, count: items.length };
    }

    function segDistM(lon, lat, ax, ay, bx, by, mpd) {
        // local equirectangular metres around the query point
        var px = 0, py = 0;
        var x1 = (ax - lon) * mpd.lon, y1 = (ay - lat) * mpd.lat;
        var x2 = (bx - lon) * mpd.lon, y2 = (by - lat) * mpd.lat;
        var vx = x2 - x1, vy = y2 - y1;
        var len2 = vx * vx + vy * vy;
        var t = len2 > 0 ? -(x1 * vx + y1 * vy) / len2 : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        var cx = x1 + t * vx - px, cy = y1 + t * vy - py;
        return Math.sqrt(cx * cx + cy * cy);
    }

    /** Exact nearest distance (m) from lon/lat to any indexed segment; Infinity if none. */
    function nearestWaterM(index, lon, lat) {
        if (!index || !index.count) return Infinity;
        var mpd = core.metresPerDegree(lat);
        var r = 0.0005;                              // start ≈ 50 m
        var best = Infinity;
        for (var guard = 0; guard < 40; guard++) {
            var hits = index.tree.search({ minX: lon - r, minY: lat - r, maxX: lon + r, maxY: lat + r });
            for (var h = 0; h < hits.length; h++) {
                var k = hits[h].k, s = index.segs;
                var d = segDistM(lon, lat, s[k], s[k + 1], s[k + 2], s[k + 3], mpd);
                if (d < best) best = d;
            }
            // Anything closer than best is inside a box of half-width best (in degrees).
            if (best <= Math.min(r * mpd.lat, r * mpd.lon)) return best;
            r = Math.max(r * 2, best / Math.min(mpd.lat, mpd.lon) * 1.01);
        }
        return best;
    }

    /* ── Percentiles relative to a reference sample ───────────────────────── */
    /** Sorted copy (Float64Array) of finite values. */
    function sortedFinite(arr, mask) {
        var tmp = [];
        for (var i = 0; i < arr.length; i++) {
            if (mask && !mask[i]) continue;
            var v = arr[i];
            if (isFinite(v)) tmp.push(v);
        }
        var out = Float64Array.from(tmp);
        out.sort();
        return out;
    }

    /** Fraction of the reference sample ≤ v (mid-rank for ties), in [0,1]. */
    function percentileOf(sorted, v) {
        var n = sorted.length;
        if (!n) return 0.5;
        var lo = 0, hi = n;
        while (lo < hi) { var m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
        var lt = lo;
        hi = n;
        lo = 0;
        while (lo < hi) { var m2 = (lo + hi) >> 1; if (sorted[m2] <= v) lo = m2 + 1; else hi = m2; }
        return (lt + lo) / 2 / n;
    }

    /* ── Polygon area and ring utilities (for fragment filtering) ─────────── */
    /** Area (m²) of a ring of [lon,lat] using local equirectangular projection. */
    function ringAreaM2(ring) {
        if (ring.length < 4) return 0;
        var lat0 = 0, n = 0;
        for (var i = 0; i < ring.length; i++) { lat0 += ring[i][1]; n++; }
        lat0 /= n;
        var mpd = core.metresPerDegree(lat0);
        var s = 0;
        for (i = 0; i < ring.length - 1; i++) {
            var x1 = ring[i][0] * mpd.lon, y1 = ring[i][1] * mpd.lat;
            var x2 = ring[i + 1][0] * mpd.lon, y2 = ring[i + 1][1] * mpd.lat;
            s += x1 * y2 - x2 * y1;
        }
        return Math.abs(s) / 2;
    }

    return {
        NODATA_LIMIT: NODATA_LIMIT,
        isValidElev: isValidElev,
        gridSpacingM: gridSpacingM,
        cellLon: cellLon,
        cellLat: cellLat,
        gridForBBox: gridForBBox,
        horn: horn,
        smoothElevation: smoothElevation,
        terrain: terrain,
        edt: edt,
        cellOf: cellOf,
        rasteriseLines: rasteriseLines,
        rasterisePolygons: rasterisePolygons,
        circleMask: circleMask,
        buildSegmentIndex: buildSegmentIndex,
        nearestWaterM: nearestWaterM,
        sortedFinite: sortedFinite,
        percentileOf: percentileOf,
        ringAreaM2: ringAreaM2
    };
});
