#!/usr/bin/env node
/*
 * tools/sync-danish-config.mjs
 * ───────────────────────────────────────────────────────────────────────────
 * Mirror js/danish-layers.config.js into the backend app root.
 *
 * Why a mirror at all: the backend is deployed on its own — Railway builds this
 * repository with `backend/` as the root directory, so the container only ever
 * contains /app/src/…, and any import that climbs out of that directory ends in
 * ERR_MODULE_NOT_FOUND at startup. The Danish proxy library
 * (backend/src/lib/danish-layers.mjs) needs the layer config for the upstream
 * URLs, the LAYERS values and the credential variable names, so the config is
 * vendored next to it.
 *
 * The mirror is a `.cjs` file on purpose: backend/package.json declares
 * "type": "module", so a `.js` file in that tree is parsed as ESM and its
 * `module.exports` never reach the proxy library — require() would hand back an
 * empty namespace instead of the layer list.
 *
 * The root file stays the single source of truth: this tool writes the mirror
 * with a generated header, and `node tools/sync-danish-config.mjs --check`
 * (run by test-danish-layers.js, and by every full test sweep) fails when the
 * two have drifted apart. Edit js/danish-layers.config.js, then run this tool.
 *
 *   node tools/sync-danish-config.mjs           # write the mirror
 *   node tools/sync-danish-config.mjs --check   # exit 1 if it is out of date
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'js/danish-layers.config.js');
const MIRROR = path.join(ROOT, 'backend/src/lib/danish-layers.config.cjs');

const HEADER = `/*
 * backend/src/lib/danish-layers.config.cjs
 * ───────────────────────────────────────────────────────────────────────────
 * GENERATED MIRROR — do not edit this copy.
 *
 * The canonical file is js/danish-layers.config.js; edit that one and run
 *
 *     node tools/sync-danish-config.mjs
 *
 * It exists because the backend is deployed with backend/ as its own app root
 * (Railway), so nothing inside it may import the repository root. The mirror is
 * byte-for-byte the canonical file below this header, and
 * \`node tools/sync-danish-config.mjs --check\` — part of the test suite —
 * fails on any drift.
 */

`;

export function expectedMirror() {
    return HEADER + fs.readFileSync(SOURCE, 'utf8');
}

const check = process.argv.includes('--check');
const want = expectedMirror();
const have = fs.existsSync(MIRROR) ? fs.readFileSync(MIRROR, 'utf8') : null;

if (check) {
    if (have === want) {
        console.log('✓ backend/src/lib/danish-layers.config.cjs is in step with js/danish-layers.config.js');
        process.exit(0);
    }
    console.error('✗ the backend mirror of the Danish layer config is out of date — run: ' +
        'node tools/sync-danish-config.mjs');
    process.exit(1);
}

if (have === want) {
    console.log('= backend/src/lib/danish-layers.config.cjs already in step');
} else {
    fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
    fs.writeFileSync(MIRROR, want);
    console.log('✓ wrote backend/src/lib/danish-layers.config.cjs (' +
        want.split('\n').length + ' lines) from js/danish-layers.config.js');
}
