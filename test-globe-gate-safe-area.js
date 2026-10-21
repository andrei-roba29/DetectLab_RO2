/*
 * test-globe-gate-safe-area.js
 * ──────────────────────────────────────────────────────────────────────────
 * The “Choose your country” gate painted its header under the phone's status
 * bar.
 *
 * WHY
 *   .globe-gate is inset:0 of .map-wrapper, and in the installed PWA that
 *   wrapper is the whole screen (body.is-pwa #map-section is position:fixed at
 *   top:0 with a min-height:100vh floor, index.html) — y = 0 is behind the
 *   translucent status bar / notch, where env(safe-area-inset-top) is ~47–59px
 *   on modern iPhones. The gate's chrome declared `padding: 18px 20px 14px`
 *   and the ≤640px variant `14px 14px 10px`, and its own ✕ sat at a fixed
 *   `top: 12px`, so the title's first rows and half the button lived under the
 *   clock. Measured in Chromium with the real stylesheets and safe-area insets
 *   emulated at 59px: title top = 14px, ✕ top = 12px — both inside the bar.
 *
 * THE FIX (css/globe-country-picker.css)
 *   - .globe-gate-chrome:        padding-top calc(18px + env(safe-area-inset-top))
 *   - same rule in ≤640px:       padding-top calc(14px + env(safe-area-inset-top))
 *   - #globeGateCloseBtn:        top/left calc(12px + env(safe-area-inset-…))
 *   - .globe-gate-reopen:        top calc(14px + env(safe-area-inset-top))
 *   - .globe-gate-zoom / -hint:  bottom calc(18px|22px + env(safe-area-inset-bottom))
 *
 *   Every inset falls back to 0px, so a desktop browser — and any device
 *   without system chrome over the page — renders exactly as before.
 *
 * Run:  node test-globe-gate-safe-area.js
 * Optional real-DOM geometry checks (Chromium + emulated safe-area insets):
 *       PUPPETEER_MODULE_DIR=/path/to/node_modules node test-globe-gate-safe-area.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

const gateCss = read('css/globe-country-picker.css');
const html = read('index.html');
const sw = read('sw.js');
const preview = read('tools/globe-gate-preview.html');
const flat = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');

const CSS_TAG = '20261021-gate-safe-area';
const CSS_URL = 'css/globe-country-picker.css?v=' + CSS_TAG;

console.log('[Test] “Choose your country” clears the phone’s status bar…');

function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const match = new RegExp('(?:^|[}])\\s*' + escaped + '\\s*\\{([^}]*)\\}').exec(stripped);
    assert(match, 'missing CSS rule for ' + selector);
    return match[1];
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The header (title / description / legend) starts below the bar
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const chrome = ruleOf(gateCss, '.globe-gate-chrome');
    assert(/padding:\s*calc\(18px \+ env\(safe-area-inset-top, 0px\)\) 20px 14px/.test(chrome),
        'the gate header adds env(safe-area-inset-top) to its 18px padding');

    /* The ≤640px block re-declares the padding — the phone is exactly the
       device the inset exists for, so it must carry it too. */
    const phoneBlock = (gateCss.match(/@media \(max-width: 640px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    assert(/\.globe-gate-chrome\s*\{\s*padding:\s*calc\(14px \+ env\(safe-area-inset-top, 0px\)\) 14px 10px;\s*\}/.test(phoneBlock),
        'the phone layout keeps the inset on top of its shorter 14px padding');

    /* No rule may re-drop the header to a bare fixed value. */
    const paddings = (gateCss.match(/\.globe-gate-chrome\s*\{[^}]*?padding:[^;]*;/g) || []);
    assert(paddings.length >= 2, 'both the desktop and the phone header paddings are declared');
    paddings.forEach(function (decl) {
        assert(/env\(safe-area-inset-top/.test(decl),
            'every .globe-gate-chrome padding keeps the safe-area term: ' + decl.trim());
    });
    console.log('  ✓ desktop 18px and phone 14px header paddings both add the top inset');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The buttons on the top edge follow it
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const close = ruleOf(gateCss, '#globeGateCloseBtn');
    assert(/top:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\)\s*!important/.test(close),
        'the gate’s ✕ clears the status bar');
    assert(/left:\s*calc\(12px \+ env\(safe-area-inset-left, 0px\)\)/.test(close),
        'and the notch on the left edge in landscape');

    const reopen = ruleOf(gateCss, '.globe-gate-reopen');
    assert(/top:\s*calc\(14px \+ env\(safe-area-inset-top, 0px\)\)/.test(reopen),
        'the shared top-right pill (the same class) carries the inset too');
    assert(!/\.map-frame\.is-fullscreen \.globe-gate-reopen\s*\{/.test(gateCss),
        'the old fullscreen-only override is gone — one declaration covers both (the frame is the screen)');
    console.log('  ✓ ✕ and the top-right pill sit below the status bar');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The bottom edge uses the app's existing home-indicator convention
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(/\.globe-gate-zoom\s*\{[^}]*bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\);/.test(flat(gateCss)),
        'the zoom stack clears the home indicator (same rule as body.is-pwa .leaflet-bottom)');
    assert(/\.globe-gate-hint\s*\{[^}]*bottom:\s*calc\(22px \+ env\(safe-area-inset-bottom, 0px\)\);/.test(flat(gateCss)),
        'so does the hovered-country hint pill');
    console.log('  ✓ zoom stack and hint respect the bottom inset');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Nothing moves on a device without system chrome
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* env() with a 0px fallback is 0 outside a system-inset context, so the
       offsets are the original 18 / 14 / 12 / 22 — asserted at the rule level
       above and measured in the optional browser pass below. No rule may have
       swapped the inset for a hard-coded PWA-only lift. */
    assert(!/body\.is-pwa[^{]*\.globe-gate-chrome\s*\{/.test(gateCss),
        'the header inset is not gated on body.is-pwa: env() already reports 0 where there is no system chrome');
    console.log('  ✓ the fix rides env(), not a body-class switch');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. The shipped copies are re-tagged
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(html.indexOf(CSS_URL) !== -1, 'index.html loads ' + CSS_URL);
    assert(sw.indexOf("'" + CSS_URL + "'") !== -1, 'sw.js precaches ' + CSS_URL);
    assert(sw.indexOf("'css/globe-country-picker.css?v=20261013-no-change-pill'") !== -1,
        'the older tag stays precached for PWAs still running an older index.html');
    assert(preview.indexOf(CSS_URL) !== -1, 'the preview harness loads the same stylesheet');
    const version = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(version >= 249, 'the app-shell cache moved past v248 (found v' + version + ')');
    console.log('  ✓ assets re-tagged and the shell cache bumped');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Optional: measure the real cascade in Chromium
 * ══════════════════════════════════════════════════════════════════════════ */
async function browserChecks() {
    if (!process.env.PUPPETEER_MODULE_DIR) {
        console.log('\nBrowser checks skipped (set PUPPETEER_MODULE_DIR to enable).');
        return;
    }
    const req = require('module').createRequire(path.join(process.env.PUPPETEER_MODULE_DIR, '..', 'package.json'));
    const puppeteer = req('puppeteer-core');
    const chromium = (await import(require('url').pathToFileURL(req.resolve('@sparticuz/chromium')))).default;
    const browser = await puppeteer.launch({
        executablePath: await chromium.executablePath(),
        args: chromium.args,
        headless: true
    });
    const sheets = ['css/styles.css', 'css/globe-country-picker.css']
        .map((file) => '<style>' + read(file) + '</style>').join('');
    const markup = (pwa) => sheets
        + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        + '<style>html,body{margin:0;padding:0}'
        + '.map-frame,.map-wrapper{position:relative;width:100%;height:100dvh;margin:0;border:0;overflow:hidden}'
        + '.map-wrapper{background:#030916}</style>'
        + '<body class="' + (pwa ? 'is-pwa' : '') + '"><div class="map-frame"><div class="map-wrapper">'
        + '<div class="globe-gate" id="globeGate"><div class="globe-gate-canvas" id="globeGateCanvas"></div>'
        + '<div class="globe-gate-chrome"><div class="globe-gate-title" id="globeGateTitle">Choose your country</div>'
        + '<p class="globe-gate-desc">Rotate the globe and click a country to select it and zoom in.</p>'
        + '<div class="globe-gate-legend"><span class="globe-gate-swatch globe-gate-swatch--default"></span>'
        + '<span>Available country</span><span class="globe-gate-swatch globe-gate-swatch--hover"></span>'
        + '<span>Hovered</span></div></div>'
        + '<button type="button" id="globeGateCloseBtn" class="globe-gate-reopen" '
        + 'style="display:flex;top:auto;right:auto;left:14px" aria-label="Close">✕</button>'
        + '<div class="globe-gate-zoom"><button id="globeGateZoomIn">+</button>'
        + '<button id="globeGateZoomOut">−</button></div>'
        + '<div class="globe-gate-hint show" id="globeGateHint">Romania</div>'
        + '</div></div></div></body>';

    const measure = () => page.evaluate(() => {
        const box = (sel) => {
            const r = document.querySelector(sel).getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left };
        };
        const probeTop = document.createElement('div');
        probeTop.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);width:1px';
        document.body.appendChild(probeTop);
        const probeBottom = document.createElement('div');
        probeBottom.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:1px';
        document.body.appendChild(probeBottom);
        const out = {
            insetTop: probeTop.getBoundingClientRect().height,
            insetBottom: probeBottom.getBoundingClientRect().height,
            title: box('#globeGateTitle'),
            desc: box('.globe-gate-desc'),
            close: box('#globeGateCloseBtn'),
            zoom: box('.globe-gate-zoom'),
            hint: box('#globeGateHint'),
            vh: window.innerHeight
        };
        probeTop.remove();
        probeBottom.remove();
        return out;
    });

    const page = await browser.newPage();
    const client = await page.createCDPSession();
    let canEmulate = true;
    try {
        await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
    } catch (e) {
        canEmulate = false;
    }
    try {
        /* The installed PWA, 390×844, iPhone-class insets. */
        await page.setViewport({ width: 390, height: 844 });
        await page.setContent(markup(true));
        let m = await measure();
        if (!canEmulate || m.insetTop === 0) {
            console.log('  … safe-area emulation unavailable in this Chromium; geometry checks skipped');
        } else {
            assert(m.insetTop === 59 && m.insetBottom === 34, 'the emulated insets reach the page');
            assert(m.title.top >= 59, 'the title starts below the status bar (top ' + m.title.top + ')');
            assert(m.desc.top >= 59, 'the description is fully clear of it');
            assert(m.close.top >= 59, 'the gate’s ✕ starts below the status bar (top ' + m.close.top + ')');
            assert(m.zoom.bottom <= 844 - 34, 'the zoom stack clears the home indicator (bottom ' + m.zoom.bottom + ')');
            assert(m.hint.bottom <= 844 - 34, 'the hint pill clears it too');
            console.log('  ✓ 390×844 PWA, insets 59/34: title ' + Math.round(m.title.top)
                + ', ✕ ' + Math.round(m.close.top) + ', zoom bottom ' + Math.round(m.zoom.bottom));

            /* Desktop: insets 0 → the historical offsets, untouched. */
            await client.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
            await page.setViewport({ width: 1280, height: 800 });
            await page.setContent(markup(false));
            m = await measure();
            assert(m.insetTop === 0, 'no insets on the desktop profile');
            assert(Math.abs(m.title.top - 18) < 0.5, 'desktop header keeps its 18px padding (got ' + m.title.top + ')');
            assert(Math.abs(m.close.top - 12) < 0.5, 'desktop ✕ keeps its 12px anchor (got ' + m.close.top + ')');
            assert(Math.abs(m.zoom.bottom - (800 - 18)) < 0.5, 'desktop zoom keeps its 18px anchor');
            console.log('  ✓ 1280×800 website: 18 / 12 / 18px anchors unchanged');

            /* Phone in a browser tab (no system chrome reported): also unchanged. */
            await page.setViewport({ width: 390, height: 844 });
            await page.setContent(markup(false));
            m = await measure();
            assert(Math.abs(m.title.top - 14) < 0.5, 'phone-web header keeps its 14px padding (got ' + m.title.top + ')');
            console.log('  ✓ 390×844 website: 14px phone padding unchanged');
        }
    } finally {
        await browser.close();
    }
}

browserChecks().then(function () {
    console.log('\nAll globe-gate safe-area tests passed ✔');
}).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
});
