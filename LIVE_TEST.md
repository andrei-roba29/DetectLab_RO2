# Next-Gen APM: first live test

Goal: check that the elevation and water sources answer from your browser, and send back the log if they do not.
Time: about 10 minutes. You need a premium account.

## Steps

1. Open the site in Chrome or Edge on a desktop. Open DevTools (F12) → Network tab, and keep it open.
2. Add `?apmDebug=1` to the URL and reload. You need a premium account (the developer override has been removed).
3. Click **APM** (bottom-left). Turn the switch **on**.
4. Click **Pick point on map**, then click a point inside Europe (for example near Marlow, England). Leave the radius at **5 km**. Keep MANUAL, leave weights at their defaults.
5. Click **Run**. Wait for it to finish (or fail).
6. Open the warnings list and note the first line exactly.
7. Open **Debug log** → **Download diagnostics**. Save the JSON file.
8. Repeat steps 4–7 once outside Europe (for example Sydney). Only Terrarium should be used there.

## Send back

- The diagnostics JSON from step 7 (both runs).
- The exact warning text from step 6 for each run.
- A screenshot of the **Network** tab filtered to `discomap`, `s3.amazonaws.com` and `overpass`, showing status and any red entries.
- Your browser name and version, and whether you are logged in.

## What to look for

- `EU-DEM v1.1` → `HTTP 200` for `GetCapabilities` and `GetCoverage`: the primary source works.
- `failed (HTTP 503)` or `(no HTTP response …)` on EU-DEM: the EEA host is down or blocks your domain (CORS). Say which.
- `wrong format` or `empty response body`: the endpoint answers, but not with GeoTIFF. Say what `content type` was logged.
- A warning that Terrarium (about 30 m) was used instead of 25 m: the EU-DEM sources failed.
- Water `failed` on EU-Hydro with a CORS message, followed by Overpass: EEA water is blocked for your domain.

Do not enable the Drainage Network option for this test. Do not change the Strahler map.
