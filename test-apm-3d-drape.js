// Next-Gen APM in the 3D view — the FINISHED heatmap and the very-high polygons
// must be visible and draped ("moulded") over the 3D base map / terrain.
//
// What is protected here:
//   1. the result heatmap reaches 3D as ONE georeferenced picture (the same
//      Web-Mercator texture the 2D tiles are drawn from), classified as
//      'image' — not as a canvas raster the 3D view would repaint tile by tile
//      (a 1024² texture rebuilt per 3D tile on the main thread);
//   2. that picture is placed on the Mercator rectangle the texture really
//      covers, so it lines up with 2D at any latitude and is draped on the
//      terrain instead of being stretched north/south;
//   3. its pixels (colours + per-cell transparency) are the 2D pixels, encoded
//      ONCE per result (the 1.5 s 3D sync poll must not re-encode it);
//   4. the result opacity slider reaches 3D for both the heatmap and the
//      outlines;
//   5. the very-high polygons keep their line-only look in 3D (the mirror used
//      to fall back to Leaflet's blue 20 % fill, which hid the heat underneath);
//   6. switching the result off (Clear / APM off / re-run) removes both from 3D;
//   7. without a canvas the layer still mirrors through its tile renderer —
//      no result may silently disappear from 3D.
//
// Usage: node test-apm-3d-drape.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

/* The panes js/apm-next/apm-ui.js creates for a result: the mirror reads their
 * z-index, which is how 2D pane order becomes 3D deck order. */
const RESULT_PANES = { apmHeat: 410, apmHotspots: 420 };
const fakePanes = {
    getPane: function (name) {
        return RESULT_PANES[name] ? { style: { zIndex: String(RESULT_PANES[name]) } } : null;
    }
};
let passed = 0;
function ok(condition, message) {
    assert.ok(condition, message);
    passed += 1;
    console.log('  ok  ' + message);
}
function equal(actual, expected, message) {
    assert.strictEqual(actual, expected, message);
    passed += 1;
    console.log('  ok  ' + message);
}
function near(actual, expected, tolerance, message) {
    assert.ok(Math.abs(actual - expected) <= tolerance,
        message + ' (got ' + actual + ', expected ' + expected + ' ±' + tolerance + ')');
    passed += 1;
    console.log('  ok  ' + message);
}

console.log('[Test] Next-Gen APM results in the 3D view — heat + polygons draped on the base map...');

/* ── the smallest browser the two modules need ─────────────────────────────── */

/* A 2D canvas that records what was drawn and hands back a deterministic data
 * URL. Node has no canvas, so "the PNG contains the heat pixels" is proven by
 * the ImageData the encoder was given. */
function makeDocument(state) {
    return {
        createElement: function (tag) {
            const canvas = { tagName: String(tag).toUpperCase(), width: 0, height: 0 };
            canvas.getContext = function () {
                return {
                    createImageData: function (w, h) {
                        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
                    },
                    putImageData: function (frame) {
                        state.frames.push({ width: canvas.width, height: canvas.height,
                            data: new Uint8ClampedArray(frame.data) });
                    },
                    drawImage: function () {},
                    setTransform: function () {}
                };
            };
            canvas.toDataURL = function (type) {
                state.encoded += 1;
                const frame = state.frames[state.frames.length - 1];
                return 'data:' + (type || 'image/png') + ';base64,APM' +
                    (frame ? frame.width + 'x' + frame.height : 'empty') + '#' + state.encoded;
            };
            state.canvases.push(canvas);
            return canvas;
        }
    };
}

function makeLeaflet() {
    function Base(options) { this.options = options || {}; }
    Base.prototype.getOpacity = function () {
        return this.options.opacity == null ? 1 : this.options.opacity;
    };
    Base.prototype.getTileSize = function () { return { x: 256, y: 256 }; };

    function GridLayer(options) { Base.call(this, options); }
    GridLayer.prototype = Object.create(Base.prototype);
    GridLayer.extend = function (proto) {
        function Sub(options) {
            Base.call(this, options);
            Object.keys(proto).forEach(function (key) { this[key] = proto[key]; }, this);
        }
        Sub.prototype = Object.create(GridLayer.prototype);
        Object.keys(proto).forEach(function (key) { Sub.prototype[key] = proto[key]; });
        return Sub;
    };

    function LayerGroup(layers) {
        Base.call(this, {});
        this._layers = (layers || []).slice();
    }
    LayerGroup.prototype = Object.create(Base.prototype);
    LayerGroup.prototype.addLayer = function (layer) { this._layers.push(layer); return this; };
    LayerGroup.prototype.removeLayer = function (layer) {
        this._layers = this._layers.filter(function (l) { return l !== layer; });
        return this;
    };
    LayerGroup.prototype.getLayers = function () { return this._layers.slice(); };
    LayerGroup.prototype.eachLayer = function (fn) { this._layers.forEach(fn); };

    function GeoJSON(data, options) { Base.call(this, options); this._data = data; }
    GeoJSON.prototype = Object.create(Base.prototype);
    GeoJSON.prototype.toGeoJSON = function () { return this._data; };

    function TileLayer(url, options) { Base.call(this, options); this._url = url; }
    TileLayer.prototype = Object.create(Base.prototype);
    TileLayer.prototype.getTileUrl = function (coords) {
        return this._url + '/' + coords.z + '/' + coords.x + '/' + coords.y;
    };

    return {
        GridLayer: GridLayer,
        LayerGroup: LayerGroup,
        GeoJSON: GeoJSON,
        TileLayer: TileLayer,
        ImageOverlay: function () {},
        SVGOverlay: null,
        VideoOverlay: null,
        Path: function () {},
        Marker: function () {},
        Renderer: function () {},
        DomUtil: { create: function (tag) { return { tagName: String(tag).toUpperCase() }; } },
        latLngBounds: function (sw, ne) {
            return {
                _sw: sw, _ne: ne, isValid: function () { return true; },
                getWest: function () { return sw[1]; }, getSouth: function () { return sw[0]; },
                getEast: function () { return ne[1]; }, getNorth: function () { return ne[0]; }
            };
        },
        point: function (x, y) { return { x: x, y: y }; }
    };
}

function sandbox(docState, withCanvas) {
    const Leaflet = makeLeaflet();
    const ctx = { console: console };
    ctx.window = ctx;
    ctx.self = ctx;
    ctx.L = Leaflet;
    ctx.document = withCanvas === false ? {} : makeDocument(docState);
    vm.createContext(ctx);
    vm.runInContext(read('js/map3d-mirror.js'), ctx, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(read('js/apm-next/apm-heatmap.js'), ctx, { filename: 'js/apm-next/apm-heatmap.js' });
    return { ctx: ctx, L: Leaflet, mirror: ctx.DetectLabMirror, heat: ctx.DetectLabApmHeatmap };
}

/* A TRAIN-sized result: 50 km window, 1024 × 1024 analysis cells. */
function result(lib) {
    const w = 1024, h = 1024, lon0 = 23.59, lat0 = 46.77;
    const grid = { w: w, h: h, west: lon0 - 0.65, north: lat0 + 0.45, dLon: 1.3 / w, dLat: 0.9 / h };
    const score = new Float32Array(w * h), mask = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        score[k] = 0.5 + 0.45 * Math.sin(i / 37) * Math.cos(j / 23);
        if (i % 211 < 9 && j % 173 < 9) mask[k] = 1;            /* built-up: transparent */
        if (Math.hypot(i - 700, j - 300) < 8) { mask[k] = 2; score[k] = 0.95; }
    }
    const thresholds = { medium: 0.55, high: 0.7, veryhigh: 0.85 };
    const raster = lib.buildRaster(score, grid, thresholds, 512, mask);
    return { thresholds: thresholds, raster: raster,
        payload: lib.displayPayload(raster, lib.buildMercatorTexture(raster)) };
}

/* The very-high outlines exactly as js/apm-next/apm-ui.js builds them. */
const HOTSPOT_GEOJSON = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', properties: { class: 'veryhigh', areaM2: 1250000 }, geometry: {
            type: 'Polygon', coordinates: [[[23.4, 46.6], [23.5, 46.6], [23.5, 46.7], [23.4, 46.7], [23.4, 46.6]]]
        } }
    ]
};
function outlineOptions(uiSource) {
    /* Read the options out of the panel instead of copying them here: the test
     * fails if the layers the viewer reads ever drift from what 2D draws. */
    const match = /root\.L\.geoJSON\(res\.geojson,\s*\{([\s\S]*?)\n\s*interactive/.exec(uiSource);
    assert.ok(match, 'apm-ui.js still builds the hotspot outlines through L.geoJSON');
    const color = /color:\s*'(#[0-9a-fA-F]{3,6})'/.exec(match[1]);
    const weight = /weight:\s*(\d+)/.exec(match[1]);
    const opacity = /opacity:\s*([\d.]+)/.exec(match[1]);
    return {
        pane: 'apmHotspots',
        color: color ? color[1] : null,
        weight: weight ? Number(weight[1]) : null,
        opacity: opacity ? Number(opacity[1]) : null,
        fill: /fill:\s*false/.test(match[1]) ? false : undefined,
        filter: function (f) { return f.properties.class === 'veryhigh'; },
        interactive: true,
        style: function () { return { color: '#d9f5ff', weight: 2, fill: false, opacity: 0.95 }; }
    };
}

/* ── 1. the heat layer is draped as one georeferenced picture ─────────────── */
{
    const state = { frames: [], canvases: [], encoded: 0 };
    const box = sandbox(state, true);
    const lib = box.heat, mirror = box.mirror;
    const res = result(lib);
    const layer = lib.createLayer(res.payload, box.L, { pane: 'apmHeat' });
    layer._leaflet_id = 'apmHeatLayer';

    equal(mirror.classify(layer, box.L), 'image',
        'the result heatmap mirrors as an IMAGE (draped), not as repainted canvas tiles');

    const descriptor = mirror.describe(layer, fakePanes);
    ok(!!descriptor, 'the mirror describes the heat layer at all');
    equal(descriptor.kind, 'image', 'the descriptor kind is image');
    ok(/^data:image\/png;base64,/.test(descriptor.url), 'the picture is a PNG data URL');
    ok(!descriptor.template, 'no dl2d:// tile template is left for the 3D view to repaint');
    equal(descriptor.z, 410, 'the heat keeps its 2D pane order (above the basemap, below the outlines)');
    equal(descriptor.opacity, 1, 'the default result opacity is opaque');
    equal(state.encoded, 1, 'the PNG was encoded exactly once');

    const texture = res.payload.texture;
    const coordinates = descriptor.coordinates;
    equal(coordinates.length, 4, 'the image is placed by four corners');
    near(coordinates[0][0], texture.west, 1e-9, 'NW corner longitude is the texture west edge');
    near(coordinates[1][0], texture.east, 1e-9, 'NE corner longitude is the texture east edge');
    near(coordinates[2][0], texture.east, 1e-9, 'SE corner longitude is the texture east edge');
    near(coordinates[3][0], texture.west, 1e-9, 'SW corner longitude is the texture west edge');
    near(coordinates[0][1], lib.latFromMercatorY(texture.y0), 1e-9, 'north edge is the texture top row in Mercator');
    near(coordinates[2][1], lib.latFromMercatorY(texture.y1), 1e-9, 'south edge is the texture bottom row in Mercator');
    ok(coordinates[0][1] > coordinates[2][1], 'north edge is north of the south edge');

    /* The picture must not be a stretched lon/lat sheet: the texture rows are
     * evenly spaced in Mercator, so image aspect and Mercator aspect agree. */
    const spanX = texture.x1 - texture.x0, spanY = texture.y1 - texture.y0;
    near(texture.w / texture.h, spanX / spanY, 0.02,
        'the picture keeps the Mercator aspect ratio (no north/south stretching)');

    /* The bytes that reached the encoder are the heat texture: colours kept and
     * hidden cells transparent (not black). */
    const frame = state.frames[0];
    equal(frame.width, texture.w, 'the encoded picture is the texture width');
    equal(frame.height, texture.h, 'the encoded picture is the texture height');
    equal(frame.data.length, texture.rgba.length, 'every texel is encoded');
    let differing = 0, transparent = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
        if (frame.data[i] !== texture.rgba[i] || frame.data[i + 1] !== texture.rgba[i + 1] ||
                frame.data[i + 2] !== texture.rgba[i + 2] || frame.data[i + 3] !== texture.rgba[i + 3]) varying();
        if (texture.rgba[i + 3] === 0) transparent += 1;
    }
    function varying() { differing += 1; }
    equal(differing, 0, 'the encoded pixels are exactly the 2D heat pixels');
    ok(transparent > 0, 'excluded cells are transparent in 3D too, not painted black');

    /* A second sync pass (the 1.5 s poll) must not re-encode the result. */
    const again = mirror.describe(layer, fakePanes);
    equal(state.encoded, 1, 'a repeated 3D sync reuses the encoded PNG (no main-thread work per poll)');
    equal(again.url, descriptor.url, 'the picture is stable between sync passes');
}

/* ── 2. the opacity slider reaches the 3D heatmap ─────────────────────────── */
{
    const state = { frames: [], canvases: [], encoded: 0 };
    const box = sandbox(state, true);
    const res = result(box.heat);
    const layer = box.heat.createLayer(res.payload, box.L, { pane: 'apmHeat' });
    layer._leaflet_id = 'apmHeatLayerOpacity';

    layer._dl3dOpacity = 0.35;
    const descriptor = box.mirror.describe(layer, fakePanes);
    equal(descriptor.opacity, 0.35, 'the APM opacity slider value is what 3D drapes the heat at');
    equal(layer._dl3dImage().opacity, 0.35, 'the picture carries the same opacity');
    layer._dl3dOpacity = 0;
    equal(box.mirror.describe(layer, fakePanes).opacity, 0,
        'dragging the slider to 0 % hides the heat in 3D as well');
}

/* ── 3. the very-high polygons keep their 2D look in 3D ───────────────────── */
{
    const state = { frames: [], canvases: [], encoded: 0 };
    const box = sandbox(state, true);
    const uiSource = read('js/apm-next/apm-ui.js');
    const options = outlineOptions(uiSource);
    ok(options.color && options.weight && options.fill === false,
        'the outlines declare colour/weight/fill at layer level (what the 3D mirror reads)');

    const outlines = new box.L.GeoJSON(HOTSPOT_GEOJSON, options);
    outlines._leaflet_id = 'apmOutlines';
    equal(box.mirror.classify(outlines, box.L), 'vector', 'the very-high outlines mirror as a vector layer');

    const descriptor = box.mirror.describe(outlines, fakePanes);
    equal(descriptor.paints.line['line-color'], '#d9f5ff', 'the 3D outline is the 2D cyan, not Leaflet blue');
    equal(descriptor.paints.line['line-width'], 2, 'the 3D outline keeps its 2 px width');
    equal(descriptor.paints.fill['fill-opacity'], 0,
        'no 20 % blue fill in 3D — the draped heatmap stays visible under the outline');
    equal(descriptor.z, 420, 'the outlines sit above the heat');

    /* The panel publishes the painted opacity itself so the slider reaches 3D. */
    ok(/_dl3dPaint/.test(uiSource), 'apm-ui.js publishes the 3D paint for the outlines');
    outlines._dl3dPaint = function () {
        return { line: { 'line-opacity': 0.95 * 0.5 }, fill: { 'fill-opacity': 0 } };
    };
    const dimmed = box.mirror.describe(outlines, fakePanes);
    near(dimmed.paints.line['line-opacity'], 0.475, 1e-9, 'the slider fades the 3D outline too');
    equal(dimmed.paints.fill['fill-opacity'], 0, 'the outline stays line-only when faded');
}

/* ── 4. both result layers travel together, in 2D pane order ──────────────── */
{
    const state = { frames: [], canvases: [], encoded: 0 };
    const box = sandbox(state, true);
    const res = result(box.heat);
    const heatLayer = box.heat.createLayer(res.payload, box.L, { pane: 'apmHeat' });
    heatLayer._leaflet_id = 'apmHeatLayerGroup';
    const outlines = new box.L.GeoJSON(HOTSPOT_GEOJSON, outlineOptions(read('js/apm-next/apm-ui.js')));
    outlines._leaflet_id = 'apmOutlinesGroup';
    const group = new box.L.LayerGroup([heatLayer, outlines]);
    group._leaflet_id = 'apmResultGroup';

    const map = {
        eachLayer: function (fn) { fn(group); },
        hasLayer: function () { return true; },
        getPane: fakePanes.getPane
    };
    const collected = box.mirror.collect(map);
    equal(collected.items.length, 2, 'the 2D result group yields both layers in 3D');
    const kinds = collected.items.map(function (item) { return item.kind + '@' + item.z; });
    equal(kinds.join(','), 'image@410,vector@420', 'draped heat under the draped outlines');
    ok(collected.items.every(function (item) { return item.kind !== 'unsupported'; }),
        'neither result layer is reported as unsupported in 3D');
    ok(collected.signature.indexOf('image:') !== -1 && collected.signature.indexOf('vector:') !== -1,
        'the 3D sync signature sees both (a re-run or a slider move is picked up)');

    /* Clear / APM off / re-run removes the group from the 2D map. */
    const empty = box.mirror.collect({
        eachLayer: function () {},
        hasLayer: function () { return false; },
        getPane: fakePanes.getPane
    });
    equal(empty.items.length, 0, 'clearing the 2D result removes the heat and the outlines from 3D');
}

/* ── 5. no canvas → the layer still reaches 3D through its tiles ──────────── */
{
    const state = { frames: [], canvases: [], encoded: 0 };
    const box = sandbox(state, false);
    const res = result(box.heat);
    const layer = box.heat.createLayer(res.payload, box.L, { pane: 'apmHeat' });
    layer._leaflet_id = 'apmHeatNoCanvas';
    equal(layer._dl3dImage(), null, 'without a canvas there is no picture to hand over');
    equal(box.mirror.classify(layer, box.L), 'raster',
        'the layer then falls back to its own tile renderer instead of vanishing');
    const descriptor = box.mirror.describe(layer, fakePanes);
    equal(descriptor.kind, 'raster', 'the fallback descriptor is the 2D canvas-tile route');
    ok(/^dl2d:\/\//.test(descriptor.template), '…driven by the live 2D layer');
}

/* ── 6. wiring: panel, worker, shell cache and the viewer ─────────────────── */
{
    const html = read('index.html');
    const sw = read('sw.js');
    const ui = read('js/apm-next/apm-ui.js');
    const worker = read('js/apm-next/apm-worker.js');
    const viewer = read('js/map3d-terrain.js');
    const TAG = '20261102-apm-3d-drape';

    ok(html.includes('js/apm-next/apm-heatmap.js?v=' + TAG), 'index.html loads the tagged heat module');
    ok(html.includes('js/apm-next/apm-ui.js?v=' + TAG), 'index.html loads the tagged APM panel');
    ok(html.includes('js/map3d-mirror.js?v=' + TAG), 'index.html loads the tagged 2D→3D mirror');
    ok(sw.includes("'js/apm-next/apm-heatmap.js?v=" + TAG + "'") &&
        sw.includes("'js/apm-next/apm-ui.js?v=" + TAG + "'") &&
        sw.includes("'js/apm-next/apm-worker.js?v=" + TAG + "'") &&
        sw.includes("'js/map3d-mirror.js?v=" + TAG + "'"),
        'the PWA shell precaches the new tags');
    ok(sw.includes("'js/apm-next/apm-heatmap.js?v=20261102-apm-continuous-heat'"),
        'the previous heat tag stays precached for installed shells');
    ok(/const CACHE_NAME = 'detectlab-v389-apm-3d-drape'/.test(sw), 'CACHE_NAME was bumped for the release');
    ok(ui.includes('apm-worker.js?v=' + TAG), 'the panel loads the worker at the same tag');
    ok(worker.includes("'apm-heatmap.js?v=" + TAG + "'"), 'the worker imports the heat module at that tag');

    /* The viewer drapes image sources and keeps the APM item off the base-map
     * slot, so the heat is drawn OVER the basemap/terrain rather than becoming
     * it. */
    ok(/map\.addSource\(sourceId, \{ type: 'image', url: item\.url, coordinates: coordinates \}\)/.test(viewer),
        'the 3D viewer adds the picture as a MapLibre image source (draped on the terrain)');
    ok(/function mirroredBaseItem\(\)[\s\S]{0,200}item\.kind === 'raster'/.test(viewer),
        'only raster layers compete for the 3D base-map slot — the APM picture never does');
    ok(/renderImage\(entry\)/.test(viewer) && /entry\.kind === 'image'/.test(viewer),
        'image entries are rendered by the draped-image renderer');

    /* The panel keeps the result layers and pushes slider changes to 3D. */
    ok(/resultLayers/.test(ui) && /_dl3dOpacity/.test(ui), 'the panel publishes the result opacity to 3D');
    ok(/function sync3d\(\)/.test(ui) && /viewer\.syncLayers\(\)/.test(ui),
        'a result or slider change re-plans the 3D deck immediately');
    ok(/outlines\._dl3dPaint = function/.test(ui), 'the outlines carry their 3D paint');
}

console.log('\n' + passed + ' APM 3D-drape checks passed.');
