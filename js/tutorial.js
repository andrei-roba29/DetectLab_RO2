/* ──────────────────────────────────────────────────────────────
   DetectLab — Mini tutorial (slides)
   ------------------------------------------------------------
   A "?" button in the top-right corner of the map opens a 6-slide
   walkthrough drawn on top of the live UI:

     1. arrows + explanations for every button on the LEFT side
     2. arrows + explanations for detection / storage / account
        (PWA floating controls; falls back to the desktop .map-controls row)
     3. the Friends panel: unified people search, requests and chats
        (opened automatically for signed-in users, like the layers panel)
     4. the layers panel: on/off switch, opacity slider, the vertical
        slider on the map, the neon-green "visible on screen" frame
     5. the layer catalogue with GRATIS / PREMIUM tabs
     6. tips for optimal performance

   Everything is purple with a transparent, blurred background.
   Targets are resolved at runtime from the real DOM, so the guide
   automatically adapts to whichever controls exist (PWA vs desktop).
   ────────────────────────────────────────────────────────────── */
(function () {
    'use strict';

    // ── i18n helpers ─────────────────────────────────────────────
    function lang() {
        try {
            if (typeof window._currentLang === 'function') {
                var l = window._currentLang();
                return l === 'en' ? 'en' : 'ro';
            }
        } catch (e) { /* storage/priv mode */ }
        return 'ro';
    }

    function tr(o) {
        if (o == null) return '';
        if (typeof o === 'string') return o;
        return o[lang()] || o.ro || o.en || '';
    }

    var UI = {
        help_title:  { ro: 'Ghid rapid', en: 'Quick guide' },
        prev:        { ro: 'Înapoi', en: 'Back' },
        next:        { ro: 'Înainte', en: 'Next' },
        close:       { ro: 'Închide ghidul', en: 'Close guide' },
        finish:      { ro: 'Am înțeles', en: 'Got it' },
        hint:        { ro: 'Atinge oriunde pentru slide-ul următor', en: 'Tap anywhere for the next slide' },
        free_tab:    { ro: 'GRATIS', en: 'FREE' },
        prem_tab:    { ro: 'PREMIUM', en: 'PREMIUM' }
    };

    // ── Slide definitions ────────────────────────────────────────
    // `sel` may be a CSS selector or an array of selectors (first match wins).
    var STEPS = [
        {
            id: 'left',
            title: { ro: 'Butoanele din stânga', en: 'The left-side buttons' },
            type: 'targets',
            placement: 'right',
            targets: [
                {
                    sel: '#detectlab-map .leaflet-control-zoom',
                    title: { ro: 'Zoom + / −', en: 'Zoom + / −' },
                    desc: {
                        ro: 'Mărește sau micșorează harta. Unele straturi apar doar de la un anumit nivel de zoom.',
                        en: 'Zoom the map in or out. Some layers only appear from a certain zoom level.'
                    }
                },
                {
                    sel: '#btnLiveLocation',
                    title: { ro: 'Locația mea', en: 'My location' },
                    desc: {
                        ro: 'Pornește / oprește urmărirea GPS în timp real și centrează harta pe poziția ta. Pe site, butonul stă în coloana din stânga; în aplicația instalată îl găsești separat, în dreapta-jos. Nu mai există meniul de cont din bara de jos. Locația live poate porni și din comutatorul Detectare sau din lupa „Detectoriști din zonă”.',
                        en: 'Start / stop real-time GPS tracking and centre the map on your position. On the website, the button is in the left-hand column; in the installed app it appears separately at the bottom-right. The account menu is no longer in a bottom bar. Live location can also start from the Detect switch or the "Detectorists nearby" magnifier.'
                    }
                },
                {
                    sel: '#btnMeasure',
                    title: { ro: 'Măsurare distanță', en: 'Measure distance' },
                    desc: {
                        ro: 'Atinge puncte pe hartă și afli distanța dintre ele (m / km). Apasă din nou pentru a opri.',
                        en: 'Tap points on the map to get the distance between them (m / km). Press again to stop.'
                    }
                },
                {
                    sel: '#btnCoord',
                    title: { ro: 'Coordonate', en: 'Coordinates' },
                    desc: {
                        ro: 'Alege un punct pe hartă și îi vezi coordonatele exacte; le poți copia, salva ca pin sau crea un eveniment din el.',
                        en: 'Pick a point on the map to see its exact coordinates; you can copy them, save them as a pin, or create an event from it.'
                    }
                },
                {
                    sel: '#btnTrack',
                    title: { ro: 'Înregistrare traseu', en: 'Record trail' },
                    desc: {
                        ro: 'Înregistrează pe hartă traseul parcurs pe teren, cu distanța și durata sesiunii.',
                        en: 'Record the trail you walk in the field on the map, with distance and session time.'
                    }
                },
                {
                    sel: '#btnOfflineMaps',
                    title: { ro: 'Hărți offline', en: 'Offline maps' },
                    desc: {
                        ro: 'Activează butonul, desenează un poligon de maximum 100 km², alege straturile disponibile, nivelul de zoom și descarcă-le pentru teren fără internet. Închide poligonul atingând primul punct sau apăsând „Finalizează”; dacă nu e mulțumit de formă, alege „Desenează alt poligon”. Cât timp o hartă offline e activă, un ✕ centrat jos o dezactivează.',
                        en: 'Activate the button, draw a polygon of up to 100 km², choose the available layers and the zoom level, then download them for use without internet. Close the polygon by tapping its first corner or pressing “Finish”; if the shape is not right, press “Draw another polygon”. While an offline map is active, a centred ✕ at the bottom leaves it.'
                    }
                },
                {
                    sel: '#detectlab-map .detectlab-compass',
                    title: { ro: 'Busolă', en: 'Compass' },
                    desc: {
                        ro: 'Arată nordul și urmărește rotirea hărții. Atinge busola ca să readuci harta la nord (0°), sau trage de ea la stânga/dreapta ca s-o rotești — exact ca în Google Earth. Nu există blocare a rotirii. În aplicația instalată, sub busolă găsești și comutatorul Detectare.',
                        en: 'Shows north and follows the map as it turns. Tap the compass to bring the map back to north (0°), or drag it left/right to rotate the view — just like Google Earth. There is no rotation lock. In the installed app, the Detect switch sits under the compass too.'
                    }
                }
            ],
            notes: [
                {
                    ico: '📅',
                    text: {
                        ro: '<b>Creare eveniment:</b> cu butonul Coordonate (sau dintr-un pin salvat) marchezi un punct, apoi apeși „Creează un eveniment”. Poți face evenimentul public sau anonim (cu cod de invitație).',
                        en: '<b>Create an event:</b> with the Coordinates button (or from a saved pin) mark a point, then tap “Create event”. You can make it public or anonymous (with an invite code).'
                    }
                },
                {
                    ico: '🎟',
                    text: {
                        ro: '<b>Participare la evenimente:</b> evenimentele publice apar pe hartă ca un coif — atinge-l și trimite o cerere de participare. Pentru evenimente anonime, deschide Contul tău → Evenimente și introdu codul primit.',
                        en: '<b>Join events:</b> public events appear on the map as a helmet — tap it and send a join request. For anonymous events, open Your account → Events and enter the code you were given.'
                    }
                }
            ]
        },
        {
            id: 'bottom',
            title: { ro: 'Detectare, stocare și cont', en: 'Detection, storage & account' },
            type: 'targets',
            placement: 'top',
            targets: [
                {
                    sel: ['#pwaDetectBtn', '#detectWrap'],
                    title: { ro: 'Detectare activitate', en: 'Activity detection' },
                    desc: {
                        ro: 'Te avertizează în timp real când te apropii de un sit arheologic sau de zona lui de protecție. În aplicația instalată, comutatorul e sub busolă, stânga-jos.',
                        en: 'Get real-time warnings when you approach an archaeological site or its protection zone. In the installed app, the switch sits under the compass, at the bottom-left.'
                    }
                },
                {
                    sel: '#savedLocationsBtn',
                    title: { ro: 'Locații salvate', en: 'Saved locations' },
                    desc: {
                        ro: 'Deschide lista coordonatelor salvate; atinge una și harta sare direct la ea. Aici găsești și categoria „Hărți offline”, de unde activezi sau ștergi hărțile salvate local.',
                        en: 'Open the list of saved coordinates; tap one and the map jumps straight to it. This button also contains “Offline maps”, where you activate or delete maps saved locally.'
                    }
                },
                {
                    sel: ['#pwaNearbyBtn', '#nearbyDetectorsBtn'],
                    title: { ro: 'Detectoriști din zonă', en: 'Detectorists nearby' },
                    desc: {
                        ro: 'Vezi ceilalți detectoriști activi în apropiere. Lupa pornește doar locația live — nu îți aprinde și comutatorul Detectare; ca să fii și tu de văzut pentru ceilalți, e de ajuns locația live plus răspunsul „Da” la întrebarea de vizibilitate. În aplicația instalată, butonul cu lupă stă în coloana de iconițe din stânga hărții. Atinge un pin și, din cartonașul lui, poți trimite o cerere de prietenie cu „＋ Adaugă prieten”.',
                        en: 'See other detectorists active nearby. The magnifier starts the live location only — it never switches your Detect mode on; to be visible to the others as well, live location plus the "Yes" answer to the visibility prompt is enough. In the installed app, the magnifier button sits in the icon column on the left of the map. Tap a pin and, from its card, you can send a friend request with "＋ Add friend".'
                    }
                },
                {
                    // The account menu used to be the "AN" / initials button of
                    // the removed PWA bottom bar (#pwaUserItem). It now only
                    // exists in the website's top nav, so the guide points at
                    // that pill and is skipped inside the installed app.
                    sel: ['#navUser', '#pwaUserItem'],
                    title: { ro: 'Contul tău', en: 'Your account' },
                    desc: {
                        ro: 'Autentificare, administrarea contului și a abonamentului, evenimente și delogare, plus Limbă (română / engleză), Stocare (pin-uri, trasee și hărți salvate) și intrarea spre Prieteni (căutare, cereri, chat). Meniul contului stă în bara de sus a site-ului; în aplicația instalată a fost scos din dreapta-jos. Butonul 🎯 din dreapta-jos pornește doar locația live, nu deschide meniul contului.',
                        en: 'Log in, manage your account and subscription, events and log out, plus Language (Romanian / English), Storage (pins, trails and saved maps) and the entry to Friends (search, requests, chat). The account menu lives in the website\'s top bar and is not available from the installed app. Its bottom-right 🎯 button controls live location only; it does not open the account menu.'
                    }
                },
                {
                    sel: '#fullscreenBtn',
                    title: { ro: 'Ecran complet', en: 'Full screen' },
                    desc: {
                        ro: 'Extinde harta pe tot ecranul.',
                        en: 'Expand the map to the full screen.'
                    }
                }
            ]
        },
        {
            id: 'friends',
            title: { ro: 'Prieteni', en: 'Friends' },
            type: 'targets',
            placement: 'below',
            openFriends: true,
            requiresAuth: true,
            authNote: {
                ro: 'Panoul Prieteni apare după autentificare. Din meniul contului deschizi Prieteni: cauți detectoriști după nume, e-mail sau localitate (merge și parțial, fără diacritice), trimiți cereri de prietenie și discuți pe chat.',
                en: 'The Friends panel appears after you sign in. From the account menu you open Friends: search detectorists by name, e-mail or place (partial works, diacritics optional), send friend requests and chat.'
            },
            targets: [
                {
                    sel: '#frSearchInput',
                    title: { ro: 'Caută detectoriști', en: 'Search detectorists' },
                    desc: {
                        ro: 'Caută după nume, e-mail, localitate sau ID: merge și parțial („mihai” îl găsește pe Mihai), fără diacritice („muresan” îl găsește pe Mureșan), iar la mai multe cuvinte fiecare trebuie potrivită undeva („ana cluj”).',
                        en: 'Search by name, e-mail, place or id: partial works (“mihai” finds Mihai), diacritics are optional (“muresan” finds Mureșan), and with several words each must match somewhere (“ana cluj”).'
                    }
                },
                {
                    sel: '#frCountySelect',
                    title: { ro: 'Filtru județ', en: 'County filter' },
                    desc: {
                        ro: 'Restrânge rezultatele căutării la un singur județ.',
                        en: 'Narrow the search results to a single county.'
                    }
                },
                {
                    sel: '#friendsManagerPanel .fr-tab[data-tab="friends"]',
                    title: { ro: 'Prietenii tăi', en: 'Your friends' },
                    desc: {
                        ro: 'Lista prietenilor tăi, cu butonul de chat pentru fiecare. Căutarea de detectoriști are acum propriul ei tab, „Caută prieteni”.',
                        en: 'Your friend list, with a chat button for each. Searching for detectorists now has its own tab, “Search friends”.'
                    }
                },
                {
                    sel: '#friendsManagerPanel .fr-tab[data-tab="requests"]',
                    title: { ro: 'Cereri', en: 'Requests' },
                    desc: {
                        ro: 'Aici accepți sau refuzi cererile primite și vezi cererile trimise de tine.',
                        en: 'Accept or decline incoming requests here, and see the ones you sent.'
                    }
                },
                {
                    sel: '#friendsManagerPanel .fr-tab[data-tab="chats"]',
                    title: { ro: 'Chat-uri', en: 'Chats' },
                    desc: {
                        ro: 'Discuții private cu prietenii și grupuri. Din cartonașul unui detectorist de pe hartă ajungi direct la chat cu „💬 Trimite mesaj”.',
                        en: 'Private chats with friends and groups. From a detectorist’s map card you jump straight to chat with “💬 Send message”.'
                    }
                }
            ]
        },
        {
            id: 'layers',
            title: { ro: 'Panoul cu straturi', en: 'The layers panel' },
            type: 'targets',
            placement: 'left',
            openPanel: true,
            targets: [
                {
                    sel: ['#transpPanel .transp-layer-row.active .apm-toggle-switch', '#transpPanel .apm-toggle-switch'],
                    title: { ro: 'Switch ON / OFF', en: 'ON / OFF switch' },
                    desc: {
                        ro: 'Pornește sau oprește afișarea stratului pe hartă.',
                        en: 'Turn the layer on or off on the map.'
                    }
                },
                {
                    sel: ['#apmOpacitySlider', '#transpPanel .transp-slider'],
                    title: { ro: 'Slider de opacitate', en: 'Opacity slider' },
                    desc: {
                        ro: 'Reglează transparența stratului, de la 0% la 100%, ca să vezi și ce e dedesubt.',
                        en: 'Adjust the layer transparency from 0% to 100% so you can see what lies beneath.'
                    }
                }
            ],
            notes: [
                {
                    ico: '↕',
                    text: {
                        ro: '<b>Slider vertical pe hartă:</b> dacă apeși pe un strat, sliderul lui de opacitate apare vertical peste hartă, ca să reglezi transparența fără să acoperi zona studiată.',
                        en: '<b>Vertical slider on the map:</b> tapping a layer moves its opacity slider onto the map, vertically, so you can adjust it without covering the area you are studying.'
                    }
                },
                {
                    ico: '<span class="dl-tut-swatch"></span>',
                    text: {
                        ro: '<b>Încadrare verde:</b> fiecare strat care are acoperire pe ecran în acel moment este încadrat cu verde neon — așa știi imediat ce straturi îți sunt utile în zona vizibilă.',
                        en: '<b>Green frame:</b> every layer that has coverage on the current screen is framed in neon green — so you instantly know which layers are useful for the visible area.'
                    }
                }
            ]
        },
        {
            id: 'catalog',
            title: { ro: 'Straturile disponibile', en: 'Available layers' },
            type: 'catalog'
        },
        {
            id: 'performance',
            title: { ro: 'Sfaturi pentru performanță optimă', en: 'Tips for optimal performance' },
            type: 'performance'
        }
    ];

    // ── Layer catalogue (slide 4) ────────────────────────────────
    var CATALOG = {
        free: [
            {
                name: { ro: 'APM Layer', en: 'APM Layer' },
                desc: {
                    ro: 'Model de predicție arheologică bazat pe factori de mediu întâlniți în toate așezările antice încă de la începutul timpurilor. (vezi pe site legenda de culori)',
                    en: 'Archaeological prediction model based on environmental factors found in every ancient settlement since the dawn of time. (see the colour legend on the website)'
                }
            },
            {
                name: { ro: 'Satelit', en: 'Satellite' },
                desc: { ro: 'Stratul de bază.', en: 'The base layer.' }
            },
            {
                name: { ro: 'Localități OSM', en: 'OSM Places' },
                desc: { ro: 'Denumirile localităților.', en: 'The names of the localities.' }
            },
            {
                name: { ro: 'UAT', en: 'UAT' },
                desc: { ro: 'Unități administrativ teritoriale.', en: 'Administrative-territorial units.' }
            },
            {
                name: { ro: 'Patrimoniu', en: 'Heritage' },
                desc: {
                    ro: 'Situri arheologice CIMEC sincronizate zilnic cu baza noastră de date + zona de protecție.',
                    en: 'CIMEC archaeological sites synchronised daily with our database + the protection zone.'
                }
            },
            {
                name: { ro: 'Hărți istorice', en: 'Historical Maps' },
                desc: {
                    ro: 'Conține hărți istorice cu acoperire completă a României + harta Iosefină gratuită care conține foi — când e apăsat butonul „Caută aici” se furnizează foaia aferentă localității văzute pe hartă și se poate alinia corect folosind săgețile.',
                    en: 'Contains historical maps with full coverage of Romania + the free Josephine map made of sheets — pressing the “Search here” button delivers the sheet matching the locality shown on the map, and it can be aligned correctly using the arrows.'
                }
            },
            {
                name: { ro: 'LIDAR', en: 'LIDAR' },
                desc: {
                    ro: 'Light Detection and Ranging — strat laser ce pătrunde prin vegetație și este una dintre cele mai puternice unelte pentru arheologie (conține mai multe straturi de diferite rezoluții și pentru diferite zone).',
                    en: 'Light Detection and Ranging — a laser layer that penetrates vegetation and is one of the most powerful tools in archaeology (it contains several layers of different resolutions and for different areas).'
                }
            },
            {
                name: { ro: 'Hărți offline', en: 'Offline maps' },
                desc: {
                    ro: 'Desenează o zonă de maximum 100 km², alege straturile disponibile și descarcă tile-urile pe dispozitiv. Harta expiră automat după 10 zile; în butonul cu card SD apare categoria Hărți offline.',
                    en: 'Draw an area of up to 100 km², choose the available layers and download their tiles to the device. The map expires automatically after 10 days; the SD-card button contains the Offline maps category.'
                }
            }
        ],
        premium: [
            {
                name: { ro: 'Biblioteca din Babel', en: 'Library of Babel' },
                desc: {
                    ro: 'Returnează informații istorice despre localități.',
                    en: 'Returns historical information about localities.'
                }
            },
            {
                name: { ro: 'APM 2.0', en: 'APM 2.0' },
                desc: {
                    ro: 'Model de predicție arheologică bazat pe factori de mediu întâlniți în toate așezările antice încă de la începutul timpurilor. Spre deosebire de APM, folosește informații mult mai precise. Butonul „Ajutor de căutare” / „Search help” poligonizează automat zonele cu cel mai ridicat potențial.',
                    en: 'Archaeological prediction model based on environmental factors found in every ancient settlement since the dawn of time. Unlike APM, it uses far more precise data. The “Search help” button automatically polygonises the areas with the highest potential.'
                }
            },
            {
                name: { ro: 'Imperiul roman', en: 'Roman Empire' },
                desc: {
                    ro: 'Conține toată rețeaua de drumuri imperiale de pe teritoriul României, cât și alte repere importante, precum vile romane, castre, cariere etc.',
                    en: 'Contains the entire network of imperial roads on Romanian territory, as well as other important landmarks such as Roman villas, forts, quarries, etc.'
                }
            },
            {
                name: { ro: 'Bătălii', en: 'Battles' },
                desc: {
                    ro: 'Conține cele mai importante conflicte militare de pe teritoriul României, începând cu sec. VIII î.Hr. până în prezent (folosește sliderul pentru a schimba secolul).',
                    en: 'Contains the most important military conflicts on Romanian territory, from the 8th century BC to the present day (use the slider to change the century).'
                }
            },
            {
                name: { ro: 'Hărți istorice', en: 'Historical maps' },
                desc: {
                    ro: 'Conține hărți istorice atât cu acoperire zonală, cât și totală a României.',
                    en: 'Contains historical maps with both regional and country-wide coverage of Romania.'
                }
            },
            {
                name: { ro: 'Imagini satelitare anii ’60', en: "Satellite imagery 60's" },
                desc: {
                    ro: 'Conține imagini aeriene din anii ’60 cu acoperire parțială a României.',
                    en: 'Contains aerial imagery from the 1960s with partial coverage of Romania.'
                }
            },
            {
                name: { ro: 'LIDAR Scanner', en: 'LIDAR Scanner' },
                desc: {
                    ro: 'Scanează și categorizează anomalii satelitare (alege un punct pe hartă și o arie de căutare, apoi apasă pe butonul de scanare).',
                    en: 'Scans and categorises satellite anomalies (pick a point on the map and a search area, then press the scan button).'
                }
            },
            {
                name: { ro: 'Zone cu potențial arheologic', en: 'Archaeological Potential Sites' }, // reproduces existing UI button spelling (Archeological)
                desc: {
                    ro: 'Se folosește de siturile arheologice existente pentru a triangula și a descoperi zone din proximitatea siturilor cu potențial arheologic (fiecărei zone îi este atribuit un scor).',
                    en: 'Uses the existing archaeological sites to triangulate and discover zones with archaeological potential in their proximity (each zone gets a score).'
                }
            },
            {
                name: { ro: 'Raport arheologic', en: 'Archaeological Report' }, // reproduces existing UI button spelling (Archeological)
                desc: {
                    ro: 'Returnează până la 3 zone cu potențial arheologic, făcând o medie ponderată între rezultatele straturilor APM 2.0, Zone cu potențial arheologic, LIDAR Scanner și Imperiul Roman. Rezultatul final poate fi descărcat ca PDF cu explicații detaliate.',
                    en: 'Returns up to 3 zones with archaeological potential by computing a weighted average of the results from the APM 2.0, Archaeological Potential Sites, LIDAR Scanner and Roman Empire layers. The final result can be downloaded as a PDF with detailed explanations.'
                }
            }
        ]
    };

    var PERF = {
        title: { ro: 'Sfaturi pentru performanță optimă', en: 'Tips for optimal performance' },
        body: {
            ro: 'Straturi precum <b>LIDAR</b> sau <b>Imagini satelitare anii ’60</b> sunt servite de pe web ca servicii <b>WMS</b> și sunt niște straturi foarte dense și detaliate care, deservite simultan, pot bloca temporar aplicația.',
            en: 'Layers such as <b>LIDAR</b> or <b>Satellite imagery 60\'s</b> are served from the web as <b>WMS</b> services and are very dense, highly detailed layers which, when served simultaneously, can temporarily freeze the app.'
        },
        tip: {
            ro: 'Recomandăm ca aceste straturi să fie activate <b>pe rând</b>, pentru cea mai bună experiență posibilă.',
            en: 'We recommend enabling these layers <b>one at a time</b>, for the best possible experience.'
        }
    };

    // ── Slide transition timing ──────────────────────────────────
    // The outgoing slide fades/slides out first, then the incoming one
    // fades/slides in from the opposite side — no hard cut between slides.
    var LEAVE_MS = 170;   // must stay in sync with .dl-tut-leaving (css/tutorial.css)
    var PANEL_MAX_WAIT = 420;

    function reduceMotion() {
        try {
            return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) { return false; }
    }

    // ── State ────────────────────────────────────────────────────
    var state = {
        open: false,
        idx: 0,
        tab: 'free',
        openedPanel: false,
        panelTabRestore: null,
        openedFriends: false,
        // Transition bookkeeping:
        seq: 0,            // invalidates pending timeouts when the user moves fast
        quiet: false,      // repaint in place (no entrance animation) — resize etc.
        panelOpening: false,
        friendsOpening: false,
        suppressTap: false // a swipe just navigated — ignore the tap that follows
    };

    var root = null, scrim = null, svg = null, stage = null,
        bar = null, dots = null, titleEl = null,
        btnPrev = null, btnNext = null;

    // ── Small DOM helpers ────────────────────────────────────────
    function el(tag, cls, parent) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (parent) parent.appendChild(n);
        return n;
    }

    function svgEl(tag, parent) {
        var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
        if (parent) parent.appendChild(n);
        return n;
    }

    function pick(sel) {
        var list = Array.isArray(sel) ? sel : [sel];
        for (var i = 0; i < list.length; i++) {
            var n;
            try { n = document.querySelector(list[i]); } catch (e) { n = null; }
            if (n && isVisible(n)) return n;
        }
        return null;
    }

    function isVisible(n) {
        if (!n) return false;
        var r = n.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        var st = window.getComputedStyle(n);
        if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.05) return false;
        if (n.closest && n.closest('.auth-hidden')) return false;
        return true;
    }

    function vw() { return window.innerWidth || document.documentElement.clientWidth; }
    function vh() { return window.innerHeight || document.documentElement.clientHeight; }

    function isPwa() {
        return !!(document.body && document.body.classList.contains('is-pwa'));
    }

    var TUTORIAL_VIDEO_URL = 'https://pub-638f9319d3994d9ba6b7c4ce178867fd.r2.dev/Tutorial.mp4';

    function stopTutorialVideo() {
        var v = document.getElementById('dlTutVideo');
        if (!v) return;
        try { v.pause(); } catch (e) { /* ignore */ }
    }

    // ── Overlay construction ─────────────────────────────────────
    function build() {
        if (root) return;

        root = el('div', 'dl-tut');
        root.id = 'dlTutorial';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');

        scrim = el('div', 'dl-tut-scrim', root);

        svg = svgEl('svg', root);
        svg.setAttribute('class', 'dl-tut-arrows');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

        stage = el('div', 'dl-tut-stage', root);
        stage.style.cssText = 'position:absolute;inset:0;pointer-events:none;';

        bar = el('div', 'dl-tut-bar', root);

        btnPrev = el('button', 'dl-tut-nav-btn', bar);
        btnPrev.type = 'button';
        btnPrev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 5 8 12 15 19"/></svg>';
        btnPrev.addEventListener('click', function (e) { e.stopPropagation(); go(state.idx - 1); });

        dots = el('div', 'dl-tut-dots', bar);

        btnNext = el('button', 'dl-tut-nav-btn', bar);
        btnNext.type = 'button';
        btnNext.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>';
        btnNext.addEventListener('click', function (e) { e.stopPropagation(); go(state.idx + 1); });

        el('div', 'dl-tut-sep', bar);

        var btnClose = el('button', 'dl-tut-nav-btn dl-tut-close', bar);
        btnClose.type = 'button';
        btnClose.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 2L12 12M12 2L2 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
        btnClose.addEventListener('click', function (e) { e.stopPropagation(); close(); });

        titleEl = el('div', 'dl-tut-title', root);

        STEPS.forEach(function (s, i) {
            var d = el('button', 'dl-tut-dot', dots);
            d.type = 'button';
            d.addEventListener('click', function (e) { e.stopPropagation(); go(i); });
        });

        initSwipe();

        // Advance when tapping the empty (blurred) area.
        scrim.addEventListener('click', function (e) {
            e.stopPropagation();
            if (state.suppressTap) return;   // the gesture already moved us
            go(state.idx + 1);
        });

        // Never let a click inside the guide reach the page underneath
        // (the layers panel closes itself on any outside click).
        root.addEventListener('click', function (e) { e.stopPropagation(); }, false);
        root.addEventListener('mousedown', function (e) { e.stopPropagation(); }, false);
        root.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });

        document.body.appendChild(root);

        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        window.addEventListener('scroll', onResize, { passive: true });
        document.addEventListener('detectlab:langchange', function () {
            if (!state.open) return;
            state.quiet = false;
            render(0);
        });
        document.addEventListener('keydown', function (e) {
            if (!state.open) return;
            if (e.key === 'Escape') { close(); }
            else if (e.key === 'ArrowRight') { go(state.idx + 1); }
            else if (e.key === 'ArrowLeft') { go(state.idx - 1); }
        });
    }

    /* ── Swipe / drag between slides ──────────────────────────────
       Dragging the blurred area follows the finger and either snaps back or
       continues into a normal slide transition, so moving between slides
       never feels like a hard cut. */
    var SWIPE_MIN = 56;

    function initSwipe() {
        var sx = 0, sy = 0, dx = 0, active = false, decided = false;

        function paintDrag(px) {
            var k = 0.42;                       // rubber-band factor
            var op = String(Math.max(0.3, 1 - Math.abs(px) / 460));
            [stage, svg].forEach(function (n) {
                n.style.transition = 'none';
                n.style.transform = 'translateX(' + (px * k) + 'px)';
                n.style.opacity = op;
            });
        }

        function releaseDrag() {
            [stage, svg].forEach(function (n) {
                n.style.transition = '';
                n.style.transform = '';
                n.style.opacity = '';
            });
        }

        function reset() {
            if (!active) return;
            active = false;
            dx = 0;
            releaseDrag();
        }

        scrim.addEventListener('touchstart', function (e) {
            if (!state.open || !e.touches || e.touches.length !== 1) return;
            sx = e.touches[0].clientX;
            sy = e.touches[0].clientY;
            dx = 0;
            active = true;
            decided = false;
        }, { passive: true });

        scrim.addEventListener('touchmove', function (e) {
            if (!active || !e.touches || e.touches.length !== 1) return;
            var mx = e.touches[0].clientX - sx;
            var my = e.touches[0].clientY - sy;
            if (!decided) {
                if (Math.abs(mx) < 12 && Math.abs(my) < 12) return;
                if (Math.abs(my) > Math.abs(mx)) { active = false; return; }  // vertical scroll
                decided = true;
            }
            dx = mx;
            paintDrag(mx);
        }, { passive: true });

        scrim.addEventListener('touchend', function () {
            if (!active) return;
            var moved = dx;
            active = false;
            dx = 0;
            if (decided && Math.abs(moved) > SWIPE_MIN) {
                state.suppressTap = true;
                var dir = moved < 0 ? 1 : -1;    // swipe left → next slide
                releaseDrag();                   // hand the position back to CSS
                go(state.idx + dir);
                setTimeout(function () { state.suppressTap = false; }, 380);
            } else {
                reset();
            }
        }, { passive: true });

        scrim.addEventListener('touchcancel', reset, { passive: true });
    }

    var resizeTimer = null;
    function onResize() {
        if (!state.open || root.classList.contains('dl-tut-closing')) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            // Quiet repaint: the slide is already on screen, re-running the
            // entrance animation on every resize frame would only flicker.
            state.quiet = true;
            render(0);
        }, 120);
    }

    // ── Layers panel handling (slide 3) ──────────────────────────
    function panelIsOpen() {
        var p = document.getElementById('transpPanel');
        return !!(p && p.classList.contains('open'));
    }

    function ensurePanel(open) {
        var p = document.getElementById('transpPanel');
        if (!p) return;
        if (open && !panelIsOpen()) {
            if (typeof window.toggleTranspPanel === 'function') {
                window.toggleTranspPanel();
                state.openedPanel = true;
                state.panelOpening = true;
            }
            // The guide always demonstrates on the free tab (APM Layer row).
            var freeTab = document.querySelector('.transp-panel-tabs .tab-btn.active');
            state.panelTabRestore = freeTab ? freeTab.getAttribute('data-tab') : null;
            if (state.panelTabRestore && state.panelTabRestore !== 'free' &&
                typeof window.switchLayerTab === 'function') {
                window.switchLayerTab('free');
            }
        } else if (!open && state.openedPanel) {
            if (typeof window.toggleTranspPanel === 'function') window.toggleTranspPanel();
            state.openedPanel = false;
            state.panelOpening = false;
            if (state.panelTabRestore && state.panelTabRestore !== 'free' &&
                typeof window.switchLayerTab === 'function') {
                window.switchLayerTab(state.panelTabRestore);
            }
            state.panelTabRestore = null;
        }
    }

    /* The layers panel slides in with its own 0.35s transition — measuring
       the controls before it lands produces rings that sit in the wrong
       place and then jump. Wait for the panel to settle (with a hard cap so
       the guide can never get stuck on an invisible slide). */
    function whenPanelSettled(cb) {
        var p = document.getElementById('transpPanel');
        var fired = false, timer = null;

        function fire() {
            if (fired) return;
            fired = true;
            state.panelOpening = false;
            if (timer) clearTimeout(timer);
            if (p) p.removeEventListener('transitionend', onEnd);
            try { cb(); } catch (e) { /* keep the guide usable no matter what */ }
        }

        function onEnd(e) {
            if (!p || e.target !== p) return;
            var prop = e.propertyName || '';
            if (prop && prop.indexOf('transform') === -1) return;
            fire();
        }

        if (p) p.addEventListener('transitionend', onEnd);
        timer = setTimeout(fire, PANEL_MAX_WAIT);
    }

    // ── Friends panel handling (slide 3) ─────────────────────────
    function signedIn() {
        try {
            var u = (typeof window._authUser === 'function') ? window._authUser() : null;
            return !!(u && u.id);
        } catch (e) { return false; }
    }

    function friendsPanelIsOpen() {
        return !!document.getElementById('friendsManagerPanel');
    }

    /* Mirrors ensurePanel(): the guide demonstrates on the friends search tab
       (the search bar the first arrow points at lives there since the panel
       split „Caută prieteni” / „Prietenii tăi”), and only ever closes a panel
       it opened itself. Signed-out visitors never get openFriends() called on
       them — that would pop the auth modal over the guide; they see the
       step's authNote instead. */
    function ensureFriends(open) {
        if (open && !friendsPanelIsOpen()) {
            if (!signedIn()) return;
            if (typeof window.openFriends === 'function') {
                window.openFriends('search');
                state.openedFriends = true;
                state.friendsOpening = true;
            }
        } else if (open && friendsPanelIsOpen()) {
            try {
                var tab = document.querySelector('#friendsManagerPanel .fr-tab[data-tab="search"]');
                if (tab && typeof tab.click === 'function') tab.click();
            } catch (e) { /* keep the guide usable no matter what */ }
        } else if (!open && state.openedFriends) {
            if (typeof window._closeFriendsPanel === 'function') window._closeFriendsPanel();
            state.openedFriends = false;
            state.friendsOpening = false;
        }
    }

    /* openFriends() renders after its async refreshAll() lands, so — unlike
       the layers panel — there is no transition to wait for: poll for the
       search input instead, with a hard cap so the guide can never get stuck
       on an invisible slide. */
    var FRIENDS_MAX_WAIT = 6000;
    function whenFriendsReady(cb) {
        var waited = 0, fired = false, timer = null;

        function fire() {
            if (fired) return;
            fired = true;
            state.friendsOpening = false;
            if (timer) clearInterval(timer);
            try { cb(); } catch (e) { /* keep the guide usable no matter what */ }
        }

        timer = setInterval(function () {
            if (!state.open) { fire(); return; }
            var input = null;
            try { input = document.querySelector('#frSearchInput'); } catch (e) { input = null; }
            if (input && isVisible(input)) { fire(); return; }
            waited += 120;
            if (waited >= FRIENDS_MAX_WAIT) fire();
        }, 120);
    }

    // ── Geometry helpers ─────────────────────────────────────────
    function roundRectPath(x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        return 'M' + (x + r) + ',' + y +
            'h' + (w - 2 * r) +
            'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + r +
            'v' + (h - 2 * r) +
            'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + r +
            'h' + (-(w - 2 * r)) +
            'a' + r + ',' + r + ' 0 0 1 ' + (-r) + ',' + (-r) +
            'v' + (-(h - 2 * r)) +
            'a' + r + ',' + r + ' 0 0 1 ' + r + ',' + (-r) + 'z';
    }

    /* Punch the highlighted controls out of the blurred scrim so they
       stay perfectly sharp while everything else is blurred. */
    function applyScrimHoles(rects) {
        if (!scrim) return;
        if (!rects.length) { root.classList.remove('dl-tut-morph'); resetScrim(); return; }

        // Two clip paths can only be interpolated when they list the same
        // number of shapes — only then is the morph worth its repaint cost.
        var prev = scrim.getAttribute('data-holes');
        root.classList.toggle('dl-tut-morph', prev !== null && prev === String(rects.length));
        scrim.setAttribute('data-holes', String(rects.length));

        var d = 'M0,0H' + vw() + 'V' + vh() + 'H0Z';
        rects.forEach(function (r) {
            d += roundRectPath(r.x, r.y, r.w, r.h, 10);
        });
        var val = 'path(evenodd, "' + d + '")';
        scrim.style.clipPath = val;
        scrim.style.webkitClipPath = val;
    }

    /* Sequential packing of boxes inside [minY, maxY]. */
    function packVertical(items, minY, maxY, gap) {
        items.sort(function (a, b) { return a.pref - b.pref; });
        var y = minY;
        items.forEach(function (it) {
            it.y = Math.max(it.pref, y);
            y = it.y + it.h + gap;
        });
        if (y - gap > maxY) {
            var yy = maxY;
            for (var i = items.length - 1; i >= 0; i--) {
                items[i].y = Math.min(items[i].y, yy - items[i].h);
                yy = items[i].y - gap;
            }
            var yy2 = minY;
            for (var j = 0; j < items.length; j++) {
                if (items[j].y < yy2) items[j].y = yy2;
                yy2 = items[j].y + items[j].h + gap;
            }
        }
    }

    /* Point on the border of `box` in the direction of (tx, ty). */
    function edgePoint(box, tx, ty) {
        var cx = box.x + box.w / 2, cy = box.y + box.h / 2;
        var dx = tx - cx, dy = ty - cy;
        if (!dx && !dy) return { x: cx, y: cy };
        var sx = dx !== 0 ? (box.w / 2) / Math.abs(dx) : Infinity;
        var sy = dy !== 0 ? (box.h / 2) / Math.abs(dy) : Infinity;
        var s = Math.min(sx, sy);
        return { x: cx + dx * s, y: cy + dy * s };
    }

    function drawArrow(start, target, delay) {
        var end = edgePoint(target, start.x, start.y);
        // stop a few px before the ring
        var vx = end.x - start.x, vy = end.y - start.y;
        var len = Math.sqrt(vx * vx + vy * vy) || 1;
        end = { x: end.x - (vx / len) * 9, y: end.y - (vy / len) * 9 };

        // gentle curve, perpendicular offset proportional to length
        var mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2;
        var off = Math.min(26, len * 0.18);
        var ctrl = { x: mx - (vy / len) * off, y: my + (vx / len) * off };

        var path = svgEl('path', svg);
        path.setAttribute('class', 'dl-tut-arrow-path');
        path.setAttribute('d', 'M' + start.x + ',' + start.y + ' Q' + ctrl.x + ',' + ctrl.y + ' ' + end.x + ',' + end.y);

        // Draw the line at a constant speed: the dash pattern must match the
        // real length of the curve, otherwise short arrows stay invisible for
        // most of the animation and then snap on in the last few frames.
        var drawMs = 300;
        try {
            var len = path.getTotalLength();
            if (len && isFinite(len) && len > 0) {
                path.style.strokeDasharray = len + ' ' + len;
                path.style.strokeDashoffset = len;
                drawMs = Math.min(640, Math.max(240, len * 1.15));
            }
        } catch (e) { /* getTotalLength unsupported — CSS fallback applies */ }
        path.style.animationDuration = drawMs + 'ms';
        if (delay) path.style.animationDelay = delay + 'ms';

        // arrow head, oriented along the tangent at the end point
        var ang = Math.atan2(end.y - ctrl.y, end.x - ctrl.x);
        var s = 8;
        var p1 = end;
        var p2 = { x: end.x - s * Math.cos(ang - 0.42), y: end.y - s * Math.sin(ang - 0.42) };
        var p3 = { x: end.x - s * Math.cos(ang + 0.42), y: end.y - s * Math.sin(ang + 0.42) };
        var head = svgEl('polygon', svg);
        head.setAttribute('class', 'dl-tut-arrow-head');
        head.setAttribute('points', p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + p3.x + ',' + p3.y);
        head.style.animationDelay = ((delay || 0) + drawMs * 0.62) + 'ms';
    }

    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    /* Where the arrow leaves its callout, depending on which side of the
       highlighted control the callout column sits on. */
    function anchorFor(placement, box, target) {
        var tcx = target.x + target.w / 2;
        if (placement === 'top')   return { x: clamp(tcx, box.x + 16, box.x + box.w - 16), y: box.y + box.h };
        if (placement === 'below') return { x: clamp(tcx, box.x + 16, box.x + box.w - 16), y: box.y };
        if (placement === 'left')  return { x: box.x + box.w, y: box.y + box.h / 2 };
        return { x: box.x, y: box.y + box.h / 2 }; // 'right'
    }

    function addRing(r, num) {
        var pad = 5;
        var n = el('div', 'dl-tut-ring', stage);
        n.style.left = (r.x - pad) + 'px';
        n.style.top = (r.y - pad) + 'px';
        n.style.width = (r.w + pad * 2) + 'px';
        n.style.height = (r.h + pad * 2) + 'px';
        if (num != null) {
            var badge = el('span', 'dl-tut-ring-num', n);
            badge.textContent = String(num);
        }
        return n;
    }

    // ── Rendering ────────────────────────────────────────────────
    function resetScrim() {
        if (!scrim) return;
        root.classList.remove('dl-tut-morph');
        scrim.removeAttribute('data-holes');
        scrim.style.clipPath = '';
        scrim.style.webkitClipPath = '';
    }

    /* `keepScrim` leaves the current holes in place: paint() then swaps them
       in a single write, which lets the scrim morph smoothly from the old
       highlight to the new one instead of blinking through a hole-less frame. */
    function clearStage(keepScrim) {
        stopTutorialVideo();
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        stage.innerHTML = '';
        if (!keepScrim) resetScrim();
        root.classList.remove('compact');
    }

    /* Toolbar / title / dots — updated the moment the slide starts leaving so
       the chrome never lags behind the click. */
    function syncChrome(step) {
        titleEl.innerHTML = (state.idx + 1) + '/' + STEPS.length + ' · ' + tr(step.title);
        btnPrev.disabled = state.idx === 0;
        btnNext.disabled = state.idx === STEPS.length - 1;
        btnPrev.title = tr(UI.prev);
        btnNext.title = tr(UI.next);
        Array.prototype.forEach.call(dots.children, function (d, i) {
            d.classList.toggle('active', i === state.idx);
            d.setAttribute('aria-label', String(i + 1));
        });
    }

    /* dir: 1 → forward, -1 → back, 0 / undefined → no transition (first
       paint, resize, language change, reduced motion). */
    function render(dir) {
        if (!root) return;
        var step = STEPS[state.idx];

        state.seq++;
        var seq = state.seq;

        // The layers panel is only needed on its own slide — start opening it
        // right away so it animates in behind the outgoing slide.
        ensurePanel(!!step.openPanel);
        // Same for the Friends panel on its own slide (signed-in users only;
        // signed-out visitors get the step's authNote instead).
        ensureFriends(!!step.openFriends);

        if (!dir || reduceMotion()) {
            commit(step);
            return;
        }

        // Phase 1 — fade/slide the current slide out in the travel direction.
        root.style.setProperty('--dl-tut-out', (dir > 0 ? -26 : 26) + 'px');
        root.style.setProperty('--dl-tut-in', (dir > 0 ? 26 : -26) + 'px');
        root.classList.add('dl-tut-leaving');

        setTimeout(function () {
            if (!state.open || seq !== state.seq) return;
            commit(step);
        }, LEAVE_MS);
    }

    /* Phase 2 — build the new slide off-screen (opacity 0), then hand it back
       to the CSS transition so it glides into place. */
    function commit(step) {
        if (!root) return;
        var seq = state.seq;
        var quiet = !!state.quiet;

        if (quiet) {
            root.classList.remove('dl-tut-leaving', 'dl-tut-entering');
        } else {
            root.classList.remove('dl-tut-leaving');
            root.classList.add('dl-tut-entering');
        }
        root.classList.toggle('dl-tut-quiet', quiet);

        syncChrome(step);
        svg.setAttribute('viewBox', '0 0 ' + vw() + ' ' + vh());

        function reveal() {
            if (!state.open || seq !== state.seq || STEPS[state.idx] !== step) return;
            paint(step);
            if (quiet) return;
            // Flush the "entering" state, then let the transition run.
            void stage.offsetWidth;
            requestAnimationFrame(function () {
                if (state.open && seq === state.seq) root.classList.remove('dl-tut-entering');
            });
        }

        if (step.openPanel && state.panelOpening) whenPanelSettled(reveal);
        else if (step.openFriends && state.friendsOpening) whenFriendsReady(reveal);
        else reveal();
    }

    function paint(step) {
        clearStage(true);
        svg.setAttribute('viewBox', '0 0 ' + vw() + ' ' + vh());

        if (step.type === 'targets') {
            paintTargets(step);          // replaces the scrim holes itself
        } else {
            resetScrim();
            if (step.type === 'catalog') paintCatalog(step);
            else if (step.type === 'performance') paintPerformance(step);
        }
    }

    function barBottom() {
        var r = bar.getBoundingClientRect();
        var t = titleEl.getBoundingClientRect();
        return Math.max(r.bottom, t.bottom) + 10;
    }

    function paintTargets(step) {
        // The Friends slide needs a signed-in account: opening the panel for
        // a visitor would pop the auth modal over the guide, so they get an
        // explanatory note pointing at the account menu instead.
        if (step.requiresAuth && !signedIn()) {
            resetScrim();
            var auth = el('div', 'dl-tut-note', stage);
            auth.style.cssText += 'left:50%;top:50%;transform:translate(-50%,-50%);width:min(340px,calc(100% - 32px));text-align:center;';
            auth.innerHTML = '<div class="dl-tut-note-item"><span class="dl-tut-note-ico">👥</span><span>' +
                tr(step.authNote) + '</span></div>';
            return;
        }

        var found = [];
        step.targets.forEach(function (t) {
            var node = pick(t.sel);
            if (!node) return;
            var ringNode = node;
            if (t.ring) {
                var closest = node.closest ? node.closest(t.ring) : null;
                ringNode = closest || (node.parentNode && node.parentNode.querySelector ? (node.parentNode.querySelector(t.ring) || node) : node);
            }
            var r = ringNode.getBoundingClientRect();
            found.push({
                def: t,
                rect: { x: r.left, y: r.top, w: r.width, h: r.height }
            });
        });

        if (!found.length) {
            resetScrim();
            var empty = el('div', 'dl-tut-note', stage);
            empty.style.cssText += 'left:50%;top:50%;transform:translate(-50%,-50%);width:min(320px,calc(100% - 32px));text-align:center;';
            empty.innerHTML = lang() === 'en'
                ? 'These controls are not available on this screen.'
                : 'Aceste butoane nu sunt disponibile pe acest ecran.';
            return;
        }

        var top = barBottom();
        var bottom = vh() - 12;
        var placement = step.placement;

        // Union of every target — used by the "below" placement.
        var uni = found.reduce(function (a, f) {
            return {
                x1: Math.min(a.x1, f.rect.x),
                y1: Math.min(a.y1, f.rect.y),
                x2: Math.max(a.x2, f.rect.x + f.rect.w),
                y2: Math.max(a.y2, f.rect.y + f.rect.h)
            };
        }, { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });

        // On narrow screens there is no usable room beside the layers panel,
        // so the callouts drop underneath the highlighted row instead.
        if (placement === 'left' && (uni.x1 - 30) < 190) placement = 'below';

        // PWA floating controls: number each button left-to-right so the callout
        // clearly maps to its control even when arrows cross.
        var numberBar = placement === 'top' && isPwa();
        var nums = [];
        if (numberBar) {
            found.map(function (f, i) { return i; })
                .sort(function (a, b) { return found[a].rect.x - found[b].rect.x; })
                .forEach(function (idx, n) { nums[idx] = n + 1; });
        }

        // Build the callouts first so we can measure their heights.
        var boxes = found.map(function (f, i) {
            var c = el('div', 'dl-tut-callout', stage);
            var numHtml = numberBar && nums[i]
                ? '<span class="dl-tut-c-num">' + nums[i] + '</span>'
                : '';
            c.innerHTML =
                '<span class="dl-tut-c-title">' + numHtml + tr(f.def.title) + '</span>' +
                '<span class="dl-tut-c-desc">' + tr(f.def.desc) + '</span>';
            return { node: c, f: f, num: nums[i] || null };
        });

        // Stagger the callouts so the slide unfolds instead of popping in one
        // single block.
        boxes.forEach(function (b, i) {
            b.node.style.animationDelay = Math.round(Math.min(i * 45, 220)) + 'ms';
        });

        if (numberBar) root.classList.add('compact');

        var note = null;
        if (step.notes && step.notes.length) {
            note = el('div', 'dl-tut-note', stage);
            note.style.animationDelay = Math.round(Math.min(boxes.length * 45, 220) + 60) + 'ms';
            note.innerHTML = step.notes.map(function (n) {
                return '<div class="dl-tut-note-item"><span class="dl-tut-note-ico">' + n.ico + '</span><span>' + tr(n.text) + '</span></div>';
            }).join('');
        }

        // ── Column geometry ──
        var colX, colW;
        if (placement === 'right') {
            var maxRight = Math.max.apply(null, found.map(function (f) { return f.rect.x + f.rect.w; }));
            colX = Math.min(maxRight + 18, vw() * 0.36);
            colW = Math.min(300, vw() - colX - 12);
            if (colW < 150) { colX = 12; colW = vw() - 24; }
        } else if (placement === 'left') {
            colW = Math.min(300, Math.max(150, uni.x1 - 30));
            colX = Math.max(12, uni.x1 - colW - 18);
        } else if (placement === 'below') {
            colW = Math.min(360, vw() - 24);
            colX = Math.max(12, Math.min((uni.x1 + uni.x2) / 2 - colW / 2, vw() - colW - 12));
        } else { // 'top' — detection / storage / account slide
            colW = Math.min(340, vw() - 24);
            colX = (vw() - colW) / 2;
        }

        boxes.forEach(function (b) {
            b.node.style.left = colX + 'px';
            b.node.style.width = colW + 'px';
        });
        if (note) {
            note.style.left = colX + 'px';
            note.style.width = colW + 'px';
        }

        // Measure — shrink everything if the column would not fit.
        function totalHeight() {
            var t = 0;
            boxes.forEach(function (b) { t += b.node.offsetHeight; });
            if (note) t += note.offsetHeight + 10;
            return t + (boxes.length - 1) * 8;
        }

        var minTargetTop = uni.y1;
        var avail;
        if (placement === 'top') avail = (minTargetTop - 16) - top;
        else if (placement === 'below') avail = bottom - Math.max(top, uni.y2 + 24);
        else avail = bottom - top;

        if (totalHeight() > avail) root.classList.add('compact');

        // ── Vertical placement ──
        var items = boxes.map(function (b) {
            var h = b.node.offsetHeight;
            var pref;
            if (placement === 'top' || placement === 'below') pref = 0; // resolved below
            else pref = b.f.rect.y + b.f.rect.h / 2 - h / 2;
            return { box: b, h: h, pref: pref };
        });

        var noteH = note ? note.offsetHeight : 0;

        if (placement === 'top') {
            // Order the callouts left-to-right by the x of their target and
            // stack them upwards from just above the topmost target.
            var lowerBound = Math.max(top, minTargetTop - 16);
            items.sort(function (a, b) { return a.box.f.rect.x - b.box.f.rect.x; });

            if (numberBar && items.length >= 2) {
                // Two columns over the map: left targets → left column,
                // right targets → right column. Arrows stay mostly vertical.
                var split = Math.ceil(items.length / 2);
                var leftCol = items.slice(0, split);
                var rightCol = items.slice(split);
                var colW2 = Math.min(200, Math.max(136, Math.floor((vw() - 24) / 2)));
                var leftX = 8;
                var rightX = vw() - colW2 - 8;

                function layoutBarCol(col, x) {
                    col.forEach(function (it) {
                        it.x = x;
                        it.w = colW2;
                        it.box.node.style.left = x + 'px';
                        it.box.node.style.width = colW2 + 'px';
                    });
                    col.forEach(function (it) { it.h = it.box.node.offsetHeight; });
                    var yy = lowerBound;
                    for (var ci = col.length - 1; ci >= 0; ci--) {
                        yy -= col[ci].h;
                        col[ci].y = yy;
                        yy -= 6;
                    }
                    if (col.length && col[0].y < top) {
                        var sh = top - col[0].y;
                        col.forEach(function (it) { it.y += sh; });
                    }
                }
                layoutBarCol(leftCol, leftX);
                layoutBarCol(rightCol, rightX);
            } else {
                var y = lowerBound;
                for (var i = items.length - 1; i >= 0; i--) {
                    y -= items[i].h;
                    items[i].y = y;
                    y -= 8;
                }
                if (items.length && items[0].y < top) {
                    var shift = top - items[0].y;
                    items.forEach(function (it) { it.y += shift; });
                }
            }
        } else if (placement === 'below') {
            // Stack downwards, starting just under the highlighted controls.
            items.sort(function (a, b) { return a.box.f.rect.y - b.box.f.rect.y; });
            var yb = Math.max(top, uni.y2 + 26);
            items.forEach(function (it) {
                it.y = yb;
                yb += it.h + 8;
            });
            var overflow = (yb - 8 + (noteH ? noteH + 10 : 0)) - bottom;
            if (overflow > 0) {
                items.forEach(function (it) { it.y = Math.max(top, it.y - overflow); });
            }
        } else {
            var maxY = bottom - (noteH ? noteH + 10 : 0);
            packVertical(items, top, maxY, 8);
        }

        items.forEach(function (it) {
            if (it.x == null) { it.x = colX; it.w = colW; }
            it.box.node.style.top = Math.round(it.y) + 'px';
        });

        if (note) {
            var lastBottom = items.reduce(function (m, it) { return Math.max(m, it.y + it.h); }, top);
            note.style.top = Math.round(Math.min(lastBottom + 10, bottom - noteH)) + 'px';
        }

        // ── Rings, holes and arrows ──
        var holes = [];
        found.forEach(function (f, fi) {
            addRing(f.rect, numberBar ? nums[fi] : null);
            holes.push({ x: f.rect.x - 5, y: f.rect.y - 5, w: f.rect.w + 10, h: f.rect.h + 10 });
        });
        applyScrimHoles(holes);

        // Arrows start drawing only once their callout has landed.
        items.forEach(function (it, i) {
            var box = { x: it.x, y: it.y, w: it.w, h: it.h };
            drawArrow(anchorFor(placement, box, it.box.f.rect), it.box.f.rect,
                140 + Math.round(Math.min(i * 45, 220)));
        });
    }

    function cardShell(extraClass) {
        var top = barBottom();
        var card = el('div', 'dl-tut-card' + (extraClass ? ' ' + extraClass : ''), stage);
        card.style.pointerEvents = 'auto';
        card.style.top = top + 'px';
        card.style.maxHeight = (vh() - top - 16) + 'px';
        card.addEventListener('click', function (e) { e.stopPropagation(); });
        return card;
    }

    function paintCatalog(step) {
        var card = cardShell();

        var tabs = el('div', 'dl-tut-card-tabs', card);
        var body = el('div', 'dl-tut-card-body', card);

        function fill() {
            var list = CATALOG[state.tab] || [];
            body.innerHTML = list.map(function (l) {
                return '<div class="dl-tut-layer">' +
                    '<span class="dl-tut-layer-name">' + tr(l.name) + '</span>' +
                    '<span class="dl-tut-layer-desc">' + tr(l.desc) + '</span>' +
                    '</div>';
            }).join('');
            body.scrollTop = 0;
        }

        [['free', UI.free_tab, ''], ['premium', UI.prem_tab, ' premium']].forEach(function (t) {
            var b = el('button', 'dl-tut-tab' + t[2] + (state.tab === t[0] ? ' active' : ''), tabs);
            b.type = 'button';
            b.textContent = tr(t[1]);
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                state.tab = t[0];
                Array.prototype.forEach.call(tabs.children, function (n, i) {
                    n.classList.toggle('active', (i === 0) === (t[0] === 'free'));
                });
                fill();
            });
        });

        fill();

        // The body must scroll inside the fixed-height card.
        requestAnimationFrame(function () {
            var used = tabs.offsetHeight + 12 + 28;
            body.style.maxHeight = Math.max(120, (vh() - card.getBoundingClientRect().top - 16) - used) + 'px';
        });
    }

    function paintPerformance(step) {
        var card = cardShell('dl-tut-card-perf');
        var body = el('div', 'dl-tut-card-body', card);
        body.innerHTML =
            '<div class="dl-tut-perf-layout">' +
                '<div class="dl-tut-perf">' +
                    '<span class="dl-tut-perf-ico">⚡</span>' +
                    '<div>' +
                        '<span class="dl-tut-layer-name" style="margin-bottom:6px">' + tr(PERF.title) + '</span>' +
                        '<p>' + tr(PERF.body) + '</p>' +
                        '<span class="dl-tut-tip">' + tr(PERF.tip) + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="dl-tut-perf-video">' +
                    '<video id="dlTutVideo" playsinline webkit-playsinline controls preload="metadata">' +
                        '<source src="' + TUTORIAL_VIDEO_URL + '" type="video/mp4">' +
                    '</video>' +
                '</div>' +
            '</div>';

        var fin = el('button', 'dl-tut-finish', card);
        fin.type = 'button';
        fin.textContent = tr(UI.finish);
        fin.addEventListener('click', function (e) { e.stopPropagation(); close(); });

        requestAnimationFrame(function () {
            var used = fin.offsetHeight + 14 + 28;
            body.style.maxHeight = Math.max(120, (vh() - card.getBoundingClientRect().top - 16) - used) + 'px';
        });
    }

    // ── Public API ───────────────────────────────────────────────
    function go(i) {
        if (i < 0) return;
        if (i >= STEPS.length) { close(); return; }
        var dir = i > state.idx ? 1 : (i < state.idx ? -1 : 0);
        state.idx = i;
        state.quiet = false;
        if (dir === 0) { if (state.open) render(0); return; }
        render(dir);
    }

    function open(startIndex) {
        build();
        state.open = true;
        state.idx = typeof startIndex === 'number' ? startIndex : 0;
        state.quiet = false;
        state.seq++;
        root.classList.remove('dl-tut-closing', 'dl-tut-leaving', 'dl-tut-entering', 'dl-tut-quiet');
        root.classList.add('open');

        // On the website (non-PWA) the map can be scrolled half out of view —
        // bring it fully on screen so every arrow has a visible target.
        var scrolled = false;
        var frame = document.querySelector('.map-frame');
        if (frame && !document.body.classList.contains('is-pwa')) {
            var r = frame.getBoundingClientRect();
            if (r.top < 0 || r.bottom > vh()) {
                try { frame.scrollIntoView({ block: 'center' }); } catch (e) { frame.scrollIntoView(); }
                scrolled = true;
            }
        }

        render(0);

        // A second pass after the scroll settles keeps the arrows exact. It
        // still runs before the first painted frame, so the entrance
        // animation starts cleanly instead of being restarted mid-flight.
        requestAnimationFrame(function () {
            if (!state.open) return;
            var step = STEPS[state.idx];
            if (step && step.openPanel && state.panelOpening) return; // commit() paints once the panel lands
            if (step && step.openFriends && state.friendsOpening) return; // commit() paints once the friends tab renders
            paint(step);
        });

        // Smooth scrolling keeps moving for a while — settle the arrows once
        // it stops, without replaying the entrance animation.
        if (scrolled) {
            setTimeout(function () {
                if (!state.open) return;
                state.quiet = true;
                paint(STEPS[state.idx]);
                root.classList.add('dl-tut-quiet');
            }, 340);
        }
    }

    function close() {
        if (!root || !state.open) return;
        state.open = false;
        state.seq++;
        stopTutorialVideo();

        var finish = function () {
            ensurePanel(false);
            ensureFriends(false);
            root.classList.remove('open', 'dl-tut-closing', 'dl-tut-leaving',
                                 'dl-tut-entering', 'dl-tut-quiet');
            clearStage();
        };

        if (reduceMotion()) { finish(); return; }

        root.classList.add('dl-tut-closing');
        setTimeout(finish, 200);
    }

    window.openMapTutorial = function (i) { open(i); };
    window.closeMapTutorial = close;

    // Keep the "?" button label localised.
    function syncBtn() {
        var b = document.getElementById('mapHelpBtn');
        if (!b) return;
        b.title = tr(UI.help_title);
        b.setAttribute('aria-label', tr(UI.help_title));
    }

    document.addEventListener('detectlab:langchange', syncBtn);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncBtn);
    } else {
        syncBtn();
    }
})();
