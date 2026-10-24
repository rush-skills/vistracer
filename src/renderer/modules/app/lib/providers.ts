import type { HopResolution, ProviderId, ProviderStatus } from "@common/ipc";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  maxmind: "GeoLite2",
  "team-cymru": "Team Cymru",
  rdap: "RDAP",
  "ripe-stat": "RIPEstat",
  peeringdb: "PeeringDB",
  "peeringdb-ix": "PeeringDB IX list"
};

export const findProvider = (
  hop: HopResolution,
  provider: ProviderId
): ProviderStatus | undefined => hop.providers?.find((status) => status.provider === provider);

export const failedProviders = (hop: HopResolution): ProviderStatus[] =>
  (hop.providers ?? []).filter((status) => status.status === "error");

export const describeFailures = (failures: ProviderStatus[]): string =>
  failures
    .map((failure) => `${PROVIDER_LABELS[failure.provider]}: ${failure.message ?? "lookup failed"}`)
    .join("\n");
