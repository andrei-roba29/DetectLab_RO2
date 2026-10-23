#!/usr/bin/env node
'use strict';

// ARIADNE portal integration + the portal search-engine quirk it has to repair.
//
// Reproduced against the live service (2026-10-23), typing the commune of
// Moldovenești (jud. Cluj) WITHOUT diacritics on https://ariadne-portal.d4science.org:
//
//   /api/search?q=Moldovenesti  → {"total":{"value":0}}   ← "No resources found"
//   /api/search?q=Moldovene      → 0
//   /api/search?q=Moldovenești   → 36 records
//   /api/search?q=Moldovene*     → 81 records (the Stejeriș record is hit #1)
//
// …while the portal's own type-ahead (which appends a wildcard) already knows
// the place after "Moldovene": its index keeps raw, non-folded whole tokens.
//
// This test emulates exactly that index (whole-token match, diacritics kept)
// and proves that the Library of Babel adapter still returns the Stejeriș /
// Moldovenești records, links them to the portal, and drops the look-alike
// "Moldoveni" (jud. Ialomița) noise.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;

/* ── a miniature ARIADNE index: raw tokens, whole-word matching only ── */
const RESOURCE_1 = 'e20527a79376cf5cb3f7c927e7292f66c992abd88b7d1d53a483832ea70a4cd6';
const RECORDS = [
    {
        id: RESOURCE_1,
        data: {
            title: { text: 'Stejeriș. Moldovenești. Cluj (punct: Stejeriș 1 (Autostrada A10, tronson Inoc-Turda/lot 4, sit nr. 5, km 64+850–65+100)) / anul: 2014', language: 'ro' },
            description: { text: 'The archaeological site Stejeriș 1 was identified in 2014; the highway affected the eastern limit of a middle Bronze Age settlement (Wietenberg culture).', language: 'en' },
            spatial: [{ placeName: 'România. Județ: Cluj. Stejeriș (Moldovenești). Punct: Stejeriș 1 (Autostrada A10, tronson Inoc-Turda/lot 4, sit nr. 5, km 64+850–65+100)' }],
            temporal: [{ periodName: 'epoca bronzului', from: '-3700', until: '-1100' }],
            nativeSubject: [{ prefLabel: 'așezare deschisă' }],
            ariadneSubject: [{ prefLabel: 'Fieldwork report' }],
            publisher: [{ name: 'National Heritage Institute - Romania' }],
            resourceType: 'dataset',
            issued: '2014-12-30',
            landingPage: 'http://cronica.cimec.ro/detaliu.asp?k=5425'
        }
    },
    {
        id: '6035ba73315120d1a26084d58c09c7399d1fa76555e504443b3cb724d00484b8',
        data: {
            title: { text: 'Așezarea Latene de la Moldovenești', language: 'ro' },
            spatial: [{ placeName: 'România. Județ: Cluj. Moldovenești (Moldovenești).' }],
            temporal: [{ periodName: 'epoca romană', from: '102', until: '275' }],
            nativeSubject: [{ prefLabel: 'așezare' }],
            publisher: [{ name: 'National Heritage Institute - Romania' }],
            resourceType: 'dataset',
            issued: '2012-08-09'
        }
    },
    {
        id: '785a7e2f7af0c5660d430fd944afa30cfa81efc3fbd9396267625b7749ce2e4a',
        data: {
            title: { text: 'Necropola medievală de la Moldovenești', language: 'ro' },
            description: { text: 'Necropolă medievală cercetată în comuna Moldovenești, jud. Cluj.' },
            spatial: [{ placeName: 'România. Județ: Cluj. Moldovenești (Moldovenești).' }],
            temporal: [{ periodName: 'epoca medievală', from: '620', until: '1821' }],
            resourceType: 'dataset',
            issued: '2012-08-09'
        }
    },
    /* look-alike locality in another county — must never be shown for Moldovenești */
    {
        id: 'moldoveni-ialomita',
        data: {
            title: { text: 'Biserica de lemn din Moldoveni', language: 'ro' },
            spatial: [{ placeName: 'România. Județ: Ialomița. Moldoveni.' }],
            temporal: [{ periodName: 'epoca medievală' }],
            resourceType: 'dataset',
            issued: '2010-01-01'
        }
    }
];

function portalTokens(v) {
    return (String(v == null ? '' : v).toLowerCase().match(/[a-z0-9\u00c0-\u024f]+/gi) || []);
}
function recordText(r) {
    const d = r.data;
    return [
        d.title && d.title.text, d.description && d.description.text,
        (d.spatial || []).map((s) => s.placeName).join(' '),
        (d.temporal || []).map((s) => s.periodName).join(' '),
        (d.nativeSubject || []).map((s) => s.prefLabel).join(' ')
    ].filter(Boolean).join(' ');
}
/* The live engine: whole-token match, wildcards only when the query has one,
 * and NO diacritics folding. */
function portalSearch(q) {
    const need = String(q).trim().split(/\s+/).filter(Boolean);
    const hits = RECORDS.filter((r) => {
        const hay = portalTokens(recordText(r));
        return need.every((w) => {
            const wl = w.toLowerCase();
            if (wl.endsWith('*')) {
                const p = wl.slice(0, -1);
                return hay.some((t) => t.startsWith(p));
            }
            return hay.some((t) => t === wl);
        });
    });
    return { total: { value: hits.length, relation: 'eq' }, hits: hits.map((h) => ({ id: h.id, data: h.data })), aggregations: [] };
}

function loadEngine(opts) {
    opts = opts || {};
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { id, innerHTML: '', hidden: true, textContent: '', disabled: false, onclick: null, onchange: null, value: '', title: '', className: '', setAttribute() {}, getAttribute() { return null; }, focus() {}, classList: { add() {}, remove() {} } });
        return elements.get(id);
    };
    let currentLangCode = 'ro';
    const requests = [];
    const store = { 'babel.europeanaKey': 'TESTKEY' };
    const sandbox = {
        console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON,
        Blob: class {}, Object, Array, String, Number, Promise, Error, RegExp, Math,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        window: null,
        document: {
            readyState: 'complete',
            getElementById: element,
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, set href(v) {}, href: '', set download(v) {}, download: '' }),
            addEventListener() {}, body: { classList: { add() {}, remove() {} } }
        },
        fetch: (u) => {
            const url = String(u);
            requests.push(url);
            const payload = (() => {
                if (url.includes('wikipedia.org')) return { query: { search: [] } };
                if (url.includes('query.wikidata.org')) return { results: { bindings: [] } };
                if (url.includes('commons.wikimedia.org')) return { query: { pages: {} } };
                if (url.includes('lookup.dbpedia.org')) return { docs: [] };
                if (url.includes('archive.org')) return { response: { docs: [] } };
                if (url.includes('europeana.eu')) return { items: [] };
                if (url.includes('ariadne-portal.d4science.org/api/search')) {
                    if (opts.failAriadnePath && url.includes(opts.failAriadnePath)) return { error: { message: 'boom' } };
                    return portalSearch(new URL(url).searchParams.get('q'));
                }
                if (url.includes('nominatim.openstreetmap.org')) return [];
                throw new Error('unexpected URL: ' + url);
            })();
            return Promise.resolve({ ok: true, status: 200, json: async () => payload });
        }
    };
    sandbox.document.head = {
        appendChild(el) {
            if (el && el.src && typeof el.src === 'string' && el.src.includes('PatrimoniuWM')) {
                const m = el.src.match(/callback=(\w+)/);
                if (m) setTimeout(() => { try { sandbox[m[1]]({ results: [] }); } catch (_) { } }, 0);
            }
        },
        removeChild() {}
    };
    sandbox.window = sandbox;
    sandbox.window._currentLang = () => currentLangCode;
    sandbox.setLang = (v) => { currentLangCode = v; };
    /* OSM gazetteer: the canonical, diacritics-correct spelling of the commune */
    if (opts.gazetteer !== false) {
        sandbox.window._osmPlaceLookup = (q) => {
            if (String(q).trim().toLowerCase().replace(/[^a-z]/g, '').startsWith('moldovenest')) {
                return [{ display_name: 'Moldovenești', judet: 'Cluj', lat: 46.5, lon: 23.65, fclass: 'place' }];
            }
            return [];
        };
    }
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/library-of-babel.js'), 'utf8'), sandbox);
    sandbox.window.DetectLabEvidenceEngine._noThrottle();
    return { sandbox, body: () => element('babelBody').innerHTML, requests };
}

(async () => {
    /* ── 0. the bug is real: the literal query the portal itself would send ── */
    assert.strictEqual(portalSearch('Moldovenesti').total.value, 0, 'the live engine returns nothing for the complete, diacritics-free name');
    assert.strictEqual(portalSearch('Moldovene').total.value, 0, 'no prefix matching on the results page either');
    assert.ok(portalSearch('Moldovenești').total.value >= 3, 'the accented spelling works');
    assert.ok(portalSearch('Moldovene*').total.value >= 3, 'a wildcard stem works');

    /* ── 1. the adapter repairs the query before sending it ── */
    let app = loadEngine();
    const queries = app.sandbox.window.DetectLabEvidenceEngine._ariadne.queries('Moldovenești', 'Moldovenesti');
    assert.deepStrictEqual(Array.from(queries).map(String), ['Moldovenești', 'Moldovene*', 'Moldovenesti'],
        `the repaired query set is [canonical, wildcard stem, typed] (got: ${JSON.stringify(queries)})`);
    assert.strictEqual(app.sandbox.window.DetectLabEvidenceEngine._ariadne.wordStem('Moldovenești'), 'Moldovene*', 'accented name → stem cut before the last diacritic');
    assert.strictEqual(app.sandbox.window.DetectLabEvidenceEngine._ariadne.wordStem('Moldovenesti'), 'Moldovene*', 'diacritics-free name → short stem that survives the index');
    assert.strictEqual(app.sandbox.window.DetectLabEvidenceEngine._ariadne.wordStem('Cluj'), null, 'short names are never widened');

    /* ── 2. an end-to-end search for the commune, typed WITHOUT diacritics ── */
    await app.sandbox.window.DetectLabEvidenceEngine.research('Moldovenesti');
    let html = app.body();

    assert.ok(/Stejeriș\. Moldovenești\. Cluj/.test(html), 'the Stejeriș / Moldovenești record is found (the reported bug)');
    assert.ok(new RegExp('https://ariadne-portal\\.d4science\\.org/resource/' + RESOURCE_1).test(html), 'the card links to the ARIADNE resource page');
    assert.ok(/ARIADNE/.test(html), 'the ARIADNE source badge is rendered');
    assert.ok(/National Heritage Institute/.test(html), 'the data provider is disclosed');
    assert.ok(/Necropola medievală de la Moldovenești/.test(html), 'other reports of the same commune are kept');
    assert.ok(!/Biserica de lemn din Moldoveni/.test(html), 'the look-alike Moldoveni (Ialomița) record is filtered out');
    assert.ok(/ARIADNE <b>3<\/b>/.test(html), 'the ARIADNE chip counts the 3 records of the commune');
    assert.ok(/<b>9\/9<\/b>\s*surse active/.test(html), 'ARIADNE counts towards the nine active sources');

    const ariadneUrls = app.requests.filter((u) => u.includes('ariadne-portal.d4science.org/api/search'));
    assert.strictEqual(ariadneUrls.length, 3, 'exactly three repaired spellings are sent (polite fan-out)');
    assert.ok(ariadneUrls.some((u) => u.includes('q=Moldovene*')), 'the wildcard stem really travels to the portal');
    assert.ok(ariadneUrls.some((u) => u.includes('q=Moldovene%C8%99ti')), 'the canonical spelling really travels to the portal');
    assert.ok(ariadneUrls.every((u) => u.includes('size=')), 'every request pins a page size');

    /* ── 3. the accented search works too (no regression on the happy path) ── */
    app = loadEngine();
    await app.sandbox.window.DetectLabEvidenceEngine.research('Moldovenești', { bypassCache: true });
    html = app.body();
    assert.ok(/Stejeriș\. Moldovenești\. Cluj/.test(html), 'the accented spelling also returns the record');
    assert.ok(!/Biserica de lemn din Moldoveni/.test(html), 'no look-alike noise with the accented spelling');

    /* ── 4. without the OSM gazetteer the repair still works (short stem) ── */
    app = loadEngine({ gazetteer: false });
    await app.sandbox.window.DetectLabEvidenceEngine.research('Moldovenesti', { bypassCache: true });
    html = app.body();
    assert.ok(/Stejeriș\. Moldovenești\. Cluj/.test(html), 'the diacritics-free fallback also reaches the record');
    assert.ok(!/Biserica de lemn din Moldoveni/.test(html), 'the local mention guard drops the look-alike even without a gazetteer');

    /* ── 5. one repaired query failing degrades to "parțial", never to a dead source ── */
    app = loadEngine({ failAriadnePath: 'q=Moldovene*' });
    await app.sandbox.window.DetectLabEvidenceEngine.research('Moldovenesti', { bypassCache: true });
    html = app.body();
    assert.ok(/Stejeriș\. Moldovenești\. Cluj/.test(html), 'the surviving exact query still returns the record');
    assert.ok(/parțial/.test(html), 'the ARIADNE chip is flagged as partial');

    /* ── 6. EN variant ── */
    app.sandbox.window.setLang('en');
    assert.ok(/ARIADNE/.test(app.body()), 'EN: the source badge is language-independent');
    const json = JSON.parse(app.sandbox.window.DetectLabEvidenceEngine._export.json());
    assert.ok(json.results.some((r) => /Moldovene/i.test(r.titlu)), 'EN: the export carries the ARIADNE findings');

    console.log('✓ Biblioteca din Babel ARIADNE integration tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
