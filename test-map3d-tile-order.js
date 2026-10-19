'use strict';
/* ============================================================================
 * test-map3d-tile-order.js — the order MapLibre asks for tiles in
 * ----------------------------------------------------------------------------
 * Why this test exists
 *   MapLibre's `coveringTiles()` returns the tiles of the current view sorted
 *   by `distanceSq`, and `TileManager._updateRetainedTiles()` calls `_addTile`
 *   for each of them in that exact order — so that sort IS the network order.
 *   In the vendored 5.24.0 build the key compared the map centre in
 *   *nominal-zoom* tile units with a tile's own x/y at *its* zoom. Flat maps
 *   use one zoom level, so the comparison was harmless; a pitched or terrain
 *   view mixes zoom levels (z12 at the horizon, z18 under the camera), so every
 *   coarser tile got a meaningless distance and the load order depended on the
 *   location on Earth. That is the "the tiles that load first are in the
 *   distance / not in the point of view" report.
 *
 * What is checked
 *   1. The vendored bundle carries the fix (upstream maplibre/maplibre-gl-js
 *      #8494): tile centres are scaled to the nominal grid with a float power
 *      of two before the distance is taken.
 *   2. The *shipped minified expression* — extracted from js/maplibre-gl.js,
 *      not a copy — ranks a near z17 tile before a far z13 one, while the old
 *      expression ranked them the other way round.
 *   3. On a deterministic mixed-zoom set the shipped expression is monotonic
 *      in the true distance from the map centre (measured in one grid).
 *   4. The cache-busting tag and the shell cache point at the patched file, so
 *      an installed PWA picks it up instead of the bundle it cached before.
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');

const sdk = fs.readFileSync('js/maplibre-gl.js', 'utf8');
const registry = fs.readFileSync('js/layer-registry.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const TAG = '20261019-tile-order';

/* ── 1. the patch is present, and the old key is gone ─────────────────────── */
{
    assert(sdk.includes('DetectLab: coveringTiles nearest-first (upstream #8494)'),
        'the vendored SDK carries the documented coveringTiles patch');
    assert(sdk.includes('distanceSq:t.as([m[0]-(f+.5)*Math.pow(2,d-_.zoom),m[1]-(x+.5)*Math.pow(2,d-_.zoom)])'),
        'the distance is taken between scaled tile centres');
    assert(!sdk.includes('distanceSq:t.as([m[0]-.5-f,m[1]-.5-x])'),
        'the mixed-zoom distance (a tile\'s own x/y against a nominal-zoom centre) is gone');
    assert.strictEqual((sdk.match(/distanceSq:/g) || []).length, 1,
        'there is exactly one coveringTiles sort key in the bundle');
    /* The bundle must still load after the edit (and stay the version the
     * registry/notes were written against). */
    const sdkModule = require('./js/maplibre-gl.js');
    assert.strictEqual(sdkModule.getVersion(), '5.24.0',
        'the patched bundle loads and reports the vendored version');
    console.log('  ✓ the vendored MapLibre carries the coveringTiles ordering fix');
}

/* ── 2. execute the shipped expression, not a re-implementation ───────────── */
const marker = 'distanceSq:';
const start = sdk.indexOf(marker);
const end = sdk.indexOf(',tileDistanceToCamera', start);
assert(start !== -1 && end > start, 'the coveringTiles sort key is extractable');
const expression = sdk.slice(start + marker.length, end);
/* The bundle's locals, named as they are in the minified function:
 *   m = centre point in NOMINAL-zoom tile units
 *   f = tile x, x = tile y (both at the tile's own zoom)
 *   d = nominal zoom, _ = the stack entry ({zoom})
 *   t.as = vec2.sqrLen                                                  */
const distanceSq = new Function('m', 'f', 'x', 'd', '_', 't', 'return ' + expression);
const t = { as: (pair) => pair[0] * pair[0] + pair[1] * pair[1] };
const key = (tile, nominalZ, centre) =>
    distanceSq(centre, tile.x, tile.y, nominalZ, { zoom: tile.z }, t);

/* The old key, for the comparison: centre in nominal units against the tile's
 * raw x/y at its own zoom. */
const oldKey = (tile, centre) =>
    t.as([centre[0] - 0.5 - tile.x, centre[1] - 0.5 - tile.y]);

/* A pitched view: the camera sits at nominal z16. The tile under the camera is
 * a z17 tile (close, magnified); the horizon is covered by a z13 tile that is
 * far away. Both are on screen at the same time. */
const NOMINAL = 16;
const CENTRE = [32768, 32768];
const near = { z: 17, x: 65538, y: 65538 };   /* ~1.5 nominal tiles from centre */
const far = { z: 13, x: 4104, y: 4104 };      /* ~68 nominal tiles from centre  */

assert(oldKey(far, CENTRE) < oldKey(near, CENTRE),
    'the old key sorted the far, coarse tile first — the reported symptom');
assert(key(near, NOMINAL, CENTRE) < key(far, NOMINAL, CENTRE),
    'the shipped key sorts the near, fine tile first');
console.log('  ✓ near z17 is requested before far z13 (the old key did the opposite)');

/* ── 3. monotonic in the true distance on a mixed-zoom set ────────────────── */
{
    /* Deterministic spread of tiles around the centre, z12–z18 — the range a
     * 62° pitched terrain view produces. All coordinates are at the tile's own
     * zoom, exactly what coveringTiles hands to the sort key. */
    const tiles = [];
    for (let z = 12; z <= 18; z += 1) {
        const span = Math.pow(2, z);
        const base = Math.floor(span / 2);
        for (let dx = -2; dx <= 2; dx += 1) {
            for (let dy = -2; dy <= 2; dy += 1) {
                tiles.push({ z, x: base + dx * (z >= 16 ? 3 : 1), y: base + dy * (z >= 16 ? 3 : 1) });
            }
        }
    }
    const trueDistance = (tile) => {
        const scale = Math.pow(2, NOMINAL - tile.z);
        const cx = (tile.x + 0.5) * scale;
        const cy = (tile.y + 0.5) * scale;
        return Math.hypot(CENTRE[0] - cx, CENTRE[1] - cy);
    };
    const shipped = tiles.slice().sort((a, b) => key(a, NOMINAL, CENTRE) - key(b, NOMINAL, CENTRE));
    for (let i = 1; i < shipped.length; i += 1) {
        const previous = trueDistance(shipped[i - 1]);
        const current = trueDistance(shipped[i]);
        assert(current + 1e-6 >= previous,
            'shipped order is monotonic in true distance (' + previous + ' → ' + current + ')');
    }
    /* And the old key was dominated by zoom, not distance: its first tile is
     * coarser than its last, which cannot happen on a distance sort. */
    const legacy = tiles.slice().sort((a, b) => oldKey(a, CENTRE) - oldKey(b, CENTRE));
    assert(legacy[0].z < legacy[legacy.length - 1].z,
        'the old key was dominated by the zoom level, not by distance');
    console.log('  ✓ the shipped key is ordered by distance across z12–z18');
}

/* ── 4. cache busting ─────────────────────────────────────────────────────── */
{
    assert(registry.includes("js: 'js/maplibre-gl.js?v=" + TAG + "'"),
        'the registry loads the patched SDK with a new tag');
    assert(sw.includes("'js/maplibre-gl.js?v=" + TAG + "'"),
        'the service worker pre-caches the patched SDK under the new tag');
    const cacheVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    assert(cacheVersion >= 228,
        'the app-shell cache is bumped so an installed PWA replaces the old bundle (found v' + cacheVersion + ')');
    console.log('  ✓ the SDK is cache-busted for the web and for installed PWAs');
}

console.log('\n✅ test-map3d-tile-order.js passed: MapLibre requests the tiles under the camera first.');
