'use strict';
// Test the real measurement against differently positioned map frame/wrapper
// boxes, and the same dock that owns all three original analysis buttons.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const script = fs.readFileSync('js/map3d-terrain.js','utf8');
const css = fs.readFileSync('css/map3d-terrain.css','utf8');
const html = fs.readFileSync('index.html','utf8');
const sw = fs.readFileSync('sw.js','utf8');
const vo = fs.readFileSync('js/vertical-opacity-control.js','utf8');
const start = script.indexOf('    function syncAnalysisDock()');
const end = script.indexOf('    function watchAnalysisControl', start);
assert(start >= 0 && end > start);
const props = {};
const classNames = new Set(['is-3d']);
let frameBottom = 900;
const dock = {style:{setProperty(k,v){props[k]=v;},removeProperty(k){delete props[k];}},
    offsetParent:{getBoundingClientRect:()=>({bottom:frameBottom,height:600})}};
const box = (top,height=38,width=38)=>({getBoundingClientRect:()=>({top,height,width})});
let header = box(750);
const document={body:{classList:{contains:c=>classNames.has(c)}},getElementById:id=>
    id==='layerActionDock' ? dock : id==='arcgisBasemapCtrl' ? {querySelector:()=>header} : null};
const context=vm.createContext({document,toggleGroup:box(748),bar:box(710,30,280),BASE_LAYER_CTRL_ID:'arcgisBasemapCtrl',ANCHOR_GAP:8,Math,isFinite,Infinity});
vm.runInContext(script.slice(start,end),context);
assert(context.syncAnalysisDock()); assert.equal(props['--m3d-analysis-dock-bottom'],'198px');
assert.equal(frameBottom-parseInt(props['--m3d-analysis-dock-bottom']),702, 'dock bottom is 8px above the highest 3D bar');
// Wrapped translations / a taller 3D bar move the dock farther up.
context.bar=box(675,65,280); context.syncAnalysisDock(); assert.equal(props['--m3d-analysis-dock-bottom'],'233px');
// The PWA frame and its safe-area/country-exit lifts are measured, not guessed.
classNames.add('is-pwa'); frameBottom=940; context.toggleGroup=box(705); context.bar=box(660,40,280); header=box(707);
context.syncAnalysisDock(); assert.equal(props['--m3d-analysis-dock-bottom'],'288px');
// Hidden bar is ignored; 2D completely releases the measured offset.
context.bar=box(0,0,0); context.syncAnalysisDock(); assert.equal(props['--m3d-analysis-dock-bottom'],'243px');
classNames.delete('is-3d'); context.syncAnalysisDock(); assert(!('--m3d-analysis-dock-bottom' in props));
assert(/body\.is-3d \.layer-action-dock,\s*body\.is-pwa\.is-3d \.layer-action-dock\s*\{[^}]*--m3d-analysis-dock-bottom[^}]*!important/s.test(css), '3D rule beats the PWA inline override');
for (const id of ['lidarScannerRun','archeoPotRunBtn','archReportRunBtn']) assert(vo.includes("actions: ['"+id+"']"));
assert(script.includes('watchAnalysisControl(toggleGroup)') && script.includes('watchAnalysisControl(bar)'));
assert(script.includes('syncToggleAnchor(); syncAnalysisDock();'));
for(const tag of ['css/map3d-terrain.css?v=20261030-3d-analysis-dock','js/map3d-terrain.js?v=20261030-3d-analysis-dock']) assert(html.includes(tag)&&sw.includes("'"+tag+"'"));
assert(Number(/const CACHE_NAME = 'detectlab-v(\d+)-/.exec(sw)[1])>=316);
console.log('OK — 3D analysis actions clear the control stack in PWA and web; 2D is unchanged.');
