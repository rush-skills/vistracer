import React, { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { TracerouteProtocol } from "@common/ipc";
import { useRecentRuns } from "@renderer/hooks/useRecentRuns";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import "./TopBar.css";

interface TracerouteFormState {
  target: string;
  protocol: TracerouteProtocol;
  maxHops: number;
  timeoutMs: number;
  packetCount: number;
  forceFresh: boolean;
}

const defaultState: TracerouteFormState = {
  target: "",
  protocol: "ICMP",
  maxHops: 30,
  timeoutMs: 4000,
  packetCount: 3,
  forceFresh: false
};

const numericConstraints = {
  maxHops: { min: 1, max: 64 },
  timeoutMs: { min: 500, max: 20000 },
  packetCount: { min: 1, max: 5 }
} as const;

export const TopBar: React.FC = () => {
  const [form, setForm] = useState<TracerouteFormState>(defaultState);
  const status = useTracerouteStore((state) => state.status);
  const error = useTracerouteStore((state) => state.error);
  const startRun = useTracerouteStore((state) => state.startRun);
  const cancelRun = useTracerouteStore((state) => state.cancelRun);
  const pendingRequest = useTracerouteStore((state) => state.pendingRequest);
  const currentRunId = useTracerouteStore((state) => state.currentRunId);
  const queryClient = useQueryClient();
  const { data: recentRuns } = useRecentRuns();

  const isRunning = status === "running";

  const isSubmitEnabled = useMemo(() => {
    if (!form.target.trim()) {
      return false;
    }
    if (isRunning && pendingRequest) {
      return false;
    }
    return true;
  }, [form.target, isRunning, pendingRequest]);

  const handleChange = (field: keyof TracerouteFormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        field === "forceFresh"
          ? (event as React.ChangeEvent<HTMLInputElement>).target.checked
          : event.target.value;

      setForm((prev) => {
        if (field === "maxHops" || field === "timeoutMs" || field === "packetCount") {
          const limits = numericConstraints[field];
          const numeric = Number(value);
          const clamped = Number.isNaN(numeric)
            ? limits.min
            : Math.min(Math.max(numeric, limits.min), limits.max);
          return { ...prev, [field]: clamped };
        }

        if (field === "forceFresh") {
          return { ...prev, [field]: Boolean(value) };
        }

        return { ...prev, [field]: value };
      });
    };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSubmitEnabled) {
      return;
    }

    const target = form.target.trim();
    if (!target) {
      return;
    }

    await startRun({
      target,
      protocol: form.protocol,
      maxHops: form.maxHops,
      timeoutMs: form.timeoutMs,
      packetCount: form.packetCount,
      forceFresh: form.forceFresh
    });

    void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
  };

  const handleRecentRunSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value) {
      return;
    }

    const recent = recentRuns?.find((run) => run.id === value);
    if (recent) {
      setForm((prev) => ({
        ...prev,
        target: recent.target,
        protocol: recent.protocol
      }));
    }
  };

  const runButtonClass = `top-bar__run${!isSubmitEnabled ? " top-bar__run--disabled" : ""}`;

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <span className="top-bar__logo">VisTracer</span>
        <span className="top-bar__tagline">— Visualize hop-by-hop network paths</span>
      </div>
      <form className="top-bar__form" onSubmit={handleSubmit}>
        <div className="top-bar__input-group">
          <input
            className="top-bar__input"
            type="text"
            name="target"
            placeholder="example.com or 8.8.8.8"
            autoComplete="off"
            value={form.target}
            onChange={handleChange("target")}
            disabled={isRunning}
            aria-label="Traceroute target"
          />
          <select
            className="top-bar__select"
            name="protocol"
            value={form.protocol}
            onChange={handleChange("protocol")}
            disabled={isRunning}
            aria-label="Probe protocol"
          >
            <option value="ICMP">ICMP</option>
            <option value="UDP">UDP</option>
            <option value="TCP">TCP</option>
          </select>
          <button type="submit" className={runButtonClass} disabled={!isSubmitEnabled}>
            {isRunning ? "Running…" : "Run"}
          </button>
          {isRunning ? (
            <button type="button" className="top-bar__cancel" onClick={() => void cancelRun()}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="top-bar__reset"
              onClick={() => setForm(defaultState)}
              disabled={isRunning}
            >
              Clear
            </button>
          )}
        </div>
        <div className="top-bar__advanced">
          <label className="top-bar__number">
            Max hops
            <input
              type="number"
              min={1}
              max={64}
              value={form.maxHops}
              onChange={handleChange("maxHops")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__number">
            Timeout (ms)
            <input
              type="number"
              min={500}
              max={20000}
              step={250}
              value={form.timeoutMs}
              onChange={handleChange("timeoutMs")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__number">
            Probes/hop
            <input
              type="number"
              min={1}
              max={5}
              value={form.packetCount}
              onChange={handleChange("packetCount")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__checkbox">
            <input
              type="checkbox"
              checked={form.forceFresh}
              onChange={handleChange("forceFresh")}
              disabled={isRunning}
            />
            Force fresh lookups
          </label>
          <select
            className="top-bar__recent"
            onChange={handleRecentRunSelect}
            value=""
            disabled={!recentRuns?.length}
          >
            <option value="">Recent runs</option>
            {recentRuns?.map((run) => (
              <option key={run.id} value={run.id}>{`${run.target} (${run.protocol})`}</option>
            ))}
          </select>
        </div>
        <div className="top-bar__status" role="status" aria-live="polite">
          {isRunning && pendingRequest ? (
            <span>
              Running traceroute to <strong>{pendingRequest.target}</strong>…
            </span>
          ) : status === "success" && currentRunId ? (
            <span>
              Completed run <code>{currentRunId.slice(0, 8)}</code>
            </span>
          ) : status === "error" && error ? (
            <span className="top-bar__status-error">{error}</span>
          ) : (
            <span>Ready for next target.</span>
          )}
        </div>
      </form>
    </header>
  );
};
