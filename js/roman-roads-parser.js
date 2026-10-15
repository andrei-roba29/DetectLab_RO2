/* ============================================================================
 * roman-roads-parser.js — the Roman-road NDJSON → binary geometry pipeline
 * ----------------------------------------------------------------------------
 * WHY
 *   The "Roman roads" layer used to turn every NDJSON line into one
 *   `L.polyline`, i.e. one SVG <path> per road segment, on the main thread,
 *   while the file was still streaming. With a continental road network
 *   (tens of thousands of segments, hundreds of thousands of vertices) that
 *   means: JSON.parse + object churn + DOM nodes in the same task that is
 *   supposed to pump the HTTP stream. The download therefore crawls (the
 *   byte progress sits at 4 %), the tab freezes and, on phones or in the
 *   installed PWA, the renderer kills the page.
 *
 * WHAT
 *   This file is the *only* place that understands the source records. It
 *   turns one stream record into indexed, simplified Web-Mercator geometry
 *   packed into transferable typed arrays:
 *
 *     origins  Float64Array(2n)      mercator x/y of vertex 0 (metres)
 *     deltas   Float32Array(2v)      per-vertex x/y offset from the segment
 *                                    origin, in metres  (sub-mm precision at
 *                                    any zoom, 8 bytes per vertex)
 *     starts   Uint32Array(n + 1)    vertex range of segment i (prefix sum)
 *     bounds   Float32Array(4n)      [minX, minY, maxX, maxY] per segment
 *     cellKeys Uint32Array(c)        sorted spatial-grid cells of this batch
 *     cellStart Uint32Array(c + 1)   CSR offsets into `cellItems`
 *     cellItems Uint32Array(n)       segment indices, grouped by cell
 *     spanItems Uint32Array(s)       segments longer than one grid cell
 *
 *   The spatial grid is what lets the canvas layer visit only the segments of
 *   the tile it is painting — `cellItems` is never walked in full above z8.
 *
 * CARRIED OVER VERBATIM FROM js/map-app.js
 *   The accepted record shapes (`geometry` / `geom` / `geojson` / `the_geom` /
 *   `wkt` / `shape` / `line` / `path` / `coordinates` / `coords`, WKT
 *   LINESTRING, GeoJSON Feature / FeatureCollection / GeometryCollection,
 *   bare coordinate arrays) and the Web-Mercator auto-detection are unchanged,
 *   so a dataset that used to load still loads — it just stops taking the tab
 *   down with it.
 *
 * MEMORY
 *   A segment costs ~36 bytes + 8 bytes per vertex here, against roughly
 *   250+ bytes per vertex for the LatLng/Path objects it replaces. The
 *   collector enforces a hard byte budget anyway: when it is reached the
 *   geometry is *sampled* (uniform stride, long roads always kept) instead of
 *   growing without bound, and the caller is told how much was left out.
 *
 * Exposes `DetectLabRomanRoadsParser` (worker: imported with importScripts,
 * page: a plain <script>; node: attached to the vm global).
 * ========================================================================== */
(function (root) {
    'use strict';
    if (!root) return;

    var VERSION = '20261015-roman-roads-v1';

    /* ── Web Mercator (EPSG:3857) ──────────────────────────────────────────
       Everything downstream works in Mercator metres: the trigonometry is
       paid once per vertex here (off the main thread, in the worker) and the
       canvas only ever does a multiply-add per vertex per frame. */
    var R = 6378137;
    var WORLD = 2 * Math.PI * R;              /* 40 075 016.686 m */
    var HALF_WORLD = Math.PI * R;
    var PX_A = 0.5 / (Math.PI * R);           /* normalized mercator → [0,1] */
    var MAX_LAT = 89.9999999;
    var DEG = Math.PI / 180;

    function mercX(lng) { return R * lng * DEG; }
    function mercY(lat) {
        if (lat > MAX_LAT) lat = MAX_LAT;
        else if (lat < -MAX_LAT) lat = -MAX_LAT;
        return R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
    }
    function invMercX(x) { return (x / R) / DEG; }
    function invMercY(y) { return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG; }

    /* ── default budget ────────────────────────────────────────────────────
       `maxBytes` is the *geometry* budget per dataset (not a promise about
       the whole page). Desktops can hold more than phones before the renderer
       starts swapping, so the page picks a profile in
       `DetectLabRomanRoads.configForDevice()`. */
    var DEFAULTS = {
        maxBytes: 96 * 1024 * 1024,
        maxSegments: 900000,
        maxVertices: 9000000,
        maxVerticesPerSegment: 6000,   /* RDP epsilon is raised until it fits  */
        maxBatchSegments: 6000,        /* one transferable payload per batch   */
        simplifyMeters: 0.35,          /* RDP tolerance: sub-pixel at z19-20   */
        minVertexDistMeters: 0.6,      /* consecutive duplicates / noise       */
        gridZoom: 11,                  /* 19.6 km cells — see the header       */
        spanRatio: 0.5,                /* bbox > half a cell → `spanItems`     */
        projected: 'auto'              /* 'auto' | 'lnglat' | 'mercator'       */
    };

    function config(overrides) {
        var out = {}, k;
        for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) out[k] = DEFAULTS[k];
        if (overrides) for (k in overrides) {
            if (Object.prototype.hasOwnProperty.call(overrides, k) && overrides[k] !== undefined) out[k] = overrides[k];
        }
        return out;
    }

    /* ── geometry extraction (unchanged from js/map-app.js) ──────────────── */

    function wktPaths(wkt) {
        var out = [], re = /\(([^()]+)\)/g, m;
        while ((m = re.exec(wkt))) {
            var pts = m[1].split(',').map(function (s) {
                return s.trim().split(/\s+/).map(Number);
            }).filter(function (a) { return a.length >= 2 && !a.some(isNaN); });
            if (pts.length > 1) out.push(pts);
        }
        return out;
    }

    function toPaths(g) {
        if (!g) return [];
        if (typeof g === 'string') {
            var t = g.trim();
            if (!t) return [];
            if (t[0] === '{') {
                try { return toPaths(JSON.parse(t)); } catch (e) { return []; }
            }
            return /LINESTRING|MULTILINESTRING/i.test(t) ? wktPaths(t) : [];
        }
        if (Array.isArray(g) || (g.buffer && g.length !== undefined && typeof g[0] === 'number')) {
            var arr = Array.isArray(g) ? g : Array.prototype.slice.call(g);
            if (arr.length && typeof arr[0][0] === 'number') return [arr];
            if (arr.length && Array.isArray(arr[0]) && typeof arr[0][0][0] === 'number') return arr;
            return [];
        }
        if (typeof g !== 'object') return [];
        switch (g.type) {
            case 'Feature': return toPaths(g.geometry);
            case 'FeatureCollection':
                return (g.features || []).reduce(function (a, f) { return a.concat(toPaths(f)); }, []);
            case 'GeometryCollection':
                return (g.geometries || []).reduce(function (a, x) { return a.concat(toPaths(x)); }, []);
            case 'LineString': return [g.coordinates || []];
            case 'MultiLineString': return g.coordinates || [];
        }
        if (g.paths && Array.isArray(g.paths)) {
            /* ArcGIS JSON (`paths`) is [ring][vertex][x,y] in lng/lat. */
            return g.paths.map(function (p) { return p; });
        }
        return [];
    }

    var RECORD_KEYS = ['geometry', 'geom', 'geojson', 'the_geom', 'wkt', 'shape', 'line',
        'path', 'coordinates', 'coords', 'paths', 'st_astext', 'wkb_geometry'];

    function recordPaths(o) {
        if (!o || typeof o !== 'object') return [];
        var p = toPaths(o);
        if (p.length) return p;
        var srcs = [o, o.properties || {}];
        for (var s = 0; s < srcs.length; s++) {
            for (var k = 0; k < RECORD_KEYS.length; k++) {
                var v = srcs[s][RECORD_KEYS[k]];
                if (v == null) continue;
                try { p = toPaths(v); } catch (e) { p = []; }
                if (p.length) return p;
            }
        }
        return [];
    }

    /* Rows that keep their geometry in plain columns (lon/lat pairs, or a
     * `lat`/`lon` pair per record) are not line geometry; they are handled by
     * `toPoint`, which the collector accepts as a one-vertex "segment". */
    function toPoint(o) {
        if (!o || typeof o !== 'object') return null;
        var keys = ['geometry', 'geom', 'geojson', 'the_geom'];
        for (var i = 0; i < keys.length; i++) {
            var g = o[keys[i]];
            if (g && typeof g === 'object' && g.type === 'Point' && g.coordinates) {
                return [g.coordinates[0], g.coordinates[1]];
            }
            if (g && Array.isArray(g) && g.length >= 2 && typeof g[0] === 'number') return g;
        }
        var lat = o.lat != null ? o.lat : (o.latitude != null ? o.latitude : o.reprLat);
        var lng = o.lon != null ? o.lon : (o.lng != null ? o.lng : (o.longitude != null ? o.longitude : o.reprLong));
        if (lat != null && lng != null && isFinite(+lat) && isFinite(+lng)) return [+lng, +lat];
        return null;
    }

    /* ── simplification ──────────────────────────────────────────────────── */

    /* Iterative Ramer–Douglas–Peucker over a flat [x0,y0,x1,y1,…] array.
     * Writes a keep-mask (`Uint8Array`) in place of a recursive allocation
     * storm; the endpoints are always kept. */
    function rdpMask(flat, count, eps) {
        var keep = new Uint8Array(count);
        keep[0] = 1;
        keep[count - 1] = 1;
        if (count <= 2) return keep;
        var eps2 = eps * eps;
        var stack = [0, count - 1];
        while (stack.length) {
            var last = stack.pop(), first = stack.pop();
            var ax = flat[first * 2], ay = flat[first * 2 + 1];
            var bx = flat[last * 2], by = flat[last * 2 + 1];
            var dx = bx - ax, dy = by - ay;
            var len2 = dx * dx + dy * dy;
            var maxD = -1, maxI = -1;
            for (var i = first + 1; i < last; i++) {
                var px = flat[i * 2] - ax, py = flat[i * 2 + 1] - ay;
                var d;
                if (len2 === 0) {
                    d = px * px + py * py;
                } else {
                    var t = (px * dx + py * dy) / len2;
                    if (t < 0) t = 0; else if (t > 1) t = 1;
                    var qx = px - t * dx, qy = py - t * dy;
                    d = qx * qx + qy * qy;
                }
                if (d > maxD) { maxD = d; maxI = i; }
            }
            if (maxD > eps2 && maxI > 0) {
                keep[maxI] = 1;
                stack.push(first, maxI, maxI, last);
            }
        }
        return keep;
    }

    /* ── the collector ───────────────────────────────────────────────────── */

    function createCollector(overrides) {
        var cfg = config(overrides);
        var cellSize = WORLD / Math.pow(2, cfg.gridZoom);
        var spanLimit = cellSize * cfg.spanRatio;
        var gridN = Math.pow(2, cfg.gridZoom);

        var cap = 4096, n = 0;                       /* segments */
        var origins = new Float64Array(cap * 2);
        var starts = new Uint32Array(cap + 1);
        var bounds = new Float32Array(cap * 4);
        var vcap = cap * 16, vn = 0;                 /* vertices */
        var deltas = new Float32Array(vcap * 2);
        var cellOf = new Uint32Array(cap);           /* grid cell per segment */
        var isSpan = new Uint8Array(cap);
        /* `n`/`vn` count the batch being filled; these two count what has
         * already been handed to the caller through flush(). Budgets apply to
         * the sum, otherwise every batch would start with a fresh allowance. */
        var emittedN = 0, emittedVn = 0;
        var stride = 1;                              /* sampling stride */
        var seen = 0, sampled = 0, skipped = 0, longKept = 0;
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        var projected = cfg.projected === 'mercator' ? true
            : (cfg.projected === 'lnglat' ? false : null);

        function growSegments() {
            var next = cap * 2;
            var o2 = new Float64Array(next * 2); o2.set(origins); origins = o2;
            var s2 = new Uint32Array(next + 1); s2.set(starts); starts = s2;
            var b2 = new Float32Array(next * 4); b2.set(bounds); bounds = b2;
            var c2 = new Uint32Array(next); c2.set(cellOf); cellOf = c2;
            var t2 = new Uint8Array(next); t2.set(isSpan); isSpan = t2;
            cap = next;
        }

        function growVertices(need) {
            if (vn + need <= vcap) return;
            var next = vcap;
            while (next < vn + need) next *= 2;
            var d2 = new Float32Array(next * 2); d2.set(deltas); deltas = d2;
            vcap = next;
        }

        /* Bytes the *caller* is holding after every batch so far, estimated
         * with the same per-segment/per-vertex cost. This is what the memory
         * budget must watch: the payloads have been transferred to the layer,
         * so the collector's own arrays stay small while the map grows. */
        function totalBytes() {
            return (emittedN + n) * (16 + 4 + 4 + 16) + (emittedVn + vn) * 8;
        }

        function heldSegments() { return emittedN + n; }
        function heldVertices() { return emittedVn + vn; }

        /* Uniform sampling: keep every `stride`-th record (and every long
         * road). Called when the byte budget is reached — memory stays flat
         * instead of the tab dying, and what is kept stays representative
         * instead of being "the first N km of the file". */
        function compact(newStride) {
            var w = 0, wv = 0;
            for (var i = 0; i < n; i++) {
                var keepSeg = isSpan[i] ? 1 : ((i % newStride) === 0 ? 1 : 0);
                if (!keepSeg) { sampled++; continue; }
                var from = starts[i], to = starts[i + 1], cnt = to - from;
                if (w !== i) {
                    origins[w * 2] = origins[i * 2];
                    origins[w * 2 + 1] = origins[i * 2 + 1];
                    bounds[w * 4] = bounds[i * 4];
                    bounds[w * 4 + 1] = bounds[i * 4 + 1];
                    bounds[w * 4 + 2] = bounds[i * 4 + 2];
                    bounds[w * 4 + 3] = bounds[i * 4 + 3];
                    isSpan[w] = isSpan[i];
                }
                if (wv !== from) {
                    deltas.copyWithin(wv * 2, from * 2, to * 2);
                }
                starts[w] = wv;
                wv += cnt;
                w++;
            }
            starts[w] = wv;
            n = w;
            vn = wv;
            stride = newStride;
        }

        function underBudget() {
            return heldSegments() < cfg.maxSegments && heldVertices() < cfg.maxVertices &&
                totalBytes() < cfg.maxBytes;
        }

        /* ── how hard to thin the arrivals ────────────────────────────────────
         * The stream tells us how many source bytes it has already consumed and
         * how many it is going to consume, so `seen / (srcSeen / srcTotal)` is
         * a running estimate of the total number of features. Keeping one
         * record in `est / maxSegments` turns the kept set into a uniform
         * sample of the whole file, from the first batch on: the alternative
         * (fill up, then stop) would keep the first N km of the export and drop
         * the rest — exactly what a user zoomed into the far end would notice.
         * The estimate is good after the first chunk and improves from there. */
        var srcTotal = 0, srcSeen = 0;
        function setSourceTotal(bytes) { if (bytes > 0) srcTotal = bytes; }
        function noteSourceBytes(bytes) { if (bytes > 0) srcSeen += bytes; }

        function plannedStride() {
            if (srcTotal > 0 && srcSeen > 0 && seen > 0) {
                var frac = Math.min(1, srcSeen / srcTotal);
                if (frac > 0.002) {
                    var est = seen / frac;
                    if (est > cfg.maxSegments) return Math.max(1, Math.round(est / cfg.maxSegments));
                }
                return 1;
            }
            /* No stream size to estimate from (chunked response): ramp the
             * rate as the budget fills, and let the hard stop below catch it. */
            var held = heldSegments();
            if (held < cfg.maxSegments) return 1;
            return Math.max(2, Math.ceil(held / cfg.maxSegments));
        }

        /* Push one already-validated path (`pts` = [[lonOrX, latOrY], …]).
         * Returns true when the path was stored, false when it was dropped. */
        function addPath(pts, index) {
            if (!pts || pts.length < 2) return false;
            if (projected === null) projected = looksProjected(pts);

            /* project + drop noise/dedup in one pass */
            var flat = new Float64Array(pts.length * 2);
            var m = 0;
            var px = 0, py = 0;
            for (var i = 0; i < pts.length; i++) {
                var c = pts[i];
                if (!c || c.length < 2) continue;
                var a = +c[0], b = +c[1];
                if (!isFinite(a) || !isFinite(b)) continue;
                var x = projected ? a : mercX(a);
                var y = projected ? b : mercY(b);
                if (m > 0) {
                    var ddx = x - px, ddy = y - py;
                    if (ddx * ddx + ddy * ddy < cfg.minVertexDistMeters * cfg.minVertexDistMeters) continue;
                }
                flat[m * 2] = x;
                flat[m * 2 + 1] = y;
                px = x; py = y;
                m++;
            }
            if (m < 2) return false;

            /* RDP — and, for a path that is still huge, a raised tolerance so
             * one monster feature cannot blow the vertex budget on its own. */
            var eps = cfg.simplifyMeters;
            var keep = rdpMask(flat, m, eps);
            var kept = 0;
            for (var k = 0; k < m; k++) if (keep[k]) kept++;
            var guard = 0;
            while (kept > cfg.maxVerticesPerSegment && guard++ < 12) {
                eps *= 2;
                keep = rdpMask(flat, m, eps);
                kept = 0;
                for (var k2 = 0; k2 < m; k2++) if (keep[k2]) kept++;
            }

            /* write */
            if (n + 1 > cap) growSegments();
            growVertices(kept);
            var ox = flat[0], oy = flat[1];
            origins[n * 2] = ox;
            origins[n * 2 + 1] = oy;
            var v = starts[n];
            var loX = Infinity, loY = Infinity, hiX = -Infinity, hiY = -Infinity;
            for (var j = 0; j < m; j++) {
                if (!keep[j]) continue;
                var gx = flat[j * 2], gy = flat[j * 2 + 1];
                deltas[v * 2] = gx - ox;
                deltas[v * 2 + 1] = gy - oy;
                if (gx < loX) loX = gx;
                if (gx > hiX) hiX = gx;
                if (gy < loY) loY = gy;
                if (gy > hiY) hiY = gy;
                v++;
            }
            starts[n + 1] = v;
            vn = v;
            bounds[n * 4] = loX;
            bounds[n * 4 + 1] = loY;
            bounds[n * 4 + 2] = hiX;
            bounds[n * 4 + 3] = hiY;
            if (loX < minX) minX = loX;
            if (hiX > maxX) maxX = hiX;
            if (loY < minY) minY = loY;
            if (hiY > maxY) maxY = hiY;

            /* grid cell: by bbox centre, so a segment lives in exactly one
             * cell and never gets drawn twice; long ones go to `spanItems`. */
            var halfW = (hiX - loX) / 2, halfH = (hiY - loY) / 2;
            var cx = Math.floor((loX + halfW + HALF_WORLD) / cellSize);
            var cy = Math.floor((loY + halfH + HALF_WORLD) / cellSize);
            if (cx < 0) cx = 0; else if (cx > gridN - 1) cx = gridN - 1;
            if (cy < 0) cy = 0; else if (cy > gridN - 1) cy = gridN - 1;
            cellOf[n] = cy * gridN + cx;
            /* Written, not just set: the arrays are reused by the next batch,
             * so a stale flag here would draw the new segment twice. */
            if (halfW > spanLimit || halfH > spanLimit) { isSpan[n] = 1; longKept++; }
            else isSpan[n] = 0;
            n++;
            return true;
        }

        /* One source record or one geometry object. */
        function addRecord(record) {
            if (!record) return 0;
            var paths = recordPaths(record);
            if (!paths.length) {
                var pt = toPoint(record);
                if (pt) {
                    /* A lone point is not a road, but a dataset that stores
                     * roads as vertex rows (one record per vertex) is still
                     * meaningful as a dot cloud — keep it as a 2-point line. */
                    paths = [[pt, pt]];
                } else { skipped++; return 0; }
            }
            var stored = 0;
            var planned = plannedStride();
            if (planned > stride) stride = planned;
            for (var i = 0; i < paths.length; i++) {
                seen++;
                var pts = paths[i];
                /* Long roads — the ones that still read at low zoom — always
                 * get through, whatever the budget says. */
                if (!longPath(pts)) {
                    if (heldSegments() > cfg.maxSegments * 2 ||
                        heldVertices() > cfg.maxVertices * 2) { sampled++; continue; }
                    if (stride > 1) {
                        /* Uniform 1:stride sample of the whole stream. */
                        if ((seen % stride) !== 0) { sampled++; continue; }
                    } else if (!underBudget()) {
                        sampled++;
                        continue;
                    }
                }
                if (addPath(pts, seen)) stored++;
            }
            /* A single batch that has grown past the flush size on its own
             * (very long features) is thinned in place — earlier batches
             * already belong to the caller and cannot be compacted. */
            if (n > cfg.maxBatchSegments * 2 && stride < 64) compact(stride * 2);
            return stored;
        }

        function longPath(pts) {
            if (!pts || pts.length < 2) return false;
            var a = pts[0], b = pts[pts.length - 1];
            if (!a || !b) return false;
            var x0 = projected === false ? mercX(+a[0]) : +a[0];
            var y0 = projected === false ? mercY(+a[1]) : +a[1];
            var x1 = projected === false ? mercX(+b[0]) : +b[0];
            var y1 = projected === false ? mercY(+b[1]) : +b[1];
            var dx = x1 - x0, dy = y1 - y0;
            return (dx * dx + dy * dy) > 9e6;      /* ≥ 3 km */
        }

        function looksProjected(pts) {
            for (var i = 0; i < pts.length && i < 8; i++) {
                var c = pts[i];
                if (!c || c.length < 2) continue;
                if (Math.abs(+c[0]) > 360 || Math.abs(+c[1]) > 90.5) return true;
            }
            return false;
        }

        /* Close the current batch: exact-size copies + the CSR grid index.
         * The result is `{ payload, transfer }` — postMessage(payload, transfer)
         * moves the buffers, so the worker never blocks on a copy. */
        function flush() {
            if (!n) return null;
            var segN = n;
            var vertN = vn;
            var o = origins.slice(0, segN * 2);
            var d = deltas.slice(0, vn * 2);
            var s = starts.slice(0, segN + 1);
            var b = bounds.slice(0, segN * 4);

            /* CSR grid: sort the segment indices by cell, then group. */
            var idx = new Uint32Array(segN);
            var i;
            for (i = 0; i < segN; i++) idx[i] = i;
            var cellOfSlice = cellOf.slice(0, segN);
            var spanList = [];
            for (i = 0; i < segN; i++) if (isSpan[i]) spanList.push(i);
            idx.sort(function (a, b2) { return cellOfSlice[a] - cellOfSlice[b2]; });
            /* CSR: `cellStart[g]` is the first item of group g and
             * `cellStart[g + 1]` the first item after it, so a search for the
             * groups of one grid row is `items[cellStart[lo] … cellStart[hi]]`.
             * Getting this off by one silently resolves every lookup to an
             * empty range — the tiles then paint nothing at all. */
            var cellKeys = [], cellStart = [0], cellItems = new Uint32Array(segN);
            var j = 0, lastKey = -1;
            for (i = 0; i < segN; i++) {
                var si = idx[i], key = cellOfSlice[si];
                if (key !== lastKey) {
                    if (i > 0) cellStart.push(j);
                    cellKeys.push(key);
                    lastKey = key;
                }
                cellItems[j++] = si;
            }
            cellStart.push(j);

            var payload = {
                version: 1,
                parser: VERSION,
                n: segN,
                vertices: vn,
                origins: o,
                deltas: d,
                starts: s,
                bounds: b,
                cellZoom: cfg.gridZoom,
                cellSize: cellSize,
                cellKeys: Uint32Array.from(cellKeys),
                cellStart: Uint32Array.from(cellStart),
                cellItems: cellItems,
                spanItems: Uint32Array.from(spanList),
                extent: [minX, minY, maxX, maxY],
                stats: {
                    seen: seen,
                    skipped: skipped,
                    sampled: sampled,
                    stride: stride,
                    longKept: longKept,
                    projected: !!projected
                }
            };
            /* Start a fresh batch. Without this the next flush would hand the
             * caller a payload containing every segment again (the writes
             * continue at index `n`), so the layer would silently grow
             * quadratically — the stream "worked" but the tab died. */
            emittedN += segN;
            emittedVn += vertN;
            n = 0;
            vn = 0;
            starts[0] = 0;

            return { payload: payload, transfer: [o.buffer, d.buffer, s.buffer, b.buffer,
                payload.cellKeys.buffer, payload.cellStart.buffer, payload.cellItems.buffer,
                payload.spanItems.buffer] };
        }

        /* Totals for the whole stream, not just the batch in hand: this is what
         * the status line and the memory watchdog read. */
        function stats() {
            return {
                segments: heldSegments(), vertices: heldVertices(),
                bytes: totalBytes(), seen: seen,
                skipped: skipped, sampled: sampled, stride: stride,
                projected: !!projected,
                extent: heldSegments() ? [minX, minY, maxX, maxY] : null
            };
        }

        function isFull() { return !underBudget(); }
        function shouldFlush() { return n >= cfg.maxBatchSegments; }

        return {
            addRecord: addRecord,
            addPath: function (pts) { seen++; return addPath(pts, seen); },
            flush: flush,
            stats: stats,
            config: cfg,
            isFull: isFull,
            shouldFlush: shouldFlush,
            setSourceTotal: setSourceTotal,
            noteSourceBytes: noteSourceBytes
        };
    }

    root.DetectLabRomanRoadsParser = {
        version: VERSION,
        R: R,
        WORLD: WORLD,
        PX_A: PX_A,
        mercX: mercX,
        mercY: mercY,
        invMercX: invMercX,
        invMercY: invMercY,
        wktPaths: wktPaths,
        toPaths: toPaths,
        recordPaths: recordPaths,
        toPoint: toPoint,
        rdpMask: rdpMask,
        createCollector: createCollector,
        DEFAULTS: DEFAULTS,
        config: config
    };
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this));
