// Exercises the LiDAR settings entry point with and without a prepared area.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
class Node {
    constructor(tag) { this.tagName=tag; this.children=[]; this.hidden=false; this.dataset={}; this.style={}; this.className=''; this.textContent=''; this.classList={contains:()=>false,toggle(){},add(){}}; }
    appendChild(n) { this.children.push(n); return n; }
    append(...nodes) { nodes.forEach(n=>this.appendChild(n)); }
    replaceChildren(...nodes) { this.children=[]; this.append(...nodes); }
    setAttribute() {} addEventListener() {}
    querySelector(s) { if (this.id==='rvt-panel' && s==='#rvt-body') return body; return null; }
}
const body = new Node('div'); body.hidden=true;
const header = new Node('div'); header.textContent='Test LiDAR';
const toggle = {checked:false,click(){this.checked=true;}};
const row = new Node('div'); row.firstElementChild=header;
row.querySelector = s => s==='.rvt-row-button' ? header.children.find(c=>c.className==='rvt-row-button') :
    s==='input[id$="OpacitySlider"]' ? {id:'lidarNlAhnOpacitySlider',value:'70'} :
    s==='input[type="checkbox"]' ? toggle : null;
const container=new Node('div');
const frame=new Node('div');
container.closest = selector => selector === '.map-frame' ? frame : null;
const map={getContainer:()=>container,getPane:()=>({style:{}}),on(){},removeLayer(){},attributionControl:{removeAttribution(){},addAttribution(){}}};
let callback, chosen=0, cancelled=0, stops=0;
const photo={get:()=>null, active:()=>true, choose(key, method, values, cb){chosen++; callback=cb; return ()=>cancelled++;}, stop(){stops++;},update(){},preview(){}};
const document={createElement:t=>new Node(t),querySelectorAll:()=>[row],getElementById:()=>null};
const dockEntries = {};
const dock = { minimize(id, label, restore) { dockEntries[id] = restore; }, remove(id) { delete dockEntries[id]; } };
const window={_dlMap:map,L:{},DLPhotoFilter:photo,DetectLabWindowDock:dock,addEventListener(){}};
const config=JSON.parse(fs.readFileSync('rvt_service/methods.json'));
const source=fs.readFileSync('js/rvt-panel.js','utf8');
const ctx={window,document,L:{GridLayer:{extend:()=>function(){}}},MutationObserver:class{observe(){}},
    fetch:()=>Promise.resolve({ok:true,json:()=>Promise.resolve({config,layers:{}})}),Event:class{},console,Map,Set,URLSearchParams,setTimeout,clearTimeout};
vm.runInNewContext(source,ctx);
assert.equal(frame.children[0].id, 'rvt-panel', 'settings are outside the Leaflet touch-action boundary');
assert.equal(container.children.length, 0, 'settings do not inherit Leaflet map gestures');
const css = fs.readFileSync('css/rvt-panel.css', 'utf8');
assert.match(css, /#rvt-body\s*\{[^}]*overflow-y:auto;[^}]*touch-action:pan-y;[^}]*-webkit-overflow-scrolling:touch/);
assert.match(css, /\.rvt-control input\s*\{[^}]*touch-action:pan-y/);
const button=header.children[0];
assert.equal(button.textContent, '', 'settings entry point is icon-only');
assert(button.innerHTML.includes('<svg'), 'settings uses a minimal SVG icon');
assert.equal(button.title, 'LiDAR Settings');
const click=()=>button.onclick({preventDefault(){},stopPropagation(){}});
const text=n=>n.textContent+' '+n.children.map(text).join(' ');
(async()=>{
    await new Promise(resolve=>setImmediate(resolve));
    click();
    assert(toggle.checked,'inactive LiDAR is enabled');
    assert.equal(chosen,1); assert(!body.hidden);
    assert(text(body).includes('Tap the centre')); assert(!text(body).includes('Custom settings'));
    body.children[0].children[1].onclick();
    assert(body.hidden && dockEntries['lidar-settings'], 'selection can be minimized');
    dockEntries['lidar-settings'](); delete dockEntries['lidar-settings'];
    assert(!body.hidden, 'selection can be restored');
    const old=callback;
    callback(new Error('Tiles unavailable')); assert(text(body).includes('Tiles unavailable')); assert(!text(body).includes('Custom settings'));
    body.children[3].onclick(); assert.equal(chosen,2);
    old(null); assert(!text(body).includes('Custom settings'),'stale selections cannot open settings');
    body.children[0].children[1].onclick();
    callback(null); assert(body.hidden, 'completed preparation does not reopen a minimized window');
    dockEntries['lidar-settings'](); delete dockEntries['lidar-settings'];
    assert(!body.hidden && text(body).includes('Custom settings'),'restoring shows prepared settings');
    click(); assert.equal(chosen,3); assert(!text(body).includes('Custom settings'),'reopening requires a new selection');
    body.children[0].children[2].onclick(); assert(body.hidden); assert(cancelled>0); assert(stops>0);
    callback(null); assert(body.hidden,'cancelled selection cannot reopen settings');
    const html=fs.readFileSync('index.html','utf8'), sw=fs.readFileSync('sw.js','utf8');
    for(const tag of ['js/rvt-panel.js?v=20261030-shared-dock','js/lidar-photo-filter.js?v=20261030-no-photo-toast']) assert(html.includes(tag)&&sw.includes(tag));
    console.log('OK — LiDAR settings require a successfully prepared area; failure, retry and cancellation work.');
})().catch(err=>{console.error(err);process.exitCode=1;});
