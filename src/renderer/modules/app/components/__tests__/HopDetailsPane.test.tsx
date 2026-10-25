import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { HopLocation, HopResolution, LocationEstimate, TracerouteRun } from "@common/ipc";
import { useInfraStore } from "@renderer/state/infraStore";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { CLOUD, INFRA_CODE, PEERINGDB } from "@renderer/test/infraFixtures";
import { HopDetailsPane } from "../HopDetailsPane";

const latency = { minRttMs: 11.9, maxRttMs: 12.2, avgRttMs: 12.05, jitterMs: 0.3 };

const noLocation: HopLocation = {
  best: null,
  alternatives: [],
  ixp: null,
  hostnameHint: null,
  anycast: null,
  isRttReference: false
};

const usCentroidRuledOut = (boundRttMs: number, maxDistanceKm: number): LocationEstimate => ({
  source: "geolite-country",
  latitude: 37.751,
  longitude: -97.822,
  radiusKm: 1000,
  confidence: "low",
  label: "United States",
  rtt: {
    verdict: "infeasible",
    distanceKm: 13500,
    maxDistanceKm,
    originalRadiusKm: 1000,
    referenceHopIndex: 1,
    referenceSource: "geolite-city",
    boundHopIndex: 2,
    boundRttMs
  }
});

const multipathHop: HopResolution = {
  hopIndex: 1,
  ipAddress: "72.14.204.170",
  hostName: "edge.example.net",
  responders: [
    { ipAddress: "72.14.204.170", hostName: "edge.example.net", rttsMs: [11.9] },
    { ipAddress: "108.170.252.1", hostName: "alt.example.net", rttsMs: [12.2] }
  ],
  lossPercent: 33.33,
  latency,
  geo: { latitude: 19.07, longitude: 72.87, city: "Mumbai", country: "India" },
  asn: { asn: 15169, name: "GOOGLE", network: "72.14.192.0/18", registry: "arin", country: "US" },
  isPrivate: false,
  location: {
    ...noLocation,
    best: {
      source: "geolite-city",
      latitude: 19.07,
      longitude: 72.87,
      radiusKm: 20,
      confidence: "medium",
      label: "Mumbai, India",
      rtt: null
    },
    alternatives: [
      {
        source: "geolite-country",
        latitude: 22,
        longitude: 79,
        radiusKm: 1000,
        confidence: "low",
        label: "India",
        rtt: null
      }
    ],
    isRttReference: true
  },
  rawLine: " 1  72.14.204.170  11.9 ms\n    108.170.252.1  12.2 ms",
  providers: [
    { provider: "maxmind", status: "success", message: "Resolved from local GeoLite2 databases.", cached: false },
    { provider: "team-cymru", status: "success", message: "Lookup complete.", cached: false },
    { provider: "rdap", status: "error", message: "Server error (HTTP 500) after 3 attempts.", cached: false },
    { provider: "ripe-stat", status: "success", message: "Loaded from cache.", cached: true },
    { provider: "peeringdb", status: "success", message: "Lookup complete.", cached: false }
  ],
  peeringDb: {
    id: 433,
    name: "Google LLC",
    infoType: "Content",
    infoScope: "Global",
    policyGeneral: "Selective",
    ixCount: 160,
    facCount: 135
  },
  lookupState: "complete"
};

const unenrichedHop: HopResolution = {
  hopIndex: 2,
  ipAddress: "8.8.8.8",
  hostName: null,
  responders: [{ ipAddress: "8.8.8.8", hostName: null, rttsMs: [4.1, 4.3] }],
  lossPercent: 0,
  latency: { minRttMs: 4.1, maxRttMs: 4.3, avgRttMs: 4.2, jitterMs: 0.2 },
  geo: { latitude: 37.751, longitude: -97.822, country: "United States" },
  asn: { asn: 15169, name: "GOOGLE" },
  isPrivate: false,
  location: {
    ...noLocation,
    alternatives: [usCentroidRuledOut(4.1, 1599)],
    anycast: {
      evidence: "known-prefix",
      service: "Google Public DNS",
      geoliteRuledOut: true,
      maxDistanceKm: 1599,
      referenceHopIndex: 1
    }
  },
  rawLine: " 2  8.8.8.8  4.1 ms  4.3 ms",
  providers: [
    { provider: "peeringdb", status: "skipped", message: "Disabled in Integration settings.", cached: false }
  ],
  lookupState: "complete"
};

const pendingHop: HopResolution = {
  hopIndex: 3,
  ipAddress: "203.0.113.7",
  hostName: null,
  responders: [{ ipAddress: "203.0.113.7", hostName: null, rttsMs: [20] }],
  lossPercent: 66.67,
  latency: { minRttMs: 20, maxRttMs: 20, avgRttMs: 20, jitterMs: null },
  isPrivate: false,
  location: noLocation,
  rawLine: " 3  203.0.113.7  20 ms",
  lookupState: "pending"
};

const ixpHop: HopResolution = {
  hopIndex: 4,
  ipAddress: "80.81.192.96",
  hostName: "de-cix.openpeering.nl",
  responders: [{ ipAddress: "80.81.192.96", hostName: "de-cix.openpeering.nl", rttsMs: [138.88] }],
  lossPercent: 0,
  latency: { minRttMs: 138.88, maxRttMs: 138.88, avgRttMs: 138.88, jitterMs: null },
  geo: { latitude: 51.3, longitude: 9.49, country: "Germany", confidence: 200 },
  isPrivate: false,
  location: {
    ...noLocation,
    best: {
      source: "ixp",
      latitude: 50.11,
      longitude: 8.69,
      radiusKm: 111,
      confidence: "high",
      label: "DE-CIX Frankfurt",
      rtt: {
        verdict: "feasible",
        distanceKm: 6560,
        maxDistanceKm: 14409,
        originalRadiusKm: 111,
        referenceHopIndex: 1,
        referenceSource: "geolite-city",
        boundHopIndex: 4,
        boundRttMs: 138.88
      }
    },
    alternatives: [
      {
        source: "geolite-country",
        latitude: 51.3,
        longitude: 9.49,
        radiusKm: 200,
        confidence: "low",
        label: "Germany",
        rtt: null
      }
    ],
    ixp: {
      ixId: 31,
      name: "DE-CIX Frankfurt",
      city: "Frankfurt",
      country: "DE",
      prefix: "80.81.192.0/21",
      facilityCount: 26
    }
  },
  rawLine: " 4  80.81.192.96  138.88 ms",
  lookupState: "complete"
};

const hintHop: HopResolution = {
  hopIndex: 5,
  ipAddress: "154.54.56.85",
  hostName: "be9653.ccr82.lon05.atlas.cogentco.com",
  responders: [
    { ipAddress: "154.54.56.85", hostName: "be9653.ccr82.lon05.atlas.cogentco.com", rttsMs: [160] }
  ],
  lossPercent: 0,
  latency: { minRttMs: 160, maxRttMs: 160, avgRttMs: 160, jitterMs: null },
  isPrivate: false,
  location: {
    ...noLocation,
    best: {
      source: "hostname-hint",
      latitude: 51.5,
      longitude: 0.05,
      radiusKm: 50,
      confidence: "high",
      label: "London, GB",
      rtt: {
        verdict: "feasible",
        distanceKm: 7200,
        maxDistanceKm: 16122,
        originalRadiusKm: 50,
        referenceHopIndex: 1,
        referenceSource: "geolite-city",
        boundHopIndex: 6,
        boundRttMs: 155.32
      }
    },
    hostnameHint: {
      hostName: "be9653.ccr82.lon05.atlas.cogentco.com",
      token: "lon05",
      rule: "airport-code",
      carrier: "Cogent",
      iata: "LCY",
      place: "London, GB"
    }
  },
  rawLine: " 5  154.54.56.85  160 ms",
  lookupState: "complete"
};

const ruledOutHop: HopResolution = {
  hopIndex: 6,
  ipAddress: "72.14.216.192",
  hostName: null,
  responders: [{ ipAddress: "72.14.216.192", hostName: null, rttsMs: [10.05] }],
  lossPercent: 0,
  latency: { minRttMs: 10.05, maxRttMs: 10.05, avgRttMs: 10.05, jitterMs: null },
  isPrivate: false,
  location: { ...noLocation, alternatives: [usCentroidRuledOut(10.05, 1564)] },
  rawLine: " 6  72.14.216.192  10.05 ms",
  lookupState: "complete"
};

const unknownHop: HopResolution = {
  ...ruledOutHop,
  hopIndex: 7,
  ipAddress: "45.10.20.30",
  responders: [{ ipAddress: "45.10.20.30", hostName: null, rttsMs: [12] }],
  location: noLocation,
  rawLine: " 7  45.10.20.30  12 ms"
};

const privateHop: HopResolution = {
  ...unknownHop,
  hopIndex: 8,
  ipAddress: "10.0.0.1",
  responders: [{ ipAddress: "10.0.0.1", hostName: null, rttsMs: [1] }],
  isPrivate: true,
  rawLine: " 8  10.0.0.1  1 ms"
};

const baseRun: TracerouteRun = {
  request: {
    target: "8.8.8.8",
    protocol: "ICMP",
    maxHops: 30,
    timeoutMs: 4000,
    packetCount: 3,
    forceFresh: false
  },
  summary: {
    target: "8.8.8.8",
    startedAt: 0,
    hopCount: 8,
    protocolsTried: ["ICMP", "UDP"],
    notices: ["ICMP probes need raw-socket privileges on Linux, so VisTracer ran this trace again with UDP probes."]
  },
  hops: [multipathHop, unenrichedHop, pendingHop, ixpHop, hintHop, ruledOutHop, unknownHop, privateHop]
};
const run = baseRun;

const inspector = (hopIndex: number) => screen.getByLabelText(`Hop ${hopIndex} details`);

const locationOf = (hopIndex: number) => within(within(inspector(hopIndex)).getByLabelText("Location"));

/** The <dd> that follows the <dt> with `term`. */
const fact = (scope: ReturnType<typeof within>, term: string) =>
  scope.getByText(term, { selector: "dt" }).nextElementSibling?.textContent;

describe("HopDetailsPane", () => {
  beforeEach(() => {
    useTracerouteStore.setState({ selectedHopIndex: undefined, hoveredHopIndex: undefined });
  });

  it("marks multipath hops, failed sources and run notices in the table", () => {
    render(<HopDetailsPane run={run} status="success" />);
    expect(screen.getByText("+1 path")).toBeTruthy();
    expect(screen.getByText("1 source failed").getAttribute("title")).toBe(
      "RDAP: Server error (HTTP 500) after 3 attempts."
    );
    expect(screen.getByText(/ran this trace again with UDP probes/)).toBeTruthy();
    expect(screen.getByText("Resolving…")).toBeTruthy();
  });

  it("lists every responder and real PeeringDB fields for the selected hop", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={1} status="success" />);
    const details = within(inspector(1));

    expect(details.getByText("Responders (2 paths)")).toBeTruthy();
    expect(details.getByText("72.14.204.170")).toBeTruthy();
    expect(details.getByText("108.170.252.1")).toBeTruthy();
    expect(details.getByText("alt.example.net")).toBeTruthy();
    expect(details.getByText("12.2 ms")).toBeTruthy();

    const peeringDb = within(details.getByLabelText("PeeringDB"));
    expect(peeringDb.getByText("Content")).toBeTruthy();
    expect(peeringDb.getByText("Selective")).toBeTruthy();
    expect(peeringDb.getByText("160")).toBeTruthy();
    expect(peeringDb.getByText("135")).toBeTruthy();
    expect(peeringDb.getByText("net #433")).toBeTruthy();

    const sources = within(details.getByLabelText("Sources"));
    expect(sources.getByText("failed")).toBeTruthy();
    expect(sources.getByText("Server error (HTTP 500) after 3 attempts.")).toBeTruthy();
    expect(sources.getByText("success (cached)")).toBeTruthy();
  });

  it("explains why PeeringDB has no data", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={2} status="success" />);
    const details = within(inspector(2));
    expect(
      details.getByText("PeeringDB not queried: Disabled in Integration settings.")
    ).toBeTruthy();
  });

  it("shows a pending state while lookups run", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={3} status="running" />);
    const details = within(inspector(3));
    expect(details.getByText("resolving…")).toBeTruthy();
    expect(within(details.getByLabelText("PeeringDB")).getByText("Looking up…")).toBeTruthy();
  });

  it("shows the chosen location, its confidence and anycast in the table", () => {
    render(<HopDetailsPane run={run} status="success" />);
    const row = (text: string) =>
      screen.getAllByRole("button").find((el) => el.textContent?.includes(text)) as HTMLElement;

    expect(within(row("80.81.192.96")).getByText("DE-CIX Frankfurt")).toBeTruthy();
    expect(row("80.81.192.96").textContent).toContain("high ±111 km");
    expect(within(row("80.81.192.96")).getByTitle("Source: Internet exchange")).toBeTruthy();
    expect(row("154.54.56.85").textContent).toContain("London, GB");
    expect(within(row("8.8.8.8")).getByText("Anycast (Google Public DNS)")).toBeTruthy();
    expect(within(row("8.8.8.8")).getByText("anycast")).toBeTruthy();
    expect(row("72.14.216.192").textContent).toContain("Unknown (fails the RTT check)");
  });

  it("explains an IXP placement with source, confidence, radius and RTT check", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={4} status="success" />);
    const location = locationOf(4);
    expect(fact(location, "Place")).toBe("DE-CIX Frankfurt");
    expect(fact(location, "Source")).toBe("Internet exchange");
    expect(fact(location, "Confidence")).toBe("high");
    expect(fact(location, "Radius")).toBe("±111 km");
    expect(fact(location, "RTT check")).toBe(
      "Fits the RTT: 138.88 ms allows at most 14,409 km from hop 1's GeoLite2 city estimate."
    );
    expect(fact(location, "IXP")).toBe(
      "DE-CIX Frankfurt80.81.192.0/21 · Frankfurt, DE · 26 facilities"
    );
    expect(location.getByText("Other candidates (1)")).toBeTruthy();
    expect(location.getByText("Germany")).toBeTruthy();
  });

  it("does not claim a city placement for an IX without facility coordinates", () => {
    const ixp = ixpHop.location.ixp;
    if (!ixp) throw new Error("fixture has an IXP");
    const noFacilities: HopResolution = {
      ...ixpHop,
      location: { ...ixpHop.location, ixp: { ...ixp, facilityCount: 0 } }
    };
    render(
      <HopDetailsPane
        run={{ ...run, hops: [noFacilities] }}
        selectedHopIndex={4}
        status="success"
      />
    );
    expect(fact(locationOf(4), "IXP")).toBe(
      "DE-CIX Frankfurt80.81.192.0/21 · Frankfurt, DE · no facility coordinates"
    );
  });

  it("shows the host name hint and an RTT bound from a later hop", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={5} status="success" />);
    const location = locationOf(5);
    expect(fact(location, "Source")).toBe("Host name");
    expect(fact(location, "Host name hint")).toBe(
      "lon05 → London, GBairport code with site number · Cogent naming"
    );
    expect(fact(location, "RTT check")).toBe(
      "Fits the RTT: 155.32 ms (hop 6) allows at most 16,122 km from hop 1's GeoLite2 city estimate."
    );
    expect(location.queryByText(/Other candidates/)).toBeNull();
  });

  it("keeps a candidate that conflicts with the reference and says why", () => {
    const best = hintHop.location.best;
    const rtt = best?.rtt;
    if (!best || !rtt) throw new Error("fixture has a checked best estimate");
    const conflicting: HopResolution = {
      ...hintHop,
      location: {
        ...hintHop.location,
        best: {
          ...best,
          rtt: { ...rtt, verdict: "conflict", distanceKm: 1139, maxDistanceKm: 840 }
        }
      }
    };
    render(
      <HopDetailsPane run={{ ...run, hops: [conflicting] }} selectedHopIndex={5} status="success" />
    );
    const location = locationOf(5);
    expect(fact(location, "Place")).toBe("London, GB");
    expect(fact(location, "RTT check")).toBe(
      "Conflicts with hop 1's GeoLite2 city estimate: 1,139 km away, but 155.32 ms (hop 6) allows at most 840 km. Kept, because this source is at least as strong as that estimate; one of the two is wrong."
    );
    const row = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.includes("154.54.56.85")) as HTMLElement;
    expect(within(row).getByText("conflict")).toBeTruthy();
  });

  it("marks anycast hops and draws no point for them", () => {
    render(<HopDetailsPane run={run} selectedHopIndex={2} status="success" />);
    const location = locationOf(2);
    const notice = location.getByRole("note").textContent ?? "";
    expect(notice).toContain("Anycast.");
    expect(notice).toContain("the globe shows no point for this hop");
    expect(notice).toContain("Google Public DNS documents this prefix as anycast.");
    expect(notice).toContain("at most 1,599 km from hop 1");
    expect(notice).toContain("The RTT also rules out the GeoLite2 location.");
    expect(location.queryByText("Place")).toBeNull();
    expect(location.getByText("Candidates (1)")).toBeTruthy();
    expect(
      location.getByText(
        "Ruled out against hop 1's GeoLite2 city estimate: 13,500 km away, but 4.1 ms allows at most 1,599 km."
      )
    ).toBeTruthy();
  });

  it("gives honest empty states for the location", () => {
    const { unmount } = render(<HopDetailsPane run={run} selectedHopIndex={6} status="success" />);
    expect(
      locationOf(6).getByText(
        "Every source is weaker than hop 1's estimate and fails the RTT check against it, so the globe shows no point for this hop."
      )
    ).toBeTruthy();
    unmount();

    const cases: Array<[number, string]> = [
      [3, "Looking up…"],
      [7, "No location source has data for this address, so the globe shows no point for this hop."],
      [8, "Private address: it has no public location."]
    ];
    for (const [hopIndex, text] of cases) {
      const view = render(<HopDetailsPane run={run} selectedHopIndex={hopIndex} status="success" />);
      expect(locationOf(hopIndex).getByText(text)).toBeTruthy();
      view.unmount();
    }

    render(<HopDetailsPane run={run} selectedHopIndex={1} status="success" />);
    expect(fact(locationOf(1), "RTT check")).toBe(
      "Reference: the other hops are checked against this location."
    );
    expect(locationOf(1).getByText("Not checked: this hop is the RTT reference.")).toBeTruthy();
  });

  it("selects a hop when its row is clicked", () => {
    render(<HopDetailsPane run={run} status="success" />);
    const row = screen.getAllByRole("button").find((el) => el.textContent?.includes("8.8.8.8"));
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);

    // Not while an animated export records: its flight would be recorded.
    const other = screen
      .getAllByRole("button")
      .find((el) => el.textContent?.includes("80.81.192.96")) as HTMLElement;
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    try {
      fireEvent.click(other);
      fireEvent.keyDown(other, { key: "Enter" });
      expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);
    } finally {
      act(() => useTracerouteStore.getState().setCaptureActive(false));
    }
  });

  it("shares the hovered hop with the globe in both directions", () => {
    const { rerender } = render(<HopDetailsPane run={run} status="success" />);
    const rowOf = (ip: string) =>
      screen.getAllByRole("button").find((el) => el.textContent?.includes(ip)) as HTMLElement;

    fireEvent.mouseEnter(rowOf("8.8.8.8"));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBe(2);
    fireEvent.mouseLeave(rowOf("8.8.8.8"));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBeUndefined();
    fireEvent.focus(rowOf("8.8.8.8"));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBe(2);
    fireEvent.blur(rowOf("8.8.8.8"));

    // A hop hovered on the globe is highlighted in the table.
    act(() => useTracerouteStore.getState().setHoveredHop(1));
    rerender(<HopDetailsPane run={run} status="success" />);
    expect(rowOf("72.14.204.170").className).toContain("hop-details__row--hovered");
    expect(rowOf("8.8.8.8").className).not.toContain("hop-details__row--hovered");
  });

  it("keeps the focus on the toggle when the pane collapses and expands", () => {
    render(<HopDetailsPane run={run} status="success" />);
    const hide = screen.getByRole("button", { name: "Hide hop details" });
    hide.focus();
    fireEvent.click(hide);
    const show = screen.getByRole("button", { name: "Show hop details" });
    expect(show.textContent).toContain("Hops (8)");
    expect(document.activeElement).toBe(show);
    fireEvent.click(show);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Hide hop details" }));
  });

  it("scrolls a hop selected on the globe into view", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      const { rerender } = render(<HopDetailsPane run={run} status="success" />);
      rerender(<HopDetailsPane run={run} selectedHopIndex={2} status="success" />);
      expect(scrolled).toHaveLength(1);
      expect(scrolled[0]).toContain("8.8.8.8");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("says which cloud region and data centre a hop is likely in, while those layers are on", () => {
    const awsHop: HopResolution = {
      ...multipathHop,
      hopIndex: 6,
      asn: { asn: 16509, name: "AMAZON-02" },
      location: {
        ...noLocation,
        best: { ...(multipathHop.location.best as LocationEstimate), latitude: 50.1, longitude: 8.7, label: "Frankfurt", radiusKm: 50, confidence: "high" }
      }
    };
    const run: TracerouteRun = { ...baseRun, hops: [awsHop] };
    useInfraStore.setState({
      code: INFRA_CODE,
      sources: {
        "peeringdb-sites": { status: "ready", data: PEERINGDB },
        "cloud-regions": { status: "ready", data: CLOUD },
        "submarine-cables": { status: "idle" }
      }
    });
    useTracerouteStore.setState({ runs: { r: run }, currentRunId: "r" });
    act(() => useUiStore.setState({ layers: {} }));
    const { rerender } = render(<HopDetailsPane run={run} selectedHopIndex={6} status="success" />);
    expect(screen.queryByRole("region", { name: "Infrastructure" })).toBeNull();

    act(() => useUiStore.setState({ layers: { "cloud-regions": true, "data-centres": true } }));
    rerender(<HopDetailsPane run={run} selectedHopIndex={6} status="success" />);
    const section = screen.getByRole("region", { name: "Infrastructure" });
    expect(section.textContent).toContain("AWS eu-central-1");
    expect(section.textContent).toContain("high");
    expect(section.textContent).toContain("AS16509 is Amazon's network");
    expect(section.textContent).toContain("Digital Realty Frankfurt FRA1-27");
  });

  it("colours each hop's dot like its marker: by network while network colours are on", () => {
    act(() => useUiStore.setState({ layers: {} }));
    const { rerender } = render(<HopDetailsPane run={run} status="success" />);
    const dot = () =>
      (document.querySelector(".hop-details__dot") as HTMLElement | null)?.style.backgroundColor;
    const before = dot();
    expect(before).toBeTruthy();
    act(() => useUiStore.setState({ layers: { "asn-colors": true } }));
    rerender(<HopDetailsPane run={run} status="success" />);
    expect(dot()).not.toBe(before);
  });
});
