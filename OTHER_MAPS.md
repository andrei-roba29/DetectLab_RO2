# „Alte hărți / Other maps” — hărți ne-georeferențiate (Hungaricana)

**Cerere:** hărțile istorice care NU sînt georeferențiate — cele de pe
[maps.hungaricana.hu](https://maps.hungaricana.hu/) care pe portal nu apar deloc pe
hartă, pentru că au doar un nume de loc, nu și o amprentă la sol — să intre în aplicație
ca sub-strat în grupul premium **„Hărți istorice / Historical Maps”**, sub numele
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
două acțiuni: **„Adaugă pe hartă”** și **„Deschide pe Hungaricana”**.

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
  `translate(scale·(proiecțiaAncorei − ancora) − nouaOrigine) scale(scale)
  translate(ancora)`; redraw-ul la stabilire o reîntoarce la plasarea obișnuită.

| Gest | Efect |
| --- | --- |
| Tragi harta (oricînd e „Mod aliniere”) | o muți în orice direcție; baza stă pe loc |
| Mîner de colț | scalare uniformă în jurul centrului |
| Mînerul de rotație (cercul auriu de deasupra) | rotație în jurul centrului, cu prindere la 0/90/180/270° |
| Roata mouse-ului | scalare |
| Shift + roata | rotație fină |
| Două degete (telefon) | scalare + rotație + deplasare într-un singur gest |
| Sliderele din panou | opacitate, rotație (−180…180°), scară |

Panoul mai are **Centrează** (mută ancora în centrul hărții), **Încadrează** (scalează
ca harta să ocupe ~70 % din fereastră), **Resetează** și **Șterge**. În modul aliniere
sînt dezactivate temporar dragging-ul, zoom-ul cu roata, pinch-ul și box-zoom-ul
bazei — exact ca la „Mută harta istorică” — și se reactivează la **Blocare**.

Scala e arătată și ca **lățime pe teren** („2.50 km × 1.87 km”), ca s-o poți potrivi
după o distanță cunoscută, nu după „metri per pixel”.

## 5. Persistență

Totul e local, per browser (`localStorage`), conform opțiunii alese:

| Cheie | Conținut |
| --- | --- |
| `dlOtherMaps.v1` | stratul pornit/oprit, opacitatea, hărțile adăugate cu ancora, rotația, scara și opacitatea fiecăreia |
| `dlOtherMaps.pyramid.v1` | dimensiunea naturală a fiecărei foi deja citite |
| `dlOtherMaps.pyramid.v1.order` | ordinea hash-ului care a funcționat |

Alinierea supraviețuiește reîncărcării paginii și repornirii stratului. Cînd se va dori
împărțirea ei între utilizatori, punctul de schimb e `writeStore()` /
`restoreOverlays()` din `js/other-maps.js`.

## 6. Fișiere

| Fișier | Rol |
| --- | --- |
| `js/other-maps-tiles.js` | piramida ECW a portalului: hash-ul AES, descoperirea dimensiunii, URL-urile |
| `js/other-maps-overlay.js` | suprapunerea liberă: transformare, tile-uri vizibile, mînere, gesturi |
| `js/other-maps.js` | catalogul, punctele verzi, gruparea, fereastra, panoul, persistența |
| `css/other-maps.css` | stilurile pentru toate cele de mai sus |
| `data/other-maps-catalog.json` | catalogul (seed real, 26 de foi → 17 locuri) |
| `tools/build-hungaricana-catalog.mjs` | re-generează/extinde catalogul de pe portal |
| `test-other-maps.js` | regresia (rulează fără rețea) |
| `index.html` | rîndul din panoul „Hărți istorice” + tagurile de asset |
| `sw.js` | cache `detectlab-v261-other-maps-fit` |

## 7. Cum extinzi catalogul

Portalul nu are API JSON (`?format=json` e ignorat) și nu trimite headere CORS, deci
catalogul se construiește offline:

```bash
# comitatele istorice din România de azi + vecinii (implicit; ~5 pagini/căutare)
node tools/build-hungaricana-catalog.mjs

# o căutare anume, toate paginile
node tools/build-hungaricana-catalog.mjs --query Maramaros --pages 0

# tot portalul (78 000 de foi, foarte lent)
node tools/build-hungaricana-catalog.mjs --all --pages 0

# fără rețea: pagini salvate din browser („Salvează ca…”)
node tools/build-hungaricana-catalog.mjs --html-dir ./pagini

# verificarea parserului de carduri, fără rețea
node tools/build-hungaricana-catalog.mjs --self-test
```

Geocodarea folosește întîi un gazetar local (`--gazetteer fișier.json`, format
`{"Sighetu Marmației": [47.933, 23.892]}`), apoi Nominatim cu 1 cerere/secundă;
răspunsurile se pun în cache în `data/other-maps/geocode-cache.json`. Înregistrările deja
existente își păstrează coordonatele, deci o aliniere făcută de cineva nu e mutată
niciodată de o re-rulare.

Numele locului e cel scris de portal însuși în Subject — de regulă
„… (Máramaros m., **ma Sighetu Marmaţiei, RO**)” — adică numele modern, cu
`precision: "settlement"`; cînd portalul numește doar un comitat, înregistrarea primește
`precision: "county"` și punctul stă pe centrul comitatului (în seed-ul de față
coordonatele de comitat sînt aproximative).

## 8. Regresie

```bash
node test-other-maps.js
```

274 de verificări, fără rețea:

* hash-ul tile-ului reproduce vectorul publicat de dezoomify (ambele ordini);
* matematica transformării: alegerea nivelului din piramidă, **scara de încadrare
  (fitScale) și preferința pentru nivelul mai fin lizibil (cu plafon de tile-uri)**,
  păstrarea proporțiilor, limitele de scală, inversa transformării (fereastra de
  tile-uri acoperă viewportul la 0°, 90°, 37° și −128°);
* fiecare înregistrare din catalog are id, cale ECW și coordonate plauzibile;
* gruparea: hărțile unui loc rămîn un singur punct, două locuri la 1,4 km sînt un punct
  la z6 și două puncte la z11 — cu aceeași configurție ca Patrimoniu;
* **managerul de suprapunere** (mapă falsă + mini-DOM): o foie nouă e încadrată la
  `fitScale(viewport, zoom)`, la zoom spre un nivel mai fin tile-urile vechi rămân ca
  fundal estompat (replasate cu 2^Δ, cu timer de rezervă) pînă se încarcă cele noi, la
  zoom spre un nivel mai gros se refac direct, iar reset/ștergere curăță totul;
* **blocarea la zoom animat** (mapă falsă cu convențiile de proiecție Web Mercator):
  un redraw stabilizat înregistrează ancora din spațiul de proiecție; `zoomanim`
  aplică `translate(scale·ancoră − nouaOrigine) scale(scale)` pe canvas și
  `translate(scale·(proiecțiaAncorei − ancora) − nouaOrigine) scale(scale)
  translate(ancora)` pe foi, fiecare punct desenat ajungând exact la poziția lui la
  zoom-ul țintă; pinch-ul (zoom 13→14, `touchZoom._zooming`) rescalează cadrul
  stabilizat fără redraw, iar la stabilire transformarea se șterge.

Asset-urile modificate sînt versionate `20261024-other-maps-zoomlock`; cache-ul
service-worker-ului e `detectlab-v262-other-maps-zoomlock`.
