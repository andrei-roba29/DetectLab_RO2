/* =====================================================================
 * historical-eu-maps.js — Hărți Istorice Europene (CENAGIS / IH PAN)
 * ---------------------------------------------------------------------
 * Colecție completă de hărți istorice, topografice și planuri urbane
 * georeferențiate, găzduite pe infrastructura CENAGIS (Politechnika Warszawska)
 * și dezvoltate în colaborare cu Instytut Historii PAN (Atlas Fontium / PastMaps).
 *
 * Categorisire pe fiecare țară europeană intersectată/suprapusă:
 *   • Polonia (PL), Germania (DE), Ucraina (UA), Belarus (BY), Lituania (LT),
 *     Letonia (LV), Cehia (CZ), Slovacia (SK), Austria (AT), Ungaria (HU),
 *     Rusia / Kaliningrad (RU), Moldova (MD), România (RO), Franța (FR),
 *     Belgia & Luxemburg (BE-LU), Țările de Jos (NL), Danemarca (DK),
 *     Estonia (EE), Elveția (CH).
 * ===================================================================== */
(function (root) {
    'use strict';

    var WMS_BASE_URL = 'https://pastmaps.cenagis.edu.pl/geoserver/ihpan/wms';

    // ── Catalogul complet al hărților CENAGIS ──
    var MAPS_CATALOG = {
        // --- Serii Topografice WIG (Wojskowy Instytut Geograficzny, 1918-1939 / 1947) ---
        'wig25k': {
            id: 'wig25k',
            wms_layer: 'wig25k_3857',
            title: { ro: 'Harta detaliată WIG 1:25 000', en: 'WIG Detailed Map 1:25,000', pl: 'Mapa szczegółowa WIG 1:25 000' },
            scale: '1:25 000',
            years: '1918–1939',
            provider: 'Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN',
            bounds: [[49.16, 15.66], [55.00, 27.33]]
        },
        'wig100k': {
            id: 'wig100k',
            wms_layer: 'wig100k_3857',
            title: { ro: 'Harta tactică WIG 1:100 000', en: 'WIG Tactical Map 1:100,000', pl: 'Mapa taktyczna WIG 1:100 000' },
            scale: '1:100 000',
            years: '1918–1939',
            provider: 'Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN',
            bounds: [[47.75, 12.83], [56.00, 28.83]]
        },
        'wig300k': {
            id: 'wig300k',
            wms_layer: 'wig300k_3857',
            title: { ro: 'Harta operațională WIG 1:300 000', en: 'WIG Operational Map 1:300,000', pl: 'Mapa operacyjna WIG 1:300 000' },
            scale: '1:300 000',
            years: '1918–1939',
            provider: 'Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN',
            bounds: [[49.00, 14.33], [55.80, 27.50]]
        },
        'wig500k_1947': {
            id: 'wig500k_1947',
            wms_layer: 'wig500k_3857',
            title: { ro: 'Harta Poloniei și a țărilor vecine WIG 1:500 000', en: 'WIG Poland & Neighboring Countries 1:500,000', pl: 'Mapa Polski i Krajów Ościennych WIG 1:500 000' },
            scale: '1:500 000',
            years: '1947',
            provider: 'Wojskowy Instytut Geograficzny (WIG) / CENAGIS IH PAN',
            bounds: [[49.00, 13.50], [55.00, 25.50]]
        },

        // --- Hărți Poloneze din Secolul al XIX-lea ---
        'tkkp_126k': {
            id: 'tkkp_126k',
            wms_layer: 'TKKP_126k_3857',
            title: { ro: 'Harta Topografică a Regatului Poloniei 1:126 000', en: 'Topographic Chart of the Kingdom of Poland (TKKP) 1:126,000', pl: 'Topograficzna Karta Królestwa Polskiego 1:126 000' },
            scale: '1:126 000',
            years: '1839–1843',
            provider: 'Sztab Kwatermistrzostwa Generalnego WP / CENAGIS IH PAN',
            bounds: [[49.81, 17.27], [55.33, 24.92]]
        },
        'chrzanowski': {
            id: 'chrzanowski',
            wms_layer: 'chrzanowski_3857',
            title: { ro: 'Harta Vechii Polonii (Wojciech Chrzanowski) 1:300 000', en: 'Charter of Old Poland (Wojciech Chrzanowski) 1:300,000', pl: 'Karta Dawnej Polski 1:300 000 (Wojciech Chrzanowski)' },
            scale: '1:300 000',
            years: '1859',
            provider: 'Gen. Wojciech Chrzanowski (Paris 1859) / CENAGIS IH PAN',
            bounds: [[45.80, 11.90], [57.10, 38.28]]
        },
        'gaul': {
            id: 'gaul',
            wms_layer: 'gaul_3857',
            title: { ro: 'Harta Gaula / Raczyńskiego 1:125 000', en: 'Gaul / Raczyński Map 1:125,000', pl: 'Mapa Gaula/Raczyńskiego 1:125 000' },
            scale: '1:125 000',
            years: '1807–1812',
            provider: 'Edward Raczyński / Archiwum Państwowe w Poznaniu / CENAGIS IH PAN',
            bounds: [[51.49, 15.12], [52.99, 17.36]]
        },

        // --- Hărți Austriece ---
        'kummersberg': {
            id: 'kummersberg',
            wms_layer: 'kummersberg_3857',
            title: { ro: 'Harta Administrativă a Galiției și Lodomeriei (Kummersberg) 1:115 200', en: 'Administrative Map of Galicia & Lodomeria (Kummersberg) 1:115,200', pl: 'Administrativ Karte von Galizien und Lodomerien (Kummersberg)' },
            scale: '1:115 200',
            years: '1855',
            provider: 'Carl Ritter von Kummersberg / CENAGIS IH PAN',
            bounds: [[48.83, 18.62], [50.85, 26.68]]
        },

        // --- Hărți Prusace și Germane ---
        'schroetter': {
            id: 'schroetter',
            wms_layer: 'schroetter_3857',
            title: { ro: 'Harta Schroetter (Prusia Răsăriteană și Apuseană) 1:150 000', en: 'Schroetter Map (East & West Prussia) 1:150,000', pl: 'Mapa Schroettera 1:150 000 (Ost- und Westpreussen)' },
            scale: '1:150 000',
            years: '1796–1802',
            provider: 'Friedrich Leopold von Schroetter / CENAGIS IH PAN',
            bounds: [[52.30, 15.10], [55.90, 22.96]]
        },
        'gilly': {
            id: 'gilly',
            wms_layer: 'gilly_3857',
            title: { ro: 'Harta Gilly (Prusia de Sud) 1:150 000', en: 'Gilly Map (South Prussia) 1:150,000', pl: 'Mapa Gilly\'ego 1:150 000 (Südpreussen)' },
            scale: '1:150 000',
            years: '1802–1803',
            provider: 'David Gilly (Special Karte von Südpreussen) / CENAGIS IH PAN',
            bounds: [[50.07, 14.88], [53.72, 21.87]]
        },
        'textor': {
            id: 'textor',
            wms_layer: 'textor_3857',
            title: { ro: 'Harta Textor-Sotzmann (Noua Prusie Răsăriteană) 1:150 000', en: 'Textor-Sotzmann Map (New East Prussia) 1:150,000', pl: 'Mapa Textora-Sotzmanna 1:150 000 (Neu Ostpreussen)' },
            scale: '1:150 000',
            years: '1806–1808',
            provider: 'J. C. Textor & D. F. Sotzmann / CENAGIS IH PAN',
            bounds: [[52.48, 18.56], [55.05, 24.34]]
        },
        'm25k': {
            id: 'm25k',
            wms_layer: 'm25k_3857',
            title: { ro: 'Hărțile Germane Messtischblätter 1:25 000', en: 'German Topographic Messtischblätter 1:25,000', pl: 'Messtischblätter 1:25 000' },
            scale: '1:25 000',
            years: '1870–1945',
            provider: 'Königlich Preussische Landesaufnahme / Reichsamt für Landesaufnahme / CENAGIS IH PAN',
            bounds: [[49.39, 13.99], [55.89, 24.66]]
        },
        'kdr': {
            id: 'kdr',
            wms_layer: 'kdr_3857',
            title: { ro: 'Harta Imperiului German (Karte des Deutschen Reiches) 1:100 000', en: 'German Empire Map (Karte des Deutschen Reiches) 1:100,000', pl: 'Karte des Deutschen Reiches 1:100 000' },
            scale: '1:100 000',
            years: '1870–1914 (~1900)',
            provider: 'Reichsamt für Landesaufnahme / CENAGIS IH PAN',
            bounds: [[47.25, 5.83], [56.00, 23.33]]
        },
        'kdr_gb': {
            id: 'kdr_gb',
            wms_layer: 'kdr_gb_3857',
            title: { ro: 'Harta Germană Grossblätter WWII 1:100 000', en: 'German Grossblätter WWII 1:100,000', pl: 'Karte des Deutschen Reiches – Grossblätter 1:100 000' },
            scale: '1:100 000',
            years: '1939–1944',
            provider: 'Hauptvermessungsabteilung / CENAGIS IH PAN',
            bounds: [[47.75, 13.33], [56.75, 28.33]]
        },
        'kdwr': {
            id: 'kdwr',
            wms_layer: 'kdwr_3857',
            title: { ro: 'Harta Rusiei Vestice (Karte des Westlichen Russlands) 1:100 000', en: 'Western Russia Map (Karte des Westlichen Russlands) 1:100,000', pl: 'Karte des Westlichen Russlands 1:100 000' },
            scale: '1:100 000',
            years: '1914–1921',
            provider: 'Kartographische Abteilung des Stellvertretenden Generalstabes / CENAGIS IH PAN',
            bounds: [[49.99, 17.33], [57.75, 27.33]]
        },
        'ukvme': {
            id: 'ukvme',
            wms_layer: 'ukvme_3857',
            title: { ro: 'Harta Europei Centrale (Übersichtskarte von Mitteleuropa) 1:300 000', en: 'Central Europe Map (Übersichtskarte von Mitteleuropa) 1:300,000', pl: 'Übersichtskarte von Mitteleuropa 1:300 000' },
            scale: '1:300 000',
            years: '1890–1915 (~1900)',
            provider: 'Königlich Preussische Landesaufnahme / CENAGIS IH PAN',
            bounds: [[45.99, 12.33], [58.99, 34.33]]
        },
        'reymann': {
            id: 'reymann',
            wms_layer: 'reymann_3857',
            title: { ro: 'Harta Specială Reymann a Europei Centrale 1:200 000', en: 'Reymann\'s Special Map of Central Europe 1:200,000', pl: 'Reymann\'s Special-Karte von Central Europa 1:200 000' },
            scale: '1:200 000',
            years: '1850–1900',
            provider: 'Daniel Gottlob Reymann / Flemming / CENAGIS IH PAN',
            bounds: [[46.50, 5.20], [55.80, 28.50]]
        },

        // --- Hărți Rusești ---
        'dwuwiorstowka': {
            id: 'dwuwiorstowka',
            wms_layer: 'dwuwiorstowka_3857',
            title: { ro: 'Harta Rusă de Două Verste (Dvuhviorstka) 1:84 000', en: 'Russian 2-Verst Map (Dvukhverstka) 1:84,000', pl: 'Dwuwiorstówka 1:84 000' },
            scale: '1:84 000',
            years: '1908–1936',
            provider: 'Военно-Топографический Отдел Главного Штаба / CENAGIS IH PAN',
            bounds: [[50.00, 17.50], [56.00, 26.50]]
        },

        // --- Atlas Historyczny Polski (Secolul al XVI-lea) ---
        'ahp_ziemie_polskie': {
            id: 'ahp_ziemie_polskie',
            wms_layer: 'ahp_ziemie_polskie_3857',
            title: { ro: 'Țările Coroanei Poloneze în sec. XVI 1:250 000', en: 'Crown Lands of Poland in 16th c. 1:250,000', pl: 'Ziemie polskie Korony w II połowie XVI w. 1:250 000' },
            scale: '1:250 000',
            years: 'XVI w. (~1580)',
            provider: 'Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)',
            bounds: [[48.88, 14.49], [55.00, 24.34]]
        },
        'ahp_drogi': {
            id: 'ahp_drogi',
            wms_layer: 'ahp_drogi_3857',
            title: { ro: 'Drumurile comerciale în sec. XVI 1:500 000', en: 'Trade & Postal Routes in 16th c. 1:500,000', pl: 'Drogi w II połowie XVI w. 1:500 000' },
            scale: '1:500 000',
            years: 'XVI w. (~1580)',
            provider: 'Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)',
            bounds: [[48.88, 14.49], [55.00, 24.34]]
        },
        'ahp_koscielne': {
            id: 'ahp_koscielne',
            wms_layer: 'ahp_koscielne_3857',
            title: { ro: 'Împărțirile ecleziastice în sec. XVI 1:500 000', en: 'Ecclesiastical Divisions in 16th c. 1:500,000', pl: 'Podziały kościelne w II połowie XVI w. 1:500 000' },
            scale: '1:500 000',
            years: 'XVI w. (~1580)',
            provider: 'Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)',
            bounds: [[48.88, 14.49], [55.00, 24.34]]
        },
        'ahp_wlasnosc': {
            id: 'ahp_wlasnosc',
            wms_layer: 'ahp_wlasnosc_3857',
            title: { ro: 'Structura proprietății funciare în sec. XVI 1:500 000', en: 'Land Ownership Structure in 16th c. 1:500,000', pl: 'Rozmieszczenie własności w II połowie XVI w. 1:500 000' },
            scale: '1:500 000',
            years: 'XVI w. (~1580)',
            provider: 'Atlas Historyczny Polski / Instytut Historii PAN (IH PAN)',
            bounds: [[48.88, 14.49], [55.00, 24.34]]
        },

        // --- Planuri Urbane (WWII & Istorice) ---
        'city_warszawa': {
            id: 'city_warszawa',
            wms_layer: 'warszawa_3857',
            title: { ro: 'Planul Varșoviei 1:25 000 (1944)', en: 'Warsaw City Plan 1:25,000 (1944)', pl: 'Plan Warszawy 1:25 000 (1944)' },
            scale: '1:25 000',
            years: '1944',
            provider: 'Geographical Section General Staff (GSGS 4435) / WIG / CENAGIS IH PAN',
            bounds: [[52.16, 20.88], [52.30, 21.15]]
        },
        'city_krakow': {
            id: 'city_krakow',
            wms_layer: 'krakow_3857',
            title: { ro: 'Planul Cracoviei 1:25 000 (1943)', en: 'Kraków City Plan 1:25,000 (1943)', pl: 'Plan Krakowa 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[49.99, 19.87], [50.10, 20.00]]
        },
        'city_gdansk': {
            id: 'city_gdansk',
            wms_layer: 'gdansk_3857',
            title: { ro: 'Planul Gdańskului 1:25 000 (1944)', en: 'Gdańsk City Plan 1:25,000 (1944)', pl: 'Plan Gdańska 1:25 000 (1944)' },
            scale: '1:25 000',
            years: '1944',
            provider: 'GSGS 4496 / WIG / CENAGIS IH PAN',
            bounds: [[54.32, 18.59], [54.42, 18.70]]
        },
        'city_wroclaw': {
            id: 'city_wroclaw',
            wms_layer: 'wroclaw_3857',
            title: { ro: 'Planul Wrocławului (Breslau) 1:25 000 (1944)', en: 'Wrocław (Breslau) City Plan 1:25,000 (1944)', pl: 'Plan Wrocławia 1:25 000 (1944)' },
            scale: '1:25 000',
            years: '1944',
            provider: 'GSGS 4480 / WIG / CENAGIS IH PAN',
            bounds: [[51.07, 16.98], [51.14, 17.10]]
        },
        'city_poznan': {
            id: 'city_poznan',
            wms_layer: 'poznan_3857',
            title: { ro: 'Planul Poznańului 1:25 000 (1943)', en: 'Poznań City Plan 1:25,000 (1943)', pl: 'Plan Poznania 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[52.36, 16.86], [52.43, 17.00]]
        },
        'city_lodz': {
            id: 'city_lodz',
            wms_layer: 'lodz_3857',
            title: { ro: 'Planul orașului Łódź 1:25 000 (1943)', en: 'Łódź City Plan 1:25,000 (1943)', pl: 'Plan Łodzi 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[51.64, 19.32], [51.87, 19.55]]
        },
        'city_katowice': {
            id: 'city_katowice',
            wms_layer: 'katowice_3857',
            title: { ro: 'Planul Katowice 1:25 000 (1943)', en: 'Katowice City Plan 1:25,000 (1943)', pl: 'Plan Katowic 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[50.23, 18.98], [50.28, 19.08]]
        },
        'city_czestochowa': {
            id: 'city_czestochowa',
            wms_layer: 'czestochowa_3857',
            title: { ro: 'Planul Częstochowa 1:25 000 (1943)', en: 'Częstochowa City Plan 1:25,000 (1943)', pl: 'Plan Częstochowy 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[50.77, 19.06], [50.83, 19.17]]
        },
        'city_bialystok': {
            id: 'city_bialystok',
            wms_layer: 'bialystok_3857',
            title: { ro: 'Planul Białystok 1:25 000 (1943)', en: 'Białystok City Plan 1:25,000 (1943)', pl: 'Plan Białegostoku 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[53.09, 23.09], [53.16, 23.21]]
        },
        'city_bydgoszcz': {
            id: 'city_bydgoszcz',
            wms_layer: 'bydgoszcz_3857',
            title: { ro: 'Planul Bydgoszcz 1:25 000 (1943)', en: 'Bydgoszcz City Plan 1:25,000 (1943)', pl: 'Plan Bydgoszczy 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[53.10, 17.94], [53.15, 18.06]]
        },
        'city_torun': {
            id: 'city_torun',
            wms_layer: 'torun_3857',
            title: { ro: 'Planul Toruń 1:25 000 (1943)', en: 'Toruń City Plan 1:25,000 (1943)', pl: 'Plan Torunia 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[52.98, 18.55], [53.05, 18.66]]
        },
        'city_lublin': {
            id: 'city_lublin',
            wms_layer: 'lublin_3857',
            title: { ro: 'Planul Lublin 1:25 000 (1943)', en: 'Lublin City Plan 1:25,000 (1943)', pl: 'Plan Lublina 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[51.20, 22.52], [51.28, 22.62]]
        },
        'city_kielce': {
            id: 'city_kielce',
            wms_layer: 'kielce_3857',
            title: { ro: 'Planul Kielce 1:25 000 (1943)', en: 'Kielce City Plan 1:25,000 (1943)', pl: 'Plan Kielc 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[50.83, 20.57], [50.89, 20.69]]
        },
        'city_radom': {
            id: 'city_radom',
            wms_layer: 'radom_3857',
            title: { ro: 'Planul Radom 1:25 000 (1943)', en: 'Radom City Plan 1:25,000 (1943)', pl: 'Plan Radomia 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[51.36, 21.09], [51.42, 21.21]]
        },
        'city_rzeszow': {
            id: 'city_rzeszow',
            wms_layer: 'rzeszow_3857',
            title: { ro: 'Planul Rzeszów 1:25 000 (1943)', en: 'Rzeszów City Plan 1:25,000 (1943)', pl: 'Plan Rzeszowa 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[50.01, 21.96], [50.07, 22.05]]
        },
        'city_tarnow': {
            id: 'city_tarnow',
            wms_layer: 'tarnow_3857',
            title: { ro: 'Planul Tarnów 1:25 000 (1943)', en: 'Tarnów City Plan 1:25,000 (1943)', pl: 'Plan Tarnowa 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[49.99, 20.94], [50.03, 21.05]]
        },
        'city_grudziadz': {
            id: 'city_grudziadz',
            wms_layer: 'grudziadz_3857',
            title: { ro: 'Planul Grudziądz 1:25 000 (1943)', en: 'Grudziądz City Plan 1:25,000 (1943)', pl: 'Plan Grudziądza 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[53.46, 18.72], [53.52, 18.80]]
        },
        'city_inowroclaw': {
            id: 'city_inowroclaw',
            wms_layer: 'inowroclaw_3857',
            title: { ro: 'Planul Inowrocław 1:25 000 (1943)', en: 'Inowrocław City Plan 1:25,000 (1943)', pl: 'Plan Inowrocławia 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[52.78, 18.20], [52.82, 18.30]]
        },
        'city_jaslo': {
            id: 'city_jaslo',
            wms_layer: 'jaslo_3857',
            title: { ro: 'Planul Jasło 1:25 000 (1943)', en: 'Jasło City Plan 1:25,000 (1943)', pl: 'Plan Jasła 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[49.71, 21.41], [49.79, 21.54]]
        },
        'city_siedlce': {
            id: 'city_siedlce',
            wms_layer: 'siedlce_3857',
            title: { ro: 'Planul Siedlce 1:25 000 (1943)', en: 'Siedlce City Plan 1:25,000 (1943)', pl: 'Plan Siedlec 1:25 000 (1943)' },
            scale: '1:25 000',
            years: '1943',
            provider: 'GSGS 4435 / WIG / CENAGIS IH PAN',
            bounds: [[52.13, 22.21], [52.20, 22.33]]
        },
        'city_warszawa_lindley': {
            id: 'city_warszawa_lindley',
            wms_layer: 'lindley_3857',
            title: { ro: 'Planul Lindley al Varșoviei 1:2 500 (1897–1901)', en: 'Lindley Warsaw Plan 1:2,500 (1897–1901)', pl: 'Warszawa - mapa Lindleyów (1897-1901)' },
            scale: '1:2 500',
            years: '1897–1901',
            provider: 'William Heerlein Lindley / Archiwum Państwowe w Warszawie / IH PAN',
            bounds: [[52.17, 20.94], [52.31, 21.08]]
        },
        'city_warszawa_1822': {
            id: 'city_warszawa_1822',
            wms_layer: 'warszawaOKI_2180',
            title: { ro: 'Planul Capitalei Varșovia (Corpul de Ingineri) 1:4 800 (1822)', en: 'Warsaw City Plan (Corps of Engineers) 1:4,800 (1822)', pl: 'Plan miasta stołecznego Warszawy (1822)' },
            scale: '1:4 800',
            years: '1822',
            provider: 'Oficerowie Korpusu Inżynierów (1818-1819, litogr. 1822) / AGAD / IH PAN',
            bounds: [[52.19, 20.95], [52.28, 21.07]]
        },
        'city_praga_1796': {
            id: 'city_praga_1796',
            wms_layer: 'rauch_2180',
            title: { ro: 'Planul Suburbiei Praga (Varșovia) 1:7 200 (1796)', en: 'Praga Suburb (Warsaw) Plan 1:7,200 (1796)', pl: 'Original Plan der Vorstadt Praga (1796)' },
            scale: '1:7 200',
            years: '1796',
            provider: 'Johann Georg Gustav von Rauch / Staatsbibliothek zu Berlin / IH PAN',
            bounds: [[52.22, 20.99], [52.28, 21.07]]
        }
    };

    // ── Clasificare pe Țări Europene și Acoperire (%) ──
    var COUNTRIES_DATA = [
        {
            code: 'PL',
            flag: '🇵🇱',
            name: { ro: 'Polonia', en: 'Poland', pl: 'Polska' },
            maps: [
                { id: 'wig100k', pct: 100.0 },
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'kdr_gb', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'reymann', pct: 100.0 },
                { id: 'wig500k_1947', pct: 99.9 },
                { id: 'wig300k', pct: 99.7 },
                { id: 'ahp_ziemie_polskie', pct: 99.9 },
                { id: 'ahp_drogi', pct: 99.9 },
                { id: 'ahp_koscielne', pct: 99.9 },
                { id: 'ahp_wlasnosc', pct: 99.9 },
                { id: 'm25k', pct: 97.2 },
                { id: 'kdr', pct: 95.9 },
                { id: 'wig25k', pct: 91.7 },
                { id: 'tkkp_126k', pct: 69.5 },
                { id: 'kdwr', pct: 65.8 },
                { id: 'dwuwiorstowka', pct: 64.0 },
                { id: 'gilly', pct: 57.7 },
                { id: 'schroetter', pct: 38.8 },
                { id: 'textor', pct: 22.6 },
                { id: 'kummersberg', pct: 20.3 },
                { id: 'gaul', pct: 7.8 },
                // City plans
                { id: 'city_warszawa', pct: 100.0, isCity: true },
                { id: 'city_krakow', pct: 100.0, isCity: true },
                { id: 'city_gdansk', pct: 100.0, isCity: true },
                { id: 'city_wroclaw', pct: 100.0, isCity: true },
                { id: 'city_poznan', pct: 100.0, isCity: true },
                { id: 'city_lodz', pct: 100.0, isCity: true },
                { id: 'city_katowice', pct: 100.0, isCity: true },
                { id: 'city_czestochowa', pct: 100.0, isCity: true },
                { id: 'city_bialystok', pct: 100.0, isCity: true },
                { id: 'city_bydgoszcz', pct: 100.0, isCity: true },
                { id: 'city_torun', pct: 100.0, isCity: true },
                { id: 'city_lublin', pct: 100.0, isCity: true },
                { id: 'city_kielce', pct: 100.0, isCity: true },
                { id: 'city_radom', pct: 100.0, isCity: true },
                { id: 'city_rzeszow', pct: 100.0, isCity: true },
                { id: 'city_tarnow', pct: 100.0, isCity: true },
                { id: 'city_grudziadz', pct: 100.0, isCity: true },
                { id: 'city_inowroclaw', pct: 100.0, isCity: true },
                { id: 'city_jaslo', pct: 100.0, isCity: true },
                { id: 'city_siedlce', pct: 100.0, isCity: true },
                { id: 'city_warszawa_lindley', pct: 100.0, isCity: true },
                { id: 'city_warszawa_1822', pct: 100.0, isCity: true },
                { id: 'city_praga_1796', pct: 100.0, isCity: true }
            ]
        },
        {
            code: 'DE',
            flag: '🇩🇪',
            name: { ro: 'Germania', en: 'Germany', pl: 'Niemcy' },
            maps: [
                { id: 'reymann', pct: 100.0 },
                { id: 'kdr', pct: 99.8 },
                { id: 'chrzanowski', pct: 25.3 },
                { id: 'ukvme', pct: 19.4 },
                { id: 'wig100k', pct: 13.4 },
                { id: 'kdr_gb', pct: 8.6 },
                { id: 'wig500k_1947', pct: 7.0 },
                { id: 'm25k', pct: 3.5 },
                { id: 'wig300k', pct: 1.4 },
                { id: 'ahp_ziemie_polskie', pct: 0.7 },
                { id: 'ahp_drogi', pct: 0.7 },
                { id: 'ahp_koscielne', pct: 0.7 },
                { id: 'ahp_wlasnosc', pct: 0.7 },
                { id: 'gilly', pct: 0.1 }
            ]
        },
        {
            code: 'UA',
            flag: '🇺🇦',
            name: { ro: 'Ucraina', en: 'Ukraine', pl: 'Ukraina' },
            maps: [
                { id: 'chrzanowski', pct: 87.2 },
                { id: 'ukvme', pct: 69.5 },
                { id: 'reymann', pct: 27.9 },
                { id: 'wig100k', pct: 27.0 },
                { id: 'kdr_gb', pct: 24.8 },
                { id: 'wig300k', pct: 13.1 },
                { id: 'wig25k', pct: 11.7 },
                { id: 'kummersberg', pct: 8.5 },
                { id: 'kdwr', pct: 7.4 },
                { id: 'wig500k_1947', pct: 6.5 },
                { id: 'dwuwiorstowka', pct: 5.7 },
                { id: 'ahp_ziemie_polskie', pct: 2.8 },
                { id: 'ahp_drogi', pct: 2.8 },
                { id: 'ahp_koscielne', pct: 2.8 },
                { id: 'ahp_wlasnosc', pct: 2.8 },
                { id: 'm25k', pct: 2.7 },
                { id: 'tkkp_126k', pct: 2.5 },
                { id: 'kdr', pct: 1.8 }
            ]
        },
        {
            code: 'BY',
            flag: '🇧🇾',
            name: { ro: 'Belarus', en: 'Belarus', pl: 'Białoruś' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdwr', pct: 75.4 },
                { id: 'dwuwiorstowka', pct: 62.8 },
                { id: 'wig100k', pct: 55.3 },
                { id: 'kdr_gb', pct: 51.5 },
                { id: 'wig300k', pct: 36.5 },
                { id: 'wig25k', pct: 32.3 },
                { id: 'reymann', pct: 26.8 },
                { id: 'wig500k_1947', pct: 13.6 },
                { id: 'tkkp_126k', pct: 9.1 },
                { id: 'ahp_ziemie_polskie', pct: 7.2 },
                { id: 'ahp_drogi', pct: 7.2 },
                { id: 'ahp_koscielne', pct: 7.2 },
                { id: 'ahp_wlasnosc', pct: 7.2 },
                { id: 'm25k', pct: 4.8 },
                { id: 'kdr', pct: 3.5 },
                { id: 'textor', pct: 2.2 }
            ]
        },
        {
            code: 'LT',
            flag: '🇱🇹',
            name: { ro: 'Lituania', en: 'Lithuania', pl: 'Litwa' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'kdwr', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'dwuwiorstowka', pct: 98.4 },
                { id: 'wig100k', pct: 92.1 },
                { id: 'kdr_gb', pct: 89.5 },
                { id: 'wig300k', pct: 83.4 },
                { id: 'm25k', pct: 74.8 },
                { id: 'kdr', pct: 64.2 },
                { id: 'wig25k', pct: 52.6 },
                { id: 'wig500k_1947', pct: 51.8 },
                { id: 'tkkp_126k', pct: 48.2 },
                { id: 'textor', pct: 46.8 },
                { id: 'reymann', pct: 43.9 },
                { id: 'schroetter', pct: 31.5 },
                { id: 'ahp_ziemie_polskie', pct: 28.6 },
                { id: 'ahp_drogi', pct: 28.6 },
                { id: 'ahp_koscielne', pct: 28.6 },
                { id: 'ahp_wlasnosc', pct: 28.6 }
            ]
        },
        {
            code: 'LV',
            flag: '🇱🇻',
            name: { ro: 'Letonia', en: 'Latvia', pl: 'Łotwa' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdwr', pct: 83.1 },
                { id: 'dwuwiorstowka', pct: 12.4 },
                { id: 'wig100k', pct: 11.8 }
            ]
        },
        {
            code: 'CZ',
            flag: '🇨🇿',
            name: { ro: 'Cehia', en: 'Czech Republic', pl: 'Czechy' },
            maps: [
                { id: 'reymann', pct: 100.0 },
                { id: 'kdr', pct: 88.6 },
                { id: 'kdr_gb', pct: 87.2 },
                { id: 'ukvme', pct: 86.4 },
                { id: 'wig100k', pct: 72.1 },
                { id: 'chrzanowski', pct: 68.2 },
                { id: 'wig500k_1947', pct: 62.7 },
                { id: 'm25k', pct: 46.8 },
                { id: 'wig300k', pct: 35.1 }
            ]
        },
        {
            code: 'SK',
            flag: '🇸🇰',
            name: { ro: 'Slovacia', en: 'Slovakia', pl: 'Słowacja' },
            maps: [
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'kdr_gb', pct: 98.2 },
                { id: 'reymann', pct: 97.6 },
                { id: 'wig100k', pct: 52.4 },
                { id: 'wig500k_1947', pct: 38.5 },
                { id: 'wig300k', pct: 24.3 },
                { id: 'm25k', pct: 11.2 },
                { id: 'kdr', pct: 9.4 }
            ]
        },
        {
            code: 'AT',
            flag: '🇦🇹',
            name: { ro: 'Austria', en: 'Austria', pl: 'Austria' },
            maps: [
                { id: 'kdr', pct: 87.4 },
                { id: 'ukvme', pct: 81.6 },
                { id: 'reymann', pct: 75.8 },
                { id: 'chrzanowski', pct: 38.9 },
                { id: 'kdr_gb', pct: 31.7 }
            ]
        },
        {
            code: 'HU',
            flag: '🇭🇺',
            name: { ro: 'Ungaria', en: 'Hungary', pl: 'Węgry' },
            maps: [
                { id: 'chrzanowski', pct: 84.5 },
                { id: 'ukvme', pct: 83.7 },
                { id: 'reymann', pct: 52.8 },
                { id: 'kdr', pct: 33.2 },
                { id: 'kdr_gb', pct: 9.5 },
                { id: 'wig100k', pct: 8.4 }
            ]
        },
        {
            code: 'RU',
            flag: '🇷🇺',
            name: { ro: 'Rusia / Kaliningrad', en: 'Russia / Kaliningrad', pl: 'Rosja / Kaliningrad' },
            maps: [
                { id: 'wig100k', pct: 100.0 },
                { id: 'wig300k', pct: 100.0 },
                { id: 'tkkp_126k', pct: 100.0 },
                { id: 'chrzanowski', pct: 100.0 },
                { id: 'schroetter', pct: 100.0 },
                { id: 'm25k', pct: 100.0 },
                { id: 'kdr', pct: 100.0 },
                { id: 'kdr_gb', pct: 100.0 },
                { id: 'kdwr', pct: 100.0 },
                { id: 'ukvme', pct: 100.0 },
                { id: 'reymann', pct: 100.0 },
                { id: 'dwuwiorstowka', pct: 100.0 },
                { id: 'wig25k', pct: 95.3 },
                { id: 'wig500k_1947', pct: 94.6 },
                { id: 'textor', pct: 91.8 },
                { id: 'ahp_ziemie_polskie', pct: 91.2 },
                { id: 'ahp_drogi', pct: 91.2 },
                { id: 'ahp_koscielne', pct: 91.2 },
                { id: 'ahp_wlasnosc', pct: 91.2 }
            ]
        },
        {
            code: 'MD',
            flag: '🇲🇩',
            name: { ro: 'Republica Moldova', en: 'Moldova', pl: 'Mołdawia' },
            maps: [
                { id: 'ukvme', pct: 76.5 },
                { id: 'chrzanowski', pct: 70.7 },
                { id: 'reymann', pct: 40.1 },
                { id: 'wig100k', pct: 21.3 },
                { id: 'kdr_gb', pct: 17.1 }
            ]
        },
        {
            code: 'RO',
            flag: '🇷🇴',
            name: { ro: 'România', en: 'Romania', pl: 'Rumunia' },
            maps: [
                { id: 'ukvme', pct: 26.4 },
                { id: 'chrzanowski', pct: 24.7 },
                { id: 'reymann', pct: 20.2 },
                { id: 'kdr', pct: 1.6 },
                { id: 'kdr_gb', pct: 1.4 },
                { id: 'wig100k', pct: 1.2 }
            ]
        },
        {
            code: 'FR',
            flag: '🇫🇷',
            name: { ro: 'Franța', en: 'France', pl: 'Francja' },
            maps: [
                { id: 'reymann', pct: 13.1 },
                { id: 'kdr', pct: 9.4 }
            ]
        },
        {
            code: 'BE-LU',
            flag: '🇧🇪',
            name: { ro: 'Belgia & Luxemburg', en: 'Belgium & Luxembourg', pl: 'Belgia i Luksemburg' },
            maps: [
                { id: 'reymann', pct: 33.1 },
                { id: 'kdr', pct: 17.4 }
            ]
        },
        {
            code: 'NL',
            flag: '🇳🇱',
            name: { ro: 'Țările de Jos', en: 'Netherlands', pl: 'Holandia' },
            maps: [
                { id: 'reymann', pct: 52.2 },
                { id: 'kdr', pct: 36.0 }
            ]
        },
        {
            code: 'DK',
            flag: '🇩🇰',
            name: { ro: 'Danemarca', en: 'Denmark', pl: 'Dania' },
            maps: [
                { id: 'kdr', pct: 52.7 },
                { id: 'reymann', pct: 50.8 },
                { id: 'chrzanowski', pct: 14.0 },
                { id: 'ukvme', pct: 8.0 }
            ]
        },
        {
            code: 'EE',
            flag: '🇪🇪',
            name: { ro: 'Estonia', en: 'Estonia', pl: 'Estonia' },
            maps: [
                { id: 'ukvme', pct: 86.8 },
                { id: 'kdwr', pct: 11.3 },
                { id: 'chrzanowski', pct: 10.3 }
            ]
        },
        {
            code: 'CH',
            flag: '🇨🇭',
            name: { ro: 'Elveția', en: 'Switzerland', pl: 'Szwajcaria' },
            maps: [
                { id: 'reymann', pct: 52.2 },
                { id: 'kdr', pct: 20.6 }
            ]
        }
    ];

    // ── Instanțe de straturi Leaflet ──
    // Hărțile CENAGIS care au deja un rând premium dedicat în index.html
    // folosesc acel rând, nu sunt duplicate în catalogul de mai jos.
    var SHARED_PREMIUM_MAP_KEYS = {
        ukvme: true, chrzanowski: true, reymann: true,
        kdr: true, kdr_gb: true, wig100k: true, kummersberg: true
    };
    var _leafletLayers = Object.create(null);
    var _leafletOpacity = Object.create(null);
    var _activeMap = null;
    var _selectedCountryCode = null;
    var _selectedCountryBounds = null;
    var _availableMapCount = 0;

    function getLang() {
        try {
            var docLang = document.documentElement && document.documentElement.lang;
            if (docLang === 'en' || docLang === 'ro' || docLang === 'pl') return docLang;
            var stored = root.localStorage && root.localStorage.getItem('detectlab_lang');
            if (stored === 'en' || stored === 'ro' || stored === 'pl') return stored;
            if (root.DetectLabSite && root.DetectLabSite.defaultLanguage) return root.DetectLabSite.defaultLanguage;
        } catch (e) {}
        return 'ro';
    }

    function getMapInstance() {
        return _activeMap || root._dlMap || root.map || null;
    }

    function normalizeBounds(bounds) {
        if (!bounds) return null;
        if (Array.isArray(bounds)) {
            if (bounds.length === 4 && bounds.every(function (v) { return isFinite(Number(v)); })) {
                return [Number(bounds[0]), Number(bounds[1]), Number(bounds[2]), Number(bounds[3])];
            }
            if (bounds.length >= 2 && Array.isArray(bounds[0]) && Array.isArray(bounds[1])) {
                // Leaflet lat/lng corner pairs: [[south, west], [north, east]].
                return [
                    Math.min(Number(bounds[0][1]), Number(bounds[1][1])),
                    Math.min(Number(bounds[0][0]), Number(bounds[1][0])),
                    Math.max(Number(bounds[0][1]), Number(bounds[1][1])),
                    Math.max(Number(bounds[0][0]), Number(bounds[1][0]))
                ];
            }
        }
        if (typeof bounds === 'object') {
            var west = typeof bounds.getWest === 'function' ? bounds.getWest() : bounds.west;
            var south = typeof bounds.getSouth === 'function' ? bounds.getSouth() : bounds.south;
            var east = typeof bounds.getEast === 'function' ? bounds.getEast() : bounds.east;
            var north = typeof bounds.getNorth === 'function' ? bounds.getNorth() : bounds.north;
            if ([west, south, east, north].every(function (v) { return isFinite(Number(v)); })) {
                return [Number(west), Number(south), Number(east), Number(north)];
            }
        }
        return null;
    }

    function mapBoundsArray(mapMeta) {
        var b = mapMeta && mapMeta.bounds;
        if (!Array.isArray(b) || b.length < 2 || !Array.isArray(b[0]) || !Array.isArray(b[1])) return null;
        // Catalog coordinates use [[south, west], [north, east]].
        return [Number(b[0][1]), Number(b[0][0]), Number(b[1][1]), Number(b[1][0])];
    }

    function boundsOverlap(a, b) {
        return !!(a && b && b[2] >= a[0] && b[0] <= a[2] && b[3] >= a[1] && b[1] <= a[3]);
    }

    function boxArea(b) {
        return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    }

    function overlapAreaBoxes(a, b) {
        var w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        var h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
        return (w > 0 && h > 0) ? w * h : 0;
    }

    // Rectangle intersection alone lets neighbouring countries' sheets leak
    // into the window where catalog extents merely graze the country's bbox
    // (a Polish WIG box clipping Denmark's bbox has ZERO data for Denmark).
    // For countries outside the curated analysis demand a substantial
    // overlap: at least 5% of the country's box OR at least 5% of the sheet.
    function substantialCountryCoverage(countryB, extentB) {
        if (!countryB || !extentB) return false;
        var o = overlapAreaBoxes(countryB, extentB);
        if (!(o > 0)) return false;
        return o >= 0.05 * boxArea(countryB) || o >= 0.05 * boxArea(extentB);
    }

    function isSharedPremiumMap(mapKey) {
        return !!SHARED_PREMIUM_MAP_KEYS[mapKey];
    }

    function getMapsOverlappingBounds(bounds, includeShared) {
        var countryBounds = normalizeBounds(bounds);
        return Object.keys(MAPS_CATALOG).filter(function (mapKey) {
            if (!includeShared && isSharedPremiumMap(mapKey)) return false;
            var extent = mapBoundsArray(MAPS_CATALOG[mapKey]);
            return !countryBounds || boundsOverlap(countryBounds, extent);
        }).map(function (mapKey) { return mapKey; });
    }

    function findCountry(countryCode) {
        var code = String(countryCode || '').toUpperCase();
        return COUNTRIES_DATA.find(function (country) {
            return country.code === code || (country.code === 'BE-LU' && (code === 'BE' || code === 'LU'));
        }) || null;
    }

    function createLeafletLayer(mapKey) {
        if (_leafletLayers[mapKey]) return _leafletLayers[mapKey];
        var mapMeta = MAPS_CATALOG[mapKey];
        if (!mapMeta) return null;

        var paneName = 'pane_cenagis_' + mapKey;
        var mapInst = getMapInstance();
        if (mapInst && typeof mapInst.createPane === 'function' && !mapInst.getPane(paneName)) {
            mapInst.createPane(paneName);
            var pane = mapInst.getPane(paneName);
            if (pane) {
                pane.style.zIndex = 635;
                pane.style.pointerEvents = 'none';
            }
        }

        var options = {
            // WMS_BASE_URL is .../geoserver/ihpan/wms — the workspace prefix
            // must be `ihpan`, not the stock GeoServer `topp`. The old value
            // happened to resolve because this server matches the layer by
            // local name, but it was wrong and would break on any GeoServer
            // that validates the prefix strictly (or if `topp` ever exists
            // there with a same-named layer).
            layers: 'ihpan:' + mapMeta.wms_layer,
            format: 'image/png',
            transparent: true,
            version: '1.3.0',
            crs: L.CRS.EPSG3857,
            opacity: _leafletOpacity[mapKey] == null ? 0.80 : _leafletOpacity[mapKey],
            pane: paneName,
            attribution: '© ' + mapMeta.provider + ' · <a href="https://pastmaps.cenagis.edu.pl" target="_blank" rel="noopener">CENAGIS</a> / <a href="https://atlasfontium.pl" target="_blank" rel="noopener">IH PAN</a>'
        };
        // Ask the WMS for pixels only where the map sheet has a footprint.
        if (mapMeta.bounds && typeof L.latLngBounds === 'function') {
            options.bounds = L.latLngBounds(mapMeta.bounds);
        }

        var layer = L.tileLayer.wms(WMS_BASE_URL, options);
        // For the WMS health guard (js/wms-health.js): which row + switch this
        // layer belongs to (.cenagis-map-row[data-map-id] / .cenagis-toggle),
        // and the title to name it in the “server is down” notice.
        layer._detectlabUiKeys = [mapKey];
        layer._detectlabUiTitle = mapMeta.title[lang] || mapMeta.title.en || mapMeta.title.ro || mapKey;
        _leafletLayers[mapKey] = layer;
        return layer;
    }

    function toggleCenagisLayer(mapKey, on) {
        var mapInst = getMapInstance();
        if (!mapInst) return;
        var layer = createLeafletLayer(mapKey);
        if (!layer) return;

        if (on) {
            var masterToggle = document.getElementById('histPremiumToggle');
            if (masterToggle && !masterToggle.checked) masterToggle.checked = true;
            if (!mapInst.hasLayer(layer)) layer.addTo(mapInst);
        } else if (mapInst.hasLayer(layer)) {
            mapInst.removeLayer(layer);
        }

        // There is one checkbox per catalog map; this also remains safe if a
        // future country view renders the same map in more than one section.
        var checkboxes = document.querySelectorAll('.cenagis-toggle[data-map-key="' + mapKey + '"]');
        checkboxes.forEach(function (cb) {
            if (cb.checked !== on) cb.checked = on;
        });

        if (typeof root.updatePremiumMapCoverageVisibility === 'function') {
            root.updatePremiumMapCoverageVisibility();
        }
    }

    function setCenagisLayerOpacity(mapKey, val) {
        var layer = createLeafletLayer(mapKey);
        var opacity = val / 100;
        _leafletOpacity[mapKey] = opacity;
        if (layer && typeof layer.setOpacity === 'function') layer.setOpacity(opacity);

        var sliders = document.querySelectorAll('.cenagis-opacity-slider[data-map-key="' + mapKey + '"]');
        sliders.forEach(function (slider) {
            if (slider.value !== String(val)) slider.value = String(val);
        });
        var pctLabels = document.querySelectorAll('.cenagis-pct[data-map-key="' + mapKey + '"]');
        pctLabels.forEach(function (label) { label.textContent = val + '%'; });
    }

    // The old European-only master switch is now an alias for the combined
    // Historical Maps group. Turning that parent OFF clears these WMS layers.
    function toggleHistEuLayer(on) {
        var masterToggle = document.getElementById('histPremiumToggle');
        if (on) {
            if (masterToggle) masterToggle.checked = true;
            return;
        }
        var mapInst = getMapInstance();
        Object.keys(_leafletLayers).forEach(function (key) {
            var layer = _leafletLayers[key];
            if (mapInst && layer && mapInst.hasLayer(layer)) mapInst.removeLayer(layer);
        });
        document.querySelectorAll('.cenagis-toggle').forEach(function (cb) { cb.checked = false; });
    }

    function filterForCountry(countryCode, bounds) {
        var code = countryCode && String(countryCode).toUpperCase() !== 'ALL'
            ? String(countryCode).toUpperCase() : null;
        var normalizedBounds = normalizeBounds(bounds);
        if (!normalizedBounds && code && root._detectlabSelectedCountry === code) {
            normalizedBounds = normalizeBounds(root._detectlabCountryBounds);
        }

        _selectedCountryCode = code;
        _selectedCountryBounds = normalizedBounds;

        var availableIds;
        var country = code ? findCountry(code) : null;
        if (!code) {
            availableIds = getMapsOverlappingBounds(null, false);
        } else if (country) {
            // The curated coverage list (COUNTRIES_DATA, pct > 0) is the
            // source of truth for the analyzed countries: rectangle overlap
            // alone leaks neighbouring countries' sheets into the window —
            // a Polish WIG sheet whose box clips Denmark's bbox is not a map
            // of Denmark. Shared premium sheets are hosted on their premium
            // rows in index.html and are not duplicated in this catalog.
            availableIds = country.maps.map(function (entry) { return entry.id; })
                .filter(function (id) { return !isSharedPremiumMap(id); });
        } else if (normalizedBounds) {
            // Country outside the curated analysis (Italy, Norway…): fall
            // back to the sheets' own extents, but only where the sheet
            // substantially covers the country — a box that merely grazes
            // the country's bbox is not a map of this country.
            availableIds = getMapsOverlappingBounds(normalizedBounds, false).filter(function (id) {
                return substantialCountryCoverage(normalizedBounds, mapBoundsArray(MAPS_CATALOG[id]));
            });
        } else {
            // An unknown ISO without geometry must not accidentally see the
            // whole catalog.
            availableIds = [];
        }

        var available = Object.create(null);
        availableIds.forEach(function (id) { available[id] = true; });
        var rows = document.querySelectorAll('.cenagis-map-row');
        var rowCount = 0;
        rows.forEach(function (row) {
            var id = row.getAttribute('data-map-id');
            var isAvailable = !code || !!available[id];
            row.classList.toggle('country-layer-unavailable', !isAvailable);
            row.setAttribute('aria-hidden', isAvailable ? 'false' : 'true');
            row.style.display = isAvailable ? '' : 'none';
            if (isAvailable) rowCount++;
        });
        _availableMapCount = rowCount;

        var section = document.getElementById('histEuMapsSection');
        if (section) {
            // Keep the catalog heading/status visible even when this country
            // has no CENAGIS rows; the matching legacy premium sheets (if any)
            // still live alongside it in the same accordion.
            section.classList.remove('country-layer-unavailable');
            section.setAttribute('aria-hidden', 'false');
        }
        var empty = document.getElementById('cenagisNoMaps');
        if (empty) empty.style.display = code && rowCount === 0 ? 'block' : 'none';
        var status = document.getElementById('histEuFilterStatus');
        if (status) {
            var country = code ? findCountry(code) : null;
            var name = country && (country.name[getLang()] || country.name.en || country.name.ro);
            if (!name && code && root._detectlabSelectedCountryName) name = root._detectlabSelectedCountryName;
            if (!name) name = code || (getLang() === 'ro' ? 'toate țările' : 'all countries');
            status.textContent = code
                ? (getLang() === 'ro'
                    ? rowCount + ' hărți cu acoperire parțială sau totală pentru ' + name + '.'
                    : rowCount + ' maps overlap ' + name + ' partially or completely.')
                : (getLang() === 'ro'
                    ? 'Selectează o țară pe glob pentru a vedea hărțile care o intersectează.'
                    : 'Choose a country on the globe to see maps that overlap it.');
        }
        return rowCount;
    }

    function filterCountry(countryCode) {
        return filterForCountry(countryCode, null);
    }

    function hasAvailableMaps() {
        return _availableMapCount > 0;
    }

    function showMapInfo(mapKey) {
        var meta = MAPS_CATALOG[mapKey];
        if (!meta) return;
        var lang = getLang();
        var title = meta.title[lang] || meta.title.en || meta.title.ro;
        var desc = (lang === 'ro')
            ? ('Scară: ' + meta.scale + '\nPerioadă / Ani: ' + meta.years + '\nSursă / Institut: ' + meta.provider + '\nEndpoint: ' + WMS_BASE_URL + '\nStrat WMS: ihpan:' + meta.wms_layer)
            : ('Scale: ' + meta.scale + '\nPeriod / Years: ' + meta.years + '\nSource / Institute: ' + meta.provider + '\nEndpoint: ' + WMS_BASE_URL + '\nWMS Layer: ihpan:' + meta.wms_layer);

        if (typeof root.showLayerInfo === 'function') {
            root.showLayerInfo(title, desc);
        } else {
            alert(title + '\n\n' + desc);
        }
    }

    // ── Generare a catalogului plat în interiorul grupului premium unic ──
    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function renderUi() {
        var container = document.getElementById('histEuMapsSection');
        if (!container) return;

        var lang = getLang();
        var mapKeys = Object.keys(MAPS_CATALOG).filter(function (key) {
            return !isSharedPremiumMap(key);
        });
        mapKeys.sort(function (a, b) {
            var aTitle = MAPS_CATALOG[a].title[lang] || MAPS_CATALOG[a].title.en || MAPS_CATALOG[a].title.ro;
            var bTitle = MAPS_CATALOG[b].title[lang] || MAPS_CATALOG[b].title.en || MAPS_CATALOG[b].title.ro;
            return aTitle.localeCompare(bTitle, lang);
        });

        var heading = (lang === 'ro') ? 'Hărți europene · CENAGIS / IH PAN' : 'European maps · CENAGIS / IH PAN';
        var emptyText = (lang === 'ro') ? 'Nu există alte hărți CENAGIS pentru țara selectată.' : 'No other CENAGIS maps cover the selected country.';
        var html = [];
        html.push('<div class="cenagis-catalog-title" style="padding-top:8px;border-top:1px solid rgba(200,169,110,0.2);font-size:0.72rem;font-weight:600;letter-spacing:0.04em;color:rgba(200,169,110,0.95);">' + heading + '</div>');
        html.push('<div id="histEuFilterStatus" aria-live="polite" style="font-size:0.66rem;color:rgba(245,240,235,0.55);line-height:1.35;">' + (lang === 'ro' ? 'Selectează o țară pe glob pentru a vedea hărțile care o intersectează.' : 'Choose a country on the globe to see maps that overlap it.') + '</div>');
        html.push('<div id="cenagisNoMaps" style="display:none;font-size:0.68rem;color:rgba(245,240,235,0.55);">' + emptyText + '</div>');
        html.push('<div class="cenagis-map-list" style="display:flex;flex-direction:column;gap:7px;">');

        mapKeys.forEach(function (mapKey) {
            var mapMeta = MAPS_CATALOG[mapKey];
            var title = mapMeta.title[lang] || mapMeta.title.en || mapMeta.title.ro;
            var safeKey = mapKey.replace(/[^a-z0-9_-]/gi, '_');
            var activeMap = getMapInstance();
            var leafletLayer = _leafletLayers[mapKey];
            var isOnMap = !!(activeMap && leafletLayer && activeMap.hasLayer && activeMap.hasLayer(leafletLayer));
            var opacityPercent = Math.round((_leafletOpacity[mapKey] == null ? 0.80 : _leafletOpacity[mapKey]) * 100);
            html.push('<div id="cenagisMapRow_' + safeKey + '" class="cenagis-map-row hist-eu-map-row" data-map-id="' + escapeHtml(mapKey) + '" style="background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.06);border-radius:5px;padding:6px;">');
            html.push('  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:4px;">');
            html.push('    <div style="min-width:0;flex:1;">');
            html.push('      <div style="font-size:0.74rem;color:#f5f0eb;font-weight:500;line-height:1.25;word-break:break-word;">' + escapeHtml(title) + '</div>');
            html.push('      <div style="font-size:0.62rem;color:rgba(245,240,235,0.6);margin-top:2px;">' + escapeHtml(mapMeta.scale) + ' · ' + escapeHtml(mapMeta.years) + '</div>');
            html.push('    </div>');
            html.push('    <label class="apm-toggle-switch" style="transform:scale(0.8);transform-origin:right top;flex-shrink:0;" title="Toggle ' + escapeHtml(title) + '">');
            html.push('      <input type="checkbox" class="cenagis-toggle" data-map-key="' + escapeHtml(mapKey) + '"' + (isOnMap ? ' checked' : '') + ' onchange="DetectLabEuMaps.toggleCenagisLayer(\'' + escapeHtml(mapKey) + '\', this.checked)">');
            html.push('      <span class="apm-toggle-track"></span>');
            html.push('    </label>');
            html.push('  </div>');
            html.push('  <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">');
            html.push('    <span style="font-size:0.66rem;color:rgba(245,240,235,0.45);">Opacity</span>');
            html.push('    <input type="range" class="transp-slider cenagis-opacity-slider" data-map-key="' + escapeHtml(mapKey) + '" min="0" max="100" value="' + opacityPercent + '" style="flex:1;height:4px;margin:0 4px;" oninput="DetectLabEuMaps.setCenagisLayerOpacity(\'' + escapeHtml(mapKey) + '\', this.value)">');
            html.push('    <span style="display:flex;align-items:center;gap:4px;">');
            html.push('      <span class="pct cenagis-pct" data-map-key="' + escapeHtml(mapKey) + '" style="font-size:0.66rem;color:rgba(245,240,235,0.7);min-width:24px;text-align:right;">' + opacityPercent + '%</span>');
            html.push('      <button type="button" class="layer-info-btn" onclick="event.stopPropagation();DetectLabEuMaps.showMapInfo(\'' + escapeHtml(mapKey) + '\')" title="Layer info" style="background:none;border:none;cursor:pointer;color:rgba(200,169,110,0.8);padding:1px;"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7.5" r="1.3" fill="currentColor"/><rect x="10.8" y="10.5" width="2.4" height="7" rx="1.2" fill="currentColor"/></svg></button>');
            html.push('    </span>');
            html.push('  </div>');
            html.push('</div>');
        });
        html.push('</div>');

        container.innerHTML = html.join('\n');
        filterForCountry(_selectedCountryCode, _selectedCountryBounds);
    }

    // ── Export public ──
    var DetectLabEuMaps = {
        catalog: MAPS_CATALOG,
        countries: COUNTRIES_DATA,
        sharedPremiumMapKeys: SHARED_PREMIUM_MAP_KEYS,
        toggleCenagisLayer: toggleCenagisLayer,
        setCenagisLayerOpacity: setCenagisLayerOpacity,
        toggleHistEuLayer: toggleHistEuLayer,
        filterCountry: filterCountry,
        filterForCountry: filterForCountry,
        getMapsOverlappingBounds: getMapsOverlappingBounds,
        hasAvailableMaps: hasAvailableMaps,
        showMapInfo: showMapInfo,
        renderUi: renderUi,
        init: function (leafletMap) {
            if (leafletMap) _activeMap = leafletMap;
            if (root._detectlabSelectedCountry) {
                filterForCountry(root._detectlabSelectedCountry, root._detectlabCountryBounds);
            }
            renderUi();
            // map-app.js may have run the first country filter before this
            // catalog script finished rendering its dynamic map rows. Re-run
            // once so the combined parent group is evaluated with real matches.
            if (root._detectlabSelectedCountry && typeof root.filterLayersForCountry === 'function') {
                root.filterLayersForCountry(root._detectlabSelectedCountry);
            }
            document.addEventListener('detectlab:langchange', function () {
                renderUi();
            });
        }
    };

    root.DetectLabEuMaps = DetectLabEuMaps;
    // Compatibility alias for existing integrations; there is no longer a
    // second European Historical Maps parent group in the layer panel.
    root.toggleHistEuLayer = toggleHistEuLayer;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            DetectLabEuMaps.init();
        });
    } else {
        DetectLabEuMaps.init();
    }

}(window));
