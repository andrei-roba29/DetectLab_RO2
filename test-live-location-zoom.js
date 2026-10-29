// Exercise the actual live-location control with successive GPS fixes.
'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('js/map-app.js', 'utf8');
const start = src.indexOf('            (function () {', src.indexOf('// ── CUSTOM LIVE LOCATION BUTTON ──'));
const end = src.indexOf('            })();', start) + '            })();'.length;
assert(start >= 0 && end > start);
let success, error, nextId = 0, zoom = 8;
const flights = [], markers = [], presence = [], cleared = [];
const map = {
    getZoom: () => zoom,
    flyTo: (position, level) => { flights.push({ position: Array.from(position), level }); zoom = level; },
    removeLayer() {}
};
const layer = position => ({ bindPopup() { return this; }, addTo() { markers.push(Array.from(position)); return this; } });
const window = {};
const context = {
    window, map, navigator: { geolocation: {
        watchPosition(onSuccess, onError) { success = onSuccess; error = onError; return ++nextId; },
        clearWatch(id) { cleared.push(id); }
    } },
    document: { createElement: () => ({ style: {} }), documentElement: { classList: { contains: () => false } }, getElementById: () => null },
    setTimeout() {},
    L: { divIcon: () => ({}), marker: layer, circle: layer },
    _detLat: null, _detLng: null, _det: { active: false },
    _presenceVisible: () => true, publishDetectorPresence: (...args) => presence.push(args),
    console, alert() {}
};
vm.runInNewContext(src.slice(start, end), context);
const fix = (lat, lng) => success({ coords: { latitude: lat, longitude: lng, accuracy: 10 } });
window._startLiveLocation();
fix(51, 0);
assert.strictEqual(flights.length, 1);
assert.strictEqual(flights[0].level, 14);
zoom = 9; // user zooms out
fix(52, 1);
assert.strictEqual(flights.length, 1, 'subsequent fixes must not recenter or zoom');
assert.strictEqual(zoom, 9);
assert.deepStrictEqual(markers[markers.length - 1], [52, 1]);
assert.deepStrictEqual(presence[presence.length - 1], [52, 1, true]);
window._stopLiveLocation();
assert.deepStrictEqual(cleared, [1]);
window._startLiveLocation();
fix(53, 2);
assert.strictEqual(flights.length, 2, 'a new session centers once again');
assert.strictEqual(flights[1].level, 14);
zoom = 17;
window._stopLiveLocation();
window._startLiveLocation();
fix(54, 3);
assert.strictEqual(flights[2].level, 17, 'initial centering preserves a closer zoom');
error({ message: 'denied' });
assert.strictEqual(window._isLiveLocationActive(), false);
console.log('Live location zoom regression tests passed');
