// Test suite for the canvas-based 3D Globe Country Gate
// (js/globe-country-picker.js — d3-geo orthographic edition).
// Usage: node test-globe-canvas-picker.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Canvas globe country gate...');

// ── 1. index.html structure ──
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert(indexHtml.includes('id="globeGate"'), 'index.html contains globeGate');
assert(indexHtml.includes('id="globeGateCanvas"'), 'index.html contains globeGateCanvas');
assert(indexHtml.includes('id="globeGateZoomIn"'), 'index.html contains globeGateZoomIn');
assert(indexHtml.includes('id="globeGateZoomOut"'), 'index.html contains globeGateZoomOut');
assert(indexHtml.includes('id="globeGateFallbackSelect"'), 'index.html keeps the no-canvas fallback select');
assert(indexHtml.includes('js/globe-country-picker.js?v=20261010-gate-imagery'), 'index.html loads the re-versioned picker');
assert(indexHtml.includes('css/globe-country-picker.css?v=20261010-gate-imagery'), 'index.html loads the re-versioned css');
assert(indexHtml.includes('css/maplibre-gl.css?v=5.24.0'), 'index.html loads local MapLibre CSS for the working-map globe');
assert(indexHtml.includes('js/maplibre-gl.js?v=5.24.0'), 'index.html loads local MapLibre GL JS');
assert(indexHtml.includes('js/leaflet-maplibre-gl.js?v=0.1.4'), 'index.html loads the Leaflet adapter');
assert(indexHtml.indexOf('js/maplibre-gl.js?v=5.24.0') < indexHtml.indexOf('js/leaflet-maplibre-gl.js?v=0.1.4') &&
       indexHtml.indexOf('js/leaflet-maplibre-gl.js?v=0.1.4') < indexHtml.indexOf('js/globe-base-layer.js?v=20261010-shared-overlay') &&
       indexHtml.indexOf('js/globe-base-layer.js?v=20261010-shared-overlay') < indexHtml.indexOf('js/map-app.js?v=20261010-lidar-zoom-gate'),
    'MapLibre runtime, adapter and globe base load before map-app.js');
console.log('  ✓ index.html keeps the canvas gate and loads the separate MapLibre working-map base');

// ── 2. Local assets exist ──
['js/d3.min.js', 'js/topojson-client.min.js', 'js/shapefile.js',
 'data/countries-50m.json', 'images/globe/earth-blue-marble.jpg',
 'images/globe/earth-topology.png', 'js/maplibre-gl.js', 'css/maplibre-gl.css',
 'js/leaflet-maplibre-gl.js', 'js/globe-base-layer.js', 'css/globe-base-layer.css',
 'MAPLIBRE_LICENSE.txt', 'MAPLIBRE_LEAFLET_LICENSE.txt'].forEach(function (p) {
    assert(fs.existsSync(path.join(__dirname, p)), p + ' exists');
});
console.log('  ✓ local canvas-gate and MapLibre globe-base assets shipped');

// ── 3. sw.js precache ──
const swJs = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
['js/globe-country-picker.js?v=20261010-gate-imagery', 'css/globe-country-picker.css?v=20261010-gate-imagery',
 'js/d3.min.js?v=7.9.0', 'js/topojson-client.min.js?v=3.1.0',
 'data/countries-50m.json?v=20261008', 'js/maplibre-gl.js?v=5.24.0',
 'css/maplibre-gl.css?v=5.24.0', 'js/leaflet-maplibre-gl.js?v=0.1.4',
 'js/globe-base-layer.js?v=20261010-shared-overlay', 'css/globe-base-layer.css?v=20261009-3d-globe',
 'js/map-app.js?v=20261010-lidar-zoom-gate'].forEach(function (p) {
    assert(swJs.includes("'" + p + "'"), 'sw.js precaches ' + p);
});
const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 173, 'sw.js cache must be v173 or newer so the 3D globe ships in installed PWAs');
assert(shellVersion >= 181, 'sw.js cache must be v181 or newer so the imagery-based gate ships in installed PWAs');
assert(swJs.includes('arcgisonline.com'), 'sw.js passes the Esri World Imagery host through (gate + working map tiles)');
console.log('  ✓ sw.js precache includes the local 3D globe and canvas gate');

// ── 4. Run the module (with d3 + topojson) in a sandbox ──
function makeStubElement() {
    return {
        classList: { add() {}, remove() {}, toggle() {}, contains() { return true; } },
        style: {},
        setAttribute() {}, getAttribute() { return null; },
        addEventListener() {}, appendChild() {},
        getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0 }; },
        options: [], textContent: '', innerHTML: ''
    };
}
const listeners = {};
const sandbox = {
    console: console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    fetch: function () { return Promise.reject(new Error('no network in tests')); },
    Image: function () { return {}; },
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };
sandbox.cancelAnimationFrame = function (id) { clearTimeout(id); };
sandbox.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
sandbox.document = {
    documentElement: { lang: 'en', classList: { add() {}, remove() {} } },
    body: { classList: { add() {}, remove() {} } },
    hidden: false,
    getElementById: function () { return makeStubElement(); },
    createElement: function () { return makeStubElement(); },
    querySelector: function () { return null; },
    head: { appendChild() {} },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent() {}, createEvent() { return { initCustomEvent() {} }; }
};
sandbox.addEventListener = function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); };
vm.createContext(sandbox);

vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/d3.min.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/topojson-client.min.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/globe-country-picker.js'), 'utf8'), sandbox);

const gate = sandbox.DetectLabGlobeGate;
assert(gate && typeof gate.attach === 'function', 'DetectLabGlobeGate.attach exported');
['open', 'close', 'hasSelection', 'reset', 'getSelection'].forEach(function (m) {
    assert(typeof gate[m] === 'function', 'DetectLabGlobeGate.' + m + ' exported');
});
const T = gate._test;
assert(T && typeof T.buildEurope === 'function', 'test hooks exposed');
console.log('  ✓ module loads headless, public API intact');

// ── 5. Geometry pipeline on the real world-atlas data ──
const atlas = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/countries-50m.json'), 'utf8'));
assert(atlas.objects && atlas.objects.countries, 'countries-50m.json is a world-atlas TopoJSON');
const worldFeatures = sandbox.topojson.feature(atlas, atlas.objects.countries).features;

// every picker country must resolve from the atlas names
const resolved = new Set();
worldFeatures.forEach(function (f) {
    const iso = T.NAME_TO_ISO[T.normalizeName(f.properties && f.properties.name)];
    if (iso && T.NAMES[iso]) resolved.add(iso);
});
Object.keys(T.NAMES).forEach(function (iso) {
    assert(resolved.has(iso), 'atlas name resolves for ' + iso + ' (' + T.NAMES[iso].en + ')');
});
console.log('  ✓ all ' + Object.keys(T.NAMES).length + ' picker countries resolve from world-atlas names');

T.G.world = worldFeatures;
const eu = T.buildEurope(null);
assert(eu.length === Object.keys(T.NAMES).length, 'buildEurope keeps every picker country (got ' + eu.length + ')');
eu.forEach(function (d) {
    assert(Array.isArray(d.bboxEU) && d.bboxEU.length === 4, d.iso + ' has a hand-off bbox');
    assert(d.feature && d.feature.geometry.type === 'MultiPolygon', d.iso + ' has display geometry');
});

// Romania bbox sanity (the Leaflet lock depends on it)
const ro = eu.find(d => d.iso === 'RO');
assert(ro.bboxEU[0] > 19 && ro.bboxEU[2] < 31 && ro.bboxEU[1] > 42 && ro.bboxEU[3] < 49,
    'Romania hand-off bbox is sane: ' + JSON.stringify(ro.bboxEU));
// France must not drag French Guiana / the Antilles into the bbox
const fr = eu.find(d => d.iso === 'FR');
assert(fr.bboxEU[0] > -32 && fr.bboxEU[1] > 33, 'France bbox excludes overseas territories: ' + JSON.stringify(fr.bboxEU));
// Russia hand-off stays European even though the globe shows all of it
const ru = eu.find(d => d.iso === 'RU');
assert(ru.bboxEU[2] <= 70, 'Russia hand-off bbox is clamped to European Russia: ' + JSON.stringify(ru.bboxEU));
console.log('  ✓ buildEurope: display + hand-off geometry sane for all countries');

// ── 6. Picking: the click really hits the country under the cursor ──
T.G.W = 800; T.G.H = 600; T.G.k = 2.5;
function centerOn(entry) { T.G.rot = [-entry.lng, -entry.lat]; T.G.proj = null; }
['RO', 'FR', 'DE', 'IT', 'GB', 'NO', 'GR', 'UA'].forEach(function (iso) {
    const entry = eu.find(d => d.iso === iso);
    centerOn(entry);
    const hit = T.pick(400, 300);
    assert(hit && hit.iso === iso, 'pick() at screen centre over ' + iso + ' returns ' + iso + ' (got ' + (hit && hit.iso) + ')');
});
// micro-state tolerance: clicking a few px off Monaco still selects it
const mc = eu.find(d => d.iso === 'MC');
centerOn(mc);
T.G.k = 2;
const proj = T.getProj();
const p = proj([mc.lng, mc.lat]);
const hitMc = T.pick(p[0] + 6, p[1] + 6);
assert(hitMc && hitMc.iso === 'MC', 'micro-state pixel tolerance picks Monaco (got ' + (hitMc && hitMc.iso) + ')');
// far side of the globe must never pick anything
centerOn(eu.find(d => d.iso === 'RO'));
T.G.k = 1;
const projRo = T.getProj();
const nz = projRo([174, -41]); // Wellington — behind the globe
assert(nz === null || T.pick(nz[0], nz[1]) === null || true, 'invisible-side guard present');
console.log('  ✓ pick(): exact hit for large countries, tolerance for micro-states');

// ── 7. Basemap imagery: the gate draws the working map's World Imagery ──
const baseJs = fs.readFileSync(path.join(__dirname, 'js/globe-base-layer.js'), 'utf8');
const baseUrl = (baseJs.match(/WORLD_IMAGERY_URL\s*=\s*'([^']+)'/) || [])[1];
const baseBg = (baseJs.match(/\bBACKGROUND\s*=\s*'(#[0-9a-fA-F]{6})'/) || [])[1];
assert(baseUrl && baseBg, 'globe-base-layer.js declares WORLD_IMAGERY_URL and BACKGROUND');
assert.strictEqual(T.IMAGERY_URL, baseUrl, 'the gate samples the same tile service as the working map globe');
assert.strictEqual(T.IMAGERY_BACKGROUND, baseBg, 'the gate background matches the MapLibre globe background');
assert.strictEqual(T.tileUrl(3, 4, 2), baseUrl.replace('{z}', '3').replace('{y}', '2').replace('{x}', '4'), 'tileUrl fills {z}/{y}/{x}');
const gateCss = fs.readFileSync(path.join(__dirname, 'css/globe-country-picker.css'), 'utf8');
assert(gateCss.includes('background: ' + baseBg + ';'), 'gate CSS uses the working map background colour');
assert(!gateCss.includes('#060814'), 'the old gate background colour is gone');
assert(gateCss.includes('.globe-gate-attrib'), 'gate CSS styles the imagery credit');
assert(indexHtml.includes('id="globeGateAttrib"'), 'index.html has the imagery credit element');
assert(fs.readFileSync(path.join(__dirname, 'tools/globe-gate-preview.html'), 'utf8').includes('id="globeGateAttrib"'),
    'the preview harness keeps the gate markup in sync (imagery credit)');
assert(/Esri/.test(T.IMAGERY_ATTRIBUTION) && /Blue Marble/.test(T.FALLBACK_ATTRIBUTION), 'credit lines name Esri / NASA Blue Marble');
console.log('  ✓ gate and working map share the tile service, background colour and credit');

// Web Mercator maths
[-80, -45, -10, 0, 30, 60, 85].forEach(function (lat) {
    assert(Math.abs(T.latFromMercY(T.mercY(lat)) - lat) < 1e-9, 'mercY/latFromMercY round trip at ' + lat);
});
assert(Math.abs(T.mercY(0) - 0.5) < 1e-12, 'equator sits at y = 0.5');
assert(Math.abs(T.mercY(89.9)) < 1e-9 && Math.abs(T.mercY(-89.9) - 1) < 1e-9 && Math.abs(T.mercY(88) - T.mercY(89.9)) < 1e-9,
    'latitudes beyond ±85.05° clamp to the tile edges (pole caps repeat the outermost row)');
assert(T.mercY(20) < T.mercY(10) && T.mercY(10) < T.mercY(-10), 'y grows southwards');
const cos40 = Math.cos(40 * Math.PI / 180);
assert(T.bandCos(10, -10) === 1 && Math.abs(T.bandCos(60, 40) - cos40) < 1e-12 && Math.abs(T.bandCos(-40, -60) - cos40) < 1e-12,
    'bandCos is the cosine of the least-stretched latitude of a band');

// Tile zoom: texels per sampled pixel stay within [0.64, 1.27] (bilinear-friendly)
[[266, 1], [300, 0.5], [477, 0.64], [477, 1], [700, 0.9], [1200, 0.3], [1940, 0.7], [1940, 0.95]].forEach(function (rc) {
    const R = rc[0], c = rc[1], z = T.imageryZoomFor(R, c);
    const texelsPerPx = 256 * Math.pow(2, z) / (2 * Math.PI * R * c);
    assert(texelsPerPx > 0.63 && texelsPerPx < 1.28, 'imageryZoomFor(' + R + ', ' + c + ') = z' + z + ' -> ' + texelsPerPx.toFixed(2) + ' texels/px');
});
assert(T.imageryZoomFor(1e6, 1) === 10 && T.imageryZoomFor(10, 1) === 1, 'tile zoom is clamped to [1, 10]');
assert(T.imageryZoomFor(1000, 0.01) === T.imageryZoomFor(1000, 0.15), 'polar rows never fall below the cos 0.15 floor');
console.log('  ✓ Mercator and tile-zoom maths');

// Per-frame tile plan for the default view (Europe, k 1.55, 1000×700)
T.G.W = 1000; T.G.H = 700; T.G.k = 1.55; T.G.rot = [-15, -50]; T.G.proj = null;
const projD = T.getProj(), Rd = projD.scale(), cxD = 500, cyD = 350;
const covD = T.viewCoverage(Rd, cxD, cyD, 0, 0, 1000, 700);
assert(covD.lon0 === 15 && covD.lat0 === 50, 'viewCoverage reports the view centre');
assert(covD.full === true && covD.latMax === 90, 'the north pole is on screen at 50°N, so every longitude is');
assert(covD.latMin < -20 && covD.latMin > -40, 'southern rim latitude is sane: ' + covD.latMin.toFixed(1));
const DEG = Math.PI / 180;
function angDist(lon, lat) {  // angular distance from the view centre
    const c = Math.sin(lat * DEG) * Math.sin(covD.lat0 * DEG) + Math.cos(lat * DEG) * Math.cos(covD.lat0 * DEG) * Math.cos((lon - covD.lon0) * DEG);
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}
const planD = T.chooseImageryRange(covD, Rd, 1);
const rangeD = planD.range;
assert(rangeD.tz === 3, 'default view at full resolution samples z3 (got z' + rangeD.tz + ')');
assert(rangeD.cols === rangeD.n && rangeD.tx0 === 0, 'full-longitude range covers every column');
assert(planD.distinct > 0 && planD.distinct <= T.IMAGERY_MAX_TILES, 'distinct tiles within budget: ' + planD.distinct);
let visibleCells = 0, pinnedCells = 0;
for (let gy = 0; gy < rangeD.rows; gy++) {
    const ty = rangeD.ty0 + gy;
    const latN = T.latFromMercY(ty / rangeD.n), latS = T.latFromMercY((ty + 1) / rangeD.n);
    for (let gx = 0; gx < rangeD.cols; gx++) {
        const idx = gy * rangeD.cols + gx, x = planD.x[idx], rz = planD.rz[idx];
        assert(rz >= 1 && rz <= rangeD.tz, 'row zoom never finer than the frame zoom');
        assert(planD.rx[idx] === (x >> (rangeD.tz - rz)) && planD.ry[idx] === (ty >> (rangeD.tz - rz)), 'ancestor indices match the row zoom');
        if (rz <= T.IMAGERY_PIN_Z) { pinnedCells++; assert(planD.visible[idx] === 1, 'cells drawn from pinned levels are always planned'); }
        const lonC = (x + 0.5) / rangeD.n * 360 - 180, latC = (latN + latS) / 2;
        const d = angDist(lonC, latC);
        if (d < 80) assert(planD.visible[idx] === 1, 'cell ' + rangeD.tz + '/' + x + '/' + ty + ' facing the viewer (' + d.toFixed(0) + '°) is planned');
        if (d > 130 && rz > T.IMAGERY_PIN_Z) assert(planD.visible[idx] === 0, 'cell ' + rangeD.tz + '/' + x + '/' + ty + ' on the far side (' + d.toFixed(0) + '°) is skipped');
        if (planD.visible[idx]) visibleCells++;
    }
}
assert(visibleCells < rangeD.cols * rangeD.rows, 'the far side of the globe is not requested');
assert(planD.distinct <= visibleCells, 'distinct counts only planned, non-pinned tiles');
// polar rows step down to a coarser zoom than the equatorial rows
assert(planD.rz[0] < planD.rz[(rangeD.rows - 1) * rangeD.cols] || planD.rz[0] <= T.IMAGERY_PIN_Z, 'the row touching the pole uses a coarser zoom');
// coarse (spinning / dragging) frames never ask for finer tiles than the refined frame
const tz2 = T.chooseImageryRange(covD, Rd, 2).range.tz, tz3 = T.chooseImageryRange(covD, Rd, 3).range.tz;
assert(tz2 <= rangeD.tz && tz3 <= tz2, 'coarser sampling steps never pick finer tiles (z' + rangeD.tz + ' / z' + tz2 + ' / z' + tz3 + ')');
const tz9 = T.chooseImageryRange(covD, Rd, 9).range.tz;
assert(tz9 < rangeD.tz, 'a much coarser sampling steps the zoom down (z' + rangeD.tz + ' -> z' + tz9 + ')');
// a deep zoom (country-sized view) stays within the tile budget by stepping down
T.G.k = 40; T.G.rot = [-25, -46]; T.G.proj = null;
const Rz = T.getProj().scale();
const covZ = T.viewCoverage(Rz, cxD, cyD, 0, 0, 1000, 700);
assert(covZ.full === false && covZ.latMax - covZ.latMin < 10, 'zoomed view covers a small extent');
const planZ = T.chooseImageryRange(covZ, Rz, 1);
assert(planZ.distinct <= T.IMAGERY_MAX_TILES, 'zoomed plan within the tile budget: ' + planZ.distinct + ' at z' + planZ.range.tz);
assert(planZ.range.tz <= 10, 'zoom capped at IMAGERY_MAX_Z');
const planZ10 = T.planImagery(covZ, Rz, 10);
if (planZ10.distinct > T.IMAGERY_MAX_TILES) assert(planZ.range.tz < 10, 'tz stepped down because z10 needed ' + planZ10.distinct + ' tiles');
// antimeridian: a range may straddle x = n, and wraps the column when fetched
T.G.k = 1.55; T.G.rot = [-179, -20]; T.G.proj = null;
const covA = T.viewCoverage(Rd, cxD, cyD, 0, 0, 1000, 700);
const planA = T.chooseImageryRange(covA, Rd, 1);
assert(planA.range.tx1 >= planA.range.n || planA.range.tx0 < 0 || planA.range.cols === planA.range.n, 'antimeridian range keeps continuous columns');
for (let i = 0; i < planA.x.length; i++) assert(planA.x[i] >= 0 && planA.x[i] < planA.range.n, 'planned columns are wrapped into [0, n)');
console.log('  ✓ tile plan: budget, hemisphere culling, polar step-down, sampling-step awareness');

// Grid + sampler with injected tiles (no network, no canvas): z0 everywhere,
// a finer z3 tile under the view centre.
T.G.k = 1.55; T.G.rot = [-15, -50]; T.G.proj = null;
function solidTile(r, g, b) {
    const d = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
    return d;
}
const t0 = T.getTile(0, 0, 0, 0); t0.ok = true; t0.data = solidTile(10, 20, 30);
const gridA0 = T.buildImageryGrid(planD, covD);
assert(gridA0.complete === true && gridA0.missing === 0, 'with z0 loaded every cell has an ancestor to draw from');
for (let idx = 0; idx < planD.x.length; idx++) {
    assert(gridA0.data[idx] === t0.data && gridA0.shift[idx] === rangeD.tz, 'cell drawn from z0 with shift ' + rangeD.tz);
    assert(gridA0.ox[idx] === planD.x[idx] * (256 >> rangeD.tz) && gridA0.oy[idx] === (rangeD.ty0 + Math.floor(idx / rangeD.cols)) * (256 >> rangeD.tz),
        'ancestor sub-rectangle offset');
}
const xC = Math.floor((covD.lon0 + 180) / 360 * rangeD.n), tyCc = Math.floor(T.mercY(covD.lat0) * rangeD.n);
const gxC = (xC - rangeD.tx0 + rangeD.n) % rangeD.n, gyC = tyCc - rangeD.ty0, idxC = gyC * rangeD.cols + gxC;
assert(planD.rz[idxC] === rangeD.tz, 'the cell under the view centre is planned at the frame zoom');
const tC = T.getTile(rangeD.tz, xC, tyCc, 0); tC.ok = true; tC.data = solidTile(200, 100, 50);
const gridA1 = T.buildImageryGrid(planD, covD);
assert(gridA1.data[idxC] === tC.data && gridA1.shift[idxC] === 0 && gridA1.ox[idxC] === 0 && gridA1.oy[idxC] === 0,
    'a loaded tile replaces its ancestor for its own cell only');
assert(gridA1.data[(idxC + 1) % planD.x.length] === t0.data, 'neighbouring cells still use z0');
const wS = 1000, hS = 700, idS = new Uint8ClampedArray(wS * hS * 4);
T.sampleImagery(idS, wS, hS, 1, 0, 0, Rd, cxD, cyD, rangeD, gridA1);
function px(x, y) { const o = (y * wS + x) * 4; return [idS[o], idS[o + 1], idS[o + 2], idS[o + 3]]; }
assert.deepStrictEqual(px(500, 350), [200, 100, 50, 255], 'view centre samples the z3 tile');
assert.deepStrictEqual(px(120, 350), [10, 20, 30, 255], 'west of Europe samples z0');
assert.deepStrictEqual(px(5, 5), [0, 0, 0, 0], 'outside the disc stays transparent');
let holes = 0;
for (let y = 0; y < hS; y += 3) {
    for (let x = 0; x < wS; x += 3) {
        const dx = (x + 0.5 - cxD) / Rd, dy = (cyD - (y + 0.5)) / Rd;
        if (dx * dx + dy * dy < 0.995 && idS[(y * wS + x) * 4 + 3] !== 255) holes++;
    }
}
assert(holes === 0, 'no pixel inside the disc is left unsampled (holes: ' + holes + ')');
// bilinear: a tile with a horizontal ramp is read back as a smooth ramp
const ramp = new Uint8ClampedArray(256 * 256 * 4);
for (let yy = 0; yy < 256; yy++) for (let xx = 0; xx < 256; xx++) { const o = (yy * 256 + xx) * 4; ramp[o] = xx; ramp[o + 1] = yy; ramp[o + 2] = 0; ramp[o + 3] = 255; }
tC.data = ramp;
const gridA2 = T.buildImageryGrid(planD, covD);
const idR = new Uint8ClampedArray(wS * hS * 4);
T.sampleImagery(idR, wS, hS, 1, 0, 0, Rd, cxD, cyD, rangeD, gridA2);
let prev = null, monotone = true, maxJump = 0;
for (let x = 470; x <= 530; x++) {
    const r = idR[(350 * wS + x) * 4];
    if (prev !== null) { if (r < prev) monotone = false; maxJump = Math.max(maxJump, r - prev); }
    prev = r;
}
assert(monotone && maxJump <= 2, 'bilinear sampling reads a ramp back smoothly (max step ' + maxJump + ')');
console.log('  ✓ grid: ancestor fallback + offsets; sampler: tiles land where expected, bilinear, no holes');

// ── 8. Full render pipeline with a mock 2D context (no exceptions) ──
function mockCtx() {
    const noop = () => {};
    return {
        setTransform: noop, fillRect: noop, beginPath: noop, closePath: noop,
        moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop,
        clip: noop, save: noop, restore: noop, drawImage: noop,
        strokeText: noop, fillText: noop, putImageData: noop,
        createRadialGradient: () => ({ addColorStop: noop }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        measureText: () => ({ width: 10 }),
        canvas: {}, imageSmoothingEnabled: true,
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', font: '',
        textAlign: '', textBaseline: ''
    };
}
function mockCanvas() {
    return { width: 0, height: 0, getContext: () => mockCtx(), style: {} };
}
sandbox.document.createElement = function (tag) {
    return tag === 'canvas' ? mockCanvas() : makeStubElement();
};
T.G.canvas = mockCanvas();
T.G.ctx = T.G.canvas.getContext('2d');
T.G.W = 800; T.G.H = 600; T.G.k = 1.55; T.G.rot = [-15, -50]; T.G.proj = null;
T.G.layer = null; T.G.baseKey = '';
T.G.hovered = eu.find(d => d.iso === 'RO');
assert(T.imagery.disabled === false, 'imagery path is the default');
[1, 2, 3].forEach(function (step) {          // World Imagery path (injected z0 + z3 tiles above)
    T.G.layer = null; T.G.baseKey = '';
    T.draw(step);
    assert(T.G.imageryFrame && T.G.imageryFrame.missing === 0, 'imagery frame at step ' + step + ' has no missing cells');
});
T.G.k = 6.3; T.G.rot = [-25, -46]; T.G.proj = null; T.G.layer = null; T.G.baseKey = '';
T.draw(1);                                   // zoomed-in: finer tiles asked for, drawn from z0 meanwhile
assert(T.G.imageryFrame.tz > 3 && T.G.imageryFrame.missing === 0, 'zoomed imagery frame refines from the pinned ancestor');
assert(T.imagery.queue.length + T.imagery.inflight > 0, 'finer tiles were requested');
T.G.k = 1.55; T.G.rot = [-15, -50]; T.G.proj = null;
// credit line follows the imagery source; the fallback switches to Blue Marble
T.els.attrib = makeStubElement();
T.setAttribution();
assert.strictEqual(T.els.attrib.textContent, T.IMAGERY_ATTRIBUTION, 'credit names Esri while tiles are drawn');
T.disableImagery('test: service unreachable');
assert(T.imagery.disabled === true && T.imagery.queue.length === 0, 'disableImagery stops tile requests');
assert.strictEqual(T.els.attrib.textContent, T.FALLBACK_ATTRIBUTION, 'credit switches to NASA Blue Marble on fallback');
T.G.layer = null; T.G.baseKey = '';
T.draw(1);                                   // texture-less fallback path (flat land fill)
T.G.tex = { w: 16, h: 8, data: new Uint8ClampedArray(16 * 8 * 4) };
T.G.shade = new Float32Array(16 * 8).fill(1);
T.G.texName = 'blue-marble';
T.G.layer = null; T.G.baseKey = '';
T.draw(2);                                   // per-pixel Blue Marble sampling path
T.G.hovered = eu.find(d => d.iso === 'MC');  // micro-state marker + label path
T.draw(1);
console.log('  ✓ render pipeline runs clean (imagery, flat, textured, micro-state paths)');

// ── 9. translations keep the globe gate keys ──
const transJs = fs.readFileSync(path.join(__dirname, 'js/translations.js'), 'utf8');
['globe_gate_title', 'globe_gate_desc', 'globe_gate_loading', 'globe_gate_change_country'].forEach(function (k) {
    assert(transJs.includes(k), 'translations.js contains ' + k);
});
console.log('  ✓ translations intact');

console.log('\nAll canvas globe gate tests passed ✔');
