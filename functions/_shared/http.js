export function jsonError(status, error, headers = {}) {
  return Response.json({ error }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

export function optionsResponse(methods = 'GET, HEAD, OPTIONS', cors = false) {
  const headers = { 'Allow': methods };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = methods;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return new Response(null, { status: 204, headers });
}

export function headResponse(response) {
  return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

// Translate Netlify's CDN cache hint on reused shared helpers to Cloudflare's
// equivalent, while retaining the browser-facing Cache-Control directive.
export function cloudflareResponse(response) {
  const headers = new Headers(response.headers);
  const netlifyCache = headers.get('Netlify-CDN-Cache-Control');
  if (netlifyCache) {
    headers.set('Cloudflare-CDN-Cache-Control', netlifyCache);
    headers.delete('Netlify-CDN-Cache-Control');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function onlyReadMethods(request, { options = false, cors = false } = {}) {
  if (request.method === 'OPTIONS' && options) return optionsResponse('GET, HEAD, OPTIONS', cors);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonError(405, 'method_not_allowed', { Allow: options ? 'GET, HEAD, OPTIONS' : 'GET, HEAD' });
  }
  return null;
}
