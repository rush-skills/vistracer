// Injected into the page before the app loads (see check.mjs). It stands in
// for the Tauri IPC with three fixture traces and synthetic infrastructure
// and satellite data (exchanges, data centres, cables, orbital elements;
// made up, not PeeringDB, TeleGeography or CelesTrak data), and counts what
// the check needs: animation frames, frames that drew, WebGL draws, online
// tile requests, IPC calls per command, CSP violations and page errors.
// Plain browser JavaScript, not bundled with the app.
(() => {
  const probe = { raf: 0, drawnFrames: 0, draws: 0, onlineTiles: [], ipc: {}, csp: [], errors: [] };
  window.__globeCheck = probe;

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      probe.raf += 1;
      const before = probe.draws;
      callback(time);
      if (probe.draws > before) {
        probe.drawnFrames += 1;
      }
    });

  // check.mjs hides the page this way (headless Chrome is never hidden).
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (window.__pageHidden ? "hidden" : "visible")
  });

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, options) {
    const context = getContext.call(this, type, options);
    if (context && /webgl/.test(type) && !context.__counted) {
      context.__counted = true;
      for (const name of [
        "drawElements",
        "drawArrays",
        "drawElementsInstanced",
        "drawArraysInstanced"
      ]) {
        const draw = context[name];
        if (draw) {
          context[name] = function (...args) {
            probe.draws += 1;
            return draw.apply(this, args);
          };
        }
      }
    }
    return context;
  };

  // Online tiles use the vistiles scheme. A browser cannot load it, but every
  // attempt is a tile the desktop app would fetch from NASA GIBS.
  const recordTile = (url) => {
    if (typeof url === "string" && url.startsWith("vistiles:")) {
      probe.onlineTiles.push(url);
    }
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    recordTile(String(url));
    return open.call(this, method, url, ...rest);
  };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    ...src,
    set(value) {
      recordTile(String(value));
      src.set.call(this, value);
    }
  });

  document.addEventListener("securitypolicyviolation", (event) =>
    probe.csp.push(`${event.violatedDirective} ${event.blockedURI}`)
  );
  window.addEventListener("error", (event) => probe.errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) => probe.errors.push(String(event.reason)));

  const noLocation = {
    best: null,
    alternatives: [],
    ixp: null,
    hostnameHint: null,
    anycast: null,
    isRttReference: false
  };
  const estimate = (source, latitude, longitude, radiusKm, confidence, label) => ({
    source,
    latitude,
    longitude,
    radiusKm,
    confidence,
    label,
    rtt: null
  });
  const hop = (hopIndex, ip, rtt, location, extra = {}) => ({
    hopIndex,
    ipAddress: ip,
    hostName: null,
    responders: [{ ipAddress: ip, hostName: null, rttsMs: [rtt, rtt + 0.5, rtt + 1] }],
    lossPercent: 0,
    latency: { minRttMs: rtt, maxRttMs: rtt + 1, avgRttMs: rtt + 0.5, jitterMs: 0.5 },
    geo: null,
    asn: null,
    isPrivate: false,
    location,
    rawLine: "",
    providers: [],
    peeringDb: null,
    lookupState: "complete",
    ...extra
  });
  const asn = (number, name) => ({ asn: { asn: number, name } });
  const ROUTES = {
    "example.com": [
      hop(1, "192.168.1.1", 1, noLocation, { isPrivate: true }),
      hop(
        2,
        "103.21.124.1",
        4,
        {
          ...noLocation,
          isRttReference: true,
          best: estimate("geolite-city", 19.08, 72.88, 20, "medium", "Mumbai, India")
        },
        asn(9498, "BHARTI Airtel Ltd.")
      ),
      hop(
        3,
        "180.87.38.5",
        30,
        {
          ...noLocation,
          best: estimate("hostname-hint", 13.08, 80.27, 50, "high", "Chennai, India")
        },
        asn(6453, "TATA COMMUNICATIONS")
      ),
      hop(
        4,
        "80.231.217.17",
        111,
        {
          ...noLocation,
          best: estimate("hostname-hint", 43.3, 5.37, 50, "high", "Marseille, France")
        },
        asn(6453, "TATA COMMUNICATIONS")
      ),
      hop(
        5,
        "80.81.192.96",
        120,
        {
          ...noLocation,
          best: estimate("ixp", 50.11, 8.68, 30, "high", "DE-CIX Frankfurt"),
          ixp: {
            ixId: 31,
            name: "DE-CIX Frankfurt",
            city: "Frankfurt",
            country: "DE",
            prefix: "80.81.192.0/21",
            facilityCount: 40
          }
        },
        asn(6453, "TATA COMMUNICATIONS")
      ),
      hop(
        6,
        "154.54.58.1",
        128,
        {
          ...noLocation,
          best: estimate("hostname-hint", 51.51, -0.13, 50, "high", "London, United Kingdom")
        },
        asn(16509, "AMAZON-02")
      ),
      hop(
        7,
        "154.54.44.85",
        200,
        {
          ...noLocation,
          best: estimate("hostname-hint", 40.71, -74.01, 50, "high", "New York, United States")
        },
        asn(16509, "AMAZON-02")
      )
    ],
    "8.8.8.8": [
      hop(1, "192.168.1.1", 1, noLocation, { isPrivate: true }),
      hop(2, "103.21.124.1", 4, {
        ...noLocation,
        isRttReference: true,
        best: estimate("geolite-city", 19.08, 72.88, 20, "medium", "Mumbai, India")
      }),
      hop(3, "142.250.171.38", 5, {
        ...noLocation,
        best: estimate("hostname-hint", 28.61, 77.21, 50, "high", "Delhi, India")
      }),
      hop(4, "8.8.8.8", 6, {
        ...noLocation,
        anycast: {
          evidence: "known-prefix",
          service: "Google Public DNS",
          geoliteRuledOut: true,
          maxDistanceKm: 740,
          referenceHopIndex: 2
        }
      })
    ]
  };

  // A route whose third hop is in Starlink's network (AS14593): the hop
  // details and the satellites layer mark it. Addresses are documentation
  // ranges, marked public here.
  ROUTES["starlink.example"] = [
    hop(1, "192.168.1.1", 1, noLocation, { isPrivate: true }),
    hop(2, "100.64.0.1", 24, noLocation, { isPrivate: true }),
    hop(
      3,
      "203.0.113.25",
      31,
      {
        ...noLocation,
        isRttReference: true,
        best: estimate("geolite-city", 51.51, -0.13, 50, "medium", "London, United Kingdom")
      },
      asn(14593, "SPACEX-STARLINK")
    ),
    hop(
      4,
      "198.51.100.7",
      33,
      { ...noLocation, best: estimate("hostname-hint", 51.51, -0.13, 50, "high", "London, United Kingdom") },
      asn(1299, "ARELION")
    ),
    hop(
      5,
      "192.0.2.10",
      40,
      { ...noLocation, best: estimate("geolite-city", 50.11, 8.68, 20, "medium", "Frankfurt, Germany") },
      asn(15169, "GOOGLE")
    )
  ];

  // Synthetic exchanges and data centres in the layout of get_peeringdb_sites.
  const CITIES = [
    ["Frankfurt", "DE", 50.11, 8.68],
    ["Amsterdam", "NL", 52.37, 4.9],
    ["London", "GB", 51.51, -0.13],
    ["Paris", "FR", 48.86, 2.35],
    ["Marseille", "FR", 43.3, 5.37],
    ["Mumbai", "IN", 19.08, 72.88],
    ["Chennai", "IN", 13.08, 80.27],
    ["Singapore", "SG", 1.29, 103.85],
    ["Tokyo", "JP", 35.68, 139.69],
    ["Sydney", "AU", -33.87, 151.21],
    ["New York", "US", 40.71, -74.01],
    ["Ashburn", "US", 39.04, -77.49],
    ["Chicago", "US", 41.88, -87.63],
    ["Dallas", "US", 32.78, -96.8],
    ["Los Angeles", "US", 34.05, -118.24],
    ["São Paulo", "BR", -23.55, -46.63],
    ["Johannesburg", "ZA", -26.2, 28.05],
    ["Dubai", "AE", 25.2, 55.27],
    ["Stockholm", "SE", 59.33, 18.07],
    ["Madrid", "ES", 40.42, -3.7]
  ];
  const SITES = {
    storedAt: Date.now(),
    complete: true,
    exchanges: CITIES.map(([city, country, latitude, longitude], i) => ({
      id: i === 0 ? 31 : 1000 + i,
      name: i === 0 ? "DE-CIX Frankfurt" : `Example IX ${city}`,
      city,
      country,
      latitude: latitude + 0.01,
      longitude: longitude + 0.01,
      radiusKm: 30,
      facilityCount: 6,
      networkCount: i === 0 ? 1019 : 400 - i * 10
    })),
    facilities: CITIES.flatMap(([city, country, latitude, longitude], i) =>
      Array.from({ length: 8 }, (_, n) => ({
        id: i * 100 + n,
        name: `Example DC ${city} ${n + 1}`,
        org: "Example Data Centres",
        city,
        country,
        latitude: latitude + Math.sin(n) * 0.12,
        longitude: longitude + Math.cos(n) * 0.12,
        networkCount: 300 - n * 20,
        exchangeCount: 3
      }))
    )
  };
  // Synthetic cables in the layout of get_submarine_cables.
  const CABLES = {
    fetchedAt: Date.now(),
    note: null,
    cables: [
      {
        id: "example-indian-ocean",
        name: "Example Indian Ocean Cable",
        segments: [[[80.27, 13.08], [79.9, 6.9], [60, 12], [45, 12.5], [43.2, 12.6], [38.5, 20], [32.4, 29.9], [32.3, 31.3], [20, 34], [5.37, 43.3]]]
      },
      {
        id: "example-atlantic",
        name: "Example Atlantic Cable",
        segments: [[[-73.97, 40.59], [-60, 42], [-40, 47], [-20, 50], [-4.55, 50.83]]]
      },
      {
        id: "example-pacific",
        name: "Example Pacific Cable",
        segments: [[[-118.4, 33.9], [-140, 30], [-160, 22], [-179.9, 25], [160, 30], [139.9, 35.3]]]
      },
      {
        id: "example-south-atlantic",
        name: "Example South Atlantic Cable",
        segments: [[[-38.5, -3.7], [-20, 0], [-5, 4], [3.4, 6.4]], [[-38.5, -3.7], [-28, 10], [-9.1, 38.7]]]
      }
    ]
  };

  // Synthetic orbital elements in the layout of get_satellites: evenly spread
  // planes, like the real constellations' shells. Epoch 6 hours ago.
  const epoch = new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace("Z", "");
  const walker = (group, firstId, planes, perPlane, elements) =>
    Array.from({ length: planes * perPlane }, (_, i) => {
      const plane = Math.floor(i / perPlane);
      const slot = i % perPlane;
      return {
        noradId: firstId + i,
        name: `EXAMPLE ${group.toUpperCase()}-${i + 1}`,
        objectId: "2098-001A",
        epoch,
        eccentricity: 0.0001,
        argOfPericenter: 90,
        bstar: 0.0001,
        meanMotionDot: 0,
        meanMotionDdot: 0,
        raan: (plane * 360) / planes,
        meanAnomaly: ((slot * 360) / perPlane + plane * 3) % 360,
        ...elements
      };
    });
  const SATELLITES = {
    starlink: walker("starlink", 900000, 72, 22, { meanMotion: 15.06, inclination: 53 }),
    oneweb: walker("oneweb", 910000, 18, 36, { meanMotion: 13.15, inclination: 87.9 }),
    "gps-ops": walker("gps", 920000, 6, 4, { meanMotion: 2.0056, inclination: 55 }),
    stations: walker("station", 930000, 3, 1, { meanMotion: 15.49, inclination: 51.6 }),
    geo: walker("geo", 940000, 1, 40, { meanMotion: 1.0027, inclination: 0.05, eccentricity: 0.0002 })
  };
  const SATELLITE_LAYERS = {
    starlink: ["satellites-starlink", true],
    oneweb: ["satellites-oneweb", false],
    "gps-ops": ["satellites-gps", true],
    stations: ["satellites-stations", true],
    geo: ["satellites-geo", false]
  };

  const listeners = new Map();
  let nextId = 1;
  const emit = (event, payload) => {
    for (const listener of listeners.values()) {
      if (listener.event === event) listener.callback({ event, id: 1, payload });
    }
  };
  const settings = {
    "preferences.onboarding": { skipOnLaunch: true },
    integrations: {
      teamCymru: { enabled: true },
      rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
      ripeStat: { enabled: true, sourceApp: "VisTracer" },
      peeringDb: { enabled: false },
      ixMatching: { enabled: true }
    }
  };

  // The app then adds the online imagery layer, as in the desktop app.
  globalThis.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" }
    },
    transformCallback: (callback) => {
      const id = nextId++;
      window[`_${id}`] = callback;
      return id;
    },
    convertFileSrc: (filePath, protocol) => `${protocol}://localhost/${filePath}`,
    invoke: async (command, args) => {
      probe.ipc[command] = (probe.ipc[command] ?? 0) + 1;
      switch (command) {
        case "plugin:event|listen": {
          const id = nextId++;
          listeners.set(id, { event: args.event, callback: window[`_${args.handler}`] });
          return id;
        }
        case "plugin:event|unlisten":
          listeners.delete(args.eventId);
          return null;
        case "plugin:window|is_minimized":
          return false;
        case "get_settings":
          return settings[args.key] ?? null;
        case "set_settings":
          settings[args.key] = args.value;
          return null;
        case "get_peeringdb_sites":
          return SITES;
        case "get_submarine_cables": {
          // As the backend: only with the saved switch on and the notice accepted.
          const ui = settings["preferences.ui"];
          if (!ui?.layers?.["submarine-cables"] || !ui?.consents?.["submarine-cables"]) {
            throw "Submarine cables are off: turn the layer on in Layers and accept its notice. Nothing was downloaded.";
          }
          return CABLES;
        }
        case "get_satellites": {
          // As the backend: the satellites layer and the group on, the notice accepted.
          const ui = settings["preferences.ui"];
          const [layer, byDefault] = SATELLITE_LAYERS[args.group] ?? [];
          const groupOn = layer && (ui?.layers?.[layer] ?? byDefault);
          if (!ui?.layers?.satellites || !ui?.consents?.satellites || !groupOn) {
            throw "Satellites are off: turn the layer and the group on in Layers and accept the notice. Nothing was downloaded.";
          }
          return {
            group: args.group,
            fetchedAt: Date.now(),
            source: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${args.group}&FORMAT=csv`,
            note: null,
            satellites: SATELLITES[args.group]
          };
        }
        case "get_geo_database_meta":
          return { cityDbStatus: "loaded", asnDbStatus: "loaded" };
        case "get_recent_runs":
          return [];
        case "get_app_info":
          return { version: "0.0.0-check", updaterConfigured: false };
        case "get_tile_cache_info":
          return { sizeBytes: 0, tileCount: 0, capBytes: 500000000 };
        case "traceroute_run": {
          const target = args.request.target;
          const hops = ROUTES[target] ?? ROUTES["example.com"];
          const runId = `check-${target}-${Date.now()}`;
          const summary = {
            target,
            startedAt: Date.now(),
            hopCount: 0,
            protocolsTried: ["ICMP"],
            notices: []
          };
          for (const item of hops) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            emit("vistracer:traceroute:progress", { runId, hop: item, completed: false, summary });
          }
          const run = {
            request: args.request,
            summary: { ...summary, hopCount: hops.length, completedAt: Date.now() },
            hops
          };
          emit("vistracer:traceroute:progress", {
            runId,
            completed: true,
            summary: run.summary,
            hops
          });
          return { runId, run };
        }
        default:
          return null;
      }
    }
  };
})();
