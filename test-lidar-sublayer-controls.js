'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('js/map-app.js', 'utf8');
const keys = ['hd','ar','ab','bh','cs','ro2m','ro5m','ro1m','cs917','dj917','gj917','mh917'];
const controls = {};
for (const key of keys) {
    const ui = key[0].toUpperCase() + key.slice(1);
    assert(html.includes(`type="checkbox" id="lidar${ui}Toggle"`), `${key} has a visible switch`);
    assert(html.includes(`onchange="toggleInternationalLidar('${key}', this.checked)"`));
    controls[`lidar${ui}Toggle`] = {checked: false};
    controls[`lidar${ui}OpacitySlider`] = {value: '0'};
    controls[`lidar${ui}Pct`] = {};
}
controls.lidarToggle = {checked:false};
const configs = Object.fromEntries(keys.map(key => [key, {opacity:0,enabled:false}]));
const window = {toggleLidarLayer() { ctx._lidarVisible = true; }};
const ctx = {window, LIDAR_SUB_LAYERS:configs, document:{getElementById:id=>controls[id]},
    _lidarVisible:false, _lidarGroup:{hasLayer:()=>false},
    _handleLidarVisibilityChange(){}, _updateLidarZoomGateMessage(){}};
vm.createContext(ctx);
for (const name of ['toggleLidarSub', 'toggleInternationalLidar', 'setInternationalLidarOpacity']) {
    const match = app.match(new RegExp('window\\.' + name + ' = function[\\s\\S]*?\\n            \\};'));
    assert(match, name);
    vm.runInContext(match[0], ctx);
}
ctx._buildLidarLeafletLayer = () => ({});
ctx._lidarGroup.addLayer = () => {};
for (const key of keys) {
    const ui = key[0].toUpperCase() + key.slice(1);
    window.toggleInternationalLidar(key, true);
    assert(controls.lidarToggle.checked, 'sublayer enables master');
    assert.equal(configs[key].opacity, .7, 'zero opacity becomes visible');
    assert.equal(controls[`lidar${ui}OpacitySlider`].value, 70);
    assert(controls[`lidar${ui}Toggle`].checked);
    window.toggleInternationalLidar(key, false);
    assert(!configs[key].enabled);
    assert(!controls[`lidar${ui}Toggle`].checked);
    window.setInternationalLidarOpacity(key, 45);
    assert(controls[`lidar${ui}Toggle`].checked, 'slider activation updates switch');
    window.toggleInternationalLidar(key, false);
    window.toggleInternationalLidar(key, true);
    assert.equal(configs[key].opacity, .45, 'switch preserves chosen opacity');
}
const sw = fs.readFileSync('sw.js','utf8');
for (const asset of ['js/map-app.js', 'js/rvt-panel.js', 'css/rvt-panel.css']) {
    const url = asset + '?v=20261030-lidar-controls';
    assert(html.includes(url) && sw.includes(url), 'updated asset is precached');
}
console.log('OK — all 12 LiDAR switches, opacity activation, state sync and cache wiring.');
