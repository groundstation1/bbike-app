/*
 * Chaos Bike Berlin — lean mobile routing app.
 * Talks directly to the public brouter.de server using the bundled
 * chaos_bike_berlin profile (uploaded once as a temporary custom profile).
 */
(function () {
    'use strict';

    var CONFIG = {
        host: 'https://brouter.de',
        profileFile: 'profiles/chaos_bike_berlin.brf',
        photon: 'https://photon.komoot.io/api/',
        center: [52.52, 13.405],
        zoom: 12,
        tiles: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        tilesAttr:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ' +
            '<a href="https://www.cyclosm.org/">CyclOSM</a> · routing <a href="https://brouter.de">BRouter</a>',
    };

    var state = {
        rows: [], // { latlng, name, marker }
        customId: null,
        routeLayer: null,
        casingLayer: null,
        meMarker: null,
        routeReq: 0,
        altIdx: 0, // 0 = main route, 1..3 = alternatives
        surfaceSegments: null, // { groupName: [ [latlng,...], ... ] }
        hoverLayer: null,
    };

    var map, $stops, $sheet, busyEl;

    // ---------- helpers ----------
    function el(id) {
        return document.getElementById(id);
    }
    function fmtDist(m) {
        return m >= 1000 ? (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km' : Math.round(m) + ' m';
    }
    function fmtTime(s) {
        s = Math.round(s);
        var h = Math.floor(s / 3600),
            m = Math.round((s % 3600) / 60);
        return h > 0 ? h + ':' + String(m).padStart(2, '0') + ' h' : m + ' min';
    }
    var toastT;
    function toast(msg) {
        var t = el('toast');
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(toastT);
        toastT = setTimeout(function () {
            t.classList.remove('show');
        }, 3200);
    }
    function busy(on) {
        busyEl.classList.toggle('show', !!on);
    }
    function debounce(fn, ms) {
        var t;
        return function () {
            var a = arguments,
                self = this;
            clearTimeout(t);
            t = setTimeout(function () {
                fn.apply(self, a);
            }, ms);
        };
    }

    // ---------- map ----------
    function initMap() {
        map = L.map('map', { zoomControl: false, attributionControl: true }).setView(CONFIG.center, CONFIG.zoom);
        L.tileLayer(CONFIG.tiles, { maxZoom: 20, subdomains: 'abc', attribution: CONFIG.tilesAttr }).addTo(map);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        map.on('click', function (e) {
            addPointFromMap(e.latlng);
        });
        window.cbbMap = map; // handle for debugging / e2e checks
    }

    function wpColor(i, n) {
        if (i === 0) return '#2e7d32'; // start
        if (i === n - 1) return '#d63e2a'; // end
        return '#1e88e5'; // via
    }
    function wpIcon(label, color) {
        return L.divIcon({
            className: '',
            html: '<div class="wp-marker" style="background:' + color + '"><span>' + label + '</span></div>',
            iconSize: [26, 26],
            iconAnchor: [13, 26],
        });
    }

    function refreshMarkers() {
        var n = state.rows.length;
        state.rows.forEach(function (row, i) {
            if (!row.latlng) {
                if (row.marker) {
                    map.removeLayer(row.marker);
                    row.marker = null;
                }
                return;
            }
            var color = wpColor(i, n),
                label = i + 1;
            if (!row.marker) {
                row.marker = L.marker(row.latlng, {
                    icon: wpIcon(label, color),
                    draggable: true,
                }).addTo(map);
                row.marker.on('dragstart', function () {
                    row.marker._dragging = true;
                });
                row.marker.on('dragend', function () {
                    var ll = row.marker.getLatLng();
                    row.latlng = ll;
                    row.name = ll.lat.toFixed(5) + ', ' + ll.lng.toFixed(5);
                    var inp = row.dom && row.dom.input;
                    if (inp) inp.value = row.name;
                    // ignore the click Leaflet may emit right after a drag
                    setTimeout(function () {
                        row.marker._dragging = false;
                    }, 0);
                    route();
                });
                // tap a placed waypoint to delete it (marker clicks don't reach the map)
                row.marker.on('click', function () {
                    if (row.marker._dragging) return;
                    clearOrRemoveRow(state.rows.indexOf(row));
                });
            } else {
                row.marker.setLatLng(row.latlng);
                row.marker.setIcon(wpIcon(label, color));
            }
        });
    }

    // ---------- stop rows ----------
    function ensureMinRows() {
        while (state.rows.length < 2) state.rows.push({ latlng: null, name: '', marker: null });
    }

    var GRIP_SVG =
        '<svg viewBox="0 0 20 20" width="14" height="14"><g fill="currentColor">' +
        '<circle cx="7" cy="5" r="1.4"/><circle cx="13" cy="5" r="1.4"/>' +
        '<circle cx="7" cy="10" r="1.4"/><circle cx="13" cy="10" r="1.4"/>' +
        '<circle cx="7" cy="15" r="1.4"/><circle cx="13" cy="15" r="1.4"/></g></svg>';

    function placeholderFor(i, n) {
        return i === 0 ? 'Start — address, map tap or 📍' : i === n - 1 ? 'Destination' : 'Stop';
    }

    function buildRows() {
        ensureMinRows();
        $stops.innerHTML = '';
        var n = state.rows.length;
        state.rows.forEach(function (row, i) {
            var wrap = document.createElement('div');
            wrap.className = 'stop-row';

            var grip = document.createElement('div');
            grip.className = 'drag-handle';
            grip.title = 'Drag to reorder';
            grip.innerHTML = GRIP_SVG;

            var dot = document.createElement('div');
            dot.className = 'stop-dot';
            dot.style.background = wpColor(i, n);
            dot.textContent = i + 1;

            var input = document.createElement('input');
            input.className = 'stop-input';
            input.type = 'text';
            input.autocomplete = 'off';
            input.placeholder = placeholderFor(i, n);
            input.value = row.name || '';

            var act = document.createElement('button');
            act.className = 'stop-act';
            act.type = 'button';
            act.innerHTML =
                '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>';
            act.title = 'Clear / remove';

            var suggest = document.createElement('div');
            suggest.className = 'suggest';
            suggest.style.display = 'none';

            row.dom = { wrap: wrap, dot: dot, input: input, suggest: suggest };

            input.addEventListener(
                'input',
                debounce(function () {
                    geocode(input.value.trim(), row);
                }, 260)
            );
            input.addEventListener('focus', function () {
                if (input.value.trim().length >= 3) geocode(input.value.trim(), row);
            });
            input.addEventListener('blur', function () {
                setTimeout(function () {
                    suggest.style.display = 'none';
                }, 180);
            });
            act.addEventListener('click', function () {
                clearOrRemoveRow(state.rows.indexOf(row));
            });

            wrap.appendChild(grip);
            wrap.appendChild(dot);
            wrap.appendChild(input);
            wrap.appendChild(act);
            wrap.appendChild(suggest);
            $stops.appendChild(wrap);
        });

        // drag-and-drop reorder (touch + mouse), dragging only via the grip
        if (state.sortable) state.sortable.destroy();
        state.sortable = Sortable.create($stops, {
            handle: '.drag-handle',
            animation: 150,
            onEnd: function (evt) {
                if (evt.oldIndex === evt.newIndex) return;
                var item = state.rows.splice(evt.oldIndex, 1)[0];
                state.rows.splice(evt.newIndex, 0, item);
                refreshDecorations(); // Sortable already moved the DOM node; just re-label
                refreshMarkers();
                route();
            },
        });
    }

    // update dot numbers/colors + placeholders in place (after a drag reorder)
    function refreshDecorations() {
        var n = state.rows.length;
        state.rows.forEach(function (row, i) {
            if (!row.dom) return;
            row.dom.dot.style.background = wpColor(i, n);
            row.dom.dot.textContent = i + 1;
            row.dom.input.placeholder = placeholderFor(i, n);
        });
    }

    function clearOrRemoveRow(i) {
        var row = state.rows[i];
        if (row.marker) {
            map.removeLayer(row.marker);
            row.marker = null;
        }
        if (state.rows.length > 2) {
            state.rows.splice(i, 1);
        } else {
            row.latlng = null;
            row.name = '';
        }
        buildRows();
        refreshMarkers();
        route();
    }

    function setRow(i, latlng, name) {
        var row = state.rows[i];
        row.latlng = latlng;
        row.name = name;
        if (row.dom && row.dom.input) row.dom.input.value = name;
        refreshMarkers();
        route();
    }

    function firstEmptyIndex() {
        for (var i = 0; i < state.rows.length; i++) if (!state.rows[i].latlng) return i;
        return -1;
    }

    // "flight of the crow" cheapest insertion: index that adds the least
    // straight-line detour (keeps existing points in order). Returns 0..n.
    function bestInsertionIndex(P) {
        var pts = state.rows.map(function (r) {
            return r.latlng;
        });
        var n = pts.length;
        if (n < 2) return n;
        var best = n,
            bestCost = Infinity;
        for (var k = 0; k <= n; k++) {
            var cost;
            if (k === 0) cost = P.distanceTo(pts[0]);
            else if (k === n) cost = pts[n - 1].distanceTo(P);
            else cost = pts[k - 1].distanceTo(P) + P.distanceTo(pts[k]) - pts[k - 1].distanceTo(pts[k]);
            if (cost < bestCost) {
                bestCost = cost;
                best = k;
            }
        }
        return best;
    }

    function addPointFromMap(latlng) {
        var name = latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
        var i = firstEmptyIndex();
        if (i !== -1) {
            // fill the first empty slot (e.g. initial start/destination)
            setRow(i, latlng, name);
            return;
        }
        // all stops set -> insert where it best fits along the route
        i = bestInsertionIndex(latlng);
        state.rows.splice(i, 0, { latlng: null, name: '', marker: null });
        buildRows();
        setRow(i, latlng, name);
    }

    // ---------- geocoding (Photon) ----------
    function geocode(q, row) {
        var box = row.dom.suggest;
        if (q.length < 3) {
            box.style.display = 'none';
            return;
        }
        var c = map.getCenter();
        var url =
            CONFIG.photon +
            '?q=' +
            encodeURIComponent(q) +
            '&limit=6&lang=en&lat=' +
            c.lat.toFixed(4) +
            '&lon=' +
            c.lng.toFixed(4);
        fetch(url)
            .then(function (r) {
                return r.json();
            })
            .then(function (data) {
                renderSuggest(row, (data && data.features) || []);
            })
            .catch(function () {
                /* offline / network: ignore */
            });
    }

    function labelFor(p) {
        var main = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || p.city || 'Unnamed';
        var sub = [p.postcode, p.city, p.state, p.country].filter(Boolean).join(', ');
        return { main: main, sub: sub };
    }

    function renderSuggest(row, features) {
        var box = row.dom.suggest;
        box.innerHTML = '';
        if (!features.length) {
            box.style.display = 'none';
            return;
        }
        features.forEach(function (f) {
            var p = f.properties || {};
            var lab = labelFor(p);
            var item = document.createElement('div');
            item.className = 'suggest-item';
            item.innerHTML = '<div class="s-main"></div><div class="s-sub"></div>';
            item.querySelector('.s-main').textContent = lab.main;
            item.querySelector('.s-sub').textContent = lab.sub;
            item.addEventListener('mousedown', function (e) {
                e.preventDefault();
                var co = f.geometry.coordinates;
                var ll = L.latLng(co[1], co[0]);
                var i = state.rows.indexOf(row);
                setRow(i, ll, lab.main + (lab.sub ? ', ' + lab.sub : ''));
                box.style.display = 'none';
                map.setView(ll, Math.max(map.getZoom(), 14));
            });
            box.appendChild(item);
        });
        box.style.display = 'block';
    }

    // ---------- current location ----------
    function locate() {
        if (!navigator.geolocation) {
            toast('Geolocation not available');
            return;
        }
        var fab = el('locateBtn');
        fab.classList.add('locating');
        navigator.geolocation.getCurrentPosition(
            function (pos) {
                fab.classList.remove('locating');
                var ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
                if (state.meMarker) map.removeLayer(state.meMarker);
                state.meMarker = L.circleMarker(ll, {
                    radius: 7,
                    color: '#fff',
                    weight: 2,
                    fillColor: '#1e88e5',
                    fillOpacity: 1,
                }).addTo(map);
                map.setView(ll, Math.max(map.getZoom(), 15));
                var i = firstEmptyIndex();
                if (i === -1) i = 0; // replace start if all full
                setRow(i, ll, 'My location');
            },
            function (err) {
                fab.classList.remove('locating');
                toast(err.code === 1 ? 'Location permission denied' : 'Could not get location');
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
        );
    }

    // ---------- profile ----------
    function uploadProfile() {
        return fetch(CONFIG.profileFile)
            .then(function (r) {
                return r.text();
            })
            .then(function (txt) {
                return fetch(CONFIG.host + '/brouter/profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain' },
                    body: txt,
                });
            })
            .then(function (r) {
                return r.json();
            })
            .then(function (j) {
                if (j && j.profileid) {
                    state.customId = j.profileid;
                    return j.profileid;
                }
                throw new Error(j && j.error ? j.error : 'profile upload failed');
            });
    }

    // ---------- routing ----------
    function activeLatLngs() {
        return state.rows.filter(function (r) {
            return r.latlng;
        });
    }

    function route() {
        var pts = activeLatLngs();
        if (pts.length < 2) {
            clearRoute();
            return;
        }
        var doRoute = function () {
            var lonlats = pts
                .map(function (r) {
                    return r.latlng.lng.toFixed(6) + ',' + r.latlng.lat.toFixed(6);
                })
                .join('|');
            var url =
                CONFIG.host +
                '/brouter?lonlats=' +
                lonlats +
                '&profile=' +
                state.customId +
                '&alternativeidx=' +
                state.altIdx +
                '&format=geojson';
            var reqId = ++state.routeReq;
            busy(true);
            fetch(url)
                .then(function (r) {
                    return r.headers.get('Content-Type') && r.headers.get('Content-Type').indexOf('json') !== -1
                        ? r.json()
                        : r.text().then(function (t) {
                              throw new Error(t);
                          });
                })
                .then(function (geo) {
                    if (reqId !== state.routeReq) return; // stale
                    busy(false);
                    drawRoute(geo);
                })
                .catch(function (e) {
                    if (reqId !== state.routeReq) return;
                    busy(false);
                    // profile may have expired on the server → re-upload once and retry
                    if (/profile/i.test(String(e.message))) {
                        uploadProfile().then(doRoute).catch(function () {
                            toast('Routing unavailable');
                        });
                    } else if (state.altIdx > 0) {
                        // this alternative doesn't exist for the trip → fall back to main
                        state.altIdx = 0;
                        updateAlts();
                        toast('No alternative for this trip');
                        doRoute();
                    } else {
                        toast('No route found');
                    }
                });
        };
        if (!state.customId) {
            uploadProfile().then(doRoute).catch(function () {
                toast('Could not load routing profile');
            });
        } else {
            doRoute();
        }
    }

    function clearRoute() {
        if (state.routeLayer) {
            map.removeLayer(state.routeLayer);
            state.routeLayer = null;
        }
        if (state.casingLayer) {
            map.removeLayer(state.casingLayer);
            state.casingLayer = null;
        }
        clearSurfaceHighlight();
        showAlts(false);
        setSheet('hidden');
    }

    function drawRoute(geo) {
        var f = geo.features && geo.features[0];
        if (!f) {
            toast('No route found');
            return;
        }
        var coords = f.geometry.coordinates.map(function (c) {
            return [c[1], c[0]];
        });
        clearSurfaceHighlight();
        if (state.routeLayer) map.removeLayer(state.routeLayer);
        if (state.casingLayer) map.removeLayer(state.casingLayer);
        state.casingLayer = L.polyline(coords, { color: '#fff', weight: 8, opacity: 0.9 }).addTo(map);
        state.routeLayer = L.polyline(coords, { color: '#2e7d32', weight: 5, opacity: 0.95 }).addTo(map);
        map.fitBounds(state.routeLayer.getBounds(), { paddingTopLeft: [30, 150], paddingBottomRight: [30, 220] });

        var p = f.properties || {};
        el('statDist').textContent = fmtDist(parseFloat(p['track-length'] || 0));
        el('statTime').textContent = fmtTime(parseFloat(p['total-time'] || 0));
        el('statAscend').textContent = Math.round(parseFloat(p['filtered ascend'] || 0)) + ' m';

        buildElevation(f.geometry.coordinates);
        buildSurface(p.messages, coords);
        showAlts(true);
        updateAlts();
        // open fully on the first route so alternatives + surface + elevation are
        // visible; keep the user's chosen state when only switching alternatives
        if ($sheet.getAttribute('aria-hidden') === 'true') setSheet('open');
    }

    // ---------- elevation chart ----------
    function buildElevation(coords) {
        var host = el('elevation');
        if (!coords || coords.length < 2 || coords[0].length < 3) {
            host.innerHTML = '<div style="color:#6b7686;font-size:13px">No elevation data</div>';
            return;
        }
        var W = 320,
            H = 120,
            padL = 28,
            padB = 16,
            padT = 8;
        var dist = [0],
            ele = [coords[0][2]],
            total = 0,
            min = coords[0][2],
            max = coords[0][2];
        for (var i = 1; i < coords.length; i++) {
            total += L.latLng(coords[i - 1][1], coords[i - 1][0]).distanceTo(L.latLng(coords[i][1], coords[i][0]));
            dist.push(total);
            var e = coords[i][2];
            ele.push(e);
            if (e < min) min = e;
            if (e > max) max = e;
        }
        if (max - min < 1) max = min + 1;
        var sx = function (d) {
            return padL + (d / total) * (W - padL - 4);
        };
        var sy = function (e) {
            return padT + (1 - (e - min) / (max - min)) * (H - padT - padB);
        };
        var line = '',
            area = 'M' + sx(0) + ',' + (H - padB);
        for (var j = 0; j < dist.length; j++) {
            var X = sx(dist[j]).toFixed(1),
                Y = sy(ele[j]).toFixed(1);
            line += (j === 0 ? 'M' : 'L') + X + ',' + Y;
            area += 'L' + X + ',' + Y;
        }
        area += 'L' + sx(total) + ',' + (H - padB) + 'Z';
        var svg =
            '<svg viewBox="0 0 ' +
            W +
            ' ' +
            H +
            '" preserveAspectRatio="none">' +
            '<path class="el-area" d="' +
            area +
            '"/>' +
            '<path class="el-line" d="' +
            line +
            '"/>' +
            '<text class="el-axis" x="2" y="' +
            (sy(max) + 4) +
            '">' +
            Math.round(max) +
            'm</text>' +
            '<text class="el-axis" x="2" y="' +
            (H - padB) +
            '">' +
            Math.round(min) +
            'm</text>' +
            '</svg>';
        host.innerHTML = svg;
    }

    // ---------- surface breakdown ----------
    var SURFACE_GROUPS = [
        { test: /asphalt|paved|concrete|paving_stones/, name: 'Paved', color: '#2e7d32' },
        { test: /compacted|fine_gravel|gravel/, name: 'Gravel', color: '#a1887f' },
        { test: /ground|dirt|earth|mud|grass|sand|unpaved/, name: 'Unpaved', color: '#8d6e63' },
        { test: /cobblestone|sett/, name: 'Cobble/Sett', color: '#e53935' },
    ];
    function classifySurface(tags) {
        var m = /surface=([^\s;]+)/.exec(tags || '');
        var s = m ? m[1] : '';
        for (var i = 0; i < SURFACE_GROUPS.length; i++) if (SURFACE_GROUPS[i].test.test(s)) return SURFACE_GROUPS[i];
        return { name: 'Unknown', color: '#b0bec5' };
    }

    function surfaceColor(name) {
        for (var i = 0; i < SURFACE_GROUPS.length; i++) if (SURFACE_GROUPS[i].name === name) return SURFACE_GROUPS[i].color;
        return '#b0bec5';
    }

    // messages = brouter per-segment data, coords = route geometry as [lat,lng,...]
    function buildSurface(messages, coords) {
        var bar = el('surfaceBar'),
            legend = el('surfaceLegend');
        bar.innerHTML = '';
        legend.innerHTML = '';
        state.surfaceSegments = null;
        if (!messages || messages.length < 2) {
            legend.innerHTML = '<div style="color:#6b7686;font-size:13px">No surface data</div>';
            return;
        }
        var header = messages[0];
        var loni = header.indexOf('Longitude'),
            lati = header.indexOf('Latitude'),
            di = header.indexOf('Distance'),
            wi = header.indexOf('WayTags');
        if (di === -1 || wi === -1) return;

        // map each route vertex (microdegree key) to its index, to slice geometry per segment
        var idxMap = {};
        if (coords) {
            for (var k = 0; k < coords.length; k++) {
                idxMap[Math.round(coords[k][0] * 1e6) + ',' + Math.round(coords[k][1] * 1e6)] = k;
            }
        }

        var acc = {},
            geom = {},
            total = 0,
            prevIdx = 0;
        for (var i = 1; i < messages.length; i++) {
            var d = parseFloat(messages[i][di]) || 0;
            var g = classifySurface(messages[i][wi]);
            acc[g.name] = acc[g.name] || { dist: 0, color: g.color };
            acc[g.name].dist += d;
            total += d;

            if (coords) {
                var key = parseInt(messages[i][lati], 10) + ',' + parseInt(messages[i][loni], 10);
                var idx = idxMap[key];
                if (idx != null && idx > prevIdx) {
                    geom[g.name] = geom[g.name] || [];
                    geom[g.name].push(coords.slice(prevIdx, idx + 1));
                    prevIdx = idx;
                }
            }
        }
        if (!total) return;
        state.surfaceSegments = geom;

        var entries = Object.keys(acc)
            .map(function (k2) {
                return { name: k2, dist: acc[k2].dist, color: acc[k2].color };
            })
            .sort(function (a, b) {
                return b.dist - a.dist;
            });
        entries.forEach(function (e) {
            var pct = (e.dist / total) * 100;
            var seg = document.createElement('div');
            seg.className = 'seg';
            seg.style.width = pct + '%';
            seg.style.background = e.color;
            seg.title = e.name + ' ' + pct.toFixed(0) + '%';
            bindSurfaceHover(seg, e.name);
            bar.appendChild(seg);

            var lg = document.createElement('div');
            lg.className = 'lg';
            lg.innerHTML =
                '<span class="sw" style="background:' +
                e.color +
                '"></span><span>' +
                e.name +
                '</span> <span class="pct">' +
                pct.toFixed(0) +
                '% · ' +
                fmtDist(e.dist) +
                '</span>';
            bindSurfaceHover(lg, e.name);
            legend.appendChild(lg);
        });
    }

    // highlight all road segments of a surface group on the map
    function highlightSurface(name) {
        clearSurfaceHighlight();
        var segs = state.surfaceSegments && state.surfaceSegments[name];
        if (!segs || !segs.length) return;
        var lg = L.layerGroup();
        var color = surfaceColor(name);
        segs.forEach(function (s) {
            L.polyline(s, { color: '#fff', weight: 11, opacity: 0.95 }).addTo(lg);
            L.polyline(s, { color: color, weight: 6, opacity: 1 }).addTo(lg);
        });
        lg.addTo(map);
        state.hoverLayer = lg;
    }
    function clearSurfaceHighlight() {
        if (state.hoverLayer) {
            map.removeLayer(state.hoverLayer);
            state.hoverLayer = null;
        }
    }
    function bindSurfaceHover(elm, name) {
        elm.addEventListener('mouseenter', function () {
            highlightSurface(name);
        });
        elm.addEventListener('mouseleave', clearSurfaceHighlight);
        // touch: press to highlight, release to clear
        elm.addEventListener(
            'touchstart',
            function () {
                highlightSurface(name);
            },
            { passive: true }
        );
        elm.addEventListener('touchend', clearSurfaceHighlight);
        elm.addEventListener('touchcancel', clearSurfaceHighlight);
    }

    // ---------- bottom sheet ----------
    function setSheet(stateName) {
        $sheet.classList.remove('open', 'collapsed');
        if (stateName === 'hidden') {
            $sheet.setAttribute('aria-hidden', 'true');
            return;
        }
        $sheet.setAttribute('aria-hidden', 'false');
        $sheet.classList.add(stateName);
    }
    function toggleSheet() {
        if ($sheet.classList.contains('open')) setSheet('collapsed');
        else if ($sheet.classList.contains('collapsed')) setSheet('open');
    }

    // ---------- alternatives selector ----------
    var ALT_LABELS = ['Main', 'Alt 1', 'Alt 2', 'Alt 3'];
    function buildAlts() {
        var host = el('alts');
        host.innerHTML = '';
        ALT_LABELS.forEach(function (lab, i) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'alt' + (i === state.altIdx ? ' active' : '');
            b.textContent = lab;
            b.addEventListener('click', function () {
                if (state.altIdx === i) return;
                state.altIdx = i;
                updateAlts();
                route();
            });
            host.appendChild(b);
        });
    }
    function updateAlts() {
        var btns = el('alts').children;
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('active', i === state.altIdx);
    }
    function showAlts(on) {
        el('alts').classList.toggle('show', !!on);
    }

    // ---------- init ----------
    function init() {
        $stops = el('stops');
        $sheet = el('sheet');
        busyEl = document.createElement('div');
        busyEl.className = 'busy';
        document.body.appendChild(busyEl);

        initMap();
        buildRows();
        buildAlts();

        el('addStop').addEventListener('click', function () {
            state.rows.push({ latlng: null, name: '', marker: null });
            buildRows();
        });
        el('locateBtn').addEventListener('click', locate);
        el('sheetHandle').addEventListener('click', toggleSheet);

        uploadProfile().catch(function () {
            toast('Could not reach routing server');
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
