# Roman roads: why segments didn't load around Aiton, Cluj

Investigation of the reported missing Roman-road segments around Aiton
(Cluj-Napoca, Romania), 2026-11-07.

## Summary

The two historical causes that could hide the Aiton road are fixed in this
repository (`js/roman-roads-parser.js`, `js/roman-roads.js`,
`js/roman-roads-worker.js`, version `20261104-roman-roads-v2`). Verification
against the real Itiner-e dataset and the live Supabase object confirms the
full network loads and the Aiton segment renders at every zoom level. If
segments still appear missing in the field, the likely causes are an older
deployed build, a stale service-worker cache, or the documented continental
low-zoom sampling.

## Root causes (both fixed in v20261104-roman-roads-v2)

1. **Collector dropped valid roads on large chunks.** The old collector
   compacted its in-progress batch purely by size, so when one network chunk
   contained more than two transfer batches it silently discarded thousands
   of valid roads. The fix: the worker and the main-thread fallback now flush
   between records (`if (collector.shouldFlush()) flush()` inside the line
   loop) and the collector no longer performs batch-size-driven compaction.
   Backpressure still caps un-acked batches at 4.

2. **Low-zoom renderer sampled against the whole network.** The old renderer
   compared a tile's candidates against the size of the entire network
   before culling, so a tile containing only 58 candidate segments (Aiton's
   z8 tile) could lose its roads under the 1,500-item budget. The fix:
   candidates are counted after spatial/bbox culling (`pass(false)` counts,
   then `capped = candidates > itemBudget`), and long roads are counted once
   (span list + cell-index overlap suppressed via `skipSpans`).

## Verification (2026-11-07)

- Real Itiner-e NDJSON (39,057,170 bytes, 16,554 records): all segments load,
  **0 sampled, 0 skipped**, under both the desktop and phone budgets
  (desktop: 96 MB / 900k segments / 9M vertices; phone: 40 MB / 350k / 3M).
- The Aiton tile candidate counts with the real data: z2 13,358, z3 6,760,
  z4 1,112, z5 1,036, z6 153, z7 131, z8 58, z9+ < 35. Even at the adaptive
  budget floor (1,500), z4+ tiles near Aiton draw everything — only
  continental z2–z3 tiles can be capped on slow devices.
- The live Supabase object (`Harti/route-segments-all-1791445468011.ndjson`)
  contains segment **23379 (Potaissa–Napoca)** with 71 vertices and geometry
  identical to the fixture `test/fixtures/roman-road-aiton.geojson`. The
  live object is ~5% larger than the public snapshot (~41 MB, ~17.4k
  records) — still far below the phone budget.
- All node tests pass: `test-roman-roads-pipeline.js`,
  `test-roman-roads-completeness.js`, `test-roman-reference-layer.js`.

## Remaining causes if gaps persist in the field

1. **Deployment lag.** The repo HEAD (2026-11-05) contains the fix, but the
   deployed build lagged behind it (`test-results/baseline.json` from the
   deployed checkout shows the deployed `index.html` didn't even load the
   roman-roads modules — it ran the pre-fix pipeline). The Netlify site is
   currently paused by Netlify usage limits.
2. **Stale service-worker cache.** `sw.js` serves the NDJSON cache-first
   (`detectlab-roman-roads-v1`) with a 30-day age-based refresh; a cached
   copy from before a data/pipeline change is served until it ages out.
3. **Continental-zoom adaptive sampling (by design).** At z2–z3 on slow
   devices, tiles with thousands of candidates are sampled 1:N to bound paint
   time. Aiton's road can only be sampled out at those continental zooms.

## Conclusion

The missing-segments bug is fixed in this repository and verified against
the real 39 MB dataset: the full network loads and the Aiton road renders
at every zoom. Field reports of missing segments around Aiton are explained
by an older deployed build, a stale SW cache, or the documented
continental-zoom sampling — not by the current code.
