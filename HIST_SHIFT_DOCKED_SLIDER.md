# „Mută harta istorică" nu mai moare când sliderul ei e pe ecranul principal

Data: 2026-10-20 · Modul: `js/hist-shift.js` ·
Test: `node test-hist-shift.js` (secțiunea „slider on the main screen")

---

## Simptom

Funcția **„Mută harta istorică"** (long-press pe hartă → panou cu switch →
drag care aliniază harta istorică, vezi `HISTORICAL_MAP_SHIFT.md`) **nu
funcționa deloc dacă sliderul stratului istoric era adăugat pe ecranul
principal** (oglinda verticală de opacitate). Long-press-ul nu mai deschidea
panoul, ca și cum gestul n-ar fi existat. Fără slider pe ecran, aceeași
secvență mergea perfect.

## Cauză

`isUiTarget()` din `js/hist-shift.js` decide dacă o apăsare a început pe un
element de UI (buton, control Leaflet, marker, panou) — caz în care nu
pornește nici long-press-ul, nici drag-ul din modul mutare. Decizia era un
`closest()` **fără limită**, cu selectori substring largi:

```js
el.closest('button, …, #histShiftPanel, [class*="panel"], [class*="dock"], …')
```

Când un slider e pe ecranul principal, `js/vertical-opacity-control.js`
pune clase de stare pe **`<body>`**:

- `vo-josephine-docked` (+ `…-secondary`) — sliderul **Hărții Iosefine**
  (Josephine Map +, `syncLayerActions`, ca panoul „Setări detecție" să se
  ancoreze lângă oglindă);
- `layer-dock-open` — dock-ul de acțiune al unui slider de distanță/rază
  (`syncDistanceDock`);

iar `js/map-app.js` adaugă `transp-panel-open` cât panoul de straturi e
deschis. Toate conțin `dock` sau `panel`, deci `[class*="dock"]` /
`[class*="panel"]` se potriveau chiar pe `<body>`, pentru **orice** țintă
din hartă (toate sunt descendente ale `body`). Orice `pointerdown` pe hartă
era clasificat „pe UI": long-press-ul nu pornea (panoul nu apărea), iar
dacă modul mutare ar fi fost pornit altcumva, niciun drag nu începea.

Verificat în browser real (aplicația completă, Chromium, gesturi touch, RO
selectată, Harta Iosefină pornită): fără slider, long-press →
`press=true`, panoul apare; cu sliderul ei pe ecran, `body.className` =
`is-pwa country-selected vo-josephine-docked`,
`mapContainer.closest('<selectorul>') === BODY`, `press` rămâne gol.
Ștergerea doar a clasei de pe `body` (sliderul rămânând pe ecran) reanimează
imediat long-press-ul — semnătura exactă a cauzei.

## Fix

**`js/hist-shift.js`** (`VERSION 2026-10-20-hist-shift-v2`):

- `isUiTarget()` urcă acum din nod în nod (`matches()` pe fiecare strămoș)
  și **se oprește la containerul hărții** (`map.getContainer()`). O țintă e
  „pe UI" doar dacă elementul interactiv e *în* hartă: controale Leaflet,
  markere, popup-uri, propriul `#histShiftPanel`, orice element
  `*panel*`/`*dock*` aflat efectiv în container. Clasele de stare de pe
  `<body>` (sau de pe orice strămoș din afara hărții) nu mai pot otrăvi
  decizia.
- Comportamentul pentru țintele UI reale din hartă nu se schimbă (aceiași
  selectori); fără container cunoscut se cade pe `closest()`-ul clasic.

Nicio altă logică nu e atinsă: descoperirea straturilor, clamp-ul de
300 m, persistența, lock-ul rămân ca în `HISTORICAL_MAP_SHIFT.md`.

## Rulare în PWA

`index.html` — `js/hist-shift.js?v=20261020-hist-shift-docked-slider`;
`sw.js` — URL-ul nou în `PRECACHE_URLS` (cel vechi rămâne pentru shell-uri
deja instalate), `CACHE_NAME` → `detectlab-v241-hist-shift-docked-slider`.
CSS-ul nu s-a schimbat. Aserțiunea de cache exact-v240 din
`test-3d-analysis-points.js` a fost relaxată la „v240 sau mai nou" (ca la
restul testelor de shell).

## Verificare

`node test-hist-shift.js` — `FakeEl` are acum `matches()`/`closest()`/
`parentElement` reali, iar noua secțiune acoperă:

1. cu fiecare clasă de stare pe `<body>` (`vo-josephine-docked`,
   `vo-josephine-docked-secondary`, `layer-dock-open`, `transp-panel-open`)
   long-press-ul pornește pe o țintă din hartă;
2. panoul apare efectiv după ~550 ms de ținere apăsat cu
   `vo-josephine-docked` setat;
3. țintele UI reale **din** hartă (`.leaflet-control`, un element
   `*panel*` în container, un `<button>`) blochează în continuare gestul;
4. în modul mutare, drag-ul din hartă deplasează suprapunerea și cu clasa
   docked prezentă, dar nu pornește dintr-un control.

Falsificare pe codul vechi (`closest()` nelegat): `AssertionError:
long-press starts with body.vo-josephine-docked (slider on the main
screen)` — exact simptomul raportat.

Suplimentar, verificat cap-coadă în browser (Harta Iosefină pornită +
sliderul ei pe ecran): long-press → panou → switch ON → drag deplasează
`pane_josephine` (offset + `transform` aplicat), centrul hărții de bază
nemiscat. Suita completă `test-*.js`: 107 trec; `test-albania-asig-layers.js`
și `test-analysis-layers-3d.js` pică identic și pe `main` (preexistente,
fără legătură).
