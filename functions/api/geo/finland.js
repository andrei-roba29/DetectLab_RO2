import { finlandGeoResponse } from '../../_shared/finland-geo.mjs';
import { headResponse } from '../../_shared/http.js';
async function handleRequest({ request, env }) {
  return finlandGeoResponse(request, { env });
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
