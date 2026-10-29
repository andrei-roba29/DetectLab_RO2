#!/usr/bin/env node
/* Regression: the MapLibre 3D view remains, but Cesium is no longer offered. */
const assert = require('assert');
const fs = require('fs');
const viewer = fs.readFileSync('js/map3d-terrain.js', 'utf8');
const registry = fs.readFileSync('js/layer-registry.js', 'utf8');
const css = fs.readFileSync('css/map3d-terrain.css', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
assert(!/cesium/i.test(viewer + registry + css), 'Cesium implementation and configuration are removed');
for (const key of ['imagery', 'topographic', 'terrain']) {
    assert(viewer.includes('<option value="' + key + '">'), key + ' basemap remains available');
}
assert(viewer.includes('root.setArcgisBasemap(basemapSelect.value)'), 'basemap choices still use the shared setter');
assert(viewer.includes("engine: 'maplibre'"), 'MapLibre 3D remains available');
for (const asset of ['js/map3d-terrain.js', 'js/layer-registry.js', 'css/map3d-terrain.css']) {
    const url = asset + '?v=20261029-no-cesium';
    assert(html.includes(url) && sw.includes(url), url + ' is updated in the page and service worker');
}
console.log('Cesium removal regression checks passed.');
