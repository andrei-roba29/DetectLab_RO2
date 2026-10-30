/* RVT terrain: only raw DTM tiles from /api/rvt, never colour-transformed WMS imagery. */
(function () {
    'use strict';
    const map = window._dlMap;
    if (!map || !window.L) return;
    const root = document.createElement('section');
    root.id = 'rvt-panel';
    root.setAttribute('aria-label', 'RVT terrain visualizations');
    root.innerHTML = '<div id="rvt-body" role="dialog" aria-label="LiDAR Settings" hidden></div>';
    map.getContainer().appendChild(root);
    const body = root.querySelector('#rvt-body');
    let layerName = '';
    let profileOn = false, profilePoints = [], profileLine = null;
    let config, layers = {}, layerKey = '', method = 'hillshade', overlay = null, busy = false;
    let requestId = 0, timer, histogramTimer;
    const settings = {};
    const tileStore = new Map();
    const featureSelection = new Set();
    const attributions = new Set();
    const previewCache = new Map();
    const photoSettings = {};
    let photoMode = true; // WMS photo workaround is the default, even if a DTM was registered.
    const isPhoto = () => photoMode || !layers[layerKey];
    const photoDefaults = () => ({exposure:0,highlights:0,shadows:0,contrast:0,brightness:0,sharpness:0,opacity:100});
    const photoState = () => photoSettings[layerKey+':'+method] || (photoSettings[layerKey+':'+method]=photoDefaults());
    const state = () => settings[layerKey + ':' + method] || (settings[layerKey + ':' + method] = defaults(method));
    const defaults = m => ({ ...config.methods[m].measure, min: config.methods[m].stretch?.[0] ?? 0,
        max: config.methods[m].stretch?.[1] ?? 1, range: config.methods[m].displayRange ?? 1,
        ...(m === 'openness' ? { mode: 'positive' } : {}), opacity: 100 });
    const methods = () => Object.values(config.groups).flat();
    const el = (tag, text, cls) => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
    const blocked = m => config.methods[m].unavailable || (!layers[layerKey] ? 'No locally registered bare-earth DTM for this layer' : '');
    function redraw() {
        for (const { canvas, data } of tileStore.values()) paint(canvas, data);
        histogram();
    }
    function paint(canvas, data) {
        const ctx = canvas.getContext('2d');
        const image = ctx.createImageData(256, 256);
        const s = state();
        const mid = (s.min + s.max) / 2, width = Math.max(.00001, (s.max - s.min) * s.range);
        const lower = mid - width / 2;
        for (let i = 0; i < data.length; i++) {
            const j = 4 * i, value = data[i];
            if (!Number.isFinite(value)) continue; // nodata transparent
            const grey = Math.round(255 * Math.max(0, Math.min(1, (value - lower) / width)));
            image.data[j] = image.data[j+1] = image.data[j+2] = grey;
            image.data[j+3] = Math.round(s.opacity * 2.55);
        }
        ctx.putImageData(image, 0, 0);
    }
    const FloatLayer = L.GridLayer.extend({
        createTile(coords, done) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const key = [coords.z, coords.x, coords.y].join('/');
            const serial = requestId;
            const s = state();
            const q = new URLSearchParams();
            for (const k of ['smoothing','smallest','largest','scaling','mode']) if (s[k] !== undefined) q.set(k, s[k]);
            const controller = new AbortController();
            canvas._rvtAbort = controller;
            fetch('/api/rvt/tile/' + [layerKey, method, coords.z, coords.x, coords.y + '.bin'].join('/') + '?' + q,
                { signal: controller.signal }).then(async resp => {
                if (!resp.ok) throw new Error((await resp.json()).error || 'Tile request failed');
                const bytes = await resp.arrayBuffer();
                if (bytes.byteLength !== 256 * 256 * 4) throw new Error('Invalid float tile');
                if (serial !== requestId) { done(null, canvas); return; }
                const data = new Float32Array(bytes);
                tileStore.set(key, { canvas, data, coords });
                paint(canvas, data);
                clearTimeout(histogramTimer);
                histogramTimer = setTimeout(histogram, 120);
                done(null, canvas);
            }).catch(err => {
                if (err.name !== 'AbortError') {
                    status(err.message);
                    done(err, canvas);
                }
            });
            return canvas;
        }
    });
    function status(message) {
        const target = body.querySelector('#rvt-status');
        if (target) target.textContent = message;
    }
    function activate() {
        requestId++;
        tileStore.clear();
        if (overlay) { map.removeLayer(overlay); overlay = null; }
        for (const name of attributions) map.attributionControl.removeAttribution(name);
        attributions.clear();
        if (isPhoto()) {
            if (window.DLPhotoFilter?.get()?.key === layerKey) window.DLPhotoFilter.update(method,photoState());
            status('Image-only effect. Select an area to prefetch; this is not a terrain calculation.');
            return;
        }
        const reason = blocked(method);
        if (reason) { status(reason); histogram(); return; }
        const attribution = layers[layerKey].attribution;
        if (attribution) { map.attributionControl.addAttribution(attribution); attributions.add(attribution); }
        map.attributionControl.addAttribution('RVT © ZRC SAZU / UL FGG (Apache-2.0)');
        attributions.add('RVT © ZRC SAZU / UL FGG (Apache-2.0)');
        status('Loading float terrain tiles…');
        busy = true;
        overlay = new FloatLayer({ tileSize: 256, pane: 'pane_lidar', maxZoom: 22,
            updateWhenIdle: true, keepBuffer: 1 });
        overlay.on('load', () => { busy = false; render(); status('Raw DTM • ' + layers[layerKey].resolution + ' m source pixels'); });
        overlay.on('tileunload', e => {
            if (e.tile._rvtAbort) e.tile._rvtAbort.abort();
            tileStore.delete([e.coords.z, e.coords.x, e.coords.y].join('/'));
            histogram();
        });
        overlay.addTo(map);
    }
    function histogram() {
        const canvas = body.querySelector('#rvt-hist');
        const readout = body.querySelector('#rvt-clip');
        if (!canvas || !readout) return;
        const bounds = map.getPixelBounds(), values = [];
        for (const { data, coords } of tileStore.values()) {
            const tileX = coords.x * 256, tileY = coords.y * 256;
            for (let y = Math.max(0, Math.ceil(bounds.min.y-tileY)); y < Math.min(256, Math.floor(bounds.max.y-tileY)); y += 4) {
                for (let x = Math.max(0, Math.ceil(bounds.min.x-tileX)); x < Math.min(256, Math.floor(bounds.max.x-tileX)); x += 4) {
                    const value = data[y*256+x]; if (Number.isFinite(value)) values.push(value);
                }
            }
        }
        const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        if (!values.length) { readout.textContent = 'No valid ground pixels on screen yet'; return; }
        values.sort((a,b) => a-b);
        const lo = values[0], hi = values[values.length-1], span = hi-lo || 1, bins = new Array(40).fill(0);
        for (const value of values) bins[Math.min(39, Math.floor((value-lo)/span*40))]++;
        const peak = Math.max(...bins);
        ctx.fillStyle = '#d6a76b';
        bins.forEach((n,i) => ctx.fillRect(i*W/40, H-n/peak*(H-4), W/40-1, n/peak*(H-4)));
        const s = state(), mid = (s.min+s.max)/2, width = (s.max-s.min)*s.range;
        const lower = mid-width/2, upper = mid+width/2;
        ctx.strokeStyle = '#82e2dc'; ctx.lineWidth = 2;
        [lower, upper].forEach(v => { const x = Math.max(0, Math.min(W, (v-lo)/span*W)); ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); });
        const below = values.filter(v => v <= lower).length, above = values.filter(v => v >= upper).length;
        readout.textContent = 'On screen: ' + (100*below/values.length).toFixed(1) + '% of the ground draws black, ' +
            (100*above/values.length).toFixed(1) + '% white (' + values.length.toLocaleString() + ' sampled ground pixels)';
        canvas._values = values;
        canvas._extent = [lo, hi];
    }
    function slider(parent, label, key, min, max, step, tip, onChange) {
        const wrap = el('label', '', 'rvt-control');
        const caption = el('span', label + (tip ? ' ⓘ' : ''));
        if (tip) caption.title = tip;
        const number = el('strong', '');
        const input = document.createElement('input'); input.type = 'range';
        input.min = min; input.max = max; input.step = step;
        const refresh = () => { input.value = state()[key]; number.textContent = Number(state()[key]).toFixed(step < 1 ? 1 : 0) + (key === 'opacity' ? '%' : ['smoothing','smallest','largest','range'].includes(key) ? ' m' : ''); };
        refresh();
        input.addEventListener('input', () => {
            state()[key] = Number(input.value); refresh();
            updateReset();
            if (onChange) { status('Recomputing terrain…'); clearTimeout(timer); timer = setTimeout(() => { activate(); render(); }, 400); }
            else redraw();
        });
        wrap.append(caption, number, input); parent.appendChild(wrap);
        return { input, refresh };
    }
    function updateReset() {
        const button = body.querySelector('#rvt-reset'); if (!button) return;
        const orig = isPhoto() ? photoDefaults() : defaults(method), s = isPhoto() ? photoState() : state();
        const changes = Object.keys(orig).filter(k => s[k] !== orig[k]).length;
        button.disabled = !changes;
        button.textContent = (isPhoto() ? 'Reset image adjustments' : 'At RVT\'s defaults') + (changes ? ' (' + changes + ' changed)' : '');
    }
    function render() {
        body.replaceChildren();
        const header = el('div', '', 'rvt-heading');
        const heading = el('h2', 'LiDAR Settings');
        const resize = el('button', body.classList.contains('expanded') ? '−' : '+'); resize.type='button';
        resize.setAttribute('aria-label', body.classList.contains('expanded') ? 'Reduce settings panel' : 'Expand settings panel');
        resize.onclick=()=>{ body.classList.toggle('expanded'); render(); };
        const close = el('button', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close LiDAR Settings');
        close.onclick = () => { body.hidden = true; stopProfile(); };
        header.append(heading, resize, close); body.appendChild(header);
        body.appendChild(el('p', layerName || layerKey, 'rvt-layer-name'));
        if (layers[layerKey]) {
            const modeButton = el('button',isPhoto() ? 'Use numeric DTM instead' : 'Use WMS photo effects');
            modeButton.type='button';
            modeButton.onclick=()=>{ photoMode=!photoMode; stopProfile(); if(!photoMode) window.DLPhotoFilter?.stop(); activate(); render(); };
            body.appendChild(modeButton);
        }
        const navigation = el('div', '', 'rvt-nav');
        const all = methods(), index = all.indexOf(method);
        const previous = el('button', '←', ''); previous.setAttribute('aria-label','Previous method');
        const next = el('button', '→', ''); next.setAttribute('aria-label','Next method');
        const group = Object.keys(config.groups).find(g => config.groups[g].includes(method));
        const title = el('span', config.methods[method].label + ', ' + group + ' · ' + (index+1) + ' of ' + all.length);
        previous.onclick = () => choose(all[(index+all.length-1)%all.length]);
        next.onclick = () => choose(all[(index+1)%all.length]);
        navigation.append(previous, title, next); body.appendChild(navigation);
        const shape = el('div', '', 'rvt-shapes');
        shape.appendChild(el('h3', 'Methods: Looking for'));
        shape.appendChild(el('p', "Pick a shape of ground to underline the methods RVT's assessment rates very suitable for it."));
        for (const feature of Object.keys(config.lookingFor.features)) {
            const chip = el('button', feature); chip.type = 'button'; chip.className = featureSelection.has(feature) ? 'selected' : '';
            chip.setAttribute('aria-pressed', featureSelection.has(feature));
            chip.onclick = () => { featureSelection.has(feature) ? featureSelection.delete(feature) : featureSelection.add(feature); render(); };
            shape.appendChild(chip);
        }
        shape.appendChild(el('small', 'Suitability mapping needs verification — no methods are underlined yet.'));
        body.appendChild(shape);
        for (const [group, ids] of Object.entries(config.groups)) {
            const section = el('div', '', 'rvt-group'); section.appendChild(el('h3', group));
            for (const id of ids) {
                const button = el('button', '', 'rvt-method' + (id === method ? ' active' : ''));
                const thumb = el('span', 'No preview', 'rvt-thumb');
                if (isPhoto() && window.DLPhotoFilter?.get()?.key === layerKey) {
                    const preview = window.DLPhotoFilter.preview(id); if (preview) thumb.replaceChildren(preview);
                } else if (id === method && tileStore.size) {
                    const image = tileStore.values().next().value.canvas;
                    thumb.textContent = ''; const preview = document.createElement('canvas'); preview.width = preview.height = 44;
                    preview.getContext('2d').drawImage(image,0,0,44,44); thumb.appendChild(preview);
                }
                button.append(thumb, el('span', config.methods[id].label)); button.type = 'button';
                button.title = config.methods[id].description || config.methods[id].unavailable || '';
                if (!isPhoto() && id !== method && !config.methods[id].unavailable && layers[layerKey]) previewThumb(thumb, id);
                button.onclick = () => choose(id);
                if (featureSelection.size && [...featureSelection].some(f => config.lookingFor.features[f].includes(id))) button.classList.add('suitable');
                section.appendChild(button);
            }
            body.appendChild(section);
        }
        const settingsBox = el('div', '', 'rvt-settings'); settingsBox.appendChild(el('h3','Custom settings'));
        const warning = blocked(method);
        if (isPhoto()) {
            settingsBox.appendChild(el('p','Visual simulation from the existing image tiles — NOT RVT, true slopes or heights. No elevation data is inferred.', 'rvt-warning'));
            const ready = window.DLPhotoFilter?.get()?.key === layerKey;
            const activeLayer = window.DLPhotoFilter?.active(layerKey);
            if (!activeLayer) settingsBox.appendChild(el('p','Switch on this LiDAR sublayer first. Only visible layers can be prefetched.'));
            const choose = el('button',ready ? 'Choose a different 1 km area' : 'Choose and prefetch a 1 km area');
            choose.type='button'; choose.disabled=!activeLayer;
            choose.onclick=()=>{ body.hidden=true; window.DLPhotoFilter.choose(layerKey,method,photoState()); };
            settingsBox.appendChild(choose);
            if (ready) {
                const area = window.DLPhotoFilter.get();
                settingsBox.appendChild(el('p','Ready: '+area.tiles+' fetched tiles · zoom '+area.zoom+' · 1 km radius. Outside the circle the original map is unchanged.'));
                const stop=el('button','Remove photo effect'); stop.type='button'; stop.onclick=()=>{ window.DLPhotoFilter.stop(); render(); }; settingsBox.appendChild(stop);
            }
            settingsBox.appendChild(el('h4','Image adjustments'));
            for (const [key,label,min,max,tip] of [
                ['exposure','Exposure',-100,100,'Photographic exposure in stops, scaled for this image.'],
                ['highlights','Highlights',-100,100,'Adjust the lightest tones.'],
                ['shadows','Shadows',-100,100,'Adjust the darkest tones.'],
                ['contrast','Contrast',-100,100,'Expand or compress image contrast.'],
                ['brightness','Brightness',-100,100,'Offset image intensity.'],
                ['sharpness','Sharpness',-100,100,'Unsharp-mask detail from the fetched image.'],
                ['opacity','Opacity',0,100,'Opacity within the chosen circle.']]) {
                const labelNode=el('label',label+' ⓘ','rvt-control'); labelNode.title=tip;
                const number=el('strong',String(photoState()[key])+(key==='opacity'?'%':''));
                const input=document.createElement('input'); input.type='range'; input.min=min; input.max=max; input.value=photoState()[key];
                input.addEventListener('input',()=>{
                    photoState()[key]=Number(input.value); number.textContent=input.value+(key==='opacity'?'%':'');
                    updateReset(); if (window.DLPhotoFilter?.get()?.key===layerKey) window.DLPhotoFilter.update(method,photoState());
                });
                labelNode.append(number,input); settingsBox.appendChild(labelNode);
            }
            const reset=el('button',"At RVT's defaults"); reset.id='rvt-reset'; reset.type='button';
            reset.textContent='Reset image adjustments';
            reset.onclick=()=>{photoSettings[layerKey+':'+method]=photoDefaults(); if(ready) window.DLPhotoFilter.update(method,photoState()); render();};
            settingsBox.appendChild(reset);
        } else if (warning) settingsBox.appendChild(el('p', warning, 'rvt-warning'));
        else {
            const measure = config.methods[method].measure;
            if (measure) {
                settingsBox.appendChild(el('h4','Measure'));
                const res = layers[layerKey].resolution;
                const cap = Math.min(2048, Math.max(20, Math.floor(res * 40)));
                if (measure.smoothing !== undefined) slider(settingsBox, 'Smoothing radius', 'smoothing', res, Math.max(20,cap), res < 1 ? .5 : 1,
                    'Radius of the local trend surface, in ground metres. Converted to DEM pixels for RVT.', true);
                if (measure.smallest !== undefined) {
                    slider(settingsBox, 'Smallest feature', 'smallest', 0, cap, 1, 'Lower feature width in metres (MSRM; MSTP requires offline preprocessing).', true);
                    slider(settingsBox, 'Largest feature', 'largest', 1, cap, 1, 'Upper feature width in metres. Radius is bounded by tile padding.', true);
                    slider(settingsBox, 'Scaling step', 'scaling', 1, 8, 1, 'MSRM scaling factor; higher values accentuate broad features.', true);
                }
            }
            if (method === 'openness') {
                const label = el('label', 'Openness direction', 'rvt-control');
                const select = document.createElement('select');
                for (const mode of ['positive','negative']) { const option = el('option', mode); option.value = mode; select.appendChild(option); }
                select.value = state().mode;
                select.onchange = () => { state().mode = select.value; updateReset(); activate(); render(); };
                label.appendChild(select); settingsBox.appendChild(label);
            }
            settingsBox.appendChild(el('h4','Draw'));
            settingsBox.appendChild(el('span','The stretch, over the screen'));
            const chart = document.createElement('canvas'); chart.id = 'rvt-hist'; chart.width = 280; chart.height = 64; chart.setAttribute('aria-label','Histogram of current viewport terrain values');
            settingsBox.appendChild(chart);
            const s = state(), unit = config.methods[method].unit;
            const extent = Math.max(1, Math.abs(config.methods[method].stretch[0]), Math.abs(config.methods[method].stretch[1])) * 10;
            const lower = slider(settingsBox, 'Black · min (' + unit + ')', 'min', -extent, extent, .01, 'Lower contrast stretch handle.', false);
            const upper = slider(settingsBox, 'White · max (' + unit + ')', 'max', -extent, extent, .01, 'Upper contrast stretch handle.', false);
            // Prevent crossed handles and allow histogram drag as another input surface.
            lower.input.addEventListener('input', () => { if (s.min >= s.max) { s.min = s.max-.01; lower.refresh(); } });
            upper.input.addEventListener('input', () => { if (s.max <= s.min) { s.max = s.min+.01; upper.refresh(); } });
            let dragging = -1;
            chart.addEventListener('pointerdown', event => { const vals = chart._extent; if (!vals) return;
                const v = vals[0] + (event.offsetX/chart.clientWidth)*(vals[1]-vals[0]);
                dragging = Math.abs(v-s.min) < Math.abs(v-s.max) ? 0 : 1; chart.setPointerCapture(event.pointerId); });
            chart.addEventListener('pointermove', event => { if (dragging < 0 || !chart._extent) return;
                const v = chart._extent[0] + Math.max(0,Math.min(1,event.offsetX/chart.clientWidth))*(chart._extent[1]-chart._extent[0]);
                if (dragging === 0) s.min = Math.min(v,s.max-.01); else s.max = Math.max(v,s.min+.01);
                lower.refresh(); upper.refresh(); updateReset(); redraw(); });
            chart.addEventListener('pointerup', () => dragging = -1);
            const clip = el('p', '', 'rvt-readout'); clip.id = 'rvt-clip'; settingsBox.appendChild(clip);
            const fit = el('button', 'Fit to the screen'); fit.type = 'button'; fit.onclick = () => {
                const vals = chart._values; if (!vals?.length) return;
                s.min = vals[Math.floor(vals.length*.02)]; s.max = vals[Math.floor(vals.length*.98)];
                if (s.max <= s.min) s.max = s.min + .01;
                lower.refresh(); upper.refresh(); updateReset(); redraw(); };
            settingsBox.appendChild(fit);
            slider(settingsBox,'Range','range',.1,5,.1,'Multiplier of the displayed response height range; does not change the DTM.',false);
            slider(settingsBox,'Opacity','opacity',0,100,1,'Overlay transparency over the basemap.',false);
            const reset = el('button', "At RVT's defaults"); reset.id = 'rvt-reset'; reset.type = 'button';
            reset.onclick = () => { settings[layerKey+':'+method] = defaults(method); activate(); render(); };
            settingsBox.appendChild(reset);
        }
        body.appendChild(settingsBox);
        const ground = el('div', '', 'rvt-ground');
        ground.appendChild(el('h3','On the ground'));
        const toggleLabel = el('label','Section along a line  ', 'rvt-control');
        const toggle = document.createElement('input'); toggle.type='checkbox'; toggle.checked=profileOn; toggle.disabled=isPhoto() || !!warning;
        toggle.setAttribute('aria-label','Section along a line');
        toggle.onchange = () => { profileOn = toggle.checked; if (!profileOn) stopProfile(); render(); if (profileOn) status('Click two points on the map to draw a line.'); };
        toggleLabel.appendChild(toggle); toggleLabel.appendChild(el('strong', profileOn ? ' ON' : ' OFF'));
        ground.append(toggleLabel, el('p',isPhoto()
            ? 'A true ground profile needs elevation data; WMS images do not contain it.'
            : 'Draw a line across a bank or a ditch: its true profile, what this method makes of it, and the numbers to copy.'));
        const output = el('div','', 'rvt-profile'); output.id='rvt-profile'; ground.appendChild(output);
        body.appendChild(ground);
        if (profileOn && profilePoints.length === 2) updateProfile();
        const statusNode = el('p', isPhoto() ? 'Select and prefetch an area to apply the photo effect.' : warning || (busy ? 'Loading float terrain tiles…' : 'Select a method'), 'rvt-status'); statusNode.id = 'rvt-status';
        body.appendChild(statusNode);
        body.appendChild(el('small','RVT © ZRC SAZU / UL FGG · Apache-2.0 · Kokalj & Somrak (2019)'));
        updateReset(); histogram();
    }
    function previewThumb(thumb, id) {
        const z = map.getZoom(), p = map.project(map.getCenter(), z);
        const x = Math.floor(p.x / 256), y = Math.floor(p.y / 256);
        const key = [layerKey, id, z, x, y].join(':');
        function draw(data) {
            if (!thumb.isConnected) return;
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 44;
            const values = Array.from(data).filter(Number.isFinite).sort((a,b) => a-b);
            if (!values.length) return;
            const low = values[Math.floor(values.length*.02)], high = values[Math.floor(values.length*.98)];
            const grey = canvas.getContext('2d').createImageData(44,44);
            for (let j=0;j<44;j++) for(let i=0;i<44;i++) {
                const v=data[Math.floor(j*256/44)*256+Math.floor(i*256/44)], n=(j*44+i)*4;
                if (!Number.isFinite(v)) continue;
                grey.data[n]=grey.data[n+1]=grey.data[n+2]=Math.round(255*Math.max(0,Math.min(1,(v-low)/(high-low||1)))); grey.data[n+3]=255;
            }
            canvas.getContext('2d').putImageData(grey,0,0);
            thumb.replaceChildren(canvas);
        }
        if (previewCache.has(key)) { draw(previewCache.get(key)); return; }
        // Small lazy preview of the actual RVT float tile, never a substitute rendered image.
        const observer = new IntersectionObserver(entries => {
            if (!entries[0].isIntersecting) return;
            observer.disconnect();
            const q = new URLSearchParams(config.methods[id].measure || {});
            fetch('/api/rvt/tile/' + [layerKey,id,z,x,y+'.bin'].join('/') + '?' + q)
                .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
                .then(buf => { if (buf.byteLength !== 262144) return; const data = new Float32Array(buf);
                    previewCache.set(key,data); if (previewCache.size > 30) previewCache.delete(previewCache.keys().next().value); draw(data); })
                .catch(() => {});
        }, {root: body});
        observer.observe(thumb);
    }
    function choose(id) { clearTimeout(timer); method = id; activate(); render(); }
    function stopProfile() {
        profileOn = false; profilePoints = [];
        if (profileLine) { map.removeLayer(profileLine); profileLine = null; }
        const output = body.querySelector('#rvt-profile'); if (output) output.replaceChildren();
    }
    if (!map.getPane('rvt-profile-pane')) { map.createPane('rvt-profile-pane'); map.getPane('rvt-profile-pane').style.zIndex = 710; }
    map.on('click', event => {
        if (window.dlApmPicking || !profileOn || body.hidden || isPhoto() || blocked(method)) return;   // APM point picking owns this map click
        if (profilePoints.length === 2) profilePoints = [];
        profilePoints.push(event.latlng);
        if (profileLine) { map.removeLayer(profileLine); profileLine = null; }
        if (profilePoints.length === 2) {
            profileLine = L.polyline(profilePoints, { color:'#ffb75e', weight:3, pane:'rvt-profile-pane' }).addTo(map);
            updateProfile();
        } else status('Click the second point on the map to finish the section.');
    });
    let profileSerial = 0;
    async function updateProfile() {
        if (!profileOn || profilePoints.length !== 2) return;
        const output = body.querySelector('#rvt-profile'); if (!output) return;
        output.textContent = 'Sampling true DTM heights…';
        const serial = ++profileSerial;
        const q = new URLSearchParams({lat1:profilePoints[0].lat,lon1:profilePoints[0].lng,
            lat2:profilePoints[1].lat,lon2:profilePoints[1].lng});
        try {
            const response = await fetch('/api/rvt/profile/' + encodeURIComponent(layerKey) + '?' + q);
            if (!response.ok) throw Error((await response.json()).error || 'Profile unavailable');
            const {samples} = await response.json();
            if (serial !== profileSerial || !output.isConnected || !profileOn) return;
            const z = map.getZoom();
            const rows = samples.map(sample => {
                const p = map.project([sample.lat,sample.lon], z);
                const x = Math.floor(p.x/256), y = Math.floor(p.y/256);
                const tile = tileStore.get([z,x,y].join('/'));
                const ix = Math.floor(p.x - x*256), iy = Math.floor(p.y - y*256);
                const value = tile?.data[iy*256+ix];
                return {...sample, methodValue: Number.isFinite(value) ? value : null};
            });
            output.replaceChildren();
            const chart = document.createElement('canvas'); chart.width=280; chart.height=105;
            chart.setAttribute('aria-label','DTM height and visualization along selected line');
            const ctx = chart.getContext('2d'); ctx.fillStyle='#203734'; ctx.fillRect(0,0,280,105);
            for (const [key,color] of [['height','#ffb75e'],['methodValue','#85dcda']]) {
                const valid = rows.map((r,i) => [r[key],i]).filter(([v]) => Number.isFinite(v));
                if (valid.length < 2) continue;
                const min = Math.min(...valid.map(v=>v[0])), max = Math.max(...valid.map(v=>v[0]));
                ctx.strokeStyle=color; ctx.lineWidth=2; ctx.beginPath();
                valid.forEach(([v,i],n) => { const px=i/100*279, py=94-(v-min)/(max-min||1)*83;
                    if (!n || i !== valid[n-1][1]+1) ctx.moveTo(px,py); else ctx.lineTo(px,py); }); ctx.stroke();
            }
            output.append(chart,el('small','Orange: true DTM height (m) · Teal: current method (' + config.methods[method].unit + '). Each series has its own scale. Values outside loaded method tiles are blank.'));
            const csv = 'distance_m,latitude,longitude,dtm_height_m,method_value_' + config.methods[method].unit + '\n' +
                rows.map(r=>[r.distance,r.lat.toFixed(7),r.lon.toFixed(7),r.height ?? '',r.methodValue?.toFixed(4) ?? ''].join(',')).join('\n');
            const copy = el('button','Copy 101 profile samples as CSV'); copy.type='button';
            copy.onclick = () => navigator.clipboard.writeText(csv).then(() => { copy.textContent='Copied CSV'; }).catch(() => { copy.textContent='Clipboard unavailable'; });
            output.appendChild(copy);
            output.appendChild(el('p', 'Start: ' + (rows[0].height ?? 'nodata') + ' m · End: ' + (rows.at(-1).height ?? 'nodata') + ' m · ' + rows.at(-1).distance + ' m line'));
        } catch (err) { if (serial === profileSerial && output.isConnected) output.textContent = err.message; }
    }
    function rowKey(row) {
        if (row.dataset.albaniaRow) return 'albania_' + row.dataset.albaniaRow;
        if (row.dataset.danishRow) return 'danish_' + row.dataset.danishRow;
        const input = row.querySelector('input[id$="OpacitySlider"]');
        if (input) return input.id.replace(/^lidar/, '').replace(/OpacitySlider$/, '').replace(/^./, c => c.toLowerCase());
        return null;
    }
    function attachButtons() {
        const rows = document.querySelectorAll('#lidarEuropeanSubLayers .lidar-country-row, #lidarSubLayers > div, #albaniaLidarLayers .lidar-country-row, #danishLidarLayers .lidar-country-row');
        rows.forEach(row => {
            if (row.querySelector('.rvt-row-button')) return;
            const key = rowKey(row); if (!key || !/^[a-zA-Z0-9_-]{1,60}$/.test(key)) return;
            const button = el('button', '⚙ Settings', 'rvt-row-button'); button.type='button';
            button.setAttribute('aria-label','LiDAR Settings for ' + key);
            button.onclick = event => {
                event.preventDefault(); event.stopPropagation();
                stopProfile(); if (layerKey !== key && window.DLPhotoFilter?.get()) window.DLPhotoFilter.stop(); layerKey = key;
                const title = row.querySelector('.albania-layer-title, .danish-layer-title');
                layerName = (title?.textContent || row.firstElementChild?.textContent || key).trim().replace(/ⓘ/g,'').slice(0,85);
                body.hidden=false;
                if (!config) { body.textContent='Loading LiDAR Settings…'; return; }
                activate(); render();
                const activeLayer = window.DLPhotoFilter?.active(layerKey);
                if (activeLayer && window.DLPhotoFilter?.choose) {
                    body.hidden=true;
                    window.DLPhotoFilter.choose(layerKey, method, photoState());
                }
            };
            const header = row.firstElementChild;
            if (header) header.appendChild(button); else row.prepend(button);
        });
    }
    const mounts = ['lidarEuropeanSubLayers','lidarSubLayers','albaniaLidarLayers','danishLidarLayers'];
    mounts.forEach(id => { const mount = document.getElementById(id); if (!mount) return;
        new MutationObserver(attachButtons).observe(mount,{childList:true,subtree:true}); });
    attachButtons();
    window.addEventListener('dl:photo-filter', event=>{
        if (isPhoto() && /ready|failed|failed|unavailable/i.test(event.detail.status)) body.hidden=false;
        if(!body.hidden && isPhoto()) { if (/ready|off|failed/i.test(event.detail.status)) render(); status(event.detail.status); }
    });
    fetch('/api/rvt/metadata').then(async response => { if (!response.ok) throw Error('No raw DTM service on this deployment'); return response.json(); })
        .then(info => { if (!info || !info.config?.groups || !info.layers) throw Error('No raw DTM service');
            config = info.config; layers = info.layers; layerKey = layerKey || 'nlAhn'; if (!body.hidden) render(); })
        .catch(() => fetch('rvt_service/methods.json').then(r => r.json()).then(c => {
            config = c; layerKey = layerKey || 'nlAhn'; if (!body.hidden) render(); status('No raw DTM service on this deployment; existing map imagery is unchanged.');
        }).catch(() => { body.appendChild(el('p', 'Terrain filters unavailable: configuration could not be loaded.')); }));
    map.on('moveend zoomend', histogram);
})();
