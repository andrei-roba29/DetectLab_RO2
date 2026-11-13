#!/usr/bin/env node
/*
 * Generate the Europe-wide Corona catalogue used by the frontend and PWA.
 * Node >= 18 (global fetch); no npm dependencies.
 *
 * A failed/invalid CAST response never touches the destination. This lets a
 * deployed Pages build proceed without a new snapshot, while preserving any
 * last-known-good snapshot already present in the build checkout.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EUROPE_BBOX,
  buildCatalogPayload,
  fetchCoronaCatalog,
  parseBbox
} from '../netlify/lib/corona-catalog.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT_PATH = path.join(repoRoot, 'data/corona-europe-catalog.json');

function validExtent(extent) {
  return Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite) &&
    extent[0] >= -180 && extent[2] <= 180 && extent[1] >= -90 && extent[3] <= 90 &&
    extent[0] <= extent[2] && extent[1] <= extent[3];
}

/** Validate the exact slim shape consumed by CoronaAtlas before it is saved. */
export function validateCatalogSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('catalog_not_object');
  if (!validExtent(snapshot.bbox) || !Array.isArray(snapshot.blocks) || snapshot.blocks.length === 0) {
    throw new Error('catalog_missing_bbox_or_blocks');
  }
  if (typeof snapshot.generated !== 'string' || !Number.isFinite(Date.parse(snapshot.generated))) {
    throw new Error('catalog_generated_invalid');
  }

  let frames = 0;
  for (const block of snapshot.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id ||
        typeof block.location !== 'string' || !block.location || !validExtent(block.extent) ||
        !Array.isArray(block.images)) throw new Error('catalog_block_invalid');
    for (const image of block.images) {
      if (!image || typeof image.location !== 'string' || !image.location || !validExtent(image.extent)) {
        throw new Error('catalog_frame_invalid');
      }
      frames += 1;
    }
  }
  if (frames === 0) throw new Error('catalog_has_no_frames');
  if (snapshot.passes !== snapshot.blocks.length || snapshot.frames !== frames) {
    throw new Error('catalog_counts_mismatch');
  }
  return { passes: snapshot.blocks.length, frames };
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(bbox|out)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

/** Fetch, build, validate and atomically publish a snapshot. */
export async function buildStaticCatalog({
  outputPath = DEFAULT_OUTPUT_PATH,
  bbox = EUROPE_BBOX,
  fetchCatalog = fetchCoronaCatalog,
  now = () => new Date(),
  log = (message) => console.log(message),
  warn = (message) => console.warn(message)
} = {}) {
  let payload;
  try {
    const catalog = await fetchCatalog({ timeoutMs: 120000 });
    payload = buildCatalogPayload(catalog, bbox);
    payload.generated = now().toISOString();
    validateCatalogSnapshot(payload);
    // Check the serialized bytes too; this catches serialization regressions
    // before a deploy asset is changed.
    payload = JSON.parse(JSON.stringify(payload));
    validateCatalogSnapshot(payload);
  } catch (error) {
    let retained = false;
    try {
      const prior = JSON.parse(await fs.readFile(outputPath, 'utf8'));
      validateCatalogSnapshot(prior);
      retained = true;
    } catch { /* no valid prior snapshot; leave any file untouched */ }
    warn(`[Corona catalog] CAST refresh skipped (${error?.message || error}); ${retained ? 'kept the valid existing snapshot' : 'continuing without a snapshot'}.`);
    return { written: false, retained, error };
  }

  const serialized = JSON.stringify(payload);
  const directory = path.dirname(outputPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporaryPath, serialized, { flag: 'wx' });
    const reread = JSON.parse(await fs.readFile(temporaryPath, 'utf8'));
    validateCatalogSnapshot(reread);
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  const bytes = Buffer.byteLength(serialized);
  log(`[Corona catalog] wrote ${payload.passes} passes and ${payload.frames} frames (${bytes} bytes) to ${path.relative(repoRoot, outputPath)}`);
  return { written: true, retained: false, passes: payload.passes, frames: payload.frames, bytes, payload };
}

export async function main(argv = process.argv.slice(2)) {
  const nodeMajor = Number(String(process.versions.node || '').split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
    throw new Error(`Node.js 18 or newer is required (found ${process.versions.node || 'unknown'})`);
  }
  const args = parseArgs(argv);
  const bbox = parseBbox(args.bbox, EUROPE_BBOX);
  if (!validExtent(bbox)) throw new Error('Invalid --bbox; expected geographic minLon,minLat,maxLon,maxLat');
  const outputPath = path.resolve(repoRoot, args.out || 'data/corona-europe-catalog.json');
  return buildStaticCatalog({ outputPath, bbox });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`[Corona catalog] build failed: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
