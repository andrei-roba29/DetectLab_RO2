// Animated outline/LiDAR tile alignment regression. No external tile requests.
// PUPPETEER_MODULE_DIR=/path/to/node_modules node test-country-outline-zoom-browser.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
async function main() {
    if (!process.env.PUPPETEER_MODULE_DIR) {
        console.log('Browser checks skipped (set PUPPETEER_MODULE_DIR to enable).');
        return;
    }
    const req = require('module').createRequire(path.join(process.env.PUPPETEER_MODULE_DIR, '..', 'package.json'));
    const puppeteer = req('puppeteer-core');
    const chromium = (await import(require('url').pathToFileURL(req.resolve('@sparticuz/chromium')))).default;
    const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
    try {
        const page = await browser.newPage();
        for (const width of [1280, 390]) {
            await page.setViewport({ width, height: 800 });
            await page.setContent(`<style>${read('css/leaflet.css')}\n${read('css/styles.css')}
                body { margin:0 } #detectlab-map { height:800px; width:100%; }
                </style><div id="detectlab-map"></div>`);
            for (const file of ['js/leaflet.js', 'js/map-rotate.js', 'js/d3.min.js',
                'js/topojson-client.min.js', 'js/globe-country-picker.js']) {
                await page.addScriptTag({ path: path.join(__dirname, file) });
            }
            await page.evaluate(atlas => {
                window._dlMap = L.map('detectlab-map', { minZoom: 2, maxZoom: 20, rotate: true,
                    zoomAnimation: true, zoomAnimationThreshold: 10 }).setView([51, 12], 3);
                const t = DetectLabGlobeGate._test;
                t.G.world = topojson.feature(atlas, atlas.objects.countries).features;
                t.buildEurope(null);
                t.state.readyPromise = Promise.resolve();
                window.terrainOpen = false;
                window.DetectLabMap3D = {
                    isOpen() { return window.terrainOpen; },
                    close() {
                        window.terrainOpen = false;
                        // Same camera hand-off as the terrain viewer's close().
                        _dlMap.setBearing(35, { noMove: true });
                        _dlMap.setView([48, 12], 10, { animate: false });
                        _dlMap.setRotateLocked(true);
                        document.body.classList.remove('is-3d');
                    }
                };
            }, JSON.parse(read('data/countries-50m.json')));
            const result = await page.evaluate(async () => {
                await DetectLabGlobeGate.selectCountry('RO');
                const map = _dlMap, t = DetectLabGlobeGate._test;
                const layer = t.state.boundsLayer.getLayers()[0];
                let ring = layer.getLatLngs();
                while (Array.isArray(ring[0])) ring = ring[0];
                const latlng = ring[0];
                map.createPane('pane_lidar').style.zIndex = 610;
                // Offline tile grid: same pane, asynchronous arrival and zoom
                // lifecycle as LiDAR WMS, without depending on a remote service.
                const tiles = L.gridLayer({maxZoom:20, pane:'pane_lidar'});
                tiles.createTile = (coords, done) => {
                    const canvas = document.createElement('canvas');
                    setTimeout(() => done(null, canvas), 60);
                    return canvas;
                };
                tiles.addTo(map);
                let maxError = 0, samples = 0; const steps = [];
                const startZoom = map.getZoom();
                for (const bearing of [0, 35]) {
                    map.setBearing(bearing, {force:true});
                    for (const target of [startZoom + 6, startZoom, startZoom + 2, startZoom]) {
                        const level = tiles._levels[tiles._tileZoom];
                        const point = map.project(latlng, tiles._tileZoom).subtract(level.origin);
                        const anchor = document.createElement('span');
                        anchor.style.cssText = `position:absolute;left:${point.x}px;top:${point.y}px;width:0;height:0;`;
                        level.el.appendChild(anchor);
                        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                        let localMax = 0, localSamples = 0;
                        map.setZoom(target, {animate:true});
                        // Sample *during* the CSS transition, not just zoomend.
                        for (let j = 0; j < 20; j++) {
                            await new Promise(resolve => requestAnimationFrame(resolve));
                            if (!map._animatingZoom || !anchor.isConnected) continue;
                            const p = layer._rings[0][0];
                            const actual = new DOMPoint(p.x,p.y).matrixTransform(layer._path.getScreenCTM());
                            const expected = anchor.getBoundingClientRect();
                            maxError = Math.max(maxError, Math.hypot(actual.x-expected.x, actual.y-expected.y));
                            localMax = Math.max(localMax, Math.hypot(actual.x-expected.x, actual.y-expected.y));
                            localSamples++; samples++;
                        }
                        steps.push({bearing,target,localMax,localSamples});
                        anchor.remove();
                    }
                }
                // A turned map must not clip away the border the user can see.
                // L.Renderer._bounds is both the <svg> element's box and the
                // window Polyline._clipPoints keeps, so any visible vertex
                // outside it is drawn nowhere — the old rotation bug lost a
                // quarter of the ring at 35° and all of it at 90°, while the
                // anchor test above stayed green (the offset cancels).
                const clipReport = [];
                // z5 keeps the whole country inside a 390px viewport as well as a
                // 1280px one, so every scenario has vertices to measure; the pan
                // is a fraction of the viewport, i.e. a drag that leaves some of
                // the border on screen.
                const viewSize = map.getSize();
                map.setView(layer.getBounds().getCenter(), 5, { animate: false });
                ring = layer.getLatLngs();
                while (Array.isArray(ring[0])) ring = ring[0];
                for (const bearing of [0, 35, 90]) {
                    map.setBearing(bearing, { force: true });
                    for (const pan of [[0, 0], [Math.round(viewSize.x * 0.15), Math.round(viewSize.y * 0.15)]]) {
                        // panBy ends the view change like a real drag does, so the
                        // renderer recomputes its box with the turn applied.
                        map.panBy(pan, { animate: false });
                        const clipBox = layer._renderer._bounds;
                        let visible = 0, clipped = 0;
                        for (const ll of ring) {
                            const c = map.latLngToContainerPoint(ll);
                            if (c.x < 1 || c.y < 1 || c.x > viewSize.x - 1 || c.y > viewSize.y - 1) continue;
                            visible++;
                            if (!clipBox.contains(map.latLngToLayerPoint(ll))) clipped++;
                        }
                        clipReport.push({
                            bearing, pan: pan.join(','), visible, clipped,
                            painted: (layer._path.getAttribute('d') || '').length > 10
                        });
                    }
                }
                // (Re)drawn mid-zoom: an outline whose renderer is born while
                // a zoom animation is in flight never receives its zoomanim,
                // so it used to paint straight onto the target frame — flat,
                // fully zoomed — while the tiles were still scaling (the
                // intermittent “border zooms in 2D”). It must now either
                // stay aligned or stay hidden until the zoom settles, and
                // its stroke must not CSS-scale (non-scaling-stroke).
                map.setView(layer.getBounds().getCenter(), startZoom, { animate: false });
                await new Promise(resolve => setTimeout(resolve, 60));
                const midZoom = { hidden: 0, visible: 0, maxError: 0 };
                map.setZoom(startZoom + 4, { animate: true });
                while (!map._animatingZoom) await new Promise(r => setTimeout(r, 5));
                // Simulate the 10m refinement landing mid-flight: a new
                // feature object forces showCountryBoundsLayer to swap the
                // outline and its dedicated renderer.
                const roEntry = t.G.byIso.RO;
                roEntry.feature = JSON.parse(JSON.stringify(roEntry.feature));
                t.refreshCountryBoundsLayer();
                const midLayer = t.state.boundsLayer.getLayers()[0];
                const level2 = tiles._levels[tiles._tileZoom];
                const anchorPoint = map.project(latlng, tiles._tileZoom).subtract(level2.origin);
                const anchor2 = document.createElement('span');
                anchor2.style.cssText = `position:absolute;left:${anchorPoint.x}px;top:${anchorPoint.y}px;width:0;height:0;`;
                level2.el.appendChild(anchor2);
                const strokeEffect = midLayer._path.getAttribute('vector-effect');
                for (let j = 0; j < 40 && map._animatingZoom; j++) {
                    await new Promise(resolve => requestAnimationFrame(resolve));
                    const container = midLayer._renderer && midLayer._renderer._container;
                    if (!container || !container.isConnected) continue;
                    if (container.style.visibility === 'hidden') { midZoom.hidden++; continue; }
                    midZoom.visible++;
                    const p = midLayer._rings[0][0];
                    const actual = new DOMPoint(p.x, p.y).matrixTransform(midLayer._path.getScreenCTM());
                    const expected = anchor2.getBoundingClientRect();
                    midZoom.maxError = Math.max(midZoom.maxError, Math.hypot(actual.x - expected.x, actual.y - expected.y));
                }
                anchor2.remove();
                while (map._animatingZoom) await new Promise(r => setTimeout(r, 10));
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const settledContainer = midLayer._renderer._container;
                const mapRect = map.getContainer().getBoundingClientRect();
                const want = map.latLngToContainerPoint(latlng);
                const gotPoint = midLayer._rings[0][0];
                const got = new DOMPoint(gotPoint.x, gotPoint.y).matrixTransform(midLayer._path.getScreenCTM());
                const settledError = Math.hypot(
                    got.x - (mapRect.left + want.x), got.y - (mapRect.top + want.y));
                const midZoomReport = {
                    hiddenFrames: midZoom.hidden,
                    visibleFrames: midZoom.visible,
                    maxVisibleError: midZoom.maxError,
                    settledVisible: settledContainer.style.visibility !== 'hidden',
                    settledError,
                    strokeEffect
                };
                const oldRenderer = layer._renderer;
                await DetectLabGlobeGate.selectCountry('DE');
                return { maxError, samples, steps, clipReport, midZoom: midZoomReport, oldRendererRemoved: !map.hasLayer(oldRenderer),
                    svgCount: map.getPane(t.BOUNDS_PANE).querySelectorAll('svg').length };
            });
            assert(result.samples > 10, 'test samples live animated zoom frames');
            assert(result.maxError < 2, `outline moved relative to LiDAR tiles: ${JSON.stringify(result)}`);
            assert(result.clipReport.reduce((n, r) => n + r.visible, 0) > 0,
                `the outline has to be on screen for the clip checks to mean anything: ${JSON.stringify(result.clipReport)}`);
            for (const r of result.clipReport) {
                assert(r.clipped === 0, `turned map clipped visible border away: ${JSON.stringify(r)}`);
                if (r.visible) assert(r.painted, `the visible outline must be painted: ${JSON.stringify(r)}`);
            }
            assert(result.oldRendererRemoved && result.svgCount === 1, 'country switching removes the dedicated renderer');
            assert(result.midZoom.hiddenFrames > 0,
                `an outline redrawn mid-zoom must wait the animation out hidden instead of painting at the target frame: ${JSON.stringify(result.midZoom)}`);
            assert(result.midZoom.maxVisibleError < 2,
                `a mid-zoom outline that is visible must stay aligned: ${JSON.stringify(result.midZoom)}`);
            assert(result.midZoom.settledVisible && result.midZoom.settledError < 2,
                `the mid-zoom outline must reappear, aligned, when the zoom settles: ${JSON.stringify(result.midZoom)}`);
            assert.strictEqual(result.midZoom.strokeEffect, 'non-scaling-stroke',
                'the border stroke must not CSS-scale during an animated zoom');
            console.log(`✓ ${width}px: country outline stays aligned with LiDAR tiles throughout animated zoom, north-up and rotated, is never clipped away by a turned view (${result.clipReport.length} bearing/pan scenarios), and a mid-zoom redraw waits the animation out instead of zooming flat`);
        }
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
