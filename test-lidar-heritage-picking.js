// A LiDAR area-selection tap must not be dispatched as a heritage-site tap.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const listeners = {}, timers = [], panes = {};
const map = {
    createPane(n) { panes[n] = {style:{}}; }, getPane(n) { return panes[n]; },
    getContainer() { return {style:{}}; },
    on(name, fn) { listeners[name] = fn; }, off(name, fn) { if (listeners[name] === fn) delete listeners[name]; }
};
const window = {_dlMap:map, L:{GridLayer:{extend:()=>function(){}}}, dispatchEvent(){}};
const document = {body:{appendChild(){}}, createElement(){return {hidden:true,setAttribute(){}};}};
vm.runInNewContext(fs.readFileSync('js/lidar-photo-filter.js','utf8'), {
    window, document, console, CustomEvent:class{}, setTimeout(fn){timers.push(fn);}, Map, Set, WeakMap
});
let cancel = window.DLPhotoFilter.choose('x','hillshade',{},()=>{});
assert.equal(window.dlLidarPhotoPicking, true);
cancel();
assert.equal(window.dlLidarPhotoPicking, false);
window.DLPhotoFilter.choose('x','hillshade',{},()=>{});
listeners.click({latlng:{lat:0,lng:0}});
assert.equal(window.dlLidarPhotoPicking, true, 'tap remains owned until Leaflet finishes dispatching');
timers.shift()();
assert.equal(window.dlLidarPhotoPicking, false);
const app = fs.readFileSync('js/map-app.js','utf8');
assert.match(app, /if \(window\.dlApmPicking \|\| window\.dlLidarPhotoPicking\) return;[^\n]*\n\s*if \(!map\.hasLayer\(patrimoniuLayer\)\)/);
const panel = fs.readFileSync('js/rvt-panel.js','utf8');
assert.match(panel, /disableClickPropagation\(body\)/);
assert.match(panel, /disableScrollPropagation\(body\)/);
console.log('LiDAR touch selection and dialog are isolated from heritage clicks.');
