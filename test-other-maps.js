#!/usr/bin/env node
'use strict';

/* Behavioural checks for the “Alte hărți / Other maps” sub-layer.
 *
 * Run with:  node test-other-maps.js
 *
 * Covers, without touching the network:
 *   1. js/other-maps-tiles.js  — the Hungaricana ECW tile hash (both readings
 *      of dezoomify's note), the pyramid level maths and the URL builders;
 *   2. js/other-maps-overlay.js — the pure transform maths: pyramid level
 *      choice, on-screen size and the inverse transform that decides which
 *      tiles to fetch for a rotated, scaled, moved sheet;
 *   3. data/other-maps-catalog.json — every record is usable;
 *   4. the clustering contract: the dots must group EXACTLY like the
 *      Patrimoniu sites (same helper, same config, same distances);
 *   5. js/other-maps.js — a group of sheets on one place opens the list, a
 *      group spread over the map zooms in instead.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let checks = 0;
function ok(condition, message) {
    assert.ok(condition, message);
    checks++;
}
function eq(actual, expected, message) {
    assert.strictEqual(actual, expected, message);
    checks++;
}

/* ── sandbox ─────────────────────────────────────────────────────────── */
function storageStub(initial) {
    const map = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k)
    };
}

/* The browser's WebCrypto, backed by node's crypto, so the module under test
 * runs the very same AES-128-CBC call it will run in the page. */
function webCryptoStub() {
    return {
        subtle: {
            importKey: (format, key, algorithm, extractable, usages) =>
                Promise.resolve({ format, key, algorithm, usages }),
            encrypt: (algorithm, key, data) => {
                const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key.key), Buffer.alloc(16));
                return Promise.resolve(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
            }
        }
    };
}

const sandbox = {
    console,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    Promise,
    isFinite,
    TextEncoder,
    Uint8Array,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearInterval: () => {},
    setInterval: () => 0,
    localStorage: storageStub(),
    crypto: webCryptoStub(),
    document: { readyState: 'loading', addEventListener: () => {}, documentElement: { lang: 'ro' } }
};
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(relative) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, relative), 'utf8'), sandbox, { filename: relative });
}

load('js/patrimoniu-clustering.js');
load('js/other-maps-tiles.js');
load('js/other-maps-overlay.js');
load('js/other-maps.js');

const Clustering = sandbox.DetectLabPatrimoniuClustering;
const Tiles = sandbox.DetectLabOtherMapsTiles;
const Overlay = sandbox.DetectLabOtherMapsOverlay;
const OtherMaps = sandbox.DetectLabOtherMaps;

/* ══ 1. tile hashes ═══════════════════════════════════════════════════ */
(async function run() {
    // dezoomify's issue #346 gives one worked example: path
    // maps/mol/s012/div13/s12_div_xiii_0031/s12_div_xiii_0031.ecw (sum 4952),
    // tile x=5, y=5, z=10, ciphertext 67d1e405cb7b1eeb04cabffd9be3596c…
    const samplePath = 'maps/mol/s012/div13/s12_div_xiii_0031/s12_div_xiii_0031.ecw';
    const asZxy = await Tiles.tileUrl.call(null, samplePath, 5, 5, 10);
    Tiles.noteOrder('xyz');
    const asXyz = await Tiles.tileUrl(samplePath, 5, 5, 10);
    Tiles.noteOrder('zxy');

    eq(path.basename(asXyz), '67d1e405cb7b1eeb04cabffd9be3596c',
        'the |x|y|z reading reproduces the hash published in dezoomify #346');
    ok(/^[0-9a-f]{32}$/.test(path.basename(asZxy)),
        'the |z|x|y reading produces a well-formed 32-char hash');
    ok(asZxy !== asXyz, 'the two hash orders really do differ');
    ok(asZxy.startsWith('https://static-cdn.hungaricana.hu/tile/image/' + samplePath + '/'),
        'the tile URL keeps the ECW path and only hashes the coordinates');

    // Tiles for the same sheet at different levels/columns must differ.
    const tileA = await Tiles.tileUrl(samplePath, 0, 0, 3);
    const tileB = await Tiles.tileUrl(samplePath, 1, 0, 3);
    const tileC = await Tiles.tileUrl(samplePath, 0, 0, 4);
    ok(tileA !== tileB && tileA !== tileC, 'each (x, y, z) is a different tile');

    // The hash is stable: asking twice must not change the answer.
    eq(await Tiles.tileUrl(samplePath, 2, 1, 3), await Tiles.tileUrl(samplePath, 2, 1, 3),
        'the hash is deterministic');

    eq(Tiles.thumbUrl(samplePath),
        'https://static-cdn.hungaricana.hu/tile/thumb/' + samplePath,
        'thumbnails need no hash');
    eq(Tiles.recordUrl('MOLTerkeptar/2146'),
        'https://maps.hungaricana.hu/en/MOLTerkeptar/2146/view/',
        'the record URL points at the human-readable page');
    eq(Tiles.maxZoomFor(512, 512), 0, 'a 512 px sheet has a single level');
    eq(Tiles.maxZoomFor(513, 400), 1, 'just over 512 px needs level 1');
    eq(Tiles.maxZoomFor(8192, 4096), 4, 'an 8192 px sheet tops out at level 4');

    /* ══ 2. transform maths ═══════════════════════════════════════════ */
    eq(Math.round(Overlay.resolutionAt(0, 0)), 156543, 'z0 at the equator: 156543 m per pixel');
    ok(Overlay.resolutionAt(0, 10) < Overlay.resolutionAt(0, 9),
        'zooming in shrinks the metres covered by one pixel');
    ok(Overlay.resolutionAt(60, 10) < Overlay.resolutionAt(0, 10),
        'the same zoom covers fewer metres per pixel away from the equator');

    eq(Overlay.normalizeDegrees(370), 10, '370° normalises to 10°');
    eq(Overlay.normalizeDegrees(-190), 170, '-190° normalises to 170°');
    eq(Overlay.snapDegrees(89.5), 90, 'a hair below 90° snaps to 90°');
    eq(Overlay.snapDegrees(80), 80, 'a genuine 80° is left alone');

    // A 10 000 × 7 000 px sheet, 1 m per pixel → 10 km wide on the ground.
    const plan = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 1, maxZoom: 5 });
    ok(plan.level >= 0 && plan.level <= 5, 'the pyramid level stays inside the pyramid');
    ok(Math.abs(plan.k - plan.dW / plan.wL) < 1e-9, 'k is exactly on-screen width / level width');
    ok(plan.dW > 0 && plan.dH > 0, 'the sheet has a positive on-screen size');
    ok(Math.abs(plan.dW / plan.dH - 10000 / 7000) < 1e-6, 'the aspect ratio is preserved');

    // A tiny scale must not pick a level above the pyramid's top…
    const tiny = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 0.02, maxZoom: 5 });
    eq(tiny.level, 0, 'the smallest scale clamps to the pyramid root');
    const huge = Overlay.planGeometry({ lat: 47, zoom: 14, w: 10000, h: 7000, mpp: 400, maxZoom: 5 });
    eq(huge.level, 5, 'the largest scale clamps to the deepest level');

    // …and the visible tile window must always contain every tile the
    // viewport actually looks at — that is the whole point of the inverse
    // transform, and it has to hold at any rotation.
    function coversViewport(geom, anchor, rotationDeg, topLeft, bottomRight) {
        const range = Overlay.visibleTileRange(geom, anchor, rotationDeg, topLeft, bottomRight);
        const theta = rotationDeg * Math.PI / 180;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);
        const corners = [
            [topLeft.x, topLeft.y], [bottomRight.x, topLeft.y],
            [bottomRight.x, bottomRight.y], [topLeft.x, bottomRight.y]
        ];
        return corners.every(([x, y]) => {
            const dx = x - anchor.x;
            const dy = y - anchor.y;
            const lx = (cos * dx + sin * dy) / geom.k + geom.wL / 2;
            const ly = (-sin * dx + cos * dy) / geom.k + geom.hL / 2;
            const tx = Math.floor(lx / Overlay.tileSize);
            const ty = Math.floor(ly / Overlay.tileSize);
            return tx >= range.x0 && tx <= range.x1 && ty >= range.y0 && ty <= range.y1;
        });
    }
    const viewport = { topLeft: { x: 0, y: 0 }, bottomRight: { x: 1200, y: 800 } };
    const centred = Overlay.planGeometry({ lat: 47, zoom: 12, w: 4000, h: 3000, mpp: 40, maxZoom: 4 });
    ok(coversViewport(centred, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 0)');
    ok(coversViewport(centred, { x: 600, y: 400 }, 90, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 90°)');
    ok(coversViewport(centred, { x: 600, y: 400 }, 37, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation 37°)');
    ok(coversViewport(centred, { x: 600, y: 400 }, -128, viewport.topLeft, viewport.bottomRight),
        'the tile window covers the viewport (rotation -128°)');
    // A sheet drawn entirely inside the viewport asks for all of its tiles.
    const inside = Overlay.planGeometry({ lat: 47, zoom: 12, w: 4000, h: 3000, mpp: 1, maxZoom: 4 });
    const insideRange = Overlay.visibleTileRange(inside, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight);
    eq(insideRange.x0, 0, 'a fully visible sheet starts at tile column 0');
    eq(insideRange.x1, inside.cols - 1, 'a fully visible sheet ends at its last column');
    eq(insideRange.y0, 0, 'a fully visible sheet starts at tile row 0');
    eq(insideRange.y1, inside.rows - 1, 'a fully visible sheet ends at its last row');

    const small = Overlay.planGeometry({ lat: 47, zoom: 16, w: 4000, h: 3000, mpp: 0.05, maxZoom: 4 });
    const smallRange = Overlay.visibleTileRange(small, { x: 600, y: 400 }, 0, viewport.topLeft, viewport.bottomRight);
    ok(smallRange.x0 >= 0 && smallRange.x1 < small.cols, 'the window never leaves the tile grid');
    ok(smallRange.x1 >= smallRange.x0 && smallRange.y1 >= smallRange.y0, 'the window is not inverted');

    const offscreen = Overlay.visibleTileRange(small, { x: 60000, y: 40000 }, 0, viewport.topLeft, viewport.bottomRight);
    ok(offscreen.x0 >= 0 && offscreen.x1 < small.cols, 'a sheet far outside the view still yields a legal window');

    /* ══ 3. the catalogue ═════════════════════════════════════════════ */
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/other-maps-catalog.json'), 'utf8'));
    ok(Array.isArray(catalog.maps) && catalog.maps.length > 0, 'the catalogue has records');
    ok(catalog.tileBase && catalog.thumbBase, 'the catalogue names its endpoints');

    const ids = new Set();
    catalog.maps.forEach((entry) => {
        ok(entry.id, 'record has an id');
        ok(!ids.has(entry.id), 'id ' + entry.id + ' is unique');
        ids.add(entry.id);
        ok(/^[a-z0-9/._-]+\.ecw$/i.test(entry.path), entry.id + ' carries an ECW path');
        ok(entry.lat > 40 && entry.lat < 52, entry.id + ' sits at a plausible central-European latitude');
        ok(entry.lng > 12 && entry.lng < 30, entry.id + ' sits at a plausible central-European longitude');
        ok(entry.place, entry.id + ' names a place');
    });

    /* ══ 4. clustering — identical to Patrimoniu ══════════════════════ */
    const config = Clustering.CONFIG;
    eq(config.minZoom, 6, 'the shared config starts clustering at z6');
    eq(config.disableClusteringAtZoom, 11, 'the shared config stops clustering at z11');
    eq(Clustering.getDistanceKm(6, config), 5, 'z6 groups within 5 km');
    eq(Clustering.getDistanceKm(10, config), 1, 'z10 groups within 1 km');
    eq(Clustering.getDistanceKm(11, config), 0, 'z11 groups nothing');

    const index = new Clustering.SpatialIndex(config.indexCellSizeM);
    const records = catalog.maps.map((entry) => ({
        id: entry.id,
        lat: entry.lat,
        lng: entry.lng,
        latlng: { lat: entry.lat, lng: entry.lng },
        place: entry.place
    }));

    // Sheets of one place share one point → they become ONE location, so the
    // map never stacks identical dots on top of each other.
    const locations = OtherMaps.groupByPlace(records);
    ok(locations.length < records.length, 'co-located sheets are merged into places');
    ok(locations.every((loc) => loc.count >= 1 && loc.sheets.length === loc.count),
        'every location counts its sheets');
    locations.forEach((loc) => index.add(loc));

    const maramures = locations.filter((l) => /Maramure/i.test(l.place || ''));
    ok(maramures.length >= 1 && maramures[0].count > 3, 'the Maramureș sheets share one dot');
    const grouped = Clustering.clusterRecords(maramures, 11, index, config);
    eq(grouped.length, 1, 'one place is one dot even with clustering disabled');

    // At country scale, places hundreds of km apart stay separate…
    const worldView = Clustering.clusterRecords(locations, 6, index, config);
    ok(worldView.length > 1, 'distant places stay separate at z6');
    // …and the dots that are single places open the sheet list when tapped.
    const singles = worldView.filter((cluster) => OtherMaps.isLocationCluster(cluster));
    ok(singles.length >= 1, 'at least one z6 dot is a single place');

    // Two places 1.4 km apart: one dot at z6 (5 km), two pins at z11 (1 km).
    const near = OtherMaps.groupByPlace([
        { id: 'a', lat: 47.000, lng: 23.000, place: 'A' },
        { id: 'b', lat: 47.010, lng: 23.010, place: 'B' }
    ]);
    const nearIndex = new Clustering.SpatialIndex(config.indexCellSizeM);
    near.forEach((loc) => nearIndex.add(loc));
    eq(Clustering.clusterRecords(near, 6, nearIndex, config).length, 1, '1.4 km apart: one dot at z6');
    const splitNear = Clustering.clusterRecords(near, 11, nearIndex, config);
    eq(splitNear.length, 2, '1.4 km apart: two pins at z11');
    ok(!OtherMaps.isLocationCluster(Clustering.clusterRecords(near, 6, nearIndex, config)[0]),
        'a group of two places is geographic, so a tap zooms in');
    ok(OtherMaps.isLocationCluster(splitNear[0]),
        'a single place is a location, so a tap opens the sheet list');

    /* ══ 5. labels ════════════════════════════════════════════════════ */
    ok(OtherMaps.t('om_add').length > 0, 'the Romanian table is used when the page is Romanian');
    eq(OtherMaps.formatMeters(0.42), '0.42 m', 'sub-metre widths read in metres');
    eq(OtherMaps.formatMeters(2500), '2.50 km', 'kilometre widths read in km');
    const limits = Overlay.limits;
    eq(OtherMaps.sliderFromMppLimits(limits.mppMin, limits), 0, 'the scale slider starts at the minimum');
    eq(OtherMaps.sliderFromMppLimits(limits.mppMax, limits), 1000, 'the scale slider ends at the maximum');

    console.log('✓ other-maps: ' + checks + ' checks passed ' +
        '(' + catalog.maps.length + ' catalogue records, ' + locations.length + ' places)');
})().catch((err) => {
    console.error('✗ other-maps test failed:', err && err.message);
    process.exit(1);
});
