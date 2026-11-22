// Regression suite for the 3D two-finger twist (installTouchTwist).
//
// The viewer's built-in MapLibre two-finger rotate was replaced by a
// Google-Earth-style twist that turns the camera AROUND THE MAP'S CENTRE —
// map.setBearing is never accompanied by a pan, so turning the map can never
// jump it to another location. This file protects:
//   1. a pinch (spread changes > 6% before engagement) is never a turn;
//   2. a deliberate twist engages BEFORE the pinch gate — the natural few
//      percent of spread drift it carries must not swallow the turn;
//   3. an engaged twist still dies the moment it becomes a real pinch
//      (> 18% spread drift from the engage frame), and never resumes;
//   4. the arc deadband (a real-pixel travel, clamped 8°–45°) and the 64 px
//      minimum finger spacing gate the twist;
//   5. the iOS Safari gesture path gets the same model through a degree
//      deadband (12°) + scale gate instead of the arc test;
//   6. rotation is reachable ONLY through setBearing — no pan/center/ease call
//      may ever reach the map, and the twist owns the gesture: MapLibre’s own
//      two-finger zoom is disabled for the whole twist (its midpoint pivot
//      is the reported “teleport” bug) and restored when the twist ends;
//   7. the listeners are removed when the map is removed (no leaks).
//
// Usage: node test-map3d-touch-twist.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] 3D touch twist — pinch stays zoom, twist turns the centre...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };
const viewer = read('js/map3d-terrain.js');
const registrySource = read('js/layer-registry.js');
const mirrorSource = read('js/map3d-mirror.js');

/* ── headless viewer boot (same minimal pattern as test-map3d-terrain.js §5) ── */
function stubElement() {
    return {
        style: {}, dataset: {}, children: [], checked: false, value: '',
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; },
        appendChild(c) { return c; }, removeChild() {}, insertBefore(c) { return c; },
        querySelector() { return stubElement(); }, querySelectorAll() { return []; },
        contains() { return false; }, focus() {}
    };
}
const documentStub = {
    readyState: 'complete',
    head: stubElement(), body: stubElement(), documentElement: stubElement(),
    createElement() { return stubElement(); },
    getElementById() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
        const list = this._listeners[type] || [];
        const at = list.indexOf(fn);
        if (at !== -1) list.splice(at, 1);
    },
    dispatch(type, event) {
        (this._listeners[type] || []).slice().forEach((fn) => fn(event));
    }
};
const windowStub = {
    document: documentStub,
    Blob: Blob, URL: URL, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: function () { return 0; }, clearInterval: function () {},
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: { onLine: true },
    console: console
};
windowStub.window = windowStub;
const sandbox = { window: windowStub, document: documentStub, console: console,
    Blob: Blob, URL: URL, Promise: Promise,
    setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator };
vm.createContext(sandbox);
vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });
const api = windowStub.DetectLabMap3D;
assert(api && typeof api._installTouchTwist === 'function', 'the viewer exposes _installTouchTwist');

/* ── fake map / container ─────────────────────────────────────────────────── */
const SAFE_MAP_METHODS = ['getCanvasContainer', 'on', 'off', 'getBearing', 'setBearing', 'fire'];
function touchPt(x, y) { return { clientX: x, clientY: y }; }
function pairAt(cx, cy, angleDeg, dist) {
    const rad = angleDeg * Math.PI / 180;
    const dx = Math.cos(rad) * dist / 2;
    const dy = Math.sin(rad) * dist / 2;
    return [touchPt(cx + dx, cy + dy), touchPt(cx - dx, cy - dy)];
}
function scenario() {
    const calls = [];          /* every method the twist touches, in order */
    const state = {
        bearing: 0, setBearingCalls: [], moveendCount: 0,
        onRemove: [], removed: false, nativeDisabled: false
    };
    const container = {
        _listeners: {},
        getBoundingClientRect: function () { return { left: 0, top: 0, width: 800, height: 600 }; },
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const list = this._listeners[type] || [];
            const at = list.indexOf(fn);
            if (at !== -1) list.splice(at, 1);
        },
        dispatch(type, event) {
            (this._listeners[type] || []).slice().forEach((fn) => fn(event));
        }
    };
    const raw = {
        getCanvasContainer() { calls.push('getCanvasContainer'); return container; },
        getBearing() { calls.push('getBearing'); return state.bearing; },
        setBearing(deg) {
            calls.push('setBearing');
            state.bearing = deg;
            state.setBearingCalls.push(deg);
        },
        on(type, fn) {
            calls.push('on');
            if (type === 'remove') state.onRemove.push(fn);
            return raw;
        },
        off(type, fn) {
            calls.push('off');
            if (type === 'remove') {
                const at = state.onRemove.indexOf(fn);
                if (at !== -1) state.onRemove.splice(at, 1);
            }
            return raw;
        },
        fire(type) {
            calls.push('fire');
            if (type === 'remove') {
                state.onRemove.slice().forEach((fn) => fn());
                state.removed = true;
            }
            if (type === 'moveend') state.moveendCount += 1;
        },
        touchZoomRotate: {
            disable() { calls.push('touchZoomRotate.disable'); state.nativeDisabled = true; },
            enable() { calls.push('touchZoomRotate.enable'); state.nativeDisabled = false; }
        }
    };
    /* The fake is deliberately pan-LESS: get/set on any property the twist
     * never calls must come back undefined, so a stray pan would throw. */
    const map = new Proxy(raw, {
        get(target, prop) {
            if (prop in target) return target[prop];
            calls.push('get:' + String(prop));
            return undefined;
        }
    });
    /* Reset the shared document stub for the scenario — the installer reads
     * `document` from its closure, so listeners must not leak across runs. */
    documentStub._listeners = {};
    api._installTouchTwist(map);
    return { map, container, calls, state };
}

function fireTouchStart(s, frame0) {
    s.container.dispatch('touchstart', { touches: frame0, preventDefault() {} });
}
function fireTouchMove(s, frame) {
    documentStub.dispatch('touchmove', { touches: frame, preventDefault() {} });
}
function fireTouchEnd(s) {
    documentStub.dispatch('touchend', { touches: [], preventDefault() {} });
}
function fireGesture(s, type, evt) {
    s.container.dispatch(type, Object.assign({ preventDefault() {} }, evt));
}
function runTwoFinger(s, frames) {
    fireTouchStart(s, frames[0]);
    for (let i = 1; i < frames.length; i += 1) fireTouchMove(s, frames[i]);
    fireTouchEnd(s);
}
const framesFrom = function (angles, dists) {
    return angles.map(function (a, i) { return pairAt(400, 300, a, dists[i]); });
};

/* ── 1. a pinch is a zoom, never a turn ──────────────────────────────────── */
{
    const s = scenario();
    runTwoFinger(s, framesFrom([0, 3, -4, 2, -3, 5], [100, 112, 128, 150, 175, 210]));
    assert.strictEqual(s.state.bearing, 0, 'a pinch-zoom with jitter must not rotate (got ' + s.state.bearing + ')');
    assert.strictEqual(s.state.setBearingCalls.length, 0, 'no setBearing call during a pure pinch');
    console.log('  ✓ a pinch stays a zoom (no rotation at all)');
}

/* ── 2. a deliberate twist engages and turns 1:1 from 0° ────────────────────
 * MapLibre counts the bearing the other way from the CSS rotation (see
 * bearingFlip in js/map3d-terrain.js): a clockwise sweep of the fingers must
 * turn the view clockwise, which is a NEGATIVE bearing. The sign of the
 * twist is part of the contract — this is the regression that made turning
 * feel inverted. */
{
    const s = scenario();
    runTwoFinger(s, framesFrom([0, 12, 25, 40, 60], [150, 150, 150, 150, 150]));
    assert(s.state.bearing < 0, 'the sign must match the fingers — a clockwise sweep must not turn the view the other way (got ' + s.state.bearing + ')');
    assert(Math.abs(s.state.bearing + 35) < 0.5,
        'a deliberate twist turns from 0° at the engage frame (-35° expected, got ' + s.state.bearing + ')');
    assert(s.state.setBearingCalls.length > 0 && Math.abs(s.state.setBearingCalls[0] - 0) < 0.5,
        'a twist must start at 0° when it engages — no jump at engage');
    assert(s.state.moveendCount >= 1, 'releasing an engaged twist fires moveend');
    console.log('  ✓ a deliberate twist turns 1:1 from 0°');
}

/* ── 3. the natural spread drift of a deliberate twist does not swallow it ──── */
{
    const s = scenario();
    runTwoFinger(s, framesFrom([0, 7, 15, 30, 45], [150, 158, 165, 160, 170]));
    assert(Math.abs(s.state.bearing + 30) < 0.5,
        'a deliberate twist with natural spread drift engages and turns (-30° expected, got ' + s.state.bearing + ')');
    console.log('  ✓ natural spread drift of a twist does not swallow the turn');
}

/* ── 4. an engaged twist still dies on a real pinch, and never resumes ────── */
{
    const s = scenario();
    runTwoFinger(s, framesFrom([0, 15, 25, 32, 50], [150, 150, 155, 185, 185]));
    assert(Math.abs(s.state.bearing + 10) < 0.5,
        'the turn dies the moment the spread turns into a real pinch (-10° expected, got ' + s.state.bearing + ')');
    assert(s.state.moveendCount >= 1, 'the twist abort fires moveend');
    console.log('  ✓ an engaged twist still dies on a real pinch, and never resumes');
}

/* ── 5. the arc deadband and the 64 px minimum spacing gate the twist ──────── */
{
    const s = scenario();
    /* 40 px spacing < 64 px: the angle is noise — nothing may turn. */
    runTwoFinger(s, framesFrom([0, 40, 90], [40, 40, 40]));
    assert.strictEqual(s.state.bearing, 0, 'fingers under 64 px apart never rotate');

    /* ~19.4° deadband at 100 px: light wiggles stay put. */
    const s2 = scenario();
    runTwoFinger(s2, framesFrom([0, 3, 5, 8], [100, 100, 100, 100]));
    assert.strictEqual(s2.state.bearing, 0, 'a wiggle under the arc deadband never turns the map');
    console.log('  ✓ the arc deadband and the 64 px minimum spacing gate the twist');
}

/* ── 6. the iOS gesture path: degree deadband + scale gate ─────────────────── */
{
    const s = scenario();
    fireGesture(s, 'gesturestart', { rotation: 0, scale: 1 });
    fireGesture(s, 'gesturechange', { rotation: 5, scale: 1 });
    assert.strictEqual(s.state.bearing, 0, 'a 5° gesture rotation stays under the 12° deadband');
    fireGesture(s, 'gesturechange', { rotation: 14, scale: 1 });
    fireGesture(s, 'gesturechange', { rotation: 20, scale: 1.02 });
    fireGesture(s, 'gesturechange', { rotation: 30, scale: 1.04 });
    fireGesture(s, 'gestureend', {});
    assert(Math.abs(s.state.bearing + 16) < 0.5,
        'a deliberate iOS twist turns 1:1 past the deadband (-16° expected, got ' + s.state.bearing + ')');
    assert(s.state.moveendCount >= 1, 'gestureend of an engaged twist fires moveend');

    const s2 = scenario();
    fireGesture(s2, 'gesturestart', { rotation: 0, scale: 1 });
    fireGesture(s2, 'gesturechange', { rotation: 5, scale: 1.2 });
    assert.strictEqual(s2.state.bearing, 0, 'a gesture pinch below the deadband must not rotate');
    fireGesture(s2, 'gestureend', {});
    console.log('  ✓ the iOS gesture path obeys the same model (deadband + scale gate)');
}

/* ── 7. an engaged gesture twist dies on a real pinch, and never resumes ───── */
{
    const s = scenario();
    fireGesture(s, 'gesturestart', { rotation: 0, scale: 1 });
    fireGesture(s, 'gesturechange', { rotation: 14, scale: 1 });
    fireGesture(s, 'gesturechange', { rotation: 18, scale: 1.2 });
    fireGesture(s, 'gesturechange', { rotation: 30, scale: 1.2 });
    const moveendBefore = s.state.moveendCount;
    fireGesture(s, 'gestureend', {});
    assert.strictEqual(s.state.bearing, 0, 'an engaged gesture twist that becomes a real pinch stops dead');
    assert(moveendBefore >= 1, 'the gesture pinch abort fires moveend');
    console.log('  ✓ an engaged gesture twist dies on a real pinch, and never resumes');
}

/* ── 8. rotation is reachable only through setBearing ──────────────────────── */
{
    const s = scenario();
    runTwoFinger(s, framesFrom([0, 20, 40, 60], [150, 150, 150, 150]));
    const used = s.calls.filter((c) => c !== 'getCanvasContainer' && c !== 'on' && c !== 'off');
    assert.deepStrictEqual(Array.from(new Set(used)).sort(),
        ['fire', 'getBearing', 'setBearing', 'touchZoomRotate.disable', 'touchZoomRotate.enable'],
        'the twist may only touch setBearing, the native zoom off (never a pan/center call): ' + JSON.stringify(used));
    assert(!used.some((c) => c.indexOf('get:') === 0),
        'the twist never reads pan/center/ease-related properties: ' + JSON.stringify(used));
    console.log('  ✓ rotation never pans the view — the twist touches setBearing and nothing else');
}

/* ── 9. the listeners go away when the map is removed ──────────────────────── */
{
    const s = scenario();
    const docTouchMove = (documentStub._listeners.touchmove || []).length;
    const containerTouchStart = (s.container._listeners.touchstart || []).length;
    s.map.fire('remove');
    assert.strictEqual((documentStub._listeners.touchmove || []).length, docTouchMove - 1,
        'touchmove is removed from the document');
    assert.strictEqual((s.container._listeners.touchstart || []).length, containerTouchStart - 1,
        'touchstart is removed from the container');
    const bearingBefore = s.state.bearing;
    runTwoFinger(s, framesFrom([0, 30], [150, 150]));
    assert.strictEqual(s.state.bearing, bearingBefore, 'a removed map never rotates, even mid-gesture');
    assert(s.state.setBearingCalls.length === 0 || s.state.bearing === bearingBefore,
        'no rotation happened after removal');
    console.log('  ✓ the twist listeners are removed with the map');
}

/* ── 10. a deliberate twist owns the gesture — MapLibre’s zoom stays off ────── */
/* The reported teleport: on Android, MapLibre’s own pinch zoom (pivoting
 * around the midpoint of the fingers) would engage mid-twist over natural
 * spread drift and re-centre the view there. The twist engages first and
 * now disables the native two-finger zoom for the whole gesture — the map
 * never pans or zooms, only turns. A pinch that never became a twist leaves
 * the native zoom fully enabled. */
{
    const s = scenario();
    const frames = framesFrom([0, 15, 24, 34], [150, 150, 150, 150]);
    fireTouchStart(s, frames[0]);
    fireTouchMove(s, frames[1]);
    fireTouchMove(s, frames[2]);
    fireTouchMove(s, frames[3]);
    assert.strictEqual(s.state.nativeDisabled, true, 'an engaged twist disables MapLibre’s own zoom');
    fireTouchEnd(s);
    assert.strictEqual(s.state.nativeDisabled, false, 'the native zoom is restored when the twist ends');
    assert(s.calls.filter((c) => c === 'touchZoomRotate.disable').length === 1,
        'MapLibre’s zoom is disabled exactly once (on engagement)');
    assert.strictEqual(s.calls.filter((c) => c === 'touchZoomRotate.enable').length, 1,
        'and restored exactly once (on gesture end)');
    console.log('  ✓ an engaged twist owns the gesture — MapLibre’s zoom stays off until it ends');
}

/* ── 11. a pure pinch never disables MapLibre’s zoom ────────────────────────── */
{
    const s = scenario();
    const frames = framesFrom([0, 5], [150, 170]);
    fireTouchStart(s, frames[0]);
    fireTouchMove(s, frames[1]);
    assert.strictEqual(s.state.nativeDisabled, false,
        'a pinch that never became a turn never disables the native zoom');
    fireTouchEnd(s);
    console.log('  ✓ a pure pinch never disables MapLibre’s zoom');
}

/* ── 12. the gesture path owns the gesture the same way ──────────────────────── */
{
    const s = scenario();
    fireGesture(s, 'gesturestart', { rotation: 0, scale: 1 });
    fireGesture(s, 'gesturechange', { rotation: 20, scale: 1 });
    assert.strictEqual(s.state.nativeDisabled, true, 'an engaged gesture twist disables MapLibre’s own zoom');
    fireGesture(s, 'gestureend', {});
    assert.strictEqual(s.state.nativeDisabled, false, 'the native zoom is restored when the gesture ends');
    console.log('  ✓ an engaged iOS gesture twist owns the gesture too');
}

/* ── 13. the wiring: installed in the open flow, pinch left with MapLibre ──── */
{
    assert(/disableRotation\(\)/.test(viewer), 'the built-in two-finger rotate is disabled explicitly');
    assert(/installTouchTwist\(map\)/.test(viewer), 'the twist installer is wired into the open flow');
    assert(/touchZoomRotate: true/.test(viewer), 'MapLibre’s own pinch/tap-drag stay enabled (touchZoomRotate)');
    console.log('  ✓ rotation is installed as the twist; pinch stays MapLibre’s own');
}

console.log('\n✅ ALL 3D TOUCH TWIST TESTS PASSED\n');
