const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync('js/romania-view.js', 'utf8');
function setup(hash = '') {
    const root = {
        location: { hash },
        _detectlabSelectedCountry: 'FR',
        _detectlabCountryBounds: [-5, 42, 8, 51],
        L: {
            latLngBounds: values => values,
            Hash: { parseHash: h => {
                const m = /^#(\d+)\/(-?[\d.]+)\/(-?[\d.]+)$/.exec(h);
                return m ? { zoom: +m[1], center: { lat: +m[2], lng: +m[3] } } : false;
            } }
        }
    };
    vm.runInNewContext(script, { window: root });
    let size = { x: 800, y: 600 }, fitZoom = 6;
    const calls = { fit: [], min: [], max: [], events: {} };
    const map = {
        options: { minZoom: 2 },
        getSize: () => size,
        getBoundsZoom: () => fitZoom,
        setMaxBounds: b => calls.max.push(b),
        setMinZoom: z => { calls.min.push(z); map.options.minZoom = z; },
        fitBounds: (b, options) => calls.fit.push({ b, options }),
        on: (event, fn) => { calls.events[event] = fn; }
    };
    return { root, map, calls, setSize: x => { size = x; }, setFit: x => { fitZoom = x; } };
}

test('old selection is ignored, and Leaflet is bounded and fitted to Romania', () => {
    const {root, map, calls} = setup('#8/48.8/2.3');
    assert.equal(root._detectlabSelectedCountry, 'RO');
    root.DetectLabRomaniaView.attach(map);
    assert.equal(map.options.maxBoundsViscosity, 1);
    assert.equal(calls.max.length, 1);
    assert.equal(calls.fit.length, 1);
    assert.equal(calls.min[0], 5);
    assert.equal(root.DetectLabRomaniaView.contains(45.75, 21.23), true);
    assert.equal(root.DetectLabRomaniaView.contains(48.8, 2.3), false);
    const bounds = root.DetectLabRomaniaView.mapLibreBounds();
    assert.equal(bounds[0][0], calls.max[0][0][1]);
    assert.equal(bounds[1][1], calls.max[0][1][0]);
});

test('valid Romania hash survives; zoom floor adapts to resize without refitting', () => {
    const {root, map, calls, setFit} = setup('#12/46.77/23.59');
    root.DetectLabRomaniaView.attach(map);
    assert.equal(calls.fit.length, 0);
    setFit(7);
    calls.events.resize();
    assert.equal(calls.min.at(-1), 6);
    assert.equal(calls.fit.length, 0);
});

test('hidden map waits for a usable size before fitting', () => {
    const {root, map, calls, setSize} = setup();
    setSize({x: 0, y: 0});
    root.DetectLabRomaniaView.attach(map);
    assert.equal(calls.fit.length, 0);
    setSize({x: 400, y: 700});
    calls.events.resize();
    assert.equal(calls.fit.length, 1);
    calls.events.resize();
    assert.equal(calls.fit.length, 1);
});

test('app removes the selector, applies Romanian filtering and shares limits with 3D', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    const app = fs.readFileSync('js/map-app.js', 'utf8');
    const terrain = fs.readFileSync('js/map3d-terrain.js', 'utf8');
    for (const id of ['globeGate', 'countryDock', 'countryExitViewBtn']) assert(!html.includes(`id="${id}"`));
    assert(!html.includes('js/globe-country-picker.js'));
    assert(!html.includes('js/country-dock.js'));
    assert(html.includes('js/romania-view.js'));
    assert(app.includes("window.filterLayersForCountry('RO')"));
    assert(app.includes('DetectLabRomaniaView.contains(coordinateItem.lat, coordinateItem.lon)'));
    assert(terrain.includes('options.maxBounds = root.DetectLabRomaniaView.mapLibreBounds()'));
});
