import React, { useState } from "react";
import { useGeoDatabaseMeta } from "@renderer/hooks/useGeoDatabaseMeta";
import { useTracerouteStore, selectCurrentRun } from "@renderer/state/tracerouteStore";
import "./FooterBar.css";

type ExportState = "idle" | "working" | "success" | "error";

export const FooterBar: React.FC = () => {
  const { data: geoMeta } = useGeoDatabaseMeta();
  const currentRun = useTracerouteStore(selectCurrentRun);
  const [exportState, setExportState] = useState<ExportState>("idle");
  const [message, setMessage] = useState<string | undefined>();

  const handleExport = async () => {
    setExportState("working");
    setMessage(undefined);
    try {
      // Capture the canvas from the globe viewport
      const canvas = document.querySelector('.globe-viewport canvas') as HTMLCanvasElement;
      if (!canvas) {
        throw new Error('Globe canvas not found');
      }

      // Convert canvas to blob
      canvas.toBlob((blob) => {
        if (!blob) {
          setExportState("error");
          setMessage("Failed to capture snapshot");
          return;
        }

        // Create download link
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `vistracer-snapshot-${timestamp}.png`;

        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();

        // Cleanup
        URL.revokeObjectURL(url);

        setExportState("success");
        setMessage(`Downloaded ${filename}`);
        setTimeout(() => {
          setExportState("idle");
          setMessage(undefined);
        }, 3000);
      }, 'image/png');
    } catch (error) {
      setExportState("error");
      setMessage(error instanceof Error ? error.message : "Download failed");
    }
  };

  const exportDisabled = !currentRun || exportState === "working";
  const updatedLabel = geoMeta?.updatedAt
    ? new Date(geoMeta.updatedAt).toLocaleDateString()
    : "unknown";

  const geoStatus = geoMeta?.cityDbPath
    ? `GeoLite2 loaded (updated ${updatedLabel})`
    : "GeoLite2 database not configured";

  return (
    <footer className="footer-bar">
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
          onClick={handleExport}
          disabled={exportDisabled}
        >
          {exportState === "working" ? "Downloading…" : "Download snapshot"}
        </button>
        {message && <span className="footer-bar__message">{message}</span>}
      </div>
    </footer>
  );
};
