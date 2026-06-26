# Chaos Bike Berlin — Android app

A hybrid (Capacitor) Android wrapper around [brouter-web](https://github.com/nrenner/brouter-web),
trimmed to the **chaos_bike_berlin** routing profile. Forked from
[cxberlin/brouter-web](https://github.com/cxberlin/brouter-web).

## What it does

-   Routes A → B → C with click-to-add / draggable waypoints
-   Address search (Photon geocoder), pick-on-map, and **current location** (GPS)
-   Elevation profile, surface / way-type stats, distance & **estimated travel time**
-   Uses **only** your `chaos_bike_berlin` profile

## How it works (no self-hosting)

All services are public third parties — nothing you have to host:

| Concern        | Service                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing engine | public **brouter.de** (`BR.conf.host`)                                                                                                      |
| Your profile   | `profiles/chaos_bike_berlin.brf` is uploaded to brouter.de at launch as a temporary custom profile; routing uses the returned `custom_<id>` |
| Map tiles      | **CyclOSM** (default, no key) — Thunderforest/MapTiler slots in `config.js` + `keys.js`                                                     |
| Address search | **Photon** (komoot)                                                                                                                         |

The profile is single-sourced from `../bbike/chaos_bike_berlin.ini`
(copied here as `profiles/chaos_bike_berlin.brf`).

## Build & run

Prereqs: Node (tested on v25), Yarn, Android Studio (for the Android build).

```bash
yarn install            # once
yarn app:build          # gulp build + assemble www/
yarn app:sync           # build + assemble + copy into android/  (run before opening Android Studio)
```

### Test in a desktop browser (no Android needed)

```bash
yarn app:build
npx http-server www -p 8080 -c-1
# open http://localhost:8080
```

(The app always talks to brouter.de, so routing works straight from the browser.)

Alternatively `yarn serve` runs brouter-web's dev server with live reload.

### Build the Android app

```bash
yarn app:sync           # IMPORTANT: refreshes android/ web assets from your latest build
npx cap open android    # opens Android Studio
```

Then press **Run** in Android Studio (device or emulator). Location permission is
requested on first use of the "locate me" button.

-   App id: `de.qgarden.chaosbike`
-   Served over `https://localhost` inside the WebView (secure context → geolocation works)

## Editing the profile

Edit `profiles/chaos_bike_berlin.brf` (or re-copy from `../bbike/chaos_bike_berlin.ini`),
then `yarn app:sync` and rebuild in Android Studio.

## Config knobs

-   `config.js` — routing host, tile layers, geocoder, map start position
-   `keys.js` — optional API keys (Thunderforest etc.)
-   `capacitor.config.json` — app id / name / webDir
