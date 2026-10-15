/* ============================================================================
 * bench-roman-roads.js — Roman-roads ingest + paint, old pipeline vs new one
 * ----------------------------------------------------------------------------
 * NOT part of the test suite and NOT loaded by the app. It generates a
 * synthetic route-segment NDJSON with the record shapes the real export uses,
 * then runs both pipelines over the same bytes and prints what each one costs.
 *
 *   LEGACY  (what js/roman-roads.js replaced, kept here as a reference)
 *           JSON.parse + a [lat, lng] object array + L.polyline per segment on
 *           the main thread, i.e. one SVG <path> in the DOM per road segment.
 *   NOW     js/roman-roads-parser.js (worker) + js/roman-roads.js (canvas tiles)
 *
 * Usage:
 *     node bench-roman-roads.js [segments] [verticesPerSegment]
 *     npm i jsdom && node bench-roman-roads.js          # adds the real-Leaflet run
 *
 * Reference result (2026-10-15, node 22, synthetic 20 000 segments × 12 vtx):
 *     legacy   parse+build  ~380 ms main thread, 20 000 live path objects,
 *              20 000 SVG <path> nodes created by the real Leaflet renderer
 *     now      parse+pack   ~300 ms in the worker, 1.0 MB of typed arrays,
 *              0 DOM nodes per segment, ~0.2 ms per painted tile
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const SEGMENTS = Number(process.argv[2] || 20000);
const PER_SEG = Number(process.argv[3] || 12);
const ROOT = __dirname;
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (e) { JSDOM = null; }

/* ── 1. the synthetic stream ─────────────────────────────────────────────── */
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rnd = mulberry32(20261015);
const R = 6378137;
const mercX = lng => R * lng * Math.PI / 180;
const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));

function generate() {
    const lines = [];
    let vertices = 0;
    for (let i = 0; i < SEGMENTS; i++) {
        const lat = 30 + rnd() * 22, lng = -8 + rnd() * 46;
        const dLat = (12 + rnd() * 30) / 111320, dLng = dLat * 1.4;
        const coords = [];
        let la = lat, lo = lng;
        for (let v = 0; v < PER_SEG; v++) {
            la += dLat * (rnd() - 0.45);
            lo += dLng * (rnd() - 0.45);
            coords.push([+lo.toFixed(7), +la.toFixed(7)]);
        }
        vertices += coords.length;
        const shape = i % 10;
        if (shape < 6) lines.push(JSON.stringify({ id: i, geometry: { type: 'LineString', coordinates: coords } }));
        else if (shape < 8) lines.push(JSON.stringify({ id: i, properties: { name: 'via ' + i }, geometry: { type: 'LineString', coordinates: coords } }));
        else if (shape === 8) lines.push(JSON.stringify({ id: i, paths: [[coords.map(c => c[0]), coords.map(c => c[1])]] }));
        else lines.push(JSON.stringify({ id: i, wkt: 'LINESTRING (' + coords.map(c => c[0] + ' ' + c[1]).join(', ') + ')' }));
    }
    return { text: lines.join('\n') + '\n', segments: SEGMENTS, vertices };
}

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }
function heapMB() { return process.memoryUsage().heapUsed / 1048576; }

/* ── 2. LEGACY: parse every line and keep one path object per segment ────── */
function legacyRun(text) {
    const t0 = process.hrtime.bigint();
    const heap0 = heapMB();
    const lines = text.split('\n');
    const kept = [];
    let vertices = 0;
    for (let i = 0; i < lines.length; i++) {
        let o;
        try { o = JSON.parse(lines[i]); } catch (e) { continue; }
        let coords = null;
        if (o.geometry && o.geometry.coordinates) coords = o.geometry.coordinates;
        else if (o.wkt) {
            const m = /\(([^()]+)\)/.exec(o.wkt);
            coords = m ? m[1].split(',').map(s => s.trim().split(/\s+/).map(Number)) : null;
        } else if (o.paths) {
            const px = o.paths[0][0], py = o.paths[0][1];
            coords = px.map((x, k) => [x, py[k]]);
        }
        if (!coords || coords.length < 2) continue;
        /* what Leaflet keeps alive for one polyline: one LatLng per vertex */
        const latlngs = coords.map(c => ({ lat: c[1], lng: c[0] }));
        kept.push(latlngs);
        vertices += latlngs.length;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, segments: kept.length, vertices, heapMB: heapMB() - heap0, kept };
}

/* ── 3. NOW: the real parser, batched exactly like the worker does ───────── */
function parserRun(text, batch) {
    const sandbox = nodeSandbox();
    const P = sandbox.DetectLabRomanRoadsParser;
    const collector = P.createCollector({ maxBatchSegments: batch });
    const lines = text.split('\n').filter(Boolean);
    const t0 = process.hrtime.bigint();
    const heap0 = heapMB();
    const payloads = [];
    let transferred = 0;
    for (const line of lines) {
        let rec;
        try { rec = JSON.parse(line); } catch (e) { continue; }
        collector.addRecord(rec);
        if (collector.shouldFlush()) {
            const framed = collector.flush();
            if (framed) { payloads.push(framed.payload); transferred += transferSize(framed); }
        }
    }
    const framed = collector.flush();
    if (framed) { payloads.push(framed.payload); transferred += transferSize(framed); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, payloads, transferred, heapMB: heapMB() - heap0, stats: collector.stats(), sandbox };
}

function transferSize(framed) {
    const p = framed.payload;
    return p.origins.byteLength + p.deltas.byteLength + p.starts.byteLength + p.bounds.byteLength +
        p.cellKeys.byteLength + p.cellStart.byteLength + p.cellItems.byteLength + p.spanItems.byteLength;
}

function nodeSandbox() {
    const vm = require('vm');
    const sandbox = {
        console: { warn() {}, log() {} }, Math, JSON, isFinite, isNaN, Date, Array, Object, Promise,
        setTimeout, clearTimeout, Uint8Array, Uint16Array, Uint32Array, Float32Array, Float64Array,
        TextDecoder, performance: { now: () => Date.now() }
    };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.navigator = { userAgent: 'node' };
    sandbox.devicePixelRatio = 1;
    sandbox.requestAnimationFrame = fn => setTimeout(fn, 0);
    sandbox.document = {
        createElement: () => ({ style: {}, width: 0, height: 0, getContext: () => countingCtx() }),
        querySelectorAll: () => []
    };
    vm.createContext(sandbox);
    vm.runInContext(read('js/roman-roads-parser.js'), sandbox, { filename: 'roman-roads-parser.js' });
    vm.runInContext(read('js/roman-roads.js'), sandbox, { filename: 'roman-roads.js' });
    return sandbox;
}

function countingCtx(stats) {
    const s = stats || { moveTo: 0, lineTo: 0, fillRect: 0, strokes: 0 };
    const noop = () => {};
    return {
        stats: s, setTransform: noop, clearRect: noop, save: noop, restore: noop, beginPath: noop,
        rect: noop, clip: noop, fill: noop,
        stroke() { s.strokes++; },
        moveTo() { s.moveTo++; }, lineTo() { s.lineTo++; }, fillRect() { s.fillRect++; },
        strokeStyle: '', fillStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', globalAlpha: 1
    };
}

/* ── 4. the canvas layer, painted for real (through its own paint queue) ── */
function layerRun(sandbox, payloads, center, zoom, tilesPerSide) {
    const L = fakeLeaflet(sandbox);
    const layer = sandbox.DetectLabRomanRoads.createLayer({});
    for (const p of payloads) layer.addBatch(p);
    const P = sandbox.DetectLabRomanRoadsParser;
    const size = 256, scale = 256 * Math.pow(2, zoom), k = P.PX_A * scale;
    const cx = Math.floor((P.mercX(center[1]) * k + 0.5 * scale) / size);
    const cy = Math.floor((0.5 * scale - P.mercY(center[0]) * k) / size);
    const tiles = tilesPerSide;
    const half = Math.floor(tiles / 2);
    const stats = { moveTo: 0, lineTo: 0, fillRect: 0, strokes: 0 };
    const t0 = process.hrtime.bigint();
    let painted = 0;
    for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
            const el = { style: {}, width: 0, height: 0, getContext: () => countingCtx(stats) };
            const entry = { key: 'k', coords: { x: cx + dx, y: cy + dy, z: zoom }, el, ctx: el.getContext('2d'), dpr: 1, version: -1 };
            layer._paintEntry(entry);
            painted++;
        }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, perTileMs: ms / painted, tiles: painted, stats, layerStats: layer.getStats() };
}

function fakeLeaflet(sandbox) {
    function GridLayer() {}
    GridLayer.prototype.options = { tileSize: 256 };
    GridLayer.prototype.onAdd = function () {};
    GridLayer.prototype.onRemove = function () {};
    GridLayer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
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
    sandbox.L = { GridLayer, Layer: function () {}, Util: { setOptions: (o, opts) => Object.assign(o.options, opts) } };
    return sandbox.L;
}

/* ── 5. real Leaflet (jsdom): what the old SVG renderer did to the DOM ──── */
async function jsdomRun(text) {
    if (!JSDOM) return null;
    const dom = new JSDOM('<!doctype html><html><body><div id="map"></div></body></html>',
        { pretendToBeVisual: true, runScripts: 'outside-only' });
    const { window } = dom;
    const size = { w: 900, h: 620 };
    window.HTMLCanvasElement.prototype.getContext = function () {
        return this.__ctx || (this.__ctx = countingCtx());
    };
    Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get() { return size.w; } });
    Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get() { return size.h; } });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, left: 0, top: 0, right: size.w, bottom: size.h, width: size.w, height: size.h };
    };
    window.devicePixelRatio = 1;
    window.eval(read('js/leaflet.js'));
    window.eval(read('js/roman-roads-parser.js'));
    window.eval(read('js/roman-roads.js'));
    const L = window.L;
    const map = L.map('map', {
        center: [41.9, 12.5], zoom: 6, preferCanvas: false, zoomAnimation: false, fadeAnimation: false,
        markerZoomAnimation: false, inertia: false, zoomControl: false, attributionControl: false
    });
    map.createPane('pane_roman');

    /* LEGACY: one L.polyline per record, on the SVG renderer (the default). */
    const layerGroup = L.layerGroup([], { pane: 'pane_roman' }).addTo(map);
    const t0 = Date.now();
    let n = 0;
    for (const line of text.split('\n')) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        let coords = null;
        if (o.geometry && o.geometry.coordinates) coords = o.geometry.coordinates;
        else if (o.properties && o.geometry) coords = o.geometry.coordinates;
        else if (o.paths) { const px = o.paths[0][0], py = o.paths[0][1]; coords = px.map((x, k) => [x, py[k]]); }
        else if (o.wkt) {
            const m = /\(([^()]+)\)/.exec(o.wkt);
            coords = m ? m[1].split(',').map(s => s.trim().split(/\s+/).map(Number)) : null;
        }
        if (!coords) continue;
        layerGroup.addLayer(L.polyline(coords.map(c => [c[1], c[0]]), { color: '#FF5A36', weight: 1.8 }));
        n++;
    }
    const legacyMs = Date.now() - t0;
    const paths = window.document.querySelectorAll('svg path').length;
    const svgNodes = window.document.querySelectorAll('svg *').length;

    /* NOW: the canvas layer. */
    const roads = window.DetectLabRomanRoads.createLayer({ pane: 'pane_roman' }).addTo(map);
    const collector = window.DetectLabRomanRoadsParser.createCollector({});
    const t1 = Date.now();
    for (const line of text.split('\n')) {
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        collector.addRecord(o);
        if (collector.shouldFlush()) {
            const framed = collector.flush();
            if (framed) roads.addBatch(framed.payload);
        }
    }
    const framed = collector.flush();
    if (framed) roads.addBatch(framed.payload);
    const ingestMs = Date.now() - t1;
    roads._update();
    roads._drainPaintQueue();
    const canvases = window.document.querySelectorAll('canvas.dl-roman-roads-tile, canvas.leaflet-tile').length;
    const stats = roads.getStats();
    return {
        legacy: { ms: legacyMs, polylines: n, svgPaths: paths, svgNodes },
        now: { ms: ingestMs, tiles: Object.keys(roads._tiles || {}).length, canvases, stats,
            lastPaintMs: stats.lastPaintMs, mappedNodes: window.document.querySelectorAll('canvas').length }
    };
}

/* ── 6. run ─────────────────────────────────────────────────────────────── */
(async function main() {
    const gen = generate();
    console.log('Roman-roads benchmark — ' + gen.segments.toLocaleString() + ' segments, ' +
        gen.vertices.toLocaleString() + ' source vertices, ' + mb(gen.text.length) + ' NDJSON\n');

    const legacy = legacyRun(gen.text);
    console.log('LEGACY (per-segment L.polyline on the main thread)');
    console.log('  parse + build      : ' + legacy.ms.toFixed(0) + ' ms of blocked main thread');
    console.log('  live objects       : ' + legacy.segments.toLocaleString() + ' path arrays, ' +
        legacy.vertices.toLocaleString() + ' LatLng objects');
    console.log('  heap delta         : ' + Math.max(0, legacy.heapMB).toFixed(1) + ' MB (GC-dependent)');
    console.log('  DOM (browser)      : ' + legacy.segments.toLocaleString() + ' SVG <path> elements');

    const now = parserRun(gen.text, 6000);
    console.log('\nNOW (js/roman-roads-parser.js, off the main thread in the worker)');
    console.log('  parse + pack       : ' + now.ms.toFixed(0) + ' ms (in the worker, not on the page)');
    console.log('  transferred        : ' + mb(now.transferred) + ' in ' + now.payloads.length + ' transferable batches');
    console.log('  kept               : ' + now.stats.segments.toLocaleString() + ' segments, ' +
        now.stats.vertices.toLocaleString() + ' vertices');
    console.log('  heap delta         : ' + Math.max(0, now.heapMB).toFixed(1) + ' MB (GC-dependent)');
    console.log('  DOM (browser)      : one canvas per visible tile, none per segment');

    console.log('\nTILE PAINT (real layer code, one screen of tiles around the data)');
    for (const zoom of [3, 6, 9, 12, 15]) {
        const run = layerRun(now.sandbox, now.payloads, [41.9, 12.5], zoom, 3);
        console.log('  z' + String(zoom).padEnd(3) + ': ' + run.perTileMs.toFixed(2) + ' ms/tile · ' +
            String(Math.round((run.stats.moveTo + run.stats.fillRect) / run.tiles)).padStart(6) + ' segments drawn/tile · ' +
            (run.stats.strokes / run.tiles).toFixed(1) + ' stroke(s) per tile');
    }

    const dom = await jsdomRun(gen.text);
    if (!dom) {
        console.log('\n(install jsdom to also run the real-Leaflet DOM comparison: npm i jsdom)');
        return;
    }
    console.log('\nREAL LEAFLET in jsdom — the same data through both pipelines');
    console.log('  legacy SVG renderer: ' + dom.legacy.ms + ' ms to add ' + dom.legacy.polylines.toLocaleString() +
        ' polylines → ' + dom.legacy.svgPaths.toLocaleString() + ' <path> + ' +
        dom.legacy.svgNodes.toLocaleString() + ' SVG nodes in the document');
    console.log('  canvas layer       : ' + dom.now.ms + ' ms to ingest into ' + dom.now.stats.segments.toLocaleString() +
        ' segments → ' + dom.now.tiles + ' tiles, ' + dom.now.canvases + ' canvas elements, ' +
        dom.now.mappedNodes + ' DOM nodes total');
    console.log('  last tile paint    : ' + dom.now.lastPaintMs + ' ms');
})();
