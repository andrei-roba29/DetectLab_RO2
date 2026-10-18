/*
 * test-battles-and-report-3d.js
 * ───────────────────────────────────────────────────────────────────────────
 * Verifies that:
 *   1. The radiuses of the "Battles" layer (js/battles-layer.js) are projected
 *      in 3D as ground-draped circles in METRES (9 km / 26 km polygons, not
 *      9000-px / 26000-px dots), with their labels anchored on the northern rim,
 *      and that clicking any battle radius or label in 3D opens its popup with
 *      full battle details.
 *   2. The result points and 180 m result rings of the "Archeological Report"
 *      layer (js/archeo-report.js) — plus its search radius circle — are
 *      projected in 3D on the ground and that clicking any result point, ring,
 *      or label in 3D opens its popup with full report candidate details.
 *
 * Runs the REAL js/leaflet.js, js/translations.js, js/directions.js,
 * js/battles-layer.js, js/archeo-report.js, js/layer-registry.js,
 * js/map3d-mirror.js, and js/map3d-terrain.js in a single JSDOM window.
 *
 * Usage:
 *   node test-battles-and-report-3d.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

console.log('[Test] Battles & Archeological Report 3D projection + click popups…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const battlesJson = JSON.parse(read('data/conflicte_militare/conflicte_militare_romania.bilingual.json'));

const html = `<!DOCTYPE html><html><body>
  <div id="detectlab-map"><div id="map" style="width:1024px;height:768px"></div></div>
  <input type="checkbox" id="battlesToggle">
  <input type="range" id="battlesPeriodSlider" min="-8" max="20" step="1" value="14">
  <span id="battlesPeriodValue"></span>
  <div id="archReportRow"></div>
  <input type="checkbox" id="archReportToggle">
  <button id="archReportRunBtn"></button>
  <button id="archReportPdfBtn" style="display:none"></button>
  <div id="archReportPdfLang" style="display:none">
    <button id="archReportPdfLangRo"></button>
    <button id="archReportPdfLangEn"></button>
  </div>
  <div id="archReportResultsToggleWrap" style="display:none">
    <input type="checkbox" id="archReportResultsToggle" checked>
  </div>
  <input type="checkbox" id="archReportIgnoreLidar">
  <div id="archReportStatus"></div>
  <div id="archReportSummary"></div>
  <input type="range" id="archReportDistance" min="1" max="10" step="1" value="3">
  <span id="archReportDistanceValue">3 km</span>
  <div id="archReportLoading" style="display:none"></div>
</body></html>`;

const dom = new JSDOM(html, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    url: 'https://detectlab.eu/',
    virtualConsole: new VirtualConsole()
});
const ctx = dom.getInternalVMContext();
const w = dom.window;

const noop = () => {};
w.HTMLCanvasElement.prototype.getContext = function (kind) {
    const canvas = this;
    if (kind && kind !== '2d') {
        return {
            getExtension: () => null,
            getParameter: () => 4096
        };
    }
    const base = {
        globalAlpha: 1,
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
        putImageData(img) { canvas.lastImage = img.data; },
        clearRect: noop, drawImage: noop, save: noop, restore: noop
    };
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
};
w.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/png;base64,iVBORw0KGgo='; };
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

let curLang = 'ro';
w._currentLang = () => curLang;
w.fetch = function (url) {
    if (String(url).indexOf('conflicte_militare_romania.bilingual.json') !== -1) {
        return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(battlesJson)
        });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
};

vm.runInContext(read('js/leaflet.js'), ctx);
vm.runInContext(read('js/translations.js'), ctx);
w._currentLang = () => curLang;
vm.runInContext(read('js/google-maps-directions.js'), ctx);
vm.runInContext(read('js/layer-registry.js'), ctx);
vm.runInContext(read('js/map3d-mirror.js'), ctx);
vm.runInContext(read('js/map3d-terrain.js'), ctx);

const L = w.L;
const M = w.DetectLabMirror;
const Viewer3D = w.DetectLabMap3D;

const map = L.map(w.document.getElementById('map'), { center: [45.8, 24.9], zoom: 7, preferCanvas: true });
w._dlMap = map;
w.map = map;

vm.runInContext(read('js/battles-layer.js'), ctx);
vm.runInContext(read('js/archeo-report.js'), ctx);

const R = w._archeoReportDebug;

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

function haversineM(lat1, lng1, lat2, lng2) {
    const E = 6371008.8, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * E * Math.asin(Math.min(1, Math.sqrt(a)));
}
function ringCentre(ring) {
    const pts = ring.slice(0, -1);
    return {
        lng: pts.reduce((s, p) => s + p[0], 0) / pts.length,
        lat: pts.reduce((s, p) => s + p[1], 0) / pts.length
    };
}
function deck() { return M.collect(map, {}); }

/* ── Recording MapLibre stub for DetectLabMap3D end-to-end 3D interaction ─ */
const fakeSources = {};
const fakeLayers = {};
const fakeOrder = [];
let lastPopup = null;
let currentFakeMap = null;

class FakePopup {
    constructor(options) {
        this.options = options || {};
        this.lngLat = null;
        this.html = '';
        this.map = null;
    }
    setLngLat(lngLat) { this.lngLat = lngLat; return this; }
    setHTML(html) { this.html = html; return this; }
    addTo(m) { this.map = m; lastPopup = this; return this; }
    remove() { this.map = null; return this; }
}

class FakeMap {
    constructor(options) {
        this.options = options;
        this._handlers = {};
        this.touchZoomRotate = { enableRotation: noop };
        currentFakeMap = this;
    }
    on(type, layerOrFn, maybeFn) {
        const key = typeof layerOrFn === 'string' ? (type + ':' + layerOrFn) : type;
        const fn = typeof layerOrFn === 'string' ? maybeFn : layerOrFn;
        (this._handlers[key] = this._handlers[key] || []).push(fn);
        return this;
    }
    fire(type, layerOrEvent, maybeEvent) {
        const key = typeof layerOrEvent === 'string' ? (type + ':' + layerOrEvent) : type;
        const ev = typeof layerOrEvent === 'string' ? maybeEvent : layerOrEvent;
        (this._handlers[key] || []).slice().forEach((fn) => fn(ev || {}));
    }
    addControl() { return this; }
    getCanvas() { return w.document.createElement('div'); }
    addSource(id, spec) {
        fakeSources[id] = Object.assign({
            setData(data) { this.data = data; }
        }, spec);
    }
    getSource(id) { return fakeSources[id] || null; }
    removeSource(id) { delete fakeSources[id]; }
    addLayer(spec) {
        if (!fakeLayers[spec.id]) fakeOrder.push(spec.id);
        fakeLayers[spec.id] = spec;
    }
    getLayer(id) { return fakeLayers[id] || null; }
    removeLayer(id) {
        delete fakeLayers[id];
        const at = fakeOrder.indexOf(id);
        if (at !== -1) fakeOrder.splice(at, 1);
    }
    moveLayer(id, beforeId) {
        const at = fakeOrder.indexOf(id);
        if (at !== -1) fakeOrder.splice(at, 1);
        const to = beforeId ? fakeOrder.indexOf(beforeId) : -1;
        if (to === -1) fakeOrder.push(id);
        else fakeOrder.splice(to, 0, id);
    }
    setPaintProperty(id, prop, val) {
        if (fakeLayers[id]) {
            fakeLayers[id].paint = fakeLayers[id].paint || {};
            fakeLayers[id].paint[prop] = val;
        }
    }
    setLayoutProperty(id, prop, val) {
        if (fakeLayers[id]) {
            fakeLayers[id].layout = fakeLayers[id].layout || {};
            fakeLayers[id].layout[prop] = val;
        }
    }
    setTerrain() {}
    hasImage() { return false; }
    addImage() {}
    loadImage() { return Promise.resolve({ data: {} }); }
    getCenter() { return { lat: 45.8, lng: 24.9 }; }
    getZoom() { return 7; }
    getBearing() { return 0; }
    getPitch() { return 60; }
    loaded() { return true; }
    resize() {}
    remove() {}
}

w.maplibregl = {
    Map: FakeMap,
    Popup: FakePopup,
    NavigationControl: function () {},
    AttributionControl: function () {},
    addProtocol: noop
};

(async () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * 1. BATTLES LAYER — 3D ground projection & click-to-popup details
     * ═══════════════════════════════════════════════════════════════════════ */
    w.toggleBattlesLayer(true);
    await new Promise((r) => setTimeout(r, 20));

    const d1 = deck();
    assert.strictEqual(d1.capped.length, 0, 'no children dropped by the 3D mirror for Battles');
    assert.strictEqual(d1.unsupported.length, 0, 'nothing unsupported in Battles: ' + d1.unsupported.join('; '));

    const battlesItem = d1.items.find((i) => i.label === 'Battles');
    assert.ok(battlesItem, 'the Battles layer is mirrored into the 3D deck');
    assert.strictEqual(battlesItem.kind, 'vector');
    assert.strictEqual(battlesItem.perFeature, true, 'Battles uses per-feature 3D paint');
    assert.strictEqual(d1.items.filter((i) => i.pane === 'pane_battles' || i.pane === 'pane_battles_labels').length, 1,
        '2D battle circles and label markers are skipped (_dl3dSkip) and bundled into ONE 3D source');
    ok('Battles: 2D circles and label markers coalesce into one per-feature 3D source');

    // Century XIV default has 3 battles: Posada (9 km), Rovine (9 km), Nicopole (26 km)
    const bFeatures = battlesItem.geojson.features;
    const bPolys = bFeatures.filter((f) => f.geometry.type === 'Polygon');
    const bLabels = bFeatures.filter((f) => f.geometry.type === 'Point');
    assert.strictEqual(bPolys.length, 3, '3 battle radius ground polygons in Century XIV');
    assert.strictEqual(bLabels.length, 3, '3 battle label points in Century XIV');

    // Check ground radii in metres (9000 m vs 26000 m)
    const byTitle = {};
    bPolys.forEach((poly) => {
        const ring = poly.geometry.coordinates[0];
        assert.strictEqual(ring.length, 33, 'battle circle is a closed 32-segment polygon');
        assert.deepStrictEqual(ring[0], ring[ring.length - 1], 'polygon ring is closed');
        const c = ringCentre(ring);
        const measured = haversineM(c.lat, c.lng, ring[0][1], ring[0][0]);
        const expected = poly.properties.radiusM;
        const relErr = Math.abs(measured - expected) / expected;
        assert.ok(relErr < 0.01, `battle ground radius ${measured.toFixed(0)} m matches ${expected} m within 1 %`);
        byTitle[poly.properties.title] = { poly, measured };
    });
    assert.ok(byTitle['Bătălia de la Posada'] && Math.abs(byTitle['Bătălia de la Posada'].measured - 26000) < 260,
        'Posada (zona_aprox=1) is projected as a 26,000 m ground polygon');
    assert.ok(byTitle['Bătălia de la Rovine'] && Math.abs(byTitle['Bătălia de la Rovine'].measured - 26000) < 260,
        'Rovine (zona_aprox=1) is projected as a 26,000 m ground polygon');
    const nicopoleKey = Object.keys(byTitle).find((k) => k.indexOf('Nicopole') !== -1);
    assert.ok(nicopoleKey && Math.abs(byTitle[nicopoleKey].measured - 26000) < 260,
        'Nicopole (zona_aprox=1) is projected as a 26,000 m ground polygon');

    // Switch to Century XV to verify both 9,000 m (zona_aprox=0) and 26,000 m (zona_aprox=1) ground circles
    w.setBattlesPeriod(15);
    const d15 = deck();
    const item15 = d15.items.find((i) => i.label === 'Battles');
    const polys15 = item15.geojson.features.filter((f) => f.geometry.type === 'Polygon');
    const byTitle15 = {};
    polys15.forEach((poly) => {
        const ring = poly.geometry.coordinates[0];
        const c = ringCentre(ring);
        const measured = haversineM(c.lat, c.lng, ring[0][1], ring[0][0]);
        const expected = poly.properties.radiusM;
        assert.ok(Math.abs(measured - expected) / expected < 0.01,
            `Century XV battle ground radius ${measured.toFixed(0)} m matches ${expected} m within 1 %`);
        byTitle15[poly.properties.title] = { poly, measured };
    });
    assert.ok(byTitle15['Bătălia de la Baia'] && Math.abs(byTitle15['Bătălia de la Baia'].measured - 9000) < 90,
        'Bătălia de la Baia (zona_aprox=0) is projected as a 9,000 m ground polygon');
    assert.ok(byTitle15['Bătălia de la Vaslui (Podul Înalt)'] && Math.abs(byTitle15['Bătălia de la Vaslui (Podul Înalt)'].measured - 26000) < 260,
        'Bătălia de la Vaslui (zona_aprox=1) is projected as a 26,000 m ground polygon');
    assert.strictEqual(polys15[0].properties.radiusM, 26000, '26 km approximate zone is ordered first so 9 km circles draw on top');
    assert.strictEqual(polys15[polys15.length - 1].properties.radiusM, 9000, '9 km circle is ordered after 26 km zones so it draws on top');
    ok('Battles: 9,000 m and 26,000 m radii are projected as ground polygons in metres (within 1 %)');

    // Restore Century XIV for the rest of the checks
    w.setBattlesPeriod(14);

    // Check labels & popups on both polygons and label points
    assert.ok(bPolys.every((f) => f.properties.popup && f.properties.popup.includes('battles-popup-inner') &&
        f.properties.popup.includes('battles-popup-title') && f.properties.popup.includes('battles-popup-search')),
        'every battle ground polygon carries its full popup HTML');
    assert.ok(bLabels.every((f) => f.properties.noDot === 1 && f.properties.label &&
        f.properties.popup && f.properties.popup.includes('battles-popup-inner')),
        'every battle label point is label-only (noDot: 1) and carries the battle popup HTML');
    ok('Battles: both ground polygons and rim labels carry the full battle popup HTML');

    // Open 3D viewer and verify MapLibre layers + click-to-popup for Battles
    Viewer3D.setEntryGate(() => Promise.resolve(true));
    const opened = await Viewer3D.open();
    assert.strictEqual(opened, true, '3D viewer opens with FakeMap');
    currentFakeMap.fire('load');
    Viewer3D.syncLayers();

    const battlesLayerPrefix = Object.keys(fakeLayers).find((id) => id.endsWith('-fill') && fakeSources[fakeLayers[id].source]);
    assert.ok(battlesLayerPrefix, 'MapLibre -fill layer created for Battles');
    const baseEntryId = battlesLayerPrefix.replace(/-fill$/, '');
    assert.ok(fakeLayers[baseEntryId + '-fill'], 'Battles -fill layer present');
    assert.ok(fakeLayers[baseEntryId + '-line'], 'Battles -line layer present');
    assert.ok(fakeLayers[baseEntryId + '-circle'], 'Battles -circle layer present');
    assert.ok(fakeLayers[baseEntryId + '-label'], 'Battles -label layer present');

    // Simulate clicking a 9 km battle ground polygon in 3D when overlapping a 26 km zone
    const baiaPoly = byTitle15['Bătălia de la Baia'].poly;
    const vasluiPoly = byTitle15['Bătălia de la Vaslui (Podul Înalt)'].poly;
    lastPopup = null;
    currentFakeMap.fire('click', baseEntryId + '-fill', {
        features: [vasluiPoly, baiaPoly],
        lngLat: { lng: baiaPoly.properties.lng, lat: baiaPoly.properties.lat }
    });
    assert.ok(lastPopup && lastPopup.html.includes('Bătălia de la Baia'),
        'clicking overlapping battle polygons in 3D opens the smaller 9 km battle popup (Baia)');
    assert.ok(lastPopup.html.includes('Ștefan cel Mare'),
        '3D battle popup shows participants and details');

    // Simulate clicking Posada's 26 km ground polygon in 3D
    const posadaPoly = byTitle['Bătălia de la Posada'].poly;
    lastPopup = null;
    currentFakeMap.fire('click', baseEntryId + '-fill', {
        features: [posadaPoly],
        lngLat: { lng: posadaPoly.properties.lng, lat: posadaPoly.properties.lat }
    });
    assert.ok(lastPopup && lastPopup.html.includes('Bătălia de la Posada') && lastPopup.html.includes('Basarab I'),
        'clicking Posada 26 km radius polygon in 3D opens Posada details');

    // Simulate clicking a battle label in 3D
    const rovineLabel = bLabels.find((f) => f.properties.label === 'Bătălia de la Rovine');
    lastPopup = null;
    currentFakeMap.fire('click', baseEntryId + '-label', {
        features: [rovineLabel],
        lngLat: { lng: rovineLabel.geometry.coordinates[0], lat: rovineLabel.geometry.coordinates[1] }
    });
    assert.ok(lastPopup && lastPopup.html.includes('Bătălia de la Rovine') && lastPopup.html.includes('Mircea cel Bătrân'),
        'clicking a battle label in 3D opens the battle popup with details');
    ok('Battles: clicking a battle radius polygon or label in 3D opens its popup with details');

    // Period change (Century XX -> 26 battles) updates 3D
    w.setBattlesPeriod(20);
    const d20 = deck();
    const item20 = d20.items.find((i) => i.label === 'Battles');
    assert.strictEqual(item20.geojson.features.filter((f) => f.geometry.type === 'Polygon').length, 26,
        'changing century slider to XX updates 3D to 26 battle ground polygons');

    // Language change (RO -> EN) updates 3D labels and popups
    w.setBattlesPeriod(14);
    curLang = 'en';
    w.document.dispatchEvent(new w.Event('detectlab:langchange'));
    const dEn = deck();
    const itemEn = dEn.items.find((i) => i.label === 'Battles');
    const enPolys = itemEn.geojson.features.filter((f) => f.geometry.type === 'Polygon');
    assert.ok(enPolys.some((f) => f.properties.title === 'Battle of Posada' && f.properties.popup.includes('Battle of Posada')),
        'switching language to EN updates 3D battle titles and popups');
    ok('Battles: period slider and language changes propagate immediately to 3D');

    // Turning Battles off removes it from 3D
    w.toggleBattlesLayer(false);
    assert.strictEqual(deck().items.filter((i) => i.label === 'Battles').length, 0,
        'switching Battles off removes it from the 3D deck');
    ok('Battles: switching the layer off removes all battle features from 3D');

    /* ═══════════════════════════════════════════════════════════════════════
     * 2. ARCHEOLOGICAL REPORT LAYER — 3D ground projection & click-to-popup
     * ═══════════════════════════════════════════════════════════════════════ */
    w.toggleArcheoReportLayer(true);
    w._archeoReportSetPoint(46.8, 23.6);

    // Before running the report: search circle alone is projected as a 3,000 m ground polygon
    const dSearch = deck();
    const searchItem = dSearch.items.find((i) => i.label === 'Archeological Report');
    assert.ok(searchItem && searchItem.perFeature === true, 'search circle before running report is a 3D ground vector');
    const searchPolys = searchItem.geojson.features.filter((f) => f.geometry.type === 'Polygon');
    assert.strictEqual(searchPolys.length, 1, '1 ground polygon for the search area circle');
    assert.strictEqual(searchPolys[0].properties.kind, 'radius');
    const scCentre = ringCentre(searchPolys[0].geometry.coordinates[0]);
    const scRadiusM = haversineM(scCentre.lat, scCentre.lng, searchPolys[0].geometry.coordinates[0][0][1], searchPolys[0].geometry.coordinates[0][0][0]);
    assert.ok(Math.abs(scRadiusM - 3000) / 3000 < 0.01, `search circle ground radius ${scRadiusM.toFixed(0)} m matches 3,000 m`);
    ok('Archeological Report: search radius circle is projected as a 3,000 m ground polygon before report runs');

    // Render a 3-result report model on the map
    const sampleModel = {
        meta: {
            generatedAt: '2026-10-18T10:00:00.000Z',
            lang: 'en',
            radiusKm: 3,
            radiusM: 3000,
            center: { lat: 46.8, lng: 23.6 }
        },
        results: [
            {
                index: 1, total: 3,
                lat: 46.805, lng: 23.608,
                score: 0.94, scorePct: 94,
                classification: 'very_high',
                classificationLabel: 'Very high archaeological potential',
                label: 'Result 1/3',
                annotated: true,
                parts: {
                    apmCls: 5, apmComp: 1,
                    potentialInside: true, potentialScore: 0.88, potentialDistM: 0,
                    lidarPoint: { name: 'Fortification rampart' }, lidarDistM: 0,
                    romanRoadApplied: true, romanRoadDistM: 220,
                    uatClearanceM: 850
                },
                nearestSites: [
                    { name: 'Castrul Roman Gilău', ran: '54984.01', distanceM: 820, url: 'https://ran.cimec.ro/sel.asp?codran=54984.01' }
                ],
                period: { key: 'roman', label: 'Roman period (1st–4th c. AD)', confidence: 0.85, evidence: [] }
            },
            {
                index: 2, total: 3,
                lat: 46.794, lng: 23.612,
                score: 0.82, scorePct: 82,
                classification: 'high',
                classificationLabel: 'High archaeological potential',
                label: 'Result 2/3',
                annotated: false,
                parts: {
                    apmCls: 4.5, apmComp: 0.85,
                    potentialInside: false, potentialScore: 0.78, potentialDistM: 180,
                    lidarPoint: null, lidarDistM: 120,
                    romanRoadApplied: false, romanRoadDistM: null,
                    uatClearanceM: 920
                },
                nearestSites: [
                    { name: 'Așezarea dacică Someș', ran: '54984.02', distanceM: 950, url: 'https://ran.cimec.ro/sel.asp?codran=54984.02' }
                ],
                period: { key: 'dacian', label: 'Dacian / Geto-Dacian (2nd c. BC – 1st c. AD)', confidence: 0.75, evidence: [] }
            },
            {
                index: 3, total: 3,
                lat: 46.798, lng: 23.588,
                score: 0.71, scorePct: 71,
                classification: 'medium',
                classificationLabel: 'Medium archaeological potential',
                label: 'Result 3/3',
                annotated: false,
                parts: {
                    apmCls: 4, apmComp: 0.75,
                    potentialInside: false, potentialScore: 0.70, potentialDistM: 250,
                    lidarPoint: null, lidarDistM: null,
                    romanRoadApplied: false, romanRoadDistM: null,
                    uatClearanceM: 640
                },
                nearestSites: [],
                period: { key: null, label: null, confidence: 0, evidence: [] }
            }
        ]
    };

    R.renderResults(sampleModel);
    Viewer3D.syncLayers();

    const dRep = deck();
    assert.strictEqual(dRep.capped.length, 0, 'nothing dropped when Archeological Report results are rendered');
    assert.strictEqual(dRep.unsupported.length, 0, 'nothing unsupported when Archeological Report results are rendered');
    const repItems = dRep.items.filter((i) => i.label === 'Archeological Report');
    assert.strictEqual(repItems.length, 1,
        'search circle and 3 result rings/points form ONE 3D source (no duplicate 2D circle dots)');

    const repItem = repItems[0];
    const rFeatures = repItem.geojson.features;
    const rPolys = rFeatures.filter((f) => f.geometry.type === 'Polygon');
    const rPoints = rFeatures.filter((f) => f.geometry.type === 'Point');
    const resultRings = rPolys.filter((f) => f.properties.kind === 'result-ring');
    const resultPoints = rPoints.filter((f) => f.properties.kind === 'result-point');

    assert.strictEqual(rPolys.length, 4, '4 ground polygons in 3D: 1 search circle (3 km) + 3 result rings (180 m)');
    assert.strictEqual(resultRings.length, 3, '3 result ground rings in 3D');
    assert.strictEqual(resultPoints.length, 3, '3 result centre points in 3D');

    // Verify each result ring is a 32-segment 180 m ground polygon
    resultRings.forEach((ringFeat, idx) => {
        const ring = ringFeat.geometry.coordinates[0];
        assert.strictEqual(ring.length, 33, 'result ring is a closed 32-segment polygon');
        const c = ringCentre(ring);
        const radM = haversineM(c.lat, c.lng, ring[0][1], ring[0][0]);
        assert.ok(Math.abs(radM - R.config.RESULT_RADIUS_M) / R.config.RESULT_RADIUS_M < 0.01,
            `result ${idx + 1} ground ring radius ${radM.toFixed(1)} m matches ${R.config.RESULT_RADIUS_M} m within 1 %`);
        assert.strictEqual(ringFeat.properties.color, R.config.RENDER.COLOR);
        assert.strictEqual(ringFeat.properties.fillColor, R.config.RENDER.FILL);
        assert.ok(ringFeat.properties.popup && ringFeat.properties.popup.includes(sampleModel.results[idx].scorePct + '%'),
            `result ${idx + 1} ground ring carries its detail popup HTML`);
    });
    ok('Archeological Report: 3 result rings are projected as 180 m ground polygons with detail popups');

    // Verify each result point is at [res.lng, res.lat] with label + popup
    resultPoints.forEach((ptFeat, idx) => {
        const expected = sampleModel.results[idx];
        assert.strictEqual(ptFeat.geometry.coordinates[0], expected.lng);
        assert.strictEqual(ptFeat.geometry.coordinates[1], expected.lat);
        assert.strictEqual(ptFeat.properties.radius, 7);
        assert.ok(ptFeat.properties.label.includes('Result ' + expected.index + '/3') &&
            ptFeat.properties.label.includes(expected.scorePct + '%'),
            `result ${idx + 1} point carries label "${ptFeat.properties.label}"`);
        assert.ok(ptFeat.properties.popup &&
            ptFeat.properties.popup.includes('Result ' + expected.index + '/3') &&
            ptFeat.properties.popup.includes(expected.scorePct + '%'),
            `result ${idx + 1} point carries full detail popup HTML`);
    });
    ok('Archeological Report: 3 result points are projected at exact coordinates with labels and detail popups');

    // Verify clicking result point AND clicking result ground ring in 3D opens the detail popup
    const repFillId = Object.keys(fakeLayers).find((id) => id.endsWith('-fill') &&
        fakeSources[fakeLayers[id].source] &&
        fakeSources[fakeLayers[id].source].data === repItem.geojson);
    assert.ok(repFillId, 'MapLibre -fill layer created for Archeological Report');
    const repBaseId = repFillId.replace(/-fill$/, '');
    assert.ok(fakeLayers[repBaseId + '-circle'], 'MapLibre -circle layer created for Archeological Report result points');
    assert.ok(fakeLayers[repBaseId + '-label'], 'MapLibre -label layer created for Archeological Report result tags');

    // 1) Click Result 1 point in 3D
    lastPopup = null;
    currentFakeMap.fire('click', repBaseId + '-circle', {
        features: [resultPoints[0]],
        lngLat: { lng: resultPoints[0].geometry.coordinates[0], lat: resultPoints[0].geometry.coordinates[1] }
    });
    assert.ok(lastPopup && lastPopup.html.includes('94%') &&
        lastPopup.html.includes('Castrul Roman Gilău') &&
        lastPopup.html.includes('Fortification rampart') &&
        lastPopup.html.includes('dl-gmaps-directions-btn'),
        'clicking a result point in 3D opens the popup with score, classification, LIDAR note, nearest site, and directions link');

    // 2) Click Result 2 ground ring in 3D (even when the 3 km kind="radius" search circle is first in event.features!)
    const searchRadiusPoly = rPolys.find((f) => f.properties.kind === 'radius');
    lastPopup = null;
    currentFakeMap.fire('click', repBaseId + '-fill', {
        features: [searchRadiusPoly, resultRings[1]],
        lngLat: { lng: resultRings[1].properties.lng, lat: resultRings[1].properties.lat }
    });
    assert.ok(lastPopup && lastPopup.html.includes('82%') &&
        lastPopup.html.includes('Așezarea dacică Someș'),
        'clicking a 180 m result ring inside the 3 km search circle in 3D opens the result popup (never blocked by the search circle)');

    // 3) Click the 3 km search circle alone (outside any result) -> no popup opens
    lastPopup = null;
    currentFakeMap.fire('click', repBaseId + '-fill', {
        features: [searchRadiusPoly],
        lngLat: { lng: 23.6, lat: 46.8 }
    });
    assert.strictEqual(lastPopup, null, 'clicking the non-interactive 3 km search circle alone in 3D does not open a popup');
    ok('Archeological Report: clicking result points or 180 m rings in 3D opens full candidate details');

    // Unticking "Show results" hides results in 3D and falls back to search circle only
    const showCheckbox = w.document.getElementById('archReportResultsToggle');
    showCheckbox.checked = false;
    showCheckbox.dispatchEvent(new w.Event('change'));
    const dHidden = deck();
    const hiddenItem = dHidden.items.find((i) => i.label === 'Archeological Report');
    assert.ok(hiddenItem, 'search circle remains when results are hidden');
    assert.strictEqual(hiddenItem.geojson.features.filter((f) => f.properties.kind === 'result-ring').length, 0,
        'unticking Show results removes result rings from 3D');
    assert.strictEqual(hiddenItem.geojson.features.filter((f) => f.properties.kind === 'result-point').length, 0,
        'unticking Show results removes result points from 3D');

    // Ticking "Show results" again brings them back in 3D
    showCheckbox.checked = true;
    showCheckbox.dispatchEvent(new w.Event('change'));
    const dRestored = deck();
    const restoredItem = dRestored.items.find((i) => i.label === 'Archeological Report');
    assert.strictEqual(restoredItem.geojson.features.filter((f) => f.properties.kind === 'result-point').length, 3,
        'ticking Show results restores the 3 result points in 3D');

    // Switching the Archeological Report layer off clears everything from 3D
    w.toggleArcheoReportLayer(false);
    assert.strictEqual(deck().items.filter((i) => i.label === 'Archeological Report').length, 0,
        'switching Archeological Report off removes all its features from 3D');
    ok('Archeological Report: show/hide results toggle and layer switch stay in sync with 3D');

    Viewer3D.close();
    console.log(`\n✅ Battles & Archeological Report 3D projection + click popups: ${passed} checks passed.`);
})().catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
