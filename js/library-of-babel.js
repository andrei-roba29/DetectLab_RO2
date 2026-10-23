/* DetectLab — "Biblioteca din Babel" multi-source archaeological search agent.
 *
 * The old single-source dossier search was retired; this module now queries
 * 9 open knowledge sources DIRECTLY from the browser, in parallel, aggregates
 * and de-duplicates the findings and renders them with per-source provenance:
 *
 *   1. Wikipedia (ro + en)   — articles about localities and sites
 *   2. Wikidata (SPARQL)     — structured entities + coordinates
 *   3. OpenStreetMap Nominatim — geocoding / gazetteer (max 1 req/sec!)
 *   4. Wikimedia Commons     — images, plans and old maps
 *   5. DBpedia Lookup        — semantic resources
 *   6. Archive.org           — digitised old documents and collections
 *   7. Europeana             — museum objects and cultural collections
 *                              (free API key required, stored locally)
 *   8. ARIADNE portal        — the European archaeological catalogue
 *                              (d4science; CORS-open JSON API)
 *   9. CIMEC / RAN           — fișe de sit arheologic din Repertoriul
 *                              Arheologic Național (via ArcGIS REST JSONP)
 *
 * Contract (see AGENT spec): a source that fails never blocks the others,
 * zero results yields suggested alternative searches, an ambiguous locality
 * surfaces the OSM matches, results can be filtered by type / period /
 * source and exported as JSON or CSV. Every UI string exists in BOTH site
 * language variants (ro / en — parity is tested).
 *
 * OSM-driven search (2026-09): every query is resolved against the OSM
 * gazetteer first — canonical locality name + county (județ) + coordinates —
 * shown in the header and used to (a) query the text sources with the exact
 * locality phrase, (b) drop fuzzy noise that never mentions the locality
 * ("Miljan Miljanić" for "Miluani"), and (c) list the RAN archaeological
 * sites AROUND the locality spatially, sorted by distance.
 *
 * ARIADNE portal (2026-10): the portal's own search box has a well-known
 * asymmetry — its type-ahead appends a wildcard ("Moldovene" → the record of
 * Stejeriș, com. Moldovenești), but the results page matches WHOLE, NOT
 * diacritics-folded tokens, so the complete name typed WITHOUT diacritics
 * ("Moldovenesti") returns "No resources found" while the accented spelling
 * ("Moldovenești") works. The adapter below never sends a single literal
 * query: it sends the gazetteer-corrected spelling, a wildcard stem cut in
 * front of the last diacritic (or, for diacritics-free input, the last three
 * characters removed) and the user's own spelling, then merges the answers
 * by resource id and keeps only wildcard hits that actually mention the
 * locality. See ARIADNE_* helpers further down.
 */
(function () {
    'use strict';

    /* ── tuning constants ── */
    var NOMINATIM_MIN_INTERVAL = 1100;   // hard usage-policy limit: 1 req/sec
    var CACHE_TTL = 30 * 60 * 1000;      // 30 minutes of local result caching
    var WIKI_LIMIT = 8, COMMONS_LIMIT = 12, OTHER_LIMIT = 10;
    /* relevance guard: when the OSM gazetteer confirms the locality, findings
     * must actually mention it (or sit within this radius of it) — fuzzy noise
     * like "Miljan Miljanić" for "Miluani" is removed. */
    var RELEVANCE_RADIUS_KM = 30;
    /* "sites around the locality": CIMEC/RAN spatial search radius (m). */
    var CIMEC_NEARBY_RADIUS_M = 10000;
    var CIMEC_MAX_RESULTS = 30;
    /* ARIADNE portal: the index is not diacritics-folded and matches whole
     * tokens, so every search fans out over (at most) ARIADNE_MAX_QUERIES
     * repaired spellings, merged by resource id. */
    var ARIADNE_BASE = 'https://ariadne-portal.d4science.org/api';
    var ARIADNE_RESOURCE_BASE = 'https://ariadne-portal.d4science.org/resource/';
    var ARIADNE_QUERY_SIZE = 25;         // hits requested per repaired spelling
    var ARIADNE_MAX_RESULTS = 40;        // cards after merging + relevance guard
    var ARIADNE_MAX_QUERIES = 3;         // portal is generous, but stay polite
    var SOURCE_ORDER = ['wikipedia', 'wikidata', 'osm', 'commons', 'dbpedia', 'archive', 'europeana', 'ariadne', 'cimec'];
    /* dominant type wins when the same finding arrives from several sources */
    var TYPE_PRIORITY = { place: 9, article: 8, structured: 7, document: 6, map: 5, image: 4, collection: 3, audio: 2, video: 2 };
    var TYPE_ORDER = ['article', 'structured', 'place', 'document', 'map', 'image', 'collection', 'audio', 'video'];
    var PERIOD_ORDER = ['prehistory', 'bronze', 'iron', 'dacian', 'roman', 'migration', 'medieval', 'modern'];

    /* ── state ── */
    var running = false, searchSeq = 0;
    var runState = 'form';               // form | searching | results | error
    var lastQuery = '', lastAgg = null, lastStats = null, cachedAt = null, lastError = null;
    var sourceStatuses = {};             // live per-source status while searching
    var uiFilters = { type: 'all', period: 'all', source: 'all' };
    var mapRef = null, lastNominatimAt = 0, formValues = { query: '' };

    /* ── i18n dictionaries — kept in strict ro/en parity (tested) ── */
    var C = {
        ro: {
            title: 'Biblioteca din Babel',
            subtitle: 'Căutare arheologică multi-sursă · 9 surse deschise',
            button: 'Caută o localitate',
            close: 'Închide',
            intro: 'Introdu o localitate sau un sit (ex. Sarmizegetusa, Apulum). Căutarea pornește simultan în 9 surse deschise; rezultatele sunt agregate, deduplicate și marcate cu sursa de proveniență.',
            sourcesPolicy: 'Surse: Wikipedia (ro/en) · Wikidata · OpenStreetMap · Wikimedia Commons · DBpedia · Archive.org · Europeana · ARIADNE · CIMEC/RAN',
            locality: 'Localitate / sit arheologic',
            placeholder: 'ex. Sarmizegetusa, Apulum, Grădiștea Muncelului…',
            run: 'Caută', searching: 'Interogăm cele 9 surse în paralel…',
            failed: 'Căutarea nu a putut fi finalizată.',
            allSourcesFailed: 'Niciuna dintre cele 9 surse nu a răspuns. Verifică conexiunea la internet și reîncearcă.',
            retry: 'Reîncearcă', newSearch: 'Caută altceva',
            noResults: 'Nu am găsit niciun rezultat pentru',
            noResultsHelp: 'Încearcă o variantă de mai jos, un nume istoric (ex. Ulpia Traiana în loc de Sarmizegetusa) sau forma engleză / maghiară / germană a numelui.',
            suggestions: 'Căutări sugerate',
            results: 'rezultate', activeSources: 'surse active', duplicates: 'duplicate eliminate',
            irrelevant: 'irelevante eliminate',
            localityVia: 'localitate identificată prin OpenStreetMap',
            countyAbbr: 'jud.', nearAbbr: 'la',
            shown: 'Afișate', of: 'din', seconds: 's',
            perSourceTitle: 'Surse',
            srcOk: 'activă', srcEmpty: 'fără rezultate', srcError: 'indisponibilă',
            srcTimeout: 'fără răspuns (timeout)', srcNetwork: 'inaccesibilă (rețea/CORS)',
            srcHttp: 'eroare server', srcNokey: 'fără cheie API', srcPartial: 'parțial',
            type: 'Tip', period: 'Perioadă', source: 'Sursa', all: 'Toate',
            type_article: 'Articol Wikipedia', type_structured: 'Dată structurată',
            type_place: 'Locație OSM', type_image: 'Imagine', type_map: 'Hartă',
            type_document: 'Document', type_audio: 'Audio', type_video: 'Video', type_collection: 'Colecție',
            sparqlData: 'Dată SPARQL', semanticResource: 'Resursă semantică',
            heritageObject: 'Obiect de patrimoniu', digitalDocument: 'Document digital',
            src_wikipedia: 'Wikipedia', src_wikidata: 'Wikidata', src_osm: 'OpenStreetMap',
            src_commons: 'Wikimedia Commons', src_dbpedia: 'DBpedia', src_archive: 'Archive.org',
            src_europeana: 'Europeana', src_ariadne: 'ARIADNE', src_cimec: 'CIMEC / RAN',
            sitArheologic: 'Fișă de sit arheologic',
            p_prehistory: 'Preistorie', p_bronze: 'Epoca bronzului', p_iron: 'Epoca fierului',
            p_dacian: 'Dacic', p_roman: 'Roman', p_migration: 'Epoca migrațiilor',
            p_medieval: 'Medieval', p_modern: 'Modern', p_unspecified: 'Nespecificată',
            timeline: 'Cronologie', timelineNote: 'clasificare automată',
            epochProfile: 'Epoci', epochProfileNote: 'din încadrările pe epoci ale corpusului',
            mapView: 'Locații pe hartă',
            ambiguousTitle: 'LOCAȚIE AMBIGUĂ',
            ambiguousHelp: 'OpenStreetMap a găsit mai multe potriviri pentru acest nume. Alege una pentru a rafina căutarea:',
            exportJson: 'Export JSON', exportCsv: 'Export CSV',
            cachedFrom: 'Rezultate din cache local', refresh: 'Reîmprospătează',
            keyTitle: 'Cheie API Europeana (opțional)', keyHelp: 'Europeana cere o cheie API gratuită, obținută în câteva minute la europeana.eu/api. Cheia se salvează doar local, în browserul tău. Fără cheie, căutarea continuă automat cu celelalte 8 surse.',
            keyPlaceholder: 'wskey Europeana', keySave: 'Salvează cheia', keySaved: 'Cheia a fost salvată local.',
            keyInvalid: 'Cheia a fost respinsă de Europeana — verifică-o și salveaz-o din nou.',
            year: 'An', generated: 'Generat', query: 'Căutare',
            periodNote: 'Perioadele sunt clasificate automat după cuvinte-cheie din titlu și descriere — verifică întotdeauna sursa originală.',
            partialNote: 'Surse care nu au răspuns (căutarea a continuat cu celelalte):',
            sourcesCount: 'surse'
        },
        en: {
            title: 'Library of Babel',
            subtitle: 'Multi-source archaeological search · 9 open sources',
            button: 'Search a locality',
            close: 'Close',
            intro: 'Enter a locality or site (e.g. Sarmizegetusa, Apulum). The search runs simultaneously across 9 open sources; results are aggregated, de-duplicated and tagged with their source.',
            sourcesPolicy: 'Sources: Wikipedia (ro/en) · Wikidata · OpenStreetMap · Wikimedia Commons · DBpedia · Archive.org · Europeana · ARIADNE · CIMEC/RAN',
            locality: 'Locality / archaeological site',
            placeholder: 'e.g. Sarmizegetusa, Apulum, Grădiștea Muncelului…',
            run: 'Search', searching: 'Querying all 9 sources in parallel…',
            failed: 'The search could not be completed.',
            allSourcesFailed: 'None of the 9 sources responded. Check your internet connection and try again.',
            retry: 'Try again', newSearch: 'Search something else',
            noResults: 'No results found for',
            noResultsHelp: 'Try one of the variants below, a historical name (e.g. Ulpia Traiana instead of Sarmizegetusa) or the English / Hungarian / German form of the name.',
            suggestions: 'Suggested searches',
            results: 'results', activeSources: 'active sources', duplicates: 'duplicates removed',
            irrelevant: 'irrelevant removed',
            localityVia: 'locality identified via OpenStreetMap',
            countyAbbr: 'county', nearAbbr: 'at',
            shown: 'Showing', of: 'of', seconds: 's',
            perSourceTitle: 'Sources',
            srcOk: 'active', srcEmpty: 'no results', srcError: 'unavailable',
            srcTimeout: 'no response (timeout)', srcNetwork: 'unreachable (network/CORS)',
            srcHttp: 'server error', srcNokey: 'no API key', srcPartial: 'partial',
            type: 'Type', period: 'Period', source: 'Source', all: 'All',
            type_article: 'Wikipedia article', type_structured: 'Structured data',
            type_place: 'OSM location', type_image: 'Image', type_map: 'Map',
            type_document: 'Document', type_audio: 'Audio', type_video: 'Video', type_collection: 'Collection',
            sparqlData: 'SPARQL data', semanticResource: 'Semantic resource',
            heritageObject: 'Heritage object', digitalDocument: 'Digital document',
            src_wikipedia: 'Wikipedia', src_wikidata: 'Wikidata', src_osm: 'OpenStreetMap',
            src_commons: 'Wikimedia Commons', src_dbpedia: 'DBpedia', src_archive: 'Archive.org',
            src_europeana: 'Europeana', src_ariadne: 'ARIADNE', src_cimec: 'CIMEC / RAN',
            sitArheologic: 'Archaeological site record',
            p_prehistory: 'Prehistoric', p_bronze: 'Bronze Age', p_iron: 'Iron Age',
            p_dacian: 'Dacian', p_roman: 'Roman', p_migration: 'Migration period',
            p_medieval: 'Medieval', p_modern: 'Modern', p_unspecified: 'Unspecified',
            timeline: 'Timeline', timelineNote: 'automatic classification',
            epochProfile: 'Epochs', epochProfileNote: 'of the corpus epoch attributions',
            mapView: 'Locations on map',
            ambiguousTitle: 'AMBIGUOUS LOCATION',
            ambiguousHelp: 'OpenStreetMap found several matches for this name. Pick one to refine the search:',
            exportJson: 'Export JSON', exportCsv: 'Export CSV',
            cachedFrom: 'Results from local cache', refresh: 'Refresh',
            keyTitle: 'Europeana API key (optional)', keyHelp: 'Europeana requires a free API key, obtainable in a few minutes at europeana.eu/api. The key is stored locally in your browser only. Without a key the search automatically continues with the other 8 sources.',
            keyPlaceholder: 'Europeana wskey', keySave: 'Save key', keySaved: 'The key was saved locally.',
            keyInvalid: 'The key was rejected by Europeana — check it and save it again.',
            year: 'Year', generated: 'Generated', query: 'Query',
            periodNote: 'Periods are classified automatically from keywords in the title and description — always check the original source.',
            partialNote: 'Sources that did not respond (the search continued with the others):',
            sourcesCount: 'sources'
        }
    };

    /* Period detection heuristics (diacritics-insensitive, word-aware —
     * "Romania" the country must NOT trigger the Roman period). */
    var PERIOD_RULES = [
        { id: 'prehistory', re: /preistor|prehistor|pal[eae]olit|neolit|eneolit|cucuteni|hamangia|gumelnita|\bboian\b|vinca|starcevo|turdas|petresti/i },
        { id: 'bronze', re: /\bbronz|otomani|wietenberg|monteoru|coslogeni|succuleni/i },
        { id: 'iron', re: /epoca fierului|iron age|hallstatt|halstatt|la[ -]?tene|latene|\bcelt|scythian|scitic|bastarn|thracian|tracic|basarabi|padea|babadag/i },
        { id: 'dacian', re: /epoca dacica|perioada dacica|\bdacic|\bdacian|\bdacii\b|\bdacilor\b|\bdacia\b|\bgeto\b|\bgetii\b|burebista|decebal|sarmizegetusa regia|cetatile dacice|gradistea de munte/i },
        /* Roman — a broad lexical field of terms that genuinely belong to the
         * ancient Roman period (castrum, legion, oil lamp, burgus, villa …).
         * The bare words "roman / romana / romani / romane / romanii /
         * romanilor" are NOT triggers on their own, because once diacritics are
         * stripped they could also be "român / română / români / române…"
         * (Romanian, the language / nationality) and would produce false
         * positives. They only count inside unambiguous compound phrases
         * ("imperiul roman", "dacia romana", "roman empire", … ). */
        { id: 'roman', re: /(\bcastr(u|a|e|ul|ului|elor|en|ense|orum)\b|\bleg(iune|iunea|iunii|iuni|ionar|ionari|ion|ions|ionary|ionarii|ionare)\b|\bopait(e|ul|ele|elor)?\b|\blucern\w*\b|\bburgus\b|\bvilla(e|s|rustica|rusticale)?\b|\bthermae\b|\bterm(e|ele|es|ae|arum)\b|\bamphitheatr\w*\b|\bamphiteatr\w*\b|\bamfiteatr\w*\b|\bforum\b|\bforul\b|\bapeduct\w*\b|\baqueduct\w*\b|\bcoloni(a|ae|e|ile|iilor)\b|\bmunicipi\w*\b|\blimes\b|\bcenturion\w*\b|\btropaeum\b|\bcastren(se|sis)\b|\b(ulpia|apulum|porolissum|drobeta|tropaeum|adamclisi|romula|zaldapa|durostorum|novae|viminacium)\b|\btraian\b|\btrajan\b|\bhadrian\b|\bconstanti\w*|imperiul roman|roman empire|imperium romanum|dacia romana|roman dacia|provincia dacia|provinci[aie]+\s+roman|roman province|roman fort|roman city|roman town|roman camp|roman road|roman bath|roman villa|roman legion|roman coin|roman coins|roman conquest|roman rule|roman era|roman period|roman site|roman ruin|roman temple|roman mosaic|roman forum|roman thermae|roman bridge|roman wall|drum roman|drumul roman|epoca romana|perioada romana|asezare romana|asezari romane|cetate romana|cetati romane|oras roman|orase romane|castrul roman|castre romane|zid roman|pod roman|cladire romana|monument roman|santier roman)/i },
        { id: 'migration', re: /gepids?|gepiz|avars?\b|huns?\b|\bhuni\b|slavs?\b|\bslavi\b|goths?\b|\bgoti\b|epoca migratiilor|migration period/i },
        { id: 'medieval', re: /medieval|mediev|evul mediu|middle ages|secolul (x|xi|xii|xiii|xiv|xv|xvi|xvii)\b|1[1-7]th century|cetate medievala|cetatea medievala|medieval fortress|medieval castle|castel|citadel|fortified church|biserica fortificata|fortareata|\bsaxons?\b|\bsasi\b|husit|secuiesc|knights?/i },
        { id: 'modern', re: /\bmodern|secolul (xviii|xix|xx|xxi)\b|1[89]th century|20th century|21st century|habsburg|austro-ungar|austro-hungarian|world war|razboiul mondial|primul razboi|al doilea razboi/i }
    ];

    /* ── small helpers ── */
    function lang() { return typeof window._currentLang === 'function' && window._currentLang() === 'en' ? 'en' : 'ro'; }
    function t(k) { var d = C[lang()] || C.ro; return (d[k] != null) ? d[k] : k; }
    function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function safeUrl(v) { try { var u = new URL(v, 'https://example.invalid'); return (u.protocol === 'https:' || u.protocol === 'http:') ? u.href : '#'; } catch (_) { return '#'; } }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function first(v) { return Array.isArray(v) ? v[0] : v; }
    function stripHtml(v) {
        return String(v == null ? '' : v)
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ').trim();
    }
    function stripDiacritics(v) { return String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
    /* de-duplication key: "File:Ulpia Traiana.jpg" ≡ "Ulpia Traiana" */
    function normKey(v) {
        return stripDiacritics(v).toLowerCase()
            .replace(/^file\s*:\s*/, '')
            .replace(/\.(jpe?g|jpeg|png|gif|svg|tiff?|webp|pdf|djvu|jp2)$/i, '')
            .replace(/[^a-z0-9\u00c0-\u024f]+/g, ' ').trim();
    }
    /* DESCRIPTION: 50–150 characters from the source (spec §OUTPUT FORMAT) */
    function clampDesc(v) {
        var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
        if (s.length > 150) return s.slice(0, 147).replace(/[\s,;.:]+\S*$/, '') + '…';
        return s;
    }
    function slug(v) { return stripDiacritics(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'localitate'; }
    /* great-circle distance in km (haversine) between {lat,lng} points */
    function distKm(a, b) {
        var R = 6371, rad = Math.PI / 180;
        var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
        var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    }
    /* "Miluani, Sălaj" → { name: 'Miluani', rest: 'Sălaj' } */
    function splitPhrase(q) {
        var parts = String(q == null ? '' : q).split(',');
        return { name: String(parts.shift() || '').trim(), rest: parts.join(' ').replace(/\s+/g, ' ').trim() };
    }
    function phraseName(q) { var p = splitPhrase(q); return p.name || String(q == null ? '' : q).trim(); }
    /* Exact-phrase query for the full-text sources: the locality name is sent
     * between quotes, so their engines stop fuzzy-matching it into unrelated
     * words ("Miluani" → "Miljan Miljanić"); the county stays a plain hint. */
    function exactPhrase(q) {
        var p = splitPhrase(q);
        if (!p.name) return String(q == null ? '' : q).trim();
        return '"' + p.name.replace(/"/g, '') + '"' + (p.rest ? ' ' + p.rest.replace(/"/g, '') : '');
    }

    function open() { var m = document.getElementById('babelModal'); if (m) { m.hidden = false; document.body.classList.add('babel-modal-open'); } }
    function close() { var m = document.getElementById('babelModal'); if (m) { m.hidden = true; document.body.classList.remove('babel-modal-open'); } destroyMap(); }
    function isPremium() { if (typeof window._dlIsPremium === 'function') return window._dlIsPremium(); var u = typeof window._authUser === 'function' ? window._authUser() : null; return !!(u && u.plan === 'premium'); }
    function updateButton() { var b = document.getElementById('babelSearchBtn'); if (!b) return; b.disabled = running; b.textContent = running ? '…' : t('button'); }

    /* ── resilient JSON fetch: timeout via AbortController, error classes ── */
    function fetchJson(url, timeout) {
        var c = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = c ? setTimeout(function () { c.abort(); }, timeout || 15000) : null;
        var opts = c ? { signal: c.signal } : {};
        return fetch(url, opts).then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (data) {
                if (!r.ok) {
                    var e = new Error((data && (data.message || data.error)) || ('HTTP ' + r.status));
                    e.status = r.status; e.data = data; throw e;
                }
                return data;
            });
        }, function (e) {
            if (timer) clearTimeout(timer);
            throw e;
        }).then(function (v) { if (timer) clearTimeout(timer); return v; });
    }
    function classifyError(e) {
        if (e && e.name === 'AbortError') return 'timeout';
        if (e && e.status) return 'http';
        return 'network';
    }
    function settle(p) { return p.then(function (v) { return { ok: true, value: v }; }, function (e) { return { ok: false, error: e }; }); }

    /* ════════════════════════ THE 7 SOURCES ════════════════════════ */

    /* 1. Wikipedia — ro AND en, both attempted; one failing keeps the other. */
    function wikiSearchOnce(query, lg) {
        var u = new URL('https://' + lg + '.wikipedia.org/w/api.php');
        u.search = new URLSearchParams({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: exactPhrase(query), srlimit: WIKI_LIMIT, srprop: 'snippet|timestamp' });
        return fetchJson(u.href, 12000).then(function (d) {
            return ((d.query && d.query.search) || []).map(function (r, i) {
                return {
                    title: r.title, description: clampDesc(stripHtml(r.snippet)),
                    type: 'article', source: 'wikipedia', lang: lg,
                    url: 'https://' + lg + '.wikipedia.org/wiki/' + encodeURIComponent(String(r.title).replace(/ /g, '_')),
                    rank: i, meta: { lang: lg, updated: r.timestamp || null }
                };
            });
        });
    }
    function sourceWikipedia(query) {
        return Promise.all([settle(wikiSearchOnce(query, 'ro')), settle(wikiSearchOnce(query, 'en'))]).then(function (rs) {
            var oks = rs.filter(function (r) { return r.ok; });
            if (!oks.length) throw rs[0].error;
            var results = [], seen = {};
            oks.forEach(function (r) {
                r.value.forEach(function (item) { var k = normKey(item.title); if (!k || seen[k]) return; seen[k] = 1; results.push(item); });
            });
            return { results: results, partial: oks.length < 2 };
        });
    }

    /* 2. Wikidata — SPARQL EntitySearch + labels/descriptions/coordinates.
     * EntitySearch is label-prefix based: it gets the bare locality name
     * (no ", county" suffix — that would simply return nothing). */
    function sourceWikidata(query, lg) {
        query = phraseName(query);
        var sparql = 'SELECT ?item ?itemLabel ?itemDescription ?coord WHERE {'
            + ' SERVICE wikibase:mwapi { bd:serviceParam wikibase:endpoint "www.wikidata.org";'
            + ' wikibase:api "EntitySearch"; mwapi:search "' + String(query).replace(/"/g, '\\"') + '";'
            + ' mwapi:language "' + lg + '"; mwapi:limit "20". ?item wikibase:apiOutputItem mwapi:item. }'
            + ' OPTIONAL { ?item wdt:P625 ?coord. }'
            + ' SERVICE wikibase:label { bd:serviceParam wikibase:language "' + lg + ',en". } } LIMIT 40';
        var u = new URL('https://query.wikidata.org/sparql');
        u.search = new URLSearchParams({ format: 'json', query: sparql });
        return fetchJson(u.href, 30000).then(function (d) {
            var bindings = (d.results && d.results.bindings) || [], seen = {}, results = [];
            bindings.forEach(function (b, i) {
                var id = String((b.item && b.item.value) || '').split('/').pop();
                if (!id || seen[id]) return;
                seen[id] = 1;
                var label = (b.itemLabel && b.itemLabel.value) || id;
                var desc = (b.itemDescription && b.itemDescription.value) || '';
                var pt = String((b.coord && b.coord.value) || ''), coords = null;
                var m = pt.match(/Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/);
                if (m) coords = { lat: Number(m[2]), lng: Number(m[1]) };
                results.push({
                    title: label, description: clampDesc(desc), type: 'structured', source: 'wikidata',
                    url: 'https://www.wikidata.org/wiki/' + id, rank: i, coords: coords,
                    typeKey: 'sparqlData', meta: { entityId: id }
                });
            });
            return { results: results };
        });
    }

    /* 3. OpenStreetMap — gazetteer + ambiguity detection.
     *
     * FIX (2026-09): localities written without Romanian diacritics
     * ("Sacalaseni" for "Săcălășeni") were missed, and a "Locality, County"
     * query fell back to matching only the county. The map's own search bar
     * already solves both, on the static OSM.geojson dataset, so this source
     * now reuses EXACTLY that matcher (window._osmPlaceLookup) and only falls
     * back to Nominatim when the dataset is unavailable (tests, other pages).
     */
    function osmLocalLookup(query) {
        if (typeof window === 'undefined' || typeof window._osmPlaceLookup !== 'function') return Promise.resolve(null);
        try {
            return Promise.resolve(window._osmPlaceLookup(query, 8)).then(function (m) {
                return Array.isArray(m) && m.length ? m : null;
            }, function () { return null; });
        } catch (_) { return Promise.resolve(null); }
    }

    function osmFromLocal(matches) {
        var results = matches.map(function (r, i) {
            var name = r.display_name || '';
            var where = [r.judet ? 'jud. ' + r.judet : '', 'România'].filter(Boolean).join(', ');
            return {
                title: name, description: clampDesc([name, where].filter(Boolean).join(', ')),
                type: 'place', source: 'osm',
                url: 'https://www.openstreetmap.org/?mlat=' + r.lat + '&mlon=' + r.lon + '#map=14/' + r.lat + '/' + r.lon,
                rank: i, coords: { lat: Number(r.lat), lng: Number(r.lon) },
                meta: { category: 'place', osmType: r.fclass || null, judet: r.judet || null }
            };
        });
        return {
            results: results,
            osmMatches: matches.map(function (r) {
                return {
                    name: r.display_name || '',
                    display: [r.display_name, r.judet, 'România'].filter(Boolean).join(', '),
                    type: r.fclass || '', category: 'place'
                };
            })
        };
    }

    /* Nominatim fallback — strictly throttled to 1 request/second (usage policy).
     * The call is memoised per query while in flight, because both the OSM
     * runner and the CIMEC nearby-sites runner need the same locality fix —
     * one search must never fire two identical Nominatim requests. */
    var _osmInflight = {};
    function sourceOsm(query, lg) {
        var k = lg + '\u0000' + query;
        if (_osmInflight[k]) return _osmInflight[k];
        var p = sourceOsmRun(query, lg);
        _osmInflight[k] = p;
        var clear = function () { if (_osmInflight[k] === p) delete _osmInflight[k]; };
        p.then(clear, clear);
        return p;
    }
    function sourceOsmRun(query, lg) {
        return osmLocalLookup(query).then(function (local) {
            if (local) return osmFromLocal(local);
            var wait = NOMINATIM_MIN_INTERVAL - (Date.now() - lastNominatimAt);
            return (wait > 0 ? sleep(wait) : Promise.resolve()).then(function () {
                lastNominatimAt = Date.now();
                var u = new URL('https://nominatim.openstreetmap.org/search');
                u.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: 8, addressdetails: 1, 'accept-language': lg });
                return fetchJson(u.href, 15000);
            }).then(function (d) {
                var arr = Array.isArray(d) ? d : [];
                var results = arr.map(function (r, i) {
                    var name = r.name || String(r.display_name || '').split(',')[0] || '?';
                    var judet = (r.address && (r.address.county || r.address.state)) || null;
                    return {
                        title: name, description: clampDesc(r.display_name || name),
                        type: 'place', source: 'osm',
                        url: 'https://www.openstreetmap.org/' + (r.osm_type || 'node') + '/' + (r.osm_id || ''),
                        rank: i, coords: { lat: Number(r.lat), lng: Number(r.lon) },
                        meta: { category: r.category || null, osmType: r.type || null, judet: judet }
                    };
                });
                return { results: results, osmMatches: arr.map(function (r) { return { name: r.name || String(r.display_name || '').split(',')[0], display: r.display_name || '', type: r.type || '', category: r.category || '' }; }) };
            });
        });
    }

    /* Resolve what the user typed against the OSM gazetteer: the canonical,
     * diacritics-correct locality name PLUS its county (județ) and coordinates
     * ("miluani, salaj" → { name: 'Miluani', judet: 'Sălaj', lat, lon }).
     * Only an exact name match (diacritics-insensitive) is accepted, so a
     * partial prefix never resolves to a random locality. */
    function resolveLocality(query) {
        var typed = String(query || '').trim();
        if (!typed) return Promise.resolve(null);
        return osmLocalLookup(typed).then(function (matches) {
            if (!matches || !matches.length) return null;
            var typedName = normKey(typed.split(',')[0]);
            if (!typedName) return null;
            for (var i = 0; i < matches.length; i++) {
                var m = matches[i];
                var name = String(m.display_name || '').trim();
                if (name && normKey(name) === typedName) {
                    return {
                        name: name,
                        judet: m.judet || null,
                        lat: Number(m.lat), lon: Number(m.lon)
                    };
                }
            }
            return null;
        }, function () { return null; });
    }

    /* Canonical spelling for the text-indexed sources (Wikipedia, Wikidata,
     * Commons, DBpedia, CIMEC…): "sacalaseni, maramures" → "Săcălășeni".
     * Returns null when nothing matches or the user already typed the
     * canonical form. */
    function resolveCanonicalQuery(query) {
        var typed = String(query || '').trim();
        if (!typed) return Promise.resolve(null);
        return resolveLocality(typed).then(function (loc) {
            if (!loc || !loc.name) return null;
            if (normKey(loc.name) === normKey(typed)) return null;
            return loc.name;
        });
    }

    /* 4. Wikimedia Commons — photos, plans and old maps (namespace File:). */
    function sourceCommons(query) {
        var u = new URL('https://commons.wikimedia.org/w/api.php');
        u.search = new URLSearchParams({
            action: 'query', format: 'json', origin: '*', generator: 'search',
            gsrsearch: exactPhrase(query), gsrlimit: COMMONS_LIMIT, gsrnamespace: 6,
            prop: 'imageinfo', iiprop: 'url|extmetadata|mime|size', iiurlwidth: 320
        });
        return fetchJson(u.href, 15000).then(function (d) {
            var pages = (d.query && d.query.pages) || {};
            var arr = Object.keys(pages).map(function (k) { return pages[k]; })
                .filter(function (p) { return p.imageinfo && p.imageinfo[0]; })
                .sort(function (a, b) { return (a.index || 99) - (b.index || 99); });
            var results = [];
            arr.forEach(function (p, i) {
                var ii = p.imageinfo[0], em = ii.extmetadata || {}, mime = ii.mime || '';
                if (/^audio\//.test(mime) || /^video\//.test(mime)) return; // media noise
                var fname = String(p.title || '').replace(/^File:/, '');
                var desc = stripHtml(em.ImageDescription && em.ImageDescription.value || '');
                var cats = String(em.Categories && em.Categories.value || '');
                var isMap = mime === 'image/svg+xml' || /\b(map|maps|hart|plan|kart|atlas)\b/i.test(fname + ' ' + desc + ' ' + cats);
                var type = (mime === 'application/pdf' || mime === 'image/vnd.djvu') ? 'document' : (isMap ? 'map' : 'image');
                results.push({
                    title: fname.replace(/\.[a-z0-9]+$/i, ''),
                    description: clampDesc(desc || (em.ObjectName && stripHtml(em.ObjectName.value)) || fname),
                    type: type, source: 'commons',
                    url: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(String(p.title).replace(/ /g, '_'))),
                    image: ii.thumburl || ii.url || null, rank: i,
                    meta: { license: em.LicenseShortName && em.LicenseShortName.value || null, artist: stripHtml(em.Artist && em.Artist.value || '') || null }
                });
            });
            return { results: results };
        });
    }

    /* 5. DBpedia Lookup — semantic resources (English DBpedia only; the
     * de/fr/… interwiki hits are duplicates of the same entities). The lookup
     * is label-based, so it gets the bare locality name. */
    function sourceDbpedia(query) {
        var u = new URL('https://lookup.dbpedia.org/api/search');
        u.search = new URLSearchParams({ query: phraseName(query), limit: OTHER_LIMIT, format: 'JSON' });
        return fetchJson(u.href, 15000).then(function (d) {
            var docs = (d && d.docs) || [], results = [];
            docs.forEach(function (doc, i) {
                var res = String(first(doc.resource || doc.id) || '');
                if (!/^https?:\/\/dbpedia\.org\/resource\//.test(res)) return;
                var label = stripHtml(first(doc.label) || '') || decodeURIComponent(res.split('/resource/')[1] || 'DBpedia');
                var cats = (doc.category || []).map(function (c) { return String(c).split('Category:').pop(); }).filter(Boolean).slice(0, 4);
                results.push({
                    title: label, description: clampDesc(stripHtml(first(doc.comment) || '')),
                    type: 'structured', source: 'dbpedia', url: res, rank: i,
                    typeKey: 'semanticResource', meta: { categories: cats }
                });
            });
            return { results: results };
        });
    }

    /* 6. Archive.org — digitised old documents and collections. */
    function sourceArchive(query) {
        var u = new URL('https://archive.org/advancedsearch.php');
        var qs = new URLSearchParams({ q: exactPhrase(query), rows: OTHER_LIMIT, page: 1, output: 'json' });
        ['identifier', 'title', 'description', 'year', 'mediatype'].forEach(function (f) { qs.append('fl[]', f); });
        u.search = qs;
        return fetchJson(u.href, 15000).then(function (d) {
            var docs = (d.response && d.response.docs) || [];
            var MT = { texts: 'document', image: 'image', audio: 'audio', movies: 'video', collection: 'collection', software: 'collection', etree: 'audio' };
            return {
                results: docs.map(function (doc, i) {
                    var id = doc.identifier || ('archive-' + i);
                    var desc = Array.isArray(doc.description) ? doc.description[0] : doc.description;
                    return {
                        title: stripHtml(doc.title || id) || id,
                        description: clampDesc(stripHtml(desc || '')),
                        type: MT[doc.mediatype] || 'document', source: 'archive',
                        url: 'https://archive.org/details/' + encodeURIComponent(id),
                        rank: i, year: doc.year || null,
                        typeKey: doc.mediatype === 'texts' ? 'digitalDocument' : null,
                        meta: { mediatype: doc.mediatype || null }
                    };
                })
            };
        });
    }

    /* 7. Europeana — museum objects and cultural collections (needs a free
     * wskey; without one the source is simply marked inactive). */
    function europeanaKey() {
        try {
            if (typeof localStorage !== 'undefined') {
                var k = localStorage.getItem('babel.europeanaKey');
                if (k) return String(k);
            }
        } catch (_) { /* private mode */ }
        return (typeof window !== 'undefined' && window.DETECTLAB_EUROPEANA_KEY) || '';
    }
    function saveEuropeanaKey(key) {
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('babel.europeanaKey', String(key || '').trim()); } catch (_) { }
    }
    function sourceEuropeana(query, key) {
        if (!key) { var e = new Error('nokey'); e.code = 'nokey'; return Promise.reject(e); }
        var u = new URL('https://api.europeana.eu/record/v2/search.json');
        u.search = new URLSearchParams({ wskey: key, query: exactPhrase(query), rows: OTHER_LIMIT, profile: 'minimal' });
        return fetchJson(u.href, 15000).then(function (d) {
            if (d && d.success === false) {
                var err = new Error(d.message || d.error || 'Europeana error');
                err.code = (d && d.code) || 'invalid_apikey';
                throw err;
            }
            var items = d.items || [];
            var ET = { IMAGE: 'image', TEXT: 'document', VIDEO: 'video', SOUND: 'audio', '3D': 'image' };
            return {
                results: items.map(function (it, i) {
                    var title = (Array.isArray(it.title) ? it.title[0] : it.title) || t('heritageObject');
                    var prov = (Array.isArray(it.edmDataProvider) ? it.edmDataProvider[0] : it.edmDataProvider) || '';
                    return {
                        title: title, description: clampDesc(prov),
                        type: ET[it.edmType] || 'document', source: 'europeana',
                        url: 'https://www.europeana.eu/item' + (it.id || ''),
                        rank: i, typeKey: 'heritageObject',
                        meta: { provider: prov || null, edmType: it.edmType || null }
                    };
                })
            };
        });
    }

    /* ════════════════════════ JSONP helper (for ArcGIS REST) ════════════════════════ */
    var _jsonpCounter = 0;
    function jsonpFetch(url, timeout) {
        timeout = timeout || 18000;
        return new Promise(function (resolve, reject) {
            var cbName = '__babelJsonp' + (++_jsonpCounter);
            var script = document.createElement('script');
            var timer = setTimeout(function () {
                cleanup();
                reject(new Error('JSONP timeout'));
            }, timeout);
            function cleanup() {
                clearTimeout(timer);
                try { delete window[cbName]; } catch (_) { window[cbName] = undefined; }
                if (script.parentNode) script.parentNode.removeChild(script);
            }
            window[cbName] = function (data) {
                cleanup();
                resolve(data);
            };
            script.onerror = function () {
                cleanup();
                reject(new Error('JSONP script load error'));
            };
            script.src = url + '&callback=' + cbName;
            document.head.appendChild(script);
        });
    }

    /* 8. CIMEC / RAN — fișe de sit arheologic din Repertoriul Arheologic Național.
     *
     * FIX (2026-09): the sites around the searched locality never showed up,
     * for two reasons. (1) The ArcGIS `find` task answers with an OBJECT —
     * `{ "results": [...] }` — while the old code expected a bare array, so
     * every live response was silently discarded. (2) A name-only find misses
     * sites recorded under a village/toponym other than the typed one. The
     * source now runs a real SPATIAL search around the locality's OSM
     * coordinates (radius CIMEC_NEARBY_RADIUS_M) on the heritage layers,
     * preferring the map's already-loaded local dataset
     * (window._localLayerData) and falling back to ArcGIS REST `query` +
     * `find` tasks via JSONP (same proven approach as the 600 m circles).
     * Every finding carries the distance to the searched locality. */
    var CIMEC_REST_BASE = 'https://eism.geo-spatial.ro/eismgeo/rest/services/Patrimoniu/PatrimoniuWM/MapServer';
    var CIMEC_SEARCH_LAYERS = [0, 5, 6]; // 0: situri (puncte), 5: situri arheologice, 6: descoperiri
    var CIMEC_SEARCH_FIELDS = ['Localitate', 'Nume', 'Toponim', 'Denumire', 'DenumireSit', 'NUMESIT', 'Comuna', 'Judet'];

    function cimecAttr(attrs, names) {
        if (!attrs) return null;
        for (var i = 0; i < names.length; i++) {
            var v = attrs[names[i]];
            if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
        }
        var lower = names.map(function (n) { return n.toLowerCase(); });
        for (var key in attrs) {
            if (lower.indexOf(String(key).toLowerCase()) !== -1) {
                var val = attrs[key];
                if (val !== undefined && val !== null && String(val).trim() !== '') return String(val).trim();
            }
        }
        return null;
    }
    var CIMEC_PROPS = {
        ran: ['CodRAN', 'COD_RAN', 'Cod_RAN', 'CODRAN', 'CODSIT', 'CodSit', 'NR_RAN', 'RAN'],
        name: ['DenumireSit', 'Denumire', 'Denumire_sit', 'NUMESIT', 'NumeSit', 'Nume', 'Toponim', 'Eticheta'],
        locality: ['Localitate', 'LOCALITATE', 'Localitat', 'Sat', 'SAT'],
        county: ['Judet', 'JUDET', 'Județ', 'JUDEȚ'],
        commune: ['Comuna', 'COMUNA', 'UAT'],
        tip: ['Tip', 'TIP', 'TipSit', 'Categorie', 'Eticheta']
    };

    /* Normalise the three response shapes into one feature list:
     * find task → {results:[...]}, layer query → {features:[...]},
     * legacy/test stubs → bare array. An ArcGIS error object throws. */
    function cimecFeatureList(data) {
        if (!data) return [];
        if (data.error) { var e = new Error(data.error.message || 'ArcGIS error'); e.status = data.error.code || 500; throw e; }
        if (Array.isArray(data)) return data;
        if (Array.isArray(data.results)) return data.results;
        if (Array.isArray(data.features)) return data.features;
        return [];
    }

    /* Representative {lat,lng} of an ArcGIS (x/y, rings, paths) or GeoJSON geometry. */
    function cimecPointOf(geom) {
        if (!geom) return null;
        if (typeof geom.x === 'number' && typeof geom.y === 'number' && isFinite(geom.x) && isFinite(geom.y)) {
            return { lat: geom.y, lng: geom.x };
        }
        var ring = (geom.rings && geom.rings[0]) || (geom.paths && geom.paths[0]) || null;
        if (!ring && geom.type === 'Point' && Array.isArray(geom.coordinates)) {
            return { lat: geom.coordinates[1], lng: geom.coordinates[0] };
        }
        if (!ring && geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0]) ring = geom.coordinates[0];
        if (!ring && geom.type === 'MultiPolygon' && geom.coordinates && geom.coordinates[0]) ring = geom.coordinates[0][0];
        if (!ring && geom.type === 'LineString' && Array.isArray(geom.coordinates)) ring = geom.coordinates;
        if (ring && ring.length) {
            /* average of the vertices — good enough as a representative point */
            var sLat = 0, sLng = 0, n = 0;
            for (var i = 0; i < ring.length; i++) {
                var pt = ring[i];
                if (Array.isArray(pt) && isFinite(pt[0]) && isFinite(pt[1])) { sLng += pt[0]; sLat += pt[1]; n++; }
            }
            if (n) return { lat: sLat / n, lng: sLng / n };
        }
        return null;
    }

    /* One raw heritage feature → one Babel result (with distance to the locality). */
    function cimecResult(attrs, coords, layerId, loc, rank) {
        var ranCode = cimecAttr(attrs, CIMEC_PROPS.ran);
        var name = cimecAttr(attrs, CIMEC_PROPS.name);
        if (!name && !ranCode) return null;
        var locality = cimecAttr(attrs, CIMEC_PROPS.locality) || '';
        var county = cimecAttr(attrs, CIMEC_PROPS.county) || '';
        var commune = cimecAttr(attrs, CIMEC_PROPS.commune) || '';
        var distM = (coords && loc && isFinite(loc.lat) && isFinite(loc.lon))
            ? Math.round(distKm(coords, { lat: loc.lat, lng: loc.lon }) * 1000) : null;
        var descParts = [name];
        if (locality && locality !== name) descParts.push(locality);
        if (commune && commune !== locality) descParts.push(commune);
        if (county) descParts.push(county);
        if (distM != null) descParts.push('~' + (distM < 950 ? distM + ' m' : (distM / 1000).toFixed(1) + ' km'));
        var url = ranCode
            ? 'https://ran.cimec.ro/sel.asp?codran=' + encodeURIComponent(ranCode)
            : 'https://ran.cimec.ro/sel.asp?descript=' + encodeURIComponent(name || '');
        return {
            title: name || 'Sit RAN ' + ranCode,
            description: clampDesc(descParts.filter(Boolean).join(' · ')),
            type: 'structured', source: 'cimec',
            typeKey: 'sitArheologic',
            url: url, rank: rank, coords: coords || null,
            distM: distM,
            meta: {
                ranCode: ranCode || null, layerId: layerId,
                locality: locality || null, county: county || null, commune: commune || null,
                tip: cimecAttr(attrs, CIMEC_PROPS.tip) || null
            }
        };
    }

    /* De-duplicate, sort by distance to the locality and cap the site list. */
    function cimecFinish(rawResults) {
        var seen = {}, out = [];
        rawResults.forEach(function (r) {
            if (!r) return;
            var key = (r.meta && r.meta.ranCode) ? 'ran:' + r.meta.ranCode
                : normKey(r.title) + (r.coords ? '@' + r.coords.lat.toFixed(3) + ',' + r.coords.lng.toFixed(3) : '');
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(r);
        });
        out.sort(function (a, b) {
            var da = a.distM == null ? Infinity : a.distM, db = b.distM == null ? Infinity : b.distM;
            return da - db;
        });
        out = out.slice(0, CIMEC_MAX_RESULTS);
        out.forEach(function (r, i) { r.rank = i; });
        return { results: out };
    }

    /* (a) The map page already holds the full heritage layers as GeoJSON
     * (window._localLayerData, layers 0/5/6) — search them directly, without
     * any network round-trip. Returns null when the dataset is not loaded. */
    function cimecFromLocalLayers(query, loc) {
        var data = (typeof window !== 'undefined') ? window._localLayerData : null;
        if (!data) return null;
        var feats = [];
        CIMEC_SEARCH_LAYERS.forEach(function (id) {
            var fc = data[id];
            if (fc && Array.isArray(fc.features)) fc.features.forEach(function (f) { feats.push({ f: f, layerId: id }); });
        });
        if (!feats.length) return null;
        var nameNorm = normKey(phraseName(query));
        var hasLoc = !!(loc && isFinite(loc.lat) && isFinite(loc.lon));
        var raw = [];
        for (var i = 0; i < feats.length; i++) {
            var props = feats[i].f.properties || {};
            var coords = cimecPointOf(feats[i].f.geometry);
            var keep = false;
            if (hasLoc && coords && distKm(coords, { lat: loc.lat, lng: loc.lon }) * 1000 <= CIMEC_NEARBY_RADIUS_M) keep = true;
            if (!keep && nameNorm && nameNorm.length >= 3) {
                var hay = normKey([
                    cimecAttr(props, CIMEC_PROPS.locality),
                    cimecAttr(props, CIMEC_PROPS.name),
                    cimecAttr(props, CIMEC_PROPS.commune)
                ].filter(Boolean).join(' '));
                if (hay && hay.indexOf(nameNorm) !== -1) keep = true;
            }
            if (!keep) continue;
            raw.push(cimecResult(props, coords, feats[i].layerId, loc, raw.length));
        }
        return cimecFinish(raw);
    }

    /* (b) Live ArcGIS REST fallbacks via JSONP. */
    function cimecSpatialQuery(layerId, loc) {
        var dLat = CIMEC_NEARBY_RADIUS_M / 111320;
        var dLng = CIMEC_NEARBY_RADIUS_M / (111320 * Math.max(0.2, Math.cos(loc.lat * Math.PI / 180)));
        var env = [loc.lon - dLng, loc.lat - dLat, loc.lon + dLng, loc.lat + dLat].join(',');
        var u = CIMEC_REST_BASE + '/' + layerId + '/query'
            + '?where=1%3D1'
            + '&geometry=' + encodeURIComponent(env)
            + '&geometryType=esriGeometryEnvelope'
            + '&inSR=4326&spatialRel=esriSpatialRelIntersects'
            + '&outFields=*&returnGeometry=true&outSR=4326'
            + '&resultRecordCount=200&f=json';
        return jsonpFetch(u, 20000).then(function (data) {
            return cimecFeatureList(data).map(function (feat) {
                return { attrs: feat.attributes || {}, geom: feat.geometry || null, layerId: layerId };
            });
        });
    }
    function cimecFind(query) {
        var u = CIMEC_REST_BASE + '/find'
            + '?searchText=' + encodeURIComponent(phraseName(query))
            + '&layers=' + CIMEC_SEARCH_LAYERS.join(',')
            + '&searchFields=' + encodeURIComponent(CIMEC_SEARCH_FIELDS.join(','))
            + '&contains=true'
            + '&sr=4326'
            + '&returnGeometry=true'
            + '&f=json';
        return jsonpFetch(u, 20000).then(function (data) {
            return cimecFeatureList(data).map(function (feat) {
                return { attrs: feat.attributes || {}, geom: feat.geometry || null, layerId: feat.layerId };
            });
        });
    }
    function sourceCimec(query, loc) {
        /* the map's already-loaded dataset wins — zero network needed */
        var local = null;
        try { local = cimecFromLocalLayers(query, loc); } catch (_) { local = null; }
        if (local) return Promise.resolve(local);
        var tasks = [];
        if (loc && isFinite(loc.lat) && isFinite(loc.lon)) {
            CIMEC_SEARCH_LAYERS.forEach(function (layerId) { tasks.push(settle(cimecSpatialQuery(layerId, loc))); });
        }
        tasks.push(settle(cimecFind(query)));
        return Promise.all(tasks).then(function (outs) {
            var oks = outs.filter(function (o) { return o.ok; });
            if (!oks.length) throw outs[outs.length - 1].error;
            var raw = [];
            oks.forEach(function (o) {
                (o.value || []).forEach(function (item) {
                    raw.push(cimecResult(item.attrs, cimecPointOf(item.geom), item.layerId, loc, raw.length));
                });
            });
            return cimecFinish(raw);
        });
    }

    /* ═══════════ 9. ARIADNE portal (d4science) — the European archaeological catalogue ═══════════
     *
     * The portal's public JSON API is CORS-open (`Access-Control-Allow-Origin: *`)
     * and answers `GET /api/search?q=…&size=…` with
     * `{ total:{value}, hits:[{id, data:{…}}] }`. A record carries title,
     * description, spatial.placeName, temporal/nativePeriod.periodName,
     * subjects, publisher/contributor, issued date and a landing page.
     *
     * THE SEARCH-ENGINE PROBLEM (reported 2026-10, reproduced against the live
     * service): the Elasticsearch index behind the portal is matched as whole
     * *raw* tokens and is NOT diacritics-folded. The portal's own type-ahead
     * appends a wildcard (`q | q*`), so "Moldovene" suggests the record of
     * Stejeriș (com. Moldovenești) — but the results page sends the literal
     * query, so the complete name typed without diacritics
     *
     *     /api/search?q=Moldovenesti   → {"total":{"value":0}}   ← "No resources found"
     *     /api/search?q=Moldovene      → 0 as well (no prefix in the results page)
     *     /api/search?q=Moldovenești   → 36 records
     *     /api/search?q=Moldovene*     → 81 records (the Stejeriș record is #1)
     *
     * The adapter therefore repairs the query instead of forwarding it:
     *   (a) the canonical spelling resolved from the OSM gazetteer
     *       ("Moldovenești"), which the portal indexes verbatim;
     *   (b) a wildcard stem cut in front of the LAST diacritic of that
     *       spelling ("Moldovene*"), which matches the raw index whatever the
     *       user typed, and — for diacritics-free names — the last two
     *       characters removed ("Turdas" → "Turda*");
     *   (c) what the user actually typed.
     * Answers are merged by resource id (the portal's own `id`), hits coming
     * from a widened (b)/(c) query are kept only when the record really
     * mentions the locality, and everything then goes through the module's
     * usual cross-source aggregation and relevance guard.
     */
    var ARIADNE_TYPE_MAP = {
        image: 'image', 'still image': 'image', photographic: 'image',
        map: 'map', cartographic: 'map',
        collection: 'collection',
        sound: 'audio', audio: 'audio',
        video: 'video', 'moving image': 'video',
        '3d': 'image'
    };
    var RO_DIACRITICS = '\u0103\u00e2\u00ee\u0219\u015f\u021b\u0163\u0102\u00c2\u00ce\u0218\u015e\u021a\u0162';

    function roDiacriticAt(word, i) { return RO_DIACRITICS.indexOf(String(word).charAt(i)) !== -1; }
    function lastRoDiacritic(word) {
        word = String(word || '');
        for (var i = word.length - 1; i >= 0; i--) if (roDiacriticAt(word, i)) return i;
        return -1;
    }
    /* One word → a token the portal's raw index is guaranteed to match, or
     * null when the word is short enough to be sent verbatim. */
    function ariadneWordStem(word) {
        word = String(word || '');
        if (word.length < 5) return null;
        var cut = lastRoDiacritic(word);
        /* accented spelling: everything before the last diacritic is raw text
         * the index certainly contains — "Moldovenești" → "Moldovene*" */
        if (cut >= 4) return word.slice(0, cut) + '*';
        /* diacritics-free spelling (no gazetteer fix available): a short stem
         * that survives the accent the index kept — "Moldovenesti" → "Moldoven*" */
        if (word.length < 6) return null;
        return word.slice(0, Math.max(4, word.length - 3)) + '*';
    }
    function ariadneStemQuery(text) {
        var words = String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
        if (!words.length) return null;
        var used = false, out = [];
        words.forEach(function (w) {
            var s = ariadneWordStem(w);
            if (s) { out.push(s); used = true; } else { out.push(w); }
        });
        return used ? out.join(' ') : null;
    }
    /* The repaired query set actually sent to the portal (max 3 requests). */
    function ariadneQueries(name, typed) {
        var out = [];
        function add(q) {
            q = String(q == null ? '' : q).trim().replace(/\s+/g, ' ');
            if (!q) return;
            for (var i = 0; i < out.length; i++) if (out[i].toLowerCase() === q.toLowerCase()) return;
            out.push(q);
        }
        add(name);
        add(ariadneStemQuery(name));
        add(typed);
        add(ariadneStemQuery(typed));
        return out.slice(0, ARIADNE_MAX_QUERIES);
    }

    /* ARIADNE answers with objects in the singular (`title:{text,language}`)
     * and with arrays in the plural (`descriptionOther`, `spatial`, …). */
    function ariadneFieldText(field) {
        if (!field) return '';
        if (typeof field === 'string') return field;
        if (Array.isArray(field)) {
            for (var i = 0; i < field.length; i++) {
                var s = ariadneFieldText(field[i]);
                if (s) return s;
            }
            return '';
        }
        return String(field.text || field.prefLabel || field.label || field.placeName || field.name || '');
    }
    function ariadneLabels(list) {
        var out = [];
        (Array.isArray(list) ? list : (list ? [list] : [])).forEach(function (x) {
            var s = x && (x.prefLabel || x.label || x.name || (typeof x === 'string' ? x : ''));
            if (s && out.indexOf(String(s)) === -1) out.push(String(s));
        });
        return out;
    }
    function ariadnePeriods(d) {
        var names = [];
        [d.temporal, d.nativePeriod].forEach(function (list) {
            (Array.isArray(list) ? list : (list ? [list] : [])).forEach(function (t) {
                var n = t && t.periodName;
                if (n && names.indexOf(String(n)) === -1) names.push(String(n));
            });
        });
        return names;
    }
    function ariadneCoords(d) {
        var out = null;
        (Array.isArray(d.spatial) ? d.spatial : (d.spatial ? [d.spatial] : [])).forEach(function (s) {
            if (out || !s) return;
            var g = s.geopoint || s.geometry || s.point;
            if (!g) return;
            var lat = Number(g.lat != null ? g.lat : g.y), lon = Number(g.lon != null ? g.lon : g.x);
            if (isFinite(lat) && isFinite(lon)) out = { lat: lat, lng: lon };
        });
        return out;
    }
    function ariadneResult(hit) {
        var d = (hit && hit.data) || {};
        var title = ariadneFieldText(d.title) || ariadneFieldText(d.titleOther) ||
            ariadneFieldText(d.is_about) || ariadneFieldText(d.spatial);
        if (!title) return null;
        var place = ariadneFieldText(d.spatial);
        var providers = ariadneLabels(d.publisher).concat(ariadneLabels(d.contributor));
        var subjects = ariadneLabels(d.nativeSubject).concat(ariadneLabels(d.derivedSubject));
        var periods = ariadnePeriods(d);
        var desc = ariadneFieldText(d.description) || ariadneFieldText(d.descriptionOther) ||
            [place, subjects.slice(0, 4).join(', ')].filter(Boolean).join(' — ');
        var type = ARIADNE_TYPE_MAP[String(d.resourceType || '').toLowerCase()] || 'document';
        var issued = String(d.issued || d.wasCreated || d.modified || '');
        var year = (issued.match(/\b(1\d{3}|20\d{2})\b/) || [])[1] ||
            (String(title).match(/anul:?\s*(\d{4})/i) || [])[1] || null;
        return {
            title: String(title),
            description: clampDesc(stripHtml(desc)),
            type: type, source: 'ariadne',
            url: ARIADNE_RESOURCE_BASE + encodeURIComponent(hit.id),
            rank: 0, year: year || null,
            coords: ariadneCoords(d),
            meta: {
                provider: providers[0] || null,
                resourceType: d.resourceType || null,
                place: place || null,
                periods: periods,
                subjects: subjects.slice(0, 6),
                landingPage: d.landingPage || null
            }
        };
    }

    /* One repaired spelling → the portal's search API. */
    function ariadneFetch(q) {
        var u = new URL(ARIADNE_BASE + '/search');
        u.search = new URLSearchParams({ q: q, size: String(ARIADNE_QUERY_SIZE) });
        return fetchJson(u.href, 20000).then(function (d) {
            if (d && d.error) {
                var err = new Error((d.error && (d.error.message || d.error.msg)) || 'ARIADNE search error');
                err.status = 502;
                throw err;
            }
            return (d && Array.isArray(d.hits)) ? d.hits : [];
        });
    }
    /* Wildcard hits are a superset ("Moldovene*" also reaches Moldoveni,
     * Moldoveneasca …): keep only the ones that really mention the locality —
     * the global relevance guard cannot do this job alone when the gazetteer
     * could not confirm the place. */
    function ariadneMentions(item, anchors) {
        if (!anchors || !anchors.length) return true;
        var hay = normKey([
            item.title, item.description,
            item.meta && item.meta.place,
            item.meta && (item.meta.periods || []).join(' '),
            item.meta && (item.meta.subjects || []).join(' ')
        ].filter(Boolean).join(' '));
        for (var i = 0; i < anchors.length; i++) {
            if (anchors[i] && hay.indexOf(anchors[i]) !== -1) return true;
        }
        return false;
    }
    function sourceAriadne(typed, canonical, locality) {
        var name = (locality && locality.name) || canonical || phraseName(typed);
        var queries = ariadneQueries(name, phraseName(typed));
        if (!queries.length) return Promise.resolve({ results: [], partial: false, queries: [] });
        var anchors = [];
        [name, phraseName(typed), canonical].forEach(function (n) {
            var k = normKey(n || '');
            if (k && k.length >= 3 && anchors.indexOf(k) === -1) anchors.push(k);
        });
        return Promise.all(queries.map(function (q) {
            /* Promise.resolve().then(...) also turns a synchronous throw from
             * an exotic environment into a normal per-source failure. */
            return settle(Promise.resolve().then(function () { return ariadneFetch(q); }));
        })).then(function (rs) {
            var oks = rs.filter(function (r) { return r.ok; });
            if (!oks.length) throw rs[0].error;
            var seen = {}, results = [];
            queries.forEach(function (q, i) {
                var r = rs[i];
                if (!r.ok) return;
                (r.value || []).forEach(function (hit) {
                    if (!hit || !hit.id || seen[hit.id]) return;
                    var item = null;
                    try { item = ariadneResult(hit); } catch (_) { item = null; }
                    if (!item) return;
                    if (i > 0 && !ariadneMentions(item, anchors)) return;
                    seen[hit.id] = 1;
                    item.rank = results.length;
                    results.push(item);
                });
            });
            return {
                results: results.slice(0, ARIADNE_MAX_RESULTS),
                partial: oks.length < rs.length,
                queries: queries
            };
        });
    }

    /* ══════════════════ parallel orchestration + aggregation ══════════════════ */

    function searchAll(query, lg, key, seq, onSource, textQuery, locality) {
        var t0 = Date.now();
        /* textQuery = the canonical, diacritics-correct spelling used for the
         * text-indexed sources; the OSM gazetteer keeps what the user typed. */
        var tq = textQuery || query;
        /* CIMEC needs the locality coordinates for its spatial nearby-sites
         * search: the gazetteer fix wins, otherwise the (memoised) OSM source
         * result is reused — never a second identical request. */
        var localityFix = locality ? Promise.resolve(locality) : sourceOsm(query, lg).then(function (out) {
            var typedName = normKey(phraseName(query));
            var places = ((out && out.results) || []).filter(function (r) { return r.coords && isFinite(r.coords.lat); });
            var exact = places.filter(function (r) { return normKey(r.title) === typedName; })[0];
            var best = exact || places[0];
            return best ? { name: best.title, judet: (best.meta && best.meta.judet) || null, lat: best.coords.lat, lon: best.coords.lng } : null;
        }, function () { return null; });
        var runners = [
            { id: 'wikipedia', run: function () { return sourceWikipedia(tq); } },
            { id: 'wikidata', run: function () { return sourceWikidata(tq, lg); } },
            { id: 'osm', run: function () { return sourceOsm(query, lg); } },
            { id: 'commons', run: function () { return sourceCommons(tq); } },
            { id: 'dbpedia', run: function () { return sourceDbpedia(tq); } },
            { id: 'archive', run: function () { return sourceArchive(tq); } },
            { id: 'europeana', run: function () { return sourceEuropeana(tq, key); } },
            /* ARIADNE gets BOTH spellings: what the user typed (its results page
             * needs a repaired query) and the gazetteer-corrected one. */
            { id: 'ariadne', run: function () { return localityFix.then(function (loc) { return sourceAriadne(query, tq, loc); }); } },
            { id: 'cimec', run: function () { return localityFix.then(function (loc) { return sourceCimec(tq, loc); }); } }
        ];
        var tasks = runners.map(function (r) {
            var pending;
            try { pending = r.run(); } catch (e) { pending = Promise.reject(e); }
            return pending.then(function (out) {
                var st = {
                    id: r.id, status: out.results && out.results.length ? 'ok' : 'empty',
                    count: out.results ? out.results.length : 0, ms: Date.now() - t0,
                    partial: !!out.partial, message: ''
                };
                if (seq === searchSeq && onSource) onSource(st);
                return { source: st, results: out.results || [], extra: out };
            }, function (e) {
                var kind = (e && e.code === 'nokey') ? 'nokey' : classifyError(e);
                var st = {
                    id: r.id, status: kind, count: 0, ms: Date.now() - t0,
                    message: (e && e.message) || '', invalidKey: !!(e && e.code === 'invalid_apikey') || !!(e && e.data && e.data.code === 'invalid_apikey')
                };
                if (seq === searchSeq && onSource) onSource(st);
                return { source: st, results: [], extra: {} };
            });
        });
        return Promise.all(tasks).then(function (outs) {
            return { perSource: outs, durationMs: Date.now() - t0 };
        });
    }

    /* Merge findings across sources by normalised title, attach automatic
     * period tags and a cross-source relevance score. */
    function detectPeriods(r) {
        var text = stripDiacritics((r.title || '') + ' ' + (r.description || '') + ' ' + (r.meta ? JSON.stringify(r.meta) : '')).toLowerCase();
        var ids = [];
        PERIOD_RULES.forEach(function (rule) { if (rule.re.test(text)) ids.push(rule.id); });
        return ids;
    }
    /* Relevance context: the locality names (typed / canonical / gazetteer)
     * and the confirmed coordinates. The filter only arms itself when the
     * gazetteer (OSM.geojson or Nominatim) actually confirmed the locality —
     * a historical site name that OSM does not know is left unfiltered. */
    function buildRelevanceCtx(query, canonical, locality, perSource) {
        var names = [];
        [phraseName(query), canonical ? phraseName(canonical) : null, locality ? locality.name : null].forEach(function (n) {
            var k = normKey(n || '');
            if (k && k.length >= 3 && names.indexOf(k) === -1) names.push(k);
        });
        var coords = (locality && isFinite(locality.lat) && isFinite(locality.lon))
            ? { lat: locality.lat, lng: locality.lon } : null;
        var confirmed = !!locality;
        if (!confirmed && perSource) {
            var osmOut = (perSource.filter(function (o) { return o.source.id === 'osm'; })[0] || {});
            ((osmOut.results) || []).forEach(function (r) {
                if (confirmed) return;
                if (names.indexOf(normKey(r.title || '')) !== -1) {
                    confirmed = true;
                    if (!coords && r.coords && isFinite(r.coords.lat)) coords = r.coords;
                }
            });
        }
        return { names: names, coords: coords, active: confirmed && names.length > 0 };
    }
    function isRelevant(r, ctx) {
        /* the gazetteer and the RAN spatial search are locality-driven by construction */
        if ((r.sources || []).some(function (s) { return s.id === 'osm' || s.id === 'cimec'; })) return true;
        var text = normKey((r.title || '') + ' ' + (r.description || ''));
        for (var i = 0; i < ctx.names.length; i++) {
            if (text.indexOf(ctx.names[i]) !== -1) return true;
        }
        if (r.coords && ctx.coords && distKm(r.coords, ctx.coords) <= RELEVANCE_RADIUS_KM) return true;
        return false;
    }

    function aggregate(outs, durationMs, ctx) {
        var map = {}, order = [], totalBefore = 0;
        outs.forEach(function (out) {
            (out.results || []).forEach(function (item, rank) {
                var key = normKey(item.title);
                if (!key) return;
                totalBefore++;
                var ex = map[key];
                if (!ex) {
                    ex = item;
                    ex.sources = [{ id: item.source, url: item.url, lang: item.lang || null }];
                    ex.rank = rank; ex.periods = [];
                    map[key] = ex; order.push(ex);
                } else {
                    if (!ex.sources.some(function (s) { return s.id === item.source; })) {
                        ex.sources.push({ id: item.source, url: item.url, lang: item.lang || null });
                    }
                    if (!ex.description && item.description) ex.description = item.description;
                    if (!ex.image && item.image) ex.image = item.image;
                    if (!ex.coords && item.coords) ex.coords = item.coords;
                    if (!ex.year && item.year) ex.year = item.year;
                    if ((TYPE_PRIORITY[item.type] || 0) > (TYPE_PRIORITY[ex.type] || 0)) {
                        ex.type = item.type; ex.typeKey = item.typeKey || null; ex.url = item.url; ex.title = item.title;
                    }
                    ex.rank = Math.min(ex.rank, rank);
                }
            });
        });
        order.forEach(function (r) {
            r.periods = detectPeriods(r);
            r.description = clampDesc(r.description || '');
            r.score = r.sources.length * 100 + Math.max(0, 60 - r.rank * 5) + (r.image ? 4 : 0) + (r.coords ? 4 : 0);
        });
        /* Fuzzy-noise guard: once the gazetteer confirmed the locality, a
         * finding must actually mention it (or sit within RELEVANCE_RADIUS_KM
         * of it) — "Miljan Miljanić" has no business among "Miluani, Sălaj". */
        var totalDeduped = order.length;
        var irrelevantRemoved = 0;
        if (ctx && ctx.active) {
            var kept = order.filter(function (r) { return isRelevant(r, ctx); });
            irrelevantRemoved = order.length - kept.length;
            order = kept;
        }
        /* Findings with no period at all (perioada "nespecificată") are dropped:
         * the Library of Babel only surfaces results the automatic classifier can
         * place on the archaeological timeline. Two locality-driven exceptions:
         * OSM places (the searched locality itself) and CIMEC/RAN site records
         * (archaeological by definition) always stay. */
        order = order.filter(function (r) {
            if (r.type === 'place') return true;
            /* archaeological catalogues (RAN, ARIADNE) are archaeological by
             * definition — their records must not vanish just because the
             * metadata carries no explicit period name */
            if ((r.sources || []).some(function (s) { return s.id === 'cimec' || s.id === 'ariadne'; })) return true;
            return r.periods.length > 0;
        });
        order.sort(function (a, b) { return b.score - a.score; });
        return { results: order, totalBeforeDedup: totalBefore, totalDeduped: totalDeduped, irrelevantRemoved: irrelevantRemoved, durationMs: durationMs };
    }

    function buildStats(query, perSource, agg, locality) {
        var sources = SOURCE_ORDER.map(function (id) {
            var out = perSource.filter(function (o) { return o.source.id === id; })[0];
            return out ? out.source : { id: id, status: 'error', count: 0, message: 'not run' };
        });
        return {
            query: query, generatedAt: new Date().toISOString(),
            durationMs: agg.durationMs,
            total: agg.results.length,
            totalBeforeDedup: agg.totalBeforeDedup,
            duplicatesRemoved: agg.totalBeforeDedup - agg.totalDeduped,
            irrelevantRemoved: agg.irrelevantRemoved || 0,
            locality: locality || null,
            active: sources.filter(function (s) { return s.status === 'ok' || s.status === 'empty'; }).length,
            sources: sources,
            osmMatches: (perSource.filter(function (o) { return o.source.id === 'osm'; })[0] || { extra: {} }).extra.osmMatches || []
        };
    }

    /* ── local result cache (localStorage, TTL) ── */
    function cacheKey(q, lg) { return 'babel.cache.v1.' + lg + '.' + slug(q); }
    function cacheGet(q, lg) {
        try {
            if (typeof localStorage === 'undefined') return null;
            var raw = localStorage.getItem(cacheKey(q, lg));
            if (!raw) return null;
            var v = JSON.parse(raw);
            if (!v || !v.ts || (Date.now() - v.ts) > CACHE_TTL) return null;
            return v;
        } catch (_) { return null; }
    }
    function cacheSet(q, lg, data) {
        try {
            if (typeof localStorage === 'undefined') return;
            localStorage.setItem(cacheKey(q, lg), JSON.stringify({ ts: Date.now(), data: data }));
        } catch (_) { /* quota / private mode */ }
    }

    /* ════════════════════════ rendering ════════════════════════ */

    function destroyMap() { if (mapRef) { try { mapRef.remove(); } catch (_) { } mapRef = null; } }

    function renderSearching() {
        runState = 'searching';
        var chips = SOURCE_ORDER.map(function (id) { return sourceChipHtml(sourceStatuses[id] || { id: id, status: 'pending' }); }).join('');
        document.getElementById('babelBody').innerHTML =
            '<div class="babel-state is-loading"><span class="babel-orbit"></span><p>' + esc(t('searching')) + '</p></div>' +
            '<div class="babel-chip-label">' + esc(t('perSourceTitle')) + '</div>' +
            '<div class="babel-chips" id="babelChips">' + chips + '</div>';
    }

    function statusClass(status) {
        if (status === 'ok') return 'is-ok';
        if (status === 'empty') return 'is-empty';
        if (status === 'nokey') return 'is-nokey';
        if (status === 'pending') return 'is-pending';
        return 'is-err';
    }
    function chipNote(st) {
        if (st.status === 'pending') return '…';
        if (st.status === 'ok') return st.partial ? t('srcPartial') : t('srcOk');
        if (st.status === 'empty') return t('srcEmpty');
        if (st.status === 'nokey') return t('srcNokey');
        if (st.status === 'timeout') return t('srcTimeout');
        if (st.status === 'http') return t('srcHttp');
        if (st.status === 'network') return t('srcNetwork');
        return t('srcError');
    }
    function chipInner(st) {
        var count = st.status === 'ok' ? '<b>' + st.count + '</b>' : '';
        return esc(t('src_' + st.id)) + ' ' + count + (statusClass(st.status) === 'is-err' ? '<i>✕</i>' : '') + '<small>' + esc(chipNote(st)) + '</small>';
    }
    function sourceChipHtml(st, asButton) {
        var open = asButton ? '<button type="button" class="babel-chip ' + statusClass(st.status) + (asButton.active ? ' is-active' : '') + '" data-source="' + esc(st.id) + '" title="' + esc(chipNote(st)) + '">'
            : '<span class="babel-chip ' + statusClass(st.status) + '" id="babel-src-' + esc(st.id) + '" data-source="' + esc(st.id) + '" title="' + esc(chipNote(st)) + '">';
        var close = asButton ? '</button>' : '</span>';
        return open + chipInner(st) + close;
    }

    function chipUpdate(st) {
        sourceStatuses[st.id] = st;
        var el = document.getElementById('babel-src-' + st.id);
        if (el) {
            el.className = 'babel-chip ' + statusClass(st.status);
            el.title = chipNote(st);
            el.innerHTML = chipInner(st);
        }
    }

    function renderForm(prefill) {
        runState = 'form';
        destroyMap();
        document.getElementById('babelBody').innerHTML =
            '<div class="babel-intro"><span class="babel-intro-seal">8×</span><div>' +
            '<h2>' + esc(t('title')) + '</h2><p>' + esc(t('intro')) + '</p>' +
            '<p class="babel-policy">' + esc(t('sourcesPolicy')) + '</p></div></div>' +
            '<form id="babelForm" class="babel-searchbar">' +
            '<label><span class="vh">' + esc(t('locality')) + '</span>' +
            '<input id="babelQuery" required maxlength="120" autocomplete="off" placeholder="' + esc(t('placeholder')) + '" value="' + esc(prefill != null ? prefill : formValues.query) + '"></label>' +
            '<button type="submit">' + esc(t('run')) + '</button></form>' +
            '<details class="babel-keypanel"><summary>' + esc(t('keyTitle')) + '</summary>' +
            '<p>' + esc(t('keyHelp')) + '</p>' +
            '<div class="babel-keyrow"><input id="babelKey" maxlength="80" autocomplete="off" placeholder="' + esc(t('keyPlaceholder')) + '" value="' + esc(europeanaKey()) + '">' +
            '<button type="button" id="babelKeySave">' + esc(t('keySave')) + '</button></div>' +
            '<p class="babel-keynote" id="babelKeyNote" hidden></p></details>';
        var f = document.getElementById('babelForm');
        f.onsubmit = function (e) { e.preventDefault(); run(document.getElementById('babelQuery').value); };
        var qi = document.getElementById('babelQuery');
        if (qi && typeof qi.focus === 'function') qi.focus();
        var saveBtn = document.getElementById('babelKeySave');
        saveBtn.onclick = function () {
            saveEuropeanaKey(document.getElementById('babelKey').value);
            var n = document.getElementById('babelKeyNote');
            n.hidden = false; n.textContent = t('keySaved');
        };
    }

    /* Filtered view of the aggregated results (type + period + source). */
    function filteredResults() {
        return (lastAgg || []).filter(function (r) {
            if (uiFilters.type !== 'all' && r.type !== uiFilters.type) return false;
            if (uiFilters.period === 'unspecified') { if (r.periods.length) return false; }
            else if (uiFilters.period !== 'all' && r.periods.indexOf(uiFilters.period) === -1) return false;
            if (uiFilters.source !== 'all' && !r.sources.some(function (s) { return s.id === uiFilters.source; })) return false;
            return true;
        });
    }

    function resultHtml(r) {
        var typeLabel = r.typeKey ? t(r.typeKey) : t('type_' + r.type);
        var badges = (r.sources || []).map(function (s) {
            var url = safeUrl(s.url || '');
            var lab = t('src_' + s.id) + (s.lang ? ' (' + s.lang.toUpperCase() + ')' : '');
            return url !== '#' ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(lab) + '</a>' : '<span>' + esc(lab) + '</span>';
        }).join('');
        var meta = [];
        if (r.year) meta.push(esc(t('year')) + ': ' + esc(r.year));
        if (r.coords) meta.push(esc(r.coords.lat.toFixed(4)) + ', ' + esc(r.coords.lng.toFixed(4)));
        if (r.meta && r.meta.license) meta.push(esc(r.meta.license));
        if (r.meta && r.meta.artist) meta.push(esc(r.meta.artist));
        if (r.meta && r.meta.provider) meta.push(esc(r.meta.provider));
        if (r.meta && r.meta.mediatype) meta.push(esc(r.meta.mediatype));
        return '<article class="babel-result" data-source="' + esc((r.sources[0] || {}).id || '') + '">' +
            (r.image && safeUrl(r.image) !== '#' ? '<img src="' + esc(safeUrl(r.image)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') +
            '<div class="babel-result-main">' +
            '<div class="babel-result-top"><span class="babel-result-type t-' + esc(r.type) + '">' + esc(typeLabel) + '</span>' +
            '<span class="babel-result-sources">' + badges + (r.sources && r.sources.length > 1 ? '<em>' + r.sources.length + ' ' + esc(t('sourcesCount')) + '</em>' : '') + '</span></div>' +
            '<h3><a href="' + esc(safeUrl(r.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(r.title) + '</a></h3>' +
            (r.description ? '<p>' + esc(r.description) + '</p>' : '') +
            (r.periods && r.periods.length ? '<div class="babel-periods">' + r.periods.map(function (p) { return '<span>' + esc(t('p_' + p)) + '</span>'; }).join('') + '</div>' : '') +
            (meta.length ? '<div class="babel-result-meta">' + meta.join(' · ') + '</div>' : '') +
            '</div></article>';
    }

    function renderResults() {
        runState = 'results';
        destroyMap();
        var s = lastStats, q = lastQuery;
        var active = s.active, total = s.total;
        var failed = s.sources.filter(function (x) { return x.status === 'timeout' || x.status === 'http' || x.status === 'network' || x.status === 'error'; });
        var invalidKey = s.sources.some(function (x) { return x.id === 'europeana' && x.invalidKey; });
        var visible = filteredResults();
        var hasCoords = (lastAgg || []).some(function (r) { return r.coords; });
        var mapAvailable = typeof window.L !== 'undefined' && typeof window.L.map === 'function';

        /* head + stats */
        var loc = s.locality;
        var locLine = loc ? '<p class="babel-locality">📍 <b>' + esc(loc.name) + '</b>' +
            (loc.judet ? ' · ' + esc(t('countyAbbr')) + ' ' + esc(loc.judet) : '') +
            (isFinite(loc.lat) && isFinite(loc.lon) ? ' · ' + esc(Number(loc.lat).toFixed(4)) + ', ' + esc(Number(loc.lon).toFixed(4)) : '') +
            ' <small>(' + esc(t('localityVia')) + ')</small></p>' : '';

        /* ── Epoch profile of the locality (header summary with percentages) ──
           Every finding already carries its automatically classified periods
           (`r.periods`), so the header summarises the de-duplicated corpus as
           the SHARE of each epoch — a locality then reads at a glance as
           Roman, medieval or prehistoric. A finding may mention several epochs
           (a Dacian site reoccupied in Roman times belongs to both), so the
           denominator is the total number of epoch attributions, not the
           number of cards: the printed percentages always add up to 100 %.
           Findings with no period at all are only the OSM/RAN exceptions and
           never enter the 100 %. Each share is a button that filters the list
           by that epoch — exactly like the timeline strip below. */
        var counts = {}, classified = 0, tags = 0;
        (lastAgg || []).forEach(function (r) {
            r.periods.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; });
            tags += r.periods.length;
            if (r.periods.length) classified += 1; else counts.unspecified = (counts.unspecified || 0) + 1;
        });
        var epochLine = '';
        if (classified > 0 && tags > 0) {
            var shares = [];
            PERIOD_ORDER.forEach(function (p) {
                if (!counts[p]) return;
                var exact = counts[p] / tags * 100;
                shares.push({ period: p, count: counts[p], pct: Math.floor(exact), frac: exact - Math.floor(exact) });
            });
            var used = shares.reduce(function (a, x) { return a + x.pct; }, 0);
            shares.slice().sort(function (a, b) { return b.frac - a.frac; })
                .slice(0, Math.max(0, 100 - used))
                .forEach(function (x) { x.pct += 1; });
            epochLine = '<div class="babel-epochs"><span class="babel-epochs-label">' + esc(t('epochProfile')) +
                ' <small>(' + esc(t('epochProfileNote')) + ')</small></span><div class="babel-epochs-strip">' +
                shares.map(function (x) {
                    return '<button type="button" data-period="' + x.period + '"' +
                        (uiFilters.period === x.period ? ' class="is-active"' : '') +
                        ' style="--babel-share:' + x.pct + '%"' +
                        ' title="' + esc(t('p_' + x.period)) + ' · ' + x.count + ' ' + esc(t('results')) + '">' +
                        '<span>' + esc(t('p_' + x.period)) + '</span><b>' + x.pct + '%</b></button>';
                }).join('') + '</div></div>';
        }

        var html =
            '<header class="babel-results-head"><div><span>DETECTLAB · MULTI-SOURCE SEARCH</span>' +
            '<h2>„' + esc(q) + '”</h2>' + locLine +
            '<p><b>' + total + '</b> ' + esc(t('results')) + ' · <b>' + active + '/' + SOURCE_ORDER.length + '</b> ' + esc(t('activeSources')) +
            (s.duplicatesRemoved > 0 ? ' · <b>' + s.duplicatesRemoved + '</b> ' + esc(t('duplicates')) : '') +
            (s.irrelevantRemoved > 0 ? ' · <b>' + s.irrelevantRemoved + '</b> ' + esc(t('irrelevant')) : '') +
            ' · ' + (s.durationMs / 1000).toFixed(1) + ' ' + esc(t('seconds')) + '</p>' + epochLine + '</div>' +
            '<button type="button" id="babelNew">' + esc(t('newSearch')) + '</button></header>';

        /* live per-source chips (clickable → filter by source) */
        html += '<div class="babel-chip-label">' + esc(t('perSourceTitle')) + '</div>' +
            '<div class="babel-chips" id="babelChips">' + s.sources.map(function (st) {
            return sourceChipHtml(st, { active: uiFilters.source === st.id });
        }).join('') + '</div>';

        if (cachedAt) html += '<p class="babel-cachenote">' + esc(t('cachedFrom')) + ' · ' + esc(new Date(cachedAt).toLocaleString()) + ' <button type="button" id="babelRefresh">' + esc(t('refresh')) + '</button></p>';
        if (failed.length) {
            html += '<p class="babel-partial">' + esc(t('partialNote')) + ' ' + failed.map(function (f) {
                return '<span>' + esc(t('src_' + f.id)) + ' (' + esc(t('src' + f.status.charAt(0).toUpperCase() + f.status.slice(1)) || f.status) + ')</span>';
            }).join('') + '</p>';
        }
        if (invalidKey) html += '<p class="babel-partial">' + esc(t('keyInvalid')) + '</p>';

        /* ambiguity: several OSM matches → refine buttons (spec §EDGE CASES) */
        if (s.osmMatches && s.osmMatches.length > 1) {
            html += '<div class="babel-ambiguous"><b>⚠ ' + esc(t('ambiguousTitle')) + '</b><p>' + esc(t('ambiguousHelp')) + '</p><div class="babel-ambiguous-list">' +
                s.osmMatches.map(function (m) {
                    var where = String(m.display || '').split(',').slice(1, 3).join(',').trim();
                    return '<button type="button" class="babel-pick" data-query="' + esc(m.name) + '"><strong>' + esc(m.name) + '</strong><span>' + esc([m.type, where].filter(Boolean).join(' · ')) + '</span></button>';
                }).join('') + '</div></div>';
        }

        /* zero results → suggested alternative searches (spec §EDGE CASES) */
        if (total === 0) {
            var variants = [stripDiacritics(q), q.split(/[\s,]+/)[0], q + ' arheologic', q + ' archaeological'].filter(function (v, i, a) { return v && v.length > 2 && a.indexOf(v) === i; });
            html += '<div class="babel-empty"><p>' + esc(t('noResults')) + ' „' + esc(q) + '”.</p><p>' + esc(t('noResultsHelp')) + '</p>' +
                '<div class="babel-suggest"><b>' + esc(t('suggestions')) + ':</b> ' + variants.map(function (v) { return '<button type="button" class="babel-pick" data-query="' + esc(v) + '">' + esc(v) + '</button>'; }).join('') + '</div></div>';
        } else {
            /* timeline of periods (automatic classification, clickable filter) —
               absolute counts, while the header shows the same corpus as % */
            var tl = PERIOD_ORDER.filter(function (p) { return counts[p]; }).map(function (p) {
                return '<button type="button" data-period="' + p + '"' + (uiFilters.period === p ? ' class="is-active"' : '') + '><span>' + esc(t('p_' + p)) + '</span><b>' + counts[p] + '</b></button>';
            }).join('');
            if (counts.unspecified) tl += '<button type="button" data-period="unspecified"' + (uiFilters.period === 'unspecified' ? ' class="is-active"' : '') + '><span>' + esc(t('p_unspecified')) + '</span><b>' + counts.unspecified + '</b></button>';
            if (tl) html += '<div class="babel-timeline"><span class="babel-timeline-label">' + esc(t('timeline')) + ' <small>(' + esc(t('timelineNote')) + ')</small></span><div class="babel-timeline-strip">' + tl + '</div></div>';

            /* mini map with every geolocated finding */
            if (hasCoords && mapAvailable) html += '<div class="babel-mapwrap"><span class="babel-maplabel">' + esc(t('mapView')) + '</span><div class="babel-map" id="babelMap"></div></div>';

            /* filters */
            var types = TYPE_ORDER.filter(function (ty) { return (lastAgg || []).some(function (r) { return r.type === ty; }); });
            html += '<div class="babel-toolbar">' +
                '<label><span>' + esc(t('type')) + '</span><select id="babelTypeFilter"><option value="all">' + esc(t('all')) + '</option>' +
                types.map(function (ty) { return '<option value="' + ty + '"' + (uiFilters.type === ty ? ' selected' : '') + '>' + esc(t('type_' + ty)) + '</option>'; }).join('') + '</select></label>' +
                '<label><span>' + esc(t('period')) + '</span><select id="babelPeriodFilter"><option value="all">' + esc(t('all')) + '</option>' +
                PERIOD_ORDER.filter(function (p) { return counts[p]; }).map(function (p) { return '<option value="' + p + '"' + (uiFilters.period === p ? ' selected' : '') + '>' + esc(t('p_' + p)) + '</option>'; }).join('') +
                (counts.unspecified ? '<option value="unspecified"' + (uiFilters.period === 'unspecified' ? ' selected' : '') + '>' + esc(t('p_unspecified')) + '</option>' : '') +
                '</select></label>' +
                '<span class="babel-showing">' + esc(t('shown')) + ': ' + visible.length + ' ' + esc(t('of')) + ' ' + total + '</span></div>';

            /* the results themselves */
            html += '<div class="babel-results">' + (visible.length ? visible.map(resultHtml).join('') : '<div class="babel-empty">0 ' + esc(t('results')) + '</div>') + '</div>';
        }

        /* exports + provenance note */
        html += '<div class="babel-exportbar"><span class="babel-period-note">' + esc(t('periodNote')) + '</span>' +
            '<button type="button" id="babelExportJson">↓ ' + esc(t('exportJson')) + '</button>' +
            '<button type="button" id="babelExportCsv">↓ ' + esc(t('exportCsv')) + '</button></div>' +
            '<p class="babel-footer-meta">' + esc(t('generated')) + ': ' + esc(s.generatedAt) + '</p>';

        document.getElementById('babelBody').innerHTML = html;
        wireResults();
        if (hasCoords && mapAvailable) mountMap();
    }

    function wireResults() {
        var el;
        el = document.getElementById('babelNew'); if (el) el.onclick = function () { cachedAt = null; renderForm(lastQuery); };
        el = document.getElementById('babelRefresh'); if (el) el.onclick = function () { run(lastQuery, { bypassCache: true }); };
        el = document.getElementById('babelExportJson'); if (el) el.onclick = function () { download(slug(lastQuery) + '.json', buildJsonExport(), 'application/json;charset=utf-8'); };
        el = document.getElementById('babelExportCsv'); if (el) el.onclick = function () { download(slug(lastQuery) + '.csv', buildCsvExport(), 'text/csv;charset=utf-8'); };
        Array.prototype.forEach.call(document.querySelectorAll('.babel-pick'), function (btn) {
            btn.onclick = function () { run(btn.getAttribute('data-query'), { bypassCache: true }); };
        });
        Array.prototype.forEach.call(document.querySelectorAll('#babelChips .babel-chip'), function (btn) {
            btn.onclick = function () {
                var id = btn.getAttribute('data-source');
                uiFilters.source = (uiFilters.source === id) ? 'all' : id;
                renderResults();
            };
        });
        /* both the header epoch percentages and the timeline strip filter by period */
        Array.prototype.forEach.call(document.querySelectorAll('.babel-timeline-strip button, .babel-epochs button'), function (btn) {
            btn.onclick = function () {
                var p = btn.getAttribute('data-period');
                uiFilters.period = (uiFilters.period === p) ? 'all' : p;
                renderResults();
            };
        });
        var tf = document.getElementById('babelTypeFilter');
        if (tf) tf.onchange = function () { uiFilters.type = tf.value; renderResults(); };
        var pf = document.getElementById('babelPeriodFilter');
        if (pf) pf.onchange = function () { uiFilters.period = pf.value; renderResults(); };
    }

    /* Leaflet mini-map with every geolocated finding (extension idea). */
    function mountMap() {
        var host = document.getElementById('babelMap');
        if (!host) return;
        var pts = (lastAgg || []).filter(function (r) { return r.coords; }).slice(0, 60);
        if (!pts.length) return;
        try {
            var map = window.L.map(host, { scrollWheelZoom: false, zoomControl: true });
            window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
            var latlngs = [];
            pts.forEach(function (r) {
                var ll = [r.coords.lat, r.coords.lng];
                latlngs.push(ll);
                window.L.circleMarker(ll, { radius: 7, color: '#d3a35d', weight: 2, fillColor: '#8a5a20', fillOpacity: 0.85 })
                    .addTo(map).bindPopup('<b>' + esc(r.title) + '</b><br><small>' + esc((r.sources || []).map(function (s) { return t('src_' + s.id); }).join(' · ')) + '</small>');
            });
            map.fitBounds(latlngs, { padding: [18, 18], maxZoom: 13 });
            setTimeout(function () { try { map.invalidateSize(); } catch (_) { } }, 80);
            mapRef = map;
        } catch (_) { /* leaflet missing or container hidden */ }
    }

    /* ── exports (JSON / CSV) over the CURRENTLY FILTERED results ── */
    function exportRows() {
        return filteredResults().map(function (r) {
            return {
                titlu: r.title,
                descriere: r.description,
                tip: r.typeKey ? t(r.typeKey) : t('type_' + r.type),
                sursa: (r.sources || []).map(function (s) { return t('src_' + s.id) + (s.lang ? ' (' + s.lang + ')' : ''); }).join(' + '),
                perioade: (r.periods || []).map(function (p) { return t('p_' + p); }).join(', '),
                an: r.year || '',
                coordonate: r.coords ? (r.coords.lat + ', ' + r.coords.lng) : '',
                url: r.url
            };
        });
    }
    function buildJsonExport() {
        return JSON.stringify({
            query: lastQuery, language: lang(), generatedAt: lastStats && lastStats.generatedAt,
            locality: (lastStats && lastStats.locality) || null,
            stats: {
                total: lastStats.total, activeSources: lastStats.active + '/' + SOURCE_ORDER.length,
                duplicatesRemoved: lastStats.duplicatesRemoved,
                irrelevantRemoved: lastStats.irrelevantRemoved || 0,
                durationMs: lastStats.durationMs,
                sources: lastStats.sources.map(function (s) { return { source: s.id, status: s.status, results: s.count }; })
            },
            results: exportRows()
        }, null, 2);
    }
    function buildCsvExport() {
        var rows = exportRows();
        var cols = ['titlu', 'descriere', 'tip', 'sursa', 'perioade', 'an', 'coordonate', 'url'];
        var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
        return '\uFEFF' + [cols.join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(','); })).join('\r\n');
    }

    function download(name, content, mime) {
        var u = URL.createObjectURL(new Blob([content], { type: mime }));
        var a = document.createElement('a');
        a.href = u; a.download = 'detectlab-babel-' + name; a.click();
        setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    }

    /* ════════════════════════ flow control ════════════════════════ */

    /* every source down, or an unexpected crash → named error + retry */
    function renderError() {
        runState = 'error';
        destroyMap();
        var allFailed = lastError && lastError.allFailed;
        document.getElementById('babelBody').innerHTML =
            '<div class="babel-state"><p>' + esc(allFailed ? t('allSourcesFailed') : t('failed')) + '</p>' +
            (!allFailed && lastError && lastError.message ? '<small>' + esc(lastError.message) + '</small>' : '') +
            '<button type="button" class="babel-retry" id="babelRetry">' + esc(t('retry')) + '</button>' +
            '<button type="button" class="babel-retry secondary" id="babelRetryForm">' + esc(t('newSearch')) + '</button></div>';
        var rb = document.getElementById('babelRetry');
        if (rb) rb.onclick = function () { run(lastError && lastError.query || lastQuery, { bypassCache: true }); };
        var rf = document.getElementById('babelRetryForm');
        if (rf) rf.onclick = function () { renderForm(lastQuery || ''); };
    }

    async function run(query, opts) {
        query = String(query || '').trim();
        if (!query || running) return;
        opts = opts || {};
        formValues.query = query;
        uiFilters = { type: 'all', period: 'all', source: 'all' };
        cachedAt = null;
        lastError = null;
        var lg = lang(), seq = ++searchSeq;
        running = true; updateButton(); open();

        /* cache hit? (30 min TTL, bypass with opts.bypassCache) */
        if (!opts.bypassCache) {
            var hit = cacheGet(query, lg);
            if (hit) {
                lastQuery = query; lastAgg = hit.data.agg; lastStats = hit.data.stats; cachedAt = hit.ts;
                running = false; updateButton(); renderResults(); return;
            }
        }

        sourceStatuses = {};
        SOURCE_ORDER.forEach(function (id) { sourceStatuses[id] = { id: id, status: 'pending' }; });
        renderSearching();
        try {
            /* OSM gazetteer first: canonical name + county + coordinates */
            var locality = await resolveLocality(query);
            if (seq !== searchSeq) return; /* superseded by a newer search */
            var canonical = (locality && locality.name && normKey(locality.name) !== normKey(query)) ? locality.name : null;
            var out = await searchAll(query, lg, europeanaKey(), seq, chipUpdate, canonical, locality);
            if (seq !== searchSeq) return; /* superseded by a newer search */
            var relCtx = buildRelevanceCtx(query, canonical, locality, out.perSource);
            var agg = aggregate(out.perSource, out.durationMs, relCtx);
            var stats = buildStats(query, out.perSource, agg, locality);
            stats.canonicalQuery = canonical || null;
            lastQuery = query; lastAgg = agg.results; lastStats = stats;

            if (stats.active === 0) {
                /* every source failed — say it plainly and offer a retry */
                lastError = { allFailed: true, query: query };
                renderError();
                return;
            }
            cacheSet(query, lg, { agg: agg.results, stats: stats });
            renderResults();
        } catch (e) {
            if (seq !== searchSeq) return;
            lastError = { message: (e && e.message) || '', query: query };
            renderError();
        } finally {
            if (seq === searchSeq) { running = false; updateButton(); }
        }
    }

    function begin() {
        if (running) return;
        if (!isPremium()) { if (typeof window.openPremiumModal === 'function') window.openPremiumModal(); return; }
        open();
        renderForm(lastQuery || formValues.query);
    }

    function apply() {
        var title = document.getElementById('babelModalTitle'), sub = document.getElementById('babelScrollSubtitle'), closeBtn = document.getElementById('babelClose'), scrollTitle = document.getElementById('babelScrollTitle');
        if (title) title.textContent = t('title');
        if (scrollTitle) scrollTitle.textContent = t('title');
        if (sub) sub.textContent = t('subtitle');
        if (closeBtn) closeBtn.setAttribute('aria-label', t('close'));
        var m = document.getElementById('babelModal');
        if (m && !m.hidden) {
            if (runState === 'error') renderError();
            else if (runState === 'results' && lastStats) renderResults();
            else if (runState === 'searching') renderSearching();
            else renderForm(lastQuery || formValues.query);
        }
        updateButton();
    }

    function init() {
        var b = document.getElementById('babelSearchBtn'), x = document.getElementById('babelClose'), m = document.getElementById('babelModal');
        if (!b || !m) return;
        b.onclick = begin; x.onclick = close; m.onclick = function (e) { if (e.target === m) close(); };
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !m.hidden) close(); });
        var old = window.setLang; if (typeof old === 'function') window.setLang = function (v) { old(v); apply(); };
        apply();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

    /* Public surface — research() drives the tests; _noThrottle() speeds them up. */
    window.DetectLabEvidenceEngine = {
        open: begin, close: close, research: run,
        _noThrottle: function () { NOMINATIM_MIN_INTERVAL = 0; },
        _resolveCanonicalQuery: resolveCanonicalQuery,
        _resolveLocality: resolveLocality,
        /* ARIADNE query repair — exposed so the regression test can pin the
         * exact repaired spellings for the "Moldovenesti" class of searches. */
        _ariadne: {
            queries: ariadneQueries,
            stemQuery: ariadneStemQuery,
            wordStem: ariadneWordStem,
            source: sourceAriadne,
            toResult: ariadneResult,
            mentions: ariadneMentions
        },
        _export: { json: buildJsonExport, csv: buildCsvExport, rows: exportRows },
        _filters: function () { return uiFilters; }
    };
})();
