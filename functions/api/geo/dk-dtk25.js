import { dtk25Response } from '../../_shared/danish-layers.mjs';
import { cloudflareResponse, headResponse, onlyReadMethods } from '../../_shared/http.js';
async function handleRequest({ request, env }) {
  const methodError = await onlyReadMethods(request, { options: true });
  if (methodError) return methodError;
  const response = cloudflareResponse(await dtk25Response(request, { env }));
  return request.method === 'HEAD' ? headResponse(response) : response;
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
