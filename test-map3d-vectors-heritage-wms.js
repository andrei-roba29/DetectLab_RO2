/* Regression: 3D pins/icons, heritage points+radii, WMS proxy-first.
 * node test-map3d-vectors-heritage-wms.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');

const windowStub = {};
windowStub.window = windowStub;
function Base(o) { this.options = o || {}; }
function TileLayer() { Base.apply(this, arguments); }
TileLayer.prototype = Object.create(Base.prototype);
function Path(o) { Base.call(this, o); }
Path.prototype = Object.create(Base.prototype);
function LayerGroup(o) { Base.call(this, o); this._layers = []; }
LayerGroup.prototype = Object.create(Base.prototype);
LayerGroup.prototype.getLayers = function () { return this._layers; };
LayerGroup.prototype.eachLayer = function (fn) { this._layers.forEach(fn); };
function Marker(latlng, o) { Base.call(this, o); this._latlng = latlng; }
Marker.prototype = Object.create(Base.prototype);
Marker.prototype.getLatLng = function () { return this._latlng; };
Marker.prototype.toGeoJSON = function () {
    return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [this._latlng.lng, this._latlng.lat] } };
};
Marker.prototype.getPopup = function () { return this._popup || null; };
Marker.prototype.getTooltip = function () { return this._tooltip || null; };
function GeoJSON(o) { LayerGroup.call(this, o); }
GeoJSON.prototype = Object.create(LayerGroup.prototype);
GeoJSON.prototype.toGeoJSON = function () {
    return { type: 'FeatureCollection', features: this._layers.map(l => l.toGeoJSON()) };
};
function Layer(o) { Base.call(this, o); }
Layer.prototype = Object.create(Base.prototype);

windowStub.L = {
    TileLayer, Marker, Path, LayerGroup, GeoJSON, Layer,
    ImageOverlay: function () {}, SVGOverlay: function () {}, VideoOverlay: function () {},
    stamp(l) { return l._leaflet_id; },
    point(x, y) { const p = { x, y }; p.scaleBy = () => p; return p; }
};
const sandbox = { window: windowStub, console, URL, encodeURIComponent, decodeURIComponent, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/map3d-mirror.js'), sandbox, { filename: 'js/map3d-mirror.js' });
const mirror = windowStub.DetectLabMirror;
const map = { getPane: () => ({ style: { zIndex: '620' } }) };
function divIcon(opts) { return { options: opts }; }
function bind(m, popup, tooltip) {
    if (popup) m._popup = { getContent: () => popup };
    if (tooltip) m._tooltip = { getContent: () => tooltip };
    return m;
}

// 1. DARE-style divIcon SVG glyph survives as an image, not a generic dot
{
    const svg = '<svg viewBox="0 0 26 26"><circle cx="13" cy="13" r="11"/></svg>';
    const m = bind(new Marker({ lat: 44, lng: 26 }, {
        icon: divIcon({ html: svg, iconSize: [26, 26], iconAnchor: [13, 13] })
    }), '<b>Fort</b>', '');
    m._leaflet_id = 'dare1';
    const d = mirror.describe(m, map, {});
    assert.strictEqual(d.kind, 'markers');
    const f = d.geojson.features[0];
    assert.strictEqual(typeof f.properties.iconId, 'string', 'feature carries primitive iconId');
    assert.ok(!f.properties.icon, 'non-primitive icon object not handed to MapLibre');
    const spec = d.icons[f.properties.iconId];
    assert.ok(spec && spec.url.startsWith('data:image/svg+xml'), 'SVG glyph becomes an SVG image: ' + (spec && spec.url));
    assert.ok(decodeURIComponent(spec.url).includes('<circle'), 'glyph content preserved');
    console.log('  ✓ DARE divIcon SVG glyph mirrors as the same image');
}

// 2. OSM Places: 0×0 label-only anchor -> no invented dot, label is per-feature text
{
    const m = bind(new Marker({ lat: 44, lng: 26 }, {
        icon: divIcon({ html: '', iconSize: [0, 0], iconAnchor: [0, 0] })
    }), '', 'Cluj-Napoca');
    m._leaflet_id = 'osm1';
    const d = mirror.describe(m, map, {});
    const f = d.geojson.features[0];
    assert.strictEqual(f.properties.noDot, 1, 'label-only places get noDot');
    assert.strictEqual(f.properties.label, 'Cluj-Napoca', 'place name travels as per-feature label');
    assert.ok(!f.properties.iconId, 'no icon id for a label-only anchor');
    console.log('  ✓ OSM Places label-only anchors keep their name and gain no pin');
}

// 3. GeoJSON pointToLayer markers (DARE GeoJSON layer) regain icons/popups
{
    const g = new GeoJSON({});
    g._leaflet_id = 'dareGj';
    const svg = '<svg viewBox="0 0 26 26"><rect x="4" y="4" width="18" height="18"/></svg>';
    const child = bind(new Marker({ lat: 45, lng: 27 }, {
        icon: divIcon({ html: svg, iconSize: [26, 26], iconAnchor: [13, 13] })
    }), '<b>Villa</b>', 'Villa');
    g._layers = [child];
    const d = mirror.describe(g, map, {});
    assert.strictEqual(d.kind, 'vector');
    const f = d.geojson.features[0];
    assert.ok(f.properties.iconId && d.icons[f.properties.iconId], 'GeoJSON marker child icon re-attached');
    assert.strictEqual(f.properties.popup, '<b>Villa</b>');
    console.log('  ✓ GeoJSON pointToLayer markers (DARE) regain glyph + popup');
}

// 4. Heritage bridge (canvas-only points + 600 m radii) mirrors as per-feature vector
{
    const bridge = new Layer({ pane: 'pane_patrimoniu' });
    bridge._leaflet_id = 'her3d';
    bridge._dl3dFeatures = () => ({
        stamp: '3|1',
        label: 'Patrimoniu (heritage)',
        geojson: { type: 'FeatureCollection', features: [
            { type: 'Feature', properties: { color: '#E60000', fillColor: '#E60000', radius: 5, fillOpacity: 0.9, kind: 'site' },
              geometry: { type: 'Point', coordinates: [26, 44] } },
            { type: 'Feature', properties: { color: '#C42B2B', fillColor: '#C42B2B', fillOpacity: 0.35, opacity: 0.6, kind: 'radius' },
              geometry: { type: 'Polygon', coordinates: [[[26, 44], [26.01, 44], [26.01, 44.01], [26, 44]]] } }
        ] }
    });
    assert.strictEqual(mirror.classify(bridge, windowStub.L), 'vector');
    const d = mirror.describe(bridge, map, {});
    assert.ok(d && d.perFeature, 'heritage descriptor is per-feature');
    assert.strictEqual(JSON.stringify(Array.from(d.types).sort()), '["Point","Polygon"]');
    const fakeMap = { getPane: map.getPane, eachLayer: fn => fn(bridge) };
    const collected = mirror.collect(fakeMap);
    assert.strictEqual(collected.items.length, 1);
    assert.ok(collected.signature.includes('3|1'), 'signature carries heritage stamp so async radii trigger resync');
    console.log('  ✓ heritage points + radius polygons mirror (not only GeoJSON polygons)');
}

// Country selection is border-only in 3D; its green wash belongs to 2D.
{
    const options = { pane: 'pane_country_bounds', color: '#39ff14', weight: 2.5,
        opacity: 0.9, fillColor: '#39ff14', fillOpacity: 0.05, interactive: false };
    const country = new GeoJSON(options);
    country._leaflet_id = 'country-ro';
    const path = new Path(Object.assign({}, options));
    path._leaflet_id = 'country-path';
    path.toGeoJSON = () => ({ type: 'Feature', properties: {}, geometry: {
        type: 'Polygon', coordinates: [[[26,44],[27,44],[27,45],[26,44]]]
    } });
    country._layers = [path];
    const original = JSON.stringify(path.options);
    const d = mirror.describe(country, map, {});
    assert.strictEqual(d.paints.fill['fill-opacity'], 0, 'no green wash in 3D');
    assert.strictEqual(d.paints.line['line-color'], '#39ff14', 'border preserved');
    assert.strictEqual(d.paints.line['line-opacity'], 0.9);
    const collected = mirror.collect({ getPane: map.getPane, eachLayer: fn => { fn(country); fn(path); } });
    assert.ok(collected.items.length > 0);
    collected.items.forEach(item => assert.strictEqual(item.paints.fill['fill-opacity'], 0,
        'group and directly visited child both remain untinted'));
    assert.strictEqual(JSON.stringify(path.options), original, '2D highlight unchanged');
    assert.strictEqual(country.options.fillOpacity, 0.05);
    const ordinary = new Path(Object.assign({}, options, { pane: 'pane_patrimoniu' }));
    ordinary._leaflet_id = 'green-data-polygon';
    ordinary.toGeoJSON = path.toGeoJSON;
    assert.strictEqual(mirror.describe(ordinary, map, {}).paints.fill['fill-opacity'], 0.05,
        'real data polygons retain their fill even if they share the same green');
    console.log('  ✓ country border retained without a green terrain wash; 2D and data fills unchanged');
}

// 5. Static contracts in viewer / app
{
    const viewer = read('js/map3d-terrain.js');
    assert.ok(viewer.includes("['get', 'label']"), 'labels render per feature, not from the first feature');
    assert.ok(viewer.includes("['image', ['get', 'iconId']]"), 'symbol icons resolve per feature');
    assert.ok(viewer.includes("['!', ['has', 'noDot']]"), 'label-only features are excluded from fallback dots');
    assert.ok(viewer.includes('preferProxy: isWms'), 'mirrored WMS tiles go proxy-first (no failed CORS wave)');
    assert.ok(viewer.includes("useProxy && !options.proxyUrl"), 'proxy refusal falls back to direct');
    assert.ok(viewer.includes('item.perFeature'), 'viewer paints heritage per-feature colours/radii');
    const app = read('js/map-app.js');
    assert.ok(app.includes('_dl3dFeatures'), 'map-app exposes the heritage canvas data to the mirror');
    assert.ok(app.includes('_heritageCirclePolygon'), '600 m radii become geodesic polygons for 3D');
    assert.ok(app.includes('_heritage3dBridge.addTo(m)'), 'heritage bridge follows the heritage toggle');
    assert.ok(app.includes('_heritagePointRecords.forEach'), 'heritage bridge emits the point records (pins)');
    console.log('  ✓ viewer + heritage bridge contracts present');
}
console.log('✅ test-map3d-vectors-heritage-wms.js passed');
