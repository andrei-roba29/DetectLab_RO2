// Regression suite for “LiDAR in the 3D view” (js/lidar-3d-focus.js + the
// focus half of js/map3d-terrain.js + the disc maths in js/map3d-mirror.js).
//
// The invariants this file protects — the ones the field report behind the
// feature is made of (“Romania 1m/pixel agregare / AB … slow, broken, or never
// there in 3D”):
//
//   1. pressing 3D with a LiDAR layer switched on does NOT open 3D: it asks
//      (viewer.setEntryGate → this suite's dialog), and only a prepared disc
//      lets open() continue;
//   2. one LiDAR layer at a time. A second one on the 2D map is left out of the
//      deck by decision, named in status().lidar — never silently dropped and
//      never both draped;
//   3. the disc is bounded and honest: 10 km radius maximum, a few hundred
//      tiles, every tile really intersecting the circle, the zoom window taken
//      from the layer's own limits and reported;
//   4. the tiles are prefetched through the SAME path 3D draws with (fetchTile →
//      CSS-blend repaint → disc clip), they are kept in memory, and a second
//      run over the same disc makes no request at all;
//   5. the clip is a circle, not a rectangle: tiles inside the disc come
//      through untouched, the rim is repainted, and everything outside it is
//      the transparent 1×1 PNG — so what the user prepared is exactly what is
//      draped;
//   6. the 2D map keeps working: the dialog is a sheet over it, the point is
//      chosen with a tap, Escape/cancel leaves no picking handler behind and the
//      LiDAR Scanner is told to keep its hands off that tap.
//
// Usage: node test-lidar-3d-focus.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] LiDAR in the 3D view — one layer, one prepared disc (10 km max)...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };

const indexHtml = read('index.html');
const swJs = read('sw.js');
const skin = read('css/map3d-terrain.css');
const mapApp = read('js/map-app.js');
const scanner = read('js/lidar-scanner.js');
const mirrorSource = read('js/map3d-mirror.js');
const registrySource = read('js/layer-registry.js');
const viewerSource = read('js/map3d-terrain.js');
const focusSource = read('js/lidar-3d-focus.js');

/* Every build that changes the LiDAR 3D focus path bumps its own tag. */
const TAG = '20261017-lidar-3d-entry-handover';
const TAG_MIRROR = '20261017-archeo-3d-projection';
const TAG_VIEWER = '20261017-archeo-3d-projection';
const TAG_CSS = '20261017-lidar-3d-entry-handover';

/* One real event-loop turn: the viewer runs its entry gate through a promise,
 * so the dialog is not in the DOM in the same tick as open(). */
function tick() {
    return new Promise(function (resolve) { setImmediate(resolve); });
}

/** Wait real time (the live-mode dialog settles on a 700 ms timer). */
function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* Timers that never hold the process open: the module under test schedules a
 * boot retry every 250 ms and the sandbox has no DOM to satisfy it. */
function unrefTimer(fn, ms) {
    const timer = setTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

/* ══════════════════════════════════════════════════════════════════════════
 * A very small DOM — just enough for the focus dialog
 * --------------------------------------------------------------------------
 * The dialog is markup + a handful of handlers. Instead of a real DOM (which
 * Node does not have), this parses the module's own innerHTML into nodes and
 * supports the selectors/APIs it uses: querySelector('#id' / '.class' /
 * 'tag' / '.a .b' / 'button[data-radius]'), classList, textContent/hidden,
 * value/checked/disabled, addEventListener + click(), and closest().
 * ══════════════════════════════════════════════════════════════════════════ */

function FakeNode(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._classes = [];
    this._listeners = {};
    this.style = {};
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.id = '';
    this.type = '';
    this._text = '';
}
Object.defineProperty(FakeNode.prototype, 'className', {
    get: function () { return this._classes.join(' '); },
    set: function (value) { this._classes = String(value || '').split(/\s+/).filter(Boolean); }
});
Object.defineProperty(FakeNode.prototype, 'classList', {
    get: function () {
        const self = this;
        return {
            add: function () { [].slice.call(arguments).forEach(function (c) { if (self._classes.indexOf(c) === -1) self._classes.push(c); }); },
            remove: function () { [].slice.call(arguments).forEach(function (c) { const at = self._classes.indexOf(c); if (at !== -1) self._classes.splice(at, 1); }); },
            toggle: function (c, on) {
                const has = self._classes.indexOf(c) !== -1;
                const want = on === undefined ? !has : !!on;
                if (want && !has) self._classes.push(c);
                if (!want && has) { const at = self._classes.indexOf(c); if (at !== -1) self._classes.splice(at, 1); }
                return want;
            },
            contains: function (c) { return self._classes.indexOf(c) !== -1; }
        };
    }
});
Object.defineProperty(FakeNode.prototype, 'textContent', {
    get: function () {
        if (this.childNodes.length) return this.childNodes.map(function (c) { return c.textContent; }).join('');
        return this._text;
    },
    set: function (value) { this._text = String(value == null ? '' : value); this.childNodes = []; }
});
Object.defineProperty(FakeNode.prototype, 'innerHTML', {
    get: function () { return ''; },
    set: function (html) { this.childNodes = []; this._text = ''; parseHTML(String(html), this, this.ownerDocument); }
});
FakeNode.prototype.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
};
FakeNode.prototype.getAttribute = function (name) { return this.attributes[name] === undefined ? null : this.attributes[name]; };
FakeNode.prototype.appendChild = function (child) {
    if (child && child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    if (child) child.parentNode = this;
    return child;
};
FakeNode.prototype.removeChild = function (child) {
    const at = this.childNodes.indexOf(child);
    if (at !== -1) this.childNodes.splice(at, 1);
    if (child) child.parentNode = null;
    return child;
};
FakeNode.prototype.addEventListener = function (type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
};
FakeNode.prototype.removeEventListener = function (type, handler) {
    const list = this._listeners[type] || [];
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
};
FakeNode.prototype.dispatch = function (type, event) {
    const detail = event || {};
    if (!detail.target) detail.target = this;
    if (!detail.type) detail.type = type;
    /* Real events bubble, and the dialog relies on it (the chips listen on
     * their container, the buttons are children of it). */
    let node = this;
    let called = 0;
    while (node) {
        const list = (node._listeners[type] || []).slice();
        list.forEach((handler) => { called += 1; handler.call(node, detail); });
        node = node.parentNode && node.parentNode.tagName ? node.parentNode : null;
    }
    return called;
};
FakeNode.prototype.click = function () { this.dispatch('click'); };
FakeNode.prototype.focus = function () { this._focused = true; };
FakeNode.prototype.closest = function (selector) {
    let node = this;
    while (node) {
        if (matches(node, selector)) return node;
        node = node.parentNode;
    }
    return null;
};
FakeNode.prototype._all = function (out) {
    this.childNodes.forEach(function (child) { out.push(child); child._all(out); });
    return out;
};
FakeNode.prototype.querySelectorAll = function (selector) {
    return this._all([]).filter(function (node) { return matches(node, selector); });
};
FakeNode.prototype.querySelector = function (selector) { return this.querySelectorAll(selector)[0] || null; };
FakeNode.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };

function matches(node, selector) {
    if (!node || !node.tagName) return false;
    const parts = String(selector).trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if (!matchesSimple(node, last)) return false;
    let parent = node.parentNode;
    for (let i = parts.length - 2; i >= 0; i -= 1) {
        let found = null;
        while (parent && parent.tagName) {
            if (matchesSimple(parent, parts[i])) { found = parent; break; }
            parent = parent.parentNode;
        }
        if (!found) return false;
        parent = found.parentNode;
    }
    return true;
}

function matchesSimple(node, part) {
    const tag = part.replace(/\[.*\]$/, '').replace(/[.#].*$/, '') || '*';
    if (tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
    const idMatch = part.match(/#([\w-]+)/);
    if (idMatch && node.id !== idMatch[1]) return false;
    const classMatch = part.match(/\.([\w-]+)/);
    if (classMatch && node._classes.indexOf(classMatch[1]) === -1) return false;
    const attrMatch = part.match(/\[([\w-]+)(?:="([^"]*)")?\]/);
    if (attrMatch) {
        let value = node.getAttribute(attrMatch[1]);
        /* `input.type = 'radio'` is a property in a real DOM too, and it is how
         * the dialog builds its radio group — accept both. */
        if (value === null && attrMatch[1] === 'type') value = node.type || null;
        if (value === null) return false;
        if (attrMatch[2] !== undefined && value !== attrMatch[2]) return false;
    }
    return true;
}

/** Tag-stack parser for the flat, attribute-only markup the module writes. */
function parseHTML(html, parent, doc) {
    const stack = [parent];
    const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
    let match;
    while ((match = re.exec(html)) !== null) {
        if (match[3] !== undefined) {
            const text = match[3];
            if (text.trim()) stack[stack.length - 1]._text += text;
            continue;
        }
        const closing = match[0].charAt(1) === '/';
        if (closing) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const node = doc.createElement(match[1]);
        const attrs = match[2] || '';
        const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
        let attr;
        while ((attr = attrRe.exec(attrs)) !== null) node.setAttribute(attr[1], attr[2] === undefined ? '' : attr[2]);
        stack[stack.length - 1].appendChild(node);
        if (match[0].charAt(match[0].length - 2) !== '/') stack.push(node);
    }
    return parent;
}

function FakeDocument() {
    this.readyState = 'complete';
    this.documentElement = new FakeNode('html', this);
    this.documentElement.lang = 'ro';
    this.body = new FakeNode('body', this);
    this.head = new FakeNode('head', this);
    this._byId = {};
    this._listeners = {};
    this.createElement = (tag) => new FakeNode(tag, this);
}
FakeDocument.prototype.getElementById = function (id) { return this._byId[id] || null; };
FakeDocument.prototype.querySelector = function () { return null; };
FakeDocument.prototype.querySelectorAll = function () { return []; };
FakeDocument.prototype.addEventListener = function (type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler);
};
FakeDocument.prototype.removeEventListener = function (type, handler) {
    const list = this._listeners[type] || [];
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
};
FakeDocument.prototype.dispatch = function (type, event) {
    (this._listeners[type] || []).slice().forEach((handler) => handler(event || {}));
};
FakeDocument.prototype.dispatchEvent = function (event) {
    if (event && event.type) this.dispatch(event.type, event);
    return true;
};
FakeDocument.prototype._register = function (id, node) { this._byId[id] = node; return node; };

/* ── image decoding, the way MapLibre's own path does it ────────────────── */
function fakeImageDecoder() {
    const size = 16;
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 240; pixels[i + 1] = 240; pixels[i + 2] = 240; pixels[i + 3] = 255;
    }
    return Promise.resolve({ width: size, height: size, _pixels: pixels });
}

/** A canvas stand-in: the mirror only draws and re-reads pixels. */
const fakeCanvas = function () {
    const canvas = { width: 1, height: 1, _pixels: new Uint8ClampedArray(4) };
    const alloc = function () {
        const need = canvas.width * canvas.height * 4;
        if (!canvas._pixels || canvas._pixels.length !== need) canvas._pixels = new Uint8ClampedArray(need);
        return canvas._pixels;
    };
    canvas.getContext = function (kind) {
        if (kind !== '2d') return null;
        return {
            drawImage: function (image) { alloc().set(image._pixels.slice(0, canvas.width * canvas.height * 4)); },
            getImageData: function (x, y, w, h) { alloc(); return { data: canvas._pixels.slice(), width: w, height: h }; },
            putImageData: function (frame) { alloc().set(frame.data); }
        };
    };
    canvas.toBlob = function (done) { done({ arrayBuffer: function () { return Promise.resolve(alloc().slice().buffer); } }); };
    return canvas;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. Static wiring
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const viewerTag = indexHtml.indexOf('js/map3d-terrain.js?v=' + TAG_VIEWER);
    const mirrorTag = indexHtml.indexOf('js/map3d-mirror.js?v=' + TAG_MIRROR);
    const focusTag = indexHtml.indexOf('js/lidar-3d-focus.js?v=' + TAG);
    assert(viewerTag !== -1 && mirrorTag !== -1, 'index.html loads the tagged mirror and viewer');
    assert(focusTag !== -1, 'index.html loads the LiDAR focus module');
    assert(focusTag > viewerTag, 'the focus module loads after the viewer it installs its gate on');
    assert(indexHtml.includes('css/map3d-terrain.css?v=' + TAG_CSS), 'index.html loads the tagged 3D skin');

    assert(/#map3d-focus \{[\s\S]*?z-index: 1400/.test(skin),
        'the dialog sits above the layer panel and the search bar (it decides what 3D may load)');
    ['#map3d-focus .m3d-focus-card', '#map3d-focus .m3d-focus-layers', '#map3d-focus .m3d-focus-radius',
     '#map3d-focus .m3d-focus-chips', '#map3d-focus .m3d-focus-point-block', '#map3d-focus .m3d-focus-actions',
     '#map3d-focus .m3d-focus-progress', '#map3d-focus .m3d-focus-x', '#map3d-bar .m3d-lidar',
     '#map3d-focus .m3d-focus-mini', '#map3d-focus .m3d-focus-mini-arrow',
     '#detectlab-map.m3d-picking'].forEach(function (selector) {
        assert(skin.indexOf(selector) !== -1, 'the skin styles ' + selector);
    });

    /* The folded window is chrome of the 3D view only: folded on the 2D map
     * it must not paint (or take taps) — the skin gates it on body.is-3d,
     * with an explicit [hidden] win, the banner lesson of §1 below. */
    assert(/body:not\(\.is-3d\) #map3d-focus\.is-minimized \{\s*display: none;/.test(skin),
        'the minimized window only paints while the 3D view is up');
    assert(/#map3d-focus \.m3d-focus-mini\[hidden\] \{\s*display: none;/.test(skin) &&
           /#map3d-focus\[hidden\] \{\s*display: none;/.test(skin),
        'and the pill/host hidden attributes beat their author display');
    assert(/minimizeDialog/.test(focusSource) && /expandMinimized/.test(focusSource) &&
           /settle\(\{ cancelled: false, focus: focus, report: report \}, \{ minimize: true \}\)/.test(focusSource),
        'a fetched disc settles into the minimized window, and the pill expands it again');

    /* The banner that told the user to tap the map is gone. It declared
     * `display: flex`, which beat the UA rule for [hidden], so it was never
     * actually hidden — an always-on overlay across the top of the dialog that
     * swallowed the tap meant for its close button. Nothing may resurrect it. */
    assert(!/m3d-focus-hint\b(?!line)/.test(skin) && !/m3d-focus-hint["'`\s>]/.test(focusSource),
        'the tap-to-pick banner is gone (its CSS kept it visible over the close button)');
    assert(!/pickingCancel/.test(focusSource) && !/hintText/.test(focusSource),
        'and the strings that fed it are gone with it');
    /* The close button is a real touch target: 44px, the size the rest of the
     * app's controls use. */
    const xRule = (skin.match(/#map3d-focus \.m3d-focus-x \{[^}]*\}/) || [''])[0];
    assert(/min-width: 44px/.test(xRule) && /min-height: 44px/.test(xRule),
        'the close button is a 44px touch target, not a 20px glyph');

    assert(swJs.includes("'js/lidar-3d-focus.js?v=" + TAG + "'") && swJs.includes("'js/lidar-3d-focus.js'"),
        'the service worker pre-caches the focus module (a cold PWA keeps the feature)');
    ['js/map3d-terrain.js?v=' + TAG_VIEWER, 'js/map3d-mirror.js?v=' + TAG_MIRROR,
     'css/map3d-terrain.css?v=' + TAG_CSS].forEach(function (asset) {
        assert(swJs.includes("'" + asset + "'"), 'sw.js pre-caches ' + asset);
    });
    /* map-app.js is not part of this change, but the service worker has to
     * pre-cache the very build index.html asks for — not a stale one. */
    const mapAppTag = (indexHtml.match(/js\/map-app\.js\?v=([^"']+)/) || [])[1];
    assert(mapAppTag && swJs.includes("'js/map-app.js?v=" + mapAppTag + "'"),
        'sw.js pre-caches the map-app.js build index.html loads (' + mapAppTag + ')');
    const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
    assert(shellVersion >= 209, 'the shell cache is bumped so installed PWAs pick the feature up (v' + shellVersion + ')');

    /* map-app.js tags every LiDAR layer it builds; the focus module reads that
     * tag through window._lidarGroup, so without it the feature is inert. */
    assert(/_dlLidar = \{ key: 'lidar\.' \+ key, label:/.test(mapApp),
        'map-app.js tags every LiDAR sub-layer with the family key the focus needs');
    assert(/_dlDefId = LIDAR_DEF_IDS\[key\]/.test(mapApp),
        '…keeping the registry id the country modules are keyed by');
    assert(scanner.includes('_dlLidarFocusPicking'),
        'the LiDAR Scanner stands down while the user is picking the LiDAR 3D centre');
    console.log('  ✓ index.html / sw.js / css / map-app.js / lidar-scanner.js are wired');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The disc maths and the planner (pure — no DOM needed)
 * ══════════════════════════════════════════════════════════════════════════ */
let Disc = null;
let FocusApi = null;

{
    const documentStub = new FakeDocument();
    const windowStub = {
        document: documentStub,
        setTimeout: unrefTimer, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener: function () {}, removeEventListener: function () {},
        innerWidth: 1280, innerHeight: 800,
        console: console
    };
    windowStub.window = windowStub;
    const sandbox = {
        window: windowStub, document: documentStub, console: console,
        Promise: Promise, setTimeout: unrefTimer, clearTimeout: clearTimeout,
        Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray,
        Float64Array: Float64Array, Math: Math, Object: Object, Array: Array
    };
    vm.createContext(sandbox);
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(viewerSource, sandbox, { filename: 'js/map3d-terrain.js' });
    vm.runInContext(focusSource, sandbox, { filename: 'js/lidar-3d-focus.js' });

    Disc = windowStub.DetectLabMirror.disc;
    FocusApi = windowStub.DetectLabLidar3D;
    assert(FocusApi, 'window.DetectLabLidar3D is exported');
    assert(FocusApi.VERSION.indexOf('lidar-3d-focus') !== -1, 'it carries its own version (' + FocusApi.VERSION + ')');
    assert(FocusApi.isReady() === false || FocusApi.isReady() === true, 'isReady() answers without a map');

    /* ── the disc ── */
    const disc = { lat: 45.5, lng: 25.0, radiusKm: 5 };
    const bounds = Disc.bounds(disc);
    assert(bounds[0] < 25 && bounds[2] > 25 && bounds[1] < 45.5 && bounds[3] > 45.5,
        'the disc bounds surround the centre');
    assert(Math.abs(Disc.distanceM(disc, { lat: bounds[3], lng: 25 }) - 5000) < 40,
        'the bounds are a real 5 km away (measured, not guessed)');
    const ring = Disc.ring(disc, 32);
    assert(ring.length === 33 && Math.abs(ring[32][0] - ring[0][0]) < 1e-9,
        'the outline ring is closed');

    const window16 = Disc.tileWindow(disc, 16);
    let touching = 0;
    let inside = 0;
    let outside = 0;
    for (let x = window16.x0; x <= window16.x1; x += 1) {
        for (let y = window16.y0; y <= window16.y1; y += 1) {
            if (!Disc.touchesTile(disc, 16, x, y)) outside += 1;
            else if (Disc.containsTile(disc, 16, x, y)) inside += 1;
            else touching += 1;
        }
    }
    assert(touching > 0 && inside > 0 && outside > 0,
        'the disc rectangle holds tiles outside it, tiles inside it and a rim between them');
    assert(inside + touching + outside === window16.count,
        'every tile of the window is classified exactly once');

    /* ── the plan ── */
    const plan = FocusApi.plan(
        { lat: 45.5, lng: 25.0, radiusKm: 10 },
        { minZoom: 0, maxZoom: 16, tileSize: 256, budget: 900, viewport: { width: 1280, height: 800 } }
    );
    assert(plan && plan.count > 40 && plan.count <= 900,
        'a 10 km disc plans a bounded set of tiles (' + (plan && plan.count) + ')');
    assert(plan.zoomTo <= 16 && plan.zoomFrom >= 0, 'the zoom window stays inside the layer limits');
    assert(plan.levels.length === plan.zoomTo - plan.zoomFrom + 1, 'one level per zoom in the window');
    assert(plan.zFit >= plan.zoomFrom && plan.zFit <= plan.zoomTo,
        'the zoom the camera opens on is inside the window it prepared');
    /* The download order is the contract that matters when a disc is trimmed:
     * level by level, and inside a level from the centre outwards. */
    assert(plan.levels.every(function (level, at, all) {
        return at === 0 || all[at - 1].z < level.z;
    }), 'the plan is walked from the widest zoom down to the detail');
    const perLevel = {};
    plan.tiles.forEach(function (tile) {
        perLevel[tile.z] = perLevel[tile.z] || [];
        perLevel[tile.z].push(tile.distanceM);
    });
    assert(Object.keys(perLevel).every(function (z) {
        return perLevel[z].every(function (value, at, all) { return at === 0 || all[at - 1] <= value + 1e-6; });
    }), 'and inside every zoom level it is ordered centre-first, so a trimmed download starts where the user looks');
    assert(plan.tiles.every((tile) => Disc.touchesTile(plan.disc, tile.z, tile.x, tile.y)),
        'every planned tile really intersects the disc (the rectangle is not the disc)');
    assert(plan.trimmed === 0 && plan.count < plan.budget, 'a 10 km disc fits the budget');
    assert(plan.bytes === plan.count * 48 * 1024, 'the size estimate is the tile count × the assumption');

    const small = FocusApi.plan(
        { lat: 45.5, lng: 25.0, radiusKm: 1 },
        { minZoom: 0, maxZoom: 16, tileSize: 256, budget: 900, viewport: { width: 1280, height: 800 } }
    );
    assert(small.zFit > plan.zFit,
        'a 1 km disc is planned one step deeper than a 10 km one (zFit ' + small.zFit + ' vs ' + plan.zFit + ')');
    assert(small.count < plan.count, 'and it is fewer tiles, not more');

    const trimmed = FocusApi.plan(
        { lat: 45.5, lng: 25.0, radiusKm: 10 },
        { minZoom: 0, maxZoom: 16, tileSize: 256, budget: 40, viewport: { width: 1280, height: 800 } }
    );
    assert(trimmed.count === 40 && trimmed.trimmed > 0,
        'a disc bigger than the budget is trimmed, and says by how much');
    const keptByLevel = {};
    trimmed.tiles.forEach(function (tile) {
        keptByLevel[tile.z] = keptByLevel[tile.z] || [];
        keptByLevel[tile.z].push(tile.distanceM);
    });
    assert(Object.keys(keptByLevel).every(function (z) {
        return keptByLevel[z].every(function (value, at, all) { return at === 0 || all[at - 1] <= value + 1e-6; });
    }), 'the tiles kept are the ones nearest the centre');

    /* The dialog cannot ask for more than the cap, whatever it is told. */
    assert(FocusApi.MAX_RADIUS_KM === 10, 'the hard ceiling is 10 km');
    assert(FocusApi._copy.ro.lead.indexOf('10 km') !== -1 && FocusApi._copy.en.lead.indexOf('10 km') !== -1,
        'both copies state the 10 km limit');
    assert(FocusApi._copy.ro.progress.indexOf('{done}') !== -1 && FocusApi._copy.ro.progress.indexOf('{total}') !== -1,
        'the progress line is a template with both numbers');
    assert(FocusApi._copy.ro.lead !== FocusApi._copy.en.lead &&
           FocusApi._copy.ro.pick !== FocusApi._copy.en.pick,
        'the Romanian copy is not a fallback to English');
    console.log('  ✓ the disc maths and the planner: bounded, centre-first, honest about trimming');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The clip: a circle, not a rectangle (pixels, through the mirror)
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const spec = { lat: 45.5, lng: 25.0, radiusKm: 2 };
    /* z15 tiles are ~860 m across, so a 2 km disc is guaranteed to have a tile
     * wholly inside it, a rim, and tiles the rectangle holds but the disc does
     * not — the three cases the clip exists for. */
    const z = 15;
    const window = Disc.tileWindow(spec, z);
    let inner = null;
    let edge = null;
    let outer = null;
    for (let x = window.x0; x <= window.x1 && (!inner || !edge || !outer); x += 1) {
        for (let y = window.y0; y <= window.y1; y += 1) {
            if (!outer && !Disc.touchesTile(spec, z, x, y)) outer = { z: z, x: x, y: y };
            if (!inner && Disc.containsTile(spec, z, x, y)) inner = { z: z, x: x, y: y };
            if (!edge && Disc.touchesTile(spec, z, x, y) && !Disc.containsTile(spec, z, x, y)) edge = { z: z, x: x, y: y };
        }
    }
    assert(inner && edge && outer, 'a 2 km disc at z15 has an inside, a rim and an outside tile');

    const opaque = function () {
        const size = 16;
        const pixels = new Uint8ClampedArray(size * size * 4);
        for (let i = 0; i < pixels.length; i += 4) {
            pixels[i] = 200; pixels[i + 1] = 210; pixels[i + 2] = 220; pixels[i + 3] = 255;
        }
        return pixels;
    };
    const asCanvas = function (pixels) {
        const canvas = fakeCanvas();
        canvas.width = 16;
        canvas.height = 16;
        canvas._pixels = pixels;
        return canvas;
    };

    (async function () {
        /* Inside: the payload is handed back as it is — the fast path that keeps
         * the prefetch cheap (most tiles of a disc are wholly inside it). */
        const innerCanvas = asCanvas(opaque());
        const inside = await Disc.maskTile(innerCanvas, 16, inner, spec);
        assert(inside === innerCanvas,
            'a tile entirely inside the disc comes through untouched (no pixel work at all)');

        /* Outside: null — the viewer substitutes the transparent tile. */
        const outside = await Disc.maskTile(asCanvas(opaque()), 16, outer, spec);
        assert(outside === null, 'a tile the disc does not touch resolves to “nothing to draw”');

        const blank = Disc.blankTile();
        const signature = new Uint8Array(blank).slice(0, 8);
        assert(Array.from(signature).join(',') === '137,80,78,71,13,10,26,10',
            'the blank tile the viewer substitutes is a real PNG');
        assert(new Uint8Array(blank).length === 68, '…and it is the 1×1 transparent one (68 bytes)');

        /* The rim: repainted, so part of its alpha is gone and part is left. */
        const rim = await Disc.maskTile(asCanvas(opaque()), 16, edge, spec);
        assert(rim && rim.byteLength === 16 * 16 * 4, 'the rim is repainted (' + (rim && rim.byteLength) + ' bytes)');
        const alphas = [];
        const masked = new Uint8ClampedArray(rim);
        for (let i = 3; i < masked.length; i += 4) alphas.push(masked[i]);
        const kept = alphas.filter((a) => a > 0).length;
        assert(kept > 0 && kept < alphas.length,
            'the rim keeps part of its pixels and clears the rest (' + kept + '/' + alphas.length + ')');
        assert(alphas.some((a) => a > 0 && a < 255),
            'the rim is feathered, so the edge of the disc is not a staircase');

        /* And the geometry behind it is the circle, not the rectangle: on a rim
         * tile some pixels keep full alpha, some are cleared outright, and some
         * are feathered in between. */
        const frame = { data: new Uint8ClampedArray(opaque()) };
        Disc.maskPixels(frame, 16, edge, spec);
        const rimAlphas = [];
        for (let i = 3; i < frame.data.length; i += 4) rimAlphas.push(frame.data[i]);
        assert(rimAlphas.some((a) => a === 255) && rimAlphas.some((a) => a === 0),
            'the rim keeps the side inside the circle and clears the side outside it');
        assert(rimAlphas.filter((a) => a === 0).length > 1 && rimAlphas.filter((a) => a === 255).length > 1,
            '…on both sides of the edge, not just one pixel');
        console.log('  ✓ the disc clip: inside untouched, outside transparent, rim feathered');
    })().then(runViewerSuite, function (error) {
        console.error(error);
        process.exit(1);
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. The viewer: one LiDAR layer, one prepared disc, and the gate
 * ══════════════════════════════════════════════════════════════════════════ */
function runViewerSuite() {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    container.setAttribute('id', 'detectlab-map');
    doc._register('detectlab-map', container);
    doc.body.appendChild(container);

    /* ── the little of Leaflet the mirror and the dialog touch ──────────── */
    function StubTileLayer(url, options) { this.options = options || {}; this._url = url; }
    StubTileLayer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
    StubTileLayer.prototype.getTileUrl = function (coords) {
        return this._url.replace('{z}', coords.z).replace('{x}', coords.x).replace('{y}', coords.y);
    };
    function StubLayerGroup(children) { this._layers = (children || []).slice(); }
    StubLayerGroup.prototype.getLayers = function () { return this._layers.slice(); };
    StubLayerGroup.prototype.hasLayer = function (layer) { return this._layers.indexOf(layer) !== -1; };
    StubLayerGroup.prototype.addLayer = function (layer) {
        if (!this.hasLayer(layer)) this._layers.push(layer);
        return this;
    };
    StubLayerGroup.prototype.removeLayer = function (layer) {
        const at = this._layers.indexOf(layer);
        if (at !== -1) this._layers.splice(at, 1);
        return this;
    };

    let stampSeq = 0;
    const drawn = [];                       /* circles the dialog drew in 2D */
    function circleStub(kind, latlng, options) {
        const layer = {
            _kind: kind,
            options: options || {},
            _latlng: latlng,
            _radius: (options && options.radius) || 0,
            addTo: function (map) { map.addLayer(layer); drawn.push(layer); return layer; },
            setStyle: function () { return layer; },
            setLatLng: function (value) { layer._latlng = value; return layer; },
            setRadius: function (value) { layer._radius = value; return layer; },
            bringToFront: function () { return layer; }
        };
        return layer;
    }
    const Leaflet = {
        TileLayer: StubTileLayer,
        LayerGroup: StubLayerGroup,
        stamp: function (layer) {
            if (!layer._leaflet_id) { stampSeq += 1; layer._leaflet_id = 'L' + stampSeq; }
            return layer._leaflet_id;
        },
        point: function (x, y) {
            return { x: x, y: y, z: 0, scaleBy: function () { return this; }, add: function () { return this; }, multiplyBy: function () { return this; } };
        },
        circle: function (latlng, options) { return circleStub('circle', latlng, options); },
        circleMarker: function (latlng, options) { return circleStub('circleMarker', latlng, options); },
        DomEvent: { stopPropagation: function () {} }
    };

    const map = {
        _handlers: {},
        _layers: [],
        panes: {},
        on: function (type, fn) { (map._handlers[type] = map._handlers[type] || []).push(fn); },
        off: function (type, fn) {
            const list = map._handlers[type] || [];
            const at = list.indexOf(fn);
            if (at !== -1) list.splice(at, 1);
        },
        addLayer: function (layer) {
            if (map._layers.indexOf(layer) === -1) map._layers.push(layer);
            if (layer && typeof layer.getLayers === 'function') layer.getLayers().forEach(function (child) { map.addLayer(child); });
            return map;
        },
        removeLayer: function (layer) {
            const at = map._layers.indexOf(layer);
            if (at !== -1) map._layers.splice(at, 1);
            return map;
        },
        hasLayer: function (layer) { return map._layers.indexOf(layer) !== -1; },
        eachLayer: function (fn) { map._layers.slice().forEach(function (layer) { fn(layer); }); },
        getPane: function (name) {
            if (!map.panes[name]) map.panes[name] = { style: {}, classList: { add: function () {}, remove: function () {} } };
            return map.panes[name];
        },
        createPane: function (name) {
            const pane = map.getPane(name);
            if (!pane.style.zIndex) pane.style.zIndex = name === 'pane_lidar' ? '610' : '656';
            return pane;
        },
        getContainer: function () { return container; },
        getCenter: function () { return { lat: 45.7, lng: 24.9 }; },
        getZoom: function () { return 12; },
        getBounds: function () { return { contains: function () { return false; } }; },
        fire: function (type, event) { (map._handlers[type] || []).slice().forEach(function (fn) { fn(event); }); },
        _click: function (lat, lng) {
            (map._handlers.click || []).slice().forEach(function (fn) {
                fn({ latlng: { lat: lat, lng: lng }, originalEvent: { stopPropagation: function () {} } });
            });
        }
    };

    map.getPane('pane_lidar').style.zIndex = '610';

    const ro1m = new StubTileLayer('https://tiles.example.org/ro1m/MapServer/tile/{z}/{y}/{x}', {
        name: 'Romania 1m/pixel agregare', className: 'lidar-ro1m-tiles', maxNativeZoom: 13,
        minZoom: 0, opacity: 0.85, pane: 'pane_lidar', attribution: '© LIDAR RO'
    });
    ro1m._leaflet_id = 'R1';
    ro1m._dlLidar = { key: 'lidar.ro1m', label: 'Romania 1m/pixel agregare' };
    const ab = new StubTileLayer('https://tiles.example.org/ab/MapServer/tile/{z}/{y}/{x}', {
        name: 'AB', maxNativeZoom: 13, minZoom: 0, opacity: 0.6, pane: 'pane_lidar', attribution: '© LIDAR AB'
    });
    ab._leaflet_id = 'A1';
    ab._dlLidar = { key: 'lidar.ab', label: 'AB' };
    const lidarGroup = new StubLayerGroup([ro1m, ab]);
    map.addLayer(lidarGroup);

    /* ── the sandbox ────────────────────────────────────────────────────── */
    let fetchCount = 0;
    const fetched = [];
    function fakeFetch(url) {
        fetchCount += 1;
        fetched.push(String(url));
        return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: function () { return null; } },
            arrayBuffer: function () { return Promise.resolve(new ArrayBuffer(4096)); }
        });
    }
    const quiet = { log: console.log, warn: function () {}, error: console.error, info: function () {}, debug: function () {}, table: function () {} };
    const windowStub = {
        document: doc,
        L: Leaflet,
        _dlMap: map,
        _lidarGroup: lidarGroup,
        fetch: fakeFetch,
        Blob: Blob,
        URL: URL,
        createImageBitmap: fakeImageDecoder,
        CustomEvent: function (type, init) { return { type: type, detail: (init || {}).detail }; },
        innerWidth: 1280, innerHeight: 800,
        setTimeout: unrefTimer, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener: function () {}, removeEventListener: function () {},
        localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
        matchMedia: function () { return { matches: false }; },
        navigator: { maxTouchPoints: 0, onLine: true },
        console: quiet
    };
    windowStub.window = windowStub;
    const sandbox = {
        window: windowStub, document: doc, console: quiet,
        Promise: Promise, setTimeout: unrefTimer, clearTimeout: clearTimeout,
        Blob: Blob, URL: URL, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray,
        Float64Array: Float64Array, ArrayBuffer: ArrayBuffer, Math: Math, Object: Object, Array: Array,
        navigator: windowStub.navigator, CustomEvent: windowStub.CustomEvent
    };
    vm.createContext(sandbox);
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(viewerSource, sandbox, { filename: 'js/map3d-terrain.js' });
    vm.runInContext(focusSource, sandbox, { filename: 'js/lidar-3d-focus.js' });

    const viewer = windowStub.DetectLabMap3D;
    const focus = windowStub.DetectLabLidar3D;
    const mirror = windowStub.DetectLabMirror;
    assert(viewer && focus && mirror, 'the viewer, the focus module and the mirror all installed themselves');

    /* ── 4a. What the mirror says about the two LiDAR layers ────────────── */
    const deck = viewer._mirror();
    const ro1mItem = deck.items.filter(function (i) { return i.lidarKey === 'lidar.ro1m'; })[0];
    const abItem = deck.items.filter(function (i) { return i.lidarKey === 'lidar.ab'; })[0];
    assert(ro1mItem && abItem, 'both tagged LiDAR layers reach the deck (' + deck.items.length + ' items)');
    assert(ro1mItem.lidarLabel === 'Romania 1m/pixel agregare' && abItem.lidarLabel === 'AB',
        'each carries the label the dialog shows');
    assert(ro1mItem.blend === 'invert-screen' && ro1mItem.template === 'dl2d://2d.R1/{z}/{x}/{y}',
        'the Romanian 1 m hillshade keeps its CSS blend and is asked of the 2D layer itself');
    assert(ro1mItem.defId === null && abItem.defId === null,
        'the Romanian sub-layers are not registry definitions — the focus must work for them too');

    /* ── 4b. One LiDAR layer at a time ──────────────────────────────────── */
    const layers = focus.activeLayers();
    assert(layers.length === 2, 'both LiDAR sub-layers on the 2D map are offered (' + layers.length + ')');
    assert(layers.map(function (entry) { return entry.key; }).join(',') === '2d.R1,2d.A1',
        'named by the mirror key the 3D deck uses');
    assert(layers[0].label === 'Romania 1m/pixel agregare' && layers[1].label === 'AB',
        'with the panel labels the user recognises');
    assert(layers.every(function (entry) { return entry.maxzoom === 13; }),
        'and the zoom ceiling of the layer itself (13 here)');
    assert(layers[0].lidarKey === 'lidar.ro1m' && layers[0].key === '2d.R1',
        'each entry carries both key spaces: the LiDAR family key and the deck key');

    /* No prepared disc (a LiDAR layer switched on while 3D is already open, or
     * 3D opened from the console): nothing LiDAR is draped. Opening one of these
     * pyramids unprompted is exactly the slow, blank load this path prevents. */
    const keep = viewer._lidarFilter();
    const kept = deck.items.filter(function (item) { return keep(item) && item.lidarKey; });
    assert(kept.length === 0, 'without a prepared disc no LiDAR layer is draped at all');
    assert(deck.items.filter(function (item) { return keep(item) && !item.lidarKey; }).length === 0,
        'and the deck is empty here because there is nothing else on the 2D map');
    assert(viewer.status().lidar.notes.some(function (note) { return note.reason === 'unprepared'; }),
        'status() names the state, so the bar can point at the dialog instead of being silently empty');

    /* ── 4c. A focus picks the layer, and only inside its disc ──────────── */
    /* Exactly what js/lidar-3d-focus.js hands to setLidarFocus(): the deck key
     * (what dl2d:// and the clip are addressed by) and the LiDAR family key the
     * mirror put on the item. */
    const ro1mFocus = { key: '2d.R1', lidarKey: layers[0].lidarKey, defId: layers[0].defId,
        label: 'Romania 1m/pixel agregare', lat: 45.5, lng: 25.0, radiusKm: 2 };
    viewer.setLidarFocus(ro1mFocus);
    const applied = viewer.getLidarFocus();
    assert(applied && applied.key === '2d.R1' && applied.mask && applied.mask.radiusKm === 2,
        'setLidarFocus() applies the disc the user chose');
    assert(Array.isArray(applied.bounds) && applied.bounds.length === 4,
        'and derives the rectangle MapLibre may ask for');
    const focusedKeep = viewer._lidarFilter();
    assert(focusedKeep(ro1mItem) === true && focusedKeep(abItem) === false,
        'with a focus, the chosen LiDAR layer is drawn and the other one is not (the user’s choice wins over “topmost”)');
    assert(viewer.status().lidar.focus.key === '2d.R1' &&
           viewer.status().lidar.notes.some(function (note) { return note.reason === 'focused'; }),
        'status().lidar names the focused layer and says so');
    assert(viewer.status().lidar.notes[0].count === 2,
        'and counts the two LiDAR layers on the 2D map, so the bar can say “one at a time”');
    assert(viewer._focusExcludesTile('2d.R1', 10, 0, 0) === true,
        'a tile on the other side of the world is outside the disc');
    const centreTile = {
        z: 14,
        x: Math.floor(mirror.disc.lngToTileX(25, 14)),
        y: Math.floor(mirror.disc.latToTileY(45.5, 14))
    };
    assert(viewer._focusExcludesTile('2d.R1', centreTile.z, centreTile.x, centreTile.y) === false,
        'the tile under the centre of the disc is inside it');
    assert(viewer._focusExcludesTile('2d.A1', 10, 0, 0) === false,
        'a layer that is not focused is never clipped');
    assert(viewer._focusSig('2d.R1').indexOf('@45.5,25,2') !== -1,
        'the focus signature pins the disc, so a moved disc cannot reuse the old tiles');

    /* ── 4d. Prefetch: the same path 3D draws with, and no second download ─ */
    return (async function () {
        const entry = layers.filter(function (item) { return item.key === '2d.R1'; })[0];
        const plan = focus.plan(
            { lat: 45.5, lng: 25.0, radiusKm: 2 },
            { minZoom: entry.minzoom, maxZoom: entry.maxzoom, tileSize: entry.tileSize, budget: 700, viewport: { width: 1280, height: 800 } }
        );
        assert(plan && plan.count > 0 && plan.count <= 700, 'the dialog’s plan for a 2 km disc is bounded (' + plan.count + ')');
        /* Exactly what refreshPlan() does before planEntries() is called. */
        plan.route = 'url';
        plan.layer = entry;
        plan.focus = { key: entry.key, lidarKey: entry.lidarKey, defId: entry.defId, lat: 45.5, lng: 25.0, radiusKm: 2 };

        const entries = focus.planEntries(plan);
        assert(entries.length === plan.count && entries.length > 0, 'the plan becomes fetch entries');
        assert(entries.every(function (item) { return item.url && item.layerKey === '2d.R1'; }),
            'every entry carries the concrete tile URL and the layer it belongs to');
        assert(entries.every(function (item) { return /^https:\/\/tiles\.example\.org\/ro1m\//.test(item.url); }),
            'the URLs are the ones the 2D layer itself builds — nothing is re-implemented');
        assert(entries.every(function (item) { return item.template === 'dl2d://2d.R1/{z}/{x}/{y}'; }),
            'each entry also knows the deck template it will be served under');

        fetchCount = 0;
        const progress = [];
        const report = await viewer.prefetchTiles(entries, {
            concurrency: 4,
            onProgress: function (value) { progress.push(value.done); }
        });
        assert(report.total === entries.length && report.done === entries.length && report.prepared === entries.length,
            'every planned tile was downloaded and prepared (' + report.prepared + '/' + report.total + ')');
        assert(report.failed === 0 && report.errors.length === 0, 'and none of them failed');
        assert(fetchCount === entries.length, 'exactly one request per tile (no retries, no duplicates)');
        assert(progress.length >= entries.length,
            'progress was reported per tile (' + progress.length + ' updates for ' + entries.length + ' tiles)');
        assert(progress.every(function (value, at, all) { return at === 0 || value >= all[at - 1]; }),
            'progress never goes backwards (' + progress.join(',') + ')');
        assert(progress[progress.length - 1] === entries.length,
            'and the last update is the whole disc (' + progress[progress.length - 1] + '/' + entries.length + ')');
        assert(viewer.status().lidar.primed.entries === entries.length,
            'the prepared tiles are counted in status().lidar.primed.entries');
        assert(viewer.primedBytes() > 0, 'and their bytes are counted too');
        assert(entries.every(function (item) { return viewer.isPrepared(item.url, '2d.R1') === true; }),
            'every tile of the disc answers “prepared” — the dialog will not promise a download it does not need');

        /* …and “prepared” has to mean the TILE, not the transparent placeholder
         * the disc clip writes for a tile outside the disc. The prefetch used
         * to hand the clip the fetch's own `{ data }` object (a callback
         * parameter shadowing the `{ z, x, y }` tile identity), so the clip read
         * z/x/y as undefined, judged every tile of the disc to be outside it and
         * cached the 1×1 transparent PNG as the prepared bytes: the dialog
         * reported every tile as downloaded and draped, 3D showed an empty
         * circle, and nothing was ever re-fetched because the cache said so. */
        const placeholder = mirror.disc.blankTile();
        const served = entries.map(function (item) { return viewer.preparedTile(item.url, '2d.R1'); });
        assert(served.every(function (bytes) { return !!bytes && bytes.byteLength > placeholder.byteLength; }),
            'every prepared tile carries the pixels the service sent, not the placeholder (' +
            served.map(function (b) { return b ? b.byteLength : 0; }).join(',') + ' bytes vs ' +
            placeholder.byteLength + ')');
        /* The disc clip runs on the tile's own coordinates: a tile the disc
         * covers is kept, one it only grazes is clipped, one it misses is the
         * placeholder. Ask the cache for a tile the plan never asked for. */
        const outside = mirror.disc.tileWindow(plan.disc, plan.zFit);
        let missed = null;
        for (let x = outside.x0; x <= outside.x1 && !missed; x += 1) {
            for (let y = outside.y0; y <= outside.y1 && !missed; y += 1) {
                if (!mirror.disc.touchesTile(plan.disc, plan.zFit, x, y)) missed = { z: plan.zFit, x: x, y: y };
            }
        }
        if (missed) {
            const url = mirror.tileUrlFor(plan.layer.layer, missed.z, missed.x, missed.y);
            assert(viewer._focusExcludesTile('2d.R1', missed.z, missed.x, missed.y) === true,
                'a tile outside the disc is excluded, so nothing is fetched around it');
            assert(viewer.preparedTile(url, '2d.R1') === null,
                'and it was never prepared in the first place');
        }
        assert(viewer.isPrepared('https://tiles.example.org/ro1m/other/1/1/1', '2d.R1') === false,
            'a tile that was never fetched does not');

        /* The second run is the important one: reopening 3D on the same disc
         * must not ask the provider for anything again. */
        const again = entries.map(function (item) {
            return { route: item.route, url: item.url, layerKey: item.layerKey, template: item.template,
                z: item.z, x: item.x, y: item.y };
        });
        fetchCount = 0;
        const second = await viewer.prefetchTiles(again, { concurrency: 4 });
        assert(fetchCount === 0, 'a second prefetch over the same disc makes no request at all (it is all in memory)');
        assert(second.prepared === second.total, 'and it still reports every tile as prepared');

        /* ── 4d-bis. Serving: what MapLibre is actually handed in 3D ─────
         * The prefetch above only proves the tiles are IN memory. The disc
         * the user sees is whatever the dl2d:// protocol handler answers
         * when MapLibre asks, tile by tile, at the zooms the opening camera
         * requests — so drive the real handler, exactly as MapLibre would,
         * and require the prepared pixels (never the transparent
         * placeholder, never a fresh download) for every tile of the disc. */
        const protocols = {};
        viewer._registerProtocols({
            addProtocol: function (name, handler) { protocols[name] = handler; }
        });
        assert(typeof protocols.dl2d === 'function' && typeof protocols.dl3d === 'function',
            'the dl2d:// and dl3d:// protocol handlers are registered');
        fetchCount = 0;
        const servedPlaceholder = mirror.disc.blankTile();
        for (const item of entries) {
            const answer = await protocols.dl2d(
                { url: 'dl2d://2d.R1/' + item.z + '/' + item.x + '/' + item.y }, null);
            assert(answer && answer.data && answer.data.byteLength > servedPlaceholder.byteLength,
                'the tile ' + item.z + '/' + item.x + '/' + item.y +
                ' is served its prepared pixels in 3D, not the transparent placeholder');
        }
        assert(fetchCount === 0,
            'serving the prepared disc makes no request at all (it is all in memory)');

        /* ── 4d-ter-0. A failed open must not wedge the viewer ────────────
         * “Fetch finished, then nothing happens at all” has a state-machine
         * form: an open that fails AFTER state.open was set (the no-WebGL
         * report is the one path that did not clear it, unlike fail3D)
         * leaves the viewer believing it is open, so every later tap on
         * the 3D button returns “already open” and does nothing — no
         * dialog, no veil, no map. The failed open must read as closed,
         * and the next tap must really try again. */
        {
            viewer.setEntryGate(function () { return Promise.resolve(true); });
            const refused = await viewer.open();
            assert(refused === false && viewer.status().failed === true,
                'the sandbox has no WebGL, so the open reports its failure');
            assert(viewer.isOpen() === false,
                'and the viewer reads as CLOSED after it — one more tap must retry, not no-op');
            viewer.close();
        }

        /* ── 4d-ter. Entering 3D: the whole handoff, with a fake MapLibre ──
         * “Fetches finished, 3D opened, base map there, LiDAR nowhere” is an
         * integration symptom: it can live in the gate, the camera, the deck
         * plan, the source spec or the serve path, and the unit sections
         * above each clear their own stretch. So here the REAL flow runs end
         * to end — viewer.open() → the real gate → the real dialog confirm →
         * the real prefetch → openNow() against a recording MapLibre — and
         * the map the user would see is inspected: the focused source must
         * exist, bounded to the disc, stacked above the base map, and every
         * tile MapLibre would ask for at the opening camera must come back
         * as the prepared pixels. */
        {
            /* A GL-capable canvas while 3D opens (the webgl probe is the
             * only thing that asks for one; everything else keeps the 2D
             * stub), restored before the gate section below. */
            const realCreateElement = doc.createElement;
            doc.createElement = function (tag) {
                if (tag === 'canvas') {
                    const c = fakeCanvas();
                    const ctx2d = c.getContext('2d');
                    c.getContext = function (kind) {
                        return kind === '2d' ? ctx2d : { getExtension: function () { return null; } };
                    };
                    return c;
                }
                return realCreateElement(tag);
            };
            const fakeSources = {};
            const fakeLayers = {};
            const fakeOrder = [];
            class FakeMap {
                constructor(options) {
                    this.options = options;
                    this._handlers = {};
                    this.touchZoomRotate = { enableRotation: function () {} };
                }
                on(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); return this; }
                fire(type, event) { (this._handlers[type] || []).slice().forEach(function (fn) { fn(event || {}); }); }
                addControl() { return this; }
                getCanvas() { return realCreateElement('div'); }
                addSource(id, spec) { fakeSources[id] = Object.assign({ setData: function () {} }, spec); }
                getSource(id) { return fakeSources[id] || null; }
                removeSource(id) { delete fakeSources[id]; }
                addLayer(spec) { if (!fakeLayers[spec.id]) fakeOrder.push(spec.id); fakeLayers[spec.id] = spec; }
                getLayer(id) { return fakeLayers[id] || null; }
                removeLayer(id) {
                    delete fakeLayers[id];
                    const at = fakeOrder.indexOf(id);
                    if (at !== -1) fakeOrder.splice(at, 1);
                }
                moveLayer(id, beforeId) {
                    const at = fakeOrder.indexOf(id);
                    if (at !== -1) fakeOrder.splice(at, 1);
                    const to = beforeId ? fakeOrder.indexOf(beforeId) : -1;
                    if (to === -1) fakeOrder.push(id); else fakeOrder.splice(to, 0, id);
                }
                setPaintProperty() {}
                getCenter() { return { lat: 45.5, lng: 25.0 }; }
                getZoom() { return 12; }
                getBearing() { return 0; }
                getPitch() { return 60; }
                loaded() { return true; }
                remove() {}
            }
            let fakeMap = null;
            windowStub.maplibregl = {
                Map: function (options) { fakeMap = new FakeMap(options); return fakeMap; },
                AttributionControl: class { constructor(o) { this.options = o; } },
                ScaleControl: class { constructor(o) { this.options = o; } },
                addProtocol: function () {}
            };

            viewer.setEntryGate(function () { return focus._gate(); });
            const opening = viewer.open();
            await tick(); await tick(); await tick();
            const gateNode = doc.body.querySelector('#map3d-focus');
            assert(gateNode && gateNode.hidden === false,
                'entering 3D asks first — the gate dialog is up before any map exists');
            assert(!fakeMap, 'and no 3D map has been created yet');
            gateNode.querySelector('.m3d-focus-go').click();
            const opened = await opening;
            assert(opened === true && viewer.isOpen() === true,
                'once the disc is prepared the gate lets 3D open');
            assert(fakeMap, 'a MapLibre map was created for the 3D view');
            fakeMap.fire('styledata');

            const focusNow = viewer.getLidarFocus();
            assert(focusNow && focusNow.key === '2d.R1', 'the focus survives the handoff');
            const lidarSource = fakeSources['m3d-2d-2d.R1-src'];
            assert(lidarSource, 'the focused LiDAR layer has a source on the 3D map');
            assert(lidarSource.tiles && lidarSource.tiles[0] === 'dl2d://2d.R1/{z}/{x}/{y}',
                'served from the live 2D layer through dl2d:// (' + (lidarSource.tiles || [])[0] + ')');
            assert(JSON.stringify(lidarSource.bounds) === JSON.stringify(focusNow.bounds),
                'and the source may only ask for tiles inside the prepared disc');
            assert(fakeLayers['m3d-2d-2d.R1'], 'the focused LiDAR layer is on the 3D map');
            assert(fakeOrder.indexOf('m3d-2d-2d.R1') > fakeOrder.indexOf('base.imagery'),
                'stacked above the base map, not underneath it');
            assert(viewer.status().lidar.drawn.some(function (d) { return d.id === 'm3d-2d-2d.R1'; }),
                'status() reports the LiDAR layer as drawn');

            /* The tiles of the disc, asked the way MapLibre asks them. */
            fetchCount = 0;
            for (const item of entries) {
                const answer = await protocols.dl2d(
                    { url: 'dl2d://2d.R1/' + item.z + '/' + item.x + '/' + item.y }, null);
                assert(answer && answer.data && answer.data.byteLength > servedPlaceholder.byteLength,
                    'on the opened map, tile ' + item.z + '/' + item.x + '/' + item.y +
                    ' still serves its prepared pixels');
            }
            assert(fetchCount === 0, 'and the opened view downloads nothing for the disc');

            viewer.close();
            assert(viewer.isOpen() === false, 'closing returns to the 2D map');
            doc.createElement = realCreateElement;
            delete windowStub.maplibregl;
        }

        /* ── 4e. The gate ───────────────────────────────────────────────── */
        let gateCalls = 0;
        viewer.setEntryGate(function () { gateCalls += 1; return Promise.resolve(false); });
        assert(viewer.hasEntryGate() === true, 'the entry gate is installed');
        const refused = await viewer.open();
        assert(gateCalls === 1 && refused === false && viewer.isOpen() === false,
            'a gate that says no leaves the 3D view closed (this is the “ask first” contract)');

        /* A second tap while the gate is still deciding must not start a second
         * dialog — it joins the promise already in flight. */
        let resolveGate = null;
        viewer.setEntryGate(function () { return new Promise(function (resolve) { resolveGate = resolve; }); });
        const first = viewer.open();
        const second4 = viewer.open();
        assert(first === second4, 'a second open() while the gate is pending shares the same promise');
        await Promise.resolve();
        assert(typeof resolveGate === 'function', 'the gate really was consulted');
        resolveGate(false);
        assert((await first) === false, 'and both resolve to “not opened” when the user cancels');

        /* A gate that lets the flow continue does reach openNow(). The sandbox
         * has no WebGL, so the viewer reports its own no-WebGL veil — that is
         * the app’s behaviour, not the gate’s; what matters here is that the
         * view was allowed to open at all. */
        viewer.setEntryGate(function () { return Promise.resolve(true); });
        await viewer.open();
        assert(doc.body.classList.contains('is-3d'),
            'a gate that allows it lets open() reach the 3D surface');
        assert(viewer.isOpen() === false,
            'but with no WebGL the viewer reads as closed afterwards, so the next tap retries (see §4d-ter-0)');
        assert(viewer.status().failed === true && viewer.status().webgl.webgl === false,
            'the sandbox has no WebGL, so the view reports the missing context instead of a blank canvas');
        viewer.close();
        assert(viewer.isOpen() === false && doc.body.classList.contains('is-3d') === false,
            'closing it puts the 2D map back');

        /* LiDAR removed from 3D: no LiDAR layer is drawn at all, by decision. */
        viewer.clearLidarFocus();
        const off = viewer.status().lidar;
        assert(off.off === true && off.focus === null, 'clearLidarFocus() switches LiDAR off in 3D');
        const offFilter = viewer._lidarFilter();
        assert(offFilter(ro1mItem) === false && offFilter(abItem) === false,
            'and neither LiDAR layer sneaks back into the deck');
        assert(viewer.status().lidar.notes.some(function (note) { return note.reason === 'off'; }),
            'the bar can say why nothing LiDAR is drawn');
        assert(viewer.status().lidar.drawn.length === 0, 'and nothing LiDAR is reported as drawn');

        /* ── 4f. The camera frames the disc ─────────────────────────────── */
        viewer.setLidarFocus(ro1mFocus);
        const fit = viewer.focusFitZoom();
        assert(fit > 6 && fit <= 13,
            'the fit zoom for a 2 km disc is where the disc fills the view, inside the layer ceiling (' + fit + ')');
        const cam = viewer._focusCamera({ center: [10, 50], zoom: 3, bearing: 0, pitch: 62 });
        assert(Math.abs(cam.center[0] - 25) < 0.05 && Math.abs(cam.center[1] - 45.5) < 0.05,
            'opening 3D on a focus frames the disc, not the 2D camera (which was elsewhere)');
        assert(cam.zoom === fit && cam.bearing === 0,
            'at the fit zoom, keeping the bearing the 2D map is at');

        /* ── 4g. The dialog, end to end ─────────────────────────────────── */
        await dialogSuite(doc, windowStub, viewer, focus, mirror, map, drawn, fetched, lidarGroup);

        /* ── 4h. First entry with a canvas-drawn layer: the prefetch must
         * prepare the disc it promises ───────────────────────────────────
         * The country LiDAR products (AHN, Høydedata, NMT, …) draw their
         * own tiles: the dialog's plan runs on the 'canvas' route and the
         * viewer renders each tile through the live 2D layer, addressed by
         * its mirror key. On a first entry the mirror has never collected
         * (collecting is something the viewer does once 3D opens), so a
         * prefetch that resolves the layer through the mirror's key table
         * finds NOTHING there: every tile rejects, the report says they all
         * failed, the dialog folds anyway — and 3D then depends on live
         * per-tile requests racing MapLibre's aborts, which is how a
         * “prepared” disc sometimes opens as base map alone. The layer
         * below joins the 2D map only now, after every collect the suite
         * has run, which is exactly the first-entry state. (The keepalive
         * is harness plumbing: a rendered tile settles on the sandbox's
         * unref'd timers, and Node would otherwise drain the loop and
         * exit mid-section.) */
        const keepalive = setInterval(function () {}, 25);
        {
            const canvasLayer = {
                options: { name: 'Canvas LiDAR', pane: 'pane_lidar', opacity: 0.9, minZoom: 0, maxZoom: 18 },
                _leaflet_id: 'C1',
                _dlLidar: { key: 'lidar.canvas', label: 'Canvas LiDAR' },
                getTileSize: function () { return { x: 256, y: 256 }; },
                createTile: function (coords, done) {
                    const tile = fakeCanvas();
                    tile.width = 256;
                    tile.height = 256;
                    return tile;         /* canvas tiles settle on the returned canvas */
                }
            };
            lidarGroup.addLayer(canvasLayer);
            map.addLayer(canvasLayer);

            const entryC = focus.activeLayers().filter(function (e) { return e.key === '2d.C1'; })[0];
            assert(entryC, 'the canvas-drawn LiDAR layer is offered by the dialog');
            const discC = { lat: 45.5, lng: 25.0, radiusKm: 2 };
            const planC = focus.plan(discC,
                { minZoom: 0, maxZoom: 18, tileSize: 256, budget: 260, viewport: { width: 1280, height: 800 } });
            planC.route = 'canvas';
            planC.layer = entryC;
            planC.focus = { key: '2d.C1', lidarKey: 'lidar.canvas', defId: null,
                label: 'Canvas LiDAR', lat: discC.lat, lng: discC.lng, radiusKm: discC.radiusKm };
            viewer.setLidarFocus(planC.focus);
            assert(mirror.layerByKey('2d.C1') === null,
                'the mirror has never collected this layer — the first-entry state');
            const entriesC = focus.planEntries(planC);
            assert(entriesC.length > 0 && entriesC.every(function (e) { return e.route === 'canvas'; }),
                'the plan runs on the canvas route (' + entriesC.length + ' tiles)');
            const repC = await viewer.prefetchTiles(entriesC, { concurrency: 4 });
            assert(repC.failed === 0 && repC.prepared === repC.total,
                'the prefetch really renders every canvas tile of the disc (' +
                repC.prepared + '/' + repC.total + ' prepared, ' + repC.failed + ' failed)');
            const centreC = entriesC[Math.floor(entriesC.length / 2)];
            const servedC = await protocols.dl2d(
                { url: 'dl2d://2d.C1/' + centreC.z + '/' + centreC.x + '/' + centreC.y }, null);
            assert(servedC && servedC.data && servedC.data.byteLength > servedPlaceholder.byteLength,
                'and the opened view is handed the rendered tile, not the placeholder');

            /* A def-backed canvas layer (the nine country products) is
             * served in 3D through dl3d://<defId>, while its prefetch —
             * the canvas route again — stores under the dl2d:// deck key.
             * The prepared disc must still be what MapLibre is handed:
             * asking dl3d for a prepared tile may not cost a request. */
            windowStub.AhnLidar = {
                tileUrl: function () { return ''; },
                exportImageUrl: function (mode, bbox, size) {
                    return 'https://ahn.example.org/export?bbox=' + bbox.join(',');
                },
                MODES: { dtm: {} },
                modeKeys: function () { return ['dtm']; }
            };
            const defLayer = {
                options: { name: 'AHN canvas', pane: 'pane_lidar', opacity: 0.9, minZoom: 8, maxZoom: 20 },
                _leaflet_id: 'C2',
                _dlDefId: 'lidar.nl-ahn',
                _dlLidar: { key: 'lidar.nlAhn', label: 'AHN canvas' },
                getTileSize: function () { return { x: 256, y: 256 }; },
                createTile: function (coords, done) {
                    const tile = fakeCanvas();
                    tile.width = 256;
                    tile.height = 256;
                    return tile;
                }
            };
            lidarGroup.addLayer(defLayer);
            map.addLayer(defLayer);
            const entryD = focus.activeLayers().filter(function (e) { return e.key === '2d.C2'; })[0];
            assert(entryD && entryD.defId === 'lidar.nl-ahn', 'the def-backed canvas layer is offered');
            const planD = focus.plan(discC,
                { minZoom: 8, maxZoom: 20, tileSize: 256, budget: 260, viewport: { width: 1280, height: 800 } });
            planD.route = 'canvas';
            planD.layer = entryD;
            planD.focus = { key: '2d.C2', lidarKey: 'lidar.nlAhn', defId: 'lidar.nl-ahn',
                label: 'AHN canvas', lat: discC.lat, lng: discC.lng, radiusKm: discC.radiusKm };
            viewer.setLidarFocus(planD.focus);
            const entriesD = focus.planEntries(planD);
            const repD = await viewer.prefetchTiles(entriesD, { concurrency: 4 });
            assert(repD.failed === 0 && repD.prepared === repD.total,
                'the def-backed disc is prepared too (' + repD.prepared + '/' + repD.total + ')');
            fetchCount = 0;
            const centreD = entriesD[Math.floor(entriesD.length / 2)];
            const servedD = await protocols.dl3d(
                { url: 'dl3d://lidar.nl-ahn/' + centreD.z + '/' + centreD.x + '/' + centreD.y }, null);
            assert(servedD && servedD.data && servedD.data.byteLength > servedPlaceholder.byteLength,
                'dl3d serves the tile the canvas prefetch prepared');
            assert(fetchCount === 0,
                'without asking the provider again — the prepared disc is the one that is drawn');
            delete windowStub.AhnLidar;
        }

        /* ── 4i. “Done” must always hand over ──────────────────────────────
         * The gate is answered by settle(), and settle() sits at the END of
         * the fetch-finished bookkeeping (apply the counted focus, paint
         * “Done”, write the pill summary). If any of that throws in a real
         * browser — a Leaflet layer that will not restyle, a bar row that
         * is mid-teardown — the dialog used to sit at “Done” forever: the
         * fetch had finished, the gate was never answered, and nothing
         * else happened. The entry must survive its own bookkeeping. */
        {
            const realSetFocus = viewer.setLidarFocus;
            let applications = 0;
            viewer.setLidarFocus = function (focusArg) {
                applications += 1;
                if (applications > 1) throw new Error('sabotaged second application');
                return realSetFocus(focusArg);
            };
            const entryPromise = focus.openDialog({ mode: 'gate' });
            const node = doc.body.querySelector('#map3d-focus');
            assert(node && node.hidden === false, 'the dialog is up for the sabotaged entry');
            node.querySelector('.m3d-focus-go').click();
            const verdict = await Promise.race([
                entryPromise.then(function (result) { return result; }),
                wait(4000).then(function () { return 'never settled'; })
            ]);
            viewer.setLidarFocus = realSetFocus;
            assert(verdict !== 'never settled',
                'the gate is answered even when the post-fetch bookkeeping throws');
            assert(verdict && verdict.cancelled === false,
                'and the answer is still “enter 3D” — the disc was applied before the fetch');
            assert(focus.status().dialog.minimized === true,
                'the window still folds into its pill for the view that opens');
        }
        clearInterval(keepalive);
        console.log('\n✅ test-lidar-3d-focus.js passed all checks successfully.');
    })().catch(function (error) {
        console.error(error);
        process.exit(1);
    });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. The dialog: point, distance, progress, and what the user is left with
 * ══════════════════════════════════════════════════════════════════════════ */
async function dialogSuite(doc, windowStub, viewer, focus, mirror, map, drawn, fetched, lidarGroup) {
    assert(viewer.getLidarFocus() && viewer.getLidarFocus().key === '2d.R1',
        'the suite starts from the focus the prefetch prepared');

    const promise = focus.openDialog({ mode: 'gate' });
    const node = doc.body.querySelector('#map3d-focus');
    assert(node && node.hidden === false, 'openDialog() builds and shows the dialog');
    assert(doc.body.classList.contains('m3d-focus-open'), 'and marks the body');
    const status = focus.status();
    assert(status.dialog.open === true && status.dialog.mode === 'gate', 'status() reports it open');
    assert(status.layers.length === 2, 'both LiDAR layers on the 2D map are offered');

    const title = node.querySelector('#m3d-focus-title').textContent;
    assert(/LiDAR/.test(title), 'the dialog is titled (' + title + ')');
    const lead = node.querySelector('.m3d-focus-lead').textContent;
    assert(/10 km/.test(lead), 'the lead states the 10 km maximum (' + lead.slice(0, 60) + '…)');
    assert(/(punct|point)/i.test(lead) && /(distan|distance)/i.test(lead),
        'and asks for the point and the fetching distance');

    const rows = node.querySelectorAll('.m3d-focus-layer');
    assert(rows.length === 2, 'one row per LiDAR layer on the 2D map (' + rows.length + ')');
    const radios = node.querySelectorAll('.m3d-focus-layer input[type="radio"]');
    assert(radios.length === 2, 'they are a radio group — 3D drapes exactly one of them');
    assert(radios.filter(function (input) { return input.checked; }).length === 1,
        'and exactly one is preselected');

    const radius = node.querySelector('#m3d-focus-radius');
    assert(Number(radius.getAttribute('min')) === 1 && Number(radius.getAttribute('max')) === 10,
        'the distance slider cannot go past the 10 km the lead promises');
    assert(/km/.test(node.querySelector('.m3d-focus-radius-val').textContent),
        'the current distance is written next to the slider');
    const chips = node.querySelectorAll('.m3d-focus-chips button');
    assert(chips.length >= 3, 'quick distances are offered (' + chips.length + ')');
    assert(chips.every(function (chip) { return Number(chip.getAttribute('data-radius')) <= 10; }),
        'and none of them exceeds the cap either');
    assert(node.querySelector('.m3d-focus-point-val').textContent.match(/[\d.]+/),
        'a default centre is offered, so the button is never dead');
    const estimate = node.querySelector('.m3d-focus-estimate').textContent;
    assert(/tile/i.test(estimate), 'the estimate says how many tiles the disc is (' + estimate + ')');
    assert(/z\d/.test(estimate), 'and the zoom window it will take');
    assert(status.plan.route === 'url', 'the plan knows this layer is fetched by URL (not drawn by a canvas layer)');

    /* Already-prepared tiles are counted before promising anything. */
    assert(status.plan.prepared === status.plan.count && status.plan.pending === 0,
        'the tiles prepared in §4d are counted as already prepared (' + status.plan.prepared + '/' + status.plan.count + ')');

    /* Changing the distance re-plans. */
    const before = focus.status().plan.count;
    chips[0].click();
    const after = focus.status().plan.count;
    assert(focus.status().dialog.radiusKm === Number(chips[0].getAttribute('data-radius')),
        'a quick distance moves the slider and the dialog state');
    assert(after !== before, 'and re-plans the disc (' + before + ' → ' + after + ' tiles)');

    /* Picking: the card steps aside and the crosshair takes over. There is no
     * banner to ask for the tap — one used to sit over the card and swallow the
     * taps meant for its close button. */
    node.querySelector('.m3d-focus-pick').click();
    assert(focus.status().picking === true, 'the map is armed for a pick');
    assert(windowStub._dlLidarFocusPicking === true,
        'and the LiDAR Scanner is told to stand down (the tap belongs to the dialog)');
    assert(node.querySelector('.m3d-focus-card').hidden === true,
        'the card steps aside so the whole map is clickable');
    assert(doc.getElementById('detectlab-map').classList.contains('m3d-picking'),
        'and the map shows the crosshair that says what the next tap does');
    assert(node.querySelectorAll('.m3d-focus-hint').length === 0,
        'no banner is left over the card to intercept a tap');
    map._click(45.12, 24.34);
    assert(focus.status().picking === false, 'the tap ends the pick');
    assert(focus.status().dialog.point.lat === 45.12 && focus.status().dialog.pointPicked === true,
        'the tapped point is the new centre of the disc');
    assert(node.querySelector('.m3d-focus-card').hidden === false, 'and the card comes back');
    assert(/45\.12/.test(node.querySelector('.m3d-focus-point-val').textContent),
        'with the centre shown to the user before anything is downloaded');

    /* Escape during a pick must not leave a handler behind. */
    node.querySelector('.m3d-focus-pick').click();
    doc.dispatch('keydown', { key: 'Escape' });
    assert(focus.status().picking === false && windowStub._dlLidarFocusPicking === false,
        'Escape cancels the pick and releases the map');
    assert((map._handlers.click || []).length === 0, 'no picking handler is left on the map');

    /* Confirm: progress while it downloads, then the focus is applied. */
    const ready = focus.status().plan;
    fetched.length = 0;
    node.querySelector('.m3d-focus-go').click();
    assert(node.querySelector('.m3d-focus-progress').hidden === false,
        'the progress block takes over the dialog');
    assert(node.querySelector('.m3d-focus-go').hidden === true &&
           node.querySelector('.m3d-focus-cancel').hidden === true,
        'and the two buttons give way to it');
    const progressText = node.querySelector('.m3d-focus-progress-text').textContent;
    assert(progressText.length > 0, 'the progress line says what is happening (' + progressText + ')');
    assert(focus.status().dialog.preparing === true, 'the dialog is in its preparing state');

    /* The disc is drawn on the 2D map while the tiles are downloaded — the user
     * sees the exact area the progress bar is talking about. */
    const circle = drawn.filter(function (layer) { return layer._kind === 'circle'; }).pop();
    assert(circle && circle._radius === focus.status().dialog.radiusKm * 1000,
        'the disc is outlined on the 2D map, at the real ground radius (metres)');
    const centre = Array.isArray(circle._latlng) ? circle._latlng : [circle._latlng.lat, circle._latlng.lng];
    assert(centre[0] === 45.12 && centre[1] === 24.34, 'centred on the point the user tapped');
    assert(drawn.some(function (layer) { return layer._kind === 'circleMarker'; }),
        'with a dot at the centre');

    const result = await promise;
    assert(result && result.cancelled === false, 'the dialog resolves with the prepared focus');
    assert(result.focus && result.focus.key === '2d.R1', 'carrying the chosen layer and disc');
    assert(result.focus.preparedTiles === ready.count && result.focus.failedTiles === 0,
        'the focus remembers how many tiles it prepared and how many failed');
    assert(result.report && result.report.prepared === result.report.total && result.report.failed === 0,
        'and the report of exactly that (' + result.report.prepared + '/' + result.report.total + ')');
    assert(fetched.length === ready.count,
        'the confirmed disc was fetched once per tile (' + fetched.length + '/' + ready.count + ')');
    assert(viewer.status().lidar.primed.entries >= ready.count,
        'and every tile of it is kept in memory for the 3D view');
    assert(viewer.getLidarFocus() && viewer.getLidarFocus().key === result.focus.key,
        'the viewer is now focused on that layer and disc');
    assert(Math.abs(viewer.getLidarFocus().mask.radiusKm - result.focus.radiusKm) < 1e-9,
        'at the distance the user chose (' + result.focus.radiusKm + ' km)');
    assert(doc.body.classList.contains('m3d-focus-open') === false,
        'the body marker goes with the card once the disc is ready');
    /* …and the window itself does not vanish: fetched and on its way into
     * the 3D view, it folds into its pill (layer · radius · tiles ready,
     * expand arrow) so it stays reachable once 3D is up. */
    assert(node.hidden === false && node.classList.contains('is-minimized') &&
           node.querySelector('.m3d-focus-card').hidden === true &&
           node.querySelector('.m3d-focus-mini').hidden === false,
        'once the disc is ready the window minimizes into its pill instead of closing');
    assert(focus.status().dialog.minimized === true && focus.status().dialog.open === false,
        'status() reports the folded window');
    const miniText = node.querySelector('.m3d-focus-mini-text').textContent;
    assert(/km/.test(miniText) && /tile/i.test(miniText),
        'the pill stands for the disc that was just fetched (' + miniText + ')');
    assert(node.querySelector('.m3d-focus-mini-title').textContent.length > 0 &&
           node.querySelector('.m3d-focus-mini-arrow').textContent.trim().length > 0,
        'and it carries the window title plus an expand arrow');
    assert(node.querySelector('.m3d-focus-bar i').style.width === '100%', 'the progress bar finished at 100%');
    assert(/Gata|Done/.test(node.querySelector('.m3d-focus-progress-text').textContent),
        'and the last line says the disc is ready');

    /* ── the gate the 3D button really goes through ─────────────────────── */
    const alreadyDownloaded = fetched.length;
    viewer.setEntryGate(function () { return focus._gate(); });
    const openPromise = viewer.open();
    await tick();
    const again = doc.body.querySelector('#map3d-focus');
    assert(again.hidden === false, 'pressing 3D asks again, because a LiDAR layer is still on the 2D map');
    assert(again.classList.contains('is-minimized') === false &&
           again.querySelector('.m3d-focus-card').hidden === false &&
           again.querySelector('.m3d-focus-mini').hidden === true,
        'and the full card is back — asking again unfolds the pill');
    assert(again.querySelector('.m3d-focus-go').hidden === false && again.querySelector('.m3d-focus-go').disabled === false,
        'with both buttons back, and the go button live');
    again.querySelector('.m3d-focus-go').click();
    await openPromise;
    assert(fetched.length === alreadyDownloaded,
        'reopening 3D on the same disc downloads nothing — it is all in memory');
    assert(doc.body.classList.contains('is-3d') && viewer.status().failed === true,
        'confirming the dialog lets open() through to the 3D view (the sandbox then reports its missing WebGL)');
    assert(viewer.isOpen() === false,
        'and the failed open reads as closed, so a later tap retries instead of doing nothing');

    /* The expand arrow: with the tiles fetched and 3D entered, the folded
     * window reopens over the running view — and folds back on cancel. The
     * sandbox has no WebGL, so the “running view” is faked from here on at
     * the one seam the dialog consults — viewer.isOpen() — until the live
     * sections below are done. */
    const realIsOpen = viewer.isOpen;
    viewer.isOpen = function () { return true; };
    const pill = again.querySelector('.m3d-focus-mini');
    assert(pill && pill.hidden === false && again.classList.contains('is-minimized'),
        'the window auto-minimized when the 3D view was entered');
    assert(/tile/i.test(pill.textContent),
        'the pill names what was fetched (' + pill.textContent.trim().slice(0, 60) + '…)');
    pill.click();
    await tick();
    assert(again.querySelector('.m3d-focus-card').hidden === false &&
           again.classList.contains('is-minimized') === false &&
           focus.status().dialog.open === true,
        'tapping the expand arrow opens the full window again');
    assert(focus.status().dialog.mode === 'live',
        'expanded over a running 3D view, it prepares in live mode');
    again.querySelector('.m3d-focus-cancel').click();
    await tick();
    assert(again.hidden === false && again.classList.contains('is-minimized') &&
           again.querySelector('.m3d-focus-mini').hidden === false &&
           focus.status().dialog.minimized === true,
        'cancelling an expanded window folds it back into the pill instead of dismissing it');
    viewer.close();

    /* The bar's Change button while 3D is open is the “live” mode: the same
     * dialog, but the running view is re-pointed in place, and 3D is not
     * reopened (it was never closed). */
    viewer.setEntryGate(function () { return Promise.resolve(true); });
    await viewer.open();
    assert(viewer.isOpen() === true, '3D is open again (the faked seam above)');
    doc.dispatch('detectlab:map3d-lidar-change');
    await tick();
    const liveBar = doc.body.querySelector('#map3d-focus');
    assert(liveBar.hidden === false && focus.status().dialog.mode === 'live',
        'with 3D open the bar opens the dialog in live mode');
    liveBar.querySelector('.m3d-focus-go').click();
    /* live mode lets the “done” line be read before the dialog steps aside. */
    await wait(900);
    assert(viewer.isOpen() === true && viewer.getLidarFocus() !== null,
        'confirming it keeps 3D open and re-points the focus');
    assert(liveBar.hidden === false && liveBar.classList.contains('is-minimized') &&
           liveBar.querySelector('.m3d-focus-card').hidden === true &&
           liveBar.querySelector('.m3d-focus-mini').hidden === false,
        'and the window folds into its pill over the running 3D view');
    viewer.close();
    viewer.isOpen = realIsOpen;

    /* cancel is the other half of the contract: nothing opens. */
    viewer.setEntryGate(function () { return focus._gate(); });
    const cancelledPromise = viewer.open();
    await tick();
    const third = doc.body.querySelector('#map3d-focus');
    assert(third.hidden === false, 'the dialog opened again');
    third.querySelector('.m3d-focus-cancel').click();
    assert((await cancelledPromise) === false && viewer.isOpen() === false,
        'cancelling the dialog does not open 3D');

    /* ── the 3D bar's own two buttons ────────────────────────────────────── */
    viewer.close();
    doc.dispatch('detectlab:map3d-lidar-change');
    await tick();
    const live = doc.body.querySelector('#map3d-focus');
    assert(live.hidden === false, 'the bar’s “change the area” opens the same dialog');
    assert(focus.status().dialog.mode === 'gate',
        'and with 3D closed it prepares a new area rather than re-pointing a running view');
    const lastPrepare = focus.status().lastPrepare;
    assert(lastPrepare && lastPrepare.total > 0 && lastPrepare.failed === 0,
        'status().lastPrepare reports the last download honestly (' +
        (lastPrepare ? lastPrepare.prepared + '/' + lastPrepare.total + ' in ' + lastPrepare.ms + ' ms' : 'none') + ')');
    live.querySelector('.m3d-focus-go').click();
    await tick();
    await tick();
    assert(doc.body.classList.contains('is-3d') && viewer.status().failed === true,
        'confirming it opens 3D on the disc that was just prepared (openNow is reached; the sandbox then reports its missing WebGL)');
    viewer.close();

    doc.dispatch('detectlab:map3d-lidar-clear');
    await tick();
    assert(viewer.getLidarFocus() === null, 'the bar’s “remove” clears the focus');
    const stillDrawn = drawn.filter(function (layer) { return map.hasLayer(layer); });
    assert(stillDrawn.length === 0, 'and takes the 2D disc off the map');

    /* With no LiDAR layer on the 2D map, 3D opens exactly as it always did. */
    map.removeLayer(lidarGroup);
    assert(focus.activeLayers().length === 0, 'the 2D map now has no LiDAR layer');
    let asked = 0;
    viewer.setEntryGate(function () { asked += 1; return focus._gate(); });
    await viewer.open();
    assert(asked === 1 && doc.body.classList.contains('is-3d'),
        'the gate is asked once and lets 3D through (no dialog)');
    assert(doc.body.querySelector('#map3d-focus').hidden === true,
        'without a LiDAR layer on the 2D map there is nothing to prepare');
    viewer.close();
    map.addLayer(lidarGroup);
}

process.on('unhandledRejection', function (error) {
    console.error('unhandled rejection:', error);
    process.exit(1);
});
