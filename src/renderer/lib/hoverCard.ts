import type { HopResolution } from "@common/ipc";
import type { HoverAnchor } from "@renderer/state/tracerouteStore";
import { SOURCE_LABELS, formatRadius } from "../modules/app/lib/location";
import { hopPosition } from "./globe";
import { formatMs } from "./timeline";

/**
 * What the hover card says about a hop. Only data already in the run: the
 * card never looks anything up.
 */
export interface HoverCardContent {
  title: string;
  host: string | null;
  address: string;
  network: string | null;
  place: string | null;
  placeDetail: string | null;
  rtt: string | null;
  loss: string | null;
  note: string | null;
}

export function hoverCardContent(hop: HopResolution): HoverCardContent {
  const best = hopPosition(hop);
  const { anycast } = hop.location;
  const { avgRttMs, minRttMs, maxRttMs } = hop.latency;
  const asn = hop.asn?.asn;

  let note: string | null = null;
  if (anycast) {
    note = `Anycast: many ${anycast.service} sites share this address, and the nearest one answered. The globe shows no point for it.`;
  } else if (best?.rtt?.verdict === "conflict") {
    note = `The RTT check against hop ${best.rtt.referenceHopIndex} disagrees with this location; one of the two is wrong.`;
  } else if (!best && hop.isPrivate) {
    note = "Private address: it has no public location.";
  } else if (!best && hop.lookupState === "pending" && hop.ipAddress) {
    note = "Looking up…";
  }

  return {
    title: `Hop ${hop.hopIndex}`,
    host: hop.hostName,
    address: hop.ipAddress ?? "No reply",
    network: asn != null ? `AS${asn}${hop.asn?.name ? ` ${hop.asn.name}` : ""}` : null,
    place: best?.label ?? null,
    placeDetail: best
      ? `${SOURCE_LABELS[best.source]}: ${best.confidence} confidence, ${formatRadius(best.radiusKm)}`
      : null,
    rtt:
      avgRttMs == null
        ? null
        : minRttMs != null && maxRttMs != null && maxRttMs > minRttMs
          ? `${formatMs(avgRttMs)} ms (${formatMs(minRttMs)}–${formatMs(maxRttMs)})`
          : `${formatMs(avgRttMs)} ms`,
    loss: hop.lossPercent != null && hop.lossPercent > 0 ? `${Math.round(hop.lossPercent)}% loss` : null,
    note
  };
}

export interface Size {
  width: number;
  height: number;
}

/** Space between the anchor and the card, and between the card and the window edge. */
export const CARD_GAP = 12;
export const CARD_MARGIN = 8;

const clamp = (value: number, size: number, limit: number) =>
  Math.max(CARD_MARGIN, Math.min(value, limit - size - CARD_MARGIN));

/**
 * Top-left corner of the card, in client pixels, so that the card stays in
 * the window. Next to the pointer: below and to the right, flipped to the
 * left or above near an edge. On a timeline hop: centred above it, below
 * when there is no room above.
 */
export function placeCard(anchor: HoverAnchor, card: Size, view: Size): { left: number; top: number } {
  if (anchor.kind === "point") {
    const right = anchor.x + CARD_GAP;
    const below = anchor.y + CARD_GAP;
    const left =
      right + card.width <= view.width - CARD_MARGIN ? right : anchor.x - CARD_GAP - card.width;
    const top =
      below + card.height <= view.height - CARD_MARGIN ? below : anchor.y - CARD_GAP - card.height;
    return { left: clamp(left, card.width, view.width), top: clamp(top, card.height, view.height) };
  }
  const above = anchor.top - CARD_GAP - card.height;
  const top = above >= CARD_MARGIN ? above : anchor.top + anchor.height + CARD_GAP;
  const left = anchor.left + anchor.width / 2 - card.width / 2;
  return { left: clamp(left, card.width, view.width), top: clamp(top, card.height, view.height) };
}
