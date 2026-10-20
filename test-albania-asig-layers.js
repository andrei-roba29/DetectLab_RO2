/* Offline ASIG layer/config/renderer/registry regression tests. No service calls. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const CONFIG = require('./js/asig-albania-layers.config.js');
const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const names = [
    'Topografike:50K_Topografike',
    'Orthophoto:Ortofoto_1999',
    'orthophoto_2015:OrthoImagery_20cm',
    'DSM:Dsm_Hill_Group',
    'Dtm_2015:Hillshade_2015_group',
    'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
    'akzm:zonat_mbrojtura_081124',
    'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
    'akzm:monumentet_natyrore_07032023'
];
const ids = ['topo50k', 'ortho1999', 'ortho1994', 'dsm', 'lidar', 'heritage', 'natural', 'cultural', 'monument'];
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[ASIG] config, panel sections, WMS request, registry, tile failure behavior');
assert.strictEqual(CONFIG.layers.length, 9);
assert.deepStrictEqual(CONFIG.layers.map((layer) => layer.layers), names);
assert.deepStrictEqual(CONFIG.layers.map((layer) => layer.id), ids);
check(CONFIG.layers.every((layer) => layer.section && layer.registryGroup && Number.isFinite(layer.registryZ)), 'all layers carry render and registry section metadata');
check(CONFIG.layers.every((layer) => layer.attributionRow.includes('ASIG')), 'each layer credits ASIG');
check(JSON.stringify(CONFIG.countryBounds) === JSON.stringify([[39.538, 18.773], [42.758, 21.179]]), 'coverage bounds match owner limits');
check(JSON.stringify(CONFIG.view) === JSON.stringify({ center: [41.3275, 19.8187], zoom: 9, label: { ro: 'Tirana', en: 'Tirana' } }), 'Tirana center and zoom are configured');
check(CONFIG.endpoints.capabilities.wmsVersion === '1.3.0', 'capabilities fixture facts state WMS 1.3.0');
assert.deepStrictEqual(CONFIG.endpoints.capabilities.getMapFormats, ['image/png', 'image/jpeg']);
assert.deepStrictEqual(CONFIG.endpoints.capabilities.rootCrs, ['EPSG:6870', 'EPSG:4326', 'EPSG:900913', 'CRS:84']);
check(CONFIG.endpoints.capabilities.defaultStyle === '' && CONFIG.wms.styles === '', 'default style remains empty');
check(CONFIG.endpoints.nativeCrs === 'EPSG:6870' && CONFIG.endpoints.nativeTileMatrixSet === 'EPSG:6870', 'native CRS/matrix set is recorded without XYZ construction');
check(CONFIG.wms.crs === 'EPSG:3857' && CONFIG.wms.fallbackCrs === 'EPSG:4326', 'Web Mercator request path and fallback remain configured');
['heritage', 'natural', 'cultural', 'monument'].forEach((id) => check(/2026|2024|2023/.test(CONFIG.byId(id).description), id + ' keeps its snapshot date in its metadata'));
check(CONFIG.byId('ortho1994').title.en.includes('20 cm') && CONFIG.byId('ortho1994').title.en.includes('2015'), '20 cm orthophoto is labeled as catalogued (2015), not 1994');
const fixture = read('test/fixtures/asig-wms-capabilities.xml');
check(/Owner-supplied excerpt; not fetched by this test or the implementation/.test(fixture), 'capabilities fixture is explicitly owner-supplied, not live');
names.forEach((name) => check(fixture.includes('<Name>' + name + '</Name>'), 'capabilities fixture preserves ' + name));
check(/<Name><\/Name>/.test(fixture), 'capabilities fixture records empty default styles');

const registry = require('./js/layer-registry.js');
check(!registry.GROUPS['albania-raster'] && !registry.GROUPS['albania-overlay'], 'legacy Albania registry groups are removed');
CONFIG.layers.forEach((layer) => {
    const def = registry.get('albania.' + layer.id);
    assert.ok(def, 'registry row exists for ' + layer.id);
    assert.strictEqual(def.layer, layer.layers);
    assert.strictEqual(def.group, layer.registryGroup);
    assert.strictEqual(def.z, layer.registryZ);
    assert.strictEqual(def.guard, false);
    assert.strictEqual(def.selfGuarded, true);
    check(!!def.selfGuardedReason && def.countryIndependent === true, layer.id + ' retains a meaningful self-guard and is country-independent');
});
check(/'geoportal\.asig\.gov\.al':/.test(read('js/wms-health.js')), 'ASIG host remains in the health host list');

const html = read('index.html');
['asigHistoricalLayers', 'asigSatelliteLayers', 'asigLidarLayers', 'asigHeritageLayers'].forEach((id) => check(html.includes('id="' + id + '"'), id + ' mount exists in an existing section'));
check(!/id="albaniaRow"|id="albaniaSubLayers"|id="albaniaToggle"|id="albaniaGroupNotice"/.test(html), 'no Albania-wide master group or generated subgroup container remains');
check(/countryIndependent/.test(read('js/map-app.js')), 'country-layer filter honors independent registry rows');
check(/asig-albania-layers\.config\.js\?v=20261020-albania-independent-rows/.test(html), 'updated config asset tag is in index');
check(/detectlab-v236-3d-analysis-points/.test(read('sw.js')), 'service-worker cache moves forward from v235');

// Tiny DOM/Leaflet harness exercises config-driven rendering and tile errors.
class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.value = ''; this.checked = false; this.naturalWidth = 0; this.naturalHeight = 0; this.classList = { toggle: (name, on) => { this.classes = this.classes || new Set(); on ? this.classes.add(name) : this.classes.delete(name); }, add: (name) => { this.classes = this.classes || new Set(); this.classes.add(name); } }; }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
    fire(type) { (this.listeners[type] || []).forEach((cb) => cb({ target: this, preventDefault() {}, stopPropagation() {} })); }
    set innerHTML(value) { if (value === '') this.children = []; }
    get innerHTML() { return ''; }
}
const mounts = ['asigHistoricalLayers', 'asigSatelliteLayers', 'asigLidarLayers', 'asigHeritageLayers'];
const elements = Object.fromEntries(mounts.map((id) => [id, new Element('div')]));
const document = {
    readyState: 'loading', documentElement: { getAttribute: () => 'en' }, listeners: {},
    createElement: (tag) => new Element(tag),
    getElementById: (id) => elements[id] || null,
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
};
function Layer() {}
Layer.prototype.initialize = function (_url, options) { this.options = Object.assign({}, this.options || {}, options || {}); };
Layer.prototype.on = function () { return this; };
Layer.prototype.off = function () { return this; };
Layer.prototype.onAdd = function () {};
Layer.prototype.onRemove = function () {};
Layer.prototype.setOpacity = function (v) { this.opacity = v; };
Layer.prototype.redraw = function () { this.redrawn = true; };
Layer.prototype._tileCoordsToBounds = function () { return { getSouthWest: () => ({ lat: 41.2, lng: 19.7 }), getNorthEast: () => ({ lat: 41.4, lng: 19.9 }) }; };
Layer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
Layer.extend = function (props) { function Child() { if (this.initialize) this.initialize.apply(this, arguments); } Child.prototype = Object.create(Layer.prototype); Object.assign(Child.prototype, props); Child.extend = Layer.extend; return Child; };
const warnings = [];
const map = { options: { crs: { project: (ll) => ({ x: ll.lng * 1000, y: ll.lat * 1000 }) } }, panes: {}, layers: new Set(), createPane(id) { return this.panes[id] = { style: {} }; }, getPane(id) { return this.panes[id]; }, hasLayer(layer) { return this.layers.has(layer); }, addLayer(layer) { this.layers.add(layer); }, removeLayer(layer) { this.layers.delete(layer); }, setView(center, zoom) { this.view = { center, zoom }; } };
const sandbox = {
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    document, L: { TileLayer: Layer, setOptions: (o, opts) => Object.assign(o, opts), latLngBounds: (b) => b, CRS: { EPSG3857: { project: (ll) => ({ x: ll.lng * 1000, y: ll.lat * 1000 }) } } },
    _dlMap: map, localStorage: { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; } },
    setInterval, clearInterval, alert() {}, showLayerInfo() {}, _currentLang: () => 'en'
};
sandbox.window = sandbox;
sandbox.ASIG_ALBANIA_CONFIG = CONFIG;
vm.createContext(sandbox);
vm.runInContext(read('js/asig-albania-layers.js'), sandbox, { filename: 'js/asig-albania-layers.js' });
const API = sandbox.AsigAlbaniaLayers;
API.init();
assert.strictEqual(API.layers.length, 9);
const rendered = Object.values(elements).flatMap((mount) => mount.children);
assert.strictEqual(rendered.length, 9, 'renderer generates nine rows from config');
CONFIG.layers.forEach((layer) => {
    const row = API.state.rows[layer.id];
    assert.ok(row && row.input && row.slider && row.status && row.go, layer.id + ' has toggle, slider, status, and Tirana action');
    assert.strictEqual(row.row.attributes['data-category'], 'free');
});
check(rendered.length === 9, 'all nine independently operable Free rows are rendered into the four existing sections');
API.filterForCountry('RO');
check(rendered.every((row) => !row.classes || !row.classes.has('country-layer-unavailable')), 'rows remain visible in other country views');
API.toggle('topo50k', true);
check(API.isActive('topo50k') && map.layers.size === 1, 'per-layer toggle activates only its layer');
API.setOpacity('topo50k', 43);
check(API.state.opacity.topo50k === 43, 'per-layer opacity state is updated');
API.goToView();
check(map.view.zoom === 9 && map.view.center[0] === 41.3275 && map.view.center[1] === 19.8187, 'each Tirana action targets configured view');
const url3857 = API.tileUrl('topo50k', [1000000, 4000000, 3000000, 6000000], 256, 'EPSG:3857');
const parsed3857 = new URL(url3857);
check(parsed3857.searchParams.get('LAYERS') === names[0] && parsed3857.searchParams.has('STYLES') && parsed3857.searchParams.get('STYLES') === '', 'WMS URL has exact Name and empty style');
const clip = parsed3857.searchParams.get('BBOX').split(',').map(Number);
check(clip[0] > 1000000 && clip[1] > 4000000 && clip[2] < 3000000 && clip[3] < 6000000, 'requested WMS BBOX is clipped to Albania');
const url4326 = new URL(API.tileUrl('natural', [18, 39, 22, 43], 256, 'EPSG:4326'));
check(url4326.searchParams.get('CRS') === 'EPSG:4326', 'fallback request names EPSG:4326');
check(url4326.searchParams.get('BBOX').startsWith('39.538,18.773'), 'WMS 1.3.0 fallback uses EPSG:4326 latitude/longitude axis order and clips');
const layer = new API.Layer(CONFIG.byId('topo50k'), {});
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) layer._onTileError();
check(layer.options.crs === 'EPSG:4326' && layer.redrawn, 'configured EPSG:3857 error burst switches layer to EPSG:4326');
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) layer._onTileError();
check(API.state.rows.topo50k.status.textContent === API.TEXT.en.unavailable, 'persistent fallback errors show source-unavailable status');
check(warnings.length === 1, 'at most one concise console warning is emitted per layer');
const failedTile = layer.createTile({ x: 1, y: 2, z: 3 }, (err) => { layerTileError = !!err; });
let layerTileError = false;
failedTile.naturalWidth = 0; failedTile.naturalHeight = 0; failedTile.onload();
check(layerTileError, 'HTTP 200 XML/HTML or non-image decode is surfaced as a tile error');

console.log(`[ASIG] ${checks + 18} checks passed (offline only; no production request made).`);
