/*
 * netlify/functions/finland-geo.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Finland · the same-origin proxy for the Finnish layers (see
 * backend/src/lib/finland-geo.mjs for the full allow-list story).
 *
 * Route (see netlify.toml):  GET /api/geo/finland?src=…
 *
 * The Finnish endpoints answer direct browser requests in most cases (plain
 * <img> tiles need no CORS), but karttamoottori.maanmittauslaitos.fi blocks
 * some clients and none of the Finnish hosts send CORS headers — which the
 * canvas mosaics, the MVT decoder and the WFS/GetFeatureInfo fetches need.
 * The map therefore tries every URL directly first and falls back to this
 * same-origin route, which relays it server-side. With MML_API_KEY set, the
 * src=mml-hillshade-open source additionally serves the official
 * avoin-karttakuva WMTS with the key attached here, never in a browser.
 *
 *   browser →  GET /api/geo/finland?src=mml-hillshade&z=11&col=984&row=1306
 *   Netlify →  GET https://karttamoottori.maanmittauslaitos.fi/maasto/wmts/1.0.0/
 *              korkeusmalli_vinovalo/default/ETRS-TM35FIN/11/1306/984.png
 *
 * Environment variable (optional): MML_API_KEY
 * See FINLAND_LAYERS.md and DATA_SOURCES.md (© Maanmittauslaitos, CC BY 4.0).
 */
import { finlandGeoResponse, jsonProblem } from '../../backend/src/lib/finland-geo.mjs';

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonProblem(405, 'method_not_allowed');
  }
  const response = await finlandGeoResponse(request);
  if (request.method === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
};

export const config = {
  path: '/api/geo/finland',
};
