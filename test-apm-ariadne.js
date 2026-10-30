#!/usr/bin/env node
'use strict';
// No live network. API fixtures follow ARIADNE-Infrastructure/portal's public search contract.
// node test-apm-ariadne.js
// Optional DOM integration: install jsdom externally and set NODE_PATH to its node_modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sites = require('./js/apm-next/apm-sites.js');
const providers = require('./js/apm-next/apm-providers.js');
const pipeline = require('./js/apm-next/apm-pipeline.js');
const centre = { lat: 46.77, lon: 23.59 };
function hit(id, lat = centre.lat, lon = centre.lon, extra = {}) {
    return { id: String(id), data: { resourceType: 'Site/monument',
        derivedSubject: [{ id: 'http://vocab.getty.edu/aat/300444153', prefLabel: 'settlements (sites of small communities)' }],
        spatial: [{ geopoint: { lat, lon } }],
        temporal: [{ periodName: 'Roman', from: 100, until: 400 }], ...extra } };
}
const response = (hits, total = hits.length) => ({ ok: true, json: async () => ({ hits, total: { value: total, relation: 'eq' } }) });
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('  ok  ' + name); }
async function main() {
    await test('canonical points preserve numeric periods and unknown accuracy; no polygon centroids or documents', () => {
        const records = sites.parseAriadneHits([hit('a'), hit('b', null), hit('c', 91),
            hit('d', 46, 23, { resourceType: 'Collection' }),
            hit('e', 46, 23, { spatial: [{ boundingbox: 'POLYGON(...)' }] })]);
        assert.equal(records.length, 1);
        assert.equal(records[0].periodStart, 100);
        assert.equal(records[0].periodEnd, 400);
        assert.equal(records[0].positionAccuracy, null);
        assert.equal(records[0].type, 'settlement');
        assert.match(records[0].url, /resource\/a$/);
    });
    await test('BCE, year zero and undated labels do not use publication dates', () => {
        const records = sites.parseAriadneHits([
            hit('a', 46.77, 23.59, { temporal: { periodName: 'Ancient', from: -500, until: 0 } }),
            hit('b', 46.78, 23.59, { temporal: [{ periodName: 'Bronze Age' }], issued: '2026-10-30' }),
            hit('c', 46.79, 23.59, { temporal: [{ periodName: 'Bad date', from: '', until: null }] })]);
        assert.equal(records[0].periodEnd, 0);
        assert.equal(records[0].periodStart, -500);
        assert.equal(records[1].periodStart, null);
        assert.equal(records[1].periodLabel, 'Bronze Age');
        assert.equal(records[2].periodStart, null);
        const dated = sites.filterSites(records, { center: centre, period: { start: -500, end: 0 } });
        assert.equal(dated.sites.length, 1);
        assert.equal(dated.dropped.undated, 2);
    });
    await test('Ariadne pool permits unknown accuracy, excludes approximation flags and de-duplicates; CSV remains strict', () => {
        const approximate = hit('approx', 46.78);
        approximate.data.spatial[0].coordinatePrecision = 'approximate';
        const records = sites.parseAriadneHits([hit('a'), hit('duplicate'), approximate]);
        records.push({ ...records[0], id: 'csv', lat: 46.79, source: 'csv' });
        const pool = pipeline.sitePool(records, centre);
        assert.equal(pool.pool.length, 1);
        assert.equal(pool.dropped.accuracy, 2);
        assert.equal(pool.dropped.duplicate, 1);
    });
    await test('only controlled settlement subjects qualify, not cemeteries, monuments or mentions in titles', () => {
        const records = sites.parseAriadneHits([
            hit('village', 46.77, 23.59, { derivedSubject: [{ id: '300008372', prefLabel: 'villages' }] }),
            hit('town', 46.78, 23.59, { derivedSubject: [{ prefLabel: 'towns' }] }),
            hit('cemetery', 46.79, 23.59, { title: { text: 'Cemetery next to a Roman settlement' }, derivedSubject: [{ prefLabel: 'cemeteries' }] }),
            hit('monument', 46.80, 23.59, { derivedSubject: [{ prefLabel: 'monuments' }] }),
            hit('unclassified', 46.81, 23.59, { derivedSubject: [] })
        ]);
        assert.deepEqual(records.map(r => r.id), ['village:0', 'town:0']);
        assert.ok(records.every(r => r.type === 'settlement'));
    });
    await test('individual local occupation periods are selectable, including named-only dates; gaps are not occupations', () => {
        const records = sites.parseAriadneHits([
            hit('multi', 46.77, 23.59, { temporal: [
                { periodName: 'Roman', from: 100, until: 400 },
                { periodName: 'Medieval', from: 1000, until: 1200 },
                { periodName: 'Bronze Age' }
            ] }),
            hit('otherRoman', 46.78, 23.59),
            hit('outside', 48, 24, { temporal: [{ periodName: 'Outside-only period', from: -9000, until: -8000 }] }),
            hit('cemetery', 46.79, 23.59, { derivedSubject: [{ prefLabel: 'cemeteries' }], temporal: [{ periodName: 'Cemetery-only period', from: -5000, until: -4000 }] })
        ]);
        const groups = pipeline.sitePool(records, centre).periods;
        assert.deepEqual(groups.map(g => g.label).sort(), ['Bronze Age', 'Medieval', 'Roman']);
        assert.equal(groups.find(g => g.label === 'Roman').count, 2);
        const bronze = groups.find(g => g.label === 'Bronze Age');
        assert.equal(bronze.selectable, true);
        assert.equal(bronze.undated, true);
        assert.equal(sites.filterSites(records, { center: centre, period: bronze }).sites.length, 1);
        assert.equal(sites.filterSites(records, { center: centre, period: { start: 600, end: 800 } }).sites.length, 0,
            'no fabricated habitation between Roman and medieval phases');
        const medieval = groups.find(g => g.label === 'Medieval');
        assert.equal(sites.filterSites(records, { center: centre, period: medieval }).sites.length, 1);
    });
    await test('spatial deduplication retains phases from separate records without mutating the source pool', () => {
        const records = sites.parseAriadneHits([
            hit('roman'), hit('medieval', centre.lat, centre.lon, { temporal: [{ periodName: 'Medieval', from: 1000, until: 1200 }] })
        ]);
        const pool = pipeline.sitePool(records, centre);
        assert.equal(pool.pool.length, 1);
        assert.deepEqual(pool.periods.map(g => g.label), ['Roman', 'Medieval']);
        assert.equal(records[0].periods.length, 1);
        assert.equal(sites.filterSites(records, { center: centre, period: pool.periods[1] }).sites.length, 1);
    });
    await test('settlement subject queries are unioned without double-counting the same resource', async () => {
        const queries = [];
        providers.setFetch(async url => {
            const u = new URL(url); queries.push(u.searchParams.get('derivedSubject'));
            return response([hit('same-resource')]);
        });
        const records = await providers.createAriadneSiteProvider().getSites(centre, 50);
        assert.equal(records.length, 1);
        assert.deepEqual(queries, sites.ARIADNE_SETTLEMENT_FILTERS);
    });
    await test('all raw search pages are loaded with portal bbox ordering, then circle-filtered', async () => {
        const urls = [];
        providers.setFetch(async (url) => {
            const u = new URL(url); urls.push(u);
            if (u.searchParams.get('derivedSubject') === 'settlements (sites of small communities)') return response([]);
            if (urls.length === 1) return response(Array.from({ length: 50 }, (_, i) => hit(i + 1, 46.77 + i * 0.001)), 51);
            return response([hit('outside', 46.77 + 0.44, 23.59 + 0.64)], 51);
        });
        const records = await providers.createAriadneSiteProvider().getSites(centre, 50);
        assert.equal(records.length, 50);
        assert.equal(urls.length, 3);
        const u = urls[0];
        assert.equal(u.origin, 'https://ariadne-portal.d4science.org');
        assert.equal(u.pathname, '/api/search');
        assert.equal(u.searchParams.get('resourceType'), 'Site/monument');
        assert.equal(u.searchParams.get('derivedSubject'), 'inhabited places');
        assert.equal(urls[2].searchParams.get('derivedSubject'), 'settlements (sites of small communities)');
        assert.equal(u.searchParams.get('size'), '50');
        assert.equal(u.searchParams.has('mapq'), false);
        assert.equal(urls[1].searchParams.get('page'), '2');
        const [north, west, south, east] = u.searchParams.get('bbox').split(',').map(Number);
        assert.ok(north > centre.lat && south < centre.lat && west < centre.lon && east > centre.lon);
    });
    await test('empty area is valid, incomplete/repeated pages never produce a partial training set', async () => {
        providers.setFetch(async () => response([]));
        assert.deepEqual(await providers.createAriadneSiteProvider().getSites(centre, 50), []);
        providers.setFetch(async () => response([hit('a')], 51));
        await assert.rejects(providers.createAriadneSiteProvider().getSites(centre, 50), /incomplete/);
    });
    await test('HTTP, API errors, invalid schemas and oversized result windows fail visibly', async () => {
        for (const value of [
            { ok: false, status: 503 },
            { ok: true, json: async () => ({ error: { msg: 'Scrolling exceeded maximum' } }) },
            { ok: true, json: async () => ({ hits: [] }) },
            response([], 10001),
            { ok: true, json: async () => ({ hits: [], total: { value: 10000, relation: 'gte' } }) }
        ]) {
            providers.setFetch(async () => value);
            await assert.rejects(providers.createAriadneSiteProvider().getSites(centre, 50), /ARIADNE/);
        }
    });
    await test('cancellation prevents the next page and prevents returning stale points', async () => {
        const token = { cancelled: false }; let calls = 0;
        providers.setFetch(async () => { calls++; token.cancelled = true; return response([hit('a')], 51); });
        await assert.rejects(providers.createAriadneSiteProvider().getSites(centre, 50, { token }), /cancelled/);
        assert.equal(calls, 1);
        await assert.rejects(providers.createAriadneSiteProvider().getSites(centre, 50, { token }), /cancelled/);
        assert.equal(calls, 1);
    });
    providers.setFetch(null);
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (_) { console.log('  SKIP DOM integration (install jsdom externally and set NODE_PATH)'); }
    if (JSDOM) await test('real panel auto-loads, retries failures, applies period thresholds and ignores stale centre loads (DOM integration)', async () => {
        const dom = new JSDOM('<!doctype html><html lang="en"><body><div id="map"></div></body></html>',
            { url: 'https://detectlab.eu', runScripts: 'outside-only', pretendToBeVisual: true });
        const w = dom.window;
        try {
            for (const file of ['js/leaflet.js', ...['core', 'raster', 'heatmap', 'sites', 'providers', 'pipeline', 'i18n'].map(x => `js/apm-next/apm-${x}.js`)]) {
                w.eval(fs.readFileSync(path.join(__dirname, file), 'utf8'));
            }
            w._dlIsPremium = () => true;
            w._dlMap = w.L.map('map').setView([centre.lat, centre.lon], 10);
            const pending = [];
            w.DetectLabApmProviders.createAriadneSiteProvider = () => ({ getSites: (c, radius, options) => new Promise((resolve, reject) => pending.push({ c, radius, options, resolve, reject })) });
            w.eval(fs.readFileSync(path.join(__dirname, 'js/apm-next/apm-ui.js'), 'utf8'));
            w.DetectLabApmUi.init(); w.DetectLabApmUi.setEnabled(true); w.DetectLabApmUi.open();
            const doc = w.document;
            const button = (text) => [...doc.querySelectorAll('button')].find(b => b.textContent === text);
            const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
            const pick = (lat, lng) => { button('Pick point on map').click(); w._dlMap.fire('click', { latlng: { lat, lng } }); };
            assert.equal(doc.querySelectorAll('input[type="file"]').length, 0);
            button('TRAIN').click();
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
            pick(centre.lat, centre.lon);
            assert.equal(pending.length, 1);
            assert.equal(pending[0].radius, 50);
            assert.equal(button('Reload ARIADNE points').disabled, true);
            const records = sites.parseAriadneHits(Array.from({ length: 12 }, (_, i) => hit(i, centre.lat + i * 0.001)));
            records.push(...sites.parseAriadneHits([hit('bronze', centre.lat + 0.02, centre.lon, { temporal: [{ periodName: 'Bronze', from: -1000, until: -500 }] })]));
            records.push(...sites.parseAriadneHits([hit('namedOnly', centre.lat + 0.03, centre.lon, { temporal: [{ periodName: 'Undated culture' }] })]));
            pending[0].resolve(records); await flush();
            assert.equal(doc.querySelector('.apm-primary').disabled, true, 'a desired period must be explicitly chosen');
            const period = doc.querySelector('.apm-train select');
            period.value = '0'; period.dispatchEvent(new w.Event('change'));
            assert.match(doc.querySelector('.apm-count-block').textContent, /1 settlements/);
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
            period.value = '1'; period.dispatchEvent(new w.Event('change'));
            assert.equal(doc.querySelector('.apm-primary').disabled, false);
            assert.equal(w.DetectLabApmUi.state().period.label, 'Roman');
            let runParams;
            w.DetectLabApmPipeline.runTrain = (_, params) => { runParams = params; return Promise.reject(new Error('test stops before DEM downloads')); };
            doc.querySelector('.apm-primary').click(); await flush();
            assert.equal(runParams.records.length, 14);
            assert.equal(runParams.siteSource.id, 'ariadne');
            assert.equal(runParams.period.label, 'Roman');
            assert.equal(sites.filterSites(runParams.records, { center: centre, period: runParams.period }).sites.length, 12);
            period.value = '2'; period.dispatchEvent(new w.Event('change'));
            assert.equal(w.DetectLabApmUi.state().period.label, 'Undated culture');
            assert.equal([...period.options].find(o => o.value === '2').disabled, false);
            assert.match(doc.querySelector('.apm-count-block').textContent, /1 settlements/);
            period.value = 'all'; period.dispatchEvent(new w.Event('change'));
            assert.equal(w.DetectLabApmUi.state().period, null);
            assert.equal(doc.querySelector('.apm-primary').disabled, false);
            button('Reload ARIADNE points').click();
            pending[1].reject(new Error('HTTP 503')); await flush();
            assert.match(doc.querySelector('.apm-status').textContent, /HTTP 503/);
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
            assert.equal(button('Reload ARIADNE points').disabled, false);
            button('Reload ARIADNE points').click();
            pick(centre.lat + 1, centre.lon);
            assert.equal(pending[2].options.token.cancelled, true);
            pending[2].resolve(records); await flush();
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
            pending[3].resolve([]); await flush();
            assert.match(doc.querySelector('.apm-count-block').textContent, /No usable settlements/);
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
            button('Reload ARIADNE points').click();
            w.DetectLabApmUi.setEnabled(false);
            assert.equal(pending[4].options.token.cancelled, true);
            pending[4].resolve(records); await flush();
            assert.equal(doc.querySelector('.apm-primary').disabled, true);
        } finally { w.close(); }
    });
    console.log(`\n${passed} passed`);
}
main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => providers.setFetch(null));
