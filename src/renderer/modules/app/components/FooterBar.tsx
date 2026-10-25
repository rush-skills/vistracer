import React, { useState } from "react";
import { useGeoDatabaseMeta } from "@renderer/hooks/useGeoDatabaseMeta";
import { useTracerouteStore, selectCurrentRun } from "@renderer/state/tracerouteStore";
import { useExportStore } from "@renderer/state/exportStore";
import { useNoticeStore } from "@renderer/state/noticeStore";
import { GeoWarningBanner } from "./GeoWarningBanner";
import { GeoSettingsModal } from "./GeoSettingsModal";
import { ExportMediaModal } from "./ExportMediaModal";
import type { VisTracerWindow } from "@common/bridge";
import "./FooterBar.css";

export const FooterBar: React.FC = () => {
  const { data: geoMeta, refetch: refetchGeoMeta } = useGeoDatabaseMeta();
  const currentRun = useTracerouteStore(selectCurrentRun);
  const exporting = useExportStore((state) => state.working);
  const dialogOpen = useExportStore((state) => state.dialogOpen);
  const { openDialog, closeDialog, start } = useExportStore.getState();
  const notice = useNoticeStore((state) => state.notice);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleUpdateGeoPaths = async (cityPath?: string, asnPath?: string) => {
    await (window as VisTracerWindow).visTracer.updateGeoDatabasePaths(cityPath, asnPath);
    await refetchGeoMeta();
  };

  const exportDisabled = !currentRun || exporting;
  const updatedLabel = geoMeta?.updatedAt
    ? new Date(geoMeta.updatedAt).toLocaleDateString()
    : "unknown";

  const geoStatus =
    geoMeta?.cityDbStatus === "loaded" && geoMeta?.asnDbStatus === "loaded"
      ? `GeoLite2 loaded (updated ${updatedLabel})`
      : geoMeta?.cityDbStatus === "loaded" || geoMeta?.asnDbStatus === "loaded"
        ? `GeoLite2 partially loaded (updated ${updatedLabel})`
        : "GeoLite2 database not configured";

  return (
    <>
      <footer className="footer-bar">
        <div className="footer-bar__content">
          <div className="footer-bar__legend">
            <span className="footer-bar__legend-item">
              <span className="footer-bar__color footer-bar__color--fast"></span>
              Fast (&lt; 50ms)
            </span>
            <span className="footer-bar__legend-item">
              <span className="footer-bar__color footer-bar__color--moderate"></span>
              Moderate (50-150ms)
            </span>
            <span className="footer-bar__legend-item">
              <span className="footer-bar__color footer-bar__color--slow"></span>
              Slow (&gt; 150ms)
            </span>
          </div>
          <div className="footer-bar__meta">
            <span>{geoStatus}</span>
            <button
              type="button"
              className="footer-bar__export"
              onClick={openDialog}
              disabled={exportDisabled}
            >
              {exporting ? "Exporting…" : "Download export"}
            </button>
            {notice && (
              <span
                className={`footer-bar__message footer-bar__message--${notice.tone}`}
                role="status"
              >
                {notice.text}
              </span>
            )}
          </div>
        </div>
        {geoMeta && (
          <div className="footer-bar__warning">
            <GeoWarningBanner
              geoMeta={geoMeta}
              onConfigure={() => setIsSettingsOpen(true)}
            />
          </div>
        )}
      </footer>
      {geoMeta && (
        <GeoSettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          geoMeta={geoMeta}
          onUpdate={handleUpdateGeoPaths}
        />
      )}
      <ExportMediaModal
        isOpen={dialogOpen}
        defaultFormat="png"
        onCancel={closeDialog}
        onConfirm={(options) => void start(options)}
        disabled={exporting}
      />
    </>
  );
};
