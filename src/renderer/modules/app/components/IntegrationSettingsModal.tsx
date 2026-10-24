import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_RDAP_BASE_URL, type GeoDatabaseMeta, type IntegrationSettings } from "@common/ipc";
import type { VisTracerWindow } from "@common/bridge";
import { FiAlertCircle, FiCheckCircle, FiFolder } from "react-icons/fi";
import { useModalA11y } from "@renderer/hooks/useModalA11y";
import { useUpdateStore, type UpdateStatus } from "@renderer/state/updateStore";
import "./IntegrationSettingsModal.css";

interface IntegrationSettingsModalProps {
  isOpen: boolean;
  settings: IntegrationSettings;
  geoMeta?: GeoDatabaseMeta;
  geoLoading: boolean;
  geoError?: string;
  onClose: () => void;
  onSave: (settings: IntegrationSettings) => Promise<void>;
  onGeoSave: (paths: { cityPath?: string; asnPath?: string }) => Promise<void>;
}

export interface IntegrationSettingsFormState {
  teamCymruEnabled: boolean;
  rdapEnabled: boolean;
  rdapBaseUrl: string;
  ripeStatEnabled: boolean;
  peeringDbEnabled: boolean;
  peeringDbApiKey: string;
  ixMatchingEnabled: boolean;
}

const defaultFormState: IntegrationSettingsFormState = {
  teamCymruEnabled: true,
  rdapEnabled: true,
  rdapBaseUrl: "",
  ripeStatEnabled: true,
  peeringDbEnabled: false,
  peeringDbApiKey: "",
  ixMatchingEnabled: true
};

const formFromSettings = (settings: IntegrationSettings): IntegrationSettingsFormState => ({
  teamCymruEnabled: settings.teamCymru.enabled,
  rdapEnabled: settings.rdap.enabled,
  rdapBaseUrl: settings.rdap.baseUrl ?? "",
  ripeStatEnabled: settings.ripeStat.enabled,
  peeringDbEnabled: settings.peeringDb.enabled,
  peeringDbApiKey: settings.peeringDb.apiKey ?? "",
  ixMatchingEnabled: settings.ixMatching?.enabled ?? true
});

/**
 * Converts the form into settings. Returns an error message instead when a
 * field is invalid; the backend validates the same rules again.
 */
export const buildIntegrationSettings = (
  form: IntegrationSettingsFormState
): { settings: IntegrationSettings } | { error: string } => {
  const baseUrl = form.rdapBaseUrl.trim() || DEFAULT_RDAP_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { error: `RDAP base URL "${baseUrl}" is not a valid URL.` };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { error: "RDAP base URL must start with https:// or http://." };
  }
  const apiKey = form.peeringDbApiKey.trim();
  if (/\s/.test(apiKey)) {
    return { error: "PeeringDB API key must not contain spaces." };
  }

  return {
    settings: {
      teamCymru: { enabled: form.teamCymruEnabled },
      rdap: { enabled: form.rdapEnabled, baseUrl: baseUrl.replace(/\/+$/, "") },
      ripeStat: { enabled: form.ripeStatEnabled, sourceApp: "VisTracer" },
      peeringDb: { enabled: form.peeringDbEnabled, apiKey: apiKey || undefined },
      ixMatching: { enabled: form.ixMatchingEnabled }
    }
  };
};

const updateStatusText = (status: UpdateStatus): string => {
  switch (status.kind) {
    case "idle":
      return "Not checked yet.";
    case "checking":
      return "Checking for updates…";
    case "disabled":
      return status.reason;
    case "up-to-date":
      return "You have the latest version.";
    case "available":
      return `Version ${status.version} is available.`;
    case "installing":
      return `Downloading version ${status.version}…`;
    case "install-failed":
      return `Update to ${status.version} failed: ${status.message}`;
    case "error":
      return status.message;
  }
};

const UpdatesSection: React.FC = () => {
  const status = useUpdateStore((state) => state.status);
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);
  const busy = status.kind === "checking" || status.kind === "installing";

  return (
    <section className="integration-settings-modal__updates" aria-labelledby="integration-settings-updates-title">
      <header>
        <h3 id="integration-settings-updates-title">Updates</h3>
        {currentVersion && <small>Installed version {currentVersion}</small>}
      </header>
      <p className="integration-settings-modal__hint" role="status">
        {updateStatusText(status)}
      </p>
      <div className="integration-settings-modal__update-actions">
        <button
          type="button"
          className="integration-settings-modal__button"
          onClick={() => void check()}
          disabled={busy || status.kind === "disabled"}
        >
          Check for updates
        </button>
        {status.kind === "available" && (
          <button
            type="button"
            className="integration-settings-modal__button integration-settings-modal__button--primary"
            onClick={() => void install()}
          >
            Install and restart
          </button>
        )}
      </div>
    </section>
  );
};

export const IntegrationSettingsModal: React.FC<IntegrationSettingsModalProps> = ({
  isOpen,
  settings,
  geoMeta,
  geoLoading,
  geoError,
  onClose,
  onSave,
  onGeoSave
}) => {
  const [form, setForm] = useState<IntegrationSettingsFormState>(defaultFormState);
  const [error, setError] = useState<string | undefined>(undefined);
  const [geoInlineError, setGeoInlineError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [cityPath, setCityPath] = useState("");
  const [asnPath, setAsnPath] = useState("");
  const modalRef = useModalA11y(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setForm(formFromSettings(settings));
    setError(undefined);
    setGeoInlineError(undefined);
    setSaving(false);
    setCityPath(geoMeta?.cityDbPath ?? "");
    setAsnPath(geoMeta?.asnDbPath ?? "");
  }, [isOpen, settings, geoMeta]);

  const renderGeoStatus = useMemo(() => {
    const resolve = (status: GeoDatabaseMeta["cityDbStatus"]) => {
      switch (status) {
        case "loaded":
          return (
            <span className="integration-settings-modal__geo-status integration-settings-modal__geo-status--success">
              <FiCheckCircle /> Loaded
            </span>
          );
        case "error":
          return (
            <span className="integration-settings-modal__geo-status integration-settings-modal__geo-status--error">
              <FiAlertCircle /> Error
            </span>
          );
        case "missing":
        default:
          return (
            <span className="integration-settings-modal__geo-status integration-settings-modal__geo-status--warning">
              <FiAlertCircle /> Not found
            </span>
          );
      }
    };
    return resolve;
  }, []);

  const handleGeoBrowse = async (target: "city" | "asn") => {
    try {
      const selectedPath = await (window as VisTracerWindow).visTracer.selectGeoDbFile();
      if (!selectedPath) {
        return;
      }

      if (target === "city") {
        setCityPath(selectedPath);
      } else {
        setAsnPath(selectedPath);
      }
    } catch (browseError) {
      const message =
        browseError instanceof Error
          ? browseError.message
          : "Failed to select GeoLite2 database file.";
      setGeoInlineError(message);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) {
      return;
    }

    setSaving(true);
    setError(undefined);
    setGeoInlineError(undefined);

    const trimmedCityPath = cityPath.trim();
    const trimmedAsnPath = asnPath.trim();

    const built = buildIntegrationSettings(form);
    if ("error" in built) {
      setError(built.error);
      setSaving(false);
      return;
    }

    try {
      await onSave(built.settings);
    } catch (saveError) {
      const message =
        saveError instanceof Error
          ? saveError.message
          : "Failed to save integration settings.";
      setError(message);
      setSaving(false);
      return;
    }

    try {
      await onGeoSave({
        cityPath: trimmedCityPath ? trimmedCityPath : undefined,
        asnPath: trimmedAsnPath ? trimmedAsnPath : undefined
      });
    } catch (geoSaveError) {
      const message =
        geoSaveError instanceof Error
          ? geoSaveError.message
          : "Failed to save GeoIP database paths.";
      setGeoInlineError(message);
      setError(message);
      setSaving(false);
      return;
    }

    setSaving(false);
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  const modal = (
    <div className="integration-settings-modal-overlay" onClick={onClose}>
      <div
        ref={modalRef}
        className="integration-settings-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-settings-modal__title"
        tabIndex={-1}
      >
        <header className="integration-settings-modal__header">
          <h2 id="integration-settings-modal__title" className="integration-settings-modal__title">
            Integration settings
          </h2>
          <button
            type="button"
            className="integration-settings-modal__close"
            onClick={onClose}
            aria-label="Close integration settings"
          >
            ×
          </button>
        </header>
        <form className="integration-settings-modal__body" onSubmit={handleSubmit}>
          <p className="integration-settings-modal__intro">
            Configure GeoLite2 databases first, then fine-tune optional enrichment providers. Leave
            any field blank to keep the default.
          </p>

          <section className="integration-settings-modal__geo">
            <header className="integration-settings-modal__geo-header">
              <div>
                <h3>GeoIP databases</h3>
                <small>
                  Provide MaxMind GeoLite2 database paths to enable location and ASN lookups.
                </small>
              </div>
              <span className="integration-settings-modal__geo-updated">
                {geoLoading
                  ? "Loading status…"
                  : geoMeta?.updatedAt
                    ? `Updated ${new Date(geoMeta.updatedAt).toLocaleDateString()}`
                    : "No update recorded"}
              </span>
            </header>
            <div className="integration-settings-modal__geo-field">
              <label htmlFor="integration-settings-geo-city">
                City database&nbsp;
                <code>GeoLite2-City.mmdb</code>
                {geoMeta && renderGeoStatus(geoMeta.cityDbStatus)}
              </label>
              <div className="integration-settings-modal__geo-inputs">
                <input
                  id="integration-settings-geo-city"
                  type="text"
                  value={cityPath}
                  onChange={(event) => setCityPath(event.target.value)}
                  placeholder="/path/to/GeoLite2-City.mmdb"
                  disabled={geoLoading}
                />
                <button
                  type="button"
                  onClick={() => void handleGeoBrowse("city")}
                  disabled={geoLoading}
                >
                  <FiFolder /> Browse
                </button>
              </div>
            </div>
            <div className="integration-settings-modal__geo-field">
              <label htmlFor="integration-settings-geo-asn">
                ASN database&nbsp;
                <code>GeoLite2-ASN.mmdb</code>
                {geoMeta && renderGeoStatus(geoMeta.asnDbStatus)}
              </label>
              <div className="integration-settings-modal__geo-inputs">
                <input
                  id="integration-settings-geo-asn"
                  type="text"
                  value={asnPath}
                  onChange={(event) => setAsnPath(event.target.value)}
                  placeholder="/path/to/GeoLite2-ASN.mmdb"
                  disabled={geoLoading}
                />
                <button
                  type="button"
                  onClick={() => void handleGeoBrowse("asn")}
                  disabled={geoLoading}
                >
                  <FiFolder /> Browse
                </button>
              </div>
            </div>
            {(geoInlineError || geoError || geoMeta?.statusMessage) && (
              <div className="integration-settings-modal__geo-messages">
                {geoMeta?.statusMessage && (
                  <span className="integration-settings-modal__geo-message integration-settings-modal__geo-message--info">
                    {geoMeta.statusMessage}
                  </span>
                )}
                {geoError && (
                  <span className="integration-settings-modal__geo-message integration-settings-modal__geo-message--error">
                    {geoError}
                  </span>
                )}
                {geoInlineError && (
                  <span className="integration-settings-modal__geo-message integration-settings-modal__geo-message--error">
                    {geoInlineError}
                  </span>
                )}
              </div>
            )}
          </section>

          <section
            className="integration-settings-modal__providers"
            aria-labelledby="integration-settings-providers-title"
          >
            <header>
              <h3 id="integration-settings-providers-title">Enrichment providers</h3>
              <small>
                Enabled services receive the public hop addresses of each trace. Private and
                non-routable addresses are never sent. Answers are cached for 7 days.
              </small>
            </header>

            <div className="integration-settings-modal__provider">
              <label className="integration-settings-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.teamCymruEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, teamCymruEnabled: event.target.checked }))
                  }
                />
                Team Cymru
              </label>
              <small className="integration-settings-modal__hint">
                IP to ASN, BGP prefix and registry over whois (TCP port 43). No credentials needed.
              </small>
            </div>

            <div className="integration-settings-modal__provider">
              <label className="integration-settings-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.rdapEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, rdapEnabled: event.target.checked }))
                  }
                />
                RDAP
              </label>
              <small className="integration-settings-modal__hint">
                Registry owner, network block and country.
              </small>
              <label className="integration-settings-modal__label" htmlFor="integration-settings-rdap">
                RDAP base URL
              </label>
              <input
                id="integration-settings-rdap"
                className="integration-settings-modal__input"
                type="url"
                value={form.rdapBaseUrl}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, rdapBaseUrl: event.target.value }))
                }
                placeholder={DEFAULT_RDAP_BASE_URL}
                disabled={!form.rdapEnabled}
              />
              <small className="integration-settings-modal__hint">
                Leave blank for {DEFAULT_RDAP_BASE_URL}, which redirects to the right registry.
              </small>
            </div>

            <div className="integration-settings-modal__provider">
              <label className="integration-settings-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.ripeStatEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, ripeStatEnabled: event.target.checked }))
                  }
                />
                RIPEstat
              </label>
              <small className="integration-settings-modal__hint">
                Announced prefix and origin ASN from live BGP data. Requests identify as
                VisTracer.
              </small>
            </div>

            <div className="integration-settings-modal__provider">
              <label className="integration-settings-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.peeringDbEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, peeringDbEnabled: event.target.checked }))
                  }
                />
                PeeringDB
              </label>
              <small className="integration-settings-modal__hint">
                Network type, peering policy, exchange and facility counts for each ASN.
              </small>
              <label className="integration-settings-modal__label" htmlFor="integration-settings-peeringdb">
                PeeringDB API key
              </label>
              <input
                id="integration-settings-peeringdb"
                className="integration-settings-modal__input"
                type="password"
                autoComplete="off"
                value={form.peeringDbApiKey}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, peeringDbApiKey: event.target.value }))
                }
                placeholder="Optional"
                disabled={!form.peeringDbEnabled}
              />
              <small className="integration-settings-modal__hint">
                Optional. Anonymous requests work but have a lower rate limit. The key is also used
                for the exchange list download and is stored in the app settings file on this
                computer.
              </small>
            </div>

            <div className="integration-settings-modal__provider">
              <label className="integration-settings-modal__toggle">
                <input
                  type="checkbox"
                  checked={form.ixMatchingEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, ixMatchingEnabled: event.target.checked }))
                  }
                />
                Internet exchanges
              </label>
              <small className="integration-settings-modal__hint">
                Match hops to internet exchanges. Downloads PeeringDB&apos;s public exchange list
                once a day; nothing about your route is sent.
              </small>
            </div>
          </section>

          <UpdatesSection />

          {error && <div className="integration-settings-modal__error">{error}</div>}

          <footer className="integration-settings-modal__footer">
            <button
              type="button"
              className="integration-settings-modal__button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="integration-settings-modal__button integration-settings-modal__button--primary"
              disabled={saving || geoLoading}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
};
