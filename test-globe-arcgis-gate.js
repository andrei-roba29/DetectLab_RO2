// ArcGIS SceneView country-gate regression tests.
// Verifies lazy SDK loading, flat globe configuration, geometry/style conversion,
// single-country selection wiring, the existing canvas fallback, and PWA assets.
// Usage: node test-globe-arcgis-gate.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html');
const sw = read('sw.js');
const picker = read('js/globe-country-picker.js');
const adapter = read('js/globe-arcgis-gate.js');
const css = read('css/globe-country-picker.css');
const translations = read('js/translations.js');

console.log('[Test] Lazy ArcGIS country gate...');

// Page and service-worker wiring: adapter before the public gate, no eager CDN.
const adapterUrl = 'js/globe-arcgis-gate.js?v=20261012-gate-layout';
const pickerUrl = 'js/globe-country-picker.js?v=20261011-arcgis-gate';
const cssUrl = 'css/globe-country-picker.css?v=20261012-gate-layout';
const translationsUrl = 'js/translations.js?v=20261011-arcgis-gate';
for (const asset of [adapterUrl, pickerUrl, cssUrl, translationsUrl]) {
    assert(html.includes(asset), 'index.html references ' + asset);
    assert(sw.includes("'" + asset + "'"), 'sw.js precaches ' + asset);
}
assert(html.indexOf(adapterUrl) < html.indexOf(pickerUrl), 'local ArcGIS adapter loads before the gate API');
assert(html.indexOf(pickerUrl) < html.indexOf('js/country-dock.js?v=20261010-hillshade-globe'), 'public gate API loads before the country dock');
assert(!/https:\/\/js\.arcgis\.com/.test(html), 'the ArcGIS SDK is not eagerly included in index.html');
assert(adapter.includes("var SDK_ROOT = 'https://js.arcgis.com/4.31/'"), 'the adapter pins ArcGIS SDK 4.31');
assert(adapter.includes("var SDK_CSS = SDK_ROOT + 'esri/themes/dark/main.css'"), 'the ArcGIS theme is dynamically loaded');
assert(adapter.includes('script.src = SDK_ROOT') && adapter.includes('loadTheme().then'), 'SDK and CSS are created only from the lazy open path');
assert(!sw.includes("'https://js.arcgis.com/4.31/"), 'the external SDK is not precached');
assert(/const CACHE_NAME = 'detectlab-v(18[5-9]|19\d|[2-9]\d\d)-/.test(sw), 'the app-shell cache is bumped past v184 for the gate layout fix');
for (const host of ['js.arcgis.com', 'arcgis.com', 'ibasemaps-api.arcgis.com']) {
    assert(sw.includes("'" + host + "'"), 'service-worker passthrough list includes ' + host);
}
assert(html.includes('id="globeGateArcGIS"') && html.includes('id="globeGateCountryList"'), 'ArcGIS surface and country list markup exist');
assert(html.includes('id="globeGateCountrySearch"') && html.includes('globeGateSelectBtn') && picker.includes("checkbox.type = 'checkbox'"), 'gate exposes search, one-country checks, and a continue action');
for (const key of ['globe_gate_search', 'globe_gate_country_count', 'globe_gate_selection_hint', 'globe_gate_continue']) {
    assert((translations.split(key).length - 1) >= 2, key + ' is translated in English and Romanian');
}
console.log('  ✓ lazy SDK/CSS, cache, markup, and EN/RO release wiring');

// Scene configuration and fallback wiring are explicit and do not touch map-app.
for (const token of [
    "viewingMode: 'global'", 'center: [14, 40]', "ground: { layers: [] }",
    'starsEnabled: false', 'atmosphereEnabled: false', "type: 'virtual'",
    'directShadowsEnabled: false', 'ambientOcclusionEnabled: false',
    'KEYED_WORLD_IMAGERY_SERVICE', 'WORLD_IMAGERY_SERVICE',
    "transparentOutline([255, 255, 255, 0.65], 1.35)",
    'makeLayer(modules, \'detectlab-country-casing\')'
]) assert(adapter.includes(token), 'SceneView configuration contains ' + token);
assert(adapter.includes('new modules.GraphicsLayer'), 'outlines use explicit ArcGIS GraphicsLayers');
assert(adapter.includes('orientRing(ring, index === 0)'), 'GeoJSON ring orientation is normalized for ArcGIS');
assert(picker.includes('function setPendingCountry(iso)') && picker.includes('if (iso && !NAMES[iso]) iso = null'), 'gate staging rejects multi/unknown-country values');
assert(picker.includes('DetectLabArcGISGate.goToCountry(iso)') && picker.includes('finishSelection(iso, name, bbox)'), 'one staged country zooms before existing hand-off');
assert(picker.includes('activateCanvasFallback(error)') && picker.includes('buildCanvas()') && picker.includes('startImagery()'), 'SceneView failures fall back to the existing canvas renderer');
assert(picker.includes('normalizeName(text).indexOf(query)') && picker.includes('[item.iso, item.name, item.en, item.ro]'), 'country search is accent-normalized and checks both EN/RO names plus ISO');
assert(css.includes('.globe-gate.is-arcgis .globe-gate-canvas') && css.includes('.globe-gate.is-canvas .globe-gate-arcgis'), 'ArcGIS and canvas surfaces can be switched independently');

// v185 regression: #globeGateArcGIS is the SceneView's own container, so the
// SDK's `.esri-view` rule (display: flex) must not be overridden — `display:
// block` there collapsed the view root to 0 px and the gate opened black with
// nothing but the country list. The adapter also refuses to hand back a globe
// without a drawable surface.
assert(html.includes('id="globeGateArcGIS"'), 'the ArcGIS container is the one the SceneView is created in');
assert(/\.globe-gate\.is-arcgis \.globe-gate-arcgis\s*\{\s*display:\s*flex;/.test(css),
    'the ArcGIS host keeps the SDK layout (display: flex) when the gate is in ArcGIS mode');
assert(!/\.globe-gate\.is-arcgis \.globe-gate-arcgis\s*\{\s*display:\s*block/.test(css),
    'the ArcGIS host is never collapsed back to display: block');
assert(/\.globe-gate-arcgis \.esri-view-root\s*\{[^}]*flex:\s*100%/.test(css),
    'the gate CSS restates the SDK view-root sizing (flex: 100%)');
assert(adapter.includes('function ensureDrawableSurface') && adapter.includes('surfaceCoversHost'),
    'the adapter measures the drawable view surface');
assert(adapter.includes("instance.container.style.display = 'flex'") && adapter.includes('view.resize()'),
    'a collapsed view container is repaired with the documented flex layout before giving up');
assert(adapter.includes("ensureDrawableSurface(instance, 'ArcGIS SceneView surface has no size inside the gate')"),
    'a SceneView without a sized surface rejects, so the canvas globe is opened instead of a black gate');
assert(/\.globe-gate\.is-canvas \.globe-gate-arcgis \{\s*display: none !important;/.test(css),
    'the canvas fallback always hides the ArcGIS host, even after an inline layout repair');
console.log('  ✓ flat globe, country styling, single-selection flow, and canvas failover');

// Ring winding, multi-polygon flattening, micro-state classification, and zoom.
const geoSandbox = { console, Promise, Math, setTimeout, clearTimeout };
geoSandbox.window = geoSandbox;
geoSandbox.document = {};
vm.createContext(geoSandbox);
vm.runInContext(adapter, geoSandbox);
const geo = geoSandbox.DetectLabArcGISGate._test;
const ccw = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const clockwiseExterior = geo.orientRing(ccw, true);
const counterClockwiseHole = geo.orientRing(ccw, false);
assert(geo.signedArea(clockwiseExterior) < 0, 'exterior rings are clockwise');
assert(geo.signedArea(counterClockwiseHole) > 0, 'holes are counter-clockwise');
assert.equal(geo.geometryRings({ geometry: { type: 'MultiPolygon', coordinates: [[ccw], [ccw]] } }).length, 2,
    'a MultiPolygon is converted to one ArcGIS rings collection');
assert(geo.isMicroState({ iso: 'MC', size: 1 }), 'known micro-state ISO codes are recognized');
assert(geo.isMicroState({ iso: 'XX', size: 0.2 }), 'tiny geometry can use the micro-state marker path');
assert(geo.zoomFor({ bboxEU: [13.4, 41.8, 13.6, 42.0] }) > geo.zoomFor({ bboxEU: [-10, 35, 30, 70] }),
    'smaller countries get a closer scene camera');
console.log('  ✓ geometry conversion and camera-fit calculations');

// Runtime smoke test with a tiny mocked ArcGIS AMD runtime. It proves the SDK
// script is not created at module load, then checks the actual view/layer config.
function GraphicsLayer(options) {
    Object.assign(this, options);
    this.graphics = [];
}
GraphicsLayer.prototype.add = function (graphic) { this.graphics.push(graphic); };
GraphicsLayer.prototype.removeAll = function () { this.graphics.length = 0; };
function TileLayer(options) { this.options = options; }
TileLayer.prototype.when = function () { return Promise.resolve(this); };
function Basemap(options) { Object.assign(this, options); }
function Map(options) { Object.assign(this, options); }
function Graphic(options) { Object.assign(this, options); }
function Polygon(options) { Object.assign(this, options); }
function Point(options) { Object.assign(this, options); }
function SceneView(options) {
    this.options = options;
    this.zoom = options.zoom;
    this.center = { longitude: options.center[0], latitude: options.center[1] };
    this.handlers = {};
    this.goTos = [];
    this.hitIso = null;
}
SceneView.prototype.when = function () { return Promise.resolve(this); };
SceneView.prototype.on = function (event, callback) {
    this.handlers[event] = callback;
    return { remove() {} };
};
SceneView.prototype.hitTest = function () {
    const hit = this.hitIso;
    return Promise.resolve({ results: hit ? [{ graphic: { attributes: { detectlabCountryISO: hit } } }] : [] });
};
SceneView.prototype.toScreen = function () { return { x: 10, y: 10 }; };
SceneView.prototype.goTo = function (target) {
    this.goTos.push(target);
    if (target.zoom !== undefined) this.zoom = target.zoom;
    if (Array.isArray(target.center)) this.center = { longitude: target.center[0], latitude: target.center[1] };
    return Promise.resolve();
};
SceneView.prototype.resize = function () { this.resizes = (this.resizes || 0) + 1; };
SceneView.prototype.destroy = function () {};
const fakeModules = [
    { apiKey: null }, Map, Basemap, SceneView, TileLayer, GraphicsLayer, Graphic, Polygon, Point
];
const elementsById = {};
const appended = [];
const dom = {
    head: { appendChild(node) {
        appended.push(node);
        if (node.id) elementsById[node.id] = node;
        if (node.tagName === 'LINK') {
            queueMicrotask(function () { node.sheet = {}; if (node.onload) node.onload(); });
        } else if (node.tagName === 'SCRIPT') {
            queueMicrotask(function () {
                runtime.require = function (_deps, success) { success.apply(null, fakeModules); };
                if (node.onload) node.onload();
            });
        }
    } },
    documentElement: { appendChild(node) { dom.head.appendChild(node); } },
    getElementById(id) { return elementsById[id] || null; },
    createElement(tag) { return { tagName: tag.toUpperCase(), style: {}, setAttribute() {}, addEventListener() {}, removeEventListener() {} }; }
};
const runtime = {
    console, Promise, Math, URL, setTimeout, clearTimeout,
    document: dom,
    setTimeout, clearTimeout,
    requestAnimationFrame(callback) { return setTimeout(callback, 0); },
    cancelAnimationFrame(id) { clearTimeout(id); }
};
runtime.window = runtime;
vm.createContext(runtime);
vm.runInContext(adapter, runtime);
const api = runtime.DetectLabArcGISGate;
assert.equal(appended.length, 0, 'no ArcGIS assets are requested before open()');
const container = {
    style: {},
    addEventListener() {},
    removeEventListener() {}
};
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const countries = [
    { iso: 'DE', name: 'Germany', lng: 10, lat: 51, size: 9,
      bboxEU: [5, 47, 15, 55],
      feature: { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[square(5, 47, 15, 55)]] } } },
    { iso: 'MC', name: 'Monaco', lng: 7.42, lat: 43.73, size: 0.08,
      bboxEU: [7.4, 43.7, 7.44, 43.76],
      feature: { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[square(7.4, 43.7, 7.44, 43.76)]] } } }
];
(async function runRuntimeChecks() {
    await api.open(container, countries, { selectedIso: null, nameOf: iso => iso, onSelect() {} });
    assert.equal(appended.filter(node => node.tagName === 'SCRIPT').length, 1, 'opening the gate loads the SDK script dynamically');
    const instance = api._test.getCurrent();
    assert(instance && api.isActive(), 'SceneView is live after open()');
    const opts = instance.view.options;
    assert.equal(opts.viewingMode, 'global');
    assert.deepEqual(Array.from(opts.center), [14, 40]);
    assert.equal(opts.environment.starsEnabled, false);
    assert.equal(opts.environment.atmosphereEnabled, false);
    assert.equal(opts.environment.lighting.type, 'virtual');
    assert.equal(opts.environment.lighting.directShadowsEnabled, false);
    assert.equal(opts.map.ground.layers.length, 0, 'flat ground disables elevation layers');
    assert.equal(instance.imagery.options.url, api.constants.imageryService, 'no unapproved key uses the existing legacy imagery service');
    assert.equal(instance.layers.countries.graphics.length, 2, 'the two supplied country polygons reach their country layer');
    assert.equal(instance.layers.micro.graphics.length, 1, 'a micro-state gets a screen-space marker');
    assert.equal(instance.layers.casing.graphics.length, 2, 'base casing is kept in its own GraphicsLayer');

    api.setSelected('DE');
    const selectedFill = instance.layers.focus.graphics[0].symbol;
    assert.deepEqual(Array.from(selectedFill.color), [57, 255, 20, 0.5]);
    assert.equal(selectedFill.outline.width, 1.8);
    assert.equal(instance.layers.focusCasing.graphics[0].symbol.outline.width, 3.75);
    assert.equal(instance.layers.labels.graphics[0].symbol.font.size, 9);

    let hitIso = null;
    instance.hooks.onSelect = iso => { hitIso = iso; };
    instance.view.hitIso = 'DE';
    instance.view.handlers.click({ x: 10, y: 10 });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(hitIso, 'DE', 'SceneView hit-testing resolves the country ISO for the existing picker callback');

    await api.goToCountry('DE');
    assert.deepEqual(Array.from(instance.view.goTos.at(-1).center), [10, 51], 'selection camera centers on the European hand-off bbox');
    const countBeforeZoom = instance.view.goTos.length;
    await api.zoomBy(0.5);
    assert.equal(instance.view.goTos.length, countBeforeZoom + 1, 'custom zoom buttons are routed to SceneView');
    api.close();
    assert.equal(api.isActive(), false, 'close() destroys the temporary SceneView');

    // An approved key is consumed only at runtime; none is stored in this test.
    runtime.DETECTLAB_ARCGIS_API_KEY = 'referrer-restricted-test-key';
    await api.open(container, countries, {});
    const keyed = api._test.getCurrent();
    assert.equal(keyed.modules.esriConfig.apiKey, 'referrer-restricted-test-key');
    assert.equal(keyed.imagery.options.url, api.constants.keyedImageryService);
    api.close();

    // v185: a SceneView that reports "ready" but never gets a drawable surface
    // must never be handed to the gate — that was the black screen with only
    // the country list visible.
    const box = (width, height) => ({ width, height, top: 0, left: 0, right: width, bottom: height });
    const layoutContainer = (hostSize, surfaceSize, heal) => {
        const state = { display: '', surface: box(surfaceSize.width, surfaceSize.height) };
        const surface = { getBoundingClientRect: () => ({ ...state.surface }) };
        const element = {
            style: {}, addEventListener() {}, removeEventListener() {}, layoutRepairs: 0,
            getBoundingClientRect: () => ({ ...box(hostSize.width, hostSize.height) }),
            querySelector: selector => (selector === '.esri-view-surface' ? surface : null)
        };
        // A real browser re-lays the view out as soon as the container is a flex
        // box again; `heal` emulates that for the successful-repair case.
        Object.defineProperty(element.style, 'display', {
            get() { return state.display; },
            set(value) {
                state.display = value;
                if (value !== 'flex') return;
                element.layoutRepairs++;
                if (heal) state.surface = box(hostSize.width, hostSize.height);
            }
        });
        return element;
    };
    assert.equal(api._test.surfaceCoversHost({
        container: layoutContainer({ width: 900, height: 600 }, { width: 900, height: 600 })
    }), true, 'a full-size view surface is accepted');
    assert.equal(api._test.surfaceCoversHost({
        container: layoutContainer({ width: 900, height: 600 }, { width: 300, height: 150 })
    }), false, 'a collapsed 0-height view surface is detected');
    const hidden = layoutContainer({ width: 0, height: 0 }, { width: 300, height: 150 });
    assert.equal(api._test.surfaceCoversHost({ container: hidden }), null,
        'an unmeasurable (hidden) host is not reported as broken');
    assert.equal(await api._test.ensureDrawableSurface({ container: hidden, view: {} }, 'unused'), true,
        'a hidden host never triggers the layout repair or the fallback');
    assert.equal(hidden.layoutRepairs, 0, 'an unmeasurable host is left alone');

    const collapsed = layoutContainer({ width: 1050, height: 558 }, { width: 300, height: 150 });
    let refused = false;
    try {
        await api.open(collapsed, countries, {});
    } catch (error) {
        refused = /no size inside the gate/.test(error.message);
    }
    assert(refused, 'an unsized SceneView rejects, so the picker opens the canvas globe instead of a black gate');
    assert.equal(collapsed.layoutRepairs, 1, 'the documented flex layout is restored once before giving up');
    assert.equal(collapsed.style.display, '', 'the failed attempt leaves no inline layout behind');
    assert.equal(api.isActive(), false, 'the unusable SceneView is destroyed while the gate falls back');

    const healable = layoutContainer({ width: 1050, height: 558 }, { width: 300, height: 150 }, true);
    await api.open(healable, countries, {});
    assert.equal(healable.layoutRepairs, 1, 'a collapsed gate container is repaired in place');
    assert.equal(healable.style.display, 'flex', 'the repair keeps the SDK flex layout while the globe is open');
    assert.equal(api._test.getCurrent().view.resizes, 1, 'the repaired view is resized once');
    assert(api.isActive(), 'a repaired SceneView stays the gate renderer');
    api.close();
    assert.equal(healable.style.display, '', 'close() clears the inline layout repair');
    console.log('  ✓ lazy mocked AMD load, SceneView setup, drawable-surface guard, graphics, hit-test, zoom, and runtime key path');
})().catch(function (error) {
    console.error(error);
    process.exitCode = 1;
});
