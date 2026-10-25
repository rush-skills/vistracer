import type { HopLocation, HopResolution, LocationEstimate, TracerouteRun } from "@common/ipc";

/** Small hop and run builders for renderer tests. */

const NO_LOCATION: HopLocation = {
  best: null,
  alternatives: [],
  ixp: null,
  hostnameHint: null,
  anycast: null,
  isRttReference: false
};

export const estimate = (
  label: string,
  latitude: number,
  longitude: number,
  confidence: LocationEstimate["confidence"] = "high",
  source: LocationEstimate["source"] = "hostname-hint",
  radiusKm = 50
): LocationEstimate => ({ source, latitude, longitude, radiusKm, confidence, label, rtt: null });

export function makeHop(
  hopIndex: number,
  ip: string | null,
  rttMs: number | null,
  overrides: Partial<HopResolution> = {}
): HopResolution {
  const rtts = rttMs == null ? [] : [rttMs, rttMs + 0.5, rttMs + 1];
  return {
    hopIndex,
    ipAddress: ip,
    hostName: null,
    responders: ip ? [{ ipAddress: ip, hostName: null, rttsMs: rtts }] : [],
    lossPercent: rttMs == null ? 100 : 0,
    latency:
      rttMs == null
        ? { minRttMs: null, maxRttMs: null, avgRttMs: null, jitterMs: null }
        : { minRttMs: rttMs, maxRttMs: rttMs + 1, avgRttMs: rttMs + 0.5, jitterMs: 0.5 },
    isPrivate: false,
    location: NO_LOCATION,
    rawLine: "",
    lookupState: "complete",
    ...overrides
  };
}

export function makeRun(hops: HopResolution[], target = "example.com"): TracerouteRun {
  return {
    request: {
      target,
      protocol: "ICMP",
      maxHops: 30,
      timeoutMs: 4000,
      packetCount: 3,
      forceFresh: false
    },
    summary: {
      target,
      startedAt: 1,
      hopCount: hops.length,
      protocolsTried: ["ICMP"],
      notices: []
    },
    hops
  };
}

/** The route of scripts/globe-check/mock-ipc.js: Mumbai to New York over Marseille. */
export const ROUTE: HopResolution[] = [
  makeHop(1, "192.168.1.1", 1, { isPrivate: true }),
  makeHop(2, "103.21.124.1", 4, {
    location: {
      ...NO_LOCATION,
      isRttReference: true,
      best: estimate("Mumbai, India", 19.08, 72.88, "medium", "geolite-city", 20)
    }
  }),
  makeHop(3, "180.87.38.5", 30, {
    hostName: "if-ae-2.tcore1.mlv-mumbai.as6453.net",
    asn: { asn: 6453, name: "TATA COMMUNICATIONS" },
    location: { ...NO_LOCATION, best: estimate("Chennai, India", 13.08, 80.27) }
  }),
  makeHop(4, null, null),
  makeHop(5, "80.231.217.17", 111, {
    lossPercent: 33.3,
    location: { ...NO_LOCATION, best: estimate("Marseille, France", 43.3, 5.37) }
  }),
  makeHop(6, "8.8.8.8", 112, {
    asn: { asn: 15169, name: "GOOGLE" },
    location: {
      ...NO_LOCATION,
      anycast: {
        evidence: "known-prefix",
        service: "Google Public DNS",
        geoliteRuledOut: true,
        maxDistanceKm: 740,
        referenceHopIndex: 2
      }
    }
  })
];
