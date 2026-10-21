'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync('js/map3d-terrain.js', 'utf8');
const loader = source.slice(source.indexOf('    function loadMapLibre()'), source.indexOf('    /* ═', source.indexOf('    function loadMapLibre()')));
async function testLoader(failures) {
    let scripts = 0, removed = 0, styles = 0;
    const nodes = {};
    const root = {
        setTimeout(fn, ms) { return setTimeout(fn, ms === 500 ? 0 : ms); }, clearTimeout
    };
    const head = {
        appendChild(node) {
            node.parentNode = head;
            if (node.id) { nodes[node.id] = node; styles++; return; }
            scripts++;
            queueMicrotask(() => {
                if (scripts <= failures) node.onerror();
                else { root.maplibregl = { Map() {} }; node.onload(); }
            });
        }, removeChild() { removed++; }
    };
    const ctx = vm.createContext({ root, document: { head, createElement() { return {}; }, getElementById(id) { return nodes[id]; } },
        REGISTRY: { config() { return { maplibre: { js: 'sdk.js', css: 'sdk.css' } }; } },
        isMobile() { return false; }, MAPLIBRE: null, sdkPromise: null });
    vm.runInContext(loader, ctx);
    const first = ctx.loadMapLibre();
    assert.strictEqual(ctx.loadMapLibre(), first, 'concurrent callers share the download');
    if (failures > 1) {
        await assert.rejects(first);
        assert.strictEqual(ctx.sdkPromise, null);
        failures = 0;
        await ctx.loadMapLibre();
    } else await first;
    assert.strictEqual(styles, 1, 'retry does not duplicate CSS');
    assert.strictEqual(removed, scripts, 'settled scripts are detached');
}
async function testCountryRace() {
    let resolveSDK, constructions = 0, failures = 0;
    const sdk = new Promise(resolve => { resolveSDK = resolve; });
    const state = { open: false, healthTimers: [] };
    const noop = () => {};
    const ctx = vm.createContext({ state, map: null, openGeneration: 0,
        wrapper: () => true, ensureSurface: noop, ensureBar: noop, ensureToggle: noop,
        document: { body: { classList: { add: noop } }, addEventListener: noop },
        refreshToggle: noop, queueAnchorSync: noop, showVeil: noop, t: x => x,
        webglProbe: () => ({ webgl2: true }), loadMapLibre: () => sdk,
        registerProtocols: noop, REGISTRY: { config: () => ({}) },
        focusCamera: x => x, cameraFrom2D: noop, deviceProfile: () => ({}),
        buildMapOptions: noop, watchContextLoss: noop, watchResume: noop, refreshBarCopy: noop, root: { setTimeout: () => 1 },
        fail3D() { failures++; }, console });
    const start = source.indexOf('    function openNow()');
    vm.runInContext(source.slice(start, source.indexOf('\n    /**', start)), ctx);
    const old = ctx.openNow();
    // Country switching closes the old view before opening the new one.
    ctx.openGeneration++;
    state.open = false;
    const current = ctx.openNow();
    resolveSDK({ Map: function () {
        constructions++;
        this.touchZoomRotate = { enableRotation: noop };
        this.on = noop;
    } });
    assert.strictEqual(await old, false);
    assert.strictEqual(await current, true);
    assert.strictEqual(constructions, 1, 'only the current country creates a map');
    assert.strictEqual(failures, 0);
}
(async () => {
    await testLoader(0);
    await testLoader(1);
    await testLoader(2);
    await testCountryRace();
    console.log('PASS: SDK retries, cleanup, shared downloads and country-switch race');
})().catch(error => { console.error(error); process.exitCode = 1; });
