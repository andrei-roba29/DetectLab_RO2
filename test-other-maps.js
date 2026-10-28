#!/usr/bin/env node
'use strict';

/* Behavioural checks for the “Alte hărți / Other maps” sub-layer.
 *
 * Run with:  node test-other-maps.js
 *
 * Covers, without touching the network:
 *   1. js/other-maps-tiles.js  — the Hungaricana ECW tile hash (both readings
 *      of dezoomify's note), the pyramid level maths and the URL builders;
 *   2. js/other-maps-overlay.js — the pure transform maths: pyramid level
 *      choice, on-screen size and the inverse transform that decides which
 *      tiles to fetch for a rotated, scaled, moved sheet;
 *   3. data/other-maps-catalog.json — every record is usable;
 *   4. the clustering contract: the dots must group EXACTLY like the
 *      Patrimoniu sites (same helper, same config, same distances);
 *   5. js/other-maps.js — a group of sheets on one place opens the list, a
 *      group spread over the map zooms in instead;
 *   6. the overlay manager against a fake map + mini DOM — a fresh sheet is
 *      framed into the viewport, zooming in keeps the old tiles as a stand-in
 *      until the finer level loads (and the fallback retires it), zooming out
 *      refetches the coarser level, reset/ remove clean up.
 *   7. js/other-maps-nls.js — NLS Map Finder IIIF region URLs, info.json
 *      parsing, the WFS query/feature mapping, the committed NLS seed
 *      catalogue, the multi-source dispatcher and an NLS sheet driven
 *      through the same overlay manager (sections 10–14).
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let checks = 0;
function ok(condition, message) {
    assert.ok(condition, message);
    checks++;
}
function eq(actual, expected, message) {
    assert.strictEqual(actual, expected, message);
    checks++;
}

/* ── sandbox ─────────────────────────────────────────────────────────── */
function storageStub(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k)
    };
}

/* The browser's WebCrypto, backed by node's crypto, so the module under test
 * runs the very same AES-128-CBC call it will run in the page. */
function webCryptoStub() {
    return {
        subtle: {
            importKey: (format, key, algorithm, extractable, usages) =>
                Promise.resolve({ format, key, algorithm, usages }),
            encrypt: (algorithm, key, data) => {
                const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key.key), Buffer.alloc(16));
                return Promise.resolve(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
            }
        }
    };
}

/* ── mini DOM + manual timers (for the manager simulation, §6) ───────── */
/* Timers never fire on their own: the test flushes them explicitly, so the
 * stand-in's 6 s fallback is exercised on demand and node never waits. */
const pendingTimers = new Map();
let nextTimerId = 1;
function flushTimers() {
    const list = Array.from(pendingTimers.values());
    pendingTimers.clear();
    list.forEach((timer) => timer.fn());
}

function fakeEl(tag) {
    const el = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        className: '',
        style: {},
        attributes: Object.create(null),
        children: [],
        parentNode: null,
        listeners: Object.create(null),
        appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
        removeChild(child) {
            const i = el.children.indexOf(child);
            if (i >= 0) el.children.splice(i, 1);
            child.parentNode = null;
            return child;
        },
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn);
        },
        dispatch(type) { (el.listeners[type] || []).slice().forEach((fn) => fn({ type })); },
        getAttribute(name) { return el.attributes[name] == null ? null : el.attributes[name]; },
        setAttribute(name, value) { el.attributes[name] = String(value); },
        /* The panel markup is a string, so a real selector is not needed:
         * hand back a fresh element for `ensurePanel`'s listener wiring. */
        querySelector: () => fakeEl('div'),
        querySelectorAll: () => [],
        matches: () => false,
        setPointerCapture: () => {},
        getContext: () => (el._ctx2d = el._ctx2d || {
            clearRect: () => {}, save: () => {}, restore: () => {}, translate: () => {},
            beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, fillText: () => {},
            lineWidth: 0, globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '',
            textAlign: '', textBaseline: ''
        })
    };
    el.classList = {
        _set: new Set(),
        add(c) { el.classList._set.add(c); },
        remove(c) { el.classList._set.delete(c); },
        toggle(c, on) {
            const should = (on == null) ? !el.classList._set.has(c) : !!on;
            if (should) el.classList._set.add(c);
            else el.classList._set.delete(c);
        },
        contains(c) { return el.classList._set.has(c); }
    };
    return el;
}

/* A Leaflet stand-in: the anchor is pinned to the centre of a 400×800
 * viewport, layer points are identity, and the test drives zooms by
 * rewriting `_state.zoom` and firing 'zoomend'. */
function fakeMap(initial) {
    const state = Object.assign({}, initial);
    const panes = Object.create(null);
    const events = Object.create(null);
    const container = fakeEl('div');
    return {
        _animatingZoom: false,
        _state: state,
        getZoom: () => state.zoom,
        getSize: () => ({ x: state.size.x, y: state.size.y }),
        getCenter: () => state.center,
        getContainer: () => container,
        getPane: (name) => panes[name] || null,
        createPane: (name) => {
            const pane = fakeEl('div');
            panes[name] = pane;
            container.appendChild(pane);
            return pane;
        },
        latLngToLayerPoint: () => ({ x: 200, y: 400 }),
        containerPointToLayerPoint: (pt) => ({ x: pt.x, y: pt.y }),
        on: (type, fn) => { (events[type] = events[type] || []).push(fn); },
        off: (type, fn) => { events[type] = (events[type] || []).filter((f) => f !== fn); },
        fire: (type) => { (events[type] || []).slice().forEach((fn) => fn({ type })); }
    };
}

const sandbox = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    Promise,
    isFinite,
    TextEncoder,
    Uint8Array,
    URLSearchParams,
    AbortController,
    Date,
    setTimeout: (fn, ms) => { pendingTimers.set(nextTimerId, { fn, ms }); return nextTimerId++; },
    clearTimeout: (id) => { pendingTimers.delete(id); },
    clearInterval: () => {},
    setInterval: () => 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: storageStub(),
    crypto: webCryptoStub(),
    document: {
        readyState: 'loading',
        addEventListener: () => {},
        getElementById: () => null,
        documentElement: { lang: 'ro' },
        createElement: (tag) => fakeEl(tag)
    },
    /* The same string form L.DomUtil writes in the browser, so the test can
     * assert the exact transform the user would see. */
    L: {
        point: (x, y) => (x != null && typeof x === 'object'
            && typeof x.x === 'number' && typeof x.y === 'number')
            ? x
            : pt(x, y),
        latLng: (lat, lng) => (lat != null && typeof lat === 'object' && 'lat' in lat)
            ? lat
            : { lat, lng },
        DomUtil: {
            setPosition: (el, p) => {
                el.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)';
            },
            setTransform: (el, p, s) => {
                el.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0) scale(' + s + ')';
            }
        }
    }
};
/* A plain {x,y} with the vector ops the zoom-animation maths leans on —
 * the point instances L.point() would hand back in the browser. */
function pt(x, y) {
    return {
        x, y,
        add(p) { return pt(this.x + p.x, this.y + p.y); },
        subtract(p) { return pt(this.x - p.x, this.y - p.y); },
        multiplyBy(k) { return pt(this.x * k, this.y * k); },
        _round() { this.x = Math.round(this.x); this.y = Math.round(this.y); return this; }
    };
}
/* loadCatalog() fetches the JSON catalogues; serve them from memory so the
 * dots test can run the real attach → enable → redraw path without a
 * network.  The stub routes by URL: the Hungaricana catalogue, the NLS
 * seed catalogue, an IIIF info.json and a WFS response each get their own
 * body, and an unset body answers non-OK (the NLS catalogue is optional). */
let fakeCatalogJson = null;
let fakeNlsCatalogJson = null;
let fakeNlsInfoJson = null;
let fakeWfsJson = null;
sandbox.fetch = (url) => {
    const u = String(url || '');
    let body = fakeCatalogJson;
    if (u.indexOf('other-maps-nls-catalog.json') !== -1) body = fakeNlsCatalogJson;
    else if (u.indexOf('info.json') !== -1) body = fakeNlsInfoJson;
    else if (u.indexOf('geoserver') !== -1 || u.indexOf('wfs') !== -1) body = fakeWfsJson;
    return Promise.resolve({ ok: body != null, json: () => Promise.resolve(body) });
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(relative) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, relative), 'utf8'), sandbox, { filename: relative });
}

load('js/patrimoniu-clustering.js');
load('js/other-maps-tiles.js');
load('js/other-maps-nls.js');
load('js/other-maps-overlay.js');
load('js/other-maps.js');

const Clustering = sandbox.DetectLabPatrimoniuClustering;
const Tiles = sandbox.DetectLabOtherMapsTiles;
const Nls = sandbox.DetectLabOtherMapsNls;
const Overlay = sandbox.DetectLabOtherMapsOverlay;
const OtherMaps = sandbox.DetectLabOtherMaps;

/* ══ 1. tile hashes ═══════════════════════════════════════════════════ */
(async function run() {
    // dezoomify's issue #346 gives one worked example: path
    // maps/mol/s012/div13/s12_div_xiii_0031/s12_div_xiii_0031.ecw (sum 4952),
    // tile x=5, y=5, z=10, ciphertext 67d1e405cb7b1eeb04cabffd9be3596c…
    const samplePath = 'maps/mol/s012/div13/s12_div_xiii_0031/s12_div_xiii_0031.ecw';
    const asZxy = await Tiles.tileUrl.call(null, samplePath, 5, 5, 10);
    Tiles.noteOrder('xyz');
    const asXyz = await Tiles.tileUrl(samplePath, 5, 5, 10);
    Tiles.noteOrder('zxy');

    eq(path.basename(asXyz), '67d1e405cb7b1eeb04cabffd9be3596c',
        'the |x|y|z reading reproduces the hash published in dezoomify #346');
    ok(/^[0-9a-f]{32}$/.test(path.basename(asZxy)),
        'the |z|x|y reading produces a well-formed 32-char hash');
    ok(asZxy !== asXyz, 'the two hash orders really do differ');
    ok(asZxy.startsWith('https://static-cdn.hungaricana.hu/tile/image/' + samplePath + '/'),
        'the tile URL keeps the ECW path and only hashes the coordinates');

    // Tiles for the same sheet at different levels/columns must differ.
    const tileA = await Tiles.tileUrl(samplePath, 0, 0, 3);
    const tileB = await Tiles.tileUrl(samplePath, 1, 0, 3);
    const tileC = await Tiles.tileUrl(samplePath, 0, 0, 4);
    ok(tileA !== tileB && tileA !== tileC, 'each (x, y, z) is a different tile');

    // The hash is stable: asking twice must not change the answer.
    eq(await Tiles.tileUrl(samplePath, 2, 1, 3), await Tiles.tileUrl(samplePath, 2, 1, 3),
        'the hash is deterministic');

    eq(Tiles.thumbUrl(samplePath),
        'https://static-cdn.hungaricana.hu/tile/thumb/' + samplePath,
        'thumbnails need no hash');
    eq(Tiles.recordUrl('MOLTerkeptar/2146'),
        'https://maps.hungaricana.hu/en/MOLTerkeptar/2146/view/',
        'the record URL points at the human-readable page');
    eq(Tiles.maxZoomFor(512, 512), 0, 'a 512 px sheet has a single level');
    eq(Tiles.maxZoomFor(513, 400), 1, 'just over 512 px needs level 1');
    eq(Tiles.maxZoomFor(8192, 4096), 4, 'an 8192 px sheet tops out at level 4');

    /* ══ 2. transform maths ═══════════════════════════════════════════ */
    eq(Math.round(Overlay.resolutionAt(0, 0)), 156543, 'z0 at the equator: 156543 m per pixel');
    ok(Overlay.resolutionAt(0, 10) < Overlay.resolutionAt(0, 9),
        'zooming in shrinks the metres covered by one pixel');
    ok(Overlay.resolutionAt(60, 10) < Overlay.resolutionAt(0, 10),
        'the same zoom covers fewer metres per pixel away from the equator');

    eq(Overlay.normalizeDegrees(370), 10, '370° normalises to 10°');
    eq(Overlay.normalizeDegrees(-190), 170, '-190° normalises to 170°');
    eq(Overlay.snapDegrees(89.5), 90, 'a hair below 90° snaps to 90°');
    eq(Overlay.snapDegrees(80), 80, 'a genuine 80° is left alone');

    // A 10 000 × 7 000 px sheet, 1 m per pixel → 10 km wide on the ground.
    const plan = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 1, maxZoom: 5 });
    ok(plan.level >= 0 && plan.level <= 5, 'the pyramid level stays inside the pyramid');
    ok(Math.abs(plan.k - plan.dW / plan.wL) < 1e-9, 'k is exactly on-screen width / level width');
    ok(plan.dW > 0 && plan.dH > 0, 'the sheet has a positive on-screen size');
    ok(Math.abs(plan.dW / plan.dH - 10000 / 7000) < 1e-6, 'the aspect ratio is preserved');

    // A tiny scale must not pick a level above the pyramid's top…
    const tiny = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 0.02, maxZoom: 5 });
    eq(tiny.level, 0, 'the smallest scale clamps to the pyramid root');
    const huge = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 400, maxZoom: 5 });
    eq(huge.level, 5, 'the largest scale clamps to the deepest level');

    /* The “frame it” scale: longest side ≈ FIT_FRACTION of the smaller
     * viewport edge, in metres per natural pixel. */
    const res12 = Overlay.resolutionAt(47, 12);
    const fitMppPhone = Overlay.fitScale(8000, 6000, res12, 400, 800);
    eq(fitMppPhone, 0.7 * 400 * res12 / 8000,
        'fitScale sizes the sheet to 70% of the smaller viewport edge');
    eq(Overlay.fitScale(8000, 6000, res12, 800, 400), fitMppPhone,
        'fitScale uses the smaller edge regardless of orientation');
    eq(Overlay.fitScale(6000, 8000, res12, 400, 800), 0.7 * 400 * res12 / 8000,
        'fitScale follows the longest side for portrait sheets');
    eq(Overlay.fitScale(0, 0, res12, 400, 800), null, 'fitScale gives up without a size');
    eq(Overlay.fitScale(8000, 6000, res12, 0, 0), null, 'fitScale gives up without a viewport');

    /* A freshly added sheet is framed, so its on-screen size IS the fit:
     * longest side on screen = FIT_FRACTION of the smaller edge, natural
     * aspect, a level inside the pyramid and a bounded tile window. */
    const fitted = Overlay.planGeometry(
        { lat: 47, zoom: 12, w: 8000, h: 6000, mpp: fitMppPhone, maxZoom: 4 },
        { anchor: { x: 200, y: 400 }, rotation: 0, topLeft: { x: 0, y: 0 }, bottomRight: { x: 400, y: 800 } }
    );
    ok(Math.abs(fitted.dW - 0.7 * 400) < 1e-9, 'the fitted sheet spans 70% of the smaller edge');
    ok(Math.abs(fitted.dW / fitted.dH - 8000 / 6000) < 1e-6, 'the fitted sheet keeps its natural 4:3 format');
    ok(fitted.level >= 0 && fitted.level <= 4, 'the fitted sheet stays inside the pyramid');
    ok(fitted.k <= 1 + 1e-9, 'the fitted sheet is never upscaled past its own pixels');
    const fittedRange = Overlay.visibleTileRange(fitted, { x: 200, y: 400 }, 0,
        { x: 0, y: 0 }, { x: 400, y: 800 });
    ok((fittedRange.x1 - fittedRange.x0 + 1) * (fittedRange.y1 - fittedRange.y0 + 1) <= Overlay.maxSharpTiles,
        'the fitted tile window respects the budget');

    /* The sharp-level preference: one level finer downscaling (k ≤ 1, crisp)
     * instead of upscaling (k > 1, soft) — with a view that says the extra
     * tiles are affordable (a small window). */
    const sharpMpp = Math.pow(2, 0.3 - 3) * res12;   // base = 0.3 → round 0, ceil 1
    const sharp = Overlay.planGeometry(
        { lat: 47, zoom: 12, w: 4000, h: 3000, mpp: sharpMpp, maxZoom: 3 },
        { anchor: { x: 200, y: 400 }, rotation: 0, topLeft: { x: 0, y: 0 }, bottomRight: { x: 400, y: 800 } }
    );
    const sharpNoView = Overlay.planGeometry({ lat: 47, zoom: 12, w: 4000, h: 3000, mpp: sharpMpp, maxZoom: 3 });
    eq(sharpNoView.level, 0, 'without a viewport the planner keeps the 1:1 level');
    ok(sharpNoView.k > 1, '…which means a mild upscale there');
    eq(sharp.level, 1, 'with an affordable window the planner steps up one level');
    ok(sharp.k <= 1 + 1e-9, 'the stepped-up level downscales (crisp, no blur)');

    /* …but a viewport whose fine window would exceed the tile budget keeps
     * the 1:1 level — no tile storm for a wall-sized sheet. */
    const wideMpp = 0.2625 * res12;                  // base ≈ 2.07 → round 2, ceil 3
    const wide = Overlay.planGeometry(
        { lat: 47, zoom: 12, w: 8000, h: 6000, mpp: wideMpp, maxZoom: 4 },
        { anchor: { x: 1500, y: 1000 }, rotation: 0, topLeft: { x: 0, y: 0 }, bottomRight: { x: 3000, y: 2000 } }
    );
    eq(wide.level, 2, 'an over-budget fine window keeps the 1:1 level');
    ok(wide.k > 1 && wide.k < 1.1, '…accepting the mild 1:1 upscale rather than hundreds of tiles');

    // …and the visible tile window must always contain every tile the
    // viewport actually looks at — that is the whole point of the inverse
    // transform, and it has to hold at any rotation.
    function coversViewport(geom, anchor, rotationDeg, topLeft, bottomRight) {
        const range = Overlay.visibleTileRange(geom, anchor, rotationDeg, topLeft, bottomRight);
        const theta = rotationDeg * Math.PI / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const corners = [
            [topLeft.x, topLeft.y], [bottomRight.x, topLeft.y],
            [bottomRight.x, bottomRight.y], [topLeft.x, bottomRight.y]
        ];
        return corners.every(([x, y]) => {
            const dx = x - anchor.x;
            const dy = y - anchor.y;
            const lx = (cos * dx + sin * dy) / geom.k + geom.wL / 2;
            const ly = (-sin * dx + cos * dy) / geom.k + geom.hL / 2;
            const tx = Math.floor(lx / Overlay.tileSize);
            const ty = Math.floor(ly / Overlay.tileSize);
            return tx >= range.x0 && tx <= range.x1 && ty >= range.y0 && ty <= range.y1;
        });
    }
    const viewport = { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1200, y: 800 } };
    const centred = Overlay.planGeometry({ lat: 47, zoom: 12, w: 4000, h: 3000, mpp: 40, maxZoom: 4 });
    ok(coversViewport(centred, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 0)');
    ok(coversViewport(centred, { x: 600, y: 400 }, 90, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 90°)');
    ok(coversViewport(centred, { x: 600, y: 400 }, 37, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 37°)');
    ok(coversViewport(centred, { x: 600, y: 400 }, -128, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation -128°)');
    // A sheet drawn entirely inside the viewport asks for all of its tiles.
    const inside = Overlay.planGeometry({ lat: 47, zoom: 12, w: 4000, h: 3000, mpp: 1, maxZoom: 4 });
    const insideRange = Overlay.visibleTileRange(inside, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight);
    eq(insideRange.x0, 0, 'a fully visible sheet starts at tile column 0');
    eq(insideRange.x1, inside.cols - 1, 'a fully visible sheet ends at its last column');
    eq(insideRange.y0, 0, 'a fully visible sheet starts at tile row 0');
    eq(insideRange.y1, inside.rows - 1, 'a fully visible sheet ends at its last row');

    const small = Overlay.planGeometry({ lat: 47, zoom: 16, w: 4000, h: 3000, mpp: 0.05, maxZoom: 4 });
    const smallRange = Overlay.visibleTileRange(small, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight);
    ok(smallRange.x0 >= 0 && smallRange.x1 < small.cols, 'the window never leaves the tile grid');
    ok(smallRange.x1 >= smallRange.x0 && smallRange.y1 >= smallRange.y0, 'the window is not inverted');

    const offscreen = Overlay.visibleTileRange(small, { x: 60000, y: 40000 }, 0, viewport.topLeft, viewport.bottomRight);
    ok(offscreen.x0 >= 0 && offscreen.x1 < small.cols, 'a sheet far outside the view still yields a legal window');

    /* ══ 3. the catalogue ═════════════════════════════════════════════ */
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/other-maps-catalog.json'), 'utf8'));
    ok(Array.isArray(catalog.maps) && catalog.maps.length > 0, 'the catalogue has records');
    ok(catalog.tileBase && catalog.thumbBase, 'the catalogue names its endpoints');

    const ids = new Set();
    catalog.maps.forEach((entry) => {
        ok(entry.id, 'record has an id');
        ok(!ids.has(entry.id), 'id ' + entry.id + ' is unique');
        ids.add(entry.id);
        ok(/^[a-z0-9/._\-()]+\.ecw$/i.test(entry.path), entry.id + ' carries an ECW path');
        ok(entry.lat > 40 && entry.lat < 52, entry.id + ' sits at a plausible central-European latitude');
        ok(entry.lng > 12 && entry.lng < 30, entry.id + ' sits at a plausible central-European longitude');
        ok(entry.place, entry.id + ' names a place');
    });

    // Same-place sheets stay individually addressable: every card in the
    // window Adds its own record id.
    const byPlace = OtherMaps.groupByPlace(catalog.maps);
    const multi = byPlace.filter((loc) => loc.count > 1);
    ok(multi.length >= 1, 'at least one place holds several sheets');
    multi.forEach((loc) => {
        const sheetIds = loc.sheets.map((sheet) => sheet.id);
        ok(new Set(sheetIds).size === sheetIds.length, loc.place + ' lists distinct sheet ids');
    });

    /* ══ 4. clustering — identical to Patrimoniu ══════════════════════ */
    const config = Clustering.CONFIG;
    eq(config.minZoom, 6, 'the shared config starts clustering at z6');
    eq(config.disableClusteringAtZoom, 11, 'the shared config stops clustering at z11');
    eq(Clustering.getDistanceKm(6, config), 5, 'z6 groups within 5 km');
    eq(Clustering.getDistanceKm(10, config), 1, 'z10 groups within 1 km');
    eq(Clustering.getDistanceKm(11, config), 0, 'z11 groups nothing');

    const index = new Clustering.SpatialIndex(config.indexCellSizeM);
    const records = catalog.maps.map((entry) => ({
        id: entry.id,
        lat: entry.lat,
        lng: entry.lng,
        latlng: { lat: entry.lat, lng: entry.lng },
        place: entry.place
    }));

    // Sheets of one place share one point → they become ONE location, so the
    // map never stacks identical dots on top of each other.
    const locations = OtherMaps.groupByPlace(records);
    ok(locations.length < records.length, 'co-located sheets are merged into places');
    ok(locations.every((loc) => loc.count >= 1 && loc.sheets.length === loc.count),
        'every location counts its sheets');
    locations.forEach((loc) => index.add(loc));

    const maramures = locations.filter((l) => /Maramure/i.test(l.place || ''));
    ok(maramures.length >= 1 && maramures[0].count > 3, 'the Maramureș sheets share one dot');
    const cluj = locations.filter((l) => l.place === 'Cluj-Napoca (RO)');
    ok(cluj.length === 1 && cluj[0].count > 40, 'the Cluj-Napoca sheets share one dot');
    const grouped = Clustering.clusterRecords(maramures, 11, index, config);
    eq(grouped.length, 1, 'one place is one dot even with clustering disabled');

    // At country scale, places hundreds of km apart stay separate…
    const worldView = Clustering.clusterRecords(locations, 6, index, config);
    ok(worldView.length > 1, 'distant places stay separate at z6');
    // …and the dots that are single places open the sheet list when tapped.
    const singles = worldView.filter((cluster) => OtherMaps.isLocationCluster(cluster));
    ok(singles.length >= 1, 'at least one z6 dot is a single place');

    // Two places 1.4 km apart: one dot at z6 (5 km), two pins at z11 (1 km).
    const near = OtherMaps.groupByPlace([
        { id: 'a', lat: 47.000, lng: 23.000, place: 'A' },
        { id: 'b', lat: 47.010, lng: 23.010, place: 'B' }
    ]);
    const nearIndex = new Clustering.SpatialIndex(config.indexCellSizeM);
    near.forEach((loc) => nearIndex.add(loc));
    eq(Clustering.clusterRecords(near, 6, nearIndex, config).length, 1, '1.4 km apart: one dot at z6');
    const splitNear = Clustering.clusterRecords(near, 11, nearIndex, config);
    eq(splitNear.length, 2, '1.4 km apart: two pins at z11');
    ok(!OtherMaps.isLocationCluster(Clustering.clusterRecords(near, 6, nearIndex, config)[0]),
        'a group of two places is geographic, so a tap zooms in');
    ok(OtherMaps.isLocationCluster(splitNear[0]),
        'a single place is a location, so a tap opens the sheet list');

    // Overlapping neighbour dots merge into one window: the Maramureș
    // town and county sheets sit ~350 m apart and share taps at low zoom.
    const locTown = { place: 'Sighetu Marmației (RO)', sheets: [{ id: 'a/1', title: 't1' }, { id: 'a/2', title: 't2' }] };
    const locCounty = { place: 'Comitatul Maramureș (azi Maramureș, RO)', sheets: [{ id: 'b/1', title: 't3' }] };
    const tapTown = { cluster: { members: [locTown] } };
    const tapCounty = { cluster: { members: [locCounty] } };
    const merged = OtherMaps.mergeTapSheets([tapTown, tapCounty]);
    eq(merged.sheets.length, 3, 'tapping two overlapping dots lists every sheet');
    eq(merged.places.length, 2, 'tapping two overlapping dots names both places');
    eq(OtherMaps.mergeTapSheets([tapTown, tapTown, tapCounty]).sheets.length, 3,
        'a sheet reached twice is listed once');
    eq(OtherMaps.mergeTapSheets([{ cluster: { members: [locTown, locCounty] } }]).sheets.length, 0,
        'a geographic group contributes no sheets to the merge');
    const lone = OtherMaps.mergeTapSheets([tapCounty]);
    eq(lone.sheets.length, 1, 'a lone dot still opens its own sheet');
    eq(lone.places[0], locCounty.place, 'a lone dot keeps its place name');

    /* ══ 5. labels ════════════════════════════════════════════════════ */
    ok(OtherMaps.t('om_add').length > 0, 'the Romanian table is used when the page is Romanian');
    ['ro', 'en', 'hu'].forEach((lang) => {
        ok(OtherMaps.strings[lang].om_places_count.indexOf('{n}') >= 0, lang + ' counts merged places');
        ok(OtherMaps.strings[lang].om_place_count.length > 0, lang + ' names one merged place');
    });
    eq(OtherMaps.formatMeters(0.42), '0.42 m', 'sub-metre widths read in metres');
    eq(OtherMaps.formatMeters(2500), '2.50 km', 'kilometre widths read in km');
    const limits = Overlay.limits;
    eq(OtherMaps.sliderFromMppLimits(limits.mppMin, limits), 0, 'the scale slider starts at the minimum');
    eq(OtherMaps.sliderFromMppLimits(limits.mppMax, limits), 1000, 'the scale slider ends at the maximum');

    /* ══ 6. the manager: framing on add + level crossfade ═════════════ */
    /* The overlay manager against a fake map + mini DOM. The sheet's
     * natural size comes from the catalogue hint (no network), tile <img>s
     * load only when the test dispatches 'load', and the stand-in's
     * fallback timer is flushed on demand. */
    const simMap = fakeMap({ zoom: 12, size: { x: 400, y: 800 }, center: { lat: 47.933, lng: 23.892 } });
    const mgr = Overlay.createManager(simMap, { pane: 'om_test_pane', opacity: 0.8 });
    const rec = {
        id: 'TST/1',
        path: 'maps/mol/s011/s11_0647/s11_0647.ecw',
        lat: 47.933,
        lng: 23.892,
        w: 8000,
        h: 6000
    };
    const ov = await mgr.add(rec);
    await new Promise((r) => setImmediate(r));   // let the tile-URL promises set src

    // A fresh sheet is framed into the viewport, not dropped at an
    // arbitrary ground size.
    const fitMpp12 = Overlay.fitScale(8000, 6000, Overlay.resolutionAt(47.933, 12), 400, 800);
    ok(Math.abs(ov.state.mpp - fitMpp12) / fitMpp12 < 1e-9,
        'a fresh sheet is framed: mpp = fitScale(viewport, zoom)');
    eq(ov.geom.level, 0, 'the fitted sheet sits at the pyramid root at county zoom');
    const gridTiles = () => ov.gridEl.children.filter((el) => el.tagName === 'IMG');
    eq(gridTiles().length, 1, 'the whole fitted sheet is one root-level tile');

    // Zoom in → finer level: the old tiles stay as a blurred stand-in,
    // repositioned by 2^Δ, until the new level loads.
    simMap._state.zoom = 13;
    simMap.fire('zoomend');
    await new Promise((r) => setImmediate(r));
    eq(ov.geom.level, 1, 'zooming in moves the sheet to a finer pyramid level');
    ok(ov.stale && Object.keys(ov.stale.imgs).length === 1,
        'the old level is kept as a stand-in while the finer one loads');
    eq(gridTiles().length, 5, 'stand-in tiles and new tiles coexist on the grid');
    const standin = ov.stale.imgs['0:0:0'];
    eq(standin.style.left, '0px', 'the stand-in tile keeps its ground position');
    eq(standin.style.width, '1024.6px', '…scaled 2^Δ to cover the same ground at the finer level');
    ok(standin.className.indexOf('om-tile-stale') >= 0, 'stand-in tiles are tagged as such');
    eq(pendingTimers.size, 1, 'the stand-in carries a fallback timer');

    // Nothing loads → the fallback drops the stand-in (no forever blur).
    flushTimers();
    ok(!ov.stale, 'the fallback timer retires the stand-in');
    eq(gridTiles().length, 4, '…leaving exactly the new-level window');
    eq(pendingTimers.size, 0, '…and the fallback timer is gone');

    // Zoom out → coarser level: the finer tiles are dropped, no stand-in.
    simMap._state.zoom = 11;
    simMap.fire('zoomend');
    await new Promise((r) => setImmediate(r));
    eq(ov.geom.level, 0, 'zooming out returns to the coarser level');
    ok(!ov.stale, 'going coarser drops the finer tiles (nothing can stand in)');
    eq(gridTiles().length, 1, 'the coarser window is refetched');

    // Zoom in again, and this time the tiles load: the stand-in retires
    // the moment every wanted tile has settled.
    simMap._state.zoom = 13;
    simMap.fire('zoomend');
    await new Promise((r) => setImmediate(r));
    ok(ov.stale, 'the stand-in is back for the second zoom-in');
    gridTiles().filter((el) => el.className.indexOf('stale') < 0)
        .forEach((img) => img.dispatch('load'));
    ok(!ov.stale, 'every new tile settled → the stand-in retires');
    eq(gridTiles().length, 4, '…and the grid holds exactly the new-level window');

    // Reset returns to the framed state of the current view (zoom 13 here).
    mgr.reset('TST/1');
    const fitMpp13 = Overlay.fitScale(8000, 6000, Overlay.resolutionAt(47.933, 13), 400, 800);
    ok(Math.abs(ov.state.mpp - fitMpp13) / fitMpp13 < 1e-9, 'reset returns the framed scale');
    eq(ov.state.rotation, 0, 'reset clears the rotation');
    ok(ov.state.lat === rec.lat && ov.state.lng === rec.lng, 'reset restores the sheet position');

    // Removal cleans up tiles and leaves no timer behind.
    mgr.remove('TST/1');
    eq(gridTiles().length, 0, 'remove empties the grid');
    eq(pendingTimers.size, 0, '…and no stand-in timer is left behind');

    /* ══ 7. zoom animation: dots and sheets stay locked to the tiles ════
     * The reported glitch: while Leaflet animates a zoom it leaves the map
     * pane stationary for 250 ms and CSS-scales ONLY the tile containers.
     * The dots canvas and the sheet roots have to apply the matching
     * transform themselves — otherwise they sit still, drift away from
     * their places, and snap back at zoomend (“se mișcă sacadat”).  This
     * section drives a fake map with the real Web Mercator conventions
     * (project space linear in zoom, layer = project − pixelOrigin,
     * container = layer + mapPanePos, map pane at a constant pan offset)
     * and checks the exact transform string plus the geometry: every
     * painted pixel must land at its target-zoom position. */
    const BASE = 1000;
    const projectAt = (ll, z) => pt(BASE * Math.pow(2, z) * ll.lng, BASE * Math.pow(2, z) * ll.lat);
    const PANE_POS = pt(17, 9);   // a non-zero pan drift, so anchors aren't trivial
    function makeProjMap(initial) {
        const state = Object.assign({}, initial);
        const panes = Object.create(null);
        const events = Object.create(null);
        const containerEl = fakeEl('div');
        const originAt = (center, z) => projectAt(center, z)
            .subtract(pt(state.size.x / 2, state.size.y / 2)).add(PANE_POS);
        return {
            _animatingZoom: false,
            _state: state,
            getZoom: () => state.zoom,
            getSize: () => pt(state.size.x, state.size.y),
            getCenter: () => state.center,
            getContainer: () => containerEl,
            getPane: (name) => panes[name] || null,
            createPane: (name) => {
                const p = fakeEl('div');
                panes[name] = p;
                containerEl.appendChild(p);
                return p;
            },
            project: (ll, z) => projectAt(ll, z == null ? state.zoom : z),
            getPixelOrigin: () => originAt(state.center, state.zoom),
            _getNewPixelOrigin: (center, z) => originAt(center, z),
            getZoomScale: (to, from) => Math.pow(2, to - from),
            latLngToLayerPoint: (ll) => projectAt(ll, state.zoom).subtract(originAt(state.center, state.zoom))._round(),
            containerPointToLayerPoint: (cp) => cp.subtract(PANE_POS),
            getBounds: () => {
                const scale = BASE * Math.pow(2, state.zoom);
                const halfW = state.size.x / 2 / scale, halfH = state.size.y / 2 / scale;
                return {
                    getSouth: () => state.center.lat - halfH,
                    getNorth: () => state.center.lat + halfH,
                    getWest: () => state.center.lng - halfW,
                    getEast: () => state.center.lng + halfW
                };
            },
            on: (type, fn) => { (events[type] = events[type] || []).push(fn); },
            off: (type, fn) => { events[type] = (events[type] || []).filter((f) => f !== fn); },
            fire: (type, ev) => { (events[type] || []).slice().forEach((fn) => fn(Object.assign({ type }, ev))); }
        };
    }
    const projMap = makeProjMap({ zoom: 12, size: { x: 800, y: 600 }, center: { lat: 47.933, lng: 23.892 } });
    const originAt = (z) => projectAt(projMap.getCenter(), z)
        .subtract(pt(400, 300)).add(PANE_POS);
    const TOP_LEFT = pt(0, 0).subtract(PANE_POS);   // containerPointToLayerPoint(0,0)

    // ── the dots canvas ─────────────────────────────────────────────────
    fakeCatalogJson = catalog;
    OtherMaps.attach(projMap);
    OtherMaps.setEnabled(true);
    await new Promise((r) => setImmediate(r));   // loadCatalog → ensureCanvas → redraw
    ok(OtherMaps.isEnabled(), 'the layer turns on with the fake map attached');
    ok(OtherMaps.state.canvas && /leaflet-zoom-animated/.test(OtherMaps.state.canvas.className),
        'the dots canvas carries the zoom-anim class (0.25 s transition, 0 0 origin)');
    ok(OtherMaps.state.hits.length > 0, 'dots are painted at the settled zoom');

    const omState = OtherMaps.state;
    const anchor12 = originAt(12).add(TOP_LEFT);
    ok(Math.abs(omState.lastAnchor.x - anchor12.x) < 1e-6 && Math.abs(omState.lastAnchor.y - anchor12.y) < 1e-6,
        'a settled redraw records the project-space anchor of the painted frame');
    eq(omState.lastZoom, 12, '…and the zoom it was painted at');
    eq(omState.canvas.style.transform, 'translate3d(-17px,-9px,0)',
        'a settled canvas is placed plainly (no zoom transform lingers)');

    // Animated zoom in (button / double-tap / wheel): no move events fire
    // for 250 ms — the zoomanim handler must scale the settled frame.
    projMap.fire('zoomanim', { center: projMap.getCenter(), zoom: 13 });
    const p1_13 = originAt(13);
    const expOff = anchor12.multiplyBy(2).subtract(p1_13)._round();
    eq(omState.canvas.style.transform,
        'translate3d(' + expOff.x + 'px,' + expOff.y + 'px,0) scale(2)',
        'zoomanim applies translate(2·anchor − newOrigin) scale(2)');

    // The geometry: after the transform, every painted dot sits exactly
    // where the settled z13 view would paint it (container coordinates).
    omState.hits.forEach(function (hit) {
        const drawn = projectAt(hit.latlng, 12).subtract(originAt(12));   // layer point as painted
        const local = drawn.subtract(TOP_LEFT);                          // canvas pixel
        const got = PANE_POS.add(pt(expOff.x + 2 * local.x, expOff.y + 2 * local.y));
        const want = projectAt(hit.latlng, 13).subtract(originAt(13)).add(PANE_POS);
        ok(Math.abs(got.x - want.x) < 1e-4 && Math.abs(got.y - want.y) < 1e-4,
            'a dot stays on its place through the animated zoom (' + hit.cluster.count + ' sheets)');
    });

    // Settling (zoomend): a plain redraw resets the transform and re-records.
    projMap._state.zoom = 13;
    projMap.fire('move');
    projMap.fire('zoomend');
    eq(omState.lastZoom, 13, 'the settled redraw re-records the frame at the new zoom');
    eq(omState.canvas.style.transform, 'translate3d(-17px,-9px,0)',
        '…and the canvas goes back to a plain placement (no lingering scale)');

    // Pinch: 'zoom' events fire per frame and the origin already moves —
    // the transform must track the live center/zoom from the settled frame,
    // and 'move' events must NOT redraw mid-pinch (they would fight it).
    projMap.touchZoom = { _zooming: true };
    const anchor13 = originAt(13).add(TOP_LEFT);
    projMap.fire('move');
    ok(Math.abs(omState.lastAnchor.x - anchor13.x) < 1e-6 && Math.abs(omState.lastAnchor.y - anchor13.y) < 1e-6,
        'mid-pinch move events do not repaint (guard)');
    projMap._state.zoom = 14;
    projMap.fire('zoom', { pinch: true });
    const expOffPinch = anchor13.multiplyBy(2).subtract(originAt(14))._round();
    eq(omState.canvas.style.transform,
        'translate3d(' + expOffPinch.x + 'px,' + expOffPinch.y + 'px,0) scale(2)',
        'a pinch rescales the settled frame live (zoom 13 → 14)');
    projMap.touchZoom._zooming = false;
    projMap.fire('move');
    projMap.fire('zoomend');
    eq(omState.lastZoom, 14, 'after the pinch settles, the frame is re-recorded at 14');
    eq(omState.canvas.style.transform, 'translate3d(-17px,-9px,0)',
        '…and the plain placement is restored');

    // ── the sheet overlays ──────────────────────────────────────────────
    const mgr2 = OtherMaps.state.manager;   // created by attach() on projMap
    const rec7 = {
        id: 'TST/7',
        path: 'maps/mol/s011/s11_0647/s11_0647.ecw',
        /* Deliberately OFF the map centre: a centre point keeps the same
         * layer position at every zoom, which would hide re-anchoring. */
        lat: 47.95,
        lng: 23.91,
        w: 8000,
        h: 6000
    };
    const ov7 = await mgr2.add(rec7);
    await new Promise((r) => setImmediate(r));
    ok(/leaflet-zoom-animated/.test(ov7.root.className),
        'the sheet root carries the zoom-anim class');
    eq(ov7.root.style.transform,
        'translate3d(' + ov7.anchor.x + 'px,' + ov7.anchor.y + 'px,0)',
        'a settled sheet is placed at its anchor (no zoom transform)');

    // Animated zoom out → in by two: the root gets
    // translate(s·(projectAnchor − anchor) − newOrigin) scale(s) translate(anchor).
    projMap.fire('zoomanim', { center: projMap.getCenter(), zoom: 15 });
    const a14 = pt(ov7.anchor.x, ov7.anchor.y);
    const bitmapAnchor7 = originAt(14).add(a14);
    const off7 = bitmapAnchor7.multiplyBy(2).subtract(originAt(15))._round();
    eq(ov7.root.style.transform,
        'translate3d(' + off7.x + 'px,' + off7.y + 'px,0) scale(2)',
        'zoomanim scales the sheet around its bitmap anchor (14 → 15)');

    // …and the sheet's anchor point stays on the ground: container of the
    // anchor after the transform = the settled z15 container of its LatLng.
    const anchorContainer15 = projectAt(rec7, 15).subtract(originAt(15)).add(PANE_POS);
    // The anchor is the root's local (0,0): translate(off7)·scale(2) maps it
    // to off7 in pane coordinates.
    const gotAnchor = PANE_POS.add(pt(off7.x, off7.y));
    ok(Math.abs(gotAnchor.x - anchorContainer15.x) < 1 && Math.abs(gotAnchor.y - anchorContainer15.y) < 1,
        'the sheet anchor stays on its ground point through the animation');

    // …and a content point stays on the ground too — the whole scan must not
    // drift, not just the anchor.
    const p7 = pt(123, 45);
    const gotContent = PANE_POS.add(pt(off7.x + 2 * p7.x, off7.y + 2 * p7.y));
    const wantContent = projectAt(rec7, 15).add(pt(2 * p7.x, 2 * p7.y))
        .subtract(originAt(15)).add(PANE_POS);
    ok(Math.abs(gotContent.x - wantContent.x) < 1 && Math.abs(gotContent.y - wantContent.y) < 1,
        'a sheet content point stays on its ground point through the animation');

    // Settle: render() resets the root transform and re-records the frame.
    projMap._state.zoom = 15;
    projMap.fire('move');
    projMap.fire('zoomend');
    ok(ov7.anchor.x !== a14.x || ov7.anchor.y !== a14.y,
        'settling at z15 re-anchors the sheet (layer points changed)');
    eq(ov7.root.style.transform,
        'translate3d(' + ov7.anchor.x + 'px,' + ov7.anchor.y + 'px,0)',
        '…and the plain placement is restored');

    // The georeference square is geographic too: a zoom animation scales it
    // around the place (its own centre) with the same transform the sheet
    // root gets, so the square stays locked to the ground through the glide.
    const homeLL = { lat: rec7.lat, lng: rec7.lng };
    const homeLayer = projMap.latLngToLayerPoint(homeLL);
    projMap.fire('zoomanim', { center: projMap.getCenter(), zoom: 16 });
    const homeBitmap = originAt(15).add(homeLayer);
    const gOff = homeBitmap.multiplyBy(2).subtract(originAt(16))._round();
    eq(ov7.georefEl.style.transform,
        'translate3d(' + gOff.x + 'px,' + gOff.y + 'px,0) scale(2)',
        'the georeference square scales around the place through the animation');

    /* ══ 8. the georeference square ═════════════════════════════════════
     * Every Hungaricana sheet is confined to a square around the place it
     * was added for: the anchor may be dragged/rotated/scaled, but it may
     * never leave the square.  5 km is the default; the panel can enlarge it
     * for an exceptional sheet. */
    const G_R = 6378137;
    const G_MPP_LAT = Math.PI * G_R / 180;
    function groundMeters(lat, lng, cLat, cLng) {
        return {
            x: (lng - cLng) * G_MPP_LAT * Math.cos(cLat * Math.PI / 180),
            y: (lat - cLat) * G_MPP_LAT
        };
    }
    const G_LAT = 47.0, G_LNG = 23.0;
    const insidePt = Overlay.clampToSquare(47.01, 23.01, G_LAT, G_LNG, 5);
    ok(Math.abs(insidePt.lat - 47.01) < 1e-9 && Math.abs(insidePt.lng - 23.01) < 1e-9,
        'a point inside the square is unchanged');
    const northPt = Overlay.clampToSquare(48.0, 23.0, G_LAT, G_LNG, 5);
    let northM = groundMeters(northPt.lat, northPt.lng, G_LAT, G_LNG);
    ok(Math.abs(northM.y - 2500) < 1 && Math.abs(northM.x) < 1,
        'a point far north clamps to the north edge (+2.5 km on the ground)');
    const eastPt = Overlay.clampToSquare(47.0, 24.0, G_LAT, G_LNG, 5);
    let eastM = groundMeters(eastPt.lat, eastPt.lng, G_LAT, G_LNG);
    ok(Math.abs(eastM.x - 2500) < 1 && Math.abs(eastM.y) < 1,
        'a point far east clamps to the east edge (+2.5 km on the ground)');
    const cornerPt = Overlay.clampToSquare(48.0, 24.0, G_LAT, G_LNG, 5);
    let cornerM = groundMeters(cornerPt.lat, cornerPt.lng, G_LAT, G_LNG);
    ok(Math.abs(cornerM.x - 2500) < 1 && Math.abs(cornerM.y - 2500) < 1,
        'a point past the corner clamps to the corner');
    const bigPt = Overlay.clampToSquare(47.2, 23.0, G_LAT, G_LNG, 100);
    ok(Math.abs(bigPt.lat - 47.2) < 1e-9, 'a bigger square lets the point through');
    const zeroPt = Overlay.clampToSquare(48.0, 23.0, G_LAT, G_LNG, 0);
    ok(Math.abs(zeroPt.lat - 48.0) < 1e-9, 'a zero square does not clamp');
    ok(isNaN(Overlay.clampToSquare(NaN, 23.0, G_LAT, G_LNG, 5).lat),
        'a non-finite latitude is returned unchanged');

    /* The manager: a fresh sheet owns a 5 km square, setState clamps the
     * anchor into it, setBoundsKm resizes it (enlarging lets the anchor
     * travel, shrinking pulls it back), the square is painted in layer space
     * and the state/snapshot carry the size. */
    const geoMap = fakeMap({ zoom: 12, size: { x: 400, y: 800 }, center: { lat: 47.933, lng: 23.892 } });
    const geoMgr = Overlay.createManager(geoMap, { pane: 'om_georef_pane', opacity: 0.8 });
    const geoRec = {
        id: 'TST/8',
        path: 'maps/mol/s011/s11_0647/s11_0647.ecw',
        lat: 47.933,
        lng: 23.892,
        w: 8000,
        h: 6000
    };
    const geoOv = await geoMgr.add(geoRec);
    await new Promise((r) => setImmediate(r));
    eq(geoOv.state.boundsKm, 5, 'a fresh sheet starts with the default 5 km square');
    eq(geoMgr.getBoundsKm('TST/8'), 5, 'getBoundsKm reports the default');
    ok(geoOv.georefEl && /om-georef/.test(geoOv.georefEl.className),
        'the sheet owns a georeference square element');
    ok(geoOv.georefEl.parentNode === geoMap.getPane('om_georef_pane'),
        'the square lives in the overlay pane');

    // A position far outside the square is clamped back to the edge.
    const farState = geoMgr.setState('TST/8', { lat: 48.5, lng: 23.892 });
    let farM = (farState.lat - geoRec.lat) * G_MPP_LAT;
    ok(farM > 2499 && farM <= 2500 + 1e-6,
        'setState clamps the anchor into the 5 km square, onto the edge');

    // Enlarging the square lets the anchor travel further.
    geoMgr.setBoundsKm('TST/8', 50);
    eq(geoMgr.getBoundsKm('TST/8'), 50, 'setBoundsKm stores the new square');
    const farState2 = geoMgr.setState('TST/8', { lat: 48.5, lng: 23.892 });
    let farM2 = (farState2.lat - geoRec.lat) * G_MPP_LAT;
    ok(farM2 > 2500, 'a bigger square lets the anchor move further');

    // Shrinking pulls the anchor back inside the smaller square.
    geoMgr.setState('TST/8', { lat: 48.5, lng: 23.892 });
    geoMgr.setBoundsKm('TST/8', 5);
    const shrunkM = (geoMgr.state('TST/8').lat - geoRec.lat) * G_MPP_LAT;
    ok(shrunkM <= 2500 + 1e-6, 'shrinking the square pulls the anchor back inside');

    // The square is drawn at the place, at the square side on the ground.
    geoMgr.setAlignMode(true);
    geoMgr.setActive('TST/8');
    const geoHalfPx = (5 * 1000 / 2) / Overlay.resolutionAt(geoRec.lat, 12);
    ok(Math.abs(parseFloat(geoOv.georefInner.style.width) - geoHalfPx * 2) < 1e-6,
        'the square is drawn at the square side on the ground');
    ok(geoOv.georefEl.style.display !== 'none', 'the square is visible in align mode');
    ok(geoMgr.state('TST/8').boundsKm === 5, 'publicState carries boundsKm');
    ok(geoMgr.snapshot().overlays[0].boundsKm === 5, 'the snapshot carries boundsKm');
    geoMgr.remove('TST/8');
    ok(!geoOv.georefEl.parentNode, 'remove detaches the square');

    /* ══ 9. the panel selector ═════════════════════════════════════════
     * The “Overlay the map” panel exposes the square size as an option. The
     * helper that builds the <option> list is exercised here (the mini DOM in
     * this file cannot parse the panel's innerHTML); the manager side of the
     * change is covered by the setBoundsKm checks above. */
    const georefOptions = OtherMaps.georefOptionsHtml(5);
    ok(/value="5"/.test(georefOptions), 'the selector offers the 5 km preset');
    ok(/value="100"/.test(georefOptions), 'the selector offers the 100 km preset');
    ok(/value="5">5 km<\/option>/.test(georefOptions), 'each preset is labelled with its size');
    const georefCustom = OtherMaps.georefOptionsHtml(7);
    ok(/value="7"/.test(georefCustom), 'a non-preset square is offered as its own option');
    ok(OtherMaps.strings.ro.om_georef && OtherMaps.strings.en.om_georef && OtherMaps.strings.hu.om_georef,
        'the georeference label exists in all three languages');
    ok(OtherMaps.strings.ro.om_georef_hint && OtherMaps.strings.en.om_georef_hint && OtherMaps.strings.hu.om_georef_hint,
        'the georeference hint exists in all three languages');

    /* ══ 10. the NLS Map Finder adapter ════════════════════════════════
     * js/other-maps-nls.js turns the NLS GeoServer WFS features into Other
     * maps records and reads the scans through the IIIF Image API.  Nothing
     * here touches the network: info.json and WFS bodies are served by the
     * URL-aware fetch stub at the top of this file. */
    ok(Nls && Nls.SOURCE === 'nls', 'the NLS adapter is loaded');
    eq(Nls.TILE_SIZE, 512, 'the IIIF tile grid matches the overlay grid');
    eq(Nls.FIND_LAYERS.length, 12, 'the finder query covers the twelve documented WFS layers');
    ok(Nls.COVERAGE.south === 49.1 && Nls.COVERAGE.north === 61, 'the coverage box is Great Britain / Ireland');

    eq(Nls.imageIdOf({ id: 'nls/228799835' }), '228799835', 'imageIdOf strips the nls/ prefix');
    eq(Nls.imageIdOf('228799835'), '228799835', 'imageIdOf accepts a bare viewer id');
    eq(Nls.iiifPath('102345214'), '10234/102345214', 'the IIIF path prefix drops the last four digits');
    eq(Nls.iiifPath('74415150'), '7441/74415150', 'an eight-digit town plan takes a four-digit prefix');
    eq(Nls.iiifBase({ path: '10234/102345214' }),
        'https://map-view.nls.uk/iiif/2/10234%2F102345214', 'the IIIF base URL encodes the slash');
    eq(Nls.thumbUrl({ id: 'nls/102345214', path: '10234/102345214' }),
        'https://map-view.nls.uk/iiif/2/10234%2F102345214/full/256,/0/default.jpg',
        'thumbnails are IIIF full-region requests');
    eq(Nls.recordUrl({ id: 'nls/102345214', path: '10234/102345214' }),
        'https://maps.nls.uk/view/102345214', 'the record URL points at the Map Images viewer');
    ok(/point=55.95330,-3.18830/.test(Nls.findUrl(55.9533, -3.1883)), 'the finder deep link carries the marker point');
    eq(Nls.maxZoomFor(13176, 10110), 5, 'a 13176 px sheet has a six-level pyramid');
    eq(Nls.maxZoomFor(512, 512), 0, 'a 512 px sheet has a single pyramid level');

    const v2 = Nls.parseInfo({
        width: 2048, height: 1024,
        tiles: [{ width: 512, height: 512, scaleFactors: [1, 2, 4, 8] }]
    });
    eq(v2.maxZoom, 3, 'IIIF v2 scale factors map onto pyramid levels');
    const v11 = Nls.parseInfo({ width: 9392, height: 8770, tile_width: 9392, scale_factors: [1, 2, 4, 8, 16, 32, 64, 128] });
    eq(v11.maxZoom, 7, 'IIIF v1.1 scale_factors are understood too');
    eq(Nls.parseInfo({ width: 1000, height: 800 }).maxZoom, Nls.maxZoomFor(1000, 800),
        'an info document without tiles falls back to the 512 px rule');

    const nlsRec = { id: 'nls/142842536', nlsId: '142842536', source: 'nls', path: '14284/142842536', w: 13176, h: 10110 };
    const nlsMeta = await Nls.resolve(nlsRec, { w: 13176, h: 10110 });
    eq(nlsMeta.w, 13176, 'resolve honours the catalogue size hint without a request');
    eq(nlsMeta.maxZoom, 5, 'the hinted pyramid depth is computed');
    const nativeTile = await Nls.tileUrl(nlsRec, 0, 0, 5);
    eq(nativeTile, 'https://map-view.nls.uk/iiif/2/14284%2F142842536/0,0,512,512/512,512/0/default.jpg',
        'a native-level tile is a 512 px IIIF region request');
    const rootTile = await Nls.tileUrl(nlsRec, 0, 0, 0);
    eq(rootTile, 'https://map-view.nls.uk/iiif/2/14284%2F142842536/0,0,13176,10110/412,316/0/default.jpg',
        'the pyramid root is one whole-image request at the smallest derivative');
    const edgeTile = await Nls.tileUrl(nlsRec, 25, 0, 5);
    ok(/\/12800,0,376,512\/376,512\/0\/default\.jpg$/.test(edgeTile), 'edge tiles are clamped to the image width');
    eq(await Nls.tileUrl(nlsRec, 26, 0, 5), '', 'a tile outside the grid resolves to an empty URL');

    fakeNlsInfoJson = {
        width: 2048, height: 1024,
        tiles: [{ width: 512, height: 512, scaleFactors: [1, 2, 4, 8] }]
    };
    const fetched = await Nls.resolve({ id: 'nls/910000001', source: 'nls', path: '91000/910000001' });
    eq(fetched.maxZoom, 3, 'without a hint the pyramid comes from the fetched info.json');
    const candidates = Nls.iiifBaseCandidates({ path: '91000/910000001' });
    eq(candidates.length, 3, 'the info lookup has the current and two legacy service paths');
    ok(candidates[0].indexOf('/iiif/2/') !== -1 && candidates[2].indexOf('/iiif/1/') !== -1,
        'the current /iiif/2 service is tried before the legacy paths');
    fakeNlsInfoJson = null;
    let resolveFailed = false;
    try {
        await Nls.resolve({ id: 'nls/910000009', source: 'nls', path: '91000/910000009' });
    } catch (e) { resolveFailed = true; }
    ok(resolveFailed, 'an unreachable info.json rejects so the overlay can apply its fallback size');
    fakeNlsInfoJson = { width: 2048, height: 1024, tiles: [{ scaleFactors: [1, 2, 4, 8] }] };

    const wfsUrl = decodeURIComponent(Nls.wfsBBoxUrl({ west: -3.3, south: 55.9, east: -3.1, north: 56.0 }));
    eq((wfsUrl.match(/nls:/g) || []).length, 12, 'the WFS query names every finder layer');
    eq((wfsUrl.match(/INTERSECTS/g) || []).length, 12, 'each layer gets its own INTERSECTS filter');
    ok(wfsUrl.indexOf('SRID=4326;POLYGON') !== -1 && wfsUrl.indexOf('maxFeatures=300') !== -1,
        'the bbox query is an EPSG:4326 polygon capped at 300 features');
    eq((wfsUrl.match(/the_geom/g) || []).length, 24,
        'the footprint column is both returned (propertyName) and filtered (CQL_INTERSECTS)');

    const sampleFeature = {
        id: 'OS_Town_Plans_Eng_non500_WFS.60',
        properties: { IMAGE: '228799835', SHEET: 'Accrington - Sheet 1, Surveyed: 1849,<br> Published: 1851', DATES: '', YEAR: '1851' },
        geometry: { type: 'MultiPolygon', coordinates: [[[[-2.3695, 53.7511], [-2.3695, 53.7568], [-2.3549, 53.7568], [-2.3549, 53.7511], [-2.3695, 53.7511]]]] }
    };
    const sampleRecord = Nls.featureToRecord(sampleFeature);
    eq(sampleRecord.id, 'nls/228799835', 'a WFS feature becomes an nls record');
    eq(sampleRecord.path, '22879/228799835', 'the record carries the IIIF path');
    eq(sampleRecord.place, 'Accrington', 'the place is the sheet-title prefix');
    eq(sampleRecord.year, 1851, 'the YEAR property is parsed');
    ok(Math.abs(sampleRecord.lat - 53.75395) < 1e-9 && Math.abs(sampleRecord.lng + 2.3622) < 1e-9,
        'the point is the footprint bbox centroid');
    const dated = Nls.featureToRecord({
        id: 'towns.7',
        properties: { IMAGE: '700000007', SHEET: 'Oldtown - Plan', DATES: 'Published 1872' },
        geometry: { type: 'Polygon', coordinates: [[[-3, 54], [-3, 54.1], [-2.9, 54.1], [-2.9, 54], [-3, 54]]] }
    });
    eq(dated.year, 1872, 'a missing YEAR falls back to the DATES text');
    eq(Nls.featureToRecord({ properties: { IMAGE: 'not-a-number' }, geometry: sampleFeature.geometry }), null,
        'a feature without a numeric viewer id is rejected');
    eq(Nls.stripHtml('a&nbsp;<br>b &amp; c'), 'a b & c', 'HTML in titles is flattened to text');
    ok(Nls.inCoverage(55.95, -3.19) && !Nls.inCoverage(46.77, 23.6), 'coverage accepts Scotland and rejects Romania');
    ok(Nls.intersectsCoverage({ west: -4, south: 55, east: -2, north: 56 }), 'an overlapping bbox is inside coverage');
    ok(!Nls.intersectsCoverage({ west: 20, south: 45, east: 28, north: 48 }), 'a Romanian bbox is outside coverage');

    fakeWfsJson = {
        type: 'FeatureCollection',
        features: [
            sampleFeature,
            Object.assign({}, sampleFeature, { properties: Object.assign({}, sampleFeature.properties, { IMAGE: '228799838' }) }),
            sampleFeature,
            { properties: { IMAGE: 'bad' }, geometry: sampleFeature.geometry }
        ]
    };
    const found = await Nls.queryBBox({ west: -3.3, south: 55.9, east: -3.1, north: 56.0 });
    eq(found.length, 2, 'queryBBox parses features, drops bad rows and de-duplicates viewer ids');
    fakeWfsJson = null;
    const realWarn = console.warn;
    console.warn = () => {};   // the failure path warns by design; keep the test output clean
    const failed = await Nls.queryBBox({ west: -3.3, south: 55.9, east: -3.1, north: 56.0 });
    console.warn = realWarn;
    eq(failed.length, 0, 'a failed finder query resolves to an empty list, never throws');

    /* ══ 11. the multi-source dispatcher ═══════════════════════════════ */
    eq(Tiles.source('nls'), Nls, 'the NLS adapter registered itself with the tile dispatcher');
    eq(await Tiles.tileUrl(nlsRec, 0, 0, 5), nativeTile, 'record objects route to the NLS adapter');
    eq(Tiles.thumbUrl(nlsRec), Nls.thumbUrl(nlsRec), 'thumbnails route to the NLS adapter');
    eq(Tiles.recordUrl(nlsRec), Nls.recordUrl(nlsRec), 'record links route to the NLS adapter');
    eq(Tiles.thumbUrl({ path: 'maps/mol/x/y.ecw' }),
        'https://static-cdn.hungaricana.hu/tile/thumb/maps/mol/x/y.ecw',
        'a sourceless record object stays on the Hungaricana path');
    eq(Tiles.recordUrl('MOLTerkeptar/2146'),
        'https://maps.hungaricana.hu/en/MOLTerkeptar/2146/view/', 'plain string ids stay on the Hungaricana path');

    /* ══ 12. the committed NLS seed catalogue ══════════════════════════ */
    const nlsCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/other-maps-nls-catalog.json'), 'utf8'));
    ok(Array.isArray(nlsCatalog.maps) && nlsCatalog.maps.length > 50, 'the NLS seed holds a substantial set of sheets');
    eq(nlsCatalog.sourceId, 'nls', 'the catalogue declares its source id');
    ok(/^https:\/\/map-view\.nls\.uk\/iiif\/2\/$/.test(nlsCatalog.iiifBase), 'the catalogue names the IIIF service');
    ok(/geoserver\.nls\.uk\/geoserver\/wfs$/.test(nlsCatalog.wfs), 'the catalogue names the finder WFS endpoint');
    const nlsIds = new Set();
    nlsCatalog.maps.forEach((entry) => {
        ok(/^nls\/\d+$/.test(entry.id), entry.id + ' is an nls record id');
        ok(!nlsIds.has(entry.id), entry.id + ' is unique');
        nlsIds.add(entry.id);
        ok(entry.path === Nls.iiifPath(entry.id.split('/')[1]), entry.id + ' carries the correct <prefix>/<id> IIIF path');
        ok(entry.source === 'nls', entry.id + ' is tagged with the nls source');
        ok(entry.lat >= Nls.COVERAGE.south && entry.lat <= Nls.COVERAGE.north, entry.id + ' sits inside the coverage latitude band');
        ok(entry.lng >= Nls.COVERAGE.west && entry.lng <= Nls.COVERAGE.east, entry.id + ' sits inside the coverage longitude band');
        ok(entry.place && entry.title, entry.id + ' carries a place and a title');
        ok(!entry.w || (entry.w > 0 && entry.h > 0), entry.id + ' has no implausible size hint');
    });

    const combined = OtherMaps.combineCatalogMaps(
        { maps: [{ id: 'H/1', path: 'maps/mol/h.ecw', lat: 47, lng: 23, place: 'Cluj-Napoca (RO)' }] },
        { sourceId: 'nls', maps: [{ id: 'nls/1', path: '00001/1', lat: 54, lng: -3, place: 'Testtown' }] }
    );
    eq(combined.length, 2, 'combineCatalogMaps merges both catalogues');
    eq(combined[0].source, 'hungaricana', 'Hungaricana rows are tagged by default');
    eq(combined[1].source, 'nls', 'NLS rows keep their source id');

    /* ══ 13. module integration: strings, live merge, labels ═══════════ */
    ok(OtherMaps.strings.ro.om_source_nls && OtherMaps.strings.en.om_source_nls && OtherMaps.strings.hu.om_source_nls,
        'the NLS source button is translated in all three languages');
    ok(/National Library of Scotland/.test(OtherMaps.sourceLabel({ source: 'nls' })),
        'the NLS badge label names the library');
    const beforeCount = OtherMaps.records().length;
    const liveRecord = {
        id: 'nls/920000002', nlsId: '920000002', source: 'nls', path: '92000/920000002',
        title: 'Liveworth - Sheet 1', place: 'Liveworth', lat: 53.8, lng: -2.4, year: 1899,
        provider: 'National Library of Scotland', collection: 'towns', precision: 'settlement'
    };
    ok(OtherMaps.mergeLiveRecords([liveRecord, liveRecord]), 'a new live sheet is accepted');
    ok(!OtherMaps.mergeLiveRecords([liveRecord]), 'a repeated live sheet is not added twice');
    OtherMaps.rebuildRecords();
    eq(OtherMaps.records().length, beforeCount + 1, 'the live sheet joined the shared record index');
    ok(OtherMaps.records().some((r) => r.id === 'nls/920000002' && r.source === 'nls'),
        'the merged record keeps its source tag');
    const cellKey = OtherMaps.nlsCellKey({ west: -3.3, south: 55.9, east: -3.1, north: 56.0 });
    ok(/^\d+\|-?\d+\|-?\d+$/.test(cellKey), 'the live-query cache key is zoom|latCell|lngCell');
    OtherMaps.scheduleNlsLive();   // Romania viewport: must no-op without throwing

    /* ══ 14. an NLS sheet through the overlay manager ══════════════════
     * The free-transform machinery is source-agnostic: an NLS record goes
     * through the same fit/frame path, and its <img> elements receive IIIF
     * region URLs rather than ECW hashes. */
    const nlsMap = fakeMap({ zoom: 12, size: { x: 400, y: 800 }, center: { lat: 53.754, lng: -2.362 } });
    const nlsMgr = Overlay.createManager(nlsMap, { pane: 'om_nls_pane', opacity: 0.8 });
    const nlsSheet = {
        id: 'nls/930000003', nlsId: '930000003', source: 'nls', path: '93000/930000003',
        lat: 53.754, lng: -2.362, w: 4096, h: 3072
    };
    const nlsOv = await nlsMgr.add(nlsSheet);
    await new Promise((r) => setImmediate(r));
    const nlsImgs = nlsOv.gridEl.children.filter((el) => el.tagName === 'IMG');
    ok(nlsImgs.length >= 1, 'the NLS sheet paints tile images');
    ok(nlsImgs.every((img) => /map-view\.nls\.uk\/iiif\/2\/93000%2F930000003\/.+\.jpg/.test(img.src || '')),
        'every NLS tile src is an IIIF region URL');
    const nlsFit = Overlay.fitScale(4096, 3072, Overlay.resolutionAt(53.754, 12), 400, 800);
    ok(Math.abs(nlsOv.state.mpp - nlsFit) / nlsFit < 1e-9, 'a fresh NLS sheet is framed into the viewport like any other');
    nlsMgr.remove('nls/930000003');

    const hungMap = fakeMap({ zoom: 12, size: { x: 400, y: 800 }, center: { lat: 47.933, lng: 23.892 } });
    const hungMgr = Overlay.createManager(hungMap, { pane: 'om_hung_pane', opacity: 0.8 });
    const hungSheet = { id: 'TST/NLS', path: 'maps/mol/s011/s11_0647/s11_0647.ecw', lat: 47.933, lng: 23.892, w: 4096, h: 3072 };
    const hungOv = await hungMgr.add(hungSheet);
    await new Promise((r) => setImmediate(r));
    const hungImgs = hungOv.gridEl.children.filter((el) => el.tagName === 'IMG');
    ok(hungImgs.length >= 1 && hungImgs.every((img) => /static-cdn\.hungaricana\.hu/.test(img.src || '')),
        'sourceless sheets still paint through the Hungaricana hash pyramid');
    hungMgr.remove('TST/NLS');

    /* ══ 15. finding and re-opening an added sheet ═══════════════════ */
    const fm = OtherMaps.state.map;          // the projMap attached in §7
    const fmgr = OtherMaps.state.manager;
    fm._state.zoom = 15;
    fm.fire('move');
    fm.fire('zoomend');
    await new Promise((r) => setImmediate(r));

    // The active sheet keeps its dashed border with align mode off, so a
    // sheet left at opacity 0 can be found again; the handles stay hidden.
    fmgr.setAlignMode(false);
    fmgr.setActive('TST/7');
    const ov7b = fmgr.get('TST/7');
    ok(ov7b.frameEl.style.display !== 'none', 'the active sheet keeps its dashed border with align mode off');
    ok(ov7b.handles.nw.style.display === 'none', 'the resize handles stay hidden outside align mode');
    ok(ov7b.georefEl.style.display === 'none', 'the georeference square stays hidden outside align mode');

    // A tap on the sheet hits the added map (container coordinates), so the
    // panel can be reopened by clicking the map that was added.
    fm.latLngToContainerPoint = (ll) => projectAt(ll, fm.getZoom())
        .subtract(originAt(fm.getZoom())).add(PANE_POS);
    const sheetPt = fm.latLngToContainerPoint({ lat: rec7.lat, lng: rec7.lng });
    eq(OtherMaps.overlayAtContainer(sheetPt).id, 'TST/7', 'a tap on the sheet lands on the added map');
    eq(OtherMaps.overlayAtContainer({ x: sheetPt.x + 100000, y: sheetPt.y + 100000 }), null,
        'a tap far from the sheet misses it');
    ok(OtherMaps.findAddedOverlay([{ id: 'TST/none' }, { id: 'TST/7' }]) === 'TST/7',
        'findAddedOverlay returns the first sheet already on the map');
    ok(OtherMaps.findAddedOverlay([{ id: 'TST/none' }]) === null,
        'findAddedOverlay returns null when nothing is added');

    // Clicking the added map reopens the panel: clear the green dots so the
    // tap resolves to the sheet, not to a place dot.
    OtherMaps.state.hits = [];
    fm.fire('click', { latlng: { lat: rec7.lat, lng: rec7.lng }, containerPoint: sheetPt });
    ok(OtherMaps.state.panel && OtherMaps.state.panel.classList.contains('show'),
        'clicking the added map reopens the panel');

    console.log('✓ other-maps: ' + checks + ' checks passed ' +
        ('(' + catalog.maps.length + ' Hungaricana + ' + nlsCatalog.maps.length + ' NLS catalogue records, ' +
            locations.length + ' Hungaricana places)'));
})().catch((err) => {
    console.error('✗ other-maps test failed:', err && err.message);
    process.exit(1);
});
