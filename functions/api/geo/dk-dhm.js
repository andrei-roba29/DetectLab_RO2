import { headResponse, onlyReadMethods } from '../../_shared/http.js';

const LAYER_UPSTREAM = new Map([
  ['dhm_terraen_skyggekort', 'https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF'],
  ['dhm_overflade_skyggekort', 'https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF']
]);
const DEFAULT_UPSTREAM = LAYER_UPSTREAM.get('dhm_terraen_skyggekort');
const ALLOWED_FORMATS = new Set(['image/jpeg']);
const ALLOWED_REQUESTS = new Set(['gettile', 'getcapabilities']);
const STRIPPED_PARAMS = new Set(['token', 'apikey', 'username', 'password']);
function param(params, name) {
  for (const [key, value] of params) if (key.toLowerCase() === name) return value;
  return '';
}
function problem(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function handleRequest({ request, env }) {
  const methodError = await onlyReadMethods(request, { options: true });
  if (methodError) return methodError;
  const token = env.DATAFORSYNINGEN_TOKEN;
  if (!token) return problem(401, 'dataforsyningen_token_missing');
  const incoming = new URL(request.url).searchParams;
  const wmtsRequest = param(incoming, 'request').toLowerCase();
  if (!ALLOWED_REQUESTS.has(wmtsRequest)) return problem(400, 'unsupported_request');
  let target = DEFAULT_UPSTREAM;
  if (wmtsRequest === 'gettile') {
    const layer = param(incoming, 'layer');
    if (!LAYER_UPSTREAM.has(layer)) return problem(400, 'layer_not_allowed');
    target = LAYER_UPSTREAM.get(layer);
    if (!ALLOWED_FORMATS.has(param(incoming, 'format'))) return problem(400, 'format_not_allowed');
    if (param(incoming, 'tilematrixset').toLowerCase() !== 'view1') return problem(400, 'tilematrixset_not_allowed');
    const matrix = Number(param(incoming, 'tilematrix').replace(/^View1:/i, ''));
    const col = Number(param(incoming, 'tilecol'));
    const row = Number(param(incoming, 'tilerow'));
    const valid = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
    if (!valid(matrix, 13) || !valid(col, 17187) || !valid(row, 17187)) return problem(400, 'bad_tile_index');
  } else {
    const layer = param(incoming, 'layer');
    if (layer && LAYER_UPSTREAM.has(layer)) target = LAYER_UPSTREAM.get(layer);
  }
  const upstream = new URL(target);
  for (const [key, value] of incoming) if (!STRIPPED_PARAMS.has(key.toLowerCase())) upstream.searchParams.set(key, value);
  let upstreamRes;
  try { upstreamRes = await fetch(upstream, { headers: { token } }); }
  catch { return problem(502, 'upstream_unreachable'); }
  const type = upstreamRes.headers.get('content-type') || 'application/octet-stream';
  const bytes = new Uint8Array(await upstreamRes.arrayBuffer());
  if (!upstreamRes.ok || type.includes('xml') || type.includes('html')) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2000));
    const unauthorized = upstreamRes.status === 401 || upstreamRes.status === 403 || /not authori[sz]ed|unauthorized|invalid token/i.test(head);
    return problem(unauthorized ? 401 : 502, unauthorized ? 'dataforsyningen_token_invalid' : 'upstream_error');
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
