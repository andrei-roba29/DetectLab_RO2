'use strict';
// Run: node test-map3d-premium.js
// Exercise the shipped entitlement, UI, entry gate and SDK race functions.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const read = file => fs.readFileSync(file, 'utf8');
const source = read('js/map3d-terrain.js');
const subscriptions = read('js/subscriptions.js');
function extract(text, name) {
    const match = text.match(new RegExp('    function ' + name + '\\([^]*?\\n    \\}'));
    assert(match, 'missing production function: ' + name);
    return match[0];
}
const functions = ['hasPremiumAccess', 'syncPremiumAccess', 'refreshToggle', 'open', 'openNow', 'toggle', 'runEntryGate', 'setEntryGate'];
const listenerStart = source.indexOf('    // Auth resolves after this module');
const listenerEnd = source.indexOf('    /* ── boot:', listenerStart);
assert(listenerStart > 0 && listenerEnd > listenerStart);
function setup() {
    let user = null, sdkLoads = 0, constructions = 0, closes = 0, resolveSDK;
    let deferredSDK = null;
    const windowEvents = {}, documentEvents = {}, intervals = [];
    const noop = () => {};
    const button = { attributes: {}, querySelector: () => ({}), setAttribute(k, v) { this.attributes[k] = v; } };
    const ctx = vm.createContext({
        Date, Promise, console, state: { open: false, healthTimers: [] }, map: null,
        toggleBtn: button, toggleGroup: { hidden: false }, refreshBtn: null, refreshJob: null,
        openGeneration: 0, wrapper: () => true, ensureSurface: noop, ensureBar: noop,
        ensureToggle: noop, queueAnchorSync: noop, showVeil: noop, t: key => key,
        webglProbe: () => ({ webgl2: true }), registerProtocols: noop,
        REGISTRY: { config: () => ({}) }, focusCamera: noop, cameraFrom2D: noop,
        deviceProfile: () => ({}), buildMapOptions: noop, watchContextLoss: noop,
        watchResume: noop, settleOpeningView: noop, refreshBarCopy: noop,
        pushError: noop, fail3D: error => { throw error; },
        currentUser: () => user,
        close() { closes++; ctx.state.open = false; ctx.map = null; ctx.openGeneration++; },
        document: { hidden: false, body: { classList: { add: noop } },
            addEventListener(type, handler) { documentEvents[type] = handler; } },
        root: { setTimeout: () => 1,
            addEventListener(type, handler) { windowEvents[type] = handler; },
            setInterval(handler, delay) { intervals.push({ handler, delay }); },
            _authReadyPromise: Promise.resolve() },
        loadMapLibre() {
            sdkLoads++;
            const sdk = { Map: function () { constructions++; this.on = noop; } };
            return deferredSDK ? deferredSDK.then(() => sdk) : Promise.resolve(sdk);
        }
    });
    vm.runInContext(extract(subscriptions, 'isPremium'), ctx);
    ctx.root._dlIsPremium = ctx.isPremium;
    vm.runInContext(functions.map(name => extract(source, name)).join('\n') + '\n' + source.slice(listenerStart, listenerEnd), ctx);
    return {
        ctx, button, windowEvents, documentEvents, intervals,
        setUser(value) { user = value; },
        counts() { return { sdkLoads, constructions, closes }; },
        deferSDK() { deferredSDK = new Promise(resolve => { resolveSDK = resolve; }); },
        resolveSDK() { resolveSDK(); }
    };
}
const premium = () => ({ plan: 'premium', premiumExpiresAt: new Date(Date.now() + 60000).toISOString() });
(async () => {
    for (const user of [null, { plan: 'free' }, { plan: 'premium' },
        { plan: 'premium', premiumExpiresAt: 'bad-date' },
        { plan: 'premium', premiumExpiresAt: new Date(Date.now() - 1000).toISOString() }]) {
        const t = setup(); t.setUser(user);
        let gates = 0;
        t.ctx.setEntryGate(() => { gates++; return true; });
        t.ctx.refreshToggle();
        assert(t.ctx.toggleGroup.hidden && t.button.disabled, 'not available without active Premium');
        assert.strictEqual(t.button.attributes['aria-disabled'], 'true');
        assert.strictEqual(await t.ctx.open(), false);
        assert.strictEqual(await t.ctx.toggle(), false);
        assert.strictEqual(await t.ctx.openNow(), false, 'internal entry also denies access');
        assert.strictEqual(gates, 0, 'denied before LiDAR planning/prefetch');
        assert.strictEqual(t.counts().sdkLoads, 0, 'denied before downloading SDK');
    }
    {
        const t = setup(); t.setUser(premium());
        await Promise.resolve(); // the real auth-ready listener runs
        assert(!t.ctx.toggleGroup.hidden && !t.button.disabled, 'auth readiness reveals Premium control without reload');
    }
    {
        const t = setup();
        delete t.ctx.root._dlIsPremium;
        assert.strictEqual(await t.ctx.open(), false, 'loading/missing subscription module fails closed');
        t.ctx.root._dlIsPremium = () => { throw new Error('not ready'); };
        assert.strictEqual(await t.ctx.open(), false, 'entitlement errors fail closed');
    }
    {
        const t = setup(); t.setUser(premium());
        t.windowEvents['detectlab:authchange']();
        assert(!t.ctx.toggleGroup.hidden && !t.button.disabled, 'upgrade reveals and enables 3D');
        let gates = 0;
        t.ctx.setEntryGate(() => { gates++; return true; });
        assert.strictEqual(await t.ctx.open(), true);
        assert.strictEqual(gates, 1);
        assert.strictEqual(t.counts().constructions, 1, 'Premium follows the normal 3D path');
        assert.strictEqual(await t.ctx.toggle(), undefined, 'closing remains unrestricted');
        t.ctx.state.open = true;
        t.setUser(null);
        t.windowEvents['detectlab:authchange']();
        assert(!t.ctx.state.open && t.ctx.toggleGroup.hidden, 'logout closes 3D and hides control');
    }
    {
        const t = setup(); t.setUser(premium());
        let resolveGate;
        t.ctx.setEntryGate(() => new Promise(resolve => { resolveGate = resolve; }));
        const opening = t.ctx.open();
        await Promise.resolve();
        t.setUser({ plan: 'free' });
        resolveGate(true);
        assert.strictEqual(await opening, false, 'revoked Premium cannot enter after async LiDAR preparation');
        assert.strictEqual(t.counts().sdkLoads, 0);
    }
    {
        const t = setup(); t.setUser(premium()); t.deferSDK();
        const opening = t.ctx.open();
        assert(t.ctx.state.open);
        t.setUser(null);
        t.resolveSDK();
        assert.strictEqual(await opening, false, 'revoked Premium cannot enter after async SDK download');
        assert.strictEqual(t.counts().constructions, 0);
        assert(!t.ctx.state.open);
    }
    {
        const t = setup(); t.setUser(premium());
        await t.ctx.open();
        t.setUser({ plan: 'premium', premiumExpiresAt: new Date(Date.now() - 1000).toISOString() });
        const poll = t.intervals.find(timer => timer.delay === 30000);
        assert(poll, 'idle expiry is monitored without auth events');
        poll.handler();
        assert(!t.ctx.state.open && t.ctx.toggleGroup.hidden, 'expiry returns to 2D');
        t.setUser(premium());
        t.documentEvents.visibilitychange();
        assert(!t.ctx.toggleGroup.hidden, 'resume refreshes entitlement');
        t.setUser(null);
        t.windowEvents.pageshow();
        assert(t.ctx.toggleGroup.hidden, 'pageshow refreshes entitlement');
    }
    const css = read('css/map3d-terrain.css');
    assert(/#map3d-toggle-group\[hidden\]\s*\{\s*display:\s*none !important/.test(css),
        'entitlement hiding overrides flex styles on web and PWA');
    for (const file of ['index.html', 'sw.js']) {
        const text = read(file);
        assert(text.includes('js/map3d-terrain.js?v=20261121-3d-twist-owns'));
        assert(text.includes('css/map3d-terrain.css?v=20261102-report-lidar-window'));
    }
    console.log('PASS: 3D Premium-only UI/API, active/expired/free/guest access, async gates, SDK race, logout, expiry and resume.');
})().catch(error => { console.error(error); process.exitCode = 1; });
