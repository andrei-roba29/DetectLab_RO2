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
const viewer = read('js/map3d-terrain.js');

/* The top-right corner belongs to the app's own help button. MapLibre's
 * TerrainControl — the “Disable terrain” button — was the only widget ever
 * parked there; with it gone from the viewer, neither the desktop row
 * reservation nor the mobile `display: none` that used to hide it has
 * anything left to act on, so both rules are gone. */
assert(!/\.maplibregl-ctrl-top-right/.test(skin),
    'no rule reserves or hides a MapLibre control in the top-right corner');
assert(!/#map3d-surface \.maplibregl-ctrl-group[^{]*\{/.test(skin),
    'the MapLibre button-group skin went with the button that needed it');
assert(!/new maplibre\.TerrainControl/.test(viewer),
    'the 3D viewer does not build MapLibre’s TerrainControl (the “Disable terrain” button)');
assert.strictEqual((viewer.match(/map\.addControl\(/g) || []).length, 2,
    'the surface adds exactly two MapLibre controls: compact credits and scale, both bottom-left');
assert(/style\.terrain = \{ source: ts\.id/.test(viewer),
    'the deck is still draped over the DEM by the style, with no toggle to switch it off');
assert(/maplibre\.ScaleControl/.test(viewer) && /maplibre\.AttributionControl/.test(viewer),
    'the bottom-left credits and scale survive the removal');
assert(/body:not\(\.is-pwa\) \.map-frame\.is-fullscreen #detectlab-map \.leaflet-left \.leaflet-control-zoom\s*\{\s*margin-left: calc\(18px \+ env\(safe-area-inset-left, 0px\)\)/.test(styles),
    'mobile web fullscreen notch inset respects the left safe area');
for (const file of ['css/styles.css', 'css/map3d-terrain.css']) {
    /* Each asset carries the tag of whatever last changed it: styles.css by
     * the ASIG catalogue panel, and the terrain skin by the 2D/3D switch
     * moving into the bottom-left control column. */
    const tag = file === 'css/styles.css' ? '20261024-asig-catalogue' : '20261024-gesture-only-camera';
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
                  </div><div class="leaflet-control leaflet-bar" id="measure-control"><a id="measure-button">M</a></div></div>
                  <div class="leaflet-bottom leaflet-left"><div class="leaflet-control detectlab-compass"><div class="detectlab-compass-col">
                    <button class="detectlab-compass-btn" id="compass-button">N</button>
                    <button class="detectlab-compass-lock" id="lock-button">L</button>
                  </div></div></div>
                </div></div>
                <div id="map3d-surface"><div class="maplibregl-control-container">
                  <div class="maplibregl-ctrl-bottom-left"><div class="maplibregl-ctrl maplibregl-ctrl-attrib"
                    id="credits">Sources</div></div>
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
                        return { help: box('mapHelpBtn'), zoom: box('zoom-in'), map: box('detectlab-map'),
                            credits: box('credits'), measure: box('measure-button'), compass: box('compass-button'), lock: box('lock-button'),
                            topRight: !!document.querySelector('.maplibregl-ctrl-top-right') };
                    });
                    if (threeD) {
                        /* Nothing may sit over the app's own “?”: the corner no
                         * longer carries a second widget to clear. */
                        assert(!geometry.topRight, 'no MapLibre control container in the top-right corner');
                        if (width > 720) {
                            assert(await page.evaluate(() => {
                                const btn = document.getElementById('mapHelpBtn');
                                const r = btn.getBoundingClientRect();
                                const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                                return !!hit && (hit === btn || (hit.closest && hit.closest('#mapHelpBtn') !== null));
                            }), `the help button owns the top-right corner: width=${width}, fullscreen=${fullscreen}`);
                        }
                        assert(geometry.credits.left >= geometry.map.left,
                            'the source credits stay inside the surface in 3D');
                    } else {
                        assert.strictEqual(geometry.zoom.left - geometry.map.left, fullscreen && width <= 600 ? 18 : 10,
                            `zoom inset: width=${width}, fullscreen=${fullscreen}`);
                        if (width > 600) {
                            for (const control of ['measure', 'compass', 'lock']) {
                                assert.strictEqual(geometry.zoom.left, geometry[control].left,
                                    `desktop zoom aligns with ${control}: width=${width}, fullscreen=${fullscreen}`);
                            }
                        }
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
