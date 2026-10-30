/*
 * test-sat60-live-location.js
 * ──────────────────────────────────────────────────────────────────────────
 * Regression test for the reported Android bug:
 *
 *   «"Satellite imagery 1960's" + live location = the whole map turns green,
 *    or it twitches/glitches badly while zooming between zoom levels.»
 *
 * The two features are individually fine; together they pushed the page into
 * the state that makes Android's compositor hand out garbage (a solid green
 * rectangle) or tear the tile panes apart:
 *
 *   A. ONE COMPOSITED SURFACE PER CORONA PRODUCT. Every CORONA tile layer was
 *      created with `opacity: 0.85`, which promotes each layer container to its
 *      own GPU surface. With up to 24 products in one pane, a zoom animation
 *      re-composites all of them every frame. The manager now supports
 *      `opacityTarget: 'pane'`: products stay opaque, the shared pane carries
 *      the opacity → ONE surface.
 *
 *   B. NO DEAD ZOOM BAND. `selectProducts()` gated on integer bands (8–11 and
 *      12–20). Any fractional zoom between 11 and 12 — which `flyTo()` (how the
 *      live-location button recentres the map) produces on every frame — fell
 *      into NEITHER band, so every product was detached and the pane went
 *      blank: the imagery visibly "twitched" between zoom levels.
 *
 *   C. ONE UPDATE PER GESTURE. A zoom fires zoomend AND moveend; the manager
 *      ran twice per gesture, detaching and re-attaching the whole stack twice
 *      within a few milliseconds.
 *
 *   D. THE PIN NEVER REBUILDS LAYERS PER FIX (covered in
 *      test-live-location-zoom.js), and the live-location code never touches
 *      the CORONA manager.
 *
 * Run:  node test-sat60-live-location.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let checks = 0;
let failures = 0;
function check(name, cond, detail) {
    checks++;
    if (cond) {
        console.log('  \u2713 ' + name);
    } else {
        failures++;
        console.error('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
    }
}
function eq(name, actual, expected) {
    check(name + ' (' + JSON.stringify(actual) + ')', actual === expected,
        'expected ' + JSON.stringify(expected));
}

const mapApp = fs.readFileSync(path.join(__dirname, 'js/map-app.js'), 'utf8');
const coronaLib = fs.readFileSync(path.join(__dirname, 'js/corona-wms-layer.js'), 'utf8');

/* The two blocks under test, cut out of the real file. */
const sat60Start = mapApp.indexOf('// ── SATELIT 60s');
const sat60End = mapApp.indexOf('window.setSatellite60sMapOpacity');
const sat60 = mapApp.slice(sat60Start, sat60End);

const liveStart = mapApp.indexOf('// ── CUSTOM LIVE LOCATION BUTTON ──');
const liveEnd = mapApp.indexOf('// ── PWA NEARBY-DETECTORISTS BUTTON');
const live = mapApp.slice(liveStart, liveEnd);

check('both blocks were located', sat60Start > 0 && sat60End > sat60Start &&
    liveStart > 0 && liveEnd > liveStart);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Behavioural: the real manager, fractional zooms, pane opacity
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] The manager: no dead zoom band, one composited surface');

function classExtend(proto) {
    function SubClass() { if (this.initialize) this.initialize.apply(this, arguments); }
    SubClass.prototype = Object.create(this.prototype || {});
    for (const k in proto) SubClass.prototype[k] = proto[k];
    return SubClass;
}
function WMSBase(url, options) { this._url = url; this.options = options || {}; }
WMSBase.extend = classExtend;
WMSBase.prototype = {
    initialize: function (url, options) { this._url = url; this.options = options || {}; },
    on: function () { return this; },
    off: function () { return this; },
    setOpacity: function (o) { this.options.opacity = o; return this; }
};
function LatLngBounds(a, b) {
    if (Array.isArray(a) && Array.isArray(a[0])) { b = a[1]; a = a[0]; }
    this.s = Math.min(a[0], b[0]); this.n = Math.max(a[0], b[0]);
    this.w = Math.min(a[1], b[1]); this.e = Math.max(a[1], b[1]);
}
LatLngBounds.prototype = {
    getSouth: function () { return this.s; },
    getNorth: function () { return this.n; },
    getWest: function () { return this.w; },
    getEast: function () { return this.e; },
    pad: function (f) {
        const dy = (this.n - this.s) * f, dx = (this.e - this.w) * f;
        return new LatLngBounds([this.s - dy, this.w - dx], [this.n + dy, this.e + dx]);
    }
};
function LayerGroup(layers) { this._set = new Set(layers || []); }
LayerGroup.prototype = {
    addLayer: function (l) { this._set.add(l); return this; },
    removeLayer: function (l) { this._set.delete(l); return this; },
    hasLayer: function (l) { return this._set.has(l); },
    size: function () { return this._set.size; }
};
const Lstub = {
    extend: function (t) {
        for (let i = 1; i < arguments.length; i++) {
            const s2 = arguments[i] || {};
            for (const k in s2) t[k] = s2[k];
        }
        return t;
    },
    TileLayer: { WMS: WMSBase },
    latLngBounds: function (a, b) { return new LatLngBounds(a, b); },
    layerGroup: function (l) { return new LayerGroup(l); },
    tileLayer: { wms: function (u, o) { return new WMSBase(u, o); } }
};
const sandbox = {
    console: { info: function () {}, warn: function () {}, error: function () {} },
    L: Lstub, encodeURIComponent: encodeURIComponent, Promise: Promise, Object: Object,
    setTimeout: setTimeout, clearTimeout: clearTimeout
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(coronaLib, sandbox, { filename: 'corona-wms-layer.js' });
const Atlas = sandbox.CoronaAtlas;

/* A strip over Romania with two frames, as the CAST catalogue has it. */
const catalogue = [{
    id: '1104-2155Fore', label: '1104-2155Fore', location: '1104-2155Fore',
    extent: [22.0, 44.0, 26.0, 48.0],
    rings: [[[22.0, 44.0], [26.0, 44.0], [26.0, 48.0], [22.0, 48.0], [22.0, 44.0]]],
    images: [
        { label: 'f1', location: '1104-2155df001', extent: [22.0, 44.0, 26.0, 46.0],
            rings: [[[22.0, 44.0], [26.0, 44.0], [26.0, 46.0], [22.0, 46.0], [22.0, 44.0]]] },
        { label: 'f2', location: '1104-2155df002', extent: [22.0, 46.0, 26.0, 48.0],
            rings: [[[22.0, 46.0], [26.0, 46.0], [26.0, 48.0], [22.0, 48.0], [22.0, 46.0]]] }
    ]
}];

const paneEl = { style: { opacity: '' } };
function makeManager(zoom, opts) {
    const group = Lstub.layerGroup([]);
    const map = {
        getZoom: function () { return zoom; },
        getBounds: function () { return new LatLngBounds([44.5, 23.0], [45.5, 25.0]); },
        getPane: function () { return paneEl; }
    };
    const manager = Atlas.createManager(map, Object.assign({ group: group }, opts || {}));
    manager.setCatalog(catalogue);
    return manager;
}

// ── A: fractional zooms must never empty the selection ───────────────────
[11, 11.2, 11.5, 11.8, 12, 11.999].forEach(function (z) {
    const active = makeManager(z).update();
    check('z' + z + ' selects a product (no dead band between 11 and 12)',
        active.length > 0, String(active.length));
});
// The atlas bands themselves are unchanged.
eq('z9 is a pass mosaic', makeManager(9).update()[0].type, 'pass');
eq('z13 is an individual frame', makeManager(13).update()[0].type, 'frame');
eq('z6 (overview) still requests nothing', makeManager(6).update().length, 0);
eq('z21 (past the pyramid) still requests nothing', makeManager(21).update().length, 0);

// ── B: pane opacity mode ────────────────────────────────────────────────
const paneManager = makeManager(13, { opacityTarget: 'pane', opacity: 0.85, pane: 'pane_sat60' });
paneManager.update();
const paneLayers = paneManager.getActiveLayers();
check('pane mode still attaches the products', paneLayers.length > 0, String(paneLayers.length));
check('every product stays fully opaque in pane mode',
    paneLayers.every(function (l) { return l.options.opacity === 1; }),
    paneLayers.map(function (l) { return l.options.opacity; }).join(','));
paneManager.setOpacity(0.4);
eq('the shared pane carries the opacity instead', paneEl.style.opacity, '0.4');
check('…and no product container is faded on its own',
    paneLayers.every(function (l) { return l.options.opacity === 1; }));

// Default mode is unchanged for any other caller.
const layerManager = makeManager(13, { opacity: 0.85 });
layerManager.update();
eq('default mode still fades each product layer',
    layerManager.getActiveLayers()[0].options.opacity, 0.85);
const el2 = { style: { opacity: '' } };
layerManager._map.getPane = function () { return el2; };
layerManager.setOpacity(0.5);
eq('default mode writes the layer opacity', layerManager.getActiveLayers()[0].options.opacity, 0.5);
eq('default mode never touches a pane', el2.style.opacity, '');

// ── C: the cache is bounded and drops the detached containers ───────────
const cacheManager = makeManager(9, { maxCachedLayers: 2 });
cacheManager.update();
eq('the working set is attached', cacheManager.getAttachedCount(), 1);
for (let i = 0; i < 12; i++) {
    // A different viewport each time → different products get cached.
    cacheManager._map.getBounds = function () {
        const lon = 23.0 + (i % 3) * 0.5;
        return new LatLngBounds([44.5, lon], [45.5, lon + 0.45]);
    };
    cacheManager.update();
}
check('the product cache never grows past maxCachedLayers',
    Object.keys(cacheManager._layers).length <= 2,
    String(Object.keys(cacheManager._layers).length));
check('eviction is device-tunable (maxCachedLayers option exists)',
    /maxCachedLayers/.test(coronaLib));

/* ══════════════════════════════════════════════════════════════════════════
 * 2. map-app: the sat60 stack is coalesced and pane-composited
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] js/map-app.js: gesture coalescing + pane compositing');

check('the Sat60 manager runs in pane-opacity mode',
    /opacityTarget:\s*["']pane["']/.test(sat60));
check('the pane itself receives the initial opacity',
    /getPane\(\s*["']pane_sat60["']\s*\)\.style\.opacity/.test(sat60));
check('moveend/zoomend go through the coalescing scheduler',
    /map\.on\(\s*["']moveend zoomend["'][\s\S]{0,120}_sat60RequestUpdate\(\)/.test(sat60));
check('the scheduler merges the burst into ONE manager.update()',
    /_sat60UpdateTimer\s*=\s*setTimeout\([\s\S]{0,600}_sat60On && _sat60Manager\) _sat60Manager\.update\(\)/
        .test(sat60));
check('a coalesced update never runs inside a zoom animation',
    /_sat60UpdateTimer = setTimeout[\s\S]{0,400}map\._animatingZoom[\s\S]{0,200}_sat60RequestUpdate\(\)/
        .test(sat60));
check('the layer list is not re-tiled on every move/zoom frame',
    !/map\.on\(\s*["'][^"']*\bmove\b[^"']*["']\s*,\s*function/.test(sat60) &&
    !/zoomanim/.test(sat60));
check('device-aware caps are still there (passes, frames, cache)',
    /maxActivePasses:\s*lowPower\s*\?/.test(sat60) &&
    /maxActiveFrames:\s*lowPower\s*\?/.test(sat60) &&
    /maxCachedLayers:\s*lowPower\s*\?/.test(sat60));
check('the opacity slider drives the pane in pane mode',
    /setSatellite60sMapOpacity[\s\S]{0,700}style\.opacity/.test(mapApp));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The two features never reach into each other
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] Live location and CORONA do not drive each other');

check('the live-location block never touches the CORONA manager',
    live.indexOf('_sat60Manager') === -1 &&
    live.indexOf('toggleSatellite60sMap') === -1 &&
    live.indexOf('CoronaAtlas') === -1);
check('the live-location block never forces a map move on its own',
    !/setView\(|panTo\(|setZoom\(/.test(live));
check('…it only centres once, through flyTo',
    (live.match(/flyTo\(/g) || []).length === 1);
check('the pin is updated in place (setLatLng), not re-added per fix',
    /locationMarker\.setLatLng\(/.test(live) &&
    !/function createMarker/.test(live));
check('a fix is coalesced into one animation frame',
    /requestAnimationFrame[\s\S]{0,200}_applyPendingFix\(\)/.test(live));
check('implausible (0,0) records are rejected before they touch the map',
    /lat === 0 && lng === 0/.test(live));
check('the accuracy circle radius is capped',
    /_ACC_MAX_R\s*=\s*\d+/.test(live) && /Math\.min\(accuracy, _ACC_MAX_R\)/.test(live));

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Over-budget pages shrink the CORONA stack (and get it back)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] The tile governor can shrink the attached CORONA products');

const tilePerfSrc = fs.readFileSync(path.join(__dirname, 'js/tile-perf.js'), 'utf8');

check('the governor broadcasts BOTH conservation transitions',
    /function enterConservationMode[\s\S]*?notifyConservationChange\(\);/.test(tilePerfSrc) &&
    /function exitConservationMode[\s\S]*?notifyConservationChange\(\);/.test(tilePerfSrc));
check('…through a public onConservationChange() hook',
    /onConservationChange:\s*function/.test(tilePerfSrc));
check('the layer can read the current state',
    /inConservationMode:\s*function/.test(tilePerfSrc));
check('Sat60 subscribes to the transition',
    /onConservationChange\(function \(\) \{[\s\S]{0,120}_sat60ApplyConservation\(\)/.test(sat60));
check('Sat60 halves its attached products while over budget',
    /Math\.round\(_sat60NormalCaps\.passes \/ 2\)/.test(sat60) &&
    /Math\.round\(_sat60NormalCaps\.frames \/ 2\)/.test(sat60));
check('…never below two products per kind',
    /Math\.max\(2, Math\.round\(_sat60NormalCaps\.passes/.test(sat60));
check('…and restores the normal caps afterwards',
    /: _sat60NormalCaps\.passes/.test(sat60) && /: _sat60NormalCaps\.frames/.test(sat60));
check('the back-off re-runs the selection so the extra layers really detach',
    /maxActiveFrames = frames;[\s\S]{0,220}_sat60RequestUpdate\(\)/.test(sat60));

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures > 0) {
    console.error(failures + ' FAILED');
    process.exit(1);
}
console.log('Satellite-60s × live-location interplay checks passed.');
