import React, { useState } from "react";
import { useGeoDatabaseMeta } from "@renderer/hooks/useGeoDatabaseMeta";
import { useExportStore } from "@renderer/state/exportStore";
import { useCommand } from "@renderer/hooks/useCommands";
import { useNoticeStore } from "@renderer/state/noticeStore";
import { GeoWarningBanner } from "./GeoWarningBanner";
import { GeoSettingsModal } from "./GeoSettingsModal";
import { ExportMediaModal } from "./ExportMediaModal";
import type { VisTracerWindow } from "@common/bridge";
import "./FooterBar.css";

export const FooterBar: React.FC = () => {
  const { data: geoMeta, refetch: refetchGeoMeta } = useGeoDatabaseMeta();
  const exporting = useExportStore((state) => state.working);
  const dialogOpen = useExportStore((state) => state.dialogOpen);
  const { closeDialog, start } = useExportStore.getState();
  const exportRoute = useCommand("export.dialog");
  const notice = useNoticeStore((state) => state.notice);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleUpdateGeoPaths = async (cityPath?: string, asnPath?: string) => {
    await (window as VisTracerWindow).visTracer.updateGeoDatabasePaths(cityPath, asnPath);
    await refetchGeoMeta();
  };

  const updated = geoMeta?.updatedAt
    ? ` (updated ${new Date(geoMeta.updatedAt).toLocaleDateString()})`
    : "";

  const geoStatus =
    geoMeta?.cityDbStatus === "loaded" && geoMeta?.asnDbStatus === "loaded"
      ? `GeoLite2 loaded${updated}`
      : geoMeta?.cityDbStatus === "loaded" || geoMeta?.asnDbStatus === "loaded"
        ? `GeoLite2 partly loaded${updated}`
        : "GeoLite2 not configured";

  return (
    <>
      <footer className="footer-bar glass">
        {geoMeta && (
          <GeoWarningBanner geoMeta={geoMeta} onConfigure={() => setIsSettingsOpen(true)} />
        )}
        <div className="footer-bar__content">
          <ul className="footer-bar__legend" aria-label="Arc colour: round-trip time">
            <li>
              <span className="footer-bar__color footer-bar__color--fast" />
              &lt; 50 ms
            </li>
            <li>
              <span className="footer-bar__color footer-bar__color--moderate" />
              50–150 ms
            </li>
            <li>
              <span className="footer-bar__color footer-bar__color--slow" />
              &gt; 150 ms
            </li>
          </ul>
          <span className="footer-bar__geo">{geoStatus}</span>
          <button
            type="button"
            className="button footer-bar__export"
            onClick={exportRoute.run}
            disabled={Boolean(exportRoute.disabledReason)}
            title={exportRoute.disabledReason}
          >
            {exporting ? "Exporting…" : "Export route"}
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
