import React, { useState } from "react";
import { GeoDatabaseMeta } from "@common/ipc";
import { FiAlertTriangle, FiX, FiSettings } from "react-icons/fi";
import "./GeoWarningBanner.css";

interface GeoWarningBannerProps {
  geoMeta: GeoDatabaseMeta;
  onConfigure?: () => void;
}

export const GeoWarningBanner: React.FC<GeoWarningBannerProps> = ({ geoMeta, onConfigure }) => {
  const [dismissed, setDismissed] = useState(false);

  const hasIssues =
    geoMeta.cityDbStatus !== "loaded" || geoMeta.asnDbStatus !== "loaded";

  if (!hasIssues || dismissed) {
    return null;
  }

  return (
    <div className="geo-warning-banner">
      <div className="geo-warning-banner__icon">
        <FiAlertTriangle />
      </div>
      <div className="geo-warning-banner__content">
        <div className="geo-warning-banner__title">GeoIP Database Warning</div>
        <div className="geo-warning-banner__message">
          {geoMeta.statusMessage || "Some GeoIP databases are not available"}
        </div>
      </div>
      <div className="geo-warning-banner__actions">
        {onConfigure && (
          <button
            className="geo-warning-banner__button geo-warning-banner__button--primary"
            onClick={onConfigure}
            title="Configure database paths"
          >
            <FiSettings />
            Configure
          </button>
        )}
        <button
          className="geo-warning-banner__button geo-warning-banner__button--dismiss"
          onClick={() => setDismissed(true)}
          title="Dismiss"
        >
          <FiX />
        </button>
      </div>
    </div>
  );
};
