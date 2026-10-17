/*
 * test-archeo-3d-projection.js
 * ───────────────────────────────────────────────────────────────────────────
 * The Archeological Potential Sites output (bubbles or heatmap, plus the red
 * exclusion mask) must reach the 3D view as what it is on the 2D map:
 *
 *   • bubbles  → ground circles in METRES (a 420 m bubble is a 420 m disc, not
 *                a 420-pixel dot), coloured by score, with the 2D popup;
 *   • heatmap  → the same colourised score raster as a PNG image, north-up,
 *                draped over the terrain at the grid's geographic corners;
 *   • mask     → the red UAT built-up areas and the 700 m protection rings as
 *                ground shapes, without a generic property popup;
 *   • nothing is lost to the 3D deck budget: the 2D children of the groups are
 *                not mirrored a second time, and the Leaflet canvas renderers
 *                are plumbing, not layers.
 *
 * It runs the REAL js/archeo-potential.js, js/leaflet.js and js/map3d-mirror.js
 * in one jsdom window, on the same synthetic scenario as bench-archeo-coverage.js.
 * No network, no browser. Usage:
 *   node test-archeo-3d-projection.js        (needs jsdom, as test-analysis-layers-3d.js)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

console.log('[Test] Archeological Potential Sites in 3D (bubbles / heatmap / mask)…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="map" style="width:800px;height:600px"></div></body></html>', {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://detectlab.eu/',
    virtualConsole: new VirtualConsole()
});
const ctx = dom.getInternalVMContext();
const w = dom.window;

/* jsdom has no 2D canvas. Leaflet's canvas renderers and the heatmap raster
 * need one: a context that records putImageData (so the north-up check can read
 * the pixels) and no-ops everything else. */
const noop = () => {};
w.HTMLCanvasElement.prototype.getContext = function () {
    const canvas = this;
    const base = {
        globalAlpha: 1,
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
        putImageData(img) { canvas.lastImage = img.data; },
        clearRect: noop, drawImage: noop, save: noop, restore: noop
    };
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
};
w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,iVBORw0KGgo='; };

vm.runInContext(read('js/leaflet.js'), ctx);
vm.runInContext(read('js/map3d-mirror.js'), ctx);
const L = w.L;
const M = w.DetectLabMirror;

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

assert.ok(L && L.version, 'Leaflet loaded');
assert.ok(M && typeof M.collect === 'function', 'mirror loaded');

/* ── the same UAT + site scenario as bench-archeo-coverage.js ───────────── */
w._currentLang = () => 'en';
w._localLayerData = {};
const TILE = 256;
const tileData = new Uint8ClampedArray(TILE * TILE * 4);
for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 4;
        const free = x >= TILE / 2;                 // west half built-up, east half free
        tileData[i] = free ? 40 : 0; tileData[i + 1] = 0;
        tileData[i + 2] = free ? 40 : 120; tileData[i + 3] = free ? 255 : 0;
    }
}
w._uatGetTile = () => Promise.resolve({ data: tileData, size: TILE });
w._UAT_TILE_UNREADABLE = { unreadable: true };
w.UAT_TILE_Z = 14;

vm.runInContext(read('js/archeo-potential.js'), ctx);
const D = w._archeoPotentialDebug;
assert.ok(D && typeof D.renderField === 'function', 'archeo-potential debug API present');

const map = L.map(w.document.getElementById('map'), { center: [46.8, 23.6], zoom: 11, preferCanvas: true });
w._dlMap = map;

const features = [];
let fid = 1;
[[-0.018, -0.018], [0.018, -0.018], [-0.018, 0.018], [0.018, 0.018]].forEach(([dl, dc], ci) => {
    for (let j = 0; j < 4; j++) {
        const a = (j / 4) * Math.PI * 2;
        features.push({
            id: fid++,
            geometry: { type: 'Point', coordinates: [23.6 + dl + 0.0022 * Math.cos(a), 46.8 + dc + 0.0022 * Math.sin(a)] },
            properties: { NUMESIT: 'C' + ci + '_' + j, COORD: 'DA' }
        });
    }
});
w._localLayerData = { 0: { features }, 5: { features: [] }, 6: { features: [] } };

/* ── geometry helpers ───────────────────────────────────────────────────── */
function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371008.8, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function ringCentre(ring) {
    // the first 32 vertices are the circle; the centre is their mean
    const pts = ring.slice(0, -1);
    return { lng: pts.reduce((s, p) => s + p[0], 0) / pts.length, lat: pts.reduce((s, p) => s + p[1], 0) / pts.length };
}
function deck() { return M.collect(map, {}); }
function byLabel(out, label) { return out.items.filter((it) => it.kind === 'vector' && it.label === label); }

const BUBBLE_LABEL = 'Archeological Potential Sites';
const MASK_LABEL = 'Archeological exclusion (red)';

(async () => {
    const field = await w.computeArcheoPotentialField(46.8, 23.6, 4000, { mode: 'bubbles', skipDataWait: true });
    assert.ok(field.bubbles.length > 50, 'the scenario yields a real bubble field (' + field.bubbles.length + ')');
    w.toggleArcheoPotentialLayer(true);

    /* ══ 1. bubbles: ground circles in metres, one bundled source ═══════════ */
    D.setOutputMode('bubbles');
    D.renderField(field);
    let out = deck();

    assert.strictEqual(out.capped.length, 0, 'bubble mode: nothing dropped from the 3D deck (' + out.capped.join('; ') + ')');
    assert.strictEqual(out.unsupported.length, 0, 'bubble mode: nothing reported as unsupported (' + out.unsupported.join('; ') + ')');
    ok('bubble mode: the whole output reaches the 3D deck, nothing dropped, nothing unsupported');

    const bubbleItems = byLabel(out, BUBBLE_LABEL);
    assert.strictEqual(bubbleItems.length, 1, 'the bubble map is ONE 3D source, got ' + bubbleItems.length);
    const bfeat = bubbleItems[0].geojson.features;
    const polys = bfeat.filter((f) => f.geometry.type === 'Polygon');
    assert.strictEqual(polys.length, field.bubbles.length + 1, 'one ground polygon per bubble + the search circle');
    assert.ok(bubbleItems[0].perFeature, 'the bubble source paints per feature (score colour per bubble)');
    ok('bubble mode: ' + field.bubbles.length + ' bubbles + the search circle form ONE 3D source (per-feature paint)');

    // Every bubble's ring is a disc of the bubble's own radius in metres — not
    // a circle of that many pixels. Check the ring against its own centre.
    const sorted = field.bubbles.slice().sort((a, b) => a.radiusM - b.radiusM);
    const sample = [sorted[0], sorted[Math.floor(sorted.length / 2)], sorted[sorted.length - 1]];
    sample.forEach((c) => {
        const idx = field.bubbles.indexOf(c);
        const poly = polys[idx + 1] || null;            // +1: the search circle comes first
        assert.ok(poly, 'bubble ' + idx + ' has a polygon');
        const ring = poly.geometry.coordinates[0];
        const dists = ring.slice(0, -1).map((p) => haversineM(c.lat, c.lng, p[1], p[0]));
        const mean = dists.reduce((s, d) => s + d, 0) / dists.length;
        assert.ok(Math.abs(mean - c.radiusM) / c.radiusM < 0.01,
            'bubble radius ' + c.radiusM + ' m is a ' + c.radiusM + ' m ground circle, measured ' + mean.toFixed(1) + ' m');
        const cen = ringCentre(ring);
        assert.ok(haversineM(c.lat, c.lng, cen.lat, cen.lng) < c.radiusM * 0.01 + 1, 'the ring is centred on the bubble');
    });
    ok('bubble ground circles match their radius in metres (' + sample.map((c) => Math.round(c.radiusM) + ' m').join(', ') + ' within 1 %)');

    const dotBubbles = bfeat.filter((f) => f.geometry.type === 'Point' && f.properties.radius !== 4);
    assert.strictEqual(dotBubbles.length, 0, 'no bubble is still a pixel-sized point');
    ok('no bubble is left as a pixel-radius point (the old 420-px dot)');

    const popups = bfeat.filter((f) => f.geometry.type === 'Polygon' && /★/.test(f.properties.popup || ''));
    assert.strictEqual(popups.length, field.bubbles.length, 'every bubble keeps its star-rating popup in 3D');
    ok('every bubble keeps its 2D popup (star rating + distance) in 3D');

    const colours = new Set(bfeat.filter((f) => f.geometry.type === 'Polygon').map((f) => f.properties.fillColor));
    assert.ok(colours.size > 1, 'bubbles are coloured by score, not one colour');
    const someBubble = field.bubbles[0];
    // polys[0] = search circle, polys[1 + i] = bubble i
    assert.strictEqual(polys[1].properties.fillColor, D.styleFor(someBubble.score).fillColor,
        'the bubble colour is the 2D colour for its score');
    ok('bubble colours come from the same score ramp as 2D (' + colours.size + ' distinct colours)');

    /* ══ 2. the red mask: ground shapes, no generic popup ═══════════════════ */
    const maskItems = byLabel(out, MASK_LABEL);
    assert.strictEqual(maskItems.length, 1, 'the red mask is ONE 3D source');
    const mfeat = maskItems[0].geojson.features;
    const siteRing = mfeat.find((f) => f.properties.kind === 'exclusion' && f.properties.opacity === 0.6);
    assert.ok(siteRing, 'site protection rings exist in 3D');
    const siteR = (D.config.SITE_RADIUS_M + D.config.SITE_BUFFER_M);
    const sc = ringCentre(siteRing.geometry.coordinates[0]);
    const measured = haversineM(sc.lat, sc.lng, siteRing.geometry.coordinates[0][0][1], siteRing.geometry.coordinates[0][0][0]);
    assert.ok(Math.abs(measured - siteR) / siteR < 0.01, 'protection ring is ' + siteR + ' m, measured ' + measured.toFixed(1));
    ok('red protection rings are ' + siteR + ' m ground circles (not 700-px dots)');

    assert.ok(mfeat.every((f) => f.properties.kind === 'exclusion'), 'every mask shape is tagged as a popup-less exclusion');
    const uat = mfeat.filter((f) => f.properties.opacity === 0);
    assert.ok(uat.length > 0, 'UAT built-up rectangles are present (no outline)');
    ok('red mask: ' + mfeat.length + ' ground shapes (UAT built-up areas + protection rings)');

    /* ══ 3. the 2D children are not mirrored a second time ═════════════════ */
    const layerGroup = (function () {
        let found = null;
        map.eachLayer((l) => { if (l._dl3dFeatures && l.options && l.options.name === BUBBLE_LABEL) found = l; });
        return found;
    })();
    assert.ok(layerGroup, 'the bubble group is on the map');
    let childCount = 0, unflagged = 0;
    layerGroup.eachLayer((child) => { childCount += 1; if (!child._dl3dSkip) unflagged += 1; });
    assert.ok(childCount > field.bubbles.length, 'the 2D group holds the bubbles (' + childCount + ' children)');
    assert.strictEqual(unflagged, 0, 'every 2D child of the bubble group is flagged _dl3dSkip');
    // And the map-level copies of those children are not in the deck either.
    assert.strictEqual(out.items.filter((it) => it.kind === 'vector' && it.label === 'archeo').length, 0,
        'no per-bubble item is in the deck');
    ok('the 2D children (' + childCount + ') are skipped: they reach 3D only through the one ground source');

    /* ══ 4. heatmap mode: the score raster as a north-up draped image ═══════ */
    D.setOutputMode('heat');
    D.renderField(field);
    out = deck();
    assert.strictEqual(out.capped.length, 0, 'heat mode: nothing dropped from the 3D deck');
    assert.strictEqual(out.unsupported.length, 0, 'heat mode: nothing reported as unsupported');
    const images = out.items.filter((it) => it.kind === 'image');
    assert.strictEqual(images.length, 1, 'the heatmap is ONE image item, got ' + images.length);
    const img = images[0];
    assert.ok(/^data:image\/png/.test(img.url), 'the heatmap is a PNG data URL');
    const b = field.grid.bbox;
    // JSON, not deepStrictEqual: the array was built inside the jsdom realm.
    assert.strictEqual(JSON.stringify(img.coordinates), JSON.stringify([
        [b.minLng, b.maxLat], [b.maxLng, b.maxLat], [b.maxLng, b.minLat], [b.minLng, b.minLat]
    ]), 'the picture is pinned to the grid corners (NW, NE, SE, SW)');
    assert.strictEqual(img.opacity, D.config.HEAT.OPACITY, 'the heatmap keeps its 2D opacity');
    ok('heat mode: one draped PNG image on the grid corners, at the 2D opacity (' + img.opacity + ')');

    assert.strictEqual(byLabel(out, BUBBLE_LABEL)[0].geojson.features.filter((f) => f.geometry.type === 'Polygon').length, 1,
        'heat mode: only the search circle is a ground polygon (bubbles are not drawn)');
    ok('heat mode hides the bubbles, as 2D does');

    /* north-up: the picture's first row is the grid's NORTHERN row */
    const raster = D.buildHeatRaster(field);
    const heatLayer = (function () {
        let found = null;
        map.eachLayer((l) => { if (l._raster && typeof l._dl3dImage === 'function') found = l; });
        return found;
    })();
    assert.ok(heatLayer, 'the heat layer is on the map');
    const src = heatLayer._srcCanvas;
    assert.ok(src && src.lastImage, 'the heatmap picture was painted');
    const rowBytes = raster.cols * 4;
    const pictureRow = (r) => Array.from(src.lastImage.subarray(r * rowBytes, (r + 1) * rowBytes));
    const gridRow = (r) => Array.from(raster.rgba.subarray(r * rowBytes, (r + 1) * rowBytes));
    let flippedMatches = 0, unflippedMatches = 0;
    for (let r = 0; r < raster.rows; r++) {
        if (JSON.stringify(pictureRow(r)) === JSON.stringify(gridRow(raster.rows - 1 - r))) flippedMatches++;
        if (JSON.stringify(pictureRow(r)) === JSON.stringify(gridRow(r))) unflippedMatches++;
    }
    assert.strictEqual(flippedMatches, raster.rows,
        'every picture row is the grid row with the same index counted from the NORTH (' + flippedMatches + '/' + raster.rows + ')');
    assert.ok(unflippedMatches < raster.rows, 'the check is meaningful: the un-flipped grid would NOT match');
    ok('the picture is north-up: its top row is the grid row at maxLat (row 0 of the grid is the south edge)');

    /* ══ 5. switching back to bubbles re-renders the bubble source ═══════════ */
    D.setOutputMode('bubbles');
    D.renderField(field);
    out = deck();
    assert.strictEqual(byLabel(out, BUBBLE_LABEL)[0].geojson.features.filter((f) => f.geometry.type === 'Polygon').length,
        field.bubbles.length + 1, 'switching back to bubbles restores every bubble in 3D');
    assert.strictEqual(out.items.filter((it) => it.kind === 'image').length, 0, 'the heat picture is removed in bubble mode');
    ok('switching Heatmap → Bubbles re-renders 3D (bubbles back, picture removed)');

    /* ══ 6. off means off ═════════════════════════════════════════════════ */
    w.toggleArcheoPotentialLayer(false);
    out = deck();
    assert.strictEqual(out.items.filter((it) => /Archeolog/.test(it.label || '')).length, 0,
        'switching the layer off removes it from 3D');
    ok('switching the layer off removes all of it from 3D');

    /* ══ 7. the mirror: a raster heat layer with the object bbox still works ═ */
    const RasterHeat = L.Layer.extend({
        initialize: function (r) { this._raster = r; this.options = {}; },
        setRaster: function (r) { this._raster = r; },
        onAdd: function () {}, onRemove: function () {}
    });
    const plainHeat = new RasterHeat(raster);
    const plainOut = M.collect(map, {});
    assert.ok(M.classify(plainHeat, L) === 'heat', 'a raster heat layer without the picture hook is still a heat layer');
    const probe = M.describe(plainHeat, map, {});
    assert.ok(probe && probe.kind === 'heat' && probe.geojson.features.length > 0,
        'the object-shaped grid bbox yields weighted heat points (was: silently none)');
    ok('mirror: the raster heat contract accepts the real object bbox (' + probe.geojson.features.length + ' weighted points)');
    void plainOut;

    /* ══ 8. source checks: the bridges are wired where the 3D view reads them ═ */
    const terrainSrc = read('js/map3d-terrain.js');
    assert.ok(/props\.kind === 'exclusion'/.test(terrainSrc), 'terrain: mask shapes do not open a generic popup');
    const mirrorSrc = read('js/map3d-mirror.js');
    assert.ok(/_dl3dSkip/.test(mirrorSrc) && /function isRenderer/.test(mirrorSrc),
        'mirror: _dl3dSkip and the renderer filter exist');
    assert.ok(/layer\._dl3dImage\(\)/.test(mirrorSrc), 'mirror: the picture hook is read');
    ok('terrain + mirror carry the bridges (popup guard, _dl3dSkip, renderer filter, picture hook)');

    console.log('\n✅ Archeological Potential Sites in 3D: ' + passed + ' checks passed.');
    process.exit(0);
})().catch((e) => {
    console.error('\n❌ ' + (e && e.stack || e));
    process.exit(1);
});
