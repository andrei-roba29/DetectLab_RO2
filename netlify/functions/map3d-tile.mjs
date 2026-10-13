/*
 * netlify/functions/map3d-tile.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Same-origin tile proxy for the 3D terrain view.
 *
 * Route (see netlify.toml):  GET /api/map3d/tile?layer=<id>&z=&x=&y=[&t=][&p=]
 *
 * It exists because MapLibre GL JS loads raster tiles with
 * `crossOrigin = "anonymous"`, so every host that does not send
 * `Access-Control-Allow-Origin` yields no tile at all in 3D, even though the
 * same layer works fine as a plain <img> tile in the 2D Leaflet map. It also
 * re-projects tile bboxes for the two historical sheets that only exist in
 * EPSG:2180. Everything it is allowed to fetch comes from the shared layer
 * registry (js/layer-registry.js) — it is not an open proxy.
 *
 * No keys, tokens or secrets are handled here: the credentialed sources
 * (Lantmäteriet, Dataforsyningen) keep their own functions
 * (/api/geo/se-hojdmodell, /api/geo/dk-dhm).
 */
import { handleTileRequest } from '../lib/map3d-tile.mjs';

export default async (request) => {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(JSON.stringify({ error: 'method-not-allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    const response = await handleTileRequest(request);
    const headers = new Headers(response.headers);
    /* Same-origin in practice; the header keeps the response usable if the 3D
     * view is ever embedded elsewhere. */
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('X-Map3D-Proxy', 'netlify-function');
    return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        headers
    });
};

export const config = {
    path: '/api/map3d/tile'
};
