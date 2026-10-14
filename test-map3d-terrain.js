// Regression suite for the 3D terrain view (2D ⇄ 3D).
//
// Covers: the shared layer registry (js/layer-registry.js), the 2D→3D mirror
// (js/map3d-mirror.js), the MapLibre viewer (js/map3d-terrain.js), the
// same-origin tile proxy (netlify/lib/map3d-tile.mjs +
// netlify/functions/map3d-tile.mjs + tools/map3d-dev-server.mjs) and the wiring
// in index.html / sw.js / netlify.toml.
//
// The invariants this file protects:
//   1. a layer is defined ONCE — in the registry (service facts) and/or as a
//      live 2D Leaflet layer (the mirror). The viewer may not hard-code a URL.
//   2. the 3D deck is the mirror of the live 2D map, so nothing can be visible
//      in 2D and missing in 3D: raster, WMS/WMTS, images, vectors, markers,
//      clusters and heatmaps are all translated.
//   3. the stack is background ▸ base ▸ hillshade ▸ overlays in 2D pane order,
//      re-asserted after every change (the defect this work fixes).
//   4. the tile proxy stays an allow-listed relay, never an open proxy.
//
// Usage: node test-map3d-terrain.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] 3D terrain view — mirror, shared registry, MapLibre viewer, tile proxy...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };

const indexHtml = read('index.html');
const swJs = read('sw.js');
const netlifyToml = read('netlify.toml');
const mapApp = read('js/map-app.js');
const histEu = read('js/historical-eu-maps.js');
const viewer = read('js/map3d-terrain.js');
const registrySource = read('js/layer-registry.js');
const mirrorSource = read('js/map3d-mirror.js');
const skin = read('css/map3d-terrain.css');

const TAG = '20261013-3d-terrain';             /* MapLibre itself (unchanged) */
const TAG_3D = '20261013-3d-mobile';           /* registry + mirror + viewer  */

// ══════════════════════════════════════════════════════════════
// 1. Static wiring — the viewer must be reachable in the app
// ══════════════════════════════════════════════════════════════
{
    const registryTag = indexHtml.indexOf('js/layer-registry.js?v=' + TAG_3D);
    const mirrorTag = indexHtml.indexOf('js/map3d-mirror.js?v=' + TAG_3D);
    const viewerTag = indexHtml.indexOf('js/map3d-terrain.js?v=20261014-3d-slider-layout');
    const mapAppTag = indexHtml.indexOf('js/map-app.js?v=');
    const histEuTag = indexHtml.indexOf('js/historical-eu-maps.js?v=');
    assert(registryTag !== -1, 'index.html loads the shared layer registry');
    assert(mirrorTag !== -1, 'index.html loads the 2D→3D mirror');
    assert(viewerTag !== -1, 'index.html loads the 3D terrain viewer');
    assert(registryTag < mapAppTag, 'the registry loads before map-app.js builds the layers');
    assert(registryTag < histEuTag, 'the registry loads before the CENAGIS catalogue');
    assert(registryTag < mirrorTag && mirrorTag < viewerTag,
        'registry → mirror → viewer: the viewer reads both, and neither reads the viewer');
    assert(indexHtml.includes('css/maplibre-gl.css?v=' + TAG) &&
           indexHtml.includes('css/map3d-terrain.css?v=20261014-3d-slider-layout'),
        'index.html loads the MapLibre stylesheet and the 3D skin');
    assert(indexHtml.indexOf('css/maplibre-gl.css') < indexHtml.indexOf('css/map3d-terrain.css'),
        'the 3D skin comes after the stylesheet it re-skins');

    // Service worker: the shell must ship the new modules, and the cache must
    // be bumped so an installed PWA picks the mirrored 3D view up.
    ['js/layer-registry.js?v=' + TAG_3D, 'js/map3d-mirror.js?v=' + TAG_3D,
     'js/map3d-terrain.js?v=20261014-3d-slider-layout', 'js/maplibre-gl.js?v=' + TAG,
     'css/map3d-terrain.css?v=20261014-3d-slider-layout', 'css/maplibre-gl.css?v=' + TAG].forEach(function (asset) {
        assert(swJs.includes("'" + asset + "'"), 'sw.js precaches ' + asset);
    });
    const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
    assert(shellVersion >= 196, 'sw.js cache is v196 or newer so installed PWAs get the mobile 3D fix');

    // Netlify: the route exists both as a function path and as a redirect
    assert(read('netlify/functions/map3d-tile.mjs').includes("path: '/api/map3d/tile'"),
        'the Netlify function claims /api/map3d/tile');
    assert(/from = "\/api\/map3d\/tile"[\s\S]{0,80}to = "\/\.netlify\/functions\/map3d-tile"/.test(netlifyToml),
        'netlify.toml redirects /api/map3d/tile to the function');
    assert(read('tools/map3d-dev-server.mjs').includes("from '../netlify/lib/map3d-tile.mjs'"),
        'the dev server runs the same proxy code as production');
    console.log('  ✓ index.html / sw.js / netlify.toml wire the registry, the mirror, the viewer and the proxy');
}

// ══════════════════════════════════════════════════════════════
// 2. No second source of truth
// ══════════════════════════════════════════════════════════════
{
    assert(!/https?:\/\/[a-z0-9.-]+\//i.test(viewer),
        'the viewer hard-codes no service URL — every URL comes from the registry or from the live 2D layer');
    assert(/DetectLabMirror/.test(viewer) && /DetectLabLayers/.test(viewer),
        'the viewer reads both the live 2D map and the shared registry');
    assert(/_dlMap/.test(viewer) && /_dlMap/.test(mirrorSource),
        'both read the live 2D Leaflet map (window._dlMap), not a copy of the layer list');
    assert(/url2d|wms2dOptions|tile2dOptions|cenagisCatalog/.test(mapApp) && /DetectLabLayers/.test(mapApp),
        'the 2D map keeps building its layers from the same registry');
    const searchSelection = mapApp.match(/function selectResult\(item\) \{[\s\S]*?\n {12}\}/);
    assert(searchSelection && /map3d && typeof map3d\.isOpen === 'function'/.test(searchSelection[0]),
        'search only calls the optional 3D viewer when it is available');
    assert(!/DetectLabMap3D/.test(mapApp.replace(searchSelection[0], '')) && !/DetectLabMirror/.test(mapApp),
        'outside the optional search hand-off, the 2D map does not depend on the 3D view');
    assert(/url2d|wms2dOptions|tile2dOptions/.test(histEu), 'the historical catalogue uses the same registry');
    console.log('  ✓ one definition per layer: registry + live 2D layers, nothing duplicated in the viewer');
}

// ══════════════════════════════════════════════════════════════
// 3. The registry itself (Node side, no DOM)
// ══════════════════════════════════════════════════════════════
{
    const R = require('./js/layer-registry.js');
    assert(R.VERSION.indexOf('3d-mirror') !== -1, 'the registry carries the mirror release version');
    const layers = R.list();
    assert(layers.length >= 90, 'the registry still describes every layer (' + layers.length + ')');
    const ordered = R.ordered();
    for (let i = 1; i < ordered.length; i += 1) {
        assert((ordered[i - 1].z == null ? 1000 : ordered[i - 1].z) <= (ordered[i].z == null ? 1000 : ordered[i].z),
            'ordered() sorts by the 2D pane z-index (draw order)');
    }
    assert(R.list().every(function (d) { return d.id && d.group; }), 'every definition has an id and a group');

    /* host policy — what the viewer uses to decide direct vs proxy */
    const policy = R.hostPolicy();
    assert(policy['server.arcgisonline.com'] === 'never' && policy['tiles.arcgis.com'] === 'never',
        'CORS-enabled hosts are declared direct');
    assert(policy['image.discomap.eea.europa.eu'] === 'always' &&
           policy['geoserve.cast.uark.edu'] === 'always',
        'hosts with no CORS at all are declared proxy-only (never a failed direct wave)');
    assert(policy['pastmaps.cenagis.edu.pl'] === 'unknown' &&
           policy['services.geo-spatial.org'] === 'unknown',
        'hosts whose CORS is merely unproven stay “auto”: direct first, healed to the proxy if they fail');

    /* mirror stubs: without a 2D map there is nothing extra, and list() stays pure */
    assert(typeof R.mirrorStubs === 'function' && R.mirrorStubs().length === 0,
        'with no live 2D map, list() is exactly the declared layers (no phantom entries)');
    assert(R.get('base.imagery') && R.get('lidar.pl-nmt'), 'known ids still resolve');
    assert(R.get('2d.1234') === null, 'a mirrored stub is never registered as a definition');
    assert(typeof R.hostPolicy === 'function' && R.mirrorStubs, 'the new helpers are exported');

    const diag = R.diagnostics();
    assert(diag.totals.layers === layers.length, 'diagnostics covers every layer');
    assert(diag.terrain.provider === 'aws-terrarium' && /elevation-tiles-prod/.test(diag.terrain.tiles[0]),
        'the default DEM is the keyless AWS Terrarium source');
    assert(R.verify2d().ok, 'the registry agrees with the live 2D layers');
    console.log('  ✓ the registry describes ' + layers.length + ' layers, orders them and routes their hosts');
}

// ══════════════════════════════════════════════════════════════
// 4. The 2D → 3D mirror (Node side, with a fake Leaflet layer)
// ══════════════════════════════════════════════════════════════
{
    const windowStub = {
        console: console,
        document: { createElement: function () { return {}; }, addEventListener() {} },
        navigator: { onLine: true },
        setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: function () { return 0; }, clearInterval() {},
        addEventListener() {}, removeEventListener() {},
        location: { search: '' }
    };
    windowStub.window = windowStub;

    /* A minimal Leaflet: enough for `instanceof`, panes and a tile layer that
     * builds its own URL (the case a static template could never express). */
    function Base(options) { this.options = options || {}; }
    function TileLayer(url, options) { Base.call(this, options); this._url = url; }
    TileLayer.prototype = Object.create(Base.prototype);
    TileLayer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
    TileLayer.prototype.getTileUrl = function (coords) {
        return 'https://wms.example.org/geoserver/wms?SERVICE=WMS&VERSION=1.1.1&SRS=EPSG:3857' +
            '&BBOX=' + coords.x + ',' + coords.y + ',' + coords.z + '&WIDTH=256&HEIGHT=256' +
            '&LAYERS=eharta%3Amozaic_austrian_200k&FORMAT=image/png&TRANSPARENT=true';
    };
    TileLayer.prototype.getOpacity = function () { return 0.72; };
    windowStub.L = {
        TileLayer: TileLayer,
        Marker: function () {}, ImageOverlay: function () {}, SVGOverlay: function () {},
        VideoOverlay: function () {}, GeoJSON: function () {}, Path: function () {},
        LayerGroup: function () {}, MarkerClusterGroup: null,
        stamp: function (layer) { layer._leaflet_id = layer._leaflet_id || 'x1'; return layer._leaflet_id; }
    };

    const sandbox = { window: windowStub, console: console, Date: Date, Math: Math, JSON: JSON,
        URL: URL, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
        setTimeout: setTimeout, clearTimeout: clearTimeout };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });

    const mirror = windowStub.DetectLabMirror;
    assert(mirror, 'window.DetectLabMirror is exported');
    ['collect', 'describe', 'classify', 'tileUrlFor', 'templateFor', 'layerByKey', 'paneZIndex'].forEach(function (fn) {
        assert(typeof mirror[fn] === 'function', 'the mirror exposes ' + fn);
    });
    assert(mirror.collect(null).items.length === 0 && mirror.collect(undefined).signature === '',
        'collect() survives the map not being built yet');

    const layer = new TileLayer('https://wms.example.org/geoserver/wms', {
        layers: 'eharta:mozaic_austrian_200k', name: 'Austrian 200k', opacity: 0.72, pane: 'pane_hist'
    });
    layer._leaflet_id = 'L77';
    const pane = { style: { zIndex: '640' }, ownerDocument: null };
    const map = {
        getPane: function () { return pane; },
        eachLayer: function (fn) { fn(layer); },
        hasLayer: function () { return true; }
    };

    assert(mirror.paneZIndex(map, layer) === 640, 'the 2D pane z-index becomes the 3D z-order');
    const described = mirror.describe(layer, map, {});
    assert(described && described.kind === 'raster', 'an L.TileLayer of any subclass mirrors as a raster layer');
    assert(described.template === 'dl2d://2d.L77/{z}/{x}/{y}',
        'the tile template points back at the live 2D layer, not at a re-implementation');
    assert(described.opacity === 0.72, 'the live 2D opacity is carried into 3D');
    assert(described.label === 'Austrian 200k', 'the 2D layer name is used as the label');

    /* The per-tile URL is asked of the layer itself: a WMS bbox that no static
     * {z}/{x}/{y} template could produce. */
    const url = mirror.tileUrlFor(layer, 10, 562, 352);
    assert(url.indexOf('SRS=EPSG%3A3857') !== -1 || url.indexOf('SRS=EPSG:3857') !== -1,
        'the tile URL keeps the service parameters the 2D layer asked for');
    assert(/BBOX=562,352,10/.test(url), 'the tile URL is built by the 2D layer for this exact tile');
    assert(mirror.tileUrlFor(null, 1, 1, 1) === '', 'a layer that is gone yields no URL instead of throwing');

    const collected = mirror.collect(map);
    assert(collected.items.length === 1 && collected.items[0].key === '2d.L77',
        'collect() walks the live map');
    assert(mirror.layerByKey('2d.L77') === layer, 'layerByKey() hands the dl2d:// protocol its Leaflet layer');
    assert(collected.signature.indexOf('raster:2d.L77:640:72') === 0,
        'the signature carries kind, order and opacity (so a change triggers a re-sync)');

    /* Without Leaflet at all (a page where the 2D map never loaded) the mirror
     * must not throw. */
    const bare = { window: null, console: console, Date: Date, JSON: JSON, Math: Math };
    bare.globalThis = bare;
    vm.createContext(bare);
    vm.runInContext(mirrorSource, bare, { filename: 'js/map3d-mirror.js' });
    assert(bare.DetectLabMirror && bare.DetectLabMirror.collect(null).items.length === 0,
        'the mirror is inert (never fatal) when Leaflet is absent');
    console.log('  ✓ the mirror translates the live 2D layers (raster/WMS included) and their order');
}

// ══════════════════════════════════════════════════════════════
// 5. The 3D viewer boots headless (no GPU, no MapLibre download)
// ══════════════════════════════════════════════════════════════
{
    const stubElement = function () {
        return {
            style: {}, dataset: {}, children: [], checked: false, value: '',
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            setAttribute() {}, getAttribute() { return null; }, addEventListener() {},
            removeEventListener() {}, appendChild(c) { return c; }, removeChild() {},
            querySelector() { return stubElement(); }, querySelectorAll() { return []; },
            insertBefore(c) { return c; }, contains() { return false; }, focus() {}
        };
    };
    const documentStub = {
        readyState: 'complete',
        head: stubElement(), body: stubElement(), documentElement: stubElement(),
        createElement: stubElement, getElementById() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}
    };
    const windowStub = {
        document: documentStub,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener() {}, removeEventListener() {},
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { onLine: true },
        console: console
    };
    windowStub.window = windowStub;
    const quietConsole = { log: console.log, warn: console.warn, error: console.error,
        table: function () {}, info: console.info, debug: console.debug };
    const sandbox = { window: windowStub, document: documentStub, console: quietConsole,
        setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator };
    vm.createContext(sandbox);
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });

    const api = windowStub.DetectLabMap3D;
    assert(api, 'window.DetectLabMap3D is exported');
    ['open', 'close', 'toggle', 'isOpen', 'getMap', 'syncLayers', 'setExaggeration', 'getExaggeration',
     'setPitch', 'setBearing', 'resetView', 'status', 'report', 'registry', 'mirror'].forEach(function (fn) {
        assert(typeof api[fn] === 'function' || typeof api[fn] === 'object', 'API exposes ' + fn);
    });
    const status = api.status();
    assert(status.open === false, '3D starts closed');
    assert(status.layers.length === api.registry.list().length, 'status() covers every registry layer');
    assert(status.terrain.provider === 'aws-terrarium' &&
           status.terrain.tiles[0].indexOf('elevation-tiles-prod/terrarium') !== -1,
        'the default terrain is the keyless AWS Terrarium DEM');
    assert(status.errors.length === 0, 'nothing failed while booting headless');
    assert(status.layers.every(function (l) { return l.active3d === false; }),
        'a closed 3D view claims no layer');
    assert(typeof api.report().mirrored !== 'undefined', 'report() returns the deck for the console');

    /* The style: background + the DEM, and the hillshade from that DEM — the
     * base map itself is a mirrored layer, added later, above the hillshade. */
    const style = api._buildStyle();
    assert(style.version === 8 && style.layers[0].id === 'm3d-background',
        'the style starts with the background');
    assert(style.sources['detectlab-dem'].type === 'raster-dem' &&
           style.sources['detectlab-dem'].encoding === 'terrarium' &&
           style.terrain.source === 'detectlab-dem',
        'the DEM is one raster-dem source, used by the terrain');
    assert(style.layers.some(function (l) { return l.id === 'm3d-hillshade'; }),
        'the DEM also feeds the hillshade layer');
    assert(style.layers[style.layers.length - 1].id === 'm3d-hillshade',
        'nothing in the style sits above the hillshade — the base map comes from the 2D map');

    /* The deck order: the defect this release fixes. */
    const entries = [
        { id: 'm3d-2d-2d.9', layerIds: ['m3d-2d-2d.9'], z: 398 },            /* 2D basemap */
        { id: 'm3d-2d-2d.77', layerIds: ['m3d-2d-2d.77'], z: 640 },          /* Austrian WMS */
        { id: 'm3d-2d-2d.31', layerIds: ['m3d-2d-2d.31'], z: 620 },          /* heritage vectors */
        { id: 'm3d-2d-2d.56', layerIds: ['m3d-2d-2d.56-fill', 'm3d-2d-2d.56-line'], z: 625 }
    ];
    const present = { 'm3d-background': true, 'm3d-hillshade': true };
    entries.forEach(function (e) { e.layerIds.forEach(function (id) { present[id] = true; }); });
    const order = api._deckOrder(entries, present, ['m3d-hillshade', 'm3d-hillshade-service'], 'm3d-2d-2d.9');
    assert(order[0] === 'm3d-background', 'the background stays at the bottom');
    assert(order.indexOf('m3d-2d-2d.9') === 1, 'the 2D base map sits directly above the background');
    assert(order.indexOf('m3d-hillshade') === 2,
        'the hillshade is drawn ON TOP of the base map — not hidden underneath it (the reported defect)');
    assert(order.indexOf('m3d-2d-2d.77') > order.indexOf('m3d-hillshade'),
        'a user layer (Austrian WMS, pane 640) is above the hillshade');
    assert(order.indexOf('m3d-2d-2d.31') < order.indexOf('m3d-2d-2d.56-fill'),
        'the user layers keep their 2D pane order (620 before 625)');
    assert(order.indexOf('m3d-2d-2d.56-line') === order.indexOf('m3d-2d-2d.56-fill') + 1,
        'sub-layers of one vector layer stay adjacent and in paint order');
    assert(order.filter(function (id) { return id === 'm3d-hillshade'; }).length === 1,
        'the hillshade appears exactly once, whatever the layer count');

    /* No basemap visible (thumbnail/2D map still booting): overlays still land
     * above the hillshade. */
    const noBase = api._deckOrder([entries[1]], { 'm3d-background': true, 'm3d-hillshade': true,
        'm3d-2d-2d.77': true }, ['m3d-hillshade'], null);
    assert(noBase.indexOf('m3d-2d-2d.77') > noBase.indexOf('m3d-hillshade'),
        'without a base map the overlays still draw above the hillshade');

    /* A raster-dem source must never be drawn as a visible raster layer. */
    assert(!style.layers.some(function (l) { return l.type === 'raster' && l.source === 'detectlab-dem'; }),
        'the DEM source is never also rendered as a visible raster layer');
    console.log('  ✓ the viewer boots headless and stacks base ▸ hillshade ▸ overlays in 2D pane order');
}

// ══════════════════════════════════════════════════════════════
// 6. Tile proxy — URLs, validation, reprojection, relay allow-list
// ══════════════════════════════════════════════════════════════
(async function main() {
    const lib = await import('./netlify/lib/map3d-tile.mjs');
    const R = require('./js/layer-registry.js');

    const wms = lib.buildUpstreamUrl(R.get('hist.austrian'), { z: 10, x: 562, y: 352 });
    assert(wms.url.indexOf('services.geo-spatial.org/geoserver/eharta/wms?') !== -1 &&
           /layers=eharta%3Amozaic_austrian_200k/.test(wms.url),
        'WMS requests come from the registry definition');
    assert(/srs=EPSG%3A3857/.test(wms.url) && !/crs=/.test(wms.url),
        'WMS 1.1.x is asked with srs= and stays in the tile CRS');
    assert(/bbox=-?\d/.test(wms.url), 'the tile bbox is resolved to real coordinates');

    const cen = lib.buildUpstreamUrl(R.get('cenagis.city_warszawa_1822'), { z: 12, x: 2266, y: 1348 });
    assert(/crs=EPSG%3A2180/.test(cen.url) && cen.approximate === true,
        'the PL-1992-only sheet is re-projected and flagged approximate');
    const w3857 = lib.tileBboxInCrs(12, 2266, 1348, 'EPSG:3857').bbox;
    const w2180 = lib.tileBboxInCrs(12, 2266, 1348, 'EPSG:2180').bbox;
    assert(w2180[0] !== w3857[0] && w2180[0] > 0 && w2180[0] < 1000000,
        'the reprojected bbox lands in the Polish national grid');

    const wmts = lib.buildUpstreamUrl(R.get('vegfp.ppi'), { z: 9, x: 284, y: 176, time: '2023-06-11' });
    assert(/REQUEST=GetTile/.test(wmts.url) && /TILEMATRIX=EPSG%3A3857%3A9/.test(wmts.url) &&
           /TIME=2023-06-11/.test(wmts.url),
        'WMTS layers keep their KVP form and TIME dimension');

    /* ── the relay (?u=): a mirrored 2D layer whose host has no CORS ─────── */
    const allowed = lib.validateRelayUrl(
        'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/8/51/12');
    assert(allowed.ok, 'a host the site itself uses is relayed');
    assert(!lib.validateRelayUrl('https://evil.example.com/tile/1/1/1.png').ok,
        'an unknown host is refused (the relay is not an open proxy)');
    assert(lib.validateRelayUrl('https://evil.example.com/x').reason === 'host-not-allowed',
        'the refusal names the reason, so the host can be added to proxy.extraHosts in one line');
    assert(!lib.validateRelayUrl('http://127.0.0.1:4173/api/x').ok &&
           lib.validateRelayUrl('http://127.0.0.1:4173/api/x').reason === 'private-host',
        'loopback/private addresses are refused outright');
    assert(!lib.validateRelayUrl('file:///etc/passwd').ok, 'only http(s) can be relayed');
    assert(!lib.validateRelayUrl('https://user:pass@server.arcgisonline.com/x').ok,
        'a URL carrying credentials is refused');
    assert(lib.relayAllowedHosts().has('pastmaps.cenagis.edu.pl') &&
           lib.relayAllowedHosts().has('wmts.geo.admin.ch'),
        'the country LiDAR / historical hosts are relayable without further configuration');

    const relayRefused = await lib.handleTileRequest(new Request(
        'https://x/api/map3d/tile?u=' + encodeURIComponent('https://evil.example.com/a.png')));
    assert(relayRefused.status === 403 &&
           /host-not-allowed/.test(await relayRefused.text()),
        'the server refuses the same host, with the config hint in the body');

    const check = (qs) => lib.validateTileRequest(new URL('https://x/api/map3d/tile' + qs));
    const good = check('?layer=hist.austrian&z=10&x=562&y=352');
    assert(good.ok && good.def && good.z === 10, 'a valid request is accepted');
    const unknown = check('?layer=nope&z=1&x=1&y=1');
    assert(!unknown.ok && unknown.status === 404,
        'unknown layers are refused with 404 (it is not an open proxy)');
    assert(!check('?layer=hist.austrian&z=99&x=1&y=1').ok, 'out-of-range zoom is refused');
    assert(!check('?layer=hist.austrian&z=10&x=9999&y=9999').ok, 'out-of-range tile indices are refused');
    const badTime = check('?layer=vegfp.ppi&z=9&x=1&y=1&t=..%2Fetc');
    assert(!badTime.ok && badTime.reason === 'bad-time', 'a malformed TIME value is refused');
    const badMode = check('?layer=lidar.fr-mnh&z=9&x=1&y=1&m=..%2Fetc');
    assert(!badMode.ok && badMode.reason === 'bad-mode', 'a malformed renderer mode is refused');

    /* A mirrored stub layer (2d.*) is not a registry id: the relay is the only
     * way such a layer is proxied, and only for allow-listed hosts. */
    assert(R.list().every(function (d) { return !d.stub; }),
        'registry.list() holds no mirrored stub without a live 2D map');
    assert(lib.proxyReport().total === R.list().length, 'the proxy report covers every registry layer');

    /* The blank-tile contract: an upstream failure must not break the 3D view. */
    const blank = await lib.handleTileRequest(new Request(
        'https://x/api/map3d/tile?layer=hist.austrian&z=10&x=562&y=352'),
        { timeoutMs: 1500 });   /* keep the suite fast when the sandbox has no egress */
    assert(blank.status === 200 && blank.headers.get('content-type') === 'image/png',
        'a failed upstream still answers 200 image/png (transparent blank tile)');
    assert(blank.headers.get('X-Map3D-Tile') === 'blank',
        'the blank tile is labelled so the viewer can report it instead of showing a hole');
    console.log('  ✓ the proxy builds, validates, reprojects and relays exactly as documented');

    // ══════════════════════════════════════════════════════════
    // 7. The 3D skin stays out of the way of the 2D chrome
    // ══════════════════════════════════════════════════════════
    assert(/body\.is-3d #detectlab-map \.leaflet-pane \{ visibility: hidden; \}/.test(skin),
        'the Leaflet panes are hidden (not removed) while 3D is on');
    assert(/body\.is-3d #map3d-bar \{ display: flex; \}/.test(skin),
        'the 3D bar only appears in 3D');
    assert(/@media \(max-width: 720px\)/.test(skin),
        'the bar has a phone layout');
    assert(/#map3d-surface \.maplibregl-popup/.test(skin),
        'popups opened from a 3D feature are styled like the 2D ones');
    console.log('  ✓ the 3D view keeps the 2D chrome usable and hides only the 2D-only controls');

    console.log('\n✅ test-map3d-terrain.js passed all checks successfully.');
}()).catch(function (err) {
    console.error(err);
    process.exit(1);
});
