# LiDAR in 3D: the deck drew a different route than the disc it prepared

**Report (2026-10-20):** *“When used multiple times, the LiDAR in 3D still has
the same behaviour: after the loading of tiles finished it loads only the base
map in 3D, with no LiDAR — from what I have seen this happens mostly in the
PWA.”*

That is the fetch-finished handover symptom documented in
`MAP_3D_TERRAIN.md` §6.4 (“Sometimes the fetch finishes, 3D opens, and only the
base map is there”), still reproducible — and the previous fix (the prefetch
collecting the mirror first) could not reach it, because the prepared disc was
never asked for in the first place.

---

## 1. Two routes to the same layer, and only one of them has the disc

Every mirrored raster reaches the deck as a descriptor with **two** tile routes:

| route | who builds a tile | knows the prepared disc? | applies the disc clip? | proxy decision |
| --- | --- | --- | --- | --- |
| `dl2d://<deck key>/{z}/{x}/{y}` | the live 2D layer's own `getTileUrl()` / `createTile` | **yes** — `state.primed` / `state.primedOut` first | yes, `clipFocusedTile()` | the same `fetchTile()` the prefetch used (`preferProxy` for WMS, healed-host rule for the rest) |
| the registry template (`dl3d://…`, `?layer=…`, or the provider URL) | `js/layer-registry.js` | **no** — it has never heard of `state.primed` | no | its own `needsProxy()` decision |

`rasterTilesFor()` preferred the **registry** route whenever the item carried a
`defId`. That is a correct default for an ordinary overlay (the registry is the
single owner of the URL), but it is wrong for the one layer the user prepared a
disc for: `js/lidar-3d-focus.js` prepares that disc through `dl2d://` — the
live layer's own URL, the viewer's own CORS/proxy decision, then the disc clip —
so the deck was drawing a layer from a *different* source than the one that
holds the tiles.

The nine country products are exactly the layers with a `defId`
(`lidar.nl-ahn`, `no-hoydedata`, `pl-nmt`, `es-mdt`, `ch-swisstopo`, `uk-ea`,
`dk-dhm`, `se-lantmateriet`, `fr-mnh`). For them the mismatch had three shapes:

* `dl3d://<defId>` (the bbox builders) — has its own prepared-disc lookup, but
  only when `focus.defId` is spelled exactly as the registry id, and **not at
  all** once the source is built from the proxy template;
* `?layer=<defId>&z=…` — what `REGISTRY.rasterSource()` returns the moment
  `needsProxy()` is true. It *becomes* true during the prefetch: `fetchTile()`
  heals a host that failed with no CORS by setting `state.proxyHosts[host]`, and
  `rasterTilesFor()` passes `Object.keys(state.proxyHosts)` straight into the
  registry. So a host that needed the proxy to download its tiles (the very
  reason the prefetch worked) got a **live, per-tile proxy template** in 3D:
  every tile re-requested at render time, no disc, no prepared bytes, and on a
  slow or cold proxy an empty sheet over the base map;
* the provider URL (the tile builders: swisstopo, EA, Dataforsyningen,
  Lantmäteriet, the French WMS) — fetched directly by MapLibre with
  `crossOrigin`, regardless of what the prefetch had decided. A WMS host that
  only renders in 3D through the proxy therefore returned nothing at all.

The dialog happily counted those tiles as ready, because `isPrepared()` /
`preparedTile()` answer about `state.primedOut` — which the deck never read.
**“N tiles ready” and “the deck downloads N tiles again” were both true.**

## 2. Why it looked like a repeat-use / PWA bug

* The disc is applied *before* the download (`confirmDialog()`), so during the
  prefetch the browser is already holding the prepared bytes; the live rebuild
  only starts when 3D opens, i.e. **after the progress bar finished**.
* The proxy template arms itself only after the prefetch has healed a host —
  which happens on the first few tiles of the download, not on the first entry.
  A session that had already met the host (repeat use, installed PWA awake for
  days) had `state.proxyHosts` populated from the start.
* On a phone/PWA those live per-tile requests are the ones that lose to
  MapLibre's cancel-while-zooming and to the proxy's cold start, so the deck
  ended with the base map where the desktop's HTTP cache sometimes covered for
  it.

## 3. The fix: one focused layer, one route

**The focused LiDAR layer is always drawn through `dl2d://`**, def-backed or
not (`js/map3d-terrain.js` → `rasterTilesFor(item, focused)`):

```js
if ((!focused || item.render === 'none') && item.defId) { …registry… }
return [item.template];                       // 'dl2d://<deck key>/{z}/{x}/{y}'
```

That makes the route the deck draws **the same route the prefetch filled**, so:

* a prepared tile is answered from `state.primedOut` with no request, no
  re-blend and no re-clip (the invariant §6.4 already claimed);
* an unprepared tile (a rim tile the budget trimmed, a tile that failed) is
  fetched with `fetchTile()` — the same proxy/`preferProxy` decision the
  download made — and clipped to the disc;
* the source's `mode` becomes `live 2D layer`, so `watchSourceHealth()` no
  longer applies its 7 s “no direct tile → flip the host to the proxy” guess to
  a layer whose fetch policy is already settled per tile.

`render: 'none'` is the single descriptor with no per-tile route at all (no
`getTileUrl`, no `createTile`); it keeps the registry template so such a layer
is not blanked by the change.

### The smaller defects found on the same path

| where | what was wrong | now |
| --- | --- | --- |
| `renderRaster()` | `maxzoom` could be capped **below** the source's `minzoom` (a source MapLibre can only draw nothing for) | `maxzoom = max(minzoom, min(maxzoom, plan.zoomTo))` |
| `maskOf()` | the registry id was recognised as `lidar.fr-mnh` but not as `def:lidar.fr-mnh`, so a registry-drawn LiDAR layer was bounded to the disc but never clipped to it | both spellings (plus the deck and family keys) return the disc |
| `dl3d` handler | the prepared-disc fallback required `focus.defId === defId` | also accepts `focus.lidarKey === 'def:' + defId` |
| `focusMatches()` | a layer that lost its `_dlLidar` tag (a group member rebuilt by a country module) was dropped as “missing” | the item's own deck key (`item.key === focus.key`) also matches |
| `countPrepared()` | the canvas route asked the cache for `dl2d://<key>/{z}/{x}/{y}` **with the braces still in it**, so a prepared country disc always reported “0 prepared” | asks the per-tile deck URL the prefetch stored, so the count is honest |
| `map3dTiles()` | a `dynamic` definition whose browser module was not loaded fell back to `def.url` — the **service endpoint**, not a template — so MapLibre asked for that one un-substituted URL once per tile and failed every one of them under a silent blank | returns `[]`; the mirror falls back to the live layer's `dl2d://` route, the registry caller reports `unsupported: no tile template (module not loaded?)` |
| `syncLayers()` | a focus that never reached the deck left only an empty 3D view and no explanation | `status().errors` gets one line per distinct reason: `LiDAR focus “…” is not on the 3D deck (missing: …)` |

## 3b. The same rule in the whole-layer scope (2026-10-26)

The rule above is about **which route** a focused layer takes, not about the disc: a
layer chosen on the entry dialog is drawn through `dl2d://` so that the prefetch and the
render make the same CORS/proxy decision. Since the 2026-10-26 change the dialog can also
be answered with `scope: 'full'` — every chosen layer drawn entirely, no disc, no
prefetch (`MAP_3D_TERRAIN.md` §6.4.3). The route rule is unchanged there:

* `renderRaster()` still chooses `rasterTilesFor(item, focused)` **before** building the
  spec, so a whole-layer focus never falls back to a registry template;
* `maskOf()` returns null for `scope: 'full'` — nothing is clipped, and
  `focusExcludesTile()` therefore never blanks a tile;
* what a full-scope view *loses* is the prepared cache (`state.primed` is empty, by
  definition), so the `dl2d://` handler makes a live request per tile — the same
  `fetchTile()` path, the same `preferProxy`/healed-host decision, just not pre-warmed.

In other words: `scope: 'disc'` is “this route, pre-downloaded and clipped”;
`scope: 'full'` is “this route, on demand, uncut”. Neither one hands the layer to the
registry renderer behind the prefetch's back.

## 4. The PWA half: a resume redraws the deck

`js/map3d-terrain.js` had a context-loss watch but **no resume hook at all**. A phone
that backgrounds the installed PWA and comes back does not always get
`webglcontextrestored` — the canvas and the style survive, so nothing re-asks for the
tile requests the OS killed while the app was away. The deck then keeps whatever had
arrived (frequently the base map) while `state.status` still says `on`.

`watchResume()` (wired once, from `openNow()`) listens for `visibilitychange` and
`pageshow`, ignores the hidden phase, calls `map.resize()` — iOS reports the new viewport
a tick after `visibilitychange`, so MapLibre would otherwise keep rendering at the old
one — and `scheduleSync()`, which re-plans the deck and re-creates anything that went
missing. Nothing is fetched again that is still in `state.primed`; the prepared disc is
not re-downloaded by a resume.

## 5. Files

| file | change |
| --- | --- |
| `js/map3d-terrain.js` | `rasterTilesFor(item, focused)` — the focused layer keeps its `dl2d://` route; `renderRaster()` computes `focused` before the template and floors the cap at `minzoom`; `maskOf()`/`dl3d`/`focusMatches()` key-space fixes; the focus-not-drawn diagnostic (with `state.focusWarned`); `watchResume()` (`visibilitychange`/`pageshow` → `map.resize()` + `scheduleSync()`, added once) |
| `js/layer-registry.js` | `map3dTiles()` returns no template for a dynamic definition whose module is not loaded (instead of the service endpoint) |
| `js/lidar-3d-focus.js` | `countPrepared()` asks the per-tile deck URL on the canvas route |
| `index.html`, `sw.js` | `js/map3d-terrain.js` and `js/lidar-3d-focus.js` → `?v=20261020-lidar-disc-route`; shell cache `detectlab-v240-lidar-disc-route` |
| `test-lidar-3d-focus.js` | new §4d-quater: a def-backed (`_dlDefId` + `AhnLidar` module) focused layer must produce a source on `dl2d://2d.C9/{z}/{x}/{y}`, bounded to the disc and capped at the prepared plan — the assertion fails on the old code with `dl3d://lidar.nl-ahn/{z}/{x}/{y}` |
| `MAP_3D_TERRAIN.md` | §6.4 records the route rule |

## 6. Verify

```bash
node test-lidar-3d-focus.js     # the def-backed route, the disc, the whole-layer
                                # deck (no bounds/cap/clip), the handoff
node test-map3d-terrain.js      # deck order, proxy, blends, chrome
node test-map3d-mobile.js       # PWA budget + cache tags
node test-map3d-slider-layout.js
```

On a device, with a country LiDAR layer on (e.g. Netherlands AHN or UK EA):

1. press **3D**, pick a point, let the disc prepare;
2. when 3D opens the LiDAR must be there immediately — and stay there while the
   base map finishes loading;
3. `DetectLabMap3D.status().layers` shows that layer as `mode: 'live 2D layer'`,
   `focused: true`; `status().lidar.primed.hits` keeps climbing while
   `status().lidar.primed.bytes` does not (nothing new is downloaded);
4. pan away from the disc and back: the tiles inside it are still served from
   memory (no new requests in the Network tab), and the outline of the disc is
   the edge of the LiDAR.

A focus that cannot be drawn now says so in `DetectLabMap3D.status().errors`
instead of leaving a silent base map.
