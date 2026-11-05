#!/usr/bin/env node
'use strict';
/* Real Chromium + Leaflet + worker/canvas test. No external services.
 *
 * PLAYWRIGHT_MODULE_DIR=/path/to/node_modules node test-roman-roads-browser.js
 * Optionally set CHROMIUM_EXECUTABLE_PATH and/or ROMAN_ROADS_TEST_DATA to an
 * external Itiner-e NDJSON snapshot containing Aiton. Skips without Playwright.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const ROOT = __dirname;
let playwright, chromium;
for (const dir of [process.env.PLAYWRIGHT_MODULE_DIR, path.join(ROOT, 'node_modules')].filter(Boolean)) {
    const req = createRequire(path.resolve(dir, 'index.js'));
    try { playwright = req('playwright'); } catch (_) {
        try { playwright = req('playwright-core'); } catch (__) { continue; }
    }
    try { chromium = req('@sparticuz/chromium'); } catch (_) { /* normal Playwright install */ }
    break;
}
if (!playwright) {
    console.log('SKIP — install Playwright and Chromium for the Roman roads browser test');
    process.exit(0);
}

const aiton = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/roman-road-aiton.geojson'), 'utf8'));
const roads = Array.from({ length: 75 }, (_, i) => ({ type: 'Feature', geometry: {
    type: 'LineString', coordinates: [[-8 + i * 0.002, 35], [-7.999 + i * 0.002, 35.001]]
} }));
roads.splice(25, 0, aiton);
const fixture = Buffer.from(roads.map(r => JSON.stringify(r)).join('\n')); // no final newline
const fullPath = process.env.ROMAN_ROADS_TEST_DATA;
const fullCount = fullPath ? fs.readFileSync(fullPath, 'utf8').split('\n').filter(s => s.trim()).length : 0;
const html = `<!doctype html><html><head><link rel="stylesheet" href="/css/leaflet.css">
<style>html,body{margin:0}#map{width:900px;height:650px}</style></head><body><div id="map"></div>
<script src="/js/leaflet.js"></script><script src="/js/roman-roads-parser.js?v=test"></script>
<script src="/js/roman-roads.js?v=test"></script><script>
window.map = L.map('map', {zoomAnimation:false, fadeAnimation:false, zoomControl:false,
    attributionControl:false}).setView([46.6873,23.738356], 8);
map.createPane('pane_roman');
window.layer = DetectLabRomanRoads.createLayer({maxItemsPerTile:4, weight:4, opacity:1, color:'#ff0000'}).addTo(map);
var full = location.search.indexOf('full') !== -1;
var fallback = location.search.indexOf('fallback') !== -1;
window.ticks = 0;
if (fallback) {
    var originalFetch = window.fetch;
    window.fetch = function(url, opts) {
        return originalFetch(url, opts).then(function(resp) {
            return {ok:resp.ok, status:resp.status, headers:resp.headers, body:null,
                text:function(){ return resp.text(); }};
        });
    };
    setInterval(function(){ window.ticks++; }, 0);
}
window.handle = DetectLabRomanRoads.load(full ? '/roads-full' : '/roads-small', {
    noWorker: fallback,
    config: full ? {maxBatchSegments:4000,maxSegments:350000,maxVertices:3000000,maxBytes:40*1024*1024}
                 : {maxBatchSegments:8,maxSegments:2000,maxVertices:100000,maxBytes:4*1024*1024},
    onBatch:function(p){ layer.addBatch(p); }, onDone:function(s){ window.done=s; },
    onError:function(e){ window.error=e; }
});
</script></body></html>`;

const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://test').pathname;
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return; }
    if (name === '/roads-small') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Length': fixture.length });
        res.end(fixture); return;
    }
    if (name === '/roads-full' && fullPath) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Length': fs.statSync(fullPath).size });
        fs.createReadStream(fullPath).pipe(res); return;
    }
    const file = path.resolve(ROOT, '.' + name);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'application/javascript' : 'text/css' });
    fs.createReadStream(file).pipe(res);
});

(async () => {
    let browser;
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    try {
        const launch = { headless: true };
        if (chromium) {
            launch.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || await chromium.executablePath();
            launch.args = chromium.args;
        } else if (process.env.CHROMIUM_EXECUTABLE_PATH) {
            launch.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
            launch.args = ['--no-sandbox'];
        }
        browser = await playwright.chromium.launch(launch);
        const page = await browser.newPage(); // reuse for single-process Chromium
        const errors = [], workers = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('worker', worker => workers.push(worker.url()));
        const cases = [
            { name: 'fixture / worker', query: '', count: roads.length },
            { name: 'fixture / text fallback', query: '?fallback', count: roads.length, fallback: true }
        ];
        if (fullPath) cases.push(
            { name: 'external snapshot / worker', query: '?full', count: fullCount },
            { name: 'external snapshot / text fallback', query: '?full&fallback', count: fullCount, fallback: true, full: true }
        );
        for (const test of cases) {
            const workerCount = workers.length;
            await page.goto('http://127.0.0.1:' + server.address().port + '/' + test.query);
            await page.waitForFunction(() => window.done || window.error, null, { timeout: 60000 });
            const result = await page.evaluate(() => ({ stats: window.done, error: window.error,
                isWorker: window.handle.isWorker, ticks: window.ticks }));
            assert(!result.error, test.name + ': ' + result.error);
            assert.equal(result.isWorker, !test.fallback, test.name + ': expected loader path');
            if (!test.fallback) assert(workers.slice(workerCount).some(url => url.includes('roman-roads-worker.js')),
                test.name + ': a real dedicated worker ran');
            if (test.full && test.fallback) assert(result.ticks > 0, test.name + ': main thread yielded during parsing');
            assert.equal(result.stats.segments, test.count, test.name + ': all roads loaded');
            assert.equal(result.stats.sampled, 0, test.name + ': under-budget source is not sampled');
            for (const zoom of [8, 12, 15]) {
                await page.evaluate(z => { layer._itemBudget = 4; map.setZoom(z); }, zoom);
                await page.waitForFunction(z => Array.from(document.querySelectorAll('.dl-roman-roads-tile')).some(c => {
                    if (!c._dlRomanEntry || c._dlRomanEntry.coords.z !== z || !c._dlRomanEntry.painted) return false;
                    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) return true;
                    return false;
                }), zoom, { timeout: 10000 });
                const distance = await page.evaluate(() => layer.nearestRoadMeters(46.6873, 23.738356, 10));
                assert(distance !== null && distance < 1, test.name + ': Aiton remains indexed at z' + zoom);
            }
            console.log('  ✓ ' + test.name + ': ' + result.stats.segments + ' roads, visible near Aiton at z8/z12/z15');
        }
        assert.deepEqual(errors, [], 'no uncaught browser errors');
        console.log('✅ test-roman-roads-browser.js passed.');
    } finally {
        if (browser) await browser.close();
        server.close();
    }
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
