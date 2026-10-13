// Regression suite for the 3D terrain view (2D ⇄ 3D).
//
// Covers: the single shared layer registry (js/layer-registry.js), the MapLibre
// viewer (js/map3d-terrain.js), the same-origin tile proxy
// (netlify/lib/map3d-tile.mjs + netlify/functions/map3d-tile.mjs +
// tools/map3d-dev-server.mjs) and the wiring in index.html / sw.js /
// netlify.toml / js/map-app.js / js/historical-eu-maps.js.
//
// The point of the shared registry is that a layer is defined ONCE: these
// checks fail if a service fact (URL, LAYERS, FORMAT, VERSION, attribution)
// starts living in two places again.
//
// Usage: node test-map3d-terrain.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] 3D terrain view — shared registry, MapLibre viewer, tile proxy...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };

const indexHtml = read('index.html');
const swJs = read('sw.js');
const netlifyToml = read('netlify.toml');
const mapApp = read('js/map-app.js');
const histEu = read('js/historical-eu-maps.js');
const viewer = read('js/map3d-terrain.js');
const registrySource = read('js/layer-registry.js');

const TAG = '20261013-3d-terrain';            /* MapLibre itself (unchanged) */
const TAG_LIDAR = '20261013-3d-lidar';        /* registry + viewer after the LiDAR release */
const TAG_POSITION = '20261013-3d-position';  /* 3D skin after the control-placement fix */

// ══════════════════════════════════════════════════════════════
// 1. Static wiring — the viewer must be reachable in the app
// ══════════════════════════════════════════════════════════════
{
    const registryTag = indexHtml.indexOf('js/layer-registry.js?v=' + TAG_LIDAR);
    const viewerTag = indexHtml.indexOf('js/map3d-terrain.js?v=' + TAG_LIDAR);
    const mapAppTag = indexHtml.indexOf('js/map-app.js?v=');
    const histEuTag = indexHtml.indexOf('js/historical-eu-maps.js?v=');
    assert(registryTag !== -1, 'index.html loads the shared layer registry');
    assert(viewerTag !== -1, 'index.html loads the 3D terrain viewer');
    assert(registryTag < mapAppTag, 'the registry loads before map-app.js builds the layers');
    assert(registryTag < histEuTag, 'the registry loads before the CENAGIS catalogue');
    assert(registryTag < viewerTag, 'the viewer loads after its registry');
    assert(indexHtml.includes('css/maplibre-gl.css?v=' + TAG) &&
           indexHtml.includes('css/map3d-terrain.css?v=' + TAG_POSITION),
        'index.html loads the MapLibre stylesheet and the 3D skin');
    assert(indexHtml.indexOf('css/maplibre-gl.css') < indexHtml.indexOf('css/map3d-terrain.css'),
        'the 3D skin comes after the stylesheet it re-skins');

    // Service worker: the shell must ship the new modules, and the cache must
    // be bumped so an installed PWA picks the 3D view up.
    ['js/layer-registry.js?v=' + TAG_LIDAR, 'js/map3d-terrain.js?v=' + TAG_LIDAR,
     'js/maplibre-gl.js?v=' + TAG, 'css/map3d-terrain.css?v=' + TAG_POSITION,
     'css/maplibre-gl.css?v=' + TAG].forEach(function (asset) {
        assert(swJs.includes("'" + asset + "'"), 'sw.js precaches ' + asset);
    });
    const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
    assert(shellVersion >= 194, 'sw.js cache is v194 or newer so installed PWAs get the 3D view');

    // Netlify: the route exists both as a function path and as a redirect
    // (same belt-and-braces as /api/corona/rasters).
    assert(read('netlify/functions/map3d-tile.mjs').includes("path: '/api/map3d/tile'"),
        'the Netlify function claims /api/map3d/tile');
    assert(/from = "\/api\/map3d\/tile"[\s\S]{0,80}to = "\/\.netlify\/functions\/map3d-tile"/.test(netlifyToml),
        'netlify.toml redirects /api/map3d/tile to the function');
    assert(read('tools/map3d-dev-server.mjs').includes("from '../netlify/lib/map3d-tile.mjs'"),
        'the dev server runs the same proxy code as production');
    console.log('  ✓ index.html / sw.js / netlify.toml wire the registry, the viewer and the proxy');
}

// ══════════════════════════════════════════════════════════════
// 2. The registry itself (Node side, no DOM)
// ══════════════════════════════════════════════════════════════
{
    const R = require('./js/layer-registry.js');
    const layers = R.list();
    assert(layers.length >= 90, 'the registry defines every layer (' + layers.length + ')');
    const ids = layers.map(function (d) { return d.id; });
    assert(new Set(ids).size === ids.length, 'layer ids are unique');
    layers.forEach(function (d) {
        assert(d.id && d.group && d.kind, 'every layer has id/group/kind: ' + JSON.stringify(d.id));
        assert(['wms', 'wmts', 'xyz', 'arcgis-image', 'dynamic'].indexOf(d.kind) !== -1,
            d.id + ' has a known kind (' + d.kind + ')');
        assert(d.kind === 'dynamic' || d.url, d.id + ' has an endpoint');
    });
    assert(Object.keys(R.cenagisCatalog()).length === 45, 'all 45 CENAGIS sheets are in the registry');
    assert(R.get('cenagis.city_warszawa_1822').reproject &&
           R.get('cenagis.city_praga_1796').reproject,
        'the two EPSG:2180-only sheets are flagged for reprojection');
    assert(/^https:\/\//.test(R.terrainSource().tiles[0]), 'the default DEM is a real tile template');
    assert(R.terrainSource().encoding === 'terrarium', 'the keyless default DEM is Terrarium-encoded');
    assert(R.config().maplibre.js.indexOf('js/maplibre-gl.js?v=' + TAG) === 0,
        'the vendored MapLibre build is loaded with the same version tag');
    assert(R.config().proxy.base.indexOf('/api/map3d/tile') === 0, 'the proxy base path is the Netlify route');

    // Every definition is complete enough for BOTH views.
    const xyz = R.get('premium.bucovina');
    assert(xyz.url.indexOf('{z}') !== -1 && xyz.tileSize === 256 && xyz.opacity === 0.8,
        'tile pyramids carry their template, tile size and default opacity');
    const wms = R.get('hist.austrian');
    assert(wms.layer === 'eharta:mozaic_austrian_200k' && wms.version === '1.1.0' &&
           wms.format === 'image/png' && wms.transparent === true,
        'WMS layers carry LAYERS/FORMAT/VERSION/TRANSPARENT');
    assert(R.wms2dOptions('hist.austrian', { pane: 'pane_austrian' }).pane === 'pane_austrian' &&
           R.wms2dOptions('hist.austrian', {}).layers === 'eharta:mozaic_austrian_200k',
        'wms2dOptions() hands Leaflet exactly the registry service facts');
    console.log('  ✓ registry: ' + layers.length + ' layers, 45 CENAGIS sheets, DEM + proxy config');
}

// ══════════════════════════════════════════════════════════════
// 3. One definition, two views — the 2D side reads the registry
// ══════════════════════════════════════════════════════════════
{
    assert(histEu.includes('REGISTRY.cenagisCatalog()') &&
           histEu.includes("REGISTRY.wms2dOptions('cenagis.' + mapKey"),
        'the CENAGIS catalogue builds its rows/layers from the registry');
    ['hist.austrian', 'hist.firing-plans', 'hist.soviet-1970',
     'premium.mitteleuropa', 'premium.chrzanowski', 'premium.reymann',
     'premium.kdr-100k', 'premium.kdr-gb', 'premium.wig-100k'].forEach(function (id) {
        assert(mapApp.includes("DL.wms2dOptions('" + id + "'"),
            'map-app.js builds ' + id + ' from the registry');
    });
    // The three Copernicus mosaics share one builder that takes a registry id.
    ['sat.vhr-2012', 'sat.vhr-2018', 'sat.vhr-2021'].forEach(function (id) {
        assert(mapApp.includes("_satVhrWms('" + id + "')"),
            'map-app.js builds ' + id + ' from the registry');
    });
    assert(/function _satVhrWms\(id\)[\s\S]{0,120}DL\.url2d\(id\)[\s\S]{0,80}DL\.wms2dOptions\(id/.test(mapApp),
        'the VHR builder resolves URL and service options through the registry');
    ['premium.bucovina', 'premium.austro-hungarian', 'premium.moldova-1868',
     'premium.moldova-1771', 'premium.moldova-wwii', 'premium.polish-tactical-1933',
     'premium.ww1', 'premium.ww2', 'premium.banat', 'premium.transylvania-1859',
     'premium.galicia-1855', 'premium.josephine'].forEach(function (id) {
        assert(mapApp.includes("DL.url2d('" + id + "'"),
            'map-app.js takes the ' + id + ' URL from the registry');
    });
    // …and the service facts really are gone from the 2D CODE (a comment may
    // still name a service, e.g. when explaining a period list — that is prose,
    // not a second definition).
    const mapAppCode = mapApp.split('\n').map(function (line) {
        return line.replace(/\/\/.*$/, '');
    }).join('\n');
    ['eharta:mozaic_austrian_200k', 'ihpan:ukvme_3857', 'ihpan:wig100k_3857',
     'Galitzien_and_Bukovina-1861-1864/moldova-1868', 'Moldova_1771/{z}',
     'Harti/Banat/{z}', 'Siebenburgen_1859/MapServer', 'Kummerer_1855/MapServer',
     'VeryHighResolution2012', 'VHR_2021_LAEA',
     'IGNF_LIDAR-HD_MNT_ELEVATION', 'IGNF_LIDAR-HD_MNS_ELEVATION',
     'IGNF_LIDAR-HD_MNH_ELEVATION'].forEach(function (fact) {
        assert(!mapAppCode.includes(fact), 'map-app.js no longer repeats "' + fact + '" in code');
    });
    assert(mapApp.includes("DL.modes('lidar.fr-mnh')") &&
           mapApp.includes("DL.url2d('lidar.fr-mnh')"),
        'the France LiDAR branch reads its endpoint and products from the registry');
    assert(!histEu.includes("layers: 'ihpan:' + mapMeta.wms_layer"),
        'the CENAGIS workspace-qualified name lives in the registry only');
    console.log('  ✓ every historical layer is defined once and consumed by the 2D view');
}

// ══════════════════════════════════════════════════════════════
// 4. The 3D viewer boots headless (no GPU, no MapLibre download)
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
    const sandbox = { window: windowStub, document: documentStub, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator };
    vm.createContext(sandbox);
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });

    const api = windowStub.DetectLabMap3D;
    assert(api, 'window.DetectLabMap3D is exported');
    ['open', 'close', 'toggle', 'isOpen', 'getMap', 'syncLayers', 'setExaggeration',
     'setPitch', 'setBearing', 'resetView', 'status', 'report', 'registry'].forEach(function (fn) {
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
        'nothing is drawn in 3D before the user opens it');

    // The style is built from the registry (DEM + hillshade + sky), not from
    // hardcoded services inside the viewer.
    const style = api._buildStyle();
    assert(style.sources && style.sources[status.terrain.id] &&
           style.sources[status.terrain.id].type === 'raster-dem',
        'the style carries the DEM from the registry as a raster-dem source');
    assert(style.terrain && style.terrain.source === status.terrain.id,
        'the style enables terrain on that source');
    /* MapLibre GL 5 keeps the atmosphere in the style-level `sky` object
     * (paint properties), not in a sky layer — see setSky() in the dist. */
    assert(style.sky && typeof style.sky['sky-color'] === 'string' &&
           typeof style.sky['horizon-color'] === 'string',
        'the style configures the atmosphere (sky/horizon/fog colours)');
    assert(style.layers.every(function (l) { return l.type !== 'sky'; }),
        'the sky is the 5.x style property, not a layer');
    assert(viewer.indexOf('elevation-tiles-prod') === -1 &&
           viewer.indexOf('arcgisonline.com') === -1,
        'the viewer hardcodes no tile service — everything comes from the registry');
    console.log('  ✓ the viewer boots headless, exposes its API and builds its style from the registry');
}

// ══════════════════════════════════════════════════════════════
// 5. Tile proxy — URLs, validation, reprojection
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

    const corona = lib.buildUpstreamUrl(R.get('sat.corona-60s'), { z: 10, x: 562, y: 352, product: '1104-2155df004' });
    assert(/layers=corona%3A1104-2155df004/.test(corona.url) && /srs=EPSG%3A900913/.test(corona.url),
        'CORONA asks GeoWebCache for the product the shared catalogue selected');

    const check = (qs) => lib.validateTileRequest(new URL('https://x/api/map3d/tile' + qs));
    const good = check('?layer=hist.austrian&z=10&x=562&y=352');
    assert(good.ok && good.def && good.z === 10, 'a valid request is accepted');
    const unknown = check('?layer=nope&z=1&x=1&y=1');
    assert(!unknown.ok && unknown.status === 404,
        'unknown layers are refused with 404 (it is not an open proxy)');
    assert(!check('?layer=hist.austrian&z=99&x=1&y=1').ok,
        'out-of-range zoom is refused');
    assert(!check('?layer=hist.austrian&z=10&x=9999&y=9999').ok,
        'out-of-range tile indices are refused');
    const badTime = check('?layer=vegfp.ppi&z=9&x=1&y=1&t=..%2Fetc');
    assert(!badTime.ok && badTime.reason === 'bad-time', 'a malformed TIME value is refused');
    const badProduct = check('?layer=sat.corona-60s&z=10&x=1&y=1&p=..%2Fetc');
    assert(!badProduct.ok && badProduct.reason === 'bad-product',
        'a malformed CORONA product id is refused');

    const report = lib.proxyReport();
    assert(report.proxied.length > 0 && report.total === R.list().length &&
           report.proxied.length + report.auto.length + report.direct.length === report.total,
        'the proxy report classifies every registry layer exactly once');

    // The blank-tile contract: an upstream failure must not break the 3D view.
    const blank = await lib.handleTileRequest(new Request(
        'https://x/api/map3d/tile?layer=hist.austrian&z=10&x=562&y=352'),
        { timeoutMs: 1500 });   /* keep the suite fast when the sandbox has no egress */
    assert(blank.status === 200 && blank.headers.get('content-type') === 'image/png',
        'a failed upstream still answers 200 image/png (transparent blank tile)');
    assert(blank.headers.get('X-Map3D-Tile') === 'blank',
        'the blank tile is labelled so the viewer can switch that host to the proxy');
    console.log('  ✓ the proxy builds, validates and degrades exactly as documented');

    // ══════════════════════════════════════════════════════════
    // 6. Country LiDAR: no layer is skipped, per-tile builders drapes too
    // ══════════════════════════════════════════════════════════
    const country = await import('./netlify/lib/map3d-country-modules.mjs');
    const modules = country.countryModuleScope();
    const lidarIds = ['lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt',
        'lidar.es-mdt', 'lidar.ch-swisstopo', 'lidar.uk-ea', 'lidar.dk-dhm',
        'lidar.se-lantmateriet', 'lidar.fr-mnh'];

    lidarIds.forEach(function (id) {
        const def = R.get(id);
        assert(def && def.ui && def.ui.toggle, id + ' has its 2D switch in the registry');
    });
    // The seven module-backed layers declare HOW their module turns a tile into
    // a URL; the two same-origin ones (SE/DK) build theirs inside the module.
    ['lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt', 'lidar.es-mdt',
     'lidar.ch-swisstopo', 'lidar.uk-ea', 'lidar.dk-dhm',
     'lidar.se-lantmateriet'].forEach(function (id) {
        const def = R.get(id);
        assert(def.builder && def.builder.module && def.builder.fn && def.builder.kind,
            id + ' declares the module, function and call shape of its tile URLs');
    });
    assert(!R.get('lidar.fr-mnh').builder,
        'France needs no module builder: it is a plain WMS with a product table');

    // Every country LiDAR layer has a real tile URL for a real tile — including
    // the five whose builders need a bbox, which no {z}/{x}/{y} template can
    // express. This is what "never silently skip a layer" means.
    const bboxIds = ['lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt',
        'lidar.es-mdt', 'lidar.se-lantmateriet'];   /* SE: same-origin token route */
    bboxIds.forEach(function (id) {
        const url = R.tileUrlAt(R.get(id), 12, 2266, 1348, { modules: modules });
        assert(url && (url.indexOf('http') === 0 || url.indexOf('/api/') === 0),
            id + ' returns a per-tile URL (got ' + JSON.stringify(url) + ')');
        assert(url.indexOf('{z}') === -1 && url.indexOf('{bbox') === -1,
            id + ' resolves the tile box itself, no placeholders left');
    });
    const plUrl = R.tileUrlAt(R.get('lidar.pl-nmt'), 12, 2266, 1348, { modules: modules });
    assert(/mapy\.geoportal\.gov\.pl.*GetMap/.test(plUrl) && /CRS=EPSG%3A3857/.test(plUrl),
        'the Polish NMT layer asks its own module for a Web-Mercator GetMap');
    const ahnUrl = R.tileUrlAt(R.get('lidar.nl-ahn'), 12, 2266, 1348, { modules: modules });
    assert(/exportImage/.test(ahnUrl) && /bboxSR=3857/.test(ahnUrl),
        'the Dutch AHN layer keeps its ArcGIS exportImage form');
    assert(R.tileUrlAt(R.get('lidar.pl-nmt'), 12, 2266, 1348, {}) === '',
        'without the module the registry reports "no URL" instead of inventing one');

    // MapLibre cannot template a bbox URL, so the registry hands it a
    // dl3d:// protocol URL and the viewer resolves it per tile.
    bboxIds.forEach(function (id) {
        const tiles = R.map3dTiles(R.get(id), { modules: modules });
        assert(tiles.length === 1 && tiles[0].indexOf('dl3d://' + id + '/') === 0,
            id + ' is handed to MapLibre as a dl3d:// protocol URL');
    });
    assert(viewer.includes("addProtocol('dl3d'") && viewer.includes('REGISTRY.tileUrlAt('),
        'the viewer registers the dl3d:// protocol and calls the registry per tile');
    assert(viewer.includes("error: 'terrain|dem'") === false, 'no stray template in the viewer');

    // The tile-kind LiDAR layers keep a normal template (no protocol needed).
    ['lidar.ch-swisstopo', 'lidar.uk-ea', 'lidar.dk-dhm'].forEach(function (id) {
        const tiles = R.map3dTiles(R.get(id), { modules: modules });
        assert(tiles.length === 1 && tiles[0].indexOf('dl3d://') === -1 &&
               tiles[0].indexOf('{z}') !== -1,
            id + ' keeps a plain {z}/{x}/{y} template');
    });

    // When a host turns out to have no CORS, the same layer goes through the
    // proxy — which runs the very same module in Node.
    const proxied = R.map3dTiles(R.get('lidar.pl-nmt'), { modules: modules, forceProxy: true });
    assert(proxied[0].indexOf('/api/map3d/tile?layer=lidar.pl-nmt') === 0,
        'a no-CORS country layer switches to the same-origin proxy');
    const fromProxy = lib.buildUpstreamUrl(R.get('lidar.pl-nmt'), { z: 12, x: 2266, y: 1348 });
    assert(/mapy\.geoportal\.gov\.pl.*GetMap/.test(fromProxy.url),
        'the proxy builds the same per-tile URL server-side');

    // The registry can therefore report every one of the 91 layers as draped.
    const diag = R.diagnostics({ modules: modules });
    assert(diag.totals.layers === 91 && diag.totals.draped === 91,
        'all 91 layers are drapeable when the country modules are present (' +
        diag.totals.draped + ')');
    assert(diag.layers.every(function (l) { return l.drape; }),
        'no layer is silently skipped: each one is draped or explicitly reported');
    assert(R.diagnostics().totals.draped === 83,
        'in the browser the LiDAR modules are always loaded, so only the headless ' +
        'registry (no DOM modules) reports the 9 country layers as pending');

    // Mode switches travel with the request: France MNT/MNS/MNH, and the
    // country renderers (hillshade/DSM/DTM) picked from a 2D dropdown.
    assert(Object.keys(R.modes('lidar.fr-mnh')).length === 3 &&
           /MNS_ELEVATION/.test(R.layerOf(R.get('lidar.fr-mnh'), { mode: 'surface' })),
        'the France product table lives in the registry and follows the dropdown');
    const frSurface = lib.buildUpstreamUrl(R.get('lidar.fr-mnh'), { z: 10, x: 512, y: 340, mode: 'surface' });
    assert(/layers=IGNF_LIDAR-HD_MNS_ELEVATION/.test(frSurface.url),
        'the proxy serves the product the 2D dropdown selected');
    assert(R.map3dTiles(R.get('lidar.fr-mnh'), { forceProxy: true, mode: 'height' })[0]
        .indexOf('&m=height') !== -1,
        'the proxy URL carries the selected product');
    const checkMode = lib.validateTileRequest(new URL(
        'https://x/api/map3d/tile?layer=lidar.fr-mnh&z=10&x=512&y=340&m=..%2Fetc'));
    assert(!checkMode.ok && checkMode.reason === 'bad-mode', 'a malformed mode is refused');

    console.log('  ✓ country LiDAR drapes per tile — nothing is skipped, modes included');

    // ══════════════════════════════════════════════════════════
    // 7. Stacking: the 3D canvas never covers the app's own chrome
    // ══════════════════════════════════════════════════════════
    const skin = read('css/map3d-terrain.css');
    const styles = read('css/styles.css');
    const declaration = function (css, selector, property) {
        const block = css.slice(css.indexOf(selector));
        const body = block.slice(block.indexOf('{'), block.indexOf('}'));
        const match = body.match(new RegExp(property + '\\s*:\\s*([0-9.]+)'));
        return match ? Number(match[1]) : NaN;
    };
    const maxPaneZ = Math.max.apply(null, Object.keys(R.GROUPS).map(function (g) {
        return R.GROUPS[g].z || 0;
    }));
    const surfaceZ = declaration(skin, '#map3d-surface {', 'z-index');
    const toggleZ = declaration(skin, '#map3d-toggle {', 'z-index');
    const barZ = declaration(skin, '#map3d-bar {', 'z-index');
    assert(surfaceZ > maxPaneZ,
        'the 3D canvas (' + surfaceZ + ') sits above every Leaflet pane (' + maxPaneZ + ')');
    ['.map-search-wrap {', '.transp-panel {'].forEach(function (sel) {
        const z = declaration(styles, sel, 'z-index');
        assert(z > surfaceZ && z > toggleZ && z > barZ,
            sel.replace(/ \{|#|\.|:/g, '') + ' stays above the 3D layer (' + z + ' > ' +
            Math.max(surfaceZ, toggleZ, barZ) + ')');
    });
    assert(toggleZ > surfaceZ && barZ > surfaceZ,
        'the 3D toggle and control bar are clickable above the canvas');
    ['#map3d-toggle {', '#map3d-bar {'].forEach(function (sel) {
        const block = skin.slice(skin.indexOf(sel));
        const body = block.slice(0, block.indexOf('}'));
        assert(body.indexOf('bottom') !== -1 && body.indexOf('top: 10px') === -1,
            sel.replace(' {', '') + ' is placed at the bottom edge, clear of the zoom/locate/measure controls');
    });
    assert(/body\.is-3d #detectlab-map \.leaflet-pane \{ visibility: hidden; \}/.test(skin),
        'while 3D is on the Leaflet panes stop painting (no double rasterisation)');
    assert(/body\.is-3d #detectlab-map \.leaflet-control-container/.test(skin) &&
           /body\.is-3d #pwa-br-stack \.leaflet-control/.test(skin),
        "Leaflet's own controls (z-index 1000) are hidden while 3D is on — nobody can " +
        'click a control that moves the map underneath');
    assert(/@media \(max-width: 720px\)/.test(skin) &&
           /#map3d-bar \{\s*top: 56px;/.test(skin),
        'on phones the control bar drops under the search bar instead of covering it');
    assert(/body\.is-3d #map3d-bar \{ display: flex; \}/.test(skin) &&
           !/body\.is-pwa #map3d-bar \{ bottom: 104px/.test(skin),
        'the bar only appears in 3D and sits on the left, clear of the PWA stack');
    assert(viewer.includes("showCompass: true }), 'bottom-right')") &&
           viewer.includes("exaggeration: state.exaggeration\n                }), 'top-right')"),
        "MapLibre's own controls are kept out of the panel / search bar / 3D bar corners");
    console.log('  ✓ the 3D view keeps the search bar, layer panel and PWA stack usable, ' +
        'and hides the 2D-only controls');

    // ══════════════════════════════════════════════════════════
    // 8. CORONA keeps ONE catalogue/selection implementation
    // ══════════════════════════════════════════════════════════
    assert(viewer.includes('CoronaAtlas') && viewer.includes('selectProducts'),
        'the 3D CORONA deck asks the shared atlas for its products');
    assert(!/get_raster_names/.test(viewer),
        'the viewer never re-implements the CORONA catalogue fetch');
    assert(mapApp.includes("layers: 'pano:' + ") === false, 'no stray CORONA catalogue code in map-app.js');

    console.log('\n✅ test-map3d-terrain.js passed all checks successfully.');
}()).catch(function (err) {
    console.error(err);
    process.exit(1);
});
