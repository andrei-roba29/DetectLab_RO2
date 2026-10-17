#!/usr/bin/env node
/*
 * tools/verify-finland-layers.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Verify every Finnish layer actually answers — the standing rule of this
 * repo is “never report a layer done without verifying it”.
 *
 *   node tools/verify-finland-layers.mjs
 *
 * What it checks, and what a failure means:
 *   1. the EPSG:3067 maths and the MVT decoder self-tests
 *      (js/finland-tm35.js — these MUST pass everywhere, no network);
 *   2. the TM35FIN grid against the three tiles the services themselves
 *      answered during the 2026-10-17 endpoint discovery;
 *   3. every enabled layer in js/finland-layers.config.js: a sample request
 *      per layer (a tile, a GetMap, a WFS bbox query, an export), status
 *      code and content type, with the known-broken ones expected to fail;
 *   4. the inferred museoverkko WFS ids (the ones marked verified:false in
 *      the config — the {pisteet, alakohteet, alueet} block pattern);
 *   5. the SYKE capabilities and one rendered tile per service;
 *   6. the Åland REST service metadata, one export and one query.
 *
 * Output: a per-layer table on the console plus
 * tools/finland-verification-report.json (the honest artifact to attach to a
 * report). Exit code 0 when every check that SHOULD pass does.
 *
 * NOTE: run this where the Finnish hosts are reachable. karttamoottori is
 * expected to answer 403 to a server-side fetch (it does for every
 * non-browser client probed so far) — that is a documented finding, not a
 * tool failure; the browser path + the /api/geo/finland proxy are the
 * mitigation and the report says so.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── load the shared config the same way the browser does ───────────────── */
const configScope = { exports: {} };
new Function('module', 'exports',
  (await import('node:fs')).readFileSync(path.join(root, 'js', 'finland-layers.config.js'), 'utf8'),
)(configScope, configScope.exports);
const CONFIG = configScope.exports;

/* ── load finland-tm35.js the same way ──────────────────────────────────── */
const tmScope = { exports: {} };
new Function('module', 'exports',
  (await import('node:fs')).readFileSync(path.join(root, 'js', 'finland-tm35.js'), 'utf8'),
)(tmScope, tmScope.exports);
const TM = tmScope.exports;

const results = [];
function record(section, name, ok, detail) {
  results.push({ section, name, ok, detail });
  console.log(`${ok ? '✓' : '✗'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function probe(url, expect) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(25000),
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) DetectLab-verify/1.0' },
      redirect: 'follow',
    });
    const type = response.headers.get('content-type') || '';
    let size = 0;
    let snippet = '';
    if (expect === 'image') {
      const buffer = Buffer.from(await response.arrayBuffer());
      size = buffer.length;
      const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
      return { status: response.status, type, size, snippet: isPng ? 'PNG' : buffer.slice(0, 24).toString('hex'), ms: Date.now() - started };
    }
    const text = await response.text();
    size = text.length;
    snippet = text.slice(0, 140).replace(/\s+/g, ' ');
    return { status: response.status, type, size, snippet, ms: Date.now() - started };
  } catch (err) {
    return { status: 0, type: '', size: 0, snippet: `fetch error: ${err.message}`, ms: Date.now() - started };
  }
}

console.log('══ 1 · projection + MVT self-tests ══');
const self = TM.selfTest();
record('selftest', 'FinlandTM35.selfTest()', self.ok,
  `roundTrip ${self.roundTripMaxErrorM.toExponential(1)} m, Helsinki ${self.helsinkiErrorM.toFixed(3)} m, mvt ${self.mvt}`);

console.log('\n══ 2 · TM35FIN grid vs the tiles the services answered in discovery ══');
const gridChecks = [
  /* [desc, level, col, row, expected west & north corner, rounded] — the
   * corners follow from the published matrix (origin −548576 8388608,
   * resolution 8192/2^level, 256 px tiles) and were cross-checked against
   * the tiles the services themselves answered during discovery. */
  ['hillshade z11 col 984 row 1306 (user-provided sample)', 11, 984, 1306, 459040, 7051264],
  ['HKP id=623 z9 x=248 y=316 (brief sample)', 9, 248, 316, 467232, 7094272],
  ['HKP id=819 z13 x=4019 y=5032 (brief sample)', 13, 4019, 5032, 480288, 7100416],
  ['museoverkko TileMatrix=11 TileCol=991 TileRow=1158', 11, 991, 1158, 466208, 7202816],
];
for (const [desc, level, col, row, west, north] of gridChecks) {
  const b = TM.tileBounds(level, col, row);
  const ok = Math.round(b[0]) === west && Math.round(b[3]) === north;
  record('grid', desc, ok, `bounds ${b.map((v) => Math.round(v)).join(', ')}`);
}
record('grid', 'levelForZoom(14, 60.2) sanity', TM.levelForZoom(14, 60.2) >= 8 && TM.levelForZoom(14, 60.2) <= 10,
  `→ ${TM.levelForZoom(14, 60.2)}`);

console.log('\n══ 3 · every enabled layer, one sample request each ══');
const R = (n) => Math.round(n * 1e4) / 1e4;
function mercatorBbox(z, x, y) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  const s = Math.PI - (2 * Math.PI * (y + 1)) / Math.pow(2, z);
  const w = (x / Math.pow(2, z)) * 2 * Math.PI - Math.PI;
  const e = ((x + 1) / Math.pow(2, z)) * 2 * Math.PI - Math.PI;
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2)) * 6378137;
  return [R(w * 6378137), R(merc(Math.atan(Math.sinh(s)))), R(e * 6378137), R(merc(Math.atan(Math.sinh(n))))];
}

for (const layer of CONFIG.enabledLayers()) {
  if (layer.kind === 'tm35-wmts') {
    /* a Helsinki-adjacent tile at the layer's own grid */
    const level = Math.min(layer.maxNativeLevel ?? 15, 13);
    const en = TM.UTM35.forward(60.17, 24.94);
    const span = 8192 * 256 / Math.pow(2, level);
    const col = Math.floor((en[0] - TM.GRID.origin[0]) / span);
    const row = Math.floor((TM.GRID.origin[1] - en[1]) / span);
    const url = layer.urlTemplate
      .replace('{z}', level).replace('{col}', col).replace('{row}', row);
    const r = await probe(url, 'image');
    record(layer.id, `${layer.id} · direct tile ${level}/${row}/${col}`,
      r.status === 200 && /image|octet/.test(r.type), `HTTP ${r.status} ${r.type} ${r.size}B — expected to need the browser path or proxy for karttamoottori`);
  } else if (layer.kind === 'wms') {
    const bbox = mercatorBbox(11, 1163, 594);
    const url = `${CONFIG.WMS_SERVICES[layer.service].url}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap` +
      `&LAYERS=${encodeURIComponent(layer.layers)}&STYLES=&SRS=EPSG%3A3857&BBOX=${bbox.join(',')}` +
      `&WIDTH=256&HEIGHT=256&FORMAT=${encodeURIComponent(layer.format)}&TRANSPARENT=TRUE`;
    const r = await probe(url, 'image');
    record(layer.id, `${layer.id} · GetMap z11`, r.status === 200 && /image/.test(r.type),
      `HTTP ${r.status} ${r.type} ${r.size}B`);
  } else if (layer.kind === 'arcgis') {
    const bbox = mercatorBbox(11, 1164, 596);
    const url = `https://kartor.regeringen.ax/arcgis/rest/services/${layer.restService}/export` +
      `?bbox=${bbox.join(',')}&bboxSR=3857&layers=show:${layer.layerId}&size=256,256&format=png&transparent=true&f=image`;
    const r = await probe(url, 'image');
    record(layer.id, `${layer.id} · export z11`, r.status === 200 && /image/.test(r.type),
      `HTTP ${r.status} ${r.type} ${r.size}B`);
  } else if (layer.kind === 'wfs') {
    if (layer.enabled === false) continue;
    const box = layer.subGroup === 'luonnonmuodostumat' ? '27.0,62.5,28.0,64.0' : '24.8,60.1,25.3,60.35';
    const url = `${CONFIG.endpoints.museoWfs}?action_route=GetWFSFeatures&id=${layer.wfsId}&srs=EPSG:4326&bbox=${box}`;
    const r = await probe(url, 'json');
    record(layer.id, `${layer.id} · GetWFSFeatures id=${layer.wfsId} (${layer.verified ? 'verified' : 'INFERRED id'})`,
      r.status === 200 && r.snippet.indexOf('"features"') !== -1,
      `HTTP ${r.status} ${r.type} ${r.size}B ${r.snippet.slice(0, 80)}`);
  } else if (layer.kind === 'geojson') {
    record(layer.id, `${layer.id} · local file`, false,
      'conversion not run here — run node tools/finland-convert-gpkg.mjs where Supabase is reachable');
  }
}

console.log('\n══ 4 · the SYKE services ══');
for (const [key, service] of Object.entries(CONFIG.WMS_SERVICES)) {
  const r = await probe(`${service.url}?request=GetCapabilities&service=WMS`, 'text');
  record('syke', `${key} GetCapabilities`, r.status === 200 && /xml/.test(r.type), `HTTP ${r.status} ${r.type} ${r.size}B`);
}

console.log('\n══ 5 · Åland REST service ══');
{
  const r = await probe('https://kartor.regeringen.ax/arcgis/rest/services/Kulturarv/Fornminnen/MapServer?f=json', 'json');
  record('aland', 'Fornminnen MapServer metadata', r.status === 200 && r.snippet.indexOf('layers') !== -1,
    `HTTP ${r.status} ${r.type}`);
  const q = await probe('https://kartor.regeringen.ax/arcgis/rest/services/Kulturarv/Fornminnen/MapServer/1/query' +
    '?f=geojson&geometryType=esriGeometryEnvelope&geometry=%7B%22xmin%22%3A19.9%2C%22ymin%22%3A60.05%2C%22xmax%22%3A20.1%2C%22ymax%22%3A60.15%7D' +
    '&inSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outFields=*&outSR=4326', 'json');
  record('aland', 'Fornminnen query (geojson)', q.status === 200 && q.snippet.indexOf('"type"') !== -1,
    `HTTP ${q.status} ${q.size}B`);
}

/* ── summary + report ──────────────────────────────────────────────────── */
const expectedOk = results.filter((r) => !/karttamoottori|museoverkko.*GetLayerTile|local file|INFERRED/.test(r.name));
const failing = expectedOk.filter((r) => !r.ok);
const inferredFails = results.filter((r) => /INFERRED/.test(r.name) && !r.ok);

console.log('\n══ summary ══');
console.log(`checks: ${results.length}, failing (of the ones expected to pass): ${failing.length}`);
if (failing.length) {
  console.log('failing:');
  failing.forEach((r) => console.log(`  ✗ ${r.name} — ${r.detail}`));
}
if (inferredFails.length) {
  console.log(`inferred WFS ids that did not verify (${inferredFails.length}) — update verified:true / the id in the config if these fail:`);
  inferredFails.forEach((r) => console.log(`  ? ${r.name} — ${r.detail}`));
}

const report = {
  generated: new Date().toISOString(),
  summary: {
    checks: results.length,
    expectedToPass: expectedOk.length,
    failing: failing.map((r) => r.name),
    inferredNotVerified: inferredFails.map((r) => r.name),
  },
  results,
};
writeFileSync(path.join(root, 'tools', 'finland-verification-report.json'), JSON.stringify(report, null, 2));
console.log('\nreport → tools/finland-verification-report.json');
process.exit(failing.length ? 1 : 0);
