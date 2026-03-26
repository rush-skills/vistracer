import { describe, expect, it, beforeEach, vi } from "vitest";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import type { TracerouteProgressEvent, HopResolution } from "@common/ipc";

// Mock window.visTracer API
const mockApi = {
  runTraceroute: vi.fn(),
  cancelTraceroute: vi.fn()
};

Object.defineProperty(window, "visTracer", {
  value: mockApi,
  writable: true
});

const makeHop = (overrides: Partial<HopResolution> = {}): HopResolution => ({
  hopIndex: 1,
  ipAddress: "1.1.1.1",
  hostName: "test.example.com",
  lossPercent: 0,
  latency: { minRttMs: 10, maxRttMs: 12, avgRttMs: 11, jitterMs: 2 },
  geo: { latitude: 37.7749, longitude: -122.4194 },
  isPrivate: false,
  isAnycastSuspected: false,
  rawLine: " 1  test.example.com (1.1.1.1)  10 ms  11 ms  12 ms",
  ...overrides
});

describe("tracerouteStore", () => {
  beforeEach(() => {
    // Reset store to initial state
    useTracerouteStore.setState({
      runs: {},
      currentRunId: undefined,
      status: "idle",
      error: undefined,
      pendingRequest: undefined,
      selectedHopIndex: undefined,
      captureActive: false
    });
    vi.clearAllMocks();
  });

  describe("handleProgress", () => {
    it("creates a new run entry on first progress event", () => {
      const event: TracerouteProgressEvent = {
        runId: "test-run-1",
        hop: makeHop({ hopIndex: 1 }),
        completed: false,
        summary: {
          target: "8.8.8.8",
          startedAt: Date.now(),
          hopCount: 1,
          protocolsTried: ["ICMP"]
        }
      };

      useTracerouteStore.getState().handleProgress(event);
      const state = useTracerouteStore.getState();

      expect(state.runs["test-run-1"]).toBeDefined();
      expect(state.runs["test-run-1"].hops).toHaveLength(1);
      expect(state.currentRunId).toBe("test-run-1");
      expect(state.status).toBe("running");
    });

    it("merges new hops incrementally", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "test-run-2",
        hop: makeHop({ hopIndex: 1, ipAddress: "10.0.0.1" }),
        completed: false
      });

      handleProgress({
        runId: "test-run-2",
        hop: makeHop({ hopIndex: 2, ipAddress: "10.0.0.2" }),
        completed: false
      });

      handleProgress({
        runId: "test-run-2",
        hop: makeHop({ hopIndex: 3, ipAddress: "10.0.0.3" }),
        completed: false
      });

      const state = useTracerouteStore.getState();
      const run = state.runs["test-run-2"];
      expect(run.hops).toHaveLength(3);
      expect(run.hops[0].hopIndex).toBe(1);
      expect(run.hops[1].hopIndex).toBe(2);
      expect(run.hops[2].hopIndex).toBe(3);
    });

    it("replaces existing hop on enrichment update", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "test-run-3",
        hop: makeHop({ hopIndex: 1, ipAddress: "1.1.1.1", asn: undefined }),
        completed: false
      });

      // Enrichment update for same hop
      handleProgress({
        runId: "test-run-3",
        hop: makeHop({
          hopIndex: 1,
          ipAddress: "1.1.1.1",
          asn: { asn: 13335, name: "Cloudflare" }
        }),
        completed: true
      });

      const run = useTracerouteStore.getState().runs["test-run-3"];
      expect(run.hops).toHaveLength(1);
      expect(run.hops[0].asn?.name).toBe("Cloudflare");
    });

    it("sets status to success on completion", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "test-run-4",
        hop: makeHop({ hopIndex: 1 }),
        completed: false
      });

      handleProgress({
        runId: "test-run-4",
        completed: true,
        hops: [makeHop({ hopIndex: 1 })],
        summary: {
          target: "8.8.8.8",
          startedAt: Date.now(),
          completedAt: Date.now(),
          hopCount: 1,
          protocolsTried: ["ICMP"]
        }
      });

      expect(useTracerouteStore.getState().status).toBe("success");
    });

    it("sets status to error on failed completion", () => {
      const { handleProgress } = useTracerouteStore.getState();

      handleProgress({
        runId: "test-run-5",
        completed: true,
        error: "Traceroute failed: permission denied",
        summary: {
          target: "8.8.8.8",
          startedAt: Date.now(),
          hopCount: 0,
          protocolsTried: ["ICMP"],
          error: "Traceroute failed: permission denied"
        }
      });

      const state = useTracerouteStore.getState();
      expect(state.status).toBe("error");
      expect(state.error).toContain("permission denied");
    });
  });

  describe("setSelectedHop", () => {
    it("updates selected hop index", () => {
      useTracerouteStore.getState().setSelectedHop(5);
      expect(useTracerouteStore.getState().selectedHopIndex).toBe(5);
    });

    it("clears selection when set to undefined", () => {
      useTracerouteStore.getState().setSelectedHop(5);
      useTracerouteStore.getState().setSelectedHop(undefined);
      expect(useTracerouteStore.getState().selectedHopIndex).toBeUndefined();
    });
  });

  describe("cancelRun", () => {
    it("calls cancelTraceroute API with current run ID", async () => {
      useTracerouteStore.setState({ currentRunId: "run-to-cancel" });
      mockApi.cancelTraceroute.mockResolvedValue(undefined);

      await useTracerouteStore.getState().cancelRun();

      expect(mockApi.cancelTraceroute).toHaveBeenCalledWith("run-to-cancel");
    });

    it("does nothing when no current run", async () => {
      useTracerouteStore.setState({ currentRunId: undefined });

      await useTracerouteStore.getState().cancelRun();

      expect(mockApi.cancelTraceroute).not.toHaveBeenCalled();
    });
  });
});
