/*
 * test-3d-analysis-points.js
 * ───────────────────────────────────────────────────────────────────────────
 * Regression suite for the three 3D reports fixed on 2026-10-20:
 *
 *   1. “LiDAR Scanner points still don't show appropriately in 3D” — the
 *      scanner had no `_dl3dFeatures` bridge, so its L.circle results were
 *      mirrored through toGeoJSON() as bare centre Points whose
 *      circle-radius was the 100 m ground radius read as 100 PIXELS, its
 *      selection circle became a disc thousands of pixels wide, its search
 *      pin degraded to a label with no dot, and every result was carried
 *      twice (group bundle + the same child walked again at top level).
 *   2. “Archeological report points turn the map into topographic in 3D” —
 *      the DEM hillshade sat over the mirrored basemap at full shader
 *      strength: the configured `hillshade.opacity` (0.55) was never
 *      applied, so satellite imagery read as a grey topographic sheet.
 *      The report's own fill paint also carried an invalid 'line-color'
 *      entry, which MapLibre's style validation answers by refusing the
 *      whole fill layer.
 *   3. “Archeological Potential Sites turn the whole map purple in 3D” —
 *      the analysis pin's standalone L.circle (1–10 km) was mirrored the
 *      same way as the scanner's: a purple disc of thousands of pixels
 *      over everything, with the (purple-at-high-score) bubbles under it
 *      indistinguishable from the wash.
 *
 * The pins below:
 *   A. the mirror projects ANY standalone L.Circle as a ground polygon in
 *      metres (L.CircleMarker keeps its pixel radius — that one is honest);
 *   B. the real LiDAR Scanner, driven through its own UI flow, reaches the
 *      mirror exactly once per result, as 100 m ground rings + labelled
 *      centre points with popups, plus a ground selection polygon;
 *   C. the real Archaeological Potential pin reaches the mirror as a
 *      ground polygon + centre point, its HTML marker is skipped, and no
 *      mirrored paint anywhere carries a circle-radius measured in
 *      thousands of pixels;
 *   D. the 3D style applies the configured hillshade opacity to the
 *      shading colours, and every fill paint in the analysis bridges stays
 *      inside the fill namespace (the viewer also strips foreign keys).
 *
 * No network, no browser. jsdom + the real Leaflet/modules in the tree.
 * Usage: node test-3d-analysis-points.js   (needs jsdom — NODE_PATH is fine)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');

console.log('[Test] 3D analysis points (scanner / report / potential)…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

function haversineM(lat1, lng1, lat2, lng2) {
    const E = 6371008.8, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * E * Math.asin(Math.min(1, Math.sqrt(a)));
}
/* Ground radius of a closed mirror ring, measured from its centroid. */
function ringRadiusM(ring) {
    const pts = ring.slice(0, -1);
    const c = {
        lng: pts.reduce((s, p) => s + p[0], 0) / pts.length,
        lat: pts.reduce((s, p) => s + p[1], 0) / pts.length
    };
    return haversineM(c.lat, c.lng, ring[0][1], ring[0][0]);
}

/* ── one jsdom world with the real modules ─────────────────────────────── */
const html = `<!DOCTYPE html><html><body>
  <div id="detectlab-map"><div id="map"></div></div>
  <div id="lidarScannerRow"></div>
  <input type="checkbox" id="lidarScannerToggle">
  <input type="range" id="lidarScannerDistance" min="1" max="50" step="1" value="5">
  <span id="lidarScannerDistanceValue"></span>
  <button id="lidarScannerRun" style="display:none"></button>
  <div id="lidarScannerStatus"></div>
  <div id="lidarScannerLoading"></div>
  <input type="checkbox" id="archeoPotToggle">
  <input type="range" id="archeoPotDistance" min="1" max="10" step="1" value="5">
  <span id="archeoPotDistanceValue"></span>
  <button id="archeoPotRunBtn"></button>
  <div id="archeoPotStatus"></div>
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
    if (kind && kind !== '2d') return { getExtension: () => null, getParameter: () => 4096 };
    const base = {
        createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4), width, height }; },
        putImageData: noop, clearRect: noop, drawImage: noop, save: noop, restore: noop,
        measureText: () => ({ width: 10 })
    };
    return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
};
w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
w._currentLang = () => 'en';
const SCANNER_CSV = [
    'lat,lon,category,name',
    '46.07100,23.59100,Roman fort,Fort A',
    '46.07500,23.60000,Burial mound,Mound B',
    '47.50000,25.00000,Far away,Far C'
].join('\n');
w.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SCANNER_CSV) });

vm.runInContext(read('js/leaflet.js'), ctx);
vm.runInContext(read('js/layer-registry.js'), ctx);
vm.runInContext(read('js/map3d-mirror.js'), ctx);
vm.runInContext(read('js/map3d-terrain.js'), ctx);

const L = w.L;
const M = w.DetectLabMirror;
const Viewer3D = w.DetectLabMap3D;
assert.ok(L && M && Viewer3D, 'Leaflet, the mirror and the 3D viewer load together');
ok('Leaflet + mirror + viewer load together');

const map = L.map(w.document.getElementById('map'), { center: [46.07, 23.59], zoom: 13 });
w._dlMap = map;
w.map = map;

/* ═══════════════════════════════════════════════════════════════════════
 * A. THE MIRROR — a standalone L.Circle is a ground circle, in metres
 * ═══════════════════════════════════════════════════════════════════════ */
{
    const results = L.layerGroup();
    const ring = L.circle([46.07, 23.59], {
        radius: 100, color: '#8cff66', weight: 2, fillColor: '#39ff14', fillOpacity: 0.11, interactive: true
    }).addTo(results);
    results.addTo(map);
    const search = L.circle([46.07, 23.59], {
        radius: 5000, color: '#c4a0f0', weight: 1.8, fillColor: '#a070e8', fillOpacity: 0.05, interactive: false
    }).addTo(map);
    const dot = L.circleMarker([46.08, 23.60], {
        radius: 6, color: '#ffffff', fillColor: '#39ff14', fillOpacity: 0.9
    }).addTo(map);

    const out = M.collect(map);
    const polygons = [];
    out.items.forEach((item) => {
        (item.geojson && item.geojson.features || []).forEach((f) => {
            if (f.geometry && f.geometry.type === 'Polygon') polygons.push({ item, f });
        });
        /* The pixel-disc signature of the old behaviour: a "circle" paint
           whose radius is a ground distance read as pixels. */
        const paints = item.paints || {};
        ['circle'].forEach((set) => {
            const r = paints[set] && paints[set]['circle-radius'];
            assert.ok(!(typeof r === 'number' && r >= 1000),
                'no mirrored item carries a ' + r + ' px circle (metres read as pixels)');
        });
    });
    const radii = polygons.map((p) => Math.round(ringRadiusM(p.f.geometry.coordinates[0]))).sort((a, b) => a - b);
    assert.ok(radii.some((r) => Math.abs(r - 100) / 100 < 0.02), 'the 100 m result ring projects at 100 m on the ground (got ' + radii.join(', ') + ')');
    assert.ok(radii.some((r) => Math.abs(r - 5000) / 5000 < 0.02), 'the 5 km search circle projects at 5 km on the ground (got ' + radii.join(', ') + ')');
    /* CircleMarker: radius really is pixels, so it stays a point. */
    const dotItem = out.items.find((i) => (i.geojson && i.geojson.features || [])
        .some((f) => f.geometry && f.geometry.type === 'Point'));
    assert.ok(dotItem, 'the circleMarker still mirrors as a point');
    ok('mirror: L.Circle → ground polygon in metres; L.CircleMarker stays a pixel point; no metre-as-pixel discs');

    map.removeLayer(search); map.removeLayer(dot); map.removeLayer(results);
    void ring;
}

/* ═══════════════════════════════════════════════════════════════════════
 * B. LIDAR SCANNER — the real module, its real UI flow
 * ═══════════════════════════════════════════════════════════════════════ */
async function scannerChecks() {
    vm.runInContext(read('js/lidar-geo.js'), ctx);
    vm.runInContext(read('js/lidar-scanner.js'), ctx);
    /* The module wires itself on DOMContentLoaded while the jsdom
     * document is still loading; give it that tick before driving it. */
    await new Promise((r) => {
        if (w.document.readyState === 'complete') r();
        else { w.addEventListener('load', r); setTimeout(r, 500); }
    });

    const toggle = w.document.getElementById('lidarScannerToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new w.Event('change'));
    map.fire('click', { latlng: L.latLng(46.07, 23.59) });

    const api = w._lidarScannerApi;
    assert.ok(api && typeof api.selectionFeatures3d === 'function', 'the scanner exposes its 3D bridges');

    /* The selection: a 5 km ground polygon + the centre point, and the
       HTML search pin itself is skipped (its centre is in the bridge). */
    const sel = api.selectionFeatures3d();
    assert.ok(sel, 'the selection bridge produces features');
    const selPoly = sel.geojson.features.find((f) => f.geometry.type === 'Polygon');
    const selPoint = sel.geojson.features.find((f) => f.geometry.type === 'Point');
    assert.ok(selPoly && selPoint, 'the selection is a ground polygon plus its centre point');
    assert.ok(Math.abs(ringRadiusM(selPoly.geometry.coordinates[0]) - 5000) / 5000 < 0.02,
        'the selection polygon is the chosen 5 km radius on the ground');
    let pinSkipped = false;
    map.eachLayer((layer) => { if (layer instanceof L.Marker) pinSkipped = layer._dl3dSkip === true; });
    assert.ok(pinSkipped, 'the HTML search pin is marked _dl3dSkip (no invented 3D dot, no label-only pin)');
    ok('LiDAR Scanner: selection = 5 km ground polygon + centre point; HTML pin skipped');

    /* Run the scan (the module holds a deliberate 5 s “scanning” pause). */
    w.document.getElementById('lidarScannerRun').dispatchEvent(new w.Event('click'));
    await new Promise((r) => setTimeout(r, 5600));
    assert.strictEqual(api.getResultPoints().length, 2, 'the scan keeps the two points inside the radius');

    const out = M.collect(map);
    const resultRings = [];
    const resultPoints = [];
    out.items.forEach((item) => {
        if (item.label !== 'LiDAR Scanner') return;
        (item.geojson.features || []).forEach((f) => {
            if (f.geometry.type === 'Polygon' && f.properties.fillColor === '#39ff14' && f.properties.kind === 'lidar-result') resultRings.push(f);
            if (f.geometry.type === 'Point' && f.properties.kind === 'lidar-result-point') resultPoints.push(f);
        });
    });
    assert.strictEqual(resultRings.length, 2,
        'each scan result reaches 3D exactly once as a ground ring (no group/child duplication)');
    resultRings.forEach((f) => {
        assert.ok(Math.abs(ringRadiusM(f.geometry.coordinates[0]) - 100) / 100 < 0.02,
            'a result ring is 100 m on the ground, not a 100 px disc');
    });
    assert.strictEqual(resultPoints.length, 2, 'each result also carries a centre point');
    resultPoints.forEach((f) => {
        assert.ok(f.properties.label && f.properties.popup && f.properties.popup.includes(f.properties.label),
            'a result centre point carries its category label and popup');
    });
    ok('LiDAR Scanner: results = 100 m ground rings + labelled centre points with popups, exactly once each');

    toggle.checked = false;
    toggle.dispatchEvent(new w.Event('change'));
}

/* ═══════════════════════════════════════════════════════════════════════
 * C. ARCHAEOLOGICAL POTENTIAL — the purple pin
 * ═══════════════════════════════════════════════════════════════════════ */
function potentialChecks() {
    vm.runInContext(read('js/archeo-potential.js'), ctx);
    w._archeoPotSetPoint(46.07, 23.59);

    const dbg = w._archeoPotentialDebug;
    assert.ok(dbg && typeof dbg.pinFeatures3d === 'function', 'the potential layer exposes its pin bridge');
    const pin = dbg.pinFeatures3d();
    assert.ok(pin, 'the pin bridge produces features');
    const poly = pin.geojson.features.find((f) => f.geometry.type === 'Polygon');
    const point = pin.geojson.features.find((f) => f.geometry.type === 'Point');
    assert.ok(poly && point, 'the pin area is a ground polygon plus its centre point');
    assert.ok(Math.abs(ringRadiusM(poly.geometry.coordinates[0]) - 5000) / 5000 < 0.02,
        'the pin polygon is the chosen 5 km radius on the ground');

    let markerSkipped = false;
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker && layer.options && layer.options.pane === 'pane_archeo_pin') {
            markerSkipped = layer._dl3dSkip === true;
        }
    });
    assert.ok(markerSkipped, 'the purple HTML pin marker is marked _dl3dSkip');

    /* The whole-map purple wash, checked at the deck level: the pin must
       reach the mirror as ground geometry whose fill stays at the 2D
       0.05 fill opacity — never as a point with a kilometric pixel radius. */
    const out = M.collect(map);
    out.items.forEach((item) => {
        const paints = item.paints || {};
        const r = paints.circle && paints.circle['circle-radius'];
        assert.ok(!(typeof r === 'number' && r >= 1000),
            'no mirrored item can paint a ' + r + ' px disc over the 3D view');
    });
    const pinItem = out.items.find((i) => i.label === 'Archeological Potential Sites' &&
        (i.geojson.features || []).some((f) => f.geometry.type === 'Polygon'));
    assert.ok(pinItem && pinItem.perFeature === true, 'the pin area mirrors as per-feature ground vector');
    ok('Archeological Potential: pin = ground polygon + centre point; no purple pixel disc anywhere in the deck');
}

/* ═══════════════════════════════════════════════════════════════════════
 * D. REPORT / VIEWER — the basemap stays the basemap in 3D
 * ═══════════════════════════════════════════════════════════════════════ */
function viewerChecks() {
    const style = Viewer3D._buildStyle();
    const hillshade = style.layers.find((l) => l.id === 'm3d-hillshade');
    assert.ok(hillshade, 'the style carries the DEM hillshade');
    ['hillshade-shadow-color', 'hillshade-highlight-color', 'hillshade-accent-color'].forEach((key) => {
        const value = String(hillshade.paint[key]);
        assert.ok(/^rgba\(/.test(value) && /,0\.55\)$/.test(value),
            key + ' carries the configured 0.55 hillshade opacity (got ' + value + ')');
    });
    ok('3D style: DEM hillshade shades at the configured low opacity — the basemap stays itself');

    /* No analysis bridge may hand MapLibre a fill paint with a foreign
       property key (its style validation refuses the whole layer). */
    ['js/archeo-report.js', 'js/archeo-potential.js', 'js/battles-layer.js', 'js/lidar-scanner.js'].forEach((file) => {
        const src = read(file);
        const fills = src.match(/fill:\s*\{[^}]*\}/g) || [];
        fills.forEach((block) => {
            assert.ok(!/'(line|circle)-/.test(block), file + ' fill paint stays in the fill namespace: ' + block.replace(/\s+/g, ' '));
        });
    });
    const terrain = read('js/map3d-terrain.js');
    assert.ok(/paintForType\(fillPaint, 'fill'\)/.test(terrain) &&
        /paintForType\(linePaint, 'line'\)/.test(terrain) &&
        /paintForType\(circlePaint, 'circle'\)/.test(terrain),
        'the viewer strips foreign paint keys per layer type');
    ok('analysis bridges + viewer: no fill paint can smuggle a foreign key past MapLibre validation');

    /* Cache wiring for everything this fix changed. */
    const index = read('index.html');
    const sw = read('sw.js');
    const TAG = '20261020-3d-analysis-points';
    const VIEWER_TAG = '20261021-3d-switch-baselayer-column';
    ['js/lidar-scanner.js',
        'js/archeo-potential.js', 'js/archeo-report.js', 'js/battles-layer.js'].forEach((file) => {
        assert.ok(index.includes(file + '?v=' + TAG), 'index.html loads ' + file + ' at the analysis-points tag');
        assert.ok(sw.includes("'" + file + '?v=' + TAG + "'"), 'sw.js pre-caches ' + file + ' at the analysis-points tag');
    });
    /* The mirror ships its own tag since the canvas-tile fix
     * (DENMARK_LIDAR_3D_CANVAS.md); the old tag stays in sw.js for installed
     * shells that are still running the previous index.html. */
    const MIRROR_TAG = '20261021-lidar-canvas-tiles';
    assert.ok(index.includes('js/map3d-mirror.js?v=' + MIRROR_TAG), 'index.html loads the mirror at its canvas-tiles tag');
    assert.ok(sw.includes("'js/map3d-mirror.js?v=" + MIRROR_TAG + "'"), 'sw.js pre-caches the mirror at its canvas-tiles tag');
    assert.ok(sw.includes("'js/map3d-mirror.js?v=" + TAG + "'"), '…and keeps the previous mirror tag for installed shells');
    assert.ok(index.includes('js/map3d-terrain.js?v=' + VIEWER_TAG) &&
        sw.includes("'js/map3d-terrain.js?v=" + VIEWER_TAG + "'"),
        'the updated terrain viewer has its own cache-busting tag');
    assert.ok(Number((sw.match(/CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]) >= 240,
        'the shell cache is v240 or later (bumped again since — currently v243 PWA-hide-exaggeration)');
    ok('cache: changed assets re-tagged and pre-cached, shell cache v240+');
}

(async () => {
    await scannerChecks();
    potentialChecks();
    viewerChecks();
    console.log('\n✅ 3D analysis points: ' + passed + ' checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
