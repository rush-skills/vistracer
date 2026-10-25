import React, { useMemo } from "react";
import { assignAsnColors, hopRangeText } from "@renderer/lib/infra/asnColors";
import { layerVisibility } from "@renderer/lib/layers";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import "./AsnLegend.css";

/**
 * The legend of the "Network colours" layer: each network (ASN) on the
 * route in the order the route enters it, with its colour and its hops.
 * The text carries the same facts, so the colour is never the only cue.
 */
export const AsnLegend: React.FC = () => {
  const saved = useUiStore((state) => state.layers);
  const shown = useMemo(() => layerVisibility(saved)["asn-colors"], [saved]);
  const hops = useTracerouteStore((state) => selectCurrentRun(state)?.hops);
  const legend = useMemo(() => (hops ? assignAsnColors(hops).legend : []), [hops]);

  if (!shown || legend.length === 0) {
    return null;
  }

  return (
    <section className="asn-legend glass" aria-labelledby="asn-legend-title">
      <h2 id="asn-legend-title">Networks on the route</h2>
      <ul>
        {legend.map((entry) => (
          <li key={entry.asn ?? "unknown"}>
            <span className="asn-legend__swatch" style={{ background: entry.color }} aria-hidden />
            <span className="asn-legend__name">
              {entry.asn != null ? `AS${entry.asn}` : "No network data"}
              {entry.name && <span className="asn-legend__holder"> {entry.name}</span>}
            </span>
            <span className="asn-legend__hops">{hopRangeText(entry.hopIndexes)}</span>
          </li>
        ))}
      </ul>
      <p className="asn-legend__hint">
        An arc that changes colour in the middle crosses from one network to the next.
      </p>
    </section>
  );
};
