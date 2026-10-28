import { Router } from 'express';

// The Python sidecar is local-only. Do not allow caller-controlled upstream URLs.
const router = Router();
router.get('/rvt/metadata', forward);
router.get('/rvt/profile/:layer', forward);
router.get('/rvt/tile/:layer/:method/:z/:x/:y', forward);
async function forward(req, res) {
  if (!process.env.RVT_SIDECAR_URL) {
    return res.status(503).json({ error: 'RVT raw DTM service is not configured on this deployment' });
  }
  const path = req.path.replace(/^\/rvt\//, '/');
  if (!/^\/(metadata|profile\/[a-zA-Z0-9_-]+|tile\/[a-zA-Z0-9_-]+\/[a-z0-9-]+\/\d{1,2}\/\d{1,9}\/\d{1,9}\.bin)$/.test(path)) {
    return res.status(400).json({ error: 'Invalid tile path' });
  }
  const query = new URLSearchParams();
  for (const name of ['lat1', 'lon1', 'lat2', 'lon2']) {
    if (req.query[name] !== undefined) {
      if (typeof req.query[name] !== 'string' || !/^-?\d{1,3}(?:\.\d{1,8})?$/.test(req.query[name]))
        return res.status(400).json({ error: 'Invalid profile coordinate' });
      query.set(name, req.query[name]);
    }
  }
  for (const name of ['smoothing', 'smallest', 'largest', 'scaling', 'mode']) {
    if (req.query[name] !== undefined) {
      if (typeof req.query[name] !== 'string' || (name === 'mode'
        ? !['positive', 'negative'].includes(req.query[name])
        : !/^\d{1,4}(?:\.\d{1,3})?$/.test(req.query[name]))) {
        return res.status(400).json({ error: 'Invalid measure' });
      }
      query.set(name, req.query[name]);
    }
  }
  try {
    const upstream = new URL(path + (query.toString() ? '?' + query : ''), process.env.RVT_SIDECAR_URL);
    const response = await fetch(upstream, { signal: AbortSignal.timeout(45000) });
    res.status(response.status).type(response.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', response.ok && path.startsWith('/tile/') ? 'public, max-age=3600' : 'no-store');
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(503).json({ error: 'RVT service unavailable' });
  }
}
export default router;
