/* Regression: long-press move/lock for historical maps (free + premium).
 * node test-hist-shift.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.nodeType = 1;
        this.id = '';
        this.parentElement = null;
        this.children = [];
        this.style = {};
        this._listeners = {};
        this._qs = {};
        this._classes = new Set();
        this.checked = false; this.disabled = false; this.value = ''; this.textContent = '';
        const self = this;
        this.classList = {
            add(c) { self._classes.add(c); },
            toggle(c, force) { if (force) self._classes.add(c); else self._classes.delete(c); },
            contains(c) { return self._classes.has(c); }
        };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
    get innerHTML() { return this._html || ''; }
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    querySelector(sel) {
        if (!this._qs[sel]) this._qs[sel] = new FakeEl(sel.includes('select') ? 'select' : sel.includes('input') || sel.includes('toggle') ? 'input' : 'div');
        return this._qs[sel];
    }
    /* Enough of matches()/closest() for the selector shapes hist-shift uses:
       tag, .class, #id, [class*="…"], [id*="…"], comma lists. */
    matches(sel) {
        return String(sel).split(',').some(part => {
            const s = part.trim();
            if (!s) return false;
            if (s[0] === '.') return this._classes.has(s.slice(1));
            if (s[0] === '#') return this.id === s.slice(1);
            const m = s.match(/^\[(class|id)\*="([^"]*)"\]$/);
            if (m) return (m[1] === 'class' ? this.className : String(this.id)).includes(m[2]);
            return this.tagName === s.toUpperCase();
        });
    }
    closest(sel) {
        let n = this;
        while (n) { if (typeof n.matches === 'function' && n.matches(sel)) return n; n = n.parentElement; }
        return null;
    }
    fire(type, ev) { (this._listeners[type] || []).slice().forEach(fn => fn(ev)); }
}
const documentFake = {
    readyState: 'complete',
    documentElement: { lang: 'ro' },
    createElement(tag) { return new FakeEl(tag); },
    addEventListener() {}
};

const paneEls = {};
function paneEl(name, z) {
    if (!paneEls[name]) { paneEls[name] = new FakeEl('div'); paneEls[name].style.zIndex = String(z); }
    return paneEls[name];
}
let layers = [];
const container = new FakeEl('div');
const dragging = {
    _on: true,
    enabled() { return this._on; },
    disable() { this._on = false; },
    enable() { this._on = true; }
};
const mapHandlers = {};
const map = {
    dragging,
    getContainer() { return container; },
    getZoom() { return 12; },
    eachLayer(fn) { layers.slice().forEach(fn); },
    getPane(name) { return paneEls[name] || null; },
    on(evt, fn) { evt.split(' ').forEach(e => { (mapHandlers[e] = mapHandlers[e] || []).push(fn); }); }
};
function tileLayer(pane, layersOpt, z) {
    paneEl(pane, z);
    return { options: { pane, layers: layersOpt }, _url: 'https://wms.example.org/wms', getTileUrl() { return 'x'; } };
}
const premiumWig = tileLayer('pane_wig100k', 'ihpan:wig100k_3857', 659);
const freeAustrian = tileLayer('pane_austrian', 'austrian', 640);
const baseLayer = tileLayer('pane_satellite', '', 200);
layers = [baseLayer, freeAustrian, premiumWig];

const DEFS = {
    'ihpan:wig100k_3857': { id: 'cenagis.wig100k', group: 'hist-premium', title: { ro: 'WIG 1:100 000', en: 'WIG 1:100,000' } },
    'austrian': { id: 'hist.austrian', group: 'hist-free', title: { ro: 'Harta Austriacă', en: 'Austrian Map' } }
};
const store = {};
const win = {
    _dlMap: map,
    _currentLang: 'ro',
    L: { ImageOverlay: class ImageOverlay {} },
    DetectLabLayers: {
        get(id) { return Object.values(DEFS).find(d => d.id === id) || null; },
        matchDef(probe) { return DEFS[probe.layers] || null; }
    },
    localStorage: {
        getItem(k) { return store[k] || null; },
        setItem(k, v) { store[k] = v; }
    },
    setTimeout, clearTimeout, setInterval, clearInterval
};
const sandbox = { window: win, document: documentFake, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/hist-shift.js'), sandbox, { filename: 'js/hist-shift.js' });
const HS = win.DetectLabHistShift;
assert.ok(HS, 'DetectLabHistShift exported');

(async function () {
    // Discovery: free + premium historical layers, basemap excluded, topmost first
    const targets = HS.activeTargets();
    assert.strictEqual(targets.length, 2, 'free + premium discovered, basemap excluded: ' + JSON.stringify(targets));
    assert.strictEqual(targets[0].pane, 'pane_wig100k', 'topmost (highest pane z) selected first');
    assert.strictEqual(targets[1].defId, 'hist.austrian');
    console.log('  ✓ free + premium historical layers discovered from the live map');

    // Clamp: "not excessively" — magnitude capped at MAX_OFFSET_M
    const clamped = HS.setOffset('pane_wig100k', 10000, 0);
    assert.ok(Math.abs(Math.hypot(clamped.x, clamped.y) - HS.MAX_OFFSET_M) < 1e-9, 'offset clamped to 300 m');
    HS.setOffset('pane_wig100k', 100, -50);
    const saved = JSON.parse(store['dlHistShift.v1']);
    assert.strictEqual(JSON.stringify(saved['pane_wig100k']), JSON.stringify({ x: 100, y: -50 }), 'offset persisted to localStorage');
    const mpp = 156543.03392 / Math.pow(2, 12);
    assert.ok(paneEls['pane_wig100k'].style.transform.includes('translate(' + (100 / mpp).toFixed(1) + 'px'),
        'metre offset becomes a pixel pane transform at current zoom: ' + paneEls['pane_wig100k'].style.transform);
    console.log('  ✓ offset clamped, persisted, applied as zoom-scaled pane transform');

    // Long-press reveals the panel/switch
    const tileTarget = new FakeEl('div');
    container.fire('pointerdown', { isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, target: tileTarget });
    await new Promise(r => setTimeout(r, HS.LONG_PRESS_MS + 80));
    const panel = HS._state.panel;
    assert.ok(panel && panel.style.display !== 'none', 'long-press shows the switch panel');
    console.log('  ✓ long-press (≈550 ms, no move) reveals the switch');

    // Switch ON: base dragging disabled, drag shifts the historical map
    assert.strictEqual(HS.setEnabled(true), true);
    assert.strictEqual(map.dragging.enabled(), false, 'base map drag locked while moving historical map');
    container.fire('pointerdown', { isPrimary: true, pointerId: 2, clientX: 100, clientY: 100, target: tileTarget });
    container.fire('pointermove', { pointerId: 2, clientX: 105, clientY: 100 });
    container.fire('pointerup', { pointerId: 2 });
    const moved = HS.getOffset(HS._state.selectedPane);
    assert.ok(Math.abs(moved.x - (100 + 5 * mpp)) < 0.01 && Math.abs(moved.y - (-50)) < 0.01,
        '5 px drag shifts overlay by 5 px worth of metres: ' + JSON.stringify(moved));
    console.log('  ✓ switch ON: drag moves the historical map, not the base');

    // A huge drag still cannot lose the map
    container.fire('pointerdown', { isPrimary: true, pointerId: 3, clientX: 0, clientY: 0, target: tileTarget });
    container.fire('pointermove', { pointerId: 3, clientX: 100000, clientY: 0 });
    container.fire('pointerup', { pointerId: 3 });
    assert.ok(Math.hypot(HS.getOffset(HS._state.selectedPane).x, HS.getOffset(HS._state.selectedPane).y) <= HS.MAX_OFFSET_M + 1e-9,
        'huge drag remains clamped');
    console.log('  ✓ excessive drags are clamped — the sheet cannot be lost');

    // Lock: switch OFF keeps the position, base dragging returns
    const lockedAt = HS.getOffset(HS._state.selectedPane);
    assert.strictEqual(HS.setEnabled(false), false);
    assert.strictEqual(map.dragging.enabled(), true, 'base map drag restored on lock');
    assert.strictEqual(JSON.stringify(HS.getOffset(HS._state.selectedPane)), JSON.stringify(lockedAt), 'lock keeps the current position');
    HS.reset(HS._state.selectedPane);
    assert.strictEqual(JSON.stringify(HS.getOffset(HS._state.selectedPane)), JSON.stringify({ x: 0, y: 0 }), 'reset returns to true position');
    console.log('  ✓ lock keeps position; reset restores true position');

    // ── Regression: the layer's slider added on the main screen ──
    // js/vertical-opacity-control.js puts state classes on <body> while a
    // mirror is on screen — `vo-josephine-docked` when the Josephine
    // historical map's slider is docked, `layer-dock-open` for a distance
    // dock — and js/map-app.js adds `transp-panel-open`. isUiTarget() used
    // to run an unbounded closest('[class*="dock"], [class*="panel"], …'),
    // which matched <body> itself for every map target: with the slider on
    // screen the long-press never started, the „Mută harta istorică" panel
    // never appeared, and move-mode drags never began. The UI test must
    // stop at the map container.
    if (HS._state.press) container.fire('pointerup', { pointerId: HS._state.press.id });
    assert.ok(!HS._state.press, 'no stale press entering the docked-slider scenario');
    const bodyEl = new FakeEl('body');
    const frameEl = new FakeEl('div'); frameEl.className = 'map-frame';
    bodyEl.appendChild(frameEl); frameEl.appendChild(container);
    const tileInMap = new FakeEl('div'); container.appendChild(tileInMap);
    for (const cls of ['vo-josephine-docked', 'vo-josephine-docked-secondary', 'layer-dock-open', 'transp-panel-open']) {
        bodyEl.className = 'is-pwa ' + cls;
        HS.hidePanel();
        container.fire('pointerdown', { isPrimary: true, pointerId: 10, clientX: 50, clientY: 50, target: tileInMap });
        assert.ok(HS._state.press, 'long-press starts with body.' + cls + ' (slider on the main screen)');
        container.fire('pointerup', { pointerId: 10 });
        assert.ok(!HS._state.press, 'press cleared on pointerup');
    }
    // …and the panel really appears on hold while the Josephine slider class is set
    bodyEl.className = 'is-pwa vo-josephine-docked';
    HS.hidePanel();
    container.fire('pointerdown', { isPrimary: true, pointerId: 11, clientX: 50, clientY: 50, target: tileInMap });
    await new Promise(r => setTimeout(r, HS.LONG_PRESS_MS + 80));
    assert.ok(HS._state.panel && HS._state.panel.style.display !== 'none',
        'long-press reveals the panel while the historical slider is on screen');
    container.fire('pointerup', { pointerId: 11 });
    // Genuine UI inside the map still blocks the gesture
    const controlEl = new FakeEl('div'); controlEl.className = 'leaflet-control'; container.appendChild(controlEl);
    const innerPanelEl = new FakeEl('div'); innerPanelEl.className = 'some-panel'; container.appendChild(innerPanelEl);
    const buttonEl = new FakeEl('button'); container.appendChild(buttonEl);
    HS.hidePanel();
    for (const uiEl of [controlEl, innerPanelEl, buttonEl]) {
        container.fire('pointerdown', { isPrimary: true, pointerId: 12, clientX: 50, clientY: 50, target: uiEl });
        assert.ok(!HS._state.press, 'press on in-map UI (' + (uiEl.className || uiEl.tagName) + ') does not start a long-press');
    }
    // Move-mode drag works with the docked body class, but not from a control
    HS.reset(HS._state.selectedPane);
    assert.strictEqual(HS.setEnabled(true), true);
    container.fire('pointerdown', { isPrimary: true, pointerId: 13, clientX: 100, clientY: 100, target: tileInMap });
    container.fire('pointermove', { pointerId: 13, clientX: 105, clientY: 100 });
    container.fire('pointerup', { pointerId: 13 });
    const dragged = HS.getOffset(HS._state.selectedPane);
    assert.ok(Math.abs(dragged.x - 5 * mpp) < 0.01 && Math.abs(dragged.y) < 0.01,
        'move-mode drag shifts the map with the slider on screen: ' + JSON.stringify(dragged));
    container.fire('pointerdown', { isPrimary: true, pointerId: 14, clientX: 100, clientY: 100, target: controlEl });
    assert.ok(!HS._state.drag, 'drag does not start from an in-map control');
    HS.setEnabled(false);
    console.log('  ✓ slider on the main screen (body *-docked / *-panel-open classes) no longer kills long-press or drag; in-map UI still blocks');

    // Static wiring
    const index = read('index.html'), sw = read('sw.js'), css = read('css/hist-shift.css');
    assert.ok(index.includes('js/hist-shift.js?v=20261020-hist-shift-docked-slider'), 'index loads hist-shift');
    assert.ok(index.includes('css/hist-shift.css?v=20261014-hist-shift'), 'index loads hist-shift css');
    assert.ok(sw.includes("'js/hist-shift.js?v=20261020-hist-shift-docked-slider'"), 'sw precaches hist-shift');
    assert.ok(css.includes('.hist-shift-panel'), 'panel styles present');
    console.log('  ✓ wiring (index / service worker / css)');
    console.log('✅ test-hist-shift.js passed');
})().catch(e => { console.error(e); process.exit(1); });
