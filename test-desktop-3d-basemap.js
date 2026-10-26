'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('js/map3d-terrain.js', 'utf8');
const code = source.slice(source.indexOf('    function desktopBasemapDefs()'), source.indexOf('    /* ═', source.indexOf('    function plan()')));
let selected = 'imagery', mobile = false;
const defs = Object.fromEntries(['imagery', 'topographic', 'terrain-base', 'terrain-relief'].map(k => ['base.' + k, { id: 'base.' + k, base: true }]));
const context = {
    root: { getArcgisBasemap: () => selected }, isMobile: () => mobile,
    REGISTRY: { get: id => defs[id], config: () => ({}) },
    state: { mirror: { items: [
        { key: 'old-topo', kind: 'raster', pane: 'pane_satellite', defId: 'base.topographic', z: 398 },
        { key: 'overlay', kind: 'raster', pane: 'pane_history', z: 640 }
    ], unsupported: [] } },
    lidarFilter: () => () => true,
    activeRegistryFallbacks: () => [defs['base.topographic']],
    mirroredBaseItem: () => ({ key: 'old-topo' }), map: null
};
vm.createContext(context);
vm.runInContext(code, context);
for (const key of ['imagery', 'topographic', 'terrain', 'imagery']) {
    selected = key;
    const plan = context.plan();
    const expected = key === 'terrain' ? ['base.terrain-base', 'base.terrain-relief'] : ['base.' + key];
    assert.deepStrictEqual(Array.from(plan.entries.filter(e => e.def).map(e => e.id)), expected);
    assert(plan.entries.some(e => e.id === 'm3d-2d-overlay'), 'overlay retained');
    assert(!plan.entries.some(e => e.id === 'm3d-2d-old-topo'), 'stale mirror basemap excluded');
    assert.strictEqual(plan.baseEntryId, expected.at(-1));
}
mobile = true;
assert(context.plan().entries.some(e => e.id === 'm3d-2d-old-topo'), 'mobile keeps existing mirror path');
console.log('Desktop 3D basemap regression tests passed');
