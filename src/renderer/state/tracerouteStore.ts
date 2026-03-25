import { create } from "zustand";
import type {
  TracerouteExecutionResult,
  TracerouteProgressEvent,
  TracerouteRequest,
  TracerouteRun
} from "@common/ipc";

type RunRegistry = Record<string, TracerouteRun>;

type TracerouteStatus = "idle" | "running" | "success" | "error";

export interface TracerouteStore {
  runs: RunRegistry;
  currentRunId?: string;
  status: TracerouteStatus;
  error?: string;
  pendingRequest?: TracerouteRequest;
  selectedHopIndex?: number;
  startRun: (request: TracerouteRequest) => Promise<TracerouteExecutionResult | undefined>;
  cancelRun: () => Promise<void>;
  handleProgress: (event: TracerouteProgressEvent) => void;
  completeRun: (result: TracerouteExecutionResult) => void;
  setSelectedHop: (hopIndex: number | undefined) => void;
  resetError: () => void;
}

function mergeHop(existing: TracerouteRun, hop: TracerouteRun["hops"][number]): TracerouteRun {
  const otherHops = existing.hops.filter((existingHop) => existingHop.hopIndex !== hop.hopIndex);
  return {
    ...existing,
    hops: [...otherHops, hop].sort((a, b) => a.hopIndex - b.hopIndex)
  };
}

export const useTracerouteStore = create<TracerouteStore>((set, get) => ({
  runs: {},
  status: "idle",
  startRun: async (request) => {
    const api = window.visTracer;
    set({ status: "running", error: undefined, pendingRequest: request });

    try {
      const result = await api.runTraceroute(request);
      get().completeRun(result);
      return result;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Traceroute execution failed unexpectedly.";
      set({ status: "error", error: message, pendingRequest: undefined });
      return undefined;
    }
  },
  cancelRun: async () => {
    const api = window.visTracer;
    const runId = get().currentRunId;
    if (runId) {
      await api.cancelTraceroute(runId);
    }
  },
  handleProgress: (event) => {
    set((state) => {
      const runs = { ...state.runs };
      const baseRun = runs[event.runId];
      const request = state.pendingRequest ?? baseRun?.request;
      let run: TracerouteRun;

      if (baseRun) {
        run = baseRun;
      } else {
        const defaultRequest: TracerouteRequest = {
          target: event.summary?.target ?? "",
          protocol: "ICMP",
          maxHops: 30,
          timeoutMs: 4000,
          packetCount: 3,
          forceFresh: false
        };

        const finalRequest = request ?? defaultRequest;

        run = {
          request: finalRequest,
          summary: event.summary ?? {
            target: finalRequest.target,
            startedAt: Date.now(),
            hopCount: 0,
            protocolsTried: [finalRequest.protocol]
          },
          hops: []
        };
      }

      if (event.summary) {
        run = {
          ...run,
          summary: {
            ...run.summary,
            ...event.summary
          }
        };
      }

      if (event.hop) {
        run = mergeHop(run, event.hop);
      }

      if (event.hops) {
        run = {
          ...run,
          hops: event.hops.slice().sort((a, b) => a.hopIndex - b.hopIndex)
        };
      }

      runs[event.runId] = run;

      const nextStatus: TracerouteStatus = event.completed
        ? event.error
          ? "error"
          : "success"
        : "running";

      const selectedHopIndex = event.hop
        ? event.hop.hopIndex
        : event.completed && state.selectedHopIndex == null && run.hops.length > 0
          ? run.hops[run.hops.length - 1].hopIndex
          : state.selectedHopIndex;

      return {
        runs,
        currentRunId: event.runId,
        status: nextStatus,
        error: event.error,
        pendingRequest: event.completed ? undefined : state.pendingRequest,
        selectedHopIndex
      };
    });
  },
  completeRun: (result) => {
    set((state) => {
      const runs = { ...state.runs, [result.runId]: result.run };
      return {
        runs,
        currentRunId: result.runId,
        status: result.run.summary.error ? "error" : "success",
        error: result.run.summary.error,
        pendingRequest: undefined
      };
    });
  },
  setSelectedHop: (hopIndex) => set({ selectedHopIndex: hopIndex }),
  resetError: () => set({ error: undefined }),
  error: undefined,
  pendingRequest: undefined,
  currentRunId: undefined,
  selectedHopIndex: undefined
}));

export const selectCurrentRun = (state: TracerouteStore): TracerouteRun | undefined => {
  if (!state.currentRunId) {
    return undefined;
  }
  return state.runs[state.currentRunId];
};

export const selectCurrentHop = (state: TracerouteStore) => {
  const run = selectCurrentRun(state);
  if (!run || state.selectedHopIndex == null) {
    return undefined;
  }
  return run.hops.find((hop) => hop.hopIndex === state.selectedHopIndex);
};
