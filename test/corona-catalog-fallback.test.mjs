import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildStaticCatalog, validateCatalogSnapshot } from '../tools/build-corona-europe-catalog.mjs';

const CATALOG_URL = 'data/corona-europe-catalog.json';
const API_URL = '/api/corona/rasters?bbox=-25,34,60,72';
const BBOX = [-25, 34, 60, 72];
const ring = [[20, 45], [22, 45], [22, 47], [20, 47], [20, 45]];
const coronaFrontend = await fs.readFile(new URL('../js/corona-wms-layer.js', import.meta.url), 'utf8');

function payload() {
  return {
    source: 'fixture', generated: '2026-11-12T00:00:00.000Z', bbox: BBOX,
    passes: 1, frames: 1,
    blocks: [{
      id: 'pass-1', location: 'pass-1', label: 'pass 1', extent: [20, 45, 22, 47], rings: [ring],
      images: [{ location: 'frame-1', label: 'frame 1', extent: [20, 45, 21, 46], rings: [ring] }]
    }]
  };
}

function rawCastCatalog() {
  const polygon = JSON.stringify({ type: 'Polygon', coordinates: [ring] });
  return {
    'pass-1': {
      location: 'pass-1', extent: { minx: 20, miny: 45, maxx: 22, maxy: 47 }, polygon,
      images: [{ location: 'frame-1', extent: { minx: 20, miny: 45, maxx: 21, maxy: 46 }, polygon }]
    }
  };
}

function frontendSandbox(fetchImpl, { withDocument = false } = {}) {
  const notices = [];
  const document = withDocument ? {
    body: {
      appendChild(element) { element.parentNode = this; notices.push(element); },
      removeChild(element) { element.parentNode = null; }
    },
    createElement() {
      const attributes = {};
      return {
        style: {},
        setAttribute(name, value) { attributes[name] = value; },
        getAttribute(name) { return attributes[name]; }
      };
    },
    getElementById(id) { return notices.find((element) => element.id === id && element.parentNode) || null; }
  } : undefined;
  const sandbox = {
    console: { info() {}, warn() {}, error() {} },
    L: { TileLayer: { WMS: { extend: (definition) => definition } }, extend: Object.assign },
    fetch: fetchImpl,
    setTimeout: (callback, delay) => ({ callback, delay }),
    clearTimeout() {},
    document
  };
  sandbox.window = sandbox;
  vm.runInNewContext(coronaFrontend, sandbox, { filename: 'corona-wms-layer.js' });
  return { atlas: sandbox.CoronaAtlas, notices };
}

function jsonResponse(data, status = 200) {
  return Response.json(data, { status });
}

async function runSources(sourceMap, options) {
  const calls = [];
  const { atlas, notices } = frontendSandbox(async (url) => {
    calls.push(String(url));
    const source = sourceMap[String(url)];
    return typeof source === 'function' ? source() : source;
  }, options);
  const first = atlas.loadCatalog();
  const second = atlas.loadCatalog();
  const result = await first;
  assert.equal(first, second, 'simultaneous catalogue requests share one promise');
  return { result, calls, notices };
}

test('PWA shell requests and precaches the versioned Corona fallback code', async () => {
  const index = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const worker = await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const asset = 'js/corona-wms-layer.js?v=20261112-corona-catalog-fallback';
  assert.ok(index.includes(asset));
  assert.ok(worker.includes(`'${asset}'`));
  assert.match(worker, /CACHE_NAME = 'detectlab-v403-corona-catalog-validation'/);
});

test('static snapshot is preferred and concurrent requests share one fetch', async () => {
  const { result, calls } = await runSources({ [CATALOG_URL]: jsonResponse(payload()) });
  assert.equal(result.source, CATALOG_URL);
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(calls, [CATALOG_URL]);
});

test('static 404 falls through to the live API', async () => {
  const { result, calls } = await runSources({
    [CATALOG_URL]: new Response('missing', { status: 404 }), [API_URL]: jsonResponse(payload())
  });
  assert.equal(result.source, API_URL);
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(calls, [CATALOG_URL, API_URL]);
});

test('static HTML with HTTP 200 is rejected and the API is used', async () => {
  const { result, calls } = await runSources({
    [CATALOG_URL]: new Response('<!doctype html><html>DetectLab</html>', {
      status: 200, headers: { 'Content-Type': 'text/html' }
    }), [API_URL]: jsonResponse(payload())
  });
  assert.equal(result.source, API_URL);
  assert.deepEqual(calls, [CATALOG_URL, API_URL]);
});

test('syntactically malformed static JSON falls through to the API', async () => {
  const { result, calls } = await runSources({
    [CATALOG_URL]: new Response('{"blocks":[', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    [API_URL]: jsonResponse(payload())
  });
  assert.equal(result.source, API_URL);
  assert.deepEqual(calls, [CATALOG_URL, API_URL]);
});

test('empty, malformed-shape and inconsistent static JSON are rejected', async () => {
  for (const invalid of [{}, { ...payload(), blocks: [], passes: 0, frames: 0 },
    { ...payload(), frames: 8 }, { ...payload(), blocks: [{ id: 'broken', images: [] }] }]) {
    const { result, calls } = await runSources({
      [CATALOG_URL]: jsonResponse(invalid), [API_URL]: jsonResponse(payload())
    });
    assert.equal(result.source, API_URL);
    assert.deepEqual(calls, [CATALOG_URL, API_URL]);
  }
});

test('API works when the static file is absent; valid static data works without the API', async () => {
  const apiCase = await runSources({
    [CATALOG_URL]: new Response('missing', { status: 404 }), [API_URL]: jsonResponse(payload())
  });
  assert.equal(apiCase.result.blocks[0].location, 'pass-1');
  assert.equal(apiCase.result.source, API_URL);

  const staticCase = await runSources({
    [CATALOG_URL]: jsonResponse(payload()), [API_URL]: () => { throw new Error('API unavailable'); }
  });
  assert.equal(staticCase.result.source, CATALOG_URL);
  assert.deepEqual(staticCase.calls, [CATALOG_URL]);
});

test('both sources unavailable return a limited fallback and an accessible non-blocking notice', async () => {
  const { result, calls, notices } = await runSources({
    [CATALOG_URL]: new Response('missing', { status: 404 }),
    [API_URL]: new Response('upstream failure', { status: 502 })
  }, { withDocument: true });
  assert.equal(result.source, 'fallback');
  assert.ok(result.warning);
  assert.equal(result.blocks.length, 6);
  assert.deepEqual(calls, [CATALOG_URL, API_URL]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].getAttribute('role'), 'status');
  assert.equal(notices[0].getAttribute('aria-live'), 'polite');
  assert.match(notices[0].textContent, /other map layers are unaffected/i);
});

test('snapshot builder writes the expected schema only after validation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detectlab-corona-build-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'data/corona-europe-catalog.json');
  const result = await buildStaticCatalog({
    outputPath, fetchCatalog: async () => rawCastCatalog(),
    now: () => new Date('2026-11-12T12:00:00.000Z'), log() {}, warn() {}
  });
  assert.equal(result.written, true);
  assert.deepEqual(validateCatalogSnapshot(JSON.parse(await fs.readFile(outputPath, 'utf8'))), { passes: 1, frames: 1 });
  assert.equal(await fs.readdir(path.dirname(outputPath)).then((files) => files.some((name) => name.includes('.tmp-'))), false);
});

test('failed CAST refresh preserves valid bytes; no snapshot is created when none exists', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detectlab-corona-outage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'catalog.json');
  await fs.writeFile(outputPath, JSON.stringify(payload()));
  const original = await fs.readFile(outputPath);
  const result = await buildStaticCatalog({
    outputPath, fetchCatalog: async () => { throw new Error('CAST TLS unavailable'); }, log() {}, warn() {}
  });
  assert.equal(result.written, false);
  assert.equal(result.retained, true);
  assert.deepEqual(await fs.readFile(outputPath), original);

  const absentPath = path.join(dir, 'absent/catalog.json');
  const absentResult = await buildStaticCatalog({
    outputPath: absentPath, fetchCatalog: async () => ({}), log() {}, warn() {}
  });
  assert.equal(absentResult.written, false);
  assert.equal(absentResult.retained, false);
  await assert.rejects(fs.access(absentPath));
});

test('CAST HTML/JSON parse failure does not create or replace a snapshot', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'detectlab-corona-html-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outputPath = path.join(dir, 'catalog.json');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>Cloudflare challenge</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await buildStaticCatalog({ outputPath, log() {}, warn() {} });
  assert.equal(result.written, false);
  assert.equal(result.retained, false);
  await assert.rejects(fs.access(outputPath));
});

test('service worker caches only valid Corona JSON and serves a validated cached copy offline', async () => {
  const handlers = {};
  const entries = new Map();
  const cache = {
    async match(request) { return entries.get(request.url)?.clone() || null; },
    async put(request, response) { entries.set(request.url, response.clone()); },
    async delete(request) { return entries.delete(request.url); }
  };
  let network = async () => jsonResponse(payload());
  const sandbox = {
    self: { addEventListener(type, handler) { handlers[type] = handler; } },
    location: { origin: 'https://detectlab.example' },
    caches: { async open() { return cache; } },
    fetch: (...args) => network(...args), URL, Request, Response, console, setTimeout, clearTimeout
  };
  vm.runInNewContext(await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8'), sandbox, { filename: 'sw.js' });
  async function dispatch(url) {
    let responsePromise;
    handlers.fetch({ request: new Request(url), respondWith(value) { responsePromise = Promise.resolve(value); } });
    return responsePromise;
  }

  const staticUrl = 'https://detectlab.example/data/corona-europe-catalog.json';
  assert.equal((await dispatch(staticUrl)).status, 200);
  assert.equal(entries.has(staticUrl), true);
  network = async () => { throw new Error('offline'); };
  const offline = await dispatch(staticUrl);
  assert.equal(offline.status, 200);
  assert.equal((await offline.json()).frames, 1);

  const apiUrl = 'https://detectlab.example/api/corona/rasters?bbox=-25,34,60,72';
  network = async () => new Response('<html>SPA</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  assert.equal((await dispatch(apiUrl)).status, 200);
  assert.equal(entries.has(apiUrl), false);
  network = async () => jsonResponse({ blocks: [], passes: 0, frames: 0 });
  assert.equal((await dispatch(apiUrl)).status, 200);
  assert.equal(entries.has(apiUrl), false);
  network = async () => { throw new Error('offline'); };
  assert.equal((await dispatch(apiUrl)).status, 503);
});

test('service worker upgrades migrate only validated cached Corona responses', async () => {
  const handlers = {};
  const stores = new Map();
  const cacheFor = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        async keys() { return Array.from(entries.keys()).map((url) => new Request(url)); },
        async match(request) { return entries.get(request.url)?.clone() || null; },
        async put(request, response) { entries.set(request.url, response.clone()); },
        async delete(request) { return entries.delete(request.url); }
      });
    }
    return stores.get(name);
  };
  const oldName = 'detectlab-v402-google-callback-bypass';
  const staticUrl = 'https://detectlab.example/data/corona-europe-catalog.json';
  const invalidUrl = 'https://detectlab.example/api/corona/rasters?bbox=-25,34,60,72';
  const oldCache = cacheFor(oldName);
  await oldCache.put(new Request(staticUrl), jsonResponse(payload()));
  await oldCache.put(new Request(invalidUrl), new Response('<html>cached SPA</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  }));
  const cachesApi = {
    async open(name) { return cacheFor(name); },
    async keys() { return Array.from(stores.keys()); },
    async delete(name) { return stores.delete(name); }
  };
  const sandbox = {
    self: { addEventListener(type, handler) { (handlers[type] || (handlers[type] = [])).push(handler); },
      clients: { async claim() {} } },
    location: { origin: 'https://detectlab.example' }, caches: cachesApi,
    fetch: async () => { throw new Error('not used during activation'); },
    URL, Request, Response, console, setTimeout, clearTimeout
  };
  vm.runInNewContext(await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8'), sandbox, { filename: 'sw.js' });
  let activation;
  handlers.activate[0]({ waitUntil(promise) { activation = promise; } });
  await activation;
  assert.equal(stores.has(oldName), false);
  const currentCache = stores.get('detectlab-v403-corona-catalog-validation');
  assert.ok(currentCache);
  assert.equal((await currentCache.match(new Request(staticUrl)))?.status, 200);
  assert.equal(await currentCache.match(new Request(invalidUrl)), null);
});
