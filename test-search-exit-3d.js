// Search must return to 2D BEFORE moving Leaflet, since closing 3D copies
// its old camera into Leaflet. Run: node test-search-exit-3d.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const app = read('js/map-app.js');
const viewer = read('js/map3d-terrain.js');
function grab(source, pattern) {
    const match = source.match(pattern);
    assert(match, 'production function is present: ' + pattern);
    return match[0];
}
const select = grab(app, /function selectResult\(item\) \{[\s\S]*?\n {12}\}/);
const close = grab(viewer, /function close\(\) \{[\s\S]*?\n {4}\}/);
const settleMotion = grab(viewer, /function settleLeafletMotion\(lmap\) \{[\s\S]*?\n {4}\}/);
const camera = grab(viewer, /function cameraTo2D\(\) \{[\s\S]*?\n {4}\}/);
const keyboard = grab(app, /searchInput\.addEventListener\('keydown', function \(e\) \{[\s\S]*?\n {16}\}\);/);
const display = grab(app, /function displaySearchResults\(data, searchTerm\) \{[\s\S]*?\n {12}\}/);

function boot(mode) {
    const events = [], timers = [], markers = [], results = [];
    const elements = {
        mapSearchInput: { value: 'Marlow', addEventListener(type, listener) { this[type] = listener; } },
        searchClearBtn: { classList: { add(value) { events.push('clear:' + value); } } },
        mapSearchResults: { innerHTML: '', classList: { add() {} }, appendChild(el) { results.push(el); } }
    };
    const leaflet = {
        destination: null, zoom: null,
        _animatingZoom: mode === 'open',
        stop() { events.push('leaflet-stop'); },
        _onZoomTransitionEnd() {
            // Match Leaflet 1.9's delayed CSS-zoom cleanup: if still active,
            // it commits the old target camera and clears the animation flag.
            if (!this._animatingZoom) return;
            events.push('old-zoom-transition-end');
            this._animatingZoom = false;
            this.destination = { lat: 40, lng: 10 };
            this.zoom = 5;
        },
        setView(latlng, zoom) { events.push('handoff'); this.destination = latlng; this.zoom = zoom; },
        setBearing() {},
        flyTo(latlng, zoom) {
            assert(!context.state.open, '3D is closed before search flies to the result');
            assert(!this._animatingZoom, 'the previous Leaflet CSS zoom is settled before search starts');
            events.push('fly'); this.destination = latlng; this.zoom = zoom;
        }
    };
    const context = {
        events, state: { open: !['absent', 'closed'].includes(mode), failed: mode === 'failed', healthTimers: [] },
        map: leaflet, searchMarker: null, searchInput: elements.mapSearchInput,
        selectedIndex: -1, searchDebounce: null, openGeneration: 0,
        coordinateSearchItem() { return context.coordinateItem || null; },
        setActive() {}, doSearch() { events.push('search'); },
        closeResults() { events.push('results-closed'); },
        removeSearchMarker() { events.push('marker-removed'); },
        setTimeout(fn) { timers.push(fn); }, clearTimeout() {},
        leafletMap() { return leaflet; },
        threeDMap: ['open', 'closed'].includes(mode) ? {
            getCenter() { return { lat: 40, lng: 10 }; }, getZoom() { return 5; },
            getBearing() { return 0; }, remove() { events.push('3d-removed'); }
        } : null,
        stopPanelWatcher() {}, hideVeil() {}, refreshToggle() {},
        document: {
            body: { classList: { remove(name) { events.push('body-remove:' + name); } } },
            getElementById(id) { return elements[id]; },
            querySelectorAll() { return results; },
            createElement() { return { dataset: {}, addEventListener(type, fn) { this[type] = fn; } }; }
        },
        L: {
            latLng(lat, lng) { return { lat, lng }; }, divIcon(options) { return options; },
            marker(latlng) {
                const marker = { latlng, bindTooltip(name) { this.name = name; return this; },
                    addTo(map) { assert.strictEqual(map, leaflet); events.push('marker-added'); return this; } };
                markers.push(marker); return marker;
            }
        }
    };
    context.window = context;
    context.root = context;
    vm.createContext(context);
    // Run the actual 3D close/camera hand-off in its own closure: its `map`
    // refers to MapLibre, while selectResult's `map` refers to Leaflet.
    vm.runInContext(`DetectLabMap3D = (function () {
        var map = threeDMap, popup = null;
        ${settleMotion}\n${camera}\n${close}
        return { isOpen: function () { return state.open; }, close: function () { events.push('close'); return close(); } };
    })();\n${select}\n${display}\n${keyboard}`, context);
    if (mode === 'absent') delete context.DetectLabMap3D;
    return { context, events, timers, markers, results, elements, leaflet };
}
const place = { lat: '51.5719', lon: '-0.7769', display_name: 'Marlow' };
for (const mode of ['absent', 'closed', 'open', 'loading', 'failed']) {
    for (const method of ['click', 'enter-place', 'enter-coordinates']) {
        const b = boot(mode);
        const item = method === 'enter-coordinates'
            ? { ...place, display_name: '51.571900, -0.776900', isCoordinate: true } : place;
        if (method === 'enter-coordinates') b.context.coordinateItem = item;
        else b.context.displaySearchResults([item], 'Marlow');
        if (method === 'click') b.results[0].click();
        else b.elements.mapSearchInput.keydown({ key: 'Enter', preventDefault() {} });
        assert.deepStrictEqual(b.leaflet.destination, { lat: 51.5719, lng: -0.7769 });
        assert.strictEqual(b.leaflet.zoom, 13);
        assert.strictEqual(b.markers[0].name, item.display_name);
        assert.strictEqual(b.elements.mapSearchInput.value, item.display_name);
        if (['absent', 'closed'].includes(mode)) assert(!b.events.includes('close'), '2D is unchanged');
        else {
            assert(b.events.indexOf('close') < b.events.indexOf('fly'), 'close precedes fly');
            assert(b.events.includes('body-remove:is-3d'), '2D controls are restored');
            if (mode === 'open') {
                assert(b.events.indexOf('leaflet-stop') < b.events.indexOf('old-zoom-transition-end'),
                    'close settles any in-flight Leaflet motion before replacing its camera');
                assert(b.events.indexOf('old-zoom-transition-end') < b.events.indexOf('handoff'),
                    'the delayed CSS zoom is finalized before the 3D camera is handed back');
                assert(b.events.indexOf('handoff') < b.events.indexOf('fly'),
                    'the 3D camera hand-off precedes the searched destination');
                const endCount = b.events.filter(event => event === 'old-zoom-transition-end').length;
                b.leaflet._onZoomTransitionEnd(); // simulate Leaflet's old 250 ms callback
                assert.strictEqual(b.events.filter(event => event === 'old-zoom-transition-end').length, endCount,
                    'the stale transition callback cannot reset the searched destination');
                assert.deepStrictEqual(b.leaflet.destination, { lat: 51.5719, lng: -0.7769 });
            }
        }
        let activation;
        b.context._iosFreeActivateSearch = (...args) => { activation = args; };
        b.timers.forEach(fn => fn());
        assert.deepStrictEqual(activation, [item.display_name, 51.5719, -0.7769], 'search layer activation retained');
    }
    console.log('✓ click, Enter and coordinates with 3D ' + mode);
}
// Reproduce the reported sequence: a 2D CSS zoom is still finishing when the
// user switches out of 3D, then searches after the 2D map is visible again.
const manualSwitch = boot('open');
manualSwitch.context.DetectLabMap3D.close();
assert(!manualSwitch.context.state.open, 'manual 3D → 2D switch closes the viewer');
manualSwitch.context.displaySearchResults([place], 'Marlow');
manualSwitch.results[0].click();
assert.deepStrictEqual(manualSwitch.leaflet.destination, { lat: 51.5719, lng: -0.7769 });
const settledEndCount = manualSwitch.events.filter(event => event === 'old-zoom-transition-end').length;
manualSwitch.leaflet._onZoomTransitionEnd(); // delayed callback from the pre-switch CSS zoom
assert.strictEqual(manualSwitch.events.filter(event => event === 'old-zoom-transition-end').length, settledEndCount);
assert.deepStrictEqual(manualSwitch.leaflet.destination, { lat: 51.5719, lng: -0.7769 },
    'a late pre-switch zoom callback cannot move the searched camera or country outline');
console.log('✓ switch 3D → 2D, then search: no stale Leaflet zoom can move the destination');

// Typing/looking up a place must not close the current 3D view prematurely.
const b = boot('open');
b.context.displaySearchResults([place], 'Marlow');
assert(b.context.state.open && !b.events.includes('close'), 'only selecting a destination exits 3D');
for (const coordinateItem of [null, { valid: false }]) {
    const pending = boot('open');
    pending.context.coordinateItem = coordinateItem;
    pending.elements.mapSearchInput.keydown({ key: 'Enter', preventDefault() {} });
    assert(pending.context.state.open && !pending.events.includes('fly'),
        'pending place lookup and invalid coordinates do not exit 3D');
}
const viewerUrl = 'js/map3d-terrain.js?v=20261020-outline-camera-handoff';
assert(read('index.html').includes(viewerUrl) && read('sw.js').includes("'" + viewerUrl + "'"),
    'the 3D camera hand-off fix is cache-busted and precached');
assert(Number(read('sw.js').match(/CACHE_NAME = 'detectlab-v(\d+)-/)[1]) >= 245);
console.log('✓ lookup stays in 3D; the camera hand-off settles Leaflet before search');
