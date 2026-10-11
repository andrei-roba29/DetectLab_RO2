// Test suite for the country dock — the slide-down country switcher glued
// under the map search bar, the World-hillshade overlay checkbox and the
// bottom-centre “Exit view” button of the locked country view.
// Covers js/country-dock.js, the country-switching/lock API added to
// js/globe-country-picker.js, the index.html markup and the sw.js shell.
// Usage: node test-country-dock.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Country dock + locked country view...');

/* ══════════════════════════════════════════════════════════════
   1. index.html: markup, assets, load order
   ══════════════════════════════════════════════════════════════ */
const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
['countryDock', 'countryDockBtn', 'countryDockCode', 'countryDockPanel', 'countryDockGrid',
 'countryDockName', 'countryDockClose', 'countryDockHillshade', 'countryDockHsInfo',
 'countryExitViewBtn', 'mapSearchResults'].forEach(function (id) {
    assert(indexHtml.includes('id="' + id + '"'), 'index.html contains #' + id);
});
assert(indexHtml.includes('css/country-dock.css?v=20261008'), 'index.html loads the dock css');
assert(indexHtml.includes('js/country-dock.js?v=20261010-hillshade-globe'), 'index.html loads the dock script');
// The dock talks to the gate, so the gate must be parsed first.
assert(indexHtml.indexOf('js/globe-country-picker.js?v=20261010-gate-imagery') <
    indexHtml.indexOf('js/country-dock.js?v=20261010-hillshade-globe'), 'globe gate loads before the dock');
assert(indexHtml.indexOf('js/country-dock.js?v=20261010-hillshade-globe') <
    indexHtml.indexOf('js/map-app.js?v=20261010-lidar-zoom-gate'), 'dock loads before map-app.js');
// The dock lives *inside* the search wrap so it stays glued to the search bar.
const wrapIdx = indexHtml.indexOf('id="mapSearchWrap"');
const dockIdx = indexHtml.indexOf('id="countryDock"');
assert(wrapIdx !== -1 && dockIdx > wrapIdx, 'the dock is nested in #mapSearchWrap');
assert(indexHtml.includes('data-key="country_dock_hillshade"'), 'hillshade label is translatable');
assert(indexHtml.includes('data-key="country_exit_view"'), 'exit view label is translatable');
assert(indexHtml.includes('country_exit_view') && /id="countryExitViewBtn"[^>]*hidden/.test(indexHtml),
    'the exit-view button starts hidden');
console.log('  ✓ index.html markup, assets and load order verified');

/* ══════════════════════════════════════════════════════════════
   2. sw.js: shell version + precache
   ══════════════════════════════════════════════════════════════ */
const swJs = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
// The world hillshade is a globe twin: it is attached right after it is created,
// and only when the globe base module is present (the call is guarded).
const dockJs = fs.readFileSync(path.join(__dirname, 'js/country-dock.js'), 'utf8');
assert(/L\.tileLayer\(HS_URL, \{[\s\S]*?\}\);\s*\n\s*\}\s*catch \(e\) \{[\s\S]*?attachTileTwin\(state\.hillshadeLayer\)/.test(dockJs),
    'the hillshade layer is attached as a globe twin after it is created');
assert(dockJs.includes("typeof globeBase.attachTileTwin === 'function'"), 'the twin attach is guarded when the globe module is absent');
assert(swJs.includes("'css/country-dock.css?v=20261008'"), 'sw.js precaches the dock css');
assert(swJs.includes("'js/country-dock.js?v=20261010-hillshade-globe'"), 'sw.js precaches the re-versioned dock script');
const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 173, 'sw.js cache is v173 or newer (got v' + shellVersion + ')');
console.log('  ✓ sw.js shell v' + shellVersion + ' precaches the dock');

/* ══════════════════════════════════════════════════════════════
   3. translations keep the dock keys in both languages
   ══════════════════════════════════════════════════════════════ */
const transJs = fs.readFileSync(path.join(__dirname, 'js/translations.js'), 'utf8');
['country_dock_title', 'country_dock_hint', 'country_dock_hillshade', 'country_exit_view']
    .forEach(function (k) {
        const hits = transJs.split(k).length - 1;
        assert(hits >= 2, 'translations.js has ' + k + ' in EN and RO (got ' + hits + ')');
    });
console.log('  ✓ dock translation keys present in EN + RO');

/* ══════════════════════════════════════════════════════════════
   4. Sandbox infrastructure (mini DOM + fake Leaflet)
   ══════════════════════════════════════════════════════════════ */
function makeEl(id) {
    const el = {
        id: id || '',
        children: [],
        attrs: {},
        classes: {},
        style: {},
        textContent: '',
        checked: false,
        parentNode: null,
        options: [],          // <select> stub, mirrors a real element
        _listeners: {},
        setAttribute: function (k, v) { el.attrs[k] = String(v); },
        getAttribute: function (k) {
            return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null;
        },
        removeAttribute: function (k) { delete el.attrs[k]; },
        addEventListener: function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
        removeEventListener: function () {},
        appendChild: function (c) { c.parentNode = el; el.children.push(c); return c; },
        contains: function (node) {
            let p = node;
            while (p) { if (p === el) return true; p = p.parentNode; }
            return false;
        },
        fire: function (type, ev) {
            const e = ev || {};
            e.type = type;
            if (!e.target) e.target = el;
            (el._listeners[type] || []).forEach(function (fn) { fn(e); });
            return e;
        }
    };
    // className ↔ classList stay in sync, like a real element.
    let className = '';
    Object.defineProperty(el, 'className', {
        get: function () { return className; },
        set: function (v) {
            className = String(v || '');
            el.classes = {};
            className.split(/\s+/).forEach(function (c) { if (c) el.classes[c] = true; });
        }
    });
    el.classList = {
        add: function (c) { el.classes[c] = true; },
        remove: function (c) { delete el.classes[c]; },
        toggle: function (c, force) {
            const on = (force === undefined) ? !el.classes[c] : !!force;
            if (on) el.classes[c] = true; else delete el.classes[c];
            return on;
        },
        contains: function (c) { return !!el.classes[c]; }
    };
    let html = '';
    Object.defineProperty(el, 'innerHTML', {
        get: function () { return html; },
        set: function (v) { html = v; if (v === '') el.children.length = 0; }
    });
    return el;
}

function makeBounds(sw, ne) {
    return {
        _w: sw, _e: ne,
        pad: function (r) {
            const dLon = (ne.lng - sw.lng) * r, dLat = (ne.lat - sw.lat) * r;
            return makeBounds({ lng: sw.lng - dLon, lat: sw.lat - dLat },
                { lng: ne.lng + dLon, lat: ne.lat + dLat });
        }
    };
}

function makeLeaflet() {
    const L = {
        created: [],
        latLng: function (lat, lng) { return { lat: lat, lng: lng }; },
        latLngBounds: function (sw, ne) { return makeBounds(sw, ne); },
        tileLayer: function (url, opts) {
            const layer = {
                url: url, options: opts || {}, setOpacity: function () {},
                addTo: function (m) { m.addLayer(layer); return layer; }
            };
            L.created.push(layer);
            return layer;
        }
    };
    return L;
}

function makeMap() {
    const m = {
        options: { minZoom: 2, maxZoom: 20 },
        _maxBounds: undefined,
        _minZoom: 2,
        _maxZoom: 20,
        _zoom: 5,
        _panes: {},
        _layers: [],
        _handlers: {},
        _fit: null,
        _view: null,
        getBoundsZoom: function () { return 7.2; },
        setMaxBounds: function (b) { m._maxBounds = b; },
        getMaxBounds: function () { return m._maxBounds; },
        setMinZoom: function (z) { m._minZoom = z; m.options.minZoom = z; },
        getMinZoom: function () { return m._minZoom; },
        setMaxZoom: function (z) { m._maxZoom = z; m.options.maxZoom = z; },
        getMaxZoom: function () { return m._maxZoom; },
        getZoom: function () { return m._zoom; },
        setZoom: function (z) { m._zoom = z; },
        fitBounds: function (bounds, opts) {
            m._fit = { bounds: bounds, opts: opts };
            if (opts && typeof opts.maxZoom === 'number') m._zoom = opts.maxZoom;
            return m;
        },
        setView: function (center, zoom) { m._view = { center: center, zoom: zoom }; m._zoom = zoom; return m; },
        createPane: function (n) { m._panes[n] = { style: {} }; },
        getPane: function (n) { return m._panes[n] || null; },
        hasLayer: function (l) { return m._layers.indexOf(l) !== -1; },
        addLayer: function (l) { if (!m.hasLayer(l)) m._layers.push(l); return m; },
        removeLayer: function (l) { const i = m._layers.indexOf(l); if (i >= 0) m._layers.splice(i, 1); return m; },
        on: function (t, fn) { (m._handlers[t] = m._handlers[t] || []).push(fn); return m; },
        off: function (t, fn) {
            const arr = m._handlers[t] || [];
            const i = arr.indexOf(fn);
            if (i >= 0) arr.splice(i, 1);
            return m;
        },
        fire: function (t, e) { (m._handlers[t] || []).slice().forEach(function (fn) { fn(e || {}); }); }
    };
    return m;
}

function makeSandbox(elMap) {
    const listeners = {};
    const dispatched = {};
    const sandbox = {
        console: console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        performance: { now: () => Date.now() },
        fetch: function () { return Promise.reject(new Error('no network in tests')); },
        Image: function () { return {}; },
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
        Promise: Promise
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.requestAnimationFrame = function (cb) { return setTimeout(cb, 0); };
    sandbox.cancelAnimationFrame = function (id) { clearTimeout(id); };
    const store = {};
    sandbox.localStorage = {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem: function (k, v) { store[k] = String(v); },
        removeItem: function (k) { delete store[k]; },
        _store: store
    };
    sandbox.CustomEvent = function (type, init) {
        this.type = type;
        this.detail = (init || {}).detail;
    };
    sandbox.MutationObserver = function (cb) {
        sandbox.MutationObserver._cb = cb;
        this.observe = function () {};
    };
    sandbox.document = {
        documentElement: makeEl('html'),
        body: makeEl('body'),
        hidden: false,
        getElementById: function (id) { return elMap[id] || (elMap[id] = makeEl(id)); },
        createElement: function () { return makeEl(''); },
        querySelector: function () { return null; },
        head: { appendChild() {} },
        addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        removeEventListener: function () {},
        dispatchEvent: function (ev) {
            (dispatched[ev.type] = dispatched[ev.type] || []).push(ev);
            (listeners[ev.type] || []).slice().forEach(function (fn) { fn(ev); });
            return true;
        },
        createEvent: function () { return { initCustomEvent: function () {} }; }
    };
    sandbox.addEventListener = function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); };
    sandbox._listeners = listeners;
    sandbox._dispatched = dispatched;
    return sandbox;
}

/* ══════════════════════════════════════════════════════════════
   5. The globe gate's country-switching / lock API
   ══════════════════════════════════════════════════════════════ */
(async function () {
    const elMap = {};
    const sandbox = makeSandbox(elMap);
    const L = makeLeaflet();
    sandbox.L = L;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/d3.min.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/topojson-client.min.js'), 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/globe-country-picker.js'), 'utf8'), sandbox);

    const gate = sandbox.DetectLabGlobeGate;
    const T = gate._test;
    ['listCountries', 'nameOf', 'selectCountry', 'prefetch', 'isLocked', 'unlock', 'exitView']
        .forEach(function (m) {
            assert(typeof gate[m] === 'function', 'gate API exposes ' + m);
        });
    console.log('  ✓ gate exposes the country-switch / lock API');

    // // 5a. Approximate bboxes are sane before any geometry is loaded.
    const approx = T.approxBbox('RO');
    assert(approx.length === 4 && approx[0] < approx[2] && approx[1] < approx[3],
        'approxBbox yields a valid box');
    ['VA', 'MC', 'RU', 'IS'].forEach(function (iso) {
        const b = T.approxBbox(iso);
        assert(b[0] < b[2] && b[1] < b[3], 'approxBbox sane for ' + iso);
    });

    // // 5b. Country list = every selectable country, codes + sorted names.
    let list = gate.listCountries();
    assert(list.length === Object.keys(T.NAMES).length, 'listCountries covers all countries');
    list.forEach(function (c) {
        assert(T.NAMES[c.iso], 'list entry code is a known ISO: ' + c.iso);
        assert(c.code === c.iso, 'the grid shows the 2-letter initial');
        assert(typeof c.name === 'string' && c.name.length > 1, c.iso + ' has a full name');
        assert(Array.isArray(c.bbox) && c.bbox.length === 4, c.iso + ' carries a lock bbox');
    });
    const names = list.map(function (c) { return c.name; });
    assert(names.join('|') === names.slice().sort(function (a, b) { return a.localeCompare(b); }).join('|'),
        'country list is sorted by name');
    assert(gate.nameOf('DE') === 'Germany', 'nameOf resolves EN names');
    assert(gate.nameOf('de') === 'Germany', 'nameOf is case-insensitive');
    assert(gate.nameOf('ZZ') === null, 'nameOf refuses unknown codes');
    console.log('  ✓ country list: ' + list.length + ' initials with full names + lock bboxes');

    // // 5c. Real geometry (local atlas) replaces the approximations.
    const atlas = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/countries-50m.json'), 'utf8'));
    T.G.world = sandbox.topojson.feature(atlas, atlas.objects.countries).features;
    T.buildEurope(null);
    list = gate.listCountries();
    const ro = list.find(function (c) { return c.iso === 'RO'; });
    assert(ro.fromGeometry, 'Romania locks to real geometry once the atlas is loaded');
    assert(ro.bbox[0] > 19 && ro.bbox[0] < 24 && ro.bbox[2] > 27 && ro.bbox[2] < 31,
        'Romania bbox longitudes are the real ones (got ' + ro.bbox.join(', ') + ')');
    assert(ro.bbox[1] > 42 && ro.bbox[3] < 49.5, 'Romania bbox latitudes are the real ones');
    console.log('  ✓ atlas geometry feeds the dock bboxes (RO ' + ro.bbox.map(function (v) { return v.toFixed(1); }).join(', ') + ')');

    // // 5d. Picking from the dock locks the Leaflet map to that country.
    const map = makeMap();
    gate.attach(map);
    const selected = await gate.selectCountry('de');
    assert(selected.iso === 'DE', 'selectCountry normalises the code');
    assert(sandbox._detectlabSelectedCountry === 'DE', 'hand-off globals are set');
    assert(Array.isArray(sandbox._detectlabCountryBounds) && sandbox._detectlabCountryBounds.length === 4,
        'country bbox is published for the search sources');
    assert(map.getMaxBounds(), 'maxBounds are applied → the map is pinned to the country');
    assert(map.getMaxBounds()._w.lng < 6 && map.getMaxBounds()._e.lng > 15, 'maxBounds cover Germany');
    assert(Math.abs(map.getMaxBounds()._w.lat - 47) < 1.5, 'maxBounds are only slightly padded');
    assert(map.getMinZoom() < map.getZoom() + 0.001,
        'the zoom floor never sits above the fit zoom');
    assert(Math.abs((map.getZoom() - map.getMinZoom()) - T.LOCK_ZOOM_SLACK) < 0.001,
        'the floor is one reachable zoom step below the fit (Leaflet snaps zooms: ' +
        map.getZoom() + ' → floor ' + map.getMinZoom() + ')');
    assert(map._fit && map._fit.opts.maxZoom <= T.FIT_MAX_ZOOM, 'the initial fit is capped for micro-states');
    assert(map._fit.opts.maxZoom >= 5, 'large countries still open on their real extent');
    assert(gate.isLocked(), 'the view reports as locked');
    assert(sandbox.document.documentElement.classList.contains('country-view-locked'),
        'html carries the country-view-locked class (CSS hook)');
    assert(sandbox.document.body.classList.contains('country-selected'), 'body carries country-selected');
    const selEvents = sandbox._dispatched['detectlab:country-selected'] || [];
    assert(selEvents.length === 1 && selEvents[0].detail.iso === 'DE',
        'the standard country-selected event fires (search + layer filtering follow)');
    assert((sandbox._dispatched['detectlab:country-lockchange'] || []).some(function (e) { return e.detail.locked; }),
        'a lockchange event announces the new lock');
    console.log('  ✓ selectCountry locks the map to the country (maxBounds + zoom floor + events)');

    // // 5e. Switching country again must not ratchet the zoom floor upwards.
    const firstMin = map.getMinZoom();
    await gate.selectCountry('VA');
    assert(sandbox._detectlabSelectedCountry === 'VA', 'switching country works');
    assert(map._fit.opts.maxZoom <= T.FIT_MAX_ZOOM, 'Vatican opens at the capped fit zoom');
    assert(map.getMinZoom() <= firstMin + 0.0001,
        'the zoom floor comes from the map baseline, not from the previous country (' +
        map.getMinZoom() + ' vs ' + firstMin + ')');

    // // 5f. Exit view releases everything.
    gate.exitView();
    assert(!gate.isLocked(), 'exitView unlocks the view');
    assert(map.getMaxBounds() === null, 'maxBounds are removed');
    assert(map.getMinZoom() === 2, 'the map keeps its own minZoom again (got ' + map.getMinZoom() + ')');
    assert(!sandbox.document.documentElement.classList.contains('country-view-locked'),
        'the CSS hook class is removed');
    assert(map._view, 'exiting pulls the camera back to the European overview');
    console.log('  ✓ exitView unlocks, restores the zoom range and reopens the globe');

    /* ══════════════════════════════════════════════════════════
       6. The dock itself
       ══════════════════════════════════════════════════════════ */
    const dockEls = {};
    ['countryDock', 'countryDockBtn', 'countryDockCode', 'countryDockPanel', 'countryDockGrid',
     'countryDockName', 'countryDockClose', 'countryDockHillshade', 'countryDockHsInfo',
     'countryExitViewBtn', 'mapSearchResults'].forEach(function (id) { dockEls[id] = makeEl(id); });
    const dockSandbox = makeSandbox(dockEls);
    const dockL = makeLeaflet();
    dockSandbox.L = dockL;
    const dockMap = makeMap();
    dockSandbox._dlMap = dockMap;

    let locked = true;
    const picked = [];
    const exits = [];
    let prefetched = 0;
    const fakeNames = { RO: 'Romania', DE: 'Germany', FR: 'France' };
    dockSandbox.DetectLabGlobeGate = {
        listCountries: function () {
            return Object.keys(fakeNames).map(function (iso) {
                return {
                    iso: iso, code: iso, name: fakeNames[iso], en: fakeNames[iso], ro: fakeNames[iso],
                    bbox: [0, 0, 1, 1], fromGeometry: true
                };
            });
        },
        nameOf: function (iso) { return fakeNames[iso] || null; },
        selectCountry: function (iso) { picked.push(iso); return Promise.resolve({ iso: iso }); },
        isLocked: function () { return locked; },
        exitView: function () { exits.push(true); locked = false; },
        unlock: function () { locked = false; },
        prefetch: function () { prefetched++; return Promise.resolve(true); },
        open: function () {}
    };
    vm.createContext(dockSandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/country-dock.js'), 'utf8'), dockSandbox);
    const dock = dockSandbox.DetectLabCountryDock;
    assert(dock && typeof dock.attach === 'function', 'DetectLabCountryDock.attach exported');
    ['open', 'close', 'toggle', 'isOpen', 'selectCountry', 'toggleHillshade',
     'isHillshadeOn', 'exitView', 'refresh'].forEach(function (m) {
        assert(typeof dock[m] === 'function', 'DetectLabCountryDock.' + m + ' exported');
    });

    dockSandbox._detectlabSelectedCountry = 'RO';
    dock.attach(dockMap);
    const dt = dock._test;
    assert(Object.keys(dt.state.buttons).length === 3, 'the grid is built from the gate country list');
    assert(dockEls.countryDockGrid.children.length === 3, 'one button per country initial');
    const roBtn = dt.state.buttons.RO;
    assert(roBtn.textContent === 'RO', 'the grid shows the 2-letter initial');
    assert(roBtn.getAttribute('title') === 'Romania', 'hover tooltip carries the full name');
    assert(roBtn.classList.contains('is-current'), 'the current country is highlighted');
    assert(dockEls.countryDockCode.textContent === 'RO', 'the chip shows the current code');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'exit view starts hidden');
    console.log('  ✓ dock renders the initials grid, current code and tooltips');

    // // 6a. Slide-down panel + full name on hover.
    dockEls.countryDockBtn.fire('click');
    assert(dock.isOpen(), 'the chip opens the panel');
    assert(dockEls.countryDockPanel.attrs.hidden === undefined, 'the panel is visible');
    assert(dockEls.countryDockBtn.attrs['aria-expanded'] === 'true', 'aria-expanded follows the panel');
    dockEls.countryDockGrid.fire('mouseover', { target: dt.state.buttons.DE });
    assert(dockEls.countryDockName.textContent === 'Germany', 'hovering a code prints the full name');
    assert(dockEls.countryDockName.classList.contains('show'), 'the name label is visible');
    dockEls.countryDockGrid.fire('click', { target: dt.state.buttons.DE });
    await new Promise(function (r) { setTimeout(r, 0); });
    assert(picked.length === 1 && picked[0] === 'DE', 'clicking a code asks the gate to switch country');
    assert(!dock.isOpen(), 'the panel closes after a pick');
    console.log('  ✓ slide-down list: initials, hover name, click switches country');

    // // 6b. Outside click / Escape close the panel.
    dock.open();
    (dockSandbox._listeners.click || []).slice().forEach(function (fn) { fn({ target: makeEl('outside') }); });
    assert(!dock.isOpen(), 'an outside click closes the panel');
    dock.open();
    (dockSandbox._listeners.keydown || []).slice().forEach(function (fn) { fn({ key: 'Escape' }); });
    assert(!dock.isOpen(), 'Escape closes the panel');
    console.log('  ✓ outside click / Escape close the slide-down list');

    // // 6c. Search autocomplete takes precedence.
    dock.open();
    dockEls.mapSearchResults.classList.add('open');
    dockSandbox.MutationObserver._cb();
    assert(dockEls.countryDock.classList.contains('dock-suppressed'),
        'the dock steps aside while the search results are open');
    assert(!dock.isOpen(), 'opening the results closes the dock panel');
    dockEls.mapSearchResults.classList.remove('open');
    dockSandbox.MutationObserver._cb();
    assert(!dockEls.countryDock.classList.contains('dock-suppressed'), 'the dock returns when results close');
    console.log('  ✓ the dock never fights the search autocomplete');

    // // 6d. World hillshade overlay — one lazily created tile layer, over the basemap.
    assert(dockL.created.length === 0, 'no hillshade tiles are requested before the box is ticked');
    dockEls.countryDockHillshade.fire('change', { target: { checked: true } });
    assert(dockL.created.length === 1, 'ticking the box creates exactly one tile layer');
    const hsLayer = dockL.created[0];
    assert(hsLayer.url.indexOf('Elevation/World_Hillshade/MapServer') !== -1, 'it is the Esri World Hillshade service');
    assert(hsLayer.options.maxNativeZoom === 16, 'overzoom is capped at the service’s own levels');
    assert(dockMap.hasLayer(hsLayer), 'the layer is added to the map');
    assert(dockMap.getPane('pane_world_hillshade'), 'it gets its own pane');
    assert(dockMap.getPane('pane_world_hillshade').style.zIndex === '400',
        'the pane sits at basemap level, below every data pane (401+)');
    assert(dock.isHillshadeOn(), 'the module reports the overlay as on');
    assert(dockSandbox.localStorage.getItem('detectlab_world_hillshade_v1') === '1', 'the choice is persisted');
    dockEls.countryDockHillshade.fire('change', { target: { checked: false } });
    assert(!dockMap.hasLayer(hsLayer), 'unticking removes the overlay');
    assert(dockSandbox.localStorage.getItem('detectlab_world_hillshade_v1') === '0', 'off is persisted too');
    dockEls.countryDockHillshade.fire('change', { target: { checked: true } });
    assert(dockL.created.length === 1 && dockMap.hasLayer(hsLayer), 'ticking again reuses the same layer');

    // The app's naming-style hook + the attribution popup (Leaflet's own
    // attribution control is hidden by CSS, so live layers credit the source).
    assert(typeof dockSandbox.toggleWorldHillshade === 'function',
        'window.toggleWorldHillshade is exposed for the rest of the app');
    dockSandbox.toggleWorldHillshade(false);
    assert(!dockMap.hasLayer(hsLayer) && !dock.isHillshadeOn(), 'the hook drives the overlay');
    dockSandbox.toggleWorldHillshade(true);
    assert(dockMap.hasLayer(hsLayer) && dock.isHillshadeOn(), 'and can switch it back on');
    const shown = [];
    dockSandbox.showLayerInfo = function (title, credits, desc) {
        shown.push({ title: title, credits: credits, desc: desc });
    };
    dock._test.showHillshadeInfo();
    assert(shown.length === 1 && /Esri/.test(shown[0].credits) && /USGS/.test(shown[0].credits),
        'the ⓘ button reports the Esri / USGS / NOAA credit');
    console.log('  ✓ World hillshade: lazy, single layer, own pane below the data overlays');

    // // 6d-bis. The floor is compared in *reachable* (zoomSnap-snapped) steps:
    // Leaflet clamps a 5.65 floor to whole levels, so the pill must key off 6.
    dockMap.options.zoomSnap = 1;
    dockMap.setMinZoom(5.65);
    assert(dock._test.reachableFloor(dockMap) === 6, 'a fractional floor rounds up to the reachable zoom level');
    dockMap.setMinZoom(5);
    dockMap.setZoom(6);
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'one step above the floor is still “zoomed in”');
    dockMap.setZoom(5);
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === undefined, 'the snapped floor counts as “zoomed out at maximum”');

    // The clamped case: the floor is the map's own minimum, so Leaflet swallows
    // the zoom-out and never fires zoomend — the wheel gesture must reveal it.
    dockMap.setMinZoom(5);
    dockMap.setZoom(5);
    dock._test.state.userZoomedOut = false;
    dock._test.evaluateExitButton();
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'hidden until the user actually tries to zoom out');
    dock._test.onWheelAttempt({ deltaY: -120 });
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'a zoom-in wheel gesture does not count');
    dock._test.onWheelAttempt({ deltaY: 120 });
    assert(dockEls.countryExitViewBtn.attrs.hidden === undefined,
        'a blocked zoom-out wheel gesture reveals the button');

    // // 6e. Exit view only shows at the zoom floor of a locked view.
    dockMap.setZoom(6);
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'not shown while zoomed into the country');
    dockMap.setZoom(7.5);
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'zooming in keeps it hidden');
    dockMap.setMinZoom(5);
    dockMap.setZoom(5);
    dockMap.fire('zoomend');                       // zoom-out → at the floor
    assert(dockEls.countryExitViewBtn.attrs.hidden === undefined,
        'zooming out to the maximum reveals “Exit view”');
    assert(dockEls.countryExitViewBtn.classList.contains('show'), 'the button animates in');
    locked = false;
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'it disappears when the view is unlocked again');
    locked = true;
    dockMap._zoom = 6;
    dockMap.fire('zoomend');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 're-locking hides it until the user zooms out again');
    dockMap.setZoom(5);
    dockMap.fire('zoomend');
    dockEls.countryExitViewBtn.fire('click');
    assert(exits.length === 1, 'clicking “Exit view” asks the gate to leave the country view');
    assert(dockEls.countryExitViewBtn.attrs.hidden === 'hidden', 'the button hides as the view is left');
    console.log('  ✓ “Exit view” appears only at the zoom floor and exits the country view');

    // // 6f. A globe pick refreshes the chip and the grid highlight.
    dockSandbox._detectlabSelectedCountry = 'FR';
    dockSandbox.document.dispatchEvent(new dockSandbox.CustomEvent('detectlab:country-selected',
        { detail: { iso: 'FR', name: 'France' } }));
    assert(dockEls.countryDockCode.textContent === 'FR', 'the chip follows a globe selection');
    assert(dt.state.buttons.FR.classList.contains('is-current'), 'the grid highlight follows it too');
    assert(!dt.state.buttons.RO.classList.contains('is-current'), 'the old highlight is cleared');
    assert(prefetched >= 1, 'the geometry is warmed in the background for instant switching');
    console.log('  ✓ the dock stays in sync with globe selections');

    // // 6g. The hillshade choice survives a reload.
    const els2 = {};
    ['countryDock', 'countryDockBtn', 'countryDockCode', 'countryDockPanel', 'countryDockGrid',
     'countryDockName', 'countryDockClose', 'countryDockHillshade', 'countryDockHsInfo',
     'countryExitViewBtn'].forEach(function (id) {
        els2[id] = makeEl(id);
    });
    const sb2 = makeSandbox(els2);
    const L2 = makeLeaflet();
    sb2.L = L2;
    sb2.localStorage.setItem('detectlab_world_hillshade_v1', '1');
    sb2.DetectLabGlobeGate = dockSandbox.DetectLabGlobeGate;
    vm.createContext(sb2);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/country-dock.js'), 'utf8'), sb2);
    const map2 = makeMap();
    sb2.DetectLabCountryDock.attach(map2);
    assert(els2.countryDockHillshade.checked === true, 'the checkbox is restored from the last session');
    assert(L2.created.length === 1 && map2.hasLayer(L2.created[0]), 'the overlay is switched back on');
    console.log('  ✓ the hillshade choice persists across sessions');

    console.log('\nAll country dock tests passed ✔');
})().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
});
