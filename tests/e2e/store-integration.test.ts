/**
 * E2E tests for store behavior and state management integration.
 * Tests the Zustand store interactions with the Tauri bridge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Import bridge first to register window.visTracer
import "../../src/common/bridge";
import {
  useTracerouteStore,
  selectCurrentRun,
  selectCurrentHop,
} from "../../src/renderer/state/tracerouteStore";
import type { TracerouteRun, HopResolution } from "../../src/common/ipc";

function makeHop(index: number, ip: string | null): HopResolution {
  return {
    hopIndex: index,
    ipAddress: ip,
    hostName: ip ? `host-${index}` : undefined,
    lossPercent: ip ? 0 : 100,
    latency: {
      minRttMs: ip ? index * 5 : null,
      maxRttMs: ip ? index * 5 + 2 : null,
      avgRttMs: ip ? index * 5 + 1 : null,
      jitterMs: ip ? 2 : null,
    },
    geo: ip
      ? {
          latitude: 40 + index,
          longitude: -74 + index,
          city: `City ${index}`,
          country: "US",
        }
      : undefined,
    asn: ip
      ? { asn: 1000 + index, name: `ISP ${index}` }
      : undefined,
    isPrivate: false,
    isAnycastSuspected: false,
    rawLine: `${index}  ${ip ?? "* * *"}`,
  };
}

function makeRun(target: string, hops: HopResolution[]): TracerouteRun {
  return {
    request: {
      target,
      protocol: "ICMP",
      maxHops: 30,
      timeoutMs: 4000,
      packetCount: 3,
      forceFresh: false,
    },
    summary: {
      target,
      startedAt: Date.now(),
      completedAt: Date.now() + 5000,
      hopCount: hops.length,
      protocolsTried: ["ICMP"],
    },
    hops,
  };
}

describe("Store Integration", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    useTracerouteStore.setState({
      runs: {},
      currentRunId: undefined,
      status: "idle",
      error: undefined,
      pendingRequest: undefined,
      selectedHopIndex: undefined,
      captureActive: false,
    });
  });

  describe("selectCurrentRun", () => {
    it("returns undefined when no run is active", () => {
      const state = useTracerouteStore.getState();
      expect(selectCurrentRun(state)).toBeUndefined();
    });

    it("returns the current run when one is active", () => {
      const run = makeRun("8.8.8.8", [makeHop(1, "10.0.0.1")]);
      useTracerouteStore.setState({
        runs: { "run-1": run },
        currentRunId: "run-1",
      });

      const state = useTracerouteStore.getState();
      expect(selectCurrentRun(state)).toBe(run);
    });
  });

  describe("selectCurrentHop", () => {
    it("returns undefined when no hop is selected", () => {
      const state = useTracerouteStore.getState();
      expect(selectCurrentHop(state)).toBeUndefined();
    });

    it("returns the selected hop", () => {
      const hop1 = makeHop(1, "10.0.0.1");
      const hop2 = makeHop(2, "8.8.8.8");
      const run = makeRun("8.8.8.8", [hop1, hop2]);

      useTracerouteStore.setState({
        runs: { "run-1": run },
        currentRunId: "run-1",
        selectedHopIndex: 2,
      });

      const state = useTracerouteStore.getState();
      const selected = selectCurrentHop(state);
      expect(selected?.hopIndex).toBe(2);
      expect(selected?.ipAddress).toBe("8.8.8.8");
    });
  });

  describe("setSelectedHop", () => {
    it("updates the selected hop index", () => {
      useTracerouteStore.getState().setSelectedHop(5);
      expect(useTracerouteStore.getState().selectedHopIndex).toBe(5);
    });

    it("clears the selected hop with undefined", () => {
      useTracerouteStore.getState().setSelectedHop(5);
      useTracerouteStore.getState().setSelectedHop(undefined);
      expect(useTracerouteStore.getState().selectedHopIndex).toBeUndefined();
    });
  });

  describe("setCaptureActive", () => {
    it("sets capture active state", () => {
      useTracerouteStore.getState().setCaptureActive(true);
      expect(useTracerouteStore.getState().captureActive).toBe(true);

      useTracerouteStore.getState().setCaptureActive(false);
      expect(useTracerouteStore.getState().captureActive).toBe(false);
    });
  });

  describe("resetError", () => {
    it("clears the error state", () => {
      useTracerouteStore.setState({ error: "Some error" });
      useTracerouteStore.getState().resetError();
      expect(useTracerouteStore.getState().error).toBeUndefined();
    });
  });

  describe("completeRun", () => {
    it("adds a completed run to the registry", () => {
      const run = makeRun("8.8.8.8", [makeHop(1, "10.0.0.1"), makeHop(2, "8.8.8.8")]);

      useTracerouteStore.getState().completeRun({
        runId: "completed-run",
        run,
      });

      const state = useTracerouteStore.getState();
      expect(state.runs["completed-run"]).toBeDefined();
      expect(state.currentRunId).toBe("completed-run");
      expect(state.status).toBe("success");
    });

    it("sets error status when run has an error", () => {
      const run = makeRun("bad.host", []);
      run.summary.error = "Host not found";

      useTracerouteStore.getState().completeRun({
        runId: "error-run",
        run,
      });

      const state = useTracerouteStore.getState();
      expect(state.status).toBe("error");
      expect(state.error).toBe("Host not found");
    });
  });

  describe("handleProgress - hop merging", () => {
    it("merges updated hop data (enrichment)", () => {
      const { handleProgress } = useTracerouteStore.getState();

      // Initial hop
      handleProgress({
        runId: "run-merge",
        completed: false,
        summary: { target: "8.8.8.8", startedAt: 1000, hopCount: 0, protocolsTried: ["ICMP"] },
      });

      handleProgress({
        runId: "run-merge",
        hop: makeHop(1, "10.0.0.1"),
        completed: false,
      });

      // Enriched version of same hop
      const enrichedHop = {
        ...makeHop(1, "10.0.0.1"),
        asn: { asn: 15169, name: "Google LLC", network: "10.0.0.0/8" },
        peeringDb: { name: "Google", city: "Mountain View", country: "US" },
      };

      handleProgress({
        runId: "run-merge",
        hop: enrichedHop,
        completed: false,
      });

      const state = useTracerouteStore.getState();
      const hops = state.runs["run-merge"].hops;
      expect(hops).toHaveLength(1); // Should have merged, not duplicated
      expect(hops[0].asn?.name).toBe("Google LLC");
      expect(hops[0].peeringDb?.name).toBe("Google");
    });
  });

  describe("startRun via API", () => {
    it("calls the Tauri backend and transitions status", async () => {
      const runResult = {
        runId: "api-run",
        run: makeRun("1.1.1.1", [makeHop(1, "1.1.1.1")]),
      };
      mockInvoke.mockResolvedValueOnce(runResult);

      const result = await useTracerouteStore.getState().startRun({
        target: "1.1.1.1",
        protocol: "ICMP",
        maxHops: 30,
        timeoutMs: 4000,
        packetCount: 3,
        forceFresh: false,
      });

      expect(result).toBeDefined();
      expect(result?.runId).toBe("api-run");

      const state = useTracerouteStore.getState();
      expect(state.currentRunId).toBe("api-run");
      expect(state.status).toBe("success");
    });

    it("handles API errors", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("Network error"));

      const result = await useTracerouteStore.getState().startRun({
        target: "unreachable.test",
        protocol: "ICMP",
        maxHops: 30,
        timeoutMs: 4000,
        packetCount: 3,
        forceFresh: false,
      });

      expect(result).toBeUndefined();

      const state = useTracerouteStore.getState();
      expect(state.status).toBe("error");
      expect(state.error).toContain("Network error");
    });
  });

  describe("IPv6 target handling", () => {
    it("handles IPv6 targets in progress events", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "ipv6-run",
        completed: false,
        summary: { target: "2001:4860:4860::8888", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
      });

      handleProgress({
        runId: "ipv6-run",
        hop: {
          hopIndex: 1,
          ipAddress: "2001:db8::1",
          hostName: "router.v6.example.com",
          lossPercent: 0,
          latency: { minRttMs: 1, maxRttMs: 3, avgRttMs: 2, jitterMs: 2 },
          geo: { latitude: 37.7749, longitude: -122.4194, city: "San Francisco", country: "US" },
          asn: { asn: 15169, name: "Google" },
          isPrivate: false,
          isAnycastSuspected: false,
          rawLine: "1  2001:db8::1  2 ms",
        },
        completed: true,
        summary: {
          target: "2001:4860:4860::8888",
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          hopCount: 1,
          protocolsTried: ["ICMP"],
        },
        hops: [
          {
            hopIndex: 1,
            ipAddress: "2001:db8::1",
            hostName: "router.v6.example.com",
            lossPercent: 0,
            latency: { minRttMs: 1, maxRttMs: 3, avgRttMs: 2, jitterMs: 2 },
            geo: { latitude: 37.7749, longitude: -122.4194, city: "San Francisco", country: "US" },
            asn: { asn: 15169, name: "Google" },
            isPrivate: false,
            isAnycastSuspected: false,
            rawLine: "1  2001:db8::1  2 ms",
          },
        ],
      });

      const state = useTracerouteStore.getState();
      expect(state.status).toBe("success");
      expect(state.runs["ipv6-run"].summary.target).toBe("2001:4860:4860::8888");
      expect(state.runs["ipv6-run"].hops[0].ipAddress).toBe("2001:db8::1");
    });
  });

  describe("Private IP handling", () => {
    it("marks private IPs correctly in hops", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "private-run",
        completed: false,
        summary: { target: "example.com", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
      });

      // Private hop (no geo data)
      handleProgress({
        runId: "private-run",
        hop: {
          hopIndex: 1,
          ipAddress: "192.168.1.1",
          lossPercent: 0,
          latency: { minRttMs: 0.5, maxRttMs: 1, avgRttMs: 0.75, jitterMs: 0.5 },
          isPrivate: true,
          isAnycastSuspected: false,
          rawLine: "1  192.168.1.1  0.75 ms",
        },
        completed: false,
      });

      // Public hop (has geo)
      handleProgress({
        runId: "private-run",
        hop: makeHop(2, "8.8.8.8"),
        completed: true,
        summary: {
          target: "example.com",
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          hopCount: 2,
          protocolsTried: ["ICMP"],
        },
        hops: [
          {
            hopIndex: 1,
            ipAddress: "192.168.1.1",
            lossPercent: 0,
            latency: { minRttMs: 0.5, maxRttMs: 1, avgRttMs: 0.75, jitterMs: 0.5 },
            isPrivate: true,
            isAnycastSuspected: false,
            rawLine: "1  192.168.1.1  0.75 ms",
          },
          makeHop(2, "8.8.8.8"),
        ],
      });

      const state = useTracerouteStore.getState();
      expect(state.runs["private-run"].hops[0].isPrivate).toBe(true);
      expect(state.runs["private-run"].hops[0].geo).toBeUndefined();
      expect(state.runs["private-run"].hops[1].isPrivate).toBe(false);
      expect(state.runs["private-run"].hops[1].geo).toBeDefined();
    });
  });
});
