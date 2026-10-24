import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { HopResolution, TracerouteRun } from "@common/ipc";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { HopDetailsPane } from "../HopDetailsPane";

const latency = { minRttMs: 11.9, maxRttMs: 12.2, avgRttMs: 12.05, jitterMs: 0.3 };

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
  isAnycastSuspected: false,
  rawLine: " 1  72.14.204.170  11.9 ms\n    108.170.252.1  12.2 ms",
  providers: [
    { provider: "maxmind", status: "success", message: "Resolved from local GeoLite2 databases." },
    { provider: "team-cymru", status: "success", message: "Lookup complete." },
    { provider: "rdap", status: "error", message: "Server error (HTTP 500) after 3 attempts." },
    { provider: "ripe-stat", status: "success", message: "Loaded from cache.", cached: true },
    { provider: "peeringdb", status: "success", message: "Lookup complete." }
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
  responders: [{ ipAddress: "8.8.8.8", rttsMs: [4.1, 4.3] }],
  lossPercent: 0,
  latency: { minRttMs: 4.1, maxRttMs: 4.3, avgRttMs: 4.2, jitterMs: 0.2 },
  geo: { latitude: 37.751, longitude: -97.822, country: "United States" },
  asn: { asn: 15169, name: "GOOGLE" },
  isPrivate: false,
  isAnycastSuspected: false,
  rawLine: " 2  8.8.8.8  4.1 ms  4.3 ms",
  providers: [
    { provider: "peeringdb", status: "skipped", message: "Disabled in Integration settings." }
  ],
  lookupState: "complete"
};

const pendingHop: HopResolution = {
  hopIndex: 3,
  ipAddress: "203.0.113.7",
  responders: [{ ipAddress: "203.0.113.7", rttsMs: [20] }],
  lossPercent: 66.67,
  latency: { minRttMs: 20, maxRttMs: 20, avgRttMs: 20, jitterMs: null },
  isPrivate: false,
  isAnycastSuspected: false,
  rawLine: " 3  203.0.113.7  20 ms",
  lookupState: "pending"
};

const run: TracerouteRun = {
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
    hopCount: 3,
    protocolsTried: ["ICMP", "UDP"],
    notices: ["ICMP probes need raw-socket privileges on Linux, so VisTracer ran this trace again with UDP probes."]
  },
  hops: [multipathHop, unenrichedHop, pendingHop]
};

const inspector = (hopIndex: number) => screen.getByLabelText(`Hop ${hopIndex} details`);

describe("HopDetailsPane", () => {
  beforeEach(() => {
    useTracerouteStore.setState({ selectedHopIndex: undefined });
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

  it("selects a hop when its row is clicked", () => {
    render(<HopDetailsPane run={run} status="success" />);
    const row = screen.getAllByRole("button").find((el) => el.textContent?.includes("8.8.8.8"));
    expect(row).toBeTruthy();
    fireEvent.click(row as HTMLElement);
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);
  });
});
