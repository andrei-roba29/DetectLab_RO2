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

const TAG = '20261014-lidar-3d-focus';
/* The viewer and its skin moved on without the terrain toggle (v213). */
const TAG_VIEWER = '20261015-3d-no-terrain-toggle';

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
    const mirrorTag = indexHtml.indexOf('js/map3d-mirror.js?v=' + TAG);
    const focusTag = indexHtml.indexOf('js/lidar-3d-focus.js?v=' + TAG);
    assert(viewerTag !== -1 && mirrorTag !== -1, 'index.html loads the tagged mirror and viewer');
    assert(focusTag !== -1, 'index.html loads the LiDAR focus module');
    assert(focusTag > viewerTag, 'the focus module loads after the viewer it installs its gate on');
    assert(indexHtml.includes('css/map3d-terrain.css?v=' + TAG_VIEWER), 'index.html loads the tagged 3D skin');

    assert(/#map3d-focus \{[\s\S]*?z-index: 1400/.test(skin),
        'the dialog sits above the layer panel and the search bar (it decides what 3D may load)');
    ['#map3d-focus .m3d-focus-card', '#map3d-focus .m3d-focus-layers', '#map3d-focus .m3d-focus-radius',
     '#map3d-focus .m3d-focus-chips', '#map3d-focus .m3d-focus-point-block', '#map3d-focus .m3d-focus-actions',
     '#map3d-focus .m3d-focus-progress', '#map3d-focus .m3d-focus-hint', '#map3d-bar .m3d-lidar',
     '#detectlab-map.m3d-picking'].forEach(function (selector) {
        assert(skin.indexOf(selector) !== -1, 'the skin styles ' + selector);
    });

    assert(swJs.includes("'js/lidar-3d-focus.js?v=" + TAG + "'") && swJs.includes("'js/lidar-3d-focus.js'"),
        'the service worker pre-caches the focus module (a cold PWA keeps the feature)');
    ['js/map3d-terrain.js?v=' + TAG_VIEWER, 'js/map3d-mirror.js?v=' + TAG, 'js/map-app.js?v=' + TAG,
     'css/map3d-terrain.css?v=' + TAG_VIEWER].forEach(function (asset) {
        assert(swJs.includes("'" + asset + "'"), 'sw.js pre-caches ' + asset);
    });
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
        assert(viewer.isOpen() === true && doc.body.classList.contains('is-3d'),
            'a gate that allows it lets open() reach the 3D surface');
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

    /* Picking: the card steps aside, the hint asks for the tap. */
    node.querySelector('.m3d-focus-pick').click();
    assert(focus.status().picking === true, 'the map is armed for a pick');
    assert(windowStub._dlLidarFocusPicking === true,
        'and the LiDAR Scanner is told to stand down (the tap belongs to the dialog)');
    assert(node.querySelector('.m3d-focus-card').hidden === true &&
           node.querySelector('.m3d-focus-hint').hidden === false,
        'the card steps aside so the whole map is clickable, with the hint on screen');
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
    assert(node.hidden === true && doc.body.classList.contains('m3d-focus-open') === false,
        'the dialog closes itself once the disc is ready');
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
    assert(again.querySelector('.m3d-focus-go').hidden === false && again.querySelector('.m3d-focus-go').disabled === false,
        'with both buttons back, and the go button live');
    again.querySelector('.m3d-focus-go').click();
    await openPromise;
    assert(fetched.length === alreadyDownloaded,
        'reopening 3D on the same disc downloads nothing — it is all in memory');
    assert(viewer.isOpen() === true && doc.body.classList.contains('is-3d'),
        'confirming the dialog lets open() through to the 3D view');
    viewer.close();

    /* The bar's Change button while 3D is open is the “live” mode: the same
     * dialog, but the running view is re-pointed in place, and 3D is not
     * reopened (it was never closed). */
    viewer.setEntryGate(function () { return Promise.resolve(true); });
    await viewer.open();
    assert(viewer.isOpen() === true, '3D is open again');
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
    assert(liveBar.hidden === true, 'and the dialog steps out of the way');
    viewer.close();

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
    assert(viewer.isOpen() === true, 'confirming it opens 3D on the disc that was just prepared');
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
    assert(asked === 1 && viewer.isOpen() === true,
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
