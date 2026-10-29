#!/usr/bin/env node
'use strict';

/*
 * Next-Gen APM (js/apm-next/*) — unit, worker and synthetic end-to-end tests.
 *   node test-apm-next.js
 * No network: the synthetic world is generated in memory with a seeded RNG.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const core = require('./js/apm-next/apm-core.js');
const raster = require('./js/apm-next/apm-raster.js');
const poly = require('./js/apm-next/apm-polygonise.js');
const sites = require('./js/apm-next/apm-sites.js');
const prov = require('./js/apm-next/apm-providers.js');
const pipeline = require('./js/apm-next/apm-pipeline.js');
const RBush = require('./js/rbush.min.js');

let passed = 0, failed = 0;
const failures = [];
// Async tests run one after another (they share the providers' fetch stub and scheduler); the
// summary waits for the queue to drain.
let asyncChain = Promise.resolve();
function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            asyncChain = asyncChain.then(() => r).then(() => { passed++; console.log('  ok  ' + name); }, (e) => { failed++; failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); });
            return;
        }
        passed++; console.log('  ok  ' + name);
    } catch (e) {
        failed++; failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message);
    }
}

// Deferred: the body runs only when every earlier async test has finished.
function testAsync(name, fn) {
    asyncChain = asyncChain.then(() => fn()).then(() => { passed++; console.log('  ok  ' + name); }, (e) => { failed++; failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); });
}

function rng(seed) {                       // mulberry32
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/* ── 1. Terrain: Horn slope/aspect, latitude correction ─────────────────── */
console.log('Terrain (Horn, cos-latitude correction)');

test('slope on a synthetic ramp at 65°N matches atan(gradient) with metric cell size', () => {
    const bbox = { west: 20, east: 20.2, south: 64.9, north: 65.1 };
    const g = raster.gridForBBox(bbox, 25);
    const mpd = core.metresPerDegree(65);
    const W = g.w, H = g.h, elev = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const xM = (raster.cellLon(g, i) - bbox.west) * mpd.lon;
        elev[j * W + i] = 0.2 * xM;                       // gradient 0.2 m/m eastwards
    }
    const sp = raster.gridSpacingM(g);
    const t = raster.horn(elev, W, H, sp.dx, sp.dy);
    let s = 0, a = 0, n = 0;
    for (let j = 2; j < H - 2; j++) for (let i = 2; i < W - 2; i++) {
        const o = j * W + i; if (t.valid[o]) { s += t.slope[o]; a += t.aspect[o]; n++; }
    }
    const expected = Math.atan(0.2) * 180 / Math.PI;
    assert.ok(Math.abs(s / n - expected) < 0.05, `slope ${s / n} vs ${expected}`);
    assert.ok(Math.abs(a / n - 270) < 0.5, `aspect ${a / n} (ramp falls westward → 270°)`);
});

test('ignoring the cos(latitude) correction gives a clearly wrong slope at 65°N', () => {
    const bbox = { west: 20, east: 20.2, south: 64.9, north: 65.1 };
    const g = raster.gridForBBox(bbox, 25);
    const mpd = core.metresPerDegree(65);
    const W = g.w, H = g.h, elev = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) elev[j * W + i] = 0.2 * (raster.cellLon(g, i) - bbox.west) * mpd.lon;
    const naive = raster.horn(elev, W, H, g.dLon * 111320, g.dLat * 110574);
    let s = 0, n = 0;
    for (let j = 2; j < H - 2; j++) for (let i = 2; i < W - 2; i++) { const o = j * W + i; if (naive.valid[o]) { s += naive.slope[o]; n++; } }
    assert.ok(Math.abs(s / n - 11.31) > 3, 'naive slope should be wrong by several degrees');
});

test('aspect of a north-rising ramp points south (180°)', () => {
    const W = 9, H = 9, e = new Float32Array(W * H);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) e[j * W + i] = (H - j) * 3;  // higher to the north
    const t = raster.horn(e, W, H, 10, 10);
    assert.ok(Math.abs(t.aspect[4 * W + 4] - 180) < 1e-3);
    assert.ok(Math.abs(t.slope[4 * W + 4] - Math.atan(0.3) * 180 / Math.PI) < 1e-3);
});

test('nodata neighbours invalidate the cell', () => {
    const W = 5, H = 5, e = new Float32Array(W * H).fill(10);
    e[1 * W + 1] = -32768;
    const t = raster.horn(e, W, H, 25, 25, { nodata: -32768 });
    assert.strictEqual(t.valid[2 * W + 2], 0);
});

test('light smoothing reduces the spike, keeps the mean roughly', () => {
    const W = 7, H = 7, e = new Float32Array(W * H);
    e[3 * W + 3] = 100;
    const sm = raster.smoothElevation(e, W, H);
    assert.ok(sm[3 * W + 3] < 100 && sm[3 * W + 3] > 20);
});

/* ── 2. Distance transform and water distance ───────────────────────────── */
console.log('Distance transform and water distance');

test('anisotropic EDT is exact (25 m × 10 m cells)', () => {
    const W = 20, H = 20, m = new Uint8Array(W * H);
    m[10 * W + 10] = 1;
    const d = raster.edt(m, W, H, 25, 10);
    assert.ok(Math.abs(d[10 * W + 13] - 75) < 1e-3);
    assert.ok(Math.abs(d[14 * W + 10] - 40) < 1e-3);
    assert.ok(Math.abs(d[14 * W + 13] - Math.hypot(75, 40)) < 1e-3);
});

test('EDT matches brute force on random sources', () => {
    const r = rng(7), W = 30, H = 25, m = new Uint8Array(W * H);
    for (let k = 0; k < 12; k++) m[Math.floor(r() * W * H)] = 1;
    const d = raster.edt(m, W, H, 30, 20);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let best = Infinity;
        for (let q = 0; q < W * H; q++) if (m[q]) {
            const qi = q % W, qj = Math.floor(q / W);
            best = Math.min(best, Math.hypot((i - qi) * 30, (j - qj) * 20));
        }
        assert.ok(Math.abs(d[j * W + i] - best) < 1e-2, `cell ${i},${j}: ${d[j * W + i]} vs ${best}`);
    }
});

test('rbush point-to-water distance matches brute force', () => {
    const r = rng(11);
    const centre = { lat: 52.0, lon: 13.0 };
    const segs = [];
    for (let k = 0; k < 40; k++) {
        const la = centre.lat + (r() - 0.5) * 0.4, lo = centre.lon + (r() - 0.5) * 0.4;
        segs.push(lo, la, lo + (r() - 0.5) * 0.02, la + (r() - 0.5) * 0.02);
    }
    const idx = raster.buildSegmentIndex(RBush, Float64Array.from(segs));
    const mpd = core.metresPerDegree(centre.lat);
    for (let t = 0; t < 30; t++) {
        const lat = centre.lat + (r() - 0.5) * 0.3, lon = centre.lon + (r() - 0.5) * 0.3;
        let best = Infinity;
        const mpdQ = core.metresPerDegree(lat);   // implementation uses the query latitude
        for (let k = 0; k < segs.length; k += 4) {
            // dense sampling as brute-force reference
            for (let s = 0; s <= 400; s++) {
                const u = s / 400;
                const x = segs[k] + u * (segs[k + 2] - segs[k]), y = segs[k + 1] + u * (segs[k + 3] - segs[k + 1]);
                best = Math.min(best, Math.hypot((x - lon) * mpdQ.lon, (y - lat) * mpdQ.lat));
            }
        }
        const got = raster.nearestWaterM(idx, lon, lat);
        assert.ok(Math.abs(got - best) < 0.5 + best * 0.002, `got ${got} vs brute ${best}`);
    }
});

test('rasterised polygon fill covers its interior and not the outside', () => {
    const g = { w: 40, h: 40, west: 0, north: 1, dLon: 0.01, dLat: 0.01 };
    const ring = [[0.1, 0.9], [0.3, 0.9], [0.3, 0.7], [0.1, 0.7], [0.1, 0.9]];
    const m = raster.rasterisePolygons([ring], g);
    assert.strictEqual(m[(Math.floor((1 - 0.8) / 0.01)) * 40 + Math.floor(0.2 / 0.01)], 1, 'centre filled');
    assert.strictEqual(m[0], 0, 'corner empty');
});

/* ── 3. Curves, logistic regression, validation ─────────────────────────── */
console.log('Curves, logistic regression and validation');

test('buildCurve puts the peak where sites concentrate, normalised 0..1', () => {
    const r = rng(3);
    const sv = [], bv = [];
    for (let k = 0; k < 400; k++) sv.push(2 + r() * 3);     // sites between 2 and 5 degrees
    for (let k = 0; k < 4000; k++) bv.push(r() * 25);       // background uniform 0–25
    const edges = core.linearEdges(0, 25, 25);
    const pts = core.buildCurve(Float64Array.from(sv), Float64Array.from(bv), edges);
    const best = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.ok(best[0] >= 1 && best[0] <= 6, `peak at ${best[0]}`);
    assert.ok(Math.min(...pts.map((p) => p[1])) >= 0 && Math.max(...pts.map((p) => p[1])) <= 1);
});

test('buildCurve is neutral (flat) when there is no site information', () => {
    const pts = core.buildCurve(new Float64Array(0), Float64Array.from([1, 2, 3]), core.linearEdges(0, 4, 4));
    assert.ok(pts.every((p) => p[1] === 0.5));
});

test('non-negative logistic regression recovers the informative feature and zeroes noise', () => {
    const r = rng(5), n = 3000;
    const x1 = new Float64Array(n), x2 = new Float64Array(n), y = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        x1[i] = r(); x2[i] = r();
        const p = 1 / (1 + Math.exp(-(6 * x1[i] - 3)));
        y[i] = r() < p ? 1 : 0;
    }
    const fit = core.fitNonNegLogistic([x1, x2], y, { maxIter: 4000 });
    assert.ok(fit.weights[0] > 0.5, `w1=${fit.weights[0]}`);
    assert.ok(fit.weights[1] < 0.2, `w2=${fit.weights[1]}`);
    assert.ok(fit.weights.every((w) => w >= 0));
});

test('AUC and Kvamme gain on known inputs', () => {
    assert.strictEqual(core.auc([0.9, 0.8], [0.1, 0.2]), 1);
    assert.strictEqual(core.auc([0.1], [0.9]), 0);
    assert.strictEqual(core.auc([0.5, 0.5], [0.5, 0.5]), 0.5);
    const S = [0.9, 0.8, 0.7, 0.1], B = [0.9, 0.2, 0.3, 0.4];
    const t = core.thresholdForCapture(S, 0.75);
    assert.strictEqual(t, 0.7);
    // A = 1/4 of background ≥ 0.7 ; S = 3/4 → gain = 1 − (1/4)/(3/4) = 2/3
    assert.ok(Math.abs(core.kvammeGain(S, B, t) - 2 / 3) < 1e-9);
});

test('TRAIN thresholds are ordered and capture the requested site fractions', () => {
    const scores = Array.from({ length: 100 }, (_, i) => i / 100);
    const t = core.trainThresholds(scores);
    assert.ok(t.medium < t.high && t.high < t.veryhigh);
    const cap = (th) => scores.filter((s) => s >= th).length / scores.length;
    assert.ok(cap(t.veryhigh) >= 0.5 && cap(t.veryhigh) <= 0.52);
    assert.ok(cap(t.high) >= 0.75 && cap(t.high) <= 0.77);
    assert.ok(cap(t.medium) >= 0.9 && cap(t.medium) <= 0.92);
});

test('manual thresholds are validated', () => {
    assert.throws(() => core.validateManualThresholds({ medium: 0.8, high: 0.7, veryhigh: 0.9 }));
    assert.deepStrictEqual(core.validateManualThresholds({ medium: 0.55, high: 0.7, veryhigh: 0.85 }).veryhigh, 0.85);
});

test('manual score: relief formula, normalisation by Σw, SOIL weight 0 by default', () => {
    const cfg = {
        curves: core.DEFAULT_CURVES, weights: { relief: 1, water: 1, soil: 0 },
        minSlopeDeg: 0.5, preferredAspectDeg: 180, waterClasses: ['small']
    };
    const cell = { slope: 3, aspect: 180, altPct: 0.35, soilPct: 0.9, waterDist: { small: 0 } };
    const s = core.manualCellScore(cell, cfg);
    const relief = 0.4 * core.interp(core.DEFAULT_CURVES.altitude, 0.35) + 0.4 * 1 + 0.2 * 1;   // slope 3°, aspect = preferred
    const water = core.interp(core.DEFAULT_CURVES.water.small, 0);
    assert.ok(Math.abs(s - (relief + water) / 2) < 1e-9);
    // Soil with weight 0 must not change the score.
    const s2 = core.manualCellScore(Object.assign({}, cell, { soilPct: 0 }), cfg);
    assert.ok(Math.abs(s - s2) < 1e-12);
});

test('manual default curves: slope 1 up to 5°, 0 at 20°, linear between', () => {
    assert.strictEqual(core.interp(core.DEFAULT_CURVES.slope, 3), 1);
    assert.ok(Math.abs(core.interp(core.DEFAULT_CURVES.slope, 12.5) - 0.5) < 1e-9);
    assert.strictEqual(core.interp(core.DEFAULT_CURVES.slope, 25), 0);
});

test('aspect is flipped for the southern hemisphere', () => {
    assert.strictEqual(core.preferredAspectDeg(50), 180);
    assert.strictEqual(core.preferredAspectDeg(-35), 0);
    assert.strictEqual(core.angularDiff(350, 10), 20);
});

/* ── 4. Polygonisation ──────────────────────────────────────────────────── */
console.log('Polygonisation');

test('classes are non-overlapping and use the exact colours', () => {
    const w = 60, h = 60, g = { w, h, west: 0, north: 1, dLon: 0.01, dLat: 0.01 };
    const sc = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) sc[j * w + i] = Math.max(0, 1 - Math.hypot(i - 30, j - 30) / 25);
    const fc = poly.polygonise(sc, g, { medium: 0.55, high: 0.7, veryhigh: 0.85 }, { minAreaM2: 0, smoothIters: 0 });
    const colours = {};
    fc.features.forEach((f) => { colours[f.properties.class] = f.properties.colour; });
    assert.deepStrictEqual(colours, { medium: '#FFA500', high: '#2E9E4F', veryhigh: '#89CFF0' });
    // Areas: sum of class areas ≈ area of the ≥0.55 region; overlap would double-count.
    const areas = poly.areaByClass(fc);
    const total = areas.medium + areas.high + areas.veryhigh;
    const expected = poly.regionAtThreshold(Float64Array.from(sc), w, h, 0.55);
    assert.ok(total > 0);
    const outerKm2 = expected.reduce((acc, p) => acc + raster.ringAreaM2(p.length ? p[0].map(([u, v]) => [u * g.dLon, v * g.dLat]) : []), 0) / 1e6;
    assert.ok(Math.abs(total - outerKm2 * 1) / total < 0.5, `total ${total} vs region ${outerKm2}`);
});

test('tiny fragments are dropped by minimum area', () => {
    const w = 40, h = 40, g = { w, h, west: 0, north: 1, dLon: 0.001, dLat: 0.001 };
    const sc = new Float32Array(w * h);
    sc[20 * w + 20] = 0.99;                    // a single high cell (~ 0.01 km²)
    const big = poly.polygonise(sc, g, { medium: 0.55, high: 0.7, veryhigh: 0.85 }, { minAreaM2: 1e6, smoothIters: 0 });
    assert.strictEqual(big.features.length, 0);
});

test('d3 contour coordinates map to lon/lat via cell edges', () => {
    const w = 6, h = 5, g = { w, h, west: 10, north: 20, dLon: 1, dLat: 1 };
    const sc = new Float32Array(w * h);
    for (let j = 1; j <= 2; j++) for (let i = 2; i <= 3; i++) sc[j * w + i] = 1;
    const fc = poly.polygonise(sc, g, { medium: 0.5, high: 0.9, veryhigh: 2 }, { minAreaM2: 0, smoothIters: 0 });
    const ring = fc.features[0].geometry.coordinates[0];
    const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
    assert.ok(Math.min(...lons) >= 12 - 1e-9 && Math.max(...lons) <= 14 + 1e-9, 'x edges cover cells 2–3');
    assert.ok(Math.min(...lats) >= 17 - 1e-9 && Math.max(...lats) <= 19 + 1e-9, 'y edges cover rows 1–2');
});

/* ── 5. Sites: parsing, filters, periods ────────────────────────────────── */
console.log('Known sites');

const CSV = [
    'ID,Latitude,Longitude,Period,Start,End,Type,Accuracy',
    's1,52.00,13.00,Bronze Age,-2200,-800,settlement,exact',
    's2,52.0002,13.0002,Bronze Age,-2200,-800,settlement,precise',  // duplicate of s1 (≈26 m, < 50 m)
    's3,52.05,13.05,Roman,50,400,village,25',
    's4,52.06,13.06,Roman,50,400,cemetery,25',                       // not settlement
    's5,52.07,13.07,Roman,50,400,settlement,approximate',            // 1000 m → drop
    's6,52.08,13.08,Medieval,900,1200,town,"12"',
    's7,52.09,13.09,Medieval,,,settlement,10',                       // undated
    's8,60.0,20.0,Roman,50,400,settlement,10'                        // far outside 50 km
].join('\n');

test('CSV parsing maps columns and reports headers', () => {
    const { records, report } = sites.parseSitesCsv(CSV, 'test');
    assert.strictEqual(records.length, 8);
    assert.strictEqual(report.typeAssumed, false);
    assert.strictEqual(records[0].periodStart, -2200);
    assert.strictEqual(records[0].periodEnd, -800);
});

test('TRAIN filters: type, accuracy threshold, de-duplication, distance, period overlap', () => {
    const { records } = sites.parseSitesCsv(CSV, 'test');
    const centre = { lat: 52.0, lon: 13.0 };
    const all = sites.filterSites(records, { center: centre, radiusKm: 50, period: null });
    const ids = all.sites.map((s) => s.id);
    assert.ok(!ids.includes('s4'), 'cemetery is not a settlement type');
    assert.ok(!ids.includes('s5'), 'approximate (1000 m) position is dropped at 100 m threshold');
    assert.ok(ids.includes('s1') && !ids.includes('s2'), 'near-duplicate removed (first of the pair is kept)');
    assert.ok(!ids.includes('s8'), 'outside 50 km');
    assert.strictEqual(all.dropped.duplicate, 1);
    const bronze = sites.filterSites(records, { center: centre, radiusKm: 50, period: { start: -1000, end: -500 } });
    assert.deepStrictEqual(bronze.sites.map((s) => s.id), ['s1']);
    const undated = sites.filterSites(records, { center: centre, radiusKm: 50, period: { start: 0, end: 2000 } });
    assert.ok(!undated.sites.some((s) => s.id === 's7'), 'undated records are not used for a period');
});

test('period picker groups counts and ranges', () => {
    const { records } = sites.parseSitesCsv(CSV, 'test');
    const groups = sites.groupPeriods(records);
    const roman = groups.find((g) => g.label === 'Roman');
    assert.strictEqual(roman.count, 4);   // s3, s4 (cemetery), s5 (approximate), s8 (far)
    assert.strictEqual(roman.start, 50);
    assert.strictEqual(roman.end, 400);
});

test('CSV without coordinates is rejected with a clear error', () => {
    const { records, report } = sites.parseSitesCsv('name,value\na,1\nb,2');
    assert.strictEqual(records.length, 0);
    assert.ok(report.errors[0].includes('latitude and longitude'));
});

/* ── 6. Providers: parsing and URL building (no network) ────────────────── */
console.log('Providers (parsers and query builders; live endpoints not exercised)');

test('EU-Hydro layer resolution uses the real service layer list, one layer per name', () => {
    // FIXTURE: layer list copied from the live EU-Hydro MapServer ?f=json response
    // (https://image.discomap.eea.europa.eu/arcgis/rest/services/EUHydro/EUHydro_RiverNetworkDatabase/MapServer).
    const L = (id, name, parentLayerId, subLayerIds) => ({ id, name, parentLayerId, subLayerIds: subLayerIds || null });
    const fixture = {
        layers: [
            L(0, 'Coastal_polygon', -1), L(1, 'Transit_polygon', -1), L(2, 'InlandWater', -1), L(3, 'InlandWater', -1),
            L(4, 'River_Net_lines', -1, [5, 6, 7, 8, 9, 10, 11, 12, 13]),
            L(5, 'Strahler 1', 4), L(6, 'Strahler 2', 4), L(7, 'Strahler 3', 4), L(8, 'Strahler 4', 4), L(9, 'Strahler 5', 4),
            L(10, 'Strahler 6', 4), L(11, 'Strahler 7', 4), L(12, 'Strahler 8', 4), L(13, 'Strahler 9', 4),
            L(14, 'River_Net_lines', -1, [15, 16, 17, 18]),
            L(15, 'Strahler 6', 14), L(16, 'Strahler 7', 14), L(17, 'Strahler 8', 14), L(18, 'Strahler 9', 14),
            L(19, 'River_Net_polygon', -1), L(20, 'Drainage Network - Public Beta', -1)
        ]
    };
    const ls = prov.resolveEuHydroLayers(fixture);
    const ids = ls.map((l) => l.id);
    // Each scale-duplicate is dropped (lowest id kept): InlandWater 2 (not 3), Strahler 6–9 from group 4 (ids 10–13, not 15–18).
    assert.deepStrictEqual(ids, [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 19]);
    const byId = Object.fromEntries(ls.map((l) => [l.id, l]));
    assert.strictEqual(byId[5].cls, 'small');    // Strahler 1
    assert.strictEqual(byId[6].cls, 'small');    // Strahler 2
    assert.strictEqual(byId[7].cls, 'medium');   // Strahler 3
    assert.strictEqual(byId[8].cls, 'medium');   // Strahler 4
    assert.strictEqual(byId[9].cls, 'large');    // Strahler 5
    assert.strictEqual(byId[19].cls, 'large');   // River_Net_polygon
    assert.strictEqual(byId[2].role, 'inland');
    assert.ok(!ls.some((l) => /coastal|transit|drainage/i.test(l.name)), 'sea, transitional and drainage layers are excluded');
});

testAsync('EU-DEM WCS: candidate endpoints are tried in order; the first that lists an EU-DEM coverage wins', async () => {
    const calls = [];
    const xml = '<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>DEM_v11_Masked2</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>';
    prov.setFetch(async (url) => {
        calls.push(url);
        if (url.startsWith(prov.CONFIG.euDem.wcsEndpoints[0])) return { ok: true, status: 503, text: async () => '', headers: { get: () => null } };
        return { ok: true, status: 200, text: async () => xml, headers: { get: () => 'text/xml' } };
    });
    const dem = prov.createEuDemProvider();
    const cov = await dem.discover();
    assert.strictEqual(cov.id, 'DEM_v11_Masked2');
    assert.strictEqual(cov.endpoint, prov.CONFIG.euDem.wcsEndpoints[1]);
    assert.ok(calls[0].startsWith(prov.CONFIG.euDem.wcsEndpoints[0]), 'first candidate is tried first');
    assert.ok(!JSON.stringify(prov.CONFIG).includes('GioLandPublic'), 'the unverified GioLandPublic path is gone');
    prov.setFetch(null);
});

testAsync('debug mode records every request: URL, status, timing; CORS/network failures are labelled', async () => {
    prov.setDebug(true);
    prov.clearDebugLog();
    prov.setFetch(async (url) => {
        if (url.includes('EUHydro')) throw new TypeError('Failed to fetch');          // simulated CORS block
        return { ok: true, status: 200, json: async () => ({ elements: [] }), headers: { get: () => 'application/json' } };
    });
    await prov.schedule('debug-test', () => null);   // ensure the scheduler is idle
    await prov.createOverpassWaterProvider().fetchWater({ south: 1, west: 1, north: 1.1, east: 1.1 }, {}).catch(() => null);
    await prov.createEuHydroProvider().fetchWater({ south: 1, west: 1, north: 1.1, east: 1.1 }, {}).catch(() => null);
    const log = prov.getDebugLog();
    assert.ok(log.length >= 1, 'at least one request is logged');
    const first = log[0];
    assert.strictEqual(first.method, 'POST');
    assert.ok(first.url.startsWith('https://overpass-api.de/api/interpreter'));
    assert.strictEqual(first.status, 200);
    assert.strictEqual(typeof first.ms, 'number');
    const failed = log.find((r) => r.status == null);
    assert.ok(failed && /CORS/.test(failed.hint), 'network/CORS failure is labelled');
    prov.setFetch(null);
    prov.setDebug(false);
});

test('ArcGIS query URL: envelope, GeoJSON, simplification, paging parameters', () => {
    const url = prov.buildEsriQuery('https://example.test/MapServer', 3, { west: 1, south: 2, east: 3, north: 4 }, { maxAllowableOffsetDeg: 0.0001, resultOffset: 1000, resultRecordCount: 1000 });
    assert.ok(url.startsWith('https://example.test/MapServer/3/query?'));
    assert.ok(url.includes('geometryType=esriGeometryEnvelope'));
    assert.ok(url.includes('geometry=1%2C2%2C3%2C4'));
    assert.ok(url.includes('f=geojson'));
    assert.ok(url.includes('maxAllowableOffset=0.0001'));
    assert.ok(url.includes('resultOffset=1000'));
});

test('ArcGIS GeoJSON parsing detects exceededTransferLimit', () => {
    const fx = { type: 'FeatureCollection', exceededTransferLimit: true, features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1, 2], [1.1, 2.1]] } },
        { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] } }
    ] };
    const p = prov.parseEsriGeoJson(fx);
    assert.strictEqual(p.lines.length, 1);
    assert.strictEqual(p.rings.length, 1);
    assert.strictEqual(p.exceeded, true);
});

test('Overpass query and parser (fixture)', () => {
    const q = prov.buildOverpassQuery({ west: 1, south: 2, east: 3, north: 4 }, 60);
    assert.ok(q.includes('["waterway"~"^(river|stream'));
    assert.ok(q.includes('out geom;'));
    const fx = { elements: [
        { type: 'way', tags: { waterway: 'stream' }, geometry: [{ lat: 2, lon: 1 }, { lat: 2.1, lon: 1.1 }] },
        { type: 'way', tags: { waterway: 'canal' }, geometry: [{ lat: 2, lon: 1 }, { lat: 2.1, lon: 1.1 }] },
        { type: 'way', tags: { natural: 'water' }, geometry: [{ lat: 2, lon: 1 }, { lat: 2, lon: 1.1 }, { lat: 2.1, lon: 1.1 }, { lat: 2, lon: 1 }] }
    ] };
    const p = prov.parseOverpass(fx);
    assert.deepStrictEqual(p.lines.map((l) => l.cls), ['small', 'artificial']);
    assert.strictEqual(p.polygons[0].cls, 'large');
});

test('terrarium zoom and pixel mapping are sane', () => {
    assert.ok(prov.terrariumZoomFor(45, 25) >= 12 && prov.terrariumZoomFor(45, 25) <= 13);
    assert.strictEqual(prov.terrariumHeight(Uint8ClampedArray.from([128, 0, 0, 255]), 0), 128 * 256 - 32768);
});

test('EU-DEM coverage id is discovered from GetCapabilities XML, not assumed', () => {
    // FIXTURE: a minimal WCS 2.0 capabilities fragment (synthetic).
    const xml = '<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0"><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>EU_DEM_v11</wcs:CoverageId></wcs:CoverageSummary><wcs:CoverageSummary><wcs:CoverageId>Other</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>';
    assert.deepStrictEqual(prov.parseWcsCoverageIds(xml), ['EU_DEM_v11', 'Other']);
});

test('provider chains: EEA first inside Europe, global fallback outside', () => {
    assert.ok(prov.inEea39Approx(50, 13));
    assert.ok(!prov.inEea39Approx(-33, 151));
    assert.strictEqual(prov.demChain(50, 13)[0].id, 'eu-dem');
    assert.strictEqual(prov.demChain(-33, 151)[0].id, 'terrarium');
    assert.strictEqual(prov.waterChain(-33, 151)[0].id, 'osm-overpass');
});

/* ── 7. Sample set, scoring and the synthetic end-to-end recovery ───────── */
console.log('Synthetic end-to-end (TRAIN recovers a known rule)');

// World: 100 km × 100 km at 100 m. Rolling hills + one north–south stream (Strahler 3 = medium).
// Ground-truth rule: sites prefer gentle slope (< 5°) AND 100–800 m from the stream.
function buildWorld(seed) {
    const r = rng(seed);
    const centre = { lat: 50.0, lon: 10.0 };
    const mpd = core.metresPerDegree(centre.lat);
    const half = 50000;
    const bbox = core.circleBBox(centre.lat, centre.lon, half + 1000);
    const g = raster.gridForBBox(bbox, 100);
    const elev = new Float32Array(g.w * g.h);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
        const x = (raster.cellLon(g, i) - centre.lon) * mpd.lon;
        const y = (raster.cellLat(g, j) - centre.lat) * mpd.lat;
        // hills with a realistic slope spread (roughly half the cells above 5°)
        elev[j * g.w + i] = 300 + 120 * Math.sin(x / 800) + 80 * Math.cos(y / 1000) + 10 * Math.sin(x / 300 + y / 260);
    }
    // stream: a sinuous line through the middle (lon = centre + small wiggle)
    const streamCoords = [];
    for (let t = -60; t <= 60; t++) {
        const y = t * 1000;
        const x = 600 * Math.sin(t / 5);
        streamCoords.push([centre.lon + x / mpd.lon, centre.lat + y / mpd.lat]);
    }
    const stream = [streamCoords];
    const segs = [];
    for (let k = 0; k + 1 < streamCoords.length; k++) segs.push(streamCoords[k][0], streamCoords[k][1], streamCoords[k + 1][0], streamCoords[k + 1][1]);
    return { centre, mpd, g, elev, stream, segs: Float64Array.from(segs), bbox, r, half };
}

function sampleAt(world, sp, lat, lon) {
    const c = raster.cellOf(world.g, lon, lat);
    return c;
}

test('synthetic TRAIN recovers slope and stream-distance preferences', () => {
    const W = buildWorld(42);
    const { g, elev, centre, mpd, r } = W;
    const sp = raster.gridSpacingM(g);
    const t = raster.terrain(elev, g.w, g.h, sp.dx, sp.dy);
    const idx = raster.buildSegmentIndex(RBush, W.segs);
    // Candidate generator: accept by rule, 180 sites; background uniform in the disc.
    const sitesList = [], cand = [];
    let guard = 0;
    while (sitesList.length < 180 && guard++ < 400000) {
        const rr = W.half * Math.sqrt(r()), th = r() * 2 * Math.PI;
        const x = rr * Math.cos(th), y = rr * Math.sin(th);
        const lat = centre.lat + y / mpd.lat, lon = centre.lon + x / mpd.lon;
        const c = raster.cellOf(g, lon, lat);
        if (c < 0 || !t.valid[c]) continue;
        const d = raster.nearestWaterM(idx, lon, lat);
        const pSlope = t.slope[c] < 5 ? 1 : 0.08;
        const pWater = (d >= 100 && d <= 800) ? 1 : 0.06;
        if (r() < pSlope * pWater) sitesList.push({ lat, lon, x, y });
    }
    assert.ok(sitesList.length >= 150, `generated ${sitesList.length} sites`);

    const bgRaw = pipeline.sampleBackground(centre, W.half, 4000, sitesList, 500, r);
    const pts = [];
    sitesList.forEach((s) => pts.push({ lat: s.lat, lon: s.lon, x: s.x, y: s.y, isSite: true }));
    bgRaw.forEach((b) => pts.push({ lat: b.lat, lon: b.lon, x: b.x, y: b.y, isSite: false }));
    const merged = pts.map((p) => {
        const c = raster.cellOf(g, p.lon, p.lat);
        const d = raster.nearestWaterM(idx, p.lon, p.lat);
        return Object.assign({}, p, {
            elev: elev[c], slope: t.slope[c], aspect: t.aspect[c], curv: t.curv[c], valid: !!t.valid[c],
            water: { medium: d }
        });
    });
    const built = pipeline.buildSampleSet(merged, { minSlopeDeg: 0.5, radiusM: W.half, folds: 5, waterClasses: ['medium'] });
    const res = core.trainModelFromSamples(built.S, { waterClasses: ['medium'], minSlopeDeg: 0.5, folds: 5 });
    const wts = res.model.weights;
    // Ground truth uses slope and water; altitude/aspect are noise by construction.
    assert.ok(wts.water > 0.25, `water weight ${wts.water}`);
    assert.ok(wts.slope > wts.aspect, `slope ${wts.slope} vs aspect ${wts.aspect}`);
    assert.ok(wts.slope > 0.15, `slope weight ${wts.slope}`);
    // Learned slope curve decreases with slope (gentle preferred).
    const sc = res.model.curves.slope;
    assert.ok(core.interp(sc, 2) > core.interp(sc, 15), 'gentle slope scores higher than steep');
    // Learned medium-stream curve peaks in the 100–800 m band.
    const wc = res.model.curves.water_medium;
    const peak = wc.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.ok(peak[0] >= 100 && peak[0] <= 800, `water peak at ${peak[0]} m`);
    // Cross-validation beats chance on held-out blocks.
    assert.ok(res.cv.auc > 0.6, `CV AUC ${res.cv.auc}`);
    assert.ok(Object.keys(res.model.weights).length === 5);
    // Weights sum to one across the variables that are actually used.
    const sum = Object.values(wts).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('redundant soil proxy is excluded (|r| > 0.8 with slope) and reported', () => {
    const n = 400, r = rng(9);
    const S = { n, y: new Uint8Array(n), fold: new Uint8Array(n), vals: {
        altitude: new Float64Array(n), slope: new Float64Array(n), aspect: new Float64Array(n),
        soil: new Float64Array(n), water_medium: new Float64Array(n) } };
    for (let i = 0; i < n; i++) {
        S.y[i] = i % 3 === 0 ? 1 : 0;
        S.fold[i] = i % 5;
        S.vals.slope[i] = r() * 20;
        S.vals.soil[i] = S.vals.slope[i] / 20;      // perfectly redundant with slope
        S.vals.altitude[i] = r();
        S.vals.aspect[i] = r() * 360;
        S.vals.water_medium[i] = r() * 2000;
    }
    const res = core.trainModelFromSamples(S, { waterClasses: ['medium'], minSlopeDeg: 0.5, folds: 5 });
    assert.strictEqual(res.model.weights.soil, 0);
    assert.ok(res.excluded.some((e) => e.variable === 'soil' && e.reason === 'redundant'));
});

test('worker harness: setAnalysis → score (MANUAL) and train → score (TRAIN) run the real worker file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'js/apm-next/apm-worker.js'), 'utf8');
    const posted = [];
    const ctx = { console, Math, Float32Array, Float64Array, Uint8Array, Int32Array, Map, Set, Array, Object, JSON, Number, String, Infinity, NaN, Promise, Error, isFinite };
    ctx.self = ctx;
    ctx.postMessage = (m) => posted.push(m);
    ctx.importScripts = (...files) => {
        files.forEach((f) => {
            const file = path.join(ROOT, 'js/apm-next', f);
            vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
        });
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'apm-worker.js' });
    const send = (m) => ctx.onmessage({ data: m });

    // MANUAL on a tilted plane: 10 km circle; no water.
    const bbox = core.circleBBox(47, 8, 12000);
    const g = raster.gridForBBox(bbox, 100);
    const elev = new Float32Array(g.w * g.h);
    const mpd = core.metresPerDegree(47);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) elev[j * g.w + i] = 0.02 * (raster.cellLon(g, i) - 8) * mpd.lon;
    send({ op: 'setAnalysis', id: 1, grid: g, elev, smooth: false, circle: { lat: 47, lon: 8, radiusM: 10000 }, waterMasks: {}, altRef: null, soilRef: null });
    const sa = posted.find((m) => m.id === 1);
    assert.ok(sa && sa.ok, 'setAnalysis ok: ' + (sa && sa.error));
    send({ op: 'score', id: 2, mode: 'manual', curves: core.DEFAULT_CURVES, weights: { relief: 1, water: 0, soil: 0 },
        minSlopeDeg: 0.5, preferredAspectDeg: 180, waterClasses: [], thresholds: { medium: 0.55, high: 0.7, veryhigh: 0.85 }, minAreaM2: 0, smoothIters: 0 });
    const sc = posted.find((m) => m.id === 2);
    assert.ok(sc && sc.ok, 'score ok: ' + (sc && sc.error));
    assert.ok(sc.geojson.features.length >= 1, 'produces at least one class polygon');
    assert.ok(sc.geojson.features.every((f) => ['#FFA500', '#2E9E4F', '#89CFF0'].includes(f.properties.colour)));

    // TRAIN path through the worker (small synthetic set)
    const n = 120, r = rng(21);
    const S = { n, y: new Uint8Array(n), fold: new Uint8Array(n), vals: { altitude: new Float64Array(n), slope: new Float64Array(n), aspect: new Float64Array(n), soil: new Float64Array(n), water_small: new Float64Array(n) } };
    for (let i = 0; i < n; i++) {
        S.y[i] = i < 40 ? 1 : 0; S.fold[i] = i % 5;
        S.vals.slope[i] = S.y[i] ? r() * 4 : r() * 20;
        S.vals.altitude[i] = r(); S.vals.aspect[i] = r() * 360; S.vals.soil[i] = r();
        S.vals.water_small[i] = S.y[i] ? r() * 200 : r() * 3000;
    }
    send({ op: 'train', id: 3, S, waterClasses: ['small'], minSlopeDeg: 0.5, folds: 5 });
    const tr = posted.find((m) => m.id === 3);
    assert.ok(tr && tr.ok, 'train ok: ' + (tr && tr.error));
    send({ op: 'score', id: 4, mode: 'train', model: tr.result.model, waterClasses: ['small'], thresholds: tr.result.thresholds, minAreaM2: 0, smoothIters: 0 });
    const sc2 = posted.find((m) => m.id === 4);
    assert.ok(sc2 && sc2.ok, 'train-score ok: ' + (sc2 && sc2.error));
});

/* ── Phase 2 input rules: radius, curves, translations ───────────────────── */
console.log('UI rules');

test('search radius is limited to 1–10 km (the spec), with a readable error outside it', () => {
    assert.strictEqual(core.RADIUS_KM.min, 1);
    assert.strictEqual(core.RADIUS_KM.max, 10);
    assert.strictEqual(core.validateRadiusKm('5'), 5);
    assert.strictEqual(core.validateRadiusKm(1), 1);
    assert.strictEqual(core.validateRadiusKm(10), 10);
    assert.throws(() => core.validateRadiusKm(25), /between 1 and 10 km/);
    assert.throws(() => core.validateRadiusKm(0.5), /between 1 and 10 km/);
    assert.throws(() => core.validateRadiusKm('abc'), /between 1 and 10 km/);
});

test('curve text: "x, y" lines, comments ignored, malformed lines reported with line numbers', () => {
    const p = core.parseCurveText('0, 1\n# comment\n5 1\n10;0.5\nbad line\n20, 2, 3');
    assert.deepStrictEqual(p.points, [[0, 1], [5, 1], [10, 0.5]]);
    assert.strictEqual(p.errors.length, 2);
    assert.ok(p.errors[0].startsWith('line 5'));
    assert.ok(p.errors[1].startsWith('line 6'));
});

test('curve validation: at least two points, x strictly increasing, y in [0,1], x inside the curve range', () => {
    const slopeSpec = core.CURVE_SPECS.slope;
    assert.deepStrictEqual(core.validateCurve([[0, 1], [5, 1], [20, 0]], slopeSpec), []);
    assert.ok(core.validateCurve([[0, 1]], slopeSpec).length > 0, 'one point is not a curve');
    assert.ok(core.validateCurve([[5, 1], [5, 0]], slopeSpec).some((e) => /must increase/.test(e)), 'x must increase');
    assert.ok(core.validateCurve([[0, 1], [5, 1.2]], slopeSpec).some((e) => /between 0 and 1/.test(e)), 'y ≤ 1');
    assert.ok(core.validateCurve([[0, 1], [95, 0]], slopeSpec).some((e) => /outside/.test(e)), 'slope x ≤ 90');
});

test('the default curves pass validation as a set; an invalid edit is reported per curve', () => {
    const ok = core.validateCurves(core.DEFAULT_CURVES);
    assert.deepStrictEqual(ok.errors, {});
    assert.ok(ok.curves && ok.curves.water.small);
    const bad = JSON.parse(JSON.stringify(core.DEFAULT_CURVES));
    bad.slope = [[0, 1], [0, 0.5]];
    bad.water.medium = [[0, 2], [100, 0]];
    const res = core.validateCurves(bad);
    assert.strictEqual(res.curves, null);
    assert.ok(res.errors.slope && res.errors.water_medium, 'errors name the curves they belong to');
});

test('translations: every Romanian key exists in English and vice versa; placeholders are filled', () => {
    const I = require('./js/apm-next/apm-i18n.js');
    const en = Object.keys(I.STRINGS.en), ro = Object.keys(I.STRINGS.ro);
    assert.deepStrictEqual(en.filter((k) => !ro.includes(k)), [], 'keys missing in ro');
    assert.deepStrictEqual(ro.filter((k) => !en.includes(k)), [], 'keys missing in en');
    assert.strictEqual(I.t('point.at', 'ro', { lat: 44.4, lon: 26.1 }), 'Punct: 44.4, 26.1');
    assert.strictEqual(I.t('point.at', 'en', { lat: 1, lon: 2 }), 'Point: 1, 2');
    assert.strictEqual(I.t('no.such.key', 'ro'), 'no.such.key', 'unknown keys fall back to the key');
    assert.strictEqual(I.normaliseLang('ro-RO'), 'ro');
    assert.strictEqual(I.normaliseLang('fr'), 'en');
});

test('colours follow the spec: medium = orange, high = green, very high = baby blue; each has a legend label key', () => {
    const I = require('./js/apm-next/apm-i18n.js');
    const byId = Object.fromEntries(core.CLASSES.map((c) => [c.id, c.colour]));
    assert.strictEqual(byId.medium, '#FFA500');
    assert.strictEqual(byId.high, '#2E9E4F');
    assert.strictEqual(byId.veryhigh, '#89CFF0');
    core.CLASSES.forEach((c) => {
        assert.ok(I.STRINGS.en['cls.' + c.id], 'legend label (en) for ' + c.id);
        assert.ok(I.STRINGS.ro['cls.' + c.id], 'legend label (ro) for ' + c.id);
    });
});

/* ── Summary ─────────────────────────────────────────────────────────────── */
asyncChain.then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
});
