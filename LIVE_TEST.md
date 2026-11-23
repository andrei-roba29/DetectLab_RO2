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
- `failed (no response within 12 s)` on EU-DEM: the EEA host accepted the request but never answered. The run must continue with the next source (the bar may stay on *Choosing elevation source…* for about 12 s per EU-DEM candidate, never longer). Send the Network-tab timing of that request.
- `failed (response larger than 4 MB)` on a DEM probe: the service ignored the requested window; send the logged `content-length`.
- `failed (HTTP 503)` or `(no HTTP response …)` on EU-DEM: the EEA host is down or blocks your domain (CORS). Say which.
- `wrong format` or `empty response body`: the endpoint answers, but not with GeoTIFF. Say what `content type` was logged.
- A warning that Terrarium (about 30 m) was used instead of 25 m: the EU-DEM sources failed.
- Water `failed` on EU-Hydro with a CORS message, followed by Overpass: EEA water is blocked for your domain.

Do not enable the Drainage Network option for this test. Do not change the Strahler map.


## Romania TRAIN deployment verification (2026-11-01)

With user approval, migration `20261101163027_apm_romania_train_correction` was applied to production on 2026-11-01. Its SQL file remains under `backend/migrations/manual/`, outside automatic startup discovery. SQL role/JWT-claim checks passed; real browser/signed-token/payment tests below remain pending. See `test-results/production-deployment.json`.

After approved staging deployment, verify premium, free, expired and logged-out sessions. Romania TRAIN must call only `apm_sites_within` for site data, using the existing client. Check browser Network for no other site-data host, explicit error/CSV behaviour on denied and timed-out requests, CSV-only behaviour outside Romania, counts, truncation and border warnings. Test legitimate payment and newsletter writes after the proposed profile-column privilege hardening.

TRAIN protection masks use the selected dataset and cached land restrictions only; unknown restriction cells remain unscored. No legacy heritage or land-tile download may be triggered by TRAIN. See `TRAIN_CORRECTION_REPORT.md` for local mocked-network and local PostgreSQL/PostGIS proof; those tests do not replace staging RLS/auth/performance checks.
