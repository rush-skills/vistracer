import React, { useMemo } from "react";
import type { HopResolution, TracerouteRun } from "@common/ipc";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { hopIndexToColor } from "@renderer/lib/globe";
import { describeFailures, failedProviders } from "../lib/providers";
import { HopInspector } from "./HopInspector";
import "./HopDetailsPane.css";

interface HopDetailsPaneProps {
  run?: TracerouteRun;
  selectedHopIndex?: number;
  status: "idle" | "running" | "success" | "error";
}

const statusLabelMap: Record<HopDetailsPaneProps["status"], string> = {
  idle: "Idle",
  running: "Running",
  success: "Completed",
  error: "Error"
};

const locationLabel = (hop: HopResolution): string => {
  if (hop.geo) {
    return `${hop.geo.city ? `${hop.geo.city}, ` : ""}${hop.geo.country ?? ""}`.trim() || "Unknown";
  }
  if (hop.isPrivate) {
    return "Private";
  }
  if (hop.lookupState === "pending") {
    return "Resolving…";
  }
  if (hop.asn?.country) {
    return `${hop.asn.country} (registry)`;
  }
  return "Unknown";
};

export const HopDetailsPane: React.FC<HopDetailsPaneProps> = React.memo(({ run, selectedHopIndex, status }) => {
  const setSelectedHop = useTracerouteStore((state) => state.setSelectedHop);

  const hopRows = useMemo(() => {
    if (!run) return [];
    return run.hops.map((hop) => {
      const failures = failedProviders(hop);
      return {
        hop,
        hopColor: hopIndexToColor(hop.hopIndex),
        location: locationLabel(hop),
        extraPaths: Math.max(0, (hop.responders?.length ?? 0) - 1),
        failures,
        failureSummary: describeFailures(failures)
      };
    });
  }, [run]);

  const selectedHop = run?.hops.find((hop) => hop.hopIndex === selectedHopIndex);
  const notices = run?.summary.notices ?? [];

  return (
    <aside className="hop-details">
      <header className="hop-details__header">
        <div>
          <h2>Hop timeline</h2>
          {run?.summary.target && <p className="hop-details__target">{run.summary.target}</p>}
        </div>
        <span className={`hop-details__badge hop-details__badge--${status}`}>
          {statusLabelMap[status]}
        </span>
      </header>

      {notices.length > 0 && (
        <ul className="hop-details__notices" aria-label="Run notices">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}

      {!run ? (
        <div className="hop-details__empty">
          <p>
            Run a traceroute to inspect hop-by-hop latency, geolocation, and ASN details.
          </p>
        </div>
      ) : (
        <div className="hop-details__table-wrapper">
          <table className="hop-details__table">
            <thead>
              <tr>
                <th aria-label="Color indicator"></th>
                <th>#</th>
                <th>Endpoint</th>
                <th>Latency (ms)</th>
                <th>Loss</th>
                <th>Location</th>
                <th>ASN</th>
              </tr>
            </thead>
            <tbody>
              {hopRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="hop-details__row-empty">
                    Awaiting hop responses…
                  </td>
                </tr>
              ) : (
                hopRows.map(({ hop, hopColor, location, extraPaths, failures, failureSummary }) => {
                  const isSelected = hop.hopIndex === selectedHopIndex;

                  return (
                    <tr
                      key={hop.hopIndex}
                      className={isSelected ? "hop-details__row hop-details__row--selected" : "hop-details__row"}
                      onClick={() => setSelectedHop(hop.hopIndex)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedHop(hop.hopIndex);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={isSelected}
                    >
                      <td>
                        <div
                          style={{
                            width: "12px",
                            height: "12px",
                            borderRadius: "50%",
                            backgroundColor: hopColor,
                            margin: "0 auto"
                          }}
                        />
                      </td>
                      <td>{hop.hopIndex}</td>
                      <td>
                        <div className="hop-details__endpoint">
                          <span>
                            {hop.ipAddress ?? "*"}
                            {extraPaths > 0 && (
                              <span
                                className="hop-details__tag"
                                title={`${extraPaths + 1} addresses answered at this hop (load-balanced paths)`}
                              >
                                +{extraPaths} {extraPaths === 1 ? "path" : "paths"}
                              </span>
                            )}
                          </span>
                          {hop.hostName && <small>{hop.hostName}</small>}
                        </div>
                      </td>
                      <td>
                        <div className="hop-details__latency">
                          <span>{hop.latency.avgRttMs ?? "–"}</span>
                          <small>
                            {hop.latency.minRttMs ?? "–"}/{hop.latency.maxRttMs ?? "–"}
                          </small>
                        </div>
                      </td>
                      <td>{hop.lossPercent == null ? "–" : `${hop.lossPercent}%`}</td>
                      <td>{location}</td>
                      <td>
                        <div className="hop-details__asn-cell">
                          <div>{hop.asn?.asn ? `AS${hop.asn.asn}` : "–"}</div>
                          {hop.asn?.name && <small>{hop.asn.name}</small>}
                          {hop.asn?.network && <small>{hop.asn.network}</small>}
                          {failures.length > 0 && (
                            <small className="hop-details__provider-error" title={failureSummary}>
                              {failures.length === 1
                                ? "1 source failed"
                                : `${failures.length} sources failed`}
                            </small>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {run.summary.error && (
            <div className="hop-details__error">{run.summary.error}</div>
          )}
        </div>
      )}

      {selectedHop && <HopInspector hop={selectedHop} />}
    </aside>
  );
});

HopDetailsPane.displayName = "HopDetailsPane";
