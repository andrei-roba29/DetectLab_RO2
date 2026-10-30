// Regression test — the PWA layers window fills the screen with a uniform
// tint, while safe-area padding keeps controls above the bottom system bar.
//
// What was broken
// ---------------
// · .transp-panel carried a hardcoded `height: 560px; max-height: 560px`. On the
//   website that is exactly the height of the map frame, so nothing looked wrong
//   — but the installed PWA paints the map edge to edge (100dvh), and 560px on a
//   ~900px phone is "the window stops after the lower half of the screen".
// · Removing all bottom padding made the final layer rows/buttons run into the
//   native PWA safe-area bar. A later gradient fix faded the panel into the
//   map near the bottom, making its tint and opacity uneven.
// · Stretching the panel to the bottom can put floating controls over the last
//   rows. Keep the live-location button at its bottom-right anchor, but hide it
//   in place while the layers window is open; never teleport it over compass /
//   Detect / nearby.
//
// The fix pins the panel with position:fixed to the true viewport edges, restores
// a 44px-or-device-safe-area padding at the bottom, and paints a single tint
// over the entire panel. Floating controls are hidden while it is open.
//
// Run: node test-pwa-layer-panel.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const css = read('css/styles.css');
const html = read('index.html');
const mapApp = read('js/map-app.js');

function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
    assert(m, 'missing CSS rule for ' + selector);
    return m[1];
}

/* 1. The panel is anchored, not sized. */
const panel = ruleOf(css, '.transp-panel');
assert(/top:\s*0/.test(panel) && /bottom:\s*0/.test(panel),
    'the layers window must be anchored to BOTH edges of the map frame');
assert(/height:\s*auto/.test(panel) && /max-height:\s*none/.test(panel),
    'no hardcoded 560px length any more — the frame decides the height');
assert(!/height:\s*560px/.test(panel), 'the old 560px cap must be gone');
assert(/padding:\s*22px 16px 0/.test(panel),
    'the desktop panel keeps its compact zero-bottom-padding layout');

/* 2. The PWA override reaches the viewport bottom with a uniform tint, while
   content clears the native bar. */
const flatHtml = html.replace(/\n\s*/g, ' ');
const pwa = ruleOf(flatHtml, 'body.is-pwa .transp-panel');
assert(/position:\s*fixed\s*!important/.test(pwa),
    'the PWA panel is fixed to the viewport so a 560px map-frame cannot crop it');
// The shell is sized from the SAME measured pixel height as the rest of the
// PWA (--pwa-viewport-h) — never from bottom:0 or a viewport unit, both of
// which resolve against an initial containing block that can be short.
assert(/height:\s*var\(--pwa-viewport-h, 100%\)\s*!important/.test(pwa),
    'the panel shell reaches the true viewport bottom through the measured px height');
assert(!/bottom:\s*0\s*!important/.test(pwa),
    'bottom:0 must not size the panel — it can land above the screen bottom');
assert(/max-height:\s*none\s*!important/.test(pwa),
    'the PWA rule keeps the anchor-driven height instead of a computed one');
assert(/--pwa-panel-bottom-clearance:\s*max\(var\(--pwa-bottom-controls-clearance,\s*44px\),\s*env\(safe-area-inset-bottom,\s*0px\)\)/.test(pwa),
    'the bottom clearance is at least 44px and grows to the device safe-area when needed');
assert(/padding-bottom:\s*var\(--pwa-panel-bottom-clearance\)\s*!important/.test(pwa),
    'the final layer rows and buttons receive the restored bottom clearance');
assert(/background:\s*rgb\(20,\s*14,\s*34\)\s*!important/.test(pwa),
    'one opaque violet color paints the entire panel including the bottom clearance');
assert(!/gradient\s*\(|background-(?:size|clip|image|color)\s*:|mask(?:-image)?\s*:/.test(pwa),
    'no gradient, clipping, or mask can fade or truncate the panel background');
assert(/backdrop-filter:\s*none\s*!important/.test(pwa),
    'the full-height PWA panel avoids backdrop blur for mobile performance');
assert(!/100% - var\(--pwa-bottom-controls-clearance/.test(pwa),
    'the panel height itself must not be shortened by the bottom-controls clearance');

/* 3. Fullscreen still owns its own geometry. */
const full = ruleOf(css, '.map-frame.is-fullscreen .transp-panel');
assert(/bottom:\s*0/.test(full), 'browser fullscreen still pins the window to the bottom');

/* 4. The floating PWA stack stays put (hidden in place) while the window is open. */
assert(/function markTranspPanelOpen\(on\)/.test(mapApp),
    'one helper owns the open state so every path stays in sync');
assert(/classList\.toggle\('transp-panel-open', transpPanelOpen\)/.test(mapApp),
    'the open state is published on <body>');
const openClose = /if \(!panel\.contains\(e\.target\) && !tab\.contains\(e\.target\)\)\s*\{\s*markTranspPanelOpen\(false\);/.test(mapApp);
assert(openClose, 'the click-outside close must go through the same helper');
const hideRule = (flatHtml.match(/body\.is-pwa\.transp-panel-open #pwa-br-stack,[^{]*\{([^}]*)\}/) || [])[1] || '';
assert(/body\.is-pwa\.transp-panel-open #pwa-br-stack,\s*body\.is-pwa\.transp-panel-open \.pwa-live-location-control\s*\{/.test(flatHtml),
    'the separate live-location button must be included in the in-place hide rule');
assert(/visibility:\s*hidden/.test(hideRule),
    'with the panel open the account stack and location button are hidden, not moved');
assert(/pointer-events:\s*none/.test(hideRule),
    'hidden controls must not intercept taps on the open layer panel');
assert(!/left:\s*max\(10px/.test(hideRule) && !/right:\s*auto/.test(hideRule),
    'no right-side control may teleport left over compass / Detect / nearby');

/* 5. Installed PWAs must actually receive it. */
const sw = read('sw.js');
const cacheName = (sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1];
assert(Number(cacheName) >= 312, 'the SW cache must be bumped to v312+ (got v' + cacheName + ')');
assert(/\/\/ v307: keep the PWA layers panel uniformly tinted/.test(sw),
    'the SW changelog must describe the uniform panel tint');
assert(/['\"]index\.html['\"]/.test(sw), 'the current shell must remain in the service-worker precache');
['css/styles.css', 'js/map-app.js'].forEach(function (file) {
    const tag = (html.match(new RegExp('(?:src|href)="(' + file + '\\?v=[^"]+)"')) || [])[1];
    assert(tag, file + ' must be cache-busted on the page');
    assert(read('sw.js').includes("'" + tag + "'"), file + ' must be pre-cached under that exact URL');
});

console.log('✓ the layers window is anchored top→bottom (no 560px cap)');
console.log('✓ the PWA panel is uniformly tinted through its safe-area clearance');
console.log('✓ the panel hides floating controls in place and the updated shell is pre-cached');
console.log('OK — the PWA layers panel reaches the screen edge without fading.');
