// Integration checks: adding a layer slider on screen auto-activates the
// layer, and removing it with the „×” button auto-deactivates the layer.
// Usage: node test-vertical-slider-layer-auto-toggle.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const voSrc = fs.readFileSync(path.join(__dirname, 'js/vertical-opacity-control.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* ── Static coverage: every opacity slider shipped by the panel is linked to
      its layer toggle (or to the LIDAR sub-layer system), except the Satellite
      basemap which is permanently on and has no switch at all. ── */
function extractStringMap(name) {
    const block = voSrc.match(new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\};'));
    assert(block, name + ' must be declared in vertical-opacity-control.js');
    const map = {};
    const pairs = block[1].match(/[A-Za-z0-9]+:\s*'[A-Za-z0-9_]+'/g) || [];
    pairs.forEach(function (pair) {
        const m = pair.match(/([A-Za-z0-9]+):\s*'([A-Za-z0-9_]+)'/);
        map[m[1]] = m[2];
    });
    return map;
}
const LAYER_TOGGLE_MAP = extractStringMap('LAYER_TOGGLE_MAP');
const LIDAR_SUB_TOGGLE_KEYS = extractStringMap('LIDAR_SUB_TOGGLE_KEYS');

const rangeTags = indexHtml.match(/<input\b[^>]*>/gis) || [];
const opacityIds = rangeTags.filter(function (tag) {
    return /class="[^"]*transp-slider/.test(tag) && /type="range"/.test(tag) && /id="[^"]*Opacity/.test(tag);
}).map(function (tag) {
    return (tag.match(/id="([^"]+)"/) || [])[1];
});
assert.strictEqual(opacityIds.length, 55, 'all 55 shipped layer opacity ranges should be discoverable (46 prior + 8 UK historical maps + the UK heritage group)');
opacityIds.forEach(function (id) {
    if (id === 'satOpacitySlider') {
        assert(!(id in LAYER_TOGGLE_MAP) && !(id in LIDAR_SUB_TOGGLE_KEYS),
            'satellite basemap has no switch — it must stay unmapped');
        return;
    }
    assert((id in LAYER_TOGGLE_MAP) || (id in LIDAR_SUB_TOGGLE_KEYS),
        'opacity slider ' + id + ' must be linked to its layer activation');
});
assert('battlesPeriodSlider' in LAYER_TOGGLE_MAP, 'the battles period mirror drives its own layer too');
assert(!('satPeriodSlider' in LAYER_TOGGLE_MAP), 'the satellite period mirror has no switch either');
Object.keys(LIDAR_SUB_TOGGLE_KEYS).forEach(function (id) {
    assert(opacityIds.includes(id), 'LIDAR sub key ' + id + ' must be a shipped opacity slider');
});
assert.strictEqual(Object.keys(LIDAR_SUB_TOGGLE_KEYS).length, 11, 'all 11 LIDAR sub-layers are linked');
Object.keys(LAYER_TOGGLE_MAP).forEach(function (sliderId) {
    const toggleId = LAYER_TOGGLE_MAP[sliderId];
    assert(indexHtml.includes('id="' + toggleId + '"'),
        'toggle ' + toggleId + ' of ' + sliderId + ' must exist in the panel');
    assert(indexHtml.includes('<input type="checkbox" id="' + toggleId + '"'),
        'toggle ' + toggleId + ' must ship as a real checkbox switch');
});

/* ── Behaviour: the mirror lifecycle drives the layer switch ── */
class ClassList {
    constructor(classes) { this._set = new Set(classes || []); }
    add(name) { this._set.add(name); }
    remove(name) { this._set.delete(name); }
    contains(name) { return this._set.has(name); }
    toggle(name, on) {
        if (on === undefined) on = !this.contains(name);
        if (on) this.add(name); else this.remove(name);
        return on;
    }
}

class MockElement extends EventTarget {
    constructor(tag, id, classes) {
        super();
        this.tagName = String(tag || 'div').toUpperCase();
        this.id = id || '';
        this.classList = new ClassList(classes || []);
        this.parentElement = null;
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.textContent = '';
        this.title = '';
        this.value = '';
        this.min = '';
        this.max = '';
        this.step = '';
        this.checked = false;
        this.focused = false;
        this.dataset = {};
    }
    get firstChild() { return this.children.length ? this.children[0] : null; }
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, ref) {
        child.parentElement = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, child); else this.children.push(child);
        return child;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentElement = null;
        return child;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelectorAll(selector) {
        const result = [];
        function visit(node) {
            node.children.forEach(function (child) {
                if (selector === '[data-key^="layer_"]' &&
                    String(child.getAttribute('data-key') || '').indexOf('layer_') === 0) result.push(child);
                visit(child);
            });
        }
        visit(this);
        return result;
    }
    closest(selector) {
        const interactive = /input|button|label|a|select|textarea/.test(selector);
        if (interactive && /^(INPUT|BUTTON|LABEL|A|SELECT|TEXTAREA)$/.test(this.tagName)) return this;
        return this.parentElement ? this.parentElement.closest(selector) : null;
    }
    click() { this.dispatchEvent(new Event('click')); }
    focus() { this.focused = true; this.dispatchEvent(new Event('focus')); }
}

function range(id, value) {
    const input = new MockElement('input', id, ['transp-slider']);
    input.value = String(value);
    input.min = '0';
    input.max = '100';
    input.step = '1';
    return input;
}

const panel = new MockElement('div', 'transpPanel', ['open']);
const tab = new MockElement('button', 'transpTab');
panel.appendChild(tab);

function panelRow(id, titleText, toggleId, sliderId, sliderValue, titleKey) {
    const row = new MockElement('div', id, ['transp-layer-row']);
    const title = new MockElement('span');
    title.textContent = titleText;
    if (titleKey) title.setAttribute('data-key', titleKey);
    row.appendChild(title);
    let toggle = null;
    if (toggleId) {
        toggle = new MockElement('input', toggleId);
        row.appendChild(toggle);
    }
    const slider = range(sliderId, sliderValue);
    row.appendChild(slider);
    panel.appendChild(row);
    return { row, toggle, slider };
}

// Regular free layer (switch starts OFF), two more evictable rows,
// a LIDAR sub-layer (no functional switch of its own), the distance row
// (registers its own switch) and the Satellite basemap row (no switch).
const uat = panelRow('uatOwner', 'UAT', 'uatToggle', 'uatOpacitySlider', 80, 'layer_uat');
const bucovina = panelRow('bucovinaOwner', 'Bucovina 1861–1864', 'bucovinaMapToggle', 'bucovinaMapOpacitySlider', 70);
const austrian = panelRow('austrianOwner', 'Austrian Map 1910', 'austrianMapToggle', 'austrianMapOpacitySlider', 70);
const lidar = panelRow('lidarOwner', 'HD · Hunedoara', null, 'lidarHdOpacitySlider', 0);
const lidarMaster = new MockElement('input', 'lidarToggle');
const distance = panelRow('distanceOwner', 'LIDAR Scanner', 'lidarScannerToggle', 'lidarScannerDistance', 10);
distance.slider.min = '10';
distance.slider.max = '50';
const scanButton = new MockElement('button', 'lidarScannerRun');
distance.row.appendChild(scanButton);
const sat = panelRow('satOwner', 'Satellite', null, 'satOpacitySlider', 100, 'layer_satellite');
sat.slider.min = '10';
const satPeriod = range('satPeriodSlider', 1);
satPeriod.min = '0';
satPeriod.max = '1';
sat.row.appendChild(satPeriod);

const control = new MockElement('div', 'verticalOpacityControl');
const caption = new MockElement('span', 'verticalOpacityCaption');
const vertical = range('verticalOpacitySlider', 80);
vertical.classList = new ClassList(['vertical-opacity-slider']);
const output = new MockElement('output', 'verticalOpacityValue');
const label = new MockElement('span', 'verticalOpacityLayer');
const close = new MockElement('button', 'verticalOpacityClose');

const control2 = new MockElement('div', 'verticalOpacityControlSecondary');
const caption2 = new MockElement('span', 'verticalOpacityCaptionSecondary');
const vertical2 = range('verticalOpacitySliderSecondary', 80);
vertical2.classList = new ClassList(['vertical-opacity-slider']);
const output2 = new MockElement('output', 'verticalOpacityValueSecondary');
const label2 = new MockElement('span', 'verticalOpacityLayerSecondary');
const close2 = new MockElement('button', 'verticalOpacityCloseSecondary');

const periodControl = new MockElement('div', 'verticalSatPeriodControl');
const periodSlider = range('verticalSatPeriodSlider', 1);
periodSlider.classList = new ClassList(['vertical-opacity-slider']);
const periodOutput = new MockElement('output', 'verticalSatPeriodValue');
const periodCaption = new MockElement('span', 'verticalSatPeriodCaption');
const periodLabel = new MockElement('span', 'verticalSatPeriodLayer');

const dock = new MockElement('div', 'layerActionDock');
const dockInner = new MockElement('div', 'layerActionDockInner');
dock.appendChild(dockInner);

const byId = {};
[panel, tab, control, caption, vertical, output, label, close,
 control2, caption2, vertical2, output2, label2, close2,
 periodControl, periodSlider, periodOutput, periodCaption, periodLabel,
 dock, dockInner,
 uat.slider, uat.toggle, bucovina.slider, bucovina.toggle, austrian.slider, austrian.toggle,
 lidar.slider, lidarMaster, distance.slider, distance.toggle, scanButton,
 sat.slider, satPeriod].forEach(function (el) {
    byId[el.id] = el;
});

let panelCloseClicks = 0;
tab.addEventListener('click', function () {
    panelCloseClicks++;
    panel.classList.remove('open');
});

const documentMock = new (class extends EventTarget {
    constructor() { super(); this.readyState = 'complete'; }
    getElementById(id) { return byId[id] || null; }
    createElement(tag) { return new MockElement(tag); }
    querySelector() { return null; }
    querySelectorAll(selector) {
        if (selector.indexOf('[id*="Opacity"]') !== -1) {
            return [uat.slider, bucovina.slider, austrian.slider, lidar.slider, sat.slider];
        }
        return [];
    }
})();

const intervals = new Map();
const timeouts = new Map();
let intervalId = 0;
let timeoutId = 0;
const windowMock = {
    setInterval(fn) { const id = ++intervalId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = ++timeoutId; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    toggleLidarSubCalls: [],
    toggleLidarSub(key, on) { this.toggleLidarSubCalls.push([key, on]); }
};

const sandbox = {
    window: windowMock,
    document: documentMock,
    Event,
    console,
    Number,
    String,
    Math,
    isFinite
};
windowMock.window = windowMock;
windowMock.document = documentMock;
vm.createContext(sandbox);
vm.runInContext(voSrc, sandbox, { filename: 'vertical-opacity-control.js' });

// Count real switch transitions dispatched by the auto-activation.
function watchToggle(el) {
    const hits = [];
    el.addEventListener('change', function () { hits.push(el.checked); });
    return hits;
}
const uatHits = watchToggle(uat.toggle);
const bucovinaHits = watchToggle(bucovina.toggle);
const austrianHits = watchToggle(austrian.toggle);
const lidarMasterHits = watchToggle(lidarMaster);
const scannerHits = watchToggle(distance.toggle);

/* 1. Adding a slider on screen turns its layer ON automatically. */
assert.strictEqual(uat.toggle.checked, false, 'UAT starts off');
windowMock.DetectLabVerticalOpacity.select('uatOpacitySlider');
assert(control.classList.contains('visible'), 'mirror visible on screen');
assert.strictEqual(uat.toggle.checked, true, 'layer auto-activated with the mirror');
assert.deepStrictEqual(uatHits, [true], 'exactly one real switch-on event fired');

/* 2. The „×” button removes the slider and auto-deactivates the layer. */
close.click();
assert(!control.classList.contains('visible'), 'mirror removed from screen');
assert.strictEqual(uat.toggle.checked, false, 'layer auto-deactivated with the mirror');
assert.deepStrictEqual(uatHits, [true, false], 'exactly one real switch-off event fired');

/* 3. Re-adding re-activates; each transition fires exactly once. */
windowMock.DetectLabVerticalOpacity.select('uatOpacitySlider');
assert.strictEqual(uat.toggle.checked, true);
assert.deepStrictEqual(uatHits, [true, false, true]);

/* 4. Escape clears every mirror and deactivates every mirrored layer. */
windowMock.DetectLabVerticalOpacity.select('bucovinaMapOpacitySlider');
assert.strictEqual(bucovina.toggle.checked, true, 'second mirror activates its layer too');
const escapeEvent = new Event('keydown');
escapeEvent.key = 'Escape';
windowMock.document.dispatchEvent(escapeEvent);
assert.strictEqual(uat.toggle.checked, false, 'Escape turned the first layer off');
assert.strictEqual(bucovina.toggle.checked, false, 'Escape turned the second layer off');
assert.deepStrictEqual(bucovinaHits, [true, false]);

/* 5. LIDAR sub-layer: master switch + toggleLidarSub; sub only on close. */
windowMock.DetectLabVerticalOpacity.select('lidarHdOpacitySlider');
assert.strictEqual(lidarMaster.checked, true, 'LIDAR master auto-activated');
assert.deepStrictEqual(lidarMasterHits, [true]);
assert.deepStrictEqual(windowMock.toggleLidarSubCalls, [['hd', true]],
    'sub-layer enabled through its real API');
close.click();
assert.deepStrictEqual(windowMock.toggleLidarSubCalls, [['hd', true], ['hd', false]],
    'closing the mirror disables only that sub-layer');
assert.strictEqual(lidarMaster.checked, true, 'master stays on for the remaining sub-layers');

/* 6. Distance slider: X turns the analysis layer's own switch off. */
distance.row.click();
assert.strictEqual(distance.toggle.checked, true, 'scanner layer auto-activated with its mirror');
assert.deepStrictEqual(scannerHits, [true]);
close.click();
assert.strictEqual(distance.toggle.checked, false, 'X deactivated the scanner layer');
assert.deepStrictEqual(scannerHits, [true, false]);

/* 7. A third selection evicts the oldest mirror — its layer goes off too. */
windowMock.DetectLabVerticalOpacity.select('uatOpacitySlider');
windowMock.DetectLabVerticalOpacity.select('bucovinaMapOpacitySlider');
assert.strictEqual(uat.toggle.checked, true);
assert.strictEqual(bucovina.toggle.checked, true);
windowMock.DetectLabVerticalOpacity.select('austrianMapOpacitySlider');
assert.strictEqual(uat.toggle.checked, false, 'evicted mirror deactivated its layer');
assert.strictEqual(bucovina.toggle.checked, true, 'still-visible mirror keeps its layer on');
assert.strictEqual(austrian.toggle.checked, true, 'newest mirror activated its layer');
assert.deepStrictEqual(austrianHits, [true]);

/* 8. Satellite basemap: mirrors appear, nothing to switch, no crash. */
windowMock.DetectLabVerticalOpacity.select('satOpacitySlider');
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'satOpacitySlider');
assert.strictEqual(uat.toggle.checked, false, 'evicted by the satellite pair');
assert.strictEqual(bucovina.toggle.checked, false, 'evicted by the satellite pair');
assert.strictEqual(austrian.toggle.checked, false, 'evicted by the satellite pair');
close.click();
assert(!control.classList.contains('visible'), 'satellite pair closed');

/* 9. A switch left „checked” by browser form restoration (reload /
      back-forward) must not swallow the auto-activation: the checkbox is
      checked but the layer is NOT on the map, so the slider appearing on
      screen has to fire a real switch-on event regardless. */
uat.toggle.checked = true;               // stale state — no change event fired
const uatBefore = uatHits.length;
windowMock.DetectLabVerticalOpacity.select('uatOpacitySlider');
assert.strictEqual(uat.toggle.checked, true);
assert.strictEqual(uatHits.length, uatBefore + 1,
    'a restored-checked switch still receives its real switch-on event');
assert.strictEqual(uatHits[uatHits.length - 1], true);
close.click();
assert.strictEqual(uat.toggle.checked, false, 'the mirror still turns the layer back off');

/* 10. Same for the LIDAR master switch: without its start event,
       toggleLidarSub would leave the sub-layer parked (its internal visible
       flag stays false) while the panel shows everything as on. */
lidarMaster.checked = true;              // restored state — layer not started
const lidarBefore = lidarMasterHits.length;
const subsBefore = windowMock.toggleLidarSubCalls.length;
windowMock.DetectLabVerticalOpacity.select('lidarHdOpacitySlider');
assert.strictEqual(lidarMasterHits.length, lidarBefore + 1,
    'restored LIDAR master still gets its switch-on event');
assert.strictEqual(windowMock.toggleLidarSubCalls.length, subsBefore + 1,
    'and the sub-layer is enabled exactly once');
windowMock.DetectLabVerticalOpacity.close();

console.log('✅ test-vertical-slider-layer-auto-toggle.js passed: adding a slider on screen auto-activates its layer; the „×” button auto-deactivates it; a restored-on switch still starts its layer.');
