#!/usr/bin/env node
'use strict';

// Resilience contract of the multi-source search agent (AGENT spec §ERORI):
//   1. one/more sources failing NEVER blocks the others — the search
//      continues, failed sources are named, results still render;
//   2. every source down → a named error + retry, never a silent hang;
//   3. zero results → alternative searches are suggested;
//   4. ambiguous locality → the OSM matches are offered as refinements;
//   5. Europeana without an API key → source marked "no key", search
//      continues with the other 7;
//   6. repeated search serves from the local cache (no new requests).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = __dirname;

function loadEngine(fetchImpl, opts) {
    opts = opts || {};
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, { id, innerHTML: '', hidden: true, textContent: '', disabled: false, onclick: null, onchange: null, value: '', title: '', className: '', setAttribute() {}, getAttribute() { return null; }, focus() {}, classList: { add() {}, remove() {} } });
        return elements.get(id);
    };
    let currentLangCode = 'ro';
    let fetchCount = 0;
    const sandbox = {
        console, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date, JSON,
        Blob: class {}, Object, Array, String, Number, Promise, Error, RegExp, Math,
        window: null,
        document: {
            readyState: 'complete',
            getElementById: element,
            querySelectorAll: () => [],
            createElement: () => ({ click() {}, set href(v) {}, href: '', set download(v) {}, download: '' }),
            addEventListener() {}, body: { classList: { add() {}, remove() {} } }
        },
        fetch: (u) => { fetchCount++; return fetchImpl(String(u)); }
    };
    if (opts.localStorage !== false) {
        const store = {};
        sandbox.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    }
    /* Intercept JSONP script elements for CIMEC/RAN — return empty array by
     * default (the source answers but has no sites), or a custom payload if
     * opts.cimecData is set. Pass false to simulate CIMEC failing immediately
     * (script onerror fires, JSONP rejects). */
    const cimecData = opts.cimecData !== undefined ? opts.cimecData : [];
    sandbox.document.head = {
        appendChild(el) {
            if (el && el.src && typeof el.src === 'string' && el.src.includes('PatrimoniuWM')) {
                if (cimecData === false) {
                    // simulate immediate JSONP failure (script load error)
                    setTimeout(function () { if (typeof el.onerror === 'function') el.onerror(); }, 0);
                    return;
                }
                var m = el.src.match(/callback=(\w+)/);
                if (m) {
                    var cbName = m[1];
                    setTimeout(function () {
                        try { sandbox[cbName](cimecData); } catch (_) { }
                    }, 0);
                }
            }
        },
        removeChild() {}
    };
    sandbox.window = sandbox;
    sandbox.window._currentLang = () => currentLangCode;
    sandbox.setLang = (v) => { currentLangCode = v; };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(root, 'js/library-of-babel.js'), 'utf8'), sandbox);
    sandbox.window.DetectLabEvidenceEngine._noThrottle();
    return { sandbox, body: () => element('babelBody').innerHTML, element, fetches: () => fetchCount };
}

const http = (payload, status) => () => Promise.resolve({ ok: status == null || (status >= 200 && status < 300), status: status || 200, json: async () => payload });
const netFail = () => Promise.reject(new TypeError('Failed to fetch'));
const abortLike = () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

const wikiOne = { query: { search: [{ title: 'Testville Roman fort', snippet: 'Articol despre castrul roman de la Testville.', timestamp: '2026-01-01T00:00:00Z' }] } };
const wdOne = { results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q1' }, itemLabel: { value: 'Testville Roman fort' }, itemDescription: { value: 'castru roman' } }] } };
const osmThree = [
    { osm_type: 'node', osm_id: 1, lat: '1', lon: '2', category: 'place', type: 'village', name: 'Testville', display_name: 'Testville, Județul X, România' },
    { osm_type: 'node', osm_id: 2, lat: '3', lon: '4', category: 'historic', type: 'ruins', name: 'Testville', display_name: 'Testville, Județul Y, România' },
    { osm_type: 'way', osm_id: 3, lat: '5', lon: '6', category: 'place', type: 'hamlet', name: 'Testville', display_name: 'Testville, Județul Z, România' }
];

(async () => {
    /* ── 1 + 4 + 5: mixed failures, ambiguity, Europeana without key ── */
    let app = loadEngine((url) => {
        if (url.includes('ro.wikipedia.org')) return http(wikiOne)();
        if (url.includes('en.wikipedia.org')) return netFail();          // wikipedia survives on ro alone (partial)
        if (url.includes('query.wikidata.org')) return http(wdOne)();
        if (url.includes('nominatim')) return http(osmThree)();          // 3 OSM matches → ambiguous
        if (url.includes('commons')) return abortLike();                 // timeout
        if (url.includes('dbpedia')) return http({ error: 'Internal server error' }, 500)(); // server error
        if (url.includes('archive.org')) return http({ response: { docs: [] } })();        // responds, 0 hits
        throw new Error('unexpected URL ' + url);
    }, { localStorage: false });                                         // no Europeana key stored

    await app.sandbox.window.DetectLabEvidenceEngine.research('Testville');
    let html = app.body();

    assert.ok(/Testville Roman fort/.test(html), 'results from the surviving sources still render');
    assert.ok(/<b>5\/9<\/b>\s*surse active/.test(html), '5/9 sources stayed active (wikipedia, wikidata, osm, archive, cimec)');
    assert.ok(/parțial/.test(html), 'the wikipedia chip flags the partial ro-only answer');
    assert.ok(/fără răspuns \(timeout\)/.test(html), 'Commons timeout is named on its chip');
    assert.ok(/eroare server/.test(html), 'the DBpedia 500 is named on its chip');
    assert.ok(/fără cheie API/.test(html), 'Europeana is marked as missing its API key');
    assert.ok(/Surse care nu au răspuns/.test(html), 'the failed-source note is shown');
    assert.ok(/Wikimedia Commons/.test(html) && /DBpedia/.test(html), 'failed sources are named in the note');
    assert.ok(/LOCAȚIE AMBIGUĂ/.test(html), '3 OSM matches raise the ambiguity banner');
    assert.ok((html.match(/class="babel-pick" data-query="Testville"/g) || []).length === 3, 'every OSM match offers a refined search');

    /* ── 2: every source down → named failure + retry, no hang ── */
    app = loadEngine(() => netFail(), { cimecData: false });
    await app.sandbox.window.DetectLabEvidenceEngine.research('Nowhere');
    html = app.body();
    assert.ok(/Niciuna dintre cele 9 surse nu a răspuns/.test(html), 'RO: total outage is named');
    assert.ok(/id="babelRetry"/.test(html), 'a retry action is offered');
    assert.ok(!/babel-result/.test(html), 'no result cards are invented from nothing');

    /* same outage in English */
    app.element('babelModal').hidden = false;
    app.sandbox.window.setLang('en');
    await app.sandbox.window.DetectLabEvidenceEngine.research('Nowhere', { bypassCache: true });
    html = app.body();
    assert.ok(/None of the 9 sources responded/.test(html), 'EN: total outage is translated');

    /* ── 3: zero results → suggested alternative searches ── */
    app = loadEngine((url) => {
        if (url.includes('wikipedia.org')) return http({ query: { search: [] } })();
        if (url.includes('query.wikidata.org')) return http({ results: { bindings: [] } })();
        if (url.includes('nominatim')) return http([])();
        if (url.includes('commons')) return http({ query: { pages: {} } })();
        if (url.includes('dbpedia')) return http({ docs: [] })();
        if (url.includes('archive.org')) return http({ response: { docs: [] } })();
        if (url.includes('europeana')) return http({ items: [] })();
        throw new Error('unexpected URL ' + url);
    }, { localStorage: false });
    await app.sandbox.window.DetectLabEvidenceEngine.research('Xyzzyville');
    html = app.body();
    assert.ok(/Nu am găsit niciun rezultat pentru\s*„Xyzzyville”/.test(html), 'RO: zero results names the query');
    assert.ok(/Căutări sugerate/.test(html), 'alternative searches are suggested');
    assert.ok(/data-query="Xyzzyville arheologic"/.test(html), 'a locality-specific variant is suggested');
    assert.ok(/data-query="Xyzzyville archaeological"/.test(html), 'an English variant is suggested');
    assert.ok(/7\/9/.test(html), 'the reachable sources all answered — a genuine zero, not an outage');

    /* ── 6: local cache — a repeated search does not re-query the APIs ── */
    app = loadEngine((url) => {
        if (url.includes('wikipedia.org')) return http(wikiOne)();
        if (url.includes('query.wikidata.org')) return http(wdOne)();
        if (url.includes('nominatim')) return http([])();
        if (url.includes('commons')) return http({ query: { pages: {} } })();
        if (url.includes('dbpedia')) return http({ docs: [] })();
        if (url.includes('archive.org')) return http({ response: { docs: [] } })();
        if (url.includes('europeana')) return http({ items: [] })();
        throw new Error('unexpected URL ' + url);
    });
    await app.sandbox.window.DetectLabEvidenceEngine.research('Cacheville');
    const afterFirst = app.fetches();
    assert.ok(afterFirst >= 6, `the first search queried the sources (${afterFirst} requests)`);
    await app.sandbox.window.DetectLabEvidenceEngine.research('Cacheville');
    assert.strictEqual(app.fetches(), afterFirst, 'the repeated search is served from the local cache');
    assert.ok(/Rezultate din cache local/.test(app.body()), 'the cache origin is disclosed to the user');

    console.log('✓ Biblioteca din Babel resilience tests passed');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
