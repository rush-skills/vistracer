import React, { useState, useEffect } from "react";
import { GeoDatabaseMeta, GeoDbDownloadProgress } from "@common/ipc";
import type { VisTracerWindow } from "@common/bridge";
import { FiX, FiFolder, FiCheckCircle, FiAlertCircle, FiDownloadCloud, FiKey } from "react-icons/fi";
import "./GeoSettingsModal.css";

interface GeoSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  geoMeta: GeoDatabaseMeta;
  onUpdate: (cityPath?: string, asnPath?: string) => Promise<void>;
}

export const GeoSettingsModal: React.FC<GeoSettingsModalProps> = ({
  isOpen,
  onClose,
  geoMeta,
  onUpdate
}) => {
  const [cityPath, setCityPath] = useState(geoMeta.cityDbPath || "");
  const [asnPath, setAsnPath] = useState(geoMeta.asnDbPath || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [licenseKey, setLicenseKey] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<GeoDbDownloadProgress | null>(null);

  useEffect(() => {
    setCityPath(geoMeta.cityDbPath || "");
    setAsnPath(geoMeta.asnDbPath || "");
  }, [geoMeta]);

  const handleAutoDownload = async () => {
    if (!licenseKey.trim()) return;
    setDownloading(true);
    setError(undefined);
    setDownloadProgress(null);

    const api = (window as VisTracerWindow).visTracer;
    const unsubscribe = api.subscribeGeoDbDownloadProgress((progress) => {
      setDownloadProgress(progress);
      if (progress.stage === "error") {
        setError(progress.error);
      }
    });

    try {
      const result = await api.downloadGeoDatabases(licenseKey.trim());
      setCityPath(result.cityPath);
      setAsnPath(result.asnPath);
      // Trigger a refresh via the parent
      await onUpdate(result.cityPath, result.asnPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
      unsubscribe();
    }
  };

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onUpdate(cityPath || undefined, asnPath || undefined);
      setTimeout(onClose, 500); // Brief delay to show success
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update database paths");
    } finally {
      setSaving(false);
    }
  };

  const handleBrowse = async (type: "city" | "asn") => {
    try {
      const selectedPath = await (window as VisTracerWindow).visTracer.selectGeoDbFile();
      if (selectedPath) {
        if (type === "city") {
          setCityPath(selectedPath);
        } else {
          setAsnPath(selectedPath);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select file");
    }
  };

  const renderStatus = (status: GeoDatabaseMeta["cityDbStatus"]) => {
    switch (status) {
      case "loaded":
        return (
          <span className="geo-settings-modal__status geo-settings-modal__status--success">
            <FiCheckCircle /> Loaded
          </span>
        );
      case "error":
        return (
          <span className="geo-settings-modal__status geo-settings-modal__status--error">
            <FiAlertCircle /> Error
          </span>
        );
      case "missing":
        return (
          <span className="geo-settings-modal__status geo-settings-modal__status--warning">
            <FiAlertCircle /> Not Found
          </span>
        );
    }
  };

  return (
    <div className="geo-settings-modal-overlay" onClick={onClose}>
      <div className="geo-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="geo-settings-modal__header">
          <h2 className="geo-settings-modal__title">Configure GeoIP Databases</h2>
          <button className="geo-settings-modal__close" onClick={onClose}>
            <FiX />
          </button>
        </div>

        <div className="geo-settings-modal__body">
          <div className="geo-settings-modal__info">
            <p>
              VisTracer uses MaxMind GeoLite2 databases to provide location and network
              information for IP addresses. Download the databases from{" "}
              <a
                href="https://dev.maxmind.com/geoip/geolite2-free-geolocation-data"
                target="_blank"
                rel="noopener noreferrer"
              >
                MaxMind&apos;s website
              </a>
              .
            </p>
          </div>

          <div className="geo-settings-modal__field">
            <label className="geo-settings-modal__label">
              City Database (GeoLite2-City.mmdb)
              {renderStatus(geoMeta.cityDbStatus)}
            </label>
            <div className="geo-settings-modal__input-group">
              <input
                type="text"
                className="geo-settings-modal__input"
                value={cityPath}
                onChange={(e) => setCityPath(e.target.value)}
                placeholder="/path/to/GeoLite2-City.mmdb"
              />
              <button
                className="geo-settings-modal__browse"
                onClick={() => handleBrowse("city")}
              >
                <FiFolder /> Browse
              </button>
            </div>
          </div>

          <div className="geo-settings-modal__field">
            <label className="geo-settings-modal__label">
              ASN Database (GeoLite2-ASN.mmdb)
              {renderStatus(geoMeta.asnDbStatus)}
            </label>
            <div className="geo-settings-modal__input-group">
              <input
                type="text"
                className="geo-settings-modal__input"
                value={asnPath}
                onChange={(e) => setAsnPath(e.target.value)}
                placeholder="/path/to/GeoLite2-ASN.mmdb"
              />
              <button
                className="geo-settings-modal__browse"
                onClick={() => handleBrowse("asn")}
              >
                <FiFolder /> Browse
              </button>
            </div>
          </div>

          <div className="geo-settings-modal__divider" />

          <div className="geo-settings-modal__auto-download">
            <label className="geo-settings-modal__label">
              <FiKey style={{ marginRight: 4 }} />
              Auto-download with MaxMind license key
            </label>
            <div className="geo-settings-modal__input-group">
              <input
                type="password"
                className="geo-settings-modal__input"
                placeholder="Enter MaxMind license key"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                disabled={downloading}
              />
              <button
                className="geo-settings-modal__browse"
                onClick={handleAutoDownload}
                disabled={downloading || !licenseKey.trim()}
              >
                <FiDownloadCloud /> {downloading ? "Downloading…" : "Download"}
              </button>
            </div>
            {downloadProgress && downloading && (
              <small className="geo-settings-modal__download-status">
                {downloadProgress.stage === "downloading" &&
                  `Downloading ${downloadProgress.edition}… ${downloadProgress.percent ?? 0}%`}
                {downloadProgress.stage === "extracting" &&
                  `Extracting ${downloadProgress.edition}…`}
              </small>
            )}
          </div>

          {error && <div className="geo-settings-modal__error">{error}</div>}
        </div>

        <div className="geo-settings-modal__footer">
          <button className="geo-settings-modal__button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="geo-settings-modal__button geo-settings-modal__button--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save & Apply"}
          </button>
        </div>
      </div>
    </div>
  );
};
