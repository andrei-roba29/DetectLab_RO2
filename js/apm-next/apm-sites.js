/*!
 * DetectLab — Next-Gen APM · known-site records: parsing, filtering, periods.
 *
 * Canonical record (what every site provider must return):
 *   { id, lat, lon, periodStart, periodEnd, periodLabel, type, positionAccuracy (metres|null), source }
 * periodStart / periodEnd are integer years (negative = BCE) or null when undated.
 */
(function (root, factory) {
    var api = factory(typeof module === 'object' && module.exports ? require('./apm-core.js') : root.DetectLabApmCore);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DetectLabApmSites = api;
})(typeof self !== 'undefined' ? self : this, function (core) {
    'use strict';

    /** Record types treated as settlements. Anything else is dropped in TRAIN. */
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
        return bce ? -Math.abs(n) : n;
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

    function periodLabelFromYears(a, b) {
        var f = function (y) { return y < 0 ? (-y) + ' BC' : y + ' AD'; };
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
            if (r.positionAccuracy == null || r.positionAccuracy > maxAcc) { drop.accuracy++; return; }
            if (opts.period) {
                if (r.periodStart == null || r.periodEnd == null) { drop.undated++; return; }
                if (!(r.periodStart <= opts.period.end && r.periodEnd >= opts.period.start)) { drop.outOfPeriod++; return; }
            }
            kept.push(r);
        });
        // De-duplicate: keep the first of any pair closer than dedupeM.
        var result = [];
        kept.forEach(function (r) {
            for (var i = 0; i < result.length; i++) {
                if (core.haversineM(r.lat, r.lon, result[i].lat, result[i].lon) < dedupeM) { drop.duplicate++; return; }
            }
            result.push(r);
        });
        return { sites: result, dropped: drop, total: records.length };
    }

    /** Count records per period label (before the period choice), for the period picker. */
    function groupPeriods(records) {
        var map = {};
        records.forEach(function (r) {
            var key = r.periodLabel || 'undated';
            if (!map[key]) map[key] = { label: key, count: 0, start: null, end: null, undated: r.periodStart == null };
            var g = map[key];
            g.count++;
            if (r.periodStart != null) g.start = g.start == null ? r.periodStart : Math.min(g.start, r.periodStart);
            if (r.periodEnd != null) g.end = g.end == null ? r.periodEnd : Math.max(g.end, r.periodEnd);
        });
        return Object.keys(map).map(function (k) { return map[k]; })
            .sort(function (a, b) { return (a.start == null ? 1e9 : a.start) - (b.start == null ? 1e9 : b.start); });
    }

    return {
        SETTLEMENT_TYPES: SETTLEMENT_TYPES,
        MAX_POSITION_ACCURACY_M: MAX_POSITION_ACCURACY_M,
        ACCURACY_WORDS: ACCURACY_WORDS,
        splitCsv: splitCsv,
        parseSitesCsv: parseSitesCsv,
        parseAccuracy: parseAccuracy,
        parseYear: parseYear,
        filterSites: filterSites,
        groupPeriods: groupPeriods
    };
});
