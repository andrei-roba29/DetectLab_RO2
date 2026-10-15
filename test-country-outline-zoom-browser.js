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
                const oldRenderer = layer._renderer;
                await DetectLabGlobeGate.selectCountry('DE');
                return { maxError, samples, steps, oldRendererRemoved: !map.hasLayer(oldRenderer),
                    svgCount: map.getPane(t.BOUNDS_PANE).querySelectorAll('svg').length };
            });
            assert(result.samples > 10, 'test samples live animated zoom frames');
            assert(result.maxError < 2, `outline moved relative to LiDAR tiles: ${JSON.stringify(result)}`);
            assert(result.oldRendererRemoved && result.svgCount === 1, 'country switching removes the dedicated renderer');
            console.log(`✓ ${width}px: country outline stays aligned with LiDAR tiles throughout animated zoom, north-up and rotated`);
        }
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
