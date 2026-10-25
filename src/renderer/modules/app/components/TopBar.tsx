import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type GeoDatabaseMeta,
  type IntegrationSettings,
  type ProviderId,
  type TracerouteProtocol
} from "@common/ipc";
import { useRecentRuns } from "@renderer/hooks/useRecentRuns";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { FiSliders } from "react-icons/fi";
import { usePanel } from "@renderer/hooks/usePanel";
import { useExportStore } from "@renderer/state/exportStore";
import { IntegrationSettingsModal } from "./IntegrationSettingsModal";
import logo from "@assets/logo.png";
import { UI_EVENTS, type StartTraceDetail } from "../lib/uiEvents";
import { INTEGRATION_DEFAULTS, normalizeIntegrations } from "../lib/integrationSettings";
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
  timeoutMs: { min: 1000, max: 10000 },
  packetCount: { min: 1, max: 5 }
} as const;

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
    description: "Network (ASN) of each address",
    providerId: "team-cymru"
  },
  {
    key: "rdap",
    label: "RDAP",
    description: "Registry owner and address block",
    providerId: "rdap"
  },
  {
    key: "ripeStat",
    label: "RIPEstat",
    description: "Announced prefix from live BGP data",
    providerId: "ripe-stat"
  },
  {
    key: "peeringDb",
    label: "PeeringDB",
    description: "Network type and peering policy",
    providerId: "peeringdb"
  },
  {
    key: "ixMatching",
    label: "Exchanges",
    description: "Place hops at internet exchanges",
    providerId: "peeringdb-ix"
  }
];

export const TopBar: React.FC = () => {
  const [form, setForm] = useState<TracerouteFormState>(defaultState);
  const [integrationSettings, setIntegrationSettings] = useState<IntegrationSettings>(INTEGRATION_DEFAULTS);
  const [integrationsLoading, setIntegrationsLoading] = useState(true);
  const [integrationSaveError, setIntegrationSaveError] = useState<string | undefined>(undefined);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [optionsCollapsed, setOptionsCollapsed] = usePanel("trace-options");
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
  const exporting = useExportStore((state) => state.working);

  // The command bar starts traces through UI_EVENTS.START_TRACE; they use
  // the options in this form, read from the latest render.
  const formRef = useRef(form);
  formRef.current = form;
  const traceTo = React.useCallback(
    async (rawTarget: string) => {
      const target = rawTarget.trim();
      // A new run during an export would end the export's camera lock.
      if (
        !target ||
        useTracerouteStore.getState().status === "running" ||
        useExportStore.getState().working
      ) {
        return;
      }
      const options = formRef.current;
      await startRun({
        target,
        protocol: options.protocol,
        maxHops: options.maxHops,
        timeoutMs: options.timeoutMs,
        packetCount: options.packetCount,
        forceFresh: options.forceFresh
      });
    },
    [startRun]
  );

  useEffect(() => {
    const handleStartTrace = (event: Event) => {
      const { target } = (event as CustomEvent<StartTraceDetail>).detail;
      setForm((previous) => ({ ...previous, target }));
      void traceTo(target);
    };
    window.addEventListener(UI_EVENTS.START_TRACE, handleStartTrace);
    return () => window.removeEventListener(UI_EVENTS.START_TRACE, handleStartTrace);
  }, [traceTo]);

  // Every finished run, from this form or the command bar, is a recent run.
  useEffect(() => {
    if (status === "success" || status === "error") {
      void queryClient.invalidateQueries({ queryKey: ["recent-runs"] });
    }
  }, [status, queryClient]);

  useEffect(() => {
    const handleOpenSettings = () => setSettingsModalOpen(true);
    const handleExpandIntegrations = () => setOptionsCollapsed(false);

    window.addEventListener(UI_EVENTS.OPEN_SETTINGS_MODAL, handleOpenSettings);
    window.addEventListener(UI_EVENTS.EXPAND_INTEGRATIONS_PANEL, handleExpandIntegrations);

    return () => {
      window.removeEventListener(UI_EVENTS.OPEN_SETTINGS_MODAL, handleOpenSettings);
      window.removeEventListener(UI_EVENTS.EXPAND_INTEGRATIONS_PANEL, handleExpandIntegrations);
    };
  }, [setOptionsCollapsed]);

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

      // "error" only means a failed lookup; a provider with no record reports "success".
      for (const provider of hop.providers) {
        if (provider.status === "error" && !errors[provider.provider]) {
          errors[provider.provider] = provider.message ?? "Lookup failed.";
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
    if (!form.target.trim() || exporting) {
      return false;
    }
    if (isRunning && pendingRequest) {
      return false;
    }
    return true;
  }, [form.target, isRunning, pendingRequest, exporting]);

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

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitEnabled) {
      void traceTo(form.target);
    }
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

  const optionsId = "trace-options";
  const isV6 = (target: string) => target.includes(":");

  return (
    <header className="trace-panel glass">
      <form className="trace-panel__form" onSubmit={handleSubmit}>
        <div className="trace-panel__row">
          <img src={logo} alt="VisTracer" className="trace-panel__logo" />
          <input
            className="trace-panel__target"
            type="text"
            name="target"
            placeholder="Host name or IP address"
            autoComplete="off"
            spellCheck={false}
            value={form.target}
            onChange={handleChange("target")}
            disabled={isRunning}
            aria-label="Traceroute target"
          />
          <select
            className="trace-panel__protocol"
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
          {isRunning ? (
            <button type="button" className="button button--danger" onClick={() => void cancelRun()}>
              Cancel
            </button>
          ) : (
            <button type="submit" className="button button--primary" disabled={!isSubmitEnabled}>
              Trace
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Trace options"
            aria-expanded={!optionsCollapsed}
            aria-controls={optionsId}
            onClick={() => setOptionsCollapsed(!optionsCollapsed)}
          >
            <FiSliders aria-hidden />
          </button>
        </div>
        <div className="trace-panel__status" role="status" aria-live="polite">
          {isRunning && pendingRequest ? (
            <span>
              Tracing <strong>{pendingRequest.target}</strong>…
              {isV6(pendingRequest.target) && <span className="trace-panel__badge">IPv6</span>}
            </span>
          ) : status === "success" && currentRunId ? (
            <span>
              Completed run <code>{currentRunId.slice(0, 8)}</code>
              {currentRun && (
                <span className="trace-panel__badge">
                  {isV6(currentRun.request.target) ? "IPv6" : "IPv4"}
                </span>
              )}
            </span>
          ) : status === "error" && error ? (
            <span className="trace-panel__status-error">{error}</span>
          ) : (
            <span>Enter a host to trace the route from this computer.</span>
          )}
        </div>
        {!optionsCollapsed && (
          <div id={optionsId} className="trace-panel__options">
            <div className="trace-panel__fields">
              <label className="trace-panel__number">
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
              <label className="trace-panel__number">
                Timeout (ms)
                <input
                  type="number"
                  min={1000}
                  max={10000}
                  step={250}
                  value={form.timeoutMs}
                  onChange={handleChange("timeoutMs")}
                  disabled={isRunning}
                />
              </label>
              <label className="trace-panel__number">
                Probes per hop
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={form.packetCount}
                  onChange={handleChange("packetCount")}
                  disabled={isRunning}
                />
              </label>
              <select
                className="trace-panel__recent"
                aria-label="Recent runs"
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
            <div className="trace-panel__fields">
              <label className="trace-panel__check">
                <input
                  type="checkbox"
                  className="switch"
                  checked={form.forceFresh}
                  onChange={handleChange("forceFresh")}
                  disabled={isRunning}
                />
                Force fresh lookups
              </label>
              <button
                type="button"
                className="button"
                onClick={() => setForm(defaultState)}
                disabled={isRunning}
              >
                Reset options
              </button>
            </div>
            <fieldset className="trace-panel__providers">
              <legend>Lookups for each hop</legend>
              {integrationToggleConfig.map((config) => {
                const section = integrationSettings[config.key];
                const providerError = providerErrors[config.providerId];
                return (
                  <label key={config.key} className="trace-panel__provider">
                    <input
                      type="checkbox"
                      className="switch"
                      checked={section.enabled}
                      onChange={handleIntegrationToggle(config.key)}
                      disabled={integrationsLoading}
                    />
                    <span>
                      {config.label}
                      <small>{config.description}</small>
                      {providerError && (
                        <small className="trace-panel__provider-error" role="status">
                          {providerError}
                        </small>
                      )}
                    </span>
                  </label>
                );
              })}
            </fieldset>
            {integrationSaveError && (
              <div className="trace-panel__provider-error" role="status">
                {integrationSaveError}
              </div>
            )}
          </div>
        )}
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
