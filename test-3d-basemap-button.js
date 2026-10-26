// Test suite for the base-layer button in the 3D view.
//
// The ask: "The base map in 3D view should still appear as its side button on
// the bottom left side of the screen, above the info button and the altitude
// distance."
//
// While 3D is on, `body.is-3d #detectlab-map .leaflet-control-container` is
// hidden — the Leaflet controls drive the invisible 2D map — and the base map
// was only reachable through the picker in the 3D bar. The base-layer button
// (#arcgisBasemapCtrl, the round layers icon the whole app uses) must stay on
// screen in its bottom-left slot, ABOVE MapLibre's own bottom-left widgets: the
// compact source-credit button (the ⓘ) and the scale bar ("the distance").
//
// So this file pins:
//   1. css/map3d-terrain.css — the corner stays hidden for every control
//      EXCEPT #arcgisBasemapCtrl, whose bottom margin rides on the measured
//      --m3d-basemap-lift (with a documented fallback), i.e. above the
//      MapLibre stack instead of on top of it;
//   2. js/map3d-terrain.js — the lift is MEASURED from the real geometry
//      (Leaflet's own corner bottom → MapLibre's corner top + the 8px gap used
//      everywhere else in that column), published on .map-wrapper, refreshed
//      from the one place every layout change already passes through, and
//      followed with a ResizeObserver because the credit row grows when the ⓘ
//      is opened;
//   3. the assets are re-tagged and precached so installed PWAs get the fix.
//
// No network, account or npm dependencies.
// Usage: node test-3d-basemap-button.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Base-layer button stays on screen in the 3D view...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const css = read('css/map3d-terrain.css');
const viewer = read('js/map3d-terrain.js');
const html = read('index.html');
const sw = read('sw.js');

/* index.html serves the viewer at the desktop-basemap tag; only the skin was
 * re-tagged for the PWA 38×38 button sizing / 3D centre change. */
const TAG = '20261026-desktop-basemap';
const TAG_CSS = '20261026-pwa-3d-button-size';
const flatten = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');

/* ══════════════════════════════════════════════════════════════
   1. CSS: one control survives the 3D blanket, above MapLibre's stack
   ══════════════════════════════════════════════════════════════ */
{
    const rules = flatten(css);

    assert(/body\.is-3d #detectlab-map \.leaflet-control-container/.test(rules) &&
           /visibility: hidden/.test(rules.split('body.is-3d #detectlab-map .leaflet-control-container')[1].split('}')[0] + '}'),
        'the Leaflet control container is still hidden while 3D is on');

    /* The exception: everything else in the bottom-left corner is display:none,
     * the base-layer button is not. */
    const siblings = /body\.is-3d #detectlab-map \.leaflet-bottom\.leaflet-left > \.leaflet-control:not\(#arcgisBasemapCtrl\) \{ display: none !important; \}/;
    assert(siblings.test(rules),
        'every OTHER bottom-left Leaflet control (compass, attribution) is removed from the 3D corner');

    const reveal = rules.split('body.is-3d #detectlab-map #arcgisBasemapCtrl {')[1];
    assert(reveal, 'the 3D rule that keeps #arcgisBasemapCtrl on screen exists');
    const declarations = reveal.split('}')[0];
    assert(/visibility: visible/.test(declarations),
        'and it re-reveals the control (a visible child inside a hidden container)');
    assert(/margin-bottom: var\(--m3d-basemap-lift, 58px\) !important/.test(declarations),
        'the control rides above MapLibre\'s ⓘ + scale by the measured lift (58px documented fallback)');

    /* The lift must not be applied outside 3D: in 2D the corner is untouched. */
    const outside = rules.replace(/body\.is-3d[^{]*\{[^}]*\}/g, '');
    assert(!/--m3d-basemap-lift/.test(outside),
        '--m3d-basemap-lift is consumed under body.is-3d only (the 2D column is unchanged)');

    console.log('  ✓ css/map3d-terrain.css: base-layer button visible in 3D, above the ⓘ and the scale');
}

/* ══════════════════════════════════════════════════════════════
   2. js/map3d-terrain.js: the lift is measured, published, followed
   ══════════════════════════════════════════════════════════════ */
function section(start, end) {
    const from = viewer.indexOf(start);
    const to = viewer.indexOf(end, from);
    assert(from >= 0 && to > from, 'production section must exist: ' + start);
    return viewer.slice(from, to);
}

{
    const liftCode = section('var BASEMAP_LIFT_ID =', 'function watchToggleAnchor()');

    assert(/var BASEMAP_LIFT_ID = 'arcgisBasemapCtrl';/.test(viewer),
        'the viewer names the same control js/map-app.js builds');
    assert(/--m3d-basemap-lift/.test(liftCode), 'it publishes --m3d-basemap-lift');
    assert(/\.maplibregl-ctrl-bottom-left/.test(liftCode),
        'the reference is MapLibre\'s own bottom-left corner (ⓘ + scale)');
    assert(/removeProperty\('--m3d-basemap-lift'\)/.test(liftCode),
        'the property is dropped when the corner is not there (stylesheet fallback takes over)');
    assert(/new root\.ResizeObserver\(queueAnchorSync\)\.observe\(corner\)/.test(liftCode.replace(/\s*\n\s*/g, ' ')) ||
           /ResizeObserver\(queueAnchorSync\)/.test(liftCode),
        'the corner is observed: the credit row grows when the ⓘ is opened');

    /* Called from the single place every layout change already passes through,
     * and measured once the MapLibre controls are actually in the corner. */
    const anchorFn = section('function syncToggleAnchor()', 'function watchToggleAnchor()');
    assert(/syncBasemapLift\(\);/.test(anchorFn),
        'every anchor sync (open, close, resize, mutation) also refreshes the lift');
    const addControls = section('if (maplibre.AttributionControl) {', 'watchContextLoss();');
    assert(/maplibre\.ctrl-bottom-left|maplibre\.AttributionControl/.test(addControls) === false ||
           /queueAnchorSync\(\);/.test(addControls),
        'the measurement is queued as soon as MapLibre\'s corner exists');
    assert(/new maplibre\.ScaleControl[\s\S]*queueAnchorSync\(\);/.test(addControls),
        'it is queued right after the bottom-left controls (ⓘ + scale) are added');
    assert(/_syncBasemapLift: syncBasemapLift|_syncBasemapLift: *syncBasemapLift/.test(viewer) &&
           /_basemapLift: function \(\)/.test(viewer),
        'the measured lift is exposed for diagnostics and tests');

    console.log('  ✓ js/map3d-terrain.js: lift measured, published, followed and exposed');
}

/* ══════════════════════════════════════════════════════════════
   3. The arithmetic and the property, run against a stub layout
   ══════════════════════════════════════════════════════════════ */
{
    const liftCode = section('var BASEMAP_LIFT_ID =', 'function watchToggleAnchor()');

    function run(scenario) {
        const props = {};
        const wrapperEl = {
            style: {
                setProperty: (k, v) => { props[k] = v; },
                removeProperty: (k) => { delete props[k]; }
            },
            getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 1200, height: 800 })
        };
        const corner = scenario.corner === null ? null : {
            getBoundingClientRect: () => scenario.corner
        };
        const maplibreCorner = scenario.maplibre === null ? null : {
            getBoundingClientRect: () => scenario.maplibre
        };
        const ctrl = scenario.leafletCorner === null ? null : { parentElement: {
            getBoundingClientRect: () => scenario.leafletCorner
        } };
        const sandbox = {
            ANCHOR_GAP: 8,
            wrapper: () => wrapperEl,
            surface: { querySelector: sel => sel === '.maplibregl-ctrl-bottom-left' ? maplibreCorner : null },
            document: { getElementById: id => id === 'arcgisBasemapCtrl' ? ctrl : null },
            queueAnchorSync: () => {},
            root: { ResizeObserver: function (cb) { this.observe = () => {}; } },
            console: console
        };
        vm.runInNewContext(liftCode + '\nresult = syncBasemapLift();', sandbox);
        return { measured: sandbox.result, props };
    }

    /* MapLibre's corner top sits 108px above the wrapper bottom (ⓘ + scale +
     * margins); Leaflet's corner bottom is the wrapper bottom. */
    const aligned = run({
        corner: { top: 692, height: 40, bottom: 800 },
        leafletCorner: { bottom: 800 },
        maplibre: { top: 692, height: 108, bottom: 800 }
    });
    assert.strictEqual(aligned.measured, true, 'the corner is measured');
    assert.strictEqual(aligned.props['--m3d-basemap-lift'], '116px',
        'lift = MapLibre corner top → Leaflet corner bottom + 8px gap (got ' +
        aligned.props['--m3d-basemap-lift'] + ')');

    /* The installed PWA lifts the Leaflet corner by the home-indicator inset;
     * MapLibre lifts its own by the same inset — the lift must not double it. */
    const inset = run({
        corner: { top: 672, height: 40, bottom: 780 },
        leafletCorner: { bottom: 780 },
        maplibre: { top: 672, height: 108, bottom: 780 }
    });
    assert.strictEqual(inset.props['--m3d-basemap-lift'], '116px',
        'a shared safe-area inset cancels out (measured from Leaflet\'s own corner bottom)');

    /* No MapLibre corner (map closed / Cesium engine): fall back to the CSS. */
    const noCorner = run({
        corner: { top: 0, height: 0, bottom: 0 },
        leafletCorner: { bottom: 800 },
        maplibre: null
    });
    assert.strictEqual(noCorner.measured, false, 'an unbuilt 3D surface is not measured');
    assert(!('--m3d-basemap-lift' in noCorner.props),
        'and the property is cleared so the 58px fallback places the button');

    console.log('  ✓ measured lift: 116px for the documented stack, inset-safe, cleared without a surface');
}

/* ══════════════════════════════════════════════════════════════
   4. Assets: re-tagged and precached
   ══════════════════════════════════════════════════════════════ */
{
    assert(html.includes('css/map3d-terrain.css?v=' + TAG_CSS), 'index.html loads the re-tagged 3D skin');
    assert(html.includes('js/map3d-terrain.js?v=' + TAG), 'index.html loads the re-tagged viewer');
    assert(sw.includes("'css/map3d-terrain.css?v=" + TAG_CSS + "'"), 'sw.js precaches the re-tagged skin');
    assert(sw.includes("'js/map3d-terrain.js?v=" + TAG + "'"), 'sw.js precaches the re-tagged viewer');
    const shellVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
    assert(shellVersion >= 276, 'sw.js cache is v276 or newer (got v' + shellVersion + ')');

    console.log('  ✓ assets re-tagged ?v=' + TAG + ' and precached (shell v' + shellVersion + ')');
}

console.log('\nAll 3D base-layer button tests passed ✔');
