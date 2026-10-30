// Next-Gen APM — browser checks (real Leaflet + real js/apm-next panel, pipeline stubbed).
//   PUPPETEER_MODULE_DIR=/path/to/node_modules node test-apm-next-browser.js
// Without PUPPETEER_MODULE_DIR the checks are skipped (same convention as the other browser tests).
//
// What is real: Leaflet, the APM panel, the pick-on-map flow, the map legend, the layout CSS.
// What is stubbed: the premium check (window._dlIsPremium), the model run (runManual returns a fixed
// heatmap/outline fixture), and the app's own map click handlers (a stand-in handler written with the same guard line).
// The app's real handlers in map-app.js etc. are not loaded here: the full page needs login, Supabase and
// CDN scripts that this sandbox cannot reach. Their guard lines are checked by test-apm-next.js.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APM_SCRIPTS = [
    'js/leaflet.js',
    'js/apm-next/apm-core.js',
    'js/apm-next/apm-raster.js',
    'js/apm-next/apm-heatmap.js',
    'js/apm-next/apm-sites.js',
    'js/apm-next/apm-providers.js',
    'js/apm-next/apm-i18n.js',
    'js/apm-next/apm-pipeline.js',
    'js/apm-next/apm-ui.js'
];

async function openHarness(browser, width, height) {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <style>${read('css/leaflet.css')}\n${read('css/styles.css')}\n${read('css/next-gen-apm.css')}
        html, body { margin: 0; height: 100%; overflow: hidden; }
        #detectlab-map { position: fixed; inset: 0; }</style></head>
        <body><div id="detectlab-map"></div></body></html>`);
    for (const file of APM_SCRIPTS) await page.addScriptTag({ path: path.join(__dirname, file) });
    await page.evaluate(() => {
        window._dlIsPremium = () => true;                       // stub: the app's entitlement check
        window._dlMap = L.map('detectlab-map', { center: [51.5, -0.5], zoom: 12 });
        // A tile-free map: the legend and panel are what is under test.
        // Stand-in for an app click handler. It carries the same guard line as the real handlers.
        window._t = { calls: [] };
        window._dlMap.on('click', function (e) {
            if (window.dlApmPicking) return;                    // APM picking owns this click
            window._t.calls.push(e.latlng.lat.toFixed(3));
        });
        window.DetectLabApmPipeline.runManual = function () {
            const grid = { w: 64, h: 64, west: -0.6, north: 51.56, dLon: .2 / 64, dLat: .12 / 64 };
            const scores = new Float32Array(64 * 64);
            for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
                const radius = Math.hypot((i - 31.5) / 31.5, (j - 31.5) / 31.5);
                scores[j * 64 + i] = radius <= 1 ? 1 - radius : NaN;
            }
            const thresholds = { medium: .55, high: .7, veryhigh: .85 };
            return Promise.resolve({
                heatmap: window.DetectLabApmHeatmap.buildRaster(scores, grid, thresholds), thresholds,
                geojson: { type: 'FeatureCollection', features: [{
                    type: 'Feature',
                    properties: { class: 'veryhigh', colour: '#89CFF0', areaM2: 1.2e6 },
                    geometry: { type: 'Polygon', coordinates: [[[-0.52, 51.49], [-0.48, 51.49], [-0.48, 51.52], [-0.52, 51.52], [-0.52, 51.49]]] }
                }] },
                areaKm2: { medium: 0, high: 0, veryhigh: 1.2 },
                provenance: { dem: { label: 'Test DEM', cellM: 25, version: null, tier: 'primary' }, water: { label: 'Test water' } },
                warnings: [],
                mode: 'manual'
            });
        };
        window.DetectLabApmUi.setEnabled(true);
    });
    return { page, errors };
}

async function clickButtonByText(page, selector, text) {
    const ok = await page.evaluate((sel, t) => {
        const b = [...document.querySelectorAll(sel)].find((el) => el.textContent.trim() === t);
        if (!b) return false;
        b.click();
        return true;
    }, selector, text);
    assert.ok(ok, 'button not found: ' + text);
}

async function mapClick(page, x, y) {
    await page.mouse.click(x, y);
    await sleep(60);
}

async function rectOf(page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
            display: cs.display, visibility: cs.visibility };
    }, selector);
}

function intersects(a, b) {
    return a && b && a.width > 0 && b.width > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ── 1. Map-pick conflict: the shared APM picking flag ───────────────────── */

test('APM off: a normal map click reaches the app handler and the flag stays clear', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => window.DetectLabApmUi.setEnabled(false));
    await mapClick(page, 900, 300);
    const r = await page.evaluate(() => ({ calls: window._t.calls.length, flag: !!window.dlApmPicking }));
    assert.strictEqual(r.calls, 1, 'handler should run once for a normal click');
    assert.strictEqual(r.flag, false);
    await page.close();
});

test('APM picking: the pick click goes to APM only; the app handler is blocked; then the flag clears', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => window.DetectLabApmUi.open());
    await clickButtonByText(page, '.apm-panel button', 'Pick point on map');
    assert.strictEqual(await page.evaluate(() => !!window.dlApmPicking), true, 'flag set while picking');
    assert.strictEqual(await page.evaluate(() => document.getElementById('apmNextPanel').hidden), true, 'window hides while picking');
    await mapClick(page, 900, 300);
    const after = await page.evaluate(() => ({
        centre: window.DetectLabApmUi.state().centre, picking: window.DetectLabApmUi.state().picking,
        calls: window._t.calls.length, flag: !!window.dlApmPicking
    }));
    assert.ok(after.centre, 'APM took the point');
    assert.strictEqual(await page.evaluate(() => document.getElementById('apmNextPanel').hidden), false, 'window reopens after picking');
    assert.strictEqual(after.picking, false, 'pick ends after one click');
    assert.strictEqual(after.calls, 0, 'app handler did not fire on the pick click');
    assert.strictEqual(after.flag, false, 'flag cleared once the click has finished');
    await mapClick(page, 900, 300);
    assert.strictEqual(await page.evaluate(() => window._t.calls.length), 1, 'normal clicks work again after picking');
    await page.close();
});

for (const mode of ['MANUAL', 'TRAIN']) test(mode + ': settings stay visually hidden through pan and reopen attempts until a point is chosen (desktop + phone)', async (ctx) => {
    for (const width of [1280, 390]) {
        const { page, errors } = await openHarness(ctx.browser, width, 844);
        // Exercise the CSS guard as well as the hidden property, without relying on UA defaults.
        await page.addStyleTag({ content: '.apm-panel { display: block !important; }' });
        await page.evaluate(() => {
            window.DetectLabApmProviders.createAriadneSiteProvider = () => ({ getSites: async () => [] });
            window.DetectLabApmUi.open();
        });
        if (mode === 'TRAIN') await clickButtonByText(page, '.apm-tab', 'TRAIN');
        await clickButtonByText(page, '.apm-panel button', 'Pick point on map');
        const visibility = () => page.evaluate(() => {
            const panel = document.getElementById('apmNextPanel');
            return { hidden: panel.hidden, display: getComputedStyle(panel).display, height: panel.getBoundingClientRect().height,
                ariaHidden: panel.getAttribute('aria-hidden'), expanded: document.getElementById('apmNextBtn').getAttribute('aria-expanded'),
                picking: window.DetectLabApmUi.state().picking, lock: document.body.classList.contains('apm-picking') };
        });
        const hidden = { hidden: true, display: 'none', height: 0, ariaHidden: 'true', expanded: 'false', picking: true, lock: true };
        assert.deepStrictEqual(await visibility(), hidden);
        await page.evaluate(() => window.DetectLabApmUi.open());
        await page.evaluate(() => document.getElementById('apmNextBtn').click());
        assert.deepStrictEqual(await visibility(), hidden, 'settings cannot reopen over the map during point selection');
        await page.mouse.move(width / 2, 350);
        await page.mouse.down();
        await page.mouse.move(width / 2 - 60, 420, { steps: 8 });
        await page.mouse.up();
        await sleep(300);
        assert.deepStrictEqual(await visibility(), hidden, 'panning is not a selection and must not restore settings');
        // Pick inside the space formerly occupied by the settings panel.
        await mapClick(page, 80, 620);
        const selected = await visibility();
        assert.strictEqual(selected.hidden, false);
        assert.notStrictEqual(selected.display, 'none');
        assert.ok(selected.height > 0, 'settings return after selecting the area centre');
        assert.strictEqual(selected.ariaHidden, 'false');
        assert.strictEqual(selected.expanded, 'true');
        assert.strictEqual(selected.picking, false);
        assert.strictEqual(selected.lock, false);
        assert.ok(await page.evaluate(() => window.DetectLabApmUi.state().centre));
        assert.deepStrictEqual(errors, []);
        await page.close();
    }
});

test('a handler registered while picking is also blocked for that click (flag clears after the click, not during)', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => window.DetectLabApmUi.open());
    await clickButtonByText(page, '.apm-panel button', 'Pick point on map');
    // Registered after APM's pick listener: it runs after APM has taken the point.
    await page.evaluate(() => {
        window._late = [];
        window._dlMap.on('click', function () { if (window.dlApmPicking) return; window._late.push(1); });
    });
    await mapClick(page, 900, 300);
    assert.strictEqual(await page.evaluate(() => window._late.length), 0, 'late handler respected the flag');
    await page.close();
});

test('closing the APM panel while picking cancels the pick and clears the flag', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => window.DetectLabApmUi.open());
    await clickButtonByText(page, '.apm-panel button', 'Pick point on map');
    await page.evaluate(() => window.DetectLabApmUi.close());
    assert.strictEqual(await page.evaluate(() => !!window.dlApmPicking), false, 'flag clear after close');
    assert.strictEqual(await page.evaluate(() => window.DetectLabApmUi.state().picking), false);
    await mapClick(page, 900, 300);
    assert.strictEqual(await page.evaluate(() => window._t.calls.length), 1, 'map clicks work after the panel closes');
    await page.close();
});

/* ── 2. Legend and panel at phone width ──────────────────────────────────── */

async function runWithResult(page) {
    await page.evaluate(() => window.DetectLabApmUi.open());
    await clickButtonByText(page, '.apm-panel button', 'Pick point on map');
    await mapClick(page, 200, 120);                                  // top-left area, not under the panel
    await clickButtonByText(page, '.apm-panel button', 'Run MANUAL model');
    await page.waitForSelector('.apm-legend', { timeout: 5000 });
    await sleep(100);
}

test('phone 390 px, panel open with a result: the map legend does not overlap the panel', async (ctx) => {
    const { page, errors } = await openHarness(ctx.browser, 390, 844);
    await runWithResult(page);
    const panel = await rectOf(page, '.apm-panel');
    const legend = await rectOf(page, '.apm-legend');
    assert.ok(panel && panel.width > 0, 'panel visible');
    assert.ok(legend, 'legend exists after a result');
    assert.ok(!intersects(panel, legend) || legend.display === 'none',
        'legend overlaps the panel: legend ' + JSON.stringify(legend) + ' panel ' + JSON.stringify(panel));
    assert.deepStrictEqual(errors, [], 'no page errors');
    await page.close();
});

test('phone 390 px, panel closed: the legend is visible again', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 390, 844);
    await runWithResult(page);
    await page.evaluate(() => window.DetectLabApmUi.close());
    await sleep(50);
    const legend = await rectOf(page, '.apm-legend');
    assert.ok(legend && legend.display !== 'none' && legend.width > 0, 'legend visible with the panel closed');
    await page.close();
});

test('desktop 1280 px, panel open with a result: legend visible and not overlapping the panel', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await runWithResult(page);
    const panel = await rectOf(page, '.apm-panel');
    const legend = await rectOf(page, '.apm-legend');
    assert.ok(legend && legend.display !== 'none' && legend.width > 0, 'legend visible on desktop');
    assert.ok(!intersects(panel, legend), 'no overlap on desktop');
    await page.close();
});

test('hybrid output renders coloured heat tiles and unfilled very-high-only outlines; replaces and clears both', async (ctx) => {
    const { page, errors } = await openHarness(ctx.browser, 1280, 800);
    await runWithResult(page);
    const inspect = () => page.evaluate(() => {
        const tiles = [...document.querySelectorAll('.apm-heatmap-tile')];
        return { tiles: tiles.length,
            coloured: tiles.some(tile => tile.getContext('2d').getImageData(0, 0, tile.width, tile.height).data.some((v, i) => i % 4 === 3 && v > 0)),
            outlines: [...document.querySelectorAll('.apm-hotspot-outline')].map(el => el.getAttribute('fill')),
            heatLayers: Object.values(window._dlMap._layers).filter(l => l instanceof L.GridLayer).length,
            pointerEvents: getComputedStyle(window._dlMap.getPane('apmHeat')).pointerEvents,
            heatOrder: Number(window._dlMap.getPane('apmHeat').style.zIndex),
            outlineOrder: Number(window._dlMap.getPane('apmHotspots').style.zIndex) };
    });
    let result = await inspect();
    assert.ok(result.tiles > 0 && result.coloured, 'canvas tiles carry real model-score colour pixels');
    assert.deepStrictEqual(result.outlines, ['none'], 'hotspot is an outline, not another opaque fill');
    assert.strictEqual(result.heatLayers, 1);
    assert.strictEqual(result.pointerEvents, 'none', 'heatmap cannot intercept gestures');
    assert.ok(result.outlineOrder > result.heatOrder);
    await page.evaluate(() => window._dlMap.setView([51.50, -0.50], 13, { animate: false }));
    await sleep(250);
    assert.ok((await inspect()).coloured, 'heat remains aligned after zoom/pan');
    await clickButtonByText(page, '.apm-panel button', 'Run MANUAL model');
    await sleep(200);
    assert.strictEqual((await inspect()).heatLayers, 1, 're-running replaces the heat layer rather than accumulating layers');
    await clickButtonByText(page, '.apm-panel button', 'Clear result');
    assert.strictEqual(await page.$('.apm-heatmap-tile'), null);
    assert.strictEqual(await page.$('.apm-hotspot-outline'), null);
    assert.strictEqual(await page.$('.apm-map-legend'), null);
    assert.deepStrictEqual(errors, []);
    await page.close();
});

test('no very-high polygons still shows the heatmap and never falls back to lower-class polygons', async (ctx) => {
    const { page, errors } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => {
        const baseRun = window.DetectLabApmPipeline.runManual;
        window.DetectLabApmPipeline.runManual = () => baseRun().then(res => { res.geojson.features = []; return res; });
    });
    await runWithResult(page);
    assert.ok(await page.$('.apm-heatmap-tile'));
    assert.strictEqual(await page.$('.apm-hotspot-outline'), null);
    assert.match(await page.$eval('.apm-results', el => el.textContent), /no very-high area/);
    await page.evaluate(() => window.DetectLabApmUi.setEnabled(false));
    assert.strictEqual(await page.$('.apm-heatmap-tile'), null, 'disabling removes the heatmap too');
    assert.deepStrictEqual(errors, []);
    await page.close();
});

test('display/export excludes lower-class polygons and exports hybrid rendering metadata', async (ctx) => {
    const { page, errors } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => {
        const baseRun = window.DetectLabApmPipeline.runManual;
        window.DetectLabApmPipeline.runManual = () => baseRun().then(res => {
            res.geojson.features.push({ ...res.geojson.features[0], properties: { class: 'medium', colour: '#FFA500', areaM2: 10 } });
            return res;
        });
        const createURL = URL.createObjectURL;
        URL.createObjectURL = blob => { window._exportBlob = blob; return createURL(blob); };
    });
    await runWithResult(page);
    assert.strictEqual(await page.$$eval('.apm-hotspot-outline', nodes => nodes.length), 1);
    await clickButtonByText(page, '.apm-panel button', 'Export hotspot GeoJSON');
    const exported = await page.evaluate(async () => JSON.parse(await window._exportBlob.text()));
    assert.deepStrictEqual(exported.features.map(f => f.properties.class), ['veryhigh']);
    assert.strictEqual(exported.metadata.rendering.polygonClass, 'veryhigh');
    assert.ok(exported.metadata.rendering.heatmap.width > 0);
    assert.strictEqual(exported.metadata.rendering.thresholds.veryhigh, .85);
    assert.deepStrictEqual(errors, []);
    await page.close();
});

test('Terrarium-only note is shown as a plain note, not a warning, and the status stays "Done"', async (ctx) => {
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => {
        window.DetectLabApmPipeline.runManual = function () {
            const base = {
                geojson: { type: 'FeatureCollection', features: [] },
                areaKm2: { medium: 0, high: 0, veryhigh: 0 },
                provenance: { dem: { label: 'Terrarium', cellM: 30, version: null, tier: 'fallback' }, water: null },
                mode: 'manual'
            };
            base.warnings = [{ key: 'info.demTerrariumOnly', vars: { res: 30 }, text: 'x' }];
            return Promise.resolve(base);
        };
    });
    await runWithResult(page);
    const r = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.apm-warnings li')];
        const status = document.querySelector('.apm-status');
        return { count: items.length, info: items.filter((li) => li.classList.contains('apm-info-note')).length,
            text: items.map((li) => li.textContent), status: status ? status.textContent : '' };
    });
    assert.strictEqual(r.count, 1, 'one note shown');
    assert.strictEqual(r.info, 1, 'shown with the info style');
    assert.ok(/Terrarium/.test(r.text[0]), r.text[0]);
    assert.ok(!/See the warnings/.test(r.status), 'status does not say warnings: ' + r.status);
    await page.close();
});

test('a free account stays gated, with no developer banner or override', async (ctx) => {
    // localStorage is not reachable from this harness (about:blank origin), so this checks the gate
    // only through _dlIsPremium. The absence of the old localStorage switch is checked by test-apm-next.js.
    const { page } = await openHarness(ctx.browser, 1280, 800);
    await page.evaluate(() => {
        window._dlIsPremium = () => false;                      // a free account
        window.DetectLabApmUi.setEnabled(true);
        window.DetectLabApmUi.open();
    });
    const r = await page.evaluate(() => ({ runDisabled: document.querySelector('.apm-primary').disabled,
        gateHidden: document.querySelector('.apm-gate').hidden, banner: !!document.querySelector('.apm-dev-banner') }));
    assert.strictEqual(r.runDisabled, true, 'Run stays disabled for a free account');
    assert.strictEqual(r.gateHidden, false, 'the premium gate message is shown');
    assert.strictEqual(r.banner, false, 'no developer banner element');
    await page.close();
});

async function main() {
    if (!process.env.PUPPETEER_MODULE_DIR) {
        console.log('Browser checks skipped (set PUPPETEER_MODULE_DIR to enable).');
        return 0;
    }
    const req = require('module').createRequire(path.join(process.env.PUPPETEER_MODULE_DIR, '..', 'package.json'));
    const puppeteer = req('puppeteer-core');
    const chromium = (await import(require('url').pathToFileURL(req.resolve('@sparticuz/chromium')))).default;
    const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
    let passed = 0, failed = 0;
    try {
        for (const t of tests) {
            try {
                await t.fn({ browser });
                passed++; console.log('  ok  ' + t.name);
            } catch (e) {
                failed++; console.log('  FAIL ' + t.name + '\n       ' + e.message.split('\n').join('\n       '));
            }
        }
    } finally {
        await browser.close();
    }
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
