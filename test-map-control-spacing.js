// Run: node test-map-control-spacing.js
// Optional browser geometry checks:
// PUPPETEER_MODULE_DIR=/path/to/node_modules node test-map-control-spacing.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const skin = read('css/map3d-terrain.css');
const styles = read('css/styles.css');
const html = read('index.html');
const sw = read('sw.js');

assert(/#map3d-surface \.maplibregl-ctrl-top-right\s*\{\s*top: calc\(60px \+ env\(safe-area-inset-top, 0px\)\)/.test(skin),
    'terrain corner reserves the help/exit row and respects the top safe area');
assert(skin.includes('#map3d-surface .maplibregl-ctrl-top-right { display: none; }'),
    'mobile terrain corner remains hidden as before');
assert(/body:not\(\.is-pwa\) \.map-frame\.is-fullscreen #detectlab-map \.leaflet-left \.leaflet-control-zoom\s*\{\s*margin-left: calc\(18px \+ env\(safe-area-inset-left, 0px\)\)/.test(styles),
    'extra zoom inset is web fullscreen only and respects the left safe area');
for (const file of ['css/styles.css', 'css/map3d-terrain.css']) {
    const tag = file === 'css/styles.css' ? '20261014-map-control-spacing' : '20261014-3d-slider-layout';
    const url = file + '?v=' + tag;
    assert(html.includes(url) && sw.includes("'" + url + "'"), 'cache-busted and precached: ' + file);
}
assert(Number(sw.match(/CACHE_NAME = 'detectlab-v(\d+)-/)[1]) >= 197, 'shell cache bumped');
console.log('✓ spacing, mobile/PWA scoping and cache wiring');

async function browserChecks() {
    if (!process.env.PUPPETEER_MODULE_DIR) {
        console.log('Browser checks skipped (set PUPPETEER_MODULE_DIR to enable).');
        return;
    }
    const req = require('module').createRequire(path.join(process.env.PUPPETEER_MODULE_DIR, '..', 'package.json'));
    const puppeteer = req('puppeteer-core');
    const chromiumModule = await import(require('url').pathToFileURL(req.resolve('@sparticuz/chromium')));
    const chromium = chromiumModule.default;
    const browser = await puppeteer.launch({
        executablePath: await chromium.executablePath(), args: chromium.args, headless: true
    });
    try {
        const page = await browser.newPage();
        // Real styles, with minimal Leaflet/MapLibre control markup. No WebGL,
        // auth or remote tiles needed to test the two independent CSS corners.
        const sheets = ['css/leaflet.css', 'css/styles.css', 'css/maplibre-gl.css',
            'css/map3d-terrain.css', 'css/tutorial.css'].map(file => `<style>${read(file)}</style>`).join('');
        for (const width of [1280, 768, 390]) {
            await page.setViewport({ width, height: 800 });
            await page.setContent(`${sheets}<style>
                body { margin:0; }
                .map-frame { position:relative; width:100%; height:700px; }
                .map-wrapper { position:relative; width:100%; height:100%; }
                #detectlab-map { width:100%; height:100%; }
                </style><div class="map-frame"><div class="map-wrapper">
                <div id="detectlab-map"><div class="leaflet-control-container">
                  <div class="leaflet-top leaflet-left"><div class="leaflet-control leaflet-control-zoom leaflet-bar">
                    <a id="zoom-in">+</a><a>−</a>
                  </div></div>
                </div></div>
                <div id="map3d-surface"><div class="maplibregl-control-container">
                  <div class="maplibregl-ctrl-top-right"><div class="maplibregl-ctrl maplibregl-ctrl-group">
                    <button id="terrain" title="Disable terrain"></button>
                  </div></div>
                </div></div></div><button class="map-help-btn" id="mapHelpBtn">?</button></div>`);
            for (const fullscreen of [false, true]) {
                for (const threeD of [false, true]) {
                    await page.evaluate(({ fullscreen, threeD }) => {
                        document.body.className = threeD ? 'is-3d' : '';
                        document.querySelector('.map-frame').classList.toggle('is-fullscreen', fullscreen);
                        document.querySelector('.map-wrapper').classList.toggle('is-fullscreen', fullscreen);
                    }, { fullscreen, threeD });
                    const geometry = await page.evaluate(() => {
                        const box = id => {
                            const r = document.getElementById(id).getBoundingClientRect();
                            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
                        };
                        return { terrain: box('terrain'), help: box('mapHelpBtn'), zoom: box('zoom-in'), map: box('detectlab-map') };
                    });
                    if (threeD && width > 720) {
                        assert(geometry.terrain.top >= geometry.help.bottom + 8,
                            `terrain clears help: width=${width}, fullscreen=${fullscreen}`);
                        assert(await page.evaluate(() => document.elementFromPoint(
                            document.getElementById('terrain').getBoundingClientRect().left + 14,
                            document.getElementById('terrain').getBoundingClientRect().top + 14
                        ).closest('#terrain') !== null), 'terrain is clickable, not covered');
                    } else if (!threeD) {
                        assert.strictEqual(geometry.zoom.left - geometry.map.left, fullscreen ? 18 : 10,
                            `zoom inset: width=${width}, fullscreen=${fullscreen}`);
                    }
                }
            }
            await page.evaluate(() => { document.body.className = 'is-pwa'; });
            assert.strictEqual(await page.$eval('#zoom-in', el => el.getBoundingClientRect().left), 10,
                'PWA keeps the original zoom inset');
            console.log(`✓ browser geometry at ${width}px: normal/fullscreen, 2D/3D, PWA`);
        }
    } finally { await browser.close(); }
}
browserChecks().catch(error => { console.error(error); process.exitCode = 1; });
