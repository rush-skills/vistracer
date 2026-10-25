import React from "react";
import type { HopResolution, LocationEstimate, PeeringDbDetails } from "@common/ipc";
import { useRouteInfra } from "@renderer/hooks/useInfra";
import { useSatelliteLinks } from "@renderer/hooks/useSatellites";
import { formatKm, regionTitle } from "@renderer/lib/infra/format";
import { layerActive, layerVisibility, type LayerId } from "@renderer/lib/layers";
import { SATELLITE_GROUPS } from "@renderer/lib/satellites/groups";
import { readySource, useInfraStore } from "@renderer/state/infraStore";
import { useUiStore } from "@renderer/state/uiStore";
import { PROVIDER_LABELS, findProvider } from "../lib/providers";
import { HINT_RULE_LABELS, SOURCE_LABELS, describeRtt, formatRadius } from "../lib/location";

interface HopInspectorProps {
  hop: HopResolution;
}

const formatRtts = (rtts: number[]) =>
  rtts.length === 0 ? "no replies" : `${rtts.map((rtt) => rtt.toString()).join(", ")} ms`;

const peeringDbRows = (details: PeeringDbDetails): Array<[string, string]> => {
  const rows: Array<[string, string | number | undefined]> = [
    ["Network", details.name],
    ["Also known as", details.aka],
    ["Type", details.infoType],
    ["Scope", details.infoScope],
    ["Peering policy", details.policyGeneral],
    ["Traffic", details.infoTraffic],
    ["Traffic ratio", details.infoRatio],
    ["Exchanges (IXPs)", details.ixCount],
    ["Facilities", details.facCount],
    ["IRR as-set", details.irrAsSet],
    ["Website", details.website],
    ["PeeringDB record", details.id != null ? `net #${details.id}` : undefined]
  ];
  return rows.filter((row): row is [string, string | number] => row[1] != null && row[1] !== "")
    .map(([label, value]) => [label, String(value)]);
};

const PeeringDbSection: React.FC<HopInspectorProps> = ({ hop }) => {
  const status = findProvider(hop, "peeringdb");
  let body: React.ReactNode;

  if (hop.peeringDb) {
    body = (
      <dl className="hop-inspector__facts">
        {peeringDbRows(hop.peeringDb).map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    );
  } else if (hop.lookupState === "pending") {
    body = <p className="hop-inspector__empty">Looking up…</p>;
  } else if (!hop.ipAddress) {
    body = <p className="hop-inspector__empty">No address answered at this hop.</p>;
  } else if (!status) {
    body = <p className="hop-inspector__empty">No PeeringDB data.</p>;
  } else if (status.status === "error") {
    body = (
      <p className="hop-inspector__empty hop-inspector__empty--error">
        PeeringDB lookup failed: {status.message ?? "unknown error"}
      </p>
    );
  } else if (status.status === "skipped") {
    body = (
      <p className="hop-inspector__empty">
        PeeringDB not queried: {status.message ?? "skipped"}
      </p>
    );
  } else {
    body = (
      <p className="hop-inspector__empty">
        {hop.asn?.asn ? `AS${hop.asn.asn} has no PeeringDB record.` : "No PeeringDB record."}
      </p>
    );
  }

  return (
    <section className="hop-inspector__section" aria-label="PeeringDB">
      <h4>PeeringDB</h4>
      {body}
    </section>
  );
};

const AnycastNotice: React.FC<HopInspectorProps> = ({ hop }) => {
  const anycast = hop.location.anycast;
  if (!anycast) {
    return null;
  }
  const evidence =
    anycast.evidence === "known-prefix"
      ? `${anycast.service} documents this prefix as anycast.`
      : `AS${hop.asn?.asn ?? "?"} (${anycast.service}) announces its addresses from many sites, and the RTT rules out the GeoLite2 location.`;
  return (
    <p className="hop-inspector__notice" role="note">
      <strong>Anycast.</strong> Many sites share this address and the nearest one answered, so
      the globe shows no point for this hop. {evidence}
      {anycast.maxDistanceKm != null && anycast.referenceHopIndex != null && (
        <>
          {" "}
          The site that answered is at most {Math.round(anycast.maxDistanceKm).toLocaleString("en-US")} km
          from hop {anycast.referenceHopIndex}.
        </>
      )}
      {anycast.evidence === "known-prefix" && anycast.geoliteRuledOut && (
        <> The RTT also rules out the GeoLite2 location.</>
      )}
    </p>
  );
};

const CandidateList: React.FC<{ hop: HopResolution; candidates: LocationEstimate[] }> = ({
  hop,
  candidates
}) => (
  <ul className="hop-inspector__candidates">
    {candidates.map((candidate) => (
      <li
        key={`${candidate.source}-${candidate.label}`}
        className={
          candidate.rtt?.verdict === "infeasible"
            ? "hop-inspector__candidate hop-inspector__candidate--ruled-out"
            : "hop-inspector__candidate"
        }
      >
        <span className="hop-inspector__source-name">{SOURCE_LABELS[candidate.source]}</span>
        <span>{candidate.label}</span>
        <span className="hop-inspector__source-status">
          {candidate.confidence} · {formatRadius(candidate.radiusKm)}
        </span>
        <small>
          {describeRtt(candidate.rtt, hop.hopIndex, hop.location.isRttReference, false)}
        </small>
      </li>
    ))}
  </ul>
);

const LocationSection: React.FC<HopInspectorProps> = ({ hop }) => {
  const { best, alternatives, ixp, hostnameHint, anycast } = hop.location;
  let summary: React.ReactNode = null;

  if (best) {
    summary = (
      <dl className="hop-inspector__facts">
        <dt>Place</dt>
        <dd>{best.label}</dd>
        <dt>Source</dt>
        <dd>{SOURCE_LABELS[best.source]}</dd>
        <dt>Confidence</dt>
        <dd>
          <span className={`hop-details__confidence hop-details__confidence--${best.confidence}`}>
            {best.confidence}
          </span>
        </dd>
        <dt>Radius</dt>
        <dd>{formatRadius(best.radiusKm)}</dd>
        <dt>RTT check</dt>
        <dd>{describeRtt(best.rtt, hop.hopIndex, hop.location.isRttReference, true)}</dd>
      </dl>
    );
  } else if (anycast) {
    summary = null;
  } else if (!hop.ipAddress) {
    summary = <p className="hop-inspector__empty">No address answered at this hop.</p>;
  } else if (alternatives.length > 0) {
    const referenceHop = alternatives.find((candidate) => candidate.rtt)?.rtt?.referenceHopIndex;
    summary = (
      <p className="hop-inspector__empty hop-inspector__empty--error">
        {referenceHop != null
          ? `Every source is weaker than hop ${referenceHop}'s estimate and fails the RTT check against it, so the globe shows no point for this hop.`
          : "No source can be drawn, so the globe shows no point for this hop."}
      </p>
    );
  } else if (hop.lookupState === "pending") {
    summary = <p className="hop-inspector__empty">Looking up…</p>;
  } else if (hop.isPrivate) {
    summary = <p className="hop-inspector__empty">Private address: it has no public location.</p>;
  } else {
    summary = (
      <p className="hop-inspector__empty">
        No location source has data for this address, so the globe shows no point for this hop.
      </p>
    );
  }

  return (
    <section className="hop-inspector__section" aria-label="Location">
      <h4>Location</h4>
      <AnycastNotice hop={hop} />
      {summary}
      {(ixp || hostnameHint) && (
        <dl className="hop-inspector__facts hop-inspector__facts--evidence">
          {ixp && (
            <>
              <dt>IXP</dt>
              <dd>
                {ixp.name}
                <small>
                  {[
                    ixp.prefix,
                    [ixp.city, ixp.country].filter(Boolean).join(", "),
                    ixp.facilityCount > 0
                      ? `${ixp.facilityCount} ${ixp.facilityCount === 1 ? "facility" : "facilities"}`
                      : "no facility coordinates"
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </dd>
            </>
          )}
          {hostnameHint && (
            <>
              <dt>Host name hint</dt>
              <dd>
                <code>{hostnameHint.token}</code> → {hostnameHint.place}
                <small>
                  {HINT_RULE_LABELS[hostnameHint.rule]}
                  {hostnameHint.carrier ? ` · ${hostnameHint.carrier} naming` : ""}
                </small>
              </dd>
            </>
          )}
        </dl>
      )}
      {alternatives.length > 0 && (
        <details className="hop-inspector__more" open={!best && !anycast}>
          <summary>
            {best ? "Other candidates" : "Candidates"} ({alternatives.length})
          </summary>
          <CandidateList hop={hop} candidates={alternatives} />
        </details>
      )}
    </section>
  );
};

const km = (value: number | null) => (value == null ? "" : ` (${formatKm(value)})`);

/**
 * What the shown infrastructure layers say about this hop: the cloud
 * region it is likely in, the exchange and data centre near it, and
 * cables that may carry the link to it; and, from its network alone, a
 * likely satellite link. Nothing else while those layers are off.
 */
const InfraSection: React.FC<HopInspectorProps> = ({ hop }) => {
  const route = useRouteInfra();
  const satellite = useSatelliteLinks().get(hop.hopIndex);
  const saved = useUiStore((state) => state.layers);
  const sites = useInfraStore((state) => readySource(state.sources, "peeringdb-sites"));
  const cloud = route.cloudMatches.get(hop.hopIndex);
  const linked = (links: typeof route.exchangeLinks, names: Map<string, string>) =>
    [...links.entries()].flatMap(([key, list]) =>
      list
        .filter((link) => link.hopIndex === hop.hopIndex)
        .map((link) => ({ name: names.get(key) ?? key, link }))
    );
  const exchanges = linked(
    route.exchangeLinks,
    new Map(sites?.exchanges.map((site) => [site.key, site.name]))
  );
  const facilities = linked(
    route.facilityLinks,
    new Map(sites?.facilities.map((site) => [site.key, site.name]))
  );
  const cables = route.cableGuesses.filter((guess) => guess.toHopIndex === hop.hopIndex);
  if (
    !cloud &&
    !satellite &&
    exchanges.length === 0 &&
    facilities.length === 0 &&
    cables.length === 0
  ) {
    return null;
  }
  const constellation = satellite ? SATELLITE_GROUPS[satellite.isp.group] : undefined;
  const constellationLayer = constellation
    ? (`satellites-${constellation.id}` satisfies LayerId)
    : undefined;
  const constellationShown =
    constellationLayer != null && layerActive(layerVisibility(saved), constellationLayer);
  return (
    <section className="hop-inspector__section" aria-label="Infrastructure">
      <h4>Infrastructure</h4>
      <dl className="hop-inspector__facts">
        {cloud && (
          <>
            <dt>Cloud</dt>
            <dd>
              {cloud.region
                ? regionTitle(cloud.provider, cloud.region)
                : `${cloud.provider.name} network`}{" "}
              <span className={`hop-details__confidence hop-details__confidence--${cloud.confidence}`}>
                {cloud.confidence}
              </span>
              <small>{cloud.reason}</small>
            </dd>
          </>
        )}
        {exchanges.map(({ name, link }) => (
          <React.Fragment key={`ix-${name}`}>
            <dt>Exchange</dt>
            <dd>
              {name}
              <small>
                {link.kind === "on-lan"
                  ? "The address is on its peering LAN."
                  : `Nearest exchange to the estimate${km(link.distanceKm)}.`}
              </small>
            </dd>
          </React.Fragment>
        ))}
        {facilities.map(({ name, link }) => (
          <React.Fragment key={`fac-${name}`}>
            <dt>Data centre</dt>
            <dd>
              {name}
              <small>Nearest data centre to the estimate{km(link.distanceKm)}; a guess.</small>
            </dd>
          </React.Fragment>
        ))}
        {satellite && constellation && constellationLayer && (
          <>
            <dt>Satellite</dt>
            <dd>
              Likely {satellite.isp.name} link{" "}
              <span
                className={`hop-details__confidence hop-details__confidence--${satellite.confidence}`}
              >
                {satellite.confidence}
              </span>
              <small>{satellite.reason}</small>
              {satellite.confidence !== "low" &&
                (constellationShown ? (
                  <small>{constellation.label} satellites are highlighted on the globe.</small>
                ) : (
                  <button
                    type="button"
                    className="button hop-inspector__action"
                    onClick={() => {
                      const ui = useUiStore.getState();
                      // The satellites layer asks for its notice first.
                      ui.setLayerVisible("satellites", true);
                      ui.setLayerVisible(constellationLayer, true);
                    }}
                  >
                    Show {constellation.label} satellites
                  </button>
                ))}
            </dd>
          </>
        )}
        {cables.length > 0 && (
          <>
            <dt>Cable</dt>
            <dd>
              {cables.map((guess) => guess.name).join(" or ")}
              <small>
                A guess from landing points near hops {cables[0].fromHopIndex} and {hop.hopIndex}{" "}
                (TeleGeography data). The link may use another cable.
              </small>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
};

export const HopInspector: React.FC<HopInspectorProps> = ({ hop }) => {
  const responders = hop.responders ?? [];

  return (
    <div className="hop-inspector" aria-label={`Hop ${hop.hopIndex} details`}>
      <h3 className="hop-inspector__title">
        Hop {hop.hopIndex}
        {hop.lookupState === "pending" && (
          <span className="hop-inspector__pending" role="status">
            resolving…
          </span>
        )}
      </h3>

      <section className="hop-inspector__section" aria-label="Responders">
        <h4>
          {responders.length > 1 ? `Responders (${responders.length} paths)` : "Responder"}
        </h4>
        {responders.length === 0 ? (
          <p className="hop-inspector__empty">No address answered at this hop.</p>
        ) : (
          <ul className="hop-inspector__responders">
            {responders.map((responder) => (
              <li key={responder.ipAddress}>
                <code>{responder.ipAddress}</code>
                {responder.hostName && <span>{responder.hostName}</span>}
                <small>{formatRtts(responder.rttsMs)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <LocationSection hop={hop} />
      <InfraSection hop={hop} />

      {hop.asn && (
        <section className="hop-inspector__section" aria-label="Network">
          <h4>Network</h4>
          <dl className="hop-inspector__facts">
            {hop.asn.asn != null && (
              <>
                <dt>ASN</dt>
                <dd>AS{hop.asn.asn}</dd>
              </>
            )}
            {hop.asn.name && (
              <>
                <dt>Holder</dt>
                <dd>{hop.asn.name}</dd>
              </>
            )}
            {hop.asn.network && (
              <>
                <dt>Prefix</dt>
                <dd>{hop.asn.network}</dd>
              </>
            )}
            {(hop.asn.registry || hop.asn.country) && (
              <>
                <dt>Registry</dt>
                <dd>{[hop.asn.registry?.toUpperCase(), hop.asn.country].filter(Boolean).join(" · ")}</dd>
              </>
            )}
          </dl>
        </section>
      )}

      <PeeringDbSection hop={hop} />

      {hop.providers && hop.providers.length > 0 && (
        <section className="hop-inspector__section" aria-label="Sources">
          <h4>Sources</h4>
          <ul className="hop-inspector__sources">
            {hop.providers.map((provider) => (
              <li
                key={provider.provider}
                className={`hop-inspector__source hop-inspector__source--${provider.status}`}
              >
                <span className="hop-inspector__source-name">{PROVIDER_LABELS[provider.provider]}</span>
                <span className="hop-inspector__source-status">
                  {provider.status === "error" ? "failed" : provider.status}
                  {provider.cached ? " (cached)" : ""}
                </span>
                {provider.message && <small>{provider.message}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
