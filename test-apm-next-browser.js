// Next-Gen APM — browser checks (real Leaflet + real js/apm-next panel, pipeline stubbed).
//   PUPPETEER_MODULE_DIR=/path/to/node_modules node test-apm-next-browser.js
// Without PUPPETEER_MODULE_DIR the checks are skipped (same convention as the other browser tests).
//
// What is real: Leaflet, the APM panel, the pick-on-map flow, the map legend, the layout CSS.
// What is stubbed: the premium check (window._dlIsPremium), the model run (runManual returns a fixed
// polygon), and the app's own map click handlers (a stand-in handler written with the same guard line).
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
            return Promise.resolve({
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
    await mapClick(page, 900, 300);
    const after = await page.evaluate(() => ({
        centre: window.DetectLabApmUi.state().centre, picking: window.DetectLabApmUi.state().picking,
        calls: window._t.calls.length, flag: !!window.dlApmPicking
    }));
    assert.ok(after.centre, 'APM took the point');
    assert.strictEqual(after.picking, false, 'pick ends after one click');
    assert.strictEqual(after.calls, 0, 'app handler did not fire on the pick click');
    assert.strictEqual(after.flag, false, 'flag cleared once the click has finished');
    await mapClick(page, 900, 300);
    assert.strictEqual(await page.evaluate(() => window._t.calls.length), 1, 'normal clicks work again after picking');
    await page.close();
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
