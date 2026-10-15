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
        setView(latlng, zoom) { events.push('handoff'); this.destination = latlng; this.zoom = zoom; },
        setBearing() {},
        flyTo(latlng, zoom) {
            assert(!context.state.open, '3D is closed before search flies to the result');
            events.push('fly'); this.destination = latlng; this.zoom = zoom;
        }
    };
    const context = {
        events, state: { open: !['absent', 'closed'].includes(mode), failed: mode === 'failed', healthTimers: [] },
        map: leaflet, searchMarker: null, searchInput: elements.mapSearchInput,
        selectedIndex: -1, searchDebounce: null,
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
        ${camera}\n${close}
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
            if (mode === 'open') assert(b.events.indexOf('handoff') < b.events.indexOf('fly'), 'old camera cannot overwrite destination');
        }
        let activation;
        b.context._iosFreeActivateSearch = (...args) => { activation = args; };
        b.timers.forEach(fn => fn());
        assert.deepStrictEqual(activation, [item.display_name, 51.5719, -0.7769], 'search layer activation retained');
    }
    console.log('✓ click, Enter and coordinates with 3D ' + mode);
}
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
const url = 'js/map-app.js?v=20261015-danish-layers';
assert(read('index.html').includes(url) && read('sw.js').includes("'" + url + "'"));
assert(Number(read('sw.js').match(/CACHE_NAME = 'detectlab-v(\d+)-/)[1]) >= 198);
console.log('✓ lookup stays in 3D; updated app is cache-busted and precached');
