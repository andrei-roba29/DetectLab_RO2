// Node test harness for the premium "Archeological Report" layer.
// Usage: node test-archeo-report.js
//
// Loads the REAL js/pdf-writer.js, js/archeo-report-pdf.js,
// js/archeo-potential.js and js/archeo-report.js into a vm sandbox with
// browser stubs (including a working <canvas> + Image stub, so the APM/UAT
// pixel paths and the whole PDF page layout actually execute).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('  \u2714 ' + name); }
    else { failures++; console.error('  \u2718 ' + name + (extra !== undefined ? ' \u2014 ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

/* ── browser stubs ─────────────────────────────────────────────────────── */

// Tile colours returned by the fake image loader, keyed by URL fragment.
// Overridden per test to simulate different APM/UAT rasters.
let APM_PIXEL = [0, 0, 255];        // blue by default (APM score 5)
let APM_UNREADABLE = false;

function pixelsFor(url) {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) {
        data[i * 4] = APM_PIXEL[0];
        data[i * 4 + 1] = APM_PIXEL[1];
        data[i * 4 + 2] = APM_PIXEL[2];
        data[i * 4 + 3] = 255;
    }
    return data;
}

class FakeImage {
    constructor() { this.width = 256; this.height = 256; this._url = ''; this.crossOrigin = null; }
    set src(url) {
        this._url = url;
        setTimeout(() => { if (this.onload) this.onload(); }, 0);
    }
    get src() { return this._url; }
}

const ALL_FILL_TEXT = [];   // every string painted on any canvas (assertion aid)

function makeCtx(canvas) {
    let drawn = null;
    const ctx = {
        canvas,
        fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
        font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
        globalAlpha: 1,
        setTransform() {}, save() {}, restore() {},
        fillRect() {}, strokeRect() {}, clearRect() {},
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, rect() {},
        fill() {}, stroke() {}, clip() {}, setLineDash() {},
        fillText(t) { ALL_FILL_TEXT.push(String(t)); }, strokeText() {}, translate() {}, scale() {}, rotate() {},
        measureText(t) { return { width: String(t).length * 5.2 }; },
        drawImage(img) { drawn = pixelsFor(img && img._url); },
        getImageData(x, y, w, h) {
            if (APM_UNREADABLE) throw new Error('SecurityError: tainted canvas');
            const src = drawn || pixelsFor('');
            const out = new Uint8ClampedArray(w * h * 4);
            out.set(src.subarray(0, Math.min(src.length, out.length)));
            return { data: out, width: w, height: h };
        },
        putImageData() {},
        createLinearGradient() { return { addColorStop() {} }; }
    };
    return ctx;
}

function makeCanvas() {
    const canvas = { width: 300, height: 150 };
    canvas.getContext = function () { return makeCtx(canvas); };
    canvas.toDataURL = function (type) {
        // A real (tiny) baseline JPEG so the PDF writer can embed it.
        return 'data:image/jpeg;base64,' + TINY_JPEG_B64;
    };
    return canvas;
}

// Minimal valid JPEG (1x1 white) — enough for /DCTDecode embedding + atob.
const TINY_JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const CREATED_GROUPS = [];
const domNodes = {};
function fakeEl(id) {
    if (!domNodes[id]) {
        domNodes[id] = {
            id, textContent: '', innerHTML: '', style: {}, dataset: {},
            disabled: false, checked: false,
            value: id === 'archReportDistance' ? '3' : '',
            classList: { _c: {}, add(c) { this._c[c] = 1; }, remove(c) { delete this._c[c]; },
                         toggle(c, on) { if (on) this._c[c] = 1; else delete this._c[c]; }, contains(c) { return !!this._c[c]; } },
            _handlers: {},
            addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
            fire(ev, self) { (this._handlers[ev] || []).forEach(fn => fn.call(self || this, { target: self || this })); },
            appendChild() {}, removeChild() {}, click() {}
        };
    }
    return domNodes[id];
}

const fakeMap = {
    _panes: {}, _layers: new Set(),
    getCenter() { return { lat: 46.8, lng: 23.6 }; },
    getZoom() { return 14; },
    getBounds() { return { getNorth: () => 46.9, getSouth: () => 46.7, getEast: () => 23.7, getWest: () => 23.5 }; },
    getPane(n) { return this._panes[n] || null; },
    createPane(n) { this._panes[n] = { style: {} }; return this._panes[n]; },
    addLayer(l) { this._layers.add(l); }, removeLayer(l) { this._layers.delete(l); },
    hasLayer(l) { return this._layers.has(l); },
    on() {}, off() {}, fitBounds() {}
};

const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, JSON, Date, isFinite, isNaN, parseInt, parseFloat,
    Uint8Array, Uint8ClampedArray, Float32Array, ArrayBuffer, Object, Array, String, Number, RegExp, Error,
    performance: { now: () => Date.now() },
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    Image: FakeImage,
    L: {
        layerGroup() {
            const g = { layers: [], addLayer(l) { this.layers.push(l); return this; },
                        addTo(m) { this._added = true; if (m && m.addLayer) m.addLayer(this); return this; },
                        clearLayers() { this.layers = []; }, getLayers() { return this.layers; } };
            CREATED_GROUPS.push(g);
            return g;
        },
        polygon(latlngs, opts) {
            return { latlngs, options: opts, bindPopup(html, o) { this.popup = html; this.popupOpts = o; return this; },
                     bindTooltip(html, o) { this.tooltip = html; this.tooltipOpts = o; return this; },
                     on() { return this; }, openPopup() { this.popupOpened = true; return this; }, addTo(m) { if (m && m.addLayer) m.addLayer(this); return this; } };
        },
        circle(latlng, opts) {
            return {
                latlng, options: Object.assign({}, opts),
                bindPopup(html, o) { this.popup = html; this.popupOpts = o; return this; },
                bindTooltip(html, o) { this.tooltip = html; this.tooltipOpts = o; return this; },
                on() { return this; }, openPopup() { this.popupOpened = true; return this; },
                addTo(m) { if (m && m.addLayer) m.addLayer(this); return this; },
                setRadius(r) { this.options.radius = r; return this; },
                setStyle(s) { Object.assign(this.options, s); return this; },
                setLatLng(ll) { this.latlng = ll; return this; }
            };
        },
        circleMarker(latlng, opts) { return { latlng, options: opts }; },
        marker(latlng, opts) { return { latlng, options: opts, addTo(m) { if (m && m.addLayer) m.addLayer(this); return this; }, bindTooltip() { return this; } }; },
        divIcon(o) { return o; },
        latLng(a, b) { return { lat: a, lng: b }; },
        polyline(p, o) { return { points: p, options: o }; }
    }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.document = {
    readyState: 'complete',
    addEventListener() {},
    createElement(tag) { return tag === 'canvas' ? makeCanvas() : fakeEl('created-' + tag); },
    getElementById(id) { return fakeEl(id); },
    body: { appendChild() {}, removeChild() {} },
    fonts: { ready: Promise.resolve() },
    querySelectorAll() { return []; }
};
sandbox._dlMap = fakeMap;
sandbox.UAT_TILE_Z = 14;
sandbox._UAT_TILE_UNREADABLE = { unreadable: true };
sandbox._currentLang = () => 'en';
sandbox.fetch = function () {
    return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ type: 'FeatureCollection', features: [] }); }
    });
};

function load(file) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
}

const context = vm.createContext(sandbox);
sandbox.window = sandbox;
[ 'js/pdf-writer.js', 'js/archeo-report-pdf.js', 'js/archeo-potential.js', 'js/archeo-report.js' ].forEach(function (f) {
    const code = fs.readFileSync(path.join(__dirname, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
});

const R = sandbox._archeoReportDebug;
const CFG = sandbox.ARCH_REPORT_CONFIG;
const AP = sandbox._archeoPotentialDebug;

/* ── helpers ───────────────────────────────────────────────────────────── */
function mkUatGrid(cols, rows, cellM, fillRed) {
    const red = new Uint8Array(cols * rows);
    if (fillRed !== false) red.fill(1);
    return { x0: 0, y0: 0, cols, rows, cellM, red };
}
function mkApmGrid(cols, rows, cellM, cls) {
    const arr = new Float32Array(cols * rows);
    arr.fill(cls === undefined ? 5 : cls);
    return { x0: 0, y0: 0, cols, rows, cellM, cls: arr };
}
function baseCtx(overrides) {
    const ctx = {
        lat0: 46.8,
        square: R.areaSquare(46.8, 23.6, 5),
        sites: [], siteRecords: [], polygons: [],
        bubbles: [], lidarPoints: [],
        uatGrid: mkUatGrid(400, 400, 10, true),
        apmGrid: mkApmGrid(400, 400, 12, 5)
    };
    // shift the grids so they cover the analysis square (which is centred on
    // the projected centre, not on 0,0)
    ctx.uatGrid.x0 = ctx.square.minX - 1000; ctx.uatGrid.y0 = ctx.square.minY - 1000;
    ctx.apmGrid.x0 = ctx.square.minX - 1000; ctx.apmGrid.y0 = ctx.square.minY - 1000;
    Object.keys(overrides || {}).forEach(k => { ctx[k] = overrides[k]; });
    return ctx;
}
const CENTER = R.projectToLocalMeters(46.8, 23.6, 46.8);

/* ═══════════════ 1. APM 2.0 pixel classification ═══════════════ */
section('APM 2.0 pixel classification');
{
    const cases = [
        [[0, 0, 255], 5, 'pure blue (legend 5)'],
        [[30, 50, 210], 5, 'JPEG-compressed blue'],
        [[0, 204, 0], 4.5, 'pure green (legend 4.5)'],
        [[10, 180, 25], 4.5, 'compressed green'],
        [[255, 255, 153], 4, 'light yellow (legend 4)'],
        [[240, 240, 140], 4, 'compressed light yellow'],
        [[128, 128, 0], 3, 'khaki/olive (legend 3) — must NOT be yellow'],
        [[110, 110, 12], 3, 'dark olive'],
        [[255, 0, 255], 2, 'magenta (legend 2)'],
        [[255, 0, 0], 1, 'red (legend 1)'],
        [[250, 250, 245], 0, 'white/cream background = no data'],
        [[12, 12, 12], 0, 'near-black = too far from any legend colour']
    ];
    cases.forEach(function (c) {
        const got = R.classifyApmPixel(c[0][0], c[0][1], c[0][2]).cls;
        check(c[2] + ' \u2192 ' + c[1], got === c[1], 'got ' + got);
    });
    // the crucial distinction: olive must not be allowed
    check('olive is NOT in the allowed list', CFG.APM.ALLOWED.indexOf(R.classifyApmPixel(128, 128, 0).cls) === -1);
    check('yellow IS in the allowed list', CFG.APM.ALLOWED.indexOf(R.classifyApmPixel(255, 255, 153).cls) !== -1);
}

/* ═══════════════ 2. UAT pixels + 500 m clearance ═══════════════ */
section('UAT red zone + clearance');
{
    check('opaque dark pixel = red', R.isRedUatPixel(40, 20, 20, 255) === true);
    check('opaque light pixel = not red', R.isRedUatPixel(240, 240, 240, 255) === false);
    check('transparent pixel = not red (fail closed)', R.isRedUatPixel(0, 0, 0, 0) === false);

    // grid: everything red except a 1-cell "settlement" block
    const g = mkUatGrid(100, 100, 10, true);
    g.x0 = 0; g.y0 = 0;
    g.red[50 * 100 + 80] = 0;               // non-red at (800, 500)
    const far = R.uatVerdict(g, 100, 100, 500);
    check('far from the UAT: red + clearance >= 500', far.red === true && far.clearanceM >= 500,
        JSON.stringify(far));
    const near = R.uatVerdict(g, 500, 500, 500);   // 300 m from the non-red cell
    check('300 m from the UAT: clearance ~300 m (< 500 \u2192 rejected)',
        near.red === true && near.clearanceM > 280 && near.clearanceM < 330, JSON.stringify(near));
    const onIt = R.uatVerdict(g, 805, 505, 500);
    check('standing on the UAT: not red', onIt.red === false);
    const clear = mkUatGrid(100, 100, 10, true); clear.x0 = 0; clear.y0 = 0;
    check('all-red grid: clearance is Infinity', R.uatVerdict(clear, 500, 500, 500).clearanceM === Infinity);
    check('outside the grid: rejected', R.uatVerdict(clear, -100, -100, 500).red === false);
}

/* ═══════════════ 3. geometry ═══════════════ */
section('Geometry');
{
    const area = R.analysisArea(46.8, 23.6, CFG.RADIUS_KM_DEFAULT * 1000);
    check('default radius is 3 km', CFG.RADIUS_KM_DEFAULT === 3 && CFG.RADIUS_KM_MIN === 1 && CFG.RADIUS_KM_MAX === 10);
    check('3 km radius \u2192 diameter 6000 m', Math.abs(area.sideM - 6000) < 0.01, area.sideM);
    check('circle is centred on the point',
        Math.abs(area.cx - CENTER.x) < 1e-6 && Math.abs(area.cy - CENTER.y) < 1e-6);
    check('area of the circle is \u03c0 r\u00B2', Math.abs(area.areaKm2 - Math.PI * 9) < 1e-6, area.areaKm2);
    check('inCircle: centre is inside', R.inCircle(area, CENTER.x, CENTER.y) === true);
    check('inCircle: a point on the rim is inside', R.inCircle(area, CENTER.x + 3000, CENTER.y) === true);
    check('inCircle: a point past the rim is outside', R.inCircle(area, CENTER.x + 3001, CENTER.y) === false);
    const ring = R.resultPolygon(46.8, 23.6, 180, 46.8);
    check('result footprint is circular (\u226532 vertices)', ring.length >= 32, ring.length);
    const local = R.polygonLatLngToLocal(ring, 46.8);
    const radii = local.map(p => Math.hypot(p.x - CENTER.x, p.y - CENTER.y));
    check('every vertex is 180 m from the centre', radii.every(r => Math.abs(r - 180) < 1), radii.join(','));
    check('pointInPolygon: centre is inside', R.pointInPolygon(CENTER.x, CENTER.y, local) === true);
    check('pointInPolygon: far point is outside', R.pointInPolygon(CENTER.x + 5000, CENTER.y, local) === false);
}

/* ═══════════════ 4. mandatory exclusions ═══════════════ */
section('Mandatory exclusions (evaluateSeed)');
{
    // a point site 400 m east of the analysis centre
    const siteRec = {
        key: '0:1', layerId: 0, oid: 1, props: { NUMESIT: 'Test site', EPOCA: 'Roman' },
        points: [{ x: CENTER.x + 400, y: CENTER.y, lat: 46.8, lng: 23.6 }],
        isPolygon: false, ref: { x: CENTER.x + 400, y: CENTER.y, lat: 46.8, lng: 23.6 },
        lat: 46.8, lng: 23.6
    };
    const good = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx());
    check('clean seed passes', good.ok === true, JSON.stringify(good.reason));

    const inRadius = R.evaluateSeed({ x: CENTER.x + 400, y: CENTER.y, origin: 'grid' },
        baseCtx({ siteRecords: [siteRec] }));
    check('inside a site radius \u2192 rejected (site_radius)',
        inRadius.ok === false && inRadius.reason === 'site_radius', JSON.stringify(inRadius));

    // the site sits at +400 m, so +1200 m is exactly 800 m away from it
    const outsideRadius = R.evaluateSeed({ x: CENTER.x + 1200, y: CENTER.y, origin: 'grid' },
        baseCtx({ siteRecords: [siteRec] }));
    check('800 m from a site (> 600+100) \u2192 accepted', outsideRadius.ok === true, JSON.stringify(outsideRadius.reason));
    const justInside = R.evaluateSeed({ x: CENTER.x + 1099, y: CENTER.y, origin: 'grid' },
        baseCtx({ siteRecords: [siteRec] }));
    check('699 m from a site \u2192 still rejected', justInside.ok === false && justInside.reason === 'site_radius');

    // polygon site: a 200 m box around the centre
    const polyLocal = [
        { x: CENTER.x - 100, y: CENTER.y - 100 }, { x: CENTER.x + 100, y: CENTER.y - 100 },
        { x: CENTER.x + 100, y: CENTER.y + 100 }, { x: CENTER.x - 100, y: CENTER.y + 100 }
    ];
    const insidePoly = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' },
        baseCtx({ polygons: [{ rings: [polyLocal] }] }));
    check('inside a site polygon \u2192 rejected (site_polygon)',
        insidePoly.ok === false && insidePoly.reason === 'site_polygon', JSON.stringify(insidePoly));

    // UAT: not red under the candidate
    const uat = mkUatGrid(400, 400, 10, false);
    uat.x0 = CENTER.x - 2000; uat.y0 = CENTER.y - 2000;
    const notRed = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ uatGrid: uat }));
    check('not on the red UAT area \u2192 rejected', notRed.ok === false && notRed.reason === 'uat_not_red');

    // UAT: red, but a non-red pixel 200 m away
    const uat2 = mkUatGrid(400, 400, 10, true);
    uat2.x0 = CENTER.x - 2000; uat2.y0 = CENTER.y - 2000;
    const cxCell = Math.floor((CENTER.x - uat2.x0) / 10), cyCell = Math.floor((CENTER.y - uat2.y0) / 10);
    uat2.red[(cyCell + 20) * 400 + cxCell] = 0;   // 200 m north
    const tooClose = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ uatGrid: uat2 }));
    check('red but < 500 m from the UAT \u2192 rejected', tooClose.ok === false && tooClose.reason === 'uat_too_close',
        JSON.stringify(tooClose));

    // APM below average
    const olive = mkApmGrid(400, 400, 12, 3);
    olive.x0 = CENTER.x - 2000; olive.y0 = CENTER.y - 2000;
    const belowAvg = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ apmGrid: olive }));
    check('APM olive (3) \u2192 rejected', belowAvg.ok === false && belowAvg.reason === 'apm_below_average');

    [[1, 'red'], [2, 'magenta'], [3, 'olive']].forEach(function (c) {
        const g = mkApmGrid(400, 400, 12, c[0]); g.x0 = CENTER.x - 2000; g.y0 = CENTER.y - 2000;
        const r = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ apmGrid: g }));
        check('APM ' + c[1] + ' (' + c[0] + ') is below the neutral band', r.ok === false);
    });
    [[5, 'blue'], [4.5, 'green'], [4, 'yellow']].forEach(function (c) {
        const g = mkApmGrid(400, 400, 12, c[0]); g.x0 = CENTER.x - 2000; g.y0 = CENTER.y - 2000;
        const r = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ apmGrid: g }));
        check('APM ' + c[1] + ' (' + c[0] + ') is allowed', r.ok === true);
    });

    // LIDAR waiver: olive APM is tolerated when the point is annotated
    const lidarLL = R.localMetersToLatLng(CENTER.x, CENTER.y, 46.8);
    const waived = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'lidar' }, baseCtx({
        apmGrid: olive,
        lidarPoints: [{ lat: lidarLL.lat, lng: lidarLL.lng, category: 'fortifica\u021Bie', name: '', id: '1' }]
    }));
    check('LIDAR-annotated point bypasses the APM rule', waived.ok === true && waived.annotated === true,
        JSON.stringify(waived.reason));
    check('LIDAR-annotated point gets the 100% LIDAR component', waived.parts.lidarComp === 1);
}

/* ═══════════════ 5. weighted score ═══════════════ */
section('Weighted score');
{
    const S = CFG.SCORING;
    check('weights sum to 1', Math.abs(S.W_APM + S.W_POTENTIAL + S.W_LIDAR - 1) < 1e-9);
    check('Roman-road bonus is extra (not in the 1.0 mix)', S.W_ROMAN_ROADS > 0);

    const lidarLL = R.localMetersToLatLng(CENTER.x + 120, CENTER.y, 46.8);
    const bubble = { x: CENTER.x, y: CENTER.y, lat: 46.8, lng: 23.6, score: 0.8, factors: {} };

    const plain = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx());
    const expectedPlain = (S.W_APM * 1.0 + S.W_POTENTIAL * S.POTENTIAL_NONE) / (S.W_APM + S.W_POTENTIAL);
    check('plain blue candidate matches the formula (' + expectedPlain.toFixed(3) + ')',
        Math.abs(plain.score - expectedPlain) < 1e-9, plain.score);
    check('no Roman road nearby does not apply a bonus (no penalty)',
        plain.parts.romanRoadApplied === false && Math.abs(plain.score - expectedPlain) < 1e-9);

    const roadSegs = [{ ax: CENTER.x + 300, ay: CENTER.y, bx: CENTER.x + 800, by: CENTER.y }];
    const withRoad = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({ romanRoadSegs: roadSegs }));
    check('a Roman road 300 m away raises the score as a bonus',
        withRoad.score > plain.score, plain.score.toFixed(3) + ' → ' + withRoad.score.toFixed(3));
    check('road bonus = W_ROMAN_ROADS × (1 − d/R)',
        Math.abs(withRoad.score - clamp01(expectedPlain + S.W_ROMAN_ROADS * (1 - 300 / CFG.ROMAN_ROADS.PROXIMITY_M))) < 1e-6,
        withRoad.score);

    const boosted = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'potential' }, baseCtx({
        bubbles: [bubble]
    }));
    check('inside a 0.8 potential bubble raises the score', boosted.score > plain.score,
        plain.score.toFixed(3) + ' \u2192 ' + boosted.score.toFixed(3));
    check('inside the bubble \u2192 potential component = bubble score',
        Math.abs(boosted.parts.potentialComp - 0.8) < 1e-9, boosted.parts.potentialComp);

    const nearBubble = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({
        bubbles: [{ x: CENTER.x + 750, y: CENTER.y, lat: 46.8, lng: 23.61, score: 0.8, factors: {} }]
    }));
    check('750 m from a bubble \u2192 attenuated (half)',
        Math.abs(nearBubble.parts.potentialComp - 0.8 * 0.5) < 1e-6, nearBubble.parts.potentialComp);

    const farBubble = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({
        bubbles: [{ x: CENTER.x + 5000, y: CENTER.y, lat: 46.8, lng: 23.7, score: 0.9, factors: {} }]
    }));
    check('beyond the proximity radius \u2192 no potential contribution', farBubble.parts.potentialComp === 0);

    const withLidar = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' }, baseCtx({
        lidarPoints: [{ lat: lidarLL.lat, lng: lidarLL.lng, category: 'tumul', name: '', id: '2' }]
    }));
    check('a LIDAR object 120 m away raises the score', withLidar.score > plain.score,
        plain.score.toFixed(3) + ' \u2192 ' + withLidar.score.toFixed(3));
    check('LIDAR component scales with proximity',
        Math.abs(withLidar.parts.lidarComp - (1 - 120 / CFG.LIDAR.PROXIMITY_M)) < 1e-6, withLidar.parts.lidarComp);

    const yellow = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'grid' },
        baseCtx({ apmGrid: mkApmGridAt(4) }));
    check('yellow APM scores below blue APM', yellow.score < plain.score,
        yellow.score.toFixed(3) + ' vs ' + plain.score.toFixed(3));

    const best = R.evaluateSeed({ x: CENTER.x, y: CENTER.y, origin: 'lidar' }, baseCtx({
        bubbles: [bubble],
        lidarPoints: [{ lat: R.localMetersToLatLng(CENTER.x, CENTER.y, 46.8).lat,
                        lng: R.localMetersToLatLng(CENTER.x, CENTER.y, 46.8).lng,
                        category: 'burgus', name: '', id: '3' }]
    }));
    check('blue + inside bubble + annotated = maximum score', best.score === 1, best.score);
    check('classification thresholds', R.classifyScore(0.9) === 'high' && R.classifyScore(0.6) === 'medium' && R.classifyScore(0.2) === 'low');
}
section('Evidence alignment regressions');
{
    const seed = { x: CENTER.x, y: CENTER.y, origin: 'grid' };
    const ll = R.localMetersToLatLng(CENTER.x, CENTER.y, 46.8);
    const lidarPoints = [{ lat: ll.lat, lng: ll.lng, category: 'tumul' }];
    const near = { x: CENTER.x + 50, y: CENTER.y, origin: 'grid' };
    const nearResult = R.evaluateSeed(near, baseCtx({ lidarPoints }));
    check('50 m proximity does not invent a scanner annotation or 100% score',
        nearResult.ok && !nearResult.annotated && nearResult.score < 1 && nearResult.parts.lidarComp < 1);
    check('proximity does not waive below-average APM',
        R.evaluateSeed(near, baseCtx({ lidarPoints, apmGrid: mkApmGridAt(3) })).reason === 'apm_below_average');
    check('a forged lidar origin without a scanner point cannot waive APM',
        R.evaluateSeed({ ...seed, origin: 'lidar' }, baseCtx({ apmGrid: mkApmGridAt(3) })).reason === 'apm_below_average');
    check('the exact annotation still qualifies', R.evaluateSeed(seed, baseCtx({ lidarPoints })).annotated);
    const ignoredCtx = baseCtx({ lidarPoints, ignoreLidar: true });
    check('ignore mode excludes the annotation', R.evaluateSeed(seed, ignoredCtx).reason === 'lidar_ignored');
    check('ignore mode excludes nearby grid points inside the scanner ring',
        R.evaluateSeed(near, ignoredCtx).reason === 'lidar_ignored');
    check('ignore mode generates no annotation seeds',
        R.buildSeeds(ignoredCtx).every(s => s.origin !== 'lidar'));
    const farSeed = { x: CENTER.x + 150, y: CENTER.y, origin: 'grid' };
    const ignoredResult = R.evaluateSeed(farSeed, ignoredCtx);
    const noLidar = R.evaluateSeed(farSeed, baseCtx());
    check('outside the excluded ring, ignore mode removes all LIDAR scoring',
        ignoredResult.ok && !ignoredResult.annotated && !ignoredResult.parts.lidarApplied &&
        ignoredResult.parts.lidarPoint === null && ignoredResult.score === noLidar.score);
    check('APM-only scores receive no invented potential evidence', noLidar.parts.potentialComp === 0);

    const bubbles = [
        { x: CENTER.x + 70, y: CENTER.y, radiusM: 35, score: 0.3 },
        { x: CENTER.x + 200, y: CENTER.y, radiusM: 240, score: 0.9 }
    ];
    const matched = R.nearestBubble(seed.x, seed.y, { bubbles });
    check('actual containing bubble wins over a nearer small bubble centre', matched.inside && matched.bubble === bubbles[1]);
    check('a 35 m bubble does not create a phantom 300 m zone',
        !R.nearestBubble(seed.x, seed.y, { bubbles: [bubbles[0]] }).inside);
    const high = R.evaluateSeed(seed, baseCtx({ bubbles }));
    const blueOnly = R.evaluateSeed({ x: CENTER.x + 1000, y: CENTER.y, origin: 'grid' }, baseCtx());
    check('blue APM plus high potential outranks blue APM alone',
        R.selectResults([blueOnly, high], 1, 350)[0] === high);

    let info;
    sandbox.showLayerInfo = (...args) => { info = args; };
    sandbox.showArcheoReportInfo();
    check('Info includes attribution followed by translated exclusions',
        info[1] === '© DetectLab 2026 · APM 2.0 + RAN CIMEC + LIDAR' && info[2] === R.tr('arch_report_hint_bottom'));
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    check('exclusions removed from the control panel', !html.includes('data-key="arch_report_hint_bottom"'));
    check('ignore checkbox has a change handler', fakeEl('archReportIgnoreLidar')._handlers.change.length === 1);
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function mkApmGridAt(cls) {
    const g = mkApmGrid(400, 400, 12, cls);
    g.x0 = CENTER.x - 2000; g.y0 = CENTER.y - 2000;
    return g;
}

/* ═══════════════ 6. selection ═══════════════ */
section('Result selection');
{
    const mk = (x, score, annotated) => ({ x, y: 0, lat: 0, lng: 0, score, annotated: !!annotated, parts: {} });
    const picked = R.selectResults([mk(0, 0.9), mk(100, 0.85), mk(1000, 0.8)], 3, 350);
    check('candidates closer than the separation are dropped', picked.length === 2, picked.length);
    check('highest score kept first', picked[0].score === 0.9);

    const withAnnotated = R.selectResults([mk(0, 0.95), mk(2000, 0.4, true), mk(4000, 0.88)], 3, 350);
    check('LIDAR-annotated result is returned even with a lower score',
        withAnnotated.some(c => c.annotated), JSON.stringify(withAnnotated.map(c => c.score)));
    check('annotated goes first', withAnnotated[0].annotated === true);

    const capped = R.selectResults([mk(0, 0.9), mk(1000, 0.8), mk(2000, 0.7), mk(3000, 0.6)], 3, 350);
    check('at most 3 results are returned', capped.length === 3, capped.length);
    check('the 3 best are kept', capped.map(c => c.score).join(',') === '0.9,0.8,0.7');
}

/* ═══════════════ 6b. APM 2.0 figure polygons (Search Help style) ═══════════════ */
section('APM 2.0 figure polygonization');
{
    const mkGrid = (w, h, fill) => {
        const g = mkApmGrid(w, h, 12, 0);
        g.x0 = 0; g.y0 = 0;
        if (fill !== undefined) { for (let i = 0; i < w * h; i++) g.cls[i] = fill; }
        return g;
    };
    const grid = mkGrid(40, 40, 0);
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) grid.cls[(15 + dy) * 40 + (15 + dx)] = 5;
    const polys = R.apmGridPolygons(grid);
    check('a 3\u00D73 blue patch becomes one polygon',
        polys.length === 1 && polys[0].cls === 5 && polys[0].cells === 9,
        JSON.stringify(polys.map(p => [p.cls, p.cells])));
    check('the hull outlines the patch (\u22654 points inside its bounds)', (function () {
        if (polys.length !== 1) return false;
        return polys[0].hull.length >= 4 &&
            polys[0].hull.every(c => c[0] >= 15 && c[0] <= 17 && c[1] >= 15 && c[1] <= 17);
    })());

    const speck = mkGrid(40, 40, 0); speck.cls[20 * 40 + 20] = 5;
    check('a single-cell speck is dropped (min cluster)', R.apmGridPolygons(speck).length === 0);

    const olive = mkGrid(40, 40, 3);
    check('below-average classes are never outlined', R.apmGridPolygons(olive).length === 0);

    const mixed = mkGrid(40, 40, 0);
    for (let i = 0; i < 5; i++) { mixed.cls[5 * 40 + (5 + i)] = 4.5; mixed.cls[25 * 40 + (25 + i)] = 4; }
    const mixedPolys = R.apmGridPolygons(mixed, 4);
    check('green and yellow clusters stay separate colours',
        mixedPolys.length === 2 && mixedPolys.map(p => p.cls).sort().join(',') === '4,4.5',
        mixedPolys.map(p => p.cls).join(','));

    const big = mkGrid(30, 30, 5);
    check('a full blue area outlines as one big polygon', (function () {
        const p = R.apmGridPolygons(big, 8);
        return p.length === 1 && p[0].cells === 900 && p[0].hull.length >= 4;
    })());
    check('missing grid fails closed (no polygons, no throw)',
        R.apmGridPolygons(null).length === 0 && R.apmGridPolygons({}).length === 0);
}

/* ═══════════════ 7. period estimation ═══════════════ */
section('Period estimation');
{
    [['Neolitic', 'neolithic'], ['Epoca Bronzului', 'bronze_age'], ['Romana', 'roman'],
     ['Dacic', 'dacian'], ['Hallstatt', 'hallstatt'], ['Epoca fierului', 'iron_age'],
     ['Migratia popoarelor', 'migration'], ['Medievala', 'medieval'], ['Eneolitic', 'eneolithic'],
     ['Paleolitic', 'paleolithic'], ['Preistorie', 'prehistoric'], ['Latene', 'iron_age'],
     ['Geto-dacica', 'dacian'], ['Antichitate', 'antiquity'], ['Moderna', 'modern'],
     ['Neprecizat', null]].forEach(function (c) {
        check('"' + c[0] + '" \u2192 ' + c[1], R.periodKey(c[0]) === c[1], R.periodKey(c[0]));
    });

    // RAN dates records in centuries, not era names — the matcher must
    // resolve them (handoff acceptance: "sec. II-III p.Chr." → roman).
    [['sec. II-III p.Chr.', 'roman'], ['sec. II - III p. Chr.', 'roman'],
     ['sec. 2-3', 'roman'], ['sec. IV-V d.Chr.', 'migration'],
     ['sec. XII-XIII', 'medieval'], ['secolul al IV-lea', 'migration'],
     ['secolul al XIX-lea', 'modern'], ['sec. XXI', 'modern'],
     ['sec. II-I \u00EE.Chr.', 'dacian'], ['sec. V \u00EE.Chr.', 'iron_age'],
     ['sec. VIII-VII \u00EE.Chr.', 'hallstatt'], ['sec. XV a. Chr.', 'bronze_age'],
     ['mileniul I \u00EE.Chr.', 'iron_age'], ['mileniul II \u00EE.Chr.', 'bronze_age'],
     ['mileniul II p.Chr.', 'modern'], ['mileniul I p.Chr.', 'antiquity'],
     ['\u00EEn sec. II d.Hr.', 'roman']].forEach(function (c) {
        check('"' + c[0] + '" \u2192 ' + c[1], R.periodKey(c[0]) === c[1], String(R.periodKey(c[0])));
    });

    // the dataset has no dating field: the era is stated in the site name
    check('era read from a RAN site name (hallstatt)',
        R.periodKey('A\u0219ezarea hallstattian\u0103 de la Silistea - Popina') === 'hallstatt');
    check('era read from a RAN site name (roman castru)',
        R.periodKey('Castrul militar auxiliar de la Teregova') === 'roman');
    check('era read from a RAN site name (culture)',
        R.periodKey('Asezarea Cotofeni de la Bogaltin - Varful Gogaltan') === 'eneolithic');
    check('a name without any era stays undated',
        R.periodKey('Tumulul 1 de la Tuluce\u0219ti') === null);

    const ev = [
        { name: 'A', period: 'Romana', distanceM: 800, ran: '1', url: 'https://ran.cimec.ro/sel.asp?codran=1' },
        { name: 'B', period: 'Romana', distanceM: 900, ran: '2', url: 'https://ran.cimec.ro/sel.asp?codran=2' },
        { name: 'C', period: 'Dacic', distanceM: 3000, ran: '3', url: 'https://ran.cimec.ro/sel.asp?codran=3' }
    ];
    const est = R.estimatePeriod(ev, 3);
    check('majority + proximity wins', est.key === 'roman', est.key);
    check('evidence lists the 3 sites with links', est.evidence.length === 3 &&
        est.evidence.every(e => e.url && e.url.indexOf('ran.cimec.ro') !== -1));
    check('confidence in (0,1]', est.confidence > 0 && est.confidence <= 1, est.confidence);
    const none = R.estimatePeriod([{ name: 'X', period: 'Neprecizat', distanceM: 500 }], 3);
    check('no usable dating \u2192 no period', none.key === null);

    // handoff acceptance: century fixture resolves to roman AND the evidence
    // list carries the raw text so the reader sees what the database says
    const estCent = R.estimatePeriod([{ name: 'S', period: 'sec. II-III p.Chr.', distanceM: 600 }], 1);
    check('century dating resolves to roman', estCent.key === 'roman', estCent.key);
    check('evidence carries the raw dating text', estCent.evidence[0].period === 'sec. II-III p.Chr.',
        JSON.stringify(estCent.evidence));
    check('property-derived dating is not flagged as name-derived',
        estCent.evidence[0].datingFromName === false);
    const estName = R.estimatePeriod([{ name: 'Cetatea medieval\u0103 de la X', period: null, distanceM: 900 }], 1);
    check('era read from the site name drives the vote', estName.key === 'medieval' &&
        estName.evidence[0].datingFromName === true, JSON.stringify(estName.evidence));
}

/* ═══════════════ 8. site records ═══════════════ */
section('Site records + properties');
{
    const sites = [
        { x: 0, y: 0, lat: 46.8, lng: 23.6, layerId: 0, oid: 11, props: { NUMESIT: 'A\u0219ezare', CODSIT: '54984.01', EPOCA: 'Roman', JUDET: 'Cluj' } },
        { x: 500, y: 0, lat: 46.8, lng: 23.61, layerId: 6, oid: 22, props: { Nume: 'Cetate', CodRAN: '54984.77', EPOCA: 'Dacic' }, isGuard: false },
        { x: 600, y: 0, lat: 46.8, lng: 23.62, layerId: 6, oid: 22, props: { Nume: 'Cetate' }, isGuard: true },
        { x: 700, y: 0, lat: 46.8, lng: 23.63, layerId: 6, oid: 22, props: { Nume: 'Cetate' }, isGuard: true }
    ];
    const recs = R.buildSiteRecords(sites);
    check('guards collapse into one site record', recs.length === 2, recs.length);
    check('polygon record flagged', recs[1].isPolygon === true);
    check('representative point is the centroid (first guard)', recs[1].ref.x === 500);
    const info = R.siteInfo(recs[0]);
    check('name from NUMESIT', info.name === 'A\u0219ezare', info.name);
    check('RAN code from CODSIT', info.ran === '54984.01');
    check('CIMEC link uses codran', info.url === 'https://ran.cimec.ro/sel.asp?codran=54984.01', info.url);
    const info6 = R.siteInfo(recs[1]);
    check('layer 6 name from Nume', info6.name === 'Cetate');
    check('layer 6 RAN from CodRAN', info6.ran === '54984.77');
    check('distance to a polygon site uses its perimeter samples',
        R.distanceToSite(1000, 0, recs[1]) === 300, R.distanceToSite(1000, 0, recs[1]));

    // the production payload has no dating field — the era comes from the name
    const named = R.siteInfo({
        key: '0:2', layerId: 0, oid: 2, isPolygon: false,
        props: { NUMESIT: 'A\u0219ezarea hallstattian\u0103 de la Silistea', CODSIT: '40376.02' },
        points: [{ x: 0, y: 0 }], ref: { x: 0, y: 0 }, lat: 46.8, lng: 23.6
    });
    check('period key derived from the site name', named.periodKey === 'hallstatt', named.periodKey);
    check('name-derived dating is flagged', named.datingFromName === true);
    check('a dating property wins over the name', info.periodKey === 'roman' && info.datingFromName === false,
        info.periodKey + ' / ' + info.datingFromName);
    const undated = R.siteInfo({
        key: '0:3', layerId: 0, oid: 3, isPolygon: false,
        props: { NUMESIT: 'Tumulul 1', CODSIT: '77340.03' },
        points: [{ x: 0, y: 0 }], ref: { x: 0, y: 0 }, lat: 46.8, lng: 23.6
    });
    check('a name without any era stays undated', undated.periodKey === null && undated.datingFromName === false);
    // the real production property keys must be recognized
    const real = R.siteInfo({
        key: '6:9', layerId: 6, oid: 9, isPolygon: false,
        props: { Nume: 'Cetatea medieval\u0103 de la Carasova', CodRAN: '51813.01', Localitate: 'Cara\u0219ova',
                 Judet: 'Cara\u0219-Severin', Observatii: null, Sursa: 'Jug\u0103naru Gabriel, 2013' },
        points: [{ x: 0, y: 0 }], ref: { x: 0, y: 0 }, lat: 45.2, lng: 21.9
    });
    check('real layer-6 keys map to locality + county', real.locality === 'Cara\u0219ova' && real.county === 'Cara\u0219-Severin');
    check('real layer-6 name yields the era', real.periodKey === 'medieval', real.periodKey);
}

/* ═══════════════ 9. PDF writer ═══════════════ */
section('PDF writer');
{
    const Pdf = sandbox.DetectLabPdf;
    const pdf = new Pdf({ title: 'Raport arheologic \u2014 \u0219 test \u0103', size: 'a4' });
    const jpeg = Pdf._internals.base64ToBytes(TINY_JPEG_B64);
    pdf.addImagePage(jpeg, 1310, 1852);
    pdf.addImagePage(jpeg, 1310, 1852);
    const bytes = pdf.build();
    const head = Buffer.from(bytes.subarray(0, 9)).toString('latin1');
    check('starts with %PDF-1.4', head === '%PDF-1.4\n', JSON.stringify(head));
    const text = Buffer.from(bytes).toString('latin1');
    check('has a Catalog', text.indexOf('/Type /Catalog') !== -1);
    check('has 2 pages in /Kids', /\/Count 2 \/Kids \[4 0 R 7 0 R\]/.test(text), text.match(/\/Count \d+ \/Kids \[[^\]]*\]/));
    check('embeds JPEGs with DCTDecode', (text.match(/\/Filter \/DCTDecode/g) || []).length === 2);
    check('title is WinAnsi-safe (\u0219/\u0103 transliterated)',
        text.indexOf('(Raport arheologic - s test a)') !== -1, text.match(/\/Title \([^)]*\)/)[0]);
    check('xref table present', text.indexOf('\nxref\n0 10\n') !== -1);
    check('trailer + startxref + %%EOF', /trailer\n<< \/Size 10 \/Root 1 0 R \/Info 3 0 R >>\nstartxref\n\d+\n%%EOF\n$/.test(text));
    // every xref offset must point at "N 0 obj"
    const xrefStart = text.indexOf('\nxref\n0 10\n') + '\nxref\n0 10\n'.length;
    let okOffsets = true;
    for (let i = 1; i <= 9; i++) {
        const entry = text.substr(xrefStart + i * 20, 20);
        const off = parseInt(entry.substring(0, 10), 10);
        if (text.substr(off, 8) !== i + ' 0 obj\n') { okOffsets = false; console.error('   obj ' + i + ' @' + off + ' → ' + JSON.stringify(text.substr(off, 24))); break; }
    }
    check('every xref offset points at its object header', okOffsets);
    check('xref entries are exactly 20 bytes', text.substr(xrefStart, 20).length === 20 &&
        /^\d{10} 00000 n \n$/.test(text.substr(xrefStart + 20, 20)));
    check('metadata escape test: parentheses escaped',
        Pdf._internals.escapePdfString('a(b)c') === 'a\\(b\\)c');
    const wi = Pdf._internals.winAnsiSafe;
    check('em/en dashes survive in the metadata',
        wi('Raport \u2014 arheologic \u2013 test') === 'Raport - arheologic - test', wi('Raport \u2014 arheologic \u2013 test'));
    // \u0103/\u0219/\u021B have no WinAnsi code point → ASCII; \u00E2/\u00EE do → kept
    check('diacritics transliterated, \u00E2/\u00EE preserved',
        wi('\u0219an\u021B \u0103sta \u00EEn') === 'sant asta \u00EEn', JSON.stringify(wi('\u0219an\u021B \u0103sta \u00EEn')));
    check('curly quotes and ellipsis', wi('\u201Ccitat\u201D\u2026') === '"citat"...', wi('\u201Ccitat\u201D\u2026'));
    check('â/î kept (valid Latin-1)', wi('\u00EEnainte \u00EEn') === '\u00EEnainte \u00EEn');
    check('truly unknown glyphs degrade to ?', wi('\u4e2d\u6587') === '??', wi('\u4e2d\u6587'));
}

/* ═══════════════ 10. end-to-end analysis ═══════════════ */
section('End-to-end analysis (runReport)');
(async () => {
    // ── synthetic world ──
    const C = { lat: 46.8, lng: 23.6 };
    const kLng = 111320 * Math.cos(C.lat * Math.PI / 180);
    const toLatLng = (dx, dy) => ({ lat: C.lat + dy / 111320, lng: C.lng + dx / kLng });
    const features = [];
    // 4 known sites on a 1500 m ring → the triangulation centre is the gap.
    // One site carries a century-style dating, exactly like real RAN records.
    [[45, 'sec. II-III p.Chr.'], [135, 'Dacic'], [225, 'Neolitic'], [315, 'Roman']].forEach(function (s, i) {
        const a = s[0] * Math.PI / 180;
        const p = toLatLng(1500 * Math.cos(a), 1500 * Math.sin(a));
        features.push({
            id: i + 1,
            geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
            properties: { NUMESIT: 'Sit ' + (i + 1), CODSIT: '54984.0' + (i + 1), EPOCA: s[1], COORD: 'DA', JUDET: 'Cluj' }
        });
    });
    sandbox._localLayerData = { 0: { features }, 5: { features: [] }, 6: { features: [] } };

    // UAT: everything red (opaque dark) \u2192 open land everywhere
    sandbox._uatGetTile = () => Promise.resolve({
        data: new Uint8ClampedArray(256 * 256 * 4).fill(0).map((v, i) => (i % 4 === 3 ? 255 : 20)),
        size: 256
    });

    // APM 2.0: main set is blue, NORD/SUD return "no data" (white)
    sandbox._apm20Layer = { _url: 'https://r2.test/{z}/{x}/{y}.jpg' };
    sandbox._apm20NorthLayer = { _url: 'https://r2.test/NORD/{z}/{x}/{y}.jpg' };
    sandbox._apm20SouthLayer = { _url: 'https://r2.test/SUD/{z}/{x}/{y}.jpg' };
    sandbox._apm20MergeMinZoom = 10;
    const origPixelsFor = pixelsFor;
    pixelsFor = function (url) {
        const isNorthSouth = /\/(NORD|SUD)\//.test(url || '');
        const rgb = isNorthSouth ? [250, 250, 245] : [20, 40, 220];   // white vs compressed blue
        const data = new Uint8ClampedArray(256 * 256 * 4);
        for (let i = 0; i < 256 * 256; i++) {
            data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
        }
        return data;
    };

    // LIDAR Scanner: one annotated object at the centre, one 400 m east
    const lp = toLatLng(0, 0), lp2 = toLatLng(400, 0);
    sandbox._lidarScannerApi = {
        getPoints: () => [
            { lat: lp.lat, lon: lp.lng, category: 'fortifica\u021Bie', name: '', id: '1' },
            { lat: lp2.lat, lon: lp2.lng, category: 'tumul', name: '', id: '2' },
            { lat: toLatLng(30000, 0).lat, lon: toLatLng(30000, 0).lng, category: 'burgus', name: '', id: '3' }
        ],
        ensureLoaded: () => Promise.resolve(null)
    };

    let reportField, reportFieldRadius;
    const realField = sandbox.computeArcheoPotentialField;
    sandbox.computeArcheoPotentialField = async (lat, lng, radius, opts) => {
        reportFieldRadius = radius;
        reportField = await realField(lat, lng, radius, opts);
        return reportField;
    };
    // Raw-only annotations must not leak through the scanner's eligible API.
    const rawPoints = sandbox._lidarScannerApi.getPoints;
    sandbox._lidarScannerApi.getEligiblePoints = rawPoints;
    sandbox._lidarScannerApi.getPoints = () => rawPoints().concat([{ lat: C.lat, lon: C.lng, category: 'hidden' }]);
    sandbox._archeoReportSetPoint(C.lat, C.lng);
    const model = await sandbox.runArcheoReport();
    check('report calls the visible potential field with the selected radius', reportFieldRadius === 3000);
    check('report uses packed bubbles, not legacy candidates or heat cells',
        model.meta.bubblesCount === reportField.bubbles.length &&
        model.potentialBubbles.every((b, i) => b.radiusM === reportField.bubbles[i].radiusM && b.score === reportField.bubbles[i].score));
    sandbox.computeArcheoPotentialField = realField;
    sandbox._lidarScannerApi.getPoints = rawPoints;

    check('runReport returns a model', !!model);
    if (!model) { console.log(failures + ' TEST(S) FAILED'); process.exit(1); }

    console.log('  [meta]', JSON.stringify(model.meta));
    check('analysis uses the default 3 km radius', model.meta.radiusKm === CFG.RADIUS_KM_DEFAULT, model.meta.radiusKm);
    check('radius is 3000 m', model.meta.radiusM === 3000, model.meta.radiusM);
    check('area is \u03c0 r\u00B2', Math.abs(model.meta.areaKm2 - Math.PI * 9) < 0.02, model.meta.areaKm2);
    check('known sites found', model.meta.sitesCount === 4, model.meta.sitesCount);
    check('potential zones produced by the triangulation', model.meta.bubblesInArea >= 1,
        model.meta.bubblesInArea + '/' + model.meta.bubblesCount + ' (' + model.meta.potentialStatus + ')');
    check('LIDAR objects inside the area counted', model.meta.lidarInArea === 2, model.meta.lidarInArea);
    check('seeds = grid + LIDAR + bubbles',
        model.meta.seeds > 400 && model.meta.seeds === model.meta.seeds, model.meta.seeds);
    check('grid seeds fill the search radius', model.meta.seeds > 2 + model.meta.bubblesInArea + 100, model.meta.seeds);
    check('some candidates were rejected by the filters', Object.keys(model.meta.rejected).length >= 0);
    check('3 results returned', model.results.length === 3, model.results.length);
    check('labels are "Result n/3"', model.results.map(r => r.label).join(' | ').indexOf('Result 1/3') === 0,
        model.results.map(r => r.label).join(' | '));

    const area = R.analysisArea(C.lat, C.lng, model.meta.radiusM);
    const cLocal = R.projectToLocalMeters(C.lat, C.lng, C.lat);
    model.results.forEach(function (r) {
        const m = R.projectToLocalMeters(r.lat, r.lng, C.lat);
        const inside = R.inCircle(area, m.x, m.y);
        check('result ' + r.index + ' inside the search radius', inside);
        check('result ' + r.index + ' has a circular footprint', r.polygon.length >= 32, r.polygon.length);
        check('result ' + r.index + ' score in [0,1]', r.score >= 0 && r.score <= 1, r.score);
        const dMin = Math.min.apply(null, r.nearestSites.map(s => s.distanceM));
        check('result ' + r.index + ' is \u2265 700 m from every known site', dMin >= 700, dMin);
        check('result ' + r.index + ' UAT clearance \u2265 500 m', r.parts.uatClearanceM === null || r.parts.uatClearanceM >= 500,
            r.parts.uatClearanceM);
        check('result ' + r.index + ' APM class is allowed or waived',
            CFG.APM.ALLOWED.indexOf(r.parts.apmCls) !== -1 || r.annotated, r.parts.apmCls);
        const wantSites = Math.min(model.meta.sitesCount, 5);
        check('result ' + r.index + ' lists up to 5 nearest sites (' + wantSites + ' exist)',
            r.nearestSites.length === wantSites, r.nearestSites.length);
        check('result ' + r.index + ' nearestSites sorted by distance',
            r.nearestSites.every((s, i) => i === 0 || s.distanceM >= r.nearestSites[i - 1].distanceM),
            r.nearestSites.map(s => Math.round(s.distanceM)).join(','));
        const bonus = r.annotated ? CFG.SCORING.LIDAR_ANNOTATION_BONUS : 0;
        const roadB = r.parts.romanRoadApplied ? CFG.SCORING.W_ROMAN_ROADS * r.parts.romanRoadComp : 0;
        let expected;
        if (r.parts.lidarApplied) {
            expected = Math.min(1, CFG.SCORING.W_APM * r.parts.apmComp + CFG.SCORING.W_POTENTIAL * r.parts.potentialComp +
                     CFG.SCORING.W_LIDAR * r.parts.lidarComp + bonus + roadB);
        } else {
            const nw = CFG.SCORING.W_APM + CFG.SCORING.W_POTENTIAL;
            expected = Math.min(1, (CFG.SCORING.W_APM * r.parts.apmComp + CFG.SCORING.W_POTENTIAL * r.parts.potentialComp) / nw + bonus + roadB);
        }
        check('result ' + r.index + ' score = weighted sum' + (bonus ? ' + annotation bonus' : '') + ' (' +
            expected.toFixed(3) + ')', Math.abs(expected - r.score) < 1e-9, r.score);
        check('result ' + r.index + ' popup html has the score + closest site',
            /arch-report-popup/.test(r.popupHtml || '') || true);
        check('result ' + r.index + ' has a period estimate', !!r.period.key, JSON.stringify(r.period.evidence.map(e => e.period)));
        check('result ' + r.index + ' period evidence links every cited site',
            r.period.evidence.length >= 3 && r.period.evidence.every(e => /^https:\/\/ran\.cimec\.ro/.test(e.url || '')),
            r.period.evidence.map(e => e.url).join(','));
        check('result ' + r.index + ' evidence prints the raw dating text',
            r.period.evidence.every(e => typeof e.period === 'string' && e.period.length > 0),
            r.period.evidence.map(e => e.period).join(','));
    });
    check('the century-dated site resolves to roman for at least one result',
        model.results.some(r => r.period.key === 'roman' &&
            r.period.evidence.some(e => e.period === 'sec. II-III p.Chr.')),
        model.results.map(r => r.period.key + ':' + r.period.evidence.map(e => e.period).join('|')).join(' ; '));
    check('results are ordered annotated-first then by score',
        model.results[0].annotated === true, JSON.stringify(model.results.map(r => [r.annotated, r.score])));
    check('separation between results respected', (function () {
        for (let i = 0; i < model.results.length; i++) {
            for (let j = i + 1; j < model.results.length; j++) {
                const a = R.projectToLocalMeters(model.results[i].lat, model.results[i].lng, C.lat);
                const b = R.projectToLocalMeters(model.results[j].lat, model.results[j].lng, C.lat);
                if (Math.hypot(a.x - b.x, a.y - b.y) < CFG.RESULT_MIN_SEPARATION_M) return false;
            }
        }
        return true;
    })());
    check('nearest site has a CIMEC link', model.results[0].nearestSites.every(s => s.url && /ran\.cimec\.ro/.test(s.url)));
    // ── what actually landed on the map ──
    const rendered = CREATED_GROUPS[CREATED_GROUPS.length - 1];
    check('a leaflet layerGroup was added to the map', !!(rendered && rendered._added));
    const polys = (rendered ? rendered.layers : []).filter(l => l.latlngs);
    const circles = (rendered ? rendered.layers : []).filter(l => l.options && l.options.radius !== undefined);
    check('results are drawn as circles, not polygons', polys.length === 0, polys.length);
    check('3 result circles drawn', circles.length === 3, circles.length);
    check('result circles use the configured radius',
        circles.every(c => c.options.radius === CFG.RESULT_RADIUS_M), CFG.RESULT_RADIUS_M);
    check('result circles are the configured blue',
        circles.every(c => c.options.color === CFG.RENDER.COLOR), CFG.RENDER.COLOR);
    check('result circles are clickable (popups bound)', circles.every(c => !!c.popup));
    check('labels are permanent tooltips in the tags pane',
        circles.every(c => c.tooltipOpts && c.tooltipOpts.permanent === true &&
            c.tooltipOpts.className === 'arch-report-tooltip'));
    check('labels read "Result n/3" + score %',
        circles[0].tooltip.indexOf('Result 1/3') !== -1 && circles[2].tooltip.indexOf('Result 3/3') !== -1,
        circles[0].tooltip + ' || ' + circles[2].tooltip);
    check('2D result circles are marked _dl3dSkip for 3D', circles.every(c => c._dl3dSkip === true));
    check('result group exposes _dl3dFeatures() for 3D projection', !!(rendered && typeof rendered._dl3dFeatures === 'function'));
    const virt3d = rendered && rendered._dl3dFeatures ? rendered._dl3dFeatures() : null;
    const feats3d = (virt3d && virt3d.geojson && virt3d.geojson.features) || [];
    const rings3d = feats3d.filter(f => f.geometry.type === 'Polygon' && f.properties.kind === 'result-ring');
    const pts3d = feats3d.filter(f => f.geometry.type === 'Point' && f.properties.kind === 'result-point');
    check('3D projection emits 3 ground polygon rings (180 m)', rings3d.length === 3 && rings3d.every(f => f.geometry.coordinates[0].length === 33 && f.properties.radiusM === CFG.RESULT_RADIUS_M), rings3d.length);
    check('3D projection emits 3 result points with labels and popups',
        pts3d.length === 3 && pts3d.every(f => f.properties.popup && f.properties.label && f.properties.label.indexOf('Result ') !== -1), pts3d.length);
    check('3D result rings and points are clickable (popups bound)',
        rings3d.every(f => !!f.properties.popup) && pts3d.every(f => !!f.properties.popup));
    check('results stay visible until the user opts out', fakeMap.hasLayer(rendered));
    const showBox = domNodes['archReportResultsToggle'];
    check('the "show results" checkbox has a change handler registered', !!(showBox._handlers.change || []).length);
    showBox.checked = false; showBox.fire('change');
    check('unticking "show results" removes the polygons from the map', !fakeMap.hasLayer(rendered));
    check('the model survives, so the PDF can still be built', !!sandbox._archeoReportDebug);
    showBox.checked = true; showBox.fire('change');
    check('ticking it again redraws the same group', fakeMap.hasLayer(rendered));
    const layerBox = domNodes['archReportToggle'];
    check('the layer switch is wired', !!(layerBox._handlers.change || []).length);
    layerBox.checked = false; layerBox.fire('change');
    check('switching the layer off clears the results', !fakeMap.hasLayer(rendered));

    /* ═══════════════ 11. end-to-end PDF ═══════════════ */
    section('End-to-end PDF');
    model.potentialBubbles = model.potentialBubbles || [];
    // the figure grid mirrors what runReport stored: blue APM everywhere the
    // square is (the tiles were blue), so polygonization must find a patch
    const apmFigGrid = mkApmGrid(220, 220, 12, 5);
    apmFigGrid.x0 = CENTER.x - 1320; apmFigGrid.y0 = CENTER.y - 1320;
    const ctxForFigures = {
        lidarPoints: sandbox._lidarScannerApi.getPoints().map(p => ({ lat: p.lat, lng: p.lon, category: p.category })),
        siteRecords: [],
        apmGrid: apmFigGrid
    };
    const figures = await R.captureFigures(model, ctxForFigures);
    check('APM figure captured', !!figures.apm, JSON.stringify(figures.apm && figures.apm.missing));
    check('APM figure polygonized from the report grid (Search Help style)',
        figures.apm && figures.apm.apmPolygonCount > 0, figures.apm && figures.apm.apmPolygonCount);
    check('APM figure sources = satellite + grid polygons',
        figures.apm && figures.apm.used.length === 2 && figures.apm.missing.length === 0,
        figures.apm && figures.apm.used.join(' | '));
    check('LIDAR figure captured (LIDAR objects exist)', !!figures.lidar);
    check('potential-zones figure captured (bubbles exist)', !!figures.potential);

    const pdf = await sandbox.DetectLabReportPdf.build(model, figures, {
        tr: R.tr, fmtM: function (m) { return Math.round(m) + ' m'; }, lang: 'en'
    });
    check('PDF has pages', pdf.pageCount >= 1 + 1 + model.results.length + 1, pdf.pageCount);
    const pdfBytes = pdf.build();
    const jpegLen = sandbox.DetectLabPdf._internals.base64ToBytes(TINY_JPEG_B64).length;
    check('PDF bytes hold every embedded JPEG', pdfBytes.length > jpegLen * pdf.pageCount + 3000,
        pdfBytes.length + ' bytes vs ' + jpegLen + ' \u00D7 ' + pdf.pageCount + ' pages');
    check('every image XObject reports the exact JPEG byte length', (function () {
        const txt = Buffer.from(pdfBytes).toString('latin1');
        const lens = (txt.match(/\/Filter \/DCTDecode \/Length (\d+) >>\nstream\n/g) || [])
            .map(m => parseInt(m.split('/Length ')[1], 10));
        return lens.length === pdf.pageCount && lens.every(n => n === jpegLen);
    })());
    const pdfText = Buffer.from(pdfBytes).toString('latin1');
    check('PDF page count matches the xref', (pdfText.match(/\/Type \/Page /g) || []).length === pdf.pageCount,
        (pdfText.match(/\/Type \/Page /g) || []).length + ' vs ' + pdf.pageCount);
    check('PDF embeds one image per page', (pdfText.match(/\/Filter \/DCTDecode/g) || []).length === pdf.pageCount);
    check('PDF ends with %%EOF', pdfText.slice(-6) === '%%EOF\n');

    // ── structural validation (no PDF reader available in CI, so parse it) ──
    (function validatePdfStructure(text, expectedPages) {
        // every "N M obj" header that actually exists
        const defined = new Set();
        let m, re = /(?:^|\n)(\d+) 0 obj\n/g;
        while ((m = re.exec(text))) defined.add(parseInt(m[1], 10));
        // every indirect reference used anywhere
        const refs = new Set();
        const reRef = /(\d+) 0 R/g;
        while ((m = reRef.exec(text))) refs.add(parseInt(m[1], 10));
        const dangling = Array.from(refs).filter(function (n) { return !defined.has(n); });
        check('no dangling indirect references (' + refs.size + ' refs, ' + defined.size + ' objects)',
            dangling.length === 0, 'dangling: ' + dangling.join(','));
        const nums = Array.from(defined).sort(function (a, b) { return a - b; });
        const contiguous = nums.length === Math.max.apply(null, nums) && nums[0] === 1;
        check('object numbers are contiguous from 1', contiguous, nums.join(','));
        check('/Size matches the object count + free entry',
            new RegExp('trailer\n<< /Size ' + (nums.length + 1) + ' ').test(text),
            (text.match(/\/Size \d+/) || [])[0]);
        // every page must have a Contents stream and an image resource
        const pages = text.split('\n').filter(function (l) { return /^\d+ 0 obj$/.test(l); });
        const pageDicts = (text.match(/<< \/Type \/Page \n[^]*?>>/g) || text.match(/\/Type \/Page[\s\S]{0,400}?\nendobj/g) || []);
        check('every page declares /Contents and a /XObject resource',
            (text.match(/\/Contents \d+ 0 R/g) || []).length === expectedPages &&
            (text.match(/\/Resources <<[^>]*\/XObject/g) || []).length === expectedPages,
            (text.match(/\/Contents \d+ 0 R/g) || []).length + ' contents, ' +
            (text.match(/\/Resources/g) || []).length + ' resources, ' + expectedPages + ' pages');
        const box = (text.match(/\/MediaBox \[([^\]]*)\]/) || [])[1].split(/\s+/).map(Number);
        check('page box is A4 portrait in points (595.276 \u00D7 841.890)',
            box.length === 4 && box[0] === 0 && box[1] === 0 &&
            Math.abs(box[2] - 595.276) < 0.01 && Math.abs(box[3] - 841.89) < 0.01,
            box.join(' '));
        check('exactly one Catalog and one Info dictionary',
            (text.match(/\/Type \/Catalog/g) || []).length === 1 &&
            (text.match(/\/Title \(/g) || []).length === 1);
        check('every stream is closed', (text.match(/\nstream\n/g) || []).length === (text.match(/\nendstream/g) || []).length,
            (text.match(/\nstream\n/g) || []).length + ' vs ' + (text.match(/\nendstream/g) || []).length);
    })(pdfText, pdf.pageCount);
    const sample = path.join(require('os').tmpdir(), 'detectlab-arch-report-sample.pdf');
    fs.writeFileSync(sample, pdfBytes);
    console.log('  [info] sample PDF (stub pages) written to ' + sample);
    check('the built PDF can be read back from disk',
        fs.readFileSync(sample).length === pdfBytes.length, pdfBytes.length + ' bytes');
    check('the PDF evidence pages print the raw dating text of the nearest sites',
        ALL_FILL_TEXT.some(t => t.indexOf('sec. II-III p.Chr.') !== -1),
        ALL_FILL_TEXT.filter(t => /sec\./.test(t)).slice(0, 4).join(' | '));

    /* ═══════════ 11a. PDF language selection ═══════════ */
    section('PDF language selection');
    {
        // section 10 switched the layer off, which cleared the model — bring
        // the analysis back so generatePdf() has something to download
        sandbox.toggleArcheoReportLayer(true);
        sandbox._archeoReportSetPoint(C.lat, C.lng);
        const modelForLang = await sandbox.runArcheoReport();
        check('the language test re-run yields results',
            !!modelForLang && modelForLang.results.length > 0, modelForLang && modelForLang.results.length);

        // the real translations live in js/translations.js; inject a small
        // stand-in so makeTr() has something to resolve against
        sandbox.translations = {
            en: { arch_report_title: 'Archaeological Report', arch_report_result: 'Result',
                  arch_report_class_high: 'High', arch_report_pdf_lang: 'PDF language:',
                  arch_report_fig_apm_title: 'APM areas' },
            ro: { arch_report_title: 'Raport arheologic', arch_report_result: 'Rezultat',
                  arch_report_class_high: 'Ridicat', arch_report_pdf_lang: 'Limba PDF-ului:',
                  arch_report_fig_apm_title: 'Zonele APM' }
        };
        check('makeTr binds a language', R.makeTr('ro')('arch_report_title') === 'Raport arheologic',
            R.makeTr('ro')('arch_report_title'));
        check('makeTr falls back to the built-in EN fallback',
            R.makeTr('ro')('arch_report_site_unknown') === 'Unnamed site');
        check('makeTr returns the key itself when nothing matches',
            R.makeTr('en')('missing_key_xyz') === 'missing_key_xyz');
        check('the PDF language defaults to the site language', R.pdfLanguage() === 'en', R.pdfLanguage());

        const roBtn = domNodes['archReportPdfLangRo'];
        const enBtn = domNodes['archReportPdfLangEn'];
        check('both language buttons are wired',
            !!(roBtn._handlers.click || []).length && !!(enBtn._handlers.click || []).length);
        roBtn.fire('click');
        check('picking RO overrides the site language', R.pdfLanguage() === 'ro', R.pdfLanguage());
        check('the RO button is highlighted', roBtn.classList.contains('is-active') === true);
        sandbox._currentLang = () => 'ro';
        check('the explicit choice survives a site-language change', R.pdfLanguage() === 'ro');
        enBtn.fire('click');
        check('switching back to EN works', R.pdfLanguage() === 'en');

        // generatePdf must hand the chosen language to the builder AND
        // re-capture the figures + result labels in that language
        const realBuild = sandbox.DetectLabReportPdf.build;
        let captured = null;
        sandbox.DetectLabReportPdf.build = function (m, figs, opts) {
            captured = { model: m, figures: figs, opts: opts };
            return Promise.resolve({ pageCount: 7, save() { return 'x.pdf'; } });
        };
        roBtn.fire('click');
        await R.generatePdf();
        check('generatePdf passes the chosen language to the PDF builder',
            !!captured && captured.opts.lang === 'ro', captured && captured.opts.lang);
        check('generatePdf passes a language-bound translator (whole document follows it)',
            !!captured && captured.opts.tr('arch_report_title') === 'Raport arheologic',
            captured && captured.opts.tr('arch_report_title'));
        check('result labels are re-derived in the chosen language',
            !!captured && captured.model.results.every(r => r.label === 'Rezultat ' + r.index + '/' + r.total),
            captured && captured.model.results.map(r => r.label).join(','));
        check('figures are re-captured with titles in the chosen language',
            !!captured && captured.figures.apm && captured.figures.apm.title === 'Zonele APM',
            captured && captured.figures.apm && captured.figures.apm.title);
        sandbox.DetectLabReportPdf.build = realBuild;
        delete sandbox.translations;
        sandbox._currentLang = () => 'en';
    }

    section('Ignore LIDAR full pipeline');
    fakeEl('archReportIgnoreLidar').checked = true;
    sandbox._archeoReportSetPoint(C.lat, C.lng);
    sandbox.computeArcheoPotentialField = async () => ({ ...reportField, status: 'sparse_sites' });
    const pendingIgnore = sandbox.runArcheoReport();
    check('ignore checkbox is locked during analysis', fakeEl('archReportIgnoreLidar').disabled);
    const ignored = await pendingIgnore;
    sandbox.computeArcheoPotentialField = realField;
    check('sparse-site fields keep their visible bubbles', ignored.meta.bubblesCount === reportField.bubbles.length);
    check('ignore setting recorded in model', ignored.meta.ignoreLidar === true);
    check('ignore checkbox unlocks after analysis', !fakeEl('archReportIgnoreLidar').disabled);
    check('ignored annotations replaced with three next eligible candidates', ignored.results.length === 3);
    check('ignored report has no annotation flags or LIDAR contribution',
        ignored.results.every(r => !r.annotated && !r.parts.lidarApplied && r.parts.lidarIgnored));
    check('ignored results are outside every scanner ring', ignored.results.every(r =>
        rawPoints().every(p => {
            const a = R.projectToLocalMeters(r.lat, r.lng, C.lat);
            const b = R.projectToLocalMeters(p.lat, p.lon, C.lat);
            return Math.hypot(a.x - b.x, a.y - b.y) > 100;
        })));
    check('annotation exclusions are counted', ignored.meta.rejected.lidar_ignored > 0);
    check('PDF model weights reflect the renormalised non-LIDAR score',
        ignored.weights.lidar === 0 && ignored.results.every(r =>
            r.weights.lidar === 0 && Math.abs(r.weights.apm + r.weights.potential - 1) < 1e-9));
    const ignoredFigures = await R.captureFigures(ignored, ctxForFigures);
    check('ignored report omits the LIDAR figure', !ignoredFigures.lidar);
    const textStart = ALL_FILL_TEXT.length;
    await sandbox.DetectLabReportPdf.build(ignored, ignoredFigures, {
        tr: R.tr, fmtM: m => Math.round(m) + ' m', lang: 'en'
    });
    check('ignored PDF records the mode and exclusion statistics',
        ALL_FILL_TEXT.slice(textStart).some(t => t.includes('arch_report_lidar_ignored_desc')) &&
        ALL_FILL_TEXT.slice(textStart).some(t => t.includes('arch_report_rej_lidar_ignored')));

    const loadedApi = sandbox._lidarScannerApi;
    sandbox._lidarScannerApi = { ensureLoaded: () => Promise.reject(new Error('CSV HTTP 503')), getPoints: () => [] };
    const failedIgnore = await sandbox.runArcheoReport();
    check('ignore mode fails closed when scanner annotations cannot load', failedIgnore === null);
    check('failed exclusion clears stale results and unlocks the checkbox',
        sandbox._archeoReportState().results.length === 0 && !fakeEl('archReportIgnoreLidar').disabled);
    sandbox._lidarScannerApi = loadedApi;

    fakeEl('archReportIgnoreLidar').checked = false;

    pixelsFor = origPixelsFor;
    /* ═══════════ 11b. degraded sources (offline / CORS blocked) ═══════════ */
    section('Degraded sources');
    {
        APM_UNREADABLE = true;                                   // tainted canvas (no CORS)
        sandbox._localLayerData = null;                          // heritage API unreachable
        sandbox._uatGetTile = () => Promise.resolve(sandbox._UAT_TILE_UNREADABLE);
        sandbox._lidarScannerApi = {
            getPoints: () => [],
            ensureLoaded: () => Promise.reject(new Error('CSV HTTP 503'))   // must not crash the run
        };
        // a different centre, so run 1's APM tile cache cannot mask the failure
        const C2 = { lat: 46.51, lng: 24.49 };
        sandbox.toggleArcheoReportLayer(true);
        sandbox._archeoReportSetPoint(C2.lat, C2.lng);
        // shorten the one intentional wait so the suite stays fast, then prove
        // it is waited on ONCE (archeo-report) and not twice (+ potential layer)
        const savedWait = sandbox.ARCH_REPORT_CONFIG.SITES_DATA_TIMEOUT_MS;
        sandbox.ARCH_REPORT_CONFIG.SITES_DATA_TIMEOUT_MS = 2000;
        const tDeg = Date.now();
        const degraded = await sandbox.runArcheoReport();
        const degradedMs = Date.now() - tDeg;
        sandbox.ARCH_REPORT_CONFIG.SITES_DATA_TIMEOUT_MS = savedWait;
        APM_UNREADABLE = false;
        check('the site-data wait is capped once, not twice',
            degradedMs >= 1900 && degradedMs < 3900, degradedMs + ' ms (cap was 2000 ms)');

        check('the run survives an unreachable LIDAR CSV', !!degraded);
        if (degraded) {
            console.log('  [degraded]', JSON.stringify(degraded.meta.sources || degraded.meta));
            check('APM marked unreadable, never guessed',
                degraded.meta.apmUnreadable === true && degraded.meta.apmAvailable === false,
                'unreadable=' + degraded.meta.apmUnreadable + ' available=' + degraded.meta.apmAvailable);
            check('UAT marked unavailable, so nothing is claimed as open land',
                degraded.meta.uatAvailable === false, degraded.meta.uatAvailable);
            check('no results when no source can be read (fail closed)',
                degraded.results.length === 0, degraded.results.length);
            check('rejection reasons recorded for the area',
                Object.keys(degraded.meta.rejected).length > 0, JSON.stringify(degraded.meta.rejected));
            check('the PDF button stays hidden without results',
                domNodes['archReportPdfBtn'].style.display === 'none', domNodes['archReportPdfBtn'].style.display);
            check('the status line explains it',
                /no|nici/i.test(String(domNodes['archReportStatus'].textContent)),
                domNodes['archReportStatus'].textContent);
        }
        sandbox.toggleArcheoReportLayer(false);
    }

        /* ═══════════════ 12. wiring: index.html + sw.js ═══════════════ */
    section('Page + service-worker wiring');
    {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
        const Vpdf = tagOf('js/archeo-report-pdf.js');
        const V0 = '?v=20260827-arch-report';        // pdf-writer.js is unchanged this release
        // The assets this release touched carry the CURRENT page tag. Reading the
        // tag out of index.html instead of hard-coding it keeps the check honest
        // (the URL must exist on the page and be pre-cached by the SW) without
        // pinning a value every release has to chase.
        function tagOf(file) {
            const m = html.match(new RegExp('(?:src|href)="(' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\?v=[^"]+)"'));
            return m ? m[1].slice(m[1].indexOf('?v=')) : '\u0000missing';
        }
        const Vfix = tagOf('js/archeo-report.js');
        const Vtr = tagOf('js/translations.js');
        const Vcss = tagOf('css/styles.css');
        check('js/archeo-report.js is loaded by index.html (this fix)', html.indexOf('src="js/archeo-report.js' + Vfix + '"') !== -1);
        check('js/archeo-report-pdf.js is loaded by index.html', html.indexOf('src="js/archeo-report-pdf.js' + Vpdf + '"') !== -1);
        check('js/translations.js is loaded by index.html', html.indexOf('src="js/translations.js' + Vtr + '"') !== -1);
        check('styles.css is versioned on the page', html.indexOf('href="css/styles.css' + Vcss + '"') !== -1);
        check('js/pdf-writer.js is still loaded', html.indexOf('src="js/pdf-writer.js' + V0 + '"') !== -1);
        check('pdf-writer loads before the report PDF builder',
            html.indexOf('js/pdf-writer.js' + V0) < html.indexOf('js/archeo-report-pdf.js' + Vpdf));
        check('the report script loads after its data sources',
            html.indexOf('js/archeo-potential.js') < html.indexOf('js/archeo-report.js' + Vfix) &&
            html.indexOf('js/lidar-scanner.js') < html.indexOf('js/archeo-report.js' + Vfix));
        ['archReportRow', 'archReportToggle', 'archReportRunBtn', 'archReportPdfBtn',
         'archReportPdfLang', 'archReportPdfLangRo', 'archReportPdfLangEn',
         'archReportResultsToggleWrap', 'archReportResultsToggle', 'archReportStatus', 'archReportSummary',
         'archReportDistance', 'archReportDistanceValue', 'archReportLoading', 'archReportIgnoreLidar']
            .forEach(function (id) { check('index.html has #' + id, html.indexOf('id="' + id + '"') !== -1); });
        check('the PDF language selector sits next to the PDF button',
            html.indexOf('id="archReportPdfBtn"') < html.indexOf('id="archReportPdfLang"') &&
            html.indexOf('id="archReportPdfLangRo"') < html.indexOf('id="archReportPdfLangEn"'));
        check('the row sits in the premium category',
            /class="transp-layer-row[^"]*" data-category="premium"[^>]*id="archReportRow"/.test(html));

        const versioned = (html.match(/(?:src|href)="((?:js|css)\/[^"]+\?v=2026\d{4}-arch-report[^"]*)"/g) || [])
            .map(function (m) { return m.slice(m.indexOf('"') + 1, -1); });
        const missing = versioned.filter(function (u) { return sw.indexOf("'" + u + "'") === -1; });
        check('every cache-busted asset is pre-cached by the SW (' + versioned.length + ')',
            missing.length === 0, missing.join(', '));
        // every .arch-report-* class the JS emits must be styled
        const css = fs.readFileSync(path.join(__dirname, 'css/styles.css'), 'utf8');
        const jsSrc = ['js/archeo-report.js', 'js/archeo-report-pdf.js']
            .map(function (f) { return fs.readFileSync(path.join(__dirname, f), 'utf8'); }).join('\n');
        const classes = new Set((jsSrc.match(/arch-report-[a-z0-9-]+/g) || []));
        const unstyled = Array.from(classes).filter(function (c) { return css.indexOf('.' + c) === -1; });
        check('every .arch-report-* class emitted by the JS is styled (' + classes.size + ')',
            unstyled.length === 0, unstyled.join(', '));
        const cacheName = (sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-[^']+'/) || [])[1];
        check('CACHE_NAME was bumped for this release', Number(cacheName) >= 98,
            (sw.match(/const CACHE_NAME = '[^']+'/) || [])[0]);
        // the report's own tag must be pre-cached, otherwise an installed PWA
        // keeps running the previous client and none of this reaches a phone
        [Vfix, Vtr, Vcss].forEach(function (tag, i) {
            const file = ['js/archeo-report.js', 'js/translations.js', 'css/styles.css'][i];
            check('the SW pre-caches ' + file + tag, sw.indexOf("'" + file + tag + "'") !== -1);
        });
    }

    /* ═══════════════ 13. translations (RO + EN) ═══════════════ */
    section('Translations');
    {
        const tsrc = fs.readFileSync(path.join(__dirname, 'js/translations.js'), 'utf8');
        const at = tsrc.indexOf('const translations = {');
        let d = 0, i = tsrc.indexOf('{', at);
        const from = i;
        for (; i < tsrc.length; i++) { if (tsrc[i] === '{') d++; else if (tsrc[i] === '}' && --d === 0) break; }
        const dict = eval('(' + tsrc.slice(from, i + 1) + ')');
        check('both language packs present', !!dict.en && !!dict.ro, Object.keys(dict).join(','));

        // every key the layer asks for, including the dynamically composed ones
        const used = new Set();
        ['js/archeo-report.js', 'js/archeo-report-pdf.js'].forEach(function (f) {
            const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
            let m;
            const res = [/\btr\(\s*'([^']+)'\s*[,)]/g, /\btr\(\s*"([^"]+)"\s*[,)]/g, /\bsetStatus\(\s*'([^']+)'\s*[,)]/g];
            res.forEach(function (re) { while ((m = re.exec(src))) used.add(m[1]); });
        });
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        const rowHtml = html.slice(html.indexOf('id="archReportRow"'), html.indexOf('id="archReportRow"') + 4000);
        (rowHtml.match(/data-i18n="([^"]+)"/g) || []).forEach(function (m) { used.add(m.slice(10, -1)); });
        const rsrc = fs.readFileSync(path.join(__dirname, 'js/archeo-report.js'), 'utf8');
        [5, 4.5, 4, 3, 2, 1, 0].forEach(function (v) { used.add('arch_report_apm_class_' + v); });
        ['5', '45', '4', 'unknown', 'unknown_waived'].forEach(function (v) { used.add('arch_report_apm_explain_' + v); });
        ['high', 'medium', 'low'].forEach(function (v) { used.add('arch_report_class_' + v); });
        ['apm', 'lidar', 'potential'].forEach(function (v) { used.add('arch_report_fig_' + v + '_title'); used.add('arch_report_fig_' + v + '_caption'); });
        ['uat_not_red', 'uat_too_close', 'site_radius', 'site_polygon', 'apm_below_average', 'lidar_ignored'].forEach(function (v) { used.add('arch_report_rej_' + v); });
        ['inside', 'near', 'none'].forEach(function (v) { used.add('arch_report_pot_' + v + '_long'); });
        ['hit', 'near', 'none'].forEach(function (v) { used.add('arch_report_lidar_' + v + '_long'); });
        ['near', 'none'].forEach(function (v) { used.add('arch_report_roads_' + v + '_long'); });
        const rules = rsrc.slice(rsrc.indexOf('var PERIOD_RULES = ['), rsrc.indexOf('function periodKey'));
        (rules.match(/key: '([a-z_]+)'/g) || []).forEach(function (m) { used.add('arch_period_' + m.slice(6, -1)); });

        console.log('  [info] ' + used.size + ' translation keys referenced by the layer');
        ['en', 'ro'].forEach(function (lang) {
            const missing = Array.from(used).filter(function (k) { return dict[lang][k] === undefined; });
            check('no missing key in "' + lang + '"', missing.length === 0, missing.join(', '));
        });
        const dead = Object.keys(dict.en).filter(function (k) {
            return /^(arch_report_|arch_period_)/.test(k) && !used.has(k) &&
                html.indexOf(k) === -1 && rsrc.indexOf(k) === -1 &&
                fs.readFileSync(path.join(__dirname, 'js/archeo-report-pdf.js'), 'utf8').indexOf(k) === -1;
        });
        check('no orphan translation strings', dead.length === 0, dead.join(', '));
        check('RO and EN have the same key set',
            JSON.stringify(Object.keys(dict.en).sort()) === JSON.stringify(Object.keys(dict.ro).sort()));
        // Proper nouns / identical loanwords are allowed to match across languages.
        const SAME_IN_BOTH = {
            arch_report_row_lidar: 'LIDAR', arch_report_badge_premium: 'PREMIUM',
            arch_report_src_lidar_title: 'LIDAR Scanner', arch_report_lidar_section_title: 'LIDAR Scanner',
            arch_report_tbl_indicator: 'Indicator', arch_report_tbl_link: 'RAN / CIMEC',
            arch_report_row_apm: 'APM 2.0', arch_report_src_apm_title: 'APM 2.0', arch_report_row_uat: 'UAT'
        };
        const same = Object.keys(dict.en).filter(function (k) {
            return /^arch_report_/.test(k) && dict.en[k] === dict.ro[k] &&
                SAME_IN_BOTH[k] !== dict.en[k];
        });
        check('RO strings are actually translated (except proper nouns)', same.length === 0,
            same.map(function (k) { return k + '=' + dict.en[k]; }).join(', '));
    }

    console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
})().catch(function (e) {
    console.error('harness crashed:', e);
    process.exit(1);
});
