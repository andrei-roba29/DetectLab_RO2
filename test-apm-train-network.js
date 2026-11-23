'use strict';
// Real TRAIN UI -> real provider -> real pipeline -> real worker, mocked network.
// Only Leaflet rendering and TIFF decoding are faked. No live services or database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {JSDOM} = createRequire(path.join(__dirname,'tools/apm-test/package.json'))('jsdom');
const read = p=>fs.readFileSync(path.join(__dirname,p),'utf8');
const fixture = require('./test/fixtures/romania-sites.synthetic.json');
const scripts=['apm-core','apm-raster','apm-heatmap','apm-sites','apm-providers','romania-periods.config','apm-romania-sites','apm-i18n','apm-pipeline','apm-ui'];
const wcs='<wcs:Capabilities><wcs:ServiceMetadata><wcs:formatSupported>image/tiff</wcs:formatSupported><wcs:Extension><wcs:crsSupported>http://www.opengis.net/def/crs/EPSG/0/4326</wcs:crsSupported></wcs:Extension><wcs:MaxPixels>4000000</wcs:MaxPixels></wcs:ServiceMetadata><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>DEM_v11</wcs:CoverageId></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<1000;i++){if(fn())return;await delay(10);}throw Error('Timeout: '+label);}
function harness(mode='ok') {
    const dom=new JSDOM('<body><div class="map-frame"></div></body>',{url:'https://detectlab.example',runScripts:'outside-only'});
    const w=dom.window,requests=[],events={},ops=[],panes={};let completed,runError,params;
    w.localStorage.setItem('detectlab_lang','en');w._dlIsPremium=()=>true;
    w.matchMedia=()=>({matches:false});w.scrollTo=()=>{};
    const layer=()=>({addTo(){return this;},setStyle(){},setOpacity(){},eachLayer(){},bindPopup(){},on(){}});
    w.L={circleMarker:layer,circle:layer,geoJSON:layer,layerGroup:layer};
    w.map={on:(name,fn)=>events[name]=fn,off:name=>delete events[name],removeLayer(){},getContainer:()=>w.document.body,getPane:n=>panes[n],createPane:n=>(panes[n]={style:{}})};
    const sampleName=fixture[0].attributes.NUMESIT;
    const rows=Array.from({length:40},(_,i)=>({object_id:i+1,lat:46.6+(i%8)*.035,lon:24.8+Math.floor(i/8)*.05,name:sampleName,siruta:'100',coord_flag:'DA'}));
    rows[1] = Object.assign({},rows[1],{lat:rows[0].lat,lon:rows[0].lon,name:fixture[8].attributes.NUMESIT});
    const network=async(url)=>{
        requests.push(url);
        const u=new URL(url);
        if(u.host==='project.supabase.example') {
            if(mode==='error')return {data:null,error:{message:'not authorised'}};
            return {data:{rows,total_in_area:40,excluded_approximate:0,excluded_unknown_coord:0,excluded_geometry:0,truncated:false},error:null};
        }
        if(u.host==='overpass-api.de') return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({elements:[]})};
        assert.ok(['image.discomap.eea.europa.eu','copernicus.discomap.eea.europa.eu'].includes(u.host),'unexpected host: '+url);
        if(url.includes('GetCapabilities'))return {ok:true,status:200,text:async()=>wcs,headers:{get:()=> 'text/xml'}};
        if(url.includes('GetCoverage')) {
            // The provider resamples whatever the service returns onto the requested grid;
            // 64×64 is enough for the synthetic 1000 m test raster.
            return {ok:true,status:200,headers:{get:()=> 'image/tiff'},arrayBuffer:async()=>({byteLength:8,w:64,h:64})};
        }
        return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>url.includes('/query?') ?
            {type:'FeatureCollection',features:[]} : {layers:[{id:5,name:'Strahler 3',parentLayerId:4}]}};
    };
    w.fetch=network;
    // This is the existing app client surface. Any table read is a hard failure.
    w.supabaseClient={rpc:(name,args)=>{
        assert.equal(name,'apm_sites_within');assert(args.p_radius_km<=50);
        return network('https://project.supabase.example/rest/v1/rpc/'+name);
    },from(){throw Error('Direct table read forbidden');}};
    w.GeoTIFF={fromArrayBuffer:async buf=>({getImage:async()=>({getWidth:()=>buf.w,getHeight:()=>buf.h,getGDALNoData:()=>null,
        readRasters:async()=>Float32Array.from({length:buf.w*buf.h},(_,i)=>200+(i%buf.w)*30+15*Math.sin(Math.floor(i/buf.w)/3))})})};
    w.Worker=class {
        constructor(){
            const ctx={console,setTimeout,clearTimeout,performance,Float32Array,Float64Array,Uint8Array,Int32Array,Uint32Array,Uint8ClampedArray,Map,Set,Math,Promise};
            ctx.self=ctx;ctx.postMessage=m=>queueMicrotask(()=>this.onmessage({data:m}));
            ctx.importScripts=(...files)=>files.forEach(f=>vm.runInContext(read(path.normalize('js/apm-next/'+f.split('?')[0])),ctx,{filename:f}));
            vm.createContext(ctx);vm.runInContext(read('js/apm-next/apm-worker.js'),ctx);this.ctx=ctx;
        }
        postMessage(m){ops.push(m.op);this.ctx.onmessage({data:m});}
        terminate(){}
    };
    // The REAL protection mask is loaded. Legacy heritage loaders must never run.
    w._loadLocalLayerData=()=>{throw Error('Legacy heritage download forbidden during TRAIN');};
    // A cold UAT cache backed by free-land tiles; the real mask must load them.
    let uatRequests = 0;
    w._uatGetTile=async()=>{uatRequests++;return {data:new Uint8ClampedArray([0,0,0,255]),size:1};};
    w.eval(read('js/archeo-potential.js'));
    for(const s of scripts)w.eval(read('js/apm-next/'+s+'.js'));
    w.DetectLabApmUi.init();w.DetectLabApmUi.setEnabled(true);
    w.DetectLabApmProviders.CONFIG.euDem.nominalResM=1000; // keep synthetic test raster small
    w.DetectLabApmHeatmap.createLayer=layer;
    const real=w.DetectLabApmPipeline.runTrain;
    w.DetectLabApmPipeline.runTrain=(session,p)=>{
        params=p;p.bgCount=100;p.minSlopeDeg=0;
        return real(session,p).then(r=>{completed=r;return r;},e=>{runError=e;throw e;});
    };
    const clickText=text=>{const b=[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert(b,'button '+text);b.click();};
    const pick=async(lat,lon)=>{
        w.document.querySelectorAll('.apm-tab')[1].click();
        w.document.querySelector('.apm-btn.apm-wide').click();
        assert(events.click,'map picker active');events.click({latlng:{lat,lng:lon}});
        await until(()=>!w.document.querySelector('.apm-status').textContent.includes('Loading exact-position'),'site loading');
    };
    return {w,dom,requests,ops,pick,clickText,get completed(){return completed;},get runError(){return runError;},get params(){return params;},get uatRequests(){return uatRequests;}};
}
(async()=>{
    const h=harness();
    try {
        await h.pick(46.75,25);
        assert.equal(h.requests.length,1);
        assert.equal(h.w.document.querySelector('.apm-select').value,'all','All periods default');
        assert.match(h.w.document.querySelector('.apm-train').textContent,/Total records in the area: 40/);
        h.w.document.querySelector('.apm-primary').click();
        await until(()=>h.completed||h.runError,'real TRAIN completion');
        if(h.runError)throw h.runError;
        assert.equal(h.completed.mode,'train');
        assert.equal(h.completed.diagnostics.sitesUsed,40,'distinct names at identical positions survive the entire training pipeline');
        assert(h.ops.includes('train')&&h.ops.includes('score'),'real worker fitted and scored');
        assert(h.uatRequests > 0, 'TRAIN loads exclusion tiles on a cold cache');
        assert(h.completed.scoreStats.cells > 0 && h.completed.heatmap.rgba.some((v,i)=>i%4===3 && v>0), 'TRAIN produces visible heat');
        assert.equal(h.requests.filter(u=>u.includes('/rpc/apm_sites_within')).length,1);
        assert(h.requests.some(u=>u.includes('GetCoverage'))&&h.requests.some(u=>u.includes('EUHydro')));
        assert(h.requests.every(u=>['project.supabase.example','image.discomap.eea.europa.eu','copernicus.discomap.eea.europa.eu','s3.amazonaws.com','overpass-api.de'].includes(new URL(u).host)), JSON.stringify(h.requests));
        console.log('PASS Romania TRAIN: real UI/provider/pipeline/worker completed; site-data calls = [Supabase apm_sites_within]; other requests = existing DEM/hydro only; no legacy heritage download.');
    } finally {h.dom.window.close();}
    const out=harness();
    try {
        await out.pick(51,10);
        assert.equal(out.requests.length,0);
        assert.match(out.w.document.querySelector('.apm-status').textContent,/covers Romania only.*CSV/);
        const file=out.w.document.querySelector('input[type=file]');assert(!file.parentElement.hidden);
        assert(out.w.document.querySelector('.apm-primary').disabled);
        const csv='latitude,longitude,type,positionAccuracy\n'+Array.from({length:12},(_,i)=>`${51+i*.001},10,settlement,5`).join('\n');
        Object.defineProperty(file,'files',{value:[{name:'local.csv',text:async()=>csv}]});file.dispatchEvent(new out.w.Event('change'));
        await until(()=>out.w.document.querySelector('.apm-status').textContent.includes('CSV selected explicitly'),'CSV upload');
        assert.equal(out.requests.length,0);
        assert(!out.w.document.querySelector('.apm-primary').disabled);
        out.w.document.querySelector('.apm-primary').click();
        await until(()=>out.completed||out.runError,'outside CSV TRAIN completion');
        if(out.runError)throw out.runError;
        assert.equal(out.params.siteSource.id,'csv');
        assert.equal(out.params.backgroundAllowed,null,'CSV background is not constrained to Romania');
        assert.equal(out.requests.filter(u=>u.includes('supabase')||u.includes('/rpc/')).length,0);
        assert(out.requests.every(u=>['image.discomap.eea.europa.eu','copernicus.discomap.eea.europa.eu','s3.amazonaws.com','overpass-api.de'].includes(new URL(u).host)));
        console.log('PASS outside Romania: zero site-data requests; explicit CSV upload; real CSV TRAIN completed with DEM/hydro only, no Romania background constraint.');
    } finally {out.dom.window.close();}
    const fail=harness('error');
    try {
        await fail.pick(46.75,25);
        assert.equal(fail.requests.length,1);
        assert.match(fail.w.document.querySelector('.apm-status').textContent,/failed.*not authorised.*CSV/);
        assert(!fail.w.document.querySelector('input[type=file]').parentElement.hidden);
        assert(fail.w.document.querySelector('.apm-primary').disabled);
        console.log('PASS RPC failure: explicit error + CSV upload, no fallback request.');
    } finally {fail.dom.window.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
