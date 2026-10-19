'use strict';
const assert = require('node:assert/strict');
const CONFIG = require('./js/danish-layers.config.js');

(async () => {
    const lib = await import('./backend/src/lib/danish-layers.mjs');
    const tokenLayers = CONFIG.enabledLayers().filter((layer) => layer.auth === 'token');
    const basicLayers = CONFIG.enabledLayers().filter((layer) => layer.auth === 'basic');
    const lidar = [
        ['lidar_hillshade_historik', 'https://api.dataforsyningen.dk/dhm_historik_DAF', 'hillshade_1_6m'],
        ['lidar_quickdhm_exaggerated', 'https://api.dataforsyningen.dk/wms/dhm_temp', 'quickDHM_skyggekort_terraen_overdrevet'],
        ['lidar_dhm_terrain_hillshade', 'https://api.dataforsyningen.dk/dhm_DAF', 'dhm_terraen_skyggekort'],
        ['lidar_dhm_surface_hillshade', 'https://api.dataforsyningen.dk/dhm_DAF', 'dhm_overflade_skyggekort']
    ];
    assert.equal(lidar.length, 4);
    for (const [id, upstream, name] of lidar) {
        const layer = CONFIG.byId(id);
        assert.equal(layer.upstream, upstream, `${id} exact service path`);
        assert.equal(layer.layers, name, `${id} exact WMS layer name`);
        assert.equal(layer.group, 'overlay');
        assert.equal(layer.opacity, 1);
        assert.equal(layer.defaultOn, false);
        assert.ok(layer.minZoom <= 12 && layer.maxZoom >= 17, `${id} available throughout verification zoom range`);
        assert.equal(layer.crs, 'EPSG:3857');
        assert.equal(layer.format, 'image/png');
        assert.equal(layer.auth, 'token');
    }
    assert.equal(tokenLayers.length, 14, 'Dataforsyningen secured layers are all in one auth class');
    assert.equal(basicLayers.length, 11, 'Datafordeler spring photos (including retained legacy base) share basic auth');
    assert.equal(CONFIG.layers.filter((layer) => layer.selectorGroup === 'spring-orthophoto').length, 10);
    const mismatched = lib.appendLayerAuth({ auth: 'token', upstream: 'https://example.com/wms', requiresCredentials: ['DATAFORSYNINGEN_TOKEN'] }, new URLSearchParams());
    assert.equal(mismatched.error, 'credential_provider_mismatch', 'never send the Dataforsyningen token to another host');
    const insecure = lib.appendLayerAuth({ auth: 'basic', upstream: 'http://services.datafordeler.dk/WMS', requiresCredentials: [] }, new URLSearchParams());
    assert.equal(insecure.error, 'credential_provider_mismatch', 'credentials require HTTPS and the Datafordeler host');

    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url: new URL(String(url)), options });
        return new Response(Buffer.from([137, 80, 78, 71]), {
            status: 200, headers: { 'Content-Type': 'image/png' }
        });
    };
    const originalToken = process.env.DATAFORSYNINGEN_TOKEN;
    const originalUser = process.env.DATAFORDELER_USERNAME;
    const originalLegacyUser = process.env.DATAFORDELER_USER;
    const originalPassword = process.env.DATAFORDELER_PASSWORD;
    const originalAllowedOrigins = process.env.DANISH_PROXY_ALLOWED_ORIGINS;
    process.env.DATAFORSYNINGEN_TOKEN = 'unit-test-only-token';
    process.env.DATAFORDELER_USERNAME = 'unit-test-service-user';
    process.env.DATAFORDELER_PASSWORD = 'unit-test-service-password';
    delete process.env.DATAFORDELER_USER;

    const kvp = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: 'attacker-layer',
        STYLES: '', FORMAT: 'image/png', TRANSPARENT: 'TRUE', TILED: 'TRUE',
        WIDTH: '256', HEIGHT: '256', CRS: 'EPSG:3857', BBOX: '1133893,7588913,1137893,7592913',
        token: 'attacker-token', username: 'attacker-user', password: 'attacker-password'
    });
    for (const layer of tokenLayers) {
        const params = new URLSearchParams(kvp);
        params.set('layer', layer.id);
        const result = await lib.dtk25Response(new Request(`https://site.example/api/geo/dk-dtk25?${params}`));
        assert.equal(result.status, 200, `${layer.id} proxied status`);
        assert.equal(result.headers.get('Content-Type'), 'image/png');
        const upstream = calls.at(-1).url;
        assert.equal(`${upstream.origin}${upstream.pathname}`, layer.upstream, `${layer.id} fixed upstream`);
        assert.equal(upstream.searchParams.get('LAYERS'), layer.layers, `${layer.id} enforced LAYERS`);
        assert.equal(upstream.searchParams.get('CRS'), 'EPSG:3857');
        assert.equal(upstream.searchParams.get('VERSION'), '1.3.0');
        assert.equal(upstream.searchParams.get('token'), 'unit-test-only-token');
        assert.equal(upstream.searchParams.get('username'), null);
        assert.equal(upstream.searchParams.get('password'), null);
    }

    for (const layer of basicLayers) {
        const params = new URLSearchParams(kvp);
        params.set('layer', layer.id);
        const result = await lib.ortoResponse(new Request(`https://site.example/api/geo/dk-orto?${params}`));
        assert.equal(result.status, 200, `${layer.id} proxied status`);
        assert.equal(result.headers.get('Content-Type'), 'image/png');
        const upstream = calls.at(-1).url;
        assert.equal(`${upstream.origin}${upstream.pathname}`, layer.upstream, `${layer.id} fixed upstream`);
        assert.equal(upstream.searchParams.get('LAYERS'), layer.layers, `${layer.id} enforced LAYERS`);
        assert.equal(upstream.searchParams.get('username'), 'unit-test-service-user');
        assert.equal(upstream.searchParams.get('password'), 'unit-test-service-password');
        assert.equal(upstream.searchParams.get('token'), null);
    }

    // Capabilities XML is returned to the map's activation probe, not mistaken for a tile error.
    global.fetch = async () => new Response('<WMS_Capabilities><Layer><Name>hillshade_1_6m</Name></Layer></WMS_Capabilities>', {
        status: 200, headers: { 'Content-Type': 'text/xml' }
    });
    const capabilities = await lib.dtk25Response(new Request(
        'https://site.example/api/geo/dk-dtk25?layer=lidar_hillshade_historik&SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0'));
    assert.equal(capabilities.status, 200);
    assert.match(await capabilities.text(), /WMS_Capabilities/);

    // Missing credentials are a generic 503; the variable name is logged server-side only.
    const originalWarn = console.warn;
    const missingLogs = [];
    console.warn = (...args) => missingLogs.push(args);
    delete process.env.DATAFORSYNINGEN_TOKEN;
    const missingToken = await lib.dtk25Response(new Request(
        'https://site.example/api/geo/dk-dtk25?layer=lidar_hillshade_historik&REQUEST=GetMap'));
    console.warn = originalWarn;
    assert.equal(missingToken.status, 503);
    const missingBody = await missingToken.json();
    assert.deepEqual(missingBody, { error: 'service_unavailable' });
    assert.match(JSON.stringify(missingLogs), /DATAFORSYNINGEN_TOKEN/);
    assert.doesNotMatch(JSON.stringify(missingBody), /DATAFORSYNINGEN_TOKEN|unit-test-only-token/);

    process.env.DANISH_PROXY_ALLOWED_ORIGINS = 'https://detectlab.ro,https://www.detectlab.ro';
    global.fetch = async () => new Response(Buffer.from([137, 80, 78, 71]), {
        status: 200, headers: { 'Content-Type': 'image/png' }
    });
    const allowedOrigin = await lib.ortoResponse(new Request(
        'https://detectlab-backend-production.up.railway.app/api/geo/dk-orto?layer=orto_foraar_2025&REQUEST=GetMap',
        { headers: { Origin: 'https://detectlab.ro' } }));
    assert.equal(allowedOrigin.status, 200, 'the exact configured Netlify site origin is allowed through Railway');
    const noOrigin = await lib.ortoResponse(new Request(
        'https://detectlab-backend-production.up.railway.app/api/geo/dk-orto?layer=orto_foraar_2025&REQUEST=GetMap'));
    assert.equal(noOrigin.status, 200, 'same-origin image requests without Origin are accepted');
    const foreign = await lib.ortoResponse(new Request(
        'https://detectlab-backend-production.up.railway.app/api/geo/dk-orto?layer=orto_foraar_2025&REQUEST=GetMap',
        { headers: { Origin: 'https://attacker.example' } }));
    assert.equal(foreign.status, 403, 'unlisted origins are rejected');

    if (originalToken === undefined) delete process.env.DATAFORSYNINGEN_TOKEN; else process.env.DATAFORSYNINGEN_TOKEN = originalToken;
    if (originalUser === undefined) delete process.env.DATAFORDELER_USERNAME; else process.env.DATAFORDELER_USERNAME = originalUser;
    if (originalLegacyUser === undefined) delete process.env.DATAFORDELER_USER; else process.env.DATAFORDELER_USER = originalLegacyUser;
    if (originalPassword === undefined) delete process.env.DATAFORDELER_PASSWORD; else process.env.DATAFORDELER_PASSWORD = originalPassword;
    if (originalAllowedOrigins === undefined) delete process.env.DANISH_PROXY_ALLOWED_ORIGINS; else process.env.DANISH_PROXY_ALLOWED_ORIGINS = originalAllowedOrigins;
    global.fetch = originalFetch;

    console.log(`Danish WMS proxy checks passed: ${tokenLayers.length} token layers, ${basicLayers.length} basic-auth layers, 4 LiDAR definitions.`);
    console.log('Note: upstream fetch is stubbed here; this is not a provider HTTP 200 or visual-render test.');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
