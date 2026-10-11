// Test suite for the country-scoped layer window and the visible country
// bounds. Once a country is selected:
//   1. the layer panel keeps ONLY the layers attributed to that country
//      (rows get .country-layer-unavailable and are hidden while
//      #transpPanel keeps .country-filter-active — e.g. Italy must not offer
//      Denmark's LiDAR, nor France's / Switzerland's, whose boxes merely
//      graze Italy's bbox; Denmark must not see Sweden's / Poland's rows).
//      Neighbouring countries' rows that are merely visible in the locked
//      viewport never leak in. A group row hides too when none of its
//      sublayers survives;
//   2. the ArcGIS SceneView atlas sends a single selected country's ISO code
//      and bbox to the parent app, which filters/zooms the alternate Leaflet map.
// Covers map-app.js country filtering, atlas-shell.js messaging, atlas selection,
// css/styles.css and the service-worker shell.
// No network, account or npm dependencies.
// Usage: node test-country-layer-filter.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Country-scoped layers + ArcGIS atlas hand-off...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const source = read('js/map-app.js');
const html = read('index.html');
const css = read('css/styles.css');
const sw = read('sw.js');

const UNAVAILABLE = 'country-layer-unavailable';
const FILTER_ACTIVE = 'country-filter-active';

// Hand-off bboxes exactly as the gate stores them ([west, south, east, north]).
const IT_BBOX = [6.62, 35.49, 18.52, 47.09];   // Italy
const DK_BBOX = [8.08, 54.56, 15.19, 57.75];   // Denmark proper
const CA_BBOX = [-141.0, 41.0, -52.0, 83.0];    // Canada (group availability fallback)

/* ══════════════════════════════════════════════════════════════
   1. Static wiring: the hiding CSS, versioned assets, precache
   ══════════════════════════════════════════════════════════════ */
assert(/#transpPanel\.country-filter-active \.country-layer-unavailable\s*\{\s*display:\s*none\s*!important/.test(css),
    'styles.css hides rows marked country-layer-unavailable while the filter is active');
assert(html.includes('css/styles.css?v=20261011-arcgis-primary'), 'index.html loads the ArcGIS-primary styles.css');
assert(html.includes('js/map-app.js?v=20261011-2d-basemap'), 'index.html loads the alternate 2D map module');
assert(html.includes('js/historical-eu-maps.js?v=20261008-country-layers-strict'), 'index.html loads the country-attribution catalog');
assert(html.includes('europe-roman-atlas.html?embed=1'), 'index.html embeds the ArcGIS atlas');
assert(html.includes('js/atlas-shell.js?v=20261011-arcgis-primary'), 'index.html loads the atlas-to-Leaflet bridge');
['css/styles.css?v=20261011-arcgis-primary',
 'js/map-app.js?v=20261011-2d-basemap',
 'js/historical-eu-maps.js?v=20261008-country-layers-strict',
 'js/atlas-shell.js?v=20261011-arcgis-primary',
 'js/europe-roman-atlas.js?v=20261011-arcgis-primary'].forEach(function (p) {
    assert(sw.includes("'" + p + "'"), 'sw.js precaches ' + p);
});
const shellVersion = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 183, 'sw.js cache is v183 or newer (got v' + shellVersion + ')');
console.log('  ✓ ArcGIS atlas wiring, country-attribution assets and sw.js v' + shellVersion + ' precache verified');

/* ══════════════════════════════════════════════════════════════
   2. Sandbox for the map-app.js layer-filter section
      (same extraction as test-layer-visibility.js: the production
      code runs against the real index.html panel structure)
   ══════════════════════════════════════════════════════════════ */
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert(from >= 0 && to > from, 'production section must exist: ' + start);
    return source.slice(from, to);
}

const coverageConfig = section('var premiumMapCoverageBounds = {', '// Create coverage polygons');
const visibilityCode = section('// ── LAYER VISIBILITY HIGHLIGHT', '// ── BUCOVINA 1861-1864 (XYZ tiles');

function normPt(p) { return Array.isArray(p) ? { lat: p[0], lng: p[1] } : p; }
// Leaflet-compatible bounds accepting both L.latLngBounds([[s,w],[n,e]]) and
// the L.latLngBounds([s,w],[n,e]) form the country-bbox fallback uses.
function latLngBounds(a, b) {
    if (a && typeof a.intersects === 'function') return a;
    const pts = (b === undefined) ? a : [a, b];
    const p1 = normPt(pts[0]), p2 = normPt(pts[1]);
    const south = Math.min(p1.lat, p2.lat), west = Math.min(p1.lng, p2.lng);
    const north = Math.max(p1.lat, p2.lat), east = Math.max(p1.lng, p2.lng);
    return {
        south, west, north, east,
        intersects(other) {
            return other.north >= south && other.south <= north &&
                other.east >= west && other.west <= east;
        }
    };
}

class MapMock {
    constructor(points) { this.bounds = latLngBounds(points); this.listeners = {}; }
    getBounds() { return this.bounds; }
    on(types, cb) { types.split(' ').forEach(t => (this.listeners[t] = this.listeners[t] || new Set()).add(cb)); }
    off(types, cb) { types.split(' ').forEach(t => this.listeners[t] && this.listeners[t].delete(cb)); }
}

class ElementMock extends EventTarget {
    constructor(tag, attrs, parent) {
        super();
        this.tagName = tag;
        this.id = attrs.id || '';
        this.parentElement = parent;
        this.style = {};
        this.dataset = { category: attrs['data-category'], tab: attrs['data-tab'] };
        const classes = new Set((attrs.class || '').split(/\s+/));
        this.classList = {
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            contains: name => classes.has(name),
            toggle(name, on = !classes.has(name)) {
                if (on) classes.add(name); else classes.delete(name);
                return on;
            }
        };
        // Deliberately NO Element.contains(): the production group check must
        // survive on the parentElement walk alone.
    }
    closest(selector) {
        for (let el = this; el; el = el.parentElement) {
            if (selector.startsWith('.') && el.classList.contains(selector.slice(1))) return el;
        }
        return null;
    }
    setAttribute(k, v) { this[k] = v; (this.attrs = this.attrs || {})[k] = String(v); }
    getAttribute(k) { return this.attrs && Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
}

// Parse the real index.html markup into the mock tree (scripts/styles out).
function makeDocument() {
    const document = new EventTarget();
    document.ids = new Map();
    document.elements = [];
    document.hidden = false;
    const stack = [];
    const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    const markup = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const tags = /<(\/?)([\w-]+)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
    for (const match of markup.matchAll(tags)) {
        const [, closing, tag, rawAttrs] = match;
        if (closing) {
            const index = stack.map(el => el.tagName).lastIndexOf(tag);
            if (index >= 0) stack.length = index;
            continue;
        }
        const attrs = {};
        for (const attr of rawAttrs.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attrs[attr[1]] = attr[2] ?? attr[3];
        }
        const el = new ElementMock(tag, attrs, stack.at(-1) || null);
        document.elements.push(el);
        if (el.id && !document.ids.has(el.id)) document.ids.set(el.id, el);
        if (tag === 'body') document.body = el;
        if (!voidTags.has(tag) && !rawAttrs.endsWith('/')) stack.push(el);
    }
    document.getElementById = id => document.ids.get(id) || null;
    return document;
}

function setupPanel() {
    const document = makeDocument();
    const window = new EventTarget();
    // The country gate ships on the .eu site: model the European market so
    // market-dependent bounds (the Roman Empire box) resolve like production.
    window.DetectLabSite = { isEurope: true };
    const catalogSpecs = [
        // Curated coverage subset of js/historical-eu-maps.js COUNTRIES_DATA:
        // WIG 300k is a Polish sheet (it grazes Denmark's bbox but has ZERO
        // data for Denmark), Gaul is a Poznań-area sheet.
        { id: 'wig300k', bounds: [14.33, 49.00, 27.50, 55.80], curated: ['PL', 'DE', 'UA', 'BY', 'LT', 'CZ', 'SK', 'RU'] },
        { id: 'gaul', bounds: [15.12, 51.49, 17.36, 52.99], curated: ['PL', 'DE', 'RU'] },
        // Fixture to exercise the parent's hasAvailableMaps() fallback when a
        // dynamic catalog row is the only available Historical Maps sublayer.
        // It has no curated coverage (country outside the analysis) and relies
        // on the extent fallback.
        { id: 'fixture', bounds: [-130.0, 40.0, -50.0, 80.0], curated: null }
    ];
    // The analyzed set (COUNTRIES_DATA entries; BE-LU = BE + LU).
    const analyzedIso = new Set(['PL', 'DE', 'UA', 'BY', 'LT', 'LV', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO', 'FR', 'BE', 'LU', 'NL', 'DK', 'EE', 'CH']);
    const catalogContainer = document.getElementById('histEuMapsSection');
    const catalogRows = catalogSpecs.map(spec => {
        const row = new ElementMock('div', { id: 'cenagisMapRow_' + spec.id, class: 'cenagis-map-row' }, catalogContainer);
        row.getAttribute = key => key === 'data-map-id' ? spec.id : null;
        document.elements.push(row);
        document.ids.set(row.id, row);
        return { spec, row };
    });
    let availableCatalogCount = 0;
    // Mirrors production js/historical-eu-maps.js filterForCountry: curated
    // coverage lists decide membership for analyzed countries; a country
    // outside the analysis falls back to the sheet extents.
    window.DetectLabEuMaps = {
        filterForCountry(code, bounds) {
            const bbox = Array.isArray(bounds) ? bounds : null;
            const iso = code && String(code).toUpperCase() !== 'ALL' ? String(code).toUpperCase() : null;
            availableCatalogCount = 0;
            catalogRows.forEach(({ spec, row }) => {
                let available = true;
                if (iso) {
                    if (analyzedIso.has(iso)) {
                        available = !!spec.curated && spec.curated.includes(iso);
                    } else {
                        const b = spec.bounds;
                        available = !!bbox &&
                            (b[2] >= bbox[0] && b[0] <= bbox[2] && b[3] >= bbox[1] && b[1] <= bbox[3]);
                    }
                }
                row.classList.toggle(UNAVAILABLE, !available);
                row.setAttribute('aria-hidden', available ? 'false' : 'true');
                if (available) availableCatalogCount++;
            });
        },
        hasAvailableMaps() { return availableCatalogCount > 0; },
        toggleHistEuLayer() {}
    };
    const frames = [];
    const context = vm.createContext({
        window, document,
        map: new MapMock([[20, -20], [21, -19]]),   // viewport far from any coverage
        L: { latLngBounds },
        setInterval: () => 0,
        setTimeout: cb => { frames.push(cb); return frames.length; },
        clearTimeout: () => {}
    });
    vm.runInContext(source.match(/var ROMANIA_BOUNDS = [^;]+;/)[0], context);
    vm.runInContext(source.match(/var APM_BOUNDS = [^;]+;/)[0], context);
    vm.runInContext(coverageConfig + visibilityCode, context);
    vm.runInContext(section('function measureSubLayersHeight', '(function initMap()'), context);
    return { window, document, context, catalogRows };
}

function unavailable(document, id) {
    const el = document.getElementById(id);
    assert(el, '#' + id + ' exists in index.html');
    return el.classList.contains(UNAVAILABLE);
}
// Same walk as getDirectChildRowByElement in map-app.js: the row that gets
// the class is the direct child of the sublayer container, not the slider.
function rowOfSlider(document, sliderId, containerId) {
    let cur = document.getElementById(sliderId);
    assert(cur, '#' + sliderId + ' exists in index.html');
    const container = document.getElementById(containerId);
    assert(container, '#' + containerId + ' exists in index.html');
    while (cur && cur.parentElement) {
        if (cur.parentElement === container || cur.parentElement.id === containerId) return cur;
        cur = cur.parentElement;
        if (cur === container) break;
    }
    assert.fail('no row for #' + sliderId + ' inside #' + containerId);
}
function rowOfToggle(document, toggleId) {
    const el = document.getElementById(toggleId);
    assert(el, '#' + toggleId + ' exists in index.html');
    const row = el.closest('.transp-layer-row');
    assert(row, '#' + toggleId + ' sits in a .transp-layer-row');
    return row;
}
function groupRowOf(document, iconId) {
    const row = document.getElementById(iconId).closest('.transp-layer-row');
    assert(row, iconId + ' lives in a .transp-layer-row');
    return row;
}

/* ══════════════════════════════════════════════════════════════
   3. Italy selected: only layers attributed to Italy remain
   ══════════════════════════════════════════════════════════════ */
{
    const { window, document } = setupPanel();
    assert(typeof window.filterLayersForCountry === 'function', 'filterLayersForCountry exported');
    assert(typeof window.unfilterLayersForCountry === 'function', 'unfilterLayersForCountry exported');

    // The globe gate's hand-off: a fake country layer exposing the bbox.
    window._detectlabCountryLayer = {
        eachLayer(cb) {
            cb({
                feature: { properties: { ISO_A2: 'IT' } },
                getBounds() { return latLngBounds([[IT_BBOX[1], IT_BBOX[0]], [IT_BBOX[3], IT_BBOX[2]]]); }
            });
        }
    };
    window.filterLayersForCountry('IT');

    // National services of other countries must NEVER leak in — not even the
    // neighbours visible at the edges of the locked viewport whose published
    // boxes graze Italy's bbox (France's MNT, Switzerland's relief).
    assert.equal(unavailable(document, 'lidarDkLidarRow'), true, 'Denmark LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarSeLidarRow'), true, 'Sweden LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarNoLidarRow'), true, 'Norway LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarUkLidarRow'), true, 'UK LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarPlLidarRow'), true, 'Poland LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarNlAhnRow'), true, 'Netherlands LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarEsLidarRow'), true, 'Spain LiDAR hidden for Italy');
    assert.equal(unavailable(document, 'lidarFrLidarRow'), true, 'France LiDAR hidden for Italy — the box grazes Italy but carries no Italian data');
    assert.equal(unavailable(document, 'lidarChLidarRow'), true, 'Switzerland LiDAR hidden for Italy — the box grazes Italy but carries no Italian data');
    // The Romanian county catalogue is not Italian either.
    assert.equal(rowOfSlider(document, 'lidarHdOpacitySlider', 'lidarSubLayers').classList.contains(UNAVAILABLE),
        true, 'HD county row hidden for Italy');
    // No national LiDAR service is attributed to Italy → the group goes too.
    assert.equal(groupRowOf(document, 'lidarExpandIcon').classList.contains(UNAVAILABLE), true,
        'LiDAR group hidden for Italy (no Italian national service in the catalogue)');
    // ...and the Romania-only free historical group disappears entirely.
    assert.equal(groupRowOf(document, 'histExpandIcon').classList.contains(UNAVAILABLE), true, 'historical group hidden for Italy');
    // Premium historical maps: the Central-European series (Mitteleuropa,
    // Reymann, KDR…) substantially cover the Alps even though the curated
    // analysis never computed Italy → group stays, Romania-only sheets go.
    assert.equal(groupRowOf(document, 'histPremiumExpandIcon').classList.contains(UNAVAILABLE), false,
        'premium historical group kept for Italy (Central-European sheets cover the Alps)');
    assert.equal(unavailable(document, 'mitteleuropaRow'), false, 'Mitteleuropa kept for Italy');
    assert.equal(unavailable(document, 'reymannRow'), false, 'Reymann kept for Italy');
    assert.equal(unavailable(document, 'kdr100kRow'), false, 'KDR 100k kept for Italy');
    assert.equal(unavailable(document, 'chrzanowskiRow'), true, 'Chrzanowski (Old Poland) hidden for Italy — bbox graze is not coverage');
    assert.equal(unavailable(document, 'bucovinaRow'), true, 'Bucovina sheet hidden for Italy');
    assert.equal(groupRowOf(document, 'vegfpExpandIcon').classList.contains(UNAVAILABLE), true, 'vegetation group hidden for Italy');
    // The Roman Empire coverage box spans Italy → the Roman group stays.
    assert.equal(groupRowOf(document, 'romanExpandIcon').classList.contains(UNAVAILABLE), false, 'Roman group kept for Italy');
    // EU-wide layers keep working anywhere in Europe.
    assert.equal(unavailable(document, 'satellite60sRow'), false, 'Europe-wide satellite layer kept for Italy');
    // European catalog rows are nested in the single premium group and are
    // independently hidden when they are not maps of Italy.
    assert.equal(document.getElementById('histEuRow'), null, 'separate European Historical Maps group removed');
    assert.equal(unavailable(document, 'cenagisMapRow_wig300k'), true, 'WIG 300k catalog row hidden for Italy');
    assert.equal(unavailable(document, 'babelScroll'), true, 'Romania-only premium layer hidden for Italy');
    assert.equal(rowOfToggle(document, 'apmToggle').classList.contains(UNAVAILABLE), true, 'APM row hidden for Italy');
    // Panel carries the filter class and hidden rows are aria-hidden.
    assert(document.getElementById('transpPanel').classList.contains(FILTER_ACTIVE), 'panel marked country-filter-active');
    assert.equal(document.getElementById('lidarDkLidarRow').getAttribute('aria-hidden'), 'true', 'hidden rows are aria-hidden');

    // Italy's real bounds come back with the exit: everything selectable again.
    window.unfilterLayersForCountry();
    assert.equal(unavailable(document, 'lidarDkLidarRow'), false, 'Denmark LiDAR restored');
    assert.equal(unavailable(document, 'lidarFrLidarRow'), false, 'France LiDAR restored');
    assert.equal(unavailable(document, 'babelScroll'), false, 'Romania-only rows restored');
    ['lidarExpandIcon', 'histExpandIcon', 'histPremiumExpandIcon', 'vegfpExpandIcon', 'romanExpandIcon'].forEach(function (icon) {
        assert.equal(groupRowOf(document, icon).classList.contains(UNAVAILABLE), false, icon + ' group restored');
    });
    assert.equal(document.getElementById('transpPanel').classList.contains(FILTER_ACTIVE), false, 'filter class removed');
    console.log('  ✓ Italy: every foreign national LiDAR row hidden (incl. France/Switzerland), empty groups hidden, exit restores all');
}

/* ══════════════════════════════════════════════════════════════
   4. Denmark selected via the stored-bbox fallback
      (no _detectlabCountryLayer — filter must use the bbox)
   ══════════════════════════════════════════════════════════════ */
{
    const { window, document } = setupPanel();
    window._detectlabCountryLayer = null;
    window._detectlabCountryBounds = DK_BBOX;
    window.filterLayersForCountry('DK');

    assert.equal(unavailable(document, 'lidarDkLidarRow'), false, 'Denmark LiDAR available for Denmark');
    // The neighbours visible around Denmark's bbox must not leak in: Sweden's
    // and Poland's boxes clip the Danish bbox but their services have ZERO
    // data for Denmark.
    assert.equal(unavailable(document, 'lidarSeLidarRow'), true, 'Sweden LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarPlLidarRow'), true, 'Poland LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarNlAhnRow'), true, 'Netherlands LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarEsLidarRow'), true, 'Spain LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarFrLidarRow'), true, 'France LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarUkLidarRow'), true, 'UK LiDAR hidden for Denmark');
    assert.equal(unavailable(document, 'lidarNoLidarRow'), true, 'Norway LiDAR hidden for Denmark');
    assert.equal(groupRowOf(document, 'lidarExpandIcon').classList.contains(UNAVAILABLE), false, 'LiDAR group kept for Denmark');
    assert.equal(groupRowOf(document, 'histExpandIcon').classList.contains(UNAVAILABLE), true, 'Romania historical group hidden for Denmark');
    assert.equal(groupRowOf(document, 'romanExpandIcon').classList.contains(UNAVAILABLE), false, 'Roman group kept for Denmark');
    assert.equal(groupRowOf(document, 'vegfpExpandIcon').classList.contains(UNAVAILABLE), true, 'vegetation group hidden for Denmark');
    // Premium historical sheets follow the curated CENAGIS coverage: sheets
    // that really reach Denmark's territory stay, Polish-only sheets go.
    assert.equal(groupRowOf(document, 'histPremiumExpandIcon').classList.contains(UNAVAILABLE), false,
        'premium historical group kept for Denmark (curated sheets cover its territory)');
    assert.equal(unavailable(document, 'josephineRow'), true, 'Josephine sheet hidden for Denmark');
    assert.equal(unavailable(document, 'wig100kRow'), true, 'WIG 100k (Polish sheet) hidden for Denmark');
    assert.equal(unavailable(document, 'mitteleuropaRow'), false, 'Mitteleuropa kept for Denmark (curated coverage)');
    assert.equal(unavailable(document, 'chrzanowskiRow'), false, 'Chrzanowski kept for Denmark (curated coverage)');
    assert.equal(unavailable(document, 'reymannRow'), false, 'Reymann kept for Denmark (curated coverage)');
    assert.equal(unavailable(document, 'kdr100kRow'), false, 'KDR 100k kept for Denmark (curated coverage)');
    assert.equal(unavailable(document, 'kdrGbRow'), true, 'KDR Großblatt hidden for Denmark (not in the curated list)');
    assert.equal(unavailable(document, 'galicia1855Row'), true, 'Galicia 1855 hidden for Denmark');
    assert.equal(document.getElementById('histEuRow'), null, 'separate European Historical Maps group removed');
    assert.equal(unavailable(document, 'cenagisMapRow_wig300k'), true,
        'WIG 300k catalog row hidden for Denmark — the bbox graze is not coverage');
    assert.equal(unavailable(document, 'cenagisMapRow_gaul'), true, 'Gaul catalog row hidden for Denmark');
    assert(document.getElementById('transpPanel').classList.contains(FILTER_ACTIVE), 'panel marked country-filter-active');
    console.log('  ✓ Denmark (bbox fallback): own + curated sheets kept, grazing neighbours hidden');
}

/* ══════════════════════════════════════════════════════════════
   5. A matching dynamic European map keeps the single group available
      even when no legacy premium sheet covers the selected country
   ══════════════════════════════════════════════════════════════ */
{
    const { window, document } = setupPanel();
    window._detectlabCountryLayer = null;
    window._detectlabCountryBounds = CA_BBOX;
    window.filterLayersForCountry('CA');

    assert.equal(unavailable(document, 'cenagisMapRow_fixture'), false, 'matching dynamic catalog sheet available for Canada fixture');
    assert.equal(unavailable(document, 'mitteleuropaRow'), true, 'Central-European premium sheets stay hidden for Canada');
    assert.equal(groupRowOf(document, 'histPremiumExpandIcon').classList.contains(UNAVAILABLE), false,
        'single premium historical group stays visible for a matching dynamic catalog sheet');
    window.unfilterLayersForCountry();
    assert.equal(unavailable(document, 'cenagisMapRow_fixture'), false, 'dynamic catalog row restored on exit');
    console.log('  ✓ dynamic CENAGIS catalog participates in country filtering and keeps the single parent group available');
}

/* ══════════════════════════════════════════════════════════════
   6. ArcGIS country selections cross the embedded view boundary
   ══════════════════════════════════════════════════════════════ */
{
    const atlas = read('js/europe-roman-atlas.js');
    const shell = read('js/atlas-shell.js');
    assert(atlas.includes('boundsOfPolygons(candidates)'), 'ArcGIS country geometry carries a transferable bbox');
    assert(atlas.includes("type: 'detectlab-atlas-country-selected'"), 'the SceneView posts country-selection state');
    assert(atlas.includes('selectionCount: selected.size'), 'multi-select state is included in the message');
    assert(shell.includes("data.type !== 'detectlab-atlas-country-selected'"), 'the parent validates the atlas message type');
    assert(shell.includes("new CustomEvent('detectlab:country-selected'"), 'the parent emits the app country event');
    assert(shell.includes('window.filterLayersForCountry(iso)'), 'a single selected country filters the Leaflet layer list');
    assert(shell.includes('window.unfilterLayersForCountry()'), 'zero/multiple selections restore the full Leaflet layer list');
    assert(shell.includes('map.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]'), 'the legacy map receives the selected-country extent');
    console.log('  ✓ country ISO/bbox and single-vs-multiple selection are bridged to the legacy map');
}

console.log('\nAll country layer-filter + ArcGIS hand-off tests passed ✔');
