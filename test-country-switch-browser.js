// Optional real Leaflet/SVG geometry regression (no network or map tiles).
// PUPPETEER_MODULE_DIR=/path/to/node_modules node test-country-switch-browser.js
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
            await page.setContent(`<style>${read('css/leaflet.css')}\n${read('css/map3d-terrain.css')}
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
            for (const iso of ['DE', 'IT', 'RO', 'FR', 'DE']) {
                const result = await page.evaluate(async iso => {
                    window.terrainOpen = true;
                    document.body.classList.add('is-3d');
                    await DetectLabGlobeGate.selectCountry(iso);
                    const t = DetectLabGlobeGate._test, map = _dlMap;
                    const errors = [], paths = [];
                    const visit = layer => {
                        if (layer.eachLayer) { layer.eachLayer(visit); return; }
                        if (!layer._path) return;
                        paths.push(layer._path);
                        const rings = [];
                        const collect = arr => {
                            if (arr.length && arr[0].lat !== undefined) rings.push(arr);
                            else arr.forEach(collect);
                        };
                        collect(layer._latlngs);
                        for (let r = 0; r < rings.length; r++) {
                            for (let i = 0; i < rings[r].length; i++) {
                                const expected = map.latLngToLayerPoint(rings[r][i]);
                                const actual = layer._rings[r][i];
                                errors.push(Math.hypot(actual.x - expected.x, actual.y - expected.y));
                            }
                        }
                        // Check the composed SVG + rotated map-pane transform,
                        // not just Leaflet's cached projected coordinates.
                        const point = layer._rings[0][0];
                        const screen = new DOMPoint(point.x, point.y).matrixTransform(layer._path.getScreenCTM());
                        const expected = map.latLngToContainerPoint(rings[0][0]);
                        const rect = map.getContainer().getBoundingClientRect();
                        errors.push(Math.hypot(screen.x - rect.left - expected.x, screen.y - rect.top - expected.y));
                    };
                    visit(t.state.boundsLayer);
                    return { selected: _detectlabSelectedCountry, outline: t.state.boundsIso,
                        terrainOpen, centerInCountry: L.latLngBounds(
                            [_detectlabCountryBounds[1], _detectlabCountryBounds[0]],
                            [_detectlabCountryBounds[3], _detectlabCountryBounds[2]]).contains(map.getCenter()),
                        pathCount: paths.length, bearing: map.getBearing(), rotationLocked: map.isRotateLocked(),
                        maxError: Math.max(...errors), zoomAnimating: !!map._animatingZoom,
                        renderedPaths: map.getPane(t.BOUNDS_PANE).querySelectorAll('path').length };
                }, iso);
                assert.strictEqual(result.selected, iso);
                assert.strictEqual(result.outline, iso);
                assert(!result.terrainOpen && !result.zoomAnimating && result.centerInCountry);
                assert.strictEqual(result.bearing, 0, 'country starts north-up after a rotated terrain hand-off');
                assert(result.rotationLocked, 'country reset does not change the user rotation-lock preference');
                assert(result.pathCount > 0 && result.renderedPaths === result.pathCount, 'only new outline is rendered');
                assert(result.maxError <= 1, `country outline projection drift: ${JSON.stringify(result)}`);
            }
            console.log(`✓ ${width}px: repeated 3D country switches fit immediately; north-up SVG outlines stay aligned after a rotated terrain hand-off`);
        }
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
