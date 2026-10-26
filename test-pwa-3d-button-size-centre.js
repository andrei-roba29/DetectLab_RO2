/*
 * test-pwa-3d-button-size-centre.js
 * ──────────────────────────────────────────────────────────────────────────
 * Two PWA-only fixes for the 2D/3D switch (css/map3d-terrain.css):
 *
 *   1. The 3D button used to be a wide text pill (min-height 36px, 44px on
 *      phones) while every other button in its bottom-left control column
 *      (compass, Detect, the ArcGIS base-layer button) is a 38×38 icon
 *      square. In the installed PWA the switch and its tile-refresh action
 *      now skin to the same 38×38 squares. The website keeps its pill.
 *
 *   2. While 3D is on, the group holds TWO buttons (the 2D switch and the
 *      1 km tile refresh) and leaves the bottom-left column for the
 *      bottom-centre slot, directly under the centred 3D bar. In 2D the
 *      single switch stays in the measured column.
 *
 * Everything is CSS-driven: js/map3d-terrain.js still builds the same group
 * and the body.is-pwa / body.is-3d classes already existed.
 *
 * Run:  node test-pwa-3d-button-size-centre.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const skin = read('css/map3d-terrain.css');
const styles = read('css/styles.css');
const html = read('index.html');
const sw = read('sw.js');
const viewer = read('js/map3d-terrain.js');

/* Comments out, whitespace collapsed — rule bodies stay intact. */
const flat = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
const skinFlat = flat(skin);

function ruleBody(source, selectorPattern) {
    const match = source.match(selectorPattern + '\\s*\\{([^}]*)\\}');
    assert(match, 'missing CSS rule matching ' + selectorPattern);
    return match[1];
}

/* Count selector specificity as (ids, classes, elements). */
function specificity(selector) {
    const ids = (selector.match(/#[\w-]+/g) || []).length;
    const classes = (selector.match(/\.[\w-]+/g) || []).length
        + (selector.match(/\[[^\]]+\]/g) || []).length;
    const elements = (selector.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
    return [ids, classes, elements];
}

const TAG = '20261026-pwa-3d-button-size';
let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

console.log('[Test] PWA 3D buttons: 38×38 squares, centred group while 3D is on…');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The PWA switch/refresh are 38×38 squares matching the control column
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const square = ruleBody(skinFlat,
        /body\.is-pwa #map3d-toggle,\s*body\.is-pwa #map3d-refresh/.source);
    assert(/width:\s*38px/.test(square) && /height:\s*38px/.test(square),
        'the PWA buttons fix both dimensions at 38px');
    assert(/min-width:\s*38px/.test(square) && /min-height:\s*38px/.test(square),
        'and the minimums cannot let content grow them back into a pill');
    assert(/padding:\s*0/.test(square), 'the pill padding is removed');
    ok('both PWA buttons are fixed 38×38 squares with no pill padding');

    /* The size the rest of the column uses — the rule must match it exactly. */
    const compass = ruleBody(flat(styles), /\.detectlab-compass-btn,\s*\.compass-detect-btn/.source);
    assert(/width:\s*38px/.test(compass) && /height:\s*38px/.test(compass),
        'the compass/Detect buttons are the 38×38 reference size');
    const basemap = flat(html).match(/\.arcgis-basemap-ctrl\s*\{([^}]*)\}/)[1];
    assert(/width:\s*38px/.test(basemap), 'the base-layer control is also 38px wide');
    ok('38px is the shared size of the compass, Detect and base-layer buttons');

    /* The square rule must beat the phone media query's 44px touch bump. */
    const media = skin.slice(skin.indexOf('@media (max-width: 720px)'));
    const bump = media.match(/#map3d-toggle,\s*#map3d-refresh\s*\{([^}]*)\}/)[1];
    assert(/min-height:\s*44px/.test(bump), 'the 44px phone bump still exists for the website pill');
    const squareSelector = 'body.is-pwa #map3d-toggle';
    const mediaSelector = '#map3d-toggle';
    assert(specificity(squareSelector)[0] > specificity(mediaSelector)[0]
        || (specificity(squareSelector)[0] === specificity(mediaSelector)[0]
            && specificity(squareSelector)[1] > specificity(mediaSelector)[1]),
        'the PWA square rule out-specifies the media query ('
        + specificity(squareSelector).join(',') + ' vs ' + specificity(mediaSelector).join(',') + ')');
    ok('the PWA square rule wins over the 720px 44px media bump on every phone');

    /* PWA-only: the website pill keeps its roomier geometry. */
    const pill = ruleBody(skinFlat, /#map3d-toggle,\s*#map3d-refresh/.source);
    assert(/min-height:\s*36px/.test(pill) && /padding:\s*6px 11px/.test(pill),
        'the shared pill rule keeps 36px / 6px 11px for the website');
    assert(!/38px/.test(ruleBody(skinFlat, /body:not\(\.is-pwa\) \.m3d-toggle-group/.source)),
        'no PWA square sizing leaks into the website rule');
    ok('the website keeps its text pill; the squares are PWA-only');

    /* The in-button count cannot fit a 38px square — hidden, but the same
     * progress stays available to assistive technology. */
    assert(/body\.is-pwa #map3d-refresh \.m3d-refresh-count\s*\{\s*display:\s*none/.test(skinFlat),
        'the done/total count is hidden inside the PWA square');
    assert(/refreshStatus\.setAttribute\('role', 'status'\)/.test(viewer)
        && /refreshStatus\.setAttribute\('aria-live', 'polite'\)/.test(viewer),
        'the role=status live span still announces tile progress');
    assert(/refreshCount\.setAttribute|aria-hidden/.test(viewer)
        && /class="m3d-refresh-count" aria-hidden="true"/.test(viewer),
        'the hidden count is aria-hidden, so nothing accessible is lost');
    ok('the count is visually hidden in PWA but the accessible status channel stays');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. In PWA 3D the group centres; in 2D it keeps the measured column
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const centred = ruleBody(skinFlat, /body\.is-pwa\.is-3d \.m3d-toggle-group/.source);
    assert(/left:\s*50%/.test(centred) && /translateX\(-50%\)/.test(centred),
        'the PWA 3D group is horizontally centred');
    assert(/bottom:\s*calc\(64px \+ var\(--map3d-safe-area-bottom, env\(safe-area-inset-bottom, 0px\)\) \+ var\(--country-exit-lift, 0px\)\)/.test(centred),
        'at the 64px + home-indicator slot, lifted above the Exit-view pill');
    assert(!/--m3d-anchor/.test(centred), 'the centred group ignores the left-column anchor');
    ok('PWA 3D: the 2D + refresh group centres at 64px + inset, with the pill lift');

    /* The 2D column rule is untouched and still consumes the measured anchor. */
    const column = ruleBody(skinFlat, /body\.is-pwa \.m3d-toggle-group/.source);
    assert(/bottom:\s*var\(--m3d-anchor-bottom/.test(column)
        && /left:\s*var\(--m3d-anchor-left, 10px\)/.test(column),
        'the 2D PWA group stays on the measured base-layer anchor');
    assert(!/left:\s*50%/.test(column), 'the 2D PWA rule itself is not centred');
    ok('PWA 2D: the single switch stays in the bottom-left column');

    /* Selector ordering: .is-3d must be the higher-specificity rule so it can
     * override the column rule while 3D is open. */
    const centredSpec = specificity('body.is-pwa.is-3d .m3d-toggle-group');
    const columnSpec = specificity('body.is-pwa .m3d-toggle-group');
    assert(centredSpec[1] > columnSpec[1],
        'the is-3d selector adds a class and therefore wins the cascade');
    ok('the is-3d centring rule out-specifies the base PWA column rule');

    /* Website: always centred, never in the column, unchanged. */
    const web = ruleBody(skinFlat, /body:not\(\.is-pwa\) \.m3d-toggle-group/.source);
    assert(/bottom:\s*66px/.test(web) && /left:\s*50%/.test(web),
        'the website group keeps its 66px bottom-centre slot');
    assert(/@media\s*\(max-width:\s*720px\)[\s\S]*?body:not\(\.is-pwa\)\s*\.m3d-toggle-group\s*\{[^}]*bottom:\s*58px/.test(skinFlat),
        'and its 58px phone slot');
    ok('the website placement is byte-for-byte untouched');

    /* The country “Exit view” pill hook still exists and is PWA-only, and
     * the centred rule is its only reader among the switch rules. */
    const dock = flat(read('css/country-dock.css'));
    assert(/body\.is-pwa\.country-exit-open\s*\{\s*--country-exit-lift:\s*46px/.test(dock),
        'the country dock still publishes the 46px PWA lift');
    const switchRules = skinFlat.match(/[^{}]*\.m3d-toggle-group\s*\{[^}]*\}/g) || [];
    switchRules.forEach((rule) => {
        if (!/is-3d\s+\.m3d-toggle-group/.test(rule)) {
            assert(!/--country-exit-lift/.test(rule), 'only the centred 3D rule reads the pill lift');
        }
    });
    ok('the Exit-view pill lift is published PWA-only and read by the centred 3D group alone');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. No JS behaviour changes — the same group, gated by the same classes
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(/toggleGroup\.id = 'map3d-toggle-group'/.test(viewer)
        && /toggleBtn\.id = 'map3d-toggle'/.test(viewer)
        && /refreshBtn\.id = 'map3d-refresh'/.test(viewer),
        'the viewer still builds the same three elements');
    assert(/'<span class="m3d-dot" aria-hidden="true"><\/span><span class="m3d-label"><\/span>'/.test(viewer),
        'the switch keeps its dot + label markup');
    assert(/body\.is-3d #map3d-refresh\s*\{\s*display:\s*inline-flex/.test(skinFlat),
        'refresh still joins the group only while 3D is on');
    assert(/document\.body\.classList\.add\('is-3d'\)/.test(viewer)
        && /document\.body\.classList\.remove\('is-3d'\)/.test(viewer),
        'the is-3d body class still drives both the surface and the new placement');
    ok('the change is CSS-only: markup, refresh gating and body classes are unchanged');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. Asset wiring: re-tagged skin, cache bump, old URL kept for old shells
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const cssUrl = 'css/map3d-terrain.css?v=' + TAG;
    assert(html.includes(cssUrl), 'index.html loads ' + cssUrl);
    assert(sw.includes("'" + cssUrl + "'"), 'sw.js precaches ' + cssUrl);
    /* Installed shells running the previous index still ask for the old tag. */
    assert(sw.includes("'css/map3d-terrain.css?v=20261026-lidar-whole-or-disc'"),
        'the previous skin URL stays precached for already-installed PWAs');
    /* The viewer JS did not change, so its tag and the old one both stay. */
    assert(html.includes('js/map3d-terrain.js?v=20261026-desktop-basemap'),
        'the viewer JS keeps its own tag — this was a skin-only change');

    const version = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(version >= 285, 'the app-shell cache moved to v285 (found v' + version + ')');
    assert(/Re-tags css\/map3d-terrain\.css\./.test(sw),
        'sw.js logs the skin re-tag in the v285 note');
    ok('re-tagged ?v=' + TAG + ', shell v' + version + ', old skin URL retained');
}

console.log('\n✅ test-pwa-3d-button-size-centre.js: ' + passed + ' groups of checks passed.');
