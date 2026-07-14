/* ==========================================================================
 * 🎨  CARTOON TILES — throwaway EXPERIMENT (safe to delete)
 * --------------------------------------------------------------------------
 * Runs each map tile through a cheap image-to-image model (fal.ai fast-sdxl)
 * with a cartoon prompt, and caches results locally (IndexedDB) so you don't
 * re-pay for tiles you've already seen.
 *
 * ⚠️  Experiment only:
 *   - Your fal API key lives in the BROWSER (localStorage) — fine for a local
 *     experiment, NOT for anything public.
 *   - Costs ~$0.002–0.01 per new (uncached) tile. Cache mitigates re-views.
 *   - Off by default; nothing runs until you click the 🎨 button and paste a key.
 *
 * TO REMOVE THIS EXPERIMENT ENTIRELY:
 *   1. delete this file (app/experiments/cartoon-tiles.js)
 *   2. delete the marked <script> for it in app/index.html
 *   (No other file references it. It only uses window.cbbMap.)
 * ========================================================================== */
(function () {
    'use strict';

    var CONFIG = {
        // fal.ai image-to-image (cheap + fast + browser-friendly, returns inline via sync_mode)
        endpoint: 'https://fal.run/fal-ai/fast-sdxl/image-to-image',
        prompt: 'flat cartoon illustration of a map, bold black outlines, cel shaded, vibrant storybook colors',
        negative_prompt: 'text, labels, letters, blurry, photorealistic, noise, watermark',
        strength: 0.5, // 0=keep original, 1=ignore original. 0.4–0.6 keeps the map readable
        steps: 4,
        guidance_scale: 2,
        maxConcurrent: 3, // don't fire the whole viewport at once
        cacheName: 'cartoon-tiles',
        styleId: 'fast-sdxl-cartoon-v1', // bump to invalidate cache when you change the prompt
    };

    function getKey() {
        return localStorage.getItem('cartoonTilesFalKey') || '';
    }

    // ---- tiny IndexedDB string cache -------------------------------------
    var dbP;
    function db() {
        if (dbP) return dbP;
        dbP = new Promise(function (res, rej) {
            var r = indexedDB.open(CONFIG.cacheName, 1);
            r.onupgradeneeded = function () {
                r.result.createObjectStore('tiles');
            };
            r.onsuccess = function () {
                res(r.result);
            };
            r.onerror = function () {
                rej(r.error);
            };
        });
        return dbP;
    }
    function cacheGet(k) {
        return db().then(function (d) {
            return new Promise(function (res) {
                var q = d.transaction('tiles').objectStore('tiles').get(k);
                q.onsuccess = function () {
                    res(q.result || null);
                };
                q.onerror = function () {
                    res(null);
                };
            });
        });
    }
    function cachePut(k, v) {
        return db().then(function (d) {
            d.transaction('tiles', 'readwrite').objectStore('tiles').put(v, k);
        });
    }

    // ---- throttle ---------------------------------------------------------
    var active = 0,
        pending = [];
    function slot() {
        return new Promise(function (res) {
            if (active < CONFIG.maxConcurrent) {
                active++;
                res();
            } else pending.push(res);
        });
    }
    function release() {
        active--;
        var next = pending.shift();
        if (next) {
            active++;
            next();
        }
    }

    var disabledDueToError = false;

    // ---- stylize one tile -> data URI ------------------------------------
    function stylize(tileUrl, z, x, y) {
        var key = CONFIG.styleId + '|' + z + '/' + x + '/' + y;
        return cacheGet(key).then(function (hit) {
            if (hit) return hit;
            if (disabledDueToError) return Promise.reject('disabled');
            var apiKey = getKey();
            if (!apiKey) return Promise.reject('no-key');
            return slot()
                .then(function () {
                    return fetch(CONFIG.endpoint, {
                        method: 'POST',
                        headers: { Authorization: 'Key ' + apiKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            image_url: tileUrl, // fal fetches the source tile (no browser CORS needed)
                            prompt: CONFIG.prompt,
                            negative_prompt: CONFIG.negative_prompt,
                            strength: CONFIG.strength,
                            num_inference_steps: CONFIG.steps,
                            guidance_scale: CONFIG.guidance_scale,
                            enable_safety_checker: false,
                            sync_mode: true, // return image inline as a data: URI
                        }),
                    });
                })
                .then(function (r) {
                    if (r.status === 401 || r.status === 403) {
                        disabledDueToError = true;
                        alert('Cartoon tiles: fal API key rejected. Disabling experiment.');
                        throw new Error('auth');
                    }
                    if (!r.ok) throw new Error('http ' + r.status);
                    return r.json();
                })
                .then(function (j) {
                    var uri = j && j.images && j.images[0] && j.images[0].url;
                    if (!uri) throw new Error('no image');
                    cachePut(key, uri);
                    return uri;
                })
                .finally(function () {
                    release();
                });
        });
    }

    // ---- Leaflet cartoon tile layer --------------------------------------
    L.TileLayer.Cartoon = L.TileLayer.extend({
        createTile: function (coords, done) {
            var tile = document.createElement('img');
            tile.setAttribute('role', 'presentation');
            tile.alt = '';
            var url = this.getTileUrl(coords);
            stylize(url, coords.z, coords.x, coords.y)
                .then(function (src) {
                    tile.onload = function () {
                        done(null, tile);
                    };
                    tile.onerror = function () {
                        tile.src = url;
                        done(null, tile);
                    };
                    tile.src = src;
                })
                .catch(function () {
                    tile.src = url; // fall back to the original tile on any error
                    done(null, tile);
                });
            return tile;
        },
    });

    // ---- enable / disable by swapping the base layer ---------------------
    var cartoonLayer = null,
        savedLayer = null;
    function baseTileLayer(map) {
        var found = null;
        map.eachLayer(function (l) {
            if (l instanceof L.TileLayer && !(l instanceof L.TileLayer.Cartoon)) found = l;
        });
        return found;
    }
    function enable() {
        var map = window.cbbMap;
        if (!map || cartoonLayer) return;
        savedLayer = baseTileLayer(map);
        var url = savedLayer ? savedLayer._url : 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png';
        var opts = savedLayer
            ? { subdomains: savedLayer.options.subdomains, maxZoom: savedLayer.options.maxZoom }
            : { subdomains: 'abc', maxZoom: 20 };
        opts.attribution = '🎨 cartoonized (experiment) · ' + (savedLayer ? savedLayer.options.attribution || '' : '');
        if (savedLayer) map.removeLayer(savedLayer);
        cartoonLayer = new L.TileLayer.Cartoon(url, opts).addTo(map);
    }
    function disable() {
        var map = window.cbbMap;
        if (!map || !cartoonLayer) return;
        map.removeLayer(cartoonLayer);
        cartoonLayer = null;
        if (savedLayer) savedLayer.addTo(map);
    }
    function clearCache() {
        return db().then(function (d) {
            d.transaction('tiles', 'readwrite').objectStore('tiles').clear();
        });
    }

    // ---- on-screen toggle (clearly an experiment) ------------------------
    function injectButton() {
        var btn = document.createElement('button');
        btn.id = 'cartoonToggle';
        btn.type = 'button';
        btn.textContent = '🎨';
        btn.title = 'Cartoon tiles (experiment)';
        btn.style.cssText =
            'position:absolute;left:14px;bottom:calc(28px + env(safe-area-inset-bottom,0px));z-index:1000;' +
            'width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:0 6px 24px rgba(20,30,25,.18);' +
            'font-size:20px;line-height:44px;text-align:center;cursor:pointer;border:none;';
        btn.addEventListener('click', function () {
            if (cartoonLayer) {
                disable();
                btn.style.background = '#fff';
                return;
            }
            if (!getKey()) {
                var k = prompt('Paste your fal.ai API key (stored locally in this browser only):', '');
                if (!k) return;
                localStorage.setItem('cartoonTilesFalKey', k.trim());
                disabledDueToError = false;
            }
            enable();
            btn.style.background = '#ffe082';
        });
        document.body.appendChild(btn);
    }

    function boot() {
        if (!window.L) return;
        if (window.cbbMap) injectButton();
        else setTimeout(boot, 200); // wait for the map to exist
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // console API: CartoonTiles.enable()/disable()/clearCache(), tweak CartoonTiles.CONFIG
    window.CartoonTiles = { enable: enable, disable: disable, clearCache: clearCache, CONFIG: CONFIG };
})();
