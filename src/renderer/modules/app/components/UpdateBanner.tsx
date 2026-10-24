import React from "react";
import { useUpdateStore } from "@renderer/state/updateStore";
import "./UpdateBanner.css";

export const UpdateBanner: React.FC = () => {
  const status = useUpdateStore((state) => state.status);
  const dismissed = useUpdateStore((state) => state.dismissed);
  const install = useUpdateStore((state) => state.install);
  const dismiss = useUpdateStore((state) => state.dismiss);

  if (dismissed) {
    return null;
  }

  if (status.kind === "available") {
    return (
      <div className="update-banner" role="status">
        <span>VisTracer {status.version} is available.</span>
        <button type="button" className="update-banner__primary" onClick={() => void install()}>
          Install and restart
        </button>
        <button type="button" onClick={dismiss}>
          Later
        </button>
      </div>
    );
  }

  if (status.kind === "installing") {
    return (
      <div className="update-banner" role="status">
        <span>Downloading VisTracer {status.version}…</span>
      </div>
    );
  }

  if (status.kind === "install-failed") {
    return (
      <div className="update-banner update-banner--error" role="alert">
        <span>
          Update to {status.version} failed: {status.message}
        </span>
        <button type="button" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  return null;
};
