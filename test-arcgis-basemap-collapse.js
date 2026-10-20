// Functional test for the retractable ArcGIS base-map list (bottom-left).
//
// The three base maps (Imagery / Topographic / Terrain) used to sit in a
// permanent block of buttons on the map. They now live in a RETRACTABLE
// list: the control shows one header row (the active base map) and the
// options unfold from it. This test runs the real control code from
// js/map-app.js inside jsdom and asserts the behaviour:
//
//   • the list is folded by default (one header line, the options hidden);
//   • the header names the ACTIVE base map;
//   • the header unfolds / refolds the list (aria-expanded follows);
//   • choosing a base map applies it AND folds the list again;
//   • a click elsewhere on the page and the Escape key fold it too;
//   • the Danish base maps, mirrored into the same control by
//     js/danish-layers.js, land INSIDE the foldable list.
//
// Run: node test-arcgis-basemap-collapse.js     (needs jsdom)

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
    JSDOM = require('jsdom').JSDOM;
} catch (e) {
    // jsdom is not vendored (node_modules/ is gitignored), so a fresh checkout
    // has no DOM. Skip rather than report a false failure.
    console.log('SKIP — jsdom is not installed.');
    console.log('       npm i --no-save jsdom   then re-run to exercise the control.');
    process.exit(0);
}

const vm = require('vm');
const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const appJs = read('js/map-app.js');
const danishJs = read('js/danish-layers.js');
const indexHtml = read('index.html');

/* ── the code under test, lifted out of js/map-app.js ──────────────────────
 * Two blocks are needed: the labels + the sync helper (which paints the
 * active state and the header caption) and the control factory itself. */
function slice(source, from, to) {
    const start = source.indexOf(from);
    assert.ok(start !== -1, 'the source block "' + from + '" must exist');
    const end = source.indexOf(to, start);
    assert.ok(end !== -1, 'the source block "' + to + '" must exist');
    return source.slice(start, end + to.length);
}

/* The labels + the sync helper, but NOT the real setArcgisBasemap — the test
 * stubs that one, so it can see which base map the control asks for. */
const HELPERS = slice(appJs, 'var ARCGIS_BASEMAP_LABELS = {', 'window.setArcgisBasemap = function (key) {')
    .replace(/window\.setArcgisBasemap = function \(key\) \{$/, '');
/* The whole factory IIFE, from its opening to the `})();` that closes it. */
const FACTORY_START = appJs.indexOf('(function addArcgisBasemapControl() {');
assert.ok(FACTORY_START !== -1, 'the basemap control factory must exist');
const FACTORY_END = appJs.indexOf('})();', appJs.indexOf('control.addTo(map);', FACTORY_START));
assert.ok(FACTORY_END !== -1, 'the basemap control factory must be closed');
const FACTORY = appJs.slice(FACTORY_START, FACTORY_END + '})();'.length);

/* ── a DOM + just enough Leaflet to run the control ─────────────────────── */
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="detectlab-map"></div></body></html>',
    { pretendToBeVisual: true, url: 'https://detectlab.eu/' });
const win = dom.window;

const fakeLeaflet = {
    DomUtil: {
        create(tag, className, parent) {
            const el = win.document.createElement(tag);
            if (className) el.className = className;
            if (parent) parent.appendChild(el);
            return el;
        }
    },
    control(options) {
        return {
            options,
            onAdd: null,
            addTo(map) {
                const el = this.onAdd(map);
                // The real Leaflet puts the control in the map's corner; the
                // document is what the outside-click handler needs.
                win.document.getElementById('detectlab-map').appendChild(el);
                this._el = el;
                return this;
            }
        };
    }
};

const applied = [];
const sandbox = {
    window: win,
    document: win.document,
    L: fakeLeaflet,
    map: { hasLayer: () => false, addLayer() {}, removeLayer() {} },
    ARCGIS_BASEMAPS: {
        imagery: { layers: [] },
        topographic: { layers: [] },
        terrain: { layers: [] }
    },
    _arcgisCurrentBasemap: 'imagery',
    applied,
    console
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* The real module exposes the switch through the map's global API; here it
 * is the stub the control calls when an option is picked. It repaints the
 * control the way the real one does, so the header caption is checked too. */
vm.runInContext('window.setArcgisBasemap = function (key) { applied.push(key); ' +
    '_syncArcgisBasemapControl(key); return key; };' +
    'window.getArcgisBasemap = function () { return "imagery"; };', sandbox);
vm.runInContext(HELPERS, sandbox);
vm.runInContext(FACTORY, sandbox);

const ctrl = win.document.getElementById('arcgisBasemapCtrl');
assert.ok(ctrl, 'the basemap control is created');
const header = win.document.getElementById('arcgisBasemapToggle');
const list = win.document.getElementById('arcgisBasemapList');
assert.ok(header, 'the control has a header that folds the list');
assert.ok(list, 'the control has a list with the base-map options');
assert.strictEqual(header.tagName, 'BUTTON', 'the header is a real button (keyboard operable)');

function isOpen() { return ctrl.classList.contains('is-open'); }
function press(el) {
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickOutside() {
    win.document.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

/* 1. Folded by default — the control is one line until the header is used. */
assert.strictEqual(isOpen(), false, 'the list starts folded');
assert.strictEqual(header.getAttribute('aria-expanded'), 'false', 'the header announces the folded state');
assert.strictEqual(list.getAttribute('aria-hidden'), 'true', 'the folded list is hidden from assistive tech');
const options = list.querySelectorAll('[data-arcgis-basemap]');
assert.strictEqual(options.length, 3, 'the list holds the three ArcGIS base maps');
assert.deepStrictEqual(Array.from(options).map((b) => b.getAttribute('data-arcgis-basemap')),
    ['imagery', 'topographic', 'terrain'], 'Imagery / Topographic / Terrain, in order');

/* 2. The header names the active base map, so the map is readable while
 *    the list is folded. */
const caption = header.querySelector('.arcgis-basemap-header-label');
assert.ok(caption, 'the header carries a caption');
assert.strictEqual(caption.textContent, 'Imagery ArcGIS', 'the caption names the active base map');

/* 3. The header unfolds and refolds the list. */
press(header);
assert.strictEqual(isOpen(), true, 'the header unfolds the list');
assert.strictEqual(header.getAttribute('aria-expanded'), 'true', 'aria-expanded follows the state');
assert.strictEqual(list.getAttribute('aria-hidden'), 'false', 'the unfolded list is exposed');
press(header);
assert.strictEqual(isOpen(), false, 'the header folds the list again');

/* 4. Choosing a base map applies it and folds the list again. */
press(header);
options[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
assert.deepStrictEqual(applied, ['topographic'], 'the picked base map is applied');
assert.strictEqual(isOpen(), false, 'a chosen base map folds the list again');
assert.strictEqual(caption.textContent, 'Topographic ArcGIS',
    'the retracted header now names the base map that was just chosen');
assert.ok(options[1].classList.contains('active'), 'the chosen option is marked active');

/* 5. A click elsewhere on the page folds the list. */
press(header);
assert.strictEqual(isOpen(), true, 'the list is open');
clickOutside();
assert.strictEqual(isOpen(), false, 'a click outside folds the list');

/* 6. Escape folds the list. */
press(header);
win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
assert.strictEqual(isOpen(), false, 'Escape folds the list');

/* 7. The list can be driven from script (the API is global, like the
 *    rest of the map's controls). */
assert.strictEqual(typeof win.setArcgisBasemapListOpen, 'function', 'the list can be opened from script');
win.setArcgisBasemapListOpen(true);
assert.strictEqual(isOpen(), true, 'setArcgisBasemapListOpen(true) unfolds the list');
win.setArcgisBasemapListOpen(false);
assert.strictEqual(isOpen(), false, 'setArcgisBasemapListOpen(false) folds the list');

/* 8. Denmark has its own themed panel rows; its module must not inject base
 *    maps into the unrelated global ArcGIS switcher. */
assert.ok(!/arcgis-basemap/.test(danishJs),
    'the Danish layer module stays independent of the ArcGIS basemap control');
assert.ok(danishJs.includes("var GROUP_ROW_ID = 'danishRow'"),
    'the Danish layers keep their own country group row');
assert.ok(indexHtml.includes('id="danishRow"') && indexHtml.includes('id="danishSubLayers"'),
    'the independent Danish panel mount points remain in index.html');

/* 9. The list is styled as a foldable block: hidden by default, shown when
 *    the control carries the open state. */
const styles = indexHtml.slice(indexHtml.indexOf('/* ── ArcGIS basemap switcher'));
assert.ok(/\.arcgis-basemap-list\s*\{[^}]*display:\s*none/.test(styles),
    'the list is hidden while the control is folded');
assert.ok(/\.arcgis-basemap-ctrl\.is-open \.arcgis-basemap-list\s*\{[^}]*display:\s*block/.test(styles),
    'the list is shown when the control is unfolded');
assert.ok(/\.arcgis-basemap-header\s*\{[^}]*display:\s*flex/.test(styles),
    'the header is its own row (icon + caption + chevron)');
assert.ok(/\.arcgis-basemap-ctrl\.is-open \.arcgis-basemap-chevron\s*\{[^}]*transform:\s*rotate\(180deg\)/.test(styles),
    'the chevron turns around when the list is unfolded');
assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.arcgis-basemap-chevron\s*\{[^}]*transition:\s*none/.test(styles),
    'reduced motion disables the chevron animation');

console.log('OK: the ArcGIS base-map list folds and unfolds correctly.');
