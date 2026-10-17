import express from 'express';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './logger.js';
import { pool } from './config/db.js';
import { runMigrations } from '../scripts/runMigrations.js';
import sitesRouter from './routes/sites.js';
import layersRouter from './routes/layers.js';
import clasateRouter from './routes/clasate.js';
import paymentsRouter from './routes/payments.js';
import promoRouter from './routes/promo.js';
import evidenceRouter from './routes/evidence.js';
import newsletterRouter from './routes/newsletter.js';
import geoProxyRouter from './routes/geoProxy.js';
import finlandProxyRouter from './routes/finlandProxy.js';
import { startScheduler } from './jobs/scheduler.js';
import { startEvidenceWorker } from './services/evidence/ingestionWorker.js';

const app = express();

app.use(cors()); // dev-friendly default: allows your React app on any localhost port to call this API
app.use(compression()); // gzip responses - cuts egress costs substantially on large GeoJSON payloads

// Stripe webhook signature verification needs the RAW body, so this must
// be mounted BEFORE express.json() consumes it.
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', sitesRouter);
app.use('/api', layersRouter);
app.use('/api', clasateRouter);
app.use('/api', paymentsRouter);
app.use('/api', promoRouter);
app.use('/api', evidenceRouter);
app.use('/api', newsletterRouter);
// Token-adding, caching proxy for Dataforsyningen (Denmark DHM hillshade).
// Keeps the Danish token server-side; see backend/src/routes/geoProxy.js.
app.use('/api', geoProxyRouter);
// Allow-listed same-origin proxy for the Finnish layers (MML WMTS/HKP MVT,
// museoverkko WFS, SYKE, Åland). Falls back for CORS/referrer-blocked
// requests and attaches MML_API_KEY server-side when configured.
// See backend/src/lib/finland-geo.mjs and FINLAND_LAYERS.md.
app.use('/api', finlandProxyRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * The evidence pipeline depends on the `knowledge.*` schema (migration 007).
 * A fresh deploy that only runs `npm start` (node src/app.js) would otherwise
 * hit `relation "knowledge.localities" does not exist` on every evidence
 * search and return a bare HTTP 500. On boot we run the (tracked, cheap)
 * migration set: it baselines pre-existing databases and applies any pending
 * migrations (fresh databases get the whole set). Failure is non-fatal: the
 * rest of the API (ArcGIS sites, payments, …) keeps serving, and evidence
 * requests surface a clear error.
 */
async function ensureDatabaseSchema() {
  try {
    await runMigrations(pool);
  } catch (err) {
    logger.error({ err }, 'ensureDatabaseSchema failed; continuing without migrations');
  }
}

ensureDatabaseSchema().finally(() => {
  app.listen(env.port, '0.0.0.0', () => {
    logger.info({ port: env.port }, 'DetectLab API listening');
    startScheduler();
    if (env.evidenceWorkerEnabled) startEvidenceWorker();
  });
});
