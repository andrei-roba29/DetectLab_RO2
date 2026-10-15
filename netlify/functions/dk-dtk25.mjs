/*
 * netlify/functions/dk-dtk25.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Denmark · DTK25 topographic base map — token-adding, CDN-cached WMS proxy.
 *
 * Route (see netlify.toml):  GET /api/geo/dk-dtk25?service=WMS&request=GetMap&…
 *
 * api.dataforsyningen.dk refuses every imagery request without a token, and a
 * Dataforsyningen token is account-wide — there is no documented way to bind
 * one to a domain or an IP — so it must never be shipped to a browser. The map
 * asks this same-origin route, the token is added here as the `token` HTTP
 * header (the form Dataforsyningen's own documentation prefers, because the
 * secret stays out of URLs, access logs, Referer headers and history) and a
 * popular tile is fetched from the agency once for all visitors.
 *
 *   browser →  GET /api/geo/dk-dtk25?service=WMS&request=GetMap&…   (no token)
 *   Netlify →  GET https://api.dataforsyningen.dk/dtk_25_DAF?…
 *              token: <DATAFORSYNINGEN_TOKEN>
 *
 * The upstream URL, the LAYERS value and the cache policy come from
 * js/danish-layers.config.js — the same file the browser reads — so there is
 * exactly one description of this layer. See DATA_SOURCES.md (© Klimadatastyrelsen,
 * CC BY 4.0) and DANISH_LAYERS.md.
 *
 * Environment variable: DATAFORSYNINGEN_TOKEN
 */
import { dtk25Response, jsonProblem } from '../lib/danish-layers.mjs';

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
    const response = await dtk25Response(request);
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
};

export const config = {
    path: '/api/geo/dk-dtk25'
};
