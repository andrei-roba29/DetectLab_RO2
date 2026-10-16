/*
 * netlify/functions/dk-orto.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Denmark · GeoDanmark spring orthophoto WMS years — credential-adding proxy.
 *
 * Route (see netlify.toml):  GET /api/geo/dk-orto?service=WMS&request=GetMap&…
 *
 * Datafordeleren serves the orthophoto only to an identified service user
 * (Tjenestebruger). Those credentials are deployment secrets, so the browser
 * asks this same-origin route and the username/password are added here.
 *
 *   browser →  GET /api/geo/dk-orto?service=WMS&request=GetMap&…    (no credentials)
 *   Netlify →  GET https://services.datafordeler.dk/…/WMS?…&username=…&password=…
 *
 * The layer name (a year!) lives in js/danish-layers.config.js, so publishing a
 * new orthophoto year is a one-line change there — no code change here.
 *
 * Environment variables: DATAFORDELER_USER, DATAFORDELER_PASSWORD
 * Licence: CC BY 4.0, © Klimadatastyrelsen / GeoDanmark — see DATA_SOURCES.md.
 */
import { ortoResponse, jsonProblem } from '../../backend/src/lib/danish-layers.mjs';

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
    const response = await ortoResponse(request);
    if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: response.headers });
    return response;
};

export const config = {
    path: '/api/geo/dk-orto'
};
