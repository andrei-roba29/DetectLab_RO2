import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EUROPE_BBOX,
  buildCatalogPayload,
  fetchCoronaCatalog
} from '../../netlify/lib/corona-catalog.mjs';

function extentIsValid(extent) {
  return Array.isArray(extent) && extent.length === 4 && extent.every(Number.isFinite) &&
    extent[0] <= extent[2] && extent[1] <= extent[3];
}

/** Require a useful, internally consistent snapshot before it can replace one. */
export function validateCoronaSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('snapshot_not_object');
  if (!Array.isArray(snapshot.blocks) || snapshot.blocks.length === 0) throw new Error('snapshot_has_no_blocks');
  if (!extentIsValid(snapshot.bbox)) throw new Error('snapshot_bbox_invalid');
  if (!Number.isFinite(Date.parse(snapshot.generated))) throw new Error('snapshot_generated_invalid');
  let frames = 0;
  for (const block of snapshot.blocks) {
    if (!block || typeof block.id !== 'string' || !block.id ||
        typeof block.location !== 'string' || !block.location || !extentIsValid(block.extent) ||
        !Array.isArray(block.images)) throw new Error('snapshot_block_invalid');
    for (const image of block.images) {
      if (!image || typeof image.location !== 'string' || !image.location || !extentIsValid(image.extent)) {
        throw new Error('snapshot_image_invalid');
      }
      frames += 1;
    }
  }
  if (frames === 0) throw new Error('snapshot_has_no_frames');
  if (snapshot.passes !== snapshot.blocks.length || snapshot.frames !== frames) {
    throw new Error('snapshot_counts_mismatch');
  }
  return { passes: snapshot.blocks.length, frames };
}

async function readValidSnapshot(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const snapshot = JSON.parse(text);
    const counts = validateCoronaSnapshot(snapshot);
    return { snapshot, bytes: Buffer.byteLength(text), ...counts };
  } catch {
    return null;
  }
}

/**
 * Refresh a static catalogue without ever truncating a last-good snapshot.
 * The temp file and atomic rename happen only after upstream data is fetched,
 * clipped, and validated. A failed refresh retains a valid pre-existing file.
 */
export async function refreshCoronaSnapshot({
  filePath,
  fetchCatalog = fetchCoronaCatalog,
  now = () => new Date(),
  log = () => {}
} = {}) {
  if (!filePath) throw new Error('snapshot_path_required');
  let payload;
  try {
    payload = buildCatalogPayload(await fetchCatalog({ timeoutMs: 120000 }), EUROPE_BBOX);
    validateCoronaSnapshot(payload);
  } catch (error) {
    const existing = await readValidSnapshot(filePath);
    if (existing) {
      log(`CAST refresh failed; retaining valid snapshot (${existing.passes} passes, ${existing.frames} frames, ${existing.bytes} bytes)`);
      return { refreshed: false, retained: true, ...existing };
    }
    throw error;
  }

  payload.generated = now().toISOString();
  validateCoronaSnapshot(payload);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(payload), { flag: 'wx' });
    const written = await readValidSnapshot(temporary);
    if (!written) throw new Error('snapshot_written_invalid');
    await fs.rename(temporary, filePath);
    log(`Wrote ${written.passes} passes, ${written.frames} frames (${written.bytes} bytes)`);
    return { refreshed: true, retained: false, ...written };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedFile && pathToFileURL(invokedFile).href === import.meta.url) {
  const repoRoot = path.resolve(path.dirname(thisFile), '../..');
  const target = path.join(repoRoot, 'data/corona-europe-catalog.json');
  try {
    const result = await refreshCoronaSnapshot({
      filePath: target,
      log: (message) => console.log(`[Corona snapshot] ${message}`)
    });
    if (!result.refreshed) console.warn('[Corona snapshot] Using the prior validated catalogue; no upstream refresh was saved.');
  } catch (error) {
    console.error(`[Corona snapshot] No valid catalogue was written: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
