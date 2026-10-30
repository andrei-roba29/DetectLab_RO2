/* Pixel-only LiDAR image effects. These are NOT RVT height visualisations. */
(function (root) {
    'use strict';
    const map = root._dlMap, L = root.L;
    if (!map || !L) return;
    let session = null, overlay = null, generation = 0, selecting = false, marker = null, pendingClick = null;
    const tilePixels = new Map(), canvases = new Map();
    const blurCache = new WeakMap();
    const MAX_TILES = root.innerWidth && root.innerWidth < 700 ? 48 : 96;
    const controls = {exposure:0, highlights:0, shadows:0, contrast:0, brightness:0, sharpness:0, opacity:100};
    const snapshot = () => session && session.ready && {key:session.key, center:{lat:session.center.lat,lng:session.center.lng}, radiusKm:1,
        zoom:session.zoom, method:session.method, tiles:tilePixels.size};
    function announce(text) { root.dispatchEvent(new CustomEvent('dl:photo-filter', {detail:{status:text,session:snapshot()}})); }
    const active = key => {
        const known=(root.DetectLabLidar3D?.activeLayers() || []).find(entry =>
            entry.tagKey === 'lidar.' + key || entry.lidarKey === 'lidar.' + key || entry.defId === key);
        if (known) return known;
        // Country sublayers mounted outside the Romanian _lidarGroup (DK/Albania).
        const defId=key.startsWith('danish_') ? 'danish.'+key.slice(7) :
            key.startsWith('albania_') ? 'albania.'+key.slice(8) : null;
        let found=null;
        if (defId) map.eachLayer(layer=>{
            if (!found && layer._dlDefId===defId && (layer.getTileUrl || layer.createTile))
                found={key,layer,defId,maxzoom:layer.options?.maxNativeZoom || layer.options?.maxZoom || 18};
        });
        return found;
    };
    function tileCoordinates(center, z) {
        const earth = 40075016.68557849, circumference = earth * Math.cos(center.lat * Math.PI / 180);
        const px = 1000 / (circumference / (256 * 2 ** z));
        const p = map.project(center, z), minX = Math.floor((p.x-px)/256), maxX = Math.floor((p.x+px)/256);
        const minY = Math.floor((p.y-px)/256), maxY = Math.floor((p.y+px)/256);
        const tiles=[];
        for (let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++) {
            if (x < 0 || y < 0 || x >= 2**z || y >= 2**z) continue;
            // Keep rim tiles: the pixel mask below clips them to the actual circle.
            tiles.push({z,x,y});
        }
        return tiles;
    }
    function zoomTiles(center, maxZoom) {
        const tiles=[];
        for (let z=0; z<=maxZoom; z++) tiles.push(...tileCoordinates(center,z));
        return tiles;
    }
    function chooseZoom(center, layer) {
        let z = Math.min(18, Math.floor(map.getZoom()), layer.maxzoom || 18);
        while (z > 0 && zoomTiles(center,z).length > MAX_TILES) z--;
        return z;
    }
    const keyOf = t => [t.z,t.x,t.y].join('/');
    async function decode(payload) {
        const blob = new Blob([payload]);
        let bitmap, objectUrl;
        try {
            if (typeof createImageBitmap === 'function') bitmap=await createImageBitmap(blob);
            else {
                objectUrl=URL.createObjectURL(blob);
                bitmap=new Image(); bitmap.src=objectUrl; await bitmap.decode();
            }
            if (bitmap.width < 16 || bitmap.height < 16) throw Error('Provider returned an empty tile');
            const canvas = document.createElement('canvas'); canvas.width=canvas.height=256;
            const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.drawImage(bitmap,0,0,256,256);
            return ctx.getImageData(0,0,256,256);
        } finally {
            if (bitmap && typeof bitmap.close === 'function') bitmap.close();
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
    }
    async function fetchPixels(entry, t, signal) {
        const M=root.DetectLabMirror, viewer=root.DetectLabMap3D;
        if (!M || !viewer) throw Error('3D tile transport is unavailable');
        const url=M.tileUrlFor(entry.layer,t.z,t.x,t.y);
        let bytes;
        if (url) {
            const timeout = new AbortController(), timer=setTimeout(()=>timeout.abort(),18000);
            signal.addEventListener('abort',()=>timeout.abort(),{once:true});
            try {
                const result=await viewer._fetchTile(url,timeout,{preferProxy: /wms|GetMap/i.test(url)});
                if (result.blank) throw Error('Tile proxy returned empty imagery');
                bytes=result.data;
            } finally { clearTimeout(timer); }
        } else if (typeof M.renderTile === 'function') bytes=await M.renderTile(entry.layer,t.z,t.x,t.y);
        else throw Error('This LiDAR layer cannot supply readable image tiles');
        if (signal.aborted) throw Error('Cancelled');
        return decode(bytes);
    }
    const maskedTiles = new Map();
    function clearMask() {
        for(const [node, prior] of maskedTiles) {
            node.style.maskImage=prior.maskImage; node.style.webkitMaskImage=prior.webkitMaskImage;
            node.style.maskRepeat=prior.maskRepeat; node.style.webkitMaskRepeat=prior.webkitMaskRepeat;
        }
        maskedTiles.clear();
    }
    function maskOrigin() {
        if(!session || !overlay) return;
        const mapBounds=map.getContainer().getBoundingClientRect(), p=map.latLngToContainerPoint(session.center);
        const radius=map.project(session.center,map.getZoom()).distanceTo(
            map.project([session.center.lat+1000/111200,session.center.lng],map.getZoom()));
        const tiles=session.entry.layer._tiles || {};
        for(const tile of Object.values(tiles)) {
            const node=tile?.el; if(!node || !node.getBoundingClientRect) continue;
            if(!maskedTiles.has(node)) maskedTiles.set(node,{
                maskImage:node.style.maskImage,webkitMaskImage:node.style.webkitMaskImage,
                maskRepeat:node.style.maskRepeat,webkitMaskRepeat:node.style.webkitMaskRepeat
            });
            const r=node.getBoundingClientRect(), x=mapBounds.left+p.x-r.left,y=mapBounds.top+p.y-r.top;
            const value=`radial-gradient(circle ${radius}px at ${x}px ${y}px, transparent calc(100% - 1px), black 100%)`;
            node.style.maskImage=value; node.style.webkitMaskImage=value;
            node.style.maskRepeat='no-repeat'; node.style.webkitMaskRepeat='no-repeat';
        }
    }
    function stop() {
        generation++; paintGeneration++; selecting=false;
        root.dlLidarPhotoPicking = false;
        if(pendingClick) { map.off('click',pendingClick); pendingClick=null; }
        if(session?.controller) session.controller.abort();
        map.getContainer().style.cursor='';
        clearMask();
        if(session?.entry?.layer) session.entry.layer.off?.('tileload',maskOrigin);
        if (overlay) map.removeLayer(overlay);
        overlay=null; session=null; tilePixels.clear(); canvases.clear();
        if (marker) { map.removeLayer(marker); marker=null; }
        root.dispatchEvent(new CustomEvent('dl:photo-filter', {detail:{status:'Image effect off',session:null}}));
    }
    function blurs(source, radius) {
        const out=new Float32Array(256*256);
        // Integral image; O(pixels) per radius. Ignore alpha = no coverage.
        const sum=new Float64Array(257*257), counts=new Uint32Array(257*257);
        for(let y=0;y<256;y++) for(let x=0;x<256;x++) {
            const i=y*256+x,p=(y+1)*257+x+1, valid=source.data[i*4+3]>0?1:0;
            const v=valid?(.2126*source.data[i*4]+.7152*source.data[i*4+1]+.0722*source.data[i*4+2]):0;
            sum[p]=v+sum[p-1]+sum[p-257]-sum[p-258];
            counts[p]=valid+counts[p-1]+counts[p-257]-counts[p-258];
        }
        for(let y=0;y<256;y++) for(let x=0;x<256;x++) {
            const a=Math.max(0,x-radius),b=Math.min(255,x+radius),c=Math.max(0,y-radius),d=Math.min(255,y+radius);
            const tl=c*257+a,tr=c*257+b+1,bl=(d+1)*257+a,br=(d+1)*257+b+1;
            const n=counts[br]-counts[tr]-counts[bl]+counts[tl];
            out[y*256+x]=n?(sum[br]-sum[tr]-sum[bl]+sum[tl])/n:0;
        }
        return out;
    }
    const clamp=v=>Math.max(0,Math.min(255,v));
    function effect(lum, near, far, dx, dy, method) {
        const relief=lum-near, broad=near-far, edge=Math.hypot(dx,dy);
        switch(method) {
        case 'hillshade': return [lum+dx*.75-dy*.7];
        case 'multi-hillshade': return [lum+edge*.6];
        case 'slope': return [edge*2+50];
        case 'slrm': return [128+relief*2];
        case 'msrm': return [128+relief*1.5+broad];
        case 'mstp': return [128+relief*2,128+broad*2,128-relief-broad];
        case 'svf': return [lum-edge*.7];
        case 'asvf': return [lum+dx*.5-dy*.3-edge*.35];
        case 'openness': return [128+(near-lum)*2];
        case 'local-dominance': return [128+Math.max(0,relief)*2];
        case 'sky-illumination': return [lum+edge*.25+dx*.25-dy*.25];
        case 'vat': return [lum+relief,lum-edge*.35,lum+dx*.3];
        case 'combined-vat': return [lum+relief*1.5,lum+broad-edge*.3,lum-edge*.6];
        case 'prismatic-openness': return [128+relief*1.7,128+broad*2,128-relief*1.5];
        case 'crim': return [lum+dx,lum+relief*1.5,lum+broad*1.5];
        case 'e2mstp': return [128+relief*2.5,128+broad*1.5,128-relief*1.5];
        case 'e3mstp': return [128+broad*2,128+relief*2.5,128-broad*2-relief];
        default: return [lum];
        }
    }
    function paint(canvas, original, coords) {
        if (!session) return;
        const image=new ImageData(256,256), src=original.data, dst=image.data;
        let blur=blurCache.get(original);
        if (!blur) { blur={near:blurs(original,3),far:blurs(original,12)}; blurCache.set(original,blur); }
        const {near,far}=blur, z=coords.z;
        const center=map.project(session.center,z);
        const metresPerPixel=40075016.68557849*Math.cos(session.center.lat*Math.PI/180)/(256*2**z);
        const rad=1000/metresPerPixel, rad2=rad*rad;
        const c=controls, opacity=c.opacity/100;
        for(let y=0;y<256;y++) for(let x=0;x<256;x++) {
            const i=y*256+x,p=4*i;
            if (src[p+3]===0 || (coords.x*256+x-center.x)**2+(coords.y*256+y-center.y)**2>rad2) continue;
            const lum=.2126*src[p]+.7152*src[p+1]+.0722*src[p+2];
            const dx=(x<255?near[i+1]:near[i])-(x>0?near[i-1]:near[i]);
            const dy=(y<255?near[i+256]:near[i])-(y>0?near[i-256]:near[i]);
            const channels=effect(lum,near[i],far[i],dx,dy,session.method);
            for(let k=0;k<3;k++) {
                let v=channels[k] ?? channels[0];
                // Photo controls act on image intensity, never metres/elevation.
                v=128+(v-128)*(1+c.contrast/100);
                v*=2**(c.exposure/100);
                v+=c.brightness*1.3;
                v+=v>128 ? (255-v)*c.highlights/100 : v*c.shadows/100;
                v+=(lum-near[i])*c.sharpness/80;
                dst[p+k]=clamp(v);
            }
            dst[p+3]=Math.round(src[p+3]*opacity*(session.entry.layer.options?.opacity ?? 1));
        }
        canvas.getContext('2d').putImageData(image,0,0);
    }
    const PhotoLayer=L.GridLayer.extend({createTile(coords,done) {
        const canvas=document.createElement('canvas'); canvas.width=canvas.height=256;
        const original=tilePixels.get(keyOf(coords));
        if (original) { paint(canvas,original,coords); canvases.set(keyOf(coords),{canvas,coords}); }
        queueMicrotask(()=>done(null,canvas)); return canvas;
    }});
    let paintGeneration=0;
    function refresh() {
        if (!session) return;
        const job=++paintGeneration, queue=Array.from(canvases.values());
        function frame() {
            if(job!==paintGeneration || !session) return;
            for(let i=0;i<2 && queue.length;i++) {
                const {canvas,coords}=queue.shift(), src=tilePixels.get(keyOf(coords));
                if(src) paint(canvas,src,coords);
            }
            if(queue.length) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }
    function update(method,values) {
        if (!session) return;
        session.method=method;
        Object.assign(controls,values || {});
        refresh(); announce('Photo effect: ' + method + ' (visual simulation only)');
    }
    async function prepare(key,center,method,values) {
        stop();
        const entry=active(key);
        if (!entry) throw Error('Switch on this LiDAR sublayer before preparing its image area');
        if (!root.DetectLabMirror || !root.DetectLabMap3D) throw Error('3D image tile transport is not ready');
        const zoom=chooseZoom(center,entry);
        const tiles=zoomTiles(center,zoom);
        const serial=++generation, controller=new AbortController();
        session={key,entry,center,zoom,method,controller}; Object.assign(controls,values||{});
        marker=L.circle(center,{radius:1000,color:'#efbb75',weight:2,fill:false,interactive:false,pane:'rvt-photo-pane'}).addTo(map);
        marker._dl3dSkip=true; // Selection chrome is not imagery.
        announce('Fetching image tiles: 0/' + tiles.length + ' (zoom ' + zoom + ')');
        let next=0,done=0,failures=0;
        async function worker() {
            while(next<tiles.length && serial===generation) {
                const t=tiles[next++];
                try { const pixels=await fetchPixels(entry,t,controller.signal);
                    if(serial===generation) tilePixels.set(keyOf(t),pixels); }
                catch(err) { failures++; if(serial===generation && failures===1) announce('A tile failed: ' + err.message); }
                done++; if (serial===generation) announce('Fetching image tiles: ' + done + '/' + tiles.length);
            }
        }
        await Promise.all(Array.from({length:Math.min(4,tiles.length)},worker));
        if (serial!==generation) return false;
        if (failures) { stop(); throw Error(failures + ' of ' + tiles.length + ' image tiles failed; no partial filter was applied'); }
        overlay=new PhotoLayer({pane:'rvt-photo-pane',tileSize:256,minZoom:0,maxNativeZoom:zoom,maxZoom:22,keepBuffer:1});
        overlay._dl3dSkip=true; // 3D has its own separately prepared image/terrain deck.
        overlay.addTo(map);
        overlay.on('tileunload', e=>canvases.delete(keyOf(e.coords)));
        session.entry.layer.on?.('tileload',maskOrigin);
        maskOrigin(); session.ready=true; announce('Photo effect ready: ' + tiles.length + ' tiles in a 1 km radius (not real RVT)');
        return true;
    }
    function preview(method) {
        if (!session) return null;
        const p=map.project(session.center,session.zoom),coords={z:session.zoom,x:Math.floor(p.x/256),y:Math.floor(p.y/256)};
        const original=tilePixels.get(keyOf(coords)); if (!original) return null;
        const canvas=document.createElement('canvas'); canvas.width=canvas.height=256;
        const prior=session.method; session.method=method; paint(canvas,original,coords); session.method=prior;
        const small=document.createElement('canvas'); small.width=small.height=44; small.getContext('2d').drawImage(canvas,0,0,44,44); return small;
    }
    // The 3D renderer may use these exact processed pixels only for the same
    // live layer and the same prepared circle, never for another focus.
    function info3d(layer, mask) {
        if (!session || !session.ready || session.entry.layer !== layer || !mask) return null;
        if (Math.abs(Number(mask.lat) - session.center.lat) > 1e-6 ||
            Math.abs(Number(mask.lng) - session.center.lng) > 1e-6 ||
            Math.abs(Number(mask.radiusKm) - 1) > 1e-6) return null;
        return { zoom: session.zoom };
    }
    async function tile3d(layer, mask, z, x, y) {
        if (!info3d(layer, mask)) throw Error('The selected image area is no longer available');
        const current = session;
        const canvas=document.createElement('canvas'); canvas.width=canvas.height=256;
        const ctx=canvas.getContext('2d');
        // The cache contains both the native zoom and its parent. For lower
        // zooms, composite the cached parent tiles into their correct positions.
        const sourceZoom = z < current.zoom ? current.zoom - 1 : current.zoom;
        const scale = 2 ** (z-sourceZoom);
        for (const [key, pixels] of tilePixels) {
            const [tz,tx,ty]=key.split('/').map(Number);
            if (tz !== sourceZoom || Math.floor(tx*scale) !== x || Math.floor(ty*scale) !== y) continue;
            const part=document.createElement('canvas'); part.width=part.height=256;
            paint(part,pixels,{z:tz,x:tx,y:ty});
            ctx.drawImage(part,(tx*scale-x)*256,(ty*scale-y)*256,256*scale,256*scale);
        }
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        if (!blob || session !== current || !info3d(layer,mask)) throw Error('Image area changed during rendering');
        return blob.arrayBuffer();
    }
    function choose(key,method,values,onComplete) {
        if(pendingClick) map.off('click',pendingClick);
        selecting=true; root.dlLidarPhotoPicking = true; map.getContainer().style.cursor='crosshair';
        announce('Tap the centre of a LiDAR-covered area on the map (1 km radius)');
        const click=event=>{
            if(window.dlApmPicking) return; // Another tool owns this click; keep selection active.
            map.off('click',click); pendingClick=null; selecting=false; map.getContainer().style.cursor='';
            // Leaflet dispatches all map listeners for the same tap. Keep ownership
            // until the dispatch finishes so heritage hit tests cannot react to it.
            setTimeout(() => { if (!selecting) root.dlLidarPhotoPicking = false; }, 0);
            const preparation = prepare(key,event.latlng,method,values);
            // prepare() resets the previous session, including its picking flag.
            root.dlLidarPhotoPicking = true;
            preparation.then(ok => {
                if (ok && onComplete) onComplete(null);
            }).catch(err => { announce(err.message); if (onComplete) onComplete(err); });
        };
        pendingClick=click; map.on('click',click);
        return () => {
            if(pendingClick === click) { map.off('click',click); pendingClick=null; selecting=false; root.dlLidarPhotoPicking=false; map.getContainer().style.cursor=''; }
        };
    }
    map.createPane('rvt-photo-pane'); map.getPane('rvt-photo-pane').style.zIndex=615;
    map.getPane('rvt-photo-pane').style.pointerEvents='none';
    map.on('layerremove',event=>{ if (session && event.layer===session.entry.layer) stop(); });
    map.on('move zoom resize',()=>{ if(session && overlay) {
        const visible=map.getZoom()>=session.zoom-1;
        if(overlay.getContainer()) overlay.getContainer().style.display=visible?'':'none';
        if(visible) maskOrigin(); else clearMask();
    } });
    root.DLPhotoFilter={active,choose,prepare,update,stop,get:snapshot,preview,info3d,tile3d,
        source3d: () => session && session.ready ? session.entry.layer : null,
        _test:{effect,tileCoordinates,chooseZoom}};
})(window);
