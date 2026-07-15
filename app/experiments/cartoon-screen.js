/* ==========================================================================
 * 🖌️  LOCAL SD-TURBO CARTOON — throwaway EXPERIMENT (safe to delete)
 * --------------------------------------------------------------------------
 * Full Stable Diffusion (SD-Turbo, ~2.4 GB one-time download, cached in
 * IndexedDB) running LOCALLY via ONNX Runtime Web + WebGPU. Captures all
 * visible map tiles into one canvas and img2img-stylizes the full screen in
 * ONE diffusion step with the prompt below. $0 per view, no seams.
 *
 * ONE-SHOT UX: click 🖌️ = render one image for the current view; click again
 * = dismiss. Panning drags the image along (it lives in the map pane); zooming
 * dismisses it. No automatic re-rendering.
 *
 * Requirements: WebGPU + shader-f16 (desktop Chrome/Edge, recent GPU).
 * Based on Microsoft's onnxruntime-web sd-turbo demo (MIT), extended with a
 * VAE-encoder img2img path and fp16 tensor IO.
 *
 * TO REMOVE THIS EXPERIMENT ENTIRELY:
 *   1. delete this file (app/experiments/cartoon-screen.js)
 *   2. delete the marked <script> for it in app/index.html
 * ========================================================================== */
(function () {
    'use strict';

    var CONFIG = {
        // 1.22: JSEP fp16 kernel coverage (1.19 lacked fp16 Clip -> vae_decoder failed)
        ortUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.webgpu.min.js',
        ortWasmDir: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
        transformersUrl: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
        modelBase: 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main',
        prompt:
            'highly stylized cartoon, drawn, bird\'s eye view of a city, cute 3D buildings with ' +
            'visible facades and roofs, fluffy trees, parks, no text. Very lively, saturated and colorful.',
        strength: 0.55, // 0..1 — higher = more stylization/invention, less map fidelity
        size: 512,
        dbName: 'sd-turbo-models',
    };

    var FILES = {
        text_encoder: { url: 'text_encoder/model.onnx', mb: 650 },
        unet: { url: 'unet/model.onnx', mb: 1653 },
        vae_encoder: { url: 'vae_encoder/model.onnx', mb: 65 },
        vae_decoder: { url: 'vae_decoder/model.onnx', mb: 95 },
    };

    var VAE_SF = 0.18215;

    var active = false,
        canvas = null,
        ctx2d = null,
        pane = null,
        sessions = null,
        tokenizer = null,
        textEmbeds = null,
        embedsPrompt = null,
        alphasCum = null,
        srcCanvas = null,
        imgCache = {},
        busyNow = false,
        loadingP = null,
        btn = null;

    function map() {
        return window.cbbMap;
    }
    function setBtn(t) {
        if (btn) btn.textContent = t;
    }
    var noteT;
    function notify(msg) {
        // non-blocking notice via the app's #toast element (alert() freezes the page)
        console.warn('[sd-turbo]', msg);
        var t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(noteT);
        noteT = setTimeout(function () {
            t.classList.remove('show');
        }, 5000);
    }

    // ---------- fp16 <-> fp32 ------------------------------------------------
    var f32buf = new Float32Array(1),
        u32buf = new Uint32Array(f32buf.buffer);
    function f32tof16(val) {
        f32buf[0] = val;
        var x = u32buf[0];
        var sign = (x >> 16) & 0x8000;
        var exp = ((x >> 23) & 0xff) - 127 + 15;
        var frac = x & 0x7fffff;
        if (exp <= 0) return sign; // flush to zero
        if (exp >= 31) return sign | 0x7bff; // clamp to max
        return sign | (exp << 10) | (frac >> 13);
    }
    function f32ArrayToF16(a) {
        var out = new Uint16Array(a.length);
        for (var i = 0; i < a.length; i++) out[i] = f32tof16(a[i]);
        return out;
    }
    function f16tof32(h) {
        var sign = (h & 0x8000) >> 15,
            exp = (h & 0x7c00) >> 10,
            frac = h & 0x03ff;
        var v;
        if (exp === 0) v = frac * Math.pow(2, -24);
        else if (exp === 31) v = frac ? NaN : Infinity;
        else v = (1 + frac / 1024) * Math.pow(2, exp - 15);
        return sign ? -v : v;
    }
    var HAS_F16ARR = typeof Float16Array !== 'undefined';
    function dataToF32(t) {
        if (t.type === 'float16') {
            var d = t.data;
            // native Float16Array (Chrome 135+): elements are already numbers
            if (HAS_F16ARR && d instanceof Float16Array) return Float32Array.from(d);
            var out = new Float32Array(d.length);
            for (var i = 0; i < d.length; i++) out[i] = f16tof32(d[i]);
            return out;
        }
        return t.data;
    }
    function floatTensor(ort, useF16, f32data, dims) {
        if (!useF16) return new ort.Tensor('float32', f32data, dims);
        // ort-web requires native Float16Array for float16 tensors when available
        if (HAS_F16ARR) return new ort.Tensor('float16', Float16Array.from(f32data), dims);
        return new ort.Tensor('float16', f32ArrayToF16(f32data), dims);
    }

    // ---------- runtime deps -------------------------------------------------
    var ortP = null;
    function loadOrt() {
        if (ortP) return ortP;
        ortP = new Promise(function (res, rej) {
            if (window.ort && window.ort.env) return res(window.ort);
            var s = document.createElement('script');
            s.src = CONFIG.ortUrl;
            s.onload = function () {
                window.ort.env.wasm.wasmPaths = CONFIG.ortWasmDir;
                window.ort.env.wasm.numThreads = 1;
                res(window.ort);
            };
            s.onerror = function () {
                rej(new Error('failed to load onnxruntime-web'));
            };
            document.head.appendChild(s);
        });
        return ortP;
    }
    function loadTokenizer() {
        if (tokenizer) return Promise.resolve(tokenizer);
        return import(CONFIG.transformersUrl).then(function (T) {
            T.env.allowLocalModels = false;
            return T.AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16').then(function (tk) {
                tk.pad_token_id = 0;
                tokenizer = tk;
                return tk;
            });
        });
    }
    function hasFp16() {
        if (!navigator.gpu) return Promise.resolve(false);
        return navigator.gpu
            .requestAdapter()
            .then(function (a) {
                return !!(a && a.features.has('shader-f16'));
            })
            .catch(function () {
                return false;
            });
    }

    // ---------- IndexedDB blob store (handles the 1.6GB unet fine) ----------
    var dbP = null;
    function db() {
        if (dbP) return dbP;
        dbP = new Promise(function (res, rej) {
            var r = indexedDB.open(CONFIG.dbName, 1);
            r.onupgradeneeded = function () {
                r.result.createObjectStore('files');
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
    function idbGet(key) {
        return db().then(function (d) {
            return new Promise(function (res) {
                var q = d.transaction('files').objectStore('files').get(key);
                q.onsuccess = function () {
                    res(q.result || null);
                };
                q.onerror = function () {
                    res(null);
                };
            });
        });
    }
    function idbPut(key, blob) {
        return db().then(function (d) {
            return new Promise(function (res) {
                var tx = d.transaction('files', 'readwrite');
                tx.objectStore('files').put(blob, key);
                tx.oncomplete = function () {
                    res(true);
                };
                tx.onerror = function () {
                    res(false);
                };
                tx.onabort = function () {
                    res(false);
                };
            });
        });
    }

    function fetchModel(path, mb) {
        var url = CONFIG.modelBase + '/' + path;
        function download() {
            return fetch(url).then(function (r) {
                if (!r.ok) throw new Error(path + ' http ' + r.status);
                var total = +r.headers.get('Content-Length') || 0;
                var estimate = total || mb * 1048576;
                // stream into a preallocated buffer — avoids building a giant Blob
                // and reading it back (Chromium NotReadableError on ~GB blobs)
                var buf = new Uint8Array(total || estimate);
                var got = 0;
                var reader = r.body.getReader();
                function pump() {
                    return reader.read().then(function (res) {
                        if (res.done) return;
                        if (got + res.value.length > buf.length) {
                            var bigger = new Uint8Array(Math.max(buf.length * 2, got + res.value.length));
                            bigger.set(buf.subarray(0, got));
                            buf = bigger;
                        }
                        buf.set(res.value, got);
                        got += res.value.length;
                        setBtn(Math.round((got / estimate) * 100) + '%');
                        return pump();
                    });
                }
                return pump().then(function () {
                    var bytes = got === buf.length ? buf : buf.subarray(0, got);
                    // persist for next session (best-effort; failure only means re-download)
                    return idbPut(url, new Blob([bytes])).then(function (ok) {
                        if (!ok) console.warn('[sd-turbo] idb store failed for', path);
                        return bytes;
                    });
                });
            });
        }
        return idbGet(url).then(function (blob) {
            if (!blob) return download();
            return blob
                .arrayBuffer()
                .then(function (ab) {
                    return new Uint8Array(ab);
                })
                .catch(function (e) {
                    console.warn('[sd-turbo] cached blob unreadable, re-downloading', path, e);
                    return download();
                });
        });
    }

    // ---------- sessions ------------------------------------------------------
    function sessOpts(extraDims, prefOut) {
        var o = {
            executionProviders: ['webgpu'],
            enableMemPattern: false,
            enableCpuMemArena: false,
            extra: {
                session: {
                    disable_prepacking: '1',
                    use_device_allocator_for_initializers: '1',
                    use_ort_model_bytes_directly: '1',
                    use_ort_model_bytes_for_initializers: '1',
                },
            },
        };
        if (extraDims) o.freeDimensionOverrides = extraDims;
        if (prefOut) o.preferredOutputLocation = prefOut;
        return o;
    }
    function loadSessions() {
        if (sessions) return Promise.resolve(sessions);
        if (loadingP) return loadingP;
        loadingP = loadOrt().then(function (ort) {
            return hasFp16().then(function (ok) {
                if (!ok) throw new Error('This GPU/browser lacks WebGPU shader-f16 (needed for SD-Turbo)');
                var s = {};
                return fetchModel(FILES.text_encoder.url, FILES.text_encoder.mb)
                    .then(function (b) {
                        return ort.InferenceSession.create(
                            b,
                            sessOpts({ batch_size: 1 }, { last_hidden_state: 'gpu-buffer' })
                        );
                    })
                    .then(function (x) {
                        s.text_encoder = x;
                        return fetchModel(FILES.unet.url, FILES.unet.mb);
                    })
                    .then(function (b) {
                        return ort.InferenceSession.create(
                            b,
                            sessOpts({ batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 })
                        );
                    })
                    .then(function (x) {
                        s.unet = x;
                        return fetchModel(FILES.vae_encoder.url, FILES.vae_encoder.mb);
                    })
                    .then(function (b) {
                        return ort.InferenceSession.create(
                            b,
                            sessOpts({ batch_size: 1, num_channels: 3, height: 512, width: 512 })
                        ).catch(function () {
                            return ort.InferenceSession.create(b, sessOpts(null));
                        });
                    })
                    .then(function (x) {
                        s.vae_encoder = x;
                        return fetchModel(FILES.vae_decoder.url, FILES.vae_decoder.mb);
                    })
                    .then(function (b) {
                        return ort.InferenceSession.create(
                            b,
                            sessOpts({ batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 })
                        );
                    })
                    .then(function (x) {
                        s.vae_decoder = x;
                        sessions = s;
                        setBtn('🖌️');
                        return s;
                    });
            });
        });
        loadingP.catch(function () {
            loadingP = null;
        });
        return loadingP;
    }

    // run with automatic f32 -> f16 retry (models here have fp16 tensor IO)
    function runAdaptive(sess, buildFeeds) {
        var tryF16 = sess.__f16 === true;
        var attempt = function (useF16) {
            return Promise.resolve(buildFeeds(useF16)).then(function (feeds) {
                return sess.run(feeds).then(function (out) {
                    sess.__f16 = useF16;
                    return out;
                });
            });
        };
        if (sess.__f16 !== undefined) return attempt(tryF16);
        return attempt(false).catch(function (e) {
            if (/float16/i.test(String(e && e.message))) return attempt(true);
            throw e;
        });
    }

    // ---------- diffusion math ------------------------------------------------
    function alphas() {
        if (alphasCum) return alphasCum;
        var n = 1000,
            b0 = Math.sqrt(0.00085),
            b1 = Math.sqrt(0.012),
            prod = 1;
        alphasCum = new Float64Array(n);
        for (var t = 0; t < n; t++) {
            var beta = Math.pow(b0 + (t / (n - 1)) * (b1 - b0), 2);
            prod *= 1 - beta;
            alphasCum[t] = prod;
        }
        return alphasCum;
    }
    function sigmaFor(t) {
        var a = alphas()[t];
        return Math.sqrt((1 - a) / a);
    }
    function randn() {
        var u = Math.random() || 1e-9,
            v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    function textEmbedsFor(prompt) {
        if (textEmbeds && embedsPrompt === prompt) return Promise.resolve(textEmbeds);
        return loadTokenizer().then(function (tk) {
            return Promise.resolve(
                tk(prompt, { padding: true, max_length: 77, truncation: true, return_tensor: false })
            ).then(function (enc) {
                var ids = enc.input_ids;
                return sessions.text_encoder
                    .run({ input_ids: new window.ort.Tensor('int32', Int32Array.from(ids), [1, ids.length]) })
                    .then(function (out) {
                        if (textEmbeds && textEmbeds.dispose) textEmbeds.dispose();
                        textEmbeds = out.last_hidden_state;
                        embedsPrompt = prompt;
                        return textEmbeds;
                    });
            });
        });
    }

    // img2img: encode -> noise at strength timestep -> 1 unet step -> decode
    function stylize(imageData) {
        var ort = window.ort,
            N = CONFIG.size,
            n = N * N;
        var f = new Float32Array(3 * n);
        for (var i = 0; i < n; i++) {
            f[i] = (imageData.data[i * 4] / 255) * 2 - 1;
            f[n + i] = (imageData.data[i * 4 + 1] / 255) * 2 - 1;
            f[2 * n + i] = (imageData.data[i * 4 + 2] / 255) * 2 - 1;
        }
        return textEmbedsFor(CONFIG.prompt).then(function (embeds) {
            return runAdaptive(sessions.vae_encoder, function (useF16) {
                return { sample: floatTensor(ort, useF16, f, [1, 3, N, N]) };
            }).then(function (encOut) {
                var latents = dataToF32(encOut[sessions.vae_encoder.outputNames[0]]);
                var t = Math.max(1, Math.min(999, Math.round(999 * CONFIG.strength)));
                var sig = sigmaFor(t);
                var L = latents.length;
                var noisy = new Float32Array(L),
                    scaled = new Float32Array(L);
                var divi = Math.sqrt(sig * sig + 1);
                for (var i2 = 0; i2 < L; i2++) {
                    noisy[i2] = latents[i2] * VAE_SF + sig * randn();
                    scaled[i2] = noisy[i2] / divi;
                }
                var dims = [1, 4, 64, 64];
                return runAdaptive(sessions.unet, function (useF16) {
                    return {
                        sample: floatTensor(ort, useF16, scaled, dims),
                        timestep: new ort.Tensor('int64', [BigInt(t)], [1]),
                        encoder_hidden_states: embeds,
                    };
                })
                    .then(function (unetOut) {
                        var eps = dataToF32(unetOut.out_sample);
                        var dec = new Float32Array(L);
                        for (var i3 = 0; i3 < L; i3++) {
                            dec[i3] = (noisy[i3] - sig * eps[i3]) / VAE_SF; // 1-step EulerA to x0
                        }
                        return runAdaptive(sessions.vae_decoder, function (useF16) {
                            return { latent_sample: floatTensor(ort, useF16, dec, dims) };
                        });
                    })
                    .then(function (decOut) {
                        var px = dataToF32(decOut[sessions.vae_decoder.outputNames[0]]);
                        var out = document.createElement('canvas');
                        out.width = N;
                        out.height = N;
                        var octx = out.getContext('2d');
                        var img = octx.createImageData(N, N);
                        for (var i4 = 0; i4 < n; i4++) {
                            img.data[i4 * 4] = Math.max(0, Math.min(255, (px[i4] / 2 + 0.5) * 255));
                            img.data[i4 * 4 + 1] = Math.max(0, Math.min(255, (px[n + i4] / 2 + 0.5) * 255));
                            img.data[i4 * 4 + 2] = Math.max(0, Math.min(255, (px[2 * n + i4] / 2 + 0.5) * 255));
                            img.data[i4 * 4 + 3] = 255;
                        }
                        octx.putImageData(img, 0, 0);
                        return out;
                    });
            });
        });
    }

    // ---------- capture visible tiles into one canvas -------------------------
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

    // ---------- one-shot render -----------------------------------------------
    function render() {
        if (!active || busyNow) return;
        busyNow = true;
        setBtn('⏳');
        loadSessions()
            .then(function () {
                return capture();
            })
            .then(function (source) {
                var N = CONFIG.size;
                var tmp = document.createElement('canvas');
                tmp.width = N;
                tmp.height = N;
                var tctx = tmp.getContext('2d');
                tctx.drawImage(source, 0, 0, N, N);
                return stylize(tctx.getImageData(0, 0, N, N));
            })
            .then(function (styled) {
                if (!active) return;
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
            })
            .catch(function (e) {
                console.warn('[sd-turbo]', e);
                disable();
                notify('Local SD-Turbo failed: ' + (e && e.message ? e.message : e));
            })
            .finally(function () {
                busyNow = false;
                setBtn('🖌️');
            });
    }
    function hide() {
        if (canvas) canvas.style.display = 'none';
    }

    // ---------- enable / disable (one-shot semantics) --------------------------
    function enable() {
        if (active || !map()) return;
        if (window.CartoonTiles && typeof window.CartoonTiles.disable === 'function') window.CartoonTiles.disable();
        active = true;
        if (!pane) {
            pane = map().createPane('cartoonPane');
            pane.style.zIndex = 250;
            pane.style.pointerEvents = 'none';
        }
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.style.position = 'absolute';
            pane.appendChild(canvas);
            ctx2d = canvas.getContext('2d');
        }
        // ONE-SHOT: single render for the current view. Pan drags the image along;
        // zoom dismisses (scale mismatch); click again to dismiss.
        map().on('zoomstart', disable);
        render();
    }
    function disable() {
        if (!active) return;
        active = false;
        map().off('zoomstart', disable);
        hide();
        if (btn) btn.style.background = '#fff';
        setBtn('🖌️');
    }

    // ---------- on-screen toggle -------------------------------------------------
    function injectButton() {
        btn = document.createElement('button');
        btn.id = 'cartoonScreenToggle';
        btn.type = 'button';
        btn.textContent = '🖌️';
        btn.title = 'Local SD-Turbo cartoon — one image per click, free, needs WebGPU. First use downloads ~2.4 GB.';
        btn.style.cssText =
            'position:absolute;left:14px;bottom:calc(82px + env(safe-area-inset-bottom,0px));z-index:1000;' +
            'width:44px;height:44px;border-radius:50%;background:#fff;box-shadow:0 6px 24px rgba(20,30,25,.18);' +
            'font-size:13px;font-weight:700;line-height:44px;text-align:center;cursor:pointer;border:none;';
        btn.addEventListener('click', function () {
            if (active) {
                disable();
                return;
            }
            if (!sessions && !confirm('Local SD-Turbo: first use downloads ~2.4 GB (then cached). Continue?')) return;
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

    // console API: CartoonScreen.enable()/disable()/rerender(); CONFIG.prompt/strength
    window.CartoonScreen = { enable: enable, disable: disable, rerender: render, CONFIG: CONFIG };
})();
