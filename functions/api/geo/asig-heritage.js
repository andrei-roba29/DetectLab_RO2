import { asigHeritageResponse } from '../../_shared/asig-heritage.mjs';
import { headResponse } from '../../_shared/http.js';

async function handleRequest({ request }) {
  const response = await asigHeritageResponse(request);
  return request.method === 'HEAD' && response.status !== 405 ? headResponse(response) : response;
}

export async function onRequest(context) {
  const response = await handleRequest(context);
  return context.request.method === 'HEAD' ? headResponse(response) : response;
}
