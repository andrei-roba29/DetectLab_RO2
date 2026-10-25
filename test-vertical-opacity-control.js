// Integration checks for the map-side vertical opacity mirror.
// Usage: node test-vertical-opacity-control.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const stylesCss = fs.readFileSync(path.join(__dirname, 'css/styles.css'), 'utf8');

// Static coverage: every opacity range currently shipped by the real panel is
// discoverable by the feature selector, while the similarly styled scanner
// distance range is not. The Battles century range is deliberately NOT an
// opacity id, yet it must ship in the panel so the control can mirror it.
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const rangeTags = indexHtml.match(/<input\b[^>]*>/gis) || [];
const opacityIds = rangeTags.filter(function (tag) {
    return /class="[^"]*transp-slider/.test(tag) && /type="range"/.test(tag) && /id="[^"]*Opacity/.test(tag);
}).map(function (tag) {
    return (tag.match(/id="([^"]+)"/) || [])[1];
});
assert.strictEqual(opacityIds.length, 54, 'all 54 shipped layer opacity ranges should be discoverable (46 prior + 8 UK historical maps)');
assert(!opacityIds.includes('lidarScannerDistance'), 'scanner distance is not an opacity range');
assert(indexHtml.includes('id="battlesPeriodSlider"'), 'battles period slider should be part of the panel');
assert(indexHtml.includes('id="battlesPeriodValue"'), 'battles century bubble should exist in the panel');
assert(!/id="battlesPeriodSlider"[^>]*title=/.test(indexHtml), 'battles slider native title tooltip should be gone (replaced by the century bubble)');
assert(indexHtml.includes('id="verticalOpacityCaption"'), 'vertical control caption should be addressable for PERIOD wording');
// The word "OPACITY" must not sit above the map-side slider any more: the
// caption element stays in the DOM (the Battles mirror still writes PERIOADĂ /
// ISTORIC into its sibling) but ships empty, and CSS hides it while empty so
// the layer name keeps the top edge of the control.
const captionMarkup = (indexHtml.match(/<span[^>]*id="verticalOpacityCaption"[^>]*>([\s\S]*?)<\/span>/) || []);
assert(captionMarkup[1] !== undefined && captionMarkup[1].trim() === '',
    'the vertical mirror must not ship an OPACITY caption (got: ' + JSON.stringify(captionMarkup[1]) + ')');
assert(!/verticalOpacityCaption"[^>]*>\s*OPACITY/i.test(indexHtml), 'the OPACITY caption strip should be gone from the markup');
assert(indexHtml.includes('body.is-pwa .transp-panel'), 'page should retain its installed-PWA layer panel mode');
assert(indexHtml.includes('id="verticalOpacityControlSecondary"') &&
    indexHtml.includes('id="verticalOpacitySliderSecondary"'),
    'the page should ship a second map-side mirror slot');
assert(/\.vertical-opacity-control\.vertical-opacity-secondary\s*\{[^}]*right:\s*calc\(38px\s*\+\s*38px\s*\+\s*12px/.test(stylesCss),
    'the second mirror needs its own side-by-side desktop anchor');
assert(/opacity-layer-mirrored/.test(stylesCss),
    'mirrored panel rows need a dedicated visual state');

// Installed mobile WebViews can collapse an auto grid track when the title is
// the only writing-mode child. The PWA path therefore owns a fixed title column
// and a concrete rotated label box; this is the regression that desktop-only
// checks would miss.
assert(/body\.is-pwa \.vertical-opacity-control\s*\{[^}]*grid-template-columns:\s*12px\s+1fr/.test(stylesCss),
    'the PWA mirror must reserve a title column beside the slider');
assert(/body\.is-pwa \.vertical-opacity-title\s*\{[^}]*position:\s*absolute/.test(stylesCss) &&
    /body\.is-pwa \.vertical-opacity-title\s*\{[^}]*height:\s*calc\(100%\s*-\s*42px\)/.test(stylesCss),
    'the PWA title needs an explicit visible box');
assert(/body\.is-pwa \.vertical-opacity-layer\s*\{[^}]*writing-mode:\s*horizontal-tb/.test(stylesCss) &&
    /body\.is-pwa \.vertical-opacity-layer\s*\{[^}]*rotate\(-90deg\)/.test(stylesCss),
    'the PWA title must use the rotated-label fallback');

// The Battles mirror must stay as compact as every other map-side slider.
// Its longer century label may wrap, but must never widen the container.
assert(/\.vertical-opacity-caption:empty\s*\{[^}]*display\s*:\s*none/.test(stylesCss),
    'an empty caption (opacity mirrors) must collapse instead of leaving a gap above the layer name');
const periodContainerRules = stylesCss.match(/\.vertical-opacity-control\[data-kind=["']period["']\]\s*\{[^}]*\}/g) || [];
assert(periodContainerRules.every(function (rule) { return !/\bwidth\s*:/.test(rule); }),
    'battles period control must not override the standard control width');
assert(/\.vertical-opacity-control\[data-kind="period"\]\s+\.vertical-opacity-value\s*\{[^}]*min-width\s*:\s*0/.test(stylesCss),
    'the century value should fit without changing the standard compact width');
assert(/\.vertical-opacity-control\[data-kind="period"\]\s+\.vertical-opacity-value\.visible/.test(stylesCss),
    'the map-side century value should have an on-hover visible state');

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
const control = new MockElement('div', 'verticalOpacityControl');
const caption = new MockElement('span', 'verticalOpacityCaption');
const vertical = range('verticalOpacitySlider', 80);
vertical.classList = new ClassList(['vertical-opacity-slider']);
const output = new MockElement('output', 'verticalOpacityValue');
const label = new MockElement('span', 'verticalOpacityLayer');
const close = new MockElement('button', 'verticalOpacityClose');

const apmOwner = new MockElement('div', 'apmOwner', ['transp-layer-row']);
const apmTitle = new MockElement('span');
apmTitle.textContent = 'APM Layer';
apmTitle.setAttribute('data-key', 'layer_apm');
const apm = range('apmOpacitySlider', 80);
apmOwner.appendChild(apmTitle);
apmOwner.appendChild(apm);
panel.appendChild(apmOwner);

const lidarOwner = new MockElement('div', 'lidarOwner');
const lidar = range('lidarHdOpacitySlider', 0);
lidarOwner.appendChild(lidar);
panel.appendChild(lidarOwner);

// A year-bearing layer name: the initials must drop the year entirely
// („Austrian Map 1910” → „AM”, never „A19…” or „AM1”).
const austrianOwner = new MockElement('div', 'austrianOwner', ['transp-layer-row']);
const austrianTitle = new MockElement('span');
austrianTitle.textContent = 'Austrian Map 1910';
const austrian = range('austrianMapOpacitySlider', 70);
austrianOwner.appendChild(austrianTitle);
austrianOwner.appendChild(austrian);
panel.appendChild(austrianOwner);

// This visually similar range is NOT opacity: the generic panel selector must
// keep ignoring it, but the explicit distance registration mirrors it (km) and
// docks the layer's action button in the bottom-centred dock.
const distanceOwner = new MockElement('div', 'distanceOwner', ['transp-layer-row']);
const distance = range('lidarScannerDistance', 10);
distance.min = '10'; distance.max = '50';
const scannerTitle = new MockElement('span');
scannerTitle.textContent = 'LIDAR Scanner';
const scanButton = new MockElement('button', 'lidarScannerRun');
const scannerToggle = new MockElement('input', 'lidarScannerToggle');
scannerToggle.checked = false;
distanceOwner.appendChild(scannerTitle);
distanceOwner.appendChild(distance);
distanceOwner.appendChild(scanButton);
distanceOwner.appendChild(scannerToggle);
panel.appendChild(distanceOwner);

const dock = new MockElement('div', 'layerActionDock');
const dockInner = new MockElement('div', 'layerActionDockInner');
dock.appendChild(dockInner);

// The Battles century range: min -8 … max 20 (8th c. BC … 20th c. AD).
const battlesOwner = new MockElement('div', 'battlesOwner', ['transp-layer-row']);
const battles = range('battlesPeriodSlider', 14);
battles.min = '-8';
battles.max = '20';
battlesOwner.appendChild(battles);
panel.appendChild(battlesOwner);

const byId = {};
[panel, tab, control, caption, vertical, output, label, close, apm, lidar, austrian, distance, battles,
 dock, dockInner, scanButton, scannerToggle].forEach(function (el) {
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
    querySelectorAll(selector) {
        // Selectorul generic de opacitate din panou NU trebuie să prindă
        // sliderele de distanță (au altă unitate și alt dock de acțiune).
        if (selector.indexOf('[id*="Opacity"]') !== -1) return [apm, lidar, austrian, battles];
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
    clearTimeout(id) { timeouts.delete(id); }
};

// battles-layer.js exposes the century formatter + caption (bilingual).
let captionLang = 'ro';
windowMock.DetectLabBattlesPeriod = {
    format: function (value) { return 'century ' + value; },
    caption: function () { return captionLang === 'ro' ? 'PERIOADĂ' : 'PERIOD'; }
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
vm.runInContext(
    fs.readFileSync(path.join(__dirname, 'js/vertical-opacity-control.js'), 'utf8'),
    sandbox,
    { filename: 'vertical-opacity-control.js' }
);

assert(apmOwner.classList.contains('opacity-layer-selectable'), 'APM row should be clickable');
assert(lidarOwner.classList.contains('opacity-layer-selectable'), 'nested LIDAR row should be clickable');
assert(battlesOwner.classList.contains('opacity-layer-selectable'), 'battles period row should be clickable');
// The distance range is registered EXPLICITLY (by id), not through the opacity
// selector: the mock selector above never returns it, yet the row is clickable
// and the mirror reports kind "distance" with a km formatter.
assert(distanceOwner.classList.contains('opacity-layer-selectable'),
    'distance row is registered explicitly for its own mirror');

// Clicking a layer row selects it, opens the vertical mirror and closes the panel.
apmOwner.click();
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'apmOpacitySlider');
assert(control.classList.contains('visible'), 'vertical control should become visible');
assert(apmOwner.classList.contains('opacity-layer-selected'), 'selected row should be highlighted');
assert.strictEqual(panelCloseClicks, 1, 'existing layer panel should close via its own tab');
assert.strictEqual(label.textContent, 'APM', 'above the slider stand only the layer initials (APM kept whole, max 3 letters)');
assert.strictEqual(label.title, 'APM Layer', 'the full layer name survives in the title attribute');
assert.strictEqual(caption.textContent, '', 'opacity sources show no caption above the map-side slider');
assert.strictEqual(control.getAttribute('data-kind'), 'opacity');
assert.strictEqual(vertical.value, '80');
assert.strictEqual(output.textContent, '80%');

// Dragging the vertical mirror must drive the real source range's input logic.
let sourceInputs = 0;
apm.addEventListener('input', function () { sourceInputs++; });
vertical.value = '37';
vertical.dispatchEvent(new Event('input'));
assert.strictEqual(apm.value, '37', 'vertical value should propagate to source');
assert.strictEqual(sourceInputs, 1, 'source input event should fire exactly once');
assert.strictEqual(output.textContent, '37%');

// The percentage is only visible while the opacity is being changed: it peeks
// while the slider is operated and fades shortly after the last change.
assert(output.classList.contains('visible'), 'the percentage is up while the slider is operated');
vertical.dispatchEvent(new Event('change'));
timeouts.forEach(function (fn, id) { timeouts.delete(id); fn(); });
assert(!output.classList.contains('visible'), 'the percentage fades shortly after the last change');
vertical.dispatchEvent(new Event('input'));
assert(output.classList.contains('visible'), 'touching the slider again brings the percentage back');

// Selecting another source updates selection and uses its fallback name.
windowMock.DetectLabVerticalOpacity.select('lidarHdOpacitySlider');
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'lidarHdOpacitySlider');
assert(!apmOwner.classList.contains('opacity-layer-selected'), 'old row highlight should clear');
assert(lidarOwner.classList.contains('opacity-layer-selected'), 'new row should be highlighted');
assert.strictEqual(label.textContent, 'HD', 'county-code rows reduce to the code itself („HD · Hunedoara” → „HD”)');
assert.strictEqual(output.textContent, '0%');

// The polling sync covers existing code that assigns source.value directly.
lidar.value = '64';
intervals.forEach(function (fn) { fn(); });
assert.strictEqual(vertical.value, '64');
assert.strictEqual(output.textContent, '64%');

// ── Initials above the slider: years and digits never reach the label ──
windowMock.DetectLabVerticalOpacity.select('austrianMapOpacitySlider');
assert.strictEqual(label.textContent, 'AM',
    'the year is stripped from the label: „Austrian Map 1910” shows only „AM”');
assert.strictEqual(label.title, 'Austrian Map 1910',
    'the full name (with the year) survives in the title attribute');
assert(label.textContent.length <= 3, 'the label never exceeds 3 initials');

// ── Battles period mirror: centuries instead of percentages ──
windowMock.DetectLabVerticalOpacity.select('battlesPeriodSlider');
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'battlesPeriodSlider');
assert(battlesOwner.classList.contains('opacity-layer-selected'), 'battles row should be highlighted');
assert(!lidarOwner.classList.contains('opacity-layer-selected'), 'previous row highlight should clear');
assert.strictEqual(label.textContent, 'B',
    'above the slider stand only the initials (max 3 letters; „/” ends the name before its translation)');
assert.strictEqual(label.title, 'Battles / Bătălii',
    'the full layer name survives in the title attribute');
assert.strictEqual(vertical.min, '-8', 'century range min should mirror the source');
assert.strictEqual(vertical.max, '20', 'century range max should mirror the source');
assert.strictEqual(vertical.value, '14');
assert.strictEqual(output.textContent, 'century 14', 'century formatter should replace percentages');
assert.strictEqual(caption.textContent, 'PERIOADĂ', 'caption should switch to the period wording');
assert.strictEqual(control.getAttribute('data-kind'), 'period');
assert(!output.classList.contains('visible'), 'map-side century starts hidden');

// The century appears only while the map-side slider is hovered or operated.
vertical.dispatchEvent(new Event('pointerenter'));
assert(output.classList.contains('visible'), 'hover reveals the map-side century');
vertical.dispatchEvent(new Event('pointerleave'));
timeouts.forEach(function (fn, id) { timeouts.delete(id); fn(); });
assert(!output.classList.contains('visible'), 'century hides when hover ends');
vertical.dispatchEvent(new Event('pointerdown'));
assert(output.classList.contains('visible'), 'drag reveals and pins the map-side century');

// Dragging the vertical century mirror drives the battles source range.
let battlesInputs = 0;
battles.addEventListener('input', function () { battlesInputs++; });
vertical.value = '17';
vertical.dispatchEvent(new Event('input'));
assert.strictEqual(battles.value, '17', 'vertical century should propagate to the source');
assert.strictEqual(battlesInputs, 1, 'source input event should fire exactly once');
assert.strictEqual(output.textContent, 'century 17');
assert(output.classList.contains('visible'), 'century stays visible throughout the drag');
vertical.dispatchEvent(new Event('pointerup'));
assert(output.classList.contains('visible'), 'century remains briefly readable after release');
timeouts.forEach(function (fn, id) { timeouts.delete(id); fn(); });
assert(!output.classList.contains('visible'), 'century hides after the release delay');

// A language switch refreshes caption, layer name and formatted value in place.
captionLang = 'en';
documentMock.dispatchEvent(new Event('detectlab:langchange'));
assert.strictEqual(caption.textContent, 'PERIOD', 'caption should follow the live language');
assert.strictEqual(output.textContent, 'century 17', 'value should re-render after the language switch');

// Closing resets the mirror state.
close.click();
assert(!control.classList.contains('visible'), 'close button should hide the mirror');
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), null);
assert.strictEqual(intervals.size, 0, 'sync timer should stop when closed');

// ── Distance mirror (LIDAR Scanner) + bottom-centred action dock ──
distanceOwner.click();
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'lidarScannerDistance');
assert.strictEqual(control.getAttribute('data-kind'), 'distance', 'distance mirrors carry their own kind');
assert.strictEqual(control.getAttribute('data-owner'), 'lidarScannerDistance', 'data-owner drives the per-layer colours');
assert.strictEqual(vertical.min, '10', 'the mirror adopts the source range (10–50 km)');
assert.strictEqual(vertical.max, '50');
assert.strictEqual(output.textContent, '10 km', 'distance is formatted in km, not %');
assert.strictEqual(caption.textContent, 'DISTANȚĂ', 'distance caption (RO default in this sandbox)');
assert.strictEqual(label.textContent, 'LS', 'initials come from the row title / fallback table („LIDAR Scanner” → „LS”)');

// The layer's own button is physically moved into the bottom dock, together
// with a radius chip; the dock only shows while the mirror is visible.
assert(dock.classList.contains('visible'), 'action dock should appear with the distance mirror');
assert.strictEqual(dock.getAttribute('aria-hidden'), 'false');
assert.strictEqual(scanButton.parentElement, dockInner, 'Scan button docks in the bottom-centre container');
assert(scanButton.classList.contains('la-docked'), 'docked button keeps a hook class for styling');
// MockElement ține className ca proprietate simplă (nelegată de classList).
const dockChip = dockInner.children.filter(function (c) {
    return String(c.className || '').indexOf('layer-action-dock-radius') !== -1;
})[0];
assert(dockChip, 'the dock shows the current radius next to the button');
assert.strictEqual(dockChip.textContent, '10 km');

// Dragging the vertical distance mirror drives the panel range and the chip.
let distanceInputs = 0;
distance.addEventListener('input', function () { distanceInputs++; });
vertical.value = '25';
vertical.dispatchEvent(new Event('input'));
assert.strictEqual(distance.value, '25', 'mirror drives the real distance range');
assert.strictEqual(distanceInputs, 1, 'source input event fires exactly once');
assert.strictEqual(output.textContent, '25 km');
assert.strictEqual(dockChip.textContent, '25 km', 'dock chip follows the mirror');

// The layer's own switch turns the mirror + dock on and off.
windowMock.DetectLabVerticalOpacity.close();
assert(!dock.classList.contains('visible'), 'dock hides with the mirror');
assert.strictEqual(scanButton.parentElement, distanceOwner, 'button returns to its panel row');
scannerToggle.checked = true;
scannerToggle.dispatchEvent(new Event('change'));
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), 'lidarScannerDistance',
    'switching the layer ON re-opens its distance mirror');
assert(dock.classList.contains('visible'), 'and its action dock');
scannerToggle.checked = false;
scannerToggle.dispatchEvent(new Event('change'));
assert.strictEqual(windowMock.DetectLabVerticalOpacity.getActiveSliderId(), null,
    'switching the layer OFF closes the mirror');
assert(!dock.classList.contains('visible'), 'and the dock');
assert.strictEqual(scanButton.parentElement, distanceOwner, 'button stays home afterwards');

// Selecting an opacity layer must not keep the dock open.
scannerToggle.checked = true;
scannerToggle.dispatchEvent(new Event('change'));
windowMock.DetectLabVerticalOpacity.select('apmOpacitySlider');
assert.strictEqual(control.getAttribute('data-kind'), 'opacity');
assert(!dock.classList.contains('visible'), 'an opacity layer has no action dock');
assert.strictEqual(scanButton.parentElement, distanceOwner, 'its button is back in the panel row');
close.click();

/* ── slim frosted-glass card; the layer title runs bottom-up on the left
      side of the slider; the percentage shows only while changing ───────── */
{
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    // One title wrapper per mirror: it hosts the layer name (vertical, along
    // the left side). The caption chip (DISTANȚĂ / RAZĂ / ISTORIC) is a
    // sibling of the wrapper, anchored to the card itself — see
    // test-vertical-caption-above-card.js for why it must not live inside.
    assert(/class="vertical-opacity-title"[^>]*id="verticalOpacityTitle"/.test(html) &&
        /class="vertical-opacity-title"[^>]*id="verticalSatPeriodTitle"/.test(html),
        'each mirror must keep its title wrapper');
    const titleRule = /\.vertical-opacity-title\s*\{([^}]*)\}/.exec(stylesCss);
    assert(titleRule, '.vertical-opacity-title must be styled');
    assert(/grid-column:\s*1/.test(titleRule[1]) && /grid-row:\s*1\s*\/\s*-1/.test(titleRule[1]),
        'the title is the left column of the slim card, next to the slider');
    const layerRule = /\.vertical-opacity-layer\s*\{([^}]*)\}/.exec(stylesCss);
    assert(layerRule, '.vertical-opacity-layer must be styled');
    assert(/writing-mode:\s*vertical-rl/.test(layerRule[1]) && /rotate\(180deg\)/.test(layerRule[1]),
        'the layer name is written vertically, bottom to top');
    // JS reduces the vertical title to the layer's initials: max 3
    // letters, without years („Austrian Map 1910” → „AM”).
    const voSrc = fs.readFileSync(path.join(__dirname, 'js', 'vertical-opacity-control.js'), 'utf8');
    assert(/LAYER_INITIALS_MAX\s*=\s*3/.test(voSrc),
        'the vertical layer title caps at 3 initials');

    // The card is narrow frosted glass: semi-transparent fill + blur, no
    // purple radial gradient left.
    const controlRule = /\.vertical-opacity-control\s*\{([^}]*)\}/.exec(stylesCss);
    assert(controlRule, '.vertical-opacity-control must be styled');
    assert(/width:\s*38px/.test(controlRule[1]), 'the mirror card is slim (38px, matching the map control buttons)');
    assert(/backdrop-filter:\s*var\(--ctl-blur\)/.test(controlRule[1]), 'the card blurs what is behind it via --ctl-blur');
    assert(/background:\s*var\(--ctl-bg\)/.test(controlRule[1]) &&
        /border:\s*1px\s+solid\s+var\(--ctl-border\)/.test(controlRule[1]) &&
        !/radial-gradient/.test(controlRule[1]),
        'blurred semitransparent button-box material (--ctl-bg / --ctl-border)');

    // Percentage visible only while the opacity changes.
    assert(/\.vertical-opacity-control\[data-kind="opacity"\]\s+\.vertical-opacity-value\s*\{[^}]*visibility\s*:\s*hidden/.test(stylesCss),
        'the opacity percentage chip starts hidden');
    assert(/\.vertical-opacity-control\[data-kind="opacity"\]\s+\.vertical-opacity-value\.visible/.test(stylesCss),
        'the opacity percentage chip has a while-changing visible state');

    // Unified slim 3D-style pastel faded semitransparent orange sliders across
    // both the layer window (.transp-slider) and the vertical map mirrors
    // (.vertical-opacity-slider), while retaining the per-layer auxiliary vars.
    assert(/--slider-track-h:\s*3px/.test(stylesCss) &&
        /--slider-thumb-size:\s*12px/.test(stylesCss) &&
        /--slider-v-thumb-size:\s*13px/.test(stylesCss) &&
        /--slider-fill:\s*rgba\(242,\s*170,\s*121,\s*0\.52\)/.test(stylesCss) &&
        /--slider-thumb-bg:\s*rgba\(244,\s*176,\s*128,\s*0\.74\)/.test(stylesCss),
        'root defines the slim pastel faded semitransparent orange slider tokens');
    assert(/\.transp-slider[\s\S]{0,400}?var\(--slider-fill\)/.test(stylesCss) &&
        /\.vertical-opacity-slider\s*\{[\s\S]{0,450}?var\(--slider-fill\)/.test(stylesCss),
        'both layer-window sliders and vertical map sliders share the pastel orange fill');

    const rules = (stylesCss.match(/[^{}]+\{[^{}]*\}/g) || []).map(function (rule) {
        return { selector: rule.split('{')[0].trim(), body: rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')) };
    });
    function paletteOf(selectorPart) {
        const hit = rules.filter(r => r.selector.indexOf(selectorPart) !== -1 && /--dl-layer-colour/.test(r.body))[0];
        return hit ? hit.body.replace(/\s+/g, ' ') : '';
    }
    const palettes = {
        lidarScannerDistance: ['#8cff66', '#39ff14', '#lidarScannerRow'],
        archeoPotDistance: ['#a070e8', '#c4a0f0', '#archeoPotentialRow'],
        archReportDistance: ['#66c8ff', '#29b6f6', '#archReportRow']
    };
    Object.keys(palettes).forEach(function (id) {
        const [colour, strong, rowId] = palettes[id];
        const rowPalette = paletteOf(rowId);
        assert(rowPalette.indexOf('--dl-layer-colour: ' + colour) !== -1 &&
            rowPalette.indexOf('--dl-layer-strong: ' + strong) !== -1,
            rowId + ' must carry ' + colour + '/' + strong + ' (got: ' + rowPalette.slice(0, 120) + ')');
        const mirrorPalette = paletteOf('[data-owner="' + id + '"]');
        assert(mirrorPalette === rowPalette || mirrorPalette.indexOf(colour) !== -1,
            id + "'s vertical mirror must carry the same colour variables as its panel range");
    });
}

console.log('✅ test-vertical-opacity-control.js passed: layer click, vertical sync, century mirror, filtering and close behavior work.');
