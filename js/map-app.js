        /* ── Layer Panel Tab Switching ── */
        function switchLayerTab(tab) {
            // Update active tab button
            document.querySelectorAll('.transp-panel-tabs button').forEach(btn => {
                btn.classList.remove('active');
                if (btn.dataset.tab === tab) {
                    btn.classList.add('active');
                }
            });

            // Update visibility of layer rows and dividers
            document.querySelectorAll('[data-category]').forEach(el => {
                el.classList.remove('active');
                if (el.dataset.category === tab) {
                    el.classList.add('active');
                }
            });
            if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
        }

        // Initialize with "free" tab active on page load
        window.addEventListener('load', function() {
            switchLayerTab('free');
        });

        // ── Înălțimea reală a containerelor de sublayeruri (accordion) ──
        // Containerle (histSubLayers, lidarSubLayers, romanSubLayers,
        // histPremiumSubLayers) se animau cu un max-height HARDCODED
        // (900/1100/1200/1000px) + overflow:hidden. Când conținutul depășea
        // plafonul (zoom de browser, fonturi mai mari, harti noi adăugate),
        // ultimele rânduri erau tăiate — ex. "Hartă administrativă a Galiției
        // și Lodomeriei – 1855" (ultima din Harti istorice PREMIUM) nu mai
        // era vizibilă în totalitate. Măsurăm înălțimea naturală la fiecare
        // expandare în loc să folosim valori fixe. fallbackPx rămâne
        // salvăgarda doar dacă conținutul nu poate fi măsurat (ex. tab-ul e
        // display:none → scrollHeight 0).
        //
        // Varianta PWA mobilă a re-tăiat totuși ultima casuță: un max-height
        // FINIT, oricât de precis la momentul măsurării, rămâne un plafon
        // rigid pe care conținutul îl poate depăși ulterior (încărcare fonturi,
        // PWA suspendare/rezumat, zoom text/browser, rotație de ecran,
        // fallback 1000px când panoul e nemăsurabil). Din această cauză,
        // după ce se termină animația de expandare (0.3s + re-măsurarea de
        // la 0.4s), constrângerea se ELIBEREAZĂ complet (max-height:none) —
        // casuța nu se mai poate clipa niciodată, iar scroll-ul e preluat
        // de .transp-panel (overflow-y:auto), care în PWA are înălțimea
        // completă a ecranului. La collapse, dacă plafonul e deja eliberat,
        // fixăm întâi înălțimea curentă (reflow) ca tranziția 0.3s să
        // pornească de la o valoare animabilă, nu din 'none'.
        function measureSubLayersHeight(panel) {
            if (!panel) return 0;
            // Măsurăm fără tăiere: dezactivăm temporar max-height, forțăm
            // layoutul și citim scrollHeight. Toate schimburile sunt
            // sincronice (fără paint intermediar) → niciun flicker, iar
            // tranziția CSS pornește de la valoarea randată anterior (0)
            // către valoarea finală măsurată.
            var prev = panel.style.maxHeight;
            var h = 0;
            try {
                panel.style.maxHeight = 'none';
                h = panel.scrollHeight;
            } catch (e) {
                h = 0;
            }
            panel.style.maxHeight = prev || '0';
            return h;
        }

        function setSubLayersMaxHeight(panel, expanded, fallbackPx) {
            if (!panel) return;
            // Oprit orice eliberare programată — starea următoare o reia.
            if (panel._subLayersReleaseTimer) {
                clearTimeout(panel._subLayersReleaseTimer);
                panel._subLayersReleaseTimer = null;
            }
            if (!expanded) {
                // Dacă plafonul fusese eliberat (max-height:none), browserul
                // nu poate anima 'none' → '0'. Fixăm înălțimea curentă și
                // forțăm layoutul ca tranziția să aibă punct de plecare.
                if (panel.style.maxHeight === 'none') {
                    panel.style.maxHeight = panel.scrollHeight + 'px';
                    void panel.offsetHeight;
                }
                panel.style.maxHeight = '0';
                return;
            }
            var h = measureSubLayersHeight(panel);
            if (!(h > 0)) h = fallbackPx || 1000;
            panel.style.maxHeight = h + 'px';
            // Re-măsurăm după tranziție (0.3s), pe cazuri în care
            // conținutul se mută târziu (încărcare fonturi, PWA resume).
            // Se actualizează doar dacă secțiunea e încă expandată.
            setTimeout(function () {
                var current = parseInt(panel.style.maxHeight, 10) || 0;
                if (current > 0) {
                    var h2 = measureSubLayersHeight(panel);
                    if (h2 > 0) panel.style.maxHeight = h2 + 'px';
                }
            }, 400);
            // ── Fix PWA mobil: eliberarea plafonului după animație ──
            // Până la eliberare, tranziția 0 → h (și re-măsurarea) rulează
            // normal; apoi max-height devine 'none' pentru totdeauna, deci
            // nicio creștere ulterioară a conținutului nu mai poate tăia
            // ultima casuță (ex. Galiția & Lodomeria 1855 în varianta
            // standalone iOS/Android). Se eliberează doar dacă secțiunea
            // e încă expandată — collapse-ul rapid (înainte de 800ms) a
            // anulat deja timerul de mai sus și setează '0'.
            panel._subLayersReleaseTimer = setTimeout(function () {
                panel._subLayersReleaseTimer = null;
                var cur = panel.style.maxHeight;
                if (cur !== '0' && cur !== '0px' && cur !== 'none') {
                    panel.style.maxHeight = 'none';
                }
            }, 800);
        }

        function _isEuropeMarket() {
            try {
                if (typeof window !== 'undefined' && window.DetectLabSite && typeof window.DetectLabSite.isEurope === 'boolean') {
                    return window.DetectLabSite.isEurope;
                }
                if (typeof window !== 'undefined' && window.location && window.location.hostname) {
                    return window.location.hostname.toLowerCase().indexOf('detectlab.eu') !== -1;
                }
            } catch (e) {}
            return false;
        }

        (function initMap() {
            var ROMANIA_BOUNDS = L.latLngBounds([[43.5, 19.5], [48.5, 30.5]]);

            // ── SEARCH BAR (OSM Places ArcGIS — fără rate-limit) ──
            var searchDebounce = null;
            var selectedIndex = -1;
            var searchMarker = null;
            var _searchCache = {};
            // ── SURSA DATE OSM (fișier GeoJSON static pe Cloudflare R2) ──
            // Înlocuiește vechiul backend ArcGIS/Worker. Fișierul se încarcă o singură
            // dată și e refolosit atât de search bar, cât și de layerul OSM Places.
            var OSM_GEOJSON_URL = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/OSM.geojson';
            var _osmGeojsonFeatures = null;
            var _osmGeojsonPromise = null;

            // ── LOCALITĂȚI ADAUSE MANUAL (completare pentru OSM.geojson) ──────
            // Fișierul OSM.geojson de pe R2 e generat în afara repository-ului și
            // nu conține toate cartierele/cătunele utile pe teren. Listă mică,
            // întreținută manual: fiecare intrare e transformată într-o facilitate
            // GeoJSON identică ca structură cu cele din sursă, deci apare automat
            // și pe layerul „OSM Places”, și în bara de search (și, prin ea, în
            // „Biblioteca din Babel”). Adăugarea unei localități noi = o linie aici.
            // Coordonatele se verifică înainte (ex. reverse-geocoding OSM/Nominatim).
            var OSM_MANUAL_PLACES = [
                // Colțan — cartier al Bocșei Montane, oraș Bocșa (OSM place=quarter,
                // nod 13418756573), județul Caraș-Severin.
                { lat: 45.367584, lon: 21.802154, name: 'Colțan', fclass: 'suburb', judet: 'Caraș-Severin' }
            ];
            window.OSM_MANUAL_PLACES = OSM_MANUAL_PLACES;

            // Caută prima proprietate existentă (și nenulă) dintr-o listă de nume
            // posibile de câmp — util pentru că fișierul GeoJSON poate avea
            // denumiri diferite pentru județ în funcție de sursă (judet/county/admin...).
            function _pickOsmProp(props, candidates) {
                for (var i = 0; i < candidates.length; i++) {
                    if (props[candidates[i]]) return props[candidates[i]];
                }
                var lower = candidates.map(function (c) { return c.toLowerCase(); });
                for (var key in props) {
                    if (lower.indexOf(key.toLowerCase()) !== -1 && props[key]) return props[key];
                }
                return null;
            }

            // Elimină diacriticele românești, aducând textul la forma de bază
            // (ă/â -> a, ș/ş -> s, ț/ţ -> t, î -> i). Folosită pentru search:
            // comparăm termenul căutat și numele localității ambele normalizate,
            // ca "sacalaseni" să găsească "Săcălășeni" indiferent de lungime.
            function normalizeRoDiacritics(str) {
                return (str || '')
                    .replace(/[ăâ]/g, 'a')
                    .replace(/[șş]/g, 's')
                    .replace(/[țţ]/g, 't')
                    .replace(/î/g, 'i');
            }

            // Împarte un termen de căutare de forma "Săcălășeni, Maramureș" în
            // numele localității și un calificator (județ). Fără virgulă, tot
            // textul e tratat drept nume de localitate.
            function splitLocalityQuery(term) {
                var parts = String(term || '').split(',');
                var name = normalizeRoDiacritics(String(parts.shift() || '').trim().toLowerCase());
                var qualifier = normalizeRoDiacritics(
                    parts.join(' ').toLowerCase()
                        .replace(/\b(jud|jude[țt]|judetul|jude[țt]ul|county)\b\.?/g, ' ')
                        .replace(/[.]/g, ' ')
                ).replace(/\s+/g, ' ').trim();
                return { name: name, qualifier: qualifier };
            }

            // Căutarea de localități folosită de bara de search — expusă și pentru
            // alte funcționalități (ex. „Biblioteca din Babel”), ca toate să
            // găsească aceleași localități, insensibil la diacritice.
            function osmPlaceLookup(term, limit) {
                // For a selected non-RO country, search uses the European
                // europe-places.geojsonseq dataset filtered to that country.
                // Romania keeps OSM.geojson, real counties, and manual place entries.
                var selIso = String((window && window._detectlabSelectedCountry) || '').toUpperCase();
                if (selIso && selIso !== 'RO' && EU_COUNTRY_TOKENS[selIso]) {
                    return europePlaceLookup(selIso, term, limit);
                }
                var parsed = splitLocalityQuery(term);
                var searchNorm = parsed.name;
                var qualifier = parsed.qualifier;
                if (!searchNorm) return Promise.resolve([]);
                return loadOsmGeojson().then(function (features) {
                    var matches = [];
                    for (var i = 0; i < features.length; i++) {
                        var feat = features[i];
                        var lnameNorm = feat._lnameNorm || '';
                        var ljudetNorm = feat._ljudetNorm || '';
                        if (!lnameNorm) continue;
                        var hit = lnameNorm.indexOf(searchNorm) === 0;
                        var hitJudet = !hit && !qualifier && ljudetNorm && ljudetNorm.indexOf(searchNorm) === 0;
                        // Potrivire după numele localității are prioritate; dacă nu
                        // există, dar termenul căutat se potrivește cu județul,
                        // afișăm și localitățile din acel județ.
                        if (!hit && !hitJudet) continue;
                        // "Săcălășeni, Maramureș" — calificatorul restrânge la județ.
                        if (qualifier && ljudetNorm.indexOf(qualifier) !== 0 && qualifier.indexOf(ljudetNorm) !== 0) continue;
                        var coords = feat.geometry && feat.geometry.coordinates;
                        if (!coords) continue;
                        var props = feat.properties || {};
                        matches.push({
                            lat: coords[1],
                            lon: coords[0],
                            display_name: props.name || props.NAME || '',
                            fclass: props.fclass || props.type || '',
                            judet: feat._judet || '',
                            population: props.population || props.pop || 0,
                            _exact: lnameNorm === searchNorm,
                            _matchedByJudet: !hit && hitJudet
                        });
                    }
                    // Localitățile care se potrivesc direct după nume apar înaintea
                    // celor găsite doar prin numele județului; în interiorul fiecărui
                    // grup, ordonăm după potrivire exactă și apoi după populație.
                    matches.sort(function (a, b) {
                        if (a._matchedByJudet !== b._matchedByJudet) {
                            return a._matchedByJudet ? 1 : -1;
                        }
                        if (a._exact !== b._exact) return a._exact ? -1 : 1;
                        return (b.population || 0) - (a.population || 0);
                    });
                    return matches.slice(0, limit || 8);
                });
            }
            window._osmPlaceLookup = osmPlaceLookup;

            // Pregătește o facilitate pentru search: nume + județ normalizate
            // (lowercase, fără diacritice), calculate o singură dată la încărcare.
            function _annotateOsmFeature(feat) {
                var props = feat.properties || {};
                var name = props.name || props.NAME || '';
                feat._lname = name.toLowerCase();
                feat._lnameNorm = normalizeRoDiacritics(feat._lname);
                var judet = _pickOsmProp(props, [
                    // Structura administrativă reală din fișierul OSM.geojson:
                    // adm2_name = județul (ex: "Constanța"), adm1_name = macroregiunea (ex: "Sud-Est").
                    'adm2_name', 'ADM2_NAME',
                    'judet', 'JUDET', 'Judet', 'județ', 'JUDEȚ', 'Județ',
                    'county', 'COUNTY', 'County',
                    'admin', 'ADMIN', 'admin_name', 'ADMIN_NAME',
                    'NAME_1', 'region', 'REGION', 'Region',
                    'adm1_name', 'ADM1_NAME'
                ]);
                feat._judet = judet || '';
                feat._ljudet = (judet || '').toLowerCase();
                feat._ljudetNorm = normalizeRoDiacritics(feat._ljudet);
                return feat;
            }

            // Intrările din OSM_MANUAL_PLACES, în același format ca restul sursei.
            function _manualOsmFeatures() {
                var out = [];
                for (var i = 0; i < OSM_MANUAL_PLACES.length; i++) {
                    var p = OSM_MANUAL_PLACES[i];
                    if (p == null || !p.name || p.lat == null || p.lon == null) continue;
                    out.push(_annotateOsmFeature({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                        properties: {
                            name: p.name,
                            fclass: p.fclass || 'locality',
                            adm2_name: p.judet || '',
                            population: p.population || 0,
                            // fid propriu, ca layerul OSM Places să nu-l confunde cu
                            // o facilitate din sursă (vezi _osmPlacesFetch).
                            fid: 'manual_' + p.lat + '_' + p.lon,
                            manual: true
                        }
                    }));
                }
                return out;
            }

            // Adaugă localitățile manuale în setul încărcat, fără duplicate: dacă
            // sursa conține deja același nume la mai puțin de ~1 km, nu mai inserăm
            // (altfel ar apărea două etichete suprapuse pe hartă).
            function _mergeManualPlaces(feats) {
                var extra = _manualOsmFeatures();
                for (var i = 0; i < extra.length; i++) {
                    var f = extra[i];
                    var c = f.geometry.coordinates;
                    var alreadyThere = false;
                    for (var j = 0; j < feats.length; j++) {
                        var o = feats[j].geometry && feats[j].geometry.coordinates;
                        if (!o) continue;
                        // 0.01° latitudine ≈ 1.11 km; 0.014° longitudine ≈ 1.1 km la 45°N.
                        if (feats[j]._lnameNorm === f._lnameNorm &&
                            Math.abs(o[1] - c[1]) < 0.01 && Math.abs(o[0] - c[0]) < 0.014) {
                            alreadyThere = true;
                            break;
                        }
                    }
                    if (!alreadyThere) feats.push(f);
                }
                return feats;
            }

            function loadOsmGeojson() {
                if (_osmGeojsonFeatures) return Promise.resolve(_osmGeojsonFeatures);
                if (_osmGeojsonPromise) return _osmGeojsonPromise;
                _osmGeojsonPromise = fetch(OSM_GEOJSON_URL)
                    .then(function (res) {
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        return res.json();
                    })
                    .then(function (data) {
                        var feats = (data && data.features) ? data.features : [];
                        // Precalculăm numele normalizat (lowercase + fără diacritice) o
                        // singură dată, pentru search rapid pe tot setul de date.
                        for (var i = 0; i < feats.length; i++) _annotateOsmFeature(feats[i]);
                        _mergeManualPlaces(feats);
                        _osmGeojsonFeatures = feats;
                        if (feats.length) {
                            console.log('[OSM DEBUG] Exemplu properties pentru prima localitate:', feats[0].properties);
                            console.log('[OSM DEBUG] Chei disponibile:', Object.keys(feats[0].properties || {}));
                        }
                        return _osmGeojsonFeatures;
                    })
                    .catch(function (err) {
                        console.warn('[OSM] Eroare la încărcarea sursei GeoJSON:', err.message);
                        // Chiar fără sursa remote, localitățile adăugate manual rămân
                        // disponibile (search + layer OSM Places).
                        _osmGeojsonFeatures = _mergeManualPlaces([]);
                        return _osmGeojsonFeatures;
                    });
                return _osmGeojsonPromise;
            }

            // Pornim încărcarea din timp, ca datele să fie deja în cache
            // când utilizatorul caută sau activează layerul.
            loadOsmGeojson();

            // ── LOCALITĂȚI EUROPENE (europe-places.geojsonseq — Supabase) ─────
            // When a selected-country event is available, search matches that
            // country's localities instead of only the Romanian OSM dataset.
            // European places stream from Supabase once per selected country;
            // only that country's matches stay in memory. Romania keeps OSM.geojson.
            var EUROPE_PLACES_URL = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/europe-places.geojsonseq';
            var EUROPE_PLACES_MAX = 150000;    // plafon de memorie per țară
            var _euPlacesByIso = {};           // ISO2 -> features anotate
            var _euPlacesPromises = {};        // ISO2 -> promisiune în curs

            // ISO2 -> [ISO3 + English names] for the ArcGIS atlas country list.
            // The source file may identify a country by ISO2, ISO3, or name;
            // all are normalised to ISO2 here.
            var EU_COUNTRY_TOKENS = {
                AL: ['ALB', 'albania'], AD: ['AND', 'andorra'], AM: ['ARM', 'armenia'],
                AT: ['AUT', 'austria'], AZ: ['AZE', 'azerbaijan'], BY: ['BLR', 'belarus'],
                BE: ['BEL', 'belgium'], BA: ['BIH', 'bosnia and herzegovina', 'bosnia and herz'],
                BG: ['BGR', 'bulgaria'], HR: ['HRV', 'croatia'], CY: ['CYP', 'cyprus'],
                CZ: ['CZE', 'czechia', 'czech republic'], DK: ['DNK', 'denmark'],
                EE: ['EST', 'estonia'], FI: ['FIN', 'finland'], FR: ['FRA', 'france'],
                GE: ['GEO', 'georgia'], DE: ['DEU', 'germany'], GR: ['GRC', 'greece'],
                HU: ['HUN', 'hungary'], IS: ['ISL', 'iceland'], IE: ['IRL', 'ireland'],
                IT: ['ITA', 'italy'], XK: ['XKX', 'KOS', 'kosovo'], LV: ['LVA', 'latvia'],
                LI: ['LIE', 'liechtenstein'], LT: ['LTU', 'lithuania'], LU: ['LUX', 'luxembourg'],
                MT: ['MLT', 'malta'], MD: ['MDA', 'moldova', 'republic of moldova'],
                MC: ['MCO', 'monaco'], ME: ['MNE', 'montenegro'],
                NL: ['NLD', 'netherlands', 'holland'], MK: ['MKD', 'north macedonia', 'macedonia'],
                NO: ['NOR', 'norway'], PL: ['POL', 'poland'], PT: ['PRT', 'portugal'],
                RO: ['ROU', 'romania'], RU: ['RUS', 'russia', 'russian federation'],
                SM: ['SMR', 'san marino'], RS: ['SRB', 'serbia', 'republic of serbia'],
                SK: ['SVK', 'slovakia'], SI: ['SVN', 'slovenia'], ES: ['ESP', 'spain'],
                SE: ['SWE', 'sweden'], CH: ['CHE', 'switzerland'],
                TR: ['TUR', 'turkey', 'turkiye'], UA: ['UKR', 'ukraine'],
                GB: ['GBR', 'united kingdom', 'great britain'],
                VA: ['VAT', 'vatican', 'vatican city', 'holy see']
            };
            var _euTokenToIso = {};
            Object.keys(EU_COUNTRY_TOKENS).forEach(function (iso) {
                _euTokenToIso[iso] = iso;
                EU_COUNTRY_TOKENS[iso].forEach(function (tok) {
                    _euTokenToIso[/^[A-Z]{2,3}$/.test(tok) ? tok : tok.toLowerCase()] = iso;
                });
            });

            // Pliere generică de diacritice pentru nume europene: NFD + câteva
            // litere fără descompunere (ß, ø, ł…). normalizeRoDiacritics acoperă
            // doar literele românești — suficient pentru OSM.geojson (RO), dar
            // „Munchen" trebuie să găsească „München", „Lodz" pe „Łódź" etc.
            function _euFold(s) {
                s = String(s || '').toLowerCase();
                try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
                return s
                    .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/đ/g, 'd')
                    .replace(/ł/g, 'l').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
                    .replace(/þ/g, 'th').replace(/ð/g, 'd');
            }

            // „FR" / „FRA" / „France" / „Türkiye" → codul ISO2. Diacriticele
            // generice sunt pliate, nu doar cele românești.
            function _euResolveCountryToken(value) {
                if (value == null) return null;
                var s = String(value).trim();
                if (!s) return null;
                if (/^[A-Za-z]{2,3}$/.test(s)) return _euTokenToIso[s.toUpperCase()] || null;
                var norm = _euFold(s).replace(/[^a-z0-9]+/g, ' ').trim();
                return _euTokenToIso[norm] || null;
            }

            // Prima proprietate de țară REZOLVABILĂ câștigă (nu doar prima
            // nenulă): un fișier poate avea și 'country_code' și 'country'.
            var _EU_COUNTRY_PROPS = [
                'iso_a2', 'ISO_A2', 'iso2', 'ISO2', 'country_code', 'COUNTRY_CODE', 'countryCode',
                'cc', 'CC', 'cntr_id', 'CNTR_ID', 'cntr_code', 'CNTR_CODE',
                'iso_3166_1', 'ISO3166-1', 'ISO3166_1',
                'iso_a3', 'ISO_A3', 'iso3', 'ISO3', 'adm0_a3', 'ADM0_A3', 'sov_a3', 'SOV_A3',
                'country', 'COUNTRY', 'Country', 'country_name', 'COUNTRY_NAME',
                'cntr_name', 'CNTR_NAME', 'admin', 'ADMIN', 'adm0_name', 'ADM0_NAME',
                'sovereignt', 'SOVEREIGNT', 'addr:country'
            ];
            function _euIsoOfPlaceProps(props) {
                props = props || {};
                for (var i = 0; i < _EU_COUNTRY_PROPS.length; i++) {
                    var v = props[_EU_COUNTRY_PROPS[i]];
                    if (v == null || v === '') continue;
                    var iso = _euResolveCountryToken(v);
                    if (iso) return iso;
                }
                return null;
            }

            // Punctul reprezentativ al unei facilități: geometria Point direct,
            // altfel centrul bbox-ului primului inel (poligoane/linii).
            function _euPlacePoint(geom) {
                if (!geom) return null;
                var c = geom.coordinates;
                if (geom.type === 'Point') {
                    return (c && isFinite(+c[0]) && isFinite(+c[1])) ? [+c[0], +c[1]] : null;
                }
                if (geom.type === 'MultiPoint') {
                    return (c && c[0] && isFinite(+c[0][0])) ? [+c[0][0], +c[0][1]] : null;
                }
                var ring = null;
                if (geom.type === 'Polygon') ring = c && c[0];
                else if (geom.type === 'MultiPolygon') ring = c && c[0] && c[0][0];
                else if (geom.type === 'LineString') ring = c;
                else if (geom.type === 'MultiLineString') ring = c && c[0];
                if (!ring || !ring.length) return null;
                var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
                for (var i = 0; i < ring.length; i++) {
                    var x = +ring[i][0], y = +ring[i][1];
                    if (!isFinite(x) || !isFinite(y)) continue;
                    if (x < w) w = x; if (x > e) e = x;
                    if (y < s) s = y; if (y > n) n = y;
                }
                return isFinite(w) ? [(w + e) / 2, (s + n) / 2] : null;
            }

            // GeoJSON Text Sequences (RFC 8142) pot prefixa fiecare înregistrare
            // cu Record Separator (0x1E); NDJSON simplu nu o face niciodată.
            function _euParseSeqLine(line) {
                if (!line) return null;
                line = String(line).replace(/^\u001e/, '').trim();
                if (!line) return null;
                try {
                    var obj = JSON.parse(line);
                    if (obj && obj.geometry) return obj;
                } catch (e) {}
                return null;
            }

            // Decide dacă o înregistrare aparține țării selectate și o anotează
            // pentru search (nume/regiune normalizate — același tratament ca
            // _annotateOsmFeature pentru sursa RO). Țara se ia din proprietăți;
            // without country attribution, fall back to a small-margin bbox
            // test using the selected country's bounds from the ArcGIS atlas.
            function _euAcceptPlace(obj, iso, bbox) {
                if (!obj || !obj.geometry) return null;
                var pt = _euPlacePoint(obj.geometry);
                if (!pt) return null;
                var props = obj.properties || {};
                var propIso = _euIsoOfPlaceProps(props);
                if (propIso) {
                    if (propIso !== iso) return null;
                } else if (bbox) {
                    if (pt[0] < bbox[0] - 0.05 || pt[0] > bbox[2] + 0.05 ||
                        pt[1] < bbox[1] - 0.05 || pt[1] > bbox[3] + 0.05) return null;
                } else {
                    return null;
                }
                var name = _pickOsmProp(props, [
                    'name', 'NAME', 'Name', 'name_en', 'NAME_EN', 'asciiname', 'ASCIINAME',
                    'place_name', 'PLACE_NAME', 'label', 'LABEL', 'namn', 'NAMN'
                ]);
                if (!name) return null;
                obj._euLon = pt[0];
                obj._euLat = pt[1];
                obj._euName = String(name);
                obj._lnameNorm = _euFold(obj._euName);
                obj._euFclass = String(_pickOsmProp(props, [
                    'fclass', 'FCLASS', 'place', 'PLACE', 'type', 'TYPE',
                    'feature_code', 'FEATURE_CODE', 'fcode', 'FCODE', 'class', 'CLASS'
                ]) || '');
                var region = _pickOsmProp(props, [
                    'adm1_name', 'ADM1_NAME', 'admin1', 'ADMIN1', 'admin1_name',
                    'state', 'STATE', 'province', 'PROVINCE', 'region', 'REGION',
                    'county', 'COUNTY', 'adm2_name', 'ADM2_NAME', 'NAME_1'
                ]);
                obj._euRegion = region ? String(region) : '';
                obj._euRegionNorm = _euFold(obj._euRegion);
                obj._euPop = Number(_pickOsmProp(props, [
                    'population', 'POPULATION', 'pop', 'POP', 'pop_max', 'POP_MAX'
                ])) || 0;
                return obj;
            }

            // Stream-uiește fișierul și păstrează doar localitățile țării `iso`.
            // Memoria rămâne proporțională cu o singură țară, indiferent cât de
            // mare e fișierul european complet.
            function _euStreamPlaces(iso, bbox) {
                return fetch(EUROPE_PLACES_URL).then(function (res) {
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    var kept = [];
                    function take(line) {
                        if (kept.length >= EUROPE_PLACES_MAX) return;
                        var f = _euAcceptPlace(_euParseSeqLine(line), iso, bbox);
                        if (f) kept.push(f);
                    }
                    if (!res.body || typeof TextDecoder === 'undefined' || !res.body.getReader) {
                        return res.text().then(function (text) {
                            var lines = text.split(/\r?\n/);
                            for (var i = 0; i < lines.length; i++) take(lines[i]);
                            return kept;
                        });
                    }
                    var reader = res.body.getReader();
                    var decoder = new TextDecoder('utf-8');
                    var buffer = '';
                    function pump() {
                        return reader.read().then(function (r) {
                            if (r.done) { take(buffer); return kept; }
                            buffer += decoder.decode(r.value, { stream: true });
                            var parts = buffer.split('\n');
                            buffer = parts.pop();
                            for (var i = 0; i < parts.length; i++) take(parts[i]);
                            if (kept.length >= EUROPE_PLACES_MAX) {
                                try { reader.cancel(); } catch (e) {}
                                return kept;
                            }
                            return pump();
                        });
                    }
                    return pump();
                });
            }

            function loadEuropePlaces(iso) {
                iso = String(iso || '').toUpperCase();
                if (_euPlacesByIso[iso]) return Promise.resolve(_euPlacesByIso[iso]);
                if (_euPlacesPromises[iso]) return _euPlacesPromises[iso];
                var bbox = (window._detectlabSelectedCountry === iso &&
                    Array.isArray(window._detectlabCountryBounds) &&
                    window._detectlabCountryBounds.length === 4)
                    ? window._detectlabCountryBounds : null;
                _euPlacesPromises[iso] = _euStreamPlaces(iso, bbox)
                    .then(function (features) {
                        _euPlacesByIso[iso] = features;
                        console.log('[EU Places] ' + features.length + ' localități pentru ' + iso + ' din europe-places.geojsonseq');
                        return features;
                    })
                    .catch(function (err) {
                        // nu memorăm eșecul: următoarea căutare poate reîncerca
                        delete _euPlacesPromises[iso];
                        console.warn('[EU Places] Eroare la încărcarea localităților pentru ' + iso + ':', err.message);
                        throw err;
                    });
                return _euPlacesPromises[iso];
            }

            // Aceeași semantică de potrivire ca osmPlaceLookup (prefix pe numele
            // normalizat, calificator „Localitate, Regiune", sortare exact →
            // populație), dar pe setul european al țării selectate.
            function europePlaceLookup(iso, term, limit) {
                var parsed = splitLocalityQuery(term);
                if (!parsed.name) return Promise.resolve([]);
                // plierea generică se aplică și termenului căutat, ca ambele
                // părți ale comparației să fie în aceeași formă de bază
                var qName = _euFold(parsed.name);
                var qQualifier = _euFold(parsed.qualifier);
                return loadEuropePlaces(iso).then(function (features) {
                    var matches = [];
                    for (var i = 0; i < features.length; i++) {
                        var f = features[i];
                        if (!f._lnameNorm) continue;
                        var hit = f._lnameNorm.indexOf(qName) === 0;
                        var hitRegion = !hit && !qQualifier && f._euRegionNorm &&
                            f._euRegionNorm.indexOf(qName) === 0;
                        if (!hit && !hitRegion) continue;
                        if (qQualifier && f._euRegionNorm.indexOf(qQualifier) !== 0 &&
                            qQualifier.indexOf(f._euRegionNorm) !== 0) continue;
                        matches.push({
                            lat: f._euLat,
                            lon: f._euLon,
                            display_name: f._euName,
                            fclass: f._euFclass,
                            judet: '',             // eticheta „jud." e doar pentru sursa RO
                            region: f._euRegion,
                            population: f._euPop,
                            _exact: f._lnameNorm === qName,
                            _matchedByJudet: hitRegion
                        });
                    }
                    matches.sort(function (a, b) {
                        if (a._matchedByJudet !== b._matchedByJudet) {
                            return a._matchedByJudet ? 1 : -1;
                        }
                        if (a._exact !== b._exact) return a._exact ? -1 : 1;
                        return (b.population || 0) - (a.population || 0);
                    });
                    return matches.slice(0, limit || 8);
                });
            }

            // Expus pentru teste (test-europe-places-search.js) și debugging.
            window._dlEuroPlaces = {
                url: EUROPE_PLACES_URL,
                resolveCountry: _euResolveCountryToken,
                isoOfProps: _euIsoOfPlaceProps,
                parseLine: _euParseSeqLine,
                accept: _euAcceptPlace,
                load: loadEuropePlaces,
                lookup: europePlaceLookup,
                _cache: _euPlacesByIso
            };

            // Preload the selected country's localities as soon as the ArcGIS
            // atlas sends its selection, so the first search is fast.
            document.addEventListener('detectlab:country-selected', function (e) {
                var iso = e && e.detail && String(e.detail.iso || '').toUpperCase();
                if (iso && iso !== 'RO' && EU_COUNTRY_TOKENS[iso]) {
                    loadEuropePlaces(iso).catch(function () {});
                }
            });


            // ── SURSA DATE UAT/Buildings (fișier GeoJSON static pe Cloudflare R2) ──
            // Înlocuiește vechile tile-uri vectoriale .pbf (tippecanoe, OSM/pbf_tiles).
            // Fișierul se încarcă o singură dată și e refolosit atât de layerul UAT
            // (randare directă pe hartă), cât și de funcționalitatea "clădiri dispărute"
            // (verificare dacă există deja o clădire modernă lângă un poligon candidat).
            // ── UAT — sursă raster (tile-uri PNG pe Cloudflare R2) ──────────────────
            // Fiecare tile e o imagine 256×256. Confirmat empiric pe hartă (nu doar pe
            // tile-uri de test izolate): pixelii întunecați + opaci sunt cei desenați
            // roșu pe strat, și reprezintă de fapt zone FĂRĂ o clădire actuală (opusul
            // denumirii inițiale "negru = clădire"). Cu alte cuvinte: roșu = fără
            // clădire acum. Această convenție e păstrată neschimbată pentru afișare (nu
            // contează cum se numește, doar cum arată) — vezi mai jos, la logica pentru
            // "clădiri dispărute", unde folosim explicit polul opus.
            var UAT_TILE_URL = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/UAT/{z}/{x}/{y}.png';
            // Expus pentru straturile de analiză care citesc aceleași tile-uri ca
            // pixeli (js/archeo-potential.js pre-încarcă rasterul pentru zona
            // analizată, cu timeout + retry, în loc să depindă de un singur pixel
            // din cache-ul aplicației). Rămâne aceeași sursă, același TMS y-flip.
            window.UAT_TILE_URL = UAT_TILE_URL;
            window.UAT_TILE_Y_FOR_URL = function (y, z) { return Math.pow(2, z) - 1 - y; };
            // Reglabil live din consolă, fără redeploy: window.UAT_TILE_Z.
            // CONFIRMAT (2026-07, test live consolă): nivelul nativ real la care există
            // tile-urile UAT/Buildings pe R2 e 14, NU 15. La z=15, toate cererile dădeau
            // 404 silențios (înainte de fix-ul de logging) — verificarea de clădiri nu
            // excludea niciodată nimic (39/39 candidați desenați, 0 tăiați). La z=14,
            // tile-urile se încarcă fără nicio eroare [UAT], iar rezultatele sunt corecte
            // (testat pe o zonă goală de clădiri actuale — Turda/Râmeț — și pe una plină
            // de clădiri actuale — Mineu).
            window.UAT_TILE_Z = (window.UAT_TILE_Z !== undefined) ? window.UAT_TILE_Z : 14;
            var UAT_TILE_Z = window.UAT_TILE_Z; // nivelul nativ la care sunt generate tile-urile
            var UAT_TILE_SIZE = 256;
            // Comutator unic pentru polaritatea clasificării pixelilor "roșu pe hartă"
            // (NU neapărat "clădire reală" — vezi nota de mai sus și
            // _uatIsPresentBuildingPixel mai jos, pentru logica de clădiri dispărute).
            var UAT_BUILDING_IS_LIGHT = false;
            function _uatIsBuildingPixel(r, g, b, a) {
                if (a <= 128) return false; // transparent / fără date → niciodată roșu
                var lum = (r + g + b) / 3;
                return UAT_BUILDING_IS_LIGHT ? (lum >= 128) : (lum < 128);
            }
            // Pentru "clădiri dispărute": un candidat e valid DOAR dacă zona e ÎN
            // interiorul stratului roșu (adică exact acolo unde _uatIsBuildingPixel
            // întoarce true) — o clădire dispărută trebuie să cadă pe roșu = fără
            // clădire actuală acolo acum. Deci "există o clădire actuală prezentă" =
            // opusul lui _uatIsBuildingPixel, pentru pixelii cu date (opaci).
            //
            // FIX (2026-07): pixelii TRANSPARENȚI dintr-un tile încărcat cu succes NU
            // înseamnă "fără date, nu putem afirma nimic" — confirmat empiric (vezi
            // captura cu stratul UAT afișat direct: exact zona satului/clădirilor
            // actuale apare transparentă, netrasă cu roșu, în timp ce câmpurile/pădurea
            // din jur sunt opace-roșii). Practic, în acest set de date, absența oricărei
            // marcaje ("roșu = fără clădire") pe un pixel opac ÎNSEAMNĂ de fapt zonă
            // construită, iar transparența e un gol lăsat peste zonele construite, nu
            // "necunoscut". Vechea logică ignora acești pixeli ("nu putem afirma nimic"),
            // ceea ce lăsa poligoane "clădire dispărută" desenate direct peste clădiri
            // actuale reale în interiorul satelor. Acum tratăm pixelii transparenți la
            // fel ca restul cazurilor incerte din acest fișier (CORS/rețea): eșuăm
            // ÎNCHIS — presupunem "clădire prezentă" — și SINGURUL mod de a confirma
            // "fără clădire" e un pixel opac clasificat explicit ca roșu.
            function _uatIsPresentBuildingPixel(r, g, b, a) {
                if (a <= 128) return true; // transparent → incert → presupunem clădire prezentă (eșuăm închis)
                return !_uatIsBuildingPixel(r, g, b, a);
            }
            // Tile-urile au fost generate cu gdal2tiles.py fără flag-ul --xyz, deci sunt
            // în schema TMS (y=0 la SUD/jos, crescător spre nord) — Leaflet & tot restul
            // codului nostru lucrează în schema XYZ standard (y=0 la NORD/sus, crescător
            // spre sud). Conversia se face DOAR la nivel de nume de fișier cerut; restul
            // matematicii (poziția pixelului în interiorul tile-ului) rămâne XYZ, pentru
            // că imaginea în sine nu e răsturnată, doar numărul de rând din URL.
            function _uatTileYForUrl(y, z) { return Math.pow(2, z) - 1 - y; }

            function _uatLngToTileX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
            function _uatLatToTileY(lat, z) {
                var rad = lat * Math.PI / 180;
                return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
            }

            // Cache de tile-uri deja încărcate (Promise -> {data,size} | null | UAT_TILE_UNREADABLE).
            // Rezultatele posibile:
            //  - {data, size}      → tile citit cu succes, pixelii sunt disponibili.
            //  - null              → tile CONFIRMAT lipsă (404 chiar și fără CORS) — nu
            //                        există date acolo, tratat ca "fără informație".
            //  - UAT_TILE_UNREADABLE → tile-ul EXISTĂ (s-a încărcat fără CORS), dar nu-i
            //                        putem citi pixelii (CORS neconfigurat pe bucket-ul R2).
            //                        Diferența față de "null" contează: apelanții trebuie să
            //                        trateze asta ca INCERT, nu ca "sigur fără clădire" — vezi
            //                        uatHasBuildingNear mai jos, care eșuează "închis"
            //                        (presupune clădire prezentă) în loc de "deschis" pe acest caz.
            var UAT_TILE_UNREADABLE = { unreadable: true };
            var _uatPixelTileCache = {};
            function _uatGetTile(z, x, y) {
                var max = Math.pow(2, z);
                if (x < 0 || y < 0 || x >= max || y >= max) return Promise.resolve(null);
                var key = z + '/' + x + '/' + y;
                if (_uatPixelTileCache[key]) return _uatPixelTileCache[key];
                var url = UAT_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', _uatTileYForUrl(y, z));
                var p = new Promise(function (resolve) {
                    function tryLoad(useCORS) {
                        var img = new Image();
                        var loadUrl = url;
                        if (useCORS) {
                            img.crossOrigin = 'anonymous'; // necesar pentru getImageData — bucket-ul R2 trebuie să aibă CORS activat
                        } else {
                            loadUrl += (url.indexOf('?') === -1 ? '?' : '&') + '_uatProbe=1';
                        }
                        img.onload = function () {
                            if (!useCORS) {
                                // S-a încărcat fără CORS → tile-ul EXISTĂ pe server, dar nu-i
                                // putem citi pixelii (fără header CORS pe bucket). INCERT, nu
                                // "fără clădire" — vezi nota de mai sus.
                                console.warn('[UAT] Tile ' + key + ' există dar nu poate fi citit (CORS neconfigurat pe bucket R2) — tratat ca INCERT în verificarea de proximitate.');
                                resolve(UAT_TILE_UNREADABLE);
                                return;
                            }
                            try {
                                var c = document.createElement('canvas');
                                c.width = img.width; c.height = img.height;
                                var ctx = c.getContext('2d');
                                ctx.drawImage(img, 0, 0);
                                var imgData = ctx.getImageData(0, 0, c.width, c.height);
                                resolve({ data: imgData.data, size: c.width });
                            } catch (e) {
                                console.warn('[UAT] Nu pot citi pixelii tile-ului ' + key + ' cu CORS, reîncerc fără CORS ca să confirm dacă tile-ul există:', e.message);
                                tryLoad(false);
                            }
                        };
                        img.onerror = function () {
                            if (useCORS) {
                                // Eșec cu CORS — poate fi 404 real SAU blocaj CORS. Reîncercăm
                                // fără crossOrigin ca să aflăm dacă resursa chiar există.
                                tryLoad(false);
                                return;
                            }
                            // Eșec și fără CORS → tile CONFIRMAT lipsă (404 real).
                            // FIX (2026-07): înainte, acest caz era complet silențios — nu se
                            // logga nimic, ceea ce a mascat un bug real (verificarea de clădiri
                            // eșua silențios pe 100% din candidați, fără niciun avertisment în
                            // consolă). Acum îl logăm explicit, ca să fie vizibil dacă tile-urile
                            // UAT lipsesc sistematic la zoom-ul cerut (UAT_TILE_Z).
                            console.warn('[UAT] Tile ' + key + ' CONFIRMAT lipsă (404) la zoom ' + z + ' — ' +
                                'verific dacă UAT_TILE_Z (' + UAT_TILE_Z + ') corespunde nivelului real generat pe R2.');
                            resolve(null);
                        };
                        img.src = loadUrl;
                    }
                    tryLoad(true);
                });
                _uatPixelTileCache[key] = p;
                return p;
            }
            window._uatGetTile = _uatGetTile;
            window._UAT_TILE_UNREADABLE = UAT_TILE_UNREADABLE;

            function _uatDegBufferFromMeters(meters, midLatDeg) {
                return {
                    dLat: meters / 111320,
                    dLng: meters / (111320 * Math.cos(midLatDeg * Math.PI / 180))
                };
            }

            // Verifică (async) dacă există cel puțin un pixel "clădire" (negru) în
            // bbox-ul sw..ne, extins cu bufferMeters în fiecare direcție — echivalentul
            // regulii "minDistM <= minBuildingDistM", dar pe raster în loc de distanță
            // geometrică exactă. cb(true|false) e apelat la final.
            //
            // IMPORTANT (2026-07, fix): dacă vreun tile relevant există dar nu poate fi
            // citit (CORS neconfigurat pe bucket — vezi UAT_TILE_UNREADABLE mai sus),
            // funcția NU mai presupune silențios "fără clădire acolo" (comportament vechi,
            // periculos: putea lăsa poligoane "clădire dispărută" desenate direct peste
            // clădiri actuale reale, doar pentru că nu am putut verifica). În schimb,
            // eșuează ÎNCHIS: cb(true) — tratează zona ca "posibil clădire prezentă", deci
            // candidatul e exclus/tăiat, nu desenat. E mai bine să ratăm o clădire
            // dispărută reală decât să desenăm una falsă peste o clădire existentă.
            function uatHasBuildingNear(sw, ne, bufferMeters, cb) {
                var midLat = (sw.lat + ne.lat) / 2;
                var buf = _uatDegBufferFromMeters(bufferMeters, midLat);
                var minLat = Math.min(sw.lat, ne.lat) - buf.dLat, maxLat = Math.max(sw.lat, ne.lat) + buf.dLat;
                var minLng = Math.min(sw.lng, ne.lng) - buf.dLng, maxLng = Math.max(sw.lng, ne.lng) + buf.dLng;

                var z = window.UAT_TILE_Z;
                var txMinF = _uatLngToTileX(minLng, z), txMaxF = _uatLngToTileX(maxLng, z);
                var tyMinF = _uatLatToTileY(maxLat, z), tyMaxF = _uatLatToTileY(minLat, z); // lat crește => tileY scade
                var txMin = Math.floor(txMinF), txMax = Math.floor(txMaxF);
                var tyMin = Math.floor(tyMinF), tyMax = Math.floor(tyMaxF);

                var tiles = [];
                for (var tx = txMin; tx <= txMax; tx++) {
                    for (var ty = tyMin; ty <= tyMax; ty++) tiles.push([tx, ty]);
                }

                Promise.all(tiles.map(function (t) { return _uatGetTile(z, t[0], t[1]); }))
                    .then(function (results) {
                        var anyUnreadable = false;
                        var anyMissing = false;
                        var anyLoaded = false;
                        for (var i = 0; i < results.length; i++) {
                            var tile = results[i];
                            if (tile === UAT_TILE_UNREADABLE) { anyUnreadable = true; continue; }
                            if (!tile) { anyMissing = true; continue; } // tile CONFIRMAT lipsă (404)
                            anyLoaded = true;
                            var tx = tiles[i][0], ty = tiles[i][1], size = tile.size;
                            var pxMinX = Math.max(0, Math.floor((txMinF - tx) * size));
                            var pxMaxX = Math.min(size - 1, Math.ceil((txMaxF - tx) * size));
                            var pxMinY = Math.max(0, Math.floor((tyMinF - ty) * size));
                            var pxMaxY = Math.min(size - 1, Math.ceil((tyMaxF - ty) * size));
                            for (var py = pxMinY; py <= pxMaxY; py++) {
                                for (var px = pxMinX; px <= pxMaxX; px++) {
                                    var idx = (py * size + px) * 4;
                                    if (_uatIsPresentBuildingPixel(tile.data[idx], tile.data[idx + 1], tile.data[idx + 2], tile.data[idx + 3])) { cb(true); return; }
                                }
                            }
                        }
                        if (anyUnreadable) {
                            // N-am putut confirma sigur "fără clădire" pentru toată zona —
                            // eșuăm închis (vezi nota de mai sus).
                            cb(true);
                            return;
                        }
                        // FIX (2026-07): dacă NICIUN tile din zona verificată nu s-a putut
                        // încărca deloc (toate 404 — de exemplu UAT_TILE_Z nu (mai) corespunde
                        // nivelului real generat pe R2 pentru acest set de date, sau lipsă de
                        // acoperire), vechiul cod trecea silențios la cb(false) = "fără clădire",
                        // FĂRĂ niciun avertisment în consolă — exact bug-ul confirmat empiric:
                        // 39/39 candidați desenați, 0 tăiați, 0 loguri [UAT]/[Buildings]. O
                        // absență TOTALĂ de date pe toată zona verificată nu e o confirmare de
                        // "fără clădire", e o necunoscută la fel de gravă ca un tile ilizibil —
                        // eșuăm închis și aici.
                        if (anyMissing && !anyLoaded) {
                            console.warn('[UAT] Niciun tile citit pentru zona verificată (toate lipsă la zoom ' + z + ') — eșuez închis (presupun clădire prezentă).');
                            cb(true);
                            return;
                        }
                        cb(false);
                    })
                    .catch(function (err) {
                        console.warn('[UAT] Eroare la citirea tile-urilor raster — eșuez închis (presupun clădire prezentă):', err && err.message);
                        cb(true); // eșec neașteptat → tot închis, nu deschis
                    });
            }
            window.uatHasBuildingNear = uatHasBuildingNear;

            // Parse a coordinate string typed or pasted into the map search bar.
            // Accepts (almost) any format a user can copy from a GPS, a pin or a
            // map site:
            //   • decimal degrees      45.123456, 24.654321 — separated by a comma,
            //     semicolon, pipe, space or newline; signed; brackets/quotes allowed
            //   • RO decimal comma     45,123456 24,654321  /  45,123456; 24,654321
            //   • hemispheres          45.12N 24.65E · N 45°34′12″ · 45N, 24E —
            //     the letter fixes the slot, so "24.65E, 45.12N" is repaired
            //   • DMS                  45°34'12"N 24°40'15"E · 45:34:12N 24:40:15E ·
            //     45 34 12 N 24 40 15 E · 45 degrees 34 minutes 12 seconds N
            //   • DDM                  45°34.2'N 24°40.25'E · 45 34.2 N 24 40.25 E
            //   • GPS/NMEA compact     4534.2222N 02440.2222E (ddmm.mmmm) · 453412 (ddmmss)
            //   • labeled              lat 45.12, lon 24.65 — either order works
            //   • trailing elevation   45.12, 24.65, 220 (the height is ignored)
            //   • UTM (WGS84)          35T 245123 4996412 · UTM 18T 583960 4511341
            //   • Plus Code (OLC)      8FVC2222+22; a short code is completed
            //     relative to the current map center, exactly like Google Maps.
            // Returns { lat, lon, valid } when the text looks like coordinates
            // (valid: false lets the search bar explain the out-of-range piece),
            // and null for everything else so place-name search still runs.
            // <dl-coordinate-parser>
            var COORD_ALPHABET = '23456789CFGHJMPQRVWX';

            // Unify degree/minute/second spellings (prime symbols, ° variants and
            // the words "degrees/deg", "minutes/min", "seconds/sec") as ° ' " so the
            // token grammar below has exactly one spelling to understand. A bare
            // "s" is deliberately NOT rewritten to a seconds mark: it is
            // indistinguishable from the South-hemisphere letter.
            function normalizeCoordinateText(input) {
                return String(input == null ? '' : input)
                    .replace(/[\u00A0\u2007\u202F]/g, ' ')
                    .replace(/[\u2018\u2019\u201A\u201B\u2032`]/g, "'")
                    .replace(/[\u201C\u201D\u2033]/g, '"')
                    .replace(/[\u2010-\u2015\u2212]/g, '-')
                    .replace(/[\u00B0\u00BA\u00AA\u2070\uFF07\uFF40]/g, '°')
                    .replace(/\uFF0C/g, ',').replace(/\uFF1B/g, ';').replace(/\uFF1A/g, ':')
                    .replace(/(\d)\s*(?:degrees?|deg)(?![a-z])/gi, '$1°')
                    .replace(/(\d)\s*(?:minutes?|min)(?![a-z])/gi, "$1'")
                    .replace(/(\d)\s*(?:seconds?|sec)(?![a-z])/gi, '$1"')
                    .replace(/(\d)\s*d(?=\s*\d)/gi, '$1°')
                    .replace(/(\d)\s*m(?=\s*\d)/gi, "$1'")
                    .trim();
            }

            // "-4534.2222" / "45,123" -> numeric pieces. A string mixing both '.'
            // and ',' (thousands grouping) is too ambiguous to trust.
            function parseCoordinateNumber(raw) {
                var neg = false;
                var str = String(raw).trim().replace(/^\+\s*/, '');
                var sm = str.match(/^-\s*/);
                if (sm) { neg = true; str = str.slice(sm[0].length); }
                if (str.indexOf('.') > -1 && str.indexOf(',') > -1) return null;
                var parts = str.split(/[.,]/);
                var value = Number(parts.join('.'));
                if (!isFinite(value) || !/^\d+(?:[.,]\d+)?$/.test(str)) return null;
                return {
                    value: neg ? -value : value,
                    abs: value,
                    intStr: parts[0],
                    fracStr: parts[1] || ''
                };
            }

            // GPS "compact" forms: ddmm(.mmmm), dddmm(.mmmm), ddmmss, dddmmss.
            // Only tried when the plain decimal reading is out of range.
            function tryCompactCoordinateDegrees(p, slot) {
                var intStr = p.intStr, frac = p.fracStr;
                var maxDeg = slot === 'lat' ? 90 : 180;
                var minLen = slot === 'lat' ? 3 : 4;
                if (intStr.length < minLen || intStr.length > 7) return null;
                // Minutes carry the fraction unless a whole seconds field exists too.
                var attempts = [];
                if (frac) {
                    attempts.push(false);
                    if (intStr.length >= minLen + 2) attempts.push(true);
                } else {
                    if (intStr.length >= minLen + 2) attempts.push(true);
                    attempts.push(false);
                }
                for (var t = 0; t < attempts.length; t++) {
                    var withSec = attempts[t];
                    var degLen = intStr.length - (withSec ? 4 : 2);
                    if (degLen < 1) continue;
                    var deg = Number(intStr.slice(0, degLen));
                    var mins = withSec
                        ? Number(intStr.slice(degLen, degLen + 2))
                        : Number(intStr.slice(degLen) + (frac ? '.' + frac : ''));
                    var secs = withSec
                        ? Number(intStr.slice(degLen + 2) + (frac ? '.' + frac : ''))
                        : 0;
                    if (!isFinite(deg) || !isFinite(mins) || !isFinite(secs)) continue;
                    if (deg > maxDeg || mins >= 60 || secs >= 60) continue;
                    return deg + mins / 60 + secs / 3600;
                }
                return null;
            }

            // One value = 1..3 numbers (degrees [+ minutes [+ seconds]]), with an
            // optional sign and hemisphere letter. Returns { value, error }.
            function coordinateGroupValue(items, hemi, slot) {
                if (!items || items.length < 1 || items.length > 3) return null;
                var parsed = [];
                for (var i = 0; i < items.length; i++) {
                    var p = parseCoordinateNumber(items[i].raw);
                    if (!p) return null;
                    parsed.push(p);
                }
                var sign = (hemi === 'S' || hemi === 'W') ? -1
                    : (hemi === 'N' || hemi === 'E') ? 1
                    : (parsed[0].value < 0 ? -1 : 1);
                var mag = Math.abs(parsed[0].value);
                var error = false;
                if (parsed.length === 1) {
                    var maxDeg = slot === 'lat' ? 90 : 180;
                    if (mag > maxDeg) {
                        var compact = tryCompactCoordinateDegrees(parsed[0], slot);
                        if (compact == null) error = true;
                        else mag = compact;
                    }
                } else {
                    var mins = Math.abs(parsed[1].value);
                    var secs = parsed.length === 3 ? Math.abs(parsed[2].value) : 0;
                    if (mins >= 60 || secs >= 60) error = true;
                    mag = mag + mins / 60 + secs / 3600;
                }
                return { value: sign * mag, error: error };
            }

            // Plus Codes (Open Location Code): decode + nearest-reference recovery
            // for short codes. Ported from the reference algorithm
            // (github.com/google/open-location-code, Apache-2.0).
            function olcEncode(lat, lng) {
                var latInt = Math.floor(lat * 25000000) + 90 * 25000000;
                if (latInt < 0) latInt = 0;
                if (latInt >= 4500000000) latInt = 4500000000 - 1;
                var lngInt = Math.floor(lng * 8192000) + 180 * 8192000;
                if (lngInt < 0) lngInt = (lngInt % 2949120000) + 2949120000;
                if (lngInt >= 2949120000) lngInt = lngInt % 2949120000;
                latInt = Math.floor(latInt / 3125);
                lngInt = Math.floor(lngInt / 1024);
                var chars = new Array(11);
                chars[8] = '+';
                chars[9] = COORD_ALPHABET.charAt(latInt % 20);
                chars[10] = COORD_ALPHABET.charAt(lngInt % 20);
                latInt = Math.floor(latInt / 20);
                lngInt = Math.floor(lngInt / 20);
                for (var i = 6; i >= 0; i -= 2) {
                    chars[i] = COORD_ALPHABET.charAt(latInt % 20);
                    chars[i + 1] = COORD_ALPHABET.charAt(lngInt % 20);
                    latInt = Math.floor(latInt / 20);
                    lngInt = Math.floor(lngInt / 20);
                }
                return chars.join('');
            }

            function olcDecodeDigits(code) {
                // code: A–Z/2–9 digit pairs (no '+' or '0'), 8..15 characters.
                var normalLat = -90 * 8000, normalLng = -180 * 8000;
                var gridLat = 0, gridLng = 0;
                var digits = Math.min(code.length, 10);
                var pv = Math.pow(20, 4);
                for (var i = 0; i < digits; i += 2) {
                    normalLat += COORD_ALPHABET.indexOf(code.charAt(i)) * pv;
                    normalLng += COORD_ALPHABET.indexOf(code.charAt(i + 1)) * pv;
                    if (i < digits - 2) pv /= 20;
                }
                var latPrecision = pv / 8000, lngPrecision = pv / 8000;
                if (code.length > 10) {
                    var rowpv = Math.pow(5, 5), colpv = Math.pow(4, 5);
                    digits = Math.min(code.length, 15);
                    for (i = 10; i < digits; i++) {
                        var digitVal = COORD_ALPHABET.indexOf(code.charAt(i));
                        if (digitVal < 0) return null;
                        gridLat += Math.floor(digitVal / 4) * rowpv;
                        gridLng += (digitVal % 4) * colpv;
                        if (i < digits - 1) { rowpv /= 5; colpv /= 4; }
                    }
                    latPrecision = rowpv / 25000000;
                    lngPrecision = colpv / 8192000;
                }
                var lat = normalLat / 8000 + gridLat / 25000000;
                var lng = normalLng / 8000 + gridLng / 8192000;
                return {
                    lat: lat + latPrecision / 2,
                    lng: lng + lngPrecision / 2
                };
            }

            function parsePlusCodeCoordinate(sIn) {
                var s = String(sIn == null ? '' : sIn).trim().toUpperCase().replace(/\s+/g, '').replace(/[\u201C\u201D\u2018\u2019"']/g, '');
                if (s.length < 4) return null;
                if (!/^[0-9CFGHJMPQRVWX+]{4,}$/.test(s)) return null;
                if (!/[CFGHJMPQRVWX]/.test(s)) return null; // pure digits are not a plus code
                if (s.charAt(0) === '0') return null;
                var plus = s.indexOf('+');
                var shortCode = false;
                if (plus > -1) {
                    if (plus > 8 || plus % 2 === 1) return null;
                    if (s.length - plus - 1 === 1) return null;
                    shortCode = plus < 8;
                }
                var digits = s.replace(/[+0]/g, '');
                if (digits.length < 4 || (!shortCode && (digits.length < 8 || (digits.length % 2 === 1 && digits.length <= 10)))) return null;
                if (digits.length > 15) return null;
                if (!shortCode) {
                    var area = olcDecodeDigits(digits);
                    if (!area) return null;
                    return { lat: area.lat, lon: area.lng > 180 ? area.lng - 360 : area.lng, valid: true };
                }
                // Short code: needs a reference location — use the current map center.
                if (typeof map === 'undefined' || !map || typeof map.getCenter !== 'function') return null;
                var ref = map.getCenter();
                if (!ref) return null;
                var refLat = Math.max(-90, Math.min(90, ref.lat));
                var refLng = ref.lng;
                while (refLng > 180) refLng -= 360;
                while (refLng < -180) refLng += 360;
                var padding = 8 - s.indexOf('+');
                var resolution = Math.pow(20, 2 - padding / 2);
                var half = resolution / 2;
                var full = olcEncode(refLat, refLng).substr(0, padding) + s;
                var center = olcDecodeDigits(full.replace(/[+0]/g, ''));
                if (!center) return null;
                var lat = center.lat, lng = center.lng;
                if (refLat + half < lat && lat - resolution >= -90) lat -= resolution;
                else if (refLat - half > lat && lat + resolution <= 90) lat += resolution;
                if (refLng + half < lng) lng -= resolution;
                else if (refLng - half > lng) lng += resolution;
                return { lat: lat, lon: lng > 180 ? lng - 360 : (lng < -180 ? lng + 360 : lng), valid: true };
            }

            // UTM (WGS84) inverse, Snyder's formulas: "35T 245123 4996412".
            function parseUtmCoordinate(sIn) {
                var s = normalizeCoordinateText(sIn);
                var m = s.match(/^UTM\s*(?:zone)?\s*[:\-]?\s*(\d{1,2})\s*([C-HJ-NP-X])[\s,;]+(\d{5,7}(?:[.,]\d+)?)[\s,;]+(\d{5,8}(?:[.,]\d+)?)$/i)
                    || s.match(/^(\d{1,2})\s*([C-HJ-NP-X])[\s,;\-]+(\d{5,7}(?:[.,]\d+)?)[\s,;]+(\d{5,8}(?:[.,]\d+)?)$/i);
                if (!m) return null;
                var zone = Number(m[1]), band = m[2].toUpperCase();
                var e = parseCoordinateNumber(m[3]), n = parseCoordinateNumber(m[4]);
                if (!e || !n) return null;
                var easting = e.abs, northing = n.abs;
                if (easting > 1000000 && easting <= 2000000) easting -= 1000000; // zone-prefixed eastings
                var fail = zone < 1 || zone > 60 ||
                    !(easting > 0 && easting <= 1000000) ||
                    !(northing > 0 && northing <= 10000000);
                if (fail) return { lat: 0, lon: 0, valid: false };
                var x = easting - 500000;
                var y = northing;
                if ('CDEFGHJKLM'.indexOf(band) > -1) y -= 10000000; // southern bands
                var A = 6378137.0, F = 1 / 298.257223563, K0 = 0.9996;
                var E2 = F * (2 - F), EP2 = E2 / (1 - E2);
                var E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
                var M = y / K0;
                var mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));
                var phi1 = mu
                    + (3 * E1 / 2 - 27 * E1 * E1 * E1 / 32) * Math.sin(2 * mu)
                    + (21 * E1 * E1 / 16 - 55 * E1 * E1 * E1 * E1 / 32) * Math.sin(4 * mu)
                    + (151 * E1 * E1 * E1 / 96) * Math.sin(6 * mu)
                    + (1097 * E1 * E1 * E1 * E1 / 512) * Math.sin(8 * mu);
                var sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
                var C1 = EP2 * cosP * cosP, T1 = tanP * tanP;
                var N1 = A / Math.sqrt(1 - E2 * sinP * sinP);
                var R1 = A * (1 - E2) / Math.pow(1 - E2 * sinP * sinP, 1.5);
                var D = x / (N1 * K0), D2 = D * D, D3 = D2 * D, D4 = D2 * D2, D5 = D3 * D2, D6 = D3 * D3;
                var lat = phi1 - (N1 * tanP / R1) * (D2 / 2
                    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D4 / 24
                    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D6 / 720);
                var lng = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180 +
                    (D - (1 + 2 * T1 + C1) * D3 / 6
                        + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D5 / 120) / cosP;
                lat = lat * 180 / Math.PI;
                lng = lng * 180 / Math.PI;
                var ok = isFinite(lat) && isFinite(lng) &&
                    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
                return { lat: lat, lon: lng, valid: ok };
            }

            // Latitude/longitude pair in any of the supported notations.
            function parseLatLonCoordinate(sIn) {
                var s = normalizeCoordinateText(sIn)
                    .replace(/^[\s()\[\]{}<>"']+/g, '')
                    .replace(/[\s()\[\]{}<>"',;.]+$/g, '');
                // Labeled values ("lat:", "longitude=") fix the order of the pair.
                var latAt = -1, lonAt = -1;
                s = s.replace(/\b(latitude|longitude|long|lon|lgt|lat)(?![a-z])\s*[:=]?\s*([+-]?)\s*/gi,
                    function (_m, word, sign, off) {
                        var w = String(word).toLowerCase();
                        var isLon = w !== 'lat' && w !== 'latitude';
                        if (isLon) { if (lonAt < 0) lonAt = off; }
                        else { if (latAt < 0) latAt = off; }
                        return sign || ' ';
                    });
                // Hemisphere letters become marker tokens so they can anchor the split
                // into the two values and decide which one is the latitude.
                var hemis = [];
                s = s.replace(/(^|[^a-z])([NSEW])(?![a-z])/gi, function (_m, pre, h) {
                    hemis.push(h.toUpperCase());
                    return pre + '\u0001' + h.toUpperCase();
                });
                if (/[a-z\u00c0-\u024f]/i.test(s.replace(/\u0001[NSEW]/g, ''))) return null;

                var toks = [];
                var re = /\u0001([NSEW])|([+-]?\s*\d+(?:[.,]\d+)?)([°'"]*)|([,;|])/gi;
                var mm, last = 0, okGap = /^[\s:()\[\]{}<>~\/.-]*$/;
                while ((mm = re.exec(s))) {
                    if (!okGap.test(s.slice(last, mm.index))) return null;
                    last = re.lastIndex;
                    if (mm[1]) toks.push({ k: 'h', c: mm[1].toUpperCase() });
                    else if (mm[4]) toks.push({ k: 'sep' });
                    else toks.push({ k: 'n', raw: mm[2].replace(/\s+/g, '') });
                }
                if (!okGap.test(s.slice(last))) return null;

                var numIdx = [], sepIdx = [], hemiIdx = [];
                for (var i = 0; i < toks.length; i++) {
                    if (toks[i].k === 'n') numIdx.push(i);
                    else if (toks[i].k === 'sep') sepIdx.push(i);
                    else hemiIdx.push(i);
                }
                if (hemiIdx.length > 2) return null;
                // "45.12, 24.65, 220" — a trailing altitude (GPS/geo-URL paste) is
                // dropped before the stream is split, even next to hemisphere letters.
                if (numIdx.length === 3 && sepIdx.length === 2) {
                    toks = toks.slice(0, sepIdx[1]);
                    numIdx = []; sepIdx = []; hemiIdx = [];
                    for (i = 0; i < toks.length; i++) {
                        if (toks[i].k === 'n') numIdx.push(i);
                        else if (toks[i].k === 'sep') sepIdx.push(i);
                        else hemiIdx.push(i);
                    }
                }
                var numsCount = numIdx.length;

                // Split the token stream into the two values.
                var splitAt = -1;
                if (hemiIdx.length === 2) {
                    var candidates = [hemiIdx[1], hemiIdx[0] + 1];
                    if (sepIdx.length === 1) candidates.push(sepIdx[0]);
                    for (var c = 0; c < candidates.length; c++) {
                        var cand = candidates[c];
                        if (cand <= 0 || cand >= toks.length) continue;
                        var before = 0, after = 0;
                        for (var j = 0; j < toks.length; j++) {
                            if (toks[j].k !== 'n') continue;
                            if (j < cand) before++; else after++;
                        }
                        if (before >= 1 && after >= 1) { splitAt = cand; break; }
                    }
                    if (splitAt < 0) return null;
                } else if (numsCount === 1) {
                    return null;
                } else if (sepIdx.length === 1) {
                    splitAt = sepIdx[0];
                } else if (numsCount === 2 || numsCount === 4 || numsCount === 6) {
                    splitAt = numIdx[Math.floor(numsCount / 2)];
                } else {
                    return null;
                }

                var groupA = { items: [], hemi: null, hemiAt: -1 };
                var groupB = { items: [], hemi: null, hemiAt: -1 };
                for (i = 0; i < toks.length; i++) {
                    var tk = toks[i];
                    if (tk.k === 'sep') continue;
                    var g = i < splitAt ? groupA : groupB;
                    if (tk.k === 'n') g.items.push(tk);
                    else if (tk.k === 'h') {
                        if (g.hemi) return null; // two hemisphere letters on one value
                        g.hemi = tk.c;
                    }
                }

                // Which group is the latitude: hemisphere letters decide, then labels,
                // then the documented pin convention (lat first).
                var latGroup = groupA, lonGroup = groupB;
                var aIsLat = groupA.hemi === 'N' || groupA.hemi === 'S';
                var aIsLon = groupA.hemi === 'E' || groupA.hemi === 'W';
                var bIsLat = groupB.hemi === 'N' || groupB.hemi === 'S';
                var bIsLon = groupB.hemi === 'E' || groupB.hemi === 'W';
                if ((aIsLat && bIsLat) || (aIsLon && bIsLon)) return null;
                if ((aIsLat && bIsLon) || (aIsLon && bIsLat)) {
                    latGroup = aIsLat ? groupA : groupB;
                    lonGroup = aIsLat ? groupB : groupA;
                } else if (aIsLat || bIsLon) { latGroup = groupA; lonGroup = groupB; }
                else if (aIsLon || bIsLat) { latGroup = groupB; lonGroup = groupA; }
                else if (latAt > -1 && lonAt > -1 && lonAt < latAt) {
                    latGroup = groupB; lonGroup = groupA;
                }

                var latPart = coordinateGroupValue(latGroup.items, latGroup.hemi, 'lat');
                var lonPart = coordinateGroupValue(lonGroup.items, lonGroup.hemi, 'lon');
                if (!latPart || !lonPart) return null;
                var lat = latPart.value, lon = lonPart.value;
                var valid = !latPart.error && !lonPart.error &&
                    isFinite(lat) && isFinite(lon) &&
                    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
                return { lat: lat, lon: lon, valid: valid };
            }

            function parseCoordinateQuery(value) {
                var raw = String(value == null ? '' : value);
                if (!/\d/.test(raw)) return null;
                var utm = parseUtmCoordinate(raw);
                if (utm) return utm;
                var plus = parsePlusCodeCoordinate(raw);
                if (plus) return plus;
                return parseLatLonCoordinate(raw);
            }
            // </dl-coordinate-parser>

            function coordinateSearchItem(value) {
                var coordinates = parseCoordinateQuery(value);
                if (!coordinates || !coordinates.valid) return coordinates;

                var formatted = coordinates.lat.toFixed(6) + ', ' + coordinates.lon.toFixed(6);
                return {
                    lat: coordinates.lat,
                    lon: coordinates.lon,
                    display_name: formatted,
                    fclass: 'Coordinates / Coordonate',
                    isCoordinate: true
                };
            }

            // Expose the parser (and the Plus Code encoder used to expand short codes
            // around the map center) for lightweight regression tests and other map
            // UI integrations, without coupling them to the place-name data source.
            window._parseMapCoordinateQuery = parseCoordinateQuery;
            window._dlOlEncode = olcEncode;

            // Funcția principală de search
            function doSearch(q) {
                var ul = document.getElementById('mapSearchResults');
                var searchTerm = q.trim();

                if (searchTerm.length < 2) {
                    closeResults();
                    return;
                }

                // Coordinate searches are local and immediate: do not download or
                // wait for OSM place data when the user pastes coordinates from a pin.
                var coordinateItem = coordinateSearchItem(searchTerm);
                if (coordinateItem && coordinateItem.valid === false) {
                    ul.innerHTML = '<li class="map-search-msg">Invalid coordinates. Latitude must be −90 to 90, longitude −180 to 180, minutes/seconds below 60. Latitude comes first — or add N/S/E/W letters and the order fixes itself.</li>';
                    ul.classList.add('open');
                    selectedIndex = -1;
                    return;
                }
                if (coordinateItem) {
                    displaySearchResults([coordinateItem], searchTerm);
                    return;
                }

                // Results depend on the selected country (RO → OSM.geojson,
                // others → europe-places.geojsonseq), so include its ISO code in
                // the cache key to avoid stale results after changing countries.
                var cacheKey = String(window._detectlabSelectedCountry || '') + '|' +
                    normalizeRoDiacritics(searchTerm.toLowerCase());

                if (_searchCache[cacheKey]) {
                    displaySearchResults(_searchCache[cacheKey], searchTerm);
                    return;
                }

                ul.innerHTML = '<li class="map-search-msg">Searching…</li>';
                ul.classList.add('open');
                selectedIndex = -1;

                osmPlaceLookup(searchTerm, 8)
                    .then(function (matches) {
                        _searchCache[cacheKey] = matches;
                        displaySearchResults(matches, searchTerm);
                    })
                    .catch(function (err) {
                        console.warn('[Search] Eroare OSM Places:', err.message);
                        ul.innerHTML = '<li class="map-search-msg">Search unavailable. Try again later.</li>';
                    });
            }

            function displaySearchResults(data, searchTerm) {
                var ul = document.getElementById('mapSearchResults');
                if (!data.length) {
                    ul.innerHTML = '<li class="map-search-msg">No results found</li>';
                    return;
                }
                ul.innerHTML = '';
                data.forEach(function (item, i) {
                    var li = document.createElement('li');
                    li.dataset.idx = i;
                    var name = item.display_name || '';
                    var typeLabel = item.fclass ? item.fclass.replace(/_/g, ' ') : '';
                    // „jud. X” doar pentru sursa românească; localitățile din
                    // setul european afișează regiunea/provincia fără prefix.
                    var meta = item.judet
                        ? ('jud. ' + item.judet) + (typeLabel ? ' · ' + typeLabel : '')
                        : (item.region
                            ? item.region + (typeLabel ? ' · ' + typeLabel : '')
                            : typeLabel);
                    li.innerHTML =
                        '<svg class="sr-icon" width="12" height="12" viewBox="0 0 12 12" fill="none">' +
                        '<circle cx="6" cy="5" r="2.5" stroke="#B8D8F0" stroke-width="1.2"/>' +
                        '<path d="M6 1C3.79 1 2 2.79 2 5c0 3 4 7 4 7s4-4 4-7c0-2.21-1.79-4-4-4z" stroke="#B8D8F0" stroke-width="1.2" fill="none"/></svg>' +
                        '<span class="sr-name">' + name + '</span>' +
                        '<span class="sr-country">' + meta + '</span>';
                    li.addEventListener('click', function () { selectResult(item); });
                    ul.appendChild(li);
                });
                ul.classList.add('open');
            }

            function setActive(idx, items) {
                items.forEach(function (i) { i.classList.remove('active'); });
                selectedIndex = Math.max(0, Math.min(idx, items.length - 1));
                if (items[selectedIndex]) items[selectedIndex].classList.add('active');
            }

            function selectResult(item) {
                var lat = parseFloat(item.lat);
                var lon = parseFloat(item.lon);
                var latlng = L.latLng(lat, lon);
                var name = item.display_name || '';

                document.getElementById('mapSearchInput').value = name;
                document.getElementById('searchClearBtn').classList.add('visible');
                closeResults();

                // Search destinations belong to the 2D map. Close 3D first:
                // its camera hand-off restores the old Leaflet view, so doing
                // this after flyTo would overwrite the searched destination.
                var map3d = window.DetectLabMap3D;
                if (map3d && typeof map3d.isOpen === 'function' && map3d.isOpen()) {
                    map3d.close();
                }
                map.flyTo(latlng, 13);

                setTimeout(function () {
                    if (typeof window._iosFreeActivateSearch === 'function') {
                        window._iosFreeActivateSearch(name, lat, lon);
                    }
                }, 200);

                removeSearchMarker();
                var icon = L.divIcon({
                    className: '',
                    html: '<svg width="22" height="28" viewBox="0 0 22 28" fill="none">' +
                        '<path d="M11 0C5 0 0 5 0 11c0 8 11 17 11 17S22 19 22 11C22 5 17 0 11 0z" fill="#6B3FA0"/>' +
                        '<circle cx="11" cy="11" r="5" fill="white" opacity="0.9"/></svg>',
                    iconSize: [22, 28],
                    iconAnchor: [11, 28]
                });
                searchMarker = L.marker(latlng, { icon: icon })
                    .bindTooltip(name, {
                        permanent: true,
                        direction: 'top',
                        offset: [0, -32],
                        className: 'map-search-tooltip'
                    })
                    .addTo(map);
            }

            function removeSearchMarker() {
                if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
            }

            function closeResults() {
                var ul = document.getElementById('mapSearchResults');
                ul.classList.remove('open');
                selectedIndex = -1;
            }

            // Make clearSearch globally accessible for the HTML onclick
            window.clearSearch = function () {
                var input = document.getElementById('mapSearchInput');
                if (input) input.value = '';
                var clear = document.getElementById('searchClearBtn');
                if (clear) clear.classList.remove('visible');
                closeResults();
                removeSearchMarker();
            };

            // Attach search event listeners
            var searchInput = document.getElementById('mapSearchInput');
            if (searchInput) {
                searchInput.addEventListener('input', function (e) {
                    var val = e.target.value;
                    var clear = document.getElementById('searchClearBtn');
                    if (clear) clear.classList.toggle('visible', val.length > 0);
                    clearTimeout(searchDebounce);
                    if (val.length < 2) { closeResults(); return; }

                    // Pasted pin coordinates need no remote data, so show the result
                    // immediately instead of making the user wait for place-search
                    // debouncing. Invalid coordinate ranges are explained immediately.
                    if (parseCoordinateQuery(val)) {
                        doSearch(val);
                        return;
                    }
                    searchDebounce = setTimeout(function () { doSearch(val); }, 350);
                });

                searchInput.addEventListener('keydown', function (e) {
                    var items = document.querySelectorAll('#mapSearchResults li[data-idx]');
                    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(selectedIndex + 1, items); }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(selectedIndex - 1, items); }
                    if (e.key === 'Enter') {
                        e.preventDefault();

                        // A pasted pin coordinate should work immediately on Enter,
                        // even if the input debounce has not rendered its result yet.
                        // Check it before any highlighted item, which may belong to the
                        // previous input value while the user is typing quickly.
                        var coordinateItem = coordinateSearchItem(searchInput.value);
                        if (coordinateItem && coordinateItem.valid !== false) {
                            clearTimeout(searchDebounce);
                            selectResult(coordinateItem);
                            return;
                        }
                        if (coordinateItem && coordinateItem.valid === false) {
                            clearTimeout(searchDebounce);
                            doSearch(searchInput.value);
                            return;
                        }

                        if (selectedIndex >= 0 && items[selectedIndex]) {
                            items[selectedIndex].click();
                            return;
                        }

                        // Make Enter useful for place searches too: choose the only
                        // visible result, or run the pending search immediately.
                        if (items.length === 1) {
                            items[0].click();
                        } else {
                            clearTimeout(searchDebounce);
                            doSearch(searchInput.value);
                        }
                    }
                    if (e.key === 'Escape') { closeResults(); }
                });
            }

            document.addEventListener('click', function (e) {
                if (!document.getElementById('mapSearchWrap').contains(e.target)) closeResults();
            });

            // Also attach clear button listener
            var clearBtn = document.getElementById('searchClearBtn');
            if (clearBtn) {
                clearBtn.onclick = function () {
                    searchInput.value = '';
                    clearBtn.classList.remove('visible');
                    closeResults();
                    removeSearchMarker();
                };
            }
            // ── SHARED LAYER REGISTRY (js/layer-registry.js) ─────────────────
            // Every raster layer below is DEFINED ONCE in js/layer-registry.js:
            // the service (URL, LAYERS, FORMAT, VERSION, transparency, custom
            // params, bounds, attribution) comes from the registry, while this
            // file keeps the view wiring (panes, toggles, coverage). The same
            // definitions build the 3D terrain view (js/map3d-terrain.js) and
            // the tile proxy (netlify/lib/map3d-tile.mjs) — no layer is defined
            // twice, so 2D and 3D cannot drift apart.
            var DL = window.DetectLabLayers;
            if (!DL) {
                console.error('[DetectLab] js/layer-registry.js must load before js/map-app.js');
            }

            // APM image bounds [[south,west],[north,east]] in EPSG:4326
            var APM_BOUNDS = [
                [42.8657855276803872, 19.9018464511967004],
                [49.0024961993941517, 30.6713880698685237]
            ];

            // Initialise Leaflet map inside DetectLab's existing container.
            // APM_BOUNDS defines only the initial Romanian view and the APM
            // raster coverage; it must not constrain navigation. The .eu site
            // can therefore pan freely as European regions are added.
            var map = L.map('detectlab-map', {
                zoomControl: false,
                // The first screen is a geographic selector, not a Romania-only view.
                // Once a country is chosen the picker fits the map back to the
                // normal working scale.
                minZoom: 2,
                maxZoom: 20,
                worldCopyJump: false,
                rotate: true,
                touchRotate: true,
                keyRotate: true,
                bearing: 0,
                // Force zoom animation even on Android (Leaflet disables it by default
                // on Android).  The custom Patrimoniu canvases rely on the zoomanim
                // transform to stay glued to tiles during zoom — without animation
                // tiles jump while the canvas is scaled, or vice-versa, which shows
                // up as the PWA-only slide/glitch.  Threshold 10 keeps animation
                // even for large jumps.
                zoomAnimation: true,
                markerZoomAnimation: true,
                fadeAnimation: true,
                zoomAnimationThreshold: 10
            }).setView([51, 12], 3);

            // Country selection happens in the globe gate (js/globe-country-picker.js,
            // lazy ArcGIS SceneView renderer + canvas fallback), shown the first
            // time an authenticated visitor reaches the map. attach() restores a
            // previously chosen country instantly (no gate flash) or opens the gate
            // once the user is confirmed logged in. Once a country is picked the
            // gate hands this Leaflet instance a locked maxBounds/minZoom and
            // calls filterLayersForCountry().
            if (window.DetectLabGlobeGate) {
                window.DetectLabGlobeGate.attach(map);
            }

            // Country dock (js/country-dock.js): the slide-down country
            // switcher + World-hillshade checkbox glued under the search bar
            // and the bottom-centre “Exit view” button of the locked country
            // view. It reads the country list / lock state from the gate, so
            // it must be attached after it.
            if (window.DetectLabCountryDock) {
                window.DetectLabCountryDock.attach(map);
            }

            // ── GLOBAL TILE GOVERNOR ──
            // js/tile-perf.js patches every tile layer of the app (LIDAR,
            // historical maps, APM 2.0, CORONA, basemap…) with gesture-safe
            // defaults, merges the tile work of a whole gesture into one update
            // and keeps a page-wide budget on the decoded tiles — the fix for
            // the crash on sudden zoom with several dense layers open. See
            // MAP_LAYER_PERFORMANCE.md.
            if (window.DLTilePerf && window.DLTilePerf.attach) {
                window.DLTilePerf.attach(map);
            }

            var hash = new L.Hash(map);

            if (typeof window._initEventsLayer === 'function') {
                window._initEventsLayer(map);
            }

            // Zoom control (top-left, styled via existing CSS)
            L.control.zoom({ position: 'topleft' }).addTo(map);

            // Locate control (plugin kept for API but button hidden; we use our own)
            L.control.locate({ locateOptions: { maxZoom: 19 }, position: 'topleft' }).addTo(map);

            // ── CUSTOM LIVE LOCATION BUTTON ──
            (function () {
                var locationMarker = null;
                var locationCircle = null;
                var watchId = null;

                // Build the shared live-location control wrapper.
                var btn = document.createElement('div');
                btn.className = 'leaflet-control leaflet-bar';
                btn.style.cssText = 'margin-top:8px;border:none;box-shadow:none;background:none;';
                btn.innerHTML =
                    '<button id="btnLiveLocation" class="btn-live-location" title="My Location" aria-label="Toggle live location">' +
                    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
                    '<circle cx="8" cy="8" r="3" fill="currentColor"/>' +
                    '<path d="M8 1v2M8 13v2M1 8h2M13 8h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                    '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/>' +
                    '</svg>' +
                    '</button>';

                // In the installed PWA, the live-location button lives inside
                // #pwa-br-stack (bottom-right) as the first child, with the
                // account trigger below it. On the website it stays below zoom
                // in the left icon stack.
                // NOTE: documentElement (set by the <head> script) is used on
                // purpose — initMap runs before the footer script adds .is-pwa
                // to <body>.
                var isPwaMode = !!(document.documentElement &&
                    document.documentElement.classList.contains('is-pwa'));

                // Wait for the map/DOM to settle, then place the control for
                // this presentation mode and attach the direct click handler.
                setTimeout(function () {
                    if (isPwaMode) {
                        btn.classList.add('pwa-live-location-control');
                        var pwaStack = document.getElementById('pwa-br-stack');
                        if (pwaStack) {
                            // Live-location on top, account below — prepend as first child.
                            if (pwaStack.firstChild) {
                                pwaStack.insertBefore(btn, pwaStack.firstChild);
                            } else {
                                pwaStack.appendChild(btn);
                            }
                        } else {
                            // Fallback when stack is missing (tests / older shells)
                            if (!document.body) return;
                            document.body.appendChild(btn);
                        }
                    } else {
                        var zoomCtrl = document.querySelector('#detectlab-map .leaflet-top.leaflet-left');
                        if (zoomCtrl) zoomCtrl.appendChild(btn);
                    }
                    // Attach listener directly on the button (not delegated) so Leaflet's
                    // internal stopPropagation on control containers can't swallow clicks.
                    var btnEl = document.getElementById('btnLiveLocation');
                    if (btnEl) {
                        // A programmatic start can precede this delayed mount;
                        // sync the button to the watcher's source-of-truth state.
                        if (watchId !== null) {
                            btnEl.classList.add('active');
                            btnEl.title = 'Stop tracking';
                        }
                        L.DomEvent.on(btnEl, 'click', function (e) {
                            L.DomEvent.stopPropagation(e);  // prevent map click firing underneath
                            if (watchId !== null) { stopTracking(); return; }
                            startTracking();
                            // ── Manual live-location activation → Da/Nu prompt ──
                            // Ask whether the user also wants to be visible to other
                            // detectorists. NOT shown when live location is auto-started
                            // by the Detect switch — that path asks its own prompt inside
                            // toggleDetection(), so the question is never doubled up.
                            if (typeof window._promptVisibleToOthers === 'function') {
                                window._promptVisibleToOthers();
                            }
                        });
                    }
                }, 200);

                // This is shared with trail recording as well as the live-location
                // button. Keeping the marker update in one place ensures that starting a
                // trail always gives the user an immediate, visible location pin.
                function showLiveLocation(lat, lng, accuracy, shouldCenter) {
                    createMarker(lat, lng, accuracy);
                    if (shouldCenter) {
                        map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 1.2 });
                    }
                }

                function createMarker(lat, lng, accuracy) {
                    removeMarker();
                    var icon = L.divIcon({
                        className: '',
                        html: '<div class="live-location-marker"></div>',
                        iconSize: [16, 16],
                        iconAnchor: [8, 8]
                    });
                    locationMarker = L.marker([lat, lng], { icon: icon, zIndexOffset: 1000 })
                        .bindPopup('<div class="map-place-popup">You are here</div>')
                        .addTo(map);
                    if (accuracy && accuracy < 5000) {
                        locationCircle = L.circle([lat, lng], {
                            radius: accuracy,
                            color: '#C42B2B', fillColor: '#C42B2B',
                            fillOpacity: 0.08, weight: 1, opacity: 0.4
                        }).addTo(map);
                    }
                }

                function removeMarker() {
                    if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
                    if (locationCircle) { map.removeLayer(locationCircle); locationCircle = null; }
                }

                function startTracking() {
                    if (!navigator.geolocation) {
                        alert('Geolocation is not supported by your browser.');
                        return;
                    }
                    // watchId is the single source of truth — already guarded by the click handler.
                    // Keep the visual state optional for programmatic/headless
                    // starts that can happen before the button has mounted.
                    var liveBtn = document.getElementById('btnLiveLocation');
                    if (liveBtn) {
                        liveBtn.classList.add('active');
                        liveBtn.title = 'Stop tracking';
                    }
                    watchId = navigator.geolocation.watchPosition(
                        function (pos) {
                            var lat = pos.coords.latitude;
                            var lng = pos.coords.longitude;
                            var acc = pos.coords.accuracy;
                            showLiveLocation(lat, lng, acc, true);
                            // Share coordinates with detection system so it can fire immediately
                            // even if the user activates detection after live location is already on
                            _detLat = lat;
                            _detLng = lng;
                            // Publish presence so the other detectorists can see
                            // this user: live location + the "Da" answer is the
                            // whole rule (see _presenceVisible).
                            if (typeof publishDetectorPresence === 'function') {
                                publishDetectorPresence(lat, lng, _presenceVisible());
                            }
                            if (_det.active) _detCheck(lat, lng);
                        },
                        function (err) {
                            console.warn('Location error:', err.message);
                            // Notify the nearby-detectorists wait (waitForDetPosition)
                            // so it fails fast when the user denies location permission.
                            if (typeof window._onDetectGeoError === 'function') window._onDetectGeoError(err);
                            stopTracking();
                        },
                        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
                    );
                }

                function stopTracking() {
                    if (watchId !== null) {
                        navigator.geolocation.clearWatch(watchId);
                        watchId = null;
                    }
                    removeMarker();
                    var btn = document.getElementById('btnLiveLocation');
                    if (btn) {
                        btn.classList.remove('active');
                        btn.title = 'My Location';
                    }
                    // ── Clean up presence: user is no longer visible to others ──
                    // A detectorist must have BOTH detection ON AND live location ON
                    // to appear in "See other detectorists in the area".  Turning off
                    // live location means they should immediately disappear from results.
                    if (_detLat !== null && typeof publishDetectorPresence === 'function') {
                        publishDetectorPresence(_detLat, _detLng, false);
                    }
                    // If detection is still active but live location was just turned off,
                    // start detection's own GPS watcher as a fallback so the heritage-site
                    // proximity alert still works even without the live-location button on.
                    if (typeof _det !== 'undefined' && _det.active && _det.watchId === null && navigator.geolocation) {
                        _det.watchId = navigator.geolocation.watchPosition(
                            _detOnPosition,
                            function (e) {
                                console.warn('[DETECT] geo error', e.code, e.message);
                                if (typeof window._onDetectGeoError === 'function') window._onDetectGeoError(e);
                            },
                            { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
                        );
                    }
                }

                // Expose globally so the detection switch can auto-activate live location
                window._startLiveLocation = startTracking;
                window._stopLiveLocation = stopTracking;
                window._isLiveLocationActive = function () { return watchId !== null; };
                // Trail recording owns a separate GPS watch so it can be stopped without
                // turning off a manually enabled live-location session. It uses this small
                // public bridge to render the same pin and accuracy circle.
                window._showLiveLocation = showLiveLocation;

            })();

            // ── PWA NEARBY-DETECTORISTS BUTTON (last in the left icon stack) ──
            // Replaces the old bottom-bar ⊙ button with a magnifier icon in the
            // standard 38×38 map-button theme. Desktop keeps its own labelled
            // button in the .map-controls row, so this is PWA-only. It must land
            // AFTER every other stack button: the coord/track pair is injected
            // at +400ms and the offline button arrives asynchronously from
            // js/offline-maps.js, so we wait for both before appending (with a
            // bounded fallback that appends anyway).
            (function () {
                if (!document.documentElement ||
                    !document.documentElement.classList.contains('is-pwa')) return;

                function appendNearbyButton(topLeft) {
                    if (document.getElementById('pwaNearbyBtn')) return;
                    var wrap = document.createElement('div');
                    wrap.className = 'leaflet-control leaflet-bar';
                    wrap.style.cssText = 'margin-top:8px;border:none;box-shadow:none;background:none;';
                    wrap.innerHTML =
                        '<button id="pwaNearbyBtn" class="btn-nearby-pwa" type="button" title="See other detectorists in the area" aria-label="See other detectorists in the area">' +
                        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                        '<circle cx="11" cy="11" r="7" />' +
                        '<line x1="21" y1="21" x2="16.65" y2="16.65" />' +
                        '</svg>' +
                        '</button>';
                    topLeft.appendChild(wrap);
                    var btnEl = document.getElementById('pwaNearbyBtn');
                    if (btnEl) {
                        L.DomEvent.on(btnEl, 'click', function (e) {
                            L.DomEvent.stopPropagation(e);
                            if (typeof window.openNearbyDetectors === 'function') {
                                window.openNearbyDetectors();
                            }
                        });
                    }
                }

                var tries = 0;
                function tryAppend() {
                    tries++;
                    var topLeft = document.querySelector('#detectlab-map .leaflet-top.leaflet-left');
                    if (topLeft && document.getElementById('btnOfflineMaps') &&
                        document.getElementById('btnTrack')) {
                        appendNearbyButton(topLeft);
                        return;
                    }
                    if (tries < 40) {
                        setTimeout(tryAppend, 150);
                        return;
                    }
                    if (topLeft) appendNearbyButton(topLeft);
                }
                setTimeout(tryAppend, 600);
            })();

            // ── CUSTOM MEASURE BUTTON ──
            (function () {
                var measuring = false;
                var measurePoints = [];
                var measurePolyline = null;
                var measureMarkers = [];
                var measureTooltips = [];
                var totalDistance = 0;

                // Build button and inject after live location button
                var btnWrap = document.createElement('div');
                btnWrap.className = 'leaflet-control leaflet-bar';
                btnWrap.style.cssText = 'margin-top:8px;border:none;box-shadow:none;background:none;';
                btnWrap.innerHTML =
                    '<button id="btnMeasure" class="btn-measure" title="Măsoară distanța" aria-label="Activează măsurarea distanței în metri">' +
                    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none">' +
                    '<line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                    '<line x1="2" y1="14" x2="5" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
                    '<line x1="5" y1="8" x2="8" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
                    '<line x1="14" y1="2" x2="11" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
                    '<circle cx="2" cy="14" r="1.8" fill="currentColor"/>' +
                    '<circle cx="14" cy="2" r="1.8" fill="currentColor"/>' +
                    '</svg>' +
                    '</button>';

                setTimeout(function () {
                    var topLeft = document.querySelector('#detectlab-map .leaflet-top.leaflet-left');
                    if (topLeft) topLeft.appendChild(btnWrap);
                    var btnEl = document.getElementById('btnMeasure');
                    if (btnEl) {
                        L.DomEvent.on(btnEl, 'click', function (e) {
                            L.DomEvent.stopPropagation(e);
                            if (measuring) {
                                stopMeasure();
                            } else {
                                startMeasure();
                            }
                        });
                    }
                }, 250);

                function formatDistance(meters) {
                    if (meters >= 1000) {
                        return (meters / 1000).toFixed(2) + ' km';
                    }
                    return Math.round(meters) + ' m';
                }

                // Create a dedicated pane on top of everything for measure layers
                map.createPane('measurePane');
                map.getPane('measurePane').style.zIndex = 700;
                map.getPane('measurePane').style.pointerEvents = 'none';

                function clearMeasure() {
                    if (measurePolyline) { map.removeLayer(measurePolyline); measurePolyline = null; }
                    measureMarkers.forEach(function (m) { map.removeLayer(m); });
                    measureMarkers = [];
                    measureTooltips.forEach(function (t) { map.removeLayer(t); });
                    measureTooltips = [];
                    measurePoints = [];
                    totalDistance = 0;
                }

                function startMeasure() {
                    measuring = true;
                    clearMeasure();
                    var btn = document.getElementById('btnMeasure');
                    if (btn) {
                        btn.classList.add('active');
                        btn.title = 'Oprește măsurarea';
                    }
                    map.getContainer().style.cursor = 'crosshair';
                    map.on('click', onMapClick);
                    map.on('dblclick', onMapDblClick);
                }

                function stopMeasure() {
                    measuring = false;
                    map.off('click', onMapClick);
                    map.off('dblclick', onMapDblClick);
                    map.getContainer().style.cursor = '';
                    var btn = document.getElementById('btnMeasure');
                    if (btn) {
                        btn.classList.remove('active');
                        btn.title = 'Măsoară distanța';
                    }
                    // Clear all measure drawings from map
                    clearMeasure();
                }

                function makeDotIcon() {
                    return L.divIcon({
                        className: '',
                        html: '<div style="width:12px;height:12px;background:#E8772A;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.6);"></div>',
                        iconSize: [12, 12],
                        iconAnchor: [6, 6]
                    });
                }

                function onMapClick(e) {
                    L.DomEvent.stopPropagation(e);
                    var latlng = e.latlng;
                    measurePoints.push(latlng);

                    // Dot marker using divIcon on measurePane so it always renders on top
                    var dot = L.marker(latlng, {
                        icon: makeDotIcon(),
                        pane: 'measurePane',
                        zIndexOffset: 2000,
                        interactive: false
                    }).addTo(map);
                    measureMarkers.push(dot);

                    // Draw or extend polyline
                    if (measurePolyline) {
                        measurePolyline.setLatLngs(measurePoints);
                    } else {
                        measurePolyline = L.polyline(measurePoints, {
                            color: '#E8772A',
                            weight: 2.5,
                            dashArray: '6 4',
                            opacity: 0.95,
                            pane: 'measurePane'
                        }).addTo(map);
                    }

                    // Segment distance tooltip
                    if (measurePoints.length > 1) {
                        var prev = measurePoints[measurePoints.length - 2];
                        var segDist = latlng.distanceTo(prev);
                        totalDistance += segDist;

                        var mid = L.latLng(
                            (latlng.lat + prev.lat) / 2,
                            (latlng.lng + prev.lng) / 2
                        );
                        var tt = L.tooltip({ permanent: true, className: 'measure-tooltip', direction: 'top', offset: [0, -6] })
                            .setContent(formatDistance(segDist))
                            .setLatLng(mid)
                            .addTo(map);
                        measureTooltips.push(tt);

                        // Total tooltip on last dot
                        var ttTotal = L.tooltip({ permanent: true, className: 'measure-tooltip', direction: 'right', offset: [8, 0] })
                            .setContent('<span class="measure-tooltip-total">Total: ' + formatDistance(totalDistance) + '</span>')
                            .setLatLng(latlng)
                            .addTo(map);
                        measureTooltips.push(ttTotal);
                    }
                }

                function onMapDblClick(e) {
                    L.DomEvent.stopPropagation(e);
                    stopMeasure();
                }

            })();

            function escapeHtml(str) {
                if (!str) return '';
                return String(str)
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#039;');
            }

            // ── CUSTOM COORD PIN BUTTON ──
            (function () {
                var coordActive = false;
                var coordMarker = null;
                var coordPopup = null;

                // Build the button element directly (no wrapper div)
                var coordBtn = document.createElement('button');
                coordBtn.id = 'btnCoord';
                coordBtn.className = 'btn-coord';
                coordBtn.title = 'Afișează coordonatele unui punct';
                coordBtn.setAttribute('aria-label', 'Activează afișarea coordonatelor');
                coordBtn.innerHTML =
                    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                    '<path d="M8 1C5.239 1 3 3.239 3 6c0 3.75 5 9 5 9s5-5.25 5-9c0-2.761-2.239-5-5-5z" stroke="currentColor" stroke-width="1.4" fill="none"/>' +
                    '<circle cx="8" cy="6" r="1.6" fill="currentColor"/>' +
                    '</svg>';

                // Build the track-recording button element directly (no wrapper div).
                // IMPORTANT: this element MUST be declared here, before it is appended
                // below (trackWrap.appendChild) and before the TRACK RECORDING LOGIC
                // closure attaches its click handler — otherwise initMap aborts with
                // "ReferenceError: trackBtn is not defined" and the whole map fails to
                // initialize (blank/white map).
                var trackBtn = document.createElement('button');
                trackBtn.id = 'btnTrack';
                trackBtn.className = 'btn-track';
                trackBtn.title = 'Înregistrează traseu';
                trackBtn.setAttribute('aria-label', 'Înregistrează un traseu GPS');
                // Top-down footprint: a ball-of-foot oval, a separate rounded heel and five
                // graduated toes. Solid `currentColor` fill so `.btn-track.active` recolours
                // the whole print to the orange recording state.
                trackBtn.innerHTML =
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">' +
                    '<ellipse cx="11.2" cy="11.3" rx="4.15" ry="4.9" transform="rotate(-8 11.2 11.3)"/>' +
                    '<ellipse cx="12.4" cy="18.8" rx="2.7" ry="2.85" transform="rotate(-4 12.4 18.8)"/>' +
                    '<ellipse cx="6.7" cy="5.7" rx="1.85" ry="2.2" transform="rotate(20 6.7 5.7)"/>' +
                    '<ellipse cx="10.25" cy="4.2" rx="1.3" ry="1.6" transform="rotate(8 10.25 4.2)"/>' +
                    '<ellipse cx="13.05" cy="4.45" rx="1.15" ry="1.4"/>' +
                    '<ellipse cx="15.3" cy="5.4" rx="1" ry="1.25" transform="rotate(-12 15.3 5.4)"/>' +
                    '<ellipse cx="17.1" cy="6.8" rx="0.85" ry="1.05" transform="rotate(-20 17.1 6.8)"/>' +
                    '</svg>';

                // Inject it into the same wrapper as btnMeasure (they share the same leaflet-bar div)
                setTimeout(function () {
                    var measureWrap = document.getElementById('btnMeasure') && document.getElementById('btnMeasure').parentNode;
                    if (measureWrap) {
                        // Insert a visual gap then the button
                        var gap = document.createElement('div');
                        gap.style.cssText = 'height:8px;';
                        measureWrap.parentNode.insertBefore(gap, measureWrap.nextSibling);
                        var newWrap = document.createElement('div');
                        newWrap.className = 'leaflet-control leaflet-bar';
                        newWrap.style.cssText = 'border:none!important;box-shadow:none!important;background:none!important;';
                        newWrap.appendChild(coordBtn);
                        gap.parentNode.insertBefore(newWrap, gap.nextSibling);

                        // Add footstep button right after coord button
                        var trackWrap = document.createElement('div');
                        trackWrap.className = 'leaflet-control leaflet-bar';
                        trackWrap.style.cssText = 'border:none!important;box-shadow:none!important;background:none!important;';
                        trackWrap.appendChild(trackBtn);
                        gap.parentNode.insertBefore(trackWrap, newWrap.nextSibling);
                    } else {
                        // Fallback: append directly to top-left
                        var topLeft = document.querySelector('#detectlab-map .leaflet-top.leaflet-left');
                        if (topLeft) {
                            var newWrap2 = document.createElement('div');
                            newWrap2.className = 'leaflet-control leaflet-bar';
                            newWrap2.style.cssText = 'margin-top:8px;border:none!important;box-shadow:none!important;background:none!important;';
                            newWrap2.appendChild(coordBtn);
                            topLeft.appendChild(newWrap2);
                        }
                    }
                    L.DomEvent.on(coordBtn, 'click', function (e) {
                        L.DomEvent.stopPropagation(e);
                        if (coordActive) { stopCoord(); } else { startCoord(); }
                    });
                }, 400);

                function startCoord() {
                    coordActive = true;
                    var btn = document.getElementById('btnCoord');
                    if (btn) {
                        btn.classList.add('active');
                        btn.title = 'Oprește afișarea coordonatelor';
                    }
                    map.getContainer().style.cursor = 'crosshair';
                    map.on('click', onCoordClick);
                }

                function stopCoord() {
                    coordActive = false;
                    map.off('click', onCoordClick);
                    map.getContainer().style.cursor = '';
                    var btn = document.getElementById('btnCoord');
                    if (btn) {
                        btn.classList.remove('active');
                        btn.title = 'Afișează coordonatele unui punct';
                    }
                    if (coordMarker) { map.removeLayer(coordMarker); coordMarker = null; window._activeCoordMarker = null; }
                    if (coordPopup) { map.closePopup(coordPopup); coordPopup = null; }
                }

                function onCoordClick(e) {
                    L.DomEvent.stopPropagation(e);
                    var lat = e.latlng.lat.toFixed(6);
                    var lng = e.latlng.lng.toFixed(6);

                    if (coordMarker) { map.removeLayer(coordMarker); window._activeCoordMarker = null; }
                    coordMarker = L.marker(e.latlng, {
                        icon: L.divIcon({
                            className: '',
                            html: '<div style="width:10px;height:10px;background:#B8D8F0;border:2px solid #fff;border-radius:50%;box-shadow:0 0 6px rgba(0,0,0,0.6);margin-top:-5px;margin-left:-5px;"></div>',
                            iconSize: [0, 0]
                        }),
                        zIndexOffset: 900
                    }).addTo(map);
                    window._activeCoordMarker = coordMarker;

                    var popupContent = createCoordPopupContent(lat, lng);

                    if (coordPopup) { map.closePopup(coordPopup); }
                    coordPopup = L.popup({ className: 'coord-popup', closeOnClick: false, autoClose: false })
                        .setLatLng(e.latlng)
                        .setContent(popupContent)
                        .openOn(map);
                }

                // ── TRACK RECORDING LOGIC ──
                (function () {
                    var isTracking = false;
                    var trackPoints = [];
                    var trackPolyline = null;
                    var trackStartMarker = null;
                    var trackCurrentMarker = null;
                    var trackWatchId = null;
                    var trackStartTime = null;

                    // The recorded trail MUST live in its own high pane. The default
                    // overlayPane sits above the satellite base (z-index 398) but beneath the
                    // historical raster panes (610-651). Because those panes are created
                    // after overlayPane they win the paint order, so a polyline added with
                    // the default pane was drawn but completely hidden behind the imagery:
                    // the user saw "no path" while moving. 690 keeps the trail above all
                    // imagery yet below measurePane (700) and popups.
                    if (!map.getPane('trackPane')) {
                        map.createPane('trackPane');
                        map.getPane('trackPane').style.zIndex = 690;
                    }

                    function updateTrackMarkers(lat, lng) {
                        var latLng = [lat, lng];
                        if (!trackStartMarker) {
                            trackStartMarker = L.circleMarker(latLng, {
                                pane: 'trackPane',
                                radius: 5, color: '#fff', weight: 2,
                                fillColor: '#E8772A', fillOpacity: 1, interactive: false
                            }).addTo(map);
                        }
                        if (!trackCurrentMarker) {
                            trackCurrentMarker = L.circleMarker(latLng, {
                                pane: 'trackPane',
                                radius: 4, color: '#fff', weight: 2,
                                fillColor: '#E8772A', fillOpacity: 1, interactive: false
                            }).addTo(map);
                        } else {
                            trackCurrentMarker.setLatLng(latLng);
                        }
                    }

                    function clearTrackLayers() {
                        if (trackPolyline) { map.removeLayer(trackPolyline); trackPolyline = null; }
                        if (trackStartMarker) { map.removeLayer(trackStartMarker); trackStartMarker = null; }
                        if (trackCurrentMarker) { map.removeLayer(trackCurrentMarker); trackCurrentMarker = null; }
                    }

                    function startTrackingPath() {
                        if (isTracking) return;
                        if (!navigator.geolocation) {
                            alert('Geolocation is not supported by your browser.');
                            return;
                        }

                        isTracking = true;
                        trackPoints = [];
                        trackStartTime = Date.now();
                        clearTrackLayers();
                        trackBtn.classList.add('active');
                        trackBtn.title = 'Recording trail — waiting for GPS';

                        trackWatchId = navigator.geolocation.watchPosition(
                            function (pos) {
                                var lat = pos.coords.latitude;
                                var lng = pos.coords.longitude;
                                var accuracy = pos.coords.accuracy;
                                var previous = trackPoints[trackPoints.length - 1];

                                // Location providers sometimes repeat the exact same fix.
                                // Do not add those duplicates, but do keep the pin current.
                                if (!previous || previous[0] !== lat || previous[1] !== lng) {
                                    trackPoints.push([lat, lng]);
                                }
                                updateTrackMarkers(lat, lng);
                                if (typeof window._showLiveLocation === 'function') {
                                    window._showLiveLocation(lat, lng, accuracy, trackPoints.length === 1);
                                }

                                if (trackPoints.length >= 2) {
                                    if (trackPolyline) {
                                        trackPolyline.setLatLngs(trackPoints);
                                    } else {
                                        trackPolyline = L.polyline(trackPoints, {
                                            pane: 'trackPane',
                                            color: '#E8772A', weight: 4, opacity: 0.95,
                                            lineCap: 'round', lineJoin: 'round'
                                        }).addTo(map);
                                    }
                                    trackPolyline.bringToFront();
                                }
                                trackBtn.title = 'Stop recording trail (' + trackPoints.length + ' GPS points)';

                                // Auto-stop after 10 hours.
                                if (Date.now() - trackStartTime > 10 * 60 * 60 * 1000) {
                                    stopTrackingPath(true);
                                }
                            },
                            function (err) {
                                console.warn('Track location error:', err);
                                var messages = {
                                    1: 'Location permission was denied. Trail recording has stopped.',
                                    2: 'Your location is currently unavailable. Trail recording has stopped.',
                                    3: 'Location request timed out. Trail recording has stopped.'
                                };
                                stopTrackingPath(false, true);
                                alert(messages[err.code] || 'Could not get your location. Trail recording has stopped.');
                            },
                            { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
                        );
                    }

                    // suppressSave is used for a GPS failure: no save question should be
                    // shown for a recording that never successfully started.
                    function stopTrackingPath(auto, suppressSave) {
                        if (typeof auto === 'undefined') auto = false;
                        if (typeof suppressSave === 'undefined') suppressSave = false;
                        if (!isTracking) return;
                        isTracking = false;

                        if (trackWatchId !== null) {
                            navigator.geolocation.clearWatch(trackWatchId);
                            trackWatchId = null;
                        }
                        trackBtn.classList.remove('active');
                        trackBtn.title = 'Record trail';

                        if (trackPoints.length < 2) {
                            clearTrackLayers();
                            if (!suppressSave && !auto) {
                                alert('Trail recording stopped. Move a little farther to create a trail.');
                            }
                            trackPoints = [];
                            return;
                        }

                        if (auto) {
                            // Snapshot before resetting, for the same async race reason as below.
                            saveTrackToSupabase(trackPoints.slice(), true);
                            trackPoints = [];
                            return;
                        }

                        // A deliberate stop must always give the user control over whether
                        // their location history is stored.
                        //
                        // NOTE: an earlier revision also inserted into a 'trails' table here
                        // (columns name/points) before falling through to the block below.
                        // That table does not exist in this project — only 'user_tracks'
                        // (path/started_at/ended_at) is created by the migrations — so the
                        // insert always failed silently while its "Trail saved!" alert made
                        // it look like it had worked. The saved-paths panel reads
                        // 'user_tracks', which is why nothing ever showed up. Saving now goes
                        // through the single, correct code path.
                        var shouldSave = window.confirm('Save this trail to your account?');
                        // Snapshot the points: saving is async and `trackPoints` is reset
                        // below, which previously could race the insert to an empty array.
                        var pointsToSave = trackPoints.slice();

                        if (shouldSave) {
                            saveTrackToSupabase(pointsToSave, false);
                        } else {
                            clearTrackLayers();
                        }
                        trackPoints = [];
                    }

                    async function saveTrackToSupabase(points, autoStopped) {
                        try {
                            if (!window.supabaseClient) {
                                alert('Please sign in to save your trail.');
                                clearTrackLayers();
                                return false;
                            }
                            var userRes = await window.supabaseClient.auth.getUser();
                            var user = userRes && userRes.data ? userRes.data.user : null;
                            if (!user) {
                                alert('Please sign in to save your trail.');
                                if (typeof window.openAuth === 'function') window.openAuth('login');
                                clearTrackLayers();
                                return false;
                            }
                            // user_id is defaulted to auth.uid() by the migration, but sending
                            // it explicitly keeps the insert working on projects where the
                            // table was created by hand without that default (the RLS policy
                            // requires auth.uid() = user_id).
                            var payload = {
                                user_id: user.id,
                                path: points,
                                started_at: new Date(trackStartTime || Date.now()).toISOString(),
                                ended_at: new Date().toISOString(),
                                auto_stopped: !!autoStopped
                            };
                            var result = await window.supabaseClient.from('user_tracks').insert(payload);
                            if (result.error) throw result.error;

                            console.log('[Track] Path saved to Supabase (' + points.length + ' points)');
                            alert('Trail saved! Open the saved-locations panel and tick "Memorised paths" to see it.');

                            // Drop the live recording layers and let the saved-paths layer own
                            // the trail, so a freshly saved trail appears immediately when the
                            // panel is already open instead of only after a reload.
                            clearTrackLayers();
                            if (typeof window._refreshSavedPaths === 'function') {
                                window._refreshSavedPaths();
                            }
                            return true;
                        } catch (e) {
                            console.error('[Track] Failed to save path:', e);
                            // Keep the drawn trail on screen so an unlucky save does not throw
                            // away a walk the user just recorded.
                            alert('We could not save this trail: ' +
                                ((e && e.message) ? e.message : 'unknown error') +
                                '\nYour trail is still on the map.');
                            return false;
                        }
                    }

                    L.DomEvent.on(trackBtn, 'click', function (e) {
                        L.DomEvent.stopPropagation(e);
                        if (isTracking) stopTrackingPath();
                        else startTrackingPath();
                    });

                    window._trackPath = { start: startTrackingPath, stop: stopTrackingPath };
                })();

                function createCoordPopupContent(lat, lng) {
                    var pinId = 'pin_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                    if (window._activeCoordMarker) { window._activeCoordMarker.pinId = pinId; window._activeCoordMarker._pinId = pinId; }
                    var content = document.createElement('div');
                    content.className = 'coord-popup-container pin-popup';
                    content.setAttribute('data-pin-id', pinId);

                    if (!window._detectLabPins) window._detectLabPins = [];
                    window._detectLabPins.push({
                        id: pinId,
                        lat: Number(lat),
                        lng: Number(lng),
                        title: '',
                        description: '',
                        marker: window._activeCoordMarker
                    });

                    content.innerHTML =
                        '<div class="coord-popup-title">📍 Coordonate / Pin</div>' +
                        '<div class="coord-popup-row"><span class="coord-popup-label">Lat:</span><span class="coord-popup-val" title="Click pentru selecție">' + Number(lat).toFixed(6) + '</span></div>' +
                        '<div class="coord-popup-row"><span class="coord-popup-label">Lng:</span><span class="coord-popup-val" title="Click pentru selecție">' + Number(lng).toFixed(6) + '</span></div>' +
                        '<div style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px;">' +
                        '<input type="text" id="coordTitleInput" placeholder="Titlu pin (opțional)" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(184,216,240,0.25); border-radius: 4px; padding: 4px 6px; color: #F5F0EB; font-size: 0.76rem; font-family: \'Outfit\', sans-serif; width: 100%; box-sizing: border-box;" autocomplete="off">' +
                        '<textarea id="coordDescInput" placeholder="Descriere / Note (opțional)" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(184,216,240,0.25); border-radius: 4px; padding: 4px 6px; color: #F5F0EB; font-size: 0.76rem; font-family: \'Outfit\', sans-serif; width: 100%; height: 40px; resize: none; box-sizing: border-box;" autocomplete="off"></textarea>' +
                        '</div>' +
                        '<div style="margin-top:8px; display:flex; flex-direction:column; gap:5px;">' +
                        '<button type="button" class="coord-popup-copy" style="width:100%;">Copiază coordonatele</button>' +
                        '<button type="button" class="coord-popup-save" style="width:100%;">' +
                        '<svg class="coord-popup-save-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.25 1.5h9.1l2.4 2.4v10.6H2.25v-13Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M5 1.5v4h6v-4M5 14.5V9h6v5.5" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><circle cx="9.6" cy="3.5" r=".7" fill="currentColor"/></svg>' +
                        '<span class="coord-popup-save-label">Salvează Pin</span>' +
                        '</button>' +
                        '<button type="button" class="pin-create-event-btn" data-pin-id="' + pinId + '" data-lat="' + lat + '" data-lng="' + lng + '" style="width:100%; background:rgba(107,63,160,0.35); border:1px solid rgba(196,160,240,0.6); border-radius:4px; color:#c4a0f0; font-size:0.75rem; font-family:\'Outfit\',sans-serif; padding:5px 0; cursor:pointer; font-weight:600;">📅 Create Event from this Pin</button>' +
                        '<button type="button" class="delete-pin-btn pin-delete-btn coord-popup-delete" data-pin-id="' + pinId + '" style="width:100%; background:rgba(232,80,42,0.25); border:1px solid rgba(232,80,42,0.5); border-radius:4px; color:#FFB09F; font-size:0.72rem; font-family:\'Outfit\',sans-serif; padding:4px 0; cursor:pointer; font-weight:500;">🗑️ Delete Pin</button>' +
                        '</div>' +
                        '<div class="coord-popup-status" role="status" aria-live="polite"></div>';

                    var copyButton = content.querySelector('.coord-popup-copy');
                    var saveButton = content.querySelector('.coord-popup-save');
                    var titleInput = content.querySelector('#coordTitleInput');
                    var descInput = content.querySelector('#coordDescInput');
                    var status = content.querySelector('.coord-popup-status');
                    var coordinatesText = lat + ', ' + lng;

                    copyButton.addEventListener('click', function () {
                        copyCoordinates(coordinatesText, copyButton);
                    });

                    saveButton.addEventListener('click', function () {
                        var titleVal = titleInput ? titleInput.value.trim() : '';
                        var descVal = descInput ? descInput.value.trim() : '';
                        saveCoordinates(Number(lat), Number(lng), titleVal, descVal, saveButton, status);
                    });

                    // ── FIX: Direct handlers for pin actions (bypass Leaflet's disableClickPropagation
                    // which blocks document-level delegation) and avoid duplicate Create Event handling.
                    // The hardcoded .pin-create-event-btn now handles everything directly, so the
                    // augmented button will early-return if it detects this one.
                    var createEventBtnDirect = content.querySelector('.pin-create-event-btn');
                    if (createEventBtnDirect) {
                        createEventBtnDirect.addEventListener('click', function(ev) {
                            if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                            var b = ev.currentTarget || createEventBtnDirect;
                            var pId = b.getAttribute('data-pin-id') || '';
                            var pLat = parseFloat(b.getAttribute('data-lat'));
                            var pLng = parseFloat(b.getAttribute('data-lng'));
                            if (!isFinite(pLat)) pLat = Number(lat);
                            if (!isFinite(pLng)) pLng = Number(lng);
                            var pTitleEl = content.querySelector('#coordTitleInput');
                            var pTitle = pTitleEl ? pTitleEl.value.trim() : '';
                            var user = window._authUser ? window._authUser() : null;
                            if (!user) { if (typeof window.openAuth === 'function') window.openAuth('login'); return; }
                            if (typeof window.openCreateEventModal === 'function') window.openCreateEventModal(pLat, pLng, pId, pTitle);
                            var m = window._dlMap || window.map;
                            if (m) m.closePopup();
                        });
                    }
                    var deleteBtnDirect = content.querySelector('.delete-pin-btn, .pin-delete-btn, .coord-popup-delete');
                    if (deleteBtnDirect) {
                        deleteBtnDirect.addEventListener('click', function(ev) {
                            if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                            var b = ev.currentTarget || deleteBtnDirect;
                            var pId = b.getAttribute('data-pin-id') || '';
                            if (confirm('Sigur doriți să ștergeți acest pin? / Are you sure you want to delete this pin?')) {
                                window.deletePin(pId, b);
                            }
                        });
                    }

                    if (typeof window._augmentCoordPopup === 'function') {
                        window._augmentCoordPopup(content, lat, lng);
                    }

                    return content;
                }

                function copyCoordinates(text, button) {
                    function showCopied() {
                        button.textContent = '✓ Copiat!';
                        setTimeout(function () {
                            if (button.isConnected) button.textContent = 'Copiază coordonatele';
                        }, 1500);
                    }

                    function legacyCopy() {
                        var textArea = document.createElement('textarea');
                        textArea.value = text;
                        textArea.style.position = 'fixed';
                        textArea.style.opacity = '0';
                        document.body.appendChild(textArea);
                        textArea.select();
                        try {
                            document.execCommand('copy');
                            showCopied();
                        } finally {
                            document.body.removeChild(textArea);
                        }
                    }

                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).then(showCopied).catch(legacyCopy);
                    } else {
                        legacyCopy();
                    }
                }

                async function saveCoordinates(lat, lng, title, description, button, status) {
                    var label = button.querySelector('.coord-popup-save-label');
                    button.disabled = true;
                    button.classList.remove('saved', 'error');
                    label.textContent = 'Se salvează…';
                    status.textContent = '';
                    status.className = 'coord-popup-status';

                    try {
                        if (!window.supabaseClient || !window.supabaseClient.auth) {
                            throw new Error('Supabase nu este disponibil momentan.');
                        }

                        // Verify the session before inserting. The database fills user_id
                        // from auth.uid(), and its RLS policy only permits the owner to save.
                        var userResult = await window.supabaseClient.auth.getUser();
                        if (userResult.error || !userResult.data || !userResult.data.user) {
                            if (typeof window.openAuth === 'function') window.openAuth('login');
                            throw new Error('Autentifică-te pentru a salva coordonatele.');
                        }

                        var insertData = {
                            latitude: lat,
                            longitude: lng
                        };
                        if (title) insertData.title = title;
                        if (description) insertData.description = description;

                        var insertResult = await window.supabaseClient
                            .from('saved_coordinates')
                            .insert(insertData);

                        if (insertResult.error) throw insertResult.error;

                        button.classList.add('saved');
                        label.textContent = 'Salvat!';
                        status.textContent = 'Coordonatele au fost salvate.';
                        status.classList.add('success');
                    } catch (err) {
                        console.error('Nu s-au putut salva coordonatele:', err);
                        button.disabled = false;
                        button.classList.add('error');
                        label.textContent = 'Încearcă din nou';
                        status.textContent = err && err.message
                            ? err.message
                            : 'Salvarea a eșuat. Încearcă din nou.';
                        status.classList.add('error');
                    }
                }
            })();

            // ── SAVED LOCATIONS ─────────────────────────────────────────────
            // This layer is intentionally separate from the one-off coordinate
            // marker above. It is populated only while the memory-card control
            // is active, so turning the control off immediately removes every
            // saved pin from the map.
            (function () {
                var savedLocationsLayer = L.layerGroup();
                window._savedLocationsLayer = savedLocationsLayer;
                var savedPathsLayer = L.layerGroup();

                // Master button state (memory-card button). Pins and paths are
                // independent sublayers controlled by the checkboxes panel.
                var savedPanelActive = false;
                var savedPinsVisible = false;
                var savedPinsLoading = false;
                var savedPathsVisible = false;
                var savedPathsLoading = false;
                var savedSwitchesContainer = null;
                var savedSwitchesStatus = null;

                function setControlState(active) {
                    // Desktop keeps its .map-controls button; PWA answers through
                    // the "Storage" row inside the account menu (styled via
                    // #pwaStorageItem.is-active in index.html).
                    ['savedLocationsBtn', 'pwaStorageItem'].forEach(function (id) {
                        var button = document.getElementById(id);
                        if (!button) return;
                        button.classList.toggle('is-active', active);
                        button.setAttribute('aria-pressed', active ? 'true' : 'false');
                        button.title = active ? 'Hide saved locations' : 'Show saved locations';
                    });
                }

                function setSavedStatus(text, type) {
                    if (!savedSwitchesStatus) return;
                    savedSwitchesStatus.textContent = text || '';
                    savedSwitchesStatus.style.display = text ? 'block' : 'none';
                    savedSwitchesStatus.style.color = type === 'error' ? '#FFB09F' : 'rgba(184,216,240,0.72)';
                }

                function updateSavedSwitches() {
                    var pinsInput = document.getElementById('switchSavedPins');
                    if (pinsInput) {
                        pinsInput.checked = !!savedPinsVisible;
                        pinsInput.disabled = !!savedPinsLoading;
                    }
                    var pathsInput = document.getElementById('switchSavedPaths');
                    if (pathsInput) {
                        pathsInput.checked = !!savedPathsVisible;
                        pathsInput.disabled = !!savedPathsLoading;
                    }
                }

                async function getSavedLocationsUser() {
                    if (!window.supabaseClient || !window.supabaseClient.auth) return null;

                    // Let the central auth bootstrap finish when possible. This
                    // prevents a click during startup from looking like a signed
                    // out state and silently doing nothing.
                    if (window._authReadyPromise) {
                        try {
                            await Promise.race([
                                window._authReadyPromise,
                                new Promise(function (resolve) { setTimeout(resolve, 1800); })
                            ]);
                        } catch (e) {}
                    }

                    // Prefer the cached local session for responsiveness in PWA
                    // mode; fall back to getUser() for projects/browsers where
                    // getSession() is not enough.
                    try {
                        var sessionRes = await window.supabaseClient.auth.getSession();
                        var session = sessionRes && sessionRes.data ? sessionRes.data.session : null;
                        if (session && session.user) return session.user;
                    } catch (e) {}

                    try {
                        var userRes = await Promise.race([
                            window.supabaseClient.auth.getUser(),
                            new Promise(function (_, reject) {
                                setTimeout(function () { reject(new Error('Auth timeout')); }, 6000);
                            })
                        ]);
                        if (userRes && userRes.data && userRes.data.user) return userRes.data.user;
                    } catch (e) {
                        console.warn('Could not verify saved-locations session:', e);
                    }
                    return null;
                }

                function makeSavedLocationMarker(row) {
                    var rawLat = row.latitude !== undefined ? row.latitude : row.lat;
                    var rawLng = row.longitude !== undefined ? row.longitude : row.lng;
                    var lat = Number(rawLat);
                    var lng = Number(rawLng);
                    if (!isFinite(lat) || !isFinite(lng)) return null;

                    var pinId = String(row.id || ('pin_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7)));
                    var title = row.title ? escapeHtml(row.title) : 'Punct salvat';
                    var desc = row.description ? escapeHtml(row.description) : '';
                    var savedAt = row.created_at ? new Date(row.created_at) : null;

                    var events = window.getEventsData ? window.getEventsData() : [];
                    var linkedEvent = events.find(function (e) {
                        return (e.pin_id && String(e.pin_id) === pinId) ||
                            (Math.abs(Number(e.latitude) - lat) < 0.0001 && Math.abs(Number(e.longitude) - lng) < 0.0001);
                    });

                    var hasEvent = !!linkedEvent;
                    var markerClass = hasEvent ? 'saved-location-marker-wrap has-event' : 'saved-location-marker-wrap';
                    var strokeColor = hasEvent ? '#FFD700' : 'currentColor';

                    var marker = L.marker([lat, lng], {
                        icon: L.divIcon({
                            className: markerClass,
                            html: '<div class="saved-location-marker" title="' + title + '" style="' + (hasEvent ? 'border:2px solid #FFD700; box-shadow:0 0 10px rgba(255,215,0,0.8);' : '') + '">' +
                                '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="' + strokeColor + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
                                '<path d="M12 21s7-5.1 7-11a7 7 0 1 0-14 0c0 5.9 7 11 7 11Z"/>' +
                                '<circle cx="12" cy="10" r="2.3"/>' +
                                '</svg>' +
                                (hasEvent ? '<span style="position:absolute; top:-6px; right:-6px; background:#6B3FA0; border:1px solid #FFD700; border-radius:50%; font-size:10px; width:16px; height:16px; display:flex; align-items:center; justify-content:center; color:#fff;" title="Event linked">📅</span>' : '') +
                                '</div>',
                            iconSize: [28, 36],
                            iconAnchor: [14, 34],
                            popupAnchor: [0, -34]
                        }),
                        zIndexOffset: 850
                    });
                    marker.pinId = pinId;
                    marker._pinId = pinId;

                    if (!window._detectLabPins) window._detectLabPins = [];
                    var existingPinIdx = window._detectLabPins.findIndex(function (p) { return String(p.id) === pinId; });
                    if (existingPinIdx !== -1) {
                        window._detectLabPins[existingPinIdx].marker = marker;
                    } else {
                        window._detectLabPins.push({ id: pinId, lat: lat, lng: lng, title: title, description: desc, marker: marker, has_event: hasEvent });
                    }

                    var popupContainer = document.createElement('div');
                    popupContainer.className = 'coord-popup-container pin-popup';
                    popupContainer.setAttribute('data-pin-id', pinId);
                    popupContainer.style.cssText = 'min-width: 220px; pointer-events: all;';

                    var html = '<strong style="font-size:0.86rem; color:#F5F0EB;">' + title + '</strong>';
                    if (desc) {
                        html += '<p style="margin: 4px 0 6px 0; font-size:0.78rem; color:rgba(245,240,235,0.85); line-height:1.3;">' + desc.replace(/\n/g, '<br>') + '</p>';
                    }
                    if (hasEvent) {
                        html += '<div style="background: rgba(107,63,160,0.35); border: 1px solid rgba(196,160,240,0.6); border-radius: 4px; padding: 4px 8px; margin: 6px 0; font-size: 0.72rem; color: #E8D0FF;">📅 <strong>Event:</strong> ' + escapeHtml(linkedEvent.title) + '</div>';
                    }
                    html += '<div style="font-size:0.72rem; color:rgba(184,216,240,0.6); margin-top:2px;">' +
                        lat.toFixed(6) + ', ' + lng.toFixed(6) +
                        (savedAt && !isNaN(savedAt.getTime()) ? '<br><small>' + savedAt.toLocaleString() + '</small>' : '') +
                        '</div>' +
                        '<div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">' +
                        '<button type="button" class="pin-create-event-btn" data-pin-id="' + pinId + '" data-lat="' + lat + '" data-lng="' + lng + '" data-title="' + title + '" style="width:100%; background:rgba(107,63,160,0.35); border:1px solid rgba(196,160,240,0.6); border-radius:4px; color:#c4a0f0; font-size:0.75rem; font-family:\'Outfit\',sans-serif; padding:5px 0; cursor:pointer; font-weight:600;">📅 Create Event from this Pin</button>' +
                        (function () {
                            // Traseu Google Maps: destinația e chiar coordonata
                            // pinului — pinurile nu au rază, centrul e pinul însuși.
                            var dir = (window.DetectLabDirections && window.DetectLabDirections.buttonHtml)
                                ? window.DetectLabDirections.buttonHtml(lat, lng)
                                : '';
                            return dir ? dir : '';
                        })() +
                        '<button type="button" class="delete-pin-btn pin-delete-btn coord-popup-delete" data-pin-id="' + pinId + '" style="width:100%; background:rgba(232,80,42,0.25); border:1px solid rgba(232,80,42,0.5); border-radius:4px; color:#FFB09F; font-size:0.72rem; font-family:\'Outfit\',sans-serif; padding:4px 0; cursor:pointer; font-weight:500;">🗑️ Șterge pinul / Delete Pin</button>' +
                        '</div>';

                    popupContainer.innerHTML = html;
                    // ── FIX: Direct handlers for saved pin popup (same reason as coord popup)
                    (function() {
                        var ceBtn = popupContainer.querySelector('.pin-create-event-btn');
                        if (ceBtn) {
                            ceBtn.addEventListener('click', function(ev) {
                                if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                                var b = ev.currentTarget || ceBtn;
                                var pId = b.getAttribute('data-pin-id') || '';
                                var pLat = parseFloat(b.getAttribute('data-lat'));
                                var pLng = parseFloat(b.getAttribute('data-lng'));
                                var pTitle = b.getAttribute('data-title') || '';
                                if (!isFinite(pLat)) pLat = Number(lat);
                                if (!isFinite(pLng)) pLng = Number(lng);
                                var user = window._authUser ? window._authUser() : null;
                                if (!user) { if (typeof window.openAuth === 'function') window.openAuth('login'); return; }
                                if (typeof window.openCreateEventModal === 'function') window.openCreateEventModal(pLat, pLng, pId, pTitle);
                                var m = window._dlMap || window.map;
                                if (m) m.closePopup();
                            });
                        }
                        var delBtn2 = popupContainer.querySelector('.delete-pin-btn, .pin-delete-btn, .coord-popup-delete');
                        if (delBtn2) {
                            delBtn2.addEventListener('click', function(ev) {
                                if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                                var b = ev.currentTarget || delBtn2;
                                var pId2 = b.getAttribute('data-pin-id') || '';
                                if (confirm('Sigur doriți să ștergeți acest pin? / Are you sure you want to delete this pin?')) {
                                    window.deletePin(pId2, b);
                                }
                            });
                        }
                    })();
                    marker.bindPopup(popupContainer, { className: 'coord-popup' });
                    // Also handle popupopen case where Leaflet may have moved content into popup wrapper
                    // Ensure handlers are re-attached after Leaflet re-creates popup DOM (some Leaflet versions clone content)
                    marker.on('popupopen', function(e) {
                        var popupEl = e.popup && e.popup.getElement ? e.popup.getElement() : null;
                        if (!popupEl) return;
                        var btn = popupEl.querySelector('.pin-create-event-btn');
                        if (btn && !btn._dlHasCreateHandler) {
                            btn._dlHasCreateHandler = true;
                            btn.addEventListener('click', function(ev) {
                                if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                                var b = ev.currentTarget;
                                var pId = b.getAttribute('data-pin-id') || '';
                                var pLat = parseFloat(b.getAttribute('data-lat'));
                                var pLng = parseFloat(b.getAttribute('data-lng'));
                                var pTitle = b.getAttribute('data-title') || '';
                                if (!isFinite(pLat)) pLat = Number(lat);
                                if (!isFinite(pLng)) pLng = Number(lng);
                                var user = window._authUser ? window._authUser() : null;
                                if (!user) { if (typeof window.openAuth === 'function') window.openAuth('login'); return; }
                                if (typeof window.openCreateEventModal === 'function') window.openCreateEventModal(pLat, pLng, pId, pTitle);
                                var m = window._dlMap || window.map;
                                if (m) m.closePopup();
                            });
                        }
                        var dBtn = popupEl.querySelector('.delete-pin-btn, .pin-delete-btn, .coord-popup-delete');
                        if (dBtn && !dBtn._dlHasDeleteHandler) {
                            dBtn._dlHasDeleteHandler = true;
                            dBtn.addEventListener('click', function(ev) {
                                if (ev) { ev.preventDefault(); if (ev.stopPropagation) ev.stopPropagation(); if (window.L && L.DomEvent) try { L.DomEvent.stop(ev); } catch(_){} }
                                var b = ev.currentTarget;
                                var pId2 = b.getAttribute('data-pin-id') || '';
                                if (confirm('Sigur doriți să ștergeți acest pin? / Are you sure you want to delete this pin?')) {
                                    window.deletePin(pId2, b);
                                }
                            });
                        }
                    });
                    return marker;
                }

                function normalizePathPoints(points) {
                    if (typeof points === 'string') {
                        try { points = JSON.parse(points); } catch (e) { return []; }
                    }
                    if (!Array.isArray(points)) return [];
                    var out = [];
                    points.forEach(function (pt) {
                        if (Array.isArray(pt) && pt.length >= 2) {
                            out.push([Number(pt[0]), Number(pt[1])]);
                        } else if (pt && typeof pt === 'object') {
                            var lat = pt.lat !== undefined ? pt.lat : (pt.latitude !== undefined ? pt.latitude : pt.y);
                            var lng = pt.lng !== undefined ? pt.lng : (pt.longitude !== undefined ? pt.longitude : pt.x);
                            out.push([Number(lat), Number(lng)]);
                        }
                    });
                    return out.filter(function (pt) {
                        return isFinite(pt[0]) && isFinite(pt[1]);
                    });
                }

                function createSavedPathPolyline(points) {
                    var normalized = normalizePathPoints(points);
                    if (normalized.length < 2) return null;
                    // Same reasoning as the live recording layer: without an explicit
                    // high pane these polylines land on overlayPane (400) and are buried
                    // under the satellite/historical imagery panes.
                    if (!map.getPane('trackPane')) {
                        map.createPane('trackPane');
                        map.getPane('trackPane').style.zIndex = 690;
                    }
                    return L.polyline(normalized, {
                        pane: 'trackPane',
                        color: '#E8772A',
                        weight: 3,
                        opacity: 0.85
                    });
                }

                function showSavedSwitches() {
                    if (savedSwitchesContainer) {
                        updateSavedSwitches();
                        return;
                    }

                    savedSwitchesContainer = document.createElement('div');
                    savedSwitchesContainer.id = 'saved-switches';
                    savedSwitchesContainer.style.cssText =
                        'position:absolute;bottom:86px;left:12px;z-index:1200;' +
                        'background:rgba(6,14,30,0.92);border:1px solid rgba(184,216,240,0.2);' +
                        'border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:8px;' +
                        'font-size:0.75rem;color:#B8D8F0;box-shadow:0 8px 24px rgba(0,0,0,0.35);';

                    var pinsRow = document.createElement('label');
                    pinsRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
                    pinsRow.innerHTML = '<input type="checkbox" id="switchSavedPins">' +
                        '<span>Memorised pins</span>';
                    pinsRow.querySelector('input').onchange = async function () {
                        if (this.checked) {
                            await loadAndShowSavedPins();
                        } else {
                            savedPinsVisible = false;
                            savedLocationsLayer.clearLayers();
                            if (map.hasLayer(savedLocationsLayer)) map.removeLayer(savedLocationsLayer);
                            updateSavedSwitches();
                        }
                    };

                    var pathsRow = document.createElement('label');
                    pathsRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
                    pathsRow.innerHTML = '<input type="checkbox" id="switchSavedPaths">' +
                        '<span>Memorised paths</span>';
                    pathsRow.querySelector('input').onchange = async function () {
                        if (this.checked) {
                            await loadAndShowSavedPaths();
                        } else {
                            savedPathsVisible = false;
                            savedPathsLayer.clearLayers();
                            if (map.hasLayer(savedPathsLayer)) map.removeLayer(savedPathsLayer);
                            updateSavedSwitches();
                        }
                    };

                    // Offline areas are stored locally, unlike pins and trails which
                    // are synced to Supabase. Keep this category available even when
                    // the user is disconnected or has no account.
                    var offlineRow = document.createElement('label');
                    offlineRow.id = 'savedOfflineMapsRow';
                    offlineRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;color:#8fe3ff;';
                    offlineRow.innerHTML = '<input type="checkbox" id="switchOfflineMaps">' +
                        '<span>Hărți offline / Offline maps</span>';
                    offlineRow.querySelector('input').onchange = function () {
                        if (typeof window.toggleOfflineLibraryVisibility === 'function') {
                            window.toggleOfflineLibraryVisibility(this.checked);
                        } else if (savedSwitchesStatus) {
                            setSavedStatus('Offline maps are preparing…');
                        }
                    };

                    savedSwitchesStatus = document.createElement('div');
                    savedSwitchesStatus.style.cssText = 'display:none;font-size:0.68rem;line-height:1.25;max-width:180px;';

                    savedSwitchesContainer.appendChild(pinsRow);
                    savedSwitchesContainer.appendChild(pathsRow);
                    savedSwitchesContainer.appendChild(offlineRow);
                    savedSwitchesContainer.appendChild(savedSwitchesStatus);

                    var mapEl = document.getElementById('detectlab-map');
                    if (mapEl) mapEl.appendChild(savedSwitchesContainer);
                    updateSavedSwitches();
                }

                function removeSavedSwitches() {
                    if (savedSwitchesContainer) {
                        savedSwitchesContainer.remove();
                        savedSwitchesContainer = null;
                        savedSwitchesStatus = null;
                    }
                }

                async function loadAndShowSavedPins() {
                    if (savedPinsLoading) return;
                    savedPinsLoading = true;
                    setSavedStatus('Loading saved pins…');
                    updateSavedSwitches();

                    try {
                        var user = await getSavedLocationsUser();
                        if (!user) {
                            if (typeof window.openAuth === 'function') window.openAuth('login');
                            throw new Error('Log in to view saved pins.');
                        }

                        var result = await window.supabaseClient
                            .from('saved_coordinates')
                            .select('*')
                            .order('created_at', { ascending: false });
                        if (result.error) {
                            // Some older/manual tables may not have created_at;
                            // still show pins instead of failing the whole panel.
                            result = await window.supabaseClient
                                .from('saved_coordinates')
                                .select('*');
                        }
                        if (result.error) throw result.error;

                        if (!savedPanelActive) return;

                        savedLocationsLayer.clearLayers();
                        (result.data || []).forEach(function (row) {
                            var marker = makeSavedLocationMarker(row);
                            if (marker) savedLocationsLayer.addLayer(marker);
                        });
                        savedLocationsLayer.addTo(map);
                        savedPinsVisible = true;
                        setSavedStatus((result.data && result.data.length) ? '' : 'No saved pins yet.');
                    } catch (err) {
                        console.error('Could not load saved locations:', err);
                        savedPinsVisible = false;
                        savedLocationsLayer.clearLayers();
                        if (map.hasLayer(savedLocationsLayer)) map.removeLayer(savedLocationsLayer);
                        setSavedStatus((err && err.message) ? err.message : 'Could not load saved pins.', 'error');
                    } finally {
                        savedPinsLoading = false;
                        updateSavedSwitches();
                    }
                }

                async function loadAndShowSavedPaths() {
                    if (savedPathsLoading) return;
                    savedPathsLoading = true;
                    setSavedStatus('Loading saved paths…');
                    updateSavedSwitches();

                    try {
                        var user = await getSavedLocationsUser();
                        if (!user) {
                            if (typeof window.openAuth === 'function') window.openAuth('login');
                            throw new Error('Log in to view saved paths.');
                        }

                        var result = await window.supabaseClient
                            .from('user_tracks')
                            .select('*')
                            .order('started_at', { ascending: false })
                            .limit(20);
                        if (result.error) {
                            // Keep compatibility with older/manual tables that
                            // do not expose started_at yet.
                            result = await window.supabaseClient
                                .from('user_tracks')
                                .select('*')
                                .limit(20);
                        }
                        if (result.error) throw result.error;

                        if (!savedPanelActive) return;

                        savedPathsLayer.clearLayers();
                        var drawn = 0;
                        (result.data || []).forEach(function (row) {
                            var poly = createSavedPathPolyline(row.path);
                            if (!poly) return;
                            drawn++;
                            var started = row.started_at || row.created_at;
                            var when = started ? new Date(started).toLocaleString() : 'Unknown date';
                            var count = poly.getLatLngs().length;
                            poly.bindPopup('<div class="map-place-popup"><strong>Saved trail</strong><br>' +
                                escapeHtml(when) + '<br>' + count + ' GPS points</div>');
                            savedPathsLayer.addLayer(poly);
                        });
                        savedPathsLayer.addTo(map);
                        savedPathsVisible = true;

                        var rows = (result.data || []).length;
                        if (!rows) {
                            setSavedStatus('No saved paths yet.');
                        } else if (!drawn) {
                            // Rows exist but none had 2+ usable points.
                            setSavedStatus('Saved paths found, but none have enough GPS points to draw.', 'error');
                        } else {
                            setSavedStatus('');
                            // Bring the user to their trails — they are often nowhere near
                            // the current view, which otherwise looks like "nothing loaded".
                            try {
                                var bounds = savedPathsLayer.getBounds();
                                if (bounds && bounds.isValid()) {
                                    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
                                }
                            } catch (e) { /* non-fatal: the trails are drawn regardless */ }
                        }
                    } catch (err) {
                        console.error('Failed to load saved paths:', err);
                        savedPathsVisible = false;
                        savedPathsLayer.clearLayers();
                        if (map.hasLayer(savedPathsLayer)) map.removeLayer(savedPathsLayer);
                        setSavedStatus((err && err.message) ? err.message : 'Could not load saved paths.', 'error');
                    } finally {
                        savedPathsLoading = false;
                        updateSavedSwitches();
                    }
                }

                // Lets the trail recorder redraw the saved-paths layer right after a
                // successful save, so a new trail shows up without reopening the panel.
                window._refreshSavedPaths = function () {
                    if (savedPanelActive && savedPathsVisible) {
                        loadAndShowSavedPaths();
                    }
                };

                // ── TOGGLE SAVED LOCATIONS + PATHS ──
                window.toggleSavedCoordinates = async function () {
                    if (savedPanelActive) {
                        savedPanelActive = false;
                        savedPinsVisible = false;
                        savedPathsVisible = false;
                        savedLocationsLayer.clearLayers();
                        savedPathsLayer.clearLayers();
                        if (map.hasLayer(savedLocationsLayer)) map.removeLayer(savedLocationsLayer);
                        if (map.hasLayer(savedPathsLayer)) map.removeLayer(savedPathsLayer);
                        setControlState(false);
                        removeSavedSwitches();
                        if (typeof window.closeOfflineMapsLibrary === 'function') window.closeOfflineMapsLibrary();
                        return;
                    }

                    // The memory-card panel also hosts the local offline-map
                    // library. It must open without a Supabase session.
                    if (!window.supabaseClient || !window.supabaseClient.auth) {
                        savedPanelActive = true;
                        setControlState(true);
                        showSavedSwitches();
                        updateSavedSwitches();
                        return;
                    }

                    savedPanelActive = true;
                    setControlState(true);
                    showSavedSwitches();

                    // Default action of the memory-card button: show saved pins.
                    // The paths checkbox stays available even if pins fail to load.
                    await loadAndShowSavedPins();
                    if (!savedPanelActive) return;
                    setControlState(true);
                    updateSavedSwitches();
                };
            })();

            // ── ArcGIS basemap (World Imagery / Topographic / Terrain) ──
            // The working map's base is the ArcGIS basemap stack: the same Esri
            // tile services the ArcGIS SceneView atlas (europe-roman-atlas.html)
            // and the country gate use, served as plain Web Mercator tiles so
            // every existing Leaflet overlay (APM, LIDAR, historical maps,
            // DARE/Roman, reports, offline maps) stays fully functional on top
            // of it. The full 3D SceneView experience (Imagery/Topographic,
            // hillshade, elevation terrain, Roman layers) remains available on
            // the separate atlas page and in the lazy country gate; this 2D
            // stack is the engine that hosts the analytical layers. The retired
            // MapLibre 3D globe is gone — nothing else in the app references it.
            var SATELLITE_LAST_NATIVE_Z =
                (window.SATELLITE_MAX_NATIVE_Z !== undefined) ? window.SATELLITE_MAX_NATIVE_Z : 18;
            var SATELLITE_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
            var ARCGIS_TOPOGRAPHIC_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
            var ARCGIS_TERRAIN_BASE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}';
            var ARCGIS_TERRAIN_RELIEF_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Shaded_Relief/MapServer/tile/{z}/{y}/{x}';
            var SATELLITE_ATTRIBUTION = 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community';
            var ARCGIS_BASEMAP_STORAGE_KEY = 'detectlab_arcgis_basemap_v1';

            map.createPane('pane_satellite');
            map.getPane('pane_satellite').style.zIndex = 398;
            map.getPane('pane_satellite').style.pointerEvents = 'none';
            var satelliteLayer = L.tileLayer(SATELLITE_IMAGERY_URL, {
                pane: 'pane_satellite',
                opacity: 1.0,
                attribution: SATELLITE_ATTRIBUTION,
                minZoom: 1,
                maxZoom: 20,
                maxNativeZoom: SATELLITE_LAST_NATIVE_Z
            }).addTo(map);
            window._satLayer = satelliteLayer;

            // World Topographic and the World Terrain pair (base + shaded
            // relief) share the satellite pane, so every data pane (OSM places
            // 401, UAT 402, LIDAR 610, historical maps 640+…) paints above
            // whichever ArcGIS basemap is active.
            function _arcgisBasemapTile(url, extra) {
                var opts = {
                    pane: 'pane_satellite',
                    opacity: 1.0,
                    attribution: SATELLITE_ATTRIBUTION,
                    minZoom: 1,
                    maxZoom: 20,
                    maxNativeZoom: SATELLITE_LAST_NATIVE_Z
                };
                if (extra) Object.keys(extra).forEach(function (k) { opts[k] = extra[k]; });
                return L.tileLayer(url, opts);
            }
            var topographicLayer = _arcgisBasemapTile(ARCGIS_TOPOGRAPHIC_URL);
            var terrainBaseLayer = _arcgisBasemapTile(ARCGIS_TERRAIN_BASE_URL, { maxNativeZoom: 9 });
            var terrainReliefLayer = _arcgisBasemapTile(ARCGIS_TERRAIN_RELIEF_URL, { maxNativeZoom: 9 });

            var ARCGIS_BASEMAPS = {
                imagery: { layers: [satelliteLayer] },
                topographic: { layers: [topographicLayer] },
                terrain: { layers: [terrainBaseLayer, terrainReliefLayer] }
            };
            var _arcgisCurrentBasemap = 'imagery';
            try {
                var _storedBasemap = window.localStorage.getItem(ARCGIS_BASEMAP_STORAGE_KEY);
                if (_storedBasemap && ARCGIS_BASEMAPS[_storedBasemap]) _arcgisCurrentBasemap = _storedBasemap;
            } catch (e) {}

            // One source of truth for the base-map names: the buttons of the
            // retractable list AND the caption of the retracted header.
            var ARCGIS_BASEMAP_LABELS = {
                imagery: { ro: 'Imagery ArcGIS', en: 'Imagery ArcGIS' },
                topographic: { ro: 'Topographic ArcGIS', en: 'Topographic ArcGIS' },
                terrain: { ro: 'Terrain ArcGIS', en: 'Terrain ArcGIS' },
                hillshade: { ro: 'Hillshade (relief)', en: 'Hillshade (terrain)' },
                hint: { ro: 'Hartă de bază — click pentru a extinde', en: 'Base map — click to expand' }
            };

            function _arcgisBasemapUseRo() {
                var lang = (typeof window._currentLang === 'function') ? window._currentLang() : 'en';
                return String(lang).toLowerCase().indexOf('ro') === 0;
            }

            function _syncArcgisBasemapControl(key) {
                var ctrl = document.getElementById('arcgisBasemapCtrl');
                if (!ctrl) return;
                var useRo = _arcgisBasemapUseRo();
                Array.prototype.forEach.call(ctrl.querySelectorAll('[data-arcgis-basemap]'), function (btn) {
                    var btnKey = btn.getAttribute('data-arcgis-basemap');
                    var isCurrent = btnKey === key;
                    btn.classList.toggle('active', isCurrent);
                    btn.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
                    var lbl = ARCGIS_BASEMAP_LABELS[btnKey];
                    if (lbl) {
                        btn.textContent = lbl[useRo ? 'ro' : 'en'];
                        btn.title = btn.textContent;
                    }
                });
                // Header is icon-only per requirement (no writing), but keep
                // accessible name and tooltip with active basemap.
                var headLabel = ctrl.querySelector('.arcgis-basemap-header-label');
                if (headLabel) {
                    var cur = ARCGIS_BASEMAP_LABELS[key] || ARCGIS_BASEMAP_LABELS.imagery;
                    headLabel.textContent = cur[useRo ? 'ro' : 'en'];
                }
                var head = ctrl.querySelector('.arcgis-basemap-header');
                if (head) {
                    var cur2 = ARCGIS_BASEMAP_LABELS[key] || ARCGIS_BASEMAP_LABELS.imagery;
                    var activeName = cur2[useRo ? 'ro' : 'en'];
                    var hint = ARCGIS_BASEMAP_LABELS.hint[useRo ? 'ro' : 'en'];
                    head.title = activeName + ' — ' + hint;
                    head.setAttribute('aria-label', activeName + ' — ' + hint);
                }
                var hsText = ctrl.querySelector('.arcgis-basemap-hs-text');
                if (hsText) hsText.textContent = ARCGIS_BASEMAP_LABELS.hillshade[useRo ? 'ro' : 'en'];
                ctrl.setAttribute('aria-label', useRo ? 'Hartă de bază ArcGIS' : 'ArcGIS basemap');
                var hsBox = document.getElementById('arcgisBasemapHillshade');
                if (hsBox && window.DetectLabCountryDock) {
                    try { hsBox.checked = !!window.DetectLabCountryDock.isHillshadeOn(); } catch (e) {}
                }
            }

            window.setArcgisBasemap = function (key) {
                if (!ARCGIS_BASEMAPS[key]) return _arcgisCurrentBasemap;
                Object.keys(ARCGIS_BASEMAPS).forEach(function (k) {
                    ARCGIS_BASEMAPS[k].layers.forEach(function (layer) {
                        if (k === key && !map.hasLayer(layer)) layer.addTo(map);
                        else if (k !== key && map.hasLayer(layer)) map.removeLayer(layer);
                    });
                });
                _arcgisCurrentBasemap = key;
                try { window.localStorage.setItem(ARCGIS_BASEMAP_STORAGE_KEY, key); } catch (e) {}
                _syncArcgisBasemapControl(key);
                return key;
            };
            window.getArcgisBasemap = function () { return _arcgisCurrentBasemap; };

            // ── ArcGIS basemap switcher (bottom-left glass control) ──
            // The three base maps (Imagery / Topographic / Terrain) live in a
            // RETRACTABLE list: the control shows a single header row — the
            // layers icon plus the name of the active base map — and the
            // options unfold from it when the header is clicked. The list is
            // folded by default, so the control occupies one line on the map
            // (and on a phone) instead of a permanent block of buttons.
            // Picking a base map folds the list again; so does a click
            // elsewhere on the page or the Escape key.
            // The World Hillshade checkbox drives the same overlay the country
            // dock owns (window.toggleWorldHillshade) and stays in sync with
            // the dock's checkbox. The control sits bottom-left, clear of the
            // search bar (top-centre), the layer panel (right) and the PWA
            // action dock (bottom-right), so it never covers the interface.
            (function addArcgisBasemapControl() {
                var container = L.DomUtil.create('div', 'arcgis-basemap-ctrl');
                container.id = 'arcgisBasemapCtrl';
                container.setAttribute('role', 'group');
                container.setAttribute('aria-label', 'ArcGIS basemap');

                /* ── the header: the only always-visible part ───────────── */
                var header = L.DomUtil.create('button', 'arcgis-basemap-header', container);
                header.type = 'button';
                header.id = 'arcgisBasemapToggle';
                header.setAttribute('aria-expanded', 'false');
                header.setAttribute('aria-controls', 'arcgisBasemapList');
                var headerIcon = L.DomUtil.create('span', 'arcgis-basemap-header-icon', header);
                headerIcon.setAttribute('aria-hidden', 'true');
                // Icon-only header per requirement: layer icon, no writing
                headerIcon.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" focusable="false">' +
                    '<path d="M8 1.7 14.3 5 8 8.3 1.7 5 8 1.7Z" fill="none" stroke="currentColor" ' +
                    'stroke-width="1.2" stroke-linejoin="round"/>' +
                    '<path d="M1.7 8 8 11.3 14.3 8" fill="none" stroke="currentColor" stroke-width="1.2" ' +
                    'stroke-linecap="round" stroke-linejoin="round"/>' +
                    '<path d="M1.7 11 8 14.3 14.3 11" fill="none" stroke="currentColor" stroke-width="1.2" ' +
                    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
                var headerLabel = L.DomUtil.create('span', 'arcgis-basemap-header-label', header);
                var headerChevron = L.DomUtil.create('span', 'arcgis-basemap-chevron', header);
                headerChevron.setAttribute('aria-hidden', 'true');
                headerChevron.textContent = '▾';

                /* ── the list of base maps (folded by default) ───────────── */
                var list = L.DomUtil.create('div', 'arcgis-basemap-list', container);
                list.id = 'arcgisBasemapList';
                list.setAttribute('aria-hidden', 'true');
                ['imagery', 'topographic', 'terrain'].forEach(function (key) {
                    var btn = L.DomUtil.create('button', 'arcgis-basemap-btn', list);
                    btn.type = 'button';
                    btn.setAttribute('data-arcgis-basemap', key);
                    btn.title = ARCGIS_BASEMAP_LABELS[key].en;
                    btn.textContent = ARCGIS_BASEMAP_LABELS[key].en;
                    btn.addEventListener('click', function () {
                        if (typeof window.setArcgisBasemap === 'function') window.setArcgisBasemap(key);
                        /* A chosen base map folds the list again — the control
                         * goes back to its one-line state. */
                        setListOpen(false);
                    });
                });
                var hsLabel = L.DomUtil.create('label', 'arcgis-basemap-hs', list);
                var hsBox = document.createElement('input');
                hsBox.type = 'checkbox';
                hsBox.id = 'arcgisBasemapHillshade';
                hsLabel.appendChild(hsBox);
                var hsText = document.createElement('span');
                hsText.className = 'arcgis-basemap-hs-text';
                hsText.textContent = ARCGIS_BASEMAP_LABELS.hillshade.en;
                hsLabel.appendChild(hsText);
                hsBox.addEventListener('change', function () {
                    if (typeof window.toggleWorldHillshade === 'function') {
                        try { window.toggleWorldHillshade(!!hsBox.checked); } catch (e) {}
                    }
                });
                // Keep the dock's hillshade checkbox and this one in sync.
                var dockHs = document.getElementById('countryDockHillshade');
                if (dockHs) dockHs.addEventListener('change', function () {
                    if (window.DetectLabCountryDock) {
                        try { hsBox.checked = !!window.DetectLabCountryDock.isHillshadeOn(); } catch (e) {}
                    }
                });

                /* ── folding / unfolding ─────────────────────────────────── */
                function setListOpen(open) {
                    var isOpen = !!open;
                    container.classList.toggle('is-open', isOpen);
                    header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                    list.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
                    return isOpen;
                }
                /* Scriptable, so the list can be opened from anywhere (tests,
                 * a future “change the base map” action) and folded again. */
                window.setArcgisBasemapListOpen = setListOpen;
                window.toggleArcgisBasemapList = function () {
                    return setListOpen(!container.classList.contains('is-open'));
                };
                header.addEventListener('click', function () {
                    setListOpen(!container.classList.contains('is-open'));
                });
                // A click anywhere else on the page folds the list again.
                document.addEventListener('click', function (e) {
                    if (!container.classList.contains('is-open')) return;
                    var node = e && e.target;
                    if (node && container.contains(node)) return;
                    setListOpen(false);
                }, true);
                // …and so does Escape.
                document.addEventListener('keydown', function (e) {
                    if (!container.classList.contains('is-open')) return;
                    if (e.key === 'Escape' || e.keyCode === 27) setListOpen(false);
                });

                document.addEventListener('detectlab:langchange', function () {
                    // Re-labels the buttons, the hillshade row and the header
                    // caption (the active base map) in the new language.
                    _syncArcgisBasemapControl(window.getArcgisBasemap());
                });
                var control = L.control({ position: 'bottomleft' });
                control.onAdd = function () { return container; };
                control.addTo(map);
                /* The control must be IN the document before it is synced —
                 * the sync paints the header caption and the active state by
                 * id, and a control that is not mounted yet is not found. */
                _syncArcgisBasemapControl(window.getArcgisBasemap());
                setListOpen(false);
            })();

            // ── SATELIT / ISTORIC — mozaicurile Copernicus VHR (EEA discomap) ──
            // Stratul „Satelit” are patru perioade, comutate din sliderul „Istoric”:
            //   2012 → GioLand/VeryHighResolution2012 (MapServer WMS, strat „Image”)
            //   2018 → GioLand/VHR_2018_WM            (ImageServer WMS)
            //   2021 → GioLand/VHR_2021_LAEA          (ImageServer WMS)
            //   2025 → tile-urile Esri World Imagery de mai sus (stratul actual)
            // Ortofotoplanul 2016 (geospatial:of_2017_2020, GeoServer „geospatial”)
            // a fost scos din stratul de bază și înlocuit cu cele trei mozaicuri
            // VHR (Very High Resolution, 2–2,5 m) ale Copernicus Land Monitoring
            // Service, care acoperă integral România.
            // O singură perioadă e pe hartă la un moment dat — celelalte sunt scoase
            // din map, ca să nu descarce tile-uri nefolosite.
            //
            // Proiecții: 2018 e nativ Web-Mercator (sufixul „_WM”), 2012 e publicat
            // tot în 3857, iar 2021 e nativ LAEA (EPSG:3035) și NU anunță 3857 în
            // GetCapabilities — dar ArcGIS Server reproiectează oricum server-side
            // orice cod EPSG cunoscut, deci cererile Leaflet în EPSG:3857 (SRS din
            // WMS 1.1.1) sunt onorate de toate trei.
            //
            // maxNativeZoom: sursele au 2–2,5 m/pixel, adică ~z17 la latitudinea
            // României; peste acest nivel serverul doar reeșantionează, așa că
            // Leaflet face overzoom local (până la z20) în loc să mai ceară tile-uri.
            map.createPane('pane_sat_hist');
            map.getPane('pane_sat_hist').style.zIndex = 400; // aceeași nivelă ca satelitul

            // Atribuirea cerută de licența Copernicus, aceeași pentru toate cele
            // trei mozaicuri (și pentru tab-ul info al stratului Satelit).
            var COPERNICUS_LAND_ATTRIBUTION =
                "&copy; European Union's Copernicus Land Monitoring Service information";
            window.COPERNICUS_LAND_ATTRIBUTION = COPERNICUS_LAND_ATTRIBUTION;

            var SAT_HIST_LAST_NATIVE_Z = 17;

            /* The three Copernicus mosaics are DEFINED in the shared registry
             * (sat.vhr-2012 / sat.vhr-2018 / sat.vhr-2021): URL, LAYERS,
             * FORMAT, TRANSPARENT and VERSION live there and are reused by the
             * 3D view, which reaches them through the same-origin proxy because
             * discomap does not guarantee CORS headers. */
            function _satVhrWms(id) {
                return L.tileLayer.wms(DL.url2d(id), DL.wms2dOptions(id, {
                    pane: 'pane_sat_hist',
                    minZoom: 1,
                    maxZoom: 20,
                    maxNativeZoom: SAT_HIST_LAST_NATIVE_Z,
                    // Fără crossOrigin: discomap nu garantează antetele CORS, iar
                    // un <img crossorigin> respins nu s-ar mai afișa deloc. Nimic
                    // din aplicație nu eșantionează aceste tile-uri în canvas.
                    transparent: false
                }));
            }

            var SAT_HIST_PERIODS = {
                '2012': _satVhrWms('sat.vhr-2012'),
                '2018': _satVhrWms('sat.vhr-2018'),
                '2021': _satVhrWms('sat.vhr-2021')
            };
            window._satHistPeriods = SAT_HIST_PERIODS;

            // Index slider → perioadă. Ultima poziție (3) = „2025” (stratul Esri).
            var SAT_PERIOD_ORDER = ['2012', '2018', '2021', 'prezent'];
            var SAT_PERIOD_LAST_INDEX = SAT_PERIOD_ORDER.length - 1;
            window._satPeriod = 'prezent';

            window.setSatPeriod = function (val) {
                var idx = Math.round(Number(val));
                if (!isFinite(idx)) idx = SAT_PERIOD_LAST_INDEX;
                idx = Math.max(0, Math.min(SAT_PERIOD_LAST_INDEX, idx));
                var period = SAT_PERIOD_ORDER[idx];
                window._satPeriod = period;

                // Baza satelitară raster rămâne activă pentru toate perioadele;
                // mozaicul istoric ales este un overlay, iar schimbarea anului nu
                // dezactivează stratul de bază.
                SAT_PERIOD_ORDER.slice(0, SAT_PERIOD_LAST_INDEX).forEach(function (p) {
                    var layer = SAT_HIST_PERIODS[p];
                    if (!layer) return;
                    if (p === period) {
                        if (!map.hasLayer(layer)) layer.addTo(map);
                    } else if (map.hasLayer(layer)) {
                        map.removeLayer(layer);
                    }
                });

                // Opacitatea curentă din panou se aplică și mozaicurilor istorice.
                var opSlider = document.getElementById('satOpacitySlider');
                if (opSlider) {
                    var histOpacity = Number(opSlider.value) / 100;
                    Object.keys(SAT_HIST_PERIODS).forEach(function (p) {
                        SAT_HIST_PERIODS[p].setOpacity(histOpacity);
                    });
                }

                // Sincronizare UI: sliderul din panou + eticheta perioadei + tick-uri.
                var slider = document.getElementById('satPeriodSlider');
                if (slider && Number(slider.value) !== idx) slider.value = idx;
                var ticks = document.querySelectorAll('#satPeriodTicks span');
                var label = document.getElementById('satPeriodLabel');
                if (label) {
                    // „2025” vine tradus automat prin sistemul .t[data-key]
                    // (ultimul tick); anii rămân la fel în ambele limbi.
                    var presentTick = ticks.length ? ticks[ticks.length - 1] : null;
                    label.textContent = (period === 'prezent')
                        ? ((presentTick && presentTick.textContent.trim()) || '2025')
                        : period;
                }
                for (var i = 0; i < ticks.length; i++) {
                    ticks[i].classList.toggle('active', i === idx);
                }
            };

            // Starea inițială: „2025” activ (Esri pe hartă, fără tile-uri WMS
            // descărcate) + tick-ul și eticheta sincronizate.
            window.setSatPeriod(SAT_PERIOD_LAST_INDEX);

            // La schimbarea limbii, eticheta „2025” trebuie re-tradusă dacă
            // perioada activă e chiar stratul actual.
            document.addEventListener('detectlab:langchange', function () {
                if (window._satPeriod !== 'prezent') return;
                var label = document.getElementById('satPeriodLabel');
                var ticks = document.querySelectorAll('#satPeriodTicks span');
                var presentTick = ticks.length ? ticks[ticks.length - 1] : null;
                if (label && presentTick) label.textContent = presentTick.textContent.trim() || '2025';
            });

            // ── Tab-ul info al stratului Satelit ──
            // Atribuirile native Leaflet sunt ascunse prin CSS, deci sursele se
            // declară aici: imaginea actuală (Esri World Imagery) + cele trei
            // mozaicuri istorice Copernicus VHR din sliderul „Istoric”.
            window.showSatelliteInfo = function () {
                if (typeof window.showLayerInfo !== 'function') return;
                var lang = (typeof window._currentLang === 'function') ? window._currentLang() : 'ro';
                var description = (lang === 'en')
                    ? 'The working map uses standard 2D Esri World Imagery. The „Historic” slider overlays ' +
                      'Copernicus VHR mosaics — 2012 (2.5 m), 2018 and 2021 (2 m); 2025 shows current Esri imagery.'
                    : 'Harta de lucru folosește imagini Esri World Imagery în 2D. Sliderul „Istoric” suprapune ' +
                      'mozaicurile Copernicus VHR — 2012 (2,5 m), 2018 și 2021 (2 m); 2025 afișează imaginile Esri actuale.';
                window.showLayerInfo(
                    (lang === 'en') ? 'Satellite' : 'Satelit',
                    '\u00a9 Esri, Maxar, Earthstar Geographics \u00b7 ' +
                    "\u00a9 European Union's Copernicus Land Monitoring Service information",
                    description);
            };

            // ── OSM PLACES (ArcGIS FeatureServer Layer 6 — REST query, nu tile) ──
            // FeatureServer/tile nu este activat pe acest serviciu (HTTP 400).
            // Folosim query REST direct: fetch features pe bbox vizibil, randăm ca L.circleMarker.
            map.createPane('pane_osm_places');
            map.getPane('pane_osm_places').style.zIndex = 401; // above the 2D satellite base (398) and imagery overlays

            var _osmPlacesGroup = L.layerGroup([], { pane: 'pane_osm_places' });
            var _osmPlacesVisible = false;
            var _osmPlacesOpacity = 1.0;
            var _osmPlacesFetching = false;
            var _osmPlacesRenderedIds = {};

            // Sursa de date e cea încărcată mai sus în OSM_GEOJSON_URL / loadOsmGeojson().

            // Clasificare fclass -> culoare și raza markerului
            function _osmPlaceStyle(fclass, pop) {
                var r = 5, color = '#B8D8F0';
                if (fclass === 'city')            { r = 9;  color = '#FFD700'; }
                else if (fclass === 'town')       { r = 7;  color = '#FFA040'; }
                else if (fclass === 'suburb' || fclass === 'village') { r = 5; color = '#B8D8F0'; }
                else if (fclass === 'hamlet' || fclass === 'locality') { r = 4; color = '#8ab4d4'; }
                else                             { r = 4;  color = '#8ab4d4'; }
                return { r: r, color: color };
            }

            var OSM_LABEL_ZOOM = 11; // zoom minim pentru afișarea layerului

            // Icon transparent — doar eticheta text apare pe hartă
            var _osmLabelIcon = L.divIcon({ className: '', iconSize: [0, 0], iconAnchor: [0, 0] });

            function _osmBuildMarker(feat) {
                var coords = feat.geometry && feat.geometry.coordinates;
                if (!coords) return null;
                var props = feat.properties || {};
                var name = props.name || props.NAME || '';
                var fclass = props.fclass || props.type || '';
                var pop = (props.population || props.pop) ? ' · ' + (props.population || props.pop).toLocaleString() + ' loc.' : '';
                var m = L.marker([coords[1], coords[0]], {
                    pane: 'pane_osm_places',
                    icon: _osmLabelIcon,
                    interactive: false
                });
                if (name) m.bindTooltip(name, { permanent: true, direction: 'center', className: 'osm-places-tooltip', offset: [0, 0] });
                return m;
            }

            function _osmPlacesFetch() {
                if (!_osmPlacesVisible || _osmPlacesFetching) return;
                var bounds = map.getBounds();
                var sw = bounds.getSouthWest(), ne = bounds.getNorthEast();

                _osmPlacesFetching = true;
                loadOsmGeojson()
                    .then(function (features) {
                        _osmPlacesFetching = false;
                        for (var i = 0; i < features.length; i++) {
                            var feat = features[i];
                            var coords = feat.geometry && feat.geometry.coordinates;
                            if (!coords) continue;
                            var lon = coords[0], lat = coords[1];
                            // Filtrăm doar punctele aflate în viewport-ul curent
                            if (lat < sw.lat || lat > ne.lat || lon < sw.lng || lon > ne.lng) continue;

                            var props = feat.properties || {};
                            var fid = props.fid != null ? props.fid
                                    : (props.osm_id != null ? props.osm_id
                                    : (lon + '_' + lat + '_' + (props.name || props.NAME || '')));
                            if (!fid || _osmPlacesRenderedIds[fid]) continue;
                            _osmPlacesRenderedIds[fid] = true;
                            var m = _osmBuildMarker(feat);
                            if (m) _osmPlacesGroup.addLayer(m);
                        }
                    })
                    .catch(function () { _osmPlacesFetching = false; });
            }

            // La zoom change: ascunde sub zoom 11, arată și rerandează la >= 11
            map.on('zoomend', function() {
                if (!_osmPlacesVisible) return;
                if (map.getZoom() < OSM_LABEL_ZOOM) {
                    _osmPlacesGroup.clearLayers();
                    _osmPlacesRenderedIds = {};
                } else {
                    _osmPlacesGroup.clearLayers();
                    _osmPlacesRenderedIds = {};
                    _osmPlacesFetch();
                }
            });

            // Re-fetch la moveend doar dacă zoom e suficient
            map.on('moveend', function() {
                if (_osmPlacesVisible && map.getZoom() >= OSM_LABEL_ZOOM) _osmPlacesFetch();
            });

            window.toggleOsmPlacesLayer = function(on) {
                _osmPlacesVisible = on;
                if (on) {
                    _osmPlacesGroup.addTo(map);
                    if (map.getZoom() >= OSM_LABEL_ZOOM) _osmPlacesFetch();
                } else {
                    map.removeLayer(_osmPlacesGroup);
                    _osmPlacesGroup.clearLayers();
                    _osmPlacesRenderedIds = {};
                }
            };

            window.setOsmPlacesOpacity = function(val) {
                var pct = parseInt(val, 10);
                _osmPlacesOpacity = pct / 100;
                var el = document.getElementById('osmPlacesPct');
                if (el) el.textContent = pct + '%';
                _osmPlacesGroup.eachLayer(function(m) {
                    m.setStyle({
                        opacity: _osmPlacesOpacity,
                        fillOpacity: _osmPlacesOpacity * 0.75
                    });
                });
            };

            window._osmPlacesGroup = _osmPlacesGroup;

            // ── UAT LAYER — tile-uri raster PNG de pe Cloudflare R2 ──
            // (negru = clădire, alb = fără clădire). Extindem L.TileLayer și recolorăm
            // fiecare tile pe un <canvas>: negru → roșu semi-transparent (același stil
            // vizual ca vechiul strat GeoJSON), alb → complet transparent, ca harta de
            // bază să rămână vizibilă dedesubt. NOTĂ: necesită CORS activat pe bucket-ul
            // R2 (GET, orice origine sau domeniul site-ului) — altfel getImageData
            // aruncă SecurityError și tile-ul rămâne needesenat (vezi consola).
            var UatCanvasLayer = L.TileLayer.extend({
                createTile: function (coords, done) {
                    var tile = document.createElement('canvas');
                    var size = this.getTileSize();
                    tile.width = size.x; tile.height = size.y;
                    var ctx = tile.getContext('2d');
                    var url = this.getTileUrl(coords);

                    function drawRecolored(img) {
                        // Poate arunca SecurityError dacă imaginea a fost încărcată FĂRĂ CORS
                        // (canvas "tainted") — apelantul prinde eroarea și face fallback.
                        ctx.drawImage(img, 0, 0, tile.width, tile.height);
                        var imgData = ctx.getImageData(0, 0, tile.width, tile.height);
                        var px = imgData.data;
                        for (var i = 0; i < px.length; i += 4) {
                            if (_uatIsBuildingPixel(px[i], px[i + 1], px[i + 2], px[i + 3])) {
                                px[i] = 255; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 140; // clădire → roșu
                            } else {
                                px[i + 3] = 0; // fără clădire → complet transparent
                            }
                        }
                        ctx.putImageData(imgData, 0, 0);
                    }

                    function tryLoad(useCORS) {
                        var img = new Image();
                        var loadUrl = url;
                        if (useCORS) {
                            img.crossOrigin = 'anonymous';
                        } else {
                            // Cache-bust ca să nu reutilizăm din cache-ul browserului varianta
                            // CORS eșuată (unele browsere țin în cache răspunsul "opac" separat,
                            // dar mai bine sigur decât regret aici).
                            loadUrl += (url.indexOf('?') === -1 ? '?' : '&') + '_uatNoCors=1';
                        }
                        img.onload = function () {
                            try {
                                drawRecolored(img);
                            } catch (e) {
                                if (useCORS) {
                                    // Canvas "tainted" în ciuda crossOrigin (rar) — reîncercăm fără
                                    // CORS ca măcar tile-ul brut (nerecolorat) să fie vizibil.
                                    console.warn('[UAT] Recolorare eșuată cu CORS, reîncerc fără CORS (tile va fi vizibil nerecolorat):', e.message);
                                    tryLoad(false);
                                    return;
                                }
                                // Deja fără CORS și tot nu putem citi pixelii → desenăm imaginea
                                // brută, necolorată, ca măcar stratul să fie vizibil pe hartă.
                                console.warn('[UAT] Nu pot recolora tile-ul (CORS indisponibil pe bucket-ul R2) — afișez tile-ul brut, necolorat:', e.message);
                                try { ctx.clearRect(0, 0, tile.width, tile.height); ctx.drawImage(img, 0, 0, tile.width, tile.height); } catch (e2) {}
                            }
                            done(null, tile);
                        };
                        img.onerror = function () {
                            if (useCORS) {
                                // CORS a picat (header lipsă, eroare de rețea etc.) — reîncercăm
                                // fără crossOrigin ca tile-ul să apară totuși pe hartă, chiar dacă
                                // pixelii n-ar mai putea fi citiți pentru recolorare.
                                tryLoad(false);
                                return;
                            }
                            done(null, tile); // tile lipsă (404) → rămâne gol, nu blocăm harta
                        };
                        img.src = loadUrl;
                    }
                    tryLoad(true);
                    return tile;
                }
            });

            (function () {
                map.createPane('pane_uat');
                map.getPane('pane_uat').style.zIndex = 402; // deasupra OSM Places (401)

                var _uatLayer = new UatCanvasLayer(UAT_TILE_URL, {
                    pane: 'pane_uat',
                    maxNativeZoom: UAT_TILE_Z,
                    tileSize: UAT_TILE_SIZE,
                    tms: true, // tile-uri generate cu gdal2tiles.py (schema TMS) — Leaflet face conversia automat la XYZ
                    opacity: 0.9
                });

                window._uatLayer = _uatLayer;
                // Adăugăm pe hartă DOAR dacă checkbox-ul e deja bifat la încărcare —
                // înainte layerul se adăuga necondiționat, indiferent de starea reală a
                // switch-ului din UI (bug vechi, moștenit din versiunea GeoJSON).
                var _uatToggleEl = document.getElementById('uatToggle');
                if (_uatToggleEl && _uatToggleEl.checked) {
                    _uatLayer.addTo(map);
                }

                window.toggleUatLayer = function (on) {
                    // Nu se poate reactiva vizual cât timp Harta Iosefină + (premium) e
                    // activă — vezi window.toggleJosephineLayer, care apelează
                    // _uatForceHide(). Logica de excludere clădiri actuale (fundal) merge
                    // mai departe indiferent, prin uatHasBuildingNear / _uatGetTile.
                    if (on && window._uatSuppressedByJosephine) return;
                    if (on) {
                        _uatLayer.addTo(map);
                    } else {
                        map.removeLayer(_uatLayer);
                    }
                };

                // Ascunde forțat stratul vizual UAT (folosit când se activează Harta
                // Iosefină + premium) — NU afectează deloc logica de fundal (clădiri
                // dispărute), care nu depinde de _uatLayer, ci citește direct tile-urile
                // raster prin uatHasBuildingNear.
                window._uatForceHide = function () {
                    if (map.hasLayer(_uatLayer)) map.removeLayer(_uatLayer);
                    var el = document.getElementById('uatToggle');
                    if (el) el.checked = false;
                };

                // Sincronizare robustă cu vizibilitatea reală a Hărții Iosefine + —
                // ascultăm direct evenimentele Leaflet ale layerului (nu funcțiile de
                // toggle), ca să acoperim orice cale de cod care îl afișează/ascunde
                // (toggleJosephineLayer, toggleHistLayer, eventuale patch-uri ulterioare
                // peste ele — vezi mai jos în fișier), fără să depindem de a "prinde"
                // fiecare punct de apel individual.
                map.on('layeradd layerremove', function (e) {
                    if (window._jLayerRef && e.layer === window._jLayerRef) {
                        var josephineVisible = map.hasLayer(window._jLayerRef);
                        window._uatSuppressedByJosephine = josephineVisible;
                        if (josephineVisible) window._uatForceHide();
                    }
                });

                window.setUatOpacity = function (val) {
                    var pct = parseInt(val, 10);
                    var el = document.getElementById('uatPct');
                    if (el) el.textContent = pct + '%';
                    _uatLayer.setOpacity(pct / 100); // L.TileLayer are setOpacity() nativ
                };
            })();

            // ── PATRIMONIU LAYER — now sourced from DetectLab's own API instead of ──
            // ── the government WMS server. See detectlab-backend/ for the sync ──
            // ── pipeline that mirrors this data nightly into our own PostGIS. ──
            map.createPane('pane_patrimoniu');

            // Creează un pane special pentru imagini, deasupra WMS-ului
            map.createPane('pane_heritage_images');
            map.getPane('pane_heritage_images').style.zIndex = 630;

            // z-index 620: above the radius canvas (610) so site markers + their
            // labels always paint on top of the red radius circles.
            map.getPane('pane_patrimoniu').style.zIndex = 620;

            // ── CLICK-THROUGH (see the HERITAGE FEATURE HIT TEST below) ──
            // This pane hosts an L.canvas renderer, i.e. ONE <canvas> element the
            // size of the whole viewport (Renderer._update sizes it to the map size
            // plus padding) — not one element per feature.  Leaflet's stylesheet only
            // neutralises pointer events for `.leaflet-pane > svg path`; it has no
            // equivalent rule for `.leaflet-pane > canvas`.  Sitting at 620, i.e.
            // ABOVE the marker pane (600), that canvas therefore became the browser's
            // hit-test winner over the entire map the moment the heritage layer was
            // switched on, and every marker underneath it stopped receiving clicks —
            // including the Events (warrior-helmet) markers, which live in the default
            // marker pane.  That is why events became unclickable as soon as detection
            // mode was activated: toggleDetection(true) auto-enables the heritage layer
            // (heritageChk.click()), which adds this renderer's canvas to the map.  And
            // it is why turning detection back off did not help: toggleDetection(false)
            // never turns the heritage layer off again, so the canvas stayed on top.
            //
            // Making the pane click-transparent is the same treatment every other
            // full-viewport surface above the markers already gets in this file (and in
            // js/lidar-scanner.js, for exactly this reason).  Heritage features stay
            // clickable: the HERITAGE FEATURE HIT TEST below re-implements the renderer's
            // own hit test on the map's click event, which now reaches the map again.
            map.getPane('pane_patrimoniu').style.pointerEvents = 'none';

            // Base URL of your DetectLab backend API (see the backend project's
            // README). Deployed on Railway — both this and the local PM2
            // instance point at the same Supabase database, so either backend
            // serves identical data.
            var DETECTLAB_API_BASE = 'https://detectlab-backend-production.up.railway.app/api';

            window._localLayerData = { 0: null, 5: null, 6: null };
            window._detectlabApiFailed = false; // set true if any layer 0/5/6 call fails

            var _localLayerDataPromise = null;
            function loadLocalLayerData() {
                // Heritage is off by default, so do not make three large
                // GeoJSON downloads compete with the first map tiles.  The
                // promise is shared by the idle preload and by an immediate
                // layer toggle, so a user action never starts duplicate loads.
                if (_localLayerDataPromise) return _localLayerDataPromise;
                var layerIds = [0, 5, 6];
                _localLayerDataPromise = Promise.all(layerIds.map(function (id) {
                    return fetch(DETECTLAB_API_BASE + '/layers/' + id + '/geojson')
                        .then(function (r) {
                            if (!r.ok) {
                                // Read the body so the real backend error message
                                // (e.g. a Supabase/DB error) shows up in the console
                                // instead of a generic "Cannot read properties of
                                // undefined" a step later.
                                return r.text().then(function (bodyText) {
                                    throw new Error('HTTP ' + r.status + ' for layer ' + id + ': ' + bodyText);
                                });
                            }
                            return r.json();
                        })
                        .then(function (fc) {
                            if (!fc || !Array.isArray(fc.features)) {
                                throw new Error('Layer ' + id + ' response was not a valid GeoJSON FeatureCollection: ' + JSON.stringify(fc));
                            }
                            window._localLayerData[id] = fc;
                            console.log('[DetectLab] Loaded layer', id, '—', fc.features.length, 'features from local API');
                        })
                        .catch(function (err) {
                            console.error('[DetectLab] Failed to load layer', id, 'from local API. Is the backend running (npm start)?', err);
                            window._localLayerData[id] = { type: 'FeatureCollection', features: [] };
                            window._detectlabApiFailed = true;
                        });
                }));
            }

            // A canvas renderer handles tens of thousands of markers/shapes far
            // more efficiently than one DOM element per feature (which is what
            // Leaflet's default SVG renderer would create, and would seriously
            // slow down or freeze the tab at this data volume).
            var _patrimoniuCanvasRenderer = L.canvas({ pane: 'pane_patrimoniu' });
            var patrimoniuLayer = L.layerGroup([]); // not added to map — off by default
            window._patrimoniuLayer = patrimoniuLayer;

            // ── PHYSICAL-DISTANCE CLUSTERING ──
            // Do not create one Leaflet layer/DOM node for every site.  The
            // clustering helper keeps the source features as plain records and
            // the map paints only the pins that are visible in the current view.
            // This is especially important on phones, where the old one-path-
            // per-site approach could block the main thread while the map loaded.
            var _patrimoniuClusterer = window.DetectLabPatrimoniuClustering;
            var PATRIMONIU_CLUSTER_CONFIG = _patrimoniuClusterer
                ? _patrimoniuClusterer.CONFIG
                : {
                    minZoom: 6,
                    disableClusteringAtZoom: 11,
                    distanceKmByZoom: { 6: 5, 7: 4, 8: 3, 9: 2, 10: 1 },
                    defaultDistanceKm: 5,
                    indexCellSizeM: 2500
                };
            // Keep the tuning visible for diagnostics and future map controls.
            window.PATRIMONIU_CLUSTER_CONFIG = PATRIMONIU_CLUSTER_CONFIG;
            var PATRIMONIU_POLYGON_MIN_ZOOM = PATRIMONIU_CLUSTER_CONFIG.disableClusteringAtZoom || 11;
            var _heritagePointRecords = [];
            var _heritagePointIndex = _patrimoniuClusterer
                ? new _patrimoniuClusterer.SpatialIndex(PATRIMONIU_CLUSTER_CONFIG.indexCellSizeM)
                : null;
            var _heritagePointHits = [];
            var _heritagePolygonRecords = [];
            var _heritagePolygonSignature = '';
            var _heritageDataReady = false;

            // ── PLAN B: direct government WMS fallback ──
            // If the DetectLab API (Railway/Supabase) fails to return one or more of
            // layers 0/5/6, fall back to rendering the raw WMS raster straight from
            // the source ArcGIS server so the map still shows *something* instead of
            // a blank layer. Built lazily — only created if a failure actually occurs.
            var patrimoniuWmsFallback = null;
            window._patrimoniuWmsFallback = null;

            function activatePatrimoniuWmsFallback() {
                if (patrimoniuWmsFallback) return; // already active
                console.warn('[DetectLab] One or more heritage layers failed to load from the API — falling back to the direct WMS service (eism.geo-spatial.ro).');
                patrimoniuWmsFallback = L.tileLayer.wms(
                    'https://eism.geo-spatial.ro/eismgeo/services/Patrimoniu/PatrimoniuWM/MapServer/WmsServer',
                    {
                        layers: '0,5,6',
                        format: 'image/png',
                        transparent: true,
                        version: '1.1.1',
                        pane: 'pane_patrimoniu',
                        opacity: 0.9,
                        attribution: '© CIMEC — eism.geo-spatial.ro (fallback)'
                    }
                );
                window._patrimoniuWmsFallback = patrimoniuWmsFallback;
                // If the heritage layer toggle is already switched on, show the
                // fallback immediately instead of waiting for the next toggle.
                if (map.hasLayer(patrimoniuLayer)) {
                    patrimoniuWmsFallback.addTo(map);
                }
            }

            function _buildHeritagePopupContent(ran, name) {
                var cimecUrl = ran
                    ? 'https://ran.cimec.ro/sel.asp?codran=' + encodeURIComponent(ran)
                    : (name ? 'https://ran.cimec.ro/sel.asp?descript=' + encodeURIComponent(name) : 'https://ran.cimec.ro');

                var label = name || ran || 'Sit Arheologic';
                var safeLabel = String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                var safeRan = ran ? String(ran).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';

                return '<div style="font-family:Outfit,sans-serif;min-width:210px;max-width:300px;padding:4px 2px">' +
                    '<div style="font-family:Cinzel,serif;font-size:0.9rem;color:#B8D8F0;font-weight:700;' +
                    'margin-bottom:10px;line-height:1.35">🏛 ' + safeLabel + '</div>' +
                    (safeRan
                        ? '<div style="font-size:0.75rem;color:rgba(196,160,240,0.85);margin-bottom:2px">' +
                        '📍 Cod RAN: <strong style="color:#c4a0f0">' + safeRan + '</strong></div>'
                        : '') +
                    '<a href="' + cimecUrl + '" target="_blank" rel="noopener" ' +
                    'style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;' +
                    'background:linear-gradient(135deg,#6B3FA0,#4a2880);' +
                    'color:#fff !important;border-radius:6px;padding:9px 16px;font-size:0.82rem;font-weight:600;' +
                    'text-decoration:none;letter-spacing:0.04em;box-shadow:0 3px 14px rgba(107,63,160,0.5);cursor:pointer;">' +
                    '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="flex-shrink:0">' +
                    '<path d="M2 6.5h9M7.5 3l3.5 3.5L7.5 10" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                    '</svg>Vezi pe CIMEC / RAN</a>' +
                    '</div>';
            }
            window._buildHeritagePopupContent = _buildHeritagePopupContent;

            function _resolveHeritageInfo(props, layerId) {
                var p = props || {};
                var name = null, ran = null;
                if (layerId === 0) {
                    name = p.NUMESIT || p.DENUMIRE || p.DenumireSit || p.Denumire || p.NUME || null;
                    ran = p.CODSIT || p.COD_RAN || p.CodRAN || p.CODRAN || p.ran || null;
                } else if (layerId === 5) {
                    name = p.Eticheta || p.Tip || p.DENUMIRE || p.NUMESIT || null;
                    ran = p.CODSIT || p.CodRAN || p.COD_RAN || p.CODRAN || p.ran || null;
                } else if (layerId === 6) {
                    name = p.Nume || p.Toponim || p.Localitate || p.DENUMIRE || p.Denumire || null;
                    ran = p.CodRAN || p.CODSIT || p.COD_RAN || p.CODRAN || p.ran || null;
                }
                if (!name) {
                    name = p.NUMESIT || p.DENUMIRE || p.DenumireSit || p.Denumire || p.Eticheta || p.Nume || p.Toponim || p.Localitate || p.Tip || null;
                }
                if (!ran) {
                    ran = p.CODSIT || p.CodRAN || p.COD_RAN || p.CODRAN || p.ran || null;
                }
                return { name: name, ran: ran };
            }
            window._resolveHeritageInfo = _resolveHeritageInfo;

            function showLocalPopup(layerId, props, latlng) {
                var info = _resolveHeritageInfo(props, layerId);
                _openHeritagePopup(info.ran, info.name, latlng);
            }

            // Return the projected extent of a GeoJSON geometry.  Polygon
            // paths are kept as metadata and only instantiated when their
            // extent intersects a detailed (z11+) viewport.
            function _heritageGeometryBounds(geometry) {
                if (!geometry) return null;
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                function visit(coords) {
                    if (!Array.isArray(coords)) return;
                    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                        var p = _patrimoniuClusterer
                            ? _patrimoniuClusterer.project(coords[1], coords[0])
                            : { x: coords[0], y: coords[1] };
                        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
                        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
                        return;
                    }
                    for (var i = 0; i < coords.length; i++) visit(coords[i]);
                }
                visit(geometry.coordinates);
                if (!isFinite(minX)) return null;
                return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
            }

            function _heritagePointRecord(lid, feature, latlng, color, radius) {
                var record = {
                    layerId: lid,
                    feature: feature,
                    properties: feature.properties || {},
                    latlng: latlng,
                    color: color,
                    radius: radius,
                    id: feature.id
                };
                if (_heritagePointIndex) _heritagePointIndex.add(record);
                return record;
            }

            function _updatePatrimoniuPolygons() {
                if (!_heritageDataReady || !map.hasLayer(patrimoniuLayer)) return;
                var zoom = map.getZoom();
                if (zoom < PATRIMONIU_POLYGON_MIN_ZOOM) {
                    if (_heritagePolygonSignature !== 'hidden') {
                        patrimoniuLayer.clearLayers();
                        _heritagePolygonSignature = 'hidden';
                    }
                    return;
                }

                var centre = map.getCenter();
                var signature = zoom.toFixed(2) + '|' + centre.lat.toFixed(3) + ',' + centre.lng.toFixed(3);
                if (signature === _heritagePolygonSignature) return;
                _heritagePolygonSignature = signature;

                var bounds = map.getBounds();
                var sw = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(bounds.getSouth(), bounds.getWest())
                    : { x: bounds.getWest(), y: bounds.getSouth() };
                var ne = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(bounds.getNorth(), bounds.getEast())
                    : { x: bounds.getEast(), y: bounds.getNorth() };
                var padM = 1000;
                var minX = Math.min(sw.x, ne.x) - padM;
                var maxX = Math.max(sw.x, ne.x) + padM;
                var minY = Math.min(sw.y, ne.y) - padM;
                var maxY = Math.max(sw.y, ne.y) + padM;

                patrimoniuLayer.clearLayers();
                for (var i = 0; i < _heritagePolygonRecords.length; i++) {
                    var record = _heritagePolygonRecords[i];
                    var extent = record.extent;
                    if (!extent || extent.maxX < minX || extent.minX > maxX ||
                        extent.maxY < minY || extent.minY > maxY) continue;

                    var feature = record.feature;
                    var info6 = _resolveHeritageInfo(feature.properties, 6);
                    var html6 = _buildHeritagePopupContent(info6.ran, info6.name);
                    var gj = L.geoJSON(feature, {
                        renderer: _patrimoniuCanvasRenderer,
                        style: { color: '#E60000', weight: 2, fillOpacity: 0, opacity: 0.85 }
                    });
                    gj.eachLayer(function (layer) {
                        layer._dlHeritageHit = function (latlng) {
                            showLocalPopup(6, feature.properties || {}, latlng);
                        };
                        if (typeof layer.bindPopup === 'function') {
                            layer.bindPopup(html6, { className: 'patrimoniu-popup', maxWidth: 320 });
                        }
                        patrimoniuLayer.addLayer(layer);
                    });
                }
                console.log('[DetectLab] Detailed heritage polygons in view:', patrimoniuLayer.getLayers().length);
            }

            function buildPatrimoniuVisuals() {
                patrimoniuLayer.clearLayers();
                _heritagePointRecords.length = 0;
                if (_heritagePointIndex) _heritagePointIndex.clear();
                _heritagePolygonRecords.length = 0;
                _heritagePolygonSignature = '';

                [0, 5, 6].forEach(function (lid) {
                    var fc = window._localLayerData[lid];
                    if (!fc || !Array.isArray(fc.features)) return;
                    fc.features.forEach(function (f) {
                        if (!f.geometry) return;
                        var geometry = f.geometry;
                        if (geometry.type === 'Point') {
                            var c = geometry.coordinates;
                            if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
                            var ll = L.latLng(c[1], c[0]);
                            var color = lid === 5
                                ? '#E6A817'
                                : (lid === 6 ? '#E60000' :
                                    (f.properties && f.properties.COORD === 'DA' ? '#C42B2B' : '#2E9E4F'));
                            _heritagePointRecords.push(_heritagePointRecord(lid, f, ll, color, lid === 5 ? 4 : 5));
                            return;
                        }
                        if (lid === 6) {
                            var extent = _heritageGeometryBounds(geometry);
                            if (extent) _heritagePolygonRecords.push({ feature: f, extent: extent });
                        }
                    });
                });

                _heritageDataReady = true;
                _updatePatrimoniuPolygons();
                if (_circlesVisible) {
                    // The user can toggle the layer before the API promise
                    // resolves.  In that case the empty-data pass must not
                    // mark the viewport as fetched forever.
                    _fetchedBounds = null;
                    loadSiteCircles();
                }
                if (typeof _scheduleRedraw === 'function') _scheduleRedraw();

                console.log('[DetectLab] Prepared heritage records:', _heritagePointRecords.length,
                    'pins +', _heritagePolygonRecords.length, 'lazy polygons');

                var fc0 = window._localLayerData[0];
                if (fc0) {
                    var coordCounts = {};
                    fc0.features.forEach(function (f) {
                        var v = (f.properties && f.properties.COORD) || '(missing)';
                        coordCounts[v] = (coordCounts[v] || 0) + 1;
                    });
                    console.log('[DetectLab] Layer 0 COORD value distribution:', coordCounts);
                }
            }

            function _startLocalLayerDataLoad() {
                return loadLocalLayerData().then(function () {
                    // The idle preload and an early toggle can both attach a
                    // continuation to the same promise; build the visual index
                    // exactly once.
                    if (!_heritageDataReady) buildPatrimoniuVisuals();
                    if (window._detectlabApiFailed) activatePatrimoniuWmsFallback();
                    return window._localLayerData;
                });
            }
            window._loadLocalLayerData = _startLocalLayerDataLoad;

            // Give the base map and controls a clear first frame.  If the
            // layer is requested before idle time, togglePatrimoniuLayer calls
            // _startLocalLayerDataLoad immediately instead.
            var _heritageToggleAtLoad = document.getElementById('patrimoniuToggle');
            if (_heritageToggleAtLoad && _heritageToggleAtLoad.checked) {
                _startLocalLayerDataLoad();
            } else if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(_startLocalLayerDataLoad, { timeout: 2000 });
            } else {
                setTimeout(_startLocalLayerDataLoad, 1200);
            }

            // ── HERITAGE FEATURE HIT TEST ──
            // pane_patrimoniu is click-transparent (see the pointerEvents note where the
            // pane is created), so its canvas can no longer steal clicks from the markers
            // underneath it — but that also means Leaflet's canvas renderer never receives
            // the DOM click it uses to dispatch feature events.  We therefore run the same
            // hit test the renderer would have run (Canvas._onClick: walk the layers, keep
            // the LAST one whose _containsPoint matches, i.e. the one drawn on top) from
            // the map's own click event.
            //
            // This listener is registered on the map, so Leaflet only calls it when the
            // click did not land on an interactive layer (a marker, a popup, a control).
            // Events/pins/detectorist markers therefore keep priority over heritage dots,
            // which matches the previous stacking order (markers were drawn under this
            // canvas, but were the intended click target).
            map.on('click', function (e) {
                if (!map.hasLayer(patrimoniuLayer)) return;   // heritage layer switched off
                if (!e.latlng || !e.containerPoint) return;

                // Ignore the click that terminates a pan. This is the same guard the
                // canvas renderer applies in Canvas._onClick, and unlike the mousedown
                // delta used further down for the WMS query it is touch-safe — which
                // matters because this app is installed as a PWA.
                if (typeof map._draggableMoved === 'function' && map._draggableMoved(map)) return;

                // Pins are painted on a click-through canvas, so hit-test the
                // small list created during the last frame before checking the
                // (lazy) polygon paths below.
                var point = e.layerPoint || map.containerPointToLayerPoint(e.containerPoint);
                for (var hi = _heritagePointHits.length - 1; hi >= 0; hi--) {
                    var pointHit = _heritagePointHits[hi];
                    var pdx = point.x - pointHit.point.x;
                    var pdy = point.y - pointHit.point.y;
                    if (pdx * pdx + pdy * pdy > pointHit.radius * pointHit.radius) continue;
                    var hitCluster = pointHit.cluster;
                    if (hitCluster.isCluster) {
                        var clusterBounds = L.latLngBounds(hitCluster.members.map(function (member) {
                            return member.latlng;
                        }));
                        if (clusterBounds.isValid()) {
                            map.fitBounds(clusterBounds, {
                                padding: [32, 32],
                                maxZoom: Math.min(RADIUS_DETAIL_ZOOM, map.getMaxZoom())
                            });
                        } else {
                            map.setZoom(Math.min(RADIUS_DETAIL_ZOOM, map.getZoom() + 1));
                        }
                    } else {
                        var hitRecord = hitCluster.members[0];
                        showLocalPopup(hitRecord.layerId, hitRecord.properties, hitRecord.latlng);
                    }
                    return;
                }

                // e.layerPoint is the same space _containsPoint works in: Path._project()
                // stores its geometry via map.latLngToLayerPoint().
                var hit = null;
                patrimoniuLayer.eachLayer(function (layer) {
                    if (typeof layer._dlHeritageHit !== 'function') return;
                    if (typeof layer._containsPoint !== 'function' || !layer._containsPoint(point)) return;
                    hit = layer;   // keep the last match = the one painted on top
                });
                if (hit) hit._dlHeritageHit(e.latlng);
            });

            // ── CLICK → WMS GetFeatureInfo → CIMEC popup + 600m radius circle ──
            var _WMS = 'https://eism.geo-spatial.ro/eismgeo/services/Patrimoniu/PatrimoniuWM/MapServer/WmsServer';

            // Track mousedown position to distinguish clicks from drags
            var _mdX = 0, _mdY = 0;
            document.getElementById('detectlab-map').addEventListener('mousedown', function (ev) {
                _mdX = ev.clientX; _mdY = ev.clientY;
            });

            // ── ALWAYS-ON 600m RADIUS CIRCLES ──
            // Queries the ArcGIS REST feature service for all sites in the current view
            // and draws a 600m semi-transparent red circle for every point / polygon vertex.
            // Cached by OBJECTID — pan/zoom never re-draws duplicates.

            // ── FLAT-OPACITY CANVAS OVERLAY ──
            // The display and site canvases are direct children of
            // .leaflet-map-pane.  Their pixels are layer-point coordinates and
            // their element position is the same layer-point top-left used by
            // L.Canvas.  The map pane supplies the pan transform; the child
            // transform below supplies only Leaflet's zoom-animation delta.
            var _offscreenCanvas = document.createElement('canvas');
            var _offscreenCtx = _offscreenCanvas.getContext('2d');
            var _displayCanvas = document.createElement('canvas');
            var _displayCtx = _displayCanvas.getContext('2d');

            var _mapContainer = map.getContainer();
            var _mapPane = _mapContainer.querySelector('.leaflet-map-pane');
            // leaflet-zoom-animated + zoomanim (below) keep the 600 m radii
            // glued to their sites while the map scales. Without that class the
            // canvas sits still in layer space while tiles/vectors CSS-scale,
            // so every heritage circle appears to slide off its site.
            _displayCanvas.className = 'leaflet-zoom-animated';
            _displayCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:650;';
            _mapPane.appendChild(_displayCanvas);

            // Site pins use a second canvas.  Keeping them separate from the
            // radius canvas lets us paint the pins above the translucent radius
            // footprint while still keeping both surfaces click-through.
            var _sitesCanvas = document.createElement('canvas');
            var _sitesCtx = _sitesCanvas.getContext('2d');
            _sitesCanvas.className = 'leaflet-zoom-animated';
            _sitesCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:655;display:none;';
            _mapPane.appendChild(_sitesCanvas);

            // Zoom-animation state for the custom canvas — same fields L.Renderer
            // stores so _updateTransform can scale around the last drawn view.
            var _canvasCenter = null;
            var _canvasZoom = null;
            // Project-space coordinate of bitmap pixel (0,0) of the last drawn
            // frame, i.e. map.getPixelOrigin() + topLeft.  This — and not the
            // unrounded project(_canvasCenter, zoom) L.Renderer uses — is the
            // anchor the bitmap content was actually drawn against, so it is the
            // only point the zoom-animation transform may scale around.
            var _canvasAnchor = null;
            // Debug/regression hook: the view the canvases were last drawn for,
            // the anchor above and the transform currently on the elements.
            var _canvasState = { center: null, zoom: null, anchor: null, transform: null };
            window._patrimoniuCanvasState = _canvasState;

            // Layer-point position WITHOUT Leaflet's per-point integer rounding.
            // map.latLngToLayerPoint() rounds every point to the pixel grid
            // because Leaflet positions markers and vector paths on integer
            // pixels.  These canvases are CSS-scaled for the whole duration of a
            // zoom animation, so a 0.5 px rounding baked into the bitmap is
            // multiplied by the zoom scale (8x for a three-level jump) and shows
            // up as the pins/radii sliding off their site.  Projecting unrounded
            // keeps the bitmap exactly on the geographic position in every frame.
            function _layerPointUnrounded(latlng, zoom) {
                return map.project(latlng, zoom == null ? map.getZoom() : zoom)
                    .subtract(map.getPixelOrigin());
            }

            var FLAT_OPACITY = 0.35;   // default visible opacity; slider can adjust
            var STROKE_COLOR = '#C42B2B';
            var FILL_COLOR = '#C42B2B';
            var _circleStore = {};
            var _radiusShapeIndex = _patrimoniuClusterer
                ? new _patrimoniuClusterer.SpatialIndex(5000)
                : null;
            var _heritageImageStore = {};
            var _heritageImageSeen = {};
            var _heritageImagesVisible = false;
            var _circlesVisible = false;
            var _radiusDetailMode = null;

            function _storeRadiusShapes(key, shapes) {
                shapes = Array.isArray(shapes) ? shapes : [];
                _circleStore[key] = shapes;
                if (!_radiusShapeIndex) return;
                for (var i = 0; i < shapes.length; i++) {
                    var shape = shapes[i];
                    if (!shape || shape.type !== 'circle' || !shape.latlng) continue;
                    _radiusShapeIndex.add({
                        latlng: shape.latlng,
                        shape: shape,
                        radius: shape.radius || 600,
                        key: key
                    });
                }
            }

            // Expune global pentru debugging
            window._heritageImageStore = _heritageImageStore;
            window._heritageImageSeen = _heritageImageSeen;
            window._heritageImagesVisible = _heritageImagesVisible;
            window._circlesVisible = _circlesVisible;
            window._circleStore = _circleStore;

            // The two canvases are direct children of Leaflet's map pane.  They
            // therefore use the same two-step coordinate contract as L.Canvas:
            // layer points are drawn in the canvas after compensating for its
            // layer-point top-left, and Leaflet's renderer transform is applied
            // to the element only while a zoom is animating.  In particular,
            // the map pane's pan transform and this child transform must not be
            // added together as if they were in the same coordinate space.
            //
            // Keep this formula the same *shape* as L.Renderer._updateTransform.
            // Its _getNewPixelOrigin() term already includes the map-pane
            // position, so adding a second hand-made container offset here would
            // double the pan (and breaks pinch zoom as well as mouse zoom).
            //
            // One deliberate difference from L.Renderer: the last-drawn-view
            // term is the exact bitmap anchor (pixelOrigin + topLeft, recorded by
            // the redraw) instead of project(_canvasCenter, zoom).  Leaflet's own
            // renderers use the unrounded centre while their content is drawn on
            // the rounded pixel grid, which leaves a sub-pixel error that the
            // zoom scale multiplies — the residual slide this canvas used to
            // show.  Scaling the anchor that the content was drawn against has no
            // such error: viewport = scale * anchor - newPixelOrigin + scale *
            // (bitmap - anchor) is exactly project(latlng, targetZoom) - origin.
            function _updateCanvasTransform(center, zoom) {
                if (_canvasAnchor == null || _canvasZoom == null || !_displayCanvas) return;
                var scale = map.getZoomScale(zoom, _canvasZoom);
                // Mirror GridLayer's rounding: tile containers round their
                // translate so that canvas and tiles share the exact same
                // integer offset during the CSS transition.  Without rounding
                // the canvas can sit on a fractional pixel while tiles are
                // snapped to whole pixels, producing the PWA-only slide.
                var topLeftOffset = L.point(_canvasAnchor).multiplyBy(scale)
                    .subtract(map._getNewPixelOrigin(center, zoom))._round();
                if (L.DomUtil.setTransform) {
                    L.DomUtil.setTransform(_displayCanvas, topLeftOffset, scale);
                    L.DomUtil.setTransform(_sitesCanvas, topLeftOffset, scale);
                    _canvasState.transform = _displayCanvas.style.transform;
                } else {
                    L.DomUtil.setPosition(_displayCanvas, topLeftOffset);
                    L.DomUtil.setPosition(_sitesCanvas, topLeftOffset);
                    _canvasState.transform = _displayCanvas.style.transform;
                }
            }

            function _redrawHeritageSites() {
                if (!_sitesCanvas || !_sitesCtx || !_heritageDataReady ||
                    !map.hasLayer(patrimoniuLayer)) {
                    if (_sitesCtx && _sitesCanvas) {
                        _sitesCtx.clearRect(0, 0, _sitesCanvas.width, _sitesCanvas.height);
                    }
                    _heritagePointHits = [];
                    return;
                }

                var size = map.getSize();
                if (_sitesCanvas.width !== size.x) _sitesCanvas.width = size.x;
                if (_sitesCanvas.height !== size.y) _sitesCanvas.height = size.y;

                var zoom = map.getZoom();
                var clusterDistanceKm = _patrimoniuClusterer
                    ? _patrimoniuClusterer.getDistanceKm(zoom, PATRIMONIU_CLUSTER_CONFIG)
                    : (zoom >= 11 ? 0 : Math.max(1, 11 - Math.floor(zoom)));
                var clusterDistanceM = clusterDistanceKm * 1000;
                var padM = clusterDistanceM + 1000;
                var bounds = map.getBounds();
                var sw = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(bounds.getSouth(), bounds.getWest())
                    : { x: bounds.getWest(), y: bounds.getSouth() };
                var ne = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(bounds.getNorth(), bounds.getEast())
                    : { x: bounds.getEast(), y: bounds.getNorth() };
                var minX = Math.min(sw.x, ne.x) - padM;
                var maxX = Math.max(sw.x, ne.x) + padM;
                var minY = Math.min(sw.y, ne.y) - padM;
                var maxY = Math.max(sw.y, ne.y) + padM;
                var candidates = _heritagePointIndex
                    ? _heritagePointIndex.queryBBox(minX, minY, maxX, maxY)
                    : _heritagePointRecords.filter(function (record) {
                        return record._clusterX >= minX && record._clusterX <= maxX &&
                            record._clusterY >= minY && record._clusterY <= maxY;
                    });

                var clusters = _patrimoniuClusterer
                    ? _patrimoniuClusterer.clusterRecords(candidates, zoom, _heritagePointIndex, PATRIMONIU_CLUSTER_CONFIG)
                    : candidates.map(function (record) {
                        return { isCluster: false, count: 1, members: [record], latlng: record.latlng };
                    });

                var topLeft = map.containerPointToLayerPoint([0, 0]);
                var ctx = _sitesCtx;
                ctx.clearRect(0, 0, size.x, size.y);
                ctx.save();
                ctx.translate(-topLeft.x, -topLeft.y);
                ctx.lineWidth = 1.5;
                _heritagePointHits = [];

                for (var i = 0; i < clusters.length; i++) {
                    var cluster = clusters[i];
                    // A cluster is kept when at least one member intersects the
                    // real viewport.  The candidate margin above is necessary
                    // so a group on the edge does not disappear while panning.
                    var intersects = cluster.maxX >= Math.min(sw.x, ne.x) &&
                        cluster.minX <= Math.max(sw.x, ne.x) &&
                        cluster.maxY >= Math.min(sw.y, ne.y) &&
                        cluster.minY <= Math.max(sw.y, ne.y);
                    if (!intersects) continue;

                    var ll = cluster.latlng || (cluster.members[0] && cluster.members[0].latlng);
                    if (!ll) continue;
                    var point = _layerPointUnrounded(ll);
                    var pixelRadius;
                    if (cluster.isCluster) {
                        // Keep cluster icons compact even when a long chain of
                        // nearby sites has a large geographic extent.
                        pixelRadius = Math.min(22, 11 + Math.log(cluster.count) * 2);
                        ctx.beginPath();
                        ctx.fillStyle = 'rgba(22, 13, 45, 0.96)';
                        ctx.strokeStyle = '#C4A0F0';
                        ctx.arc(point.x, point.y, pixelRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                        ctx.fillStyle = '#F5F0EB';
                        ctx.font = '600 ' + (cluster.count > 99 ? '9px' : '10px') + ' Outfit, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(cluster.count > 9999 ? '9999+' : String(cluster.count), point.x, point.y);
                    } else {
                        var record = cluster.members[0];
                        pixelRadius = record.radius || 5;
                        ctx.beginPath();
                        ctx.fillStyle = record.color || '#C42B2B';
                        ctx.strokeStyle = record.color || '#C42B2B';
                        ctx.globalAlpha = 0.9;
                        ctx.arc(point.x, point.y, pixelRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                        ctx.globalAlpha = 1;
                    }

                    _heritagePointHits.push({
                        latlng: ll,
                        point: point,
                        radius: Math.max(pixelRadius + 4, 9),
                        cluster: cluster
                    });
                }
                ctx.restore();
            }

            function _redrawAll() {
                // During CSS zoom animation or pinch the map's pixelOrigin
                // already sits at the target/intermediate zoom while tiles
                // are mid-scale. Redrawing now would jump circles/pins to
                // final pixels and make them slide — the PWA glitch.
                if (map._animatingZoom) return;
                if (map.touchZoom && map.touchZoom._zooming) return;

                // Re-cluster only for the settled viewport.  During a zoom
                // animation both custom canvases are transformed together with
                // the rest of the map by _updateCanvasTransform().
                _redrawHeritageSites();

                var size = map.getSize();

                // Exact same approach as Leaflet's own L.Canvas renderer:
                // 1. Position the canvas element at the top-left corner of the viewport
                //    in layer-point space using L.DomUtil.setPosition (translate3d).
                // 2. Size the canvas to the viewport.
                // 3. Translate the 2D context by -topLeft so that latLngToLayerPoint()
                //    coords draw at the correct canvas pixel.
                var topLeft = map.containerPointToLayerPoint([0, 0]);
                // Both custom surfaces are drawn in the same layer-point space.
                // Reset BOTH elements after every settled move/zoom: setTransform()
                // from zoomanim must never remain on _sitesCanvas when its pixels
                // are redrawn at the new zoom.  Previously only _displayCanvas was
                // reset, which applied the zoom transform twice to pins/clusters
                // and left them offset after pan/zoom.
                L.DomUtil.setPosition(_displayCanvas, topLeft);
                L.DomUtil.setPosition(_sitesCanvas, topLeft);
                _canvasCenter = map.getCenter();
                _canvasZoom = map.getZoom();
                // Project-space origin of bitmap pixel (0,0) for this frame.
                // _updateCanvasTransform() may only scale around this anchor:
                // the pixels were drawn relative to getPixelOrigin() + topLeft,
                // both of which include Leaflet's integer rounding.
                _canvasAnchor = L.point(map.getPixelOrigin()).add(topLeft);
                _canvasState.center = _canvasCenter;
                _canvasState.zoom = _canvasZoom;
                _canvasState.anchor = _canvasAnchor;
                _canvasState.transform = _displayCanvas.style.transform;

                if (_offscreenCanvas.width !== size.x) _offscreenCanvas.width = size.x;
                if (_offscreenCanvas.height !== size.y) _offscreenCanvas.height = size.y;
                if (_displayCanvas.width !== size.x) _displayCanvas.width = size.x;
                if (_displayCanvas.height !== size.y) _displayCanvas.height = size.y;

                if (!_circlesVisible || FLAT_OPACITY === 0) {
                    _displayCtx.clearRect(0, 0, _displayCanvas.width, _displayCanvas.height);
                    return;
                }

                var ctx = _offscreenCtx;
                ctx.clearRect(0, 0, _offscreenCanvas.width, _offscreenCanvas.height);
                // Shift context so latLngToLayerPoint coords map to correct canvas pixels
                ctx.save();
                ctx.translate(-topLeft.x, -topLeft.y);
                ctx.fillStyle = FILL_COLOR;
                ctx.strokeStyle = STROKE_COLOR;
                ctx.lineWidth = 1.5;

                var radiusZoom = map.getZoom();
                var radiusDistanceKm = (radiusZoom < MIN_ZOOM) ? 0 :
                    (_patrimoniuClusterer
                        ? _patrimoniuClusterer.getDistanceKm(radiusZoom, PATRIMONIU_CLUSTER_CONFIG)
                        : (radiusZoom >= 11 ? 0 : Math.max(1, 11 - Math.floor(radiusZoom))));
                var radiusDistanceM = radiusDistanceKm * 1000;
                var radiusPadM = (radiusDistanceM > 0 ? radiusDistanceM : 700) + 700;
                var radiusBounds = map.getBounds();
                var radiusSw = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(radiusBounds.getSouth(), radiusBounds.getWest())
                    : { x: radiusBounds.getWest(), y: radiusBounds.getSouth() };
                var radiusNe = _patrimoniuClusterer
                    ? _patrimoniuClusterer.project(radiusBounds.getNorth(), radiusBounds.getEast())
                    : { x: radiusBounds.getEast(), y: radiusBounds.getNorth() };
                var radiusMinX = Math.min(radiusSw.x, radiusNe.x) - radiusPadM;
                var radiusMaxX = Math.max(radiusSw.x, radiusNe.x) + radiusPadM;
                var radiusMinY = Math.min(radiusSw.y, radiusNe.y) - radiusPadM;
                var radiusMaxY = Math.max(radiusSw.y, radiusNe.y) + radiusPadM;
                var radiusRecords = _radiusShapeIndex
                    ? _radiusShapeIndex.queryBBox(radiusMinX, radiusMinY, radiusMaxX, radiusMaxY)
                    : [];
                var radiusItems = radiusDistanceM > 0 && _patrimoniuClusterer
                    ? _patrimoniuClusterer.clusterRecords(
                        radiusRecords, radiusZoom, _radiusShapeIndex, PATRIMONIU_CLUSTER_CONFIG)
                    : radiusRecords.map(function (record) {
                        return {
                            isCluster: false,
                            count: 1,
                            members: [record],
                            latlng: record.latlng,
                            minX: record._clusterX,
                            minY: record._clusterY,
                            maxX: record._clusterX,
                            maxY: record._clusterY
                        };
                    });

                // At country scale one protection footprint is painted for a
                // group, while the raw 600 m shapes remain in _circleStore for
                // proximity detection.  As the zoom increases the grouping
                // distance shrinks, and z11+ uses every raw shape again.
                for (var ri = 0; ri < radiusItems.length; ri++) {
                    var radiusItem = radiusItems[ri];
                    if (radiusItem.maxX < Math.min(radiusSw.x, radiusNe.x) ||
                        radiusItem.minX > Math.max(radiusSw.x, radiusNe.x) ||
                        radiusItem.maxY < Math.min(radiusSw.y, radiusNe.y) ||
                        radiusItem.minY > Math.max(radiusSw.y, radiusNe.y)) continue;
                    var radiusLatLng = radiusItem.latlng ||
                        (radiusItem.members[0] && radiusItem.members[0].latlng);
                    if (!radiusLatLng) continue;

                    var radiusMeters = 600;
                    if (radiusItem.isCluster) {
                        var maxMemberDistance = 0;
                        for (var mi = 0; mi < radiusItem.members.length; mi++) {
                            var member = radiusItem.members[mi];
                            var dx = member._clusterX - radiusItem.x;
                            var dy = member._clusterY - radiusItem.y;
                            maxMemberDistance = Math.max(maxMemberDistance, Math.sqrt(dx * dx + dy * dy));
                        }
                        // The larger footprint communicates the area occupied
                        // by the grouped sites, but is capped so a long chain
                        // cannot cover the entire map at once.
                        radiusMeters = Math.min(5000, 600 + maxMemberDistance);
                    }
                    var radiusPoint = _layerPointUnrounded(radiusLatLng);
                    var radiusPx = _metersToPixels(radiusMeters, radiusLatLng);
                    if (radiusPx < 0.35) continue;
                    ctx.beginPath();
                    ctx.arc(radiusPoint.x, radiusPoint.y, radiusPx, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.restore();
                _displayCtx.clearRect(0, 0, _displayCanvas.width, _displayCanvas.height);
                _displayCtx.globalAlpha = FLAT_OPACITY;
                _displayCtx.drawImage(_offscreenCanvas, 0, 0);
                _displayCtx.globalAlpha = 1;
            }

            function _metersToPixels(meters, latlng) {
                // Project a point `meters` east of the site with the same
                // unrounded projection the circle centre uses, so the radius
                // cannot drift from the site when zoom (or CRS scale) changes.
                // Projecting instead of using latLngToLayerPoint() matters here:
                // that helper rounds both points to whole pixels, and a rounding
                // baked into the bitmap is multiplied by the zoom scale for the
                // whole duration of a zoom animation (1 px reads as 8 px on a
                // three-level jump).
                var latRad = latlng.lat * Math.PI / 180;
                var cos = Math.cos(latRad);
                var lngDelta = meters / (111320 * Math.max(Math.abs(cos), 0.2));
                var zoom = map.getZoom();
                var p0 = map.project(latlng, zoom);
                var p1 = map.project(L.latLng(latlng.lat, latlng.lng + lngDelta), zoom);
                var px = Math.abs(p1.x - p0.x);
                if (px > 0) return px;
                var mPerPx = (156543.03392 * Math.max(Math.abs(cos), 0.2)) / Math.pow(2, zoom);
                return meters / mPerPx;
            }

            // Keep custom canvases locked to tiles during every kind of zoom.
            // - zoomanim: button / double-tap / wheel animated zoom
            // - zoom with pinch:true: touch pinch gesture (PWA standalone)
            // _scheduleRedraw is deliberately NOT called during pinch or
            // _animatingZoom; it runs only on settled view (moveend/zoomend).
            map.on('zoomanim', function (e) {
                if (e && e.center != null && e.zoom != null) _updateCanvasTransform(e.center, e.zoom);
            });
            map.on('zoom', function (e) {
                if (e && e.pinch) {
                    _updateCanvasTransform(map.getCenter(), map.getZoom());
                }
            });
            map.on('move viewreset resize', _scheduleRedraw);
            map.on('moveend zoomend', _scheduleRedraw);

            function unproject3857(x, y) {
                return L.CRS.EPSG3857.unproject(L.point(x, y));
            }

            function dedupePoints(pts) {
                var seen = {};
                return pts.filter(function (p) {
                    var k = p.lat.toFixed(4) + ',' + p.lng.toFixed(4);
                    if (seen[k]) return false;
                    seen[k] = true; return true;
                });
            }

            // ── 600m RADIUS CIRCLES via ArcGIS REST (JSONP — bypasses CORS) ──
            var _REST_BASE = 'https://eism.geo-spatial.ro/eismgeo/rest/services/Patrimoniu/PatrimoniuWM/MapServer';
            var _REST_LAYERS = [0, 5, 6];
            var _jsonpCounter = 0;

            var _oidStore = {};   // layerId:OID → true, permanent across pan/zoom
            var _fetchedBounds = null;
            var _fetchActive = false;

            function jsonpFetch(url, cb) {
                var cbName = '__dlJsonp' + (++_jsonpCounter);
                var script;
                window[cbName] = function (data) {
                    try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
                    if (script && script.parentNode) script.parentNode.removeChild(script);
                    cb(data);
                };
                script = document.createElement('script');
                script.src = url + '&callback=' + cbName;
                script.onerror = function () {
                    console.error('[RADIUS] JSONP script load failed for layer, url:', url);
                    try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
                    if (script.parentNode) script.parentNode.removeChild(script);
                    cb(null);
                };
                document.head.appendChild(script);
            }

            // Extract geometry into a list of {type:'circle', latlng, radius} shapes.
            // For polygons and polylines we place 600m circles at regular intervals along
            // every edge — spacing MAX_STEP_M apart — so even a triangle with 3 vertices
            // gets a fully continuous buffer with no gaps between corner circles.
            var MAX_STEP_M = 500; // interpolate a circle every 500m along each edge (600m radius = slight overlap)

            function _latlngDistM(a, b) {
                var R = 6371000;
                var dLat = (b.lat - a.lat) * Math.PI / 180;
                var dLng = (b.lng - a.lng) * Math.PI / 180;
                var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
                return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
            }

            // Interpolate n evenly-spaced points between [lng,lat] A and B (not including B)
            function _interpEdge(a, b, n) {
                var pts = [];
                for (var i = 0; i < n; i++) {
                    var t = i / n;
                    pts.push(L.latLng(a[1] + t * (b[1] - a[1]), a[0] + t * (b[0] - a[0])));
                }
                return pts;
            }

            function _coordsToCircles(coords) {
                // coords: array of [lng, lat]
                // Walk each edge, placing a circle every MAX_STEP_M metres.
                var shapes = [];
                var seen = {};
                function addPt(ll) {
                    // dedupe to ~50m grid to avoid massive arrays on dense geometries
                    var k = Math.round(ll.lat * 200) + ',' + Math.round(ll.lng * 200); // ~111000/200 ≈ 555m grid cells
                    if (seen[k]) return;
                    seen[k] = true;
                    shapes.push({ type: 'circle', latlng: ll, radius: 600 });
                }
                for (var i = 0; i < coords.length - 1; i++) {
                    var a = coords[i], b = coords[i + 1];
                    var distM = _latlngDistM(L.latLng(a[1], a[0]), L.latLng(b[1], b[0]));
                    var steps = Math.max(1, Math.ceil(distM / MAX_STEP_M));
                    var pts = _interpEdge(a, b, steps);
                    for (var j = 0; j < pts.length; j++) addPt(pts[j]);
                }
                // add the last vertex
                if (coords.length > 0) {
                    var last = coords[coords.length - 1];
                    addPt(L.latLng(last[1], last[0]));
                }
                return shapes;
            }

            function _geomToShapes(geom, gType) {
                if (!geom) return null;
                var shapes = [];
                if (gType === 'esriGeometryPoint') {
                    if (!isNaN(geom.x) && !isNaN(geom.y))
                        shapes.push({ type: 'circle', latlng: L.latLng(geom.y, geom.x), radius: 600 });
                } else if (gType === 'esriGeometryPolygon' && geom.rings) {
                    geom.rings.forEach(function (ring) {
                        _coordsToCircles(ring).forEach(function (s) { shapes.push(s); });
                    });
                } else if (gType === 'esriGeometryPolyline' && geom.paths) {
                    geom.paths.forEach(function (path) {
                        _coordsToCircles(path).forEach(function (s) { shapes.push(s); });
                    });
                }
                return shapes.length ? shapes : null;
            }
            // Adaugă imaginea PNG centrată pe coordonatele unui punct

            function _addHeritageImage(latlng, key) {
                // Kept as a compatibility hook for the radius loader, but do
                // not create one 40 px image marker per site.  The single
                // canvas above now paints both individual pins and clusters;
                // thousands of image DOM nodes were the biggest avoidable
                // source of jank on mobile.
                return null;
            }

            // Build a GFI URL for a specific pixel (px, py) within a virtual WxH canvas over bounds
            function _queryLayer(layerId, fetchBounds, cb) {
                var sw = L.CRS.EPSG3857.project(fetchBounds.getSouthWest());
                var ne = L.CRS.EPSG3857.project(fetchBounds.getNorthEast());
                var url = _REST_BASE + '/' + layerId + '/query'
                    + '?where=1%3D1'
                    + '&geometry=' + encodeURIComponent(sw.x + ',' + sw.y + ',' + ne.x + ',' + ne.y)
                    + '&geometryType=esriGeometryEnvelope'
                    + '&inSR=102100&spatialRel=esriSpatialRelIntersects'
                    + '&outFields=OBJECTID&returnGeometry=true&outSR=4326'
                    + '&resultRecordCount=2000&f=json';
                console.log('[RADIUS] querying layer', layerId, 'url:', url);
                jsonpFetch(url, cb);
            }

            // Radiuses are not painted below z6: at country scale a 600 m
            // circle is sub-pixel and only adds work.  From z6 to z10 the
            // same physical thresholds as the pins are used; z11+ is exact.
            var MIN_ZOOM = PATRIMONIU_CLUSTER_CONFIG.minZoom || 6;
            var RADIUS_DETAIL_ZOOM = PATRIMONIU_CLUSTER_CONFIG.disableClusteringAtZoom || 11;

            var _redrawTimer = null;
            function _scheduleRedraw() {
                // During any zoom animation (button zoom, double-tap, or
                // pinch) the map's _pixelOrigin already sits at the target
                // zoom while tiles are mid-scale.  Redrawing now would jump
                // circles/pins to their final pixels and make them slide
                // relative to tiles — exactly the PWA glitch.  Let
                // _updateCanvasTransform() scale the last frame instead.
                // This also prevents the expensive redraw from running on
                // every pinch move in PWA standalone, where touchZoom drives
                // zoom via continuous 'zoom' events with pinch:true.
                if (map && (map._animatingZoom || (map.touchZoom && map.touchZoom._zooming))) return;
                if (_redrawTimer) return;
                _redrawTimer = requestAnimationFrame(function () {
                    _redrawTimer = null;
                    // Re-check animating flag inside the frame: a zoom may
                    // have started between scheduling and execution.
                    if (map && (map._animatingZoom || (map.touchZoom && map.touchZoom._zooming))) return;
                    _redrawAll();
                });
            }
            window._scheduleRedraw = _scheduleRedraw;
            window._setFlatOpacity = function (v) { FLAT_OPACITY = v; };
            window._loadSiteCircles = loadSiteCircles;
            window._setCirclesVisible = function (v) { _circlesVisible = v; };
            window._resetFetchedBounds = function () { _fetchedBounds = null; };
            window.clearAllSiteCircles = clearAllSiteCircles;
            window._getDisplayCanvas = function () { return _displayCanvas; };

            function clearAllSiteCircles() {
                _oidStore = {};
                _circleStore = {};
                if (_radiusShapeIndex) _radiusShapeIndex.clear();
                _fetchedBounds = null;
                _radiusDetailMode = null;
                window._circleStore = _circleStore;
                _offscreenCtx.clearRect(0, 0, _offscreenCanvas.width, _offscreenCanvas.height);
                _displayCtx.clearRect(0, 0, _displayCanvas.width, _displayCanvas.height);
                _hideLoader();
            }

            // ── LOADER HELPERS ──
            var _loaderEl = null;
            function _getLoader() {
                if (!_loaderEl) _loaderEl = document.getElementById('mapRadiusLoader');
                return _loaderEl;
            }
            function _showLoader() { var el = _getLoader(); if (el) el.classList.add('visible'); }
            function _hideLoader() { var el = _getLoader(); if (el) el.classList.remove('visible'); }

            function _needsFetch(viewBounds) {
                if (!_fetchedBounds) return true;
                // Only fetch if the viewport has moved outside already-fetched area
                return (
                    viewBounds.getSouth() < _fetchedBounds.getSouth() ||
                    viewBounds.getNorth() > _fetchedBounds.getNorth() ||
                    viewBounds.getWest() < _fetchedBounds.getWest() ||
                    viewBounds.getEast() > _fetchedBounds.getEast()
                );
            }

            function _geoJsonToShapes(geometry, detailed) {
                if (!geometry) return null;
                if (geometry.type === 'Point') {
                    var c = geometry.coordinates;
                    if (!c || !isFinite(c[0]) || !isFinite(c[1])) return null;
                    return [{ type: 'circle', latlng: L.latLng(c[1], c[0]), radius: 600 }];
                }

                // At z6–z10 the boundary itself is not discernible.  One
                // representative 600 m footprint is enough for the grouped
                // preview and avoids interpolating every polygon edge.  Once
                // z11 is reached we restore the detailed perimeter circles.
                if (!detailed) {
                    var representative = _representativePoint(geometry);
                    return representative
                        ? [{ type: 'circle', latlng: representative, radius: 600 }]
                        : null;
                }

                var shapes = [];
                if (geometry.type === 'Polygon') {
                    geometry.coordinates.forEach(function (ring) {
                        _coordsToCircles(ring).forEach(function (s) { shapes.push(s); });
                    });
                } else if (geometry.type === 'MultiPolygon') {
                    geometry.coordinates.forEach(function (polygon) {
                        polygon.forEach(function (ring) {
                            _coordsToCircles(ring).forEach(function (s) { shapes.push(s); });
                        });
                    });
                }
                return shapes.length ? shapes : null;
            }

            function _representativePoint(geometry) {
                if (!geometry) return null;
                if (geometry.type === 'Point' && geometry.coordinates) {
                    return L.latLng(geometry.coordinates[1], geometry.coordinates[0]);
                }
                var ring = null;
                if (geometry.type === 'Polygon' && geometry.coordinates && geometry.coordinates[0]) {
                    ring = geometry.coordinates[0];
                } else if (geometry.type === 'MultiPolygon' && geometry.coordinates &&
                    geometry.coordinates[0] && geometry.coordinates[0][0]) {
                    ring = geometry.coordinates[0][0];
                } else if (geometry.type === 'LineString' && geometry.coordinates) {
                    ring = geometry.coordinates;
                }
                if (ring && ring.length) {
                    var lat = 0, lng = 0, count = 0;
                    for (var i = 0; i < ring.length; i++) {
                        if (!ring[i] || !isFinite(ring[i][0]) || !isFinite(ring[i][1])) continue;
                        lng += ring[i][0]; lat += ring[i][1]; count++;
                    }
                    if (count) return L.latLng(lat / count, lng / count);
                }
                return null;
            }

            // Draws 600m radius circles + heritage images for whatever is in view,
            // reading from our already-loaded local dataset (window._localLayerData)
            // instead of live-querying the government server on every pan/zoom.
            // Same viewport-padding + OBJECTID-dedup caching as before, just backed
            // by an in-memory filter instead of a network request.
            function loadSiteCircles() {
                if (!_circlesVisible) return;
                var zoom = map.getZoom();
                if (zoom < MIN_ZOOM) {
                    _displayCtx.clearRect(0, 0, _displayCanvas.width, _displayCanvas.height);
                    return;
                }

                // Rebuild the small radius representation when crossing z11.
                // Low zooms use one representative point per feature; detailed
                // polygon perimeter circles are generated only when they can be
                // seen.  This prevents a zoom-in from inheriting a country-wide
                // collection of thousands of edge samples.
                var detailed = zoom >= RADIUS_DETAIL_ZOOM;
                if (_radiusDetailMode !== null && _radiusDetailMode !== detailed) {
                    _oidStore = {};
                    _circleStore = {};
                    if (_radiusShapeIndex) _radiusShapeIndex.clear();
                    window._circleStore = _circleStore;
                    _fetchedBounds = null;
                }
                _radiusDetailMode = detailed;

                var viewBounds = map.getBounds();
                if (!_needsFetch(viewBounds)) {
                    _scheduleRedraw();
                    return;
                }

                var latSpan = viewBounds.getNorth() - viewBounds.getSouth();
                var lngSpan = viewBounds.getEast() - viewBounds.getWest();
                var fetchBounds = L.latLngBounds(
                    [viewBounds.getSouth() - latSpan * 0.3, viewBounds.getWest() - lngSpan * 0.3],
                    [viewBounds.getNorth() + latSpan * 0.3, viewBounds.getEast() + lngSpan * 0.3]
                );
                _fetchedBounds = _fetchedBounds ? _fetchedBounds.extend(fetchBounds) : fetchBounds;

                [0, 5, 6].forEach(function (lid) {
                    var fc = window._localLayerData[lid];
                    if (!fc || !Array.isArray(fc.features)) return;

                    fc.features.forEach(function (f) {
                        if (!f.geometry) return;
                        var rep = _representativePoint(f.geometry);
                        if (!rep || !fetchBounds.contains(rep)) return;

                        var oid = f.id;
                        if (oid == null) return;
                        var key = lid + ':' + oid;
                        if (_oidStore[key]) return;

                        var shapes = _geoJsonToShapes(f.geometry, detailed);
                        if (!shapes) return;
                        _oidStore[key] = true;
                        _storeRadiusShapes('r:' + key, shapes);
                    });
                });

                _scheduleRedraw();
            }

            var _fetchDebounce = null;
            map.on('moveend zoomend', function () {
                _updatePatrimoniuPolygons();
                clearTimeout(_fetchDebounce);
                _fetchDebounce = setTimeout(loadSiteCircles, 250);
            });
            // Don't call loadSiteCircles() on init — circles are off by default

            // Build GFI URL for a specific single layer
            function buildGfiUrl(e, infoFormat, layerId) {
                var size = map.getSize();
                var bounds = map.getBounds();
                var sw = L.CRS.EPSG3857.project(bounds.getSouthWest());
                var ne = L.CRS.EPSG3857.project(bounds.getNorthEast());
                var pt = map.latLngToContainerPoint(e.latlng);
                var layerParam = encodeURIComponent(String(layerId));
                return _WMS
                    + '?SERVICE=WMS&REQUEST=GetFeatureInfo&VERSION=1.1.1'
                    + '&LAYERS=' + layerParam + '&QUERY_LAYERS=' + layerParam + '&STYLES='
                    + '&BBOX=' + sw.x + ',' + sw.y + ',' + ne.x + ',' + ne.y
                    + '&WIDTH=' + size.x + '&HEIGHT=' + size.y
                    + '&SRS=EPSG%3A3857'
                    + '&X=' + Math.round(pt.x) + '&Y=' + Math.round(pt.y)
                    + '&INFO_FORMAT=' + encodeURIComponent(infoFormat)
                    + '&FEATURE_COUNT=1';
            }

            // Parse props from ArcGIS HTML response — first feature's data table only.
            // FEATURE_COUNT may return multiple overlapping sites in separate tables.
            // We pick the first table that has <th> header cells (skipping layout wrappers).
            function parseHtmlProps(raw) {
                var props = {};
                try {
                    var dp = new DOMParser().parseFromString(raw, 'text/html');
                    // Find the first table that has <th> cells — that's a data table
                    var tables = dp.querySelectorAll('table');
                    var dataTable = null;
                    for (var t = 0; t < tables.length; t++) {
                        if (tables[t].querySelector('th')) { dataTable = tables[t]; break; }
                    }
                    // Fallback: just use the first table if none have <th>
                    if (!dataTable) dataTable = tables[0] || null;

                    var rows = dataTable ? dataTable.querySelectorAll('tr') : [];
                    rows.forEach(function (row) {
                        var th = row.querySelector('th');
                        var td = row.querySelector('td');
                        if (th && td) {
                            var key = th.textContent.trim();
                            var val = td.textContent.trim();
                            if (key && val && val.toLowerCase() !== 'null') props[key] = val;
                        }
                    });
                    if (Object.keys(props).length === 0) {
                        // Fallback: key/value pairs in consecutive <td> cells
                        var tds = dataTable ? dataTable.querySelectorAll('td') : dp.querySelectorAll('td');
                        for (var i = 0; i + 1 < tds.length; i += 2) {
                            var k = tds[i].textContent.trim();
                            var v = tds[i + 1].textContent.trim();
                            if (k && v && v.toLowerCase() !== 'null') props[k] = v;
                        }
                    }
                } catch (ex) { console.warn('[GFI] HTML parse exception:', ex); }
                return props;
            }

            // Extract ALL coordinate pairs from a GML response.
            // Handles <gml:coordinates>, <gml:pos>, <gml:posList> in EPSG:4326 or EPSG:3857.
            function parseGmlCoords(raw) {
                var points = []; // array of {lat, lng}
                try {
                    var xmlDoc = new DOMParser().parseFromString(raw, 'text/xml');
                    if (xmlDoc.querySelector('parsererror')) return points;

                    // Helper: parse "x,y x,y" or "x y x y" strings into lat/lng pairs
                    // ArcGIS WMS 1.1.1 returns CRS EPSG:4326 with coords as "lon,lat" in <gml:coordinates>
                    // or "lat lon" pairs in <gml:pos>/<gml:posList>
                    function coordsFromString(str, separator, isLatLonOrder) {
                        var pairs = str.trim().split(/\s+/);
                        if (separator === ',') {
                            // "lon,lat lon,lat" format (gml:coordinates)
                            pairs.forEach(function (pair) {
                                var parts = pair.split(',');
                                if (parts.length >= 2) {
                                    var x = parseFloat(parts[0]);
                                    var y = parseFloat(parts[1]);
                                    if (!isNaN(x) && !isNaN(y)) {
                                        // Determine if these are EPSG:3857 (metres) or 4326 (degrees)
                                        if (Math.abs(x) > 180 || Math.abs(y) > 90) {
                                            // Project from EPSG:3857 to LatLng
                                            var ll = L.CRS.EPSG3857.unproject(L.point(x, y));
                                            points.push({ lat: ll.lat, lng: ll.lng });
                                        } else {
                                            points.push({ lat: y, lng: x }); // lon,lat → lat,lng
                                        }
                                    }
                                }
                            });
                        } else {
                            // "lat lon lat lon" format (gml:pos / gml:posList)
                            for (var i = 0; i + 1 < pairs.length; i += 2) {
                                var a = parseFloat(pairs[i]);
                                var b = parseFloat(pairs[i + 1]);
                                if (!isNaN(a) && !isNaN(b)) {
                                    if (Math.abs(a) > 180 || Math.abs(b) > 90) {
                                        var ll2 = L.CRS.EPSG3857.unproject(L.point(a, b));
                                        points.push({ lat: ll2.lat, lng: ll2.lng });
                                    } else {
                                        // GML 3 posList for EPSG:4326 is "lat lon" order
                                        points.push({ lat: a, lng: b });
                                    }
                                }
                            }
                        }
                    }

                    // <gml:coordinates> — GML 2 style, used by ArcGIS WMS 1.1.1
                    var coordEls = xmlDoc.getElementsByTagNameNS('http://www.opengis.net/gml', 'coordinates');
                    if (coordEls.length === 0) coordEls = xmlDoc.getElementsByTagName('gml:coordinates');
                    if (coordEls.length === 0) coordEls = xmlDoc.getElementsByTagName('coordinates');
                    for (var i = 0; i < coordEls.length; i++) {
                        coordsFromString(coordEls[i].textContent, ',', false);
                    }

                    // <gml:pos> — GML 3 single point
                    if (points.length === 0) {
                        var posEls = xmlDoc.getElementsByTagNameNS('http://www.opengis.net/gml', 'pos');
                        if (posEls.length === 0) posEls = xmlDoc.getElementsByTagName('gml:pos');
                        if (posEls.length === 0) posEls = xmlDoc.getElementsByTagName('pos');
                        for (var j = 0; j < posEls.length; j++) {
                            coordsFromString(posEls[j].textContent, ' ', true);
                        }
                    }

                    // <gml:posList> — GML 3 polygon/linestring
                    if (points.length === 0) {
                        var plEls = xmlDoc.getElementsByTagNameNS('http://www.opengis.net/gml', 'posList');
                        if (plEls.length === 0) plEls = xmlDoc.getElementsByTagName('gml:posList');
                        if (plEls.length === 0) plEls = xmlDoc.getElementsByTagName('posList');
                        for (var k = 0; k < plEls.length; k++) {
                            coordsFromString(plEls[k].textContent, ' ', true);
                        }
                    }
                } catch (ex) { console.warn('[GFI] GML coord parse error:', ex); }
                return points;
            }

            // Case-insensitive pick from props
            function pickProp(props, candidates) {
                for (var i = 0; i < candidates.length; i++) {
                    if (props[candidates[i]]) return props[candidates[i]];
                }
                var lower = candidates.map(function (c) { return c.toLowerCase(); });
                for (var key in props) {
                    if (lower.indexOf(key.toLowerCase()) !== -1 && props[key]) return props[key];
                }
                return null;
            }

            // Show popup from a props object
            // Render and open the heritage popup. Called directly when we have all data,
            // or after an async REST enrichment call fills in the name.
            function _openHeritagePopup(ran, name, latlng) {
                L.popup({ className: 'patrimoniu-popup', maxWidth: 320 })
                    .setLatLng(latlng)
                    .setContent(_buildHeritagePopupContent(ran, name))
                    .openOn(map);
            }

            // Fetch the full site record from the ArcGIS REST service using a small
            // bounding-box query (same proven approach as the radius circle loader).
            // This returns the full COD_RAN (e.g. "54984.77") and DENUMIRE.
            // Cascades through REST_LAYERS until a feature matching the RAN hint is found.
            function _enrichAndPopup(ranHint, hitLayerId, latlng) {
                var layersToTry = [hitLayerId].concat(
                    _REST_LAYERS.filter(function (l) { return l !== hitLayerId; })
                );
                var intHint = ranHint ? String(ranHint).split('.')[0] : null;

                // Build a ~150m bbox around the click in EPSG:3857 (same as working radius query)
                function buildEnrichUrl(lid) {
                    var pt3857 = L.CRS.EPSG3857.project(latlng);
                    var d = 150; // metres in 3857 units ≈ metres at mid-latitudes
                    var bbox = (pt3857.x - d) + ',' + (pt3857.y - d) + ',' +
                        (pt3857.x + d) + ',' + (pt3857.y + d);
                    return _REST_BASE + '/' + lid + '/query'
                        + '?where=1%3D1'
                        + '&geometry=' + encodeURIComponent(bbox)
                        + '&geometryType=esriGeometryEnvelope'
                        + '&inSR=102100'
                        + '&spatialRel=esriSpatialRelIntersects'
                        + '&outFields=*'
                        + '&returnGeometry=false'
                        + '&resultRecordCount=10'
                        + '&f=json';
                }

                function tryRestLayer(idx) {
                    if (idx >= layersToTry.length) {
                        console.warn('[DetectLab] Enrichment: no match in any layer for RAN hint', ranHint);
                        _openHeritagePopup(ranHint, null, latlng);
                        return;
                    }
                    var lid = layersToTry[idx];
                    var url = buildEnrichUrl(lid);
                    console.log('[DetectLab] Enrichment layer', lid, 'url:', url);

                    jsonpFetch(url, function (data) {
                        // Always log the raw response so we can see field names in the console
                        console.log('[DetectLab] Enrichment layer', lid, 'raw response:',
                            JSON.stringify(data).slice(0, 1200));

                        if (!data || !data.features || data.features.length === 0) {
                            console.log('[DetectLab] Enrichment layer', lid, 'no features → next');
                            tryRestLayer(idx + 1);
                            return;
                        }

                        // Pick the best feature: prefer one whose RAN integer prefix matches hint
                        var best = null;
                        var bestRan = null;
                        for (var i = 0; i < data.features.length; i++) {
                            var a = data.features[i].attributes || {};
                            // Scan ALL fields for anything that looks like a RAN code
                            var candidateRan = null;
                            for (var fld in a) {
                                if (!a[fld]) continue;
                                var v = String(a[fld]);
                                if (/^\d{4,6}\.\d{2,3}$/.test(v) || (intHint && v === intHint)) {
                                    candidateRan = v; break;
                                }
                            }
                            var matches = intHint && candidateRan && candidateRan.split('.')[0] === intHint;
                            if (!best || matches) {
                                best = a; bestRan = candidateRan;
                                if (matches) break;
                            }
                        }

                        if (!best) { tryRestLayer(idx + 1); return; }

                        // Log all field names so we know what to look for
                        console.log('[DetectLab] Enrichment best feature fields:', JSON.stringify(best));

                        // Extract name — try every plausible field name
                        var name = null;
                        var nameFields = ['DENUMIRE', 'DENUMIRE_SIT', 'DENUMIRE_OBIECTIV', 'DENUMIRE_OB',
                            'DenumireSit', 'Denumire', 'denumire', 'NUME', 'NAME', 'TITLU', 'DESCRIPTION'];
                        for (var ni = 0; ni < nameFields.length; ni++) {
                            if (best[nameFields[ni]]) { name = String(best[nameFields[ni]]); break; }
                        }
                        // Also scan all fields: any long string (>10 chars) that isn't a date/code
                        if (!name) {
                            for (var fld2 in best) {
                                var v2 = best[fld2];
                                if (!v2 || typeof v2 !== 'string') continue;
                                if (v2.length > 10 && !/^\d/.test(v2) && !/\d{1,2}\/\d{1,2}\/\d{4}/.test(v2)) {
                                    name = v2; break;
                                }
                            }
                        }

                        // Extract full RAN — try known field names
                        var fullRan = bestRan || ranHint;
                        var ranFields = ['COD_RAN', 'NR_RAN', 'CodRAN', 'Cod_RAN', 'RAN', 'COD', 'Cod'];
                        if (!bestRan) {
                            for (var ri = 0; ri < ranFields.length; ri++) {
                                if (best[ranFields[ri]]) { fullRan = String(best[ranFields[ri]]); break; }
                            }
                        }

                        console.log('[DetectLab] Enrichment result → ran:', fullRan, '| name:', name);
                        _openHeritagePopup(fullRan, name, latlng);
                    });
                }

                tryRestLayer(0);
            }

            function showPatrimoniuPopup(props, coordPoints, latlng, hitLayerId) {
                console.log('[DetectLab] Props:', JSON.stringify(props), '| Coords:', coordPoints.length);
                if (Object.keys(props).length === 0) return;

                var ran = null;
                var name = null;

                // RAN codes come in two flavours from the WMS:
                //   • Full:    "54984.77"  (digits dot digits)
                //   • Integer: "54984"     (digits only, 4-6 chars) — Layer 0 Point features
                var ranPatternFull = /^\d{4,6}\.\d{2,3}$/;
                var ranPatternInt = /^\d{4,6}$/;
                // SIRUTA locality codes look the same as integer RANs; a SIRUTA key is
                // typically a short pure-number string (2-4 digits) — used to distinguish
                // "this 4-6 digit value is the RAN, not the key" below.
                var sirutaKeyPattern = /^\d{2,4}$/;
                var skipKeys = /^(point|administrator|objectid|fid|shape|globalid|created_|last_edit)$/i;
                var datePattern = /\d{1,2}\/\d{1,2}\/\d{4}/;
                var epochPattern = /^(eneolitic|neolitic|paleolitic|bronzului|fierului|medievala?|romana?|preistorie|migratiil|hallstatt|latene|epoca|secol|secolul)/i;

                // Pass 1: scan keys AND values for RAN patterns.
                // The WMS sometimes places the RAN code in the <th> (key) with the geometry
                // type ("Point") as the <td> (value), so we must check both directions.
                Object.keys(props).forEach(function (k) {
                    var v = props[k];
                    // Full RAN in key or value
                    if (ranPatternFull.test(k)) {
                        ran = k;
                    } else if (ranPatternFull.test(v)) {
                        ran = v;
                        // Integer RAN in value where the key looks like a SIRUTA code or short number
                    } else if (!ran && ranPatternInt.test(v) && sirutaKeyPattern.test(k)) {
                        ran = v;  // e.g. key="2466", value="54984" → RAN is the value
                        // Integer RAN in key where the value is clearly not a RAN (e.g. geometry type)
                    } else if (!ran && ranPatternInt.test(k) && !ranPatternInt.test(v) && !ranPatternFull.test(v)) {
                        ran = k;
                    }
                });

                // Pass 2: look for name by explicit key candidates (most reliable)
                name = pickProp(props, [
                    'DENUMIRE', 'DENUMIRE_SIT', 'DENUMIRE_OBIECTIV', 'DENUMIRE_OB',
                    'NUME', 'NUME_OBIECTIV', 'NAME', 'TITLU',
                    'Denumire', 'denumire', 'DenumireSit', 'denumire_sit',
                    'DESCRIPTION', 'DESCRIERE', 'LOCALITATE', 'Localitate'
                ]);

                // Pass 3: look for RAN by explicit key candidates if not found yet
                if (!ran) ran = pickProp(props, [
                    'COD_RAN', 'CODRAN', 'CodRAN', 'NR_RAN', 'RAN', 'Cod_RAN', 'ran',
                    'COD', 'Cod', 'CODE'
                ]);

                // Pass 4: last-resort name — scan values but with strict guards
                if (!name) {
                    Object.keys(props).forEach(function (k) {
                        if (name) return;
                        if (skipKeys.test(k)) return;
                        var v = props[k];
                        if (!v || v === ran) return;
                        if (ranPatternFull.test(v) || ranPatternInt.test(v)) return;
                        if (datePattern.test(v)) return;
                        if (/^\d+$/.test(v)) return;
                        if (epochPattern.test(v)) return;
                        if (v.length <= 4) return;
                        name = v;
                    });
                }

                if (!ran && !name) {
                    console.warn('[DetectLab] No RAN/name. Props:', JSON.stringify(props));
                    return;
                }

                console.log('[DetectLab] Resolved → ran:', ran, 'name:', name);

                // If we have a RAN but no name, try to enrich from the REST API asynchronously.
                // hitLayerId tells us which layer actually returned the feature.
                if (ran && !name && hitLayerId != null) {
                    _enrichAndPopup(ran, hitLayerId, latlng);
                } else {
                    _openHeritagePopup(ran, name, latlng);
                }
            }

            map.on('click', function (e) {
                return; // superseded: heritage clicks are dispatched by the HERITAGE FEATURE HIT TEST above
                var ox = e.originalEvent.clientX - _mdX;
                var oy = e.originalEvent.clientY - _mdY;
                if (Math.sqrt(ox * ox + oy * oy) > 5) return; // drag

                if (!map.hasLayer(window._patrimoniuLayer)) return;

                var latlng = e.latlng;

                // Query each layer individually (FEATURE_COUNT=1 each) so their field
                // schemas never mix. Use the first layer that returns a real feature.
                var LAYERS = [0, 5, 6];

                function queryLayer(layerId) {
                    return Promise.all([
                        fetch(buildGfiUrl(e, 'text/html', layerId)).then(function (r) { return r.text(); }).catch(function () { return ''; }),
                        fetch(buildGfiUrl(e, 'application/vnd.ogc.gml', layerId)).then(function (r) { return r.text(); }).catch(function () { return ''; })
                    ]).then(function (res) {
                        return { html: res[0], gml: res[1] };
                    });
                }

                // Query all layers in parallel and merge — Layer 0 gives the Point with
                // integer RAN; Layer 5/6 give overlapping Polygons with full decimal
                // RAN + DENUMIRE. We merge only the polygon whose integer prefix matches
                // the point's RAN, so nearby sites don't contaminate each other.
                // Polygon results that arrive before Layer 0 are queued and processed once
                // Layer 0 resolves, so the RAN hint is always available for comparison.
                var layer0Props = null;  // null = not yet resolved
                var layer0Coords = [];
                var polygonQueue = [];    // polygon results waiting for layer 0
                var extraProps = {};
                var extraCoords = [];
                var pending = LAYERS.length;
                var _rfFull = /^\d{4,6}\.\d{2,3}$/;
                var _rfInt = /^\d{4,6}$/;

                function extractRanFromProps(p) {
                    for (var k in p) {
                        if (_rfFull.test(k)) return k;
                        if (_rfFull.test(p[k])) return p[k];
                    }
                    for (var k2 in p) {
                        if (_rfInt.test(k2)) return k2;
                        if (_rfInt.test(p[k2])) return p[k2];
                    }
                    return null;
                }

                function tryMergePolygon(p, c) {
                    if (Object.keys(p).length === 0) return;
                    var pointRanInt = extractRanFromProps(layer0Props || {});
                    if (pointRanInt) pointRanInt = String(pointRanInt).split('.')[0];
                    var polygonRan = extractRanFromProps(p);
                    var polygonInt = polygonRan ? String(polygonRan).split('.')[0] : null;
                    var isMatch = pointRanInt && polygonInt && polygonInt === pointRanInt;
                    var noHint = !pointRanInt;
                    if (isMatch || noHint) {
                        console.log('[DetectLab] Polygon RAN', polygonRan, 'matches hint', pointRanInt, '→ merging');
                        Object.assign(extraProps, p);
                        if (c.length > extraCoords.length) extraCoords = c;
                    } else {
                        console.log('[DetectLab] Polygon RAN', polygonRan, '≠ hint', pointRanInt, '→ SKIP (different site)');
                    }
                }

                function finalMerge() {
                    var allProps = Object.assign({}, layer0Props || {}, extraProps);
                    var allCoords = extraCoords.length > 0 ? extraCoords : layer0Coords;
                    if (Object.keys(allProps).length === 0 && allCoords.length === 0) return;

                    if (_circlesVisible) {
                        var clickKey = 'click:' + latlng.lat.toFixed(4) + ',' + latlng.lng.toFixed(4);
                        if (!_circleStore[clickKey]) {
                            var cs;
                            if (allCoords.length > 1) {
                                cs = _coordsToCircles(allCoords.map(function (pt) { return [pt.lng, pt.lat]; }));
                            } else if (allCoords.length === 1) {
                                cs = [{ type: 'circle', latlng: L.latLng(allCoords[0].lat, allCoords[0].lng), radius: 600 }];
                            } else {
                                cs = [{ type: 'circle', latlng: latlng, radius: 600 }];
                            }
                            _storeRadiusShapes(clickKey, cs);
                            _scheduleRedraw();
                        }
                    }

                    console.log('[DetectLab] Final merged props:', JSON.stringify(allProps));
                    showPatrimoniuPopup(allProps, allCoords, latlng, LAYERS[0]);
                }

                LAYERS.forEach(function (lid) {
                    queryLayer(lid).then(function (res) {
                        var p = parseHtmlProps(res.html);
                        var c = parseGmlCoords(res.gml);
                        if (c.length === 0 && res.gml.trim().startsWith('<')) c = parseGmlCoords(res.html);

                        console.log('[DetectLab] Layer', lid, 'props:', JSON.stringify(p));
                        console.log('[DetectLab] Layer', lid, 'raw HTML:', res.html.slice(0, 1200));

                        if (lid === 0) {
                            layer0Props = p;
                            layer0Coords = c;
                            // Process any polygon results that arrived before us
                            polygonQueue.forEach(function (q) { tryMergePolygon(q.p, q.c); });
                            polygonQueue = [];
                        } else {
                            if (layer0Props === null) {
                                polygonQueue.push({ p: p, c: c }); // queue until layer 0 resolves
                            } else {
                                tryMergePolygon(p, c);
                            }
                        }

                        pending--;
                        if (pending === 0) finalMerge();
                    });
                });
            });

            // ── HERITAGE → 3D BRIDGE ──
            // Heritage points and their 600 m radii are NOT Leaflet layers:
            // they are painted on the raw map-pane canvases above (_sitesCanvas
            // for pins, _displayCanvas for radii) for performance. The 3D
            // mirror walks Leaflet layers, so those two surfaces were
            // invisible to it — only the lazy L.GeoJSON polygons (z11+) ever
            // appeared in 3D. This invisible Leaflet layer offers the same
            // records to the mirror (js/map3d-mirror.js: `_dl3dFeatures`) as
            // per-feature GeoJSON: coloured points + geodesic 600 m circles.
            // It adds no DOM and draws nothing in 2D; polygons stay out of it
            // because they already mirror as real GeoJSON layers.
            var _heritage3dCache = { stamp: '', geojson: null };
            function _heritageCirclePolygon(latlng, radiusM) {
                var coords = [];
                var latRad = latlng.lat * Math.PI / 180;
                var dLat = radiusM / 111320;
                var dLng = radiusM / (111320 * Math.max(Math.abs(Math.cos(latRad)), 0.2));
                for (var i = 0; i < 24; i++) {
                    var a = (i / 24) * Math.PI * 2;
                    coords.push([latlng.lng + Math.sin(a) * dLng, latlng.lat + Math.cos(a) * dLat]);
                }
                coords.push(coords[0].slice());
                return coords;
            }
            function _heritage3dFeatures() {
                if (!_heritageDataReady) return { geojson: { type: 'FeatureCollection', features: [] }, stamp: 'nodata' };
                var shapeCount = 0;
                Object.keys(_circleStore).forEach(function (k) { shapeCount += (_circleStore[k] || []).length; });
                var stamp = [_heritagePointRecords.length, shapeCount, _circlesVisible ? 1 : 0,
                    Math.round(FLAT_OPACITY * 100)].join('|');
                if (_heritage3dCache.stamp === stamp && _heritage3dCache.geojson) {
                    return { geojson: _heritage3dCache.geojson, stamp: stamp, label: 'Patrimoniu (heritage)' };
                }
                var features = [];
                if (_circlesVisible) {
                    var seenRadius = {};
                    Object.keys(_circleStore).forEach(function (k) {
                        (_circleStore[k] || []).forEach(function (shape) {
                            if (!shape || shape.type !== 'circle' || !shape.latlng || features.length > 40000) return;
                            var radius = shape.radius || 600;
                            var key = shape.latlng.lat.toFixed(5) + ',' + shape.latlng.lng.toFixed(5) + ',' + radius;
                            if (seenRadius[key]) return;
                            seenRadius[key] = true;
                            features.push({
                                type: 'Feature',
                                properties: { color: '#C42B2B', fillColor: '#C42B2B', fillOpacity: Math.round(FLAT_OPACITY * 100) / 100, opacity: 0.6, kind: 'radius' },
                                geometry: { type: 'Polygon', coordinates: [_heritageCirclePolygon(shape.latlng, radius)] }
                            });
                        });
                    });
                }
                _heritagePointRecords.forEach(function (record) {
                    if (!record.latlng) return;
                    var info = _resolveHeritageInfo(record.properties, record.layerId);
                    var popupHtml = _buildHeritagePopupContent(info.ran, info.name);
                    features.push({
                        type: 'Feature',
                        properties: {
                            color: record.color || '#C42B2B', fillColor: record.color || '#C42B2B',
                            radius: record.radius || 5, fillOpacity: 0.9, kind: 'site',
                            popup: popupHtml
                        },
                        geometry: { type: 'Point', coordinates: [record.latlng.lng, record.latlng.lat] }
                    });
                });
                var geojson = { type: 'FeatureCollection', features: features };
                _heritage3dCache = { stamp: stamp, geojson: geojson };
                return { geojson: geojson, stamp: stamp, label: 'Patrimoniu (heritage)' };
            }
            var Heritage3dBridge = L.Layer.extend({ onAdd: function () {}, onRemove: function () {} });
            var _heritage3dBridge = new Heritage3dBridge({ pane: 'pane_patrimoniu' });
            _heritage3dBridge._dl3dFeatures = _heritage3dFeatures;
            _heritage3dBridge._buildHeritagePopupContent = _buildHeritagePopupContent;
            window._heritage3dBridge = _heritage3dBridge;

            // Single unified togglePatrimoniuLayer — handles WMS layer AND radius circles
            window.togglePatrimoniuLayer = function (on) {
                var layer = window._patrimoniuLayer;
                var m = window._dlMap;
                if (!layer || !m) return;
                if (on && !_heritageDataReady) _startLocalLayerDataLoad();
                if (on) { layer.addTo(m); if (!m.hasLayer(_heritage3dBridge)) _heritage3dBridge.addTo(m); }
                else { m.removeLayer(layer); if (m.hasLayer(_heritage3dBridge)) m.removeLayer(_heritage3dBridge); }
                // Keep the WMS fallback (if active) in sync with the same toggle
                if (window._patrimoniuWmsFallback) {
                    if (on) { window._patrimoniuWmsFallback.addTo(m); } else { m.removeLayer(window._patrimoniuWmsFallback); }
                }
                _circlesVisible = on;

                // Arată sau ascunde imaginile PNG (doar pentru layer 0 și 5)
                _heritageImagesVisible = on;
                window._heritageImagesVisible = on;
                if (on) {
                    Object.keys(_heritageImageStore).forEach(function (k) {
                        if (!map.hasLayer(_heritageImageStore[k]))
                            _heritageImageStore[k].addTo(map);
                    });
                } else {
                    Object.keys(_heritageImageStore).forEach(function (k) {
                        if (map.hasLayer(_heritageImageStore[k]))
                            map.removeLayer(_heritageImageStore[k]);
                    });
                }

                _sitesCanvas.style.display = on ? '' : 'none';
                _heritagePolygonSignature = '';
                if (on) {
                    _updatePatrimoniuPolygons();
                    var slider = document.getElementById('patrimoniuOpacitySlider');
                    if (slider && parseInt(slider.value, 10) === 0) {
                        slider.value = 25; FLAT_OPACITY = 0.25;
                        document.getElementById('patrimoniuPct').textContent = '25%';
                    }
                    _displayCanvas.style.display = '';
                    loadSiteCircles();
                } else {
                    _displayCanvas.style.display = 'none';
                    _scheduleRedraw();
                }
            };

            // Popup styles
            (function () {
                var s = document.createElement('style');
                s.textContent =
                    '.patrimoniu-popup .leaflet-popup-content-wrapper{background:rgba(6,14,30,0.95);backdrop-filter:blur(16px);border:1px solid rgba(107,63,160,0.5);border-radius:10px;color:#F5F0EB;box-shadow:0 8px 32px rgba(0,0,0,0.6)}' +
                    '.patrimoniu-popup .leaflet-popup-tip{background:rgba(6,14,30,0.95)}' +
                    '.patrimoniu-popup .leaflet-popup-close-button{color:#B8D8F0!important}';
                document.head.appendChild(s);
            })();

            

            map.createPane('pane_apm');
            map.getPane('pane_apm').style.zIndex = 401;

            var _APM_BASE = 'https://sclav.andreiroba2000.workers.dev';
            var _APM_BOUNDS = L.latLngBounds(
                [42.865092546835, 19.901846451197],
                [49.002496199394, 30.671388069869]
            );

            function _createApmLayer(useTms) {
                if (window._apmLayer) map.removeLayer(window._apmLayer);
                var layer = L.tileLayer(_APM_BASE + '/APM_TILES/{z}/{x}/{y}.png', {
                    pane: 'pane_apm',
                    opacity: 0.80,
                    bounds: _APM_BOUNDS,
                    minZoom: 5,
                    maxZoom: 18,
                    minNativeZoom: 6,
                    maxNativeZoom: 12,
                    tms: useTms,
                    crossOrigin: 'anonymous',
                    errorTileUrl: ''
                });
                // APM is opt-in: keep the layer off until the user enables it.
                // The probe is asynchronous, so checking the control here also
                // respects a click made while the tile source is being detected.
                var apmToggle = document.getElementById('apmToggle');
                if (apmToggle && apmToggle.checked) layer.addTo(map);
                window._apmLayer = layer;
                return layer;
            }

            var _tmsProbe = new Image();
            _tmsProbe.onload = function () {
                console.log('[APM] Probe /6/36/40 OK => TMS format => tms:true');
                _createApmLayer(true);
            };
            _tmsProbe.onerror = function () {
                console.warn('[APM] Probe /6/36/40 failed, trying XYZ /6/36/23...');
                var _xyzProbe = new Image();
                _xyzProbe.onload = function () {
                    console.log('[APM] Probe /6/36/23 OK => XYZ format => tms:false');
                    _createApmLayer(false);
                };
                _xyzProbe.onerror = function () {
                    console.error('[APM] Both probes failed — check worker and bucket');
                    _createApmLayer(true);
                };
                _xyzProbe.src = _APM_BASE + '/APM_TILES/6/36/23.png';
            };
            _tmsProbe.src = _APM_BASE + '/APM_TILES/6/36/40.png';

            console.log('[DetectLab] APM tile layer probing Cloudflare R2...');

            // Expose for external controls
            window._dlMap = map;

            // ── APM LAYER TOGGLE ──
            window.toggleApmLayer = function (on) {
                var layer = window._apmLayer;
                if (!layer) return;
                if (on) { layer.addTo(map); } else { map.removeLayer(layer); }
            };

            // ── ROMAN EMPIRE — SUB-LAYER SYSTEM ──
            map.createPane('pane_roman');
            map.getPane('pane_roman').style.zIndex = 625;
            map.getPane('pane_roman').style.pointerEvents = 'auto';

            var _romanOpacity = 0.70;
            var _romanVisible = false;

            // ── Sub-layer definitions ──
            // type: 'geojson' | 'wms' | 'tilelayer'
            // enabled: initial state (mirrors checkbox defaults in HTML)
            // NOTE: AWMC GeoServer WMS (awmc.unc.edu/awmc/map/geoserver) is defunct as of 2024.
            // All layers now use GeoJSON from forked AWMC repo (andrei-roba29/geo_data) which mirrors
            // the current AWMC/geodata structure. Folder layout changed — see Cultural-Data/ in fork.
            var _AWMC = 'https://raw.githubusercontent.com/andrei-roba29/geo_data/master/Cultural-Data/';
            var ROMAN_SUB_LAYERS = {

                // ── INFRASTRUCTURE ──
                roads: {
                    label: 'Roads', color: '#FF5A36', weight: 1.8, enabled: false,
                    type: 'ndjson'
                },
                places: {
                    label: 'Roman Sites (Pleiades)', color: '#FFD60A', weight: 1, enabled: false,
                    type: 'pleiades'
                },
                // ── POINTS & LABELS ──
                dare_11: { label: 'Major Settlements', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_17: { label: 'Major Forts', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_13: { label: 'Civitas Capitals', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_12: { label: 'Regular Settlements', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_18: { label: 'Forts/Castrum', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_53: { label: 'Fortlets/Towers', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_16: { label: 'Roads/Coastal Stations', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_61: { label: 'Sanctuaries/Temples', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_66: { label: 'Baths', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_32: { label: 'Tumuli', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_63: { label: 'Cemeteries', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_21: { label: 'Monasteries', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_24: { label: 'Churches', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_14: { label: 'Villas', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_57: { label: 'Mines/Quarries', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_49: { label: 'Passes', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_51: { label: 'Bridges', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_55: { label: 'Roads/Milestones', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_52: { label: 'Aqueducts', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                dare_64: { label: 'Monuments', color: '#CC2222', weight: 1.5, enabled: true, type: 'geojson', dare: true },
                walls: {
                    label: 'Walls', color: '#E2BE64', weight: 2.4, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'walls/walls.geojson'
                },
                regional_names: {
                    label: 'Regional Names', color: '#FFFFFF', weight: 0.8, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'regional_name_linework/regional_names_linework.geojson'
                },

                // ── POLITICAL SHADING ──
                shade_117: {
                    label: 'Roman Empire 117 CE', color: '#AA32AA', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/roman_empire_ce_117_extent/roman_empire_ce_117_extent.geojson'
                },
                shade_60bce: {
                    label: 'Roman Empire 60 BCE', color: '#CC2222', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/roman_empire_bce_60/roman_empire_bce_60.geojson'
                },
                shade_200: {
                    label: 'Roman Empire 200 CE', color: '#E17D28', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/roman_empire_ce_200_extent/roman_empire_ce_200_extent.geojson'
                },
                shade_alexander: {
                    label: "Alexander's Empire", color: '#3CAA5A', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/alexanders_empire/alexanders_empire.geojson'
                },
                shade_persian: {
                    label: 'Persian Empire', color: '#875FCD', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/persian_extent/extent_of_the_persian_empire.geojson'
                },
                shade_diocletian: {
                    label: 'Roman Provinces after Diocletian', color: '#3C8CCD', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/roman_empire_provinces post_diocletian/roman_empire_provinces post_diocletian.geojson'
                },
                shade_herod: {
                    label: "Herod's Empire", color: '#EBC328', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/herod/herods_kingdom.geojson'
                },
                shade_hasmonean: {
                    label: 'Hasmonean Kingdom', color: '#28AFAF', weight: 1.2, enabled: false,
                    type: 'geojson',
                    url: _AWMC + 'political_shading/hasmonean/hasmonean_kingdom.geojson'
                }
            };

            // Runtime state: leaflet layer instances per key
            var _romanLayers = {};   // key → Leaflet layer
            var _romanEnabled = {};  // key → bool (from checkbox state)
            var _romanCache  = {};   // url → GeoJSON data
            var _romanLoading = {};  // key → bool (tracks active fetches)
            var _viciCache  = {};    // id → bool (tracks loaded vici features)

            // Initialise enabled state from definitions
            Object.keys(ROMAN_SUB_LAYERS).forEach(function(k) {
                _romanEnabled[k] = ROMAN_SUB_LAYERS[k].enabled;
            });
            // subscriptions.js calls this when Premium entitlement is applied:
            // it restores the reference's default-checked DARE categories after
            // the locked free-user UI has temporarily unchecked them.
            window._syncRomanDareCategoryToggles = function () {
                Object.keys(ROMAN_SUB_LAYERS).forEach(function (key) {
                    if (key.indexOf('dare_') !== 0) return;
                    var input = document.getElementById('roman_' + key);
                    if (input) input.checked = !!_romanEnabled[key];
                });
            };

            var _romanGroup = L.layerGroup([], { pane: 'pane_roman' });
            window._romanGroup = _romanGroup;

            function _isEuropeMarket() {
                try {
                    if (window.DetectLabSite && typeof window.DetectLabSite.isEurope === 'boolean') {
                        return window.DetectLabSite.isEurope;
                    }
                    if (window.location && window.location.hostname) {
                        return window.location.hostname.toLowerCase().indexOf('detectlab.eu') !== -1;
                    }
                } catch (e) {}
                return false;
            }

            // ── Romania bounds helper: on .ro non-shade Roman layers are Romania-only, on .eu full original scale ──
            function _romanFeatureInBounds(feature, useDareCountryOverride) {
                if (_isEuropeMarket()) return true; // Full original scale on detectlab.eu
                if (useDareCountryOverride) {
                    var countryField = document.getElementById('romanDareCountryCode');
                    if (countryField && /^[A-Z]{2}$/.test(countryField.value.trim().toUpperCase())) {
                        return true; // DARE's valid ISO2 cc parameter is authoritative.
                    }
                }
                var b = ROMANIA_BOUNDS;
                if (!b) return true;
                function checkCoord(c) {
                    return c[1] >= b.getSouth() && c[1] <= b.getNorth() && c[0] >= b.getWest() && c[0] <= b.getEast();
                }
                function checkGeom(g) {
                    if (!g) return false;
                    if (g.type === 'Point') return checkCoord(g.coordinates);
                    if (g.type === 'MultiPoint') return g.coordinates.some(checkCoord);
                    if (g.type === 'LineString') return g.coordinates.some(checkCoord);
                    if (g.type === 'MultiLineString') return g.coordinates.some(function(r) { return r.some(checkCoord); });
                    if (g.type === 'Polygon') return g.coordinates.some(function(r) { return r.some(checkCoord); });
                    if (g.type === 'MultiPolygon') return g.coordinates.some(function(p) { return p.some(function(r) { return r.some(checkCoord); }); });
                    if (g.type === 'GeometryCollection') return g.geometries.some(checkGeom);
                    return false;
                }
                return checkGeom(feature.geometry);
            }

            // ── Build one Leaflet layer for a sub-layer config ──
            function _buildRomanLeafletLayer(key, cfg, geojsonData) {
                if (cfg.type === 'wms') {
                    return L.tileLayer.wms(cfg.url, {
                        layers: cfg.layers,
                        format: 'image/png',
                        transparent: true,
                        version: '1.1.1',
                        opacity: _romanOpacity,
                        pane: 'pane_roman',
                        attribution: '© AWMC'
                    });
                }
                if (cfg.type === 'geojson' && geojsonData) {
                    var isShade = key.indexOf('shade_') === 0;
                    return L.geoJSON(geojsonData, {
                        pane: 'pane_roman',
                        filter: isShade ? null : function (feature) { return _romanFeatureInBounds(feature); },
                        interactive: key === 'regional_names',
                        style: function() {
                            return {
                                color: cfg.color,
                                fillColor: cfg.color,
                                weight: cfg.weight,
                                opacity: _romanOpacity,
                                fillOpacity: _romanOpacity * 0.18,
                                pane: 'pane_roman'
                            };
                        },
                        pointToLayer: function(feature, latlng) {
                            return L.circleMarker(latlng, {
                                pane: 'pane_roman',
                                radius: 4,
                                color: cfg.color,
                                fillColor: cfg.color,
                                fillOpacity: _romanOpacity * 0.6,
                                opacity: _romanOpacity,
                                weight: 1
                            });
                        },
                        onEachFeature: function(feature, layer) {
                            var p = feature.properties || {};
                            var name = p.label || p.name || p.NAME || p.Label || p.LABEL || p.PLabel || '';
                            if (name) {
                                layer.bindTooltip(
                                    '<span style="font-family:\'Cinzel\',serif;font-size:0.78rem;color:#E8772A;">' + name + '</span>' +
                                    '<br><span style="font-size:0.68rem;opacity:0.6;">' + cfg.label + ' · Roman Empire</span>',
                                    { className: 'map-search-tooltip', sticky: true }
                                );
                            }
                        }
                    });
                }
                return null;
            }

            // ── ROMAN EMPIRE — DARE sites, roads & AWMC layers ──
            // Aceeași logică de încărcare și aceleași pictograme ca în harta de
            // referință (imperium / DARE): badge rotund 26px cu glif SVG pe
            // categorie, cereri DARE pe viewport (zoom ≥ 7, plafon 10, cu
            // deduplicare și o singură cerere în zbor), iar drumurile romane se
            // citesc în flux (NDJSON) cu progres și segmentele apar pe măsură ce
            // sosesc. Celelalte straturi AWMC rămân GeoJSON cu cache.

            // Etichetele și glifele celor 20 de categorii DARE (numType → glif 24×24, stroke).
            var DARE_CAT_LABELS = {
                11: 'Major Settlements', 12: 'Regular Settlements', 13: 'Civitas Capitals', 14: 'Villas',
                16: 'Roads / Coastal Stations', 17: 'Major Forts', 18: 'Forts / Castrum', 21: 'Monasteries',
                24: 'Churches', 32: 'Tumuli', 49: 'Passes', 51: 'Bridges', 52: 'Aqueducts', 53: 'Fortlets / Towers',
                55: 'Roads / Milestones', 57: 'Mines / Quarries', 61: 'Sanctuaries / Temples', 63: 'Cemeteries',
                64: 'Monuments', 66: 'Baths'
            };
            var DARE_CAT_GLYPHS = {
                11: 'M2 21h20M3 21V11h5v10M8 21V4h7v17M15 21V9h6v12M10.5 8h2M10.5 12h2M10.5 16h2',
                12: 'M2 21h20M3 21v-8l4-4 4 4v8M13 21v-6l4-4 4 4v6M6 17h2M16 18h2',
                13: 'M3 21V11l9-5 9 5v10M12 6V1.5M12 1.5h4.5v3H12M9.5 21v-6h5v6M2 21h20',
                14: 'M2 11l10-7 10 7M4 10v11h16V10M8 21v-6M12 21v-6M16 21v-6M2 21h20',
                16: 'M12 2v20M6 4.5h10l3 3-3 3H6zM18 13.5H8l-3 3 3 3h10zM9 22h6',
                17: 'M3 21V6h4v3h2V6h6v3h2V6h4v15zM10 21v-5h4v5M3 21h18',
                18: 'M6 6h12v12H6zM2.5 2.5h5v5h-5zM16.5 2.5h5v5h-5zM2.5 16.5h5v5h-5zM16.5 16.5h5v5h-5z',
                21: 'M2 21h20M3 21V12l9-6 9 6v9M12 8.5v5M9.5 11h5M9 21v-4.5h6V21',
                24: 'M12 1.5v5M9.8 3.7h4.4M5 21v-9l7-5 7 5v9zM10 21v-5h4v5M2 21h20',
                32: 'M2 20h20M3.5 20C3.5 13 7.5 9 12 9s8.5 4 8.5 11M12 9V4M12 4h4l-1.2 1.5L16 7h-4',
                49: 'M1.5 20L8 8l4 7 3-5.5 7.5 10.5zM8 8l1.8 3.2M15 9.5l1.5 2.2',
                51: 'M1.5 9h21M4 9v12M20 9v12M1.5 21h21M4 21c0-5.5 3.5-8.5 8-8.5s8 3 8 8.5',
                52: 'M1.5 5.5h21M3 5.5V21M9 5.5V21M15 5.5V21M21 5.5V21M1.5 21h21M3 15.5a3 3 0 0 1 6 0M9 15.5a3 3 0 0 1 6 0M15 15.5a3 3 0 0 1 6 0',
                53: 'M8 21V9h8v12M5.5 9h13V4.5h-2.7V7h-2V4.5h-3.6V7h-2V4.5H5.5zM10.5 21v-4.5h3V21M11.5 12.5h1M4 21h16',
                55: 'M2 21h20M8.5 21V8.5a3.5 3.5 0 0 1 7 0V21M10.5 11.5h3M10.5 14.5h3M10.5 17.5h3',
                57: 'M5 21.5L16.5 8M6.5 5C12.5 2.5 19.5 6 21 13M6.5 5l2.2 3.2M21 13l-3.4-1.4M3 21.5h5',
                61: 'M2 9.5L12 3.5l10 6zM4 9.5h16M6 12v7M10 12v7M14 12v7M18 12v7M3.5 19h17M2 21.5h20',
                63: 'M6.5 21V10a5.5 5.5 0 0 1 11 0v11zM12 8.5v7M9.2 11.2h5.6M3 21h18',
                64: 'M9.5 20L10.7 6 12 2.5 13.3 6 14.5 20zM7 20h10M5.5 22h13M11 10h2',
                66: 'M2 16c2-2 4 2 6 0s4 2 6 0 4 2 6 0M2 20.5c2-2 4 2 6 0s4 2 6 0 4 2 6 0M7 11.5c-1.5-2 1.5-3 0-5.5M12 11.5c-1.5-2 1.5-3 0-5.5M17 11.5c-1.5-2 1.5-3 0-5.5'
            };
            var _DARE_COLOR = '#CC2222';

            // API-ul DARE trimite text dublu codat (UTF-8 citit ca Windows-1252): "Å arkamen" → "Šarkamen"
            var _CP1252_REV = {0x20AC:0x80,0x201A:0x82,0x0192:0x83,0x201E:0x84,0x2026:0x85,0x2020:0x86,0x2021:0x87,0x02C6:0x88,0x2030:0x89,0x0160:0x8A,
                0x2039:0x8B,0x0152:0x8C,0x017D:0x8E,0x2018:0x91,0x2019:0x92,0x201C:0x93,0x201D:0x94,0x2022:0x95,0x2013:0x96,0x2014:0x97,0x02DC:0x98,
                0x2122:0x99,0x0161:0x9A,0x203A:0x9B,0x0153:0x9C,0x017E:0x9E,0x0178:0x9F};
            function _fixMojibake(s) {
                if (typeof s !== 'string' || !/[\u00c2-\u00f4]/.test(s)) return s;
                var b = [];
                for (var i = 0; i < s.length; i++) {
                    var c = s.codePointAt(i);
                    if (c > 0xFFFF) i++;
                    if (c <= 0xFF) b.push(c);
                    else if (_CP1252_REV[c] !== undefined) b.push(_CP1252_REV[c]);
                    else return s;
                }
                try { return new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(b)); } catch (e) { return s; }
            }

            function _dareTypeNum(f) {
                var p = (f && f.properties) || {};
                var n = parseInt(p.numType, 10);
                if (isNaN(n)) n = parseInt(p.type, 10);
                return isNaN(n) ? String(p.numType || p.type || p.sympl || '') : n;
            }
            function _dareGlyph(type) {
                var g = DARE_CAT_GLYPHS[String(type)];
                return g ? '<path d="' + g + '"/>' : '<circle cx="12" cy="12" r="8"/>';
            }
            // Reuse one SVG for the 26px map markers and the 20px category legend.
            function _dareIconSvg(type, size) {
                var px = size || 26;
                return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 26 26" style="display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.55));">' +
                    '<circle cx="13" cy="13" r="11.5" fill="#0c111e" fill-opacity=".68" stroke="' + _DARE_COLOR + '" stroke-width="1.5"/>' +
                    '<g transform="translate(4.5 4.5) scale(0.7083)" fill="none" stroke="#ffd9d9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                    _dareGlyph(type) + '</g></svg>';
            }
            function getDareIcon(type) {
                return L.divIcon({
                    html: _dareIconSvg(type),
                    className: 'dare-icon-marker',
                    iconSize: [26, 26],
                    iconAnchor: [13, 13]
                });
            }
            function _renderDareCategoryIcons() {
                document.querySelectorAll('#romanSubLayers input[id^="roman_dare_"]').forEach(function (input) {
                    var type = parseInt(input.id.slice('roman_dare_'.length), 10);
                    var row = input.parentElement && input.parentElement.parentElement;
                    var legend = row && row.children && row.children[0];
                    var icon = legend && legend.querySelector ? legend.querySelector('span') : null;
                    if (!icon || !DARE_CAT_GLYPHS[type]) return;
                    icon.style.cssText = 'width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:none;border:0;border-radius:0;';
                    icon.innerHTML = _dareIconSvg(type, 20);
                });
            }
            _renderDareCategoryIcons();

            function _createDareLayer() {
                return L.geoJSON(null, {
                    pane: 'pane_roman',
                    pointToLayer: function (feature, latlng) {
                        return L.marker(latlng, {
                            pane: 'pane_roman',
                            icon: getDareIcon(_dareTypeNum(feature)),
                            opacity: _romanOpacity,
                            interactive: true
                        });
                    },
                    onEachFeature: function (feature, layer) {
                        var p = feature.properties || {};
                        var displayName = (p.ancient && p.name) ? (p.ancient + ' (' + p.name + ')') : (p.ancient || p.name || 'Unnamed Roman Site');
                        var typeLabel = DARE_CAT_LABELS[_dareTypeNum(feature)] || p.type || '';
                        var html = '<span style="font-family:\'Cinzel\',serif;font-size:0.78rem;color:#E8772A;">' + _romanEscapeHtml(_fixMojibake(displayName)) + '</span>';
                        if (typeLabel) html += '<br><span style="font-size:0.68rem;opacity:0.8;color:#E8772A;">Type: ' + _romanEscapeHtml(typeLabel) + '</span>';
                        html += '<br><span style="font-size:0.68rem;opacity:0.6;">DARE Roman Site · Roman Empire</span>';
                        var dareId = feature.id || p.id;
                        if (dareId) html += '<br><a href="https://imperium.ahlfeldt.se/places/' + encodeURIComponent(String(dareId)) + '.html" target="_blank" rel="noopener" style="color:#E8772A;text-decoration:underline;font-size:0.68rem;pointer-events:auto;">View on DARE</a>';
                        layer.bindTooltip(html, { className: 'map-search-tooltip', sticky: true });
                        layer.bindPopup(html);
                    }
                });
            }

            // Mesaje de stare sub panoul Roman (DARE / drumuri), ca la referință.
            var _romanStatusEls = {};
            function _romanStatus(key, text) {
                var el = _romanStatusEls[key];
                if (!el) {
                    var host = document.getElementById('romanSubLayers');
                    if (!host) return;
                    el = document.createElement('div');
                    el.style.cssText = 'font-size:11px;color:#9fb3c9;padding:0 2px;';
                    host.insertBefore(el, host.firstChild);
                    _romanStatusEls[key] = el;
                }
                el.textContent = text || '';
            }

            // ── DARE: cereri pe viewport, deduplicate, o singură cerere în zbor ──
            var _dareSeen = {};          // id → true (toate categoriile)
            var _dareInflight = false, _dareAgain = false, _dareTimer = null, _dareRequestVersion = 0;
            var _pleiadesRows = null, _pleiadesLoading = false, _pleiadesPeriod = 'R';
            var PLEIADES_URLS = [
                'https://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz',
                'http://atlantides.org/downloads/pleiades/dumps/pleiades-places-latest.csv.gz'
            ];
            var DARE_MIN_ZOOM = 7;

            function _dareAnyEnabled() {
                for (var k in _romanEnabled) if (k.indexOf('dare_') === 0 && _romanEnabled[k]) return true;
                return false;
            }
            function _dareLayerFor(n) {
                var key = 'dare_' + n;
                if (!_romanLayers[key]) _romanLayers[key] = _createDareLayer();
                return _romanLayers[key];
            }

            function _clearDareSites() {
                _dareRequestVersion++; // Ignore an older ISO2/viewport response still in flight.
                _dareSeen = {};
                Object.keys(_romanLayers).forEach(function (key) {
                    if (key.indexOf('dare_') !== 0) return;
                    var layer = _romanLayers[key];
                    if (layer && typeof layer.clearLayers === 'function') layer.clearLayers();
                });
            }
            var _dareCountryInput = document.getElementById('romanDareCountryCode');
            if (_dareCountryInput) _dareCountryInput.addEventListener('change', function () {
                _dareCountryInput.value = _dareCountryInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
                _clearDareSites();
                if (_romanVisible && _dareAnyEnabled()) _loadDynamicDareSites();
            });
            function _dareStatusFor(zoom) {
                if (!_dareAnyEnabled()) return _romanStatus('dare', '');
                if (zoom < DARE_MIN_ZOOM) return _romanStatus('dare', 'DARE: zoom in to level ' + DARE_MIN_ZOOM + '+ to load sites (now ' + zoom.toFixed(1) + ').');
            }

            function _loadDynamicDareSites() {
                clearTimeout(_dareTimer);
                _dareTimer = setTimeout(_fetchDareNow, 150);
            }
            // Keep DARE aligned with the current map viewport, just like the
            // reference: pan/zoom events are debounced and serialized by the
            // one-in-flight guard in _fetchDareNow().
            map.on('moveend zoomend', function () {
                if (_romanVisible && _dareAnyEnabled()) _loadDynamicDareSites();
            });
            function _fetchDareNow() {
                if (!_romanVisible || !_dareAnyEnabled()) { _romanStatus('dare', ''); return; }
                var zoom = map.getZoom();
                if (zoom < DARE_MIN_ZOOM) { _dareStatusFor(zoom); return; }
                if (_dareInflight) { _dareAgain = true; return; }
                _dareInflight = true;
                var requestVersion = _dareRequestVersion;

                var b = map.getBounds();
                var bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (x) { return x.toFixed(4); }).join(',');
                var countryField = document.getElementById('romanDareCountryCode');
                var cc = countryField && countryField.value ? countryField.value.trim().toUpperCase() : '';
                if (!/^[A-Z]{2}$/.test(cc)) cc = '';
                if (!cc && !_isEuropeMarket()) cc = 'RO';
                var ccParam = cc ? '&cc=' + encodeURIComponent(cc) : '';
                var url = 'https://imperium.ahlfeldt.se/api/geojson.php?bbox=' + bbox + '&zoom=' + Math.min(Math.round(zoom), 10) + ccParam;

                fetch(url)
                    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function (data) {
                        if (!_romanVisible || !_dareAnyEnabled() || requestVersion !== _dareRequestVersion) return;
                        var batches = {}, added = 0;
                        ((data && data.features) || []).forEach(function (f) {
                            if (!f || !f.geometry || f.geometry.type !== 'Point') return;
                            if (!_romanFeatureInBounds(f, true)) return;
                            var p = f.properties || {};
                            var id = String(f.id != null ? f.id : (p.id != null ? p.id : ''));
                            if (!id || _dareSeen[id]) return;
                            var n = _dareTypeNum(f);
                            if (typeof n !== 'number' || !DARE_CAT_LABELS[n]) return;
                            _dareSeen[id] = true; added++;
                            var fixed = {type: 'Feature', id: f.id, geometry: f.geometry, properties: Object.assign({}, p, {
                                name: _fixMojibake(p.name), ancient: _fixMojibake(p.ancient)
                            })};
                            (batches[n] = batches[n] || []).push(fixed);
                        });
                        Object.keys(batches).forEach(function (n) {
                            var layer = _dareLayerFor(n);
                            layer.addData({type: 'FeatureCollection', features: batches[n]});
                            if (_romanEnabled['dare_' + n] && !_romanGroup.hasLayer(layer)) _romanGroup.addLayer(layer);
                        });
                        var total = Object.keys(_dareSeen).length;
                        _romanStatus('dare', 'DARE: ' + total.toLocaleString() + ' sites loaded (+' + added + ').');
                    })
                    .catch(function (e) {
                        console.warn('[Roman] DARE fetch failed (retry on next move):', e && e.message);
                        _romanStatus('dare', 'DARE: could not load sites — retrying on the next move.');
                    })
                    .finally(function () {
                        _dareInflight = false;
                        if (_dareAgain) { _dareAgain = false; _loadDynamicDareSites(); }
                    });
            }

            // ── Pleiades: export CSV comprimat, filtrat după perioada selectată ──
            function _parseRomanCsv(text) {
                var rows = [], row = [], field = '', quoted = false;
                for (var i = 0; i < text.length; i++) {
                    var c = text[i];
                    if (quoted) {
                        if (c === '"') {
                            if (text[i + 1] === '"') { field += '"'; i++; }
                            else quoted = false;
                        } else field += c;
                    } else if (c === '"') quoted = true;
                    else if (c === ',') { row.push(field); field = ''; }
                    else if (c === '\n' || c === '\r') {
                        if (c === '\r' && text[i + 1] === '\n') i++;
                        row.push(field); field = '';
                        if (row.length > 1 || row[0] !== '') rows.push(row);
                        row = [];
                    } else field += c;
                }
                if (field !== '' || row.length) { row.push(field); rows.push(row); }
                return rows;
            }
            function _parsePleiadesCsv(text) {
                var rows = _parseRomanCsv(text);
                if (!rows.length) throw new Error('empty CSV');
                var headers = rows[0].map(function (x) { return x.replace(/^\uFEFF/, '').trim().toLowerCase(); });
                var ix = function (name) { return headers.indexOf(name); };
                var iId = ix('id'), iTitle = ix('title'), iDesc = ix('description'), iTypes = ix('featuretypes');
                var iLat = ix('reprlat'), iLon = ix('reprlong'), iLatLon = ix('reprlatlong');
                var iKeys = ix('timeperiodskeys'), iPeriods = ix('timeperiods');
                if (iLat < 0 && iLatLon < 0) throw new Error('no coordinate column');
                if (iKeys < 0 && iPeriods < 0) throw new Error('no time period column');
                var out = [];
                for (var r = 1; r < rows.length; r++) {
                    var row = rows[r], lat = parseFloat(row[iLat]), lon = parseFloat(row[iLon]);
                    if ((!isFinite(lat) || !isFinite(lon)) && iLatLon >= 0) {
                        var pair = String(row[iLatLon] || '').split(/[ ,]+/);
                        lat = parseFloat(pair[0]); lon = parseFloat(pair[1]);
                    }
                    if (!isFinite(lat) || !isFinite(lon)) continue;
                    var tokens = ((iKeys >= 0 ? row[iKeys] : '') + ',' + (iPeriods >= 0 ? row[iPeriods] : ''))
                        .toLowerCase().split(/[\s,;|]+/).filter(Boolean);
                    var isRoman = tokens.indexOf('r') >= 0 || tokens.indexOf('roman') >= 0;
                    var isRepublican = tokens.indexOf('h') >= 0 || tokens.some(function (x) { return x.indexOf('hellenistic') === 0; });
                    var isLate = tokens.indexOf('l') >= 0 || tokens.some(function (x) { return x.indexOf('late') === 0; });
                    if (!(isRoman || isRepublican || isLate)) continue;
                    out.push({
                        pid: row[iId], title: row[iTitle] || '(untitled)', description: row[iDesc] || '',
                        types: String(row[iTypes] || '').replace(/,/g, ', '), lat: lat, lon: lon,
                        R: isRoman ? 1 : 0, H: isRepublican ? 1 : 0, L: isLate ? 1 : 0
                    });
                }
                return out;
            }
            function _bytesToRomanText(buffer) {
                var bytes = new Uint8Array(buffer);
                if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
                    if (typeof DecompressionStream === 'undefined') throw new Error('gzip decompression is not supported in this browser');
                    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
                }
                return Promise.resolve(new TextDecoder().decode(bytes));
            }
            function _romanEscapeHtml(value) {
                return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
                });
            }
            function _pleiadesRowsForPeriod() {
                return (_pleiadesRows || []).filter(function (row) {
                    return _pleiadesPeriod === 'RH' ? (row.R || row.H)
                        : _pleiadesPeriod === 'RL' ? (row.R || row.L) : row.R;
                });
            }
            function _buildRomanPleiadesLayer() {
                if (!_pleiadesRows) return;
                var oldLayer = _romanLayers.places;
                if (oldLayer && _romanGroup.hasLayer(oldLayer)) _romanGroup.removeLayer(oldLayer);
                var rows = _pleiadesRowsForPeriod().filter(function (row) {
                    return _romanFeatureInBounds({geometry: {type: 'Point', coordinates: [row.lon, row.lat]}});
                });
                var features = rows.map(function (row) {
                    return {type: 'Feature', id: String(row.pid || ''), geometry: {type: 'Point', coordinates: [row.lon, row.lat]}, properties: row};
                });
                var layer = L.geoJSON({type: 'FeatureCollection', features: features}, {
                    pane: 'pane_roman',
                    pointToLayer: function (feature, latlng) {
                        return L.circleMarker(latlng, {pane: 'pane_roman', radius: 4, color: '#111111', weight: 0.7,
                            fillColor: '#FFD60A', fillOpacity: 0.95, opacity: _romanOpacity, interactive: true});
                    },
                    onEachFeature: function (feature, featureLayer) {
                        var p = feature.properties || {};
                        var title = _romanEscapeHtml(p.title || '(untitled)');
                        var content = '<p>' + _romanEscapeHtml(p.description || '') + '</p><p><b>Types:</b> ' + _romanEscapeHtml(p.types || '–') + '</p>' +
                            '<p><a href="https://pleiades.stoa.org/places/' + encodeURIComponent(p.pid || '') + '" target="_blank" rel="noopener">Open in Pleiades</a></p>';
                        featureLayer.bindTooltip(title + '<br><span style="font-size:0.68rem;opacity:0.7">Pleiades · Roman-period site</span>',
                            {className: 'map-search-tooltip', sticky: true});
                        featureLayer.bindPopup(content);
                    }
                });
                _romanLayers.places = layer;
                if (_romanVisible && _romanEnabled.places) _romanGroup.addLayer(layer);
                _romanStatus('places', 'Sites: ' + rows.length.toLocaleString() + ' Roman-period places (Pleiades).');
            }
            function _ingestRomanPleiades(buffer) {
                return _bytesToRomanText(buffer).then(function (text) {
                    _pleiadesRows = _parsePleiadesCsv(text);
                    _buildRomanPleiadesLayer();
                    return true;
                }).catch(function (e) {
                    _romanStatus('places', 'Sites: ' + e.message);
                    return false;
                });
            }
            function _showRomanPleiadesFilePicker() {
                var fallback = document.getElementById('romanPlacesFallback');
                if (fallback) fallback.style.display = 'block';
            }
            function _loadRomanPleiades() {
                if (!_romanVisible || !_romanEnabled.places) return;
                if (_pleiadesRows) { _buildRomanPleiadesLayer(); return; }
                if (_pleiadesLoading) return;
                _pleiadesLoading = true;
                _romanStatus('places', 'Sites: downloading Pleiades export…');
                (async function () {
                    for (var i = 0; i < PLEIADES_URLS.length; i++) {
                        try {
                            var response = await fetch(PLEIADES_URLS[i]);
                            if (!response.ok) throw new Error('HTTP ' + response.status);
                            if (await _ingestRomanPleiades(await response.arrayBuffer())) return;
                        } catch (e) { console.warn('[Roman] Pleiades source unavailable:', e && e.message); }
                    }
                    _romanStatus('places', 'Sites: Pleiades server unavailable. Select the CSV.GZ export file.');
                    _showRomanPleiadesFilePicker();
                })().finally(function () { _pleiadesLoading = false; });
            }
            var _romanPlacesFile = document.getElementById('romanPlacesFile');
            if (_romanPlacesFile) _romanPlacesFile.addEventListener('change', function () {
                var file = _romanPlacesFile.files && _romanPlacesFile.files[0];
                if (!file) return;
                _romanStatus('places', 'Sites: reading selected Pleiades file…');
                file.arrayBuffer().then(_ingestRomanPleiades);
            });
            window.setRomanPlacesPeriod = function (period) {
                _pleiadesPeriod = period === 'RH' || period === 'RL' ? period : 'R';
                if (_pleiadesRows && _romanVisible && _romanEnabled.places) _buildRomanPleiadesLayer();
            };
            window.toggleRomanDareCategories = function (on) {
                var ids = Object.keys(ROMAN_SUB_LAYERS).filter(function (key) { return key.indexOf('dare_') === 0; });
                ids.forEach(function (key) {
                    _romanEnabled[key] = !!on;
                    var input = document.getElementById('roman_' + key);
                    if (input) input.checked = !!on;
                    var layer = _romanLayers[key];
                    if (!on && layer && _romanGroup.hasLayer(layer)) _romanGroup.removeLayer(layer);
                });
                if (!on) _romanStatus('dare', '');
                if (on && !_romanVisible) {
                    var master = document.getElementById('romanToggle');
                    if (master) master.checked = true;
                    window.toggleRomanLayer(true);
                } else if (on && _romanVisible) _loadDynamicDareSites();
            };

            // ── Drumuri romane ──────────────────────────────────────────────
            // The network is a stream of NDJSON records (one record per route
            // segment) and the map renders it as ONE canvas tile layer of
            // binary geometry:
            //   js/roman-roads-worker.js  reads + parses the stream off-thread,
            //   js/roman-roads-parser.js  turns records into typed arrays,
            //   js/roman-roads.js         paints the tiles the viewport shows.
            // Nothing is parsed on the main thread any more, no road segment
            // becomes a DOM node, nothing outside the viewport is drawn, and
            // the item budget keeps the per-tile work flat. This is what the
            // old per-segment `L.polyline` loop cost us: the stream stalled at
            // a few percent, the tab froze and (mobile / installed PWA) the
            // renderer killed the page. See ROMAN_ROADS_PERFORMANCE.md.
            var ROMAN_ROADS_URL = 'https://dacboefvooxgsngxkavx.supabase.co/storage/v1/object/public/Harti/route-segments-all-1791445468011.ndjson';
            var _roadsLoading = false, _roadsDone = false, _roadsLoad = null;

            // The canvas layer that carries the roads (created on first use).
            function _roadsLayer() {
                var lyr = _romanLayers.roads;
                if (lyr && lyr.addBatch) return lyr;
                var factory = window.DetectLabRomanRoads;
                if (!factory) return null;
                var cfg = ROMAN_SUB_LAYERS.roads || {};
                lyr = factory.createLayer({
                    pane: 'pane_roman',
                    name: 'Roman roads',
                    color: cfg.color || '#FF5A36',
                    weight: cfg.weight || 1.8,
                    opacity: _romanOpacity
                });
                if (!lyr) return null;
                _romanLayers.roads = lyr;
                /* The analysis panel measures against the same network when it
                 * is already on the map, instead of downloading the reference
                 * GeoJSON again (js/archeo-report.js). */
                window._romanRoadsLayer = lyr;
                return lyr;
            }

            function _roadsMb(bytes) {
                var mb = bytes / 1048576;
                return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + ' MB';
            }

            // Live status: bytes read / total + segments kept, so the line
            // keeps moving while the stream arrives instead of parking at a
            // byte percentage the user cannot interpret.
            function _roadsStatus(ev) {
                var parts = [ev.segments.toLocaleString() + ' segments'];
                if (ev.total) {
                    parts.push(_roadsMb(ev.bytes) + ' / ' + _roadsMb(ev.total) +
                        ' · ' + Math.min(100, Math.round(ev.bytes / ev.total * 100)) + '%');
                } else {
                    parts.push(_roadsMb(ev.bytes) + ' read');
                }
                if (ev.stride && ev.stride > 1) parts.push('sampled 1:' + ev.stride);
                else if (ev.sampled) parts.push(ev.sampled.toLocaleString() + ' dropped');
                if (ev.elapsed > 4000) parts.push(Math.round(ev.elapsed / 1000) + 's');
                _romanStatus('roads', 'Roads: ' + parts.join(' · '));
            }

            function _loadRomanRoads() {
                var layer = _roadsLayer();
                if (!layer) {
                    _romanStatus('roads', 'Roads: canvas layer unavailable.');
                    return;
                }
                if (_romanEnabled.roads && _romanVisible && !_romanGroup.hasLayer(layer)) _romanGroup.addLayer(layer);
                if (_roadsDone || _roadsLoading) return;
                if (!window.DetectLabRomanRoads) {
                    _romanStatus('roads', 'Roads: loader not loaded (js/roman-roads.js).');
                    return;
                }
                _roadsLoading = true;
                _romanStatus('roads', 'Roads: downloading…');
                var startedAt = (window.performance && performance.now) ? performance.now() : Date.now();

                _roadsLoad = window.DetectLabRomanRoads.load(ROMAN_ROADS_URL, {
                    config: window.DetectLabRomanRoads.configForDevice(),
                    onBatch: function (payload) {
                        layer.addBatch(payload);
                    },
                    onProgress: function (ev) { _roadsStatus(ev); },
                    onDone: function (stats) {
                        _roadsLoading = false;
                        _roadsDone = true;
                        var segs = (stats && stats.segments) || layer.getStats().segments;
                        var elapsed = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - startedAt);
                        if (segs) {
                            _romanStatus('roads', 'Roads: ' + segs.toLocaleString() + ' segments loaded.');
                            console.info('[Roman] roads ready: ' + segs.toLocaleString() + ' segments, ' +
                                (layer.getStats().vertices || 0).toLocaleString() + ' vertices, ' +
                                _roadsMb(layer.getStats().bytes) + ' geometry in ' + (elapsed / 1000).toFixed(1) + 's' +
                                (stats && stats.sampled ? ' (' + stats.sampled.toLocaleString() + ' segment(s) sampled out to fit the memory budget)' : ''));
                        } else {
                            _romanStatus('roads', 'Roads: no geometry recognised in ' + ((stats && stats.seen) || 0) + ' lines.');
                        }
                    },
                    onError: function (message) {
                        _roadsLoading = false;
                        console.warn('[Roman] roads failed:', message);
                        _romanStatus('roads', 'Roads: could not load (' + message + ').');
                    }
                });
            }

            // ── ROMAN: load helpers & public toggles ──
            function _loadSingleRomanLayer(key) {
                var cfg = ROMAN_SUB_LAYERS[key];
                if (!cfg) return;
                if (cfg.dare) {
                    var dl = _romanLayers[key];
                    if (dl && _romanEnabled[key] && _romanVisible && !_romanGroup.hasLayer(dl)) _romanGroup.addLayer(dl);
                    _loadDynamicDareSites();
                    return;
                }
                if (cfg.type === 'ndjson') { _loadRomanRoads(); return; }
                if (cfg.type === 'pleiades') { _loadRomanPleiades(); return; }
                if (_romanLayers[key]) {
                    if (_romanEnabled[key] && _romanVisible && !_romanGroup.hasLayer(_romanLayers[key])) {
                        _romanGroup.addLayer(_romanLayers[key]);
                    }
                    return;
                }
                if (!cfg.url) return;
                if (_romanLoading[key]) return;
                if (_romanCache[cfg.url]) {
                    var cached = _romanCache[cfg.url];
                    var lyrCached = _buildRomanLeafletLayer(key, cfg, cached);
                    if (lyrCached) {
                        _romanLayers[key] = lyrCached;
                        if (_romanEnabled[key] && _romanVisible) _romanGroup.addLayer(lyrCached);
                    }
                    return;
                }
                _romanLoading[key] = true;
                fetch(cfg.url)
                    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                    .then(function(data) {
                        _romanCache[cfg.url] = data;
                        if (!_romanVisible || !_romanEnabled[key]) return;
                        var lyr2 = _buildRomanLeafletLayer(key, cfg, data);
                        if (lyr2) {
                            _romanLayers[key] = lyr2;
                            _romanGroup.addLayer(lyr2);
                        }
                    })
                    .catch(function(e){ console.warn('[Roman] Failed to load ' + key + ':', e.message); })
                    .finally(function(){ _romanLoading[key]=false; });
            }

            function _loadRomanData() {
                if (!_romanVisible) return;
                Object.keys(ROMAN_SUB_LAYERS).forEach(function(key){
                    if (!_romanEnabled[key]) return;
                    _loadSingleRomanLayer(key);
                });
            }

            window.toggleRomanLayer = function(on) {
                _romanVisible = !!on;
                var toggleEl = document.getElementById('romanToggle');
                if (toggleEl) toggleEl.checked = _romanVisible;
                if (_romanVisible) {
                    _romanGroup.addTo(map);
                    _loadRomanData();
                } else {
                    map.removeLayer(_romanGroup);
                    _clearDareSites();
                    _romanStatus('dare', '');
                    _romanStatus('roads', '');
                    _romanStatus('places', '');
                }
            };

            window.toggleRomanSub = function(key, on) {
                if (!(key in ROMAN_SUB_LAYERS)) {
                    console.warn('[Roman] Unknown sub-layer key:', key);
                    return;
                }
                _romanEnabled[key] = !!on;
                var cbId = 'roman_' + key;
                var cb = document.getElementById(cbId);
                if (cb) cb.checked = !!on;
                if (!on) {
                    var lyr = _romanLayers[key];
                    if (lyr && _romanGroup.hasLayer(lyr)) {
                        _romanGroup.removeLayer(lyr);
                    }
                    if (key.indexOf('dare_') === 0 && !_dareAnyEnabled()) _romanStatus('dare', '');
                    return;
                }
                if (!_romanVisible) {
                    var masterToggle = document.getElementById('romanToggle');
                    if (masterToggle) masterToggle.checked = true;
                    window.toggleRomanLayer(true);
                    return;
                }
                _loadSingleRomanLayer(key);
            };

            window.toggleRomanSubLayers = function() {
                var container = document.getElementById('romanSubLayers');
                var icon = document.getElementById('romanExpandIcon');
                var btn = document.getElementById('romanExpandBtn');
                if (!container) return;
                window._romanSubExpanded = !window._romanSubExpanded;
                if (window._romanSubExpanded) {
                    setSubLayersMaxHeight(container, true, 1200);
                    container.style.opacity = '1';
                    container.style.marginTop = '10px';
                    if (icon) icon.style.transform = 'rotate(0deg)';
                    if (btn) btn.style.color = '#E8772A';
                } else {
                    setSubLayersMaxHeight(container, false);
                    container.style.opacity = '0';
                    container.style.marginTop = '0';
                    if (icon) icon.style.transform = 'rotate(-90deg)';
                    if (btn) btn.style.color = 'rgba(232,119,42,0.8)';
                }
                setTimeout(function() {
                    if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                }, 350);
            };

            window.setRomanOpacity = function(val) {
                _romanOpacity = val / 100;
                document.getElementById('romanPct').textContent = val + '%';
                // Update opacity on all active layers
                Object.keys(_romanLayers).forEach(function(key) {
                    var lyr = _romanLayers[key];
                    if (!lyr) return;
                    if (lyr.setOpacity) { lyr.setOpacity(_romanOpacity); } // WMS
                    if (lyr.eachLayer) {
                        lyr.eachLayer(function(sub) {
                            if (sub.setStyle) sub.setStyle({ opacity: _romanOpacity, fillOpacity: _romanOpacity * 0.18 });
                            if (sub.setOpacity && !sub.setStyle) sub.setOpacity(_romanOpacity);
                        });
                    } else if (lyr.setStyle) {
                        lyr.setStyle({ opacity: _romanOpacity, fillOpacity: _romanOpacity * 0.18 });
                    }
                });
                var toggle = document.getElementById('romanToggle');
                if (toggle) toggle.checked = (val > 0);
                if (val > 0 && !_romanVisible) window.toggleRomanLayer(true);
            };

            // Reload on pan/zoom when layer is active
            map.on('moveend', function() {
                if (_romanVisible) _loadRomanData();
            });

            // ── LIDAR LAYER SYSTEM ──
            map.createPane('pane_lidar');
            map.getPane('pane_lidar').style.zIndex = 610;
            map.getPane('pane_lidar').style.pointerEvents = 'none';

            var _lidarVisible = false;

            // Public geodata services used by the free LiDAR catalogue. Each
            // country keeps its own service endpoint and layer name, but they
            // all share the same Leaflet group and opacity controls below.
            // AHN6 is published as a dynamic ArcGIS ImageServer in the
            // Dutch national RD New projection (EPSG:28992), not as a tiled
            // WMS. The layer builder below requests Web-Mercator exportImage
            // tiles from this service so it lines up with Leaflet's map.
            // The products, rendering rules, zoom window and opacity now live
            // in the CONFIG block of js/ahn-layer.js. This constant is kept so
            // external callers keep resolving, but the layer is built by the
            // module: the old URL was requested *without* the /exportImage
            // operation (200 text/html → blank tile) and AHN6 alone has only
            // partial national coverage.
            var NETHERLANDS_LIDAR_IMAGE_SERVER_URL =
                'https://ahn.arcgisonline.nl/arcgis/rest/services/Hoogtebestand/AHN6_DSM_50cm/ImageServer';
            var NETHERLANDS_LIDAR_MODES = (window.AhnLidar && window.AhnLidar.MODES) || {};
            var NETHERLANDS_LIDAR_DEFAULT_MODE =
                (window.AhnLidar && window.AhnLidar.CONFIG.DEFAULT_MODE) || 'dtm';
            // Norway: Kartverket's national LiDAR terrain models, served as
            // dynamic ArcGIS ImageServers by hoydedata.no. The configuration
            // (service names, rendering rules, zoom window, opacity) lives in
            // the CONFIG block of js/hoydedata-layer.js.
            //
            // This replaces the former Geonorge WMS
            // (wms.hoyde-hoydedata-metadata-prosjekt): its layers are *per
            // survey project*, so outside the one selected project the server
            // answered 200 with a fully transparent PNG and the map looked
            // empty everywhere.
            var NORWAY_LIDAR_IMAGE_SERVER_HOST =
                (window.Hoydedata && window.Hoydedata.CONFIG.HOST) ||
                'https://hoydedata.no/arcgis/rest/services';
            // Poland: terrain SHADING from the GUGiK ISOK/NMT services
            // (js/geoportal-nmt-layer.js holds the CONFIG block).
            //
            // The two "Skorowidze" WMS endpoints that used to back this row
            // publish the INDEX SHEETS of the LiDAR measurement data — survey
            // metadata, not imagery — which is why the tiles came back 200 and
            // empty. They are kept below only as a reference to the catalogue
            // (the WFS twins), never as a display layer.
            var POLAND_NMT_WMS_BASE =
                (window.GeoportalNMT && window.GeoportalNMT.CONFIG.WMS_BASE) ||
                'https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WMS/';
            var POLAND_LIDAR_KRON86_WMS_URL =
                'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomNMT/WMS/SkorowidzeWUkladzieKRON86';
            var POLAND_LIDAR_EVRF2007_WMS_URL =
                'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomNMT/WMS/SkorowidzeWUkladzieEVRF2007';
            // The WFS endpoints publish the same year indexes as vector
            // footprints. Keep them alongside the WMS display services so a
            // future download/feature-info action can reuse the supplied
            // catalog without another source-definition change.
            var POLAND_LIDAR_KRON86_WFS_URL =
                'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomiaroweLidarKRON86/WFS/Skorowidze';
            var POLAND_LIDAR_EVRF2007_WFS_URL =
                'https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomiaroweLidarEVRF2007/WFS/Skorowidze';
            // Spain: the IDEE/IGN "Mapa LiDAR" WMS — a shaded LiDAR digital
            // surface model with vegetation/building heights and hydrography,
            // rendered per GetMap tile in EPSG:3857. Config lives in
            // js/ign-mdt-layer.js.
            var SPAIN_LIDAR_WMS_URL =
                (window.IgnMdt && window.IgnMdt.CONFIG.WMS_URL) || 'https://wms-mapa-lidar.idee.es/lidar';
            var SPAIN_LIDAR_MODES = (window.IgnMdt && window.IgnMdt.MODES) || {};
            var SPAIN_LIDAR_DEFAULT_MODE =
                (window.IgnMdt && window.IgnMdt.CONFIG.DEFAULT_MODE) || 'mapa_lidar';
            // Switzerland: swisstopo's public RESTful WMTS cache of the
            // swissALTI3D / swissSURFACE3D relief shading. Config lives in
            // js/swisstopo-relief-layer.js. The old WMS constant is kept for
            // external callers, but the row no longer requests
            // ch.swisstopo.swisssurface3d.metadata (acquisition footprints,
            // not terrain imagery).
            var SWITZERLAND_LIDAR_WMS_URL = 'https://wms.geo.admin.ch/';
            var SWITZERLAND_LIDAR_WMTS_HOST =
                (window.SwisstopoRelief && window.SwisstopoRelief.CONFIG.HOST) || 'https://wmts.geo.admin.ch';
            var SWITZERLAND_LIDAR_MODES = (window.SwisstopoRelief && window.SwisstopoRelief.MODES) || {};
            var SWITZERLAND_LIDAR_DEFAULT_MODE =
                (window.SwisstopoRelief && window.SwisstopoRelief.CONFIG.DEFAULT_MODE) || 'relief';
            // The UK row now uses the Environment Agency's cached WMTS
            // (WebMercatorQuad = standard XYZ). The old per-tile WMS endpoint
            // is kept only for external callers of window.UK_LIDAR_WMS_URL.
            var UK_LIDAR_WMS_URL =
                'https://environment.data.gov.uk/geoservices/datasets/13787b9a-26a4-4775-8523-806d13af58fc/wms';
            var UK_LIDAR_WMTS_HOST =
                (window.EaLidarWmts && window.EaLidarWmts.CONFIG.HOST) || 'https://environment.data.gov.uk';
            var UK_LIDAR_DEFAULT_MODE =
                (window.EaLidarWmts && window.EaLidarWmts.CONFIG.DEFAULT_MODE) || 'hillshade';
            // France: the endpoint and the per-product layer names are owned by
            // the shared registry (js/layer-registry.js) — the same definition
            // the 3D terrain view drapes, so the two can never drift apart.
            var FRANCE_LIDAR_WMS_URL = (DL && DL.url2d('lidar.fr-mnh')) || '';
            // Denmark now streams Danmarks Højdemodel from Dataforsyningen
            // through the site's own token-adding proxy (see
            // js/dataforsyningen-dhm-layer.js). The old Datafordeler WMS
            // constant stays for external callers only.
            var DENMARK_LIDAR_WMS_URL = 'https://wms.datafordeler.dk/DHMNedboer/dhm/1.0.0/WMS';
            var DENMARK_LIDAR_MODES = (window.DataforsyningenDHM && window.DataforsyningenDHM.MODES) || {};
            var DENMARK_LIDAR_DEFAULT_MODE =
                (window.DataforsyningenDHM && window.DataforsyningenDHM.CONFIG.DEFAULT_MODE) || 'terrain';

            // Sweden streams Lantmäteriet's terrängskuggning / terränglutning
            // through the site's own credential-adding proxy (see
            // js/lantmateriet-hojdmodell-layer.js). The service is the
            // licensed product "Markhöjdmodell Visning"; the unauthenticated
            // Min karta backend is evaluation-only and is NOT the default.
            var SWEDEN_LIDAR_WMS_URL =
                (window.LantmaterietHojdmodell && window.LantmaterietHojdmodell.CONFIG.GEOTORGET_URL) ||
                'https://maps.lantmateriet.se/hojdmodell/wms/v1.1';
            var SWEDEN_LIDAR_MODES = (window.LantmaterietHojdmodell && window.LantmaterietHojdmodell.MODES) || {};
            var SWEDEN_LIDAR_DEFAULT_MODE =
                (window.LantmaterietHojdmodell && window.LantmaterietHojdmodell.CONFIG.DEFAULT_MODE) ||
                'terrangskuggning';

            // The Norway control now switches between whole-country products
            // (bare terrain, surface, local relief) instead of 1,356 survey
            // projects, so there is no catalogue request to make at start-up.
            var NORWAY_LIDAR_MODES = (window.Hoydedata && window.Hoydedata.MODES) || {};
            var NORWAY_LIDAR_DEFAULT_MODE =
                (window.Hoydedata && window.Hoydedata.CONFIG.DEFAULT_MODE) || 'dtm';

            window.NORWAY_LIDAR_IMAGE_SERVER_HOST = NORWAY_LIDAR_IMAGE_SERVER_HOST;
            window.NORWAY_LIDAR_MODES = NORWAY_LIDAR_MODES;
            window.NETHERLANDS_LIDAR_IMAGE_SERVER_URL = NETHERLANDS_LIDAR_IMAGE_SERVER_URL;
            window.NETHERLANDS_LIDAR_MODES = NETHERLANDS_LIDAR_MODES;
            window.POLAND_LIDAR_KRON86_WMS_URL = POLAND_LIDAR_KRON86_WMS_URL;
            window.POLAND_LIDAR_EVRF2007_WMS_URL = POLAND_LIDAR_EVRF2007_WMS_URL;
            window.POLAND_LIDAR_KRON86_WFS_URL = POLAND_LIDAR_KRON86_WFS_URL;
            window.POLAND_LIDAR_EVRF2007_WFS_URL = POLAND_LIDAR_EVRF2007_WFS_URL;
            window.SPAIN_LIDAR_WMS_URL = SPAIN_LIDAR_WMS_URL;
            window.SPAIN_LIDAR_MODES = SPAIN_LIDAR_MODES;
            window.SWITZERLAND_LIDAR_WMS_URL = SWITZERLAND_LIDAR_WMS_URL;
            window.SWITZERLAND_LIDAR_WMTS_HOST = SWITZERLAND_LIDAR_WMTS_HOST;
            window.SWITZERLAND_LIDAR_MODES = SWITZERLAND_LIDAR_MODES;
            window.UK_LIDAR_WMS_URL = UK_LIDAR_WMS_URL;
            window.UK_LIDAR_WMTS_HOST = UK_LIDAR_WMTS_HOST;
            window.UK_LIDAR_MODES = UK_LIDAR_MODES;
            window.FRANCE_LIDAR_WMS_URL = FRANCE_LIDAR_WMS_URL;
            window.DENMARK_LIDAR_WMS_URL = DENMARK_LIDAR_WMS_URL;
            window.DENMARK_LIDAR_MODES = DENMARK_LIDAR_MODES;
            window.SWEDEN_LIDAR_WMS_URL = SWEDEN_LIDAR_WMS_URL;
            window.SWEDEN_LIDAR_MODES = SWEDEN_LIDAR_MODES;

            // The WMS services use different layer catalogues, so the select
            // controls below swap a complete layer instead of stacking several
            // incompatible rasters on top of each other.
            var POLAND_LIDAR_MODES = (window.GeoportalNMT && window.GeoportalNMT.MODES) || {};
            var POLAND_LIDAR_DEFAULT_MODE =
                (window.GeoportalNMT && window.GeoportalNMT.CONFIG.DEFAULT_MODE) || 'cieniowanie';
            window.POLAND_NMT_WMS_BASE = POLAND_NMT_WMS_BASE;
            window.POLAND_LIDAR_MODES = POLAND_LIDAR_MODES;

            var FRANCE_LIDAR_MODES = (DL && DL.modes && DL.modes('lidar.fr-mnh')) || {};
            // England: layer identifiers, zoom caps and extents all come from
            // the live GetCapabilities (see js/ea-lidar-wmts-layer.js).
            var UK_LIDAR_MODES = (window.EaLidarWmts && window.EaLidarWmts.MODES) || {};

            function _lidarWmsOptions(extra) {
                var options = extra || {};
                if (options.updateWhenZooming === undefined) options.updateWhenZooming = false;
                if (options.updateWhenIdle === undefined) options.updateWhenIdle = true;
                if (options.keepBuffer === undefined) {
                    options.keepBuffer = (window.DLTilePerf && window.DLTilePerf.config)
                        ? window.DLTilePerf.config.keepBuffer : 1;
                }
                options.pane = 'pane_lidar';
                options.maxZoom = 20;
                return options;
            }

            function _createFreeLidarWmsLayer(url, layers, cfg) {
                cfg = cfg || {};
                var options = _lidarWmsOptions({
                    layers: layers,
                    format: cfg.format || 'image/png',
                    transparent: cfg.transparent !== false,
                    version: cfg.version || '1.3.0',
                    styles: cfg.styles || '',
                    opacity: cfg.opacity,
                    attribution: cfg.attribution || '© LIDAR',
                    crs: L.CRS.EPSG3857
                });
                if (cfg.crossOrigin) options.crossOrigin = cfg.crossOrigin;
                if (cfg.serverType) options.serverType = cfg.serverType;
                if (cfg.minZoom !== undefined) options.minZoom = cfg.minZoom;
                if (cfg.maxNativeZoom !== undefined) options.maxNativeZoom = cfg.maxNativeZoom;
                return L.tileLayer.wms(url, options);
            }

            // Norway · hoydedata.no ImageServer (js/hoydedata-layer.js).
            // One exportImage request per Leaflet tile, EPSG:3857 in and out,
            // reprojected on the fly by the server from its native EPSG:25833.
            function createNorwayLidarLayer(cfg) {
                if (!window.Hoydedata) {
                    console.warn('[DetectLab] hoydedata-layer.js is not loaded — Norway LiDAR unavailable');
                    return null;
                }
                var modeKey = (cfg && cfg.mode) || NORWAY_LIDAR_DEFAULT_MODE;
                return window.Hoydedata.createLayer({
                    mode: modeKey,
                    pane: 'pane_lidar',
                    opacity: (cfg && cfg.opacity !== undefined)
                        ? cfg.opacity
                        : window.Hoydedata.CONFIG.OPACITY,
                    keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                        ? window.DLTilePerf.config.keepBuffer
                        : window.Hoydedata.CONFIG.KEEP_BUFFER
                });
            }
            window.createNorwayLidarLayer = createNorwayLidarLayer;

            function _populateNorwayModeSelect() {
                var select = document.getElementById('norwayLidarRegionSelect');
                if (!select || !window.Hoydedata) return;
                var current = select.value;
                select.innerHTML = '';
                window.Hoydedata.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = NORWAY_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.noLidar;
                select.value = (current && NORWAY_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || NORWAY_LIDAR_DEFAULT_MODE);
            }

            // DTM ⇄ DSM ⇄ local relief. The layer object is reused: only the
            // service name inside the exportImage URL changes, so Leaflet just
            // redraws the tiles that are already on screen.
            window.setNorwayLidarMode = function (modeKey) {
                var cfg = LIDAR_SUB_LAYERS.noLidar;
                if (!cfg || !NORWAY_LIDAR_MODES[modeKey]) return;
                cfg.mode = modeKey;
                if (cfg.leafletLayer && cfg.leafletLayer.setMode) {
                    cfg.leafletLayer.setMode(modeKey);
                }
            };
            // Backwards-compatible alias (the control used to pick a project).
            window.setNorwayLidarRegion = window.setNorwayLidarMode;

            // Click → "Elevation: N m", straight from the ImageServer identify
            // operation. Verified CORS-safe: hoydedata.no reflects the request
            // Origin, so a plain fetch() works with no proxy. The handler is
            // attached only while the Norway layer is actually on the map, and
            // ignores the click that ends a pan.
            var _norwayIdentifyPopup = null;
            function _norwayIdentifyClick(e) {
                var cfg = LIDAR_SUB_LAYERS.noLidar;
                if (!cfg || !window.Hoydedata || !window.Hoydedata.CONFIG.IDENTIFY.ENABLED) return;
                if (!cfg.leafletLayer || !_lidarGroup.hasLayer(cfg.leafletLayer)) return;
                if (typeof map._draggableMoved === 'function' && map._draggableMoved(map)) return;
                if (map.getZoom() < window.Hoydedata.CONFIG.MIN_ZOOM) return;
                var bounds = cfg.leafletLayer.options.bounds;
                if (bounds && !bounds.contains(e.latlng)) return;

                _norwayIdentifyPopup = L.popup({ className: 'hoydedata-identify-popup' })
                    .setLatLng(e.latlng)
                    .setContent('…')
                    .openOn(map);
                var popup = _norwayIdentifyPopup;
                window.Hoydedata.identify(e.latlng, cfg.mode).then(function (result) {
                    if (popup !== _norwayIdentifyPopup) return;
                    popup.setContent(window.Hoydedata.formatIdentify(result));
                }).catch(function () {
                    if (popup !== _norwayIdentifyPopup) return;
                    popup.setContent('Elevation unavailable');
                });
            }
            function _setNorwayIdentifyEnabled(on) {
                map.off('click', _norwayIdentifyClick);
                if (on) map.on('click', _norwayIdentifyClick);
                if (!on && _norwayIdentifyPopup) {
                    map.closePopup(_norwayIdentifyPopup);
                    _norwayIdentifyPopup = null;
                }
            }
            window._setNorwayIdentifyEnabled = _setNorwayIdentifyEnabled;

            // Sub-layer definitions
            var LIDAR_SUB_LAYERS = {
                hd: {
                    label: 'HD',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/Q2Kmg0bQDn3rySgn/arcgis/rest/services/HD_MDH_tif/MapServer/tile/{z}/{y}/{x}',
                    leafletLayer: null
                },
                ar: {
                    label: 'AR',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/Q2Kmg0bQDn3rySgn/arcgis/rest/services/AR_MDH_tif/MapServer/tile/{z}/{y}/{x}',
                    leafletLayer: null
                },
                ab: {
                    label: 'AB',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/Q2Kmg0bQDn3rySgn/arcgis/rest/services/AB_MDH_tif/MapServer/tile/{z}/{y}/{x}',
                    leafletLayer: null
                },
                bh: {
                    label: 'BH',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/Q2Kmg0bQDn3rySgn/arcgis/rest/services/BH_MDH_tif/MapServer/tile/{z}/{y}/{x}',
                    leafletLayer: null
                },
                cs: {
                    label: 'CS',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/Q2Kmg0bQDn3rySgn/arcgis/rest/services/CS_MDH_tif/MapServer/tile/{z}/{y}/{x}',
                    leafletLayer: null
                },
                ro2m: {
                    label: 'Romania 2-5m/pixel',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/Ro2m/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 16,
                    className: 'lidar-ro2m-tiles',
                    leafletLayer: null
                },
                ro1m: {
                    label: 'Romania 1m/pixel agregare',
                    enabled: false,
                    opacity: 0,
                    type: 'xyz',
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/1m/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 16,
                    className: 'lidar-ro1m-tiles',
                    leafletLayer: null
                },
                cs917: {
                    label: 'CS - LAKI III',
                    enabled: false,
                    opacity: 0,
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/CS_917/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 17,
                    minZoom: 9,
                    leafletLayer: null
                },
                dj917: {
                    label: 'DJ - LAKI III',
                    enabled: false,
                    opacity: 0,
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/DJ/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 17,
                    minZoom: 9,
                    leafletLayer: null
                },
                gj917: {
                    label: 'GJ - LAKI III',
                    enabled: false,
                    opacity: 0,
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/GJ_917/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 17,
                    minZoom: 9,
                    leafletLayer: null
                },
                mh917: {
                    label: 'MH - LAKI III',
                    enabled: false,
                    opacity: 0,
                    url: 'https://tiles.arcgis.com/tiles/wCvLzGFkz06gCfBg/arcgis/rest/services/MH/MapServer/tile/{z}/{y}/{x}',
                    maxNativeZoom: 17,
                    minZoom: 9,
                    leafletLayer: null
                },

                // ── Free European LiDAR catalogue ──────────────────────────
                // These entries deliberately live in the same LIDAR master
                // switch as the original Romania coverage. They are lazy: a
                // remote layer is not constructed until its opacity is raised
                // or its country switch is turned on.
                nlAhn: {
                    // AHN terrain relief through js/ahn-layer.js: one
                    // /exportImage request per Leaflet tile, AHN4 by default
                    // (the only campaign with complete national coverage).
                    label: 'Netherlands · AHN relief (0.5 m)', enabled: false,
                    opacity: (window.AhnLidar && window.AhnLidar.CONFIG.OPACITY) || 0.8,
                    factory: 'netherlands', mode: NETHERLANDS_LIDAR_DEFAULT_MODE,
                    attribution: (window.AhnLidar && window.AhnLidar.CONFIG.ATTRIBUTION) ||
                        'AHN hillshade © AHN / Esri Nederland (CC BY 4.0)',
                    leafletLayer: null
                },
                noLidar: {
                    // Whole-country Kartverket LiDAR via hoydedata.no. Zoom
                    // window, opacity and service names come from the CONFIG
                    // block of js/hoydedata-layer.js.
                    label: 'Norway · Kartverket', enabled: false,
                    opacity: (window.Hoydedata && window.Hoydedata.CONFIG.OPACITY) || 0.7,
                    factory: 'norway', mode: NORWAY_LIDAR_DEFAULT_MODE,
                    attribution: (window.Hoydedata && window.Hoydedata.CONFIG.ATTRIBUTION) ||
                        'Hillshade © Kartverket (CC BY 4.0)',
                    leafletLayer: null
                },
                plLidar: {
                    // Terrain shading (ISOK/NMT 1 m), not the survey index sheets.
                    label: 'Poland · GUGiK NMT shading', enabled: false,
                    opacity: (window.GeoportalNMT && window.GeoportalNMT.CONFIG.OPACITY) || 0.7,
                    factory: 'poland', mode: POLAND_LIDAR_DEFAULT_MODE,
                    attribution: (window.GeoportalNMT && window.GeoportalNMT.CONFIG.ATTRIBUTION) ||
                        'Cieniowanie: © GUGiK / Geoportal.gov.pl (dane ISOK/NMT)',
                    leafletLayer: null
                },
                esLidar: {
                    // IDEE/IGN "Mapa LiDAR" WMS (layer EL.GridCoverage): a
                    // shaded LiDAR surface model rendered per GetMap tile in
                    // EPSG:3857 — see js/ign-mdt-layer.js.
                    label: 'Spain · IGN relief (PNOA-LiDAR MDT)', enabled: false,
                    opacity: (window.IgnMdt && window.IgnMdt.CONFIG.OPACITY) || 0.7,
                    factory: 'spain', mode: SPAIN_LIDAR_DEFAULT_MODE,
                    attribution: (window.IgnMdt && window.IgnMdt.CONFIG.ATTRIBUTION) ||
                        'Mapa LiDAR © IDEE / Instituto Geográfico Nacional (IGN/CNIG) — CC BY 4.0',
                    leafletLayer: null
                },
                chLidar: {
                    // swisstopo WMTS relief of swissALTI3D (LiDAR DTM). The
                    // "3857" matrix set is the standard XYZ grid, so this is a
                    // plain tile layer — see js/swisstopo-relief-layer.js.
                    label: 'Switzerland · swisstopo relief (swissALTI3D)', enabled: false,
                    opacity: (window.SwisstopoRelief && window.SwisstopoRelief.CONFIG.OPACITY) || 0.7,
                    factory: 'switzerland', mode: SWITZERLAND_LIDAR_DEFAULT_MODE,
                    attribution: (window.SwisstopoRelief && window.SwisstopoRelief.CONFIG.ATTRIBUTION) ||
                        '© swisstopo',
                    leafletLayer: null
                },
                ukLidar: {
                    label: 'England · EA LIDAR Composite hillshade (DTM 1 m)', enabled: false,
                    opacity: (window.EaLidarWmts && window.EaLidarWmts.CONFIG.OPACITY) || 0.7,
                    factory: 'uk', mode: UK_LIDAR_DEFAULT_MODE,
                    attribution: (window.EaLidarWmts && window.EaLidarWmts.CONFIG.ATTRIBUTION) ||
                        '© Environment Agency copyright and/or database right 2022',
                    leafletLayer: null
                },
                frLidar: {
                    label: 'France · LiDAR HD', enabled: false, opacity: 0.8,
                    factory: 'france', mode: 'terrain', attribution: '© IGN France — LiDAR HD.', leafletLayer: null
                },
                dkLidar: {
                    label: 'Denmark · DHM hillshade (Dataforsyningen WMTS)', enabled: false,
                    opacity: (window.DataforsyningenDHM && window.DataforsyningenDHM.CONFIG.OPACITY) || 0.6,
                    factory: 'denmark', mode: DENMARK_LIDAR_DEFAULT_MODE,
                    attribution: (window.DataforsyningenDHM && window.DataforsyningenDHM.CONFIG.ATTRIBUTION) ||
                        'Indeholder data fra Klimadatastyrelsen, Danmarks Højdemodel (CC BY 4.0)',
                    leafletLayer: null
                },
                seLidar: {
                    label: 'Sweden · Terrängskuggning (Lantmäteriet höjdmodell)', enabled: false,
                    opacity: (window.LantmaterietHojdmodell && window.LantmaterietHojdmodell.CONFIG.OPACITY) || 0.7,
                    factory: 'sweden', mode: SWEDEN_LIDAR_DEFAULT_MODE,
                    attribution: (window.LantmaterietHojdmodell && window.LantmaterietHojdmodell.CONFIG.ATTRIBUTION) ||
                        'Terrängskuggning © Lantmäteriet',
                    leafletLayer: null
                }
            };

            var LIDAR_COUNTRY_TOGGLE_IDS = {
                nlAhn: 'lidarNlAhnToggle', noLidar: 'lidarNoLidarToggle',
                plLidar: 'lidarPlLidarToggle', esLidar: 'lidarEsLidarToggle',
                chLidar: 'lidarChLidarToggle', ukLidar: 'lidarUkLidarToggle',
                frLidar: 'lidarFrLidarToggle', dkLidar: 'lidarDkLidarToggle',
                seLidar: 'lidarSeLidarToggle'
            };

            function _createSelectableEuropeanLidarLayer(cfg) {
                var mode;
                if (cfg.factory === 'poland') {
                    // GUGiK ISOK/NMT shading — one WMS GetMap per Leaflet tile
                    // in EPSG:3857, no token, bounded to Poland.
                    if (!window.GeoportalNMT) {
                        console.warn('[DetectLab] geoportal-nmt-layer.js is not loaded — Poland LiDAR unavailable');
                        return null;
                    }
                    return window.GeoportalNMT.createLayer({
                        mode: cfg.mode || POLAND_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.GeoportalNMT.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.GeoportalNMT.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'netherlands') {
                    // AHN ImageServers, no key, clipped to the Netherlands.
                    if (!window.AhnLidar) {
                        console.warn('[DetectLab] ahn-layer.js is not loaded — Netherlands LiDAR unavailable');
                        return null;
                    }
                    return window.AhnLidar.createLayer({
                        mode: cfg.mode || NETHERLANDS_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.AhnLidar.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.AhnLidar.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'switzerland') {
                    // swisstopo WMTS, no key, clipped to the published extent
                    // and capped at each product's own maximum zoom.
                    if (!window.SwisstopoRelief) {
                        console.warn('[DetectLab] swisstopo-relief-layer.js is not loaded — Switzerland LiDAR unavailable');
                        return null;
                    }
                    return window.SwisstopoRelief.createLayer({
                        mode: cfg.mode || SWITZERLAND_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.SwisstopoRelief.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.SwisstopoRelief.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'spain') {
                    // IDEE/IGN "Mapa LiDAR" WMS (no key, no token): one GetMap
                    // per Leaflet tile in EPSG:3857, clipped to the coverage
                    // the capabilities declare.
                    if (!window.IgnMdt) {
                        console.warn('[DetectLab] ign-mdt-layer.js is not loaded — Spain LiDAR unavailable');
                        return null;
                    }
                    return window.IgnMdt.createLayer({
                        mode: cfg.mode || SPAIN_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.IgnMdt.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.IgnMdt.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'uk') {
                    // Environment Agency WMTS (no key, no token), clipped to
                    // the published England extent and capped at the service's
                    // real maximum zoom.
                    if (!window.EaLidarWmts) {
                        console.warn('[DetectLab] ea-lidar-wmts-layer.js is not loaded — UK LiDAR unavailable');
                        return null;
                    }
                    return window.EaLidarWmts.createLayer({
                        mode: cfg.mode || UK_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.EaLidarWmts.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.EaLidarWmts.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'france') {
                    mode = FRANCE_LIDAR_MODES[cfg.mode] || FRANCE_LIDAR_MODES.terrain;
                    if (!mode || !FRANCE_LIDAR_WMS_URL) {
                        console.warn('[DetectLab] France LiDAR unavailable — the shared layer registry did not load');
                        return null;
                    }
                    return _createFreeLidarWmsLayer(FRANCE_LIDAR_WMS_URL, mode.layer || mode.layers, {
                        opacity: cfg.opacity,
                        attribution: cfg.attribution
                    });
                }
                if (cfg.factory === 'denmark') {
                    // Dataforsyningen WMS in EPSG:3857, clipped to Denmark.
                    // Dataforsyningen's DHM skyggekort WMTS. Its only grid,
                    // View1, is EPSG:25832 (ETRS89 / UTM 32N), so the layer
                    // reprojects each tile onto a canvas rather than putting
                    // the whole map into a Danish CRS — OSM and the other
                    // national LiDAR layers keep lining up.
                    // The token is NEVER in this file: tiles go through the
                    // site's own /api/geo/dk-dhm proxy, which adds it
                    // server-side (backend/src/routes/geoProxy.js, or
                    // netlify/functions/dk-dhm.mjs). A static deployment with
                    // no backend can set window.DETECTLAB_DK_TOKEN instead —
                    // insecure, see DENMARK_LIDAR_DATAFORSYNINGEN.md.
                    if (!window.DataforsyningenDHM) {
                        console.warn('[DetectLab] dataforsyningen-dhm-layer.js is not loaded — Denmark LiDAR unavailable');
                        return null;
                    }
                    return window.DataforsyningenDHM.createLayer({
                        mode: cfg.mode || DENMARK_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.DataforsyningenDHM.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.DataforsyningenDHM.CONFIG.KEEP_BUFFER
                    });
                }
                if (cfg.factory === 'sweden') {
                    // Lantmäteriet's height-model WMS in EPSG:3857, clipped to
                    // Sweden. The Geotorget credentials are NEVER in this file:
                    // tiles go through the site's own /api/geo/se-hojdmodell
                    // proxy, which adds the Authorization header server-side
                    // (backend/src/routes/geoProxy.js, or the Netlify twin in
                    // netlify/functions/se-hojdmodell.mjs). For a local look
                    // without an agreement, set
                    // window.DETECTLAB_SE_WMS_SOURCE = 'minkarta' — evaluation
                    // only, see SWEDEN_LIDAR_LANTMATERIET.md.
                    if (!window.LantmaterietHojdmodell) {
                        console.warn('[DetectLab] lantmateriet-hojdmodell-layer.js is not loaded — Sweden LiDAR unavailable');
                        return null;
                    }
                    return window.LantmaterietHojdmodell.createLayer({
                        mode: cfg.mode || SWEDEN_LIDAR_DEFAULT_MODE,
                        pane: 'pane_lidar',
                        opacity: (cfg.opacity !== undefined)
                            ? cfg.opacity
                            : window.LantmaterietHojdmodell.CONFIG.OPACITY,
                        keepBuffer: (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : window.LantmaterietHojdmodell.CONFIG.KEEP_BUFFER
                    });
                }
                return null;
            }

            /* Registry id per master-switch key: the 3D view needs a name for
             * these layers, and a canvas layer that builds its URLs inside
             * createTile() carries no URL to recognise it by. */
            var LIDAR_DEF_IDS = {
                nlAhn: 'lidar.nl-ahn', noLidar: 'lidar.no-hoydedata',
                plLidar: 'lidar.pl-nmt', esLidar: 'lidar.es-mdt',
                chLidar: 'lidar.ch-swisstopo', ukLidar: 'lidar.uk-ea',
                frLidar: 'lidar.fr-mnh', dkLidar: 'lidar.dk-dhm',
                seLidar: 'lidar.se-lantmateriet'
            };
            function _buildLidarLeafletLayer(key, cfg) {
                var lidarLayer = _buildLidarLeafletLayerRaw(key, cfg);
                /* Tag only — the 2D behaviour of the layer is untouched. */
                if (lidarLayer && key) {
                    if (LIDAR_DEF_IDS[key]) lidarLayer._dlDefId = LIDAR_DEF_IDS[key];
                    /* LiDAR family + human name, for the 3D focus (js/lidar-3d-focus.js)
                     * and for the mirror (js/map3d-mirror.js → item.lidarKey): the 3D
                     * view drapes ONE LiDAR layer at a time, over one prepared disc of
                     * 1 km radius, and it has to be able to name the layers it
                     * may choose from. Nothing here changes how the layer draws. */
                    lidarLayer._dlLidar = { key: 'lidar.' + key, label: (cfg && cfg.label) || key };
                }
                return lidarLayer;
            }
            function _buildLidarLeafletLayerRaw(key, cfg) {
                // ── Gesture-safe tile options for the LIDAR stack ──
                // LIDAR sub-layers are dense (HD/AR/AB/BH/CS + "Romania 1m" +
                // "Romania 2–5m" + the four LAKI III sheets) and are routinely
                // stacked on top of the basemap, CORONA and the historical
                // maps. With Leaflet's defaults every one of them re-queued
                // tiles on every frame of a pinch/scroll zoom, which is what
                // made the page crash on sudden zoom. These options are the
                // same ones the Sat60 fix uses; js/tile-perf.js applies the
                // governor to every other tile layer of the app as well.
                function _lidarPerfOptions(extra) {
                    var o = extra || {};
                    if (o.updateWhenZooming === undefined) o.updateWhenZooming = false;
                    if (o.updateWhenIdle === undefined) o.updateWhenIdle = true;
                    if (o.keepBuffer === undefined) {
                        o.keepBuffer = (window.DLTilePerf && window.DLTilePerf.config)
                            ? window.DLTilePerf.config.keepBuffer
                            : 1;
                    }
                    return o;
                }

                // ArcGIS ImageServer layers are dynamic (AHN6 is not a
                // Single Fused Map Cache), so they cannot use Leaflet's
                // ordinary {z}/{x}/{y} tile URL expansion. Render one
                // Web-Mercator exportImage request per Leaflet tile instead.
                function _createArcGisImageServerLayer(imageServerUrl, imageCfg) {
                    var ImageServerGridLayer = L.GridLayer.extend({
                        options: {
                            tileSize: 256,
                            updateWhenZooming: false,
                            updateWhenIdle: true,
                            keepBuffer: 1,
                            maxZoom: 20,
                            maxNativeZoom: 18,
                            minZoom: 0,
                            opacity: 1,
                            pane: 'pane_lidar',
                            noWrap: true
                        },

                        createTile: function (coords, done) {
                            var tile = L.DomUtil.create('img', 'leaflet-tile');
                            var size = this.getTileSize();
                            var finished = false;
                            var finish = function (error) {
                                if (finished) return;
                                finished = true;
                                done(error, tile);
                            };

                            tile.alt = '';
                            tile.setAttribute('role', 'presentation');
                            tile.width = size.x;
                            tile.height = size.y;
                            if (imageCfg.crossOrigin) tile.crossOrigin = imageCfg.crossOrigin;
                            tile.onload = function () { finish(null); };
                            tile.onerror = function (error) { finish(error || new Error('AHN6 ImageServer tile failed')); };
                            tile.src = this._exportImageUrl(coords);
                            return tile;
                        },

                        onAdd: function (map) {
                            L.GridLayer.prototype.onAdd.call(this, map);
                            this.setOpacity(this.options.opacity);
                        },

                        _exportImageUrl: function (coords) {
                            var size = this.getTileSize();
                            var nw = this._map.unproject(coords.multiplyBy(size), coords.z);
                            var se = this._map.unproject(coords.add([1, 1]).multiplyBy(size), coords.z);
                            var crs = this._map.options.crs || L.CRS.EPSG3857;
                            var nwProjected = crs.project(nw);
                            var seProjected = crs.project(se);
                            var params = {
                                bbox: [nwProjected.x, seProjected.y, seProjected.x, nwProjected.y].join(','),
                                bboxSR: 3857,
                                imageSR: 3857,
                                size: size.x + ',' + size.y,
                                format: 'png32',
                                transparent: true,
                                adjustAspectRatio: false,
                                interpolation: 'RSP_BilinearInterpolation',
                                f: 'image'
                            };
                            if (imageCfg.renderingRule) {
                                params.renderingRule = JSON.stringify({ rasterFunction: imageCfg.renderingRule });
                            }
                            // The /exportImage operation is mandatory: the
                            // ImageServer *root* with f=image answers 200 with
                            // text/html, which an <img> renders as nothing.
                            var operationUrl = imageServerUrl.replace(/\/+$/, '') + '/exportImage';
                            return operationUrl + L.Util.getParamString(params, operationUrl);
                        },

                        setOpacity: function (opacity) {
                            this.options.opacity = opacity;
                            if (this._container) this._container.style.opacity = opacity;
                            return this;
                        }
                    });

                    var options = _lidarPerfOptions({
                        opacity: imageCfg.opacity,
                        pane: 'pane_lidar',
                        attribution: imageCfg.attribution || '© LIDAR',
                        maxZoom: imageCfg.maxZoom !== undefined ? imageCfg.maxZoom : 20,
                        maxNativeZoom: imageCfg.maxNativeZoom !== undefined ? imageCfg.maxNativeZoom : 18,
                        minZoom: imageCfg.minZoom !== undefined ? imageCfg.minZoom : 0,
                        bounds: imageCfg.bounds ? L.latLngBounds(imageCfg.bounds) : undefined,
                        crossOrigin: imageCfg.crossOrigin
                    });
                    return new ImageServerGridLayer(options);
                }

                if (cfg.type === 'arcgis_image_server') {
                    return _createArcGisImageServerLayer(cfg.url, cfg);
                }

                if (cfg.factory === 'norway') {
                    return createNorwayLidarLayer(cfg);
                }
                if (cfg.factory) {
                    return _createSelectableEuropeanLidarLayer(cfg);
                }

                if (cfg.type === 'wms') {
                    var wmsOptions = _lidarPerfOptions({
                        layers: cfg.wmsLayers,
                        format: cfg.format || 'image/png',
                        transparent: cfg.transparent !== false,
                        version: cfg.version || '1.3.0',
                        styles: cfg.styles || '',
                        opacity: cfg.opacity,
                        pane: 'pane_lidar',
                        attribution: cfg.attribution || '© LIDAR ' + cfg.label,
                        crs: L.CRS.EPSG3857
                    });
                    if (cfg.crossOrigin) wmsOptions.crossOrigin = cfg.crossOrigin;
                    if (cfg.serverType) wmsOptions.serverType = cfg.serverType;
                    return L.tileLayer.wms(cfg.url, wmsOptions);
                }



                // WMTS via KVP (evita ORB — Leaflet trimite parametrii in query string)
                if (cfg.type === 'wms_kvp') {
                    return L.tileLayer.wms(cfg.url, _lidarPerfOptions({
                        service: 'WMTS',
                        version: '1.0.0',
                        request: 'GetTile',
                        layers: cfg.wmsLayers,
                        layer: cfg.wmsLayers,
                        style: 'default',
                        tilematrixset: 'default028mm',
                        format: 'image/png',
                        transparent: true,
                        opacity: cfg.opacity,
                        pane: 'pane_lidar',
                        attribution: '© LIDAR ' + cfg.label,
                        maxZoom: 20,
                        maxNativeZoom: cfg.maxNativeZoom !== undefined ? cfg.maxNativeZoom : 17,
                        minZoom: 9,
                        tileSize: 256,
                        crs: L.CRS.EPSG3857,
                        className: cfg.className || ''
                    }));
                }

                // default: xyz tile layer
                return L.tileLayer(cfg.url, _lidarPerfOptions({
                    opacity: cfg.opacity,
                    pane: 'pane_lidar',
                    attribution: '© LIDAR ' + cfg.label,
                    maxZoom: 20,
                    maxNativeZoom: cfg.maxNativeZoom !== undefined ? cfg.maxNativeZoom : 18,
                    minZoom: cfg.minZoom !== undefined ? cfg.minZoom : 0,
                    tileSize: 256,
                    crossOrigin: true,
                    className: cfg.className || ''
                }));
            }

            var _lidarGroup = L.layerGroup([], { pane: 'pane_lidar' });
            window._lidarGroup = _lidarGroup;

            // ── "Zoom in more" message for canvas-drawn LIDAR sources ──
            // Shown while an enabled canvas-drawn source is below its zoom gate. The
            // text comes from translations.js (key lidar_zoom_in_more), in the
            // current language, and is refreshed on zoom and on language change.
            var _lidarZoomMsgEl = null;
            function _lidarZoomGateTextFor() {
                var tr = (typeof translations !== 'undefined') ? translations : null;
                var fallback = 'Zoom in more to show this LIDAR layer';
                if (!tr) return fallback;
                var lang = (typeof window._currentLang === 'function') ? window._currentLang()
                         : ((typeof currentLang !== 'undefined') ? currentLang : 'en');
                var T = tr[lang] || tr.en;
                return (T && T.lidar_zoom_in_more) || (tr.en && tr.en.lidar_zoom_in_more) || fallback;
            }
            function _lidarZoomGateNeeded() {
                if (!_lidarVisible || _lidarCanvasZoomOpen()) return false;
                return Object.keys(LIDAR_SUB_LAYERS).some(function (key) {
                    var cfg = LIDAR_SUB_LAYERS[key];
                    return !!(cfg && cfg.enabled && cfg.leafletLayer && cfg.leafletLayer._detectlabCanvasZoomGate &&
                              _lidarGroup.hasLayer(cfg.leafletLayer));
                });
            }
            // translations.js defines window.setLang, and may load after this file.
            // The hook is therefore installed on first use rather than at startup.
            function _hookLidarZoomGateLanguage() {
                if (window._lidarZoomGateLangHooked || typeof window.setLang !== 'function') return;
                window._lidarZoomGateLangHooked = true;
                var _sl = window.setLang;
                window.setLang = function (lang) { _sl.apply(this, arguments); _updateLidarZoomGateMessage(); };
            }
            function _updateLidarZoomGateMessage() {
                _hookLidarZoomGateLanguage();
                var show = _lidarZoomGateNeeded();
                if (!_lidarZoomMsgEl) {
                    if (!show) return;
                    _lidarZoomMsgEl = document.createElement('div');
                    _lidarZoomMsgEl.id = 'lidarZoomGateMsg';
                    _lidarZoomMsgEl.setAttribute('role', 'status');
                    _lidarZoomMsgEl.style.cssText = [
                        'position:absolute', 'bottom:60px', 'left:50%',
                        'transform:translateX(-50%)',
                        'background:rgba(6,14,30,0.82)',
                        'color:rgba(200,169,110,0.98)',
                        'border:1px solid rgba(200,169,110,0.4)',
                        'border-radius:6px', 'padding:7px 16px',
                        'font-family:Outfit,sans-serif', 'font-size:0.82rem',
                        'font-weight:500', 'letter-spacing:0.02em',
                        'pointer-events:none', 'z-index:800',
                        'backdrop-filter:blur(6px)', 'display:none',
                        'white-space:nowrap'
                    ].join(';');
                    var mapEl = document.getElementById('detectlab-map');
                    if (mapEl) mapEl.appendChild(_lidarZoomMsgEl);
                }
                _lidarZoomMsgEl.textContent = '🔍 ' + _lidarZoomGateTextFor();
                _lidarZoomMsgEl.style.display = show ? '' : 'none';
            }
            map.on('zoomend', _updateLidarZoomGateMessage);

            // ── Public: master toggle ──
            window.toggleLidarLayer = function(on) {
                _lidarVisible = on;
                if (on) {
                    _lidarGroup.addTo(map);
                    Object.keys(LIDAR_SUB_LAYERS).forEach(function(key) {
                        var cfg = LIDAR_SUB_LAYERS[key];
                        if (cfg.enabled && !cfg.leafletLayer) {
                            cfg.leafletLayer = _buildLidarLeafletLayer(key, cfg);
                            _lidarGroup.addLayer(cfg.leafletLayer);
                        } else if (cfg.enabled && cfg.leafletLayer && !_lidarGroup.hasLayer(cfg.leafletLayer)) {
                            _lidarGroup.addLayer(cfg.leafletLayer);
                        }
                    });
                } else {
                    map.removeLayer(_lidarGroup);
                    // Oprirea switch-ului mare "LIDAR" oprește automat toate
                    // substraturile lui (starea internă enabled + slider-ele de
                    // opacitate revin la 0), ca la repornirea masterului să nu
                    // reapară brusc substraturi lăsate "aprinse" din greșeală.
                    Object.keys(LIDAR_SUB_LAYERS).forEach(function (key) {
                        var cfg = LIDAR_SUB_LAYERS[key];
                        cfg.enabled = false;
                        var countryToggle = document.getElementById(LIDAR_COUNTRY_TOGGLE_IDS[key] || '');
                        if (countryToggle) countryToggle.checked = false;
                    });
                }
                var subPanel = document.getElementById('lidarSubLayers');
                var europeanPanel = document.getElementById('lidarEuropeanSubLayers');
                if (subPanel) subPanel.style.opacity = on ? '1' : '0.45';
                if (europeanPanel) europeanPanel.style.opacity = on ? '1' : '0.45';
                if (window._updateCs917ZoomHint) window._updateCs917ZoomHint();
                if (window._updateDj917ZoomHint) window._updateDj917ZoomHint();
                if (window._updateGj917ZoomHint) window._updateGj917ZoomHint();
                if (window._updateMh917ZoomHint) window._updateMh917ZoomHint();
                _updateLidarZoomGateMessage();
            };

            // ── Public: toggle individual sub-layer ──
            window.toggleLidarSub = function(key, on) {
                var cfg = LIDAR_SUB_LAYERS[key];
                if (!cfg) return;
                cfg.enabled = on;
                if (!_lidarVisible) return;
                if (on) {
                    if (!cfg.leafletLayer) {
                        cfg.leafletLayer = _buildLidarLeafletLayer(key, cfg);
                    }
                    if (!_lidarGroup.hasLayer(cfg.leafletLayer)) {
                        _lidarGroup.addLayer(cfg.leafletLayer);
                    }
                } else {
                    if (cfg.leafletLayer && _lidarGroup.hasLayer(cfg.leafletLayer)) {
                        _lidarGroup.removeLayer(cfg.leafletLayer);
                    }
                }
                if (key === 'cs917' && window._updateCs917ZoomHint) window._updateCs917ZoomHint();
                if (key === 'dj917' && window._updateDj917ZoomHint) window._updateDj917ZoomHint();
                if (key === 'gj917' && window._updateGj917ZoomHint) window._updateGj917ZoomHint();
                if (key === 'mh917' && window._updateMh917ZoomHint) window._updateMh917ZoomHint();
                // Click-to-read-elevation only exists while Norway is on map.
                if (key === 'noLidar' && window._setNorwayIdentifyEnabled) {
                    window._setNorwayIdentifyEnabled(!!on && !!cfg.leafletLayer);
                }
                _updateLidarZoomGateMessage();
            };

            // ── European country controls ─────────────────────────────────
            // Country rows use ordinary checkboxes, while the master remains the
            // single switch that owns the shared Leaflet layer group.
            window.toggleInternationalLidar = function (key, on) {
                var cfg = LIDAR_SUB_LAYERS[key];
                if (!cfg) return;
                if (on && !_lidarVisible) {
                    var master = document.getElementById('lidarToggle');
                    if (master) master.checked = true;
                    window.toggleLidarLayer(true);
                }
                window.toggleLidarSub(key, !!on);
            };

            window.setInternationalLidarOpacity = function (key, value) {
                var cfg = LIDAR_SUB_LAYERS[key];
                if (!cfg) return;
                var numeric = Math.max(0, Math.min(100, Number(value) || 0));
                cfg.opacity = numeric / 100;
                var uiKey = key.charAt(0).toUpperCase() + key.slice(1);
                var pct = document.getElementById('lidar' + uiKey + 'Pct');
                if (pct) pct.textContent = numeric + '%';
                if (cfg.leafletLayer && cfg.leafletLayer.setOpacity) {
                    cfg.leafletLayer.options.opacity = cfg.opacity;
                    cfg.leafletLayer.setOpacity(cfg.opacity);
                }
                if (numeric > 0) {
                    if (!_lidarVisible) {
                        var master = document.getElementById('lidarToggle');
                        if (master) master.checked = true;
                        window.toggleLidarLayer(true);
                    }
                    if (!cfg.enabled) window.toggleLidarSub(key, true);
                } else if (cfg.enabled) {
                    window.toggleLidarSub(key, false);
                }
                var slider = document.getElementById('lidar' + uiKey + 'OpacitySlider');
                if (slider && String(slider.value) !== String(numeric)) slider.value = numeric;
            };

            function _replaceSelectableInternationalLayer(key, mode) {
                var cfg = LIDAR_SUB_LAYERS[key];
                if (!cfg) return;
                cfg.mode = mode;
                if (cfg.leafletLayer) {
                    if (_lidarGroup.hasLayer(cfg.leafletLayer)) _lidarGroup.removeLayer(cfg.leafletLayer);
                    cfg.leafletLayer = _buildLidarLeafletLayer(key, cfg);
                    if (cfg.leafletLayer) {
                        cfg.leafletLayer.setOpacity(cfg.opacity);
                        if (_lidarVisible && cfg.enabled) _lidarGroup.addLayer(cfg.leafletLayer);
                    }
                }
            }

            window.setPolandLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.plLidar;
                // Cieniowanie ⇄ Hipsometria only changes the service name in
                // the GetMap URL, so redraw instead of rebuilding the layer.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && POLAND_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('plLidar', mode);
            };

            function _populatePolandModeSelect() {
                var select = document.getElementById('polandLidarModeSelect');
                if (!select || !window.GeoportalNMT) return;
                var current = select.value;
                select.innerHTML = '';
                window.GeoportalNMT.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = POLAND_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.plLidar;
                select.value = (current && POLAND_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || POLAND_LIDAR_DEFAULT_MODE);
            }
            _populatePolandModeSelect();

            window.setSpainLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.esLidar;
                // The Mapa LiDAR WMS publishes a single product today, so this
                // is a no-op unless the module ever exposes more than one mode.
                // When it does, retarget the existing tile layer instead of
                // rebuilding it — only the LAYERS/STYLES pair would change.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && SPAIN_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('esLidar', mode);
            };

            function _populateSpainModeSelect() {
                var select = document.getElementById('spainLidarModeSelect');
                if (!select || !window.IgnMdt) return;
                var current = select.value;
                select.innerHTML = '';
                window.IgnMdt.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = SPAIN_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.esLidar;
                select.value = (current && SPAIN_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || SPAIN_LIDAR_DEFAULT_MODE);
            }
            _populateSpainModeSelect();

            window.setNetherlandsLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.nlAhn;
                // Only the service name and rendering rule change, so redraw
                // the existing grid layer instead of rebuilding it.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && NETHERLANDS_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('nlAhn', mode);
            };

            function _populateNetherlandsModeSelect() {
                var select = document.getElementById('netherlandsLidarModeSelect');
                if (!select || !window.AhnLidar) return;
                var current = select.value;
                select.innerHTML = '';
                window.AhnLidar.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = NETHERLANDS_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.nlAhn;
                select.value = (current && NETHERLANDS_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || NETHERLANDS_LIDAR_DEFAULT_MODE);
            }
            _populateNetherlandsModeSelect();

            window.setSwitzerlandLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.chLidar;
                // Only the layer name (and its maxNativeZoom) changes, so
                // retarget the existing tile layer instead of rebuilding it.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && SWITZERLAND_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('chLidar', mode);
            };

            function _populateSwitzerlandModeSelect() {
                var select = document.getElementById('switzerlandLidarModeSelect');
                if (!select || !window.SwisstopoRelief) return;
                var current = select.value;
                select.innerHTML = '';
                window.SwisstopoRelief.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = SWITZERLAND_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.chLidar;
                select.value = (current && SWITZERLAND_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || SWITZERLAND_LIDAR_DEFAULT_MODE);
            }
            _populateSwitzerlandModeSelect();
            window.setUkLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.ukLidar;
                // Only the layer name (plus its extent and zoom cap) changes,
                // so retarget the existing tile layer instead of rebuilding it.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && UK_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('ukLidar', mode);
            };

            window.setDenmarkLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.dkLidar;
                // Terrain and surface share the View1 grid, so only the
                // WMTS layer name changes: redraw in place.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && DENMARK_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('dkLidar', mode);
            };

            function _populateDenmarkModeSelect() {
                var select = document.getElementById('denmarkLidarModeSelect');
                if (!select || !window.DataforsyningenDHM) return;
                var current = select.value;
                select.innerHTML = '';
                window.DataforsyningenDHM.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = DENMARK_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.dkLidar;
                select.value = (current && DENMARK_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || DENMARK_LIDAR_DEFAULT_MODE);
            }
            _populateDenmarkModeSelect();

            window.setSwedenLidarMode = function (mode) {
                var cfg = LIDAR_SUB_LAYERS.seLidar;
                // Only the WMS layer name changes, so redraw in place.
                if (cfg && cfg.leafletLayer && cfg.leafletLayer.setMode && SWEDEN_LIDAR_MODES[mode]) {
                    cfg.mode = mode;
                    cfg.leafletLayer.setMode(mode);
                    return;
                }
                _replaceSelectableInternationalLayer('seLidar', mode);
            };

            function _populateSwedenModeSelect() {
                var select = document.getElementById('swedenLidarModeSelect');
                if (!select || !window.LantmaterietHojdmodell) return;
                var current = select.value;
                select.innerHTML = '';
                window.LantmaterietHojdmodell.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = SWEDEN_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.seLidar;
                select.value = (current && SWEDEN_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || SWEDEN_LIDAR_DEFAULT_MODE);
            }
            _populateSwedenModeSelect();

            function _populateUkModeSelect() {
                var select = document.getElementById('ukLidarModeSelect');
                if (!select || !window.EaLidarWmts) return;
                var current = select.value;
                select.innerHTML = '';
                window.EaLidarWmts.modeKeys().forEach(function (key) {
                    var option = document.createElement('option');
                    option.value = key;
                    option.textContent = UK_LIDAR_MODES[key].label;
                    select.appendChild(option);
                });
                var cfg = LIDAR_SUB_LAYERS && LIDAR_SUB_LAYERS.ukLidar;
                select.value = (current && UK_LIDAR_MODES[current])
                    ? current
                    : ((cfg && cfg.mode) || UK_LIDAR_DEFAULT_MODE);
            }
            _populateUkModeSelect();
            window.setFranceLidarMode = function (mode) {
                _replaceSelectableInternationalLayer('frLidar', mode);
            };

            // Norway: three whole-country products, no catalogue request.
            _populateNorwayModeSelect();
            var norwaySelect = document.getElementById('norwayLidarRegionSelect');
            if (norwaySelect) norwaySelect.addEventListener('change', function () {
                window.setNorwayLidarMode(this.value);
            });

            // ── Public: expand/collapse sub-layer panel ──
            var _lidarSubExpandedState = false;
            window.toggleLidarSubLayers = function() {
                _lidarSubExpandedState = !_lidarSubExpandedState;
                var panel = document.getElementById('lidarSubLayers');
                var europeanPanel = document.getElementById('lidarEuropeanSubLayers');
                var icon = document.getElementById('lidarExpandIcon');
                if (_lidarSubExpandedState) {
                    setSubLayersMaxHeight(europeanPanel, true, 900);
                    setSubLayersMaxHeight(panel, true, 1100);
                    if (europeanPanel) { europeanPanel.style.opacity = '1'; europeanPanel.style.marginTop = '10px'; }
                    if (panel) { panel.style.opacity = '1'; panel.style.marginTop = '10px'; }
                    icon.style.transform = 'rotate(0deg)';
                } else {
                    setSubLayersMaxHeight(europeanPanel, false);
                    setSubLayersMaxHeight(panel, false);
                    if (europeanPanel) { europeanPanel.style.opacity = '0'; europeanPanel.style.marginTop = '0'; }
                    if (panel) { panel.style.opacity = '0'; panel.style.marginTop = '0'; }
                    icon.style.transform = 'rotate(-90deg)';
                }
                setTimeout(function() {
                    if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                }, 350);
            };

            // ── Public: HD opacity slider ──
            window.setLidarHdOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['hd'];
                cfg.opacity = opacity;
                document.getElementById('lidarHdPct').textContent = val + '%';
                if (cfg.leafletLayer && cfg.leafletLayer.setOpacity) {
                    cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) {
                    window.toggleLidarSub('hd', true);
                }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) {
                    masterToggle.checked = true;
                    window.toggleLidarLayer(true);
                }
            };



            // ── Public: AR opacity slider ──
            window.setLidarArOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['ar'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarArPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    // Suprascrie options.opacity astfel incat tile-urile noi (create la zoom) sa mosteneasca valoarea corecta
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) {
                        cfg.leafletLayer.setOpacity(opacity);
                    }
                }
                if (val > 0 && !cfg.enabled) {
                    window.toggleLidarSub('ar', true);
                }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) {
                    masterToggle.checked = true;
                    window.toggleLidarLayer(true);
                }
            };

            // ── Public: AB opacity slider ──
            window.setLidarAbOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['ab'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarAbPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) {
                        cfg.leafletLayer.setOpacity(opacity);
                    }
                }
                if (val > 0 && !cfg.enabled) {
                    window.toggleLidarSub('ab', true);
                }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) {
                    masterToggle.checked = true;
                    window.toggleLidarLayer(true);
                }
            };

            // ── Public: BH opacity slider ──
            window.setLidarBhOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['bh'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarBhPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) {
                        cfg.leafletLayer.setOpacity(opacity);
                    }
                }
                if (val > 0 && !cfg.enabled) {
                    window.toggleLidarSub('bh', true);
                }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) {
                    masterToggle.checked = true;
                    window.toggleLidarLayer(true);
                }
            };

            // ── Re-aplica opacitatea LIDAR dupa fiecare zoom ──
            // Leaflet creeaza tile-uri noi la zoom si le initializeaza cu options.opacity,
            // dar GridLayer._resetView() poate reseta containerul. Fortam re-aplicarea.
            // ── Public: CS opacity slider ──
            window.setLidarCsOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['cs'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarCsPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('cs', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
            };

            // ── Public: Romania 2-5m/pixel opacity slider ──
            window.setLidarRo2mOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['ro2m'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarRo2mPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('ro2m', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
            };

            // ── Public: Romania 1m/pixel agregare opacity slider ──
            window.setLidarRo1mOpacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['ro1m'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarRo1mPct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('ro1m', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
            };

            // ── Public: CS917 (CS - LAKI III) opacity slider ──
            window.setLidarCs917Opacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['cs917'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarCs917Pct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('cs917', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
                if (window._updateCs917ZoomHint) window._updateCs917ZoomHint();
            };

            // ── CS917 zoom hint ──
            var _CS917_MIN_ZOOM = 9;
            var _cs917HintVisible = false;

            function _updateCs917ZoomHint() {
                var cfg = LIDAR_SUB_LAYERS['cs917'];
                var hint = document.getElementById('cs917ZoomHint');
                if (!hint) return;

                // Only show when: layer is enabled, master LIDAR is on, zoom < minZoom
                var shouldShow = _lidarVisible && cfg.enabled && cfg.opacity > 0 &&
                                 map.getZoom() < _CS917_MIN_ZOOM;

                if (shouldShow && !_cs917HintVisible) {
                    // Build progress pips: current zoom / minZoom  (max 9 pips)
                    var bar = document.getElementById('cs917ZoomBar');
                    if (bar) {
                        bar.innerHTML = '';
                        var cur = Math.max(0, map.getZoom());
                        for (var i = 0; i < _CS917_MIN_ZOOM; i++) {
                            var pip = document.createElement('span');
                            pip.className = 'zh-pip' + (i < cur ? ' filled' : '');
                            bar.appendChild(pip);
                        }
                    }
                    hint.style.display = 'flex';
                    // Trigger transition on next frame
                    requestAnimationFrame(function() { hint.classList.add('visible'); });
                    _cs917HintVisible = true;
                } else if (shouldShow && _cs917HintVisible) {
                    // Update pips while already visible
                    var bar = document.getElementById('cs917ZoomBar');
                    if (bar) {
                        var pips = bar.querySelectorAll('.zh-pip');
                        var cur = Math.max(0, map.getZoom());
                        pips.forEach(function(p, i) {
                            p.classList.toggle('filled', i < cur);
                        });
                    }
                } else if (!shouldShow && _cs917HintVisible) {
                    hint.classList.remove('visible');
                    setTimeout(function() {
                        if (!_cs917HintVisible) hint.style.display = 'none';
                    }, 270);
                    _cs917HintVisible = false;
                }
            }

            // Expose so toggleLidarSub / setLidarCs917Opacity can trigger it too
            window._updateCs917ZoomHint = _updateCs917ZoomHint;

            // ── DJ917 zoom hint ──
            var _DJ917_MIN_ZOOM = 9;
            var _dj917HintVisible = false;

            function _updateDj917ZoomHint() {
                var cfg = LIDAR_SUB_LAYERS['dj917'];
                var hint = document.getElementById('dj917ZoomHint');
                if (!hint) return;

                var shouldShow = _lidarVisible && cfg.enabled && cfg.opacity > 0 &&
                                 map.getZoom() < _DJ917_MIN_ZOOM;

                if (shouldShow && !_dj917HintVisible) {
                    var bar = document.getElementById('dj917ZoomBar');
                    if (bar) {
                        bar.innerHTML = '';
                        var cur = Math.max(0, map.getZoom());
                        for (var i = 0; i < _DJ917_MIN_ZOOM; i++) {
                            var pip = document.createElement('span');
                            pip.className = 'zh-pip' + (i < cur ? ' filled' : '');
                            bar.appendChild(pip);
                        }
                    }
                    hint.style.display = 'flex';
                    requestAnimationFrame(function() { hint.classList.add('visible'); });
                    _dj917HintVisible = true;
                } else if (shouldShow && _dj917HintVisible) {
                    var bar = document.getElementById('dj917ZoomBar');
                    if (bar) {
                        var pips = bar.querySelectorAll('.zh-pip');
                        var cur = Math.max(0, map.getZoom());
                        pips.forEach(function(p, i) {
                            p.classList.toggle('filled', i < cur);
                        });
                    }
                } else if (!shouldShow && _dj917HintVisible) {
                    hint.classList.remove('visible');
                    setTimeout(function() {
                        if (!_dj917HintVisible) hint.style.display = 'none';
                    }, 270);
                    _dj917HintVisible = false;
                }
            }

            window._updateDj917ZoomHint = _updateDj917ZoomHint;

            // ── GJ917 zoom hint ──
            var _GJ917_MIN_ZOOM = 9;
            var _gj917HintVisible = false;

            function _updateGj917ZoomHint() {
                var cfg = LIDAR_SUB_LAYERS['gj917'];
                var hint = document.getElementById('gj917ZoomHint');
                if (!hint) return;

                var shouldShow = _lidarVisible && cfg.enabled && cfg.opacity > 0 &&
                                 map.getZoom() < _GJ917_MIN_ZOOM;

                if (shouldShow && !_gj917HintVisible) {
                    var bar = document.getElementById('gj917ZoomBar');
                    if (bar) {
                        bar.innerHTML = '';
                        var cur = Math.max(0, map.getZoom());
                        for (var i = 0; i < _GJ917_MIN_ZOOM; i++) {
                            var pip = document.createElement('span');
                            pip.className = 'zh-pip' + (i < cur ? ' filled' : '');
                            bar.appendChild(pip);
                        }
                    }
                    hint.style.display = 'flex';
                    requestAnimationFrame(function() { hint.classList.add('visible'); });
                    _gj917HintVisible = true;
                } else if (shouldShow && _gj917HintVisible) {
                    var bar = document.getElementById('gj917ZoomBar');
                    if (bar) {
                        var pips = bar.querySelectorAll('.zh-pip');
                        var cur = Math.max(0, map.getZoom());
                        pips.forEach(function(p, i) {
                            p.classList.toggle('filled', i < cur);
                        });
                    }
                } else if (!shouldShow && _gj917HintVisible) {
                    hint.classList.remove('visible');
                    setTimeout(function() {
                        if (!_gj917HintVisible) hint.style.display = 'none';
                    }, 270);
                    _gj917HintVisible = false;
                }
            }

            window._updateGj917ZoomHint = _updateGj917ZoomHint;

            // ── MH917 zoom hint ──
            var _MH917_MIN_ZOOM = 9;
            var _mh917HintVisible = false;

            function _updateMh917ZoomHint() {
                var cfg = LIDAR_SUB_LAYERS['mh917'];
                var hint = document.getElementById('mh917ZoomHint');
                if (!hint) return;

                var shouldShow = _lidarVisible && cfg.enabled && cfg.opacity > 0 &&
                                 map.getZoom() < _MH917_MIN_ZOOM;

                if (shouldShow && !_mh917HintVisible) {
                    var bar = document.getElementById('mh917ZoomBar');
                    if (bar) {
                        bar.innerHTML = '';
                        var cur = Math.max(0, map.getZoom());
                        for (var i = 0; i < _MH917_MIN_ZOOM; i++) {
                            var pip = document.createElement('span');
                            pip.className = 'zh-pip' + (i < cur ? ' filled' : '');
                            bar.appendChild(pip);
                        }
                    }
                    hint.style.display = 'flex';
                    requestAnimationFrame(function() { hint.classList.add('visible'); });
                    _mh917HintVisible = true;
                } else if (shouldShow && _mh917HintVisible) {
                    var bar = document.getElementById('mh917ZoomBar');
                    if (bar) {
                        var pips = bar.querySelectorAll('.zh-pip');
                        var cur = Math.max(0, map.getZoom());
                        pips.forEach(function(p, i) {
                            p.classList.toggle('filled', i < cur);
                        });
                    }
                } else if (!shouldShow && _mh917HintVisible) {
                    hint.classList.remove('visible');
                    setTimeout(function() {
                        if (!_mh917HintVisible) hint.style.display = 'none';
                    }, 270);
                    _mh917HintVisible = false;
                }
            }

            window._updateMh917ZoomHint = _updateMh917ZoomHint;

            // ── Public: MH917 (MH - LAKI III) opacity slider ──
            window.setLidarMh917Opacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['mh917'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarMh917Pct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('mh917', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
                if (window._updateMh917ZoomHint) window._updateMh917ZoomHint();
            };

            // ── Public: GJ917 (GJ - LAKI III) opacity slider ──
            window.setLidarGj917Opacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['gj917'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarGj917Pct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('gj917', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
                if (window._updateGj917ZoomHint) window._updateGj917ZoomHint();
            };

            // ── Public: DJ917 (DJ - LAKI III) opacity slider ──
            window.setLidarDj917Opacity = function(val) {
                var opacity = val / 100;
                var cfg = LIDAR_SUB_LAYERS['dj917'];
                cfg.opacity = opacity;
                var pctEl = document.getElementById('lidarDj917Pct');
                if (pctEl) pctEl.textContent = val + '%';
                if (cfg.leafletLayer) {
                    cfg.leafletLayer.options.opacity = opacity;
                    if (cfg.leafletLayer.setOpacity) cfg.leafletLayer.setOpacity(opacity);
                }
                if (val > 0 && !cfg.enabled) { window.toggleLidarSub('dj917', true); }
                var masterToggle = document.getElementById('lidarToggle');
                if (masterToggle && val > 0 && !_lidarVisible) { masterToggle.checked = true; window.toggleLidarLayer(true); }
                if (window._updateDj917ZoomHint) window._updateDj917ZoomHint();
            };

            map.on('zoomend', function() {
                ['ar', 'hd', 'ab', 'bh', 'cs', 'ro2m', 'ro1m', 'cs917', 'dj917', 'gj917', 'mh917',
                 'nlAhn', 'noLidar', 'plLidar', 'esLidar', 'chLidar', 'ukLidar', 'frLidar', 'dkLidar',
                 'seLidar'].forEach(function(key) {
                    var cfg = LIDAR_SUB_LAYERS[key];
                    if (cfg && cfg.leafletLayer && cfg.enabled && _lidarVisible) {
                        cfg.leafletLayer.options.opacity = cfg.opacity;
                        cfg.leafletLayer.setOpacity(cfg.opacity);
                    }
                });
                _updateCs917ZoomHint();
                _updateDj917ZoomHint();
                _updateGj917ZoomHint();
                _updateMh917ZoomHint();
            });

            // ── SYNC initial state with HTML checkboxes ──
            // Safety net: if the romanToggle checkbox is ever marked checked in HTML,
            // make sure _romanVisible (which starts false) gets synced on page load.
            // With current markup nothing is checked by default, so this is a no-op.
            (function() {
                var toggle = document.getElementById('romanToggle');
                if (toggle && toggle.checked) {
                    window.toggleRomanLayer(true);
                }
            })();

            // ── NEARBY DETECTORISTS ──
            var nearbyLayer = L.layerGroup().addTo(map);
            // Map view captured when the nearby panel is opened, so "back to the
            // initial view" can restore exactly what the user was looking at.
            var _nearbyPrevView = null;
            // Stable per-browser device id so the SAME account signed in on two phones
            // (or two browser tabs) shows up as two distinct nearby detectorists instead
            // of one row overwriting the other. Falls back gracefully if storage is blocked.
            var DETECTOR_DEVICE_ID = (function () {
                try {
                    var d = localStorage.getItem('detector_device_id');
                    if (!d) {
                        d = (window.crypto && crypto.randomUUID)
                            ? crypto.randomUUID()
                            : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2);
                        localStorage.setItem('detector_device_id', d);
                    }
                    return d;
                } catch (e) {
                    return 'web-' + Math.random().toString(36).slice(2);
                }
            })();
            function nearbyInitials(name) { return String(name || '?').replace(/[<>&"']/g, '').trim().split(/\s+/).slice(0,2).map(function(x){return x[0];}).join('').toUpperCase() || '?'; }
            // Social action slot carried by every detectorist popup (live orange
            // pins AND black/white offline bubbles). It is intentionally EMPTY:
            // js/friends.js fills it from the map's 'popupopen' event with the
            // action that matches the relationship with that account — send a
            // friend request, accept theirs, cancel ours or open the chat when
            // you are already friends. Keeping only the identity in the markup
            // means the buttons are always painted from the live friend state,
            // never from a popup captured minutes ago.
            function detectorSocialSlotHtml(userId, name, kind) {
                if (!userId) return '';
                var uid = String(userId).replace(/[<>&"']/g, '');
                var safe = String(name || '').replace(/[<>&"']/g, '');
                return '<div class="detector-social-actions" data-user-id="' + uid +
                    '" data-user-name="' + safe + '" data-detector-kind="' + String(kind || '') + '"></div>';
            }
            function nearbyDistance(a,b,c,d) { var R=6371, x=(c-a)*Math.PI/180, y=(d-b)*Math.PI/180; var q=Math.sin(x/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(y/2)**2; return 2*R*Math.asin(Math.sqrt(q)); }
            function nearbyUser() { return window._authUser && window._authUser(); }
            // Mirrors the active state on both triggers: the desktop labelled
            // button and the PWA icon in the left stack (whichever exists).
            function setNearbyButtonsActive(on) {
                ['nearbyDetectorsBtn', 'pwaNearbyBtn'].forEach(function (id) {
                    try {
                        var b = document.getElementById(id);
                        if (b) b.classList.toggle('is-active', on);
                    } catch (e) {}
                });
            }
            window.openNearbyDetectors = function() {
                var m = document.getElementById('nearbyModal');
                var hasPins = nearbyLayer && nearbyLayer.getLayers().length > 0;
                
                if (m && (m.classList.contains('show') || hasPins)) {
                    // Modal is already open OR there are already pins on the map (clicking again).
                    // We hide the modal, clear the pins, hide the home button and reset status.
                    m.classList.remove('show');
                    if (nearbyLayer) {
                        nearbyLayer.clearLayers();
                    }
                    var homeBtn = document.getElementById('nearbyHomeBtn');
                    if (homeBtn) homeBtn.style.display = 'none';

                    setNearbyButtonsActive(false);
                    
                    var status = document.getElementById('nearbyStatus');
                    if (status) {
                        status.innerHTML = 'Cauți detectoriști pe o rază de 10 km?<br><small>Search within a 10 km radius?</small>';
                    }
                } else {
                    if (m) m.classList.add('show');
                    // Remember the current map view so the user can return to the initial
                    // aspect after the search zooms the map to the found pins.
                    _nearbyPrevView = { center: map.getCenter(), zoom: map.getZoom() };
                    // Broadcast our current position right away, under the one
                    // presence rule (live location + the "Da" answer).
                    if(_detLat !== null && typeof publishDetectorPresence === 'function') {
                        publishDetectorPresence(_detLat, _detLng, _presenceVisible());
                    }
                }
            };
            window.closeNearbyDetectors = function() { var m=document.getElementById('nearbyModal'); if(m)m.classList.remove('show'); };
            // ── SOCIAL ACTIONS ON DETECTORIST PINS ──
            // Every live (orange) and offline (black/white) popup ships an empty
            // .detector-social-actions slot; friends.js paints it the moment the
            // popup opens, so a tap on a detectorist offers "Adaugă prieten",
            // "Acceptă cererea", "Cerere trimisă / Anulează" or, for somebody who
            // is already a friend, "Trimite mesaj". Nothing renders when nobody
            // is signed in (or when the pin is another device of my own account).
            map.on('popupopen', function (e) {
                try {
                    var popupEl = e && e.popup && typeof e.popup.getElement === 'function' ? e.popup.getElement() : null;
                    if (!popupEl) return;
                    var F = window.DetectLabFriends;
                    // decorateDetectorPopup() paints the slot AND re-runs Leaflet's
                    // measuring step itself. It must not be followed by a
                    // popup.update() here: these popups hold a string content, so
                    // update() would assign that string back over the content node
                    // and erase the button that was just painted — the exact
                    // "butonul de prietenie apare doar câteodata" behaviour.
                    if (F && typeof F.decorateDetectorPopup === 'function') F.decorateDetectorPopup(popupEl);
                } catch (err) {
                    console.warn('[Nearby] social actions on popup failed:', err && err.message ? err.message : err);
                }
            });
            // Restore the map view the user had before opening the nearby-detectorists
            // panel (falls back to the initial full-canvas view) and close the panel.
            window.resetNearbyView = function() {
                if (_nearbyPrevView) {
                    map.setView(_nearbyPrevView.center, _nearbyPrevView.zoom);
                    _nearbyPrevView = null;
                } else {
                    map.fitBounds(APM_BOUNDS);
                }
                window.closeNearbyDetectors();
            };
            // Resolves true as soon as the detection / live-location GPS watchers deliver
            // the first fix (_detLat/_detLng set), or false if a geolocation error fires
            // first or no fix arrives within the timeout. Used by the nearby-detectorists
            // search so that clicking "Yes" can auto-turn-on the user's live location,
            // wait for the position, and then continue the search automatically.
            function waitForDetPosition(timeoutMs) {
                return new Promise(function (resolve) {
                    if (_detLat !== null && _detLng !== null) { resolve(true); return; }
                    var settled = false;
                    function finish(ok) {
                        if (settled) return;
                        settled = true;
                        if (window._onDetectGeoError === onGeoError) window._onDetectGeoError = null;
                        clearInterval(poll);
                        clearTimeout(deadline);
                        resolve(ok);
                    }
                    var onGeoError = function () { finish(false); };
                    window._onDetectGeoError = onGeoError;
                    var poll = setInterval(function () {
                        if (_detLat !== null && _detLng !== null) finish(true);
                    }, 300);
                    var deadline = setTimeout(function () { finish(false); }, timeoutMs || 25000);
                });
            }
            // ── OFFLINE DETECTORISTS ───────────────────────────────────────
            // Draw a black/white bubble for every user who is NOT broadcasting
            // live right now but whose last known broad location (nearest
            // city/town) sits in the SAME COUNTY as our own last location.
            // The bubble is placed on their last known coordinates.
            // Returns how many bubbles were added.
            async function addOfflineDetectorBubbles(liveUserIds, user) {
                try {
                    var LL = window.DetectLabLastLocation;
                    if (!LL) return 0;

                    // Make sure OUR OWN last location is up to date first, so we
                    // know which county to match against even on a fresh device.
                    if (_detLat !== null && _detLng !== null) {
                        try { await LL.recordLastLocation(_detLat, _detLng); } catch (e) {}
                    }

                    var mine = LL.getMyLastLocation();
                    var myCounty = mine && mine.county;
                    if (!myCounty && _detLat !== null && _detLng !== null) {
                        var place = await LL.resolveBroadLocation(_detLat, _detLng);
                        myCounty = place && place.county;
                    }
                    if (!myCounty) return 0;

                    var rows = await LL.fetchLastLocations();
                    var added = 0;
                    rows.forEach(function (row) {
                        if (!row || !row.user_id) return;
                        if (user && row.user_id === user.id) return;         // that's us
                        if (liveUserIds && liveUserIds[row.user_id]) return; // already an orange live pin
                        if (!LL.sameCounty(row.county, myCounty)) return;
                        var lat = Number(row.latitude), lng = Number(row.longitude);
                        if (!isFinite(lat) || !isFinite(lng)) return;

                        var name = String(row.full_name || 'Detectorist');
                        var safeName = name.replace(/[<>&"]/g, '');
                        // The visible bubble stays 32px, but the tappable icon is a
                        // 44px pad (Apple HIG minimum): 32px targets are too easy
                        // to miss with a thumb, and a tap that starts off-target
                        // never opens the popup in the PWA.
                        var icon = L.divIcon({
                            className: '',
                            html: '<div class="detector-tap-pad"><div class="detector-offline-marker" title="' + safeName + ' — offline">' +
                                nearbyInitials(name) + '</div></div>',
                            iconSize: [44, 44],
                            iconAnchor: [22, 22]
                        });
                        var where = String(row.label || row.city || row.county || '').replace(/[<>&]/g, '');
                        var seenAt = '';
                        try {
                            if (row.updated_at) seenAt = new Date(row.updated_at).toLocaleString();
                        } catch (e) {}
                        // zIndexOffset below the live pins (1100): a live detectorist
                        // standing at the same spot must stay clickable first.
                        // Horizontal card: avatar left, identity right, actions below.
                        // The outer .map-place-popup stays FIRST — the in-popup flow
                        // override keys off it (one window, not two).
                        L.marker([lat, lng], { icon: icon, interactive: true, zIndexOffset: 900 })
                            .bindPopup('<div class="map-place-popup"><div class="detector-popup detector-offline">' +
                                '<div class="detector-card-top">' +
                                '<div class="detector-avatar">' + nearbyInitials(name) + '<span class="detector-presence"></span></div>' +
                                '<div class="detector-id">' +
                                '<div class="detector-name">' + safeName + '</div>' +
                                '<div class="detector-status">⚪ Offline — ultima locație cunoscută / last known location</div>' +
                                (where ? '<div class="detector-meta">📍 ' + where + '</div>' : '') +
                                (seenAt ? '<div class="detector-meta">🕘 ' + seenAt + '</div>' : '') +
                                '</div></div>' +
                                detectorSocialSlotHtml(row.user_id, name, 'offline') +
                                '</div></div>')
                            .addTo(nearbyLayer);
                        added++;
                    });
                    return added;
                } catch (e) {
                    console.warn('[Nearby] offline bubbles failed:', e && e.message ? e.message : e);
                    return 0;
                }
            }

            window.searchNearbyDetectors = async function() {
                var status=document.getElementById('nearbyStatus'); var user=nearbyUser();
                if(!user) { status.innerHTML='Trebuie să fii autentificat pentru această funcție.<br><small>You must be logged in to use this feature.</small>'; return; }
                // ── "Yes" turns on the LIVE LOCATION — and nothing else ──
                // This flow only needs a position of our own to search around,
                // so the magnifier starts the live-location GPS watcher. It used
                // to call toggleDetection(true) as well, which silently switched
                // on the whole detection mode (heritage radius circles + layer,
                // proximity alarm, the 10 h auto-off timer and its persisted
                // switch state) for somebody who only wanted to look around.
                // Broadcasting to the other detectorists is a live-location
                // thing (see _presenceVisible), so nothing is lost by leaving
                // the Detect switch alone.
                var autoLiveLocation = false;
                if (!navigator.geolocation) {
                    status.innerHTML='Browserul tău nu suportă geolocalizarea.<br><small>Your browser does not support geolocation.</small>';
                    return;
                }
                if (typeof window._startLiveLocation !== 'function' ||
                    typeof window._isLiveLocationActive !== 'function') {
                    status.innerHTML='Pornește locația live (butonul 🎯 de pe hartă) ca să te poți căuta.<br><small>Start live location (the 🎯 map button) before searching.</small>';
                    return;
                }
                // ── Aceeași fereastră Da/Nu ca la switchul de detecție ──
                // „Vrei să fii vizibil și pentru alți utilizatori?” este întrebat
                // și aici: momentul în care vrei să vezi alți detectoriști este
                // exact momentul în care propria poziție se publică, deci
                // răspunsul trebuie să vină de la utilizator, nu din valoarea
                // veche.  Căutarea AȘTEAPTĂ răspunsul — fereastra de întrebare
                // rămâne singura pe ecran (dialogul de căutare se retrage și
                // revine după răspuns), iar publicarea de mai jos trece oricum
                // prin _presenceVisible(), deci nu poate contrazice răspunsul.
                // „Nu” NU oprește căutarea: vezi vecinii fără să fii văzut.
                if (typeof window._promptVisibleToOthers === 'function') {
                    var nearbyModalEl = document.getElementById('nearbyModal');
                    var nearbyWasShowing = !!(nearbyModalEl && nearbyModalEl.classList.contains('show'));
                    if (nearbyModalEl) nearbyModalEl.classList.remove('show');
                    try {
                        await window._promptVisibleToOthers();
                    } catch (err) {
                        console.warn('[Nearby] visibility prompt failed:', err);
                    }
                    if (nearbyModalEl && nearbyWasShowing) nearbyModalEl.classList.add('show');
                }
                if (!window._isLiveLocationActive()) {
                    status.innerHTML='Activăm locația live…<br><small>Turning on your live location…</small>';
                    try {
                        window._startLiveLocation();
                    } catch (err) {
                        console.warn('[Nearby] auto-enable live location failed:', err);
                    }
                    if (!window._isLiveLocationActive()) {
                        status.innerHTML='Nu am putut porni locația live.<br><small>We could not turn on live location.</small>';
                        return;
                    }
                    autoLiveLocation = true;
                }
                // Undo OUR own switch-on when the fix never arrives, so the map
                // never keeps a GPS watcher the user did not ask for.
                function revertLiveLocation() {
                    if (!autoLiveLocation) return;
                    autoLiveLocation = false;
                    try {
                        if (window._isLiveLocationActive() && typeof window._stopLiveLocation === 'function') {
                            window._stopLiveLocation();
                        }
                    } catch (err) { console.warn('[Nearby] revert live location failed:', err); }
                }
                if(_detLat === null) {
                    // No position fix yet — wait for the live-location watcher
                    // (started above or already running) to deliver the first
                    // coordinates, then fall through and run the search.
                    if (!autoLiveLocation) {
                        // Live location was already on but no fix yet — just wait.
                        status.innerHTML='Așteptăm semnalul GPS pentru a-ți transmite poziția…<br><small>Waiting for your location to broadcast your position…</small>';
                    }
                    var gotFix = await waitForDetPosition();
                    if (!gotFix) {
                        // Location permission denied / unavailable / timed out.
                        revertLiveLocation();
                        status.innerHTML='Nu am putut activa locația ta. Verifică permisiunile de localizare din browser (sau pornește manual locația live) și încearcă din nou.<br><small>We could not turn on your location. Check your browser location permissions (or start live location manually) and try again.</small>';
                        return;
                    }
                }
                status.innerHTML='Se caută…<br><small>Searching…</small>';
                try {
                    // Make sure OUR position is freshly published first, so the other
                    // phone can see us even if its search runs a moment earlier — but only
                    // while live location is on and the user answered "Da".
                    await publishDetectorPresence(_detLat, _detLng, _presenceVisible());

                    // Try to read with device_id (new schema). If the migration hasn't been
                    // applied yet, fall back to the legacy columns-only query.
                    var rows, legacySchema = false;
                    // Only show detectorists whose position was updated in the last
                    // 5 minutes — excludes stale rows left behind when a user closes
                    // the browser without turning off detection / live location.
                    var _staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
                    var res = await window.supabaseClient
                        .from('detector_presence')
                        .select('user_id,device_id,full_name,email,latitude,longitude')
                        .eq('visible', true)
                        .gt('updated_at', _staleCutoff);
                    if (res.error) {
                        if (/device_id|column/i.test((res.error.message || '') + (res.error.details || '') + (res.error.hint || ''))) {
                            var res2 = await window.supabaseClient
                                .from('detector_presence')
                                .select('user_id,full_name,email,latitude,longitude')
                                .eq('visible', true)
                                .gt('updated_at', _staleCutoff);
                            if (res2.error) throw res2.error;
                            rows = res2.data || [];
                            legacySchema = true;
                        } else {
                            throw res.error;
                        }
                    } else {
                        rows = res.data || [];
                    }

                    nearbyLayer.clearLayers();
                    var total = rows.length, found = 0;
                    // Track who is LIVE so the offline pass never draws a second
                    // (black/white) bubble for somebody already shown in orange.
                    var liveUserIds = {};
                    rows.forEach(function (row) { if (row && row.user_id) liveUserIds[row.user_id] = true; });
                    rows.forEach(function(row){
                        // Skip only OUR device (allow two devices of the same account to see
                        // each other on the new schema; fall back to user match on legacy schema).
                        if (!legacySchema && row.device_id === DETECTOR_DEVICE_ID) return;
                        if (legacySchema && row.user_id === user.id) return;
                        if (nearbyDistance(_detLat,_detLng,+row.latitude,+row.longitude) <= 10) {
                            found++;
                            var liveName=String(row.full_name||'Detectorist').replace(/[<>&"]/g,'');
                            var liveEmail=String(row.email||'').replace(/[<>&]/g,'');
                            // 44px tap pad around the 32px visual (see the offline
                            // bubbles above): thumb-sized targets for the PWA.
                            var icon=L.divIcon({className:'',html:'<div class="detector-tap-pad"><div class="detector-nearby-marker" title="'+liveName+'">'+nearbyInitials(row.full_name)+'</div></div>',iconSize:[44,44],iconAnchor:[22,22]});
                            // zIndexOffset 1100 keeps these pins ABOVE our own live-location
                            // marker (zIndexOffset 1000), so a detectorist standing at ~our
                            // own position is still the one that receives the tap/click.
                            // Clicking a pin opens a small window with full name + email
                            // plus the social action slot (friend request / message).
                            // Horizontal card (same shape as the offline bubbles):
                            // avatar left, identity right, actions below.
                            L.marker([+row.latitude,+row.longitude],{icon:icon,interactive:true,zIndexOffset:1100})
                                .bindPopup('<div class="map-place-popup"><div class="detector-popup detector-live">' +
                                '<div class="detector-card-top">' +
                                '<div class="detector-avatar">'+nearbyInitials(row.full_name)+'<span class="detector-presence"></span></div>' +
                                '<div class="detector-id"><div class="detector-name">'+liveName+'</div>' +
                                '<div class="detector-status">🟢 Live — în apropiere / nearby</div>' +
                                (liveEmail ? '<div class="detector-meta">'+liveEmail+'</div>' : '') +
                                '</div></div>' +
                                detectorSocialSlotHtml(row.user_id, liveName, 'live') +
                                '</div></div>')
                                .addTo(nearbyLayer);
                        }
                    });
                    // ── OFFLINE DETECTORISTS (black/white bubbles) ──
                    // Users who are not broadcasting right now but whose LAST known
                    // broad location (nearest city/town) is in the SAME COUNTY as us.
                    var offlineFound = await addOfflineDetectorBubbles(liveUserIds, user);

                    if (found || offlineFound) {
                        var liveTxtRo = found + ' detectorist(i) activ(i) în apropiere';
                        var liveTxtEn = found + ' active detectorist(s) nearby';
                        var offTxtRo = offlineFound ? ' și ' + offlineFound + ' offline în județ' : '';
                        var offTxtEn = offlineFound ? ' and ' + offlineFound + ' offline in your county' : '';
                        status.innerHTML = liveTxtRo + offTxtRo + '.<br><small>' + liveTxtEn + offTxtEn + '.</small>' +
                            (offlineFound ? '<br><small style="opacity:0.7;">⚪ Bulele alb-negru = ultima locație cunoscută. / Black &amp; white bubbles = last known location.</small>' : '');
                        var layers = nearbyLayer.getLayers();
                        // IMPORTANT: never let fitBounds zoom past the satellite base map's
                        // limit (maxNativeZoom 19). With only 1-2 nearby pins, an uncapped
                        // fitBounds jumps to the map max (20) and Leaflet hides every
                        // satellite tile — the "whole base map turns white" bug.
                        if (layers.length) {
                            var bounds = L.latLngBounds(layers.map(function(layer) { return layer.getLatLng(); }));
                            if (_detLat !== null && _detLng !== null) {
                                bounds.extend([_detLat, _detLng]);
                            }
                            map.fitBounds(bounds.pad(0.2), { maxZoom: 17 });
                        }
                        setNearbyButtonsActive(true);
                        var homeBtn = document.getElementById('nearbyHomeBtn');
                        if (homeBtn) homeBtn.style.display = '';
                    } else if (total > 0) {
                        status.innerHTML = 'Niciun detectorist în raza de 10 km (' + total + ' activ(i) în total).<br><small>No detectorists within 10 km (' + total + ' active in total).</small>';
                        setNearbyButtonsActive(false);
                    } else {
                        status.innerHTML = 'Nu sunt detectoriști în apropiere.<br><small>No detectorists found nearby.</small>';
                        setNearbyButtonsActive(false);
                    }
                } catch(e) {
                    var msg = (e && (e.message || (e.error && (e.error.message || e.error)) || e.details)) ? (e.message || (e.error && (e.error.message || e.error)) || e.details) : '';
                    console.warn('Nearby detectorists:', e);
                    var hint = '';
                    if (/relation|does not exist|404|schema cache/i.test(msg)) hint = '<br><small>Tabela "detector_presence" lipsește — aplică migrările Supabase.</small>';
                    else if (/permission|policy|42501|rls/i.test(msg)) hint = '<br><small>Acces blocat de RLS — verifică politicile pentru detector_presence.</small>';
                    status.innerHTML = 'Căutarea nu este disponibilă momentan.' + hint + '<br><small>Search unavailable. ' + (msg ? String(msg).slice(0,160) : '') + '</small>';
                }
            };
            // ── "May this position be published to the other detectorists?" ──
            // The rule behind every publishDetectorPresence() call below:
            //
            //     live location is running  AND  the user answered "Da"
            //
            // It used to also require the detection mode, which forced the
            // magnifier button to switch the whole detection mode on (heritage
            // radius alerts, the heritage layer, the 10 h auto-off timer…) just
            // so a detectorist could look around. Broadcasting a position is a
            // live-location thing, so the Detect switch is no longer part of it
            // and stays the user's own business. (window._presenceVisible keeps
            // the same rule available to other modules and to the tests.)
            function _presenceVisible() {
                return !!(typeof window._isLiveLocationActive === 'function' &&
                    window._isLiveLocationActive() && _visibleToOthers);
            }
            window._presenceVisible = _presenceVisible;

            async function publishDetectorPresence(lat,lng,visible) {
                try {
                    var u=nearbyUser();
                    if(!u || !window.supabaseClient) return;
                    var md=u.user_metadata||{};
                    var name=u.name||md.full_name||md.name||u.email||'Detectorist';
                    var payload = {
                        user_id:u.id,
                        full_name:name,
                        email:u.email||'',
                        latitude:lat,
                        longitude:lng,
                        visible:visible,
                        updated_at:new Date().toISOString()
                    };
                    try { payload.device_id = DETECTOR_DEVICE_ID; } catch(e){}
                    var result = await window.supabaseClient.from('detector_presence').upsert(payload);
                    if (result.error) {
                        var em = (result.error.message || '') + (result.error.details || '') + (result.error.hint || '');
                        // Legacy schema without the device_id column: retry without it.
                        if (/device_id|column/i.test(em)) {
                            var p2 = {}; for (var k in payload) { if (k !== 'device_id') p2[k] = payload[k]; }
                            var r2 = await window.supabaseClient.from('detector_presence').upsert(p2);
                            if (r2.error) console.warn('[Presence] upsert error:', r2.error.message || r2.error);
                        } else {
                            console.warn('[Presence] upsert error:', result.error.message || result.error);
                        }
                    }
                } catch(e) {
                    console.warn('[Presence] publish failed:', e && e.message ? e.message : e);
                }
                // ── Remember the BROAD last location (nearest city/town + county) ──
                // Independent of `visible`: even when the user hides from live
                // search we still know roughly where they were, so they can be
                // shown as an offline (black/white) bubble and be notified about
                // events created in their county. Throttled internally.
                try {
                    if (window.DetectLabLastLocation) {
                        window.DetectLabLastLocation.recordLastLocation(lat, lng);
                    }
                } catch (e) {}
            }

            // ── FULLSCREEN ──
            var isFullscreen = false;
            window.toggleMapFullscreen = function () {
                var frame = document.querySelector('.map-frame');
                var wrapper = document.querySelector('.map-wrapper');
                isFullscreen = !isFullscreen;
                frame.classList.toggle('is-fullscreen', isFullscreen);
                wrapper.classList.toggle('is-fullscreen', isFullscreen);
                document.body.style.overflow = isFullscreen ? 'hidden' : '';
                // Update the bottom-bar button label
                var fsLabel = document.getElementById('fsLabel');
                var fsIcon = document.getElementById('fsIcon');
                if (fsLabel) fsLabel.textContent = isFullscreen ? 'Exit Full Screen' : 'Full Screen';
                if (fsIcon) fsIcon.innerHTML = isFullscreen
                    ? '<path d="M5 1V5H1M9 5V1H13M9 13V9H13M1 9H5V13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
                    : '<path d="M1 5V1H5M9 1H13V5M13 9V13H9M5 13H1V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
                setTimeout(function () { map.invalidateSize(); }, 100);
            };
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && isFullscreen) window.toggleMapFullscreen();
            });

            // ── TRANSPARENCY PANEL ──
            // The open state is also published on <body>: the panel stretches to
            // the bottom of the screen in the installed PWA. The account stack
            // stays removed, while the separate bottom-right live-location
            // button hides in place under the panel; the body flag drives that
            // CSS rule and lets other code know the window is open.
            var transpPanelOpen = false;
            // Both the panel element and a body-level flag follow the open state,
            // so no path may set one without the other — hence one tiny setter
            // used by open AND close.
            function markTranspPanelOpen(on) {
                transpPanelOpen = !!on;
                document.getElementById('transpPanel').classList.toggle('open', transpPanelOpen);
                document.getElementById('transpTab').classList.toggle('open', transpPanelOpen);
                if (document.body && document.body.classList) {
                    document.body.classList.toggle('transp-panel-open', transpPanelOpen);
                }
            }
            window.toggleTranspPanel = function () {
                markTranspPanelOpen(!transpPanelOpen);
                if (transpPanelOpen) {
                    setTimeout(function() {
                        if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                    }, 100);
                }
            };

            // Close panel when clicking outside
            document.addEventListener('click', function (e) {
                if (!transpPanelOpen) return;
                var panel = document.getElementById('transpPanel');
                var tab = document.getElementById('transpTab');
                if (!panel.contains(e.target) && !tab.contains(e.target)) {
                    markTranspPanelOpen(false);
                }
            });

            window.setApmOpacity = function (val) {
                var opacity = val / 100;
                if (window._apmLayer) window._apmLayer.setOpacity(opacity);
                document.getElementById('apmPct').textContent = val + '%';
                // Keep the toggle in sync: if opacity > 0 consider layer "on"
                var toggle = document.getElementById('apmToggle');
                if (toggle) toggle.checked = (val > 0);
            };


            window.setSatOpacity = function (val) {
                var opacity = val / 100;
                if (window._satLayer) window._satLayer.setOpacity(opacity);
                // Opacitatea se aplică și mozaicurilor istorice Copernicus VHR
                // (2012 / 2018 / 2021), indiferent care perioadă e activă din
                // sliderul „Istoric”.
                if (window._satHistPeriods) {
                    Object.keys(window._satHistPeriods).forEach(function (p) {
                        var layer = window._satHistPeriods[p];
                        if (layer && typeof layer.setOpacity === 'function') layer.setOpacity(opacity);
                    });
                }
                document.getElementById('satPct').textContent = val + '%';
            };

            window.setPatrimoniuOpacity = function (val) {
                // Radius opacity slider controls ONLY the canvas FLAT_OPACITY.
                // It has no effect on the Heritage Sites WMS layer or its toggle.
                var wasZero = (FLAT_OPACITY === 0);
                FLAT_OPACITY = val / 100;
                document.getElementById('patrimoniuPct').textContent = val + '%';

                if (val > 0 && !_circlesVisible) {
                    // Slider dragged above 0 while circles are off — turn them on
                    _circlesVisible = true;
                    _displayCanvas.style.display = '';
                }
                if (val > 0 && wasZero) {
                    // Transitioning from hidden → visible: force a data fetch for this viewport
                    loadSiteCircles();
                }
                _scheduleRedraw();
            };

            // Keep opacity slider in sync when APM toggle is switched
            var _origToggle = window.toggleApmLayer;
            window.toggleApmLayer = function (on) {
                _origToggle(on);
                var slider = document.getElementById('apmOpacitySlider');
                if (slider) {
                    var newVal = on ? slider.value : 0;
                    if (!on) {
                        var pct = document.getElementById('apmPct');
                        if (pct) pct.textContent = '0%';
                    }
                }
            };

            // ── VIZIBILITATE PENTRU ALȚI UTILIZATORI (prompt Da/Nu) ──
            // When the user MANUALLY turns ON the Detect switch or the live-location
            // button, a Da/Nu dialog asks whether they also want to be visible to
            // other users on the "See other detectorists" map.  The answer is the
            // extra gate (_visibleToOthers) applied to every presence publish.
            //
            // Being seen is about the position, not about the metal detector: the
            // rule is "live location is running AND the answer was Da"
            // (_presenceVisible), and the Detect switch no longer gates it.  The
            // "Vezi alți detectoriști" search starts live location only — it must
            // never switch detection on by itself, and switching detection off must
            // not hide somebody who is still sharing their position.
            //
            // The choice is persisted in localStorage so programmatic re-activations
            // (resume from background, 10-hour-window restore, auto-enable from the
            // nearby search) reuse it instead of re-asking.  Default until the user
            // makes an explicit choice: "Nu" (invisible) — presence rows are written
            // with visible=false, so nobody is broadcast without an explicit "Da".
            //
            // The SAME dialog is asked by the TWO user actions that hand our
            // position to the other detectorists:
            //   • turning the Detect switch ON / starting the live location by hand
            //     (window.toggleDetection + the 🎯 button below), and
            //   • the "Vezi alți detectoriști în zonă" search — wanting to see the
            //     neighbours is answered with the identical question instead of
            //     being published silently (searchNearbyDetectors awaits the
            //     answer before it broadcasts or starts the GPS watcher).
            // Programmatic re-activations never ask again: they reuse the stored
            // answer.  A second ask that arrives while the dialog is already on
            // screen joins the SAME question (the window is never stacked); every
            // waiter — a callback or the Promise a flow is awaiting — is released
            // with the single Da/Nu answer.
            var _visibleToOthers = (function () {
                try { return localStorage.getItem('detect_visible_to_others') === 'true'; }
                catch (e) { return false; }
            })();
            var _visibilityWaiters = [];

            // Show the Da/Nu dialog: "Vrei să fii vizibil și pentru alți utilizatori?"
            //   • with a cb  → cb(answer) is invoked when Da/Nu is pressed
            //                  (true = "Da", visible · false = "Nu", invisible);
            //   • without one → a Promise resolving with the same answer, so an
            //                   async flow (the nearby-detectorists search) can WAIT
            //                   for the user instead of publishing behind the window.
            // With the markup missing the current stored answer is handed over
            // immediately, so no caller can ever hang on a dialog that cannot open.
            window._promptVisibleToOthers = function (cb) {
                var hasCb = (typeof cb === 'function');
                var m = document.getElementById('visibilityModal');
                if (!m) {
                    if (hasCb) { try { cb(_visibleToOthers); } catch (e) {} }
                    return Promise.resolve(_visibleToOthers);
                }
                return new Promise(function (resolve) {
                    _visibilityWaiters.push(function (answer) {
                        if (hasCb) { try { cb(answer); } catch (e) {} }
                        resolve(answer);
                    });
                    m.classList.add('show');
                });
            };

            // Da/Nu answer from the dialog's buttons (inline onclick in index.html).
            window.answerVisibleToOthers = function (yes) {
                _visibleToOthers = !!yes;
                try { localStorage.setItem('detect_visible_to_others', _visibleToOthers ? 'true' : 'false'); } catch (e) {}
                var m = document.getElementById('visibilityModal');
                if (m) m.classList.remove('show');
                // Apply immediately: publish presence with the new flag, or hide the
                // user right away when they chose "Nu".  (If no GPS fix exists yet,
                // the gated publish happens on the next position tick instead.)
                if (_detLat !== null && typeof publishDetectorPresence === 'function') {
                    publishDetectorPresence(_detLat, _detLng, _presenceVisible());
                }
                // Release every ask waiting on this window, with the same answer.
                var waiters = _visibilityWaiters;
                _visibilityWaiters = [];
                waiters.forEach(function (w) { try { w(_visibleToOthers); } catch (e) {} });
            };

            // ── PROXIMITY DETECTION ──
            // When enabled: heritage sites + radiuses are turned on automatically.
            // Proximity check reads directly from _circleStore (same data the canvas draws).
            // Edge-triggered: alert fires once on entry, resets when user leaves all radiuses.

            var _det = {
                active: false,
                watchId: null,
                wasInside: false,   // was inside a radius on the last GPS tick?
                alertUp: false,   // is the alert currently on screen?
                // What turning detection ON changed on the user's behalf, so turning it
                // OFF can put it back exactly as it was.  null = detection did not
                // change that thing (the user had already enabled it themselves), and
                // in that case OFF must leave it alone rather than switch it off.
                restore: null
            };

            function _playAlarm() {
                try {
                    var ctx = new (window.AudioContext || window.webkitAudioContext)();
                    [[880, 0, 0.18], [660, 0.22, 0.18], [880, 0.44, 0.18], [660, 0.66, 0.18]].forEach(function (t) {
                        var osc = ctx.createOscillator(), gain = ctx.createGain();
                        osc.connect(gain); gain.connect(ctx.destination);
                        osc.type = 'square';
                        osc.frequency.setValueAtTime(t[0], ctx.currentTime + t[1]);
                        gain.gain.setValueAtTime(0.35, ctx.currentTime + t[1]);
                        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t[1] + t[2]);
                        osc.start(ctx.currentTime + t[1]);
                        osc.stop(ctx.currentTime + t[1] + t[2] + 0.05);
                    });
                } catch (e) { console.warn('[DETECT] audio failed', e); }
            }

            function _detIsInside(lat, lng) {
                var R = 6371000;
                var keys = Object.keys(_circleStore);
                for (var ki = 0; ki < keys.length; ki++) {
                    var shapes = _circleStore[keys[ki]];
                    if (!shapes) continue;
                    for (var si = 0; si < shapes.length; si++) {
                        var s = shapes[si];
                        if (s.type !== 'circle') continue;
                        var dLat = (lat - s.latlng.lat) * Math.PI / 180;
                        var dLng = (lng - s.latlng.lng) * Math.PI / 180;
                        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(s.latlng.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                            Math.sin(dLng / 2) * Math.sin(dLng / 2);
                        if (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= s.radius) return true;
                    }
                }
                return false;
            }

            function _detCheck(lat, lng) {
                var inside = _detIsInside(lat, lng);
                if (inside && !_det.wasInside) {
                    _det.wasInside = true;
                    if (!_det.alertUp) {
                        _det.alertUp = true;
                        _playAlarm();
                        document.getElementById('siteAlert').classList.add('visible');
                    }
                } else if (!inside) {
                    _det.wasInside = false;
                    _det.alertUp = false;
                }
            }

            // Called after every new batch of circles loads into _circleStore
            // so if the user is already inside when data arrives, alert fires immediately
            function _detRecheck() {
                if (_det.active && _detLat !== null) _detCheck(_detLat, _detLng);
            }

            var _detLat = null, _detLng = null;

            function _detOnPosition(pos) {
                _detLat = pos.coords.latitude;
                _detLng = pos.coords.longitude;
                // Visible to others only while live location is on AND the user
                // answered "Da" — detection mode is not part of the rule.
                publishDetectorPresence(_detLat, _detLng, _presenceVisible());
                _detCheck(_detLat, _detLng);
            }

            // Patch loadSiteCircles to call _detRecheck after each completed fetch
            var _origLoadSiteCircles = loadSiteCircles;
            loadSiteCircles = function () {
                _origLoadSiteCircles();
            };
            // Patch the internal pending===0 completion by wrapping _hideLoader
            var _origHideLoader = _hideLoader;
            _hideLoader = function () {
                _origHideLoader();
                _detRecheck();
            };

            // userInitiated = true when a real user action flipped the switch
            // (map switch or PWA bottom-bar switch).  Programmatic callers (state
            // restore on resume, auto-enable from the nearby-detectorists search)
            // omit it so the "visible to other users?" Da/Nu prompt only ever
            // appears for genuine user actions — the stored answer is reused for
            // the silent re-activations.
            window.toggleDetection = function (on, userInitiated) {
                _det.active = on;
                document.getElementById('detectWrap').classList.toggle('active', on);

                // ── Notify Service Worker + store state ──
                try {
                    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                        navigator.serviceWorker.controller.postMessage({
                            type: 'SET_DETECTION',
                            enabled: on
                        });
                    }
                    // Persist the switch state together with the timestamp of the moment
                    // it was turned ON.  Both live in localStorage, so they survive app
                    // restarts, phone lock and minimization, and the timestamp drives
                    // the 10-hour auto-OFF timer (see _detEnforceExpiry below).  The
                    // timestamp is only (re)written when missing, so restoring the
                    // switch after an app restart does NOT extend the original window.
                    if (on) {
                        localStorage.setItem('detection_enabled', 'true');
                        if (!localStorage.getItem('detection_enabled_at')) {
                            localStorage.setItem('detection_enabled_at', String(Date.now()));
                        }
                    } else {
                        localStorage.setItem('detection_enabled', 'false');
                        localStorage.removeItem('detection_enabled_at');
                    }
                } catch (e) {}

                if (on) {
                    if (!navigator.geolocation) {
                        alert('Geolocation is not supported by your browser.');
                        document.getElementById('detectSwitch').checked = false;
                        _det.active = false;
                        document.getElementById('detectWrap').classList.remove('active');
                        return;
                    }

                    // Remember what the user had set up BEFORE detection starts
                    // borrowing their layers, so switching detection off can hand it
                    // all back untouched.  Only recorded on a genuine OFF→ON edge:
                    // re-entrant ON calls (state restore on resume, the PWA mirror
                    // switch) must not overwrite the original snapshot with the state
                    // detection itself produced.
                    var _heritageChk = document.querySelector('input[onchange*="togglePatrimoniuLayer"]');
                    if (!_det.restore) {
                        _det.restore = {
                            heritageOn: !!(_heritageChk && _heritageChk.checked),
                            circlesVisible: _circlesVisible,
                            flatOpacity: FLAT_OPACITY,
                            canvasDisplay: _displayCanvas.style.display,
                            sliderValue: (function () {
                                var s = document.getElementById('patrimoniuOpacitySlider');
                                return s ? s.value : null;
                            })(),
                            liveLocationOn: typeof window._isLiveLocationActive === 'function' &&
                                window._isLiveLocationActive()
                        };
                    }

                    // ── Auto-activate live user location on map ──
                    if (typeof window._startLiveLocation === 'function' &&
                        typeof window._isLiveLocationActive === 'function' &&
                        !window._isLiveLocationActive()) {
                        window._startLiveLocation();
                    }

                    // Auto-enable heritage sites layer + radiuses
                    var heritageChk = _heritageChk;
                    if (heritageChk && !heritageChk.checked) {
                        heritageChk.click();   // triggers togglePatrimoniuLayer(true) which calls loadSiteCircles()
                    } else if (!_circlesVisible) {
                        // Heritage toggle already checked but circles somehow off — force on
                        _circlesVisible = true;
                        FLAT_OPACITY = Math.max(FLAT_OPACITY, 0.25);
                        _displayCanvas.style.display = '';
                        var slider = document.getElementById('patrimoniuOpacitySlider');
                        if (slider && parseInt(slider.value, 10) === 0) {
                            slider.value = 25;
                            document.getElementById('patrimoniuPct').textContent = '25%';
                        }
                        loadSiteCircles();
                    }
                    // loadSiteCircles() is now running (or already has data) —
                    // _hideLoader patch will call _detRecheck() when it completes.

                    // If live location is already active, we already have coordinates —
                    // fire an immediate check instead of waiting for the next GPS tick.
                    // Presence is re-published under the same single rule (live
                    // location + "Da"), so turning Detect on never hides anybody who
                    // is already broadcasting and never shows one who is not.
                    if (_detLat !== null) {
                        _detCheck(_detLat, _detLng);
                        if (typeof publishDetectorPresence === 'function') {
                            publishDetectorPresence(_detLat, _detLng, _presenceVisible());
                        }
                    }

                    if (typeof window._isLiveLocationActive !== 'function' ||
                        !window._isLiveLocationActive()) {
                        // Live location is not active → start detection's own GPS watcher
                        _det.watchId = navigator.geolocation.watchPosition(
                            _detOnPosition,
                            function (e) {
                                console.warn('[DETECT] geo error', e.code, e.message);
                                // Notify the nearby-detectorists wait (waitForDetPosition)
                                // so it fails fast when the user denies location permission.
                                if (typeof window._onDetectGeoError === 'function') window._onDetectGeoError(e);
                            },
                            { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
                        );
                    } else {
                        // Live location already active → its watcher handles presence + site checks
                        _det.watchId = null;
                    }

                    // ── Da/Nu visibility prompt ──
                    // Asked only on a genuine user action (the switch under their
                    // finger), never on programmatic restore/auto-enable.  The answer
                    // is persisted and gates every presence publish from now on.
                    if (userInitiated && typeof window._promptVisibleToOthers === 'function') {
                        window._promptVisibleToOthers();
                    }

                } else {
                    if (_det.watchId !== null) {
                        navigator.geolocation.clearWatch(_det.watchId);
                        _det.watchId = null;
                    }
                    document.getElementById('siteAlert').classList.remove('visible');
                    
                    // Re-publish under the presence rule instead of forcing
                    // visible=false: a detectorist who keeps live location on and
                    // consented stays visible (only the live-location switch or a
                    // "Nu" answers hides them now).  Going through
                    // publishDetectorPresence also avoids a race with the
                    // live-location GPS watcher, which would otherwise re-insert
                    // the row on its next tick, and handles the device_id fallback.
                    if (_detLat !== null && typeof publishDetectorPresence === 'function') {
                        publishDetectorPresence(_detLat, _detLng, _presenceVisible());
                    }
                    
                    // ── Hand back everything detection borrowed on the way ON ──
                    // Each item is only reverted if detection is the one that switched
                    // it on; anything the user had enabled themselves is left exactly
                    // as they left it.  Without this the heritage layer, its radius
                    // circles and live location all stayed on for good after a single
                    // use of the detection switch.
                    var _r = _det.restore;
                    _det.restore = null;
                    if (_r) {
                        var chk = document.querySelector('input[onchange*="togglePatrimoniuLayer"]');
                        if (!_r.heritageOn) {
                            // Detection turned the heritage layer on → turn it back off.
                            // Drive it through the checkbox so the panel UI, the WMS
                            // fallback and the heritage images all stay in sync.
                            if (chk && chk.checked) {
                                chk.checked = false;
                                if (typeof window.togglePatrimoniuLayer === 'function') {
                                    window.togglePatrimoniuLayer(false);
                                }
                            } else {
                                _circlesVisible = _r.circlesVisible;
                                _displayCanvas.style.display = _r.canvasDisplay;
                            }
                            // togglePatrimoniuLayer(true) may have nudged a 0% slider up
                            // to 25% — put the user's original value back.
                            var sl = document.getElementById('patrimoniuOpacitySlider');
                            if (sl && _r.sliderValue !== null && sl.value !== _r.sliderValue) {
                                sl.value = _r.sliderValue;
                                var pct = document.getElementById('patrimoniuPct');
                                if (pct) pct.textContent = _r.sliderValue + '%';
                            }
                            FLAT_OPACITY = _r.flatOpacity;
                            if (typeof _scheduleRedraw === 'function') _scheduleRedraw();
                        }

                        // Detection auto-started live location → stop it again. If the
                        // user had it on before, leave it running.
                        if (!_r.liveLocationOn &&
                            typeof window._stopLiveLocation === 'function' &&
                            typeof window._isLiveLocationActive === 'function' &&
                            window._isLiveLocationActive()) {
                            // _det.active is already false, so stopTracking() will not
                            // resurrect detection's own GPS watcher as a fallback.
                            window._stopLiveLocation();
                        }
                    }

                    // Reset edge-trigger flags so the alert fires fresh on re-activation.
                    // Keep _detLat/_detLng — they're needed for the immediate recheck when
                    // the switch is turned back on, and harmless to retain while inactive.
                    _det.wasInside = false;
                    _det.alertUp = false;
                }
            };

            window.dismissSiteAlert = function () {
                document.getElementById('siteAlert').classList.remove('visible');
                // alertUp stays true → won't re-fire while still inside the same radius
                // wasInside stays true → resets only when user physically exits
            };

            // ── DETECTION SWITCH — PERSISTENT STATE + 10-HOUR AUTO-OFF ──
            // Behaviour:
            //  • Once ON, the switch stays ON across app backgrounding, phone lock
            //    and minimization — the state + ON-timestamp live in localStorage
            //    ('detection_enabled' / 'detection_enabled_at'), not in memory.
            //  • After a MAXIMUM of 10 hours the switch turns itself OFF.  The timer
            //    is enforced from the stored timestamp (set the moment the switch was
            //    turned ON), so it survives the app being killed/restarted — unlike
            //    a setTimeout/setInterval, which would reset on every cold start.
            //  • The check runs on cold start, on every return from background
            //    (screen unlock / app switch-back / bfcache restore / refocus) and on
            //    a 1-minute watchdog while the page stays open.
            var DETECT_MAX_AGE_MS = 10 * 60 * 60 * 1000; // 10 hours

            // Keep ALL visible detect switches in sync when the state changes
            // programmatically (restore / auto-enable / expiry): the desktop map
            // switch (#detectSwitch) and its PWA twin under the compass
            // (#pwaDetectBtn, a button rather than a checkbox).
            // We set .checked directly instead of dispatching a synthetic 'change'
            // so the inline onchange handlers don't re-enter toggleDetection().
            function _syncDetectSwitchUI(on) {
                try {
                    var sw = document.getElementById('detectSwitch');
                    if (sw) sw.checked = on;
                    var pwaBtn = document.getElementById('pwaDetectBtn');
                    if (pwaBtn) {
                        pwaBtn.classList.toggle('detect-active', on);
                        pwaBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
                    }
                } catch (e) {}
            }

            function _detPersistedState() {
                try {
                    return {
                        on: localStorage.getItem('detection_enabled') === 'true',
                        since: parseInt(localStorage.getItem('detection_enabled_at') || '0', 10) || 0
                    };
                } catch (e) {
                    return { on: false, since: 0 };
                }
            }

            // Enforce the 10-hour expiry.  Returns true while detection is (or must
            // stay) ON, false when it must be OFF — in which case it also clears the
            // persisted state, stops detection if running, notifies the service worker
            // and syncs every switch UI.
            function _detEnforceExpiry() {
                var st = _detPersistedState();
                if (!st.on) return false;
                var expired = !st.since || (Date.now() - st.since) >= DETECT_MAX_AGE_MS;
                if (!expired) return true;
                // ── 10 hours elapsed (or corrupt timestamp) → auto OFF ──
                try {
                    localStorage.setItem('detection_enabled', 'false');
                    localStorage.removeItem('detection_enabled_at');
                } catch (e) {}
                if (_det.active) {
                    // toggleDetection(false) clears the GPS watcher, hides us from
                    // other detectorists (visible=false) and re-notifies the SW.
                    try { window.toggleDetection(false); } catch (e) {}
                } else {
                    // Cold start with an expired flag — nothing running, just sync the SW.
                    try {
                        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
                            navigator.serviceWorker.controller.postMessage({ type: 'SET_DETECTION', enabled: false });
                        }
                    } catch (e) {}
                }
                _syncDetectSwitchUI(false);
                console.log('[DETECT] 10 hours elapsed — switch turned OFF automatically.');
                return false;
            }

            // Restore the ON state (after app restart or on resume from background)
            // if — and only if — the persisted state is ON and the 10h window has
            // not elapsed.  Expired state flips the switch OFF instead.
            window._detRestorePersistedState = function () {
                if (!_detEnforceExpiry()) return;      // expired (or off) → stays OFF
                if (_det.active) return;               // already running — nothing to do
                if (!_detPersistedState().on) return;  // nothing persisted
                _syncDetectSwitchUI(true);
                try {
                    // The stored timestamp is preserved by toggleDetection (set-if-
                    // missing), so the 10-hour window keeps counting from the moment
                    // the user originally turned the switch ON.
                    window.toggleDetection(true);
                } catch (e) {
                    console.warn('[DETECT] Failed to restore persisted ON state:', e);
                }
            };

            // 1) Cold start / app restart — after full load so every panel, the PWA
            //    controls and the service worker are wired up.  (Geolocation was
            //    already authorised when the user first enabled the switch, so the
            //    GPS watchers resume silently.)
            window.addEventListener('load', function () {
                window._detRestorePersistedState();
            });

            // 2) Returning from background: screen unlock, app switch-back, bfcache
            //    restore, window refocus.  If >10h elapsed while the app was away,
            //    the switch flips OFF right here; otherwise its ON state is re-asserted.
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') window._detRestorePersistedState();
            });
            window.addEventListener('pageshow', function (e) {
                if (e.persisted) window._detRestorePersistedState(); // bfcache restore (iOS back/forward)
            });
            window.addEventListener('focus', function () {
                window._detRestorePersistedState();
            });

            // 3) Watchdog for a page that never leaves the foreground: re-check every minute.
            setInterval(_detEnforceExpiry, 60 * 1000);

            // ── HISTORICAL MAPS — JOSEPHINE LAYER ──
            (function () {
                // [LEGACY / NEUTILIZAT] Mecanism vechi de citire directă a fișierului SQLite
                // din browser (HTTP Range + parsare manuală B-tree). Era folosit înainte ca
                // tile-urile să fie pre-generate ca JPG static în Cloudflare R2 (vezi _jLayer
                // mai jos, care folosește acum direct L.tileLayer cu URL R2).
                // DB_URL ('localhost:7777') nu mai e accesat de nimic activ — getTile()/
                // findTilesRoot()/scanPage() de mai jos nu sunt apelate de nicăieri în fișier.
                // Păstrat doar ca referință istorică; sigur de șters într-o curățare viitoare.
                var DB_URL = 'http://localhost:7777';
                var MIN_ZOOM = 8;
                var _opacity = 0.80;
                var _visible = false;
                var _expanded = false;

                // ── Tile cache: "z/x/y" → blob: URL ──
                var _tileCache = {};
                // ── [LEGACY] SQLite page cache: pageNo → ArrayBuffer ──
                var _pageCache = {};
                var _PAGE_SIZE = 4096;
                var _pagesSizeConfirmed = false;
                var _tilesRootPage = null;   // will be resolved once on first use

                // ── Leaflet GridLayer ──
                map.createPane('pane_josephine');
                map.getPane('pane_josephine').style.zIndex = 650;
                map.getPane('pane_josephine').style.pointerEvents = 'none';

                // ── JOSEPHINE MAP + — visual-source router ───────────────────────────
                // The Cloudflare raster remains the canonical Josephine source for the
                // "Clădiri dispărute" analysis below.  This router affects *only* what is
                // drawn for the premium Josephine Map + layer.
                //
                // FINAL visual rule:
                //   • Supabase is drawn whenever the current map field of view intersects
                //     the authoritative Josephine coverage polygon (the supplied GeoJSON
                //     "Bounds" MultiPolygon).
                //   • Cloudflare is drawn when the field of view is completely outside
                //     that polygon.
                //
                // This is a deterministic geometric viewport/polygon intersection test.
                // It intentionally does not depend on opaque-black tile borders, alpha
                // probing, or whether a sheet edge happens to be visible.
                /* Both pyramids are DEFINED in the shared registry (premium.josephine). */
                var JOSEPHINE_CLOUDFLARE_TILE_URL = DL.url2d('premium.josephine');
                var JOSEPHINE_SUPABASE_TILE_URL = DL.url2d('premium.josephine', 'supabase');
                var JOSEPHINE_SUPABASE_MIN_NATIVE_Z = 10;
                var JOSEPHINE_SUPABASE_MAX_NATIVE_Z = 14;
                var JOSEPHINE_TILE_SIZE = 256;

                var _jCloudflareLayer = L.tileLayer(JOSEPHINE_CLOUDFLARE_TILE_URL, {
                    minZoom: 8,
                    maxZoom: 20,
                    maxNativeZoom: 15,
                    tileSize: JOSEPHINE_TILE_SIZE,
                    opacity: _opacity,
                    pane: 'pane_josephine'
                });

                var _jSupabaseLayer = L.tileLayer(JOSEPHINE_SUPABASE_TILE_URL, {
                    minZoom: 8,
                    maxZoom: 20,
                    minNativeZoom: JOSEPHINE_SUPABASE_MIN_NATIVE_Z,
                    maxNativeZoom: JOSEPHINE_SUPABASE_MAX_NATIVE_Z,
                    tileSize: JOSEPHINE_TILE_SIZE,
                    opacity: _opacity,
                    pane: 'pane_josephine',
                    // The coverage detector below reads the same public PNGs in a canvas.
                    // Supabase Storage serves the public bucket with CORS enabled.
                    crossOrigin: 'anonymous',
                    noWrap: true
                });

                // Keep one stable public layer reference.  Several established features
                // (notably the premium toggle, UAT suppression and Buildings Search UI)
                // already use _jLayerRef/map.hasLayer().  A LayerGroup lets those features
                // continue to see Josephine Map + as active while the visual child switches.
                var _jLayer = L.layerGroup([_jCloudflareLayer]);
                var _jActiveVisualLayer = _jCloudflareLayer;
                var _josephineVisualSource = 'cloudflare';

                _jLayer.setOpacity = function (opacity) {
                    _jCloudflareLayer.setOpacity(opacity);
                    _jSupabaseLayer.setOpacity(opacity);
                    return _jLayer;
                };
                _jLayer.getVisualSource = function () {
                    return _josephineVisualSource;
                };

                window._jLayer = _jLayer;
                window._jLayerRef = _jLayer;
                window._jCloudflareLayer = _jCloudflareLayer;
                window._jSupabaseLayer = _jSupabaseLayer;
                window._josephineVisualSource = _josephineVisualSource;
                window._debugJosephineLayers = function() {
                    var layers = _jLayer.getLayers();
                    console.log('[Josephine] Layers:', layers.length, '| Active:', _jActiveVisualLayer === _jCloudflareLayer ? 'Cloudflare' : 'Supabase');
                    console.log('[Josephine] LayerGroup contents:', layers.map(function(l) { return l === _jCloudflareLayer ? 'Cloudflare' : 'Supabase'; }));
                    console.log('[Josephine] Visual source:', _josephineVisualSource);
                    console.log('[Josephine] Map has _jLayer:', map.hasLayer(_jLayer));
                    console.log('[Josephine] Viewport:', map.getBounds().toBBoxString());
                };
                window._forceJosephineCloudflare = function() {
                    console.log('[Josephine] FORCING Cloudflare');
                    if (_josephineRouteTimer) { clearTimeout(_josephineRouteTimer); _josephineRouteTimer = null; }
                    _josephineRouteRevision++;
                    _setJosephineVisualSource('cloudflare', 'manual force');
                };
                window._forceJosephineSupabase = function() {
                    console.log('[Josephine] FORCING Supabase');
                    if (_josephineRouteTimer) { clearTimeout(_josephineRouteTimer); _josephineRouteTimer = null; }
                    _josephineRouteRevision++;
                    _setJosephineVisualSource('supabase', 'manual force');
                };
                console.log('[Josephine] premium visual router created:', _jLayer, '| map:', typeof map);

                // Supabase coverage polygon (the authoritative "Bounds" MultiPolygon
                // supplied for Josephine Map +).  Coordinates are [lng, lat] in CRS84 /
                // WGS84, exactly as provided.  The Supabase raster must be visible whenever
                // the current field of view intersects this polygon; otherwise Cloudflare
                // remains visible.
                var JOSEPHINE_SUPABASE_COVERAGE_RINGS = (function () {
                    var ring = [
                        [22.70430468610034,45.247334688102356],[23.638068028777383,45.367926236897077],[23.605014459125091,45.47232797441896],[24.996611657254576,45.679964670809881],[25.026897943470658,45.571036068370276],[25.262698314724439,45.596774409900036],[25.330564845692024,45.382520567740876],[25.561796886074816,45.412222000271633],[25.527958050896846,45.520993687078786],[26.012981355114398,45.607859923009656],[26.046820190292372,45.493326261660918],[26.097578443059319,45.501232627996004],[26.249853201360182,45.635471012283972],[26.47544543587998,45.668980483017073],[26.40494786259254,45.728065934757929],[26.447246406565004,45.773322499554453],[26.253057718465055,46.434888850924899],[26.024645581013768,46.401840758416128],[25.987986842904295,46.524212680241497],[26.145901407068152,46.549429795538273],[26.199479562766602,46.607578446430772],[26.185380048109113,46.659858918181207],[25.954148007726332,46.628883994561079],[25.873474999620807,46.908480614600904],[25.834302318047907,46.946379236077917],[25.641703300314504,46.926318600187962],[25.589395834608641,47.02117892481575],[25.555896545080099,47.123848337767278],[25.321401518380316,47.097249333672913],[25.287902228851774,47.184596146953574],[25.248819724401809,47.194081719453777],[25.047823987230558,47.161823856277643],[25.0087414827806,47.269905275879971],[25.215320434873266,47.385327367846287],[25.162279893119742,47.543856553077809],[25.092489706601953,47.573998389723521],[25.036657557387713,47.564580928507873],[24.863577894823589,47.589062805570386],[24.807745745609349,47.573998389723521],[24.701664662102306,47.566464556219522],[24.670956980034468,47.551393637922203],[24.626291260663084,47.590945552762719],[24.400171056345432,47.611651301824551],[24.25500746838842,47.540087604220552],[24.160092814724223,47.57776490007555],[24.026095656610057,47.668079877269442],[23.791600629910267,47.622941892758874],[23.766476162763865,47.592828232225628],[23.696685976246066,47.585297107995764],[23.461348111421387,47.664956792568333],[23.382170328792164,47.650412008614545],[23.335383457238542,47.604326794448177],[23.202220822816678,47.640713234980758],[23.141037990785009,47.626161697892023],[23.065459198275303,47.584910336841432],[23.015073336602168,47.482855721462748],[22.838722820746181,47.453660777123595],[22.788336959073042,47.519326598605439],[22.799133929431573,47.582482773066332],[22.590392502500009,47.606753345087782],[22.349260164492851,47.487719968945669],[22.403245016285499,47.404966497607148],[22.486021789034222,47.344035289823893],[22.575996542021965,47.341596577070383],[22.633580383934124,47.290357584388381],[22.583194522260989,47.236625345313243],[22.496818759392752,47.212183570432316],[22.511214719870789,47.111854460704762],[22.62998139381461,47.131445750757287],[22.662372304890201,47.050585177793295],[22.799133929431573,46.979424530028922],[22.727154127041381,46.824507345310188],[22.798367068661527,46.490617763474347],[22.681412674095011,46.465184456464293],[22.693723662996756,46.422769193484982],[22.718345640800234,46.414282178016634],[22.644479707389795,46.378197624604049],[22.539836301725018,46.401549177927421],[22.422881907158501,46.397304184051613],[22.401337676580461,46.359084377168045],[22.425959654383931,46.335714658648556],[22.385948940453286,46.282564503316486],[22.459814873863717,46.216586630317806],[22.456737126638284,46.127070643869445],[22.456737126638284,46.090796560107783],[22.502903335019806,46.005351604814493],[22.389526818458148,45.885604034745789],[22.473082250426309,45.782478004828569],[22.520828211550974,45.792466295232572],[22.51366631738227,45.76249605464524],[22.56379957656317,45.769157500175211],[22.559024980450701,45.644123019997821],[22.613932835744066,45.550581561954893],[22.492180634876174,45.528844279045181],[22.568574172675632,45.440136076125974],[22.649742306587569,45.453534944589236],[22.683164479374831,45.351288184660618],[22.70430468610034,45.247334688102356]
                    ];
                    return [ring];
                })();

                function _josephinePointInCoverage(lat, lng) {
                    // Standard even-odd ray casting against the outer coverage ring.
                    var inside = false;
                    var ring = JOSEPHINE_SUPABASE_COVERAGE_RINGS[0];
                    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                        var xi = ring[i][0], yi = ring[i][1];
                        var xj = ring[j][0], yj = ring[j][1];
                        var intersects = ((yi > lat) !== (yj > lat)) &&
                            (lng < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi);
                        if (intersects) inside = !inside;
                    }
                    return inside;
                }

                function _josephineSegmentsIntersect(a, b, c, d) {
                    // a,b and c,d are [lng,lat] pairs. Returns true for proper segment
                    // intersection (touching at endpoints is enough to count the FOV as
                    // intersecting the coverage polygon).
                    function ccw(p, q, r) {
                        return (r[1] - p[1]) * (q[0] - p[0]) > (q[1] - p[1]) * (r[0] - p[0]);
                    }
                    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
                }

                function _josephineViewportIntersectsCoverage(bounds) {
                    var west = bounds.getWest(), east = bounds.getEast();
                    var south = bounds.getSouth(), north = bounds.getNorth();
                    var corners = [
                        [west, south], [east, south], [east, north], [west, north]
                    ];
                    
                    var covRing = JOSEPHINE_SUPABASE_COVERAGE_RINGS[0];
                    var covMinX = Infinity, covMaxX = -Infinity, covMinY = Infinity, covMaxY = -Infinity;
                    for (var ci = 0; ci < covRing.length; ci++) {
                        covMinX = Math.min(covMinX, covRing[ci][0]);
                        covMaxX = Math.max(covMaxX, covRing[ci][0]);
                        covMinY = Math.min(covMinY, covRing[ci][1]);
                        covMaxY = Math.max(covMaxY, covRing[ci][1]);
                    }
                    
                    // Check 1: Bounding box overlap
                    var bboxOverlap = !(east < covMinX || west > covMaxX || north < covMinY || south > covMaxY);
                    if (!bboxOverlap) {
                        console.log('[Josephine] viewport outside coverage bbox - Cloudflare');
                        return false;
                    }

                    // Check 2: All corners inside = viewport contained
                    var cornersInside = 0;
                    for (var i = 0; i < corners.length; i++) {
                        if (_josephinePointInCoverage(corners[i][1], corners[i][0])) {
                            cornersInside++;
                        }
                    }
                    if (cornersInside === 4) {
                        console.log('[Josephine] viewport fully inside coverage - Cloudflare');
                        return false;
                    }

                    // Check 3: Coverage vertices inside viewport
                    for (var v = 0; v < covRing.length; v++) {
                        var x = covRing[v][0], y = covRing[v][1];
                        if (x >= west && x <= east && y >= south && y <= north) {
                            console.log('[Josephine] coverage vertex inside viewport - Supabase');
                            return true;
                        }
                    }

                    // Check 4: Edge crossing
                    var rectEdges = [
                        [corners[0], corners[1]],
                        [corners[1], corners[2]],
                        [corners[2], corners[3]],
                        [corners[3], corners[0]]
                    ];
                    for (var k = 0, m = covRing.length - 1; k < covRing.length; m = k++) {
                        var polyA = covRing[m], polyB = covRing[k];
                        for (var e = 0; e < rectEdges.length; e++) {
                            if (_josephineSegmentsIntersect(polyA, polyB, rectEdges[e][0], rectEdges[e][1])) {
                                console.log('[Josephine] coverage edge crosses viewport - Supabase');
                                return true;
                            }
                        }
                    }
                    
                    // No intersection found - this shouldn't happen if bbox overlaps
                    console.log('[Josephine] bbox overlaps but no intersection found - Cloudflare');
                    return false;
                }

                function _doesJosephineViewportNeedSupabase() {
                    var intersects = _josephineViewportIntersectsCoverage(map.getBounds());
                    return Promise.resolve({
                        useSupabase: intersects,
                        reason: intersects
                            ? 'viewport intersects coverage boundary'
                            : 'no intersection'
                    });
                }

                var _josephineRouteTimer = null;
                var _josephineRouteRevision = 0;

                // ── Visual source transition overlay ───────────────────────────────────
                // The map source is swapped only after the Supabase coverage check above.
                // While the new tile layer is loading, show the app's sonar animation over a
                // blurred map so a Cloudflare ↔ Supabase transition never looks like a flash.
                var _josephineTransitionEl = null;
                var _josephineTransitionId = 0;
                var _josephineTransitionStartedAt = 0;
                var _josephineTransitionWait = null;
                var JOSEPHINE_TRANSITION_MIN_MS = 260;
                var JOSEPHINE_TRANSITION_MAX_MS = 3500;

                function _getJosephineTransitionEl() {
                    if (!_josephineTransitionEl) {
                        _josephineTransitionEl = document.getElementById('josephineSourceTransition');
                    }
                    return _josephineTransitionEl;
                }

                function _clearJosephineTransitionWait() {
                    if (!_josephineTransitionWait) return;
                    _josephineTransitionWait.layer.off('load', _josephineTransitionWait.onLoad);
                    clearTimeout(_josephineTransitionWait.timeout);
                    _josephineTransitionWait = null;
                }

                function _beginJosephineTransition() {
                    _clearJosephineTransitionWait();
                    _josephineTransitionId++;
                    _josephineTransitionStartedAt = Date.now();
                    var el = _getJosephineTransitionEl();
                    if (el) {
                        el.setAttribute('aria-hidden', 'false');
                        el.classList.add('is-visible');
                    }
                    return _josephineTransitionId;
                }

                function _finishJosephineTransition(transitionId) {
                    if (!transitionId || transitionId !== _josephineTransitionId) return;
                    var delay = Math.max(0, JOSEPHINE_TRANSITION_MIN_MS - (Date.now() - _josephineTransitionStartedAt));
                    setTimeout(function () {
                        if (transitionId !== _josephineTransitionId) return;
                        var el = _getJosephineTransitionEl();
                        if (el) {
                            el.classList.remove('is-visible');
                            el.setAttribute('aria-hidden', 'true');
                        }
                    }, delay);
                }

                function _cancelJosephineTransition() {
                    _clearJosephineTransitionWait();
                    _josephineTransitionId++;
                    var el = _getJosephineTransitionEl();
                    if (el) {
                        el.classList.remove('is-visible');
                        el.setAttribute('aria-hidden', 'true');
                    }
                }

                function _waitForJosephineVisualLayer(layer, transitionId) {
                    // Register before adding the child layer to the LayerGroup.  Leaflet's
                    // `load` event means every tile requested for the current viewport has
                    // either loaded or errored, which is the right moment to fade away.
                    var settled = false;
                    function settle() {
                        if (settled) return;
                        settled = true;
                        layer.off('load', onLoad);
                        if (_josephineTransitionWait && _josephineTransitionWait.transitionId === transitionId) {
                            clearTimeout(_josephineTransitionWait.timeout);
                            _josephineTransitionWait = null;
                        }
                        _finishJosephineTransition(transitionId);
                    }
                    function onLoad() { settle(); }

                    layer.on('load', onLoad);
                    _josephineTransitionWait = {
                        layer: layer,
                        onLoad: onLoad,
                        transitionId: transitionId,
                        // Never leave the map covered if a remote tile server is unavailable.
                        timeout: setTimeout(settle, JOSEPHINE_TRANSITION_MAX_MS)
                    };
                }

                function _setJosephineVisualSource(source, reason) {
                    var nextLayer = source === 'supabase' ? _jSupabaseLayer : _jCloudflareLayer;
                    var currentSource = _jActiveVisualLayer === _jCloudflareLayer ? 'cloudflare' : 'supabase';
                    
                    console.log('[Josephine] setVisualSource:', currentSource, '->', source, '| reason:', reason);
                    
                    if (_jActiveVisualLayer === nextLayer) {
                        return;
                    }

                    var transitionId = map.hasLayer(_jLayer) ? _beginJosephineTransition() : 0;
                    if (transitionId) _waitForJosephineVisualLayer(nextLayer, transitionId);

                    if (_jLayer.hasLayer(_jActiveVisualLayer)) {
                        _jLayer.removeLayer(_jActiveVisualLayer);
                    }
                    if (!_jLayer.hasLayer(nextLayer)) {
                        _jLayer.addLayer(nextLayer);
                    }
                    
                    _jActiveVisualLayer = nextLayer;
                    _josephineVisualSource = source;
                    window._josephineVisualSource = source;
                    console.log('[Josephine] visual source now:', source);
                }

                function _scheduleJosephineVisualSourceCheck() {
                    if (!map.hasLayer(_jLayer)) return;
                    var revision = ++_josephineRouteRevision;
                    if (_josephineRouteTimer) clearTimeout(_josephineRouteTimer);
                    _josephineRouteTimer = setTimeout(function () {
                        _josephineRouteTimer = null;
                        _doesJosephineViewportNeedSupabase().then(function (decision) {
                            if (revision !== _josephineRouteRevision || !map.hasLayer(_jLayer)) return;
                            _setJosephineVisualSource(decision.useSupabase ? 'supabase' : 'cloudflare', decision.reason);
                        }).catch(function () {
                            // Preserve the Cloudflare view if an unexpected routing issue occurs.
                            if (revision === _josephineRouteRevision && map.hasLayer(_jLayer)) {
                                _setJosephineVisualSource('cloudflare', 'coverage check error');
                            }
                        });
                    }, 60);
                }

                // A stable manual hook is useful after a browser cache is cleared or when
                // inspecting a source tile in DevTools; normal users never need to call it.
                window.refreshJosephineVisualSource = _scheduleJosephineVisualSourceCheck;
                _jLayer.on('add', function () {
                    console.log('[Josephine] layer added to map');
                    // Start from Cloudflare while the coverage intersection check runs;
                    // this avoids a blank flash and avoids loading both visual sources.
                    _setJosephineVisualSource('cloudflare', 'initial coverage check');
                    // Delay the coverage check slightly to ensure map is ready
                    setTimeout(function() {
                        if (map.hasLayer(_jLayer)) {
                            _scheduleJosephineVisualSourceCheck();
                        }
                    }, 100);
                });
                _jLayer.on('remove', function () {
                    _josephineRouteRevision++;
                    _cancelJosephineTransition();
                    if (_josephineRouteTimer) {
                        clearTimeout(_josephineRouteTimer);
                        _josephineRouteTimer = null;
                    }
                });
                map.on('moveend zoomend', _scheduleJosephineVisualSourceCheck);

                // ── "Zoom in" hint ──
                var _hintEl = null;
                function _ensureHint() {
                    if (_hintEl) return;
                    _hintEl = document.createElement('div');
                    _hintEl.id = 'josephineZoomHint';
                    _hintEl.style.cssText = [
                        'position:absolute', 'bottom:18px', 'left:50%',
                        'transform:translateX(-50%)',
                        'background:rgba(6,14,30,0.78)',
                        'color:rgba(200,169,110,0.95)',
                        'border:1px solid rgba(200,169,110,0.4)',
                        'border-radius:6px', 'padding:7px 18px',
                        'font-family:Outfit,sans-serif', 'font-size:0.82rem',
                        'font-weight:500', 'letter-spacing:0.04em',
                        'pointer-events:none', 'z-index:800',
                        'backdrop-filter:blur(6px)', 'display:none',
                        'white-space:nowrap'
                    ].join(';');
                    var mapEl = document.getElementById('detectlab-map');
                    if (mapEl) mapEl.appendChild(_hintEl);
                }
                function _updateHint() {
                    _ensureHint();
                    if (!_hintEl) return;
                    var T = (typeof currentLang !== 'undefined' && translations[currentLang])
                        ? translations[currentLang] : translations['en'];
                    _hintEl.textContent = '🗺 ' + (T.hist_zoom_hint || 'Zoom in to see map');
                    _hintEl.style.display = (_visible && map.getZoom() < MIN_ZOOM) ? '' : 'none';
                }
                map.on('zoomend moveend', _updateHint);

                // Patch setLang to refresh hint text on language change
                setTimeout(function () {
                    var _sl = window.setLang;
                    if (typeof _sl === 'function') {
                        window.setLang = function (lang) { _sl(lang); _updateHint(); };
                    }
                }, 0);

                // ── SQLite helpers ──
                function fetchPage(pageNo, cb) {
                    if (_pageCache[pageNo]) { cb(_pageCache[pageNo]); return; }
                    var off = (pageNo - 1) * _PAGE_SIZE;
                    fetch(DB_URL, { headers: { Range: 'bytes=' + off + '-' + (off + _PAGE_SIZE - 1) } })
                        .then(function (r) { return (r.ok || r.status === 206) ? r.arrayBuffer() : null; })
                        .then(function (buf) {
                            if (!buf) { cb(null); return; }
                            if (pageNo === 1 && !_pagesSizeConfirmed) {
                                var ps = new DataView(buf).getUint16(16);
                                if (ps === 1) ps = 65536;
                                if (ps >= 512) _PAGE_SIZE = ps;
                                _pagesSizeConfirmed = true;
                            }
                            _pageCache[pageNo] = buf; cb(buf);
                        }).catch(function () { cb(null); });
                }

                function ru32(buf, off) { return new DataView(buf).getUint32(off); }

                function readVarint(buf, off) {
                    var u = new Uint8Array(buf), r = 0, b = 0;
                    for (var i = 0; i < 9; i++) {
                        b = u[off + i];
                        if (i < 8) { r = r * 128 + (b & 0x7f); if (!(b & 0x80)) return { v: r, n: i + 1 }; }
                        else { r = r * 256 + b; return { v: r, n: 9 }; }
                    }
                    return { v: r, n: 9 };
                }

                function readSerial(buf, off, s) {
                    var dv = new DataView(buf), u8 = new Uint8Array(buf);
                    if (s === 0) return { v: null, n: 0 };
                    if (s === 1) return { v: dv.getInt8(off), n: 1 };
                    if (s === 2) return { v: dv.getInt16(off), n: 2 };
                    if (s === 3) { var x = (u8[off] << 16) | (u8[off+1] << 8) | u8[off+2]; return { v: x >= 0x800000 ? x - 0x1000000 : x, n: 3 }; }
                    if (s === 4) return { v: dv.getInt32(off), n: 4 };
                    if (s === 5) return { v: dv.getInt16(off) * 4294967296 + dv.getUint32(off+2), n: 6 };
                    if (s === 6 || s === 7) return { v: dv.getFloat64(off), n: 8 };
                    if (s === 8) return { v: 0, n: 0 };
                    if (s === 9) return { v: 1, n: 0 };
                    if (s >= 12 && s % 2 === 0) { var ln = (s - 12) / 2; return { v: buf.slice(off, off + ln), n: ln }; }
                    if (s >= 13 && s % 2 === 1) {
                        var tl = (s - 13) / 2, tb = new Uint8Array(buf, off, tl), ts = '';
                        for (var ci = 0; ci < tb.length; ci++) ts += String.fromCharCode(tb[ci]);
                        return { v: ts, n: tl };
                    }
                    return { v: null, n: 0 };
                }

                function parseRecord(buf, ptr) {
                    var off = ptr;
                    var pl = readVarint(buf, off); off += pl.n;
                    var ri = readVarint(buf, off); off += ri.n;
                    var rs = off;
                    var hl = readVarint(buf, off); off += hl.n;
                    var serials = [];
                    while (off < rs + hl.v) { var sv = readVarint(buf, off); off += sv.n; serials.push(sv.v); }
                    var vals = [];
                    for (var i = 0; i < serials.length; i++) { var rv = readSerial(buf, off, serials[i]); vals.push(rv.v); off += rv.n; }
                    return vals;
                }

                // Find "tiles" table root page from sqlite_master (page 1)
                function findTilesRoot(cb) {
                    if (_tilesRootPage !== null) { cb(_tilesRootPage); return; }
                    fetchPage(1, function (buf) {
                        if (!buf) { cb(null); return; }
                        var dv = new DataView(buf);
                        var ptype = dv.getUint8(100); // page 1 has 100-byte file header
                        var cellCount = dv.getUint16(103);
                        for (var i = 0; i < cellCount; i++) {
                            var cptr = dv.getUint16(108 + i * 2);
                            try {
                                var vals = parseRecord(buf, cptr);
                                // sqlite_master cols: type, name, tbl_name, rootpage, sql
                                if (vals[0] === 'table' && vals[1] === 'tiles') {
                                    _tilesRootPage = vals[3];
                                    cb(_tilesRootPage);
                                    return;
                                }
                            } catch (e) { /* skip */ }
                        }
                        cb(null);
                    });
                }

                // Scan a B-tree page for tile (z, x, y) — columns: x, y, z, image
                function scanPage(pageNo, z, x, y, cb) {
                    fetchPage(pageNo, function (buf) {
                        if (!buf) { cb(null); return; }
                        var dv = new DataView(buf);
                        var ptype = dv.getUint8(0);
                        var cellCount = dv.getUint16(3);

                        if (ptype === 0x0d) { // leaf table
                            for (var i = 0; i < cellCount; i++) {
                                var cptr = dv.getUint16(8 + i * 2);
                                try {
                                    var vals = parseRecord(buf, cptr);
                                    if (vals[0] === x && vals[1] === y && vals[2] === z) {
                                        cb(vals[3] ? new Blob([vals[3]], { type: 'image/jpeg' }) : null);
                                        return;
                                    }
                                } catch (e) { /* skip */ }
                            }
                            cb(null);
                        } else if (ptype === 0x05) { // interior table
                            var rm = ru32(buf, 8);
                            var children = [];
                            for (var j = 0; j < cellCount; j++) {
                                var cp = dv.getUint16(12 + j * 2);
                                children.push(ru32(buf, cp));
                            }
                            children.push(rm);
                            var idx = 0;
                            (function next() {
                                if (idx >= children.length) { cb(null); return; }
                                scanPage(children[idx++], z, x, y, function (b) { b ? cb(b) : next(); });
                            })();
                        } else { cb(null); }
                    });
                }

                function getTile(z, x, y, cb) {
                    findTilesRoot(function (root) {
                        if (!root) { cb(null); return; }
                        scanPage(root, z, x, y, cb);
                    });
                }

                // ── Public API ──
                window.toggleHistLayer = function (on) {
                    _visible = on;

                    // Controlează layer-ul Josephine (cel cu SQLite) — respectă sub-toggle
                    var josToggle = document.getElementById('josephineToggle');
                    var josOn = !josToggle || josToggle.checked; // default on if no toggle yet
                    if (on && josOn) {
                        _jLayer.addTo(map);
                        var pane = map.getPane('pane_josephine');
                        if (pane) pane.style.display = '';
                    } else {
                        map.hasLayer(_jLayer) && map.removeLayer(_jLayer);
                    }

                    // Harta Iosefină (iosfree overlay) — respectă sub-toggle
                    var iosToggle = document.getElementById('iosfreeToggle');
                    var iosOn = !iosToggle || iosToggle.checked;
                    if (!on && _currentOverlay) {
                        if (map.hasLayer(_currentOverlay)) {
                            map.removeLayer(_currentOverlay);
                        }
                    } else if (on && iosOn && _currentOverlay) {
                        _currentOverlay.addTo(map);
                    }

                    _updateHint();
                    var sub = document.getElementById('histSubLayers');
                    if (sub) sub.style.opacity = on ? '1' : '0.45';
                };

                window.toggleHistSubLayers = function () {
                    _expanded = !_expanded;
                    var panel = document.getElementById('histSubLayers');
                    var icon  = document.getElementById('histExpandIcon');
                    if (_expanded) {
                        setSubLayersMaxHeight(panel, true, 900); panel.style.opacity = '1'; panel.style.marginTop = '10px';
                        icon.style.transform = 'rotate(0deg)';
                    } else {
                        setSubLayersMaxHeight(panel, false); panel.style.opacity = '0'; panel.style.marginTop = '0';
                        icon.style.transform = 'rotate(-90deg)';
                    }
                    setTimeout(function() {
                        if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                    }, 350);
                };

                window.setHistOpacity = function (val) {
                    document.getElementById('histOpacityPct').textContent = val + '%';
                    // Apply opacity to Josephine layer if visible
                    if (window._jLayer && map.hasLayer(window._jLayer)) {
                        window._jLayer.setOpacity(val / 100);
                    }
                    // Apply opacity to pane
                    var pane = map.getPane('pane_josephine');
                    if (pane) pane.style.opacity = val / 100;
                };

                window.setJosephineOpacity = function (val) {
                    _opacity = val / 100;
                    document.getElementById('josephinePct').textContent = val + '%';
                    _jLayer.setOpacity(_opacity);
                    var pane = map.getPane('pane_josephine');
                    if (pane) pane.style.opacity = _opacity;
                };

                // ── Patch toggleHistLayer to also control the new WMS layers ──
                var _origToggleHistLayer = window.toggleHistLayer;
                window.toggleHistLayer = function (on) {
                    _origToggleHistLayer(on);
                    // Austrian Map
                    if (window._austrianMapLayer) {
                        var aToggle = document.getElementById('austrianMapToggle');
                        if (!on) {
                            map.hasLayer(window._austrianMapLayer) && map.removeLayer(window._austrianMapLayer);
                        } else if (aToggle && aToggle.checked) {
                            window._austrianMapLayer.addTo(map);
                        }
                    }
                    // Firing Plans
                    if (window._firingPlansLayer) {
                        var fToggle = document.getElementById('firingPlansToggle');
                        if (!on) {
                            map.hasLayer(window._firingPlansLayer) && map.removeLayer(window._firingPlansLayer);
                        } else if (fToggle && fToggle.checked) {
                            window._firingPlansLayer.addTo(map);
                        }
                    }
                    // Soviet Map
                    if (window._sovietMapLayer) {
                        var sToggle = document.getElementById('sovietMapToggle');
                        if (!on) {
                            map.hasLayer(window._sovietMapLayer) && map.removeLayer(window._sovietMapLayer);
                        } else if (sToggle && sToggle.checked) {
                            window._sovietMapLayer.addTo(map);
                        }
                    }
                    // Bucovina 1861-1864, Harta Austro-Ungară, Moldova 1868, Moldova WWII,
                    // Harta tactică poloneză 1933 și WWI sunt acum straturi premium
                    // independente (tab Premium) — nu mai sunt controlate de switch-ul
                    // master Historical Maps.

                    // Oprirea switch-ului mare "Historical Maps" oprește automat toate
                    // switch-urile substraturilor lui (Harta Iosefină gratuită, Harta
                    // Austriacă, Planuri de Tragere, Harta Sovietică) — nu doar stratul
                    // de pe hartă, ci și starea vizuală a switch-ului, ca să nu rămână
                    // "aprins" degeaba.
                    if (!on) {
                        var iosfreeToggleEl = document.getElementById('iosfreeToggle');
                        if (iosfreeToggleEl) iosfreeToggleEl.checked = false;
                        var austrianToggleEl = document.getElementById('austrianMapToggle');
                        if (austrianToggleEl) austrianToggleEl.checked = false;
                        var firingToggleEl = document.getElementById('firingPlansToggle');
                        if (firingToggleEl) firingToggleEl.checked = false;
                        var sovietToggleEl = document.getElementById('sovietMapToggle');
                        if (sovietToggleEl) sovietToggleEl.checked = false;
                        var iosfreeRowEl = document.getElementById('iosfreeRow');
                        if (iosfreeRowEl) iosfreeRowEl.style.opacity = '0.45';
                    }

                    // Actualizăm butonul Buildings Search când Historical Maps e pornit/oprit
                    if (typeof window._refreshIosBldBtnVisibility === 'function') window._refreshIosBldBtnVisibility();
                    if (!on && typeof window.clearIosBldSearchHelp === 'function') window.clearIosBldSearchHelp();
                };

            })(); // end Josephine/Historical Maps

            // ── JOSEPHINE MAP + BUILDINGS SEARCH HELP ────────────────────────────────────
            // Detectează pe Harta Iosefină + (stratul premium) structuri/clădiri istorice
            // folosind un model ONNX (detectlab-v3-best.onnx, servit din Cloudflare R2) în
            // locul vechii euristici de culoare roșie. Poligoanele mai mari returnate de
            // model pot fi opțional subîmpărțite după punctele roșiatice din interior
            // (mai multe clădiri alipite marcate ca un singur box). Rezultatele sunt apoi
            // comparate cu tile-urile raster Buildings/UAT (Cloudflare, vezi
            // uatHasBuildingNear mai sus în fișier) — dacă acolo există deja o clădire
            // modernă, poligonul e ignorat. Exclude și radiusurile siturilor Heritage
            // (același mecanism ca APM 2.0).
            // NOTĂ: filtrul vechi bazat pe distanța până la cel mai apropiat punct OSM
            // (folosit ca să ajusteze pragul de aspect-ratio al clusterelor de culoare) a
            // fost eliminat — nu mai are sens fără detecția pe bază de culoare.
            (function () {
                map.createPane('pane_ios_bld_search_help');
                map.getPane('pane_ios_bld_search_help').style.zIndex = 651;

                // IMPORTANT: this deliberately stays on Cloudflare.  The visual premium
                // layer may switch to Supabase at a map boundary, but "Clădiri dispărute"
                // must always analyse the established Cloudflare Josephine imagery.
                var TILE_URL_JOSEPHINE_PLUS = DL.url2d('premium.josephine');
                var JOSEPHINE_MAX_NATIVE_Z = 15; // ultimul nivel cu tile-uri reale generate static în R2
                var TILE_SIZE  = 256;
                var GRID       = 4;
                // Prag minim de celule GRID×GRID pentru ca un poligon (rezultat din ONNX, sau
                // dintr-o sub-împărțire după puncte roșiatice) să fie considerat valid — sub
                // acest prag e ignorat ca prea mic/zgomot. Expus pe window ca să poată fi
                // coborât live din consolă, fără redeploy.
                window.IOS_BLD_MIN_CLUSTER_CELLS = (window.IOS_BLD_MIN_CLUSTER_CELLS !== undefined) ? window.IOS_BLD_MIN_CLUSTER_CELLS : 4;
                // [LEGACY / NEUTILIZATE] Foloseau la tăierea clusterelor uriașe (>40000 celule) în
                // bucăți de până la 80000 celule, care tot ajungeau desenate ca "clădiri" — doar
                // felii, nu respinse. Înlocuite (2026-07) cu un prag de respingere directă,
                // window.IOS_BLD_MAX_CLUSTER_CELLS (vezi mai jos, lângă filtrul MIN/MAX_CLUSTER_CELLS):
                // orice cluster peste acel prag e aruncat integral, nu mai e tăiat/poligonizat.
                var SPLIT_CLUSTER_CELLS = 40000;
                var MAX_CLUSTER_CELLS   = 80000;
                var MAX_AREA_KM2 = 150;
                // Prag minim de zoom sub care funcționalitatea nu e disponibilă. Coborât la 13
                // (2026-07) ca să fie disponibilă mai devreme; sub acest nivel tile-urile
                // Josephine sunt afișate suficient de mic încât detaliile (clădiri mici, hașură)
                // se pierd prin scalare/antialiasing și rata de fals-pozitive crește.
                // Reglabil live din consolă, fără redeploy: window.IOS_BLD_MIN_ZOOM.
                window.IOS_BLD_MIN_ZOOM = (window.IOS_BLD_MIN_ZOOM !== undefined) ? window.IOS_BLD_MIN_ZOOM : 13;
                // Prag maxim de zoom peste care funcționalitatea nu e disponibilă. Peste
                // nivelul 14, tile-urile raster UAT (Cloudflare R2, nivel nativ 15 — vezi
                // UAT_TILE_Z mai sus în fișier) ajung uneori lipsă/upscalate la randare,
                // ceea ce produce fals-pozitive ("clădire dispărută" deși de fapt tile-ul
                // UAT doar nu s-a randat la acel zoom). Funcționalitatea e limitată strict
                // la zoom 13–14, unde tile-urile UAT sunt randate fiabil. Reglabil live din
                // consolă, fără redeploy: window.IOS_BLD_MAX_ZOOM.
                window.IOS_BLD_MAX_ZOOM = (window.IOS_BLD_MAX_ZOOM !== undefined) ? window.IOS_BLD_MAX_ZOOM : 14;

                // Distanță minimă (metri) față de cea mai apropiată clădire actuală (setul
                // GeoJSON Buildings/UAT, Cloudflare) sub care NU considerăm clădirea drept
                // "dispărută" — chiar dacă bounding box-urile nu se suprapun explicit.
                // Motiv: harta Iosefină + (raster istoric) și tile-urile Buildings actuale
                // au mici erori de georeferențiere/proiecție; o clădire modernă aflată la
                // câțiva zeci de metri e aproape sigur ACEEAȘI clădire, doar ușor deplasată,
                // nu dovada că acolo a dispărut ceva. Peste acest prag, absența unei clădiri
                // apropiate e considerată o dovadă suficient de solidă de dispariție.
                // Reglabil live din consolă, fără redeploy: window.IOS_BLD_MIN_BUILDING_DIST_M.
                window.IOS_BLD_MIN_BUILDING_DIST_M = (window.IOS_BLD_MIN_BUILDING_DIST_M !== undefined) ? window.IOS_BLD_MIN_BUILDING_DIST_M : 150;

                var _running  = false;
                var _resultLG = null;
                var _runGen   = 0; // incrementat la fiecare start/clear, ca să invalidăm callback-urile async "vechi" (Overpass etc.)
                var _hintVisible = false;

                // ── helpers ──────────────────────────────────────────────────────────────

                function _t(key) {
                    var lang = (typeof currentLang !== 'undefined' ? currentLang : 'en') || 'en';
                    var T = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : {};
                    return T[key] || key;
                }

                function _toast(msg, ms) {
                    var el = document.getElementById('iosBldSearchHelpToast');
                    if (!el) return;
                    el.textContent = msg;
                    el.style.display = 'block';
                    clearTimeout(el._t);
                    el._t = setTimeout(function () { el.style.display = 'none'; }, ms || 3500);
                }

                function _areaKm2() {
                    var b = map.getBounds(), lat = (b.getNorth() + b.getSouth()) / 2, r = lat * Math.PI / 180;
                    return (b.getNorth()-b.getSouth()) * 111.32 * (b.getEast()-b.getWest()) * 111.32 * Math.cos(r);
                }

                // ── Tile <-> lat/lng (Web Mercator, identic cu APM 2.0) ──
                function lon2tx(lon,z){ return (lon+180)/360*Math.pow(2,z); }
                function lat2ty(lat,z){ var r=lat*Math.PI/180; return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*Math.pow(2,z); }
                function tx2lon(x,z){ return x/Math.pow(2,z)*360-180; }
                function ty2lat(y,z){ var n=Math.PI-2*Math.PI*y/Math.pow(2,z); return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))); }

                // ── Clasificare pixel roșu (folosită DOAR pentru sub-împărțirea poligoanelor ONNX mari) ──
                // Detecția principală de clădiri se face acum prin modelul ONNX (vezi mai jos,
                // _runOnnxDetection), nu prin culoare. _isRed/_rgb2hsv rămân ca helper opțional:
                // când un poligon detectat de model e prea mare (posibil mai multe clădiri
                // alipite marcate ca un singur box), _splitBoxByRedness caută puncte roșiatice
                // (clădiri pe Harta Iosefină, marcate tradițional cu cerneală roșu-cărămizie) în
                // interiorul boxului și îl împarte în componente conexe pe baza lor.
                // Praguri reglabile live din consolă, fără redeploy:
                //   window.IOS_BLD_HUE_LO / _HUE_HI  → interval de nuanță acceptat (roșu-roz, cu wrap la 0°)
                //   window.IOS_BLD_MIN_SAT            → saturație minimă (0-1)
                //   window.IOS_BLD_MIN_VAL             → luminozitate minimă (0-1), exclude cerneala foarte închisă
                window.IOS_BLD_HUE_LO  = (window.IOS_BLD_HUE_LO  !== undefined) ? window.IOS_BLD_HUE_LO  : 330; // grade, wrap peste 360→0
                window.IOS_BLD_HUE_HI  = (window.IOS_BLD_HUE_HI  !== undefined) ? window.IOS_BLD_HUE_HI  : 30;
                // Prag ridicat 0.14→0.39 (2026-07, iterația "3: calibrare pe date reale"):
                // pragul vechi (0.14) lăsa să treacă tonurile dominante de hârtie îmbătrânită
                // și hașură deschisă (ex. rgb(176,144,112), sat≈0.36), care apar de mii de ori
                // pe orice viewport și nu au nicio legătură cu clădirile — de-asta apăreau
                // "poligoane nonsens" presărate pe versanți goi. 0.39 confirmat manual pe
                // harta reală (zona Szek) ca separă bine cerneala de clădire de fundal/hașură.
                window.IOS_BLD_MIN_SAT = (window.IOS_BLD_MIN_SAT !== undefined) ? window.IOS_BLD_MIN_SAT : 0.39;
                window.IOS_BLD_MIN_VAL = (window.IOS_BLD_MIN_VAL !== undefined) ? window.IOS_BLD_MIN_VAL : 0.42;

                // RGB → HSV. h în [0,360), s și v în [0,1].
                function _rgb2hsv(r, g, b) {
                    r /= 255; g /= 255; b /= 255;
                    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
                    var h = 0;
                    if (d !== 0) {
                        if (max === r)      h = ((g - b) / d) % 6;
                        else if (max === g) h = (b - r) / d + 2;
                        else                 h = (r - g) / d + 4;
                        h *= 60;
                        if (h < 0) h += 360;
                    }
                    var s = max === 0 ? 0 : d / max;
                    return { h: h, s: s, v: max };
                }

                function _isRed(r, g, b) {
                    if (r + g + b < 30) return false;
                    var hsv = _rgb2hsv(r, g, b);
                    // Interval de nuanță cu wrap peste 0°/360° (roșu-cărămiziu → roz).
                    var hueOk = (window.IOS_BLD_HUE_LO <= window.IOS_BLD_HUE_HI)
                        ? (hsv.h >= window.IOS_BLD_HUE_LO && hsv.h <= window.IOS_BLD_HUE_HI)
                        : (hsv.h >= window.IOS_BLD_HUE_LO || hsv.h <= window.IOS_BLD_HUE_HI);
                    if (!hueOk) return false;
                    if (hsv.s < window.IOS_BLD_MIN_SAT) return false;
                    if (hsv.v < window.IOS_BLD_MIN_VAL) return false;
                    return true;
                }

                // Verifică dacă un cluster de celule (grilă GRID×GRID) conține ORICE pixel
                // roșiatic (cerneala tradițională pentru clădiri de pe Harta Iosefină) — spre
                // deosebire de _splitBoxByRedness (care cere o densitate minimă pentru a
                // împărți un poligon mare), aici e suficient un singur pixel pentru a considera
                // clusterul "confirmat" prin culoare și a-i crește scorul de încredere.
                function _clusterHasRed(cells, cols, data, compW, compH) {
                    for (var ci = 0; ci < cells.length; ci++) {
                        var gx = cells[ci] % cols, gy = (cells[ci] - gx) / cols;
                        for (var sy = 0; sy < GRID; sy++) {
                            for (var sx = 0; sx < GRID; sx++) {
                                var spx = gx * GRID + sx, spy = gy * GRID + sy;
                                if (spx >= compW || spy >= compH) continue;
                                var pi = (spy * compW + spx) * 4;
                                if (_isRed(data[pi], data[pi+1], data[pi+2])) return true;
                            }
                        }
                    }
                    return false;
                }

                // ── Pas SUPLIMENTAR de poligonizare ("Detector pas adițional") ──────────
                // Criteriu extra, opțional (implicit activ, comutabil din panoul de Setări),
                // aplicat DUPĂ confirmarea obligatorie de roșeață (_clusterHasRed) și ÎNAINTE
                // de verificarea vs Buildings/Overpass. Pornește de la particularitățile
                // vizuale comune identificate pe mostre reale de simbol de clădire de pe
                // Harta Iosefină (contur rotunjit tip "blob", nu poligon geometric drept;
                // umbrire internă parțială — o latură mai închisă, convenție grafică veche
                // pentru relief/acoperiș) și respinge clustere care, deși conțin un pixel
                // roșiatic izolat, nu au și restul semnăturii formă+textură a simbolului —
                // reducând fals-pozitivele de tip "pată/zgomot" sau "hașură dreaptă".
                window.IOS_BLD_EXTRA_MIN_COMPACTNESS = (window.IOS_BLD_EXTRA_MIN_COMPACTNESS !== undefined) ? window.IOS_BLD_EXTRA_MIN_COMPACTNESS : 0.42;
                window.IOS_BLD_EXTRA_MIN_GRAD_STD    = (window.IOS_BLD_EXTRA_MIN_GRAD_STD    !== undefined) ? window.IOS_BLD_EXTRA_MIN_GRAD_STD    : 6;

                function _extraShapeColorValidation(cells, cols, data, compW, compH) {
                    // 1) Compactitate = arie_cluster / arie_bounding_box (0-1). Formele
                    //    rotunjite ("blob") specifice simbolului au compactitate ridicată;
                    //    resping forme alungite/sparse (linii de drum, umbre difuze, zgomot).
                    var gx0=Infinity, gx1=-Infinity, gy0=Infinity, gy1=-Infinity;
                    cells.forEach(function(i){
                        var gx=i%cols, gy=(i-gx)/cols;
                        if(gx<gx0)gx0=gx; if(gx>gx1)gx1=gx;
                        if(gy<gy0)gy0=gy; if(gy>gy1)gy1=gy;
                    });
                    var bboxCells = (gx1-gx0+1) * (gy1-gy0+1);
                    var compactness = bboxCells > 0 ? (cells.length / bboxCells) : 0;
                    if (compactness < window.IOS_BLD_EXTRA_MIN_COMPACTNESS) {
                        return { pass: false, reason: 'compactitate ' + compactness.toFixed(2) + ' < ' + window.IOS_BLD_EXTRA_MIN_COMPACTNESS };
                    }

                    // 2) Umbrire internă: deviația standard a luminozității (V din HSV) în
                    //    interiorul clusterului. Simbolul tradițional are gradient intern
                    //    (nu e o pată complet uniformă); o deviație ~0 sugerează cerneală
                    //    vărsată/zgomot de scanare, nu o clădire desenată.
                    var vals = [];
                    cells.forEach(function(i){
                        var gx=i%cols, gy=(i-gx)/cols;
                        for (var sy=0; sy<GRID; sy++){
                            for (var sx=0; sx<GRID; sx++){
                                var spx=gx*GRID+sx, spy=gy*GRID+sy;
                                if (spx>=compW || spy>=compH) continue;
                                var pi=(spy*compW+spx)*4;
                                vals.push(_rgb2hsv(data[pi], data[pi+1], data[pi+2]).v*255);
                            }
                        }
                    });
                    if (!vals.length) return { pass: false, reason: 'fără pixeli eșantionați' };
                    var mean = vals.reduce(function(a,b){return a+b;},0)/vals.length;
                    var variance = vals.reduce(function(a,b){return a+(b-mean)*(b-mean);},0)/vals.length;
                    var std = Math.sqrt(variance);
                    if (std < window.IOS_BLD_EXTRA_MIN_GRAD_STD) {
                        return { pass: false, reason: 'gradient intern ' + std.toFixed(1) + ' < ' + window.IOS_BLD_EXTRA_MIN_GRAD_STD };
                    }

                    return { pass: true, compactness: compactness, gradStd: std };
                }

                // ── Încărcare tile cu CORS (identic cu APM 2.0 _loadTileImage) ──
                var _CB = '_josbld=' + Math.random().toString(36).slice(2);
                var _tileOkCount = 0, _tileFailCount = 0;
                function _loadTile(url) {
                    return new Promise(function (resolve) {
                        function try1(cors) {
                            var img = new Image();
                            var src = url;
                            if (cors) { img.crossOrigin = 'anonymous'; src += (url.indexOf('?') < 0 ? '?' : '&') + _CB; }
                            img.onload = function () {
                                _tileOkCount++;
                                console.log('[IosBld+] Tile OK (cors=' + cors + '):', src);
                                resolve(img);
                            };
                            img.onerror = function () {
                                if (cors) {
                                    console.warn('[IosBld+] Tile fail (CORS try), retrying fără CORS:', src);
                                    try1(false);
                                } else {
                                    _tileFailCount++;
                                    console.error('[IosBld+] Tile FAILED complet (Josephine Map+ tile server inaccesibil):', src);
                                    resolve(null);
                                }
                            };
                            img.src = src;
                        }
                        try1(true);
                    });
                }

                // ── BFS flood-fill (8-conectivitate) ──
                function _connComp(mask, cols, rows) {
                    var vis = new Uint8Array(cols * rows), comps = [];
                    var dxs = [-1,1,0,0,-1,1,-1,1], dys = [0,0,-1,1,-1,-1,1,1];
                    for (var idx = 0; idx < cols * rows; idx++) {
                        if (vis[idx] || !mask[idx]) continue;
                        var st = [idx], cells = []; vis[idx] = 1;
                        while (st.length) {
                            var c = st.pop(); cells.push(c);
                            var cx = c % cols, cy = (c - cx) / cols;
                            for (var d = 0; d < 8; d++) {
                                var nx = cx+dxs[d], ny = cy+dys[d];
                                if (nx<0||ny<0||nx>=cols||ny>=rows) continue;
                                var ni = ny*cols+nx;
                                if (!vis[ni] && mask[ni]) { vis[ni]=1; st.push(ni); }
                            }
                        }
                        comps.push(cells);
                    }
                    return comps;
                }

                // ── Convex hull (monotone chain) ──
                function _hull(pts) {
                    if (pts.length < 3) return pts;
                    pts = pts.slice().sort(function(a,b){ return a[0]-b[0]||a[1]-b[1]; });
                    function cr(o,a,b){ return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]); }
                    var lo=[], hi=[];
                    for (var i=0;i<pts.length;i++){ while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],pts[i])<=0)lo.pop(); lo.push(pts[i]); }
                    for (var j=pts.length-1;j>=0;j--){ while(hi.length>=2&&cr(hi[hi.length-2],hi[hi.length-1],pts[j])<=0)hi.pop(); hi.push(pts[j]); }
                    hi.pop(); lo.pop(); return lo.concat(hi);
                }

                // ── Moore neighborhood tracing (contur cluster) ──
                function _contour(cells, cols, csz) {
                    var cs = {}; cells.forEach(function(i){ cs[i]=true; });
                    function has(x,y){ return x>=0&&y>=0&&!!cs[y*cols+x]; }
                    var si = cells.reduce(function(b,i){ var bx=b%cols,by=(b-bx)/cols,ix=i%cols,iy=(i-ix)/cols; return (iy<by||(iy===by&&ix<bx))?i:b; }, cells[0]);
                    var sx=si%cols, sy=(si-sx)/cols;
                    var dxs=[1,1,0,-1,-1,-1,0,1], dys=[0,1,1,1,0,-1,-1,-1];
                    var out=[], cx=sx, cy=sy, dir=7, max=cells.length*4+8, steps=0;
                    do {
                        out.push([cx*csz+csz/2, cy*csz+csz/2]);
                        var bd=(dir+4)%8, ok=false;
                        for (var d=0;d<8;d++){ var nd=(bd+1+d)%8, nx=cx+dxs[nd], ny=cy+dys[nd]; if(has(nx,ny)){ cx=nx;cy=ny;dir=nd;ok=true;break; } }
                        if (!ok) break;
                    } while ((cx!==sx||cy!==sy) && ++steps<max);
                    if (out.length<3) { var ps=cells.map(function(i){ var x=i%cols,y=(i-x)/cols; return [x*csz+csz/2,y*csz+csz/2]; }); return _hull(ps); }
                    return out;
                }

                // ── Bisecție geometrică pentru clustere mari ──
                function _split(cells, cols, max) {
                    if (cells.length <= max) return [cells];
                    var ps = cells.map(function(i){ var x=i%cols,y=(i-x)/cols; return {i:i,x:x,y:y}; });
                    var mnX=Infinity,mxX=-Infinity,mnY=Infinity,mxY=-Infinity;
                    ps.forEach(function(p){ if(p.x<mnX)mnX=p.x; if(p.x>mxX)mxX=p.x; if(p.y<mnY)mnY=p.y; if(p.y>mxY)mxY=p.y; });
                    var onX = (mxX-mnX) >= (mxY-mnY);
                    ps.sort(function(a,b){ return onX?(a.x-b.x):(a.y-b.y); });
                    var mid = Math.floor(ps.length/2);
                    return _split(ps.slice(0,mid).map(function(p){return p.i;}), cols, max)
                          .concat(_split(ps.slice(mid).map(function(p){return p.i;}), cols, max));
                }

                // ── Detecție ONNX (model detectlab-v3-best.onnx, Cloudflare R2) ──────────
                // Înlocuiește vechea euristică de culoare roșie + filtre de formă/aspect (care
                // depindeau de distanța până la cel mai apropiat punct OSM). Modelul rulează
                // direct pe imaginea compusă din tile-urile Josephine Map+ și întoarce
                // bounding box-uri pentru clădiri/structuri istorice.
                var ONNX_MODEL_URL = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/detectlab-v3-best.onnx';
                // Praguri reglabile live din consolă, fără redeploy:
                window.IOS_BLD_ONNX_INPUT_SIZE   = (window.IOS_BLD_ONNX_INPUT_SIZE   !== undefined) ? window.IOS_BLD_ONNX_INPUT_SIZE   : 640;  // fallback dacă metadata modelului nu expune dimensiunea de intrare
                window.IOS_BLD_ONNX_CONF         = (window.IOS_BLD_ONNX_CONF         !== undefined) ? window.IOS_BLD_ONNX_CONF         : 0.25; // prag minim de încredere per detecție
                window.IOS_BLD_ONNX_IOU          = (window.IOS_BLD_ONNX_IOU          !== undefined) ? window.IOS_BLD_ONNX_IOU          : 0.45; // prag IoU pentru NMS
                window.IOS_BLD_ONNX_TILE_OVERLAP = (window.IOS_BLD_ONNX_TILE_OVERLAP !== undefined) ? window.IOS_BLD_ONNX_TILE_OVERLAP : 0.2;  // suprapunere între decupajele trimise modelului (0-1)
                // Arie (px² pe canvas-ul compus) peste care un poligon ONNX e considerat "prea
                // mare" pentru o singură clădire și e împărțit după punctele roșiatice din
                // interior (opțional — vezi _splitBoxByRedness mai jos).
                // [LEGACY / NEUTILIZAT activ] Fostul prag de arie de la care se aplica
                // split-ul după roșeață. De la introducerea _tightenBoxToRedCells (2026-07),
                // strângerea la celule roșii rulează pe FIECARE box, indiferent de mărime,
                // deci acest prag nu mai controlează comportamentul — lăsat declarat doar
                // pentru compatibilitate cu eventuale referințe externe/console.
                window.IOS_BLD_ONNX_SPLIT_AREA_PX2 = (window.IOS_BLD_ONNX_SPLIT_AREA_PX2 !== undefined) ? window.IOS_BLD_ONNX_SPLIT_AREA_PX2 : 2500;
                window.IOS_BLD_ONNX_SPLIT_ENABLED  = (window.IOS_BLD_ONNX_SPLIT_ENABLED  !== undefined) ? window.IOS_BLD_ONNX_SPLIT_ENABLED  : true;

                // Limită DURĂ de mărime (px pe canvas-ul compus) pentru orice poligon FINAL,
                // aplicată indiferent dacă split-ul după roșeață (mai sus) a găsit ceva sau
                // nu. Motiv: un box ONNX mare care acoperă un grup dens de clădiri poate să
                // nu aibă pixeli roșiatici suficient de clari (hașură, cerneală decolorată,
                // etc.), caz în care _splitBoxByRedness întoarce [] și boxul rămânea întreg
                // — un singur poligon uriaș peste multe clădiri, imposibil de comparat corect
                // cu tile-ul vectorial Buildings (unde clădirile sunt separate). Aici tăiem
                // orice poligon mai mare de acest prag pe o grilă fixă de bucăți de cel mult
                // IOS_BLD_ONNX_MAX_POLY_PX pe fiecare axă, păstrând doar celulele reale din
                // fiecare bucată (nu dreptunghiuri goale) — rezultă mai multe poligoane mici,
                // fiecare verificat individual față de Buildings. Reglabil live din consolă,
                // fără redeploy: window.IOS_BLD_ONNX_MAX_POLY_PX.
                window.IOS_BLD_ONNX_MAX_POLY_PX = (window.IOS_BLD_ONNX_MAX_POLY_PX !== undefined) ? window.IOS_BLD_ONNX_MAX_POLY_PX : 44;

                var _ortSessionPromise = null;
                function _getOnnxSession() {
                    if (!_ortSessionPromise) {
                        if (typeof ort === 'undefined') {
                            console.error('[IosBld+][ONNX] onnxruntime-web (ort) nu e încărcat — verifică tag-ul <script> din <head>.');
                            return Promise.reject(new Error('onnxruntime-web (ort) nu e încărcat'));
                        }
                        try { ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/'; } catch(e) {}
                        console.log('[IosBld+][ONNX] Încarc modelul:', ONNX_MODEL_URL);
                        _ortSessionPromise = ort.InferenceSession.create(ONNX_MODEL_URL, { executionProviders: ['wasm'] })
                            .then(function(session) {
                                console.log('[IosBld+][ONNX] Model încărcat. Input(uri):', session.inputNames, '| Output(uri):', session.outputNames);
                                return session;
                            })
                            .catch(function(err) {
                                console.error('[IosBld+][ONNX] Eroare la încărcarea modelului:', err);
                                _ortSessionPromise = null;
                                throw err;
                            });
                    }
                    return _ortSessionPromise;
                }

                // Dimensiunea de intrare așteptată de model (presupusă pătrată H=W). Încearcă
                // să o citească din metadata sesiunii; dacă nu e disponibilă (variază între
                // versiunile onnxruntime-web), folosește window.IOS_BLD_ONNX_INPUT_SIZE.
                function _onnxInputSize(session) {
                    try {
                        var meta = session.inputMetadata && session.inputMetadata[0];
                        var dims = meta && (meta.dimensions || meta.shape);
                        if (dims && dims.length === 4 && typeof dims[2] === 'number' && dims[2] > 0 && typeof dims[3] === 'number' && dims[3] > 0) {
                            return { w: dims[3], h: dims[2] };
                        }
                    } catch (e) { /* fallback mai jos */ }
                    return { w: window.IOS_BLD_ONNX_INPUT_SIZE, h: window.IOS_BLD_ONNX_INPUT_SIZE };
                }

                // Decupează o regiune din canvas-ul sursă, o redimensionează la (tw x th) și
                // întoarce un ort.Tensor float32 NCHW normalizat [0,1] (RGB).
                function _canvasCropToTensor(srcCanvas, sx, sy, sw, sh, tw, th) {
                    var c = document.createElement('canvas');
                    c.width = tw; c.height = th;
                    var cctx = c.getContext('2d');
                    cctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, tw, th);
                    var d = cctx.getImageData(0, 0, tw, th).data;
                    var floatData = new Float32Array(3 * tw * th);
                    var plane = tw * th;
                    for (var i = 0; i < plane; i++) {
                        var pi = i * 4;
                        floatData[i]         = d[pi]   / 255; // R
                        floatData[plane + i] = d[pi+1] / 255; // G
                        floatData[2*plane+i] = d[pi+2] / 255; // B
                    }
                    return new ort.Tensor('float32', floatData, [1, 3, th, tw]);
                }

                function _iou(a, b) {
                    var x1 = Math.max(a.x0, b.x0), y1 = Math.max(a.y0, b.y0);
                    var x2 = Math.min(a.x1, b.x1), y2 = Math.min(a.y1, b.y1);
                    var iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1);
                    var inter = iw * ih;
                    var areaA = (a.x1-a.x0)*(a.y1-a.y0), areaB = (b.x1-b.x0)*(b.y1-b.y0);
                    var uni = areaA + areaB - inter;
                    return uni <= 0 ? 0 : inter / uni;
                }

                function _nms(boxes) {
                    boxes = boxes.slice().sort(function(a,b){ return b.score - a.score; });
                    var kept = [];
                    boxes.forEach(function(b) {
                        for (var i = 0; i < kept.length; i++) {
                            if (_iou(b, kept[i]) > window.IOS_BLD_ONNX_IOU) return;
                        }
                        kept.push(b);
                    });
                    return kept;
                }

                // Parsează output-ul brut (format tipic export Ultralytics/YOLO: [1, 4+nc, N]
                // sau [1, N, 4+nc]) și întoarce box-uri {x0,y0,x1,y1,score} în spațiul de
                // pixeli al input-ului modelului (tw x th).
                function _parseYoloOutput(outputTensor, tw, th) {
                    var dims = outputTensor.dims, data = outputTensor.data;
                    if (!dims || dims.length !== 3) { console.warn('[IosBld+][ONNX] Format output neașteptat (dims):', dims); return []; }
                    var d1 = dims[1], d2 = dims[2];
                    var anchorsFirst = d1 > d2; // adică forma e [1, N, C] în loc de [1, C, N]
                    var N = anchorsFirst ? d1 : d2;
                    var C = anchorsFirst ? d2 : d1;
                    var nc = Math.max(1, C - 4);
                    var boxes = [];
                    for (var i = 0; i < N; i++) {
                        var val = anchorsFirst
                            ? function(ch){ return data[i*C + ch]; }
                            : function(ch){ return data[ch*N + i]; };
                        var cx = val(0), cy = val(1), w = val(2), h = val(3);
                        var bestScore = 0;
                        for (var c = 0; c < nc; c++) { var s = val(4 + c); if (s > bestScore) bestScore = s; }
                        if (bestScore < window.IOS_BLD_ONNX_CONF) continue;
                        boxes.push({ x0: cx - w/2, y0: cy - h/2, x1: cx + w/2, y1: cy + h/2, score: bestScore });
                    }
                    return boxes;
                }

                // Rulează modelul pe canvas-ul compus (decupat în ferestre de dimensiunea de
                // intrare a modelului, cu suprapunere + NMS global) și întoarce o listă de
                // "componente" (array-uri de indici de celule GRID×GRID) — exact formatul pe
                // care restul pipeline-ului (heritage mask, _contour, verificare Buildings) îl
                // aștepta și de la vechea detecție pe bază de culoare.
                function _runOnnxDetection(imgData, compW, compH, cols, rows) {
                    return _getOnnxSession().then(function(session) {
                        var inSize = _onnxInputSize(session);
                        var srcCanvas = document.createElement('canvas');
                        srcCanvas.width = compW; srcCanvas.height = compH;
                        srcCanvas.getContext('2d').putImageData(imgData, 0, 0);

                        var stepW = Math.max(1, Math.round(inSize.w * (1 - window.IOS_BLD_ONNX_TILE_OVERLAP)));
                        var stepH = Math.max(1, Math.round(inSize.h * (1 - window.IOS_BLD_ONNX_TILE_OVERLAP)));
                        var crops = [];
                        for (var oy = 0; oy < compH; oy += stepH) {
                            for (var ox = 0; ox < compW; ox += stepW) {
                                var cw = Math.min(inSize.w, compW - ox), ch = Math.min(inSize.h, compH - oy);
                                if (cw < 8 || ch < 8) continue;
                                crops.push({ ox: ox, oy: oy, cw: cw, ch: ch });
                            }
                        }
                        console.log('[IosBld+][ONNX] Decupaje de inferență:', crops.length, '| dimensiune model:', inSize.w+'x'+inSize.h);

                        var allBoxes = [];
                        var inputName = session.inputNames[0];

                        function runOne(idx) {
                            if (idx >= crops.length) return Promise.resolve();
                            var crop = crops[idx];
                            var tensor = _canvasCropToTensor(srcCanvas, crop.ox, crop.oy, crop.cw, crop.ch, inSize.w, inSize.h);
                            var feeds = {}; feeds[inputName] = tensor;
                            return session.run(feeds).then(function(results) {
                                var outName = session.outputNames[0];
                                var out = results[outName] || results[Object.keys(results)[0]];
                                var boxes = _parseYoloOutput(out, inSize.w, inSize.h);
                                var scaleX = crop.cw / inSize.w, scaleY = crop.ch / inSize.h;
                                boxes.forEach(function(b) {
                                    allBoxes.push({
                                        x0: crop.ox + b.x0*scaleX, y0: crop.oy + b.y0*scaleY,
                                        x1: crop.ox + b.x1*scaleX, y1: crop.oy + b.y1*scaleY,
                                        score: b.score
                                    });
                                });
                                return runOne(idx + 1);
                            });
                        }

                        return runOne(0).then(function() {
                            console.log('[IosBld+][ONNX] Detecții brute (înainte de NMS):', allBoxes.length);
                            var kept = _nms(allBoxes);
                            console.log('[IosBld+][ONNX] Detecții după NMS:', kept.length,
                                '(prag conf=' + window.IOS_BLD_ONNX_CONF + ', IoU=' + window.IOS_BLD_ONNX_IOU + ')');

                            var bigComps = [];
                            var _droppedNoRed = 0;
                            kept.forEach(function(box) {
                                var areaPx2 = (box.x1-box.x0) * (box.y1-box.y0);
                                // Strângem ÎNTOTDEAUNA boxul la celulele cu cerneală roșie reală —
                                // nu doar pentru boxuri "mari" ca înainte. Asta evită poligoane
                                // largi desenate peste teren gol în jurul unei clădiri mici.
                                var pieces = window.IOS_BLD_ONNX_SPLIT_ENABLED
                                    ? _tightenBoxToRedCells(imgData.data, compW, compH, cols, rows, box)
                                    : [_boxToCells(box, cols)];
                                if (!pieces.length) {
                                    // Nicio urmă de roșu în tot boxul → nu mai desenăm boxul întreg
                                    // (comportamentul vechi). Aruncăm complet detecția.
                                    _droppedNoRed++;
                                    return;
                                }
                                if (pieces.length > 1 || (pieces[0] && pieces[0].length < _boxToCells(box, cols).length)) {
                                    console.log('[IosBld+][ONNX] Box (' + Math.round(areaPx2) + 'px²) strâns la', pieces.length, 'sub-poligon(oane) pe baza punctelor roșiatice (bulinele clădirii), în loc de boxul YOLO întreg.');
                                }
                                // Capare finală de mărime maximă (grilă fixă) — rulează întotdeauna,
                                // ca plasă de siguranță pentru clustere anormal de mari rămase
                                // după strângere. Vezi window.IOS_BLD_ONNX_MAX_POLY_PX mai sus.
                                pieces.forEach(function(p) {
                                    var capped = _capPolygonSize(p, cols);
                                    if (capped.length > 1) {
                                        console.log('[IosBld+][ONNX] Poligon peste limita de', window.IOS_BLD_ONNX_MAX_POLY_PX, 'px → tăiat în', capped.length, 'bucăți (grilă fixă).');
                                    }
                                    // Păstrăm scorul de încredere al detecției ONNX-sursă alături de fiecare
                                    // bucată rezultată (folosit apoi în popup-ul de feedback 👍/👎).
                                    capped.forEach(function(c) { bigComps.push({ cells: c, score: box.score }); });
                                });
                            });
                            if (_droppedNoRed) {
                                console.log('[IosBld+][ONNX] Boxuri aruncate complet (fără nicio urmă de roșu în interior):', _droppedNoRed, '/', kept.length);
                            }
                            return bigComps;
                        });
                    });
                }

                // Taie un poligon (listă de indici de celule GRID×GRID) într-o grilă fixă de
                // bucăți de cel mult window.IOS_BLD_ONNX_MAX_POLY_PX pe fiecare axă, dacă
                // bounding box-ul lui depășește acest prag. Păstrează doar celulele reale din
                // fiecare bucată (nu creează dreptunghiuri goale) și elimină bucățile prea
                // mici (sub IOS_BLD_MIN_CLUSTER_CELLS). Dacă poligonul e deja sub prag, sau
                // dacă toate bucățile rezultate ar fi eliminate ca prea mici, întoarce
                // poligonul original neschimbat (nu aruncăm date bune din cauza limitei).
                function _capPolygonSize(cells, cols) {
                    var maxCellsPerSide = Math.max(1, Math.round((window.IOS_BLD_ONNX_MAX_POLY_PX || 70) / GRID));
                    var gx0=Infinity, gx1=-Infinity, gy0=Infinity, gy1=-Infinity;
                    cells.forEach(function(i){
                        var gx=i%cols, gy=(i-gx)/cols;
                        if(gx<gx0)gx0=gx; if(gx>gx1)gx1=gx;
                        if(gy<gy0)gy0=gy; if(gy>gy1)gy1=gy;
                    });
                    var w = gx1-gx0+1, h = gy1-gy0+1;
                    if (w <= maxCellsPerSide && h <= maxCellsPerSide) return [cells];

                    var buckets = {};
                    cells.forEach(function(i){
                        var gx=i%cols, gy=(i-gx)/cols;
                        var bx = Math.floor((gx-gx0)/maxCellsPerSide);
                        var by = Math.floor((gy-gy0)/maxCellsPerSide);
                        var key = bx+'_'+by;
                        (buckets[key] = buckets[key] || []).push(i);
                    });
                    var out = [];
                    Object.keys(buckets).forEach(function(k){
                        var piece = buckets[k];
                        if (piece.length >= (window.IOS_BLD_MIN_CLUSTER_CELLS || 2)) out.push(piece);
                    });
                    return out.length ? out : [cells];
                }

                // Rasterizează un bounding box (px pe canvas-ul compus) în indici de celule
                // GRID×GRID — aceeași grilă folosită de heritage mask / _contour / etc.
                function _boxToCells(box, cols) {
                    var gx0 = Math.max(0, Math.floor(box.x0 / GRID));
                    var gx1 = Math.max(gx0, Math.floor((box.x1 - 1) / GRID));
                    var gy0 = Math.max(0, Math.floor(box.y0 / GRID));
                    var gy1 = Math.max(gy0, Math.floor((box.y1 - 1) / GRID));
                    var cells = [];
                    for (var gy = gy0; gy <= gy1; gy++) {
                        for (var gx = gx0; gx <= Math.min(gx1, cols - 1); gx++) {
                            cells.push(gy * cols + gx);
                        }
                    }
                    return cells;
                }

                // Împarte un poligon ONNX prea mare în bucăți mai mici, urmărind punctele
                // roșiatice din interiorul lui (reutilizează _isRed + _connComp existente) —
                // util când modelul marchează mai multe clădiri alipite ca un singur box.
                // Dacă nu găsește nimic roșiatic în interior, întoarce [] și boxul rămâne întreg.
                function _splitBoxByRedness(data, compW, compH, cols, rows, box) {
                    var gx0 = Math.max(0, Math.floor(box.x0 / GRID)), gx1 = Math.min(cols-1, Math.floor(box.x1 / GRID));
                    var gy0 = Math.max(0, Math.floor(box.y0 / GRID)), gy1 = Math.min(rows-1, Math.floor(box.y1 / GRID));
                    var mask = new Uint8Array(cols * rows);
                    var any = false;
                    for (var gy = gy0; gy <= gy1; gy++) {
                        for (var gx = gx0; gx <= gx1; gx++) {
                            var vRed = 0, vTot = 0;
                            for (var sy = 0; sy < GRID; sy++) for (var sx = 0; sx < GRID; sx++) {
                                var spx = gx*GRID+sx, spy = gy*GRID+sy;
                                if (spx >= compW || spy >= compH) continue;
                                var pi = (spy*compW+spx)*4;
                                vTot++;
                                if (_isRed(data[pi], data[pi+1], data[pi+2])) vRed++;
                            }
                            if (vTot && vRed >= (window.IOS_BLD_CELL_MIN_COUNT || 4) && vRed > (vTot - vRed) * (window.IOS_BLD_CELL_MIN_RATIO || 0.6)) {
                                mask[gy*cols+gx] = 1; any = true;
                            }
                        }
                    }
                    if (!any) return [];
                    return _connComp(mask, cols, rows).filter(function(c) { return c.length >= (window.IOS_BLD_MIN_CLUSTER_CELLS || 2); });
                }

                // ── Strângerea poligonului la "bulinele" reale de clădire ──────────────
                // Motiv: un box YOLO poate fi mult mai mare decât simbolul de clădire pe
                // care îl încadrează, iar vechiul comportament desena ÎNTREGUL box brut de
                // îndată ce conținea UN SINGUR pixel roșiatic (vezi _clusterHasRed) —
                // rezultând poligoane mari peste teren gol în jurul unei clădiri mici, sau
                // chiar peste zone fără nicio clădire (un singur pixel roșu-maroniu izolat,
                // hașură decolorată etc.). _tightenBoxToRedCells încearcă întâi pragul
                // STRICT (densitate ridicată de roșu per celulă — cerneala reală a
                // simbolului), apoi un prag PERMISIV (celulă cu ≥1 pixel roșiatic) doar ca
                // rezervă — și, spre deosebire de comportamentul vechi, NU mai cade înapoi
                // pe boxul întreg dacă nu găsește nimic: boxul e aruncat complet (vezi
                // apelul din _runOnnxDetection). Rezultatul e apoi dilatat cu o mică marjă
                // (window.IOS_BLD_TIGHTEN_PAD_CELLS celule) ca poligonul să nu taie exact
                // prin pixelii de cerneală, dar rămâne mult mai aproape de simbolul real
                // decât boxul YOLO original.
                window.IOS_BLD_TIGHTEN_PAD_CELLS = (window.IOS_BLD_TIGHTEN_PAD_CELLS !== undefined) ? window.IOS_BLD_TIGHTEN_PAD_CELLS : 1;

                function _looseRedCellMask(data, compW, compH, cols, rows, box) {
                    var gx0 = Math.max(0, Math.floor(box.x0 / GRID)), gx1 = Math.min(cols-1, Math.floor(box.x1 / GRID));
                    var gy0 = Math.max(0, Math.floor(box.y0 / GRID)), gy1 = Math.min(rows-1, Math.floor(box.y1 / GRID));
                    var mask = new Uint8Array(cols * rows);
                    var any = false;
                    for (var gy = gy0; gy <= gy1; gy++) {
                        for (var gx = gx0; gx <= gx1; gx++) {
                            var found = false;
                            for (var sy = 0; sy < GRID && !found; sy++) {
                                for (var sx = 0; sx < GRID && !found; sx++) {
                                    var spx = gx*GRID+sx, spy = gy*GRID+sy;
                                    if (spx >= compW || spy >= compH) continue;
                                    var pi = (spy*compW+spx)*4;
                                    if (_isRed(data[pi], data[pi+1], data[pi+2])) found = true;
                                }
                            }
                            if (found) { mask[gy*cols+gx] = 1; any = true; }
                        }
                    }
                    if (!any) return [];
                    return _connComp(mask, cols, rows);
                }

                // Dilată un set de celule GRID×GRID cu `pad` celule în fiecare direcție,
                // decupat la limitele boxului original + o mică marjă suplimentară — ca
                // poligonul strâns să păstreze un mic buffer vizual în jurul cernelii, fără
                // să se întoarcă la dimensiunea boxului YOLO original.
                function _dilateCellsClipped(cells, cols, rows, pad, gx0, gx1, gy0, gy1) {
                    var set = {};
                    cells.forEach(function(i) {
                        var gx = i % cols, gy = (i - gx) / cols;
                        for (var dy = -pad; dy <= pad; dy++) {
                            for (var dx = -pad; dx <= pad; dx++) {
                                var nx = gx + dx, ny = gy + dy;
                                if (nx < Math.max(0, gx0) || nx > Math.min(cols-1, gx1)) continue;
                                if (ny < Math.max(0, gy0) || ny > Math.min(rows-1, gy1)) continue;
                                set[ny*cols+nx] = true;
                            }
                        }
                    });
                    return Object.keys(set).map(Number);
                }

                function _tightenBoxToRedCells(data, compW, compH, cols, rows, box) {
                    var gx0 = Math.max(0, Math.floor(box.x0 / GRID)), gx1 = Math.min(cols-1, Math.floor(box.x1 / GRID));
                    var gy0 = Math.max(0, Math.floor(box.y0 / GRID)), gy1 = Math.min(rows-1, Math.floor(box.y1 / GRID));
                    var pad = window.IOS_BLD_TIGHTEN_PAD_CELLS;

                    // 1) Prag STRICT — densitate ridicată de roșu per celulă (cerneala reală
                    //    a simbolului de clădire, nu doar un pixel izolat).
                    var strict = _splitBoxByRedness(data, compW, compH, cols, rows, box);
                    if (strict.length) {
                        return strict.map(function(c) { return _dilateCellsClipped(c, cols, rows, pad, gx0-pad, gx1+pad, gy0-pad, gy1+pad); });
                    }

                    // 2) Prag PERMISIV, doar rezervă — orice celulă cu ≥1 pixel roșiatic.
                    //    Tot mai strâns decât boxul YOLO întreg, dar nu cere densitate mare
                    //    (util pentru cerneală foarte decolorată/subțire).
                    var loose = _looseRedCellMask(data, compW, compH, cols, rows, box);
                    if (loose.length) {
                        return loose
                            .map(function(c) { return _dilateCellsClipped(c, cols, rows, pad, gx0-pad, gx1+pad, gy0-pad, gy1+pad); })
                            .filter(function(c) { return c.length > 0; });
                    }

                    // 3) Nicio urmă de roșu în tot boxul → nu returnăm nimic. Boxul e aruncat
                    //    complet de apelant (nu se mai desenează un poligon "gol", uriaș, peste
                    //    zone fără nicio clădire).
                    return [];
                }


                // ── Heritage fetch + mask (reutilizează jsonpFetch din pagină) ──
                function _fetchHeritage(bounds) {
                    return new Promise(function(resolve) {
                        var BASE = 'https://eism.geo-spatial.ro/eismgeo/rest/services/Patrimoniu/PatrimoniuWM/MapServer';
                        var LAYERS = [0,5,6];
                        var circles = [], pend = LAYERS.length;
                        function done(){ if(--pend===0) resolve(circles); }
                        LAYERS.forEach(function(lid){
                            var sw=L.CRS.EPSG3857.project(bounds.getSouthWest()), ne=L.CRS.EPSG3857.project(bounds.getNorthEast());
                            var url = BASE+'/'+lid+'/query?where=1%3D1&geometry='+encodeURIComponent(sw.x+','+sw.y+','+ne.x+','+ne.y)
                                +'&geometryType=esriGeometryEnvelope&inSR=102100&spatialRel=esriSpatialRelIntersects'
                                +'&outFields=OBJECTID&returnGeometry=true&outSR=4326&resultRecordCount=2000&f=json';
                            var to=setTimeout(function(){ console.warn('[IosBld+][Heritage] TIMEOUT (5s) pe layer', lid, '— continuă fără acest layer.'); done(); }, 5000);
                            jsonpFetch(url, function(data){
                                clearTimeout(to);
                                var before = circles.length;
                                if (data && data.features) data.features.forEach(function(f){
                                    var g=f.geometry, gt=data.geometryType; if(!g) return;
                                    if (gt==='esriGeometryPoint'&&!isNaN(g.x)&&!isNaN(g.y)) circles.push({latlng:L.latLng(g.y,g.x),radiusM:600});
                                    else if (gt==='esriGeometryPolygon'&&g.rings) g.rings.forEach(function(r){ r.forEach(function(pt){ circles.push({latlng:L.latLng(pt[1],pt[0]),radiusM:600}); }); });
                                    else if (gt==='esriGeometryPolyline'&&g.paths) g.paths.forEach(function(p){ p.forEach(function(pt){ circles.push({latlng:L.latLng(pt[1],pt[0]),radiusM:600}); }); });
                                });
                                console.log('[IosBld+][Heritage] Layer', lid, '→', (data && data.features ? data.features.length : 0), 'features,',
                                    (circles.length-before), 'cercuri adăugate.', (!data ? '(răspuns null/JSONP eșuat)' : ''));
                                done();
                            });
                        });
                    });
                }

                function _buildHeritageMask(circles, cols, rows, tileXs, tileYs, z) {
                    var mask = new Uint8Array(cols*rows); if(!circles.length) return mask;
                    var orig = map.project(L.latLng(ty2lat(tileYs[0],z), tx2lon(tileXs[0],z)), z);
                    var hpx = [], seen = {};
                    circles.forEach(function(hc){
                        var pt = map.project(hc.latlng, z);
                        var cx = pt.x-orig.x, cy = pt.y-orig.y;
                        var mpp = (156543.03392*Math.cos(hc.latlng.lat*Math.PI/180))/Math.pow(2,z);
                        var rPx = hc.radiusM/mpp;
                        var dk = Math.round(cx/30)+','+Math.round(cy/30);
                        if (seen[dk]) return; seen[dk]=true;
                        hpx.push({cx:cx, cy:cy, rSq:rPx*rPx});
                    });
                    for (var gy=0;gy<rows;gy++){ var cpy=gy*GRID+GRID/2;
                        for (var gx=0;gx<cols;gx++){ var cpx=gx*GRID+GRID/2;
                            for (var i=0;i<hpx.length;i++){ var h=hpx[i],dx=cpx-h.cx,dy=cpy-h.cy; if(dx*dx+dy*dy<h.rSq){ mask[gy*cols+gx]=1; break; } }
                        }
                    }
                    return mask;
                }

                // ── Verificare Buildings: folosește tile-urile raster UAT (negru = ──
                // clădire) în loc de fișierul GeoJSON unic / indexul spațial pe grilă.
                // uatHasBuildingNear extinde bbox-ul cu minBuildingDistM și caută orice
                // pixel "clădire" în zona extinsă — echivalentul raster al vechii reguli
                // "minDistM <= minBuildingDistM". Overpass rămâne fallback pentru cazul
                // (rar) în care niciun tile din zonă nu a putut fi citit (CORS/rețea).
                window.IOS_BLD_DOUBLE_CHECK_OVERPASS = (window.IOS_BLD_DOUBLE_CHECK_OVERPASS !== undefined) ? window.IOS_BLD_DOUBLE_CHECK_OVERPASS : false;

                function _hasBuildingsAt(sw, ne, cb) {
                    var minBuildingDistM = (window.IOS_BLD_MIN_BUILDING_DIST_M !== undefined) ? window.IOS_BLD_MIN_BUILDING_DIST_M : 150;
                    uatHasBuildingNear(sw, ne, minBuildingDistM, function (hasPolygon) {
                        console.log('[IosBld+][Buildings] UAT raster → pixel "clădire" în raza de',
                            minBuildingDistM + 'm', '=', hasPolygon);
                        if (hasPolygon) { cb(true); return; }
                        // Niciun pixel "clădire" găsit în tile-urile citite — acceptăm direct
                        // "fără clădire", fără dubla verificare Overpass (implicit dezactivată).
                        if (window.IOS_BLD_DOUBLE_CHECK_OVERPASS === false) { cb(false); return; }
                        _overpassHasBuildings(sw, ne, cb);
                    });
                }

                // ── Trimming la nivel de celulă vs. clădiri actuale ─────────────────────
                // Înainte, un candidat era acceptat/respins ÎN ÎNTREGIME pe baza unei
                // singure verificări pe bbox-ul lui întreg (_hasBuildingsAt), ceea ce putea
                // lăsa să treacă poligoane care ating sau chiar intersectează o clădire
                // actuală reală, atâta timp cât bbox-ul general "trecea" testul. Aici
                // verificăm FIECARE celulă individual — orice celulă aflată la mai puțin de
                // `bufferMeters` (implicit window.IOS_BLD_MIN_BUILDING_DIST_M, 150m — aceeași
                // valoare din panoul de Setări, "Distanță minimă față de clădire") de un
                // pixel "clădire actuală" e tăiată din poligonul final, nu doar tot
                // clusterul respins/acceptat în bloc. O celulă care intersectează direct
                // stratul UAT (distanță 0) e prinsă automat de același test.
                function _trimCellsNearBuildings(cells, cols, pxToLLFn, bufferMeters, cb) {
                    if (!cells.length) { cb([]); return; }
                    var kept = [];
                    var pending = cells.length;
                    cells.forEach(function (i) {
                        var gx = i % cols, gy = (i - gx) / cols;
                        var ll = pxToLLFn(gx * GRID + GRID / 2, gy * GRID + GRID / 2);
                        var pt = { lat: ll.lat, lng: ll.lng };
                        uatHasBuildingNear(pt, pt, bufferMeters, function (hasBldg) {
                            if (!hasBldg) kept.push(i);
                            if (--pending === 0) cb(kept);
                        });
                    });
                }

                // ── Overpass: coadă serializată + retry, ca să nu lovim rate-limit-ul
                // API-ului public (overpass-api.de) ─────────────────────────────────────
                // De la introducerea limitei de mărime maximă a poligoanelor (vezi
                // window.IOS_BLD_ONNX_MAX_POLY_PX), un singur box ONNX mare poate genera
                // acum zeci de sub-poligoane mici — și fiecare, dacă tile-ul Buildings arată
                // "fără clădire", declanșează o interogare Overpass de confirmare. Trimise
                // toate simultan (fără limitare), API-ul public Overpass răspunde cu eroarea
                // lui specifică de rate-limit — un XML de forma
                // "<?xml version=...><remark>runtime error: open64: ... Too many
                // requests...</remark>" — care NU e JSON valid, deși am cerut [out:json]
                // (Overpass ignoră formatul cerut pentru propriile erori de runtime).
                // fetch().json() eșuează la parsare, iar codul vechi presupunea în catch
                // "fără clădire" (cb(false)) — exact când ar fi trebuit să fie prudent —
                // rezultând poligoane "dispărute" desenate peste clădiri reale.
                // Fix: (1) o coadă globală care rulează cererile Overpass una câte una, cu
                // o pauză minimă între ele (window.IOS_BLD_OVERPASS_MIN_GAP_MS); (2) câteva
                // reîncercări cu backoff dacă răspunsul nu e JSON valid sau HTTP nu e OK
                // (window.IOS_BLD_OVERPASS_MAX_RETRIES); (3) dacă TOT eșuează, presupunem
                // "clădire prezentă" (cb(true) → NU marcăm drept dispărută) — un eșec de
                // rețea nu mai înseamnă implicit "sigur a dispărut", ci "nu putem confirma,
                // deci nu riscăm un fals-pozitiv peste o clădire reală".
                window.IOS_BLD_OVERPASS_MIN_GAP_MS  = (window.IOS_BLD_OVERPASS_MIN_GAP_MS  !== undefined) ? window.IOS_BLD_OVERPASS_MIN_GAP_MS  : 1100;
                window.IOS_BLD_OVERPASS_MAX_RETRIES = (window.IOS_BLD_OVERPASS_MAX_RETRIES !== undefined) ? window.IOS_BLD_OVERPASS_MAX_RETRIES : 2;

                var _opQueue = [];
                var _opQueueRunning = false;
                var _opLastCallTs = 0;

                function _opEnqueue(job) {
                    _opQueue.push(job);
                    _opDrainQueue();
                }

                function _opDrainQueue() {
                    if (_opQueueRunning) return;
                    _opQueueRunning = true;
                    function step() {
                        if (!_opQueue.length) { _opQueueRunning = false; return; }
                        var job = _opQueue.shift();
                        var minGap = (window.IOS_BLD_OVERPASS_MIN_GAP_MS !== undefined) ? window.IOS_BLD_OVERPASS_MIN_GAP_MS : 1100;
                        var wait = Math.max(0, minGap - (Date.now() - _opLastCallTs));
                        setTimeout(function() {
                            _opLastCallTs = Date.now();
                            job(step);
                        }, wait);
                    }
                    step();
                }

                function _overpassFetchOnce(opUrl) {
                    return fetch(opUrl).then(function(r) {
                        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.httpStatus = r.status; throw e; }
                        return r.json();
                    });
                }

                // Interoghează Overpass pentru numărul de clădiri OSM dintr-un bbox — folosit
                // atât ca fallback (eroare de rețea/parsare pe tile-ul R2), cât și ca a doua
                // confirmare atunci când tile-ul Buildings (R2) indică "fără clădire" (posibil
                // fals-negativ dintr-un gol de acoperire în acel dataset). Cererile sunt
                // serializate prin _opEnqueue (vezi mai sus) ca să nu lovim rate-limit-ul.
                function _overpassHasBuildings(sw, ne, cb) {
                    var bbox = sw.lat+','+sw.lng+','+ne.lat+','+ne.lng;
                    var q = '[out:json][timeout:8];(way["building"]('+bbox+');relation["building"]('+bbox+'););out count;';
                    var opUrl = 'https://overpass-api.de/api/interpreter?data='+encodeURIComponent(q);

                    _opEnqueue(function(done) {
                        var maxRetries = (window.IOS_BLD_OVERPASS_MAX_RETRIES !== undefined) ? window.IOS_BLD_OVERPASS_MAX_RETRIES : 2;
                        var attempt = 0;
                        function tryOnce() {
                            attempt++;
                            console.log('[IosBld+][Buildings] Confirmare/fallback Overpass (încercare ' + attempt + '/' + (maxRetries+1) + '):', opUrl);
                            _overpassFetchOnce(opUrl).then(function(d) {
                                var cnt = (d&&d.elements&&d.elements[0]&&d.elements[0].tags) ? parseInt(d.elements[0].tags.total||'0',10) : 0;
                                console.log('[IosBld+][Buildings] Overpass count clădiri:', cnt);
                                cb(cnt>0);
                                done();
                            }).catch(function(opErr) {
                                if (attempt <= maxRetries) {
                                    var backoff = 800 * attempt;
                                    console.warn('[IosBld+][Buildings] Overpass a eșuat (' + (opErr && opErr.message) + ') → reîncerc peste', backoff, 'ms.');
                                    setTimeout(tryOnce, backoff);
                                } else {
                                    console.error('[IosBld+][Buildings] Overpass a eșuat definitiv:', opErr && opErr.message,
                                        '→ presupun "clădire prezentă" (NU marchez ca dispărută) ca să evit un fals-pozitiv.');
                                    cb(true);
                                    done();
                                }
                            });
                        }
                        tryOnce();
                    });
                }

                // ── Visibility refresh ──
                // Cele trei iconițe Iosefină (căutare clădiri dispărute / setări /
                // sugerează) trăiesc sub sliderul vertical de opacitate
                // (#verticalOpacityActions, mutate de js/vertical-opacity-control.js):
                // sunt vizibile doar când stratul Josephine Map + e pornit ȘI
                // selectat în oglinda verticală. Hint-ul bottom-center nu se mai
                // arată niciodată — la zoom/arie insuficiente iconița de căutare
                // rămâne vizibilă (estompată, .needs-zoom), iar bula ei de
                // informații arată mesajul de zoom corect (in vs out), ca în
                // FIX-ul 2026-07. Setările și sugestia rămân mereu disponibile
                // (parametrii se pot regla oricând, iar desenul manual nu cere
                // zoom de detecție); doar detecția automată cere zoom valid.
                function _refreshVisibility() {
                    var btn  = document.getElementById('iosBldSearchHelpBtn');
                    var hint = document.getElementById('iosBldSearchHelpHint');
                    if (!btn || !hint) return;

                    var btnLabel = document.getElementById('iosBldSearchHelpLabel');
                    var settingsBtn = document.getElementById('iosBldSettingsBtn');
                    var suggestBtn = document.getElementById('iosBldSuggestBtn');

                    var _vo = (typeof window.DetectLabVerticalOpacity !== 'undefined')
                        ? window.DetectLabVerticalOpacity : null;
                    var verticalActive = false;
                    if (_vo && typeof _vo.isActiveFor === 'function') {
                        try { verticalActive = _vo.isActiveFor('josephineOpacitySlider'); } catch (e) { verticalActive = false; }
                    }

                    // Butonul e activ dacă Josephine Map + (_jLayerRef) e pe hartă
                    var jOn = !!(window._jLayerRef && map.hasLayer(window._jLayerRef));
                    var _curZoom = map.getZoom();
                    var zoomOk = _curZoom >= window.IOS_BLD_MIN_ZOOM && _curZoom <= window.IOS_BLD_MAX_ZOOM;
                    var areaOk = _areaKm2() <= MAX_AREA_KM2 && zoomOk;

                    hint.classList.remove('visible');
                    hint.style.display = 'none';
                    _hintVisible = false;

                    if (!jOn || !verticalActive) {
                        btn.style.display = 'none';
                        btn.classList.remove('needs-zoom');
                        if (settingsBtn) settingsBtn.style.display = 'none';
                        if (suggestBtn) suggestBtn.style.display = 'none';
                        window._iosBldStopSuggestDrawing && window._iosBldStopSuggestDrawing();
                        return;
                    }
                    if (areaOk) {
                        btn.style.display = 'flex';
                        btn.classList.remove('needs-zoom');
                        if (btnLabel && !btn.disabled) btnLabel.textContent = _t('ios_bld_search_help');
                        if (settingsBtn) settingsBtn.style.display = 'flex';
                        if (suggestBtn) suggestBtn.style.display = 'flex';
                    } else {
                        btn.style.display = 'flex';
                        btn.classList.add('needs-zoom');
                        // FIX (2026-07): mesajul era static ("Zoom in mai mult") indiferent de
                        // motiv — confuz când zoom-ul curent e PESTE maxim (14), caz în care
                        // utilizatorul trebuie să dea zoom OUT, nu in. Alegem textul corect în
                        // funcție de motivul real: zoom prea mic → zoom in; zoom prea mare →
                        // zoom out; zoom OK dar viewport prea mare → zoom in (micșorează aria).
                        // Textul ajunge acum în bula iconiței, nu în hint-ul bottom-center.
                        if (btnLabel && !btn.disabled) {
                            var zoomKey = (_curZoom > window.IOS_BLD_MAX_ZOOM) ? 'ios_bld_search_help_zoom_out' : 'ios_bld_search_help_zoom_in';
                            btnLabel.textContent = _t(zoomKey);
                        }
                        if (settingsBtn) settingsBtn.style.display = 'flex';
                        if (suggestBtn) suggestBtn.style.display = 'flex';
                        window._iosBldStopSuggestDrawing && window._iosBldStopSuggestDrawing();
                        window.clearIosBldSearchHelp && window.clearIosBldSearchHelp();
                    }
                }

                map.on('zoomend moveend', _refreshVisibility);
                window.addEventListener('resize', _refreshVisibility);
                window._refreshIosBldBtnVisibility = _refreshVisibility;

                // ── Panou de setări ("Ruleaza detectia pe viewport", portat din model-test-v3.1.html) ──
                // Expune live, prin UI, praguri care înainte erau reglabile doar din consolă
                // (window.IOS_BLD_ONNX_CONF/_IOU/_MIN_BUILDING_DIST_M) și adaugă un flag nou de
                // excludere a clădirilor actuale + feedback (👍/👎) mereu activ, ca în model-test-v3.1.html.
                window.IOS_BLD_EXCLUDE_BUILDINGS = (window.IOS_BLD_EXCLUDE_BUILDINGS !== undefined) ? window.IOS_BLD_EXCLUDE_BUILDINGS : true;
                // Flag pentru pasul suplimentar de poligonizare (formă + culoare specifică
                // simbolului de clădire Iosefină) — vezi _extraShapeColorValidation mai jos.
                // Implicit ACTIV (checked by default în UI), comutabil din panoul de setări.
                window.IOS_BLD_EXTRA_STEP_ENABLED = (window.IOS_BLD_EXTRA_STEP_ENABLED !== undefined) ? window.IOS_BLD_EXTRA_STEP_ENABLED : true;

                window.toggleIosBldSettings = function () {
                    var panel = document.getElementById('iosBldSettingsPanel');
                    if (panel) panel.classList.toggle('open');
                };

                (function _bindIosBldSettingsControls() {
                    var confSlider  = document.getElementById('iosBldConfSlider');
                    var confVal     = document.getElementById('iosBldConfVal');
                    var iouSlider   = document.getElementById('iosBldIouSlider');
                    var iouVal      = document.getElementById('iosBldIouVal');
                    var excludeChk  = document.getElementById('iosBldExcludeCurrentBuildings');
                    var minDistIn   = document.getElementById('iosBldMinDistanceInput');

                    if (confSlider) {
                        confSlider.value = window.IOS_BLD_ONNX_CONF;
                        if (confVal) confVal.textContent = window.IOS_BLD_ONNX_CONF;
                        confSlider.addEventListener('input', function () {
                            window.IOS_BLD_ONNX_CONF = parseFloat(confSlider.value);
                            if (confVal) confVal.textContent = confSlider.value;
                        });
                    }
                    if (iouSlider) {
                        iouSlider.value = window.IOS_BLD_ONNX_IOU;
                        if (iouVal) iouVal.textContent = window.IOS_BLD_ONNX_IOU;
                        iouSlider.addEventListener('input', function () {
                            window.IOS_BLD_ONNX_IOU = parseFloat(iouSlider.value);
                            if (iouVal) iouVal.textContent = iouSlider.value;
                        });
                    }
                    if (excludeChk) {
                        excludeChk.checked = window.IOS_BLD_EXCLUDE_BUILDINGS;
                        excludeChk.addEventListener('change', function () {
                            window.IOS_BLD_EXCLUDE_BUILDINGS = !!excludeChk.checked;
                        });
                    }
                    if (minDistIn) {
                        minDistIn.value = window.IOS_BLD_MIN_BUILDING_DIST_M;
                        minDistIn.addEventListener('change', function () {
                            var v = parseFloat(minDistIn.value);
                            if (!(v >= 100)) v = 100;
                            if (v > 300) v = 300;
                            minDistIn.value = v;
                            window.IOS_BLD_MIN_BUILDING_DIST_M = v;
                        });
                    }
                    var extraStepChk = document.getElementById('iosBldExtraStepDetector');
                    if (extraStepChk) {
                        extraStepChk.checked = window.IOS_BLD_EXTRA_STEP_ENABLED;
                        extraStepChk.addEventListener('change', function () {
                            window.IOS_BLD_EXTRA_STEP_ENABLED = !!extraStepChk.checked;
                            console.log('[IosBld+][Extra] Detector pas adițional →', window.IOS_BLD_EXTRA_STEP_ENABLED ? 'ACTIV' : 'DEZACTIVAT');
                        });
                    }
                })();

                // ── Feedback (👍/👎), portat identic din model-test-v3.1.html: Worker URL fix,
                // butoanele de vot sunt mereu afișate pe fiecare detecție ──
                var IOS_BLD_FEEDBACK_WORKER_URL = 'https://detectlab-feedback.andreiroba2000.workers.dev';
                function _iosBldGetWorkerUrl() {
                    return IOS_BLD_FEEDBACK_WORKER_URL;
                }

                function _iosBldSendFeedback(vote, meta) {
                    var workerUrl = _iosBldGetWorkerUrl();
                    return fetch(workerUrl + '/feedback', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            vote: vote, cls: meta.cls, confidence: meta.confidence,
                            latNorth: meta.latNorth, latSouth: meta.latSouth,
                            lonWest: meta.lonWest, lonEast: meta.lonEast,
                            zoom: meta.zoom, tileX: meta.tileX, tileY: meta.tileY,
                            modelVersion: meta.modelVersion,
                        }),
                    }).then(function (resp) { return resp.ok; })
                      .catch(function (e) { console.error('[IosBld+] feedback error', e); return false; });
                }

                function _iosBldBuildFeedbackPopup(meta) {
                    var div = document.createElement('div');
                    div.id = 'iosBldFeedbackPopup';

                    var header = document.createElement('div');
                    header.innerHTML = '<b>' + meta.labelRo + '</b>' +
                        (meta.confidence != null ? '<br>Încredere: ' + (meta.confidence * 100).toFixed(1) + '%' : '');
                    div.appendChild(header);

                    var btnRow = document.createElement('div');
                    btnRow.className = 'ios-bld-fb-row';

                    var upBtn = document.createElement('button');
                    upBtn.textContent = '👍 Corect';
                    upBtn.style.background = '#f4faf6';

                    var downBtn = document.createElement('button');
                    downBtn.textContent = '👎 Greșit';
                    downBtn.style.background = '#fdf4f2';

                    var statusEl = document.createElement('div');
                    statusEl.style.cssText = 'margin-top:6px;font-size:11px;color:#888;';

                    function vote(v) {
                        upBtn.disabled = true; downBtn.disabled = true;
                        statusEl.textContent = 'Se trimite...';
                        _iosBldSendFeedback(v, meta).then(function (ok) {
                            statusEl.textContent = ok ? 'Mulțumim pentru feedback!' : 'Eroare la trimitere — verifică Worker URL.';
                        });
                    }
                    upBtn.addEventListener('click', function () { vote('up'); });
                    downBtn.addEventListener('click', function () { vote('down'); });

                    btnRow.appendChild(upBtn);
                    btnRow.appendChild(downBtn);
                    div.appendChild(btnRow);
                    div.appendChild(statusEl);
                    return div;
                }

                // ── "Sugerează un poligon" — desenare manuală de clădiri nedetectate ───────
                // Userul poate desena pe hartă un poligon acolo unde crede că exista o clădire
                // dispărută pe care detecția automată (ONNX) nu a semnalat-o, și îl poate
                // trimite ca sugestie prin același Worker de feedback (endpoint separat /suggest).
                var _suggestLG = null;
                var _suggestDrawing = false;
                var _suggestPoints = [];
                var _suggestTempLayer = null;
                var _suggestVertexLG = null;   // markere mari pentru fiecare colț
                var _suggestVertexMarkers = []; // referințe la markerele de mai sus, în ordine

                // Rază (px) markerelor de colț — suficient de mare ca să fie ușor de nimerit
                // pe mobil/desktop. Primul punct e desenat și mai mare, ca să fie clar unde
                // trebuie să dai click pentru a închide poligonul.
                var IOS_BLD_SUGGEST_VERTEX_R = 8;
                var IOS_BLD_SUGGEST_FIRST_VERTEX_R = 12;

                function _iosBldRedrawSuggestPreview() {
                    if (_suggestTempLayer) { map.removeLayer(_suggestTempLayer); _suggestTempLayer = null; }
                    if (_suggestPoints.length < 2) return;
                    _suggestTempLayer = L.polyline(_suggestPoints, {
                        color: '#6EC1E4', weight: 2, dashArray: '6,4', pane: 'pane_ios_bld_search_help'
                    }).addTo(map);
                }

                // Adaugă un marker mare, ușor de apăsat, pentru colțul curent. Primul colț
                // primește un stil aparte (mai mare, contur auriu) + tooltip, pentru că un
                // click pe el închide automat poligonul.
                function _iosBldAddSuggestVertexMarker(latlng, isFirst) {
                    if (!_suggestVertexLG) _suggestVertexLG = L.layerGroup().addTo(map);
                    var marker = L.circleMarker(latlng, {
                        radius: isFirst ? IOS_BLD_SUGGEST_FIRST_VERTEX_R : IOS_BLD_SUGGEST_VERTEX_R,
                        color: isFirst ? '#FFD166' : '#ffffff',
                        weight: isFirst ? 3 : 2,
                        fillColor: '#6EC1E4',
                        fillOpacity: 0.95,
                        pane: 'pane_ios_bld_search_help',
                        bubblingMouseEvents: false // click-ul pe marker nu trebuie să adauge și un punct nou pe hartă dedesubt
                    }).addTo(_suggestVertexLG);

                    if (isFirst) {
                        marker.bindTooltip('Click aici ca să închei poligonul', { direction: 'top', offset: [0, -10] });
                        marker.on('click', function (e) {
                            L.DomEvent.stop(e);
                            _iosBldFinishSuggestPolygon();
                        });
                    } else {
                        // Click pe un colț deja plasat nu face nimic (doar previne dublarea punctului)
                        marker.on('click', function (e) { L.DomEvent.stop(e); });
                    }

                    _suggestVertexMarkers.push(marker);
                }

                function _iosBldClearSuggestVertexMarkers() {
                    if (_suggestVertexLG) { map.removeLayer(_suggestVertexLG); _suggestVertexLG = null; }
                    _suggestVertexMarkers = [];
                }

                function _iosBldMapClickForSuggest(e) {
                    var isFirst = _suggestPoints.length === 0;
                    _suggestPoints.push(e.latlng);
                    _iosBldAddSuggestVertexMarker(e.latlng, isFirst);
                    _iosBldRedrawSuggestPreview();
                    if (_suggestPoints.length < 3) {
                        _toast('Punct adăugat (' + _suggestPoints.length + '). Mai adaugă cel puțin ' + (3 - _suggestPoints.length) + ' pentru a putea închide poligonul.', 4000);
                    } else {
                        _toast('Punct adăugat (' + _suggestPoints.length + '). Click pe primul punct (auriu) ca să închei poligonul, Esc ca să anulezi.', 4500);
                    }
                }

                function _iosBldKeyForSuggest(e) {
                    if (e.key === 'Escape') _iosBldCancelSuggest();
                }

                function _iosBldStartSuggestDrawing() {
                    if (_suggestDrawing) return;
                    _suggestDrawing = true;
                    _suggestPoints = [];
                    _iosBldClearSuggestVertexMarkers();
                    var btn = document.getElementById('iosBldSuggestBtn');
                    if (btn) btn.classList.add('active');
                    map.getContainer().style.cursor = 'crosshair';
                    map.on('click', _iosBldMapClickForSuggest);
                    document.addEventListener('keydown', _iosBldKeyForSuggest);
                    _toast('Click pe hartă ca să adaugi colțuri.', 5000);
                }

                function _iosBldStopSuggestDrawing() {
                    _suggestDrawing = false;
                    var btn = document.getElementById('iosBldSuggestBtn');
                    if (btn) btn.classList.remove('active');
                    map.getContainer().style.cursor = '';
                    map.off('click', _iosBldMapClickForSuggest);
                    document.removeEventListener('keydown', _iosBldKeyForSuggest);
                    if (_suggestTempLayer) { map.removeLayer(_suggestTempLayer); _suggestTempLayer = null; }
                    _iosBldClearSuggestVertexMarkers();
                }
                window._iosBldStopSuggestDrawing = _iosBldStopSuggestDrawing; // apelat din _refreshVisibility

                function _iosBldCancelSuggest() {
                    _suggestPoints = [];
                    _iosBldStopSuggestDrawing();
                    _toast('Desenare anulată.', 2000);
                }

                function _iosBldFinishSuggestPolygon() {
                    if (_suggestPoints.length < 3) {
                        _toast('Ai nevoie de minim 3 puncte pentru un poligon.', 3000);
                        return;
                    }
                    var latlngs = _suggestPoints.slice();
                    _iosBldStopSuggestDrawing();

                    if (!_suggestLG) _suggestLG = L.layerGroup().addTo(map);
                    var poly = L.polygon(latlngs, {
                        color: '#6EC1E4', weight: 2.5, dashArray: '6,4',
                        fillColor: '#6EC1E4', fillOpacity: 0.12,
                        pane: 'pane_ios_bld_search_help'
                    }).addTo(_suggestLG);

                    var meta = {
                        polygon: latlngs.map(function (p) { return [p.lat, p.lng]; }),
                        zoom: Math.round(map.getZoom()),
                        modelVersion: 'user-suggested',
                    };
                    poly.bindPopup(_iosBldBuildSuggestPopup(poly, meta)).openPopup();
                }

                window.toggleIosBldSuggestMode = function () {
                    if (_suggestDrawing) _iosBldCancelSuggest();
                    else _iosBldStartSuggestDrawing();
                };

                function _iosBldSendSuggestion(meta) {
                    var workerUrl = _iosBldGetWorkerUrl();
                    return fetch(workerUrl + '/suggest', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'user_polygon', polygon: meta.polygon,
                            zoom: meta.zoom, modelVersion: meta.modelVersion, ts: Date.now(),
                        }),
                    }).then(function (resp) { return resp.ok; })
                      .catch(function (e) { console.error('[IosBld+] eroare trimitere sugestie', e); return false; });
                }

                function _iosBldBuildSuggestPopup(polyLayer, meta) {
                    var div = document.createElement('div');
                    div.id = 'iosBldSuggestPopup';

                    var header = document.createElement('div');
                    header.innerHTML = '<b>Sugestie clădire dispărută</b><br>Poligon desenat manual (' + meta.polygon.length + ' puncte)';
                    div.appendChild(header);

                    var btnRow = document.createElement('div');
                    btnRow.className = 'ios-bld-fb-row';

                    var sendBtn = document.createElement('button');
                    sendBtn.textContent = '📩 Trimite sugestia';
                    sendBtn.style.background = '#eef6ff';

                    var delBtn = document.createElement('button');
                    delBtn.textContent = '🗑 Șterge';
                    delBtn.style.background = '#fdf4f2';

                    var statusEl = document.createElement('div');
                    statusEl.style.cssText = 'margin-top:6px;font-size:11px;color:#888;';

                    sendBtn.addEventListener('click', function () {
                        sendBtn.disabled = true; delBtn.disabled = true;
                        statusEl.textContent = 'Se trimite...';
                        _iosBldSendSuggestion(meta).then(function (ok) {
                            statusEl.textContent = ok ? 'Mulțumim! Sugestia a fost trimisă.' : 'Eroare la trimitere — verifică Worker URL.';
                        });
                    });
                    delBtn.addEventListener('click', function () {
                        if (_suggestLG) _suggestLG.removeLayer(polyLayer);
                        map.closePopup();
                    });

                    btnRow.appendChild(sendBtn);
                    btnRow.appendChild(delBtn);
                    div.appendChild(btnRow);
                    div.appendChild(statusEl);
                    return div;
                }

                window.clearIosBldSearchHelp = function () {
                    _runGen++; // invalidează orice callback async (Overpass/R2) rămas dintr-o rulare anterioară
                    if (_resultLG) { map.removeLayer(_resultLG); _resultLG = null; }
                    _iosBldStopSuggestDrawing();
                };

                // ── Funcția principală ───────────────────────────────────────────────────
                window.runIosBldSearchHelp = function () {
                    console.log('[IosBld+] ── START căutare ──────────────────────');
                    if (_running) { console.warn('[IosBld+] Deja în curs (_running=true), ignor click.'); return; }
                    var jLayer = window._jLayerRef;
                    if (!jLayer || !map.hasLayer(jLayer)) {
                        console.error('[IosBld+] ABANDON: stratul Josephine Map+ (_jLayerRef) nu e activ pe hartă.', {jLayer: jLayer, onMap: jLayer ? map.hasLayer(jLayer) : null});
                        _toast(_t('ios_bld_search_help_error'), 4000);
                        return;
                    }
                    if (map.getZoom() < window.IOS_BLD_MIN_ZOOM || map.getZoom() > window.IOS_BLD_MAX_ZOOM) {
                        console.warn('[IosBld+] ABANDON: zoom în afara intervalului permis (13-14).', {zoom: map.getZoom(), min: window.IOS_BLD_MIN_ZOOM, max: window.IOS_BLD_MAX_ZOOM});
                        _toast(_t(map.getZoom() > window.IOS_BLD_MAX_ZOOM ? 'ios_bld_search_help_zoom_out' : 'ios_bld_search_help_zoom_in'), 3000);
                        return;
                    }
                    if (_areaKm2() > MAX_AREA_KM2) {
                        console.warn('[IosBld+] ABANDON: viewport prea mare.', {areaKm2: _areaKm2(), max: MAX_AREA_KM2});
                        _toast(_t('ios_bld_search_help_zoom_in'), 3000);
                        return;
                    }

                    window.clearIosBldSearchHelp();
                    _running = true;
                    var _myGen = _runGen; // "amprenta" acestei rulări — orice callback venit după un clear/restart o va vedea depășită
                    _tileOkCount = 0; _tileFailCount = 0;

                    var btn = document.getElementById('iosBldSearchHelpBtn');
                    var lbl = document.getElementById('iosBldSearchHelpLabel');
                    if (btn) btn.disabled = true;
                    if (lbl) lbl.textContent = _t('ios_bld_search_help_loading') || 'Se analizează…';

                    var z = Math.round(map.getZoom());
                    var fetchZ = Math.min(z, JOSEPHINE_MAX_NATIVE_Z); // nu cerem tile-uri peste nivelul generat static în R2
                    var overZoomDiff = z - fetchZ; // 0 dacă z <= 15
                    var overZoomScale = Math.pow(2, overZoomDiff);
                    if (overZoomDiff > 0) {
                        console.warn('[IosBld+] Zoom curent (' + z + ') peste maxNativeZoom Josephine (' + JOSEPHINE_MAX_NATIVE_Z + '). ' +
                            'Cer tile-uri de la z=' + fetchZ + ' și le decupez/scalez local (overzoom diff=' + overZoomDiff + ').');
                    }
                    var b = map.getBounds();
                    var minTX = Math.max(0, Math.floor(lon2tx(b.getWest(),  z)));
                    var maxTX = Math.floor(lon2tx(b.getEast(),  z));
                    var minTY = Math.max(0, Math.floor(lat2ty(b.getNorth(), z)));
                    var maxTY = Math.floor(lat2ty(b.getSouth(), z));

                    console.log('[IosBld+] Zoom curent:', z, '| fetchZ (Josephine):', fetchZ, '| Bounds:', b.toBBoxString());
                    console.log('[IosBld+] Tile range X:', minTX, '-', maxTX, '| Y:', minTY, '-', maxTY,
                        '(' , (maxTX-minTX+1)*(maxTY-minTY+1), 'tile-uri Josephine de încărcat )');
                    console.log('[IosBld+] URL exemplu tile Josephine:',
                        TILE_URL_JOSEPHINE_PLUS.replace('{z}', fetchZ)
                            .replace('{x}', Math.floor(minTX/overZoomScale))
                            .replace('{y}', Math.floor(minTY/overZoomScale)));
                    console.log('[IosBld+] Sursă Buildings (R2, raster):', UAT_TILE_URL);

                    var tileXs = [], tileYs = [];
                    for (var tx = minTX; tx <= maxTX; tx++) tileXs.push(tx);
                    for (var ty = minTY; ty <= maxTY; ty++) tileYs.push(ty);
                    if (!tileXs.length || !tileYs.length) { console.error('[IosBld+] ABANDON: niciun tile index calculat (tileXs/tileYs goale).'); _finish(false); return; }

                    var compW = tileXs.length * TILE_SIZE;
                    var compH = tileYs.length * TILE_SIZE;
                    var canvas = document.createElement('canvas');
                    canvas.width = compW; canvas.height = compH;
                    var ctx = canvas.getContext('2d');

                    // Funcție pixel → lat/lng (identic cu APM 2.0)
                    function pxToLL(px, py) {
                        return L.latLng(ty2lat(tileYs[0] + py/TILE_SIZE, z), tx2lon(tileXs[0] + px/TILE_SIZE, z));
                    }

                    // Încărcăm tile-urile Josephine Map + pe canvas.
                    // Dacă z <= 15: 1 tile cerut = 1 tile desenat, direct.
                    // Dacă z > 15 (overzoom): mai multe tile-uri "virtuale" cad pe același tile real
                    // de la fetchZ — îl cerem o singură dată (cache local) și desenăm doar porțiunea
                    // (crop) corespunzătoare fiecărui tile virtual, scalată la 256×256.
                    var promises = [];
                    var _fetchCache = {}; // 'tx_ty' (la fetchZ) -> Promise<img|null>
                    function _getFetchedTile(ftx, fty) {
                        var key = ftx + '_' + fty;
                        if (!_fetchCache[key]) {
                            var url = TILE_URL_JOSEPHINE_PLUS.replace('{z}', fetchZ).replace('{x}', ftx).replace('{y}', fty);
                            _fetchCache[key] = _loadTile(url);
                        }
                        return _fetchCache[key];
                    }
                    tileXs.forEach(function(tx, ix) {
                        tileYs.forEach(function(ty, iy) {
                            var ftx = Math.floor(tx / overZoomScale);
                            var fty = Math.floor(ty / overZoomScale);
                            promises.push(_getFetchedTile(ftx, fty).then(function(img) {
                                if (!img) return;
                                if (overZoomDiff === 0) {
                                    ctx.drawImage(img, ix*TILE_SIZE, iy*TILE_SIZE, TILE_SIZE, TILE_SIZE);
                                } else {
                                    // Crop-ul porțiunii corespunzătoare acestui tile virtual din tile-ul real
                                    var cropSize = TILE_SIZE / overZoomScale;
                                    var cellX = tx % overZoomScale, cellY = ty % overZoomScale;
                                    ctx.drawImage(img,
                                        cellX*cropSize, cellY*cropSize, cropSize, cropSize,
                                        ix*TILE_SIZE, iy*TILE_SIZE, TILE_SIZE, TILE_SIZE);
                                }
                            }));
                        });
                    });

                    Promise.all(promises).then(function() {
                        console.log('[IosBld+] Tile-uri Josephine încărcate. OK:', _tileOkCount, '| FAILED:', _tileFailCount, '/', promises.length);
                        if (_tileOkCount === 0) {
                            console.error('[IosBld+] NICIUN tile Josephine Map+ nu s-a încărcat. ' +
                                'Verifică dacă URL-ul R2 (' + TILE_URL_JOSEPHINE_PLUS + ') e accesibil din browser-ul curent — ' +
                                'posibile cauze: CORS, tile inexistent în R2, sau zoom curent (' + z + ') peste nivelul maxim generat static (' + JOSEPHINE_MAX_NATIVE_Z + ').');
                        }
                        var imgData;
                        try { imgData = ctx.getImageData(0, 0, compW, compH); }
                        catch(e) {
                            console.warn('[IosBld+] CORS blocat la getImageData:', e);
                            _finish(false, true); return;
                        }
                        var data = imgData.data;

                        var cols = Math.max(1, Math.floor(compW / GRID));
                        var rows = Math.max(1, Math.floor(compH / GRID));

                        _runOnnxDetection(imgData, compW, compH, cols, rows).then(function(bigComps) {

                        console.log('[IosBld+] Clustere finale (ONNX):', bigComps.length);
                        if (!bigComps.length) { _finish(false); return; }


                        // ── Heritage exclusion ──
                        console.log('[IosBld+] Interoghez Heritage (eismgeo) pentru excludere arii protejate…');
                        _fetchHeritage(map.getBounds().pad(0.15)).then(function(hCircles) {
                            console.log('[IosBld+] Heritage: ', hCircles.length, 'cercuri returnate.');
                            var hMask = _buildHeritageMask(hCircles, cols, rows, tileXs, tileYs, z);

                            // ── Buildings exclusion ──
                            var toCheck = [];
                            var totalClippedByHeritage = 0;
                            bigComps.forEach(function(comp) {
                                var cells = comp.cells, score = comp.score;
                                // Tai Heritage
                                var clipped = cells.filter(function(i){ return !hMask[i]; });
                                var cutByHeritage = cells.length - clipped.length;
                                totalClippedByHeritage += cutByHeritage;
                                if (clipped.length < window.IOS_BLD_MIN_CLUSTER_CELLS) {
                                    console.log('[IosBld+] Cluster de', cells.length, 'celule →', cutByHeritage, 'tăiate de Heritage → rămase', clipped.length, '< MIN_CLUSTER_CELLS, ELIMINAT.');
                                    return;
                                }

                                // Cerință OBLIGATORIE: clusterul trebuie să conțină cel puțin un
                                // pixel cu nuanță de roșu/maro (cerneala tradițională de clădire
                                // pe Harta Iosefină). Fără nicio urmă de roșu, zona e considerată
                                // fundal/hașură goală și NU se mai desenează niciun poligon —
                                // elimină poligoanele "nonsens" pe zone complet goale.
                                window.IOS_BLD_RED_SCORE_BONUS = (window.IOS_BLD_RED_SCORE_BONUS !== undefined) ? window.IOS_BLD_RED_SCORE_BONUS : 0.15;
                                var hasRed = _clusterHasRed(clipped, cols, data, compW, compH);
                                if (!hasRed) {
                                    console.log('[IosBld+] Cluster de', clipped.length, 'celule FĂRĂ nicio nuanță de roșu/maro → ELIMINAT (cerință obligatorie).');
                                    return;
                                }
                                var boostedScore = (score != null) ? Math.min(1, score + window.IOS_BLD_RED_SCORE_BONUS) : score;
                                console.log('[IosBld+] Cluster confirmat prin nuanță de roșu → scor', score, '→', boostedScore);

                                // ── Detector pas adițional (opțional, vezi panoul de Setări) ──
                                // Al doilea filtru, după cel de roșeață: cere și semnătura de
                                // formă (compactitate/rotunjime) + textură (umbrire internă)
                                // specifică simbolului de clădire Iosefină, nu doar un singur
                                // pixel roșiatic izolat.
                                if (window.IOS_BLD_EXTRA_STEP_ENABLED) {
                                    var extraCheck = _extraShapeColorValidation(clipped, cols, data, compW, compH);
                                    if (!extraCheck.pass) {
                                        console.log('[IosBld+][Extra] Cluster de', clipped.length, 'celule RESPINS de detectorul pas adițional:', extraCheck.reason);
                                        return;
                                    }
                                    console.log('[IosBld+][Extra] Cluster ACCEPTAT de detectorul pas adițional (compactitate=' + extraCheck.compactness.toFixed(2) + ', gradient=' + extraCheck.gradStd.toFixed(1) + ')');
                                }

                                // Bbox al clusterului
                                var mnLat=90,mxLat=-90,mnLng=180,mxLng=-180;
                                clipped.forEach(function(i){
                                    var gx=i%cols,gy=(i-gx)/cols;
                                    var ll=pxToLL(gx*GRID+GRID/2, gy*GRID+GRID/2);
                                    if(ll.lat<mnLat)mnLat=ll.lat; if(ll.lat>mxLat)mxLat=ll.lat;
                                    if(ll.lng<mnLng)mnLng=ll.lng; if(ll.lng>mxLng)mxLng=ll.lng;
                                });
                                // Padding în jurul bbox-ului clusterului înainte de verificarea vs
                                // Buildings — absoarbe mici erori de georeferențiere ale hărții
                                // Josephine (raster istoric) față de imaginea satelitară curentă.
                                // Reglabil live din consolă, fără redeploy: window.IOS_BLD_BUILDINGS_CHECK_PAD_DEG.
                                window.IOS_BLD_BUILDINGS_CHECK_PAD_DEG = (window.IOS_BLD_BUILDINGS_CHECK_PAD_DEG !== undefined) ? window.IOS_BLD_BUILDINGS_CHECK_PAD_DEG : 0.0004;
                                var pad = window.IOS_BLD_BUILDINGS_CHECK_PAD_DEG;
                                toCheck.push({ cells:clipped, score:boostedScore, sw:{lat:mnLat-pad,lng:mnLng-pad}, ne:{lat:mxLat+pad,lng:mxLng+pad} });
                            });
                            console.log('[IosBld+] Total celule tăiate de masca Heritage:', totalClippedByHeritage);

                            if (!toCheck.length) { console.warn('[IosBld+] ABANDON: toate clusterele au fost excluse de masca Heritage.'); _finish(false); return; }
                            console.log('[IosBld+] Clustere de verificat vs Buildings.mbtiles (R2):', toCheck.length);

                            _resultLG = L.layerGroup();
                            var pend = toCheck.length, added = 0;

                            function _draw(item) {
                                if (_myGen !== _runGen || !_resultLG) return; // rulare depășită (clear/restart între timp) — ignorăm
                                var cells = item.cells;
                                var hull = _contour(cells, cols, GRID);
                                if (hull.length < 3) return;
                                var lls = hull.map(function(p){ return pxToLL(p[0],p[1]); });
                                var poly = L.polygon(lls, {
                                    color:       '#FF2800',
                                    weight:      2.5,
                                    fillColor:   '#FF2800',
                                    fillOpacity: 0.16,
                                    opacity:     0.88,
                                    pane:        'pane_ios_bld_search_help'
                                }).addTo(_resultLG);
                                // Popup cu feedback 👍/👎 (portat din model-test-v3.1.html), activ
                                // doar dacă a fost completat un Worker URL în panoul de setări.
                                var meta = {
                                    cls: 'Buildings', labelRo: 'Clădire dispărută (posibilă)',
                                    confidence: (item.score != null ? item.score : null),
                                    latNorth: item.ne.lat, latSouth: item.sw.lat,
                                    lonWest: item.sw.lng, lonEast: item.ne.lng,
                                    zoom: z, tileX: tileXs[0], tileY: tileYs[0], modelVersion: 'v3',
                                };
                                poly.bindPopup(_iosBldBuildFeedbackPopup(meta));
                                added++;
                            }

                            toCheck.forEach(function(item) {
                                // Dacă "Exclude detecțiile pe clădiri actuale" e debifat în panoul de
                                // setări, desenăm direct fără să mai interogăm tile-ul Buildings/Overpass
                                // (comportament portat din checkbox-ul excludeCurrentBuildings din
                                // model-test-v3.1.html).
                                if (!window.IOS_BLD_EXCLUDE_BUILDINGS) {
                                    _draw(item);
                                    if (--pend === 0) {
                                        console.log('[IosBld+] ── FINAL: poligoane desenate =', added, '/', toCheck.length, 'clustere verificate ──');
                                        if (added > 0 && _resultLG) _resultLG.addTo(map);
                                        _finish(added > 0);
                                    }
                                    return;
                                }
                                var minBuildingDistM = (window.IOS_BLD_MIN_BUILDING_DIST_M !== undefined) ? window.IOS_BLD_MIN_BUILDING_DIST_M : 150;
                                _trimCellsNearBuildings(item.cells, cols, pxToLL, minBuildingDistM, function (keptCells) {
                                    if (_myGen !== _runGen) return; // rulare depășită — nu mai atingem _resultLG/_finish
                                    var cutByBuildings = item.cells.length - keptCells.length;
                                    if (keptCells.length < window.IOS_BLD_MIN_CLUSTER_CELLS) {
                                        console.log('[IosBld+][Buildings] Cluster de', item.cells.length, 'celule →', cutByBuildings,
                                            'tăiate (în raza de', minBuildingDistM, 'm de o clădire actuală) → rămase', keptCells.length,
                                            '< MIN_CLUSTER_CELLS, ELIMINAT.');
                                        if (--pend === 0) {
                                            console.log('[IosBld+] ── FINAL: poligoane desenate =', added, '/', toCheck.length, 'clustere verificate ──');
                                            if (added > 0 && _resultLG) _resultLG.addTo(map);
                                            _finish(added > 0);
                                        }
                                        return;
                                    }
                                    if (cutByBuildings) {
                                        console.log('[IosBld+][Buildings] Cluster de', item.cells.length, 'celule →', cutByBuildings,
                                            'tăiate (în raza de', minBuildingDistM, 'm de o clădire actuală) → rămase', keptCells.length, '.');
                                    }
                                    // Tăierea poate rupe clusterul în bucăți neconectate (ex. o
                                    // clădire modernă chiar prin mijlocul poligonului candidat) —
                                    // re-despărțim și desenăm fiecare bucată rămasă separat, ca să
                                    // nu unim vizual două zone care nu mai sunt de fapt legate.
                                    var subMask = new Uint8Array(cols * rows);
                                    keptCells.forEach(function (i) { subMask[i] = 1; });
                                    var pieces = _connComp(subMask, cols, rows).filter(function (c) { return c.length >= window.IOS_BLD_MIN_CLUSTER_CELLS; });
                                    pieces.forEach(function (pieceCells) {
                                        var mnLat=90,mxLat=-90,mnLng=180,mxLng=-180;
                                        pieceCells.forEach(function(i){
                                            var gx=i%cols,gy=(i-gx)/cols;
                                            var ll=pxToLL(gx*GRID+GRID/2, gy*GRID+GRID/2);
                                            if(ll.lat<mnLat)mnLat=ll.lat; if(ll.lat>mxLat)mxLat=ll.lat;
                                            if(ll.lng<mnLng)mnLng=ll.lng; if(ll.lng>mxLng)mxLng=ll.lng;
                                        });
                                        _draw({ cells: pieceCells, score: item.score, sw: {lat:mnLat,lng:mnLng}, ne: {lat:mxLat,lng:mxLng} });
                                    });
                                    if (--pend === 0) {
                                        console.log('[IosBld+] ── FINAL: poligoane desenate =', added, '/', toCheck.length, 'clustere verificate ──');
                                        if (added > 0 && _resultLG) _resultLG.addTo(map);
                                        _finish(added > 0);
                                    }
                                });
                            });
                        });

                        }).catch(function(onnxErr) {
                            console.warn('[IosBld+] Eroare la detecția ONNX:', onnxErr);
                            _finish(false, true);
                        });

                    }).catch(function(e) {
                        console.warn('[IosBld+] Eroare:', e);
                        _finish(false, true);
                    });

                    function _finish(found, err) {
                        if (_myGen !== _runGen) { console.log('[IosBld+] _finish ignorat — rulare depășită (clear/restart între timp).'); return; }
                        _running = false;
                        var btn = document.getElementById('iosBldSearchHelpBtn');
                        var lbl = document.getElementById('iosBldSearchHelpLabel');
                        if (btn) btn.disabled = false;
                        if (lbl) lbl.textContent = _t('ios_bld_search_help') || 'Clădiri Dispărute';
                        /* Dacă zoom-ul s-a schimbat în timpul analizei, resincronizăm
                           iconița (needs-zoom + bulă de zoom) imediat ce ieșim din loading. */
                        try { _refreshVisibility(); } catch (e) { /* never break _finish */ }
                        console.log('[IosBld+] ── SFÂRȘIT căutare. found =', !!found, '| err =', !!err, '──────────────────');
                        if (err)  _toast(_t('ios_bld_search_help_error'), 4000);
                        else if (!found) _toast(_t('ios_bld_search_help_empty'), 3500);
                    }
                };

            })();
            // ── END JOSEPHINE MAP + BUILDINGS SEARCH HELP ────────────────────────────────

            // ── AUSTRIAN MAP 1910 WMS LAYER ──
            (function () {
                map.createPane('pane_austrian');
                map.getPane('pane_austrian').style.zIndex = 640;
                map.getPane('pane_austrian').style.pointerEvents = 'none';

                window._austrianMapLayer = L.tileLayer.wms(DL.url2d('hist.austrian'), DL.wms2dOptions('hist.austrian', {
                    pane: 'pane_austrian'
                }));

                window.toggleAustrianMap = function (on) {
                    var histToggle = document.getElementById('histToggle');
                    var histOn = histToggle && histToggle.checked;
                    if (on && !histOn) {
                        if (histToggle) histToggle.checked = true;
                        window.toggleHistLayer(true);
                        histOn = true;
                    }
                    if (on && histOn) {
                        window._austrianMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._austrianMapLayer) && map.removeLayer(window._austrianMapLayer);
                    }
                };

                window.setAustrianMapOpacity = function (val) {
                    document.getElementById('austrianMapPct').textContent = val + '%';
                    window._austrianMapLayer.setOpacity(val / 100);
                };
            })();

            // ── APM 2.0 LAYER (XYZ tiles, JPG, zoom 4-15, direct din Cloudflare R2) ──
            // Trei seturi de tile-uri (principal + NORD + SUD) sunt suprapuse în aceeași
            // pană, pe aceleași bounds/zoom. Fiecare set are doar tile-urile pe care le
            // are fizic în R2 — restul cad pe errorTileUrl (transparent) — așa că cele
            // trei surse se "îmbină" vizual într-o singură hartă completă.
            (function () {
                map.createPane('pane_apm20');
                map.getPane('pane_apm20').style.zIndex = 645;
                map.getPane('pane_apm20').style.pointerEvents = 'none';

                var _apm20Bounds = L.latLngBounds(
                    L.latLng(42.86543190058622, 19.900994668187472),
                    L.latLng(49.003192791122444, 30.671530270425873)
                );

                // ── Tile layer simplu, direct (fără canvas, fără citire de pixeli) ──
                // Am eliminat eliminarea fundalului alb/crem și încercarea de CORS:
                // procesarea pe canvas (getImageData pe fiecare tile) încetinea mult
                // zoom-ul, iar reîncărcarea CORS→fallback dubla cererile de rețea și
                // ducea la tile-uri care nu mai apăreau la zoom out. Tile layer-ul
                // standard Leaflet e mult mai rapid și de încredere.
                function _makeApm20Tile(urlTemplate) {
                    return L.tileLayer(urlTemplate, {
                        opacity: 0.40, // = 80% slider (default) din noul cap de 50% opacitate maximă
                        pane: 'pane_apm20',
                        attribution: '© DetectLab APM 2.0',
                        tms: false,
                        minZoom: 4,
                        maxZoom: 15,
                        bounds: _apm20Bounds
                    });
                }

                // Set principal (cel existent) + cele două seturi care completează zonele lipsă
                window._apm20Layer = _makeApm20Tile('https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/{z}/{x}/{y}.jpg');
                window._apm20NorthLayer = _makeApm20Tile('https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/NORD/{z}/{x}/{y}.jpg');
                window._apm20SouthLayer = _makeApm20Tile('https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/SUD/{z}/{x}/{y}.jpg');

                window._apm20AllLayers = [window._apm20Layer, window._apm20NorthLayer, window._apm20SouthLayer];
                window._apm20MergeLayers = [window._apm20NorthLayer, window._apm20SouthLayer];

                // Sub acest zoom se vede DOAR sursa principală; de la acest zoom în sus
                // (inclusiv) se "îmbină" și NORD + SUD peste ea.
                var APM20_MERGE_MIN_ZOOM = 10;
                window._apm20MergeMinZoom = APM20_MERGE_MIN_ZOOM; // expus global pentru Search Help

                // Adaugă/scoate NORD+SUD în funcție de zoom, doar cât timp APM 2.0 e activ
                function _apm20UpdateMergeLayers() {
                    if (!map.hasLayer(window._apm20Layer)) return; // APM 2.0 e oprit → nu facem nimic
                    var shouldMerge = map.getZoom() >= APM20_MERGE_MIN_ZOOM;
                    window._apm20MergeLayers.forEach(function (layer) {
                        if (shouldMerge) {
                            map.hasLayer(layer) || layer.addTo(map);
                        } else {
                            map.hasLayer(layer) && map.removeLayer(layer);
                        }
                    });
                }
                map.on('zoomend', _apm20UpdateMergeLayers);

                window.toggleApm20Layer = function (on) {
                    if (on) {
                        window._apm20Layer.addTo(map);
                        _apm20UpdateMergeLayers(); // adaugă și NORD/SUD dacă zoom-ul curent e ≥ 10
                    } else {
                        window._apm20AllLayers.forEach(function (layer) {
                            map.hasLayer(layer) && map.removeLayer(layer);
                        });
                    }
                };

                window.setApm20Opacity = function (val) {
                    document.getElementById('apm20Pct').textContent = val + '%';
                    var APM20_MAX_OPACITY = 0.5; // capul maxim de opacitate al stratului
                    window._apm20AllLayers.forEach(function (layer) {
                        layer.setOpacity((val / 100) * APM20_MAX_OPACITY);
                    });
                };
            })();

            // ── MUTUAL EXCLUSIVITY: APM Layer and APM 2.0 are never on at the same time ──
            (function () {
                var _origToggleApm = window.toggleApmLayer;
                var _origToggleApm20 = window.toggleApm20Layer;

                window.toggleApmLayer = function (on) {
                    _origToggleApm(on);
                    if (on) {
                        var apm20Toggle = document.getElementById('apm20Toggle');
                        if (apm20Toggle && apm20Toggle.checked) {
                            apm20Toggle.checked = false;
                            _origToggleApm20(false);
                            var apm20Pct = document.getElementById('apm20Pct');
                            if (apm20Pct) apm20Pct.textContent = '0%';
                            var searchHelpBtn = document.getElementById('apm20SearchHelpBtn');
                            if (searchHelpBtn) searchHelpBtn.style.display = 'none';
                            if (typeof window.clearApm20SearchHelp === 'function') window.clearApm20SearchHelp();
                        }
                        // Restore original legend when APM 1 comes back on
                        if (typeof window._updateApm20Legend === 'function') window._updateApm20Legend(false);
                    }
                };

                window.toggleApm20Layer = function (on) {
                    console.log('[APM2.0] toggleApm20Layer called, on =', on);
                    _origToggleApm20(on);
                    if (on) {
                        var apmToggle = document.getElementById('apmToggle');
                        if (apmToggle && apmToggle.checked) {
                            apmToggle.checked = false;
                            _origToggleApm(false);
                            var apmPct = document.getElementById('apmPct');
                            if (apmPct) apmPct.textContent = '0%';
                        }
                    }
                    window._updateApm20Legend(on);
                    if (typeof window._refreshApm20SearchHelpBtnVisibility === 'function') {
                        console.log('[APM2.0] calling _refreshApm20SearchHelpBtnVisibility...');
                        window._refreshApm20SearchHelpBtnVisibility();
                        setTimeout(window._refreshApm20SearchHelpBtnVisibility, 50);
                    } else {
                        console.warn('[APM2.0] _refreshApm20SearchHelpBtnVisibility NOT defined yet!');
                    }
                    if (!on && typeof window.clearApm20SearchHelp === 'function') window.clearApm20SearchHelp();
                };

                // ── APM 2.0 LEGEND SWITCHER ──
                var _apm20LegendColors = [
                    { color: '#ff0000', value: '1' },   // red
                    { color: '#ff00ff', value: '2' },   // magenta
                    { color: '#808000', value: '3' },   // olive/dark yellow
                    { color: '#ffff99', value: '4' },   // light yellow
                    { color: '#00cc00', value: '4.5' }, // green
                    { color: '#0000ff', value: '5' }    // blue
                ];
                // APM 2.0 has 6 legend entries: value 1 = no potential, then 2/3/4/4.5/5
                var _apm20WhatLegendDefs = [
                    { color: '#0000ff', keyEN: 'apm20_leg5', keyRO: 'apm20_leg5' },
                    { color: '#00cc00', keyEN: 'apm20_leg4', keyRO: 'apm20_leg4' },
                    { color: '#ffff99', keyEN: 'apm20_leg3', keyRO: 'apm20_leg3' },
                    { color: '#808000', keyEN: 'apm20_leg2', keyRO: 'apm20_leg2' },
                    { color: '#ff00ff', keyEN: 'apm20_leg2b', keyRO: 'apm20_leg2b' },
                    { color: '#ff0000', keyEN: 'apm20_leg1', keyRO: 'apm20_leg1' }
                ];
                var _apm20MapPillDefs = [
                    { color: '#ff0000', label: '1' },
                    { color: '#ff00ff', label: '2' },
                    { color: '#808000', label: '3' },
                    { color: '#ffff99', label: '4' },
                    { color: '#00cc00', label: '4.5' },
                    { color: '#0000ff', label: '5' }
                ];
                // Original APM legend defs
                var _origWhatLegendHTML = null;
                var _origPillsHTML = null;

                window._updateApm20Legend = function _updateApm20Legend(on) {
                    var whatLegend = document.getElementById('whatLegendItems');
                    var pillsContainer = document.getElementById('legendPills');
                    var lang = (typeof _lang !== 'undefined' ? _lang : 'en') || 'en';
                    var t = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : {};

                    if (on) {
                        // Save originals
                        if (whatLegend && !_origWhatLegendHTML) _origWhatLegendHTML = whatLegend.innerHTML;
                        if (pillsContainer && !_origPillsHTML) _origPillsHTML = pillsContainer.innerHTML;

                        // Update what-legend (6 items, top = highest)
                        if (whatLegend) {
                            whatLegend.innerHTML = _apm20WhatLegendDefs.map(function(d) {
                                var text = t[d.keyEN] || d.keyEN;
                                return '<div class="legend-item"><div class="legend-dot" style="background:' + d.color + '"></div><span class="t" data-key="' + d.keyEN + '">' + text + '</span></div>';
                            }).join('');
                        }
                        // Update map pills (6 items, low to high)
                        if (pillsContainer) {
                            pillsContainer.innerHTML = _apm20MapPillDefs.map(function(d) {
                                return '<div class="legend-pill"><div class="legend-pill-dot" style="background:' + d.color + '"></div><span>' + d.label + '</span></div>';
                            }).join('');
                        }
                    } else {
                        // Restore originals
                        if (whatLegend && _origWhatLegendHTML) {
                            whatLegend.innerHTML = _origWhatLegendHTML;
                            _origWhatLegendHTML = null;
                        }
                        if (pillsContainer && _origPillsHTML) {
                            pillsContainer.innerHTML = _origPillsHTML;
                            _origPillsHTML = null;
                        }
                        // Re-apply translations to restored items
                        if (typeof applyTranslations === 'function') applyTranslations();
                    }
                };
            })();

            // ── APM 2.0 SEARCH HELP (analiză culoare pe tile-uri vizibile + încadrare poligoane mov) ──
            // Activ doar când stratul APM 2.0 e pornit. La click pe buton:
            //  1. compune un canvas cu tile-urile JPG vizibile în viewport-ul curent
            //  2. clasifică fiecare pixel (sub-eșantionat) ca albastru / verde / galben / altceva,
            //     pe baza distanței euclidiene RGB faţă de culorile de referință din legendă
            //  3. regulă de prioritate pe zona analizată:
            //       - dacă densitatea albastru+verde e foarte mare  -> păstrează DOAR albastru
            //       - altfel, dacă există albastru SAU verde        -> păstrează albastru+verde
            //       - altfel (nu există nici albastru, nici verde)  -> fallback pe galben
            //  4. găsește componentele conexe ale măștii rezultate, ignoră clusterele mici
            //     (păstrăm doar zone mari/compacte), desenează un poligon mov (convex hull) per cluster
            (function () {
                map.createPane('pane_apm20_search_help');
                map.getPane('pane_apm20_search_help').style.zIndex = 646;

                var TILE_URL_TMPL = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/{z}/{x}/{y}.jpg';
                var TILE_URL_TMPL_NORTH = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/NORD/{z}/{x}/{y}.jpg';
                var TILE_URL_TMPL_SOUTH = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/SUD/{z}/{x}/{y}.jpg';
                var TILE_SIZE = 256;
                var GRID = 4;          // 4px/celulă — echilibru între rezoluție și viteză
                var MIN_CLUSTER_CELLS = 4;
                var SPLIT_CLUSTER_CELLS = 40000; // clustere mai mari decât asta sunt re-analizate pe masca originală (nedilatată)
                var MAX_CLUSTER_CELLS = 80000; // plasă de siguranță — trebuie > SPLIT_CLUSTER_CELLS, altfel split-ul de mai jos nu se mai execută niciodată
                var DENSE_THRESHOLD = 0.12;
                var TOL = 90;
                var MAX_AREA_KM2 = 150; // ~12x12 km viewport

                // Culori de referință — ajustate pentru ce returnează efectiv JPEG-ul (nu valorile pure din legendă)
                // JPEG compresie: albastrul pur #0000ff devine ~[30-60, 30-60, 200-230] în tile-uri comprimate
                var COL_BLUE   = [20, 20, 220];   // #0000ff comprimat JPEG
                var COL_GREEN  = [0, 185, 0];     // #00cc00 comprimat JPEG
                var COL_YELLOW = [240, 240, 140]; // #ffff99 comprimat JPEG

                var _resultLayerGroup = null;
                var _running = false;

                function _colorDist(r, g, b, ref) {
                    var dr = r - ref[0], dg = g - ref[1], db = b - ref[2];
                    return Math.sqrt(dr * dr + dg * dg + db * db);
                }

                // Clasifică un pixel: 0=none, 1=blue(score5), 2=green(score4.5), 3=yellow(score4), 4=dark-green-toward-blue(score4.8)
                // Regulă strictă: ALBASTRU înseamnă că B este NET dominant față de G.
                // Teal/verde-albăstrui (G ≈ B) → clasificat ca VERDE, nu albastru.
                // Tip 4: verde ÎNCHIS cu componentă albastră semnificativă (verde-teal spre albastru)
                //   Folosit DOAR în modul "blue rar" — înlocuiește tot verdele cu verdele care are afinitate albastră.
                var _debugPixelLog = true;
                function _classifyPixel(r, g, b) {
                    if (r + g + b < 15) return 0;
                    var total = r + g + b;
                    if (total < 40) return 0;
                    var rr = r / total, gr = g / total, br = b / total;

                    // ALBASTRU PUR (score 5): B net dominant față de atât R cât și G
                    // B trebuie să fie > G (nu doar aproape egal) și > R
                    // Condiție strictă: b > g * 1.3 elimină teal-ul/verde-albăstruiul
                    // Exemple valide: rgb(20,60,200), rgb(10,80,180), rgb(30,100,210)
                    // Exemple EXCLUSE: rgb(0,130,120) teal, rgb(0,100,100) teal
                    if (b > 80 && b > r * 2.0 && b > g * 1.3 && br > 0.38 && rr < 0.22) {
                        if (_debugPixelLog) { console.log('[APM2.0] 🔵 albastru RGB:', r, g, b, '| br:', br.toFixed(2), 'b/g:', (b/Math.max(g,1)).toFixed(2)); _debugPixelLog = false; }
                        return 1;
                    }

                    // VERDE ÎNCHIS SPRE ALBASTRU (score 4.8): verde cu componentă albastră notabilă
                    // G dominant dar B semnificativ (B ≥ 40% din G) și culoarea e închisă (nu verde lime strident)
                    // Exemple: rgb(0,120,80) verde-teal, rgb(0,100,70) verde forest, rgb(20,130,100)
                    // Excludem verdele lime pur (B prea mic față de G)
                    if (g > 60 && b > 30 && g > r * 1.4 && b >= g * 0.40 && b > r * 1.5 &&
                        gr > 0.30 && br > 0.15 && rr < 0.30 && g < 200) {
                        return 4;
                    }

                    // VERDE LIME/PUR (score 4.5): G net dominant față de R și B
                    // Include și teal-ul (G ≈ B, ambele mari, R mic) — e mai aproape de verde decât albastru
                    // Exemple: rgb(0,216,0), rgb(8,177,48), rgb(0,130,120) teal, rgb(50,200,30)
                    if (g > 80 && g > r * 1.4 && g > b * 0.7 && gr > 0.35 && rr < 0.35) return 2;

                    // GALBEN/OLIVE (score 4): R și G ambele mari, B mic
                    if (rr > 0.30 && gr > 0.30 && br < 0.22 && r > 100 && g > 100) return 3;

                    return 0;
                }

                // Conversii lat/lng <-> tile XYZ (Web Mercator standard, slippy-map)
                function _lon2tileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
                function _lat2tileY(lat, z) {
                    var rad = lat * Math.PI / 180;
                    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
                }
                function _tileX2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
                function _tileY2lat(y, z) {
                    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
                    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
                }

                // Token unic per sesiune de pagină: folosit doar pentru a forța o cerere
                // de rețea nouă când încărcăm cu CORS, ca să nu nimerim peste varianta
                // fără CORS deja pusă în cache-ul de imagini de stratul de hartă (altfel
                // img.onload se declanșează "cu succes" dar canvas-ul rămâne tainted).
                var _CORS_CACHE_BUST = '_apm20cb=' + Math.random().toString(36).slice(2);

                function _loadTileImage(url) {
                    return new Promise(function (resolve) {
                        function tryLoad(useCORS) {
                            var img = new Image();
                            var loadUrl = url;
                            if (useCORS) {
                                // Încercăm întâi cu CORS: e necesar ca să putem citi pixelii
                                // (getImageData) pentru analiza Search Help. Dacă bucket-ul R2
                                // trimite Access-Control-Allow-Origin, tile-ul se încarcă normal
                                // și canvas-ul compus nu rămâne "tainted".
                                img.crossOrigin = 'anonymous';
                                loadUrl += (url.indexOf('?') === -1 ? '?' : '&') + _CORS_CACHE_BUST;
                            }
                            img.onload = function () { resolve(img); };
                            img.onerror = function () {
                                if (useCORS) {
                                    // CORS a picat din orice motiv (header lipsă, eroare de rețea
                                    // etc.) — reîncărcăm fără crossOrigin ca tile-ul să apară
                                    // totuși, chiar dacă pixelii n-ar mai putea fi citiți.
                                    tryLoad(false);
                                    return;
                                }
                                resolve(null);
                            };
                            img.src = loadUrl;
                        }
                        tryLoad(true);
                    });

                }

                function _showToast(msg, durationMs) {
                    var toast = document.getElementById('apm20SearchHelpToast');
                    if (!toast) return;
                    toast.textContent = msg;
                    toast.style.display = 'block';
                    clearTimeout(toast._hideTimer);
                    toast._hideTimer = setTimeout(function () { toast.style.display = 'none'; }, durationMs || 3500);
                }

                // BFS flood-fill: componente conexe (8-conectivitate) pe grid-ul binar de mască
                function _connectedComponents(maskGrid, cols, rows) {
                    var visited = new Uint8Array(cols * rows);
                    var components = [];
                    for (var idx = 0; idx < cols * rows; idx++) {
                        if (visited[idx] || !maskGrid[idx]) continue;
                        var stack = [idx];
                        var cells = [];
                        visited[idx] = 1;
                        while (stack.length) {
                            var cur = stack.pop();
                            cells.push(cur);
                            var cx = cur % cols, cy = (cur - cx) / cols;
                            var nb = [
                                [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
                                [cx - 1, cy - 1], [cx + 1, cy - 1], [cx - 1, cy + 1], [cx + 1, cy + 1]
                            ];
                            for (var n = 0; n < nb.length; n++) {
                                var nx = nb[n][0], ny = nb[n][1];
                                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                                var nIdx = ny * cols + nx;
                                if (visited[nIdx] || !maskGrid[nIdx]) continue;
                                visited[nIdx] = 1;
                                stack.push(nIdx);
                            }
                        }
                        components.push(cells);
                    }
                    return components;
                }

                // Bisecție recursivă pe mediană (gen kd-tree): împarte un cluster de celule
                // în bucăți mai mici după poziția geometrică (NU după culoare).
                // Se folosește când o pată e prea mare ȘI prea uniformă ca să se separe
                // natural (densitate f. mare de albastru/verde, fără variație de nuanță
                // care să creeze o frontieră reală între sub-zone). Garantează că fiecare
                // bucată rezultată are cel mult maxSize celule, oricare ar fi forma petei.
                function _splitComponentByGeometry(cells, cols, maxSize) {
                    if (cells.length <= maxSize) return [cells];
                    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    var pts = cells.map(function (idx) {
                        var cx = idx % cols, cy = (idx - cx) / cols;
                        if (cx < minX) minX = cx;
                        if (cx > maxX) maxX = cx;
                        if (cy < minY) minY = cy;
                        if (cy > maxY) maxY = cy;
                        return { idx: idx, x: cx, y: cy };
                    });
                    // Tăiem mereu pe axa cu extindere mai mare, ca bucățile rezultate
                    // să tindă spre poligoane compacte, nu fâșii alungite.
                    var splitOnX = (maxX - minX) >= (maxY - minY);
                    pts.sort(function (a, b) { return splitOnX ? (a.x - b.x) : (a.y - b.y); });
                    var mid = Math.floor(pts.length / 2);
                    var left = pts.slice(0, mid).map(function (p) { return p.idx; });
                    var right = pts.slice(mid).map(function (p) { return p.idx; });
                    return _splitComponentByGeometry(left, cols, maxSize)
                        .concat(_splitComponentByGeometry(right, cols, maxSize));
                }

                // Convex hull (monotone chain) — păstrat ca fallback
                function _convexHull(points) {
                    if (points.length < 3) return points;
                    points = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
                    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
                    var lower = [];
                    for (var i = 0; i < points.length; i++) {
                        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], points[i]) <= 0) lower.pop();
                        lower.push(points[i]);
                    }
                    var upper = [];
                    for (var j = points.length - 1; j >= 0; j--) {
                        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], points[j]) <= 0) upper.pop();
                        upper.push(points[j]);
                    }
                    upper.pop(); lower.pop();
                    return lower.concat(upper);
                }

                // Outline concav: urmărește marginea reală a clusterului de celule (marching squares simplificat)
                // Returnează lista de puncte [px,py] de pe conturul exterior al clusterului.
                function _hullFromCells(cells, cols, cellSizePx) {
                    // Construim set rapid de celule
                    var cellSet = {};
                    cells.forEach(function(idx) { cellSet[idx] = true; });

                    function has(cx, cy) {
                        if (cx < 0 || cy < 0) return false;
                        return !!cellSet[cy * cols + cx];
                    }

                    // Găsim celula de start: cea mai de sus-stânga din cluster
                    var startIdx = cells.reduce(function(best, idx) {
                        var bx = best % cols, by = (best - bx) / cols;
                        var ix = idx % cols, iy = (idx - ix) / cols;
                        return (iy < by || (iy === by && ix < bx)) ? idx : best;
                    }, cells[0]);
                    var sx = startIdx % cols, sy = (startIdx - sx) / cols;

                    // Moore neighborhood tracing — urmărește conturul exterior
                    // Direcții: 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE
                    var dx = [1,1,0,-1,-1,-1,0,1];
                    var dy = [0,1,1,1,0,-1,-1,-1];

                    var outline = [];
                    var cx = sx, cy = sy;
                    var dir = 7; // venim din NE (standard pentru start de sus-stânga)
                    var maxSteps = cells.length * 4 + 8;
                    var steps = 0;

                    do {
                        outline.push([cx * cellSizePx + cellSizePx / 2, cy * cellSizePx + cellSizePx / 2]);
                        // Căutăm următoarea celulă din contur, rotind clockwise din direcția opusă celei de unde am venit
                        var backDir = (dir + 4) % 8;
                        var found = false;
                        for (var d = 0; d < 8; d++) {
                            var nd = (backDir + 1 + d) % 8;
                            var nx = cx + dx[nd], ny = cy + dy[nd];
                            if (has(nx, ny)) {
                                cx = nx; cy = ny; dir = nd;
                                found = true;
                                break;
                            }
                        }
                        if (!found) break;
                        steps++;
                    } while ((cx !== sx || cy !== sy) && steps < maxSteps);

                    // Dacă outline-ul e prea mic (forme degenerate), fallback la convex hull
                    if (outline.length < 3) {
                        var pts = cells.map(function(idx) {
                            var cx = idx % cols, cy = (idx - cx) / cols;
                            return [cx * cellSizePx + cellSizePx / 2, cy * cellSizePx + cellSizePx / 2];
                        });
                        return _convexHull(pts);
                    }

                    // Simplificăm outline-ul: păstrăm doar punctele care schimbă direcția (reducem zgomotul)
                    var simplified = [outline[0]];
                    for (var si = 1; si < outline.length - 1; si++) {
                        var prev = simplified[simplified.length - 1];
                        var curr = outline[si];
                        var next = outline[si + 1];
                        var ddx1 = curr[0] - prev[0], ddy1 = curr[1] - prev[1];
                        var ddx2 = next[0] - curr[0], ddy2 = next[1] - curr[1];
                        if (ddx1 !== ddx2 || ddy1 !== ddy2) simplified.push(curr);
                    }
                    simplified.push(outline[outline.length - 1]);
                    return simplified;
                }

                function _setButtonState(loading, T) {
                    var btn = document.getElementById('apm20SearchHelpBtn');
                    var labelSpan = document.getElementById('apm20SearchHelpLabel');
                    if (btn) btn.disabled = loading;
                    if (labelSpan) {
                        labelSpan.textContent = loading
                            ? (T['apm20_search_help_loading'] || 'Analyzing visible area…')
                            : (T['apm20_search_help'] || 'Search Help');
                    }
                }

                // Aria aproximativă (km²) a viewport-ului curent al hărții, calculată din bounds-ul real
                // (nu doar din nivelul de zoom — depinde și de dimensiunea ferestrei/ecranului).
                // Folosim formula haversine pentru lățime (la latitudinea medie) și înălțime, apoi le înmulțim.
                function _haversineKm(lat1, lng1, lat2, lng2) {
                    var R = 6371; // raza Pământului în km
                    var dLat = (lat2 - lat1) * Math.PI / 180;
                    var dLng = (lng2 - lng1) * Math.PI / 180;
                    var rLat1 = lat1 * Math.PI / 180, rLat2 = lat2 * Math.PI / 180;
                    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                            Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
                    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                }

                function _currentViewportAreaKm2() {
                    var b = map.getBounds();
                    var n = b.getNorth(), s = b.getSouth(), e = b.getEast(), w = b.getWest();
                    var midLat = (n + s) / 2;
                    var widthKm = _haversineKm(midLat, w, midLat, e);
                    var heightKm = _haversineKm(n, w, s, w);
                    return widthKm * heightKm;
                }

                // Arată/ascunde butonul "Search Help" și hint-ul de zoom: cât timp APM 2.0
                // e activ, afișăm fie hint-ul "Zoom in for advanced search" (zoom insuficient),
                // fie butonul "Search Help" (zoom suficient) — niciodată ambele simultan.
                var _apm20HintVisible = false;

                // Poziționarea se face acum integral din CSS (position:absolute, ancorat în
                // .map-wrapper — la fel ca celelalte hint-uri/controale ale hărții), așa că nu
                // mai e nevoie să recalculăm coordonate în JS la fiecare resize/scroll. Asta
                // elimină și bug-ul în care butonul "sărea" pe verticală când utilizatorul
                // interacționa cu slider-ele din panoul de opacitate (care declanșau recalculări
                // bazate pe getBoundingClientRect și un mic scroll/reflow al paginii).
                function _positionApm20Overlays() {
                    // no-op — păstrată doar pentru compatibilitate cu apelurile existente
                }
                window._positionApm20Overlays = _positionApm20Overlays;
                window._refreshApm20SearchHelpBtnVisibility = function () {
                    _positionApm20Overlays();
                    var btn = document.getElementById('apm20SearchHelpBtn');
                    var hint = document.getElementById('apm20SearchHelpHint');
                    var labelSpan = document.getElementById('apm20SearchHelpLabel');
                    if (!btn || !hint) {
                        console.error('[APM2.0] ❌ btn sau hint NU a fost găsit în DOM! Verifică ID-urile.');
                        return;
                    }
                    // Iconița „Ajutor de căutare” trăiește sub sliderul vertical de
                    // opacitate (#verticalOpacityActions): vizibilă doar când stratul
                    // APM 2.0 e pornit ȘI selectat în oglinda verticală. Hint-ul
                    // bottom-center nu se mai arată niciodată — la zoom insuficient
                    // iconița rămâne vizibilă (estompată, .needs-zoom), iar bula ei
                    // de informații arată mesajul de zoom.
                    var _vo = (typeof window.DetectLabVerticalOpacity !== 'undefined')
                        ? window.DetectLabVerticalOpacity : null;
                    var verticalActive = false;
                    if (_vo && typeof _vo.isActiveFor === 'function') {
                        try { verticalActive = _vo.isActiveFor('apm20OpacitySlider'); } catch (e) { verticalActive = false; }
                    }
                    var layerOn = !!(window._apm20Layer && map.hasLayer(window._apm20Layer));
                    var areaKm2 = _currentViewportAreaKm2();
                    var areaOk = areaKm2 <= MAX_AREA_KM2;

                    hint.classList.remove('visible');
                    hint.style.display = 'none';
                    _apm20HintVisible = false;

                    if (!layerOn || !verticalActive) {
                        btn.style.display = 'none';
                        btn.classList.remove('needs-zoom');
                        return;
                    }

                    var lang = (typeof currentLang !== 'undefined' ? currentLang : 'en') || 'en';
                    var T = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : {};
                    if (areaOk) {
                        btn.style.display = 'flex';
                        btn.classList.remove('needs-zoom');
                        if (labelSpan && !btn.disabled) {
                            labelSpan.textContent = T['apm20_search_help'] || 'Search Help';
                        }
                    } else {
                        btn.style.display = 'flex';
                        btn.classList.add('needs-zoom');
                        if (labelSpan && !btn.disabled) {
                            labelSpan.textContent = T['apm20_search_help_zoom'] || 'Zoom in more to use Search Help';
                        }
                        if (typeof window.clearApm20SearchHelp === 'function') window.clearApm20SearchHelp();
                    }
                };

                // Recalculăm vizibilitatea la fiecare schimbare de zoom/poziție/dimensiune a hărții
                map.on('zoomend moveend', function () {
                    window._refreshApm20SearchHelpBtnVisibility();
                });
                window.addEventListener('resize', function () {
                    window._refreshApm20SearchHelpBtnVisibility();
                });

                window.clearApm20SearchHelp = function () {
                    if (_resultLayerGroup) {
                        map.removeLayer(_resultLayerGroup);
                        _resultLayerGroup = null;
                    }
                };

                window.runApm20SearchHelp = function () {
                    if (_running) return;
                    if (!window._apm20Layer || !map.hasLayer(window._apm20Layer)) return; // doar când APM 2.0 e activ
                    if (_currentViewportAreaKm2() > MAX_AREA_KM2) {
                        var langZ = (typeof currentLang !== 'undefined' ? currentLang : 'en') || 'en';
                        var TZ = (typeof translations !== 'undefined' && translations[langZ]) ? translations[langZ] : {};
                        _showToast(TZ['apm20_search_help_zoom'] || 'Zoom in more to use Search Help', 3000);
                        return; // zoom insuficient, zona prea mare
                    }

                    window.clearApm20SearchHelp();
                    _running = true;

                    var lang = (typeof currentLang !== 'undefined' ? currentLang : 'en') || 'en';
                    var T = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : {};
                    _setButtonState(true, T);

                    var z = Math.round(map.getZoom());
                    var bounds = map.getBounds();
                    var minTileX = Math.max(0, Math.floor(_lon2tileX(bounds.getWest(), z)));
                    var maxTileX = Math.floor(_lon2tileX(bounds.getEast(), z));
                    var minTileY = Math.max(0, Math.floor(_lat2tileY(bounds.getNorth(), z)));
                    var maxTileY = Math.floor(_lat2tileY(bounds.getSouth(), z));

                    var tileXs = [], tileYs = [];
                    for (var tx = minTileX; tx <= maxTileX; tx++) tileXs.push(tx);
                    for (var ty = minTileY; ty <= maxTileY; ty++) tileYs.push(ty);

                    if (tileXs.length === 0 || tileYs.length === 0) { _finish(false, T); return; }

                    var compositeW = tileXs.length * TILE_SIZE;
                    var compositeH = tileYs.length * TILE_SIZE;
                    var canvas = document.createElement('canvas');
                    canvas.width = compositeW;
                    canvas.height = compositeH;
                    var ctx = canvas.getContext('2d');

                    // Sub zoom-ul de îmbinare, analizăm DOAR sursa principală (la fel ca pe hartă);
                    // de la zoom-ul de îmbinare în sus, completăm canvas-ul și cu NORD/SUD,
                    // exact ca ordinea de stivuire de pe hartă (principal → NORD → SUD).
                    var mergeInSearchHelp = z >= (window._apm20MergeMinZoom || 10);

                    var loadPromises = [];
                    tileXs.forEach(function (tx, ix) {
                        tileYs.forEach(function (ty, iy) {
                            var px = ix * TILE_SIZE, py = iy * TILE_SIZE;
                            var urls = [TILE_URL_TMPL];
                            if (mergeInSearchHelp) urls.push(TILE_URL_TMPL_NORTH, TILE_URL_TMPL_SOUTH);

                            // Desenăm secvențial (nu în paralel) per celulă, ca sursele care
                            // se încarcă mai târziu (NORD/SUD) să nu poată ajunge să fie
                            // suprascrise de cele anterioare — păstrăm ordinea de stivuire.
                            var chain = Promise.resolve();
                            urls.forEach(function (tmpl) {
                                var url = tmpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
                                chain = chain.then(function () {
                                    return _loadTileImage(url).then(function (img) {
                                        if (img) ctx.drawImage(img, px, py, TILE_SIZE, TILE_SIZE);
                                    });
                                });
                            });
                            loadPromises.push(chain);
                        });
                    });

                    Promise.all(loadPromises).then(function () {
                        var imgData;
                        try {
                            imgData = ctx.getImageData(0, 0, compositeW, compositeH);
                        } catch (e) {
                            console.warn('APM 2.0 Search Help: nu pot citi pixelii canvas-ului (CORS?)', e);
                            _finish(false, T, true);
                            return;
                        }
                        var data = imgData.data;

                        // ── DEBUG: samplez 300 pixeli și loghez distribuția de culori reale din JPEG ──
                        (function() {
                            var samples = [];
                            var step = Math.max(1, Math.floor(data.length / 4 / 300));
                            for (var si = 0; si < data.length / 4; si += step) {
                                var sr = data[si*4], sg = data[si*4+1], sb = data[si*4+2];
                                if (sr + sg + sb > 30) samples.push([sr, sg, sb]);
                            }
                            // grupez în buckets grossolane de culoare dominantă
                            var bBlu = samples.filter(function(p){ var t=p[0]+p[1]+p[2]; return p[2]/t > 0.38 && p[2] > 80; });
                            var bGrn = samples.filter(function(p){ var t=p[0]+p[1]+p[2]; return p[1]/t > 0.45 && p[1] > 80; });
                            var bYel = samples.filter(function(p){ return p[0] > 120 && p[1] > 120 && p[2] < 100; });
                            console.log('[APM2.0] 🎨 Sample', samples.length, 'pixeli: albastru=', bBlu.length, '| verde=', bGrn.length, '| galben=', bYel.length);
                            if (bBlu.length > 0) console.log('[APM2.0] 🔵 Exemple albastre:', bBlu.slice(0,5).map(function(p){return 'rgb('+p+')';}).join(', '));
                            if (bGrn.length > 0) console.log('[APM2.0] 🟢 Exemple verzi:', bGrn.slice(0,5).map(function(p){return 'rgb('+p+')';}).join(', '));
                            if (bBlu.length === 0 && bGrn.length === 0) {
                                // niciun pixel recunoscut — loghez primii 10 pixeli brut ca să vedem ce vine
                                console.warn('[APM2.0] ⚠️ NICIO culoare recunoscută! Primii pixeli brut:', samples.slice(0,10).map(function(p){return 'rgb('+p+')';}).join(', '));
                            }
                        })();

                        var cols = Math.max(1, Math.floor(compositeW / GRID));
                        var rows = Math.max(1, Math.floor(compositeH / GRID));

                        // tip dominant per celulă grid: 0=none, 1=blue, 2=green, 3=yellow, 4=verde-albăstrui
                        var cellType = new Uint8Array(cols * rows);
                        var counts = { blue: 0, green: 0, yellow: 0, darkGreenBlue: 0 };

                        // Eșantionare majoritară: votăm culoarea dominantă din toți pixelii celulei GRID×GRID
                        // Asta elimină dependența de un singur pixel și crește acuratețea masiv.
                        for (var gy = 0; gy < rows; gy++) {
                            for (var gx = 0; gx < cols; gx++) {
                                var vBlue = 0, vGreen = 0, vYellow = 0, vDarkGreenBlue = 0, vNone = 0;
                                for (var sy = 0; sy < GRID; sy++) {
                                    for (var sx = 0; sx < GRID; sx++) {
                                        var spx = gx * GRID + sx;
                                        var spy = gy * GRID + sy;
                                        if (spx >= compositeW || spy >= compositeH) continue;
                                        var pidx = (spy * compositeW + spx) * 4;
                                        var sc = _classifyPixel(data[pidx], data[pidx+1], data[pidx+2]);
                                        if (sc === 1) vBlue++;
                                        else if (sc === 2) vGreen++;
                                        else if (sc === 3) vYellow++;
                                        else if (sc === 4) vDarkGreenBlue++;
                                        else vNone++;
                                    }
                                }
                                var cls = 0;
                                if (vBlue >= vGreen && vBlue >= vYellow && vBlue >= vDarkGreenBlue && vBlue > vNone * 0.3) cls = 1;
                                else if (vDarkGreenBlue >= vGreen && vDarkGreenBlue >= vYellow && vDarkGreenBlue > vNone * 0.3) cls = 4;
                                else if (vGreen >= vBlue && vGreen >= vYellow && vGreen > vNone * 0.3) cls = 2;
                                else if (vYellow >= vBlue && vYellow >= vGreen && vYellow > vNone * 0.3) cls = 3;
                                cellType[gy * cols + gx] = cls;
                                if (cls === 1) counts.blue++;
                                else if (cls === 2) counts.green++;
                                else if (cls === 3) counts.yellow++;
                                else if (cls === 4) counts.darkGreenBlue++;
                            }
                        }

                        // ── Regulă de prioritate ──
                        // 1) albastru + verde au prioritate peste galben
                        // 2) dacă densitatea albastru+verde e foarte mare în zona vizibilă, păstrăm DOAR albastru
                        // 3) dacă nu există nici albastru, nici verde, recurgem la galben
                        var totalCells = cols * rows;
                        console.log('[APM2.0] Clasificare grid:', cols, 'x', rows, '=', totalCells, 'celule | blue:', counts.blue, '| green:', counts.green, '| yellow:', counts.yellow, '| verde-albăstrui:', counts.darkGreenBlue);

                        var hasBlue = counts.blue > 0;
                        var hasGreen = counts.green > 0 || counts.darkGreenBlue > 0;
                        var blueRatio = counts.blue / totalCells;
                        var greenRatio = (counts.green + counts.darkGreenBlue) / totalCells;

                        // Prioritate: blue > green > yellow
                        // Dacă avem suficient blue (>0.3% din celule), încadrăm DOAR blue
                        // Dacă avem blue mai puțin sau deloc, includem și green
                        // Fallback yellow doar dacă nu există nici blue nici green
                        // ── Selecție tip țintă ──
                        // Dacă zona e dominată de blue+green (>40% celule active), selectăm DOAR blue.
                        // Altfel folosim blue cu prioritate, sau blue+green dacă e puțin blue.
                        var totalActive = counts.blue + counts.green + counts.yellow + counts.darkGreenBlue;
                        var activeFraction = totalActive / totalCells;

                        // ── Regulă nouă de prioritate ──
                        // Verificăm dacă există atât albastru cât și verde/galben în zona vizibilă:
                        //   → Dacă există albastru suficient (≥2% din celulele active): DOAR albastru
                        //   → Dacă există albastru dar foarte puțin (<2% din activ): albastru + verde ÎNCHIS SPRE ALBASTRU (tip 4)
                        //     (nu tot verdele — doar verdele cu afinitate albastră, verde forest/teal)
                        //   → Dacă există DOAR verde (fără albastru): încadrăm verde
                        //   → Dacă nu există nici albastru, nici verde: fallback galben
                        var hasYellow = counts.yellow > 0;
                        var hasGreenAny = counts.green > 0 || counts.darkGreenBlue > 0;
                        var hasDarkGreenBlue = counts.darkGreenBlue > 0;
                        var mixedColors = hasBlue && (hasGreenAny || hasYellow);
                        // Prag minim: albastrul trebuie să fie cel puțin 2% din celulele active
                        // ca să fie poligonizat singur. Sub acest prag, e prea rar/izolat.
                        var BLUE_MIN_FRACTION = 0.02;
                        var blueOfActive = totalActive > 0 ? counts.blue / totalActive : 0;
                        var blueSufficient = hasBlue && blueOfActive >= BLUE_MIN_FRACTION;

                        var targetTypes;
                        if (blueSufficient) {
                            // Albastru suficient → DOAR albastru (cel mai valoros)
                            targetTypes = [1];
                            console.log('[APM2.0] Mod: BLUE suficient (' + (blueOfActive*100).toFixed(1) + '% din activ) → DOAR BLUE');
                        } else if (hasBlue && hasDarkGreenBlue) {
                            // Albastru există dar e foarte rar → blue + verde ÎNCHIS SPRE ALBASTRU (tip 4)
                            // Nu poligonizăm tot verdele, doar verdele cu afinitate albastră (verde forest/teal)
                            targetTypes = [1, 4];
                            console.log('[APM2.0] Mod: BLUE rar (' + (blueOfActive*100).toFixed(1) + '% din activ) → BLUE + VERDE-ALBĂSTRUI (tip 4)');
                        } else if (hasBlue && hasGreenAny) {
                            // Albastru rar și nu există verde-albăstrui distinct → blue + tot verdele
                            targetTypes = [1, 4, 2];
                            console.log('[APM2.0] Mod: BLUE rar (' + (blueOfActive*100).toFixed(1) + '% din activ) → BLUE + GREEN (fără verde-albăstrui distinct)');
                        } else if (hasGreenAny) {
                            // Nu există albastru → încadrăm verde
                            targetTypes = [2, 4];
                            console.log('[APM2.0] Mod: DOAR GREEN (fără blue)');
                        } else {
                            // Fallback galben
                            targetTypes = [3];
                            console.log('[APM2.0] Mod: fallback YELLOW');
                        }

                        // Mască originală (nedilatată) — referință pentru split
                        var maskOriginal = new Uint8Array(totalCells);
                        for (var i = 0; i < totalCells; i++) {
                            maskOriginal[i] = targetTypes.indexOf(cellType[i]) >= 0 ? 1 : 0;
                        }

                        // ── Filtru densitate locală când zona e foarte densă ──
                        // Aplicăm doar când >55% activ: păstrăm celule cu ≥2 vecini în 3x3.
                        // Elimină pixeli izolați și păstrează clustere reale.
                        if (activeFraction > 0.55) {
                            var maskFiltered = new Uint8Array(totalCells);
                            for (var fy = 0; fy < rows; fy++) {
                                for (var fx = 0; fx < cols; fx++) {
                                    if (!maskOriginal[fy * cols + fx]) continue;
                                    var localCount = 0;
                                    for (var wy = -1; wy <= 1; wy++) {
                                        for (var wx = -1; wx <= 1; wx++) {
                                            var ny2 = fy + wy, nx2 = fx + wx;
                                            if (ny2 >= 0 && ny2 < rows && nx2 >= 0 && nx2 < cols) {
                                                if (maskOriginal[ny2 * cols + nx2]) localCount++;
                                            }
                                        }
                                    }
                                    if (localCount >= 2) maskFiltered[fy * cols + fx] = 1;
                                }
                            }
                            maskOriginal = maskFiltered;
                            var filteredCount = 0;
                            for (var fi2 = 0; fi2 < totalCells; fi2++) { if (maskOriginal[fi2]) filteredCount++; }
                            console.log('[APM2.0] Filtru 3x3: ' + filteredCount + ' celule rămase');
                        }

                        // ── Viewport clipping: zero-ificăm celulele din afara bounds-ului vizibil exact ──
                        // Tile-urile acoperă o zonă mai mare decât ecranul — eliminăm ce nu se vede.
                        (function () {
                            var vb = map.getBounds();
                            var vNorth = vb.getNorth(), vSouth = vb.getSouth();
                            var vWest  = vb.getWest(),  vEast  = vb.getEast();
                            for (var vy = 0; vy < rows; vy++) {
                                for (var vx = 0; vx < cols; vx++) {
                                    if (!maskOriginal[vy * cols + vx]) continue;
                                    // centrul celulei în lat/lng
                                    var cellGlobalTileX = tileXs[0] + (vx * GRID + GRID / 2) / TILE_SIZE;
                                    var cellGlobalTileY = tileYs[0] + (vy * GRID + GRID / 2) / TILE_SIZE;
                                    var cellLat = _tileY2lat(cellGlobalTileY, z);
                                    var cellLng = _tileX2lon(cellGlobalTileX, z);
                                    if (cellLat > vNorth || cellLat < vSouth ||
                                        cellLng < vWest  || cellLng > vEast) {
                                        maskOriginal[vy * cols + vx] = 0;
                                    }
                                }
                            }
                        })();

                        // Dilatare adaptivă:
                        // - Dacă suntem în mod "doar albastru" și există și verde/galben în imagine
                        //   (mixedColors), NU dilatăm deloc — vrem să izolăm strict patch-urile albastre
                        //   fără să le fuzionăm cu verdele/galbenul imediat vecin.
                        // - Altfel, dilatăm 1 celulă (3x3) pentru a uni patch-uri apropiate.
                        // Dezactivăm dilatarea când selectăm DOAR albastru în prezența altor culori
                        // (altfel dilatarea fuzionează patch-urile albastre cu verdele vecin)
                        var _mixedBlueOnly = (targetTypes.length === 1 && targetTypes[0] === 1 && (hasGreen || hasYellow));
                        var maskGrid = new Uint8Array(totalCells);
                        if (_mixedBlueOnly) {
                            // Fără dilatare — copiem masca originală direct
                            for (var di2 = 0; di2 < totalCells; di2++) maskGrid[di2] = maskOriginal[di2];
                            console.log('[APM2.0] Dilatare DEZACTIVATĂ (mod blue-only cu mix de culori)');
                        } else {
                            for (var dy = 0; dy < rows; dy++) {
                                for (var dx = 0; dx < cols; dx++) {
                                    if (maskOriginal[dy * cols + dx]) { maskGrid[dy * cols + dx] = 1; continue; }
                                    var found = false;
                                    outerD: for (var ky = -1; ky <= 1 && !found; ky++) {
                                        for (var kx = -1; kx <= 1 && !found; kx++) {
                                            var nx2 = dx + kx, ny2 = dy + ky;
                                            if (nx2 >= 0 && ny2 >= 0 && nx2 < cols && ny2 < rows && maskOriginal[ny2 * cols + nx2]) found = true;
                                        }
                                    }
                                    maskGrid[dy * cols + dx] = found ? 1 : 0;
                                }
                            }
                        }

                        var components = _connectedComponents(maskGrid, cols, rows);

                        // Clustere prea mari (fuzionate prin dilatare) → re-analizate pe masca originală
                        var finalComponents = [];
                        components.forEach(function(comp) {
                            if (comp.length < MIN_CLUSTER_CELLS) return;
                            if (comp.length > SPLIT_CLUSTER_CELLS) {
                                // Cluster mare, probabil fuzionat prin dilatare — îl re-analizăm pe masca
                                // originală (nedilatată) ca să recuperăm sub-zonele reale, în loc să-l aruncăm direct.
                                var subMask = new Uint8Array(totalCells);
                                comp.forEach(function(idx) { if (maskOriginal[idx]) subMask[idx] = 1; });
                                var subComps = _connectedComponents(subMask, cols, rows);

                                var produced = 0, dropped = 0, forcedCount = 0;
                                subComps.forEach(function(sc) {
                                    if (sc.length < MIN_CLUSTER_CELLS) { dropped++; return; }
                                    if (sc.length <= MAX_CLUSTER_CELLS) {
                                        finalComponents.push(sc);
                                        produced++;
                                        return;
                                    }
                                    // Sub-componenta e TOT prea mare — înseamnă că pata e foarte
                                    // densă și uniformă (fără diferență de nuanță suficientă ca să
                                    // se separe natural, ex. zone masive de albastru/verde).
                                    // În loc să o aruncăm, o împărțim forțat pe poziție geometrică
                                    // (bisecție recursivă) în bucăți mai mici, valide ca poligoane.
                                    forcedCount++;
                                    var pieces = _splitComponentByGeometry(sc, cols, MAX_CLUSTER_CELLS);
                                    pieces.forEach(function(piece) {
                                        if (piece.length >= MIN_CLUSTER_CELLS) {
                                            finalComponents.push(piece);
                                            produced++;
                                        } else {
                                            dropped++;
                                        }
                                    });
                                });
                                console.log('[APM2.0] Cluster mare (' + comp.length + ') → ' + produced + ' sub-clustere finale' +
                                    (forcedCount > 0 ? ' (' + forcedCount + ' pete uniforme împărțite forțat geometric)' : '') +
                                    (dropped > 0 ? ' (' + dropped + ' eliminate: prea mici)' : ''));
                            } else {
                                finalComponents.push(comp);
                            }
                        });

                        console.log('[APM2.0] Componente finale:', finalComponents.length, '(din', components.length, 'totale)');
                        var bigComponents = finalComponents;

                        if (bigComponents.length === 0) { _finish(false, T); return; }

                        function _pixelToLatLng(px, py) {
                            var globalTileX = tileXs[0] + px / TILE_SIZE;
                            var globalTileY = tileYs[0] + py / TILE_SIZE;
                            return L.latLng(_tileY2lat(globalTileY, z), _tileX2lon(globalTileX, z));
                        }

                        // ── Heritage exclusion helpers ──────────────────────────────────────────

                        // Fetch Heritage site circles direct din API pentru viewport curent
                        function _fetchHeritageSiteCirclesForBounds(fetchBounds) {
                            return new Promise(function (resolve) {
                                var REST_BASE = 'https://eism.geo-spatial.ro/eismgeo/rest/services/Patrimoniu/PatrimoniuWM/MapServer';
                                var LAYERS = [0, 5, 6];
                                var circles = [];
                                var pending = LAYERS.length;

                                function done() {
                                    pending--;
                                    if (pending === 0) resolve(circles);
                                }

                                LAYERS.forEach(function (lid) {
                                    var sw = L.CRS.EPSG3857.project(fetchBounds.getSouthWest());
                                    var ne = L.CRS.EPSG3857.project(fetchBounds.getNorthEast());
                                    var url = REST_BASE + '/' + lid + '/query'
                                        + '?where=1%3D1'
                                        + '&geometry=' + encodeURIComponent(sw.x + ',' + sw.y + ',' + ne.x + ',' + ne.y)
                                        + '&geometryType=esriGeometryEnvelope'
                                        + '&inSR=102100&spatialRel=esriSpatialRelIntersects'
                                        + '&outFields=OBJECTID&returnGeometry=true&outSR=4326'
                                        + '&resultRecordCount=2000&f=json';

                                    var timedOut = false;
                                    var timer = setTimeout(function () {
                                        timedOut = true;
                                        console.warn('[APM2.0 Heritage] timeout layer', lid);
                                        done();
                                    }, 5000);

                                    jsonpFetch(url, function (data) {
                                        if (timedOut) return;
                                        clearTimeout(timer);
                                        if (data && data.features) {
                                            data.features.forEach(function (f) {
                                                var g = f.geometry, gt = data.geometryType;
                                                if (!g) return;
                                                if (gt === 'esriGeometryPoint' && !isNaN(g.x) && !isNaN(g.y)) {
                                                    circles.push({ latlng: L.latLng(g.y, g.x), radiusM: 600 });
                                                } else if (gt === 'esriGeometryPolygon' && g.rings) {
                                                    g.rings.forEach(function (ring) {
                                                        ring.forEach(function (pt) {
                                                            circles.push({ latlng: L.latLng(pt[1], pt[0]), radiusM: 600 });
                                                        });
                                                    });
                                                } else if (gt === 'esriGeometryPolyline' && g.paths) {
                                                    g.paths.forEach(function (path) {
                                                        path.forEach(function (pt) {
                                                            circles.push({ latlng: L.latLng(pt[1], pt[0]), radiusM: 600 });
                                                        });
                                                    });
                                                }
                                            });
                                        }
                                        done();
                                    });
                                });
                            });
                        }

                        // Construiește o mască booleană: pentru fiecare celulă din grilă,
                        // marchează true dacă centrul ei se află în orice radius Heritage (600m).
                        // Lucrăm direct în spațiul pixel/grid — fără geometrie vectorială.
                        function _buildHeritageMask(hCircles, cols, rows, pixelToLatLng) {
                            var mask = new Uint8Array(cols * rows);
                            if (!hCircles.length) return mask;

                            // Convertim fiecare sit Heritage în coordonate pixel ale canvas-ului compozit.
                            // map.project() → coordonate globale tile la zoom z → scădem originea canvas-ului.
                            var originPt = map.project(
                                L.latLng(_tileY2lat(tileYs[0], z), _tileX2lon(tileXs[0], z)), z
                            );
                            // Deduplicăm siturile prea apropiate (< 50px) pentru a reduce iterațiile
                            var hPx = [];
                            var seen = {};
                            hCircles.forEach(function (hc) {
                                var pt = map.project(hc.latlng, z);
                                var cx = pt.x - originPt.x;
                                var cy = pt.y - originPt.y;
                                // Raza în pixeli: 600m → pixeli la zoom z
                                var latRad = hc.latlng.lat * Math.PI / 180;
                                var mPerPx = (156543.03392 * Math.cos(latRad)) / Math.pow(2, z);
                                var rPx = hc.radiusM / mPerPx;
                                // dedup key la 30px grid
                                var dk = Math.round(cx / 30) + ',' + Math.round(cy / 30);
                                if (seen[dk]) return;
                                seen[dk] = true;
                                hPx.push({ cx: cx, cy: cy, rPxSq: rPx * rPx });
                            });

                            // Comparăm fiecare celulă cu fiecare sit în spațiu pixel — fără trig
                            for (var gy = 0; gy < rows; gy++) {
                                var cpy = gy * GRID + GRID / 2;
                                for (var gx = 0; gx < cols; gx++) {
                                    var cpx = gx * GRID + GRID / 2;
                                    for (var ci = 0; ci < hPx.length; ci++) {
                                        var h = hPx[ci];
                                        var dx = cpx - h.cx, dy = cpy - h.cy;
                                        if (dx * dx + dy * dy < h.rPxSq) {
                                            mask[gy * cols + gx] = 1;
                                            break;
                                        }
                                    }
                                }
                            }
                            return mask;
                        }

                        // Un cluster conflictează cu Heritage dacă ORICE celulă a sa
                        // se află în masca Heritage.
                        function _clusterConflictsHeritage(cells, hMask) {
                            for (var i = 0; i < cells.length; i++) {
                                if (hMask[cells[i]]) return true;
                            }
                            return false;
                        }
                        // ────────────────────────────────────────────────────────────────────────

                        // Fetch Heritage sites direct din API, viewport extins 15%
                        var _hBounds = map.getBounds().pad(0.15);
                        _fetchHeritageSiteCirclesForBounds(_hBounds).then(function (heritageSiteCircles) {
                            console.log('[APM2.0] Heritage exclusion: found', heritageSiteCircles.length, 'site circles from API');

                            // Construim masca Heritage pe aceeași grilă ca analiza APM
                            // Fiecare celulă din grilă e marcată dacă centrul ei e în vreun radius de 600m
                            var hMask = _buildHeritageMask(heritageSiteCircles, cols, rows, _pixelToLatLng);
                            var maskedCells = 0;
                            for (var mi = 0; mi < hMask.length; mi++) { if (hMask[mi]) maskedCells++; }
                            console.log('[APM2.0] Celule Heritage excluse din grilă:', maskedCells, '/', hMask.length);

                            _resultLayerGroup = L.layerGroup();
                            var skippedByHeritage = 0;
                            var clippedByHeritage = 0;

                            function _drawCluster(cells) {
                                var hull = _hullFromCells(cells, cols, GRID);
                                if (hull.length < 3) return;
                                var latlngs = hull.map(function (p) { return _pixelToLatLng(p[0], p[1]); });
                                var poly = L.polygon(latlngs, {
                                    color: '#a020f0',
                                    weight: 2.5,
                                    fillColor: '#a020f0',
                                    fillOpacity: 0.12,
                                    opacity: 0.85,
                                    pane: 'pane_apm20_search_help'
                                });
                                _resultLayerGroup.addLayer(poly);
                            }

                            bigComponents.forEach(function (cells) {
                                if (!_clusterConflictsHeritage(cells, hMask)) {
                                    // Fără conflict Heritage — desenăm direct
                                    _drawCluster(cells);
                                    return;
                                }

                                // ── Decupăm celulele Heritage din cluster și redesenăm ce rămâne ──
                                var clipped = cells.filter(function(idx) { return !hMask[idx]; });
                                console.log('[APM2.0] Cluster tăiat Heritage: ' + cells.length + ' → ' + clipped.length + ' celule rămase');

                                if (clipped.length < MIN_CLUSTER_CELLS) {
                                    skippedByHeritage++;
                                    return;
                                }
                                clippedByHeritage++;

                                // Re-run connected components pe celulele rămase (tăierea Heritage
                                // poate rupe un cluster mare în mai multe bucăți disjuncte)
                                var subMaskClip = new Uint8Array(cols * rows);
                                clipped.forEach(function(idx) { subMaskClip[idx] = 1; });
                                var subComps = _connectedComponents(subMaskClip, cols, rows);

                                subComps.forEach(function(sc) {
                                    if (sc.length < MIN_CLUSTER_CELLS) return;
                                    if (sc.length <= MAX_CLUSTER_CELLS) {
                                        _drawCluster(sc);
                                    } else {
                                        var pieces = _splitComponentByGeometry(sc, cols, MAX_CLUSTER_CELLS);
                                        pieces.forEach(function(piece) {
                                            if (piece.length >= MIN_CLUSTER_CELLS) _drawCluster(piece);
                                        });
                                    }
                                });
                            });
                            console.log('[APM2.0] Clustere excluse complet (Heritage):', skippedByHeritage, '| tăiate parțial:', clippedByHeritage);
                            var addedPolys = _resultLayerGroup.getLayers().length;
                            _resultLayerGroup.addTo(map);

                            _finish(addedPolys > 0, T);
                        });
                    }).catch(function (e) {
                        console.warn('APM 2.0 Search Help error:', e);
                        _finish(false, T, true);
                    });

                    function _finish(found, T, errored) {
                        _running = false;
                        _setButtonState(false, T);
                        /* Dacă zoom-ul s-a schimbat în timpul analizei, resincronizăm
                           iconița (needs-zoom + bulă de zoom) imediat ce ieșim din loading. */
                        try {
                            if (typeof window._refreshApm20SearchHelpBtnVisibility === 'function') {
                                window._refreshApm20SearchHelpBtnVisibility();
                            }
                        } catch (e) { /* never break _finish */ }
                        if (errored) {
                            _showToast(T['apm20_search_help_error'] || 'Could not analyze the visible area, please try again', 4000);
                        } else if (!found) {
                            _showToast(T['apm20_search_help_empty'] || 'No clear high-potential zones found in the visible area', 3500);
                        }
                    }
                };
            })();

            (function () {
                map.createPane('pane_firingplans');
                map.getPane('pane_firingplans').style.zIndex = 641;
                map.getPane('pane_firingplans').style.pointerEvents = 'none';

                window._firingPlansLayer = L.tileLayer.wms(DL.url2d('hist.firing-plans'), DL.wms2dOptions('hist.firing-plans', {
                    pane: 'pane_firingplans'
                }));

                window.toggleFiringPlans = function (on) {
                    var histToggle = document.getElementById('histToggle');
                    var histOn = histToggle && histToggle.checked;
                    if (on && !histOn) {
                        if (histToggle) histToggle.checked = true;
                        window.toggleHistLayer(true);
                        histOn = true;
                    }
                    if (on && histOn) {
                        window._firingPlansLayer.addTo(map);
                    } else {
                        map.hasLayer(window._firingPlansLayer) && map.removeLayer(window._firingPlansLayer);
                    }
                };

                window.setFiringPlansOpacity = function (val) {
                    document.getElementById('firingPlansPct').textContent = val + '%';
                    window._firingPlansLayer.setOpacity(val / 100);
                };
            })();

            // ── SOVIET MAP 1970s WMS LAYER ──
            (function () {
                map.createPane('pane_sovietmap');
                map.getPane('pane_sovietmap').style.zIndex = 642;
                map.getPane('pane_sovietmap').style.pointerEvents = 'none';

                window._sovietMapLayer = L.tileLayer.wms(DL.url2d('hist.soviet-1970'), DL.wms2dOptions('hist.soviet-1970', {
                    pane: 'pane_sovietmap'
                }));

                window.toggleSovietMap = function (on) {
                    var histToggle = document.getElementById('histToggle');
                    var histOn = histToggle && histToggle.checked;
                    if (on && !histOn) {
                        if (histToggle) histToggle.checked = true;
                        window.toggleHistLayer(true);
                        histOn = true;
                    }
                    if (on && histOn) {
                        window._sovietMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._sovietMapLayer) && map.removeLayer(window._sovietMapLayer);
                    }
                };

                window.setSovietMapOpacity = function (val) {
                    document.getElementById('sovietMapPct').textContent = val + '%';
                    window._sovietMapLayer.setOpacity(val / 100);
                };
            })();

            // ── PREMIUM HISTORICAL MAPS COVERAGE POLYGONS ──
            // Create a shared pane for all coverage polygons
            map.createPane('pane_hist_coverage');
            map.getPane('pane_hist_coverage').style.zIndex = 615;
            map.getPane('pane_hist_coverage').style.pointerEvents = 'none';

            // Rough geographic bounds for each premium historical map
            var premiumMapCoverageBounds = {
                josephine: {
                    bounds: [[44.963611, 21.972695], [47.873181, 26.719332]],
                    label: 'Josephine Map +',
                    layerVar: '_jLayer'
                },
                bucovina: {
                    bounds: [[47.514971, 21.796526], [48.457705, 26.723135]],
                    label: 'Bucovina 1861-1864',
                    layerVar: '_bucovinaMapLayer'
                },
                austrohu: {
                    bounds: [[47.5469, 21.6211], [48.3124, 26.8506]],
                    label: 'Austro-Hungarian 1861-1864',
                    layerVar: '_austrohuMapLayer'
                },

                moldova1868: {
                    bounds: [[44.9959, 26.2354], [48.3124, 29.8389]],
                    label: 'Moldova 1868',
                    layerVar: '_moldova1868MapLayer'
                },

                moldovawwii: {
                    bounds: [[44.7467, 26.4990], [48.3124, 29.8389]],
                    label: 'Moldova WWII',
                    layerVar: '_moldovaWwiiMapLayer'
                },

                polishtactical1933: {
                    bounds: [[47.6950, 22.0166], [48.3124, 28.3887]],
                    label: 'Polish Tactical 1933',
                    layerVar: '_polishTactical1933MapLayer'
                },

                ww1: {
                    bounds: [[43.3252, 22.3242], [48.3416, 29.8828]],
                    label: 'WWI',
                    layerVar: '_ww1MapLayer'
                },

                ww2: {
                    bounds: [[43.8345, 20.0391], [48.4584, 29.8828]],
                    label: 'WWII',
                    layerVar: '_ww2MapLayer'
                },

                satellite60s: {
                    // CORONA imagery (CAST GeoServer) — the catalogue is
                    // loaded for the WHOLE of Europe (js/corona-wms-layer.js,
                    // CoronaAtlas.EUROPE_BBOX). These bounds exist only for
                    // the layer-row highlight; the red "where is this layer"
                    // rectangle is suppressed (noCoverageRect) because a
                    // Europe-wide rectangle reads as "imagery everywhere",
                    // which is false — CORONA is a set of narrow 1960s pass
                    // strips. The REAL footprints are drawn by the coverage
                    // outlines (js/corona-coverage-layer.js), straight from
                    // the same catalogue the original Corona Atlas uses.
                    bounds: [[34.0, -25.0], [72.0, 60.0]],
                    label: "Satellite imagery 60's",
                    layerVar: '_sat60MapLayer',
                    coverageMinZoom: 8,
                    noCoverageRect: true
                },

                banat: {
                    // Banat 1769-1772 (Habsburg Banat maps, raster XYZ tiles on Supabase).
                    // Rough bounds covering the Banat region in western Romania.
                    bounds: [[44.55, 20.85], [46.35, 22.45]],
                    label: 'Banat 1769-1772',
                    layerVar: '_banatMapLayer'
                },

                transylvania1859: {
                    // Harta Transilvaniei 1859 (Tiled Map Service, ArcGIS Online —
                    // Siebenburgen_1859). fullExtent-ul serviciului convertit în WGS84.
                    // Digitalizare și publicare: Universitatea „Ștefan cel Mare” din
                    // Suceava — sursă: bukowina1856.eu.
                    // Tile-urile native există doar la zoom 7-14 (minLOD 7, maxLOD 14),
                    // deci dreptunghiul roșu de acoperire se arată în afara intervalului.
                    bounds: [[45.2059, 22.2319], [47.7300, 26.7037]],
                    label: 'Harta Transilvaniei 1859',
                    layerVar: '_transylvania1859MapLayer',
                    coverageMinZoom: 7,
                    coverageMaxZoom: 14
                },

                galicia1855: {
                    // Hartă administrativă a Galiției și Lodomeriei – 1855 (Tiled Map
                    // Service, ArcGIS Online — Kummerer_1855). fullExtent WGS84.
                    // Digitalizare și publicare: Universitatea „Ștefan cel Mare” din
                    // Suceava — sursă: bukowina1856.eu.
                    // Tile-urile native există doar la zoom 6-14 (minLOD 6, maxLOD 14).
                    bounds: [[46.8116, 18.3937], [50.8713, 26.6844]],
                    label: 'Hartă administrativă a Galiției și Lodomeriei – 1855',
                    layerVar: '_galicia1855MapLayer',
                    coverageMinZoom: 6,
                    coverageMaxZoom: 14
                },

                mitteleuropa: {
                    // Übersichtskarte von Mitteleuropa 1:300 000 (1893–1945) — CENAGIS / IH PAN
                    bounds: [[43.5, 5.0], [56.0, 32.0]],
                    label: 'Übersichtskarte von Mitteleuropa (1893–1945)',
                    layerVar: '_mitteleuropaMapLayer'
                },

                chrzanowski: {
                    // Harta generală a Regatului Poloniei – Wojciech Chrzanowski 1859 — CENAGIS / IH PAN
                    bounds: [[46.5, 14.5], [56.5, 33.5]],
                    label: 'Harta Wojciech Chrzanowski (1859)',
                    layerVar: '_chrzanowskiMapLayer'
                },

                reymann: {
                    // Special-Karte von Central-Europa – Daniel Gottlob Reymann (1806–1908) — CENAGIS / IH PAN
                    bounds: [[45.0, 5.0], [55.5, 30.0]],
                    label: 'Harta Central-Europa – Reymann (1806–1908)',
                    layerVar: '_reymannMapLayer'
                },

                kdr100k: {
                    // Karte des Deutschen Reiches 1:100 000 (1878–1945) — CENAGIS / IH PAN
                    bounds: [[45.5, 5.5], [56.0, 24.5]],
                    label: 'Karte des Deutschen Reiches (1878–1945)',
                    layerVar: '_kdr100kMapLayer'
                },

                kdr_gb: {
                    // Karte des Deutschen Reiches – Großblatt 1:100 000 (1914–1944) — CENAGIS / IH PAN
                    bounds: [[45.5, 5.5], [56.0, 31.0]],
                    label: 'Karte des Deutschen Reiches – Großblatt (1914–1944)',
                    layerVar: '_kdrGbMapLayer'
                },

                wig100k: {
                    // WIG 1:100 000 – Harta tactică a Poloniei (1919–1939) — CENAGIS / IH PAN
                    bounds: [[47.5, 14.0], [56.0, 33.0]],
                    label: 'Harta tactică a Poloniei – WIG 1:100k (1919–1939)',
                    layerVar: '_wig100kMapLayer'
                },

                vegfpPpi: {
                    // Amprenta Vegetației — PPI (CLMS HR-VPP, 10 m, la fiecare
                    // 10 zile). Acoperire: România pe .ro, toată Europa pe .eu.
                    // Sub z6 se arată dreptunghiul roșu de acoperire cât timp stratul e pornit.
                    bounds: (typeof _isEuropeMarket === 'function' && _isEuropeMarket()) ? [[34.0, -25.0], [72.0, 45.0]] : [[43.5, 19.5], [48.5, 30.5]],
                    label: 'Amprenta Vegetației — PPI',
                    layerVar: '_vegfpPpiLayer',
                    coverageMinZoom: 6
                },

                vegfpSmx: {
                    // Amprenta Vegetației — SMX (VPP MAXV SEASON1, 10 m,
                    // anual) — valoarea maximă de vegetație a anului.
                    bounds: (typeof _isEuropeMarket === 'function' && _isEuropeMarket()) ? [[34.0, -25.0], [72.0, 45.0]] : [[43.5, 19.5], [48.5, 30.5]],
                    label: 'Amprenta Vegetației — SMX',
                    layerVar: '_vegfpSmxLayer',
                    coverageMinZoom: 6
                },

                vegfpSgu: {
                    // Amprenta Vegetației — SGU (VPP LSLOPE SEASON1, 10 m,
                    // anual) — rata de creștere la începutul sezonului.
                    bounds: (typeof _isEuropeMarket === 'function' && _isEuropeMarket()) ? [[34.0, -25.0], [72.0, 45.0]] : [[43.5, 19.5], [48.5, 30.5]],
                    label: 'Amprenta Vegetației — SGU',
                    layerVar: '_vegfpSguLayer',
                    coverageMinZoom: 6
                },

                vegfpSgd: {
                    // Amprenta Vegetației — SGD (VPP RSLOPE SEASON1, 10 m,
                    // anual) — rata de ofilire la finalul sezonului.
                    bounds: (typeof _isEuropeMarket === 'function' && _isEuropeMarket()) ? [[34.0, -25.0], [72.0, 45.0]] : [[43.5, 19.5], [48.5, 30.5]],
                    label: 'Amprenta Vegetației — SGD',
                    layerVar: '_vegfpSgdLayer',
                    coverageMinZoom: 6
                }
            };

            // Create coverage polygons for each premium map
            var premiumMapCoveragePolygons = {};
            Object.keys(premiumMapCoverageBounds).forEach(function(mapKey) {
                var data = premiumMapCoverageBounds[mapKey];
                // Layers whose true coverage is NOT a rectangle (CORONA pass
                // strips) opt out — their footprints come from a dedicated
                // outline layer instead (see satellite60s above).
                if (data.noCoverageRect) return;
                premiumMapCoveragePolygons[mapKey] = L.rectangle(data.bounds, {
                    color: '#FF2800',
                    weight: 2,
                    opacity: 0.5,
                    fill: true,
                    fillColor: '#FF2800',
                    fillOpacity: 0.1,
                    dashArray: '5, 5',
                    pane: 'pane_hist_coverage',
                    className: 'premium-map-coverage'
                }).bindPopup(data.label + ' (Premium)');
            });

            // Function to update coverage polygon visibility based on zoom
            window.updatePremiumMapCoverageVisibility = function() {
                var currentZoom = map.getZoom();
                Object.keys(premiumMapCoveragePolygons).forEach(function(mapKey) {
                    var polygon = premiumMapCoveragePolygons[mapKey];
                    var layerVar = premiumMapCoverageBounds[mapKey].layerVar;
                    var sourceLayer = window[layerVar];
                    // The coverage rectangle is only shown while the sublayer is
                    // turned on AND the current zoom is outside the range at which
                    // the layer's real tiles exist. Most premium maps have minZoom 8
                    // (default); the CORONA 60's layer fetches pass mosaics from z8
                    // and frames from z12 (like the original atlas), so its rectangle
                    // hides at 8 (coverageMinZoom: 8). Layers backed by ArcGIS tiled
                    // services also declare coverageMaxZoom (their maxLOD): above it
                    // the rectangle reappears to mark the available-range limit.
                    var tilesBeginZoom = premiumMapCoverageBounds[mapKey].coverageMinZoom || 8;
                    var tilesEndZoom = premiumMapCoverageBounds[mapKey].coverageMaxZoom;
                    var outsideRange = currentZoom < tilesBeginZoom ||
                        (tilesEndZoom !== undefined && currentZoom > tilesEndZoom);
                    var shouldShow = outsideRange && !!sourceLayer && map.hasLayer(sourceLayer);
                    if (shouldShow) {
                        if (!map.hasLayer(polygon)) {
                            polygon.addTo(map);
                        }
                    } else {
                        if (map.hasLayer(polygon)) {
                            map.removeLayer(polygon);
                        }
                    }
                });
            };

            // Listen for zoom changes
            map.on('zoomend', window.updatePremiumMapCoverageVisibility);
            // The WMS health guard (js/wms-health.js) can remove a CENAGIS
            // layer on its own when the provider's server stops answering with
            // images; keep the “coverage” rectangles in sync with the real map
            // state instead of waiting for the next zoom. Only removals of the
            // premium layers themselves trigger a refresh, so the polygons the
            // refresh adds/removes cannot re-enter this handler.
            map.on('layerremove', function (e) {
                var isPremiumLayer = Object.keys(premiumMapCoverageBounds).some(function (key) {
                    var layerVar = premiumMapCoverageBounds[key].layerVar;
                    return layerVar && window[layerVar] === e.layer;
                });
                if (isPremiumLayer) window.updatePremiumMapCoverageVisibility();
            });
            window.updatePremiumMapCoverageVisibility();

            // ── LAYER VISIBILITY HIGHLIGHT ──
            // Partial intersection with coverage highlights each leaf row and
            // only the expand arrow of its group, in desktop and standalone PWA.
            // Both modes use the same rows inside #transpPanel (not the bottom bar).
            // Resolve rows on every check: auth/layer UI may not be ready yet.
            (function() {
                function _isEuropeMarket() {
                    try {
                        if (typeof window !== 'undefined' && window.DetectLabSite && typeof window.DetectLabSite.isEurope === 'boolean') {
                            return window.DetectLabSite.isEurope;
                        }
                        if (typeof window !== 'undefined' && window.location && window.location.hostname) {
                            return window.location.hostname.toLowerCase().indexOf('detectlab.eu') !== -1;
                        }
                    } catch (e) {}
                    return false;
                }

                // Helper: get direct child div of container that contains a given element
                function getDirectChildRowByElement(el, containerId) {
                    if (!el) return null;
                    var container = document.getElementById(containerId);
                    if (!container) return null;
                    var cur = el;
                    // Walk up until parent is container
                    while (cur && cur.parentElement) {
                        if (cur.parentElement === container) {
                            return cur;
                        }
                        if (cur.parentElement.id === containerId) {
                            return cur;
                        }
                        cur = cur.parentElement;
                        if (!cur || cur === container) break;
                    }
                    return null;
                }

                // Approximate bounds for LIDAR counties (coverage highlight only)
                var LIDAR_COUNTY_BOUNDS = {
                    hd: [[45.20, 22.00], [46.20, 23.30]],
                    ar: [[45.80, 20.70], [46.80, 22.50]],
                    ab: [[45.70, 23.00], [46.60, 24.00]],
                    bh: [[46.40, 21.30], [47.50, 22.80]],
                    cs: [[44.60, 21.30], [45.70, 22.60]],
                    ro2m: [[43.5, 19.5], [48.5, 30.5]],
                    ro1m: [[43.5, 19.5], [48.5, 30.5]],
                    cs917: [[44.70, 21.50], [45.60, 22.80]],
                    dj917: [[43.90, 23.00], [44.80, 24.50]],
                    gj917: [[44.60, 22.70], [45.50, 24.00]],
                    mh917: [[44.30, 22.20], [45.00, 23.20]]
                };

                // The country rows are filtered by the selected-country view,
                // but deliberately do not participate in the older green
                // coverage-highlight count used for the Romania catalogue.
                // This keeps the original panel's visual semantics stable while
                // adding the international free services.
                var INTERNATIONAL_LIDAR_BOUNDS = {
                    nlAhn: [[50.70, 3.20], [53.60, 7.30]],
                    noLidar: [[57.90, 4.00], [71.30, 31.50]],
                    plLidar: [[49.00, 14.00], [54.90, 24.20]],
                    // España: the extent the Mapa LiDAR WMS declares in its
                    // capabilities (−19 27 → 5 44) — peninsula, Balearics and
                    // Canaries, with the surrounding sea margin.
                    esLidar: [[27, -19], [44, 5]],
                    chLidar: [[45.398181, 5.140242], [48.230651, 11.47757]],
                    ukLidar: [[49.850605, -7.104776], [55.877087, 2.084282]],
                    frLidar: [[41.30, -5.50], [51.20, 9.70]],
                    dkLidar: [[54.4265, 7.99125], [57.7781, 15.5995]],
                    // Sweden proper. The service's own capabilities box
                    // (6.31918 53.90617 → 29.28575 72.0992) spills into the
                    // Baltic, Norway and Finland where there is no data.
                    seLidar: [[55.20, 10.80], [69.20, 24.30]]
                };

                // ── Country attribution for the country-scoped layer window ──
                // A row belongs to the selected country ONLY when the layer is
                // attributed to it here (or the row is a pan-European catalogue
                // declared by its extent). Neighbouring countries' rows must
                // not leak into the window just because their published
                // rectangle grazes the country's bbox or the locked viewport:
                // with Denmark selected, Sweden's / Poland's national LiDAR
                // boxes touch the Danish bbox but carry ZERO data for Denmark.
                // Keys are layerDef keys (below).
                var LAYER_COUNTRIES = {
                    // National LiDAR / elevation services — strictly their own country.
                    lidar_nlAhn: ['NL'],
                    lidar_noLidar: ['NO'],
                    lidar_plLidar: ['PL'],
                    lidar_esLidar: ['ES'],
                    lidar_chLidar: ['CH'],
                    lidar_ukLidar: ['GB', 'UK'],
                    lidar_frLidar: ['FR'],
                    lidar_dkLidar: ['DK'],
                    lidar_seLidar: ['SE'],
                    // Romanian national catalogue (county LiDAR keys are added
                    // below — all of them are Romanian counties/national grids).
                    apm: ['RO'], apm20: ['RO'], sat: ['RO'], osmPlaces: ['RO'],
                    uat: ['RO'], patrimoniu: ['RO'], babel: ['RO'], battles: ['RO'],
                    iosfree: ['RO'], austrianMap: ['RO'], firingPlans: ['RO'],
                    sovietMap: ['RO'], lidarScanner: ['RO'], archeoPotential: ['RO'],
                    archReport: ['RO'],
                    // Amprenta Vegetației publishes Romanian coverage only
                    // (see VEGETATION_FINGERPRINT.md / the .eu market note).
                    vegfp_ppi: ['RO'], vegfp_smx: ['RO'], vegfp_sgu: ['RO'],
                    vegfp_sgd: ['RO'],
                    // Premium sheets — the modern countries whose territory the
                    // sheet genuinely shows (home region first).
                    premium_josephine: ['RO'],
                    premium_bucovina: ['RO', 'UA'],
                    premium_austrohu: ['RO', 'MD', 'UA'],
                    premium_moldova1868: ['RO', 'MD'],
                    premium_moldova1771: ['RO', 'MD'],
                    premium_moldovawwii: ['RO', 'MD'],
                    premium_polishtactical1933: ['RO', 'MD', 'UA'],
                    premium_ww1: ['RO', 'MD', 'UA', 'BG', 'HU', 'RS'],
                    premium_ww2: ['RO', 'MD', 'UA', 'BG', 'HU', 'RS'],
                    premium_banat: ['RO', 'HU', 'RS'],
                    premium_transylvania1859: ['RO']
                };
                Object.keys(LIDAR_COUNTY_BOUNDS).forEach(function (k) {
                    LAYER_COUNTRIES['lidar_' + k] = ['RO'];
                });

                // The premium rows below host the CENAGIS sheets that are
                // de-duplicated out of the dynamic catalog
                // (js/historical-eu-maps.js SHARED_PREMIUM_MAP_KEYS). Their
                // country coverage is the catalog's curated data — COUNTRIES
                // _DATA in that module (pct > 0 = the sheet really covers part
                // of that country's territory). MIRROR kept in sync there; a
                // drift check lives in test-historical-eu-maps.js.
                var SHARED_PREMIUM_CATALOG_KEYS = {
                    premium_mitteleuropa: 'ukvme',
                    premium_chrzanowski: 'chrzanowski',
                    premium_reymann: 'reymann',
                    premium_kdr100k: 'kdr',
                    premium_kdr_gb: 'kdr_gb',
                    premium_wig100k: 'wig100k',
                    premium_galicia1855: 'kummersberg'
                };
                var SHARED_PREMIUM_COUNTRIES = {
                    ukvme: ['PL', 'DE', 'UA', 'BY', 'LT', 'LV', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO', 'DK', 'EE'],
                    chrzanowski: ['PL', 'DE', 'UA', 'BY', 'LT', 'LV', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO', 'DK', 'EE'],
                    reymann: ['PL', 'DE', 'UA', 'BY', 'LT', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO', 'FR', 'BE', 'LU', 'NL', 'DK', 'CH'],
                    kdr: ['PL', 'DE', 'UA', 'BY', 'LT', 'CZ', 'SK', 'AT', 'HU', 'RU', 'RO', 'FR', 'BE', 'LU', 'NL', 'DK', 'CH'],
                    kdr_gb: ['PL', 'DE', 'UA', 'BY', 'LT', 'CZ', 'SK', 'AT', 'HU', 'RU', 'MD', 'RO'],
                    wig100k: ['PL', 'DE', 'UA', 'BY', 'LT', 'LV', 'CZ', 'SK', 'HU', 'RU', 'MD', 'RO'],
                    kummersberg: ['PL', 'UA']
                };
                // Countries covered by that curated analysis (COUNTRIES_DATA
                // entries; BE-LU is listed as BE + LU). For any other country
                // the curated lists are known-incomplete, so the shared sheets
                // fall back to their own extent.
                var CURATED_COVERAGE_COUNTRIES = {
                    PL: 1, DE: 1, UA: 1, BY: 1, LT: 1, LV: 1, CZ: 1, SK: 1,
                    AT: 1, HU: 1, RU: 1, MD: 1, RO: 1, FR: 1, BE: 1, LU: 1,
                    NL: 1, DK: 1, EE: 1, CH: 1
                };

                // Central config: each leaf layer with its bounds and row getter
                var layerDefs = [];
                var internationalLayerDefs = [];

                // Helper to create L.latLngBounds safely
                function toBounds(arr) {
                    try { return L.latLngBounds(arr); } catch(e) { return ROMANIA_BOUNDS; }
                }

                var APM_BOUNDS_LATLNG = (typeof APM_BOUNDS !== 'undefined' ? toBounds(APM_BOUNDS) : ROMANIA_BOUNDS);

                // Free top-level layers
                layerDefs.push({
                    key: 'apm',
                    bounds: APM_BOUNDS_LATLNG,
                    getRow: function() {
                        var el = document.getElementById('apmToggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'sat',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() {
                        var el = document.getElementById('satOpacitySlider');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'osmPlaces',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() {
                        var el = document.getElementById('osmPlacesToggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'uat',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() {
                        var el = document.getElementById('uatToggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'patrimoniu',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() {
                        var el = document.getElementById('patrimoniuToggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });

                // Free historical sublayers
                layerDefs.push({
                    key: 'iosfree',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('iosfreeRow'); },
                    group: 'hist'
                });
                layerDefs.push({
                    key: 'austrianMap',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('austrianMapRow'); },
                    group: 'hist'
                });
                layerDefs.push({
                    key: 'firingPlans',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('firingPlansRow'); },
                    group: 'hist'
                });
                layerDefs.push({
                    key: 'sovietMap',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('sovietMapRow'); },
                    group: 'hist'
                });

                // LIDAR sublayers
                Object.keys(LIDAR_COUNTY_BOUNDS).forEach(function(k) {
                    var sliderId = 'lidar' + k.charAt(0).toUpperCase() + k.slice(1) + 'OpacitySlider';
                    // Special case: ro2m, ro1m, cs917 etc have specific casing
                    // Map k to actual slider IDs used in HTML
                    var mapping = {
                        hd: 'lidarHdOpacitySlider',
                        ar: 'lidarArOpacitySlider',
                        ab: 'lidarAbOpacitySlider',
                        bh: 'lidarBhOpacitySlider',
                        cs: 'lidarCsOpacitySlider',
                        ro2m: 'lidarRo2mOpacitySlider',
                        ro1m: 'lidarRo1mOpacitySlider',
                        cs917: 'lidarCs917OpacitySlider',
                        dj917: 'lidarDj917OpacitySlider',
                        gj917: 'lidarGj917OpacitySlider',
                        mh917: 'lidarMh917OpacitySlider',
                        nlAhn: 'lidarNlAhnOpacitySlider',
                        noLidar: 'lidarNoLidarOpacitySlider',
                        plLidar: 'lidarPlLidarOpacitySlider',
                        esLidar: 'lidarEsLidarOpacitySlider',
                        chLidar: 'lidarChLidarOpacitySlider',
                        ukLidar: 'lidarUkLidarOpacitySlider',
                        frLidar: 'lidarFrLidarOpacitySlider',
                        dkLidar: 'lidarDkLidarOpacitySlider',
                        seLidar: 'lidarSeLidarOpacitySlider'
                    };
                    var realSliderId = mapping[k] || sliderId;
                    layerDefs.push({
                        key: 'lidar_' + k,
                        bounds: toBounds(LIDAR_COUNTY_BOUNDS[k]),
                        getRow: (function(sId) {
                            return function() {
                                var s = document.getElementById(sId);
                                if (!s) return null;
                                // The wrapper div is parentElement (slider's direct parent)
                                // But ensure we return the child of lidarSubLayers
                                var direct = getDirectChildRowByElement(s, 'lidarSubLayers');
                                return direct || s.parentElement;
                            };
                        })(realSliderId),
                        group: 'lidar'
                    });
                });

                // International free LiDAR rows use the selected-country
                // filtering, but not the Romania coverage highlight outlines.
                Object.keys(INTERNATIONAL_LIDAR_BOUNDS).forEach(function(k) {
                    var sliderId = 'lidar' + k.charAt(0).toUpperCase() + k.slice(1) + 'OpacitySlider';
                    var realSliderId = {
                        nlAhn: 'lidarNlAhnOpacitySlider', noLidar: 'lidarNoLidarOpacitySlider',
                        plLidar: 'lidarPlLidarOpacitySlider', esLidar: 'lidarEsLidarOpacitySlider',
                        chLidar: 'lidarChLidarOpacitySlider', ukLidar: 'lidarUkLidarOpacitySlider',
                        frLidar: 'lidarFrLidarOpacitySlider', dkLidar: 'lidarDkLidarOpacitySlider',
                        seLidar: 'lidarSeLidarOpacitySlider'
                    }[k] || sliderId;
                    internationalLayerDefs.push({
                        key: 'lidar_' + k,
                        bounds: toBounds(INTERNATIONAL_LIDAR_BOUNDS[k]),
                        getRow: (function(sId) {
                            return function() {
                                var s = document.getElementById(sId);
                                if (!s) return null;
                                return getDirectChildRowByElement(s, 'lidarEuropeanSubLayers') || s.parentElement;
                            };
                        })(realSliderId),
                        group: null
                    });
                });

                // Premium top-level leaf layers
                layerDefs.push({
                    key: 'babel',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('babelScroll'); },
                    group: null
                });
                layerDefs.push({
                    key: 'apm20',
                    bounds: APM_BOUNDS_LATLNG,
                    getRow: function() {
                        var el = document.getElementById('apm20Toggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'battles',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() {
                        var el = document.getElementById('battlesToggle');
                        return el ? el.closest('.transp-layer-row') : null;
                    },
                    group: null
                });
                layerDefs.push({
                    key: 'satellite60s',
                    bounds: toBounds(premiumMapCoverageBounds.satellite60s ? premiumMapCoverageBounds.satellite60s.bounds : [[34.0,15.0],[58.0,38.0]]),
                    getRow: function() { return document.getElementById('satellite60sRow'); },
                    group: null
                });
                layerDefs.push({
                    key: 'lidarScanner',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('lidarScannerRow'); },
                    group: null
                });
                layerDefs.push({
                    key: 'archeoPotential',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('archeoPotentialRow'); },
                    group: null
                });
                layerDefs.push({
                    key: 'archReport',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('archReportRow'); },
                    group: null
                });

                // Premium historical sublayers (use precise bounds from premiumMapCoverageBounds)
                var premiumKeys = [
                    { key: 'josephine', toggle: 'josephineToggle', row: 'josephineRow' },
                    { key: 'bucovina', toggle: 'bucovinaMapToggle', row: 'bucovinaRow' },
                    { key: 'austrohu', toggle: 'austrohuMapToggle', row: 'austrohuRow' },
                    { key: 'moldova1868', toggle: 'moldova1868MapToggle', row: 'moldova1868Row' },
                    { key: 'moldovawwii', toggle: 'moldovaWwiiMapToggle', row: 'moldovaWwiiRow' },
                    { key: 'polishtactical1933', toggle: 'polishTactical1933MapToggle', row: 'polishTactical1933Row' },
                    { key: 'ww1', toggle: 'ww1MapToggle', row: 'ww1Row' },
                    { key: 'ww2', toggle: 'ww2MapToggle', row: 'ww2Row' },
                    { key: 'moldova1771', toggle: 'moldova1771MapToggle', row: 'moldova1771Row' },
                    { key: 'banat', toggle: 'banatMapToggle', row: 'banatRow' },
                    { key: 'transylvania1859', toggle: 'transylvania1859MapToggle', row: 'transylvania1859Row' },
                    { key: 'mitteleuropa', toggle: 'mitteleuropaMapToggle', row: 'mitteleuropaRow' },
                    { key: 'chrzanowski', toggle: 'chrzanowskiMapToggle', row: 'chrzanowskiRow' },
                    { key: 'reymann', toggle: 'reymannMapToggle', row: 'reymannRow' },
                    { key: 'kdr100k', toggle: 'kdr100kMapToggle', row: 'kdr100kRow' },
                    { key: 'kdr_gb', toggle: 'kdrGbMapToggle', row: 'kdrGbRow' },
                    { key: 'wig100k', toggle: 'wig100kMapToggle', row: 'wig100kRow' },
                    { key: 'galicia1855', toggle: 'galicia1855MapToggle', row: 'galicia1855Row' }
                ];
                premiumKeys.forEach(function(item) {
                    var b = premiumMapCoverageBounds[item.key] ? premiumMapCoverageBounds[item.key].bounds : [[43.5,19.5],[48.5,30.5]];
                    // moldova1771 doesn't have coverage entry, reuse moldova1868 bounds
                    if (item.key === 'moldova1771' && premiumMapCoverageBounds.moldova1868) {
                        b = premiumMapCoverageBounds.moldova1868.bounds;
                    }
                    layerDefs.push({
                        key: 'premium_' + item.key,
                        bounds: toBounds(b),
                        getRow: (function(rowId) {
                            return function() { return document.getElementById(rowId); };
                        })(item.row),
                        group: 'histPremium'
                    });
                });

                // Amprenta Vegetației (premium) — substraturile PPI, SMX,
                // SGU și SGD, cu acoperire pe România (.ro) sau toată Europa (.eu).
                layerDefs.push({
                    key: 'vegfp_ppi',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('vegfpPpiRow'); },
                    group: 'vegfp'
                });

                layerDefs.push({
                    key: 'vegfp_smx',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('vegfpSmxRow'); },
                    group: 'vegfp'
                });

                layerDefs.push({
                    key: 'vegfp_sgu',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('vegfpSguRow'); },
                    group: 'vegfp'
                });

                layerDefs.push({
                    key: 'vegfp_sgd',
                    bounds: ROMANIA_BOUNDS,
                    getRow: function() { return document.getElementById('vegfpSgdRow'); },
                    group: 'vegfp'
                });

                // The CENAGIS map catalog is rendered inside the single premium
                // Historical Maps accordion. This bounds-only entry contributes
                // to the accordion's viewport highlight; each individual map is
                // country-filtered by historical-eu-maps.js from its own extent.
                layerDefs.push({
                    key: 'premium_cenagis_catalog',
                    bounds: toBounds([[45.0, 5.0], [59.0, 39.0]]),
                    getRow: function() { return null; },
                    group: 'histPremium'
                });

                // Roman Empire sublayers (ROMANIA_BOUNDS on .ro, full Roman Empire bounds on .eu)
                var ROMAN_EMPIRE_BOUNDS = toBounds([[20.0, -15.0], [60.0, 50.0]]);
                var romanBoundsDef = _isEuropeMarket() ? ROMAN_EMPIRE_BOUNDS : ROMANIA_BOUNDS;
                var romanToggleIds = [
                    'roman_roads', 'roman_places',
                    'roman_dare_11','roman_dare_17','roman_dare_13','roman_dare_12','roman_dare_18','roman_dare_53',
                    'roman_dare_16','roman_dare_61','roman_dare_66','roman_dare_32','roman_dare_63','roman_dare_21',
                    'roman_dare_24','roman_dare_14','roman_dare_57','roman_dare_49','roman_dare_51','roman_dare_55',
                    'roman_dare_52','roman_dare_64','roman_walls','roman_regional_names',
                    'roman_shade_117','roman_shade_60bce','roman_shade_200','roman_shade_alexander',
                    'roman_shade_persian','roman_shade_diocletian','roman_shade_herod','roman_shade_hasmonean'
                ];
                romanToggleIds.forEach(function(tid) {
                    layerDefs.push({
                        key: 'roman_' + tid,
                        bounds: romanBoundsDef,
                        getRow: (function(toggleId) {
                            return function() {
                                var el = document.getElementById(toggleId);
                                if (!el) return null;
                                var direct = getDirectChildRowByElement(el, 'romanSubLayers');
                                return direct || (el.parentElement ? el.parentElement.parentElement : null);
                            };
                        })(tid),
                        group: 'roman'
                    });
                });

                // Group definitions: expand icon + sublayer keys
                var groups = {
                    hist: { expandIconId: 'histExpandIcon', sublayerKeys: ['iosfree','austrianMap','firingPlans','sovietMap'] },
                    lidar: { expandIconId: 'lidarExpandIcon', sublayerKeys: Object.keys(LIDAR_COUNTY_BOUNDS).map(function(k){ return 'lidar_' + k; }) },
                    roman: { expandIconId: 'romanExpandIcon', sublayerKeys: romanToggleIds.map(function(tid){ return 'roman_' + tid; }) },
                    histPremium: { expandIconId: 'histPremiumExpandIcon', sublayerKeys: premiumKeys.map(function(it){ return 'premium_' + it.key; }) },
                    vegfp: { expandIconId: 'vegfpExpandIcon', sublayerKeys: ['vegfp_ppi', 'vegfp_smx', 'vegfp_sgu', 'vegfp_sgd'] }
                };

                function isIntersecting(mapBounds, layerBounds) {
                    try {
                        if (!mapBounds || !layerBounds) return false;
                        // L.latLngBounds.intersects handles partial overlap
                        return mapBounds.intersects(layerBounds);
                    } catch(e) {
                        return false;
                    }
                }

                var visibilityMap = null;
                function bindVisibilityMap(activeMap) {
                    if (visibilityMap === activeMap) return;
                    if (visibilityMap && typeof visibilityMap.off === 'function') {
                        visibilityMap.off('moveend zoomend resize', window.checkLayerVisibility);
                    }
                    visibilityMap = activeMap;
                    if (activeMap && typeof activeMap.on === 'function') {
                        activeMap.on('moveend zoomend resize', window.checkLayerVisibility);
                    }
                }

                window.checkLayerVisibility = function() {
                    var activeMap = window._dlMap || map || window.map;
                    // Keep event listeners on the same instance whose bounds we read,
                    // including when a restored PWA exposes a replacement _dlMap.
                    bindVisibilityMap(activeMap);
                    if (!activeMap || typeof activeMap.getBounds !== 'function') return;
                    var mapBounds;
                    try { mapBounds = activeMap.getBounds(); } catch(e) { return; }
                    if (!mapBounds) return;

                    var groupVisible = { hist: false, lidar: false, roman: false, histPremium: false, vegfp: false };
                    layerDefs.forEach(function(def) {
                        var visible = isIntersecting(mapBounds, def.bounds);
                        if (def.group && visible) groupVisible[def.group] = true;

                        // Do not gate on panel.open, offsetParent or toggle.checked:
                        // collapsed/hidden rows must already be correct when revealed.
                        var rowEl = null;
                        try { rowEl = def.getRow(); } catch(e) { rowEl = null; }
                        if (rowEl) rowEl.classList.toggle('layer-visible-highlight', visible);
                    });

                    // Only arrows go green. Clear any stale group-row highlight even
                    // when outside coverage or while its sublayer DOM is unavailable.
                    Object.keys(groups).forEach(function(gKey) {
                        var icon = document.getElementById(groups[gKey].expandIconId);
                        if (!icon) return;
                        icon.classList.toggle('layer-group-arrow-highlight', groupVisible[gKey]);
                        var groupRow = icon.closest ? icon.closest('.transp-layer-row') : null;
                        if (groupRow) groupRow.classList.remove('layer-visible-highlight');
                    });
                };

                // Is a layer row nested inside a group row (LiDAR, historical,
                // Roman, premium, vegetation)? DOM containment first, with a
                // parent-chain walk as fallback for minimal DOM stubs.
                function rowInsideGroupRow(row, groupRow) {
                    if (!row || !groupRow) return false;
                    if (row === groupRow) return true;
                    if (typeof groupRow.contains === 'function') {
                        try { return groupRow.contains(row); } catch (e) { return false; }
                    }
                    var p = row.parentElement || row.parentNode || null;
                    while (p) {
                        if (p === groupRow) return true;
                        p = p.parentElement || p.parentNode || null;
                    }
                    return false;
                }

                function getGroupRow(gKey) {
                    var icon = document.getElementById(groups[gKey].expandIconId);
                    if (!icon) return null;
                    return icon.closest ? icon.closest('.transp-layer-row') : null;
                }

                // Bounds edge helpers that accept both Leaflet LatLngBounds
                // (getWest() …) and the plain {west, south, east, north}
                // objects used by the test doubles.
                function boundsEdge(b, name) {
                    if (!b) return NaN;
                    var fn = 'get' + name.charAt(0).toUpperCase() + name.slice(1);
                    if (typeof b[fn] === 'function') return Number(b[fn]());
                    return Number(b[name]);
                }
                function boundsAreaOf(b) {
                    var w = boundsEdge(b, 'east') - boundsEdge(b, 'west');
                    var h = boundsEdge(b, 'north') - boundsEdge(b, 'south');
                    return (w > 0 && h > 0) ? w * h : 0;
                }
                function boundsOverlapArea(a, b) {
                    var w = Math.min(boundsEdge(a, 'east'), boundsEdge(b, 'east')) -
                        Math.max(boundsEdge(a, 'west'), boundsEdge(b, 'west'));
                    var h = Math.min(boundsEdge(a, 'north'), boundsEdge(b, 'north')) -
                        Math.max(boundsEdge(a, 'south'), boundsEdge(b, 'south'));
                    return (w > 0 && h > 0) ? w * h : 0;
                }
                // Rectangle intersection alone lets neighbouring countries'
                // catalogues leak in where published boxes merely graze each
                // other (France's MNT box touches Italy's bbox in the Alps,
                // Sweden's LiDAR box clips Denmark's bbox at Bornholm). When a
                // row has no curated country list, demand a *substantial*
                // overlap: at least 5% of the country's box OR at least 5% of
                // the layer's box.
                function coversSubstantially(countryB, layerB) {
                    var o = boundsOverlapArea(countryB, layerB);
                    if (!(o > 0)) return false;
                    return o >= 0.05 * boundsAreaOf(countryB) || o >= 0.05 * boundsAreaOf(layerB);
                }
                function isoInList(list, code) {
                    for (var i = 0; i < list.length; i++) {
                        var c = list[i];
                        if (c === code) return true;
                        if (c === 'BE-LU' && (code === 'BE' || code === 'LU')) return true;
                        if ((c === 'GB' || c === 'UK') && (code === 'GB' || code === 'UK')) return true;
                    }
                    return false;
                }
                function curatedCountriesFor(def) {
                    if (LAYER_COUNTRIES[def.key]) return LAYER_COUNTRIES[def.key];
                    var catalogKey = SHARED_PREMIUM_CATALOG_KEYS[def.key];
                    return catalogKey ? (SHARED_PREMIUM_COUNTRIES[catalogKey] || null) : null;
                }

                // After country selection the layer window offers ONLY the
                // layers that are aferente the selected country: rows of
                // neighbouring countries that merely graze the country's bbox
                // or sit in the locked viewport get .country-layer-unavailable
                // and are hidden while #transpPanel keeps
                // .country-filter-active (e.g. Italy → no Denmark LiDAR and no
                // France/Switzerland LiDAR rows; Denmark → no Sweden/Poland
                // rows). Rows attributed to the country (LAYER_COUNTRIES /
                // SHARED_PREMIUM_COUNTRIES) stay; rows without any country
                // attribution (pan-European catalogues like CORONA and the
                // Roman Empire, live/API layers without a bounds record) keep
                // the coverage rule.
                window.filterLayersForCountry = function (iso) {
                    iso = String(iso || '').toUpperCase();
                    if (!iso) return;
                    var countryBounds = null;
                    var countryLayer = window._detectlabCountryLayer;
                    if (countryLayer && countryLayer.eachLayer) countryLayer.eachLayer(function (featureLayer) {
                        var p = featureLayer.feature && featureLayer.feature.properties || {};
                        var c = String(p.ISO_A2 || p.iso_a2 || p.ISO2 || p.iso2 || p.ISO_A3 || '').toUpperCase();
                        if (c === iso && featureLayer.getBounds) countryBounds = featureLayer.getBounds();
                    });
                    // Fallback: the selected-country bbox received from the ArcGIS atlas.
                    if (!countryBounds && Array.isArray(window._detectlabCountryBounds) &&
                        window._detectlabCountryBounds.length === 4) {
                        try {
                            var b = window._detectlabCountryBounds;
                            countryBounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
                        } catch (e) {}
                    }

                    var allDefs = layerDefs.concat(internationalLayerDefs);
                    allDefs.forEach(function (def) {
                        var row = null;
                        try { row = def.getRow(); } catch (e) {}
                        if (!row) return;
                        var available = true;
                        // ASIG exposes globally selectable rows in the app's
                        // existing sections. The WMS request bbox is clipped
                        // to Albania; selection of another country must not hide
                        // those rows.
                        if (!def.countryIndependent) {
                            var list = curatedCountriesFor(def);
                            if (list) {
                                available = isoInList(list, iso);
                                if (!available && SHARED_PREMIUM_CATALOG_KEYS[def.key] &&
                                    !CURATED_COVERAGE_COUNTRIES[iso] && def.bounds && countryBounds) {
                                    available = coversSubstantially(countryBounds, def.bounds);
                                }
                            } else if (countryBounds && def.bounds) {
                                available = coversSubstantially(countryBounds, def.bounds);
                            }
                        }
                        // Rows without a bounds record AND without country
                        // attribution are left untouched (live/API layers that
                        // do not publish coverage yet).
                        row.classList.toggle('country-layer-unavailable', !available);
                        row.setAttribute('aria-hidden', available ? 'false' : 'true');
                    });

                    // The Danish rows (js/danish-layers.js) are generated from
                    // js/danish-layers.config.js, so they are not in `layerDefs`
                    // above; the module applies the same country rule to its own
                    // group row and sub-rows.
                    var danishLayers = window.DetectLabDanishLayers;
                    if (danishLayers && typeof danishLayers.filterForCountry === 'function') {
                        try { danishLayers.filterForCountry(iso); } catch (e) {}
                    }

                    // Albania ASIG registry definitions mark their rows
                    // countryIndependent; do not apply the legacy group filter.

                    // The Finnish rows (js/finland-layers.js) are generated from
                    // js/finland-layers.config.js, so they are not in `layerDefs`
                    // above; the module applies the same country rule to its own
                    // group row and sub-rows.
                    var finlandLayers = window.FinlandLayers;
                    if (finlandLayers && typeof finlandLayers.filterForCountry === 'function') {
                        try { finlandLayers.filterForCountry(iso); } catch (e) {}
                    }

                    var euCatalog = window.DetectLabEuMaps;
                    if (euCatalog && typeof euCatalog.filterForCountry === 'function') {
                        var countryExtent = null;
                        try {
                            var west = typeof countryBounds.getWest === 'function' ? countryBounds.getWest() : countryBounds.west;
                            var south = typeof countryBounds.getSouth === 'function' ? countryBounds.getSouth() : countryBounds.south;
                            var east = typeof countryBounds.getEast === 'function' ? countryBounds.getEast() : countryBounds.east;
                            var north = typeof countryBounds.getNorth === 'function' ? countryBounds.getNorth() : countryBounds.north;
                            if ([west, south, east, north].every(function (v) { return isFinite(Number(v)); })) {
                                countryExtent = [Number(west), Number(south), Number(east), Number(north)];
                            }
                        } catch (e) {}
                        euCatalog.filterForCountry(iso, countryExtent);
                    }

                    // A group row disappears too when none of its sublayers
                    // covers the selected country. The European (international)
                    // LiDAR rows carry no group key but live inside the LiDAR
                    // group row, so membership is decided by DOM containment.
                    Object.keys(groups).forEach(function (gKey) {
                        var groupRow = getGroupRow(gKey);
                        if (!groupRow) return;
                        var anyAvailable = false;
                        allDefs.forEach(function (def) {
                            if (anyAvailable) return;
                            var row = null;
                            try { row = def.getRow(); } catch (e) {}
                            if (!row || row.classList.contains('country-layer-unavailable')) return;
                            if (rowInsideGroupRow(row, groupRow)) anyAvailable = true;
                        });
                        if (!anyAvailable && gKey === 'histPremium' && window.DetectLabEuMaps &&
                            typeof window.DetectLabEuMaps.hasAvailableMaps === 'function') {
                            anyAvailable = window.DetectLabEuMaps.hasAvailableMaps();
                        }
                        groupRow.classList.toggle('country-layer-unavailable', !anyAvailable);
                        groupRow.setAttribute('aria-hidden', anyAvailable ? 'false' : 'true');
                    });

                    var panel = document.getElementById('transpPanel');
                    if (panel) panel.classList.add('country-filter-active');
                };

                // Leaving a country-scoped view restores the full catalogue.
                window.unfilterLayersForCountry = function () {
                    if (window.DetectLabEuMaps && typeof window.DetectLabEuMaps.filterForCountry === 'function') {
                        window.DetectLabEuMaps.filterForCountry(null, null);
                    }
                    if (window.DetectLabDanishLayers &&
                        typeof window.DetectLabDanishLayers.filterForCountry === 'function') {
                        try { window.DetectLabDanishLayers.filterForCountry(null); } catch (e) {}
                    }
                    if (window.FinlandLayers &&
                        typeof window.FinlandLayers.filterForCountry === 'function') {
                        try { window.FinlandLayers.filterForCountry(null); } catch (e) {}
                    }
                    layerDefs.concat(internationalLayerDefs).forEach(function (def) {
                        var row = null;
                        try { row = def.getRow(); } catch (e) {}
                        if (!row) return;
                        row.classList.remove('country-layer-unavailable');
                        row.setAttribute('aria-hidden', 'false');
                    });
                    Object.keys(groups).forEach(function (gKey) {
                        var groupRow = getGroupRow(gKey);
                        if (!groupRow) return;
                        groupRow.classList.remove('country-layer-unavailable');
                        groupRow.setAttribute('aria-hidden', 'false');
                    });
                    var panel = document.getElementById('transpPanel');
                    if (panel) panel.classList.remove('country-filter-active');
                };

                // Auth handlers and PWA controls can change layout after this listener
                // runs. Coalesce their checks into the next frame. The map's resize
                // event also re-checks after PWA invalidateSize() has updated its bounds.
                var visibilityFrame = null;
                function scheduleLayerVisibilityCheck() {
                    if (visibilityFrame !== null) return;
                    visibilityFrame = window.requestAnimationFrame(function() {
                        visibilityFrame = null;
                        window.checkLayerVisibility();
                    });
                }

                window.addEventListener('detectlab:authchange', scheduleLayerVisibilityCheck);
                window.addEventListener('resize', scheduleLayerVisibilityCheck);
                window.addEventListener('pageshow', scheduleLayerVisibilityCheck);
                document.addEventListener('visibilitychange', function() {
                    if (!document.hidden) scheduleLayerVisibilityCheck();
                });
                if (window.visualViewport) {
                    window.visualViewport.addEventListener('resize', scheduleLayerVisibilityCheck);
                }

                // togglePwa* functions are defined later in index.html. Listen on the
                // shared PWA containers instead of wrapping functions that do not
                // exist yet; click/change cover dropdowns, touch/keyboard actions
                // and detection. (Only getElementById is used here so the offline
                // unit test's minimal document mock keeps working.)
                var pwaStack = document.getElementById('pwa-br-stack');
                if (pwaStack) {
                    pwaStack.addEventListener('click', scheduleLayerVisibilityCheck);
                    pwaStack.addEventListener('change', scheduleLayerVisibilityCheck);
                }
                // The compass column holds the PWA Detect toggle (flipping it can
                // auto-enable layers). It is mounted asynchronously by
                // js/map-rotate.js, so its absence here is normal and harmless.
                var compassCol = document.getElementById('compassCol');
                if (compassCol) {
                    compassCol.addEventListener('click', scheduleLayerVisibilityCheck);
                }

                window.checkLayerVisibility();
                setTimeout(scheduleLayerVisibilityCheck, 600);

                // Catch late row creation and PWA resume even with the panel closed.
                // Desktop keeps the open-panel guard to avoid unnecessary polling.
                setInterval(function() {
                    var panel = document.getElementById('transpPanel');
                    var isPwa = document.body && document.body.classList.contains('is-pwa');
                    if (isPwa || (panel && panel.classList.contains('open'))) {
                        window.checkLayerVisibility();
                    }
                }, 2000);

            })();

            // ── BUCOVINA 1861-1864 (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Spre deosebire de Austrian/Soviet (WMS, geo-spatial.org),
            // sursa e raster XYZ pe R2, la fel ca Josephine Map + — vezi acolo (var _jLayer
            // mai sus în fișier) pentru pattern-ul original.
            (function () {
                map.createPane('pane_bucovina');
                map.getPane('pane_bucovina').style.zIndex = 641;
                map.getPane('pane_bucovina').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.BUCOVINA_TILE_MAX_NATIVE_Z.
                // Nivelul nativ real nu a fost încă verificat empiric (vezi lecția de azi cu
                // UAT_TILE_Z: presupunerile despre nivelul nativ pot fi greșite) — dacă tile-
                // urile lipsesc la un anumit zoom, testați alte valori aici înainte de a
                // presupune că sursa nu are acoperire acolo.
                window.BUCOVINA_TILE_MAX_NATIVE_Z = (window.BUCOVINA_TILE_MAX_NATIVE_Z !== undefined) ? window.BUCOVINA_TILE_MAX_NATIVE_Z : 15;

                window._bucovinaMapLayer = L.tileLayer(DL.url2d('premium.bucovina'), DL.tile2dOptions('premium.bucovina', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.BUCOVINA_TILE_MAX_NATIVE_Z,
                    pane: 'pane_bucovina'
                }));

                window.toggleBucovinaMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._bucovinaMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._bucovinaMapLayer) && map.removeLayer(window._bucovinaMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setBucovinaMapOpacity = function (val) {
                    document.getElementById('bucovinaMapPct').textContent = val + '%';
                    window._bucovinaMapLayer.setOpacity(val / 100);
                };
            })();

            // ── HARTA AUSTRO-UNGARĂ 1861-1864 (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca Bucovina 1861-1864 (mai sus),
            // dar sursa e subfolderul 1869-1912 din același bucket R2.
            (function () {
                map.createPane('pane_austrohu');
                map.getPane('pane_austrohu').style.zIndex = 642;
                map.getPane('pane_austrohu').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.AUSTROHU_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z13 (ex. 13/4592/2840.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.AUSTROHU_TILE_MAX_NATIVE_Z = (window.AUSTROHU_TILE_MAX_NATIVE_Z !== undefined) ? window.AUSTROHU_TILE_MAX_NATIVE_Z : 13;

                window._austrohuMapLayer = L.tileLayer(DL.url2d('premium.austro-hungarian'), DL.tile2dOptions('premium.austro-hungarian', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.AUSTROHU_TILE_MAX_NATIVE_Z,
                    pane: 'pane_austrohu'
                }));

                window.toggleAustrohuMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._austrohuMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._austrohuMapLayer) && map.removeLayer(window._austrohuMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setAustrohuMapOpacity = function (val) {
                    document.getElementById('austrohuMapPct').textContent = val + '%';
                    window._austrohuMapLayer.setOpacity(val / 100);
                };
            })();

            // ── MOLDOVA 1868 (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca Bucovina 1861-1864 / Harta Austro-Ungară
            // de mai sus, subfolderul fiind moldova-1868 din același bucket R2.
            (function () {
                map.createPane('pane_moldova1868');
                map.getPane('pane_moldova1868').style.zIndex = 643;
                map.getPane('pane_moldova1868').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.MOLDOVA1868_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z13 (ex. 13/4694/2838.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.MOLDOVA1868_TILE_MAX_NATIVE_Z = (window.MOLDOVA1868_TILE_MAX_NATIVE_Z !== undefined) ? window.MOLDOVA1868_TILE_MAX_NATIVE_Z : 13;

                window._moldova1868MapLayer = L.tileLayer(DL.url2d('premium.moldova-1868'), DL.tile2dOptions('premium.moldova-1868', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.MOLDOVA1868_TILE_MAX_NATIVE_Z,
                    pane: 'pane_moldova1868'
                }));

                window.toggleMoldova1868Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._moldova1868MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._moldova1868MapLayer) && map.removeLayer(window._moldova1868MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setMoldova1868MapOpacity = function (val) {
                    document.getElementById('moldova1868MapPct').textContent = val + '%';
                    window._moldova1868MapLayer.setOpacity(val / 100);
                };
            })();


            // ── MOLDOVA 1771 (3 stitched sheets from Národní knihovna České republiky) ──
            (function () {
                map.createPane('pane_moldova1771');
                map.getPane('pane_moldova1771').style.zIndex = 650;
                map.getPane('pane_moldova1771').style.pointerEvents = 'none';

                window.MOLDOVA1771_TILE_MAX_NATIVE_Z = (window.MOLDOVA1771_TILE_MAX_NATIVE_Z !== undefined) ? window.MOLDOVA1771_TILE_MAX_NATIVE_Z : 15;

                window._moldova1771MapLayer = L.tileLayer(DL.url2d('premium.moldova-1771'), DL.tile2dOptions('premium.moldova-1771', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.MOLDOVA1771_TILE_MAX_NATIVE_Z,
                    pane: 'pane_moldova1771'
                }));

                window.toggleMoldova1771Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._moldova1771MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._moldova1771MapLayer) && map.removeLayer(window._moldova1771MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setMoldova1771MapOpacity = function (val) {
                    document.getElementById('moldova1771MapPct').textContent = val + '%';
                    window._moldova1771MapLayer.setOpacity(val / 100);
                };
            })();

            // ── MOLDOVA WWII (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca celelalte hărți istorice de mai sus,
            // subfolderul fiind moldova-wwii din același bucket R2.
            (function () {
                map.createPane('pane_moldovawwii');
                map.getPane('pane_moldovawwii').style.zIndex = 644;
                map.getPane('pane_moldovawwii').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.MOLDOVAWWII_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z13 (ex. 13/4702/2848.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.MOLDOVAWWII_TILE_MAX_NATIVE_Z = (window.MOLDOVAWWII_TILE_MAX_NATIVE_Z !== undefined) ? window.MOLDOVAWWII_TILE_MAX_NATIVE_Z : 13;

                window._moldovaWwiiMapLayer = L.tileLayer(DL.url2d('premium.moldova-wwii'), DL.tile2dOptions('premium.moldova-wwii', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.MOLDOVAWWII_TILE_MAX_NATIVE_Z,
                    pane: 'pane_moldovawwii'
                }));

                window.toggleMoldovaWwiiMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._moldovaWwiiMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._moldovaWwiiMapLayer) && map.removeLayer(window._moldovaWwiiMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setMoldovaWwiiMapOpacity = function (val) {
                    document.getElementById('moldovaWwiiMapPct').textContent = val + '%';
                    window._moldovaWwiiMapLayer.setOpacity(val / 100);
                };
            })();

            // ── HARTA TACTICĂ POLONEZĂ 1933 (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca celelalte hărți istorice de mai sus,
            // subfolderul fiind ukraine_zapad_pl-1933 din același bucket R2.
            (function () {
                map.createPane('pane_polishtactical1933');
                map.getPane('pane_polishtactical1933').style.zIndex = 645;
                map.getPane('pane_polishtactical1933').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.POLISHTACTICAL1933_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z13 (ex. 13/4600/2840.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.POLISHTACTICAL1933_TILE_MAX_NATIVE_Z = (window.POLISHTACTICAL1933_TILE_MAX_NATIVE_Z !== undefined) ? window.POLISHTACTICAL1933_TILE_MAX_NATIVE_Z : 13;

                window._polishTactical1933MapLayer = L.tileLayer(DL.url2d('premium.polish-tactical-1933'), DL.tile2dOptions('premium.polish-tactical-1933', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.POLISHTACTICAL1933_TILE_MAX_NATIVE_Z,
                    pane: 'pane_polishtactical1933'
                }));

                window.togglePolishTactical1933Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._polishTactical1933MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._polishTactical1933MapLayer) && map.removeLayer(window._polishTactical1933MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setPolishTactical1933MapOpacity = function (val) {
                    document.getElementById('polishTactical1933MapPct').textContent = val + '%';
                    window._polishTactical1933MapLayer.setOpacity(val / 100);
                };
            })();

            // ── WWI (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca celelalte hărți istorice de mai sus,
            // subfolderul fiind ww1 din același bucket R2.
            (function () {
                map.createPane('pane_ww1');
                map.getPane('pane_ww1').style.zIndex = 646;
                map.getPane('pane_ww1').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.WW1_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z11 (ex. 11/1154/712.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.WW1_TILE_MAX_NATIVE_Z = (window.WW1_TILE_MAX_NATIVE_Z !== undefined) ? window.WW1_TILE_MAX_NATIVE_Z : 11;

                window._ww1MapLayer = L.tileLayer(DL.url2d('premium.ww1'), DL.tile2dOptions('premium.ww1', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.WW1_TILE_MAX_NATIVE_Z,
                    pane: 'pane_ww1'
                }));

                window.toggleWw1Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._ww1MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._ww1MapLayer) && map.removeLayer(window._ww1MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setWw1MapOpacity = function (val) {
                    document.getElementById('ww1MapPct').textContent = val + '%';
                    window._ww1MapLayer.setOpacity(val / 100);
                };
            })();

            // ── WWII (XYZ tiles, JPG, direct din Cloudflare R2) ──
            // Strat premium nou. Același pattern ca celelalte hărți istorice de mai sus,
            // subfolderul fiind ww2 din același bucket R2.
            (function () {
                map.createPane('pane_ww2');
                map.getPane('pane_ww2').style.zIndex = 647;
                map.getPane('pane_ww2').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.WW2_TILE_MAX_NATIVE_Z.
                // Confirmat empiric: tile-uri există cel puțin până la z10 (ex. 10/572/356.jpg).
                // Dacă apar și la zoom mai mare, crește valoarea aici.
                window.WW2_TILE_MAX_NATIVE_Z = (window.WW2_TILE_MAX_NATIVE_Z !== undefined) ? window.WW2_TILE_MAX_NATIVE_Z : 10;

                window._ww2MapLayer = L.tileLayer(DL.url2d('premium.ww2'), DL.tile2dOptions('premium.ww2', {
                    minZoom: 8, maxZoom: 20,
                    maxNativeZoom: window.WW2_TILE_MAX_NATIVE_Z,
                    pane: 'pane_ww2'
                }));

                window.toggleWw2Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._ww2MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._ww2MapLayer) && map.removeLayer(window._ww2MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setWw2MapOpacity = function (val) {
                    document.getElementById('ww2MapPct').textContent = val + '%';
                    window._ww2MapLayer.setOpacity(val / 100);
                };
            })();

            // ── BANAT 1769-1772 (XYZ tiles, PNG, direct din Supabase storage) ──
            // Strat premium nou. Același pattern ca celelalte hărți istorice de mai sus,
            // dar sursa e bucket-ul Supabase (Harti/Banat), nu Cloudflare R2.
            // Zoom-urile native sunt 11-15.
            (function () {
                map.createPane('pane_banat');
                map.getPane('pane_banat').style.zIndex = 649;
                map.getPane('pane_banat').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.BANAT_TILE_MAX_NATIVE_Z.
                // Zoom-urile disponibile sunt 11-15.
                window.BANAT_TILE_MAX_NATIVE_Z = (window.BANAT_TILE_MAX_NATIVE_Z !== undefined) ? window.BANAT_TILE_MAX_NATIVE_Z : 15;

                window._banatMapLayer = L.tileLayer(DL.url2d('premium.banat'), DL.tile2dOptions('premium.banat', {
                    minZoom: 11, maxZoom: 20,
                    maxNativeZoom: window.BANAT_TILE_MAX_NATIVE_Z,
                    pane: 'pane_banat'
                }));

                window.toggleBanatMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._banatMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._banatMapLayer) && map.removeLayer(window._banatMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setBanatMapOpacity = function (val) {
                    document.getElementById('banatMapPct').textContent = val + '%';
                    window._banatMapLayer.setOpacity(val / 100);
                };
            })();

            // ── HARTA TRANSILVANIEI 1859 (Tiled Map Service, ArcGIS Online) ──
            // Strat premium nou. Sursă: serviciu de tile-uri găzduit pe ArcGIS
            // Online (org. t2AVhHhEnEvHcPF6), public (share level Everyone).
            // Digitalizare și publicare: Universitatea „Ștefan cel Mare” din
            // Suceava — bukowina1856.eu (credit afișat în ⓘ layer info și în
            // attribution-ul Leaflet al stratului).
            // LOD-urile native ale serviciului sunt 7-14 (minLOD 7, maxLOD 14),
            // deci sub z7 și peste z14 dreptunghiul roșu de acoperire preia
            // locul tile-urilor (vezi coverageMinZoom / coverageMaxZoom în
            // premiumMapCoverageBounds).
            (function () {
                map.createPane('pane_transylvania1859');
                map.getPane('pane_transylvania1859').style.zIndex = 652;
                map.getPane('pane_transylvania1859').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z.
                window.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z = (window.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z !== undefined) ? window.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z : 14;

                // fullExtent-ul serviciului (Web Mercator -> WGS84): Transilvania.
                var TRANSYLVANIA1859_BOUNDS = L.latLngBounds([[45.2059, 22.2319], [47.7300, 26.7037]]);

                window._transylvania1859MapLayer = L.tileLayer(DL.url2d('premium.transylvania-1859'), DL.tile2dOptions('premium.transylvania-1859', {
                    minZoom: 7, maxZoom: 20,
                    maxNativeZoom: window.TRANSYLVANIA1859_TILE_MAX_NATIVE_Z,
                    bounds: TRANSYLVANIA1859_BOUNDS,
                    pane: 'pane_transylvania1859'
                }));

                window.toggleTransylvania1859Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._transylvania1859MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._transylvania1859MapLayer) && map.removeLayer(window._transylvania1859MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setTransylvania1859MapOpacity = function (val) {
                    document.getElementById('transylvania1859MapPct').textContent = val + '%';
                    window._transylvania1859MapLayer.setOpacity(val / 100);
                };
            })();

            // ── HARTĂ ADMINISTRATIVĂ A GALIȚIEI ȘI LODOMERIEI – 1855 (Tiled Map Service, ArcGIS Online) ──
            // Strat premium nou. Sursă: serviciu de tile-uri găzduit pe ArcGIS
            // Online (org. t2AVhHhEnEvHcPF6), public (share level Everyone).
            // Digitalizare și publicare: Universitatea „Ștefan cel Mare” din
            // Suceava — bukowina1856.eu (credit afișat în ⓘ layer info și în
            // attribution-ul Leaflet al stratului).
            // LOD-urile native ale serviciului sunt 6-14 (minLOD 6, maxLOD 14);
            // în afara intervalului, dreptunghiul roșu de acoperire e afișat.
            (function () {
                map.createPane('pane_galicia1855');
                map.getPane('pane_galicia1855').style.zIndex = 653;
                map.getPane('pane_galicia1855').style.pointerEvents = 'none';

                // Reglabil live din consolă, fără redeploy: window.GALICIA1855_TILE_MAX_NATIVE_Z.
                window.GALICIA1855_TILE_MAX_NATIVE_Z = (window.GALICIA1855_TILE_MAX_NATIVE_Z !== undefined) ? window.GALICIA1855_TILE_MAX_NATIVE_Z : 14;

                // fullExtent-ul serviciului (Web Mercator -> WGS84): Galiția și Lodomeria.
                var GALICIA1855_BOUNDS = L.latLngBounds([[46.8116, 18.3937], [50.8713, 26.6844]]);

                window._galicia1855MapLayer = L.tileLayer(DL.url2d('premium.galicia-1855'), DL.tile2dOptions('premium.galicia-1855', {
                    minZoom: 6, maxZoom: 20,
                    maxNativeZoom: window.GALICIA1855_TILE_MAX_NATIVE_Z,
                    bounds: GALICIA1855_BOUNDS,
                    pane: 'pane_galicia1855'
                }));

                window.toggleGalicia1855Map = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._galicia1855MapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._galicia1855MapLayer) && map.removeLayer(window._galicia1855MapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setGalicia1855MapOpacity = function (val) {
                    document.getElementById('galicia1855MapPct').textContent = val + '%';
                    window._galicia1855MapLayer.setOpacity(val / 100);
                };
            })();

            // ── CENAGIS / IH PAN HISTORICAL MAPS (Covering Romania) ──
            var CENAGIS_WMS_URL = 'https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms';

            // 1. Übersichtskarte von Mitteleuropa 1:300 000 (1893–1945)
            (function () {
                map.createPane('pane_mitteleuropa');
                map.getPane('pane_mitteleuropa').style.zIndex = 654;
                map.getPane('pane_mitteleuropa').style.pointerEvents = 'none';

                window._mitteleuropaMapLayer = L.tileLayer.wms(DL.url2d('premium.mitteleuropa'), DL.wms2dOptions('premium.mitteleuropa', {
                    pane: 'pane_mitteleuropa', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#mitteleuropaRow / #mitteleuropaMapToggle).
                window._mitteleuropaMapLayer._detectlabUiKeys = ['mitteleuropa'];

                window.toggleMitteleuropaMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._mitteleuropaMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._mitteleuropaMapLayer) && map.removeLayer(window._mitteleuropaMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setMitteleuropaMapOpacity = function (val) {
                    var el = document.getElementById('mitteleuropaMapPct');
                    if (el) el.textContent = val + '%';
                    window._mitteleuropaMapLayer.setOpacity(val / 100);
                };
            })();

            // 2. Harta Wojciech Chrzanowski (1859)
            (function () {
                map.createPane('pane_chrzanowski');
                map.getPane('pane_chrzanowski').style.zIndex = 655;
                map.getPane('pane_chrzanowski').style.pointerEvents = 'none';

                window._chrzanowskiMapLayer = L.tileLayer.wms(DL.url2d('premium.chrzanowski'), DL.wms2dOptions('premium.chrzanowski', {
                    pane: 'pane_chrzanowski', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#chrzanowskiRow / #chrzanowskiMapToggle).
                window._chrzanowskiMapLayer._detectlabUiKeys = ['chrzanowski'];

                window.toggleChrzanowskiMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._chrzanowskiMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._chrzanowskiMapLayer) && map.removeLayer(window._chrzanowskiMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setChrzanowskiMapOpacity = function (val) {
                    var el = document.getElementById('chrzanowskiMapPct');
                    if (el) el.textContent = val + '%';
                    window._chrzanowskiMapLayer.setOpacity(val / 100);
                };
            })();

            // 3. Harta Central-Europa – Reymann (1806–1908)
            (function () {
                map.createPane('pane_reymann');
                map.getPane('pane_reymann').style.zIndex = 656;
                map.getPane('pane_reymann').style.pointerEvents = 'none';

                window._reymannMapLayer = L.tileLayer.wms(DL.url2d('premium.reymann'), DL.wms2dOptions('premium.reymann', {
                    pane: 'pane_reymann', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#reymannRow / #reymannMapToggle).
                window._reymannMapLayer._detectlabUiKeys = ['reymann'];

                window.toggleReymannMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._reymannMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._reymannMapLayer) && map.removeLayer(window._reymannMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setReymannMapOpacity = function (val) {
                    var el = document.getElementById('reymannMapPct');
                    if (el) el.textContent = val + '%';
                    window._reymannMapLayer.setOpacity(val / 100);
                };
            })();

            // 4. Karte des Deutschen Reiches 1:100 000 (1878–1945)
            (function () {
                map.createPane('pane_kdr100k');
                map.getPane('pane_kdr100k').style.zIndex = 657;
                map.getPane('pane_kdr100k').style.pointerEvents = 'none';

                window._kdr100kMapLayer = L.tileLayer.wms(DL.url2d('premium.kdr-100k'), DL.wms2dOptions('premium.kdr-100k', {
                    pane: 'pane_kdr100k', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#kdr100kRow / #kdr100kMapToggle).
                window._kdr100kMapLayer._detectlabUiKeys = ['kdr100k'];

                window.toggleKdr100kMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._kdr100kMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._kdr100kMapLayer) && map.removeLayer(window._kdr100kMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setKdr100kMapOpacity = function (val) {
                    var el = document.getElementById('kdr100kMapPct');
                    if (el) el.textContent = val + '%';
                    window._kdr100kMapLayer.setOpacity(val / 100);
                };
            })();

            // 5. Karte des Deutschen Reiches – Großblatt 1:100 000 (1914–1944)
            (function () {
                map.createPane('pane_kdr_gb');
                map.getPane('pane_kdr_gb').style.zIndex = 658;
                map.getPane('pane_kdr_gb').style.pointerEvents = 'none';

                window._kdrGbMapLayer = L.tileLayer.wms(DL.url2d('premium.kdr-gb'), DL.wms2dOptions('premium.kdr-gb', {
                    pane: 'pane_kdr_gb', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#kdrGbRow / #kdrGbMapToggle).
                window._kdrGbMapLayer._detectlabUiKeys = ['kdrGb'];

                window.toggleKdrGbMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._kdrGbMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._kdrGbMapLayer) && map.removeLayer(window._kdrGbMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setKdrGbMapOpacity = function (val) {
                    var el = document.getElementById('kdrGbMapPct');
                    if (el) el.textContent = val + '%';
                    window._kdrGbMapLayer.setOpacity(val / 100);
                };
            })();

            // 6. WIG 1:100 000 – Harta tactică a Poloniei (1919–1939)
            (function () {
                map.createPane('pane_wig100k');
                map.getPane('pane_wig100k').style.zIndex = 659;
                map.getPane('pane_wig100k').style.pointerEvents = 'none';

                window._wig100kMapLayer = L.tileLayer.wms(DL.url2d('premium.wig-100k'), DL.wms2dOptions('premium.wig-100k', {
                    pane: 'pane_wig100k', maxZoom: 18
                }));
                // Keys the WMS health guard (js/wms-health.js) uses to find
                // this layer's row + switch (#wig100kRow / #wig100kMapToggle).
                window._wig100kMapLayer._detectlabUiKeys = ['wig100k'];

                window.toggleWig100kMap = function (on) {
                    if (on) {
                        var histPremToggle = document.getElementById('histPremiumToggle');
                        if (histPremToggle && !histPremToggle.checked) {
                            histPremToggle.checked = true;
                            window.toggleHistPremiumLayer(true);
                        }
                        window._wig100kMapLayer.addTo(map);
                    } else {
                        map.hasLayer(window._wig100kMapLayer) && map.removeLayer(window._wig100kMapLayer);
                    }
                    window.updatePremiumMapCoverageVisibility && window.updatePremiumMapCoverageVisibility();
                };

                window.setWig100kMapOpacity = function (val) {
                    var el = document.getElementById('wig100kMapPct');
                    if (el) el.textContent = val + '%';
                    window._wig100kMapLayer.setOpacity(val / 100);
                };
            })();

            // ── SATELIT 60s (CORONA) — the Corona Atlas logic, Europe-wide ──
            // Port of how https://corona.cast.uark.edu/atlas fetches its tiles
            // (read from the atlas's own source: assets/libraries/custom/
            // maputils.js → "CORONA RASTER MANAGER/FUNCTIONS"), applied to the
            // whole of Europe instead of a hand-written Romania list:
            //
            //   1. CATALOGUE — the atlas calls GET /corona/get_raster_names and
            //      receives every CORONA product the CAST GeoServer publishes:
            //      a pass mosaic per orbit ("1104-2155Fore") plus the individual
            //      frames inside it ("1104-2155df004"), each with its WGS84
            //      footprint polygon. DetectLab loads the same catalogue through
            //      js/corona-wms-layer.js (static snapshot → /api/corona/rasters
            //      proxy → built-in fallback; the CAST endpoint itself sends no
            //      CORS header and is ~6 MB of worldwide coverage).
            //   2. TILES — one ol.source.TileWMS per product against
            //      geoserve.cast.uark.edu/geoserver/gwc/service/wms, WMS 1.1.1
            //      GetMap, tiled=true, 256×256, SRS=EPSG:900913, a single
            //      LAYERS=corona:<product> per request, limited to the product's
            //      own footprint. window.createCoronaWmsLayer() emits exactly
            //      those URLs.
            //   3. ZOOM GATING — rasterSettings.layerSettings: pass mosaics live
            //      at z8–z11, individual frames at z12–z20.
            //   4. VISIBILITY — rasterLayer.checkZoom(), re-run on every moveend
            //      (corona.zoomChanged()): a product draws only while its
            //      POLYGON (not its bbox) intersects the view.
            //
            // The one deliberate difference is memory hygiene: the atlas builds
            // an OpenLayers layer for every product up front; here a Leaflet tile
            // layer is created when the product first enters the view and dropped
            // when it leaves, which keeps a Europe-wide catalogue affordable on a
            // phone. The requests that reach the server are identical.
            //
            // Coverage outlines (js/corona-coverage-layer.js) are shown together
            // with the layer so the empty space between passes reads as "no
            // imagery here", not as a broken layer.
            (function () {
                map.createPane("pane_sat60");
                map.getPane("pane_sat60").style.zIndex = 648;
                map.getPane("pane_sat60").style.pointerEvents = "none";

                var SAT60_OPACITY = 0.85;
                var Atlas = window.CoronaAtlas;

                var _sat60MapLayer = L.layerGroup([]);
                var _sat60Manager = null;
                var _sat60Opacity = SAT60_OPACITY;
                var _sat60On = false;
                var _sat60CatalogPromise = null;

                // Used by the premium coverage-rectangle system and by the tests.
                window._sat60MapLayer = _sat60MapLayer;
                window._sat60Layers = [];

                // ── Mobile safety: why this layer used to crash phones ──────
                // Several CORONA tile layers share one pane. On a phone (incl.
                // "Desktop site" / PWA, where Leaflet's own L.Browser.mobile
                // sniff is defeated by the spoofed user-agent) Leaflet's
                // defaults are the worst case for that stack:
                //   • updateWhenIdle  = L.Browser.mobile → false when the UA
                //     is spoofed, so EVERY pan frame re-runs _update() for
                //     every layer and queues new tiles while the finger moves;
                //   • updateWhenZooming = true → the same on every frame of a
                //     pinch/scroll zoom animation;
                //   • keepBuffer = 2 → each layer keeps a two-tile ring around
                //     the viewport.
                // The result is hundreds of in-flight requests and decoded
                // 256×256 PNGs within a second → mobile WebKit/Chromium kills
                // the tab (out of memory). Nothing below changes WHAT is
                // requested (same endpoint, same WMS-C URL, same products, same
                // zoom gating, same footprints) — only HOW OFTEN and HOW MANY
                // tiles are kept alive on constrained devices.
                var _sat60LowPowerCache = null;
                function _sat60IsLowPowerDevice() {
                    if (typeof window.SAT60_LOW_POWER_TILES === "boolean") {
                        return window.SAT60_LOW_POWER_TILES;
                    }
                    // Single source of truth with the global tile governor
                    // (js/tile-perf.js): same device class, same limits, applied
                    // here and to every other tile layer of the app.
                    if (window.DLTilePerf && typeof window.DLTilePerf.isLowPowerDevice === "function") {
                        return window.DLTilePerf.isLowPowerDevice();
                    }
                    if (_sat60LowPowerCache !== null) return _sat60LowPowerCache;
                    var lowPower = false;
                    try {
                        if (L.Browser && L.Browser.mobile) lowPower = true;
                        var coarse = !!(window.matchMedia &&
                            window.matchMedia("(pointer: coarse)").matches);
                        var touchPoints = (navigator.maxTouchPoints || 0) > 0 ||
                            ("ontouchstart" in window);
                        if (coarse && touchPoints) lowPower = true;
                        if (typeof navigator.deviceMemory === "number" &&
                            navigator.deviceMemory > 0 && navigator.deviceMemory <= 4) {
                            lowPower = true;
                        }
                    } catch (err) {
                        lowPower = false;
                    }
                    _sat60LowPowerCache = lowPower;
                    return lowPower;
                }

                function _sat60EnsureManager() {
                    if (_sat60Manager || !Atlas) return _sat60Manager;
                    var lowPower = _sat60IsLowPowerDevice();

                    _sat60Manager = Atlas.createManager(map, {
                        group: _sat60MapLayer,
                        pane: "pane_sat60",
                        opacity: _sat60Opacity,
                        // A product slightly off-screen still counts as visible,
                        // so a normal drag does not uncover an empty area before
                        // moveend fires.
                        viewportPad: lowPower ? 0.2 : 0.35,
                        // Safety caps: a dense Corona corridor can put dozens of
                        // frames in one view; beyond these the extra layers add
                        // memory, not imagery.
                        maxActivePasses: lowPower ? 8 : 18,
                        maxActiveFrames: lowPower ? 10 : 24,
                        tileLayerOptions: {
                            // Never queue tiles for the intermediate frames of a
                            // zoom animation: Leaflet then only re-transforms the
                            // levels it already has and loads the final zoom once,
                            // on zoomend.
                            updateWhenZooming: false,
                            // Same idea for panning: load after the gesture ends
                            // instead of on every move frame. Forced on regardless
                            // of the user-agent (Leaflet's default is the mobile
                            // sniff, which "Desktop site" mode defeats).
                            updateWhenIdle: true,
                            keepBuffer: lowPower ? 1 : 2
                        },
                        onChange: function (active) {
                            window._sat60Layers = _sat60Manager.getActiveLayers();
                            window._sat60ActiveProducts = active;
                        }
                    });

                    // The atlas re-runs checkZoom() on every moveend
                    // (corona.zoomChanged()) — never during the gesture.
                    map.on("moveend zoomend", function () {
                        if (_sat60On && _sat60Manager) _sat60Manager.update();
                    });
                    return _sat60Manager;
                }

                function _sat60LoadCatalog() {
                    if (_sat60CatalogPromise) return _sat60CatalogPromise;
                    if (!Atlas) return Promise.resolve(null);
                    _sat60CatalogPromise = Atlas.loadCatalog({ bbox: Atlas.EUROPE_BBOX })
                        .then(function (result) {
                            var manager = _sat60EnsureManager();
                            if (manager) {
                                manager.setCatalog(result.blocks);
                                window._sat60Catalog = result;
                                if (_sat60On) manager.update();
                            }
                            return result;
                        });
                    return _sat60CatalogPromise;
                }

                window.toggleSatellite60sMap = function (on) {
                    // Strat premium de sine stătător: switch-ul lui nu pornește
                    // grupul "Historical Maps" și nu e oprit de switch-ul mare
                    // al grupului — see HIST_PREMIUM_SUBLAYER_TOGGLES.
                    _sat60On = !!on;
                    if (on) {
                        _sat60EnsureManager();
                        if (!map.hasLayer(_sat60MapLayer)) {
                            _sat60MapLayer.addTo(map);
                        }
                        _sat60LoadCatalog();
                        if (_sat60Manager) _sat60Manager.update();
                        // Where does this layer actually have imagery? The
                        // outlines answer that before the user hunts for tiles.
                        if (window.CoronaCoverage && window.SAT60_COVERAGE_OUTLINES !== false) {
                            window.CoronaCoverage.show(map);
                            var outlinesToggle = document.getElementById("satellite60sCoverageToggle");
                            if (outlinesToggle) outlinesToggle.checked = true;
                        }
                    } else {
                        if (map.hasLayer(_sat60MapLayer)) {
                            map.removeLayer(_sat60MapLayer);
                        }
                        if (window.CoronaCoverage) window.CoronaCoverage.hide();
                        var offToggle = document.getElementById("satellite60sCoverageToggle");
                        if (offToggle) offToggle.checked = false;
                    }
                    if (typeof window.updatePremiumMapCoverageVisibility === "function") {
                        window.updatePremiumMapCoverageVisibility();
                    }
                };

                // Independent switch for the coverage outlines (the row under
                // the layer's opacity slider).
                window.toggleSatellite60sCoverage = function (on) {
                    window.SAT60_COVERAGE_OUTLINES = !!on;
                    if (!window.CoronaCoverage) return;
                    if (on) {
                        window.CoronaCoverage.show(map);
                    } else {
                        window.CoronaCoverage.hide();
                    }
                };

                window.setSatellite60sMapOpacity = function (val) {
                    var pct = document.getElementById("satellite60sMapPct");
                    if (pct) pct.textContent = val + "%";
                    _sat60Opacity = val / 100;
                    if (_sat60Manager) _sat60Manager.setOpacity(_sat60Opacity);
                };
            })();

            // ── HARTI ISTORICE PREMIUM — PARENT GROUP FUNCTIONS ──
            var _histPremiumSubExpanded = false;
            window.toggleHistPremiumSubLayers = function() {
                _histPremiumSubExpanded = !_histPremiumSubExpanded;
                var panel = document.getElementById('histPremiumSubLayers');
                var icon = document.getElementById('histPremiumExpandIcon');
                if (_histPremiumSubExpanded) {
                    // Înălțimea măsurată din conținut (nu 1000px fix):
                    // plafonul fix tăia ultima hartă (Galiția și Lodomeria 1855).
                    setSubLayersMaxHeight(panel, true, 1000);
                    panel.style.opacity = '1';
                    panel.style.marginTop = '10px';
                    icon.style.transform = 'rotate(0deg)';
                } else {
                    setSubLayersMaxHeight(panel, false);
                    panel.style.opacity = '0';
                    panel.style.marginTop = '0';
                    icon.style.transform = 'rotate(-90deg)';
                }
                setTimeout(function() {
                    if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                }, 350);
            };

            // Substraturile grupului "Harti istorice / Historical maps" (premium).
            // Când switch-ul mare e oprit, toate switch-urile astea (și straturile
            // lor de pe hartă) trebuie oprite automat — vezi bug-ul raportat.
            // NOTE: "Satellite imagery 60's" nu mai e aici — e acum un strat
            // premium de sine stătător (top-level), cu propriul switch, nu un
            // substrat al grupului Historical Maps.
            var HIST_PREMIUM_SUBLAYER_TOGGLES = [
                { id: 'josephineToggle', fnName: 'toggleJosephineLayer' },
                { id: 'bucovinaMapToggle', fnName: 'toggleBucovinaMap' },
                { id: 'austrohuMapToggle', fnName: 'toggleAustrohuMap' },
                { id: 'moldova1868MapToggle', fnName: 'toggleMoldova1868Map' },
                { id: 'moldova1771MapToggle', fnName: 'toggleMoldova1771Map' },
                { id: 'moldovaWwiiMapToggle', fnName: 'toggleMoldovaWwiiMap' },
                { id: 'polishTactical1933MapToggle', fnName: 'togglePolishTactical1933Map' },
                { id: 'ww1MapToggle', fnName: 'toggleWw1Map' },
                { id: 'ww2MapToggle', fnName: 'toggleWw2Map' },
                { id: 'banatMapToggle', fnName: 'toggleBanatMap' },
                { id: 'transylvania1859MapToggle', fnName: 'toggleTransylvania1859Map' },
                { id: 'mitteleuropaMapToggle', fnName: 'toggleMitteleuropaMap' },
                { id: 'chrzanowskiMapToggle', fnName: 'toggleChrzanowskiMap' },
                { id: 'reymannMapToggle', fnName: 'toggleReymannMap' },
                { id: 'kdr100kMapToggle', fnName: 'toggleKdr100kMap' },
                { id: 'kdrGbMapToggle', fnName: 'toggleKdrGbMap' },
                { id: 'wig100kMapToggle', fnName: 'toggleWig100kMap' },
                { id: 'galicia1855MapToggle', fnName: 'toggleGalicia1855Map' }
            ];

            window.toggleHistPremiumLayer = function (on) {
                var toggle = document.getElementById('histPremiumToggle');
                if (toggle) toggle.checked = on;

                if (!on) {
                    // Oprirea grupului mare oprește automat toate substraturile lui:
                    // debifăm fiecare switch și apelăm funcția lui de toggle(false),
                    // care știe deja cum să scoată stratul respectiv de pe hartă.
                    HIST_PREMIUM_SUBLAYER_TOGGLES.forEach(function (child) {
                        var el = document.getElementById(child.id);
                        if (el) el.checked = false;
                        var fn = window[child.fnName];
                        if (typeof fn === 'function') fn(false);
                    });
                    if (window.DetectLabEuMaps && typeof window.DetectLabEuMaps.toggleHistEuLayer === 'function') {
                        window.DetectLabEuMaps.toggleHistEuLayer(false);
                    }
                }

                // Actualizează vizibilitatea poligoanelor de acoperire
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            // ── AMPRENTA VEGETAȚIEI / VEGETATION FINGERPRINT (PREMIUM) ──
            // Grup premium de straturi din familia Copernicus HR-VPP (High
            // Resolution Vegetation Phenology and Productivity). Substratul
            // PPI — Plant Phenology Index, „Seasonal Trajectories” 10 m,
            // compus la fiecare 10 zile (2017–2024). Substratul SMX —
            // valoarea maximă de vegetație atinsă într-un an (VPP MAXV
            // SEASON1, 10 m, anual). Substratul SGU — rata de creștere a
            // vegetației la începutul sezonului („left slope”, VPP LSLOPE
            // SEASON1, 10 m, anual). Substratul SGD — rata de ofilire a
            // vegetației la finalul sezonului („right slope”, VPP RSLOPE
            // SEASON1, 10 m, anual).
            //
            // SERVICIU: același GeoWebCache HR-VPP care expune și WMS-ul de
            // la wmts-1.hrvpp2.vgt.vito.be:8080 (capabilities WMS 1.1.1,
            // layer CLMS_HRVPP_ST_PPI_10M, dimensiune „time” cu date la 01 /
            // 11 / 21 ale fiecărei luni). Folosim endpoint-ul WMTS KVP de la
            // phenology.hrvpp2.vgt.vito.be — singurul disponibil ȘI prin
            // HTTPS (site-ul e servit prin HTTPS; endpoint-ul WMS de pe
            // portul 8080 ar fi blocat de browser ca mixed content).
            // Cererea GetTile cu TILEMATRIXSET=EPSG:3857 lovește direct
            // cache-ul de tile-uri al serviciului (grila EPSG:3857 e exact
            // grila XYZ standard a hărții), fără randare WMS dinamică.
            //
            // OPTIMIZAREA VOLUMULUI DE FETCH — tile-uri doar pentru România:
            //   1. `bounds` (anvelopa poligonului de mai jos): Leaflet nu
            //      creează niciun element de tile în afara dreptunghiului;
            //   2. mască poligonală simplificată a României (superset cu
            //      margine de siguranță spre exterior): tile-urile din
            //      colțurile dreptunghiului care nu intersectează poligonul
            //      primesc un pixel transparent (L.emptyImageUrl) — ZERO
            //      cereri de rețea, deci fără tile-uri pentru Ungaria /
            //      Serbia / Bulgaria / Ucraina / R. Moldova interioare;
            //   3. deciziile măștii sunt memorate pe (z,x,y);
            //   4. minZoom 6 / maxNativeZoom 15: produsul are 10 m/px, deci
            //      z15 (~3,3 m/px la latitudinea României) e deja
            //      supra-eșantionat; peste z15 Leaflet reutilizește tile-urile
            //      z15 (fără fetch nou), iar sub z6 stratul nu se încarcă
            //      (dreptunghiul roșu de acoperire explică de ce).
            map.createPane('pane_vegfp');
            map.getPane('pane_vegfp').style.zIndex = 612; // peste LIDAR (610), sub dreptunghiurile de acoperire (615)
            map.getPane('pane_vegfp').style.pointerEvents = 'none';

            var VEGFP_WMTS_BASE = 'https://phenology.hrvpp2.vgt.vito.be/wmts';
            var VEGFP_PPI_LAYER_NAME = 'CLMS_HRVPP_ST_PPI_10M';
            var VEGFP_PPI_MIN_ZOOM = 6;
            var VEGFP_PPI_MAX_NATIVE_ZOOM = 15;
            var VEGFP_PPI_DEFAULT_TIME = '2024-07-01'; // miezul sezonului de vegetație, ultimul an complet
            var VEGFP_SMX_LAYER_NAME = 'CLMS_HRVPP_VPP_MAXV_SEASON1_10M';
            var VEGFP_SMX_DEFAULT_TIME = '2024-01-01'; // „time” anual, ca la toate straturile VPP
            var VEGFP_SGU_LAYER_NAME = 'CLMS_HRVPP_VPP_LSLOPE_SEASON1_10M';
            var VEGFP_SGU_DEFAULT_TIME = '2024-01-01'; // „time” anual
            var VEGFP_SGD_LAYER_NAME = 'CLMS_HRVPP_VPP_RSLOPE_SEASON1_10M';
            var VEGFP_SGD_DEFAULT_TIME = '2024-01-01'; // la fel ca SGU: „time” anual

            // Poligon SIMPLIFICAT al României ([lat, lng]), parcurs în sens
            // orar, cu vârfurile împinse spre EXTERIOR (superset): niciun
            // punct al României nu rămâne afară, iar tile-urile adânc în
            // țările vecine sunt respinse. Nu e o frontieră exactă — e o
            // mască de fetch, nu un strat cadastral.
            var VEGFP_RO_POLYGON = [
                [46.05, 20.10], // Beba Veche (extrema vestică)
                [46.70, 20.55], // granița cu Ungaria, pad spre vest
                [47.10, 21.30],
                [47.60, 21.50],
                [47.75, 22.00], // cotul Satu Mare
                [48.15, 22.30], // tripliul RO-HU-UA
                [48.10, 23.30], // Oaș, pad spre nord
                [48.05, 24.40],
                [48.00, 25.60], // Rădăuți, pad spre nord
                [48.40, 26.45], // Horodiștea (extrema nordică)
                [48.35, 27.05], // tripliul RO-UA-MD (Prut)
                [47.55, 27.60], // Prut, pad spre est
                [47.20, 27.95], // Ungheni
                [46.75, 28.50],
                [46.30, 28.65], // Prut sud (Cahul/Leova), pad spre est
                [45.60, 28.55], // Giurgiulești (vărsarea Prutului)
                [45.55, 29.60], // brațul Chilia (granița cu Ucraina), pad
                [45.15, 29.90], // Sulina (extrema estică), pad spre est
                [44.45, 29.40], // litoral, pad spre est
                [44.20, 28.90], // Capul Midia
                [43.55, 28.70], // Vama Veche (litoral sud), pad spre mare
                [43.50, 28.00], // Dobrogea de sud, pad spre Bulgaria
                [43.70, 27.25], // cotul Silistra, pad spre sud
                [43.45, 26.60],
                [43.45, 25.55], // Zimnicea (extrema sudică)
                [43.55, 24.50], // Dunărea jos (Corabia), pad spre sud
                [43.80, 22.85], // Vidin, pad spre sud
                [44.15, 22.25], // Cazanele Dunării, pad spre sud
                [44.55, 21.25], // Banatul de Sud (Serbia), pad spre sud
                [44.95, 20.50], // tripliul RO-HU-SR (Baziaș), pad
                [45.30, 20.45]  // Câmpia de Vest, pad spre vest
            ];

            // Anvelopa poligonului — filtrul ieftin de nivel 1 (opțiunea
            // `bounds` a GridLayer: în afara dreptunghiului Leaflet nu
            // creează nici elementul de tile).
            var VEGFP_RO_TILE_BOUNDS = L.latLngBounds(VEGFP_RO_POLYGON);
            var VEGFP_EU_TILE_BOUNDS = L.latLngBounds([[34.0, -25.0], [72.0, 45.0]]);

            function _vegfpCurrentTileBounds() {
                return _isEuropeMarket() ? VEGFP_EU_TILE_BOUNDS : VEGFP_RO_TILE_BOUNDS;
            }

            // ── Geometria măștii (dreptunghi de tile ↔ poligon) ──
            function _vegfpPointInPolygon(lat, lng, poly) {
                var inside = false;
                for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                    var latI = poly[i][0], lngI = poly[i][1];
                    var latJ = poly[j][0], lngJ = poly[j][1];
                    if (((latI > lat) !== (latJ > lat)) &&
                        (lng < (lngJ - lngI) * (lat - latI) / (latJ - latI) + lngI)) {
                        inside = !inside;
                    }
                }
                return inside;
            }

            function _vegfpCross(lngA, latA, lngB, latB, lngP, latP) {
                return (lngB - lngA) * (latP - latA) - (latB - latA) * (lngP - lngA);
            }

            function _vegfpOnSegment(lngA, latA, lngB, latB, lngP, latP) {
                return lngP >= Math.min(lngA, lngB) - 1e-12 && lngP <= Math.max(lngA, lngB) + 1e-12 &&
                       latP >= Math.min(latA, latB) - 1e-12 && latP <= Math.max(latA, latB) + 1e-12;
            }

            function _vegfpSegmentsIntersect(lng1, lat1, lng2, lat2, lng3, lat3, lng4, lat4) {
                var d1 = _vegfpCross(lng3, lat3, lng4, lat4, lng1, lat1);
                var d2 = _vegfpCross(lng3, lat3, lng4, lat4, lng2, lat2);
                var d3 = _vegfpCross(lng1, lat1, lng2, lat2, lng3, lat3);
                var d4 = _vegfpCross(lng1, lat1, lng2, lat2, lng4, lat4);
                if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
                // cazuri coliniare — conservator: le tratăm ca intersecție
                if (d1 === 0 && _vegfpOnSegment(lng3, lat3, lng4, lat4, lng1, lat1)) return true;
                if (d2 === 0 && _vegfpOnSegment(lng3, lat3, lng4, lat4, lng2, lat2)) return true;
                if (d3 === 0 && _vegfpOnSegment(lng1, lat1, lng2, lat2, lng3, lat3)) return true;
                if (d4 === 0 && _vegfpOnSegment(lng1, lat1, lng2, lat2, lng4, lat4)) return true;
                return false;
            }

            function _vegfpRectIntersectsPolygon(minLat, minLng, maxLat, maxLng, poly) {
                // 1. vreun vârf al poligonului cade în dreptunghi
                for (var i = 0; i < poly.length; i++) {
                    if (poly[i][0] >= minLat && poly[i][0] <= maxLat &&
                        poly[i][1] >= minLng && poly[i][1] <= maxLng) return true;
                }
                // 2. vreun colț al dreptunghiului e în poligon
                if (_vegfpPointInPolygon(minLat, minLng, poly)) return true;
                if (_vegfpPointInPolygon(maxLat, minLng, poly)) return true;
                if (_vegfpPointInPolygon(minLat, maxLng, poly)) return true;
                if (_vegfpPointInPolygon(maxLat, maxLng, poly)) return true;
                // 3. vreo muchie a poligonului ta vreo muchie a dreptunghiului
                for (var j = 0, k = poly.length - 1; j < poly.length; k = j++) {
                    var lngA = poly[k][1], latA = poly[k][0];
                    var lngB = poly[j][1], latB = poly[j][0];
                    if (_vegfpSegmentsIntersect(lngA, latA, lngB, latB, minLng, minLat, maxLng, minLat) ||
                        _vegfpSegmentsIntersect(lngA, latA, lngB, latB, maxLng, minLat, maxLng, maxLat) ||
                        _vegfpSegmentsIntersect(lngA, latA, lngB, latB, maxLng, maxLat, minLng, maxLat) ||
                        _vegfpSegmentsIntersect(lngA, latA, lngB, latB, minLng, maxLat, minLng, minLat)) {
                        return true;
                    }
                }
                return false;
            }

            // Limitele geografice ale unui tile XYZ (Web Mercator), fără
            // dependență de stareua hărții — matematică pură.
            function _vegfpTileLat(y, n) {
                return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
            }

            function _vegfpTileInRomania(z, x, y) {
                var key = z + ':' + x + ':' + y;
                var cached = _vegfpMaskCache[key];
                if (cached !== undefined) return cached;
                var n = Math.pow(2, z);
                var minLng = x / n * 360 - 180;
                var maxLng = (x + 1) / n * 360 - 180;
                var maxLat = _vegfpTileLat(y, n);       // marginea de nord
                var minLat = _vegfpTileLat(y + 1, n);   // marginea de sud
                var ok = _vegfpRectIntersectsPolygon(minLat, minLng, maxLat, maxLng, VEGFP_RO_POLYGON);
                // Cache de decizii, cu plafon ca să nu crească la nesfârșit
                // într-o sesiune foarte lungă de navigare.
                if (_vegfpMaskCacheCount > 30000) {
                    _vegfpMaskCache = Object.create(null);
                    _vegfpMaskCacheCount = 0;
                }
                _vegfpMaskCache[key] = ok;
                _vegfpMaskCacheCount++;
                return ok;
            }

            var _vegfpMaskCache = Object.create(null);
            var _vegfpMaskCacheCount = 0;
            window._vegfpTileInRomania = _vegfpTileInRomania; // testare / debug

            // Stratul de tile-uri cu mască: getTileUrl decide, înainte de
            // orice cerere de rețea, dacă tile-ul atinge România (pe .ro).
            // Pe .eu, acoperirea este completă la nivelul întregului continent european (EEA).
            // Cele respinse primesc pixelul transparent al lui Leaflet (fără
            // descărcare). Suprascrierea getTileUrl e același mecanism folosit
            // de js/corona-wms-layer.js.
            var VegFpTileLayer = L.TileLayer.extend({
                getTileUrl: function (coords) {
                    var z = this._getZoomForUrl();
                    if (!_isEuropeMarket() && !_vegfpTileInRomania(z, coords.x, coords.y)) {
                        return (L.Util && L.Util.emptyImageUrl) || L.emptyImageUrl ||
                            'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
                    }
                    return L.TileLayer.prototype.getTileUrl.call(this, coords);
                }
            });

            function _vegfpBuildPpiUrl(time) {
                // Format WMTS KVP verificat împotriva serviciului (GetTile
                // răspunde cu PNG; STYLE= gol e acceptat de GeoWebCache).
                return VEGFP_WMTS_BASE +
                    '?SERVICE=WMTS' +
                    '&REQUEST=GetTile' +
                    '&VERSION=1.0.0' +
                    '&LAYER=' + VEGFP_PPI_LAYER_NAME +
                    '&STYLE=' +
                    '&FORMAT=image%2Fpng' +
                    '&TILEMATRIXSET=EPSG%3A3857' +
                    '&TILEMATRIX=EPSG%3A3857%3A{z}' +
                    '&TILEROW={y}' +
                    '&TILECOL={x}' +
                    '&TIME=' + time;
            }

            function _vegfpBuildSmxUrl(time) {
                // Același format WMTS KVP verificat împotriva serviciului;
                // dimensiunea „time” a straturilor VPP e anuală, deci
                // TIME = YYYY-01-01 (2017-01-01 … 2024-01-01).
                return VEGFP_WMTS_BASE +
                    '?SERVICE=WMTS' +
                    '&REQUEST=GetTile' +
                    '&VERSION=1.0.0' +
                    '&LAYER=' + VEGFP_SMX_LAYER_NAME +
                    '&STYLE=' +
                    '&FORMAT=image%2Fpng' +
                    '&TILEMATRIXSET=EPSG%3A3857' +
                    '&TILEMATRIX=EPSG%3A3857%3A{z}' +
                    '&TILEROW={y}' +
                    '&TILECOL={x}' +
                    '&TIME=' + time;
            }

            function _vegfpBuildSgdUrl(time) {
                // Același format WMTS KVP; „right slope” = rata de scădere
                // (ofilire) la finalul sezonului. TIME anual, ca la SGU.
                return VEGFP_WMTS_BASE +
                    '?SERVICE=WMTS' +
                    '&REQUEST=GetTile' +
                    '&VERSION=1.0.0' +
                    '&LAYER=' + VEGFP_SGD_LAYER_NAME +
                    '&STYLE=' +
                    '&FORMAT=image%2Fpng' +
                    '&TILEMATRIXSET=EPSG%3A3857' +
                    '&TILEMATRIX=EPSG%3A3857%3A{z}' +
                    '&TILEROW={y}' +
                    '&TILECOL={x}' +
                    '&TIME=' + time;
            }

            function _vegfpBuildSguUrl(time) {
                // „left slope” = rata de creștere la începutul sezonului.
                // Același format WMTS KVP, TIME anual.
                return VEGFP_WMTS_BASE +
                    '?SERVICE=WMTS' +
                    '&REQUEST=GetTile' +
                    '&VERSION=1.0.0' +
                    '&LAYER=' + VEGFP_SGU_LAYER_NAME +
                    '&STYLE=' +
                    '&FORMAT=image%2Fpng' +
                    '&TILEMATRIXSET=EPSG%3A3857' +
                    '&TILEMATRIX=EPSG%3A3857%3A{z}' +
                    '&TILEROW={y}' +
                    '&TILECOL={x}' +
                    '&TIME=' + time;
            }

            // Dekadele din dimensiunea „time” a serviciului: zilele 01, 11
            // și 21 ale fiecărei luni, 2017-01-01 → 2024-12-21 (288 date).
            var VEGFP_PPI_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];
            var VEGFP_PPI_DEKAD_DAYS = [1, 11, 21];

            function _vegfpGeneratePpiDates() {
                var list = [];
                for (var yi = 0; yi < VEGFP_PPI_YEARS.length; yi++) {
                    var year = VEGFP_PPI_YEARS[yi];
                    for (var m = 1; m <= 12; m++) {
                        for (var di = 0; di < VEGFP_PPI_DEKAD_DAYS.length; di++) {
                            var day = VEGFP_PPI_DEKAD_DAYS[di];
                            list.push(year + '-' + (m < 10 ? '0' + m : m) +
                                      '-' + (day < 10 ? '0' + day : day));
                        }
                    }
                }
                return list;
            }

            var _vegfpPpiDateList = null;
            function _vegfpPpiDates() {
                if (!_vegfpPpiDateList) _vegfpPpiDateList = _vegfpGeneratePpiDates();
                return _vegfpPpiDateList;
            }
            window._vegfpPpiDates = _vegfpPpiDates; // testare

            // Dimensiunea „time” a straturilor VPP (SMX/MAXV, SGU/LSLOPE,
            // SGD/RSLOPE):
            // o valoare pe an, 2017-01-01 → 2024-01-01.
            var VEGFP_VPP_YEARS = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024];

            var _vegfpVppYearList = null;
            function _vegfpVppYearTimes() {
                if (!_vegfpVppYearList) {
                    _vegfpVppYearList = VEGFP_VPP_YEARS.map(function (y) { return y + '-01-01'; });
                }
                return _vegfpVppYearList;
            }
            window._vegfpVppYearTimes = _vegfpVppYearTimes; // testare

            var _vegfpPpiLayer = null;
            var _vegfpPpiTime = VEGFP_PPI_DEFAULT_TIME;
            var _vegfpSmxLayer = null;
            var _vegfpSmxTime = VEGFP_SMX_DEFAULT_TIME;
            var _vegfpSguLayer = null;
            var _vegfpSguTime = VEGFP_SGU_DEFAULT_TIME;
            var _vegfpSgdLayer = null;
            var _vegfpSgdTime = VEGFP_SGD_DEFAULT_TIME;

            function _vegfpTilePerfOptions(extra) {
                // Aceleași opțiuni gesture-safe ca stiva LIDAR / Sat60 —
                // js/tile-perf.js le aplică oricum global, aici sunt explicite
                // pentru cazul în care guvernorul e oprit din consolă.
                var o = extra || {};
                if (o.updateWhenZooming === undefined) o.updateWhenZooming = false;
                if (o.updateWhenIdle === undefined) o.updateWhenIdle = true;
                if (o.keepBuffer === undefined) {
                    o.keepBuffer = (window.DLTilePerf && window.DLTilePerf.config)
                        ? window.DLTilePerf.config.keepBuffer : 1;
                }
                return o;
            }

            function _buildVegfpPpiLayer() {
                return new VegFpTileLayer(_vegfpBuildPpiUrl(_vegfpPpiTime), _vegfpTilePerfOptions({
                    pane: 'pane_vegfp',
                    attribution: "© European Union's Copernicus Land Monitoring Service information",
                    opacity: 0.85,
                    minZoom: VEGFP_PPI_MIN_ZOOM,
                    maxNativeZoom: VEGFP_PPI_MAX_NATIVE_ZOOM,
                    maxZoom: 20,
                    tileSize: 256,
                    bounds: _vegfpCurrentTileBounds(), // bounds: VEGFP_RO_TILE_BOUNDS
                    className: 'vegfp-ppi-tiles',
                    noWrap: true
                }));
            }

            function _buildVegfpSmxLayer() {
                // Aceleași limite de zoom ca PPI — același produs HR-VPP de
                // 10 m (supra-eșantionat peste z15, gol sub z6).
                return new VegFpTileLayer(_vegfpBuildSmxUrl(_vegfpSmxTime), _vegfpTilePerfOptions({
                    pane: 'pane_vegfp',
                    attribution: "© European Union's Copernicus Land Monitoring Service information",
                    opacity: 0.85,
                    minZoom: VEGFP_PPI_MIN_ZOOM,
                    maxNativeZoom: VEGFP_PPI_MAX_NATIVE_ZOOM,
                    maxZoom: 20,
                    tileSize: 256,
                    bounds: _vegfpCurrentTileBounds(),
                    className: 'vegfp-smx-tiles',
                    noWrap: true
                }));
            }

            function _buildVegfpSguLayer() {
                // Aceleași limite de zoom ca PPI / SMX / SGD — același produs
                // HR-VPP de 10 m.
                return new VegFpTileLayer(_vegfpBuildSguUrl(_vegfpSguTime), _vegfpTilePerfOptions({
                    pane: 'pane_vegfp',
                    attribution: "© European Union's Copernicus Land Monitoring Service information",
                    opacity: 0.85,
                    minZoom: VEGFP_PPI_MIN_ZOOM,
                    maxNativeZoom: VEGFP_PPI_MAX_NATIVE_ZOOM,
                    maxZoom: 20,
                    tileSize: 256,
                    bounds: _vegfpCurrentTileBounds(),
                    className: 'vegfp-sgu-tiles',
                    noWrap: true
                }));
            }

            function _buildVegfpSgdLayer() {
                // Aceleași limite de zoom ca PPI / SGU — același produs HR-VPP
                // de 10 m.
                return new VegFpTileLayer(_vegfpBuildSgdUrl(_vegfpSgdTime), _vegfpTilePerfOptions({
                    pane: 'pane_vegfp',
                    attribution: "© European Union's Copernicus Land Monitoring Service information",
                    opacity: 0.85,
                    minZoom: VEGFP_PPI_MIN_ZOOM,
                    maxNativeZoom: VEGFP_PPI_MAX_NATIVE_ZOOM,
                    maxZoom: 20,
                    tileSize: 256,
                    bounds: _vegfpCurrentTileBounds(),
                    className: 'vegfp-sgd-tiles',
                    noWrap: true
                }));
            }

            // ── Public: masterul grupului ──
            window.toggleVegfpLayer = function (on) {
                var toggle = document.getElementById('vegfpToggle');
                if (toggle) toggle.checked = on;
                if (!on) {
                    // Oprirea masterului oprește toate substraturile, exact ca
                    // la „Harti istorice” / LIDAR — la repornire nu trebuie să
                    // reapară un substrat rămas „aprins” din greșeală.
                    var ppiToggle = document.getElementById('vegfpPpiToggle');
                    if (ppiToggle) ppiToggle.checked = false;
                    window.toggleVegfpPpiLayer(false);
                    var smxToggle = document.getElementById('vegfpSmxToggle');
                    if (smxToggle) smxToggle.checked = false;
                    window.toggleVegfpSmxLayer(false);
                    var sguToggle = document.getElementById('vegfpSguToggle');
                    if (sguToggle) sguToggle.checked = false;
                    window.toggleVegfpSguLayer(false);
                    var sgdToggle = document.getElementById('vegfpSgdToggle');
                    if (sgdToggle) sgdToggle.checked = false;
                    window.toggleVegfpSgdLayer(false);
                }
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            // ── Public: expand/collapse panoul de substraturi ──
            var _vegfpSubExpanded = false;
            window.toggleVegfpSubLayers = function () {
                _vegfpSubExpanded = !_vegfpSubExpanded;
                var panel = document.getElementById('vegfpSubLayers');
                var icon = document.getElementById('vegfpExpandIcon');
                if (_vegfpSubExpanded) {
                    setSubLayersMaxHeight(panel, true, 900);
                    panel.style.opacity = '1';
                    panel.style.marginTop = '10px';
                    icon.style.transform = 'rotate(0deg)';
                } else {
                    setSubLayersMaxHeight(panel, false);
                    panel.style.opacity = '0';
                    panel.style.marginTop = '0';
                    icon.style.transform = 'rotate(-90deg)';
                }
                setTimeout(function () {
                    if (typeof window.checkLayerVisibility === 'function') window.checkLayerVisibility();
                }, 350);
            };

            // ── Public: substratul PPI ──
            window.toggleVegfpPpiLayer = function (on) {
                if (on) {
                    // Pornirea unui substrat pornește și masterul grupului
                    // (ca la Harta Iosefină + din „Harti istorice”).
                    var master = document.getElementById('vegfpToggle');
                    if (master && !master.checked) {
                        master.checked = true;
                        window.toggleVegfpLayer(true);
                    }
                    if (!_vegfpPpiLayer) {
                        _vegfpPpiLayer = _buildVegfpPpiLayer();
                        window._vegfpPpiLayer = _vegfpPpiLayer; // dreptunghiul roșu de acoperire
                    }
                    if (!map.hasLayer(_vegfpPpiLayer)) _vegfpPpiLayer.addTo(map);
                } else if (_vegfpPpiLayer && map.hasLayer(_vegfpPpiLayer)) {
                    map.removeLayer(_vegfpPpiLayer);
                }
                var row = document.getElementById('vegfpPpiRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            window.setVegfpPpiOpacity = function (val) {
                var opacity = parseFloat(val) / 100;
                var pct = document.getElementById('vegfpPpiPct');
                if (pct) pct.textContent = Math.round(opacity * 100) + '%';
                if (_vegfpPpiLayer && _vegfpPpiLayer.setOpacity) {
                    _vegfpPpiLayer.setOpacity(opacity);
                }
            };

            function _vegfpSyncPpiDateButtons() {
                var dates = _vegfpPpiDates();
                var idx = dates.indexOf(_vegfpPpiTime);
                var prev = document.getElementById('vegfpPpiPrevBtn');
                var next = document.getElementById('vegfpPpiNextBtn');
                if (prev) prev.disabled = (idx <= 0);
                if (next) next.disabled = (idx === -1 || idx >= dates.length - 1);
            }

            window.setVegfpPpiDate = function (dateStr) {
                if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
                _vegfpPpiTime = dateStr;
                if (_vegfpPpiLayer) {
                    // setUrl fără noRedraw → curăță și reîncarcă tile-urile
                    // vizibile cu noua valoare TIME.
                    _vegfpPpiLayer.setUrl(_vegfpBuildPpiUrl(dateStr));
                }
                _vegfpSyncPpiDateButtons();
            };

            window.vegfpPpiStepDekad = function (dir) {
                var dates = _vegfpPpiDates();
                var idx = dates.indexOf(_vegfpPpiTime);
                if (idx === -1) idx = dates.length - 1;
                var next = idx + (dir > 0 ? 1 : -1);
                if (next < 0 || next >= dates.length) return; // capetele listei
                var select = document.getElementById('vegfpPpiDateSelect');
                if (select) select.value = dates[next];
                window.setVegfpPpiDate(dates[next]);
            };

            // Populează selectorul de dekade (grupat pe ani).
            (function _vegfpPopulatePpiDates() {
                var select = document.getElementById('vegfpPpiDateSelect');
                if (!select) return;
                var dates = _vegfpPpiDates();
                var currentYear = null;
                var group = null;
                for (var i = 0; i < dates.length; i++) {
                    var d = dates[i];
                    var y = d.slice(0, 4);
                    if (y !== currentYear) {
                        currentYear = y;
                        group = document.createElement('optgroup');
                        group.label = y;
                        select.appendChild(group);
                    }
                    var opt = document.createElement('option');
                    opt.value = d;
                    opt.textContent = d;
                    if (d === _vegfpPpiTime) opt.selected = true;
                    group.appendChild(opt);
                }
                _vegfpSyncPpiDateButtons();
            })();

            // ── Public: substratul SGU (VPP LSLOPE — rata de creștere la
            // începutul sezonului; dimensiunea „time” e anuală) ──
            window.toggleVegfpSmxLayer = function (on) {
                if (on) {
                    // Pornirea unui substrat pornește și masterul grupului.
                    var master = document.getElementById('vegfpToggle');
                    if (master && !master.checked) {
                        master.checked = true;
                        window.toggleVegfpLayer(true);
                    }
                    if (!_vegfpSmxLayer) {
                        _vegfpSmxLayer = _buildVegfpSmxLayer();
                        window._vegfpSmxLayer = _vegfpSmxLayer; // dreptunghiul roșu de acoperire
                    }
                    if (!map.hasLayer(_vegfpSmxLayer)) _vegfpSmxLayer.addTo(map);
                } else if (_vegfpSmxLayer && map.hasLayer(_vegfpSmxLayer)) {
                    map.removeLayer(_vegfpSmxLayer);
                }
                var row = document.getElementById('vegfpSmxRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            window.setVegfpSmxOpacity = function (val) {
                var opacity = parseFloat(val) / 100;
                var pct = document.getElementById('vegfpSmxPct');
                if (pct) pct.textContent = Math.round(opacity * 100) + '%';
                if (_vegfpSmxLayer && _vegfpSmxLayer.setOpacity) {
                    _vegfpSmxLayer.setOpacity(opacity);
                }
            };

            function _vegfpSyncSmxYearButtons() {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSmxTime);
                var prev = document.getElementById('vegfpSmxPrevBtn');
                var next = document.getElementById('vegfpSmxNextBtn');
                if (prev) prev.disabled = (idx <= 0);
                if (next) next.disabled = (idx === -1 || idx >= years.length - 1);
            }

            window.setVegfpSmxYear = function (timeStr) {
                // Straturile VPP au o singură valoare „time” pe an.
                if (!timeStr || !/^\d{4}-01-01$/.test(timeStr)) return;
                if (_vegfpVppYearTimes().indexOf(timeStr) === -1) return;
                _vegfpSmxTime = timeStr;
                if (_vegfpSmxLayer) {
                    // setUrl fără noRedraw → curăță și reîncarcă tile-urile
                    // vizibile cu noul an.
                    _vegfpSmxLayer.setUrl(_vegfpBuildSmxUrl(timeStr));
                }
                _vegfpSyncSmxYearButtons();
            };

            window.vegfpSmxStepYear = function (dir) {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSmxTime);
                if (idx === -1) idx = years.length - 1;
                var next = idx + (dir > 0 ? 1 : -1);
                if (next < 0 || next >= years.length) return; // capetele listei
                var select = document.getElementById('vegfpSmxYearSelect');
                if (select) select.value = years[next];
                window.setVegfpSmxYear(years[next]);
            };

            // Populează selectorul de ani (câte o opțiune pe an).
            (function _vegfpPopulateSmxYears() {
                var select = document.getElementById('vegfpSmxYearSelect');
                if (!select) return;
                var years = _vegfpVppYearTimes();
                for (var i = 0; i < years.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = years[i];
                    opt.textContent = years[i].slice(0, 4); // doar anul
                    if (years[i] === _vegfpSmxTime) opt.selected = true;
                    select.appendChild(opt);
                }
                _vegfpSyncSmxYearButtons();
            })();

            // ── Public: substratul SGU (VPP LSLOPE — rata de creștere la
            // începutul sezonului; dimensiunea „time” e anuală) ──
            window.toggleVegfpSguLayer = function (on) {
                if (on) {
                    // Pornirea unui substrat pornește și masterul grupului.
                    var master = document.getElementById('vegfpToggle');
                    if (master && !master.checked) {
                        master.checked = true;
                        window.toggleVegfpLayer(true);
                    }
                    if (!_vegfpSguLayer) {
                        _vegfpSguLayer = _buildVegfpSguLayer();
                        window._vegfpSguLayer = _vegfpSguLayer; // dreptunghiul roșu de acoperire
                    }
                    if (!map.hasLayer(_vegfpSguLayer)) _vegfpSguLayer.addTo(map);
                } else if (_vegfpSguLayer && map.hasLayer(_vegfpSguLayer)) {
                    map.removeLayer(_vegfpSguLayer);
                }
                var row = document.getElementById('vegfpSguRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            window.setVegfpSguOpacity = function (val) {
                var opacity = parseFloat(val) / 100;
                var pct = document.getElementById('vegfpSguPct');
                if (pct) pct.textContent = Math.round(opacity * 100) + '%';
                if (_vegfpSguLayer && _vegfpSguLayer.setOpacity) {
                    _vegfpSguLayer.setOpacity(opacity);
                }
            };

            function _vegfpSyncSguYearButtons() {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSguTime);
                var prev = document.getElementById('vegfpSguPrevBtn');
                var next = document.getElementById('vegfpSguNextBtn');
                if (prev) prev.disabled = (idx <= 0);
                if (next) next.disabled = (idx === -1 || idx >= years.length - 1);
            }

            window.setVegfpSguYear = function (timeStr) {
                // Straturile VPP au o singură valoare „time” pe an.
                if (!timeStr || !/^\d{4}-01-01$/.test(timeStr)) return;
                if (_vegfpVppYearTimes().indexOf(timeStr) === -1) return;
                _vegfpSguTime = timeStr;
                if (_vegfpSguLayer) {
                    _vegfpSguLayer.setUrl(_vegfpBuildSguUrl(timeStr));
                }
                _vegfpSyncSguYearButtons();
            };

            window.vegfpSguStepYear = function (dir) {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSguTime);
                if (idx === -1) idx = years.length - 1;
                var next = idx + (dir > 0 ? 1 : -1);
                if (next < 0 || next >= years.length) return; // capetele listei
                var select = document.getElementById('vegfpSguYearSelect');
                if (select) select.value = years[next];
                window.setVegfpSguYear(years[next]);
            };

            // Populează selectorul de ani (câte o opțiune pe an).
            (function _vegfpPopulateSguYears() {
                var select = document.getElementById('vegfpSguYearSelect');
                if (!select) return;
                var years = _vegfpVppYearTimes();
                for (var i = 0; i < years.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = years[i];
                    opt.textContent = years[i].slice(0, 4); // doar anul
                    if (years[i] === _vegfpSguTime) opt.selected = true;
                    select.appendChild(opt);
                }
                _vegfpSyncSguYearButtons();
            })();

            // ── Public: substratul SGD (VPP RSLOPE — rata de ofilire la
            // finalul sezonului; dimensiunea „time” e anuală) ──
            window.toggleVegfpSgdLayer = function (on) {
                if (on) {
                    // Pornirea unui substrat pornește și masterul grupului.
                    var master = document.getElementById('vegfpToggle');
                    if (master && !master.checked) {
                        master.checked = true;
                        window.toggleVegfpLayer(true);
                    }
                    if (!_vegfpSgdLayer) {
                        _vegfpSgdLayer = _buildVegfpSgdLayer();
                        window._vegfpSgdLayer = _vegfpSgdLayer; // dreptunghiul roșu de acoperire
                    }
                    if (!map.hasLayer(_vegfpSgdLayer)) _vegfpSgdLayer.addTo(map);
                } else if (_vegfpSgdLayer && map.hasLayer(_vegfpSgdLayer)) {
                    map.removeLayer(_vegfpSgdLayer);
                }
                var row = document.getElementById('vegfpSgdRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
                if (typeof window.updatePremiumMapCoverageVisibility === 'function') {
                    window.updatePremiumMapCoverageVisibility();
                }
            };

            window.setVegfpSgdOpacity = function (val) {
                var opacity = parseFloat(val) / 100;
                var pct = document.getElementById('vegfpSgdPct');
                if (pct) pct.textContent = Math.round(opacity * 100) + '%';
                if (_vegfpSgdLayer && _vegfpSgdLayer.setOpacity) {
                    _vegfpSgdLayer.setOpacity(opacity);
                }
            };

            function _vegfpSyncSgdYearButtons() {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSgdTime);
                var prev = document.getElementById('vegfpSgdPrevBtn');
                var next = document.getElementById('vegfpSgdNextBtn');
                if (prev) prev.disabled = (idx <= 0);
                if (next) next.disabled = (idx === -1 || idx >= years.length - 1);
            }

            window.setVegfpSgdYear = function (timeStr) {
                // Straturile VPP au o singură valoare „time” pe an.
                if (!timeStr || !/^\d{4}-01-01$/.test(timeStr)) return;
                if (_vegfpVppYearTimes().indexOf(timeStr) === -1) return;
                _vegfpSgdTime = timeStr;
                if (_vegfpSgdLayer) {
                    _vegfpSgdLayer.setUrl(_vegfpBuildSgdUrl(timeStr));
                }
                _vegfpSyncSgdYearButtons();
            };

            window.vegfpSgdStepYear = function (dir) {
                var years = _vegfpVppYearTimes();
                var idx = years.indexOf(_vegfpSgdTime);
                if (idx === -1) idx = years.length - 1;
                var next = idx + (dir > 0 ? 1 : -1);
                if (next < 0 || next >= years.length) return; // capetele listei
                var select = document.getElementById('vegfpSgdYearSelect');
                if (select) select.value = years[next];
                window.setVegfpSgdYear(years[next]);
            };

            // Populează selectorul de ani (câte o opțiune pe an).
            (function _vegfpPopulateSgdYears() {
                var select = document.getElementById('vegfpSgdYearSelect');
                if (!select) return;
                var years = _vegfpVppYearTimes();
                for (var i = 0; i < years.length; i++) {
                    var opt = document.createElement('option');
                    opt.value = years[i];
                    opt.textContent = years[i].slice(0, 4); // doar anul
                    if (years[i] === _vegfpSgdTime) opt.selected = true;
                    select.appendChild(opt);
                }
                _vegfpSyncSgdYearButtons();
            })();

            // ── Public: ferestrele de info (grup + substrat) ──
            function _vegfpInfoDescription(layer) {
                var lang = (typeof window._currentLang === 'function') ? window._currentLang() : 'ro';
                if (layer === 'smx') {
                    if (lang === 'ro') {
                        return 'Valoarea maximă de vegetație atinsă într-un an. Un zid sau o ' +
                            'fundație sub sol limitează cât de mult poate crește cultura, chiar ' +
                            'și în plin sezon.';
                    }
                    return 'The maximum vegetation value reached in a year. A wall or a foundation ' +
                        'buried in the soil limits how much the crop can grow, even in peak ' +
                        'season.';
                }
                if (layer === 'sgu') {
                    if (lang === 'ro') {
                        return 'Cât de repede crește vegetația la începutul sezonului. ' +
                            'Solul subțire de deasupra unei structuri îngropate se încălzește și ' +
                            'se usucă mai repede, așa că cultura de acolo pornește mai lent sau mai ' +
                            'rapid decât cea din jur — o diferență vizibilă exact în perioada de ' +
                            'creștere timpurie.';
                    }
                    return 'How fast the vegetation grows at the start of the season. The thin soil ' +
                        'above a buried structure warms up and dries out sooner, so the crop on top ' +
                        'starts more slowly — or more quickly — than the surrounding one: a ' +
                        'difference visible precisely in the early growth period.';
                }
                if (layer === 'sgd') {
                    if (lang === 'ro') {
                        return 'Cât de rapid se ofilește vegetația spre final de sezon. Șanțurile ' +
                            'umplute cu sol mai afânat rețin apa mai mult, întârziind ofilirea ' +
                            'deasupra lor.';
                    }
                    return 'How quickly the vegetation wilts toward the end of the season. Ditches ' +
                        'filled with looser soil hold water longer, delaying the wilting of the ' +
                        'crop above them.';
                }
                if (layer === 'ppi') {
                    if (lang === 'ro') {
                        return 'Arată sănătatea vegetației la fiecare 10 zile de-a lungul sezonului. ' +
                            'Structurile îngropate schimbă ritmul de creștere al culturii deasupra lor, ' +
                            'vizibil ca abateri în curba sezonieră.';
                    }
                    return 'Shows vegetation health every 10 days throughout the season. Buried structures ' +
                        'change the growth rhythm of the crop above them, visible as deviations in the ' +
                        'seasonal curve.';
                }
                // descrierea grupului (master)
                if (lang === 'ro') {
                    return 'Straturi CLMS HR-VPP (10 m) pentru amprenta culturilor asupra peisajului: ' +
                        'PPI urmărește sănătatea vegetației la fiecare 10 zile, SGU rata de creștere ' +
                        'la începutul sezonului, SMX valoarea maximă din plin sezon, iar SGD rata ' +
                        'de ofilire la finalul lui. Tile-urile se încarcă doar pentru România.';
                }
                return 'CLMS HR-VPP layers (10 m) for the fingerprint crops leave on the landscape: ' +
                    'PPI tracks vegetation health every 10 days, SGU the growth rate at the start ' +
                    'of the season, SMX the peak value in full season and SGD the wilting rate at ' +
                    'its end. Tiles are fetched only for Romania.';
            }

            var VEGFP_ATTRIBUTION = "© European Union's Copernicus Land Monitoring Service information";

            window.showVegfpInfo = function () {
                if (typeof window.showLayerInfo === 'function') {
                    window.showLayerInfo('Amprenta Vegetației / Vegetation Fingerprint',
                        VEGFP_ATTRIBUTION, _vegfpInfoDescription());
                }
            };

            window.showVegfpPpiInfo = function () {
                if (typeof window.showLayerInfo === 'function') {
                    window.showLayerInfo('PPI — Plant Phenology Index',
                        VEGFP_ATTRIBUTION, _vegfpInfoDescription('ppi'));
                }
            };

            window.showVegfpSmxInfo = function () {
                if (typeof window.showLayerInfo === 'function') {
                    window.showLayerInfo('SMX — Season Maximum value (MAXV)',
                        VEGFP_ATTRIBUTION, _vegfpInfoDescription('smx'));
                }
            };

            window.showVegfpSguInfo = function () {
                if (typeof window.showLayerInfo === 'function') {
                    window.showLayerInfo('SGU — Season Green-Up rate (LSLOPE)',
                        VEGFP_ATTRIBUTION, _vegfpInfoDescription('sgu'));
                }
            };

            window.showVegfpSgdInfo = function () {
                if (typeof window.showLayerInfo === 'function') {
                    window.showLayerInfo('SGD — Season Green-Down rate (RSLOPE)',
                        VEGFP_ATTRIBUTION, _vegfpInfoDescription('sgd'));
                }
            };

            // ── HARTA IOSEFINĂ GRATUITĂ (VERSIUNE CORECTATĂ) ──

            // ========== DECLARARE VARIABILE ==========
            var IOSFREE_MIN_ZOOM = 14;
            var _iosDB = null;
            var _lastLocality = null;
            var _imgCache = {};
            var _currentOverlay = null;
            var _currentLocality = null;
            var _isFlying = false;
            var _currentImageUrl = null;


            // Funcții helper
            function _t(key) {
                var lang = (typeof currentLang !== 'undefined') ? currentLang : 'ro';
                var T = (typeof translations !== 'undefined' && translations[lang]) ? translations[lang] : {};
                return T[key] || key;
            }

            function _msgEl() { return document.getElementById('iosfreePreviewMsg'); }
            function _previewEl() { return document.getElementById('iosfreePreview'); }

            function _removeOverlay() {
                if (_currentOverlay && window._dlMap) {
                    window._dlMap.removeLayer(_currentOverlay);
                    _currentOverlay = null;
                }
                _currentLocality = null;
                // Ascunde butoanele de pan din panel, arată Search
                var panelBtns = document.getElementById('iosfreePanelBtns');
                if (panelBtns) panelBtns.style.display = 'none';
                var searchBtn = document.getElementById('iosfreeSearchBtn');
                if (searchBtn) searchBtn.style.display = '';
            }

            window.setIosfreeOpacity = function (val) {
                var opacity = parseFloat(val) / 100;
                var pct = document.getElementById('iosfreeOpacityPct');
                if (pct) pct.textContent = Math.round(opacity * 100) + '%';
                if (_currentOverlay) _currentOverlay.setOpacity(opacity);
            };

            window.toggleIosfreeLayer = function (on) {
                var histToggle = document.getElementById('histToggle');
                var histOn = histToggle && histToggle.checked;
                if (on && !histOn) {
                    if (histToggle) histToggle.checked = true;
                    window.toggleHistLayer(true);
                    histOn = true;
                }
                if (!histOn) return; // master toggle controls visibility
                if (on) {
                    // re-show overlay if one was loaded
                    if (_currentOverlay && !map.hasLayer(_currentOverlay)) {
                        _currentOverlay.addTo(map);
                    }
                    var searchBtn = document.getElementById('iosfreeSearchBtn');
                    var panelBtns = document.getElementById('iosfreePanelBtns');
                    if (_currentOverlay && panelBtns) panelBtns.style.display = '';
                    else if (searchBtn) searchBtn.style.display = '';
                } else {
                    if (_currentOverlay && map.hasLayer(_currentOverlay)) {
                        map.removeLayer(_currentOverlay);
                    }
                }
                var row = document.getElementById('iosfreeRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
            };

            window.toggleJosephineLayer = function (on) {
                if (on) {
                    var histPremToggle = document.getElementById('histPremiumToggle');
                    if (histPremToggle && !histPremToggle.checked) {
                        histPremToggle.checked = true;
                        window.toggleHistPremiumLayer(true);
                    }
                }
                // _jLayer is in the Josephine/Historical Maps closure — access via window._jLayerRef if set
                if (window._jLayerRef) {
                    if (on) {
                        window._jLayerRef.addTo(map);
                    } else {
                        map.hasLayer(window._jLayerRef) && map.removeLayer(window._jLayerRef);
                    }
                }
                var pane = map.getPane('pane_josephine');
                if (pane) pane.style.display = on ? '' : 'none';
                var row = document.getElementById('josephineRow');
                if (row) row.style.opacity = on ? '1' : '0.45';
                // Actualizăm vizibilitatea butonului Buildings Search
                if (typeof window._refreshIosBldBtnVisibility === 'function') window._refreshIosBldBtnVisibility();
                if (!on && typeof window.clearIosBldSearchHelp === 'function') window.clearIosBldSearchHelp();
            };

            function _calculateBounds(lat, lng, imageUrl, callback) {
                var img = new Image();
                img.onload = function () {
                    var imgWidth = img.width;
                    var imgHeight = img.height;
                    var aspectRatio = imgWidth / imgHeight;

                    // DUBLEAZĂ DIMENSIUNEA - de la 12 km la 24 km lățime
                    var widthKm = 24;   // era 12, acum 24 (dublu)
                    var heightKm = widthKm / aspectRatio;

                    var metersPerDegree = 111320;
                    var deltaLng = (widthKm * 1000 / 2) / (metersPerDegree * Math.cos(lat * Math.PI / 180));
                    var deltaLat = (heightKm * 1000 / 2) / metersPerDegree;

                    var bounds = L.latLngBounds(
                        [lat - deltaLat, lng - deltaLng],
                        [lat + deltaLat, lng + deltaLng]
                    );

                    callback(bounds);
                };
                img.onerror = function () {
                    // Fallback dublat și aici
                    var metersPerDegree = 111320;
                    var deltaDegrees = (16000 / 2) / metersPerDegree;  // era 8000, acum 16000
                    var bounds = L.latLngBounds(
                        [lat - deltaDegrees, lng - deltaDegrees],
                        [lat + deltaDegrees, lng + deltaDegrees]
                    );
                    callback(bounds);
                };
                img.src = imageUrl;
            }

            function _fetchWikiImage(wikiUrl, locality, cb) {
                console.log('[Iosefină] Fetch imagine pentru:', wikiUrl);
                var match = wikiUrl.match(/File:([^/]+)$/);
                if (!match) {
                    console.log('Nu se poate extrage numele fișierului');
                    cb(null);
                    return;
                }
                var filename = decodeURIComponent(match[1]);
                var apiUrl = 'https://en.wikipedia.org/w/api.php?action=query&titles=File:' +
                    encodeURIComponent(filename) +
                    '&prop=imageinfo&iiprop=url&format=json&origin=*';

                fetch(apiUrl)
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        console.log('Răspuns primit pentru', locality, data);
                        var pages = data.query && data.query.pages;
                        if (!pages) { cb(null); return; }
                        var page = Object.values(pages)[0];
                        var imgUrl = page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url;
                        if (imgUrl) {
                            _imgCache[wikiUrl] = imgUrl;
                            console.log('✅ Imagine găsită:', imgUrl);
                            cb(imgUrl);
                        } else {
                            console.log('❌ Nu s-a găsit URL pentru imagine');
                            cb(null);
                        }
                    })
                    .catch(function (err) {
                        console.error('Eroare fetch:', err);
                        cb(null);
                    });
            }

            function _loadAndDisplay(entry, displayName, targetLat, targetLng, customBounds) {
                console.log('[Iosefină] Încarcă pentru:', displayName, targetLat, targetLng);

                _fetchWikiImage(entry.l, displayName, function (imgUrl) {
                    console.log('[Iosefină] Callback primit, imgUrl:', imgUrl);

                    if (!imgUrl) {
                        var msg = _msgEl();
                        if (msg) {
                            msg.style.display = '';
                            msg.innerHTML = '⚠ ' + _t('iosfree_notfound');
                        }
                        return;
                    }

                    _currentImageUrl = imgUrl;
                    _showThumbnail(imgUrl, displayName);

                    // Calculează limitele proporțional cu imaginea
                    if (customBounds && Array.isArray(customBounds) && customBounds.length === 2) {
                        // Folosește limitele personalizate din JSON
                        var bounds = L.latLngBounds(customBounds[0], customBounds[1]);
                        _finalizeDisplay(imgUrl, displayName, bounds, targetLat, targetLng);
                    } else if (targetLat != null && targetLng != null) {
                        // Calculează limitele proporțional
                        _calculateBounds(targetLat, targetLng, imgUrl, function (bounds) {
                            _finalizeDisplay(imgUrl, displayName, bounds, targetLat, targetLng);
                        });
                    } else {
                        console.warn('[Iosefină] Nu există coordonate');
                    }
                });
            }

            function _finalizeDisplay(imgUrl, displayName, bounds, targetLat, targetLng) {
                // ASCUNDE MESAJUL DE LOADING
                var msg = _msgEl();
                if (msg) {
                    msg.style.display = 'none';
                }

                // Micșorează imaginea cu 19% față de centrul geografic (0.9 × 0.9)
                var _scale = 0.81;
                var _c    = bounds.getCenter();
                var _dLat = (bounds.getNorth() - bounds.getSouth()) / 2 * _scale;
                var _dLng = (bounds.getEast()  - bounds.getWest())  / 2 * _scale;
                bounds = L.latLngBounds(
                    [_c.lat - _dLat, _c.lng - _dLng],
                    [_c.lat + _dLat, _c.lng + _dLng]
                );

                // Plasează overlay-ul pe hartă
                _placeOnMap(imgUrl, displayName, bounds);

                // Nu mai forțăm flyTo — utilizatorul poate vedea harta la orice zoom
            }


            // Caută o localitate în baza de date
            function _normalizeDiacritics(str) {
                return str
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[\u015f\u015e]/g, 's')
                    .replace(/[\u0163\u0162]/g, 't');
            }

            function lookupLocality(name, lat, lng) {
                if (!name || !_iosDB) return;

                var key = name.trim().toLowerCase();
                var keyNorm = _normalizeDiacritics(key);
                var entry = _iosDB[key];

                if (!entry) {
                    var keys = Object.keys(_iosDB);
                    for (var i = 0; i < keys.length; i++) {
                        var dbKeyNorm = _normalizeDiacritics(keys[i]);
                        if (keys[i] === key || dbKeyNorm === keyNorm ||
                            dbKeyNorm.indexOf(keyNorm) === 0 || keyNorm.indexOf(dbKeyNorm) === 0 ||
                            keys[i].indexOf(key) === 0 || keys[i].includes(key)) {
                            entry = _iosDB[keys[i]];
                            break;
                        }
                    }
                }

                if (!entry) {
                    var msg = _msgEl();
                    if (msg) {
                        msg.style.display = '';
                        msg.innerHTML = '⚠ ' + _t('iosfree_notfound') + ': <em>' + name + '</em>';
                    }
                    _removeOverlay();
                    return;
                }

                if (_currentLocality === key) return;
                _currentLocality = key;

                var targetLat = entry.lat || lat;
                var targetLng = entry.lng || lng;
                var displayName = entry.d || name;
                var customBounds = entry.bounds || null;

                if (entry.c && typeof entry.c === 'object') {
                    targetLat = entry.c.lat || targetLat;
                    targetLng = entry.c.lng || targetLng;
                }

                if (typeof targetLat === 'string' && targetLat.includes(',')) {
                    var parts = targetLat.split(',');
                    targetLat = parseFloat(parts[0]);
                    targetLng = parseFloat(parts[1]);
                }

                if (isNaN(targetLat) || isNaN(targetLng)) {
                    console.warn('[Iosefină] Coordonate invalide pentru', displayName);
                    var msg = _msgEl();
                    if (msg) {
                        msg.style.display = '';
                        msg.innerHTML = '⚠ Coordonate lipsă pentru ' + displayName;
                    }
                    return;
                }

                var msg = _msgEl();
                if (msg) {
                    msg.style.display = '';
                    msg.innerHTML = '⏳ ' + _t('iosfree_loading');
                }

                var oldImg = document.getElementById('iosfreeImg');
                if (oldImg) oldImg.remove();

                _loadAndDisplay(entry, displayName, targetLat, targetLng, customBounds);
            }

            // Activare la zoom/pan
            function _activate(lat, lng) {
                if (!_iosDB) return;

                var row = document.getElementById('iosfreeRow');
                if (row) row.style.display = '';

                var sub = document.getElementById('histSubLayers');
                if (sub && (sub.style.maxHeight === '0px' || sub.style.maxHeight === '0')) {
                    if (typeof toggleHistSubLayers === 'function') toggleHistSubLayers();
                }

                // Găsește cea mai apropiată localitate din DB față de coordonatele centrului
                var closestEntry = null;
                var closestKey = null;
                var minDist = Infinity;

                for (var key in _iosDB) {
                    var e = _iosDB[key];
                    // Suportă atât {lat, lng} cât și {c: {lat, lng}}
                    var eLat = (e.c && e.c.lat) ? e.c.lat : e.lat;
                    var eLng = (e.c && e.c.lng) ? e.c.lng : e.lng;
                    if (eLat == null || eLng == null) continue;

                    var d = Math.sqrt(
                        Math.pow(eLat - lat, 2) +
                        Math.pow(eLng - lng, 2)
                    );
                    if (d < minDist) {
                        minDist = d;
                        closestEntry = e;
                        closestKey = key;
                    }
                }

                if (!closestEntry) return;

                // ── FIX: verifică dacă cea mai apropiată localitate este
                //    în raza de acoperire a hărții Iozefine (~0.25° ≈ 25–28 km).
                //    Dacă centrul hărții este mai departe, zona nu are acoperire.
                var MAX_DIST_DEG = 0.25;
                if (minDist > MAX_DIST_DEG) {
                    var msg = _msgEl();
                    if (msg) {
                        msg.style.display = '';
                        msg.innerHTML = '⚠ ' + _t('iosfree_notfound');
                    }
                    _removeOverlay();
                    return;
                }

                // Evită reîncărcarea dacă e aceeași localitate
                var newKey = closestKey;
                if (_currentLocality === newKey) return;
                _currentLocality = newKey;

                var targetLat = (closestEntry.c && closestEntry.c.lat) ? closestEntry.c.lat : closestEntry.lat;
                var targetLng = (closestEntry.c && closestEntry.c.lng) ? closestEntry.c.lng : closestEntry.lng;
                var displayName = closestEntry.d || closestKey;
                var customBounds = closestEntry.bounds || null;

                // Arată mesaj de loading
                var msg = _msgEl();
                if (msg) { msg.style.display = ''; msg.innerHTML = '⏳ ' + _t('iosfree_loading') + ' (' + displayName + ')'; }

                // Încarcă direct imaginea pe baza coordonatelor — fără lookup după nume
                _loadAndDisplay(closestEntry, displayName, targetLat, targetLng, customBounds);
            }

            // Inițializare
            function _init() {
                if (!window._dlMap) {
                    setTimeout(_init, 200);
                    return;
                }

                var map = window._dlMap;

                if (!map.getPane('iosfreePane')) {
                    map.createPane('iosfreePane');
                    var iosPane = map.getPane('iosfreePane');
                    iosPane.style.zIndex = 1000;
                    iosPane.style.pointerEvents = 'auto';
                    console.log('[Iosefină] Pane dedicat creat cu zIndex 1000');
                }

                map.on('zoomend moveend', function () {
                    // Auto-căutarea a fost dezactivată — folosește butonul "Caută aici"
                    // (fostul cod chema _activate la orice mișcare)
                });

                // Activare inițială imediat după încărcarea bazei de date
                // Nu mai facem auto-activate — utilizatorul apasă butonul

                window._iosFreeActivateSearch = function (localityName, lat, lng) {
                    var toggle = document.getElementById('iosfreeToggle');
                    if (toggle && !toggle.checked) return; // layer is off — don't fetch or display anything
                    _currentLocality = null;
                    lookupLocality(localityName, lat, lng);
                };

                // Funcție publică pentru butonul "Caută / Search"
                window.iosfreeManualSearch = function () {
                    if (!window._dlMap) return;
                    var center = window._dlMap.getCenter();
                    _currentLocality = null; // Forțează re-căutare chiar dacă e aceeași zonă
                    _activate(center.lat, center.lng);
                };

                // Funcție publică pentru butonul X — închide harta curentă
                window.iosfreeCloseMap = function () {
                    _removeOverlay();
                    var msg = _msgEl();
                    if (msg) msg.style.display = 'none';
                };
            }

            // Încarcă baza de date JSON
            function loadDatabase() {
                fetch('iosfree_db.json')
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        _iosDB = data;
                        window._iosDB = data;  // ← ADĂUGĂ ASTA
                        console.log('[Iosefină] Bază de date încărcată cu', Object.keys(data).length, 'localități');
                        _init();
                    })
                    .catch(function (err) {
                        console.error('[Iosefină] Eroare la încărcarea bazei de date:', err);
                        _iosDB = {};
                        window._iosDB = {};  // ← ADĂUGĂ ASTA
                        _init();
                    });
            }

            // Pornește totul
            loadDatabase();

            // Verifică dacă funcția _showThumbnail există și este corectă
            function _showThumbnail(url, locality) {
                console.log('[Iosefină] _showThumbnail:', url, locality);
                var preview = _previewEl();
                if (!preview) return;

                var old = document.getElementById('iosfreeImg');
                if (old) old.remove();

                var wrapper = document.createElement('div');
                wrapper.style.cssText = 'width:100%;';

                var img = document.createElement('img');
                img.id = 'iosfreeImg';
                img.src = url;
                img.alt = locality;
                var opacity = (document.getElementById('iosfreeOpacitySlider') ?
                    document.getElementById('iosfreeOpacitySlider').value / 100 : 0.8);
                img.style.cssText = 'width:100%;display:block;object-fit:cover;cursor:pointer;border:none;opacity:' + opacity + ';';
                img.title = 'Harta Iosefină — ' + locality;
                img.onclick = function () {
                    if (typeof openIosfreeModal === 'function') openIosfreeModal(url, locality);
                };

                var caption = document.createElement('div');
                caption.style.cssText = 'font-size:0.68rem;color:rgba(168,216,160,0.7);margin-top:3px;';
                caption.innerHTML = '📜 ' + locality;

                wrapper.appendChild(img);
                wrapper.appendChild(caption);
                preview.appendChild(wrapper);
            }

            // ── Layer custom Leaflet cu rotație stabilă pe canvas ──
            var IOSFREE_ROTATION_DEG = -12; // grade, negativ = spre stânga

            L.RotatedImageOverlay = L.Layer.extend({
                initialize: function (url, bounds, options) {
                    this._url    = url;
                    this._bounds = bounds;
                    // Limitele inițiale — nu se modifică niciodată; dreptunghiul exterior e ancorat aici
                    this._initialBounds = L.latLngBounds(bounds.getSouthWest(), bounds.getNorthEast());
                    this._rotation = (options && options.rotation != null) ? options.rotation : 0;
                    this._opacity  = (options && options.opacity  != null) ? options.opacity  : 1;
                    this._pane     = (options && options.pane)    ? options.pane    : 'overlayPane';
                    this._locality = (options && options.locality) ? options.locality : '';
                    L.setOptions(this, options);
                },

                onAdd: function (map) {
                    this._map = map;
                    if (!this._canvas) {
                        this._canvas = document.createElement('canvas');
                        this._canvas.style.position = 'absolute';
                        this._canvas.style.pointerEvents = 'none';
                    }
                    var pane = map.getPane(this._pane) || map.getPanes().overlayPane;
                    pane.appendChild(this._canvas);

                    var self = this;
                    if (!this._img) {
                        this._img = new Image();
                        this._img.crossOrigin = 'anonymous';
                        this._img.onload = function () {
                            self._imgLoaded = true;
                            self._redraw();
                        };
                        this._img.src = this._url;
                    } else if (this._imgLoaded) {
                        this._redraw();
                    }

                    map.on('zoomstart', this._onZoomStart, this);
                    map.on('zoomend moveend viewreset', this._onZoomEnd, this);
                    return this;
                },

                onRemove: function (map) {
                    map.off('zoomstart', this._onZoomStart, this);
                    map.off('zoomend moveend viewreset', this._onZoomEnd, this);
                    if (this._canvas && this._canvas.parentNode) {
                        this._canvas.parentNode.removeChild(this._canvas);
                    }
                },

                setOpacity: function (opacity) {
                    this._opacity = opacity;
                    if (this._canvas) this._canvas.style.opacity = opacity;
                    return this;
                },

                setBounds: function (newBounds) {
                    this._bounds = newBounds;
                    this._redraw();
                    return this;
                },

                getElement: function () { return this._canvas; },

                _onZoomStart: function () {
                    if (this._canvas) this._canvas.style.display = 'none';
                },

                _onZoomEnd: function () {
                    if (this._canvas) this._canvas.style.display = '';
                    this._redraw();
                },

                _redraw: function () {
                    if (!this._map || !this._imgLoaded) return;

                    var map      = this._map;
                    var bounds   = this._bounds;
                    var initBounds = this._initialBounds || bounds;
                    var angleDeg = this._rotation;
                    var angleRad = angleDeg * Math.PI / 180;

                    // Centrul FIX al dreptunghiului exterior (nu se modifică la pan)
                    var initCenter   = initBounds.getCenter();
                    var initCenterPx = map.latLngToLayerPoint(initCenter);

                    // Centrul CURENT al imaginii (se modifică la pan)
                    var curCenter   = bounds.getCenter();
                    var curCenterPx = map.latLngToLayerPoint(curCenter);

                    // Dimensiunile imaginii din bounds-ul CURENT
                    var sw = map.latLngToLayerPoint(bounds.getSouthWest());
                    var ne = map.latLngToLayerPoint(bounds.getNorthEast());
                    var halfW = (ne.x - sw.x) / 2;
                    var halfH = (sw.y - ne.y) / 2;

                    // Dreptunghiul exterior: 3× dimensiunea imaginii
                    var rectHalfW = halfW * 3;
                    var rectHalfH = halfH * 3;

                    // Offset al imaginii față de centrul fix (în spațiu ecran)
                    var imgOffX = curCenterPx.x - initCenterPx.x;
                    var imgOffY = curCenterPx.y - initCenterPx.y;

                    // Conversia offset-ului din spațiu ecran în spațiu rotit (rotație inversă)
                    var cosA  =  Math.cos(angleRad);
                    var sinA  =  Math.sin(angleRad);
                    var imgOffXRot = imgOffX * cosA + imgOffY * sinA;
                    var imgOffYRot = -imgOffX * sinA + imgOffY * cosA;

                    // Bounding box: colțurile AMBELOR forme în spațiu ecran (față de initCenterPx)
                    function rotatedCornersAt(hw, hh, ox, oy) {
                        return [
                            { x: -hw + ox, y: -hh + oy },
                            { x:  hw + ox, y: -hh + oy },
                            { x:  hw + ox, y:  hh + oy },
                            { x: -hw + ox, y:  hh + oy }
                        ].map(function (c) {
                            return {
                                x: c.x * Math.cos(angleRad) - c.y * Math.sin(angleRad),
                                y: c.x * Math.sin(angleRad) + c.y * Math.cos(angleRad)
                            };
                        });
                    }

                    var rectCorners = rotatedCornersAt(rectHalfW, rectHalfH, 0, 0);
                    var imgCorners  = rotatedCornersAt(halfW, halfH, imgOffXRot, imgOffYRot);
                    var allCorners  = rectCorners.concat(imgCorners);

                    var pad = 4;
                    var minX = Math.min.apply(null, allCorners.map(function(c){return c.x;})) - pad;
                    var maxX = Math.max.apply(null, allCorners.map(function(c){return c.x;})) + pad;
                    var minY = Math.min.apply(null, allCorners.map(function(c){return c.y;})) - pad;
                    var maxY = Math.max.apply(null, allCorners.map(function(c){return c.y;})) + pad;

                    var MAX_CANVAS = 8192;
                    var cW = Math.min(Math.ceil(maxX - minX), MAX_CANVAS);
                    var cH = Math.min(Math.ceil(maxY - minY), MAX_CANVAS);

                    var canvas = this._canvas;
                    canvas.width  = cW;
                    canvas.height = cH;
                    canvas.style.opacity = this._opacity;

                    // Canvas ancorat față de initCenterPx (dreptunghiul nu se mișcă)
                    canvas.style.left = (initCenterPx.x + minX) + 'px';
                    canvas.style.top  = (initCenterPx.y + minY) + 'px';

                    var ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, cW, cH);
                    ctx.save();

                    // Origine = centrul FIX (initCenterPx) în coordonate canvas
                    ctx.translate(-minX, -minY);
                    ctx.rotate(angleRad);

                    // 1. Dreptunghi exterior — ANCORAT la origine (nu se mișcă)
                    ctx.strokeStyle = 'rgba(160, 160, 160, 0.5)';
                    ctx.lineWidth   = 2;
                    ctx.setLineDash([10, 6]);
                    ctx.strokeRect(-rectHalfW, -rectHalfH, rectHalfW * 2, rectHalfH * 2);

                    // 2. Imaginea hărții — offset față de centrul fix
                    ctx.setLineDash([]);
                    ctx.globalAlpha = 1;
                    ctx.drawImage(this._img,
                        -halfW + imgOffXRot, -halfH + imgOffYRot,
                        halfW * 2, halfH * 2);

                    ctx.restore();
                }
            });

            L.rotatedImageOverlay = function (url, bounds, options) {
                return new L.RotatedImageOverlay(url, bounds, options);
            };

            // Asigură-te că _placeOnMap folosește pane-ul corect
            function _placeOnMap(imageUrl, locality, bounds) {
                if (!window._dlMap) return;

                var map = window._dlMap;

                if (!map.getPane('iosfreePane')) {
                    map.createPane('iosfreePane');
                    map.getPane('iosfreePane').style.zIndex = 1000;
                    console.log('[Iosefină] Pane creat din _placeOnMap');
                }

                _removeOverlay();

                var opacity = (document.getElementById('iosfreeOpacitySlider') ?
                    document.getElementById('iosfreeOpacitySlider').value / 100 : 0.8);

                console.log('[Iosefină] Crează overlay rotit cu imaginea:', imageUrl);

                _currentOverlay = L.rotatedImageOverlay(imageUrl, bounds, {
                    opacity:  opacity,
                    rotation: IOSFREE_ROTATION_DEG,
                    pane:     'iosfreePane',
                    locality: locality
                }).addTo(map);

                _currentLocality = locality;
                window._iosfreeCurrentOverlay = _currentOverlay;
                window._iosfreeCurrentBounds  = bounds;

                // Arată butoanele de pan din panel, ascunde Search
                var panelBtns = document.getElementById('iosfreePanelBtns');
                if (panelBtns) panelBtns.style.display = '';
                var searchBtn = document.getElementById('iosfreeSearchBtn');
                if (searchBtn) searchBtn.style.display = 'none';

                // Populează mini-previzualizarea din widget-ul de navigare
                var panPreview = document.getElementById('iosfreePanPreview');
                if (panPreview) {
                    panPreview.innerHTML = '';
                    var thumb = document.createElement('img');
                    thumb.src = imageUrl;
                    thumb.alt = locality;
                    thumb.style.cssText = 'width:100%;display:block;border-radius:3px;';
                    panPreview.appendChild(thumb);
                }

                // ========== NOU: Dacă toggle-ul Historical Maps e OFF, ascunde overlay-ul ==========
                var histToggle = document.getElementById('histToggle');
                if (histToggle && !histToggle.checked) {
                    map.removeLayer(_currentOverlay);
                }

                console.log('[Iosefină] Overlay rotit plasat cu succes, bounds:', bounds);
            }

        })();
