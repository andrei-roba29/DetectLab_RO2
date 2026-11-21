'use strict';
// Run: node test-3d-lidar-gray-backing.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const viewer = fs.readFileSync('js/map3d-terrain.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const translations = fs.readFileSync('js/translations.js', 'utf8');
const css = fs.readFileSync('css/map3d-terrain.css', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const ids = ['Ro2m', 'Ro5m', 'Ro1m'];
ids.forEach(id => {
    assert(html.includes(`id="lidar${id}DisableTransparency"`));
    assert(html.includes(`id="lidar${id}OpacitySlider"`));
});
assert(html.match(/data-key="lidar_disable_transparency"/g).length === 3);
assert(translations.includes("lidar_disable_transparency: 'Disable transparency'"));
assert(translations.includes("lidar_disable_transparency: 'Dezactivează transparența'"));
assert(css.includes('body.is-3d .lidar-gray-backing-option'));
for (const asset of ['js/map3d-terrain.js', 'js/translations.js', 'css/map3d-terrain.css']) {
    const tag = asset.endsWith('.css') ? '20261102-report-lidar-window'
        : asset === 'js/map3d-terrain.js' ? '20261121-3d-touch-twist'
        : '20261102-ro-heritage';
    assert(html.includes(`${asset}?v=${tag}`));
    assert(sw.includes(`${asset}?v=${tag}`));
}

const layers = {}, sources = {}, controls = {};
ids.forEach(id => { controls[`lidar${id}DisableTransparency`] = { checked: false }; });
const map = {
    getSource: id => sources[id], getLayer: id => layers[id],
    addSource(id, spec) { sources[id] = { ...spec, setData(data) { this.data = data; } }; },
    removeSource(id) { delete sources[id]; },
    addLayer(spec) { layers[spec.id] = spec; },
    removeLayer(id) { delete layers[id]; },
    setPaintProperty(id, key, value) { layers[id].paint[key] = value; }
};
let discCalls = 0;
const context = {
    map, document: { getElementById: id => controls[id] },
    state: { focus: { scope: 'disc', mask: { lat: 45, lng: 25, radiusKm: 1 }, bounds: [24, 44, 26, 46] }, sourceData: {}, status: {} },
    MIRROR: { disc: { geojson(mask) { discCalls++; return { type: 'FeatureCollection', mask: { ...mask }, features: [] }; } } },
    focusMatches: () => true, focusScope: f => f.scope, planForLayer: () => null,
    rasterTilesFor: () => ['dl2d://test'], photoInfoFor: () => null,
    fadeDuration: () => 0, setSourceTiles: () => {}, shouldProxy: () => false, hostOfUrl: () => '',
};
// Execute the actual renderer and its data-upload helper with a mock MapLibre map.
vm.createContext(context);
vm.runInContext(viewer.slice(viewer.indexOf('    function setSourceData('), viewer.indexOf('    /* setTiles()')) +
    viewer.slice(viewer.indexOf('    /* A solid backing belongs'), viewer.indexOf('    /**\n     * The tile template of a mirrored raster layer.')), context);
function render(key, opacity) {
    return context.renderRaster({ id: 'layer-' + key, item: { key, lidarKey: 'lidar.' + key, opacity, kind: 'raster' } });
}
let result = render('ro2m', 1);
assert.deepStrictEqual(Array.from(result.layerIds), ['layer-ro2m']);
controls.lidarRo2mDisableTransparency.checked = true;
result = render('ro2m', 1);
assert.deepStrictEqual(Array.from(result.layerIds), ['layer-ro2m-gray', 'layer-ro2m']);
// The renderer's returned order is consumed by the real deck-order function.
vm.runInContext(viewer.slice(viewer.indexOf('    function computeDeckOrder('), viewer.indexOf('    /** Deterministic stacking:')), context);
const order = context.computeDeckOrder([
    { id: 'base', z: 1, seq: 1, layerIds: ['base'] },
    { id: 'layer-ro2m', z: 2, seq: 2, layerIds: result.layerIds },
    { id: 'labels', z: 3, seq: 3, layerIds: ['labels'] }
], { base: true, 'layer-ro2m-gray': true, 'layer-ro2m': true, labels: true }, [], 'base');
assert.deepStrictEqual(Array.from(order), ['base', 'layer-ro2m-gray', 'layer-ro2m', 'labels']);
assert.strictEqual(layers['layer-ro2m-gray'].paint['fill-color'], '#808080');
assert.strictEqual(layers['layer-ro2m-gray'].paint['fill-opacity'], 1);
assert.strictEqual(sources['layer-ro2m-gray-src'].data.mask.radiusKm, 1);
render('ro2m', 0.35);
assert.strictEqual(layers['layer-ro2m-gray'].paint['fill-opacity'], 0.35);
assert.strictEqual(layers['layer-ro2m'].paint['raster-opacity'], 0.35);
assert.strictEqual(discCalls, 1, 'unchanged disc is not re-uploaded on every sync');
render('ro2m', 0);
assert.strictEqual(layers['layer-ro2m-gray'].paint['fill-opacity'], 0);
context.state.focus.mask = { lat: 46, lng: 25, radiusKm: 2 };
render('ro2m', 1);
assert.strictEqual(sources['layer-ro2m-gray-src'].data.mask.radiusKm, 2);
context.state.focus.scope = 'full';
render('ro2m', 1);
assert.strictEqual(sources['layer-ro2m-gray-src'].data.features[0].geometry.type, 'MultiPolygon');
for (const key of ['ro5m', 'ro1m']) {
    const id = key === 'ro5m' ? 'Ro5m' : 'Ro1m';
    assert.strictEqual(render(key, 0.4).layerIds.length, 1);
    controls[`lidar${id}DisableTransparency`].checked = true;
    assert.strictEqual(render(key, 0.4).layerIds.length, 2);
    assert.strictEqual(layers[`layer-${key}-gray`].paint['fill-opacity'], 0.4);
}
assert.strictEqual(render('other', 1).layerIds.length, 1);
context.focusMatches = () => false;
render('ro2m', 1);
assert(!layers['layer-ro2m-gray'] && !sources['layer-ro2m-gray-src']);
context.focusMatches = () => true;
render('ro2m', 1);
controls.lidarRo2mDisableTransparency.checked = false;
render('ro2m', 1);
assert(!layers['layer-ro2m-gray'] && !sources['layer-ro2m-gray-src']);
assert(layers['layer-ro2m'], 'unchecking keeps the raster');
// Removing a focused LiDAR entry also disposes of its backing and source.
vm.runInContext(viewer.slice(viewer.indexOf('    function removeRendered('), viewer.indexOf('    /* MapLibre re-parses')), context);
context.state.rendered = { 'layer-ro5m': {
    sourceIds: ['layer-ro5m-src', 'layer-ro5m-gray-src'],
    layerIds: ['layer-ro5m-gray', 'layer-ro5m']
} };
context.state.sourceTiles = {};
context.state.bound = {};
context.removeRendered('layer-ro5m');
assert(!layers['layer-ro5m-gray'] && !sources['layer-ro5m-gray-src']);
assert(!layers['layer-ro5m'] && !sources['layer-ro5m-src']);
assert(viewer.includes("document.addEventListener('input', onPanelEvent, true)"));
assert(viewer.includes("document.addEventListener('change', onPanelEvent, true)"));
console.log('3D Romanian LiDAR gray backing tests passed');
