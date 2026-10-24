import { DEFAULT_RDAP_BASE_URL, type IntegrationSettings } from "@common/ipc";

/** Mirrors `IntegrationSettings::default()` in src-tauri/src/commands/persistence.rs. */
export const INTEGRATION_DEFAULTS: IntegrationSettings = {
  teamCymru: { enabled: true },
  rdap: { enabled: true, baseUrl: DEFAULT_RDAP_BASE_URL },
  ripeStat: { enabled: true, sourceApp: "VisTracer" },
  peeringDb: { enabled: false },
  ixMatching: { enabled: true }
};

/**
 * Fills sections that saved settings lack with the defaults, so settings
 * saved by an older version keep working (exchange matching stays on).
 */
export const normalizeIntegrations = (
  settings?: Partial<IntegrationSettings>
): IntegrationSettings => ({
  teamCymru: {
    enabled: settings?.teamCymru?.enabled ?? INTEGRATION_DEFAULTS.teamCymru.enabled
  },
  rdap: {
    enabled: settings?.rdap?.enabled ?? INTEGRATION_DEFAULTS.rdap.enabled,
    baseUrl: settings?.rdap?.baseUrl ?? INTEGRATION_DEFAULTS.rdap.baseUrl
  },
  ripeStat: {
    enabled: settings?.ripeStat?.enabled ?? INTEGRATION_DEFAULTS.ripeStat.enabled,
    sourceApp: "VisTracer"
  },
  peeringDb: {
    enabled: settings?.peeringDb?.enabled ?? INTEGRATION_DEFAULTS.peeringDb.enabled,
    apiKey: settings?.peeringDb?.apiKey
  },
  ixMatching: {
    enabled: settings?.ixMatching?.enabled ?? INTEGRATION_DEFAULTS.ixMatching.enabled
  }
});
