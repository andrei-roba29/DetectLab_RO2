// Regression test — the installed PWA must not show any strip or bar below
// the map, and the shell must be sized in PIXELS (one measurement), not from a
// CSS viewport unit.
//
// What was broken
// ---------------
// In the installed app an empty, dark navy band was visible at the very bottom
// of the screen: the map stopped above it and the page background showed
// through. The box that stopped short was sized from `bottom:0` / `100vh` /
// `100dvh` / `100svh` — all of which resolve against an initial containing
// block that standalone iOS can report shorter than the physical screen.
//
// The fix (v286): the PWA script measures the real screen height
// (window.innerHeight / visualViewport.height, and window.screen.height in the
// installed app) and publishes it as --pwa-viewport-h, applying it inline with
// !important to #map-section and to every box of the percentage chain. Anything
// the OS keeps outside the page's viewport is published as --pwa-bleed: the map
// overruns the bottom edge by that much, while the compass corner and the
// "© Leafleet" tag are lifted back by the same amount. The install banner (a
// fixed rgba(6,14,30,.97) bottom bar) is disabled outright in the installed app.
//
// Run: node test-pwa-no-bottom-strip.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const htmlRaw = read('index.html');
// CSS comments are stripped so a comment can never satisfy a rule assertion.
const html = htmlRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\n\s*/g, ' ');
const sw = read('sw.js');

// Every declaration block whose selector LIST contains `selector` as one item.
// A selector can legitimately appear in more than one rule (the shared
// touch-action group, then the geometry rule), so callers ask "does ANY of
// them declare this?" instead of binding to the first hit.
function rulesOf(source, selector) {
    const blocks = source.match(/[^{}]+\{[^{}]*\}/g) || [];
    const out = [];
    for (const block of blocks) {
        const open = block.indexOf('{');
        const list = block.slice(0, open).split(',');
        if (list.some((item) => item.trim() === selector)) {
            out.push(block.slice(open + 1, block.lastIndexOf('}')));
        }
    }
    return out;
}

function assertDecl(source, selector, re, message) {
    const bodies = rulesOf(source, selector);
    assert(bodies.length > 0, 'missing CSS rule for ' + selector);
    assert(bodies.some((body) => re.test(body)), message + ' [' + selector + ']');
}

function assertNoDecl(source, selector, re, message) {
    const bodies = rulesOf(source, selector);
    assert(bodies.length > 0, 'missing CSS rule for ' + selector);
    assert(!bodies.some((body) => re.test(body)), message + ' [' + selector + ']');
}

/* 1. The section is fixed, but its height comes from the measured pixel value. */
const SECTION = 'body.is-pwa #map-section';
assertDecl(html, SECTION, /position:\s*fixed/,
    'the PWA map section must stay fixed so it escapes the page flow');
assertDecl(html, SECTION, /height:\s*var\(--pwa-viewport-h/,
    'the section height must come from the measured px height (--pwa-viewport-h)');
assertDecl(html, SECTION, /min-height:\s*0\s*!important/,
    'no min-height floor may reintroduce a unit-derived height');
assertNoDecl(html, SECTION, /100dvh|100svh|100vh/,
    'no viewport unit may size the section — that is what left the strip');
assertNoDecl(html, SECTION, /bottom:\s*0\s*[;!]/,
    'bottom:0 resolves against the (possibly short) ICB and must not size the box');

/* 2. Every box of the percentage chain takes the same px height. */
['.map-frame', '.map-wrapper', '#detectlab-map', '.container', '.transp-panel'].forEach((sel) => {
    const target = 'body.is-pwa ' + sel;
    assertDecl(html, target, /height:\s*var\(--pwa-viewport-h/,
        sel + ' must be sized from --pwa-viewport-h, not from an ancestor percentage');
    assertDecl(html, target, /min-height:\s*0\s*!important/,
        sel + ' must not carry a min-height floor');
    assertNoDecl(html, target, /height:\s*(100dvh|100svh|100vh)/,
        sel + ' must not be sized by a viewport unit either');
});

/* 3. The script publishes one measurement and applies it inline. */
assert(/function measurePwaScreen\(\)/.test(html),
    'the PWA script must measure the screen height');
assert(/window\.innerHeight/.test(html) && /visualViewport\.height/.test(html),
    'the measurement must read innerHeight / visualViewport.height');
assert(/window\.screen\.height/.test(html),
    'screen.height must be available for the installed-app case');
assert(/setProperty\('--pwa-viewport-h'/.test(html),
    'the measured height must be published as --pwa-viewport-h');
assert(/setProperty\('--pwa-bleed'/.test(html),
    'the uncovered part of the screen must be published as --pwa-bleed');
assert(/setProperty\('height', h, 'important'\)/.test(html),
    'the height must be applied inline with priority on every shell box');
assert(/PWA_FIT_SELECTORS/.test(html)
    && /'#map-section > \.container'/.test(html)
    && /'#map-section \.map-wrapper'/.test(html)
    && /'.transp-panel'/.test(html),
    'the shell chain (section → container → frame → wrapper → map → panel) must all be fitted');

/* 4. Leaflet is re-measured after every fit. */
assert(/function resizeMap\(\)/.test(html) && /invalidateSize/.test(html),
    'Leaflet must be re-measured after the shell is resized');
assert(/setTimeout\(updatePwaMapLayout, 800\)/.test(html)
    && /setTimeout\(updatePwaMapLayout, 1600\)/.test(html),
    'delayed passes must cover the iOS settle window after first paint');
assert(/new window\.ResizeObserver/.test(html),
    'a ResizeObserver must catch the frame the container grows');
assert(/addEventListener\('load', updatePwaMapLayout\)/.test(html)
    && /addEventListener\('pageshow', updatePwaMapLayout\)/.test(html),
    'load and pageshow (back/forward cache) must re-sync the layout too');

/* 5. The bleed keeps the two container-bottom anchors on screen. */
assertDecl(html, 'body.is-pwa .leaflet-bottom',
    /bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ var\(--pwa-bleed, 0px\)\)\s*!important/,
    'the compass corner must clear the home indicator AND the bleed');
assertDecl(html, 'body.is-pwa .leaflet-container::after',
    /bottom:\s*calc\(4px \+ var\(--pwa-bleed, 0px\)\)/,
    'the "© Leafleet" tag must be lifted by the bleed too');

/* 6. No stray bottom bar may paint in the installed app. */
assertDecl(html, 'html.is-pwa #pwa-install-banner', /display:\s*none\s*!important/,
    'the install banner (a fixed bottom bar) must never paint in the installed app');
assertDecl(html, 'body.is-pwa #pwa-install-banner', /display:\s*none\s*!important/,
    'the guard must cover both html.is-pwa and body.is-pwa');

/* 7. The old band machinery is gone for good. */
assert(!/dl-vvh/.test(htmlRaw), 'the --dl-vvh floor must be gone');
assert(!/setVH\(\)/.test(htmlRaw), 'the --vh setter must be gone');
assert(!/pwa-debug/.test(htmlRaw), 'the temporary band probe must not be loaded');
assert(!fs.existsSync(path.join(__dirname, 'js/pwa-debug.js')),
    'the temporary band probe file must be deleted');
assert(!/pwa-debug/.test(sw), 'the shell must not pre-cache the deleted probe');

/* 8. The controls keep their published offsets — nothing moved. */
assertDecl(html, 'html.is-pwa .pwa-live-location-control', /position:\s*fixed\s*!important/,
    'the PWA live-location button must stay independently fixed');
assertDecl(html, 'html.is-pwa .pwa-live-location-control',
    /bottom:\s*calc\(env\(safe-area-inset-bottom, 0px\) \+ 28px\)\s*!important/,
    'the live-location button must keep its bottom offset');
/* Everything anchored to the map's bottom edge (toasts, zoom hints, layer
   action buttons, the layers panel clearance) already lifts by
   --pwa-bottom-controls-clearance, so the bleed is folded into that variable
   once instead of being re-applied control by control. */
assertDecl(html, 'body.is-pwa',
    /--pwa-bottom-controls-clearance:\s*calc\(44px \+ var\(--pwa-bleed, 0px\)\)/,
    'the bottom clearance must keep its 44px and add the bleed');
assertDecl(html, 'body.is-pwa .layer-action-dock',
    /bottom:\s*calc\(20px \+ env\(safe-area-inset-bottom, 0px\) \+ var\(--pwa-bleed, 0px\)\)\s*!important/,
    'the bottom-centre action dock must take the bleed lift too');

/* 9. Installed PWAs actually receive it. */
const cacheName = (sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1];
assert(Number(cacheName) >= 286,
    'the SW cache must be bumped to v286+ (got v' + cacheName + ')');

console.log('✓ the PWA shell is sized from one measured pixel height (no viewport unit)');
console.log('✓ the whole chain (section → container → frame → wrapper → map → panel) is fitted');
console.log('✓ the map overruns the OS strip by --pwa-bleed; compass + tag stay on screen');
console.log('✓ the install banner cannot paint a bottom bar in the installed app');
console.log('✓ the --dl-vvh floor, the --vh setter and the band probe are deleted');
console.log('OK — no dark strip or bar can remain below the map in the installed PWA.');
