/*!
 * DetectLab — Next-Gen APM · known-site records: parsing, filtering, periods.
 *
 * Canonical record (what every site provider must return):
 *   { id, lat, lon, periodStart, periodEnd, periodLabel, type, positionAccuracy (metres|null), source }
 * periodStart / periodEnd are integer years (negative = BCE) or null when undated.
 * ARIADNE adds periods:[{label,start,end,uri}] so separate occupation phases are not flattened.
 */
(function (root, factory) {
    var api = factory(typeof module === 'object' && module.exports ? require('./apm-core.js') : root.DetectLabApmCore);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmSites = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
    'use strict';

    /** Settlement-like records only; generic sites and monuments are not training positives. */
    var SETTLEMENT_TYPES = ['settlement', 'habitation', 'village', 'town', 'city', 'vicus', 'camp', 'fort', 'castrum', 'urban'];

    /** Positions coarser than this (metres) are dropped. Stated in the UI and docs. */
    var MAX_POSITION_ACCURACY_M = 100;

    /** Named accuracy classes → metres (used when a provider gives text, not a number). */
    var ACCURACY_WORDS = {
        exact: 5, precise: 25, high: 25, good: 50, medium: 250, approximate: 1000,
        approx: 1000, coarse: 5000, region: 10000, unknown: null, '': null
    };

    /* ── Parsing ───────────────────────────────────────────────────────────── */
    function normKey(k) { return String(k || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

    var ALIASES = {
        id: ['id', 'siteid', 'identifier', 'name', 'recordid'],
        lat: ['lat', 'latitude', 'y', 'ycoord', 'northing'],
        lon: ['lon', 'lng', 'long', 'longitude', 'x', 'xcoord', 'easting'],
        periodStart: ['periodstart', 'start', 'startyear', 'yearfrom', 'from', 'datestart', 'begin'],
        periodEnd: ['periodend', 'end', 'endyear', 'yearto', 'to', 'dateend', 'finish'],
        periodLabel: ['period', 'periodlabel', 'periodname', 'culture', 'epoch', 'chronology'],
        type: ['type', 'sitetype', 'category', 'kind', 'feature'],
        positionAccuracy: ['positionaccuracy', 'accuracy', 'locationaccuracy', 'precision', 'positionprecision', 'accuracym']
    };

    /** Minimal RFC-4180-style CSV split. Supports quoted fields with commas/newlines/double quotes. */
    function splitCsv(text, delim) {
        var rows = [], row = [], field = '', i = 0, q = false;
        while (i < text.length) {
            var c = text[i];
            if (q) {
                if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
                else field += c;
            } else if (c === '"') q = true;
            else if (c === delim) { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(field); rows.push(row); row = []; field = '';
            } else field += c;
            i++;
        }
        if (field.length || row.length) { row.push(field); rows.push(row); }
        return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
    }

    function detectDelimiter(headerLine) {
        var counts = { ',': 0, ';': 0, '\t': 0 };
        for (var i = 0; i < headerLine.length; i++) if (counts[headerLine[i]] !== undefined) counts[headerLine[i]]++;
        return Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    }

    function parseAccuracy(v) {
        if (v == null || String(v).trim() === '') return null;
        var n = Number(String(v).replace(',', '.'));
        if (isFinite(n)) return n;
        var word = String(v).trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(ACCURACY_WORDS, word) ? ACCURACY_WORDS[word] : null;
    }

    function parseYear(v) {
        if (v == null) return null;
        var s = String(v).trim();
        if (s === '') return null;
        var bce = /\s*(bc|bce|v\.chr)$/i.test(s);
        var n = parseInt(s.replace(/[^0-9-]/g, ''), 10);
        if (!isFinite(n)) return null;
        // Astronomical year numbering: 1 BC = year 0, 2 BC = year -1, so "N BC" → 1 − N.
        // A plain negative number is taken as already astronomical and is left unchanged.
        return bce ? 1 - Math.abs(n) : n;
    }

    /**
     * Parse CSV text into canonical records plus a report.
     * Returns { records, report:{ total, missingCoords, typeAssumed, headerMap, errors[] } }.
     */
    function parseSitesCsv(text, sourceLabel) {
        var report = { total: 0, missingCoords: 0, typeAssumed: false, headerMap: {}, errors: [] };
        text = String(text || '').replace(/^\uFEFF/, '');
        var firstLine = text.split(/\r?\n/)[0] || '';
        var delim = detectDelimiter(firstLine);
        var rows = splitCsv(text, delim);
        if (rows.length < 2) { report.errors.push('The file has no data rows.'); return { records: [], report: report }; }
        var header = rows[0].map(normKey);
        var map = {};
        Object.keys(ALIASES).forEach(function (field) {
            for (var a = 0; a < ALIASES[field].length; a++) {
                var idx = header.indexOf(ALIASES[field][a]);
                if (idx >= 0) { map[field] = idx; break; }
            }
        });
        report.headerMap = map;
        if (map.lat == null || map.lon == null) {
            report.errors.push('Required columns not found: latitude and longitude (accepted names: ' +
                ALIASES.lat.concat(ALIASES.lon).join(', ') + ').');
            return { records: [], report: report };
        }
        if (map.type == null) report.typeAssumed = true;
        var records = [];
        for (var r = 1; r < rows.length; r++) {
            report.total++;
            var row = rows[r];
            var get = function (f) { return map[f] == null ? '' : (row[map[f]] || '').trim(); };
            var lat = Number(get('lat').replace(',', '.')), lon = Number(get('lon').replace(',', '.'));
            if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                report.missingCoords++;
                continue;
            }
            var type = map.type == null ? 'settlement' : (get('type').toLowerCase() || 'unknown');
            var start = parseYear(get('periodStart')), end = parseYear(get('periodEnd'));
            if (start != null && end == null) end = start;
            if (end != null && start == null) start = end;
            if (start != null && end != null && end < start) { var tmp = start; start = end; end = tmp; }
            records.push({
                id: get('id') || ('csv-' + r),
                lat: lat,
                lon: lon,
                periodStart: start,
                periodEnd: end,
                periodLabel: get('periodLabel') || (start == null ? 'undated' : periodLabelFromYears(start, end)),
                type: type,
                positionAccuracy: parseAccuracy(get('positionAccuracy')),
                source: sourceLabel || 'csv'
            });
        }
        return { records: records, report: report };
    }

    /** AAT inhabited places (300008347) and descendants. Small vocabulary snapshot from
     * ARIADNE-Infrastructure/portal/server/classes/AAT/term-descendants.json (2026-10-30).
     * Match controlled subjects, never title/description mentions of nearby settlements.
     */
    var ARIADNE_SETTLEMENT_TERMS = {
        "300008347": "inhabited places",
        "300008350": "settlements by form",
        "300008369": "hamlets",
        "300008372": "villages",
        "300108349": "kraals",
        "300262891": "ksour",
        "300389983": "nucleated villages",
        "300008375": "towns",
        "300008396": "oppida",
        "300265593": "theme towns",
        "300379492": "historic towns",
        "300387212": "burgs",
        "300008389": "cities",
        "300008394": "municipia",
        "300008397": "poleis",
        "300008401": "metropolises",
        "300000751": "medinas",
        "300008400": "agglomerations",
        "300008402": "megalopolises",
        "300008404": "conurbations",
        "300132618": "metropolitan areas",
        "300257104": "camps",
        "300387203": "communities",
        "300387241": "former communities",
        "300387330": "communes",
        "300391480": "demes",
        "300391496": "linear settlements",
        "300008356": "linear cities",
        "300444153": "settlements",
        "300008407": "settlements by function",
        "300120579": "settlements by function: administrative",
        "300008415": "local administrative centers",
        "300008416": "county seats",
        "300008419": "parish seats",
        "300387240": "noble seats",
        "300008485": "colonial cities",
        "300008486": "missions",
        "300008487": "pueblos",
        "300265612": "municipalities",
        "300311237": "Indian reductions",
        "300387205": "localities",
        "300387218": "capitals",
        "300008410": "capital cities",
        "300387219": "national capitals",
        "300387220": "regional capitals",
        "300387221": "state capitals",
        "300387222": "district capitals",
        "300387223": "provincial capitals",
        "300387225": "department capitals",
        "300387226": "subregional capitals",
        "300387231": "colonial settlements",
        "300387235": "episcopal sees",
        "300387236": "archiepiscopal sees",
        "300387237": "patriarchal sees",
        "300387508": "parlements",
        "300387529": "cathedral centers",
        "300008458": "cathedral cities",
        "300387528": "cathedral towns",
        "300387716": "seats",
        "300435537": "headquarters",
        "300443773": "park headquarters",
        "300120590": "settlements by function: military",
        "300008449": "bastides",
        "300008450": "castelli",
        "300008455": "presidios",
        "300387238": "fortified settlements",
        "300443507": "walled settlements",
        "300387275": "military centers",
        "300008454": "military towns",
        "300263194": "televillages",
        "300387067": "special cities",
        "300387068": "independent cities",
        "300387213": "special municipalities",
        "300387239": "imperial cities",
        "300387264": "administrative centers",
        "300387265": "legislative centers",
        "300387266": "judicial centers",
        "300387269": "regional centers",
        "300387270": "transportation centers",
        "300404130": "halting places",
        "300387272": "religious centers",
        "300387273": "monastic centers",
        "300391482": "sanctuary centers",
        "300412063": "",
        "300387320": "political centers",
        "300412053": "emporia",
        "300443764": "facility centers",
        "300450681": "census-designated places",
        "300008467": "settlements by location",
        "300008475": "settlements by location: topographical",
        "300387314": "coastal settlements",
        "300008483": "coastal towns",
        "300387315": "hill settlements",
        "300008479": "hill towns",
        "300387316": "river settlements",
        "300008482": "river towns",
        "300387317": "oasis settlements",
        "300444930": "marina settlements",
        "300449004": "underground settlements",
        "300449005": "cave settlements",
        "300000874": "suburbs",
        "300000879": "garden suburbs",
        "300000880": "exurbs",
        "300120707": "space colonies",
        "300249169": "edge cities",
        "300387210": "rural communities",
        "300387232": "frontier settlements",
        "300387510": "satellite communities",
        "300008384": "satellite cities",
        "300387509": "satellite towns",
        "300008488": "settlements by condition",
        "300008537": "lost settlements",
        "300387650": "lost cities",
        "300387651": "lost villages",
        "300008542": "ruined settlements",
        "300167671": "deserted settlements",
        "300266395": "abandoned cities",
        "300387242": "buried settlements",
        "300008544": "buried cities",
        "300008545": "tells",
        "300155228": "hüyüks",
        "300155914": "tepes",
        "300008547": "ghost towns",
        "300008549": "unincorporated areas",
        "300387066": "autonomous municipalities",
        "300387069": "autonomous cities",
        "300387243": "ephemeral communities",
        "300387246": "incorporated areas",
        "300387247": "seasonally inhabited places",
        "300391424": "cultural centers",
        "300391436": "occupation sites",
        "300443501": "sister cities",
        "300443856": "former inhabited places",
        "300443971": "centers",
        "300008490": "settlements by planning concept",
        "300008492": "model cities",
        "300008496": "future cities",
        "300008498": "ideal cities",
        "300181194": "urban villages",
        "300387215": "villes neuves",
        "300387517": "planned communities",
        "300008377": "new towns",
        "300008381": "garden cities",
        "300387214": "civitates",
        "300387520": "model villages",
        "300008502": "settlements by occupants",
        "300008503": "artists' colonies",
        "300008509": "retirement communities",
        "300113278": "life care communities",
        "300259605": "continuing care retirement communities",
        "300008511": "squatter settlements",
        "300263222": "quilombos",
        "300386139": "agrahāra",
        "300387216": "leper colonies",
        "300387271": "residential centers",
        "300387318": "penal settlements",
        "300000280": "penal colonies",
        "300387319": "craftsman settlements",
        "300387321": "refugee centers",
        "300387326": "native peoples reservations",
        "300008506": "Indian reservations",
        "300387323": "tribal areas",
        "300387325": "Aboriginal reserves",
        "300387531": "First Nations reserves",
        "300387327": "Amerindian communities",
        "300391509": "",
        "300411530": "health colonies",
        "300008522": "settlements by ownership",
        "300008523": "collective settlements",
        "300008526": "communes",
        "300008527": "kibbutzim",
        "300120583": "settlements by economic base",
        "300008489": "boomtowns",
        "300120599": "ports",
        "300387253": "treaty ports",
        "300387254": "free ports",
        "300387255": "inland ports",
        "300387256": "river ports",
        "300387257": "ports of entry",
        "300387511": "seaports",
        "300411435": "outer ports",
        "300155931": "company towns",
        "300178894": "golf course communities",
        "300387233": "cow towns",
        "300387249": "fishing communities",
        "300008461": "fishing villages",
        "300387250": "fur stations",
        "300387267": "prison centers",
        "300387662": "prison towns",
        "300387276": "breeding centers",
        "300387277": "agricultural centers",
        "300008420": "agricultural settlements",
        "300404010": "",
        "300387278": "irrigation centers",
        "300387279": "livestock centers",
        "300387280": "timber centers",
        "300387281": "viniculture centers",
        "300387282": "corporate headquarters",
        "300387283": "fish-processing centers",
        "300387284": "financial centers",
        "300387285": "market centers",
        "300008423": "market towns",
        "300263210": "bourgs",
        "300387668": "market hamlets",
        "300387669": "market villages",
        "300387286": "trade centers",
        "300387287": "shipping centers",
        "300387288": "shipbuilding centers",
        "300387290": "textile centers",
        "300387291": "tourist centers",
        "300122715": "tourist towns",
        "300387659": "tourist villages",
        "300387292": "resort centers",
        "300387293": "sporting centers",
        "300387294": "spa centers",
        "300387295": "entertainment centers",
        "300387296": "university centers",
        "300008429": "university cities",
        "300387527": "university towns",
        "300387298": "college centers",
        "300008430": "college towns",
        "300387299": "scientific centers",
        "300387300": "publishing centers",
        "300387302": "industrial centers",
        "300008432": "industrial towns",
        "300387303": "factory centers",
        "300155942": "factory villages",
        "300387304": "mill centers",
        "300008436": "mill towns",
        "300387305": "mining centers",
        "300008464": "mining towns",
        "300387234": "gold towns",
        "300387308": "manufacturing centers",
        "300387306": "quarrying centers",
        "300387309": "petroleum refining centers",
        "300387310": "metallurgical centers",
        "300387311": "communications centers",
        "300387312": "power production centers",
        "300387313": "weapons production centers",
        "300387512": "commercial centers"
    };
    var ARIADNE_SETTLEMENT_FILTERS = ['inhabited places', 'settlements (sites of small communities)'];
    function list(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
    function normLabel(v) { return String(v || '').trim().toLowerCase(); }
    var settlementLabels = Object.create(null);
    Object.keys(ARIADNE_SETTLEMENT_TERMS).forEach(function (id) {
        if (ARIADNE_SETTLEMENT_TERMS[id]) settlementLabels[normLabel(ARIADNE_SETTLEMENT_TERMS[id])] = true;
    });
    settlementLabels['settlements (sites of small communities)'] = true;
    function isAriadneSettlement(data) {
        return list(data.derivedSubject).some(function (subject) {
            if (!subject) return false;
            var id = String(subject.id || subject.uri || '').split('/').pop();
            return Object.prototype.hasOwnProperty.call(ARIADNE_SETTLEMENT_TERMS, id) || !!settlementLabels[normLabel(subject.prefLabel)];
        });
    }

    function periodKey(p) {
        return JSON.stringify([p.uri || '', p.label || '', p.start, p.end]);
    }
    function recordPeriods(r) {
        return Array.isArray(r.periods) ? r.periods : [{ label: r.periodLabel || 'undated', start: r.periodStart, end: r.periodEnd, uri: null }];
    }
    /** Individual occupation phases stay separate: no invented occupation across gaps. */
    function parseAriadneHits(hits) {
        var records = [];
        function number(v) { return v == null || String(v).trim() === '' ? null : (isFinite(Number(v)) ? Number(v) : null); }
        hits.forEach(function (hit) {
            var d = hit && hit.data;
            if (!d || normLabel(d.resourceType) !== 'site/monument' || !isAriadneSettlement(d)) return;
            var periods = list(d.temporal).filter(Boolean).map(function (t) {
                var start = number(t.from), end = number(t.until);
                if (start != null && end != null && start > end) { var tmp = start; start = end; end = tmp; }
                return { label: t.periodName || (start != null && end != null ? periodLabelFromYears(start, end) : 'undated'),
                    start: start, end: end, uri: t.uri || null };
            });
            if (!periods.length) periods = [{ label: 'undated', start: null, end: null, uri: null }];
            list(d.spatial).forEach(function (sp, i) {
                var g = sp && sp.geopoint;
                if (!g) return;
                var lat = number(g.lat), lon = number(g.lon);
                if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
                records.push({
                    id: String(hit.id) + ':' + i, lat: lat, lon: lon,
                    // Legacy scalar fields describe only the first phase, never an envelope over all phases.
                    periodStart: periods[0].start, periodEnd: periods[0].end,
                    periodLabel: periods[0].label, periods: periods,
                    type: 'settlement', positionAccuracy: null, source: 'ariadne',
                    approximatePosition: !!(sp.spatialPrecision || sp.coordinatePrecision),
                    url: 'https://ariadne-portal.d4science.org/resource/' + encodeURIComponent(hit.id)
                });
            });
        });
        return records;
    }

    function periodLabelFromYears(a, b) {
        var f = function (y) { return y <= 0 ? (1 - y) + ' BC' : y + ' AD'; };
        return a === b ? f(a) : f(a) + ' – ' + f(b);
    }

    /* ── Filtering ─────────────────────────────────────────────────────────── */
    /**
     * Apply the TRAIN filters in order and report what was dropped and why.
     * opts: { center:{lat,lon}, radiusKm=50, period:{start,end}|null, types=SETTLEMENT_TYPES,
     *         maxAccuracyM=MAX_POSITION_ACCURACY_M, dedupeM=50 }
     */
    function filterSites(records, opts) {
        var types = opts.types || SETTLEMENT_TYPES;
        var maxAcc = opts.maxAccuracyM == null ? MAX_POSITION_ACCURACY_M : opts.maxAccuracyM;
        var dedupeM = opts.dedupeM == null ? 50 : opts.dedupeM;
        var radiusM = (opts.radiusKm || 50) * 1000;
        var drop = { outside: 0, type: 0, accuracy: 0, undated: 0, outOfPeriod: 0, duplicate: 0 };
        var kept = [];
        records.forEach(function (r) {
            if (core.haversineM(opts.center.lat, opts.center.lon, r.lat, r.lon) > radiusM) { drop.outside++; return; }
            if (types.indexOf(String(r.type).toLowerCase()) < 0) { drop.type++; return; }
            if (r.approximatePosition || (r.positionAccuracy == null && r.source !== 'ariadne') || (r.positionAccuracy != null && (r.positionAccuracy < 0 || r.positionAccuracy > maxAcc))) { drop.accuracy++; return; }
            if (opts.period) {
                var phases = recordPeriods(r);
                var match = phases.some(function (p) {
                    if (opts.period.key) return periodKey(p) === opts.period.key;
                    return p.start != null && p.end != null && p.start <= opts.period.end && p.end >= opts.period.start;
                });
                if (!match) {
                    var dated = phases.some(function (p) { return p.start != null && p.end != null; });
                    drop[dated ? 'outOfPeriod' : 'undated']++; return;
                }
            }
            kept.push(r);
        });
        // De-duplicate: keep the first of any pair closer than dedupeM.
        var result = [];
        kept.forEach(function (r) {
            for (var i = 0; i < result.length; i++) {
                if (core.haversineM(r.lat, r.lon, result[i].lat, result[i].lon) < dedupeM) {
                    // Preserve every occupation phase at a duplicate location for the period picker.
                    if (r.source === 'ariadne' && result[i].source === 'ariadne') {
                        var merged = result[i].periods.slice();
                        recordPeriods(r).forEach(function (p) {
                            if (!merged.some(function (q) { return periodKey(p) === periodKey(q); })) merged.push(p);
                        });
                        result[i].periods = merged;
                    }
                    drop.duplicate++; return;
                }
            }
            result.push(r.source === 'ariadne' ? Object.assign({}, r, { periods: recordPeriods(r).slice() }) : r);
        });
        return { sites: result, dropped: drop, total: records.length };
    }

    /** Count records per period label (before the period choice), for the period picker. */
    function groupPeriods(records) {
        var map = Object.create(null);
        records.forEach(function (r) {
            var seen = Object.create(null);
            recordPeriods(r).forEach(function (p) {
                var key = periodKey(p);
                if (seen[key]) return;
                seen[key] = true;
                if (!map[key]) map[key] = { key: key, label: p.label, count: 0, start: p.start, end: p.end,
                    undated: p.start == null || p.end == null,
                    selectable: p.label !== 'undated' || (p.start != null && p.end != null) };
                map[key].count++;
            });
        });
        return Object.keys(map).map(function (k) { return map[k]; })
            .sort(function (a, b) { return (a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start) || a.label.localeCompare(b.label); });
    }

    return {
        ARIADNE_SETTLEMENT_FILTERS: ARIADNE_SETTLEMENT_FILTERS,
        isAriadneSettlement: isAriadneSettlement,
        SETTLEMENT_TYPES: SETTLEMENT_TYPES,
        MAX_POSITION_ACCURACY_M: MAX_POSITION_ACCURACY_M,
        ACCURACY_WORDS: ACCURACY_WORDS,
        splitCsv: splitCsv,
        parseSitesCsv: parseSitesCsv,
        parseAriadneHits: parseAriadneHits,
        parseAccuracy: parseAccuracy,
        parseYear: parseYear,
        filterSites: filterSites,
        groupPeriods: groupPeriods
    };
});
