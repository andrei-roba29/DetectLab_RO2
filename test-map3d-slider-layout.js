// node test-map3d-slider-layout.js
// Optional real DOM/control checks:
// PUPPETEER_MODULE_DIR=/path/to/node_modules node test-map3d-slider-layout.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const viewer = read('js/map3d-terrain.js');
const skin = read('css/map3d-terrain.css');
const html = read('index.html');
const sw = read('sw.js');
const ensureBar = viewer.match(/function ensureBar\(\) \{[\s\S]*?\n {4}\}/)[0];
const nav = viewer.match(/if \(maplibre.NavigationControl\) \{[\s\S]*?\n {12}\}/)[0];
assert(!viewer.includes('map3d-status') && !skin.includes('map3d-status'), 'layer/provider rows are removed, not just hidden');
assert(/status: status/.test(viewer) && /report: report/.test(viewer), 'developer diagnostics are preserved');
assert(/#map3d-bar\s*\{[^}]*background: transparent;/.test(skin), 'shared panel has no background');
assert(/#map3d-bar \.m3d-row\s*\{[^}]*background: rgba\(6, 14, 30, 0\.48\)/.test(skin), 'each slider is its own translucent strip');
for (const field of ['exag', 'pitch', 'bearing']) {
    assert(ensureBar.includes(`label for="map3d-${field}"`) && ensureBar.includes(`id="map3d-${field}"`), 'slider has an associated label: ' + field);
}
for (const pwa of [false, true]) {
    const controls = [];
    vm.runInNewContext(nav, {
        document: { body: { classList: { contains: name => name === 'is-pwa' && pwa } } },
        maplibre: { NavigationControl: function (options) { this.options = options; } },
        map: { addControl(control, corner) { controls.push({ control, corner }); } }
    });
    assert.strictEqual(controls[0].corner, pwa ? 'top-left' : 'bottom-right');
    assert.strictEqual(controls[0].control.options.showCompass, !pwa);
}
const SLIDER_TAGS = { 'js/map3d-terrain.js': '20261014-3d-vectors', 'css/map3d-terrain.css': '20261014-3d-slider-layout' };
for (const file of ['js/map3d-terrain.js', 'css/map3d-terrain.css']) {
    const url = file + '?v=' + SLIDER_TAGS[file];
    assert(html.includes(url) && sw.includes("'" + url + "'"), 'updated asset cache wiring: ' + file);
}
assert(Number(sw.match(/CACHE_NAME = 'detectlab-v(\d+)-/)[1]) >= 200);
console.log('✓ transparent slider strips, removed status UI, labels, web/PWA navigation and cache wiring');

async function browserChecks() {
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
        for (const [width, height, pwa] of [[1280, 800, false], [390, 844, false], [390, 844, true],
            [375, 667, true], [768, 1024, true], [844, 390, true]]) {
            await page.setViewport({ width, height });
            const sheets = ['css/styles.css', 'css/maplibre-gl.css', 'css/map3d-terrain.css', 'css/tutorial.css']
                .map(file => `<style>${read(file)}</style>`).join('');
            await page.setContent(`${sheets}<style>
                body { margin:0; } .map-frame, .map-wrapper { position:relative; width:100%; height:100dvh; border:0; margin:0; }
                </style><body class="is-3d ${pwa ? 'is-pwa' : ''}"><div class="map-frame"><div class="map-wrapper">
                <div id="map3d-surface"></div><button id="map3d-toggle">2D</button>
                </div><button class="map-help-btn" id="mapHelpBtn">?</button></div></body>`);
            await page.addScriptTag({ path: path.join(__dirname, 'js/maplibre-gl.js') });
            // Use the production bar and real MapLibre navigation buttons.
            // A tiny camera stub avoids remote tiles/WebGL while testing UI.
            await page.addScriptTag({ content: `
                var bar = null, state = { exaggeration: 1.4 };
                var CONFIG = { terrain: { minExaggeration: 0.5, maxExaggeration: 4 }, camera: { maxPitch: 80 } };
                function wrapper() { return document.querySelector('.map-wrapper'); }
                function t(key) { return ({ title:'3D View', exaggeration:'Terrain exaggeration', pitch:'Pitch', bearing:'Bearing', reset:'Reset view' })[key] || key; }
                function cameraPitch() { return map.pitch; } function cameraBearing() { return map.bearing; }
                function setExaggeration(v) { state.exaggeration = v; }
                function resetView() { map.pitch = 62; map.bearing = 0; }
                function refreshToggle() {}
                var map = { pitch:62, bearing:0, zoom:6, transform:{ pitch:0, bearing:0, roll:0, pitchInRadians:0 },
                    setPitch(v) { this.pitch = v; }, setBearing(v) { this.bearing = v; }, easeTo(v) { this.pitch = v.pitch; this.bearing = v.bearing; },
                    getZoom() { return this.zoom; }, getMinZoom() { return 0; }, getMaxZoom() { return 20; },
                    zoomIn() { this.zoom++; }, zoomOut() { this.zoom--; }, on() {}, off() {}, _getUIString(k) { return k; },
                    addControl(control, corner) { var el = document.createElement('div'); el.className = 'maplibregl-ctrl-' + corner;
                        el.appendChild(control.onAdd(this)); document.getElementById('map3d-surface').appendChild(el); } };
                var maplibre = maplibregl;
                ${ensureBar}
                ensureBar();
                ${nav}
            ` });
            const geometry = await page.evaluate(() => {
                const box = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
                const bar = document.getElementById('map3d-bar');
                const rows = [...bar.querySelectorAll('.m3d-row')];
                return { bar:box(bar), rows:rows.map(box), help:box(document.getElementById('mapHelpBtn')),
                    zoom:box(document.querySelector('.maplibregl-ctrl-zoom-in')),
                    bg:getComputedStyle(bar).backgroundColor, filter:getComputedStyle(bar).backdropFilter,
                    alpha:rows.map(el => getComputedStyle(el).backgroundColor),
                    scroll:bar.scrollHeight > bar.clientHeight, overflow:getComputedStyle(bar).overflowY };
            });
            assert.strictEqual(geometry.bg, 'rgba(0, 0, 0, 0)');
            assert.strictEqual(geometry.filter, 'none');
            assert.strictEqual(geometry.rows.length, 3);
            assert(geometry.alpha.every(value => value.includes('0.48')), 'separate semi-transparent slider strips');
            assert(geometry.rows.every(row => row.width > row.height * 2), 'sliders are horizontal');
            if (pwa) {
                assert(Math.abs((geometry.bar.left + geometry.bar.right) / 2 - width / 2) < 1, 'PWA bar is centred');
                assert(geometry.bar.top >= height / 2 - 1, 'PWA bar stays in the bottom half');
                assert.strictEqual(geometry.zoom.top, geometry.help.top, 'zoom/help share the same top offset');
                assert.strictEqual(geometry.zoom.left, width - geometry.help.right, 'zoom/help have mirrored side offsets');
                assert.strictEqual(geometry.zoom.width, geometry.help.width, 'zoom/help have matching width');
                assert(geometry.bar.bottom < height - 80, 'bar clears bottom toggle/actions');
                if (geometry.scroll) {
                    assert.strictEqual(geometry.overflow, 'auto', 'short-screen controls can scroll');
                    await page.mouse.move(width / 2, geometry.bar.top + 10);
                    await page.mouse.wheel({ deltaY: 200 });
                    await page.waitForFunction(() => document.getElementById('map3d-bar').scrollTop > 0, { timeout: 2000 });
                }
                assert.strictEqual(await page.$('.maplibregl-ctrl-compass'), null, 'PWA has only zoom buttons in this corner');
            }
            // Range callbacks and the retained actions must still drive the camera.
            const values = await page.evaluate(() => {
                const update = (selector, value) => { const el = document.querySelector(selector); el.value = value; el.dispatchEvent(new Event('input')); };
                update('.m3d-exag', 70); update('.m3d-pitch', 34); update('.m3d-bearing', 120);
                const values = { exag:state.exaggeration, pitch:map.pitch, bearing:map.bearing };
                document.querySelector('.maplibregl-ctrl-zoom-in').click(); values.zoomIn = map.zoom;
                document.querySelector('.maplibregl-ctrl-zoom-out').click(); values.zoomOut = map.zoom;
                document.querySelector('.m3d-north').click(); values.north = map.bearing;
                document.querySelector('.m3d-flat').click(); values.flat = map.pitch;
                document.querySelector('.m3d-collapse').click();
                values.collapsed = getComputedStyle(document.querySelector('.m3d-row')).display;
                values.expanded = document.querySelector('.m3d-collapse').getAttribute('aria-expanded');
                document.querySelector('.m3d-collapse').click();
                values.restored = getComputedStyle(document.querySelector('.m3d-row')).display;
                return values;
            });
            assert(Math.abs(values.exag - 2.95) < 0.001);
            assert.strictEqual(values.pitch, 34); assert.strictEqual(values.bearing, 120);
            assert.strictEqual(values.zoomIn, 7); assert.strictEqual(values.zoomOut, 6);
            assert.strictEqual(values.north, 0); assert.strictEqual(values.flat, 0);
            assert.strictEqual(values.collapsed, 'none'); assert.strictEqual(values.expanded, 'false');
            assert.strictEqual(values.restored, 'flex');
            console.log(`✓ ${width}×${height} ${pwa ? 'PWA' : 'web'}: control geometry and slider/actions work`);
        }
    } finally { await browser.close(); }
}
browserChecks().catch(error => { console.error(error); process.exitCode = 1; });
