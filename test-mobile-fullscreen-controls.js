// Regression test — mobile WEB fullscreen controls (browser tab, not PWA).
//
// What was broken
// ---------------
// In the mobile web variant (NOT the installed PWA), with the map in the
// "Full Screen" state:
//   1. the bottom-left buttons (compass + rotation-lock column) were not
//      visible at all — the browser's bottom search/URL bar covered them.
//      The full-screen map frame is `inset:0; height:100vh`, and 100vh is the
//      LARGE viewport, so the frame's bottom edge — and every
//      absolutely-positioned control anchored to it — slides under the
//      browser toolbar (the same overshoot index.html documents for ?pwa=1 in
//      a mobile browser tab). They must sit higher / on the visible viewport.
//   2. the "?" quick-guide button moved flush against the map search bar
//      ("se mută lipit de bara de căutare"). The desktop fullscreen rule
//      offsets it to right:64px to clear the ✕ exit button, but on phones the
//      ✕ is moved to the bottom-right — so the top-right corner is free and
//      the "?" must STAY in it (same spot as the normal, non-fullscreen map).
//
// The fix (styles.css + css/tutorial.css, tagged 20260922-mobile-fs-controls):
//   - body:not(.is-pwa) .map-frame.is-fullscreen #detectlab-map
//     .leaflet-bottom.leaflet-left becomes position:fixed, bottom
//     calc(56px + env(safe-area-inset-bottom)) — back onto the visible
//     viewport, clear of the browser search bar + home indicator. Scoped to
//     the max-width:600px mobile block and body:not(.is-pwa): the installed
//     app has no browser bar and keeps its own body.is-pwa .leaflet-bottom
//     clearance from index.html.
//   - css/tutorial.css adds a max-width:600px override that pins the
//     fullscreen "?" back to top:calc(14px + env(safe-area-inset-top)) /
//     right:14px — the exact offsets of the base .map-help-btn rule.
//
// Run: node test-mobile-fullscreen-controls.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const styles = read('css/styles.css');
const tutorial = read('css/tutorial.css');
const html = read('index.html');
const sw = read('sw.js');

let passed = 0;
function ok(name) { passed++; console.log('✓ ' + name); }

/* Returns the body of the FIRST `selector { ... }` rule in `source`. */
function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
    assert(m, 'missing CSS rule for ' + selector);
    return m[1];
}

/* True when `needle` appears inside an `@media (max-width: 600px) { ... }`
   block (brace-matched from each media prelude). */
function insideMobileMedia(source, needle) {
    const re = /@media\s*\(max-width:\s*600px\)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        let i = source.indexOf('{', m.index + m[0].length);
        if (i === -1) continue;
        let depth = 1, j = i + 1;
        while (j < source.length && depth > 0) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}') depth--;
            j++;
        }
        const block = source.slice(i + 1, j - 1);
        if (block.indexOf(needle) !== -1) return true;
    }
    return false;
}

/* ── 1. Bottom-left compass column clears the browser search bar ─────────── */
const liftSel = 'body:not(.is-pwa) .map-frame.is-fullscreen #detectlab-map .leaflet-bottom.leaflet-left';
assert(styles.includes(liftSel),
    'styles.css must lift the bottom-left Leaflet corner in mobile-web fullscreen');
const lift = ruleOf(styles, liftSel);
assert(/position:\s*fixed/.test(lift),
    'the corner must anchor to the visible viewport (position:fixed) — the map frame\'s 100vh bottom edge slides under the browser toolbar');
assert(/bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom, 0px\)\)/.test(lift),
    'the corner must clear the browser search bar (~50-56px) + home-indicator / gesture inset');
assert(insideMobileMedia(styles, liftSel),
    'the lift is mobile-web layout only — it must sit inside @media (max-width: 600px)');
assert(styles.includes('body:not(.is-pwa) .map-frame.is-fullscreen'),
    'the lift is scoped to body:not(.is-pwa): the installed PWA has no browser bar');
ok('bottom-left compass column fixes to the visible viewport above the browser search bar');

/* ── 2. The PWA contract is untouched ("nu varianta PWA") ───────────────── */
const compassBase = ruleOf(styles.replace(/\n\s*/g, ' '), '#detectlab-map .detectlab-compass');
assert(/margin:\s*0 0 10px 10px !important/.test(compassBase),
    'the compass keeps its base bottom-left margin (the lift may not move the base rule)');
const indexStyle = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const pwaBottom = ruleOf(indexStyle, 'body.is-pwa .leaflet-bottom');
assert(/bottom:\s*env\(safe-area-inset-bottom, 0px\) !important/.test(pwaBottom),
    'the installed PWA keeps its own safe-area bottom clearance');
// Comments name both worlds on purpose ("Scoped to body:not(.is-pwa): …
// body.is-pwa .leaflet-bottom …"), so only real rule text may count here.
const stylesNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, '');
assert(!/body\.is-pwa[^{}]*\.map-frame\.is-fullscreen[^{}]*\.leaflet-bottom[^{}]*\{/.test(stylesNoComments),
    'the PWA must not inherit the browser-bar lift');
ok('PWA bottom-left anchoring (safe-area only) is unchanged');

/* ── 3. The "?" quick-guide button stays in the top-right corner ─────────── */
const desktopFsHelp = ruleOf(tutorial.replace(/\n\s*/g, ' '), '.map-frame.is-fullscreen .map-help-btn');
assert(/right:\s*64px/.test(desktopFsHelp),
    'desktop fullscreen still offsets the "?" left of the ✕ button');
const baseHelp = ruleOf(tutorial.replace(/\n\s*/g, ' '), '.map-help-btn');
assert(/top:\s*calc\(14px \+ env\(safe-area-inset-top, 0px\)\)/.test(baseHelp) && /right:\s*14px/.test(baseHelp),
    'the base "?" rule keeps its top-right corner offsets (14px + safe-area / 14px)');
assert(insideMobileMedia(tutorial, '.map-frame.is-fullscreen .map-help-btn'),
    'the mobile override must sit inside @media (max-width: 600px)');
const mobileFsHelp = /@media\s*\(max-width:\s*600px\)[\s\S]*?\.map-frame\.is-fullscreen \.map-help-btn\s*\{([^}]*)\}/.exec(tutorial);
assert(mobileFsHelp, 'mobile fullscreen must override the "?" position');
assert(/right:\s*14px/.test(mobileFsHelp[1]),
    'in mobile fullscreen the "?" must stay in the top-right corner (right:14px), glued neither to the map search bar nor to the ✕ slot');
assert(/top:\s*calc\(14px \+ env\(safe-area-inset-top, 0px\)\)/.test(mobileFsHelp[1]),
    'the "?" keeps the same top offset as the normal map');
ok('"?" quick guide stays pinned in the top-right corner in mobile fullscreen');

/* ── 4. Cache busting: the touched stylesheets ship under a ?v= tag ──
   styles.css is re-versioned by every later release (v127 bumped it to
   ?v=20260922-vo-actions-both-slots), so assert the LIVE relationship — the
   exact URL the page requests must be in PRECACHE_URLS — instead of one
   frozen tag. tutorial.css carries the tag of the release that last changed
   it (the glass-controls pass gave the "?" button the shared pane). */
const stylesUrl = (html.match(/href="(css\/styles\.css\?v=[^"]+)"/) || [])[1];
assert(stylesUrl, 'index.html requests a cache-busted styles.css');
assert(sw.includes("'" + stylesUrl + "'"), 'sw.js pre-caches the live styles.css URL (' + stylesUrl + ')');
const TAG = '20261025-layer-glass';
assert(html.includes('css/tutorial.css?v=' + TAG), 'index.html requests the bumped tutorial.css');
assert(sw.includes("'css/tutorial.css?v=" + TAG + "'"), 'sw.js pre-caches the bumped tutorial.css');
const cacheNum = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert(cacheNum >= 126, 'sw.js CACHE_NAME must be bumped past v125 (got v' + cacheNum + ')');
ok('both stylesheets are cache-busted and pre-cached (' + stylesUrl + ', tutorial.css?v=' + TAG + ')');

console.log('\n' + passed + ' checks passed — ALL MOBILE FULLSCREEN CONTROL TESTS PASSED');
