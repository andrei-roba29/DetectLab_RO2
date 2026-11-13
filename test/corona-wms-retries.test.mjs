import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../js/corona-wms-layer.js', import.meta.url), 'utf8');

function setup() {
  const timers = [];
  const notices = [];
  const body = {
    appendChild(element) { element.parentNode = this; notices.push(element); },
    removeChild(element) { element.parentNode = null; }
  };
  const document = {
    body,
    createElement() {
      return {
        style: {},
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        naturalWidth: 0,
        naturalHeight: 0
      };
    }
  };
  function WmsLayer() {}
  WmsLayer.prototype.initialize = function (url, options) {
    this._url = url;
    this.options = options;
    this._events = {};
  };
  WmsLayer.prototype.on = function (name, callback) {
    (this._events[name] ||= []).push(callback);
    return this;
  };
  const L = {
    TileLayer: { WMS: WmsLayer },
    extend: (target, ...sources) => Object.assign(target, ...sources)
  };
  WmsLayer.extend = function (definition) {
    function Extended(url, options) { definition.initialize.call(this, url, options); }
    Extended.prototype = Object.create(WmsLayer.prototype);
    Object.assign(Extended.prototype, definition);
    Extended.prototype.constructor = Extended;
    return Extended;
  };
  const sandbox = {
    L,
    document,
    console: { error() {}, warn() {}, info() {} },
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    performance: { getEntriesByName() { return []; } }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'corona-wms-layer.js' });
  return { Layer: sandbox.CoronaWmsLayer, timers, notices };
}

function makeTile(layer, coords = { z: 10, x: 3, y: 4 }) {
  const completions = [];
  const tile = layer.createTile(coords, (error, loadedTile) => completions.push({ error, tile: loadedTile }));
  return { tile, completions };
}

function retryTimers(timers) {
  return timers.filter((timer) => !timer.cleared && timer.delay < 8000);
}

function runRetryTimer(timers, delay) {
  const timer = timers.find((candidate) => !candidate.cleared && candidate.delay === delay);
  assert.ok(timer, `expected a pending ${delay}ms retry timer`);
  timer.cleared = true;
  timer.callback();
}

function succeed(tile) {
  tile.naturalWidth = 256;
  tile.naturalHeight = 256;
  tile.onload({ status: 200, target: { status: 200 } });
}

function fail(tile, status) {
  tile.onerror({ status, target: { status } });
}

test('valid PNG image completes once without a retry and preserves the WMS URL', () => {
  const { Layer, timers } = setup();
  const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', {
    layers: 'corona:1104-2155Aft'
  });
  const { tile, completions } = makeTile(layer);
  const exactUrl = 'https://geoserve.cast.uark.edu/geoserver/gwc/service/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&FORMAT=image%2Fpng&TRANSPARENT=true&LAYERS=corona%3A1104-2155Aft&tiled=true&WIDTH=256&HEIGHT=256&SRS=EPSG%3A900913&STYLES=&BBOX=-19920101.067343%2C19841829.550379%2C-19880965.308861%2C19880965.308861';
  assert.equal(tile.src, exactUrl);
  succeed(tile);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].error, null);
  assert.equal(retryTimers(timers).length, 0);
});

test('HTTP 504/503 failures get at most two progressive retries; recovery completes the tile', () => {
  const { Layer, timers, notices } = setup();
  const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', { layers: 'corona:1104-2155Aft' });
  const { tile, completions } = makeTile(layer);
  const originalUrl = tile.src;

  tile.naturalWidth = 256;
  tile.naturalHeight = 256;
  tile.onload({ status: 504, target: { status: 504 } });
  assert.equal(completions.length, 0, 'even a decodable body with HTTP 504 is not marked as a successfully loaded image');
  assert.equal(notices.filter((notice) => notice.parentNode).length, 1);
  assert.deepEqual(retryTimers(timers).map((timer) => timer.delay), [500]);
  runRetryTimer(timers, 500);
  assert.equal(tile.src, originalUrl, 'retry uses the exact same WMS request URL');

  fail(tile, 503);
  assert.deepEqual(retryTimers(timers).map((timer) => timer.delay), [1500]);
  runRetryTimer(timers, 1500);
  succeed(tile);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].error, null);
  assert.equal(notices.filter((notice) => notice.parentNode).length, 0, 'successful recovery clears the notice');
});

test('HTTP 502 is treated as a transient gateway failure', () => {
  const { Layer, timers } = setup();
  const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', { layers: 'corona:1104-2155Aft' });
  const { tile, completions } = makeTile(layer);
  fail(tile, 502);
  assert.equal(completions.length, 0);
  assert.deepEqual(retryTimers(timers).map((timer) => timer.delay), [500]);
});

test('network errors and HTTP 200 HTML/non-image responses retry, then stop after two retries', () => {
  for (const status of [0, 200]) {
    const { Layer, timers } = setup();
    const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', { layers: 'corona:1104-2155Aft' });
    const { tile, completions } = makeTile(layer);
    fail(tile, status); // a browser image error for network failure or undecodable HTML
    runRetryTimer(timers, 500);
    fail(tile, status);
    runRetryTimer(timers, 1500);
    fail(tile, status);
    assert.equal(completions.length, 1);
    assert.ok(completions[0].error);
    assert.equal(retryTimers(timers).length, 0);
  }
});

test('an observable permanent HTTP 404 is not retried', () => {
  const { Layer, timers } = setup();
  const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', { layers: 'corona:1104-2155Aft' });
  const { tile, completions } = makeTile(layer);
  fail(tile, 404);
  assert.equal(completions.length, 1);
  assert.match(completions[0].error.message, /HTTP 404/);
  assert.equal(retryTimers(timers).length, 0);
});

test('one failed tile does not block a successful sibling, and duplicate retry timers coalesce by URL', () => {
  const { Layer, timers, notices } = setup();
  const layer = new Layer('https://geoserve.cast.uark.edu/geoserver/gwc/service/wms', { layers: 'corona:1104-2155Aft' });
  const first = makeTile(layer, { z: 10, x: 3, y: 4 });
  const duplicate = makeTile(layer, { z: 10, x: 3, y: 4 });
  const sibling = makeTile(layer, { z: 10, x: 4, y: 4 });

  fail(first.tile, 504);
  fail(duplicate.tile, 504);
  succeed(sibling.tile);
  assert.equal(sibling.completions.length, 1);
  assert.equal(sibling.completions[0].error, null);
  assert.equal(retryTimers(timers).length, 1, 'same-URL retry waiters share one timer');
  assert.equal(notices.filter((notice) => notice.parentNode).length, 1);

  runRetryTimer(timers, 500);
  succeed(first.tile);
  succeed(duplicate.tile);
  assert.equal(first.completions.length, 1);
  assert.equal(duplicate.completions.length, 1);
  assert.equal(sibling.completions.length, 1, 'the already-loaded sibling remains intact');
});

test('service worker bypasses Cache Storage for Corona WMS and refuses opaque Corona offline writes', async () => {
  const handlers = {};
  let cacheReads = 0;
  let cacheWrites = 0;
  let networkResponse = new Response('<html>gateway timeout</html>', {
    status: 504, headers: { 'Content-Type': 'text/html' }
  });
  const cache = {
    async match(request) {
      if (String(request && request.url || request).includes('geoserve.cast.uark.edu')) cacheReads += 1;
      return null;
    },
    async put(request) {
      if (String(request && request.url || request).includes('geoserve.cast.uark.edu')) cacheWrites += 1;
    }
  };
  const sandbox = {
    self: { addEventListener(type, handler) { handlers[type] = handler; } },
    location: { origin: 'https://detectlab.example' },
    caches: { async open() { return cache; }, async keys() { return []; } },
    fetch: async () => networkResponse,
    URL, Request, Response, console, setTimeout, clearTimeout
  };
  vm.runInNewContext(await fs.readFile(new URL('../sw.js', import.meta.url), 'utf8'), sandbox, { filename: 'sw.js' });

  const tileUrl = 'https://geoserve.cast.uark.edu/geoserver/gwc/service/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=corona%3A1104-2155Aft';
  async function dispatch(url) {
    let responsePromise;
    handlers.fetch({ request: new Request(url), respondWith(value) { responsePromise = Promise.resolve(value); } });
    return responsePromise;
  }
  const failed = await dispatch(tileUrl);
  assert.equal(failed.status, 504);
  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 0);

  networkResponse = new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200, headers: { 'Content-Type': 'image/png' }
  });
  assert.equal((await dispatch(tileUrl)).status, 200);
  assert.equal(cacheWrites, 0, 'the worker leaves valid live tiles to browser HTTP caching');

  let messageResult;
  await handlers.message({
    data: { type: 'CACHE_OFFLINE_TILE', url: tileUrl },
    ports: [{ postMessage(value) { messageResult = value; } }]
  });
  assert.equal(messageResult.ok, false);
  assert.equal(cacheWrites, 0, 'opaque Corona responses are not written to Cache Storage');
});
