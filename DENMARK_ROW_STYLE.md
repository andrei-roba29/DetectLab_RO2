# Denmark layers — same row style as the other countries (2026-10-27)

Every free Denmark layer is now styled exactly like the other countries'
layers (Romania's free rows are the template), each with an on/off switch
and an opacity slider.

## The rows

`js/danish-layers.js` (`buildRow`) generates the shared row shape used by
the Romanian sublayers in `index.html`:

- glass `.dl-sublayer-row` box (LiDAR rows also `.lidar-country-row`),
- title on the left, pill on/off switch on the right
  (`.apm-toggle-switch` + checkbox + `.apm-toggle-track`, input directly
  before the track so the checked CSS applies),
- an “Opacity” line (`.transp-layer-label`) with the shared
  `.layer-info-btn` ⓘ button and the `.pct` percentage badge
  (`danishPct_<id>`),
- one `.transp-slider` opacity slider per layer (`danishOpacity_<id>`;
  LiDAR rows also carry `.lidar-country-opacity` like their neighbours),
- the per-row status line under the slider.

The switch ids (`danishToggle_<id>`), slider ids and stored preferences
are unchanged. The heritage WFS polygons have no tile opacity, so their
slider scales the vector stroke/fill opacity instead (`wfsStyle`).

## The groups

Only `CONFIG.panelGroups` (`js/danish-layers.config.js`) is rendered:

| group | where | layers |
|---|---|---|
| **LiDAR** | shared LiDAR accordion, after “Hillshade LiDAR derivate” | LiDAR hillshade 1.6 m (DHM historik) · LiDAR hillshade, exaggerated terrain (quickDHM) · LiDAR terrain hillshade (DHM) · LiDAR surface hillshade (DHM) |
| **Heritage** | Denmark mount | Protected nature types (NBL § 3) · Scheduled ancient monuments (areas) · Not protected ancient monuments · Protected ancient monuments |
| **Historical maps** | Denmark mount | Topographic map 1980-2001 · Topographic map 1953-1976 · Low measuring table leaves 1901-1971 · High measuring table leaves 1842-1899 · Prussian measuring table leaves 1877-1920 · Denmark · DTK25 topographic map (1:25,000) |
| **Ortophoto** | Denmark mount | 2008 · 2005 · 2002 · 1999 |

Heritage / Historical maps / Ortophoto are Romania-style sections: a
`.transp-layer-row` header (`danishGroup_<id>`) with the section title, no
icon at all, and a master on/off switch (`danishGroupToggle_<id>`,
indeterminate for partial states) over a bordered
`danish<Group>SubLayers` column. Sections start collapsed.

The header carries **no icon** (2026-11-15). It used to draw a `▾` glyph in
a small red button next to the switch; that button is gone and the title
itself is the disclosure: `danishGroupExpandBtn_<id>` is now a text-only
`.danish-group-disclosure` button wrapping the label, with
`aria-expanded` / `aria-controls` and the same click behaviour, so the row
reads as plain text (Patrimoniu · Hărți istorice · Ortophoto) and stays
keyboard-operable. `css/styles.css` gives it the pointer + hover lift
instead of the removed glyph.

## Row photo

Every row of the **Historical maps** section carries a photo of one of its
own sheets as its background, exactly like the Romanian historical
sublayers (`js/layer-panel-rows.js`):

- `js/danish-layers.js` (`buildRow`) tags those rows
  `data-preview-layer="danish.<id>"` — the `historical` `panelGroup` only,
  so the Heritage and Ortophoto sections stay plain glass;
- the URL is built from the shared catalogue entry, never from a copy:
  `…/api/geo/dk-dtk25` (or `?layer=<id>`) + a small WMS `GetMap`
  (168 × 96, `EPSG:3857`, the layer's own `LAYERS` value, a 9 km window
  whose aspect ratio matches the image), through the same server-side proxy
  the layer itself uses;
- `js/layer-panel-rows.js` gives each sheet an anchor town inside its own
  coverage — the country bbox centre is open water in the Kattegat — and
  paints `--row-preview` only once the tile really loaded. A missing
  credential / dead service leaves the plain glass row behind and is never
  retried.

## Removed

- **The “Base map” section.** No Danish layer is a radio base map any
  more: the historical sheets, the summer orthophotos and DTK25 are
  `group: 'overlay'` in the config, so switches combine freely and every
  slider blends its sheet over the basemap. DTK25 remains the one layer
  on by default. The former base rows — the GeoDanmark spring-orthophoto
  year dropdown (`orto_foraar_2016…2025`, `orto`) and the Danish OSM base
  (`osm`) — are no longer rendered and never restored from stored
  preferences (a layer without a switch could never be turned off).
  Their catalogue entries stay for the proxy allow-list, the shared
  registry and the 3D catalogue, and the API can still activate them
  (bases remain mutually exclusive on that path).
- **“Denmark · DHM hillshade (DHM/Terræn)”** — the separate WMTS row
  (`#lidarDkLidarRow`) was removed from the LiDAR accordion; its
  terrain/surface products are the WMS rows above.
  `js/dataforsyningen-dhm-layer.js` stays loaded for the 3D registry
  builder (`lidar.dk-dhm`) and the `/api/geo/dk-dhm` routes are untouched;
  the map-app `dkLidar` plumbing is dormant (all its DOM lookups are
  null-safe).

## Verification

```sh
node test-danish-layers.js            # row shape, groups (icon-free headers), removal, proxy, registry
node test-layer-panel-rows.js         # the Danish historical rows resolve their own tile photo
node test-danish-wms-layers.js        # proxy allow-lists unchanged (14 token / 11 basic)
node test-denmark-dataforsyningen-dhm.js
node tools/sync-danish-config.mjs --check
```

`test-danish-layers.js` asserts for every rendered layer: checkbox (never
radio) inside an `.apm-toggle-switch` with the track as its next sibling,
a `.transp-slider`, a `.pct` badge, the glass row classes, a working
switch/slider round-trip for DTK25, the icon-free section header (title
disclosure + master switch, no glyph), which rows opt into the tile photo,
and that the removed rows/dropdown do not come back. As before, live provider
tiles still need the server-side credentials (see `DENMARK_LAYERS.md`);
nothing about endpoints, proxies or credentials changed.
