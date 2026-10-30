# Archeological Report — "Raport arheologic"

Premium layer. Pick a point on the map, press **Run / Rulează**: the layer
analyses the selected **1–10 km circular radius** around that point, returns
**up to 3 ranked locations** as blue focus polygons and produces a **downloadable PDF** that explains each one.

Three sources feed a single weighted score:

| Source | What it contributes |
| --- | --- |
| **APM 2.0** | The raster score under the point (colour → legend score) |
| **Zone cu potențial arheologic** | Proximity to a triangulation bubble |
| **LIDAR Scanner** | Proximity to an annotated object; an annotated point is returned automatically |\n| **Roman roads** | Optional bonus: proximity to a mapped Roman road can raise the score; absence never lowers it |


## Evidence alignment and LIDAR exclusion (2026-09-18)

* Report potential evidence now comes from `computeArcheoPotentialField()` at
  the **report centre and selected radius**, not the legacy sparse triangulation
  API at a fixed 10 km. It uses `field.bubbles` (including `sparse_sites` runs),
  with their actual `radiusM`, both for membership and PDF figures. To compare
  the report to the potential layer, use the same centre and radius. The report
  still applies its own stricter UAT clearance and APM filters.
* The report reads `getEligiblePoints()`: the scanner's own heritage-filtered
  annotations, even when the scanner layer is off. Being nearby is not being
  annotated: nearby grid points no longer receive the annotation bonus or APM
  exception. The scanner and report share the scanner result-ring radius.
* **Ignore LIDAR Scanner results / Ignoră rezultate LIDAR Scanner** defaults off.
  Changing it with a selected report point regenerates the report. When on,
  candidates inside scanner result rings (100 m) are rejected **before** top-three
  selection; no LIDAR seeds, weights, bonuses or APM waivers are used. The next
  eligible candidates replace them. If annotations cannot be loaded, exclusion
  mode aborts rather than falsely claiming to exclude them.
* PDF source notes and rejection statistics record exclusion mode. Its LIDAR
  figure is omitted. The panel's exclusions hint now lives in the localized
  **Info** popup below `© DetectLab 2026 · APM 2.0 + RAN CIMEC + LIDAR`.

## Files

| Path | Role |
| --- | --- |
| `js/archeo-report.js` | The layer: seed generation, filters, scoring, map rendering, PDF orchestration |
| `js/archeo-report-pdf.js` | Page layout — paints every page on a canvas, hands JPEGs to the writer |
| `js/pdf-writer.js` | Dependency-free PDF 1.4 writer (`window.DetectLabPdf`) |
| `js/archeo-potential.js` | Unchanged logic, exposes `computeArcheoPotentialField()` headlessly |
| `js/lidar-scanner.js` | Adds `window._lidarScannerApi` (`getPoints`, `getEligiblePoints`, `ensureLoaded`) |
| `css/styles.css` | `.arch-report-*` (row, buttons, popup, pin, labels) |
| `js/translations.js` | `arch_report_*` + `arch_period_*` keys, EN and RO |
| `test-archeo-report.js` | Node harness — `node test-archeo-report.js` |

No PDF library is downloaded: jsPDF / html2canvas are not available offline, so
`pdf-writer.js` emits the PDF byte stream itself and every page is a JPEG
painted on a canvas. That also solves the diacritics problem — the standard PDF
fonts are WinAnsiEncoding, so **ă/ș/ț would render as garbage**; on a canvas
Cinzel/Outfit draw them correctly. `pdf-writer.js` still transliterates the
document *metadata* (`/Title`, `/Author`) with `winAnsiSafe()`.

## Workflow

1. Switch the layer on → map clicks pick the analysis centre (orange pin).
2. **Run** (disabled until a point exists) → status steps: sites → potential →
   LIDAR → UAT → APM → scoring.
3. **Up to 3 focus polygons** with permanent `Rezultat n/3 · %` labels
   appear and **stay until the layer is switched off** (or "show results" is
   unticked). The polygon *and* its label are clickable → score popup.
4. Pick the **PDF language** with the RO / EN selector next to the download
   button (defaults to the site language, remembered per session), then
   **Download PDF** → captures the 3 figures, builds the report and downloads
   it. The *whole* document — pages, tables, figure titles and result labels —
   comes out in the chosen language.

The layer keeps its state: switching languages or re-running does not clear the
results unless the user turns the layer off.

## Mandatory filters (a seed must pass all of them)

Seeds = adaptive systematic grid inside the search circle **+ every eligible
LIDAR annotation + every visible potential bubble centre inside it**.

1. **UAT** — the candidate must sit on the **red** part of the UAT raster
   (opaque and dark = open land) **and** be **≥ 500 m** from any non-red
   (built-up) pixel. `window._uatGetTile()` is reused from `map-app.js`.
2. **Known sites** — ≥ `RADIUS_M + BUFFER_M` (600 + 100 m) from every site
   reference point. For **polygon** sites the perimeter is sampled every
   `POLYGON_GUARD_STEP_M` (400 m) plus the centroid, exactly like
   `archeo-potential.js` does, so an elongated site cannot be "passed through"
   by measuring its centroid alone.
3. **APM 2.0** — the nearest legend colour under the point must be
   **5 (blue), 4.5 (green) or 4 (yellow)**. Khaki/olive (3), magenta (2) and
   red (1) are below average → rejected. The classifier is an independent
   nearest-neighbour match against the 6 legend colours (map-app's private
   `_classifyPixel` was *not* reused: its yellow rule accepts pure olive
   `#808000`, the colour the spec forbids, while rejecting the real reference
   yellow `[240,240,140]`).
4. **Exception** — a point **annotated in LIDAR Scanner** (at the annotation
   coordinates, with a 1 m numerical tolerance) bypasses filter 3 and is returned automatically; its APM component
   becomes `APM_UNKNOWN` (0.30) and it receives `LIDAR_ANNOTATION_BONUS`.

## Scoring

```
score = 0.40 · APM  +  0.30 · Potential  +  0.30 · LIDAR   (+ 0.45 if annotated)
      + up to 0.12 if a Roman road is within 1.5 km   (bonus only; omitted otherwise)
```

* **APM** — class → 1.00 / 0.85 / 0.62 (5 / 4.5 / 4).
* **Potential** — inside a bubble: the bubble's own score; within
  `PROXIMITY_M` (1500 m): its score attenuated by centre distance; otherwise 0.
  No bubbles means no potential evidence (0), not an invented 25% baseline.
* **LIDAR** — `1 − d/600` for the nearest scanner object; `LIDAR_NO_DATA` 0.20
  when there is no coverage in the area, `LIDAR_FAR` 0.10 when nothing is near.

Classification: **high ≥ 0.75**, **medium ≥ 0.50**, else low. Results are
ordered annotated-first, then by score, and must be ≥ 350 m apart.

## The PDF

A4 pages, cover → method → per result (score page + sites & period page) →
figures → sources. It explains, per result:

* the **APM score derived from the colour**, justified in plain language
  ("relatively flat, close to water, supported by the geology") — the exact
  wording is chosen per class (`arch_report_apm_explain_*`);
* the **potential-zone bubble** it lies in or near, relative to the other sites;
* the **LIDAR Scanner title** when one exists;
* an **approximate period** inferred from the 3 nearest sites, with their
  **raw dating text always printed** (name-derived dating is marked †) and
  **links to RAN / CIMEC** (`https://ran.cimec.ro/sel.asp?codran=…`, falling
  back to a description query) as the evidence;
* the 5 nearest sites with distances, and the rejection statistics for the area.

Screenshots (canvas re-composited from tiles + vector overlays, since
`html2canvas` is unavailable):

* **APM 2.0 high-potential polygons (Search Help style)** — the figure does
  *not* re-fetch the APM tiles (the 30 % raster wash was invisible over the
  satellite image, and depended on CORS). It polygonizes the report's own
  classified grid (`ctx.apmGrid` — the same 12 m cells the score was computed
  from): the allowed classes (blue 5 / green 4.5 / yellow 4) are clustered
  per class with 8-connectivity, patches below `APM.FIGURE.MIN_CLUSTER_CELLS`
  (8 cells) are dropped, and each surviving cluster is outlined with the same
  Moore boundary trace the Search Help tool uses and filled with its legend
  colour at `APM.FIGURE.OPACITY` (0.45) over the satellite base. The figure
  can therefore never contradict the analysis — it *is* the analysis data;
* **LIDAR view** when scanner objects exist;
* **potential zones vs. the other sites** when at least one bubble falls in
  the area.

### Period estimation

The estimate is an inverse-distance vote over the 3 nearest known sites.
The production GeoJSON endpoints (`/api/layers/0`, `/5/`, `/6/`) were checked:
**none of the layers has a dating property** (layer 0 → `NUMESIT/CODSIT/
SIRUTA/COORD`, layer 5 → `Tip/Judet/Comuna/Eticheta`, layer 6 → `Nume/CodRAN/
Localitate/Judet/Observatii/Sursa`). The dating therefore lives in the site
**name** ("Așezarea hallstattiană…", "Castrul militar auxiliar…"), so
`siteInfo()` derives the period from a dating property when one exists,
otherwise from the name (`datingFromName` is flagged in the evidence list and
the sites table shows `†`). The matcher also understands RAN **century
notation** — `sec. II-III p.Chr.`, `secolul al IV-lea`, `sec. XII-XIII`,
`sec. II-I î.Chr.`, `mileniul I î.Chr.` — and maps each century (or range,
majority vote, ties resolved toward year 0) onto the period scale using the
Romanian archaeological conventions. Whatever happens, the evidence list
**always prints the raw dating text** from the database; "undetermined"
appears only when a record genuinely says nothing.

## Rendering

Panes `pane_arch_report_shapes` (z 672) and `pane_arch_report_tags` (z 674),
colour `#66c8ff`, drawn above the LIDAR scanner tags (665).

## Debugging

```js
_archeoReportDebug.config          // live CONFIG
window.runArcheoReport()           // returns the model
_archeoReportDebug.classifyApmPixel(r, g, b)
_archeoReportDebug.uatVerdict(grid, x, y, 500)
_archeoReportDebug.apmGridPolygons(grid)   // figure polygons from the classified grid
_archeoReportDebug.parseCenturyRange('sec. II-III p.Chr.')
_archeoReportDebug.periodKey('sec. II-III p.Chr.')   // → 'roman'
_archeoReportSetPdfLang('ro')      // or 'en' — PDF language override
_archeoReportPdfLang()             // → the effective PDF language
window._lidarScannerApi.getPoints()
```

`node test-archeo-report.js` runs the real `archeo-report.js`,
`archeo-report-pdf.js`, `pdf-writer.js` and `archeo-potential.js` inside a vm
sandbox with a working canvas/Image stub: APM colour classification, every
exclusion rule, the weighted score, selection, the century/name period
matcher, the APM figure polygonization, the PDF byte structure (xref offsets,
DCTDecode streams), the PDF language selection, the Leaflet layers that end
up on the map, and the RO/EN translation completeness.

283 checks. **Not covered by the harness** (needs a browser): real tile
fetching — the R2 APM bucket and the Esri satellite basemap must answer
`Access-Control-Allow-Origin` for `getImageData()` to work.

## When a source is unavailable

Everything fails **closed** — the layer never guesses:

| Failure | Effect |
| --- | --- |
| APM tile unreadable (CORS/404) | `apmUnreadable: true`, `apmAvailable: false` → every seed is rejected, 0 results, the PDF button stays hidden and the status line says why. The PDF's APM figure then has no polygons and the caption says the APM source was not drawn |
| UAT tile unreadable | the pixel counts as **not red** → rejected (`uat_not_red`) |
| Heritage API down | after one 20 s cap: `sitesCount: 0`, `potentialStatus: 'no_sites'` |
| LIDAR CSV down | `ensureLoaded()` rejects and is swallowed → `lidarCount: 0`, no annotation bonus |

The APM figure itself needs no APM tiles: it draws the classified grid the
analysis produced, so it can never disagree with the score.

`computeArcheoPotentialField()` accepts `skipDataWait` so the report's own
`waitForSiteData()` is not waited on a second time (40 s → 20 s when the
heritage API is unreachable).

## Adding another layer — checklist

1. `js/<layer>.js` + a `test-<layer>.js` vm harness.
2. `index.html`: premium row with `data-i18n` keys + `<script>` tags (cache-bust `?v=`).
3. `js/translations.js`: every key in **both** `en` and `ro`.
4. `css/styles.css`: the layer's classes.
5. `sw.js`: add the versioned URLs to `PRECACHE_URLS` **and** bump `CACHE_NAME`.
6. Run `node test-<layer>.js` and the harnesses of the layers you touched.

## Focus areas and field transects

Each selected result is resampled on a 50 m grid using the report's existing
score and mandatory exclusions. Its connected main focus contains cells within
0.10 of the result's local score, capped at 200 m from its centre; the connected
secondary focus uses a 0.25 score drop and is capped by an 800 m-wide sampling
window. The main focus is always included in the secondary focus. For a LIDAR
annotation, thresholds use the best valid adjacent score rather than extending
its point-only annotation bonus across the surrounding area. If the data do not
support a wider area, the two areas can coincide.

The blue polygon, dotted white secondary boundary and translucent white
north–south transects (100 m apart, clipped to the secondary area) appear in
2D, 3D and report figures. Whole cells are screened against the sampled UAT raster, heritage circles and
site polygons; scoring still samples their centres. Raster resolution and cell edges are approximate: the footprints are **not** measured site boundaries, calibrated
probabilities, permission to enter land, or a substitute for heritage checks.
The underlying report still uses APM 2.0; Next-Gen APM integration has not yet
been implemented.

Focus cells that touch the UAT raster exclusion, a protection radius, or a
site polygon are omitted altogether, including from the secondary survey area.
The report retains its stricter 500 m UAT clearance for result centres. If
heritage data is missing or any heritage API layer fails, the report displays
no results; UAT raster failures are also treated as excluded. The raster is a
sampled representation and cannot guarantee that every small feature is visible.
