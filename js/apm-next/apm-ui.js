/*!
 * DetectLab — Next-Gen APM · main-thread panel (MANUAL and TRAIN).
 *
 * The user switches the feature on, picks a search point on the map, chooses a mode and runs the
 * model. Results are drawn on the existing Leaflet map (window._dlMap). Premium is checked with the
 * app's own entitlement function (window._dlIsPremium). Nothing here touches the legacy
 * archeo-potential layer.
 *
 * Depends on: DetectLabApmCore, DetectLabApmPipeline, DetectLabApmSites, DetectLabApmProviders,
 *             DetectLabApmI18n, Leaflet (L).
 */
(function (root) {
    'use strict';

    var WORKER_URL = 'js/apm-next/apm-worker.js?v=20261029-apm-next-phase3';
    var SWITCH_KEY = 'detectlab_apm_next';         // 'on' | 'off' (default off)
    var DEBUG_KEY = 'apmDebug';                    // shared with apm-providers.js
    var TRAIN_AREA_KM = 50;

    var core = function () { return root.DetectLabApmCore; };
    var pipe = function () { return root.DetectLabApmPipeline; };
    var sites = function () { return root.DetectLabApmSites; };
    var prov = function () { return root.DetectLabApmProviders; };
    var I18N = function () { return root.DetectLabApmI18n; };

    /* ── state ───────────────────────────────────────────────────────────── */

    var state = {
        mode: 'manual',
        enabled: false,
        centre: null,               // { lat, lon } picked on the map
        picking: false,
        radiusKm: 5,
        records: null,              // parsed CSV (TRAIN)
        csvName: '',
        period: null,               // { start, end } or null = all periods
        periods: [],                // groupPeriods() output for the chosen centre
        curveText: null,            // editable curve text per curve name
        result: null,
        busy: false,
        token: null,
        manualSession: { worker: null, analysisKey: null, provenance: null, stats: null, waterClasses: [] },
        trainSession: { worker: null, analysisKey: null, provenance: null, stats: null, waterClasses: [] }
    };

    var map = null, layer = null, centreMarker = null, radiusCircle = null, legendControl = null, legendEl = null;
    var els = {}, ui = { panel: null, btn: null };
    var i18nBindings = [];          // [{ el, key, attr }] refreshed on language change

    /* ── small helpers ───────────────────────────────────────────────────── */

    function lang() {
        try {
            if (typeof root._currentLang === 'function') return I18N().normaliseLang(root._currentLang());
            var stored = root.localStorage && root.localStorage.getItem('detectlab_lang');
            if (stored) return I18N().normaliseLang(stored);
        } catch (e) { /* storage blocked */ }
        return I18N().normaliseLang(document.documentElement.lang || 'en');
    }

    function T(key, vars) { return I18N().t(key, lang(), vars); }

    /** Translate a keyed message { key, vars }; nested keyed messages (e.g. a reason) are translated too. */
    function tm(m) {
        if (m == null) return '';
        if (typeof m === 'string') return m;
        var vars = {};
        Object.keys(m.vars || {}).forEach(function (k) {
            var v = m.vars[k];
            vars[k] = (v && typeof v === 'object' && v.key) ? tm(v) : v;
        });
        return T(m.key, vars);
    }
    /** Text for an error thrown by the pipeline or core (keyed) or by plain code (message). */
    function errText(e) {
        if (e && e.key) return tm({ key: e.key, vars: e.vars });
        return e && e.message ? e.message : String(e);
    }

    /* DEV-OVERRIDE-BEGIN — developer-only premium override. REMOVE BEFORE RELEASE (this block and the
     * `devPremiumOverride()` call inside isPremium()). Enable with ?apmDevPremium=1 in the URL or
     * localStorage.apmDevPremium = '1'. The panel shows a banner while it is active. */
    function devPremiumOverride() {
        try {
            if (root.location && /[?&]apmDevPremium=1\b/.test(root.location.search)) return true;
            return !!root.localStorage && root.localStorage.getItem('apmDevPremium') === '1';
        } catch (e) { return false; }
    }
    /* DEV-OVERRIDE-END */

    function isPremium() {
        if (devPremiumOverride()) return true;          // DEV-OVERRIDE (remove before release)
        try { return typeof root._dlIsPremium === 'function' ? !!root._dlIsPremium() : false; }
        catch (e) { return false; }
    }

    function getMap() { return root._dlMap || root.map || null; }

    function h(tag, attrs, children) {
        var node = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) {
            var v = attrs[k];
            if (v === false || v == null) return;
            if (k === 'text') node.textContent = v;
            else if (k === 'key') bind(node, v, 'text');
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

    /** Register a node whose text follows a translation key (updated on language change). */
    function bind(node, key, attr, vars) {
        i18nBindings.push({ el: node, key: key, attr: attr || 'text', vars: vars || null });
        applyBinding(i18nBindings[i18nBindings.length - 1]);
        return node;
    }
    function applyBinding(b) {
        var s = T(b.key, b.vars);
        if (b.attr === 'text') b.el.textContent = s;
        else b.el.setAttribute(b.attr, s);
    }
    function refreshI18n() {
        i18nBindings.forEach(applyBinding);
        renderPoint();
        renderModeTabs();
        renderLegend();
        if (state.result) renderResult(state.result);
        renderPeriods();
        updateGate();
    }

    function fmtKm2(v) { return (Math.round(v * 100) / 100).toLocaleString(lang() === 'ro' ? 'ro-RO' : 'en-GB', { maximumFractionDigits: 2 }) + ' km²'; }
    function fmtNum(v, d) { return v == null || !isFinite(v) ? '—' : Number(v).toFixed(d == null ? 2 : d); }

    function setStatus(text, kind) {
        if (!els.status) return;
        els.status.textContent = text || '';
        els.status.className = 'apm-status' + (kind ? ' apm-status-' + kind : '');
    }

    function setProgress(text, pct) {
        els.progress.hidden = false;
        els.progressBar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
        setStatus(text, 'busy');
    }

    /* ── gate and switch ─────────────────────────────────────────────────── */

    /** Single source for the on/off state and the premium gate. */
    function isRunnable() { return state.enabled && isPremium(); }

    function setEnabled(on) {
        state.enabled = !!on;
        try { root.localStorage.setItem(SWITCH_KEY, on ? 'on' : 'off'); } catch (e) { /* ignore */ }
        if (!on) { stopPick(); cancelRun(); clearResult(); }
        renderSwitch();
        updateGate();
    }

    function renderSwitch() {
        if (!els.switch) return;
        els.switch.setAttribute('aria-checked', String(state.enabled));
        els.switchText.textContent = state.enabled ? T('switch.on') : T('switch.off');
        if (ui.btn) ui.btn.classList.toggle('apm-fab-off', !state.enabled);
    }

    function fabSub() {
        if (!isPremium()) return T('btn.sub.locked');
        return state.enabled ? T('btn.sub.on') : T('btn.sub.off');
    }

    function updateGate() {
        var premium = isPremium();
        var on = state.enabled;
        els.gate.hidden = premium && on;
        if (els.devBanner) els.devBanner.hidden = !devPremiumOverride();   // DEV-OVERRIDE (remove before release)
        els.gate.textContent = !premium ? T('gate.premium') : T('gate.off');
        var canRunNow = premium && on && !state.busy;
        var trainBlocked = state.mode === 'train' && (!state.records || (state.siteCount != null && state.siteCount < 10));
        els.run.disabled = !canRunNow || !state.centre || trainBlocked;
        els.run.textContent = state.mode === 'train' ? T('run.train') : T('run.manual');
        els.pickBtn.disabled = !premium || !on || state.busy;
        els.controls.classList.toggle('apm-disabled', !(premium && on));
        if (ui.btn) {
            ui.btn.setAttribute('aria-expanded', String(!ui.panel.hidden));
            var sub = ui.btn.querySelector('.apm-fab-sub');
            if (sub) sub.textContent = fabSub();
        }
    }

    /* ── point selection on the map ──────────────────────────────────────── */

    function onMapPick(e) {
        if (!state.picking) return;
        if (e && e.originalEvent && e.originalEvent.target && e.originalEvent.target.closest &&
            e.originalEvent.target.closest('.apm-panel, .apm-fab')) return;     // clicks on the panel never pick
        stopPick();
        state.centre = { lat: e.latlng.lat, lon: e.latlng.lng };
        onCentreChanged();
    }

    function startPick() {
        map = getMap();
        if (!map) { setStatus(T('status.noMap'), 'error'); return; }
        state.picking = true;
        map.on('click', onMapPick);
        if (map.getContainer) map.getContainer().style.cursor = 'crosshair';
        renderPickButton();
    }

    function stopPick() {
        if (!state.picking) return;
        state.picking = false;
        var m = getMap();
        if (m) { m.off('click', onMapPick); if (m.getContainer) m.getContainer().style.cursor = ''; }
        renderPickButton();
    }

    function renderPickButton() {
        els.pickBtn.textContent = state.picking ? T('point.pickActive') : T('point.pick');
        els.pickBtn.setAttribute('aria-pressed', String(state.picking));
    }

    function renderPoint() {
        if (!els.pointText) return;
        els.pointText.textContent = state.centre
            ? T('point.at', { lat: state.centre.lat.toFixed(5), lon: state.centre.lon.toFixed(5) })
            : T('point.none');
        renderPickButton();
    }

    function drawCentre() {
        var m = getMap();
        if (!m || !state.centre || !root.L) return;
        if (centreMarker) m.removeLayer(centreMarker);
        if (radiusCircle) m.removeLayer(radiusCircle);
        var ll = [state.centre.lat, state.centre.lon];
        var r = state.mode === 'train' ? TRAIN_AREA_KM * 1000 : state.radiusKm * 1000;
        centreMarker = root.L.circleMarker(ll, { radius: 5, color: '#ffffff', weight: 2, fillColor: '#89cff0', fillOpacity: 1, interactive: false }).addTo(m);
        radiusCircle = root.L.circle(ll, { radius: r, color: '#89cff0', weight: 2, fill: false, dashArray: '6 6', interactive: false }).addTo(m);
    }

    function clearCentre() {
        var m = getMap();
        if (m && centreMarker) m.removeLayer(centreMarker);
        if (m && radiusCircle) m.removeLayer(radiusCircle);
        centreMarker = radiusCircle = null;
    }

    function onCentreChanged() {
        renderPoint();
        drawCentre();
        if (state.mode === 'train' && state.records) loadPeriods();
        updateGate();
    }

    /* ── MANUAL parameters ───────────────────────────────────────────────── */

    function readRadius() {
        var v = parseFloat(els.radius.value);
        return core().validateRadiusKm(v);        // throws a readable error outside 1–10 km
    }

    /** Curves from the editor. Throws with a readable message when any curve is invalid. */
    function readCurves() {
        var C = core();
        var raw = { slope: null, altitude: null, aspectDeviation: null, soil: null, water: {} };
        var errors = [];
        ['slope', 'altitude', 'aspectDeviation', 'soil'].forEach(function (name) {
            var p = C.parseCurveText(state.curveText[name]);
            if (p.errors.length) errors.push(name + ': ' + p.errors.map(tm).join('; '));
            raw[name] = p.points;
        });
        C.WATER_CLASSES.forEach(function (cls) {
            var p = C.parseCurveText(state.curveText['water_' + cls]);
            if (p.errors.length) errors.push('water ' + cls + ': ' + p.errors.map(tm).join('; '));
            raw.water[cls] = p.points;
        });
        if (errors.length) throw new Error(errors.join(' | '));
        var checked = C.validateCurves(raw);
        var parts = [];
        Object.keys(checked.errors).forEach(function (k) { parts.push(k + ': ' + checked.errors[k].map(tm).join('; ')); });
        if (parts.length) throw new Error(parts.join(' | '));
        return checked.curves;
    }

    function readManualParams() {
        if (!getMap()) throw new Error(T('status.noMap'));
        if (!state.centre) throw new Error(T('status.noPoint'));
        var radiusKm = readRadius();
        var wRelief = parseFloat(els.wRelief.value), wWater = parseFloat(els.wWater.value), wSoil = parseFloat(els.wSoil.value);
        [wRelief, wWater, wSoil].forEach(function (w) { if (!(isFinite(w) && w >= 0)) throw new Error(T('status.noWeights')); });
        if (wRelief + wWater + wSoil <= 0) throw new Error(T('status.noWeights'));
        var classes = core().WATER_CLASSES.filter(function (c) { return els.water[c].checked; });
        var thresholds = core().validateManualThresholds({
            medium: parseFloat(els.tMed.value) / 100, high: parseFloat(els.tHigh.value) / 100, veryhigh: parseFloat(els.tVery.value) / 100
        });
        var minArea = parseFloat(els.minArea.value);
        if (!(minArea >= 0)) throw core().keyedError('err.minArea', {}, 'Minimum polygon area must be zero or positive.');
        return {
            centre: state.centre,
            radiusKm: radiusKm,
            smoothDem: !!els.smooth.checked,
            includeDrainage: !!els.drainage.checked,
            strahlerMap: readStrahlerMap(),
            curves: readCurves(),
            weights: { relief: wRelief, water: wWater, soil: wSoil },
            minSlopeDeg: parseFloat(els.minSlope.value),
            waterClasses: classes,
            thresholds: thresholds,
            minAreaM2: minArea,
            workerUrl: WORKER_URL,
            token: state.token
        };
    }

    /** Strahler → size class map from the advanced panel. Throws a keyed error when invalid. */
    function readStrahlerMap() {
        var out = { small: [], medium: [], large: [] }, seen = {}, ok = true;
        core().WATER_CLASSES.forEach(function (c) {
            if (!out[c]) return;
            var raw = String(els.strahler[c].value || '').split(',');
            raw.forEach(function (t) {
                t = t.trim();
                if (!t) return;
                var n = Number(t);
                if (!(/^\d+$/.test(t) && n >= 1 && n <= 20)) { ok = false; return; }
                if (seen[n]) { ok = false; return; }
                seen[n] = true;
                out[c].push(n);
            });
        });
        if (!ok) throw core().keyedError('err.strahler', {}, 'Strahler orders must be whole numbers from 1 to 20, each in at most one class.');
        return out;
    }

    /* ── TRAIN: CSV and periods ──────────────────────────────────────────── */

    /** Site count for the chosen centre and period, with the warning / block thresholds (TRAIN). */
    function renderSiteCount() {
        if (!els.countNote) return;
        if (!state.records || !state.centre) { els.countNote.textContent = ''; els.countNote.className = 'apm-note'; state.siteCount = null; return; }
        var pool = sites().filterSites(state.records, { center: state.centre, radiusKm: 50, period: state.period });
        var n = pool.sites.length;
        state.siteCount = n;
        var st = pipe().trainSiteStatus(n, 10, 30);
        var cls = 'apm-note', text;
        if (n === 0) { text = T('train.noSites'); cls = 'apm-note apm-count-block'; }
        else if (st.status === 'block') { text = T('train.countBlock', { n: n, min: st.min }); cls = 'apm-note apm-count-block'; }
        else if (st.status === 'warn') { text = T('train.countWarn', { n: n, rec: st.rec }); cls = 'apm-note apm-count-warn'; }
        else { text = T('train.countOk', { n: n }); cls = 'apm-note apm-count-ok'; }
        els.countNote.textContent = text;
        els.countNote.className = cls;
    }

    function onCsvChosen(ev) {
        var file = ev.target.files && ev.target.files[0];
        if (!file) return;
        state.csvName = file.name;
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var parsed = sites().parseSitesCsv(String(reader.result || ''), file.name);
                state.records = parsed.records;
                els.csvName.textContent = file.name;
                els.csvCount.textContent = T('train.loaded', { n: parsed.records.length });
                setStatus('', '');
                if (state.centre) loadPeriods();
                updateGate();
            } catch (e) {
                state.records = null;
                state.periods = [];
                renderPeriods();
                setStatus(T('train.csvError', { msg: errText(e) }), 'error');
                updateGate();
            }
        };
        reader.onerror = function () { setStatus(T('train.csvError', { msg: reader.error && reader.error.message }), 'error'); };
        reader.readAsText(file);
    }

    function loadPeriods() {
        if (!state.records || !state.centre) { state.periods = []; renderPeriods(); return; }
        var pool = pipe().sitePool(state.records, state.centre);
        state.periods = pool.periods;
        if (state.period) {
            var keep = state.periods.some(function (g) { return g.start === state.period.start && g.end === state.period.end && !g.undated; });
            if (!keep) state.period = null;
        }
        renderPeriods();
        renderSiteCount();
    }

    function renderPeriods() {
        if (!els.period) return;
        els.period.textContent = '';
        els.period.appendChild(h('option', { value: 'all', text: T('train.allPeriods') }));
        state.periods.forEach(function (g, i) {
            var usable = !g.undated && g.start != null && g.end != null;
            var label = g.label + ' (' + g.count + ')' + (usable ? '' : ' — ' + T('train.undated'));
            els.period.appendChild(h('option', { value: String(i), disabled: !usable, text: label }));
        });
        var sel = 'all';
        if (state.period) {
            var idx = state.periods.findIndex(function (g) { return g.start === state.period.start && g.end === state.period.end; });
            if (idx >= 0) sel = String(idx);
        }
        els.period.value = sel;
        els.periodRow.hidden = !state.records;
        els.csvCount.textContent = state.records ? T('train.loaded', { n: state.records.length }) : '';
    }

    function onPeriodChanged() {
        var v = els.period.value;
        if (v === 'all') state.period = null;
        else {
            var g = state.periods[Number(v)];
            state.period = g ? { start: g.start, end: g.end } : null;
        }
        renderSiteCount();
    }

    /* ── run / cancel ────────────────────────────────────────────────────── */

    function run() {
        if (!isRunnable()) { updateGate(); return; }
        var mode = state.mode;
        var params;
        try {
            if (mode === 'train') {
                if (!state.centre) throw new Error(T('status.noPoint'));
                if (!state.records) throw new Error(T('train.noPoint'));
                if (state.siteCount != null && state.siteCount < 10) throw new Error(T('train.countBlock', { n: state.siteCount, min: 10 }));
                params = {
                    centre: state.centre,
                    records: state.records,
                    period: state.period,
                    radiusKm: TRAIN_AREA_KM,
                    minSlopeDeg: parseFloat(els.minSlope.value),
                    smoothDem: !!els.smooth.checked,
                    includeDrainage: !!els.drainage.checked,
                    strahlerMap: readStrahlerMap(),
                    waterClasses: core().WATER_CLASSES.filter(function (c) { return els.water[c].checked; }),
                    workerUrl: WORKER_URL
                };
            } else {
                params = readManualParams();
            }
        } catch (e) {
            setStatus(errText(e), 'error');
            return;
        }

        state.token = { cancelled: false };
        params.token = state.token;
        state.busy = true;
        setBusyUi(true);
        setProgress(T('status.starting'), 2);
        params.onProgress = function (key, pct, vars) {
            if (state.token && !state.token.cancelled) setProgress(T(key, vars), pct);
        };
        var session = mode === 'train' ? state.trainSession : state.manualSession;
        var job = mode === 'train' ? pipe().runTrain(session, params) : pipe().runManual(session, params);

        job.then(function (res) {
            if (!state.token || state.token.cancelled) return;
            state.result = res;
            drawResult(res);
            setStatus((res.warnings && res.warnings.length) ? T('status.doneWarn') : T('status.done'), 'ok');
        }).catch(function (err) {
            if (pipe().isCancelled(err)) { setStatus(T('status.cancelled')); return; }
            setStatus(T('status.error', { msg: errText(err) }), 'error');
        }).then(function () {
            state.token = null;
            state.busy = false;
            setBusyUi(false);
            updateGate();
        });
    }

    function cancelRun() {
        if (state.token) state.token.cancelled = true;
        [state.manualSession, state.trainSession].forEach(function (s) {
            if (s.worker) { s.worker.terminate(); s.worker = null; s.analysisKey = null; }
        });
        if (state.busy) { state.busy = false; setBusyUi(false); setStatus(T('status.cancelled')); }
    }

    function setBusyUi(busy) {
        els.cancel.hidden = !busy;
        if (!busy) els.progress.hidden = true;
        updateGate();
    }

    /* ── rendering results and legend ────────────────────────────────────── */

    function clearResult() {
        var m = getMap();
        if (layer && m) m.removeLayer(layer);
        layer = null;
        state.result = null;
        els.results.hidden = true;
        els.exportBtn.disabled = true;
        els.clearBtn.disabled = true;
        renderLegend();
    }

    function drawResult(res) {
        var m = getMap();
        if (layer && m) m.removeLayer(layer);
        var classById = {};
        core().CLASSES.forEach(function (c) { classById[c.id] = c; });
        layer = root.L.geoJSON(res.geojson, {
            interactive: true,
            style: function (f) { return { color: f.properties.colour, weight: 1, fillColor: f.properties.colour, fillOpacity: 0.45 }; },
            onEachFeature: function (f, l) {
                var p = f.properties;
                var cls = p.class && classById[p.class];
                var title = cls ? T('cls.' + p.class) : (p.label || p.class);
                var area = p.areaM2 != null ? T('result.area', { v: fmtKm2(p.areaM2 / 1e6) }) : '';
                l.bindPopup(h('div', { class: 'apm-popup' }, [h('strong', { text: title }), h('div', { text: area })]));
            }
        });
        if (m && layer.addTo) layer.addTo(m);
        renderLegend();
        renderResult(res);
        els.exportBtn.disabled = false;
        els.clearBtn.disabled = false;
    }

    function renderLegend() {
        var m = getMap();
        if (!legendEl) {
            legendEl = h('div', { class: 'apm-legend' });
        }
        legendEl.textContent = '';
        legendEl.appendChild(h('div', { class: 'apm-legend-title', text: T('result.legend') }));
        core().CLASSES.forEach(function (c) {
            legendEl.appendChild(h('div', { class: 'apm-legend-row' }, [
                h('span', { class: 'apm-swatch', style: 'background:' + c.colour }),
                h('span', { text: T('cls.' + c.id) })
            ]));
        });
        // The map legend is shown only while a result is on the map.
        if (m && root.L && root.L.control && state.result) {
            if (!legendControl) {
                legendControl = root.L.control({ position: 'bottomright' });
                legendControl.onAdd = function () { return legendEl; };
                legendControl.addTo(m);
            }
        } else if (m && legendControl) {
            legendControl.remove();
            legendControl = null;
        }
    }

    function renderResult(res) {
        var C = core();
        els.resultRows.textContent = '';
        C.CLASSES.forEach(function (c) {
            var v = res.areaKm2 ? res.areaKm2[c.id] : 0;
            els.resultRows.appendChild(h('div', { class: 'apm-row' }, [
                h('span', { class: 'apm-swatch', style: 'background:' + c.colour }),
                h('span', { class: 'apm-row-label', text: T('cls.' + c.id) }),
                h('span', { class: 'apm-row-value', text: fmtKm2(v || 0) })
            ]));
        });
        var prov = res.provenance || {};
        var parts = [];
        if (prov.dem) parts.push(T('result.dem') + ': ' + prov.dem.label + ' · ' + prov.dem.cellM + ' m' +
            (prov.dem.version ? ' · v' + prov.dem.version : '') + (prov.dem.tier === 'fallback' ? ' · ' + T('result.fallback') : ''));
        parts.push(T('result.water') + ': ' + (prov.water ? prov.water.label : T('result.waterNone')));
        parts.push(T('result.mode') + ': ' + (res.mode === 'train' ? T('mode.train') : T('mode.manual')));
        els.provenance.textContent = parts.join(' · ');

        els.warnings.textContent = '';
        (res.warnings || []).forEach(function (w) { els.warnings.appendChild(h('li', { text: tm(w) })); });
        els.warnings.hidden = !(res.warnings && res.warnings.length);

        els.diag.textContent = '';
        if (res.mode === 'train' && res.diagnostics) {
            var d = res.diagnostics;
            var weights = d.weights ? Object.keys(d.weights).map(function (k) { return k + ' ' + fmtNum(d.weights[k], 2); }).join(', ') : T('result.none');
            var excluded = (d.excluded && d.excluded.length)
                ? d.excluded.map(function (e) { return e.variable + ' (' + e.reason + ')'; }).join('; ') : T('result.none');
            var rows = [
                [T('result.sites'), String(d.sitesUsed)],
                [T('result.auc'), fmtNum(d.cv && d.cv.auc, 2)],
                [T('result.kvamme'), fmtNum(d.cv && d.cv.kvamme75, 2)],
                [T('result.confidence'), String(d.confidence || '—')],
                [T('result.weights'), weights],
                [T('result.excluded'), excluded]
            ];
            els.diag.appendChild(h('h4', { text: T('result.diag') }));
            rows.forEach(function (r) {
                els.diag.appendChild(h('div', { class: 'apm-row apm-row-diag' }, [
                    h('span', { class: 'apm-row-label', text: r[0] }),
                    h('span', { class: 'apm-row-value', text: r[1] })
                ]));
            });
        }
        els.results.hidden = false;
    }

    function exportGeoJson() {
        if (!state.result) return;
        var res = state.result;
        var fc = JSON.parse(JSON.stringify(res.geojson));
        fc.metadata = {
            tool: 'DetectLab Next-Gen APM',
            mode: res.mode || state.mode,
            generated: new Date().toISOString(),
            centre: state.centre,
            radiusKm: state.mode === 'train' ? TRAIN_AREA_KM : state.radiusKm,
            provenance: res.provenance,
            warnings: res.warnings,
            diagnostics: res.diagnostics || null
        };
        downloadBlob(JSON.stringify(fc), 'application/geo+json',
            'apm-' + (res.mode || 'manual') + '-' + new Date().toISOString().slice(0, 10) + '.geojson');
    }

    function downloadBlob(text, type, name) {
        var blob = new Blob([text], { type: type });
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: name });
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    /* ── debug log ───────────────────────────────────────────────────────── */

    function setDebugMode(on) {
        prov().setDebug(on);
        try {
            if (on) root.localStorage.setItem(DEBUG_KEY, '1');
            else root.localStorage.removeItem(DEBUG_KEY);
        } catch (e) { /* ignore */ }
        renderDebugLog();
    }

    function debugRow(rec) {
        if (rec.kind === 'step') {
            var why = rec.reason ? ' — ' + tm(rec.reason) : '';
            return h('div', { class: 'apm-debug-row' + (rec.outcome === 'failed' ? ' apm-debug-bad' : '') }, [
                h('span', { class: 'apm-debug-code', text: String(rec.step).toUpperCase() }),
                h('span', { class: 'apm-debug-ms', text: rec.ms != null ? rec.ms + ' ms' : '' }),
                h('span', { class: 'apm-debug-url', text: rec.label + ' → ' + rec.outcome + why, title: rec.endpoint || '' })
            ]);
        }
        if (rec.kind === 'caps') {
            return h('div', { class: 'apm-debug-row' }, [
                h('span', { class: 'apm-debug-code', text: 'CAPS' }),
                h('span', { class: 'apm-debug-url', text: (rec.endpoint || '') + ' · ' + (rec.coverageId || (rec.layers || []).length + ' layers'), title: rec.endpoint || '' })
            ]);
        }
        var bad = rec.status == null || rec.status >= 400;
        var extra = [rec.contentType, rec.bytes != null ? rec.bytes + ' B' : null, rec.step, rec.reason ? tm(rec.reason) : null].filter(Boolean).join(' · ');
        return h('div', { class: 'apm-debug-row' + (bad ? ' apm-debug-bad' : '') }, [
            h('span', { class: 'apm-debug-code', text: rec.status != null ? String(rec.status) : 'ERR' }),
            h('span', { class: 'apm-debug-ms', text: rec.ms + ' ms' }),
            h('span', { class: 'apm-debug-url', text: rec.method + ' ' + rec.url + (rec.proxied ? ' (proxy)' : ''), title: rec.url }),
            extra ? h('span', { class: 'apm-debug-hint', text: extra }) : null
        ]);
    }

    /** Settings snapshot for the diagnostics export. Never throws. */
    function collectSettings() {
        function num(el) { return el ? Number(el.value) : null; }
        function chk(el) { return el ? !!el.checked : null; }
        var out = { mode: state.mode, radiusKm: state.radiusKm, period: state.period, smoothDem: chk(els.smooth),
            includeDrainage: chk(els.drainage), waterClasses: null, weights: null, minSlopeDeg: num(els.minSlope),
            minAreaM2: num(els.minArea), thresholdsPct: null, strahlerMap: null,
            demProxyEnabled: prov().CONFIG.proxy.enabled, debugMode: prov().isDebug(), devPremiumOverride: devPremiumOverride() };
        try { out.waterClasses = core().WATER_CLASSES.filter(function (c) { return els.water[c].checked; }); } catch (e) { /* ignore */ }
        try { out.weights = { relief: num(els.wRelief), water: num(els.wWater), soil: num(els.wSoil) }; } catch (e) { /* ignore */ }
        try { out.thresholdsPct = { medium: num(els.tMed), high: num(els.tHigh), veryhigh: num(els.tVery) }; } catch (e) { /* ignore */ }
        try { out.strahlerMap = readStrahlerMap(); } catch (e) { out.strahlerMap = 'invalid: ' + errText(e); }
        return out;
    }

    /** Diagnostics bundle: request/step log, app version, user agent, point, radius and settings. */
    function diagnosticsBundle() {
        var res = state.result || null;
        return {
            generated: new Date().toISOString(),
            appVersion: prov().APP_VERSION,
            userAgent: root.navigator ? root.navigator.userAgent : null,
            page: root.location ? root.location.pathname : null,
            point: state.centre,
            radiusKm: state.mode === 'train' ? TRAIN_AREA_KM : state.radiusKm,
            settings: collectSettings(),
            lastResult: res ? { mode: res.mode, provenance: res.provenance, warnings: res.warnings } : null,
            log: prov().getDebugLog()
        };
    }

    function renderDebugLog() {
        if (!els.debugList) return;
        var log = prov().getDebugLog();
        els.debugList.textContent = '';
        if (!log.length) els.debugList.appendChild(h('div', { class: 'apm-note', text: T('debug.empty') }));
        log.slice(-100).forEach(function (rec) { els.debugList.appendChild(debugRow(rec)); });
    }

    /* ── panel construction ──────────────────────────────────────────────── */

    function slider(key, min, max, step, value) {
        var input = h('input', { type: 'range', min: min, max: max, step: step, value: value });
        var out = h('output', { text: String(value) });
        input.addEventListener('input', function () { out.textContent = input.value; });
        var label = h('span', { key: key });
        return { row: h('label', { class: 'apm-field' }, [label, input, out]), input: input };
    }

    function numberField(key, value, opts) {
        var input = h('input', Object.assign({ type: 'number', value: value }, opts || {}));
        return { row: h('label', { class: 'apm-field' }, [h('span', { key: key }), input]), input: input };
    }

    function checkbox(key, checked) {
        var cb = h('input', { type: 'checkbox' });
        cb.checked = !!checked;
        return { cb: cb, row: h('label', { class: 'apm-check' }, [cb, h('span', { key: key })]) };
    }

    function defaultCurveText(name) {
        var C = core().DEFAULT_CURVES;
        var pts = name.indexOf('water_') === 0 ? C.water[name.slice(6)] : C[name];
        return pts.map(function (p) { return p[0] + ', ' + p[1]; }).join('\n');
    }

    function buildPanel() {
        var C = core();
        state.curveText = {};
        ['slope', 'altitude', 'aspectDeviation', 'soil'].concat(C.WATER_CLASSES.map(function (c) { return 'water_' + c; }))
            .forEach(function (n) { state.curveText[n] = defaultCurveText(n); });

        // Mode tabs
        var tabManual = h('button', { type: 'button', class: 'apm-tab', 'aria-pressed': 'true', onclick: function () { setMode('manual'); } });
        var tabTrain = h('button', { type: 'button', class: 'apm-tab', 'aria-pressed': 'false', onclick: function () { setMode('train'); } });
        bind(tabManual, 'mode.manual'); bind(tabTrain, 'mode.train');
        els.tabManual = tabManual; els.tabTrain = tabTrain;

        // On / off switch and premium gate
        els.switchText = h('span', { class: 'apm-switch-text' });
        els.switch = h('button', {
            type: 'button', role: 'switch', class: 'apm-switch', 'aria-checked': 'false',
            onclick: function () { setEnabled(!state.enabled); }
        }, [h('span', { class: 'apm-switch-knob' }), els.switchText]);
        els.gate = h('div', { class: 'apm-gate', role: 'note' });

        // Search point and radius
        els.pickBtn = h('button', { type: 'button', class: 'apm-btn apm-wide', onclick: function () { state.picking ? stopPick() : startPick(); } });
        els.pointText = h('div', { class: 'apm-point' });
        var radius = numberField('radius.label', state.radiusKm, { min: 1, max: 10, step: 0.5 });
        els.radius = radius.input;
        radius.input.addEventListener('change', function () {
            try { state.radiusKm = readRadius(); drawCentre(); } catch (e) { /* run() reports the error */ }
        });
        els.radiusRow = radius.row;
        els.trainNote = h('div', { class: 'apm-note', key: 'train.area' });

        // Weights
        var wRel = slider('weights.relief', 0, 1, 0.05, 0.6);
        var wWat = slider('weights.water', 0, 1, 0.05, 0.4);
        var wSoil = slider('weights.soil', 0, 1, 0.05, 0);
        els.wRelief = wRel.input; els.wWater = wWat.input; els.wSoil = wSoil.input;

        // Water classes and smoothing
        els.water = {};
        var waterRows = C.WATER_CLASSES.map(function (c) {
            var cb = checkbox('water.' + c, c !== 'artificial');
            els.water[c] = cb.cb;
            return cb.row;
        });
        var waterGroup = h('fieldset', { class: 'apm-group' }, [h('legend', { key: 'water.title' }), h('div', { class: 'apm-checks' }, waterRows)]);
        // EU-Hydro Drainage Network: advanced, off by default (modelled, not a mapped river)
        var drain = checkbox('water.drainage', false);
        els.drainage = drain.cb;
        var drainBox = h('div', { class: 'apm-drain' }, [drain.row, h('div', { class: 'apm-note', key: 'water.drainageNote' })]);
        var strahlerDefaults = prov().defaultStrahlerMap();
        els.strahler = {};
        var strahlerRows = core().WATER_CLASSES.filter(function (c) { return strahlerDefaults[c]; }).map(function (c) {
            var input = h('input', { type: 'text', class: 'apm-strahler-input', value: strahlerDefaults[c].join(', '), spellcheck: 'false' });
            els.strahler[c] = input;
            return h('label', { class: 'apm-field' }, [h('span', { key: 'water.' + c }), input]);
        });
        var strahlerBox = h('div', { class: 'apm-strahler' }, [h('span', { class: 'apm-note', key: 'water.strahler' })]
            .concat(strahlerRows, [h('div', { class: 'apm-note', key: 'water.strahlerNote' })]));
        var waterAdv = h('details', { class: 'apm-group' }, [h('summary', { key: 'water.advanced' }), drainBox, strahlerBox]);
        waterGroup.appendChild(waterAdv);
        var smooth = checkbox('smooth.label', false);
        els.smooth = smooth.cb;

        // Advanced
        var minSlope = numberField('adv.minSlope', 0.5, { min: 0, max: 20, step: 0.5 });
        var minArea = numberField('adv.minArea', 2500, { min: 0, step: 500 });
        var tMed = numberField('adv.tMed', 55, { min: 0, max: 99, step: 1 });
        var tHigh = numberField('adv.tHigh', 70, { min: 1, max: 99, step: 1 });
        var tVery = numberField('adv.tVery', 85, { min: 1, max: 100, step: 1 });
        els.minSlope = minSlope.input; els.minArea = minArea.input;
        els.tMed = tMed.input; els.tHigh = tHigh.input; els.tVery = tVery.input;

        // Curves (editable text, one "x, y" per line)
        var curveBlocks = Object.keys(state.curveText).map(function (name) {
            var ta = h('textarea', { class: 'apm-curve', rows: 4, spellcheck: 'false', 'data-curve': name });
            ta.value = state.curveText[name];
            ta.addEventListener('input', function () { state.curveText[name] = ta.value; });
            els['curve_' + name] = ta;
            var reset = h('button', { type: 'button', class: 'apm-btn apm-small', onclick: function () {
                state.curveText[name] = defaultCurveText(name); ta.value = state.curveText[name];
            } });
            bind(reset, 'curves.reset');
            return h('div', { class: 'apm-curve-block' }, [
                h('div', { class: 'apm-curve-head' }, [h('strong', { key: 'curves.' + name }), reset]),
                ta
            ]);
        });
        els.curveNote = h('div', { class: 'apm-note', key: 'curves.trainNote' });
        els.curvesBox = h('div', { class: 'apm-curves' }, [h('div', { class: 'apm-note', key: 'curves.help' })].concat(curveBlocks, [els.curveNote]));

        // TRAIN inputs
        els.csvInput = h('input', { type: 'file', accept: '.csv,text/csv', class: 'apm-file', onchange: onCsvChosen });
        els.csvName = h('span', { class: 'apm-note' });
        els.csvCount = h('span', { class: 'apm-note' });
        els.period = h('select', { class: 'apm-select', onchange: function () { onPeriodChanged(); updateGate(); } });
        els.periodRow = h('label', { class: 'apm-field' }, [h('span', { key: 'train.period' }), els.period]);
        els.periodRow.hidden = true;
        els.countNote = h('div', { class: 'apm-note', role: 'status' });
        els.trainBox = h('div', { class: 'apm-train' }, [
            h('div', { class: 'apm-file-row' }, [bind(h('span', { class: 'apm-btn apm-small apm-file-btn' }), 'train.chooseFile'), els.csvInput]),
            els.csvName, els.csvCount, els.periodRow, els.countNote,
            h('div', { class: 'apm-note', key: 'train.area' })
        ]);

        // Actions and status
        els.run = h('button', { type: 'button', class: 'apm-btn apm-primary', onclick: run });
        els.cancel = h('button', { type: 'button', class: 'apm-btn', hidden: true, onclick: cancelRun });
        bind(els.cancel, 'run.cancel');
        els.exportBtn = h('button', { type: 'button', class: 'apm-btn', disabled: true, onclick: exportGeoJson });
        bind(els.exportBtn, 'run.export');
        els.clearBtn = h('button', { type: 'button', class: 'apm-btn', disabled: true, onclick: clearResult });
        bind(els.clearBtn, 'run.clear');
        els.progressBar = h('div', { class: 'apm-progress-bar' });
        els.progress = h('div', { class: 'apm-progress', hidden: true }, [els.progressBar]);
        els.status = h('div', { class: 'apm-status', role: 'status', 'aria-live': 'polite' });

        // Results
        els.resultRows = h('div', { class: 'apm-rows' });
        els.provenance = h('div', { class: 'apm-provenance' });
        els.warnings = h('ul', { class: 'apm-warnings', hidden: true });
        els.diag = h('div', { class: 'apm-diag' });
        els.results = h('div', { class: 'apm-results', hidden: true }, [
            h('h4', { key: 'result.title' }), els.resultRows, els.provenance, els.warnings, els.diag
        ]);

        // Debug
        els.debugCb = h('input', { type: 'checkbox' });
        els.debugCb.checked = prov().isDebug();
        els.debugCb.addEventListener('change', function () { setDebugMode(els.debugCb.checked); });
        els.debugList = h('div', { class: 'apm-debug-list' });
        var dlBtn = h('button', { type: 'button', class: 'apm-btn apm-small', onclick: function () {
            downloadBlob(JSON.stringify(diagnosticsBundle(), null, 2),
                'application/json', 'apm-diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
        } });
        bind(dlBtn, 'diag.download');
        var clBtn = h('button', { type: 'button', class: 'apm-btn apm-small', onclick: function () { prov().clearDebugLog(); renderDebugLog(); } });
        bind(clBtn, 'debug.clear');
        prov().onDebug(function () { renderDebugLog(); });

        var close = h('button', { type: 'button', class: 'apm-close', onclick: function () { togglePanel(false); } });
        close.setAttribute('aria-label', 'Close');
        bind(close, 'panel.close', 'aria-label');
        bind(close, 'panel.close', 'title');
        close.textContent = '✕';

        var manualOnly = h('div', { class: 'apm-manual-only' }, [
            h('fieldset', { class: 'apm-group' }, [h('legend', { key: 'weights.title' }), wRel.row, wWat.row, wSoil.row]),
            h('details', { class: 'apm-group' }, [h('summary', { key: 'adv.title' }), minSlope.row, tMed.row, tHigh.row, tVery.row, minArea.row]),
            h('details', { class: 'apm-group' }, [h('summary', { key: 'curves.title' }), els.curvesBox])
        ]);
        var trainOnly = h('div', { class: 'apm-train-only' }, [
            h('fieldset', { class: 'apm-group' }, [h('legend', { key: 'train.csvTitle' }), els.trainBox])
        ]);
        els.manualOnly = manualOnly; els.trainOnly = trainOnly;

        els.controls = h('div', { class: 'apm-controls' }, [
            h('div', { class: 'apm-group' }, [
                h('div', { class: 'apm-group-title', key: 'mode.label' }),
                h('div', { class: 'apm-tabs' }, [tabManual, tabTrain]),
                els.introManual = h('p', { class: 'apm-intro', key: 'intro.manual' }),
                els.introTrain = h('p', { class: 'apm-intro', key: 'intro.train' })
            ]),
            h('div', { class: 'apm-group' }, [
                h('div', { class: 'apm-group-title', key: 'point.title' }),
                els.pickBtn, els.pointText, els.radiusRow, els.trainNote
            ]),
            manualOnly, trainOnly, waterGroup,
            h('div', { class: 'apm-group' }, [
                h('label', { class: 'apm-check' }, [smooth.cb, h('span', { key: 'smooth.label' })])
            ])
        ]);

        var debugBox = h('details', { class: 'apm-group' }, [
            h('summary', { key: 'debug.title' }),
            h('label', { class: 'apm-check' }, [els.debugCb, h('span', { key: 'debug.mode' })]),
            h('div', { class: 'apm-actions' }, [dlBtn, clBtn]),
            els.debugList
        ]);

        els.devBanner = h('div', { class: 'apm-dev-banner', hidden: true });   // DEV-OVERRIDE (remove before release)
        bind(els.devBanner, 'dev.banner');
        var panel = h('section', { class: 'apm-panel', id: 'apmNextPanel', hidden: true, 'aria-label': 'Next-Gen APM' }, [
            h('header', { class: 'apm-head' }, [
                h('h3', { key: 'panel.title' }),
                h('div', { class: 'apm-head-right' }, [els.switch, close])
            ]),
            els.devBanner,
            els.gate,
            els.controls,
            h('div', { class: 'apm-actions' }, [els.run, els.cancel, els.exportBtn, els.clearBtn]),
            els.progress,
            els.status,
            els.results,
            debugBox
        ]);

        renderSwitch();
        renderPeriods();
        renderModeTabs();
        renderPoint();
        renderLegend();
        return panel;
    }

    function renderModeTabs() {
        if (!els.tabManual) return;
        var manual = state.mode === 'manual';
        els.tabManual.setAttribute('aria-pressed', String(manual));
        els.tabTrain.setAttribute('aria-pressed', String(!manual));
        els.manualOnly.hidden = !manual;
        els.trainOnly.hidden = manual;
        els.curveNote.hidden = manual;
        els.curvesBox.querySelectorAll('textarea').forEach(function (ta) { ta.disabled = !manual; });
        els.radiusRow.hidden = !manual;
        els.trainNote.hidden = manual;
        els.introManual.hidden = !manual;
        els.introTrain.hidden = manual;
        els.controls.classList.toggle('apm-mode-train', !manual);
    }

    function setMode(mode) {
        if (mode === state.mode) return;
        state.mode = mode;
        renderModeTabs();
        if (state.centre) drawCentre();
        if (mode === 'train' && state.records) loadPeriods();
        updateGate();
    }

    function togglePanel(force) {
        var open = typeof force === 'boolean' ? force : ui.panel.hidden;
        ui.panel.hidden = !open;
        if (open) { updateGate(); renderDebugLog(); }
        ui.btn.setAttribute('aria-expanded', String(open));
    }

    function onLanguageChange() { refreshI18n(); }

    function init() {
        var needed = [root.DetectLabApmPipeline, root.DetectLabApmCore, root.DetectLabApmSites, root.DetectLabApmProviders, root.DetectLabApmI18n];
        if (needed.some(function (m) { return !m; })) return;     // a script is missing: stay silent
        if (document.getElementById('apmNextBtn')) return;

        try { state.enabled = root.localStorage.getItem(SWITCH_KEY) === 'on'; } catch (e) { state.enabled = false; }

        ui.panel = buildPanel();
        ui.btn = h('button', {
            type: 'button', id: 'apmNextBtn', class: 'apm-fab', 'aria-expanded': 'false',
            'aria-controls': 'apmNextPanel', title: T('btn.title'), onclick: function () { togglePanel(); }
        }, [h('span', { text: 'APM' }), h('span', { class: 'apm-fab-sub' })]);
        document.body.appendChild(ui.panel);
        document.body.appendChild(ui.btn);
        document.addEventListener('detectlab:langchange', onLanguageChange);
        renderSwitch();
        updateGate();
    }

    root.DetectLabApmUi = {
        tm: tm,
        diagnosticsBundle: diagnosticsBundle,
        init: init,
        open: function () { togglePanel(true); },
        close: function () { togglePanel(false); },
        setEnabled: function (on) { setEnabled(on); },
        isEnabled: function () { return state.enabled; },
        state: function () { return { mode: state.mode, enabled: state.enabled, centre: state.centre, radiusKm: state.radiusKm, period: state.period, picking: state.picking }; }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(typeof window !== 'undefined' ? window : this);
