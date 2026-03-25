import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  GeoDatabaseMeta,
  IntegrationSettings,
  ProviderId,
  TracerouteProtocol
} from "@common/ipc";
import { useRecentRuns } from "@renderer/hooks/useRecentRuns";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { FiChevronDown, FiChevronUp, FiHelpCircle, FiSettings } from "react-icons/fi";
import { IntegrationSettingsModal } from "./IntegrationSettingsModal";
import logo from "@assets/logo.png";
import { UI_EVENTS } from "../lib/uiEvents";
import "./TopBar.css";

interface TracerouteFormState {
  target: string;
  protocol: TracerouteProtocol;
  maxHops: number;
  timeoutMs: number;
  packetCount: number;
  forceFresh: boolean;
}

const defaultState: TracerouteFormState = {
  target: "",
  protocol: "ICMP",
  maxHops: 30,
  timeoutMs: 4000,
  packetCount: 3,
  forceFresh: false
};

const numericConstraints = {
  maxHops: { min: 1, max: 64 },
  timeoutMs: { min: 500, max: 20000 },
  packetCount: { min: 1, max: 5 }
} as const;

const integrationDefaults: IntegrationSettings = {
  teamCymru: { enabled: true },
  rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
  ripeStat: { enabled: true, sourceApp: "VisTracer" },
  peeringDb: { enabled: false }
};

type IntegrationKey = keyof IntegrationSettings;

const integrationToggleConfig: Array<{
  key: IntegrationKey;
  label: string;
  description: string;
  providerId: ProviderId;
}> = [
  {
    key: "teamCymru",
    label: "Team Cymru",
    description: "IP ↔ ASN mapping",
    providerId: "team-cymru"
  },
  {
    key: "rdap",
    label: "RDAP",
    description: "Registry metadata fallback",
    providerId: "rdap"
  },
  {
    key: "ripeStat",
    label: "RIPE Stat",
    description: "Prefix + holder enrichment",
    providerId: "ripe-stat"
  },
  {
    key: "peeringDb",
    label: "PeeringDB",
    description: "Facility & operator context",
    providerId: "peeringdb"
  }
];

const normalizeIntegrations = (
  settings?: Partial<IntegrationSettings>
): IntegrationSettings => ({
  teamCymru: {
    enabled: settings?.teamCymru?.enabled ?? integrationDefaults.teamCymru.enabled
  },
  rdap: {
    enabled: settings?.rdap?.enabled ?? integrationDefaults.rdap.enabled,
    baseUrl: settings?.rdap?.baseUrl ?? integrationDefaults.rdap.baseUrl
  },
  ripeStat: {
    enabled: settings?.ripeStat?.enabled ?? integrationDefaults.ripeStat.enabled,
    sourceApp: "VisTracer"
  },
  peeringDb: {
    enabled: settings?.peeringDb?.enabled ?? integrationDefaults.peeringDb.enabled,
    apiKey: settings?.peeringDb?.apiKey
  }
});

export const TopBar: React.FC = () => {
  const [form, setForm] = useState<TracerouteFormState>(defaultState);
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettings>(integrationDefaults);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationSaveError, setIntegrationSaveError] = useState<string | undefined>(undefined);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [integrationsExpanded, setIntegrationsExpanded] = useState(false);
  const [geoMeta, setGeoMeta] = useState<GeoDatabaseMeta | undefined>(undefined);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState<string | undefined>(undefined);
  const status = useTracerouteStore((state) => state.status);
  const error = useTracerouteStore((state) => state.error);
  const startRun = useTracerouteStore((state) => state.startRun);
  const cancelRun = useTracerouteStore((state) => state.cancelRun);
  const pendingRequest = useTracerouteStore((state) => state.pendingRequest);
  const currentRunId = useTracerouteStore((state) => state.currentRunId);
  const currentRun = useTracerouteStore(selectCurrentRun);
  const queryClient = useQueryClient();
  const { data: recentRuns } = useRecentRuns();

  const isRunning = status === "running";

  useEffect(() => {
    const handleOpenSettings = () => setSettingsModalOpen(true);
    const handleExpandIntegrations = () => setIntegrationsExpanded(true);

    window.addEventListener(UI_EVENTS.OPEN_SETTINGS_MODAL, handleOpenSettings);
    window.addEventListener(UI_EVENTS.EXPAND_INTEGRATIONS_PANEL, handleExpandIntegrations);

    return () => {
      window.removeEventListener(UI_EVENTS.OPEN_SETTINGS_MODAL, handleOpenSettings);
      window.removeEventListener(UI_EVENTS.EXPAND_INTEGRATIONS_PANEL, handleExpandIntegrations);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    window.visTracer
      .getSettings<IntegrationSettings>("integrations")
      .then((stored) => {
        if (!mounted) {
          return;
        }
        const merged = normalizeIntegrations(stored ?? undefined);
        setIntegrationSettings(merged);
      })
      .catch((loadError) => {
        if (!mounted) {
          return;
        }
        const message =
          loadError instanceof Error
            ? loadError.message
            : "Failed to load integration settings.";
        setIntegrationSaveError(message);
      })
      .finally(() => {
        if (mounted) {
          setIntegrationsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const loadGeoMeta = React.useCallback(async () => {
    setGeoLoading(true);
    try {
      const meta = await window.visTracer.getGeoDatabaseMeta();
      setGeoMeta(meta);
      setGeoError(undefined);
    } catch (metaError) {
      const message =
        metaError instanceof Error
          ? metaError.message
          : "Failed to load GeoIP database status.";
      setGeoError(message);
    } finally {
      setGeoLoading(false);
    }
  }, []);

  useEffect(() => {
    if (settingsModalOpen) {
      void loadGeoMeta();
    }
  }, [settingsModalOpen, loadGeoMeta]);

  const providerErrors = useMemo<Partial<Record<ProviderId, string>>>(() => {
    if (!currentRun) {
      return {};
    }

    const errors: Partial<Record<ProviderId, string>> = {};

    for (const hop of currentRun.hops) {
      if (!hop.providers) {
        continue;
      }

      for (const provider of hop.providers) {
        // Skip if not an error, or if already have an error for this provider
        if (provider.status !== "error" || errors[provider.provider]) {
          continue;
        }

        // Filter out "no data" messages - these are not real errors
        const message = provider.message ?? "Provider returned an error.";
        const isNoDataMessage = message.toLowerCase().includes("no data");

        if (!isNoDataMessage) {
          errors[provider.provider] = message;
        }
      }
    }

    return errors;
  }, [currentRun]);

  const persistIntegrations = React.useCallback(
    async (next: IntegrationSettings) => {
      try {
        const payload: IntegrationSettings = {
          ...next,
          ripeStat: { ...next.ripeStat, sourceApp: "VisTracer" }
        };
        await window.visTracer.setSettings("integrations", payload);
        setIntegrationSaveError(undefined);
      } catch (persistError) {
        const message =
          persistError instanceof Error
            ? persistError.message
            : "Failed to update integration settings.";
        setIntegrationSaveError(message);
        throw new Error(message);
      }
    },
    []
  );

  const handleGeoSave = React.useCallback(
    async (paths: { cityPath?: string; asnPath?: string }) => {
      setGeoLoading(true);
      try {
        await window.visTracer.updateGeoDatabasePaths(paths.cityPath, paths.asnPath);
        await loadGeoMeta();
        setGeoError(undefined);
      } catch (updateError) {
        const message =
          updateError instanceof Error
            ? updateError.message
            : "Failed to update GeoIP database paths.";
        setGeoError(message);
        throw new Error(message);
      } finally {
        setGeoLoading(false);
      }
    },
    [loadGeoMeta]
  );

  const handleIntegrationToggle =
    (key: IntegrationKey) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const enabled = event.target.checked;
      setIntegrationSettings((previous) => {
        const snapshot = previous;
        const nextSection = { ...snapshot[key], enabled } as IntegrationSettings[IntegrationKey];
        const next: IntegrationSettings = {
          ...snapshot,
          [key]: nextSection
        };

        void persistIntegrations(next).catch(() => {
          setIntegrationSettings(snapshot);
        });

        return next;
      });
    };

  const isSubmitEnabled = useMemo(() => {
    if (!form.target.trim()) {
      return false;
    }
    if (isRunning && pendingRequest) {
      return false;
    }
    return true;
  }, [form.target, isRunning, pendingRequest]);

  const handleChange = (field: keyof TracerouteFormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value =
        field === "forceFresh"
          ? (event as React.ChangeEvent<HTMLInputElement>).target.checked
          : event.target.value;

      setForm((prev) => {
        if (field === "maxHops" || field === "timeoutMs" || field === "packetCount") {
          const limits = numericConstraints[field];
          const numeric = Number(value);
          const clamped = Number.isNaN(numeric)
            ? limits.min
            : Math.min(Math.max(numeric, limits.min), limits.max);
          return { ...prev, [field]: clamped };
        }

        if (field === "forceFresh") {
          return { ...prev, [field]: Boolean(value) };
        }

        return { ...prev, [field]: value };
      });
    };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isSubmitEnabled) {
      return;
    }

    const target = form.target.trim();
    if (!target) {
      return;
    }

    await startRun({
      target,
      protocol: form.protocol,
      maxHops: form.maxHops,
      timeoutMs: form.timeoutMs,
      packetCount: form.packetCount,
      forceFresh: form.forceFresh
    });

    void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
  };

  const handleRecentRunSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value) {
      return;
    }

    const recent = recentRuns?.find((run) => run.id === value);
    if (recent) {
      setForm((prev) => ({
        ...prev,
        target: recent.target,
        protocol: recent.protocol
      }));
    }
  };

  const runButtonClass = `top-bar__run${!isSubmitEnabled ? " top-bar__run--disabled" : ""}`;

  return (
    <header className="top-bar">
      <form className="top-bar__form" onSubmit={handleSubmit}>
        <div className="top-bar__input-group">
          <img src={logo} alt="VisTracer" className="top-bar__logo" />
          <input
            className="top-bar__input"
            type="text"
            name="target"
            placeholder="example.com or 8.8.8.8"
            autoComplete="off"
            value={form.target}
            onChange={handleChange("target")}
            disabled={isRunning}
            aria-label="Traceroute target"
          />
          <select
            className="top-bar__select"
            name="protocol"
            value={form.protocol}
            onChange={handleChange("protocol")}
            disabled={isRunning}
            aria-label="Probe protocol"
          >
            <option value="ICMP">ICMP</option>
            <option value="UDP">UDP</option>
            <option value="TCP">TCP</option>
          </select>
          <button
            type="button"
            className="top-bar__toggle"
            aria-label={integrationsExpanded ? "Hide enrichment services" : "Show enrichment services"}
            aria-expanded={integrationsExpanded}
            onClick={() => setIntegrationsExpanded((prev) => !prev)}
          >
            {integrationsExpanded ? <FiChevronUp /> : <FiChevronDown />}
          </button>
          <button type="submit" className={runButtonClass} disabled={!isSubmitEnabled}>
            {isRunning ? "Running…" : "Run"}
          </button>
          {isRunning ? (
            <button type="button" className="top-bar__cancel" onClick={() => void cancelRun()}>
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="top-bar__reset"
              onClick={() => setForm(defaultState)}
              disabled={isRunning}
            >
              Clear
            </button>
          )}
          <button
            type="button"
            className="top-bar__guide"
            onClick={() => window.dispatchEvent(new CustomEvent(UI_EVENTS.SHOW_ONBOARDING))}
            aria-label="Show onboarding guide"
          >
            <FiHelpCircle />
          </button>
          <button
            type="button"
            className="top-bar__settings"
            onClick={() => setSettingsModalOpen(true)}
            aria-label="Integration settings"
          >
            <FiSettings />
          </button>
        </div>
        {integrationsExpanded && (
          <>
            <div className="top-bar__integrations">
              {integrationToggleConfig.map((config) => {
                const section = integrationSettings[config.key];
                const providerError = providerErrors[config.providerId];
                return (
                  <label key={config.key} className="top-bar__integration-toggle">
                    <span className="top-bar__integration-header">
                      <input
                        type="checkbox"
                        checked={section.enabled}
                        onChange={handleIntegrationToggle(config.key)}
                        disabled={integrationsLoading}
                      />
                      <span>{config.label}</span>
                    </span>
                    <small className="top-bar__integration-note">{config.description}</small>
                    {providerError && (
                      <small className="top-bar__integration-error" role="status">
                        {providerError}
                      </small>
                    )}
                  </label>
                );
              })}
            </div>
            {integrationSaveError && (
              <div className="top-bar__integration-error top-bar__integration-error--global" role="status">
                {integrationSaveError}
              </div>
            )}
          </>
        )}
        <div className="top-bar__advanced">
          <label className="top-bar__number">
            Max hops
            <input
              type="number"
              min={1}
              max={64}
              value={form.maxHops}
              onChange={handleChange("maxHops")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__number">
            Timeout (ms)
            <input
              type="number"
              min={500}
              max={20000}
              step={250}
              value={form.timeoutMs}
              onChange={handleChange("timeoutMs")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__number">
            Probes/hop
            <input
              type="number"
              min={1}
              max={5}
              value={form.packetCount}
              onChange={handleChange("packetCount")}
              disabled={isRunning}
            />
          </label>
          <label className="top-bar__checkbox">
            <input
              type="checkbox"
              checked={form.forceFresh}
              onChange={handleChange("forceFresh")}
              disabled={isRunning}
            />
            Force fresh lookups
          </label>
          <select
            className="top-bar__recent"
            onChange={handleRecentRunSelect}
            value=""
            disabled={!recentRuns?.length}
          >
            <option value="">Recent runs</option>
            {recentRuns?.map((run) => (
              <option key={run.id} value={run.id}>{`${run.target} (${run.protocol})`}</option>
            ))}
          </select>
        </div>
        <div className="top-bar__status" role="status" aria-live="polite">
          {isRunning && pendingRequest ? (
            <span>
              Running traceroute to <strong>{pendingRequest.target}</strong>…
            </span>
          ) : status === "success" && currentRunId ? (
            <span>
              Completed run <code>{currentRunId.slice(0, 8)}</code>
            </span>
          ) : status === "error" && error ? (
            <span className="top-bar__status-error">{error}</span>
          ) : (
            <span>Ready for next target.</span>
          )}
        </div>
      </form>
      <IntegrationSettingsModal
        isOpen={settingsModalOpen}
        settings={integrationSettings}
        geoMeta={geoMeta}
        geoLoading={geoLoading}
        geoError={geoError}
        onClose={() => setSettingsModalOpen(false)}
        onSave={async (updated) => {
          await persistIntegrations(updated);
          setIntegrationSettings(updated);
        }}
        onGeoSave={handleGeoSave}
      />
    </header>
  );
};
