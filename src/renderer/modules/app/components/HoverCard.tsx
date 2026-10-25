import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { hoverCardContent, placeCard } from "@renderer/lib/hoverCard";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import "./HoverCard.css";

/**
 * A compact card for the hop under the pointer on the globe or in the
 * timeline. It reads the run in the store only, so hovering sends nothing
 * anywhere. The card ignores the pointer so it never steals the hover.
 */
export const HoverCard: React.FC = () => {
  const hopIndex = useTracerouteStore((state) => state.hoveredHopIndex);
  const anchor = useTracerouteStore((state) => state.hoverAnchor);
  const capturing = useTracerouteStore((state) => state.captureActive);
  const run = useTracerouteStore(selectCurrentRun);
  const hop = run?.hops.find((candidate) => candidate.hopIndex === hopIndex);
  const content = useMemo(() => (hop ? hoverCardContent(hop) : null), [hop]);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !anchor) {
      setPosition(undefined);
      return;
    }
    setPosition(
      placeCard(
        anchor,
        { width: card.offsetWidth, height: card.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
    // `capturing`: the card is not rendered during an export, so it must be
    // measured and placed again when the export ends.
  }, [anchor, content, capturing]);

  if (!content || !anchor || capturing) {
    return null;
  }

  return (
    <div
      ref={cardRef}
      className="hover-card glass"
      role="tooltip"
      // Measured first, then placed; hidden until placed so it never flashes at 0,0.
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <div className="hover-card__title">
        <strong>{content.title}</strong>
        {content.rtt && <span className="hover-card__rtt">{content.rtt}</span>}
      </div>
      {content.host && <div className="hover-card__host">{content.host}</div>}
      <code className="hover-card__address">{content.address}</code>
      {content.network && <div className="hover-card__network">{content.network}</div>}
      {content.place && (
        <div className="hover-card__place">
          {content.place}
          <small>{content.placeDetail}</small>
        </div>
      )}
      {content.loss && <div className="hover-card__loss">{content.loss}</div>}
      {content.note && <p className="hover-card__note">{content.note}</p>}
    </div>
  );
};
