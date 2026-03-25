import React, { useState } from "react";
import { useGeoDatabaseMeta } from "@renderer/hooks/useGeoDatabaseMeta";
import { useTracerouteStore, selectCurrentRun } from "@renderer/state/tracerouteStore";
import { GeoWarningBanner } from "./GeoWarningBanner";
import { GeoSettingsModal } from "./GeoSettingsModal";
import { ExportMediaModal } from "./ExportMediaModal";
import { runExport } from "../lib/exportCapture";
import type { VisTracerWindow } from "@common/bridge";
import "./FooterBar.css";

type ExportState = "idle" | "working" | "success" | "error";

export const FooterBar: React.FC = () => {
  const { data: geoMeta, refetch: refetchGeoMeta } = useGeoDatabaseMeta();
  const currentRun = useTracerouteStore(selectCurrentRun);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [message, setMessage] = useState<string | undefined>();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [defaultFormat, setDefaultFormat] = useState<"png" | "jpg" | "webp" | "webm" | "gif">("png");

  const beginExport = () => {
    if (!currentRun || exportState === "working") {
      return;
    }
    setDefaultFormat("png");
    setIsExportModalOpen(true);
  };

  const handleExportConfirm = async (options: { format: "png" | "jpg" | "webp" | "webm" | "gif"; dwellSeconds: number }) => {
    if (!currentRun) {
      setIsExportModalOpen(false);
      return;
    }

    setDefaultFormat(options.format);
    setIsExportModalOpen(false);
    setExportState("working");
    setMessage(undefined);
    try {
      const { filename } = await runExport(options, currentRun);
      setExportState("success");
      setMessage(`Saved ${filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Export failed";
      setExportState("error");
      setMessage(message);
    } finally {
      setTimeout(() => {
        setExportState("idle");
        setMessage(undefined);
      }, 3500);
    }
  };

  const handleUpdateGeoPaths = async (cityPath?: string, asnPath?: string) => {
    await (window as VisTracerWindow).visTracer.updateGeoDatabasePaths(cityPath, asnPath);
    await refetchGeoMeta();
  };

  const exportDisabled = !currentRun || exportState === "working";
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
              onClick={beginExport}
              disabled={exportDisabled}
            >
              {exportState === "working" ? "Exporting…" : "Download export"}
            </button>
            {message && <span className="footer-bar__message">{message}</span>}
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
        isOpen={isExportModalOpen}
        defaultFormat={defaultFormat}
        onCancel={() => setIsExportModalOpen(false)}
        onConfirm={handleExportConfirm}
        disabled={exportState === "working"}
      />
    </>
  );
};
