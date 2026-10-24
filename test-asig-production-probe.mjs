#!/usr/bin/env node
/* Mock-only regression for the same-origin ASIG production probe. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const probe = path.join(root, 'tools/probe-asig-production.mjs');
const ids = [
  'culturalZone', 'cultural', 'natural', 'monument',
  'ortho7686', 'ortho94', 'ortho2007', 'ortho2015',
  'ortho1994', 'ortho8cm', 'orthoCir', 'orthoCir8cm',
  'ortho2018', 'ortho2001', 'ortho1999', 'ortho1957',
  'ortho19761980', 'fragmentDurres1986'
];
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex');

function runProbe(origin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probe, `--origin=${origin}`, '--tile=12/2273/1530', '--timeout=3000'], { cwd: root });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push(url);
  if (url.pathname !== '/api/map3d/tile') { res.writeHead(404).end(); return; }
  const id = url.searchParams.get('layer') || '';
  const invalid = id === 'albania.culturalZone';
  const mode = url.searchParams.get('mock') || process.env.ASIG_PROBE_MOCK || 'pass';
  // Scenarios come from the server path so the probe still tests the production URL shape.
  if (invalid && mode === 'xml') { res.writeHead(200, { 'Content-Type': 'text/xml' }).end('<ServiceExceptionReport/>'); return; }
  if (invalid && mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html>exception</html>'); return; }
  if (invalid && mode === 'short') { res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.from([1, 2, 3])); return; }
  if (invalid && mode === 'upstream') { res.writeHead(200, { 'Content-Type': 'image/png', 'X-Map3D-Upstream': 'not-an-image' }).end(png); return; }
  res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
try {
  // Server query mode is injected by a local wrapper path, never passed to the probe.
  for (const scenario of ['pass', 'xml', 'html', 'short', 'upstream']) {
    requests.length = 0;
    const previous = process.env.ASIG_PROBE_MOCK;
    process.env.ASIG_PROBE_MOCK = scenario;
    const result = await runProbe(origin);
    if (previous === undefined) delete process.env.ASIG_PROBE_MOCK; else process.env.ASIG_PROBE_MOCK = previous;
    assert.equal(requests.length, 18, `${scenario}: probes all 18 registry IDs; child=${result.code} ${result.stderr} ${result.stdout}`);
    requests.forEach((url) => {
      assert.equal(url.pathname, '/api/map3d/tile');
      assert.equal(url.searchParams.get('z'), '12');
      assert.equal(url.searchParams.get('x'), '2273');
      assert.equal(url.searchParams.get('y'), '1530');
    });
    ids.forEach((id) => assert.ok(requests.some((url) => url.searchParams.get('layer') === 'albania.' + id), `${scenario}: includes albania.${id}`));
    if (scenario === 'pass') {
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Probe summary: 18\/18 passed/);
      assert.match(result.stdout, /HTTP 200\timage\/png\t\d+ bytes\tX-Map3D-Upstream: <absent>/);
    } else {
      assert.equal(result.code, 1, `${scenario}: invalid response must fail the gate`);
      assert.match(result.stdout, /Probe summary: 17\/18 passed/);
      const failed = result.stdout.split('\n').find((line) => line.startsWith('FAIL albania.culturalZone'));
      assert.ok(failed, `${scenario}: the bad layer is identified in output`);
      if (scenario === 'xml' || scenario === 'html') assert.match(failed, /XML\/HTML exception body/);
      if (scenario === 'short') assert.match(failed, /3 bytes/);
      if (scenario === 'upstream') assert.match(failed, /X-Map3D-Upstream: not-an-image/);
    }
  }
  console.log('[ASIG probe mock] 5 response scenarios passed; all requests were same-origin and used Tirana tile 12/2273/1530.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
