// Probe: the 3D mirror's bundling and CSS-blend emulation, without a browser.
//
//   node tools/probe-3d-blend.js
//
// It loads the real js/map3d-mirror.js (and the real Leaflet bundle) into Node
// with the smallest DOM a tile layer needs, then:
//   1. bundles a 200 000-polyline feature group and times the poll pass;
//   2. repaints a blended tile through the same code path MapLibre uses and
//      checks the result against the CSS formula it replaces.
// The assertions themselves live in test-map3d-terrain.js; this script prints
// the numbers (bundle counts, timings, byte counts) that justify the budgets.
'use strict';
const path = require('path');
const REPO = path.join(__dirname, '..');

/* ── the smallest DOM Node needs for Leaflet ─────────────────────────────── */
function fakeCanvas(width, height) {
    const canvas = { width: width, height: height, _pixels: new Uint8ClampedArray(width * height * 4) };
    canvas.getContext = function () {
        return {
            drawImage: function (image) { canvas._pixels.set(image._pixels); },
            getImageData: function (x, y, w, h) {
                return { data: canvas._pixels.slice(), width: w, height: h };
            },
            putImageData: function (frame) { canvas._pixels.set(frame.data); }
        };
    };
    canvas.toBlob = function (done) { done({ arrayBuffer: function () { return Promise.resolve(canvas._pixels.slice().buffer); } }); };
    return canvas;
}
const documentStub = {
    documentElement: { style: {}, className: '', lang: 'ro' },
    createElement: function (tag) { return tag === 'canvas' ? fakeCanvas(256, 256) : { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }; },
    addEventListener() {}, getElementsByTagName: function () { return []; }, body: { appendChild() {} }
};
global.window = global;
global.document = documentStub;
try {
    Object.defineProperty(global, 'navigator', { value: { userAgent: 'node', platform: 'node' }, configurable: true });
} catch (e) { /* Node 22 already exposes a read-only navigator */ }
global.screen = { deviceXDPI: 96, logicalXDPI: 96 };
/* Stand-in for the browser decoder: the probe hands it raw RGBA, so the
 * round-trip through createImageBitmap is exercised without an image codec. */
global.createImageBitmap = function (blob) {
    return blob.arrayBuffer().then(function (buffer) {
        const pixels = new Uint8ClampedArray(buffer);
        return { width: 256, height: 256, _pixels: pixels };
    });
};

require(path.join(REPO, 'js/leaflet.js'));
const L = global.L;
require(path.join(REPO, 'js/map3d-mirror.js'));
const MIRROR = global.DetectLabMirror;

function mapWith(layer) {
    return {
        getPane: function () { return { style: { zIndex: '625' } }; },
        eachLayer: function (fn) { fn(layer); },
        hasLayer: function () { return true; },
        unproject: function () { return L.latLng(0, 0); },
        options: { crs: L.CRS.EPSG3857 }
    };
}

/* ── 0. the layer the user reported: “Romania 1m/pixel agregare” ─────────── */
const ro1m = L.tileLayer('https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/{z}/{y}/{x}', {
    name: 'Romania 1m/pixel agregare', className: 'lidar-ro1m-tiles', maxNativeZoom: 16,
    opacity: 0.85, pane: 'pane_lidar'
});
ro1m._leaflet_id = 'RO1';
const roMap = {
    getPane: function (name) { return { style: { zIndex: name === 'pane_lidar' ? '610' : '400' } }; },
    eachLayer: function (fn) { fn(ro1m); },
    hasLayer: function () { return true; }
};
const roItem = MIRROR.describe(ro1m, roMap, {});
console.log('[probe] ro1m descriptor : ' + JSON.stringify({
    kind: roItem.kind, template: roItem.template, render: roItem.render, blend: roItem.blend,
    z: roItem.z, maxzoom: roItem.maxzoom, opacity: roItem.opacity
}));
console.log('[probe] ro1m tile URL   : ' + MIRROR.tileUrlFor(ro1m, 16, 36100, 22800));

/* ── 1. a Roman-roads-shaped group ───────────────────────────────────────── */
const N = 200000;
const children = [];
for (let i = 0; i < N; i += 1) {
    children.push(L.polyline([[44 + i * 1e-5, 26], [44.1 + i * 1e-5, 26.1]],
        { color: '#FF5A36', weight: 1.8, opacity: 0.8, interactive: false, pane: 'pane_roman' }));
}
const roads = L.featureGroup(children);
roads._leaflet_id = 'R1';
const map = mapWith(roads);

console.log('[probe] ' + N.toLocaleString() + ' polylines in one featureGroup');
let t = Date.now();
const first = MIRROR.collect(map);
console.log('[probe] first collect : ' + first.items.length + ' item(s), ' +
    first.items.reduce(function (n, i) { return n + i.geojson.features.length; }, 0).toLocaleString() + ' features, ' +
    (Date.now() - t) + ' ms, signature ' + first.signature.length + ' chars, capped ' + first.capped.length);
t = Date.now();
const cached = MIRROR.collect(map);
console.log('[probe] poll (cached) : ' + cached.items.length + ' item(s), ' + (Date.now() - t) + ' ms, identical ' +
    (cached.signature === first.signature));
console.log('[probe] labels        : ' + first.items.slice(0, 3).map(function (i) { return i.key + ' → ' + i.label; }).join(' | '));
MIRROR.invalidate(roads);
t = Date.now();
const rebuilt = MIRROR.collect(map);
console.log('[probe] after invalidate: ' + rebuilt.items.length + ' item(s), ' + (Date.now() - t) + ' ms');
children.forEach(function (c) { c.setStyle({ opacity: 0.4 }); });
t = Date.now();
const restyled = MIRROR.collect(map);
console.log('[probe] opacity slider : ' + (Date.now() - t) + ' ms, line-opacity ' +
    (restyled.items[0] && restyled.items[0].paints.line['line-opacity']));

/* ── 2. the blend: CSS screen(invert(tile)) vs the repainted pixels ──────── */
const SIZE = 256;
const source = new Uint8ClampedArray(SIZE * SIZE * 4);
for (let i = 0; i < source.length; i += 4) {
    const c = (i / 4) % 256;                     /* one grayscale ramp */
    source[i] = c; source[i + 1] = c; source[i + 2] = c; source[i + 3] = 255;
}
const blended = MIRROR.blendPixels({ data: source.slice(), width: SIZE, height: SIZE }, 'invert-screen');
let worst = 0;
for (let i = 0; i < blended.data.length; i += 4) {
    const c = ((i / 4) % 256) / 255;
    const base = 0.35;                            /* any base at all, not just black */
    const css = 1 - (1 - base) * c;               /* screen(base, invert(tile))      */
    const at = blended.data[i + 3] / 255;         /* white over base with that alpha */
    worst = Math.max(worst, Math.abs(css - (at + (1 - at) * base)));
}
console.log('[probe] blend vs CSS  : worst channel error ' + worst.toFixed(4) +
    ' (0 = pixel-exact), corner alpha ' + blended.data[3] + '…' + blended.data[blended.data.length - 1]);
const transparent = MIRROR.blendPixels({ data: new Uint8ClampedArray([10, 10, 10, 0]) }, 'invert-screen');
console.log('[probe] transparent px: alpha ' + transparent.data[3] + ' (stays invisible)');

/* ── 3. the full repaint chain the dl2d:// protocol uses ─────────────────── */
MIRROR.retintTile(source.buffer, SIZE, 'invert-screen').then(function (bytes) {
    const out = new Uint8ClampedArray(bytes);
    console.log('[probe] retintTile    : ' + bytes.byteLength + ' bytes, rgb ' +
        out[0] + ',' + out[1] + ',' + out[2] + ', alpha ' + out[3]);
    return MIRROR.retintTile(source.buffer, SIZE, null);
}).then(function (bytes) {
    console.log('[probe] no blend      : ' + bytes.byteLength + ' bytes untouched');
}).catch(function (error) {
    console.error('[probe] FAILED: ' + (error && error.stack || error));
    process.exitCode = 1;
});
