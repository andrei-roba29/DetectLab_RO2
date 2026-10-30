// The 3D protocol must serve the same processed, clipped pixels as 2D.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('js/lidar-photo-filter.js','utf8');
const pipeline = src.slice(src.indexOf('    function blurs('), src.indexOf('    const PhotoLayer='));
const bridge = src.slice(src.indexOf('    function info3d('), src.indexOf('    function choose(key,method,values,onComplete)'));
const n=256*256*4, pixels={data:new Uint8ClampedArray(n)};
for(let i=0;i<n;i+=4) { pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=100+(i/4%100); pixels.data[i+3]=255; }
class Canvas {
    constructor() { this.ctx={ image:null, putImageData:im=>{this.ctx.image=im;}, drawImage:(other,...rect)=>{this.ctx.image=other.ctx.image; this.rect=rect;} }; }
    getContext() {return this.ctx;}
    toBlob(cb) { const data=this.ctx.image?.data || new Uint8ClampedArray(0); cb({arrayBuffer:async()=>Uint8Array.from(data).buffer}); }
}
const layer={options:{opacity:0.8}};
const session={ready:true,entry:{layer},center:{lat:0,lng:0},zoom:1,method:'hillshade'};
const controls={exposure:0,highlights:0,shadows:0,contrast:0,brightness:0,sharpness:0,opacity:100};
const ctx=vm.createContext({ session, controls, blurCache:new WeakMap(), tilePixels:new Map([['1/1/1',pixels],['0/0/0',pixels]]),
    document:{createElement:()=>new Canvas()}, map:{project:()=>({x:256,y:256})},
    ImageData:class {constructor(w,h){this.data=new Uint8ClampedArray(w*h*4);}}, Uint8ClampedArray, Float32Array, Float64Array, Math, Promise, Error });
vm.runInContext(pipeline + bridge,ctx);
const mask={lat:0,lng:0,radiusKm:1};
(async()=>{
    assert(ctx.info3d(layer,mask)); assert.equal(ctx.info3d({},mask),null);
    assert.equal(ctx.info3d(layer,{lat:0,lng:0.01,radiusKm:1}),null);
    const c=new Canvas(); ctx.paint(c,pixels,{z:1,x:1,y:1});
    const first=new Uint8Array(await ctx.tile3d(layer,mask,1,1,1));
    assert.deepStrictEqual(first,Uint8Array.from(c.ctx.image.data),'3D native tile equals 2D paint');
    controls.brightness=60; session.method='slope';
    const changed=new Uint8Array(await ctx.tile3d(layer,mask,1,1,1));
    assert.notDeepStrictEqual(changed,first,'3D uses current method and settings');
    const c2=new Canvas(); ctx.paint(c2,pixels,{z:1,x:1,y:1});
    assert.deepStrictEqual(changed,Uint8Array.from(c2.ctx.image.data));
    await assert.rejects(ctx.tile3d({},mask,1,1,1));
    // Exercise the real protocol handler: the processed tile takes precedence over primed raw tiles.
    const viewer=fs.readFileSync('js/map3d-terrain.js','utf8');
    const start=viewer.indexOf('    function photoInfoFor('), end=viewer.indexOf("        /* Registry fallback:", start);
    const code=viewer.slice(start,end)+'    }\n';
    let handler, raw=0, rendered=0;
    const focus={lat:0,lng:0,radiusKm:1};
    const v=vm.createContext({state:{protocols:false},root:{DLPhotoFilter:{info3d:(l,m)=>l===layer&&m===focus?{zoom:1}:null,
        tile3d:async(l,m,z,x,y)=>{rendered++; return new Uint8Array([z,x,y]).buffer;}}},
        focusMaskFor:()=>focus,MIRROR:{layerByKey:()=>layer,disc:{blankTile(){return new ArrayBuffer(0);}}},
        primedOutput(){raw++;return new Uint8Array([99]).buffer;},pipelineSigFor(){},Promise,Error,Number,String,decodeURIComponent});
    vm.runInContext(code,v); v.registerProtocols({addProtocol(name,fn){if(name==='dl2d') handler=fn;}});
    const result=await handler({url:'dl2d://key/1/1/1'},{});
    assert.deepStrictEqual(Array.from(new Uint8Array(result.data)),[1,1,1]); assert.equal(raw,0); assert.equal(rendered,1);
    const mirror=fs.readFileSync('js/map3d-mirror.js','utf8');
    assert(mirror.includes('o.fill === false ? 0')); 
    const focusSrc=fs.readFileSync('js/lidar-3d-focus.js','utf8');
    assert(focusSrc.includes('discState.circle._dl3dSkip = true'));
    assert(viewer.includes('var rasterOpacity = photoInfo ? 1'));
    assert(viewer.includes('photoInfo.zoom'));
    console.log('OK — adjusted 2D pixels win over raw 3D tiles, with no extra selection fill.');
})().catch(err=>{console.error(err);process.exitCode=1;});
