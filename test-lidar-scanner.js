// Integration tests for js/lidar-geo.js and js/lidar-scanner.js
// Usage: node test-lidar-scanner.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let addedLayers = [];
let removedLayers = [];
let mapEventListeners = {};

// Leaflet's stock pane z-indexes, plus the LIDAR imagery pane created by
// map-app.js. The scanner must place everything it draws above pane_lidar,
// otherwise the search pin and the result tags are painted underneath the
// terrain tiles and vanish as soon as a LIDAR sub-layer is switched on.
const BUILTIN_PANE_Z = {
    tilePane: 200,
    overlayPane: 400,
    shadowPane: 500,
    markerPane: 600,
    tooltipPane: 650,
    popupPane: 700
};
const LIDAR_PANE_Z = 610; // js/map-app.js -> map.getPane('pane_lidar')

// Panes the app creates outside the scanner, so the test resolves a realistic
// z-index for any pane the scanner asks for.
const mapPanes = Object.assign({}, BUILTIN_PANE_Z, { pane_lidar: LIDAR_PANE_Z });

const mockMap = {
    panes: {},
    addLayer(layer) { addedLayers.push(layer); return this; },
    removeLayer(layer) { removedLayers.push(layer); return this; },
    on(event, fn) { mapEventListeners[event] = fn; return this; },
    off(event) { delete mapEventListeners[event]; return this; },
    fitBounds() {},
    createPane(name) {
        // Mirror Leaflet: creating an existing pane returns the existing node.
        if (!this.panes[name]) this.panes[name] = { name, style: {} };
        return this.panes[name];
    },
    getPane(name) {
        if (this.panes[name]) return this.panes[name];
        // Built-in / foreign panes exist without the scanner creating them.
        if (mapPanes[name] !== undefined) {
            this.panes[name] = { name, style: { zIndex: mapPanes[name] } };
            return this.panes[name];
        }
        return undefined;
    }
};

// Effective z-index of the pane a layer was placed on. A layer with no pane
// option falls back to Leaflet's default for its type.
function paneZIndexOf(layer, defaultPane) {
    const name = (layer.options && layer.options.pane) || defaultPane;
    const pane = mockMap.getPane(name);
    assert(pane, 'layer refers to a pane that was never created: ' + name);
    const z = Number(pane.style.zIndex);
    assert(isFinite(z), 'pane ' + name + ' has no numeric z-index');
    return z;
}

const domElements = {
    lidarScannerToggle: { checked: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } },
    lidarScannerDistance: { value: '10', listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } },
    lidarScannerDistanceValue: { textContent: '' },
    lidarScannerRun: { listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; } },
    lidarScannerStatus: { textContent: '' },
    lidarScannerRow: {
        classList: {
            toggle(cls, value) { this[cls] = value; }
        }
    },
    lidarScannerLoading: {
        classList: {
            add() {},
            remove() {}
        }
    }
};

const mockL = {
    circle(latlng, options) {
        return {
            type: 'circle',
            latlng,
            options,
            // Count redraws so the suite can prove the distance slider
            // coalesces its work instead of repainting per input event.
            radiusUpdates: 0,
            styleUpdates: [],
            bindTooltip(html, tooltipOptions) { this._tooltip = html; this._tooltipOpts = tooltipOptions; return this; },
            bindPopup(html) { this._popup = html; return this; },
            setRadius(radius) { this.options.radius = radius; this.radiusUpdates++; return this; },
            setStyle(style) {
                Object.keys(style).forEach(key => { this.options[key] = style[key]; });
                this.styleUpdates.push(style);
                return this;
            },
            addTo(map) { map.addLayer(this); return this; }
        };
    },
    marker(latlng, options) {
        return {
            type: 'marker',
            latlng,
            options,
            bindTooltip(html, tooltipOptions) { this._tooltip = html; this._tooltipOpts = tooltipOptions; return this; },
            bindPopup(html) { this._popup = html; return this; },
            addTo(map) { map.addLayer(this); return this; }
        };
    },
    divIcon(options) {
        return { type: 'divIcon', options };
    },
    // The scanner draws its circles on a shared canvas renderer. It is mocked
    // here (rather than left undefined) so the test covers the real code path
    // and can assert the renderer is pinned to a pane above the LIDAR tiles.
    canvas(options) {
        return { type: 'canvasRenderer', options };
    },
    layerGroup() {
        const layers = [];
        return {
            type: 'layerGroup',
            layers,
            addLayer(layer) { layers.push(layer); },
            clearLayers() { layers.length = 0; },
            addTo(map) { map.addLayer(this); return this; }
        };
    },
    latLngBounds() {
        return { pad() { return this; } };
    }
};

// Load the real geographic helper first so the test exercises Romanian CSV
// parsing all the way through normalization and radius scanning.
const geoWindow = {};
const geoSandbox = {
    window: geoWindow,
    Math,
    Object,
    Array,
    String,
    parseFloat,
    isFinite
};
vm.createContext(geoSandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'js/lidar-geo.js'), 'utf8'), geoSandbox);
const lidarGeo = geoWindow.LidarGeo;

const removedScannerRows = [
    '46.09811,23.55539,anomalie necunoscută',
    '46.09201,23.54846,anomalie necunoscută',
    '46.09234,23.54366,anomalie necunoscută',
    '46.12036,23.52000,anomalie necunoscută',
    '46.01570,23.49656,anomalie necunoscută',
    '45.90249,23.56876,fortificație'
];
/* Inject the retired coordinates into the fetched payload: the production CSV
   no longer contains them, but stale PWA caches and future regenerated files
   must still be unable to bring them back. */
const csvText = fs.readFileSync(path.join(__dirname, 'data/lidar_scanner_points.csv'), 'utf8').trimEnd() +
    '\n' + removedScannerRows.join('\n') + '\n';

// Short-lived timers are held so the test can inspect drag state before the
// scanner's release safety net fires.
const pendingTimers = new Map();
let nextTimerId = 1;
function flushTimers() {
    const pending = Array.from(pendingTimers.values());
    pendingTimers.clear();
    pending.forEach(fn => fn());
}

const sandbox = {
    console,
    // Run the cosmetic five-second scan delay immediately in tests, but keep
    // short timers (the slider's drag-release safety net) pending so the test
    // can observe the drag state rather than having it torn down instantly.
    setTimeout(fn, ms) {
        if (!(ms < 1000)) { fn(); return 0; }
        const id = nextTimerId++;
        pendingTimers.set(id, fn);
        return id;
    },
    clearTimeout(id) { pendingTimers.delete(id); },
    Promise,
    Math,
    JSON,
    isFinite,
    parseFloat,
    parseInt,
    document: {
        readyState: 'complete',
        addEventListener() {},
        getElementById(id) { return domElements[id] || null; },
        body: {
            classList: {
                _set: new Set(),
                toggle(cls, on) { if (on) this._set.add(cls); else this._set.delete(cls); },
                contains(cls) { return this._set.has(cls); }
            }
        }
    },
    window: {
        _dlMap: mockMap,
        _localLayerData: {}
    },
    L: mockL,
    LidarGeo: lidarGeo,
    fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve(csvText) })
};

sandbox.window.window = sandbox.window;
sandbox.window.document = sandbox.document;
sandbox.window.L = sandbox.L;
sandbox.window.LidarGeo = lidarGeo;

// Controllable animation frames. The distance slider is expected to coalesce
// its DOM/map writes into one frame instead of doing them per input event, so
// the test drives frames manually to observe that.
const frameQueue = new Map();
let nextFrameId = 1;
sandbox.window.requestAnimationFrame = fn => {
    const id = nextFrameId++;
    frameQueue.set(id, fn);
    return id;
};
sandbox.window.cancelAnimationFrame = id => { frameQueue.delete(id); };
function flushFrames() {
    const pending = Array.from(frameQueue.values());
    frameQueue.clear();
    pending.forEach(fn => fn());
}

const scriptCode = fs.readFileSync(path.join(__dirname, 'js/lidar-scanner.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(scriptCode, sandbox);

async function main() {
    console.log('[Test] Running LIDAR Scanner CSV and search point tests...');

    // Geographic helper accepts direct Romanian and English aliases.
    const aliasPoint = lidarGeo.load_points([{ Latitudine: '45,5', Longitudine: '22,25' }])[0];
    assert.strictEqual(aliasPoint.lat, 45.5, 'Romanian latitude alias should be accepted');
    assert.strictEqual(aliasPoint.lon, 22.25, 'Romanian longitude alias should be accepted');
    assert.strictEqual(aliasPoint.lng, 22.25, 'Leaflet lng alias should be populated');
    const englishPoint = lidarGeo.load_points([{ latitude: 46, longitude: 23 }])[0];
    assert.strictEqual(englishPoint.lat, 46, 'English latitude/longitude should remain supported');
    const legacyEcefPoint = lidarGeo.load_points([{ X: 6378137, Y: 0, Z: 0 }])[0];
    assert(Math.abs(legacyEcefPoint.lat) < 1e-10, 'legacy ECEF X/Y/Z should still convert to latitude');
    assert(Math.abs(legacyEcefPoint.lon) < 1e-10, 'legacy ECEF X/Y/Z should still convert to longitude');
    assert.throws(
        () => lidarGeo.load_points([{ category: 'missing coordinates' }]),
        /latitude\/longitude/,
        'A CSV without a supported coordinate pair should have a useful error'
    );

    // 1. Activate scanner and wait for the real CSV fetch/parse pipeline.
    assert(typeof sandbox.window.toggleLidarScannerLayer === 'function', 'toggleLidarScannerLayer should be exposed');
    sandbox.window.toggleLidarScannerLayer(true);
    await new Promise(resolve => setImmediate(resolve));
    assert(mapEventListeners.click, 'map click listener should be registered when active');
    // Derive the expected count from the CSV itself so the suite keeps working
    // as sites are added to data/lidar_scanner_points.csv. Rows whose
    // coordinates fall outside valid WGS 84 degrees are rejected by design, so
    // they are excluded here rather than masked by a hardcoded total.
    const csvDataRows = csvText.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).slice(1);
    const validCsvRows = csvDataRows.filter(line => {
        const cells = line.split(',');
        const lat = parseFloat(cells[0]);
        const lon = parseFloat(cells[1]);
        return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    }).length;
    const expectedLoadedRows = validCsvRows - removedScannerRows.length;
    assert.match(
        domElements.lidarScannerStatus.textContent,
        new RegExp('^' + expectedLoadedRows + ' points loaded'),
        'valid Romanian CSV rows should load except the ' + removedScannerRows.length +
            ' explicitly retired coordinates (' + expectedLoadedRows + ' expected)'
    );

    // 2. Click directly on the first CSV point.
    addedLayers = [];
    mapEventListeners.click({ latlng: { lat: 44.680496658, lng: 22.532812357 } });

    assert(addedLayers.length >= 2, 'search marker and search circle should be added to map');
    const marker = addedLayers.find(layer => layer.type === 'marker');
    const circle = addedLayers.find(layer => layer.type === 'circle');

    assert(marker, 'marker should be placed at search point');
    assert(circle, 'selection circle should be placed around search point');
    assert(marker.options.icon, 'marker should use custom divIcon');
    assert(marker.options.icon.options.className.includes('lidar-search-marker-wrapper'), 'divIcon should use the scanner wrapper class');
    assert(marker.options.icon.options.html.includes('lidar-search-dot'), 'divIcon should include the neon green dot');
    assert(marker.options.icon.options.html.includes('lidar-search-pulse'), 'divIcon should include the neon green pulse');
    assert(marker._tooltip.includes('Search Point / Punct căutare'), 'marker should have a bilingual search point tooltip');
    assert.strictEqual(circle.options.color, '#8cff66', 'circle stroke should be neon green');
    assert.strictEqual(circle.options.fillColor, '#39ff14', 'circle fill should be neon green');

    // ── Stacking: the search pin and its tag must clear every LIDAR layer ──
    // Leaflet's default marker pane is 600 and its overlay pane is 400, both
    // BELOW pane_lidar (610). Without explicit panes the pin and the search
    // radius were drawn underneath the LIDAR imagery and became invisible the
    // moment a sub-layer was enabled.
    const pinZ = paneZIndexOf(marker, 'markerPane');
    const pinTagZ = paneZIndexOf({ options: marker._tooltipOpts }, 'tooltipPane');
    const searchCircleZ = paneZIndexOf(circle, 'overlayPane');

    assert(
        pinZ > LIDAR_PANE_Z,
        'search pin must be painted above the LIDAR pane (' + LIDAR_PANE_Z + '), got ' + pinZ
    );
    assert(
        pinTagZ > LIDAR_PANE_Z,
        'search pin tag must be painted above the LIDAR pane (' + LIDAR_PANE_Z + '), got ' + pinTagZ
    );
    assert(
        searchCircleZ > LIDAR_PANE_Z,
        'search radius circle must be painted above the LIDAR pane (' + LIDAR_PANE_Z + '), got ' + searchCircleZ
    );
    // Tags ride above the pin so a label is never clipped by the pulsing dot.
    assert(
        pinTagZ >= pinZ,
        'tags should sit at or above the pin, got tag ' + pinTagZ + ' vs pin ' + pinZ
    );
    // ...but the scanner must not leapfrog the measurement/popup tooling.
    assert(
        pinTagZ < BUILTIN_PANE_Z.popupPane,
        'scanner panes must stay below popups (' + BUILTIN_PANE_Z.popupPane + '), got ' + pinTagZ
    );

    // 3. A 10 km scan at the first coordinate returns that CSV site and its
    // Romanian category, proving no X/Y/Z conversion is attempted.
    domElements.lidarScannerRun.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    const resultGroup = addedLayers.find(layer => layer.type === 'layerGroup');
    assert(resultGroup, 'scan results layer should be added to the map');
    assert(resultGroup.layers.length >= 1, '10 km scan should find at least the first CSV site');
    const scannedSite = resultGroup.layers.find(layer =>
        layer.latlng[0] === 44.680496658 && layer.latlng[1] === 22.532812357);
    assert(scannedSite, '10 km scan should include the site that was clicked');
    assert(scannedSite._tooltip.includes('fortificație'), 'Romanian category should be displayed');
    // Results are returned nearest-first, so the clicked site leads the list.
    assert.strictEqual(resultGroup.layers[0], scannedSite, 'closest site should be listed first');

    // Result labels must stay pinned to their site at every zoom level. A
    // tooltip offset is measured in screen pixels while the result circle is
    // measured in metres, so a large offset visibly drifts away from the site
    // as the user zooms (a 98 px offset is ~2.6 km at z12 but only ~10 m at
    // z20). Keeping the offset small anchors the label on the site itself.
    const resultTooltipOpts = scannedSite._tooltipOpts;
    assert.strictEqual(resultTooltipOpts.permanent, true, 'result label should stay visible');
    assert.strictEqual(resultTooltipOpts.direction, 'top', 'result label should sit above its site');
    assert.strictEqual(resultTooltipOpts.offset[0], 0, 'result label should not be pushed sideways');
    assert(
        Math.abs(resultTooltipOpts.offset[1]) <= 20,
        'result label offset must stay small so it does not drift from its site when zooming, got ' + resultTooltipOpts.offset[1]
    );
    assert.deepStrictEqual(
        Array.from(scannedSite.latlng),
        [44.680496658, 22.532812357],
        'result should use WGS 84 latitude/longitude directly'
    );

    // Scan result rings and their permanent category tags must clear the LIDAR
    // imagery too — a result drawn under a hillshade tile is unreadable.
    const resultRingZ = paneZIndexOf(scannedSite, 'overlayPane');
    const resultTagZ = paneZIndexOf({ options: resultTooltipOpts }, 'tooltipPane');
    assert(
        resultRingZ > LIDAR_PANE_Z,
        'result ring must be painted above the LIDAR pane (' + LIDAR_PANE_Z + '), got ' + resultRingZ
    );
    assert(
        resultTagZ > LIDAR_PANE_Z,
        'result tag must be painted above the LIDAR pane (' + LIDAR_PANE_Z + '), got ' + resultTagZ
    );
    assert(
        resultTagZ >= resultRingZ,
        'result tags should sit above their rings, got tag ' + resultTagZ + ' vs ring ' + resultRingZ
    );

    // Result rings must NOT be handed the shared canvas renderer. They are
    // clickable, and their pane is pointer-events:none (see below); Leaflet's
    // stylesheet can only re-enable hit-testing for an interactive *SVG* path,
    // never for a shape painted into a canvas. A canvas-rendered ring inside
    // that pane would be permanently unclickable.
    assert(
        !scannedSite.options.renderer,
        'result rings must use the default SVG renderer so they stay clickable ' +
        'inside a pointer-events:none pane'
    );
    assert(
        scannedSite.options.interactive === true,
        'result rings carry a popup and must stay interactive'
    );

    // The scanner's circles pane holds a viewport-sized canvas (the search
    // circle's renderer). Leaflet neutralises pointer events for
    // `.leaflet-pane > svg path` but has no such rule for `.leaflet-pane >
    // canvas`, so at z-index 655 that canvas would sit over every interactive
    // layer on the map — the heritage polygons at 620, the UAT boundaries at
    // 402, the markers at 600 — and swallow their clicks across the whole
    // viewport. The pane must therefore be click-transparent, exactly like the
    // raster panes map-app.js creates.
    const circlesPane = mockMap.getPane(scannedSite.options.pane);
    assert(
        circlesPane.style.pointerEvents === 'none',
        'the scanner circles pane must be pointer-events:none so its full-viewport ' +
        'canvas cannot steal clicks from the layers underneath, got ' +
        JSON.stringify(circlesPane.style.pointerEvents)
    );

    // The pin and tag panes are small DOM elements, not full-viewport
    // surfaces, so they must keep normal pointer handling — the pin has a
    // tooltip and the operator can interact with it.
    for (const paneName of [marker.options.pane, resultTooltipOpts.pane]) {
        const pane = mockMap.getPane(paneName);
        assert(
            !pane.style.pointerEvents || pane.style.pointerEvents === 'auto',
            'pane ' + paneName + ' must keep pointer events, got ' +
            JSON.stringify(pane.style.pointerEvents)
        );
    }

    // The search circle keeps the canvas renderer: it is resized on every
    // frame of the distance drag, which is the one place canvas matters.
    assert(
        circle.options.renderer,
        'the search circle should keep its canvas renderer for drag performance'
    );
    const rendererZ = paneZIndexOf(circle.options.renderer, 'overlayPane');
    assert(
        rendererZ > LIDAR_PANE_Z,
        'the scanner canvas renderer must live above the LIDAR pane, got ' + rendererZ
    );

    // 4. Update distance slider.
    //
    // Dragging the slider used to redraw the (up to 50 km wide) search circle
    // synchronously on every single `input` event, which made the control lag
    // badly in the installed PWA. The work must now be coalesced into one
    // animation frame per paint, and the circle must drop its expensive dashed
    // fill for a plain outline while the drag is in progress.
    circle.radiusUpdates = 0;
    circle.styleUpdates = [];

    const slider = domElements.lidarScannerDistance;
    // Simulate a fast drag: many input events before the browser paints.
    ['12', '15', '19', '23', '25'].forEach(value => {
        slider.value = value;
        slider.listeners.input.call(slider);
    });

    assert.strictEqual(
        circle.radiusUpdates, 0,
        'no synchronous circle redraw should happen while input events are still arriving'
    );
    assert(
        sandbox.document.body.classList.contains('lidar-distance-dragging'),
        'the drag class should be set so CSS can drop the panel backdrop blur'
    );
    assert.strictEqual(circle.options.fill, false, 'circle fill should be disabled during the drag');
    assert.strictEqual(circle.options.dashArray, null, 'circle dash pattern should be dropped during the drag');

    flushFrames();
    assert.strictEqual(
        circle.radiusUpdates, 1,
        'a burst of 5 input events should coalesce into a single circle redraw, got ' + circle.radiusUpdates
    );
    assert.strictEqual(circle.options.radius, 25000, 'selection circle radius should update to 25 km');
    assert.strictEqual(domElements.lidarScannerDistanceValue.textContent, '25 km', 'the km readout should show the latest value');

    // Releasing the slider restores the decorated circle.
    slider.listeners.change.call(slider);
    assert(
        !sandbox.document.body.classList.contains('lidar-distance-dragging'),
        'the drag class should be cleared on release'
    );
    assert.strictEqual(circle.options.fill, true, 'circle fill should be restored after the drag');
    assert.strictEqual(circle.options.dashArray, '5 6', 'circle dash pattern should be restored after the drag');
    assert.strictEqual(circle.options.radius, 25000, 'released radius should be preserved');

    // A drag that is cancelled without a change/pointerup event (a phone call,
    // a palm reject) must still restore the circle via the idle safety net.
    slider.value = '40';
    slider.listeners.input.call(slider);
    flushFrames();
    assert.strictEqual(circle.options.fill, false, 'a new drag should strip the circle again');
    flushTimers();
    assert.strictEqual(circle.options.fill, true, 'an interrupted drag should still restore the circle');
    assert.strictEqual(circle.options.radius, 40000, 'interrupted drag should keep the last radius');

    // The selection circle must not intercept map clicks — the scanner relies
    // on clicks reaching the map to move the search point.
    assert.strictEqual(circle.options.interactive, false, 'selection circle must not swallow map clicks');

    // Restore the 25 km state the remaining assertions were written against.
    slider.value = '25';
    slider.listeners.input.call(slider);
    flushFrames();
    slider.listeners.change.call(slider);

    // 5. Sites are no longer clipped to LIDAR coverage tiles — a Dobrogea
    // point far outside the old county boxes must still be returned. Heritage
    // radiuses remain the only spatial exclusion.
    mapEventListeners.click({ latlng: { lat: 43.7708993, lng: 28.5362063 } });
    slider.value = '10';
    slider.listeners.input.call(slider);
    flushFrames();
    slider.listeners.change.call(slider);
    addedLayers = [];
    domElements.lidarScannerRun.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    const anywhereGroup = addedLayers.find(layer => layer.type === 'layerGroup') || resultGroup;
    const easternSite = anywhereGroup.layers.find(layer =>
        layer.latlng[0] === 43.7708993 && layer.latlng[1] === 28.5362063);
    assert(easternSite, 'sites outside former LIDAR coverage bounds must still be found');
    assert(easternSite._tooltip.includes('tumul'), 'appended Dobrogea site should keep its category');

    sandbox.window._localLayerData[0] = {
        features: [{
            geometry: { type: 'Point', coordinates: [28.5362063, 43.7708993] }
        }]
    };
    addedLayers = [];
    anywhereGroup.clearLayers();
    domElements.lidarScannerRun.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    const excluded = anywhereGroup.layers.find(layer =>
        layer.latlng[0] === 43.7708993 && layer.latlng[1] === 28.5362063);
    assert(!excluded, 'a site inside a heritage radius must still be filtered out');

    const api = sandbox.window._lidarScannerApi;
    assert(api.getPoints().some(p => p.lat === 43.7708993), 'raw CSV retains the annotation');
    assert(!api.getEligiblePoints().some(p => p.lat === 43.7708993), 'report API excludes the same heritage annotation as scanner');
    assert.strictEqual(api.resultRadiusM, 100, 'report exclusion matches the visible scanner ring');
    sandbox.window._localLayerData[0] = { features: [] };
    assert(api.getEligiblePoints().some(p => p.lat === 43.7708993), 'eligible annotations refresh after heritage data changes');

    // 6. Deactivate scanner.
    sandbox.window.toggleLidarScannerLayer(false);
    assert(!mapEventListeners.click, 'map click listener should be removed when deactivated');
    assert(removedLayers.includes(marker), 'selected marker should be removed when layer is turned off');
    assert(removedLayers.includes(circle), 'selection circle should be removed when layer is turned off');

    console.log('✅ ALL LIDAR SCANNER TESTS PASSED');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
