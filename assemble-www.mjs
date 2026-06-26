#!/usr/bin/env node
/*
 * assemble-www.mjs
 * ----------------
 * Builds ./www (the Capacitor webDir) for the clean Chaos Bike Berlin app:
 *   - app/            -> www/            (index.html, app.css, app.js)
 *   - node_modules/leaflet/dist -> www/leaflet/
 *   - profiles/chaos_bike_berlin.brf -> www/profiles/
 *
 *   yarn app:build   = this script
 *   yarn app:sync    = this script + cap sync android
 *
 * (The brouter-web fork sources remain in the repo for reference but are no
 * longer used by the app.)
 */
import { existsSync, rmSync, mkdirSync, cpSync, copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const www = join(root, 'www');

function need(p) {
    if (!existsSync(join(root, p))) {
        console.error(`[assemble-www] ✗ missing ${p}`);
        process.exit(1);
    }
}
['app', 'node_modules/leaflet/dist', 'profiles/chaos_bike_berlin.brf'].forEach(need);

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

// app source
for (const f of readdirSync(join(root, 'app'))) {
    cpSync(join(root, 'app', f), join(www, f), { recursive: true });
}

// leaflet runtime (js, css, images/)
cpSync(join(root, 'node_modules/leaflet/dist'), join(www, 'leaflet'), { recursive: true });

// bundled routing profile
mkdirSync(join(www, 'profiles'), { recursive: true });
copyFileSync(join(root, 'profiles/chaos_bike_berlin.brf'), join(www, 'profiles/chaos_bike_berlin.brf'));

console.log('[assemble-www] ✓ assembled www/ (app + leaflet + profile)');
