#!/usr/bin/env node
'use strict';
// Offline checks: real legacy exclusions -> real APM worker -> display/export.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const core = require('./js/apm-next/apm-core.js');
const raster = require('./js/apm-next/apm-raster.js');
const heat = require('./js/apm-next/apm-heatmap.js');
const polygons = require('./js/apm-next/apm-polygonise.js');
const clipping = require('./js/vendor/polygon-clipping.umd.min.js');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const lat = 46.77, lon = 23.59;
const thresholds = { medium: .55, high: .7, veryhigh: .85 };
const empty = () => ({ type: 'FeatureCollection', features: [] });
const point = (lng, latitude = lat) => ({ type: 'Feature', properties: { COORD: 'DA' }, geometry: { type: 'Point', coordinates: [lng, latitude] } });
let uatMode = 'free';
const window = {
    _localLayerData: { 0: empty(), 5: empty(), 6: empty() },
    UAT_TILE_Z: 14,
    _UAT_TILE_UNREADABLE: {},
    _uatGetTile(z, x) {
        if (uatMode === 'missing') return null;
        if (uatMode === 'unreadable') return this._UAT_TILE_UNREADABLE;
        const data = new Uint8ClampedArray(256 * 256 * 4);
        for (let y = 0; y < 256; y++) for (let px = 0; px < 256; px++) {
            const lng = (x + (px + .5) / 256) / 2 ** z * 360 - 180;
            const builtUp = uatMode === 'blocked' || (uatMode === 'split' && lng > lon + .004);
            const i = 4 * (y * 256 + px);
            data[i] = data[i + 1] = data[i + 2] = builtUp ? 255 : 0;
            data[i + 3] = 255;
        }
        return { data, size: 256 };
    }
};
const legacyContext = { window, document: { readyState: 'loading', addEventListener() {} },
    console, setTimeout, clearTimeout, performance, Uint8Array, Uint8ClampedArray };
vm.runInNewContext(read('js/archeo-potential.js'), legacyContext);
const debug = window._archeoPotentialDebug;
debug.config.UAT.RETRIES = 0;
const grid = raster.gridForBBox(core.circleBBox(lat, lon, 2200), 100);
const center = i => ({ lat: raster.cellLat(grid, Math.floor(i / grid.w)), lon: raster.cellLon(grid, i % grid.w) });
const mask = opts => window.computeArcheoExclusionMask(grid, lat, lon, 1800, opts);
function reset(mode = 'free') {
    uatMode = mode;
    window._localLayerData = { 0: empty(), 5: empty(), 6: empty() };
    window._archeoPotentialResetCache();
}
function contains(rings, lng, latitude) {
    const hit = ring => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            if (((a[1] > latitude) !== (b[1] > latitude)) && lng < (b[0] - a[0]) * (latitude - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
    };
    return hit(rings[0]) && !rings.slice(1).some(hit);
}
function workerHarness() {
    const posted = [];
    const ctx = { console };
    ctx.self = ctx;
    ctx.postMessage = value => posted.push(value);
    ctx.importScripts = (...files) => files.forEach(file => {
        vm.runInContext(read(path.join('js/apm-next', file.split('?')[0])), ctx);
    });
    vm.createContext(ctx);
    vm.runInContext(read('js/apm-next/apm-worker.js'), ctx);
    let id = 0;
    return (op, payload) => {
        ctx.onmessage({ data: { ...payload, op, id: ++id } });
        const result = posted.find(message => message.id === id);
        assert.ok(result.ok, result.error);
        return result;
    };
}

(async () => {
    reset();
    const open = await mask();
    assert.ok(open.mask.some(v => v === 0), 'free land remains scoreable even without nearby sites');
    assert.equal(open.stats.unknown, 0);
    window._localLayerData[0] = { ...empty(), features: [point(lon)] };
    // Protection from a site outside the search circle must still reach inside it.
    const exteriorLon = lon + 2000 / core.metresPerDegree(lat).lon;
    window._localLayerData[5] = { ...empty(), features: [point(exteriorLon)] };
    const protectedResult = await mask();
    let protectedCells = 0, edgeProtectedCells = 0;
    for (let i = 0; i < grid.w * grid.h; i++) {
        const p = center(i);
        if (core.haversineM(lat, lon, p.lat, p.lon) < 690) {
            assert.equal(protectedResult.mask[i], 1, '600 m radius plus 100 m buffer');
            protectedCells++;
        }
        if (!open.mask[i] && core.haversineM(lat, exteriorLon, p.lat, p.lon) < 690) {
            assert.equal(protectedResult.mask[i], 1, 'neighboring protection radius crosses search boundary');
            edgeProtectedCells++;
        }
    }
    assert.ok(protectedCells && edgeProtectedCells);
    console.log('  ok  all heritage layers and sites beyond the search boundary protect their radii');

    reset();
    const ring = [[lon - .008, lat - .008], [lon + .008, lat - .008], [lon + .008, lat + .008], [lon - .008, lat + .008], [lon - .008, lat - .008]];
    window._localLayerData[6].features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
    const boundary = await mask();
    assert.ok(boundary.stats.heritage > 0);
    for (let i = 0; i < boundary.mask.length; i++) {
        const p = center(i);
        if (contains([ring], p.lon, p.lat)) assert.equal(boundary.mask[i], 1, 'site polygon is forbidden');
    }
    console.log('  ok  heritage polygons are excluded independently of their visibility');

    reset('split');
    const split = await mask();
    assert.ok(split.stats.uat > 0 && split.mask.some(v => !v));
    for (let i = 0; i < split.mask.length; i++) {
        if (center(i).lon > lon + .005) assert.equal(split.mask[i], 1, 'built-up UAT cells never score');
    }
    reset('blocked');
    assert.ok((await mask()).mask.every(Boolean), 'fully built-up UAT has no results');
    for (const mode of ['missing', 'unreadable']) {
        reset(mode);
        const unknown = await mask();
        assert.ok(unknown.mask.every(Boolean), mode + ' UAT fails closed');
        assert.ok(unknown.stats.unknown > 0);
    }
    await assert.rejects(mask({ isCancelled: () => true }), error => error.code === 'cancelled');
    window._detectlabApiFailed = true;
    await assert.rejects(mask(), /Heritage exclusion data could not be loaded/);
    window._detectlabApiFailed = false;
    console.log('  ok  UAT, unavailable data, failed heritage downloads and cancellation cannot leak predictions');

    // Verify the pipeline's common MANUAL/TRAIN preparation actually forwards the mask.
    const src = read('js/apm-next/apm-pipeline.js');
    assert.equal((src.match(/return setPredictionAnalysis\(session, \{/g) || []).length, 2);
    const start = src.indexOf('    function setPredictionAnalysis(');
    const end = src.indexOf('    /* ── Worker client', start);
    let received;
    const ctx = { root: { computeArcheoExclusionMask: async () => ({ mask: split.mask, stats: { unknown: 2 } }) },
        checkToken(token) { if (token && token.cancelled) { const e = new Error('Cancelled'); e.code = 'cancelled'; throw e; } }, core };
    vm.createContext(ctx);
    vm.runInContext(src.slice(start, end), ctx);
    const session = { worker: { call: async (op, analysis) => { received = { op, analysis }; return {}; } } };
    const analysis = { grid, circle: { lat, lon, radiusM: 1800 } };
    const warnings = [];
    await ctx.setPredictionAnalysis(session, analysis, {}, warnings);
    assert.equal(received.analysis.exclusionMask, split.mask);
    assert.equal(warnings[0].key, 'warn.exclusionUnknown');
    // TRAIN must request UAT prewarming even when it provides authoritative sites.
    let options;
    ctx.root.computeArcheoExclusionMask = async (...args) => { options = args[4]; return { mask: split.mask, stats: { unknown: 0 } }; };
    const records = [{ lat, lon }];
    records._protectionRecords = [{ lat: lat + .001, lon }];
    await ctx.setPredictionAnalysis(session, analysis, { records }, []);
    assert.equal(options.siteRecords, records._protectionRecords);
    assert.notEqual(options.cacheOnly, true, 'TRAIN must load UAT tiles on a cold cache');
    ctx.root.computeArcheoExclusionMask = async () => ({ mask: split.mask, stats: { unknown: 5 } });
    const emptySession = { worker: { call: async () => ({ stats: { valid: 0 } }) } };
    await assert.rejects(ctx.setPredictionAnalysis(emptySession, analysis, { records }, []), e => e.key === 'err.noPredictionUat');
    ctx.root.computeArcheoExclusionMask = async () => ({ mask: split.mask, stats: { unknown: 0 } });
    await assert.rejects(ctx.setPredictionAnalysis(emptySession, analysis, { records }, []), e => e.key === 'err.noPredictionCells');
    ctx.root.computeArcheoExclusionMask = undefined;
    await assert.rejects(ctx.setPredictionAnalysis(session, analysis, {}, []), /exclusion service is unavailable/);
    console.log('  ok  both prediction modes use the shared mask before sending data to the worker');

    // Cold cache and a 50 km window larger than the bounded tile cache: all
    // blocks must be sampled before their tiles are evicted, and TRAIN scores
    // must produce visible heat while still excluding known-site buffers.
    reset();
    const savedLoader = window._uatGetTile, savedMax = debug.config.UAT.MAX_CACHED_TILES;
    const tileData = new Uint8ClampedArray([0, 0, 0, 255]);
    window._uatGetTile = async () => ({ data: tileData, size: 1 });
    debug.config.UAT.MAX_CACHED_TILES = 120;
    const largeGrid = raster.gridForBBox(core.circleBBox(lat, lon, 51000), 1000);
    const largeAnalysis = { grid: largeGrid, circle: { lat, lon, radiusM: 50000 } };
    const largeElev = new Float32Array(largeGrid.w * largeGrid.h);
    for (let i = 0; i < largeElev.length; i++) largeElev[i] = (i % largeGrid.w) * 3;
    const largeWorker = workerHarness();
    const largeSession = { worker: { call: async (op, payload) => largeWorker(op, { ...payload, elev: largeElev }) } };
    ctx.root.computeArcheoExclusionMask = window.computeArcheoExclusionMask;
    const prepared = await ctx.setPredictionAnalysis(largeSession, largeAnalysis, { records: [{ lat, lon }] }, []);
    assert.equal(largeSession.exclusionStats.unknown, 0, 'large cold-cache area is fully verified');
    assert.ok(largeSession.exclusionStats.heritage > 0, 'training sites still protect their surroundings');
    assert.ok(prepared.stats.valid > 0);
    const trainedModel = { weights: { altitude: 1 }, curves: { altitude: [[0, .4], [1, .9]] } };
    const largeResult = largeWorker('score', { mode: 'train', model: trainedModel, waterClasses: [], thresholds, minAreaM2: 1e12 });
    assert.ok(largeResult.scoreStats.cells > 0);
    assert.ok(largeResult.heatmap.rgba.some((v, i) => i % 4 === 3 && v > 0), 'TRAIN produces visible heat');
    window._uatGetTile = savedLoader;
    debug.config.UAT.MAX_CACHED_TILES = savedMax;
    reset();
    console.log('  ok  cold-cache TRAIN produces heat across a 50 km window without evicting its UAT masks');

    // Real worker: MANUAL, TRAIN, and repeated scoring retain the same forbidden cells.
    const send = workerHarness();
    const elev = new Float32Array(grid.w * grid.h);
    for (let i = 0; i < elev.length; i++) elev[i] = (i % grid.w) * 3;
    const set = send('setAnalysis', { grid, elev, smooth: false, circle: { lat, lon, radiusM: 1800 }, exclusionMask: split.mask });
    assert.ok(set.stats.valid > 0);
    const model = { weights: { relief: 1, water: 0, soil: 0 }, curves: core.DEFAULT_CURVES };
    // Use a genuine trained model for TRAIN scoring.
    const n = 60, S = { n, y: new Uint8Array(n), fold: new Uint8Array(n), vals: {
        altitude: new Float64Array(n), slope: new Float64Array(n), aspect: new Float64Array(n), soil: new Float64Array(n)
    } };
    for (let i = 0; i < n; i++) { S.y[i] = i % 2; S.fold[i] = i % 5; S.vals.altitude[i] = (i % 10) / 10; S.vals.slope[i] = i % 15; S.vals.aspect[i] = i * 6; S.vals.soil[i] = (i % 7) / 7; }
    const trained = send('train', { S, waterClasses: [], minSlopeDeg: 0, folds: 5 }).result;
    for (const mode of ['manual', 'train', 'manual']) {
        const result = send('score', { mode, model: trained.model, curves: core.DEFAULT_CURVES, weights: model.weights,
            minSlopeDeg: 0, preferredAspectDeg: 180, waterClasses: [], thresholds, minAreaM2: 0, smoothIters: 1 });
        for (let i = 0; i < split.mask.length; i++) {
            if (!split.mask[i]) continue;
            const p = center(i), pixel = new Uint8Array(4);
            heat.sampleRGBA(result.heatmap, p.lon, p.lat, pixel, 0);
            assert.equal(pixel[3], 0, mode + ' heat is transparent in excluded cells');
            assert.ok(!result.geojson.features.some(f => contains(f.geometry.coordinates, p.lon, p.lat)), mode + ' export excludes forbidden cells');
        }
        assert.equal(result.scoreStats.cells, set.stats.valid);
    }
    send('setAnalysis', { grid, elev, smooth: false, circle: { lat, lon, radiusM: 1800 }, exclusionMask: new Uint8Array(elev.length).fill(1) });
    const noResults = send('score', { mode: 'manual', curves: core.DEFAULT_CURVES, weights: model.weights,
        minSlopeDeg: 0, preferredAspectDeg: 180, waterClasses: [], thresholds, minAreaM2: 0 });
    assert.equal(noResults.geojson.features.length, 0);
    assert.equal(noResults.scoreStats.cells, 0);
    assert.ok(noResults.heatmap.rgba.every(v => v === 0));
    assert.ok(Object.values(noResults.areaKm2).every(v => v === 0));
    console.log('  ok  real MANUAL/TRAIN worker scoring and rescoring keep heatmaps and exports masked');

    // Adversarial rendering: a tiny forbidden hole with an area smaller than minAreaM2.
    const g = { w: 12, h: 12, west: lon, north: lat, dLon: .0001, dLat: .0001 };
    const scores = new Float32Array(144).fill(1), forbidden = new Uint8Array(144);
    forbidden[6 * 12 + 6] = 1;
    scores[6 * 12 + 6] = NaN;
    const geojson = polygons.polygonise(scores, g, thresholds, { highestOnly: true, minAreaM2: 500, smoothIters: 2, exclusionMask: forbidden });
    assert.ok(geojson.features.length, 'surrounding hotspot remains');
    const forbiddenRect = [[[[lon + .0006, lat - .0006], [lon + .0007, lat - .0006], [lon + .0007, lat - .0007], [lon + .0006, lat - .0007], [lon + .0006, lat - .0006]]]];
    for (const feature of geojson.features) {
        assert.equal(clipping.intersection([feature.geometry.coordinates], forbiddenRect).length, 0, 'no polygon area overlaps the exclusion hole');
    }
    const downsampled = heat.buildRaster(scores, g, thresholds, 3, forbidden);
    const pixel = new Uint8Array(4);
    heat.sampleRGBA(downsampled, lon + .00065, lat - .00065, pixel, 0);
    assert.equal(pixel[3], 0, 'downsampling/interpolation cannot fill protected holes');
    console.log('  ok  tiny holes survive area filtering, smoothing, heat downsampling and interpolation');
    const html = read('index.html'), sw = read('sw.js');
    const TAG = '20261102-apm-train-bounded-grid';
    for (const [file, version] of [['apm-heatmap', '20261102-apm-async-tiles'],
        ['apm-raster', TAG], ['apm-pipeline', TAG]]) {
        const tag = 'js/apm-next/' + file + '.js?v=' + version;
        assert.ok(sw.includes(tag), file + ' is versioned and precached');
    }
    for (const file of ['apm-i18n', 'apm-ui']) {
        const tag = 'js/apm-next/' + file + '.js?v=20261102-apm-highest-only-view';
        assert.ok(html.includes(tag) && sw.includes(tag), file + ' is versioned and precached');
    }
    assert.ok(sw.includes('js/apm-next/apm-polygonise.js?v=20261101-train-source'));
    assert.ok(sw.includes('js/apm-next/apm-worker.js?v=20261102-apm-highest-only-view'));
    assert.ok(read('js/apm-next/apm-ui.js').includes('apm-worker.js?v=20261102-apm-highest-only-view'));
    assert.ok(html.includes('js/archeo-potential.js?v=' + TAG));
    assert.ok(sw.includes('js/archeo-potential.js?v=' + TAG));
    assert.match(sw, /const CACHE_NAME = 'detectlab-v385-apm-highest-only'/);
    console.log('  ok  updated prediction, mask, worker and display assets are wired into the PWA cache');
    console.log('\nAll APM spatial-exclusion checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
