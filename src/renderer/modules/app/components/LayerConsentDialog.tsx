import React, { useCallback } from "react";
import { layerById } from "@renderer/lib/layers";
import { useModalA11y } from "@renderer/hooks/useModalA11y";
import { useUiStore } from "@renderer/state/uiStore";
import "./LayerConsentDialog.css";

/**
 * The notice of a layer with licence terms or a third-party download
 * (`LayerDefinition.consent`), shown the first time the user turns it on,
 * from the layer panel or the command bar. The layer stays off, and
 * nothing is downloaded, unless the user accepts.
 */
export const LayerConsentDialog: React.FC = () => {
  const pending = useUiStore((state) => state.pendingConsent);
  const layer = pending ? layerById(pending) : undefined;
  const consent = layer?.consent;
  const decline = useCallback(() => useUiStore.getState().declineConsent(), []);
  const panelRef = useModalA11y(Boolean(consent), decline);

  if (!layer || !consent) {
    return null;
  }

  return (
    <div className="consent-overlay" onClick={decline}>
      <div
        ref={panelRef}
        className="consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-dialog-title"
        aria-describedby="consent-dialog-body"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="consent-dialog-title">{consent.title}</h2>
        <div id="consent-dialog-body" className="consent-dialog__body">
          {consent.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <footer className="consent-dialog__footer">
          <button type="button" className="button" onClick={decline}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => useUiStore.getState().acceptConsent()}
          >
            {consent.accept}
          </button>
        </footer>
      </div>
    </div>
  );
};
