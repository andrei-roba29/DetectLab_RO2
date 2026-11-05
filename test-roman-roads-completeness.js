/* Regression tests for road completeness, including the Itiner-e segment
 * through Aiton, Cluj. No network, browser or npm dependencies.
 * Run: node test-roman-roads-completeness.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder, TextDecoder } = require('util');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const parserSource = read('js/roman-roads-parser.js');
const layerSource = read('js/roman-roads.js');
const workerSource = read('js/roman-roads-worker.js');
const mapSource = read('js/map-app.js');
const aiton = JSON.parse(read('test/fixtures/roman-road-aiton.geojson'));
const aitonPoint = [23.738356, 46.6873];
const config = { maxBatchSegments: 8, maxSegments: 2000, maxVertices: 100000, maxBytes: 4 * 1024 * 1024 };

function dummyRoad(i) {
    return { type: 'Feature', id: 'dummy-' + i, geometry: {
        type: 'LineString', coordinates: [[-8 + i * 0.002, 35], [-7.999 + i * 0.002, 35.001]]
    } };
}
const roads = Array.from({ length: 75 }, (_, i) => dummyRoad(i));
roads.splice(25, 0, aiton);
const text = roads.map(r => JSON.stringify(r)).join('\n'); // no final newline
const bytes = new TextEncoder().encode(text);

function baseSandbox() {
    const sandbox = {
        console: { warn() {}, log() {}, info() {} }, Math, JSON, isFinite, isNaN, Date, Array, Object,
        Promise, String, Number, RegExp, Error, URL, TextEncoder, TextDecoder,
        Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array,
        setTimeout, clearTimeout, performance: { now: () => Date.now() }
    };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    return sandbox;
}

function makeLayerHost() {
    const sandbox = baseSandbox();
    let recorder;
    function context() {
        return {
            setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
            stroke() {}, moveTo(x, y) { recorder.moves.push([x, y]); },
            lineTo(x, y) { recorder.lines.push([x, y]); }, fillRect() { recorder.dots++; }
        };
    }
    sandbox.navigator = { userAgent: 'test' };
    sandbox.document = {
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, getContext: context })
    };
    sandbox.devicePixelRatio = 1;
    sandbox.requestAnimationFrame = fn => setTimeout(fn, 0);
    function GridLayer() {}
    GridLayer.prototype.options = { tileSize: 256 };
    GridLayer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
    GridLayer.prototype._tileCoordsToKey = c => `${c.x}:${c.y}:${c.z}`;
    GridLayer.prototype.onAdd = function () {};
    GridLayer.prototype.onRemove = function () {};
    GridLayer.extend = function (props) {
        function Cls(options) {
            this.options = Object.assign({}, Cls.prototype.options);
            this.initialize(options);
        }
        Cls.prototype = Object.create(GridLayer.prototype);
        Object.assign(Cls.prototype, props);
        return Cls;
    };
    sandbox.L = { GridLayer, Layer: function () {}, Util: { setOptions: (o, opts) => Object.assign(o.options, opts) } };
    vm.runInContext(parserSource, sandbox, { filename: 'roman-roads-parser.js' });
    vm.runInContext(layerSource, sandbox, { filename: 'roman-roads.js' });
    const P = sandbox.DetectLabRomanRoadsParser;
    const layer = sandbox.DetectLabRomanRoads.createLayer({ maxItemsPerTile: 4 });
    function paintAt(lng, lat, z) {
        const scale = 256 * Math.pow(2, z), k = P.PX_A * scale;
        const coords = { z, x: Math.floor((P.mercX(lng) * k + scale / 2) / 256),
            y: Math.floor((scale / 2 - P.mercY(lat) * k) / 256) };
        recorder = { moves: [], lines: [], dots: 0 };
        const tile = layer.createTile(coords);
        layer._paintEntry(tile._dlRomanEntry);
        return recorder;
    }
    return { sandbox, P, layer, paintAt };
}

function responseFor(chunks, noStream) {
    let i = 0;
    return {
        ok: true,
        headers: { get: name => name === 'content-length' ? String(chunks.reduce((n, chunk) => n + chunk.length, 0)) : null },
        body: noStream ? null : { getReader: () => ({
            read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
            cancel: () => Promise.resolve()
        }) },
        text: () => Promise.resolve(new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c)))))
    };
}

function workerHarness(chunks, noStream, autoAck) {
    const sandbox = baseSandbox();
    const messages = [];
    let outstanding = 0, maxOutstanding = 0;
    sandbox.location = { href: 'https://example.test/js/roman-roads-worker.js?v=test' };
    sandbox.importScripts = () => vm.runInContext(parserSource, sandbox);
    sandbox.addEventListener = (type, fn) => { if (type === 'message') sandbox.messageHandler = fn; };
    sandbox.fetch = () => Promise.resolve(responseFor(chunks, noStream));
    sandbox.postMessage = msg => {
        messages.push(msg);
        if (msg.type === 'batch') {
            outstanding++;
            maxOutstanding = Math.max(maxOutstanding, outstanding);
            if (autoAck) setTimeout(ack, 0);
        }
    };
    vm.runInContext(workerSource, sandbox, { filename: 'roman-roads-worker.js' });
    function ack() {
        if (outstanding > 0) outstanding--;
        sandbox.messageHandler({ data: { cmd: 'ack' } });
    }
    return {
        sandbox, messages, ack,
        outstanding: () => outstanding,
        maxOutstanding: () => maxOutstanding,
        start: () => sandbox.messageHandler({ data: { cmd: 'start', url: 'https://example.test/roads.ndjson', config } })
    };
}

async function waitUntil(fn, message) {
    const deadline = Date.now() + 5000;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

function assertAitonOnMap(host, payloads, label) {
    for (const p of payloads) host.layer.addBatch(p);
    assert.strictEqual(host.layer.getStats().segments, roads.length, label + ': all roads are in the layer');
    assert(host.layer.roadSegmentsInBounds(46.6871, 23.7382, 46.6875, 23.7385) >= 1,
        label + ': Aiton road is reachable through the spatial index');
    const dist = host.layer.nearestRoadMeters(aitonPoint[1], aitonPoint[0], 10);
    assert(dist !== null && dist < 1, label + ': analysis can find the Aiton road');
    const features = host.layer._dl3dFeatures().geojson.features;
    assert(features.some(f => Math.abs(f.geometry.coordinates[0][0] - 23.710223) < 1e-6 &&
        Math.abs(f.geometry.coordinates[0][1] - 46.629059) < 1e-6), label + ': Aiton road reaches the 3D mirror');
    host.layer._itemBudget = 4; // emulate the adaptive budget after a slow tile
    for (const z of [8, 12, 15]) {
        const drawing = host.paintAt(aitonPoint[0], aitonPoint[1], z);
        assert(drawing.moves.length > 0 && drawing.lines.length > 0,
            label + ': Aiton road must be drawn at zoom ' + z + ' even when other regions have many roads');
    }
}

async function workerCase(chunks, noStream, label) {
    const worker = workerHarness(chunks, noStream, true);
    worker.start();
    await waitUntil(() => worker.messages.some(m => m.type === 'done' || m.type === 'error'), label + ': worker timed out');
    const error = worker.messages.find(m => m.type === 'error');
    assert(!error, label + ': ' + (error && error.message));
    const done = worker.messages.find(m => m.type === 'done');
    const batches = worker.messages.filter(m => m.type === 'batch').map(m => m.payload);
    assert.strictEqual(done.stats.segments, roads.length, label + ': every source line is kept');
    assert.strictEqual(done.stats.sampled, 0, label + ': an under-budget file must not be sampled');
    assert(batches.every(p => p.n <= config.maxBatchSegments), label + ': one big chunk is still batched');
    assert(worker.maxOutstanding() <= 4, label + ': backpressure applies inside a chunk');
    assertAitonOnMap(makeLayerHost(), batches, label);
}

async function mainThreadCase(chunks, noStream, label, noDecoder) {
    const host = makeLayerHost();
    if (noDecoder) host.sandbox.TextDecoder = undefined;
    const batches = [];
    host.sandbox.fetch = () => Promise.resolve(responseFor(chunks, noStream));
    const stats = await new Promise((resolve, reject) => {
        host.sandbox.DetectLabRomanRoads.load('https://example.test/roads.ndjson', {
            noWorker: true, config,
            onBatch: payload => batches.push(payload), onDone: resolve, onError: reject
        });
    });
    assert.strictEqual(stats.segments, roads.length, label + ': every source line is kept');
    assert.strictEqual(stats.sampled, 0, label + ': an under-budget file must not be sampled');
    assert(batches.every(p => p.n <= config.maxBatchSegments), label + ': large responses are batched');
    assertAitonOnMap(host, batches, label);
}

async function statusCases() {
    const sandbox = baseSandbox();
    let callbacks, clears = 0, count = 0, status = '';
    const layer = {
        addBatch(payload) { count += payload.n; }, clearData() { clears++; count = 0; },
        getStats() { return { segments: count, vertices: count * 2, bytes: count * 80 }; }
    };
    sandbox.DetectLabRomanRoads = { configForDevice: () => ({}), load(url, cb) {
        callbacks = cb; return { cancel() {} };
    } };
    sandbox._roadsLayer = () => layer;
    sandbox._romanEnabled = { roads: true };
    sandbox._romanVisible = true;
    sandbox._romanGroup = { hasLayer: () => true, addLayer() {} };
    sandbox._romanStatus = (name, value) => { status = value; };
    const start = mapSource.indexOf('function _roadsMb(');
    const end = mapSource.indexOf('// ── ROMAN: load helpers', start);
    assert(start >= 0 && end > start, 'road loading/status code is available for the integration check');
    vm.runInContext('var ROMAN_ROADS_URL = "/roads", _roadsLoading = false, _roadsDone = false, _roadsLoad = null;\n' +
        mapSource.slice(start, end), sandbox);
    sandbox._loadRomanRoads();
    callbacks.onBatch({ n: 2 });
    assert.equal(count, 2, 'a partial batch reached the layer');
    callbacks.onError('connection lost');
    assert.equal(count, 0, 'a failed load clears partial geometry');
    assert.equal(clears, 1, 'a failed load clears the data exactly once');
    assert(status.includes('connection lost'), 'the failure reports why');

    sandbox._loadRomanRoads();
    callbacks.onBatch({ n: 2 });
    callbacks.onDone({ segments: 2, vertices: 4, seen: 4, sampled: 1, skipped: 1 });
    assert.equal(count, 2, 'retry does not include stale partial roads');
    assert(status.includes('1 omitted (memory limit)') && status.includes('1 invalid or unsupported'),
        'the final status distinguishes actual budget omissions from invalid geometry');

    sandbox._roadsDone = false;
    count = 0;
    sandbox._loadRomanRoads();
    callbacks.onDone({ segments: 0, seen: 0, skipped: 2 });
    assert(status.includes('no geometry recognised') && status.includes('2 invalid or unsupported'),
        'an entirely invalid source still reports skipped records');
}

(async function () {
    console.log('[Test] Roman-road completeness — Aiton and large responses...');
    const host = makeLayerHost();
    const collector = host.P.createCollector(config);
    roads.forEach(r => collector.addRecord(r)); // intentionally more than two batches
    const direct = collector.flush().payload;
    assert.strictEqual(direct.n, roads.length, 'batch size alone must not discard under-budget roads');
    assert.strictEqual(collector.stats().sampled, 0, 'no implicit in-place sampling');
    assertAitonOnMap(host, [direct], 'collector');

    // Deduplication must not erase short valid segments or their endpoints.
    const tiny = host.P.createCollector({});
    const start = [23.7, 46.7], end = [23.700002, 46.7];
    tiny.addRecord({ geometry: { type: 'LineString', coordinates: [start, end] } });
    const short = tiny.flush();
    assert(short && short.payload.n === 1 && short.payload.vertices === 2, 'sub-metre road is retained');
    assert(Math.abs(short.payload.origins[0] + short.payload.deltas[2] - host.P.mercX(end[0])) < 0.001,
        'the original last endpoint survives deduplication');
    tiny.addRecord({ geometry: { type: 'LineString', coordinates: [start, end, [NaN, NaN]] } });
    const trailingInvalid = tiny.flush().payload;
    assert(Math.abs(trailingInvalid.origins[0] + trailingInvalid.deltas[2] - host.P.mercX(end[0])) < 0.001,
        'the last valid endpoint survives invalid trailing coordinates');
    tiny.addRecord({ lat: 46.7, lon: 23.7 });
    assert(tiny.flush().payload.n === 1, 'point records survive as zero-length lines');

    const multi = host.P.createCollector(config);
    multi.addRecord({ type: 'MultiLineString', coordinates: roads.map(r => r.geometry.coordinates) });
    assert.strictEqual(multi.flush().payload.n, roads.length,
        'one multipart record can exceed the transfer threshold without losing paths');

    const hard = host.P.createCollector({ maxSegments: 3, maxBatchSegments: 2, maxVertices: 40, maxBytes: 4096 });
    for (let i = 0; i < 100; i++) {
        hard.addRecord({ geometry: { type: 'LineString', coordinates: [[0, 35 + i * 0.001], [0.1, 35 + i * 0.001]] } });
        if (hard.shouldFlush()) hard.flush();
    }
    assert(hard.stats().segments <= 8 && hard.stats().sampled > 0,
        'even an all-long-roads stream has a bounded hard memory ceiling');
    const hardMulti = host.P.createCollector({ maxSegments: 3, maxBatchSegments: 2, maxVertices: 40, maxBytes: 4096 });
    hardMulti.addRecord({ type: 'MultiLineString', coordinates: Array.from({ length: 100 }, (_, i) =>
        [[0, 35 + i * 0.001], [0.1, 35 + i * 0.001]]) });
    assert(hardMulti.stats().segments <= 8 && hardMulti.stats().sampled > 0,
        'the hard memory ceiling also applies within one oversized multipart record');

    // A busy tile may be sampled, but a tile one item over budget should not
    // arbitrarily lose half its roads; use exactly the available budget.
    const dense = makeLayerHost(), denseCollector = dense.P.createCollector({});
    for (let i = 0; i < 7; i++) {
        const lng = aitonPoint[0] + i * 0.00001;
        denseCollector.addRecord({ geometry: { type: 'LineString', coordinates: [[lng, 46.6873], [lng + 0.00002, 46.6874]] } });
    }
    dense.layer.addBatch(denseCollector.flush().payload);
    const denseDrawing = dense.paintAt(aitonPoint[0], aitonPoint[1], 14);
    assert.strictEqual(denseDrawing.moves.length, 4, 'a crowded tile uses all four available item slots');
    assert.strictEqual(dense.layer.getStats().cappedTiles, 1, 'sampling a crowded tile is observable');

    // Long segments live in both the centre-cell index and the separate span
    // list. Count them once without losing their far ends on detailed tiles.
    const spans = makeLayerHost(), spanCollector = spans.P.createCollector({});
    spanCollector.addRecord({ geometry: { type: 'LineString', coordinates: [[23.48, 46.5], [23.99, 46.9]] } });
    spanCollector.addRecord({ geometry: { type: 'LineString', coordinates: [[23.73835, 46.6873], [23.73836, 46.6874]] } });
    const spanPage = spanCollector.flush().payload;
    assert.strictEqual(spanPage.spanItems.length, 1, 'fixture contains one multi-cell span');
    spans.layer.addBatch(spanPage);
    spans.layer._itemBudget = 2;
    for (const z of [8, 12]) {
        const drawing = spans.paintAt(aitonPoint[0], aitonPoint[1], z);
        assert.strictEqual(drawing.moves.length, 2, 'a span and a local road are each drawn once at z' + z);
    }
    assert.strictEqual(spans.layer.getStats().cappedTiles || 0, 0, 'overlapping indices do not falsely exceed the tile budget');
    assert.strictEqual(spans.layer.roadSegmentsInBounds(46.6872, 23.7382, 46.6876, 23.7385), 2,
        'analysis counts a multi-cell span only once');
    assert.strictEqual(spans.paintAt(23.48, 46.5, 15).moves.length, 1,
        'a long road remains reachable far from its centre cell');
    spans.layer.clearData();
    assert.strictEqual(spans.layer.getStats().segments, 0, 'clearing partial data resets the layer');
    assert.strictEqual(spans.layer._dl3dFeatures().geojson.features.length, 0, 'clearing partial data resets the 3D mirror');
    assert.strictEqual(spans.layer.nearestRoadMeters(46.6873, 23.738356, 10), null,
        'analysis cannot see geometry after a failed load is cleared');

    const oneChunk = [bytes];
    const smallChunks = [];
    for (let i = 0; i < bytes.length; i += 257) smallChunks.push(bytes.slice(i, i + 257));
    await workerCase(oneChunk, false, 'worker / one large chunk');
    await workerCase(oneChunk, true, 'worker / response.text');
    await workerCase(smallChunks, false, 'worker / split chunks');
    await mainThreadCase(oneChunk, false, 'main thread / one large chunk');
    await mainThreadCase(oneChunk, true, 'main thread / response.text');
    await mainThreadCase(oneChunk, false, 'main thread / no TextDecoder', true);
    await mainThreadCase(smallChunks, false, 'main thread / split chunks');

    const formats = new TextEncoder().encode('LINESTRING (23.7 46.7, 23.701 46.701)\n' +
        '[[23.8,46.8],[23.801,46.801]]\n{bad json\nunsupported record');
    const formatWorker = workerHarness([formats], true, true);
    formatWorker.start();
    await waitUntil(() => formatWorker.messages.some(m => m.type === 'done' || m.type === 'error'), 'format worker timed out');
    const formatDone = formatWorker.messages.find(m => m.type === 'done');
    assert(formatDone && formatDone.stats.segments === 2 && formatDone.stats.skipped === 2,
        'worker accepts bare WKT and JSON-array lines and counts invalid records');
    const formatHost = makeLayerHost();
    formatHost.sandbox.fetch = () => Promise.resolve(responseFor([formats], true));
    const fallbackFormats = await new Promise((resolve, reject) => formatHost.sandbox.DetectLabRomanRoads.load('/roads', {
        noWorker: true, config, onDone: resolve, onError: reject
    }));
    assert.strictEqual(fallbackFormats.segments, 2, 'fallback accepts bare WKT and JSON-array lines');
    assert.strictEqual(fallbackFormats.skipped, 2, 'fallback counts invalid records');

    const cancelledHost = makeLayerHost();
    cancelledHost.sandbox.fetch = () => Promise.resolve(responseFor(oneChunk, true));
    let handle, cancelledBatches = 0, cancelledDone = false;
    handle = cancelledHost.sandbox.DetectLabRomanRoads.load('/roads', {
        noWorker: true, config, onBatch() { cancelledBatches++; handle.cancel(); },
        onDone() { cancelledDone = true; }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(cancelledBatches, 1, 'main-thread cancellation stops an in-progress text response');
    assert(!cancelledDone, 'a cancelled fallback must not report success');

    // Do not let one huge chunk bypass the four-batch backpressure limit.
    const blocked = workerHarness(oneChunk, false, false);
    blocked.start();
    await waitUntil(() => blocked.messages.filter(m => m.type === 'batch').length >= 4, 'worker never reached backpressure');
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(blocked.messages.filter(m => m.type === 'batch').length, 4, 'one chunk stops at four unacknowledged batches');
    assert(!blocked.messages.some(m => m.type === 'done'), 'one chunk cannot finish without acknowledgements');
    const deadline = Date.now() + 5000;
    while (!blocked.messages.some(m => m.type === 'done')) {
        if (Date.now() > deadline) throw new Error('worker did not resume after acknowledgements');
        while (blocked.outstanding()) blocked.ack();
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert(blocked.maxOutstanding() <= 4, 'backpressure remains bounded until completion');

    const cancelledWorker = workerHarness(oneChunk, true, false);
    cancelledWorker.start();
    await waitUntil(() => cancelledWorker.outstanding() === 4, 'text worker did not reach backpressure');
    cancelledWorker.sandbox.messageHandler({ data: { cmd: 'cancel' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert(!cancelledWorker.messages.some(m => m.type === 'done'), 'worker cancellation wakes the backpressure wait');
    assert.strictEqual(cancelledWorker.messages.filter(m => m.type === 'batch').length, 4,
        'worker cancellation stops parsing the remainder of the text response');
    await statusCases();
    console.log('  ✓ Aiton stays indexed and visible; worker and fallback keep every under-budget road');
    console.log('  ✓ Errors clear partial data; real omissions are reported and retry is clean');
    console.log('✅ test-roman-roads-completeness.js passed.');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
