# Mutarea hărților istorice peste harta de bază (long-press)

**Cerere:** toate hărțile istorice disponibile (gratuite și premium) să poată
fi mutate peste harta de bază astfel: ții apăsat oriunde pe hartă → apare un
switch; switch ON → harta istorică poate fi trasă în orice direcție, dar nu
exagerat; ții apăsat din nou și oprești switch-ul → LOCK, poziția rămâne.

## Cum funcționează (`js/hist-shift.js` + `css/hist-shift.css`)

1. **Long-press (~550 ms, fără mișcare > 10 px)** oriunde pe hartă (nu pe
   butoane/marker-e/panouri) deschide panoul „Mută harta istorică", cu
   switch-ul, lista straturilor istorice active și deplasarea curentă.
2. **Switch ON (mod mutare):** handler-ul `dragging` al hărții de bază e
   dezactivat, iar drag-ul pe ecran mută harta istorică selectată (implicit
   cea de deasupra; poate fi aleasă din lista din panou). Deplasarea maximă
   e **3 km** (magnitudine, EPSG:3857) — permite corecții mai mari de
   georeferențiere, păstrând o limită de siguranță.
3. **Long-press din nou / switch OFF / × = LOCK:** drag-ul revine la harta de
   bază, iar poziția rămâne. Deplasarea e salvată per strat în
   `localStorage` (`dlHistShift.v1`) și reaplicată la pornirea stratului și
   la fiecare zoom. Butonul „Resetează poziția" o aduce la (0, 0).

## De ce merge pe TOATE hărțile istorice

Niciun strat nu e reimplementat. Modulul descoperă pe harta live layerele
al căror URL/LAYERS se potrivesc cu o definiție din registru
(`js/layer-registry.js`) din grupurile `hist-free`, `hist-premium` (inclusiv
catalogul CENAGIS) și `hist-sat` (CORONA anii '60), plus pane-urile speciale
`pane_josephine` (premium, sursă dublă Cloudflare/Supabase) și `iosfreePane`
(Harta Iosefină gratuită, image-overlay). Mutarea e o transformare CSS pe
pane-ul stratului, deci e independentă de tipul serviciului: WMS, WMTS, XYZ,
ArcGIS sau imagine. Deplasarea e ținută în **metri proiectați**, nu pixeli,
așa că poziția geografică rămâne aceeași la orice zoom.

API: `window.DetectLabHistShift` — `attach/activeTargets/setEnabled/
isEnabled/getOffset/setOffset/reset/showPanel`, `MAX_OFFSET_M = 3000`.

Regresie: `node test-hist-shift.js` (descoperire gratuit+premium, clamp,
persistență, long-press, drag, lock, reset). Asset-uri versionate
`20261014-hist-shift`, cache SW `v205-hist-shift`.

**Corecție (2026-10-20):** mutarea nu funcționa deloc dacă sliderul
stratului era adăugat pe ecranul principal — `isUiTarget()` potrivea cu
`closest()` clasele de stare `*docked*`/`*panel*` puse pe `<body>` de
oglinzile verticale, deci orice apăsare pe hartă era tratată drept UI.
Vezi `HIST_SHIFT_DOCKED_SLIDER.md` (asset
`20261020-hist-shift-docked-slider`, cache SW `v241`).

**Extindere (2026-10-31):** limita crește de la 300 m la 3 km (metri
proiectați EPSG:3857), în orice direcție. Pozițiile deja salvate rămân
valabile; lock-ul și resetarea nu se schimbă. Asset JS
`20261031-hist-shift-range`, cache SW `v344-hist-shift-range`.
