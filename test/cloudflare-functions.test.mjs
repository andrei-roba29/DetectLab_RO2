import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { onRequest as asig } from '../functions/api/geo/asig-heritage.js';
import { onRequest as corona } from '../functions/api/corona/rasters.js';
import { onRequest as dkDhm } from '../functions/api/geo/dk-dhm.js';
import { onRequest as dkDtk25 } from '../functions/api/geo/dk-dtk25.js';
import { onRequest as dkOrto } from '../functions/api/geo/dk-orto.js';
import { onRequest as dkHeritage } from '../functions/api/geo/dk-heritage.js';
import { onRequest as finland } from '../functions/api/geo/finland.js';
import { onRequest as map3d } from '../functions/api/map3d/tile.js';
import { onRequest as seHojdmodell } from '../functions/api/geo/se-hojdmodell.js';
import { registry } from '../functions/_shared/map3d-tile.mjs';
import { map3dCountryTileUrl, moduleModes } from '../functions/_shared/map3d-country-urls.mjs';
import { refreshCoronaSnapshot, validateCoronaSnapshot } from '../functions/_shared/corona-snapshot.mjs';
import { onRequest as callbackHtml } from '../functions/google-auth-callback.html.js';
import { onRequest as callbackExtensionless } from '../functions/google-auth-callback.js';

const routes = [
  ['/api/corona/rasters', 'functions/api/corona/rasters.js', corona],
  ['/api/geo/se-hojdmodell', 'functions/api/geo/se-hojdmodell.js', seHojdmodell],
  ['/api/map3d/tile', 'functions/api/map3d/tile.js', map3d],
  ['/api/geo/dk-dhm', 'functions/api/geo/dk-dhm.js', dkDhm],
  ['/api/geo/dk-dtk25', 'functions/api/geo/dk-dtk25.js', dkDtk25],
  ['/api/geo/dk-orto', 'functions/api/geo/dk-orto.js', dkOrto],
  ['/api/geo/dk-heritage', 'functions/api/geo/dk-heritage.js', dkHeritage],
  ['/api/geo/finland', 'functions/api/geo/finland.js', finland],
  ['/api/geo/asig-heritage', 'functions/api/geo/asig-heritage.js', asig],
];

const call = (handler, path, method = 'GET', env = {}) => handler({
  request: new Request(`https://detectlab.test${path}`, { method }),
  env,
  waitUntil() {},
});

function pngFixture256() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, 256);
  new DataView(bytes.buffer).setUint32(20, 256);
  return bytes;
}

function jpegFixture256() {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x01, 0x00, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
    ...new Array(12).fill(0)
  ]);
}

test('Google callback .html and extensionless responses are no-store and protected from referrers/indexing', async () => {
  const required = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  for (const [handler, path] of [
    [callbackHtml, '/google-auth-callback.html'],
    [callbackExtensionless, '/google-auth-callback']
  ]) {
    const response = await handler({
      request: new Request(`https://detectlab.test${path}?code=one-time-code`),
      next: async () => new Response('<!doctype html><title>callback</title>', {
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=3600' }
      })
    });
    assert.equal(response.status, 200, path);
    for (const [name, value] of Object.entries(required)) assert.equal(response.headers.get(name), value, `${path} ${name}`);
    assert.match(await response.text(), /callback/);
  }
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(sw, /requestURL\.pathname === '\/google-auth-callback\.html'[\s\S]*requestURL\.pathname === '\/google-auth-callback'/);
});

test('all Pages filesystem routes, including both callback paths, exist', () => {
  for (const [route, file] of routes) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${route} -> ${file}`);
  }
  assert.ok(existsSync(new URL('../functions/google-auth-callback.html.js', import.meta.url)));
  assert.ok(existsSync(new URL('../functions/google-auth-callback.js', import.meta.url)));
});

test('unsupported methods are rejected by every route', async () => {
  for (const [route, , handler] of routes) {
    const response = await call(handler, route, 'POST');
    assert.equal(response.status, 405, route);
  }
});

test('OPTIONS is handled for applicable proxy routes without enabling broad CORS on credentials', async () => {
  for (const [route, , handler] of routes) {
    const response = await call(handler, route, 'OPTIONS');
    if (route === '/api/geo/asig-heritage') assert.equal(response.status, 405, route);
    else assert.equal(response.status, 204, route);
  }
  const protectedOptions = await call(dkDhm, '/api/geo/dk-dhm', 'OPTIONS');
  assert.equal(protectedOptions.headers.get('access-control-allow-origin'), null);
  assert.equal((await call(map3d, '/api/map3d/tile', 'OPTIONS')).headers.get('access-control-allow-origin'), '*');
});

test('HEAD responses omit bodies; ASIG retains its existing GET-only contract', async () => {
  const dhm = await call(dkDhm, '/api/geo/dk-dhm?request=GetTile', 'HEAD');
  assert.equal(dhm.status, 401);
  assert.equal(await dhm.text(), '');
  const asigHead = await call(asig, '/api/geo/asig-heritage', 'HEAD');
  assert.equal(asigHead.status, 405);
});

test('credentialed functions fail closed when required Cloudflare bindings are absent', async () => {
  assert.equal((await call(dkDhm, '/api/geo/dk-dhm?request=GetCapabilities')).status, 401);
  assert.equal((await call(seHojdmodell, '/api/geo/se-hojdmodell?request=GetCapabilities')).status, 401);
  const dtk = await call(dkDtk25, '/api/geo/dk-dtk25?request=GetMap');
  assert.equal(dtk.status, 503);
  const orto = await call(dkOrto, '/api/geo/dk-orto?request=GetMap');
  assert.equal(orto.status, 503);
  const fin = await call(finland, '/api/geo/finland?src=mml-hillshade-open&z=1&col=1&row=1');
  assert.equal(fin.status, 401);
});

test('invalid inputs fail before external fetches and proxy destinations remain constrained', async () => {
  assert.equal((await call(asig, '/api/geo/asig-heritage?layer=not-valid&bbox=19,39,20,40')).status, 400);
  assert.equal((await call(dkHeritage, '/api/geo/dk-heritage?bbox=0,0,1,1')).status, 400);
  assert.equal((await call(finland, '/api/geo/finland?src=not-a-source')).status, 400);
  assert.equal((await call(map3d, '/api/map3d/tile?layer=unknown&z=0&x=0&y=0')).status, 404);
  assert.equal((await call(map3d, '/api/map3d/tile?u=https%3A%2F%2Fexample.org%2Ftile.png')).status, 403);
  assert.equal((await call(map3d, '/api/map3d/tile?layer=unknown&z=99&x=0&y=0')).status, 404);
});

test('ASIG, Danish heritage and Finland WFS return valid GeoJSON responses', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ type: 'FeatureCollection', features: [] });
  t.after(() => { globalThis.fetch = originalFetch; });

  const asigResponse = await call(asig,
    '/api/geo/asig-heritage?layer=akzm%3Azonat_mbrojtura_081124&bbox=19,39,20,40');
  assert.equal(asigResponse.status, 200);
  assert.equal((await asigResponse.json()).type, 'FeatureCollection');

  const danishResponse = await call(dkHeritage, '/api/geo/dk-heritage?bbox=10,55,11,56');
  assert.equal(danishResponse.status, 200);
  assert.equal((await danishResponse.json()).type, 'FeatureCollection');

  const finlandResponse = await call(finland, '/api/geo/finland?src=museo-wfs&id=133&bbox=20,60,21,61');
  assert.equal(finlandResponse.status, 200);
  assert.equal((await finlandResponse.json()).type, 'FeatureCollection');
});

test('Dataforsyningen secret is sent only in its fixed upstream request and binary tile response is preserved', async (t) => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    captured = { url: new URL(input), headers: new Headers(init?.headers) };
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { 'Content-Type': 'image/jpeg' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call(dkDhm,
    '/api/geo/dk-dhm?request=GetTile&layer=dhm_terraen_skyggekort&format=image%2Fjpeg&tilematrixset=View1&tilematrix=1&tilecol=1&tilerow=1&token=attacker',
    'GET', { DATAFORSYNINGEN_TOKEN: 'synthetic-test-secret' });
  assert.equal(response.status, 200);
  assert.equal(captured.url.hostname, 'api.dataforsyningen.dk');
  assert.equal(captured.url.searchParams.has('token'), false);
  assert.equal(captured.headers.get('token'), 'synthetic-test-secret');
  assert.equal(response.headers.get('cache-control').includes('max-age=604800'), true);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [255, 216, 255, 217]);
  assert.equal(new TextDecoder().decode(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])).includes('synthetic-test-secret'), false);
});

test('Denmark WMS token and Datafordeler credentials stay server-side and retain CDN cache directives', async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    seen.push(new URL(input));
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const dtk = await call(dkDtk25, '/api/geo/dk-dtk25?request=GetMap&token=attacker', 'GET', {
    DATAFORSYNINGEN_TOKEN: 'synthetic-danish-token'
  });
  assert.equal(dtk.status, 200);
  assert.equal(seen[0].hostname, 'api.dataforsyningen.dk');
  assert.equal(seen[0].searchParams.get('token'), 'synthetic-danish-token');
  assert.equal(dtk.headers.has('Netlify-CDN-Cache-Control'), false);
  assert.match(dtk.headers.get('Cloudflare-CDN-Cache-Control'), /s-maxage=604800/);
  assert.equal((await dtk.clone().text()).includes('synthetic-danish-token'), false);

  const orto = await call(dkOrto, '/api/geo/dk-orto?request=GetMap&username=attacker&password=attacker', 'GET', {
    DATAFORDELER_USERNAME: 'synthetic-user', DATAFORDELER_PASSWORD: 'synthetic-password'
  });
  assert.equal(orto.status, 200);
  assert.equal(seen[1].hostname, 'services.datafordeler.dk');
  assert.equal(seen[1].searchParams.get('username'), 'synthetic-user');
  assert.equal(seen[1].searchParams.get('password'), 'synthetic-password');
  assert.equal((await orto.clone().text()).includes('synthetic-password'), false);
});

test('Swedish authenticated binary tile request keeps seven-day cache and does not echo credentials', async (t) => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (input, init) => {
    captured = { url: new URL(input), headers: new Headers(init?.headers) };
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call(seHojdmodell,
    '/api/geo/se-hojdmodell?request=GetMap&layers=terrangskuggning&format=image%2Fpng&width=256&height=256&bbox=10,55,11,56',
    'GET', { LANTMATERIET_WMS_TOKEN: 'synthetic-sweden-token' });
  assert.equal(response.status, 200);
  assert.equal(captured.url.hostname, 'maps.lantmateriet.se');
  assert.equal(captured.headers.get('authorization'), 'Bearer synthetic-sweden-token');
  assert.match(response.headers.get('cache-control'), /max-age=604800/);
  assert.equal((await response.clone().text()).includes('synthetic-sweden-token'), false);
});

test('Lantmäteriet URL override cannot turn the proxy into an arbitrary-host relay', async () => {
  const response = await call(seHojdmodell, '/api/geo/se-hojdmodell?request=GetCapabilities', 'GET', {
    LANTMATERIET_WMS_TOKEN: 'synthetic-test-token',
    LANTMATERIET_WMS_URL: 'https://attacker.example/proxy'
  });
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes('synthetic-test-token'), false);
});

test('Corona frontend retains its static/API URLs and generator validates before atomic publication', () => {
  const frontend = readFileSync(new URL('../js/corona-wms-layer.js', import.meta.url), 'utf8');
  assert.match(frontend, /data\/corona-europe-catalog\.json/);
  assert.match(frontend, /\/api\/corona\/rasters\?bbox=/);
  assert.match(frontend, /validateCatalogPayload\(json\)/);
  const generator = readFileSync(new URL('../tools/build-corona-europe-catalog.mjs', import.meta.url), 'utf8');
  assert.match(generator, /validateCatalogSnapshot\(payload\)/);
  assert.match(generator, /await fs\.rename\(temporaryPath, outputPath\)/);
  assert.match(generator, /CAST refresh skipped/);
});

test('Cloudflare snapshot refresh validates non-empty catalogue data and atomically preserves last-good snapshots', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'detectlab-corona-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'corona-europe-catalog.json');
  const catalogue = {
    'pass-fixture': {
      location: 'fixture pass', extent: [10, 40, 12, 42],
      images: [{ location: 'fixture frame', extent: [10, 40, 11, 41] }]
    }
  };
  const first = await refreshCoronaSnapshot({
    filePath,
    fetchCatalog: async () => catalogue,
    now: () => new Date('2026-11-12T00:00:00.000Z')
  });
  assert.deepEqual({ refreshed: first.refreshed, passes: first.passes, frames: first.frames },
    { refreshed: true, passes: 1, frames: 1 });
  const oldBytes = await readFile(filePath);
  const oldStat = await stat(filePath);
  assert.deepEqual(validateCoronaSnapshot(JSON.parse(oldBytes)), { passes: 1, frames: 1 });

  const failedRefresh = await refreshCoronaSnapshot({ filePath, fetchCatalog: async () => { throw new Error('TLS reset'); } });
  assert.equal(failedRefresh.retained, true);
  assert.deepEqual(await readFile(filePath), oldBytes);
  assert.equal((await stat(filePath)).size, oldStat.size);

  const emptyRefresh = await refreshCoronaSnapshot({ filePath, fetchCatalog: async () => ({}) });
  assert.equal(emptyRefresh.retained, true);
  assert.deepEqual(await readFile(filePath), oldBytes);

  const absentPath = path.join(dir, 'absent', 'snapshot.json');
  await assert.rejects(refreshCoronaSnapshot({ filePath: absentPath, fetchCatalog: async () => { throw new Error('upstream unavailable'); } }));
  assert.equal(existsSync(absentPath), false);
});

test('Corona endpoint falls back to the static snapshot when CAST is unavailable', async (t) => {
  const originalFetch = globalThis.fetch;
  const snapshot = {
    source: 'snapshot', generated: '2026-01-01T00:00:00.000Z', bbox: [-25, 34, 60, 72],
    blocks: [
      { id: 'inside', extent: [10, 40, 12, 42], images: [{ extent: [10, 40, 11, 41] }] },
      { id: 'outside', extent: [-100, -50, -90, -40], images: [] }
    ]
  };
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.hostname === 'corona.cast.uark.edu') throw new Error('simulated CAST outage');
    throw new Error(`unexpected fetch target: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call(corona, '/api/corona/rasters?bbox=9,39,13,43', 'GET', {
    ASSETS: { fetch: async (input) => new URL(input).pathname === '/data/corona-europe-catalog.json'
      ? Response.json(snapshot)
      : new Response('not found', { status: 404 }) }
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.blocks.map((block) => block.id), ['inside']);
  assert.equal(payload.passes, 1);
  assert.equal(payload.frames, 1);
});

test('3D registry tile response is binary and fetched only from the registered source', async (t) => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl;
  const png = new Uint8Array(64).fill(9);
  globalThis.fetch = async (input) => {
    upstreamUrl = new URL(input);
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call(map3d, '/api/map3d/tile?layer=base.imagery&z=0&x=0&y=0');
  assert.equal(response.status, 200);
  assert.equal(upstreamUrl.hostname, 'server.arcgisonline.com');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-map3d-proxy'), 'cloudflare-pages-function');
  assert.equal((await response.arrayBuffer()).byteLength, 64);
});

test('Cloudflare Map3D passes through all eight module-backed tile images with cache and credential boundaries', async (t) => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  const png = pngFixture256();
  const jpeg = jpegFixture256();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    seen.push({ url, headers });
    const isDenmark = url.hostname === 'api.dataforsyningen.dk';
    return new Response(isDenmark ? jpeg : png, {
      headers: { 'Content-Type': isDenmark ? 'image/jpeg' : 'image/png' }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const ids = [
    'lidar.nl-ahn', 'lidar.no-hoydedata', 'lidar.pl-nmt', 'lidar.es-mdt',
    'lidar.ch-swisstopo', 'lidar.uk-ea', 'lidar.dk-dhm', 'lidar.se-lantmateriet'
  ];
  const moduleLayers = registry.list().filter((def) => def.kind === 'dynamic' && def.builder?.module);
  assert.deepEqual(moduleLayers.map((def) => def.id).sort(), [...ids].sort());
  const env = {
    DATAFORSYNINGEN_TOKEN: 'test-only-denmark-secret',
    LANTMATERIET_WMS_TOKEN: 'test-only-sweden-secret'
  };

  for (const id of ids) {
    const mode = moduleModes(id)[0];
    const target = map3dCountryTileUrl(id, { z: 10, x: 533, y: 351, mode });
    const response = await call(map3d,
      `/api/map3d/tile?layer=${encodeURIComponent(id)}&z=10&x=533&y=351&m=${encodeURIComponent(mode)}`,
      'GET', env);
    assert.equal(response.status, 200, id);
    const expectedType = id === 'lidar.dk-dhm' ? 'image/jpeg' : 'image/png';
    assert.equal(response.headers.get('content-type'), expectedType, id);
    assert.equal(response.headers.get('x-map3d-proxy'), 'cloudflare-pages-function', id);
    assert.equal(response.headers.get('x-map3d-layer'), id, id);
    assert.equal(response.headers.get('cache-control').includes('max-age=604800') ||
      response.headers.get('cache-control').includes('max-age=86400'), true, id);
    const body = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(body, id === 'lidar.dk-dhm' ? jpeg : png, `${id} binary pass-through`);
    assert.equal(new TextDecoder().decode(body).includes('test-only-'), false, `${id} credential is not in body`);
    assert.equal(response.headers.get('authorization'), null, `${id} credential is not in response headers`);

    const upstream = seen.at(-1);
    if (target.startsWith('/api/')) {
      const expected = new URL(target, 'https://detectlab.test');
      assert.equal(upstream.url.pathname, id === 'lidar.dk-dhm'
        ? '/dhm_terraen_skyggekort_DAF' : '/hojdmodell/wms/v1.1', id);
      assert.deepEqual([...upstream.url.searchParams], [...expected.searchParams], `${id} internal route preserves original builder query parameters`);
      if (id === 'lidar.dk-dhm') {
        assert.equal(upstream.url.hostname, 'api.dataforsyningen.dk');
        assert.equal(upstream.headers.get('token'), env.DATAFORSYNINGEN_TOKEN);
        assert.equal(response.headers.get('x-map3d-cache'), 'delegated-function');
      } else {
        assert.equal(upstream.url.hostname, 'maps.lantmateriet.se');
        assert.equal(upstream.headers.get('authorization'), `Bearer ${env.LANTMATERIET_WMS_TOKEN}`);
        assert.equal(response.headers.get('x-map3d-cache'), 'delegated-function');
      }
    } else {
      assert.equal(upstream.url.href, target, `${id} exact registered upstream URL`);
      assert.equal(response.headers.get('x-map3d-cache'), 'upstream');
      assert.match(response.headers.get('Cloudflare-CDN-Cache-Control') || '', /s-maxage=604800/);
    }
  }
  assert.equal(seen.length, ids.length);
});

test('Map3D rejects unknown and invalid tile coordinates and returns explicit upstream errors, never transparent fallbacks', async (t) => {
  assert.equal((await call(map3d, '/api/map3d/tile?layer=unknown&z=0&x=0&y=0')).status, 404);
  assert.equal((await call(map3d, '/api/map3d/tile?layer=base.imagery&z=99&x=0&y=0')).status, 400);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('upstream failed', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = await call(map3d, '/api/map3d/tile?layer=base.imagery&z=1&x=1&y=1');
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('x-map3d-tile'), 'error');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal((await response.json()).error, 'upstream_http_error');
});
