// Unit test — the PWA screen measurement (measurePwaScreen in index.html).
//
// The whole "no strip under the map" fix rests on this one function returning
// the PIXEL height the shell must be, and on it never asking a browser-tab
// layout to overrun its own viewport. The function is evaluated here against
// stubbed window objects, so every device case is covered without a browser.
//
// Run: node test-pwa-viewport-fit.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* ── pull the function out of the inline PWA script ─────────────────────── */
const startMarker = 'function measurePwaScreen()';
const start = html.indexOf(startMarker);
assert(start > -1, 'index.html must define measurePwaScreen()');

let depth = 0;
let end = -1;
let seen = false;
for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') {
        depth--;
        if (seen && depth === 0) { end = i + 1; break; }
    }
}
assert(end > start, 'measurePwaScreen() must be a complete function body');
const fnSource = html.slice(start, end);

assert(!/\.is-pwa/.test(fnSource), 'the measurement must not depend on the shell class');
assert(!/100vh|dvh|svh/.test(fnSource), 'no viewport unit may take part in the measurement');

/* ── run it against stubbed environments ────────────────────────────────── */
function measure(env) {
    const media = (query) => ({
        matches: (env.displayModes || ['standalone']).includes(
            (query.match(/display-mode:\s*([a-z]+)/) || [])[1]
        )
    });
    const win = {
        innerHeight: env.innerHeight,
        visualViewport: env.visualViewport,
        screen: env.screen,
        matchMedia: media,
        navigator: { standalone: env.navigatorStandalone === true }
    };
    // eslint-disable-next-line no-new-func
    const factory = new Function('window', 'Math', fnSource + '\nreturn measurePwaScreen;');
    return factory(win, Math)();
}

/* 1. The reported bug: standalone reports a viewport shorter than the screen. */
{
    const m = measure({
        innerHeight: 785,
        visualViewport: { height: 785 },
        screen: { height: 844 },
        displayModes: ['standalone']
    });
    assert.strictEqual(m.pageH, 785, 'the page viewport reading must be kept as its own number');
    assert.strictEqual(m.height, 844,
        'the shell must be sized to the physical screen (844), not to the short 785 viewport');
    assert.strictEqual(m.bleed, 59,
        'the 59px the page does not cover must be published as the bleed');
    console.log('✓ standalone with a short viewport: shell = physical screen, bleed = 59px');
}

/* 2. Normal standalone: no bleed, exactly the screen. */
{
    const m = measure({
        innerHeight: 844, visualViewport: { height: 844 }, screen: { height: 844 },
        displayModes: ['standalone']
    });
    assert.strictEqual(m.height, 844);
    assert.strictEqual(m.bleed, 0, 'nothing may bleed when the two agree');
    console.log('✓ standalone, viewport == screen: exact fit, zero bleed');
}

/* 3. A browser tab (?pwa=1 preview) must never overrun its own viewport. */
{
    const m = measure({
        innerHeight: 700, visualViewport: { height: 700 }, screen: { height: 900 },
        displayModes: ['browser']
    });
    assert.strictEqual(m.height, 700,
        'a browser tab keeps its own viewport — the browser chrome is not a strip to cover');
    assert.strictEqual(m.bleed, 0, 'no bleed outside an installed app');
    console.log('✓ browser tab: sized to the visible viewport, never to screen.height');
}

/* 4. Landscape: screen.height is the SHORT side, so it can never win. */
{
    const m = measure({
        innerHeight: 390, visualViewport: { height: 390 }, screen: { height: 390 },
        displayModes: ['standalone']
    });
    assert.strictEqual(m.height, 390);
    assert.strictEqual(m.bleed, 0);
    const rotated = measure({
        innerHeight: 844, visualViewport: { height: 844 }, screen: { height: 390 },
        displayModes: ['standalone']
    });
    assert.strictEqual(rotated.height, 844, 'a taller viewport than screen.height must be kept');
    assert.strictEqual(rotated.bleed, 0, 'a smaller screen.height must never produce a negative bleed');
    console.log('✓ landscape readings never shrink the shell');
}

/* 5. visualViewport can be the taller, more accurate reading. */
{
    const m = measure({
        innerHeight: 800, visualViewport: { height: 812 }, screen: { height: 812 },
        displayModes: ['standalone']
    });
    assert.strictEqual(m.pageH, 812, 'the taller of innerHeight / visualViewport must win');
    assert.strictEqual(m.bleed, 0);
    console.log('✓ visualViewport.height is honoured when it is the taller reading');
}

/* 6. Old WebViews without visualViewport / screen / matchMedia must not throw. */
{
    const m = measure({ innerHeight: 733, displayModes: [] });
    assert.strictEqual(m.height, 733);
    assert.strictEqual(m.bleed, 0);
    console.log('✓ missing visualViewport / screen / matchMedia degrades to innerHeight');
}

/* 7. iOS navigator.standalone is honoured as an installed-app signal. */
{
    const m = measure({
        innerHeight: 785, visualViewport: { height: 785 }, screen: { height: 844 },
        displayModes: ['browser'], navigatorStandalone: true
    });
    assert.strictEqual(m.height, 844, 'navigator.standalone must count as installed');
    assert.strictEqual(m.bleed, 59);
    console.log('✓ navigator.standalone (older iOS) counts as the installed app');
}

/* 8. The fit itself writes the number out with priority, on the whole chain. */
const fit = (html.match(/function fitPwaViewport\(\)[\s\S]*?\n                \}/) || [''])[0];
assert(fit, 'index.html must define fitPwaViewport()');
assert(/setProperty\('--pwa-viewport-h', m\.height \+ 'px'\)/.test(fit),
    'the measured height must be published as --pwa-viewport-h in px');
assert(/setProperty\('--pwa-bleed', m\.bleed \+ 'px'\)/.test(fit),
    'the bleed must be published as --pwa-bleed in px');
assert(/setProperty\('height', h, 'important'\)/.test(fit),
    'the height must be written inline with priority');
assert(/PWA_FIT_SELECTORS\.forEach/.test(fit),
    'every shell box must be fitted, not just the section');

const selectors = (html.match(/var PWA_FIT_SELECTORS = \[([\s\S]*?)\];/) || ['', ''])[1];
['#map-section', '#map-section > .container', '#map-section .map-frame',
    '#map-section .map-wrapper', '#detectlab-map', '.transp-panel'].forEach((sel) => {
    assert(selectors.includes("'" + sel + "'"), 'PWA_FIT_SELECTORS must include ' + sel);
});
console.log('✓ the fit applies the measured px height to the whole shell chain');

console.log('\nOK — one pixel measurement drives the PWA shell; no strip can survive it.');
