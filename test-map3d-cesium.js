#!/usr/bin/env node
/* test-map3d-cesium.js — the “Cesium” basemap alternative for 3D mode.
 *
 * The MapTiler terrain-quantized-mesh-v2 TileJSON user supplied is a
 * quantized-mesh-1.0 terrain for CesiumJS, not a MapLibre raster-dem
 * (terrarium/mapbox), so this suite pins:
 *   1. the registry resolves it as a separate `cesiumTerrain()` (label
 *      "Cesium", tiles.json + tile template, octvertexnormals, z0–15,
 *      attribution, SDK URLs) without touching the default AWS DEM;
 *   2. diagnostics/status expose it;
 *   3. the 3D basemap picker offers <option value="cesium">Cesium</option>,
 *      routes picking it to activateCesium() (real Cesium.Viewer +
 *      CesiumTerrainProvider.fromUrl) and picking an ArcGIS entry back to
 *      deactivateCesium() + the shared 2D basemap setter;
 *   4. the viewer hard-codes no service URL (all URLs come from the registry);
 *   5. camera maths: Web-Mercator zoom ↔ Cesium height round-trips;
 *   6. the failure path reverts to MapLibre (no viewer, engine restored).
 *
 * No GPU / network: activation is driven against a stub Cesium namespace in
 * a vm sandbox, the same way test-map3d-terrain.js drives MapLibre.
 * Run: node test-map3d-cesium.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const viewer = read('js/map3d-terrain.js');
const skin = read('css/map3d-terrain.css');

console.log('[Test] Cesium basemap alternative for 3D mode...');

// ══════════════════════════════════════════════════════════════
// 1. Registry: quantized-mesh provider, separate from raster-dem
// ══════════════════════════════════════════════════════════════
{
    const R = require('./js/layer-registry.js');
    const c = R.cesiumTerrain();
    assert.strictEqual(c.label, 'Cesium', 'the alternative is named Cesium');
    assert.strictEqual(c.name, 'Cesium', 'the alternative carries name "Cesium"');
    assert.strictEqual(c.engine, 'cesium', 'it is a Cesium engine, not a raster-dem source');
    assert.strictEqual(c.format, 'quantized-mesh-1.0', 'quantized-mesh format from the TileJSON');
    assert(c.extensions.includes('octvertexnormals'), 'octvertexnormals extension requested');
    assert.strictEqual(c.minzoom, 0, 'TileJSON minzoom 0');
    assert.strictEqual(c.maxzoom, 15, 'TileJSON maxzoom 15');
    assert.strictEqual(
        c.tilesJson,
        'https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/tiles.json?key=lJtTFcjiimg8ZwMPUfpf',
        'CesiumTerrainProvider is fed the supplied tiles.json URL');
    assert.strictEqual(
        c.tileTemplate,
        'https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/{z}/{x}/{y}.quantized-mesh-1.0?key=lJtTFcjiimg8ZwMPUfpf',
        'the supplied quantized-mesh tile template is registered');
    assert.deepStrictEqual(c.tiles, [c.tileTemplate], 'tiles[] mirrors the TileJSON tiles entry');
    assert(/MapTiler/.test(c.attribution) && /OpenStreetMap/.test(c.attribution),
        'attribution comes from the TileJSON (MapTiler / OSM)');
    assert(/cesium@1\.131\.0/.test(c.sdk.js), 'the CesiumJS SDK is lazy-loaded from a pinned CDN build');
    assert(Array.isArray(c.sdk.jsFallbacks) && c.sdk.jsFallbacks.length >= 2, 'SDK fallbacks are configured');
    assert(/Build\/Cesium\/$/.test(c.sdk.baseUrl), 'CESIUM_BASE_URL points at the Build/Cesium folder');

    // The MapLibre DEM must be untouched: quantized-mesh never leaks into it.
    const dem = R.terrainSource();
    assert.strictEqual(dem.provider, 'aws-terrarium', 'the default MapLibre DEM stays AWS Terrarium');
    assert(!/quantized-mesh/.test(dem.tiles.join(' ')), 'the raster-dem source never receives mesh tiles');
    assert.strictEqual(R.diagnostics().cesium.tilesJson, c.tilesJson, 'diagnostics expose the Cesium terrain');
    assert.strictEqual(typeof R.cesiumTerrain, 'function', 'cesiumTerrain() is exported');
    console.log('  ✓ registry resolves the Cesium quantized-mesh terrain separately from the raster DEM');
}

// ══════════════════════════════════════════════════════════════
// 2. Viewer wiring: picker, engine switch, lifecycle, CSS
// ══════════════════════════════════════════════════════════════
{
    assert(viewer.includes('<option value="cesium">'), 'the 3D basemap picker offers a Cesium option');
    assert(viewer.includes("basemapCesium: 'Cesium'"), 'the option is labelled exactly “Cesium” (ro + en)');
    assert(viewer.includes("if (basemapSelect.value === 'cesium')") && viewer.includes('activateCesium();'),
        'picking Cesium activates the Cesium engine');
    assert(viewer.includes("if (state.engine === 'cesium') deactivateCesium(true);") &&
        viewer.includes('root.setArcgisBasemap(basemapSelect.value)'),
        'picking an ArcGIS entry hands the camera back and restores the shared 2D basemap route');
    assert(viewer.includes('CesiumTerrainProvider.fromUrl(cfg.tilesJson, { requestVertexNormals: true })'),
        'terrain comes from CesiumTerrainProvider.fromUrl(tilesJson) with vertex normals');
    assert(viewer.includes('new Cesium.Viewer(el, {'), 'a real Cesium.Viewer is created');
    assert(viewer.includes('new Cesium.UrlTemplateImageryProvider({') &&
        viewer.includes('url: imageryTemplate,'),
        'the ArcGIS basemap is draped via UrlTemplateImageryProvider');
    assert(viewer.includes('function cesiumImageryTemplate()') &&
        viewer.includes("'base.terrain-base'"),
        'the draped imagery follows the active ArcGIS basemap (terrain → Terrain Base)');
    assert(viewer.includes('loadCesium()') && viewer.includes('root.CESIUM_BASE_URL'),
        'CesiumJS is lazy-loaded with CESIUM_BASE_URL derived from the winning CDN URL');
    assert(viewer.includes('deactivateCesium(true)') && viewer.includes('cesiumViewer.destroy()'),
        'leaving 3D / leaving Cesium destroys the viewer');
    assert(!/https?:\/\/[a-z0-9.-]+\//i.test(viewer),
        'the viewer hard-codes no service URL — every URL comes from the registry');
    assert(skin.includes('#map3d-cesium') && skin.includes('#map3d-surface.is-cesium .maplibregl-canvas-container'),
        'the Cesium container covers the MapLibre canvas inside the same surface');
    console.log('  ✓ picker, engine switch, lazy SDK load and teardown are wired');
}

// ══════════════════════════════════════════════════════════════
// 3. Camera maths + imagery template (vm sandbox, stub Cesium)
// ══════════════════════════════════════════════════════════════
(async function () {
    const documentStub = {
        createElement: function () {
            return { style: {}, classList: { add() {}, remove() {}, toggle() {} },
                setAttribute() {}, appendChild() {}, querySelector() { return null; },
                querySelectorAll() { return []; }, addEventListener() {} };
        },
        getElementById: function () { return null; },
        addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {} } },
        documentElement: { lang: 'en' }, head: { appendChild() {} }
    };
    const windowStub = {
        console: console, document: documentStub,
        navigator: { onLine: true }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener() {}, removeEventListener() {}, matchMedia: function () { return { matches: false }; },
        location: { search: '' }, getArcgisBasemap: function () { return 'terrain'; }
    };
    windowStub.window = windowStub;
    const sandbox = { window: windowStub, document: documentStub, console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout, navigator: windowStub.navigator,
        Promise: Promise, Blob: Blob, URL: URL };
    vm.createContext(sandbox);
    vm.runInContext(read('js/layer-registry.js'), sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(read('js/map3d-mirror.js'), sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });

    const api = windowStub.DetectLabMap3D;
    assert(api, 'window.DetectLabMap3D is exported');
    assert.strictEqual(typeof api._activateCesium, 'function', 'activation is exposed for tests');
    assert.strictEqual(api.getEngine(), 'maplibre', '3D starts on the MapLibre engine');
    assert.strictEqual(api._cesiumTerrain().label, 'Cesium', 'status/config expose Cesium by name');
    assert.strictEqual(api._cesiumImageryTemplate(),
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
        'terrain basemap → Esri World Terrain Base is draped on the globe');
    windowStub.getArcgisBasemap = function () { return 'imagery'; };
    assert(/World_Imagery/.test(api._cesiumImageryTemplate()), 'imagery basemap → World Imagery is draped');

    for (const z of [3, 8, 13, 17]) {
        const h = api._cesiumHeightForZoom(z, 45);
        assert(h > 0, 'a zoom has a camera height');
        assert(Math.abs(api._cesiumZoomForHeight(h, 45) - z) < 0.6,
            'zoom ↔ height round-trips at z' + z + ' (got ' + api._cesiumZoomForHeight(h, 45) + ')');
    }

    // Failure path: no Cesium namespace, no 3D open → stays MapLibre.
    assert.strictEqual(await api._activateCesium(), false, 'Cesium cannot activate while 3D is closed');
    assert.strictEqual(api.getEngine(), 'maplibre', 'a refused activation leaves MapLibre in charge');
    assert.strictEqual(api.getCesiumViewer(), null, 'no viewer leaks from a refused activation');
    assert.strictEqual(api.status().cesium.active, false, 'status reports Cesium inactive');
    assert.strictEqual(api.status().cesium.terrain.tilesJson,
        'https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/tiles.json?key=lJtTFcjiimg8ZwMPUfpf',
        'status() carries the Cesium tiles.json');
    console.log('  ✓ camera maths round-trips and the closed/failure paths stay on MapLibre');

    console.log('\n✅ test-map3d-cesium.js passed all checks successfully.');
})().catch(function (err) {
    console.error(err);
    process.exit(1);
});
