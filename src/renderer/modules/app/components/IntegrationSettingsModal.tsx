import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GeoDatabaseMeta, IntegrationSettings } from "@common/ipc";
import type { VisTracerWindow } from "@common/bridge";
import { FiAlertCircle, FiCheckCircle, FiFolder } from "react-icons/fi";
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

interface IntegrationSettingsFormState {
  rdapBaseUrl: string;
  peeringDbApiKey: string;
}

const defaultFormState: IntegrationSettingsFormState = {
  rdapBaseUrl: "",
  peeringDbApiKey: ""
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

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setForm({
      rdapBaseUrl: settings.rdap.baseUrl ?? "",
      peeringDbApiKey: settings.peeringDb.apiKey ?? ""
    });
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

    const trimmedBaseUrl = form.rdapBaseUrl.trim();
    const trimmedApiKey = form.peeringDbApiKey.trim();
    const trimmedCityPath = cityPath.trim();
    const trimmedAsnPath = asnPath.trim();

    const updated: IntegrationSettings = {
      ...settings,
      rdap: {
        ...settings.rdap,
        baseUrl: trimmedBaseUrl || "https://rdap.org/ip"
      },
      ripeStat: {
        ...settings.ripeStat,
        sourceApp: "VisTracer"
      },
      peeringDb: {
        ...settings.peeringDb,
        apiKey: trimmedApiKey ? trimmedApiKey : undefined
      }
    };

    try {
      await onSave(updated);
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
        className="integration-settings-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-settings-modal__title"
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

          <div className="integration-settings-modal__field">
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
              placeholder="https://rdap.org/ip"
            />
            <small className="integration-settings-modal__hint">
              VisTracer defaults to https://rdap.org/ip. Override if you operate a private RDAP
              resolver.
            </small>
          </div>

          <div className="integration-settings-modal__field">
            <label className="integration-settings-modal__label" htmlFor="integration-settings-peeringdb">
              PeeringDB API key
            </label>
            <input
              id="integration-settings-peeringdb"
              className="integration-settings-modal__input"
              type="text"
              value={form.peeringDbApiKey}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, peeringDbApiKey: event.target.value }))
              }
              placeholder="Optional"
            />
            <small className="integration-settings-modal__hint">
              Optional. Adds authentication headers for faster, higher-rate PeeringDB requests.
            </small>
          </div>

          <div className="integration-settings-modal__field">
            <label className="integration-settings-modal__label" htmlFor="integration-settings-ripe">
              RIPE Stat source app
            </label>
            <input
              id="integration-settings-ripe"
              className="integration-settings-modal__input"
              type="text"
              value="VisTracer"
              disabled
              readOnly
            />
            <small className="integration-settings-modal__hint">
              RIPE Stat requests always identify as VisTracer.
            </small>
          </div>

          <div className="integration-settings-modal__field integration-settings-modal__field--note">
            <small className="integration-settings-modal__hint">
              Team Cymru lookups run over their public whois service and do not require credentials.
            </small>
          </div>

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
