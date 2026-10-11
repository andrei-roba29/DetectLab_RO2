/* ============================================================
   DetectLab — Service Worker v1.4.10
   ============================================================ */

// Bump this when a client-side feature or data-sync fix ships so installed
// PWAs replace stale scripts instead of continuing to run an older client.
// v81: premium historical-maps accordion releases its max-height after the
// expand animation so the last card (Galiția & Lodomeria 1855) can no longer
// be clipped in the standalone mobile PWA.
// v82: fix PWA Patrimoniu zoom glitch — stop redrawing custom canvases
// during pinch/zoom animation, round transform to match tile container,
// and guard visualViewport resize while zooming.
// v84: offline-maps panel — zoom-level wording ("Nivel zoom" / "Zoom level"),
// closing a polygon on its first corner, the over-sized-polygon error that was
// being overwritten, and panel/bottom-bar/status-bar geometry in the PWA.
// v85: Satellite layer "Istoric" period slider — 2016 / 2018 orthophotos
// (geo-spatial.org WMS) alongside the present-day imagery, with both vertical
// mirrors (opacity + period) shown together on the map.
// v86: Social layer — "Prieteni / Friends" (search by e-mail · name · id +
// county filter), friend requests, private and group chat with an admin,
// events created straight from a chat and the "Adaugă prieteni / Add friends"
// box of the create-event form, all bounded by the quotas in public.app_limits.
// v87: Visibility prompt — turning ON the Detect switch or the live-location
// button now asks "Vrei să fii vizibil și pentru alți utilizatori?" (Da/Nu);
// the answer gates every presence publish so users are only shown to other
// detectorists after an explicit "Da".
// v89: Satellite „Istoric” keeps only the 2016 orthophoto (the 2018 layer is
// removed from the base layer → two stops, 2016 / 2025) and the two
// map-side mirrors of the Satellite layer stay side by side in the installed
// PWA / on phones, where the ≤600px breakpoint used to stack them on the same
// anchor so only the ISTORIC mirror was visible.
// v90: the map-side opacity mirror no longer prints the word "OPACITY" above
// the range — the slider shows the layer name only (period mirrors keep
// ISTORIC / PERIOADĂ).
// v95: layer info for "Harta Transilvaniei 1859" and "Hartă administrativă a
// Galiției și Lodomeriei – 1855" also credits the digitization and publication
// by Universitatea „Ștefan cel Mare” din Suceava, with bukowina1856.eu as the
// source (ⓘ popup, Leaflet attribution, offline-maps panel). The source domain
// is rendered as a clickable link inside the ⓘ popup.
// v98: PWA layer panel + analysis sliders + detectorist social fixes —
//   • the layers window is anchored top→bottom of the map frame (it used to be
//     capped at 560px, so in the installed PWA it stopped after the lower half
//     of the screen) and carries no bottom padding any more;
//   • a mirrored vertical slider shows its layer title ABOVE the card instead of
//     inside it, and the LIDAR / potential / report ranges take the colour of the
//     pin + radius circle of their own layer (green / purple / blue);
//   • the magnifier only starts the live location — it no longer switches the
//     detection mode on — and being visible to others now depends on live
//     location + consent alone;
//   • tapping a detectorist pin always offers the friend action (Leaflet's
//     popup.update() used to repaint the string content over the buttons, so the
//     button appeared only when it lost that race);
//   • the friends search browses the county on an empty query, searches while you
//     type, reads the tables the RLS already exposes when the search RPC is
//     missing, and says so when the server could not be reached
//     (supabase/migrations/20260916020000_social_directory_projection.sql);
//   • offline areas are drawn as a polygon only — no vertex pins, no radius
//     circles, and the analysis layers never drop their pin under the finger
//     while a ring is being drawn — plus a centred ✕ at the bottom that leaves
//     an active offline map.
// v100: tile performance governor — js/tile-perf.js (loaded right after Leaflet)
//   applies gesture-safe defaults to every tile layer, merges the tile work of a
//   fast zoom into one update per layer, prunes the old zoom levels harder and
//   watches the page's decoded-tile budget; it is what stops the crash/reload
//   reported with several dense layers open at once (LIDAR + „Imagini
//   satelitare anii 60'" + historical maps + APM) when zooming abruptly.
//   See MAP_LAYER_PERFORMANCE.md.
// v103: friends panel — the unified search and the friend list each get their
//   own tab („Caută prieteni” / „Prietenii tăi”; the empty friend list carries
//   a button straight to the search), and the chat view with a friend clears
//   the phone status bar in the installed PWA (safe-area top padding, same
//   rule as the event chat) so ← / ⋯ / 📅 stay tappable. The map guide
//   (js/tutorial.js) opens the search tab and points at the new tabs.
// v105: fluid zoom — shorter settle window, covering tiles until the new
//   zoom is active, keepBuffer 1/2, dark map background so empty tiles no
//   longer flash white. See MAP_LAYER_PERFORMANCE.md.
// v107: "Zone cu potențial arheologic" — the heatmap now matches the bubbles:
//   the score raster is copied north-up into the source bitmap (it used to be
//   mirrored N–S, so colours and the transparent exclusion holes landed on
//   the opposite side of the circle, in places that are neither UAT nor a
//   site radius); the separate "Mod pin" switch is removed — the map-point
//   logic (tap → purple pin) is permanent while the layer's main switch is on
//   (the radius mirror + dock now follow that switch), and the layer info
//   text is replaced. See ARCHEO_POTENTIAL.md.
// v108: seamless tiles — the white grid between tiles is gone (Leaflet's
//   mix-blend-mode: plus-lighter added the colours of the 1px seam overlap
//   instead of covering them, so every 256px line lit up white) and zoom
//   in/out now cross-fades the incoming tiles over the previous zoom level
//   through a CSS-only fade on every device — same crash protection, no
//   hard pop. See MAP_LAYER_PERFORMANCE.md.
// v109: no dark strip below the map in the installed PWA — #map-section no
//   longer computes its height from vh/svh/dvh (iOS standalone settles those
//   one frame late, and on some versions the dynamic viewport excludes the
//   home-indicator band, so the section could end up shorter than the screen
//   and the navy page background showed as an empty "bottom bar" under the
//   tiles). It now stretches between the viewport edges (top:0 + bottom:0),
//   and delayed passes + a ResizeObserver re-run Leaflet's invalidateSize the
//   exact frame the container reaches its real size. No control moves.
// v110: social notifications — the red badge moves onto the PROFILE BUTTON and
//   counts everything at once (unread event chats from js/events.js + pending
//   friend requests + unread messages from js/friends.js, both writing through
//   window.DetectLabNotify so neither erases the other), and a new friend
//   request or a new chat message pops a notification card in the top-right
//   corner (tap = open that request tab / that thread, ✕ = dismiss, hidden
//   forever once seen — the marks live in the per-account mirror). Messages
//   arrive instantly through a realtime inbox channel; requests through the
//   20 s counter poll. See FRIENDS_AND_CHAT.md.
// v111: offline maps — the download cap grows from 10 km² to 100 km² (tile
//   budget raised with it) and the free catalogue gains Patrimoniu (CIMEC
//   WMS), the three free eharta historical maps (Austriacă 1910, Planuri de
//   Tragere 20k, Sovietică 1970) and Localități OSM (the GeoJSON is cached as
//   one document and replayed as name labels). sw.js now treats every
//   request tagged with __dl_offline_map= as an offline-cache lookup so WMS
//   tiles and the cached GeoJSON also work with no connection.
// v112: the dark band under the map in the installed iPhone PWA — root cause
//   found. `#map-section` is position:fixed, so top:0 / bottom:0 resolve
//   against the initial containing block, and this page asks iOS for the one
//   viewport documented to come up short there: viewport-fit=cover +
//   apple-mobile-web-app-status-bar-style:black-translucent + a document sized
//   in % / svh / dvh. WebKit then hands the page an ICB that is
//   safe-area-inset-top (~59px) shorter than the physical screen — content is
//   laid out from y=0 behind the translucent status bar but the box height is
//   never compensated — so bottom:0 stops ~59px above the bottom edge, the map
//   container ends there, the "© Leafleet" tag sits on top of the gap and the
//   empty #060E1E page background shows through under it as the "bottom
//   padding / bottom bar". Every reading of the ICB is short by the same
//   amount (%, svh, dvh and bottom:0 alike), which is why v109's ladder →
//   stretch rewrite did not remove it. 100vh is the one unit WebKit resolves to
//   the FULL screen in this mode, so #map-section and .transp-panel now carry
//   min-height:100vh as a floor: where the ICB already equals the screen
//   (Android, desktop ?pwa=1, iOS without the short-ICB behaviour) it is
//   exactly the top:0→bottom:0 stretch and changes nothing; where the ICB is
//   short it clamps the box back to the real screen height. No control offset
//   is touched. Also ships js/pwa-debug.js — a gated on-device probe
//   (?pwaDebug=1 / ?pwaDebug=colors, or five taps on the © Leafleet tag) that
//   prints the ICB / 100vh / dvh / svh / env() / element rects and can copy the
//   whole readout, plus paints each candidate layer a different colour so the
//   band's own colour names its painter in one round trip. See
//   PWA_BOTTOM_BAND.md.
// v113: keep event creation below the phone status bar and within the viewport.
// v115: move the Battles epoch-colour legend from the layers panel into the
// Battles info tab, directly below its attribution.
// v116: layer-card initials — the mirrored layer cards (analysis sliders +
//   the PWA layer panel) fall back to the layer's initials when the icon is
//   missing, so no card is painted with an empty header.
// v117: visibility prompt on the nearby search — tapping „Da / Yes” in „Vezi
//   alți detectoriști în zonă” now asks the SAME question as the Detect switch
//   („Vrei să fii vizibil și pentru alți utilizatori?”, Da/Nu) before anything
//   is published: the search waits for the answer, the search dialog steps
//   aside for the question and returns with it, and the answer is applied
//   through _presenceVisible() („Nu” still searches — you just stay invisible).
// v118: PWA bottom band — the inner percentage chain (.container → .map-frame →
//   .map-wrapper → #detectlab-map) was still min-height:100% so it inherited the
//   short ICB (785px on an 844px screen) even after #map-section got the 100vh
//   floor; the © Leafleet tag sat on top of the gap and #060E1E showed through.
//   All four inner boxes now carry min-height:100vh as well, closing the band
//   without moving any control offset. See PWA_BOTTOM_BAND.md.
// v119: PWA bottom band, take two — 100vh itself is still a CSS-unit reading of
//   the same short ICB on some iOS/Android builds, so v118's floor could still
//   come up short there. #map-section / .map-frame / .map-wrapper /
//   #detectlab-map / .transp-panel / .container now also take a JS-measured
//   `--dl-vvh` pixel floor (window.innerHeight / visualViewport.height, which
//   already reports the true physical screen height in that mode) as a second
//   `min-height` line after the plain 100vh one — CSS keeps the last
//   `min-height` that resolves to a real length, so this only raises the floor
//   when 100vh itself was short, and changes nothing where it already matched
//   the screen. No control offset moved. See PWA_BOTTOM_BAND.md.
// v121: the standalone PWA gives the map-side layer title an explicit column
//   and a concrete rotated label box, avoiding the mobile WebView auto-grid
//   collapse that could leave the initials outside the visible card.
// v122: two independent layer mirrors can stay on the map at once. The
//   Satellite base remains the deliberate two-slider pair (opacity + historic
//   period), while other selected layers use the two map-side slots and mark
//   their rows as already represented on the map.
// v123: the PWA bottom bar is GONE. The installed app showed a strip at the
//   bottom of the screen — the bottom-right floating stack (#pwa-br-stack):
//   the geolocation / live-location 🎯 button above the account trigger (the
//   button showing the e-mail initials, "AN", or the "Log In" pill) with its
//   upward dropdown (Manage Account / Events / Friends / Language / Storage /
//   Log Out). The container is display:none !important, it is removed() from
//   the DOM by the standalone script, and js/map-app.js no longer builds the
//   live-location button in PWA mode — so the map now runs to the bottom edge
//   with no bar and no buttons under it. The left icon stack (zoom, measure,
//   coordinates, trail, offline maps, magnifier), the compass / rotation-lock /
//   Detect column and the "© Leafleet" tag are untouched.
// v125: PWA shell refresh — index.html now re-checks for a new sw.js after
//   load, on pageshow, on foregrounding and every minute, and reloads once a
//   NEW worker takes control over an OLD one. Installed apps used to keep
//   running their opening shell (WebView snapshot) for days, so map changes
//   already shipped — two layer sliders on screen (v122) and the layer title
//   written beside the vertical mirror (v121) — never surfaced in the PWA
//   even after deploy. The corrupt trailing bytes after index.html's </html>
//   are gone as well, so the document parses as one clean unit again.
// v126: mobile WEB fullscreen control clearance (browser tab, not the
//   installed PWA). The bottom-left compass + rotation-lock column was hidden
//   behind the browser's bottom search/URL bar in map fullscreen — the frame
//   is `inset:0; height:100vh` and 100vh is the LARGE viewport, so the map's
//   bottom edge (and every absolute control on it) slides under the browser
//   toolbar — and the "?" help button slid against the map search bar because
//   the desktop fullscreen offset (right:64px, clearing the ✕) also applied
//   on phones where the ✕ lives at the bottom-right instead. The bottom-left
//   corner now fixes to the visible viewport above the browser bar, and the
//   "?" stays pinned in the top-right corner on narrow screens.
// v127: layer quick actions in BOTH vertical mirrors. The docked icon rules
//   (APM 2.0 „Ajutor de căutare” + the three Iosefină Premium buttons) were
//   scoped to `#verticalOpacityActions …`, so when a layer was mirrored into
//   the SECOND on-screen slider (#verticalOpacityActionsSecondary) its buttons
//   kept the floating bottom-center geometry from their base rules
//   (position:absolute, bottom:76px, left:50%, translateX(±112px)) — out of the
//   column, overlapping and off to the left of the slider. The selectors now
//   key off the shared `.vertical-opacity-actions` container class. The bump
//   matters for the installed PWA, which serves the shell from this cache.
// v129: closing a DISTANCE mirror (LIDAR Scanner / Zone cu potențial
//   arheologic / Raport arheologic) that sits on the map as the SECOND
//   slider no longer closes the OTHER mirror and deactivates its layer.
//   The analysis modules used to call the global mirror close()
//   (closeAllControls) when their layer switched off — which happens INSIDE
//   their own mirror's teardown, because clearSlot re-fires the layer
//   switch's change event — so everything on the map went dark together.
//   They now call the new single-slot closeFor(id) API, and isActiveFor(id)
//   no longer reports the slot that is currently being torn down.
// v130: the DISTANȚĂ / RAZĂ / ISTORIC caption chip floats ABOVE the vertical
//   slider card in the installed PWA too. The chip lived inside
//   .vertical-opacity-title; in the PWA that wrapper is absolutely positioned
//   (rotated side-title fallback), so it became the chip's containing block
//   and dragged DISTANȚĂ down onto the top edge of the card, over the ×
//   button. The chip is now a direct child of the card (index.html) and the
//   stylesheet is re-versioned. The bump also pushes every installed app onto
//   a shell where the mirrored-row „PE HARTĂ / ON MAP” badge is gone (removed
//   in v124 — a stale cached shell was the only way to still see it).
// v131: the ✕ that closes a map-side slider is finally hittable on desktop.
//   ROOT CAUSE: without a z-index, the positioned .vertical-opacity-slider-
//   wrap (later in the DOM) painted OVER the bottom half of the absolutely-
//   positioned 22×22 transparent button and swallowed its clicks — only a
//   thin strip above the card was ever clickable, so closing a mirror took
//   several aim-and-click attempts. The button now paints above the wrap
//   (z-index: 2), grew to 26×26 with a visible disc, carries an invisible
//   ::before halo that grows the click target to ~40px (WCAG 2.5.8; the
//   halo overhangs the card edge, which has no overflow:hidden, and stays
//   clear of the slider's top end), lights up as soon as the cursor enters
//   the card, and scales up on hover/focus (disabled under
//   prefers-reduced-motion). Stylesheet and shell re-versioned.
// v132: în aplicația instalată (și pe orice ecran tactil) oglinda unui strat
//   se adaugă pe ecran DOAR la un tap deliberat pe cardul stratului. Înainte,
//   orice atingere a unui range din panou — inclusiv degetul care aluneca
//   peste el în timp ce derulai lista — selecta stratul prin pointerdown /
//   focus, arunca oglinda pe hartă și aprindea stratul; la fel, orice clic pe
//   card (chiar și cel produs la capătul unei derulări) închidea panoul și
//   aprindea stratul. Acum atingerea unui slider doar alimentează o oglindă
//   aflată deja pe ecran, iar tapul pe card este ignorat dacă gestul a fost o
//   derulare (deplasare peste prag, panou derulat între apăsare și ridicare,
//   tap care doar oprește o derulare, al doilea deget, apăsare lungă). Pe
//   desktop, în afara modului PWA, comportamentul rămâne neschimbat.
// v133: readuce butonul 🎯 de locație live în PWA ca un control fix separat
//   în dreapta-jos (safe-area + 28px), fără să readucă meniul contului din
//   vechea stivă de jos; site-ul păstrează butonul în coloana din stânga.
// v134: RAZĂ / DISTANȚĂ / ISTORIC rămâne vizibil deasupra oglinzii verticale
//   și în landscape (max-height ≤500px) — regula display:none care ascundea
//   cipul pe ecrane scurte e scoasă, la cererea explicită a utilizatorului
//   („cuvântul raza ... trebuie să apară deasupra lor când sunt adăugate”).
// v135: extinde v134 și pentru PERIOADĂ din stratul Bătălii — același
//   tratament: cip-ul rămâne vizibil în landscape, deasupra oglinzii.
// v136: PWA bottom-right stack restabilit — 🎯 live-location deasupra,
//   trigger cont (AN / Log In + dropdown) dedesubt, ambele în
//   #pwa-br-stack fix dreapta-jos cu safe-area; ascuns la transp-panel-open.
// v137: PWA — iconițele stratului (APM 2.0 „Ajutor de căutare”, Iosefină
//   Premium căutare / setări / sugerează) stau în coloană SUB sliderul lor
//   și în aplicația instalată. Ridicarea PWA din index.html
//   (`body.is-pwa #id { bottom: … !important }`, specificitate 1,1,1) bătea
//   `bottom: auto !important` al regulii andocate (1,1,0) și împingea
//   butoanele relative în sus, peste slider; același lucru strivea panoul
//   „Setări detecție” între top și bottom. css/styles.css re-afirmă geometria
//   andocată cu body.is-pwa în selector (1,2,1).
// v138: „Zone cu potențial arheologic” — canvas-ul stratului (z 660, deasupra
//   markerelor) nu mai înghite tap-ul pe pin-urile detectoriștilor după ce
//   stratul e pornit și apoi oprit. Pane-ul e click-through, iar rendererul
//   L.canvas e scos de pe hartă la dezactivare.
// v139: LIDAR Scanner — 12 site-uri noi în data/lidar_scanner_points.csv
//   (10 fortificații, 1 tumul, 1 burgus). CSV-ul e refetch-uit prin noul
//   ?v= din DATA_URL, iar scriptul rescris primește versiunea lui de
//   cache-busting ca PWA-ul instalat să nu mai servească shell-ul vechi.
// v140: „Amprenta Vegetației / Vegetation Fingerprint” — grup premium cu
//   substraturi CLMS HR-VPP. Primul substrat, PPI (Plant Phenology Index,
//   10 m, la fiecare 10 zile), se încarcă prin WMTS de la
//   phenology.hrvpp2.vgt.vito.be cu tile-uri limitate la suprafața României
//   (anvelopă + mască poligonală în js/map-app.js — vezi
//   VEGETATION_FINGERPRINT.md). map-app.js, translations.js,
//   subscriptions.js și vertical-opacity-control.js sunt re-versionate.
// v141: substratul SGU (VPP LSLOPE SEASON1 — rata de creștere la începutul
//   sezonului, „time” anual 2017–2024) se adaugă în același grup; cele
//   patru scripturi modificate primesc din nou ?v= ca PWA-ul instalat să
//   tragă shell-ul nou.
// v142: substratul SGD (VPP RSLOPE SEASON1 — rata de ofilire la finalul
//   sezonului, tot anual) al treilea strat din grup; aceleași patru
//   scripturi re-versionate.
// v144: sliderul „Istoric” al stratului Satelit trece de la ortofotoplanul
//   2016 (geo-spatial.org) la cele trei mozaicuri Copernicus VHR servite de
//   EEA discomap prin WMS — 2012 (VeryHighResolution2012/MapServer), 2018
//   (VHR_2018_WM/ImageServer) și 2021 (VHR_2021_LAEA/ImageServer) — deci
//   patru poziții (2012 / 2018 / 2021 / 2025). Stratul Satelit primește și
//   buton ⓘ, al cărui tab info citează „© European Union's Copernicus Land
//   Monitoring Service information”. discomap.eea.europa.eu intră în
//   PASSTHROUGH_HOSTS ca tile-urile WMS să nu treacă prin shell-ul cache-uit.
// v145: LIDAR Scanner — elimină marcajele suprapuse de lângă coordonatele
//   44.14573, 23.61337 și păstrează un singur obiectiv «fortificație».
// v146: lansare detectlab.eu — limba implicită și datele de contact urmează
//   domeniul (.ro / .eu), iar harta nu mai este blocată la limita României.
// v147: Hărți Istorice Europene (CENAGIS / IH PAN) — 22 de hărți și planuri
//   urbane istorice categorisite pe fiecare țară europeană (Web & PWA).
// v148: acțiunile rapide rămân legate de PROPRIA oglindă verticală. Astfel,
//   cele trei butoane Josephine Map + nu mai dispar când un alt substrat al
//   hărților istorice premium este adăugat în al doilea slider; ambele sloturi
//   își păstrează independent acțiunile până la închiderea propriei oglinzi.
// v149: resincronizarea acțiunilor nu mai depinde de aliasul temporar al
//   sliderului activ. Înlocuirea sau focalizarea celeilalte hărți istorice nu
//   mai poate lăsa butoanele Iosefină ascunse; versiunea nouă forțează și
//   actualizarea shell-ului pentru instalațiile PWA care aveau codul vechi.
// v150: cinci coordonate retrase din LIDAR Scanner sunt filtrate inclusiv din
//   copiile vechi ale CSV-ului; lidar-scanner.js și DATA_URL sunt re-versionate.
// v151: free European LiDAR catalogues and country-specific WMS controls.
// v152: the flat Leaflet country picker is replaced by a real 3D globe gate
//   (js/globe-country-picker.js, css/globe-country-picker.css) — a MapLibre GL
//   "globe" projection shown the first time a logged-in visitor reaches the
//   map. css/country-selector.css and js/country-selector.js are retired.
// v153: Netherlands LiDAR now uses the AHN6 DSM 50 cm ArcGIS ImageServer
//   (dynamic exportImage tiles in Web Mercator) instead of the older PDOK WMS.
// v162: Sweden · Lantmäteriet terrängskuggning (höjdmodell 1 m) as live WMS
//   1.1.1 tiles in EPSG:3857, behind the site's own credential-adding proxy
//   (js/lantmateriet-hojdmodell-layer.js).
// v163 (dk-dhm-wmts): Denmark LiDAR switches from the dhm_DAF WMS to
//   Dataforsyningen's DHM skyggekort WMTS (View1 / EPSG:25832), reprojected
//   client-side (js/dataforsyningen-dhm-layer.js); tiles go through the
//   same-origin /api/geo/dk-dhm proxy (netlify/functions/dk-dhm.mjs or the
//   Express geoProxy), which adds the token server-side.
// v164: the globe country gate is re-engineered on a plain 2D canvas
//   (d3-geo orthographic + per-pixel Blue Marble texture) — MapLibre GL is
//   retired from the shell; js/d3.min.js, js/topojson-client.min.js and
//   data/countries-50m.json ship locally instead.
// v165: the search bar honours the globe-selected country — non-RO countries
//   stream their localities from europe-places.geojsonseq (Supabase) while
//   Romania keeps OSM.geojson (see osmPlaceLookup / europePlaceLookup in
//   js/map-app.js). The places file itself is NOT precached (too large;
//   streamed + filtered per country at runtime).
// v166: CORONA "Satellite imagery 60's" — the coverage outlines are drawn
//   from the imagery catalogue itself (the same footprints the original
//   Corona Atlas uses), the degenerate world-spanning ring of corona2.kml is
//   filtered out, and the misleading Europe-wide red coverage rectangle is
//   retired. A static Europe catalogue snapshot is baked at deploy time
//   (netlify.toml [build] → data/corona-europe-catalog.json) so the layer
//   works for every covered country even without the runtime proxy.
//   Also: the Denmark LiDAR auth probe now reports a 404 from the proxy as
//   "proxy not deployed" instead of leaving the layer silently blank (the
//   production v161 deploy had no /api/geo/dk-dhm function at all).
// v167: Country dock — once a country is picked on the globe, a slide-down
//   country switcher is glued under the map search bar (current 2-letter code
//   + the full list of country initials, full name on hover) together with a
//   small "World hillshade" checkbox that lays the Esri World Hillshade tiles
//   over whichever basemap is already on screen (a selection never switches
//   the basemap any more — it only moves and locks the view). When the locked
//   country view is zoomed all the way out, an "Exit view" button appears
//   centred in the lower part of the screen: it releases the lock and reopens
//   the globe so another country can be chosen. See COUNTRY_SELECTION_DOCK.md,
//   js/country-dock.js and js/globe-country-picker.js.
// v168: Spain LiDAR switches from the IDEE WMTS relief cache
//   (servicios.idee.es/wmts/mdt) to the official IDEE/IGN "Mapa LiDAR" WMS
//   (wms-mapa-lidar.idee.es/lidar, layer EL.GridCoverage): the LiDAR surface
//   model with vegetation/building heights and hydrography, one GetMap per
//   Leaflet tile in EPSG:3857, clipped to the extent the capabilities declare
//   (see js/ign-mdt-layer.js and SPAIN_LIDAR_IGN_WMS.md). The GetMap URLs are
//   recognised by the offline-tile lookup ("request=getmap") and fall straight
//   through to the network on a cache miss, never into the app shell; idee.es
//   is listed in PASSTHROUGH_HOSTS like the other WMS tile hosts.
// v169: country-scoped layer window + visible country bounds. Once a country
//   is selected, the layer panel keeps only the layers whose coverage
//   partially or entirely overlaps the bounds of that country (rows outside
//   the country get .country-layer-unavailable, hidden by css/styles.css while
//   #transpPanel carries .country-filter-active; group rows hide too when no
//   sublayer survives). The selection also draws the country bounds on the
//   Leaflet map — the outline once the gate geometry is loaded, the bbox until
//   then — in its own pane above the data layers; both belong to the locked
//   view and go away on “Exit view”. See js/map-app.js (filterLayersForCountry
//   / unfilterLayersForCountry) and js/globe-country-picker.js.
// v173: the main Leaflet-controlled map now uses a single MapLibre GL 3D globe
//   as its permanent basemap (local inline style + Esri imagery raster source).
//   The existing canvas country gate remains WebGL-independent, country bounds
//   still drive Leaflet's maxBounds/zoom floor, and offline cached satellite
//   tiles are overlaid within their saved polygon instead of removing the globe.
//   MapLibre runtime/binding/style assets and the re-versioned map, offline,
//   dock and translation scripts are precached for installed PWAs.
// v174: the selected-country outline and its highlight are projected with the
//   same globe camera that draws the 3D basemap (DetectLabGlobeBase
//   .createProjectedFeature in js/globe-base-layer.js) instead of Leaflet's
//   Web Mercator, so they stay on the imagery when zoomed out and while the
//   globe moves. The basemap style and imagery are unchanged; the outline falls
//   back to Leaflet placement when no globe is live. The globe adapter now syncs
//   its camera on every map move instead of every 32 ms. globe-base-layer.js and
//   globe-country-picker.js are re-versioned and precached.
// v175: Leaflet raster overlays (LIDAR, WMS, XYZ tiles) can get a MapLibre "globe twin"
//   from DetectLabGlobeBase.attachTileTwin (js/globe-base-layer.js): the same tile URLs
//   drawn on the globe camera in the layer's own pane, so they stay on the basemap when
//   the globe moves or zooms. Not wired into any layer yet; globe-base-layer.js is
//   re-versioned and precached.
// v176: LIDAR layers get a globe twin when their URLs convert exactly
//   (_lidarGlobeTwin in js/map-app.js, DetectLabGlobeBase.attachTileTwin in
//   js/globe-base-layer.js). Layers that draw their own tiles, or whose requests
//   cannot be expressed as a MapLibre template, stay Leaflet layers.
// v177: canvas-drawn LIDAR sources (custom createTile: NL AHN, DK DHM, NO Hoydedata,
//   ArcGIS ImageServer grids) are shown only from zoom 11 on the live globe, with a
//   localised "zoom in more" message (_lidarApplyCanvasZoomGate in js/map-app.js).
//   map-app.js and translations.js are re-versioned and precached.
// v178: raster twins share one MapLibre overlay per Leaflet pane (globe-base-layer.js
//   attachTileTwin / paneOverlayFor). Each twin is one raster source and layer in its
//   pane's overlay, so the page holds one WebGL context per pane, not per twin.
// v179: the world hillshade is a globe twin (country-dock.js ensureHillshadeLayer ->
//   DetectLabGlobeBase.attachTileTwin), in pane_world_hillshade's shared overlay.
//   country-dock.js is re-versioned and precached.
// v180: index.html gives the LIDAR zoom message (#lidarZoomGateMsg) its PWA bottom offset.
// v181: the globe country gate draws the same Esri World Imagery tiles as the working
//   map's MapLibre globe (js/globe-country-picker.js samples them per pixel; the bundled
//   Blue Marble texture is only a fallback) over the same background colour, so the
//   basemap no longer changes when a country is picked. globe-country-picker.js/.css
//   are re-versioned and precached.
const CACHE_NAME = 'detectlab-v181-gate-imagery';
// Raster tiles explicitly downloaded by the user. This cache is separate from
// the app shell so expiring one offline area never evicts the PWA itself.
const OFFLINE_TILE_CACHE_NAME = 'detectlab-offline-tiles-v1';

// ── Detection settings ──
let detectionEnabled = false;
let backgroundDetectionEnabled = true; // can be disabled by user
let lastKnownPosition = null;

const PROTECTED_SITES_URL = 'https://detectlab-backend-production.up.railway.app/api/heritage-sites';
const PROTECTED_SITES_CACHE_KEY = 'protected-sites';

// v171: European CENAGIS sheets now live inside the one Premium Historical Maps
//   group and are filtered by the selected country's partial/full footprint;
//   Roman Empire DARE category icons/ISO2 reload, Pleiades sites, Herod and
//   Hasmonean layers are wired, and Roman road NDJSON keeps progressive drawing.
// v172: the country-scoped layer window lists ONLY the selected country's
//   layers (strict country attribution — see COUNTRY_LAYER_FILTER.md). National
//   services of neighbouring countries no longer leak in through bbox grazes;
//   shared CENAGIS sheets follow the curated coverage lists.
// ── Static assets to pre-cache on install ──
const PRECACHE_URLS = [
  // European Historical Maps (CENAGIS / IH PAN)
  'js/historical-eu-maps.js?v=20261008-country-overlap',
  'js/historical-eu-maps.js?v=20261008-country-layers-strict',
  'js/historical-eu-maps.js',
  // Host-aware market defaults for detectlab.ro and detectlab.eu.
  'js/site-config.js?v=20260928-eu-domain',
  'js/site-config.js',
  'js/translations.js?v=20260928-eu-domain',
  'js/archeo-report-pdf.js?v=20260928-eu-domain',
  // Report: shared potential field, exact scanner annotations, ignore option.
  'js/archeo-report.js?v=20260918-report-evidence',
  'js/archeo-report-pdf.js?v=20260918-report-evidence',
  'js/lidar-scanner.js?v=20260918-report-evidence',
  'js/translations.js?v=20260918-report-evidence',
  '.',
  'index.html',
  'css/styles.css',
  'css/styles.css?v=2026080502',
  'css/leaflet.css',
  'css/maplibre-gl.css?v=5.24.0',
  'css/globe-base-layer.css?v=20261009-3d-globe',
  'css/L.Control.Layers.Tree.css',
  'css/L.Control.Locate.min.css',
  'css/leaflet.photon.css',
  'css/leaflet-measure.css',
  'css/fontawesome-all.min.css',
  'css/MarkerCluster.css',
  'css/MarkerCluster.Default.css',
  'js/translations.js',
  'js/translations.js?v=2026080702',
  'js/translations.js?v=20260811',
  'js/leaflet.js',
  'js/maplibre-gl.js?v=5.24.0',
  'js/leaflet-maplibre-gl.js?v=0.1.4',
  'js/globe-base-layer.js?v=20261009-3d-globe',
  'js/globe-base-layer.js?v=20261009-globe-outline',
  'js/globe-base-layer.js?v=20261009-globe-raster-twin',
  'js/globe-base-layer.js?v=20261009-lidar-globe-twin',
  'js/globe-base-layer.js?v=20261010-shared-overlay',
  'js/L.Control.Layers.Tree.min.js',
  'js/L.Control.Locate.min.js',
  'js/leaflet-hash.js',
  'js/leaflet.photon.js',
  'js/leaflet-measure.js',
  'js/Autolinker.min.js',
  'js/supabase.js',
  'js/events.js?v=20260814-chat-realtime',
  'js/events.js?v=20260908-anonymous-event-sync',
  'js/last-location.js?v=20260815-last-location',
  'js/auth.js',
  'js/auth.js?v=20260729',
  'js/auth.js?v=20260730',
  'js/auth-forms.js',
  'js/account-legacy.js',
  'js/map-app.js',
  'js/map-app.js?v=20260814-coordinate-search',
  'js/map-app.js?v=20260815-last-location',
  'js/map-app.js?v=20260819-sat60-premium-layer',
  'js/map-app.js?v=20260902-satbase-native18',
  'js/map-app.js?v=20260908-coordinate-formats',
  'js/patrimoniu-clustering.js?v=20260914-patrimoniu-cluster',
  'js/map-app.js?v=20260914-patrimoniu-zoom-anchor',
  'js/map-app.js?v=20260914-premium-hist-pwa-fix',
  'js/map-app.js?v=20260915-patrimoniu-pwa-zoom-fix',
  'css/styles.css?v=20260915-patrimoniu-pwa-zoom-fix',
  'js/corona-wms-layer.js',
  'js/corona-wms-layer.js?v=20260812-layers',
  'js/corona-wms-layer.js?v=20261006-europe',
  'js/corona-coverage-layer.js',
  'js/corona-coverage-layer.js?v=20261006-europe',
  'js/corona-coverage-layer.js?v=20261008-corona-coverage',
  'js/hoydedata-layer.js',
  'js/hoydedata-layer.js?v=20261006-norway',
  'js/map-app.js?v=20261006-corona-europe',
  'js/geoportal-nmt-layer.js',
  'js/geoportal-nmt-layer.js?v=20261006-poland',
  'js/ign-mdt-layer.js',
  'js/ign-mdt-layer.js?v=20261006-spain',
  'js/ign-mdt-layer.js?v=20261007-spain-mapa-lidar',
  'js/ahn-layer.js',
  'js/ahn-layer.js?v=20261006-ahn',
  'js/swisstopo-relief-layer.js',
  'js/swisstopo-relief-layer.js?v=20261006-swisstopo',
  'js/ea-lidar-wmts-layer.js',
  'js/ea-lidar-wmts-layer.js?v=20261006-ea-lidar',
  'js/dataforsyningen-dhm-layer.js',
  'js/dataforsyningen-dhm-layer.js?v=20261006-dk-dhm',
  'js/dataforsyningen-dhm-layer.js?v=20261007-dk-dhm-wmts',
  'js/dataforsyningen-dhm-layer.js?v=20261008-dk-proxy-notice',
  'js/lantmateriet-hojdmodell-layer.js',
  'js/lantmateriet-hojdmodell-layer.js?v=20261007-se-hojdmodell',
  'js/map-app.js?v=20261006-norway-hoydedata',
  'js/map-app.js?v=20261006-spain-mdt',
  'js/map-app.js?v=20261006-ahn-exportimage',
  'js/map-app.js?v=20261006-dk-dhm-wms',
  'js/map-app.js?v=20261007-se-hojdmodell',
  'js/map-app.js?v=20261008-eu-places-search',
  'js/map-app.js?v=20261008-corona-coverage',
  'js/map-app.js?v=20261007-spain-mapa-lidar',
  'js/map-app.js?v=20261008-country-layer-filter',
  'js/map-app.js?v=20261008-premium-historical-roman',
  'js/map-app.js?v=20261008-country-layers-strict',
  'js/archeo-potential.js',
  'js/archeo-potential.js?v=20260803',
  'js/lidar-geo.js?v=20260811-latlon',
  'js/lidar-scanner.js?v=20260812-scanner-above-lidar',
  'css/styles.css?v=20260811-lidar-perf',
  'css/styles.css?v=20260812-vertical-opacity',
  'css/library-of-babel.css?v=20260815',
  'css/library-of-babel.css?v=20260819',
  'css/library-of-babel.css?v=20260827-historical-dossier',
  'css/library-of-babel.css?v=20260831-babel-multisource',
  'css/library-of-babel.css?v=20260902-babel-osm-nearby',
  'css/library-of-babel.css?v=20260902-babel-safe-area',
  'css/library-of-babel.css?v=20260917-babel-epochs',
  'js/library-of-babel.js?v=20260815',
  'js/library-of-babel.js?v=20260819',
  'js/library-of-babel.js?v=20260827-historical-dossier',
  'js/library-of-babel.js?v=20260828-evidence-search-fix',
  'js/library-of-babel.js?v=20260831-babel-multisource',
  'js/library-of-babel.js?v=20260902-babel-osm-nearby',
  'js/library-of-babel.js?v=20260831-babel-cimec',
  'js/library-of-babel.js?v=20260831-babel-periods-lexicon',
  'js/library-of-babel.js?v=20260917-babel-epochs',
  'js/vertical-opacity-control.js',
  'js/vertical-opacity-control.js?v=20260812',
  'js/vertical-opacity-control.js?v=20260918-layer-initials',
  'css/styles.css?v=20260918-layer-initials',
  'js/auth.js?v=20260812-vertical-opacity',
  'js/subscriptions.js?v=20260812-premium',
  'js/checkout.js?v=20260812-premium',
  'js/subscriptions.js?v=20260812-payments',
  'js/checkout.js?v=20260812-payments',
  'js/translations.js?v=20260812-payments',
  'js/translations.js?v=20260812-premium-catalogue',
  'js/subscriptions.js?v=20260812-premium-catalogue',
  'css/styles.css?v=20260812-premium-catalogue',
  'css/checkout.css?v=20260812',
  // ── One-time €5 Premium purchase (no automatic renewal) ──
  'js/translations.js?v=20260813-onetime',
  'js/subscriptions.js?v=20260813-onetime',
  'js/checkout.js?v=20260813-onetime',
  'js/account-legacy.js?v=20260813-onetime',
  'js/auth.js?v=20260813-onetime',
  'css/checkout.css?v=20260813-onetime',
  // Promo codes (free-trial redemption in the popup + checkout page).
  'js/translations.js?v=20260814-promo',
  'js/translations.js?v=20260814-useful-info',
  'js/subscriptions.js?v=20260814-promo',
  'js/subscriptions.js?v=20260819-sat60-premium-layer',
  'js/checkout.js?v=20260814-promo',
  'js/account-legacy.js?v=20260814-promo',
  'js/auth.js?v=20260814-promo',
  'css/checkout.css?v=20260814-promo',
  'css/styles.css?v=20260814-promo',
  'checkout.html',
  // Documentation tabs: the “Tehnologie / Technology” and “Proces / Process”
  // pages moved off the homepage into their own RO/EN page pair. Precached so
  // they also open offline from the installed PWA.
  'tehnologie.html',
  'technology.html',
  'proces.html',
  'process.html',
  'css/documentation.css',
  'css/documentation.css?v=20260917-doc-tabs',
  'images/pwa-icon-192.png',
  'images/pwa-icon-512.png',
  // Archeological Report premium layer: self-contained PDF writer + report +
  // canvas-rendered PDF pages (no external PDF library is fetched at runtime).
  'js/pdf-writer.js?v=20260827-arch-report',
  'js/archeo-report-pdf.js?v=20260827-arch-report',
  'js/archeo-report.js?v=20260827-arch-report',
  'js/archeo-potential.js?v=20260827-arch-report',
  'js/lidar-scanner.js?v=20260827-arch-report',
  'js/translations.js?v=20260827-arch-report',
  'css/styles.css?v=20260827-arch-report',
  // Archeological Report fix release: Search-Help-style APM figure polygons,
  // century/name-based period estimation, user-picked PDF language.
  'js/archeo-report-pdf.js?v=20260827-arch-report-v2',
  'js/archeo-report.js?v=20260827-arch-report-v2',
  'js/translations.js?v=20260827-arch-report-v2',
  'css/styles.css?v=20260827-arch-report-v2',
  // Archaeological Report: circular 1–10 km radius, blue LIDAR-like UI, dark PDF.
  'js/archeo-report-pdf.js?v=20260831-arch-report-v4',
  'js/archeo-report.js?v=20260831-arch-report-v4',
  'js/archeo-report.js?v=20260902-arch-report-v4',
  'js/translations.js?v=20260831-arch-report-v4',
  'css/styles.css?v=20260831-arch-report-v4',
  // Battles v3: on-hover century bubble on the period slider + the century
  // range mirrored in the map-side vertical control like every other layer.
  'js/battles-layer.js?v=20260901-battles-v3',
  'js/vertical-opacity-control.js?v=20260901-battles-v3',
  'css/styles.css?v=20260901-battles-v3',
  // Josephine source transition: pure CSS/SVG sonar overlay (the animated
  // sonar webp/mp4 are gone — no more image glitching on the map).
  'css/styles.css?v=20260902-josephine-sonar',
  // Battles v5: compact battle info window — hard width/height caps (px + vh/vw),
  // smaller type and spacing, and a long description collapsed to a few lines
  // behind a "Detalii / Details" toggle, so the popup no longer covers the screen.
  'js/battles-layer.js?v=20260902-battles-compact',
  'js/translations.js?v=20260902-battles-compact',
  'css/styles.css?v=20260902-battles-compact',
  // Battles v6: battle title tags are now L.marker anchored GEOGRAPHICALLY on
  // the top edge of their own radius (lat + radius/6371000 → exactly where
  // L.Circle._project paints the circle top). Leaflet moves them natively on
  // pan / zoom / pinch / flyTo, so they no longer drift or jump between zooms.
  'js/battles-layer.js?v=20260902-battles-label-anchor',
  'css/styles.css?v=20260902-battles-label-anchor',
  // Mini tutorial: "?" button (top-right of the map) + 5 purple, blurred
  // slides with arrows pointing at the real side / bottom-bar controls,
  // the layers panel, the free & premium layer catalogue and perf tips.
  'js/tutorial.js?v=20260907-tutorial-events',
  'css/tutorial.css?v=20260908-tutorial',
  // Tutorial slides now cross-fade and slide in the direction of travel
  // instead of cutting: staggered callouts, length-matched arrow drawing,
  // swipe / drag navigation, and the layers slide waits for the panel to
  // finish opening before its arrows are measured.
  'js/tutorial.js?v=20260908-smooth-slides',
  'css/tutorial.css?v=20260908-smooth-slides',
  // Offline maps: polygon editor, IndexedDB metadata and tile-cache UI.
  'js/offline-maps.js?v=20260915-offline-maps',
  'css/offline-maps.css?v=20260915-offline-maps',
  // Offline-maps panel polish: named zoom pickers, tap-to-close the polygon,
  // sticky size error, and panel geometry inside the map canvas / above the
  // PWA bottom bar / under the phone status bar. The tutorial slide for
  // #btnOfflineMaps describes the same flow, so it ships in the same version.
  'js/offline-maps.js?v=20260915-offline-panel',
  'css/offline-maps.css?v=20260915-offline-panel',
  'js/tutorial.js?v=20260915-offline-panel',
  // Nearby detectorists: the popup card (.map-place-popup) used to be
  // position:absolute, which pulled it out of the Leaflet popup's flow and left
  // an empty little popup box next to the info card — two windows, one of them
  // blank, on every nearby pin (offline bubbles included). Now in-flow only.
  'css/styles.css?v=20260907-nearby-popup',
  // Subtle layer coverage highlights + standalone map/layout/auth hooks.
  // Keep the installed/offline PWA on the same CSS and JS as index.html.
  'css/styles.css?v=20260907-layer-visibility-pwa',
  'js/map-app.js?v=20260907-layer-visibility-pwa',
  // Android install flow: Samsung Internet & OEM browsers mint a WebAPK that
  // Google Play Protect blocks, so the install section now routes those users
  // to Chrome and explains the "Unsafe app blocked" dialog.
  'css/styles.css?v=20260914-android-install',
  'js/translations.js?v=20260914-android-install',
  // Satellite "Istoric": the Satellite layer gains a period slider — 2016 and
  // 2018 national orthophotos (geo-spatial.org WMS) alongside the present-day
  // imagery; the vertical opacity mirror is joined on the map by a vertical
  // period mirror, both visible at the same time.
  'js/map-app.js?v=20260915-sat-historic',
  // Da/Nu visibility prompt when enabling Detect / live location.
  'js/map-app.js?v=20260915-visibility-prompt',
  'js/vertical-opacity-control.js?v=20260915-sat-historic',
  'js/translations.js?v=20260915-sat-historic',
  'css/styles.css?v=20260915-sat-historic',
  // Social layer ("Prieteni / Friends"): friends, friend requests, private and
  // group chat with an admin, events started from a chat, and the
  // "Adaugă prieteni / Add friends" box of the create-event form.
  'js/friends.js?v=20260915-social',
  'js/events.js?v=20260915-social',
  'js/translations.js?v=20260915-social',
  // Detectorist pins on the map ("Vezi alți detectoriști în zonă"): the live
  // (orange) and offline (black/white) popups now carry the social action slot
  // — friend request / accept / cancel / send message — painted by friends.js
  // when the popup opens.
  'js/friends.js?v=20260915-map-social',
  'js/map-app.js?v=20260915-map-social',
  'css/styles.css?v=20260915-map-social',
  // Satellite „Istoric” without 2018 + the installed-PWA mirror fix:
  // • the base layer keeps only the 2016 orthophoto (GeoServer „geospatial”)
  //   and the present-day Esri imagery — the 2018 layer (GeoServer „clc”) is
  //   gone, so the period slider has two stops (2016 / 2025);
  // • the two map-side vertical mirrors (opacity + period) no longer collapse
  //   onto the same anchor inside the ≤600px breakpoint, which is exactly the
  //   width every installed PWA / phone reports — in standalone mode only the
  //   ISTORIC mirror used to be visible, never the pair.
  'css/styles.css?v=20260916-sat-2016-only',
  'js/map-app.js?v=20260916-sat-2016-only',
  'js/vertical-opacity-control.js?v=20260916-sat-2016-only',
  'js/auth.js?v=20260916-sat-2016-only',
  // The map-side opacity mirror drops its "OPACITY" caption strip; the caption
  // row collapses (:empty) so the layer name sits at the top of the control.
  'css/styles.css?v=20260916-no-opacity-caption',
  'js/vertical-opacity-control.js?v=20260916-no-opacity-caption',
  // PWA bottom bar removed: the bottom-right account stack absorbs
  // language + storage, Detect moves under the tap-to-lock compass,
  // nearby detectorists join the left icon stack, live-location sits
  // above the account avatar.
  'css/styles.css?v=20260916-no-bottom-bar',
  'css/offline-maps.css?v=20260916-no-bottom-bar',
  'js/map-app.js?v=20260916-no-bottom-bar',
  'js/events.js?v=20260916-no-bottom-bar',
  'js/friends.js?v=20260916-no-bottom-bar',
  'js/tutorial.js?v=20260916-no-bottom-bar',
  'js/translations.js?v=20260916-no-bottom-bar',
  'js/vertical-opacity-control.js?v=20260916-no-bottom-bar',
  // Detectorist popups become a horizontal card (avatar + identity row,
  // actions below); the popup re-runs its Leaflet layout after friends.js
  // paints the slot, so buttons and messages stay inside the frame.
  // "Adaugă prietenie" is renamed to "Adaugă prieten".
  'css/styles.css?v=20260916-friend-card',
  'js/friends.js?v=20260916-friend-card',
  'js/map-app.js?v=20260916-friend-card',
  'js/translations.js?v=20260916-friend-card',
  // Unified friend search (migration 20260916010000): one query matched
  // partially, diacritics folded, against name / e-mail / county / city /
  // id; multi-word queries need every word in at least one column.
  'js/friends.js?v=20260916-unified-search',
  // "?" tutorial: 6th slide for the Friends panel (unified search,
  // requests, chats), PWA control positions (Detect under the compass,
  // live-location above the account icon, magnifier in the left stack)
  // and the "Adaugă prieten" detectorist card.
  'js/tutorial.js?v=20260916-tutorial-friends',
  // Harta Transilvaniei 1859 + Hartă administrativă a Galiției și Lodomeriei
  // 1855: ⓘ layer info, Leaflet attribution and the offline-maps panel now also
  // state "Digitalizare și publicare: Universitatea „Ștefan cel Mare” din
  // Suceava · Sursă: bukowina1856.eu" (the source domain is clickable in the
  // popup, hence the styles.css + map-app.js re-version).
  'css/styles.css?v=20260916-map-source-usv',
  'js/map-app.js?v=20260916-map-source-usv',
  'js/offline-maps.js?v=20260916-map-source-usv',
  // Straturile de analiză (LIDAR Scanner, Zone cu potențial arheologic, Raport
  // arheologic): sliderul de distanță/rază e oglindit vertical pe hartă exact ca
  // opacitatea, iar butonul de acțiune al stratului se andochează centrat jos
  // (#layerActionDock). Potențialul arheologic primește pin mov + rază 1–10 km
  // și două moduri de ieșire — bule dense fără goluri și hartă termică pe
  // fiecare punct (leaflet-heat.js intră acum în app shell), cu zonele excluse
  // (UAT + raze de protecție) marcate cu roșu.
  'js/leaflet-heat.js?v=20260916-analysis-dock',
  'css/styles.css?v=20260916-analysis-dock',
  'js/translations.js?v=20260916-analysis-dock',
  'js/vertical-opacity-control.js?v=20260916-analysis-dock',
  'js/archeo-potential.js?v=20260916-analysis-dock',
  'js/lidar-scanner.js?v=20260916-analysis-dock',
  'js/archeo-report.js?v=20260916-analysis-dock',
  // Zone cu potențial arheologic — „sweet spot” pentru bule + heatmap real:
  //   • bulele nu mai pavează toată harta: se desenează doar celulele care au
  //     loc ca disc întreg, deci nu se ating între ele și nu intră peste razele
  //     de protecție ale siturilor sau peste masca roșie UAT;
  //   • heatmap-ul nu mai e leaflet-heat (alfa acumulat → culoare aproape
  //     constantă + alunecare la zoom), ci un raster de scoruri desenat pe un
  //     canvas ancorat în geografie, cu scala întinsă pe percentila 2..98 a
  //     rulării ca diferența slab↔tare să se vadă clar.
  'js/archeo-potential.js?v=20260916-archeo-sweetspot',
  'css/styles.css?v=20260916-archeo-sweetspot',
  'js/translations.js?v=20260916-archeo-sweetspot',
  // Panoul de straturi se întinde acum pe toată înălțimea hărții (fără tăierea
  // la 560px din PWA) și fără padding jos; titlul oglinzii verticale iese din
  // card, deasupra lui; sliderele LIDAR / potențial arheologic / raport primesc
  // culoarea pinului și a razei stratului lor; lupa pornește doar locația live;
  // căutarea de prieteni caută în timp ce scrii și arată de ce nu a ajuns la
  // server; harta offline se desenează doar ca poligon și are un ✕ centrat jos
  // pentru ieșire.
  'css/styles.css?v=20260916-pwa-panel-offline-exit',
  'css/offline-maps.css?v=20260916-pwa-panel-offline-exit',
  'js/translations.js?v=20260916-pwa-panel-offline-exit',
  'js/friends.js?v=20260916-pwa-panel-offline-exit',
  'js/map-app.js?v=20260916-pwa-panel-offline-exit',
  'js/offline-maps.js?v=20260916-pwa-panel-offline-exit',
  'js/vertical-opacity-control.js?v=20260916-pwa-panel-offline-exit',
  'js/archeo-potential.js?v=20260916-pwa-panel-offline-exit',
  'js/lidar-scanner.js?v=20260916-pwa-panel-offline-exit',
  'js/archeo-report.js?v=20260916-pwa-panel-offline-exit',
  'js/tutorial.js?v=20260916-pwa-panel-offline-exit',
  // Guvernorul global de tile-uri: oprește explozia de tile-uri (și crash-ul
  // paginii) când sunt deschise simultan mai multe straturi dense — LIDAR,
  // „Imagini satelitare anii 60'", hărți istorice, APM — și se face un gest
  // brusc de zoom. Se încarcă imediat după Leaflet, înaintea map-app.js.
  // Vezi MAP_LAYER_PERFORMANCE.md.
  'js/tile-perf.js',
  'js/tile-perf.js?v=20260917-tile-perf',
  'js/translations.js?v=20260917-tile-perf',
  'js/map-app.js?v=20260917-tile-perf',
  // PWA layers window flush to the screen bottom; live-location / profile
  // stay on the right (hidden while the panel is open, never teleported left).
  'css/styles.css?v=20260917-pwa-panel-flush',
  'js/map-app.js?v=20260917-pwa-panel-flush',
  // „Zone cu potențial arheologic": bulele umplu terenul liber (împachetare pe
  // trepte de mărime + rețea de umplutură), heatmap-ul colorează fiecare celulă
  // liberă pe o scară absolută comună cu legenda, iar excluderea UAT se decide
  // pe celulă (probe multiple) după ce tile-urile sunt pre-încărcate — cu
  // fail-open când rasterul nu poate fi citit. Vezi ARCHEO_POTENTIAL.md.
  'js/archeo-potential.js?v=20260917-archeo-coverage',
  'js/map-app.js?v=20260917-archeo-coverage',
  'js/translations.js?v=20260917-archeo-coverage',
  'css/styles.css?v=20260917-archeo-coverage',
  // „Prieteni”: căutarea de detectoriști și lista de prieteni au acum taburi
  // separate („Caută prieteni” / „Prietenii tăi”), iar chat-ul cu un prieten
  // primește padding de safe-area în PWA — bara de stare a telefonului nu mai
  // acoperă butoanele ← / ⋯ / 📅. Ghidul (?-ul hărții) deschide tabul de
  // căutare și arată ambele taburi noi.
  'js/friends.js?v=20260917-friends-tabs',
  'js/tutorial.js?v=20260917-friends-tabs',
  // PWA „Social”: pinurile de detectoriști primesc zonă de tap de 44px și
  // acțiunea pornește direct din touchend (fără click sintetizat); citirea
  // firelor de chat trece pe get_conversation_messages() (newest-first) cu
  // verificare după trimitere, iar re-pictările fără schimbare de stare nu
  // mai distrug butonul din mijlocul tap-ului.
  'js/friends.js?v=20260917-pwa-social-fix',
  'js/map-app.js?v=20260917-pwa-social-fix',
  'css/styles.css?v=20260917-pwa-social-fix',
  // Oglinzile verticale de opacitate devin mai înguste: casetă de sticlă
  // semi-transparentă cu blur (fără fundalul mov), titlul stratului scris
  // vertical de jos în sus pe laterala stângă a sliderului (max. 15
  // caractere, restul „…”) și procentul vizibil doar cât timp se modifică
  // opacitatea.
  'css/styles.css?v=20260917-vertical-slim-glass',
  'js/vertical-opacity-control.js?v=20260917-vertical-slim-glass',
  // Fluid zoom: load the new zoom sooner and keep covering tiles until the
  // incoming ones are active, without restoring per-frame _update during
  // pinch/wheel. Dark map background hides Leaflet's #ddd through empty tiles.
  'js/tile-perf.js?v=20260917-tile-fluid',
  'js/map-app.js?v=20260917-tile-fluid',
  'css/styles.css?v=20260917-tile-fluid',
  // „🧭 Traseu Google Maps” în popup-uri: fiecare punct LIDAR Scanner, candidat
  // din Raportul arheologic, bule cu potențial arheologic, pin salvat și
  // evenimente primește un buton de direcție. Destinația e ÎNTOTDEAUNA centrul
  // cercului/pinului (nu marginea), indiferent cât de mare e raza — vezi
  // js/google-maps-directions.js.
  'js/google-maps-directions.js?v=20260917-gmaps-directions',
  'js/events.js?v=20260917-gmaps-directions',
  'js/map-app.js?v=20260917-gmaps-directions',
  'js/archeo-potential.js?v=20260917-gmaps-directions',
  'js/lidar-scanner.js?v=20260917-gmaps-directions',
  'js/archeo-report.js?v=20260917-gmaps-directions',
  'css/styles.css?v=20260917-gmaps-directions',
  // „Zone cu potențial arheologic": heatmap-ul e desenat nord în sus (rândurile
  // rasterului se inversează în bitmap-ul sursă — înainte ieșea oglindit N–S
  // față de bule, cu „goluri” în zone care nu sunt nici UAT, nici raze de
  // sit); switch-ul „Mod pin” e scos — logica de punct pe hartă e permanentă
  // (urmează comutatorul mare al stratului, care poartă și oglinda razei +
  // dock-ul), iar textul de info al stratului e înlocuit.
  'js/archeo-potential.js?v=20260918-archeo-heat-northup',
  'js/translations.js?v=20260918-archeo-heat-northup',
  'js/vertical-opacity-control.js?v=20260918-archeo-heat-northup',
  'css/styles.css?v=20260918-archeo-heat-northup',
  // „Zone cu potențial arheologic”: explicația (logica de triangulare, roșu =
  // excluse) a fost mutată din bara de sub legendă în fereastra butonului de
  // info „i” (sub titlu + atribuire), iar stratul nu mai pornește ON implicit
  // — pinul mov, oglinda razei și butonul „Detectează” se activează numai
  // după ce utilizatorul aprinde comutatorul.
  'js/archeo-potential.js?v=20260918-archeo-info-toggle-off',
  'js/translations.js?v=20260918-archeo-info-toggle-off',
  'css/styles.css?v=20260918-archeo-info-toggle-off',
  // „Zone cu potențial arheologic” OFF by default (forțat): browserele
  // restaurează starea bifată a checkbox-ului la reload, iar vechea citire a
  // comutatorului la boot pornea stratul ON fără voia utilizatorului. wireUI()
  // resetează acum explicit comutatorul + starea internă la prima cablare.
  'js/archeo-potential.js?v=20260922-archeo-default-off',
  // Battles info tab: the epoch-colour legend is shown below the layer
  // attribution instead of taking space in the layers panel.
  'css/styles.css?v=20260918-battles-info-legend',
  // Seamless tiles: kill the white grid (Leaflet's mix-blend-mode:
  // plus-lighter adds the colours of the 1px tile overlap instead of
  // covering them, saturating every 256px seam to white) and make the zoom
  // handoff a real cross-fade on every device (CSS-only tile fade, no
  // per-frame JS). See MAP_LAYER_PERFORMANCE.md.
  'js/tile-perf.js?v=20260918-tile-seamless',
  'css/styles.css?v=20260918-tile-seamless',
  // Hărți offline: limita de download crește la 100 km² și catalogul gratuit
  // primește Patrimoniu (WMS CIMEC), cele trei hărți istorice gratuite eharta
  // (Austriacă 1910, Planuri de Tragere 20k, Sovietică 1970) și Localități
  // OSM (GeoJSON cache-uit ca un singur document). Vezi OFFLINE_MAPS_100KM2.md.
  'js/offline-maps.js?v=20260918-offline-100km-free-layers',
  // Notificări sociale: cerculețul roșu de pe butonul de profil adună tot ce
  // așteaptă (chat-uri de eveniment necitite + cereri de prietenie + mesaje
  // necitite), iar o cerere sau un mesaj nou apare ca pop-up în colțul din
  // dreapta sus. js/events.js și js/friends.js scriu în aceleași două elemente
  // prin window.DetectLabNotify.
  'js/events.js?v=20260918-social-notify',
  'js/friends.js?v=20260918-social-notify',
  // Banda închisă la culoare de sub hartă în PWA-ul instalat (iPhone): cauza e
  // ICB-ul scurt cu safe-area-inset-top dat de viewport-fit=cover +
  // black-translucent, iar #map-section / .transp-panel primesc podeaua
  // min-height:100vh. js/pwa-debug.js e sonda opțională de pe dispozitiv
  // (?pwaDebug=1 / ?pwaDebug=colors, sau 5 tap-uri pe eticheta „© Leafleet”).
  // Vezi PWA_BOTTOM_BAND.md.
  'js/pwa-debug.js?v=20260918-pwa-bottom-probe',
  // „Vezi alți detectoriști în zonă” întreabă și el „Vrei să fii vizibil și
  // pentru alți utilizatori?” (Da/Nu), exact ca switchul de detecție: căutarea
  // așteaptă răspunsul înainte să publice prezența sau să pornească locația
  // live, iar „Nu” doar te ține ascuns — căutarea merge înainte.
  'js/map-app.js?v=20260921-nearby-visibility-prompt',
  // PWA bottom-right stack: 🎯 live-location deasupra + cont dedesubt
  // (restaurat în v136); ascuns la transp-panel-open.
  'js/map-app.js?v=20260923-pwa-live-location',
  'js/tutorial.js?v=20260923-pwa-live-location',
  // These four were referenced by index.html with a cache-busted query string
  // but never added here, so an already-installed PWA kept serving whatever
  // older copy it had cached under the un-versioned URL instead of picking up
  // the current script/stylesheet on the next update. Re-added so the v119
  // bottom-band fix below (index.html's inline scripts) actually reaches
  // installed apps together with the styles/auth/newsletter/map-rotate code
  // that shipped alongside it.
  'css/styles.css?v=20260922-two-layer-mirrors',
  'js/vertical-opacity-control.js?v=20260922-two-layer-mirrors',
  // Mirrored-layer rows lose the "PE HARTĂ" badge and keep only a slightly
  // lighter panel shade instead (desktop + installed PWA share these files).
  'css/styles.css?v=20260922-mirrored-light-shade',
  'js/vertical-opacity-control.js?v=20260922-mirrored-light-shade',
  'js/auth.js?v=20260922-resend-confirm',
  'js/map-rotate.js?v=20260916-no-bottom-bar',
  'js/newsletter.js?v=20260916-newsletter',
  // Mobile WEB fullscreen: bottom-left compass column clears the browser's
  // bottom search bar; the "?" help button stays in the top-right corner
  // (tutorial.css) instead of sliding against the map search bar.
  'css/styles.css?v=20260922-mobile-fs-controls',
  'css/tutorial.css?v=20260922-mobile-fs-controls',
  // v127: the layer quick-action icons (APM 2.0 „Ajutor de căutare” + the three
  // Iosefină Premium buttons) are now styled from the shared
  // .vertical-opacity-actions container, so they dock under the slider in the
  // SECOND on-screen mirror too instead of keeping their floating
  // bottom-center geometry there. Both files are cache-busted on the page, so
  // both URLs must be pre-cached for an installed PWA to pick them up.
  'css/styles.css?v=20260922-vo-actions-both-slots',
  'js/vertical-opacity-control.js?v=20260922-vo-actions-both-slots',
  // v128: a mirror left ALONE on screen slides onto the right-most anchor
  // (class „mirror-sole”), and adding a slider on screen now really STARTS its
  // layer even when the panel switch was left checked by browser form
  // restoration (reload / back-forward) — the switch-on event fires regardless.
  'css/styles.css?v=20260922-sole-mirror-activate',
  'js/vertical-opacity-control.js?v=20260922-sole-mirror-activate',
  // v129: single-slot distance-mirror close (see the CACHE_NAME note above).
  // Both the control module and the three analysis layers ship together, so
  // all four changed URLs are pre-cached for the installed PWA.
  'js/vertical-opacity-control.js?v=20260922-distance-mirror-close',
  'js/archeo-potential.js?v=20260922-distance-mirror-close',
  // v138: archeo potential canvas must not swallow detectorist pin taps after
  // the layer is switched off (click-through pane + renderer detach).
  'js/archeo-potential.js?v=20260923-archeo-clickthrough',
  'js/lidar-scanner.js?v=20260922-distance-mirror-close',
  'js/archeo-report.js?v=20260922-distance-mirror-close',
  // v130: caption chip (DISTANȚĂ / RAZĂ / ISTORIC) anchored to the card
  // itself, so it floats above the slider in the PWA as well.
  'css/styles.css?v=20260922-caption-above-card',
  // v131: the mirrors' ✕ close button grew a visible disc and a ~40px
  // invisible hit halo — on desktop the 22px glyph target was nearly
  // impossible to hit with the mouse.
  'css/styles.css?v=20260923-close-hit-area',
  // v132: „tap concret pe strat” — in the installed PWA / on touch, the layer
  // mirror is added on screen only by a deliberate tap on the layer card.
  // Touching or dragging a panel range no longer adds a mirror and no longer
  // switches its layer on, and scroll-shaped gestures on a card are ignored.
  'js/vertical-opacity-control.js?v=20260923-deliberate-tap',
  // v134: RAZĂ / DISTANȚĂ / ISTORIC stays above the vertical mirror in
  // landscape too — the max-height:500px display:none is removed per user
  // request that the word must appear above its slider whenever on screen.
  'css/styles.css?v=20260923-raza-always-visible',
  // v135: same fix extended to PERIOADĂ (Battles layer) — user asked for
  // „perioada” in Bătălii as well.
  'css/styles.css?v=20260923-raza-perioada-always-visible',
  // v136: PWA bottom-right stack restabilit — 🎯 live-location deasupra,
  //   trigger cont (AN / Log In + dropdown) dedesubt, ambele în
  //   #pwa-br-stack fix dreapta-jos cu safe-area; ascuns la transp-panel-open.
  'css/styles.css?v=20260923-pwa-br-stack-account',
  'js/map-app.js?v=20260923-pwa-br-stack-account',
  'js/tutorial.js?v=20260923-pwa-br-stack-account',
  // v137: PWA — layer quick actions (APM 2.0 / Iosefină Premium) dock in a
  // column UNDER their slider in the installed app too; the index.html PWA
  // lift (`body.is-pwa #id { bottom: … !important }`) no longer beats the
  // docked geometry, and the „Setări detecție” panel keeps its auto height.
  'css/styles.css?v=20260923-pwa-docked-actions',
  // v139: LIDAR Scanner — 12 site-uri noi în data/lidar_scanner_points.csv;
  // DATA_URL din script a fost refăcut, deci PWA-ul trebuie să ia fișierul nou.
  'js/lidar-scanner.js?v=20260927-deduplicate-fortification',
  // v150: blacklist persistent pentru cele cinci coordonate retrase.
  'js/lidar-scanner.js?v=20261002-remove-five-points',
  // v140: „Amprenta Vegetației / Vegetation Fingerprint” (premium) — primul
  // substrat PPI din CLMS HR-VPP, cu tile-uri WMTS limitate la România.
  // v141: + substratul SGU (VPP LSLOPE, anual); v142: + SGD (VPP RSLOPE).
  'js/map-app.js?v=20260926-vegfp-smx',
  'js/translations.js?v=20260926-vegfp-smx',
  'js/subscriptions.js?v=20261008-premium-roman-guard',
  'js/vertical-opacity-control.js?v=20260926-vegfp-smx',
  // v144: Satellite „Istoric” = Copernicus VHR 2012 / 2018 / 2021 + 2025.
  // The panel slider grows from two stops to four, both the panel and the
  // map-side mirror ship the new stop markers, and the Satellite card gains
  // the ⓘ button that credits the Copernicus Land Monitoring Service.
  'css/styles.css?v=20260927-sat-copernicus-vhr',
  'css/styles.css?v=20261002-european-lidar',
  'css/styles.css?v=20261008-roman-dare-icons',
  'css/globe-country-picker.css?v=20261008',
  'css/globe-country-picker.css?v=20261010-gate-imagery',
  'js/globe-country-picker.js?v=20261008',
  'js/globe-country-picker.js?v=20261008-country-bounds',
  'js/globe-country-picker.js?v=20261009-globe-outline',
  'js/globe-country-picker.js?v=20261010-gate-imagery',
  // v167: country dock glued under the search bar (country switcher +
  // World-hillshade checkbox) and the “Exit view” button of the locked
  // country view. The hillshade tiles themselves stay network-only.
  'css/country-dock.css?v=20261008',
  'js/country-dock.js?v=20261008',
  'js/country-dock.js?v=20261009-3d-globe',
  'js/country-dock.js?v=20261010-hillshade-globe',
  'js/map-app.js?v=20261009-3d-globe',
  'js/map-app.js?v=20261009-lidar-globe-twin',
  'js/map-app.js?v=20261010-lidar-zoom-gate',
  'js/offline-maps.js?v=20261009-3d-globe',
  'js/translations.js?v=20261009-3d-globe',
  'js/translations.js?v=20261010-lidar-zoom-gate',
  'js/d3.min.js?v=7.9.0',
  'js/topojson-client.min.js?v=3.1.0',
  'data/countries-50m.json?v=20261008',
  'js/shapefile.js?v=0.6.6',
  'js/map-app.js?v=20260927-sat-copernicus-vhr',
  'js/map-app.js?v=20261002-european-lidar',
  'js/map-app.js?v=20261005-ahn6-dsm',
  'js/vertical-opacity-control.js?v=20260927-sat-copernicus-vhr',
  // v148–v149: fiecare oglindă își păstrează propriile acțiuni rapide,
  // inclusiv Josephine Map + când un alt substrat istoric premium primește
  // focusul; v149 elimină dependența de aliasul temporar al sliderului activ.
  'js/vertical-opacity-control.js?v=20261001-persistent-layer-actions',
  'js/vertical-opacity-control.js?v=20261002-persistent-layer-actions-v2',
  'js/supabase.js?v=20260811-event-sync'
];

// ── Domains that normally bypass the app-shell strategy ──
//     Tile servers, APIs, and large data sources must not be cached by the
//     network-first shell path. Explicitly downloaded raster tiles are the
//     one exception and are looked up in OFFLINE_TILE_CACHE_NAME below.
const PASSTHROUGH_HOSTS = [
  'supabase',           // auth / database
  'workers.dev',        // APM tiles + feedback worker
  'railway.app',        // detection backend
  'r2.dev',             // Josephine / historical tiles + ONNX model
  'geo-spatial.org',    // heritage WMS + eharta
  'geo-spatial.ro',     // heritage WMS (eism)
  'arcgisonline.com',   // Esri satellite tiles
  'arcgisonline.nl',    // AHN6 DSM ImageServer
  'tiles.arcgis.com',   // LAKI III / MDH historical map tiles
  'raw.githubusercontent.com', // heritage images + geo-data JSON
  'githubusercontent.com',     // catch-all for GitHub CDN
  'overpass-api.de',    // OSM Overpass queries
  'cdn.jsdelivr.net',   // ONNX runtime CDN
  'ran.cimec.ro',       // Romanian cultural data
  'wikipedia.org',      // Wikipedia API
  'openstreetmap.org',  // OSM tiles / API
  'hrvpp2.vgt.vito.be', // CLMS HR-VPP vegetation WMTS (Amprenta Vegetației)
  'discomap.eea.europa.eu', // EEA Copernicus VHR 2012/2018/2021 basemap WMS
  'copernicus.discomap.eea.europa.eu',
  'image.discomap.eea.europa.eu',
  'pastmaps.cenagis.edu.pl', // CENAGIS / IH PAN Historical Maps GeoServer WMS
  'atlas.ihpan.edu.pl', // IH PAN PastMaps portal
  'imperium.ahlfeldt.se', // Digital Atlas of the Roman Empire (DARE) API
  'cast.uark.edu', // CORONA Atlas of the Near East / GeoServer (CAST UARK)
  'geoserve.cast.uark.edu', // CORONA GeoWebCache WMS-C tile server
  'idee.es'         // IDEE/IGN tile services — "Mapa LiDAR" WMS (Spain LiDAR)
];

// ── Install event: pre-cache essential static files ──
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      console.log('[SW] Pre-caching static assets');
      return cache.addAll(PRECACHE_URLS).catch(function (err) {
        console.warn('[SW] Pre-cache partial failure:', err.message);
      });
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ── Activate event: clean old caches ──
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (cacheNames) {
      return Promise.all(
        cacheNames.map(function (name) {
          if (name !== CACHE_NAME && name !== OFFLINE_TILE_CACHE_NAME) {
            console.log('[SW] Removing old cache:', name);
            return caches.delete(name);
          }
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ── Offline tile cache ─────────────────────────────────────────
// Normal cross-origin requests continue to bypass the service worker. Only
// URLs that look like raster map tiles are checked against the user-managed
// cache; this keeps the existing PWA fast while making downloaded areas work
// without a connection.
function isOfflineTileRequest(url) {
  var path = url.pathname || '';
  var query = (url.search || '').toLowerCase();
  // Anything carrying the offline-module tag was queued by js/offline-maps.js
  // (raster XYZ tiles, WMS GetMap images and cached GeoJSON documents alike).
  if (query.indexOf('__dl_offline_map=') !== -1) return true;
  if (query.indexOf('request=getmap') !== -1) return true;
  if (path.indexOf('/tile/') !== -1 || path.indexOf('/APM_TILES/') !== -1 || path.indexOf('/UAT/') !== -1) return true;
  return /\/\d+\/\d+\/\d+\.(png|jpg|jpeg)(?:$|\?)/i.test(path + url.search);
}

function cacheOfflineTileFromMessage(url) {
  return caches.open(OFFLINE_TILE_CACHE_NAME).then(function (cache) {
    return fetch(new Request(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })).then(function (response) {
      return cache.put(url, response.clone()).then(function () { return true; });
    });
  });
}

// ── Fetch event: network-first with cache fallback ──
self.addEventListener('fetch', function (event) {
  var request = event.request;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // ── Keep the app-shell strategy same-origin only ──
  //     Cross-origin tile / API requests either use the dedicated offline
  //     lookup below or go straight to the network; they never enter the
  //     shell's network-first clone-and-cache pipeline.
  var requestURL;
  try {
    requestURL = new URL(request.url);
  } catch (e) {
    // Malformed URL — let the browser handle it
    return;
  }

  // ── Cross-origin tile lookup ──
  // Cache.match is cheap for normal requests and only returns a response when
  // the user previously downloaded this exact tile URL. If it is not cached,
  // the original network request proceeds unchanged.
  if (requestURL.origin !== location.origin) {
    if (!isOfflineTileRequest(requestURL)) return;
    event.respondWith(
      caches.open(OFFLINE_TILE_CACHE_NAME).then(function (cache) {
        return cache.match(request).then(function (cached) {
          return cached || fetch(request);
        });
      }).catch(function () { return fetch(request); })
    );
    return;
  }

  // ── Same-origin path-based exclusions ──
  //     (These catch any same-origin proxy paths that serve tiles or API data)
  if (requestURL.pathname.includes('/map/') ||
      requestURL.pathname.includes('/tile/')) {
    return;
  }

  // ── Strategy: Network-first for same-origin requests ──
  event.respondWith(
    fetch(request)
      .then(function (response) {
        // Cache successful same-origin responses
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, clone);
          });
        }
        return response;
      })
      .catch(function () {
        // Offline — serve from cache if available
        return caches.match(request).then(function (cached) {
          if (cached) return cached;
          // For navigation requests, return the cached index.html
          if (request.mode === 'navigate') {
            return caches.match('index.html');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});

// ─────────────────────────────────────────────────────────────
// BACKGROUND DETECTION + PERSISTENT NOTIFICATION + USER TOGGLE
// ─────────────────────────────────────────────────────────────

// Load detection state from IndexedDB on startup
async function loadDetectionState() {
    try {
        const cache = await caches.open(CACHE_NAME);
        const stored = await cache.match('detection-state');
        if (stored) {
            const state = await stored.json();
            detectionEnabled = !!state.detectionEnabled;
            backgroundDetectionEnabled = state.backgroundDetectionEnabled !== false;
            console.log('[SW] Restored detection state:', { detectionEnabled, backgroundDetectionEnabled });
        }
    } catch (e) {
        console.warn('[SW] Could not load detection state');
    }
}

// Save detection state
async function saveDetectionState() {
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put('detection-state', new Response(JSON.stringify({
            detectionEnabled,
            backgroundDetectionEnabled
        })));
    } catch (e) {}
}

// Message handler from the main app
self.addEventListener('message', async (event) => {
    if (!event.data) return;

    if (event.data.type === 'CACHE_OFFLINE_TILE' && event.data.url) {
        try {
            await cacheOfflineTileFromMessage(event.data.url);
            if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
        } catch (error) {
            if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: false, error: String(error && error.message || error) });
        }
        return;
    }

    if (event.data.type === 'SET_DETECTION') {
        detectionEnabled = !!event.data.enabled;
        await saveDetectionState();
        
        if (detectionEnabled && backgroundDetectionEnabled) {
            await registerPeriodicSync();
            await showPersistentDetectionNotification();
        } else {
            await hidePersistentDetectionNotification();
        }
        
        console.log('[SW] Detection toggled:', detectionEnabled);
    }

    if (event.data.type === 'SET_BACKGROUND_DETECTION') {
        backgroundDetectionEnabled = !!event.data.enabled;
        await saveDetectionState();
        
        if (!backgroundDetectionEnabled) {
            await hidePersistentDetectionNotification();
        } else if (detectionEnabled) {
            await showPersistentDetectionNotification();
        }
    }

    if (event.data.type === 'GET_DETECTION_STATUS') {
        event.ports[0].postMessage({
            detectionEnabled,
            backgroundDetectionEnabled
        });
    }
});

// Register periodic background sync
async function registerPeriodicSync() {
    if ('periodicSync' in self.registration) {
        try {
            await self.registration.periodicSync.register('detect-protected-areas', {
                minInterval: 15 * 60 * 1000 // 15 minutes
            });
            console.log('[SW] Periodic sync registered');
        } catch (err) {
            console.warn('[SW] Periodic sync registration failed:', err);
        }
    }
}

// ── PERSISTENT NOTIFICATION (background running indicator) ──
const PERSISTENT_NOTIFICATION_TAG = 'detectlab-background-detection';

async function showPersistentDetectionNotification() {
    if (!backgroundDetectionEnabled || !detectionEnabled) return;

    try {
        await self.registration.showNotification('DetectLab — Detection Active', {
            body: 'Background detection is running. You will be notified when entering protected areas.',
            icon: 'images/pwa-icon-192.png',
            badge: 'images/pwa-icon-192.png',
            tag: PERSISTENT_NOTIFICATION_TAG,
            silent: true,
            requireInteraction: false,
            data: { type: 'persistent-detection' }
        });
        console.log('[SW] Persistent detection notification shown');
    } catch (err) {
        console.warn('[SW] Could not show persistent notification:', err);
    }
}

async function hidePersistentDetectionNotification() {
    const notifications = await self.registration.getNotifications({ tag: PERSISTENT_NOTIFICATION_TAG });
    notifications.forEach(n => n.close());
}

// ── PERIODIC SYNC HANDLER ──
self.addEventListener('periodicsync', async (event) => {
    if (event.tag === 'detect-protected-areas') {
        if (!detectionEnabled || !backgroundDetectionEnabled) return;
        console.log('[SW] Running background protected-area check');
        await performBackgroundCheck();
    }
});

// Core background check logic
async function performBackgroundCheck() {
    if (!detectionEnabled || !backgroundDetectionEnabled) return;

    try {
        // Get current position
        const position = await new Promise((resolve, reject) => {
            // We can't use geolocation directly in SW in all browsers.
            // Use the last known position sent from the main thread if available.
            if (lastKnownPosition) {
                resolve({ coords: lastKnownPosition });
            } else {
                reject(new Error('No position available'));
            }
        });

        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;

        const sites = await getProtectedSites();
        const RADIUS = 600; // meters

        let enteredSite = null;
        for (const site of sites) {
            const dist = getDistanceMeters(userLat, userLng, site.lat, site.lng);
            if (dist <= RADIUS) {
                enteredSite = site;
                break;
            }
        }

        if (enteredSite) {
            await showProtectedAreaAlert(enteredSite);
        }
    } catch (err) {
        console.warn('[SW] Background check error:', err.message);
    }
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getProtectedSites() {
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(PROTECTED_SITES_CACHE_KEY);
    
    if (!response) {
        try {
            const fresh = await fetch(PROTECTED_SITES_URL);
            if (fresh.ok) {
                const data = await fresh.json();
                await cache.put(PROTECTED_SITES_CACHE_KEY, new Response(JSON.stringify(data)));
                return data;
            }
        } catch (e) {}
        return [];
    }
    
    return response.json();
}

async function showProtectedAreaAlert(site) {
    const title = '⚠️ ALERTĂ — Zonă protejată';
    const body = `Ați intrat în raza de protecție a sitului: ${site.name || 'Sit arheologic'}\nActivitate interzisă prin lege.`;

    await self.registration.showNotification(title, {
        body: body,
        icon: 'images/pwa-icon-192.png',
        badge: 'images/pwa-icon-192.png',
        tag: 'protected-area-alert',
        requireInteraction: true,
        vibrate: [200, 100, 200],
        data: { siteId: site.id, lat: site.lat, lng: site.lng, type: 'alert' }
    });
}

// On activate, restore state and show persistent notification if needed
self.addEventListener('activate', async () => {
    await loadDetectionState();
    if (detectionEnabled && backgroundDetectionEnabled) {
        await showPersistentDetectionNotification();
    }
});

// Initial load
loadDetectionState();
