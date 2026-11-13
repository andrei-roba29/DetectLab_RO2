import { handleTileRequest } from '../../_shared/map3d-tile.mjs';
import { cloudflareResponse, headResponse, onlyReadMethods } from '../../_shared/http.js';

async function handleRequest({ request, env, waitUntil }) {
  const methodError = await onlyReadMethods(request, { options: true, cors: true });
  if (methodError) return methodError;
  const response = cloudflareResponse(await handleTileRequest(request, { env, waitUntil }));
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Map3D-Proxy', 'cloudflare-pages-function');
  const withCors = new Response(response.body, { status: response.status, headers });
  return request.method === 'HEAD' ? headResponse(withCors) : withCors;
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
