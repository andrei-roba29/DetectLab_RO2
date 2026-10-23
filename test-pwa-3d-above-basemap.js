/*
 * test-pwa-3d-above-basemap.js
 * ──────────────────────────────────────────────────────────────────────────
 * “Move the 3D button right above the base layer button, only in the PWA.”
 *
 * WHAT THE INSTALLED APP DID
 *   The 2D⇄3D switch is a fixed pill anchored bottom-CENTRE (58px on phones,
 *   66px on the website, 64px + the safe-area inset in the PWA's 3D view) —
 *   that is where css/map3d-terrain.css has always put it. In the installed
 *   app that slot is the only free strip of the bottom edge, so the pill
 *   floated between the map's own bottom-left control column and the country
 *   “Exit view” pill instead of belonging to either.
 *
 * THE FIX
 *   In the PWA (and only there) js/map3d-terrain.js mounts the switch into
 *   #map3d-toggle-slot, a plain row it inserts into Leaflet's bottom-left
 *   corner IMMEDIATELY BEFORE #arcgisBasemapCtrl (the base-layer button). A
 *   Leaflet bottom corner stacks top-down, so “before the basemap control” is
 *   exactly “one row above the base-layer button”, with the column's own 10px
 *   inset, safe-area anchoring, z-index and margins — no hard-coded offsets.
 *   When the basemap list unfolds, the column grows and the switch rides up
 *   with it. On the website toggleHost() keeps returning the map wrapper, so
 *   the bottom-centre layout is untouched.
 *
 *   In 3D the Leaflet column is hidden; the slot is the one survivor
 *   (visibility override), the rest of the column leaves the layout so the
 *   switch drops to the corner, and it steps 46px up to clear MapLibre's
 *   compact source-credit button.
 *
 * Run:  node test-pwa-3d-above-basemap.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');

const html = read('index.html');
const sw = read('sw.js');
const skin = read('css/map3d-terrain.css');
const viewer = read('js/map3d-terrain.js');
const registrySource = read('js/layer-registry.js');
const mirrorSource = read('js/map3d-mirror.js');

const TAG = '20261021-pwa-3d-above-basemap';

const flatten = (source) => source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
const skinFlat = flatten(skin);

function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(flatten(source));
    assert(match, 'missing CSS rule for ' + selector);
    return match[1];
}

console.log('[Test] PWA: the 2D⇄3D switch sits right above the base-layer button…');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The slot is ordinary flow content in the map's own column
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const slot = ruleOf(skin, '.m3d-toggle-slot');
    assert(/float:\s*left/.test(slot) && /clear:\s*both/.test(slot),
        'the slot is a column row (float + clear), like every Leaflet bottom-left control');
    assert(/margin:\s*0\s+0\s+8px\s+10px/.test(slot),
        'it keeps the column’s 10px left inset and an 8px gap above the base-layer button');
    assert(/pointer-events:\s*none/.test(slot),
        'the slot lets the map keep gestures; its buttons re-enable themselves');

    const group = ruleOf(skin, 'body.is-pwa #map3d-toggle-slot .m3d-toggle-group');
    assert(/position:\s*static/.test(group) && /bottom:\s*auto/.test(group) &&
           /transform:\s*none/.test(group) && /left:\s*auto/.test(group),
        'inside the slot the group is flow content — no absolute bottom-centre anchoring');
    console.log('  ✓ the slot is a normal row of the bottom-left column');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The website keeps the bottom-centre switch
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const base = ruleOf(skin, '.m3d-toggle-group');
    assert(/position:\s*absolute/.test(base) && /left:\s*50%/.test(base) &&
           /transform:\s*translateX\(-50%\)/.test(base),
        'the base rule still centres the switch — it is the website layout');
    assert(/bottom:\s*calc\(66px \+ var\(--layer-dock-clearance, 0px\) \+ var\(--country-exit-lift, 0px\)\)/.test(base),
        'the website keeps its 66px + dock clearance + country-pill lift anchor');
    assert(!/body:not\(\.is-pwa\)[^{]*#map3d-toggle-slot/.test(skinFlat),
        'no non-PWA rule touches the slot, so the website can never receive it');
    console.log('  ✓ website geometry untouched (bottom-centre, 66px + clearances)');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The 3D view: the switch survives, the rest of the column leaves
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(/body\.is-3d #detectlab-map \.leaflet-control-container,?[\s\S]{0,120}?\{ visibility: hidden; \}/.test(skin),
        'the 3D view still hides the Leaflet control container');
    assert(/body\.is-3d #detectlab-map \.leaflet-control-container #map3d-toggle-slot \{\s*visibility: visible;/.test(skin),
        'the slot is the one control that stays visible in 3D — it is the way back to 2D');
    assert(/body\.is-pwa\.is-3d #detectlab-map \.leaflet-bottom\.leaflet-left > \.leaflet-control \{\s*display: none;/.test(skin),
        'in 3D the hidden column leaves the layout, so the slot does not hover above an invisible stack');
    const lifted = ruleOf(skin, 'body.is-pwa.is-3d #map3d-toggle-slot');
    assert(/margin-bottom:\s*46px/.test(lifted),
        'the switch steps 46px up in 3D — 24px credit button + 10px margin + 8px gap + the pill’s own margin');
    assert(/108px/.test(ruleOf(skin, 'body.is-pwa.is-3d #map3d-bar')),
        'the 3D bar still starts at 108px, above the lifted switch (46 + 44 = 90)');
    console.log('  ✓ 3D: switch visible in the corner, clear of the credits and the bar');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. The viewer mounts it with structure, not offsets
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert(viewer.includes("toggleSlot.id = 'map3d-toggle-slot'"), 'the module creates the slot');
    assert(viewer.includes("toggleSlot.className = 'm3d-toggle-slot'"), 'with the skin’s class');
    assert(/document\.querySelector\('#detectlab-map \.leaflet-bottom\.leaflet-left'\)/.test(viewer),
        'the slot goes into Leaflet’s real bottom-left corner');
    assert(/var basemap = document\.getElementById\('arcgisBasemapCtrl'\)/.test(viewer) &&
           /host\.insertBefore\(toggleSlot, anchor \|\| host\.firstChild\)/.test(viewer),
        'it is inserted immediately BEFORE the base-layer control — one row above it, never between');
    assert(/if \(!pwaLayout\(\)\) return wrapper\(\);/.test(viewer),
        'the website path returns the map wrapper (bottom-centre)');
    assert(/function pwaLayout\(\)/.test(viewer) &&
           /classList\.contains\('is-pwa'\)/.test(viewer),
        'the PWA is detected from the is-pwa class the head script sets');
    assert(/root\.DetectLabMap3D = api/.test(viewer) &&
           /_mountToggle: mountToggleGroup/.test(viewer) &&
           /_toggleSlot: function \(\) \{ return toggleSlot; \}/.test(viewer),
        'the placement is exposed so this suite can drive it against a DOM');
    console.log('  ✓ viewer: PWA → column slot above #arcgisBasemapCtrl, website → wrapper');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. Real placement, driven through a DOM (no browser needed)
 * ══════════════════════════════════════════════════════════════════════════ */
function makeNode(id, className) {
    const el = {
        id: id || '',
        className: className || '',
        style: {},
        dataset: {},
        title: '',
        type: '',
        hidden: false,
        textContent: '',
        innerHTML: '',
        children: [],
        parentNode: null,
        classList: {
            _set: new Set(),
            add(name) { this._set.add(name); },
            remove(name) { this._set.delete(name); },
            toggle(name, on) {
                if (on === undefined) on = !this._set.has(name);
                if (on) this._set.add(name); else this._set.delete(name);
                return !!on;
            },
            contains(name) { return this._set.has(name); }
        },
        appendChild(child) {
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = el;
            el.children.push(child);
            return child;
        },
        insertBefore(child, reference) {
            if (child.parentNode) child.parentNode.removeChild(child);
            const index = reference ? el.children.indexOf(reference) : -1;
            child.parentNode = el;
            if (index < 0) el.children.push(child);
            else el.children.splice(index, 0, child);
            return child;
        },
        removeChild(child) {
            const index = el.children.indexOf(child);
            if (index >= 0) el.children.splice(index, 1);
            child.parentNode = null;
            return child;
        },
        contains(candidate) {
            let node = candidate;
            while (node) {
                if (node === el) return true;
                node = node.parentNode;
            }
            return false;
        },
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
        getAttribute() { return null; },
        querySelector() { return makeNode('stub'); },
        querySelectorAll() { return []; },
        focus() {}
    };
    Object.defineProperty(el, 'firstChild', {
        get() { return el.children[0] || null; }
    });
    Object.defineProperty(el, 'nextSibling', {
        get() {
            if (!el.parentNode) return null;
            const index = el.parentNode.children.indexOf(el);
            return index >= 0 ? (el.parentNode.children[index + 1] || null) : null;
        }
    });
    Object.defineProperty(el, 'nextElementSibling', {
        get() { return el.nextSibling; }
    });
    return el;
}

/* Boots the real viewer in a sandbox whose DOM is the smallest map that can
 * exist: .map-wrapper → #detectlab-map → .leaflet-control-container →
 * .leaflet-bottom.leaflet-left → [compass, #arcgisBasemapCtrl]. */
function bootMap(options) {
    const wrapper = makeNode('', 'map-wrapper');
    const mapEl = makeNode('detectlab-map', 'leaflet-container');
    wrapper.appendChild(mapEl);
    const corner = makeNode('', 'leaflet-bottom leaflet-left');
    mapEl.appendChild(corner);
    const compass = makeNode('', 'leaflet-control detectlab-compass');
    corner.appendChild(compass);
    const basemap = makeNode('arcgisBasemapCtrl', 'leaflet-control arcgis-basemap-ctrl');
    /* Leaflet's own ordering for a bottom corner: control.addTo() inserts every
     * new control at firstChild, so a control added later sits ABOVE the ones
     * already there (the compass is added first, the basemap switcher later). */
    if (options.basemapAtBoot) corner.insertBefore(basemap, corner.firstChild);

    const documentElement = makeNode('', '');
    if (options.pwa) documentElement.classList.add('is-pwa');
    const body = makeNode('', options.pwa && !options.pwaOnHtmlOnly ? 'is-pwa' : '');

    const documentStub = {
        readyState: 'complete',
        head: makeNode('', ''),
        body: body,
        documentElement: documentElement,
        createElement(tag) { return makeNode('', tag === 'canvas' ? '' : ''); },
        getElementById(id) {
            if (id === 'detectlab-map') return mapEl;
            if (id === 'arcgisBasemapCtrl') return basemap.parentNode ? basemap : null;
            return null;
        },
        querySelector(selector) {
            if (selector === '#detectlab-map .leaflet-bottom.leaflet-left') return corner;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {}
    };
    const windowStub = {
        document: documentStub,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        setInterval: function () { return 0; }, clearInterval: function () {},
        addEventListener() {}, removeEventListener() {},
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { onLine: true },
        console: console
    };
    windowStub.window = windowStub;
    const sandbox = {
        window: windowStub, document: documentStub, console: console,
        Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
        navigator: windowStub.navigator
    };
    vm.createContext(sandbox);
    vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
    vm.runInContext(mirrorSource, sandbox, { filename: 'js/map3d-mirror.js' });
    vm.runInContext(viewer, sandbox, { filename: 'js/map3d-terrain.js' });
    return {
        api: windowStub.DetectLabMap3D,
        wrapper: wrapper, mapEl: mapEl, corner: corner,
        compass: compass, basemap: basemap
    };
}

{
    /* ── the installed app: the switch joins the column ─────────────────── */
    const pwa = bootMap({ pwa: true, basemapAtBoot: true });
    const api = pwa.api;
    assert.strictEqual(api._pwaLayout(), true, 'the viewer sees the PWA layout');
    const slot = api._toggleSlot();
    assert(slot, 'the PWA boot created the switch slot');
    assert.strictEqual(slot.parentNode, pwa.corner, 'the slot lives in Leaflet’s bottom-left corner');
    assert.strictEqual(slot.nextElementSibling, pwa.basemap,
        'the slot sits immediately BEFORE the base-layer button — i.e. one row above it');
    assert.strictEqual(pwa.corner.children[0], slot,
        'it is the top row of the column (bottom corners stack firstChild at the top)');
    assert.strictEqual(pwa.corner.children[2], pwa.compass,
        'the compass column keeps the bottom of the stack');
    const group = pwa.corner.children[0].children[0];
    assert.strictEqual(group.id, 'map3d-toggle-group', 'the switch group is mounted inside the slot');
    assert(!pwa.wrapper.children.includes(group), 'the group is NOT left in the map wrapper');
    assert(pwa.corner.contains(pwa.compass),
        'the compass column is untouched below the base-layer button');

    /* A late control (Leaflet always inserts bottom controls at firstChild —
     * exactly what map-app.js does when it adds the basemap switcher) must
     * not push the switch under the base-layer button. */
    const late = makeNode('', 'leaflet-control some-new-control');
    pwa.corner.insertBefore(late, pwa.corner.firstChild);   /* Leaflet's own ordering */
    api._mountToggle();
    assert.strictEqual(slot.parentNode, pwa.corner, 'the slot stays in the corner');
    assert.strictEqual(slot.nextElementSibling, pwa.basemap,
        'a later bottom-left control cannot land between the switch and the base-layer button');
    assert.strictEqual(pwa.corner.children[1], slot,
        'the switch is still the row right above the base-layer button');

    /* The basemap control added AFTER the boot (the real order in map-app.js):
     * the slot is placed first, then the base-layer button arrives above it by
     * Leaflet's firstChild rule — the mount must restore the order. */
    const latePwa = bootMap({ pwa: true, basemapAtBoot: false });
    assert(latePwa.api._toggleSlot().parentNode, 'the slot is mounted before the basemap control exists');
    latePwa.corner.insertBefore(latePwa.basemap, latePwa.corner.firstChild);
    latePwa.api._mountToggle();
    assert.strictEqual(latePwa.api._toggleSlot().nextElementSibling, latePwa.basemap,
        'when the base-layer button is added later the switch moves above it, not below');
    console.log('  ✓ PWA DOM: slot in the corner, directly above #arcgisBasemapCtrl, late controls handled');
}

{
    /* ── the website: nothing moves ─────────────────────────────────────── */
    const web = bootMap({ pwa: false, basemapAtBoot: true });
    assert.strictEqual(web.api._pwaLayout(), false, 'a browser tab is not the PWA layout');
    assert.strictEqual(web.api._toggleSlot(), null, 'no slot is created on the website');
    const group = web.wrapper.children.find((node) => node.id === 'map3d-toggle-group');
    assert(group, 'the switch is mounted in the map wrapper, as before');
    assert(!web.corner.contains(group), 'the website switch never enters the Leaflet column');
    assert.strictEqual(web.api._toggleHost(), web.wrapper, 'toggleHost() returns the wrapper');
    console.log('  ✓ website DOM: switch stays in the wrapper (bottom-centre), no slot');
}

{
    /* The head script sets is-pwa on <html> before this module runs; the footer
     * script adds it to <body> later. Either one must be enough. */
    const htmlOnly = bootMap({ pwa: true, pwaOnHtmlOnly: true, basemapAtBoot: true });
    assert.strictEqual(htmlOnly.api._pwaLayout(), true,
        'is-pwa on <html> (the head script) is enough — the module boots before <body> is stamped');
    assert(htmlOnly.api._toggleSlot(), 'and the slot is mounted from that signal');
    console.log('  ✓ PWA detection works from <html> alone (boot order in index.html)');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. Wiring: the installed app must actually receive the new files
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const cssUrl = 'css/map3d-terrain.css?v=' + TAG;
    const jsUrl = 'js/map3d-terrain.js?v=' + TAG;
    assert(html.includes(cssUrl), 'index.html loads the re-tagged 3D skin');
    assert(html.includes(jsUrl), 'index.html loads the re-tagged viewer');
    assert(sw.includes("'" + cssUrl + "'"), 'sw.js pre-caches the re-tagged skin');
    assert(sw.includes("'" + jsUrl + "'"), 'sw.js pre-caches the re-tagged viewer');
    const version = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
    /* v254 shipped the same move for every layout; v255 narrows it to the
     * installed app and drops the measured offsets. This change must land
     * above both so an installed shell re-fetches the assets. */
    assert(version >= 255, 'the app-shell cache moved past v254 (found v' + version + ')');
    assert(/detectlab-v\d+-pwa-3d-above-basemap/.test(sw),
        'the cache name names this change, so an installed PWA re-fetches the shell');
    console.log('  ✓ index.html + sw.js ship the change to installed PWAs (v' + version + ')');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. Optional: the REAL Leaflet 1.9.4 corner, in jsdom
 * --------------------------------------------------------------------------
 * Section 3 drives a hand-written DOM stub. This section boots js/leaflet.js
 * and the real viewer in a jsdom window, builds the corner the way the app
 * does (the compass first, the base-layer control later — Leaflet inserts
 * every new bottom control at firstChild, so the basemap goes on top), and
 * checks the actual node order.
 *
 *   NODE_PATH=/path/to/node_modules node test-pwa-3d-above-basemap.js
 *   (npm i --no-save jsdom)
 * ══════════════════════════════════════════════════════════════════════════ */
{
    let JSDOM = null;
    try { JSDOM = require('jsdom').JSDOM; } catch (e) { JSDOM = null; }

    if (!JSDOM) {
        console.log('  ⏭  real-Leaflet check skipped (jsdom is not installed — npm i --no-save jsdom)');
    } else {
        const bootReal = (pwa) => {
            const dom = new JSDOM('<!doctype html><html><head></head><body>' +
                '<div class="map-wrapper"><div id="detectlab-map" style="width:800px;height:600px"></div></div>' +
                '</body></html>', {
                runScripts: 'outside-only',
                pretendToBeVisual: true,
                url: pwa ? 'https://detectlab.test/?pwa=1' : 'https://detectlab.test/'
            });
            const w = dom.window;
            w.eval(read('js/leaflet.js'));

            const map = w.L.map(w.document.getElementById('detectlab-map'), {
                center: [45, 25], zoom: 6, zoomControl: false, attributionControl: false
            });
            if (pwa) w.document.documentElement.classList.add('is-pwa');   /* the inline head script */
            w._dlMap = map;

            /* map-rotate.js adds the compass while the map is being built;
             * map-app.js adds the base-layer control later. Both bottomleft. */
            const compass = w.document.createElement('div');
            compass.className = 'leaflet-control detectlab-compass';
            const compassControl = w.L.control({ position: 'bottomleft' });
            compassControl.onAdd = () => compass;
            compassControl.addTo(map);

            const basemap = w.document.createElement('div');
            basemap.id = 'arcgisBasemapCtrl';
            basemap.className = 'leaflet-control arcgis-basemap-ctrl';
            const basemapControl = w.L.control({ position: 'bottomleft' });
            basemapControl.onAdd = () => basemap;
            basemapControl.addTo(map);

            w.eval(read('js/map3d-mirror.js'));
            w.eval(read('js/layer-registry.js'));
            vm.runInContext(viewer, dom.getInternalVMContext(), { filename: 'js/map3d-terrain.js' });

            return new Promise((resolve) => {
                /* jsdom fires DOMContentLoaded after construction, which is when
                 * the viewer's boot() runs. */
                w.setTimeout(() => resolve({ w, map, compass, basemap }), 50);
            });
        };

        const ids = (corner) => Array.from(corner.children).map((n) => n.id || n.className);

        bootReal(true).then(({ w, basemap }) => {
            const corner = w.document.querySelector('#detectlab-map .leaflet-bottom.leaflet-left');
            const slot = w.document.getElementById('map3d-toggle-slot');
            const group = w.document.getElementById('map3d-toggle-group');
            assert(slot, 'the real run creates the slot in Leaflet\'s corner');
            assert.strictEqual(group.parentNode, slot, 'the switch group is mounted inside the slot');
            const order = ids(corner);
            assert.deepStrictEqual(order,
                ['map3d-toggle-slot', 'arcgisBasemapCtrl', 'leaflet-control detectlab-compass'],
                'real Leaflet order: slot ▸ base layer ▸ compass');

            /* A control Leaflet adds AFTER boot lands on top of the column, not
             * between the switch and the base layer. */
            const late = w.document.createElement('div');
            late.className = 'leaflet-control late-control';
            const lateControl = w.L.control({ position: 'bottomleft' });
            lateControl.onAdd = () => late;
            lateControl.addTo(w._dlMap);
            w.DetectLabMap3D._mountToggle();
            assert.deepStrictEqual(ids(corner),
                ['leaflet-control late-control', 'map3d-toggle-slot', 'arcgisBasemapCtrl', 'leaflet-control detectlab-compass'],
                'a later control cannot wedge itself between the switch and the base layer');

            /* A re-created base-layer control (map rebuild / re-add) keeps the
             * switch directly above it. */
            corner.removeChild(basemap);
            const rebuilt = w.document.createElement('div');
            rebuilt.id = 'arcgisBasemapCtrl';
            rebuilt.className = 'leaflet-control';
            corner.insertBefore(rebuilt, corner.firstChild);
            w.DetectLabMap3D._mountToggle();
            const after = Array.from(corner.children);
            assert.strictEqual(after[after.indexOf(slot) + 1], rebuilt,
                'the re-created base-layer control is still immediately below the switch');
            console.log('  ✓ real Leaflet 1.9.4 + the real viewer: slot ▸ base layer ▸ compass');

            return bootReal(false);
        }).then(({ w }) => {
            const corner = w.document.querySelector('#detectlab-map .leaflet-bottom.leaflet-left');
            const group = w.document.getElementById('map3d-toggle-group');
            assert.strictEqual(w.DetectLabMap3D._toggleSlot(), null, 'the website creates no slot');
            assert(!corner.contains(group), 'the website switch stays out of the Leaflet column');
            assert.strictEqual(group.parentNode, w.document.querySelector('.map-wrapper'),
                'the website switch stays in the wrapper (bottom-centre)');
            console.log('  ✓ real Leaflet on the website: no slot, switch stays bottom-centre');
            console.log('\n✅ test-pwa-3d-above-basemap.js passed all checks successfully.');
        }).catch((err) => {
            console.error(err);
            process.exit(1);
        });
    }
}

