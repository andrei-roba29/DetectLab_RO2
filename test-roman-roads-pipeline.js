/* ============================================================================
 * test-roman-roads-pipeline.js
 * ----------------------------------------------------------------------------
 * What this locks down (the bug the user hit was a *shape* bug, not a typo):
 *
 *   1. the roads no longer build one Leaflet vector per segment on the main
 *      thread — no `_readNdjsonStream` / `pending.push(ll)` / `L.polyline`
 *      loop, and the canvas layer is what the Roman toggle drives;
 *   2. `js/roman-roads-parser.js` batches correctly: every flush hands over a
 *      *fresh* batch (a flush that forgets to reset its cursors re-emits the
 *      whole file on every batch — the layer then grows quadratically and the
 *      tab dies, which is exactly what "loads slowly and then crashes" was);
 *   3. the per-batch spatial grid is a valid CSR index (an off-by-one there
 *      resolves every tile lookup to an empty range: nothing is ever drawn);
 *   4. the budget still bounds memory on a stream ten times bigger than the
 *      device allowance (uniform sampling, long roads kept, hard stop);
 *   5. `js/roman-roads-worker.js` speaks the batch/progress/done protocol and
 *      keeps at most MAX_OUTSTANDING payloads in flight (backpressure);
 *   6. the canvas maths maps Mercator metres to the pixel Leaflet would use.
 *
 * No network, no browser, no npm dependency. Usage:
 *     node test-roman-roads-pipeline.js
 * ========================================================================== */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

const indexHtml = read('index.html');
const mapApp = read('js/map-app.js');
const sw = read('sw.js');
const archeo = read('js/archeo-report.js');
const parserSrc = read('js/roman-roads-parser.js');
const layerSrc = read('js/roman-roads.js');
const workerSrc = read('js/roman-roads-worker.js');

/* The roads' own assets were last touched by the roads work; map-app.js was
 * re-tagged since — most recently by the collapsible ArcGIS base-map list. */
const VERSION_TAG = '20261015-roman-roads';
const MAP_APP_TAG = '20261021-albania-country-group';
console.log('[Test] Roman roads — worker parser, canvas layer, no per-segment DOM...');

/* ── 1. wiring ─────────────────────────────────────────────────────────────
 * The old loader is what crashed the page; none of it may come back. */
assert(!mapApp.includes('_readNdjsonStream'), 'the main-thread NDJSON reader is gone');
assert(!mapApp.includes('_roadStyle') && !mapApp.includes('_thinPath') && !mapApp.includes('_recordPaths'),
    'the per-segment polyline pipeline is gone from map-app.js');
assert(!mapApp.includes('pending.push(ll)'), 'no per-segment polyline queue is left');
assert(mapApp.includes('window.DetectLabRomanRoads.load(ROMAN_ROADS_URL'), 'map-app drives the shared loader');
assert(mapApp.includes('factory.createLayer({'), 'map-app builds the canvas layer');
assert(mapApp.includes("config: window.DetectLabRomanRoads.configForDevice()"), 'the device budget is applied');
assert(mapApp.includes('window._romanRoadsLayer = lyr'), 'the analysis panel can reuse the loaded roads');
assert(mapApp.includes("_romanStatus('roads', 'Roads: ' + parts.join(' · '))"), 'live status is reported');
assert(mapApp.includes("'Roads: ' + segs.toLocaleString() + ' segments loaded.'"), 'the final segment count is reported');
assert(mapApp.includes('onError: function (message)'), 'a failed stream is surfaced, not swallowed');
console.log('  ✓ map-app.js loads roads through the worker + canvas layer');

const iParser = indexHtml.indexOf('js/roman-roads-parser.js?v=' + VERSION_TAG);
const iLayer = indexHtml.indexOf('js/roman-roads.js?v=' + VERSION_TAG);
const iMapApp = indexHtml.indexOf('js/map-app.js?v=' + MAP_APP_TAG);
assert(iParser > 0 && iLayer > 0 && iMapApp > 0, 'index.html loads both new modules and the versioned map app');
assert(iParser < iMapApp && iLayer < iMapApp, 'the modules are loaded before map-app.js');
['js/roman-roads-parser.js?v=' + VERSION_TAG, 'js/roman-roads.js?v=' + VERSION_TAG,
    'js/roman-roads-worker.js?v=' + VERSION_TAG].forEach(asset => {
        assert(sw.includes("'" + asset + "'"), 'sw.js precaches ' + asset);
    });
/* The worker is what a PWA must be able to fetch offline — and it has to be
 * the same version as the page that created it. */
assert(indexHtml.includes('js/map-app.js?v=' + MAP_APP_TAG) && sw.includes('js/map-app.js?v=' + MAP_APP_TAG),
    'index.html and sw.js agree on the map-app version');
console.log('  ✓ parser, layer and worker are shipped and precached');

/* ── 2. parser ────────────────────────────────────────────────────────────
 * Runs the real module in a vm (no DOM needed). */
function parserSandbox() {
    const sandbox = { console: { warn() {}, log() {} }, Math, JSON, isFinite, isNaN, Date, Array, Object,
        Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array, Promise, setTimeout, clearTimeout };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(parserSrc, sandbox, { filename: 'roman-roads-parser.js' });
    return sandbox;
}
const P = parserSandbox().DetectLabRomanRoadsParser;
assert(P && P.createCollector, 'the parser exposes a collector');

/* a straight segment in [lng, lat] order, GeoJSON style */
function road(lng, lat, n, stepLng, stepLat) {
    const coords = [];
    for (let i = 0; i < n; i++) coords.push([lng + i * stepLng, lat + i * stepLat]);
    return { geometry: { type: 'LineString', coordinates: coords } };
}

/* 2a. batching: no duplication, no unbounded batch growth */
{
    const collector = P.createCollector({ maxBatchSegments: 500 });
    const TOTAL = 5000;
    let sent = 0, batches = 0, biggest = 0;
    for (let i = 0; i < TOTAL; i++) {
        collector.addRecord(road(5 + (i % 90) * 0.4, 36 + (i % 40) * 0.3, 6, 0.002, 0.001));
        if (collector.shouldFlush()) {
            const framed = collector.flush();
            assert(framed, 'a flush that reports work hands back a payload');
            sent += framed.payload.n;
            biggest = Math.max(biggest, framed.payload.n);
            batches++;
        }
    }
    const last = collector.flush();
    if (last) { sent += last.payload.n; biggest = Math.max(biggest, last.payload.n); batches++; }
    assert.strictEqual(sent, TOTAL, 'every segment is handed over exactly once');
    assert(collector.stats().segments === TOTAL, 'the cumulative stats see the whole stream');
    assert(batches >= Math.floor(TOTAL / 500), 'the stream really was split into batches');
    assert(biggest <= 500 * 2, 'no batch grows past its flush size');
    assert.strictEqual(collector.flush(), null, 'flushing an empty collector is a no-op');
    console.log('  ✓ ' + TOTAL.toLocaleString() + ' segments in ' + batches +
        ' batches, none duplicated, largest ' + biggest);
}

/* 2b. the CSR grid index must be a valid, complete grouping */
{
    const collector = P.createCollector({ maxBatchSegments: 4000 });
    for (let i = 0; i < 1200; i++) {
        collector.addRecord(road(-6 + (i % 60) * 0.9, 33 + (i % 30) * 0.7, 5, 0.004, 0.003));
    }
    const p = collector.flush().payload;
    assert(p.cellKeys.length >= 1, 'the batch carries a grid index');
    assert.strictEqual(p.cellStart.length, p.cellKeys.length + 1, 'CSR has one more offset than cells');
    assert.strictEqual(p.cellStart[p.cellStart.length - 1], p.n, 'the last offset closes the item array');
    for (let g = 0; g < p.cellKeys.length; g++) {
        assert(p.cellStart[g] <= p.cellStart[g + 1], 'cell offsets are monotonic (group ' + g + ')');
        if (g) assert(p.cellKeys[g] > p.cellKeys[g - 1], 'cell keys are sorted and unique');
    }
    const seenIdx = new Set();
    for (let j = 0; j < p.cellItems.length; j++) {
        const i = p.cellItems[j];
        assert(i < p.n, 'every grid item points at a segment of this batch');
        assert(!seenIdx.has(i), 'a segment is indexed exactly once (segment ' + i + ')');
        seenIdx.add(i);
    }
    assert.strictEqual(seenIdx.size, p.n, 'every segment is reachable through the grid');
    console.log('  ✓ grid index is a valid CSR grouping (' + p.cellKeys.length + ' cells, ' + p.n + ' segments)');
}

/* 2c. geometry: Mercator metres, relative deltas, bounding boxes */
{
    const collector = P.createCollector({});
    const src = [[12.5, 41.9], [12.6, 41.95], [12.62, 41.99]];
    collector.addRecord({ geometry: { type: 'LineString', coordinates: src } });
    const p = collector.flush().payload;
    assert.strictEqual(p.n, 1, 'the record became one segment');
    assert(p.starts[1] >= 2, 'the vertices (minus noise) were kept');
    const ox = p.origins[0], oy = p.origins[1];
    assert(Math.abs(ox - P.mercX(12.5)) < 1e-6 && Math.abs(oy - P.mercY(41.9)) < 1e-6,
        'the origin is the first vertex in Mercator metres');
    for (let v = p.starts[0]; v < p.starts[1]; v++) {
        const mx = ox + p.deltas[v * 2], my = oy + p.deltas[v * 2 + 1];
        const hit = src.some(c => Math.abs(mx - P.mercX(c[0])) < 0.01 && Math.abs(my - P.mercY(c[1])) < 0.01);
        assert(hit, 'vertex ' + v + ' decodes back to a source coordinate (within 1 cm)');
    }
    /* bounds are Float32 metres (sub-metre), used for culling; the geometry
     * itself is Float64 origins + Float32 deltas, so it stays exact. */
    assert(Math.abs(p.bounds[0] - P.mercX(12.5)) < 1 && Math.abs(p.bounds[2] - P.mercX(12.62)) < 1,
        'bounds carry the segment extent in metres');
    assert(p.extent[0] <= P.mercX(12.5) && p.extent[2] >= P.mercX(12.62),
        'the batch extent is the union of its segments');
    console.log('  ✓ geometry decodes back to the source coordinates');
}

/* 2d. the record shapes that used to load must keep loading */
{
    const shapes = [
        { wkt: 'LINESTRING (12.49 41.89, 12.51 41.91, 12.53 41.92)' },
        { geom: [[12.49, 41.89], [12.51, 41.91]] },
        { geometry: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[12.49, 41.89], [12.51, 41.91]] } } },
        { geometry: { type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[12.49, 41.89], [12.51, 41.91]] }] } },
        { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[12.49, 41.89], [12.51, 41.91]] } }] },
        { paths: [[[126535, 4023620], [126545, 4023630]]] },                       /* already projected */
        [[[12.49, 41.89], [12.51, 41.91]]]                                          /* bare coordinates */
    ];
    shapes.forEach((rec, i) => {
        const collector = P.createCollector({});
        collector.addRecord(rec);
        const framed = collector.flush();
        assert(framed && framed.payload.n >= 1, 'record shape #' + i + ' is still understood');
    });
    const projected = P.createCollector({});
    projected.addRecord({ geometry: { type: 'LineString', coordinates: [[1388609, 5097355], [1388619, 5097365]] } });
    const pp = projected.flush().payload;
    assert(Math.abs(pp.origins[0] - 1388609) < 1 && pp.stats.projected === true,
        'pre-projected Web-Mercator input is not projected twice');
    console.log('  ✓ GeoJSON, WKT, bare arrays and projected input all still load');
}

/* 2e. budget: a stream many times the allowance must settle, not grow */
{
    const TOTAL = 20000;
    const CHUNK = 4000;                       /* "source bytes per progress tick" */
    const CAP = 400;

    function stream(opts, tellTotal) {
        const collector = P.createCollector(Object.assign({ maxSegments: CAP, maxVertices: 40000,
            maxBytes: 1024 * 1024, maxBatchSegments: 200 }, opts));
        if (tellTotal) collector.setSourceTotal(TOTAL / 100 * CHUNK);
        for (let i = 0; i < TOTAL; i++) {
            collector.addRecord(road(8 + (i % 120) * 0.3, 38 + (i % 60) * 0.2, 8, 0.0015, 0.0012));
            if (i % 100 === 0) collector.noteSourceBytes(CHUNK);
            if (collector.shouldFlush()) collector.flush();
        }
        collector.flush();
        return collector.stats();
    }

    /* Without the stream size the collector falls back to feedback control —
     * still bounded, the safety net at 2 × the cap. */
    const blind = stream({}, false);
    assert(blind.sampled > 0, 'the budget dropped geometry instead of growing without bound');
    assert(blind.segments <= CAP * 2 + 200, 'the kept set is bounded without knowing the total (' + blind.segments + ')');
    assert(blind.stride > 1, 'the sampling rate is reported so the UI can say "sampled 1:N"');
    assert(blind.bytes < 4 * 1024 * 1024, 'the geometry the caller holds is bounded');

    /* With the byte total (what the worker and the page both hand over) the
     * kept set is a uniform ~1:N sample of the whole stream, so no region is
     * silently missing — and it lands on the configured cap. */
    const stats = stream({}, true);
    assert(stats.sampled > 0 && stats.segments <= CAP * 1.5,
        'knowing the stream size keeps the sample at the configured cap (' + stats.segments + ')');
    assert(stats.stride > 1, 'the estimate-driven stride is reported');
    /* long roads are the ones that still read at low zoom: they survive */
    const longCollector = P.createCollector({ maxSegments: 5, maxVertices: 200, maxBytes: 65536, maxBatchSegments: 50 });
    const payloads = [];
    for (let i = 0; i < 400; i++) {
        longCollector.addRecord(road(5 + (i % 20) * 0.1, 40 + (i % 10) * 0.1, 4, 0.0008, 0.0008));
        if (longCollector.shouldFlush()) {
            const framed = longCollector.flush();
            if (framed) payloads.push(framed.payload);
        }
    }
    longCollector.addRecord({ geometry: { type: 'LineString', coordinates: [[2, 40], [14, 47]] } });  /* ~1500 km */
    const tail = longCollector.flush();
    if (tail) payloads.push(tail.payload);
    let spans = 0;
    payloads.forEach(p => {
        for (let i = 0; i < p.n; i++) if (p.bounds[i * 4 + 2] - p.bounds[i * 4] > 1e6) spans++;
    });
    const longStats = longCollector.stats();
    assert(longStats.sampled > 400 * 0.8, 'the over-budget stream dropped the short roads (' + longStats.sampled + ' of 400)');
    assert(spans >= 1, 'the long through-road survived the budget');
    assert(longStats.segments <= 5 * 2 + 50, 'and the collector stayed bounded at ' + longStats.segments);
    console.log('  ✓ budget sampling bounded the stream at ' + stats.segments + ' segments (stride 1:' + stats.stride + ')');
}

/* ── 3. worker protocol ─────────────────────────────────────────────────── */
function workerSandbox(chunks, total, hooks) {
    const messages = [];
    const sandbox = {
        console: { warn() {}, log() {}, info() {} },
        Math, JSON, Promise, Date, Array, Object, Set, Map, String, Number, RegExp, Error,
        TextEncoder, TextDecoder, URL, Uint8Array, Uint32Array, Float32Array, Float64Array,
        setTimeout, clearTimeout, performance: { now: () => Date.now() }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.location = { href: 'https://example.test/js/roman-roads-worker.js?v=' + VERSION_TAG };
    sandbox.importScripts = function (url) {
        sandbox.__imported = (sandbox.__imported || []).concat(url);
        vm.runInContext(parserSrc, sandbox, { filename: 'imported:' + url });
    };
    sandbox.postMessage = function (msg) {
        messages.push(msg);
        if (hooks && hooks.onMessage) hooks.onMessage(msg, messages);
    };
    sandbox.addEventListener = function (type, fn) {
        if (type === 'message') sandbox.__onMessage = fn;
    };
    sandbox.fetch = function () {
        let i = 0;
        const reader = {
            read: () => Promise.resolve(i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined }),
            cancel: () => Promise.resolve()
        };
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: name => (name === 'content-length' ? String(total) : null) },
            body: { getReader: () => reader },
            text: () => Promise.resolve('')
        });
    };
    vm.createContext(sandbox);
    vm.runInContext(workerSrc, sandbox, { filename: 'roman-roads-worker.js' });
    return { sandbox, messages };
}

const segmentLine = (lng, lat) => JSON.stringify({ geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 0.01, lat + 0.01]] } }) + '\n';

function encodeText(text) {
    return new TextEncoder().encode(text);
}

(async function workerChecks() {
    /* A chunk boundary that splits a JSON line in half is the normal case. */
    const records = [];
    for (let i = 0; i < 3000; i++) records.push(segmentLine(3 + (i % 200) * 0.05, 40 + (i % 50) * 0.05));
    const text = records.join('');
    const bytes = encodeText(text);
    const chunks = [];
    for (let at = 0; at < bytes.length; at += 7 * 1024) chunks.push(bytes.slice(at, at + 7 * 1024));

    const h = workerSandbox(chunks, bytes.length);
    assert.strictEqual(h.sandbox.__imported.length, 1, 'the worker imports exactly one script');
    assert(h.sandbox.__imported[0].indexOf('roman-roads-parser.js') === 0, 'the worker imports the shared parser');
    assert(h.sandbox.__imported[0].indexOf('?' + 'v=' + VERSION_TAG) > 0, 'the parser is imported with the page version');

    h.sandbox.__onMessage({ data: { cmd: 'start', url: 'https://example.test/roads.ndjson', config: { maxBatchSegments: 500 } } });
    const deadline = Date.now() + 5000;
    let sawDone = false;
    while (Date.now() < deadline && !sawDone) {
        for (const m of h.messages) if (m.type === 'done') sawDone = true;
        if (!sawDone) {
            /* ack every batch, exactly like the page does */
            for (const m of h.messages) if (m.type === 'batch' && !m.__acked) { m.__acked = true; h.sandbox.__onMessage({ data: { cmd: 'ack' } }); }
            await new Promise(r => setTimeout(r, 1));
        }
    }
    assert(sawDone, 'the worker reported done');
    const batches = h.messages.filter(m => m.type === 'batch');
    const segs = batches.reduce((n, m) => n + m.payload.n, 0);
    assert(segs === 3000, 'the worker handed over every record exactly once (' + segs + ')');
    const done = h.messages.filter(m => m.type === 'done').pop();
    assert(done.stats.segments === 3000, 'the done stats agree with the batches');
    const first = batches[0].payload;
    assert(first.origins instanceof Float64Array || first.origins instanceof Float64Array.constructor,
        'the payload carries typed arrays');
    assert(typeof first.cellKeys.length === 'number' && typeof first.cellStart.length === 'number',
        'the payload carries the CSR grid index');
    const progress = h.messages.filter(m => m.type === 'progress');
    assert(progress.length >= 1, 'progress is reported while streaming');
    assert(progress[progress.length - 1].total === bytes.length, 'progress knows the total byte length');
    assert(progress[progress.length - 1].elapsed >= 0, 'progress reports elapsed time');
    console.log('  ✓ worker streamed ' + (bytes.length / 1024).toFixed(0) + ' KB in ' + chunks.length +
        ' chunks → ' + batches.length + ' batches, ' + segs.toLocaleString() + ' segments');

    /* Backpressure: the worker must not run ahead of the page without an ack. */
    const recs2 = [];
    for (let i = 0; i < 20000; i++) recs2.push(segmentLine(3 + (i % 300) * 0.04, 40 + (i % 60) * 0.04));
    const bytes2 = encodeText(recs2.join(''));
    const chunks2 = [];
    for (let at = 0; at < bytes2.length; at += 32 * 1024) chunks2.push(bytes2.slice(at, at + 32 * 1024));
    const h2 = workerSandbox(chunks2, bytes2.length);
    h2.sandbox.__onMessage({ data: { cmd: 'start', url: 'https://example.test/roads.ndjson', config: { maxBatchSegments: 200 } } });
    for (let i = 0; i < 40; i++) await new Promise(r => setTimeout(r, 1));      /* no acks at all */
    const inflight = h2.messages.filter(m => m.type === 'batch').length;
    assert(inflight <= 4, 'without acks the worker keeps at most 4 batches in flight (got ' + inflight + ')');
    assert(!h2.messages.some(m => m.type === 'done'), 'and it cannot finish while the page is behind');
    for (let i = 0; i < 6; i++) h2.sandbox.__onMessage({ data: { cmd: 'ack' } });
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 1));
        for (const m of h2.messages) if (m.type === 'batch' && !m.__acked) { m.__acked = true; h2.sandbox.__onMessage({ data: { cmd: 'ack' } }); }
        if (h2.messages.some(m => m.type === 'done')) break;
    }
    assert(h2.messages.some(m => m.type === 'done'), 'the stream finishes once the page catches up');
    console.log('  ✓ backpressure holds the worker at 4 un-consumed batches');

    /* Cancel must stop the ingest. */
    const h3 = workerSandbox(chunks, bytes.length);
    h3.sandbox.__onMessage({ data: { cmd: 'start', url: 'https://example.test/roads.ndjson', config: {} } });
    h3.sandbox.__onMessage({ data: { cmd: 'cancel' } });
    for (let i = 0; i < 30; i++) await new Promise(r => setTimeout(r, 1));
    assert(!h3.messages.some(m => m.type === 'done'), 'a cancelled stream reports no done');
    console.log('  ✓ cancel stops the stream');

    /* ── 4. the canvas maths ───────────────────────────────────────────────── */
    const mathChecks = layerSandbox();
    assert(Math.abs(mathChecks.expectedX - mathChecks.drawn.moveTo[0]) < 1e-9 &&
        Math.abs(mathChecks.expectedY - mathChecks.drawn.moveTo[1]) < 1e-9,
        'the first vertex maps to the pixel Leaflet uses');
    assert(mathChecks.drawn.lineTo.length >= 1, 'the tile gets a polyline, not a dot, at high zoom');
    assert(mathChecks.dotDrawn.fillRect.length === 4 && mathChecks.dotDrawn.moveTo.length === 0,
        'a sub-pixel segment at low zoom is a dot');
    assert(mathChecks.versionAfterOpacity === mathChecks.versionBefore,
        'changing opacity does not invalidate painted tiles (the slider stays instant)');
    assert(mathChecks.versionAfterColor > mathChecks.versionBefore,
        'changing colour does invalidate them');
    assert(mathChecks.paintedTileMoveTo.length >= 2, 'a tile painted through the grid index gets the road');
    assert(mathChecks.layer.getStats().segments === 1 && mathChecks.layer.getStats().pages === 1,
        'the layer reports what it holds');
    assert(layerSrc.includes('_dl3dFeatures: function'),
        'the 3D mirror contract exists on the layer');
    assert(archeo.includes('window._romanRoadsLayer') && archeo.includes('roadSegmentsInBounds'),
        'the analysis panel measures in the live layer when it is loaded');
    assert(archeo.includes('loadRomanRoadsGeojson'), 'and still falls back to the reference GeoJSON');
    console.log('  ✓ canvas maths, dot mode and the opacity fast path');

    console.log('✅ test-roman-roads-pipeline.js passed all checks successfully.');
})().catch(err => {
    console.error('❌ test-roman-roads-pipeline.js failed:');
    console.error(err && err.stack || err);
    process.exit(1);
});

/* ── the layer without a browser ───────────────────────────────────────────
 * A minimal L.GridLayer + a recording 2D context is enough to exercise the
 * whole painting path of js/roman-roads.js — including the per-batch grid
 * index, which is where an off-by-one silently blanks every tile. */
function layerSandbox() {
    const drawn = { moveTo: [], lineTo: [], fillRect: [], strokes: 0 };
    const dotDrawn = { moveTo: [], lineTo: [], fillRect: [] };
    const tileDrawn = { moveTo: [], lineTo: [], fillRect: [], strokes: 0 };
    let recorder = drawn;

    function fakeCtx() {
        return {
            setTransform() {}, clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {},
            clip() {}, stroke() { recorder.strokes = (recorder.strokes || 0) + 1; }, fill() {},
            moveTo(x, y) { recorder.moveTo.push(x, y); },
            lineTo(x, y) { recorder.lineTo.push(x, y); },
            fillRect(x, y, w, h) { recorder.fillRect.push(x, y, w, h); },
            strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', globalAlpha: 1
        };
    }

    const sandbox = {
        console: { warn() {}, log() {}, info() {} },
        Math, JSON, isFinite, isNaN, Date, Array, Object, Promise, setTimeout, clearTimeout,
        Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array, TextDecoder,
        devicePixelRatio: 1,
        requestAnimationFrame: fn => setTimeout(fn, 0),
        performance: { now: () => Date.now() }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.navigator = { userAgent: 'node' };
    sandbox.document = {
        createElement: function () {
            return { style: {}, width: 0, height: 0, className: '', getContext: () => fakeCtx() };
        },
        querySelectorAll: () => []
    };
    vm.createContext(sandbox);
    vm.runInContext(parserSrc, sandbox, { filename: 'roman-roads-parser.js' });

    /* the smallest GridLayer the painting path touches */
    function GridLayer() {}
    GridLayer.prototype.options = { tileSize: 256 };
    GridLayer.prototype.onAdd = function () {};
    GridLayer.prototype.onRemove = function () {};
    GridLayer.prototype.getTileSize = function () { return { x: this.options.tileSize, y: this.options.tileSize }; };
    GridLayer.prototype._updateOpacity = function () {};
    GridLayer.prototype._tileCoordsToKey = c => c.x + ':' + c.y + ':' + c.z;
    GridLayer.extend = function (props) {
        function Cls(options) {
            this.options = Object.assign({}, Cls.prototype.options);
            if (this.initialize) this.initialize(options);
        }
        Cls.prototype = Object.create(GridLayer.prototype);
        Cls.prototype.constructor = Cls;
        Cls.prototype.options = Object.assign({}, GridLayer.prototype.options, props.options);
        Object.assign(Cls.prototype, props);
        return Cls;
    };
    sandbox.L = {
        GridLayer,
        Layer: function () {},
        Util: { setOptions: (o, opts) => Object.assign(o.options, opts) }
    };
    vm.runInContext(layerSrc, sandbox, { filename: 'roman-roads.js' });

    const P2 = sandbox.DetectLabRomanRoadsParser;
    const layer = sandbox.DetectLabRomanRoads.createLayer({ color: '#FF5A36', weight: 2 });
    assert(layer && layer.addBatch && layer.createTile, 'createLayer builds a canvas layer');
    assert(sandbox.DetectLabRomanRoads.configForDevice().maxSegments > 0, 'the device budget is exposed');

    const collector = P2.createCollector({});
    const lng = 12.5, lat = 41.9;
    collector.addRecord({ geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 0.02, lat + 0.02]] } });
    const framed = collector.flush();
    layer.addBatch(framed.payload);
    assert(layer.getStats().segments === 1, 'the batch landed in the layer');

    /* direct segment draw: the tile-local transform has to match Leaflet's */
    const zoom = 12, size = 256, scale = 256 * Math.pow(2, zoom), k = P2.PX_A * scale;
    const tileX = Math.floor((P2.mercX(lng) * k + 0.5 * scale) / size);
    const tileY = Math.floor((0.5 * scale - P2.mercY(lat) * k) / size);
    const gx0 = tileX * size, gy0 = tileY * size;
    recorder = drawn;
    layer._drawSegment(fakeCtx(), framed.payload, 0, k, 0.5 * scale - gx0, 0.5 * scale - gy0, 0.45, false, layer.options);
    const expectedX = P2.mercX(lng) * k + (0.5 * scale - gx0);
    const expectedY = -P2.mercY(lat) * k + (0.5 * scale - gy0);
    assert(Math.abs(drawn.moveTo[0] - expectedX) < 1e-9 && Math.abs(drawn.moveTo[1] - expectedY) < 1e-9,
        'the first vertex maps to the pixel Leaflet uses');
    assert(drawn.lineTo.length >= 2, 'the segment is a polyline, not a dot, at z' + zoom);

    /* the same road through createTile + the grid index */
    const el = layer.createTile({ x: tileX, y: tileY, z: zoom });
    assert(el && el._dlRomanEntry, 'createTile hands back a canvas queued for painting');
    recorder = tileDrawn;
    layer._paintEntry(el._dlRomanEntry);
    assert(tileDrawn.moveTo.length >= 2 && tileDrawn.strokes === 1,
        'one stroke paints every road of the tile');
    assert(Math.abs(tileDrawn.moveTo[0] - expectedX) < 1e-9 && Math.abs(tileDrawn.moveTo[1] - expectedY) < 1e-9,
        'the grid lookup leads to the same vertex the direct call produced');

    /* a tile nowhere near the data must stay empty */
    recorder = { moveTo: [], lineTo: [], fillRect: [], strokes: 0 };
    const far = layer.createTile({ x: tileX + 40, y: tileY + 40, z: zoom });
    layer._paintEntry(far._dlRomanEntry);
    assert(recorder.moveTo.length === 0 && recorder.fillRect.length === 0,
        'a tile that does not touch the geometry paints nothing');

    /* dot mode: a 150 m road is sub-pixel at z5 */
    const c2 = P2.createCollector({});
    c2.addRecord({ geometry: { type: 'LineString', coordinates: [[12.4995, 41.8995], [12.5005, 41.9005]] } });
    const small = c2.flush().payload;
    const scale5 = 256 * Math.pow(2, 5), k5 = P2.PX_A * scale5;
    recorder = dotDrawn;
    layer._drawSegment(fakeCtx(), small, 0, k5, 0, 0, 0.45, true, layer.options);
    assert(dotDrawn.fillRect.length === 4 && dotDrawn.moveTo.length === 0,
        'a sub-pixel segment at low zoom is a dot (fillRect args ' + dotDrawn.fillRect.length +
        ', moveTo ' + dotDrawn.moveTo.length + ')');

    /* opacity must not invalidate painted tiles, colour must */
    const versionBefore = layer._version;
    layer.setOpacity(0.4);
    const versionAfterOpacity = layer._version;
    layer.setColor('#00FF00');
    const versionAfterColor = layer._version;

    return { layer, drawn, dotDrawn, paintedTileMoveTo: tileDrawn.moveTo,
        expectedX, expectedY, versionBefore, versionAfterOpacity, versionAfterColor };
}
