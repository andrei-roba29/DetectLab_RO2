# United Kingdom · Heritage — a free group of seven registers

## What changed

The UK heritage layer was one block in the layers window: a heading with an ⓘ
and seven rows that were just a checkbox and a status line. It was also listed
in **both** tabs — Free and Premium.

It is now an ordinary **free country group**, in the same shape as Romania's
sublayers, the Danish sections, the Albanian section headers and the Finnish
group:

```
┌ United Kingdom · Heritage            ⓘ      ▾      [pill on/off] ┐   ← group row
│ Opacity                                              ──  80%     │
│ ───────────────────●────────────────────────────────────────── │
│   ┌ ● National Heritage List for England  Historic England  [pill] ┐
│   │ Opacity                                        ⓘ   80%        │
│   │ ─────────────────●────────────────────────────────────────── │
│   │ 1 284 features                                                 │
│   └──────────────────────────────────────────────────────────────┘
│   … six more registers, each with its own switch / slider / ⓘ …
└──────────────────────────────────────────────────────────────────┘
```

* **Free only.** The group is a `.transp-layer-row` with
  `data-category="free"`, and so is every row the module builds. The
  Free/Premium tabs gate `.transp-layer-row[data-category]`
  (`js/map-app.js` `switchLayerTab()` keeps an `.active` marker on every
  `[data-category]` node); `css/styles.css` extends exactly that gate to the
  nested register rows (`.uk-heritage-sublayer[data-category]`). The registers
  therefore appear in **one** tab — Free.
* **One row per source**, each with its own on/off switch
  (`.apm-toggle-switch`), its own opacity slider (`.transp-slider`), its own
  percentage badge (`.pct`), its own status line and **its own ⓘ** (licence,
  coverage, zoom limit, live record count). Leaving RCAHMW off does not stop
  the NHLE from drawing.
* **A group header like every other group**: title (translated through
  `js/translations.js`, key `layer_uk_heritage`), group ⓘ, expand chevron,
  master on/off switch (turns all seven on/off, indeterminate when mixed) and
  a group opacity slider that applies to every register (each row can then be
  fine-tuned).
* **United Kingdom only.** `detectlab:country-selected` shows the group for
  `GB` / `GBR` / `UK` and hides it (and its rows) for every other country; the
  switches keep their state and the layers come back when the UK view returns.

## Why it used to appear in both tabs

The block was a bare `.country-section-list`:

```html
<div id="ukHeritageRow" class="country-section-list" data-category="free">
    <div id="ukHeritageSubLayers"> …rows with no data-category… </div>
</div>
```

`.country-section-list` is `display:contents !important` (it exists so country
catalogues do not add a box of their own), and the tab gate for that family is
`.country-section-list[data-category]:not(.active)`. Everything depended on
that one container rule and on children that carried **no** category of their
own: there was no per-row `data-category`, no per-row slider and no per-row ⓘ,
so any time the container rule did not bite — a stale stylesheet from the PWA
shell cache, a rebuild of the panel, a tab clicked before the marker was
applied — the same registers showed up as free layers *and* as premium ones.

The registers no longer rely on that container at all: the group row and the
seven register rows are `data-category="free"` nodes gated by the same CSS the
rest of the free catalogue uses, and the module re-applies the current tab
after every rebuild (language change). `css/styles.css` also carries an
ID-strength country gate (`#transpPanel #ukHeritageRow.country-layer-unavailable`)
so no tab rule can resurrect a hidden group.

## The sources

| id | register | provider | colour | min zoom |
| --- | --- | --- | --- | --- |
| `nhle` | National Heritage List for England | Historic England | `#d9a441` | 8 |
| `rcahmw` | National Monuments Records of Wales | RCAHMW | `#65b5e8` | 13 |
| `heneb` | Historic Environment Record of Wales | Heneb | `#9b82d1` | 13 |
| `listed` | Listed buildings | Cadw | `#e7bd55` | 12 |
| `scheduled` | Scheduled monuments | Cadw | `#e46d5f` | 9 |
| `wrecks` | Designated wrecks | Cadw | `#39aeb3` | 8 |
| `parks` | Registered historical parks & gardens | Cadw | `#73b86b` | 9 |

Every register is an ArcGIS FeatureServer queried for the **visible map area
only** (`esriGeometryEnvelope` + `esriSpatialRelIntersects`, max 8 000 records),
re-queried on `moveend`/`zoomend` with a 180 ms debounce, aborted when the row
is switched off, and silent below its own minimum zoom (“Zoom to 12+” in the
row's status line). The NHLE is published as a FeatureServer **root**, so its
public sublayers are discovered once (`?f=json`) before querying: an upstream
reshuffle cannot silently drop records.

## Files

* `js/uk-heritage-layers.js` — the whole feature: the seven source
  descriptions (label ro/en, provider, attribution, `info` text, colour, zoom
  limit), the panel rows, the Leaflet `L.geoJSON` layers in their own pane
  (`ukHeritagePane`, z-index 621), the per-row sliders (they repaint the
  existing geometry — never a new request), the group switch, the chevron, the
  two levels of ⓘ, the GB gate and the language rebuild. Public API:
  `window.DetectLabUkHeritage` (`sources`, `setSource`, `setGroupOpacity`,
  `setSourceOpacity`, `toggleAll`, `setExpanded`, `groupInfo`, `sourceInfo`,
  `filterForCountry`) plus the inline handlers index.html uses
  (`toggleUkHeritageLayers`, `setUkHeritageOpacity`,
  `toggleUkHeritageSubLayers`, `showUkHeritageGroupInfo`).
* `index.html` — the group row markup (title, ⓘ, chevron, master switch, group
  opacity slider, `#ukHeritageSubLayers`) and the
  `'United Kingdom · Heritage': 'layer_uk_heritage'` entry in
  `LAYER_NAME_TO_KEY`, so the info overlay's title is translated too.
* `css/styles.css` — `.uk-heritage-*` (head, dot, provider, title truncation,
  status line, focus rings, 430 px wrapping) and the two gates: the
  `[data-category]` Free/Premium gate for the register rows and the
  `country-layer-unavailable` country gate.
* `js/translations.js` — `layer_uk_heritage` (ro / en / da) and
  `uk_heritage_group_info`.
* `js/vertical-opacity-control.js` — the group slider is a map-side mirror
  source (`ukHeritageOpacitySlider` → `ukHeritageToggle`), like the Roman group.
* `sw.js` — shell cache v293 and the live URLs (`css/styles.css`,
  `js/uk-heritage-layers.js`) in `PRECACHE_URLS`.
* `test-uk-heritage-free-sublayers.js` — 155 checks: the markup, the two CSS
  gates, the module run against a stub DOM + stub Leaflet (seven rows, one
  switch/slider/badge/ⓘ each, per-source attribution, independent switching,
  slider repaint without a request, zoom guard, GB gate, Free/Premium marker
  on every tab switch **and** after a language rebuild, cache-busting parity
  with `sw.js`).

## Manual QA

- `python3 -m http.server` at the repo root → open `/index.html`, open the
  layers window (`#transpTab`) → **Free**: the “United Kingdom · Heritage”
  group is there; **Premium**: it is not (and neither are its registers).
- Switch the master on → seven rows go on, seven viewport queries (one per
  register) and each row reports its own count. Switch one row off → only that
  service stops and only that layer leaves the map.
- Drag one row's slider → that register fades, no request is made. Drag the
  group slider → every register takes the same value.
- Open a row's ⓘ → that register's provider/licence/zoom/count. Open the
  group's ⓘ → all four providers.
- Select France → the whole group disappears; select United Kingdom → it
  returns with the same switches on.
- Below the register's minimum zoom (e.g. Wales at z8) the row says
  “Zoom to 12+” instead of querying.
- `node test-uk-heritage-free-sublayers.js`, then `node test-layer-panel-rows.js`,
  `node test-country-layer-filter.js`, `node test-vertical-opacity-control.js`,
  `node test-pwa-shell-refresh.js` after touching any of this.
