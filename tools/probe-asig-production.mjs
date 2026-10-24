#!/usr/bin/env node
/*
 * Live production check for every Albania ASIG WMS registry layer.
 *
 * This calls DetectLab's same-origin tile proxy only; it never calls ASIG
 * directly. HTTP 200 is insufficient unless the proxy returns a real image.
 *
 * The list comes from the shared registry, so it follows the catalogue:
 * tile-only rows (WMTS) and rows whose name is not in the catalogue yet are
 * not registered and therefore not probed — run
 * `node tools/build-asig-catalogue.mjs --export=asig-layers.json` to bake the
 * remaining names first.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const registry = require('../js/layer-registry.js');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function exceptionBody(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf8').trimStart();
  return /^(?:<\?xml|<!doctype\s+html|<html\b|<serviceexception(?:report)?\b|<ows:exceptionreport\b)/i.test(head) ||
    /(?:ServiceExceptionReport|ServiceException|ExceptionReport|ExceptionText)/i.test(head);
}
function upstreamFailure(value) {
  return /^(?:error|not-an-image|unavailable|failed|false|http-\d{3})$/i.test(String(value || '').trim());
}

const origin = String(option('origin', '')).replace(/\/$/, '');
const tile = String(option('tile', '12/2273/1530'));
const timeoutMs = Math.max(1000, Math.min(60000, Number(option('timeout', '20000')) || 20000));
let parsedOrigin;
try { parsedOrigin = new URL(origin); } catch { parsedOrigin = null; }
const localHttpMock = parsedOrigin && parsedOrigin.protocol === 'http:' &&
  ['localhost', '127.0.0.1', '[::1]'].includes(parsedOrigin.hostname);
if (!parsedOrigin || (parsedOrigin.protocol !== 'https:' && !localHttpMock)) {
  console.error('Usage: node tools/probe-asig-production.mjs --origin=https://detectlab.eu --tile=12/2273/1530');
  process.exit(2);
}
if (!/^\d+\/\d+\/\d+$/.test(tile)) {
  console.error(`Invalid tile ${tile}; expected z/x/y.`);
  process.exit(2);
}
const expectedIds = registry.list().map((def) => def.id).filter((id) => id.startsWith('albania.')).sort();
if (!expectedIds.length) {
  console.error('No albania.* layers in the registry — is data/asig-layers.data.js present?');
  process.exit(2);
}
const skipped = typeof registry.asigCatalogueSkips === 'function' ? registry.asigCatalogueSkips() : [];
console.log(`Probing ${expectedIds.length} ASIG WMS layer(s) through the same-origin proxy` +
  (skipped.length ? `; ${skipped.length} catalogue row(s) not probed: ${skipped.join(', ')}` : '') + '.');

let failures = 0;
for (const id of expectedIds) {
  const url = new URL('/api/map3d/tile', origin);
  url.searchParams.set('layer', id);
  const [z, x, y] = tile.split('/');
  url.searchParams.set('z', z);
  url.searchParams.set('x', x);
  url.searchParams.set('y', y);
  let status = 'ERR';
  let contentType = '<none>';
  let size = 0;
  let upstream = '<absent>';
  let exception = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'image/*' } });
    clearTimeout(timer);
    status = String(response.status);
    contentType = response.headers.get('content-type') || '<none>';
    upstream = response.headers.get('x-map3d-upstream') || '<absent>';
    const body = Buffer.from(await response.arrayBuffer());
    size = body.byteLength;
    exception = exceptionBody(body);
    const passed = response.status === 200 && /^image\//i.test(contentType) && size >= 32 &&
      !exception && !upstreamFailure(upstream);
    if (!passed) failures += 1;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}\tHTTP ${status}\t${contentType}\t${size} bytes\tX-Map3D-Upstream: ${upstream}${exception ? '\tXML/HTML exception body' : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${id}\tHTTP ${status}\t${contentType}\t${size} bytes\tX-Map3D-Upstream: ${upstream}\t${String(error && error.message || error)}`);
  }
}
console.log(`Probe summary: ${expectedIds.length - failures}/${expectedIds.length} passed; origin=${origin}; tile=${tile}.`);
if (failures) process.exitCode = 1;
