/* Offline ASIG catalogue/config/renderer/registry regression tests. No service calls. */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

const CATALOGUE = readJson('data/asig-layers.json');
const MIRROR = require('./data/asig-layers.data.js');
const CONFIG = require('./js/asig-albania-layers.config.js');

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[ASIG] catalogue · panel · heritage · WMS/WMTS · feature info · registry');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE CATALOGUE IS GENERATED, IN SYNC, AND COMPLETE
 * ══════════════════════════════════════════════════════════════════════════ */
execFileSync(process.execPath, ['tools/build-asig-catalogue.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
check(true, 'the generator reproduces the committed catalogue (JSON + browser mirror)');
assert.deepStrictEqual(MIRROR, CATALOGUE);
check(true, 'data/asig-layers.json and data/asig-layers.data.js are the same object');
check(CATALOGUE.licence.state === 'unverified', 'the licence is recorded as unverified, not guessed');
check(/ASIG/.test(CATALOGUE.attribution), 'the catalogue carries the ASIG attribution');
check(JSON.stringify(CATALOGUE.bounds) === JSON.stringify([[39.538, 18.773], [42.758, 21.179]]), 'coverage bounds');

/* Section order and the requested row counts. The catalogue is the ONLY
 * Albanian content: no pre-catalogue row is kept alongside it. */
assert.deepStrictEqual(CATALOGUE.sections.map((s) => s.title),
    ['Orthophotos', 'LiDAR', 'Cadastre', 'Maps', 'Environment', 'Planning & mining']);
const counts = {};
CATALOGUE.sections.forEach((section) => { counts[section.title] = section.layers.length; });
assert.deepStrictEqual(counts, { Orthophotos: 14, LiDAR: 2, Cadastre: 3, Maps: 2, Environment: 1, 'Planning & mining': 6 });
const requested = CATALOGUE.sections.reduce((sum, section) => sum + section.layers.length, 0);
check(requested === 28, 'the catalogue holds exactly the 28 requested layers');
check(!CONFIG.byId('topo50k') && !/Topografike:50K_Topografike/.test(JSON.stringify(CATALOGUE)),
    'the pre-catalogue 1:50k sheet is gone from the catalogue and the config');
check(CONFIG.layers.every((layer) => !layer.retained), 'no catalogue row is kept for a pre-catalogue feature');

const all = CATALOGUE.sections.flatMap((section) => section.layers);
const byTitle = {};
all.forEach((layer) => { byTitle[layer.title] = layer; });
check(!!byTitle['Mineral Resouces'], 'the portal’s own “Mineral Resouces” spelling is preserved');
check(!byTitle['Mineral Resources'], 'the misspelling is not silently “fixed”');

/* The three tile-only products are the ones the WMS cannot serve. */
const wmts = all.filter((layer) => layer.kind === 'wmts').map((layer) => layer.name).sort();
assert.deepStrictEqual(wmts, ['DSM:Dsm_Hill_Group', 'Dtm_2015:Hillshade_2015_group', 'hartat_historike:italiane_100k']);
check(all.filter((layer) => layer.kind === 'wmts').every((layer) => layer.url === CATALOGUE.service.wmts),
    'tile-only rows point at the WMTS endpoint');
check(all.filter((layer) => layer.kind === 'wms').every((layer) =>
    !layer.name || (layer.url === CATALOGUE.service.wms ||
        layer.url === CATALOGUE.service.root + encodeURIComponent(layer.name.split(':')[0]) + '/wms')),
'every WMS row asks the per-workspace endpoint or the global service');
check(all.filter((layer) => layer.kind === 'wms').every((layer) => layer.fallbackUrl === CATALOGUE.service.wms),
    'every WMS row records the global endpoint as its one fallback');

/* Names that are not in the export yet must be marked, never invented. */
const unresolved = all.filter((layer) => !layer.name);
check(unresolved.every((layer) => layer.nameSource === 'unresolved' && layer.resolveByTitle === layer.title),
    'a row without a name carries the title used to resolve it, and nothing else');
check(CATALOGUE.unresolved.length === unresolved.length, 'the catalogue lists exactly its unresolved rows');

/* Heritage: one toggle, four known parts, and the keyword rule. */
check(CATALOGUE.heritage.id === 'heritage' && CATALOGUE.heritage.title === 'Heritage', 'Heritage is a single entry');
check(CATALOGUE.heritage.keyword === 'archaeolog|archeolog|arkeolog', 'the archaeology keyword rule is recorded');
const heritageNames = CATALOGUE.heritage.parts.map((part) => part.name);
['akzm:zonat_mbrojtura_081124', 'akzm:monumentet_natyrore_07032023'].forEach((name) =>
    check(heritageNames.includes(name), 'Heritage includes ' + name));
check(CATALOGUE.heritage.parts.some((part) => /pike/i.test(part.name || '')), 'Heritage includes the cultural points');
check(CATALOGUE.heritage.parts.some((part) => /zonatembrojturatetrashegimisekulturore22_07_2026/.test(part.name || '')),
    'Heritage includes the cultural polygons');
check(CATALOGUE.heritage.parts.every((part) => part.kind !== 'wmts'), 'no tile-only product is a Heritage part');

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE CONFIG ADDS REQUEST RULES, NOT NAMES
 * ══════════════════════════════════════════════════════════════════════════ */
check(CONFIG.country === 'AL', 'the catalogue belongs to Albania (ISO2 AL)');
check(CONFIG.wms.version === '1.3.0' && CONFIG.wms.crs === 'EPSG:3857' && CONFIG.wms.fallbackCrs === 'EPSG:4326',
    'WMS request path and EPSG:4326 fallback');
check(CONFIG.wms.styles === '' && CONFIG.endpoints.capabilities.defaultStyle === '', 'empty default style');
check(CONFIG.endpoints.nativeCrs === 'EPSG:6870' && CONFIG.wmts.tileMatrixSet === 'EPSG:4326',
    'native CRS is recorded; the browser reads the EPSG:4326 matrix set');
check(CONFIG.wmts.maxSourceZoom === 21 && CONFIG.wmts.tileMatrixPrefix === 'EPSG:4326:', 'WMTS grid settings');
check(CONFIG.licenceState === 'unverified' && /confirm|verify/i.test(CONFIG.licence), 'the config keeps the licence caveat');
check(CONFIG.layers.length === 29, '28 catalogue rows + the Heritage toggle');
check(CONFIG.sections[0].id === 'heritage', 'Heritage is the first panel section');
const wmtsUrl = CONFIG.wmtsTileUrl('DSM:Dsm_Hill_Group', 12, 100, 200);
check(/TileMatrix=EPSG%3A4326%3A12/.test(wmtsUrl) && /TileCol=100/.test(wmtsUrl) && /TileRow=200/.test(wmtsUrl),
    'WMTS GetTile URL uses the EPSG:4326 matrix, col and row');
check(/layer=DSM%3ADsm_Hill_Group/.test(wmtsUrl) && /tilematrixset=EPSG%3A4326/.test(wmtsUrl), 'WMTS layer and matrix set');
check(CONFIG.workspaceUrl('cadastre:Cadastral_Zone') === 'https://geoportal.asig.gov.al/service/cadastre/wms',
    'per-workspace WMS route is derived from the name');

/* The registry mirrors only what the WMS can answer. */
const registry = require('./js/layer-registry.js');
check(!!registry.GROUPS['asig-env'] && !!registry.GROUPS['asig-plan'], 'the two new catalogue groups exist');
check(!registry.GROUPS['albania-raster'] && !registry.GROUPS['albania-overlay'], 'legacy Albania groups stay removed');
const registered = registry.list().filter((def) => def.id.startsWith('albania.'));
const expectedRegistered = CONFIG.layers.filter((layer) => layer.layers &&
    (layer.kind === 'wms' || layer.kind === 'group'));
check(registered.length === expectedRegistered.length,
    'every answerable catalogue row is registered, and only those');
CONFIG.layers.filter((layer) => layer.kind === 'wmts').forEach((layer) =>
    check(!registry.get('albania.' + layer.id), layer.id + ' (WMTS-only) is not registered as WMS'));
CONFIG.layers.filter((layer) => layer.kind === 'wms' && !layer.layers).forEach((layer) =>
    check(!registry.get('albania.' + layer.id), layer.id + ' (unnamed) is not registered yet'));
registered.forEach((def) => {
    check(JSON.stringify(def.countries) === JSON.stringify(['AL']), def.id + ' is Albania-only');
    check(def.guard === false && def.selfGuarded === true, def.id + ' keeps its own failure handling');
    check(String(def.layer).length > 0, def.id + ' has a LAYERS value');
    check(def.group && registry.GROUPS[def.group], def.id + ' sits in a real catalogue group');
    check(def.ui && def.ui.toggle === 'albaniaToggle_' + def.ui.configId, def.id + ' points at its row controls');
});
check(registry.get('albania.heritage').ui.heritage === true, 'the Heritage row is flagged in the registry');
check(/akzm:zonat_mbrojtura_081124/.test(registry.get('albania.heritage').layer), 'Heritage mirrors its WMS parts');

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE RENDERER — DOM/Leaflet harness
 * ══════════════════════════════════════════════════════════════════════════ */
class TextNode {
    constructor(value) { this.nodeType = 3; this._text = String(value); this.children = []; }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); }
    contains() { return false; }
}
class Element {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.listeners = {};
        this.className = '';
        this._text = '';
        this.value = '';
        this.checked = false;
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        const self = this;
        this.classList = {
            toggle(name, on) { const set = self.classes || (self.classes = new Set()); on == null ? (set.has(name) ? set.delete(name) : set.add(name)) : (on ? set.add(name) : set.delete(name)); },
            add(name) { (self.classes || (self.classes = new Set())).add(name); },
            remove(name) { (self.classes || (self.classes = new Set())).delete(name); },
            contains(name) { return !!(self.classes && self.classes.has(name)); }
        };
    }
    get textContent() {
        if (!this.children.length) return this._text;
        return this.children.map((child) => child.textContent).join('');
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'id') { this.id = String(value); registryById[this.id] = this; }
    }
    getAttribute(name) { return this.attributes[name]; }
    appendChild(child) {
        if (child && child.nodeType === 3) child.parentNode = this;
        this.children.push(child);
        if (child) child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        if (child) child.parentNode = null;
        return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceChildren() {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = Array.from(arguments);
        this.children.forEach((child) => { child.parentNode = this; });
    }
    contains(node) { if (node === this) return true; return this.children.some((child) => child.contains && child.contains(node)); }
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
    fire(type, extra) {
        const event = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, extra || {});
        (this.listeners[type] || []).forEach((handler) => handler(event));
    }
    getContext() { return null; }
    click() { this.fire('click'); }
}
const registryById = {};
const elements = {};
function presetElement(id, tag) {
    const node = new Element(tag);
    node.setAttribute('id', id);
    elements[id] = node;
    return node;
}
presetElement('albaniaRow', 'div');
presetElement('albaniaToggle', 'input');
presetElement('albaniaExpandBtn', 'button');
presetElement('albaniaExpandIcon', 'svg');
const mount = presetElement('albaniaSubLayers', 'div');
const lidarMount = presetElement('albaniaLidarLayers', 'div');

const document = {
    readyState: 'complete',
    documentElement: { getAttribute: () => 'en' },
    listeners: {},
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    getElementById: (id) => elements[id] || registryById[id] || null,
    addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
};

function proto() {}
proto.prototype.on = function () { return this; };
proto.prototype.off = function () { return this; };
proto.prototype.onAdd = function () {};
proto.prototype.onRemove = function () {};
proto.prototype.setOpacity = function (value) { this.opacity = value; };
proto.prototype.setZIndex = function (value) { this.zIndex = value; };
proto.prototype.redraw = function () { this.redrawn = true; };
proto.prototype.initialize = function () {
    for (let i = 0; i < arguments.length; i++) {
        const arg = arguments[i];
        if (arg && typeof arg === 'object') this.options = Object.assign({}, this.options || {}, arg);
    }
};
proto.prototype._tileCoordsToBounds = function () {
    return {
        getSouthWest: () => ({ lat: 41.2, lng: 19.7 }),
        getNorthEast: () => ({ lat: 41.4, lng: 19.9 })
    };
};
proto.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
proto.extend = function (props) {
    function Child() { if (this.initialize) this.initialize.apply(this, arguments); }
    Child.prototype = Object.create(proto.prototype);
    Object.assign(Child.prototype, props);
    Child.extend = proto.extend;
    return Child;
};
const TileLayer = proto.extend({});
const GridLayer = proto.extend({});

const warnings = [];
const infos = [];
const layersOnMap = new Set();
const map = {
    options: { crs: { project: (ll) => ({ x: ll.lng * 20037508.34 / 180, y: ll.lat * 20037508.34 / 180 }) } },
    panes: {},
    listeners: {},
    createPane(id) { return (this.panes[id] = { style: {} }); },
    getPane(id) { return this.panes[id]; },
    hasLayer(layer) { return layersOnMap.has(layer); },
    addLayer(layer) { layersOnMap.add(layer); },
    removeLayer(layer) { layersOnMap.delete(layer); },
    setView(center, zoom) { this.view = { center, zoom }; },
    on(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); },
    getBounds() {
        return {
            getSouthWest: () => ({ lat: 39.5, lng: 18.7 }),
            getNorthEast: () => ({ lat: 42.8, lng: 21.2 })
        };
    },
    getSize() { return { x: 800, y: 600 }; },
    latLngToContainerPoint() { return { x: 400, y: 300 }; }
};

/* Capabilities used by the run-time resolver (browser-side in production). */
const CAPABILITIES = [
    { name: 'cadastre:Cadastral_Zone', title: 'Cadastral Zone' },
    { name: 'cadastre:Cadastral_Parcels', title: 'Cadastral Parcels' },
    { name: 'cadastre:ashk_cadastral_parcels', title: 'Cadastral Parcels (ASHK)' },
    { name: 'topo:25k_krgjsh_1', title: '25k_krgjsh_1' },
    { name: 'hidro:Water_Course_Link', title: 'Water course link' },
    { name: 'plan:zonat_e_planifikuara_dcm347', title: 'Areas Planned by (DCM 347)' },
    { name: 'plan:zona_rrezik_minier_dcm726', title: 'Mining Hazardous Areas (DCM 726)' },
    { name: 'plan:zona_rrezik_minier_dcm347', title: 'Mining Hazardous Areas (DCM 347)' },
    { name: 'plan:zonat_e_vjetra_miniere', title: 'Old Mining Areas' },
    { name: 'plan:burimet_minerale', title: 'Mineral Resouces' },
    { name: 'plan:lejet_e_shfrytezimit', title: 'Mining exploitation permits' },
    { name: 'akzm:zona_arkeologjike_kruje', title: 'Zona arkeologjike Krujë (DCM)' },
    { name: 'akzm:zona_arkeologjike_shkoder', title: 'Zona arkeologjike Shkodër (DCM)' }
];
const capabilitiesDoc = {
    querySelector: () => null,
    getElementsByTagName: () => CAPABILITIES.map((entry) => ({
        localName: 'Layer',
        children: [
            { localName: 'Name', textContent: entry.name },
            { localName: 'Title', textContent: entry.title }
        ]
    }))
};
const fetchCalls = [];
const sandbox = {
    console: { warn: (...args) => warnings.push(args.join(' ')), info: (...args) => infos.push(args.join(' ')), error() {} },
    document,
    L: {
        TileLayer,
        GridLayer,
        Layer: proto,
        setOptions: (target, options) => Object.assign(target.options || (target.options = {}), options),
        latLngBounds: (bounds) => { const b = bounds.slice ? { south: bounds[0][0], west: bounds[0][1], north: bounds[1][0], east: bounds[1][1] } : bounds; return b; },
        CRS: { EPSG3857: { project: map.options.crs.project } },
        popup: (options) => ({
            options,
            setLatLng(latlng) { this.latlng = latlng; return this; },
            setContent(content) { this.content = content; return this; },
            openOn(target) { target.openedPopup = this; return this; }
        })
    },
    _dlMap: map,
    localStorage: {
        data: {},
        getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
        setItem(key, value) { this.data[key] = String(value); }
    },
    DOMParser: class { parseFromString() { return capabilitiesDoc; } },
    URLSearchParams,
    fetch: (url) => {
        fetchCalls.push(String(url));
        if (/GetCapabilities/i.test(String(url))) return Promise.resolve({ ok: true, text: () => Promise.resolve('<WMS_Capabilities/>') });
        if (/GetFeatureInfo/i.test(String(url))) return Promise.resolve({ ok: true, text: () => Promise.resolve('<table><tr><td>Fortress</td></tr></table>') });
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
    },
    setInterval, clearInterval,
    alert() {},
    showLayerInfo(...args) { sandbox.shownInfo = args; },
    _currentLang: () => 'en'
};
sandbox.window = sandbox;
sandbox.ASIG_ALBANIA_CONFIG = CONFIG;
sandbox.ASIG_LAYERS_CATALOGUE = MIRROR;
vm.createContext(sandbox);
vm.runInContext(read('js/asig-heritage.js'), sandbox, { filename: 'js/asig-heritage.js' });
vm.runInContext(read('js/asig-albania-layers.js'), sandbox, { filename: 'js/asig-albania-layers.js' });
const API = sandbox.AsigAlbaniaLayers;
assert.ok(API, 'the module exposes window.AsigAlbaniaLayers');
API.init();

/* ── panel structure ─────────────────────────────────────────────────────── */
check(API.layerIds().length === 29, 'the group renders all 28 catalogue rows plus the Heritage toggle');
function allRows(node, found) {
    found = found || [];
    (node.children || []).forEach((child) => {
        if (typeof child.className === 'string' && child.className.indexOf('albania-layer-row') === 0) found.push(child);
        allRows(child, found);
    });
    return found;
}
const rows = allRows(mount).concat(allRows(lidarMount));
const sections = mount.children.filter((child) => child.attributes['data-albania-section']);
check(!mount.children.some(child => child.className === 'albania-catalogue-tools'), 'no country-level catalogue toolbar');
const heritageBlock = mount.children[0];
check(heritageBlock.className === 'albania-heritage-block', 'Heritage sits at the top of the panel, above every section');
const heritageRows = heritageBlock.children.filter((child) => child.className && child.className.indexOf('albania-layer-row') === 0);
check(heritageRows.length === 1 && heritageRows[0].id === 'albaniaRow_heritage',
    'Heritage is ONE toggle — its parts are not rows');
check(!sections.some((section) => section.attributes['data-albania-section'] === 'heritage'),
    'Heritage is not a collapsible section of parts');
check(sections.length === 5, 'the six catalogue sections render as collapsible blocks');
assert.deepStrictEqual(sections.map((section) => section.attributes['data-albania-section']),
    ['orthophotos', 'cadastre', 'maps', 'environment', 'planning']);
sections.forEach((section) => {
    const head = section.children[0];
    const body = section.children[1];
    check(head.attributes['aria-expanded'] === 'true', section.attributes['data-albania-section'] + ' starts expanded');
    check(body.children.length === Number(head.children[2].textContent.replace(/[()]/g, '')),
        section.attributes['data-albania-section'] + ' body holds exactly its rows');
});
check(rows.length === 29 && rows.filter((row) => row.id !== 'albaniaRow_heritage').length === 28,
    'all 28 catalogue rows plus the Heritage toggle are mounted in the one Albania group');
check(rows.filter((row) => row.id === 'albaniaRow_topo50k').length === 0,
    'the pre-catalogue 1:50k row is not rendered');
LAYERS_CHECK();
function LAYERS_CHECK() {
    CONFIG.layers.forEach((layer) => {
        const row = API.state.rows[layer.id];
        assert.ok(row && row.input && row.slider && row.status && row.go, layer.id + ' has toggle, slider, status and Tirana action');
        assert.strictEqual(row.row.attributes['data-category'], 'free');
        assert.strictEqual(row.input.id, 'albaniaToggle_' + layer.id);
        assert.strictEqual(row.slider.id, 'albaniaOpacity_' + layer.id);
    });
    check(true, 'every row carries checkbox, opacity slider, status line and Tirana action');
}
check(API.HERITAGE_ID === 'heritage' && !!API.state.rows.heritage &&
    API.state.rows.heritage.input.id === 'albaniaToggle_heritage',
    'the Heritage row is addressable as “heritage” and owns exactly one checkbox');

/* ── search ──────────────────────────────────────────────────────────────── */
API.setSearch('durres');
let visible = 0;
mount.children.forEach((child) => {
    if (child.className === 'albania-layer-row' && child.style.display !== 'none') visible++;
    if (child.attributes['data-albania-section']) {
        child.children[1].children.forEach((row) => { if (row.style.display !== 'none') visible++; });
    }
});
check(visible === 1 && API.state.rows.ortho_durres_1986.row.style.display === '',
    'the search box filters rows by display title');
API.setSearch('zonat_mbrojtura');
check(API.state.rows.heritage.row.style.display === '', 'searching the service name of a Heritage part keeps the Heritage toggle');
API.setSearch('zzz-nothing');
check(mount.children.some((child) => child.id === 'albaniaSearchEmpty'), 'an unmatched search says so');
API.setSearch('');
const restored = allRows(mount).concat(allRows(lidarMount));
check(restored.length === 29 && restored.every((row) => row.style.display === ''), 'clearing the search restores every row');

/* ── country gate ────────────────────────────────────────────────────────── */
check(API.isInCountry() === false && elements.albaniaRow.classList.contains('albania-out-of-country'),
    'the group starts hidden in the global view');
['RO', 'DK', 'FI', 'IT'].forEach((iso) => {
    API.filterForCountry(iso);
    check(API.isInCountry() === false && elements.albaniaRow.classList.contains('albania-out-of-country'),
        'the group and its rows stay hidden for ' + iso);
});
API.filterForCountry('AL');
check(API.isInCountry() === true && !elements.albaniaRow.classList.contains('albania-out-of-country'),
    'selecting Albania shows the group');
check(rows.every((row) => !row.classList.contains('country-layer-unavailable')), 'every row is re-enabled for Albania');

/* ── activation, opacity, ordering ───────────────────────────────────────── */
API.toggle('ortho_1999', true);
check(API.isActive('ortho_1999') && layersOnMap.size === 1, 'a row toggle adds exactly one layer');
API.toggle('hillshade_2015', true);
check(layersOnMap.size === 2, 'the WMTS row adds its canvas layer');
const orderBefore = API.activeOrder().slice();
API.moveActive('ortho_1999', 1);
check(API.activeOrder().indexOf('ortho_1999') === orderBefore.indexOf('ortho_1999') + 1,
    'the active list reorders the draw order');
const zIndexes = Array.from(layersOnMap).map((layer) => layer.zIndex);
check(new Set(zIndexes).size === 2, 'each active entry gets its own z-index in the shared pane');
check(map.panes[API.PANE_ID].style.zIndex === '404' && map.panes[API.PANE_ID].style.pointerEvents === 'none',
    'every catalogue layer shares one pane so the list order is the draw order');

/* Heritage: one switch, one opacity, every part. */
API.toggle('heritage', true);
const heritageParts = API.activeLeaves().filter((leaf) => /^(akzm|iktk):/.test(leaf.name));
check(heritageParts.length === 0, 'Heritage does not create WMS stacks or GetFeatureInfo queries');
const heritageLayers = Array.from(layersOnMap).filter(layer => layer._dlDefId === 'albania.heritage');
check(heritageLayers.length === 1, 'Heritage uses one bounded viewport controller');
API.setOpacity('heritage', 42);
check(heritageLayers.every(layer => Math.abs(layer._opacity - 0.42) < 1e-9), 'Heritage opacity reaches the viewport controller');
check(API.state.opacity.heritage === 42, 'Heritage keeps a single opacity value');
API.toggle('heritage', false);
check(layersOnMap.size === 2, 'one click removes every Heritage part');

API.toggleAll(true);
const expectedLayers = CONFIG.layers.reduce((sum, def) => {
    if (def.kind === 'group') return sum + 1;
    return sum + (def.name ? 1 : 0);
}, 0);
check(layersOnMap.size === expectedLayers, 'the group master switch turns the whole catalogue on');
API.toggleAll(false);
check(layersOnMap.size === 0, 'and off again');

/* The choice survives the country gate without requesting anything. */
API.toggle('ortho_1999', true);
API.filterForCountry('RO');
check(API.isActive('ortho_1999') && layersOnMap.size === 0, 'switching country parks the layer and keeps the choice');
API.filterForCountry('AL');
check(API.isActive('ortho_1999') && layersOnMap.size === 1, 'returning to Albania restores it');
API.toggle('ortho_1999', false);

/* ── requests ────────────────────────────────────────────────────────────── */
const url3857 = API.tileUrl('ortho_1999', [1000000, 4000000, 3000000, 6000000], 256, 'EPSG:3857');
const parsed = new URL(url3857);
check(parsed.searchParams.get('LAYERS') === 'Orthophoto:Ortofoto_1999' && parsed.searchParams.get('STYLES') === '',
    'WMS URL has the exact Name and an empty style');
const clip = parsed.searchParams.get('BBOX').split(',').map(Number);
check(clip[0] > 1000000 && clip[1] > 4000000 && clip[2] < 3000000 && clip[3] < 6000000,
    'the requested WMS BBOX is clipped to the ASIG footprint');
const url4326 = new URL(API.tileUrl('heritage_natural_protected_areas', [18, 39, 22, 43], 256, 'EPSG:4326'));
check(url4326.searchParams.get('CRS') === 'EPSG:4326' && url4326.searchParams.get('BBOX').startsWith('39.538,18.773'),
    'the EPSG:4326 fallback uses latitude/longitude axis order and clips');
check(API.tileUrl('dsm_hill', [1, 2, 3, 4], 256, 'EPSG:3857') === '',
    'a tile-only row never asks the WMS (it would answer LayerNotDefined with HTTP 200)');

const layer = new API.Layer(CONFIG.byId('ortho_1999'), {});
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) layer._onTileError();
check(layer.options.crs === 'EPSG:4326' && layer.redrawn, 'the configured error burst switches the layer to EPSG:4326');
const before = warnings.length;
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) layer._onTileError();
check(warnings.length === before, 'a second burst does not repeat the console warning');
let tileError = false;
const tile = layer.createTile({ x: 1, y: 2, z: 3 }, (error) => { tileError = !!error; });
tile.naturalWidth = 0;
tile.naturalHeight = 0;
tile.onload();
check(tileError, 'an HTTP 200 XML/HTML or non-image body is a tile error');

/* ── WMTS reprojection maths ──────────────────────────────────────────────── */
const plan = API.planWmtsTile(12, 2273, 1530, 256, 12);
check(plan.z === 12 && plan.rows.length === 256, 'one destination pixel row per source row lookup');
check(plan.cols.length >= 1 && plan.cols[0].c >= 0, 'the destination tile maps to plate-carrée columns');
check(plan.rows.every((row) => row.r >= 0 && row.r < Math.pow(2, 12) && row.sy >= 0 && row.sy <= 256 && row.sh > 0),
    'every source row is inside the EPSG:4326 level and its slice is inside the 256-px tile');
check(plan.rows[0].r <= plan.rows[100].r && plan.rows[100].r <= plan.rows[255].r, 'source rows increase north → south');
const stepDown = API.planWmtsTile(12, 2273, 1530, 256, 9);
check(stepDown.z === 9 && stepDown.cols.length > 0, 'a shallower source level is used when a deep one is not cached');
const worldPlan = API.planWmtsTile(0, 0, 0, 256, 0);
check(worldPlan.cols.length === 2 && worldPlan.rows[0].r === 0,
    'level 0 of the EPSG:4326 grid is two tiles wide, as the WMTS matrix set says');

/* Shared WMTS images: concurrent/revisited destination tiles reuse requests. */
const originalCreateElement = document.createElement;
const sourceImages = [];
let paints = 0;
document.createElement = (tag) => {
    const node = originalCreateElement(tag);
    if (tag === 'img') sourceImages.push(node);
    if (tag === 'canvas') node.getContext = () => ({ drawImage() { paints++; } });
    return node;
};
const wmtsLayer = new API.WmtsLayer(CONFIG.byId('hillshade_2015'));
let completedTiles = 0;
const destination = { z: 12, x: 2273, y: 1530 };
wmtsLayer.createTile(destination, (error) => { assert.ifError(error); completedTiles++; });
const uniqueRequests = sourceImages.length;
check(uniqueRequests > 1, 'WMTS mosaic has multiple source images');
wmtsLayer.createTile(destination, (error) => { assert.ifError(error); completedTiles++; });
check(sourceImages.length === uniqueRequests, 'concurrent WMTS tiles share in-flight source requests');
sourceImages[0].naturalWidth = sourceImages[0].naturalHeight = 256;
sourceImages[0].onload();
check(paints > 0 && completedTiles === 0, 'available imagery paints before the slowest source completes');
sourceImages.slice(1).forEach(image => {
    image.naturalWidth = image.naturalHeight = 256;
    image.onload();
});
check(completedTiles === 2, 'all shared request consumers complete once');
wmtsLayer.createTile(destination, (error) => { assert.ifError(error); completedTiles++; });
check(sourceImages.length === uniqueRequests && completedTiles === 3, 'revisiting a tile reuses decoded source images');
const failedLayer = new API.WmtsLayer(CONFIG.byId('dsm_hill'));
let failedDone = 0;
const failedStart = sourceImages.length;
failedLayer.createTile({ z: 0, x: 0, y: 0 }, (error) => { check(!!error, 'missing WMTS sources report an error'); failedDone++; });
sourceImages.slice(failedStart).forEach(image => image.onerror());
const failedRequests = sourceImages.length;
failedLayer.createTile({ z: 0, x: 0, y: 0 }, () => { failedDone++; });
check(failedDone === 2 && sourceImages.length === failedRequests, 'recent failed sources are shared rather than immediately requested again');
document.createElement = originalCreateElement;

/* ── run-time name resolution ────────────────────────────────────────────── */
(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    check(fetchCalls.some((url) => /GetCapabilities/i.test(url)), 'the unresolved rows ask the service capabilities once');
    check(CONFIG.byId('cadastral_zone').name === 'cadastre:Cadastral_Zone',
        'a row without a baked name is resolved by title in the browser');
    check(CONFIG.byId('mineral_resources').name === 'plan:burimet_minerale',
        'the misspelled title is what resolution matches, so the name is right');
    check(/^akzm:zona_arkeologjike_/.test(API.state.resolver.parts[0].name),
        'every archaeological layer joins Heritage as a part');
    check(API.state.rows.heritage.input.id === 'albaniaToggle_heritage' &&
        API.state.rows.heritage.slider.id === 'albaniaOpacity_heritage',
        'Heritage still has one checkbox and one opacity slider after new parts are found');
    API.toggle('cadastral_zone', true);
    check(layersOnMap.size === 1 && /cadastre\/wms/.test(Array.from(layersOnMap)[0].endpoint()),
        'a resolved row draws from its per-workspace endpoint');

    /* ── feature info ────────────────────────────────────────────────────── */
    const leaves = API.activeLeaves();
    check(leaves.length === 1 && leaves[0].name === 'cadastre:Cadastral_Zone', 'feature info queries every active WMS layer');
    fetchCalls.length = 0;
    const results = await API.featureInfo({ lat: 41.3, lng: 19.8 });
    check(fetchCalls.length === 1 && /GetFeatureInfo/i.test(fetchCalls[0]), 'one GetFeatureInfo request per endpoint');
    check(/x=400&y=300/.test(fetchCalls[0]) || /x=400/.test(fetchCalls[0]), 'the clicked pixel and view size are sent');
    check(results.length === 1 && /Fortress/.test(results[0].html), 'the service HTML comes back for a sandboxed iframe');
    API.openFeatureInfo({ lat: 41.3, lng: 19.8 });
    const popup = map.openedPopup;
    check(!!popup && popup.content && popup.content.className === 'albania-feature-info', 'the answer opens in a map popup');
    API.toggle('cadastral_zone', false);

    /* ── persistence + text refresh ──────────────────────────────────────── */
    API.toggle('ortho_2018', true);
    API.setOpacity('ortho_2018', 33);
    const stored = JSON.parse(sandbox.localStorage.getItem('detectlab_albania_layers_v2'));
    check(stored.active.ortho_2018 === true && stored.opacity.ortho_2018 === 33 && Array.isArray(stored.order),
        'on/off, opacity and order are persisted');
    API.refreshTexts();
    check(API.state.rows.ortho_2018.input.checked === true && API.state.rows.ortho_2018.pct.textContent === '33%',
        'a rebuild keeps the state');
    check(API.state.rows.ortho_2018.row.classList.contains('is-active'), 'the active row is marked');

    /* ── the HTML/assets that carry all of this ──────────────────────────── */
    const html = read('index.html');
    check(html.includes('data/asig-layers.data.js?v=20261024-asig-lidar'),
        'index.html loads the generated catalogue before the config');
    /* Each asset carries the tag of whatever last changed it: the data file and
     * the config by the “LiDAR” rename, the module by the catalogue itself. */
    check(/js\/asig-albania-layers\.js\?v=20261026-viewport-heritage/.test(html) &&
        /js\/asig-albania-layers\.config\.js\?v=20261024-asig-lidar/.test(html),
        'index.html loads the re-tagged module and config');
    check(html.includes('id="albaniaSubLayers"'), 'the single Albania mount is still in the shell');
    check(!/data-key="albania_group_title"/.test(html), 'no country-level layer heading');
    check(/#albaniaRow\.albania-out-of-country\s*\{[\s\S]*?display:\s*none\s*!important/.test(read('css/styles.css')),
        'the country gate is still enforced by CSS');
    check(/\.albania-section-head/.test(read('css/styles.css')) && /\.albania-active-item/.test(read('css/styles.css')),
        'the new panel parts are styled with the panel’s own classes');
    check(/'geoportal\.asig\.gov\.al':/.test(read('js/wms-health.js')), 'the ASIG host stays in the health list');
    check(/filterForCountry\(iso\)/.test(read('js/map-app.js')) &&
        /AsigAlbaniaLayers[\s\S]{0,200}?filterForCountry\(null\)/.test(read('js/map-app.js')),
        'map-app still gates and releases the group');

    check(warnings.filter((line) => /^\[ASIG\]/.test(line)).length <= 2,
        'console output stays one concise warning per row');
    console.log(`[ASIG] ${checks} checks passed (offline only; no production request made).`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
