#!/usr/bin/env node
/**
 * test-globe-lockin-logic.mjs
 *
 * Verifies the "lock-in to country extent" state machine for the standalone
 * ArcGIS globe page (arcgis-globe-europe.html — SceneView, viewingMode:
 * "global"). A global SceneView does NOT support `constraints.geometry`, so
 * the lock is emulated with an altitude ceiling + a clamp of `view.center`
 * whenever the view goes stationary.
 *
 * The globe page is a single self-contained HTML file, so that logic cannot be
 * imported and unit-tested directly. This harness re-states the exact code path
 * (same stale-selection token guard, same clamp math, same constraint capture /
 * restore) against a stub of the ArcGIS Maps SDK 4.31 surface it touches:
 *
 *     view.goTo · view.constraints.{altitude,tilt} · view.camera.position.z
 *     view.center · view.stationary · reactiveUtils.watch · Graphic.attributes
 *
 * and pins the behaviour the acceptance test checks:
 *   1. pick a country  -> constraints tighten only AFTER the flight lands
 *   2. zoom out / drag -> the view is brought back inside the country extent
 *   3. micro-states    -> get a wider expansion factor so zoom is usable
 *   4. two picks in a row (touch double-tap) -> the newest pick wins, the
 *      superseded flight must not write its constraints afterwards
 *   5. "back to globe" -> altitude/tilt restored to the values captured at
 *      view.when(), watcher removed, selection cleared, HOME flight
 *
 * Run: node test-globe-lockin-logic.mjs
 */

import assert from "node:assert/strict";

/* =========================================================================
 * ArcGIS Maps SDK 4.31 stubs (test-only)
 * ========================================================================= */

const EARTH_RADIUS = 6378137;

class Extent {
  constructor(xmin, ymin, xmax, ymax) {
    this.xmin = xmin; this.ymin = ymin; this.xmax = xmax; this.ymax = ymax;
  }
  get width() { return this.xmax - this.xmin; }
  get height() { return this.ymax - this.ymin; }
  clone() { return new Extent(this.xmin, this.ymin, this.xmax, this.ymax); }
  /** ArcGIS semantics: scales width/height by `factor` around the centre. */
  expand(factor) {
    const cx = (this.xmin + this.xmax) / 2;
    const cy = (this.ymin + this.ymax) / 2;
    const w = (this.width * factor) / 2;
    const h = (this.height * factor) / 2;
    this.xmin = cx - w; this.xmax = cx + w;
    this.ymin = cy - h; this.ymax = cy + h;
    return this;
  }
  union(other) {
    this.xmin = Math.min(this.xmin, other.xmin);
    this.ymin = Math.min(this.ymin, other.ymin);
    this.xmax = Math.max(this.xmax, other.xmax);
    this.ymax = Math.max(this.ymax, other.ymax);
    return this;
  }
  contains(lon, lat) {
    return lon >= this.xmin && lon <= this.xmax && lat >= this.ymin && lat <= this.ymax;
  }
}

const reactiveUtils = (() => {
  const watchers = new Set();
  return {
    watch(getter, callback) {
      const w = { getter, callback, active: true };
      watchers.add(w);
      return { remove() { w.active = false; watchers.delete(w); } };
    },
    /** test hook: pretend a frame settled and run the watcher callbacks */
    _flush() { for (const w of [...watchers]) if (w.active) w.callback(w.getter()); },
    _count() { return watchers.size; },
  };
})();

/** Camera altitude that "fits" an extent — smaller country => lower camera. */
const fitAltitude = (ext) => Math.max(20000, Math.max(ext.width, ext.height) * 90000);

class ViewStub {
  constructor() {
    // documented 4.x defaults: min = -Infinity, max = EARTH_RADIUS * 4
    this.constraints = { altitude: { min: -Infinity, max: EARTH_RADIUS * 4 }, tilt: { max: 90 } };
    this.camera = { position: { x: 15, y: 28, z: 7500000 }, tilt: 0, heading: 0 };
    this.center = { longitude: 15, latitude: 28 };
    this.stationary = false;
    this.gotoLog = [];
    this._seq = 0;
  }

  async goTo(spec, opts = {}) {
    const seq = ++this._seq;
    this._apply(spec);
    this.gotoLog.push({ target: spec, opts });
    await new Promise((r) => setImmediate(r)); // let a newer goTo supersede this one
    // `noAbort` models the SDK versions where an interrupted goTo still
    // resolves instead of rejecting — the case the stale-token guard covers.
    if (seq !== this._seq && !this.noAbort) {
      const err = new Error("goTo superseded");
      err.name = "AbortError";
      throw err;
    }
    return { target: spec };
  }

  _apply(spec) {
    if (!spec) return;
    const alt = this.constraints.altitude;
    const tilt = spec.tilt;
    const heading = spec.heading;
    // goTo({target, tilt, heading}) — tilt/heading ride on the outer object
    let target = spec;
    if (spec.position === undefined && spec.center === undefined && spec.target) target = spec.target;

    if (target.position) {
      this.camera.position.z = clamp(target.position.z, alt.min, alt.max);
      this.camera.tilt = tilt ?? target.tilt ?? 0;
      this.camera.heading = heading ?? target.heading ?? 0;
      if (target.position.longitude !== undefined) {
        this.center = { longitude: target.position.longitude, latitude: target.position.latitude };
      }
    } else if (typeof target.xmin === "number") {
      this.center = { longitude: (target.xmin + target.xmax) / 2, latitude: (target.ymin + target.ymax) / 2 };
      this.camera.position.z = clamp(fitAltitude(target), alt.min, alt.max);
      this.camera.tilt = tilt ?? 0;
      this.camera.heading = heading ?? 0;
    } else if (Array.isArray(target.center)) {
      this.center = { longitude: target.center[0], latitude: target.center[1] };
    }
    // the camera must never sit outside the active altitude window
    this.camera.position.z = clamp(this.camera.position.z, alt.min, alt.max);
  }

  /** test hook: user drags / flings the globe, then the view settles */
  dragTo(longitude, latitude) {
    this.center = { longitude, latitude };
    this.stationary = true;
    reactiveUtils._flush();
    this.stationary = false;
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* =========================================================================
 * Harness: fake DOM + GraphicsLayer contents
 * ========================================================================= */

const dom = {
  backBtn: { style: { display: "none" } },
  clear: { onclick: null },
  tip: { textContent: "" },
};
const $ = (id) => dom[id] || (dom[id] = { style: { display: "none" }, textContent: "" });

const COUNTRIES = [
  { name: "România", extent: [20.26, 43.62, 29.72, 48.27] },
  { name: "Franța", extent: [-5.14, 41.33, 9.56, 51.09] },
  { name: "Malta", extent: [14.18, 35.79, 14.58, 36.08] },
  { name: "Germania", extent: [5.87, 47.27, 15.04, 55.06] },
];
const countries = {
  graphics: COUNTRIES.map((c) => ({
    attributes: { name: c.name },
    geometry: { extent: new Extent(...c.extent) },
  })),
};

/* =========================================================================
 * Mirrored logic — identical to the code that goes into the HTML page
 * ========================================================================= */

const view = new ViewStub();
const sel = new Set();
const symSel = { id: "symSel" }, symDim = { id: "symDim" },
      symHover = { id: "symHover" }, symBase = { id: "symBase" };
const hov = null;

let lock = null, lockWatch = null, lockTok = 0, defAlt = null, defTilt = null;
const HOME = { position: { longitude: 15, latitude: 28, z: 7500000 }, tilt: 0, heading: 0 };

// captured AFTER the view is ready, so whatever the original file put in the
// SceneView constructor (altitude floor, tilt ceiling) is what we restore.
view.constraints.altitude = { min: 100, max: 20000000 }; // e.g. existing page config
view.constraints.tilt = { max: 85 };
defAlt = { min: view.constraints.altitude.min, max: view.constraints.altitude.max };
defTilt = { max: view.constraints.tilt.max };

const fin = (v, fallback) => (Number.isFinite(v) ? v : fallback);
function restoreConstraints() {
  view.constraints.altitude = {
    min: fin(defAlt?.min, -200000),
    max: fin(defAlt?.max, EARTH_RADIUS * 4),
  };
  view.constraints.tilt = { max: fin(defTilt?.max, 90) };
}

const symDimSpec = {
  type: "simple-fill",
  color: [70, 120, 190, 0.0],
  outline: { color: [255, 255, 255, 0.25], width: 0.5 },
};

function symbolFor(d) {
  if (sel.has(d.name)) return symSel;
  if (lock) return symDim;
  return d.name === hov ? symHover : symBase;
}

function selectionExtent() {
  let ext = null;
  countries.graphics.forEach((g) => {
    if (!sel.has(g.attributes.name)) return;
    ext = ext ? ext.union(g.geometry.extent) : g.geometry.extent.clone();
  });
  if (!ext) return null;
  // micro-states (Malta, Monaco, Vatican...) need a wider factor, otherwise the
  // fitted camera sits so low that the altitude max blocks any pan.
  const span = Math.max(ext.width, ext.height);
  return ext.clone().expand(span < 2 ? 2 : 1.25);
}

async function lockToSelection() {
  const ext = selectionExtent();
  if (!ext) return;

  const tok = ++lockTok;
  lockWatch?.remove();
  lockWatch = null;

  restoreConstraints();          // allow the flight (previous max must not block it)
  lock = { ext };
  restyle();

  try {
    await view.goTo({ target: ext, tilt: 0, heading: 0 }, { duration: 1400, easing: "in-out-cubic" });
  } catch (e) {
    return;                      // superseded by a newer goTo / unlock
  }
  if (tok !== lockTok) return;   // a newer selection owns the state now

  view.constraints.altitude = { min: 1500, max: view.camera.position.z * 1.25 };
  view.constraints.tilt = { max: 70 };

  lockWatch = reactiveUtils.watch(() => view.stationary, (st) => {
    if (!st || !lock) return;
    const c = view.center;
    const e = lock.ext;
    const lon = Math.min(Math.max(c.longitude, e.xmin), e.xmax);
    const lat = Math.min(Math.max(c.latitude, e.ymin), e.ymax);
    if (lon !== c.longitude || lat !== c.latitude) {
      // deliberately not awaited — a later drag/new pick supersedes it, and an
      // unhandled AbortError rejection would show up as a console error
      view.goTo({ center: [lon, lat] }, { duration: 400 }).catch(() => {});
    }
  });

  $("backBtn").style.display = "block";
}

function unlock() {
  lockTok++;
  lockWatch?.remove();
  lockWatch = null;
  lock = null;
  restoreConstraints();
  sel.clear();
  restyle();
  view.goTo(HOME, { duration: 1600 }).catch(() => {});   // AbortError-safe
  $("backBtn").style.display = "none";
}
$("backBtn").onclick = unlock;

function toggle(n) {
  sel.has(n) ? sel.delete(n) : sel.add(n);
  restyle();
  sel.size ? lockToSelection() : unlock();
}
$("clear").onclick = unlock;

/** stand-in for the page's restyle(): re-applies symbolFor to every graphic */
const lastSymbols = new Map();
const dirty = new Set();
function restyle() {
  for (const g of countries.graphics) {
    const s = symbolFor(g.attributes);
    lastSymbols.set(g.attributes.name, s);
    dirty.add(g.attributes.name);
  }
}

/* =========================================================================
 * Tests
 * ========================================================================= */

let consoleErrors = 0;
process.on("unhandledRejection", (e) => {
  consoleErrors++;
  console.error(`FAIL  console error — unhandled rejection: ${e.name}: ${e.message}`);
  process.exitCode = 1;
});

const settle = () => new Promise((r) => setTimeout(r, 0));
let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const reset = () => {
  unlock();
  view.stationary = false;
  return settle();
};

console.log("\narcgis-globe-europe.html · lock-in state machine\n");

await test("1. pick a country: constraints tighten only after the flight lands", async () => {
  await reset();
  const p = toggle("România");
  // mid-flight: the page must still be free to move (no altitude trap yet)
  assert.equal(lockWatch, null, "watcher must not be installed before landing");
  assert.equal(view.constraints.altitude.min, 100, "flight must not be clamped by the old lock");
  await p; await settle();

  const fitted = fitAltitude(selectionExtent());
  assert.equal(view.constraints.altitude.min, 1500);
  assert.equal(view.constraints.altitude.max, fitted * 1.25);
  assert.equal(view.constraints.tilt.max, 70);
  assert.equal(view.camera.tilt, 0, "flight must land at tilt 0");
  assert.equal(dom.backBtn.style.display, "block");
  assert.ok(reactiveUtils._count() === 1, "exactly one clamp watcher");
});

await test("2. locked extent is the country bbox expanded by 1.25", async () => {
  const ext = selectionExtent();
  assert.ok(Math.abs(ext.width - 9.46 * 1.25) < 1e-9, `width ${ext.width}`);
  assert.ok(Math.abs(ext.height - 4.65 * 1.25) < 1e-9, `height ${ext.height}`);
  assert.equal(lastSymbols.get("România"), symSel, "selected keeps symSel");
  assert.equal(lastSymbols.get("Franța"), symDim, "others dim to symDim");
  assert.equal(symDimSpec.color[3], 0, "dimmed fill is fully transparent");
});

await test("3. zoom-out beyond the ceiling is refused (max altitude = z * 1.25)", async () => {
  const maxAlt = view.constraints.altitude.max;
  await view.goTo({ position: { longitude: 25, latitude: 46, z: maxAlt * 4 }, tilt: 0 });
  assert.equal(view.camera.position.z, maxAlt, "camera must stop at the ceiling");
});

await test("4. dragging the globe away snaps the centre back into the extent", async () => {
  const before = view.gotoLog.length;
  view.dragTo(-40, -10);                                  // yanked to the Atlantic
  await settle();
  const e = lock.ext;
  assert.ok(e.contains(view.center.longitude, view.center.latitude),
    `centre ${view.center.longitude},${view.center.latitude} not inside extent`);
  assert.equal(view.gotoLog.length, before + 1, "exactly one corrective goTo");
  assert.equal(view.gotoLog.at(-1).opts.duration, 400);

  // a legitimate move stays inside the extent -> no corrective flight
  const ok = view.gotoLog.length;
  view.dragTo(24.0, 45.0);
  await settle();
  assert.equal(view.gotoLog.length, ok, "no correction while still inside");
});

await test("5. two picks in a row: only the newest flight may install state", async () => {
  await reset();
  // Multi-select: România then Franța leaves both selected, so the lock is the
  // union — but the FIRST flight (to România only) must not install a second
  // clamp watcher or overwrite the ceiling when it resolves late.
  view.noAbort = true; // model an SDK that resolves a superseded goTo
  const p1 = toggle("România");
  const p2 = toggle("Franța");
  await Promise.allSettled([p1, p2]);
  await settle();
  view.noAbort = false;

  const union = new Extent(20.26, 43.62, 29.72, 48.27)
    .union(new Extent(-5.14, 41.33, 9.56, 51.09))
    .expand(1.25);
  assert.ok(Math.abs(lock.ext.width - union.width) < 1e-9, "lock must describe the union");
  assert.equal(reactiveUtils._count(), 1,
    "the superseded flight must not stack a second clamp watcher");
  assert.equal(view.constraints.altitude.max, fitAltitude(union) * 1.25,
    "ceiling must come from the last flight only");
  assert.equal(view.constraints.altitude.min, 1500);
});

await test("6. micro-state (Malta) gets the wider expansion factor", async () => {
  await reset();
  await toggle("Malta"); await settle();
  // span 0.4 < 2 degrees -> expand(2)
  assert.ok(Math.abs(lock.ext.width - 0.4 * 2) < 1e-9, `width ${lock.ext.width}`);
  assert.equal(view.constraints.altitude.min, 1500);
  assert.ok(view.constraints.altitude.max > 1500, "ceiling above the floor");
});

await test("7. multi-select locks onto the union of the picked extents", async () => {
  await reset();
  await toggle("România"); await settle();
  await toggle("Franța"); await settle();
  assert.equal(sel.size, 2);
  const u = new Extent(20.26, 43.62, 29.72, 48.27).union(new Extent(-5.14, 41.33, 9.56, 51.09)).expand(1.25);
  assert.equal(lock.ext.xmin, u.xmin);
  assert.equal(lock.ext.xmax, u.xmax);
  assert.equal(lock.ext.ymin, u.ymin);
  assert.equal(lock.ext.ymax, u.ymax);
  assert.equal(reactiveUtils._count(), 1, "re-locking must not stack watchers");
});

await test("8. back to globe: constraints restored, watcher gone, HOME flight", async () => {
  const before = view.gotoLog.length;
  unlock();
  await settle();
  assert.equal(lock, null);
  assert.equal(lockWatch, null);
  assert.equal(reactiveUtils._count(), 0, "clamp watcher removed");
  assert.equal(sel.size, 0);
  assert.equal(dom.backBtn.style.display, "none");
  assert.equal(lastSymbols.get("Franța"), symBase, "dimming cleared");

  // restored to what the page had at view.when() — NOT hard-coded defaults
  assert.equal(view.constraints.altitude.min, 100, "floor restored to the page value");
  assert.equal(view.constraints.altitude.max, 20000000, "ceiling restored to the page value");
  assert.equal(view.constraints.tilt.max, 85, "tilt restored to the page value");

  const home = view.gotoLog.at(-1);
  assert.ok(view.gotoLog.length > before);
  assert.equal(home.target.position.longitude, 15);
  assert.equal(home.target.position.latitude, 28);
  assert.equal(home.target.position.z, 7500000);
  assert.equal(home.opts.duration, 1600);
});

await test("9. after unlock the globe is free again (no stale clamp)", async () => {
  const before = view.gotoLog.length;
  view.constraints.altitude = { min: 100, max: 20000000 };
  view.dragTo(-120, 10);                              // anywhere on the planet
  await settle();
  assert.equal(view.center.longitude, -120, "no clamp watcher left behind");
  assert.equal(view.center.latitude, 10);
  assert.equal(view.gotoLog.length, before, "no corrective flights");
});

await test("10. unlock during a flight cancels the pending lock (no late constraints)", async () => {
  await reset();
  const p = toggle("Germania");
  unlock();                                           // user hits back mid-flight
  await Promise.allSettled([p]);
  await settle();
  assert.equal(lock, null, "no lock resurrected by the interrupted flight");
  assert.equal(reactiveUtils._count(), 0);
  assert.equal(view.constraints.tilt.max, 85, "tilt ceiling left at the page default");
});

await test("11. interrupting a clamp flight raises no console error", async () => {
  await reset();
  await toggle("Germania");
  await settle();
  assert.equal(consoleErrors, 0, "clean so far");

  // drag out -> clamp flight starts; drag again -> it is superseded; Back -> also
  view.dragTo(-40, -10);
  view.dragTo(-30, -5);
  unlock();
  await settle();

  assert.equal(consoleErrors, 0,
    "superseded goTo promises must not surface as unhandled rejections");
  assert.equal(reactiveUtils._count(), 0);
});

await test("12. switching country while locked relaxes the previous ceiling first", async () => {
  await reset();
  await toggle("Malta");
  await settle();
  const maltaCeiling = view.constraints.altitude.max;   // low, suited to a micro-state

  // no reset(): the user picks a much larger country straight from the list
  await toggle("Germania");
  await settle();

  assert.ok(view.constraints.altitude.max > maltaCeiling,
    "the new ceiling must come from the new flight, not the old lock");
  assert.ok(Math.abs(view.camera.position.z - fitAltitude(lock.ext)) < 1e-6,
    `flight was clamped by the previous ceiling (z=${view.camera.position.z}, want ${fitAltitude(lock.ext)})`);
  assert.equal(view.constraints.altitude.max, fitAltitude(lock.ext) * 1.25);
});

console.log(`\n${passed}/12 checks passed\n`);
