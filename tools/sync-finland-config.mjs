#!/usr/bin/env node
/*
 * tools/sync-finland-config.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Copy js/finland-layers.config.js → backend/src/lib/finland-layers.config.cjs
 *
 * The backend deploys with backend/ as its own app root (Railway), so its
 * proxy library may not import anything outside it. The browser config is
 * UMD (module.exports works under require()), so the "vendored copy" is a
 * byte-for-byte copy with a .cjs extension — "type": "module" would parse a
 * .js copy as ESM and export nothing.
 *
 *   node tools/sync-finland-config.mjs           copy
 *   node tools/sync-finland-config.mjs --check   fail on drift (CI/tests)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'js', 'finland-layers.config.js');
const target = path.join(root, 'backend', 'src', 'lib', 'finland-layers.config.cjs');

const code = readFileSync(source, 'utf8');
const check = process.argv.includes('--check');

if (check) {
  let existing = '';
  try {
    existing = readFileSync(target, 'utf8');
  } catch {
    console.error(`[sync-finland-config] missing vendored copy: ${target}`);
    process.exit(1);
  }
  if (existing !== code) {
    console.error('[sync-finland-config] js/finland-layers.config.js and the vendored ' +
      'backend copy have drifted — run: node tools/sync-finland-config.mjs');
    process.exit(1);
  }
  console.log('[sync-finland-config] in sync');
  process.exit(0);
}

writeFileSync(target, code);
console.log(`[sync-finland-config] wrote ${path.relative(root, target)} ` +
  `(${code.length} bytes) from js/finland-layers.config.js`);
