// Unit and integration tests for map rotation + the Google-Earth-style compass
// Usage: node test-map-rotate-lock.js
//
// The tap-to-lock rotation lock was removed: the compass now behaves like
// Google Earth's — the rose follows the camera, a tap eases the view back to
// north, and a horizontal drag on the rose turns the view. These tests pin
// that behaviour; the filename is kept so the suite index stays stable.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running test-map-rotate-lock.js...\n');

const localStorageMock = {
    _data: {},
    getItem(k) { return this._data[k] !== undefined ? this._data[k] : null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
    clear() { this._data = {}; }
};

function createMockElement(tag, className) {
    let _innerHtml = '';
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        className: className || '',
        classList: {
            _set: new Set((className || '').split(' ').filter(Boolean)),
            add(c) { this._set.add(c); el.className = Array.from(this._set).join(' '); },
            remove(c) { this._set.delete(c); el.className = Array.from(this._set).join(' '); },
            toggle(c, force) {
                if (force === undefined) force = !this._set.has(c);
                if (force) this.add(c); else this.remove(c);
                return force;
            },
            contains(c) { return this._set.has(c); }
        },
        style: {},
        children: [],
        attributes: {},
        get innerHTML() { return _innerHtml; },
        set innerHTML(html) {
            _innerHtml = html;
            this.children = [];
            // Parse top-level/nested mock elements from html string
            const tagRegex = /<([a-z0-9-]+)\b([^>]*)>([\s\S]*?)<\/\1>|<([a-z0-9-]+)\b([^>]*)\/>/gi;
            let match;
            while ((match = tagRegex.exec(html)) !== null) {
                const tagName = match[1] || match[4];
                const attrs = match[2] || match[5] || '';
                const inner = match[3] || '';
                const classMatch = attrs.match(/class=["']([^"']+)["']/i);
                const cls = classMatch ? classMatch[1] : '';
                const child = createMockElement(tagName, cls);
                if (inner) child.innerHTML = inner;
                this.appendChild(child);
            }
        },
        setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k]; },
        appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
            return child;
        },
        querySelector(sel) {
            function match(node) {
                if (!node) return null;
                if (sel.startsWith('.') && node.classList && node.classList.contains(sel.slice(1))) return node;
                if (sel.startsWith('#') && node.id === sel.slice(1)) return node;
                for (let c of (node.children || [])) {
                    const found = match(c);
                    if (found) return found;
                }
                return null;
            }
            return match(this);
        },
        querySelectorAll(sel) {
            const results = [];
            function traverse(node) {
                if (!node) return;
                if (sel.startsWith('.') && node.classList && node.classList.contains(sel.slice(1))) results.push(node);
                for (let c of (node.children || [])) traverse(c);
            }
            traverse(this);
            return results;
        },
        addEventListener(event, fn) {
            this._listeners = this._listeners || {};
            this._listeners[event] = this._listeners[event] || [];
            this._listeners[event].push(fn);
        },
        removeEventListener(event, fn) {
            if (!this._listeners || !this._listeners[event]) return;
            this._listeners[event] = this._listeners[event].filter(l => l !== fn);
        },
        dispatchEvent(evt) {
            const list = (this._listeners && this._listeners[evt.type]) || [];
            for (let l of list) l.call(this, evt);
        }
    };
    return el;
}

// Minimal mock of Leaflet 1.9 core structures for testing rotation + compass
function createLeafletMock() {
    function Class() {}
    Class.extend = function (props) {
        function Sub() {
            if (this.initialize) this.initialize.apply(this, arguments);
        }
        Sub.prototype = Object.create(this.prototype);
        Sub.prototype.constructor = Sub;
        for (let k in props) Sub.prototype[k] = props[k];
        Sub.extend = Class.extend;
        Sub.include = function (extra) {
            for (let k in extra) Sub.prototype[k] = extra[k];
        };
        Sub.mergeOptions = function (opts) {
            Sub.prototype.options = Object.assign(Sub.prototype.options || {}, opts);
        };
        Sub.addInitHook = function (fn) {
            Sub._initHooks = Sub._initHooks || [];
            Sub._initHooks.push(fn);
        };
        return Sub;
    };

    const Evented = Class.extend({
        on(types, fn, ctx) {
            this._events = this._events || {};
            for (let t of types.split(' ')) {
                this._events[t] = this._events[t] || [];
                this._events[t].push({ fn, ctx });
            }
            return this;
        },
        off(types, fn) {
            this._events = this._events || {};
            for (let t of types.split(' ')) {
                if (!this._events[t]) continue;
                this._events[t] = this._events[t].filter(e => e.fn !== fn);
            }
            return this;
        },
        fire(type, data) {
            this._events = this._events || {};
            const list = this._events[type] || [];
            const evt = Object.assign({ type, target: this }, data);
            for (let l of list) l.fn.call(l.ctx || this, evt);
            return this;
        }
    });

    function Point(x, y) { this.x = x; this.y = y; }
    Point.prototype = {
        clone() { return new Point(this.x, this.y); },
        add(p) { return new Point(this.x + p.x, this.y + p.y); },
        subtract(p) { return new Point(this.x - p.x, this.y - p.y); },
        _divideBy(num) { return new Point(this.x / num, this.y / num); },
        distanceTo(p) {
            const dx = this.x - p.x;
            const dy = this.y - p.y;
            return Math.sqrt(dx * dx + dy * dy);
        }
    };

    const MapClass = Evented.extend({
        initialize(container, options) {
            this._container = container;
            this.options = Object.assign({}, this.options, options);
            this._handlers = {};
            this._mapPane = createMockElement('div', 'leaflet-map-pane');
            if (MapClass._initHooks) {
                for (let hook of MapClass._initHooks) hook.call(this);
            }
        },
        addHandler(name, HandlerClass) {
            this._handlers[name] = new HandlerClass(this);
            this[name] = this._handlers[name];
        },
        whenReady(fn) { fn.call(this); },
        getSize() { return new Point(800, 600); },
        _getMapPanePos() { return new Point(0, 0); },
        mouseEventToContainerPoint(e) {
            return new Point(e.clientX || 0, e.clientY || 0);
        }
    });

    const Handler = Class.extend({
        initialize(map) { this._map = map; this._enabled = false; },
        enable() { this._enabled = true; if (this.addHooks) this.addHooks(); return this; },
        disable() { this._enabled = false; if (this.removeHooks) this.removeHooks(); return this; },
        enabled() { return this._enabled; }
    });

    const Control = Class.extend({
        options: { position: 'topright' },
        initialize(opts) { this.options = Object.assign({}, this.options, opts); },
        addTo(map) {
            this._map = map;
            this._container = this.onAdd(map);
            return this;
        }
    });

    const DomUtil = {
        create(tag, className, parent) {
            const el = createMockElement(tag, className);
            if (parent) parent.appendChild(el);
            return el;
        },
        setPosition(el, point) {
            el._leaflet_pos = point;
        },
        getPosition(el) {
            return el._leaflet_pos || new Point(0, 0);
        },
        disableTextSelection() {},
        enableTextSelection() {},
        addClass(el, c) { if (el && el.classList) el.classList.add(c); },
        removeClass(el, c) { if (el && el.classList) el.classList.remove(c); },
        TRANSFORM: 'transform'
    };

    // Keep track of what was bound with which ctx so `off` can remove the
    // exact handler `on` installed (browsers do this natively; without it
    // repeated gestures in the tests would stack duplicate listeners).
    const domEventBindings = [];
    const DomEvent = {
        on(el, types, fn, ctx) {
            for (let t of types.split(' ')) {
                if (el.addEventListener) {
                    const handler = ctx ? fn.bind(ctx) : fn;
                    domEventBindings.push({ el, type: t, fn, handler });
                    el.addEventListener(t, handler);
                }
            }
        },
        off(el, types, fn) {
            for (let t of types.split(' ')) {
                for (let i = domEventBindings.length - 1; i >= 0; i--) {
                    const b = domEventBindings[i];
                    if (b.el !== el || b.type !== t || b.fn !== fn) continue;
                    if (el.removeEventListener) el.removeEventListener(t, b.handler);
                    domEventBindings.splice(i, 1);
                }
            }
        },
        stop(e) {
            if (e && e.stopPropagation) e.stopPropagation();
            if (e && e.preventDefault) e.preventDefault();
            return this;
        },
        preventDefault(e) { if (e && e.preventDefault) e.preventDefault(); return this; },
        stopPropagation(e) { if (e && e.stopPropagation) e.stopPropagation(); return this; },
        disableClickPropagation() {},
        disableScrollPropagation() {}
    };

    const Util = {
        requestAnimFrame: (cb) => setTimeout(cb, 16),
        cancelAnimFrame: (id) => clearTimeout(id)
    };

    return {
        Class,
        Evented,
        Map: MapClass,
        Handler,
        Control,
        control: (opts) => new Control(opts),
        point: (x, y) => new Point(x, y),
        Point,
        DomUtil,
        DomEvent,
        Util,
        Browser: { any3d: true },
        bind: (fn, ctx) => fn.bind(ctx),
        latLngBounds: (bounds) => bounds
    };
}

const L = createLeafletMock();
global.L = L;
global.localStorage = localStorageMock;
global.window = global;
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.PointerEvent = function () {};

// The compass binds its drag listeners on `document`; keep them reachable so
// the tests can drive a press / move / release the way a browser would.
const documentHandlers = {};
const fakeDocument = {
    documentElement: { style: {} },
    body: createMockElement('body'),
    addEventListener(type, fn) {
        documentHandlers[type] = documentHandlers[type] || [];
        documentHandlers[type].push(fn);
    },
    removeEventListener(type, fn) {
        if (!documentHandlers[type]) return;
        documentHandlers[type] = documentHandlers[type].filter((l) => l !== fn);
    }
};

function fireDocument(type, evt) {
    (documentHandlers[type] || []).forEach((fn) => fn(evt));
}

const rotateCode = fs.readFileSync(path.join(__dirname, 'js/map-rotate.js'), 'utf8');
const rotateFn = new Function('L', 'window', 'document', rotateCode);
rotateFn(L, global, fakeDocument);

// -------------------------------------------------------------
// Test 1: Bearing calculations and Snap-to-North threshold
// -------------------------------------------------------------
console.log('[1] Bearing calculations & Snap-to-North threshold');
const mapEl = createMockElement('div');
const map = new L.Map(mapEl, {
    rotate: true,
    touchRotate: true,
    keyRotate: true,
    bearing: 0
});

assert.strictEqual(map.getBearing(), 0, 'initial bearing is 0°');

map.setBearing(45);
assert.strictEqual(map.getBearing(), 45, 'bearing set to 45°');

// Snapping to North within 3.0 degrees
map.setBearing(2.8);
assert.strictEqual(map.getBearing(), 0, 'bearing of 2.8° snaps to 0°');

map.setBearing(-2.9);
assert.strictEqual(map.getBearing(), 0, 'bearing of -2.9° snaps to 0°');

map.setBearing(15);
assert.strictEqual(map.getBearing(), 15, 'bearing outside snap range stays 15°');

// An unrotated map pane must keep Leaflet's 0 0 transform-origin. A
// centre origin makes tiles and vector overlays (heritage, LIDAR,
// archeo) scale around the wrong point while zooming, so dots slide
// off their geographic sites.
map.setBearing(0);
assert.strictEqual(
    String(map._mapPane.style.transformOrigin),
    '0px 0px',
    'unrotated map pane must use transform-origin 0 0 so zoom animation stays locked'
);
map.setBearing(15);
const origin15 = String(map._mapPane.style.transformOrigin);
assert(
    origin15 !== '0px 0px' && origin15.indexOf('px') !== -1,
    'rotated map pane may pivot around the viewport centre, got ' + origin15
);
console.log('  ✔ snap-to-north works within 3.0°');
console.log('  ✔ transform-origin is 0 0 when the map is not rotated');

// -------------------------------------------------------------
// Test 2: There is no rotation lock any more
// -------------------------------------------------------------
console.log('\n[2] Rotation is always available (no lock)');
assert.strictEqual(typeof map.setRotateLocked, 'undefined',
    'L.Map no longer exposes setRotateLocked');
assert.strictEqual(typeof map.isRotateLocked, 'undefined',
    'L.Map no longer exposes isRotateLocked');

// A bearing stored by an older build must not survive.
localStorageMock.setItem('detectlab_rotation_locked', 'true');
const remount = new L.Map(createMockElement('div'), { rotate: true, bearing: 0 });
assert.strictEqual(localStorageMock.getItem('detectlab_rotation_locked'), null,
    'the stale lock key is cleared when the map mounts');

// Rotation from the keyboard path, a twist or a drag is never blocked.
map.setBearing(80);
assert.strictEqual(map.getBearing(), 80, 'setBearing applies without a force flag');
map.setBearing(140);
assert.strictEqual(map.getBearing(), 140, 'and keeps applying on the next change');
console.log('  ✔ no lock API, stale lock key cleared, rotation never blocked');

// -------------------------------------------------------------
// Test 3: Compass Control DOM Structure (compass + detect, no lock)
// -------------------------------------------------------------
console.log('\n[3] Compass Control DOM Structure');
const compass = L.control.compass({ position: 'bottomleft' });
const compassWrap = compass.onAdd(map);

assert(compassWrap.classList.contains('detectlab-compass'), 'compass container has detectlab-compass class');
const col = compassWrap.querySelector('.detectlab-compass-col');
assert(col, 'compass button column exists');
assert.strictEqual(col.id, 'compassCol', 'column carries the compassCol id');

const btn = compassWrap.querySelector('.detectlab-compass-btn');
assert(btn, 'compass button exists');
assert.strictEqual(btn.tagName, 'BUTTON', 'compass is a real <button>');
assert(btn.querySelector('.detectlab-compass-rose'), 'compass rose exists inside button');
assert(btn.querySelector('.dl-c-needle-n'), 'the rose carries a north needle');
assert(btn.querySelector('.dl-c-ring'), 'the rose carries its hairline ring');
assert(!/compass-lock/.test(compassWrap.className), 'no lock chrome in the container');

const det = compassWrap.querySelector('.compass-detect-btn');
assert(det, 'detect toggle button exists under the compass');
assert.strictEqual(det.tagName, 'BUTTON', 'detect toggle is a real <button>');
assert.strictEqual(det.id, 'pwaDetectBtn', 'detect button carries the pwaDetectBtn id');

// The lock button and its icons are gone; compass + detect remain, in order.
assert.strictEqual(compassWrap.querySelector('.detectlab-compass-lock'), null,
    'the rotation-lock button is gone');
assert.strictEqual(compassWrap.querySelector('#compassLockBtn'), null,
    'and so is its id');
assert.strictEqual(compassWrap.querySelector('.dl-lock-icon-unlocked'), null,
    'no unlocked padlock icon');
assert.strictEqual(compassWrap.querySelector('.dl-lock-icon-locked'), null,
    'no locked padlock icon');

const colKids = col.children.filter((c) => c.tagName === 'BUTTON');
assert.strictEqual(colKids.length, 2, 'column holds exactly two buttons');
assert(colKids[0].classList.contains('detectlab-compass-btn'), 'compass is first');
assert(colKids[1].classList.contains('compass-detect-btn'), 'detect is second');

// The old slide-to-lock chrome stays gone.
assert(!compassWrap.querySelector('.detectlab-compass-track'), 'no sliding track anymore');
assert(!compassWrap.querySelector('.detectlab-compass-lock-dock'), 'no lock dock anymore');
assert(!compassWrap.querySelector('.detectlab-compass-guide'), 'no guide arrow anymore');
assert(!compassWrap.querySelector('.dl-compass-mini-lock'), 'no mini lock badge anymore');
assert(!compassWrap.querySelector('.dl-lock-dock-label'), 'no LOCK text label anymore');
console.log('  ✔ compass column holds exactly compass + detect, with no lock chrome');

// -------------------------------------------------------------
// Test 4: Compass follows the camera (Google-Earth movement)
// -------------------------------------------------------------
console.log('\n[4] The rose follows the camera');
const rose = btn.querySelector('.detectlab-compass-rose');
map.setBearing(45);
assert.strictEqual(rose.style.transform, 'rotate(-45deg)', 'rose counter-rotates the bearing');
assert(btn.classList.contains('is-rotated'), 'compass shows is-rotated while off-north');
assert(/45/.test(String(btn.getAttribute('aria-label'))),
    'the accessible label reports the current offset from north');

map.setBearing(90);
assert.strictEqual(rose.style.transform, 'rotate(-90deg)', 'rose keeps tracking every change');
map.setBearing(-30);
assert.strictEqual(rose.style.transform, 'rotate(30deg)', 'and it tracks negative bearings');

// Frame-by-frame updates come straight off the map's rotate event: the control
// is a listener, not a poller, so nothing lags behind the imagery.
assert(typeof compass._onRotate === 'function', 'the control subscribes to the rotate event');
assert(btn._listeners && btn._listeners.pointerdown, 'the rose is a pointer-drag handle');
console.log('  ✔ rose tracks the bearing continuously, with an accurate aria-label');

// -------------------------------------------------------------
// Test 5: Tap resets north, drag turns the view, detect relays
// -------------------------------------------------------------
console.log('\n[5] Tap resets north, drag turns the view');
map.setBearing(45);

// Sub-degree bearings reset synchronously (larger ones animate back).
map._bearing = 0.5;
btn.dispatchEvent({ type: 'click' });
assert.strictEqual(map.getBearing(), 0, 'compass tap resets bearing to north');
assert.strictEqual(rose.style.transform, 'rotate(0deg)', 'rose returns upright');
assert(!btn.classList.contains('is-rotated'), 'is-rotated clears at north');

// A horizontal drag on the rose turns the view and swallows the trailing click.
map.setBearing(10);
btn.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0 });
assert(btn.classList.contains('is-dragging'), 'pressing the rose enters the drag state');
fireDocument('pointermove', { type: 'pointermove', clientX: 160, clientY: 100 });
assert(Math.abs(map.getBearing() - (10 + 60 * 0.55)) < 0.001,
    'dragging 60px right turns the view by 33° (0.55°/px), got ' + map.getBearing());
fireDocument('pointerup', { type: 'pointerup' });
assert(!btn.classList.contains('is-dragging'), 'releasing the rose leaves the drag state');
map.setBearing(42);
btn.dispatchEvent({ type: 'click' });
assert.strictEqual(map.getBearing(), 42,
    'the click that ends a drag must not also reset north, got ' + map.getBearing());

// A press without movement is still a tap.
btn.dispatchEvent({ type: 'pointerdown', clientX: 100, clientY: 100, button: 0 });
fireDocument('pointerup', { type: 'pointerup' });
map._bearing = 0.4;
btn.dispatchEvent({ type: 'click' });
assert.strictEqual(map.getBearing(), 0, 'a press that did not move still resets north');

// Keyboard: arrows nudge, Home resets — the same compass, without a pointer.
map.setBearing(20);
btn.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
assert.strictEqual(map.getBearing(), 15, 'ArrowLeft turns 5° left');
btn.dispatchEvent({ type: 'keydown', key: 'ArrowRight', shiftKey: true });
assert.strictEqual(map.getBearing(), 30, 'Shift+ArrowRight turns 15° right');
map._bearing = 0.4;
btn.dispatchEvent({ type: 'keydown', key: 'Home' });
assert.strictEqual(map.getBearing(), 0, 'Home faces north');

// Tapping detect relays to the PWA detection toggle (index.html).
let detectRelayed = false;
global.togglePwaDetection = function () { detectRelayed = true; };
det.dispatchEvent({ type: 'click' });
assert.strictEqual(detectRelayed, true, 'detect tap relays to window.togglePwaDetection');
delete global.togglePwaDetection;
console.log('  ✔ tap faces north, a horizontal drag turns the view, keys nudge, detect relays');

// -------------------------------------------------------------
// Test 6: Two-finger twist deadband & pinch arbitration (Google Earth feel)
// -------------------------------------------------------------
console.log('\n[6] Two-finger twist deadband & pinch arbitration');

function touchPt(x, y) { return { clientX: x, clientY: y }; }
// Two fingers around (cx, cy) at `angleDeg`, `dist` px apart.
function pairAt(cx, cy, angleDeg, dist) {
    const rad = angleDeg * Math.PI / 180;
    const dx = Math.cos(rad) * dist / 2;
    const dy = Math.sin(rad) * dist / 2;
    return [touchPt(cx + dx, cy + dy), touchPt(cx - dx, cy - dy)];
}
function fireMapEvent(type, evt) {
    mapEl.dispatchEvent(Object.assign({ type, preventDefault() {} }, evt));
}
// Drive a whole two-finger gesture: touchstart on the map, touchmove on
// document for every frame after the first, touchend at the end.
function runTwoFinger(frames) {
    fireMapEvent('touchstart', { touches: frames[0] });
    for (let i = 1; i < frames.length; i++) {
        fireDocument('touchmove', { type: 'touchmove', touches: frames[i], preventDefault() {} });
    }
    fireDocument('touchend', { type: 'touchend', touches: [], preventDefault() {} });
}
const twistFrames = (cx, cy, angles, dist) => angles.map((a) => pairAt(cx, cy, a, dist));

map.touchRotate.enable();

// 6.1 — a pinch-zoom must never turn the map, even with angle jitter.
map.setBearing(0);
runTwoFinger([
    pairAt(400, 300, 0, 100),
    pairAt(400, 300, 3, 112),
    pairAt(400, 300, -4, 128),
    pairAt(400, 300, 2, 150),
    pairAt(400, 300, -3, 175),
    pairAt(400, 300, 5, 210)
]);
assert.strictEqual(map.getBearing(), 0,
    'a pinch-zoom with jitter must not rotate the map, got ' + map.getBearing());

// A slow, gentle pinch (a few % of spread per frame) is still a pinch.
map.setBearing(0);
runTwoFinger([
    pairAt(400, 300, 0, 100),
    pairAt(400, 300, 4, 104),
    pairAt(400, 300, -3, 108),
    pairAt(400, 300, 4, 113),
    pairAt(400, 300, -4, 120)
]);
assert.strictEqual(map.getBearing(), 0,
    'a slow two-finger zoom must not rotate either, got ' + map.getBearing());
console.log('  ✔ pinch-zoom never turns the map, jitter or not');

// 6.2 — light touches: twists under the arc deadband do nothing.
// At 120 px spacing the fingers must travel 34 px along the arc, i.e. ~16°.
map.setBearing(0);
runTwoFinger(twistFrames(400, 300, [0, 5, -7, 8, -10, 12], 120));
assert.strictEqual(map.getBearing(), 0,
    'a 12° twitch at 120 px is below the 16° arc deadband and must not rotate, got ' + map.getBearing());
console.log('  ✔ light touches stay under the arc deadband');

// 6.3 — a deliberate twist turns the map 1:1 past the deadband.
// 150 px spacing → threshold = 34/150·57.3 ≈ 12.9°, engaged on the 20° frame.
map.setBearing(0);
runTwoFinger(twistFrames(400, 300, [0, 10, 20, 30, 40], 150));
assert(Math.abs(map.getBearing() - 20) < 0.5,
    'a 40° twist past a ~13° deadband must turn the map by ~27° from its engage point (20° applied from 0), got ' + map.getBearing());
map.setBearing(0);
runTwoFinger(twistFrames(400, 300, [0, 10, 20], 150));
assert(Math.abs(map.getBearing() - 0) < 0.5,
    'the turn starts from 0° at the engage frame (no jump), got ' + map.getBearing());
console.log('  ✔ a deliberate twist turns 1:1 past the deadband, starting from 0°');

// 6.4 — fingers too close together can never rotate (angle is noise there).
map.setBearing(0);
runTwoFinger(twistFrames(400, 300, [0, 30, 60, 90], 45));
assert.strictEqual(map.getBearing(), 0,
    'a twist with fingers 45 px apart must not rotate at all, got ' + map.getBearing());
// …but a gesture that starts close and then spreads re-baselines once the
// angle becomes readable, and twists normally from there.
map.setBearing(0);
runTwoFinger([
    pairAt(400, 300, 0, 40),
    pairAt(400, 300, 5, 80),
    pairAt(400, 300, 25, 80),
    pairAt(400, 300, 35, 80),   // twist 30° ≥ 24.3° → engages, turn starts at 0°
    pairAt(400, 300, 45, 80)    // twist 40° → 10° of turn past the engage point
]);
assert(Math.abs(map.getBearing() - 10) < 0.5,
    'a gesture re-baselines when the fingers spread past 64 px and turns 1:1 from there, got ' + map.getBearing());
console.log('  ✔ close fingers never rotate; a spread re-baselines cleanly');

// 6.5 — a pinch that grows out of a twist cancels the turn and locks it out.
map.setBearing(0);
runTwoFinger([
    pairAt(400, 300, 0, 150),
    pairAt(400, 300, 10, 150),
    pairAt(400, 300, 20, 150),
    pairAt(400, 300, 30, 150),
    pairAt(400, 300, 36, 190),   // spread +27 % → the twist dies here
    pairAt(400, 300, 55, 190),   // further twisting must stay ignored
    pairAt(400, 300, 75, 190)
]);
assert(Math.abs(map.getBearing() - 10) < 0.5,
    'the turn must freeze at the moment the gesture turns into a pinch (10°), got ' + map.getBearing());
console.log('  ✔ a pinch cancels an engaged twist and never resumes');

// 6.6 — iOS Safari gesture events: same deadband + pinch arbitration.
map.setBearing(0);
fireMapEvent('gesturestart', { rotation: 0, scale: 1 });
fireMapEvent('gesturechange', { rotation: 5, scale: 1 });
assert.strictEqual(map.getBearing(), 0, 'a 5° gesture-rotation is under the 12° deadband');
fireMapEvent('gesturechange', { rotation: 14, scale: 1 });   // engage here
fireMapEvent('gesturechange', { rotation: 20, scale: 1.02 }); // 2 % spread drift is still a twist
fireMapEvent('gesturechange', { rotation: 30, scale: 1.04 });
assert(Math.abs(map.getBearing() - 16) < 0.5,
    'a 30° gesture-rotation past a 12° deadband turns by ~16°, got ' + map.getBearing());
fireMapEvent('gestureend', {});
assert.strictEqual(map.touchRotate._usingGesture, false, 'gestureend releases the gesture');

fireMapEvent('gesturestart', { rotation: 0, scale: 1 });
fireMapEvent('gesturechange', { rotation: 25, scale: 1.2 });  // a zoom: spread +20 %
assert(Math.abs(map.getBearing() - 16) < 0.5,
    'a gesture pinch must not rotate the map (bearing stays at 16°), got ' + map.getBearing());
fireMapEvent('gestureend', {});
console.log('  ✔ iOS gesture rotation obeys the same rules');

// -------------------------------------------------------------
// Test 7: CSS + docs coverage for the new material and behaviour
// -------------------------------------------------------------
console.log('\n[7] CSS Stylesheet Coverage');
const cssContent = fs.readFileSync(path.join(__dirname, 'css/styles.css'), 'utf8');
assert(cssContent.includes('.detectlab-compass-col'), 'css includes .detectlab-compass-col');
assert(cssContent.includes('.detectlab-compass-btn'), 'css includes .detectlab-compass-btn');
assert(cssContent.includes('.compass-detect-btn'), 'css includes .compass-detect-btn');
assert(cssContent.includes('.compass-detect-btn.detect-active'), 'css includes detect-active state');
assert(cssContent.includes('.btn-nearby-pwa'), 'css includes .btn-nearby-pwa');
assert(!cssContent.includes('.detectlab-compass-lock'), 'css drops .detectlab-compass-lock');
assert(!cssContent.includes('.detectlab-compass-col.is-locked'), 'css drops the locked column state');
assert(!cssContent.includes('.dl-lock-icon'), 'css drops the padlock icons');
assert(!cssContent.includes('.detectlab-compass-track'), 'css drops .detectlab-compass-track');
assert(!cssContent.includes('.detectlab-compass-lock-dock'), 'css drops .detectlab-compass-lock-dock');
assert(!cssContent.includes('.dl-compass-mini-lock'), 'css drops .dl-compass-mini-lock');

// The shared control material: translucent, blurred, violet glyph.
assert(cssContent.includes('--ctl-bg:') && cssContent.includes('--ctl-blur:') &&
       cssContent.includes('--ctl-icon:'), 'css declares the shared map-control tokens');
assert(/\.detectlab-compass-btn[\s\S]{0,900}?backdrop-filter:\s*var\(--ctl-blur\)/.test(cssContent),
    'the compass pane is blurred');
assert(/\.detectlab-compass-btn[\s\S]{0,400}?background:\s*var\(--ctl-bg\)/.test(cssContent),
    'and translucent');
assert(!/\.detectlab-compass-btn[^{]*\{[^}]*rgba\(10,25,48/.test(cssContent),
    'the opaque navy button background is gone');
console.log('  ✔ glass tokens, violet glyphs and the lock-free compass are in the stylesheet');

console.log('\n\u2705 ALL MAP ROTATION & COMPASS TESTS PASSED\n');
