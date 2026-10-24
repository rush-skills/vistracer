import type { HintRule, HopResolution, LocationSource, RttCheck } from "@common/ipc";

export const SOURCE_LABELS: Record<LocationSource, string> = {
  ixp: "PeeringDB IXP",
  "hostname-hint": "Host name",
  "geolite-city": "GeoLite2 city",
  "geolite-country": "GeoLite2 country"
};

export const HINT_RULE_LABELS: Record<HintRule, string> = {
  "carrier-code": "carrier site code",
  "city-region-code": "city and region code",
  "city-name": "city name",
  "airport-code": "airport code with site number",
  "bare-airport-code": "airport code; another source confirms the country"
};

const km = (value: number) => `${Math.round(value).toLocaleString("en-US")} km`;

export const formatRadius = (radiusKm: number) => `±${km(radiusKm)}`;

/** Location column of the hop table. */
export const locationLabel = (hop: HopResolution): string => {
  const { best, anycast, alternatives } = hop.location;
  if (anycast) {
    return `Anycast (${anycast.service})`;
  }
  if (best) {
    return best.label;
  }
  if (hop.isPrivate) {
    return "Private";
  }
  if (hop.lookupState === "pending") {
    return "Resolving…";
  }
  if (alternatives.length > 0) {
    return "Unknown (RTT rules out every source)";
  }
  if (hop.asn?.country) {
    return `${hop.asn.country} (registry)`;
  }
  return "Unknown";
};

/**
 * What the speed-of-light check said about one estimate of hop `hopIndex`.
 * On the reference hop only the best estimate is the reference; the other
 * estimates of that hop are not checked.
 */
export const describeRtt = (
  check: RttCheck | null,
  hopIndex: number,
  onReferenceHop: boolean,
  isBest: boolean
): string => {
  if (!check) {
    if (onReferenceHop) {
      return isBest
        ? "Reference: the other hops are checked against this location."
        : "Not checked: this hop is the RTT reference.";
    }
    return "Not checked: no reference hop or no RTT yet.";
  }
  const limit = `at most ${km(check.maxDistanceKm)} from hop ${check.referenceHopIndex}`;
  const bound =
    check.boundHopIndex === hopIndex
      ? `${check.boundRttMs} ms`
      : `${check.boundRttMs} ms (hop ${check.boundHopIndex})`;
  switch (check.verdict) {
    case "feasible":
      return `Fits the RTT: ${bound} allows ${limit}.`;
    case "tightened":
      return `Radius tightened from ${km(check.originalRadiusKm)}: ${bound} allows ${limit}.`;
    case "widened":
      return `Radius widened from ${km(check.originalRadiusKm)}: ${bound} allows ${limit}, so the hop is beyond the stated radius.`;
    case "infeasible":
      return `Ruled out: ${km(check.distanceKm)} from hop ${check.referenceHopIndex}, but ${bound} allows ${limit}.`;
  }
};
