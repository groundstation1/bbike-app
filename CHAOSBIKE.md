# Chaos Bike Berlin — Android app

A clean, mobile-first bike routing app for Berlin using the **chaos_bike_berlin**
profile. Custom lightweight UI (vanilla JS + Leaflet) that routes against the
public **brouter.de** server. Hybrid-packaged for Android with Capacitor.

The repo started as a fork of [cxberlin/brouter-web](https://github.com/cxberlin/brouter-web)
(its sources remain for reference), but the app itself is the purpose-built
frontend in **`app/`** — it does not use the brouter-web UI.

## Features (only these, by design)

- From / To / via **stops**: type an address (Photon autocomplete), **tap the map**, or **📍 my location**
- **Set map to location** (locate button)
- Routes **A → B → C**; tap map to add a stop; drag a pin to move it
- **Elevation profile**, **surface breakdown** (paved / gravel / unpaved / cobble-sett), **distance** & **estimated time**
- Uses **only** your `chaos_bike_berlin` profile

## How it works (nothing self-hosted)

| Concern | Service |
|---|---|
| Routing engine | public **brouter.de** |
| Your profile | `profiles/chaos_bike_berlin.brf` is uploaded to brouter.de at startup as a temporary custom profile; routing uses the returned `custom_<id>` (auto re-uploaded if it expires) |
| Map tiles | **CyclOSM** |
| Address search | **Photon** (komoot) |

Profile is single-sourced from `../bbike/chaos_bike_berlin.ini`
(copied here as `profiles/chaos_bike_berlin.brf`).

## Source layout

```
app/                 the actual app — index.html, app.css, app.js
profiles/            chaos_bike_berlin.brf
assemble-www.mjs     builds www/ = app/ + leaflet + profile
www/                 build output (Capacitor webDir, git-ignored)
android/             Capacitor Android project
```

## Build & run

Prereqs: Node, Yarn, Android Studio (for the Android build).

```bash
yarn install        # once (pulls leaflet + capacitor)
yarn app:build      # assemble www/
```

### Test in a desktop browser

```bash
yarn app:build
npx http-server www -p 8080 -c-1
# open http://localhost:8080
```

### Build the Android app

```bash
yarn app:sync           # assemble www/ + copy into android/  (run before building)
npx cap open android    # opens Android Studio, then press Run
```

- App id: `de.qgarden.chaosbike`
- Served over `https://localhost` in the WebView (secure context → geolocation works)
- Location permission is requested on first use of the 📍 button

## Tweaking

- Routing host, tiles, geocoder, start position: top of `app/app.js` (`CONFIG`)
- Profile: edit `profiles/chaos_bike_berlin.brf` (or recopy from the `.ini`), then `yarn app:sync`
- App id / name: `capacitor.config.json`
