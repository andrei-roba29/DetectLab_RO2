// Test suite for the European historical-map catalog inside the single
// Premium Historical Maps group and its country-overlap filtering.
// Usage: node test-historical-eu-maps.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] European historical-map catalog + country overlap...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const indexHtml = read('index.html');
const swJs = read('sw.js');
const source = read('js/historical-eu-maps.js');
const subscriptions = read('js/subscriptions.js');

// The catalog is nested in the original premium Historical Maps accordion;
// the obsolete second top-level European group must stay gone.
const parentStart = indexHtml.indexOf('id="histPremiumSubLayers"');
const parentEnd = indexHtml.indexOf('<!-- /histPremiumSubLayers -->', parentStart);
assert(parentStart >= 0 && parentEnd > parentStart, 'single premium Historical Maps accordion exists');
const parentMarkup = indexHtml.slice(parentStart, parentEnd);
assert(parentMarkup.includes('id="histEuMapsSection"'), 'CENAGIS catalog is inside histPremiumSubLayers');
// The sheets are a flat part of the Historical Maps group: the old
// “European maps · CENAGIS / IH PAN” subcategory heading is gone for good and
// no replacement heading may come back above the list.
assert(!indexHtml.includes('cenagis-catalog-title'), 'index.html ships no CENAGIS subcategory heading');
assert(!source.includes('cenagis-catalog-title'), 'the catalog renderer builds no CENAGIS subcategory heading');
['histEuRow', 'histEuSubLayers', 'histEuToggle', 'histEuExpandBtn'].forEach(id => {
    assert(!indexHtml.includes('id="' + id + '"'), 'obsolete separate group #' + id + ' is removed');
});
assert(indexHtml.includes('js/historical-eu-maps.js?v=20261013-flat-hist-maps'), 'versioned catalog is loaded');
assert(indexHtml.includes('js/map-app.js?v=20261015-roman-roads'), 'versioned fallback map app is loaded');
assert(indexHtml.includes('js/subscriptions.js?v=20261008-premium-roman-guard'), 'premium guard is versioned');
assert(subscriptions.includes('toggleCenagisLayer'), 'dynamic CENAGIS toggle is Premium-guarded');
assert(subscriptions.includes("'toggleRomanDareCategories'"), 'DARE All/None is Premium-guarded');
assert(subscriptions.includes("'toggleRomanSub'"), 'Roman sublayers are Premium-guarded');
console.log('  ✓ one premium parent group, versioned scripts and entitlement guards verified');

assert(swJs.includes('js/historical-eu-maps.js?v=20261013-flat-hist-maps'), 'service worker precaches the versioned catalog');
assert(swJs.includes('js/map-app.js?v=20261015-roman-roads'), 'service worker precaches the current versioned map app');
assert(swJs.includes('js/subscriptions.js?v=20261008-premium-roman-guard'), 'service worker precaches the versioned subscription guard');
const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 171, 'service-worker cache bumped for the merged catalog (got v' + shellVersion + ')');
console.log('  ✓ service-worker precache and cache version v' + shellVersion + ' verified');

function makeClassList() {
    const values = new Set();
    return {
        add(name) { values.add(name); },
        remove(name) { values.delete(name); },
        contains(name) { return values.has(name); },
        toggle(name, force) {
            const on = force === undefined ? !values.has(name) : !!force;
            if (on) values.add(name); else values.delete(name);
            return on;
        }
    };
}
function makeRow(mapId) {
    const attrs = { 'data-map-id': mapId };
    return {
        classList: makeClassList(),
        style: {},
        attrs,
        getAttribute(name) { return attrs[name] || null; },
        setAttribute(name, value) { attrs[name] = String(value); }
    };
}

const rows = ['wig300k', 'wig500k_1947', 'gaul', 'kdr', 'reymann'].map(makeRow);
const section = {
    classList: makeClassList(),
    attrs: {},
    innerHTML: '',
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] || null; }
};
const status = { textContent: '' };
const noMaps = { style: { display: 'none' } };
const listeners = {};
const document = {
    readyState: 'loading',
    documentElement: { lang: 'en' },
    addEventListener(type, callback) { listeners[type] = callback; },
    getElementById(id) {
        if (id === 'histEuMapsSection') return section;
        if (id === 'histEuFilterStatus') return status;
        if (id === 'cenagisNoMaps') return noMaps;
        return null;
    },
    querySelectorAll(selector) {
        return selector === '.cenagis-map-row' ? rows : [];
    }
};
const mockWindow = {
    localStorage: { getItem: () => 'en' },
    document,
    L: {
        CRS: { EPSG3857: {} },
        tileLayer: { wms: () => ({ setOpacity() {}, addTo() {} }) }
    }
};
/* The catalogue itself now lives in js/layer-registry.js (shared with the 3D
 * terrain view and the tile proxy), so the sandbox loads it first — the same
 * order index.html uses. */
const registrySource = read('js/layer-registry.js');
const sandbox = { window: mockWindow, document, L: mockWindow.L, console, alert() {} };
vm.createContext(sandbox);
vm.runInContext(registrySource, sandbox);
assert(mockWindow.DetectLabLayers && typeof mockWindow.DetectLabLayers.cenagisCatalog === 'function',
    'the shared layer registry is loaded before the CENAGIS catalogue');
assert(Object.keys(mockWindow.DetectLabLayers.cenagisCatalog()).length === 45,
    'the registry still carries all 45 CENAGIS sheets');
vm.runInContext(source, sandbox);
const api = mockWindow.DetectLabEuMaps;
assert(api, 'DetectLabEuMaps API is exported');

// Rendered output: every non-shared sheet appears as a plain row, directly in
// the Historical Maps group — no subcategory block, no heading, no separator.
api.renderUi();
const rendered = section.innerHTML;
assert(rendered.indexOf('histEuFilterStatus') !== -1, 'the country-filter hint still renders above the rows');
assert(rendered.indexOf('cenagis-catalog-title') === -1, 'no subcategory heading is rendered');
assert(rendered.indexOf('CENAGIS / IH PAN') === -1, 'the heading text is not part of the rendered list');
assert(rendered.indexOf('<div class="cenagis-map-row') === 0 ||
       rendered.indexOf('<div class="cenagis-map-row') < rendered.indexOf('cenagis-map-list'),
    'the rows render flat at the start of the container (no heading block before them)');
const flatRows = (rendered.match(/class="cenagis-map-row hist-eu-map-row"/g) || []).length;
const expectedRows = Object.keys(api.catalog).filter(id => !api.sharedPremiumMapKeys[id]).length;
assert.strictEqual(flatRows, expectedRows,
    'each non-shared catalog sheet renders exactly once as a flat row (' + flatRows + '/' + expectedRows + ')');
console.log('  ✓ sheets render flat in the Historical Maps group, with no subcategory heading');

// Catalog and duplicate behavior: maps already offered by legacy premium rows
// stay in that part of the same parent and are not repeated in the CENAGIS list.
const catalog = api.catalog;
assert(Object.keys(catalog).length >= 40, 'catalog contains regional/national maps and city plans');
['wig300k', 'wig500k_1947', 'gaul', 'm25k', 'ahp_ziemie_polskie'].forEach(id => {
    assert(catalog[id], 'catalog contains ' + id);
});
['ukvme', 'chrzanowski', 'reymann', 'kdr', 'kdr_gb', 'wig100k', 'kummersberg'].forEach(id => {
    assert(api.sharedPremiumMapKeys[id], id + ' is marked as already present in the legacy premium list');
});
const italyOverlap = api.getMapsOverlappingBounds([6.62, 35.49, 18.52, 47.09], true);
assert(italyOverlap.includes('reymann'), 'partial bounds overlap is recognized at the north of Italy');
assert(!api.getMapsOverlappingBounds([6.62, 35.49, 18.52, 47.09], false).includes('reymann'),
    'a shared legacy map is not duplicated in the dynamic catalog');
console.log('  ✓ catalog metadata, partial-overlap logic and legacy de-duplication verified');

// The dynamic section shows ONLY sheets attributed to the selected country:
// the curated coverage lists (COUNTRIES_DATA) decide membership. Rectangle
// overlap is not enough — a Polish WIG sheet whose box clips Denmark's bbox
// is NOT a map of Denmark and must not leak into the window.
const denmark = [8.08, 54.56, 15.19, 57.75];
const byId = Object.fromEntries(rows.map(row => [row.getAttribute('data-map-id'), row]));
const availableCount = api.filterForCountry('DK', denmark);
assert.strictEqual(availableCount, 0,
    'Denmark gets only its curated sheets — and those are all premium-hosted (shared) rows');
assert.strictEqual(byId.wig300k.classList.contains('country-layer-unavailable'), true,
    'WIG 300k (a Polish sheet whose box clips Denmark) is hidden for Denmark');
assert.strictEqual(byId.wig500k_1947.classList.contains('country-layer-unavailable'), true,
    'WIG 500k is hidden for Denmark despite the bbox graze');
assert.strictEqual(byId.gaul.classList.contains('country-layer-unavailable'), true, 'non-covering Gaul sheet is hidden');
assert.strictEqual(byId.kdr.classList.contains('country-layer-unavailable'), true, 'shared KDR sheet is not duplicated in the catalog');
assert.strictEqual(byId.reymann.classList.contains('country-layer-unavailable'), true, 'shared Reymann sheet is not duplicated in the catalog');
assert.strictEqual(api.hasAvailableMaps(), false, 'no dynamic rows available for Denmark');
assert.strictEqual(noMaps.style.display, 'block', 'empty catalog message appears when only premium-hosted sheets cover the country');
assert(status.textContent.includes('Denmark'), 'status announces the matching country');

// Curated coverage beats overlap in the other direction too: Poland's own
// sheets come back from the ISO list alone, with no geometry at all.
assert.strictEqual(api.filterForCountry('PL', null), 3,
    'Poland gets its curated non-shared sheets (WIG 300k, WIG 500k, Gaul) without any bounds');
assert.strictEqual(byId.wig300k.classList.contains('country-layer-unavailable'), false,
    'WIG 300k is a curated Polish sheet');
assert.strictEqual(noMaps.style.display, 'none', 'empty message hidden once curated sheets are listed');

// A country outside the curated analysis falls back to the sheets' extents,
// and only substantial coverage counts.
assert.strictEqual(api.filterForCountry('IT', [6.62, 35.49, 18.52, 47.09]), 0,
    'no Polish catalog sheet substantially covers Italy');
assert.strictEqual(api.filterForCountry('CA', [-141.0, 41.0, -52.0, 83.0]), 0,
    'no catalog sheet covers Canada either');

api.filterForCountry(null, null);
assert(rows.every(row => !row.classList.contains('country-layer-unavailable')), 'clearing country filter restores all catalog rows');
assert.strictEqual(api.hasAvailableMaps(), true, 'unfiltered catalog remains available');
console.log('  ✓ curated country lists gate the catalog; bbox grazes and non-covering sheets stay hidden');

// Curated coverage remains available as a fallback when no country polygon is
// supplied (e.g. a country selection with only an ISO code).
assert.strictEqual(api.countries.length, 19, 'curated ISO fallback list is retained');
assert.strictEqual(api.filterForCountry('ZZ', null), 0, 'unknown ISO without bounds does not expose every European map');
assert.strictEqual(noMaps.style.display, 'block', 'empty catalog message appears when no CENAGIS map overlaps');
['PL', 'DE', 'UA', 'BY', 'LT', 'LV', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO', 'FR', 'BE-LU', 'NL', 'DK', 'EE', 'CH'].forEach(code => {
    assert(api.countries.some(country => country.code === code), 'fallback coverage includes ' + code);
});
console.log('  ✓ country-ISO fallback catalog retained');

// ── Drift guard: js/map-app.js keeps a static mirror of the curated coverage
// for the premium rows that host the shared sheets (it runs before / without
// this module). The mirror must equal the inversion of COUNTRIES_DATA.
const mapAppSource = read('js/map-app.js');
function mapAppLiteral(name) {
    const match = mapAppSource.match(new RegExp('var ' + name + ' = (\\{[^}]*\\});'));
    assert(match, name + ' is defined in js/map-app.js');
    return vm.runInNewContext('(' + match[1] + ')');
}
const mirror = mapAppLiteral('SHARED_PREMIUM_COUNTRIES');
const catalogKeys = mapAppLiteral('SHARED_PREMIUM_CATALOG_KEYS');
const curatedCountries = mapAppLiteral('CURATED_COVERAGE_COUNTRIES');
const inverted = {};
api.countries.forEach(country => {
    const codes = country.code === 'BE-LU' ? ['BE', 'LU'] : [country.code];
    country.maps.forEach(entry => {
        inverted[entry.id] = (inverted[entry.id] || []).concat(codes);
    });
});
assert.deepStrictEqual(
    new Set(Object.values(catalogKeys)), new Set(Object.keys(api.sharedPremiumMapKeys)),
    'every shared premium sheet is mapped to its CENAGIS id exactly once');
Object.keys(mirror).forEach(id => {
    assert(inverted[id], 'COUNTRIES_DATA covers the mirrored sheet ' + id);
    assert.deepStrictEqual([...mirror[id]].sort(), [...inverted[id]].sort(),
        'mirror of ' + id + ' matches COUNTRIES_DATA');
});
const analyzed = new Set();
api.countries.forEach(country => {
    if (country.code === 'BE-LU') { analyzed.add('BE'); analyzed.add('LU'); }
    else analyzed.add(country.code);
});
assert.deepStrictEqual(new Set(Object.keys(curatedCountries)), analyzed,
    'CURATED_COVERAGE_COUNTRIES matches the COUNTRIES_DATA entries');
console.log('  ✓ map-app.js curated-coverage mirror matches COUNTRIES_DATA');

console.log('✅ test-historical-eu-maps.js passed all checks successfully.');
