import React, { useEffect, useMemo, useRef } from "react";
import { FiChevronsLeft, FiChevronsRight } from "react-icons/fi";
import type { TracerouteRun } from "@common/ipc";
import { usePanel } from "@renderer/hooks/usePanel";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { hopIndexToColor } from "@renderer/lib/globe";
import { describeFailures, failedProviders } from "../lib/providers";
import { SOURCE_LABELS, formatRadius, locationLabel } from "../lib/location";
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

export const HopDetailsPane: React.FC<HopDetailsPaneProps> = React.memo(({ run, selectedHopIndex, status }) => {
  const selectHopByUser = useTracerouteStore((state) => state.selectHopByUser);
  const hoveredHopIndex = useTracerouteStore((state) => state.hoveredHopIndex);
  const setHoveredHop = useTracerouteStore((state) => state.setHoveredHop);
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const [collapsed, setCollapsed] = usePanel("hops");
  // Collapsing swaps the pane for a tab, so the focused toggle unmounts;
  // the focus moves to the toggle that replaces it.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggle = useRef(false);
  const toggle = (value: boolean) => {
    focusToggle.current = true;
    setCollapsed(value);
  };

  useEffect(() => {
    if (focusToggle.current) {
      focusToggle.current = false;
      toggleRef.current?.focus();
    }
  }, [collapsed]);

  // A hop picked on the globe (or reached during a run) scrolls into view.
  useEffect(() => {
    if (selectedHopIndex != null) {
      rowRefs.current.get(selectedHopIndex)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selectedHopIndex, collapsed]);

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

  if (collapsed) {
    return (
      <button
        ref={toggleRef}
        type="button"
        className="hop-details__expand glass"
        aria-label="Show hop details"
        aria-expanded={false}
        onClick={() => toggle(false)}
      >
        <FiChevronsLeft aria-hidden />
        Hops{run ? ` (${run.hops.length})` : ""}
      </button>
    );
  }

  return (
    <aside className="hop-details glass" aria-label="Hop details">
      <header className="hop-details__header">
        <div className="hop-details__heading">
          <h2>Hops</h2>
          {run?.summary.target && <p className="hop-details__target">{run.summary.target}</p>}
        </div>
        <span className={`hop-details__badge hop-details__badge--${status}`}>
          {statusLabelMap[status]}
        </span>
        <button
          ref={toggleRef}
          type="button"
          className="icon-button"
          aria-label="Hide hop details"
          aria-expanded={true}
          title="Hide hop details"
          onClick={() => toggle(true)}
        >
          <FiChevronsRight aria-hidden />
        </button>
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
          <p>Trace a host to see the latency, location and network of each hop here.</p>
        </div>
      ) : (
        <div className="hop-details__table-wrapper">
          <table className="hop-details__table">
            <thead>
              <tr>
                <th aria-label="Colour on the globe"></th>
                <th>#</th>
                <th>Endpoint</th>
                <th>RTT (ms)</th>
                <th>Location</th>
              </tr>
            </thead>
            <tbody>
              {hopRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="hop-details__row-empty">
                    Awaiting hop responses…
                  </td>
                </tr>
              ) : (
                hopRows.map(({ hop, hopColor, location, extraPaths, failures, failureSummary }) => {
                  const isSelected = hop.hopIndex === selectedHopIndex;
                  const rowClass = [
                    "hop-details__row",
                    isSelected && "hop-details__row--selected",
                    hop.hopIndex === hoveredHopIndex && "hop-details__row--hovered"
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <tr
                      key={hop.hopIndex}
                      ref={(row) => {
                        if (row) {
                          rowRefs.current.set(hop.hopIndex, row);
                        } else {
                          rowRefs.current.delete(hop.hopIndex);
                        }
                      }}
                      className={rowClass}
                      onClick={() => selectHopByUser(hop.hopIndex)}
                      onMouseEnter={() => setHoveredHop(hop.hopIndex)}
                      onMouseLeave={() => setHoveredHop(undefined)}
                      onFocus={() => setHoveredHop(hop.hopIndex)}
                      onBlur={() => setHoveredHop(undefined)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          selectHopByUser(hop.hopIndex);
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={isSelected}
                    >
                      <td>
                        <span className="hop-details__dot" style={{ backgroundColor: hopColor }} />
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
                          {hop.asn?.asn != null && (
                            <small>
                              AS{hop.asn.asn}
                              {hop.asn.name && ` ${hop.asn.name}`}
                            </small>
                          )}
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
                      <td>
                        <div className="hop-details__latency">
                          <span>{hop.latency.avgRttMs ?? "–"}</span>
                          <small title="Minimum and maximum">
                            {hop.latency.minRttMs ?? "–"}–{hop.latency.maxRttMs ?? "–"}
                          </small>
                          {hop.lossPercent != null && hop.lossPercent > 0 && (
                            <small className="hop-details__loss">{hop.lossPercent}% loss</small>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="hop-details__location">
                          <span>
                            {location}
                            {hop.location.anycast && (
                              <span
                                className="hop-details__tag hop-details__tag--anycast"
                                title="Many sites announce this address; the nearest one answered. No single point is drawn."
                              >
                                anycast
                              </span>
                            )}
                            {hop.location.best?.rtt?.verdict === "conflict" && (
                              <span
                                className="hop-details__tag hop-details__tag--conflict"
                                title="The RTT check against the reference hop disagrees with this location; one of the two is wrong."
                              >
                                conflict
                              </span>
                            )}
                          </span>
                          {hop.location.best && (
                            <small title={`Source: ${SOURCE_LABELS[hop.location.best.source]}`}>
                              <span
                                className={`hop-details__confidence hop-details__confidence--${hop.location.best.confidence}`}
                              >
                                {hop.location.best.confidence}
                              </span>{" "}
                              {formatRadius(hop.location.best.radiusKm)}
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
