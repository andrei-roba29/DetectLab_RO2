#!/usr/bin/env node
'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { resolveSiteOrigin } from './backend/src/utils/siteOrigin.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function loadSiteConfig(hostname, storedLanguage = null, pathname = '/') {
  const documentElement = { lang: 'ro' };
  const document = {
    documentElement,
    readyState: 'loading',
    addEventListener() {},
    querySelectorAll() { return []; },
  };
  const window = {
    location: { hostname, pathname },
    localStorage: { getItem() { return storedLanguage; } },
  };
  const context = vm.createContext({ window, document });
  vm.runInContext(read('js/site-config.js'), context, { filename: 'js/site-config.js' });
  return { window, document };
}

console.log('[Test] detectlab.eu dual-domain setup...');

{
  const { window, document } = loadSiteConfig('detectlab.eu');
  assert.equal(window.DetectLabSite.market, 'eu');
  assert.equal(window.DetectLabSite.defaultLanguage, 'en');
  assert.equal(window.DetectLabSite.contactEmail, 'contact@detectlab.eu');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(
    window.DetectLabSite.interpolate('Open {{site_domain}} / {{contact_email}}'),
    'Open detectlab.eu / contact@detectlab.eu',
  );
}

{
  const { window, document } = loadSiteConfig('www.detectlab.ro');
  assert.equal(window.DetectLabSite.market, 'ro');
  assert.equal(window.DetectLabSite.defaultLanguage, 'ro');
  assert.equal(window.DetectLabSite.contactEmail, 'contact@detectlab.ro');
  assert.equal(document.documentElement.lang, 'ro');
}

{
  const { document } = loadSiteConfig('detectlab.eu', 'ro');
  assert.equal(document.documentElement.lang, 'ro', 'an explicit visitor choice wins over the domain default');
}

{
  const source = read('js/translations.js');
  assert.match(source, /DetectLabSite\s*&&\s*window\.DetectLabSite\.defaultLanguage/);
  assert.match(source, /\{\{site_domain\}\}/);
  assert.match(source, /\{\{contact_email\}\}/);
}

{
  const source = read('js/map-app.js');
  assert.doesNotMatch(source, /maxBounds\s*:\s*MAP_PAN_BOUNDS/);
  assert.doesNotMatch(source, /panInsideBounds\(MAP_PAN_BOUNDS/);
  assert.doesNotMatch(source, /maxBoundsViscosity\s*:/);
  assert.match(source, /\.fitBounds\(APM_BOUNDS\)/, 'Romania remains the initial view');

  // Roman Empire & DARE on .eu vs .ro:
  assert.match(source, /function _isEuropeMarket\(\)/, 'map-app checks for .eu market');
  assert.match(source, /if \(_isEuropeMarket\(\)\) return true;/, 'Roman features in bounds returns true for .eu (full original scale)');
  assert.match(source, /if \(!cc && !_isEuropeMarket\(\)\) cc = 'RO';/, 'DARE defaults to Romania only on the .ro market');
  assert.match(source, /var ccParam = cc \? '&cc=' \+ encodeURIComponent\(cc\) : '';/, 'an explicit DARE country filter is optional on .eu');

  // Vegetation Fingerprint (Amprenta Vegetației) on .eu vs .ro:
  assert.match(source, /VEGFP_EU_TILE_BOUNDS/, 'VEGFP European tile bounds defined');
  assert.match(source, /_vegfpCurrentTileBounds\(\)/, 'Tile layers use dynamic current tile bounds based on market');
  assert.match(source, /!_isEuropeMarket\(\) && !_vegfpTileInRomania/, 'Tile loader skips Romania mask when on .eu');

  // Base Layer Satellite with Historical Years (Copernicus VHR 2012, 2018, 2021 + Esri):
  assert.match(source, /var SAT_HIST_PERIODS\s*=\s*\{/, 'Satellite historical period mosaics are registered');
  assert.match(source, /window\.setSatPeriod\s*=\s*function/, 'setSatPeriod is available for period switching');
  assert.match(source, /SAT_PERIOD_ORDER\s*=\s*\[\s*'2012',\s*'2018',\s*'2021',\s*'prezent'\s*\]/, 'All historical base years (2012, 2018, 2021, 2025) are configured');

  // 1960s Satellite Imagery (CORONA) European scale on .eu:
  assert.match(source, /premiumMapCoverageBounds\.satellite60s/, 'Satellite 60s coverage bounds configured dynamically');
  assert.match(source, /satellite60s:\s*\{[\s\S]*?bounds:\s*\[\[34\.0,\s*-25\.0\],\s*\[72\.0,\s*60\.0\]\]/, 'Satellite 60s country coverage uses the full European CORONA catalogue extent');
}

{
  const html = read('index.html');
  assert.match(html, /site-config\.js\?v=20260928-eu-domain/);
  assert.match(html, /hreflang="ro" href="https:\/\/detectlab\.ro\//);
  assert.match(html, /hreflang="en" href="https:\/\/detectlab\.eu\//);
  assert.match(html, /data-site-contact/);
}

{
  const config = read('netlify.toml');
  assert.match(config, /www\.detectlab\.eu\/\*/);
  assert.match(config, /https:\/\/detectlab\.eu\/:splat/);
  assert.doesNotMatch(config, /from\s*=\s*"https:\/\/detectlab\.eu\/\*"[\s\S]*?to\s*=\s*"https:\/\/detectlab\.ro/);
}

{
  const allowedOrigins = ['https://detectlab.ro', 'https://detectlab.eu'];
  assert.equal(resolveSiteOrigin({
    requestOrigin: 'https://detectlab.eu',
    allowedOrigins,
    configuredSiteUrl: 'https://detectlab.ro',
  }), 'https://detectlab.eu', '.eu checkout returns to .eu');

  assert.equal(resolveSiteOrigin({
    requestOrigin: 'https://evil.example',
    allowedOrigins,
    configuredSiteUrl: 'https://detectlab.ro',
  }), 'https://detectlab.ro', 'an untrusted Origin cannot become a Stripe redirect');

  assert.equal(resolveSiteOrigin({
    requestOrigin: 'http://localhost:8080',
    allowedOrigins,
    configuredSiteUrl: 'https://detectlab.ro',
    allowLocalhost: true,
  }), 'http://localhost:8080', 'localhost remains usable outside production');
}

console.log('✓ detectlab.eu domain, language, map navigation and payment-origin checks passed');
