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
const credits = viewer.match(/if \(maplibre.AttributionControl\) \{[\s\S]*?\n {12}\}/)[0];
const attributionOption = viewer.match(/attributionControl: ([^\n]+),\n/)[1];
assert(!viewer.includes('map3d-status') && !skin.includes('map3d-status'), 'layer/provider rows are removed, not just hidden');
assert(/status: status/.test(viewer) && /report: report/.test(viewer), 'developer diagnostics are preserved');
assert(/#map3d-bar\s*\{[^}]*background: transparent;/.test(skin), 'shared panel has no background');
assert(/#map3d-bar \.m3d-row\s*\{[^}]*background: rgba\(6, 14, 30, 0\.48\)/.test(skin), 'each slider is its own translucent strip');
/* Gesture-only camera: the exaggeration / pitch / bearing sliders are gone from
 * the desktop bar, and every rotation/pitch gesture handler is switched on. */
for (const field of ['exag', 'pitch', 'bearing']) {
    assert(!ensureBar.includes(`map3d-${field}`), 'no camera/exaggeration slider left in the bar: ' + field);
}
assert(!/\.m3d-(exag|pitch|bearing)\b/.test(ensureBar), 'no slider rows or value labels in the bar markup');
assert(!/paintLabels/.test(viewer), 'no slider label painting left behind');
assert(!viewer.includes('sliderToExag') && !viewer.includes('exagToSlider'), 'no slider mapping helpers left behind');
assert(/dragRotate: true/.test(viewer) && /pitchWithRotate: true/.test(viewer) && /touchPitch: true/.test(viewer),
    'the map is created with the rotation/pitch gestures enabled');
assert(/map\.touchZoomRotate\.enableRotation\(\)/.test(viewer) &&
       /map\.touchPitch\.enable\(\)/.test(viewer) &&
       /map\.dragRotate\.enable\(\)/.test(viewer),
    'rotation, pitch and drag handlers are enabled explicitly after creation');
assert(/map\.keyboard\.enable\(\)/.test(viewer), 'keyboard rotation stays available');
assert(!viewer.includes('new maplibre.NavigationControl'), 'no duplicate MapLibre +/-, compass buttons in either layout');
for (const pwa of [false, true]) {
    const controls = [];
    const classes = new Set(pwa ? [] : ['maplibregl-compact', 'maplibregl-compact-show']);
    const listeners = {};
    let isOpen = !pwa;
    const inner = { textContent: pwa ? '' : 'Map data attribution' };
    const attributionNode = {
        classList: {
            contains(name) { return classes.has(name); },
            remove(name) { classes.delete(name); },
            add(name) { classes.add(name); }
        },
        querySelector(selector) {
            return selector === '.maplibregl-ctrl-attrib-inner' ? inner : null;
        },
        removeAttribute(name) { if (name === 'open') isOpen = false; }
    };
    const document = { body: { classList: { contains: name => name === 'is-pwa' && pwa } } };
    const context = { document, surface: { querySelector: () => attributionNode },
        maplibre: { AttributionControl: function (options) { this.options = options; } },
        map: {
            addControl(control, corner) { controls.push({ control, corner }); },
            on(event, fn) { listeners[event] = fn; },
            off(event, fn) { if (listeners[event] === fn) delete listeners[event]; }
        }
    };
    vm.runInNewContext(credits, context);
    assert.strictEqual(controls.length, 1, 'both layouts keep attribution available');
    assert.strictEqual(controls[0].corner, 'bottom-left');
    assert.strictEqual(controls[0].control.options.compact, true, 'credits use a compact info button');
    if (pwa) {
        assert.strictEqual(Object.keys(listeners).length, 3, 'the collapse waits while source metadata is not ready');
        inner.textContent = 'Map data attribution';
        classes.add('maplibregl-compact');
        classes.add('maplibregl-compact-show');
        isOpen = true;
        listeners.sourcedata();
    }
    assert.strictEqual(classes.has('maplibregl-compact-show'), false, 'the long source window starts collapsed');
    assert.strictEqual(isOpen, false, 'the initial expanded details panel is closed');
    assert.strictEqual(Object.keys(listeners).length, 0, 'initial-collapse listeners are removed after credits load');
    assert.strictEqual(vm.runInNewContext(attributionOption, context), false,
        'no duplicate default bottom-right attribution control in either layout');
}
assert(!/\.m3d-(exag-row|pitch-row|bearing-row)/.test(skin),
    'the skin no longer reserves or hides rows that do not exist');
assert(/body\.is-pwa\.is-3d #map3d-bar \.m3d-head \{ display: none; \}/.test(skin), 'PWA hides the extra collapse button');
assert(/body\.is-pwa\.is-3d #map3d-bar\.collapsed \.m3d-row,\nbody\.is-pwa\.is-3d #map3d-bar\.collapsed \.m3d-actions \{ display: flex; \}/.test(skin),
    'the PWA collapsed-bar override keeps the basemap picker and the actions visible');
assert(!/#map3d-surface \.maplibregl-ctrl-bottom-left \{ display: none; \}/.test(skin),
    'mobile source credits are not hidden with the scale');
assert(/body\.is-pwa\.is-3d #map3d-surface \.maplibregl-ctrl-bottom-left\s*\{[^}]*max-width: 42%;/.test(skin),
    'PWA keeps credits clear of the right-side actions');
for (const action of ['reset', 'north', 'flat']) {
    assert(ensureBar.includes('m3d-' + action), 'retained action: ' + action);
}
assert(!/\.m3d-lidar\b/.test(ensureBar) && !/\.m3d-lidar\b/.test(skin),
    'the duplicate .m3d-lidar box in #map3d-bar is removed from both desktop and PWA');
const SLIDER_TAGS = { 'js/map3d-terrain.js': '20261026-lidar-whole-or-disc', 'css/map3d-terrain.css': '20261026-lidar-whole-or-disc' };
for (const file of ['js/map3d-terrain.js', 'css/map3d-terrain.css']) {
    const url = file + '?v=' + SLIDER_TAGS[file];
    assert(html.includes(url) && sw.includes("'" + url + "'"), 'updated asset cache wiring: ' + file);
}
assert(Number(sw.match(/CACHE_NAME = 'detectlab-v(\d+)-/)[1]) >= 200);
console.log('✓ gesture-only camera bar, PWA controls, collapsed source credits, and cache wiring');

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
                </style><body class="is-3d ${pwa ? 'is-pwa' : ''}" ${pwa ? 'style="--map3d-safe-area-bottom: 34px"' : ''}><div class="map-frame"><div class="map-wrapper">
                <div id="map3d-surface"></div>
                <div id="map3d-toggle-group" class="m3d-toggle-group">
                  <button id="map3d-toggle">2D</button><button id="map3d-refresh">↻</button>
                </div>
                <div id="map3d-focus" class="is-minimized"><button id="map3d-focus-mini" class="m3d-focus-mini">LiDAR in 3D</button></div>
                </div><button class="map-help-btn" id="mapHelpBtn">?</button></div></body>`);
            await page.addScriptTag({ path: path.join(__dirname, 'js/maplibre-gl.js') });
            // Use the production bar and desktop attribution placement.
            // A tiny camera stub avoids remote tiles/WebGL while testing UI.
            await page.addScriptTag({ content: `
                var bar = null, state = { exaggeration: 1.4 };
                var surface = document.getElementById('map3d-surface');
                var CONFIG = { terrain: { minExaggeration: 0.5, maxExaggeration: 4 }, camera: { maxPitch: 80 } };
                var root = { getArcgisBasemap() { return 'imagery'; }, setArcgisBasemap(key) { return key; } };
                function wrapper() { return document.querySelector('.map-wrapper'); }
                function t(key) { return ({ title:'3D View', basemap:'Base map', basemapImagery:'Imagery ArcGIS', basemapTopographic:'Topographic ArcGIS', basemapTerrain:'Terrain ArcGIS', exaggeration:'Terrain exaggeration', pitch:'Pitch', bearing:'Bearing', reset:'Reset view' })[key] || key; }
                function cameraPitch() { return map.pitch; } function cameraBearing() { return map.bearing; }
                function setExaggeration(v) { state.exaggeration = v; }
                function resetView() { map.pitch = 62; map.bearing = 0; }
                function refreshToggle() {}
                var map = { pitch:62, bearing:0, zoom:6, transform:{ pitch:0, bearing:0, roll:0, pitchInRadians:0 },
                    setPitch(v) { this.pitch = v; }, setBearing(v) { this.bearing = v; }, easeTo(v) { this.pitch = v.pitch; this.bearing = v.bearing; },
                    getZoom() { return this.zoom; }, getMinZoom() { return 0; }, getMaxZoom() { return 20; },
                    zoomIn() { this.zoom++; }, zoomOut() { this.zoom--; }, on() {}, off() {}, _getUIString(k) { return k; },
                    addControl(control, corner) { var el = document.createElement('div'); el.className = 'maplibregl-ctrl-' + corner;
                        el.appendChild(control.onAdd(this)); surface.appendChild(el); } };
                var maplibre = { AttributionControl: class {
                    constructor(options) { this.options = options; }
                    onAdd() {
                        var el = document.createElement('details');
                        el.className = 'maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show';
                        el.setAttribute('open', '');
                        var button = document.createElement('summary');
                        button.className = 'maplibregl-ctrl-attrib-button';
                        button.addEventListener('click', function (event) {
                            event.preventDefault(); el.classList.add('maplibregl-compact-show');
                        });
                        var inner = document.createElement('div');
                        inner.className = 'maplibregl-ctrl-attrib-inner'; inner.textContent = 'Map data attribution';
                        el.appendChild(button); el.appendChild(inner); return el;
                    }
                } };
                ${ensureBar}
                ensureBar();
                ${credits}
            ` });
            const geometry = await page.evaluate(() => {
                const box = el => { const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
                const bar = document.getElementById('map3d-bar');
                const rows = [...bar.querySelectorAll('.m3d-row')];
                const group = document.getElementById('map3d-toggle-group');
                const toggle = document.getElementById('map3d-toggle');
                const refresh = document.getElementById('map3d-refresh');
                const toggleRect = toggle.getBoundingClientRect();
                const refreshRect = refresh.getBoundingClientRect();
                const toggleHit = document.elementFromPoint(toggleRect.left + toggleRect.width / 2,
                    toggleRect.top + toggleRect.height / 2);
                const refreshHit = document.elementFromPoint(refreshRect.left + refreshRect.width / 2,
                    refreshRect.top + refreshRect.height / 2);
                return { bar:box(bar), rows:rows.map(box), group:box(group), toggle:box(toggle), refresh:box(refresh),
                    mini:box(document.getElementById('map3d-focus-mini')),
                    toggleHit:toggleHit && toggleHit.id, refreshHit:refreshHit && refreshHit.id, help:box(document.getElementById('mapHelpBtn')),
                    zoom:document.querySelector('.maplibregl-ctrl-zoom-in') ? box(document.querySelector('.maplibregl-ctrl-zoom-in')) : null,
                    compass:!!document.querySelector('.maplibregl-ctrl-compass'),
                    info:(() => { const el = document.querySelector('.maplibregl-ctrl-attrib-button');
                        return !!el && getComputedStyle(el).display !== 'none'; })(),
                    credits:(() => { const el = document.querySelector('.maplibregl-ctrl-attrib-inner');
                        return !!el && getComputedStyle(el).display !== 'none'; })(),
                    creditControl:!!document.querySelector('.maplibregl-ctrl-bottom-left .maplibregl-ctrl-attrib'),
                    bg:getComputedStyle(bar).backgroundColor, filter:getComputedStyle(bar).backdropFilter,
                    alpha:rows.map(el => getComputedStyle(el).backgroundColor),
                    visibleRows:rows.filter(el => getComputedStyle(el).display !== 'none').length,
                    head:getComputedStyle(bar.querySelector('.m3d-head')).display,
                    actions:[...bar.querySelectorAll('.m3d-actions button')].filter(el => getComputedStyle(el).display !== 'none').length,
                    scroll:bar.scrollHeight > bar.clientHeight, overflow:getComputedStyle(bar).overflowY };
            });
            assert.strictEqual(geometry.bg, 'rgba(0, 0, 0, 0)');
            assert.strictEqual(geometry.filter, 'none');
            assert.strictEqual(geometry.rows.length, 1, 'the basemap picker is the only row left');
            assert(geometry.alpha.every(value => value.includes('0.48')), 'separate semi-transparent control strips');
            assert(geometry.rows.filter(row => row.width > 0).every(row => row.width > row.height * 2), 'visible control rows stay horizontal');
            assert.strictEqual(geometry.actions, 3, 'reset/north/flat actions remain available');
            assert.strictEqual(geometry.zoom, null, 'no duplicate +/- buttons');
            assert.strictEqual(geometry.compass, false, 'no duplicate compass');
            assert(geometry.refresh.width >= 44 && geometry.refresh.left >= geometry.toggle.right,
                'the raster refresh action has a touch-sized target beside the 2D/3D switch');
            assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#map3d-bar input[type="range"]').length), 0,
                'no range slider is rendered, on web or in the PWA');
            if (pwa) {
                assert.strictEqual(geometry.visibleRows, 1, 'only the basemap picker is visible');
                assert.strictEqual(geometry.head, 'none', 'no extra PWA collapse control');
                assert(Math.abs((geometry.bar.left + geometry.bar.right) / 2 - width / 2) < 1, 'PWA bar is centred');
                assert(geometry.bar.top >= 56, 'PWA bar clears the top map controls');
                assert(geometry.bar.bottom < height - 80, 'bar clears bottom toggle/actions');
                if (width <= 720) {
                    assert(geometry.group.bottom <= geometry.mini.top - 8,
                        'the grouped 2D switch and raster refresh clear the minimized LiDAR pill with a 10px safe-area gap');
                    assert.strictEqual(geometry.toggleHit, 'map3d-toggle',
                        'the switch itself receives a tap at its centre rather than the higher-z-index pill');
                    assert.strictEqual(geometry.refreshHit, 'map3d-refresh',
                        'the adjacent refresh button receives a tap at its centre');
                }
                if (geometry.scroll) {
                    assert.strictEqual(geometry.overflow, 'auto', 'short-screen controls can scroll');
                    await page.mouse.move(width / 2, geometry.bar.top + 10);
                    await page.mouse.wheel({ deltaY: 200 });
                    await page.waitForFunction(() => document.getElementById('map3d-bar').scrollTop > 0, { timeout: 2000 });
                }
            } else {
                assert.strictEqual(geometry.visibleRows, 1, 'web keeps the basemap picker only — the camera is gesture-driven');
            }
            assert.strictEqual(geometry.info, true, 'the compact source-credit button remains available');
            assert.strictEqual(geometry.creditControl, true, 'the compact attribution control stays bottom-left');
            assert.strictEqual(geometry.credits, false, 'the long attribution window is hidden on entry');
            await page.evaluate(() => document.querySelector('.maplibregl-ctrl-attrib-button').click());
            assert(await page.evaluate(() => getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib-inner')).display !== 'none'),
                'source credits remain accessible from the compact button');
            // Range callbacks and the retained actions must still drive the camera.
            const values = await page.evaluate(() => {
                // Pitch/bearing come from map gestures (the camera transform), not
                // from a slider: move the camera the way a gesture would.
                map.setPitch(34); map.setBearing(120);
                const values = { exag:state.exaggeration, pitch:map.pitch, bearing:map.bearing };
                document.querySelector('.m3d-north').click(); values.north = map.bearing;
                document.querySelector('.m3d-flat').click(); values.flat = map.pitch;
                document.querySelector('.m3d-reset').click();
                values.resetPitch = map.pitch; values.resetBearing = map.bearing;
                if (!document.body.classList.contains('is-pwa')) {
                    document.querySelector('.m3d-collapse').click();
                    values.collapsed = getComputedStyle(document.querySelector('.m3d-row')).display;
                    values.expanded = document.querySelector('.m3d-collapse').getAttribute('aria-expanded');
                    document.querySelector('.m3d-collapse').click();
                    values.restored = getComputedStyle(document.querySelector('.m3d-row')).display;
                }
                return values;
            });
            assert.strictEqual(values.exag, 1.4, 'terrain exaggeration is fixed — nothing in the bar changes it');
            assert.strictEqual(values.pitch, 34); assert.strictEqual(values.bearing, 120);
            assert.strictEqual(values.north, 0); assert.strictEqual(values.flat, 0);
            assert.strictEqual(values.resetPitch, 62); assert.strictEqual(values.resetBearing, 0);
            if (!pwa) {
                assert.strictEqual(values.collapsed, 'none'); assert.strictEqual(values.expanded, 'false');
                assert.strictEqual(values.restored, 'flex');
            }
            console.log(`✓ ${width}×${height} ${pwa ? 'PWA' : 'web'}: control geometry, gesture camera and actions work`);
        }
    } finally { await browser.close(); }
}
browserChecks().catch(error => { console.error(error); process.exitCode = 1; });
