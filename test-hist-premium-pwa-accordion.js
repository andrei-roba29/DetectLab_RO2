// Regression test — mobile PWA: the last card of the PREMIUM historical-maps
// accordion (today "Alte hărți / Other maps"; the Galiția & Lodomeria 1855
// card and the eight UK historical maps precede it) must never be clipped by
// the panel's animated max-height.
//
// Background:
//   · v1 of the bug: hardcoded max-height 1000px + overflow:hidden cut the
//     last row when the 12 map rows grew past the ceiling (browser zoom,
//     bigger fonts, mobile PWA).
//   · PR #189 replaced the fixed ceiling with a height measured at expand
//     time (setSubLayersMaxHeight / measureSubLayersHeight). Still, the
//     expanded state kept a FINITE max-height forever — in the standalone
//     PWA the content can change size AFTER the measurement (font loading,
//     PWA suspend/resume, text zoom, rotation, or the 1000px fallback when
//     the panel was unmeasurable), so the last card was clipped again.
//   · This fix: after the 0.3s expand transition + the 0.4s re-measure, the
//     constraint is released (max-height:none) — the box can no longer clip
//     its own content; .transp-panel (overflow-y:auto, full screen height in
//     PWA) takes over scrolling. Collapse re-pins the current height first
//     so the 0.3s animation still runs from a real start value.
//
// Run: node test-hist-premium-pwa-accordion.js  (from repo root)
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

const mapApp = read('js/map-app.js');
const html = read('index.html');
const sw = read('sw.js');

console.log('[Test] Premium historical maps accordion — PWA mobile (Galiția & Lodomeria 1855 not clipped)...');

// ── 1. Static wiring ──────────────────────────────────────────────────

// The premium accordion expand path must go through the measuring helper.
const premiumToggleBlock = mapApp.slice(
    mapApp.indexOf('window.toggleHistPremiumSubLayers'),
    mapApp.indexOf('window.toggleHistPremiumSubLayers') + 1200
);
assert.match(premiumToggleBlock, /setSubLayersMaxHeight\(panel, true, 1000\)/,
    'histPremiumSubLayers expand must use setSubLayersMaxHeight (measured height, 1000px only as fallback)');

// The release step exists and only fires while the panel is still expanded.
assert.match(mapApp, /panel\._subLayersReleaseTimer = setTimeout\(/,
    'setSubLayersMaxHeight must schedule the max-height release after expand');
assert.match(mapApp, /panel\.style\.maxHeight = 'none';/,
    'released state must be max-height:none (box can never clip its content)');
assert.match(mapApp, /cur !== '0' && cur !== '0px' && cur !== 'none'/,
    'release must be a no-op when the panel was collapsed (rapid expand→collapse)');

// Collapse from the released state must re-pin the height for the animation.
assert.match(mapApp, /if \(panel\.style\.maxHeight === 'none'\) \{[\s\S]{0,220}panel\.style\.maxHeight = panel\.scrollHeight \+ 'px';[\s\S]{0,120}void panel\.offsetHeight;/,
    'collapse from released state must pin scrollHeight + force reflow before animating to 0');
assert.match(mapApp, /if \(panel\._subLayersReleaseTimer\) \{[\s\S]{0,120}clearTimeout\(panel\._subLayersReleaseTimer\);/,
    'every state change must cancel a pending release');

// The Josephine auto-expand guard checks maxHeight === '0' for "collapsed".
// Our collapse must therefore set exactly '0' (it does — see runtime
// scenarios below), and the released 'none' must NOT match that guard, so a
// visible panel is never force-expanded twice.
assert.match(mapApp, /sub\.style\.maxHeight === '0px' \|\| sub\.style\.maxHeight === '0'/,
    'Josephine auto-expand guard unchanged (collapsed = maxHeight 0)');

// The clipped card is the LAST child of the premium accordion, so a
// released panel is what keeps it fully visible. Galicia used to be the
// last card; eight premium UK historical maps now follow it, and the
// "Other maps" card closes the accordion.
const subStart = html.indexOf('id="histPremiumSubLayers"');
const subEnd = html.indexOf('/histPremiumSubLayers');
assert.ok(subStart > -1 && subEnd > subStart, 'histPremiumSubLayers panel exists');
const subPanel = html.slice(subStart, subEnd);
const galiciaIdx = subPanel.indexOf('id="galicia1855Row"');
assert.ok(galiciaIdx > -1, 'galicia1855Row lives inside the premium accordion');
const UK_ROWS = ['ukOsLondon1893Row', 'ukOs1919Row', 'ukOs10k1888Row', 'ukOs25k1937Row',
    'ukOsHills1885Row', 'ukOs63k1955Row', 'ukOs1900sRow', 'ukBaire1940Row'];
let cursor = galiciaIdx;
for (const rowId of UK_ROWS) {
    const idx = subPanel.indexOf('id="' + rowId + '"', cursor);
    assert.ok(idx > cursor, rowId + ' is appended after the previous premium card (Galicia → UK maps order)');
    cursor = idx;
}
const otherMapsIdx = subPanel.indexOf('id="otherMapsRow"', cursor);
assert.ok(otherMapsIdx > cursor, 'otherMapsRow still comes after the UK historical maps');
const afterLastCard = subPanel.slice(otherMapsIdx).replace('id="otherMapsRow"', '');
assert.ok(!/id="(\w+)Row"/.test(afterLastCard),
    'otherMapsRow (Alte hărți / Other maps) is the last card of the accordion');

// ── 2. Runtime simulation of the real helper (mock panel + fake clock) ─

const fnStart = mapApp.indexOf('function measureSubLayersHeight');
const fnEnd = mapApp.indexOf('(function initMap()');
assert.ok(fnStart > -1 && fnEnd > fnStart, 'accordion height helpers found in map-app.js');
const fnSource = mapApp.slice(fnStart, fnEnd);

function makeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    function fakeSetTimeout(fn, delay) {
        const id = nextId++;
        timers.set(id, { at: now + (delay || 0), fn });
        return id;
    }
    function fakeClearTimeout(id) { timers.delete(id); }
    function advance(ms) {
        const target = now + ms;
        for (;;) {
            let earliest = null;
            for (const [id, t] of timers) {
                if (!earliest || t.at < earliest.at) earliest = { id, at: t.at, fn: t.fn };
            }
            if (!earliest || earliest.at > target) { now = target; break; }
            now = earliest.at;
            timers.delete(earliest.id);
            earliest.fn();
        }
    }
    return { fakeSetTimeout, fakeClearTimeout, advance };
}

// Mock accordion row: style.maxHeight is logged; scrollHeight behaves like
// the browser (full content height whether clipped or not).
function makePanel(contentHeight) {
    const panel = {
        _content: contentHeight,
        _ops: [],
        style: {}
    };
    Object.defineProperty(panel, 'scrollHeight', { get() { return this._content; } });
    let mh = '0';
    Object.defineProperty(panel.style, 'maxHeight', {
        get() { return mh; },
        set(v) { mh = v; panel._ops.push(v); }
    });
    return panel;
}

function loadHelpers(clock) {
    const runner = new Function(
        'setTimeout', 'clearTimeout', 'parseInt',
        fnSource + '\nreturn { measureSubLayersHeight, setSubLayersMaxHeight };'
    );
    return runner(clock.fakeSetTimeout, clock.fakeClearTimeout, parseInt);
}

// ── Scenario A: PWA — content grows AFTER the measurement ─────────────
{
    const clock = makeClock();
    const api = loadHelpers(clock);
    const panel = makePanel(1150); // 12 cards, taller than any old ceiling

    api.setSubLayersMaxHeight(panel, true, 1000);
    assert.strictEqual(panel.style.maxHeight, '1150px', 'expand animates to the measured height');

    // Font loading / PWA layout shift after the measurement.
    panel._content = 1180;
    clock.advance(400); // re-measure updates the px value
    assert.strictEqual(panel.style.maxHeight, '1180px', '400ms re-measure tracks the grown content');

    clock.advance(400); // release fires
    assert.strictEqual(panel.style.maxHeight, 'none', 'constraint released after the animation (PWA fix)');

    // PWA suspend/resume grows the content again — nothing can clip it now.
    panel._content = 1300;
    clock.advance(1000);
    assert.strictEqual(panel.style.maxHeight, 'none', 'no re-clipping after later growth (Galiția & Lodomeria card stays visible)');
    // measure sets 'none' transiently (restored right after), so the full
    // write sequence is: measure/restore, expand, re-measure/restore/update, release.
    assert.deepStrictEqual(panel._ops,
        ['none', '0', '1150px', 'none', '1150px', '1180px', 'none'],
        'exact write sequence: measure → expand px → re-measure px → single release to none');
}

// ── Scenario B: unmeasurable panel (fallback 1000px) still releases ───
{
    const clock = makeClock();
    const api = loadHelpers(clock);
    const panel = makePanel(0); // display:none tab → scrollHeight 0

    api.setSubLayersMaxHeight(panel, true, 1000);
    assert.strictEqual(panel.style.maxHeight, '1000px', 'falls back to 1000px when unmeasurable (transient)');
    clock.advance(800);
    assert.strictEqual(panel.style.maxHeight, 'none', 'fallback is released too, so 1100px of content is never permanently clipped');
}

// ── Scenario C: rapid expand→collapse (within 800ms) ──────────────────
{
    const clock = makeClock();
    const api = loadHelpers(clock);
    const panel = makePanel(900);

    api.setSubLayersMaxHeight(panel, true, 1000);
    clock.advance(300);
    api.setSubLayersMaxHeight(panel, false);
    assert.strictEqual(panel.style.maxHeight, '0', 'collapse sets maxHeight 0 (Josephine auto-expand guard still matches)');
    clock.advance(2000);
    assert.strictEqual(panel.style.maxHeight, '0', 'cancelled release never re-expands a collapsed panel');
}

// ── Scenario D: collapse from the released state re-pins the height ───
{
    const clock = makeClock();
    const api = loadHelpers(clock);
    const panel = makePanel(850);

    api.setSubLayersMaxHeight(panel, true, 1000);
    clock.advance(800);
    assert.strictEqual(panel.style.maxHeight, 'none', 'expanded + released');

    api.setSubLayersMaxHeight(panel, false);
    assert.strictEqual(panel._ops[panel._ops.length - 2], '850px', 'collapse pins the current content height first (animatable start)');
    assert.strictEqual(panel._ops[panel._ops.length - 1], '0', 'then animates to 0');
}

// ── Scenario E: second expand after collapse starts from 0 ────────────
{
    const clock = makeClock();
    const api = loadHelpers(clock);
    const panel = makePanel(700);

    api.setSubLayersMaxHeight(panel, true, 1000);
    clock.advance(800);
    api.setSubLayersMaxHeight(panel, false);
    clock.advance(100);
    api.setSubLayersMaxHeight(panel, true, 1000);
    assert.strictEqual(panel.style.maxHeight, '700px', 're-expand measures fresh content height');
    clock.advance(800);
    assert.strictEqual(panel.style.maxHeight, 'none', 're-expand releases again');
}

// ── 3. Installed PWA must pick up the new client ──────────────────────
// The bug only disappears on phones once the service worker swaps the
// stale cached map-app.js, so the SW cache name must move and the fresh
// versioned URL must be precached.
const cacheMatch = sw.match(/const CACHE_NAME = '([^']+)'/);
assert.ok(cacheMatch, 'sw.js defines CACHE_NAME');
assert.notStrictEqual(cacheMatch[1], 'detectlab-v80-patrimoniu-zoom-anchor',
    'CACHE_NAME bumped so installed PWAs replace stale scripts');
// Parse the version instead of pinning the major digit: every later release
// re-bumps the name (v90-no-opacity-caption today), and a frozen `v8\d+`
// pattern starts failing the moment the counter leaves the 80s.
const cacheVersion = Number((cacheMatch[1].match(/-v(\d+)-/) || [])[1] || 0);
assert.ok(cacheVersion >= 81,
    'new CACHE_NAME marks at least the premium-history PWA fix (got: ' + cacheMatch[1] + ')');

const scriptMatch = html.match(/<script src="js\/map-app\.js\?v=([^"]+)"><\/script>/);
assert.ok(scriptMatch, 'index.html loads js/map-app.js with a version query');
assert.ok(scriptMatch[1] !== '20260914-patrimoniu-zoom-anchor',
    'map-app.js version query bumped for this fix');
assert.ok(sw.includes("'" + 'js/map-app.js?v=' + scriptMatch[1] + "'"),
    'the exact new map-app.js URL is in the SW precache (offline-safe)');

console.log('  ✓ release of max-height after the expand animation (no permanent finite ceiling)');
console.log('  ✓ 400ms re-measure + 800ms release sequence; single release per expand');
console.log('  ✓ 1000px fallback is transient — released too');
console.log('  ✓ rapid expand→collapse stays collapsed; collapse from released state re-pins for the animation');
console.log('  ✓ Josephine auto-expand guard (maxHeight === 0) untouched');
console.log('  ✓ SW CACHE_NAME bumped + new map-app.js version precached (installed PWAs update)');
console.log('OK — Galiția & Lodomeria 1855 card can no longer be clipped in the mobile PWA.');
