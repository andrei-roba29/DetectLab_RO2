# „Alte hărți / Other maps” — hărți ne-georeferențiate (Hungaricana + National Library of Scotland)

**Cerere:** hărțile istorice care NU sînt georeferențiate — cele de pe
[maps.hungaricana.hu](https://maps.hungaricana.hu/) și, din octombrie 2026, cele din
[National Library of Scotland Map Finder](https://maps.nls.uk/geo/find/) care pe
portaluri apar doar printr-un nume de loc / o amprentă de foaie, nu ca strat aliniat —
să intre în aplicație ca sub-strat în grupul premium
**„Hărți istorice / Historical Maps”**, sub numele
**„Alte hărți / Other maps”**:

1. cînd stratul e pornit, fiecare loc care are hărți apare ca **punct verde
   semitransparent**;
2. punctele se **grupează exact ca siturile din stratul Patrimoniu**, în funcție de
   nivelul de zoom (un singur punct pentru mai multe locuri apropiate la distanță mare,
   din ce în ce mai puțin grupate pe măsură ce te apropii);
3. la apăsarea unui punct se deschide o **fereastră cu hărțile disponibile** în locul
   acela; oricare dintre ele poate fi **adăugată pe hartă**;
4. harta adăugată se **suprapune ca în Adobe/Photoshop**: o poți mișca în orice direcție
   fără să se miște baza, o poți roti și mări/micșora, iar potrivirea rămîne salvată.

---

## Harta Iosefină gratuită — acoperire estimată

`iosfree_db.json` asociază localități și coordonate cu scanări Wikimedia Commons.
Când „Other maps” este activ, ele apar ca discuri verde-închis, desenate
înaintea punctelor existente și disponibile și sub zoom 13. Apăsarea unui disc
deschide lista cu foaia corespunzătoare; la suprapunere, punctele existente au
prioritate, dar lista include și foile Iosefine. Discurile respectă opacitatea
stratului și scala geografică la zoom.

Catalogul nu conține poligoane ale localităților sau limite georeferențiate ale
foilor, deci acestea sunt **estimări**, nu contururi exacte. Localitățile aceleiași
foi sunt grupate în zone compacte (cel mult 25 km între oricare două puncte),
iar fiecare disc acoperă centrele grupului cu o marjă de 1 km (minimum 1,2 km
raza). Astfel, omonimele geocodate departe nu produc un disc pe jumătate de
țară. Mai multe discuri pot duce la aceeași foaie, fără a o duplica în catalog.
Calitatea pozițiilor depinde de `iosfree_db.json`.

## 1. De ce e nevoie de un modul separat

Un strat Leaflet este poziționat geografic: primește o anvelopă și Leaflet îi rescrie
containerul la fiecare pan. O hartă **ne-georeferențiată** nu are anvelopă, deci nu
poate fi un strat Leaflet. În locul ei, modulul ține propria stare de transformare:

```
ancoră (LatLng) · metri per pixel de imagine · rotație · opacitate
```

și o desenează într-un pane dedicat cu un singur lanț CSS:

```
translate3d(punctul ancorei) → rotate(θ) → scale(k) → translate(-jumătate)
```

Pentru că ancora e un LatLng real, iar dimensiunea vine din metri/pixel, harta se
comportă ca un strat de hartă atunci cînd miști baza — dar poziția, rotația și scara
rămîn la latitudinea ta.

## 2. De unde vin datele

| Lucru | Unde |
| --- | --- |
| Catalogul | `data/other-maps-catalog.json` |
| Piramida de tile-uri | `https://static-cdn.hungaricana.hu/tile/image/<path>/<hash>` |
| Miniatură (fără hash) | `https://static-cdn.hungaricana.hu/tile/thumb/<path>` |
| Dimensiunea naturală | `https://static-cdn.hungaricana.hu/tile/imagesize/<path>` |
| Paginua omului | `https://maps.hungaricana.hu/en/<Colecție>/<număr>/view/` |

Un tile nu se adresează prin `/z/x/y`, ci printr-un hash:

```
hash = AES-128-CBC(cheia „dGhpcyBpcyBubyBr”, IV zero) din
       „<sumaASCII(path) % 100>|<z>|<x>|<y>” completat cu '*' pînă la 16 octeți,
       primii 16 octeți de ciphertext, în hex
```

Schema a fost documentată de dezoomify (lovasoa/dezoomify, issue #346). Nota din issue
scrie ordinea `|x|y|z`, implementarea livrată de același autor folosește `|z|x|y`, iar
exemplul de ciphertext din issue corespunde primei citiri. Ca să nu pariez pe o
interpretare, `js/other-maps-tiles.js` implementă **ambele** ordini, o folosește pe cea
care a răspuns ultima și întoarce automat dacă un tile pică (`noteOrder()`), așa că
ambiguitatea o decide serverul, o singură dată.

Dimensiunea naturală se ia de la `/tile/imagesize/`; dacă acel endpoint nu e citibil
din browser (CORS), modulul **sondează** piramida: întreabă tile-ul `(0,0,z)` cu z
crescător ca să afle nivelul maxim, apoi numără tile-urile de pe rîndul și coloana de
sus. Rezultatul se păstrează în `localStorage` (`dlOtherMaps.pyramid.v1`).

## 2.1 A doua sursă: National Library of Scotland Map Finder

Din octombrie 2026 sub-stratul are o a doua sursă, complet independentă:
[maps.nls.uk/geo/find/](https://maps.nls.uk/geo/find/) — Map Finder-ul Bibliotecii
Naționale a Scoției (NLS), ~200 000 de scanări istorice, în mare parte britanice și
irlandeze. Sursa se numește `nls` și e servită de `js/other-maps-nls.js`, care se
înregistrează singură în dispatcherul de tile-uri din `js/other-maps-tiles.js`
(`registerSource('nls', …)`). Un record cu `source: "nls"` e rutat spre adapterul NLS;
un string de cale sau un record fără sursă rămîne pe drumul Hungaricana, deci
comportamentul vechi e neschimbat.

Două servicii publice NLS sînt folosite, ambele CORS-deschise:

| Lucru | Unde |
| --- | --- |
| Căutarea pe loc (footprint-uri) | `https://geoserver.nls.uk/geoserver/wfs` (GeoServer WFS 1.1.0) |
| Piramida de tile-uri (IIIF Image API 2) | `https://map-view.nls.uk/iiif/2/<prefix>%2F<id>/info.json` |
| Pagina omului | `https://maps.nls.uk/view/<id>` |
| Deep-link în finder | `https://maps.nls.uk/geo/find/#…&point=<lat>,<lng>` |

**Identificatorii.** Pentru o foaie cu id-ul de viewer `102345214`, identificatorul
IIIF e `10234/102345214` (primele cinci cifre, apoi id-ul complet), iar serviciul de
imagine e `https://map-view.nls.uk/iiif/2/10234%2F102345214`. Dacă serviciul `/iiif/2/`
nu răspunde, adapterul încearcă și formele moștenite `/iiif/<id>/info.json` și
`/iiif/1/<id>/info.json` (Image API 1.1, cu `tile_width`/`scale_factors`).

**Tile-urile sînt cereri IIIF canonice, nu hash-uri.** Adapterul mapează grila
`(x, y, nivel)` a overlay-ului pe regiuni: la nivelul `L`, factorul de scară e
`s = 2^(maxZoom−L)`, iar tile-ul `(x,y)` cere
`{bază}/{rx},{ry},{rw},{rh}/{tw},{th}/0/default.jpg`, cu muchiile clampate la
dimensiunea imaginii. `maxZoom` vine din `scaleFactors`-ii din `info.json` (sau din
regula 512 px cînd documentul nu listează gresia); miniatura e
`{bază}/full/256,/0/default.jpg`. Dimensiunile se țin în
`localStorage` (`dlOtherMaps.nls.pyramid.v1`).

**WFS — aceeași interogare pe care o face finder-ul NLS.** `wfsBBoxUrl()` construiește
un `GetFeature` pe cele 12 straturi de catalog (`nls:OS_6inch_all_find`,
`nls:OS_one_inch_combined`, …), cu cîte un filtru
`INTERSECTS(the_geom,SRID=4326;POLYGON(…))` per strat, unite cu `;`, și
`propertyName=(the_geom,IMAGE,SHEET,DATES,YEAR)` — `the_geom` e cerut explicit, altfel
GeoServer nu întoarce amprenta. `featureToRecord()` transformă fiecare feature în
forma de catalog a aplicației: `id: "nls/<IMAGE>"`, `path: <prefix>/<IMAGE>`, locul
după prefixul titlului foii (`"Accrington - Sheet 1 …"` → `Accrington`), anul din
`YEAR`/`DATES`, iar coordonatele punctului verde sînt centroidul bbox-ului amprentei.

**Descoperire live.** Catalogul static (`data/other-maps-nls-catalog.json`) e doar o
sămînță. Cît timp stratul e pornit, `other-maps.js` întreabă WFS-ul și pentru fereastra
curentă: cererea e debouncată (700 ms), nu pornește sub zoom 9 (o scară de țară ar
întoarce prea multe foi), nu pleacă în afara cutiei de acoperire NLS
(49.1–61°N, 12.9°V–1.8°E) și se memoizează pe celulă de jumătate de grad
(`nlsCellKey`, maxim 20 celule). Foile întoarse se unesc în același index de puncte verzi
ca cele două cataloage, dedublate după id; o eroare de rețea e silențioasă — punctele
Hungaricana și sămînța NLS rămîn vizibile.

**Sămînța offline.** `tools/build-nls-catalog.mjs` construiește catalogul static:
live, cu interogări punct WFS pentru o listă de orașe (`--place/--lat/--lng`), cu o
interogare de fereastră (`--bbox`), sau offline din răspunsuri WFS salvate
(`--json-dir ./director`), caz în care nu e nevoie de rețea. Sămînța livrată acum e
construită offline dintr-un răspuns WFS real (planuri cadastrale OS, Anglia): 262 de
foi din 73 de locuri.

## 3. Punctele verzi și gruparea

* `js/other-maps.js` încarcă **laziv** catalogul (doar cînd stratul e pornit întîia
  oară) și construiește un index spațial.
* Hărțile aceluiași loc se unesc într-o singură **locație** — portalul stochează un
  punct per loc, deci altfel am desena puncte identice unul peste altul.
* Locațiile se grupează cu **același helper și aceeași configurție ca Patrimoniu**
  (`js/patrimoniu-clustering.js`): 5 km la z6, 4 km la z7 … 1 km la z10, puncte
  individuale de la z11 în sus. Distanțele sînt în metri pe teren, nu în pixeli, deci
  gruparea înseamnă același lucru la orice latitudine și orice dimensiune de ecran.
* Un punct = o locație (verde semitransparent, puțin mai mare dacă locul are mai multe
  hărți, cu numărul lor pe el). Un grup geographic = o bulă cu numărul total de hărți.
* Click pe o **locație** → se deschide lista hărților. Click pe un **grup** → se dă
  zoom pînă cînd grupul se rupe (același gest ca la Patrimoniu).
* Două puncte vecine care se suprapun pe ecran (ex. Sighetu Marmației și comitatul,
  la ~350 m unul de altul) se deschid **împreună**: o singură fereastră listează
  foile amîndurora, ca să nu rămînă nicio hartă ascunsă în spatele altui punct.
* Hit-testul rulează pe evenimentul de click al hărții, nu pe canvas: pane-ul e
  `pointer-events: none`, ca să nu fure clickurile markerelor de dedesubt (aceeași
  soluție ca la stratul Patrimoniu).
* **Punctele rămîn blocate de tile-uri la zoom** (animații + pinch): pe timpul
  animației de zoom, Leaflet ține pane-ul hărții pe loc 250 ms și scalează prin CSS
  doar containerele de tile-uri. Canvas-ul punctelor (ca și rădăcinile foielor, vezi
  §4) primește aceeași transformare pe care o au deja canvas-urile Patrimoniu
  (`map-app.js`, `_updateCanvasTransform`): `zoomanim` (buton/dublu-click/scroll) și
  `zoom` cu `e.pinch` (pinch pe touch) aplică
  `translate(scale·ancoră − nouaOrigine) scale(scale)` — în spațiul de proiecție
  Web Mercator (liniar în zoom) fiecare pixel desenat ajunge exact la poziția lui la
  zoom-ul țintă. Glisa de 250 ms vine din `.leaflet-zoom-anim .leaflet-zoom-animated`
  (`css/leaflet.css`); redraw-ul la stabilire (move/zoomend) șterge transformarea.
  Fără aceasta, punctele „se mișcă sacadat” de la locul lor la zoom in/out.

## 4. Fereastra „Hărți disponibile” și suprapunerea

Fereastra listează hărțile locului (miniatură, titlu, subiect, colecție, an, autor) cu
două acțiuni: **„Adaugă pe hartă”** și **„Deschide pe Hungaricana”**. Subtitlul arată
locul și numărul de hărți — „Cluj-Napoca (RO) · 49 hărți” — sau, cînd o atingere adună
puncte vecine, „2 locuri · 9 hărți”.

După adăugare, harta devine o suprapunere liberă (`js/other-maps-overlay.js`) și se
deschide panoul de aliniere. Din prima încărcare foia apare **stabili și lizibilă, cu
proporțiile ei naturale** — nu ca un punct difuz care „schimbă formatul” la zoom:

* **Încadrare la adăugare** — o foie nouă e pusă la scara la care latura ei lungă
  ocupă ~70 % din marginea mai mică a ferestrei (aceeași regulă ca „Încadrează”), nu la
  o scară pe teren arbitrar de ~4 km care, la zoom de comitat, o desena ca un punct de
  cîțiva pixeli.
* **Nivelul din piramidă e ales ca să micșoreze, nu să mărimească** — cel mai apropiat
  nivel la care 1 pixel de nivel ≈ 1 pixel de ecran, urcat cu un nivel (k ≤ 1 = lizibil)
  cînd fereastra de tile-uri vizibile rămîne sub plafonul de 16 tile-uri.
* **Grila e tăiată la conturul foii** — tile-urile de 512 px ale serverului au margini
  în afara foiei la nivelurile groase; fără clip, acele margini se desenează peste baza
  și făceau forma vizibilă să se schimbe odată cu nivelul (ex. 4:3 → 9:16).
* **Fără goluri la schimbarea nivelului** — la zoom spre un nivel mai fin, tile-urile
  vechi rămân ca fundal estompat (replasate cu 2^Δ) pînă termină să se încarce cele noi;
  la zoom spre un nivel mai gros se refac direct cele 1–2 tile-uri groase.
* **Foiile stau blocate de tile-uri la zoom** — la fel ca punctele (§3): rădăcina fiecărei
  foi are clasa `leaflet-zoom-animated`, iar `zoomanim`/pinch aplică
  `translate(scale·ancoraBitmap − nouaOrigine) scale(scale)` (ancoraBitmap e
  ancora în pixeli + originea pixelilor de la redraw-ul stabilizat, adică
  centrul pe care s-a desenat conținutul — același principiu ca la canvas-ul
  punctelor); redraw-ul la stabilire o reîntoarce la plasarea obișnuită.

| Gest | Efect |
| --- | --- |
| Tragi harta (oricînd e „Mod aliniere”) | o muți în orice direcție; baza stă pe loc |
| Mîner de colț | scalare uniformă în jurul centrului |
| Mînerul de rotație (cercul auriu de deasupra) | rotație în jurul centrului, cu prindere la 0/90/180/270° |
| Roata mouse-ului | scalare |
| Shift + roata | rotație fină |
| Două degete (telefon) | scalare + rotație + deplasare într-un singur gest |
| Sliderul din panou | doar opacitatea — rotația și scara se fac din gesturi/mînere |

Panoul („Suprapune harta” / „Overlay the map”) e **compact**: titlu, harta activă,
comutatorul „Mod aliniere”, un singur slider de opacitate și butoanele **Centrează**
(mută ancora în centrul hărții), **Încadrează** (scalează ca harta să ocupe ~70 % din
fereastră), **Resetează** și **Șterge**. Nu mai are slidere de rotație și scară —
potrivirea fină rămîne pe gesturi: mînerele de colț, mînerul de rotație, roata
mouse-ului (Shift + roata = rotație) și pinch-ul pe telefon. În modul aliniere sînt
dezactivate temporar dragging-ul, zoom-ul cu roata, pinch-ul și box-zoom-ul bazei —
exact ca la „Mută harta istorică” — și se reactivează la **Blocare**.

## 4.1 Pătratul georeferențieră (5 km, modificabil)

O foaie ne-georeferențiată se potrivește manual peste baza curentă, dar nu
poate fi plasată oriunde: **ancora ei (punctul central) rămîne într-un pătrat
de 5 km în jurul locului din catalog**. Așadar, foaia se poate alinia
(aducere la superpoziție, rotație, scalare) doar pe ground-ul care i se
poartă — nu se poate traîn până la o altă lume.

* pătratul e centrat pe **locul din catalog** (`record.lat/lng`), nu pe ancora
  curentă — deci e o zonă fixă pe hartă, iar ancora e confinată într-ea;
* laturile se măsoară **pe teren** (metri), nu în grade, deci un pătrat de
  5 km e 5 km la orice latitudine;
* rotația și scalarea rămîn libere (scară limitată doar de `mppMin`/`mppMax`);
* în modul aliniere, pătratul se desenează ca contur punctat auriu în jurul
  locului, iar panoul „Suprapune harta” are un **selector de dimensiune**:
  2 / 5 / 10 / 20 / 50 / 100 km. Valorile mai mari sunt ieșirea pentru
  cazurile excepționale (o hartă lată de județ, un nume de loc aproximativ) —
  selectând una, ancora e repinsă în interiorul noului pătrat dacă trebuie;
* dimensiunea e salvată per foaie în `localStorage` (`dlOtherMaps.v1`),
  alături de ancora, rotația și opacitatea;
* punctul de schimb e `clampToSquare()` / `setBoundsKm()` din
  `js/other-maps-overlay.js` și selectorul `om-s-georef` din `js/other-maps.js`.

---

## 5. Persistență

Totul e local, per browser (`localStorage`), conform opțiunii alese:

| Cheie | Conținut |
| --- | --- |
| `dlOtherMaps.v1` | stratul pornit/oprit, opacitatea, hărțile adăugate (din ambele surse) cu ancora, rotația, scara, dimensiunea pătratului georeferențieră și opacitatea fiecăreia |
| `dlOtherMaps.pyramid.v1` | dimensiunea naturală a fiecărei foi Hungaricana deja citite |
| `dlOtherMaps.pyramid.v1.order` | ordinea hash-ului care a funcționat |
| `dlOtherMaps.nls.pyramid.v1` | dimensiunile naturale (`w/h/maxZoom`) ale foilor NLS citite prin `info.json` |

Alinierea supraviețuiește reîncărcării paginii și repornirii stratului. Cînd se va dori
împărțirea ei între utilizatori, punctul de schimb e `writeStore()` /
`restoreOverlays()` din `js/other-maps.js`.

## 6. Fișiere

| Fișier | Rol |
| --- | --- |
| `js/other-maps-tiles.js` | dispatcherul de surse + piramida ECW Hungaricana: hash-ul AES, descoperirea dimensiunii, URL-urile; `registerSource()` și rutarea după `record.source` |
| `js/other-maps-nls.js` | sursa `nls`: adapter IIIF (info.json, regiuni, miniaturi), interogarea WFS a Map Finder-ului, parsarea feature-urilor, acoperirea, deep-link-urile |
| `js/other-maps-overlay.js` | suprapunerea liberă: transformare, tile-uri vizibile, mînere, gesturi, pătratul georeferențieră ( independent de sursă) |
| `js/other-maps.js` | cele două cataloage, punctele verzi, gruparea, fereastra, panoul, persistența, descoperirea live NLS |
| `css/other-maps.css` | stilurile pentru toate cele de mai sus (inclusiv ecusonul de sursă) |
| `data/other-maps-catalog.json` | catalogul Hungaricana (131 de foi → 42 de locuri: seed + lotul Transilvania, oct. 2026) |
| `data/other-maps-nls-catalog.json` | sămînța NLS (262 de foi → 73 de locuri, planuri OS ale Angliei; se regenerază cu tool-ul de mai jos) |
| `tools/build-hungaricana-catalog.mjs` | re-generează/extinde catalogul Hungaricana de pe portal |
| `tools/build-nls-catalog.mjs` | construiește catalogul NLS din WFS (live sau `--json-dir` offline); `--self-test` |
| `test-other-maps.js` | regresia (rulează fără rețea) |
| `index.html` | rîndul din panoul „Hărți istorice” + tagurile de asset |
| `sw.js` | cache `detectlab-v338-other-maps-tile-span` |

## 7. Cum extinzi catalogul

Portalul nu are API JSON (`?format=json` e ignorat) și nu trimite headere CORS, deci
catalogul se construiește offline:

```bash
# comitatele istorice din România de azi + vecinii (implicit; ~5 pagini/căutare)
node tools/build-hungaricana-catalog.mjs

# o căutare anume, toate paginile
node tools/build-hungaricana-catalog.mjs --query Maramureș --pages 0

# tot portalul (78 000 de foi, foarte lent)
node tools/build-hungaricana-catalog.mjs --all --pages 0

# fără rețea: pagini salvate din browser („Salvează ca…”)
node tools/build-hungaricana-catalog.mjs --html-dir ./pagini

# verificarea parserului de carduri, fără rețea
node tools/build-hungaricana-catalog.mjs --self-test
```

Geocodarea folosește întîi un gazetar local (`--gazetteer fișier.json`, format
`{"Sighetu Marmației": [47.933, 23.892]}`), apoi Nominatim cu 1 cerere/secundă;
răspunsurile se pun în cache în `data/other-maps/geocode-cache.json`. Se acceptă doar
răspunsuri la nivel de așezare (`place`/`boundary`, fără țări sau rîuri), ca punctul
să nu ajungă la kilometri de foaie. Înregistrările deja existente își păstrează
coordonatele **și** numele de loc, iar cele pe care căutarea nu le-a revăzut sînt
păstrate (doar `--prune` reconstruiește de la zero) — deci o curatare făcută de mînă,
cum e lotul Transilvania, nu e mutată niciodată de o re-rulare.

Numele locului e cel scris de portal însuși în Subject — de regulă
„… (Máramaros m., **ma Sighetu Marmaţiei, RO**)” — adică numele modern, cu
`precision: "settlement"`; cînd portalul numește doar un comitat, înregistrarea primește
`precision: "county"` și punctul stă pe centrul comitatului (în lotul de față
coordonatele de comitat sînt aproximative). La foile cu mai multe locuri cîștigă
primul numit, traseele A–B primesc puncte la mijloc, iar foile fără scanare (multe
S 118) sînt sărite — cardul fără `path` nu ajunge în catalog.

### 7.1 Extinderea sursei NLS

Sursa NLS are API JSON (GeoServer WFS) și header-e CORS, deci catalogul se poate
construi atît live, cît și din răspunsuri salvate:

```bash
# orașele din gazetarul încorporat (o cerere WFS punct, cu politețe de 1 s)
node tools/build-nls-catalog.mjs

# un oraș anume
node tools/build-nls-catalog.mjs --place Edinburgh --lat 55.9533 --lng -3.1883

# o fereastră geografică (același GetFeature pe care îl face și modulul live)
node tools/build-nls-catalog.mjs --bbox -3.3,55.9,-3.1,56.0

# offline: răspunsuri WFS salvate (*.json / *.geojson, căutare recursivă)
node tools/build-nls-catalog.mjs --json-dir ./wfs-dumps

# verificarea parserului și a URL-urilor IIIF, fără rețea
node tools/build-nls-catalog.mjs --self-test
```

Fiecare feature WFS devine un record `nls/<IMAGE>` (deduplicat), punctul verde stă pe
centroidul amprentei, iar foile aceluiași loc sînt eșantionate uniform peste ani
(`--per-place`, implicit 6). Spre deosebire de Hungaricana, dimensiunile naturale ale
imaginii **nu** sînt în catalog: `info.json` IIIF e citit la prima adăugare a foii și
păstrat în `localStorage`. Pe lîngă catalogul static, stratul face oricum o interogare
WFS live pentru fereastra curentă (§2.1), deci extinderea acoperirii nu necesită niciun
release.

## 8.1 Stabilitatea la zoom și la deplasare (v306)

O foaie este o imagine fixă pe teren: la orice zoom trebuie să arate la fel,
doar mai mare sau mai mică. Trei lucruri făceau să nu fie așa:

* **nivelul piramidei depindea de poziția foii în cadru.** Dacă tile-ul
  „mai fin” era acceptat sau nu depindea de fereastra de tile-uri vizibilă, deci
  același zoom arăta altfel după ce mutai foaia. Acum bugetul de tile-uri se
  calculează din **dimensiunea** viewport-ului (diagonala, în pixelii nivelului),
  nu din poziția lui: nivelul depinde doar de zoom, de scară și de dimensiunea
  naturală a foii (`planGeometry`, `viewportTileBudget`, `MAX_SHARP_TILES = 36`).
* **dimensiunile nivelului erau rotunjite pe fiecare axă.** Grila desenată avea
  înălțimea `hL·k` care nu coincidea cu caseta `dH`, cu o eroare de pînă la o
  jumătate de pixel de nivel pe axă, care se schimba cu nivelul. Acum
  `wL = w·2^Δ` și `hL = h·2^Δ` sînt exacte, iar scara e un singur număr `k` pe
  ambele axe, la orice zoom.
* **testul** verifică acum că grila umple exact caseta la fiecare zoom (4–18,
  șase dimensiuni de foaie, inclusiv una foarte alungită), că fiecare pas de zoom
  dublează dimensiunea pe ecran și că nivelul nu depinde de pan sau de rotație.
  Înainte, eroarea de proporție ajungea la 0,9 %.

Versiunea: `js/other-maps-overlay.js?v=20261029-other-maps-stable`, cache
`detectlab-v306-other-maps-stable`.

## 8.2 Forma foii la zoom — fiecare tile se pictează la măsura lui (v338)

O foie adăugată trebuie să arate ca o poză lipită pe teren: aceeași formă la orice
zoom, doar mai mare sau mai mică. §8.1 a reparat matematica transformării, dar
pictarea tile-urilor avea încă o scăpare: **fiecare bitmap era întins într-o celulă
pătrată de 512 × 512 px, oricît de lat era**.

* Piramida Hungaricana răspunde mereu cu un pătrat de 512 px, cu foia „în interior”
  (margini în afara foii, în dreapta/jos), iar `css/other-maps.css` taie marginile la
  caseta foii — deci acolo celula pătrată e corectă.
* Serviciul IIIF al NLS **decupează** tile-ul la marginea imaginii: cererea pentru
  ultima coloană / ultimul rînd se întoarce mai îngustă (ex. 376 × 512). Întinsă
  peste 512 px, ea era lungită pe verticală cu 512/376 iar, la nivelul rădăcină
  (toată foia într-un singur bitmap 512 × 384), cu 512/384 = 33 %. Cum fiecare nivel
  are altă margine, foia își schimba forma și era tăiată altfel la fiecare zoom —
  „hărțile se distorsionează la zoom in/out”.
* Sursa gratuită **Josephine** (`js/other-maps.js`, scanările Wikimedia Commons)
  decupează la fel: tile-urile sînt desenate pe un canvas de `tw × th`, cu marginea
  tăiată la capătul foii, deci aveau aceeași soartă.

Acum dispatcherul spune **cît acoperă fiecare tile** în pixelii nivelului
(`Tiles.tileSpan(record, x, y, level)`): 512 × 512 pe drumul Hungaricana (neschimbat),
iar la sursele care decupează — NLS și Josephine — măsura calculată o singură dată în
`Tiles.tileSpanFor(meta, x, y, level)`:
`{w: min(512, wL − x·512), h: min(512, hL − y·512)}`, unde
`wL = w / 2^(maxZoom−level)`. `js/other-maps-overlay.js` pictează bitmap-ul exact la
această măsură (`sizeTile`, plus cei 0,6 px de suprapunere care acoperă cusăturile),
iar tile-ul de trecere (stand-in-ul nivelului precedent) își păstrează propria
măsură, scalată cu 2^Δ — deci nici în timpul schimbării de nivel foia nu se întinde.
Un tile a cărui sursă nu raportează nimic rămîne pe celula pătrată, adică pe
comportamentul de dinainte.

Testul verifică `Tiles.tileSpanFor` (rădăcină 411,75 × 315,94 px; coloană
marginală 376 × 512; rînd marginal 512 × 382; colț 376 × 382; 512 × 512 în interior;
o foie 4:3 = 512 × 384 la rădăcină), măsurile surselor (Hungaricana rămîne pe celula
pătrată, NLS și Josephine raportează span-uri),
pictarea la încadrare (512 × 384, nu un pătrat de 512), rîndul de jos al nivelului
următor (256 px) și stand-in-ul (1024,6 × 768,6 după 2^Δ).

Versiunea: `js/other-maps-tiles.js`, `js/other-maps-nls.js`,
`js/other-maps-overlay.js` și `js/other-maps.js` sînt versionate
`20261031-other-maps-tile-span`, cache `detectlab-v338-other-maps-tile-span`.

## 8. Regresie

```bash
node test-other-maps.js
```

peste 3 100 de verificări, fără rețea:

* hash-ul tile-ului Hungaricana reproduce vectorul publicat de dezoomify (ambele ordini),
  iar stringurile de cale și recordurile fără `source` rămîn rutate pe același drum;
* matematica transformării: alegerea nivelului din piramidă, **scara de încadrare
  (fitScale) și preferința pentru nivelul mai fin lizibil (cu plafon de tile-uri)**,
  păstrarea proporțiilor, limitele de scală, inversa transformării (fereastra de
  tile-uri acoperă viewportul la 0°, 90°, 37° și −128°);
* fiecare înregistrare din catalog are id, cale ECW și coordonate plauzibile;
* foile unui loc au id-uri distincte (fiecare card „Adaugă” e independent), iar
  punctul Cluj-Napoca ține zecile de foi ale orașului;
* atingerea contopește punctele vecine suprapuse: `mergeTapSheets` adună foile fără
  duplicate, iar șirurile `om_places_count`/`om_place_count` există în ro/en/hu;
* gruparea: hărțile unui loc rămîn un singur punct, două locuri la 1,4 km sînt un punct
  la z6 și două puncte la z11 — cu aceeași configurție ca Patrimoniu;
* **managerul de suprapunere** (mapă falsă + mini-DOM): o foie nouă e încadrată la
  `fitScale(viewport, zoom)`, la zoom spre un nivel mai fin tile-urile vechi rămân ca
  fundal estompat (replasate cu 2^Δ, cu timer de rezervă) pînă se încarcă cele noi, la
  zoom spre un nivel mai gros se refac direct, iar reset/ștergere curăță totul;
* **pătratul georeferențieră**: `clampToSquare` măsoară în metri pe teren
  (punct în interior lăsat de-acum, punct în exterior repins pe margine la
  ±2.5 km, colțul la ±2.5 km pe ambele axe, pătrat mai mare lăsă punctul să
  treacă, pătrat de 0 nu clâmbică); managerul: o foie nouă are pătrat de 5 km,
  `setState`/`setBoundsKm` țin ancora în interior, `publicState`/`snapshot`
  cară dimensiunea, iar selectorul din panoul „Suprapune harta” oferă
  preset-urile 2/5/10/20/50/100 km;
* **blocarea la zoom animat** (mapă falsă cu convențiile de proiecție Web Mercator):
  un redraw stabilizat înregistrează ancora din spațiul de proiecție; `zoomanim`
  aplică `translate(scale·ancoră − nouaOrigine) scale(scale)` pe canvas și
  `translate(scale·(proiecțiaAncorei − ancora) − nouaOrigine) scale(scale)
  translate(ancora)` pe foi, fiecare punct desenat ajungând exact la poziția lui la
  zoom-ul țintă; pinch-ul (zoom 13→14, `touchZoom._zooming`) rescalează cadrul
  stabilizat fără redraw, iar la stabilire transformarea se șterge.
* **sursa NLS** (`js/other-maps-nls.js`, §10–14): derivarea identificatorilor
  (`102345214` → `10234/102345214` → `iiif/2/10234%2F…`), URL-urile IIIF
  (rădăcina piramidei, tile nativ, muchii clampate, tile în afara grilei),
  parsarea `info.json` v2 și v1.1 cu lanțul de fallback `/iiif/2/ → /iiif/ →
  /iiif/1/`, forma interogării WFS (12 tipuri, 12 filtre `INTERSECTS`,
  `the_geom` în `propertyName`, `maxFeatures`), maparea feature→record pe
  Polygon și MultiPolygon, filtrele de id invalid și dedublarea, cutia de
  acoperire și deep-link-ul finder-ului, eșecul de rețea care întoarce lista
  goală;
* **măsura fiecărui tile** (§8.2): `Tiles.tileSpanFor` dă 512 × 512 în interiorul foii
  și lățimea / înălțimea tăiată pe muchie (376 × 512, 512 × 382, 376 × 382),
  `Nls.tileSpan` o folosește, sursa Josephine își expune `tileSpan`, iar
  `Tiles.tileSpan` păstrează celula pătrată pe Hungaricana; managerul pictează
  bitmap-ul NLS la 512 × 384 (nu într-un pătrat de 512), rîndul de jos al nivelului
  următor la 256 px, iar stand-in-ul își păstrează măsura scalată cu 2^Δ;
* **dispatcherul multi-sursă**: recordurile `{source:"nls"}` sînt rutate spre
  adapterul NLS pentru tile/thumb/record/resolve, iar stringurile și recordurile
  fără sursă rămîn pe Hungaricana — verificat și prin managerul de overlay, care
  pictează o foaie NLS cu URL-uri IIIF și o foaie Hungaricana cu URL-uri cu hash,
  ambele încadrate identic (`fitScale`);
* **catalogul NLS comis**: fiecare record are id `nls/<număr>`, cale IIIF
  `<prefix>/<număr>`, coordonate în cutia de acoperire și id unic, iar
  `combineCatalogMaps` etichetează corect cele două surse și îmbinarea live
  (`mergeLiveRecords`/`rebuildRecords`) crește indexul comun fără dubluri.

`js/other-maps.js`, `js/other-maps-tiles.js`, `js/other-maps-nls.js` și
`js/other-maps-overlay.js` sînt versionate `20261031-other-maps-tile-span` (vezi
§8.2), iar `css/other-maps.css` rămîne la `20261028-other-maps-fix`; catalogul
Hungaricana
(`data/other-maps-catalog.json`) rămîne la `20261026-cluj-alba`, iar catalogul NLS
(`data/other-maps-nls-catalog.json`) e la `20261028-other-maps-fix`; cache-ul
service-worker-ului e `detectlab-v338-other-maps-tile-span`.
