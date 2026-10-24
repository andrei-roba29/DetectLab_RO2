/*
 * test-map3d-mobile.js
 * ──────────────────────────────────────────────────────────────────────────
 * Guards the mobile fix for the 3D terrain view.
 *
 * THE BUG (iPhone Safari, mobile browser and installed PWA alike)
 *   Tapping “3D” made a dark rectangle flash once and the app snapped
 *   straight back to the 2D map, with no error anywhere.
 *
 * WHY
 *   MapLibre GL 5 acquires its WebGL context INSIDE the constructor and
 *   throws synchronously when it cannot:
 *
 *       gl = canvas.getContext("webgl2", e) || canvas.getContext("webgl", e);
 *       if (!gl) throw new Error("Failed to initialize WebGL");
 *
 *   On iOS Safari that happens on real hardware: the context was requested at
 *   the full devicePixelRatio (3 on a Face-ID iPhone → ~1170×2532 ≈ 3 Mpx)
 *   with powerPreference 'high-performance', after the page already holds
 *   every Leaflet tile image. WebKit refuses the allocation and returns null.
 *   A desktop GPU never hits that ceiling — hence “works on the laptop”.
 *
 *   The throw landed in open()'s catch, which removed `body.is-3d`. That class
 *   is what makes #map3d-surface display at all, and the veil carrying the
 *   error message lives INSIDE the surface — so the code hid the explanation
 *   it was trying to show. All the user ever saw was the flash.
 *
 * WHAT THIS TEST PINS DOWN
 *   1. the phone profile is asked for from the FIRST constructor call
 *      (pixelRatio / maxCanvasSize / canvasContextAttributes), not applied
 *      afterwards with setPixelRatio() — by which point WebKit has said no;
 *   2. a refused context is retried once in a stripped-down safe mode;
 *   3. a real failure stays ON SCREEN instead of hiding itself;
 *   4. WebGL is probed before 1 MB of SDK is downloaded;
 *   5. a lost GPU context is reported and recovered;
 *   6. the phone gets a longer SDK timeout and a smaller tile cache.
 *
 * Run:  node test-map3d-mobile.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] 3D on mobile — WebGL capability, phone profile, visible failures...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };
const viewer = read('js/map3d-terrain.js');
const registrySource = read('js/layer-registry.js');
const mirrorSource = read('js/map3d-mirror.js');
const skin = read('css/map3d-terrain.css');
const swJs = read('sw.js');
const indexHtml = read('index.html');

/* ══════════════════════════════════════════════════════════════════════════
 * 0. Everything must parse — a syntax error disables 3D entirely
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n[0] the sources parse');
[['js/map3d-terrain.js', viewer], ['js/layer-registry.js', registrySource],
 ['js/map3d-mirror.js', mirrorSource]].forEach(function (pair) {
    let err = null;
    try { new (require('vm').Script)(pair[1], { filename: pair[0] }); } catch (e) { err = e; }
    assert(err === null, pair[0] + ' parses' + (err ? ' — ' + err.message : ''));
});
console.log('  ✓ the viewer, the registry and the mirror parse as scripts');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Boot the viewer headless, in BOTH profiles
 * ══════════════════════════════════════════════════════════════════════════ */
console.log('\n[1] the viewer boots headless as a phone and as a desktop');

function boot(isMobile) {
    const stubElement = function () {
        return {
            style: {}, dataset: {}, children: [], checked: false, value: '',
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
            removeEventListener() {}, appendChild(c) { return c; }, removeChild() {},
            querySelector() { return stubElement(); }, querySelectorAll() { return []; },
            insertBefore(c) { return c; }, contains() { return false; }, focus() {}
        };
    };
    const documentStub = {
        readyState: 'complete',
        head: stubElement(), body: stubElement(), documentElement: stubElement(),
        createElement: stubElement, getElementById() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}
    };
    const windowStub = {
        document: documentStub,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener() {}, removeEventListener() {},
        matchMedia: function (q) {
            return { matches: isMobile && /max-width:\s*768px/.test(q), media: q,
                addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
        },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { onLine: true, maxTouchPoints: isMobile ? 5 : 0 },
        console: console
    };
    windowStub.window = windowStub;
    const sandbox = { window: windowStub, document: documentStub, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator };
    vm.createContext(sandbox);
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });
    return windowStub.DetectLabMap3D;
}

const phone = boot(true);
const desktop = boot(false);
assert(phone && desktop, 'window.DetectLabMap3D is exported in both profiles');

/* ── the device profile itself ─────────────────────────────────────────── */
const phoneProfile = phone._deviceProfile();
const desktopProfile = desktop._deviceProfile();

assert(phoneProfile.mobile === true, 'a 768px / touch device is detected as a phone');
assert(desktopProfile.mobile === false, 'a desktop is not treated as a phone');

assert(phoneProfile.pixelRatio === 1,
    'the phone asks for pixelRatio 1 (a 3× context is what iOS Safari refuses)');
assert(desktopProfile.pixelRatio === null,
    'the desktop leaves pixelRatio alone (MapLibre reads devicePixelRatio)');

assert(Array.isArray(phoneProfile.maxCanvasSize) && phoneProfile.maxCanvasSize[0] <= 2048,
    'the phone caps the drawing buffer at 2048px, not MapLibre’s 4096²');
assert(desktopProfile.maxCanvasSize === null, 'the desktop keeps MapLibre’s own canvas ceiling');

assert(phoneProfile.maxTileCacheSize < desktopProfile.maxTileCacheSize,
    'the phone keeps a smaller tile cache (' + phoneProfile.maxTileCacheSize +
    ' vs ' + desktopProfile.maxTileCacheSize + ') — 320 decoded tiles is ~80 MB of texture');

assert(phoneProfile.canvasContextAttributes.antialias === false,
    'the phone does not ask for 4× MSAA (it quadruples the colour buffer)');
assert(phoneProfile.canvasContextAttributes.powerPreference === 'low-power',
    'the phone asks for the low-power GPU, not "high-performance"');
assert(desktopProfile.canvasContextAttributes.antialias === true,
    'the desktop keeps antialiasing');
console.log('  ✓ phone profile: pixelRatio 1, 2048² canvas, ' + phoneProfile.maxTileCacheSize +
    ' tiles, no MSAA, low-power GPU');

/* ── the options that reach the constructor ────────────────────────────── */
console.log('\n[2] the phone profile is IN the constructor, not applied afterwards');

const phoneOptions = phone._mapOptions(false);
const safeOptions = phone._mapOptions(true);
const desktopOptions = desktop._mapOptions(false);

assert(phoneOptions.pixelRatio === 1,
    'the phone’s pixelRatio is passed to new maplibregl.Map() — the first GL context is created small');
assert(Array.isArray(phoneOptions.maxCanvasSize) && phoneOptions.maxCanvasSize[0] === 2048,
    'the phone’s canvas ceiling is passed to the constructor');
assert(phoneOptions.maxTileCacheSize === phoneProfile.maxTileCacheSize,
    'the phone’s tile cache is passed to the constructor');
assert(phoneOptions.canvasContextAttributes &&
       phoneOptions.canvasContextAttributes.antialias === false &&
       phoneOptions.canvasContextAttributes.powerPreference === 'low-power',
    'the phone’s GL attributes are passed as canvasContextAttributes');

assert(!('antialias' in phoneOptions),
    'no top-level antialias: MapLibre 5 only reads it under canvasContextAttributes');
assert(desktopOptions.canvasContextAttributes.antialias === true,
    'the desktop still gets antialiasing (the old top-level flag was silently ignored)');

/* The whole bug in one line: setPixelRatio() after the fact can only resize a
 * context that already had to be allocated at the device’s full ratio. */
assert(!/isMobile\(\) && typeof map\.setPixelRatio[\s\S]{0,120}mobilePixelRatio/.test(viewer),
    'the old "create at ×3, then setPixelRatio(1)" call is gone');
console.log('  ✓ the phone context is created small from the very first call');

/* ── the safe-mode retry ───────────────────────────────────────────────── */
console.log('\n[3] a refused context is retried once in safe mode');

assert(safeOptions.pixelRatio === 1, 'safe mode pins the pixel ratio to 1');
assert(safeOptions.maxCanvasSize[0] === 1024, 'safe mode shrinks the canvas to 1024²');
assert(safeOptions.maxTileCacheSize <= 32, 'safe mode drops the tile cache to 32');
assert(safeOptions.canvasContextAttributes.antialias === false, 'safe mode drops MSAA');
assert(safeOptions.canvasContextAttributes.stencil === false, 'safe mode drops the stencil buffer');
assert(!safeOptions.style.sky, 'safe mode drops the sky (decoration, not map)');
assert(!safeOptions.style.layers.some(function (l) { return l.type === 'hillshade'; }),
    'safe mode drops the hillshade pass');
assert(!!safeOptions.style.sources['detectlab-dem'] && !!safeOptions.style.terrain,
    'safe mode KEEPS the DEM — the relief is the reason 3D exists');

assert(/new maplibre\.Map\(buildMapOptions\(cam, profile, false\)\)/.test(viewer) &&
       /new maplibre\.Map\(buildMapOptions\(cam, profile, true\)\)/.test(viewer),
    'the constructor is called twice: full quality, then safe mode');
assert(/catch \(firstError\)/.test(viewer),
    'the throw from the first constructor is caught (MapLibre throws synchronously)');
console.log('  ✓ attempt 1 at full quality, attempt 2 stripped down, DEM always kept');

/* ── the failure the user can actually see ─────────────────────────────── */
console.log('\n[4] a failure stays on screen instead of hiding itself');

assert(/function fail3D\(/.test(viewer), 'there is one failure path');
const failBlock = viewer.slice(viewer.indexOf('function fail3D('),
    viewer.indexOf('function reportNoWebgl('));
assert(failBlock.length > 0, 'the failure path could be located');
assert(failBlock.indexOf("classList.remove('is-3d')") === -1,
    'fail3D() does NOT remove body.is-3d — that class is what makes #map3d-surface ' +
    '(and therefore the message) visible at all');
assert(/state\.open = false/.test(failBlock),
    'fail3D() still marks 3D closed, so the pill retries on the next tap');
assert(/t\('retry'\)/.test(failBlock) && /t\('back'\)/.test(failBlock),
    'fail3D() offers both "try again" and "back to 2D"');
assert(/state\.lastError = message/.test(failBlock),
    'fail3D() records the exact message so it can be quoted in a bug report');
assert(/showVeil\('error'/.test(failBlock), 'fail3D() shows the error veil');

/* close() is the only thing that may drop the class. */
const closeBlock = viewer.slice(viewer.indexOf('function close()'),
    viewer.indexOf('function toggle()'));
assert(closeBlock.indexOf("classList.remove('is-3d')") !== -1,
    'close() removes body.is-3d (the way back to the 2D map)');
assert(/state\.failed = false/.test(closeBlock), 'close() clears the failure flag');
console.log('  ✓ the message survives the failure; only close() clears the surface');

/* ── the veil can hold two buttons, and they are tappable ──────────────── */
console.log('\n[5] the error veil is reachable with a thumb');

assert(/class="m3d-veil-actions"/.test(viewer), 'the veil groups its actions');
assert(/class="m3d-veil-back"/.test(viewer), 'the veil has a "back to 2D" button');
assert(/m3d-veil-back'\)\.addEventListener\('click', function \(\) \{\s*close\(\);/.test(viewer),
    'the back button closes 3D (it does not retry)');
const phoneSkin = skin.slice(skin.indexOf('@media (max-width: 720px)'));
assert(phoneSkin.indexOf('min-height: 44px') !== -1,
    'the veil buttons get a 44px touch target on narrow screens');
assert(/#map3d-veil \.m3d-veil-detail[\s\S]{0,300}overflow-y: auto/.test(skin),
    'a long error message scrolls instead of pushing the buttons off-screen');
console.log('  ✓ two 44px buttons, scrollable detail, both inside the visible surface');

/* ── WebGL is probed before 1 MB is spent ──────────────────────────────── */
console.log('\n[6] WebGL is probed before the SDK is downloaded');

assert(/function webglProbe\(/.test(viewer), 'there is a WebGL probe');
assert(/function releaseGl\(gl\)/.test(viewer) &&
       /WEBGL_lose_context/.test(viewer) &&
       /WEBKIT_lose_context/.test(viewer) &&
       /result\.webgl2 = true; releaseGl\(gl\);/.test(viewer) &&
       /result\.webgl = true; releaseGl\(gl\);/.test(viewer),
    'the probe RELEASES its context — WebKit only allows a handful, and a leaked ' +
    'probe context could itself be the reason the real one is refused');
const openBlock = viewer.slice(viewer.indexOf('function open()'),
    viewer.indexOf('function fail3D('));
assert(openBlock.indexOf('webglProbe(true)') !== -1,
    'open() re-probes every time (a device that refused a context may grant one later)');
assert(openBlock.indexOf('webglProbe(true)') < openBlock.indexOf('loadMapLibre()'),
    'the probe runs BEFORE the 1 MB SDK download');
assert(/reportNoWebgl\(probe\)/.test(openBlock),
    'a device without WebGL gets an explanation instead of a flash');
assert(phone.status().webgl && typeof phone.status().webgl.webgl2 === 'boolean',
    'status() reports what the device supports');
console.log('  ✓ probe → message, and no 1 MB download for a device that cannot do 3D');

/* ── a lost context ────────────────────────────────────────────────────── */
console.log('\n[7] a lost GPU context is reported and recovered');

assert(/function watchContextLoss\(/.test(viewer), 'there is a context-loss watcher');
assert(/addEventListener\('webglcontextlost'/.test(viewer), 'context loss is handled');
assert(/addEventListener\('webglcontextrestored'/.test(viewer), 'context restore is handled');
assert(/state\.contextLost = false;[\s\S]{0,80}hideVeil\(\)/.test(viewer),
    'a restored context clears the message and redraws');
console.log('  ✓ the black-canvas-after-backgrounding case is now visible and recoverable');

/* ── timeouts and caches ───────────────────────────────────────────────── */
console.log('\n[8] the phone gets the time and memory it needs');

assert(/timeoutMsMobile/.test(registrySource),
    'the registry declares a separate SDK timeout for phones');
assert(/isMobile\(\) \? \(cfg\.timeoutMsMobile \|\| cfg\.timeoutMs \|\| 15000\)/.test(viewer),
    'the viewer uses the longer timeout on a phone (1 MB of JS on cellular)');
assert(/mobileMaxTileCacheSize/.test(registrySource), 'the registry declares the phone tile cache');
assert(/mobileMaxCanvas/.test(registrySource), 'the registry declares the phone canvas ceiling');
console.log('  ✓ longer SDK timeout, smaller tile cache, smaller canvas — on phones only');

/* ── the installed PWA actually receives the fix ───────────────────────── */
console.log('\n[9] installed PWAs are updated');

const shellVersion = Number((swJs.match(/CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert(shellVersion >= 196,
    'sw.js cache is v196 or newer so installed PWAs get the mobile fix (found v' + shellVersion + ')');
/* Each asset is versioned by whatever last changed it: the registry by the
 * WMS/WMTS audit, and the viewer + its skin by the 2D/3D switch moving into
 * the bottom-left control column, above the base-layer button. */
const TAGS = {
    'js/layer-registry.js': '20261024-uk-historical-maps',
    'js/map3d-terrain.js': '20261024-gesture-only-camera',
    'css/map3d-terrain.css': '20261024-gesture-only-camera',
    'js/danish-layers.config.js': '20261024-danish-heritage-proxy',
    'js/danish-layers.js': '20261019-danish-free-groups'
};
['js/map3d-terrain.js', 'js/layer-registry.js', 'css/map3d-terrain.css',
    'js/danish-layers.config.js', 'js/danish-layers.js'].forEach(function (asset) {
    const tag = TAGS[asset];
    assert(indexHtml.indexOf(asset + '?v=' + tag) !== -1,
        'index.html loads ' + asset + ' with the new cache-busting tag');
    assert(swJs.indexOf("'" + asset + "?v=" + tag + "'") !== -1,
        'sw.js pre-caches ' + asset + ' with the new tag');
});
console.log('  ✓ cache bumped and the new tagged assets are pre-cached');

console.log('\n✅ test-map3d-mobile.js passed all checks successfully.');
