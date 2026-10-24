import React from "react";
import type { HopResolution, PeeringDbDetails } from "@common/ipc";
import { PROVIDER_LABELS, findProvider } from "../lib/providers";

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

      {hop.isAnycastSuspected && (
        <p className="hop-inspector__notice">
          Suspected anycast: the measured RTT is too short for the distance to the GeoLite2
          location, so a closer replica answered (or the geolocation is wrong).
        </p>
      )}

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
