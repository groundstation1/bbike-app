/* ==========================================================================
 * 🖌️  AI CARTOON SCREEN — throwaway EXPERIMENT (safe to delete)
 * --------------------------------------------------------------------------
 * LOCAL neural cartoonizer, no API, $0: captures all visible map tiles into
 * one canvas ("full screen at once", so no tile seams) and runs AnimeGANv2
 * (Hayao / Miyazaki-scenery style, 8.6 MB ONNX) in the browser via
 * ONNX Runtime Web — WebGPU if available, WASM fallback.
 *
 * First enable downloads the model once (~8.6 MB, cached via Cache API).
 * Re-renders after each pan/zoom; the raw map shows while moving.
 *
 * TO REMOVE THIS EXPERIMENT ENTIRELY:
 *   1. delete this file (app/experiments/cartoon-screen.js)
 *   2. delete the marked <script> for it in app/index.html
 *   (No other file references it. It only uses window.cbbMap.)
 * ========================================================================== */
(function () {
    'use strict';

    var CONFIG = {
        ortUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js',
        ortWasmDir: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/',
        // AnimeGANv2 "Hayao" scenery model (verified reachable + CORS ok)
        modelUrl: 'https://huggingface.co/vumichien/AnimeGANv2_Hayao/resolve/main/AnimeGANv2_Hayao.onnx',
        maxSide: 512, // inference resolution (rounded to /32). Raise to 736+ on fast GPUs
        cacheName: 'cartoon-model-v1',
    };

    var active = false,
        canvas = null,
        ctx2d = null,
        pane = null,
        session = null,
        layoutNCHW = null, // learned at first run
        srcCanvas = null,
        imgCache = {},
        busyNow = false,
        rerenderQueued = false,
        btn = null;

    function map() {
        return window.cbbMap;
    }
    function setBusy(b) {
        if (btn) btn.textContent = b ? '⏳' : '🖌️';
    }

    // ---------- load ONNX Runtime (once, from CDN) --------------------------
    var ortP = null;
    function loadOrt() {
        if (ortP) return ortP;
        ortP = new Promise(function (res, rej) {
            if (window.ort) return res(window.ort);
            var s = document.createElement('script');
            s.src = CONFIG.ortUrl;
            s.onload = function () {
                window.ort.env.wasm.wasmPaths = CONFIG.ortWasmDir;
                res(window.ort);
            };
            s.onerror = function () {
                rej(new Error('failed to load onnxruntime-web'));
            };
            document.head.appendChild(s);
        });
        return ortP;
    }

    // ---------- model bytes (Cache API so the 8.6MB downloads once) --------
    function getModelBytes() {
        var fetchFresh = function () {
            return fetch(CONFIG.modelUrl).then(function (r) {
                if (!r.ok) throw new Error('model download http ' + r.status);
                return r;
            });
        };
        if (!window.caches) return fetchFresh().then(function (r) { return r.arrayBuffer(); });
        return caches.open(CONFIG.cacheName).then(function (c) {
            return c.match(CONFIG.modelUrl).then(function (hit) {
                if (hit) return hit.arrayBuffer();
                return fetchFresh().then(function (r) {
                    return c.put(CONFIG.modelUrl, r.clone()).then(function () {
                        return r.arrayBuffer();
                    });
                });
            });
        });
    }

    function getSession() {
        if (session) return Promise.resolve(session);
        return loadOrt().then(function (ort) {
            return getModelBytes().then(function (bytes) {
                // try WebGPU first, fall back to WASM
                return ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] })
                    .catch(function () {
                        return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
                    })
                    .then(function (s) {
                        session = s;
                        return s;
                    });
            });
        });
    }

    // ---------- capture visible tiles into one canvas ----------------------
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
            im.crossOrigin = 'anonymous'; // CyclOSM sends ACAO:* (verified)
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

    // ---------- neural inference -------------------------------------------
    function round32(v) {
        return Math.max(32, Math.round(v / 32) * 32);
    }
    function toTensorNHWC(d, w, h) {
        var f = new Float32Array(w * h * 3);
        for (var i = 0, p = 0; i < w * h; i++) {
            f[p++] = d[i * 4] / 127.5 - 1;
            f[p++] = d[i * 4 + 1] / 127.5 - 1;
            f[p++] = d[i * 4 + 2] / 127.5 - 1;
        }
        return new window.ort.Tensor('float32', f, [1, h, w, 3]);
    }
    function toTensorNCHW(d, w, h) {
        var n = w * h,
            f = new Float32Array(n * 3);
        for (var i = 0; i < n; i++) {
            f[i] = d[i * 4] / 127.5 - 1;
            f[n + i] = d[i * 4 + 1] / 127.5 - 1;
            f[2 * n + i] = d[i * 4 + 2] / 127.5 - 1;
        }
        return new window.ort.Tensor('float32', f, [1, 3, h, w]);
    }
    function runModel(imageData, w, h) {
        return getSession().then(function (s) {
            var inName = s.inputNames[0],
                outName = s.outputNames[0];
            var attempt = function (nchw) {
                var feeds = {};
                feeds[inName] = nchw ? toTensorNCHW(imageData.data, w, h) : toTensorNHWC(imageData.data, w, h);
                return s.run(feeds).then(function (out) {
                    layoutNCHW = nchw;
                    return out[outName];
                });
            };
            if (layoutNCHW === null) {
                return attempt(false).catch(function () {
                    return attempt(true);
                });
            }
            return attempt(layoutNCHW);
        });
    }
    function tensorToCanvas(t) {
        var dims = t.dims,
            nchw = dims[1] === 3,
            h = nchw ? dims[2] : dims[1],
            w = nchw ? dims[3] : dims[2],
            data = t.data,
            n = w * h;
        var out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        var octx = out.getContext('2d');
        var img = octx.createImageData(w, h);
        for (var i = 0; i < n; i++) {
            var r, g, b;
            if (nchw) {
                r = data[i];
                g = data[n + i];
                b = data[2 * n + i];
            } else {
                r = data[i * 3];
                g = data[i * 3 + 1];
                b = data[i * 3 + 2];
            }
            img.data[i * 4] = Math.max(0, Math.min(255, (r + 1) * 127.5));
            img.data[i * 4 + 1] = Math.max(0, Math.min(255, (g + 1) * 127.5));
            img.data[i * 4 + 2] = Math.max(0, Math.min(255, (b + 1) * 127.5));
            img.data[i * 4 + 3] = 255;
        }
        octx.putImageData(img, 0, 0);
        return out;
    }

    // ---------- render -------------------------------------------------------
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
                var scale = Math.min(1, CONFIG.maxSide / Math.max(source.width, source.height));
                var w = round32(source.width * scale),
                    h = round32(source.height * scale);
                var tmp = document.createElement('canvas');
                tmp.width = w;
                tmp.height = h;
                var tctx = tmp.getContext('2d');
                tctx.drawImage(source, 0, 0, w, h);
                var imageData = tctx.getImageData(0, 0, w, h);
                return runModel(imageData, w, h).then(function (outTensor) {
                    if (!active) return;
                    var styled = tensorToCanvas(outTensor);
                    var size = map().getSize();
                    canvas.width = size.x;
                    canvas.height = size.y;
                    canvas.style.width = size.x + 'px';
                    canvas.style.height = size.y + 'px';
                    L.DomUtil.setPosition(canvas, map().containerPointToLayerPoint([0, 0]));
                    ctx2d.imageSmoothingEnabled = true;
                    ctx2d.imageSmoothingQuality = 'high';
                    ctx2d.drawImage(styled, 0, 0, size.x, size.y);
                    canvas.style.display = '';
                });
            })
            .catch(function (e) {
                console.warn('[cartoon-screen]', e);
                disable();
                alert('AI cartoon failed (' + (e && e.message ? e.message : e) + ') — disabled.');
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

    // ---------- enable / disable --------------------------------------------
    function enable() {
        if (active || !map()) return;
        active = true;
        if (!pane) {
            pane = map().createPane('cartoonPane');
            pane.style.zIndex = 250; // above tiles (200), below routes (400) & markers (600)
            pane.style.pointerEvents = 'none';
        }
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.style.position = 'absolute';
            pane.appendChild(canvas);
            ctx2d = canvas.getContext('2d');
        }
        map().on('movestart zoomstart', hide);
        map().on('moveend zoomend resize', render);
        render();
    }
    function disable() {
        if (!active) return;
        active = false;
        map().off('movestart zoomstart', hide);
        map().off('moveend zoomend resize', render);
        hide();
        if (btn) btn.style.background = '#fff';
        setBusy(false);
    }

    // ---------- on-screen toggle ----------------------------------------------
    function injectButton() {
        btn = document.createElement('button');
        btn.id = 'cartoonScreenToggle';
        btn.type = 'button';
        btn.textContent = '🖌️';
        btn.title = 'AI cartoon — local neural model, free (experiment). First use downloads ~9 MB.';
        btn.style.cssText =
            'position:absolute;left:14px;bottom:calc(82px + env(safe-area-inset-bottom,0px));z-index:1000;' +
            'width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:0 6px 24px rgba(20,30,25,.18);' +
            'font-size:19px;line-height:44px;text-align:center;cursor:pointer;border:none;';
        btn.addEventListener('click', function () {
            if (active) {
                disable();
            } else {
                enable();
                btn.style.background = '#ffe082';
            }
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

    // console API: CartoonScreen.enable()/disable()/rerender(), tweak CONFIG.maxSide
    window.CartoonScreen = { enable: enable, disable: disable, rerender: render, CONFIG: CONFIG };
})();
