// Regression suite for the globe-projected country outline.
// The selected-country outline must take its screen positions from the same
// MapLibre globe camera that draws the basemap, so it does not drift off the
// imagery when zoomed out or while the globe moves. The Leaflet behaviour used
// here (Polyline/Polygon projection, _clipPoints, renderer hooks) is mirrored
// from Leaflet 1.9.4; the real browser check lives in the harness.
// Run: node test-globe-outline-projection.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = __dirname;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js/globe-base-layer.js'), 'utf8');
const picker = fs.readFileSync(path.join(root, 'js/globe-country-picker.js'), 'utf8');

console.log('[Test] Globe-projected country outline...');

// ── Page wiring and release bookkeeping ───────────────────────────────────
const BASE_URL = 'js/globe-base-layer.js?v=20261010-shared-overlay';
const PICKER_URL = 'js/globe-country-picker.js?v=20261010-gate-imagery';
assert(html.includes(BASE_URL) && html.includes(PICKER_URL), 'index.html loads the re-versioned globe scripts');
assert(sw.includes("'" + BASE_URL + "'") && sw.includes("'" + PICKER_URL + "'"), 'sw.js precaches the re-versioned globe scripts');
const shellVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert(shellVersion >= 174, 'sw.js shell is v174 or newer (got v' + shellVersion + ')');
assert(/\/\/ v174:/.test(sw), 'sw.js documents the v174 outline release');

// ── Picker wiring: projected outline first, Leaflet placement as fallback ──
const projectedAt = picker.indexOf('projector.createProjectedFeature(entry.feature, globeOpts)');
const boxAt = picker.indexOf('projector.createProjectedPolygon([');
const geoJsonAt = picker.indexOf('window.L.geoJSON(entry.feature, styleOpts)');
const rectangleAt = picker.indexOf('window.L.rectangle([[bbox[1], bbox[0]], [bbox[3], bbox[2]]], styleOpts)');
assert(projectedAt > 0 && boxAt > projectedAt, 'picker tries the projected feature, then the projected bbox');
assert(geoJsonAt > boxAt && rectangleAt > geoJsonAt, 'Leaflet L.geoJSON and L.rectangle remain as fallbacks');
assert(/globe && globe\._map === map && typeof globe\.getMaplibreMap === 'function' && projector/.test(picker),
    'projection is used only when a real globe adapter is live on this map (not the raster fallback)');
assert(/window\._detectlabGlobeBaseLayer/.test(picker), 'picker reads the live globe layer published by map-app');
assert(/layer\._detectlabBoundsKind = kind;/.test(picker) && /kind = 'country outline'/.test(picker),
    'the status line can tell the projected outline from the bbox rectangle');

// ── Minimal Leaflet 1.9.4 shapes for the module under test ────────────────
function Point(x, y) { this.x = x; this.y = y; }
function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
function Bounds() { this.min = null; this.max = null; }
Bounds.prototype.extend = function (p) {
    if (!this.min) { this.min = new Point(p.x, p.y); this.max = new Point(p.x, p.y); return this; }
    this.min.x = Math.min(this.min.x, p.x); this.min.y = Math.min(this.min.y, p.y);
    this.max.x = Math.max(this.max.x, p.x); this.max.y = Math.max(this.max.y, p.y);
    return this;
};
Bounds.prototype.isValid = function () { return !!this.min; };
Bounds.prototype.intersects = function (other) {
    return !!(this.min && other && this.min.x <= other.max.x && this.max.x >= other.min.x &&
        this.min.y <= other.max.y && this.max.y >= other.min.y);
};

function toLatLng(p) {
    if (p instanceof LatLng) return p;
    if (Array.isArray(p)) return new LatLng(p[0], p[1]);
    return new LatLng(p.lat, p.lng);
}
function isFlat(list) {
    const first = list[0];
    return first instanceof LatLng || (Array.isArray(first) && typeof first[0] === 'number');
}
// Leaflet drops a ring's closing vertex when it repeats the first one.
function convertRings(list) {
    if (isFlat(list)) {
        const out = list.map(toLatLng);
        const a = out[0], b = out[out.length - 1];
        if (out.length >= 2 && a.lat === b.lat && a.lng === b.lng) out.pop();
        return out;
    }
    return list.map(convertRings);
}

function Polyline(latlngs, options) {
    this.options = Object.assign({ smoothFactor: 1, noClip: false }, options);
    this._latlngs = convertRings(latlngs);
    // Leaflet keeps lat/lng bounds from the conversion; _project checks them.
    this._bounds = { isValid: () => this._latlngs.length > 0 };
    this._rings = [];
    this._parts = [];
}
Polyline.prototype._projectLatlngs = function (latlngs, result, projectedBounds) {
    if (latlngs[0] instanceof LatLng) {
        const ring = [];
        for (let i = 0; i < latlngs.length; i++) {
            ring[i] = this._map.latLngToLayerPoint(latlngs[i]);
            projectedBounds.extend(ring[i]);
        }
        result.push(ring);
    } else {
        for (let i = 0; i < latlngs.length; i++) this._projectLatlngs(latlngs[i], result, projectedBounds);
    }
};
Polyline.prototype._project = function () {
    const pxBounds = new Bounds();
    this._rings = [];
    this._projectLatlngs(this._latlngs, this._rings, pxBounds);
    this._pxBounds = pxBounds.isValid() ? pxBounds : undefined;
};
Polyline.prototype._updateBounds = function () {
    // Leaflet pads the projected bounds by the click tolerance; padding is irrelevant here.
    if (this._rawPxBounds) this._pxBounds = this._rawPxBounds;
};
Polyline.prototype._clipPoints = function () {
    const bounds = this._renderer._bounds;
    this._parts = [];
    if (!this._pxBounds || !this._pxBounds.intersects(bounds)) return;
    if (this.options.noClip) { this._parts = this._rings; return; }
    this._parts = this._rings;
};
Polyline.prototype._update = function () {
    if (!this._map) return;
    this._clipPoints();
    this._renderer._updatePoly(this);
};
Polyline.prototype._reset = function () {
    this._project();
    this._update();
};

function extend(Parent, proto) {
    const defaults = Object.assign({}, Parent.defaults || {}, (proto && proto.options) || {});
    function Sub(latlngs, options) { Parent.call(this, latlngs, Object.assign({}, defaults, options)); }
    Sub.prototype = Object.create(Parent.prototype);
    Sub.prototype.constructor = Sub;
    Object.assign(Sub.prototype, proto || {});
    Sub.defaults = defaults;
    Sub.extend = function (p) { return extend(Sub, p); };
    return Sub;
}

const Polygon = extend(Polyline, {
    onAdd: function (map) { this._map = map; this._renderer = map._renderer; this._reset(); },
    onRemove: function () { this._map = null; }
});

function makeRenderer() {
    return {
        _bounds: { min: new Point(-1e6, -1e6), max: new Point(1e6, 1e6) },
        updates: 0,
        _updatePoly(layer) { this.updates += 1; this.lastParts = layer._parts; }
    };
}

// Loads js/globe-base-layer.js in a vm sandbox with the given fake Leaflet.
function loadBaseModule(fakeL) {
    const sandbox = { console, isFinite, Math, Object, Array, Number };
    sandbox.window = {
        L: fakeL,
        maplibregl: { Map: function Map() {}, supported() { return true; } }
    };
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'globe-base-layer.js' });
    return sandbox.window.DetectLabGlobeBase;
}

function makeFakeL(extra) {
    const L = Object.assign({
        LatLng,
        Bounds,
        latLng: (lat, lng) => new LatLng(lat, lng),
        point: (x, y) => new Point(x, y),
        DomUtil: { getPosition: (el) => el._leaflet_pos || new Point(0, 0) },
        Polygon,
        maplibreGL() { throw new Error('maplibreGL is not used in this case'); }
    }, extra || {});
    return L;
}

// A linear stand-in for MapLibre's project(): lng/lat degrees → CSS px.
// The real camera is validated in the browser harness, not here.
function makeGl(center) {
    return {
        center,
        project([lng, lat]) {
            return { x: (lng - this.center.lng) * 10 + 100, y: (this.center.lat - lat) * 10 + 50 };
        },
        getCenter() { return { lat: this.center.lat, lng: this.center.lng }; }
    };
}

function makeGlobe(gl, map, container) {
    return {
        _map: map,
        _zooming: false,
        _container: container || { _leaflet_pos: new Point(30, 40) },
        getMaplibreMap() { return gl; },
        getContainer() { return this._container; }
    };
}

// ── densify, antimeridian and GeoJSON conversion ─────────────────────────
const base = loadBaseModule(makeFakeL());
assert(base && base._test, 'DetectLabGlobeBase exposes its internal test hooks');
const T = base._test;

assert.equal(T.wrapLng(190), -170, 'wrapLng folds 190° to -170°');
assert.equal(T.wrapLng(-190), 170, 'wrapLng folds -190° to 170°');
assert.equal(T.wrapLng(180), -180, 'wrapLng keeps the antimeridian in [-180, 180)');
assert.equal(T.wrapLng(0), 0, 'wrapLng leaves in-range longitudes alone');

const unit = T.unitVector(0, 90);
assert(Math.abs(unit[0] - 1) < 1e-12 && Math.abs(unit[1]) < 1e-12 && Math.abs(unit[2]) < 1e-12,
    'unitVector puts (0°N, 90°E) on the +x axis');

const square = [new LatLng(0, 0), new LatLng(0, 10), new LatLng(10, 10), new LatLng(10, 0)];
const dense = T.densifyLatLngs(square);
assert.equal(dense[0][0], 0, 'densify starts at the first vertex (lat)');
assert.equal(dense[0][1], 0, 'densify starts at the first vertex (lng)');
assert(!(dense[dense.length - 1][0] === 0 && dense[dense.length - 1][1] === 0), 'densify does not repeat the closing vertex');
assert.equal(dense.length, 40, 'a 10°×10° square is sampled at 1° along each 10° edge');
for (let i = 0; i < dense.length; i++) {
    const next = dense[(i + 1) % dense.length];
    const step = Math.max(Math.abs(next[0] - dense[i][0]), Math.abs(T.wrapLng(next[1] - dense[i][1])));
    assert(step <= 1 + 1e-9, 'densify leaves no edge longer than 1° (step ' + step + ')');
}
assert(dense.some((p) => p[0] === 5 && p[1] === 10), 'densify keeps the midpoint of the long edge on the sphere path');

// An edge across the antimeridian (170°E → 170°W) stays continuous in longitude.
const dateline = [new LatLng(0, 170), new LatLng(0, -170), new LatLng(10, -170), new LatLng(10, 170)];
const wrapped = T.densifyLatLngs(dateline);
for (let i = 0; i < wrapped.length; i++) {
    const next = wrapped[(i + 1) % wrapped.length];
    assert(Math.abs(next[1] - wrapped[i][1]) <= 1 + 1e-9, 'antimeridian ring is unwrapped without a jump (i=' + i + ')');
}
assert(wrapped.some((p) => p[1] > 180), 'the unwrapped ring runs past 180° instead of folding back');

// Simplification: collapses straight runs, keeps real corners, and every
// dropped vertex stays within the tolerance of the simplified outline.
const square2 = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3], [3, 3], [3, 0], [2, 0], [1, 0]];
const squareSimple = T.simplifyRing(square2, 0.05);
assert.equal(squareSimple.length, 4, 'collinear points on each edge are dropped');
assert.equal(JSON.stringify(squareSimple.map((p) => p.join(',')).sort()), JSON.stringify(['0,0', '0,3', '3,0', '3,3']), 'the corners survive');
assert.equal(T.simplifyRing(square2, 0).length, square2.length, 'zero tolerance keeps every vertex');

const bump = [[0, 0], [0, 1], [0.04, 2], [0, 3], [3, 3], [3, 0]];
assert.equal(T.simplifyRing(bump, 0.1).length, 4, 'a bump below the tolerance is dropped');
assert.equal(T.simplifyRing(bump, 0.01).length, 6, 'a bump above the tolerance is kept');

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const jagged = [];
for (let i = 0; i < 300; i++) {
    const a = (i / 300) * 2 * Math.PI;
    const r = 10 + (rand() - 0.5) * 0.4;
    jagged.push([r * Math.sin(a), r * Math.cos(a)]);
}
const tol = 0.05;
const kept = T.simplifyRing(jagged, tol);
assert(kept.length < jagged.length && kept.length > 10, 'a jagged ring is reduced but keeps its shape (' + kept.length + ' points)');
const segDist = (p, a, b) => {
    const dx = b[1] - a[1], dy = b[0] - a[0], len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[0] - a[0]) * dy) / len2)) : 0;
    return Math.hypot(p[1] - (a[1] + t * dx), p[0] - (a[0] + t * dy));
};
let worst = 0;
for (const p of jagged) {
    let best = Infinity;
    for (let i = 0; i < kept.length; i++) best = Math.min(best, segDist(p, kept[i], kept[(i + 1) % kept.length]));
    worst = Math.max(worst, best);
}
assert(worst <= tol + 1e-9, 'every dropped vertex is within the tolerance (worst ' + worst.toFixed(4) + ')');

const bandTol = T.simplifyTolerance(3);
assert(Math.abs(bandTol * 256 * Math.pow(2, 4) / 360 - 0.25) < 1e-12,
    'the zoom-band tolerance is 0.25 px at the top of the band');
assert(T.simplifyTolerance(5) < T.simplifyTolerance(3), 'tolerance shrinks as the globe zooms in');

const polygonGeometry = {
    type: 'Polygon',
    coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]
    ]
};
const rings = T.geoJsonToLatLngs(polygonGeometry);
assert.equal(rings.length, 2, 'a GeoJSON Polygon keeps its hole as a second ring');
assert(rings[0][1] instanceof LatLng && rings[0][1].lat === 0 && rings[0][1].lng === 10,
    'GeoJSON [lng, lat] pairs become Leaflet LatLng(lat, lng)');
assert.equal(rings[0].length, 5, 'the GeoJSON closing vertex is passed on for Leaflet to drop');
assert.deepEqual([rings[0][4].lat, rings[0][4].lng], [rings[0][0].lat, rings[0][0].lng], 'and it repeats the first vertex, as GeoJSON requires');

const multi = T.geoJsonToLatLngs({ type: 'MultiPolygon', coordinates: [polygonGeometry.coordinates, [[[20, 0], [21, 0], [21, 1], [20, 0]]]] });
assert.equal(multi.length, 2, 'a MultiPolygon keeps each polygon separate');
assert.equal(multi[0].length, 2, 'a MultiPolygon polygon keeps its hole');
assert.equal(T.geoJsonToLatLngs({ type: 'LineString', coordinates: [[0, 0], [1, 1]] }), null, 'non-area geometry is rejected');

// ── Fallbacks: no live globe means Leaflet placement, never a broken layer ──
assert.equal(base.createProjectedPolygon(square.map((p) => [p.lat, p.lng]), {}), null,
    'no globeLayer option → no projected polygon (the caller keeps Leaflet placement)');
assert.equal(base.createProjectedFeature({ geometry: polygonGeometry }, {}), null,
    'a feature without a globe is not projected');
assert.equal(base.createProjectedFeature({ geometry: { type: 'Point', coordinates: [0, 0] } }, { globeLayer: {} }), null,
    'a non-area feature is not projected');

// ── Projection with a live globe camera ──────────────────────────────────
const renderer = makeRenderer();
const map = {
    _renderer: renderer,
    getZoom() { return 3; },
    on() {}, off() {},
    latLngToLayerPoint(ll) { return new Point(ll.lng * 2, ll.lat * 2); }
};
const gl = makeGl({ lat: 2, lng: 2 });
const globe = makeGlobe(gl, map);

const block = [[1, 1], [1, 3], [3, 3], [3, 1]];
const projected = base.createProjectedPolygon(block, { globeLayer: globe, pane: 'pane_country_bounds' });
assert(projected, 'a projected polygon is created when the globe is live');
assert.equal(projected.options.noClip, true, 'projected outlines are not clipped by Leaflet');
assert.equal(projected.options.smoothFactor, 0, 'projected outlines keep every vertex');
assert.equal(projected.options.pane, 'pane_country_bounds', 'caller options (pane, interactive) survive');
projected.onAdd(map);
assert.equal(renderer.updates, 1, 'adding the outline pushes one path update');

// The square's corners sit on the globe camera: (1,1) → (90,60) + origin (30,40).
const cornerA = projected._rings[0].find((p) => p.x === 120 && p.y === 100);
const cornerB = projected._rings[0].find((p) => p.x === 120 + 20 && p.y === 100);
assert(cornerB, 'corner (1°N, 3°E) is kept by simplification');
assert(cornerA, 'corner (1°N, 1°E) is placed by the globe camera, not by Leaflet');
const ringCount = projected._rings[0].length;
assert.equal(ringCount, 4, 'straight sampled edges simplify away: the 2°×2° square keeps its four corners');
assert(projected._rings[0].every((p, i, all) => {
    const q = all[(i + 1) % all.length];
    return Math.hypot(q.x - p.x, q.y - p.y) > 0;
}), 'no zero-length segments in the simplified outline');

// The same vertices must follow the camera when it moves.
gl.center = { lat: 2.5, lng: 2 };
projected._update();
const shifted = projected._rings[0].find((p) => Math.abs(p.x - 120) < 1e-9 && Math.abs(p.y - 105) < 1e-9);
assert(shifted, 'a camera move of 0.5° of latitude moves the outline by 5 px (re-projected, not cached)');

// Leaflet's own hooks: viewreset → _reset, moveend → _update, and both re-project.
projected._reset();
assert(renderer.updates >= 3, 'viewreset and moveend paths re-project the outline');

// Pans and resizes re-project; a zoom animation waits for the adapter's zoomend.
const before = projected._rings[0];
globe._zooming = true;
gl.center = { lat: 9, lng: 9 };
projected._onGlobeMove();
assert.equal(projected._rings[0], before, 'no re-projection while the adapter is mid zoom animation');
globe._zooming = false;
projected._onGlobeMove();
assert.notEqual(projected._rings[0], before, 'a pan after the zoom re-projects with the new camera');

// Sampled rings are cached per integer zoom band and reused between updates.
const cachedBefore = projected._globeSamples && projected._globeSamples[3];
projected._update();
assert.equal(projected._globeSamples[3], cachedBefore, 'updates at the same zoom reuse the sampled rings');
assert(projected._globeSamples[3] !== undefined && Object.keys(projected._globeSamples).length === 1, 'one zoom band is cached');

// Far-side vertices are left out instead of folding back over the visible disc.
const farGl = makeGl({ lat: 0, lng: 0 });
const farGlobe = makeGlobe(farGl, map);
const farRing = [[0, 170], [0, 175], [5, 175], [5, 170]];
const far = base.createProjectedPolygon(farRing, { globeLayer: farGlobe });
far.onAdd(map);
assert.equal(far._rings.length, 0, 'a ring entirely on the far side produces no path points');
assert.equal(far._parts.length, 0, 'and so draws nothing');

// If the globe is not on this map, the outline keeps Leaflet's own placement.
const otherMap = { _renderer: renderer, getZoom() { return 3; }, on() {}, off() {}, latLngToLayerPoint(ll) { return new Point(ll.lng * 2, ll.lat * 2); } };
const stale = base.createProjectedPolygon(block, { globeLayer: makeGlobe(gl, { other: true }) });
stale.onAdd(otherMap);
assert.deepEqual(stale._rings[0][0], new Point(2, 2), 'a globe on another map falls back to Leaflet placement');

// ── Adapter sync: every move drives the globe camera ──────────────────────
let adapterCalls = 0;
function FakeAdapter() {
    this._zooming = false;
    this._map = null;
}
FakeAdapter.prototype.getEvents = function () {
    return { move: this._throttledUpdate, zoomend: this._zoomEnd, resize: this._resize };
};
FakeAdapter.prototype._update = function () { adapterCalls += 1; };
FakeAdapter.prototype._throttledUpdate = function () { throw new Error('throttled path must not be used'); };
FakeAdapter.prototype._zoomEnd = function () {};
FakeAdapter.prototype._resize = function () {};
FakeAdapter.prototype.addTo = function (leafletMap) { this._map = leafletMap; leafletMap.layers.push(this); return this; };
FakeAdapter.prototype.getMaplibreMap = function () { return { getStyle() { return {}; }, setPaintProperty() {}, isStyleLoaded() { return true; }, once() {}, on() {} }; };

const adapterFakeL = makeFakeL({
    maplibreGL() {
        return new FakeAdapter();
    }
});
const adapterBase = loadBaseModule(adapterFakeL);
const fakeLeafletMap = { layers: [], addLayer(layer) { this.layers.push(layer); return this; } };
const adapter = adapterBase.create(fakeLeafletMap, {});
assert(adapter, 'the globe layer is created');
const events = adapter.getEvents.call(adapter);
assert.equal(events.move, adapter._update, 'move drives the camera synchronously, not through the 32 ms throttle');
assert.equal(events.zoomend, adapter._zoomEnd, 'the adapter keeps its other handlers (zoomend)');
assert.equal(events.resize, adapter._resize, 'the adapter keeps its resize handler');
events.move.call(adapter);
assert.equal(adapterCalls, 1, 'a move event reaches the adapter update once');

console.log('  ✓ densify, antimeridian, GeoJSON holes, fallbacks, projection and adapter sync verified');
console.log('All globe outline projection tests passed.');
