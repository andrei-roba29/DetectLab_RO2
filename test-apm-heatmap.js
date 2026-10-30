#!/usr/bin/env node
'use strict';
// Pure score-display and highest-only contour checks. No DOM or network dependencies.
const assert = require('node:assert/strict');
const heat = require('./js/apm-next/apm-heatmap.js');
const polygons = require('./js/apm-next/apm-polygonise.js');
const core = require('./js/apm-next/apm-core.js');
const thresholds = { medium: 0.55, high: 0.7, veryhigh: 0.85 };
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
const grid = (w, h) => ({ w, h, west: 20, north: 50, dLon: .01, dLat: .01 });

test('continuous ramp is anchored to model thresholds, not the minimum/maximum in this run', () => {
    const ramp = heat.stops(thresholds);
    assert.deepEqual(heat.colourAt(.55, ramp), [53, 198, 180]);
    assert.deepEqual(heat.colourAt(.7, ramp), [255, 200, 87]);
    assert.deepEqual(heat.colourAt(.85, ramp), [255, 99, 61]);
    assert.notDeepEqual(heat.colourAt(.71, ramp), heat.colourAt(.72, ramp));
    const raster = heat.buildRaster(new Float32Array([.4, .41]), grid(2, 1), thresholds);
    assert.ok(raster.rgba[0] < 100, 'an all-low window is not stretched to hot colours');
    const tied = heat.stops({ medium: .5, high: .5, veryhigh: 1 });
    assert.ok(heat.colourAt(.5, tied).every(Number.isFinite));
});
test('invalid scores are transparent; a valid zero score remains visible', () => {
    const raster = heat.buildRaster(new Float32Array([NaN, -1, Infinity, 0]), grid(4, 1), thresholds);
    assert.deepEqual([raster.rgba[3], raster.rgba[7], raster.rgba[11], raster.rgba[15]], [0, 0, 0, 180]);
});
test('display raster is bounded and preserves geographic extent; masking affects opacity, not score', () => {
    const g = grid(2048, 1024), scores = new Float32Array(g.w * g.h).fill(.9);
    const raster = heat.buildRaster(scores, g, thresholds);
    assert.equal(raster.w, 512); assert.equal(raster.h, 256);
    assert.equal(raster.rgba.byteLength, 512 * 256 * 4);
    assert.equal(raster.w * raster.dLon, g.w * g.dLon);
    assert.equal(raster.h * raster.dLat, g.h * g.dLat);
    const partial = heat.buildRaster(new Float32Array([NaN, .9, NaN, .9]), grid(2, 2), thresholds, 1);
    assert.equal(partial.rgba[3], 90);
    assert.deepEqual([...partial.rgba.slice(0, 3)], heat.colourAt(new Float32Array([.9])[0], heat.stops(thresholds)));
});
test('geographic lookup uses north-first pixel centres; no-data interpolation does not darken the heat', () => {
    const raster = { ...grid(2, 2), rgba: new Uint8Array([255, 0, 0, 180, 0, 0, 0, 0, 0, 0, 255, 180, 0, 255, 0, 180]) };
    let pixel = new Uint8Array(4);
    heat.sampleRGBA(raster, 20.005, 49.995, pixel, 0);
    assert.deepEqual([...pixel], [255, 0, 0, 180]);
    pixel = new Uint8Array(4);
    heat.sampleRGBA(raster, 20.01, 49.995, pixel, 0);
    assert.equal(pixel[0], 255); assert.ok(Math.abs(pixel[3] - 90) <= 1);
    pixel = new Uint8Array(4);
    heat.sampleRGBA(raster, 21, 50, pixel, 0);
    assert.equal(pixel[3], 0);
});
test('only the very-high threshold creates output polygons; lower classes still have raster areas', () => {
    const g = grid(60, 60), scores = new Float32Array(g.w * g.h);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) scores[j * g.w + i] = Math.max(0, 1 - Math.hypot(i - 30, j - 30) / 25);
    const full = polygons.polygonise(scores, g, thresholds, { minAreaM2: 0, smoothIters: 0 });
    assert.equal(new Set(full.features.map(f => f.properties.class)).size, 3, 'legacy helper still supports all classes');
    const hotspots = polygons.polygonise(scores, g, thresholds, { highestOnly: true, minAreaM2: 0, smoothIters: 0 });
    assert.ok(hotspots.features.length > 0);
    assert.ok(hotspots.features.every(f => f.properties.class === 'veryhigh'));
    assert.deepEqual(hotspots.features, full.features.filter(f => f.properties.class === 'veryhigh'));
    const areas = polygons.areaByScores(scores, g, thresholds);
    assert.ok(areas.medium > 0 && areas.high > 0 && areas.veryhigh > 0);
});
test('no highest-potential region never promotes lower scores to polygons, even if heat is visible', () => {
    const g = grid(20, 20), scores = new Float32Array(400).fill(.75);
    assert.equal(polygons.polygonise(scores, g, thresholds, { highestOnly: true }).features.length, 0);
    assert.ok(heat.buildRaster(scores, g, thresholds).rgba.some((v, i) => i % 4 === 3 && v > 0));
    assert.equal(polygons.polygonise(new Float32Array(400).fill(.99), g, thresholds, { highestOnly: true, minAreaM2: 1e12 }).features.length, 0);
});
test('class area is counted on valid full-resolution score cells independently of contour filtering', () => {
    const g = grid(4, 1), scores = new Float32Array([.6, .75, .9, NaN]);
    const areas = polygons.areaByScores(scores, g, thresholds);
    const mpd = core.metresPerDegree(49.995), expected = g.dLon * mpd.lon * g.dLat * mpd.lat / 1e6;
    for (const id of ['medium', 'high', 'veryhigh']) assert.ok(Math.abs(areas[id] - expected) < 1e-8);
});
console.log(`\n${passed} passed`);
