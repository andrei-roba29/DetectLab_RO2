# PWA instalat: fără bară / fâșie jos, ecran plin (v286)

Documentul acesta înlocuiește toată seria anterioară de „reparații” pentru banda
de jos a PWA-ului instalat (`PWA_BOTTOM_BAND.md` a fost șters). Nu mai există
niciun mecanism separat pentru bandă: ecranul este dimensionat o singură dată,
în pixeli, iar harta acoperă toată suprafața fizică.

## Ce se vede în aplicația instalată

- Harta, panoul de transparență, stiva flotantă din dreapta-jos (`#pwa-br-stack`:
  🎯 locație live deasupra, trigger de cont dedesubt), coloana busolei și
  eticheta „© Leafleet”.
- **Nicio bară și nicio fâșie de fundal** la marginea de jos: nici goală, nici cu
  butoane. `#pwa-install-banner` (bara fixă de instalare a site-ului) este
  dezactivată explicit în aplicația instalată, indiferent ce raportează browserul
  despre `display-mode`.

## Cum e dimensionat ecranul (singura sursă de adevăr)

`index.html`, scriptul PWA de la finalul documentului:

```js
function measurePwaScreen() {
    var pageH = Math.max(window.innerHeight,
        (window.visualViewport && window.visualViewport.height) || 0);
    var screenH = (window.screen && window.screen.height) || 0;
    var installed = matchMedia('(display-mode: standalone)').matches
        || matchMedia('(display-mode: fullscreen)').matches
        || navigator.standalone === true;
    var target = Math.round(pageH);
    if (installed && screenH > target) target = Math.round(screenH);
    return { pageH: pageH, height: target, bleed: Math.max(0, target - pageH) };
}
```

Două variabile CSS publice, ambele în pixeli:

| variabilă | valoare | cine o folosește |
| --- | --- | --- |
| `--pwa-viewport-h` | înălțimea reală a ecranului | `#map-section`, `.container`, `.map-frame`, `.map-wrapper`, `#detectlab-map`, `.transp-panel` |
| `--pwa-bleed` | partea din ecran pe care viewport-ul paginii nu o acoperă | ridică la loc `.leaflet-bottom` (busola), eticheta `© Leafleet`, colțul de jos al hărții și tot ce e ancorat pe marginea de jos a hărții |

Valoarea este scrisă de asemenea **inline, cu `!important`**, direct pe fiecare
element din lanț (`height`, `min-height:0`, `max-height:none`), nu doar prin
variabilă: așa nici un `height:100%` intermediar nu mai poate moșteni un strămoș
scurt.

Harta are voie să depășească marginea de jos cu `--pwa-bleed` pixeli (ca să nu
poată apărea fundalul paginii), iar controalele ancorate pe aceeași margine
primesc aceeași ridicare: `--pwa-bottom-controls-clearance` devine
`calc(44px + var(--pwa-bleed, 0px))` (toast-uri, hint-uri de zoom, butoanele
APM 2.0 / Iosefină, panoul de setări), `.layer-action-dock` primește
`+ var(--pwa-bleed)`, iar `.leaflet-bottom` și `© Leafleet` sunt ridicate
explicit. Când cele două înălțimi coincid, `--pwa-bleed` este `0px` și nimic nu
se mișcă.

Re-măsurarea rulează la `DOMContentLoaded`/`load`/`pageshow`, la `resize` și
`orientationchange` (cu o a doua trecere la 300 ms, fiindcă iOS raportează o
singură rotație cu întârziere), la `visualViewport.resize`, la 300/800/1600 ms
după pornire și dintr-un `ResizeObserver` pe `#map-section`, `.map-frame` și
`#detectlab-map`. Fiecare trecere se încheie cu `map.invalidateSize()`, ca
Leaflet să redeseneze pe suprafața nouă.

## De ce nu se mai folosesc unități de viewport

`bottom:0`, `100vh`, `100dvh` și `100svh` se rezolvă toate față de *initial
containing block*. Cu `viewport-fit=cover` + `black-translucent`, WebKit poate
da paginii un ICB mai scurt decât ecranul fizic; orice cutie dimensionată din
acele valori se oprește deasupra marginii, iar ce rămâne nepictat arată ca o
fâșie de fundal sub hartă. `window.innerHeight` / `visualViewport.height` nu
suferă de această particularitate, de aceea înălțimea se scrie în pixeli.
`height: var(--pwa-viewport-h, 100%)` din CSS este doar forma declarativă a
aceleiași reguli (primul cadru, înainte ca scriptul să ruleze).

## Fișiere

- `index.html` — stilurile PWA (`#map-section`, `.container`, `.map-frame`,
  `.map-wrapper`, `#detectlab-map`, `.transp-panel`, `.leaflet-bottom`,
  `.leaflet-container::after`, `#pwa-install-banner`) și scriptul PWA
  (`measurePwaScreen`, `fitPwaViewport`, `updatePwaMapLayout`).
- `sw.js` — `detectlab-v286-pwa-fullscreen-fit`.
- Teste: `node test-pwa-viewport-fit.js` (matematica măsurătorii, pe stub-uri:
  standalone cu viewport scurt → ecran fizic + bleed, browser → viewport propriu,
  landscape, WebView-uri vechi), `node test-pwa-no-bottom-strip.js` (dimensiunea
  în pixeli în CSS, lanțul complet, bleeds, bara de instalare dezactivată,
  absența vechilor mecanisme), `node test-pwa-no-bottom-bar.js` (stiva
  dreapta-jos), `node test-pwa-shell-refresh.js` (versiunea SW).

## Istoric scurt

- v112–v119: încercări cu `min-height:100vh`, apoi cu un „floor” JS (`--dl-vvh`)
  aplicat tot ca `min-height`. Ambele au fost eliminate în v286, împreună cu
  sonda de diagnostic `js/pwa-debug.js`.
- v123 / v136: stiva din dreapta-jos a fost scoasă, apoi restaurată. Starea
  actuală este cea din secțiunea „Ce se vede”.
