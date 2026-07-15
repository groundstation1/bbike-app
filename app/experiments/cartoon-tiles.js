/* ==========================================================================
 * 🎨  AI CARTOON (fal.ai, prompt-based) — throwaway EXPERIMENT (safe to delete)
 * --------------------------------------------------------------------------
 * v2: FULL SCREEN AT ONCE. Captures all visible map tiles into one canvas and
 * sends ONE image-to-image request per view to fal.ai fast-sdxl with the
 * prompt below (v1 stylized each tile separately -> seams + $ per tile).
 * ~$0.005–0.01 per new view; results cached in IndexedDB per view+style.
 *
 * ⚠️  Experiment only:
 *   - fal API key lives in the BROWSER (localStorage) — local experiments only.
 *   - Off by default; nothing runs until you click 🎨 and paste a key.
 *
 * TO REMOVE THIS EXPERIMENT ENTIRELY:
 *   1. delete this file (app/experiments/cartoon-tiles.js)
 *   2. delete the marked <script> for it in app/index.html
 *   (No other file references it. It only uses window.cbbMap.)
 * ========================================================================== */
(function () {
    'use strict';

    var CONFIG = {
        endpoint: 'https://fal.run/fal-ai/fast-sdxl/image-to-image',
        prompt:
            'highly stylized cartoon, drawn, bird\'s eye view of a city, cute 3D buildings with ' +
            'visible facades and roofs, fluffy trees, parks, no text. Very lively, saturated and colorful.',
        negative_prompt: 'text, labels, letters, numbers, watermark, photo, photorealistic, blurry, noise',
        strength: 0.65, // higher = more creative liberty (3D-ification) but less map-accurate
        steps: 8,
        guidance_scale: 3,
        sendMaxSide: 1024, // downscale the captured screen before sending (SDXL native)
        styleId: 'fal-fullscreen-lively3d-v2', // bump to invalidate cached views
        cacheName: 'cartoon-tiles',
    };

    var active = false,
        canvas = null,
        ctx2d = null,
        pane = null,
        srcCanvas = null,
        imgCache = {},
        busyNow = false,
        rerenderQueued = false,
        disabledDueToError = false,
        btn = null;

    function map() {
        return window.cbbMap;
    }
    function getKey() {
        return localStorage.getItem('cartoonTilesFalKey') || '';
    }
    function setBusy(b) {
        if (btn) btn.textContent = b ? '⏳' : '🎨';
    }
    var noteT;
    function notify(msg) {
        // non-blocking notice via the app's #toast element (alert() freezes the page)
        console.warn('[cartoon-ai]', msg);
        var t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(noteT);
        noteT = setTimeout(function () {
            t.classList.remove('show');
        }, 5000);
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
    function clearCache() {
        return db().then(function (d) {
            d.transaction('tiles', 'readwrite').objectStore('tiles').clear();
        });
    }

    // ---- capture visible tiles into one canvas ---------------------------
    function baseLayer() {
        var found = null;
        map().eachLayer(function (l) {
            if (l instanceof L.TileLayer) found = l;
        });
        return found;
    }
    function loadImg(src) {
        if (imgCache[src]) return imgCache[src];
        imgCache[src] = new Promise(function (res, rej) {
            var im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = function () {
                res(im);
            };
            im.onerror = rej;
            im.src = src;
        });
        return imgCache[src];
    }
    function capture() {
        var m = map(),
            layer = baseLayer();
        if (!layer) return Promise.reject(new Error('no tile layer'));
        var size = m.getSize();
        if (!srcCanvas) srcCanvas = document.createElement('canvas');
        srcCanvas.width = size.x;
        srcCanvas.height = size.y;
        var ctx = srcCanvas.getContext('2d');
        ctx.fillStyle = '#eef1f4';
        ctx.fillRect(0, 0, size.x, size.y);
        var cRect = m.getContainer().getBoundingClientRect();
        var jobs = [];
        Object.keys(layer._tiles).forEach(function (k) {
            var t = layer._tiles[k];
            if (!t.current || !t.loaded || !t.el || !t.el.src) return;
            var r = t.el.getBoundingClientRect();
            jobs.push(
                loadImg(t.el.src)
                    .then(function (im) {
                        ctx.drawImage(im, r.left - cRect.left, r.top - cRect.top, r.width, r.height);
                    })
                    .catch(function () {})
            );
        });
        return Promise.all(jobs).then(function () {
            return srcCanvas;
        });
    }

    // ---- fal request per view ---------------------------------------------
    function viewKey() {
        var m = map(),
            c = m.getCenter(),
            s = m.getSize();
        return [
            CONFIG.styleId,
            CONFIG.strength,
            m.getZoom(),
            c.lat.toFixed(4),
            c.lng.toFixed(4),
            s.x + 'x' + s.y,
        ].join('|');
    }
    function stylizeView(source) {
        var key = viewKey();
        return cacheGet(key).then(function (hit) {
            if (hit) return hit;
            if (disabledDueToError) return Promise.reject(new Error('disabled'));
            var apiKey = getKey();
            if (!apiKey) return Promise.reject(new Error('no-key'));
            // downscale for SDXL
            var scale = Math.min(1, CONFIG.sendMaxSide / Math.max(source.width, source.height));
            var w = Math.round(source.width * scale),
                h = Math.round(source.height * scale);
            var tmp = document.createElement('canvas');
            tmp.width = w;
            tmp.height = h;
            tmp.getContext('2d').drawImage(source, 0, 0, w, h);
            var dataUri = tmp.toDataURL('image/jpeg', 0.92);
            return fetch(CONFIG.endpoint, {
                method: 'POST',
                headers: { Authorization: 'Key ' + getKey(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_url: dataUri,
                    prompt: CONFIG.prompt,
                    negative_prompt: CONFIG.negative_prompt,
                    strength: CONFIG.strength,
                    num_inference_steps: CONFIG.steps,
                    guidance_scale: CONFIG.guidance_scale,
                    enable_safety_checker: false,
                    sync_mode: true,
                }),
            })
                .then(function (r) {
                    if (r.status === 401 || r.status === 403) {
                        disabledDueToError = true;
                        notify('AI cartoon: fal API key rejected. Disabling experiment.');
                        throw new Error('auth');
                    }
                    if (!r.ok)
                        return r.text().then(function (t) {
                            throw new Error('http ' + r.status + ' ' + t.slice(0, 120));
                        });
                    return r.json();
                })
                .then(function (j) {
                    var uri = j && j.images && j.images[0] && j.images[0].url;
                    if (!uri) throw new Error('no image in response');
                    cachePut(key, uri);
                    return uri;
                });
        });
    }

    // ---- render -------------------------------------------------------------
    function render() {
        if (!active) return;
        if (busyNow) {
            rerenderQueued = true;
            return;
        }
        busyNow = true;
        setBusy(true);
        capture()
            .then(function (source) {
                return stylizeView(source).then(function (uri) {
                    return loadImg(uri).then(function (im) {
                        if (!active) return;
                        var size = map().getSize();
                        canvas.width = size.x;
                        canvas.height = size.y;
                        canvas.style.width = size.x + 'px';
                        canvas.style.height = size.y + 'px';
                        L.DomUtil.setPosition(canvas, map().containerPointToLayerPoint([0, 0]));
                        ctx2d.imageSmoothingEnabled = true;
                        ctx2d.drawImage(im, 0, 0, size.x, size.y);
                        canvas.style.display = '';
                    });
                });
            })
            .catch(function (e) {
                console.warn('[cartoon-ai]', e);
                if (String(e && e.message) !== 'no-key') {
                    disable();
                    if (!disabledDueToError) notify('AI cartoon failed: ' + (e && e.message ? e.message : e));
                }
            })
            .finally(function () {
                busyNow = false;
                setBusy(false);
                if (rerenderQueued) {
                    rerenderQueued = false;
                    render();
                }
            });
    }
    function hide() {
        if (canvas) canvas.style.display = 'none';
    }

    // ---- enable / disable ----------------------------------------------------
    function enable() {
        if (active || !map()) return;
        // don't stack with the local-model experiment
        if (window.CartoonScreen && typeof window.CartoonScreen.disable === 'function') window.CartoonScreen.disable();
        active = true;
        if (!pane) {
            pane = map().createPane('cartoonAiPane');
            pane.style.zIndex = 251; // above tiles (200), below routes (400)
            pane.style.pointerEvents = 'none';
        }
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.style.position = 'absolute';
            pane.appendChild(canvas);
            ctx2d = canvas.getContext('2d');
        }
        // ONE-SHOT: one image per click for the current view (each render costs $).
        // Panning drags the image along; zooming dismisses; click again to dismiss.
        map().on('zoomstart', disable);
        render();
    }
    function disable() {
        if (!active) return;
        active = false;
        map().off('zoomstart', disable);
        hide();
        if (btn) btn.style.background = '#fff';
        setBusy(false);
    }

    // ---- on-screen toggle -------------------------------------------------
    function injectButton() {
        btn = document.createElement('button');
        btn.id = 'cartoonToggle';
        btn.type = 'button';
        btn.textContent = '🎨';
        btn.title = 'AI cartoon via fal.ai — one request per view (experiment)';
        btn.style.cssText =
            'position:absolute;left:14px;bottom:calc(28px + env(safe-area-inset-bottom,0px));z-index:1000;' +
            'width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:0 6px 24px rgba(20,30,25,.18);' +
            'font-size:20px;line-height:44px;text-align:center;cursor:pointer;border:none;';
        btn.addEventListener('click', function () {
            if (active) {
                disable();
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
        else setTimeout(boot, 200);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    // console API: CartoonTiles.enable()/disable()/clearCache(); tweak CartoonTiles.CONFIG
    // (change prompt/strength -> also bump CONFIG.styleId to bypass cached views)
    window.CartoonTiles = { enable: enable, disable: disable, clearCache: clearCache, CONFIG: CONFIG };
})();
