(function () {
    var hostname = window.location.hostname;
    var origin = window.location.protocol + '//' + hostname + (window.location.port ? ':' + window.location.port : '');

    BR.conf = {};

    // Switch for intermodal routing demo
    BR.conf.transit = false;
    // or as query parameter (index.html?transit=true#zoom=...)
    // (uses search/query (?) not hash (#) params, as config only executed once at load)
    // TODO not included in permalink (better replace permalink with hash plugin)
    //var params = new URLSearchParams(window.location.search.slice(1));
    //BR.conf.transit = params.has('transit') && (params.get('transit') === 'true');

    // Chaos Bike Berlin hybrid app: always use the public brouter.de routing
    // server (cross-origin; brouter.de sends Access-Control-Allow-Origin: *).
    // The chaos_bike_berlin profile is NOT installed on brouter.de, so it is
    // uploaded at runtime as a temporary custom profile (see js/index.js,
    // BR.confChaosProfile) and routed via the returned custom_<id>.
    BR.conf.host = 'https://brouter.de';

    // Profile .brf files are bundled with the app and served locally (relative
    // to index.html), so no external profile host is needed.
    BR.conf.profilesUrl = 'profiles/';

    // Name of the web app/instance, e.g. used as GPX creator and link text
    BR.conf.appName = 'Chaos Bike Berlin';

    // Bundled profile auto-applied on load (uploaded to brouter.de as custom profile)
    BR.conf.chaosProfile = 'chaos_bike_berlin';

    BR.conf.privacyPolicyUrl = '/privacypolicy.html';

    // Set the initial position and zoom level of the map (Berlin)
    BR.conf.initialMapLocation = [52.52, 13.405];
    BR.conf.initialMapZoom = 12;

    BR.conf.profiles = ['chaos_bike_berlin'];

    // Only use our curated, app-friendly tile layers (no auto-loaded
    // tile.openstreetmap.org default, whose policy forbids app/bulk use).
    BR.conf.clearBaseLayers = true;

    // Custom tile layers. Only the active layer fetches tiles, so listing
    // alternatives is fine. CyclOSM (index 0) is the default bike map.
    // To add Thunderforest's cycling maps, put your key in keys.js
    // (BR.keys.thunderforest) and uncomment the entries below.
    BR.conf.baseLayers = {
        CyclOSM: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        OpenTopoMap: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        // 'Thunderforest OpenCycleMap': 'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=YOUR_KEY',
        // 'Thunderforest Outdoors': 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=YOUR_KEY',
    };

    BR.conf.overlays = {};

    // Base layer to show on start, as position number in the layer switcher, starting from 0, default is first
    BR.conf.defaultBaseLayerIndex = 0;

    // Initial route line transparency (0-1, overridden by stored slider setting)
    BR.conf.defaultOpacity = 0.67;

    // Minimum transparency slider value on load, values between 0 and 1 (0=invisible).
    // 0 = no minimum, use stored setting; 1 = always reset to full visibility on load
    BR.conf.minOpacity = 0.3;

    BR.conf.routingStyles = {
        trailer: {
            weight: 5,
            dashArray: [10, 10],
            opacity: 0.6,
            color: 'magenta',
        },
        track: {
            weight: 5,
            color: 'magenta',
            opacity: BR.conf.defaultOpacity,
        },
        trackCasing: {
            weight: 8,
            color: 'white',
            // assumed to be same as track, see setOpacity
            opacity: BR.conf.defaultOpacity,
        },
        nodata: {
            color: 'darkred',
        },
    };

    BR.conf.markerColors = {
        // awesome-markers colors (by color picker)
        poi: '#436978',
        start: '#72b026',
        via: '#38aadd',
        stop: '#d63e2a',
    };

    // transit (intermodal routing) demo config
    if (BR.conf.transit) {
        BR.conf.profiles = [
            '../im/bike',
            '../im/foot',
            '../im/like-bike',
            '../im/like-foot',
            'trekking',
            'fastbike',
            'shortest',
            'moped',
            'car-test',
        ];
    }

    // regex needs to be in sync with server, see ServerHandler.getTrackName()
    BR.conf.tracknameAllowedChars = 'a-zA-Z0-9 \\._\\-';
})();
