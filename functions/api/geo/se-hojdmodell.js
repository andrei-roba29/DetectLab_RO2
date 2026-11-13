import { headResponse, onlyReadMethods } from '../../_shared/http.js';

const UPSTREAM_DEFAULT = 'https://maps.lantmateriet.se/hojdmodell/wms/v1.1';
const ALLOWED_LAYERS = new Set(['terrangskuggning', 'terranglutning', 'terranglutning_brunton', 'ursprung_kvalitet']);
const ALLOWED_FORMATS = new Set(['image/png', 'image/jpeg', 'image/png; mode=8bit']);
const ALLOWED_REQUESTS = new Set(['getmap', 'getcapabilities']);
const STRIPPED_PARAMS = new Set(['token', 'user', 'pass', 'password', 'authorization']);
function param(params, name) {
  for (const [key, value] of params) if (key.toLowerCase() === name) return value;
  return '';
}
function problem(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}
function authHeader(env) {
  if (env.LANTMATERIET_WMS_TOKEN) return `Bearer ${env.LANTMATERIET_WMS_TOKEN}`;
  const user = env.LANTMATERIET_WMS_USER;
  const password = env.LANTMATERIET_WMS_PASSWORD;
  if (user && password) {
    const bytes = new TextEncoder().encode(`${user}:${password}`);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }
  return null;
}

async function handleRequest({ request, env }) {
  const methodError = await onlyReadMethods(request, { options: true });
  if (methodError) return methodError;
  const authorization = authHeader(env);
  if (!authorization) return problem(401, 'lantmateriet_credentials_missing');
  const incoming = new URL(request.url).searchParams;
  const wmsRequest = param(incoming, 'request').toLowerCase();
  if (!ALLOWED_REQUESTS.has(wmsRequest)) return problem(400, 'unsupported_request');
  if (wmsRequest === 'getmap') {
    const layers = param(incoming, 'layers');
    if (!layers || !layers.split(',').every((layer) => ALLOWED_LAYERS.has(layer.trim()))) return problem(400, 'layer_not_allowed');
    if (!ALLOWED_FORMATS.has(param(incoming, 'format'))) return problem(400, 'format_not_allowed');
    const width = Number(param(incoming, 'width'));
    const height = Number(param(incoming, 'height'));
    if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024)) return problem(400, 'bad_image_size');
  }
  let upstream;
  try { upstream = new URL(env.LANTMATERIET_WMS_URL || UPSTREAM_DEFAULT); }
  catch { return problem(500, 'invalid_upstream_configuration'); }
  if (upstream.protocol !== 'https:' || upstream.hostname !== 'maps.lantmateriet.se') return problem(500, 'invalid_upstream_configuration');
  for (const [key, value] of incoming) if (!STRIPPED_PARAMS.has(key.toLowerCase())) upstream.searchParams.set(key, value);
  let upstreamRes;
  try { upstreamRes = await fetch(upstream, { headers: { authorization } }); }
  catch { return problem(502, 'upstream_unreachable'); }
  const type = upstreamRes.headers.get('content-type') || 'application/octet-stream';
  const bytes = new Uint8Array(await upstreamRes.arrayBuffer());
  if (!upstreamRes.ok || type.includes('xml') || type.includes('html')) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2000));
    const unauthorized = upstreamRes.status === 401 || upstreamRes.status === 403 || /authorization required|not authori[sz]ed|unauthorized/i.test(head);
    return problem(unauthorized ? 401 : 502, unauthorized ? 'lantmateriet_credentials_invalid' : 'upstream_error');
  }
  const response = new Response(bytes, {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable, s-maxage=604800, stale-while-revalidate=86400' }
  });
  return request.method === 'HEAD' ? headResponse(response) : response;
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
