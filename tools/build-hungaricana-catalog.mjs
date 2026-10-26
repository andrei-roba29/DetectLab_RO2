#!/usr/bin/env node
/* =====================================================================
 * tools/build-hungaricana-catalog.mjs
 * ---------------------------------------------------------------------
 * Rebuilds data/other-maps-catalog.json — the catalogue behind the
 * “Alte hărți / Other maps” sub-layer — straight from maps.hungaricana.hu.
 *
 * Why a script and not a live query: the portal has no JSON API (the search
 * page ignores ?format=json) and sends no CORS headers, so the browser can
 * only ever read the finished catalogue.  Everything below is therefore done
 * once, offline, and the result is a small static file the app downloads only
 * when the sub-layer is switched on.
 *
 * What it does, for every search result page:
 *   1. reads the result cards (record id, title, Subject, provider,
 *      collection, ECW tile path from the thumbnail URL);
 *   2. pulls the place out of the record — the portal itself writes the
 *      modern name in the Subject (“Máramarossziget (Máramaros m., ma
 *      Sighetu Marmaţiei, RO)”), and that is the spelling we keep;
 *   3. turns that place into coordinates with a local gazetteer when one is
 *      given, otherwise with Nominatim (1 request/second, cached);
 *   4. merges the result into the existing catalogue: entries that are
 *      already there keep their coordinates, so an alignment nobody has
 *      touched is never silently moved.
 *
 * Usage:
 *   node tools/build-hungaricana-catalog.mjs                 # default queries
 *   node tools/build-hungaricana-catalog.mjs --query Maramaros --query Bihar
 *   node tools/build-hungaricana-catalog.mjs --all --pages 40
 *   node tools/build-hungaricana-catalog.mjs --gazetteer data/other-maps/gazetteer.json
 *   node tools/build-hungaricana-catalog.mjs --no-geocode    # metadata only
 *   node tools/build-hungaricana-catalog.mjs --out /tmp/catalog.json
 *
 * Options:
 *   --query <text>     search term (repeatable). Default: the historical
 *                      Hungarian counties that lie in today's Romania plus
 *                      the neighbour counties, so the harvest is useful for
 *                      DetectLab without downloading all 78 000 sheets.
 *   --all              one empty query, i.e. the whole portal (slow).
 *   --pages <n>        pages per query (default 5, 0 = every page)
 *   --per-page <n>     results per page (default 100, max 100)
 *   --lang <en|hu>     portal language (default en)
 *   --gazetteer <file> JSON {"name": [lat, lng]} consulted before Nominatim
 *   --geocode-cache <f> where place → coordinates are remembered
 *                      (default data/other-maps/geocode-cache.json)
 *   --out <file>       catalogue to write (default data/other-maps-catalog.json)
 *   --no-geocode       keep only records whose place is already known
 *   --delay <ms>       pause between portal requests (default 700)
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_QUERIES = [
    'Máramaros', 'Szatmár', 'Bihar', 'Szilágy', 'Kolozs', 'Maros-Torda',
    'Csík', 'Háromszék', 'Brassó', 'Fogaras', 'Szeben', 'Hunyad',
    'Krassó-Szörény', 'Temes', 'Torontál', 'Arad', 'Békés', 'Ugocsa',
    'Erdély', 'Bánság', 'Bukovina', 'Alsó-Fehér', 'Felső-Fehér',
    'Torda-Aranyos', 'Szolnok-Doboka', 'Beszterce-Naszód', 'Udvarhely',
    'Nagy-Küküllő', 'Kis-Küküllő'
];

const USER_AGENT = 'DetectLab-catalog-builder/1.0 (https://detectlab.ro; maps catalogue sync)';
const COUNTRY_CODES = 'ro,hu,ua,sk,at,rs,hr,si,pl';

/* ── arguments ───────────────────────────────────────────────────────── */
function args(name, fallback) {
    const flag = '--' + name;
    const values = [];
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === flag && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
            values.push(process.argv[i + 1]);
        }
    }
    if (!values.length) return fallback;
    return Array.isArray(fallback) ? values : values[values.length - 1];
}
const flag = (name) => process.argv.includes('--' + name);

const queries = flag('all') ? [''] : args('query', DEFAULT_QUERIES);
const pages = Number(args('pages', '5')) || 5;
const perPage = Math.min(100, Math.max(1, Number(args('per-page', '100')) || 100));
const lang = args('lang', 'en');
const delay = Number(args('delay', '700')) || 700;
const outFile = path.resolve(ROOT, args('out', 'data/other-maps-catalog.json'));
const gazetteerFile = args('gazetteer', null) ? path.resolve(ROOT, args('gazetteer', null)) : null;
const cacheFile = path.resolve(ROOT, args('geocode-cache', 'data/other-maps/geocode-cache.json'));
const geocoding = !flag('no-geocode');

/* ── helpers ─────────────────────────────────────────────────────────── */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return fallback;
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function stripTags(html) {
    return String(html || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&bull;|&middot;|&#8226;|&#183;/gi, '•')   /* breadcrumb separators */
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decode(text) {
    return stripTags(text);
}

async function getText(url, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, 'Accept-Language': lang }
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return await response.text();
        } catch (err) {
            if (attempt === retries) {
                console.error('  ! failed', url, err.message);
                return '';
            }
            await sleep(1500 * (attempt + 1));
        }
    }
    return '';
}

/* ── parsing one result card ─────────────────────────────────────────── */
/* A card links to its record more than once (heading + thumbnail), so the
 * chunks are grouped by record id and read as one block. */
const RECORD_RE = /<a[^>]+href="\/[a-z]{2}\/([A-Za-z0-9]+)\/(\d+)\/?\??/g;
const RECORD_ANY_RE = /<a[^>]+href="\/[a-z]{2}\/[A-Za-z0-9]+\/\d+\/?\??/g;
const THUMB_RE = /tile\/thumb\/([^"'<>\s]+?\.ecw)/i;
const FIELD_RE = /<t[dh][^>]*>\s*([^<]{1,40}?)\s*<\/t[dh]>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
const ANCHOR_RE = /<a[^>]+href="\/[a-z]{2}\/[A-Za-z0-9]+\/\d+\/?\??[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

function parseResults(html) {
    const stops = [];
    let stop;
    RECORD_ANY_RE.lastIndex = 0;
    while ((stop = RECORD_ANY_RE.exec(html))) stops.push(stop.index);
    if (!stops.length) return [];

    const blocks = new Map();
    const order = [];
    RECORD_RE.lastIndex = 0;
    let match;
    while ((match = RECORD_RE.exec(html))) {
        const id = match[1] + '/' + match[2];
        const start = match.index;
        const nextStop = stops.find((index) => index > start);
        const end = nextStop == null ? html.length : nextStop;
        const chunk = html.slice(start, Math.min(end, start + 8000));
        if (!blocks.has(id)) {
            blocks.set(id, []);
            order.push(id);
        }
        blocks.get(id).push(chunk);
    }

    return order.map((id) => {
        const chunk = blocks.get(id).join('\n');
        const thumb = chunk.match(THUMB_RE);
        const fields = Object.create(null);
        FIELD_RE.lastIndex = 0;
        let field;
        while ((field = FIELD_RE.exec(chunk))) {
            const key = decode(field[1]).toLowerCase();
            const value = decode(field[2]);
            if (key && value && !fields[key]) fields[key] = value;
        }

        // “7. Planum remonstrans … [S 11 - No. 647.]” — the ordinal is not
        // part of the title.
        const titleMatch = chunk.match(ANCHOR_RE);
        let title = titleMatch ? decode(titleMatch[1]) : '';
        title = title.replace(/^\s*\d+[.)]\s*/, '').trim();
        if (!title) title = fields['main title'] || fields.title || id;

        // Breadcrumb — “National Archives of Hungary • S 11 Kamarai térképek”.
        const crumbs = readCrumbs(chunk, titleMatch);
        return {
            id,
            title,
            subject: fields.subject || '',
            mainTitle: fields['main title'] || fields.title || '',
            date: fields.date || '',
            provider: crumbs[0] || '',
            collection: crumbs.slice(1).join(' · '),
            path: thumb ? thumb[1] : ''
        };
    });
}

/* The provider/collection line is a <p class="…provider…">, a <small> or just
 * the text that follows the heading; take whichever is present. */
function readCrumbs(chunk, titleMatch) {
    const candidates = [
        /<p[^>]*class="[^"]*(?:provider|source|breadcrumb)[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
        /<small[^>]*>([\s\S]*?)<\/small>/i
    ];
    for (const pattern of candidates) {
        const found = chunk.match(pattern);
        if (found) {
            const parts = stripTags(found[1]).split(/[•|]/).map((p) => p.trim()).filter(Boolean);
            if (parts.length) return parts;
        }
    }
    const after = titleMatch ? chunk.slice(titleMatch.index + titleMatch[0].length) : chunk;
    const cut = after.search(/<table|<img|<div/i);
    const text = stripTags(cut > 0 ? after.slice(0, cut) : after.slice(0, 400));
    return text.split(/[•|]/).map((p) => p.trim()).filter(Boolean);
}

/* ── the place the portal itself names ───────────────────────────────── */
/* “No. 647. Máramarossziget (Máramaros m., ma Sighetu Marmaţiei, RO)”  →
 * “Sighetu Marmaţiei”. Inside one parenthesis the last concrete “ma …”
 * (today …) hint wins — earlier ones are often the county (“ma Kolozs m.,
 * ma Cluj-Napoca, RO”) — while across several parentheses the first-named
 * sheet wins, matching the hand curation. Without any “ma” hint we fall
 * back to the middle of a county parenthesis (“Miriszlo (Alsó-Fehér m.,
 * Mirăslău, RO)”), then to the first name in the Subject. */
function extractPlace(record) {
    const subject = String(record.subject || '').replace(/\bma\s+ma\b/gi, 'ma');
    const hinted = subject.match(/\([^()]*\bma\s+[^()]*\)/gi) || [];
    if (hinted.length) {
        const hints = [];
        const re = /\bma\s+([^,()]+)/gi;
        let m;
        while ((m = re.exec(hinted[0]))) hints.push(m[1].trim());
        const concrete = hints.filter((h) => h.length > 2 && !/(\bm\.?$|megye|vármegye|része)/i.test(h));
        if (concrete.length) return concrete[concrete.length - 1];
        if (hints.length) return hints[hints.length - 1];
    }
    const bare = subject.match(/\bma\s+([^,()]{3,})/i);
    if (bare) return bare[1].trim();
    const paren = subject.match(/\(([^,()]+),\s*([^,()]+),\s*(RO|HU|UA|SK|RS|HR|AT|SI|PL)\)/i);
    if (paren && paren[2].trim().length > 2) return paren[2].trim();
    const lead = subject.replace(/^(?:[A-Za-z]+\.?\s*)?(?:Div\.[^.]*\.)?\s*(?:No\.\s*)?[\w:/.\-–]*\s*/, '');
    const name = lead.split(/[,().?!:;]/)[0].trim();
    if (name && name.length > 2 && name.length < 60) return name;
    const tail = (record.mainTitle || record.title || '').split(/[([,]/)[0].trim();
    if (!tail || tail.length <= 2 || /^(RO|HU|UA|SK|RS|HR|AT|SI|PL)$/i.test(tail)) return '';
    return tail;
}

function placeQuery(place) {
    return place
        .replace(/\b(megye|vármegye|város|község|puszta|megyei|comitatus|county|szabad|szab\.?|sz\.?|kir\.?|királyi|th?j\.?|része)\b/ig, ' ')
        .replace(/(?:^|\s)[A-Za-z]\.(?=\s|$)/g, ' ')
        .replace(/[().]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/* ── geocoding ───────────────────────────────────────────────────────── */
const gazetteer = gazetteerFile ? readJson(gazetteerFile, {}) : null;
const geocodeCache = readJson(cacheFile, {});
let geocodeCalls = 0;

function gazetteerHit(place) {
    if (!gazetteer) return null;
    const key = place.toLowerCase();
    if (gazetteer[key]) return gazetteer[key];
    const loose = Object.keys(gazetteer).find((k) => k.toLowerCase() === key);
    return loose ? gazetteer[loose] : null;
}

/* Only a settlement-level answer counts: without this filter a river or a
 * whole country (“Geoagiu” the waterway, “RO” the country) would plant a
 * dot kilometres from the sheet. Pure so the self-test can drive it. */
function acceptGeocodeHit(json) {
    if (!Array.isArray(json) || !json.length) return null;
    const first = json[0];
    const cls = String(first.class || '');
    if (cls !== 'place' && cls !== 'boundary') return null;
    if (String(first.addresstype || '') === 'country' || String(first.type || '') === 'country') return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!isFinite(lat) || !isFinite(lng)) return null;
    return { lat, lng, from: 'nominatim' };
}

async function geocode(place) {
    const key = place.trim();
    if (!key) return null;
    if (geocodeCache[key] !== undefined) return geocodeCache[key];

    const local = gazetteerHit(key);
    if (local) {
        geocodeCache[key] = { lat: local[0], lng: local[1], from: 'gazetteer' };
        return geocodeCache[key];
    }
    if (!geocoding) return null;

    // Nominatim asks for at most one request per second and a real UA.
    if (geocodeCalls) await sleep(1100);
    geocodeCalls++;
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=' +
        encodeURIComponent(COUNTRY_CODES) + '&q=' + encodeURIComponent(placeQuery(key));
    const body = await getText(url);
    let hit = null;
    try {
        hit = acceptGeocodeHit(JSON.parse(body));
    } catch (e) {
        hit = null;
    }
    geocodeCache[key] = hit;
    return hit;
}

/* ── a self-test so the card parser can be checked without the network ──
 * The markup below is what a Hungaricana result card looks like; run
 * `node tools/build-hungaricana-catalog.mjs --self-test` after changing the
 * expressions above. */
const FIXTURE = `
<h5><a href="/en/MOLTerkeptar/2146/?list=eyJxdWVyeSI6ICJNYXJhbWFyb3MifQ==">7. Planum remonstrans situationem coronalis oppidi Szigeth [S 11 - No. 647.]</a></h5>
<p class="provider">National Archives of Hungary &bull; S 11 Kamarai térképek (1747-1882) &bull; S – Térképtár</p>
<a href="/en/MOLTerkeptar/2146/?list=eyJxdWVyeSI6ICJNYXJhbWFyb3MifQ=="><img src="https://static-cdn.hungaricana.hu/tile/thumb/maps/mol/s011/s11_0647/s11_0647.ecw"></a>
<table><tbody>
<tr><th>Main title</th><td>Planum remonstrans situationem coronalis oppidi Szigeth</td></tr>
<tr><th>Subject</th><td>No. 647. Máramarossziget (Máramaros m., ma Sighetu Marmaţiei, RO)</td></tr>
<tr><th>Date</th><td>Keletkezés: 1785</td></tr>
</tbody></table>`;

if (flag('self-test')) {
    const parsed = parseResults(FIXTURE);
    if (!parsed.length) {
        console.error('✗ self-test: no card was parsed');
        process.exit(1);
    }
    const card = parsed[0];
    const expectations = [
        ['id', card.id, 'MOLTerkeptar/2146'],
        ['path', card.path, 'maps/mol/s011/s11_0647/s11_0647.ecw'],
        ['subject', card.subject, 'No. 647. Máramarossziget (Máramaros m., ma Sighetu Marmaţiei, RO)'],
        ['provider', card.provider, 'National Archives of Hungary'],
        ['place', extractPlace(card), 'Sighetu Marmaţiei']
    ];
    let failed = 0;
    expectations.forEach(([name, actual, expected]) => {
        const good = actual === expected;
        if (!good) failed++;
        console.log((good ? '  ✓ ' : '  ✗ ') + name + ': ' + JSON.stringify(actual) +
            (good ? '' : ' (expected ' + JSON.stringify(expected) + ')'));
    });
    const titleOk = /^Planum remonstrans/.test(card.title);
    console.log((titleOk ? '  ✓ ' : '  ✗ ') + 'title: ' + JSON.stringify(card.title));
    if (!titleOk) failed++;
    const check = (label, actual, expected) => {
        const good = actual === expected;
        if (!good) failed++;
        console.log((good ? '  ✓ ' : '  ✗ ') + label + ': ' + JSON.stringify(actual) +
            (good ? '' : ' (expected ' + JSON.stringify(expected) + ')'));
    };
    /* Place extraction shapes seen on the live portal (October 2026). */
    check('place / ma-ma typo',
        extractPlace({ subject: 'No. 16. A Külső-Szamos Kolozsvár (Kolozs m., ma ma Cluj-Napoca, RO) mellett' }),
        'Cluj-Napoca');
    check('place / county-then-city hints',
        extractPlace({ subject: 'No. 325. Kolozsvár (ma Kolozs m., ma Cluj-Napoca, RO) belterülete' }),
        'Cluj-Napoca');
    check('place / first sheet wins',
        extractPlace({ subject: 'No. 245/2. Felek (Szeben m., ma Avrig, RO), Nagyenyed (Alsó-Fehér m., ma Aiud, RO) között' }),
        'Avrig');
    check('place / county-paren fallback',
        extractPlace({ subject: 'No. 7:1. A Maros Miriszlo (Alsó-Fehér m., Mirăslău, RO) mellett' }),
        'Mirăslău');
    check('place / plan subject',
        extractPlace({ subject: 'No 44/3 Kolozsvár. Nyári színház' }),
        'Kolozsvár');
    check('place / bare code rejected',
        extractPlace({ subject: '', title: 'RO' }),
        '');
    check('query / noble predicates stripped', placeQuery('Kolozsvár szab. kir. város'), 'Kolozsvár');
    check('query / része stripped', placeQuery('Kolozsvár része'), 'Kolozsvár');
    check('query / county stripped', placeQuery('Kolozs vármegye'), 'Kolozs');
    check('query / initials stripped', placeQuery('B. Hunyad'), 'Hunyad');
    check('query / town predicates stripped', placeQuery('Kolozsvár t. j. sz. kir. város'), 'Kolozsvár');
    check('geocode / village accepted',
        !!acceptGeocodeHit([{ class: 'place', type: 'village', lat: '46.0', lon: '23.0' }]), true);
    check('geocode / city accepted',
        !!acceptGeocodeHit([{ class: 'place', type: 'city', lat: '46.7', lon: '23.5' }]), true);
    check('geocode / river rejected',
        acceptGeocodeHit([{ class: 'waterway', type: 'river', lat: '45.9', lon: '23.1' }]), null);
    check('geocode / country rejected',
        acceptGeocodeHit([{ class: 'boundary', type: 'country', addresstype: 'country', lat: '45.9', lon: '25.0' }]), null);
    process.exit(failed ? 1 : 0);
}

/* ── harvest ─────────────────────────────────────────────────────────── */
function searchUrl(query, page) {
    const list = Buffer.from(JSON.stringify({ query }), 'utf8').toString('base64');
    return 'https://maps.hungaricana.hu/' + lang + '/search/results/?list=' +
        encodeURIComponent(list) + '&per_page=' + perPage + '&page=' + page;
}

const collected = new Map();
let totalCards = 0;

/* Offline mode: read pages that were saved from the browser
 * (maps.hungaricana.hu sends no CORS headers, so a page saved with
 * “Save as …” is a perfectly good input). */
const htmlDir = args('html-dir', null);

if (htmlDir) {
    const dir = path.resolve(ROOT, htmlDir);
    const files = fs.readdirSync(dir).filter((f) => /\.html?$/i.test(f)).sort();
    for (const file of files) {
        const html = fs.readFileSync(path.join(dir, file), 'utf8');
        const cards = parseResults(html);
        totalCards += cards.length;
        cards.forEach((card) => { if (!collected.has(card.id)) collected.set(card.id, card); });
        console.log('  · ' + file + ': ' + cards.length + ' cards');
    }
    console.log('[hungaricana] ' + totalCards + ' result cards from ' + files.length +
        ' saved pages, ' + collected.size + ' unique records');
}

for (const query of (htmlDir ? [] : queries)) {
    const label = query || '(everything)';
    let page = 1;
    while (true) {
        const html = await getText(searchUrl(query, page));
        if (!html) break;
        const cards = parseResults(html);
        totalCards += cards.length;
        cards.forEach((card) => {
            if (!collected.has(card.id)) collected.set(card.id, card);
        });
        console.log('  · ' + label + ' page ' + page + ': ' + cards.length + ' cards');
        if (!cards.length || cards.length < perPage) break;
        if (pages && page >= pages) break;
        page++;
        await sleep(delay);
    }
    await sleep(delay);
}

console.log('[hungaricana] ' + totalCards + ' result cards, ' + collected.size + ' unique records');

/* ── merge into the catalogue ────────────────────────────────────────── */
const existing = readJson(outFile, null) || readJson(path.resolve(ROOT, 'data/other-maps-catalog.json'), null);
const previous = new Map();
(existing && existing.maps ? existing.maps : []).forEach((entry) => previous.set(entry.id, entry));

const maps = [];
let placed = 0;
let withoutPath = 0;
let unplaced = 0;

for (const card of collected.values()) {
    if (!card.path) { withoutPath++; continue; }
    const place = extractPlace(card);
    const year = (String(card.date || '').match(/(1[5-9]\d{2}|20\d{2})/) || [])[1] || null;
    const previousEntry = previous.get(card.id);
    let lat = previousEntry ? previousEntry.lat : null;
    let lng = previousEntry ? previousEntry.lng : null;
    if ((!isFinite(lat) || !isFinite(lng)) && place) {
        const hit = await geocode(place);
        if (hit) { lat = hit.lat; lng = hit.lng; }
    }
    if (!isFinite(lat) || !isFinite(lng)) { unplaced++; continue; }
    placed++;
    /* A kept position keeps its name: re-harvesting must not rename a
     * hand-placed dot (e.g. a district sheet pinned on Turda) while its
     * coordinates stay put. */
    const keepPrev = previousEntry && isFinite(previousEntry.lat) && isFinite(previousEntry.lng);
    maps.push({
        id: card.id,
        title: card.title,
        subject: card.subject,
        place: (keepPrev && previousEntry.place) || place || (previousEntry && previousEntry.place) || '',
        lat: Number(Number(lat).toFixed(5)),
        lng: Number(Number(lng).toFixed(5)),
        year: year ? Number(year) : (previousEntry ? previousEntry.year : null),
        provider: card.provider || (previousEntry && previousEntry.provider) || '',
        collection: card.collection || (previousEntry && previousEntry.collection) || '',
        path: card.path,
        precision: (keepPrev && previousEntry.precision) ||
            (/,?\s*(RO|HU|UA|SK|RS|HR|AT|SI|PL)\b/.test(card.subject || '') ? 'settlement' : 'county')
    });
}

/* Entries the query pass did not see (hand curation, other queries) survive
 * the run; pass --prune for a from-scratch rebuild instead. */
if (!flag('prune')) {
    const seenIds = new Set(maps.map((m) => m.id));
    for (const entry of previous.values()) {
        if (!seenIds.has(entry.id)) maps.push(entry);
    }
}

maps.sort((a, b) => (a.place || '').localeCompare(b.place || '') || a.id.localeCompare(b.id));

const catalogue = {
    version: 1,
    generated: new Date().toISOString().slice(0, 10),
    note: (existing && existing.note) ||
        'Catalogue of non-georeferenced sheets harvested from maps.hungaricana.hu by tools/build-hungaricana-catalog.mjs.',
    source: (existing && existing.source) || {
        name: 'Hungaricana · Maps',
        home: 'https://maps.hungaricana.hu/',
        attribution: '© Hungaricana – Kulturális Örökség Portál · conținutul aparține instituțiilor partenere.'
    },
    tileBase: 'https://static-cdn.hungaricana.hu/tile/image/',
    thumbBase: 'https://static-cdn.hungaricana.hu/tile/thumb/',
    sizeBase: 'https://static-cdn.hungaricana.hu/tile/imagesize/',
    recordBase: 'https://maps.hungaricana.hu/en/',
    maps
};

writeJson(outFile, catalogue);
writeJson(cacheFile, geocodeCache);

console.log('[hungaricana] ' + maps.length + ' sheets written to ' + path.relative(ROOT, outFile) +
    ' (' + placed + ' geocoded, ' + unplaced + ' without a place, ' + withoutPath + ' without a scan)');
if (unplaced) {
    console.log('[hungaricana] tip: add those places to the gazetteer (--gazetteer) or edit the catalogue by hand.');
}
