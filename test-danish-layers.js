/*
 * test-danish-layers.js
 * ───────────────────────────────────────────────────────────────────────────
 * Test suite for the Danish layers (Denmark):
 *   1. the CONFIG contract (js/danish-layers.config.js) — the full Danish
 *      catalogue: the original wired layers, the official heritage WFS, the
 *      disabled third-party placeholders AND the complete official
 *      Kulturarv WMS family (every layer of the service's GetCapabilities,
 *      2026-10-28), DA+EN titles, licences, attribution, credentials
 *      declared as environment variables, exactly one Danish base map on by
 *      default, and no secret anywhere near the browser;
 *   2. the shared registry mirror (js/layer-registry.js) — the same layers in the
 *      catalogue the diagnostics and the offline audit read, with the same
 *      LAYERS / format / version / CRS, and a documented guard opt-out;
 *   3. the proxy library (backend/src/lib/danish-layers.mjs) — the token and the
 *      service user are added server-side only, a caller can neither smuggle nor
 *      override credentials, missing credentials return a generic 503, and the
 *      heritage WFS is asked in EPSG:25832 and answered in
 *      EPSG:4326 (the projection is checked against PROJ reference values);
 *   4. the map module (js/danish-layers.js) in a stub DOM + Leaflet — rows built
 *      from the config in the shared switch + slider style (every rendered
 *      layer an independent overlay), per-layer opacity, nothing requested
 *      before a row is switched on, and the country filter;
 *   5. the wiring — index.html (row, container, script order), the i18n keys
 *      (EN + DA), css/styles.css, sw.js and the country-filter hook in
 *      js/map-app.js.
 *
 * No network, no npm dependencies, no browser. Usage: node test-danish-layers.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('[Test] Danish layers (Denmark): config, registry, proxies, map module…');

const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const CONFIG = require('./js/danish-layers.config.js');

let passed = 0;
function ok(label) { passed += 1; console.log('  ✓ ' + label); }

const WIRED = CONFIG.enabledLayers().map((layer) => layer.id);
/* The panel renders exactly the panelGroups catalogue, in group order:
   LiDAR (in the shared LiDAR accordion), then Heritage, Historical maps
   and Ortophoto. Everything else (the spring-orthophoto years, the Danish
   OSM base) is catalogue/proxy data without a row. */
const RENDERED = CONFIG.panelGroups.reduce((ids, group) => ids.concat(group.layers), []);
/* A stand-in for the Dataforsyningen token: the suite only checks that the
   token travels server-side, never in browser requests, never that a
   real one works. No credential may ever be committed. */
const TOKEN = 'test-token-not-a-credential';

/* ══════════════════════════════════════════════════════════════════════════
 * 1. the config
 * ══════════════════════════════════════════════════════════════════════════ */
{
    assert.strictEqual(CONFIG.layers.length, 43, 'the existing Danish layers plus the requested LiDAR, heritage and historical layers plus the ten Kulturarv sublayers are configured');
    assert.strictEqual(CONFIG.country, 'DK');
    assert.deepStrictEqual(CONFIG.layers.slice(0, 6).map((l) => l.id),
        ['dtk25', 'orto', 'naturtyper', 'osm', 'historic-witx', 'fortidsminder']);
    assert.strictEqual(CONFIG.layers.filter((l) => l.id.indexOf('lidar_') === 0).length, 4);
    assert.strictEqual(CONFIG.layers.filter((l) => l.id.indexOf('orto_foraar_') === 0).length, 10);
    assert.strictEqual(CONFIG.layers.filter((l) => l.id.indexOf('orto_sommer_') === 0).length, 4);
    assert.deepStrictEqual(CONFIG.enabledLayers().map((l) => l.id), WIRED);
    assert.strictEqual(CONFIG.byId('historic-witx').enabled, false);
    assert.strictEqual(CONFIG.byId('witx_fundogfortidsminder_areal').enabled, false);
    assert.strictEqual(CONFIG.byId('witx_fundogfortidsminder').enabled, false);
    assert.strictEqual(CONFIG.byId('witx_fundogfortidsminder_areal').layers, 'witx:FundOgFortidsminderAreal');
    assert.strictEqual(CONFIG.byId('witx_fundogfortidsminder').layers, 'witx:FundOgFortidsminder');
    assert.deepStrictEqual(CONFIG.panelGroups.map((group) => [group.id, group.title.en, group.layers]), [
        ['lidar', 'LiDAR', ['lidar_hillshade_historik', 'lidar_quickdhm_exaggerated', 'lidar_dhm_terrain_hillshade', 'lidar_dhm_surface_hillshade']],
        ['heritage', 'Heritage', ['naturtyper', 'fortidsminder',
            'fortidsminder_areal_alle', 'fortidsminder_areal_adm', 'fortidsminder_areal_ka',
            'fortidsminder_areal_beskyttelse', 'fortidsminder_areal_marin',
            'fortidsminder_linie_alle', 'fortidsminder_linje_fredet', 'fortidsminder_linie_marin',
            'fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet', 'fortidsminder_punkt_marin',
            'kulturarv_relief']],
        ['historical', 'Historical maps', ['topo4cm_1980_2001', 'topo4cm_1953_1976', 'hist_lave', 'hist_hoeje', 'hist_preussen', 'dtk25']],
        ['orthophoto', 'Ortophoto', ['orto_sommer_2008', 'orto_sommer_2005', 'orto_sommer_2002', 'orto_sommer_1999']]
    ], 'the requested free Denmark groups and sublayer order are explicit in the catalogue');
    assert.strictEqual(CONFIG.panelGroups.filter((group) => group.id === 'lidar')[0].mount, 'danishLidarLayers',
        'the LiDAR group is mounted in the shared LiDAR accordion');
    CONFIG.panelGroups.forEach((group) => group.layers.forEach((id) => {
        assert.strictEqual(CONFIG.byId(id).enabled, true, id + ' is available in the free Denmark catalogue');
        assert.strictEqual(CONFIG.byId(id).panelGroup, group.id, id + ' is rendered only inside ' + group.id);
    }));
    ok('existing Danish layers retained; requested free Heritage, Historical maps and Ortophoto groups are enabled');

    const FIELDS = ['id', 'title', 'group', 'type', 'url', 'layers', 'crs', 'format', 'minZoom', 'maxZoom',
        'attribution', 'opacity', 'defaultOn', 'enabled', 'requiresCredentials', 'auth', 'provider', 'licence', 'bounds'];
    CONFIG.layers.forEach((layer) => {
        FIELDS.forEach((field) => {
            assert.ok(Object.prototype.hasOwnProperty.call(layer, field),
                layer.id + ' is missing ' + field);
        });
        assert.ok(layer.title.da && layer.title.en, layer.id + ' has a DA and an EN title');
        assert.ok(['base', 'overlay'].indexOf(layer.group) !== -1, layer.id + ' group');
        assert.ok(['wms', 'xyz', 'wfs'].indexOf(layer.type) !== -1, layer.id + ' type');
        assert.ok(layer.attribution && layer.attribution.length > 3, layer.id + ' attribution');
        assert.ok(layer.licence && layer.licence.length > 2, layer.id + ' licence');
        assert.ok(layer.provider, layer.id + ' provider');
        assert.ok(Array.isArray(layer.bounds) && layer.bounds.length === 2, layer.id + ' bounds');
        assert.ok(layer.opacity > 0 && layer.opacity <= 1, layer.id + ' opacity');
        assert.ok(layer.minZoom <= layer.maxZoom, layer.id + ' zoom range');
    });
    ok('every entry carries the full documented field set (DA+EN title, licence, attribution…)');

    ['dtk25', 'orto'].forEach((id) => {
        const layer = CONFIG.byId(id);
        assert.strictEqual(layer.url.indexOf('/api/geo/'), 0, id + ' is reached through the deployment');
        assert.ok(layer.requiresCredentials.length, id + ' declares its variables');
        layer.requiresCredentials.forEach((name) => {
            assert.ok(/^[A-Z][A-Z0-9_]+$/.test(name), id + ' variable name ' + name);
        });
        assert.ok(layer.credentialsNote.da && layer.credentialsNote.en, id + ' explains what to set, DA + EN');
    });
    assert.deepStrictEqual(CONFIG.byId('dtk25').requiresCredentials, ['DATAFORSYNINGEN_TOKEN']);
    assert.deepStrictEqual(CONFIG.byId('orto').requiresCredentials,
        ['DATAFORDELER_USERNAME', 'DATAFORDELER_PASSWORD']);
    ok('credentialed layers use same-origin routes and name their environment variables');

    const defaults = CONFIG.layers.filter((l) => l.defaultOn);
    assert.strictEqual(defaults.length, 1, 'one and only one layer starts on');
    assert.strictEqual(defaults[0].id, 'dtk25');
    assert.strictEqual(defaults[0].group, 'overlay', 'DTK25 is a Historical-maps overlay now, not a base map');
    assert.strictEqual(defaults[0].panelGroup, 'historical');
    ok('exactly one Danish layer starts switched on (DTK25, as an overlay)');

    /* Every rendered layer is an independent overlay: no Danish panel row
       is a mutually-exclusive base map any more. The only remaining
       `base` entries are the unrendered catalogue layers (the GeoDanmark
       spring orthophoto + its ten selector years and the Danish OSM base). */
    RENDERED.forEach((id) => {
        assert.strictEqual(CONFIG.byId(id).group, 'overlay', id + ' is an independent overlay');
    });
    assert.deepStrictEqual(
        CONFIG.enabledLayers().filter((l) => l.group === 'base').map((l) => l.id),
        ['orto', 'osm'].concat(CONFIG.layers.filter((l) => l.selectorGroup === 'spring-orthophoto').map((l) => l.id)),
        'the only enabled bases left are the unrendered catalogue entries');
    assert.ok(CONFIG.enabledLayers().filter((l) => l.group === 'base').every((l) => l.defaultOn === false));
    assert.ok(CONFIG.byId('lidar_hillshade_historik').minZoom <= 12 && CONFIG.byId('lidar_hillshade_historik').maxZoom >= 17);
    assert.ok(CONFIG.byId('lidar_quickdhm_exaggerated').minZoom <= 12 && CONFIG.byId('lidar_dhm_terrain_hillshade').minZoom <= 12);
    assert.ok(CONFIG.layers.filter((l) => l.selectorGroup === 'spring-orthophoto').length === 10);
    ok('every rendered Danish layer is an independent overlay (on/off switch); bases survive only unrendered');

    const nature = CONFIG.byId('naturtyper');
    assert.strictEqual(nature.requiresCredentials.length, 0);
    assert.strictEqual(nature.url, 'https://arealeditering-dist-geo.miljoeportal.dk/geoserver/wms');
    assert.strictEqual(nature.layers, 'dai:bes_naturtyper');
    assert.strictEqual(nature.transparent, true);
    assert.strictEqual(nature.crs, 'EPSG:3857');
    ok('protected nature types: public GeoServer, WMS 1.3.0, EPSG:3857, transparent');

    const osm = CONFIG.byId('osm');
    assert.strictEqual(osm.type, 'xyz');
    assert.ok(osm.url.indexOf('tile.openstreetmap.org') !== -1);
    assert.ok(osm.maxNativeZoom <= 19, 'the community tile servers stop at z19');
    assert.ok(/OpenStreetMap/.test(osm.attribution));
    ok('OpenStreetMap: XYZ template, maxNativeZoom 19, ODbL attribution');

    const heritage = CONFIG.byId('fortidsminder');
    assert.strictEqual(heritage.type, 'wfs');
    assert.strictEqual(heritage.url, '/api/geo/dk-heritage');
    assert.ok(heritage.upstream.indexOf('kulturarv.dk/ffgeoserver') !== -1);
    assert.ok(!/witx/i.test(heritage.url + heritage.upstream), 'the third-party mirror is not used');
    assert.ok(heritage.minZoom >= 12, 'polygons are only fetched when they can be read');
    assert.ok(heritage.wfs.style.fillColor && heritage.wfs.style.color, 'styled for both basemaps');
    assert.ok(heritage.wfs.maxFeatures >= 100 && heritage.wfs.maxFeatures <= 2000, 'a hard feature cap');
    assert.ok(/^CC0/.test(heritage.licence));
    ok('scheduled monuments: official CC0 WFS, minZoom gate, feature cap, readable style');

    /* The two POINT layers of the same service are raster WMS read directly
     * from the agency GeoServer: public, tokenless, EPSG:3857 (verified). */
    ['fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet'].forEach((id) => {
        const points = CONFIG.byId(id);
        assert.strictEqual(points.type, 'wms', id + ' is a WMS overlay');
        assert.strictEqual(points.url, 'https://www.kulturarv.dk/ffgeoserver/public/wms');
        assert.strictEqual(points.layers, 'fundogfortidsminder_' + id.replace('fortidsminder_punkt_', 'punkt_'),
            id + ' requests the service layer of the same product');
        assert.strictEqual(points.crs, 'EPSG:3857', id + ' asks for the map projection');
        assert.strictEqual(points.transparent, true);
        assert.strictEqual(points.auth, 'none');
        assert.deepStrictEqual(points.requiresCredentials, [], id + ' needs no credential');
        assert.ok(/^CC0/.test(points.licence));
        assert.ok(!/witx/i.test(points.url), 'never the third-party mirror');
    });
    assert.ok(CONFIG.byId('fortidsminder_punkt_ikkefredet').minZoom >
        CONFIG.byId('fortidsminder_punkt_fredet').minZoom,
        'the dense unprotected-point layer starts one zoom later');
    assert.strictEqual(CONFIG.byId('fortidsminder_punkt_fredet').minZoom, 7,
        'the protected points are visible from the Denmark view zoom on');
    assert.strictEqual(CONFIG.byId('fortidsminder_punkt_ikkefredet').minZoom, 8,
        'the denser unprotected points join one zoom in');
    ok('heritage points: public CC0 WMS, EPSG:3857, no credential, sensible zoom gates');

    /* The COMPLETE official Kulturarv WMS family (the service's
     * GetCapabilities, updateSequence 526 — checked 2026-10-28): every
     * layer name it publishes must be reachable from the config, and the
     * ten rows that were added after the initial three all follow the
     * direct public-CC0 contract as Heritage sublayers. */
    const KULTURARV_CAPABILITIES = [
        'fundogfortidsminder_areal_adm', 'fundogfortidsminder_areal_alle',
        'fundogfortidsminder_areal_beskyttelse', 'fundogfortidsminder_areal_fredet',
        'fundogfortidsminder_areal_ka', 'fundogfortidsminder_areal_marin',
        'fundogfortidsminder_linie_alle', 'fundogfortidsminder_linie_marin',
        'fundogfortidsminder_linje_fredet', 'fundogfortidsminder_punkt_fredet',
        'fundogfortidsminder_punkt_ikkefredet', 'fundogfortidsminder_punkt_marin',
        'relief'
    ];
    KULTURARV_CAPABILITIES.forEach((name) => {
        const owner = CONFIG.layers.filter((l) => l.layers === name || l.layers === 'public:' + name)[0];
        assert.ok(owner, name + ' of the live GetCapabilities is implemented as a layer');
        assert.strictEqual(owner.provider.indexOf('Slots- og Kulturstyrelsen'), 0,
            name + ' is served by the official agency');
        assert.strictEqual(owner.enabled, true, name + ' ships enabled');
    });
    ok('every layer of the Kulturarv GetCapabilities is implemented (13/13)');

    const KULTURARV_NEW = ['fortidsminder_areal_alle', 'fortidsminder_areal_adm',
        'fortidsminder_areal_ka', 'fortidsminder_areal_beskyttelse', 'fortidsminder_areal_marin',
        'fortidsminder_linie_alle', 'fortidsminder_linje_fredet', 'fortidsminder_linie_marin',
        'fortidsminder_punkt_marin'];
    KULTURARV_NEW.forEach((id) => {
        const row = CONFIG.byId(id);
        assert.ok(row, id + ' exists');
        assert.strictEqual(row.type, 'wms', id + ' is a WMS overlay');
        assert.strictEqual(row.url, 'https://www.kulturarv.dk/ffgeoserver/public/wms',
            id + ' is read straight from the agency GeoServer (no proxy needed)');
        assert.ok(/^fundogfortidsminder_(areal|linie|linje|punkt)_/.test(row.layers),
            id + ' requests its own service layer (' + row.layers + ')');
        assert.strictEqual(row.crs, 'EPSG:3857', id + ' asks for the map projection');
        assert.strictEqual(row.transparent, true);
        assert.strictEqual(row.version, '1.3.0');
        assert.strictEqual(row.auth, 'none');
        assert.deepStrictEqual(row.requiresCredentials, [], id + ' needs no credential');
        assert.ok(/^CC0/.test(row.licence), id + ' is CC0 1.0 like the rest of the register');
        assert.ok(!/witx/i.test(row.url), 'never the third-party mirror');
        assert.strictEqual(row.group, 'overlay', id + ' is an independent overlay');
        assert.strictEqual(row.defaultOn, false, id + ' starts off');
        assert.strictEqual(row.panelGroup, 'heritage', id + ' renders inside the Heritage section');
        assert.ok(row.title.da && row.title.en, id + ' has a DA and an EN title');
        assert.ok(row.identify && row.identify.fields.length >= 3, id + ' answers GetFeatureInfo clicks');
        assert.ok(row.minZoom >= 8 && row.minZoom <= 9 && row.maxZoom >= 20,
            id + ' opens at a sensible zoom gate (got ' + row.minZoom + ')');
    });
    const relief = CONFIG.byId('kulturarv_relief');
    assert.ok(relief, 'kulturarv_relief exists');
    assert.strictEqual(relief.layers, 'relief', 'the service\'s own relief raster');
    assert.strictEqual(relief.type, 'wms');
    assert.strictEqual(relief.url, 'https://www.kulturarv.dk/ffgeoserver/public/wms');
    assert.strictEqual(relief.crs, 'EPSG:3857');
    assert.strictEqual(relief.transparent, true, 'the relief blends over the basemap');
    assert.strictEqual(relief.panelGroup, 'heritage');
    assert.strictEqual(relief.identify, null, 'a raster is not queryable');
    assert.ok(relief.minZoom <= 6 && relief.maxNativeZoom >= 12 && relief.maxNativeZoom <= 16,
        'the relief opens early and upscales beyond its unpublished native grid');
    const heritageGroup = CONFIG.panelGroups.filter((g) => g.id === 'heritage')[0];
    assert.deepStrictEqual(heritageGroup.layers.slice(2),
        ['fortidsminder_areal_alle', 'fortidsminder_areal_adm', 'fortidsminder_areal_ka',
            'fortidsminder_areal_beskyttelse', 'fortidsminder_areal_marin',
            'fortidsminder_linie_alle', 'fortidsminder_linje_fredet', 'fortidsminder_linie_marin',
            'fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet', 'fortidsminder_punkt_marin',
            'kulturarv_relief'],
        'the Kulturarv rows are sublayers of the Heritage section, grouped areas → lines → points → relief');
    ok('the ten new Kulturarv rows: direct public CC0 WMS, EPSG:3857, Heritage sublayers');

    /* The scheduled-monuments areas are bright neon orange now: the user asked
       for an eye-catching colour, and the areas are the group's hero layer. */
    assert.strictEqual(heritage.wfs.style.color, '#ff5e00', 'area outline is neon orange');
    assert.strictEqual(heritage.wfs.style.fillColor, '#ff9e3d', 'area fill is neon orange');
    assert.strictEqual(heritage.wfs.style.weight, 2);
    assert.strictEqual(heritage.wfs.style.fillOpacity, 0.32);
    ok('scheduled-monument areas are rendered in neon orange');

    /* Both monument point layers identify on click: the user reported the
       points were hard to hit, so the raster WMS layers answer
       GetFeatureInfo and open a popup on the nearest monument. */
    ['fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet'].forEach((id) => {
        const points = CONFIG.byId(id);
        assert.ok(points.identify, id + ' identifies on click');
        assert.ok(points.identify.fields.length >= 3, id + ' identifies with several fields');
        assert.strictEqual(points.identify.linkField, 'url');
        assert.ok(points.identify.linkLabel.en && points.identify.linkLabel.da,
            id + ' names the Fund og Fortidsminder link in both languages');
    });
    ok('both monument point layers are clickable WMS layers');

    const surface = CONFIG.byId('lidar_dhm_surface_hillshade');
    assert.strictEqual(surface.group, 'overlay');
    assert.strictEqual(surface.upstream, 'https://api.dataforsyningen.dk/dhm_DAF');
    assert.strictEqual(surface.layers, 'dhm_overflade_skyggekort');
    assert.ok(surface.url.indexOf('/api/geo/') === 0, 'token added server-side');
    assert.deepStrictEqual(surface.requiresCredentials, ['DATAFORSYNINGEN_TOKEN']);
    ok('surface hillshade: DHM overflade WMS through the token proxy');

    const witx = CONFIG.byId('historic-witx');
    assert.strictEqual(witx.permission.required, true);
    assert.ok(/permission/i.test(witx.permission.note));
    assert.ok(witx.url.indexOf('witx.dk') !== -1, 'the placeholder keeps the address it may not use yet');
    ok('the witx.dk tiles stay a documented, permission-gated placeholder');

    const text = read('js/danish-layers.config.js') + read('js/danish-layers.js');
    assert.ok(text.indexOf(TOKEN) === -1, 'the token never appears in a served file');
    assert.ok(!/token\s*[:=]\s*['"][A-Za-z0-9]{16,}['"]/.test(text), 'no token literal');
    assert.ok(!/password\s*[:=]\s*['"][^'"]+['"]/i.test(text), 'no password literal');
    assert.ok(!/token=[A-Za-z0-9]{8,}/.test(text), 'no token query parameter');
    ok('no credential anywhere in the client code');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. the registry mirror
 * ══════════════════════════════════════════════════════════════════════════ */
{
    const R = require('./js/layer-registry.js');
    assert.ok(R.GROUPS['danish-base'] && R.GROUPS['danish-base'].base === true, 'danish-base is a base group');
    assert.ok(R.GROUPS['danish-overlay'] && !R.GROUPS['danish-overlay'].base);
    ok('the registry has the danish-base (exclusive) and danish-overlay groups');

    WIRED.forEach((id) => {
        const layer = CONFIG.byId(id);
        const def = R.get('danish.' + id);
        assert.ok(def, 'danish.' + id + ' is in the catalogue');
        assert.strictEqual(def.url, layer.url, id + ': same endpoint as the config');
        assert.strictEqual(def.layer, layer.layers, id + ': same LAYERS value');
        assert.strictEqual(def.format, layer.format, id + ': same format');
        assert.strictEqual(def.version, layer.version, id + ': same version');
        assert.strictEqual(def.crs, layer.crs, id + ': same CRS');
        assert.strictEqual(def.group, layer.group === 'base' ? 'danish-base' : 'danish-overlay');
        if (RENDERED.indexOf(id) !== -1) {
            assert.strictEqual(def.group, 'danish-overlay', id + ': rendered Danish layers are overlays in the registry too');
            assert.strictEqual(def.ui.slider, 'danishOpacity_' + id, id + ': the registry knows its opacity slider');
            assert.strictEqual(def.ui.toggle, 'danishToggle_' + id, id + ': the registry knows its on/off switch');
        }
        assert.ok(def.title.en && def.title.da, id + ': both titles mirrored');
        assert.strictEqual(def.attribution, layer.attribution, id + ': attribution mirrored');
        assert.strictEqual(def.licence, layer.licence, id + ': licence mirrored');
        if (def.kind === 'wms') {
            assert.strictEqual(def.guard, false, id + ': the availability guard must not flip this row');
            assert.ok(def.selfGuarded && String(def.selfGuardedReason).length > 40,
                id + ': opting out of the guard is documented');
        }
    });
    assert.ok(R.get('danish.dtk25').upstream.indexOf('api.dataforsyningen.dk') !== -1,
        'the provider endpoint behind the proxy is recorded');
    assert.ok(R.get('danish.orto').upstream.indexOf('services.datafordeler.dk') !== -1);
    ok('every enabled Danish layer is mirrored with identical LAYERS/format/version/CRS + licence');

    const audit = read('tools/audit-wms-layers.mjs');
    assert.ok(audit.indexOf("r.guardPath === 'self'") !== -1, 'the audit knows the self-handled class');
    assert.ok(audit.indexOf('GUARD_OPTOUT_UNDOCUMENTED') !== -1,
        'an undocumented opt-out of the guard is an error, not a warning');
    ok('the offline audit covers the Danish layers and still fails on an undocumented opt-out');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. the proxy library
 * ══════════════════════════════════════════════════════════════════════════ */
async function testProxies() {
    const lib = await import('./backend/src/lib/danish-layers.mjs');

    /* EPSG:25832 reference values from PROJ (pyproj 3.7 / PROJ 9.5). */
    [
        [12.5683, 55.6761, 724351.93, 6175804.02, 'Copenhagen'],
        [9.4195, 55.7565, 526327.47, 6179058.91, 'Jelling'],
        [10.2039, 56.1629, 574766.39, 6224862.65, 'Aarhus'],
        [15.0, 55.1, 882613.76, 6122374.97, 'Bornholm']
    ].forEach(([lon, lat, e, n, name]) => {
        const [x, y] = lib.lonLatToEpsg25832(lon, lat);
        assert.ok(Math.abs(x - e) < 0.05, name + ' easting ' + x.toFixed(2) + ' vs PROJ ' + e);
        assert.ok(Math.abs(y - n) < 0.05, name + ' northing ' + y.toFixed(2) + ' vs PROJ ' + n);
    });
    const back = lib.epsg25832ToLonLat(532910.64, 6227491.94);
    assert.ok(Math.abs(back[0] - 9.530311) < 2e-5 && Math.abs(back[1] - 56.191249) < 2e-5,
        'inverse matches PROJ');
    ok('EPSG:25832 forward/inverse agree with PROJ to the centimetre over Denmark');

    const box = lib.bboxDegreesToEpsg25832([10.15, 56.10, 10.30, 56.22]);
    assert.ok(box[0] < box[2] && box[1] < box[3], 'a valid box');
    assert.ok(box[0] > 400000 && box[2] < 900000 && box[1] > 6000000, 'metres in the UTM zone of Denmark');
    ok('a view bbox becomes the EPSG:25832 box the service actually understands');

    const projected = lib.reprojectFeatureCollection({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [[[532910.64, 6227491.94], [532912.14, 6227487.15], [532910.64, 6227491.94]]]
            },
            properties: { anlaegstype: 'Rundhøj' }
        }]
    });
    const vertex = projected.features[0].geometry.coordinates[0][0];
    assert.ok(Math.abs(vertex[0] - 9.530311) < 2e-5, 'longitude in degrees');
    assert.ok(Math.abs(vertex[1] - 56.191249) < 2e-5, 'latitude in degrees');
    assert.strictEqual(projected.features[0].properties.anlaegstype, 'Rundhøj', 'properties survive');
    ok('GeoJSON geometries are handed to Leaflet in EPSG:4326');

    const calls = [];
    const realFetch = global.fetch;
    const pngTile = () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200, headers: { 'Content-Type': 'image/png' }
    });
    global.fetch = async (url, options) => {
        calls.push({ url: String(url), options: options || {} });
        return pngTile();
    };

    delete process.env.DATAFORSYNINGEN_TOKEN;
    let response = await lib.dtk25Response(new Request('https://x/api/geo/dk-dtk25?service=WMS&request=GetMap'));
    assert.strictEqual(response.status, 503, 'without the token the route returns service unavailable');
    let body = await response.json();
    assert.deepStrictEqual(body, { error: 'service_unavailable' }, 'the client receives no variable or layer details');
    ok('DTK25 missing credential → generic 503; variable details stay server-side');

    process.env.DATAFORSYNINGEN_TOKEN = 'server-side-token';
    response = await lib.dtk25Response(new Request(
        'https://x/api/geo/dk-dtk25?service=WMS&version=1.3.0&request=GetMap&LAYERS=dtk25_2023' +
        '&CRS=EPSG:3857&bbox=1133893,7588913,1137893,7592913&width=256&height=256&format=image/png' +
        '&token=someone-elses&username=steal&password=steal'));
    assert.strictEqual(response.status, 200, 'a valid request is proxied');
    assert.strictEqual(response.headers.get('Content-Type'), 'image/png');
    assert.ok(response.headers.get('Cache-Control').indexOf('max-age=604800') !== -1, 'the tile is cacheable');
    let upstream = calls[calls.length - 1];
    assert.ok(upstream.url.indexOf('https://api.dataforsyningen.dk/dtk_25_DAF?') === 0, 'a fixed upstream host');
    assert.ok(upstream.url.indexOf('token=server-side-token') !== -1, 'the token is present only on the server-to-provider URL');
    assert.ok(upstream.url.indexOf('token=server-side-token') !== -1, 'it travels as a server-side query parameter');
    assert.ok(upstream.url.indexOf('someone-elses') === -1, 'a caller cannot inject a token');
    assert.ok(upstream.url.indexOf('steal') === -1, 'a caller cannot inject credentials');
    assert.ok(/LAYERS=dtk25_2023/i.test(upstream.url), 'the LAYERS value comes from the config');
    ok('Dataforsyningen: token added server-side; caller-supplied credentials stripped');

    await lib.dtk25Response(new Request('https://x/api/geo/dk-dtk25?request=GetMap&LAYERS=some_other_layer'));
    const injected = decodeURIComponent(calls[calls.length - 1].url);
    assert.ok(/LAYERS=dtk25_2023/.test(injected), 'the config wins');
    assert.ok(injected.indexOf('some_other_layer') === -1, 'the upstream cannot be repointed from outside');
    response = await lib.dtk25Response(new Request('https://x/api/geo/dk-dtk25?request=DropTable'));
    assert.strictEqual(response.status, 400, 'only GetMap / GetCapabilities are forwarded');
    ok('DTK25: upstream and LAYERS are allow-listed, unsupported requests are refused');

    delete process.env.DATAFORDELER_USER;
    delete process.env.DATAFORDELER_USERNAME;
    delete process.env.DATAFORDELER_PASSWORD;
    response = await lib.ortoResponse(new Request('https://x/api/geo/dk-orto?request=GetMap'));
    assert.strictEqual(response.status, 503);
    body = await response.json();
    assert.deepStrictEqual(body, { error: 'service_unavailable' }, 'the generic response hides missing variable names');
    ok('orthophoto missing credentials → generic 503; variable details stay server-side');

    process.env.DATAFORDELER_USERNAME = 'service-user';
    process.env.DATAFORDELER_PASSWORD = 'service-pass';
    response = await lib.ortoResponse(new Request(
        'https://x/api/geo/dk-orto?service=WMS&version=1.3.0&request=GetMap&username=attacker&password=attacker'));
    assert.strictEqual(response.status, 200);
    const ortoUpstream = calls[calls.length - 1].url;
    assert.ok(ortoUpstream.indexOf('https://services.datafordeler.dk/GeoDanmarkOrto/orto_foraar/1.0.0/WMS?') === 0);
    assert.ok(ortoUpstream.indexOf('username=service-user') !== -1, 'the deployment user is used');
    assert.ok(ortoUpstream.indexOf('attacker') === -1, 'the caller cannot override it');
    assert.ok(/geodanmark_2025_12_5cm/.test(decodeURIComponent(ortoUpstream)), 'the year comes from the config');
    ok('orthophoto: service user added server-side, caller cannot override it');

    const geo = {
        type: 'FeatureCollection',
        totalFeatures: 14,
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::25832' } },
        features: [{
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [[[532910.64, 6227491.94], [532912.14, 6227487.15], [532910.64, 6227491.94]]]
            },
            properties: { anlaegstype: 'Rundhøj', frednr: '24105' }
        }]
    };
    global.fetch = async (url) => {
        calls.push({ url: String(url), options: {} });
        return new Response(JSON.stringify(geo), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    response = await lib.heritageResponse(new Request('https://x/api/geo/dk-heritage?bbox=9.40,55.74,9.44,55.77'));
    assert.strictEqual(response.status, 200);
    const heritageBody = await response.json();
    const heritageUpstream = decodeURIComponent(calls[calls.length - 1].url);
    assert.ok(heritageUpstream.indexOf('https://www.kulturarv.dk/ffgeoserver/public/wfs?') === 0,
        'the official agency service, never the witx mirror');
    assert.ok(heritageUpstream.indexOf('service=WFS') !== -1);
    assert.ok(/bbox=\d{5,}(\.\d+)?,\d{6,}(\.\d+)?/.test(heritageUpstream),
        'the bbox is sent in EPSG:25832 metres, not in degrees');
    assert.ok(heritageUpstream.indexOf(',EPSG:25832') !== -1);
    assert.ok(/maxFeatures=\d+/.test(heritageUpstream), 'a feature cap is always applied');
    assert.strictEqual(heritageBody.features[0].geometry.coordinates[0][0][0].toFixed(4), '9.5303',
        'the answer is reprojected to degrees');
    assert.strictEqual(heritageBody.features[0].properties.frednr, '24105');
    assert.strictEqual(heritageBody.totalFeatures, 14, 'the service total is passed on');
    ok('heritage WFS: asked in EPSG:25832, answered in EPSG:4326 GeoJSON, capped');

    for (const [url, status, label] of [
        ['https://x/api/geo/dk-heritage', 400, 'no bbox'],
        ['https://x/api/geo/dk-heritage?bbox=1,2,3', 400, 'an incomplete bbox'],
        ['https://x/api/geo/dk-heritage?bbox=9,55,8,56', 400, 'an inverted bbox'],
        ['https://x/api/geo/dk-heritage?bbox=-100,-40,-90,-30', 400, 'a bbox outside Denmark'],
        ['https://x/api/geo/dk-heritage?bbox=10,55,12,56', 200, 'a Danish bbox']
    ]) {
        const result = await lib.heritageResponse(new Request(url));
        assert.strictEqual(result.status, status, label + ' → HTTP ' + status);
    }
    response = await lib.heritageResponse(new Request(
        'https://x/api/geo/dk-heritage?bbox=10,55,12,56&layer=premium.mitteleuropa'));
    assert.strictEqual(response.status, 400, 'only a configured WFS layer can be asked for');
    response = await lib.heritageResponse(new Request(
        'https://x/api/geo/dk-heritage?bbox=10,55,12,56&maxFeatures=99999'));
    assert.strictEqual(response.status, 200);
    assert.ok(/maxFeatures=400/.test(calls[calls.length - 1].url), 'the cap cannot be raised from outside');
    ok('heritage WFS: bbox validated, Denmark-only, layer allow-listed, cap enforced');

    global.fetch = realFetch;
    delete process.env.DATAFORSYNINGEN_TOKEN;
    delete process.env.DATAFORDELER_USER;
    delete process.env.DATAFORDELER_USERNAME;
    delete process.env.DATAFORDELER_PASSWORD;
    ok('all three routes exercised against a stubbed upstream (no network)');

    const toml = read('netlify.toml');
    ['/api/geo/dk-dtk25', '/api/geo/dk-orto', '/api/geo/dk-heritage'].forEach((route) => {
        assert.ok(toml.indexOf('from = "' + route + '"') !== -1, route + ' is routed in netlify.toml');
    });
    ['dk-dtk25', 'dk-orto', 'dk-heritage'].forEach((fn) => {
        assert.ok(fs.existsSync(path.join(__dirname, 'netlify/functions/' + fn + '.mjs')), fn + ' exists');
    });
    const backend = read('backend/src/routes/geoProxy.js');
    ['/geo/dk-dtk25', '/geo/dk-orto', '/geo/dk-heritage'].forEach((route) => {
        assert.ok(backend.indexOf("router.get('" + route + "'") !== -1, 'the Express mirror serves ' + route);
    });
    const env = read('backend/.env.example');
    assert.ok(env.indexOf('DATAFORDELER_USERNAME') !== -1 && env.indexOf('DATAFORDELER_PASSWORD') !== -1,
        'the variable names are documented for self-hosting');
    const devServer = read('tools/map3d-dev-server.mjs');
    assert.ok(devServer.indexOf('DANISH_ROUTES') !== -1, 'the local dev server serves the same routes');
    assert.ok(devServer.indexOf('DETECTLAB_DK_TOKEN') === -1,
        'the server never injects the credential into client HTML');
    ok('Netlify routes/functions, the Express mirror, the docs and the dev server are wired');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. the map module, in a stub DOM + Leaflet
 * ══════════════════════════════════════════════════════════════════════════ */
async function testMapModule() {
    const dom = buildDom();
    const map = buildMap();
    const leaflet = buildLeaflet(dom);

    const sandbox = {
        console: { warn() {}, log() {} },
        document: dom.document,
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: (fn) => { dom.timers.push(fn); return dom.timers.length; },
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        fetch: () => Promise.resolve(new Response('', { status: 503 })),
        Response, Request, AbortController: function () { this.abort = () => {}; },
        alert() {},
        L: leaflet,
        DANISH_LAYERS_CONFIG: CONFIG,
        _dlMap: map,
        _currentLang: () => 'en'
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('js/danish-layers.js'), sandbox, { filename: 'js/danish-layers.js' });
    const API = sandbox.DetectLabDanishLayers;
    assert.ok(API, 'the module exposes its API');
    assert.ok(sandbox.toggleDanishLayers && sandbox.setDanishBase && sandbox.showDanishInfo,
        'the inline handlers in index.html exist');

    /* Rendered rows, in panel order: the LiDAR mount first (it lives in the
       shared LiDAR accordion, after the global derivate row), then the
       three Denmark sections and their …SubLayers columns. */
    const groupBodyId = (group) => 'danish' + group.id.charAt(0).toUpperCase() + group.id.slice(1) + 'SubLayers';
    const rowIds = dom.childIds('danishLidarLayers').concat(
        CONFIG.panelGroups.filter((group) => !group.mount && group.id !== 'lidar')
            .flatMap((group) => dom.childIds(groupBodyId(group))));
    assert.deepStrictEqual(rowIds, RENDERED, 'exactly the panelGroups rows are rendered, once each, in order');
    assert.deepStrictEqual(dom.byId.danishSubLayers.children.map((child) => child.id),
        ['danishGroup_heritage', 'danishGroup_historical', 'danishGroup_orthophoto'],
        'the Denmark mount holds the three thematic sections and nothing else (no Base map section)');
    for (const group of CONFIG.panelGroups) {
        if (group.mount || group.id === 'lidar') {
            assert.deepStrictEqual(dom.childIds('danishLidarLayers'), group.layers,
                'the LiDAR mount contains exactly the requested sublayers in order');
            continue;
        }
        const wrap = dom.byId['danishGroup_' + group.id];
        assert.ok(wrap, group.id + ' has a section');
        assert.ok((wrap.attributes['class'] || '').indexOf('transp-layer-row') !== -1,
            group.id + ' is a Romania-style glass section row');
        assert.deepStrictEqual(dom.childIds(groupBodyId(group)), group.layers,
            group.id + ' contains exactly the requested sublayers in order');
        assert.ok(dom.byId['danishGroupToggle_' + group.id], group.id + ' has a master on/off switch');
        assert.strictEqual(dom.byId['danishGroupToggle_' + group.id].type, 'checkbox');
        assert.ok(dom.byId['danishGroupExpandBtn_' + group.id], group.id + ' has an expand chevron');
        assert.strictEqual(dom.byId[groupBodyId(group)].style.maxHeight, '0',
            group.id + ' starts collapsed, like the Romanian Historical Maps group');
    }

    /* Every rendered row has the shared Romania style: a glass sublayer
       row, the pill on/off switch (checkbox + track sibling in an
       .apm-toggle-switch label), the .pct badge next to the shared info
       button on the Opacity line, and a .transp-slider opacity slider.
       No radios, and no row without a slider. */
    RENDERED.forEach((id) => {
        const input = dom.byId['danishToggle_' + id];
        assert.ok(input, id + ' has an on/off switch');
        assert.strictEqual(input.type, 'checkbox', id + ' switch is a checkbox, not a radio');
        const toggleLabel = input.parentNode;
        assert.strictEqual(toggleLabel.attributes['class'], 'apm-toggle-switch',
            id + ' switch uses the shared pill toggle');
        assert.strictEqual(toggleLabel.children[0], input, id + ' input comes first in the switch');
        assert.strictEqual(toggleLabel.children[1].attributes['class'], 'apm-toggle-track',
            id + ' track immediately follows the input (checked CSS depends on it)');
        const slider = dom.byId['danishOpacity_' + id];
        assert.ok(slider, id + ' has an opacity slider');
        assert.strictEqual(slider.type, 'range');
        assert.ok((slider.attributes['class'] || '').indexOf('transp-slider') !== -1,
            id + ' slider uses the shared transp-slider style');
        assert.ok(dom.byId['danishPct_' + id], id + ' has a percentage badge');
        assert.strictEqual(dom.byId['danishPct_' + id].textContent, API.opacityOf(id) + '%');
        const row = dom.byId['danishRow_' + id];
        assert.ok((row.attributes['class'] || '').indexOf('dl-sublayer-row') !== -1,
            id + ' row carries the shared glass sublayer box');
        const opacityLine = row.children[1];
        assert.strictEqual(opacityLine.attributes['class'], 'transp-layer-label',
            id + ' opacity line uses the shared label row');
        assert.strictEqual(opacityLine.children[0].textContent, 'Opacity');
        assert.strictEqual(opacityLine.children[1].children[0].attributes['class'], 'layer-info-btn',
            id + ' info button uses the shared layer-info-btn');
        assert.strictEqual(row.children[2], slider, id + ' slider sits under its Opacity line');
    });
    ['lidar_hillshade_historik', 'lidar_quickdhm_exaggerated', 'lidar_dhm_terrain_hillshade'].forEach((id) => {
        assert.equal(dom.byId['danishOpacity_' + id].value, '100', id + ' slider starts at 100%');
        assert.ok((dom.byId['danishRow_' + id].attributes['class'] || '').indexOf('lidar-country-row') !== -1,
            id + ' is a country LiDAR row like its neighbours in the accordion');
    });
    assert.equal(dom.byId['danishOpacity_dtk25'].value, '100', 'DTK25 slider starts at 100%');

    /* The removed panel furniture stays removed: no Base map rows, no
       spring-orthophoto dropdown, no Danish OSM row. The catalogue entries
       still exist for the proxy/registry — they just have no row. */
    ['orto', 'osm', 'orto_foraar_2016', 'orto_foraar_2025'].forEach((id) => {
        assert.ok(!dom.byId['danishToggle_' + id], id + ' has no panel switch');
        assert.ok(!dom.byId['danishRow_' + id], id + ' has no panel row');
        assert.strictEqual(API.isActive(id), false, id + ' is not restored without a row');
    });
    assert.ok(!dom.byId['danishSpringOrthoYear'], 'the spring-orthophoto year dropdown is gone');
    assert.ok(!dom.byId['danishSpringOrthoStatus'], 'and so is its status line');
    ok('rows, pill switches, sliders and sections are generated from the config; removed rows stay removed');

    /* The info panel takes plain text: it links the URLs it finds and prints the
       description through textContent, so markup or newlines would show up
       verbatim. Each row's (i) button goes through the same function. */
    const info = [];
    sandbox.showLayerInfo = (name, attribution, description) => info.push({ name, attribution, description });
    API.showInfo(CONFIG.byId('dtk25'));
    API.showInfo(CONFIG.byId('fortidsminder'));
    API.showInfo(CONFIG.byId('historic-witx'));
    assert.strictEqual(info[0].name, 'Denmark · DTK25 topographic map (1:25,000)',
        'the title is translated for the panel');
    assert.ok(!/<[a-z]/i.test(info.map((i) => i.attribution + i.description).join(' ')),
        'no markup is passed to a renderer that prints text');
    assert.ok(!/\n/.test(info.map((i) => i.description).join(' ')),
        'and no newline that textContent would collapse');
    assert.strictEqual((info[0].attribution.match(/CC BY 4\.0/g) || []).length, 1,
        'the licence is named once, not twice');
    assert.ok(info[0].attribution.indexOf('https://creativecommons.org/licenses/by/4.0/') !== -1,
        'the licence URL is there for the renderer to link');
    assert.ok(/server-side credentials required/.test(info[0].description),
        'the info explains server credentials without exposing variable names');
    assert.ok(!/DATAFORSYNINGEN_TOKEN|DATAFORDELER_USERNAME|DATAFORDELER_PASSWORD/.test(info[0].description),
        'the visitor-facing info contains no variable names');
    assert.ok(/zoom 13/.test(info[1].description) && /CC0 1\.0/.test(info[1].attribution),
        'the heritage row states its own zoom gate and licence');
    assert.ok(/disabled/.test(info[2].description) && /permission required/.test(info[2].description),
        'the disabled WITX placeholder explains why it is disabled');
    ok('the per-row info panel gets plain, single-paragraph text');

    /* The one default-on layer is switched on at start and probed once; the
     * stub answers 503, so DTK25 shows a generic missing-configuration
     * notice in its own row and stays off. It is an overlay now, so there
     * is no OSM takeover: the app's own basemap simply shows through. */
    await settle();
    assert.ok(/not configured on the server/.test(dom.byId['danishStatus_dtk25'].textContent),
        'the row gives a generic server-configuration notice');
    assert.ok(!/DATAFORSYNINGEN_TOKEN|DATAFORDELER_USERNAME|DATAFORDELER_PASSWORD/.test(dom.byId['danishStatus_dtk25'].textContent),
        'the row does not expose environment variable names');
    assert.ok(dom.byId['danishGroupNotice'].textContent.length > 0, 'the group says what happened');
    assert.strictEqual(API.isActive('dtk25'), false, 'the unconfigured overlay does not appear active');
    assert.strictEqual(API.isActive('osm'), false, 'no OSM base takes over — that row is gone');
    assert.ok(!leaflet.calls.tileLayer.some((c) => c.url.indexOf('tile.openstreetmap.org') !== -1),
        'and no XYZ fallback layer was built');
    ok('DTK25 generic 503 status explains the issue; the overlay simply stays off');

    /* The three requested LiDAR layers are lazy and report missing credentials generically. */
    assert.strictEqual(leaflet.calls.tileLayerWms.length, 0, 'no WMS tile layer is built before an overlay is activated');
    API.activate('lidar_hillshade_historik');
    await settle();
    assert.ok(/not configured on the server/.test(dom.byId['danishStatus_lidar_hillshade_historik'].textContent),
        'the LiDAR row gives a generic configuration notice');
    assert.ok(!/DATAFORSYNINGEN_TOKEN|DATAFORDELER_USERNAME|DATAFORDELER_PASSWORD/.test(dom.byId['danishStatus_lidar_hillshade_historik'].textContent),
        'the LiDAR row does not expose environment variable names');
    assert.strictEqual(API.isActive('lidar_hillshade_historik'), false, 'unconfigured LiDAR does not silently appear active');
    ok('LiDAR rows are lazy and show only generic credential status');

    /* A public overlay is built on demand, with the documented request format. */
    API.activate('naturtyper');
    const nature = leaflet.calls.tileLayerWms[0];
    assert.ok(nature && nature.url.indexOf('miljoeportal.dk') !== -1, 'the overlay was built from its own URL');
    assert.strictEqual(nature.options.layers, 'dai:bes_naturtyper');
    assert.strictEqual(nature.options.uppercase, true, 'uppercase KVP (WMS 1.3.0)');
    assert.strictEqual(nature.options.tiled, 'TRUE', 'TILED=TRUE is serialized exactly as required');
    assert.strictEqual(nature.options.transparent, 'TRUE', 'TRANSPARENT=TRUE is serialized exactly as required');
    assert.strictEqual(nature.options.format, 'image/png');
    assert.ok(nature.options.crs === undefined && nature.options.srs === undefined,
        'no CRS option → Leaflet sends the map CRS, EPSG:3857');
    assert.ok(/^pane_danish_/.test(nature.options.pane), 'it paints in the Danish raster pane');
    assert.ok(/miljoeportal/.test(nature.options.attribution), 'attribution travels with the layer');
    assert.ok(nature.options.minZoom >= 6, 'a sensible zoom range');
    ok('a public overlay is built with the documented request format and its attribution');

    /* Opacity slider → live layer. */
    API.setOpacity('naturtyper', 40);
    assert.strictEqual(API.opacityOf('naturtyper'), 40);
    assert.strictEqual(leaflet.calls.opacity[leaflet.calls.opacity.length - 1], 0.4);
    dom.byId['danishOpacity_naturtyper'].value = '15';
    dom.byId['danishOpacity_naturtyper'].dispatch('input');
    assert.strictEqual(API.opacityOf('naturtyper'), 15, 'the slider itself drives the layer');
    ok('the opacity slider sets the layer opacity (40% → 0.4, then 15% by hand)');

    /* A deployment with the token: the probe answers with the capabilities
     * document and DTK25 draws — through the deployment's own route, never
     * with a key in the browser — as an independent overlay in the raster
     * pane, with a working opacity slider and a switch that turns it off. */
    sandbox.fetch = () => Promise.resolve(new Response('<WMS_Capabilities/>', {
        status: 200, headers: { 'Content-Type': 'text/xml' }
    }));
    delete API.state.guard.dtk25;
    API.activate('dtk25');
    await settle();
    const proxied = leaflet.calls.tileLayerWms.filter((c) => c.url.indexOf('dk-dtk25') !== -1).pop();
    assert.ok(proxied, 'DTK25 is built once the credential is configured');
    assert.strictEqual(proxied.options.uppercase, true, 'the documented uppercase request format');
    assert.ok(proxied.options.layers.indexOf('dtk25') === 0, 'the LAYERS value comes from the config');
    assert.strictEqual(API.modeOf('dtk25'), 'proxy', 'it goes through the deployment');
    assert.strictEqual(proxied.options.pane, 'pane_danish_raster', 'DTK25 paints as an overlay, not a base map');
    assert.strictEqual(API.isActive('dtk25'), true);
    assert.strictEqual(API.isActive('naturtyper'), true, 'the other overlay stayed on — overlays combine freely');
    assert.strictEqual(API.selectedBase(), 'dtk25', 'selectedBase() reports the last activation (name kept for API callers)');
    dom.byId['danishOpacity_dtk25'].value = '55';
    dom.byId['danishOpacity_dtk25'].dispatch('input');
    assert.strictEqual(API.opacityOf('dtk25'), 55, 'the former base map has a working opacity slider');
    assert.strictEqual(leaflet.calls.opacity[leaflet.calls.opacity.length - 1], 0.55);
    assert.strictEqual(dom.byId['danishPct_dtk25'].textContent, '55%');
    const dtkToggle = dom.byId['danishToggle_dtk25'];
    dtkToggle.checked = false;
    dtkToggle.dispatch('change');
    assert.strictEqual(API.isActive('dtk25'), false, 'the pill switch turns DTK25 off again');
    assert.strictEqual(API.isActive('naturtyper'), true, 'switching one overlay off leaves the others alone');
    dtkToggle.checked = true;
    dtkToggle.dispatch('change');
    await settle();
    assert.strictEqual(API.isActive('dtk25'), true, 'and back on');
    ok('former base maps are independent overlays with a working switch and slider');

    /* A client-injected token must never enable direct provider requests. */
    sandbox.DETECTLAB_DK_TOKEN = 'local-only-token';
    sandbox.fetch = () => Promise.resolve(new Response('', { status: 404 }));
    delete API.state.guard.dtk25;
    API.activate('dtk25');
    await settle();
    assert.ok(!leaflet.calls.tileLayerWms.some((c) => c.url.indexOf('api.dataforsyningen.dk') !== -1),
        'the browser never falls back to a token-bearing provider URL');
    assert.strictEqual(API.isActive('dtk25'), false, 'a missing proxy leaves the protected layer off');
    ok('no client-side Dataforsyningen token fallback is permitted');

    /* A section's master switch and chevron (Romania-style sections):
       expanding unfolds the sublayer column; the master turns the whole
       section on and off and reflects partial states as indeterminate. */
    sandbox.fetch = () => Promise.resolve(new Response('<WMS_Capabilities/>', {
        status: 200, headers: { 'Content-Type': 'text/xml' }
    }));
    const heritageBody = dom.byId['danishHeritageSubLayers'];
    assert.strictEqual(heritageBody.style.maxHeight, '0', 'Heritage starts collapsed');
    dom.byId['danishGroupExpandBtn_heritage'].dispatch('click');
    assert.strictEqual(heritageBody.style.maxHeight, '6000px', 'the chevron expands the section');
    assert.strictEqual(dom.byId['danishGroupExpandBtn_heritage'].getAttribute('aria-expanded'), 'true');
    assert.strictEqual(API.isActive('naturtyper'), true, 'naturtyper is already on');
    const heritageMaster = dom.byId['danishGroupToggle_heritage'];
    assert.strictEqual(heritageMaster.checked, false, 'the master is off while only some layers are on');
    assert.strictEqual(heritageMaster.indeterminate, true, 'and indeterminate for the partial state');
    heritageMaster.checked = false;
    heritageMaster.dispatch('change');
    assert.strictEqual(API.isActive('naturtyper'), false, 'the master switches the whole section off');
    heritageMaster.checked = true;
    heritageMaster.dispatch('change');
    await settle();
    assert.ok(['naturtyper', 'fortidsminder', 'fortidsminder_punkt_ikkefredet', 'fortidsminder_punkt_fredet']
        .every((id) => API.isActive(id)), 'the master switches every Heritage layer on');
    assert.strictEqual(heritageMaster.checked, true, 'and reads checked once all of them are on');
    heritageMaster.checked = false;
    heritageMaster.dispatch('change');
    API.activate('naturtyper');
    ok('section chevron + master switch unfold and toggle the whole group');

    delete API.state.guard.lidar_quickdhm_exaggerated;
    API.activate('lidar_quickdhm_exaggerated');
    await settle();
    const quickDhm = leaflet.calls.tileLayerWms.filter((call) => call.url.indexOf('layer=lidar_quickdhm_exaggerated') !== -1).pop();
    assert.ok(quickDhm, 'an enabled LiDAR overlay is actually created and added after its proxy probe');
    assert.strictEqual(quickDhm.options.layers, 'quickDHM_skyggekort_terraen_overdrevet');
    assert.strictEqual(API.isActive('lidar_quickdhm_exaggerated'), true);
    ok('configured LiDAR overlay builds the exact layer through the same-origin proxy');

    /* The guard replaces L.tileLayer.wms; a Danish row that went through it
     * could have its switch flipped under the module's feet. Every WMS layer
     * this module builds must therefore come from the class instead, and must
     * carry the opt-out flag the guard's map hook looks for. */
    const viaFactory = leaflet.calls.tileLayerWms.filter((c) => c.via !== 'class');
    assert.deepStrictEqual(viaFactory, [], 'no Danish WMS layer is built through the guard-wrapped factory');
    assert.ok(API.isActive('naturtyper'));
    const natureLayer = map._layers.filter((l) => l && l.options && l.options.layers === 'dai:bes_naturtyper').pop();
    assert.ok(natureLayer && natureLayer._detectlabNoGuard === true,
        'each row opts out of the guard: the module owns its status line');
    ok('WMS layers bypass the guard factory and declare the opt-out');

    /* The heritage overlay uses the WFS path: minZoom gate, then a capped query. */
    API.activate('fortidsminder');
    assert.strictEqual(leaflet.calls.geoJSON.length, 1, 'one GeoJSON group for the heritage layer');
    assert.ok(dom.byId['danishStatus_fortidsminder'].textContent.length > 0,
        'the row reports state (zoom hint or feature count)');
    ok('the heritage overlay is a styled GeoJSON group with its own status line');

    /* The monument POINT layers are clickable: GetFeatureInfo answers on a
       map click and a popup opens on the nearest monument. First the
       candidates and the request shape. */
    ['fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet'].forEach((id) => {
        API.activate(id);
    });
    assert.deepStrictEqual(API._test.identifyLayers().map((layer) => layer.id),
        ['fortidsminder_punkt_fredet', 'fortidsminder_punkt_ikkefredet'],
        'the activated monument layers are the click candidates');
    const clickLatLng = [56.15, 10.2];
    const infoUrl = API._test.identifyUrl(CONFIG.byId('fortidsminder_punkt_fredet'), map, clickLatLng);
    assert.ok(infoUrl.indexOf('SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo') !== -1,
        'a WMS 1.1.1 GetFeatureInfo request');
    assert.ok(infoUrl.indexOf('LAYERS=fundogfortidsminder_punkt_fredet') !== -1 &&
        infoUrl.indexOf('QUERY_LAYERS=fundogfortidsminder_punkt_fredet') !== -1,
        'the service layer is asked about');
    assert.ok(infoUrl.indexOf('SRS=EPSG%3A4326') !== -1, 'the answer comes in degrees');
    assert.ok(infoUrl.indexOf('BBOX=10.15,56.1,10.3,56.22') !== -1, 'the bbox is the map bounds');
    assert.ok(infoUrl.indexOf('WIDTH=800&HEIGHT=600') !== -1, 'the viewport size is sent');
    assert.ok(infoUrl.indexOf('X=1000&Y=1400') !== -1, 'X/Y are pixel offsets from the north-west corner');
    assert.ok(infoUrl.indexOf('INFO_FORMAT=application%2Fjson') !== -1, 'a JSON answer is requested');
    assert.ok(infoUrl.indexOf('FEATURE_COUNT=10') !== -1);
    ok('a click on an activated monument issues a correct GetFeatureInfo');

    /* The JSON answer opens a popup on the nearest monument — the configured
       fields, the extra properties, and the Fund og Fortidsminder link. */
    sandbox.fetch = () => Promise.resolve(new Response(JSON.stringify({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [10.2, 56.15] },
            properties: {
                anlaegstype: 'runehus', datering: 'Vikingetiden', frednr: '1234', stednr: '5678',
                url: 'https://www.kulturarv.dk/kid/vis.do?kid=1234'
            }
        }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    API._test.identifyOnClick({ latlng: clickLatLng });
    await settle();
    assert.strictEqual(leaflet.calls.popups.length, 1, 'one popup opens');
    assert.strictEqual(leaflet.calls.popups[0].latlng.join(','), '56.15,10.2',
        'the popup anchors on the monument, not on the click point');
    const popupHtml = leaflet.calls.popups[0].content;
    assert.ok(popupHtml.indexOf('runehus') !== -1, 'the type is shown');
    assert.ok(popupHtml.indexOf('Vikingetiden') !== -1, 'the dating is shown');
    assert.ok(popupHtml.indexOf('Åbn i Fund og Fortidsminder') !== -1 ||
        popupHtml.indexOf('Open in Fund og Fortidsminder') !== -1, 'the link is named in both languages');
    assert.ok(popupHtml.indexOf('https://www.kulturarv.dk/kid/vis.do') !== -1, 'the monument page is linked');
    ok('a GetFeatureInfo answer opens a popup with the monument details');

    /* No feature under the cursor: no popup, and the click does not break. */
    sandbox.fetch = () => Promise.resolve(new Response(JSON.stringify({
        type: 'FeatureCollection', features: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    API._test.identifyOnClick({ latlng: clickLatLng });
    await settle();
    assert.strictEqual(leaflet.calls.popups.length, 1, 'an empty answer leaves the popup closed');
    ok('an empty GetFeatureInfo answer opens nothing');

    /* The cross-origin JSON answer can be CORS-blocked: the request is then
       asked as HTML and rendered in a sandboxed iframe, so the user still
       sees the monument record (the Albania pattern). Both point layers are
       active, so the iframe asks the topmost candidate about its layer. */
    sandbox.fetch = () => Promise.reject(new Error('CORS'));
    API._test.identifyOnClick({ latlng: clickLatLng });
    await settle();
    assert.strictEqual(leaflet.calls.popups.length, 2, 'the fallback opens a second popup');
    const iframeHtml = leaflet.calls.popups[1].content;
    assert.ok(iframeHtml.indexOf('<iframe') !== -1, 'the fallback is a sandboxed iframe');
    assert.ok(iframeHtml.indexOf('INFO_FORMAT=text%2Fhtml') !== -1, 'the iframe asks for HTML');
    assert.ok(iframeHtml.indexOf('LAYERS=fundogfortidsminder_punkt_ikkefredet') !== -1,
        'the topmost candidate layer is asked about');
    assert.ok(iframeHtml.indexOf('sandbox') !== -1, 'the iframe is sandboxed');
    ok('a CORS-blocked answer falls back to a sandboxed HTML iframe');

    /* The topmost candidate wins: with both point layers active the click
       identifies on the layer switched on last. */
    API.deactivate('fortidsminder_punkt_fredet');
    assert.deepStrictEqual(API._test.identifyLayers().map((layer) => layer.id),
        ['fortidsminder_punkt_ikkefredet'], 'deactivating drops the layer from the candidates');
    ok('click candidates follow the activation state');

    /* Country filter: visible in Denmark only. The requested free groups hide
     * with the Danish parent outside DK and all their subrows return for DK. */
    const requestedPanelIds = CONFIG.panelGroups.reduce((ids, group) => ids.concat(group.layers), []);
    API.filterForCountry('FR');
    assert.strictEqual(dom.byId['danishRow'].classList.contains('country-layer-unavailable'), true);
    assert.strictEqual(dom.byId['danishRow_dtk25'].classList.contains('country-layer-unavailable'), true);
    requestedPanelIds.forEach((id) => {
        assert.strictEqual(dom.byId['danishRow_' + id].classList.contains('country-layer-unavailable'), true,
            id + ' is hidden outside Denmark');
    });
    API.filterForCountry('DK');
    assert.strictEqual(dom.byId['danishRow'].classList.contains('country-layer-unavailable'), false);
    requestedPanelIds.forEach((id) => {
        assert.strictEqual(dom.byId['danishRow_' + id].classList.contains('country-layer-unavailable'), false,
            id + ' is available when Denmark is selected');
    });
    ok('the country filter keeps all requested free sublayers for Denmark and hides them elsewhere');

    /* The basemap control mirror. */
    const controlButtons = dom.byId['arcgisBasemapCtrl'].descendants
        .filter((n) => n.attributes && n.attributes['data-danish-basemap']);
    assert.deepStrictEqual(controlButtons.map((b) => b.attributes['data-danish-basemap']),
        [],
        'Danish bases stay in the layer panel, not in the ArcGIS basemap control');
    ok('the ArcGIS basemap control stays free of Danish layer buttons');

    /* Language: DA + EN strings, and the module follows a language change. */
    assert.strictEqual(API._test.tr(CONFIG.groupLabel), 'Denmark · Danish maps');
    sandbox._currentLang = () => 'da';
    API.refreshTexts();
    assert.strictEqual(sandbox.document.getElementById('danishGroupTitle').textContent,
        'Danmark · danske kort', 'the group title follows the language');
    assert.strictEqual(API._test.tr(CONFIG.byId('dtk25').title), 'Danmark · DTK25 topografisk kort (1:25 000)');
    ok('UI strings are DA + EN, and the group re-renders on a language change');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. the page wiring
 * ══════════════════════════════════════════════════════════════════════════ */
function testWiring() {
    const html = read('index.html');
    const css = read('css/styles.css');
    const sw = read('sw.js');
    const translations = read('js/translations.js');
    const mapApp = read('js/map-app.js');

    const danishGroupMarkup = html.match(/<div\b[^>]*\bid="danishRow"[^>]*>/);
    assert.ok(danishGroupMarkup, 'the panel has the Danish group row');
    assert.match(danishGroupMarkup[0], /\bdata-category="free"/,
        'the Denmark group appears in the Gratis / Free tab, not an unrecognized category');
    assert.ok(html.indexOf('id="danishSubLayers"') !== -1, '…and the container the rows are built into');
    assert.ok(html.indexOf('id="danishToggle"') === -1, 'no country master switch');
    assert.ok(html.indexOf('onclick="toggleDanishSubLayers()"') === -1, 'no country collapse button');
    assert.ok(html.indexOf('js/danish-layers.config.js?v=') <
        html.indexOf('js/layer-registry.js?v='),
        'the config loads before the registry that mirrors it');
    assert.ok(html.indexOf('js/danish-layers.js?v=') >
        html.indexOf('js/map-app.js?v='),
        'the module loads after the map module');
    ok('index.html: group row, container and both scripts in the right order');

    const enBlock = translations.slice(translations.indexOf('            en: {'), translations.indexOf('            ro: {'));
    const daBlock = translations.slice(translations.indexOf('            da: {'));
    assert.ok(enBlock.indexOf("danish_group_title: 'Denmark · Danish maps'") !== -1, 'EN title in the dictionary');
    assert.ok(daBlock.indexOf("danish_group_title: 'Danmark · danske kort'") !== -1, 'DA title in the dictionary');
    assert.ok(enBlock.indexOf('danish_group_info:') !== -1 && daBlock.indexOf('danish_group_info:') !== -1);
    assert.strictEqual(CONFIG.groupLabel.en, 'Denmark · Danish maps');
    assert.strictEqual(CONFIG.groupLabel.da, 'Danmark · danske kort');
    ok('the DA+EN strings live in the site’s own dictionary and match the config');

    assert.ok(mapApp.indexOf('DetectLabDanishLayers') !== -1,
        'map-app.js hands the country selection to the Danish rows');
    assert.ok(Number((sw.match(/const CACHE_NAME = 'detectlab-v(\d+)-/) || [])[1]) >= 212,
        'the service-worker cache moved on for the Danish layers');
    assert.ok(sw.indexOf("'js/danish-layers.js?v=") !== -1, 'the new scripts are precached');
    assert.ok(css.indexOf('.danish-layer-row') !== -1 && css.indexOf('.danish-basemap-btn') !== -1 && css.indexOf('.danish-year-select') !== -1,
        'the generated rows and the basemap buttons are styled');
    assert.ok(css.indexOf('focus-visible') !== -1, 'and keyboard focus stays visible');
    ok('map-app hook, service worker, stylesheet and keyboard focus are wired');

    /* ── the backend is deployed as its own app root ────────────────────────
     * Railway builds this repository with `backend/` as the root directory, so
     * the app lands at /app and a relative import that climbs out of it becomes
     * /netlify/… and kills the container at startup (ERR_MODULE_NOT_FOUND).
     * Every relative specifier under backend/ must therefore resolve to a file
     * that still lives inside backend/. */
    const fsMod = require('node:fs');
    const spawnSync = require('node:child_process').spawnSync;
    const pathMod = require('node:path');
    const BACKEND = pathMod.resolve('backend');
    const escapes = [];
    const backFiles = [];
    (function walk(dir) {
        fsMod.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
            const full = pathMod.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') return;
                walk(full);
            } else if (/\.(m|c)?js$/.test(entry.name)) {
                backFiles.push(full);
            }
        });
    })(BACKEND);
    assert.ok(backFiles.length > 10, 'the backend sources were scanned (' + backFiles.length + ' files)');
    const specRe = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g;
    backFiles.forEach((file) => {
        const src = fsMod.readFileSync(file, 'utf8');
        let m;
        while ((m = specRe.exec(src)) !== null) {
            const resolved = pathMod.resolve(pathMod.dirname(file), m[1]);
            if (resolved !== BACKEND && !resolved.startsWith(BACKEND + pathMod.sep)) {
                escapes.push(pathMod.relative(process.cwd(), file) + ' → ' + m[1]);
            }
        }
    });
    assert.deepStrictEqual(escapes, [],
        'no backend import may leave backend/ (its own deploy root): ' + escapes.join('; '));
    assert.ok(fsMod.existsSync('backend/src/lib/danish-layers.mjs'),
        'the shared Danish proxy library lives inside the backend app root');
    assert.ok(fsMod.existsSync('backend/src/lib/danish-layers.config.cjs'),
        'the layer config is mirrored there as a .cjs file (backend/ is „type\": \"module\"“, ' +
        'so a .js mirror would export nothing to require())');
    assert.ok(read('backend/src/routes/geoProxy.js').includes("from '../lib/danish-layers.mjs'"),
        'and the Express mirror imports it from there');
    const danishProxySource = read('backend/src/lib/danish-layers.mjs');
    assert.ok(danishProxySource.includes("import danishLayerConfig from './danish-layers.config.cjs';"),
        'the library statically imports its own config so the Netlify bundle includes it');
    assert.ok(!danishProxySource.includes("require(path.resolve(HERE, 'danish-layers.config.cjs'))"),
        'no runtime-only config lookup may reintroduce the production MODULE_NOT_FOUND failure');
    const sync = spawnSync(process.execPath, ['tools/sync-danish-config.mjs', '--check'], { encoding: 'utf8' });
    assert.strictEqual(sync.status, 0,
        'the mirrored config is in step with js/danish-layers.config.js (run: node tools/sync-danish-config.mjs)' +
        (sync.stdout || '') + (sync.stderr || ''));
    ok('the backend stays self-contained (its deploy root is backend/)');
}

/* ── a stub of just enough DOM / Leaflet for the module ───────────────────── */
function buildDom() {
    const byId = {};

    function makeElement(tag) {
        const element = {
            tagName: String(tag).toUpperCase(),
            children: [], attributes: {}, style: {}, className: '',
            textContent: '', checked: false, value: '', type: '',
            parentNode: null, listeners: {},
            appendChild(child) { child.parentNode = this; this.children.push(child); this.descendants.push(child); return child; },
            insertBefore(child) { child.parentNode = this; this.children.unshift(child); this.descendants.push(child); return child; },
            removeChild(child) {
                this.children = this.children.filter((c) => c !== child);
                this.descendants = this.descendants.filter((c) => c !== child);
                return child;
            },
            setAttribute(key, value) {
                this.attributes[key] = String(value);
                if (key === 'value') this.value = String(value);
                if (key === 'id') { this.id = String(value); byId[this.id] = this; }
                if (key === 'type') this.type = String(value);
            },
            getAttribute(key) { return this.attributes[key] === undefined ? null : this.attributes[key]; },
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            dispatch(type, payload) { (this.listeners[type] || []).forEach((fn) => fn(payload || {})); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            set innerHTML(value) { if (value === '') { this.children = []; this.descendants = []; } },
            get innerHTML() { return ''; },
            get lastChild() { return this.children[this.children.length - 1] || null; },
            get classList() {
                const self = this;
                return {
                    contains(name) { return self.className.split(' ').indexOf(name) !== -1; },
                    add(name) { if (!this.contains(name)) self.className = (self.className + ' ' + name).trim(); },
                    remove(name) { self.className = self.className.split(' ').filter((c) => c && c !== name).join(' '); },
                    toggle(name, on) {
                        if (on === undefined) on = !this.contains(name);
                        if (on) this.add(name); else this.remove(name);
                    }
                };
            }
        };
        element.descendants = [];
        return element;
    }

    /* The static markup index.html provides (at 375 px it is all present). */
    const staticIds = ['danishLidarLayers', 'danishRow', 'danishSubLayers', 'danishToggle', 'danishExpandBtn',
        'danishExpandIcon', 'danishGroupTitle', 'danishGroupNotice', 'arcgisBasemapCtrl', 'transpPanel'];
    staticIds.forEach((id) => {
        const element = makeElement(id === 'danishToggle' ? 'input' : 'div');
        element.id = id;
        byId[id] = element;
    });

    const document = {
        readyState: 'complete',
        documentElement: makeElement('html'),
        createElement: makeElement,
        getElementById: (id) => byId[id] || null,
        addEventListener() {},
        createTextNode: (text) => ({ textContent: text })
    };

    return {
        document, byId,
        timers: [],
        childIds(containerId) {
            return byId[containerId].children
                .map((child) => child.attributes['data-danish-row'])
                .filter(Boolean);
        }
    };
}

function buildLeaflet(dom) {
    const calls = { tileLayer: [], tileLayerWms: [], geoJSON: [], opacity: [], addLayer: [], removeLayer: [], popups: [] };
    function baseLayer(options) {
        return {
            options,
            _opacity: options && typeof options.opacity === 'number' ? options.opacity : 1,
            listeners: {},
            on(type, fn) { this.listeners[type] = fn; return this; },
            setOpacity(value) { this._opacity = value; calls.opacity.push(value); return this; },
            getOpacity() { return this._opacity; }
        };
    }
    /* Real Leaflet exposes TileLayer.WMS as a class and tileLayer.wms as a
       factory that wraps it. js/wms-health.js replaces that factory, so the
       Danish module must use the class; the stub records both paths and the
       suite asserts only the class one is taken. */
    function wmsLayer(url, options) {
        calls.tileLayerWms.push({ url, options, via: 'class' });
        return baseLayer(options);
    }
    const L = {
        calls,
        TileLayer: { WMS: wmsLayer },
        tileLayer(url, options) {
            calls.tileLayer.push({ url, options });
            return baseLayer(options);
        },
        geoJSON(data, options) {
            calls.geoJSON.push({ data, options });
            const group = baseLayer(options);
            group._layers = [];
            group.clearLayers = function () { this._layers = []; };
            group.addData = function (collection) { this._layers = (collection && collection.features) || []; };
            group.eachLayer = function (fn) { this._layers.forEach(fn); };
            return group;
        },
        latLngBounds() { return {}; },
        popup(options) {
            const popup = {
                options,
                latlng: null,
                content: null,
                setLatLng(latlng) { this.latlng = latlng; return this; },
                setContent(content) { this.content = content; return this; },
                openOn() {
                    calls.popups.push({ latlng: this.latlng, content: this.content, options });
                    return this;
                }
            };
            return popup;
        }
    };
    L.tileLayer.wms = function (url, options) {           /* guard-wrapped in production */
        calls.tileLayerWms.push({ url, options, via: 'factory' });
        return baseLayer(options);
    };
    return L;
}

function buildMap() {
    const panes = {};
    return {
        options: { crs: { code: 'EPSG:3857' } },
        attributionControl: { addAttribution() {}, removeAttribution() {} },
        _layers: [],
        getPane(name) { return panes[name] || null; },
        createPane(name) { panes[name] = { style: {} }; return panes[name]; },
        addLayer(layer) { this._layers.push(layer); return this; },
        hasLayer(layer) { return this._layers.indexOf(layer) !== -1; },
        removeLayer(layer) { this._layers = this._layers.filter((l) => l !== layer); return this; },
        on() { return this; },
        getZoom() { return 14; },
        getBounds() {
            return {
                getWest: () => 10.15, getSouth: () => 56.10, getEast: () => 10.30, getNorth: () => 56.22,
                getNorthWest: () => ({ lat: 56.22, lng: 10.15 })
            };
        },
        getSize() { return { x: 800, y: 600 }; },
        project(latlng, zoom) {
            let lat = latlng[0], lng = latlng[1];
            if (!Array.isArray(latlng)) { lat = latlng.lat; lng = latlng.lng; }
            /* Real Leaflet returns an L.Point: x/y plus distanceTo(). */
            return {
                x: (lng - 10.0) * 20000,
                y: (56.4 - lat) * 20000,
                distanceTo(other) {
                    return Math.sqrt(Math.pow(this.x - other.x, 2) + Math.pow(this.y - other.y, 2));
                }
            };
        },
        setView() { return this; }
    };
}

/* Let the stubbed promises (probe → fallback → syncUI) settle. */
function settle() {
    return new Promise((resolve) => setImmediate(resolve))
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(() => new Promise((resolve) => setImmediate(resolve)))
        .then(() => new Promise((resolve) => setImmediate(resolve)));
}

(async function main() {
    await testProxies();
    await testMapModule();
    testWiring();
    console.log('\n✅ Danish layers: ' + passed + ' checks passed.');
}().catch((error) => {
    console.error('\n❌ ' + (error && error.message));
    if (error && error.stack && process.env.DANISH_TEST_STACK) console.error(error.stack);
    process.exit(1);
}));
