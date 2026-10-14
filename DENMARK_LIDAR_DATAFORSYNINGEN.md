# Denmark · Danmarks Højdemodel hillshade — Dataforsyningen **WMTS**

Live hillshade ("skyggekort") of the Danish national LiDAR elevation model,
streamed tile-by-tile from Dataforsyningen as the user pans and zooms.
Nothing is downloaded or pre-generated.

| | |
|---|---|
| Service | `https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF` (terræn)<br>`https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF` (overflade) |
| Protocol | WMTS 1.0.0, KVP `GetTile` |
| Layer | `dhm_terraen_skyggekort` / `dhm_overflade_skyggekort` |
| Style | `default` |
| TileMatrixSet | `View1` — **EPSG:25832 (ETRS89 / UTM 32N)**, *not* Web Mercator |
| Format | `image/jpeg` (the only one published — **no transparency**) |
| Owner / licence | Klimadatastyrelsen (ex-SDFI) · free geographic data, **CC BY 4.0** |
| Attribution | *Indeholder data fra Klimadatastyrelsen, Danmarks Højdemodel* |
| Code | `js/dataforsyningen-dhm-layer.js` · proxy `backend/src/routes/geoProxy.js` + `netlify/functions/dk-dhm.mjs` |
| Tests | `node test-denmark-dataforsyningen-dhm.js` |
| Demo | `tools/denmark-lidar-demo.html` |

---

## 1. Verification report

Everything in this section was checked against the live service on
**2026-10-07**. `GetCapabilities` needs no token, so all of it is
reproducible by anyone. §1.6 lists what could **not** be verified here and
why.

### 1.1 GetCapabilities — layer, styles, formats, tile matrix sets

`GET https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF?service=WMTS&request=GetCapabilities&version=1.0.0`
→ **200**, no token required.

```
ows:Identifier          dhm_terraen_skyggekort
ows:WGS84BoundingBox    2.478420 53.015000 → 17.557800 58.640300
Style                   default
Format                  image/jpeg                 ← the ONLY format
TileMatrixSetLink       View1                      ← the ONLY tile matrix set
OperationsMetadata      GetCapabilities: KVP,  GetTile: KVP   (no RESTful template)
```

`dhm_overflade_skyggekort_DAF` returns the **identical** document apart from
the layer identifier, so the terrain/surface switch in the UI reuses every
number below.

**The `View1` tile matrix set, in full:**

```
ows:Identifier     View1
ows:BoundingBox    120000.000000 5900000.000000 → 1000000.000000 6500000.000000
SupportedCRS       urn:ogc:def:crs:EPSG:6.3:25832        (ETRS89 / UTM zone 32N)
TopLeftCorner      120000.000000 6500000.000000          (same at every level)
TileWidth/Height   256 × 256
levels             0 … 13
```

| TileMatrix | ScaleDenominator | m/px | MatrixWidth × MatrixHeight |
|---:|---:|---:|---:|
| 0  | 5 851 428.571 | 1638.4 | 3 × 2 |
| 1  | 2 925 714.286 | 819.2  | 5 × 3 |
| 2  | 1 462 857.143 | 409.6  | 9 × 6 |
| 3  | 731 428.571   | 204.8  | 17 × 12 |
| 4  | 365 714.286   | 102.4  | 34 × 23 |
| 5  | 182 857.143   | 51.2   | 68 × 46 |
| 6  | 91 428.571    | 25.6   | 135 × 92 |
| 7  | 45 714.286    | 12.8   | 269 × 184 |
| 8  | 22 857.143    | 6.4    | 538 × 367 |
| 9  | 11 428.571    | 3.2    | 1075 × 733 |
| 10 | 5 714.286     | 1.6    | 2149 × 1465 |
| 11 | 2 857.143     | 0.8    | 4297 × 2930 |
| 12 | 1 428.571     | 0.4    | 8594 × 5860 |
| 13 | 714.286       | 0.2    | 17188 × 11719 |

Resolution = ScaleDenominator × 0.00028. The ladder is an exact
power-of-two: `res(level) = 1638.4 / 2^level`. Every MatrixWidth/Height also
reproduces exactly as `ceil(880000 / span) × ceil(600000 / span)`, which is
why `js/dataforsyningen-dhm-layer.js` derives them instead of hard-coding
them — and `test-denmark-dataforsyningen-dhm.js` §2 pins all 28 numbers
against the capabilities.

**Layer extent.** The layer's `WGS84BoundingBox` (2.48 E 53.0 N →
17.56 E 58.64 N) is the envelope of the *projection box*, not of the data —
it reaches into Germany, Sweden and the North Sea. The real coverage comes
from the WMS capabilities of the same products:
**7.99125 54.4265 → 15.5995 57.7781**. That is what `CONFIG.BOUNDS` uses, so
Leaflet never even creates a tile outside Denmark.

> ⚠️ One inconsistency worth knowing about. The `TileMatrixSet` element names
> its levels `0 … 13`, but the Layer's `TileMatrixSetLimits` refer to the same
> levels as `View1:0 … View1:13`. A bare integer is what
> `api.dataforsyningen.dk` actually wants — Dataforsyningen's own migration
> notes say *"Udskifte navne på TileMatrix – tidligere var der L0 foran numre
> f.eks. L07 – nu 7 (TileMatrix=7)"* — and both of the brief's example tiles
> use bare integers too. `CONFIG.TILEMATRIX_PREFIX` exists as a one-line
> escape hatch if that ever changes.

### 1.2 The two example tiles

Neither tile could be *fetched* here (no token exists in this environment —
see §1.6), so their location was derived from the grid instead, which is a
stronger check than eyeballing a JPEG anyway.

Tile → bbox: `span = 256 × res(level)`, `minX = 120000 + col·span`,
`maxY = 6500000 − row·span`. Then EPSG:25832 → WGS84.

**`TileMatrix=10&TileCol=1027&TileRow=620`** (res 1.6 m/px, span 409.6 m)

```
EPSG:25832   540659.2, 6245638.4 → 541068.8, 6246048.0
WGS84        9.65795, 56.35368   →   9.66464, 56.35732
centre       56.35550 N, 9.66130 E       →  central Jutland, near Hammershøj
index valid  yes (matrix at level 10 is 2149 × 1465)
```

**`TileMatrix=4&TileCol=15&TileRow=13`** (res 102.4 m/px, span 26 214.4 m)

```
EPSG:25832   513216, 6132998 → 539430, 6159213
WGS84        9.20838, 55.34316 → 9.62542, 55.57729
centre       55.46041 N, 9.41628 E       →  southern Jutland, Kolding / Vejle
index valid  yes (matrix at level 4 is 34 × 23)
```

✅ **Both land inside Denmark.** Pinned in `test-…-dhm.js` §4.

Both also demonstrate the trap in the brief: at level 10 an XYZ grid only has
columns 0–1023, so `TileCol=1027` could not be XYZ; and the XYZ tile for the
second location at z4 would be col 8 / row 5, not 15 / 13.

**How do we know the projection code is right?** Two independent checks, both
in the test suite:

1. `UTM.forward` / `UTM.inverse` round-trip to **< 2 µm** across Denmark.
2. Transforming the `View1` bounding box (`120000 5900000 → 1000000 6500000`)
   and taking the envelope reproduces the service's own published
   `WGS84BoundingBox` — `2.47842 53.015 → 17.5578 58.6403` — to **3 m**,
   which is just the rounding in the published figures. If the datum or zone
   were wrong this would be out by kilometres.

### 1.3 Is there an EPSG:3857 option? (brief question 3)

| Route | Web Mercator? | Verdict |
|---|---|---|
| **WMTS** `dhm_*_skyggekort_DAF` | ❌ `View1` is the only TileMatrixSet, and it is EPSG:25832 | no plain XYZ possible |
| **WMS** `dhm_DAF` | ✅ advertises `EPSG:3857` (and 4326, 4258, 25832/3, 32632/3, 3395, 4093–4096) | would work as a plain reprojecting WMS |
| other Dataforsyningen products | ✅ e.g. `orto_foraar_webm_DAF` publishes `DFD_GoogleMapsCompatible` | …but **not** for DHM skyggekort |

So a Web-Mercator path does exist, but **only through the WMS**, and the
brief asks for the WMTS. The next section explains how both are satisfied.

`dhm_DAF` WMS capabilities also confirm, for the record: formats
`image/png` + `image/jpeg`; hillshade layers carry
`MaxScaleDenominator 1e7`; contour layers `dhm_kurve_traditionel` (130 000),
`dhm_kurve_0_5_m` (16 000), `dhm_kurve_0_25_m` (11 000); and `TRANSPARENT`
must be spelled in **upper case** `TRUE`/`FALSE` or the service refuses.

### 1.4 How the token works (brief question 4)

| Question | Answer | Source |
|---|---|---|
| Where does it go? | Either the HTTP header `token: <value>` **or** the query parameter `?token=<value>` | Klimadatastyrelsen docs (*Log ind og Token*) |
| Which is recommended? | **The header** — the docs call it the most secure form, because it keeps the secret out of access logs, `Referer` headers and browser history | same |
| Shape | 32 hexadecimal characters | same |
| Created where? | dataforsyningen.dk → *Administrer token til webservice og API'er* → **OPRET NY TOKEN** | same |
| Expiry | None by default; an optional deletion date can be set | same |
| Stateless? | Yes — it must be sent on **every** request; HTTPS only | same |
| **Restrict to a domain or IP?** | **No such option is documented.** A token is account-wide. This is the single biggest reason to keep it server-side. | — |
| **Rate limit / quota?** | **Not published anywhere.** Treat it as "be polite" — see §6. | — |
| CORS | The gateway **echoes the caller's `Origin`** (`access-control-allow-origin: <origin>`, `vary: Origin`) rather than `*`, so `<img>`, `fetch()` and canvas reads all work. Moot through the proxy, which is same-origin. | — |

Note that DAWA and the INSPIRE OGC services are token-free; the DHM services
are not.

### 1.5 What a request without a token actually returns

```
GET …/dhm_terraen_skyggekort_DAF?service=WMTS&request=GetTile&…&TileMatrix=4&TileCol=15&TileRow=13

<ExceptionReport version="1.1.0" xmlns="http://www.opengis.net/ows/1.1">
  <Exception exceptionCode="NoApplicableCode">
    <ExceptionText>User not authorized</ExceptionText>
  </Exception>
</ExceptionReport>
```

The three messages are chosen by the probe ladder (`_probeAuthOnce`, tiles
2/4/2): a 401/403 **without** a client-supplied token, or the proxy's JSON
`{"error":"dataforsyningen_token_missing"}`, means *this deployment has no
token* → `TOKEN_MISSING_MESSAGE`; a 401/403 with a token, or a token
`ExceptionReport`, means *the token was rejected* → `AUTH_MESSAGE`; a 404
without a client token means the proxy route itself is missing →
`PROXY_MISSING_MESSAGE`. All three are reported through
`DetectLabWmsHealth.markUnavailable()` (see `CENAGIS_WMS_HEALTH.md`), so the
row is switched off with the reason attached instead of staying blank.

This matters for error handling: the service answers with an **XML body**,
not necessarily a bare `401`. Both proxies therefore sniff the body as well
as the status code and normalise the result to a real `401
dataforsyningen_token_invalid`, which is what the browser turns into the
"Invalid or missing Dataforsyningen token" notice.

### 1.6 What could **NOT** be verified here — and how you verify it

No Dataforsyningen token exists in this environment, and the sandbox cannot
read raw HTTP responses. So the following are **unverified claims** and are
covered by the manual checklist in §8 instead:

| Not verified | Why | How to confirm |
|---|---|---|
| A real tile returns **200** with `Content-Type: image/jpeg` | needs a token | §8 step 4 |
| The exact **CORS** response headers | needs a real tile fetch | §8 step 7 — though the layer never reads canvas pixels, so CORS is not required at all (see §4) |
| Rate limits / quota | nothing is published | watch for 429s in production |
| **Visual** alignment of the hillshade on a coastline | needs real imagery | §8 step 3 — `tools/denmark-lidar-demo.html` exists precisely for this |
| Whether the server also accepts `TileMatrix=View1:7` | the auth error fires before parameter validation | not needed; bare integers are documented and used |

The *geometry* of the alignment, by contrast, **is** verified — numerically,
in the test suite (§2, §3, §9). See §3 below.

---

## 2. The problem this layer solves

The map is Leaflet in EPSG:3857, shared with OpenStreetMap and eight other
national LiDAR layers. The WMTS only publishes EPSG:25832. Three ways out:

| Option | Aligns with OSM? | Cost |
|---|---|---|
| **Proj4Leaflet**, map CRS → EPSG:25832 | ❌ **No** — OSM and every other LiDAR layer would be wrong | would need a Danish basemap and a second map instance |
| **WMS `dhm_DAF` in EPSG:3857** | ✅ Yes, server-side | ❌ not the WMTS; every request rendered on demand, never a cache hit, maximum load on a public agency |
| **WMTS + client-side reprojection** ← **chosen** | ✅ Yes, to < 0.2 px | one canvas and ~64 `drawImage` calls per tile |

The third is what `js/dataforsyningen-dhm-layer.js` does. It is an
`L.GridLayer` that renders each destination tile into a `<canvas>`:

1. take the destination tile's EPSG:3857 bounds;
2. lay an **8 × 8 mesh** over it and convert every node to EPSG:25832;
3. pick the `View1` level whose resolution matches, work out which `View1`
   tiles the mesh covers, fetch them, mosaic them;
4. draw the mosaic into the destination canvas **one mesh cell at a time**
   through that cell's own affine transform — a piecewise-affine warp, the
   same technique OpenLayers uses for cross-projection raster sources.

**Trade-off, stated plainly.** The WMS would need no client maths but makes
the agency reproject and render every single request. The WMTS serves
pre-rendered tiles straight from its own cache, so this design moves the
cheap part (an affine warp, microseconds) into the browser and keeps the
expensive part off a public server. The price is ~250 lines of projection
and warp code, plus a canvas per tile.

---

## 3. Why the alignment is correct

Both projections are conformal, so over one 256 px tile the mapping between
them is very nearly affine — but not exactly, and the residual is what makes
a hillshade sit 10 px off a coastline. Measured against the exact projection
at Copenhagen, Skagen, Esbjerg and Bornholm for zooms 7 / 10 / 13 / 16
(worst case of all sixteen combinations):

| mesh | worst error |
|---:|---:|
| 1 (single affine per tile) | **10.6 px** — visibly wrong |
| 2 | 2.66 px |
| 4 | 0.67 px |
| **8 ← `CONFIG.WARP_MESH`** | **0.17 px** |
| 16 | 0.04 px |

8 is the sweet spot: invisible error, 64 cells. Cost grows with the square of
the mesh.

This is not just a claim in a document. `test-denmark-dataforsyningen-dhm.js`
§9 drives the **real `createTile()`** through a recording canvas for five
Danish locations, then takes known coordinates, computes independently
(a) where they belong in the destination tile and (b) where they are in the
fetched View1 mosaic, pushes (b) through the affine the warp actually
installed, and requires the answer to equal (a) **within 0.25 px**.

---

## 4. Transparency, CORS and canvas

* **JPEG has no alpha.** At opacity 1 the hillshade would completely hide the
  basemap. The default is therefore **0.6**, exposed as a slider. Everything
  the canvas does not cover stays transparent, so coastlines and the areas
  outside coverage show the basemap through.
* **No CORS is required.** The layer only ever calls `drawImage()`; it never
  calls `getImageData()` or `toDataURL()`. A tainted canvas is harmless when
  you only display it. `CONFIG.CROSS_ORIGIN` is therefore `null` by default.
  Set it to `'anonymous'` only if you add pixel reads — through the proxy
  that is same-origin and always works.
* If some other feature ever exports the map to an image (html2canvas and
  friends), run in **proxy mode**: same-origin tiles never taint anything.

---

## 5. The token: setup

### 5.1 Get one

1. Sign in at <https://dataforsyningen.dk/>.
2. *Administrer token til webservice og API'er* → **OPRET NY TOKEN**.
3. Copy the 32-character value. Optionally set a deletion date.

### 5.2 Default: the same-origin proxy (recommended)

The browser never sees the token. It asks **our** domain for tiles; the
server adds the token as a header and caches the answer for 7 days.

```
browser  →  GET /api/geo/dk-dhm?service=WMTS&request=GetTile&…      (no token)
server   →  GET https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF?…
            token: <DATAFORSYNINGEN_TOKEN>
```

**Express** — already wired, `backend/src/routes/geoProxy.js`, mounted at
`/api` by `backend/src/app.js`:

```bash
cp backend/.env.example backend/.env
# edit backend/.env:
#   DATAFORSYNINGEN_TOKEN=YOUR_TOKEN
cd backend && npm install && npm start
```

**Netlify** — already wired, `netlify/functions/dk-dhm.mjs` +
the `/api/geo/dk-dhm` redirect in `netlify.toml`. Set
`DATAFORSYNINGEN_TOKEN` under *Site settings → Environment variables*.
`netlify dev` picks it up locally.

**Cloudflare Worker** — route it at `/api/geo/dk-dhm`, set the secret with
`wrangler secret put DATAFORSYNINGEN_TOKEN`:

```js
const LAYERS = {
  dhm_terraen_skyggekort:   'https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF',
  dhm_overflade_skyggekort: 'https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF',
};

export default {
  async fetch(request, env, ctx) {
    const incoming = new URL(request.url).searchParams;
    const layer = incoming.get('layer');
    const upstreamBase = LAYERS[layer];
    if (!upstreamBase) return new Response('layer_not_allowed', { status: 400 });
    if ((incoming.get('request') || '').toLowerCase() !== 'gettile') {
      return new Response('unsupported_request', { status: 400 });
    }

    const upstream = new URL(upstreamBase);
    for (const [k, v] of incoming) {
      if (k.toLowerCase() === 'token') continue;          // never forward a client token
      upstream.searchParams.set(k, v);
    }

    const cache = caches.default;
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    let response = await cache.match(cacheKey);
    if (response) return response;

    const upstreamRes = await fetch(upstream.toString(), {
      headers: { token: env.DATAFORSYNINGEN_TOKEN },
    });
    const type = upstreamRes.headers.get('content-type') || '';
    if (!upstreamRes.ok || type.includes('xml')) {
      return new Response(JSON.stringify({ error: 'dataforsyningen_token_invalid' }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }

    response = new Response(upstreamRes.body, {
      headers: { 'content-type': type,
                 'cache-control': 'public, max-age=604800, immutable' },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
```

**PHP** — drop in as `api/geo/dk-dhm.php` (rewrite `/api/geo/dk-dhm` to it);
the token lives in an environment variable or an un-served `.env`:

```php
<?php
// /api/geo/dk-dhm.php  —  never put the token in this file; use the environment.
$LAYERS = [
  'dhm_terraen_skyggekort'   => 'https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF',
  'dhm_overflade_skyggekort' => 'https://api.dataforsyningen.dk/dhm_overflade_skyggekort_DAF',
];
$token = getenv('DATAFORSYNINGEN_TOKEN');
$layer = $_GET['layer'] ?? '';
if (!$token)                     { http_response_code(401); exit('{"error":"dataforsyningen_token_missing"}'); }
if (!isset($LAYERS[$layer]))     { http_response_code(400); exit('{"error":"layer_not_allowed"}'); }
if (strtolower($_GET['request'] ?? '') !== 'gettile') { http_response_code(400); exit('{"error":"unsupported_request"}'); }

$params = $_GET; unset($params['token']);               // never forward a client token
$url    = $LAYERS[$layer] . '?' . http_build_query($params);

$cacheFile = sys_get_temp_dir() . '/dkdhm_' . sha1($url) . '.jpg';
if (is_file($cacheFile) && filemtime($cacheFile) > time() - 604800) {
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=604800, immutable');
    readfile($cacheFile); exit;
}

$ch = curl_init($url);
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_HTTPHEADER => ['token: ' . $token]]);
$body = curl_exec($ch);
$type = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

if (strpos((string)$type, 'image/') !== 0) {            // the OGC exception is XML
    http_response_code(401); exit('{"error":"dataforsyningen_token_invalid"}');
}
file_put_contents($cacheFile, $body);
header('Content-Type: ' . $type);
header('Cache-Control: public, max-age=604800, immutable');
echo $body;
```

**Nginx** — no code at all, but note that `proxy_pass` can only add the token
as a *header*, which is exactly the recommended form:

```nginx
proxy_cache_path /var/cache/nginx/dkdhm levels=1:2 keys_zone=dkdhm:20m
                 max_size=5g inactive=30d use_temp_path=off;

location = /api/geo/dk-dhm {
    # The token lives only in this file, which is root-readable only.
    # include /etc/nginx/secrets/dataforsyningen.conf;   →  set $dk_token "...";
    proxy_set_header token $dk_token;
    proxy_set_header Host api.dataforsyningen.dk;

    proxy_cache            dkdhm;
    proxy_cache_key        $args;
    proxy_cache_valid      200 7d;
    proxy_cache_use_stale  error timeout updating;
    add_header             X-Proxy-Cache $upstream_cache_status;
    add_header             Cache-Control "public, max-age=604800, immutable";

    # Strip any token the client tried to send.
    if ($args ~ (.*)(^|&)token=[^&]*(.*)) { set $args $1$2$3; }

    proxy_pass https://api.dataforsyningen.dk/dhm_terraen_skyggekort_DAF$is_args$args;
}
```

> For the surface product add a second `location = /api/geo/dk-dhm-overflade`
> pointing at `dhm_overflade_skyggekort_DAF`, or use the Express/Netlify
> proxy, which routes on the `layer` parameter.

### 5.3 Fallback: client-only, **INSECURE**

If there is genuinely no backend:

```html
<!-- Anyone who opens DevTools can read this token. -->
<script>window.DETECTLAB_DK_TOKEN = 'YOUR_TOKEN';</script>
<script src="js/dataforsyningen-dhm-layer.js"></script>
```

The layer then talks to `api.dataforsyningen.dk` directly with `?token=…`.
How to limit the damage:

* Use a **dedicated, disposable** token used for nothing else, and set a
  **deletion date** when you create it.
* Rotate it on a schedule, and immediately if the site is scraped.
* Keep it out of the repository: inject it at deploy time (Netlify snippet
  injection, a CI template step), never commit the `<script>` line.
* Watch Dataforsyningen's usage page; delete and re-create at the first sign
  of someone else using it.
* Accept that it **will** be copied. There is no domain or IP restriction to
  fall back on (§1.4).

---

## 6. Being a good citizen on a public agency's server

No quota is published, so the layer is deliberately restrained:

* `KEEP_BUFFER: 1` — essentially no tiles kept outside the viewport.
* `updateWhenIdle: true`, `updateWhenZooming: false` — nothing is fetched
  mid-gesture; only the view the user settles on is requested.
* `CONFIG.BOUNDS` clips to Denmark, and every tile index is checked against
  the `View1` matrix, so **no out-of-coverage request is ever made**.
* `MAX_SOURCE_TILES: 12` — if a destination tile somehow needs more source
  tiles than that, the layer steps down a level instead of hammering away.
* An in-memory LRU of 96 decoded source tiles means neighbouring destination
  tiles and the zoom level you just left are reused, not re-requested.
* Both proxies cache for **7 days** (`max-age=604800, immutable`) and the
  Netlify one also pins on the CDN.

> **Production needs the caching proxy.** Without it every visitor's browser
> hits the agency directly. With it, a popular area is fetched once.

---

## 7. Configuration

Everything tunable is in the single marked `CONFIG` block at the top of
`js/dataforsyningen-dhm-layer.js`, between

```
/* ═══ CONFIG — everything tunable lives here and nowhere else. ═══ */
```

and

```
/* ════════════════════════ end of configuration ═══════════════════════ */
```

**The token is deliberately not in it** — it comes from the proxy, or from
`window.DETECTLAB_DK_TOKEN` in the insecure fallback.

| Key | Default | Meaning |
|---|---|---|
| `PROXY_PATH` | `/api/geo/dk-dhm` | same-origin tile path |
| `DIRECT_HOST` | `https://api.dataforsyningen.dk/` | used only in client-token mode |
| `FORMAT` / `STYLE` / `TILEMATRIXSET` | `image/jpeg` / `default` / `View1` | WMTS request parameters |
| `TILEMATRIX_PREFIX` | `''` | set to `'View1:'` if the server ever wants that spelling |
| `GRID_*`, `SOURCE_RES0`, `SOURCE_LEVELS` | from GetCapabilities | the `View1` grid |
| `WARP_MESH` | `8` | reprojection mesh (see §3) |
| `SOURCE_LEVEL_BIAS` | `0` | `+1` = always one level sharper |
| `MAX_SOURCE_TILES` | `12` | cap per destination tile |
| `SOURCE_CACHE_SIZE` | `96` | decoded source tiles kept in memory |
| `OPACITY` | `0.6` | JPEG is opaque, so this matters |
| `MIN_ZOOM` / `MAX_ZOOM` / `MAX_NATIVE_ZOOM` | `6` / `20` / `19` | 0.2 m/px runs out just under z19 |
| `KEEP_BUFFER` | `1` | preloading |
| `BOUNDS` | `[[54.4265, 7.99125], [57.7781, 15.5995]]` | published coverage |
| `ATTRIBUTION` | CC BY 4.0 text | shown in the Leaflet attribution control |
| `AUTH_MESSAGE` | *Invalid or missing Dataforsyningen token* | the 401/403 notice when a token *was* supplied but rejected |
| `TOKEN_MISSING_MESSAGE` | *The Denmark LiDAR layer is not configured on this deployment: the tile proxy (/api/geo/dk-dhm) has no DATAFORSYNINGEN_TOKEN…* | the notice when the deployment has no token at all — a configuration gap, not a provider outage |
| `PROXY_MISSING_MESSAGE` | *Denmark LiDAR proxy (/api/geo/dk-dhm) is not deployed on this server…* | a 404 from the same-origin proxy route (shell deployed without its functions) |
| `TOGGLE_ID` | `lidarDkLidarToggle` | the row the guard switches off when it reports the failure |
| `MODES` | `terrain`, `surface` | the two products |

**To change region or product**, edit `MODES` and `BOUNDS`. Any other
Dataforsyningen WMTS on the `View1` grid (for example
`topo_skaermkort_wmts_DAF`) drops straight in: add an entry with its
`service` and `layer`, and add the same pair to `LAYER_UPSTREAM` in
`backend/src/routes/geoProxy.js` and `netlify/functions/dk-dhm.mjs`. A
service on a *different* grid also needs the `GRID_*` block updated from its
own GetCapabilities.

---

## 8. Manual test checklist

Run the site with a proxy configured (§5.2), or open
`tools/denmark-lidar-demo.html` from the repository root.

1. **Toggle.** Turn *Denmark · DHM hillshade* on. A hillshade appears over
   Denmark within a second or two. Turn it off — it disappears completely.
2. **Opacity.** The slider starts at **60 %**. Drag to 0 → basemap only.
   Drag to 100 → the hillshade fully hides the basemap (JPEG, no alpha — this
   is expected, not a bug).
3. **Alignment — the important one.** Go to **Copenhagen at z13–15** with the
   opacity around 50 %. The hillshade's coastline must sit exactly on the
   basemap's coastline, with no visible shift. Repeat at:
   * the **Skagen** spit (57.740 N, 10.628 E) — a sharp, unmistakable shape;
   * the **Silkeborg lakes** (56.033 N, 9.530 E) — lake outlines are the most
     sensitive test there is;
   * **Bornholm** (55.10 N, 14.90 E) — the far east of UTM zone 32, where
     meridian convergence is largest and a bad reprojection shows first.
   *Any visible offset means the CRS or the grid is wrong.* A rotation that
   grows towards Bornholm would specifically mean the UTM maths is off.
4. **Network tab.** Open DevTools → Network, filter `dk-dhm`. Every request
   must:
   * go to **your own domain**, path `/api/geo/dk-dhm?…`;
   * contain **no `token=` parameter** anywhere in the URL;
   * return **200** with `Content-Type: image/jpeg`;
   * carry `Cache-Control: public, max-age=604800, immutable`.
   Pan back over an area you have already seen: the second visit should be a
   cache hit (`X-Proxy-Cache: HIT` from Express, or `(disk cache)` /
   `(memory cache)` in the browser).
5. **No bad requests inside coverage.** Pan around Denmark at several zooms.
   There must be **no 400, 401 or 403** at all.
6. **Outside coverage.** Pan to Sweden or Germany. The layer must go quiet —
   **zero** requests, no broken-image icons, no console output.
7. **Console.** Over a full session there should be at most **one**
   `[DataforsyningenDHM]` warning, never one per tile.
8. **Bad token.** Stop the proxy, or set `DATAFORSYNINGEN_TOKEN` to garbage
   and restart it. Expect a single small non-blocking notice reading
   **"Invalid or missing Dataforsyningen token"** that auto-dismisses, tiles
   that stay blank rather than broken, and no console flood.
9. **Product switch.** Change the dropdown from *Terræn* to *Overflade*. The
   image changes (buildings and trees appear); alignment is unaffected;
   `layer=dhm_overflade_skyggekort` shows in the Network tab.
10. **Attribution.** The bottom-right of the map reads *Indeholder data fra
    Klimadatastyrelsen, Danmarks Højdemodel (CC BY 4.0)* with working links.
11. **Other countries.** Switch on Sweden, Norway or Poland. They still work
    and still line up — nothing about the map CRS changed.

Automated side: `node test-denmark-dataforsyningen-dhm.js`.

---

## 9. Known limitations

* **Contours are gone.** `dhm_kurve_traditionel`, `dhm_kurve_0_5_m` and
  `dhm_kurve_0_25_m` exist **only on the WMS `dhm_DAF`**, never on the WMTS,
  so moving to the WMTS drops the two contour entries that used to be in the
  Denmark dropdown. If you want them back they need a separate WMS layer
  alongside this one — they cannot be served from `View1`.
* **JPEG, so no transparency.** Sea, and anything outside the data, is
  painted rather than left clear. Use the opacity slider; a `multiply` blend
  mode on the pane is an alternative if you prefer.
* **One canvas per tile.** Heavier than a plain `<img>` tile layer. In
  practice it is unnoticeable, but on very low-end hardware with many layers
  enabled it is not free.
* **Zoom beyond 19 is upsampled.** The finest `View1` level is 0.2 m/px,
  which runs out at about z18.7; past `MAX_NATIVE_ZOOM` Leaflet scales the
  last real tiles.
* **UTM zone 32 only.** `View1` covers Denmark; this is not a general
  reprojection layer.
* **No published quota.** If Dataforsyningen ever starts rate-limiting, the
  caching proxy is what will keep the site inside the limit.
* **Token cannot be scoped.** No domain or IP restriction exists, so the
  client-only fallback is genuinely insecure, not merely untidy.

---

## 10. Licence and attribution

Danmarks Højdemodel is **free geographic data** published by
**Klimadatastyrelsen** (the Danish Climate Data Agency, formerly SDFI) under
**Creative Commons Attribution 4.0 International (CC BY 4.0)**.

The required attribution, as stated by dataforsyningen.dk, is:

> **Indeholder data fra Klimadatastyrelsen, Danmarks Højdemodel**

It is rendered in the Leaflet attribution control by `CONFIG.ATTRIBUTION`,
together with a link to the CC BY 4.0 deed, and must stay visible wherever
the layer is shown.
