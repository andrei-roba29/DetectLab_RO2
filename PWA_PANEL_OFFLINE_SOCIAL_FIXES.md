# PWA: fereastra de straturi, culorile sliderelor, detectoriștii și harta offline

Reparațiile cerute după testarea pe telefon (16 septembrie 2026). Nouă puncte, fiecare cu
cauza sa reală — mai jos sunt enumerate în ordinea în care au fost raportate.

Regula generală a tuturor punctelor: **un PWA instalat servește ce are în cache**. De aceea
fiecare reparație de aici vine cu `CACHE_NAME` bump în `sw.js`
(`detectlab-v98-pwa-panel-offline-exit`) și cu `?v=20260916-pwa-panel-offline-exit` pe
fișele atinse (`css/styles.css`, `css/offline-maps.css`, `js/translations.js`,
`js/friends.js`, `js/map-app.js`, `js/offline-maps.js`, `js/vertical-opacity-control.js`,
`js/archeo-potential.js`, `js/lidar-scanner.js`, `js/archeo-report.js`, `js/tutorial.js`);
fără acest pas, instalarea de pe telefon ar fi continuat să arate CSS-ul vechi.

---

## 1. Titlul sliderului a ieșit din card

**Cauza.** „Oglinda" de opacitate/distanță de pe hartă (`.vertical-opacity-control`) își
punea numele stratului *în interiorul* cardului, deasupra sliderului. Cu border, fundal
și blur pe card, titlul arăta ca un rând de panou căzut pe hartă — și ocupa spațiu unui
slider care oricum e înalt cât ecranul.

**Reparația.** `index.html` are acum un `<span class="vertical-opacity-title">` (cu
`#verticalOpacityCaption` + `#verticalOpacityLayer`) **frate al cardului**, iar CSS-ul îl
ancorează deasupra lui:

```css
.vertical-opacity-title { position: absolute; bottom: calc(100% + 7px); left: 50%; transform: translateX(-50%); }
.vertical-opacity-title:empty { display: none; }   /* fără titlu → fără spațiu liber */
```

Cardul nu mai conține titlul; la `@media (max-height: 500px)` distanța se strânge, nu se
mută titlul înapoi înăuntru.

## 2. Padding-ul albastru de jos a dispărut

**Cauza.** `.transp-panel` avea `padding: 22px 16px` — iar fiindcă fereastra era
`height: 560px`, ultimii 22px din jos erau fundalul panoului, vizibil ca o fâșie
albastru-închis sub ultimul rând.

**Reparația inițială.** `padding: 22px 16px 0` în `css/styles.css` (panoul își face singur spațiul
între rânduri), plus `padding-bottom: 0 !important` în override-ul PWA din `index.html`, care
altfel moștenea fâșia veche.

**Corecție după testarea pe telefon (v263, 24 octombrie 2026).** Eliminarea întregului padding
jos făcea ultimele rânduri și butoane să ajungă sub bara nativă de jos, fără să elimine banda
închisă. În PWA, fereastra păstrează acum `bottom: 0`, dar adaugă o rezervă de minimum 44px
(sau inset-ul safe-area dacă e mai mare). Gradientele bleumarin sunt dimensionate să se oprească
înaintea acestei rezerve, deci spațiul rămâne transparent și harta se vede dedesubt:
`body.is-pwa .transp-panel` din `index.html`. Testul actualizat este
`node test-pwa-layer-panel.js`.

## 3. Fereastra de straturi nu mai se oprește la jumătate

**Cauza.** Două lucruri, ambele de reparat: panoul avea **lungime fixă** (`height: 560px` /
`max-height: 560px`), iar în PWA i se mai scădea și banda de controale de jos
(`calc(100% - var(--pwa-bottom-controls-clearance))`) — deci se termina cam la jumătatea ecranului.
Peste asta, PWA-ul instalat servea din cache CSS-ul vechi, deci nicio reparare pură de CSS nu
ajungea pe telefon.

```css
.transp-panel { top: 0; bottom: 0; height: auto; max-height: none; }
body.is-pwa .transp-panel {
  bottom: 0;
  min-height: max(100vh, var(--dl-vvh, 100vh));
  padding-bottom: var(--pwa-panel-bottom-clearance);
}
```

Ultima regulă include rezerva transparentă introdusă în v263 (detaliată mai sus), nu mai
oprește panoul la `env(safe-area-inset-bottom)`. Măsurat în Chromium la 412×915:
`top = 0`, `bottom = 915`, `padding: 22px 16px 0`. În
plus, cât timp fereastra e deschisă, stiva flotantă din dreapta-jos (locație live + cont) se
mută pe marginea stângă
(`body.is-pwa.transp-panel-open #pwa-br-stack { left: max(10px, …); right: auto; }`), ca să
nu acopere un rând de comutatoare. Starea „deschis" e publicată pe `<body>` de un singur setter
(`markTranspPanelOpen()` în `js/map-app.js`), folosit atât la deschidere cât și la închiderea
din click-în-afară — altfel CSS-ul ajungea să mute stiva după o stare depășită.

## 4. sliderele poartă culoarea stratului

**Cauza.** Pinul și cercul de rază ale celor trei straturi de analiză au culori proprii,
dar track-ul și thumb-ul sliderului erau toți verzi (culoarea generală a panoului), deci
sliderul nu „semăna" cu raza pe care o regla.

**Reparația.** Paleta stă lângă codul care desenează pinul, sub formă de variabile CSS, și
acoperă **atât rândul din panou cât și oglinda verticală**:

| Strat | Pin / cerc pe hartă | Variabile |
|---|---|---|
| LIDAR Scanner | contur `#8cff66`, umplere `#39ff14` | `--dl-layer-colour / -strong / -soft / -edge` |
| Zone cu potențial arheologic | `#a070e8` / `#c4a0f0` | la fel |
| Raport arheologic | `#66c8ff` / `#29b6f6` | la fel |

`js/vertical-opacity-control.js` (neschimbat) scrie deja `data-owner` + `data-kind` pe
oglindă, deci regulile `.vertical-opacity-control[data-owner="…"]` moștenesc aceleași
variabile de pe `#lidarScannerRow` / `#archeoPotentialRow` / `#archReportRow`. Track, thumb
(WebKit **și** `::-moz-range-thumb`) și chip-ul cu valoare se pictează din ele.

## 5. Lupita nu mai aprinde modul de detecție

**Cauza.** `searchNearbyDetectors()` („Vezi alți detectoriști în zonă") apela
`toggleDetection(true)` ca să aibă o poziție proprie. Asta nu doar că pornea GPS-ul:
aplica și cercurile de patrimoniu + stratul, alarma de proximitate, timerul de 10 h și
persista comutatorul în `localStorage` — cine voia doar să se uite în jur se trezea în mod
de detecție.

**Reparația.** Fluxul pornește **doar** locația live (`window._startLiveLocation()`), și o
oprește din nou dacă nu vine niciun fix — deci nu rămâne pe fundal un watcher de GPS pe care
utilizatorul nu l-a cerut niciodată. Regula de vizibilitate a fost simplificată odată cu el:

* **vizibil pentru alți detectoriști** = locație live pornită **și** răspuns „Da" la
  prompt (`_visibleToOthers`) — comutatorul Detect nu mai contează;
* toate cele opt locuri care publică prezența trec prin același `_presenceVisible()` (și
  oprirea locației live scrie `visible = false`), deci nicio cale nu poate publica un rând
  care să contrazică regula;
* **oprirea detecției nu te mai ascunde** atâta timp cât locația live merge; pinul
  dispare când se oprește locația live (sau când răspunsul devine „Nu").

**Actualizare.** Consimțământul se cere acum și din fluxul lupitei, cu **aceeași**
fereastră ca la switchul de detecție: după „Da / Yes" la întrebarea de 10 km,
„Vrei să fii vizibil și pentru alți utilizatori?" (Da/Nu) apare înainte ca ceva să
fie publicat, iar căutarea **așteaptă răspunsul** (dialogul de căutare se retrage
cât timp întrebarea e pe ecran și revine după răspuns). „Nu" nu oprește căutarea —
vezi vecinii fără să fii văzut — iar răspunsul intră în aceeași regulă
`_presenceVisible()`. Detalii în `FRIENDS_AND_CHAT.md`.

## 6. Butonul „Adaugă prietenie" apărea doar câteodată

**Cauza.** `Popup.update()` din Leaflet **reatribuie conținutul**: pentru un popup al cărui
conținut e un *string*, `_updateContent()` face `contentNode.innerHTML = this._content`.
`js/map-app.js` chema exact asta după ce `js/friends.js` pictase butonul — deci butonul era
șters imediat, și rămânea vizibil doar în ordinea întâmplătoare în care re-pictarea
ulterioară (listele de prieteni care se întorc asincron) prindea nodul. Al doilea defect:
re-pictarea târzie scria într-un slot deja înlocuit de Leaflet.

**Reparația.** `updateOpenDetectorPopup()` **nu mai randează din nou**: măsoară
(`_updateLayout()` / `_updatePosition()` / `_adjustPan()`) ca butonul să nu iasă din
fereastră, fără să atingă DOM-ul; `paintDetectorSlots(root)` re-interoghează sloturile în clipa
pictării (nu ține referințe după noduri); `ensureDetectorSocialState()` așteaptă
`window._authReadyPromise`, deci la reload panoul nu mai stă o clipă în stare
„neautentificat" (cazul în care butonul nici nu se picta).
`map.on('popupopen')` nu mai cheamă `popup.update()`.

## 7. Căutarea de detectoriști de adăugat a fost adusă înapoi

**Cauza.** Trei defecte suprapuse:

1. `search_social_users('')` nu întorcea nimic: `regexp_split_to_array('', '\s+')` este
   `{''}`, deci `cardinality(v_tokens) = 0` nu era niciodată adevărat — și
   `search_normalise()` avea `translate()` cu 31 de caractere „de" și 32 „la", deci `ñ`
   nu se plia deloc;
2. `user_social_profiles` conținea doar conturile care **deschiseseră vreodată** panoul
   Prieteni, deci majoritatea oamenilor pur și simplu nu existau în director
   (`send_friend_request()` răspundea `USER_NOT_FOUND`);
3. clientul căuta o singură dată (la paste, nu la tastare) și înghițea orice eroare a RPC-ului —
   un eșec de rețea arăta exact ca „nu există astfel de oameni".

**Reparația.**

* migrația `supabase/migrations/20260916020000_social_directory_projection.sql`:
  `mirror_social_profile()` + trigger pe `user_last_locations` (doar pe coloanele care
  interesează, no-op dacă rândul e deja complet — ca refresh-ul de poziție din ~30 s să nu
  scrie degeaba) și trigger INSERT-only pe `detector_presence`, plus backfill pentru
  conturile existente. `discoverable` nu e atins de trigger, deci un cont care s-a ascuns
  rămâne ascuns. Aceeași migrație rescrie `search_social_users()` cu `coalesce(cardinality(v_tokens), 0) = 0`
  și cu foldarea corectă.
* `js/friends.js`: tastarea e **debounced 300 ms**, un query gol **parcurge directorul** în loc
  să fie impas, iar `ensureProfile()` rulează înainte de căutare, fallback **client-side** pe `user_social_profiles`
  + `user_last_locations` cu aceeași pliere (`searchNormalise` / `searchTokens` /
  `matchesTokens`) dacă RPC-ul lipsește sau pică, iar motivul eșecului se afișează
  (`state.search.error`) în loc să fie înghițit. Expus și ca `DetectLabFriends.searchUsers()`
  / `getSearchResults()`, ca să poată fi acoperită și din alte teste.

## 8. Harta offline: doar poligon, fără „pin cu rază"

**Cauza.** Fluxul de desenare offline punea pe hartă și `circleMarker`-e la fiecare
vârf, iar prima apăsare genera un cerc de rază — adică suprapunea „pin cu rază" (un concept
al straturilor de analiză) peste desenarea unui teritoriu.

**Reparația.** `redrawPreview()` desenează acum un singur obiect: `L.polyline` în timpul
trasării și `L.polygon` de îndată ce există ≥ 3 vârfuri — **fără niciun marker și fără niciun
cerc** pe parcurs.
`createVertexMarkers()` / `removeVertexMarkers()` / starea `state.editing` / butonul
„✎ edit" / `previewMarkers` / linia de închidere au fost șterse, împreună cu CSS-ul lor
(`.offline-vertex-icon`, `.offline-first-vertex` și animațiile). Cheile de traducere `edit` /
`editing` / `closeHint` au dispărut odată cu ele (a rămas `finished` pentru inelul
închis).

Iar ca cele trei module de analiză să nu mai „tragă" un pin cu rază în mijlocul
desenării, `js/offline-maps.js` publică un singur flag —
`window._dlOfflineDrawActive` (pornit/oprit de `updateDrawModeFlag()`) — pe care
`js/lidar-scanner.js`, `js/archeo-potential.js` și `js/archeo-report.js` îl verifică în
`onMapClick` înainte să pună orice marker.

## 9. Butonul ✕ care dezactivează harta offline

**Ce face.** Cât timp un offline map e activ, pe marginea de jos, centrat, apare un buton
✕ (`#offlineMapExit`, `.offline-active-exit`) cu `title` / `aria-label` = **„Ieși din harta
offline" / “Exit the offline map"**. Un tap oprește tot ce a adus harta respectivă:
abandonează poligonul neterminat, **dezactivează straturile locale**, iese din modul offline
și redă biblioteca.

E montat de `ensureExitButton()` în `.map-frame` (deci se suprapune hărții, nu paginii, și
nu alunecă la scroll) și e vizibil doar cât timp `updateExitButton()` găsește un
`state.activeId`, deci nu poate rămâne pe ecran un ✕ care nu mai are ce opri.
Se ridică deasupra dock-ului de acțiuni cu
`bottom: calc(18px + env(safe-area-inset-bottom, 0px) + var(--layer-dock-clearance, 0px))`,
iar sub 420 px lățime rămâne doar gliful, cu numele acțiunii în `title` / `aria-label`.

---

## Ce nu ține de cele nouă puncte, dar a fost reparat oricum

`index.html` includea **de două ori** `js/hybrid-tile-switch.js` — un `</body>` prematur,
rămas după o comasare, urmat de un al doilea `<script>` identic. A doua includere arunca la
fiecare încărcare:

> `SyntaxError: Identifier 'supabaseBounds' has already been declared'`

un zgomot care maschează erorile reale din consolă. A fost șters primul `<script>` (cel de
după `</body>`-ul prematur, dinaintea modulelor „Vezi alți detectoriști" și „Vrei să fii
vizibil"); cel de la final rămâne, deci nici încărcarea, nici ordinea nu se schimbă.

---

## Pe server

Punctul 7 are nevoie și de o migrație nouă, altfel căutarea rămâne cu directorul gol:

```bash
supabase db push     # aplică supabase/migrations/20260916020000_social_directory_projection.sql
```

E idempotentă (toate obiectele `create or replace` / `drop ... if exists`, backfill-ul scrie
doar ce lipsește), deci a doua rulare nu schimbă nimic — iar fără ea clientul continuă să
funcționeze pe fallback-ul lui, doar cu mai puține rezultate.

---

## Cum verifici

```bash
node test-pwa-layer-panel.js          # 1-3: ancorare top→bottom, fără padding, stiva nu acoperă
node test-vertical-opacity-control.js # 1 + 4: titlul deasupra cardului, culorile pe strat
node test-offline-maps-panel.js       # 8 + 9: doar poligon, flag-ul de desenare, butonul ✕
node test-map-friend-actions.js       # 5 + 6: lupita nu atinge detecția, butonul nu e șters
node test-friends-social.js           # 7: căutarea, fallback-ul, migrația de proiecție
node test-detect-toggle-symmetry.js   # 5: simetria comutatorului / prezenței
node test-layer-visibility.js         # highlight-urile de acoperire + setterul de panou
node test-archeo-report.js            # textele de pagină + versiunile de asset
node test-tutorial.js                 # pașii de tutorial (locație live / offline) corecți
node test-nearby-offline-popup.js     # pop-up-urile nearby / offline
```

Pe telefon (PWA instalat, după ce SW-ul a prins `v98`):

1. Panoul de straturi se întinde până la marginea de jos, fără fâșie albastră sub ultimul
   rând, iar titlul oglinzii de opacitate e deasupra cardului.
2. LIDAR / potențial arheologic / raport arheologic: sliderul are aceeași culoare cu raza
   de pe hartă.
3. Lupita → se activează doar locația live; comutatorul Detect rămâne așa cum l-ai lăsat.
4. Atingi un pin de detectorist → butonul de prietenie apare de fiecare dată, inclusiv după
   ce aprobi o cerere.
5. Căutarea din „Adaugă prieteni" găsește la nume parțial și fără diacritice și arată lumea
   din director înainte să scrii orice.
6. Desenezi un offline map: apar doar liniile poligonului (fără puncte/cerc la vârfuri),
   iar jos, centrat, ✕-ul dezactivează harta la un tap.

---

## Vezi și

- `FRIENDS_AND_CHAT.md` — secțiunile 2, 5 și 6 pentru căutarea de persoane, butoanele din
  pinurile de detectorist și regula de vizibilitate (punctele 5–7 de aici);
- `ARCHEO_POTENTIAL.md` și `ARCH_REPORT.md` — pinii și cercurile ale căror culori le oglindește
  acum sliderul (punctul 4);
- `js/tutorial.js` — pașii „Locație live" și „Hărți offline" au fost rescriși ca să descrie
  noile comportamente (punctele 5, 8 și 9).
