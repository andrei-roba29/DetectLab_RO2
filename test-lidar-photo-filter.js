// Offline regression: all 17 photo effects stay distinguishable, tile footprint is bounded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const panes = {};
const map = {
  createPane(n) { panes[n] = {style:{}}; }, getPane(n) { return panes[n]; },
  on() {}, getZoom() {return 17;},
  project({lat,lng}, z) {return {x:(lng+180)/360*256*2**z,y:(90-lat)/180*256*2**z};}
};
const win = {_dlMap:map,L:{GridLayer:{extend:()=>function(){}}}};
const doc = {body:{appendChild(){}},createElement(){return {hidden:true,setAttribute(){}};}};
vm.runInNewContext(fs.readFileSync('js/lidar-photo-filter.js','utf8'),{
  window:win,document:doc,console,CustomEvent:class{}
});
const {effect,tileCoordinates,chooseZoom} = win.DLPhotoFilter._test;
const ids=['hillshade','multi-hillshade','slope','slrm','msrm','mstp','svf','asvf',
  'openness','local-dominance','sky-illumination','vat','combined-vat',
  'prismatic-openness','crim','e2mstp','e3mstp'];
const outputs=ids.map(id=>effect(100,110,120,20,-10,id));
assert.equal(outputs.length,17);
assert.equal(new Set(outputs.map(o=>JSON.stringify(o))).size,17, 'distinct visual responses');
const center={lat:52,lng:5};
const z=chooseZoom(center,{maxzoom:18});
assert.ok(z<=17 && tileCoordinates(center,z).length+tileCoordinates(center,z-1).length<=96);
console.log('Photo effects: 17 distinct styles; <=96 prefetched tiles.');
