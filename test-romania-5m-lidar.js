#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const read = p => fs.readFileSync(p, 'utf8');
const app = read('js/map-app.js'), html = read('index.html');
const definition = app.match(/ro5m: \{([\s\S]*?)\n\s*\},/);
assert(definition, 'sublayer is defined');
const cfg = vm.runInNewContext('({' + definition[1] + '})');
assert.strictEqual(cfg.url.replace('{z}', '15').replace('{y}', '11658').replace('{x}', '18672'), 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/Ro5m/MapServer/tile/15/11658/18672');
assert.strictEqual(cfg.enabled, false);
assert.strictEqual(cfg.opacity, 0);
assert(html.includes('id="lidarRo5mOpacitySlider"') && html.includes('oninput="setLidarRo5mOpacity(this.value)"'));
const setter = app.match(/window\.setLidarRo5mOpacity = function\(val\) \{[\s\S]*?\n            \};/)[0];
const percent = {}, master = {checked: false}, calls = [];
const window = {toggleLidarSub: (key, on) => { calls.push([key, on]); cfg.enabled = on; }, toggleLidarLayer: on => calls.push(['master', on])};
vm.runInNewContext(setter, {window, LIDAR_SUB_LAYERS: {ro5m: cfg}, document: {getElementById: id => id === 'lidarRo5mPct' ? percent : master}, _lidarVisible: false});
window.setLidarRo5mOpacity(65);
assert.strictEqual(cfg.opacity, .65);
assert.strictEqual(percent.textContent, '65%');
assert.deepStrictEqual(calls, [['ro5m', true], ['master', true]]);
let opacity;
cfg.leafletLayer = {options: {}, setOpacity: n => {opacity = n;}};
window.setLidarRo5mOpacity(0);
assert.strictEqual(opacity, 0);
assert(app.includes("ro5m: 'lidarRo5mOpacitySlider'") && app.includes('ro5m: [[43.5, 19.5]'));
assert(read('css/styles.css').includes('.lidar-ro5m-tiles'));
assert(read('js/map3d-mirror.js').includes("'lidar-ro5m-tiles': 'invert-screen'"));
assert(read('js/vertical-opacity-control.js').includes("lidarRo5mOpacitySlider: 'ro5m'"));
for (const asset of ['css/styles.css', 'js/map-app.js', 'js/map3d-mirror.js', 'js/vertical-opacity-control.js']) {
  const url = asset + '?v=20261029-romania-5m';
  assert(html.includes(url) && read('sw.js').includes(url));
}
console.log('Romania 5m LiDAR regression checks passed.');
