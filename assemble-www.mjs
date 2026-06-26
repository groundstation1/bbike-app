#!/usr/bin/env node
/*
 * assemble-www.mjs
 * ----------------
 * Collects the runtime files of the built brouter-web site into ./www, which is
 * the Capacitor `webDir` wrapped into the Android app.
 *
 * Run AFTER the gulp build (`yarn build`). The combined command is:
 *     yarn app:build       (gulp build + this script)
 *
 * Mirrors what Dockerfile serves: index.html + dist/ + config.js + keys.js,
 * plus the bundled profiles/ (loaded at runtime via BR.conf.profilesUrl).
 */
import { existsSync, rmSync, mkdirSync, cpSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const www = join(root, 'www');

const dirs = ['dist', 'profiles'];
const files = ['index.html', 'config.js', 'keys.js'];

for (const f of [...dirs, ...files]) {
    if (!existsSync(join(root, f))) {
        console.error(`[assemble-www] ✗ missing ${f} — did you run "yarn build" first?`);
        process.exit(1);
    }
}

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const d of dirs) {
    cpSync(join(root, d), join(www, d), { recursive: true });
}
for (const f of files) {
    copyFileSync(join(root, f), join(www, f));
}

console.log(`[assemble-www] ✓ assembled www/ (${[...dirs, ...files].join(', ')})`);
