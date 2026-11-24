#!/usr/bin/env node
'use strict';
/*
 * TRAIN heatmap crash at display time (phones): polygonising the scored grid
 * subtracted one polygon-clipping rectangle per exclusion-mask run — the
 * outside-circle cells, every UAT blob and a disc per known site. A realistic
 * 1024 x 1024 TRAIN mask has tens of thousands of those rings, and the boolean
 * op allocated a few hundred MB inside the worker right when the result was
 * about to be shown, which killed a phone renderer.
 *
 *   node test-apm-heatmap-crash.js
 *
 * No network: the real apm-polygonise module runs against synthetic score
 * fields and masks. Checks three things:
 *   1. the mask contract still holds (no forbidden land in any output ring);
 *   2. a realistic TRAIN mask stays inside a small time/heap budget and never
 *      feeds polygon-clipping a large clipping geometry again;
 *   3. the fix is wired into the worker, the panel and the PWA shell cache.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const vm = require('node:vm');

const ROOT = __dirname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const core = require('./js/apm-next/apm-core.js');
const raster = require('./js/apm-next/apm-raster.js');
const polygons = require('./js/apm-next/apm-polygonise.js');
const pc = require('./js/vendor/polygon-clipping.umd.min.js');

const THRESHOLDS = { medium: 0.55, high: 0.7, veryhigh: 0.85 };
const BAND_TAG = '20261102-apm-mask-band';
const EPS = 1e-6;                       // cell-fraction tolerance for "strictly inside"
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* ── 1. Mask contract: forbidden land never appears in the output ─────────── */

function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if (((a[1] > lat) !== (b[1] > lat)) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
}
function pointInPolygon(lon, lat, rings) {
    if (!pointInRing(lon, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) if (pointInRing(lon, lat, rings[h])) return false;
    return true;
}
function ringArea(ring) {
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return Math.abs(s / 2);
}
function intersectionArea(geom) {
    if (!geom || !geom.length) return 0;
    if (typeof geom[0][0][0] === 'number') return ringArea(geom[0]);
    if (typeof geom[0][0][0][0] === 'number') {
        return geom.reduce((sum, poly) => sum + poly.reduce((s, ring, i) => s + ringArea(ring) * (i ? -1 : 1), 0), 0);
    }
    return geom.reduce((sum, g) => sum + intersectionArea(g), 0);
}

/** No forbidden cell centre inside a polygon, no segment strictly inside a
 *  forbidden cell (edge-grazing is legal: that is where a clipped ring sits),
 *  and no measurable polygon-clipping area overlap with sampled cells. */
function assertMaskContract(name, grid, score, mask, opts) {
    const w = grid.w, h = grid.h;
    const fc = polygons.polygonise(score, grid, THRESHOLDS,
        Object.assign({ minAreaM2: 0, exclusionMask: mask }, opts));
    const offenders = [];
    for (let j = 0; j < h && offenders.length < 3; j++) {
        for (let i = 0; i < w && offenders.length < 3; i++) {
            if (!mask[j * w + i]) continue;
            const lon = grid.west + (i + 0.5) * grid.dLon, lat = grid.north - (j + 0.5) * grid.dLat;
            if (fc.features.some(f => pointInPolygon(lon, lat, f.geometry.coordinates)))
                offenders.push('centre ' + i + ',' + j);
        }
    }
    for (const f of fc.features) {
        for (const ring of f.geometry.coordinates) {
            for (let k = 0; k + 1 < ring.length && offenders.length < 6; k++) {
                const a = ring[k], b = ring[k + 1];
                const ai = (a[0] - grid.west) / grid.dLon, aj = (grid.north - a[1]) / grid.dLat;
                const bi = (b[0] - grid.west) / grid.dLon, bj = (grid.north - b[1]) / grid.dLat;
                const steps = Math.max(1, Math.ceil(Math.hypot(bi - ai, bj - aj) / 0.2));
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps, fi = ai + (bi - ai) * t, fj = aj + (bj - aj) * t;
                    const ci = Math.floor(fi), cj = Math.floor(fj);
                    if (ci < 0 || cj < 0 || ci >= w || cj >= h || !mask[cj * w + ci]) continue;
                    const frI = fi - ci, frJ = fj - cj;
                    if (frI > EPS && frI < 1 - EPS && frJ > EPS && frJ < 1 - EPS) {
                        offenders.push('segment through ' + ci + ',' + cj);
                        break;
                    }
                }
            }
        }
    }
    const cells = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (mask[j * w + i]) cells.push([i, j]);
    const stride = Math.max(1, Math.floor(cells.length / 300));
    for (let k = 0; k < cells.length && offenders.length < 6; k += stride) {
        const [i, j] = cells[k];
        const x0 = grid.west + i * grid.dLon, x1 = x0 + grid.dLon;
        const y1 = grid.north - j * grid.dLat, y0 = y1 - grid.dLat;
        const rect = [[[[x0, y1], [x1, y1], [x1, y0], [x0, y0], [x0, y1]]]];
        for (const f of fc.features) {
            try {
                if (intersectionArea(pc.intersection([f.geometry.coordinates], rect)) > 1e-9) {
                    offenders.push('area overlap ' + i + ',' + j);
                    break;
                }
            } catch (e) { /* ignore a clipping hiccup on a degenerate ring */ }
        }
    }
    assert.deepEqual(offenders, [], name + ': ' + offenders.join('; '));
    return fc;
}

function gridFor(w, h) { return { w, h, west: 23.0, north: 47.0, dLon: 0.001, dLat: 0.0008 }; }

function smoothScore(grid, seed) {
    const out = new Float32Array(grid.w * grid.h);
    let z = seed;
    const rnd = () => ((z = (1664525 * z + 1013904223) >>> 0) / 4294967296);
    const ctrl = [];
    for (let k = 0; k < 40; k++) ctrl.push([rnd() * grid.w, rnd() * grid.h, rnd()]);
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
        let v = 0, sum = 0;
        for (const [cx, cy, cv] of ctrl) {
            const d = Math.hypot(i - cx, j - cy) + 1;
            v += cv / (d * d); sum += 1 / (d * d);
        }
        out[j * grid.w + i] = Math.min(1, Math.max(0, v / sum * 3));
    }
    return out;
}

test('a one-cell forbidden hole survives smoothing and area filtering', () => {
    const g = gridFor(24, 24);
    const score = new Float32Array(24 * 24).fill(1);
    const mask = new Uint8Array(24 * 24);
    mask[12 * 24 + 12] = 1;
    score[12 * 24 + 12] = NaN;
    const fc = assertMaskContract('single cell', g, score, mask,
        { highestOnly: true, smoothIters: 2, minAreaM2: 500 });
    assert.ok(fc.features.length, 'the surrounding hotspot remains');
    const hole = fc.features[0].geometry.coordinates.find(ring => ring.length > 8);
    assert.ok(hole, 'the hole is still a separate ring');
    assert.ok(raster.ringAreaM2(hole) > 500,
        'the one-cell band grows the hole past the 500 m² fragment filter (' +
        Math.round(raster.ringAreaM2(hole)) + ' m²)');
});

test('adversarial masks never leak into the exported polygons (highest-only)', () => {
    const g = gridFor(200, 200);
    const base = smoothScore(g, 99);
    const patterns = {
        'thin lines': (i, j) => i % 37 === 5 || j % 41 === 9,
        'checkerboard': (i, j) => (i + j) % 2 === 0 && i % 7 < 3,
        'diagonal chain': (i, j) => Math.abs(i - j) < 2 || Math.abs(i + j - 200) < 2,
        'single cells': (i, j) => i % 13 === 3 && j % 17 === 7,
        'discs': (i, j) => ((i % 31) - 15) ** 2 + ((j % 29) - 14) ** 2 < 64
    };
    for (const [name, fn] of Object.entries(patterns)) {
        const mask = new Uint8Array(200 * 200);
        const score = Float32Array.from(base);
        for (let j = 0; j < 200; j++) for (let i = 0; i < 200; i++)
            if (fn(i, j)) { mask[j * 200 + i] = 1; score[j * 200 + i] = NaN; }
        assertMaskContract(name, g, score, mask, { highestOnly: true, smoothIters: 1 });
        assertMaskContract(name + ' (all classes)', g, score, mask, { highestOnly: false, smoothIters: 1 });
    }
});

test('protection discs stay out of results whether or not scores were computed under them', () => {
    const g = gridFor(300, 300);
    const base = smoothScore(g, 7);
    const mask = new Uint8Array(300 * 300);
    for (let cy = 50; cy < 300; cy += 80) for (let cx = 50; cx < 300; cx += 90)
        for (let j = cy - 12; j <= cy + 12; j++) for (let i = cx - 12; i <= cx + 12; i++)
            if (i >= 0 && j >= 0 && i < 300 && j < 300 && (i - cx) ** 2 + (j - cy) ** 2 <= 144)
                mask[j * 300 + i] = 2;
    const withNaN = Float32Array.from(base);
    for (let i = 0; i < mask.length; i++) if (mask[i]) withNaN[i] = NaN;
    assertMaskContract('discs, score NaN', g, withNaN, mask, { highestOnly: true, smoothIters: 1 });
    assertMaskContract('discs, score present', g, base, mask, { highestOnly: true, smoothIters: 1 });
});

/* ── 2. A realistic TRAIN mask stays small, fast and out of polygon-clipping ─ */

function realisticMask(grid) {
    const LAT = 46.77, LON = 23.59, R = 50000;
    const mpd = core.metresPerDegree(LAT);
    const mask = new Uint8Array(grid.w * grid.h);
    let seed = 7;
    const rnd = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
    const protect = [];
    for (let k = 0; k < 1200; k++) {                       // one protection disc per site
        const r = 48000 * Math.sqrt(rnd()), th = rnd() * 2 * Math.PI;
        const sLat = LAT + r * Math.cos(th) / 111320;
        const sLon = LON + r * Math.sin(th) / (111320 * Math.cos(LAT * Math.PI / 180));
        protect.push([Math.round((sLon - grid.west) / grid.dLon),
            Math.round((grid.north - sLat) / grid.dLat),
            Math.ceil(700 / (grid.dLon * mpd.lon))]);
    }
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
        const x = (grid.west + (i + 0.5) * grid.dLon - LON) * mpd.lon;
        const y = (grid.north - (j + 0.5) * grid.dLat - LAT) * mpd.lat;
        let v = 0;
        if (x * x + y * y > R * R) v = 1;                  // outside the search circle
        else if (i % 41 === 5 && j % 37 < 4) v = 1;        // UAT built-up blobs
        else for (const p of protect) {
            const dx = i - p[0], dy = j - p[1];
            if (dx * dx + dy * dy <= p[2] * p[2]) { v = 2; break; }
        }
        if (v) mask[j * grid.w + i] = v;
    }
    return mask;
}

function collectHeap() {
    try {
        v8.setFlagsFromString('--expose_gc');
        const gc = vm.runInNewContext('gc');
        v8.setFlagsFromString('--no-expose_gc');
        gc();
        return gc;
    } catch (e) { return null; }
}

test('a realistic TRAIN mask polygonises inside a phone-sized budget', () => {
    const bbox = core.circleBBox(46.77, 23.59, 53000);
    const grid = raster.boundedGridForBBox(bbox, 25);
    assert.ok(grid.w * grid.h <= raster.MAX_PREDICTION_CELLS, 'bounded prediction grid');
    const n = grid.w * grid.h;
    const score = new Float32Array(n);
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
        const dx = (i - grid.w / 2) / grid.w, dy = (j - grid.h / 2) / grid.h;
        score[j * grid.w + i] = Math.min(1, Math.max(0,
            0.5 + 0.45 * Math.exp(-(dx * dx + dy * dy) * 12) + 0.1 * Math.sin(i / 31) * Math.cos(j / 27)));
    }
    const mask = realisticMask(grid);
    let excluded = 0;
    for (let i = 0; i < n; i++) if (mask[i]) excluded++;
    assert.ok(excluded > n * 0.3, 'the fixture really is a heavily masked window: ' + excluded);

    const originalDifference = pc.difference;
    let calls = 0, maxRings = 0;
    const countRings = g => {
        if (!g || !g.length) return 0;
        if (typeof g[0][0][0] === 'number') return 1;               // polygon → one ring list
        if (typeof g[0][0][0][0] === 'number') return g.reduce((s, poly) => s + poly.length, 0);
        return g.reduce((s, part) => s + countRings(part), 0);
    };
    pc.difference = function (a, b) { calls++; maxRings = Math.max(maxRings, countRings(b)); return originalDifference.apply(this, arguments); };
    const gc = collectHeap();
    const before = gc ? process.memoryUsage().heapUsed : 0;
    const t0 = Date.now();
    let fc;
    try {
        fc = polygons.polygonise(score, grid, THRESHOLDS,
            { highestOnly: true, minAreaM2: 2500, smoothIters: 1, exclusionMask: mask });
    } finally {
        pc.difference = originalDifference;
    }
    const elapsed = Date.now() - t0;
    if (gc) gc();
    const delta = gc ? process.memoryUsage().heapUsed - before : 0;

    assert.equal(calls, 0,
        'the production path never calls polygon-clipping with the mask (got ' + calls + ')');
    assert.ok(fc.features.length >= 0, 'a FeatureCollection comes back');
    assert.ok(elapsed < 3000, 'polygonising stays fast: ' + elapsed + ' ms');
    if (gc) assert.ok(delta < 64 * 1024 * 1024,
        'heap stays phone-sized: ' + (delta / 1048576).toFixed(1) + ' MB (was ~230 MB)');
    console.log('       ' + grid.w + 'x' + grid.h + ' grid, ' + excluded + ' excluded cells, ' +
        fc.features.length + ' features, ' + elapsed + ' ms' +
        (gc ? ', heap Δ ' + (delta / 1048576).toFixed(1) + ' MB' : ''));
});

test('the legacy class path also stays clear of large clipping geometries', () => {
    const g = gridFor(400, 400);
    const score = smoothScore(g, 21);
    const mask = new Uint8Array(400 * 400);
    for (let j = 0; j < 400; j++) for (let i = 0; i < 400; i++)
        if (i % 53 === 7 || (i % 17 === 4 && j % 19 < 6)) mask[j * 400 + i] = 1;
    const originalDifference = pc.difference;
    let maxRings = 0;
    const countRings = g2 => {
        if (!g2 || !g2.length) return 0;
        if (typeof g2[0][0][0] === 'number') return 1;
        if (typeof g2[0][0][0][0] === 'number') return g2.reduce((s, poly) => s + poly.length, 0);
        return g2.reduce((s, part) => s + countRings(part), 0);
    };
    pc.difference = function (a, b) { maxRings = Math.max(maxRings, countRings(b)); return originalDifference.apply(this, arguments); };
    try {
        polygons.polygonise(score, g, THRESHOLDS,
            { highestOnly: false, minAreaM2: 0, smoothIters: 1, exclusionMask: mask });
    } finally {
        pc.difference = originalDifference;
    }
    assert.ok(maxRings < 1024,
        'class-vs-class diffs only ever see contour regions, not mask runs (max ' + maxRings + ' rings)');
});

/* ── 3. Wiring: worker, panel and PWA shell carry the fix ──────────────────── */

test('the band-based polygoniser is what the phone actually downloads', () => {
    const worker = read('js/apm-next/apm-worker.js');
    const ui = read('js/apm-next/apm-ui.js');
    const sw = read('sw.js');
    const src = read('js/apm-next/apm-polygonise.js');
    assert.ok(worker.includes("'apm-polygonise.js?v=" + BAND_TAG + "'"), 'worker imports the re-tagged polygoniser');
    assert.ok(ui.includes('apm-worker.js?v=20261124-arch-report-fast'), 'panel starts the latest re-tagged worker');
    assert.ok(sw.includes('js/apm-next/apm-worker.js?v=20261124-arch-report-fast'), 'latest worker precached');
    assert.ok(sw.includes('js/apm-next/apm-worker.js?v=' + BAND_TAG), 'older worker stays precached');
    assert.ok(sw.includes('js/apm-next/apm-polygonise.js?v=' + BAND_TAG), 'new polygoniser precached');
    // Older tags stay precached so shells that have not refreshed keep working.
    assert.ok(sw.includes('js/apm-next/apm-worker.js?v=20261102-apm-continuous-heat'));
    assert.ok(sw.includes('js/apm-next/apm-polygonise.js?v=20261101-train-source'));
    assert.ok(Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]) >= 396,
        'shell cache moved so installed PWAs pick the fix up');
    assert.ok(!src.includes('exclusionRectangles'),
        'the per-run rectangle builder is gone from the polygoniser');
    assert.match(src, /applyExclusionBand/);
});

console.log('\n' + passed + ' heatmap crash checks passed.');
