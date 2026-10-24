/* Offline ASIG catalogue regression tests: config, registry mirror, the one
 * Albania-only panel group, country gate, WMS/WMTS request construction,
 * Heritage-as-one-toggle, stack reordering, capabilities discovery against a
 * SYNTHETIC fixture, and the tile-failure fallback chain.
 * No service calls are made. Live verification is the owner's browser job —
 * ASIG blacklists automated IPs (see ALBANIA_ASIG_LAYERS.md). */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const CONFIG = require('./js/asig-albania-layers.config.js');
const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[ASIG] catalogue config, registry, panel, gate, requests, discovery, fallbacks');

/* ── 1. Catalogue shape (acceptance: Heritage + 14/2/3/2/1/6, data-driven) ── */
assert.deepStrictEqual(CONFIG.countsBySection(), {
    heritage: 1, orthophotos: 14, terrain: 2, cadastre: 3, maps: 2, environment: 1, planning: 6
});
assert.strictEqual(CONFIG.layers.length, 32, '32 tile definitions');
assert.strictEqual(CONFIG.panelLayers().length, 28, '28 panel tile rows');
assert.strictEqual(CONFIG.panelOrder().length, 29, '29 panel entries (Heritage + 28)');
assert.deepStrictEqual(CONFIG.sections.map((s) => s.id),
    ['heritage', 'orthophotos', 'terrain', 'cadastre', 'maps', 'environment', 'planning']);
const STATIC_WMS = [
    'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
    'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
    'akzm:zonat_mbrojtura_081124', 'akzm:monumentet_natyrore_07032023',
    'Orthophoto:Ortofoto_76_86_25k', 'Orthophoto:ortofoto_94',
    'orthophoto_2007:OrthoImagery', 'orthophoto_2015:OrthoImagery',
    'orthophoto_2015:OrthoImagery_20cm', 'orthophoto_2015:OrthoImagery_8cm',
    'Orthophoto_cir:Orthophoto_CIR', 'Orthophoto_cir:Orthophoto_CIR_8cm',
    'ortofoto_2018:Ortofoto_2018', 'Orthophoto:Ortofoto_2001',
    'Orthophoto:Ortofoto_1999', 'Orthophoto:Ortofoto_1957',
    'Orthophoto:Orthofoto_1976_1980', 'Orthophoto:Fragment_Durres_1986'
];
assert.deepStrictEqual(
    CONFIG.layers.filter((l) => l.kind === 'wms' && l.layers).map((l) => l.layers).sort(),
    STATIC_WMS.slice().sort(), 'the 18 static WMS names are exact');
assert.deepStrictEqual(
    CONFIG.layers.filter((l) => l.kind === 'wmts').map((l) => l.layers).sort(),
    ['DSM:Dsm_Hill_Group', 'Dtm_2015:Hillshade_2015_group', 'hartat_historike:italiane_100k'],
    'the three tile-only layers are WMTS, never WMS');
assert.deepStrictEqual(
    CONFIG.layers.filter((l) => !l.layers).map((l) => l.resolveTitle),
    ['Cadastral Zone', 'Cadastral Parcels', 'Cadastral Parcels (ASHK)', '25k_krgjsh_1',
     'Water course link', 'Areas Planned by (DCM 347)', 'Mining Hazardous Areas (DCM 726)',
     'Mining Hazardous Areas (DCM 347)', 'Old Mining Areas', 'Mineral Resouces',
     'Mining exploitation permits'],
    'the 11 resolve-by-title entries carry exact portal titles and no guessed name');
check(CONFIG.layers.every((l) => l.section && l.registryGroup && Number.isFinite(l.registryZ)),
    'every definition carries section + registry metadata');
check(CONFIG.layers.every((l) => l.attributionRow.includes('ASIG')), 'each layer credits ASIG');
check(CONFIG.country === 'AL' && CONFIG.attribution.includes('geoportal.asig.gov.al'),
    'attributed to Albania with the ASIG credit line');
check(/unknown/i.test(CONFIG.licence), 'licence stays flagged unknown — never guessed');
check(CONFIG.byId('topo50k') === null && !CONFIG.layers.some((l) => l.layers === 'Topografike:50K_Topografike'),
    'the retired Topo 1:50k row is gone with the exact catalogue');
check(CONFIG.byId('heritage') === null && CONFIG.heritage.id === 'heritage',
    'heritage is the GROUP id, not a tile layer');
assert.deepStrictEqual(CONFIG.heritage.partIds, ['culturalZone', 'cultural', 'natural', 'monument']);
check(CONFIG.heritage.partIds.every((id) => { const d = CONFIG.byId(id); return d && d.panel === false && d.heritagePart === true; }),
    'Heritage parts exist and are never panel rows');
check(CONFIG.heritage.keyword === 'archaeolog|archeolog|arkeolog', 'the archaeology keyword rule is config data');
check(/\[OWNER PLACEHOLDER/.test(CONFIG.heritage.description) && /not a permission map/.test(CONFIG.heritage.description),
    'Heritage info keeps the owner legal-notice placeholder (no detecting rules stated)');
check(CONFIG.byId('mineralResouces').title.en === 'Mineral Resouces',
    "display titles stay verbatim, including the portal's \"Resouces\" spelling");
check(JSON.stringify(CONFIG.countryBounds) === JSON.stringify([[39.538, 18.773], [42.758, 21.179]]),
    'coverage bounds match the owner-supplied footprint');
check(CONFIG.wms.getMapVersion === '1.1.1' && CONFIG.wms.crs === 'EPSG:3857' &&
    CONFIG.wms.fallbackCrs === 'EPSG:4326' && CONFIG.wms.getMapTileSize === 512,
    '2D GetMap shape: WMS 1.1.1 / EPSG:3857 / 512 px with the EPSG:4326 safety net');
check(CONFIG.wmts.tileMatrixSet === 'EPSG:4326' && CONFIG.wmts.maxSourceZoom === 21 &&
    CONFIG.wmts.grid.topLeft[0] === -180 && CONFIG.wmts.grid.topLeft[1] === 90 && CONFIG.wmts.grid.tileSize === 256,
    'WMTS grid matches the owner-supplied capabilities (EPSG:4326:0..21, top-left -180,90)');
check(CONFIG.endpoints.capabilities.wmtsGrids.join() === 'EPSG:6870,EPSG:4326' &&
    CONFIG.endpoints.capabilities.wmtsDefinedButUnlinked.includes('EPSG:900913'),
    'EPSG:900913 is recorded as defined-but-unlinked, not used for GetTile');

/* Catalogue interchange copy stays in lock-step with the config. */
execFileSync(process.execPath, [path.join('tools', 'build-asig-catalogue.mjs'), '--check'],
    { cwd: ROOT, encoding: 'utf8' });
check(true, 'data/asig-catalogue.json is regenerated from the config (--check passes)');

/* Fixtures: the owner excerpt stays untouched; the synthetic one is labelled. */
const ownerFixture = read('test/fixtures/asig-wms-capabilities.xml');
check(/Owner-supplied excerpt; not fetched/.test(ownerFixture), 'owner capabilities excerpt is marked as such');
['akzm:zonat_mbrojtura_081124', 'akzm:monumentet_natyrore_07032023',
 'iktk:zonatembrojturatetrashegimisekulturore22_07_2026', 'Orthophoto:Ortofoto_1999']
    .forEach((name) => check(ownerFixture.includes('<Name>' + name + '</Name>'), 'owner excerpt keeps ' + name));
const synthetic = read('test/fixtures/asig-wms-capabilities.synthetic.xml');
check(/SYNTHETIC test fixture/.test(synthetic) && /NOT an ASIG response/.test(synthetic),
    'the synthetic discovery fixture can never be mistaken for a real ASIG answer');

/* ── 2. Registry mirror: static WMS only, Heritage parts → group controls ── */
const registry = require('./js/layer-registry.js');
const albaniaDefs = registry.list().filter((d) => d.id.startsWith('albania.'));
assert.strictEqual(albaniaDefs.length, 18, 'registry mirrors exactly the 18 static WMS layers');
assert.deepStrictEqual(albaniaDefs.map((d) => d.layer).sort(), STATIC_WMS.slice().sort());
check(!registry.get('albania.lidar') && !registry.get('albania.dsm') && !registry.get('albania.italiane100k'),
    'WMTS-only layers are not mirrored in the WMS registry');
check(!registry.get('albania.cadastralZone') && !registry.get('albania.topo50k'),
    'resolve-by-title and retired layers are not mirrored either');
CONFIG.heritage.partIds.forEach((id) => {
    const def = registry.get('albania.' + id);
    check(def && def.ui.toggle === 'albaniaToggle_heritage' && def.ui.slider === 'albaniaOpacity_heritage' &&
        def.ui.pct === 'albaniaPct_heritage' && def.ui.partOf === 'heritage',
        id + ' is driven by the single Heritage controls');
});
albaniaDefs.forEach((def) => {
    check(JSON.stringify(def.countries) === JSON.stringify(['AL']) && def.guard === false &&
        def.selfGuarded === true && !!def.selfGuardedReason,
        def.id + ' is Albania-only and self-guarded');
});
check(!registry.GROUPS['albania-raster'] && !registry.GROUPS['albania-overlay'], 'no legacy Albania registry groups');
check(/'geoportal\.asig\.gov\.al':/.test(read('js/wms-health.js')), 'ASIG host stays in the health host list');

/* ── 3. Placement + cache tags in the shell ── */
const html = read('index.html');
['asigHistoricalLayers', 'asigSatelliteLayers', 'asigLidarLayers', 'asigHeritageLayers'].forEach((id) => {
    check(!html.includes('id="' + id + '"'), id + ' (old per-section mount) is gone');
});
['albaniaRow', 'albaniaSubLayers', 'albaniaLayerSearch', 'albaniaToggle', 'albaniaGroupTitle', 'albaniaExpandBtn']
    .forEach((id) => check(html.includes('id="' + id + '"'), 'the Albania group carries #' + id));
check(/<div class="transp-layer-row albania-out-of-country" data-category="free" id="albaniaRow">/.test(html),
    'the group ships hidden so it never flashes outside the Albania view');
const rowAt = html.indexOf('id="albaniaRow"');
const searchAt = html.indexOf('id="albaniaLayerSearch"');
const mountAt = html.indexOf('id="albaniaSubLayers"');
const danishAt = html.indexOf('id="danishRow"');
check(rowAt > 0 && searchAt > rowAt && mountAt > searchAt && danishAt > mountAt,
    'search sits inside the group, before the generated mount, Denmark after');
check(/#albaniaRow\.albania-out-of-country\s*\{[\s\S]*?display:\s*none\s*!important/.test(read('css/styles.css')),
    'styles.css hides the group outside the Albania view');
['.albania-section {', '.albania-section-rows', '.albania-layer-search', '.albania-layer-move',
 '.albania-group-tools', '.albania-group-status', '.asig-fi {']
    .forEach((sel) => check(read('css/styles.css').includes(sel), 'styles.css covers ' + sel));
const TAG = '20261024-asig-catalogue';
['css/styles.css', 'js/asig-albania-layers.config.js', 'js/asig-albania-layers.js', 'js/layer-registry.js']
    .forEach((asset) => check(html.includes(asset + '?v=' + TAG), 'index loads ' + asset + ' with the catalogue tag'));
const sw = read('sw.js');
check(/const CACHE_NAME = 'detectlab-v258-asig-catalogue'/.test(sw), 'service worker cache is v258');
['css/styles.css', 'js/asig-albania-layers.config.js', 'js/asig-albania-layers.js', 'js/layer-registry.js']
    .forEach((asset) => check(sw.includes("'" + asset + '?v=' + TAG + "'"), 'sw precaches ' + asset));
const mapApp = read('js/map-app.js');
check(/AsigAlbaniaLayers[\s\S]{0,300}?filterForCountry\(iso\)/.test(mapApp) &&
    /AsigAlbaniaLayers[\s\S]{0,300}?filterForCountry\(null\)/.test(mapApp),
    'map-app drives the Albania gate on selection and on exit');

/* ── 4. Runtime harness (tiny DOM/Leaflet) ── */
class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {};
        this.listeners = {}; this.className = ''; this.textContent = ''; this.value = '';
        this.checked = false; this.disabled = false; this.dataset = {};
        this.naturalWidth = 0; this.naturalHeight = 0; this.classes = new Set();
        this.classList = {
            toggle: (name, on) => { on ? this.classes.add(name) : this.classes.delete(name); },
            add: (name) => { this.classes.add(name); },
            remove: (name) => { this.classes.delete(name); },
            contains: (name) => this.classes.has(name)
        };
    }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'value') this.value = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; }
    contains(node) { if (node === this) return true; return this.children.some((c) => c.contains(node)); }
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); }
    click() {}
    set innerHTML(value) { if (value === '') this.children = []; }
    get innerHTML() { return ''; }
}
const elements = {
    albaniaRow: new Element('div'),
    albaniaSubLayers: new Element('div'),
    albaniaLayerSearch: new Element('input'),
    albaniaToggle: new Element('input'),
    albaniaExpandBtn: new Element('button'),
    albaniaExpandIcon: new Element('svg')
};
/* A stale app shell: pre-group mounts inside other countries' sections. */
const staleSection = new Element('div'); staleSection.id = 'asigSatelliteLayers';
const staleHeritage = new Element('div'); staleHeritage.id = 'asigHeritageLayers';
const strayRow = new Element('div'); strayRow.setAttribute('data-albania-row', 'ortho1999');
const romanianSatellite = new Element('div');
romanianSatellite.appendChild(staleSection); romanianSatellite.appendChild(strayRow);
const romanianHeritage = new Element('div');
romanianHeritage.appendChild(staleHeritage); romanianHeritage.appendChild(new Element('div'));
elements.asigSatelliteLayers = staleSection;
elements.asigHeritageLayers = staleHeritage;
elements.romanianSatelliteSection = romanianSatellite;
elements.romanianHeritageSection = romanianHeritage;
const documentMock = {
    readyState: 'loading', documentElement: { getAttribute: () => 'en' }, listeners: {},
    createElement: (tag) => new Element(tag),
    getElementById: (id) => elements[id] || null,
    addEventListener(type, cb) { (this.listeners[type] ||= []).push(cb); },
    querySelectorAll(selector) {
        if (selector !== '[data-albania-row]') return [];
        const found = []; const seen = new Set();
        const walk = (node) => (node.children || []).forEach((child) => {
            if (seen.has(child)) return; seen.add(child);
            if (child.attributes['data-albania-row'] !== undefined) found.push(child);
            walk(child);
        });
        Object.keys(elements).forEach((key) => walk(elements[key]));
        return found;
    }
};
function BaseLayer() {}
BaseLayer.prototype.initialize = function (_url, options) { this.options = Object.assign({}, this.options || {}, options || {}); };
BaseLayer.prototype.on = function () { return this; };
BaseLayer.prototype.off = function () { return this; };
BaseLayer.prototype.onAdd = function () {};
BaseLayer.prototype.onRemove = function () {};
BaseLayer.prototype.setOpacity = function (v) { this.opacity = v; };
BaseLayer.prototype.setZIndex = function (z) { this.zIndex = z; };
BaseLayer.prototype.redraw = function () { this.redrawn = true; };
BaseLayer.prototype._tileCoordsToBounds = function () {
    return { getSouthWest: () => ({ lat: 41.2, lng: 19.7 }), getNorthEast: () => ({ lat: 41.4, lng: 19.9 }) };
};
BaseLayer.prototype.getTileSize = function () { return { x: 512, y: 512 }; };
BaseLayer.extend = function (props) {
    function Child() { if (this.initialize) this.initialize.apply(this, arguments); }
    Child.prototype = Object.create(BaseLayer.prototype);
    Object.assign(Child.prototype, props); Child.extend = BaseLayer.extend; return Child;
};
function GridBase() {}
GridBase.prototype.initialize = function (options) { this.options = Object.assign({}, options || {}); };
GridBase.prototype.on = BaseLayer.prototype.on;
GridBase.prototype.off = BaseLayer.prototype.off;
GridBase.prototype.onAdd = function () {};
GridBase.prototype.onRemove = function () {};
GridBase.prototype.setOpacity = BaseLayer.prototype.setOpacity;
GridBase.prototype.setZIndex = BaseLayer.prototype.setZIndex;
GridBase.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
GridBase.extend = function (props) {
    function Child() { if (this.initialize) this.initialize.apply(this, arguments); }
    Child.prototype = Object.create(GridBase.prototype);
    Object.assign(Child.prototype, props); Child.extend = GridBase.extend; return Child;
};
const warnings = [];
const map = {
    options: { crs: { project: (ll) => ({ x: ll.lng * 1000, y: ll.lat * 1000 }) } },
    panes: {}, layers: new Set(),
    createPane(id) { return this.panes[id] = { style: {} }; }, getPane(id) { return this.panes[id]; },
    hasLayer(layer) { return this.layers.has(layer); }, addLayer(layer) { this.layers.add(layer); },
    removeLayer(layer) { this.layers.delete(layer); }, setView(center, zoom) { this.view = { center, zoom }; },
    on() { return this; }
};
const sandbox = {
    console: { warn: (...args) => warnings.push(args.join(' ')), info() {}, log() {} },
    document: documentMock,
    L: {
        TileLayer: BaseLayer, GridLayer: GridBase,
        setOptions: (obj, opts) => { obj.options = Object.assign({}, obj.options, opts); return obj.options; },
        latLngBounds: (b) => b,
        CRS: { EPSG3857: { project: (ll) => ({ x: ll.lng * 1000, y: ll.lat * 1000 }) } }
    },
    _dlMap: map,
    localStorage: {
        data: {
            /* v1 state from the nine-row module: folds into Heritage, topo50k dropped. */
            detectlab_albania_layers_v1: JSON.stringify({
                active: { natural: true, topo50k: true, ortho1999: true },
                opacity: { natural: 44, ortho1999: 61 }
            })
        },
        getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; }
    },
    setInterval, clearInterval, alert() {}, showLayerInfo() {}, _currentLang: () => 'en'
};
sandbox.window = sandbox;
sandbox.ASIG_ALBANIA_CONFIG = CONFIG;
vm.createContext(sandbox);
vm.runInContext(read('js/asig-albania-layers.js'), sandbox, { filename: 'js/asig-albania-layers.js' });
const API = sandbox.AsigAlbaniaLayers;
API.init();
const mount = elements.albaniaSubLayers;

/* placement sweep */
check(API.state.swept >= 3, 'the sweep removes legacy mounts and stray rows at startup');
check(!romanianSatellite.children.includes(staleSection) && !romanianSatellite.children.includes(strayRow) &&
    !romanianHeritage.children.includes(staleHeritage),
    'nothing Albanian remains inside another country\'s section');

/* panel structure: 7 sections, 29 rows, Heritage parts never rows */
const sectionWrappers = mount.children.filter((c) => c.className === 'albania-section');
assert.strictEqual(sectionWrappers.length, 7, 'seven collapsible catalogue sections');
assert.strictEqual(Object.keys(API.state.rows).length, 29, 'exactly Heritage + 28 rows');
CONFIG.heritage.partIds.forEach((id) => check(!API.state.rows[id], id + ' has no panel row (Heritage part)'));
const heritageRow = API.state.rows.heritage;
check(heritageRow && heritageRow.input && heritageRow.slider && heritageRow.moveUp && heritageRow.moveDown,
    'Heritage has the one toggle/slider/reorder pair');
check(heritageRow.meta.textContent === '4 parts', 'Heritage row reports its four static parts');
check(API.state.rows.cadastralZone.input.disabled === true && API.state.rows.ortho1999.input.disabled === false,
    'resolve-by-title rows start disabled; named rows are usable immediately');
check(API.state.rows.cadastralZone.status.textContent.length > 0,
    'an unresolved row explains itself instead of guessing a name');

/* v1 → v2 migration */
check(API.isActive('heritage') && API.state.opacity.heritage === 44,
    'v1 heritage rows fold into the one Heritage toggle with their opacity');
check(API.isActive('ortho1999') && API.state.opacity.ortho1999 === 61 && !API.panelIds().includes('topo50k'),
    'v1 rows that still exist keep their state; topo50k is dropped');

/* country gate */
check(API.isInCountry() === false && elements.albaniaRow.classes.has('albania-out-of-country') && map.layers.size === 0,
    'global view: group hidden, remembered layers parked (nothing drawn)');
API.filterForCountry('AL');
check(API.isInCountry() === true && !elements.albaniaRow.classes.has('albania-out-of-country'),
    'selecting Albania shows the group');
check(map.layers.size === 5, 'remembered state draws: 4 Heritage parts + Orthophoto 1999');
[['RO', 'Romania'], ['DK', 'Denmark'], ['FI', 'Finland'], ['IT', 'Italy']].forEach(([iso, label]) => {
    API.filterForCountry(iso);
    check(API.isInCountry() === false && map.layers.size === 0 &&
        Object.values(API.state.rows).every((r) => r.row.classes.has('country-layer-unavailable')),
        label + ': group hidden, rows unavailable, nothing drawn');
});
API.filterForCountry('AL');
check(map.layers.size === 5 && API.isActive('heritage'), 'returning to Albania restores the parked layers');

/* Heritage parts obey the one control, even via legacy part ids */
API.setOpacity('natural', 33);
check(API.state.opacity.heritage === 33 &&
    (API.state.built.heritage || []).every((l) => l.opacity === 0.33),
    'one opacity drives every Heritage part (legacy part ids resolve to the group)');

/* search + section collapse + group expander */
API.setSearch('cadastral');
check(API.state.rows.cadastralZone.row.style.display === '' &&
    API.state.rows.ortho1999.row.style.display === 'none' &&
    API.state.sections.orthophotos.wrapper.style.display === 'none' &&
    API.state.sections.cadastre.wrapper.style.display === '',
    'search filters rows and hides empty sections');
API.setSearch('');
check(API.state.rows.ortho1999.row.style.display === '', 'clearing the search restores every row');
API.toggleSection('orthophotos');
check(API.state.sections.orthophotos.rows.style.display === 'none' &&
    API.state.sections.orthophotos.header.attributes['aria-expanded'] === 'false',
    'section toggles collapse with aria-expanded');
API.toggleSection('orthophotos');
API.toggleExpanded();
check(API.state.expanded === false && mount.style.maxHeight === '0px', 'the group expander collapses the mount');
API.toggleExpanded();
check(API.state.expanded === true && mount.style.maxHeight === '8000px', 'the group expander reopens it');

/* active-stack reordering (z-order inside the one catalogue pane) */
check(JSON.stringify(API.stackOrder()) === '["heritage","ortho1999"]', 'remembered stack restores in panel order');
check(API.moveInStack('heritage', 1) === true, 'move up swaps the stack order');
check(JSON.stringify(API.stackOrder()) === '["ortho1999","heritage"]', 'the swap sticks');
check((API.state.built.heritage || []).every((l) => l.zIndex === 11), 'Heritage parts share the moved z-index');
check(API.moveInStack('heritage', 1) === false, 'the top entry cannot move above itself');
API.moveInStack('heritage', -1);

/* ── 5. Request construction ── */
const u1 = new URL(API.tileUrl('ortho1999', [2000000, 4700000, 2300000, 5300000], 512, 'EPSG:3857'));
check(u1.origin === 'https://geoportal.asig.gov.al' && u1.pathname === '/service/Orthophoto/wms',
    'per-workspace endpoint is tried first, direct from the browser (no proxy)');
check(u1.searchParams.get('VERSION') === '1.1.1' && u1.searchParams.get('SRS') === 'EPSG:3857' &&
    u1.searchParams.get('LAYERS') === 'Orthophoto:Ortofoto_1999' && u1.searchParams.get('STYLES') === '' &&
    u1.searchParams.get('FORMAT') === 'image/png' && u1.searchParams.get('TRANSPARENT') === 'TRUE',
    'GetMap carries the prototype shape');
check(u1.searchParams.get('BBOX') === '2000000,4700000,2300000,5300000',
    'intersecting tiles keep their FULL bbox (no clipped-bbox stretching)');
check(API.tileUrl('ortho1999', [0, 0, 1000, 1000], 512, 'EPSG:3857').startsWith('data:image/png'),
    'tiles outside the ASIG footprint answer the blank pixel, not a request');
const u2 = new URL(API.tileUrl('natural', [19, 41, 20, 42], 512, 'EPSG:4326'));
check(u2.searchParams.get('SRS') === 'EPSG:4326' && u2.searchParams.get('BBOX') === '19,41,20,42',
    'the 1.1.1 EPSG:4326 safety net keeps lon/lat order');
check(JSON.stringify(API.endpointsFor('Orthophoto:Ortofoto_1999')) ===
    '["https://geoportal.asig.gov.al/service/Orthophoto/wms","https://geoportal.asig.gov.al/service/wms"]',
    'endpoint order: workspace, then global');
assert.throws(() => API.tileUrl('lidar', [0, 0, 1, 1], 256, 'EPSG:3857'), /tile-only \(WMTS\)/,
    'a WMTS-only layer refuses to build a WMS URL');
assert.throws(() => API.tileUrl('cadastralZone', [19, 41, 20, 42], 256, 'EPSG:4326'), /Unresolved/,
    'an unresolved title refuses to build a request under a guessed name');
const wu = new URL(API.wmtsTileUrl('italiane100k', 12, 4546, 1108));
check(wu.pathname === '/service/wmts' && wu.searchParams.get('layer') === 'hartat_historike:italiane_100k' &&
    wu.searchParams.get('tilematrixset') === 'EPSG:4326' && wu.searchParams.get('TileMatrix') === 'EPSG:4326:12' &&
    wu.searchParams.get('TileCol') === '4546' && wu.searchParams.get('TileRow') === '1108' &&
    wu.searchParams.get('Format') === 'image/png',
    'WMTS GetTile uses the EPSG:4326 grid the layer actually links');
const plan = API.planTile(12, 2273, 1530, 256, 21);
check(plan.z === 12 && plan.cols.length === 2 && plan.cols[0].c === 4546 && plan.cols[1].c === 4547 &&
    plan.rows.length === 256 && plan.rows[0].r >= 1000 && plan.rows[0].r <= 1200,
    'planTile maps the Tirana Mercator tile onto the EPSG:4326 matrix (width 2^(z+1))');
check(API.planTile(25, 0, 0, 256, 21).z === 21, 'planTile caps the source level at the grid maximum (21)');

/* WMS fallback chain on a fresh layer: workspace → global → EPSG:4326 → status */
const fresh = new API.Layer(CONFIG.byId('ortho1957'), {});
const warnBefore = warnings.length;
fresh._onTileError({ tile: { src: 'https://example.invalid/bad1' } });
fresh._onTileError({ tile: { src: 'https://example.invalid/bad2' } });
check(fresh._endpointIndex === 1 && fresh.redrawn === true &&
    API.state.rows.ortho1957.status.textContent === API.TEXT.en.retrying,
    'two failures retry through the alternate endpoint and say so');
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) fresh._onTileError({ tile: { src: 'https://example.invalid/bad' } });
check(fresh.options.crs === 'EPSG:4326', 'a full error burst then falls back to EPSG:4326');
for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) fresh._onTileError({ tile: { src: 'https://example.invalid/bad' } });
check(API.state.rows.ortho1957.status.textContent === API.TEXT.en.unavailable,
    'persistent failure lands as a visible row status');
check(warnings.length === warnBefore + 1, 'console noise stays at one warning per layer');
let tileError = false;
const failedTile = fresh.createTile({ x: 2273, y: 1530, z: 12 }, (err) => { tileError = !!err; });
failedTile.naturalWidth = 0; failedTile.naturalHeight = 0; failedTile.onload();
check(tileError, 'an HTTP-200 XML/HTML body (zero-size image) is a tile error, never a silent success');

/* master switch covers renderable entries only */
API.toggleAll(true);
check(API.stackOrder().length === 18 && map.layers.size === 21,
    'all on: Heritage(4) + 14 orthophotos + 3 WMTS layers; unresolved entries stay off');
check(!API.isActive('cadastralZone'), 'unresolved entries cannot be switched on');
API.toggleAll(false);
check(map.layers.size === 0 && API.stackOrder().length === 0, 'all off clears the map and the stack');

/* ── 6. Discovery against the synthetic capabilities ── */
const result = API.ingestCapabilities(synthetic);
check(result.resolved.cadastralZone === 'synthetic:zone_kadastrale' &&
    result.resolved.topo25k === 'synthetic:25k_krgjsh_1',
    'unique Titles resolve; 25k_krgjsh_1 resolves through the local-Name fallback');
check(Object.keys(result.resolved).length === 9, 'nine of eleven titles resolve from the fixture');
check(result.ambiguous.length === 1 && result.ambiguous[0].id === 'waterCourseLink' &&
    result.ambiguous[0].names.join() === 'synthetic:rruga_ujore_a,synthetic:rruga_ujore_b',
    'a duplicated Title is ambiguous — candidates kept, nothing guessed');
check(JSON.stringify(result.missing) === '["Mining Hazardous Areas (DCM 347)"]', 'an absent Title is reported missing');
check(result.heritageMatches.length === 2 && API.heritageParts().length === 6,
    'archaeology keyword matches join Heritage as parts (still no panel rows)');
check(API.state.rows.cadastralZone.input.disabled === false &&
    API.state.rows.waterCourseLink.input.disabled === true &&
    /synthetic:rruga_ujore_a/.test(API.state.rows.waterCourseLink.status.textContent),
    'resolved rows enable; the ambiguous row stays off and names its candidates');
const u3 = new URL(API.tileUrl('cadastralZone', [2000000, 4700000, 2300000, 5300000], 512, 'EPSG:3857'));
check(u3.searchParams.get('LAYERS') === 'synthetic:zone_kadastrale' && u3.pathname === '/service/synthetic/wms',
    'a resolved row requests its exact discovered name on its workspace endpoint');

/* feature-info grouping: every active WMS leaf, Heritage parts included */
API.toggle('heritage', true); API.toggle('ortho1999', true);
const groups = API.featureInfoGroups();
const fiNames = groups.flatMap((g) => g.leaves.map((l) => l.name));
check(groups.length === 4 && fiNames.includes('akzm:zonat_mbrojtura_081124') &&
    fiNames.includes('iktk:zonatembrojturatetrashegimisekulturore22_07_2026') &&
    fiNames.includes('synthetic:zona_arkeologjike_a') && fiNames.includes('Orthophoto:Ortofoto_1999'),
    'clicks query all active WMS leaves (Heritage parts included), grouped by endpoint');
const fi = new URL(API.featureInfoUrl(groups[0].url, groups[0].leaves.map((l) => l.name), [1, 2, 3, 4], { x: 800, y: 600 }, { x: 10, y: 11 }));
check(fi.searchParams.get('request') === 'GetFeatureInfo' && fi.searchParams.get('version') === '1.1.1' &&
    fi.searchParams.get('srs') === 'EPSG:3857' && fi.searchParams.get('info_format') === 'text/html',
    'feature-info uses the 1.1.1 shape with text/html');
API.toggleAll(false);

/* late stray sweep on rebuild */
const lateStray = new Element('div'); lateStray.setAttribute('data-albania-row', 'dsm');
romanianSatellite.appendChild(lateStray);
API.refreshTexts();
check(!romanianSatellite.children.includes(lateStray) && Object.keys(API.state.rows).length === 29,
    'a late row outside the group is swept; the group still holds exactly 29 entries');

console.log(`[ASIG] ${checks} checks passed (offline only; no production request made).`);
