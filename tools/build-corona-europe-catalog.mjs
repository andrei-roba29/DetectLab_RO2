#!/usr/bin/env node
/*
 * tools/build-corona-europe-catalog.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Produces the STATIC snapshot of the Corona Atlas catalogue for Europe:
 *
 *     data/corona-europe-catalog.json
 *
 * The map (js/corona-wms-layer.js) prefers this file over the runtime proxy
 * (`/api/corona/rasters`): it is same-origin, CDN-cached, works offline in
 * the PWA and costs no function invocation. The proxy stays as the fallback
 * so the layer keeps working even if the snapshot is missing or stale.
 *
 * Usage:
 *     node tools/build-corona-europe-catalog.mjs
 *     node tools/build-corona-europe-catalog.mjs --bbox=-25,34,60,72
 *     node tools/build-corona-europe-catalog.mjs --out=data/corona-europe-catalog.json
 *
 * Requires: Node >= 18 (global fetch) and plain internet access to
 * corona.cast.uark.edu. No npm dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EUROPE_BBOX,
  buildCatalogPayload,
  fetchCoronaCatalog,
  parseBbox
} from '../netlify/lib/corona-catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const bbox = parseBbox(arg('bbox'), EUROPE_BBOX);
const outPath = path.resolve(repoRoot, arg('out', 'data/corona-europe-catalog.json'));

console.log(`Fetching the CAST Corona catalogue …`);
const catalog = await fetchCoronaCatalog({ timeoutMs: 120000 });
console.log(`  ${Object.keys(catalog).length} passes worldwide`);

const payload = buildCatalogPayload(catalog, bbox);
console.log(`Clipped to [${bbox.join(', ')}]: ${payload.passes} passes, ${payload.frames} frames`);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload));
const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
console.log(`Wrote ${path.relative(repoRoot, outPath)} (${sizeMb} MB)`);
