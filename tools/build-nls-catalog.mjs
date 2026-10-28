#!/usr/bin/env node
/* =====================================================================
 * tools/build-nls-catalog.mjs
 * ---------------------------------------------------------------------
 * Builds data/other-maps-nls-catalog.json — the National Library of
 * Scotland seed catalogue behind the “Alte hărți / Other maps”
 * sub-layer — from the same GeoServer WFS the NLS Map Finder uses
 * (https://maps.nls.uk/geo/find/, service root
 * https://geoserver.nls.uk/geoserver/wfs).
 *
 * Why a script and not a live-only query: the browser module
 * (js/other-maps-nls.js) already queries the finder live for the current
 * viewport, but a small offline catalogue gives the sub-layer stable
 * green dots (and working cards) without a round trip, exactly like the
 * Hungaricana catalogue.  The WFS itself is CORS-enabled, so live mode
 * works from any machine with network access; saved WFS responses can be
 * harvested fully offline.
 *
 * Usage:
 *   node tools/build-nls-catalog.mjs                       # live: built-in place list
 *   node tools/build-nls-catalog.mjs --place "Edinburgh" --lat 55.953 --lng -3.188
 *   node tools/build-nls-catalog.mjs --bbox -3.3,55.9,-3.1,56.0
 *   node tools/build-nls-catalog.mjs --json-dir ./wfs-dumps  # offline, saved GeoJSON
 *   node tools/build-nls-catalog.mjs --self-test
 *
 * Options:
 *   --json-dir <dir>    read saved WFS FeatureCollection JSON files instead
 *                       of querying the service (offline harvest; *.json /
 *                       *.geojson, nested directories are walked)
 *   --place <name>      repeatable; overrides the built-in place list
 *   --lat <n> / --lng <n>  coordinates for a single --place entry
 *   --bbox w,s,e,n      one bbox GetFeature (same request the live module fires)
 *   --per-place <n>     sheets kept per place (default 6, spread over years)
 *   --max-features <n>  WFS maxFeatures (default 300)
 *   --pages <n>         kept for CLI symmetry; one request covers a point
 *   --delay <ms>        pause between WFS requests (default 1000)
 *   --out <file>        catalogue to write
 *                       (default data/other-maps-nls-catalog.json)
 *   --self-test         exercise the parser without the network and exit
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const USER_AGENT = 'DetectLab-catalog-builder/1.0 (https://detectlab.ro; NLS catalogue sync)';
const DEFAULT_PER_PLACE = 6;

/* A compact gazetteer for the live harvest: the finder index covers Great
 * Britain and Ireland, so the seed follows the same box. */
const DEFAULT_PLACES = [
    { name: 'London', lat: 51.5074, lng: -0.1278 },
    { name: 'Edinburgh', lat: 55.9533, lng: -3.1883 },
    { name: 'Glasgow', lat: 55.8642, lng: -4.2518 },
    { name: 'Liverpool', lat: 53.4084, lng: -2.9916 },
    { name: 'Manchester', lat: 53.4808, lng: -2.2426 },
    { name: 'Birmingham', lat: 52.4862, lng: -1.8904 },
    { name: 'Leeds', lat: 53.8008, lng: -1.5491 },
    { name: 'Bristol', lat: 51.4545, lng: -2.5879 },
    { name: 'York', lat: 53.9590, lng: -1.0452 },
    { name: 'Cardiff', lat: 51.4816, lng: -3.1791 },
    { name: 'Dublin', lat: 53.3498, lng: -6.2603 },
    { name: 'Belfast', lat: 54.5973, lng: -5.9301 }
];

/* ── arguments ───────────────────────────────────────────────────────── */
function argList(name) {
    const flag = '--' + name;
    const values = [];
    for (let i = 0; i < process.argv.length; i++) {
        if (process.argv[i] === flag && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
            values.push(process.argv[++i]);
        }
    }
    return values;
}
function argValue(name, fallback) {
    const values = argList(name);
    return values.length ? values[values.length - 1] : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

const perPlace = Math.max(1, parseInt(argValue('per-place', String(DEFAULT_PER_PLACE)), 10) || DEFAULT_PER_PLACE);
const maxFeatures = parseInt(argValue('max-features', '300'), 10) || 300;
const delay = parseInt(argValue('delay', '1000'), 10) || 1000;
const outFile = path.resolve(ROOT, argValue('out', 'data/other-maps-nls-catalog.json'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── load the browser adapter so the parser is never duplicated ──────── */
function loadNlsAdapter() {
    const sandbox = {
        URLSearchParams,
        setTimeout,
        clearTimeout,
        AbortController,
        console,
        fetch: globalThis.fetch
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/other-maps-nls.js'), 'utf8'), sandbox,
        { filename: 'js/other-maps-nls.js' });
    return sandbox.DetectLabOtherMapsNls;
}

const Nls = loadNlsAdapter();

/* ── WFS requests ────────────────────────────────────────────────────── */
function wfsPointUrl(lat, lng) {
    const point = 'POINT(' + Number(lng) + ' ' + Number(lat) + ')';
    const layers = Nls.FIND_LAYERS;
    const params = new URLSearchParams({
        service: 'WFS',
        version: '1.1.0',
        request: 'GetFeature',
        outputFormat: 'application/json',
        typeName: layers.map((layer) => 'nls:' + layer).join(','),
        propertyName: layers.map(() => '(the_geom,IMAGE,SHEET,DATES,YEAR)').join(''),
        CQL_FILTER: layers.map(() => 'INTERSECTS(the_geom,SRID=4326;' + point + ')').join(';'),
        maxFeatures: String(maxFeatures)
    });
    return Nls.WFS_BASE + '?' + params.toString();
}

async function getJson(url) {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + url);
    return response.json();
}

/* ── catalogue shaping ───────────────────────────────────────────────── */
function recordsFromFeatureCollection(json) {
    const records = [];
    const seen = new Set();
    (json && Array.isArray(json.features) ? json.features : []).forEach((feature) => {
        const record = Nls.featureToRecord(feature);
        if (record && !seen.has(record.id)) {
            seen.add(record.id);
            records.push(record);
        }
    });
    return records;
}

/* One dot per place: group by the settlement name, keep `perPlace` sheets
 * spread across the available years so a city does not collapse to one
 * decade, mirroring the live finder's sampling rule. */
function capPerPlace(records) {
    const groups = new Map();
    records.forEach((record) => {
        const key = record.place || record.title;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    });
    const picked = [];
    for (const list of groups.values()) {
        list.sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
        const k = Math.min(perPlace, list.length);
        for (let i = 0; i < k; i++) picked.push(list[Math.floor((i * list.length) / k)]);
    }
    return picked.sort((a, b) => a.place.localeCompare(b.place) || (a.year || 0) - (b.year || 0));
}

function walkJsonFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walkJsonFiles(full));
        else if (/\.(json|geojson)$/i.test(entry.name)) files.push(full);
    }
    return files;
}

function recordsFromJsonDir(dir) {
    const root = path.resolve(dir);
    if (!fs.existsSync(root)) throw new Error('--json-dir does not exist: ' + root);
    const records = [];
    const seen = new Set();
    walkJsonFiles(root).forEach((file) => {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            console.warn('  ! skipping ' + file + ': ' + err.message);
            return;
        }
        recordsFromFeatureCollection(json).forEach((record) => {
            if (!seen.has(record.id)) {
                seen.add(record.id);
                records.push(record);
            }
        });
    });
    return records;
}

function writeCatalog(records) {
    const catalog = {
        version: 1,
        generated: new Date().toISOString().slice(0, 10),
        note: 'Seed catalogue for the “Alte hărți / Other maps” sub-layer, sourced from the National Library of Scotland Map Finder (https://maps.nls.uk/geo/find/). Every record comes from a GeoServer WFS GetFeature response (IMAGE viewer id, SHEET/DATES/YEAR, footprint polygon); coordinates are the footprint centroids. The scan pyramid itself is read on demand from the NLS IIIF Image service on map-view.nls.uk. Run tools/build-nls-catalog.mjs to regenerate or extend this file.',
        sourceId: Nls.SOURCE,
        source: {
            name: 'National Library of Scotland · Map Finder',
            home: Nls.FIND_BASE,
            attribution: '© National Library of Scotland · maps.nls.uk — historic map scans released for re-use under the Library’s terms (https://maps.nls.uk/copyright).'
        },
        iiifBase: Nls.IIIF_BASE,
        recordBase: Nls.VIEW_BASE,
        wfs: Nls.WFS_BASE,
        maps: records
    };
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(catalog, null, 2) + '\n');
    return catalog;
}

/* ── self-test ───────────────────────────────────────────────────────── */
function selfTest() {
    const sample = {
        type: 'Feature',
        id: 'OS_Town_Plans_Eng_non500_WFS.60',
        properties: {
            IMAGE: '228799835',
            IMAGEURL: 'https://maps.nls.uk/view/228799835',
            SHEET: 'Accrington - Sheet 1, Surveyed: 1849,&nbsp;<br>&nbsp;Published: 1851',
            DATES: 'Surveyed: 1849, Published: 1851',
            YEAR: '1851'
        },
        geometry: {
            type: 'MultiPolygon',
            coordinates: [[[
                [-2.3695, 53.7511], [-2.3695, 53.7568],
                [-2.3549, 53.7568], [-2.3549, 53.7511], [-2.3695, 53.7511]
            ]]]
        }
    };
    const record = Nls.featureToRecord(sample);
    const assert = (condition, message) => {
        if (!condition) { console.error('✗ self-test: ' + message); process.exit(1); }
    };
    assert(record && record.id === 'nls/228799835', 'feature id maps to nls/<IMAGE>');
    assert(record.path === '22879/228799835', 'IIIF path is <id without its last four digits>/<IMAGE>');
    assert(Nls.iiifPath('74415150') === '7441/74415150',
        'an eight-digit town plan takes a four-digit IIIF prefix');
    assert(record.source === 'nls', 'the record is tagged with the nls source');
    assert(record.place === 'Accrington', 'place is read from the sheet title prefix');
    assert(record.year === 1851, 'year is parsed from the YEAR property');
    assert(Math.abs(record.lat - 53.75395) < 1e-9 && Math.abs(record.lng + 2.3622) < 1e-9,
        'coordinates are the footprint bbox centroid');
    assert(Nls.iiifBase(record) === 'https://map-view.nls.uk/iiif/2/22879%2F228799835',
        'the IIIF base URL encodes the slash');
    assert(Nls.thumbUrl(record) === 'https://map-view.nls.uk/iiif/2/22879%2F228799835/full/256,/0/default.jpg',
        'thumbnails are IIIF full-region requests');
    assert(Nls.recordUrl(record) === 'https://maps.nls.uk/view/228799835',
        'the record URL points at the Map Images viewer');
    assert(Nls.maxZoomFor(13176, 10110) === 5, 'pyramid depth follows the 512 px tile rule');
    const url = Nls.wfsBBoxUrl({ west: -3.3, south: 55.9, east: -3.1, north: 56.0 });
    assert(url.indexOf('service=WFS') !== -1 && url.indexOf('outputFormat=application%2Fjson') !== -1,
        'the WFS URL carries the finder parameters');
    assert((url.match(/INTERSECTS/g) || []).length === Nls.FIND_LAYERS.length,
        'one INTERSECTS filter per feature type');
    assert(url.indexOf('POLYGON') !== -1, 'the bbox query is an INTERSECTS polygon');
    assert(decodeURIComponent(url).indexOf('(the_geom,IMAGE,SHEET,DATES,YEAR)') !== -1,
        'the footprint column is requested so features carry their geometry');
    const pointUrl = wfsPointUrl(55.9533, -3.1883);
    assert(pointUrl.indexOf('SRID%3D4326%3BPOINT') !== -1 || pointUrl.indexOf('SRID=4326;POINT') !== -1,
        'the point query is an INTERSECTS point');
    assert(decodeURIComponent(pointUrl).indexOf('(the_geom,IMAGE,SHEET,DATES,YEAR)') !== -1,
        'the point query asks for the footprint too');
    assert(Nls.stripHtml('a&nbsp;<br>b &amp; c') === 'a b & c', 'HTML is stripped to plain text');
    const capped = capPerPlace([
        Object.assign({}, record, { id: 'nls/1', year: 1800 }),
        Object.assign({}, record, { id: 'nls/2', year: 1850 }),
        Object.assign({}, record, { id: 'nls/3', year: 1900 })
    ]);
    assert(capped.length === 3, 'per-place cap keeps distinct sheets');
    console.log('✓ build-nls-catalog self-test passed');
}

/* ── main ────────────────────────────────────────────────────────────── */
async function main() {
    if (flag('self-test')) { selfTest(); return; }

    let records;
    const jsonDir = argValue('json-dir', null);
    const bbox = argValue('bbox', null);
    const placeArgs = argList('place');

    if (jsonDir) {
        console.log('• harvesting saved WFS responses from ' + jsonDir);
        records = recordsFromJsonDir(jsonDir);
    } else if (bbox) {
        const parts = bbox.split(',').map(Number);
        if (parts.length !== 4 || parts.some((n) => !isFinite(n))) {
            throw new Error('--bbox must be west,south,east,north');
        }
        console.log('• WFS bbox query ' + bbox);
        const json = await getJson(Nls.wfsBBoxUrl({ west: parts[0], south: parts[1], east: parts[2], north: parts[3] }));
        records = recordsFromFeatureCollection(json);
    } else {
        let places = DEFAULT_PLACES;
        if (placeArgs.length) {
            const lats = argList('lat'), lngs = argList('lng');
            places = placeArgs.map((name, i) => ({
                name,
                lat: Number(lats[i]),
                lng: Number(lngs[i])
            }));
            if (places.some((p) => !isFinite(p.lat) || !isFinite(p.lng))) {
                throw new Error('each --place needs matching --lat and --lng');
            }
        }
        records = [];
        const seen = new Set();
        for (const place of places) {
            console.log('• WFS point query: ' + place.name);
            try {
                const json = await getJson(wfsPointUrl(place.lat, place.lng));
                recordsFromFeatureCollection(json).forEach((record) => {
                    if (!seen.has(record.id)) { seen.add(record.id); records.push(record); }
                });
            } catch (err) {
                console.warn('  ! ' + place.name + ': ' + err.message);
            }
            await sleep(delay);
        }
    }

    const picked = capPerPlace(records);
    const catalog = writeCatalog(picked);
    const places = new Set(picked.map((r) => r.place)).size;
    console.log('✓ wrote ' + picked.length + ' NLS sheets (' + places + ' places) → ' +
        path.relative(ROOT, outFile) + ' (raw: ' + records.length + ')');
}

main().catch((err) => {
    console.error('✗ build-nls-catalog failed:', err.message);
    process.exit(1);
});
