import {
  EUROPE_BBOX,
  bboxIntersects,
  buildCatalogPayload,
  fetchCoronaCatalog,
  parseBbox
} from '../../../netlify/lib/corona-catalog.mjs';
import { cloudflareResponse, headResponse, onlyReadMethods } from '../../_shared/http.js';

const MEMORY_TTL_MS = 12 * 60 * 60 * 1000;
let cached = null;

async function getCatalog() {
  const now = Date.now();
  if (cached && now - cached.at < MEMORY_TTL_MS) return cached.catalog;
  try {
    const catalog = await fetchCoronaCatalog();
    cached = { at: now, catalog };
    return catalog;
  } catch (error) {
    if (cached) return cached.catalog;
    throw error;
  }
}

// The generated JSON is a static asset. It is intentionally also checked in
// when available, so this endpoint can return the last good catalogue if CAST
// is unavailable during a cold start or deployment.
async function staticSnapshot(request, bbox, assets) {
  if (!assets || typeof assets.fetch !== 'function') throw new Error('corona_snapshot_binding_unavailable');
  const assetUrl = new URL('/data/corona-europe-catalog.json', request.url);
  const response = await assets.fetch(assetUrl);
  if (!response.ok) throw new Error('corona_snapshot_unavailable');
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.blocks)) throw new Error('corona_snapshot_invalid');
  const blocks = snapshot.blocks
    .filter((block) => Array.isArray(block.extent) && bboxIntersects(block.extent, bbox))
    .map((block) => ({
      ...block,
      images: (block.images || []).filter((image) => Array.isArray(image.extent) && bboxIntersects(image.extent, bbox))
    }));
  return {
    ...snapshot,
    bbox,
    blocks,
    passes: blocks.length,
    frames: blocks.reduce((sum, block) => sum + block.images.length, 0)
  };
}

async function handleRequest({ request, env }) {
  const methodError = await onlyReadMethods(request, { options: true, cors: true });
  if (methodError) return methodError;
  const bbox = parseBbox(new URL(request.url).searchParams.get('bbox'), EUROPE_BBOX);
  let payload;
  try {
    payload = buildCatalogPayload(await getCatalog(), bbox);
  } catch {
    try {
      payload = await staticSnapshot(request, bbox, env?.ASSETS);
    } catch (error) {
      return Response.json({ error: String(error?.message || error) }, {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
      });
    }
  }
  const response = cloudflareResponse(Response.json(payload, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400'
    }
  }));
  return request.method === 'HEAD' ? headResponse(response) : response;
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
