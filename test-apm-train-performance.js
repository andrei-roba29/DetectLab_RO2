#!/usr/bin/env node
'use strict';
/*
 * TRAIN heatmap regression: the fixed 50 km prediction window used to be built
 * at the native 25 m DEM resolution (~18 million cells), which exhausted the
 * browser tab exactly when the worker tried to return the heatmap.
 *
 *   node test-apm-train-performance.js
 *
 * No network: providers, UAT tiles and the Web Worker are mocked; the real
 * pipeline, protection-mask contract and worker source are executed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const apmDir = path.join(ROOT, 'js', 'apm-next');
const core = require('./js/apm-next/apm-core.js');
const raster = require('./js/apm-next/apm-raster.js');
const sites = require('./js/apm-next/apm-sites.js');
const prov = require('./js/apm-next/apm-providers.js');

const LAT = 46.77, LON = 23.59, RADIUS_M = 50000;
const TAG = '20261102-apm-train-bounded-grid';
let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}
async function testAsync(name, fn) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.stack || e)); process.exitCode = 1; }
}

/* Worker source in a VM, as the browser would load it with importScripts. */
function workerHarness() {
    const posted = [];
    const ctx = { console };
    ctx.self = ctx;
    ctx.postMessage = m => posted.push(m);
    ctx.importScripts = (...files) => files.forEach(f =>
        vm.runInContext(read(path.join('js/apm-next', f.split('?')[0])), ctx, { filename: f }));
    vm.createContext(ctx);
    vm.runInContext(read('js/apm-next/apm-worker.js'), ctx);
    let id = 0;
    return (op, payload) => {
        ctx.onmessage({ data: Object.assign({}, payload, { op: op, id: ++id }) });
        return posted.find(m => m.id === id);
    };
}

/* A Worker facade whose replies arrive in a microtask, like real postMessage. */
function FakeWorker() {
    const wctx = { console };
    wctx.self = wctx;
    wctx.importScripts = (...files) => files.forEach(f =>
        vm.runInContext(read(path.join('js/apm-next', f.split('?')[0])), wctx, { filename: f }));
    wctx.postMessage = m => Promise.resolve().then(() => {
        if (this.onmessage) this.onmessage({ data: m });
    });
    vm.createContext(wctx);
    vm.runInContext(read('js/apm-next/apm-worker.js'), wctx);
    this.ctx = wctx;
    this.onmessage = null;
}
FakeWorker.prototype.postMessage = function (msg) { this.ctx.onmessage({ data: msg }); };
FakeWorker.prototype.terminate = function () {};

/* Legacy exclusion module in a VM, with a controllable UAT tile loader. */
function maskHarness(loader) {
    const empty = () => ({ type: 'FeatureCollection', features: [] });
    const window = {
        _localLayerData: { 0: empty(), 5: empty(), 6: empty() },
        UAT_TILE_Z: 14, _UAT_TILE_UNREADABLE: {},
        _uatGetTile: loader
    };
    const ctx = { window, document: { readyState: 'loading', addEventListener() {} },
        console, setTimeout, clearTimeout, performance, Uint8Array, Uint8ClampedArray };
    vm.runInNewContext(read('js/archeo-potential.js'), ctx);
    const debug = window._archeoPotentialDebug;
    debug.config.UAT.RETRIES = 0;
    return { window, debug };
}
function redTileData(size, alpha = 255) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = alpha; }
    return data;
}

(async function main() {
    const bbox = core.circleBBox(LAT, LON, RADIUS_M + 3000);

    test('50 km TRAIN window at 25 m is unbounded and would need ~18 million cells', () => {
        const native = raster.gridForBBox(bbox, 25);
        assert.ok(native.w * native.h > 15e6, 'native grid really is the crash-sized raster');
        assert.ok(native.w > 4000 && native.h > 4000);
    });

    test('prediction grid is bounded to ~1 million cells without changing its geographic extent', () => {
        const native = raster.gridForBBox(bbox, 25);
        const bounded = raster.boundedGridForBBox(bbox, 25);
        assert.ok(bounded.w * bounded.h <= raster.MAX_PREDICTION_CELLS, 'within the cell budget');
        assert.ok(bounded.w < native.w && bounded.h < native.h, 'coarsened');
        assert.ok(Math.abs(bounded.w * bounded.dLon - native.w * native.dLon) < 1e-9, 'east-west extent preserved');
        assert.ok(Math.abs(bounded.h * bounded.dLat - native.h * native.dLat) < 1e-9, 'north-south extent preserved');
        assert.equal(bounded.west, native.west);
        assert.equal(bounded.north, native.north);
        assert.deepEqual(Object.keys(bounded).sort(), ['dLat', 'dLon', 'h', 'north', 'w', 'west']);
        const spacing = raster.gridSpacingM(bounded);
        assert.ok(Math.max(spacing.dx, spacing.dy) > 25 && Math.max(spacing.dx, spacing.dy) < 200,
            'TRAIN heatmap uses ~100 m cells');
        // MANUAL's largest allowed radius is only marginally affected (a few %).
        const manualBBox = core.circleBBox(LAT, LON, 13000);
        const manual = raster.boundedGridForBBox(manualBBox, 25);
        const manualNative = raster.gridForBBox(manualBBox, 25);
        assert.ok(Math.abs(manual.w - manualNative.w) / manualNative.w < 0.02,
            'MANUAL stays within 2% of native 25 m cells');
        assert.ok(manual.w * manual.h <= raster.MAX_PREDICTION_CELLS);
        const custom = raster.boundedGridForBBox(bbox, 25, 100000);
        assert.ok(custom.w * custom.h <= 100000, 'explicit budget is honoured');
    });

    test('worker refuses an oversized analysis instead of exhausting the tab', () => {
        const send = workerHarness();
        const g = { w: 1600, h: 1400, west: LON - 0.7, north: LAT + 0.5, dLon: 0.0009, dLat: 0.0007 };
        const n = g.w * g.h;
        assert.ok(n > 2 * 1024 * 1024, 'fixture is above the guard');
        const elev = new Float32Array(n);
        for (let i = 0; i < n; i++) elev[i] = 200 + (i % g.w) * 0.04;
        const set = send('setAnalysis', { grid: g, elev, smooth: false,
            circle: { lat: LAT, lon: LON, radiusM: RADIUS_M }, waterMasks: {}, exclusionMask: null });
        assert.equal(set.ok, true, 'setAnalysis still works');
        const scored = send('score', { mode: 'manual', curves: core.DEFAULT_CURVES,
            weights: { relief: 0.6, water: 0.4, soil: 0 }, waterClasses: [],
            thresholds: { medium: .55, high: .7, veryhigh: .85 }, minAreaM2: 2500, smoothIters: 1 });
        assert.equal(scored.ok, false, 'score fails cleanly');
        assert.match(scored.error, /too large to score safely/, 'readable error, not an OOM crash');
    });

    await testAsync('real TRAIN pipeline at 25 m returns a visible heatmap from a bounded grid', async () => {
        const demBlocks = [];
        let seenGrid = null;
        const dem = {
            id: 'synthetic-eudem', label: 'Synthetic EU-DEM 25 m', source: 'test',
            version: '1.1', tier: 'primary', endpoint: 'https://example.invalid/wcs',
            nominalResM: 25, tilePx: 1000,
            fetchBlock(g) {
                demBlocks.push(g.w * g.h);
                const out = new Float32Array(g.w * g.h);
                for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
                    out[j * g.w + i] = 180 + 0.05 * i + 0.02 * j + 12 * Math.sin(i / 17) * Math.cos(j / 23);
                }
                return Promise.resolve(out);
            }
        };
        const water = { id: 'no-water', label: 'No water (test)', source: 'test', endpoint: null,
            fetchWater: () => Promise.resolve({ lines: [], polygons: [] }) };
        const savedDemPlan = prov.demPlan, savedWaterPlan = prov.waterPlan;
        prov.demPlan = () => [{ provider: dem, use: true, skipReason: null }];
        prov.waterPlan = () => [{ provider: water, use: true, skipReason: null }];

        const exclusionStub = async (grid, lat, lon, radiusM) => {
            seenGrid = grid;
            const mask = new Uint8Array(grid.w * grid.h);
            const mpd = core.metresPerDegree(lat);
            for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
                const x = (grid.west + (i + .5) * grid.dLon - lon) * mpd.lon;
                const y = (grid.north - (j + .5) * grid.dLat - lat) * mpd.lat;
                if (x * x + y * y > radiusM * radiusM || (i % 97 === 3 && j % 83 < 7)) mask[j * grid.w + i] = 1;
            }
            return { mask, stats: { unknown: 0, heritage: 0, uat: 0, outside: 0 } };
        };

        const pctx = vm.createContext({
            module: { exports: {} },
            require: id => require(path.join(apmDir, id.replace(/^\.\//, ''))),
            console, Promise, Map, Set, Date, Math, Float32Array, Float64Array, Uint8Array,
            Int32Array, Uint32Array, Uint8ClampedArray, setTimeout, clearTimeout, performance,
            Worker: FakeWorker, computeArcheoExclusionMask: exclusionStub
        });
        vm.runInContext(read('js/apm-next/apm-pipeline.js'), pctx);
        const pipeline = pctx.module.exports;

        const csv = 'latitude,longitude,type,positionAccuracy\n' +
            Array.from({ length: 40 }, (_, i) =>
                `${LAT + ((i % 8) - 4) * 0.06},${LON + (Math.floor(i / 8) - 2) * 0.08},settlement,5`).join('\n');
        const records = sites.parseSitesCsv(csv, 'test').records;
        let seed = 4211;
        const rnd = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
        const t0 = Date.now();
        let result;
        try {
            result = await pipeline.runTrain({ worker: null, analysisKey: null }, {
                centre: { lat: LAT, lon: LON }, records, period: null, siteSource: null,
                radiusKm: 50, minSlopeDeg: 0.5, smoothDem: false, includeDrainage: false,
                strahlerMap: null, waterClasses: [], workerUrl: 'worker.js', bgCount: 200,
                rnd, minAreaM2: 2500, token: { cancelled: false }
            });
        } finally {
            prov.demPlan = savedDemPlan;
            prov.waterPlan = savedWaterPlan;
        }
        const elapsed = Date.now() - t0;
        assert.ok(seenGrid, 'protection mask was requested');
        assert.ok(seenGrid.w * seenGrid.h <= raster.MAX_PREDICTION_CELLS,
            'the real prediction grid is bounded: ' + seenGrid.w + 'x' + seenGrid.h);
        assert.equal(result.mode, 'train');
        assert.ok(result.scoreStats.cells > 0, 'cells were scored');
        assert.ok(result.heatmap && result.heatmap.rgba.some((v, i) => i % 4 === 3 && v > 0),
            'TRAIN returned a visible heatmap');
        assert.equal(result.heatmap.w <= 512 && result.heatmap.h <= 512, true, 'display texture is bounded');
        assert.equal(result.warnings.filter(w => w.key === 'info.coarsePrediction').length, 1,
            'the resolution note is shown exactly once');
        assert.equal(result.provenance.dem.resampledForPrediction, true);
        assert.ok(result.provenance.dem.cellM > 25, 'provenance reports the effective cell size');
        assert.equal(result.provenance.dem.predictionCells, seenGrid.w * seenGrid.h);
        assert.ok(demBlocks.length <= 16, 'bounded grids keep DEM tile requests small: ' + demBlocks.length);
        assert.ok(elapsed < 90000, 'TRAIN completes instead of hanging/crashing (' + elapsed + ' ms)');
        console.log('       grid ' + seenGrid.w + 'x' + seenGrid.h + ', DEM blocks ' + demBlocks.length +
            ', heatmap ' + result.heatmap.w + 'x' + result.heatmap.h + ', ' + elapsed + ' ms');
    });

    await testAsync('large TRAIN windows use one coarse UAT pyramid pass, without cache evictions', async () => {
        const calls = [];
        const data = redTileData(32);
        const h = maskHarness(async (z) => { calls.push(z); return { data, size: 32 }; });
        h.debug.config.UAT.MAX_CACHED_TILES = 120;   // tighter than the number of tiles
        const grid = raster.boundedGridForBBox(bbox, 25);
        const result = await h.window.computeArcheoExclusionMask(grid, LAT, LON, RADIUS_M,
            { siteRecords: [{ lat: LAT, lon: LON, id: 'centre' }], isCancelled: () => false });
        assert.ok(calls.length > 0 && calls.length <= 400,
            'a few hundred tiles instead of ~4,000 native z14 tiles: ' + calls.length);
        assert.ok(calls.every(z => z < 14), 'coarse pyramid level is used');
        assert.equal(result.stats.unknown, 0, 'no unverified cells (no FIFO eviction holes)');
        assert.ok(result.mask.some(v => !v), 'free ground remains scoreable');
        assert.ok(result.mask.some(Boolean), 'outside-circle and protected cells stay excluded');
        assert.ok(h.debug.config.UAT.MAX_TILES_PER_RUN >= calls.length);
    });

    await testAsync('cancelling during the coarse UAT download aborts the mask', async () => {
        let loaded = 0, cancelled = false;
        const data = redTileData(32);
        const h = maskHarness(async () => {
            loaded++;
            if (loaded >= 20) cancelled = true;
            return { data, size: 32 };
        });
        const grid = raster.boundedGridForBBox(bbox, 25);
        await assert.rejects(
            h.window.computeArcheoExclusionMask(grid, LAT, LON, RADIUS_M,
                { siteRecords: [{ lat: LAT, lon: LON, id: 'centre' }], isCancelled: () => cancelled }),
            e => e.code === 'cancelled');
        assert.ok(loaded < 400, 'the download stops instead of finishing all tiles');
    });

    // A coarser prediction grid keeps the fallback cases quick; they are still
    // 50 km training windows with more than 200,000 prediction cells.
    async function fallbackCase(name, coarseTile, extraAssert) {
        await testAsync(name, async () => {
            const calls = [];
            const data = redTileData(32);
            const h = maskHarness(async (z) => { calls.push(z); return z < 14 ? coarseTile : { data, size: 32 }; });
            h.debug.config.UAT.MAX_CACHED_TILES = 600;
            const grid = raster.gridForBBox(bbox, 200);
            const result = await h.window.computeArcheoExclusionMask(grid, LAT, LON, RADIUS_M,
                { siteRecords: [{ lat: LAT, lon: LON, id: 'centre' }], isCancelled: () => false });
            assert.ok(calls.some(z => z === 14), 'native level is loaded after the coarse level is rejected');
            assert.ok(calls.filter(z => z === 14).length > 1000, 'full native coverage is still verified');
            assert.equal(result.mask.length, grid.w * grid.h);
            assert.ok(result.mask.some(v => !v), 'free ground remains scoreable');
            if (extraAssert) extraAssert(calls);
        });
    }
    await fallbackCase('missing coarse pyramid falls back to native UAT tiles (correct, slower)', null);
    await fallbackCase('all-transparent coarse pyramid is rejected in favour of native tiles',
        { data: redTileData(32, 0), size: 32 });

    test('changed assets are re-tagged for the browser and the PWA shell cache', () => {
        const html = read('index.html'), sw = read('sw.js');
        for (const f of ['apm-raster.js', 'apm-i18n.js']) {
            const tag = 'js/apm-next/' + f + '?v=' + TAG;
            assert.ok(html.includes(tag) && sw.includes(tag), tag);
        }
        // Later fixes re-tag the UI, worker and mask under the newer HEAT_TAG.
        const HEAT_TAG = '20261102-apm-continuous-heat';
        // v389 re-tags the heat module, the UI and the worker for the 3D draping.
        const DRAPE = '20261102-apm-3d-drape';
        const uiTag = 'js/apm-next/apm-ui.js?v=' + DRAPE;
        assert.ok(html.includes(uiTag) && sw.includes(uiTag), uiTag);
        assert.ok(sw.includes('js/apm-next/apm-ui.js?v=' + TAG), 'older UI tag stays precached for older shells');
        assert.ok(html.includes('js/archeo-potential.js?v=' + HEAT_TAG));
        assert.ok(sw.includes('js/archeo-potential.js?v=' + HEAT_TAG));
        assert.ok(sw.includes('js/apm-next/apm-worker.js?v=' + DRAPE));
        assert.ok(read('js/apm-next/apm-ui.js').includes('apm-worker.js?v=' + DRAPE));
        // Latest fix: the pipeline's DEM/water/UAT-mask fetches run in parallel
        // instead of in sequence (TRAIN's "run" step no longer sums their times).
        const PARALLEL_TAG = '20261102-apm-parallel-fetch';
        const pipelineTag = 'js/apm-next/apm-pipeline.js?v=' + PARALLEL_TAG;
        assert.ok(html.includes(pipelineTag) && sw.includes(pipelineTag), pipelineTag);
        assert.ok(sw.includes('js/apm-next/apm-pipeline.js?v=' + TAG), 'older pipeline tag stays precached for older shells');
        assert.match(sw, /const CACHE_NAME = 'detectlab-v389-apm-3d-drape'/);
        assert.match(read('js/apm-next/apm-worker.js'), /MAX_SCORE_CELLS/);
        assert.match(read('js/apm-next/apm-pipeline.js'), /boundedGridForBBox/);
        assert.match(read('js/apm-next/apm-pipeline.js'), /startExclusionMask/,
            'DEM and the UAT exclusion mask are requested together, not one after another');
    });

    console.log('\n' + passed + ' TRAIN performance checks passed.');
})().catch(e => { console.error(e); process.exitCode = 1; });
