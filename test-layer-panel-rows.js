// Test suite for the layers window's glass material and the per-row tile photo
// of every historical-map sublayer.
// Usage: node test-layer-panel-rows.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Layers window: glass rows + historical tile-photo rows...');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const css = read('css/styles.css');
const html = read('index.html');
const sw = read('sw.js');
const moduleSource = read('js/layer-panel-rows.js');
const registrySource = read('js/layer-registry.js');

const flatHtml = html.replace(/\n\s*/g, ' ');
function ruleOf(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(source);
    assert(m, 'missing CSS rule for ' + selector);
    return m[1];
}

/* ── 1. The window and its rows are ONE material: the control glass ────── */
const panel = ruleOf(css, '.transp-panel');
assert(/backdrop-filter:\s*var\(--ctl-blur\)/.test(panel),
    'the layers window blurs what is behind it with the control glass blur');
assert(/var\(--ctl-border\)/.test(panel),
    'the window edge is the violet control border, not the old sky-blue one');
assert(!/rgba\(10,20,42,0\.97\)/.test(panel),
    'the near-opaque navy slab must be gone — the window is translucent now');
const panelAlpha = (panel.match(/rgba\(20,14,34,var\(--panel-top-alpha\)\)/) || [])[0];
assert(panelAlpha, 'the window carries its own violet tint behind the blur');
assert(/--panel-top-alpha:\s*0\.6\d/.test(panel) && /--panel-bottom-alpha:\s*0\.7\d/.test(panel),
    'both tint stops stay under 0.8 alpha so the map really shows through');
assert(/padding:\s*22px 16px 0/.test(panel), 'the compact panel padding is unchanged');

const rows = ruleOf(css, '.transp-layer-row,\n        .dl-sublayer-row');
assert(/background:\s*var\(--ctl-bg\)/.test(rows) && /border:\s*1px solid var\(--ctl-border\)/.test(rows),
    'layer rows use the same translucent violet box as the map controls');
assert(!/backdrop-filter/.test(rows),
    'rows add no second blur layer inside the already-blurred window — the blur is the pane\'s');
assert(/position:\s*relative/.test(rows), 'rows anchor their own background photo');
assert(/--row-radius:\s*var\(--ctl-radius\)/.test(rows), 'the row radius comes from the control material');

/* Nested rows the accordions render take the very same rule. */
const subRows = ruleOf(css, '#transpPanel .dl-sublayer-row');
assert(/--row-radius:\s*10px/.test(subRows), 'nested rows are a compact version of the same box');
console.log('  ✓ window + top-level rows + nested rows share the --ctl-* glass material');

/* ── 2. The tile photo: mean-ed out, violet-washed, under the controls ─── */
const before = ruleOf(css, '.transp-layer-row[data-row-preview]::before,\n        .dl-sublayer-row[data-row-preview]::before');
assert(/background-image:\s*var\(--row-preview\)/.test(before),
    'the row background is the layer\'s own tile, passed in as --row-preview');
const filter = (before.match(/filter:([^;]+);/) || [])[1] || '';
assert(!/blur\(/.test(filter), 'tile details remain recognizable, not blurred away');
assert(/saturate\(0\.85\)/.test(filter) && /brightness\(0\.9\)/.test(filter),
    'the preview keeps map colours and detail beneath the dark wash');
assert(/opacity:\s*0\.95/.test(before), 'the preview is visible rather than a faint colour wash');
assert(/clip-path:\s*inset\(0 round var\(--row-radius\)\)/.test(before),
    'the blur is clipped back to the row radius');

const after = ruleOf(css, '.transp-layer-row[data-row-preview]::after,\n        .dl-sublayer-row[data-row-preview]::after');
assert(/linear-gradient\(180deg,\s*rgba\(45,33,74,0\.4/.test(after),
    'a violet fade sits on top of the photo');
assert(/radial-gradient\([^)]*rgba\(126,94,214,0\.30\)/.test(after), 'the fade carries the engaged-violet tint');

const above = ruleOf(css, '.transp-layer-row[data-row-preview] > *,\n        .dl-sublayer-row[data-row-preview] > *');
assert(/z-index:\s*1/.test(above), 'the switch, slider, info button and labels paint above the photo');
console.log('  ✓ the photo is a mean, violet-washed backdrop underneath the controls');

/* ── 3. Every historical sublayer row opts in, and every id resolves ───── */
const tagged = [...html.matchAll(/data-preview-layer="([^"]+)"/g)].map(m => m[1]);
assert(tagged.length === 29, 'all 29 historical sublayer rows carry a preview layer id (got ' + tagged.length + ')');
assert.deepStrictEqual(tagged, [...new Set(tagged)], 'no row is tagged twice');

const fakeDocument = {
    readyState: 'complete',
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};
const sandboxWindow = { document: fakeDocument };
const sandbox = {
    window: sandboxWindow,
    document: fakeDocument,
    console,
    setTimeout, clearTimeout,
    Image: function () {}
};
vm.createContext(sandbox);
vm.runInContext(registrySource, sandbox, { filename: 'js/layer-registry.js' });
assert(sandboxWindow.DetectLabLayers, 'the shared registry loads before the row chrome');
vm.runInContext(moduleSource, sandbox, { filename: 'js/layer-panel-rows.js' });

const api = sandboxWindow.DetectLabPanelRows;
assert(api && typeof api.urlFor === 'function' && api.anchors, 'js/layer-panel-rows.js exports its API');

tagged.forEach(id => {
    assert(sandboxWindow.DetectLabLayers.get(id), 'unknown layer id on a row: ' + id);
    const url = api.urlFor(id);
    assert(url, 'no tile-photo URL for the tagged row ' + id);
    assert(/^https:\/\//.test(url), 'the row photo is an https tile request: ' + id);
});

/* Every historical layer of the registry either declares a bounding box or is
 * listed in the anchors table — a new sheet cannot silently lose its photo. */
const historical = sandboxWindow.DetectLabLayers.list().filter(def =>
    (def.group === 'hist-free' || def.group === 'hist-premium') &&
    ['xyz', 'arcgis-image', 'wms'].indexOf(def.kind) !== -1 &&
    !def.runtimeOverlays);
const unbounded = historical.filter(def => !def.bounds || def.bounds.length !== 2);
unbounded.forEach(def => {
    assert(api.anchors[def.id], 'unbounded historical layer without an anchor: ' + def.id);
});
console.log('  ✓ 29 tagged rows resolve; ' + unbounded.length + ' unbounded layers are anchored');

/* ── 4. The URL really is one of that layer's OWN tiles ────────────────── */
const escapeLiteral = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* Split a tile template into its literal parts and its {z}/{x}/{y} tokens, so
 * the generated URL can be read back without assuming an order: ArcGIS
 * pyramids are {z}/{y}/{x}, XYZ pyramids are {z}/{x}/{y}. */
function readBack(template, url) {
    const pieces = template.split(/(\{[zxy]\})/);
    const names = [];
    let pattern = '';
    pieces.forEach(piece => {
        const token = /^\{([zxy])\}$/.exec(piece);
        if (token) {
            names.push(token[1]);
            pattern += '(\\d+)';
        } else {
            pattern += escapeLiteral(piece);
        }
    });
    const m = new RegExp('^' + pattern + '$').exec(url);
    if (!m) return null;
    const out = {};
    names.forEach((name, i) => { out[name] = Number(m[i + 1]); });
    return out;
}

function tileCentre(tile) {
    const span = Math.pow(2, tile.z);
    const n = Math.PI - 2 * Math.PI * (tile.y + 0.5) / span;
    return {
        lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
        lng: (tile.x + 0.5) / span * 360 - 180
    };
}

const pyramids = historical.filter(def => def.kind === 'xyz' || def.kind === 'arcgis-image');
let bounded = 0;
pyramids.forEach(def => {
    const parsed = readBack(def.url, api.urlFor(def.id));
    assert(parsed, 'the row photo is built from the layer tile template: ' + def.id);
    assert(parsed.z >= (def.minZoom || 0) && parsed.z <= (def.maxZoom || 22),
        'the preview zoom is inside the layer zoom window: ' + def.id);
    if (def.bounds && def.bounds.length === 2) {
        const centre = tileCentre(parsed);
        const south = def.bounds[0][0], west = def.bounds[0][1];
        const north = def.bounds[1][0], east = def.bounds[1][1];
        assert(centre.lat >= south - 0.5 && centre.lat <= north + 0.5 &&
               centre.lng >= west - 0.5 && centre.lng <= east + 0.5,
            'the preview tile falls inside ' + def.id + ' (' + centre.lat.toFixed(3) + ', ' +
            centre.lng.toFixed(3) + ' vs its declared bounds)');
        bounded++;
    }
});
assert(bounded >= 8, 'the bounded pyramids are checked against their own footprint');
console.log('  ✓ ' + pyramids.length + ' tile pyramids resolve to a tile inside their own coverage');

/* WMS mosaics preview through a small GetMap over the sheet's middle. */
const josephine = api.urlFor('premium.josephine');
assert(/r2\.dev\/Josephine\/\d+\/\d+\/\d+\.jpg$/.test(josephine), 'Josephine previews its own R2 mosaic tile');

const mitteleuropa = api.urlFor('premium.mitteleuropa');
['service=WMS', 'request=GetMap', 'version=1.1.1', 'layers=ihpan%3Aukvme_2180',
    'srs=EPSG:3857', 'width=168', 'height=96', 'transparent=true'].forEach(part => {
    assert(mitteleuropa.includes(part), 'the WMS preview carries ' + part);
});
const titleLayer = sandboxWindow.DetectLabLayers.get('premium.mitteleuropa');
assert(mitteleuropa.startsWith(titleLayer.url), 'the preview asks the layer\'s own WMS endpoint');

const austrian = api.urlFor('hist.austrian');
assert(/version=1\.1\.0/.test(austrian) && /srs=EPSG:3857/.test(austrian),
    'a 1.1.0 service is asked with SRS, not CRS');
assert(/layers=eharta%3Amozaic_austrian_200k/.test(austrian), 'the free historical rows preview too');

/* The CENAGIS catalogue rows are resolved from their data-map-id. */
const cenagisUrl = api.urlFor('cenagis.wig100k');
assert(/layers=ihpan%3Awig100k_3857/.test(cenagisUrl),
    'a CENAGIS catalogue row previews its own catalogue sheet');

/* Non-historical layers are left alone. */
assert.strictEqual(api.urlFor('premium.josephine') && api.urlFor('basemap.osm'), null,
    'only historical layers get a row photo');
console.log('  ✓ WMS mosaics preview through GetMap; XYZ/ArcGIS through their own tile template');

/* ── 5. Loading is lazy, greedy-free and failure-tolerant ──────────────── */
assert(/data-row-preview-state/.test(moduleSource),
    'a row remembers it was already tried, so a dead service is asked once');
assert(/img\.onerror/.test(moduleSource) && /data-row-preview-state', 'failed'/.test(moduleSource),
    'a tile that fails to load leaves the plain glass row behind');
assert(/READY\[url\]/.test(moduleSource) && /BROKEN\[url\]/.test(moduleSource),
    'a loaded tile is remembered and a broken one is never retried — the CENAGIS '
    + 'catalogue re-renders on every country change');
assert(/MAX_IN_FLIGHT/.test(moduleSource) && /pump\(\)/.test(moduleSource),
    'requests are capped instead of opening one socket per row');
assert(/classList\.contains\('open'\)/.test(moduleSource),
    'nothing is fetched while the window is closed');
assert(/getClientRects/.test(moduleSource),
    'collapsed accordions and hidden tabs are skipped until they are shown');
assert(/\.cenagis-map-row/.test(moduleSource) && /removeAttribute\('style'\)/.test(moduleSource),
    'the CENAGIS rows drop their generated inline dark box and take the shared material');
assert(/SubLayers\$/.test(moduleSource), 'the nested rows are found through their *SubLayers containers');
console.log('  ✓ previews load only for visible rows, once, and fail soft');

/* Refreshing generated rows must not erase an already-loaded background. */
{
    const classes = new Set();
    let removals = 0;
    const row = {
        classList: { contains: key => classes.has(key), add: key => classes.add(key) },
        removeAttribute: name => { assert.strictEqual(name, 'style'); removals++; }
    };
    const host = { querySelectorAll: selector => selector === '.cenagis-map-row' ? [row] : [] };
    fakeDocument.getElementById = id => id === 'transpPanel' ? host : null;
    api.markGlass();
    api.markGlass();
    assert.strictEqual(removals, 1, 'later sweeps preserve the preview custom property');
    fakeDocument.getElementById = () => null;

}

/* ── 6. Wiring: cache-busting, precache, shell version ─────────────────── */
const TAG = '20261026-historical-previews';
const STYLES_TAG = '20261026-historical-previews';
assert(html.includes('js/layer-panel-rows.js?v=' + TAG), 'index.html loads the row chrome, versioned');
assert(sw.includes("'js/layer-panel-rows.js?v=" + TAG + "'"), 'sw.js precaches the row chrome');
const stylesUrl = (html.match(/href="(css\/styles\.css\?v=[^"]+)"/) || [])[1];
assert(stylesUrl && stylesUrl.endsWith(STYLES_TAG), 'the restyled stylesheet is re-tagged (' + stylesUrl + ')');
assert(sw.includes("'" + stylesUrl + "'"), 'sw.js precaches the live stylesheet URL');
const cacheNum = Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1] || 0);
assert(cacheNum >= 270, 'the service-worker cache is bumped for the new shell (got v' + cacheNum + ')');
const stylesTagPos = html.indexOf('css/styles.css?v=' + STYLES_TAG);
const rowsTagPos = html.indexOf('js/layer-panel-rows.js?v=' + TAG);
const registryTagPos = html.indexOf('js/layer-registry.js?v=');
assert(registryTagPos !== -1 && registryTagPos < rowsTagPos,
    'the row chrome loads after the registry it reads its endpoints from');
assert(stylesTagPos !== -1, 'the stylesheet is wired');
console.log('  ✓ cache wiring: ?v=' + TAG + ', shell v' + cacheNum);

console.log('\nAll layers-window glass + row-photo checks passed.');
