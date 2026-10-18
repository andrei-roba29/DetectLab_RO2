/*
 * test-albania-asig-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * Test suite for the Albanian layers (ASIG geoportal, geoportal.asig.gov.al):
 *   1. the CONFIG contract (js/asig-albania-layers.config.js) — nine layers
 *      (five raster overlays as independent checkboxes + the four “Protected
 *      Sites” children), the exact LAYERS names from the ASIG catalogue
 *      (snapshot dates included), formats/transparency, the LiDAR hillshade
 *      at 50% and the draw order (protected sites always on top);
 *   2. the WMS request builder — WMS 1.1.1 GetMap per Leaflet tile in
 *      EPSG:3857 (SRS, not CRS), the EPSG:4326 lon/lat fallback, JPEG only
 *      for the 20 cm orthophoto;
 *   3. the shared registry mirror (js/layer-registry.js) — the same layers in
 *      the catalogue the diagnostics, the 3D status report and the offline
 *      audit read, with a documented guard opt-out;
 *   4. the map module (js/asig-albania-layers.js) in a stub DOM + Leaflet —
 *      rows built from the config, stacking checkboxes, per-row opacity, the
 *      collapsible Protected Sites group, the master switch, the CRS fallback
 *      after repeated tile errors and the country filter;
 *   5. the wiring — index.html (row, container, script order), css/styles.css,
 *      sw.js and the country-filter hooks in js/map-app.js.
 *
 * No network, no npm dependencies, no browser. Usage: node test-albania-asig-layers.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Albanian layers (ASIG geoportal): config, WMS builder, registry, map module…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const CONFIG = require('./js/asig-albania-layers.config.js');

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

const RASTER_IDS = ['topo50k', 'ortho1999', 'ortho1994', 'dsm', 'lidar'];
const PROTECTED_IDS = ['heritage', 'natural', 'cultural', 'monument'];
const ALL_IDS = RASTER_IDS.concat(PROTECTED_IDS);

/* The exact LAYERS values published by ASIG (integration brief §2); the four
   protected names carry publication snapshot dates. */
const EXPECTED_LAYERS = {
    topo50k: 'Topografike:50K_Topografike',
    ortho1999: 'Orthophoto:Ortofoto_1999',
    ortho1994: 'orthophoto_2015:OrthoImagery_20cm',
    dsm: 'DSM:Dsm_Hill_Group',
    lidar: 'Dtm_2015:Hillshade_2015_group',
    heritage: 'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
    natural: 'akzm:zonat_mbrojtura_081124',
    cultural: 'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
    monument: 'akzm:monumentet_natyrore_07032023'
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. the config
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert.strictEqual(CONFIG.country, 'AL', 'the group belongs to Albania');
    assert.deepStrictEqual(CONFIG.countryBounds, [[39.538, 18.773], [42.758, 21.179]],
        'the coverage is all of Albania');
    assert.strictEqual(CONFIG.enabledLayers().length, 9, 'nine layers are configured and enabled');
    assert.deepStrictEqual(CONFIG.enabledLayers().map((l) => l.id), ALL_IDS,
        'the nine layers, raster rows first, then the Protected Sites');
    assert.deepStrictEqual(CONFIG.enabledLayers().filter((l) => l.group === 'raster').map((l) => l.id), RASTER_IDS);
    assert.deepStrictEqual(CONFIG.enabledLayers().filter((l) => l.group === 'protected').map((l) => l.id), PROTECTED_IDS);
    ok('nine layers: five raster + the four-child “Protected Sites” toggle group');

    const FIELDS = ['id', 'title', 'group', 'layers', 'format', 'transparent', 'opacity',
        'order', 'minZoom', 'maxNativeZoom', 'defaultOn', 'attributionRow', 'description', 'notes'];
    const seen = {};
    CONFIG.layers.forEach((layer) => {
        FIELDS.forEach((field) => assert.ok(Object.prototype.hasOwnProperty.call(layer, field),
            layer.id + ' is missing ' + field));
        assert.ok(!seen[layer.id], layer.id + ' is unique');
        seen[layer.id] = true;
        assert.ok(layer.title.ro && layer.title.en, layer.id + ' has a RO and an EN title');
        assert.ok(layer.attributionRow.indexOf('ASIG') !== -1, layer.id + ' credits ASIG');
        assert.strictEqual(layer.layers, EXPECTED_LAYERS[layer.id],
            layer.id + ' carries the exact ASIG LAYERS value');
        assert.ok(layer.minZoom < layer.maxNativeZoom, layer.id + ' zoom range');
        assert.ok(layer.opacity >= 0 && layer.opacity <= 1, layer.id + ' opacity');
    });
    ok('every entry carries the full documented field set (RO+EN title, attribution…)');

    /* The exact published LAYERS strings, verbatim (snapshot dates included). */
    Object.keys(EXPECTED_LAYERS).forEach((id) => assert.strictEqual(CONFIG.byId(id).layers, EXPECTED_LAYERS[id]));
    ok('the ASIG LAYERS names match the catalogue, snapshot dates included');

    /* Formats / transparency per product (brief §2): JPEG only where the
       product is JPEG-only; hillshades and the vector overlays transparent. */
    assert.strictEqual(CONFIG.byId('ortho1994').format, 'image/jpeg', 'the 20 cm orthophoto is JPEG-only');
    ['topo50k', 'ortho1999', 'dsm', 'lidar', 'heritage', 'natural', 'cultural', 'monument'].forEach((id) =>
        assert.strictEqual(CONFIG.byId(id).format, 'image/png', id + ' is PNG'));
    ['dsm', 'lidar', 'heritage', 'natural', 'cultural', 'monument'].forEach((id) =>
        assert.strictEqual(CONFIG.byId(id).transparent, true, id + ' is transparent'));
    ['topo50k', 'ortho1999', 'ortho1994'].forEach((id) =>
        assert.strictEqual(CONFIG.byId(id).transparent, false, id + ' is opaque'));
    ok('JPEG only where the product is JPEG-only; hillshades + vector overlays transparent');

    /* Draw order, bottom → top (brief §3): topographic, orthophotos, DSM,
       LiDAR hillshade (≈50 %), then the Protected Sites. */
    const order = CONFIG.drawOrder().map((l) => l.id);
    assert.deepStrictEqual(order, ALL_IDS, 'draw order bottom → top');
    const orders = CONFIG.enabledLayers().map((l) => l.order);
    assert.deepStrictEqual(orders, orders.slice().sort((a, b) => a - b), 'order strictly increasing');
    CONFIG.enabledLayers().filter((l) => l.group === 'protected').forEach((l) => {
        CONFIG.enabledLayers().filter((r) => r.group === 'raster').forEach((r) => {
            assert.ok(l.order > r.order, l.id + ' draws above ' + r.id);
        });
    });
    assert.strictEqual(CONFIG.byId('lidar').opacity, 0.5, 'the LiDAR hillshade starts at 50 %');
    ok('draw order: topo < orthophotos < DSM < LiDAR (50 %) < Protected Sites');

    /* The user-confirmed labels: “LiDAR” (a DTM 2015 hillshade, labelled as
       briefed) and “Orthophoto 1994” (label kept per the owner; the product
       is the 2015 20 cm orthophoto). */
    assert.strictEqual(CONFIG.byId('lidar').title.en, 'LiDAR');
    assert.ok(/hillshade/i.test(CONFIG.byId('lidar').description), 'the LiDAR info says it is a DTM hillshade');
    assert.strictEqual(CONFIG.byId('ortho1994').title.en, 'Orthophoto 1994');
    assert.ok(CONFIG.byId('ortho1994').description.indexOf('orthophoto_2015:OrthoImagery_20cm') !== -1,
        'the info popup names the real ASIG product behind the 1994 label');
    ok('labels follow the brief (LiDAR, Orthophoto 1994); the info popup keeps the data provenance');

    /* Endpoints and request defaults. */
    assert.ok(/^https:\/\//.test(CONFIG.wms.url), 'the WMS endpoint is HTTPS');
    assert.strictEqual(CONFIG.wms.url, 'https://geoportal.asig.gov.al/service/wms');
    assert.strictEqual(CONFIG.wms.version, '1.1.1', 'WMS 1.1.1, as captured from the portal');
    assert.strictEqual(CONFIG.wms.crs, 'EPSG:3857', 'Web Mercator first');
    assert.strictEqual(CONFIG.wms.fallbackCrs, 'EPSG:4326', 'EPSG:4326 fallback');
    assert.strictEqual(CONFIG.endpoints.nativeCrs, 'EPSG:6870', 'the native CRS is documented');
    assert.ok(CONFIG.endpoints.capabilities.wms.indexOf('geoportal.asig.gov.al') !== -1,
        'the capabilities URL to re-check the dated layer names is one constant away');
    assert.ok(CONFIG.attribution.indexOf('geoportal.asig.gov.al') !== -1, 'the attribution links the portal');
    ok('endpoints, EPSG:3857-first strategy, fallback and attribution are configured');

    const defaults = CONFIG.enabledLayers().filter((l) => l.defaultOn);
    assert.deepStrictEqual(defaults.map((l) => l.id), ['lidar'], 'the master switch starts the LiDAR hillshade');
    ok('exactly one default layer (LiDAR) for the master switch');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. the WMS request builder (pure)
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* The builder lives in the map module; the sandbox below gives it the
       stubs it needs and exposes the pure function through API._test. */
    const sandbox = moduleSandbox();
    vm.createContext(sandbox);
    vm.runInContext(read('js/asig-albania-layers.js'), sandbox, { filename: 'js/asig-albania-layers.js' });
    const API = sandbox.AsigAlbaniaLayers;
    const tileUrl = API._test.tileUrl;

    const bbox3857 = [2225000.12345, 4960000.6789, 2230000.00005, 4965000.54321];
    const url = tileUrl('lidar', bbox3857, 256, 'EPSG:3857');
    assert.ok(url.indexOf('https://geoportal.asig.gov.al/service/wms?') === 0, 'the ASIG WMS endpoint');
    assert.ok(/SERVICE=WMS/.test(url), 'SERVICE=WMS');
    assert.ok(/VERSION=1\.1\.1/.test(url), 'VERSION=1.1.1');
    assert.ok(/REQUEST=GetMap/.test(url), 'GetMap');
    assert.ok(/LAYERS=Dtm_2015%3AHillshade_2015_group/.test(url), 'LAYERS, URL-encoded');
    assert.ok(/SRS=EPSG%3A3857/.test(url), 'WMS 1.1.1 → SRS, never CRS');
    assert.ok(url.indexOf('CRS=') === -1, 'no CRS parameter on a 1.1.1 request');
    assert.ok(/BBOX=2225000\.1235,4960000\.6789|BBOX=2225000\.1235,4960000\.6789/.test(url) ||
        /BBOX=2225000\.1235,4960000\.6789,2230000,4965000\.5432/.test(url),
        'the mercator bbox, minx,miny,maxx,maxy, 4-decimal rounding');
    assert.ok(/WIDTH=256&HEIGHT=256/.test(url), 'one 256 px tile');
    assert.ok(/FORMAT=image%2Fpng/.test(url), 'PNG for the hillshade');
    assert.ok(/TRANSPARENT=TRUE/.test(url), 'the hillshade is transparent');
    assert.ok(/STYLES=(&|$)/.test(url), 'an empty STYLES (the portal sends style=default only for WMTS)');
    ok('WMS 1.1.1 GetMap in EPSG:3857: SRS, LAYERS, bbox order, FORMAT, TRANSPARENT');

    const ortho = tileUrl('ortho1994', bbox3857, 256, 'EPSG:3857');
    assert.ok(/LAYERS=orthophoto_2015%3AOrthoImagery_20cm/.test(ortho), 'the 20 cm orthophoto layer');
    assert.ok(/FORMAT=image%2Fjpeg/.test(ortho), 'JPEG is requested for the JPEG-only product');
    assert.ok(/TRANSPARENT=FALSE/.test(ortho), 'an opaque basemap-style raster is not transparent');
    ok('the orthophoto product requests image/jpeg with TRANSPARENT=FALSE');

    const heritage = tileUrl('heritage', bbox3857, 256, 'EPSG:3857');
    assert.ok(/LAYERS=iktk%3Azonatembrojturatetrashegimisekulturore22_07_2026/.test(heritage),
        'the dated snapshot name is sent verbatim');
    assert.ok(/TRANSPARENT=TRUE/.test(heritage), 'protected-sites overlay is transparent');
    ok('the protected-sites request carries the snapshot name and transparency');

    const deg = tileUrl('natural', [19.123456789, 41.123456789, 19.623456789, 41.623456789], 256, 'EPSG:4326');
    assert.ok(/SRS=EPSG%3A4326/.test(deg), 'the fallback asks for EPSG:4326');
    assert.ok(/BBOX=19\.1234568,41\.1234568,19\.6234568,41\.6234568/.test(deg),
        '1.1.1 + EPSG:4326 keeps lon,lat axis order (7 decimals)');
    ok('the EPSG:4326 fallback keeps lon,lat axis order (WMS 1.1.1)');

    assert.throws(() => tileUrl('nope', bbox3857, 256, 'EPSG:3857'), /unknown layer id/,
        'an unknown id fails loudly instead of producing a bogus request');
    ok('the builder guards against unknown layer ids');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. the shared registry mirror
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* Node: the registry require()s the config itself (the browser loads it
       as a plain script first). */
    const R = require('./js/layer-registry.js');
    assert.ok(R.GROUPS['albania-raster'], 'the albania-raster group exists');
    assert.ok(R.GROUPS['albania-overlay'], 'the albania-overlay group exists');
    assert.ok(R.GROUPS['albania-overlay'].z > R.GROUPS['albania-raster'].z,
        'protected sites draw above the Albanian rasters');
    ok('the registry has the albania-raster (405) and albania-overlay (407) groups');

    ALL_IDS.forEach((id) => {
        const def = R.get('albania.' + id);
        const layer = CONFIG.byId(id);
        assert.ok(def, 'albania.' + id + ' is in the catalogue');
        assert.strictEqual(def.kind, 'wms', id + ' is a WMS layer');
        assert.strictEqual(def.layer, layer.layers, id + ' LAYERS');
        assert.strictEqual(def.format, layer.format, id + ' FORMAT');
        assert.strictEqual(def.transparent, layer.transparent, id + ' TRANSPARENT');
        assert.strictEqual(def.version, '1.1.1', id + ' WMS 1.1.1');
        assert.strictEqual(def.crs, 'EPSG:3857', id + ' EPSG:3857');
        assert.strictEqual(def.group, layer.group === 'protected' ? 'albania-overlay' : 'albania-raster',
            id + ' group');
        assert.strictEqual(def.guard, false, id + ' opts out of the global guard…');
        assert.ok(def.selfGuarded && /asig-albania-layers\.js/.test(def.selfGuardedReason),
            '…and says who owns the failures instead');
        assert.strictEqual(def.ui.toggle, 'albaniaToggle_' + id, id + ' toggle id');
        assert.strictEqual(def.ui.slider, 'albaniaOpacity_' + id, id + ' slider id');
        assert.ok(/^https:\/\//.test(def.url), id + ' HTTPS endpoint');
        assert.deepStrictEqual(def.bounds, CONFIG.countryBounds, id + ' bounded to Albania');
    });
    ok('all nine layers are mirrored with kind/version/CRS/ui/attribution and a documented guard opt-out');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. the map module, in a stub DOM + Leaflet
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const dom = buildDom();
    const map = buildMap();
    const leaflet = buildLeaflet();

    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        document: dom.document,
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: () => 0,
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        L: leaflet,
        ASIG_ALBANIA_CONFIG: CONFIG,
        _dlMap: map,
        _currentLang: () => 'en'
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('js/asig-albania-layers.js'), sandbox, { filename: 'js/asig-albania-layers.js' });
    const API = sandbox.AsigAlbaniaLayers;
    assert.ok(API, 'the module exposes its API');
    assert.ok(sandbox.toggleAlbaniaLayers && sandbox.toggleAlbaniaSubLayers &&
        sandbox.setAlbaniaLayer && sandbox.setAlbaniaOpacity &&
        sandbox.goToAlbaniaView && sandbox.showAlbaniaInfo,
        'the inline handlers in index.html exist');

    /* ── the panel ── */
    const rasterRowIds = dom.childIds('albaniaSubLayers');
    RASTER_IDS.forEach((id) => assert.ok(rasterRowIds.indexOf(id) !== -1, id + ' row is rendered'));
    const protectedChildIds = dom.protectedChildIds('albaniaProtectedBody');
    assert.deepStrictEqual(protectedChildIds, PROTECTED_IDS,
        'the Protected Sites group holds exactly the four child checkboxes');
    ALL_IDS.forEach((id) => {
        const input = dom.byId['albaniaToggle_' + id];
        assert.ok(input && input.type === 'checkbox', id + ' is an independent checkbox (rasters stack)');
        assert.ok(dom.byId['albaniaOpacity_' + id], id + ' has an opacity slider');
        assert.ok(dom.byId['albaniaPct_' + id], id + ' has a pct label');
    });
    assert.ok(dom.byId['albaniaProtectedCaption'], 'the Protected Sites caption exists');
    assert.strictEqual(dom.byId['albaniaOpacity_lidar'].value, '50', 'the LiDAR slider starts at 50 %');
    ok('rows: five independent raster checkboxes + the collapsible four-child Protected Sites group');

    /* ── activation / stacking ── */
    assert.strictEqual(leaflet.calls.constructed.length, 0, 'nothing is built before a switch');
    API.toggle('ortho1999', true);
    API.toggle('lidar', true);
    assert.strictEqual(leaflet.calls.constructed.length, 2, 'two stacked rasters draw independently');
    const panes = leaflet.calls.constructed.map((l) => l.options.pane);
    assert.deepStrictEqual(panes, ['pane_albania_raster', 'pane_albania_raster'],
        'the rasters stack on the raster pane');
    assert.strictEqual(leaflet.calls.constructed[1].options.opacity, 0.5,
        'the LiDAR hillshade draws at the briefed 50 %');
    API.toggle('natural', true);
    assert.strictEqual(leaflet.calls.constructed.length, 3);
    assert.strictEqual(leaflet.calls.constructed[2].options.pane, 'pane_albania_protected',
        'the protected sites always draw above the Albanian rasters');
    assert.ok(map.createPaneCalled.indexOf('pane_albania_raster') !== -1 &&
        map.createPaneCalled.indexOf('pane_albania_protected') !== -1, 'both panes are created');
    assert.strictEqual(map.getPane('pane_albania_raster').style.zIndex, 405);
    assert.strictEqual(map.getPane('pane_albania_protected').style.zIndex, 407);
    ok('rasters stack independently (checkboxes); protected sites on the higher pane');

    API.toggle('lidar', false);
    assert.strictEqual(map._layers.length, 2, 'a switched-off row comes off the map');
    API.toggleGroup(true);
    assert.ok(!API.isActive('lidar'), 'the master switch respects the visitor’s own pick');
    API.toggleGroup(false);
    assert.strictEqual(map._layers.length, 0, 'the master switch off clears the whole Albanian stack');
    assert.ok(!API.activeIds().length, 'and resets the sub-switches');
    API.toggleGroup(true);
    assert.deepStrictEqual(API.activeIds(), ['lidar'], 'the master switch on starts the default (LiDAR)');
    ok('the master switch: default-on LiDAR, off clears everything');

    /* ── opacity slides a row on (the app’s standing rule) ── */
    API.toggleGroup(false);
    API.setOpacity('dsm', 80);
    assert.ok(API.isActive('dsm'), 'sliding past 0 switches the row on');
    assert.strictEqual(API.opacityOf('dsm'), 80);
    API.setOpacity('dsm', 0);
    assert.ok(!API.isActive('dsm'), 'sliding to 0 switches the row off');
    ok('opacity: per-row slider, 0–100, slides the row on/off');

    /* ── the CRS fallback + the “source is not answering” notice ── */
    const lidar = API.state.built.lidar || (API.toggle('lidar', true), API.state.built.lidar);
    const osmTile = { _map: map };
    lidar._tileCoordsToBounds = () => ({ getSouthWest: () => ({ lat: 41.0, lng: 19.0 }), getNorthEast: () => ({ lat: 41.5, lng: 19.5 }) });
    lidar.getTileSize = () => ({ x: 256, y: 256 });
    lidar._map = map;
    const merc = leaflet.CRS.EPSG3857.project;
    const sw = merc({ lat: 41.0, lng: 19.0 });
    const ne = merc({ lat: 41.5, lng: 19.5 });
    const expected = API._test.tileUrl('lidar', [sw.x, sw.y, ne.x, ne.y], 256, 'EPSG:3857');
    assert.strictEqual(lidar.getTileUrl({ x: 0, y: 0, z: 10 }), expected,
        'the tile URL is the tile bbox projected to EPSG:3857');
    for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) lidar._onTileError(osmTile);
    assert.strictEqual(lidar.options.crs, 'EPSG:4326', 'repeated failures switch to EPSG:4326');
    const degUrl = lidar.getTileUrl({ x: 0, y: 0, z: 10 });
    assert.ok(/BBOX=19(\.0)?,41(\.0)?,19\.5,41\.5/.test(degUrl), '1.1.1 → lon,lat axis order in degrees');
    let unavailable = 0;
    const rows = API.state.rows.lidar;
    for (let i = 0; i < CONFIG.wms.fallbackAfterErrors; i++) lidar._onTileError(osmTile);
    assert.ok(rows.status.textContent.indexOf('not answering') !== -1 ||
        rows.status.textContent.length > 0, 'a persistent failure is reported in the row (never a silent blank map)');
    lidar._onTileLoad();
    assert.strictEqual(lidar._errorCount, 0, 'a successful tile resets the counter');
    ok('EPSG:4326 fallback after repeated errors; a down service is named in the row');

    /* ── the country filter ── */
    assert.ok(!dom.byId.albaniaRow.classList.contains('country-layer-unavailable'), 'visible without a country');
    API.filterForCountry('RO');
    assert.ok(dom.byId.albaniaRow.classList.contains('country-layer-unavailable'),
        'the group row is hidden for Romania');
    assert.strictEqual(dom.byId.albaniaRow.attributes['aria-hidden'], 'true');
    API.filterForCountry('AL');
    assert.ok(!dom.byId.albaniaRow.classList.contains('country-layer-unavailable'),
        'and visible for Albania');
    API.filterForCountry(null);
    assert.ok(!dom.byId.albaniaRow.classList.contains('country-layer-unavailable'),
        'leaving the country view restores the catalogue');
    ok('the country filter shows the group only for Albania (or no country)');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. the wiring
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const html = read('index.html');
    assert.ok(html.indexOf('id="albaniaRow"') !== -1, 'the group row markup exists');
    assert.ok(html.indexOf('id="albaniaSubLayers"') !== -1, 'the rows container exists');
    assert.ok(html.indexOf('id="albaniaToggle"') !== -1 && html.indexOf('toggleAlbaniaLayers(this.checked)') !== -1,
        'the master switch is wired');
    assert.ok(html.indexOf('id="albaniaExpandBtn"') !== -1 && html.indexOf('toggleAlbaniaSubLayers()') !== -1,
        'the expand button is wired');
    assert.ok(html.indexOf('goToAlbaniaView()') !== -1, 'the go-to-Tirana button is wired');
    assert.ok(html.indexOf('showAlbaniaInfo()') !== -1, 'the info button is wired');
    assert.ok(html.indexOf('data-category="free" id="albaniaRow"') !== -1,
        'the group lives on the Free tab like the other national layers');
    ok('index.html: group row, master switch, expand, go-to, info');

    const cfgTag = 'js/asig-albania-layers.config.js';
    const modTag = 'js/asig-albania-layers.js';
    const iCfg = html.indexOf(cfgTag);
    const iReg = html.indexOf('js/layer-registry.js');
    const iMap = html.indexOf('js/map-app.js');
    const iMod = html.indexOf(modTag + '?');
    assert.ok(iCfg !== -1 && iMod !== -1, 'both scripts are included');
    assert.ok(iCfg < iReg, 'the config loads BEFORE the registry (the registry mirrors it)');
    assert.ok(iMod > iMap, 'the module loads AFTER map-app.js');
    assert.ok(html.indexOf('js/layer-registry.js?v=20261017-albania-asig') !== -1,
        'the registry script tag is cache-busted');
    ok('script order: config → registry → map-app → module');

    const css = read('css/styles.css');
    ['.albania-layer-row', '.albania-layer-label', '.albania-layer-slider', '.albania-layer-status',
        '.albania-sublayers', '.albania-protected-caption', '.albania-protected-body', '.albania-group-notice']
        .forEach((cls) => assert.ok(css.indexOf(cls) !== -1, cls + ' styled'));
    ok('css/styles.css carries the row styles');

    const sw = read('sw.js');
    assert.ok(sw.indexOf('detectlab-v227-archeo-3d-projection') !== -1, 'the cache is bumped');
    assert.ok(sw.indexOf("js/asig-albania-layers.config.js?v=20261017-albania-asig") !== -1 &&
        sw.indexOf("js/asig-albania-layers.js?v=20261017-albania-asig") !== -1,
        'both modules are precached');
    ok('sw.js: cache bumped, modules precached');

    const app = read('js/map-app.js');
    assert.ok(app.indexOf('var albaniaLayers = window.AsigAlbaniaLayers;') !== -1 &&
        app.indexOf('albaniaLayers.filterForCountry(iso)') !== -1,
        'map-app.js applies the country rule on selection');
    assert.ok(app.indexOf('window.AsigAlbaniaLayers.filterForCountry(null)') !== -1,
        'map-app.js restores the catalogue when the country view is left');
    ok('js/map-app.js applies the country rule to the Albanian rows (filter + unfilter)');
}

console.log('\n[OK] ' + passed + ' checks passed — Albanian layers (ASIG geoportal).\n');

/* ══════════════════════════════════════════════════════════════════════════
 * Stubs
 * ══════════════════════════════════════════════════════════════════════════ */
function moduleSandbox() {
    const dom = buildDom();
    const sandbox = {
        console: { warn() {}, log() {}, error() {} },
        document: dom.document,
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: () => 0, clearTimeout() {},
        setInterval: () => 0, clearInterval() {},
        L: buildLeaflet(),
        ASIG_ALBANIA_CONFIG: CONFIG,
        _currentLang: () => 'en'
    };
    sandbox.window = sandbox;
    return sandbox;
}

function buildDom() {
    const byId = {};

    function makeElement(tag) {
        const element = {
            tagName: String(tag).toUpperCase(),
            children: [], attributes: {}, style: {}, className: '',
            textContent: '', checked: false, value: '', type: '',
            parentNode: null, listeners: {},
            appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
            removeChild(child) {
                this.children = this.children.filter((c) => c !== child);
                return child;
            },
            setAttribute(key, value) {
                this.attributes[key] = String(value);
                if (key === 'value') this.value = String(value);
                if (key === 'class') this.className = String(value);
                if (key === 'id') { this.id = String(value); byId[this.id] = this; }
                if (key === 'type') this.type = String(value);
            },
            getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key]; },
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            dispatch(type, payload) { (this.listeners[type] || []).forEach((fn) => fn(payload || {})); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            set innerHTML(value) { if (value === '') { this.children = []; } },
            get innerHTML() { return ''; },
            get classList() {
                const self = this;
                return {
                    contains(name) { return self.className.split(' ').indexOf(name) !== -1; },
                    add(name) { if (!this.contains(name)) self.className = (self.className + ' ' + name).trim(); },
                    remove(name) { self.className = self.className.split(' ').filter((c) => c && c !== name).join(' '); },
                    toggle(name, on) {
                        if (on === undefined) on = !this.contains(name);
                        if (on) this.add(name); else this.remove(name);
                    }
                };
            }
        };
        return element;
    }

    /* The static markup index.html provides. */
    const staticIds = ['albaniaRow', 'albaniaSubLayers', 'albaniaToggle', 'albaniaExpandBtn',
        'albaniaExpandIcon', 'albaniaGroupTitle', 'albaniaGroupNotice', 'transpPanel'];
    staticIds.forEach((id) => {
        const element = makeElement(id === 'albaniaToggle' ? 'input' : 'div');
        element.id = id;
        byId[id] = element;
    });

    const document = {
        readyState: 'complete',
        documentElement: makeElement('html'),
        createElement: makeElement,
        getElementById: (id) => byId[id] || null,
        addEventListener() {}
    };

    function rowsOf(root, acc) {
        acc = acc || [];
        (root.children || []).forEach((child) => {
            const row = child.attributes && child.attributes['data-albania-row'];
            if (row) acc.push(row);
            rowsOf(child, acc);
        });
        return acc;
    }

    return {
        document, byId,
        childIds() { return rowsOf(byId.albaniaSubLayers); },
        protectedChildIds(containerId) {
            return (byId[containerId] ? byId[containerId].children : [])
                .map((child) => child.attributes['data-albania-row'])
                .filter(Boolean);
        }
    };
}

function buildLeaflet() {
    const calls = { constructed: [], opacity: [] };

    /* Real spherical-mercator (EPSG:3857) projection, as L.CRS.EPSG3857. */
    const RADIUS = 6378137;
    const MAX_LAT = 85.0511287798;
    function project(latlng) {
        const d = Math.PI / 180;
        const lat = Math.max(Math.min(MAX_LAT, latlng.lat), -MAX_LAT);
        const sin = Math.sin(lat * d);
        return { x: RADIUS * latlng.lng * d, y: RADIUS * Math.log((1 + sin) / (1 - sin)) / 2 };
    }

    /* L.setOptions, mirroring Leaflet: the first assignment builds an object
       whose PROTOTYPE is the class default options, so defaults stay visible. */
    function setOptions(obj, opts) {
        if (!Object.prototype.hasOwnProperty.call(obj, 'options')) {
            obj.options = Object.create(obj.options || null);
        }
        Object.assign(obj.options, opts || {});
        return obj.options;
    }

    function BaseTileLayer() {}
    BaseTileLayer.prototype = {
        options: {},
        initialize(url, options) { this._url = url; setOptions(this, options); },
        on(type, fn) {
            this.listeners = this.listeners || {};
            (this.listeners[type] = this.listeners[type] || []).push(fn);
            return this;
        },
        off() { return this; },
        redraw() { this._redrawn = (this._redrawn || 0) + 1; return this; },
        setOpacity(value) { this.options.opacity = value; calls.opacity.push(value); return this; },
        setZIndex() { return this; },
        getTileSize() { return { x: 256, y: 256 }; },
        _tileCoordsToBounds() {
            return { getSouthWest: () => ({ lat: 41.0, lng: 19.0 }), getNorthEast: () => ({ lat: 41.5, lng: 19.5 }) };
        }
    };
    BaseTileLayer.extend = function (proto) {
        function Klass(...args) {
            calls.constructed.push(this);
            if (this.initialize) this.initialize(...args);
        }
        Klass.prototype = Object.assign(Object.create(BaseTileLayer.prototype), proto);
        return Klass;
    };

    return {
        calls,
        TileLayer: BaseTileLayer,
        setOptions,
        latLngBounds(bounds) { return { _bounds: bounds }; },
        CRS: { EPSG3857: { code: 'EPSG:3857', project } }
    };
}

function buildMap() {
    const panes = {};
    return {
        /* options.crs stays null → the layer falls back to L.CRS.EPSG3857,
           which is what it would find on the real map anyway. */
        options: { crs: null },
        createPaneCalled: [],
        _layers: [],
        getPane(name) { return panes[name] || null; },
        createPane(name) { this.createPaneCalled.push(name); panes[name] = { style: {} }; return panes[name]; },
        addLayer(layer) { this._layers.push(layer); layer._map = this; return this; },
        hasLayer(layer) { return this._layers.indexOf(layer) !== -1; },
        removeLayer(layer) { this._layers = this._layers.filter((l) => l !== layer); return this; },
        on() { return this; },
        setView() { return this; }
    };
}
