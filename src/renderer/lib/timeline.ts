import type { HopResolution, LocationConfidence } from "@common/ipc";
import { hopPosition } from "./globe";

/**
 * A rise of the average RTT by at least this much over the previous hop
 * that answered is marked as a latency jump: usually a long link (an ocean
 * cable), sometimes a router that answers probes slowly.
 */
export const LATENCY_JUMP_MS = 20;

export type TimelineLocation =
  | { kind: "located"; label: string; confidence: LocationConfidence }
  | { kind: "anycast"; service: string }
  | { kind: "private" }
  | { kind: "pending" }
  | { kind: "unknown" };

export interface TimelineHop {
  hopIndex: number;
  address: string | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** RTTs of the first responder's probes. */
  samplesMs: number[];
  lossPercent: number | null;
  location: TimelineLocation;
  /** The rise over `jumpFromHopIndex`, when it is a latency jump. */
  jumpMs: number | null;
  jumpFromHopIndex: number | null;
}

export interface Timeline {
  hops: TimelineHop[];
  /** The largest RTT of the run: the top of every bar's scale. */
  scaleMs: number;
}

function timelineLocation(hop: HopResolution): TimelineLocation {
  const best = hopPosition(hop);
  if (best) {
    return { kind: "located", label: best.label, confidence: best.confidence };
  }
  if (hop.location.anycast) {
    return { kind: "anycast", service: hop.location.anycast.service };
  }
  if (hop.isPrivate) {
    return { kind: "private" };
  }
  return hop.lookupState === "pending" && hop.ipAddress ? { kind: "pending" } : { kind: "unknown" };
}

export function buildTimeline(hops: HopResolution[]): Timeline {
  let previous: { hopIndex: number; avgMs: number } | null = null;
  let scaleMs = 0;
  const items = hops.map((hop): TimelineHop => {
    const { avgRttMs, minRttMs, maxRttMs } = hop.latency;
    let jumpMs: number | null = null;
    let jumpFromHopIndex: number | null = null;
    if (avgRttMs != null) {
      if (previous && avgRttMs - previous.avgMs >= LATENCY_JUMP_MS) {
        jumpMs = avgRttMs - previous.avgMs;
        jumpFromHopIndex = previous.hopIndex;
      }
      previous = { hopIndex: hop.hopIndex, avgMs: avgRttMs };
    }
    const samplesMs = hop.responders[0]?.rttsMs ?? [];
    scaleMs = Math.max(scaleMs, maxRttMs ?? 0, avgRttMs ?? 0, ...samplesMs);
    return {
      hopIndex: hop.hopIndex,
      address: hop.ipAddress,
      avgMs: avgRttMs,
      minMs: minRttMs,
      maxMs: maxRttMs,
      samplesMs,
      lossPercent: hop.lossPercent,
      location: timelineLocation(hop),
      jumpMs,
      jumpFromHopIndex
    };
  });
  return { hops: items, scaleMs: Math.max(scaleMs, 1) };
}

/** Rounds to whole ms from 10 ms, one decimal below. */
export function formatMs(ms: number): string {
  return ms >= 10 ? `${Math.round(ms)}` : `${Math.round(ms * 10) / 10}`;
}

export function describeLocation(location: TimelineLocation): string {
  switch (location.kind) {
    case "located":
      return `${location.label}, ${location.confidence} confidence`;
    case "anycast":
      return `anycast (${location.service}), no single location`;
    case "private":
      return "private address";
    case "pending":
      return "location still resolving";
    case "unknown":
      return "location unknown";
  }
}

/** What a screen reader reads for one hop of the timeline. */
export function describeTimelineHop(hop: TimelineHop): string {
  const parts = [`Hop ${hop.hopIndex}`, hop.address ?? "no reply"];
  parts.push(describeLocation(hop.location));
  if (hop.avgMs != null) {
    parts.push(
      `RTT ${formatMs(hop.avgMs)} ms` +
        (hop.minMs != null && hop.maxMs != null
          ? ` (min ${formatMs(hop.minMs)}, max ${formatMs(hop.maxMs)})`
          : "")
    );
  }
  if (hop.lossPercent != null) {
    parts.push(`${Math.round(hop.lossPercent)}% loss`);
  }
  if (hop.jumpMs != null) {
    parts.push(`${formatMs(hop.jumpMs)} ms more than hop ${hop.jumpFromHopIndex}`);
  }
  return parts.join(", ");
}
