import test from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../functions/_shared/map3d-tile.mjs';
import { map3dCountryTileUrl, moduleModes } from '../functions/_shared/map3d-country-urls.mjs';
import { countryModuleScope } from '../netlify/lib/map3d-country-modules.mjs';

const LAYER_IDS = [
  'lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt', 'lidar.es-mdt',
  'lidar.ch-swisstopo', 'lidar.uk-ea', 'lidar.dk-dhm', 'lidar.se-lantmateriet'
];
const TILES = [[6, 32, 21], [10, 533, 351], [15, 16600, 10800]];

// Differentially test the Cloudflare-only adapters against the existing
// Netlify VM that executes the real browser modules and shared registry.
test('Cloudflare Map3D URL adapters exactly match the original module builders', () => {
  const modules = countryModuleScope();
  for (const id of LAYER_IDS) {
    const def = registry.get(id);
    assert.ok(def, `registry layer ${id}`);
    const original = modules[def.builder.module];
    assert.ok(original, `Netlify VM loaded ${def.builder.module}`);
    const modes = original.modeKeys();
    assert.deepEqual(Array.from(moduleModes(id)), Array.from(modes), `${id} mode order`);
    for (const mode of modes) {
      for (const [z, x, y] of TILES) {
        const expected = registry.tileUrlAt(def, z, x, y, { modules, mode });
        const actual = map3dCountryTileUrl(id, { z, x, y, mode });
        assert.equal(actual, expected, `${id} mode=${mode} z/x/y=${z}/${x}/${y}`);
      }
    }
  }
});

test('unknown modes retain each original module builder default', () => {
  const modules = countryModuleScope();
  for (const id of LAYER_IDS) {
    const def = registry.get(id);
    const mode = modules[def.builder.module].modeKeys()[0];
    const expected = registry.tileUrlAt(def, 11, 1023, 705, { modules, mode: 'not-a-real-mode' });
    const actual = map3dCountryTileUrl(id, { z: 11, x: 1023, y: 705, mode: 'not-a-real-mode' });
    assert.equal(actual, expected, `${id} mode fallback`);
  }
});
