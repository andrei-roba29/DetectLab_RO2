// Regression: the 2D ⇄ 3D hand-off must not mirror the map.
//
// MapLibre's bearing is counter-clockwise from north; Leaflet's map pane is
// turned with CSS rotate(+deg), which is clockwise (js/map-rotate.js). The
// camera used to be copied across unconverted, so every trip into 3D and back
// flipped the rotation of the 2D map — and the LiDAR disc drawn on it swung
// about the pivot. This suite runs the REAL production functions from
// js/map3d-terrain.js in a sandbox and pins:
//
//   1. bearingFlip() is an involution that never returns −0;
//   2. cameraFrom2D() hands MapLibre the negated Leaflet bearing;
//   3. cameraTo2D() hands Leaflet the negated MapLibre bearing;
//   4. a round trip (2D → 3D → 2D) keeps the 2D bearing, for any gesture;
//   5. the public setBearing()/status() speak the 2D convention too;
//   6. the geometry really is mirrored without the flip (the premise).
//
// Usage: node test-map3d-bearing-handoff.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] 2D ⇄ 3D bearing hand-off does not mirror the map...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const viewer = read('js/map3d-terrain.js');

function grab(source, pattern, label) {
    const match = source.match(pattern);
    assert(match, 'production function is present: ' + label);
    return match[0];
}

const flipSrc = grab(viewer, /function bearingFlip\(deg\) \{[\s\S]*?\n {4}\}/, 'bearingFlip');
const fromSrc = grab(viewer, /function cameraFrom2D\(\) \{[\s\S]*?\n {4}\}/, 'cameraFrom2D');
const settleSrc = grab(viewer, /function settleLeafletMotion\(lmap\) \{[\s\S]*?\n {4}\}/, 'settleLeafletMotion');
const toSrc = grab(viewer, /function cameraTo2D\(\) \{[\s\S]*?\n {4}\}/, 'cameraTo2D');

/* A sandbox with a Leaflet stub (2D, clockwise) and a MapLibre stub (3D,
 * counter-clockwise). The 3D camera is whatever the test sets it to. */
function sandbox({ leafletBearing = 0, maplibreBearing = 0 } = {}) {
    const calls = [];
    const lmap = {
        _animatingZoom: false,
        getBearing() { return leafletBearing; },
        setBearing(deg, opts) { calls.push(['leaflet.setBearing', deg, opts]); leafletBearing = deg; },
        getCenter() { return { lat: 46.77, lng: 23.6 }; },
        getZoom() { return 15; },
        setView(latlng, zoom, opts) { calls.push(['leaflet.setView', latlng, zoom, opts]); },
        stop() {}
    };
    const map = {
        getCenter() { return { lng: 23.6, lat: 46.77 }; },
        getZoom() { return 15; },
        getBearing() { return maplibreBearing; }
    };
    const context = {
        CONFIG: { camera: { pitch: 62 } },
        map,
        leafletMap() { return lmap; },
        calls
    };
    vm.createContext(context);
    vm.runInContext(flipSrc + '\n' + fromSrc + '\n' + settleSrc + '\n' + toSrc +
        '\nthis.bearingFlip = bearingFlip; this.cameraFrom2D = cameraFrom2D; this.cameraTo2D = cameraTo2D;', context);
    return context;
}

// [1] the flip: an involution, never −0 ────────────────────────────────────
{
    const ctx = sandbox();
    assert.strictEqual(ctx.bearingFlip(30), -30);
    assert.strictEqual(ctx.bearingFlip(-30), 30);
    assert.strictEqual(ctx.bearingFlip(0), 0);
    assert(!Object.is(ctx.bearingFlip(0), -0), 'a zero bearing is +0, never −0');
    assert.strictEqual(ctx.bearingFlip(undefined), 0, 'a missing bearing is north');
    assert.strictEqual(ctx.bearingFlip('45'), -45, 'a numeric string is read as a number');
    for (const v of [-179, -90, -25, 0, 1, 33.5, 180]) {
        assert.strictEqual(ctx.bearingFlip(ctx.bearingFlip(v)), v || 0, 'flip(flip(' + v + ')) === ' + v);
    }
    console.log('✓ bearingFlip is an involution and never −0');
}

// [2] 2D → 3D: MapLibre receives the negated Leaflet bearing ────────────────
{
    for (const leaflet of [0, 30, -25, 90, -179]) {
        const ctx = sandbox({ leafletBearing: leaflet });
        const cam = ctx.cameraFrom2D();
        assert.strictEqual(cam.bearing, leaflet === 0 ? 0 : -leaflet,
            'Leaflet ' + leaflet + '° enters 3D as MapLibre ' + (-leaflet) + '°');
        assert.strictEqual(cam.center[0], 23.6);
        assert.strictEqual(cam.center[1], 46.77);
        assert.strictEqual(cam.zoom, 15);
    }
    console.log('✓ 2D → 3D hands MapLibre the negated bearing');
}

// [3] 3D → 2D: Leaflet receives the negated MapLibre bearing ────────────────
{
    for (const ml of [0, 40, -40, 120]) {
        const ctx = sandbox({ leafletBearing: 0, maplibreBearing: ml });
        ctx.cameraTo2D();
        const setBearing = ctx.calls.find(c => c[0] === 'leaflet.setBearing');
        assert(setBearing, 'the 2D bearing is written back');
        assert.strictEqual(setBearing[1], ml === 0 ? 0 : -ml,
            'MapLibre ' + ml + '° returns to 2D as Leaflet ' + (-ml) + '°');
        assert.strictEqual(setBearing[2].noMove, true, 'the bearing write stays silent (noMove)');
    }
    console.log('✓ 3D → 2D hands Leaflet the negated bearing');
}

// [4] round trip: 2D θ → 3D (untouched) → 2D θ ─────────────────────────────
{
    for (const theta of [0, 25, -25, 60, -135]) {
        const enter = sandbox({ leafletBearing: theta });
        const mlBearing = enter.cameraFrom2D().bearing;
        const back = sandbox({ leafletBearing: 0, maplibreBearing: mlBearing });
        back.cameraTo2D();
        const written = back.calls.find(c => c[0] === 'leaflet.setBearing')[1];
        assert.strictEqual(written, theta || 0, 'a 2D map at ' + theta + '° comes back at ' + theta + '°');
    }
    // A gesture in 3D: MapLibre turns to +40 (counter-clockwise), the 2D map
    // must come back turned the same way on screen, i.e. Leaflet −40.
    const gesture = sandbox({ leafletBearing: 0, maplibreBearing: 40 });
    gesture.cameraTo2D();
    assert.strictEqual(gesture.calls.find(c => c[0] === 'leaflet.setBearing')[1], -40);
    console.log('✓ a 2D → 3D → 2D round trip keeps the rotation; a 3D gesture carries back the right way');
}

// [5] the public API speaks the 2D convention ──────────────────────────────
{
    assert(/setBearing: function \(v\) \{ if \(map\) map\.setBearing\(bearingFlip\(v\)\); \}/.test(viewer),
        'the public setBearing(v) takes the 2D bearing and converts it');
    assert(/bearing: bearingFlip\(map\.getBearing\(\)\),\n\s+pitch: map\.getPitch\(\)/.test(viewer),
        'status().camera reports the 2D bearing');
    assert(!/lmap\.setBearing\(map\.getBearing\(\)/.test(viewer),
        'no raw MapLibre bearing is written into Leaflet any more');
    assert(!/bearing = lmap\.getBearing\(\) \|\| 0;/.test(viewer),
        'no raw Leaflet bearing is handed to MapLibre any more');
    console.log('✓ public setBearing()/status() and both hand-offs use the converted bearing');
}

// [6] the premise: without the flip the two engines disagree ───────────────
{
    // Leaflet (js/map-rotate.js): layerPoint → container point is rotatePoint(p, +deg),
    // i.e. the content turns CLOCKWISE on screen (y grows downwards).
    // MapLibre: the north vector is turned by −bearing in its rotation matrix,
    // i.e. COUNTER-CLOCKWISE for a positive bearing. Measured in the browser:
    // at +30° the 2D north point sits up-RIGHT (dx > 0) and the 3D north point
    // up-LEFT (dx < 0) when the number is copied unchanged.
    const rotate = (deg, x, y) => {
        const r = deg * Math.PI / 180;
        return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    };
    const north = [0, -1];
    const leafletNorth = rotate(30, north[0], north[1]);     // what Leaflet draws at +30°
    const maplibreNorth = rotate(-30, north[0], north[1]);   // what MapLibre draws at +30° (CCW)
    assert(leafletNorth[0] > 0 && maplibreNorth[0] < 0, 'the engines turn in opposite directions');
    // With the conversion, MapLibre's −30° and Leaflet's +30° draw north identically.
    const ctx = sandbox({ leafletBearing: 30 });
    // MapLibre draws north at rotate(−bearing): its camera bearing is the negation.
    const mlNorth = rotate(-ctx.cameraFrom2D().bearing, north[0], north[1]);
    assert(Math.abs(mlNorth[0] - leafletNorth[0]) < 1e-9 && Math.abs(mlNorth[1] - leafletNorth[1]) < 1e-9,
        'converted, the 3D north vector equals the 2D one');
    console.log('✓ the geometry: without the flip the north vectors are mirror images');
}

console.log('All bearing hand-off tests passed.');
