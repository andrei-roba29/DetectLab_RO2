/*!
 * DetectLab — Next-Gen APM · main-thread UI (Phase 1: MANUAL mode).
 *
 * Adds a small floating button and a panel. The panel takes the map centre,
 * a radius and the MANUAL parameters, runs DetectLabApmPipeline.runManual()
 * and draws the resulting class polygons on the existing Leaflet map
 * (window._dlMap). Nothing here touches the legacy archeo-potential layer.
 *
 * Depends on: DetectLabApmCore, DetectLabApmPipeline, Leaflet (L).
 */
(function (root) {
    'use strict';

    var CORE = function () { return root.DetectLabApmCore; };
    var PIPE = function () { return root.DetectLabApmPipeline; };
    var WORKER_URL = 'js/apm-next/apm-worker.js';
    var MAX_RADIUS_KM = 25;          // Phase 1 cap for MANUAL on the main thread
    var DEFAULTS = {
        radiusKm: 10,
        smoothDem: false,
        weights: { relief: 0.6, water: 0.4, soil: 0 },
        minSlopeDeg: 0.5,
        waterClasses: { small: true, medium: true, large: true, artificial: false },
        thresholds: { medium: 0.55, high: 0.70, veryhigh: 0.85 },
        minAreaM2: 2500
    };
    var WATER_LABELS = {
        small: 'Streams (small)', medium: 'Rivers (medium)',
        large: 'Large rivers & lakes', artificial: 'Canals & ditches'
    };

    var session = { worker: null, analysisKey: null, provenance: null, stats: null, waterClasses: [] };
    var token = null;
    var layer = null;
    var lastResult = null;
    var els = {};
    var ui = { panel: null, btn: null };

    /* ── helpers ─────────────────────────────────────────────────────────── */

    function getMap() { return root._dlMap || root.map || null; }

    function h(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v === false || v == null) return;                 // omitted boolean / empty
            if (k === 'text') node.textContent = v;
            else if (k === 'class') node.className = v;
            else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
            else if (v === true) node.setAttribute(k, '');
            else node.setAttribute(k, String(v));
        });
        (children || []).forEach(function (c) {
            if (c == null) return;
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
        });
        return node;
    }

    function fmtKm2(v) { return (Math.round(v * 100) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' km²'; }

    function num(input, fallback) {
        var v = parseFloat(input.value);
        return isFinite(v) ? v : fallback;
    }

    function setStatus(text, kind) {
        els.status.textContent = text || '';
        els.status.className = 'apm-status' + (kind ? ' apm-status-' + kind : '');
    }

    function setProgress(text, pct) {
        els.progress.hidden = false;
        els.progressBar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
        setStatus(text, 'busy');
    }

    function setBusy(busy) {
        els.run.disabled = busy;
        els.cancel.hidden = !busy;
        if (!busy) els.progress.hidden = true;
    }

    /* ── parameters ──────────────────────────────────────────────────────── */

    function readParams() {
        var core = CORE();
        var radiusKm = num(els.radius, DEFAULTS.radiusKm);
        if (!(radiusKm >= 1 && radiusKm <= MAX_RADIUS_KM)) throw new Error('Radius must be between 1 and ' + MAX_RADIUS_KM + ' km.');
        var wRelief = num(els.wRelief, 0), wWater = num(els.wWater, 0);
        if (wRelief < 0 || wWater < 0 || wRelief + wWater <= 0) throw new Error('Set at least one positive weight (relief or water).');
        var classes = Object.keys(DEFAULTS.waterClasses).filter(function (c) { return els.water[c].checked; });
        var thresholds = core.validateManualThresholds({
            medium: num(els.tMed, NaN) / 100, high: num(els.tHigh, NaN) / 100, veryhigh: num(els.tVery, NaN) / 100
        });
        var minArea = num(els.minArea, DEFAULTS.minAreaM2);
        if (!(minArea >= 0)) throw new Error('Minimum polygon area must be zero or positive.');
        var map = getMap();
        if (!map) throw new Error('The map is not ready yet.');
        var c = map.getCenter();
        return {
            centre: { lat: c.lat, lon: c.lng },
            radiusKm: radiusKm,
            smoothDem: !!els.smooth.checked,
            curves: core.DEFAULT_CURVES,
            weights: { relief: wRelief, water: wWater, soil: 0 },   // soil weight is 0 by default (Phase 1 keeps it off)
            minSlopeDeg: num(els.minSlope, DEFAULTS.minSlopeDeg),
            waterClasses: classes,
            thresholds: thresholds,
            minAreaM2: minArea,
            workerUrl: WORKER_URL,
            token: token
        };
    }

    /* ── run / cancel ────────────────────────────────────────────────────── */

    function run() {
        var params;
        try { params = readParams(); } catch (e) { setStatus(e.message, 'error'); return; }
        token = { cancelled: false };
        params.token = token;
        setBusy(true);
        setProgress('Starting…', 2);
        params.onProgress = function (text, pct) { if (token && !token.cancelled) setProgress(text, pct); };
        PIPE().runManual(session, params).then(function (res) {
            if (token !== null && token.cancelled) return;
            lastResult = res;
            drawResult(res);
            setBusy(false);
            setStatus('Done.' + (res.warnings && res.warnings.length ? ' See warnings below.' : ''), 'ok');
        }).catch(function (err) {
            setBusy(false);
            if (PIPE().isCancelled(err)) { setStatus('Cancelled.', ''); return; }
            setStatus('Could not run the model: ' + (err && err.message ? err.message : err), 'error');
        }).then(function () { token = null; });
    }

    function cancel() {
        if (token) token.cancelled = true;
        if (session.worker) { session.worker.terminate(); session.worker = null; session.analysisKey = null; }
        setBusy(false);
        setStatus('Cancelled.', '');
    }

    /* ── rendering ───────────────────────────────────────────────────────── */

    function clearResult() {
        var map = getMap();
        if (layer && map) map.removeLayer(layer);
        layer = null;
        lastResult = null;
        els.results.hidden = true;
        els.exportBtn.disabled = true;
        els.clearBtn.disabled = true;
        setStatus('', '');
    }

    function drawResult(res) {
        var map = getMap();
        if (layer && map) map.removeLayer(layer);
        var core = CORE();
        var classById = {};
        core.CLASSES.forEach(function (c) { classById[c.id] = c; });

        layer = root.L.geoJSON(res.geojson, {
            interactive: true,
            style: function (f) {
                return { color: f.properties.colour, weight: 1, fillColor: f.properties.colour, fillOpacity: 0.45 };
            },
            onEachFeature: function (f, l) {
                var p = f.properties;
                var label = p.label || (classById[p.class] && classById[p.class].label) || p.class;
                var area = p.areaM2 != null ? fmtKm2(p.areaM2 / 1e6) : '';
                l.bindPopup(h('div', { class: 'apm-popup' }, [
                    h('strong', { text: label }),
                    h('div', { text: area ? 'Area: ' + area : '' })
                ]));
            }
        }).addTo(map);

        var rows = core.CLASSES.map(function (c) {
            var v = res.areaKm2 ? res.areaKm2[c.id] : 0;
            return h('div', { class: 'apm-row' }, [
                h('span', { class: 'apm-swatch', style: 'background:' + c.colour }),
                h('span', { class: 'apm-row-label', text: c.label }),
                h('span', { class: 'apm-row-value', text: fmtKm2(v || 0) })
            ]);
        });
        var prov = res.provenance || {};
        var provText = [
            prov.dem ? 'Elevation: ' + prov.dem.label + ' (' + prov.dem.cellM + ' m cells)' : null,
            prov.water ? 'Water: ' + prov.water.label : 'Water: none available for this area',
            'Mode: MANUAL'
        ].filter(Boolean);
        els.resultRows.textContent = '';
        rows.forEach(function (r) { els.resultRows.appendChild(r); });
        els.provenance.textContent = provText.join(' · ');
        els.warnings.textContent = '';
        (res.warnings || []).forEach(function (w) { els.warnings.appendChild(h('li', { text: w })); });
        els.warnings.hidden = !(res.warnings && res.warnings.length);
        els.results.hidden = false;
        els.exportBtn.disabled = false;
        els.clearBtn.disabled = false;
    }

    function exportGeoJson() {
        if (!lastResult) return;
        var fc = JSON.parse(JSON.stringify(lastResult.geojson));
        fc.metadata = {
            tool: 'DetectLab Next-Gen APM', mode: 'manual',
            generated: new Date().toISOString(),
            provenance: lastResult.provenance, warnings: lastResult.warnings
        };
        var blob = new Blob([JSON.stringify(fc)], { type: 'application/geo+json' });
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: 'apm-manual-' + new Date().toISOString().slice(0, 10) + '.geojson' });
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    /* ── panel construction ──────────────────────────────────────────────── */

    function slider(labelText, min, max, step, value, id) {
        var input = h('input', { type: 'range', min: min, max: max, step: step, value: value, id: id });
        var out = h('output', { text: String(value) });
        input.addEventListener('input', function () { out.textContent = input.value; });
        return { row: h('label', { class: 'apm-field' }, [h('span', { text: labelText }), input, out]), input: input };
    }

    function numberField(labelText, value, opts) {
        var input = h('input', Object.assign({ type: 'number', value: value }, opts || {}));
        return { row: h('label', { class: 'apm-field' }, [h('span', { text: labelText }), input]), input: input };
    }

    function buildPanel() {
        var radius = numberField('Radius (km, 1–' + MAX_RADIUS_KM + ')', DEFAULTS.radiusKm, { min: 1, max: MAX_RADIUS_KM, step: 1 });
        var smooth = h('input', { type: 'checkbox' });
        var wRel = slider('Relief weight', 0, 1, 0.05, DEFAULTS.weights.relief, 'apm-w-relief');
        var wWat = slider('Water weight', 0, 1, 0.05, DEFAULTS.weights.water, 'apm-w-water');
        var minSlope = numberField('Min slope for aspect (°)', DEFAULTS.minSlopeDeg, { min: 0, max: 20, step: 0.5 });
        var tMed = numberField('Medium threshold (%)', Math.round(DEFAULTS.thresholds.medium * 100), { min: 0, max: 99, step: 1 });
        var tHigh = numberField('High threshold (%)', Math.round(DEFAULTS.thresholds.high * 100), { min: 1, max: 99, step: 1 });
        var tVery = numberField('Very high threshold (%)', Math.round(DEFAULTS.thresholds.veryhigh * 100), { min: 1, max: 100, step: 1 });
        var minArea = numberField('Min polygon area (m²)', DEFAULTS.minAreaM2, { min: 0, step: 500 });

        var water = {};
        var waterBoxes = Object.keys(DEFAULTS.waterClasses).map(function (c) {
            var cb = h('input', { type: 'checkbox' });
            cb.checked = !!DEFAULTS.waterClasses[c];
            water[c] = cb;
            return h('label', { class: 'apm-check' }, [cb, h('span', { text: WATER_LABELS[c] })]);
        });

        els.radius = radius.input; els.smooth = smooth; els.wRelief = wRel.input; els.wWater = wWat.input;
        els.minSlope = minSlope.input; els.tMed = tMed.input; els.tHigh = tHigh.input; els.tVery = tVery.input;
        els.minArea = minArea.input; els.water = water;

        els.status = h('div', { class: 'apm-status', role: 'status', 'aria-live': 'polite' });
        els.progressBar = h('div', { class: 'apm-progress-bar' });
        els.progress = h('div', { class: 'apm-progress', hidden: true }, [els.progressBar]);
        els.run = h('button', { type: 'button', class: 'apm-btn apm-primary', onclick: run, text: 'Run MANUAL model' });
        els.cancel = h('button', { type: 'button', class: 'apm-btn', hidden: true, onclick: cancel, text: 'Cancel' });
        els.exportBtn = h('button', { type: 'button', class: 'apm-btn', disabled: true, onclick: exportGeoJson, text: 'Export GeoJSON' });
        els.clearBtn = h('button', { type: 'button', class: 'apm-btn', disabled: true, onclick: clearResult, text: 'Clear result' });

        els.resultRows = h('div', { class: 'apm-rows' });
        els.provenance = h('div', { class: 'apm-provenance' });
        els.warnings = h('ul', { class: 'apm-warnings', hidden: true });
        els.results = h('div', { class: 'apm-results', hidden: true }, [
            h('h4', { text: 'Result (area per class)' }), els.resultRows, els.provenance, els.warnings
        ]);

        var trainNote = h('div', { class: 'apm-note', text: 'TRAIN mode (fit to known sites) is planned for Phase 2.' });
        var close = h('button', { type: 'button', class: 'apm-close', 'aria-label': 'Close', onclick: togglePanel, text: '✕' });

        var panel = h('section', { class: 'apm-panel', id: 'apmNextPanel', hidden: true, 'aria-label': 'Next-Gen APM' }, [
            h('header', { class: 'apm-head' }, [
                h('h3', { text: 'Next-Gen APM · MANUAL' }),
                close
            ]),
            h('p', { class: 'apm-intro', text: 'Scores the area around the map centre from terrain (slope, aspect, relief) and water distance using fixed, documented curves.' }),
            h('fieldset', { class: 'apm-group' }, [
                h('legend', { text: 'Area' }),
                radius.row,
                h('label', { class: 'apm-check' }, [smooth, h('span', { text: 'Smooth elevation (less noise, slower)' })])
            ]),
            h('fieldset', { class: 'apm-group' }, [
                h('legend', { text: 'Weights' }),
                wRel.row, wWat.row
            ]),
            h('fieldset', { class: 'apm-group' }, [
                h('legend', { text: 'Water classes' }),
                h('div', { class: 'apm-checks' }, waterBoxes)
            ]),
            h('details', { class: 'apm-group' }, [
                h('summary', { text: 'Advanced' }),
                minSlope.row, tMed.row, tHigh.row, tVery.row, minArea.row
            ]),
            h('div', { class: 'apm-actions' }, [els.run, els.cancel, els.exportBtn, els.clearBtn]),
            els.progress,
            els.status,
            els.results,
            trainNote
        ]);
        return panel;
    }

    function togglePanel(force) {
        var open = typeof force === 'boolean' ? force : ui.panel.hidden;
        ui.panel.hidden = !open;
        ui.btn.setAttribute('aria-expanded', String(open));
    }

    function init() {
        if (!root.DetectLabApmPipeline || !root.DetectLabApmCore) return;   // scripts missing: fail silently
        if (document.getElementById('apmNextBtn')) return;
        ui.panel = buildPanel();
        ui.btn = h('button', {
            type: 'button', id: 'apmNextBtn', class: 'apm-fab', 'aria-expanded': 'false',
            'aria-controls': 'apmNextPanel', title: 'Next-Gen APM (MANUAL)', onclick: function () { togglePanel(); }
        }, [h('span', { text: 'APM' }), h('span', { class: 'apm-fab-sub', text: 'next-gen' })]);
        document.body.appendChild(ui.panel);
        document.body.appendChild(ui.btn);
    }

    root.DetectLabApmUi = { init: init, open: function () { togglePanel(true); }, close: function () { togglePanel(false); } };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(typeof window !== 'undefined' ? window : this);
