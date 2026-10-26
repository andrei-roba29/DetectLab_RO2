/* Bounded, same-origin ASIG WFS queries. Never download the national dataset.
 * WFS availability is upstream-dependent; errors are explicit, not an empty map.
 * Polygons are represented by bbox centres (not guaranteed interior points). */
const BAKED = new Set([
  'akzm:zonat_mbrojtura_081124', 'akzm:monumentet_natyrore_07032023',
  'iktk:zonatembrojturatetrashegimisekulturore_pike13_05_2026',
  'iktk:zonatembrojturatetrashegimisekulturore22_07_2026',
]);
const problem = (status, error) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
export function representativePoint(geometry) {
  if (!geometry) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, vertices = 0;
  function walk(c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (++vertices > 100000) throw new Error('geometry_limit');
      const [x, y] = c;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) throw new Error('invalid_coordinates');
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    } else c.forEach(walk);
  }
  if (geometry.type === 'GeometryCollection') return null;
  walk(geometry.coordinates);
  return Number.isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null;
}
export async function asigHeritageResponse(request, fetcher = fetch) {
  if (request.method !== 'GET') return problem(405, 'method_not_allowed');
  const input = new URL(request.url).searchParams;
  const layer = input.get('layer') || '';
  // Archaeology names are discovered from WMS capabilities by the client.
  if (!BAKED.has(layer) && !/^[a-zA-Z0-9_]+:[a-zA-Z0-9_]*(?:archaeolog|archeolog|arkeolog)[a-zA-Z0-9_]*$/i.test(layer)) return problem(400, 'invalid_layer');
  const raw = input.get('bbox') || '';
  const bbox = raw.split(',').map(Number);
  if (bbox.length !== 4 || raw.split(',').some(v => !v.trim()) || !bbox.every(Number.isFinite) ||
      bbox[0] < 19 || bbox[1] < 39 || bbox[2] > 21.2 || bbox[3] > 43 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return problem(400, 'invalid_bbox');
  const url = new URL('https://geoportal.asig.gov.al/service/wfs');
  // WFS 1.0 + EPSG:4326 uses longitude,latitude; no WFS 1.1 axis ambiguity.
  url.search = new URLSearchParams({ service: 'WFS', version: '1.0.0', request: 'GetFeature',
    typeName: layer, outputFormat: 'application/json', srsName: 'EPSG:4326',
    bbox: bbox.join(',') + ',EPSG:4326', maxFeatures: '150' }).toString();
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 10000);
  let reader;
  try {
    if (request.signal?.aborted) controller.abort();
    const upstream = await fetcher(url.toString(), { signal: controller.signal, redirect: 'error' });
    if (!upstream.ok) return problem(502, 'asig_wfs_unavailable');
    if (Number(upstream.headers.get('content-length')) > 2000000) { await upstream.body?.cancel(); return problem(502, 'asig_response_too_large'); }
    reader = upstream.body.getReader();
    const chunks = []; let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2000000) { await reader.cancel(); return problem(502, 'asig_response_too_large'); }
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) return problem(502, 'asig_wfs_unsupported');
    const features = data.features.slice(0, 150).map((feature, index) => {
      const point = representativePoint(feature.geometry);
      if (!point) return null;
      const props = feature.properties || {};
      const title = Object.entries(props).find(([key, value]) => /name|emer|emri|title|objekt/i.test(key) && typeof value === 'string');
      return { type: 'Feature', id: layer + '/' + (feature.id ?? index),
        geometry: { type: 'Point', coordinates: point },
        properties: { title: String(title?.[1] || layer).slice(0, 200), source: layer,
          representative: feature.geometry.type !== 'Point' } };
    }).filter(Boolean);
    return Response.json({ type: 'FeatureCollection', features, truncated: data.features.length >= 150 },
      { headers: { 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return problem(502, controller.signal.aborted ? 'asig_timeout' : 'asig_wfs_unavailable');
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}
