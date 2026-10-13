// Regression suite for js/wms-health.js — the third-party WMS availability
// guard that keeps a silently-broken CENAGIS / IH PAN layer from flooding the
// network with undecodable “200 OK” tiles.
//
// Covers: the one-probe gate on layer add, the cooldown, tile-error tripping,
// retry, the offline path, the GetMap URL the probe builds, and the wiring in
// index.html / sw.js / js/map-app.js / js/historical-eu-maps.js.
//
// Usage: node test-wms-health.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] WMS availability guard (CENAGIS / IH PAN)...');

const read = function (p) { return fs.readFileSync(path.join(__dirname, p), 'utf8'); };

// ══════════════════════════════════════════════════════════════
// 1. Static wiring — the guard must actually be reachable in the app
// ══════════════════════════════════════════════════════════════
const indexHtml = read('index.html');
const swJs = read('sw.js');
const mapApp = read('js/map-app.js');
const histEu = read('js/historical-eu-maps.js');

const guardTag = indexHtml.indexOf('js/wms-health.js?v=20261013-wms-guard');
assert(guardTag !== -1, 'index.html loads the versioned WMS guard');
assert(guardTag > indexHtml.indexOf('js/leaflet.js'), 'the guard loads after Leaflet');
assert(guardTag < indexHtml.indexOf('js/map-app.js?v=20261013-wms-guard'),
    'the guard loads before map-app.js creates the CENAGIS layers');
assert(guardTag < indexHtml.indexOf('js/historical-eu-maps.js?v=20261013-wms-guard'),
    'the guard loads before the country-map catalog wraps it');
assert(swJs.includes('js/wms-health.js?v=20261013-wms-guard'), 'sw.js precaches the guard');
assert(swJs.includes('js/map-app.js?v=20261013-wms-guard'), 'sw.js precaches the re-versioned map app');
assert(swJs.includes('js/historical-eu-maps.js?v=20261013-wms-guard'), 'sw.js precaches the re-versioned catalog');
const shellVersion = Number((swJs.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]);
assert(shellVersion >= 191, 'sw.js cache is v191 or newer so installed PWAs pick the guard up');
console.log('  ✓ index.html / sw.js load and precache the guard in order');

// Premium panel: every CENAGIS layer names its row + switch for the guard.
['mitteleuropa', 'chrzanowski', 'reymann', 'kdr100k', 'kdrGb', 'wig100k'].forEach(function (key) {
    assert(mapApp.includes("window._" + key + "MapLayer._detectlabUiKeys = ['" + key + "'];"),
        'map-app.js tags the ' + key + ' layer for the guard');
});
assert(!/layers:\s*'topp:/.test(mapApp) && !/layers:\s*'topp:/.test(histEu),
    'no CENAGIS request is built with the stock "topp:" workspace prefix');
assert(histEu.includes("layers: 'ihpan:' + mapMeta.wms_layer"),
    'the country catalog asks the ihpan workspace it actually publishes');
assert(histEu.includes('layer._detectlabUiKeys = [mapKey];') &&
       histEu.includes('layer._detectlabUiTitle = mapMeta.title'),
    'the country catalog hands the guard its row key and display title');
console.log('  ✓ app modules tag their CENAGIS layers for the guard');

// ══════════════════════════════════════════════════════════════
// 2. Sandbox — a stub DOM + a stub Leaflet good enough for the guard
// ══════════════════════════════════════════════════════════════
function Point(x, y) { this.x = x; this.y = y; }
// Leaflet normalises array/plain-object operands with toPoint(); mirror that.
function toP(v) {
    if (Array.isArray(v)) return new Point(v[0], v[1]);
    return v instanceof Point ? v : new Point(v.x, v.y);
}
Point.prototype.clone = function () { return new Point(this.x, this.y); };
Point.prototype.subtract = function (o) { o = toP(o); return new Point(this.x - o.x, this.y - o.y); };
Point.prototype.add = function (o) { o = toP(o); return new Point(this.x + o.x, this.y + o.y); };
Point.prototype.divideBy = function (n) { return new Point(this.x / n, this.y / n); };
Point.prototype.multiplyBy = function (n) { return new Point(this.x * n, this.y * n); };
Point.prototype.floor = function () { return new Point(Math.floor(this.x), Math.floor(this.y)); };
Point.prototype.round = function () { return new Point(Math.round(this.x), Math.round(this.y)); };

const R = 6378137;
const D = Math.PI / 180;
const WORLD = 2 * Math.PI * R;

function mercX(lng) { return R * lng * D; }
function mercY(lat) { return R * Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2)); }
function projectLatLng(latlng, zoom) {
    const world = 256 * Math.pow(2, zoom);
    return new Point((mercX(latlng.lng) + Math.PI * R) / WORLD * world,
                     (Math.PI * R - mercY(latlng.lat)) / WORLD * world);
}
function unprojectPoint(pt, zoom) {
    const world = 256 * Math.pow(2, zoom);
    const x = pt.x / world * WORLD - Math.PI * R;
    const y = Math.PI * R - pt.y / world * WORLD;
    return { lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D, lng: x / R / D };
}

// ── Stub elements ──
function makeEl(tag) {
    const el = {
        tagName: (tag || 'div').toUpperCase(),
        children: [], listeners: {}, attrs: {}, events: [],
        className: '', textContent: '', checked: false, type: '',
        style: { cssText: '', display: '' },
        setAttribute: function (k, v) { this.attrs[k] = String(v); },
        getAttribute: function (k) { return k in this.attrs ? this.attrs[k] : null; },
        removeAttribute: function (k) { delete this.attrs[k]; },
        appendChild: function (c) { this.children.push(c); return c; },
        addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
        dispatchEvent: function (ev) { this.events.push(ev); (this.listeners[ev.type] || []).forEach((f) => f(ev)); },
        querySelector: function (sel) { return this.querySelectorAll(sel)[0] || null; },
        querySelectorAll: function (sel) {
            const wanted = String(sel).split(',').map((s) => s.trim().toUpperCase());
            return this.children.filter((c) => wanted.indexOf(c.tagName) !== -1);
        }
    };
    return el;
}

function matches(el, sel) {
    let m = sel.match(/^\.([\w-]+)\[data-([\w-]+)="([^"]*)"\]$/);
    if (m) {
        return (el.className || '').split(/\s+/).indexOf(m[1]) !== -1 &&
               el.getAttribute('data-' + m[2]) === m[3];
    }
    return false;
}

function makeDocument(catalog) {
    const byId = {};
    const all = [];
    const doc = {
        readyState: 'complete',
        documentElement: { lang: 'ro' },
        body: makeEl('body'),
        // Assigning .id must register the node, exactly like the real DOM
        // (getElementById has to find the notice after it is created).
        createElement: function (tag) {
            const el = makeEl(tag);
            Object.defineProperty(el, 'id', {
                get() { return this._id || ''; },
                set(v) { this._id = v; byId[v] = el; },
                configurable: true
            });
            return el;
        },
        getElementById: function (id) { return byId[id] || null; },
        querySelectorAll: function (sel) {
            if (sel === '.cenagis-map-row') return all.filter((e) => e.className.indexOf('cenagis-map-row') !== -1);
            return all.filter((e) => matches(e, sel));
        },
        addEventListener: function () {},
        // Legacy path — the guard prefers window.Event and falls back here.
        createEvent: function () { return { type: '', initEvent(t) { this.type = t; } }; }
    };
    Object.keys(catalog).forEach((key) => {
        const row = makeEl('div');
        row.className = 'cenagis-map-row hist-eu-map-row';
        row.setAttribute('data-map-id', key);
        const title = makeEl('div');
        title.textContent = catalog[key].title || key;
        row.appendChild(title);
        const checkbox = makeEl('input');
        checkbox.className = 'cenagis-toggle';
        checkbox.checked = false;
        checkbox.setAttribute('data-map-key', key);
        byId[key + 'MapToggle'] = checkbox;          // premium-panel shape
        all.push(row, checkbox);
    });
    return doc;
}

// ── Stub Image: every request is recorded; the test answers it ──
function installImageStub(sandbox) {
    sandbox.__images = [];
    sandbox.Image = function () {
        const img = {
            naturalWidth: 0, naturalHeight: 0, onload: null, onerror: null, _src: '',
            set src(v) { this._src = v; sandbox.__images.push(this); },
            get src() { return this._src; }
        };
        return img;
    };
}
function answerImage(img, ok, size) {
    img.naturalWidth = ok ? (size || 256) : 0;
    img.naturalHeight = ok ? (size || 256) : 0;
    if (ok && img.onload) img.onload();
    else if (!ok && img.onerror) img.onerror();
}
function flush() { return new Promise((r) => setImmediate(r)); }

// ── Stub Leaflet ──
function makeLeaflet(sandbox) {
    const L = {
        CRS: {
            EPSG3857: { code: 'EPSG:3857', project: (ll) => new Point(mercX(ll.lng), mercY(ll.lat)) },
            EPSG4326: { code: 'EPSG:4326', project: (ll) => new Point(ll.lng, ll.lat) }
        },
        point: (x, y) => new Point(x, y),
        // Leaflet normalises corner order here — mirror that, or a NE/SW
        // pair would come out as a decreasing bbox.
        bounds: (a, b) => ({ min: new Point(Math.min(a.x, b.x), Math.min(a.y, b.y)),
                             max: new Point(Math.max(a.x, b.x), Math.max(a.y, b.y)) }),
        Util: {
            getParamString: function (obj, existingUrl, uppercase) {
                const parts = [];
                Object.keys(obj).forEach(function (k) {
                    const name = uppercase ? k.toUpperCase() : k;
                    parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(obj[k]));
                });
                return (existingUrl && existingUrl.indexOf('?') !== -1 ? '&' : '?') + parts.join('&');
            }
        },
        tileLayer: {}
    };
    L.tileLayer.wms = function (url, options) {
        const layer = {
            _url: url,
            options: options || {},
            wmsParams: {
                service: 'WMS', request: 'GetMap',
                layers: (options || {}).layers || '', styles: '',
                format: (options || {}).format || 'image/jpeg',
                transparent: !!(options || {}).transparent,
                version: (options || {}).version || '1.1.1'
            },
            _map: null,
            addCalls: 0, removeCalls: 0, tileListeners: {},
            onAdd: function (map) { this.addCalls++; this._map = map; },
            onRemove: function () { this.removeCalls++; this._map = null; },
            getTileSize: function () { return new Point(256, 256); },
            on: function (t, fn) { (this.tileListeners[t] = this.tileListeners[t] || []).push(fn); },
            off: function (t, fn) {
                const list = this.tileListeners[t] || [];
                const i = list.indexOf(fn);
                if (i !== -1) list.splice(i, 1);
            },
            fireTiles: function (t) { (this.tileListeners[t] || []).slice().forEach((f) => f()); }
        };
        return layer;
    };
    return L;
}

function makeMap() {
    const map = {
        layers: [],
        _zoom: 5,
        _center: { lat: 52, lng: 19 },
        getZoom: function () { return this._zoom; },
        setZoom: function (z) { this._zoom = z; },
        getCenter: function () { return this._center; },
        getSize: function () { return new Point(1024, 768); },
        project: function (ll, z) { return projectLatLng(ll, z == null ? this._zoom : z); },
        unproject: function (pt, z) { return unprojectPoint(pt, z == null ? this._zoom : z); },
        hasLayer: function (l) { return this.layers.indexOf(l) !== -1; },
        removeLayer: function (l) {
            const i = this.layers.indexOf(l);
            if (i !== -1) this.layers.splice(i, 1);
            if (l) l._map = null;
            return this;
        },
        addTo: function (l) { this.layers.push(l); return this; }
    };
    return map;
}

function loadGuard() {
    const doc = makeDocument({
        mitteleuropa: { title: 'Übersichtskarte von Mitteleuropa (1893–1945)' },
        kdr100k: { title: 'Karte des Deutschen Reiches (1878–1945)' }
    });
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Date, Math, JSON, encodeURIComponent, parseFloat, String, Object, Array,
        navigator: { onLine: true },
        document: doc
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.Image = undefined;
    installImageStub(sandbox);
    sandbox.L = sandbox.window.L = makeLeaflet(sandbox);
    sandbox._currentLang = function () { return 'en'; };

    const code = fs.readFileSync(path.join(__dirname, 'js/wms-health.js'), 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'js/wms-health.js' });
    assert(sandbox.DetectLabWmsHealth, 'the guard exposes window.DetectLabWmsHealth');
    return sandbox;
}

// ══════════════════════════════════════════════════════════════
// 3. Behaviour
// ══════════════════════════════════════════════════════════════
(async function main() {
    const sandbox = loadGuard();
    const G = sandbox.window.DetectLabWmsHealth;
    const CENAGIS = 'https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms';
    const map = makeMap();

    // ── 3a. Guards only foreign-host URLs, and is idempotent ──
    const other = sandbox.L.tileLayer.wms('https://example.org/wms', { layers: 'x' });
    assert(!G.isGuardedUrl('https://example.org/wms'), 'other hosts are not guarded');
    assert(G.isGuardedUrl(CENAGIS), 'the CENAGIS host is guarded');
    G.guard(other);
    assert(!other._detectlabWmsGuard, 'guarding an unlisted host is a no-op');
    console.log('  ✓ guard applies to the CENAGIS host only');

    // ── 3b. The probe asks for the tile Leaflet would ask for ──
    const probeLayer = sandbox.L.tileLayer.wms(CENAGIS, {
        layers: 'ihpan:ukvme_3857', format: 'image/png', transparent: true,
        version: '1.1.1', crs: sandbox.L.CRS.EPSG3857
    });
    const url111 = G.sampleUrl(probeLayer, map);
    assert(url111.indexOf('service=WMS') !== -1, 'probe URL carries service=WMS');
    assert(url111.indexOf('request=GetMap') !== -1, 'probe URL carries request=GetMap');
    assert(url111.indexOf('layers=ihpan%3Aukvme_3857') !== -1, 'probe URL carries the layer name');
    assert(url111.indexOf('width=256') !== -1 && url111.indexOf('height=256') !== -1, 'probe requests one 256px tile');
    assert(url111.indexOf('srs=EPSG%3A3857') !== -1, '1.1.1 uses srs=');
    const bbox = (url111.match(/&bbox=([^&]+)/) || [])[1];
    assert(bbox, 'probe URL carries a bbox');
    const nums = bbox.split(',').map(Number);
    assert(nums.length === 4 && nums.every((n) => isFinite(n)) && nums[2] > nums[0] && nums[3] > nums[1],
        'bbox is four finite, increasing coordinates: ' + bbox);
    const centreM = sandbox.L.CRS.EPSG3857.project(map.getCenter());
    assert(nums[0] <= centreM.x && centreM.x <= nums[2] && nums[1] <= centreM.y && centreM.y <= nums[3],
        'the probe asks for the tile under the view centre');
    const versioned = sandbox.L.tileLayer.wms(CENAGIS, {
        layers: 'ihpan:kdr_3857', version: '1.3.0', crs: sandbox.L.CRS.EPSG3857, format: 'image/png'
    });
    const url130 = G.sampleUrl(versioned, map);
    assert(url130.indexOf('crs=EPSG%3A3857') !== -1 && url130.indexOf('srs=') === -1,
        '1.3.0 uses crs=, not srs=');
    console.log('  ✓ probe builds the same GetMap the layer would');

    // ── 3c. A 200 with an error body (onerror) blocks the add ──
    sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:ukvme_3857' });
    const layer = G._test.peers[G._test.peers.length - 1];
    layer._detectlabUiKeys = ['mitteleuropa'];
    sandbox.document.getElementById('mitteleuropaMapToggle').checked = true;   // the user just switched it on
    const before = sandbox.__images.length;
    layer.onAdd(map);
    await flush();
    assert(sandbox.__images.length === before + 1, 'exactly one probe request is made');
    assert(layer.addCalls === 0, 'the layer is not added while the probe is in flight');
    answerImage(sandbox.__images[sandbox.__images.length - 1], false);
    await flush();
    assert(layer.addCalls === 0, 'a failing probe never adds the layer');
    assert(G.isDownFor(layer), 'the failing layer is marked down');
    const toggle = sandbox.document.getElementById('mitteleuropaMapToggle');
    assert(toggle.checked === false, 'the failing layer’s switch is turned off');
    const row = sandbox.document.querySelectorAll('.cenagis-map-row[data-map-id="mitteleuropa"]')[0];
    assert(row.getAttribute('data-wms-state') === 'down', 'the failing layer’s row is marked down');
    const nodes = G._test.noticeNodes();
    assert(nodes && nodes.box.style.display === 'block', 'the notice is shown');
    assert(/CENAGIS/.test(nodes.body.textContent), 'the notice names the provider server');
    assert(/Mitteleuropa/.test(nodes.body.textContent), 'the notice names the map');
    console.log('  ✓ a failed probe trips the switch, the row and the notice');

    // ── 3d. Cooldown: no second request while the verdict stands ──
    const requests = sandbox.__images.length;
    layer.onAdd(map);
    await flush();
    assert(sandbox.__images.length === requests, 'a layer known to be down is not probed again inside the cooldown');
    assert(layer.addCalls === 0, 'the layer is not added inside the cooldown');
    console.log('  ✓ cooldown keeps a known-bad layer from hammering the server');

    // ── 3e. Retry re-enables only what the guard switched off ──
    const untouched = makeEl('input');
    untouched.className = 'cenagis-toggle';
    untouched.setAttribute('data-map-key', 'kdr100k');
    untouched.checked = false;
    sandbox.document.getElementById('kdr100kMapToggle').checked = false;
    const keys = G.retry();
    assert(keys.length === 1 && keys[0] === 'mitteleuropa', 'retry returns the keys the guard blocked');
    assert(toggle.checked === true, 'retry switches the blocked row back on');
    assert(toggle.events.some((e) => e.type === 'change'), 'retry replays the app’s own change handler');
    assert(!G.isDownFor(layer), 'retry forgets the down verdict');
    assert(row.getAttribute('data-wms-state') === null, 'retry clears the row mark');
    assert(nodes.box.style.display === 'none', 'retry hides the notice');
    G._test.verdicts[G._test.verdictKey(layer)] = { state: 'down', at: Date.now(), reason: 'test' };
    G.retry();
    console.log('  ✓ retry only touches rows the guard turned off');

    // ── 3f. A healthy probe admits the layer, then tile errors trip it ──
    const good = sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:kdr_3857' });
    const goodLayer = G._test.peers[G._test.peers.length - 1];
    goodLayer._detectlabUiKeys = ['kdr100k'];
    map.addTo(goodLayer);
    const reads = sandbox.__images.length;
    goodLayer.onAdd(map);
    await flush();
    assert(sandbox.__images.length === reads + 1, 'the healthy path probes once too');
    answerImage(sandbox.__images[sandbox.__images.length - 1], true);
    await flush();
    assert(goodLayer.addCalls === 1, 'a passing probe adds the layer exactly once');
    assert(!G.isDownFor(goodLayer), 'the passing layer is not marked down');
    goodLayer.fireTiles('tileerror');
    goodLayer.fireTiles('tileerror');
    assert(!G.isDownFor(goodLayer), 'two failures are not enough to trip a layer');
    goodLayer.fireTiles('tileerror');
    assert(G.isDownFor(goodLayer), 'three failures with no success trip it');
    assert(goodLayer.removeCalls >= 0 && !map.hasLayer(goodLayer), 'tripping removes the layer from the map');
    console.log('  ✓ tile errors trip an accepted layer after three failures');

    // ── 3g. Offline never blames the provider and remembers no cooldown ──
    G.retry();
    sandbox.navigator.onLine = false;
    const off = sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:ukvme_3857' });
    const offLayer = G._test.peers[G._test.peers.length - 1];
    offLayer._detectlabUiKeys = ['mitteleuropa'];
    offLayer.onAdd(map);
    await flush();
    answerImage(sandbox.__images[sandbox.__images.length - 1], false);
    await flush();
    assert(!G.isDownFor(offLayer), 'an offline failure is not cached as a server verdict');
    assert(/offline/i.test(G._test.noticeNodes().title.textContent), 'the notice says the connection is at fault');
    sandbox.navigator.onLine = true;
    console.log('  ✓ offline is reported as a local problem, without a cooldown');

    // ── 3h. Balanced add/remove while a probe is pending ──
    G.retry();
    const pend = sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:reymann_3857' });
    const pendLayer = G._test.peers[G._test.peers.length - 1];
    pendLayer._detectlabUiKeys = ['reymann'];
    pendLayer.onAdd(map);                       // probe in flight
    assert(pendLayer.addCalls === 0, 'nothing is added while the probe is pending');
    pendLayer.onRemove(map);                    // user toggled it off again
    assert(pendLayer.removeCalls === 0, 'the original onRemove is skipped, so the pair stays balanced');
    answerImage(sandbox.__images[sandbox.__images.length - 1], true);
    await flush();
    assert(pendLayer.addCalls === 0, 'a probe that resolves after removal cannot add the layer');
    console.log('  ✓ a probe that resolves after removal does not resurrect the layer');

    // ── 3i. Keys and titles ──
    const bare = sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:ukvme_3857' });
    assert(String(G._test.keysFor(bare)) === 'ukvme', 'a layer without UI keys falls back to its map key');
    const named = sandbox.L.tileLayer.wms(CENAGIS, { layers: 'ihpan:ukvme_3857' });
    named._detectlabUiKeys = ['mitteleuropa'];
    named._detectlabUiTitle = 'Übersichtskarte von Mitteleuropa (1893–1945)';
    assert(G._test.nameFor(named, 'mitteleuropa') === 'Übersichtskarte von Mitteleuropa (1893–1945)',
        'the layer’s own title names it in the notice');
    assert(G._test.nameFor(named, 'kdr100k') === 'Karte des Deutschen Reiches (1878–1945)',
        'a key without a title falls back to its row text');
    console.log('  ✓ notice names come from the layer title, the row, or the key');

    console.log('\n✅ test-wms-health.js passed all checks successfully.');
})().catch(function (err) {
    console.error('\n❌ test-wms-health.js failed:', err.message);
    console.error(err.stack);
    process.exit(1);
});
