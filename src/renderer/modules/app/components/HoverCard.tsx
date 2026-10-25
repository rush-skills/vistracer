import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { hoverCardContent, placeCard } from "@renderer/lib/hoverCard";
import { useRouteInfra } from "@renderer/hooks/useInfra";
import { satelliteData, useSatelliteLinks } from "@renderer/hooks/useSatellites";
import { satelliteLinkSummary } from "@renderer/lib/satellites/isp";
import { readySource, useInfraStore } from "@renderer/state/infraStore";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import "./HoverCard.css";

/**
 * A compact card for the hop, site, cable or satellite under the pointer on
 * the globe, or the hop in the timeline. It reads the stores only, so
 * hovering sends nothing anywhere. The card ignores the pointer so it never
 * steals the hover. A hop wins over a site.
 */
export const HoverCard: React.FC = () => {
  const hopIndex = useTracerouteStore((state) => state.hoveredHopIndex);
  const hopAnchor = useTracerouteStore((state) => state.hoverAnchor);
  const capturing = useTracerouteStore((state) => state.captureActive);
  const run = useTracerouteStore(selectCurrentRun);
  const hoveredSite = useInfraStore((state) => state.hoveredSite);
  const sources = useInfraStore((state) => state.sources);
  const code = useInfraStore((state) => state.code);
  const route = useRouteInfra();
  const satelliteLinks = useSatelliteLinks();
  const hop = run?.hops.find((candidate) => candidate.hopIndex === hopIndex);
  const cloud = hop ? route.cloudMatches.get(hop.hopIndex) : undefined;
  const satellite = hop ? satelliteLinks.get(hop.hopIndex) : undefined;
  const content = useMemo(() => (hop ? hoverCardContent(hop) : null), [hop]);
  const site = useMemo(() => {
    if (content || !hoveredSite || !code) {
      return null;
    }
    if (hoveredSite.layer === "satellites") {
      return code.satelliteCardContent(
        hoveredSite,
        satelliteData(sources),
        satelliteLinks,
        Date.now()
      );
    }
    const input = {
      peeringdb: readySource(sources, "peeringdb-sites"),
      cloud: readySource(sources, "cloud-regions"),
      cables: readySource(sources, "submarine-cables")
    };
    return code.siteCardContent({ ...hoveredSite, layer: hoveredSite.layer }, input, route);
  }, [content, hoveredSite, code, sources, route, satelliteLinks]);
  const anchor = content ? hopAnchor : site ? hoveredSite?.anchor : undefined;
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
  }, [anchor, content, site, capturing]);

  if ((!content && !site) || !anchor || capturing) {
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
      {content && (
        <>
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
          {cloud && (
            <div className="hover-card__cloud">
              {cloud.region
                ? `Cloud: ${cloud.provider.shortName} ${cloud.region.code}, ${cloud.confidence} confidence`
                : `Cloud: ${cloud.provider.name}'s network, ${cloud.confidence} confidence`}
            </div>
          )}
          {satellite && (
            <div className="hover-card__satellite">
              {satelliteLinkSummary(satellite)}
            </div>
          )}
          {content.note && <p className="hover-card__note">{content.note}</p>}
        </>
      )}
      {site && (
        <>
          <div className="hover-card__title">
            <strong>{site.title}</strong>
          </div>
          {site.lines.map((line) => (
            <div key={line} className="hover-card__network">
              {line}
            </div>
          ))}
          {site.route.map((line) => (
            <div key={line} className="hover-card__route">
              {line}
            </div>
          ))}
          {site.more && <p className="hover-card__note">{site.more}</p>}
        </>
      )}
    </div>
  );
};
