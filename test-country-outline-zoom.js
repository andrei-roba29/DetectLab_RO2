// The country outline must not “zoom in 2D” on zoom in/out: a renderer that
// is created while a Leaflet zoom animation is already in flight never
// receives that animation's zoomanim, so it cannot CSS-scale with the tile
// levels — it projects straight onto the target frame and the border sits
// there flat while the imagery is still scaling towards it. That happens
// whenever a (re)draw races an animation: the globe hand-off fit landing
// under the closing gate, the 10m refinement swapping the outline mid-zoom,
// a dock switch during a wheel zoom. The dedicated BoundsSVG renderer now
// waits such an animation out hidden and is revealed by the moveend update
// that always follows zoomend; an outline that joined the animation via
// zoomanim is never hidden, and its stroke no longer CSS-scales either
// (vector-effect: non-scaling-stroke), so the line keeps its reprojected
// width at every intermediate scale.
//
// The mid-flight geometry itself is covered by the optional browser suite
// (test-country-outline-zoom-browser.js); this file guards the lifecycle
// logic in Node by running the shipped functions against a stub renderer.
//
// Usage: node test-country-outline-zoom.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
    return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

const picker = read('js/globe-country-picker.js');
const indexHtml = read('index.html');
const swJs = read('sw.js');

console.log('[Test] Country outline vs in-flight zoom animations...');

// ── The fix, at the source level ─────────────────────────────────────
assert.match(
    picker,
    /_onAnimZoom:\s*function\s*\(ev\)\s*\{\s*this\._outlineJoinedZoom\s*=\s*true;\s*L\.SVG\.prototype\._onAnimZoom\.call\(this,\s*ev\);/,
    'the outline renderer must record that it joined the zoom animation before delegating to Leaflet'
);
assert.match(
    picker,
    /_syncOutlineZoomVisibility:\s*function\s*\(\)\s*\{[\s\S]{0,500}?this\._map\._animatingZoom\)\s*\{\s*if\s*\(\s*!this\._outlineJoinedZoom\s*\)\s*\{\s*this\._outlineAwaitingZoom\s*=\s*true;\s*this\._container\.style\.visibility\s*=\s*'hidden';/,
    'a renderer born mid-animation (no zoomanim received) must wait the animation out hidden'
);
assert.match(
    picker,
    /this\._outlineJoinedZoom\s*=\s*false;\s*if\s*\(this\._outlineAwaitingZoom\)\s*\{\s*this\._outlineAwaitingZoom\s*=\s*false;\s*this\._container\.style\.visibility\s*=\s*'';/,
    'once the map is no longer animating the outline must be revealed and both flags cleared'
);
assert.match(
    picker,
    /L\.SVG\.prototype\._update\.call\(this\);[\s\S]{0,300}?this\._syncOutlineZoomVisibility\(\);/,
    '_update must run the visibility sync (the moveend after zoomend is what reveals a waited-out outline)'
);
assert.match(
    picker,
    /_initPath:\s*function\s*\(path\)\s*\{\s*L\.SVG\.prototype\._initPath\.call\(this,\s*path\);[\s\S]{0,900}?setAttribute\('vector-effect',\s*'non-scaling-stroke'\)/,
    'the border stroke must not CSS-scale during an animated zoom — Leaflet reprojects it to a constant width at zoomend, so it must paint at that width all the way through'
);

// ── Run the shipped lifecycle functions ───────────────────────────────
function extractFn(src, marker) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, 'could not find ' + marker + ' in js/globe-country-picker.js');
    const open = src.indexOf('{', src.indexOf('function', at));
    let depth = 0, i = open;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (!depth) break; }
    }
    return src.slice(at, i + 1).replace(/^[^:]*:\s*/, '');
}

const sync = new Function(
    'return ' + extractFn(picker, '_syncOutlineZoomVisibility: function () {')
)();
const onAnimZoom = new Function(
    'L',
    'return ' + extractFn(picker, '_onAnimZoom: function (ev) {')
);

function makeRenderer(joined) {
    const r = {
        _map: { _animatingZoom: true },
        _container: { style: { visibility: '' } },
        _outlineJoinedZoom: !!joined,
        _outlineAwaitingZoom: false
    };
    r._sync = function () { return sync.call(r); };
    return r;
}

// Born mid-animation: hidden for the rest of the flight, revealed after.
{
    const r = makeRenderer(false);
    r._sync();
    assert.strictEqual(r._container.style.visibility, 'hidden',
        'an outline (re)drawn mid-zoom must not paint at the target frame while tiles still scale');
    assert.strictEqual(r._outlineAwaitingZoom, true, 'the renderer must remember it is waiting out a zoom');
    r._sync(); // any further _update during the flight keeps it hidden
    assert.strictEqual(r._container.style.visibility, 'hidden');
    r._map._animatingZoom = false; // zoomend → moveend → _update
    r._sync();
    assert.strictEqual(r._container.style.visibility, '', 'the outline must reappear once the zoom settles');
    assert.strictEqual(r._outlineAwaitingZoom, false);
    assert.strictEqual(r._outlineJoinedZoom, false, 'the joined marker belongs to the finished animation');
    console.log('  ✓ an outline (re)drawn mid-zoom waits hidden and reappears at zoomend');
}

// Already on the map when the zoom started: joined via zoomanim, never hidden.
{
    const r = makeRenderer(false);
    let delegated = null;
    const L = { SVG: { prototype: { _onAnimZoom(ev) { delegated = ev; } } } };
    onAnimZoom(L).call(r, { center: [46, 25], zoom: 9 });
    assert.strictEqual(r._outlineJoinedZoom, true, 'zoomanim must mark the renderer as joined');
    assert.deepStrictEqual(delegated, { center: [46, 25], zoom: 9 },
        'the stock zoomanim transform must still run — the outline scales with the imagery');
    r._sync();
    assert.strictEqual(r._container.style.visibility, '',
        'an outline that joined the animation must stay visible while it scales');
    assert.strictEqual(r._outlineAwaitingZoom, false);
    r._map._animatingZoom = false;
    r._sync();
    assert.strictEqual(r._container.style.visibility, '');
    console.log('  ✓ an outline that joined the zoom via zoomanim is never hidden');
}

// No container yet (renderer not fully added): must be a harmless no-op.
{
    const r = makeRenderer(false);
    r._container = null;
    r._sync();
    r._map._animatingZoom = false;
    r._sync();
    console.log('  ✓ the visibility sync is safe before the container exists');
}

// ── Versioning: the fix must actually ship to installed PWAs ─────────
assert(indexHtml.includes('js/globe-country-picker.js?v=20261017-outline-zoom-settle'),
    'index.html loads the re-versioned picker');
assert(swJs.includes("'js/globe-country-picker.js?v=20261017-outline-zoom-settle'"),
    'sw.js precaches the re-versioned picker');
const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 222, 'sw.js cache must be v222 or newer so the outline zoom fix ships');
console.log('  ✓ picker asset re-versioned in index.html and the service worker');

console.log('✅ ALL COUNTRY-OUTLINE-ZOOM TESTS PASSED');
