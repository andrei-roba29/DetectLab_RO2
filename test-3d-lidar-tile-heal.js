/*
 * test-3d-lidar-tile-heal.js
 * ───────────────────────────────────────────────────────────────────────────
 * Regression suite for the field report: “The 3D loading does not work for
 * 'Romania 1m/pixel agregare' and 'Romania 2–5m/pixel'. They appear for a
 * millisecond and then the basemap changes and only the basemap is visible
 * with no LiDAR.”
 *
 * The two named layers are the only CSS-blended LiDAR layers, and both are
 * served by tiles.arcgis.com through the viewer's fetchTile() and the
 * dl2d:// protocol. That path had three defects that only bite in
 * production (real MapLibre tile aborts, the real tile proxy), which is why
 * every local fake-tile harness showed a working disc:
 *
 *  1. A cancelled tile request was read as “this host has no CORS”.
 *     MapLibre aborts tile loads on every camera move / source reload, and
 *     the prefetch aborts its own tiles at its 45 s deadline. The abort
 *     landed in fetchTile's catch-all, marked tiles.arcgis.com proxied for
 *     the whole browser session (sessionStorage included) and retried with
 *     the same dead signal — so the tile failed anyway and every later
 *     tile of the Romanian pyramids paid the proxy hop.
 *  2. The registry declares tiles.arcgis.com CORS-serving / proxy “never”,
 *     but shouldProxy() let a (possibly poisoned) session verdict override
 *     the declaration, so the declaration never protected anyone.
 *  3. A proxy “blank” (a 1×1 transparent PNG with X-Map3D-Tile: blank,
 *     the function's answer to an upstream error/timeout) was treated as
 *     the tile itself: prime-cached, clip-cached and counted as prepared
 *     by the focus dialog. After (1) rerouted the prefetch through a cold
 *     proxy, the disc therefore “loaded” as a set of transparent nothings
 *     and 3D opened on the base map alone.
 *
 * Also pinned here:
 *  4. map-app.js called _lidarCanvasZoomOpen() without ever defining it:
 *     every LiDAR enable and every 2D zoomend with LiDAR visible threw a
 *     ReferenceError, cutting Leaflet's zoomend→moveend chain (tile
 *     refresh + the 3D live sync) and skipping the
 *     detectlab:lidar-visibility-changed dispatch the 3D disc listens for.
 *  5. The focus-disc outline (m3d-lidar-disc-line) is not a deck entry, so
 *     applyDeck's re-stack left it underneath the opaque m3d-background,
 *     where the “your disc is here” ring could never be seen.
 *
 * No network. jsdom + the real Leaflet / registry / mirror / viewer.
 * Usage: node test-3d-lidar-tile-heal.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

console.log('[Test] 3D LiDAR tile healing (aborts ≠ no-CORS, blanks ≠ tiles)…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const indexHtml = read('index.html');
const swJs = read('sw.js');
const mapApp = read('js/map-app.js');
const viewerSource = read('js/map3d-terrain.js');

const TAG = '20261026-lidar-whole-or-disc';

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

/* ════════════════════════════════════════════════════════════════════════
 * 1. Static wiring
 * ════════════════════════════════════════════════════════════════════════ */
{
    assert(indexHtml.includes('js/map3d-terrain.js?v=' + TAG), 'index.html loads the healed viewer build');
    assert(indexHtml.includes('js/map-app.js?v=' + TAG), 'index.html loads the map-app.js build with the zoom-gate helper');
    assert(swJs.includes("'js/map3d-terrain.js?v=" + TAG + "'"), 'sw.js pre-caches the healed viewer build');
    assert(swJs.includes("'js/map-app.js?v=" + TAG + "'"), 'sw.js pre-caches the map-app.js build');
    const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
    assert(shellVersion >= 268, 'the shell cache is bumped so installed PWAs pick the fix up (v' + shellVersion + ')');
    ok('index.html / sw.js carry the new builds (shell v' + shellVersion + ')');

    assert(/function _lidarCanvasZoomOpen\(\)/.test(mapApp),
        '_lidarCanvasZoomOpen is defined (it was only ever called)');
    ok('map-app.js defines _lidarCanvasZoomOpen — enabling LiDAR no longer throws');

    assert(/function isAbortError\(error\)/.test(viewerSource) && /if \(isAbortError\(error\)\) throw error;/.test(viewerSource),
        'fetchTile rethrows aborts instead of healing the host');
    assert(/registryHostPolicy\(host\) === 'never'\) return false;/.test(viewerSource),
        'shouldProxy honours a declared “never” over any session verdict');
    assert(/if \(fetched\.blank\) throw new Error/.test(viewerSource),
        'the prefetch refuses to count a proxy blank as a prepared tile');
    assert(/if \(tile\.blank\) return \{ data: MIRROR\.disc\.blankTile\(\) \};/.test(viewerSource) &&
           /if \(tileData\.blank\) return \{ data: MIRROR\.disc\.blankTile\(\) \};/.test(viewerSource),
        'both tile protocols serve a blank for one frame only, never into a cache');
    assert(/map\.moveLayer\(FOCUS_LINE\)/.test(viewerSource),
        'applyDeck lifts the focus-disc outline to the top of the deck');
    ok('viewer source carries the abort / never / blank / outline guards');
}

/* ════════════════════════════════════════════════════════════════════════
 * 2. The real modules with a scripted fetch
 * ════════════════════════════════════════════════════════════════════════ */
const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://detectlab.ro/'
});
const win = dom.window;
const ctx = dom.getInternalVMContext();

/* A programmable fetch: every call recorded, behaviour swapped per case. */
const fetchCalls = [];
let fetchBehaviour = null;
win.fetch = function (url, options) {
    fetchCalls.push(String(url));
    return fetchBehaviour(String(url), options || {}, fetchCalls.length);
};

vm.runInContext(read('js/leaflet.js'), ctx);
vm.runInContext(read('js/layer-registry.js'), ctx);
vm.runInContext(read('js/map3d-mirror.js'), ctx);
vm.runInContext(viewerSource, ctx);

const VIEWER = win.DetectLabMap3D;
assert(VIEWER && typeof VIEWER._fetchTile === 'function', 'the viewer exposes _fetchTile for the suite');
ok('Leaflet + registry + mirror + viewer load together');

const RO1M_TILE = 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/15/11704/18714';

function headers(map) {
    return { get: function (name) { return map[name] || null; } };
}
function okResponse(bytes, hdrs) {
    const data = new Uint8Array(bytes);
    return {
        ok: true, status: 200,
        headers: headers(hdrs || {}),
        arrayBuffer: function () { return Promise.resolve(data.buffer.slice(0)); },
        json: function () { return Promise.resolve({}); }
    };
}
function abortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

async function main() {
    /* ── case 1: a cancelled ro1m tile must not poison the host ───────── */
    fetchCalls.length = 0;
    win.sessionStorage.clear();
    fetchBehaviour = function () { return Promise.reject(abortError()); };
    let rejected = null;
    try { await VIEWER._fetchTile(RO1M_TILE, null, {}); } catch (error) { rejected = error; }
    assert(rejected && rejected.name === 'AbortError', 'the abort reaches the caller as an abort');
    assert.strictEqual(fetchCalls.length, 1,
        'an aborted tile is not retried (least of all through the proxy with the dead signal)');
    assert.strictEqual(fetchCalls[0], RO1M_TILE, '…and the one request went direct');
    assert.strictEqual(win.sessionStorage.getItem('dl3d.cors.tiles.arcgis.com'), null,
        'tiles.arcgis.com is NOT session-marked as CORS-less by a cancelled request');
    ok('a MapLibre-cancelled tile no longer moves tiles.arcgis.com onto the proxy');

    /* ── case 2: a poisoned session verdict cannot reroute a “never” host ─ */
    fetchCalls.length = 0;
    win.sessionStorage.setItem('dl3d.cors.tiles.arcgis.com', '0');   /* legacy poison */
    fetchBehaviour = function () { return Promise.resolve(okResponse(2048)); };
    const tile = await VIEWER._fetchTile(RO1M_TILE, null, {});
    assert.strictEqual(fetchCalls[0], RO1M_TILE,
        'a declared CORS host is fetched direct even with a poisoned session cache');
    assert.strictEqual(tile.data.byteLength, 2048, 'the direct bytes are handed over');
    assert.strictEqual(tile.blank, false, '…flagged as a real tile, not a blank');
    ok('the registry “never proxy” verdict beats a stale session verdict');

    /* ── case 3: genuine no-CORS healing still works for unknown hosts ─── */
    fetchCalls.length = 0;
    win.sessionStorage.clear();
    fetchBehaviour = function (url) {
        if (url.indexOf('/api/map3d/tile?u=') === 0) return Promise.resolve(okResponse(1024));
        return Promise.reject(new TypeError('Failed to fetch'));
    };
    const healed = await VIEWER._fetchTile('https://wms.example.test/service?request=GetMap', null, {});
    assert.strictEqual(fetchCalls.length, 2, 'an unknown host that truly fails is retried once');
    assert(fetchCalls[1].indexOf('/api/map3d/tile?u=') === 0, '…through the tile proxy');
    assert.strictEqual(healed.data.byteLength, 1024, '…and the proxied bytes arrive');
    assert.strictEqual(win.sessionStorage.getItem('dl3d.cors.wms.example.test'), '0',
        '…with the verdict remembered for the session, as designed');
    ok('real CORS healing is unchanged for hosts the registry does not declare');

    /* ── case 4: a proxy blank resolves as blank, not as pixels ────────── */
    fetchBehaviour = function () {
        return Promise.resolve(okResponse(68, { 'X-Map3D-Tile': 'blank', 'X-Map3D-Upstream': 'error' }));
    };
    const blank = await VIEWER._fetchTile('https://wms.example.test/tile.png', null, {});
    assert.strictEqual(blank.blank, true, 'a blank proxy answer is flagged as blank');
    ok('fetchTile flags X-Map3D-Tile: blank answers');

    /* ── case 5: the prefetch never counts (or caches) a blank ─────────── */
    fetchCalls.length = 0;
    fetchBehaviour = function () {
        return Promise.resolve(okResponse(68, { 'X-Map3D-Tile': 'blank', 'X-Map3D-Upstream': 'error' }));
    };
    const report = await VIEWER.prefetchTiles([{
        route: 'url', url: RO1M_TILE, layerKey: '2d.1', z: 15, x: 18714, y: 11704, preferProxy: true
    }], {});
    assert.strictEqual(report.prepared, 0, 'a blank is not “prepared”');
    assert.strictEqual(report.failed, 1, '…it is honestly counted as failed');
    assert.strictEqual(VIEWER.isPrepared(RO1M_TILE, '2d.1'), false, '…and nothing was cached as the tile');
    ok('a proxy blank can no longer pose as a prepared LiDAR disc');

    /* ── case 6: a real tile still prepares ────────────────────────────── */
    fetchBehaviour = function () { return Promise.resolve(okResponse(4096)); };
    const good = await VIEWER.prefetchTiles([{
        route: 'url', url: RO1M_TILE, layerKey: '2d.1', z: 15, x: 18714, y: 11704
    }], {});
    assert.strictEqual(good.prepared, 1, 'a real tile prepares');
    assert.strictEqual(good.failed, 0, '…with no failures');
    ok('the happy path is untouched');

    console.log('[Test] 3D LiDAR tile healing: ' + passed + ' groups passed.');
    win.close();
    process.exit(0);
}

main().catch(function (error) {
    console.error(error && error.stack || error);
    try { win.close(); } catch (e) { /* ignore */ }
    process.exit(1);
});
