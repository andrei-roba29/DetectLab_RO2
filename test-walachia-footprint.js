#!/usr/bin/env node
/* Valahia 1855-1859 (premium.walachia-1855) — footprint and tile retry.
 *
 * The Supabase bucket Harti/charta holds the Szathmári sheet as a complete
 * pyramid over one rectangle (z0–14). Every tile outside it is a 404, and the
 * availability guard reads a 404 as a failed service ("Harta nu poate fi
 * încărcată"). The layer must therefore request only tiles inside the sheet,
 * and a failed tile must be retried before it counts. See
 * ROMANIA_HIST_MAP_COVERAGE.md ("Valahia tile footprint"). */
const assert = require('assert');
const fs = require('fs');
const read = p => fs.readFileSync(p, 'utf8');
const app = read('js/map-app.js');
const html = read('index.html');
const sw = read('sw.js');

/* Per-zoom tile ranges of Harti/charta/{z}/{x}/{y}.png, read from
 * storage.objects (every range is a full rectangle, so the pyramid is
 * complete inside it). */
const STORAGE_INDEX = {
  0: [0, 0, 0, 0], 1: [1, 1, 0, 0], 2: [2, 2, 1, 1], 3: [4, 4, 2, 2],
  4: [8, 9, 5, 5], 5: [17, 18, 11, 11], 6: [35, 37, 22, 23], 7: [71, 74, 45, 46],
  8: [143, 148, 91, 93], 9: [287, 296, 182, 187], 10: [575, 592, 364, 374],
  11: [1150, 1185, 729, 749], 12: [2301, 2370, 1459, 1498],
  13: [4602, 4741, 2919, 2997], 14: [9205, 9483, 5839, 5994]
};

/* ── 1. The bounds in the layer are the sheet, rounded inward ────────── */
const boundsLit = app.match(/var WALACHIA_BOUNDS = L\.latLngBounds\(\[\[([\d.]+), ([\d.]+)\], \[([\d.]+), ([\d.]+)\]\]\);/);
assert(boundsLit, 'WALACHIA_BOUNDS is defined in js/map-app.js');
const [south, west, north, east] = boundsLit.slice(1).map(Number);

const tileLon = (x, z) => x / 2 ** z * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / 2 ** z)) * 180 / Math.PI;
const [x0, x1, y0, y1] = STORAGE_INDEX[14];
const exactW = tileLon(x0, 14), exactE = tileLon(x1 + 1, 14);
const exactN = tileLat(y0, 14), exactS = tileLat(y1 + 1, 14);
assert(west >= exactW && west - exactW < 1e-5, 'west edge sits on the sheet edge (rounded inward)');
assert(east <= exactE && exactE - east < 1e-5, 'east edge sits on the sheet edge (rounded inward)');
assert(north <= exactN && exactN - north < 1e-5, 'north edge sits on the sheet edge (rounded inward)');
assert(south >= exactS && south - exactS < 1e-5, 'south edge sits on the sheet edge (rounded inward)');

/* Leaflet's LatLngBounds.overlaps() is strict: a tile is requested only when
 * it overlaps the layer bounds. Check every zoom: all sheet tiles overlap,
 * and the ring of tiles just outside the sheet does not. */
function overlaps(tile, z) {
  const w = tileLon(tile.x, z), e = tileLon(tile.x + 1, z);
  const n = tileLat(tile.y, z), s = tileLat(tile.y + 1, z);
  return e > west && w < east && n > south && s < north;
}
for (const z of Object.keys(STORAGE_INDEX).map(Number)) {
  const [ax0, ax1, ay0, ay1] = STORAGE_INDEX[z];
  for (let x = ax0; x <= ax1; x++) {
    for (let y = ay0; y <= ay1; y++) {
      assert(overlaps({ x, y }, z), `sheet tile ${z}/${x}/${y} is requested`);
    }
  }
  const outside = [
    { x: ax0 - 1, y: ay0 }, { x: ax1 + 1, y: ay0 },
    { x: ax0, y: ay0 - 1 }, { x: ax0, y: ay1 + 1 }
  ];
  for (const t of outside) {
    assert(!overlaps(t, z), `off-sheet tile ${z}/${t.x}/${t.y} is NOT requested (it would 404)`);
  }
}

/* The coverage rectangle of the row (premiumMapCoverageBounds, drawn as the red
 * “where is this map” polygon) and the viewport region use the same footprint,
 * and the rectangle is no longer suppressed. */
const coverageEntry = app.match(/walachia: \{\n[\s\S]*?bounds: \[\[([\d.]+), ([\d.]+)\], \[([\d.]+), ([\d.]+)\]\],\n\s*label: 'Valahia 1855-1859',\n\s*layerVar: '_walachiaMapLayer'\n(\s*)\}/);
assert(coverageEntry, 'premiumMapCoverageBounds.walachia has the footprint and no noCoverageRect');
assert.deepStrictEqual(coverageEntry.slice(1, 5).map(Number), [south, west, north, east], 'coverage rectangle is the sheet footprint');
const viewport = app.match(/walachia: \{ RO: \{ bounds: \[\[([\d.]+), ([\d.]+)\], \[([\d.]+), ([\d.]+)\]\], minShare: 0\.55 \} \}/);
assert(viewport, 'PREMIUM_VIEWPORT_REGIONS.walachia is defined');
assert.deepStrictEqual(viewport.slice(1, 5).map(Number), [south, west, north, east], 'viewport region is the sheet footprint');

/* The layer keeps zooms 0–20 and the bounds option (passed through
 * DL.tile2dOptions, which copies extra options onto the Leaflet layer). */
const valahia = app.slice(app.indexOf('// Valahia 1855-1859 — XYZ tiles'), app.indexOf('// ── HARTA TRANSILVANIEI 1859'));
assert(/DL\.tile2dOptions\('premium\.walachia-1855', \{[^}]*minZoom: 0, maxZoom: 20, bounds: WALACHIA_BOUNDS \}/.test(valahia),
  'walachia layer is created with bounds: WALACHIA_BOUNDS');

/* ── 2. The retry wrapper: a failed tile is retried before it counts ─── */
const wrapperSrc = app.slice(app.indexOf('function withTileRetry'), app.indexOf("map.createPane('pane_walachia')", app.indexOf('function withTileRetry')));
assert(wrapperSrc.length > 100, 'withTileRetry is defined before the pane is created');
function fakeLayer(timers) {
  const layer = {
    _map: {},
    calls: [],
    getTileUrl: () => 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/charta/14/9205/5839.png',
    createTile(coords, done) {          // stand-in for L.TileLayer.prototype.createTile
      const tile = { src: this.getTileUrl(coords) };
      this.calls.push(tile.src);
      this._done = done;
      this._tile = tile;
      return tile;
    }
  };
  return layer;
}
function setup(delays) {
  const timers = [];
  const window = { setTimeout: (fn, ms) => timers.push({ fn, ms }) };
  const factory = new Function('window', wrapperSrc + '\nreturn withTileRetry;');
  const wrap = factory(window);
  const layer = wrap(fakeLayer(timers), delays);
  return { layer, timers };
}

/* Failure, retry 1 (700 ms), failure, retry 2 (1.8 s), failure → counted once. */
{
  const { layer, timers } = setup([700, 1800]);
  const results = [];
  layer.createTile({ x: 9205, y: 5839, z: 14 }, (err, tile) => results.push(err ? 'err' : 'ok'));
  layer._done('err1', layer._tile);
  assert.deepStrictEqual(results, [], 'the first failure is not reported yet');
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(timers[0].ms, 700);
  timers.shift().fn();
  assert(layer._tile.src.endsWith('.png?_dl_retry=1'), 'retry 1 uses a fresh URL');
  layer._done('err2', layer._tile);
  assert.deepStrictEqual(results, [], 'the second failure is not reported yet');
  timers.shift().fn();
  assert(layer._tile.src.endsWith('.png?_dl_retry=2'), 'retry 2 uses a fresh URL');
  layer._done('err3', layer._tile);
  assert.deepStrictEqual(results, ['err'], 'after the retries are used up the failure is reported once');
  assert.strictEqual(timers.length, 0, 'no further retries are scheduled');
}

/* A tile that recovers on retry is reported as loaded, not as an error. */
{
  const { layer, timers } = setup([700, 1800]);
  const results = [];
  layer.createTile({ x: 9205, y: 5839, z: 14 }, (err) => results.push(err ? 'err' : 'ok'));
  layer._done('blip', layer._tile);
  timers.shift().fn();
  layer._done(null, layer._tile);
  assert.deepStrictEqual(results, ['ok'], 'a tile that loads on retry counts as a success');
  assert.strictEqual(timers.length, 0);
}

/* ── 3. Shipped: the new script tag and service-worker entry ─────────── */
assert(html.includes('<script src="js/map-app.js?v=20261101-walachia-coverage"></script>'));
assert(sw.includes("'js/map-app.js?v=20261101-walachia-coverage'"));
assert(html.includes('js/wms-health.js?v=20261114-hosted-no-trip') && sw.includes("'js/wms-health.js?v=20261114-hosted-no-trip'"));
assert(read('js/wms-health.js').includes("'DetectLab hosted map data (Supabase)'") && !read('js/wms-health.js').includes('Finnish layer data (Supabase)'));
assert(sw.includes("const CACHE_NAME = 'detectlab-v363-romania-train-only';"));

console.log('Valahia 1855-1859 footprint and tile-retry checks passed.');
