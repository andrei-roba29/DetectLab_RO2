/*
 * test-uk-heritage-free-sublayers.js
 * ───────────────────────────────────────────────────────────────────────────
 * The UK heritage registers are a FREE country group, and every register is a
 * full sublayer row.
 *
 * What was broken
 * ---------------
 * The group was a bare `.country-section-list` whose children were plain rows
 * carrying no `data-category`. The Free/Premium tabs gate
 * `.transp-layer-row[data-category]` (js/map-app.js switchLayerTab() keeps an
 * `.active` marker on every `[data-category]` node) and `.country-section-list`
 * is `display:contents`, so the UK heritage block was listed in BOTH tabs — as
 * a free layer and again as a premium one. The rows themselves were custom
 * markup: a checkbox and a status line, no opacity slider, no per-source ⓘ.
 *
 * What this test locks down
 * -------------------------
 *   1. index.html: the group is one Romania-style `.transp-layer-row` with
 *      `data-category="free"` (no `.country-section-list`), carrying the title,
 *      the group ⓘ, the expand chevron, the master switch, the group opacity
 *      slider and the `#ukHeritageSubLayers` column.
 *   2. css/styles.css: the register rows carry their own Free/Premium gate
 *      (`[data-category]` + `.active`) and the country gate, so a register can
 *      never be displayed outside the Free tab / outside the UK view.
 *   3. js/uk-heritage-layers.js (run against a stub DOM + stub Leaflet): it
 *      builds exactly one row per register, and every row has its own on/off
 *      switch, its own opacity slider, its own percentage badge and its own ⓘ
 *      that names that register's provider/licence — never the group's.
 *   4. The switches, the sliders and the master switch only touch the source
 *      they belong to; the sliders repaint instead of re-querying, and the
 *      group is gated to GB.
 *   5. Cache-busting: index.html and sw.js request/pre-cache the same URLs and
 *      the shell cache is bumped.
 *
 * No network, account or npm dependency. Usage: node test-uk-heritage-free-sublayers.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html');
const css = read('css/styles.css');
const sw = read('sw.js');
const moduleSource = read('js/uk-heritage-layers.js');

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

console.log('[UK heritage] free group · per-register switch + slider + ⓘ · tab gate');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. THE PANEL MARKUP — a free layer row, not a `country-section-list`
 * ══════════════════════════════════════════════════════════════════════════ */

const groupStart = html.indexOf('id="ukHeritageRow"');
check(groupStart > 0, 'index.html declares #ukHeritageRow');
const groupTagStart = html.lastIndexOf('<div', groupStart);
const groupTag = html.slice(groupTagStart, html.indexOf('>', groupStart) + 1);

check(/class="[^"]*\btransp-layer-row\b[^"]*"/.test(groupTag),
    'the UK group is a real .transp-layer-row — the same box as every other layer row');
check(/data-category="free"/.test(groupTag),
    'the UK group declares data-category="free", so the Free/Premium tabs gate it directly');
check(!/country-section-list/.test(groupTag),
    'the UK group is no longer a bare .country-section-list (that is what leaked into Premium)');
check(/class="[^"]*\bactive\b[^"]*"/.test(groupTag),
    'the UK group starts with the Free tab marker (.active), like the other free rows');

/* The group's own chrome: title, ⓘ, chevron, master switch, opacity slider. */
const groupEnd = html.indexOf('<!-- Suomi / Finland', groupStart);
check(groupEnd > groupStart, 'the UK group block is delimited by the next country block');
const groupHtml = html.slice(groupTagStart, groupEnd);

check(/<span[^>]*data-key="layer_uk_heritage"[^>]*id="ukHeritageTitle"[^>]*>/.test(groupHtml),
    'the group title travels through js/translations.js (data-key)');
check(/showUkHeritageGroupInfo\(\)/.test(groupHtml),
    'the group carries its own ⓘ (every source, licence and zoom limit)');
check(/id="ukHeritageExpandBtn"/.test(groupHtml) && /id="ukHeritageExpandIcon"/.test(groupHtml),
    'the group carries the expand/collapse chevron of the other groups');
check(/id="ukHeritageToggle"/.test(groupHtml) && /toggleUkHeritageLayers\(this\.checked\)/.test(groupHtml),
    'the group carries a master on/off switch');
check(/id="ukHeritageOpacitySlider"/.test(groupHtml) && /setUkHeritageOpacity\(this\.value\)/.test(groupHtml),
    'the group carries the group opacity slider');
check(/id="ukHeritagePct"/.test(groupHtml), 'the group slider has its .pct badge');
check(/id="ukHeritageSubLayers"/.test(groupHtml),
    'the group exposes the #ukHeritageSubLayers column the module fills');
check(/class="apm-toggle-switch"/.test(groupHtml) && /class="apm-toggle-track"/.test(groupHtml),
    'the master switch is the shared pill switch, not a custom control');
check(/class="transp-slider"/.test(groupHtml), 'the group slider is the shared .transp-slider');

/* The old leaked structure is gone. */
check(!/<div id="ukHeritageRow" class="country-section-list"/.test(html),
    'the display:contents container that duplicated the layer in Premium is gone');
check((html.match(/id="ukHeritageRow"/g) || []).length === 1,
    'there is exactly one UK heritage group in the panel');

/* ══════════════════════════════════════════════════════════════════════════
 * 2. THE CSS GATES — free tab only, United Kingdom only
 * ══════════════════════════════════════════════════════════════════════════ */

check(/\.uk-heritage-sublayer\[data-category\]\s*\{\s*display:\s*none\s*!important/.test(css),
    'a register row with no tab marker is hidden');
check(/\.uk-heritage-sublayer\[data-category\]\.active\s*\{\s*display:\s*flex\s*!important/.test(css),
    'a register row is displayed only when the current tab marked it .active');
check(/#transpPanel #ukHeritageRow\.country-layer-unavailable/.test(css),
    'the group is hidden outside the United Kingdom view');
check(/#transpPanel \.uk-heritage-sublayer\.country-layer-unavailable/.test(css),
    'the register rows are hidden outside the United Kingdom view');
check(/\.transp-layer-row\[data-category\]\s*\{\s*display:\s*none\s*!important/.test(css),
    'the shared tab gate that the group row now uses is still in place');
check(/\.uk-heritage-provider\s*\{/.test(css),
    'each row can print its provider (Historic England / RCAHMW / Heneb / Cadw)');
check(/\.uk-heritage-status\.is-error/.test(css), 'the failure state of a register row is styled');
check(/#transpPanel \.uk-heritage-sublayer \.apm-toggle-switch input:focus-visible/.test(css),
    'the generated switches stay keyboard-visible');

/* ══════════════════════════════════════════════════════════════════════════
 * 3. THE MODULE — one row per register, own switch/slider/ⓘ
 * ══════════════════════════════════════════════════════════════════════════ */

/* A minimal DOM: elements, attributes, class list, style, listeners and the
 * descendant selector the module uses for the tab bar. */
function makeDom() {
    const byId = Object.create(null);

    class ClassList {
        constructor(el) { this.el = el; this.set = new Set(); }
        add() { Array.prototype.forEach.call(arguments, (c) => c && this.set.add(c)); this.sync(); }
        remove() { Array.prototype.forEach.call(arguments, (c) => this.set.delete(c)); this.sync(); }
        contains(c) { return this.set.has(c); }
        toggle(c, force) {
            const on = force === undefined ? !this.set.has(c) : !!force;
            if (on) this.set.add(c); else this.set.delete(c);
            this.sync();
            return on;
        }
        sync() { this.el._className = Array.from(this.set).join(' '); }
        get value() { return Array.from(this.set).join(' '); }
    }

    class Element {
        constructor(tag) {
            this.tagName = String(tag || 'div').toUpperCase();
            this.children = [];
            this.attributes = Object.create(null);
            this.style = {};
            this.listeners = Object.create(null);
            this.classList = new ClassList(this);
            this.parentNode = null;
            this._text = '';
            this._html = '';
        }
        get className() { return this.classList.value; }
        set className(value) {
            this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
            this.classList.sync();
        }
        get id() { return this.attributes.id || ''; }
        set id(value) { this.setAttribute('id', value); }
        setAttribute(key, value) {
            this.attributes[key] = String(value);
            if (key === 'id') byId[String(value)] = this;
            if (key === 'style') this.applyStyleString(value);
            /* A real DOM keeps `class` and `classList` in sync; so must the stub. */
            if (key === 'class') {
                this.classList.set = new Set(String(value || '').split(/\s+/).filter(Boolean));
                this.classList.sync();
            }
        }
        getAttribute(key) {
            return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
        }
        hasAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attributes, key); }
        removeAttribute(key) { delete this.attributes[key]; }
        applyStyleString(value) {
            String(value || '').split(';').forEach((part) => {
                const at = part.indexOf(':');
                if (at < 0) return;
                const key = part.slice(0, at).trim();
                const val = part.slice(at + 1).trim();
                if (!key) return;
                this.style[key.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = val;
            });
        }
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }
        get textContent() {
            if (this._text) return this._text;
            if (!this.children.length) return '';
            return this.children.map((child) => child.textContent).join('');
        }
        set textContent(value) { this._text = String(value == null ? '' : value); this.children = []; }
        get innerHTML() { return this._html; }
        set innerHTML(value) { this._html = String(value == null ? '' : value); this._text = ''; this.children = []; }
        set type(value) { this.attributes.type = value; }
        set checked(value) { this._checked = !!value; }
        get checked() { return !!this._checked; }
        set indeterminate(value) { this._indeterminate = !!value; }
        get indeterminate() { return !!this._indeterminate; }
        set value(value) { this.attributes.value = String(value); }
        get value() { return this.attributes.value; }
        get scrollHeight() { return 40 * (this.children.length || 1); }
        get offsetHeight() { return 20; }
        addEventListener(type, handler) { (this.listeners[type] || (this.listeners[type] = [])).push(handler); }
        dispatch(type, event) {
            const ev = event || {};
            ev.target = ev.target || this;
            ev.preventDefault = ev.preventDefault || function () {};
            ev.stopPropagation = ev.stopPropagation || function () {};
            (this.listeners[type] || []).forEach((handler) => handler(ev));
        }
        get dataset() {
            const data = {};
            Object.keys(this.attributes).forEach((key) => {
                if (key.indexOf('data-') !== 0) return;
                data[key.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = this.attributes[key];
            });
            return data;
        }
        matches(selector) { return matchesCompound(this, selector); }
        querySelectorAll(selector) { return querySelectorAll(this, selector); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        contains(node) {
            for (let n = node; n; n = n.parentNode) if (n === this) return true;
            return false;
        }
    }

    function matchesCompound(el, compound) {
        const selector = String(compound).trim();
        if (!selector) return false;
        const tag = (/^([a-zA-Z]*)/.exec(selector) || [])[1] || '';
        if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
        const classes = (selector.match(/\.[A-Za-z0-9_-]+/g) || []).map((c) => c.slice(1));
        if (!classes.every((c) => el.classList.contains(c))) return false;
        const attrs = selector.match(/\[[^\]]+\]/g) || [];
        for (let i = 0; i < attrs.length; i++) {
            const match = /^\[\s*([A-Za-z0-9_:-]+)\s*(?:=\s*["']?([^"'\]]*)["']?\s*)?\]$/.exec(attrs[i]);
            if (!match) return false;
            const value = el.getAttribute(match[1]);
            if (value === null) return false;
            if (match[2] !== undefined && value !== match[2]) return false;
        }
        return true;
    }

    function descendants(root, out) {
        root.children.forEach((child) => {
            out.push(child);
            descendants(child, out);
        });
        return out;
    }

    function querySelectorAll(root, selector) {
        const parts = String(selector).trim().split(/\s+/);
        let candidates = [root];
        parts.forEach((part) => {
            const next = [];
            candidates.forEach((node) => {
                descendants(node, []).forEach((child) => {
                    if (matchesCompound(child, part) && next.indexOf(child) < 0) next.push(child);
                });
                if (matchesCompound(node, part) && next.indexOf(node) < 0) next.push(node);
            });
            candidates = next;
        });
        return candidates;
    }

    const documentElement = new Element('html');
    documentElement.setAttribute('lang', 'en');
    const body = new Element('body');

    const document = {
        readyState: 'complete',
        documentElement: documentElement,
        body: body,
        listeners: Object.create(null),
        createElement: (tag) => new Element(tag),
        getElementById: (id) => byId[id] || null,
        querySelector: (selector) => querySelectorAll(body, selector)[0] || null,
        querySelectorAll: (selector) => querySelectorAll(body, selector),
        addEventListener(type, handler) {
            (this.listeners[type] || (this.listeners[type] = [])).push(handler);
        },
        dispatch(type, detail) {
            const ev = { detail: detail, target: body, preventDefault() {}, stopPropagation() {} };
            (this.listeners[type] || []).forEach((handler) => handler(ev));
        }
    };

    return { document, body, Element, byId };
}

/* The panel skeleton the module expects (built from the ids index.html owns). */
const dom = makeDom();
const { document, body, Element, byId } = dom;

/* Tab bar: switchLayerTab() keeps `.active` on the Free button. */
const tabs = new Element('div');
tabs.className = 'transp-panel-tabs';
const freeTab = new Element('button');
freeTab.className = 'tab-btn active';
freeTab.setAttribute('data-tab', 'free');
const premiumTab = new Element('button');
premiumTab.className = 'tab-btn';
premiumTab.setAttribute('data-tab', 'premium');
tabs.appendChild(freeTab);
tabs.appendChild(premiumTab);

const group = new Element('div');
group.className = 'transp-layer-row active uk-heritage-group';
group.setAttribute('id', 'ukHeritageRow');
group.setAttribute('data-category', 'free');

const masterInput = new Element('input');
masterInput.setAttribute('type', 'checkbox');
masterInput.setAttribute('id', 'ukHeritageToggle');
masterInput.setAttribute('onchange', 'toggleUkHeritageLayers(this.checked)');
group.appendChild(masterInput);

const expandIcon = new Element('svg');
expandIcon.setAttribute('id', 'ukHeritageExpandIcon');
group.appendChild(expandIcon);
const expandBtn = new Element('button');
expandBtn.setAttribute('id', 'ukHeritageExpandBtn');
group.appendChild(expandBtn);

const groupPct = new Element('span');
groupPct.className = 'pct';
groupPct.setAttribute('id', 'ukHeritagePct');
group.appendChild(groupPct);

const groupSlider = new Element('input');
groupSlider.setAttribute('type', 'range');
groupSlider.setAttribute('id', 'ukHeritageOpacitySlider');
groupSlider.setAttribute('value', '80');
group.appendChild(groupSlider);

const mount = new Element('div');
mount.setAttribute('id', 'ukHeritageSubLayers');
group.appendChild(mount);

body.appendChild(tabs);
body.appendChild(group);

/* Stub Leaflet + map + network. */
const geoJsonLayers = [];
const panes = {};
const mapLayers = new Set();
const map = {
    createPane(id) { panes[id] = { style: {} }; return panes[id]; },
    getPane(id) { return panes[id]; },
    hasLayer(layer) { return mapLayers.has(layer); },
    addLayer(layer) { mapLayers.add(layer); return this; },
    removeLayer(layer) { mapLayers.delete(layer); return this; },
    on() {},
    getZoom() { return 14; },
    getBounds() { return { getWest: () => -3.2, getSouth: () => 51.4, getEast: () => -0.1, getNorth: () => 52.2 }; }
};

function FakeGeoJSON(options) {
    this.options = options || {};
    this.features = [];
    this.children = [];
}
FakeGeoJSON.prototype.addTo = function (target) { target.addLayer(this); return this; };
FakeGeoJSON.prototype.clearLayers = function () { this.features = []; this.children = []; };
FakeGeoJSON.prototype.addData = function (collection) {
    this.features = (collection && collection.features) || [];
    this.children = this.features.map((feature) => ({
        feature: feature,
        style: {},
        setStyle(next) { this.style = Object.assign({}, this.style, next); }
    }));
};
FakeGeoJSON.prototype.eachLayer = function (fn) { this.children.forEach(fn); };
FakeGeoJSON.prototype.setStyle = function () {};

const L = {
    geoJSON(data, options) {
        const layer = new FakeGeoJSON(options);
        geoJsonLayers.push(layer);
        return layer;
    },
    circleMarker(latlng, options) { return { latlng: latlng, options: options, setStyle() {} }; },
    Util: { extend: (target, source) => Object.assign(target || {}, source || {}) }
};

const fetchCalls = [];
const FEATURE = { type: 'Feature', geometry: { type: 'Point', coordinates: [-1.5, 51.5] }, properties: { Name: 'Test site', PRN: '1234' } };
function fetchStub(url) {
    const href = String(url);
    fetchCalls.push(href);
    if (/\?f=json/.test(href)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ layers: [{ id: 0 }, { id: 1 }] }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ features: [FEATURE] }) });
}

const shownInfo = [];
const sandbox = {
    console: { warn() {}, error() {}, info() {} },
    document,
    L,
    _dlMap: map,
    URLSearchParams,
    fetch: fetchStub,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    AbortController,
    Promise,
    showLayerInfo(...args) { shownInfo.push(args); },
    _currentLang: () => 'en'
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(moduleSource, sandbox, { filename: 'js/uk-heritage-layers.js' });

const API = sandbox.DetectLabUkHeritage;
check(!!API, 'the module exposes window.DetectLabUkHeritage');
check(typeof sandbox.toggleUkHeritageLayers === 'function' &&
    typeof sandbox.setUkHeritageOpacity === 'function' &&
    typeof sandbox.toggleUkHeritageSubLayers === 'function' &&
    typeof sandbox.showUkHeritageGroupInfo === 'function',
    'the four inline handlers index.html uses are global functions');

const SOURCES = API.sources;
check(Array.isArray(SOURCES) && SOURCES.length === 7,
    'seven registers are described (NHLE + RCAHMW + Heneb + four Cadw registers), got ' + (SOURCES || []).length);
check(SOURCES.every((s) => s.label && s.provider && s.attribution && s.info && s.url),
    'every register carries its own label, provider, attribution and info text');
check(new Set(SOURCES.map((s) => s.provider)).size === 4,
    'the four providers stay distinct (Historic England · RCAHMW · Heneb · Cadw)');
check(new Set(SOURCES.map((s) => s.colour)).size === SOURCES.length,
    'every register keeps its own colour');
check(SOURCES.every((s) => /^https:\/\/services/.test(s.url) && /FeatureServer/.test(s.url)),
    'every register queries its own ArcGIS FeatureServer');

/* ── the rows the module built ───────────────────────────────────────────── */
check(mount.children.length === SOURCES.length,
    'the module builds exactly one row per register (' + mount.children.length + ')');
const rows = mount.children;
check(rows.every((row) => row.classList.contains('uk-heritage-sublayer')),
    'every row is a .uk-heritage-sublayer');
check(rows.every((row) => row.classList.contains('dl-sublayer-row')),
    'every row takes the shared glass .dl-sublayer-row box of the other catalogues');
check(rows.every((row) => row.getAttribute('data-category') === 'free'),
    'every register row is data-category="free" — the free layer only');
check(rows.every((row) => row.classList.contains('active')),
    'every register row is marked .active while the Free tab is the current tab');
check(!/['"]premium['"]/.test(moduleSource),
    'the module never creates a premium row or a premium source');

rows.forEach((row) => {
    const id = row.getAttribute('data-uk-heritage-source');
    const source = SOURCES.filter((s) => s.id === id)[0];
    check(!!source, 'row ' + id + ' maps to a described register');
    const input = row.querySelectorAll('input[type="checkbox"]')[0];
    check(!!input && input.id === 'ukHeritageToggle-' + id,
        id + ' has its own on/off switch');
    check(!!row.querySelectorAll('.apm-toggle-track').length, id + ' uses the shared pill switch');
    const slider = row.querySelectorAll('input[type="range"]')[0];
    check(!!slider && slider.id === 'ukHeritageOpacity-' + id,
        id + ' has its own opacity slider');
    check(slider && slider.value === '80', id + ' slider starts at the shared 80%');
    const pct = byId['ukHeritagePct-' + id];
    check(!!pct && pct.textContent === '80%', id + ' has its own percentage badge');
    const info = row.querySelectorAll('button.layer-info-btn')[0];
    check(!!info && info.getAttribute('data-uk-heritage-info') === id,
        id + ' has its own ⓘ button');
    check(!!byId['ukHeritageStatus-' + id], id + ' has its own status line');
    check(row.textContent.indexOf(source.provider) !== -1,
        id + ' prints its provider (' + source.provider + ')');
});

/* ── every ⓘ shows that register's own licence, not the group's ─────────── */
shownInfo.length = 0;
API.sourceInfo('heneb');
check(shownInfo.length === 1, 'the row ⓘ opens the layer-info panel');
const [infoTitle, infoCredits, infoBody] = shownInfo[0];
check(infoTitle === 'Historic Environment Record of Wales (Heneb)',
    'the row ⓘ is titled with the register, got: ' + infoTitle);
check(/Heneb/.test(infoCredits) && !/Historic England/.test(infoCredits),
    'the row ⓘ carries ONLY that register\'s attribution, got: ' + infoCredits);
check(/Provider: Heneb/.test(infoBody), 'the row ⓘ names that register\'s provider');
check(/zoom 13/i.test(infoBody), 'the row ⓘ names that register\'s zoom limit');

shownInfo.length = 0;
API.groupInfo();
check(shownInfo.length === 1 && /Historic England/.test(shownInfo[0][1]) && /Cadw/.test(shownInfo[0][1]),
    'the group ⓘ credits every provider');

/* ══════════════════════════════════════════════════════════════════════════
 * 4. BEHAVIOUR — independent switches, per-row sliders, GB-only
 * ══════════════════════════════════════════════════════════════════════════ */

(async () => {
    /* Let start()'s map-wait interval attach to the stub map. */
    await new Promise((resolve) => setTimeout(resolve, 320));
    check(!!panes.ukHeritagePane && panes.ukHeritagePane.style.zIndex === 621,
        'the registers get their own Leaflet pane at z-index 621');

    /* One switch on → exactly one layer on the map and one service queried. */
    fetchCalls.length = 0;
    API.setSource('nhle', true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(mapLayers.size === 1, 'switching the NHLE on adds exactly one layer');
    check(API.isActive('nhle') && !API.isActive('heneb'),
        'the registers switch independently');
    check(fetchCalls.some((url) => /National_Heritage_List_for_England_NHLE_v02_VIEW/.test(url)),
        'the NHLE is the service that was queried');
    check(!fetchCalls.some((url) => /YFaBqL5jL3y8fq7s/.test(url)),
        'the Welsh services are not queried by an England-only switch');
    check(rows[0].querySelectorAll('input[type="checkbox"]')[0].checked === true,
        'the NHLE row switch reflects the state');
    check(byId['ukHeritageStatus-nhle'].textContent === '2 features',
        'the NHLE row reports its own record count, got: ' + byId['ukHeritageStatus-nhle'].textContent);
    check(masterInput.indeterminate === true && masterInput.checked === false,
        'the master switch shows the mixed state');

    /* Per-row opacity: repaint, no new request. */
    fetchCalls.length = 0;
    const nhleLayer = geoJsonLayers[0];
    API.setSourceOpacity('nhle', 40);
    const painted = nhleLayer.children[0].style;
    check(Math.abs(painted.opacity - 0.36) < 1e-9,
        'the slider repaints the geometry (stroke opacity 0.9 × 40%), got ' + painted.opacity);
    check(fetchCalls.length === 0, 'moving a slider never re-queries the service');
    check(byId['ukHeritagePct-nhle'].textContent === '40%', 'the row badge follows its slider');

    /* A second, Welsh register: its own layer, its own service. */
    fetchCalls.length = 0;
    API.setSource('heneb', true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(mapLayers.size === 2, 'a second register adds a second layer');
    check(fetchCalls.some((url) => /Welsh_Historic_Environment_Records/.test(url)),
        'Heneb queries its own service');
    check(byId['ukHeritagePct-nhle'].textContent === '40%',
        'switching another register does not reset an existing opacity');

    /* The group slider applies to every register. */
    sandbox.setUkHeritageOpacity(60);
    check(SOURCES.every((s) => byId['ukHeritagePct-' + s.id].textContent === '60%'),
        'the group slider sets every register\'s opacity');
    check(byId.ukHeritagePct.textContent === '60%', 'the group badge follows the group slider');

    /* Master switch: on → every register, off → none. */
    sandbox.toggleUkHeritageLayers(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    check(SOURCES.every((s) => API.isActive(s.id)), 'the master switch turns every register on');
    check(mapLayers.size === SOURCES.length, 'every register layer is on the map');
    check(masterInput.checked === true && masterInput.indeterminate === false,
        'the master switch reads “all on”');

    sandbox.toggleUkHeritageLayers(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(SOURCES.every((s) => !API.isActive(s.id)), 'the master switch turns every register off');
    check(mapLayers.size === 0, 'nothing is left on the map');
    check(rows.every((row) => row.querySelectorAll('input[type="checkbox"]')[0].checked === false),
        'every row switch follows the master switch');

    /* Zoom guard: below the register's own minimum zoom nothing is queried. */
    fetchCalls.length = 0;
    map.getZoom = () => 7;
    API.setSource('listed', true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(byId['ukHeritageStatus-listed'].textContent === 'Zoom to 12+',
        'a register explains its own zoom limit instead of querying, got: ' +
        byId['ukHeritageStatus-listed'].textContent);
    check(!fetchCalls.some((url) => /Listed_Buildings/.test(url)),
        'no request is made below the register\'s minimum zoom');
    map.getZoom = () => 14;
    API.setSource('listed', false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(mapLayers.size === 0, 'switching a register off removes its own layer');

    /* Country gate: the registers exist only in the UK view. */
    document.dispatch('detectlab:country-selected', { iso: 'FR' });
    check(group.classList.contains('country-layer-unavailable'),
        'selecting another country hides the whole group');
    check(rows.every((row) => row.classList.contains('country-layer-unavailable')),
        'selecting another country hides every register row');
    check(group.getAttribute('aria-hidden') === 'true', 'the hidden group is aria-hidden');
    document.dispatch('detectlab:country-selected', { iso: 'GB' });
    check(!group.classList.contains('country-layer-unavailable'),
        'the group comes back for the United Kingdom');
    check(rows.every((row) => !row.classList.contains('country-layer-unavailable')),
        'the register rows come back for the United Kingdom');
    check(group.getAttribute('aria-hidden') === 'false', 'the visible group is not aria-hidden');

    /* ══════════════════════════════════════════════════════════════════════
     * 5. THE FREE/PREMIUM TABS
     *    switchLayerTab() removes `.active` from every [data-category] node
     *    and adds it back only to the nodes of the current tab. The group and
     *    the register rows are such nodes, so the Premium tab can never show
     *    them (the CSS gate in §2 hides the ones without `.active`).
     * ══════════════════════════════════════════════════════════════════════ */
    function switchLayerTab(tab) {
        document.querySelectorAll('.transp-panel-tabs button').forEach((btn) => {
            btn.classList.remove('active');
            if (btn.getAttribute('data-tab') === tab) btn.classList.add('active');
        });
        document.querySelectorAll('[data-category]').forEach((node) => {
            node.classList.remove('active');
            if (node.getAttribute('data-category') === tab) node.classList.add('active');
        });
    }

    switchLayerTab('premium');
    check(!group.classList.contains('active'), 'the group leaves the Premium tab');
    check(rows.every((row) => !row.classList.contains('active')),
        'no register row survives in the Premium tab');

    /* A rebuild (language switch) must not resurrect them in Premium. */
    document.dispatch('detectlab:langchange');
    const rebuilt = mount.children;
    check(rebuilt.length === SOURCES.length, 'the language rebuild re-creates the rows');
    check(rebuilt.every((row) => row.getAttribute('data-category') === 'free'),
        'the rebuilt rows are free rows');
    check(rebuilt.every((row) => !row.classList.contains('active')),
        'a rebuild while the Premium tab is open leaves every register inactive');
    check(!group.classList.contains('active'),
        'a rebuild while the Premium tab is open leaves the group inactive');

    switchLayerTab('free');
    check(rebuilt.every((row) => row.classList.contains('active')),
        'the registers appear in the Free tab');
    document.dispatch('detectlab:langchange');
    check(mount.children.every((row) => row.classList.contains('active')),
        'a rebuild inside the Free tab keeps the registers active');

    /* Switching the country away and back must keep the switches' state. */
    API.setSource('nhle', true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    document.dispatch('detectlab:country-selected', { iso: 'IE' });
    check(API.isActive('nhle'), 'the switch state survives a country change');
    document.dispatch('detectlab:country-selected', { iso: 'GB' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check(mapLayers.size === 1, 'coming back to the UK restores the layer that was on');

    /* The expand/collapse chevron. */
    sandbox.toggleUkHeritageSubLayers();
    check(mount.style.maxHeight === '0px' && expandIcon.style.transform === 'rotate(-90deg)',
        'the chevron collapses the register column');
    sandbox.toggleUkHeritageSubLayers();
    check(mount.style.opacity === '1', 'the chevron expands it again');

    /* ══════════════════════════════════════════════════════════════════════
     * 6. CACHE-BUSTING — index.html and sw.js agree on the live URLs
     * ══════════════════════════════════════════════════════════════════════ */
    const moduleUrl = (html.match(/js\/uk-heritage-layers\.js\?v=[^"']+/) || [])[0];
    check(!!moduleUrl, 'index.html requests a versioned uk-heritage-layers.js');
    check(sw.includes("'" + moduleUrl + "'"), 'sw.js pre-caches the exact module URL (' + moduleUrl + ')');
    const stylesUrl = (html.match(/href="(css\/styles\.css\?v=[^"]+)"/) || [])[1];
    check(!!stylesUrl && sw.includes("'" + stylesUrl + "'"),
        'sw.js pre-caches the exact stylesheet URL (' + stylesUrl + ')');
    const cacheNum = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    check(cacheNum >= 293, 'the service-worker shell is bumped for this release (got v' + cacheNum + ')');
    check(/layer_uk_heritage/.test(read('js/translations.js')),
        'the group title is translated (ro / en / da)');

    console.log('\n✓ ' + checks + ' checks passed — the UK heritage registers are a FREE group,');
    console.log('  every register with its own switch, slider and ⓘ, and they never reach Premium.');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
