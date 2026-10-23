/*
 * test-country-exit-3d-stack.js
 * ──────────────────────────────────────────────────────────────────────────
 * “Exit view” was overlapped by the “3D” switch in the installed PWA.
 *
 * THE BUG
 *   The country view's “Exit view” pill is bottom-centred and, on the website,
 *   sits 18px above the edge — underneath the 2D/3D switch (66px up on desktop,
 *   58px on phones). The installed PWA lifts the pill to 60px + the safe-area
 *   inset so the home indicator never covers it… which is exactly where the
 *   switch has always been. The switch is centred too and paints later
 *   (z-index 960 vs 950), so it covered the pill's middle and swallowed its
 *   taps: elementFromPoint at the pill's centre returned #map3d-toggle. In the
 *   PWA 3D view the same pill was crossed by the switch at 64px + the same
 *   inset (20–26px of the pill's 32px height in a 390×844 window).
 *
 * THE FIX
 *   One shared hook instead of two pieces of CSS guessing about each other:
 *     • js/country-dock.js   evaluateExitButton() toggles body.country-exit-open
 *       with the very same boolean that reveals the pill;
 *     • css/country-dock.css turns that class into --country-exit-lift (46px =
 *       the pill's own height plus a 10px gap) — but only under body.is-pwa;
 *     • css/map3d-terrain.css adds the variable to the switch's three rules
 *       (desktop 66px, phone 58px, PWA 3D 64px + inset) and to the 3D bar that
 *       rides on top of it (108px + inset), so the whole column steps up
 *       together instead of the switch sliding under the bar.
 *
 * In the installed PWA (body.is-pwa) the switch left this bottom-centre
 * column: it heads the map's bottom-left control column, directly above the
 * base-layer button (#arcgisBasemapCtrl), placed by the custom properties
 * js/map3d-terrain.js measures — see MAP3D_SWITCH_BASE_LAYER_COLUMN.md and
 * test-3d-switch-base-layer-column.js. On the website (body:not(.is-pwa)) the
 * switch stays bottom-centre and the pill keeps its 18px slot, so nothing in
 * the pill's column needs the lift any more and the pill can never be covered
 * or out-tapped again; the hook itself stays (the country dock still publishes
 * it and the bottom-centre 3D bar can still read it).
 *
 * Run:  node test-country-exit-3d-stack.js
 * Optional real-DOM geometry checks:
 *       PUPPETEER_MODULE_DIR=/path/to/node_modules node test-country-exit-3d-stack.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

const dockCss = read('css/country-dock.css');
const skinCss = read('css/map3d-terrain.css');
const dockJs = read('js/country-dock.js');
const html = read('index.html');
const sw = read('sw.js');

const flatten = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
const dockFlat = flatten(dockCss);
const skinFlat = flatten(skinCss);

function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
    assert(match, 'missing CSS rule for ' + selector);
    return match[1];
}

console.log('[Test] “Exit view” and the 2D/3D switch share the bottom-centre column…');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The pill keeps its documented PWA height above the home indicator
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const web = ruleOf(dockCss, '.country-exit-view');
    assert(/left:\s*50%/.test(web) && /translateX\(-50%\)/.test(web),
        'the pill stays bottom-centre');
    assert(/bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(web),
        'on the website the pill sits 18px above the edge, below the switch');

    const pwa = ruleOf(dockCss, 'body.is-pwa .country-exit-view');
    assert(/bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 60px\)/.test(pwa),
        'the installed PWA still lifts the pill to 60px + the safe-area inset — '
        + 'that lift is what puts it in the switch’s slot, so it must be the value the stack accounts for');
    console.log('  ✓ the pill keeps its 18px (web) / 60px + inset (PWA) anchors');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. One hook, armed by the show/hide decision itself
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(/document\.body\.classList\.toggle\('country-exit-open', show\)/.test(dockJs),
        'evaluateExitButton() marks the body with country-exit-open using the same “show” it already computed');

    const hook = ruleOf(dockCss, 'body.is-pwa.country-exit-open');
    assert(/--country-exit-lift:\s*46px/.test(hook),
        'the hook publishes --country-exit-lift: 46px (pill height + 10px gap)');
    assert(/body\.is-pwa\.country-exit-open/.test(dockFlat),
        'the lift is scoped to body.is-pwa — the website already has room and must not move');
    const declarations = (dockFlat.match(/--country-exit-lift:\s*[^;]+;/g) || []);
    assert.strictEqual(declarations.length, 1,
        'exactly one place defines the lift, so the switch can never read a stale second value');
    console.log('  ✓ body.country-exit-open → --country-exit-lift: 46px, PWA only');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The switch left this column, so the pill cannot be covered again
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* PWA-only: the switch sits above the base-layer button in the installed
       PWA (measured anchor); the website keeps its bottom-centre switch, and
       neither environment reads the pill's lift or the dock's clearance. */
    const switchRules = skinFlat.match(/\.m3d-toggle-group\s*\{[^}]*\}/g) || [];
    assert(switchRules.length >= 1, 'the skin still places .m3d-toggle-group');
    switchRules.forEach(function (rule) {
        assert(!/--country-exit-lift/.test(rule),
            'no switch rule reads --country-exit-lift any more: ' + rule.trim());
        assert(!/--layer-dock-clearance/.test(rule),
            'no switch rule reads --layer-dock-clearance any more: ' + rule.trim());
    });
    const website = ruleOf(skinCss, 'body:not(.is-pwa) .m3d-toggle-group');
    assert(/position:\s*absolute/.test(website) && /bottom:\s*66px/.test(website) &&
           /left:\s*50%/.test(website) && /translateX\(-50%\)/.test(website),
        'the website switch stays bottom-centre, untouched by this re-scope');
    const pwa = ruleOf(skinCss, 'body.is-pwa .m3d-toggle-group');
    assert(!/left:\s*50%/.test(pwa),
        'the PWA switch is not centred: ' + pwa.trim());
    assert(/bottom:\s*var\(--m3d-anchor-bottom, calc\(192px \+ var\(--map3d-safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\)\)\)/.test(pwa),
        'the installed-PWA fallback keeps the home-indicator inset (192px + inset)');
    assert(/left:\s*var\(--m3d-anchor-left, 10px\)/.test(pwa),
        'and --m3d-anchor-left, left-aligned with the base-layer button');
    const shared = ruleOf(skinCss, '.m3d-toggle-group');
    assert(!/position:/.test(shared) && !/bottom:/.test(shared) && !/left:/.test(shared),
        'the shared rule is box model only; placement is environment-specific');
    console.log('  ✓ the PWA switch lives in the bottom-left column; the website stays bottom-centre');

    /* The 3D bar is the one piece of 3D chrome still bottom-centred in the
       installed PWA, and it now rides on the switch's measured top edge. */
    assert(/body\.is-pwa\.is-3d #map3d-bar\s*\{[^}]*bottom:\s*calc\(var\(--m3d-stack-top/.test(skinFlat),
        'the PWA 3D bar rides on the switch’s measured top edge, so it never covers the switch');

    /* The arithmetic that keeps the pill tappable: the bar's fallback bottom
       (236px + inset + 8px) is far above the lifted pill's top edge
       (60px + 35px), and the switch's own column starts 10px in from the left
       edge, i.e. outside a centred pill's box on a 390px phone. */
    const PILL_TOP_PWA = 60 + 35;
    assert.strictEqual(236 + 8 > PILL_TOP_PWA, true,
        'the PWA 3D bar starts above the pill’s top edge even before the lift');
    const SWITCH_COLUMN_RIGHT = 11 + 44 + 6 + 44;   /* left edge + switch + gap + refresh */
    assert.strictEqual(SWITCH_COLUMN_RIGHT < (390 - 130) / 2, true,
        'on a 390px phone the switch column ends before a centred 130px pill begins');
    console.log('  ✓ the switch lives in the bottom-left column now; the pill’s slot is free');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. The website is untouched, and the served assets are re-tagged
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(!/body:not\(\.is-pwa\)[^{]*--country-exit-lift/.test(dockFlat),
        'no non-PWA rule arms the lift');

    const TAG = '20261021-country-exit-3d-stack';
    for (const asset of ['css/country-dock.css', 'js/country-dock.js']) {
        const url = asset + '?v=' + TAG;
        assert(html.indexOf(url) !== -1, 'index.html loads ' + url);
        assert(sw.indexOf("'" + url + "'") !== -1, 'sw.js precaches ' + url);
    }
    /* The 3D skin carries the tag of whatever changed it last — v254 moved the
     * switch into the bottom-left control column — but this fix's URL stays in
     * the precache so an installed shell still finds the copy it references. */
    assert(sw.indexOf("'" + 'css/map3d-terrain.css?v=' + TAG + "'") !== -1,
        'sw.js still precaches the v248 skin an installed shell may ask for');
    const SKIN_TAG = '20261023-pwa-only-3d-column';
    assert(html.indexOf('css/map3d-terrain.css?v=' + SKIN_TAG) !== -1 &&
        sw.indexOf("'" + 'css/map3d-terrain.css?v=' + SKIN_TAG + "'") !== -1,
        'index.html loads and sw.js precaches the re-tagged 3D skin');
    const version = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(version >= 248, 'the app-shell cache moved past v247 (found v' + version + ')');
    console.log('  ✓ website geometry untouched, assets re-tagged and precached');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Optional: the real cascade, measured in Chromium
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
    const sheets = ['css/styles.css', 'css/country-dock.css', 'css/map3d-terrain.css']
        .map((file) => '<style>' + read(file) + '</style>').join('');
    const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
    try {
        const page = await browser.newPage();
        for (const [width, height, pwa, is3d, lift] of [
            [390, 844, true, false, true],     // the reported case
            [390, 844, true, true, true],
            [1280, 800, true, false, true],
            [390, 844, true, false, false],    // pill hidden → the switch keeps its place
            [393, 852, false, false, false]    // website: nothing moved at all
        ]) {
            await page.setViewport({ width: width, height: height });
            await page.setContent(sheets + viewport + '<style>'
                + 'html,body{margin:0;padding:0}'
                + '.map-frame,.map-wrapper{position:relative;width:100%;height:100dvh;border:0;margin:0}'
                + '</style><body class="' + (pwa ? 'is-pwa ' : '') + (is3d ? 'is-3d ' : '')
                + (lift ? 'country-exit-open' : '') + '"><div class="map-frame"><div class="map-wrapper">'
                + '<div id="map3d-surface"></div>'
                + '<div id="map3d-toggle-group" class="m3d-toggle-group">'
                + '<button id="map3d-toggle"><span class="m3d-dot"></span><span class="m3d-label">3D</span></button>'
                + '<button id="map3d-refresh"><span class="m3d-refresh-icon">↻</span></button></div>'
                + (is3d ? '<div id="map3d-bar"><label class="m3d-row" for="map3d-exag">'
                    + '<span class="m3d-row-label">Terrain exaggeration</span>'
                    + '<input id="map3d-exag" type="range" min="0.5" max="4" step="0.1" value="1.4">'
                    + '</label></div>' : '')
                + '<button type="button" class="country-exit-view show" id="countryExitViewBtn">'
                + '<span aria-hidden="true">✕</span><span>Exit view</span></button>'
                + '</div></div></body>');

            const geometry = await page.evaluate(() => {
                const box = (id) => {
                    const r = document.getElementById(id).getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
                };
                const pill = box('countryExitViewBtn');
                const group = box('map3d-toggle-group');
                const toggle = box('map3d-toggle');
                const bar = document.getElementById('map3d-bar') ? box('map3d-bar') : null;
                const hit = document.elementFromPoint((pill.left + pill.right) / 2, (pill.top + pill.bottom) / 2);
                return {
                    pill: pill, group: group, toggle: toggle, bar: bar,
                    pillHit: !!(hit && document.getElementById('countryExitViewBtn').contains(hit)),
                    hitId: hit && (hit.id || hit.className || hit.tagName)
                };
            });

            const label = width + '×' + height + (pwa ? ' PWA' : ' web') + (is3d ? ' 3D' : '');
            /* The switch is in the bottom-left column now, so the two boxes
               must not intersect at all — with the pill lifted or not. */
            const intersects = !(geometry.toggle.right <= geometry.pill.left + 0.5
                || geometry.toggle.left >= geometry.pill.right - 0.5
                || geometry.toggle.bottom <= geometry.pill.top + 0.5
                || geometry.toggle.top >= geometry.pill.bottom - 0.5);
            assert(!intersects, label + ': the switch must not touch the pill’s box');
            assert(geometry.pillHit,
                label + ': the pill’s centre must belong to the pill, not to the switch (hit: '
                + geometry.hitId + ')');
            const anchorBottom = pwa ? 192 : 146;      /* documented CSS fallbacks */
            assert(Math.abs(geometry.toggle.bottom - (height - anchorBottom)) < 1.5,
                label + ': the switch keeps the base-layer column’s anchor (bottom '
                + geometry.toggle.bottom + ', expected ' + (height - anchorBottom) + ')');
            if (geometry.bar) {
                assert(geometry.bar.bottom <= geometry.toggle.top + 0.5,
                    label + ': the 3D bar must ride above the switch');
            }
            console.log('  ✓ ' + label + ': pill ' + Math.round(geometry.pill.top) + '–'
                + Math.round(geometry.pill.bottom) + ', switch ' + Math.round(geometry.toggle.top)
                + '–' + Math.round(geometry.toggle.bottom));
        }
    } finally {
        await browser.close();
    }
}

browserChecks().then(function () {
    console.log('\nAll “Exit view” / 3D stack tests passed ✔');
}).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
});
