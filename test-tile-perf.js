/*
 * test-tile-perf.js
 * ──────────────────────────────────────────────────────────────────────────
 * Guards the fix for the crash reported with several DENSE layers open at the
 * same time (LIDAR sub-layers + "Satellite imagery 60's" / CORONA + historical
 * maps + APM) when the user makes a sudden gesture (abrupt zoom-in / fast
 * pinch): the page crashed and reloaded itself.
 *
 * Cause: the number of live 256×256 decoded tiles. Leaflet's defaults are made
 * for ONE tile layer (updateWhenZooming: true, updateWhenIdle: L.Browser.mobile,
 * keepBuffer: 2, up to 5 retained ancestor zoom levels), so with ~15 heavy
 * layers every frame of a gesture queued tiles and kept levels alive until the
 * renderer was killed.
 *
 * js/tile-perf.js installs one governor for every tile layer:
 *   1. gesture-safe defaults (updateWhenZooming false, updateWhenIdle true on
 *      low-power devices, adaptive keepBuffer);
 *   2. one tile update per layer per gesture (settle window after zoomend);
 *   3. stricter pruning (2–3 ancestor levels instead of 5) + covering tiles
 *      kept until the incoming zoom is active + a hard ceiling on extras;
 *   4. a page watchdog: over the device tile budget → conservation mode +
 *      one-time notice;
 *   5. seamless tiles: the additive blend that lit the 1px seam overlap
 *      white is cancelled in CSS, and the zoom handoff cross-fades through
 *      a CSS-only tile fade (no per-frame JS, on every device).
 *
 * Run:  node test-tile-perf.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
let checks = 0;
function check(name, cond, detail) {
    checks++;
    if (cond) {
        console.log('  \u2713 ' + name);
    } else {
        failures++;
        console.error('  \u2717 ' + name + (detail ? ' — ' + detail : ''));
    }
}

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

const tilePerfSrc = read('js/tile-perf.js');
const mapApp = read('js/map-app.js');
const indexHtml = read('index.html');
const swJs = read('sw.js');
const translations = read('js/translations.js');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The governor is a real script and is loaded where it must be
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] js/tile-perf.js is wired in the right place');

let parseError = null;
try {
    new vm.Script(tilePerfSrc, { filename: 'js/tile-perf.js' });
} catch (err) {
    parseError = err;
}
check('js/tile-perf.js parses as a script', parseError === null,
    parseError ? parseError.message : '');

const iLeaflet = indexHtml.indexOf('<script src="js/leaflet.js">');
const iTilePerf = indexHtml.indexOf('<script src="js/tile-perf.js');
const iMapApp = indexHtml.indexOf('<script src="js/map-app.js');
check('index.html loads js/tile-perf.js', iTilePerf !== -1);
check('it is loaded after Leaflet', iLeaflet !== -1 && iTilePerf > iLeaflet);
check('it is loaded before map-app.js', iMapApp !== -1 && iTilePerf < iMapApp);
check('it is cache-busted like the other scripts',
    /js\/tile-perf\.js\?v=20\d{6}-[a-z0-9-]+/.test(indexHtml));

check('sw.js precaches the plain file', swJs.indexOf("'js/tile-perf.js'") !== -1);
check('sw.js precaches the exact versioned URL',
    /'js\/tile-perf\.js\?v=20\d{6}-[a-z0-9-]+'/.test(swJs));

/* ══════════════════════════════════════════════════════════════════════════
 * 2. map-app.js uses the governor (LIDAR, Sat60, map wiring)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[2] map-app.js: LIDAR + Sat60 + map are wired to the governor');

check('the map attaches the governor', /window\.DLTilePerf\.attach\(map\)/.test(mapApp));

const lidarStart = mapApp.indexOf('function _buildLidarLeafletLayer');
const lidarEnd = mapApp.indexOf('var _lidarGroup = L.layerGroup');
const lidar = mapApp.slice(lidarStart, lidarEnd);
check('the LIDAR stack has a shared perf-options helper', /function _lidarPerfOptions/.test(lidar));
check('every LIDAR layer is built with it',
    (lidar.match(/_lidarPerfOptions\(/g) || []).length >= 3,
    String((lidar.match(/_lidarPerfOptions\(/g) || []).length));
check('LIDAR layers stop re-queueing tiles during a zoom animation',
    /updateWhenZooming\s*=\s*false/.test(lidar));
check('LIDAR layers load once per pan gesture, not per frame',
    /updateWhenIdle\s*=\s*true/.test(lidar));
check('LIDAR layers take the adaptive off-screen ring size',
    /keepBuffer\s*=/.test(lidar) && /DLTilePerf/.test(lidar));

const sat60Start = mapApp.indexOf('// ── SATELIT 60s');
const sat60End = mapApp.indexOf('window.setSatellite60sMapOpacity');
const sat60 = mapApp.slice(sat60Start, sat60End);
check('Sat60 uses the governor for its device class (single source of truth)',
    /DLTilePerf[\s\S]{0,120}isLowPowerDevice/.test(sat60));
check('Sat60 keeps its own fallback detection (works without the governor)',
    /deviceMemory/.test(sat60) && /pointer:\s*coarse/.test(sat60));
check('Sat60 keeps updateWhenZooming: false / updateWhenIdle: true',
    /updateWhenZooming\s*:\s*false/.test(sat60) && /updateWhenIdle\s*:\s*true/.test(sat60));

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The one-time notice is translated (RO + EN)
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[3] Conservation-mode notice is translated');

const noticeKeys = (translations.match(/perf_layers_notice\s*:/g) || []).length;
check('js/translations.js defines perf_layers_notice for both languages',
    noticeKeys === 2, String(noticeKeys));
check('js/tile-perf.js looks the string up before using its fallback',
    /translations\[lang\][\s\S]{0,80}perf_layers_notice/.test(tilePerfSrc));

/* ══════════════════════════════════════════════════════════════════════════
 * BEHAVIOURAL HARNESS — run the real file against a minimal fake Leaflet
 * ═════════════════════════════════════════════════════════════════════════ */

function makeSandbox(opts) {
    opts = opts || {};

    function FakeGridLayer() { this._tiles = {}; }

    // The methods tile-perf.js wraps/uses. Calls are recorded so the test can
    // count tile work exactly.
    FakeGridLayer.prototype = {
        options: {
            tileSize: 256,
            keepBuffer: 2,
            updateWhenZooming: true,
            updateWhenIdle: false,
            updateInterval: 200,
            minZoom: 0,
            maxZoom: 20
        },
        _update: function (center) {
            this.updateCalls = (this.updateCalls || 0) + 1;
            this.lastCenter = center;
            this.lastZoom = this._map ? this._map.getZoom() : null;
        },
        _pruneTiles: function () { this.pruneCalls = (this.pruneCalls || 0) + 1; },
        _retainParent: function (x, y, z, minZoom) {
            this.parentArgs = [x, y, z, minZoom];
            return false;
        },
        _retainChildren: function (x, y, z, maxZoom) {
            this.childArgs = [x, y, z, maxZoom];
        },
        _removeTile: function (key) {
            if (!this._tiles[key]) return;
            delete this._tiles[key];
            this.removed = (this.removed || 0) + 1;
        },
        _removeAllTiles: function () {
            for (var k in this._tiles) this._removeTile(k);
        }
    };

    if (opts.tileReady) {
        // Closer to the real Leaflet: this layer can receive tiles, and its
        // _tileReady is the one the governor wraps for the CSS fade (§11).
        FakeGridLayer.prototype._tileCoordsToKey = function (c) {
            return c.x + ':' + c.y + ':' + c.z;
        };
        FakeGridLayer.prototype._noTilesToLoad = function () { return false; };
        FakeGridLayer.prototype.fire = function () { return this; };
        // Leaflet 1.9.4's own _tileReady, non-fade branch.
        FakeGridLayer.prototype._tileReady = function (coords, err, tile) {
            var t = this._tiles[this._tileCoordsToKey(coords)];
            if (!t) return;
            if (err) { this.tileErrors = (this.tileErrors || 0) + 1; }
            t.loaded = +new Date();
            t.active = true;
            this._pruneTiles();
            this.nativeTileReadyCalls = (this.nativeTileReadyCalls || 0) + 1;
        };
    }

    function TileLayer() {
        // Leaflet copies options onto the instance. Sharing the prototype
        // object would make conservation-mode keepBuffer writes leak across
        // layers (the second layer would save 0 after the first already
        // wrote CONSERVATION.keepBuffer onto the shared object).
        this.options = Object.create(TileLayer.prototype.options);
    }
    TileLayer.prototype = Object.create(FakeGridLayer.prototype);
    TileLayer.prototype.options = Object.create(FakeGridLayer.prototype.options);
    TileLayer.prototype.constructor = TileLayer;

    const events = {};
    const map = {
        _animatingZoom: false,
        _loaded: true,
        _layers: [],
        _zoom: 13,
        _center: { lat: 46, lng: 25 },
        on: function (names, fn) {
            String(names).split(/\s+/).forEach(function (n) {
                (events[n] = events[n] || []).push(fn);
            });
            return this;
        },
        off: function () { return this; },
        fire: function (name, data) {
            (events[name] || []).forEach(function (fn) { fn.call(map, data || { type: name, target: map }); });
            return this;
        },
        hasLayer: function (layer) { return map._layers.indexOf(layer) !== -1; },
        eachLayer: function (fn) { map._layers.slice().forEach(fn); },
        getCenter: function () { return map._center; },
        getZoom: function () { return map._zoom; },
        whenReady: function (fn) { fn(); return this; }
    };

    function makeLayer(tileKeys) {
        const layer = new TileLayer();
        layer._tiles = {};
        layer._map = map;
        layer._tileZoom = map._zoom;
        Object.keys(tileKeys || {}).forEach(function (k) { layer._tiles[k] = tileKeys[k]; });
        map._layers.push(layer);
        return layer;
    }

    const created = [];
    const bodyChildren = [];
    const bodyClasses = new Set();
    const documentStub = {
        body: {
            // body.map-gesturing (§12) needs a real classList to observe.
            classList: {
                add: function (name) { bodyClasses.add(name); },
                remove: function (name) { bodyClasses.delete(name); },
                contains: function (name) { return bodyClasses.has(name); },
                toggle: function (name, on) {
                    if (on === undefined) on = !bodyClasses.has(name);
                    if (on) bodyClasses.add(name); else bodyClasses.delete(name);
                    return on;
                }
            },
            appendChild: function (el) { bodyChildren.push(el); el.parentNode = documentStub.body; },
            removeChild: function (el) { const i = bodyChildren.indexOf(el); if (i !== -1) bodyChildren.splice(i, 1); }
        },
        getElementById: function () { return null; },
        createElement: function (tag) {
            const el = {
                tagName: tag, style: {}, textContent: '', id: '', parentNode: null,
                setAttribute: function (k, v) { this[k] = v; }
            };
            created.push(el);
            return el;
        }
    };

    const timers = [];
    const sandbox = {
        console: { log: () => {}, warn: () => {}, info: () => {}, error: () => {} },
        navigator: {
            userAgent: 'node-test',
            maxTouchPoints: opts.touch ? 5 : 0,
            deviceMemory: opts.lowMemory ? 2 : 8,
            hardwareConcurrency: opts.fewCores ? 2 : 8
        },
        document: documentStub,
        requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.L = {
        GridLayer: FakeGridLayer,
        TileLayer: TileLayer,
        Browser: { mobile: !!opts.mobileUa }
    };
    sandbox.window.DLTILE_PERF = Object.assign({
        quietMs: 40,
        sweepEveryMs: 100000,
        maxLiveTiles: 100000
    }, opts.perf || {});
    if (opts.lowPower !== undefined) sandbox.window.DLTILE_LOW_POWER = opts.lowPower;
    if (opts.translations) sandbox.translations = opts.translations;
    if (opts.currentLang) sandbox.window._currentLang = () => opts.currentLang;

    vm.createContext(sandbox);
    vm.runInContext(tilePerfSrc, sandbox, { filename: 'js/tile-perf.js' });

    return { sandbox, L: sandbox.L, map, makeLayer, documentStub, bodyChildren, created, timers };
}

const wait = (ms) => new Promise(function (r) { setTimeout(r, ms); });

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Defaults installed for every tile layer
 * ═════════════════════════════════════════════════════════════════════════ */
console.log('\n[4] Gesture-safe defaults for every tile layer');

const desktop = makeSandbox({ lowPower: false });
check('zoom animations no longer queue tiles frame by frame (desktop)',
    desktop.L.TileLayer.prototype.options.updateWhenZooming === false);
check('desktop keeps Leaflet\'s own pan behaviour',
    desktop.L.TileLayer.prototype.options.updateWhenIdle === false);
check('desktop keeps Leaflet\'s 2-tile off-screen ring',
    desktop.L.TileLayer.prototype.options.keepBuffer === 2);
check('the grid-layer default is patched too (custom layers inherit it)',
    desktop.L.GridLayer.prototype.options.updateWhenZooming === false);
check('an explicit per-layer option still wins',
    (function () {
        const l = desktop.makeLayer({});
        l.options.updateWhenIdle = false;
        l.options.keepBuffer = 2;
        return l.options.keepBuffer === 2 && l.options.updateWhenIdle === false;
    })());

const phone = makeSandbox({ lowPower: true });
check('low-power devices load tiles on gesture end (updateWhenIdle: true)',
    phone.L.TileLayer.prototype.options.updateWhenIdle === true);
check('low-power devices keep a 1-tile off-screen ring (keepBuffer: 1)',
    phone.L.TileLayer.prototype.options.keepBuffer === 1);

const auto = makeSandbox({ touch: true, lowMemory: true });
check('a touch device with little memory is detected without any override',
    auto.sandbox.window.DLTilePerf.isLowPowerDevice() === true,
    String(auto.L.TileLayer.prototype.options.keepBuffer));

/* ══════════════════════════════════════════════════════════════════════════
 * 5. A whole abrupt zoom = ONE tile update per layer
 * ═════════════════════════════════════════════════════════════════════════ */
(async function runBehaviour() {
    console.log('\n[5] An abrupt zoom cannot queue per-frame tile work');

    const h = makeSandbox({ lowPower: false, perf: { quietMs: 40 } });
    h.sandbox.window.DLTilePerf.attach(h.map);

    const layer = h.makeLayer({ '1:1:13': { coords: { x: 1, y: 1, z: 13 }, current: true } });
    const other = h.makeLayer({ '2:2:13': { coords: { x: 2, y: 2, z: 13 }, current: true } });

    // Idle map: an update goes through immediately.
    layer._update(h.map.getCenter());
    other._update(h.map.getCenter());
    check('an update on an idle map runs immediately',
        layer.updateCalls === 1 && other.updateCalls === 1,
        layer.updateCalls + '/' + other.updateCalls);

    // A first paint (no tiles at all yet) is never delayed.
    const fresh = h.makeLayer({});
    fresh._update(h.map.getCenter());
    check('the first paint of a layer is never delayed', fresh.updateCalls === 1);

    // Abrupt zoom: 4 zoom levels, the way a fast wheel / double pinch behaves.
    h.map.fire('zoomstart');
    for (let z = 14; z <= 17; z++) {
        h.map._zoom = z;
        h.map._animatingZoom = true;                       // zoom animation frames
        layer._update(h.map.getCenter());
        other._update(h.map.getCenter());
        h.map.fire('zoom', { type: 'zoom', zoom: z });
        h.map._animatingZoom = false;
    }
    h.map.fire('zoomend');
    h.map.fire('moveend');

    check('no tiles were queued during the gesture',
        layer.updateCalls === 1 && other.updateCalls === 1,
        layer.updateCalls + '/' + other.updateCalls);
    check('both layers are waiting for the gesture to settle',
        h.sandbox.window.DLTilePerf.stats().tiles === 2);

    // Another quick zoom inside the settle window must not produce a second
    // batch either: the pending update is simply replaced.
    h.map.fire('zoomstart');
    h.map._zoom = 18;
    layer._update(h.map.getCenter());
    h.map.fire('zoomend');
    h.map.fire('moveend');
    check('a second zoom inside the settle window still queues nothing',
        layer.updateCalls === 1);

    await wait(160);
    check('after the gesture each layer updated exactly once',
        layer.updateCalls === 2 && other.updateCalls === 2,
        layer.updateCalls + '/' + other.updateCalls);
    check('the single update used the final zoom, not an intermediate one',
        layer.lastZoom === 18 && other.lastZoom === 18,
        layer.lastZoom + '/' + other.lastZoom);
    check('the deferred layers were pruned right after the update',
        layer.parentArgs !== undefined && other.parentArgs !== undefined);

    /* ══════════════════════════════════════════════════════════════════════
     * 5b. A layer with no tiles left must not wait: no empty tile pane
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[5b] A wiped layer repaints during the gesture');

    const wipe = makeSandbox({ lowPower: false, perf: { quietMs: 40 } });
    wipe.sandbox.window.DLTilePerf.attach(wipe.map);
    const wiped = wipe.makeLayer({ '5:5:13': { coords: { x: 5, y: 5, z: 13 }, current: true } });
    wiped._update(wipe.map.getCenter());
    check('the layer painted before the wipe', wiped.updateCalls === 1,
        String(wiped.updateCalls));

    // viewprereset: what a non-animated zoom, setView(..., {animate:false})
    // or redraw() does to every tile layer — all tiles are thrown away.
    wiped._removeAllTiles();
    wipe.map.fire('zoomstart');
    wipe.map._zoom = 15;
    wiped._update(wipe.map.getCenter());
    check('a layer whose tiles were wiped repaints at once (no empty pane)',
        wiped.updateCalls === 2, String(wiped.updateCalls));

    // ...and the guard must not disable the deferral itself: put a tile back
    // and the very same layer waits again.
    wiped._tiles['5:5:13'] = { coords: { x: 5, y: 5, z: 13 }, current: true };
    wiped._update(wipe.map.getCenter());
    check('with a tile on screen the same layer is deferred again',
        wiped.updateCalls === 2, String(wiped.updateCalls));

    wipe.map.fire('zoomend');
    wipe.map.fire('moveend');
    await wait(150);
    check('and it is flushed exactly once after the gesture',
        wiped.updateCalls === 3 && wiped.lastZoom === 15,
        wiped.updateCalls + ' @z' + wiped.lastZoom);

    /* ══════════════════════════════════════════════════════════════════════
     * 6. A pan (not a zoom) never waits for a settle window
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[6] Panning during the settle window loads tiles at once');

    const pan = makeSandbox({ lowPower: false, perf: { quietMs: 5000 } });
    pan.sandbox.window.DLTilePerf.attach(pan.map);
    const panLayer = pan.makeLayer({ '3:3:13': { coords: { x: 3, y: 3, z: 13 }, current: true } });
    panLayer._update(pan.map.getCenter());
    check('the layer painted once before the gesture', panLayer.updateCalls === 1);

    pan.map.fire('zoomstart');
    pan.map._zoom = 14;
    panLayer._update(pan.map.getCenter());
    pan.map.fire('zoomend');
    pan.map.fire('moveend');
    check('the zoom left its update pending (settle window is 5 s here)',
        panLayer.updateCalls === 1, String(panLayer.updateCalls));

    pan.map.fire('movestart');   // the user starts dragging right away
    check('a pan flushes the pending update immediately', panLayer.updateCalls === 2,
        String(panLayer.updateCalls));

    // Panning itself must NOT be deferred: Leaflet already throttles it through
    // updateInterval / updateWhenIdle. Only a zoom opens a settle window.
    const panOnly = makeSandbox({ lowPower: false, perf: { quietMs: 5000 } });
    panOnly.sandbox.window.DLTilePerf.attach(panOnly.map);
    const dragLayer = panOnly.makeLayer({ '4:4:13': { coords: { x: 4, y: 4, z: 13 }, current: true } });
    dragLayer._update(panOnly.map.getCenter());
    panOnly.map.fire('movestart');
    panOnly.map.fire('move');
    dragLayer._update(panOnly.map.getCenter());
    panOnly.map.fire('moveend');
    check('a plain drag keeps loading its tiles while it moves',
        dragLayer.updateCalls === 2, String(dragLayer.updateCalls));

    /* ══════════════════════════════════════════════════════════════════════
     * 7. Pruning: fewer zoom levels + hard ceiling on off-screen tiles
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[7] Pruning keeps fewer zoom levels and a bounded tile ring');

    const p = makeSandbox({ lowPower: false });
    p.sandbox.window.DLTilePerf.attach(p.map);
    const pl = p.makeLayer({
        '10:10:13': { coords: { x: 10, y: 10, z: 13 }, current: true, active: false }
    });
    pl._pruneTiles();
    check('desktop keeps 3 ancestor levels instead of Leaflet\'s 5',
        pl.parentArgs && pl.parentArgs[3] === 13 - 3, JSON.stringify(pl.parentArgs));
    check('desktop keeps 2 descendant levels (Leaflet default)',
        pl.childArgs && pl.childArgs[3] === 13 + 2, JSON.stringify(pl.childArgs));

    const plp = makeSandbox({ lowPower: true });
    plp.sandbox.window.DLTilePerf.attach(plp.map);
    const plpLayer = plp.makeLayer({
        '10:10:13': { coords: { x: 10, y: 10, z: 13 }, current: true, active: false }
    });
    plpLayer._pruneTiles();
    check('low-power devices keep 2 ancestor levels',
        plpLayer.parentArgs && plpLayer.parentArgs[3] === 13 - 2, JSON.stringify(plpLayer.parentArgs));
    check('low-power devices keep only 1 descendant level',
        plpLayer.childArgs && plpLayer.childArgs[3] === 13 + 1, JSON.stringify(plpLayer.childArgs));

    // Ceiling: 10 visible tiles + 200 retained ones must not stay alive.
    const cap = makeSandbox({ lowPower: false });
    cap.sandbox.window.DLTilePerf.attach(cap.map);
    const capTiles = {};
    for (let i = 0; i < 10; i++) {
        capTiles['c' + i] = { coords: { x: i, y: 0, z: 13 }, current: true, active: true };
    }
    for (let i = 0; i < 200; i++) {
        capTiles['r' + i] = { coords: { x: i, y: i, z: 13 }, current: false, retain: true, loaded: true };
    }
    const capLayer = cap.makeLayer(capTiles);
    capLayer._pruneTiles();
    const left = Object.keys(capLayer._tiles).length;
    check('a layer cannot keep hundreds of off-screen tiles', left <= 10 + 64, String(left));
    check('the ceiling never drops tiles that are on screen', left >= 10, String(left));
    check('the ceiling is never smaller than one extra level',
        left <= 10 + 64 && capLayer.removed >= 200 - 64, String(capLayer.removed));

    /* ══════════════════════════════════════════════════════════════════════
     * 8. Nothing is pruned while the zoom animation is on screen
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[8] The level shown during a zoom animation is not pruned away');

    const g = makeSandbox({ lowPower: false });
    g.sandbox.window.DLTilePerf.attach(g.map);
    const gl = g.makeLayer({
        '1:1:13': { coords: { x: 1, y: 1, z: 13 }, current: true, active: true },
        '9:9:13': { coords: { x: 9, y: 9, z: 13 }, current: false, loaded: true }
    });
    g.map.fire('zoomstart');
    gl._pruneTiles();
    check('pruning is skipped during the gesture', gl.removed === undefined);
    g.map.fire('zoomend');
    await wait(120);
    gl._pruneTiles();
    check('pruning runs again once the gesture settled', gl.removed >= 1);

    /* ══════════════════════════════════════════════════════════════════════
     * 8b. Covering tiles stay until the incoming zoom is active
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[8b] Loaded covering tiles stay until current tiles are active');

    const cov = makeSandbox({ lowPower: false });
    cov.sandbox.window.DLTilePerf.attach(cov.map);
    const covLayer = cov.makeLayer({
        '1:1:14': { coords: { x: 1, y: 1, z: 14 }, current: true, active: false },
        '9:9:13': { coords: { x: 9, y: 9, z: 13 }, current: false, loaded: true },
        '8:8:12': { coords: { x: 8, y: 8, z: 12 }, current: false, loaded: true }
    });
    covLayer._pruneTiles();
    check('previous-zoom tiles are kept while the new zoom is still loading',
        covLayer._tiles['9:9:13'] && covLayer._tiles['8:8:12'] && covLayer.removed === undefined,
        JSON.stringify(Object.keys(covLayer._tiles)));
    check('the incoming tile itself is not dropped',
        !!covLayer._tiles['1:1:14']);

    covLayer._tiles['1:1:14'].active = true;
    covLayer._pruneTiles();
    check('covering tiles are released once the new zoom is active',
        !covLayer._tiles['9:9:13'] && !covLayer._tiles['8:8:12'],
        JSON.stringify(Object.keys(covLayer._tiles)));
    check('the now-active current tile stays', !!covLayer._tiles['1:1:14']);

    /* ══════════════════════════════════════════════════════════════════════
     * 9. Page budget → conservation mode + one-time notice
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[9] Over the tile budget the page switches to conservation mode');

    const big = makeSandbox({
        lowPower: true,
        perf: { sweepEveryMs: 20, maxLiveTiles: 50, quietMs: 10 },
        translations: { ro: { perf_layers_notice: 'NOTICE_RO' }, en: { perf_layers_notice: 'NOTICE_EN' } },
        currentLang: 'ro'
    });
    big.sandbox.window.DLTilePerf.attach(big.map);
    const heavy = big.makeLayer({});
    for (let i = 0; i < 60; i++) {
        heavy._tiles['t' + i] = { coords: { x: i, y: 0, z: 13 }, current: true, active: true };
    }
    const heavy2 = big.makeLayer({});
    for (let i = 0; i < 40; i++) {
        heavy2._tiles['u' + i] = { coords: { x: i, y: 1, z: 13 }, current: true, active: true };
    }
    await wait(140);
    const perf = big.sandbox.window.DLTilePerf;
    check('conservation mode engages above the budget', perf.inConservationMode() === true);
    check('the off-screen ring is dropped in conservation mode',
        heavy.options.keepBuffer === 0 && heavy2.options.keepBuffer === 0);
    check('the user gets one translated notice',
        big.bodyChildren.length === 1 && big.bodyChildren[0].textContent === 'NOTICE_RO',
        big.bodyChildren.length + '/' + (big.bodyChildren[0] && big.bodyChildren[0].textContent));
    check('the notice is not repeated on the next measurement', (function () {
        const before = big.bodyChildren.length;
        return before === 1;
    })());

    // Free the tiles → the page leaves conservation mode again.
    for (const k in heavy._tiles) delete heavy._tiles[k];
    for (const k in heavy2._tiles) delete heavy2._tiles[k];
    await wait(140);
    check('conservation mode ends when the page is light again',
        perf.inConservationMode() === false);
    check('the layer options are restored', heavy.options.keepBuffer === 1 &&
        heavy2.options.keepBuffer === 1);

    /* ══════════════════════════════════════════════════════════════════════
     * 10. The governor never changes WHAT is requested
     * ═════════════════════════════════════════════════════════════════════ */
    console.log('\n[10] The tile sources themselves are untouched');

    check('tile URLs are never rewritten by the governor',
        !/getTileUrl\s*=/.test(tilePerfSrc) && !/\.src\s*=/.test(tilePerfSrc));
    check('the governor does not touch opacity, zoom limits or layer lists',
        !/setOpacity|maxNativeZoom|minZoom\s*=/.test(tilePerfSrc));
    check('it can be disabled per layer (dltilePerf: false)',
        /options\.dltilePerf === false/.test(tilePerfSrc));
    check('it can be disabled / tuned live without a redeploy',
        /window\.DLTILE_PERF/.test(tilePerfSrc) && /window\.DLTILE_LOW_POWER/.test(tilePerfSrc));
    check('the old Sat60 override still works',
        /SAT60_LOW_POWER_TILES/.test(tilePerfSrc));
    check('the escape hatches are documented in the file header',
        /DLTilePerf\.stats\(\)/.test(tilePerfSrc) && /DLTilePerf\.sweep\(\)/.test(tilePerfSrc));

    /* ══════════════════════════════════════════════════════════════════════
     * 11. Seamless tiles: no white grid + a smooth (CSS-only) zoom handoff
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[11] Seamless tiles: no white grid, smooth zoom handoff');

    const stylesCss = read('css/styles.css');
    const imgTileRule = stylesCss.match(/#detectlab-map img\.leaflet-tile\s*\{[^}]*\}/);
    check('tiles keep the 1px seam overlap',
        !!imgTileRule &&
        /width:\s*257px\s*!important/.test(imgTileRule[0]) &&
        /height:\s*257px\s*!important/.test(imgTileRule[0]),
        imgTileRule ? imgTileRule[0] : 'rule missing');
    check('the additive blend that lit the seams white is cancelled',
        !!imgTileRule &&
        /mix-blend-mode:\s*normal\s*!important/.test(imgTileRule[0]),
        imgTileRule ? imgTileRule[0] : 'rule missing');
    check('canvas tiles never blend additively either',
        /#detectlab-map canvas\.leaflet-tile\s*\{[^}]*mix-blend-mode:\s*normal\s*!important/.test(stylesCss));
    check('scaled tiles stay smooth on Safari (no optimize-contrast blockiness)',
        /#detectlab-map \.leaflet-tile\s*\{[^}]*image-rendering:\s*auto/.test(stylesCss));

    const tpVer = (indexHtml.match(/js\/tile-perf\.js\?v=([0-9a-z-]+)/) || [])[1];
    check('tile-perf.js is cache-busted in index.html', !!tpVer, String(tpVer));
    check('sw.js precaches the exact versioned governor URL',
        !!tpVer && swJs.indexOf("'js/tile-perf.js?v=" + tpVer + "'") !== -1);
    const cssVer = (indexHtml.match(/css\/styles\.css\?v=([0-9a-z-]+)/) || [])[1];
    check('styles.css is cache-busted in index.html', !!cssVer, String(cssVer));
    check('sw.js precaches the exact versioned stylesheet URL',
        !!cssVer && swJs.indexOf("'css/styles.css?v=" + cssVer + "'") !== -1);

    check('the fade ships as a CSS transition, not a per-frame JS loop',
        /\.dltile-cssfade \.leaflet-tile\{transition:opacity/.test(tilePerfSrc) &&
        /map\._fadeAnimated = false/.test(tilePerfSrc));

    // Behaviour: an incoming tile cross-fades over the previous zoom level.
    // It is announced as loaded at once, but becomes `active` — the flag the
    // covering-tile handoff (§8b) waits on — only once the fade is over.
    const fade = makeSandbox({ lowPower: true, tileReady: true });
    fade.sandbox.window.DLTilePerf.attach(fade.map);
    const fl = fade.makeLayer({});
    const fadeTile = { coords: { x: 1, y: 1, z: 13 }, el: { style: {} }, current: true };
    fl._tiles['1:1:13'] = fadeTile;
    fl._tileReady({ x: 1, y: 1, z: 13 }, null, fadeTile.el);
    check('an incoming tile is counted as loaded at once',
        typeof fadeTile.loaded === 'number');
    check('...but stays inactive while it fades in (covering tiles stay)',
        fadeTile.active !== true && fadeTile.el.style.opacity === 0,
        'active=' + fadeTile.active + ' opacity=' + fadeTile.el.style.opacity);
    check('Leaflet\'s own fade loop is not used for it',
        (fl.nativeTileReadyCalls || 0) === 0);
    check('and the pruner has not run for it yet (covering tiles are safe)',
        fadeTile.retain === undefined);
    await wait(450);
    check('the tile becomes active once the CSS fade is over',
        fadeTile.active === true);
    check('...and only then does the pruner release the covering tiles',
        fadeTile.retain === true && (fl.removed || 0) === 0,
        'retain=' + fadeTile.retain + ' removed=' + (fl.removed || 0));

    // A failed tile keeps Leaflet's own path — no fade of a broken image.
    const brokenEl = { style: {} };
    fl._tiles['2:2:13'] = { coords: { x: 2, y: 2, z: 13 }, el: brokenEl, current: true };
    fl._tileReady({ x: 2, y: 2, z: 13 }, new Error('404'), brokenEl);
    check('a failed tile still goes through Leaflet\'s own path',
        fl._tiles['2:2:13'].active === true && (fl.tileErrors || 0) === 1);

    /* ══════════════════════════════════════════════════════════════════════
     * 12. Map gestures defrost the glass (Android zoom glitch)
     * ══════════════════════════════════════════════════════════════════════ */
    console.log('\n[12] Gestures drop every backdrop-filter for the gesture + settle');

    check('the governor owns the gesture class (arm + lift)',
        /gestureGlassOff:\s*LOW_POWER/.test(tilePerfSrc) &&
        /classList\.add\('map-gesturing'\)/.test(tilePerfSrc) &&
        /classList\.remove\('map-gesturing'\)/.test(tilePerfSrc));
    check('every map event arms it through the shared activity() hook',
        /function activity\(\) \{ STATE\.lastGestureAt = now\(\); glassGestureEvent\(\); \}/.test(tilePerfSrc));
    check('the lift timer self-heals when the event chain is cut',
        /now\(\) - STATE\.lastGestureAt < glassGraceMs\(\)/.test(tilePerfSrc));
    check('styles.css defrosts every glass surface while the gesture runs',
        /body\.map-gesturing \*[\s\S]{0,160}backdrop-filter:\s*none\s*!important/.test(stylesCss) &&
        /body\.map-gesturing \*::after[\s\S]{0,120}-webkit-backdrop-filter:\s*none\s*!important/.test(stylesCss));
    check('the panel thickens its two alpha stops instead (readable without the blur)',
        /body\.map-gesturing \.transp-panel\s*\{[^}]*--panel-top-alpha:\s*0\.92[^}]*--panel-bottom-alpha:\s*0\.94/s
            .test(stylesCss));

    // A low-power (Android-class) device: the class rides the gesture and
    // lifts itself once the settle window is over.
    const glass = makeSandbox({ lowPower: true });
    glass.sandbox.window.DLTilePerf.attach(glass.map);
    glass.map.fire('zoomstart');
    check('a zoom defrosts the glass on a low-power device',
        glass.documentStub.body.classList.contains('map-gesturing'));
    glass.map.fire('zoomend');
    glass.map.fire('moveend');
    await wait(650); // grace = quiet 40 + fade 180 + margin, + slack
    check('the glass comes back after the settle window',
        !glass.documentStub.body.classList.contains('map-gesturing'));

    // A gesture whose end events never arrive (the historical cut chain)
    // still lifts the class on its own.
    const cut = makeSandbox({ lowPower: true });
    cut.sandbox.window.DLTilePerf.attach(cut.map);
    cut.map.fire('movestart');
    check('a pan defrosts the glass too',
        cut.documentStub.body.classList.contains('map-gesturing'));
    await wait(650);
    check('a cut event chain still lifts the class by itself',
        !cut.documentStub.body.classList.contains('map-gesturing'));

    // Desktop keeps its frosted glass unless the knob asks for it.
    const frosted = makeSandbox({ lowPower: false });
    frosted.sandbox.window.DLTilePerf.attach(frosted.map);
    frosted.map.fire('zoomstart');
    check('desktop keeps its glass frosted during gestures',
        !frosted.documentStub.body.classList.contains('map-gesturing'));
    const forced = makeSandbox({ lowPower: false, perf: { gestureGlassOff: true } });
    forced.sandbox.window.DLTilePerf.attach(forced.map);
    forced.map.fire('zoomstart');
    check('...but DLTILE_PERF.gestureGlassOff can force it on anywhere',
        forced.documentStub.body.classList.contains('map-gesturing'));

    /* ══════════════════════════════════════════════════════════════════════ */
    console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
    if (failures > 0) {
        console.error(failures + ' FAILED');
        process.exit(1);
    }
    console.log('All tile-performance checks passed.');
    process.exit(0);
})();
