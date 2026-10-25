/*
 * test-3d-switch-base-layer-column.js
 * ──────────────────────────────────────────────────────────────────────────
 * “Move the 3D button right above the base layer button.”
 *
 * THE CHANGE
 *   The 2D/3D switch (#map3d-toggle, with the 1 km raster refresh beside it)
 *   used to float bottom-CENTRE, 66px up on desktop, 58px on phones, 64px +
 *   the safe-area inset in the installed PWA — the same slot the country
 *   “Exit view” pill, the analysis action dock, the offline ✕ and the APM/zoom
 *   hints all use, which is why it needed --layer-dock-clearance and
 *   --country-exit-lift to dodge them (PWA_EXIT_VIEW_3D_STACK.md).
 *
 *   It now heads the map's bottom-LEFT control column, directly above the
 *   base-layer button (#arcgisBasemapCtrl — the Leaflet control js/map-app.js
 *   folds Imagery / Topographic / Terrain into). The column reads, top to
 *   bottom: 2D/3D switch → base layer → compass (+ Detect in the installed
 *   PWA). The rotation lock was removed — the compass is Google-Earth-like.
 *
 * WHY THE OFFSET IS MEASURED, NOT A CONSTANT
 *   Leaflet stacks that corner in flow, and every environment moves it:
 *     • the installed PWA puts a third button (Detect) in the compass column
 *       and lifts the whole corner by the home-indicator inset;
 *     • mobile-web fullscreen makes the corner position:fixed above the
 *       browser's own bar (css/styles.css);
 *     • the control grows UPWARD when its list of base maps folds open.
 *   So js/map3d-terrain.js measures #arcgisBasemapCtrl against .map-wrapper
 *   and publishes three custom properties on the wrapper, which
 *   css/map3d-terrain.css reads (with the documented column as the fallback):
 *     --m3d-anchor-bottom   wrapper bottom → the control's top edge + 8px gap
 *     --m3d-anchor-left     wrapper left   → the control's left edge
 *     --m3d-stack-top       wrapper bottom → the switch's own top edge
 *   The 3D control bar rides on --m3d-stack-top in every layout, because the
 *   switch stays visible in 3D (it is the way back to 2D).
 *
 * Run:  node test-3d-switch-base-layer-column.js
 * Optional real-cascade geometry checks (needs a Chromium that can start):
 *       PUPPETEER_MODULE_DIR=/path/to/node_modules node test-3d-switch-base-layer-column.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const skin = read('css/map3d-terrain.css');
const viewer = read('js/map3d-terrain.js');
const html = read('index.html');
const sw = read('sw.js');
const styles = read('css/styles.css');

const flatten = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
const skinFlat = flatten(skin);

function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
    assert(match, 'missing CSS rule for ' + selector);
    return match[1];
}

/* The column, in the numbers both the CSS fallbacks and the measurement use.
 * Leaflet's own corner margins are 10px (css/leaflet.css); the compass column
 * is 38px buttons with an 8px gap (css/styles.css); the base-layer control is
 * a 34px icon row (index.html); the switch is 36px on desktop and 44px where
 * a finger taps it. */
const GAP = 8;
const COMPASS_WEB = 38;                      // compass (no rotation lock)
const COMPASS_PWA = 38 + 8 + 38;             // compass + Detect
const BASE_LAYER_H = 34;
const LEAFLET_MARGIN = 10;
const SWITCH_H_WEB = 36;
const SWITCH_H_TOUCH = 44;
const SAFE_AREA = 34;                        // an iPhone home indicator

const ANCHOR_WEB = COMPASS_WEB + LEAFLET_MARGIN + BASE_LAYER_H + LEAFLET_MARGIN + GAP;
const ANCHOR_PWA = COMPASS_PWA + LEAFLET_MARGIN + BASE_LAYER_H + LEAFLET_MARGIN + GAP;

console.log('[Test] the 2D/3D switch sits right above the base-layer button…');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The stylesheet places the switch by the measured anchor
 * ══════════════════════════════════════════════════════════════════════════ */
    {
        /* The shared rule is box model only now: position, bottom and left are
         * environment-specific (PWA column above the base layer vs the
         * website’s bottom-centre switch). */
        const group = ruleOf(skinFlat, '.m3d-toggle-group');
        assert(!/position:/.test(group) && !/bottom:/.test(group) && !/left:/.test(group),
            'the shared rule carries no positioning — placement is environment-specific');
        assert(/z-index:\s*960/.test(group) && /display:\s*flex/.test(group) && /gap:\s*6px/.test(group),
            'and keeps z-index 960, flex layout and the 6px gap');

        const pwa = ruleOf(skinFlat, 'body.is-pwa .m3d-toggle-group');
        assert(/position:\s*absolute/.test(pwa),
            'in the installed PWA the switch is absolutely placed');
        assert(/bottom:\s*var\(--m3d-anchor-bottom, calc\(146px \+ var\(--map3d-safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\)\)\)/.test(pwa),
            'reading --m3d-anchor-bottom with the 146px + inset fallback');
        assert(/left:\s*var\(--m3d-anchor-left, 10px\)/.test(pwa),
            'and --m3d-anchor-left, left-aligned with the base-layer button');

        const web = ruleOf(skinFlat, 'body:not(.is-pwa) .m3d-toggle-group');
        assert(/position:\s*absolute/.test(web),
            'on the website the switch stays absolutely placed');
        assert(/bottom:\s*66px/.test(web),
            'bottom-centre, 66px up, unchanged from before this re-scope');
        assert(/left:\s*50%/.test(web) && /translateX\(-50%\)/.test(web),
            'centred over the bottom slot');

        /* The documented column numbers still drive the measurement and the PWA fallback. */
        assert.strictEqual(ANCHOR_WEB, 100, 'website: 38 + 10 + 34 + 10 + 8 = 100px');
        assert.strictEqual(ANCHOR_PWA, 146, 'installed PWA: 84 + 10 + 34 + 10 + 8 = 146px');

        /* Neither environment reads the bottom-centre lift variables. */
        assert(!/--country-exit-lift|--layer-dock-clearance/.test(pwa) &&
               !/--country-exit-lift|--layer-dock-clearance/.test(web),
            'no environment resurrects the bottom-centre lift variables');

        /* The phone bump is website-only: the PWA column keeps measuring. */
        assert(!/body\.is-pwa\s*\.m3d-toggle-group\s*\{[^}]*bottom:\s*(58|64|66)px/.test(skinFlat),
            'no hard-coded phone bottom survives in the PWA rule');
        console.log('  ✓ .m3d-toggle-group: PWA column above the base layer; website bottom-centre untouched');
    }

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The 3D bar rides above the switch instead of over it
 * ══════════════════════════════════════════════════════════════════════════ */
    {
        const STACK_WEB = ANCHOR_WEB + SWITCH_H_TOUCH;    // 144px, the CSS fallback
        const STACK_PWA = ANCHOR_PWA + SWITCH_H_TOUCH + SAFE_AREA;   // 190px + inset

        /* The shared bar rule is box model only now: no left, bottom or
         * max-height — those are environment-specific. */
        const bar = ruleOf(skinFlat, '#map3d-bar');
        assert(!/left:/.test(bar) && !/bottom:/.test(bar) && !/max-height:/.test(bar),
            'the shared rule carries no anchors — placement is environment-specific');
        assert(/display:\s*none/.test(bar) && /flex-direction:\s*column/.test(bar) && /width:\s*208px/.test(bar),
            'and keeps display none, column layout and the 208px width');

        const pwaBar = ruleOf(skinFlat, 'body.is-pwa.is-3d #map3d-bar');
        assert(/bottom:\s*calc\(var\(--m3d-stack-top, calc\(190px \+ var\(--map3d-safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\)\)\) \+ 8px\)/.test(pwaBar),
            'in the installed PWA the bar rides --m3d-stack-top (190px + inset fallback)');
        assert(/max-height:\s*calc\(100% - var\(--m3d-stack-top, calc\(190px \+ var\(--map3d-safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\)\)\) - 72px\)/.test(pwaBar),
            'and caps its height the same way');
        assert(/left:\s*50%/.test(pwaBar) && /translateX\(-50%\)/.test(pwaBar),
            'the compact PWA bar stays centred over the column');

        const webBar = ruleOf(skinFlat, 'body:not(.is-pwa).is-3d #map3d-bar');
        assert(/bottom:\s*34px/.test(webBar),
            'on the website the bar keeps its fixed bottom: 34px anchor');
        assert(/left:\s*50%/.test(webBar) && /translateX\(-50%\)/.test(webBar) && /width:\s*208px/.test(webBar),
            'centred over the bottom-centre switch');

        /* Phones hang the PWA bar under the search bar; the website switch and
         * bar keep their website placement on phones too (58px / bottom: 34px). */
        assert(/body\.is-pwa\s*#map3d-bar\s*\{[^}]*top:\s*56px;[^}]*max-height:\s*calc\(100% - 64px - var\(--m3d-stack-top, 144px\)\)/.test(skinFlat),
            'the phone PWA bar tucks under the search bar and stops above the switch');
        assert(/@media\s*\(max-width:\s*720px\)[\s\S]*?body:not\(.is-pwa\)\s*\.m3d-toggle-group\s*\{[^}]*bottom:\s*58px/.test(skinFlat),
            'phones keep the website switch at 58px');

        /* The arithmetic the layout stands on. */
        assert.strictEqual(STACK_WEB, 144, 'website column top: 100 + 44 = 144px');
        assert.strictEqual(STACK_PWA - SAFE_AREA, 190, 'PWA column top: 146 + 44 = 190px + inset');
        assert.ok(144 + 8 + 60 < 560, 'a 560px map still has room for the bar above the column');
        console.log('  ✓ #map3d-bar: PWA rides the measured column; website bottom: 34px centred; phone PWA tucked under the search bar');
    }

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The viewer measures the base-layer button and follows it
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(/var BASE_LAYER_CTRL_ID = 'arcgisBasemapCtrl';/.test(viewer),
        'the viewer measures the same control js/map-app.js builds (#arcgisBasemapCtrl)');
    assert(/var ANCHOR_GAP = 8;/.test(viewer), 'and keeps an 8px gap above it');
    assert(/function syncToggleAnchor\(\)/.test(viewer) && /function watchToggleAnchor\(\)/.test(viewer) &&
           /function startAnchorWatch\(\)/.test(viewer),
        'the anchor is measured, watched and retried');
    assert(/host\.style\.setProperty\('--m3d-anchor-bottom'/.test(viewer) &&
           /host\.style\.setProperty\('--m3d-anchor-left'/.test(viewer) &&
           /host\.style\.setProperty\('--m3d-stack-top'/.test(viewer),
        'all three properties are published on .map-wrapper');
    assert(/host\.style\.removeProperty\('--m3d-anchor-bottom'\)/.test(viewer),
        'and removed again when there is no base-layer button to measure, so the CSS fallbacks apply');
    /* Followed, not measured once: the corner moves without a window resize. */
    assert(/root\.addEventListener\('resize', queueAnchorSync\)/.test(viewer) &&
           /root\.addEventListener\('orientationchange', queueAnchorSync\)/.test(viewer) &&
           /document\.addEventListener\('fullscreenchange', queueAnchorSync\)/.test(viewer),
        'resize, rotation and fullscreen re-measure the anchor');
    assert(/new root\.ResizeObserver\(queueAnchorSync\)/.test(viewer) &&
           /observer\.observe\(ctrl\)/.test(viewer) &&
           /observer\.observe\(ctrl\.parentNode\)/.test(viewer) &&
           /observer\.observe\(host\)/.test(viewer),
        'the control (its list folds open upward), its Leaflet corner and the wrapper are observed');
    assert(/new root\.MutationObserver\(queueAnchorSync\)/.test(viewer) &&
           /attributeFilter: \['class'\]/.test(viewer),
        'body class changes (is-pwa, fullscreen) re-measure it too');
    assert(/map\.on\('resize', queueAnchorSync\)/.test(viewer),
        'and so does a Leaflet resize with no window resize behind it');
    assert(/syncToggleAnchor\(\);\s*\n\s*startAnchorWatch\(\);/.test(viewer),
        'ensureToggle() measures as soon as the switch is in the DOM');
    assert(/refreshToggle\(\);\s*\n\s*\/\*[\s\S]{0,220}?queueAnchorSync\(\);/.test(viewer),
        'opening and closing 3D re-measures (the refresh action joins the group)');
    assert(/_syncToggleAnchor: syncToggleAnchor/.test(viewer) && /_toggleAnchor: function \(\)/.test(viewer),
        'the anchor is exposed for diagnostics and tests');
    /* js/map-app.js builds the control inside its own async boot, so the first
     * measurement can run before it exists. */
    assert(/anchorAttempts > 40/.test(viewer), 'the measurement retries while the control is still missing');
    console.log('  ✓ js/map3d-terrain.js measures #arcgisBasemapCtrl, publishes the anchor and follows it');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. The measurement itself, run against a stub column (no browser needed)
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const start = viewer.indexOf('    var BASE_LAYER_CTRL_ID');
    const end = viewer.indexOf('    function ensureToggle() {');
    assert(start > 0 && end > start, 'the anchor block can be lifted out of the viewer');
    const anchorSource = viewer.slice(start, end);

    function element(rect, name) {
        const props = {};
        return {
            name: name,
            rect: rect,
            style: {
                setProperty(key, value) { props[key] = value; },
                removeProperty(key) { delete props[key]; },
                getPropertyValue(key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : ''; }
            },
            props: props,
            getBoundingClientRect() { return this.rect; }
        };
    }

    /* A 560px-tall wrapper at (200,100) with a 1px border, exactly the way
     * .map-wrapper sits on the website. */
    function harness(options) {
        const opts = options || {};
        const wrapperBottom = 660;
        const compass = opts.pwa ? COMPASS_PWA : COMPASS_WEB;
        const inset = opts.pwa ? SAFE_AREA : 0;
        const controlHeight = opts.controlHeight || BASE_LAYER_H;
        const controlTop = wrapperBottom - (inset + compass + LEAFLET_MARGIN + controlHeight + LEAFLET_MARGIN);
        const wrapper = element({ top: 100, bottom: wrapperBottom, left: 200, right: 1000, height: 560 }, 'wrapper');
        const control = opts.noControl ? null
            : element({ top: controlTop, bottom: controlTop + controlHeight, left: 211, right: 245, height: controlHeight }, 'control');
        const group = element({ top: 0, bottom: 0, left: 0, right: 0, height: opts.groupHeight || SWITCH_H_WEB }, 'group');
        const corner = control ? { observe() {} } : null;
        if (control) control.parentNode = corner;
        const observed = [];
        const context = {
            wrapper: function () { return wrapper; },
            leafletMap: function () { return null; },
            toggleGroup: group,
            document: {
                getElementById: function (id) { return id === 'arcgisBasemapCtrl' ? control : null; },
                addEventListener: function () {},
                body: {}
            },
            root: {
                addEventListener: function () {},
                setInterval: function () { return 1; },
                clearInterval: function () {},
                requestAnimationFrame: function (fn) { fn(); return 1; },
                ResizeObserver: opts.observers === false ? undefined : function (fn) {
                    this.observe = function (el) { observed.push(el); };
                },
                MutationObserver: opts.observers === false ? undefined : function () { this.observe = function () {}; }
            },
            observed: observed,
            console: console
        };
        context.window = context;
        vm.createContext(context);
        vm.runInContext(anchorSource, context);
        return { context: context, wrapper: wrapper, control: control, group: group, observed: observed };
    }

    /* ── website: the switch lands 8px above the control, left-aligned ── */
    {
        const h = harness({});
        assert.strictEqual(h.context.syncToggleAnchor(), true, 'the website column is measured');
        assert.strictEqual(h.wrapper.props['--m3d-anchor-bottom'], ANCHOR_WEB + 'px',
            'anchor-bottom = wrapper bottom − control top + 8px gap');
        assert.strictEqual(h.wrapper.props['--m3d-anchor-left'], '11px',
            'anchor-left = the control’s left edge (1px wrapper border + Leaflet’s 10px)');
        assert.strictEqual(h.wrapper.props['--m3d-stack-top'], (ANCHOR_WEB + SWITCH_H_WEB) + 'px',
            'stack-top = the anchor plus the switch’s own height');
    }

    /* ── installed PWA: the third compass button and the inset both count ── */
    {
        const h = harness({ pwa: true, groupHeight: SWITCH_H_TOUCH });
        assert.strictEqual(h.context.syncToggleAnchor(), true);
        assert.strictEqual(h.wrapper.props['--m3d-anchor-bottom'], (ANCHOR_PWA + SAFE_AREA) + 'px',
            'the PWA column is 146px + the home-indicator inset');
        assert.strictEqual(h.wrapper.props['--m3d-stack-top'], (ANCHOR_PWA + SAFE_AREA + SWITCH_H_TOUCH) + 'px',
            'and the switch’s top edge follows its 44px touch height');
    }

    /* ── the list of base maps folds open: the control grows upward ── */
    {
        const h = harness({ controlHeight: BASE_LAYER_H + 120 });
        h.context.syncToggleAnchor();
        assert.strictEqual(h.wrapper.props['--m3d-anchor-bottom'], (ANCHOR_WEB + 120) + 'px',
            'an open base-layer list steps the switch up with the control’s top edge');
    }

    /* ── no control (a bare harness, or before js/map-app.js built it) ── */
    {
        const h = harness({ noControl: true });
        h.wrapper.props['--m3d-anchor-bottom'] = '999px';
        assert.strictEqual(h.context.syncToggleAnchor(), false, 'nothing to measure');
        assert.strictEqual(h.wrapper.style.getPropertyValue('--m3d-anchor-bottom'), '',
            'the stale anchor is dropped so the stylesheet’s fallback places the switch');
    }

    /* ── not laid out yet: keep the previous anchor rather than publish 0 ── */
    {
        const h = harness({});
        h.context.syncToggleAnchor();
        h.control.rect = { top: 0, bottom: 0, left: 0, right: 0, height: 0 };
        assert.strictEqual(h.context.syncToggleAnchor(), false, 'a zero-height control is not an anchor');
        assert.strictEqual(h.wrapper.props['--m3d-anchor-bottom'], ANCHOR_WEB + 'px',
            'the last good anchor survives a measurement that found no layout');
    }

    /* ── the watchers are installed once, on the real elements ── */
    {
        const h = harness({});
        h.context.startAnchorWatch();
        h.context.startAnchorWatch();
        assert.strictEqual(h.observed.length, 3, 'the control, its Leaflet corner and the wrapper are observed once');
        assert.strictEqual(h.observed[0], h.control, 'the base-layer control itself is observed');
        assert.strictEqual(h.observed[2], h.wrapper, 'and so is the wrapper the anchor is published on');
    }

    /* ── the exposed diagnostics read the same properties ── */
    {
        const h = harness({ pwa: true, groupHeight: SWITCH_H_TOUCH });
        h.context.syncToggleAnchor();
        const read = {
            bottom: parseFloat(h.wrapper.style.getPropertyValue('--m3d-anchor-bottom')),
            left: parseFloat(h.wrapper.style.getPropertyValue('--m3d-anchor-left')),
            stackTop: parseFloat(h.wrapper.style.getPropertyValue('--m3d-stack-top'))
        };
        assert.strictEqual(read.bottom, ANCHOR_PWA + SAFE_AREA);
        assert.strictEqual(read.stackTop - read.bottom, SWITCH_H_TOUCH,
            'stack-top − anchor-bottom is the switch’s height, which is what the 3D bar clears');
    }
    console.log('  ✓ the measurement: website 100px, PWA 146px + inset, list open, missing control, no layout');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. The bottom-centre column is free, and the corner it joins is documented
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* The pill and the dock keep their own anchors: this change moves the
     * switch out of their way, it does not move them. */
    const dock = read('css/country-dock.css');
    assert(/bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(ruleOf(flatten(dock), '.country-exit-view')),
        'the country “Exit view” pill keeps its bottom-centre anchor');
    assert(/--layer-dock-clearance:\s*62px/.test(styles),
        'the analysis action dock still publishes its clearance for the centred stack');
    assert(/body\.is-pwa \.leaflet-bottom \{[^}]*bottom: env\(safe-area-inset-bottom, 0px\) !important/.test(flatten(html)),
        'the PWA still lifts the Leaflet corner the switch is measured against');
    assert(/#detectlab-map \.leaflet-bottom\.leaflet-left \{\s*position: fixed;/.test(styles.replace(/\s+/g, ' ').replace(/ \{/g, ' {')) ||
           /body:not\(\.is-pwa\) \.map-frame\.is-fullscreen #detectlab-map \.leaflet-bottom\.leaflet-left/.test(styles),
        'mobile-web fullscreen still fixes that corner above the browser bar — which is why the anchor is measured');
    /* The base-layer control is the button the switch is measured against. */
    const app = read('js/map-app.js');
    assert(/container\.id = 'arcgisBasemapCtrl';/.test(app) && /L\.control\(\{ position: 'bottomleft' \}\)/.test(app),
        'js/map-app.js still builds #arcgisBasemapCtrl as a bottom-left Leaflet control');
    console.log('  ✓ the pill, the dock and the Leaflet corner are untouched; the switch joins the corner');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Assets are re-tagged and precached
 * ══════════════════════════════════════════════════════════════════════════ */
{
    /* Each asset carries the tag of whatever last changed it: the skin by the
     * 2D/3D switch moving into the bottom-left control column, the viewer by
     * the basemap-picker sync fix. */
    const TAG_CSS = '20261025-glass-controls';
    const TAG_VIEWER = '20261025-lidar-3d-tile-heal';
    for (const asset of ['css/map3d-terrain.css', 'js/map3d-terrain.js']) {
        const tag = asset === 'css/map3d-terrain.css' ? TAG_CSS : TAG_VIEWER;
        const url = asset + '?v=' + tag;
        assert(html.includes(url), 'index.html loads ' + url);
        assert(sw.includes("'" + url + "'"), 'sw.js precaches ' + url);
    }
    const version = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(version >= 255, 'the app-shell cache moved past v254 (found v' + version + ')');
    assert(/Re-tags css\/map3d-terrain\.css and js\/map3d-terrain\.js\./.test(sw),
        'sw.js logs the change the way the other shell bumps do');
    assert(/Re-tags js\/map-app\.js and js\/map3d-terrain\.js\./.test(sw),
        'sw.js logs the basemap-picker sync bump too');
    console.log('  ✓ re-tagged ?v=' + TAG_VIEWER + ' and CACHE_NAME v' + version);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. Optional: the real cascade, measured in Chromium
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
        executablePath: await chromium.executablePath(), args: chromium.args, headless: true
    });
    const sheets = ['css/leaflet.css', 'css/styles.css', 'css/map3d-terrain.css']
        .map((file) => '<style>' + read(file) + '</style>').join('');
    const anchorStart = viewer.indexOf('    var BASE_LAYER_CTRL_ID');
    const anchorSource = viewer.slice(anchorStart, viewer.indexOf('    function ensureToggle() {'))
        .replace(/root\.addEventListener/g, 'window.addEventListener')
        .replace(/root\.ResizeObserver/g, 'window.ResizeObserver')
        .replace(/root\.MutationObserver/g, 'window.MutationObserver')
        .replace(/root\.setInterval/g, 'window.setInterval')
        .replace(/root\.clearInterval/g, 'window.clearInterval')
        .replace(/root\.requestAnimationFrame/g, 'window.requestAnimationFrame');
    try {
        const page = await browser.newPage();
        for (const [width, height, pwa, threeD] of [
            [1280, 800, false, false],
            [1280, 800, false, true],
            [390, 844, false, false],
            [390, 844, true, false],
            [390, 844, true, true],
            [844, 390, true, true]
        ]) {
            await page.setViewport({ width: width, height: height });
            await page.setContent(sheets
                + '<style>html,body{margin:0;padding:0}'
                + '.map-frame,.map-wrapper{position:relative;width:100%;height:100dvh;border:0;margin:0}'
                + '#detectlab-map{position:relative;width:100%;height:100%}</style>'
                + '<body class="' + (pwa ? 'is-pwa ' : '') + (threeD ? 'is-3d' : '') + '">'
                + '<div class="map-frame"><div class="map-wrapper">'
                + '<div id="detectlab-map"><div class="leaflet-control-container">'
                + '<div class="leaflet-bottom leaflet-left">'
                + '<div class="leaflet-control arcgis-basemap-ctrl" id="arcgisBasemapCtrl">'
                + '<button class="arcgis-basemap-header" id="arcgisBasemapToggle">L</button>'
                + '<div class="arcgis-basemap-list"><button class="arcgis-basemap-btn">Imagery</button>'
                + '<button class="arcgis-basemap-btn">Topographic</button><button class="arcgis-basemap-btn">Terrain</button></div></div>'
                + '<div class="leaflet-control detectlab-compass"><div class="detectlab-compass-col">'
                + '<button class="detectlab-compass-btn">N</button>'
                + (pwa ? '<button class="compass-detect-btn">D</button>' : '')
                + '</div></div></div></div></div>'
                + '<div id="map3d-surface"></div>'
                + '<div id="map3d-toggle-group" class="m3d-toggle-group">'
                + '<button id="map3d-toggle"><span class="m3d-dot"></span><span class="m3d-label">3D</span></button>'
                + '<button id="map3d-refresh"><span class="m3d-refresh-icon">↻</span></button></div>'
                + (threeD ? '<div id="map3d-bar"><div class="m3d-row m3d-basemap-row"><label for="map3d-basemap">'
                    + '<span>Base map</span></label><select id="map3d-basemap" class="m3d-basemap-select">'
                    + '<option value="imagery">Imagery ArcGIS</option></select></div>'
                    + '<div class="m3d-actions"><button type="button" class="m3d-reset">Reset</button></div></div>' : '')
                + '</div></div></body>');

            const label = width + '×' + height + (pwa ? ' PWA' : ' web') + (threeD ? ' 3D' : ' 2D');

            /* Before the measurement: the stylesheet's own fallback column. */
            const fallback = await page.evaluate(() => {
                const box = (el) => { const r = el.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
                const wrapper = box(document.querySelector('.map-wrapper'));
                const group = box(document.getElementById('map3d-toggle-group'));
                return { offset: Math.round(wrapper.bottom - group.bottom), height: Math.round(group.height) };
            });
            const expectedFallback = pwa ? 146 : 66;
            assert(Math.abs(fallback.offset - expectedFallback) < 1.5,
                label + ': the CSS fallback puts the switch ' + expectedFallback + 'px up (found ' + fallback.offset + ')');

            /* Now run the real measurement against the real cascade. */
            await page.evaluate((source) => {
                const script = document.createElement('script');
                script.textContent = 'var toggleGroup = document.getElementById("map3d-toggle-group");\n'
                    + 'function wrapper() { return document.querySelector(".map-wrapper"); }\n'
                    + 'function leafletMap() { return null; }\n'
                    + source + '\nsyncToggleAnchor();';
                document.body.appendChild(script);
            }, anchorSource);

            const geometry = await page.evaluate(() => {
                const box = (el) => { const r = el.getBoundingClientRect();
                    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
                const control = document.getElementById('arcgisBasemapCtrl');
                const group = document.getElementById('map3d-toggle-group');
                const toggle = document.getElementById('map3d-toggle');
                const bar = document.getElementById('map3d-bar');
                const wrapper = box(document.querySelector('.map-wrapper'));
                const toggleRect = toggle.getBoundingClientRect();
                const hit = document.elementFromPoint(toggleRect.left + toggleRect.width / 2,
                    toggleRect.top + toggleRect.height / 2);
                return {
                    control: box(control), group: box(group), wrapper: wrapper,
                    bar: bar ? box(bar) : null,
                    toggleHit: !!(hit && (hit === toggle || (hit.closest && hit.closest('#map3d-toggle') !== null)))
                };
            });

            if (pwa) {
                assert(Math.abs((geometry.control.top - 8) - geometry.group.bottom) < 1.5,
                    label + ': the switch sits 8px above the base-layer button (gap '
                    + (geometry.control.top - geometry.group.bottom).toFixed(1) + 'px)');
                assert(Math.abs(geometry.group.left - geometry.control.left) < 1.5,
                    label + ': the switch is left-aligned with the base-layer button');
                assert(geometry.group.bottom < geometry.control.top && geometry.group.top > geometry.wrapper.top,
                    label + ': the switch is inside the map, above the control');
            } else {
                /* Website: the switch stays bottom-centre (66 px) — the
                 * measurement is published but the website never consumes it. */
                assert(Math.abs((geometry.wrapper.bottom - 66) - geometry.group.bottom) < 1.5,
                    label + ': the website switch stays bottom-centre, 66 px up (bottom ' + Math.round(geometry.group.bottom) + ')');
                assert(Math.abs(geometry.group.left + geometry.group.width / 2 - (geometry.wrapper.left + geometry.wrapper.width / 2)) < 1.5,
                    label + ': the website switch stays centred');
                assert(geometry.group.top > geometry.wrapper.top && geometry.group.bottom < geometry.wrapper.bottom,
                    label + ': the switch stays inside the map');
            }
            if (!threeD) {
                assert(geometry.toggleHit, label + ': the switch takes its own tap');
            }
            if (geometry.bar) {
                assert(geometry.bar.bottom <= geometry.group.top + 0.5,
                    label + ': the 3D bar rides above the switch (bar bottom ' + Math.round(geometry.bar.bottom)
                    + ', switch top ' + Math.round(geometry.group.top) + ')');
                assert(geometry.bar.top >= geometry.wrapper.top,
                    label + ': the 3D bar stays inside the map');
            }
            console.log('  ✓ ' + label + ': control ' + Math.round(geometry.control.top) + '–'
                + Math.round(geometry.control.bottom) + ', switch ' + Math.round(geometry.group.top) + '–'
                + Math.round(geometry.group.bottom) + (geometry.bar
                    ? ', bar ' + Math.round(geometry.bar.top) + '–' + Math.round(geometry.bar.bottom) : ''));
        }
    } finally {
        await browser.close();
    }
}

browserChecks().then(function () {
    console.log('\nAll 2D/3D switch column tests passed ✔');
}).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
});
