// Regression test — an ASIG tap may only query where the ASIG data is.
//
// The bug
// -------
// `ready()` registers ONE map-wide click handler:
//
//     map.on('click', function (event) {
//         if (!hasActive()) return;
//         if (!activeWmsLeaves().length) return;
//         openFeatureInfo(event.latlng);       // “Querying the ASIG service…”
//     });
//
// `hasActive()` is just `runtime.order.length > 0`, and on/off state is
// restored from localStorage (detectlab_albania_layers_v2). So once any
// Albanian layer had been switched on — in any earlier session, the installed
// PWA included — EVERY tap anywhere on the map opened the popup, printed
// “Querying the ASIG service…” and loaded the Albanian archaeological /
// heritage HTML, far outside Albania.
//
// The fix
// -------
// A tap may only query when ALL of these hold:
//   · the country gate is parked open   (not suppressed, Albania selected),
//   · the tap is inside the ASIG footprint,
//   · at least one ASIG WMS layer is actually ON THE MAP (not merely
//     remembered in localStorage).
//
// Run: node test-asig-click-guard.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const src = read('js/asig-albania-layers.js');
const CONFIG = require('./js/asig-albania-layers.config.js');

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[ASIG] map tap → feature info is gated to the Albanian footprint');

/* ── 1. The map-wide handler consults the gate, nothing else ────────────── */
const handler = /map\.on\('click', function \(event\) \{([\s\S]*?)\n        \}\);/.exec(src);
check(!!handler, 'the module still registers its map click handler');
check(/canQueryAt\(event\.latlng\)/.test(handler[1]),
    'the handler must go through canQueryAt() — the old hasActive() test let any tap through');
check(!/hasActive\(\)/.test(handler[1]),
    'the handler must not fall back to the persisted “has active layers” flag');
check(!/openFeatureInfo\([^)]*\)[\s\S]*openFeatureInfo/.test(handler[1]),
    'one tap opens one popup');

/* ── 2. canQueryAt() checks all four conditions ─────────────────────────── */
const gate = /function canQueryAt\(latlng\) \{([\s\S]*?)\n    \}/.exec(src);
check(!!gate, 'canQueryAt() must exist');
[
    [/runtime\.suppressed/, 'a suppressed group (leaving the country) must not answer'],
    [/runtime\.inCountry/, 'the selected-country gate must be enforced'],
    [/insideFootprint\(latlng\)/, 'the tap must be inside the ASIG footprint'],
    [/activeWmsLeaves\(\)\.length > 0/, 'something must actually be drawing']
].forEach(([re, message]) => check(re.test(gate[1]), message));

/* ── 3. “Active” now means on this map, not remembered in storage ───────── */
const leaves = /function activeWmsLeaves\(\) \{([\s\S]*?)\n    \}/.exec(src);
check(!!leaves, 'activeWmsLeaves() must exist');
check(/map\.hasLayer && !map\.hasLayer\(part\.layer\)/.test(leaves[1]) ||
      /!map\.hasLayer\(part\.layer\)/.test(leaves[1]),
    'a remembered-but-not-drawn layer must be skipped (hasLayer check)');
check(/var map = mapInstance\(\)/.test(leaves[1]),
    'the map instance is needed for that check');

/* ── 4. The footprint maths, run for real ───────────────────────────────── */
const fnSource = /function insideFootprint\(latlng\) \{[\s\S]*?\n    \}/.exec(src)[0];
const insideFootprint = new Function('CONFIG', fnSource + '\nreturn insideFootprint;')(
    { countryBounds: CONFIG.countryBounds }
);
const bounds = CONFIG.countryBounds;
check(JSON.stringify(bounds) === JSON.stringify([[39.538, 18.773], [42.758, 21.179]]),
    'the footprint is the published Albanian coverage box');
check(insideFootprint({ lat: 41.3275, lng: 19.8187 }) === true, 'Tirana answers');
check(insideFootprint({ lat: 42.4, lng: 19.5 }) === true, 'northern Albania answers');
check(insideFootprint({ lat: 40.0, lng: 20.1 }) === true, 'southern Albania answers');
/* The points that used to open the popup: the reporter's own taps. */
check(insideFootprint({ lat: 46.7712, lng: 23.6236 }) === false, 'Cluj-Napoca must not answer');
check(insideFootprint({ lat: 44.4268, lng: 26.1025 }) === false, 'Bucharest must not answer');
check(insideFootprint({ lat: 51.5074, lng: -0.1278 }) === false, 'London must not answer');
check(insideFootprint({ lat: 37.9838, lng: 23.7275 }) === false, 'Athens must not answer');
check(insideFootprint({ lat: 43.0, lng: 19.0 }) === false, 'just north of the border must not answer');
check(insideFootprint({ lat: 38.5, lng: 20.0 }) === false, 'just south of the border must not answer');
check(insideFootprint(null) === false, 'a tap without coordinates must not answer');
check(insideFootprint({}) === false, 'a malformed latlng must not answer');
check(insideFootprint({ lat: '41.3', lng: '19.8' }) === false,
    'string coordinates are not trusted');
/* The documented margin around the outline. */
check(insideFootprint({ lat: bounds[0][0] - 0.01, lng: bounds[0][1] - 0.01 }) === true,
    'a tap marginally outside the outline is still accepted (tile edge)');
check(insideFootprint({ lat: bounds[1][0] + 0.05, lng: bounds[1][1] + 0.05 }) === false,
    'the margin stays small — a tap well outside never answers');

/* ── 5. The gate is reachable from the public API (used by tests/tools) ── */
['canQueryAt', 'insideFootprint'].forEach((name) =>
    check(new RegExp('\\b' + name + ':\\s*' + name + ',').test(src),
        'API must expose ' + name));

/* ── 6. The intended behaviour inside Albania is documented ─────────────── */
const doc = read('ALBANIA_ASIG_LAYERS.md');
check(/inside Albania/i.test(doc), 'the docs still describe the in-country query');
check(/footprint|selected country|country gate/i.test(doc),
    'the docs must state that a tap outside the footprint / country does not query');

console.log('✓ one gated handler: suppressed / country / footprint / on-map layer');
console.log('✓ “active” means drawing now, not remembered in localStorage');
console.log('✓ Tirana answers; Cluj-Napoca, Bucharest, London, Athens do not');
console.log('\n' + checks + ' checks passed — a tap outside Albania no longer queries ASIG.');
