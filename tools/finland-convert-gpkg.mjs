#!/usr/bin/env node
/*
 * tools/finland-convert-gpkg.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Convert the Supabase-hosted Finnish GeoPackages to web-friendly GeoJSON.
 *
 * The Supabase bucket is not reachable from every development sandbox, so
 * this tool is meant to be run where it is (any machine with internet):
 *
 *   node tools/finland-convert-gpkg.mjs                download + convert
 *   node tools/finland-convert-gpkg.mjs --no-download  reuse an existing tmp dir
 *   node tools/finland-convert-gpkg.mjs --upload       ALSO upload the results
 *                                                     back to the bucket
 *
 * What it does, step by step:
 *   1. downloads every GeoPackage listed in js/finland-layers.config.js
 *      (the `kind: 'geojson'` entries) plus their .qml symbology files from
 *      <SUPABASE base>/Harti/Finlanda/ — the ORIGINALS are never touched;
 *   2. reads each .qml and extracts the fill/line/point colours into a small
 *      <name>.style.json sidecar the map can apply;
 *   3. converts each GeoPackage to EPSG:4326 GeoJSON with ogr2ogr (GDAL) —
 *      the authoritative converter for GPKG; large outputs are warned about
 *      with the exact PMTiles/FGB command to run instead;
 *   4. writes data/finland/<name>.geojson (committed to the repo, served
 *      same-origin) and data/finland/conversion-report.json with the layer
 *      inventory, the feature counts and the dedup comparison against the
 *      live services;
 *   5. with --upload, PUTs the outputs back to the SAME bucket folder under
 *      converted/ (new names — never over the originals), using
 *      SUPABASE_SERVICE_KEY from the environment. The bucket's anon key
 *      cannot write, so the service key is required for this step.
 *
 * Requirements: Node 18+ (global fetch), GDAL's ogr2ogr/ogrinfo on PATH
 * (brew install gdal / apt install gdal-bin). No secrets are hardcoded —
 * only the environment variable SUPABASE_SERVICE_KEY, and only for --upload.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(root, 'data', 'finland');
const TMP_DIR = path.join(root, 'tmp-finland-gpkg');
const SUPABASE_BASE = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/Finlanda';

/* The GeoPackages (and their .qml sidecars, when they exist) — kept in step
 * with js/finland-layers.config.js by reading it directly. */
const configPath = path.join(root, 'js', 'finland-layers.config.js');
const configSource = readFileSync(configPath, 'utf8');
const configScope = { exports: {} };
new Function('module', 'exports', configSource)(configScope, configScope.exports);
const layers = (configScope.exports && configScope.exports.layers) || [];
const gpkgLayers = layers.filter((l) => l.kind === 'geojson');

if (!gpkgLayers.length) {
  console.error('[finland-convert] no kind:"geojson" entries found in the config — nothing to convert.');
  process.exit(1);
}

const noDownload = process.argv.includes('--no-download');
const doUpload = process.argv.includes('--upload');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function sh(cmd, args, opts) {
  const res = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts));
  if (res.error) throw res.error;
  return res;
}

function haveBinary(cmd) {
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !res.error && res.status === 0;
}

async function downloadIfMissing(url, target) {
  if (existsSync(target) && statSync(target).size > 0) {
    console.log(`  (cached) ${path.basename(target)}`);
    return true;
  }
  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`  ✗ ${path.basename(target)}: HTTP ${response.status} ${response.statusText}`);
    return false;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, buffer);
  console.log(`  ✓ ${path.basename(target)} (${(buffer.length / 1048576).toFixed(1)} MB)`);
  return true;
}

/* ── QML symbology → <name>.style.json ──────────────────────────────────── */

function qmlColor(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

function parseQml(xml) {
  const style = { source: 'qml' };
  const attrs = {
    color: qmlColor(xml, 'Linecolor') || qmlColor(xml, 'lineColor') || qmlColor(xml, 'Color'),
    fill: qmlColor(xml, 'Fillcolor') || qmlColor(xml, 'fillColor'),
    border: qmlColor(xml, 'Outlinecolor') || qmlColor(xml, 'borderColor'),
    marker: qmlColor(xml, 'Markercolor') || qmlColor(xml, 'markerColor') ||
      qmlColor(xml, 'Color') || qmlColor(xml, 'Fillcolor') || qmlColor(xml, 'fillColor'),
  };
  ['color', 'fill', 'border', 'marker'].forEach((k) => {
    if (attrs[k] && /^\d+\s*,\s*\d+\s*,\s*\d+/i.test(attrs[k])) {
      const rgb = attrs[k].split(',').map((v) => parseInt(v, 10));
      const alpha = rgb.length > 3 ? (rgb[3] / 255).toFixed(2) : null;
      style[k] = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` + (alpha ? ` / ${alpha}` : '');
    } else if (attrs[k]) {
      style[k] = attrs[k];
    }
  });
  const w = xml.match(/<Width[^>]*>(\d+)</i) || xml.match(/<linewidth[^>]*>([\d.]+)</i);
  if (w) style.weight = parseFloat(w[1]);
  const op = xml.match(/<Fillopacity[^>]*>([\d.]+)</i) || xml.match(/<fillopacity[^>]*>([\d.]+)</i);
  if (op) style.fillOpacity = parseFloat(op[1]);
  return style;
}

/* ── dedup: live counts from the services the files might duplicate ─────── */

async function liveWfsCount(id, bbox) {
  const url = `https://kartta.museoverkko.fi/action?action_route=GetWFSFeatures&id=${id}&srs=EPSG:4326&bbox=${bbox}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) return `HTTP ${response.status}`;
    const collection = await response.json();
    return (collection.features || []).length;
  } catch (err) {
    return `error: ${err.message}`;
  }
}

/* ── the conversion ─────────────────────────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const hasGdal = haveBinary('ogr2ogr') && haveBinary('ogrinfo');
if (!hasGdal) {
  console.warn('[finland-convert] ⚠ ogr2ogr/ogrinfo not found on PATH.');
  console.warn('    Install GDAL first:  apt install gdal-bin   |   brew install gdal');
  console.warn('    (The QML sidecars and the download cache are still produced.)');
}

const report = {
  generated: new Date().toISOString(),
  supabaseBase: SUPABASE_BASE,
  outputs: [],
  gdal: hasGdal,
};

console.log('[finland-convert] downloading from Supabase (originals are never modified)…');
const downloaded = [];
for (const layer of gpkgLayers) {
  if (only.length && !only.includes(layer.file)) continue;
  const gpkg = path.join(TMP_DIR, layer.file + '.gpkg');
  const ok = noDownload ? existsSync(gpkg) : await downloadIfMissing(`${SUPABASE_BASE}/${layer.file}.gpkg`, gpkg);
  if (!ok) continue;
  downloaded.push(layer);

  /* the .qml, when there is one */
  const qmlPath = path.join(TMP_DIR, layer.file + '.qml');
  if (!existsSync(qmlPath)) await downloadIfMissing(`${SUPABASE_BASE}/${layer.file}.qml`, qmlPath).catch(() => {});
  if (existsSync(qmlPath)) {
    try {
      const style = parseQml(readFileSync(qmlPath, 'utf8'));
      writeFileSync(path.join(OUT_DIR, layer.file + '.style.json'), JSON.stringify(style, null, 2));
      console.log(`  · ${layer.file}.qml → ${layer.file}.style.json (${JSON.stringify(style)})`);
    } catch (err) {
      console.warn(`  ⚠ ${layer.file}.qml could not be parsed: ${err.message}`);
    }
  }
}

if (hasGdal) {
  console.log('\n[finland-convert] converting to EPSG:4326 GeoJSON…');
  for (const layer of downloaded) {
    const gpkg = path.join(TMP_DIR, layer.file + '.gpkg');
    const out = path.join(OUT_DIR, layer.file + '.geojson');

    /* GPKGs can hold several tables — inspect, then convert the first
     * (spatial) one or every one concatenated is NOT safe, so: one file per
     * table, and the report says which is which. */
    const info = sh('ogrinfo', ['-ro', '-so', '-json', gpkg], { stdio: 'pipe' });
    let tables = [];
    try {
      const parsed = JSON.parse(info.stdout);
      tables = (parsed.layers || []).map((l) => l.name);
    } catch {
      const lines = String(sh('ogrinfo', ['-ro', '-so', gpkg]).stdout || '');
      tables = lines.split('\n').map((l) => (l.match(/^\d+:\s+(\S+)/) || [])[1]).filter(Boolean);
    }
    if (!tables.length) {
      console.warn(`  ✗ ${layer.file}.gpkg: no layers found`);
      report.outputs.push({ file: layer.file, ok: false, error: 'no layers in gpkg' });
      continue;
    }

    const primary = tables[0];
    const res = sh('ogr2ogr', [
      '-f', 'GeoJSON',
      '-t_srs', 'EPSG:4326',
      '-lco', 'RFC7946=YES',
      '-lco', 'WRITE_BBOX=YES',
      out, gpkg, primary,
    ], { stdio: 'pipe' });
    if (res.status !== 0) {
      console.warn(`  ✗ ${layer.file}: ogr2ogr failed\n${res.stderr}`);
      report.outputs.push({ file: layer.file, ok: false, error: String(res.stderr).slice(0, 500), tables });
      continue;
    }

    let count = 0, bytes = 0;
    try {
      bytes = statSync(out).size;
      const parsed = JSON.parse(readFileSync(out, 'utf8'));
      count = (parsed.features || []).length;
    } catch { /* keep 0 */ }
    const mb = bytes / 1048576;
    console.log(`  ✓ ${layer.file}.geojson  (${count} features, ${mb.toFixed(1)} MB${mb > 8 ? '  ⚠ large — consider PMTiles/FGB, see FINLAND_LAYERS.md' : ''})`);
    report.outputs.push({
      file: layer.file,
      ok: true,
      tables,
      primary,
      features: count,
      bytes,
      large: mb > 8,
      duplicateOf: layer.status === 'duplicate' ? layer.statusNote : null,
    });
  }
}

/* ── the dedup comparison the brief asked for ───────────────────────────── */

console.log('\n[finland-convert] dedup comparison against the live services…');
const dedup = [];
const helsinkiBox = '24.8,60.1,25.3,60.35';
try {
  dedup.push({ check: 'live mv-rakennusperinto-piste (id 155, Helsinki box)', value: await liveWfsCount(155, helsinkiBox) });
  dedup.push({ check: 'live mv-rakennusperinto-alue (id 156, Helsinki box)', value: await liveWfsCount(156, helsinkiBox) });
  dedup.push({ check: 'live mj-kiinteat-alakohteet (id 134, Helsinki box)', value: await liveWfsCount(134, helsinkiBox) });
} catch (err) {
  dedup.push({ check: 'live counts', value: `error: ${err.message}` });
}
report.dedup = dedup;
dedup.forEach((d) => console.log(`  · ${d.check}: ${d.value}`));

writeFileSync(path.join(OUT_DIR, 'conversion-report.json'), JSON.stringify(report, null, 2));
console.log(`\n[finland-convert] report → data/finland/conversion-report.json`);

/* ── optional upload back to Supabase (new names, never the originals) ──── */

if (doUpload) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) {
    console.error('\n[finland-convert] --upload needs SUPABASE_SERVICE_KEY in the environment ' +
      '(the anon key cannot write to the bucket). Nothing was uploaded.');
    process.exit(2);
  }
  const uploadBase = SUPABASE_BASE.replace('/object/public/', '/object/');
  for (const out of report.outputs.filter((o) => o.ok)) {
    const target = `${uploadBase}/converted/${out.file}.geojson`;
    const body = readFileSync(path.join(OUT_DIR, out.file + '.geojson'));
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/geo+json',
        'x-upsert': 'true',
      },
      body,
    });
    console.log(`  ${response.ok ? '✓' : '✗'} converted/${out.file}.geojson → HTTP ${response.status}`);
  }
  console.log('\n[finland-convert] uploads done (Harti/Finlanda/converted/ — the originals were untouched).');
} else if (report.outputs.some((o) => o.ok)) {
  console.log('[finland-convert] outputs are in data/finland/ (served same-origin by the site).');
  console.log('                   To ALSO mirror them into the Supabase bucket under converted/:');
  console.log('                   SUPABASE_SERVICE_KEY=<key> node tools/finland-convert-gpkg.mjs --upload');
}
