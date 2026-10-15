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

/* The smallest 2D canvas the mirror's CSS-blend repaint needs. Node has no
 * ImageData and no canvas, so the pixels travel in a plain clamped array and
 * toBlob() hands back those same bytes — enough to prove what the repaint does
 * to every pixel, which is all that can go wrong here. */
const fakeCanvas = function (width, height) {
    const canvas = { width: width, height: height, _pixels: null };
    /* The caller sets width/height after createElement(), exactly as the mirror
     * does, so the pixel buffer follows the size rather than the constructor. */
    const alloc = function () {
        const need = canvas.width * canvas.height * 4;
        if (!canvas._pixels || canvas._pixels.length !== need) canvas._pixels = new Uint8ClampedArray(need);
        return canvas._pixels;
    };
    canvas.getContext = function (kind) {
        if (kind !== '2d') return null;          /* Node has no WebGL: keep the probe honest */
        return {
            drawImage: function (image) { alloc().set(image._pixels.slice(0, canvas.width * canvas.height * 4)); },
            getImageData: function (x, y, w, h) { return { data: alloc().slice(), width: w, height: h }; },
            putImageData: function (frame) { alloc().set(frame.data); }
        };
    };
    canvas.toBlob = function (done) {
        done({ arrayBuffer: function () { return Promise.resolve(alloc().slice().buffer); } });
    };
    return canvas;
};
/* Stand-in for the browser's image decoder: the bytes ARE the pixels here, so
 * retintTile()'s whole chain (bytes → canvas → repaint → PNG bytes) runs. */
const fakeImageDecoder = function (blob) {
    return blob.arrayBuffer().then(function (buffer) {
        return { width: 256, height: 256, _pixels: new Uint8ClampedArray(buffer) };
    });
};
/* The registry-driven viewer sandbox and its live 2D layer, kept for the async
 * blend assertions in §6b (they need promises, and the file's sync blocks do
 * not). */
let viewApi = null;
let viewRo1m = null;
let viewWindow = null;

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
const TAG_3D = '20261015-3d-ramp-merge';        /* mirror                        */
const TAG_VIEWER = '20261015-3d-startup-race';    /* viewer                        */
const TAG_FOCUS = '20261014-lidar-3d-focus';     /* LiDAR focus (3D, one disc)    */
const TAG_REGISTRY = '20261015-danish-layers';     /* shared registry (WMS audit)  */

// ══════════════════════════════════════════════════════════════
// 1. Static wiring — the viewer must be reachable in the app
// ══════════════════════════════════════════════════════════════
{
    const registryTag = indexHtml.indexOf('js/layer-registry.js?v=' + TAG_REGISTRY);
    const mirrorTag = indexHtml.indexOf('js/map3d-mirror.js?v=' + TAG_3D);
    const viewerTag = indexHtml.indexOf('js/map3d-terrain.js?v=' + TAG_VIEWER);
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
           indexHtml.includes('css/map3d-terrain.css?v=20261015-3d-dock-clearance'),
        'index.html loads the MapLibre stylesheet and the 3D skin');
    assert(indexHtml.indexOf('css/maplibre-gl.css') < indexHtml.indexOf('css/map3d-terrain.css'),
        'the 3D skin comes after the stylesheet it re-skins');

    // Service worker: the shell must ship the new modules, and the cache must
    // be bumped so an installed PWA picks the mirrored 3D view up.
    ['js/layer-registry.js?v=' + TAG_REGISTRY, 'js/map3d-mirror.js?v=' + TAG_3D,
     'js/map3d-terrain.js?v=' + TAG_VIEWER, 'js/maplibre-gl.js?v=' + TAG,
     'css/map3d-terrain.css?v=20261015-3d-dock-clearance', 'css/maplibre-gl.css?v=' + TAG,
     'js/lidar-3d-focus.js?v=' + TAG_FOCUS].forEach(function (asset) {
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
    /* A vector that draws itself, like the 20 000 polylines of the Roman roads. */
    function Path(options) { Base.call(this, options); }
    Path.prototype = Object.create(Base.prototype);
    Path.prototype.getOpacity = function () { return this.options.opacity == null ? 1 : this.options.opacity; };
    Path.prototype.toGeoJSON = function () {
        return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: this._coords } };
    };
    /* …and the featureGroup they are added to, which is what the 3D mirror sees.
     * It must really be an L.LayerGroup: that is how the mirror tells a group
     * (walk its children) from one leaf layer. */
    function LayerGroup(options) { Base.call(this, options); }
    LayerGroup.prototype = Object.create(Base.prototype);
    function FeatureGroup(layers, options) { Base.call(this, options); this._layers = (layers || []).slice(); }
    FeatureGroup.prototype = Object.create(LayerGroup.prototype);
    FeatureGroup.prototype.getLayers = function () { return this._layers; };
    FeatureGroup.prototype.eachLayer = function (fn) { this._layers.forEach(function (l) { fn(l); }); };
    FeatureGroup.prototype.addLayer = function (l) { this._layers.push(l); };
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
        VideoOverlay: function () {}, GeoJSON: function () {}, Path: Path,
        LayerGroup: LayerGroup, FeatureGroup: FeatureGroup, MarkerClusterGroup: null,
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

    /* ── the layers the 2D stylesheet blends, and the Roman-roads group ──── */

    /* css/styles.css paints the Romanian 1 m / 2 m LiDAR hillshades with
     * `filter: invert(1); mix-blend-mode: screen`. MapLibre has no blend modes,
     * so the mirror has to carry the blend and the viewer repaint the tile —
     * without both, these layers arrive in 3D as an opaque white sheet (the
     * “Romania 1m/pixel agregare never loads in 3D” report). */
    const ro1m = new TileLayer('https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/{z}/{y}/{x}', {
        name: 'Romania 1m/pixel agregare', className: 'lidar-ro1m-tiles',
        maxNativeZoom: 16, opacity: 0.85, pane: 'pane_lidar'
    });
    ro1m._leaflet_id = 'R1';
    const roMap = {
        getPane: function () { return { style: { zIndex: '610' }, ownerDocument: null }; },
        eachLayer: function (fn) { fn(ro1m); },
        hasLayer: function () { return true; }
    };
    const roItem = mirror.describe(ro1m, roMap, {});
    assert(roItem && roItem.kind === 'raster' && roItem.blend === 'invert-screen',
        'a CSS-blended 2D layer carries its blend into 3D instead of draping a white sheet of tiles');
    assert(roItem.render === 'url' && roItem.template === 'dl2d://2d.R1/{z}/{x}/{y}',
        'the blended layer still asks its own 2D layer for every tile URL');
    assert(roItem.maxzoom === 16,
        'the 1 m service is never asked past its native zoom — MapLibre overzooms the z16 tiles instead');
    assert(mirror.blendOf(new TileLayer('u', { className: 'lidar-ro2m-tiles' })) === 'invert-screen' &&
           mirror.blendOf(layer) === null,
        'only the layers the stylesheet blends are repainted; everything else keeps the pixels it was sent');

    /* The repaint is the stylesheet's arithmetic, in the pixels: screen over the
     * base is white with alpha 1 − luminance. */
    const ramp = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 7, 7, 7, 0]);
    const blended = mirror.blendPixels({ data: ramp, width: 2, height: 2 }, 'invert-screen');
    assert(blended.data[0] === 255 && blended.data[1] === 255 && blended.data[2] === 255 && blended.data[3] === 255,
        'a black tile pixel becomes opaque white — the hillshade line of the inverted tile');
    assert(blended.data[7] === 0,
        'the white ArcGIS background becomes fully transparent: this is the white sheet the 2D CSS filter removes');
    assert(Math.abs(blended.data[11] - 127) <= 1, 'mid grey becomes half-transparent white');
    assert(blended.data[15] === 0, 'a tile pixel that is already transparent stays invisible');
    let worstBlend = 0;
    for (let c = 0; c < 256; c += 1) {
        const px = mirror.blendPixels({ data: new Uint8ClampedArray([c, c, c, 255]) }, 'invert-screen').data;
        const base = 0.35;                                   /* any base, not just a dark one */
        const css = 1 - (1 - base) * (c / 255);              /* screen(base, invert(tile))    */
        const ours = px[3] / 255 + (1 - px[3] / 255) * base; /* white, alpha 1 − luma         */
        worstBlend = Math.max(worstBlend, Math.abs(css - ours));
    }
    assert(worstBlend < 1 / 255,
        'the repainted tile equals screen(invert(tile)) within a rounding step (worst ' + worstBlend.toFixed(4) + ')');

    /* A group of siblings that draw identically becomes ONE 3D source. The
     * Roman roads are ~20 000 polylines in a featureGroup; one source, one
     * layer and one 500 KB signature per polyline is what crashed the page as
     * soon as 3D was switched on. */
    function roads(count) {
        const kids = [];
        for (let i = 0; i < count; i += 1) {
            const road = new Path({ color: '#FF5A36', weight: 1.8, opacity: 0.8, interactive: false, pane: 'pane_roman' });
            road._leaflet_id = 'p' + i;
            road._coords = [[26, 44 + i * 1e-5], [26.1, 44.1 + i * 1e-5]];
            kids.push(road);
        }
        const group = new FeatureGroup(kids, { pane: 'pane_roman' });
        group._leaflet_id = 'G1';
        return group;
    }
    const group = roads(25001);
    const groupMap = {
        getPane: function () { return { style: { zIndex: '625' }, ownerDocument: null }; },
        eachLayer: function (fn) { fn(group); },
        hasLayer: function () { return true; }
    };
    const bundled = mirror.collect(groupMap);
    assert(bundled.items.length === 2,
        '25 001 identically-painted polylines become 2 3D sources (20 000 features each)');
    assert(bundled.items[0].geojson.features.length === 20000 &&
           bundled.items[1].geojson.features.length === 5001,
        'the merge splits on the feature budget and keeps every feature');
    assert(bundled.items[0].key === '2d.G1/b1' && bundled.items[1].key === '2d.G1/b2',
        'a bundle gets its own key, so it maps to its own 3D source');
    assert(bundled.items[0].count === 20000 && /\(20,000 features\)/.test(bundled.items[0].label),
        'the bundle label says how much of the group it carries — the status panel cannot overstate it');
    assert(bundled.signature.length < 400,
        'the signature of a merged group is a handful of bytes, not one entry per polyline (' +
        bundled.signature.length + ' chars)');
    const bundling = bundled.signature;
    const again = mirror.collect(groupMap);
    assert(again.signature === bundling && again.items[0] === bundled.items[0],
        'the second collect (the 1.5 s poll while 3D is open) returns the cached bundles unchanged');
    mirror.invalidate(group);
    const fresh = mirror.collect(groupMap);
    assert(fresh.items[0] !== bundled.items[0] && fresh.signature === bundling,
        'invalidate() drops the cache without changing what the group contains');
    group.getLayers()[0].options.opacity = 0.4;
    const restyled = mirror.collect(groupMap);
    assert(restyled.items[0] !== fresh.items[0] &&
           restyled.items[0].paints.line['line-opacity'] === 0.4,
        'the opacity slider is noticed even though the child count did not change');
    /* Distinct paints cannot be merged — but the deck has a ceiling, and what it
     * had to leave out is reported instead of silently dropped.
     *
     * The group is deliberately bigger than the per-group budget (MIXED children
     * with a distinct weight each, so no two of them share a paint) so the
     * ceiling is actually reached and the "capped" note is produced. */
    const MIXED = 300;
    const mixedKids = [];
    for (let i = 0; i < MIXED; i += 1) {
        const road = new Path({ color: '#0000' + (10 + (i % 30)), weight: 1 + i, opacity: 0.9 });
        road._leaflet_id = 'm' + i;
        road._coords = [[26, 44 + i * 1e-3], [26.1, 44.1 + i * 1e-3]];
        mixedKids.push(road);
    }
    const mixed = new FeatureGroup(mixedKids, {});
    mixed._leaflet_id = 'G2';
    const mixedRes = mirror.collect({
        getPane: function () { return { style: { zIndex: '600' }, ownerDocument: null }; },
        eachLayer: function (fn) { fn(mixed); },
        hasLayer: function () { return true; }
    });
    assert(mixedRes.items.length === mirror.BUDGET.maxBundlesPerGroup,
        'a group whose children all paint differently stops at the per-group bundle budget (' +
        mixedRes.items.length + ')');
    assert(mixedRes.capped.length === 1 && /six|6|budget/i.test(mixedRes.capped[0]),
        'what the budget left out is reported (capped) so the 3D panel can say so — got: ' +
        mixedRes.capped.join('; '));

    /* But a group that merely LOOKS like it has a distinct paint per child —
     * every sibling drawn from a continuous ramp, which is what Battles, the
     * Archeological Potential bubbles and the analysis results all do — must
     * NOT be truncated by that ceiling. The mirror quantises the paint it builds
     * (colour channels and circle radius), so those siblings merge and the whole
     * group survives. Regression guard for "these layers cannot be visualised
     * in 3D". */
    const rampKids = [];
    for (let i = 0; i < 60; i += 1) {
        const bubble = new Path({
            color: '#285ac8', weight: 1.2, opacity: 0.9,
            fillColor: '#285ac8', fillOpacity: 0.3 + (i % 3) * 0.1,
            radius: 60 + i * 7
        });
        bubble._leaflet_id = 'r' + i;
        bubble._coords = [[26, 44 + i * 1e-3], [26.1, 44.1 + i * 1e-3]];
        rampKids.push(bubble);
    }
    const rampGroup = new FeatureGroup(rampKids, {});
    rampGroup._leaflet_id = 'G3';
    const rampRes = mirror.collect({
        getPane: function () { return { style: { zIndex: '600' }, ownerDocument: null }; },
        eachLayer: function (fn) { fn(rampGroup); },
        hasLayer: function () { return true; }
    });
    assert(rampRes.capped.length === 0,
        'a group drawn from a continuous ramp is never truncated by the merge budget (' +
        rampRes.capped.join('; ') + ')');
    assert(rampRes.items.length < rampKids.length,
        'and its ramp-coloured siblings do merge (' + rampRes.items.length + ' bundles for ' +
        rampKids.length + ' children)');

    /* The deck has a hard ceiling, and the mirror stops *walking* once it is
     * reached: 4 000 loose sibling-less layers must not be described (and their
     * 4 000 sources created) just so the budged could then drop them. */
    const scattered = [];
    for (let i = 0; i < 4000; i += 1) {
        const one = new Path({ color: '#12345' + (i % 10), weight: 1 + (i % 7), opacity: 0.9 });
        one._leaflet_id = 's' + i;
        one._coords = [[26, 44 + i * 1e-4], [26.1, 44.1 + i * 1e-4]];
        scattered.push(one);
    }
    const scatteredMap = {
        getPane: function () { return { style: { zIndex: '600' }, ownerDocument: null }; },
        eachLayer: function (fn) { scattered.forEach(fn); },
        hasLayer: function () { return true; }
    };
    const deck = mirror.collect(scatteredMap);
    assert(deck.items.length === 400,
        'the 3D deck never exceeds its 400-layer budget (' + deck.items.length + ')');
    assert(deck.capped.length >= 1 && /budget/.test(deck.capped.join(' ')),
        'and says what the budget left out instead of silently hiding layers');

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
        createElement(tag) { return tag === 'canvas' ? fakeCanvas(32, 32) : stubElement(); },
        getElementById() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() {}, removeEventListener() {}
    };
    const windowStub = {
        document: documentStub,
        Blob: Blob,                       /* the blend repaint round-trips its bytes through one */
        URL: URL,
        createImageBitmap: fakeImageDecoder,
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
        Blob: Blob, URL: URL, Promise: Promise,
        setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator };
    vm.createContext(sandbox);
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });

    const api = windowStub.DetectLabMap3D;
    assert(api, 'window.DetectLabMap3D is exported');
    viewApi = api;
    ['open', 'close', 'toggle', 'isOpen', 'getMap', 'syncLayers', 'setExaggeration', 'getExaggeration',
     'setPitch', 'setBearing', 'resetView', 'status', 'report', 'registry', 'mirror',
     '_blendedTile', '_setSourceData', '_setSourceTiles'].forEach(function (fn) {
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
    assert(Array.isArray(status.capped) && typeof status.retintedTiles === 'number',
        'status() carries the deck budget (“capped”) and the count of repainted blend tiles');

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
    /* A live 2D map, so §6 can drive the real mirror → viewer path: the
     * Romanian 1 m hillshade, added exactly as map-app.js adds it (an ArcGIS
     * XYZ tile layer with the stylesheet's blend class). */
    function StubTileLayer(url, options) { this.options = options || {}; this._url = url; }
    StubTileLayer.prototype.getTileSize = function () { return { x: 256, y: 256 }; };
    StubTileLayer.prototype.getTileUrl = function (coords) { return this._url + '/' + coords.z + '/' + coords.x + '/' + coords.y; };
    StubTileLayer.prototype.getOpacity = function () { return this.options.opacity == null ? 1 : this.options.opacity; };
    const ro1mLayer = new StubTileLayer('https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/{z}/{y}/{x}', {
        name: 'Romania 1m/pixel agregare', className: 'lidar-ro1m-tiles', maxNativeZoom: 16,
        opacity: 0.85, pane: 'pane_lidar'
    });
    ro1mLayer._leaflet_id = 'R1';
    windowStub.L = {
        TileLayer: StubTileLayer, Marker: function () {}, ImageOverlay: function () {},
        SVGOverlay: function () {}, VideoOverlay: function () {}, GeoJSON: function () {},
        Path: function () {}, LayerGroup: function () {}, MarkerClusterGroup: null,
        stamp: function (layer) { layer._leaflet_id = layer._leaflet_id || 'x1'; return layer._leaflet_id; }
    };
    viewWindow = windowStub;
    viewWindow._dlMap = {
        getPane: function () { return { style: { zIndex: '610' }, ownerDocument: null }; },
        eachLayer: function (fn) { fn(ro1mLayer); },
        hasLayer: function () { return true; }
    };
    viewRo1m = ro1mLayer;
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
    // 6b. The Romanian LiDAR hillshades: blended in 2D, repainted for 3D
    // ══════════════════════════════════════════════════════════
    /* The mirror sees the live 2D layer the way map-app.js adds it … */
    const mirrorDeck = viewApi._mirror();
    const ro1mItem = mirrorDeck.items.filter(function (i) { return i.key === '2d.R1'; })[0];
    assert(ro1mItem && ro1mItem.kind === 'raster' && ro1mItem.blend === 'invert-screen',
        '“Romania 1m/pixel agregare” reaches the 3D deck as a raster carrying the CSS blend');
    assert(ro1mItem.template === 'dl2d://2d.R1/{z}/{x}/{y}' && ro1mItem.opacity === 0.85,
        'its tiles are asked of the 2D layer itself, at the opacity the 2D slider is on');
    assert(viewApi.status().mirrored.some(function (m) { return m.blend === 'invert-screen'; }),
        'status() names the emulated blend, so a support report can show it');

    /* …and the viewer repaints each of its tiles: white, alpha 1 − luminance. */
    const SIZE = 256;
    const image = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let i = 0; i < image.length; i += 4) {
        const c = (i / 4) % 256;                 /* a grayscale hillshade ramp: black → white */
        image[i] = image[i + 1] = image[i + 2] = c;
        image[i + 3] = 255;
    }
    const tileUrl = 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/16/2345/1234';
    const repainted = new Uint8ClampedArray(await viewApi._blendedTile(viewRo1m, tileUrl, image.buffer));
    assert(repainted.length === image.length, 'the repaint keeps the tile size (a 256² tile is still 256²)');
    assert(repainted[0] === 255 && repainted[1] === 255 && repainted[2] === 255 && repainted[3] === 255,
        'the darkest pixel of the tile is opaque white');
    assert(repainted[255 * 4 + 3] === 0,
        'the white ArcGIS background pixel is fully transparent — the white sheet is gone in 3D too');
    assert(repainted.some(function (v, i) { return i % 4 === 3 && v > 0 && v < 255; }),
        'the hillshade itself stays visible, as white lines at partial alpha');
    assert(viewApi.status().retintedTiles === 1, 'a repainted tile is counted (status().retintedTiles)');

    /* Second request for the same tile: from the repaint cache, not the network,
     * and never the same buffer (MapLibre may take ownership of it). */
    const again = new Uint8ClampedArray(await viewApi._blendedTile(viewRo1m, tileUrl, image.buffer));
    assert(viewApi.status().retintedTiles === 1 && again[0] === repainted[0] && again[3] === repainted[3],
        'the same tile is repainted once and served from the cache afterwards');
    assert(again.buffer !== repainted.buffer,
        'the cached bytes are copied out, so MapLibre cannot detach the cache’s buffer');

    /* A layer the stylesheet does not blend must keep the pixels it was sent. */
    const plain = new Uint8ClampedArray(image);
    const untouched = new Uint8ClampedArray(await viewApi._blendedTile(
        { options: {}, getTileSize: function () { return { x: 256, y: 256 }; } }, 'https://example.org/plain/1/1/1', plain.buffer));
    assert(untouched[3] === 255 && untouched[0] === 0, 'a layer without a blend class is passed through untouched');
    assert(viewApi._setSourceData('m3d-2d-2d.R1-src', null) === false,
        'setSourceData() is inert while no 3D map is open (it never throws at the caller)');

    /* A layer the deck budget leaves out must explain itself, once: the
     * complaint that starts this whole section. */
    const savedDlMap = viewWindow._dlMap;
    const loose = [];
    for (let i = 0; i < 2000; i += 1) {
        const one = Object.create(viewWindow.L.Path.prototype);
        one.options = { color: '#1a2b3c', weight: 3, opacity: 1 };
        one._leaflet_id = 'loose' + i;
        one.toGeoJSON = function () { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[26, 44], [26.1, 44.1]] } }; };
        loose.push(one);
    }
    viewWindow._dlMap = {
        getPane: function () { return { style: { zIndex: '600' }, ownerDocument: null }; },
        eachLayer: function (fn) { loose.forEach(fn); },
        hasLayer: function () { return true; }
    };
    const budgetLines = function () {
        return viewApi.status().errors.map(function (e) { return e.message; })
            .filter(function (m) { return /budget/.test(m); });
    };
    viewApi._mirror();
    viewApi._mirror();
    const budgetFirst = budgetLines();
    viewApi._mirror();
    const budgetSecond = budgetLines();
    assert(budgetFirst.length >= 1 && budgetSecond.length === budgetFirst.length &&
           budgetFirst.every(function (m, i) { return budgetFirst.indexOf(m) === i; }),
        'a deck that hit its budget says so in status().errors — each line once, not on every poll');
    viewWindow._dlMap = savedDlMap;

    /* The wiring itself: the dl2d:// protocol repaints, and no renderer may
     * re-upload data MapLibre already has (a 20 000-feature reparse per pan is
     * exactly what made 3D crawl while the Roman roads were on). */
    assert(viewer.includes('return blendedTile(layer, url, tile.data)'),
        'the dl2d:// protocol sends fetched tiles through the blend repaint');
    assert(viewer.includes('setSourceData(sourceId, item.geojson)') &&
           !/\.setData\(/.test(viewer.replace(/source\.setData\(data\);/g, '')),
        'every GeoJSON upload goes through setSourceData() — the only setData() left is the one inside it');
    assert(viewer.includes('if (state.sourceData[sourceId] === data) return true;'),
        'setSourceData() skips the re-upload when MapLibre already holds that exact object');
    assert(viewer.includes('if (!force && state.sourceTiles[sourceId] === key) return true;'),
        'setSourceTiles() skips the reload when the tile template has not changed — a steady-state sync must not ' +
        'restart every LiDAR tile request (that is what made 3D “load forever”)');
    assert(viewer.includes('setSourceTiles(sourceId, source.tiles.slice(), true)'),
        'a host healed to the proxy still forces the reload — the template is unchanged but must be re-resolved');
    assert(viewApi._setSourceTiles('m3d-2d-2d.R1-src', ['dl2d://2d.R1/{z}/{x}/{y}']) === false,
        'setSourceTiles() is inert while no 3D map is open');
    assert((viewer.match(/state\.sourceData\[sourceId\] = /g) || []).length === 5,
        'the upload cache is written by setSourceData() and by each of the four GeoJSON renderers');
    console.log('  ✓ the blended LiDAR hillshades are repainted (and cached), not painted as a white sheet');

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
