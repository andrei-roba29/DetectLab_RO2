/* ============================================================
   DetectLab — selected-layer vertical opacity control
   Mirrors every layer opacity range from the side panel into a
   compact vertical control over the right side of the map.
   ============================================================ */
(function () {
    'use strict';

    /* Fallback names are also used by entries (notably LIDAR) whose title is
       not translated through a data-key. Whenever a translated layer title is
       present in the row, the live DOM text takes precedence. */
    var LAYER_NAMES = {
        apmOpacitySlider: 'APM Layer',
        apm20OpacitySlider: 'APM 2.0',
        satOpacitySlider: 'Satellite',
        osmPlacesOpacitySlider: 'OSM Places',
        uatOpacitySlider: 'UAT',
        patrimoniuOpacitySlider: 'Heritage Sites',
        ukHeritageOpacitySlider: 'United Kingdom · Heritage',
        iosfreeOpacitySlider: 'Harta Iosefină',
        austrianMapOpacitySlider: 'Austrian Map 1910',
        firingPlansOpacitySlider: 'Planuri de Tragere',
        sovietMapOpacitySlider: 'Harta Sovietică 1970',
        lidarHdOpacitySlider: 'HD · Hunedoara',
        lidarArOpacitySlider: 'AR · Arad',
        lidarAbOpacitySlider: 'AB · Alba',
        lidarBhOpacitySlider: 'BH · Bihor',
        lidarCsOpacitySlider: 'CS · Caraș-Severin',
        lidarRo2mOpacitySlider: 'Romania 2–5 m/pixel',
        lidarRo5mOpacitySlider: 'Romania 5m/pixel',
        lidarRo1mOpacitySlider: 'Romania 1 m/pixel',
        lidarCs917OpacitySlider: 'CS · LAKI III',
        lidarDj917OpacitySlider: 'DJ · LAKI III',
        lidarGj917OpacitySlider: 'GJ · LAKI III',
        lidarMh917OpacitySlider: 'MH · LAKI III',
        romanOpacitySlider: 'Roman Empire',
        josephineOpacitySlider: 'Josephine Map +',
        bucovinaMapOpacitySlider: 'Bucovina 1861–1864',
        austrohuMapOpacitySlider: 'Austro-Hungarian Map',
        moldova1868MapOpacitySlider: 'Moldova 1868',
        moldovaWwiiMapOpacitySlider: 'Moldova WWII',
        polishTactical1933MapOpacitySlider: 'Tactical Polish Map 1933',
        ww1MapOpacitySlider: 'WWI',
        ww2MapOpacitySlider: 'WWII',
        banatMapOpacitySlider: 'Banat 1769–1772',
        satellite60sMapOpacitySlider: "Satellite imagery 60's",
        vegfpPpiOpacitySlider: 'PPI · Vegetation Fingerprint',
        vegfpSmxOpacitySlider: 'SMX · Vegetation Fingerprint',
        vegfpSguOpacitySlider: 'SGU · Vegetation Fingerprint',
        vegfpSgdOpacitySlider: 'SGD · Vegetation Fingerprint',
        battlesPeriodSlider: 'Battles / Bătălii',
        satPeriodSlider: 'Satellite',
        lidarScannerDistance: 'LIDAR Scanner',
        archeoPotDistance: 'Archeological Potential Sites',
        archReportDistance: 'Archeological Report'
    };

    /* ── AUTO-ACTIVAREA STRATULUI AFERENT SLIDERULUI OGLINDIT ──
       Fiecare slider oglindit vertical pe ecran e legat de comutatorul stratului
       lui din panou: când oglinda APARE pe ecran (rândul/sliderul e selectat),
       stratul pornește automat; când oglinda e ștearsă de pe ecran cu butonul
       „×” (sau cu Escape, sau când e înlocuită de o oglindă mai nouă), stratul
       se oprește automat. Comutatorul primește exact aceeași secvență ca la un
       clic al utilizatorului (checked + eveniment „change”), deci rulează
       aceeași funcție toggle din js/map-app.js — nu există o a doua cale de
       pornire/oprire. Satellite e excepția deliberată: e strat de bază,
       permanent aprins, fără comutator, deci oglinzile lui nu pornesc/opresc
       nimic (intrările sale lipsesc intenționat din hartă). */
    var LAYER_TOGGLE_MAP = {
        apmOpacitySlider: 'apmToggle',
        apm20OpacitySlider: 'apm20Toggle',
        osmPlacesOpacitySlider: 'osmPlacesToggle',
        uatOpacitySlider: 'uatToggle',
        patrimoniuOpacitySlider: 'patrimoniuToggle',
        ukHeritageOpacitySlider: 'ukHeritageToggle',
        iosfreeOpacitySlider: 'iosfreeToggle',
        austrianMapOpacitySlider: 'austrianMapToggle',
        firingPlansOpacitySlider: 'firingPlansToggle',
        sovietMapOpacitySlider: 'sovietMapToggle',
        romanOpacitySlider: 'romanToggle',
        battlesPeriodSlider: 'battlesToggle',
        josephineOpacitySlider: 'josephineToggle',
        bucovinaMapOpacitySlider: 'bucovinaMapToggle',
        austrohuMapOpacitySlider: 'austrohuMapToggle',
        moldova1868MapOpacitySlider: 'moldova1868MapToggle',
        moldovaWwiiMapOpacitySlider: 'moldovaWwiiMapToggle',
        polishTactical1933MapOpacitySlider: 'polishTactical1933MapToggle',
        ww1MapOpacitySlider: 'ww1MapToggle',
        ww2MapOpacitySlider: 'ww2MapToggle',
        banatMapOpacitySlider: 'banatMapToggle',
        transylvania1859MapOpacitySlider: 'transylvania1859MapToggle',
        mitteleuropaMapOpacitySlider: 'mitteleuropaMapToggle',
        chrzanowskiMapOpacitySlider: 'chrzanowskiMapToggle',
        reymannMapOpacitySlider: 'reymannMapToggle',
        kdr100kMapOpacitySlider: 'kdr100kMapToggle',
        kdrGbMapOpacitySlider: 'kdrGbMapToggle',
        wig100kMapOpacitySlider: 'wig100kMapToggle',
        galicia1855MapOpacitySlider: 'galicia1855MapToggle',
        /* UK historical premium sublayers (NLS / MapTiler): same mirror →
           switch wiring as the rest of the Historical maps accordion. */
        ukOsLondon1893MapOpacitySlider: 'ukOsLondon1893MapToggle',
        ukOs1919MapOpacitySlider: 'ukOs1919MapToggle',
        ukOs10k1888MapOpacitySlider: 'ukOs10k1888MapToggle',
        ukOs25k1937MapOpacitySlider: 'ukOs25k1937MapToggle',
        ukOsHills1885MapOpacitySlider: 'ukOsHills1885MapToggle',
        ukOs63k1955MapOpacitySlider: 'ukOs63k1955MapToggle',
        ukOs1900sMapOpacitySlider: 'ukOs1900sMapToggle',
        ukBaire1940MapOpacitySlider: 'ukBaire1940MapToggle',
        otherMapsOpacitySlider: 'otherMapsToggle',
        satellite60sMapOpacitySlider: 'satellite60sToggle',
        vegfpPpiOpacitySlider: 'vegfpPpiToggle',
        vegfpSmxOpacitySlider: 'vegfpSmxToggle',
        vegfpSguOpacitySlider: 'vegfpSguToggle',
        vegfpSgdOpacitySlider: 'vegfpSgdToggle',
        /* Straturile de analiză: oglinzile lor de distanță/rază comută
           aceleași comutatoare care și le deschid (wire bidirecional deja
           existent în registerDistanceSource), ca butonul „×” să le oprească
           la fel ca la restul straturilor. */
        lidarScannerDistance: 'lidarScannerToggle',
        archeoPotDistance: 'archeoPotToggle',
        archReportDistance: 'archReportToggle'
    };

    /* Substraturile LIDAR nu au comutatoare funcționale proprii în panou
       („lidar…Toggle” sunt input-uri ascunse, fără logică). Stratul lor real
       se pornește/oprește prin window.toggleLidarSub (js/map-app.js), sub
       masterul #lidarToggle, care pornește odată cu primul substrat adăugat
       pe ecran și rămâne neatins la închiderea unei oglinzi (alte substraturi
       pot fi încă vizibile). */
    var LIDAR_SUB_TOGGLE_KEYS = {
        lidarHdOpacitySlider: 'hd',
        lidarArOpacitySlider: 'ar',
        lidarAbOpacitySlider: 'ab',
        lidarBhOpacitySlider: 'bh',
        lidarCsOpacitySlider: 'cs',
        lidarRo2mOpacitySlider: 'ro2m',
        lidarRo5mOpacitySlider: 'ro5m',
        lidarRo1mOpacitySlider: 'ro1m',
        lidarCs917OpacitySlider: 'cs917',
        lidarDj917OpacitySlider: 'dj917',
        lidarGj917OpacitySlider: 'gj917',
        lidarMh917OpacitySlider: 'mh917'
    };

    /* ── OGLINZI DE DISTANȚĂ / RAZĂ + DOCK DE ACȚIUNE ──
       Straturile de analiză (LIDAR Scanner, Zone cu potențial arheologic,
       Raport arheologic) au un slider de distanță/rază în panou. Când stratul
       e apăsat — clic pe rând sau comutatorul pornit — sliderul e oglindit
       vertical pe hartă exact ca opacitatea, iar butonul de acțiune al
       stratului (Scan / Detectează / Generează raport) e mutat în dock-ul
       centrat în partea de jos a ecranului principal. Înregistrarea e pe id
       (nu după șablonul „Opacity”), ca unitatea, eticheta și acțiunile să
       poată fi specifice fiecărui strat. */
    var DISTANCE_SOURCES = [
        { id: 'lidarScannerDistance', toggle: 'lidarScannerToggle', actions: ['lidarScannerRun'], caption: 'distance' },
        { id: 'archeoPotDistance', toggle: 'archeoPotToggle', actions: ['archeoPotRunBtn'], caption: 'radius' },
        { id: 'archReportDistance', toggle: 'archReportToggle', actions: ['archReportRunBtn'], caption: 'radius' }
    ];

    function distanceDef(sliderId) {
        for (var i = 0; i < DISTANCE_SOURCES.length; i++) {
            if (DISTANCE_SOURCES[i].id === sliderId) return DISTANCE_SOURCES[i];
        }
        return null;
    }

    function isDistanceId(sliderId) {
        return !!distanceDef(sliderId);
    }

    /* The Satellite layer owns TWO ranges: its opacity and the „Istoric”
       period selector (2012 / 2018 / 2021 / 2025 — the three Copernicus VHR
       mosaics plus the present-day imagery). Selecting either one shows both
       vertical mirrors on the map at the same time — each permanently bound to
       its own panel slider. */
    var SATELLITE_PAIR_IDS = ['satOpacitySlider', 'satPeriodSlider'];
    /* Only a last-resort fallback for when the panel ticks are not in the DOM
       (unit tests / pre-render). The live ticks win, so the mirror follows
       whatever stop list the panel actually ships. */
    var SAT_PERIOD_LABELS_FALLBACK = ['2012', '2018', '2021', '2025'];

    function isSatellitePairId(id) {
        return SATELLITE_PAIR_IDS.indexOf(id) !== -1;
    }

    function satPeriodTickLabel(idx) {
        var ticks = document.querySelectorAll('#satPeriodTicks span');
        if (!ticks || !ticks[idx]) return '';
        return String(ticks[idx].textContent || '').replace(/\s+/g, ' ').trim();
    }

    function satPeriodLastTickLabel() {
        /* „2025” follows the translated last tick of the panel slider. */
        var tick = document.querySelector('#satPeriodTicks span:last-child');
        return tick ? String(tick.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    function satPeriodLabel(value) {
        var ticks = document.querySelectorAll('#satPeriodTicks span');
        var lastIdx = (ticks && ticks.length ? ticks.length : SAT_PERIOD_LABELS_FALLBACK.length) - 1;
        if (lastIdx < 0) lastIdx = 0;
        var idx = Math.round(Number(value));
        if (!isFinite(idx)) idx = lastIdx;
        idx = Math.max(0, Math.min(lastIdx, idx));
        if (idx === lastIdx) {
            var present = satPeriodLastTickLabel();
            if (present) return present;
        }
        return satPeriodTickLabel(idx) || SAT_PERIOD_LABELS_FALLBACK[idx] || String(value);
    }

    /* Two independent map-side mirror slots are available. The first slot is
       also reused by the Satellite opacity + historic-period pair. Keeping the
       first slot's legacy ids preserves the public/test integration surface. */
    var control;
    var verticalSlider;
    var valueOutput;
    var layerLabel;
    var captionEl;
    var closeButton;
    var periodControl;
    var periodSlider;
    var periodOutput;
    var periodCaptionEl;
    var periodLayerLabel;
    var mirrorSlotPool = [];
    var mirrorSlots = [];
    var activeSlot = null;
    var activeSource = null;
    var activeOwner = null;
    var activeFormatter = percentageText;
    var syncTimer = null;
    var periodTipTimer = null;
    var periodTipPinned = false;
    var PERIOD_THUMB_SIZE = 13;
    var PERIOD_TIP_HIDE_DELAY = 900;

    /* Syncs `--slider-pct` (0%–100%) on any `<input type="range">` so WebKit /
       Chromium tracks paint a pastel faded semitransparent orange progress bar
       matching the 3D slider look. Guarded for minimal DOM mocks in Node tests. */
    function syncSliderFill(el) {
        if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
        var min = (el.min !== '' && el.min != null && isFinite(Number(el.min))) ? Number(el.min) : 0;
        var max = (el.max !== '' && el.max != null && isFinite(Number(el.max))) ? Number(el.max) : 100;
        var val = (el.value !== '' && el.value != null && isFinite(Number(el.value))) ? Number(el.value) : min;
        var span = max - min;
        var pct = span > 0 ? ((val - min) / span) * 100 : 0;
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        el.style.setProperty('--slider-pct', pct.toFixed(2) + '%');
    }

    function syncAllSlidersIn(rootNode) {
        if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;
        var list = rootNode.querySelectorAll('input[type="range"]');
        for (var i = 0; i < list.length; i++) syncSliderFill(list[i]);
    }

    /* Acțiuni rapide ancorate sub sliderul vertical: butonul „Ajutor de
       căutare” (APM 2.0) și cele trei butoane Iosefină Premium (căutare
       clădiri dispărute / setări / sugerează). Fiecare apare ca iconiță
       minimalistă (același design ca restul iconițelor de pe hartă),
       fără text, doar cât timp stratul său e selectat în oglinda
       verticală — eticheta devine bulă de informații la hover / focus / tap.
       Cheia e id-ul slider-ului de opacitate din panoul lateral. */
    var LAYER_ACTION_MAP = {
        apm20OpacitySlider: ['apm20SearchHelpBtn'],
        josephineOpacitySlider: ['iosBldSearchHelpBtn', 'iosBldSettingsBtn', 'iosBldSuggestBtn']
    };
    var actionHome = {};
    var tipTimers = {};
    var TIP_TAP_MS = 2500;

    function managedActionIds() {
        var ids = [];
        var keys = Object.keys(LAYER_ACTION_MAP);
        for (var i = 0; i < keys.length; i++) {
            var list = LAYER_ACTION_MAP[keys[i]];
            for (var j = 0; j < list.length; j++) {
                if (ids.indexOf(list[j]) === -1) ids.push(list[j]);
            }
        }
        return ids;
    }

    function refreshLayerActionVisibility() {
        if (typeof window === 'undefined') return;
        try {
            if (typeof window._refreshApm20SearchHelpBtnVisibility === 'function') {
                window._refreshApm20SearchHelpBtnVisibility();
            }
        } catch (e) { /* map module not initialised yet */ }
        try {
            if (typeof window._refreshIosBldBtnVisibility === 'function') {
                window._refreshIosBldBtnVisibility();
            }
        } catch (e) { /* map module not initialised yet */ }
    }

    function syncActionAriaLabels() {
        var ids = managedActionIds();
        for (var i = 0; i < ids.length; i++) {
            var btn = document.getElementById(ids[i]);
            if (!btn || !btn.querySelector) continue;
            var tip = btn.querySelector('.vo-action-tip');
            if (!tip) continue;
            var txt = compactText(tip.textContent);
            if (txt && typeof btn.setAttribute === 'function') {
                btn.setAttribute('aria-label', txt);
            }
        }
    }

    function refreshMirroredRows() {
        var mirroredOwners = [];
        for (var i = 0; i < mirrorSlots.length; i++) {
            var slot = mirrorSlots[i];
            if (slot && slot.owner && mirroredOwners.indexOf(slot.owner) === -1) {
                mirroredOwners.push(slot.owner);
            }
        }

        /* Clear the class first so a layer closed from the map immediately
           returns to its normal panel colour. */
        var rows = document.querySelectorAll('#transpPanel .opacity-layer-selectable');
        for (var r = 0; r < rows.length; r++) {
            if (rows[r].classList) {
                rows[r].classList.remove('opacity-layer-mirrored');
                rows[r].classList.remove('opacity-layer-selected');
            }
            if (typeof rows[r].removeAttribute === 'function') rows[r].removeAttribute('data-vo-mirrored-label');
        }
        for (var m = 0; m < mirroredOwners.length; m++) {
            var owner = mirroredOwners[m];
            if (!owner.classList) continue;
            owner.classList.add('opacity-layer-mirrored');
            if (owner === activeOwner) owner.classList.add('opacity-layer-selected');
        }
        refreshSoleMirrorAnchor();
    }

    /* ── O SINGURĂ OGLINDĂ = MEREU ÎN CEA MAI DIN DREAPTA POZIȚIE ──
       Cele două sloturi au ancore fixe: primul lipit de marginea din dreapta
       a hărții, al doilea la un pas spre stânga (50px card + 14px spațiu;
       46 + 10 pe mobil), ca să poată sta simultan pe ecran. Când oglinda din
       dreapta e închisă, cea rămasă ar rămâne pe ancora secundară, adică
       singură pe ecran dar decalat spre stânga, cu o bandă goală lângă
       margine. Clasa „mirror-sole” mută oglinda rămasă singură pe ancora
       primului slot, deci cu un singur slider pe ecran el e mereu cel mai din
       dreapta; la a doua selecție clasa dispare și cele două revin la
       pozițiile lor de pereche. Perechea Satellite (opacitate + ISTORIC) are
       întotdeauna două controale vizibile, deci nu primește niciodată clasa. */
    function refreshSoleMirrorAnchor() {
        var visible = [];
        for (var i = 0; i < mirrorSlotPool.length; i++) {
            var slot = mirrorSlotPool[i];
            try {
                if (slot && slot.control && slot.control.classList &&
                    slot.control.classList.contains('visible')) {
                    visible.push(slot.control);
                }
            } catch (e) { /* DOM-only tests */ }
        }
        for (var v = 0; v < mirrorSlotPool.length; v++) {
            var control2 = mirrorSlotPool[v] && mirrorSlotPool[v].control;
            if (!control2 || !control2.classList) continue;
            control2.classList.toggle('mirror-sole', visible.length === 1 && visible[0] === control2);
        }
    }

    function mirrorSlotVisible(slot) {
        try {
            return !!(slot && slot.source && slot.control && slot.control.classList &&
                slot.control.classList.contains('visible'));
        } catch (e) {
            return false;
        }
    }

    /* Fiecare oglindă își păstrează propriile acțiuni cât timp rămâne pe ecran.
       „Activ” înseamnă doar ultimul slider atins (bulă, tastatură, dock-ul de
       distanță); nu trebuie să golească slotul vecin. Altfel, după Josephine +
       selectarea unei alte hărți istorice, cele trei butoane Iosefină erau
       trimise înapoi în .map-wrapper și ascunse până la închiderea celui de-al
       doilea slider. Destinațiile sunt reconstruite din TOATE mirrorSlots, nu
       doar din activeSlot. */
    function syncLayerActions() {
        /* Nu condiționa resincronizarea de aliasul global `control`. În timpul
           înlocuirii/închiderii unui slot, setActiveSlot(null) poate goli
           temporar aliasul chiar dacă în `mirrorSlots` mai există o oglindă
           vizibilă. Un return aici lăsa acțiunile Iosefină acasă (display:none)
           până la închiderea sliderului vecin. Sursa de adevăr sunt sloturile
           vizibile, pe care le parcurgem mai jos. */
        var destinations = {};
        for (var s = 0; s < mirrorSlots.length; s++) {
            var slot = mirrorSlots[s];
            if (!mirrorSlotVisible(slot) || !slot.actions) continue;
            var slotId = slot.source.id;
            var slotActions = LAYER_ACTION_MAP[slotId] || [];
            for (var a = 0; a < slotActions.length; a++) {
                destinations[slotActions[a]] = slot;
            }
        }

        var ids = managedActionIds();
        for (var i = 0; i < ids.length; i++) {
            var btn = null;
            try { btn = document.getElementById(ids[i]); } catch (e) { btn = null; }
            if (!btn) continue;
            if (!actionHome[ids[i]]) {
                actionHome[ids[i]] = { parent: btn.parentElement, next: btn.nextSibling };
            }
            var destination = destinations[ids[i]];
            var destinationActions = destination && destination.actions;
            if (destinationActions) {
                if (btn.parentElement !== destinationActions) {
                    try { destinationActions.appendChild(btn); } catch (e) { /* DOM-only tests */ }
                }
                if (btn.classList) btn.classList.add('vo-docked');
            } else {
                var home = actionHome[ids[i]];
                if (home && home.parent && btn.parentElement !== home.parent) {
                    try {
                        if (home.next && home.next.parentElement === home.parent) {
                            home.parent.insertBefore(btn, home.next);
                        } else {
                            home.parent.appendChild(btn);
                        }
                    } catch (e) { /* DOM-only tests */ }
                }
                if (btn.classList) btn.classList.remove('vo-docked', 'show-tip');
            }
        }

        /* Păstrează ordinea declarată separat sub fiecare slider. */
        for (var r = 0; r < mirrorSlots.length; r++) {
            var orderedSlot = mirrorSlots[r];
            if (!mirrorSlotVisible(orderedSlot) || !orderedSlot.actions) continue;
            var ordered = LAYER_ACTION_MAP[orderedSlot.source.id] || [];
            for (var k = 0; k < ordered.length; k++) {
                var docked = null;
                try { docked = document.getElementById(ordered[k]); } catch (e) { docked = null; }
                if (docked && docked.parentElement === orderedSlot.actions) {
                    try { orderedSlot.actions.appendChild(docked); } catch (e) { /* DOM-only tests */ }
                }
            }
        }

        /* Panoul „Setări detecție” urmează oglinda Josephine cât timp ACEA
           oglindă rămâne pe ecran, chiar dacă utilizatorul atinge/selectează
           sliderul vecin. Ancora se derivă din slotul Josephine, nu din
           activeSlot. */
        var josephineSource = null;
        try { josephineSource = document.getElementById('josephineOpacitySlider'); } catch (e) { josephineSource = null; }
        var josephineSlot = josephineSource ? slotForSource(josephineSource) : null;
        var josephineDocked = mirrorSlotVisible(josephineSlot);
        /* O oglindă rămasă singură pe ecran stă pe ancora cea mai din dreapta
           (clasa „mirror-sole”), deci și panoul se ancorează ca pentru prima
           oglindă — fără clasa …-secondary. */
        var josephineSole = !!(josephineSlot && josephineSlot.control && josephineSlot.control.classList &&
            josephineSlot.control.classList.contains('mirror-sole'));
        var josephineSecondary = josephineDocked && !josephineSole &&
            mirrorSlotPool.length > 1 && josephineSlot === mirrorSlotPool[1];
        try {
            if (document.body && document.body.classList) {
                document.body.classList.toggle('vo-josephine-docked', josephineDocked);
                document.body.classList.toggle('vo-josephine-docked-secondary', josephineSecondary);
            }
        } catch (e) { /* DOM-only tests */ }
        if (!josephineDocked) {
            try {
                var settingsPanel = document.getElementById('iosBldSettingsPanel');
                if (settingsPanel && settingsPanel.classList) settingsPanel.classList.remove('open');
            } catch (e) { /* DOM-only tests */ }
        }
        /* map-app.js arată/ascunde iconițele în funcție de strat + zoom + existența oglinzii sale. */
        refreshLayerActionVisibility();
        syncActionAriaLabels();
    }

    /* ── dock-ul centrat jos: butonul de acțiune al stratului de analiză ──
       Butonul e mutat fizic (nu clonat), deci își păstrează id-ul,
       listener-ele, starea disabled și spinner-ul; la dezactivare se întoarce
       exact în rândul lui din panou. Alături rămâne o etichetă cu raza curentă,
       sincronizată cu oglinda verticală și cu sliderul din panou. */
    var dock = null;
    var dockInner = null;
    var dockRadius = null;
    var dockActionHome = {};

    function ensureDock() {
        if (!dock) { try { dock = document.getElementById('layerActionDock'); } catch (e) { dock = null; } }
        if (!dockInner) { try { dockInner = document.getElementById('layerActionDockInner'); } catch (e) { dockInner = null; } }
        return !!(dock && dockInner);
    }

    function ensureDockRadius() {
        if (dockRadius || !dockInner) return null;
        dockRadius = document.createElement('span');
        dockRadius.className = 'layer-action-dock-radius';
        if (typeof dockInner.insertBefore === 'function' && dockInner.firstChild) {
            dockInner.insertBefore(dockRadius, dockInner.firstChild);
        } else {
            dockInner.appendChild(dockRadius);
        }
        return dockRadius;
    }

    function updateDockRadius() {
        if (!dockRadius || !activeSource || !isDistanceId(activeSource.id)) return;
        dockRadius.textContent = distanceText(activeSource.value);
    }

    function syncDistanceDock() {
        if (!ensureDock()) return;
        var activeId = activeSource ? activeSource.id : null;
        var def = activeId ? distanceDef(activeId) : null;
        var controlVisible = false;
        try { controlVisible = control.classList.contains('visible'); } catch (e) { controlVisible = false; }
        var visible = !!def && controlVisible;
        var wanted = visible ? def.actions : [];

        var hasVisibleAction = false;
        for (var i = 0; i < DISTANCE_SOURCES.length; i++) {
            var actions = DISTANCE_SOURCES[i].actions;
            for (var j = 0; j < actions.length; j++) {
                var id = actions[j];
                var btn = null;
                try { btn = document.getElementById(id); } catch (e) { btn = null; }
                if (!btn) continue;
                if (!dockActionHome[id]) {
                    dockActionHome[id] = { parent: btn.parentElement, next: btn.nextSibling };
                }
                if (wanted.indexOf(id) !== -1) {
                    if (btn.parentElement !== dockInner) {
                        try { dockInner.appendChild(btn); } catch (e) { /* DOM-only tests */ }
                    }
                    if (btn.classList) btn.classList.add('la-docked');
                    var isHidden = false;
                    if (btn.style && btn.style.display === 'none') isHidden = true;
                    if (btn.classList && typeof btn.classList.contains === 'function' && btn.classList.contains('is-hidden')) isHidden = true;
                    if (!isHidden) hasVisibleAction = true;
                } else {
                    var home = dockActionHome[id];
                    if (home && home.parent && btn.parentElement !== home.parent) {
                        try {
                            if (home.next && home.next.parentElement === home.parent &&
                                typeof home.parent.insertBefore === 'function') {
                                home.parent.insertBefore(btn, home.next);
                            } else {
                                home.parent.appendChild(btn);
                            }
                        } catch (e) {
                            try { home.parent.appendChild(btn); } catch (e2) { /* DOM-only tests */ }
                        }
                    }
                    if (btn.classList) btn.classList.remove('la-docked');
                }
            }
        }

        var showDock = visible && hasVisibleAction;

        if (showDock) {
            ensureDockRadius();
            updateDockRadius();
        } else if (dockRadius && dockRadius.parentElement) {
            try { dockRadius.parentElement.removeChild(dockRadius); } catch (e) { /* DOM-only tests */ }
            dockRadius = null;
        }

        if (dock.classList) dock.classList.toggle('visible', showDock);
        if (dock.setAttribute) dock.setAttribute('aria-hidden', showDock ? 'false' : 'true');
        // Ridică stack-ul de controale plutitoare centrate jos (ajutor APM20,
        // hint-uri de zoom) cât timp dock-ul e vizibil, ca să nu se suprapună.
        try {
            if (document.body && document.body.classList) {
                document.body.classList.toggle('layer-dock-open', showDock);
            }
        } catch (e) { /* DOM-only tests */ }
    }

    function isVerticalActiveFor(sliderId) {
        try {
            /* „Activ pentru strat” înseamnă că oglinda ACELUI strat există și
               este vizibilă, nu că este ultimul slider atins. Ambele oglinzi
               pot rămâne simultan pe ecran; acțiunile Josephine/APM și
               modulele de analiză trebuie să-și recunoască propriul slot chiar
               când vecinul are focusul. */
            var source = document.getElementById(sliderId);
            var slot = source ? slotForSource(source) : null;
            if (!mirrorSlotVisible(slot)) return false;
            /* Un slot în curs de DEMOLARE nu mai apare în mirrorSlots:
               removeMirrorSlot îl scoate ÎNAINTE ca clearSlot să oprească
               stratul și să emită „change”, deci reintrările din acel eveniment
               primesc false și nu ating oglinda vecină. */
            return true;
        } catch (e) {
            return false;
        }
    }

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    /* Deasupra sliderului vertical (laterala stângă a casetei de sticlă) nu
       mai stă numele stratului, ci DOAR inițialele lui: maximum 3 litere,
       fără ani / cifre — „Austrian Map 1910” → „AM”, „Bucovina 1861–1864” →
       „B”, „APM Layer” → „APM”, „HD · Hunedoara” → „HD”. Numele complet
       rămâne în atributul title al etichetei (tooltip / cititoare de ecran). */
    var LAYER_INITIALS_MAX = 3;

    /* Grupuri de litere latine + diacritice românești / europene
       (ă, â, î, ș, ț, é, ö…): din fiecare se ia inițiala. */
    var LAYER_WORD_RE = /[A-Za-z\u00C0-\u024F]+/g;

    /* Particele de legătură nu contribuie cu inițială
       („Planuri de Tragere” → „PT”). */
    var LAYER_STOPWORDS = {
        de: true, din: true, al: true, ai: true, ale: true, cu: true, pe: true,
        la: true, le: true, di: true, du: true, da: true, and: true, of: true,
        the: true, on: true, in: true, for: true
    };

    function isLayerAcronym(word) {
        /* Prescurtările de maxim 3 litere (APM, OSM, UAT, CS, HD, WWI…) se
           păstrează întregi — ele sunt deja inițialele stratului. */
        return word.length <= LAYER_INITIALS_MAX &&
            word === word.toUpperCase() && /[A-Z]/.test(word);
    }

    function layerInitials(name) {
        var text = compactText(name);
        if (!text) return '';
        /* Doar segmentul dinaintea unui separator de expandare: la rândurile
           LIDAR codul de județ („CS · Caraș-Severin”) ESTE inițiala, iar după
           „/” („Battles / Bătălii”) urmează doar traducerea aceluiași nume. */
        var head = text.split('\u00B7')[0].split('/')[0];
        var chunks = head.split(/\s+/);
        var initials = '';
        for (var c = 0; c < chunks.length && initials.length < LAYER_INITIALS_MAX; c++) {
            var chunk = chunks[c];
            /* Fără ani / cifre: orice grup care conține o cifră dispare
               (1910, 1861–1864, 2.0, 2–5, 60's…). */
            if (!chunk || /\d/.test(chunk)) continue;
            var words = chunk.match(LAYER_WORD_RE);
            if (!words) continue;
            for (var w = 0; w < words.length && initials.length < LAYER_INITIALS_MAX; w++) {
                var word = words[w];
                /* Fragmentele de o literă („m” din „m/pixel”, „s” din „60's”)
                   nu sunt inițiale. */
                if (word.length < 2) continue;
                if (LAYER_STOPWORDS[word.toLowerCase()]) continue;
                if (isLayerAcronym(word)) {
                    if (initials.length + word.length <= LAYER_INITIALS_MAX) {
                        initials += word;
                    } else {
                        /* Prescurtarea nu mai încape întreagă: o reprezentăm
                           doar prin prima ei literă („Localități OSM” → „LO”),
                           niciodată tăiată în jumătate. */
                        initials += word.charAt(0);
                    }
                } else {
                    initials += word.charAt(0).toUpperCase();
                }
            }
        }
        return initials;
    }

    function layerTitleText(name) {
        return layerInitials(name);
    }

    function getLayerName(source, owner) {
        /* A translated layer title is preferred, but never mistake the shared
           "Opacity" translation for the layer's actual name. */
        var translated = owner.querySelectorAll('[data-key^="layer_"]');
        for (var i = 0; i < translated.length; i++) {
            var key = translated[i].getAttribute('data-key') || '';
            if (key !== 'layer_opacity' && key !== 'layer_opacity_label') {
                var translatedText = compactText(translated[i].textContent);
                if (translatedText) return translatedText;
            }
        }

        return LAYER_NAMES[source.id] || source.getAttribute('aria-label') || 'Layer';
    }

    function percentageText(value) {
        var number = Number(value);
        if (!isFinite(number)) return String(value) + '%';
        return (Math.round(number * 100) / 100) + '%';
    }

    /* The Battles layer mirrors a period (century) range, not an opacity one.
       Its value formatter and caption come from battles-layer.js
       (window.DetectLabBattlesPeriod); percentage formatting stays the default
       for every other range. */
    function distanceText(value) {
        var number = Number(value);
        if (!isFinite(number)) return String(value) + ' km';
        return number + ' km';
    }

    function sourceFormatter(source) {
        if (isDistanceId(source.id)) return distanceText;
        if (source.id === 'battlesPeriodSlider') {
            if (window.DetectLabBattlesPeriod && typeof window.DetectLabBattlesPeriod.format === 'function') {
                return window.DetectLabBattlesPeriod.format;
            }
            return function (value) { return String(value); };
        }
        if (source.id === 'satPeriodSlider') {
            return satPeriodLabel;
        }
        return percentageText;
    }

    function sourceCaption(source) {
        if (isDistanceId(source.id)) {
            var def = distanceDef(source.id);
            var en = (window._currentLang && window._currentLang() === 'en');
            if (def && def.caption === 'radius') return en ? 'RADIUS' : 'RAZĂ';
            return en ? 'DISTANCE' : 'DISTANȚĂ';
        }
        if (source.id === 'battlesPeriodSlider') {
            if (window.DetectLabBattlesPeriod && typeof window.DetectLabBattlesPeriod.caption === 'function') {
                return window.DetectLabBattlesPeriod.caption();
            }
            return 'PERIOD';
        }
        if (source.id === 'satPeriodSlider') {
            return (window._currentLang && window._currentLang() === 'en') ? 'HISTORIC' : 'ISTORIC';
        }
        /* Plain opacity ranges carry NO caption: the word "OPACITY" used to sit
           above the map-side slider and only pushed the layer name down. The
           label stays empty (and is hidden by CSS), while the accessible name
           of the range still says what it controls. */
        return '';
    }

    function sourceKind(source) {
        if (isDistanceId(source.id)) return 'distance';
        if (source.id === 'battlesPeriodSlider') return 'period';
        if (source.id === 'satPeriodSlider') return 'satperiod';
        return 'opacity';
    }

    function positionPeriodTip() {
        if (!activeSource || sourceKind(activeSource) !== 'period' || !verticalSlider || !valueOutput) return;
        var min = Number(verticalSlider.min);
        var max = Number(verticalSlider.max);
        var value = Number(verticalSlider.value);
        if (!isFinite(min) || !isFinite(max) || !isFinite(value) || max <= min) return;

        var wrap = verticalSlider.parentElement;
        if (!wrap) return;
        var sliderLength = verticalSlider.offsetWidth || 0;
        if (!sliderLength && typeof verticalSlider.getBoundingClientRect === 'function') {
            sliderLength = verticalSlider.getBoundingClientRect().height || 0;
        }
        if (!sliderLength) return; // no layout (e.g. DOM-only integration tests)

        var fraction = Math.max(0, Math.min(1, (value - min) / (max - min)));
        var travel = Math.max(0, sliderLength - PERIOD_THUMB_SIZE);
        var centre = (wrap.offsetTop || 0) + (wrap.offsetHeight || 0) / 2;
        var y = centre + (0.5 - fraction) * travel; // rotated range: max is at the top
        var tipHalf = (valueOutput.offsetHeight || 0) / 2;
        var controlHeight = control.clientHeight || control.offsetHeight || 0;
        if (controlHeight && tipHalf) y = Math.max(tipHalf + 4, Math.min(controlHeight - tipHalf - 4, y));
        valueOutput.style.top = Math.round(y) + 'px';
    }

    function showPeriodTip() {
        if (!activeSource || sourceKind(activeSource) !== 'period') return;
        if (periodTipTimer !== null) {
            window.clearTimeout(periodTipTimer);
            periodTipTimer = null;
        }
        positionPeriodTip();
        valueOutput.classList.add('visible');
    }

    function hidePeriodTip(delay) {
        if (!activeSource || sourceKind(activeSource) !== 'period') {
            if (valueOutput) valueOutput.classList.remove('visible');
            return;
        }
        if (periodTipTimer !== null) window.clearTimeout(periodTipTimer);
        periodTipTimer = window.setTimeout(function () {
            periodTipTimer = null;
            if (valueOutput) valueOutput.classList.remove('visible');
        }, delay || 0);
    }

    function resetPeriodTip() {
        if (periodTipTimer !== null) {
            window.clearTimeout(periodTipTimer);
            periodTipTimer = null;
        }
        if (valueTipTimer !== null) {
            window.clearTimeout(valueTipTimer);
            valueTipTimer = null;
        }
        periodTipPinned = false;
        if (valueOutput) {
            valueOutput.classList.remove('visible');
            valueOutput.style.top = '';
        }
    }

    /* ── PERCENTAGE ONLY WHILE CHANGING (opacity mirrors) ──
       The opacity mirror's value chip is hidden by default and lights up only
       while the user is actually changing the opacity (drag / keyboard / the
       panel slider), fading away shortly after the last change. Distance and
       ISTORIC mirrors keep their chips permanently visible (not percentages). */
    var VALUE_TIP_HIDE_DELAY = 1100;
    var valueTipTimer = null;

    function showValueTip() {
        if (valueTipTimer !== null) {
            window.clearTimeout(valueTipTimer);
            valueTipTimer = null;
        }
        if (valueOutput) valueOutput.classList.add('visible');
    }

    function hideValueTip(delay) {
        if (valueTipTimer !== null) window.clearTimeout(valueTipTimer);
        valueTipTimer = window.setTimeout(function () {
            valueTipTimer = null;
            if (valueOutput) valueOutput.classList.remove('visible');
        }, typeof delay === 'number' ? delay : VALUE_TIP_HIDE_DELAY);
    }

    function opacityTipShow() {
        if (activeSource && sourceKind(activeSource) === 'opacity') showValueTip();
    }

    function opacityTipHide(delay) {
        if (activeSource && sourceKind(activeSource) === 'opacity') hideValueTip(delay);
    }

    function slotForSource(source) {
        for (var i = 0; i < mirrorSlots.length; i++) {
            if (mirrorSlots[i] && mirrorSlots[i].source === source) return mirrorSlots[i];
        }
        return null;
    }

    function setActiveSlot(slot) {
        activeSlot = slot || null;
        if (activeSlot) {
            /* These aliases keep the distance dock and tooltip code focused on
               the slot the user most recently touched. Layer quick actions are
               deliberately resolved for every visible slot independently. */
            control = activeSlot.control;
            verticalSlider = activeSlot.slider;
            valueOutput = activeSlot.output;
            layerLabel = activeSlot.label;
            captionEl = activeSlot.caption;
            closeButton = activeSlot.close;
            activeSource = activeSlot.source;
            activeOwner = activeSlot.owner;
            activeFormatter = activeSlot.formatter || percentageText;
        } else {
            activeSource = null;
            activeOwner = null;
            activeFormatter = percentageText;
        }
        refreshMirroredRows();
    }

    function dispatchToggleChange(el) {
        try {
            if (el && typeof el.dispatchEvent === 'function') {
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) { /* DOM-only tests */ }
    }

    /* Substrat LIDAR: pornit → masterul (#lidarToggle) pornește întâi (ca în
       js/map-app.js la mișcarea sliderului de opacitate), apoi substratul —
       toggleLidarSub îl pune pe hartă imediat dacă masterul e vizibil, sau la
       următoarea pornire a masterului; oprit → doar substratul se stinge,
       masterul rămâne aprins pentru restul substraturilor de pe ecran.

       La pornire evenimentul masterului e trimis ÎNTOTDEAUNA, nu doar când
       checkbox-ul era debifat: window.toggleLidarSub (js/map-app.js) iese
       devreme cât timp starea lui internă _lidarVisible e falsă, iar un
       checkbox bifat nu înseamnă că stratul e pe hartă — browserele restaurează
       starea bifată la reload / back-forward (form restoration), deci
       „master.checked === true” fără eveniment lăsa substratul activat în
       configurație, dar invizibil. */
    function setLidarSubActive(subKey, on) {
        var master = null;
        try { master = document.getElementById('lidarToggle'); } catch (e) { master = null; }
        if (on && master) {
            master.checked = true;
            dispatchToggleChange(master);
        }
        try {
            if (typeof window !== 'undefined' && window &&
                typeof window.toggleLidarSub === 'function') {
                window.toggleLidarSub(subKey, on);
            }
        } catch (e) { /* map module not initialised yet */ }
    }

    /* Pornește / oprește stratul căruia îi aparține sliderul oglindit, în
       numele oglinzii de pe ecran. Apelat cu on=true la APARIȚIA oglinzii pe
       ecran (selectSource / showSatellitePair, după înregistrarea slotului) și
       cu on=false la ȘTERGEREA ei de pe ecran (clearSlot: butonul „×”,
       Escape, înlocuirea oglinzii).

       force=true (doar la pornire) trimite evenimentul „change” chiar dacă
       comutatorul e deja bifat. Fără asta, un comutator rămas bifat dintr-o
       stare veche — cel mai des form restoration la reload / back-forward,
       caz în care stratul NU mai e pe hartă — făcea ca adăugarea sliderului pe
       ecran să nu pornească nimic: oglinda apărea, stratul rămânea stins.
       Re-trimiterea e inofensivă: funcțiile toggle din js/map-app.js folosesc
       map.hasLayer(...) înainte de addTo, iar modulele de analiză își apără
       oglinda cu isActiveFor(...) înainte de api.select(...), deci nu se
       creează bucle. La oprire (force fals) evenimentul rămâne condiționat de
       o tranziție reală de stare, ca să nu stingem straturi de două ori. */
    function setLayerActiveForSource(sliderId, on, force) {
        if (!sliderId) return;
        var subKey = LIDAR_SUB_TOGGLE_KEYS[sliderId];
        if (subKey) {
            setLidarSubActive(subKey, on);
            return;
        }
        var toggleId = LAYER_TOGGLE_MAP[sliderId];
        if (!toggleId) return; // Satellite: strat de bază, permanent aprins
        var toggle = null;
        try { toggle = document.getElementById(toggleId); } catch (e) { toggle = null; }
        if (!toggle) return;
        if (toggle.checked === on && !(force && on)) return; // deja în starea cerută — fără eveniment redundant
        toggle.checked = on;
        dispatchToggleChange(toggle);
    }

    function configureSlot(slot, source) {
        if (!slot || !source || !source.parentElement) return false;
        var owner = source.parentElement;
        var kind = sourceKind(source);
        var name = getLayerName(source, owner);
        slot.source = source;
        slot.owner = owner;
        slot.kind = kind;
        slot.formatter = sourceFormatter(source);
        slot.label.textContent = layerTitleText(name);
        slot.label.title = name;
        if (slot.caption) slot.caption.textContent = sourceCaption(source);
        slot.control.setAttribute('data-kind', kind);
        slot.control.setAttribute('data-owner', source.id);
        slot.control.setAttribute('aria-label', name + ' ' + kind);
        slot.control.setAttribute('aria-hidden', 'false');
        slot.slider.min = source.min || '0';
        slot.slider.max = source.max || '100';
        slot.slider.step = source.step || '1';
        slot.slider.value = source.value;
        slot.slider.setAttribute('aria-label', name + ' ' + kind);
        slot.slider.setAttribute('aria-valuetext', slot.formatter(source.value));
        slot.control.classList.add('visible');
        if (kind === 'opacity') {
            slot.output.textContent = slot.formatter(source.value);
            slot.output.classList.add('visible');
        }
        /* Activarea stratului NU are loc aici, ci la apelatorii acestei
           funcții, imediat după înregistrarea slotului în mirrorSlots — ca
           un eventual eveniment „change” declanșat de comutator (ex.
           comutatoarele de distanță, care reintră în selectSource) să găsească
           oglinda deja înregistrată și să nu configureze un al doilea slot. */
        return true;
    }

    function clearSlot(slot) {
        if (!slot) return;
        /* Oglinda părăsește ecranul (butonul „×”, Escape, înlocuirea ei) →
           stratul aferent se oprește automat, înainte ca sursa slotului să
           fie ștearsă. */
        if (slot.source) setLayerActiveForSource(slot.source.id, false);
        if (slot.owner && slot.owner.classList) {
            slot.owner.classList.remove('opacity-layer-mirrored');
            slot.owner.classList.remove('opacity-layer-selected');
        }
        if (slot.control) {
            slot.control.classList.remove('visible', 'pair-shown');
            slot.control.setAttribute('aria-hidden', 'true');
            if (typeof slot.control.removeAttribute === 'function') slot.control.removeAttribute('data-owner');
        }
        if (slot.output && slot.output.classList) slot.output.classList.remove('visible');
        slot.source = null;
        slot.owner = null;
        slot.kind = null;
        slot.formatter = percentageText;
    }

    function syncFromSource(slot) {
        slot = slot || activeSlot;
        if (!slot || !slot.source || !slot.slider || !slot.output) return;
        if (String(slot.slider.value) !== String(slot.source.value)) {
            slot.slider.value = slot.source.value;
        }
        syncSliderFill(slot.source);
        syncSliderFill(slot.slider);
        slot.output.textContent = slot.formatter(slot.source.value);
        slot.slider.setAttribute('aria-valuetext', slot.output.textContent);
        if (slot === activeSlot) {
            updateDockRadius();
            if (slot.output.classList.contains('visible')) positionPeriodTip();
        }
    }

    function startProgrammaticSync() {
        if (syncTimer !== null) window.clearInterval(syncTimer);
        /* Some existing layer toggles restore a range by assigning .value
           directly (without an input event). Keep both visible mirrors in
           sync without giving either one ownership of the other. */
        syncTimer = window.setInterval(function () {
            for (var i = 0; i < mirrorSlots.length; i++) syncFromSource(mirrorSlots[i]);
            if (pairActive) syncPeriodFromSource();
        }, 250);
    }

    function closeLayerPanel() {
        var panel = document.getElementById('transpPanel');
        var tab = document.getElementById('transpTab');
        if (panel && panel.classList.contains('open') && tab) {
            /* Go through the existing button so map-app.js's private open-state
               flag and arrow direction stay in sync. */
            tab.click();
        }
    }

    var pairActive = false;

    function updatePeriodOutput() {
        if (!periodSlider || !periodOutput) return;
        syncSliderFill(periodSlider);
        periodOutput.textContent = satPeriodLabel(periodSlider.value);
        periodSlider.setAttribute('aria-valuetext', periodOutput.textContent);
    }

    function syncPeriodFromSource() {
        var periodSource = document.getElementById('satPeriodSlider');
        if (!periodSource || !periodSlider) return;
        /* Follow the panel range's own geometry, so a stop list that grows or
           shrinks (2012 / 2018 / 2021 / 2025 since the Copernicus VHR mosaics
           replaced the single 2016 orthophoto) can never leave the mirror
           pointing at a period the panel cannot reach. */
        if (periodSource.max && periodSlider.max !== periodSource.max) periodSlider.max = periodSource.max;
        if (periodSource.min && periodSlider.min !== periodSource.min) periodSlider.min = periodSource.min;
        if (periodSource.step && periodSlider.step !== periodSource.step) periodSlider.step = periodSource.step;
        if (String(periodSlider.value) !== String(periodSource.value)) {
            periodSlider.value = periodSource.value;
        }
        syncSliderFill(periodSource);
        syncSliderFill(periodSlider);
        updatePeriodOutput();
    }

    function removeMirrorSlot(slot) {
        if (!slot) return;
        var index = mirrorSlots.indexOf(slot);
        if (index !== -1) mirrorSlots.splice(index, 1);
        var wasActive = activeSlot === slot;
        clearSlot(slot);
        if (wasActive) setActiveSlot(null);
        refreshMirroredRows();
    }

    function clearAllMirrorSlots() {
        var slots = mirrorSlots.slice();
        mirrorSlots.length = 0;
        for (var i = 0; i < slots.length; i++) clearSlot(slots[i]);
        setActiveSlot(null);
    }

    function hideSatellitePair() {
        pairActive = false;
        if (periodControl) {
            periodControl.classList.remove('visible', 'pair-shown');
            periodControl.setAttribute('aria-hidden', 'true');
        }
        var satSource = document.getElementById('satOpacitySlider');
        var satSlot = satSource ? slotForSource(satSource) : null;
        if (satSlot) removeMirrorSlot(satSlot);
        refreshMirroredRows();
    }

    /* Satellite is the deliberate two-slider exception: its first slot is
       opacity and its second control is the historic period. It occupies both
       available map-side positions, so selecting it replaces other mirrors. */
    function showSatellitePair(closePanel) {
        var opacitySource = document.getElementById('satOpacitySlider');
        var periodSource = document.getElementById('satPeriodSlider');
        var primarySlot = mirrorSlotPool[0];
        if (!opacitySource || !periodSource || !periodControl || !periodSlider || !primarySlot) return false;

        resetPeriodTip();
        clearAllMirrorSlots();
        pairActive = true;
        configureSlot(primarySlot, opacitySource);
        mirrorSlots.push(primarySlot);
        setActiveSlot(primarySlot);
        /* Oglinda de opacitate Satellite a ajuns pe ecran → stratul aferent
           pornește automat (Satellite e strat de bază fără comutator, deci
           apelul rămâne un no-op intenționat — vezi LAYER_TOGGLE_MAP). */
        setLayerActiveForSource(opacitySource.id, true, true);

        /* The current percentage peeks briefly when the mirror opens, then
           fades — it only stays up while the value is actually changed. */
        showValueTip();
        hideValueTip();

        var name = getLayerName(opacitySource, primarySlot.owner);
        if (periodLayerLabel) {
            periodLayerLabel.textContent = layerTitleText(name);
            periodLayerLabel.title = name;
        }
        if (periodCaptionEl) periodCaptionEl.textContent = sourceCaption(periodSource);
        syncPeriodFromSource();
        periodControl.classList.add('visible', 'pair-shown');
        periodControl.setAttribute('aria-hidden', 'false');

        startProgrammaticSync();
        if (closePanel) closeLayerPanel();
        syncLayerActions();
        syncDistanceDock();
        refreshMirroredRows();
        return true;
    }

    function selectSource(source, closePanel) {
        if (!source || !source.parentElement) return;

        /* The Satellite layer shows both of its vertical mirrors at once. */
        if (isSatellitePairId(source.id) && showSatellitePair(closePanel)) return;

        resetPeriodTip();
        if (pairActive) hideSatellitePair();

        var slot = slotForSource(source);
        if (!slot) {
            /* A third selection replaces the oldest visible mirror. This keeps
               the on-map surface bounded while making the second selection an
               additive action instead of hiding the first slider. */
            if (mirrorSlots.length >= 2) {
                slot = mirrorSlots[0];
                removeMirrorSlot(slot);
            } else {
                for (var i = 0; i < mirrorSlotPool.length; i++) {
                    if (mirrorSlots.indexOf(mirrorSlotPool[i]) === -1) {
                        slot = mirrorSlotPool[i];
                        break;
                    }
                }
            }
            /* DOM-only integrations from before the second slot existed may
               expose only the primary control; preserve their old replacement
               behaviour instead of dropping the selection. */
            if (!slot && mirrorSlots.length) {
                slot = mirrorSlots[0];
                removeMirrorSlot(slot);
            }
            if (!slot) return;
            configureSlot(slot, source);
            mirrorSlots.push(slot);
            /* Sliderul a fost ADĂUGAT pe ecran → stratul aferent pornește
               automat: comutatorul lui din panou primește exact secvența unui
               clic manual (checked + „change”). Apelat după înregistrarea
               slotului, ca o reintrare în selectSource declanșată de
               comutator (straturile de distanță) să găsească oglinda deja
               existentă în loc să configureze un al doilea slot. Al treilea
               argument (force) trimite „change” și când comutatorul era deja
               bifat dintr-o stare veche (form restoration la reload), altfel
               sliderul apărea pe ecran cu stratul stins. */
            setLayerActiveForSource(source.id, true, true);
        }

        setActiveSlot(slot);
        syncFromSource(slot);
        if (slot.kind === 'opacity') {
            showValueTip();
            hideValueTip();
        }
        startProgrammaticSync();

        if (closePanel) closeLayerPanel();
        syncLayerActions();
        syncDistanceDock();
        refreshMirroredRows();
    }

    function hideControl(slot) {
        slot = slot || activeSlot;
        if (!slot) return;
        resetPeriodTip();
        if (pairActive && slot.source && isSatellitePairId(slot.source.id)) {
            hideSatellitePair();
        } else {
            var wasActive = activeSlot === slot;
            removeMirrorSlot(slot);
            if (wasActive && mirrorSlots.length) {
                setActiveSlot(mirrorSlots[mirrorSlots.length - 1]);
                syncFromSource(activeSlot);
            }
        }

        if (!mirrorSlots.length) {
            setActiveSlot(null);
            if (syncTimer !== null) {
                window.clearInterval(syncTimer);
                syncTimer = null;
            }
        }
        syncLayerActions();
        syncDistanceDock();
        refreshMirroredRows();
    }

    function closeAllControls() {
        resetPeriodTip();
        pairActive = false;
        if (periodControl) {
            periodControl.classList.remove('visible', 'pair-shown');
            periodControl.setAttribute('aria-hidden', 'true');
        }
        clearAllMirrorSlots();
        if (syncTimer !== null) {
            window.clearInterval(syncTimer);
            syncTimer = null;
        }
        syncLayerActions();
        syncDistanceDock();
        refreshMirroredRows();
    }

    function isInteractiveTarget(target) {
        return !!(target && target.closest && target.closest(
            'input, button, label, a, select, textarea, [role="button"], .heritage-legend-icon, .heritage-legend-tooltip'
        ));
    }

    /* ── TAP CONCRET PE STRAT (PWA / touch): fără oglinzi adăugate din greșeală ──
       În aplicația instalată (și pe orice ecran tactil) oglinda unui strat se
       adaugă pe ecran DOAR la un tap deliberat pe cardul stratului. Atingerea
       sau glisarea unui slider din panou nu mai adaugă oglinda și nu mai
       pornește stratul: ea doar alimentează o oglindă aflată DEJA pe ecran (o
       aduce în față pentru dock-ul de acțiuni și pentru bula de valoare). Așa
       dispare calea cea mai frecventă de „misclick” din PWA — degetul care
       alunecă peste un range în timp ce derulezi panoul, sau o simplă atingere
       a sliderului, care înainte aruncau pe hartă o oglindă și aprindeau
       stratul.

       Un tap pe card contează ca „concret” doar dacă gestul care l-a produs nu
       a fost o derulare: deplasare peste prag între apăsare și ridicare, panou
       derulat între ele, un tap care doar oprește o derulare în curs, al
       doilea deget sau o apăsare lungă nu selectează nimic. Când nu există
       niciun pointerdown înaintea click-ului (click sintetic — tastatură,
       script, test) nu avem ce verifica și lăsăm click-ul să treacă.

       Pe desktop, în afara modului PWA, comportamentul rămâne cel dinainte:
       orice clic pe card sau atingere a unui slider selectează stratul. */
    var TAP_MOVE_TOLERANCE = 12;    // px: peste asta gestul e scroll/drag, nu tap
    var TAP_MAX_DURATION = 800;     // ms: doar pe touch — apăsarea lungă nu e tap
    var SCROLL_QUIET_MS = 200;      // ms: un tap care oprește derularea nu selectează
    /* GESTURE_TTL e intenționat mai mare decât TAP_MAX_DURATION: un gest ținut
       minte prea puțin ar lăsa o apăsare lungă să treacă drept tap (n-am mai
       avea cu ce compara durata). */
    var GESTURE_TTL = 2500;         // ms: cât ținem minte un gest rămas fără click
    var tapGesture = null;
    var gestureTimer = null;
    var lastPanelScrollAt = 0;

    /* Modul PWA: clasa „is-pwa” e pusă de index.html pe <html> în <head> și pe
       <body> imediat după — citim amândouă, ca să prindem și fereastra scurtă
       de la pornire, și `?pwa=1`, care forțează același mod în browser. */
    function pwaLayout() {
        try {
            if (document.documentElement && document.documentElement.classList &&
                document.documentElement.classList.contains('is-pwa')) return true;
        } catch (e) { /* DOM-only tests */ }
        try {
            if (document.body && document.body.classList &&
                document.body.classList.contains('is-pwa')) return true;
        } catch (e) { /* DOM-only tests */ }
        return false;
    }

    function isTouchPointer(type) {
        return type === 'touch' || type === 'pen';
    }

    /* Un gest cere tap deliberat pe touch sau în aplicația instalată. */
    function strictTapMode(pointerType) {
        return isTouchPointer(pointerType) || pwaLayout();
    }

    function panelElement() {
        try { return document.getElementById('transpPanel'); } catch (e) { return null; }
    }

    function panelScrollTop() {
        var panel = panelElement();
        return (panel && typeof panel.scrollTop === 'number') ? panel.scrollTop : null;
    }

    function gesturePointerType() {
        return tapGesture && tapGesture.type ? tapGesture.type : '';
    }

    /* Tipul de gest al evenimentului curent: pointerType-ul lui (dacă browserul
       îl pune pe click) sau cel înregistrat la pointerdown. */
    function strictEvent(event) {
        return strictTapMode(event && event.pointerType ? String(event.pointerType) : gesturePointerType());
    }

    function dropGesture() {
        if (gestureTimer !== null) {
            window.clearTimeout(gestureTimer);
            gestureTimer = null;
        }
        tapGesture = null;
    }

    function beginGesture(event) {
        /* Al doilea deget în același gest (pinch / apăsare cu două degete) nu
           e un tap pe strat. */
        if (tapGesture && !tapGesture.ended && !tapGesture.cancelled) {
            tapGesture.extra = true;
            return;
        }
        if (gestureTimer !== null) {
            window.clearTimeout(gestureTimer);
            gestureTimer = null;
        }
        tapGesture = {
            type: event && event.pointerType ? String(event.pointerType) : '',
            x: (event && typeof event.clientX === 'number') ? event.clientX : null,
            y: (event && typeof event.clientY === 'number') ? event.clientY : null,
            t: Date.now(),
            target: event ? event.target : null,
            scrollTop: panelScrollTop(),
            extra: false,
            ended: false,
            cancelled: false
        };
        gestureTimer = window.setTimeout(function () {
            gestureTimer = null;
            tapGesture = null;
        }, GESTURE_TTL);
    }

    function endGesture(event) {
        if (!tapGesture) return;
        tapGesture.ended = true;
        if (event && event.type === 'pointercancel') tapGesture.cancelled = true;
    }

    /* Decizia pentru un click sosit pe cardul stratului. */
    function deliberateTap(event) {
        if (!strictEvent(event)) return true; /* desktop clasic: ca înainte */
        var gesture = tapGesture;
        if (!gesture) return true; /* click sintetic — nimic de verificat */
        if (gesture.cancelled || gesture.extra) return false;
        if (gesture.target && isInteractiveTarget(gesture.target)) return false; /* a început pe slider/comutator */
        if (typeof event.clientX === 'number' && typeof event.clientY === 'number' &&
            typeof gesture.x === 'number' && typeof gesture.y === 'number') {
            if (Math.abs(event.clientX - gesture.x) > TAP_MOVE_TOLERANCE ||
                Math.abs(event.clientY - gesture.y) > TAP_MOVE_TOLERANCE) return false;
        }
        if (isTouchPointer(gesture.type) && gesture.t &&
            (Date.now() - gesture.t) > TAP_MAX_DURATION) return false;
        var scrollTop = panelScrollTop();
        if (typeof scrollTop === 'number' && typeof gesture.scrollTop === 'number' &&
            Math.abs(scrollTop - gesture.scrollTop) > 2) return false;
        if (gesture.t && (Date.now() - lastPanelScrollAt) < SCROLL_QUIET_MS) return false;
        return true;
    }

    /* Oglinda deja aflată pe ecran devine activă (dock de acțiuni, bulă,
       highlight în panou) fără să creeze una nouă și fără să atingă
       comutatorul stratului. Întoarce false când sursa nu are nicio oglindă
       pe ecran — caz în care un gest tactil nu are voie să facă nimic. */
    function activateExistingMirror(source) {
        if (!source) return false;
        var slot = slotForSource(source);
        if (!slot && pairActive && isSatellitePairId(source.id)) {
            /* Perechea Satellite: cea de-a doua oglindă (ISTORIC) nu are slot
               propriu, deci atingerea ei readuce în față oglinda de opacitate
               a perechii — exact slotul pe care îl activează și selectSource. */
            try { slot = slotForSource(document.getElementById('satOpacitySlider')); }
            catch (e) { slot = null; }
        }
        if (!slot) return false;
        setActiveSlot(slot);
        syncFromSource(slot);
        syncLayerActions();
        syncDistanceDock();
        return true;
    }

    /* Atingerea unui slider (pointerdown / focus de tastatură) în modul strict
       nu selectează stratul: doar readuce în față oglinda existentă. */
    function sliderTouch(source, event) {
        if (strictEvent(event)) {
            activateExistingMirror(source);
            return;
        }
        selectSource(source, false);
    }

    function registerSource(source) {
        var owner = source.parentElement;
        if (!owner) return;

        owner.classList.add('opacity-layer-selectable');
        owner.setAttribute('tabindex', '0');
        owner.setAttribute('role', 'group');
        owner.setAttribute('aria-label', 'Select ' + getLayerName(source, owner) + ' ' + sourceKind(source) + ' control');

        owner.addEventListener('click', function (event) {
            /* Sliders/toggles retain their normal behaviour. On the desktop
               site, touching the original horizontal range still selects it
               (and waits for the user to close the panel before revealing the
               map-side mirror). In the installed PWA / on touch the range only
               drives an already-visible mirror — see the TAP CONCRET block. */
            if (isInteractiveTarget(event.target)) {
                if (event.target === source) sliderTouch(source, event);
                return;
            }
            /* Only a deliberate tap on the layer card adds its slider on the
               map (no scroll gesture, no drag, no second finger). */
            if (!deliberateTap(event)) return;
            selectSource(source, true);
        });

        owner.addEventListener('keydown', function (event) {
            if (event.target !== owner) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectSource(source, true);
                verticalSlider.focus();
            }
        });

        source.addEventListener('pointerdown', function (event) {
            sliderTouch(source, event);
        });
        source.addEventListener('focus', function (event) {
            sliderTouch(source, event);
        });
        source.addEventListener('input', function () {
            var slot = slotForSource(source);
            if (!slot) return;
            syncFromSource(slot);
            if (slot === activeSlot) opacityTipShow();
        });
        source.addEventListener('change', function () {
            var slot = slotForSource(source);
            if (!slot) return;
            syncFromSource(slot);
            if (slot === activeSlot) opacityTipHide();
        });
    }

    /* Înregistrarea unui slider de distanță/rază: aceeași interacțiune ca la
       opacitate (clic pe rând → oglindă + închiderea panoului), plus comutatorul
       stratului, care porneste/oprește și el oglinda. Rândul proprietar e
       `.transp-layer-row` (sliderul de distanță e copil direct al rândului, spre
       deosebire de cele de opacitate, care stau în eticheta rândului). */
    function registerDistanceSource(def) {
        var source = null;
        try { source = document.getElementById(def.id); } catch (e) { source = null; }
        if (!source) return;

        var owner = source.parentElement;
        if (owner && typeof owner.closest === 'function') {
            owner = owner.closest('.transp-layer-row') || owner;
        }
        if (!owner) return;

        if (owner.classList) owner.classList.add('opacity-layer-selectable');
        if (owner.setAttribute) {
            if (!owner.getAttribute('tabindex')) owner.setAttribute('tabindex', '0');
            owner.setAttribute('role', 'group');
            owner.setAttribute('aria-label', 'Select ' + getLayerName(source, owner) + ' distance control');
        }

        owner.addEventListener('click', function (event) {
            if (isInteractiveTarget(event.target)) {
                if (event.target === source) sliderTouch(source, event);
                return;
            }
            if (!deliberateTap(event)) return;
            selectSource(source, true);
        });

        owner.addEventListener('keydown', function (event) {
            if (event.target !== owner) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectSource(source, true);
                verticalSlider.focus();
            }
        });

        source.addEventListener('pointerdown', function (event) { sliderTouch(source, event); });
        source.addEventListener('focus', function (event) { sliderTouch(source, event); });
        source.addEventListener('input', function () {
            var slot = slotForSource(source);
            if (slot) syncFromSource(slot);
            if (slot === activeSlot) opacityTipShow();
        });
        source.addEventListener('change', function () {
            var slot = slotForSource(source);
            if (slot) syncFromSource(slot);
            if (slot === activeSlot) opacityTipHide();
        });

        // Comutatorul stratului (LIDAR Scanner / pin potențial / raport):
        // pornit → oglinda + dock-ul apar; oprit → se ascund, dacă erau pe el.
        var toggle = null;
        try { toggle = def.toggle ? document.getElementById(def.toggle) : null; } catch (e) { toggle = null; }
        if (toggle && toggle.addEventListener && !toggle.dataset.voDistanceWired) {
            toggle.dataset.voDistanceWired = '1';
            toggle.addEventListener('change', function () {
                if (this.checked) selectSource(source, false);
                else {
                    var slot = slotForSource(source);
                    if (slot) hideControl(slot);
                }
            });
        }
    }

    function emitSourceEvent(type, slot) {
        slot = slot || activeSlot;
        if (!slot || !slot.source || !slot.slider) return;
        slot.source.value = slot.slider.value;
        slot.source.dispatchEvent(new Event(type, { bubbles: true }));
        syncFromSource(slot);
    }

    /* Registration for a range that shares its row with an already registered
       range (the Satellite „Istoric” slider sits in the Satellite card next to
       the opacity slider). It must not add a second row-level click handler —
       only the source-level listeners that reveal and drive the mirror. */
    function registerPairedSource(source) {
        var owner = source.parentElement;
        if (!owner) return;

        owner.classList.add('opacity-layer-selectable');
        if (!owner.getAttribute('tabindex')) {
            owner.setAttribute('tabindex', '0');
            owner.setAttribute('role', 'group');
            owner.setAttribute('aria-label', 'Select ' + getLayerName(source, owner) + ' ' + sourceKind(source) + ' control');
        }

        source.addEventListener('pointerdown', function (event) {
            sliderTouch(source, event);
        });
        source.addEventListener('focus', function (event) {
            sliderTouch(source, event);
        });
        source.addEventListener('input', function () {
            if (pairActive) syncPeriodFromSource();
        });
        source.addEventListener('change', function () {
            if (pairActive) syncPeriodFromSource();
        });
    }

    function init() {
        control = document.getElementById('verticalOpacityControl');
        verticalSlider = document.getElementById('verticalOpacitySlider');
        valueOutput = document.getElementById('verticalOpacityValue');
        layerLabel = document.getElementById('verticalOpacityLayer');
        captionEl = document.getElementById('verticalOpacityCaption');
        closeButton = document.getElementById('verticalOpacityClose');
        var secondaryControl = document.getElementById('verticalOpacityControlSecondary');
        var secondarySlider = document.getElementById('verticalOpacitySliderSecondary');
        var secondaryOutput = document.getElementById('verticalOpacityValueSecondary');
        var secondaryLabel = document.getElementById('verticalOpacityLayerSecondary');
        var secondaryCaption = document.getElementById('verticalOpacityCaptionSecondary');
        var secondaryClose = document.getElementById('verticalOpacityCloseSecondary');
        var secondaryActions = document.getElementById('verticalOpacityActionsSecondary');
        periodControl = document.getElementById('verticalSatPeriodControl');
        periodSlider = document.getElementById('verticalSatPeriodSlider');
        periodOutput = document.getElementById('verticalSatPeriodValue');
        periodCaptionEl = document.getElementById('verticalSatPeriodCaption');
        periodLayerLabel = document.getElementById('verticalSatPeriodLayer');
        if (!control || !verticalSlider || !valueOutput || !layerLabel || !closeButton) return;

        mirrorSlotPool = [{
            control: control,
            slider: verticalSlider,
            output: valueOutput,
            label: layerLabel,
            caption: captionEl,
            close: closeButton,
            actions: document.getElementById('verticalOpacityActions'),
            source: null,
            owner: null,
            formatter: percentageText,
            kind: null
        }];
        if (secondaryControl && secondarySlider && secondaryOutput && secondaryLabel && secondaryClose) {
            mirrorSlotPool.push({
                control: secondaryControl,
                slider: secondarySlider,
                output: secondaryOutput,
                label: secondaryLabel,
                caption: secondaryCaption,
                close: secondaryClose,
                actions: secondaryActions,
                source: null,
                owner: null,
                formatter: percentageText,
                kind: null
            });
        }
        setActiveSlot(null);

        /* Opacity in the id intentionally excludes the LIDAR Scanner distance
           range, which shares the panel's visual .transp-slider class. The
           Battles century range is the one deliberate non-opacity mirror: it
           is registered explicitly and renders century labels, not %. */
        var sources = document.querySelectorAll(
            '#transpPanel input.transp-slider[type="range"][id*="Opacity"],' +
            '#transpPanel input.transp-slider[type="range"]#battlesPeriodSlider'
        );
        for (var i = 0; i < sources.length; i++) registerSource(sources[i]);

        /* The Satellite „Istoric” range shares its row with the opacity range,
           so it gets the paired registration (no duplicate row handlers). */
        var satPeriodSource = document.getElementById('satPeriodSlider');
        if (satPeriodSource) registerPairedSource(satPeriodSource);

        /* Sliderele de distanță/rază ale straturilor de analiză: înregistrate
           explicit (vezi DISTANCE_SOURCES), cu dock de acțiune centrat jos. */
        for (var d = 0; d < DISTANCE_SOURCES.length; d++) registerDistanceSource(DISTANCE_SOURCES[d]);

        /* Keep `--slider-pct` filled progress live on every `<input type="range">`
           across the app (layer panel, vertical mirrors, country/CENAGIS rows,
           Other Maps, Josephine settings, and 3D controls). */
        syncAllSlidersIn(document);
        if (typeof document.addEventListener === 'function') {
            var onAnyRangeUpdate = function (event) {
                var t = event && event.target;
                if (t && (t.type === 'range' || (t.getAttribute && t.getAttribute('type') === 'range'))) {
                    syncSliderFill(t);
                }
            };
            document.addEventListener('input', onAnyRangeUpdate, true);
            document.addEventListener('change', onAnyRangeUpdate, true);
        }
        try {
            if (typeof MutationObserver === 'function' && document.body) {
                var rangeObserver = new MutationObserver(function (mutations) {
                    for (var m = 0; m < mutations.length; m++) {
                        var added = mutations[m].addedNodes;
                        if (!added) continue;
                        for (var n = 0; n < added.length; n++) {
                            var node = added[n];
                            if (!node || node.nodeType !== 1) continue;
                            if (node.tagName === 'INPUT' && node.type === 'range') {
                                syncSliderFill(node);
                            } else {
                                syncAllSlidersIn(node);
                            }
                        }
                    }
                });
                rangeObserver.observe(document.body, { childList: true, subtree: true });
            }
        } catch (e) { /* DOM-only tests */ }

        function wireMirrorSlot(slot) {
            if (!slot || !slot.slider) return;
            slot.slider.addEventListener('input', function () {
                if (slot !== activeSlot) setActiveSlot(slot);
                emitSourceEvent('input', slot);
                if (periodTipPinned || slot.output.classList.contains('visible')) showPeriodTip();
                opacityTipShow();
            });
            slot.slider.addEventListener('change', function () {
                if (slot !== activeSlot) setActiveSlot(slot);
                emitSourceEvent('change', slot);
                opacityTipHide();
            });
            slot.slider.addEventListener('pointerenter', function () {
                if (slot === activeSlot) showPeriodTip();
            });
            slot.slider.addEventListener('pointerleave', function () {
                /* The opacity chip has its own fade-out timer; pulling it here
                   would kill the brief readable moment after a drag ends. */
                if (slot !== activeSlot || sourceKind(slot.source || {}) !== 'period') return;
                if (!periodTipPinned) hidePeriodTip(0);
            });
            slot.slider.addEventListener('pointerdown', function () {
                setActiveSlot(slot);
                if (activeSource && sourceKind(activeSource) === 'opacity') showValueTip();
                if (!activeSource || sourceKind(activeSource) !== 'period') return;
                periodTipPinned = true;
                showPeriodTip();
            });
            slot.slider.addEventListener('pointerup', function () {
                opacityTipHide();
                if (slot !== activeSlot || !periodTipPinned) return;
                periodTipPinned = false;
                hidePeriodTip(PERIOD_TIP_HIDE_DELAY);
            });
            slot.slider.addEventListener('pointercancel', function () {
                if (slot === activeSlot && activeSource && sourceKind(activeSource) === 'opacity') hideValueTip(0);
                if (slot !== activeSlot || !periodTipPinned) return;
                periodTipPinned = false;
                hidePeriodTip(0);
            });
            slot.slider.addEventListener('focus', function () {
                setActiveSlot(slot);
                showPeriodTip();
                opacityTipShow();
            });
            slot.slider.addEventListener('blur', function () {
                if (slot !== activeSlot) return;
                if (activeSource && sourceKind(activeSource) === 'period') hidePeriodTip(0);
                opacityTipHide(200);
            });
            if (slot.close && slot.close.addEventListener) {
                slot.close.addEventListener('click', function () { hideControl(slot); });
            }
            if (slot.actions && slot.actions.addEventListener) {
                slot.actions.addEventListener('click', function (event) {
                    var btn = event.target && event.target.closest
                        ? event.target.closest('button')
                        : null;
                    if (!btn || !slot.actions.contains(btn)) return;
                    if (btn.classList) btn.classList.add('show-tip');
                    var id = btn.id || 'tip';
                    if (tipTimers[id]) window.clearTimeout(tipTimers[id]);
                    tipTimers[id] = window.setTimeout(function () {
                        tipTimers[id] = null;
                        if (btn.classList) btn.classList.remove('show-tip');
                    }, TIP_TAP_MS);
                });
            }
        }

        for (var s = 0; s < mirrorSlotPool.length; s++) wireMirrorSlot(mirrorSlotPool[s]);

        /* The paired Satellite period mirror drives the panel's „Istoric”
           range, which owns the actual layer switching (setSatPeriod). */
        if (periodSlider && periodControl) {
            periodSlider.addEventListener('input', function () {
                var periodSource = document.getElementById('satPeriodSlider');
                if (!periodSource) return;
                periodSource.value = periodSlider.value;
                periodSource.dispatchEvent(new Event('input', { bubbles: true }));
                updatePeriodOutput();
            });
            periodSlider.addEventListener('change', function () {
                var periodSource = document.getElementById('satPeriodSlider');
                if (!periodSource) return;
                periodSource.value = periodSlider.value;
                periodSource.dispatchEvent(new Event('change', { bubbles: true }));
                updatePeriodOutput();
            });
        }

        if (typeof window.addEventListener === 'function') {
            window.addEventListener('resize', function () {
                if (activeSlot && activeSlot.output.classList.contains('visible')) positionPeriodTip();
            });
        }

        /* ── Urmărirea gestului (vezi blocul TAP CONCRET) ──
           Înregistrate pe document, în faza de captură, ca un pointerdown
           oprit de alt handler să nu ne scape; click-ul (faza de bule, adică
           DUPĂ handler-ul cardului) închide gestul. */
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('pointerdown', beginGesture, true);
            document.addEventListener('pointerup', endGesture, true);
            document.addEventListener('pointercancel', endGesture, true);
            document.addEventListener('click', function () { dropGesture(); });
        }
        var panelScroller = panelElement();
        if (panelScroller && typeof panelScroller.addEventListener === 'function') {
            panelScroller.addEventListener('scroll', function () {
                lastPanelScrollAt = Date.now();
            }, { passive: true });
        }

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && activeSlot) closeAllControls();
        });

        /* Bilingual mirrors: the layer name, the caption that mirrors still carry
           (PERIOADĂ / ISTORIC) and the formatted value follow the live language.
           Plain opacity mirrors have no caption any more. */
        document.addEventListener('detectlab:langchange', function () {
            for (var i = 0; i < mirrorSlots.length; i++) {
                var slot = mirrorSlots[i];
                if (!slot || !slot.source || !slot.owner) continue;
                var name = getLayerName(slot.source, slot.owner);
                slot.label.textContent = layerTitleText(name);
                slot.label.title = name;
                if (slot.caption) slot.caption.textContent = sourceCaption(slot.source);
                syncFromSource(slot);
            }
            if (pairActive) {
                var satName = activeSource && activeOwner
                    ? getLayerName(activeSource, activeOwner) : 'Satellite';
                if (periodLayerLabel) {
                    periodLayerLabel.textContent = layerTitleText(satName);
                    periodLayerLabel.title = satName;
                }
                var periodSource = document.getElementById('satPeriodSlider');
                if (periodCaptionEl && periodSource) {
                    periodCaptionEl.textContent = sourceCaption(periodSource);
                }
                updatePeriodOutput();
            }
            syncDistanceDock();
            refreshMirroredRows();
            refreshLayerActionVisibility();
            syncActionAriaLabels();
        });

        /* Small public surface for integration tests and for any map module
           that needs to focus a layer without synthesising a card click. */
        window.DetectLabVerticalOpacity = {
            select: function (sliderId) {
                var source = document.getElementById(sliderId);
                if (source) selectSource(source, false);
            },
            close: closeAllControls,
            /* Închide DOAR oglinda sliderului dat, lăsând celelalte oglinzi
               (și straturile lor) neatinse. Modulele de analiză (LIDAR
               Scanner, Zone cu potențial arheologic, Raport arheologic) o
               apelează când stratul lor se oprește programatic, fără
               eveniment „change” pe comutator; vechiul api.close() închidea
               TOATE oglinzile de pe ecran, deci închiderea sliderului adăugat
               al doilea stinge și sliderul + stratul alăturat. No-op dacă
               oglinda nu e pe ecran. */
            closeFor: function (sliderId) {
                var source = null;
                try { source = document.getElementById(sliderId); } catch (e) { source = null; }
                if (!source) return;
                var slot = slotForSource(source);
                if (slot) { hideControl(slot); return; }
                /* Perechea Satellite: oglinda de ISTORIC nu are slot propriu în
                   mirrorSlots; „închiderea” pe id-ul ei înseamnă închiderea
                   întregii perechi, exact ca butonul „×” al oglinzii ei. */
                if (isSatellitePairId(sliderId) && pairActive) hideControl();
            },
            getActiveSliderId: function () {
                return activeSource ? activeSource.id : null;
            },
            /* map-app.js arată iconițele APM 2.0 / Iosefină cât timp oglinda
               propriului strat este vizibilă; focusul poate fi pe vecin. */
            isActiveFor: isVerticalActiveFor,
            refreshActions: refreshLayerActionVisibility,
            refreshDock: syncDistanceDock
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
