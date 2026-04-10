/**
 * E2E tests for the full traceroute flow.
 * Simulates the complete lifecycle: start run -> progress events -> completion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, callback: (event: { payload: unknown }) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(callback);
      return Promise.resolve(() => {
        const listeners = eventListeners.get(event);
        if (listeners) {
          const idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        }
      });
    }
  ),
}));

function emitEvent(event: string, payload: unknown) {
  const listeners = eventListeners.get(event) ?? [];
  for (const listener of listeners) {
    listener({ payload });
  }
}

// Import bridge first to register window.visTracer
import "../../src/common/bridge";
// Import store after mocks
import { useTracerouteStore } from "../../src/renderer/state/tracerouteStore";
import type { TracerouteProgressEvent, HopResolution } from "../../src/common/ipc";

function createMockHop(index: number, ip: string, avgRtt: number): HopResolution {
  return {
    hopIndex: index,
    ipAddress: ip,
    hostName: `hop-${index}.example.com`,
    lossPercent: 0,
    latency: {
      minRttMs: avgRtt - 1,
      maxRttMs: avgRtt + 1,
      avgRttMs: avgRtt,
      jitterMs: 2,
    },
    geo: {
      latitude: 37.7749 + index * 2,
      longitude: -122.4194 + index * 5,
      city: `City ${index}`,
      country: "US",
      isoCode: "US",
    },
    asn: {
      asn: 15169 + index,
      name: `AS${15169 + index}`,
      network: `${ip}/24`,
    },
    isPrivate: false,
    isAnycastSuspected: false,
    rawLine: `${index}  ${ip}  ${avgRtt} ms`,
    providers: [
      { provider: "maxmind", status: "success", message: "Resolved locally." },
    ],
  };
}

describe("Full Traceroute Flow", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    eventListeners.clear();
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("processes a complete traceroute with progressive hop updates", () => {
    const runId = "test-run-001";
    const target = "8.8.8.8";
    const { handleProgress } = useTracerouteStore.getState();

    // Simulate progress events that would come from the Tauri backend
    handleProgress({
      runId,
      completed: false,
      summary: {
        target,
        startedAt: Date.now(),
        hopCount: 0,
        protocolsTried: ["ICMP"],
      },
    });

    // Verify run was registered
    let state = useTracerouteStore.getState();
    expect(state.currentRunId).toBe(runId);
    expect(state.status).toBe("running");

    // Simulate hop 1 arriving
    handleProgress({
      runId,
      hop: createMockHop(1, "10.0.0.1", 1.5),
      completed: false,
    });

    state = useTracerouteStore.getState();
    expect(state.runs[runId].hops).toHaveLength(1);
    expect(state.runs[runId].hops[0].ipAddress).toBe("10.0.0.1");
    expect(state.selectedHopIndex).toBe(1);

    // Simulate hop 2 arriving
    handleProgress({
      runId,
      hop: createMockHop(2, "192.168.1.1", 5.3),
      completed: false,
    });

    state = useTracerouteStore.getState();
    expect(state.runs[runId].hops).toHaveLength(2);
    expect(state.selectedHopIndex).toBe(2);

    // Simulate hop 3 (final) arriving
    handleProgress({
      runId,
      hop: createMockHop(3, "8.8.8.8", 12.7),
      completed: false,
    });

    state = useTracerouteStore.getState();
    expect(state.runs[runId].hops).toHaveLength(3);

    // Simulate completion
    handleProgress({
      runId,
      completed: true,
      summary: {
        target,
        startedAt: Date.now() - 5000,
        completedAt: Date.now(),
        hopCount: 3,
        protocolsTried: ["ICMP"],
      },
      hops: [
        createMockHop(1, "10.0.0.1", 1.5),
        createMockHop(2, "192.168.1.1", 5.3),
        createMockHop(3, "8.8.8.8", 12.7),
      ],
    });

    state = useTracerouteStore.getState();
    expect(state.status).toBe("success");
    expect(state.runs[runId].hops).toHaveLength(3);
    expect(state.runs[runId].summary.hopCount).toBe(3);
  });

  it("handles traceroute with timeout hops (***)", () => {
    const runId = "test-run-timeout";
    const { handleProgress } = useTracerouteStore.getState();

    // Hop 1 normal, hop 2 timeout, hop 3 normal
    handleProgress({
      runId,
      completed: false,
      summary: { target: "example.com", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
    });

    handleProgress({
      runId,
      hop: createMockHop(1, "10.0.0.1", 1.5),
      completed: false,
    });

    // Timeout hop
    handleProgress({
      runId,
      hop: {
        hopIndex: 2,
        ipAddress: null,
        lossPercent: 100,
        latency: { minRttMs: null, maxRttMs: null, avgRttMs: null, jitterMs: null },
        isPrivate: false,
        isAnycastSuspected: false,
        rawLine: "2  * * *",
      },
      completed: false,
    });

    handleProgress({
      runId,
      hop: createMockHop(3, "8.8.8.8", 15),
      completed: true,
      summary: {
        target: "example.com",
        startedAt: Date.now() - 3000,
        completedAt: Date.now(),
        hopCount: 3,
        protocolsTried: ["ICMP"],
      },
      hops: [
        createMockHop(1, "10.0.0.1", 1.5),
        {
          hopIndex: 2,
          ipAddress: null,
          lossPercent: 100,
          latency: { minRttMs: null, maxRttMs: null, avgRttMs: null, jitterMs: null },
          isPrivate: false,
          isAnycastSuspected: false,
          rawLine: "2  * * *",
        },
        createMockHop(3, "8.8.8.8", 15),
      ],
    });

    const state = useTracerouteStore.getState();
    expect(state.status).toBe("success");
    expect(state.runs[runId].hops).toHaveLength(3);
    expect(state.runs[runId].hops[1].ipAddress).toBeNull();
    expect(state.runs[runId].hops[1].lossPercent).toBe(100);
  });

  it("handles traceroute error gracefully", () => {
    const runId = "test-run-error";
    const { handleProgress } = useTracerouteStore.getState();

    handleProgress({
      runId,
      completed: false,
      summary: { target: "nonexistent.invalid", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
    });

    handleProgress({
      runId,
      completed: true,
      error: "traceroute: unknown host nonexistent.invalid",
      summary: {
        target: "nonexistent.invalid",
        startedAt: Date.now() - 1000,
        completedAt: Date.now(),
        hopCount: 0,
        protocolsTried: ["ICMP"],
        error: "traceroute: unknown host nonexistent.invalid",
      },
      hops: [],
    });

    const state = useTracerouteStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("unknown host");
  });

  it("handles cancellation", async () => {
    const runId = "test-run-cancel";
    const { handleProgress } = useTracerouteStore.getState();

    // Set current run ID so cancelRun knows what to cancel
    useTracerouteStore.setState({ currentRunId: runId });

    handleProgress({
      runId,
      completed: false,
      summary: { target: "8.8.8.8", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
    });

    // Simulate some hops arriving
    handleProgress({
      runId,
      hop: createMockHop(1, "10.0.0.1", 1),
      completed: false,
    });

    let state = useTracerouteStore.getState();
    expect(state.runs[runId].hops).toHaveLength(1);

    // Now cancel - mock the invoke call
    mockInvoke.mockResolvedValueOnce(undefined);
    await useTracerouteStore.getState().cancelRun();

    expect(mockInvoke).toHaveBeenCalledWith("traceroute_cancel", { runId });

    // Simulate the backend sending a cancellation event
    handleProgress({
      runId,
      completed: true,
      error: "Traceroute run cancelled",
      summary: {
        target: "8.8.8.8",
        startedAt: Date.now() - 2000,
        completedAt: Date.now(),
        hopCount: 1,
        protocolsTried: ["ICMP"],
        error: "Traceroute run cancelled",
      },
      hops: [createMockHop(1, "10.0.0.1", 1)],
    });

    state = useTracerouteStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("cancelled");
  });

  it("handles enrichment updates after completion", () => {
    const runId = "test-run-enrichment";
    const { handleProgress } = useTracerouteStore.getState();

    // Initial run
    handleProgress({
      runId,
      completed: false,
      summary: { target: "8.8.8.8", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
    });

    const hop1 = createMockHop(1, "10.0.0.1", 1.5);
    handleProgress({ runId, hop: hop1, completed: false });

    // Complete the run
    handleProgress({
      runId,
      completed: true,
      summary: {
        target: "8.8.8.8",
        startedAt: Date.now() - 2000,
        completedAt: Date.now(),
        hopCount: 1,
        protocolsTried: ["ICMP"],
      },
      hops: [hop1],
    });

    // Set a specific hop selection
    useTracerouteStore.getState().setSelectedHop(1);

    let state = useTracerouteStore.getState();
    expect(state.selectedHopIndex).toBe(1);

    // Now simulate an enrichment update (from async external providers)
    const enrichedHop = {
      ...hop1,
      asn: { asn: 15169, name: "Google LLC", network: "10.0.0.0/8" },
      providers: [
        { provider: "maxmind", status: "success", message: "Resolved." },
        { provider: "team-cymru", status: "success", message: "Lookup complete." },
      ],
    };

    handleProgress({
      runId,
      hop: enrichedHop,
      completed: true, // Enrichment updates come with completed=true
    });

    state = useTracerouteStore.getState();
    // Selected hop should NOT change on enrichment updates
    expect(state.selectedHopIndex).toBe(1);
    // But the hop data should be updated
    expect(state.runs[runId].hops[0].asn?.name).toBe("Google LLC");
    expect(state.runs[runId].hops[0].providers).toHaveLength(2);
  });

  it("handles multiple consecutive runs", () => {
    const { handleProgress } = useTracerouteStore.getState();

    // Run 1
    handleProgress({
      runId: "run-1",
      completed: false,
      summary: { target: "8.8.8.8", startedAt: 1000, hopCount: 0, protocolsTried: ["ICMP"] },
    });
    handleProgress({
      runId: "run-1",
      hop: createMockHop(1, "10.0.0.1", 1),
      completed: true,
      summary: { target: "8.8.8.8", startedAt: 1000, completedAt: 2000, hopCount: 1, protocolsTried: ["ICMP"] },
      hops: [createMockHop(1, "10.0.0.1", 1)],
    });

    let state = useTracerouteStore.getState();
    expect(state.currentRunId).toBe("run-1");
    expect(state.status).toBe("success");

    // Run 2
    handleProgress({
      runId: "run-2",
      completed: false,
      summary: { target: "1.1.1.1", startedAt: 3000, hopCount: 0, protocolsTried: ["UDP"] },
    });
    handleProgress({
      runId: "run-2",
      hop: createMockHop(1, "192.168.0.1", 2),
      completed: true,
      summary: { target: "1.1.1.1", startedAt: 3000, completedAt: 4000, hopCount: 1, protocolsTried: ["UDP"] },
      hops: [createMockHop(1, "192.168.0.1", 2)],
    });

    state = useTracerouteStore.getState();
    expect(state.currentRunId).toBe("run-2");
    expect(state.status).toBe("success");
    // Both runs should be in the registry
    expect(Object.keys(state.runs)).toHaveLength(2);
    expect(state.runs["run-1"]).toBeDefined();
    expect(state.runs["run-2"]).toBeDefined();
  });

  it("correctly sorts hops by hop index", () => {
    const { handleProgress } = useTracerouteStore.getState();

    handleProgress({
      runId: "run-sort",
      completed: false,
      summary: { target: "8.8.8.8", startedAt: Date.now(), hopCount: 0, protocolsTried: ["ICMP"] },
    });

    // Send hops out of order
    handleProgress({ runId: "run-sort", hop: createMockHop(3, "3.3.3.3", 15), completed: false });
    handleProgress({ runId: "run-sort", hop: createMockHop(1, "1.1.1.1", 5), completed: false });
    handleProgress({ runId: "run-sort", hop: createMockHop(2, "2.2.2.2", 10), completed: false });

    const state = useTracerouteStore.getState();
    const hops = state.runs["run-sort"].hops;
    expect(hops[0].hopIndex).toBe(1);
    expect(hops[1].hopIndex).toBe(2);
    expect(hops[2].hopIndex).toBe(3);
  });
});
