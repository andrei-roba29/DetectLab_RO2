// Viewport layer-filter regression tests. No network, account or npm dependencies.
// Run: node test-layer-visibility.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const source = read('js/map-app.js');
const html = read('index.html');
const css = read('css/styles.css');
const sw = read('sw.js');
const ROW_CLASS = 'viewport-layer-unavailable';
const ARROW_CLASS = 'layer-group-arrow-highlight';
const groups = ['hist', 'lidar', 'roman', 'histPremium'];
const OUTSIDE = [[20, -20], [21, -19]];
const BANAT = [[45, 21], [45.1, 21.1]];
const BUCOVINA = [[48.35, 25], [48.4, 25.1]];
const ALL = [[40, 15], [52, 35]];

function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert(from >= 0 && to > from, 'production section must exist: ' + start);
    return source.slice(from, to);
}

const coverageConfig = section('var premiumMapCoverageBounds = {', '// Create coverage polygons');
const visibilityCode = section('// ── LAYER VIEWPORT FILTER', '// ── BUCOVINA 1861-1864 (XYZ tiles');

// Leaflet-compatible rectangle intersection, including edge contact. Browser
// smoke checks use the actual bundled Leaflet; this keeps the unit test offline.
function latLngBounds(points) {
    if (points && typeof points.intersects === 'function') return points;
    const south = Math.min(points[0][0], points[1][0]);
    const west = Math.min(points[0][1], points[1][1]);
    const north = Math.max(points[0][0], points[1][0]);
    const east = Math.max(points[0][1], points[1][1]);
    return {
        south, west, north, east,
        intersects(other) {
            return other.north >= south && other.south <= north &&
                other.east >= west && other.west <= east;
        }
    };
}

class MapMock {
    constructor(points) {
        this.bounds = latLngBounds(points);
        this.listeners = {};
        this.reads = 0;
    }
    getBounds() { this.reads++; return this.bounds; }
    setBounds(points) { this.bounds = latLngBounds(points); }
    on(types, callback) {
        types.split(' ').forEach(type => (this.listeners[type] ||= new Set()).add(callback));
    }
    off(types, callback) {
        types.split(' ').forEach(type => this.listeners[type]?.delete(callback));
    }
    fire(type) { [...(this.listeners[type] || [])].forEach(callback => callback()); }
}

class ElementMock extends EventTarget {
    constructor(tag, attrs, parent) {
        super();
        this.tagName = tag;
        this.type = attrs.type || '';
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
    }
    closest(selector) {
        for (let el = this; el; el = el.parentElement) {
            if (selector.startsWith('.') && el.classList.contains(selector.slice(1))) return el;
        }
        return null;
    }
    setAttribute(key, value) { this[key] = String(value); }
}

// Read the actual row ancestry/IDs from index.html so PWA tests cannot silently
// pass with invented IDs or a different panel structure. Only element structure
// is needed; scripts, comments, text and CSS are intentionally not interpreted.
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
    document.querySelectorAll = selector => document.elements.filter(el => {
        if (selector === '[data-category]') return !!el.dataset.category;
        if (selector === '.transp-panel-tabs button') {
            return el.tagName === 'button' && !!el.closest('.transp-panel-tabs');
        }
        throw new Error('Unsupported test selector: ' + selector);
    });
    return document;
}

function setup({ local = new MapMock(OUTSIDE), exposed, legacy, pwa = false, visualViewport = true } = {}) {
    const document = makeDocument();
    document.body.classList.toggle('is-pwa', pwa);
    const window = new EventTarget();
    Object.assign(window, { _dlMap: exposed, map: legacy });
    if (visualViewport) window.visualViewport = new EventTarget();
    const frames = [];
    const intervals = [];
    const timeouts = [];
    window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    const context = vm.createContext({
        window, document, map: local, L: { latLngBounds },
        setInterval: (callback, delay) => intervals.push({ callback, delay }),
        setTimeout: (callback, delay) => timeouts.push({ callback, delay }),
        // No-op here: flushTimeouts() drains the queue anyway, and the
        // production release callback is self-guarded (no-op when the panel
        // is collapsed), so a "cancelled" timer firing late is harmless.
        clearTimeout: () => {}
    });
    vm.runInContext(source.match(/var ROMANIA_BOUNDS = [^;]+;/)[0], context);
    vm.runInContext(source.match(/var APM_BOUNDS = [^;]+;/)[0], context);
    vm.runInContext(coverageConfig + visibilityCode, context);
    // Accordion height helpers — the expand/collapse toggles below call
    // setSubLayersMaxHeight, so the real definitions must exist in context.
    vm.runInContext(section('function measureSubLayersHeight', '(function initMap()'), context);
    return {
        window, document, context, local, intervals, timeouts,
        row: id => document.getElementById(id),
        check: () => window.checkLayerVisibility(),
        flushFrames: () => frames.splice(0).forEach(callback => callback()),
        flushTimeouts: () => timeouts.splice(0).forEach(({ callback }) => callback())
    };
}

function highlighted(h, id) {
    const el = h.row(id);
    assert(el, id + ' exists in the shared desktop/PWA DOM');
    return !el.classList.contains(ROW_CLASS);
}

function assertGroupsUnoutlined(h) {
    groups.forEach(group => {
        const row = h.row(group + 'ExpandIcon').closest('.transp-layer-row');
        assert.equal(row.classList.contains('layer-visible-highlight'), false, group + ': no green availability highlight');
        assert.equal(h.row(group + 'ExpandIcon').classList.contains('layer-group-arrow-highlight'), false, group + ': arrow stays neutral');
    });
}

function premiumRows(h) {
    return h.document.elements.filter(el => el.parentElement?.id === 'histPremiumSubLayers' && el.id !== 'histEuMapsSection' && !el.classList.contains(ROW_CLASS))
        .map(el => el.id).sort();
}

test('desktop: Banat keeps covered leaves and hides Bucovina and unrelated areas', () => {
    const h = setup({ local: new MapMock(BANAT) });
    // WWII, Mitteleuropa and Reymann also cover Banat. Excluding them would break intersects semantics.
    // "Other maps" (Hungaricana composites) ships without coverage bounds, so it stays visible everywhere.
    assert.deepEqual(premiumRows(h), ['banatRow', 'mitteleuropaRow', 'otherMapsRow', 'reymannRow', 'ww2Row']);
    assert.equal(highlighted(h, 'bucovinaRow'), false);
    assert.equal(highlighted(h, 'satellite60sRow'), true);
    assert.equal(h.row('histPremiumExpandIcon').classList.contains(ARROW_CLASS), false);
    assertGroupsUnoutlined(h);
});

test('PWA: _dlMap takes precedence over a stale local map and window.map', () => {
    const active = new MapMock(BUCOVINA);
    const local = new MapMock(BANAT);
    const legacy = new MapMock(ALL);
    const h = setup({ exposed: active, local, legacy, pwa: true });
    // Galicia 1855, Chrzanowski, KDR Großblatt, Mitteleuropa, Reymann, WIG 100k also span the Bucovina viewport.
    // The boundless "Other maps" row is always visible; the UK-only maps are hidden (no GB/IE intersection).
    assert.deepEqual(premiumRows(h), ['bucovinaRow', 'chrzanowskiRow', 'galicia1855Row', 'kdrGbRow', 'mitteleuropaRow', 'otherMapsRow', 'reymannRow', 'wig100kRow', 'ww2Row']);
    assert.equal(active.reads, 1);
    assert.equal(local.reads + legacy.reads, 0);
    assert.equal(h.row('histPremiumExpandIcon').classList.contains(ARROW_CLASS), false);
    assert.equal(h.row('transpPanel').classList.contains('open'), false);
    assertGroupsUnoutlined(h);
});

test('local map and legacy window.map fallbacks work; unavailable/unready maps are safe', () => {
    const legacy = new MapMock(BANAT);
    const h = setup({ local: null, legacy, visualViewport: false });
    assert.equal(highlighted(h, 'banatRow'), true);
    h.window.map = null;
    assert.doesNotThrow(h.check);
    h.window._dlMap = {};
    assert.doesNotThrow(h.check);
    h.window._dlMap = { getBounds() { throw new Error('not loaded'); } };
    assert.doesNotThrow(h.check);
    h.window._dlMap = new MapMock(BUCOVINA);
    h.check();
    assert.equal(highlighted(h, 'bucovinaRow'), true);
});

test('partial overlaps and boundary contact count; rows return when coverage enters the viewport', () => {
    const h = setup();
    h.local.setBounds([[44.5, 20.8], [44.6, 20.9]]); // only Banat's SW corner overlaps
    h.local.fire('moveend');
    assert.equal(highlighted(h, 'banatRow'), true);
    h.local.setBounds([[46.35, 22.45], [46.4, 22.5]]); // touches NE corner
    h.local.fire('zoomend');
    assert.equal(highlighted(h, 'banatRow'), true);
    h.local.setBounds(OUTSIDE);
    h.local.fire('moveend');
    assert.equal(highlighted(h, 'banatRow'), false);
    groups.forEach(group => assert.equal(h.row(group + 'ExpandIcon').classList.contains(ARROW_CLASS), false));
});

test('moveend, zoomend and resize listen on the active map, without duplicate subscriptions', () => {
    const active = new MapMock(OUTSIDE);
    const h = setup({ exposed: active, pwa: true });
    ['moveend', 'zoomend', 'resize'].forEach(type => {
        active.setBounds(BUCOVINA);
        active.fire(type);
        assert.equal(highlighted(h, 'bucovinaRow'), true, type);
        active.setBounds(OUTSIDE);
        active.fire(type);
        assert.equal(highlighted(h, 'bucovinaRow'), false, type);
        assert.equal(active.listeners[type].size, 1);
        assert.equal(h.local.listeners[type], undefined);
    });
    const replacement = new MapMock(BANAT);
    h.window._dlMap = replacement;
    h.check();
    h.check();
    ['moveend', 'zoomend', 'resize'].forEach(type => {
        assert.equal(active.listeners[type].size, 0, 'detach old ' + type);
        assert.equal(replacement.listeners[type].size, 1, 'bind new ' + type + ' once');
    });
});

test('PWA periodic refresh runs with the panel closed, including when is-pwa is added later', () => {
    const h = setup();
    assert.equal(h.intervals.length, 1);
    assert.equal(h.intervals[0].delay, 2000);
    const tick = h.intervals[0].callback;
    h.local.setBounds(BUCOVINA);
    tick();
    assert.equal(highlighted(h, 'bucovinaRow'), false, 'desktop closed panel skips polling');
    h.document.body.classList.add('is-pwa');
    tick();
    assert.equal(highlighted(h, 'bucovinaRow'), true);
    h.document.body.classList.remove('is-pwa');
    h.row('transpPanel').classList.add('open');
    h.local.setBounds(OUTSIDE);
    tick();
    assert.equal(highlighted(h, 'bucovinaRow'), false, 'desktop open panel refreshes');
});

test('visualViewport/window resize and auth changes refresh after layout; bursts coalesce', () => {
    const h = setup({ pwa: true });
    h.window.visualViewport.dispatchEvent(new Event('resize'));
    h.window.dispatchEvent(new Event('resize'));
    h.window.dispatchEvent(new Event('detectlab:authchange'));
    assert.equal(h.local.reads, 1, 'defer until all handlers have updated the UI');
    h.local.setBounds(BUCOVINA);
    h.flushFrames();
    assert.equal(h.local.reads, 2, 'one check per frame');
    assert.equal(highlighted(h, 'bucovinaRow'), true);
    h.local.setBounds(OUTSIDE);
    h.window.dispatchEvent(new Event('detectlab:authchange'));
    h.flushFrames();
    assert.equal(highlighted(h, 'bucovinaRow'), false, 'logout refreshes too');
});

test('PWA account-stack click/change re-check after togglePwa actions without early function wrapping', () => {
    const h = setup({ pwa: true });
    assert.equal(h.window.togglePwaDetection, undefined, 'inline PWA functions are defined later');
    ['click', 'change'].forEach(type => {
        h.local.setBounds(OUTSIDE);
        h.check();
        h.row('pwa-br-stack').dispatchEvent(new Event(type));
        h.local.setBounds(BUCOVINA); // inline control/layout handler
        h.flushFrames();
        assert.equal(highlighted(h, 'bucovinaRow'), true, type);
    });
    assert.match(
        source,
        /getElementById\('compassCol'\)[\s\S]*?addEventListener\('click', scheduleLayerVisibilityCheck\)/,
        'the compass-column Detect toggle also triggers a refresh'
    );
});

test('pageshow/foreground refresh a resumed PWA', () => {
    const h = setup({ pwa: true });
    h.local.setBounds(BUCOVINA);
    h.window.dispatchEvent(new Event('pageshow'));
    h.flushFrames();
    assert.equal(highlighted(h, 'bucovinaRow'), true);
    h.local.setBounds(OUTSIDE);
    h.document.hidden = true;
    h.document.dispatchEvent(new Event('visibilitychange'));
    h.flushFrames();
    assert.equal(highlighted(h, 'bucovinaRow'), true, 'do not schedule while hidden');
    h.document.hidden = false;
    h.document.dispatchEvent(new Event('visibilitychange'));
    h.flushFrames();
    assert.equal(highlighted(h, 'bucovinaRow'), false);
});

test('all real historical, LIDAR and Roman rows resolve in the shared PWA panel', () => {
    const h = setup({ local: new MapMock(ALL), pwa: true });
    const leafRows = h.document.elements.filter(el =>
        ['histSubLayers', 'lidarSubLayers', 'romanSubLayers', 'histPremiumSubLayers'].includes(el.parentElement?.id) &&
        h.document.elements.some(control => {
            if (control.tagName !== 'input' || control.type === 'search') return false;
            for (let parent = control.parentElement; parent; parent = parent.parentElement) {
                if (parent === el) return true;
            }
            return false;
        }));
    assert.equal(leafRows.length, 74, '4 historical + 11 LIDAR + 32 Roman + 27 premium rows (19 prior + 8 UK historical maps)');
    // The Pleiades, AWMC names and eastern Mediterranean political layers are
    // now real rows in the shared Roman/Premium panel.
    ['roman_places', 'roman_regional_names', 'roman_shade_herod', 'roman_shade_hasmonean'].forEach(id => {
        assert(h.row(id), '#' + id + ' is present in the Roman sublayer UI');
    });
    const pwaStack = h.row('pwa-br-stack');
    assert(pwaStack, 'PWA account stack keeps its id');
    // The "ALL" fixture is a central/Southeast-European viewport (lng 15–35):
    // the eight UK/GB-IE historical maps legitimately filter out there, and
    // nothing else may be hidden.
    const viewportHidden = leafRows.filter(row => row.classList.contains(ROW_CLASS)).map(row => row.id).sort();
    assert.deepEqual(viewportHidden, [
        'ukBaire1940Row', 'ukOs10k1888Row', 'ukOs1900sRow', 'ukOs1919Row',
        'ukOs25k1937Row', 'ukOs63k1955Row', 'ukOsHills1885Row', 'ukOsLondon1893Row'
    ], 'only the eight UK/GB-IE historical maps are hidden outside their coverage');
    leafRows.filter(row => !row.classList.contains(ROW_CLASS)).forEach(row => {
        assert.equal(row.closest('.transp-panel'), h.row('transpPanel'));
        for (let el = row; el; el = el.parentElement) {
            assert.notEqual(el, pwaStack, (row.id || 'anonymous row') + ' stays out of the PWA account stack');
        }
    });
    assertGroupsUnoutlined(h);
});

test('missing/late rows are safe and do not suppress the group arrow', () => {
    const h = setup({ local: new MapMock(OUTSIDE), pwa: true });
    const lateRows = ['bucovinaRow', 'ww2Row'].map(id => h.row(id));
    lateRows.forEach(row => h.document.ids.delete(row.id));
    h.local.setBounds(BUCOVINA);
    assert.doesNotThrow(h.check);
    assert.equal(h.row('histPremiumExpandIcon').classList.contains(ARROW_CLASS), false);
    lateRows.forEach(row => h.document.ids.set(row.id, row));
    h.window.dispatchEvent(new Event('detectlab:authchange'));
    h.flushFrames();
    assert.equal(highlighted(h, 'bucovinaRow'), true);
});

test('group rows never receive green highlights', () => {
    const h = setup();
    [OUTSIDE, ALL].forEach(bounds => {
        groups.forEach(group => h.row(group + 'ExpandIcon').closest('.transp-layer-row').classList.add(ROW_CLASS));
        h.local.setBounds(bounds);
        h.check();
        assertGroupsUnoutlined(h);
    });
});

test('the panel publishes its open state on <body> from one place', () => {
    // css/index.html move the floating PWA stack out of the way of the
    // bottom-anchored layers window through body.transp-panel-open; both the
    // open and the click-outside close must go through the same setter.
    const setter = /function markTranspPanelOpen\(on\) \{[\s\S]*?\n\s{12}\}/.exec(source);
    assert(setter, 'one setter owns the panel open state');
    assert(/classList\.toggle\('transp-panel-open', transpPanelOpen\)/.test(setter[0]),
        'the setter is the only place that writes body.transp-panel-open');
    const uses = (source.match(/markTranspPanelOpen\(/g) || []).length;
    assert(uses >= 3, 'open and the click-outside close both go through the setter (found ' + uses + ')');
});

test('tab switching and all five direct expand/panel hooks remain functional', () => {
    const h = setup();
    vm.runInContext(section('function switchLayerTab', '// Initialize with'), h.context);
    h.local.setBounds(BUCOVINA);
    h.context.switchLayerTab('premium');
    assert.equal(highlighted(h, 'bucovinaRow'), true);
    vm.runInContext('var _expanded = false, _lidarSubExpandedState = false, _histPremiumSubExpanded = false, transpPanelOpen = false;', h.context);
    // window.toggleTranspPanel is extracted on its own below, and it delegates
    // every class write to the sibling setter, so that helper has to exist in
    // the sandbox before the snippet can run.
    vm.runInContext(section('function markTranspPanelOpen', 'window.toggleTranspPanel'), h.context);
    ['toggleHistSubLayers', 'toggleLidarSubLayers', 'toggleRomanSubLayers', 'toggleHistPremiumSubLayers', 'toggleTranspPanel'].forEach(name => {
        const match = source.match(new RegExp('window\\.' + name + ' = function\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\};'));
        assert(match, name + ' has a direct implementation');
        assert(match[0].includes('window.checkLayerVisibility()'), name + ' retains its direct refresh');
        vm.runInContext(match[0], h.context);
        h.local.setBounds(OUTSIDE);
        h.check();
        h.local.setBounds(BUCOVINA);
        h.window[name]();
        h.flushTimeouts();
        h.flushFrames();
        assert.equal(highlighted(h, 'bucovinaRow'), true, name);
    });
});

test('viewport filtering hides unavailable rows, removes decorative layer icons and never uses green highlights', () => {
    assert.match(css, /#transpPanel\.viewport-filter-active \.viewport-layer-unavailable\s*\{\s*display: none !important/);
    assert.doesNotMatch(css, /\.layer-visible-highlight\s*\{/);
    assert.doesNotMatch(css, /\.layer-group-arrow-highlight\s*\{/);
    assert.match(css, /#transpPanel \.transp-layer-label > span:first-child > svg[\s\S]*?display: none !important/);
    assert.match(css, /babel-scroll-icon/);
    assert.match(source, /viewport-layer-unavailable/);
    assert.match(source, /mapBounds, def\.bounds/);
});

test('PWA asset URLs are versioned together and pre-cached under a refreshed cache name', () => {
    const cssURL = html.match(/href="(css\/styles\.css\?v=[^"]+)"/)[1];
    const jsURL = html.match(/src="(js\/map-app\.js\?v=[^"]+)"/)[1];
    [cssURL, jsURL].forEach(url => {
        assert(!['css/styles.css?v=20260907-nearby-popup', 'js/map-app.js?v=20260902-satbase-native18'].includes(url),
            'do not reuse the pre-fix asset URLs');
        assert(sw.includes("'" + url + "'"), url + ' must be pre-cached exactly');
    });
    const cacheVersion = sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/);
    assert(cacheVersion && Number(cacheVersion[1]) >= 74, 'installed PWAs must invalidate the previous v73 cache');
});
