import React from "react";
import type { TracerouteRun } from "@common/ipc";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { hopIndexToColor } from "@renderer/lib/globe";
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

export const HopDetailsPane: React.FC<HopDetailsPaneProps> = ({ run, selectedHopIndex, status }) => {
  const setSelectedHop = useTracerouteStore((state) => state.setSelectedHop);

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
                <th></th>
                <th>#</th>
                <th>Endpoint</th>
                <th>Latency (ms)</th>
                <th>Loss</th>
                <th>Location</th>
                <th>ASN</th>
              </tr>
            </thead>
            <tbody>
              {run.hops.length === 0 ? (
                <tr>
                  <td colSpan={7} className="hop-details__row-empty">
                    Awaiting hop responses…
                  </td>
                </tr>
              ) : (
                run.hops.map((hop) => {
                  const isSelected = hop.hopIndex === selectedHopIndex;
                  const hopColor = hopIndexToColor(hop.hopIndex);
                  return (
                    <tr
                      key={hop.hopIndex}
                      className={isSelected ? "hop-details__row hop-details__row--selected" : "hop-details__row"}
                      onClick={() => setSelectedHop(hop.hopIndex)}
                    >
                      <td>
                        <div
                          style={{
                            width: '12px',
                            height: '12px',
                            borderRadius: '50%',
                            backgroundColor: hopColor,
                            margin: '0 auto'
                          }}
                        />
                      </td>
                      <td>{hop.hopIndex}</td>
                      <td>
                        <div className="hop-details__endpoint">
                          <span>{hop.ipAddress ?? "*"}</span>
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
                      <td>
                        {hop.geo ? (
                          <>
                            {hop.geo.city ? `${hop.geo.city}, ` : ""}
                            {hop.geo.country ?? ""}
                          </>
                        ) : (
                          hop.isPrivate ? "Private" : "Unknown"
                        )}
                      </td>
                      <td>
                        {hop.asn?.asn ? `AS${hop.asn.asn}` : "–"}
                        {hop.asn?.name && <small>{hop.asn.name}</small>}
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
    </aside>
  );
};
