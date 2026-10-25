import React, { useEffect, useMemo, useRef } from "react";
import { FiChevronDown, FiChevronUp } from "react-icons/fi";
import type { TracerouteRun } from "@common/ipc";
import { latencyToColor } from "@renderer/lib/globe";
import { scrollBehavior } from "@renderer/lib/motion";
import {
  buildTimeline,
  describeTimelineHop,
  formatMs,
  type TimelineHop
} from "@renderer/lib/timeline";
import { usePanel } from "@renderer/hooks/usePanel";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import "./HopTimeline.css";

interface HopTimelineProps {
  run?: TracerouteRun;
  selectedHopIndex?: number;
}

const CHART_HEIGHT = 56;
const CONFIDENCE_BARS = { high: 3, medium: 2, low: 1 } as const;

/** RTT of one hop on the run's scale: min-max whisker, average bar, one tick per probe. */
const RttChart: React.FC<{ hop: TimelineHop; scaleMs: number }> = ({ hop, scaleMs }) => {
  const y = (ms: number) => CHART_HEIGHT - (Math.min(ms, scaleMs) / scaleMs) * (CHART_HEIGHT - 2);
  if (hop.avgMs == null) {
    return (
      <svg className="timeline__chart" viewBox={`0 0 24 ${CHART_HEIGHT}`} aria-hidden>
        <line className="timeline__no-reply" x1="12" x2="12" y1="8" y2={CHART_HEIGHT} />
      </svg>
    );
  }
  const colour = latencyToColor(hop.avgMs);
  return (
    <svg className="timeline__chart" viewBox={`0 0 24 ${CHART_HEIGHT}`} aria-hidden>
      <rect
        className="timeline__bar"
        x="7"
        width="10"
        y={y(hop.avgMs)}
        height={CHART_HEIGHT - y(hop.avgMs)}
        rx="2"
        fill={colour}
      />
      {hop.minMs != null && hop.maxMs != null && hop.maxMs > hop.minMs && (
        <line className="timeline__whisker" x1="12" x2="12" y1={y(hop.maxMs)} y2={y(hop.minMs)} />
      )}
      {hop.samplesMs.map((sample, index) => (
        <line
          key={index}
          className="timeline__sample"
          x1="4"
          x2="20"
          y1={y(sample)}
          y2={y(sample)}
        />
      ))}
    </svg>
  );
};

const Confidence: React.FC<{ hop: TimelineHop }> = ({ hop }) => {
  const { location } = hop;
  if (location.kind === "anycast") {
    return <span className="timeline__place timeline__place--anycast">anycast</span>;
  }
  if (location.kind !== "located") {
    return <span className="timeline__place">{location.kind === "private" ? "private" : "–"}</span>;
  }
  const filled = CONFIDENCE_BARS[location.confidence];
  return (
    <span className={`timeline__confidence timeline__confidence--${location.confidence}`}>
      {[1, 2, 3].map((bar) => (
        <i key={bar} className={bar <= filled ? "is-filled" : undefined} />
      ))}
    </span>
  );
};

/**
 * Hops left to right with their RTT, loss and location confidence. Latency
 * jumps get an amber marker. Selection and hover are the store's, shared
 * with the globe and the hop pane; arrow keys move the selection.
 */
export const HopTimeline: React.FC<HopTimelineProps> = ({ run, selectedHopIndex }) => {
  const [collapsed, setCollapsed] = usePanel("timeline");
  const hoveredHopIndex = useTracerouteStore((state) => state.hoveredHopIndex);
  const optionRefs = useRef(new Map<number, HTMLDivElement>());
  const timeline = useMemo(() => buildTimeline(run?.hops ?? []), [run]);
  const hops = timeline.hops;

  useEffect(() => {
    if (selectedHopIndex != null) {
      optionRefs.current
        .get(selectedHopIndex)
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
    }
  }, [selectedHopIndex, collapsed]);

  const { selectHopByUser, setHoveredHop } = useTracerouteStore.getState();
  /** The hover card points at the hop's column. */
  const hover = (hopIndex: number, element: HTMLElement) => {
    const { left, top, width, height } = element.getBoundingClientRect();
    setHoveredHop(hopIndex, { kind: "rect", left, top, width, height });
  };
  const focusIndex = hops.some((hop) => hop.hopIndex === selectedHopIndex)
    ? selectedHopIndex
    : hops[0]?.hopIndex;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The card shown for a focused hop must be dismissable (WCAG 1.4.13);
    // the hop stays highlighted.
    const { hoveredHopIndex: hovered, hoverAnchor } = useTracerouteStore.getState();
    if (event.key === "Escape" && hoverAnchor) {
      event.preventDefault();
      setHoveredHop(hovered);
      return;
    }
    moveSelection(event);
  };

  const moveSelection = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // An animated export moves the selection itself (selectHopByUser).
    if (hops.length === 0 || useTracerouteStore.getState().captureActive) {
      return;
    }
    const current = hops.findIndex((hop) => hop.hopIndex === focusIndex);
    const last = hops.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: Math.min(last, current + 1),
      ArrowDown: Math.min(last, current + 1),
      ArrowLeft: Math.max(0, current - 1),
      ArrowUp: Math.max(0, current - 1),
      Home: 0,
      End: last
    };
    const target = targets[event.key];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    const hopIndex = hops[target].hopIndex;
    selectHopByUser(hopIndex);
    optionRefs.current.get(hopIndex)?.focus();
  };

  const maxRtt = hops.reduce((max, hop) => Math.max(max, hop.maxMs ?? hop.avgMs ?? 0), 0);

  return (
    <section className="timeline glass" aria-labelledby="timeline-title">
      <header className="timeline__header">
        <h2 id="timeline-title">Hop timeline</h2>
        {hops.length > 0 && (
          <span className="timeline__summary">
            {hops.length} {hops.length === 1 ? "hop" : "hops"}, up to {formatMs(maxRtt)} ms
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={collapsed ? "Show hop timeline" : "Hide hop timeline"}
          aria-expanded={!collapsed}
          aria-controls={!collapsed && hops.length > 0 ? "timeline-track" : undefined}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <FiChevronUp aria-hidden /> : <FiChevronDown aria-hidden />}
        </button>
      </header>
      {!collapsed &&
        (hops.length === 0 ? (
          <p className="timeline__empty">
            {run ? "Waiting for the first hop…" : "Each hop of a trace appears here, left to right."}
          </p>
        ) : (
          <div
            id="timeline-track"
            className="timeline__track"
            role="listbox"
            aria-label="Hops by round-trip time"
            aria-orientation="horizontal"
            onKeyDown={onKeyDown}
          >
            {hops.map((hop) => {
              const selected = hop.hopIndex === selectedHopIndex;
              const className = [
                "timeline__hop",
                selected && "timeline__hop--selected",
                hop.hopIndex === hoveredHopIndex && "timeline__hop--hovered",
                hop.jumpMs != null && "timeline__hop--jump"
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  key={hop.hopIndex}
                  ref={(element) => {
                    if (element) {
                      optionRefs.current.set(hop.hopIndex, element);
                    } else {
                      optionRefs.current.delete(hop.hopIndex);
                    }
                  }}
                  id={`timeline-hop-${hop.hopIndex}`}
                  role="option"
                  aria-selected={selected}
                  aria-label={describeTimelineHop(hop)}
                  tabIndex={hop.hopIndex === focusIndex ? 0 : -1}
                  className={className}
                  onClick={() => selectHopByUser(hop.hopIndex)}
                  onMouseEnter={(event) => hover(hop.hopIndex, event.currentTarget)}
                  onMouseLeave={() => setHoveredHop(undefined)}
                  onFocus={(event) => hover(hop.hopIndex, event.currentTarget)}
                  onBlur={() => setHoveredHop(undefined)}
                >
                  <span className="timeline__jump" aria-hidden>
                    {hop.jumpMs != null ? `+${formatMs(hop.jumpMs)}` : ""}
                  </span>
                  <RttChart hop={hop} scaleMs={timeline.scaleMs} />
                  <span className="timeline__rtt" aria-hidden>
                    {hop.avgMs != null ? formatMs(hop.avgMs) : "*"}
                  </span>
                  <span className="timeline__index" aria-hidden>
                    {hop.hopIndex}
                  </span>
                  <span className="timeline__meta" aria-hidden>
                    <Confidence hop={hop} />
                    {hop.lossPercent != null && hop.lossPercent > 0 && (
                      <span className="timeline__loss">{Math.round(hop.lossPercent)}%</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
};
