/*
 * test-analysis-layers-3d.js
 * ───────────────────────────────────────────────────────────────────────────
 * The four analysis layers the user reported as invisible in 3D — Battles,
 * Archeological Potential Sites, the Archeological Report results and the
 * LIDAR Scanner results — all paint their 2D geometry from a continuous ramp:
 * every sibling gets its own colour (score / epoch) and, for the potential
 * bubbles, its own radius. The 3D mirror merges siblings that share a paint
 * signature and caps the number of merged sources per group; with a signature
 * per sibling the cap was hit almost immediately and the rest were silently
 * dropped, so the 2D map looked full and the 3D view looked empty.
 *
 * This suite pins the three things that make them appear:
 *   1. bundleSiblings() merges by paint signature across the whole group, not
 *      only between consecutive siblings — A,B,A,B is two bundles, not four;
 *   2. the mirrored paint is quantised (colour channels, circle radius) so a
 *      continuous ramp collapses into a handful of bundles instead of one per
 *      sibling;
 *   3. the Archeological Potential heatmap — a hand-rolled L.Layer carrying a
 *      score raster — is classified as a heat layer and described from that
 *      raster, and its 2D ramp is handed to the 3D viewer.
 *
 * It also pins the dock/3D-switch collision: the analysis action button
 * (Scan / Detect / Generate report) is docked bottom-centre at z-index 1000
 * and covered the 3D switch at 960.
 *
 * No network, no browser. jsdom + the real Leaflet in the tree. Usage:
 *   node test-analysis-layers-3d.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

console.log('[Test] Analysis layers in 3D (battles / archeo potential / report / scanner)…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

/* ── the real Leaflet + the real mirror, in one jsdom context ───────────── */
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://detectlab.eu/'
});
vm.runInContext(read('js/leaflet.js'), dom.getInternalVMContext());
vm.runInContext(read('js/map3d-mirror.js'), dom.getInternalVMContext());

const L = dom.window.L;
const M = dom.window.DetectLabMirror;

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

assert.ok(L && L.version, 'Leaflet loaded');
assert.strictEqual(typeof M.collect, 'function', 'the mirror exposes collect()');
ok('Leaflet ' + L.version + ' and the 3D mirror load together');

/* ── a map stub that behaves like Leaflet for the walk ──────────────────── */
const PANE_Z = {
    pane_battles: 640, pane_battles_labels: 645,
    pane_archeo: 660, pane_archeo_heat: 656, pane_archeo_mask: 658,
    pane_archeo_pin: 665, overlayPane: 400
};
function makeMap(layers) {
    const set = new Set(layers);
    return {
        _layers: layers,
        getPane: (name) => (PANE_Z[name] === undefined ? null : { style: { zIndex: String(PANE_Z[name]) } }),
        hasLayer: (l) => set.has(l),
        eachLayer: (fn) => layers.forEach(fn),
        getLayer: () => null
    };
}
function summarise(layers) {
    const out = M.collect(makeMap(layers));
    const kinds = {};
    let features = 0;
    out.items.forEach((item) => {
        kinds[item.kind] = (kinds[item.kind] || 0) + 1;
        features += (item.geojson && item.geojson.features) ? item.geojson.features.length : 0;
    });
    return { out: out, kinds: kinds, features: features, items: out.items.length };
}

/* ── the real shapes these layers build ─────────────────────────────────── */

/* Battles: one zone circle + one divIcon label per event, coloured per epoch,
 * with the "context" events painted differently. */
const BATTLE_EPOCHS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d35400', '#16a085'];
function battlesGroup(events) {
    const group = L.layerGroup([], { pane: 'pane_battles' });
    for (let i = 0; i < events; i += 1) {
        const colour = BATTLE_EPOCHS[i % BATTLE_EPOCHS.length];
        const context = (i % 5 === 0);
        L.circle([45.5 + i * 0.05, 25.0], {
            pane: 'pane_battles', radius: context ? 26000 : 9000,
            color: context ? '#dfe6ee' : colour, weight: context ? 1.4 : 2.2,
            fillColor: colour, fillOpacity: context ? 0.12 : 0.30, interactive: true
        }).addTo(group);
        L.marker([45.5 + i * 0.05, 25.0], {
            pane: 'pane_battles_labels',
            icon: L.divIcon({ className: 'battles-label-anchor', html: 'x', iconSize: [0, 0] }),
            interactive: true
        }).addTo(group);
    }
    return group;
}

/* The Archeological Potential ramp, exactly as js/archeo-potential.js paints
 * it: score 0..1 → blue → green → yellow → red, one continuous colour. */
function scoreColorHex(score) {
    const stops = [[40, 90, 200], [40, 190, 120], [235, 200, 60], [220, 60, 50]];
    const t = Math.max(0, Math.min(1, score)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    const f = t - i;
    const a = stops[i], b = stops[i + 1];
    const hex = (v) => Math.round(v).toString(16).padStart(2, '0');
    return '#' + hex(a[0] + (b[0] - a[0]) * f) + hex(a[1] + (b[1] - a[1]) * f) + hex(a[2] + (b[2] - a[2]) * f);
}
const STYLE_TIERS = {
    high: { weight: 1.4, opacity: 0.95, fillOpacity: 0.55 },
    mid: { weight: 1.1, opacity: 0.90, fillOpacity: 0.42 },
    low: { weight: 0.8, opacity: 0.85, fillOpacity: 0.30 }
};
/* Bubbles: a continuous score ramp AND a continuous packing radius, so no two
 * siblings share a paint — the case that used to exhaust the merge budget. */
function bubbleGroup(count) {
    const group = L.layerGroup([]);
    for (let i = 0; i < count; i += 1) {
        const score = (i * 0.997) % 1;               /* deterministic ramp  */
        const tier = score > 0.66 ? 'high' : (score > 0.33 ? 'mid' : 'low');
        const style = STYLE_TIERS[tier];
        L.circle([45.4 + (i % 60) * 0.004, 25.0 + Math.floor(i / 60) * 0.004], {
            radius: 60 + ((i * 37) % 100) * 4.4,     /* 60…500 m, no repeats */
            color: scoreColorHex(score), weight: style.weight, opacity: style.opacity,
            fillColor: scoreColorHex(score), fillOpacity: style.fillOpacity,
            pane: 'pane_archeo', stroke: style.weight > 0.9
        }).addTo(group);
    }
    return group;
}

/* The score raster the heatmap is built from (buildHeatRaster's contract):
 * row 0 is the SOUTHERN edge (minLat), and bbox is the object form the real
 * grid carries — {minLat, maxLat, minLng, maxLng}. */
function heatRaster(cols, rows) {
    const values = new Float32Array(cols * rows);
    const valid = new Uint8Array(cols * rows);
    for (let i = 0; i < values.length; i += 1) {
        values[i] = (i % 97) / 97;
        valid[i] = (i % 3 === 0) ? 0 : 1;
    }
    return { cols: cols, rows: rows, values: values, base: values, valid: valid,
             cellM: 180, bbox: { minLat: 45.4, maxLat: 45.8, minLng: 25.0, maxLng: 25.4 } };
}

/* The real heatLayerProto contract from js/archeo-potential.js: an L.Layer
 * subclass exposing _raster + setRaster, with no leaflet.heat shape at all. */
const HeatLayerClass = L.Layer.extend({
    initialize: function (raster, options) {
        this.options = options || {};
        this._raster = raster || null;
    },
    onAdd: function (map) { this._map = map; },
    onRemove: function (map) { this._map = null; },
    setRaster: function (raster) { this._raster = raster || null; }
});

/* The same L.circle result set the LIDAR Scanner and the Archeological Report
 * draw for their findings. */
function resultGroup(count, varied) {
    const group = L.layerGroup();
    for (let i = 0; i < count; i += 1) {
        const options = {
            radius: varied ? 1200 + (i * 137) % 2000 : 3000,
            color: '#8cff66', weight: 1.6,
            fillColor: '#8cff66',
            fillOpacity: varied ? 0.2 + ((i * 11) % 8) / 40 : 0.25
        };
        L.circle([45.6 + i * 0.02, 25.2], options).addTo(group);
    }
    return group;
}

/* ══ 1. the four layers reach the 3D deck whole ═══════════════════════════ */

const BATTLE_EVENTS = 40;
let s = summarise([battlesGroup(BATTLE_EVENTS)]);
assert.strictEqual(s.features, BATTLE_EVENTS * 2,
    'Battles: every zone circle AND every label reaches 3D, got ' + s.features);
assert.ok(s.kinds.vector && s.kinds.markers, 'Battles: zones as vector, labels as markers');
assert.strictEqual(s.out.capped.length, 0, 'Battles: nothing dropped');
assert.strictEqual(s.out.unsupported.length, 0, 'Battles: nothing unsupported');
ok('Battles (' + BATTLE_EVENTS + ' events, ' + s.features + ' features) mirrors whole — ' +
   s.items + ' bundled sources, nothing dropped');

const BUBBLES = 200;
s = summarise([bubbleGroup(BUBBLES)]);
assert.strictEqual(s.features, BUBBLES,
    'Archeological Potential bubbles: every bubble reaches 3D, got ' + s.features);
assert.strictEqual(s.out.capped.length, 0,
    'Archeological Potential bubbles: nothing dropped (' + s.out.capped.join('; ') + ')');
ok('Archeological Potential bubbles (' + BUBBLES + ', continuous score + radius) mirror whole — ' +
   s.items + ' bundled sources');

s = summarise([resultGroup(30, false), resultGroup(30, true)]);
assert.strictEqual(s.features, 60,
    'Scanner + Report results: every circle reaches 3D, got ' + s.features);
assert.strictEqual(s.out.capped.length, 0, 'Scanner + Report results: nothing dropped');
ok('LIDAR Scanner + Archeological Report results (60 circles) mirror whole');

/* All four at once, as a busy 2D map would have them. */
s = summarise([
    battlesGroup(BATTLE_EVENTS),
    bubbleGroup(BUBBLES),
    heatRaster(80, 80) && (function () {
        const layer = new HeatLayerClass(heatRaster(80, 80), { opacity: 0.82 });
        return layer;
    })(),
    resultGroup(30, true)
]);
assert.strictEqual(s.out.capped.length, 0,
    'all four together: nothing dropped (' + s.out.capped.join('; ') + ')');
assert.ok(s.kinds.heat, 'all four together: the heatmap is mirrored as heat');
ok('All four layers together: ' + s.features + ' features in ' + s.items +
   ' sources, nothing dropped, heatmap included');

/* ══ 2. signature-keyed merging (not consecutive-only) ════════════════════ */
/* A,B,A,B with the same paints must collapse to ONE bundle, not four. */
function alternatingGroup() {
    const group = L.layerGroup([]);
    for (let i = 0; i < 8; i += 1) {
        L.circle([45.5 + i * 0.01, 25.0], {
            pane: 'pane_battles', radius: 9000,
            color: i % 2 ? '#2980b9' : '#c0392b', weight: 2.2,
            fillColor: i % 2 ? '#2980b9' : '#c0392b', fillOpacity: 0.30
        }).addTo(group);
    }
    return group;
}
s = summarise([alternatingGroup()]);
assert.strictEqual(s.features, 8, 'alternating paints: all 8 features kept');
assert.strictEqual(s.items, 2,
    'alternating paints merge into one bundle per signature (got ' + s.items + ')');
ok('bundleSiblings() merges by signature across the group: A,B,A,B → 2 bundles, not 4');

/* ══ 3. the heatmap mirrors from its raster, with the 2D ramp ═════════════ */

const HEAT_GRADIENT = { 0.00: '#10233f', 0.25: '#1f7fc4', 0.55: '#23c48e', 0.75: '#f2b134', 1.00: '#8b3ff0' };
const heatLayer = new HeatLayerClass(heatRaster(60, 60), {
    opacity: 0.82, gradient: HEAT_GRADIENT, radius: 90, max: 1
});
assert.strictEqual(M.classify(heatLayer, L), 'heat',
    'the raster heat layer is classified as heat, not unsupported');
ok('classify(): the Archeological Potential heat layer is a heat layer');

s = summarise([heatLayer]);
assert.strictEqual(s.kinds.heat, 1, 'the heat layer produces one heat item');
const heatItem = s.out.items[0];
const raster = heatRaster(60, 60);
/* A cell the raster scores 0 adds nothing to a heatmap, so only the valid
 * cells with a positive weight become points. */
let expectedPoints = 0;
for (let i = 0; i < raster.valid.length; i += 1) {
    if (raster.valid[i] && raster.values[i] > 0) expectedPoints += 1;
}
assert.strictEqual(heatItem.geojson.features.length, expectedPoints,
    'one point per scored grid cell, got ' + heatItem.geojson.features.length);
assert.ok(heatItem.heat && heatItem.heat.gradient, 'the 2D ramp is carried into 3D');
assert.deepStrictEqual(Object.keys(heatItem.heat.gradient).map(Number).sort((a, b) => a - b),
    [0, 0.25, 0.55, 0.75, 1], 'the ramp stops survive');
ok('heatDescriptor(): ' + expectedPoints + ' weighted points from the score raster, ramp ' +
   JSON.stringify(heatItem.heat.gradient));

/* The heat must land on the same cells the 2D canvas paints: row 0 is the
 * SOUTH edge of the grid (buildHeatRaster indexes row 0 at minLat), so the
 * first point, from row 0, sits near the bbox's south edge — never the north. */
const first = heatItem.geojson.features[0].geometry.coordinates;
assert.ok(first[1] > 45.4 && first[1] < 45.45,
    'row 0 maps to the south edge of the grid bbox, got lat ' + first[1]);
ok('heatDescriptor(): the grid is anchored the same way as the 2D raster (row 0 = south)');

/* Weights are normalised to 0..1 against the field peak. */
const weights = heatItem.geojson.features.map((f) => f.properties.w);
assert.ok(Math.max.apply(null, weights) === 1, 'the strongest cell weighs 1');
assert.ok(Math.min.apply(null, weights) >= 0, 'no negative weights');
ok('heatDescriptor(): weights normalised against the field peak');

/* leaflet.heat's own shape still works — the new branch must not shadow it.
 * Its layers either carry a _heat.draw contract or are tagged via
 * options._kind; both are covered. */
function pluginHeatLayer(options) {
    const Heat = L.Layer.extend({
        initialize: function (opts) { this._latlngs = [{ lat: 45.5, lng: 25.0, alt: 3 }]; this.options = opts || {}; },
        onAdd: function () {}, onRemove: function () {}
    });
    return new Heat(options);
}
const byKind = pluginHeatLayer({ _kind: 'heat' });
assert.strictEqual(M.classify(byKind, L), 'heat', 'options._kind=heat still classifies as heat');
const byDraw = pluginHeatLayer({});
byDraw._heat = { draw: function () {} };
assert.strictEqual(M.classify(byDraw, L), 'heat', 'the _heat.draw contract still classifies as heat');
ok('classify(): the leaflet.heat contracts still win for their own layers');

/* ══ 4. paint quantisation ═══════════════════════════════════════════════ */

/* 200 bubbles over a continuous ramp must NOT produce ~200 bundles: without
 * quantisation every sibling carried its own paint and exhausted the merge
 * budget. */
s = summarise([bubbleGroup(BUBBLES)]);
assert.ok(s.items * 2 <= BUBBLES,
    'a continuous ramp collapses into far fewer bundles than siblings (got ' +
    s.items + ' for ' + BUBBLES + ')');
assert.strictEqual(s.out.capped.length, 0, 'and nothing is dropped to achieve it');
ok('paint quantisation: ' + BUBBLES + ' ramp-coloured bubbles → ' + s.items +
   ' bundles (was one per sibling before, which exhausted the merge budget)');
/* Quantisation is coarse but never destructive: the paint stays exact, and the
 * banded copy exists only inside the merge signature. */
function mirrorPaint(options) {
    const layer = L.circle([45.5, 25.0], options);
    return M.collect(makeMap([L.layerGroup([layer])])).items[0];
}
const painted = mirrorPaint({
    radius: 421, color: '#285ac8', weight: 2.2,
    fillColor: '#285ac8', fillOpacity: 0.3
});
assert.strictEqual(painted.paints.circle['circle-color'], '#285ac8',
    'the mirrored colour is the layer\'s own colour, not a rounded one');
assert.strictEqual(painted.paints.circle['circle-radius'], 421,
    'the mirrored radius is the layer\'s own radius');
assert.ok(/circle-radius/.test(painted.sig),
    'the merge signature does band the radius, so near-equal radii merge');
assert.ok(!painted.sig.includes('"#285ac8"'),
    'the merge signature bands the colour, so ramp siblings merge');
ok('paint quantisation: the paint stays exact (#285ac8, 421 m); only the merge signature is banded');

/* An app brand colour must never be shifted by the mirror. */
const scanner = mirrorPaint({
    radius: 3000, color: '#39ff14', weight: 1.6,
    fillColor: '#39ff14', fillOpacity: 0.25
});
assert.strictEqual(scanner.paints.circle['circle-color'], '#39ff14',
    'the LIDAR Scanner green survives the trip into 3D unchanged');
assert.strictEqual(scanner.paints.circle['circle-radius'], 3000,
    'the Scanner result radius survives unchanged');
ok('paint quantisation leaves the app\'s own colours and radii untouched (#39ff14, 3000 m)');

/* The country-selection wash keeps its suppressed fill (an existing rule that
 * must survive the quantiser). */
const wash = mirrorPaint({
    pane: 'pane_country_bounds', color: '#2ecc71', weight: 2,
    fillColor: '#2ecc71', fillOpacity: 0.25
});
assert.strictEqual(wash.paints.fill['fill-opacity'], 0,
    'the country wash fill is still suppressed');
ok('paint quantisation keeps the country-wash suppression intact');

/* ══ 5. the dock no longer covers the 3D switch ═══════════════════════════ */

/* The switch left the bottom-centre column the dock (and the country “Exit
 * view” pill, the offline ✕ and the APM/zoom hints) occupies: it now heads the
 * map's bottom-left control column, directly above the base-layer button, so
 * the dock's 62px clearance can no longer collide with it and the switch no
 * longer reads --layer-dock-clearance. See MAP3D_SWITCH_BASE_LAYER_COLUMN.md. */
const toggleCss = read('css/map3d-terrain.css');
const toggleRule = toggleCss.slice(toggleCss.indexOf('.m3d-toggle-group {'));
assert.ok(/bottom:\s*var\(--m3d-anchor-bottom/.test(toggleRule),
    '#map3d-toggle is placed by the measured base-layer anchor');
assert.ok(!/--layer-dock-clearance/.test(toggleRule.slice(0, toggleRule.indexOf('}'))),
    'the switch no longer needs the dock clearance: it is not in the dock’s column');
ok('the 2D/3D switch sits in the bottom-left control column, out of the dock’s way');

const stylesCss = read('css/styles.css');
assert.ok(/--layer-dock-clearance:\s*62px/.test(stylesCss),
    'the dock still publishes its 62px clearance');
const dockInner = stylesCss.slice(stylesCss.indexOf('.layer-action-dock-inner {'));
assert.ok(/padding:\s*7px\s+9px/.test(dockInner), 'the dock inner keeps its 7px/9px padding');
assert.ok(/bottom:\s*calc\(18px\s*\+\s*env\(safe-area-inset-bottom/.test(
    stylesCss.slice(stylesCss.indexOf('.layer-action-dock {'))),
    'the dock still sits on its 18px offset');
ok('the dock geometry is unchanged: 18px offset + 7px padding over a 38px button (top ≈ 72px)');

/* The centred stack the dock lifts (APM help, zoom hints) still reads the
 * clearance; the switch is 10px in from the left edge and never under the dock. */
assert.ok(/bottom:\s*calc\(26px\s*\+\s*var\(--layer-dock-clearance/.test(stylesCss),
    'the centred APM help button still lifts by the dock clearance');
ok('the dock clearance still lifts the bottom-centre stack, which no longer holds the switch');

/* ══ 6. the source, not just the behaviour ════════════════════════════════ */

const mirrorSrc = read('js/map3d-mirror.js');
assert.ok(/var bySig = \{\}/.test(mirrorSrc), 'bundleSiblings keeps a signature pool');
assert.ok(!/var current = null;/.test(mirrorSrc), 'the consecutive-only "current" is gone');
assert.ok(/function rasterHeatPoints/.test(mirrorSrc), 'the raster heat bridge exists');
assert.ok(/layer\._raster && typeof layer\.setRaster === 'function'/.test(mirrorSrc),
    'isHeatLayer recognises the raster heat layer');
assert.ok(/PAINT_STEP/.test(mirrorSrc) && /RADIUS_BAND/.test(mirrorSrc),
    'the paint quantiser exists');
ok('js/map3d-mirror.js carries the signature pool, the raster heat bridge and the quantiser');

const potentialSrc = read('js/archeo-potential.js');
assert.ok(/gradient: HEAT_GRADIENT/.test(potentialSrc),
    'renderHeat() hands the 2D ramp to the 3D viewer');
ok('js/archeo-potential.js renderHeat() passes HEAT_GRADIENT through');

console.log('\n✅ Analysis layers in 3D: ' + passed + ' checks passed.');
