/*
 * netlify/functions/dk-heritage.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Denmark · Fund og Fortidsminder (Slots- og Kulturstyrelsen) — bbox → GeoJSON.
 *
 * Route (see netlify.toml):
 *   GET /api/geo/dk-heritage?bbox=west,south,east,north[&layer=…][&maxFeatures=…]
 *
 * Why this route exists at all (it is not about a secret):
 *   • the official WFS publishes EPSG:25832 (UTM 32N) and, asked for a bbox in
 *     degrees, answers an EMPTY FeatureCollection instead of an error — a
 *     silent trap. This route converts the view bbox into EPSG:25832 for the
 *     query and returns the geometries in EPSG:4326, so Leaflet draws them
 *     without a projection plugin (verified against the live service);
 *   • the upstream host, layer and feature cap come from
 *     js/danish-layers.config.js, so this is an allow-list, not an open proxy;
 *   • a city-sized bbox can match thousands of polygons, so the answer is
 *     capped and cached instead of hammering the agency's server.
 *
 * Licence: CC0 1.0, © Slots- og Kulturstyrelsen — see DATA_SOURCES.md.
 * The third-party mirror (geoserver.witx.dk) is deliberately NOT used.
 */
import { heritageResponse, jsonProblem } from '../../backend/src/lib/danish-layers.mjs';

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
        return jsonProblem(405, 'method_not_allowed');
    }
    const response = await heritageResponse(request);
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
};

export const config = {
    path: '/api/geo/dk-heritage'
};
