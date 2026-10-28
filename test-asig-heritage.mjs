import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { asigHeritageResponse, representativePoint } from './backend/src/lib/asig-heritage.mjs';
const require = createRequire(import.meta.url);
const factory = require('./js/asig-heritage.js');
const layer = 'akzm:monumentet_natyrore_07032023';
const request = (query = '') => {
    const url = new URL('https://detectlab.eu/api/geo/asig-heritage?layer=' + layer + '&bbox=19.7,41.2,19.9,41.4');
    new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
    return new Request(url);
};
let calls = 0;
const upstream = async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(new URL(url).origin, 'https://geoportal.asig.gov.al');
    assert.equal(params.get('maxFeatures'), '150');
    assert.equal(params.get('bbox'), '19.7,41.2,19.9,41.4,EPSG:4326');
    assert.equal(params.get('srsName'), 'EPSG:4326');
    return Response.json({ type: 'FeatureCollection', features: Array.from({ length: 150 }, (_, i) => ({ type: 'Feature', id: i, properties: { emri: '<script>test</script>', secret: 'not returned' }, geometry: { type: 'Point', coordinates: [19.8, 41.3] } })) });
};
let response = await asigHeritageResponse(request(), upstream);
assert.equal(response.status, 200);
let data = await response.json();
assert.equal(data.features.length, 150);
assert.equal(data.truncated, true);
assert.equal(data.features[0].properties.secret, undefined);
assert.deepEqual(representativePoint({ type: 'Polygon', coordinates: [[[19.7,41.2],[19.9,41.4],[19.7,41.2]]] }), [19.799999999999997,41.3]);
assert.equal((await asigHeritageResponse(request('&layer=not:allowed'), upstream)).status, 400);
assert.equal((await asigHeritageResponse(request('&bbox=1,2,3,4'), upstream)).status, 400);
assert.equal((await asigHeritageResponse(request('&bbox=19.9,41.4,19.7,41.2'), upstream)).status, 400);
assert.equal(calls, 1, 'invalid requests never reach upstream');
assert.equal((await asigHeritageResponse(request(), async () => new Response('<Exception/>'))).status, 502);
assert.equal((await asigHeritageResponse(request(), async () => new Response('x'.repeat(2000001)))).status, 502);
assert.equal((await asigHeritageResponse(request(), async () => Response.json({ type: 'FeatureCollection', features: [{ geometry: { type: 'Point', coordinates: [1000000,1000000] } }] }))).status, 502);
const point = i => ({ type: 'Feature', id: String(i), geometry: { type: 'Point', coordinates: [19.8 + i * 0.000001,41.3] }, properties: { title: '<b>safe</b>' } });
let zoom = 12, requests = [], markers = [], statuses = [], pending;
const group = { addTo() { return this; }, clearLayers() { markers = []; }, eachLayer(fn) { markers.forEach(fn); }, addLayer(marker) { markers.push(marker); } };
const L = {
    Layer: { extend(def) { return class { constructor(options) { Object.assign(this, def); this.initialize(options); } }; } },
    layerGroup() { return group; },
    divIcon(options) { return options; },
    marker(position, options) { return { position, options, on() {}, setOpacity() {}, bindPopup(content) { this.content = content; return this; } }; }
};
const root = { document: { documentElement: { lang: 'en' }, createElement() { return {}; } }, fetch: async (url, options) => {
    requests.push({ url, options });
    if (pending) return pending;
    return Response.json({ type: 'FeatureCollection', features: Array.from({ length: 150 }, (_, i) => point(i + requests.length * 150)), truncated: true });
} };
const Heritage = factory(L, root);
const controller = new Heritage({ opacity: 0.5, parts: () => Array.from({ length: 8 }, (_, i) => ({ name: layer + i })), status: (text, kind) => statuses.push({ text, kind }) });
const map = { getZoom: () => zoom, getBounds: () => ({ getWest: () => 19.7, getSouth: () => 41.2, getEast: () => 19.9, getNorth: () => 41.4 }),
    project: ([lat,lng], z) => ({ x: lng * 2 ** z, y: lat * 2 ** z }), on() {}, off() {}, removeLayer() {} };
controller._map = map; controller._group = group;
zoom = 9;
await controller._load();
assert.equal(requests.length, 0, 'no national query below the zoom gate');
zoom = 12;
await controller._load();
assert.equal(requests.length, 4, 'total feature budget stops subsequent sources');
assert.ok(markers.length < 600, 'zoom-dependent grid clusters reduce rendered markers');
assert.ok(statuses.at(-1).text.includes('Partial'), 'capped results are explicitly labelled');
assert.ok(requests.every(r => r.url.includes('bbox=19.7,41.2,19.9,41.4')), 'queries use the current viewport');
const separated = [point(0), { ...point(1), geometry: { type: 'Point', coordinates: [19.801, 41.3] } }];
zoom = 12;
controller._draw(separated);
const coarseCount = markers.length;
zoom = 18;
controller._draw(separated);
assert.ok(markers.length > coarseCount, 'zooming in splits nearby objects into separate markers');
assert.equal(markers[0].content.textContent, '<b>safe</b>', 'source titles use DOM text, not HTML');
let resolve;
pending = new Promise(r => { resolve = r; });
const loading = controller._load();
const signal = requests.at(-1).options.signal;
controller._cancel();
assert.equal(signal.aborted, true, 'moving/toggling off aborts the active fetch');
resolve(Response.json({ type: 'FeatureCollection', features: [point(1)] }));
await loading;
assert.equal(markers.length, 0, 'stale results cannot repopulate a new view');
pending = null;
root.fetch = async () => new Response('<Exception/>', { status: 502 });
await controller._load();
assert.equal(statuses.at(-1).kind, 'error', 'unsupported WFS is explicit, not an empty success');
// A failed first type must not suppress healthy later sources.
let attempts = 0;
root.fetch = async () => ++attempts === 1
    ? new Response('unavailable', { status: 502 })
    : Response.json({ type: 'FeatureCollection', features: [point(attempts)] });
await controller._load();
assert.equal(attempts, 8, 'all sources are attempted despite the first failure');
assert.ok(markers.length > 0, 'healthy sources still render');
let fallbackAdds = 0, fallbackRemoves = 0, fallbackOpacity, fallbackZ;
const fallback = { setOpacity(v) { fallbackOpacity = v; }, setZIndex(v) { fallbackZ = v; } };
map.addLayer = value => { assert.equal(value, fallback); fallbackAdds++; };
map.removeLayer = value => { if (value === fallback) fallbackRemoves++; };
controller.options.createFallback = (parts, opacity) => {
    assert.equal(parts.length, 8);
    assert.equal(opacity, 0.5);
    return fallback;
};
controller.setZIndex(407);
attempts = 0;
await controller._load();
assert.equal(fallbackAdds, 1, 'one composite map replaces incomplete feature results');
assert.equal(markers.length, 0, 'no duplicate markers over fallback');
assert.equal(fallbackZ, 407);
controller.setOpacity(0.3);
assert.equal(fallbackOpacity, 0.3);
const before = attempts;
await controller._load();
assert.equal(attempts, before, 'fallback avoids repeated failing WFS requests on movement');
controller.onRemove(map);
assert.equal(fallbackRemoves, 1, 'fallback removed with the toggle');
assert.equal(controller._map, null);
assert.equal(controller._group, null);
console.log('ASIG Heritage: proxy bounds, caps, byte limit, point reduction, clustering, cancellation, stale responses and failure handling passed (mock-only).');
