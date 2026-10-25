// Injected into the page before the app loads (see check.mjs). It stands in
// for the Tauri IPC with two fixture traces, and counts what the check needs:
// animation frames, WebGL draws, online tile requests, CSP violations and
// page errors. Plain browser JavaScript, not bundled with the app.
(() => {
  const probe = { raf: 0, draws: 0, onlineTiles: [], csp: [], errors: [] };
  window.__globeCheck = probe;

  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((time) => {
      probe.raf += 1;
      callback(time);
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
  const ROUTES = {
    "example.com": [
      hop(1, "192.168.1.1", 1, noLocation, { isPrivate: true }),
      hop(2, "103.21.124.1", 4, {
        ...noLocation,
        isRttReference: true,
        best: estimate("geolite-city", 19.08, 72.88, 20, "medium", "Mumbai, India")
      }),
      hop(3, "180.87.38.5", 30, {
        ...noLocation,
        best: estimate("hostname-hint", 13.08, 80.27, 50, "high", "Chennai, India")
      }),
      hop(4, "80.231.217.17", 111, {
        ...noLocation,
        best: estimate("hostname-hint", 43.3, 5.37, 50, "high", "Marseille, France")
      }),
      hop(5, "80.81.192.96", 120, {
        ...noLocation,
        best: estimate("ixp", 50.11, 8.68, 30, "high", "DE-CIX Frankfurt")
      }),
      hop(6, "154.54.58.1", 128, {
        ...noLocation,
        best: estimate("hostname-hint", 51.51, -0.13, 50, "high", "London, United Kingdom")
      }),
      hop(7, "154.54.44.85", 200, {
        ...noLocation,
        best: estimate("hostname-hint", 40.71, -74.01, 50, "high", "New York, United States")
      })
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
