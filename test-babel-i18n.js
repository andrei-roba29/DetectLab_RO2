#!/usr/bin/env node
'use strict';

// Guards the "Biblioteca din Babel" multi-source search agent:
//  1. every UI string exists in BOTH site language variants (ro + en);
//  2. all 9 sources are named in both variants;
//  3. the agent specification's key sentences survive in both variants;
//  4. the retired backend search (SIRUTA / biblioteca-digitala.ro dossier)
//     is really gone from the module.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const source = fs.readFileSync(path.join(root, 'js/library-of-babel.js'), 'utf8');

function extractDict(lang) {
    const start = source.indexOf(`\n        ${lang}: {`);
    assert(start > 0, `${lang} dictionary exists in library-of-babel.js`);
    /* balanced-brace scan: the dictionary ends at its own closing brace,
     * not at the next `ro:`/`en:` marker in unrelated code below */
    const open = source.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    assert(end > 0, `${lang} dictionary braces are balanced`);
    const block = source.slice(start, end);
    const keys = new Set();
    const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
    let match;
    while ((match = pattern.exec(block))) keys.add(match[1]);
    keys.delete(lang); // the leading `ro:` / `en:` key marker
    return keys;
}

const ro = extractDict('ro');
const en = extractDict('en');

assert.ok(ro.size >= 60, `ro dictionary is substantial (${ro.size} keys)`);
const missingInEn = [...ro].filter((k) => !en.has(k));
const missingInRo = [...en].filter((k) => !ro.has(k));
assert.deepStrictEqual(missingInEn, [], `every ro key has an en translation (missing: ${missingInEn.join(', ')})`);
assert.deepStrictEqual(missingInRo, [], `every en key has an ro translation (missing: ${missingInRo.join(', ')})`);

// The 9 sources of the multi-source agent must be named in both variants.
for (const id of ['wikipedia', 'wikidata', 'osm', 'commons', 'dbpedia', 'archive', 'europeana', 'ariadne', 'cimec']) {
    assert.ok(ro.has(`src_${id}`), `ro names source ${id}`);
    assert.ok(en.has(`src_${id}`), `en names source ${id}`);
}

// Agent specification — FORMAT OUTPUT: every result carries TITLU/DESCRIERE/TIP/SURSĂ.
assert.ok(ro.has('type_article') && en.has('type_article'), 'type labels exist (TIP)');
assert.ok(ro.has('results') && en.has('results'), 'stats wording exists (STATISTICĂ)');
assert.ok(ro.has('activeSources') && en.has('activeSources'), 'active-sources wording exists');
assert.ok(ro.has('duplicates') && en.has('duplicates'), 'de-duplication wording exists');

// PARAMETRI OPȚIONALI: filter by type, filter by period, export JSON/CSV.
assert.ok(ro.has('type') && ro.has('period') && ro.has('source') && ro.has('all'), 'ro filter labels exist');
assert.ok(en.has('type') && en.has('period') && en.has('source') && en.has('all'), 'en filter labels exist');
for (const id of ['prehistory', 'bronze', 'iron', 'dacian', 'roman', 'migration', 'medieval', 'modern', 'unspecified']) {
    assert.ok(ro.has(`p_${id}`) && en.has(`p_${id}`), `period ${id} is labelled in both languages`);
}
assert.ok(ro.has('exportJson') && ro.has('exportCsv') && en.has('exportJson') && en.has('exportCsv'), 'JSON/CSV export labels exist');

// ERORI & EDGE CASES: failing sources, zero results, ambiguous locality.
assert.ok(ro.has('noResults') && en.has('noResults'), 'zero-results wording exists');
assert.ok(ro.has('suggestions') && en.has('suggestions'), 'alternative-search suggestions wording exists');
assert.ok(ro.has('ambiguousTitle') && en.has('ambiguousTitle'), 'ambiguity wording exists');
assert.ok(ro.has('allSourcesFailed') && en.has('allSourcesFailed'), 'all-sources-failed wording exists');
assert.ok(ro.has('srcTimeout') && ro.has('srcNetwork') && ro.has('srcHttp'), 'per-failure wording exists (ro)');
assert.ok(en.has('srcTimeout') && en.has('srcNetwork') && en.has('srcHttp'), 'per-failure wording exists (en)');

// Canonical sentences.
assert(source.includes("'Căutare arheologică multi-sursă · 9 surse deschise'"), 'ro subtitle names the 9-source mission');
assert(source.includes("'Multi-source archaeological search · 9 open sources'"), 'en subtitle names the 9-source mission');
assert(source.includes("'LOCAȚIE AMBIGUĂ'"), 'ro ambiguous-location marker present');
assert(source.includes("'AMBIGUOUS LOCATION'"), 'en ambiguous-location marker present');

// The retired dossier search is gone: no backend call, no SIRUTA, no zoom gate.
assert(!source.includes('/evidence/search'), 'the module no longer calls POST /evidence/search');
assert(!source.includes('SIRUTA'), 'no SIRUTA register logic remains');
assert(!source.includes('biblioteca-digitala'), 'no biblioteca-digitala.ro dependency remains');
assert(!source.includes('MIN_ZOOM'), 'the old zoom gate is gone');
assert(!source.includes('API_BASE'), 'no backend API base remains');

// The 8 public endpoints are wired in the module itself.
for (const endpoint of [
    'wikipedia.org/w/api.php', 'query.wikidata.org/sparql', 'nominatim.openstreetmap.org/search',
    'commons.wikimedia.org/w/api.php', 'lookup.dbpedia.org/api/search', 'archive.org/advancedsearch.php',
    'api.europeana.eu/record/v2/search.json', 'Patrimoniu/PatrimoniuWM/MapServer'
]) {
    assert(source.includes(endpoint), `endpoint ${endpoint} is wired`);
}

// Nominatim usage policy: max 1 request/second, respected client-side.
assert(/NOMINATIM_MIN_INTERVAL\s*=\s*1100/.test(source), 'Nominatim is throttled to ~1 req/sec');

// ARIADNE portal: the 9th source and its repaired query fan-out exist.
assert.ok(source.includes("ariadne-portal.d4science.org/api"), 'the ARIADNE JSON API endpoint is wired in');
assert.ok(/SOURCE_ORDER = \[[^\]]*'ariadne'/.test(source), 'ARIADNE is part of the source order (chips, stats, exports)');
assert.ok(source.includes('function ariadneQueries'), 'the repaired query builder exists');
assert.ok(source.includes('function ariadneStemQuery'), 'the wildcard stem builder exists');
assert.ok(source.includes('function sourceAriadne'), 'the ARIADNE source adapter exists');

console.log('✓ Biblioteca din Babel i18n + agent-spec tests passed');
